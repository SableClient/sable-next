use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::Ordering;

use matrix_sdk::Room;
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::events::receipt::{ReceiptThread, ReceiptType};
use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, AnySyncTimelineEvent};
use matrix_sdk::ruma::push::Action;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, OwnedUserId, UInt};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::Core;
use crate::notifications;
use crate::protocol::{CommandErr, CoreEvent, InboxFilter, InboxItemView};

const SCHEMA: u32 = 1;
const KEY: &[u8] = b"sable.inbox.notifications";
const MAX_ENTRIES: usize = 5_000;
const PREVIEW_LIMIT: usize = 120;
const PAGE_SIZE: u16 = 50;
const MAX_PAGES: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    version: u32,
    entries: Vec<Entry>,
    cursors: BTreeMap<OwnedRoomId, Option<String>>,
}

fn merge(entries: &mut Vec<Entry>, fresh: Vec<Entry>) -> usize {
    let mut known: HashSet<OwnedEventId> =
        entries.iter().map(|entry| entry.event_id.clone()).collect();
    let before = entries.len();
    for entry in fresh {
        if known.insert(entry.event_id.clone()) {
            entries.push(entry);
        }
    }
    let added = entries.len() - before;
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.ts));
    entries.truncate(MAX_ENTRIES);
    added
}

fn preview(body: String) -> String {
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

const fn matches(entry: &Entry, filter: InboxFilter) -> bool {
    match filter {
        InboxFilter::All => true,
        InboxFilter::Mentions => entry.highlight,
        InboxFilter::Direct => entry.is_direct,
    }
}

async fn load(client: &matrix_sdk::Client) -> Stored {
    let bytes = match client.state_store().get_custom_value(KEY).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Stored::default(),
        Err(error) => {
            warn!("reading the inbox store failed: {error}");
            return Stored::default();
        }
    };
    match serde_json::from_slice::<Stored>(&bytes) {
        Ok(stored) if stored.version == SCHEMA => stored,
        Ok(_) => Stored::default(),
        Err(error) => {
            warn!("discarding an inbox store that did not parse: {error}");
            Stored::default()
        }
    }
}

async fn save(client: &matrix_sdk::Client, stored: &mut Stored) {
    stored.version = SCHEMA;
    let bytes = match serde_json::to_vec(stored) {
        Ok(bytes) => bytes,
        Err(error) => {
            warn!("serialising the inbox store failed: {error}");
            return;
        }
    };
    if let Err(error) = client
        .state_store()
        .set_custom_value_no_read(KEY, bytes)
        .await
    {
        warn!("persisting the inbox store failed: {error}");
    }
}

pub(crate) async fn receipt_ts(room: &Room) -> u64 {
    let user_id = room.own_user_id();
    let mut latest = 0;
    for receipt_type in [ReceiptType::Read, ReceiptType::ReadPrivate] {
        for thread in [ReceiptThread::Unthreaded, ReceiptThread::Main] {
            if let Ok(Some((_, receipt))) = room
                .load_user_receipt(receipt_type.clone(), &thread, user_id)
                .await
                && let Some(ts) = receipt.ts
            {
                latest = latest.max(u64::from(ts.get()));
            }
        }
    }
    latest
}

async fn read_state(room: &Room) -> RoomReadState {
    RoomReadState {
        receipt_ts: receipt_ts(room).await,
        remaining: room.unread_notification_counts().notification_count,
    }
}

