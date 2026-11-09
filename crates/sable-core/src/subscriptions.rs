use crate::api::timeline::SubscribeParams;
use crate::api::timeline::TimelineFocusView;
use crate::api::timeline::WarmRoomsParams;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};

use futures_util::future::{self, Either};
use futures_util::{Stream, StreamExt, pin_mut};
use matrix_sdk::event_cache::{PaginationStatus, RoomEventCacheUpdate};
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::push::Ruleset;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId, OwnedUserId, RoomId, UserId};
use matrix_sdk::send_queue::RoomSendQueueUpdate;
use matrix_sdk_base::event_cache::Event;
use matrix_sdk_ui::eyeball_im::VectorDiff;
use matrix_sdk_ui::room_list_service::RoomListItem;
use matrix_sdk_ui::room_list_service::filters::new_filter_non_left;
use matrix_sdk_ui::timeline::{
    Error as TimelineError, EventSendState, SendTarget, Timeline, TimelineItem,
};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc, watch};
use web_time::Instant;

use crate::ResultExt;
use crate::api::timeline::{SubscribeOk, SubscribeRoomListOk};
use crate::notifications;
use crate::protocol::{
    CoreEvent, RoomListItemView, RoomListOptionsView, RpcError, SubscriptionId, TimelineItemView,
};
use crate::push_rules::PushRules;
use crate::room_list_batch::DiffBatch;
use crate::room_list_rows::{DmSpaceLinks, RoomListRows};
use crate::room_sections::RoomSections;
use crate::space_parents::{ParentResult, ParentTracker};
use crate::timeline_overlay::{ReplyFallback, TimelineOverlay};
use crate::timelines::{
    AggregationScope, aggregation_items, build_room_timeline, fill_sender_profiles,
};
use crate::view;
use crate::{Core, Subscription, SubscriptionKind, Task};

const BRIDGE_EVENTS: [&str; 2] = ["m.bridge", "uk.half-shot.bridge"];

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

/// A lagged room list resends a `Reset` cut to the page size, so a smaller page drops rooms.
const ROOM_LIST_PAGE_SIZE: usize = usize::MAX;
const ROOM_LIST_BATCH_INTERVAL: Duration = Duration::from_millis(100);
pub(crate) const MAX_WARM_ROOMS: usize = 32;

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

struct RoomListWorker {
    client: matrix_sdk::Client,
    push_rules: Arc<PushRules>,
    rules: Ruleset,
    /// Refreshed from each diff before constructing synchronous summaries.
    room_cache: HashMap<OwnedRoomId, view::RoomInfo>,
    rows: RoomListRows,
    sections: RoomSections,
    options: watch::Receiver<RoomListOptionsView>,
    dm_spaces: DmSpaceLinks,
    parents: ParentTracker,
    dm_spaces_changed: watch::Receiver<()>,
    nicknames: watch::Receiver<crate::nicknames::Nicknames>,
    core: Arc<Core>,
    subscription: SubscriptionId,
}

enum ParentStateChange {
    Room(OwnedRoomId),
    Space(OwnedRoomId),
    Member(OwnedRoomId, OwnedUserId),
}

