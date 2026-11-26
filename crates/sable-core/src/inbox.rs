use sable_model::text::visible_name;

use crate::api::notifications::InboxFilter;
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::Ordering;

use crate::tasks::JoinHandleExt;
use matrix_sdk::Room;
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::executor::spawn;
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::events::receipt::{ReceiptThread, ReceiptType};
use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, AnySyncTimelineEvent};
use matrix_sdk::ruma::push::Action;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, OwnedUserId, RoomId, UInt};
use matrix_sdk_common::serde_helpers::extract_thread_root;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::Core;
use crate::SignedIn;
use crate::notifications;
use crate::preview;
use crate::protocol::{CoreEvent, InboxItemView, PreviewEmote, RpcCode, RpcError};
use crate::push_rules;
use crate::session::Session;

const SCHEMA: u32 = 1;
const KEY: &[u8] = b"sable.inbox.notifications";
const MAX_ENTRIES: usize = 5_000;
const PREVIEW_LIMIT: usize = 120;
const PAGE_SIZE: u16 = 50;
const MAX_PAGES: usize = 5;
const INBOX_FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "persisted flags of one stored entry"
)]
pub(crate) struct Entry {
    room_id: OwnedRoomId,
    event_id: OwnedEventId,
    ts: u64,
    sender: OwnedUserId,
    sender_name: Option<String>,
    body: Option<String>,
    #[serde(default)]
    emotes: Vec<PreviewEmote>,
    highlight: bool,
    is_direct: bool,
    encrypted: bool,
    #[serde(default)]
    undecryptable: bool,
    #[serde(default)]
    thread_root: Option<OwnedEventId>,
    #[serde(default)]
    reply: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Stored {
    version: u32,
    entries: Vec<Entry>,
    cursors: BTreeMap<OwnedRoomId, Option<String>>,
    #[serde(default)]
    unread_scans: BTreeMap<OwnedRoomId, UnreadScan>,
}

#[derive(Clone, Serialize, Deserialize)]
struct UnreadScan {
    receipt_ts: u64,
    notified: u64,
    head: Option<OwnedEventId>,
    from: Option<String>,
    found: u64,
    complete: bool,
}

impl UnreadScan {
    fn for_room(
        previous: Option<&Self>,
        receipt_ts: u64,
        notified: u64,
        head: Option<OwnedEventId>,
    ) -> Self {
        previous
            .filter(|scan| {
                scan.receipt_ts == receipt_ts && scan.notified == notified && scan.head == head
            })
            .cloned()
            .unwrap_or(Self {
                receipt_ts,
                notified,
                head,
                from: None,
                found: 0,
                complete: false,
            })
    }
}

fn merge(entries: &mut Vec<Entry>, fresh: Vec<Entry>) -> usize {
    let mut known: HashMap<OwnedEventId, usize> = entries
        .iter()
        .enumerate()
        .map(|(at, entry)| (entry.event_id.clone(), at))
        .collect();
    let mut changed = 0;
    for entry in fresh {
        let at = known.get(&entry.event_id).copied();
        if let Some(stored) = at.and_then(|at| entries.get_mut(at)) {
            if stored.undecryptable && !entry.undecryptable {
                *stored = entry;
                changed += 1;
            }
        } else {
            known.insert(entry.event_id.clone(), entries.len());
            entries.push(entry);
            changed += 1;
        }
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.ts));
    entries.truncate(MAX_ENTRIES);
    changed
}

pub(crate) fn preview(body: String) -> String {
    if body.chars().count() <= PREVIEW_LIMIT {
        body
    } else {
        format!("{}…", body.chars().take(PREVIEW_LIMIT).collect::<String>())
    }
}

struct RoomReadState {
    receipt_ts: u64,
    remaining: u64,
}

const fn is_unread(entry: &Entry, state: &mut RoomReadState) -> bool {
    if entry.ts <= state.receipt_ts || state.remaining == 0 {
        return false;
    }
    state.remaining -= 1;
    true
}

/// Narrows the inbox to one room and to entries whose sender or shown text contains `query`.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct InboxScope<'a> {
    pub(crate) room_id: Option<&'a RoomId>,
    pub(crate) query: Option<&'a str>,
}

