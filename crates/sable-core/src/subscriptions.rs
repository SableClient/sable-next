use crate::api::timeline::SubscribeParams;
use crate::api::timeline::TimelineFocusView;
use crate::api::timeline::WarmRoomsParams;
use std::{collections::HashMap, sync::Arc, time::Duration};

use futures_util::future::{self, Either};
use futures_util::{StreamExt, pin_mut};
use matrix_sdk::event_cache::{PaginationStatus, RoomEventCacheUpdate};
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId, OwnedUserId, RoomId, UserId};
use matrix_sdk::send_queue::RoomSendQueueUpdate;
use matrix_sdk_base::event_cache::Event;
use matrix_sdk_ui::eyeball_im::VectorDiff;
use matrix_sdk_ui::room_list_service::filters::new_filter_non_left;
use matrix_sdk_ui::room_list_service::{RoomListItem, RoomListLoadingState};
use matrix_sdk_ui::timeline::{
    Error as TimelineError, EventSendState, SendTarget, Timeline, TimelineItem,
};
use tokio::sync::broadcast::error::RecvError;
use web_time::Instant;

use crate::ResultExt;
use crate::api::timeline::{SubscribeOk, SubscribeRoomListOk};
use crate::notifications;
use crate::protocol::{CoreEvent, RpcError, SubscriptionId, TimelineItemView};
use crate::room_list_batch::DiffBatch;
use crate::room_list_rows::RoomListRows;
use crate::timeline_overlay::{ReplyFallback, TimelineOverlay};
use crate::timelines::{
    AggregationScope, aggregation_items, build_room_timeline, fill_sender_profiles,
};
use crate::view;
use crate::{Core, Subscription, SubscriptionKind, Task};

enum Wake {
    Diffs(Option<Vec<VectorDiff<Arc<TimelineItem>>>>),
    Queue(Option<RoomSendQueueUpdate>),
}

async fn next_queue_update(
    updates: &mut Option<tokio::sync::broadcast::Receiver<RoomSendQueueUpdate>>,
) -> Option<RoomSendQueueUpdate> {
    let Some(receiver) = updates.as_mut() else {
        return future::pending().await;
    };
    loop {
        match receiver.recv().await {
            Ok(update) => return Some(update),
            Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => return None,
        }
    }
}

const ROOM_LIST_PAGE_SIZE: usize = 200;
const ROOM_LIST_BATCH_INTERVAL: Duration = Duration::from_millis(100);
pub(crate) const MAX_WARM_ROOMS: usize = 32;

const fn pages_for(total: u32) -> usize {
    (total as usize).div_ceil(ROOM_LIST_PAGE_SIZE)
}

pub(crate) fn abort_rejected_redaction(timeline: &Arc<Timeline>, item: &TimelineItem) {
    let Some(event) = item.as_event() else {
        return;
    };
    if !matches!(
        event.redaction_send_state(),
        Some(EventSendState::SendingFailed {
            is_recoverable: false,
            ..
        })
    ) {
        return;
    }
    let timeline = timeline.clone();
    let item_id = event.identifier();
    drop(spawn(async move {
        if let Err(error) = timeline.abort_send(&item_id, SendTarget::Redaction).await {
            tracing::warn!("abort rejected redaction failed: {error}");
        }
    }));
}

