use crate::api::timeline::SubscribeParams;
use crate::api::timeline::TimelineFocusView;
use crate::api::timeline::WarmRoomsParams;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use crate::tasks::JoinHandleExt;
use futures_util::future::{self, Either};
use futures_util::{Stream, StreamExt, pin_mut};
use matrix_sdk::event_cache::{PaginationStatus, RoomEventCacheUpdate};
use matrix_sdk::executor::spawn;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::push::Ruleset;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId, OwnedUserId, RoomId, UserId};
use matrix_sdk::send_queue::RoomSendQueueUpdate;
use matrix_sdk_base::event_cache::Event;
use matrix_sdk_base::sticky::StickyEventsUpdate;
use matrix_sdk_ui::eyeball_im::VectorDiff;
use matrix_sdk_ui::room_list_service::RoomListItem;
use matrix_sdk_ui::room_list_service::filters::new_filter_non_left;
use matrix_sdk_ui::timeline::{
    Error as TimelineError, EventSendState, EventTimelineItem, SendTarget, Timeline, TimelineItem,
};
use tokio::sync::broadcast::error::{RecvError, TryRecvError};
use tokio::sync::{broadcast, mpsc, watch};
use tokio_stream::{StreamMap, wrappers::BroadcastStream};
use web_time::Instant;

use crate::ResultExt;
use crate::api::timeline::{SubscribeOk, SubscribeRoomListOk};
use crate::notifications;
use crate::protocol::{
    CoreEvent, RoomListItemView, RoomListOptionsView, RpcCode, RpcError, SubscriptionId,
    TimelineItemView,
};
use crate::push_rules::PushRules;
use crate::room_list_batch::DiffBatch;
use crate::room_list_rows::{DmSpaceLinks, RoomListRows};
use crate::room_sections::RoomSections;
use crate::space_parents::{ParentResult, ParentTracker};
use crate::timeline_overlay::{BanRedaction, ReplyFallback, TimelineOverlay};
use crate::timelines::{
    AggregationScope, aggregation_items, build_room_timeline, fill_sender_profiles,
};
use crate::view;
use crate::{Core, SignedIn, Subscription, SubscriptionKind, Task};

const BRIDGE_EVENTS: [&str; 2] = ["m.bridge", "uk.half-shot.bridge"];

enum Wake {
    Diffs(Option<Vec<VectorDiff<Arc<TimelineItem>>>>),
    Queue(Result<RoomSendQueueUpdate, RecvError>),
}