fn contains_query(entry: &Entry, query: &str, body_shown: bool) -> bool {
    let contains = |text: &str| text.to_lowercase().contains(query);
    contains(entry.sender.as_str())
        || entry.sender_name.as_deref().is_some_and(contains)
        || (body_shown && entry.body.as_deref().is_some_and(contains))
}

/// A thread message's `m.in_reply_to` is only a fallback for clients without threads.
fn is_reply(raw: &Raw<AnySyncTimelineEvent>) -> bool {
    let Ok(Some(relation)) = raw
        .get_field::<serde_json::Value>("content")
        .map(|content| content.and_then(|content| content.get("m.relates_to").cloned()))
    else {
        return false;
    };
    relation.pointer("/m.in_reply_to/event_id").is_some()
        && relation.get("is_falling_back") != Some(&serde_json::Value::Bool(true))
}

const fn matches(entry: &Entry, filter: InboxFilter) -> bool {
    match filter {
        InboxFilter::All => true,
        InboxFilter::Mentions => entry.highlight,
        InboxFilter::Direct => entry.is_direct,
        InboxFilter::Threads => entry.thread_root.is_some(),
    }
}

#[derive(Default)]
pub(crate) struct Inbox {
    cache: tokio::sync::Mutex<InboxCache>,
    /// The revision last written. Held while writing, so saves land in revision order.
    saved: tokio::sync::Mutex<u64>,
    changed: tokio::sync::Notify,
}

#[derive(Default)]
struct InboxCache {
    stored: Option<Stored>,
    revision: u64,
}

impl InboxCache {
    fn stored(&mut self) -> &mut Stored {
        self.stored.get_or_insert_default()
    }
}

impl Inbox {
    async fn save(&self, write: impl AsyncFnOnce(Vec<u8>) -> Result<(), RpcError>) {
        let mut saved = self.saved.lock().await;
        let (revision, bytes) = {
            let mut cache = self.cache.lock().await;
            if cache.revision == *saved {
                return;
            }
            let Some(stored) = cache.stored.as_mut() else {
                return;
            };
            let Ok(bytes) = encode(stored) else {
                return;
            };
            (cache.revision, bytes)
        };
        if write(bytes).await.is_ok() {
            *saved = (*saved).max(revision);
        } else {
            self.changed.notify_one();
        }
    }
}

async fn load(client: &matrix_sdk::Client) -> Result<Stored, RpcError> {
    let bytes = match client.state_store().get_custom_value(KEY).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(Stored::default()),
        Err(error) => {
            warn!("reading the inbox store failed: {error}");
            return Err(RpcCode::Unavailable.into());
        }
    };
    match serde_json::from_slice::<Stored>(&bytes) {
        Ok(stored) if stored.version == SCHEMA => Ok(stored),
        Ok(_) => Ok(Stored::default()),
        Err(error) => {
            warn!("discarding an inbox store that did not parse: {error}");
            Ok(Stored::default())
        }
    }
}

fn encode(stored: &mut Stored) -> Result<Vec<u8>, RpcError> {
    stored.version = SCHEMA;
    serde_json::to_vec(stored).map_err(|error| {
        warn!("serialising the inbox store failed: {error}");
        crate::errors::coded("inbox_encode", RpcCode::Unavailable, &error)
    })
}

async fn write(client: &matrix_sdk::Client, bytes: Vec<u8>) -> Result<(), RpcError> {
    if let Err(error) = client
        .state_store()
        .set_custom_value_no_read(KEY, bytes)
        .await
    {
        warn!("persisting the inbox store failed: {error}");
        return Err(RpcCode::Unavailable.into());
    }
    Ok(())
}

struct StoredReceipts {
    events: BTreeMap<OwnedEventId, Option<u64>>,
    cached_ts: Option<u64>,
}

