use std::{collections::HashMap, sync::Arc};

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::event_cache::{PaginationStatus, RoomEventCacheUpdate};
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId};
use matrix_sdk_base::event_cache::Event;
use matrix_sdk_ui::eyeball_im::VectorDiff;
use matrix_sdk_ui::room_list_service::RoomListLoadingState;
use matrix_sdk_ui::room_list_service::filters::{
    new_filter_all, new_filter_deduplicate_versions, new_filter_non_left,
};
use matrix_sdk_ui::timeline::{EventSendState, SendTarget, Timeline, TimelineItem};

use crate::protocol::{
    CommandErr, CommandOk, CoreEvent, SubscriptionId, TimelineFocusView, TimelineItemView,
};

use crate::timelines::{aggregation_items, build_room_timeline, fill_sender_profiles};
use crate::view;
use crate::{Core, Subscription, SubscriptionKind, Task};

const ROOM_LIST_PAGE_SIZE: usize = 200;

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
    pub(crate) async fn subscribe_room_list(self: &Arc<Self>) -> Result<CommandOk, CommandErr> {
        let sync_service = {
            let guard = self.session.read().await;
            guard
                .as_ref()
                .ok_or(CommandErr::NotLoggedIn)?
                .sync_service
                .clone()
        };

        let subscription = self.allocate_subscription();
        let core = self.clone();

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
            controller.set_filter(Box::new(new_filter_all(vec![
                Box::new(new_filter_non_left()),
                Box::new(new_filter_deduplicate_versions()),
            ])));

            // Refreshed from each diff before constructing synchronous summaries.
            let mut room_cache: HashMap<OwnedRoomId, view::RoomInfo> = HashMap::new();

            let mut stream = Box::pin(stream);
            let mut grown_to = 0;
            while let Some(diffs) = stream.next().await {
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
                for diff in &diffs {
                    view::enrich_room_fields(diff, &mut room_cache).await;
                }
                let every_encrypted = match core.client().await {
                    Ok(client) => crate::notifications::every_encrypted_event_pushed(&client).await,
                    Err(_) => false,
                };
                core.emit(CoreEvent::RoomListDiff {
                    subscription,
                    diffs: diffs
                        .into_iter()
                        .map(|diff| {
                            view::map_diff(diff, |item| {
                                view::room_summary(item, &room_cache, every_encrypted)
                            })
                        })
                        .collect(),
                });
            }
        })
        .abort_on_drop();

        self.subscriptions.lock().await.insert(
            subscription,
            Subscription {
                tasks: vec![task],
                timeline: None,
                thread_root: None,
                kind: SubscriptionKind::Other,
            },
        );

        // The filter makes the stream open with a `Reset` carrying everything.
        Ok(CommandOk::SubscribeRoomList {
            subscription,
            rooms: Vec::new(),
        })
    }

    #[allow(clippy::arc_with_non_send_sync)] // Matrix timelines are single-threaded on WASM
    #[allow(clippy::too_many_lines)] // Keep subscription registration and owned tasks together.
    pub(crate) async fn subscribe_timeline(
        self: &Arc<Self>,
        room_id: OwnedRoomId,
        focus: TimelineFocusView,
        hidden_events: bool,
    ) -> Result<CommandOk, CommandErr> {
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
                    .map_err(|error| self.failed("build focused timeline", error))?,
            ),
        };
        fill_sender_profiles(&room, &timeline);
        let relays = Arc::new(room.service_members().unwrap_or_default());

        // The SDK replaces its explicit-room set wholesale. Register before
        let mut subscribed = self.room_subscriptions.lock().await;
        self.subscriptions.lock().await.insert(
            subscription,
            Subscription {
                tasks: Vec::new(),
                timeline: Some(timeline.clone()),
                thread_root: match &focus {
                    TimelineFocusView::Thread { root_event_id } => Some(root_event_id.clone()),
                    TimelineFocusView::Live | TimelineFocusView::Event { .. } => None,
                },
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
        let (items, stream) = timeline.subscribe().await;
        let (echoes, mut queue_updates) = match room.send_queue().subscribe().await {
            Ok((echoes, updates)) => (echoes, Some(updates)),
            Err(_) => (Vec::new(), None),
        };
        let local_content = view::LocalContent::new(&echoes);
        let mut stream_content = view::LocalContent::new(&echoes);
        let pagination = timeline.live_back_pagination_status().await;
        let own_user_id = self.client().await?.user_id().map(ToOwned::to_owned);
        let core = self.clone();
        let stream_user_id = own_user_id.clone();
        let stream_relays = relays.clone();
        let stream_room = room.clone();
        let stream_timeline = timeline.clone();
        let task = spawn(async move {
            pin_mut!(stream);
            while let Some(diffs) = stream.next().await {
                if let Some(updates) = queue_updates.as_mut() {
                    while let Ok(update) = updates.try_recv() {
                        stream_content.apply(&update);
                    }
                }
                let push = stream_room.push_context().await.ok().flatten();
                let highlights = view::Highlights::for_diffs(push.as_ref(), &diffs).await;
                core.emit(CoreEvent::TimelineDiff {
                    subscription,
                    diffs: diffs
                        .into_iter()
                        .map(|diff| {
                            view::map_diff(diff, |item| {
                                if let Some(event) = item.as_event()
                                    && event.send_state().is_none()
                                    && let Some(transaction_id) = event.transaction_id()
                                {
                                    stream_content.forget(transaction_id);
                                }
                                abort_rejected_redaction(&stream_timeline, item);
                                view::timeline_item(
                                    item,
                                    stream_user_id.as_deref(),
                                    &stream_relays,
                                    &highlights,
                                    &stream_content,
                                )
                            })
                        })
                        .collect(),
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
            self.watch_aggregations(subscription, &room, own_user_id.clone())
                .await
        } else {
            (Vec::new(), None)
        };

        let mut subscriptions = self.subscriptions.lock().await;
        let Some(entry) = subscriptions.get_mut(&subscription) else {
            return Err(CommandErr::Unavailable);
        };
        entry.tasks = status_task
            .into_iter()
            .chain(aggregation_task)
            .chain([task])
            .collect();
        if let Some(status) = initial_status {
            self.emit(timeline_pagination_event(subscription, status));
        }

        let push = room.push_context().await.ok().flatten();
        let highlights = view::Highlights::compute(push.as_ref(), items.iter()).await;

        Ok(CommandOk::SubscribeTimeline {
            subscription,
            aggregations,
            items: items
                .iter()
                .map(|item| {
                    abort_rejected_redaction(&timeline, item);
                    view::timeline_item(
                        item,
                        own_user_id.as_deref(),
                        &relays,
                        &highlights,
                        &local_content,
                    )
                })
                .collect(),
        })
    }

    async fn watch_aggregations(
        self: &Arc<Self>,
        subscription: SubscriptionId,
        room: &matrix_sdk::Room,
        own_user_id: Option<OwnedUserId>,
    ) -> (Vec<TimelineItemView>, Option<Task>) {
        let Ok((cache, _handles)) = room.event_cache().await else {
            return (Vec::new(), None);
        };
        let Ok((cached, mut updates)) = cache.subscribe().await else {
            return (Vec::new(), None);
        };
        let rules = room.clone_info().room_version_rules_or_default();
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
                let events = update.diffs.into_iter().flat_map(diff_events);
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

    pub(crate) async fn sync_timeline_rooms_locked(
        &self,
        subscribed: &mut std::collections::BTreeSet<OwnedRoomId>,
    ) -> Result<(), CommandErr> {
        let subscriptions = self.subscriptions.lock().await;
        let room_ids = subscriptions
            .values()
            .filter_map(|subscription| match &subscription.kind {
                SubscriptionKind::LiveTimeline(room_id)
                | SubscriptionKind::FocusedTimeline(room_id) => Some(room_id.clone()),
                SubscriptionKind::Other => None,
            })
            .collect::<std::collections::BTreeSet<_>>();
        drop(subscriptions);
        if room_ids.is_empty() || room_ids == *subscribed {
            return Ok(());
        }

        let room_refs = room_ids.iter().map(OwnedRoomId::as_ref).collect::<Vec<_>>();
        self.sync_service()
            .await?
            .room_list_service()
            .set_room_subscriptions(&room_refs)
            .await;
        *subscribed = room_ids;
        Ok(())
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