impl RoomListWorker {
    fn watch_parent_state(
        &self,
    ) -> (
        matrix_sdk::event_handler::EventHandlerDropGuard,
        mpsc::UnboundedReceiver<ParentStateChange>,
    ) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let handle = self.client.add_event_handler(
            move |raw: matrix_sdk::ruma::serde::Raw<
                matrix_sdk::ruma::events::AnySyncStateEvent,
            >,
                  room: matrix_sdk::Room| {
                let sender = sender.clone();
                async move {
                    let Ok(event) = raw.deserialize_as_unchecked::<serde_json::Value>() else {
                        return;
                    };
                    let kind = event.get("type").and_then(serde_json::Value::as_str);
                    let change = if kind == Some("m.space.parent") {
                        Some(ParentStateChange::Room(room.room_id().to_owned()))
                    } else if room.is_space() && kind == Some("m.room.member") {
                        event
                            .get("state_key")
                            .and_then(serde_json::Value::as_str)
                            .and_then(|user| OwnedUserId::try_from(user).ok())
                            .map(|user| ParentStateChange::Member(room.room_id().to_owned(), user))
                    } else if room.is_space()
                        && matches!(
                            kind,
                            Some("m.space.child" | "m.room.power_levels" | "m.room.create")
                        )
                    {
                        Some(ParentStateChange::Space(room.room_id().to_owned()))
                    } else {
                        None
                    };
                    if let Some(change) = change {
                        let _ = sender.send(change);
                    }
                }
            },
        );
        (self.client.event_handler_drop_guard(handle), receiver)
    }

    fn watch_avatar_overrides(
        &self,
    ) -> (
        matrix_sdk::event_handler::EventHandlerDropGuard,
        mpsc::UnboundedReceiver<OwnedRoomId>,
    ) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let handle = self.client.add_event_handler(
            move |raw: matrix_sdk::ruma::serde::Raw<
                matrix_sdk::ruma::events::AnyRoomAccountDataEvent,
            >,
                  room: matrix_sdk::Room| {
                let sender = sender.clone();
                async move {
                    if raw.get_field::<String>("type").ok().flatten().as_deref()
                        == Some(crate::spaces::AVATAR_OVERRIDE_EVENT)
                    {
                        let _ = sender.send(room.room_id().to_owned());
                    }
                }
            },
        );
        (self.client.event_handler_drop_guard(handle), receiver)
    }

    async fn on_avatar_overrides(
        &mut self,
        room_ids: HashSet<OwnedRoomId>,
    ) -> Vec<crate::protocol::VectorDiff<RoomListItemView>> {
        let rooms: Vec<_> = room_ids
            .iter()
            .filter(|room_id| self.room_cache.contains_key(*room_id))
            .filter_map(|room_id| self.client.get_room(room_id))
            .map(RoomListItem::from)
            .collect();
        view::enrich_rooms(&rooms, &mut self.room_cache).await;
        self.rows.refresh(
            &rooms,
            &self.room_cache,
            &self.rules,
            &self.nicknames.borrow(),
        )
    }

    async fn run(
        mut self,
        mut stream: impl Stream<Item = Vec<VectorDiff<RoomListItem>>> + Unpin,
        mut stores_open: watch::Receiver<bool>,
        mut rule_changes: broadcast::Receiver<()>,
        mut parent_results: mpsc::UnboundedReceiver<ParentResult>,
    ) {
        let mut batch = DiffBatch::new(ROOM_LIST_BATCH_INTERVAL);
        self.dm_spaces = self.load_dm_spaces().await;
        let (_handler, mut state_changes) = self.watch_parent_state();
        let (_override_handler, mut avatar_overrides) = self.watch_avatar_overrides();
        loop {
            let held = batch.wait(Instant::now());
            let diffs = tokio::select! {
                _ = stores_open.changed() => {
                    if !*stores_open.borrow_and_update() {
                        continue;
                    }
                    let Some(diffs) = self.on_stores_reopened().await else {
                        continue;
                    };
                    diffs
                }
                () = due(held) => {
                    self.emit(batch.take(Instant::now()));
                    continue;
                }
                changed = self.options.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    if held.is_none() {
                        self.emit(Vec::new());
                    }
                    continue;
                }
                changed = self.dm_spaces_changed.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    self.dm_spaces = self.load_dm_spaces().await;
                    self.rows.relink(&self.room_cache, &self.dm_spaces, &self.parents.links)
                }
                change = state_changes.recv() => {
                    let Some(change) = change else { break; };
                    let mut rooms = HashSet::new();
                    let mut spaces = HashSet::new();
                    let mut members = HashSet::new();
                    for change in std::iter::once(change).chain(std::iter::from_fn(|| state_changes.try_recv().ok())) {
                        match change {
                            ParentStateChange::Room(id) => { rooms.insert(id); }
                            ParentStateChange::Space(id) => { spaces.insert(id); }
                            ParentStateChange::Member(id, user) => { members.insert((id, user)); }
                        }
                    }
                    self.refresh_changed_parents(&rooms, &spaces, &members).await;
                    self.rows.relink(&self.room_cache, &self.dm_spaces, &self.parents.links)
                }
                room_id = avatar_overrides.recv() => {
                    let Some(room_id) = room_id else { break; };
                    let room_ids = std::iter::once(room_id)
                        .chain(std::iter::from_fn(|| avatar_overrides.try_recv().ok()))
                        .collect();
                    let diffs = self.on_avatar_overrides(room_ids).await;
                    if diffs.is_empty() {
                        continue;
                    }
                    diffs
                }
                result = parent_results.recv() => {
                    let Some(result) = result else { break; };
                    if !self.parents.apply(&self.client, result) { continue; }
                    self.rows.relink(&self.room_cache, &self.dm_spaces, &self.parents.links)
                }
                diffs = stream.next() => {
                    let Some(diffs) = diffs else { break };
                    self.on_entries(diffs).await
                }
                changed = self.nicknames.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    let nicknames = self.nicknames.borrow_and_update().clone();
                    let diffs = self.rows.rename(&nicknames, &self.room_cache);
                    if diffs.is_empty() {
                        continue;
                    }
                    diffs
                }
                changed = rule_changes.recv() => {
                    if matches!(changed, Err(RecvError::Closed)) {
                        break;
                    }
                    let Some(diffs) = self.on_rules_changed().await else {
                        continue;
                    };
                    diffs
                }
            };
            if let Some(diffs) = batch.push(diffs, Instant::now()) {
                self.emit(diffs);
            }
        }
    }

    fn emit(&mut self, diffs: Vec<crate::protocol::VectorDiff<RoomListItemView>>) {
        let next = RoomSections::build(self.rows.rows(), &self.options.borrow_and_update());
        let sections = self.sections.update(next);
        if diffs.is_empty() && sections.is_none() {
            return;
        }
        self.core.emit(CoreEvent::RoomListDiff {
            subscription: self.subscription,
            diffs,
            sections,
        });
    }

    async fn load_dm_spaces(&self) -> DmSpaceLinks {
        crate::account_documents::synced_dm_spaces(&self.client).await
    }

    async fn refresh_changed_parents(
        &mut self,
        rooms: &HashSet<OwnedRoomId>,
        spaces: &HashSet<OwnedRoomId>,
        members: &HashSet<(OwnedRoomId, OwnedUserId)>,
    ) {
        let listed = self
            .rows
            .rows()
            .iter()
            .map(|row| row.room_id.clone())
            .collect();
        self.parents
            .refresh(&self.core, &self.client, &listed, rooms, spaces, members)
            .await;
    }

    async fn on_stores_reopened(
        &mut self,
    ) -> Option<Vec<crate::protocol::VectorDiff<RoomListItemView>>> {
        let rooms: Vec<_> = self
            .room_cache
            .iter()
            .filter(|(_, info)| info.children_stale)
            .filter_map(|(room_id, _)| self.client.get_room(room_id))
            .map(RoomListItem::from)
            .collect();
        view::enrich_rooms(&rooms, &mut self.room_cache).await;
        let mut diffs = self.rows.refresh(
            &rooms,
            &self.room_cache,
            &self.rules,
            &self.nicknames.borrow(),
        );
        let rooms = self
            .rows
            .rows()
            .iter()
            .map(|row| row.room_id.clone())
            .collect();
        self.refresh_changed_parents(&rooms, &HashSet::new(), &HashSet::new())
            .await;
        diffs.extend(
            self.rows
                .relink(&self.room_cache, &self.dm_spaces, &self.parents.links),
        );
        (!diffs.is_empty()).then_some(diffs)
    }

    async fn on_entries(
        &mut self,
        diffs: Vec<VectorDiff<RoomListItem>>,
    ) -> Vec<crate::protocol::VectorDiff<RoomListItemView>> {
        view::prime_display_names(&diffs).await;
        view::enrich_room_batch(&diffs, &mut self.room_cache).await;
        let mut diffs: Vec<_> = diffs
            .into_iter()
            .map(|diff| {
                view::map_diff(diff, |item| {
                    view::room_list_item(
                        item,
                        &self.room_cache,
                        &self.rules,
                        &self.nicknames.borrow(),
                    )
                })
            })
            .collect();
        let previous: std::collections::HashSet<_> = self
            .rows
            .rows()
            .iter()
            .map(|row| row.room_id.clone())
            .collect();
        for diff in &diffs {
            self.rows.apply(diff);
        }
        self.rows.evict(&mut self.room_cache);
        let current: HashSet<_> = self
            .rows
            .rows()
            .iter()
            .map(|row| row.room_id.clone())
            .collect();
        let added = current.difference(&previous).cloned().collect();
        let changed_spaces = current.symmetric_difference(&previous).cloned().collect();
        self.refresh_changed_parents(&added, &changed_spaces, &HashSet::new())
            .await;
        diffs.extend(
            self.rows
                .relink(&self.room_cache, &self.dm_spaces, &self.parents.links),
        );
        diffs
    }

    async fn on_rules_changed(
        &mut self,
    ) -> Option<Vec<crate::protocol::VectorDiff<RoomListItemView>>> {
        self.rules = self.push_rules.snapshot().await;
        let client = &self.client;
        let diffs = self.rows.renotify(&self.rules, |room_id| {
            client
                .get_room(room_id)
                .is_some_and(|room| notifications::uses_direct_push_rules(&room))
        });
        (!diffs.is_empty()).then_some(diffs)
    }
}