async fn stored_receipts(room: &Room) -> matrix_sdk::Result<StoredReceipts> {
    let user_id = room.own_user_id();
    let mut receipts = BTreeMap::new();
    for receipt_type in [ReceiptType::Read, ReceiptType::ReadPrivate] {
        for thread in [ReceiptThread::Unthreaded, ReceiptThread::Main] {
            if let Some((event_id, receipt)) = room
                .load_user_receipt(receipt_type.clone(), &thread, user_id)
                .await?
            {
                let ts = receipt.ts.map(|ts| u64::from(ts.get()));
                receipts
                    .entry(event_id)
                    .and_modify(|known: &mut Option<u64>| *known = (*known).max(ts))
                    .or_insert(ts);
            }
        }
    }
    if receipts.is_empty() {
        return Ok(StoredReceipts {
            events: receipts,
            cached_ts: Some(0),
        });
    }
    let targets: std::collections::BTreeSet<OwnedEventId> = receipts.keys().cloned().collect();
    let key = format!("sable.inbox.receipt.{}", room.room_id());
    let client = room.client();
    if let Some(bytes) = client
        .state_store()
        .get_custom_value(key.as_bytes())
        .await?
        && let Ok((known, ts)) =
            serde_json::from_slice::<(std::collections::BTreeSet<OwnedEventId>, u64)>(&bytes)
        && known == targets
    {
        return Ok(StoredReceipts {
            events: receipts,
            cached_ts: Some(ts),
        });
    }
    Ok(StoredReceipts {
        events: receipts,
        cached_ts: None,
    })
}

pub(crate) async fn receipt_ts(room: &Room) -> matrix_sdk::Result<u64> {
    resolve_receipt_ts(room, stored_receipts(room).await?).await
}

/// The thread's own receipts, which the room's main receipt does not cover.
async fn thread_receipt_ts(room: &Room, thread_root: &OwnedEventId) -> u64 {
    let thread = ReceiptThread::Thread(thread_root.clone());
    let mut latest = 0;
    for receipt_type in [ReceiptType::Read, ReceiptType::ReadPrivate] {
        let Ok(Some((event_id, _))) = room
            .load_user_receipt(receipt_type, &thread, room.own_user_id())
            .await
        else {
            continue;
        };
        if let Ok(event) = room.load_or_fetch_event(&event_id, None).await {
            latest = latest.max(event_ts(&event).unwrap_or(0));
        }
    }
    latest
}

/// The later of the thread's receipt and the room's, which `read_state` skips for a room
/// without notifications.
async fn thread_read_ts(
    core: &Core,
    room: &Room,
    thread_root: &OwnedEventId,
    room_receipts: &mut HashMap<OwnedRoomId, u64>,
) -> Result<u64, RpcError> {
    let thread = core
        .with_open_stores(async || thread_receipt_ts(room, thread_root).await)
        .await;
    Ok(thread.max(cached_room_receipt_ts(core, room, room_receipts).await?))
}

/// Continuwuity zeroes the counts on any receipt, so a mention after the receipt stays unread.
async fn main_unread(
    core: &Core,
    client: &matrix_sdk::Client,
    entry: &Entry,
    read: &mut RoomReadState,
    room_receipts: &mut HashMap<OwnedRoomId, u64>,
) -> Result<bool, RpcError> {
    let counted = is_unread(entry, read);
    let Some(room) = client.get_room(&entry.room_id).filter(|_| entry.highlight) else {
        return Ok(counted);
    };
    let receipt_ts = cached_room_receipt_ts(core, &room, room_receipts).await?;
    Ok(if receipt_ts == 0 {
        counted
    } else {
        entry.ts > receipt_ts
    })
}

async fn cached_room_receipt_ts(
    core: &Core,
    room: &Room,
    room_receipts: &mut HashMap<OwnedRoomId, u64>,
) -> Result<u64, RpcError> {
    if let Some(ts) = room_receipts.get(room.room_id()) {
        return Ok(*ts);
    }
    let ts = room_receipt_ts(core, room).await?;
    room_receipts.insert(room.room_id().to_owned(), ts);
    Ok(ts)
}

async fn resolve_receipt_ts(room: &Room, stored: StoredReceipts) -> matrix_sdk::Result<u64> {
    if let Some(ts) = stored.cached_ts {
        return Ok(ts);
    }
    let targets: std::collections::BTreeSet<OwnedEventId> = stored.events.keys().cloned().collect();
    let key = format!("sable.inbox.receipt.{}", room.room_id());
    let client = room.client();
    let store = client.state_store();
    let mut latest = 0;
    let mut resolved = true;
    for (event_id, receipt_ts) in &stored.events {
        match room.load_or_fetch_event(event_id, None).await {
            Ok(event) => latest = latest.max(event_ts(&event).unwrap_or(0)),
            Err(error) => {
                warn!(room_id = %room.room_id(), %event_id, "read receipt event unavailable: {error}");
                resolved = false;
                latest = latest.max(receipt_ts.unwrap_or(0));
            }
        }
    }
    if resolved {
        let bytes = serde_json::to_vec(&(targets, latest))?;
        store
            .set_custom_value_no_read(key.as_bytes(), bytes)
            .await?;
    }
    Ok(latest)
}