impl Core {
    #[expect(
        clippy::too_many_lines,
        reason = "one loop owns the room list's sources"
    )]
    pub(crate) async fn subscribe_room_list(
        self: &Arc<Self>,
    ) -> Result<SubscribeRoomListOk, RpcError> {
        let sync_service = {
            let guard = self.session.read().await;
            guard
                .as_ref()
                .ok_or(RpcError::NotLoggedIn)?
                .sync_service
                .clone()
        };

        self.wait_for_stores().await;
        let client = self.client().await?;
        let push_rules = self.push_rules().await?;
        let subscription = self.allocate_subscription();
        let core = self.clone();
        let mut stores_open = self.stores_open.subscribe();

        let task = spawn(async move {
            let room_list = match sync_service.room_list_service().all_rooms().await {
                Ok(room_list) => room_list,
                Err(error) => {
                    tracing::error!("all_rooms failed: {error}");
                    return;
                }
            };

            let loading = room_list.loading_state();
            let (stream, controller) = room_list.entries_with_dynamic_adapters(ROOM_LIST_PAGE_SIZE);
            controller.set_filter(Box::new(new_filter_non_left()));

            // Refreshed from each diff before constructing synchronous summaries.
            let mut room_cache: HashMap<OwnedRoomId, view::RoomInfo> = HashMap::new();
            let mut rows = RoomListRows::default();
            let mut rule_changes = push_rules.subscribe();
            let mut rules = push_rules.snapshot().await;

            let mut stream = Box::pin(stream);
            let mut grown_to = 0;
            let mut batch = DiffBatch::new(ROOM_LIST_BATCH_INTERVAL);
            loop {
                let held = batch.wait(Instant::now());
                let diffs = tokio::select! {
                    _ = stores_open.changed() => {
                        if !*stores_open.borrow_and_update() {
                            continue;
                        }
                        let rooms: Vec<_> = room_cache.iter()
                            .filter(|(_, info)| info.children_stale)
                            .filter_map(|(room_id, _)| client.get_room(room_id))
                            .map(RoomListItem::from)
                            .collect();
                        view::enrich_rooms(&rooms, &mut room_cache).await;
                        let diffs = rows.refresh(&rooms, &room_cache, &rules);
                        if diffs.is_empty() {
                            continue;
                        }
                        diffs
                    }
                    () = due(held) => {
                        core.emit(CoreEvent::RoomListDiff {
                            subscription,
                            diffs: batch.take(Instant::now()),
                        });
                        continue;
                    }
                    diffs = stream.next() => {
                        let Some(diffs) = diffs else { break };
                        if let RoomListLoadingState::Loaded {
                            maximum_number_of_rooms: Some(total),
                        } = loading.get()
                            && total > grown_to
                        {
                            for _ in 0..pages_for(total) {
                                controller.add_one_page();
                            }
                            grown_to = total;
                        }

                        view::prime_display_names(&diffs).await;
                        view::enrich_room_batch(&diffs, &mut room_cache).await;
                        let diffs: Vec<_> = diffs
                            .into_iter()
                            .map(|diff| {
                                view::map_diff(diff, |item| {
                                    view::room_list_item(item, &room_cache, &rules)
                                })
                            })
                            .collect();
                        for diff in &diffs {
                            rows.apply(diff);
                        }
                        rows.evict(&mut room_cache);
                        diffs
                    }
                    changed = rule_changes.recv() => {
                        if matches!(changed, Err(RecvError::Closed)) {
                            break;
                        }
                        rules = push_rules.snapshot().await;
                        let diffs = rows.renotify(&rules, |room_id| {
                            client
                                .get_room(room_id)
                                .is_some_and(|room| notifications::uses_direct_push_rules(&room))
                        });
                        if diffs.is_empty() {
                            continue;
                        }
                        diffs
                    }
                };
                if let Some(diffs) = batch.push(diffs, Instant::now()) {
                    core.emit(CoreEvent::RoomListDiff {
                        subscription,
                        diffs,
                    });
                }
            }
        })
        .abort_on_drop();

        self.subscriptions.lock().await.insert(
            subscription,
            Subscription {
                tasks: vec![task],
                timeline: None,
                overlay: None,
                thread_root: None,
                timeline_key: None,
                kind: SubscriptionKind::Other,
            },
        );

        // The filter makes the stream open with a `Reset` carrying everything.
        Ok(SubscribeRoomListOk {
            subscription,
            rooms: Vec::new(),
        })
    }

    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::arc_with_non_send_sync,
            reason = "matrix timelines are single-threaded on WASM"
        )
    )]
    #[expect(
        clippy::too_many_lines,
        reason = "keep subscription registration and owned tasks together"
    )]
    pub(crate) async fn subscribe_timeline(
        self: &Arc<Self>,
        SubscribeParams {
            room_id,
            key: timeline_key,
            focus,
            hidden_events,
        }: SubscribeParams,
    ) -> Result<SubscribeOk, RpcError> {
        self.wait_for_stores().await;
        let subscription = self.allocate_subscription();
        let live = matches!(focus, TimelineFocusView::Live);
        let room = self.room(&room_id).await?;
        let timeline = match &focus {
            TimelineFocusView::Live => self.live_timeline(&room_id, hidden_events).await?,
            TimelineFocusView::Thread { root_event_id } => {
                self.thread_timeline(&room_id, root_event_id).await?
            }
            TimelineFocusView::Event { .. } => Arc::new(
                build_room_timeline(&room, &focus, hidden_events)
                    .await
                    .or_failed(self, "build_focused_timeline")?,
            ),
        };
        fill_sender_profiles(&room, &timeline);
        let overlay = Arc::new(std::sync::Mutex::new(TimelineOverlay::default()));

        // The SDK replaces its explicit-room set wholesale. Register before
        tracing::info!(%room_id, "subscribe_timeline: waiting for room_subscriptions");
        let mut subscribed = self.room_subscriptions.lock().await;
        tracing::info!(%room_id, "subscribe_timeline: holding room_subscriptions");
        if live {
            self.remember_warm(room_id.clone());
        }
        self.subscriptions.lock().await.insert(
            subscription,
            Subscription {
                tasks: Vec::new(),
                timeline: Some(timeline.clone()),
                overlay: Some(overlay.clone()),
                thread_root: match &focus {
                    TimelineFocusView::Thread { root_event_id } => Some(root_event_id.clone()),
                    TimelineFocusView::Live | TimelineFocusView::Event { .. } => None,
                },
                timeline_key: timeline_key.clone(),
                kind: if live {
                    SubscriptionKind::LiveTimeline(room_id.clone())
                } else {
                    SubscriptionKind::FocusedTimeline(room_id.clone())
                },
            },
        );
        if let Err(error) = self.sync_timeline_rooms_locked(&mut subscribed).await {
            self.subscriptions.lock().await.remove(&subscription);
            return Err(error);
        }
        tracing::info!(%room_id, "subscribe_timeline: subscriptions synced");
        let (items, stream) = timeline.subscribe().await;
        let (echoes, mut queue_updates) = match room.send_queue().subscribe().await {
            Ok((echoes, updates)) => (echoes, Some(updates)),
            Err(_) => (Vec::new(), None),
        };
        let local_content = view::LocalContent::new(&echoes);
        let mut stream_content = view::LocalContent::new(&echoes);
        let pagination = timeline.live_back_pagination_status().await;
        let own_user_id = self.client().await?.user_id().map(ToOwned::to_owned);
        let push = room.push_context().await.ok().flatten();
        let highlights = view::Highlights::compute(push.as_ref(), items.iter()).await;
        let items = items
            .iter()
            .map(|item| {
                abort_rejected_redaction(&timeline, item);
                view::timeline_item(item, own_user_id.as_deref(), &highlights, &local_content)
            })
            .collect();
        // Seeded before the stream starts, so its diffs apply to this snapshot.
        let items = overlay
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .reset(items);
        let core = self.clone();
        let stream_user_id = own_user_id.clone();
        let stream_room = room.clone();
        let stream_timeline = timeline.clone();
        let stream_overlay = overlay.clone();
        let stream_key = timeline_key.clone();
        let task = spawn(async move {
            pin_mut!(stream);
            loop {
                let wake = {
                    let update = next_queue_update(&mut queue_updates);
                    pin_mut!(update);
                    match future::select(stream.next(), update).await {
                        Either::Left((diffs, _)) => Wake::Diffs(diffs),
                        Either::Right((update, _)) => Wake::Queue(update),
                    }
                };
                let diffs = match wake {
                    Wake::Diffs(Some(diffs)) => diffs,
                    Wake::Diffs(None) => break,
                    Wake::Queue(Some(update)) => {
                        if let Some(target) = stream_content.apply(&update) {
                            let items = stream_timeline.items().await;
                            let Some(item) = items.iter().find(|item| {
                                item.as_event().and_then(|event| event.event_id()) == Some(&target)
                            }) else {
                                continue;
                            };
                            let push = stream_room.push_context().await.ok().flatten();
                            let highlights = view::Highlights::compute(push.as_ref(), [item]).await;
                            let value = view::timeline_item(
                                item,
                                stream_user_id.as_deref(),
                                &highlights,
                                &stream_content,
                            );
                            let mut overlay = stream_overlay
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            if let Some(index) = overlay.index_of_event(&target) {
                                core.emit(CoreEvent::TimelineDiff {
                                    subscription,
                                    key: stream_key.clone(),
                                    diffs: vec![
                                        overlay.apply(crate::protocol::VectorDiff::Set {
                                            index,
                                            value,
                                        }),
                                    ],
                                });
                            }
                        }
                        continue;
                    }
                    Wake::Queue(None) => {
                        queue_updates = None;
                        continue;
                    }
                };
                if let Some(updates) = queue_updates.as_mut() {
                    while let Ok(update) = updates.try_recv() {
                        stream_content.apply(&update);
                    }
                }
                let push = stream_room.push_context().await.ok().flatten();
                let highlights = view::Highlights::for_diffs(push.as_ref(), &diffs).await;
                let diffs: Vec<_> = diffs
                    .into_iter()
                    .map(|diff| {
                        view::map_diff(diff, |item| {
                            if let Some(event) = item.as_event()
                                && event.send_state().is_none()
                                && let Some(transaction_id) = event.transaction_id()
                            {
                                stream_content.forget(transaction_id);
                            }
                            if let Some(event) = item.as_event()
                                && let Some(event_id) = event.event_id()
                            {
                                stream_content
                                    .settle(event_id, view::latest_edit_id(event).as_deref());
                            }
                            abort_rejected_redaction(&stream_timeline, item);
                            view::timeline_item(
                                item,
                                stream_user_id.as_deref(),
                                &highlights,
                                &stream_content,
                            )
                        })
                    })
                    .collect();
                let mut overlay = stream_overlay
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                core.emit(CoreEvent::TimelineDiff {
                    subscription,
                    key: stream_key.clone(),
                    diffs: diffs.into_iter().map(|diff| overlay.apply(diff)).collect(),
                });
            }
        })
        .abort_on_drop();
        let (initial_status, status_task) = pagination.map_or((None, None), |(status, stream)| {
            let core = self.clone();
            (
                Some(status),
                Some(
                    spawn(async move {
                        let mut status = Box::pin(stream);
                        while let Some(status) = status.next().await {
                            core.emit(timeline_pagination_event(subscription, status));
                        }
                    })
                    .abort_on_drop(),
                ),
            )
        });
        let (aggregations, aggregation_task) = if hidden_events {
            self.watch_aggregations(
                subscription,
                &room,
                own_user_id.clone(),
                AggregationScope::of(&focus),
            )
            .await
        } else {
            (Vec::new(), None)
        };

        let mut subscriptions = self.subscriptions.lock().await;
        let Some(entry) = subscriptions.get_mut(&subscription) else {
            return Err(RpcError::Unavailable);
        };
        entry.tasks = status_task
            .into_iter()
            .chain(aggregation_task)
            .chain([task])
            .collect();
        if let Some(status) = initial_status {
            self.emit(timeline_pagination_event(subscription, status));
        }

        Ok(SubscribeOk {
            subscription,
            items,
            aggregations,
        })
    }

    /// Lays a member's new profile over every open timeline of the room.
    pub(crate) async fn overlay_profile(
        &self,
        room_id: &RoomId,
        user_id: &UserId,
        name: Option<String>,
        avatar: Option<String>,
    ) {
        self.overlay_room(room_id, |overlay| {
            overlay.set_profile(user_id.to_owned(), name.clone(), avatar.clone())
        })
        .await;
    }

    /// Shows why `redacted` was deleted in every open timeline of the room.
    pub(crate) async fn overlay_redaction(
        &self,
        room_id: &RoomId,
        redacted: &EventId,
        reason: &str,
    ) {
        self.overlay_room(room_id, |overlay| {
            overlay.set_redaction_reason(redacted.to_owned(), reason.to_owned())
        })
        .await;
    }

    /// Fills in the replies to `replied` in every open timeline of the room.
    pub(crate) async fn overlay_reply(
        &self,
        room_id: &RoomId,
        replied: &EventId,
        stand_in: &ReplyFallback,
    ) {
        self.overlay_room(room_id, |overlay| {
            overlay.set_reply(replied.to_owned(), stand_in.clone())
        })
        .await;
    }

    async fn overlay_room(
        &self,
        room_id: &RoomId,
        change: impl Fn(&mut TimelineOverlay) -> Vec<crate::protocol::VectorDiff<TimelineItemView>>,
    ) {
        let subscriptions = self.subscriptions.lock().await;
        for (subscription, entry) in subscriptions.iter() {
            let (SubscriptionKind::LiveTimeline(room) | SubscriptionKind::FocusedTimeline(room)) =
                &entry.kind
            else {
                continue;
            };
            let Some(overlay) = entry.overlay.as_ref().filter(|_| room == room_id) else {
                continue;
            };
            let mut overlay = overlay
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let diffs = change(&mut overlay);
            if !diffs.is_empty() {
                self.emit(CoreEvent::TimelineDiff {
                    subscription: *subscription,
                    key: entry.timeline_key.clone(),
                    diffs,
                });
            }
        }
    }

    /// The SDK's details for a reply, or what the replied-to event's source
    /// says when it has none.
    pub(crate) async fn fetch_event_details(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        thread_root: Option<&OwnedEventId>,
    ) -> Result<(), RpcError> {
        let timeline = self.timeline_for(room_id, thread_root).await?;
        let fetched = timeline.fetch_details_for_event(event_id).await;
        if let Err(TimelineError::EventNotInTimeline(_)) = fetched {
            tracing::debug!(
                context = "fetch_event_details",
                "the event left the timeline"
            );
            return Err(RpcError::Unavailable);
        }
        let unresolved = timeline
            .item_by_event_id(event_id)
            .await
            .and_then(|item| view::reply_without_body(item.content()));
        if let Some(replied) = unresolved {
            match self.event_source(room_id, &replied, false).await {
                Ok((source, _, _)) => {
                    let stand_in = serde_json::from_str(&source)
                        .ok()
                        .and_then(|source| ReplyFallback::from_source(&source));
                    if let Some(stand_in) = stand_in {
                        self.overlay_reply(room_id, &replied, &stand_in).await;
                    }
                }
                Err(error) => {
                    tracing::debug!(?error, "replied-to event unavailable");
                }
            }
        }
        fetched.or_failed(self, "fetch_event_details")?;
        Ok(())
    }

    async fn watch_aggregations(
        self: &Arc<Self>,
        subscription: SubscriptionId,
        room: &matrix_sdk::Room,
        own_user_id: Option<OwnedUserId>,
        scope: AggregationScope,
    ) -> (Vec<TimelineItemView>, Option<Task>) {
        let client = room.client();
        let Some(event_cache) = client.event_cache() else {
            return (Vec::new(), None);
        };
        let Ok((cache, _handles)) = event_cache.room(room.room_id()).await else {
            return (Vec::new(), None);
        };
        let Ok((cached, mut updates)) = cache.subscribe().await else {
            return (Vec::new(), None);
        };
        let rules = room.clone_info().room_version_rules_or_default();
        let lookup = move |id: OwnedEventId| {
            let cache = cache.clone();
            async move { cache.find_event(&id).await.ok().flatten() }
        };
        let cached = scope.retain(cached, &lookup).await;
        let items = aggregation_items(cached, &rules, own_user_id.as_deref());

        let core = self.clone();
        let task = spawn(async move {
            use tokio::sync::broadcast::error::RecvError;

            loop {
                let update = match updates.recv().await {
                    Ok(update) => update,
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                };
                let RoomEventCacheUpdate::UpdateTimelineEvents(update) = update else {
                    continue;
                };
                let events = update.diffs.into_iter().flat_map(diff_events).collect();
                let events = scope.retain(events, &lookup).await;
                let items = aggregation_items(events, &rules, own_user_id.as_deref());
                if !items.is_empty() {
                    core.emit(CoreEvent::TimelineAggregations {
                        subscription,
                        items,
                    });
                }
            }
        })
        .abort_on_drop();

        (items, Some(task))
    }

    pub(crate) async fn warm_rooms(
        &self,
        WarmRoomsParams { room_ids }: WarmRoomsParams,
    ) -> Result<(), RpcError> {
        let client = self.client().await?;
        let mut subscribed = self.room_subscriptions.lock().await;
        for room_id in room_ids {
            if client
                .get_room(&room_id)
                .is_some_and(|room| room.state() == matrix_sdk::RoomState::Joined)
            {
                self.remember_warm(room_id);
            }
        }
        self.sync_timeline_rooms_locked(&mut subscribed).await?;
        Ok(())
    }

    fn remember_warm(&self, room_id: OwnedRoomId) {
        let mut warm = self
            .warm_rooms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        warm.retain(|warmed| *warmed != room_id);
        warm.push_back(room_id);
        while warm.len() > MAX_WARM_ROOMS {
            warm.pop_front();
        }
    }

    /// The SDK drops its room subscriptions when the sync session expires.
    pub(crate) async fn resubscribe_timeline_rooms(&self) {
        let mut subscribed = self.room_subscriptions.lock().await;
        subscribed.clear();
        if let Err(error) = self.sync_timeline_rooms_locked(&mut subscribed).await {
            tracing::warn!(?error, "failed to restore room subscriptions");
        }
    }

    pub(crate) async fn sync_timeline_rooms_locked(
        &self,
        subscribed: &mut std::collections::BTreeSet<OwnedRoomId>,
    ) -> Result<(), RpcError> {
        let subscriptions = self.subscriptions.lock().await;
        let room_ids = subscriptions
            .values()
            .filter_map(|subscription| match &subscription.kind {
                SubscriptionKind::LiveTimeline(room_id)
                | SubscriptionKind::FocusedTimeline(room_id) => Some(room_id.clone()),
                SubscriptionKind::Other => None,
            })
            .chain(
                self.warm_rooms
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .iter()
                    .cloned(),
            )
            .collect::<std::collections::BTreeSet<_>>();
        drop(subscriptions);
        if room_ids == *subscribed {
            return Ok(());
        }

        let room_refs = room_ids.iter().map(OwnedRoomId::as_ref).collect::<Vec<_>>();
        tracing::info!(rooms = room_refs.len(), "set_room_subscriptions: start");
        let service = self.sync_service().await?;
        tracing::info!("set_room_subscriptions: sync service acquired");
        service
            .room_list_service()
            .set_room_subscriptions(&room_refs)
            .await;
        tracing::info!("set_room_subscriptions: done");
        *subscribed = room_ids;
        Ok(())
    }
}