struct TimelineWorker {
    core: Arc<Core>,
    subscription: SubscriptionId,
    room: matrix_sdk::Room,
    timeline: Arc<Timeline>,
    overlay: Arc<parking_lot::Mutex<TimelineOverlay>>,
    user_id: Option<OwnedUserId>,
    content: view::LocalContent,
    queue_updates: Option<tokio::sync::broadcast::Receiver<RoomSendQueueUpdate>>,
}

impl TimelineWorker {
    async fn run(mut self, stream: impl Stream<Item = Vec<VectorDiff<Arc<TimelineItem>>>>) {
        pin_mut!(stream);
        loop {
            let wake = {
                let update = next_queue_update(&mut self.queue_updates);
                pin_mut!(update);
                match future::select(stream.next(), update).await {
                    Either::Left((diffs, _)) => Wake::Diffs(diffs),
                    Either::Right((update, _)) => Wake::Queue(update),
                }
            };
            match wake {
                Wake::Diffs(Some(diffs)) => self.on_diffs(diffs).await,
                Wake::Diffs(None) => break,
                Wake::Queue(Some(update)) => self.on_queue_update(&update).await,
                Wake::Queue(None) => self.queue_updates = None,
            }
        }
    }

    async fn on_queue_update(&mut self, update: &RoomSendQueueUpdate) {
        let Some(target) = self.content.apply(update) else {
            return;
        };
        let items = self.timeline.items().await;
        let Some(item) = items
            .iter()
            .find(|item| item.as_event().and_then(|event| event.event_id()) == Some(&target))
        else {
            return;
        };
        let push = self.room.push_context().await.ok().flatten();
        let highlights = view::Highlights::compute(push.as_ref(), [item]).await;
        let value = view::timeline_item(item, self.user_id.as_deref(), &highlights, &self.content);
        let mut overlay = self.overlay.lock();
        if let Some(index) = overlay.index_of_event(&target) {
            self.core.emit(CoreEvent::TimelineDiff {
                subscription: self.subscription,
                diffs: vec![overlay.apply(crate::protocol::VectorDiff::Set { index, value })],
            });
        }
    }