async fn is_dm(room: &Room) -> bool {
    !room.is_space()
        && (room.is_direct().await.unwrap_or(false) || room.joined_members_count() == 2)
}

async fn dm_notifies(room: &Room) -> bool {
    is_dm(room).await
        && room
            .client()
            .account()
            .push_rules()
            .await
            .is_ok_and(|rules| push_rules::dm_notifies(&rules, room.room_id()))
}

async fn notified(room: &Room) -> u64 {
    let counted = room
        .unread_notification_counts()
        .notification_count
        .max(room.unread_notification_counts().highlight_count)
        .max(room.num_unread_notifications())
        .max(room.num_unread_mentions());
    let messages = room.num_unread_messages();
    if messages > counted && dm_notifies(room).await {
        messages
    } else {
        counted
    }
}

const fn is_dm_message(event: &AnySyncTimelineEvent) -> bool {
    matches!(
        event,
        AnySyncTimelineEvent::MessageLike(
            AnySyncMessageLikeEvent::RoomMessage(_) | AnySyncMessageLikeEvent::Sticker(_)
        )
    )
}

async fn read_state(core: &Core, room: &Room) -> Result<RoomReadState, RpcError> {
    let remaining = core.with_open_stores(async || notified(room).await).await;
    if remaining == 0 {
        return Ok(RoomReadState {
            receipt_ts: 0,
            remaining,
        });
    }
    Ok(RoomReadState {
        receipt_ts: room_receipt_ts(core, room).await?,
        remaining,
    })
}

async fn room_receipt_ts(core: &Core, room: &Room) -> Result<u64, RpcError> {
    let receipt_ts = async {
        let stored = core
            .with_open_stores(async || stored_receipts(room).await)
            .await?;
        resolve_receipt_ts(room, stored).await
    }
    .await;
    Ok(receipt_ts.map_err(|error| {
        warn!("resolving the inbox read receipt failed: {error}");
        RpcCode::Unavailable
    })?)
}

async fn backfill_candidates(
    core: &Core,
    client: &matrix_sdk::Client,
    stored: &Stored,
    include_read: bool,
    room_id: Option<&RoomId>,
) -> Result<Vec<(Room, UnreadScan)>, RpcError> {
    let mut candidates = Vec::new();
    for room in client.joined_rooms() {
        if room.is_space() || room_id.is_some_and(|room_id| room.room_id() != room_id) {
            continue;
        }
        if include_read {
            let cursor = stored.cursors.get(room.room_id()).cloned();
            if matches!(cursor, Some(None)) {
                continue;
            }
            candidates.push((
                room,
                UnreadScan {
                    receipt_ts: 0,
                    notified: u64::MAX,
                    head: None,
                    from: cursor.flatten(),
                    found: 0,
                    complete: false,
                },
            ));
            continue;
        }
        if core.with_open_stores(async || notified(&room).await).await == 0 {
            continue;
        }
        let read = read_state(core, &room).await?;
        let scan = UnreadScan::for_room(
            stored.unread_scans.get(room.room_id()),
            read.receipt_ts,
            read.remaining,
            room.latest_event().event_id(),
        );
        if !scan.complete {
            candidates.push((room, scan));
        }
    }
    candidates.sort_by_key(|(room, _)| {
        (
            std::cmp::Reverse(room.unread_notification_counts().highlight_count),
            std::cmp::Reverse(room.recency_stamp()),
        )
    });
    Ok(candidates)
}

impl Core {
    fn shows_inbox_body(&self, encrypted: bool) -> bool {
        self.settings.notification_content.load(Ordering::Relaxed)
            && (!encrypted
                || self
                    .settings
                    .notification_encrypted_content
                    .load(Ordering::Relaxed))
    }