async fn next_queue_update(
    updates: &mut Option<broadcast::Receiver<RoomSendQueueUpdate>>,
) -> Result<RoomSendQueueUpdate, RecvError> {
    let Some(receiver) = updates.as_mut() else {
        return future::pending().await;
    };
    receiver.recv().await
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
    voice_updates: StreamMap<OwnedRoomId, BroadcastStream<StickyEventsUpdate>>,
    rows: RoomListRows,
    sections: RoomSections,
    options: watch::Receiver<RoomListOptionsView>,
    dm_spaces: DmSpaceLinks,
    parents: ParentTracker,
    dm_spaces_changed: watch::Receiver<()>,
    nicknames: watch::Receiver<crate::nicknames::Nicknames>,
    core: SignedIn,
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
            move |raw: ruma::serde::Raw<ruma::events::AnySyncStateEvent>,
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

    fn watch_row_account_data(
        &self,
    ) -> (
        matrix_sdk::event_handler::EventHandlerDropGuard,
        mpsc::UnboundedReceiver<OwnedRoomId>,
    ) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let handle = self.client.add_event_handler(
            move |raw: ruma::serde::Raw<ruma::events::AnyRoomAccountDataEvent>,
                  room: matrix_sdk::Room| {
                let sender = sender.clone();
                async move {
                    let event_type = raw.get_field::<String>("type").ok().flatten();
                    if event_type.as_deref().is_some_and(|event_type| {
                        event_type == crate::spaces::AVATAR_OVERRIDE_EVENT
                            || crate::account_documents::is_media_preview_event(event_type)
                    }) {
                        let _ = sender.send(room.room_id().to_owned());
                    }
                }
            },
        );
        (self.client.event_handler_drop_guard(handle), receiver)
    }

    async fn on_row_account_data(
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
        view::refresh_media_previews(&rooms, &mut self.room_cache).await;
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
        let (_account_data_handler, mut row_account_data) = self.watch_row_account_data();
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
                    let changes = std::iter::once(change)
                        .chain(std::iter::from_fn(|| state_changes.try_recv().ok()))
                        .collect();
                    self.on_parent_state_changes(changes).await;
                    self.rows.relink(&self.room_cache, &self.dm_spaces, &self.parents.links)
                }
                room_id = row_account_data.recv() => {
                    let Some(room_id) = room_id else { break; };
                    let room_ids = std::iter::once(room_id)
                        .chain(std::iter::from_fn(|| row_account_data.try_recv().ok()))
                        .collect();
                    let diffs = self.on_row_account_data(room_ids).await;
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
                Some((room_id, update)) = self.voice_updates.next(), if !self.voice_updates.is_empty() && *stores_open.borrow() => {
                    if update.is_ok_and(|update| !crate::calls::affects_voice_roster(&update)) {
                        continue;
                    }
                    self.on_voice_update(&room_id).await
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
                    let Some(diffs) = self.on_rules_changed() else {
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
        let options = self.options.borrow_and_update();
        let next = RoomSections::rebuild(self.rows.rows(), &options, &self.sections);
        #[cfg(target_os = "ios")]
        let defaults = (options.badge_default_direct, options.badge_default_group);
        drop(options);
        #[cfg(target_os = "ios")]
        if next.push_badge() != self.sections.push_badge() {
            self.save_push_badge(next.push_badge(), defaults);
        }
        let sections = self.sections.update(next);
        if diffs.is_empty() && sections.is_none() {
            return;
        }
        self.core.core().emit(CoreEvent::RoomListDiff {
            subscription: self.subscription,
            diffs,
            sections,
        });
    }

    #[cfg(target_os = "ios")]
    fn save_push_badge(
        &self,
        rooms: &std::collections::BTreeMap<String, notifications::badge::PushBadgeRoom>,
        (direct, group): (
            crate::protocol::BadgeModeView,
            crate::protocol::BadgeModeView,
        ),
    ) {
        use crate::protocol::BadgeModeView;
        let Some(user_id) = self.client.user_id() else {
            return;
        };
        let badge = notifications::badge::PushBadge {
            user_id: user_id.to_string(),
            rooms: rooms.clone(),
            direct_every: direct == BadgeModeView::All,
            group_every: group == BadgeModeView::All,
            counted: std::collections::VecDeque::new(),
        };
        let root = std::path::PathBuf::from(&self.core.core().store_id);
        tokio::task::spawn_blocking(move || {
            if let Err(error) = badge.save(&root) {
                tracing::warn!("push badge not saved: {error}");
            }
        });
    }

    async fn load_dm_spaces(&self) -> DmSpaceLinks {
        crate::account_documents::synced_dm_spaces(&self.client).await
    }

    async fn on_parent_state_changes(&mut self, changes: Vec<ParentStateChange>) {
        let mut rooms = HashSet::new();
        let mut spaces = HashSet::new();
        let mut members = HashSet::new();
        for change in changes {
            match change {
                ParentStateChange::Room(id) => {
                    rooms.insert(id);
                }
                ParentStateChange::Space(id) => {
                    spaces.insert(id);
                }
                ParentStateChange::Member(id, user) => {
                    members.insert((id, user));
                }
            }
        }
        self.refresh_changed_parents(&rooms, &spaces, &members)
            .await;
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
            .refresh(
                self.core.core(),
                &self.client,
                &listed,
                rooms,
                spaces,
                members,
            )
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
        let rooms = view::latest_items(&diffs);
        // Sticky-only joins, leaves and expirations do not produce SDK room-list diffs.
        // Subscribe before reading the roster so an update cannot fall between the two.
        for room in &rooms {
            if room.is_call() && !self.voice_updates.contains_key(room.room_id()) {
                self.voice_updates.insert(
                    room.room_id().to_owned(),
                    BroadcastStream::new(room.sticky_events().subscribe()),
                );
            }
        }
        view::enrich_rooms(rooms, &mut self.room_cache).await;
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
        let previous: HashSet<_> = self
            .rows
            .rows()
            .iter()
            .map(|row| row.room_id.clone())
            .collect();
        for diff in &diffs {
            self.rows.apply(diff);
        }
        self.rows.evict(&mut self.room_cache);
        let removed: Vec<_> = self
            .voice_updates
            .keys()
            .filter(|id| !self.room_cache.contains_key(*id))
            .cloned()
            .collect();
        for id in removed {
            self.voice_updates.remove(&id);
        }
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

    async fn on_voice_update(
        &mut self,
        room_id: &RoomId,
    ) -> Vec<crate::protocol::VectorDiff<RoomListItemView>> {
        let Some(room) = self.client.get_room(room_id) else {
            return Vec::new();
        };
        let Some(cached) = self
            .room_cache
            .get_mut(room_id)
            .and_then(|info| info.voice_roster.as_mut())
        else {
            return Vec::new();
        };
        let roster = crate::calls::voice_room_roster(&room).await;
        if roster == *cached {
            return Vec::new();
        }
        *cached = roster;
        self.rows.refresh(
            &[room.into()],
            &self.room_cache,
            &self.rules,
            &self.nicknames.borrow(),
        )
    }

    fn on_rules_changed(&mut self) -> Option<Vec<crate::protocol::VectorDiff<RoomListItemView>>> {
        self.rules = self.push_rules.snapshot();
        let client = &self.client;
        let rules = &self.rules;
        let diffs = self.rows.renotify(rules, |room_id| {
            client
                .get_room(room_id)
                .is_some_and(|room| notifications::uses_direct_push_rules(rules, &room))
        });
        (!diffs.is_empty()).then_some(diffs)
    }
}

struct TimelineWorker {
    core: SignedIn,
    subscription: SubscriptionId,
    room: matrix_sdk::Room,
    timeline: Arc<Timeline>,
    overlay: Arc<parking_lot::Mutex<TimelineOverlay>>,
    user_id: Option<OwnedUserId>,
    content: view::LocalContent,
    queue_updates: Option<broadcast::Receiver<RoomSendQueueUpdate>>,
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
                Wake::Queue(Ok(update)) => self.on_queue_update(&update).await,
                Wake::Queue(Err(RecvError::Lagged(_))) => self.resync_queue().await,
                Wake::Queue(Err(RecvError::Closed)) => self.queue_updates = None,
            }
        }
    }

    /// Updates were missed, so the local echoes are read again and the items they change are
    /// resent one by one. A `Reset` from the timeline's items would repeat the diffs its stream
    /// still holds.
    async fn resync_queue(&mut self) {
        let Ok((echoes, updates)) = self.room.send_queue().subscribe().await else {
            self.queue_updates = None;
            return;
        };
        self.queue_updates = Some(updates);
        let targets = self.content.resync(&echoes);
        self.resend(|event| {
            event.is_local_echo() || event.event_id().is_some_and(|id| targets.contains(id))
        })
        .await;
    }

    async fn on_queue_update(&mut self, update: &RoomSendQueueUpdate) {
        let Some(target) = self.content.apply(update) else {
            return;
        };
        self.resend(|event| event.event_id() == Some(&target)).await;
    }

    /// Renders the chosen events again where the host already holds them. One it does not hold
    /// yet is rendered when its own diff arrives.
    async fn resend(&self, chosen: impl Fn(&EventTimelineItem) -> bool) {
        let items = self.timeline.items().await;
        let items: Vec<_> = items
            .iter()
            .filter(|item| item.as_event().is_some_and(&chosen))
            .cloned()
            .collect();
        // Held across the awaits below, it would have to be `Send`.
        drop(chosen);
        if items.is_empty() {
            return;
        }
        let push = self.room.push_context().await.ok().flatten();
        let highlights = view::Highlights::compute(push.as_ref(), &items).await;
        let mut overlay = self.overlay.lock();
        let diffs: Vec<_> = items
            .iter()
            .filter_map(|item| {
                let value =
                    view::timeline_item(item, self.user_id.as_deref(), &highlights, &self.content);
                let index = match (&value.event_id, &value.transaction_id) {
                    (Some(event_id), _) => overlay.index_of_event(event_id),
                    (None, Some(transaction_id)) => overlay.index_of_transaction(transaction_id),
                    (None, None) => None,
                }?;
                Some(overlay.apply(crate::protocol::VectorDiff::Set { index, value }))
            })
            .flatten()
            .collect();
        if !diffs.is_empty() {
            self.core.core().emit(CoreEvent::TimelineDiff {
                subscription: self.subscription,
                diffs,
            });
        }
    }

    async fn on_diffs(&mut self, diffs: Vec<VectorDiff<Arc<TimelineItem>>>) {
        let mut lagged = false;
        if let Some(updates) = self.queue_updates.as_mut() {
            loop {
                match updates.try_recv() {
                    Ok(update) => drop(self.content.apply(&update)),
                    Err(TryRecvError::Lagged(_)) => {
                        lagged = true;
                        break;
                    }
                    Err(TryRecvError::Empty | TryRecvError::Closed) => break,
                }
            }
        }
        if lagged {
            self.resync_queue().await;
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
        self.core.core().emit(CoreEvent::TimelineDiff {
            subscription: self.subscription,
            diffs: diffs
                .into_iter()
                .flat_map(|diff| overlay.apply(diff))
                .collect(),
        });
    }
}