    async fn on_diffs(&mut self, diffs: Vec<VectorDiff<Arc<TimelineItem>>>) {
        if let Some(updates) = self.queue_updates.as_mut() {
            while let Ok(update) = updates.try_recv() {
                self.content.apply(&update);
            }
        }
        let push = self.room.push_context().await.ok().flatten();
        let highlights = view::Highlights::for_diffs(push.as_ref(), &diffs).await;
        let diffs: Vec<_> = diffs
            .into_iter()
            .map(|diff| {
                view::map_diff(diff, |item| {
                    if let Some(event) = item.as_event()
                        && event.send_state().is_none()
                        && let Some(transaction_id) = event.transaction_id()
                    {
                        self.content.forget(transaction_id);
                    }
                    if let Some(event) = item.as_event()
                        && let Some(event_id) = event.event_id()
                    {
                        self.content
                            .settle(event_id, view::latest_edit_id(event).as_deref());
                    }
                    abort_rejected_redaction(&self.timeline, item);
                    view::timeline_item(item, self.user_id.as_deref(), &highlights, &self.content)
                })
            })
            .collect();
        let mut overlay = self.overlay.lock();
        self.core.emit(CoreEvent::TimelineDiff {
            subscription: self.subscription,
            diffs: diffs.into_iter().map(|diff| overlay.apply(diff)).collect(),
        });
    }
}