    fn inbox_body(&self, event: &AnySyncTimelineEvent, encrypted: bool) -> Option<String> {
        if !self.shows_inbox_body(encrypted) {
            return None;
        }
        if matches!(
            event,
            AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomEncrypted(_))
        ) {
            return None;
        }
        Some(preview(preview::describe(event)))
    }

    async fn inbox_entry(
        &self,
        room: &Room,
        raw: &Raw<AnySyncTimelineEvent>,
        actions: &[Action],
    ) -> Option<Entry> {
        if crate::calls::is_call_event_type(raw) || crate::calls::is_call_membership_event_type(raw)
        {
            return None;
        }
        let event = raw.deserialize().ok()?;
        if !(notifications::notifies(actions) || is_dm_message(&event) && dm_notifies(room).await) {
            return None;
        }
        if event.sender() == room.own_user_id() {
            return None;
        }
        let sender_name = room
            .get_member_no_sync(event.sender())
            .await
            .ok()
            .flatten()
            .and_then(|member| {
                member
                    .display_name()
                    .and_then(visible_name)
                    .map(ToOwned::to_owned)
            });
        let encrypted = crate::rooms::room_maybe_encrypted(room);
        let body = self.inbox_body(&event, encrypted);
        let emotes = if body.is_some() {
            preview::emotes(&event)
        } else {
            Vec::new()
        };
        Some(Entry {
            room_id: room.room_id().to_owned(),
            event_id: event.event_id().to_owned(),
            ts: u64::from(event.origin_server_ts().get()),
            sender: event.sender().to_owned(),
            sender_name,
            body,
            emotes,
            highlight: actions.iter().any(Action::is_highlight),
            is_direct: is_dm(room).await,
            encrypted,
            undecryptable: notifications::raw_is_encrypted(raw),
            thread_root: extract_thread_root(raw),
            reply: is_reply(raw),
        })
    }
}

fn event_ts(event: &TimelineEvent) -> Option<u64> {
    event.timestamp().map(|ts| u64::from(ts.get()))
}

impl Core {
    /// For lifecycle jobs: closed stores reopen only in a later job, so waiting for them here would
    /// wait forever. The changes stay unsaved until the next flush.
    pub(crate) async fn flush_inbox_if_open(&self, session: &Session) {
        if *self.activity.subscribe_stores().borrow() {
            session
                .state
                .inbox
                .save(async |bytes| write(&session.client, bytes).await)
                .await;
        }
    }
}

impl SignedIn {
    pub(crate) fn watch_inbox_persist(&self) {
        let session = self.clone();
        self.track_session_task(
            spawn(async move {
                loop {
                    session.state().inbox.changed.notified().await;
                    matrix_sdk::sleep::sleep(INBOX_FLUSH_INTERVAL).await;
                    session.flush_inbox().await;
                }
            })
            .abort_on_drop(),
        );
    }

    async fn record_inbox(
        &self,
        fresh: Vec<Entry>,
        cursors: BTreeMap<OwnedRoomId, Option<String>>,
        unread_scans: BTreeMap<OwnedRoomId, UnreadScan>,
    ) -> Result<usize, RpcError> {
        if fresh.is_empty() && cursors.is_empty() && unread_scans.is_empty() {
            return Ok(0);
        }
        let mut inbox = self.loaded_inbox().await?;
        let stored = inbox.stored();
        let added = merge(&mut stored.entries, fresh);
        stored.cursors.extend(cursors);
        stored.unread_scans.extend(unread_scans);
        inbox.revision += 1;
        self.state().inbox.changed.notify_one();
        Ok(added)
    }

    async fn stored_inbox(&self) -> Result<Stored, RpcError> {
        Ok(self.loaded_inbox().await?.stored().clone())
    }

