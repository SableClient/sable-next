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
use crate::ResultExt;
use crate::notifications;
use crate::preview;
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

async fn load(client: &matrix_sdk::Client) -> Result<Stored, CommandErr> {
    let bytes = match client.state_store().get_custom_value(KEY).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(Stored::default()),
        Err(error) => {
            warn!("reading the inbox store failed: {error}");
            return Err(CommandErr::Unavailable);
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

async fn save(client: &matrix_sdk::Client, stored: &mut Stored) -> Result<(), CommandErr> {
    stored.version = SCHEMA;
    let bytes = match serde_json::to_vec(stored) {
        Ok(bytes) => bytes,
        Err(error) => {
            warn!("serialising the inbox store failed: {error}");
            return Err(CommandErr::Unavailable);
        }
    };
    if let Err(error) = client
        .state_store()
        .set_custom_value_no_read(KEY, bytes)
        .await
    {
        warn!("persisting the inbox store failed: {error}");
        return Err(CommandErr::Unavailable);
    }
    Ok(())
}

pub(crate) async fn receipt_ts(room: &Room) -> matrix_sdk::Result<u64> {
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
        return Ok(0);
    }
    let targets: std::collections::BTreeSet<OwnedEventId> = receipts.keys().cloned().collect();
    let key = format!("sable.inbox.receipt.{}", room.room_id());
    let client = room.client();
    let store = client.state_store();
    if let Some(bytes) = store.get_custom_value(key.as_bytes()).await?
        && let Ok((known, ts)) =
            serde_json::from_slice::<(std::collections::BTreeSet<OwnedEventId>, u64)>(&bytes)
        && known == targets
    {
        return Ok(ts);
    }
    let mut latest = 0;
    let mut resolved = true;
    for (event_id, receipt_ts) in &receipts {
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

fn notified(room: &Room) -> u64 {
    room.unread_notification_counts()
        .notification_count
        .max(room.num_unread_notifications())
}

async fn read_state(room: &Room) -> Result<RoomReadState, CommandErr> {
    let remaining = notified(room);
    if remaining == 0 {
        return Ok(RoomReadState {
            receipt_ts: 0,
            remaining,
        });
    }
    Ok(RoomReadState {
        receipt_ts: receipt_ts(room).await.map_err(|error| {
            warn!("resolving the inbox read receipt failed: {error}");
            CommandErr::Unavailable
        })?,
        remaining,
    })
}

async fn backfill_candidates(
    client: &matrix_sdk::Client,
    stored: &Stored,
    include_read: bool,
) -> Result<Vec<(Room, UnreadScan)>, CommandErr> {
    let mut candidates = Vec::new();
    for room in client.joined_rooms() {
        if room.is_space() {
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
        if notified(&room) == 0 {
            continue;
        }
        let read = read_state(&room).await?;
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
        Some(preview(preview::describe(event)))
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
        let encrypted = crate::rooms::room_maybe_encrypted(room);
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
        unread_scans: BTreeMap<OwnedRoomId, UnreadScan>,
    ) -> Result<usize, CommandErr> {
        if fresh.is_empty() && cursors.is_empty() && unread_scans.is_empty() {
            return Ok(0);
        }
        let _guard = self.inbox_lock.lock().await;
        let mut stored = load(client).await?;
        let added = merge(&mut stored.entries, fresh);
        stored.cursors.extend(cursors);
        stored.unread_scans.extend(unread_scans);
        save(client, &mut stored).await?;
        Ok(added)
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
            Ok(added) if added > 0 => self.emit_if_current(generation, CoreEvent::InboxChanged),
            Err(error) => warn!(?error, "recording an inbox notification failed"),
            _ => {}
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
        let stored = load(&client).await?;
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
                        let read = read_state(&room).await?;
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

    pub(crate) async fn backfill_inbox(
        &self,
        include_read: bool,
    ) -> Result<(u32, bool), CommandErr> {
        let client = self.client().await?;
        crate::rooms::fill_own_members(&client)
            .await
            .or_failed(self, "inbox_memberships")?;
        let stored = load(&client).await?;
        let every_encrypted = notifications::every_encrypted_event_pushed(&client).await;
        let candidates = backfill_candidates(&client, &stored, include_read).await?;
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
                        failure = Some(self.failed("inbox_backfill", error));
                        continue 'rooms;
                    }
                };
                let mut reached_read = false;
                for event in &messages.chunk {
                    if event_ts(event).is_some_and(|ts| ts <= scan.receipt_ts) && !include_read {
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
                        scan.found = scan.found.saturating_add(1);
                    }
                }
                let exhausted = messages.end.is_none() || messages.chunk.is_empty();
                if !exhausted && messages.end == scan.from {
                    failure = Some(CommandErr::Unavailable);
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
    use matrix_sdk_test::{ALICE, JoinedRoomBuilder, event_factory::EventFactory};
    use matrix_sdk_ui::sync_service::SyncService;
    use serde_json::json;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path_regex, query_param, query_param_is_missing},
    };

    use super::{Entry, MAX_ENTRIES, RoomReadState, UnreadScan, is_unread, merge, preview};
    use crate::{Core, protocol::InboxFilter, session::Session, store::MemorySessionStore};

    async fn setup(server: &MatrixMockServer, notified: u64) -> (Arc<Core>, Client, Room) {
        let client = server.client_builder().build().await;
        let room_id = room_id!("!room:example.org");
        let factory = EventFactory::new().room(room_id).sender(*ALICE);
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(factory.member(client.user_id().unwrap()))
                    .add_state_event(factory.member(*ALICE))
                    .add_state_event(factory.default_power_levels())
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
            "sender": *ALICE, "origin_server_ts": ts,
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
    async fn delayed_receipt_does_not_hide_a_newer_unread_message() {
        let server = MatrixMockServer::new().await;
        let (core, client, room) = setup(&server, 1).await;
        let factory = EventFactory::new().room(room.room_id()).sender(*ALICE);
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
                .inbox_notifications(InboxFilter::All, false, 30, None)
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
            .inbox_notifications(InboxFilter::All, true, 30, None)
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].read);
    }

    #[tokio::test]
    async fn an_unfetchable_receipt_event_falls_back_to_the_receipt_time() {
        let server = MatrixMockServer::new().await;
        let (core, client, room) = setup(&server, 1).await;
        let factory = EventFactory::new().room(room.room_id()).sender(*ALICE);
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
            .inbox_notifications(InboxFilter::All, false, 30, None)
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

        assert_eq!(core.backfill_inbox(false).await.unwrap(), (0, true));
        assert_eq!(core.backfill_inbox(false).await.unwrap(), (1, false));
        assert_eq!(core.backfill_inbox(false).await.unwrap(), (0, false));
        let (items, _) = core
            .inbox_notifications(InboxFilter::All, false, 30, None)
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
        core.backfill_inbox(false).await.unwrap_err();
        drop(failure);
        Mock::given(method("GET")).and(path_regex("/messages$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"start": "p0", "chunk": [message("$retry", 100, client.user_id())], "state": []})))
            .mount(server.server()).await;
        assert_eq!(core.backfill_inbox(false).await.unwrap(), (1, false));
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
                let factory = EventFactory::new().room(&room_id).sender(*ALICE);
                server
                    .sync_room(
                        &client,
                        JoinedRoomBuilder::new(&room_id)
                            .add_state_event(factory.member(client.user_id().unwrap()))
                            .add_state_event(factory.member(*ALICE))
                            .add_state_event(factory.default_power_levels())
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
        assert_eq!(core.backfill_inbox(false).await.unwrap(), (5, true));
        assert_eq!(core.backfill_inbox(false).await.unwrap(), (1, false));
        assert_eq!(
            core.inbox_notifications(InboxFilter::All, false, 30, None)
                .await
                .unwrap()
                .0
                .len(),
            6
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
        assert_eq!(core.backfill_inbox(false).await.unwrap(), (1, false));
        assert_eq!(
            core.inbox_notifications(InboxFilter::All, false, 30, None)
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