impl Core {
    /// Call when the page that owns the subscriptions goes away: nothing else unsubscribes for
    /// it.
    pub fn drop_open_subscriptions(self: &Arc<Self>) -> impl Future<Output = ()> + use<> {
        let dropping = self
            .signed_in()
            .ok()
            .map(|session| session.drop_open_subscriptions());
        async move {
            if let Some(dropping) = dropping {
                dropping.await;
            }
        }
    }
}

impl SignedIn {
    pub(crate) async fn subscribe_room_list(
        &self,
        options: RoomListOptionsView,
    ) -> Result<SubscribeRoomListOk, RpcError> {
        let session_state = self.state();
        self.core().room_list_options.send_replace(options);
        let sync_service = self.sync_service();

        self.core().wait_for_stores().await;
        let client = self.client().clone();
        let push_rules = self.push_rules().await?;
        let subscription = self.core().allocate_subscription();
        let core = self.clone();
        let stores_open = self.core().activity.subscribe_stores();
        let room_list = sync_service
            .room_list_service()
            .all_rooms()
            .await
            .or_failed(self.core(), "subscribe_room_list")?;
        let task = spawn(async move {
            let (stream, controller) = room_list.entries_with_dynamic_adapters(ROOM_LIST_PAGE_SIZE);
            controller.set_filter(Box::new(new_filter_non_left()));

            let rule_changes = push_rules.subscribe();
            let rules = push_rules.snapshot();
            let nicknames = core.core().nickname_changes();
            let (parent_results_tx, parent_results_rx) = mpsc::unbounded_channel();
            let worker = RoomListWorker {
                client,
                push_rules,
                rules,
                room_cache: HashMap::new(),
                voice_updates: StreamMap::new(),
                rows: RoomListRows::default(),
                sections: RoomSections::default(),
                options: core.core().room_list_options.subscribe(),
                dm_spaces: DmSpaceLinks::default(),
                parents: ParentTracker::new(parent_results_tx),
                dm_spaces_changed: core.core().dm_spaces_changed.subscribe(),
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

        let mut subscriptions = session_state.subscriptions.lock();
        if self.has_ended() {
            return Err(RpcCode::NotLoggedIn.into());
        }
        subscriptions.insert(
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
        &self,
        SubscribeParams {
            room_id,
            focus,
            hidden_events,
        }: SubscribeParams,
    ) -> Result<SubscribeOk, RpcError> {
        let core = self.core();
        core.wait_for_stores().await;
        let subscription = core.allocate_subscription();
        let room = self.room(&room_id)?;
        let timeline = self
            .open_timeline(&room, &room_id, &focus, hidden_events)
            .await?;
        fill_sender_profiles(&room, &timeline);
        let overlay = core.new_overlay();

        let _subscribed = self
            .register_timeline(subscription, &room, &focus, &timeline, &overlay)
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
        let own_user_id = self.client().user_id().map(ToOwned::to_owned);
        let items = snapshot_items(
            &room,
            &timeline,
            &items,
            own_user_id.as_deref(),
            &local_content,
        )
        .await;
        let encrypted = room.encryption_state().is_encrypted();
        let stored_bridge = encrypted && core.stored_bridge(&room).await;
        if stored_bridge {
            overlay.lock().set_bridged();
        }
        let (bans, redactors) = BanRedaction::in_room(&room).await;
        overlay.lock().seed_ban_redactions(bans, redactors);
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
            let core = Arc::clone(core);
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

        let threads_task = self.watch_threads(&room_id);
        let bridge_task = (encrypted && !stored_bridge).then(|| self.watch_bridge(&room));

        let mut subscriptions = self.state().subscriptions.lock();
        let Some(entry) = subscriptions.get_mut(&subscription) else {
            return Err(RpcCode::Unavailable.into());
        };
        entry.tasks = status_task
            .into_iter()
            .chain(aggregation_task)
            .chain(bridge_task)
            .chain(threads_task)
            .chain([task])
            .collect();
        if let Some(status) = initial_status {
            core.emit(timeline_pagination_event(subscription, status));
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
        &self,
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
                    .or_failed(self.core(), "build_focused_timeline")?,
            ),
        })
    }

    fn watch_threads(&self, room_id: &OwnedRoomId) -> Option<Task> {
        self.client().event_cache().map(|cache| {
            let mut updates = cache.subscribe_to_room_generic_updates();
            let core = self.clone();
            let room_id = room_id.clone();
            core.core().emit(CoreEvent::ThreadsChanged {
                room_id: room_id.clone(),
            });
            spawn(async move {
                loop {
                    match updates.recv().await {
                        Ok(update) if update.room_id != room_id => continue,
                        Err(RecvError::Closed) => break,
                        Ok(_) | Err(RecvError::Lagged(_)) => {}
                    }
                    core.core().emit(CoreEvent::ThreadsChanged {
                        room_id: room_id.clone(),
                    });
                }
            })
            .abort_on_drop()
        })
    }

    fn watch_bridge(&self, room: &matrix_sdk::Room) -> Task {
        let core = self.clone();
        let room = room.clone();
        spawn(async move {
            if core.served_bridge(&room).await {
                core.overlay_room(room.room_id(), TimelineOverlay::set_bridged);
            }
        })
        .abort_on_drop()
    }

    async fn register_timeline(
        &self,
        subscription: SubscriptionId,
        room: &matrix_sdk::Room,
        focus: &TimelineFocusView,
        timeline: &Arc<Timeline>,
        overlay: &Arc<parking_lot::Mutex<TimelineOverlay>>,
    ) -> Result<tokio::sync::OwnedMutexGuard<std::collections::BTreeSet<OwnedRoomId>>, RpcError>
    {
        let live = matches!(focus, TimelineFocusView::Live);
        let room_id = &room.room_id().to_owned();
        // The SDK replaces its explicit-room set wholesale. Register before
        // computing the union so concurrent live subscriptions see each other.
        tracing::debug!(%room_id, "subscribe_timeline: waiting for room_subscriptions");
        let session_state = self.state();
        let mut subscribed = session_state.room_subscriptions.clone().lock_owned().await;
        tracing::debug!(%room_id, "subscribe_timeline: holding room_subscriptions");
        if self.has_ended() {
            return Err(RpcCode::NotLoggedIn.into());
        }
        if live {
            self.remember_warm(room_id.clone());
        }
        self.state().subscriptions.lock().insert(
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
            let removed = session_state.subscriptions.lock().remove(&subscription);
            drop(removed);
            return Err(error);
        }
        tracing::debug!(%room_id, "subscribe_timeline: subscriptions synced");
        Ok(subscribed)
    }

    /// Sliding sync never asks for bridge state, so the store only has it when
    /// the timeline carried it.
    async fn served_bridge(&self, room: &matrix_sdk::Room) -> bool {
        match self.room_state_snapshot(room.room_id()).await {
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
    pub(crate) fn overlay_profile(
        &self,
        room_id: &RoomId,
        user_id: &UserId,
        name: Option<&str>,
        avatar: Option<&str>,
    ) {
        self.overlay_room(room_id, |overlay| {
            overlay.set_profile(
                user_id.to_owned(),
                name.map(str::to_owned),
                avatar.map(str::to_owned),
            )
        });
    }

    pub(crate) fn overlay_timeline_nicknames(
        &self,
        nicknames: &crate::nicknames::Nicknames,
        users: &[OwnedUserId],
    ) {
        let session_state = self.state();
        let subscriptions = session_state.subscriptions.lock();
        for (subscription, entry) in subscriptions.iter() {
            let Some(overlay) = entry.overlay.as_ref() else {
                continue;
            };
            let diffs = overlay.lock().set_nicknames(nicknames.clone(), users);
            if !diffs.is_empty() {
                self.core().emit(CoreEvent::TimelineDiff {
                    subscription: *subscription,
                    diffs,
                });
            }
        }
    }

    /// Shows why `redacted` was deleted in every open timeline of the room.
    pub(crate) fn overlay_redaction(&self, room_id: &RoomId, redacted: &EventId, reason: &str) {
        self.overlay_room(room_id, |overlay| {
            overlay.set_redaction_reason(redacted.to_owned(), reason.to_owned())
        });
    }

    /// Hides or shows again `user_id`'s messages in every open timeline of the room.
    pub(crate) fn overlay_ban_redaction(
        &self,
        room_id: &RoomId,
        user_id: &UserId,
        ban: Option<&BanRedaction>,
        redactors: Option<&ruma::events::room::power_levels::RoomPowerLevels>,
    ) {
        self.overlay_room(room_id, |overlay| {
            overlay.set_ban_redaction(user_id, ban.cloned(), redactors.cloned())
        });
    }

    /// What a ban hides of `event_id` in an open timeline of the room.
    pub(crate) fn ban_hidden_content(
        &self,
        room_id: &RoomId,
        event_id: &OwnedEventId,
    ) -> Option<crate::protocol::TimelineItemContentView> {
        let session_state = self.state();
        let subscriptions = session_state.subscriptions.lock();
        subscriptions.values().find_map(|entry| {
            let (SubscriptionKind::LiveTimeline(room) | SubscriptionKind::FocusedTimeline(room)) =
                &entry.kind
            else {
                return None;
            };
            entry
                .overlay
                .as_ref()
                .filter(|_| room == room_id)?
                .lock()
                .hidden_content(event_id)
        })
    }

    /// Fills in the replies to `replied` in every open timeline of the room.
    pub(crate) fn overlay_reply(
        &self,
        room_id: &RoomId,
        replied: &EventId,
        stand_in: &ReplyFallback,
    ) {
        self.overlay_room(room_id, |overlay| {
            overlay.set_reply(replied.to_owned(), stand_in.clone())
        });
    }

    fn overlay_room(
        &self,
        room_id: &RoomId,
        change: impl Fn(&mut TimelineOverlay) -> Vec<crate::protocol::VectorDiff<TimelineItemView>>,
    ) {
        let session_state = self.state();
        let subscriptions = session_state.subscriptions.lock();
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
                self.core().emit(CoreEvent::TimelineDiff {
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
        subscription: Option<SubscriptionId>,
    ) -> Result<(), RpcError> {
        let timeline = self
            .subscribed_timeline(room_id, thread_root, subscription)
            .await?;
        let fetched = timeline.fetch_details_for_event(event_id).await;
        if let Err(TimelineError::EventNotInTimeline(_)) = fetched {
            tracing::debug!(
                context = "fetch_event_details",
                "the event left the timeline"
            );
            return Err(RpcCode::Unavailable.into());
        }
        let unresolved = timeline
            .item_by_event_id(event_id)
            .await
            .and_then(|item| view::reply_without_body(item.content()));
        if let Some(replied) = unresolved {
            self.fill_reply(room_id, &replied).await;
        }
        fetched.or_failed(self.core(), "fetch_event_details")?;
        Ok(())
    }

    async fn fill_reply(&self, room_id: &OwnedRoomId, replied: &OwnedEventId) {
        match self.event_source(room_id, replied, false).await {
            Ok((source, ..)) => {
                let stand_in = serde_json::from_str(&source)
                    .ok()
                    .and_then(|source| ReplyFallback::from_source(&source));
                if let Some(stand_in) = stand_in {
                    self.overlay_reply(room_id, replied, &stand_in);
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
            .state()
            .subscriptions
            .lock()
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
        &self,
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
        let resync = cache.clone();
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
                    Err(RecvError::Lagged(_)) => {
                        // The missed updates are gone, so what the cache holds now is resent.
                        let Ok((cached, resubscribed)) = resync.subscribe().await else {
                            break;
                        };
                        updates = resubscribed;
                        let cached = scope.retain(cached, &lookup).await;
                        let items = aggregation_items(cached, &rules, own_user_id.as_deref());
                        if !items.is_empty() {
                            core.core().emit(CoreEvent::TimelineAggregations {
                                subscription,
                                items,
                            });
                        }
                        continue;
                    }
                    Err(RecvError::Closed) => break,
                };
                let RoomEventCacheUpdate::UpdateTimelineEvents(update) = update else {
                    continue;
                };
                let events = update.diffs.into_iter().flat_map(diff_events).collect();
                let events = scope.retain(events, &lookup).await;
                let items = aggregation_items(events, &rules, own_user_id.as_deref());
                if !items.is_empty() {
                    core.core().emit(CoreEvent::TimelineAggregations {
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
        let client = self.client();
        let session_state = self.state();
        let mut subscribed = session_state.room_subscriptions.lock().await;
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
        let session_state = self.state();
        let mut warm = session_state.warm_rooms.lock();
        warm.retain(|warmed| *warmed != room_id);
        warm.push_back(room_id);
        while warm.len() > MAX_WARM_ROOMS {
            warm.pop_front();
        }
    }

    pub(crate) fn drop_open_subscriptions(&self) -> impl Future<Output = ()> + use<> {
        let core = self.clone();
        let end = self.core().next_subscription.load(Ordering::Relaxed);
        async move {
            let session_state = core.state();
            let mut subscribed = session_state.room_subscriptions.lock().await;
            core.state()
                .subscriptions
                .lock()
                .retain(|subscription, _| subscription.0 >= end);
            if let Err(error) = core.sync_timeline_rooms_locked(&mut subscribed).await {
                tracing::debug!(?error, "room subscriptions not released");
            }
        }
    }

    /// The SDK drops its room subscriptions when the sync session expires.
    pub(crate) async fn resubscribe_timeline_rooms(&self) {
        let session_state = self.state();
        let mut subscribed = session_state.room_subscriptions.lock().await;
        subscribed.clear();
        if let Err(error) = self.sync_timeline_rooms_locked(&mut subscribed).await {
            tracing::warn!(?error, "failed to restore room subscriptions");
        }
    }

    pub(crate) async fn sync_timeline_rooms_locked(
        &self,
        subscribed: &mut std::collections::BTreeSet<OwnedRoomId>,
    ) -> Result<(), RpcError> {
        if self.has_ended() {
            return Ok(());
        }
        let session_state = self.state();
        let room_ids = {
            let subscriptions = session_state.subscriptions.lock();
            subscriptions
                .values()
                .filter_map(|subscription| match &subscription.kind {
                    SubscriptionKind::LiveTimeline(room_id)
                    | SubscriptionKind::FocusedTimeline(room_id) => Some(room_id.clone()),
                    SubscriptionKind::Other => None,
                })
                .chain(session_state.warm_rooms.lock().iter().cloned())
                .collect::<std::collections::BTreeSet<_>>()
        };
        if room_ids == *subscribed {
            return Ok(());
        }

        let room_refs = room_ids.iter().map(OwnedRoomId::as_ref).collect::<Vec<_>>();
        tracing::debug!(rooms = room_refs.len(), "set_room_subscriptions: start");
        let service = self.sync_service();
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

impl Core {
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

    fn new_overlay(&self) -> Arc<parking_lot::Mutex<TimelineOverlay>> {
        Arc::new(parking_lot::Mutex::new(TimelineOverlay::new(
            self.nicknames(),
        )))
    }
}