    /// Suspension flushes the inbox before it closes the stores, so the store read must not hold
    /// the inbox while it waits for them.
    async fn loaded_inbox(&self) -> Result<tokio::sync::MutexGuard<'_, InboxCache>, RpcError> {
        let cache = &self.state().inbox.cache;
        {
            let inbox = cache.lock().await;
            if inbox.stored.is_some() {
                return Ok(inbox);
            }
        }
        let loaded = self
            .core()
            .with_open_stores(async || load(self.client()).await)
            .await?;
        let mut inbox = cache.lock().await;
        inbox.stored.get_or_insert(loaded);
        Ok(inbox)
    }

    pub(crate) async fn flush_inbox(&self) {
        self.state()
            .inbox
            .save(async |bytes| {
                self.core()
                    .with_open_stores(async || write(self.client(), bytes).await)
                    .await
            })
            .await;
    }

    pub(crate) async fn record_live_inbox(
        &self,
        room: &Room,
        raw: &Raw<AnySyncTimelineEvent>,
        actions: &[Action],
        generation: u64,
    ) {
        let Some(entry) = self.core().inbox_entry(room, raw, actions).await else {
            return;
        };
        match self
            .record_inbox(vec![entry], BTreeMap::new(), BTreeMap::new())
            .await
        {
            Ok(changed) if changed > 0 => {
                self.core()
                    .emit_if_current(generation, CoreEvent::InboxChanged);
            }
            Err(error) => warn!(?error, "recording an inbox notification failed"),
            _ => {}
        }
    }

    pub(crate) async fn refresh_undecryptable_inbox_entry(
        &self,
        room: &Room,
        event: &TimelineEvent,
        actions: &[Action],
        generation: u64,
    ) {
        let Some(event_id) = event.event_id() else {
            return;
        };
        let undecryptable = {
            self.loaded_inbox().await.is_ok_and(|mut inbox| {
                inbox
                    .stored()
                    .entries
                    .iter()
                    .any(|entry| entry.event_id == event_id && entry.undecryptable)
            })
        };
        if !undecryptable {
            return;
        }
        self.record_live_inbox(room, event.raw(), actions, generation)
            .await;
    }

    pub(crate) async fn inbox_notifications(
        &self,
        filter: InboxFilter,
        include_read: bool,
        limit: u32,
        before_ts: Option<u64>,
        scope: InboxScope<'_>,
    ) -> Result<(Vec<InboxItemView>, bool), RpcError> {
        let client = self.client();
        let stored = self.stored_inbox().await?;
        let mut rooms: HashMap<OwnedRoomId, Option<(bool, RoomReadState)>> = HashMap::new();
        let mut threads: HashMap<OwnedEventId, u64> = HashMap::new();
        let mut room_receipts: HashMap<OwnedRoomId, u64> = HashMap::new();
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        let mut items = Vec::new();
        let mut has_more = false;

        let query = scope
            .query
            .map(str::to_lowercase)
            .filter(|query| !query.is_empty());

        for mut entry in stored.entries {
            if scope
                .room_id
                .is_some_and(|room_id| entry.room_id != room_id)
            {
                continue;
            }
            if let Some(query) = &query
                && !contains_query(&entry, query, self.core().shows_inbox_body(entry.encrypted))
            {
                continue;
            }
            if !rooms.contains_key(&entry.room_id) {
                let joined = client
                    .get_room(&entry.room_id)
                    .filter(|room| room.state() == matrix_sdk::RoomState::Joined);
                let state = match joined {
                    Some(room) => {
                        let read = read_state(self.core(), &room).await?;
                        Some((
                            self.core()
                                .with_open_stores(async || is_dm(&room).await)
                                .await,
                            read,
                        ))
                    }
                    None => None,
                };
                rooms.insert(entry.room_id.clone(), state);
            }
            let Some(Some((direct, read))) = rooms.get_mut(&entry.room_id) else {
                continue;
            };
            entry.is_direct = *direct;
            let unread = match &entry.thread_root {
                Some(thread_root) => {
                    let thread_read_ts = if let Some(ts) = threads.get(thread_root) {
                        *ts
                    } else {
                        let ts = match client.get_room(&entry.room_id) {
                            Some(room) => {
                                thread_read_ts(self.core(), &room, thread_root, &mut room_receipts)
                                    .await?
                            }
                            None => 0,
                        };
                        threads.insert(thread_root.clone(), ts);
                        ts
                    };
                    entry.ts > thread_read_ts
                }
                None => main_unread(self.core(), client, &entry, read, &mut room_receipts).await?,
            };
            if !matches(&entry, filter)
                || (!unread && !include_read)
                || before_ts.is_some_and(|before| entry.ts >= before)
            {
                continue;
            }
            if items.len() == limit {
                has_more = true;
                break;
            }
            let shows_body = self.core().shows_inbox_body(entry.encrypted);
            items.push(InboxItemView {
                room_id: entry.room_id.to_string(),
                event_id: entry.event_id.to_string(),
                ts: entry.ts,
                sender: entry.sender.to_string(),
                sender_name: entry.sender_name.and_then(visible_name),
                body: entry.body.filter(|_| shows_body),
                emotes: if shows_body { entry.emotes } else { Vec::new() },
                highlight: entry.highlight,
                is_direct: entry.is_direct,
                encrypted: entry.encrypted,
                read: !unread,
                thread_root: entry.thread_root.as_ref().map(ToString::to_string),
                reply: entry.reply,
            });
        }

        Ok((items, has_more))
    }

    pub(crate) async fn backfill_inbox(
        &self,
        include_read: bool,
        room_id: Option<&RoomId>,
    ) -> Result<(u32, bool), RpcError> {
        let client = self.client();
        let stored = self.stored_inbox().await?;
        let every_encrypted = self.every_encrypted_event_pushed().await;
        let candidates =
            backfill_candidates(self.core(), client, &stored, include_read, room_id).await?;
        drop(stored);

        let mut fresh = Vec::new();
        let mut cursors = BTreeMap::new();
        let mut unread_scans = BTreeMap::new();
        let mut pages = 0;
        let mut has_more = false;
        let mut failure = None;

        'rooms: for (room, mut scan) in candidates {
            if let Err(error) = crate::rooms::fill_own_member(&room).await {
                warn!(room_id = %room.room_id(), "inbox memberships failed: {error}");
                failure = Some(self.core().failed_with("inbox_memberships", &error));
                continue;
            }
            loop {
                if pages == MAX_PAGES {
                    has_more = true;
                    break 'rooms;
                }
                pages += 1;
                let mut options = MessagesOptions::backward().from(scan.from.as_deref());
                options.limit = UInt::from(PAGE_SIZE);
                let messages = match room.messages(options).await {
                    Ok(messages) => messages,
                    Err(error) => {
                        warn!(room_id = %room.room_id(), "inbox backfill failed: {error}");
                        failure = Some(self.core().failed_with("inbox_backfill", &error));
                        continue 'rooms;
                    }
                };
                let mut reached_read = false;
                for event in &messages.chunk {
                    if event_ts(event).is_some_and(|ts| ts <= scan.receipt_ts) && !include_read {
                        reached_read = true;
                        break;
                    }
                    if every_encrypted && notifications::raw_is_encrypted(event.raw()) {
                        continue;
                    }
                    let actions = push_rules::related_actions(
                        &room,
                        event.raw(),
                        event.push_actions().unwrap_or_default().to_vec(),
                    )
                    .await;
                    if let Some(entry) = self.core().inbox_entry(&room, event.raw(), &actions).await
                    {
                        fresh.push(entry);
                        scan.found = scan.found.saturating_add(1);
                    }
                }
                let exhausted = messages.end.is_none() || messages.chunk.is_empty();
                if !exhausted && messages.end == scan.from {
                    failure = Some(RpcCode::Unavailable.into());
                    continue 'rooms;
                }
                scan.from = messages.end.clone();
                scan.complete = exhausted || reached_read || scan.found >= scan.notified;
                if include_read {
                    cursors.insert(
                        room.room_id().to_owned(),
                        (!exhausted).then(|| messages.end.clone()).flatten(),
                    );
                } else {
                    unread_scans.insert(room.room_id().to_owned(), scan.clone());
                }
                if scan.complete {
                    break;
                }
            }
        }

        let added = self.record_inbox(fresh, cursors, unread_scans).await?;
        if added > 0 {
            self.core().emit(CoreEvent::InboxChanged);
        }
        if added > 0 || failure.is_some() {
            tracing::info!(
                added,
                pages,
                has_more,
                failed = failure.is_some(),
                "inbox backfill finished"
            );
        } else {
            tracing::debug!(pages, has_more, "inbox backfill found nothing new");
        }
        if let Some(error) = failure {
            return Err(error);
        }
        Ok((u32::try_from(added).unwrap_or(u32::MAX), has_more))
    }
}

#[cfg(test)]
#[path = "inbox_tests.rs"]
mod tests;