async fn due(wait: Option<Duration>) {
    match wait {
        Some(wait) => matrix_sdk::sleep::sleep(wait).await,
        None => std::future::pending().await,
    }
}

fn diff_events(diff: VectorDiff<Event>) -> Vec<Event> {
    match diff {
        VectorDiff::Append { values } | VectorDiff::Reset { values } => {
            values.into_iter().collect()
        }
        VectorDiff::PushFront { value }
        | VectorDiff::PushBack { value }
        | VectorDiff::Insert { value, .. }
        | VectorDiff::Set { value, .. } => vec![value],
        VectorDiff::Clear
        | VectorDiff::PopFront
        | VectorDiff::PopBack
        | VectorDiff::Remove { .. }
        | VectorDiff::Truncate { .. } => Vec::new(),
    }
}

pub(crate) const fn timeline_pagination_event(
    subscription: SubscriptionId,
    status: PaginationStatus,
) -> CoreEvent {
    match status {
        PaginationStatus::Paginating => CoreEvent::TimelinePagination {
            subscription,
            loading: true,
            reached_start: false,
        },
        PaginationStatus::Idle { hit_timeline_start } => CoreEvent::TimelinePagination {
            subscription,
            loading: false,
            reached_start: hit_timeline_start,
        },
    }
}
