use sable_model::text::visible_name;

use crate::api::notifications::InboxFilter;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use matrix_sdk::Room;
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::executor::{JoinHandleExt, spawn};
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
use crate::ResultExt;
use crate::notifications;
use crate::preview;
use crate::protocol::{CoreEvent, InboxItemView, RpcCode, RpcError};
use crate::push_rules;

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
pub(crate) struct InboxCache {
    stored: Option<Stored>,
    revision: u64,
    saved: u64,
    resets: u64,
}

impl InboxCache {
    fn stored(&mut self) -> &mut Stored {
        self.stored.get_or_insert_default()
    }

    pub(crate) fn reset(&mut self) {
        *self = Self {
            resets: self.resets + 1,
            ..Self::default()
        };
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
    if dm_notifies(room).await {
        counted.max(room.num_unread_messages())
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
    let receipt_ts = async {
        let stored = core
            .with_open_stores(async || stored_receipts(room).await)
            .await?;
        resolve_receipt_ts(room, stored).await
    }
    .await;
    Ok(RoomReadState {
        receipt_ts: receipt_ts.map_err(|error| {
            warn!("resolving the inbox read receipt failed: {error}");
            RpcCode::Unavailable
        })?,
        remaining,
    })
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
        self.notification_content.load(Ordering::Relaxed)
            && (!encrypted || self.notification_encrypted_content.load(Ordering::Relaxed))
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
        Some(Entry {
            room_id: room.room_id().to_owned(),
            event_id: event.event_id().to_owned(),
            ts: u64::from(event.origin_server_ts().get()),
            sender: event.sender().to_owned(),
            sender_name,
            body: self.inbox_body(&event, encrypted),
            highlight: actions.iter().any(Action::is_highlight),
            is_direct: is_dm(room).await,
            encrypted,
            undecryptable: notifications::raw_is_encrypted(raw),
            thread_root: extract_thread_root(raw),
            reply: is_reply(raw),
        })
    }

    async fn record_inbox(
        &self,
        client: &matrix_sdk::Client,
        fresh: Vec<Entry>,
        cursors: BTreeMap<OwnedRoomId, Option<String>>,
        unread_scans: BTreeMap<OwnedRoomId, UnreadScan>,
    ) -> Result<usize, RpcError> {
        if fresh.is_empty() && cursors.is_empty() && unread_scans.is_empty() {
            return Ok(0);
        }
        let mut inbox = self.loaded_inbox(client).await?;
        let stored = inbox.stored();
        let added = merge(&mut stored.entries, fresh);
        stored.cursors.extend(cursors);
        stored.unread_scans.extend(unread_scans);
        inbox.revision += 1;
        Ok(added)
    }

    async fn stored_inbox(&self, client: &matrix_sdk::Client) -> Result<Stored, RpcError> {
        Ok(self.loaded_inbox(client).await?.stored().clone())
    }

    /// Suspension flushes the inbox before it closes the stores, so the store read must not hold
    /// the inbox while it waits for them.
    async fn loaded_inbox(
        &self,
        client: &matrix_sdk::Client,
    ) -> Result<tokio::sync::MutexGuard<'_, InboxCache>, RpcError> {
        let resets = {
            let inbox = self.inbox.lock().await;
            if inbox.stored.is_some() {
                return Ok(inbox);
            }
            inbox.resets
        };
        let loaded = self.with_open_stores(async || load(client).await).await?;
        let mut inbox = self.inbox.lock().await;
        // The session changed during the read, so `loaded` belongs to the previous account.
        if inbox.resets != resets {
            return Err(RpcCode::Unavailable.into());
        }
        inbox.stored.get_or_insert(loaded);
        Ok(inbox)
    }

    pub(crate) async fn flush_inbox(&self, client: &matrix_sdk::Client) {
        self.save_inbox(async |bytes| {
            self.with_open_stores(async || write(client, bytes).await)
                .await
        })
        .await;
    }

    /// For a suspension, where `with_open_stores` would wait for stores it has already closed.
    pub(crate) async fn flush_inbox_locked(
        &self,
        client: &matrix_sdk::Client,
        transition: &crate::activity::Transition<'_>,
    ) {
        if transition.stores_open() {
            self.save_inbox(async |bytes| write(client, bytes).await)
                .await;
        }
    }