impl Core {
    pub(crate) async fn subscribe_room_list(
        self: &Arc<Self>,
        options: RoomListOptionsView,
    ) -> Result<SubscribeRoomListOk, RpcError> {
        self.room_list_options.send_replace(options);
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
        let stores_open = self.stores_open.subscribe();
        let task = spawn(async move {
            let room_list = match sync_service.room_list_service().all_rooms().await {
                Ok(room_list) => room_list,
                Err(error) => {
                    tracing::error!("all_rooms failed: {error}");
                    return;
                }
            };

            let (stream, controller) = room_list.entries_with_dynamic_adapters(ROOM_LIST_PAGE_SIZE);
            controller.set_filter(Box::new(new_filter_non_left()));

            let rule_changes = push_rules.subscribe();
            let rules = push_rules.snapshot().await;
            let nicknames = core.nickname_changes();
            let (parent_results_tx, parent_results_rx) = mpsc::unbounded_channel();
            let worker = RoomListWorker {
                client,
                push_rules,
                rules,
                room_cache: HashMap::new(),
                rows: RoomListRows::default(),
                sections: RoomSections::default(),
                options: core.room_list_options.subscribe(),
                dm_spaces: DmSpaceLinks::default(),
                parents: ParentTracker::new(parent_results_tx),
                dm_spaces_changed: core.dm_spaces_changed.subscribe(),
                nicknames,
                core,
                subscription,
            };
            worker
                .run(
                    Box::pin(stream),
                    stores_open,
                    rule_changes,
                    parent_results_rx,
                )
                .await;
        })
        .abort_on_drop();

        self.subscriptions.lock().await.insert(
            subscription,
            Subscription {
                tasks: vec![task],
                timeline: None,
                overlay: None,
                thread_root: None,
                kind: SubscriptionKind::Other,
            },
        );

        // The filter makes the stream open with a `Reset` carrying everything.
        Ok(SubscribeRoomListOk {
            subscription,
            rooms: Vec::new(),
        })
    }