impl Core {
    fn inbox_body(&self, event: &AnySyncTimelineEvent, encrypted: bool) -> Option<String> {
        if !self.notification_content.load(Ordering::Relaxed)
            || (encrypted && !self.notification_encrypted_content.load(Ordering::Relaxed))
        {
            return None;
        }
        if matches!(
            event,
            AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomEncrypted(_))
        ) {
            return None;
        }
        Some(preview(notifications::timeline_body(event)))
    }

    async fn inbox_entry(
        &self,
        room: &Room,
        raw: &Raw<AnySyncTimelineEvent>,
        actions: &[Action],
    ) -> Option<Entry> {
        if !notifications::notifies(actions) || crate::calls::is_call_event_type(raw) {
            return None;
        }
        let event = raw.deserialize().ok()?;
        if event.sender() == room.own_user_id() {
            return None;
        }
        let sender_name = room
            .get_member_no_sync(event.sender())
            .await
            .ok()
            .flatten()
            .and_then(|member| member.display_name().map(ToOwned::to_owned));
        let encrypted = room.encryption_state().is_encrypted();
        Some(Entry {
            room_id: room.room_id().to_owned(),
            event_id: event.event_id().to_owned(),
            ts: u64::from(event.origin_server_ts().get()),
            sender: event.sender().to_owned(),
            sender_name,
            body: self.inbox_body(&event, encrypted),
            highlight: actions.iter().any(Action::is_highlight),
            is_direct: room.is_direct().await.unwrap_or(false),
            encrypted,
        })
    }

    async fn record_inbox(
        &self,
        client: &matrix_sdk::Client,
        fresh: Vec<Entry>,
        cursors: BTreeMap<OwnedRoomId, Option<String>>,
    ) -> usize {
        if fresh.is_empty() && cursors.is_empty() {
            return 0;
        }
        let _guard = self.inbox_lock.lock().await;
        let mut stored = load(client).await;
        let added = merge(&mut stored.entries, fresh);
        stored.cursors.extend(cursors);
        save(client, &mut stored).await;
        added
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
        if self
            .record_inbox(&room.client(), vec![entry], BTreeMap::new())
            .await
            > 0
        {
            self.emit_if_current(generation, CoreEvent::InboxChanged);
        }
    }

    pub(crate) async fn inbox_notifications(
        &self,
        filter: InboxFilter,
        include_read: bool,
        limit: u32,
        before_ts: Option<u64>,
    ) -> Result<(Vec<InboxItemView>, bool), CommandErr> {
        let client = self.client().await?;
        let stored = load(&client).await;
        let mut rooms: HashMap<OwnedRoomId, Option<(Room, RoomReadState)>> = HashMap::new();
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
        let mut items = Vec::new();
        let mut has_more = false;

        for entry in stored.entries {
            if !rooms.contains_key(&entry.room_id) {
                let joined = client
                    .get_room(&entry.room_id)
                    .filter(|room| room.state() == matrix_sdk::RoomState::Joined);
                let state = match joined {
                    Some(room) => {
                        let read = read_state(&room).await;
                        Some((room, read))
                    }
                    None => None,
                };
                rooms.insert(entry.room_id.clone(), state);
            }
            let Some(Some((_, read))) = rooms.get_mut(&entry.room_id) else {
                continue;
            };
            let unread = is_unread(&entry, read);
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
                sender_name: entry.sender_name,
                body: entry.body,
                highlight: entry.highlight,
                is_direct: entry.is_direct,
                encrypted: entry.encrypted,
                read: !unread,
            });
        }

        Ok((items, has_more))
    }

    pub(crate) async fn backfill_inbox(&self, include_read: bool) -> Result<u32, CommandErr> {
        let client = self.client().await?;
        if let Err(error) = crate::rooms::fill_own_members(&client).await {
            warn!("could not fill in our own room memberships: {error}");
        }
        let stored = load(&client).await;
        let every_encrypted = notifications::every_encrypted_event_pushed(&client).await;
        let mut candidates = Vec::new();

        for room in client.joined_rooms() {
            if room.is_space() {
                continue;
            }
            let counts = room.unread_notification_counts();
            let cursor = stored.cursors.get(room.room_id()).cloned();
            if include_read {
                if matches!(cursor, Some(None)) {
                    continue;
                }
                candidates.push((room, u64::MAX, 0, cursor.flatten()));
                continue;
            }
            if counts.notification_count == 0 {
                continue;
            }
            let receipt = receipt_ts(&room).await;
            let known = stored
                .entries
                .iter()
                .filter(|entry| entry.room_id == room.room_id() && entry.ts > receipt)
                .count() as u64;
            let missing = counts.notification_count.saturating_sub(known);
            if missing > 0 {
                candidates.push((room, missing, receipt, None));
            }
        }
        drop(stored);

        candidates.sort_by_key(|(room, _, _, _)| {
            (
                std::cmp::Reverse(room.unread_notification_counts().highlight_count),
                std::cmp::Reverse(room.recency_stamp()),
            )
        });

        let mut fresh = Vec::new();
        let mut cursors = BTreeMap::new();
        let mut pages = 0;

        'rooms: for (room, mut missing, receipt, mut from) in candidates {
            loop {
                if pages == MAX_PAGES {
                    break 'rooms;
                }
                pages += 1;
                let mut options = MessagesOptions::backward().from(from.as_deref());
                options.limit = UInt::from(PAGE_SIZE);
                let messages = match room.messages(options).await {
                    Ok(messages) => messages,
                    Err(error) => {
                        warn!(room_id = %room.room_id(), "inbox backfill failed: {error}");
                        continue 'rooms;
                    }
                };
                let mut reached_read = false;
                for event in &messages.chunk {
                    if event_ts(event).is_some_and(|ts| ts <= receipt) && !include_read {
                        reached_read = true;
                        break;
                    }
                    let Some(actions) = event.push_actions() else {
                        continue;
                    };
                    if every_encrypted && notifications::raw_is_encrypted(event.raw()) {
                        continue;
                    }
                    if let Some(entry) = self.inbox_entry(&room, event.raw(), actions).await {
                        fresh.push(entry);
                        missing = missing.saturating_sub(1);
                    }
                }
                let exhausted = messages.end.is_none() || messages.chunk.is_empty();
                if include_read {
                    cursors.insert(
                        room.room_id().to_owned(),
                        (!exhausted).then(|| messages.end.clone()).flatten(),
                    );
                }
                if exhausted || reached_read || missing == 0 {
                    break;
                }
                from = messages.end;
            }
        }

        let added = self.record_inbox(&client, fresh, cursors).await;
        if added > 0 {
            self.emit(CoreEvent::InboxChanged);
        }
        Ok(u32::try_from(added).unwrap_or(u32::MAX))
    }
}

fn event_ts(event: &TimelineEvent) -> Option<u64> {
    event.timestamp().map(|ts| u64::from(ts.get()))
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{OwnedEventId, owned_room_id, owned_user_id};

    use super::{Entry, MAX_ENTRIES, RoomReadState, is_unread, merge, preview};

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
        }
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