    async fn save_inbox(&self, write: impl AsyncFnOnce(Vec<u8>) -> Result<(), RpcError>) {
        let _writing = self.inbox_flush.lock().await;
        let (revision, bytes) = {
            let mut inbox = self.inbox.lock().await;
            if inbox.revision == inbox.saved {
                return;
            }
            let Some(stored) = inbox.stored.as_mut() else {
                return;
            };
            let Ok(bytes) = encode(stored) else {
                return;
            };
            (inbox.revision, bytes)
        };
        if write(bytes).await.is_ok() {
            let mut inbox = self.inbox.lock().await;
            inbox.saved = inbox.saved.max(revision);
        }
    }

    pub(crate) fn watch_inbox_persist(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let core = self.clone();
        let client = client.clone();
        self.track_session_task(
            spawn(async move {
                loop {
                    matrix_sdk::sleep::sleep(INBOX_FLUSH_INTERVAL).await;
                    core.flush_inbox(&client).await;
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn record_live_inbox(
        &self,
        room: &Room,
        raw: &Raw<AnySyncTimelineEvent>,
        actions: &[Action],
        generation: u64,
    ) {
        let Some(entry) = self.inbox_entry(room, raw, actions).await else {
            return;
        };
        match self
            .record_inbox(
                &room.client(),
                vec![entry],
                BTreeMap::new(),
                BTreeMap::new(),
            )
            .await
        {
            Ok(changed) if changed > 0 => {
                self.emit_if_current(generation, CoreEvent::InboxChanged);
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
        let client = room.client();
        let undecryptable = {
            self.loaded_inbox(&client).await.is_ok_and(|mut inbox| {
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
        let client = self.client().await?;
        let stored = self.stored_inbox(&client).await?;
        let mut rooms: HashMap<OwnedRoomId, Option<(bool, RoomReadState)>> = HashMap::new();
        let mut threads: HashMap<OwnedEventId, u64> = HashMap::new();
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
                && !contains_query(&entry, query, self.shows_inbox_body(entry.encrypted))
            {
                continue;
            }
            if !rooms.contains_key(&entry.room_id) {
                let joined = client
                    .get_room(&entry.room_id)
                    .filter(|room| room.state() == matrix_sdk::RoomState::Joined);
                let state = match joined {
                    Some(room) => {
                        let read = read_state(self, &room).await?;
                        Some((
                            self.with_open_stores(async || is_dm(&room).await).await,
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
                                self.with_open_stores(async || {
                                    thread_receipt_ts(&room, thread_root).await
                                })
                                .await
                            }
                            None => 0,
                        };
                        threads.insert(thread_root.clone(), ts);
                        ts
                    };
                    entry.ts > read.receipt_ts.max(thread_read_ts)
                }
                None => is_unread(&entry, read),
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
            items.push(InboxItemView {
                room_id: entry.room_id.to_string(),
                event_id: entry.event_id.to_string(),
                ts: entry.ts,
                sender: entry.sender.to_string(),
                sender_name: entry.sender_name.and_then(visible_name),
                body: entry
                    .body
                    .filter(|_| self.shows_inbox_body(entry.encrypted)),
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
        let client = self.client().await?;
        crate::rooms::fill_own_members(&client)
            .await
            .or_failed(self, "inbox_memberships")?;
        let stored = self.stored_inbox(&client).await?;
        let every_encrypted = self.every_encrypted_event_pushed().await;
        let candidates = backfill_candidates(self, &client, &stored, include_read, room_id).await?;
        drop(stored);

        let mut fresh = Vec::new();
        let mut cursors = BTreeMap::new();
        let mut unread_scans = BTreeMap::new();
        let mut pages = 0;
        let mut has_more = false;
        let mut failure = None;

        'rooms: for (room, mut scan) in candidates {
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
                        failure = Some(self.failed_with("inbox_backfill", &error));
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
                    let actions = crate::push_rules::related_actions(
                        &room,
                        event.raw(),
                        event.push_actions().unwrap_or_default().to_vec(),
                    )
                    .await;
                    if let Some(entry) = self.inbox_entry(&room, event.raw(), &actions).await {
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

        let added = self
            .record_inbox(&client, fresh, cursors, unread_scans)
            .await?;
        if added > 0 {
            self.emit(CoreEvent::InboxChanged);
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

fn event_ts(event: &TimelineEvent) -> Option<u64> {
    event.timestamp().map(|ts| u64::from(ts.get()))
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, sync::Arc};

    use matrix_sdk::ruma::{OwnedEventId, owned_room_id, owned_user_id, push::Action, serde::Raw};
    use matrix_sdk::{
        Client, Room,
        ruma::{
            event_id,
            events::AnySyncTimelineEvent,
            events::receipt::{ReceiptThread, ReceiptType},
            room_id,
        },
        test_utils::mocks::MatrixMockServer,
    };
    use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
    use matrix_sdk_ui::sync_service::SyncService;
    use serde_json::json;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path_regex, query_param, query_param_is_missing},
    };

    use super::{
        Entry, InboxScope, MAX_ENTRIES, RoomReadState, UnreadScan, is_reply, is_unread, merge,
        preview,
    };
    use crate::{
        Core, api::notifications::InboxFilter, session::Session, store::MemorySessionStore,
    };

    async fn setup(server: &MatrixMockServer, notified: u64) -> (Arc<Core>, Client, Room) {
        let client = server.client_builder().build().await;
        let room_id = room_id!("!room:example.org");
        let factory = EventFactory::new().room(room_id).sender(User::Alice);
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(factory.member(client.user_id().unwrap()))
                    .add_state_event(factory.member(User::Alice))
                    .add_state_event(factory.power_levels())
                    .set_unread_notifications_count(
                        json!({"notification_count": notified, "highlight_count": notified}),
                    ),
            )
            .await;
        let (core, _) = Core::new("inbox", Box::new(MemorySessionStore::default()));
        *core.session.write().await = Some(Session {
            account_id: "inbox".to_owned(),
            client: client.clone(),
            sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
            homeserver: server.server().uri(),
            oauth: false,
        });
        (core, client, room)
    }

    fn message(
        event_id: &str,
        ts: u64,
        user: Option<&matrix_sdk::ruma::UserId>,
    ) -> serde_json::Value {
        json!({"type": "m.room.message", "event_id": event_id, "room_id": "!room:example.org",
            "sender": User::Alice, "origin_server_ts": ts,
            "content": {"msgtype": "m.text", "body": "hello", "m.mentions": {"user_ids": user.into_iter().collect::<Vec<_>>()}}})
    }

    #[tokio::test]
    async fn an_unknown_encryption_state_hides_the_inbox_preview() {
        let server = MatrixMockServer::new().await;
        let (core, _client, room) = setup(&server, 1).await;
        assert!(room.encryption_state().is_unknown());
        let raw =
            Raw::<AnySyncTimelineEvent>::from_json_string(message("$message", 1, None).to_string())
                .unwrap();

        let entry = core
            .inbox_entry(&room, &raw, &[Action::Notify])
            .await
            .unwrap();
        assert!(entry.encrypted);
        assert!(entry.body.is_none());
    }

    #[tokio::test]
    async fn recorded_notifications_reach_the_store_only_on_flush() {
        let server = MatrixMockServer::new().await;
        let (core, client, _room) = setup(&server, 1).await;
        for (event, ts) in [("first", 100), ("second", 200)] {
            core.record_inbox(
                &client,
                vec![entry(event, ts)],
                BTreeMap::new(),
                BTreeMap::new(),
            )
            .await
            .unwrap();
        }
        assert_eq!(super::load(&client).await.unwrap().entries, []);

        core.flush_inbox(&client).await;

        let stored = super::load(&client).await.unwrap();
        assert_eq!(stored.entries.len(), 2);
        *core.inbox.lock().await = super::InboxCache::default();
        assert_eq!(core.stored_inbox(&client).await.unwrap().entries.len(), 2);
    }

    #[tokio::test]
    async fn suspending_with_unsaved_notifications_saves_them_and_lets_sync_resume() {
        let server = MatrixMockServer::new().await;
        let (core, client, _room) = setup(&server, 1).await;
        core.record_inbox(
            &client,
            vec![entry("first", 100)],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();

        let cycle = async {
            core.update_app_active(false).await;
            core.update_app_active(true).await;
        };
        matrix_sdk::timeout::timeout(cycle, std::time::Duration::from_secs(5))
            .await
            .expect("suspending must not deadlock");

        assert_eq!(super::load(&client).await.unwrap().entries.len(), 1);
    }

    #[tokio::test]
    async fn suspending_during_the_first_inbox_load_does_not_deadlock() {
        let server = MatrixMockServer::new().await;
        let (core, client, _room) = setup(&server, 1).await;
        let closing = core.activity.closing_stores().await;
        let record = core.record_inbox(
            &client,
            vec![entry("first", 100)],
            BTreeMap::new(),
            BTreeMap::new(),
        );
        tokio::pin!(record);
        assert!(futures_util::poll!(record.as_mut()).is_pending());

        matrix_sdk::timeout::timeout(
            core.update_app_active(false),
            std::time::Duration::from_secs(5),
        )
        .await
        .expect("suspending must not wait for the inbox a pending load holds");
        drop(closing);
        let recorded = record.await;
        assert_eq!(recorded.unwrap(), 1);
    }

    #[tokio::test]
    async fn the_inbox_can_be_limited_to_one_room() {
        let server = MatrixMockServer::new().await;
        let (core, client, room) = setup(&server, 1).await;
        core.record_inbox(
            &client,
            vec![entry("here", 200)],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();

        let (here, _) = core
            .inbox_notifications(
                InboxFilter::All,
                true,
                30,
                None,
                InboxScope {
                    room_id: Some(room.room_id()),
                    ..InboxScope::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(here.len(), 1);
        let (elsewhere, _) = core
            .inbox_notifications(
                InboxFilter::All,
                true,
                30,
                None,
                InboxScope {
                    room_id: Some(room_id!("!other:example.org")),
                    ..InboxScope::default()
                },
            )
            .await
            .unwrap();
        assert!(elsewhere.is_empty());
    }

    #[tokio::test]
    async fn the_inbox_can_be_searched_by_sender() {
        let server = MatrixMockServer::new().await;
        let (core, client, _) = setup(&server, 1).await;
        core.record_inbox(
            &client,
            vec![entry("from-alice", 200)],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();

        for (query, found) in [("ALICE", 1), ("bob", 0), ("", 1)] {
            let (items, _) = core
                .inbox_notifications(
                    InboxFilter::All,
                    true,
                    30,
                    None,
                    InboxScope {
                        query: Some(query),
                        ..InboxScope::default()
                    },
                )
                .await
                .unwrap();
            assert_eq!(items.len(), found, "{query}");
        }
    }

    #[tokio::test]
    async fn highlights_keep_inbox_notifications_unread() {
        let server = MatrixMockServer::new().await;
        let (core, client, room) = setup(&server, 1).await;
        core.record_inbox(
            &client,
            vec![entry("unread", 200)],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room.room_id()).set_unread_notifications_count(
                    json!({"notification_count": 0, "highlight_count": 1}),
                ),
            )
            .await;
        let (items, _) = core
            .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert!(!items[0].read);
    }

    #[tokio::test]
    async fn a_stored_encrypted_preview_is_hidden_once_the_setting_is_off() {
        let server = MatrixMockServer::new().await;
        let (core, client, _room) = setup(&server, 1).await;
        let stored = Entry {
            body: Some("secret".to_owned()),
            encrypted: true,
            ..entry("secret", 200)
        };
        core.record_inbox(&client, vec![stored], BTreeMap::new(), BTreeMap::new())
            .await
            .unwrap();
        core.notification_content
            .store(true, std::sync::atomic::Ordering::Relaxed);

        core.notification_encrypted_content
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let (items, _) = core
            .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
            .await
            .unwrap();
        assert_eq!(items[0].body.as_deref(), Some("secret"));

        core.notification_encrypted_content
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let (items, _) = core
            .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
            .await
            .unwrap();
        assert_eq!(items[0].body, None);
    }

    #[tokio::test]
    async fn direct_filter_uses_current_room_status() {
        let server = MatrixMockServer::new().await;
        let (core, client, room) = setup(&server, 1).await;
        core.record_inbox(
            &client,
            vec![entry("unread", 200)],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();
        let factory = EventFactory::new().room(room.room_id()).sender(User::Alice);
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_global_account_data(
                    factory.direct().add_user(User::Alice, room.room_id()),
                );
            })
            .await;
        assert!(room.is_direct().await.unwrap());
        let (items, _) = core
            .inbox_notifications(InboxFilter::Direct, false, 30, None, InboxScope::default())
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].is_direct);
    }

    #[tokio::test]
    async fn a_direct_room_records_messages_the_push_rules_did_not_notify() {
        let server = MatrixMockServer::new().await;
        let (core, client, room) = setup(&server, 0).await;
        let raw = serde_json::from_value(message("$bridged", 200, None)).unwrap();
        assert!(core.inbox_entry(&room, &raw, &[]).await.is_none());
        let factory = EventFactory::new().room(room.room_id()).sender(User::Alice);
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_global_account_data(
                    factory.direct().add_user(User::Alice, room.room_id()),
                );
            })
            .await;
        let entry = core.inbox_entry(&room, &raw, &[]).await.unwrap();
        assert!(entry.is_direct);
    }

    #[tokio::test]
    async fn a_thread_receipt_marks_its_replies_read_and_threads_filter_them() {
        let server = MatrixMockServer::new().await;
        let (core, client, room) = setup(&server, 0).await;
        let factory = EventFactory::new().room(room.room_id()).sender(User::Alice);
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room.room_id()).add_receipt(
                    factory
                        .read_receipts()
                        .add(
                            event_id!("$read-reply"),
                            client.user_id().unwrap(),
                            ReceiptType::Read,
                            ReceiptThread::Thread(event_id!("$root").to_owned()),
                        )
                        .into_event(),
                ),
            )
            .await;
        Mock::given(method("GET"))
            .and(path_regex("/event/.*read-reply$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(message(
                "$read-reply",
                250,
                None,
            )))
            .mount(server.server())
            .await;
        let in_thread = |event: &str, ts| Entry {
            thread_root: Some(event_id!("$root").to_owned()),
            ..entry(event, ts)
        };
        core.record_inbox(
            &client,
            vec![
                in_thread("seen", 200),
                in_thread("new", 300),
                entry("main", 100),
            ],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();

        let (items, _) = core
            .inbox_notifications(InboxFilter::Threads, true, 30, None, InboxScope::default())
            .await
            .unwrap();
        let read: Vec<_> = items
            .iter()
            .map(|item| (item.event_id.as_str(), item.read))
            .collect();
        assert_eq!(read, [("$new", false), ("$seen", true)]);
        assert!(
            items
                .iter()
                .all(|item| item.thread_root.as_deref() == Some("$root"))
        );
    }

    #[test]
    fn an_entry_stored_before_threads_were_recorded_is_not_in_a_thread() {
        let stored = json!({"room_id": "!room:example.org", "event_id": "$old", "ts": 1,
            "sender": "@alice:example.org", "sender_name": null, "body": null,
            "highlight": false, "is_direct": false, "encrypted": false});
        let entry: Entry = serde_json::from_value(stored).unwrap();
        assert_eq!(entry.thread_root, None);
        assert!(!super::matches(&entry, InboxFilter::Threads));
    }

    #[tokio::test]
    async fn delayed_receipt_does_not_hide_a_newer_unread_message() {
        let server = MatrixMockServer::new().await;
        let (core, client, room) = setup(&server, 1).await;
        let factory = EventFactory::new().room(room.room_id()).sender(User::Alice);
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room.room_id())
                    .add_receipt(
                        factory
                            .read_receipts()
                            .add_with_timestamp(
                                event_id!("$read"),
                                client.user_id().unwrap(),
                                ReceiptType::Read,
                                ReceiptThread::Unthreaded,
                                Some(matrix_sdk::ruma::MilliSecondsSinceUnixEpoch(300u32.into())),
                            )
                            .into_event(),
                    )
                    .set_unread_notifications_count(
                        json!({"notification_count": 1, "highlight_count": 1}),
                    ),
            )
            .await;
        Mock::given(method("GET"))
            .and(path_regex("/event/.*read$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(message("$read", 100, None)))
            .expect(1)
            .mount(server.server())
            .await;
        core.record_inbox(
            &client,
            vec![entry("unread", 200)],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();

        for _ in 0..2 {
            let (items, _) = core
                .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
                .await
                .unwrap();
            assert_eq!(items.len(), 1);
            assert_eq!(items[0].event_id, "$unread");
            assert!(!items[0].read);
        }
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room.room_id())
                    .add_receipt(
                        factory
                            .read_receipts()
                            .add(
                                event_id!("$unavailable"),
                                client.user_id().unwrap(),
                                ReceiptType::Read,
                                ReceiptThread::Unthreaded,
                            )
                            .into_event(),
                    )
                    .set_unread_notifications_count(
                        json!({"notification_count": 0, "highlight_count": 0}),
                    ),
            )
            .await;
        let (items, _) = core
            .inbox_notifications(InboxFilter::All, true, 30, None, InboxScope::default())
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].read);
    }

    #[tokio::test]
    async fn an_unfetchable_receipt_event_falls_back_to_the_receipt_time() {
        let server = MatrixMockServer::new().await;
        let (core, client, room) = setup(&server, 1).await;
        let factory = EventFactory::new().room(room.room_id()).sender(User::Alice);
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room.room_id())
                    .add_receipt(
                        factory
                            .read_receipts()
                            .add_with_timestamp(
                                event_id!("$gone"),
                                client.user_id().unwrap(),
                                ReceiptType::Read,
                                ReceiptThread::Unthreaded,
                                Some(matrix_sdk::ruma::MilliSecondsSinceUnixEpoch(150u32.into())),
                            )
                            .into_event(),
                    )
                    .set_unread_notifications_count(
                        json!({"notification_count": 1, "highlight_count": 1}),
                    ),
            )
            .await;
        Mock::given(method("GET"))
            .and(path_regex("/event/.*gone$"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "gone"})),
            )
            .mount(server.server())
            .await;
        core.record_inbox(
            &client,
            vec![entry("old", 100), entry("new", 200)],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();

        let (items, _) = core
            .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
            .await
            .unwrap();

        assert_eq!(
            items
                .iter()
                .map(|item| item.event_id.as_str())
                .collect::<Vec<_>>(),
            ["$new"]
        );
    }

    #[tokio::test]
    async fn unread_backfill_resumes_after_five_empty_pages() {
        let server = MatrixMockServer::new().await;
        let (core, client, _) = setup(&server, 1).await;
        for page in 0..6 {
            let mock = Mock::given(method("GET")).and(path_regex("/messages$"));
            let mock = if page == 0 {
                mock.and(query_param_is_missing("from"))
            } else {
                mock.and(query_param("from", format!("p{page}")))
            };
            let mut event = message(
                &format!("$p{page}"),
                1000 - page,
                if page == 5 { client.user_id() } else { None },
            );
            if page < 5 {
                event["sender"] = json!(client.user_id().unwrap());
            }
            mock.respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "start": format!("p{page}"), "end": format!("p{}", page + 1), "chunk": [event], "state": []
            }))).expect(1).mount(server.server()).await;
        }

        assert_eq!(core.backfill_inbox(false, None).await.unwrap(), (0, true));
        assert_eq!(core.backfill_inbox(false, None).await.unwrap(), (1, false));
        assert_eq!(core.backfill_inbox(false, None).await.unwrap(), (0, false));
        let (items, _) = core
            .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].event_id, "$p5");
    }

    #[tokio::test]
    async fn backfill_fetch_errors_are_reported_and_can_be_retried() {
        let server = MatrixMockServer::new().await;
        let (core, client, _) = setup(&server, 1).await;
        let failure = Mock::given(method("GET"))
            .and(path_regex("/messages$"))
            .respond_with(
                ResponseTemplate::new(403)
                    .set_body_json(json!({"errcode": "M_FORBIDDEN", "error": "denied"})),
            )
            .mount_as_scoped(server.server())
            .await;
        core.backfill_inbox(false, None).await.unwrap_err();
        drop(failure);
        Mock::given(method("GET")).and(path_regex("/messages$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"start": "p0", "chunk": [message("$retry", 100, client.user_id())], "state": []})))
            .mount(server.server()).await;
        assert_eq!(core.backfill_inbox(false, None).await.unwrap(), (1, false));
    }

    #[tokio::test]
    async fn unread_backfill_reaches_rooms_beyond_the_first_batch() {
        let server = MatrixMockServer::new().await;
        let (core, client, _) = setup(&server, 1).await;
        for index in 0..6 {
            let name = if index == 0 {
                "room".to_owned()
            } else {
                format!("extra{index}")
            };
            if index > 0 {
                let room_id =
                    matrix_sdk::ruma::RoomId::parse(format!("!{name}:example.org")).unwrap();
                let factory = EventFactory::new().room(&room_id).sender(User::Alice);
                server
                    .sync_room(
                        &client,
                        JoinedRoomBuilder::new(&room_id)
                            .add_state_event(factory.member(client.user_id().unwrap()))
                            .add_state_event(factory.member(User::Alice))
                            .add_state_event(factory.power_levels())
                            .set_unread_notifications_count(
                                json!({"notification_count": 1, "highlight_count": 1}),
                            ),
                    )
                    .await;
            }
            Mock::given(method("GET")).and(path_regex(format!("/rooms/.*{name}.*?/messages$")))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({"start": "p0", "chunk": [message(&format!("${name}"), 100, client.user_id())], "state": []})))
                .expect(1).mount(server.server()).await;
        }
        assert_eq!(core.backfill_inbox(false, None).await.unwrap(), (5, true));
        assert_eq!(core.backfill_inbox(false, None).await.unwrap(), (1, false));
        assert_eq!(
            core.inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
                .await
                .unwrap()
                .0
                .len(),
            6
        );
    }

    #[tokio::test]
    async fn backfill_can_be_limited_to_one_room() {
        let server = MatrixMockServer::new().await;
        let (core, client, room) = setup(&server, 1).await;
        let other = matrix_sdk::ruma::room_id!("!other:example.org");
        let factory = EventFactory::new().room(other).sender(User::Alice);
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(other)
                    .add_state_event(factory.member(client.user_id().unwrap()))
                    .add_state_event(factory.member(User::Alice))
                    .add_state_event(factory.power_levels())
                    .set_unread_notifications_count(
                        json!({"notification_count": 1, "highlight_count": 1}),
                    ),
            )
            .await;
        for (name, calls) in [("room", 1), ("other", 0)] {
            Mock::given(method("GET")).and(path_regex(format!("/rooms/.*{name}.*?/messages$")))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({"start": "p0", "chunk": [message(&format!("${name}"), 100, client.user_id())], "state": []})))
                .expect(calls).mount(server.server()).await;
        }

        assert_eq!(
            core.backfill_inbox(false, Some(room.room_id()))
                .await
                .unwrap(),
            (1, false)
        );
    }

    #[tokio::test]
    async fn a_cached_notification_does_not_stop_backfill_before_a_missing_one() {
        let server = MatrixMockServer::new().await;
        let (core, client, _) = setup(&server, 2).await;
        core.record_inbox(
            &client,
            vec![entry("known", 200)],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();
        for (from, end, id, ts) in [
            (None, Some("older"), "$known", 200),
            (Some("older"), None, "$missing", 100),
        ] {
            let mock = Mock::given(method("GET")).and(path_regex("/messages$"));
            let mock = if let Some(from) = from {
                mock.and(query_param("from", from))
            } else {
                mock.and(query_param_is_missing("from"))
            };
            mock.respond_with(ResponseTemplate::new(200).set_body_json(json!({"start": "p0", "end": end, "chunk": [message(id, ts, client.user_id())], "state": []})))
                .expect(1).mount(server.server()).await;
        }
        assert_eq!(core.backfill_inbox(false, None).await.unwrap(), (1, false));
        assert_eq!(
            core.inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
                .await
                .unwrap()
                .0
                .len(),
            2
        );
    }

    #[test]
    fn a_new_head_or_read_boundary_restarts_a_completed_scan() {
        let mut scan = UnreadScan::for_room(None, 100, 1, Some(event_id!("$old").to_owned()));
        scan.complete = true;
        scan.from = Some("old-page".to_owned());
        let fresh = UnreadScan::for_room(Some(&scan), 100, 1, Some(event_id!("$new").to_owned()));
        assert!(!fresh.complete);
        assert!(fresh.from.is_none());
        let fresh = UnreadScan::for_room(Some(&scan), 200, 1, scan.head.clone());
        assert!(!fresh.complete);
        assert!(fresh.from.is_none());
    }

    fn entry(event: &str, ts: u64) -> Entry {
        Entry {
            room_id: owned_room_id!("!room:example.org"),
            event_id: OwnedEventId::try_from(format!("${event}")).unwrap(),
            ts,
            sender: owned_user_id!("@alice:example.org"),
            sender_name: None,
            body: None,
            highlight: false,
            is_direct: false,
            encrypted: false,
            undecryptable: false,
            thread_root: None,
            reply: false,
        }
    }

    #[test]
    fn only_real_replies_count_as_replies() {
        let event = |relation: serde_json::Value| {
            Raw::<AnySyncTimelineEvent>::from_json_string(
                json!({
                    "type": "m.room.message",
                    "event_id": "$e",
                    "sender": "@a:example.org",
                    "origin_server_ts": 1,
                    "content": { "msgtype": "m.text", "body": "hi", "m.relates_to": relation },
                })
                .to_string(),
            )
            .unwrap()
        };

        assert!(is_reply(&event(
            json!({ "m.in_reply_to": { "event_id": "$p" } })
        )));
        assert!(!is_reply(&event(json!({
            "rel_type": "m.thread",
            "event_id": "$root",
            "is_falling_back": true,
            "m.in_reply_to": { "event_id": "$p" },
        }))));
        assert!(is_reply(&event(json!({
            "rel_type": "m.thread",
            "event_id": "$root",
            "is_falling_back": false,
            "m.in_reply_to": { "event_id": "$p" },
        }))));
        assert!(!is_reply(&event(json!({}))));
    }

    #[test]
    fn merge_skips_known_events_and_keeps_newest_first() {
        let mut entries = vec![entry("a", 10), entry("b", 30)];

        let added = merge(&mut entries, vec![entry("a", 10), entry("c", 20)]);

        assert_eq!(added, 1);
        let order: Vec<u64> = entries.iter().map(|entry| entry.ts).collect();
        assert_eq!(order, vec![30, 20, 10]);
    }

    #[test]
    fn merge_replaces_an_undecryptable_entry_with_its_decrypted_version() {
        let mut stale = entry("a", 10);
        stale.undecryptable = true;
        stale.highlight = true;
        let mut decrypted = entry("a", 10);
        decrypted.body = Some("hello".to_owned());
        let mut entries = vec![stale];

        let changed = merge(&mut entries, vec![decrypted.clone()]);

        assert_eq!(changed, 1);
        assert_eq!(entries, vec![decrypted.clone()]);

        let mut still_encrypted = entry("a", 10);
        still_encrypted.undecryptable = true;
        assert_eq!(merge(&mut entries, vec![still_encrypted]), 0);
        assert_eq!(entries, vec![decrypted]);
    }

    #[test]
    fn merge_drops_the_oldest_past_the_cap() {
        let mut entries: Vec<Entry> = (0..MAX_ENTRIES as u64)
            .map(|index| entry(&format!("e{index}"), index + 1))
            .collect();

        merge(&mut entries, vec![entry("newest", u64::MAX)]);

        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries.first().map(|entry| entry.ts), Some(u64::MAX));
        assert!(entries.iter().all(|entry| entry.ts != 1));
    }

    #[test]
    fn unread_stops_at_the_receipt_and_the_server_count() {
        let mut state = RoomReadState {
            receipt_ts: 15,
            remaining: 1,
        };

        assert!(is_unread(&entry("new", 30), &mut state));
        assert!(!is_unread(&entry("newer-than-receipt", 20), &mut state));
        assert!(!is_unread(&entry("old", 10), &mut state));
    }

    #[test]
    fn previews_are_truncated_on_characters() {
        let long = "é".repeat(200);

        let short = preview(long);

        assert_eq!(short.chars().count(), 121);
        assert!(short.ends_with('…'));
    }
}