    pub(crate) async fn subscribe_timeline(
        self: &Arc<Self>,
        SubscribeParams {
            room_id,
            focus,
            hidden_events,
        }: SubscribeParams,
    ) -> Result<SubscribeOk, RpcError> {
        self.wait_for_stores().await;
        let subscription = self.allocate_subscription();
        let room = self.room(&room_id).await?;
        let timeline = self
            .open_timeline(&room, &room_id, &focus, hidden_events)
            .await?;
        fill_sender_profiles(&room, &timeline);
        let overlay = self.new_overlay();

        let _subscribed = self
            .register_timeline(subscription, &room_id, &focus, &timeline, &overlay)
            .await?;
        let (items, stream) = timeline.subscribe().await;
        let (echoes, queue_updates) = match room.send_queue().subscribe().await {
            Ok((echoes, updates)) => (echoes, Some(updates)),
            Err(error) => {
                tracing::warn!(%room_id, "local echoes unavailable: {error}");
                (Vec::new(), None)
            }
        };
        let local_content = view::LocalContent::new(&echoes);
        let stream_content = view::LocalContent::new(&echoes);
        let pagination = timeline.live_back_pagination_status().await;
        let own_user_id = self.client().await?.user_id().map(ToOwned::to_owned);
        let items = snapshot_items(
            &room,
            &timeline,
            &items,
            own_user_id.as_deref(),
            &local_content,
        )
        .await;
        let encrypted = room.encryption_state().is_encrypted();
        let stored_bridge = encrypted && self.stored_bridge(&room).await;
        if stored_bridge {
            overlay.lock().set_bridged();
        }
        // Seeded before the stream starts, so its diffs apply to this snapshot.
        let items = overlay.lock().reset(items);
        let task = spawn(
            TimelineWorker {
                core: self.clone(),
                subscription,
                room: room.clone(),
                timeline: timeline.clone(),
                overlay: overlay.clone(),
                user_id: own_user_id.clone(),
                content: stream_content,
                queue_updates,
            }
            .run(stream),
        )
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
        let (aggregations, aggregation_task) = self
            .watch_aggregations(
                subscription,
                &room,
                own_user_id.clone(),
                AggregationScope::of(&focus),
            )
            .await;

        let threads_task = self.watch_threads(&room_id).await?;
        let bridge_task = (encrypted && !stored_bridge).then(|| self.watch_bridge(&room));

        let mut subscriptions = self.subscriptions.lock().await;
        let Some(entry) = subscriptions.get_mut(&subscription) else {
            return Err(RpcError::Unavailable);
        };
        entry.tasks = status_task
            .into_iter()
            .chain(aggregation_task)
            .chain(bridge_task)
            .chain(threads_task)
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

    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::arc_with_non_send_sync,
            reason = "matrix timelines are single-threaded on WASM"
        )
    )]
    async fn open_timeline(
        self: &Arc<Self>,
        room: &matrix_sdk::Room,
        room_id: &OwnedRoomId,
        focus: &TimelineFocusView,
        hidden_events: bool,
    ) -> Result<Arc<Timeline>, RpcError> {
        Ok(match focus {
            TimelineFocusView::Live => self.live_timeline(room_id, hidden_events).await?,
            TimelineFocusView::Thread { root_event_id } => {
                self.thread_timeline(room_id, root_event_id).await?
            }
            TimelineFocusView::Event { .. } => Arc::new(
                build_room_timeline(room, focus, hidden_events)
                    .await
                    .or_failed(self, "build_focused_timeline")?,
            ),
        })
    }

    async fn watch_threads(
        self: &Arc<Self>,
        room_id: &OwnedRoomId,
    ) -> Result<Option<Task>, RpcError> {
        Ok(self.client().await?.event_cache().map(|cache| {
            let mut updates = cache.subscribe_to_room_generic_updates();
            let core = self.clone();
            let room_id = room_id.clone();
            core.emit(CoreEvent::ThreadsChanged {
                room_id: room_id.clone(),
            });
            spawn(async move {
                loop {
                    match updates.recv().await {
                        Ok(update) if update.room_id != room_id => continue,
                        Err(RecvError::Closed) => break,
                        Ok(_) | Err(RecvError::Lagged(_)) => {}
                    }
                    core.emit(CoreEvent::ThreadsChanged {
                        room_id: room_id.clone(),
                    });
                }
            })
            .abort_on_drop()
        }))
    }

    fn watch_bridge(self: &Arc<Self>, room: &matrix_sdk::Room) -> Task {
        let core = self.clone();
        let room = room.clone();
        spawn(async move {
            if core.served_bridge(&room).await {
                core.overlay_room(room.room_id(), TimelineOverlay::set_bridged)
                    .await;
            }
        })
        .abort_on_drop()
    }

    async fn register_timeline(
        &self,
        subscription: SubscriptionId,
        room_id: &OwnedRoomId,
        focus: &TimelineFocusView,
        timeline: &Arc<Timeline>,
        overlay: &Arc<parking_lot::Mutex<TimelineOverlay>>,
    ) -> Result<tokio::sync::MutexGuard<'_, std::collections::BTreeSet<OwnedRoomId>>, RpcError>
    {
        let live = matches!(focus, TimelineFocusView::Live);
        // The SDK replaces its explicit-room set wholesale. Register before
        // computing the union so concurrent live subscriptions see each other.
        tracing::debug!(%room_id, "subscribe_timeline: waiting for room_subscriptions");
        let mut subscribed = self.room_subscriptions.lock().await;
        tracing::debug!(%room_id, "subscribe_timeline: holding room_subscriptions");
        if live {
            self.remember_warm(room_id.clone());
        }
        self.subscriptions.lock().await.insert(
            subscription,
            Subscription {
                tasks: Vec::new(),
                timeline: Some(timeline.clone()),
                overlay: Some(overlay.clone()),
                thread_root: match focus {
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
        tracing::debug!(%room_id, "subscribe_timeline: subscriptions synced");
        Ok(subscribed)
    }

    async fn stored_bridge(&self, room: &matrix_sdk::Room) -> bool {
        for event_type in BRIDGE_EVENTS {
            let events = self
                .with_open_stores(async || {
                    room.get_state_events(StateEventType::from(event_type))
                        .await
                })
                .await;
            if events.is_ok_and(|events| !events.is_empty()) {
                return true;
            }
        }
        false
    }

    /// Sliding sync never asks for bridge state, so the store only has it when
    /// the timeline carried it.
    async fn served_bridge(&self, room: &matrix_sdk::Room) -> bool {
        match self
            .room_state_snapshot(&room.client(), room.room_id())
            .await
        {
            Ok(snapshot) => snapshot.iter().any(|raw| {
                raw.get_field::<String>("type")
                    .ok()
                    .flatten()
                    .is_some_and(|event_type| BRIDGE_EVENTS.contains(&event_type.as_str()))
            }),
            Err(error) => {
                tracing::debug!(room = %room.room_id(), %error, "bridge state unavailable");
                false
            }
        }
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

    fn new_overlay(&self) -> Arc<parking_lot::Mutex<TimelineOverlay>> {
        Arc::new(parking_lot::Mutex::new(TimelineOverlay::new(
            self.nicknames(),
        )))
    }

    pub(crate) async fn overlay_timeline_nicknames(
        &self,
        nicknames: &crate::nicknames::Nicknames,
        users: &[matrix_sdk::ruma::OwnedUserId],
    ) {
        let subscriptions = self.subscriptions.lock().await;
        for (subscription, entry) in subscriptions.iter() {
            let Some(overlay) = entry.overlay.as_ref() else {
                continue;
            };
            let diffs = overlay.lock().set_nicknames(nicknames.clone(), users);
            if !diffs.is_empty() {
                self.emit(CoreEvent::TimelineDiff {
                    subscription: *subscription,
                    diffs,
                });
            }
        }
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
            let mut overlay = overlay.lock();
            let diffs = change(&mut overlay);
            if !diffs.is_empty() {
                self.emit(CoreEvent::TimelineDiff {
                    subscription: *subscription,
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
            self.fill_reply(room_id, &replied).await;
        }
        fetched.or_failed(self, "fetch_event_details")?;
        Ok(())
    }

    async fn fill_reply(&self, room_id: &OwnedRoomId, replied: &OwnedEventId) {
        match self.event_source(room_id, replied, false).await {
            Ok((source, ..)) => {
                let stand_in = serde_json::from_str(&source)
                    .ok()
                    .and_then(|source| ReplyFallback::from_source(&source));
                if let Some(stand_in) = stand_in {
                    self.overlay_reply(room_id, replied, &stand_in).await;
                }
            }
            Err(error) => {
                tracing::debug!(?error, "replied-to event unavailable");
            }
        }
    }

    /// A replied-to event fetched from the server is outside the event cache,
    /// so the SDK never redecrypts it once its key arrives.
    pub(crate) async fn refresh_encrypted_replies(
        &self,
        room_id: Option<&RoomId>,
        keyed: impl Fn(&str) -> bool,
    ) {
        let pending: std::collections::BTreeSet<(OwnedRoomId, OwnedEventId)> = self
            .subscriptions
            .lock()
            .await
            .values()
            .filter_map(|entry| {
                let (SubscriptionKind::LiveTimeline(room)
                | SubscriptionKind::FocusedTimeline(room)) = &entry.kind
                else {
                    return None;
                };
                let overlay = entry
                    .overlay
                    .as_ref()
                    .filter(|_| room_id.is_none_or(|wanted| wanted == room))?;
                Some(
                    overlay
                        .lock()
                        .encrypted_replies(&keyed)
                        .into_iter()
                        .map(|replied| (room.clone(), replied)),
                )
            })
            .flatten()
            .collect();
        for (room, replied) in pending {
            self.fill_reply(&room, &replied).await;
        }
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
        let mut warm = self.warm_rooms.lock();
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
            .chain(self.warm_rooms.lock().iter().cloned())
            .collect::<std::collections::BTreeSet<_>>();
        drop(subscriptions);
        if room_ids == *subscribed {
            return Ok(());
        }

        let room_refs = room_ids.iter().map(OwnedRoomId::as_ref).collect::<Vec<_>>();
        tracing::debug!(rooms = room_refs.len(), "set_room_subscriptions: start");
        let service = self.sync_service().await?;
        tracing::debug!("set_room_subscriptions: sync service acquired");
        service
            .room_list_service()
            .set_room_subscriptions(&room_refs)
            .await;
        tracing::debug!("set_room_subscriptions: done");
        *subscribed = room_ids;
        Ok(())
    }
}

async fn snapshot_items(
    room: &matrix_sdk::Room,
    timeline: &Arc<Timeline>,
    items: &matrix_sdk_ui::eyeball_im::Vector<Arc<TimelineItem>>,
    user_id: Option<&UserId>,
    content: &view::LocalContent,
) -> Vec<TimelineItemView> {
    let push = room.push_context().await.ok().flatten();
    let highlights = view::Highlights::compute(push.as_ref(), items.iter()).await;
    items
        .iter()
        .map(|item| {
            abort_rejected_redaction(timeline, item);
            view::timeline_item(item, user_id, &highlights, content)
        })
        .collect()
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
