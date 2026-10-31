mod chunks;
mod core_api;
mod crawl;
mod document;
mod index;
mod network;
pub(crate) use network::CrawlNetwork;
mod dictionary;
#[cfg(target_family = "wasm")]
mod idb;
mod persist;
mod server;
mod tokenize;

pub(crate) const MAX_SEARCH_RESULTS: usize = 200;

pub(crate) use crawl::CrawlProgress;
#[cfg(not(target_family = "wasm"))]
pub(crate) use persist::reset_state_cache;
pub(crate) use server::ServerSearch;

use std::time::Duration;

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::event_cache::RoomEventCache;
use matrix_sdk::ruma::events::ignored_user_list::IgnoredUserListEventContent;
use matrix_sdk::ruma::events::room::message::{OriginalSyncRoomMessageEvent, Relation};
use matrix_sdk::ruma::events::room::redaction::SyncRoomRedactionEvent;
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId, OwnedUserId};

use self::document::{Document, indexable_body, replacement_of};
#[cfg(test)]
use self::index::RoomIndex;
pub(crate) use self::index::{ContextLine, Hit, MessageIndex};
use crate::messages::valid_replacements;
use crate::protocol::{self, RpcError, SearchAttachment};

const BODY_FIELD_COUNT: usize = 1;
const BODY_FIELD_BOOST: [f64; BODY_FIELD_COUNT] = [1.0];
const EVENTS_PER_INGEST_YIELD: usize = 16;
const DOCUMENTS_PER_RESTORE_YIELD: usize = 256;
const INGEST_WAIT: Duration = Duration::from_millis(25);
const INGEST_WAIT_ATTEMPTS: usize = 200;
const RETIRED_KEYS_BEFORE_VACUUM: usize = 64;

/// [`protocol::SearchFilter`] with its ids parsed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct IndexFilter {
    pub(crate) rooms: Vec<OwnedRoomId>,
    pub(crate) senders: Vec<OwnedUserId>,
    pub(crate) mentions: Vec<OwnedUserId>,
    pub(crate) has: Vec<SearchAttachment>,
    pub(crate) not_rooms: Vec<OwnedRoomId>,
    pub(crate) not_senders: Vec<OwnedUserId>,
    pub(crate) not_mentions: Vec<OwnedUserId>,
    pub(crate) not_has: Vec<SearchAttachment>,
    pub(crate) after_ts: Option<u64>,
    pub(crate) before_ts: Option<u64>,
    pub(crate) phrases: Vec<String>,
    pub(crate) exclude: Vec<String>,
    pub(crate) pinned: Option<bool>,
    pub(crate) in_thread: Option<bool>,
    pub(crate) file_types: Vec<String>,
    pub(crate) not_file_types: Vec<String>,
    pub(crate) pattern: Option<String>,
    pub(crate) state_events: Option<bool>,
}

fn parsed_ids<T: TryFrom<String>>(ids: Vec<String>) -> Result<Vec<T>, RpcError> {
    ids.into_iter()
        .map(|id| T::try_from(id).map_err(|_| RpcError::InvalidSearchFilter))
        .collect()
}

impl TryFrom<protocol::SearchFilter> for IndexFilter {
    type Error = RpcError;

    fn try_from(filter: protocol::SearchFilter) -> Result<Self, RpcError> {
        Ok(Self {
            rooms: parsed_ids(filter.rooms)?,
            senders: parsed_ids(filter.senders)?,
            mentions: parsed_ids(filter.mentions)?,
            has: filter.has,
            not_rooms: parsed_ids(filter.not_rooms)?,
            not_senders: parsed_ids(filter.not_senders)?,
            not_mentions: parsed_ids(filter.not_mentions)?,
            not_has: filter.not_has,
            after_ts: filter.after_ts,
            before_ts: filter.before_ts,
            phrases: filter.phrases,
            exclude: filter.exclude,
            pinned: filter.pinned,
            in_thread: filter.in_thread,
            file_types: filter.file_types,
            not_file_types: filter.not_file_types,
            pattern: filter.pattern,
            state_events: filter.state_events,
        })
    }
}

const MEMORY_BUDGET: usize = 64 * 1024 * 1024;
const DISK_BUDGET: u64 = 512 * 1024 * 1024;
const COLD_CHUNKS_PER_PAGE: usize = 32;
const OLDER_PAGE_BUDGET_MS: u64 = 50;
const HYDRATE_BATCH: usize = 30;
const HYDRATE_CONCURRENCY: usize = 8;
const DOCUMENT_OVERHEAD: usize = 1_600;
const CLASSIFIED_OVERHEAD: usize = 96;
const PINNED_FETCH_CONCURRENCY: usize = 4;

const INITIAL_DOCUMENTS: usize = 64;
const CHANGES_BEFORE_FLUSH: usize = 32;
const TICKS_BEFORE_FLUSH: u32 = 5;
fn now_ms() -> u64 {
    matrix_sdk::ruma::MilliSecondsSinceUnixEpoch::now()
        .get()
        .into()
}

pub(super) fn edited_or_own_event_id(original: &OriginalSyncRoomMessageEvent) -> OwnedEventId {
    match &original.content.relates_to {
        Some(Relation::Replacement(replacement)) => replacement.event_id.clone(),
        _ => original.event_id.clone(),
    }
}

fn ingestable_events(
    diffs: Vec<matrix_sdk_ui::eyeball_im::VectorDiff<TimelineEvent>>,
) -> Vec<TimelineEvent> {
    use matrix_sdk_ui::eyeball_im::VectorDiff as In;

    diffs
        .into_iter()
        .flat_map(|diff| match diff {
            In::Append { values } | In::Reset { values } => values.into_iter().collect(),
            In::PushFront { value }
            | In::PushBack { value }
            | In::Insert { value, .. }
            | In::Set { value, .. } => vec![value],
            _ => Vec::new(),
        })
        .collect()
}

pub(crate) async fn ignored_user_ids(client: &matrix_sdk::Client) -> Vec<OwnedUserId> {
    client
        .account()
        .account_data::<IgnoredUserListEventContent>()
        .await
        .ok()
        .flatten()
        .and_then(|raw| raw.deserialize().ok())
        .map(|content| content.ignored_users.into_keys().collect())
        .unwrap_or_default()
}

fn redacted_event_id(
    redaction: &SyncRoomRedactionEvent,
    rules: &RedactionRules,
) -> Option<OwnedEventId> {
    let original = redaction.as_original()?;
    let (preferred, fallback) = if rules.content_field_redacts {
        (&original.content.redacts, &original.redacts)
    } else {
        (&original.redacts, &original.content.redacts)
    };
    preferred.clone().or_else(|| fallback.clone())
}

async fn edit_is_valid(cache: &RoomEventCache, target: &EventId, edit: &TimelineEvent) -> bool {
    match cache.find_event(target).await {
        Ok(Some(original)) => valid_replacements(&original, std::slice::from_ref(edit))
            .next()
            .is_some(),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::room_version_rules::RedactionRules;
    use matrix_sdk::ruma::{
        EventId, event_id, events::room::message::RoomMessageEventContentWithoutRelation, room_id,
        user_id,
    };
    use matrix_sdk::test_utils::mocks::{MatrixMockServer, RoomMessagesResponseTemplate};
    use matrix_sdk_test::{JoinedRoomBuilder, async_test, event_factory::EventFactory};
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Duration;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    use super::MessageIndex;
    use super::crawl::{CrawlBatch, CrawlOutcome};

    pub(super) fn in_room(
        index: &MessageIndex,
        room_id: &matrix_sdk::ruma::OwnedRoomId,
        query: &str,
        limit: usize,
        offset: usize,
    ) -> Vec<super::Hit> {
        index.search(
            query,
            &super::IndexFilter {
                rooms: vec![room_id.clone()],
                ..super::IndexFilter::default()
            },
            crate::api::search::SearchOrder::Rank,
            limit,
            offset,
        )
    }

    async fn reingest_whole_room(
        index: &mut MessageIndex,
        cache: &matrix_sdk::event_cache::RoomEventCache,
        room_id: &matrix_sdk::ruma::OwnedRoomId,
    ) {
        let events = cache.events().await.expect("cached events");
        index
            .ingest(room_id, events, cache, &RedactionRules::V11)
            .await;
    }

    async fn wait_for_hits(
        core: &crate::Core,
        room_id: &matrix_sdk::ruma::OwnedRoomId,
        query: &str,
        count: usize,
    ) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while in_room(
                &*core.search_index.lock().await,
                room_id,
                query,
                count + 1,
                0,
            )
            .len()
                != count
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("search index caught up");
    }

    pub(super) fn document(
        seed: &str,
        body: &str,
        sender: &str,
        ts: u64,
        attachment: Option<super::SearchAttachment>,
        mentions: Vec<matrix_sdk::ruma::OwnedUserId>,
    ) -> super::Document {
        super::Document {
            event_id: EventId::parse(format!("${seed}")).expect("event id"),
            has_link: super::document::contains_link(body),
            body: body.to_owned(),
            folded: String::new(),
            sender: matrix_sdk::ruma::UserId::parse(sender).expect("user id"),
            origin_server_ts: ts,
            attachments: attachment.into_iter().collect(),
            mentions,
            in_thread: false,
            edited_at: None,
            media: Vec::new(),
            state: false,
        }
    }

    fn restored_from(documents: Vec<super::Document>) -> super::persist::Restored {
        let count = documents.len();
        super::persist::Restored {
            manifest: super::persist::Manifest::new(
                1,
                vec![super::persist::ChunkEntry {
                    id: 0,
                    start: 0,
                    bytes: 0,
                    count,
                }],
                Vec::new(),
                0,
            ),
            loaded: vec![(0, super::persist::StoredChunk::new(documents, Vec::new()))],
            legacy: false,
        }
    }

    #[async_test]
    async fn test_chinese_search_survives_restore() {
        super::tokenize::load_bundled_chinese();
        let room = room_id!("!chinese:localhost").to_owned();
        let document = document(
            "chinese",
            "今天我们一起讨论中文搜索功能，然后测试加密房间里的消息索引。",
            "@erwan:localhost",
            1_000,
            None,
            Vec::new(),
        );
        let mut fresh = super::RoomIndex::new();
        fresh.upsert(document.clone());
        let restored = super::RoomIndex::restored(restored_from(vec![document])).await;

        for room_index in [fresh, restored] {
            let mut index = MessageIndex::new();
            index.rooms.insert(room.clone(), room_index);
            for query in ["中文", "搜索", "功能", "加密", "消息", "索引"] {
                assert_eq!(
                    found(&index, query, &super::IndexFilter::default()),
                    ["$chinese"],
                    "missing Chinese search result for {query:?}"
                );
            }
            assert_eq!(
                found(&index, "天气", &super::IndexFilter::default()),
                [] as [String; 0]
            );
        }
    }

    #[async_test]
    async fn test_pending_chinese_reindex() {
        super::tokenize::load_bundled_chinese();
        let room = room_id!("!pending-chinese:localhost").to_owned();
        let mut room_index = super::RoomIndex::new();
        room_index.upsert(document(
            "pending",
            "稍后搜索中文消息",
            "@erwan:localhost",
            1_000,
            None,
            Vec::new(),
        ));
        // Simulate indexing before the dictionary is available.
        room_index.index = probly_search::Index::new(super::BODY_FIELD_COUNT);
        room_index
            .chinese_pending
            .extend(room_index.documents.keys().copied());
        let revision = room_index.revision;
        let mut index = MessageIndex::new();
        index.rooms.insert(room.clone(), room_index);
        assert!(index.chinese_pending());
        assert_eq!(
            found(&index, "搜索", &super::IndexFilter::default()),
            [] as [String; 0]
        );

        index.refresh_chinese().await;

        assert!(!index.chinese_pending());
        assert_eq!(index.revision(&room), revision);
        assert_eq!(
            found(&index, "搜索", &super::IndexFilter::default()),
            ["$pending"]
        );
    }

    pub(super) fn filtered_index() -> (MessageIndex, matrix_sdk::ruma::OwnedRoomId) {
        let room = matrix_sdk::ruma::RoomId::parse("!filters:localhost").expect("room id");
        let mut index = MessageIndex::new();
        let room_index = index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new);

        room_index.upsert(document(
            "erwan",
            "the deploy pipeline is broken",
            "@erwan:localhost",
            1_000,
            None,
            Vec::new(),
        ));
        room_index.upsert(document(
            "alice",
            "deploy finished, see https://example.org/build",
            "@alice:localhost",
            2_000,
            None,
            vec![matrix_sdk::ruma::user_id!("@erwan:localhost").to_owned()],
        ));
        room_index.upsert(document(
            "screenshot",
            "deploy screenshot.png",
            "@alice:localhost",
            3_000,
            Some(super::SearchAttachment::Image),
            Vec::new(),
        ));

        (index, room)
    }

    pub(super) fn picture(seed: &str, sender: &str, ts: u64) -> super::Document {
        super::Document {
            media: vec![(
                None,
                crate::protocol::RoomAttachmentContentView::Image {
                    filename: format!("{seed}.png"),
                    source: format!("mxc://localhost/{seed}"),
                    mime: None,
                    width: None,
                    height: None,
                    blurhash: None,
                    thumbnail: None,
                    spoiler: None,
                },
            )],
            ..document(
                seed,
                &format!("{seed}.png"),
                sender,
                ts,
                Some(super::SearchAttachment::Image),
                Vec::new(),
            )
        }
    }

    pub(super) fn attachment_pages(
        index: &MessageIndex,
        room: &matrix_sdk::ruma::RoomId,
        not_senders: &[matrix_sdk::ruma::OwnedUserId],
        limit: usize,
    ) -> Vec<Vec<String>> {
        attachment_pages_with(index, room, not_senders, limit, &mut |_| None)
    }

    pub(super) fn attachment_pages_with(
        index: &MessageIndex,
        room: &matrix_sdk::ruma::RoomId,
        not_senders: &[matrix_sdk::ruma::OwnedUserId],
        limit: usize,
        load: &mut dyn FnMut(super::persist::ChunkId) -> Option<super::persist::StoredChunk>,
    ) -> Vec<Vec<String>> {
        let mut pages = Vec::new();
        let mut work = super::index::PageWork::default();
        let mut before: Option<(u64, matrix_sdk::ruma::OwnedEventId)> = None;
        loop {
            let step = index.attachment_page(
                room,
                crate::protocol::RoomAttachmentKind::Media,
                not_senders,
                before
                    .as_ref()
                    .map(|(ts, event_id)| (*ts, event_id.as_str())),
                limit,
                &work,
            );
            let (items, next) = match step {
                super::index::PageStep::Done(items, next) => (items, next),
                super::index::PageStep::Hydrate(_) => panic!("unexpected hydrate step"),
                super::index::PageStep::Need(chunk) => {
                    let stored = load(chunk).expect("stored chunk");
                    work.loaded.insert(chunk, stored);
                    continue;
                }
            };
            pages.push(
                items
                    .into_iter()
                    .map(|item| item.event_id.to_string())
                    .collect(),
            );
            match next {
                Some(cursor) => before = Some(cursor),
                None => return pages,
            }
        }
    }

    #[async_test]
    async fn test_a_restored_index_lists_media_without_the_event_cache() {
        let room = matrix_sdk::ruma::RoomId::parse("!pictures:localhost").expect("room id");
        let mut index = MessageIndex::new();
        index.rooms.insert(
            room.clone(),
            super::RoomIndex::restored(restored_from(vec![picture(
                "beach",
                "@erwan:localhost",
                1,
            )]))
            .await,
        );

        let super::index::PageStep::Done(items, next) = index.attachment_page(
            &room,
            crate::protocol::RoomAttachmentKind::Media,
            &[],
            None,
            10,
            &super::index::PageWork::default(),
        ) else {
            panic!("nothing is cold");
        };
        assert!(next.is_none());
        assert!(matches!(
            items.as_slice(),
            [crate::protocol::RoomAttachmentView {
                content: crate::protocol::RoomAttachmentContentView::Image { source, .. },
                ..
            }] if source == "mxc://localhost/beach"
        ));
    }

    #[test]
    fn test_a_hit_carries_its_indexed_neighbours_minus_ignored_senders() {
        let (mut index, room) = filtered_index();
        index
            .rooms
            .get_mut(&room)
            .expect("room index")
            .upsert(document(
                "troll",
                "noise",
                "@troll:localhost",
                2_500,
                None,
                Vec::new(),
            ));
        let mut hits = index.search(
            "pipeline",
            &super::IndexFilter::default(),
            crate::api::search::SearchOrder::Rank,
            10,
            0,
        );
        hits.extend(index.search(
            "finished",
            &super::IndexFilter::default(),
            crate::api::search::SearchOrder::Rank,
            10,
            0,
        ));

        index.fill_context(
            &mut hits,
            &[matrix_sdk::ruma::user_id!("@troll:localhost").to_owned()],
            1,
        );

        let ids = |lines: &[super::ContextLine]| {
            lines
                .iter()
                .map(|line| line.event_id.to_string())
                .collect::<Vec<_>>()
        };
        assert!(hits[0].before.is_empty());
        assert_eq!(ids(&hits[0].after), ["$alice"]);
        assert_eq!(ids(&hits[1].before), ["$erwan"]);
        assert_eq!(ids(&hits[1].after), ["$screenshot"]);
    }

    pub(super) fn found(
        index: &MessageIndex,
        query: &str,
        filter: &super::IndexFilter,
    ) -> Vec<String> {
        index
            .search(query, filter, crate::api::search::SearchOrder::Rank, 20, 0)
            .into_iter()
            .map(|hit| hit.event_id.to_string())
            .collect()
    }

    #[test]
    fn test_a_cache_refill_costs_nothing_when_the_index_already_holds_it() {
        use super::{MessageIndex, RoomIndex};
        use matrix_sdk::deserialized_responses::TimelineEvent;

        let room_id = room_id!("!refilled:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@a:b.c"));
        let events: Vec<TimelineEvent> = ["one", "two"]
            .iter()
            .enumerate()
            .map(|(index, body)| {
                TimelineEvent::from_plaintext(
                    factory
                        .text_msg(*body)
                        .event_id(&EventId::parse(format!("$refill{index}")).expect("an event id"))
                        .into_raw_sync(),
                )
            })
            .collect();

        let mut index = MessageIndex::new();
        index
            .rooms
            .entry(room_id.clone())
            .or_insert_with(RoomIndex::new);

        assert_eq!(index.unclassified(&room_id, events.clone()).len(), 2);

        for event in &events {
            index
                .rooms
                .get_mut(&room_id)
                .expect("the room")
                .mark_classified(event.event_id().expect("an event id").to_owned(), 0);
        }

        assert!(index.unclassified(&room_id, events).is_empty());
    }

    #[async_test]
    async fn test_a_room_with_no_new_activity_is_indexed_from_its_persisted_cache() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!quiet:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("archived thought")
                        .event_id(event_id!("$archived")),
                ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-prime",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;

        let index = core.search_index.lock().await;
        assert_eq!(
            in_room(&index, &room_id, "archived", 10, 0).len(),
            1,
            "a room with no new activity must be indexed from its persisted cache"
        );
        drop(index);
        drop(room);
    }

    #[async_test]
    async fn test_search_watcher_releases_paginated_room_cache() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!retention:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous")
                    .add_timeline_event(factory.text_msg("latest").event_id(event_id!("$latest"))),
            )
            .await;
        let (cache, _handles) = client.event_cache().unwrap().room(&room_id).await.unwrap();
        let (_, foreground) = cache.subscribe().await.unwrap();
        let (core, _events) = crate::Core::new(
            "search-retention",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.foreground_paginations
            .store(1, std::sync::atomic::Ordering::Relaxed);
        core.watch_search_index(&client, "");
        wait_for_hits(&core, &room_id, "latest", 1).await;

        let history = (0..300)
            .map(|index| {
                factory
                    .text_msg("archaeology")
                    .event_id(&EventId::parse(format!("$history{index}")).unwrap())
            })
            .collect();
        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default().events(history))
            .mock_once()
            .mount()
            .await;
        cache.pagination().run_backwards_once(300).await.unwrap();
        wait_for_hits(&core, &room_id, "archaeology", 300).await;
        let loaded = cache.events().await.unwrap().len();
        assert_eq!(loaded, 301);
        drop(foreground);
        tokio::time::timeout(Duration::from_secs(5), async {
            while cache.events().await.unwrap().len() >= loaded {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("search must not pin the paginated SDK cache");
        assert_eq!(
            in_room(
                &*core.search_index.lock().await,
                &room_id,
                "archaeology",
                400,
                0
            )
            .len(),
            300
        );

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("subsequent")
                        .event_id(event_id!("$subsequent")),
                ),
            )
            .await;
        wait_for_hits(&core, &room_id, "subsequent", 1).await;
        core.session_tasks.lock().clear();
    }

    #[async_test]
    async fn test_back_pagination_reaches_the_index_and_notifies_it() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!backfill:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous")
                    .add_timeline_event(
                        factory
                            .text_msg("latest deploy")
                            .event_id(event_id!("$latest")),
                    ),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");

        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;
        assert!(
            in_room(&index, &room_id, "archaeology", 10, 0).is_empty(),
            "the older message is not in the cache yet"
        );

        let mut updates = client
            .event_cache()
            .unwrap()
            .subscribe_to_room_generic_updates();

        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default().events(vec![
                factory
                    .text_msg("older archaeology")
                    .event_id(event_id!("$older")),
            ]))
            .mock_once()
            .mount()
            .await;

        let timeline = crate::timelines::build_room_timeline(
            &room,
            &crate::api::timeline::TimelineFocusView::Live,
            false,
        )
        .await
        .expect("timeline");
        timeline.paginate_backwards(10).await.expect("paginate");

        let notified = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(update) = updates.recv().await
                    && update.room_id == room_id
                {
                    return true;
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(notified, "back-pagination must wake the indexer");

        reingest_whole_room(&mut index, &cache, &room_id).await;

        let hits = in_room(&index, &room_id, "archaeology", 10, 0);
        assert_eq!(hits.len(), 1, "the backfilled message must be searchable");
        assert_eq!(hits[0].event_id, event_id!("$older"));
    }

    #[async_test]
    async fn test_an_encrypted_rooms_plaintext_is_searchable_and_edits_replace_the_body() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!search:localhost").to_owned();
        let original_id = event_id!("$original");
        let edit_id = event_id!("$edit");

        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("the deploy pipeline is broken")
                        .event_id(original_id),
                ),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;

        let hits = in_room(&index, &room_id, "deploying", 10, 0);
        assert_eq!(hits.len(), 1, "{hits:?}", hits = hits.len());
        assert_eq!(hits[0].event_id, original_id);

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("* the rollback finished")
                        .edit(
                            original_id,
                            RoomMessageEventContentWithoutRelation::text_plain(
                                "the rollback finished",
                            ),
                        )
                        .event_id(edit_id),
                ),
            )
            .await;

        reingest_whole_room(&mut index, &cache, &room_id).await;

        assert!(
            in_room(&index, &room_id, "deploying", 10, 0).is_empty(),
            "an edited message must not still match its old body"
        );

        let hits = in_room(&index, &room_id, "rollback", 10, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].event_id, original_id);
        assert_eq!(hits[0].body, "the rollback finished");

        drop(room);
    }

    #[async_test]
    async fn test_an_edit_crawled_before_its_original_keeps_the_new_body() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!crawl:localhost").to_owned();
        let original_id = event_id!("$original");
        let edit_id = event_id!("$edit");

        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        let (cache, _drop) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");

        let crawled = vec![
            factory
                .text_msg("* the rollback finished")
                .edit(
                    original_id,
                    RoomMessageEventContentWithoutRelation::text_plain("the rollback finished"),
                )
                .event_id(edit_id)
                .into_event(),
            factory
                .text_msg("the deploy pipeline is broken")
                .event_id(original_id)
                .into_event(),
        ];

        let mut index = MessageIndex::new();
        index
            .ingest(&room_id, crawled, &cache, &RedactionRules::V11)
            .await;

        assert!(
            in_room(&index, &room_id, "deploying", 10, 0).is_empty(),
            "the pre-edit body must not win just because it was crawled last"
        );

        let hits = in_room(&index, &room_id, "rollback", 10, 0);
        assert_eq!(hits.len(), 1, "{hits:?}", hits = hits.len());
        assert_eq!(hits[0].event_id, original_id);
        assert_eq!(hits[0].body, "the rollback finished");

        drop(room);
    }

    #[async_test]
    async fn test_a_thread_reply_is_marked_and_keeps_the_mark_through_an_edit() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!threads:localhost").to_owned();
        let thread_root = event_id!("$root");
        let reply_id = event_id!("$reply");

        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));
        let (cache, _drop) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");

        let events = vec![
            factory
                .text_msg("the deploy pipeline is broken")
                .event_id(thread_root)
                .into_event(),
            factory
                .text_msg("deploy retried")
                .in_thread(thread_root, thread_root)
                .event_id(reply_id)
                .into_event(),
            factory
                .text_msg("* deploy retried twice")
                .edit(
                    reply_id,
                    RoomMessageEventContentWithoutRelation::text_plain("deploy retried twice"),
                )
                .event_id(event_id!("$reply-edit"))
                .into_event(),
        ];

        let mut index = MessageIndex::new();
        index
            .ingest(&room_id, events, &cache, &RedactionRules::V11)
            .await;

        let threaded = |wanted| {
            index
                .search(
                    "deploy",
                    &super::IndexFilter {
                        in_thread: Some(wanted),
                        ..super::IndexFilter::default()
                    },
                    crate::api::search::SearchOrder::Rank,
                    10,
                    0,
                )
                .into_iter()
                .map(|hit| hit.event_id.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(threaded(true), vec!["$reply"]);
        assert_eq!(threaded(false), vec!["$root"]);

        drop(room);
    }

    #[async_test]
    async fn test_a_redaction_drops_the_message_from_the_index() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!redact:localhost").to_owned();
        let target_id = event_id!("$target");

        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_timeline_event(factory.text_msg("regrettable").event_id(target_id)),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;
        assert_eq!(in_room(&index, &room_id, "regrettable", 10, 0).len(), 1);

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .redaction(target_id)
                        .event_id(event_id!("$redaction")),
                ),
            )
            .await;

        reingest_whole_room(&mut index, &cache, &room_id).await;

        assert!(
            in_room(&index, &room_id, "regrettable", 10, 0).is_empty(),
            "a redacted message must leave no indexed body behind"
        );

        drop(room);
    }

    #[async_test]
    async fn test_pagination_walks_one_ordering_without_repeating_a_hit() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!paging:localhost").to_owned();
        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        let ids = ["$page0", "$page1", "$page2", "$page3", "$page4"];
        let mut builder = JoinedRoomBuilder::new(&room_id);
        for (position, raw_id) in ids.iter().enumerate() {
            let id = EventId::parse(*raw_id).expect("test event id");
            builder = builder.add_timeline_event(
                factory
                    .text_msg(format!("paginate this {position}"))
                    .event_id(&id),
            );
        }
        server.sync_room(&client, builder).await;

        let (cache, _drop) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;

        let ids =
            |hits: Vec<super::Hit>| hits.into_iter().map(|hit| hit.event_id).collect::<Vec<_>>();

        let first = ids(in_room(&index, &room_id, "paginate", 2, 0));
        let second = ids(in_room(&index, &room_id, "paginate", 2, 2));
        let last = ids(in_room(&index, &room_id, "paginate", 2, 4));
        assert_eq!(first.len(), 2);
        assert_eq!(second.len(), 2);
        assert_eq!(last.len(), 1, "five matches paged two at a time");

        let mut walked: Vec<_> = first.iter().chain(&second).chain(&last).cloned().collect();
        let seen = walked.len();
        walked.sort();
        walked.dedup();
        assert_eq!(walked.len(), seen, "paging repeated a hit");

        assert_eq!(
            first,
            ids(in_room(&index, &room_id, "paginate", 2, 0)),
            "the same page must come back twice"
        );

        drop(room);
    }

    #[async_test]
    async fn test_leaving_a_room_forgets_its_documents() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!forget:localhost").to_owned();
        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_timeline_event(factory.text_msg("secret").event_id(event_id!("$secret"))),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;
        assert_eq!(in_room(&index, &room_id, "secret", 10, 0).len(), 1);

        index.forget_room(&room_id);

        assert!(in_room(&index, &room_id, "secret", 10, 0).is_empty());
        assert!(
            index
                .search(
                    "secret",
                    &super::IndexFilter::default(),
                    crate::api::search::SearchOrder::Rank,
                    10,
                    0,
                )
                .is_empty()
        );

        drop(room);
    }

    fn persisted(index: &mut super::RoomIndex) {
        let flush = index.take_flush();
        for (chunk, stored) in flush.chunks {
            index
                .chunk_meta
                .insert(chunk, (1_000, stored.documents.len()));
        }
    }

    pub(super) fn budgeted_room(count: usize, from: u64) -> super::RoomIndex {
        let mut index = super::RoomIndex::new();
        for seed in 0..count {
            let ts = from + seed as u64;
            index.upsert(document(
                &format!("d{ts}"),
                &format!("deploy note w{ts}"),
                "@erwan:localhost",
                ts,
                None,
                Vec::new(),
            ));
        }
        persisted(&mut index);
        index
    }

    #[test]
    fn test_a_cold_chunk_with_nothing_left_to_scan_finds_nothing() {
        let room = room_id!("!room:localhost").to_owned();
        let mut index = MessageIndex::new();
        index.rooms.insert(room.clone(), super::RoomIndex::new());
        let filter = super::IndexFilter::default();
        let stored = super::persist::StoredChunk::new(Vec::new(), Vec::new());

        let (hits, total) = index.scan_cold(
            &room,
            &stored,
            "deploy",
            &filter,
            &super::document::FoldedTerms::of(&filter, std::collections::HashSet::new()),
            super::index::ColdWindow::all(1),
        );

        assert!(hits.is_empty());
        assert_eq!(total, 0);
    }

    #[async_test]
    async fn test_a_redaction_of_an_unloaded_message_is_purged_from_disk() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room = room_id!("!purge:localhost").to_owned();
        let (core, _events) = crate::Core::new(
            "search-cold-purge",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        {
            let mut index = core.search_index.lock().await;
            *index = MessageIndex::with_budgets(usize::MAX, u64::MAX);
            let mut room_index = super::RoomIndex::new();
            seed_room(&mut room_index, 3_000);
            index.rooms.insert(room.clone(), room_index);
        }
        core.flush_search_index(&client).await;

        let oldest = {
            let mut index = core.search_index.lock().await;
            let room_index = index.rooms.get_mut(&room).expect("room");
            let oldest = *room_index.chunks.values().next().expect("a chunk");
            room_index.unload(oldest);
            room_index.forget_message(&event_id!("$s0").to_owned());
            oldest
        };
        core.flush_search_index(&client).await;

        let super::persist::ChunkRead::Found(stored) =
            super::persist::load_chunk(&client, &room, oldest).await
        else {
            panic!("missing chunk");
        };
        assert!(
            stored
                .documents
                .iter()
                .all(|document| document.event_id != event_id!("$s0"))
        );
        assert!(stored.documents.len() > 100);
        let index = core.search_index.lock().await;
        assert!(index.rooms[&room].pending_redactions.is_empty());
    }

    #[async_test]
    async fn test_older_pages_search_what_is_only_on_disk() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room = room_id!("!older:localhost").to_owned();
        let core = logged_in(&server, &client, "search-older").await;
        {
            let mut index = core.search_index.lock().await;
            *index = MessageIndex::with_budgets(usize::MAX, u64::MAX);
            let mut room_index = super::RoomIndex::new();
            for seed in 0..3_000_u64 {
                room_index.upsert(document(
                    &format!("o{seed}"),
                    &format!("archive entry w{seed}x"),
                    "@erwan:localhost",
                    seed,
                    None,
                    Vec::new(),
                ));
            }
            index.rooms.insert(room.clone(), room_index);
        }
        core.flush_search_index(&client).await;
        {
            let mut index = core.search_index.lock().await;
            let room_index = index.rooms.get_mut(&room).expect("room");
            let oldest = *room_index.chunks.values().next().expect("a chunk");
            room_index.unload(oldest);
        }
        let filter = super::IndexFilter::default();

        let hot = core
            .search_messages(
                "w1x",
                &filter,
                crate::api::search::SearchOrder::Rank,
                30,
                0,
                0,
            )
            .await;
        assert!(hot.is_empty());
        let start = core
            .older_start(&filter)
            .await
            .expect("a cold chunk is in scope");

        let (older, next) = core
            .search_older(
                "w1x",
                &filter,
                crate::api::search::SearchOrder::Rank,
                30,
                &start,
                1,
            )
            .await;
        assert_eq!(
            older
                .iter()
                .map(|hit| hit.event_id.as_str())
                .collect::<Vec<_>>(),
            ["$o1"]
        );
        assert_eq!(older[0].before[0].event_id, event_id!("$o0"));
        assert_eq!(older[0].after[0].event_id, event_id!("$o2"));
        assert!(next.is_none());
    }

    #[tokio::test]
    async fn test_an_older_page_is_capped_and_resumes_inside_the_chunk() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let core = logged_in(&server, &client, "search-older-cap").await;
        let rooms = [
            room_id!("!older-cap-a:localhost").to_owned(),
            room_id!("!older-cap-b:localhost").to_owned(),
        ];
        {
            let mut index = core.search_index.lock().await;
            *index = MessageIndex::with_budgets(usize::MAX, u64::MAX);
            for (offset, room) in rooms.iter().enumerate() {
                let mut room_index = super::RoomIndex::new();
                for seed in 0..3_000_u64 {
                    room_index.upsert(document(
                        &format!("{offset}c{seed}"),
                        &format!("archive entry w{seed}x"),
                        "@erwan:localhost",
                        seed * 2 + offset as u64,
                        None,
                        Vec::new(),
                    ));
                }
                index.rooms.insert(room.clone(), room_index);
            }
        }
        core.flush_search_index(&client).await;
        let mut cold = 0;
        {
            let mut index = core.search_index.lock().await;
            for room in &rooms {
                let room_index = index.rooms.get_mut(room).expect("room");
                let chunks: Vec<_> = room_index.chunks.values().copied().collect();
                for chunk in chunks.iter().take(chunks.len() - 1) {
                    room_index.unload(*chunk);
                }
                cold += room_index.documents.len();
            }
        }
        let on_disk = 6_000 - cold;
        assert!(on_disk > 100);

        for (query, scope) in [
            ("", vec![rooms[0].clone()]),
            ("", rooms.to_vec()),
            ("archive", vec![rooms[0].clone()]),
            ("archive", Vec::new()),
        ] {
            for order in [
                crate::api::search::SearchOrder::Rank,
                crate::api::search::SearchOrder::Recent,
                crate::api::search::SearchOrder::Oldest,
            ] {
                let filter = super::IndexFilter {
                    rooms: scope.clone(),
                    ..super::IndexFilter::default()
                };
                let mut cursor = core.older_start(&filter).await.expect("a cold chunk");
                let mut seen = std::collections::HashSet::new();
                loop {
                    let (page, next) = core
                        .search_older(query, &filter, order, 30, &cursor, 0)
                        .await;
                    assert!(page.len() <= 30, "{query:?} {order:?}: {} hits", page.len());
                    for hit in &page {
                        assert!(
                            seen.insert(hit.event_id.clone()),
                            "{query:?} {order:?}: {} repeated",
                            hit.event_id
                        );
                    }
                    let Some(next) = next else { break };
                    cursor = next;
                }
                let expected =
                    on_disk / 2 * scope.len().max(1) * if scope.is_empty() { 2 } else { 1 };
                assert_eq!(seen.len(), expected, "{query:?} {order:?} {}", scope.len());
            }
        }
    }

    #[test]
    fn test_the_disk_budget_drops_the_oldest_chunk_and_raises_the_floor() {
        let room = matrix_sdk::ruma::RoomId::parse("!disk:localhost").expect("room id");
        let room_index = budgeted_room(3_000, 0);
        let chunks = room_index.chunks.len();
        assert!(chunks > 2);
        let mut index = MessageIndex::with_budgets(usize::MAX, 1_000 * (chunks - 1) as u64);
        index.rooms.insert(room.clone(), room_index);

        let (victim_room, chunk, next) = index.disk_victim().expect("over the disk budget");
        assert_eq!(victim_room, room);
        index
            .rooms
            .get_mut(&room)
            .expect("room")
            .evict_oldest_chunk(chunk, next);

        let evicted = &index.rooms[&room];
        assert_eq!(evicted.floor, next);
        assert_eq!(evicted.chunks.len(), chunks - 1);
        assert_eq!(evicted.chunks.keys().next(), Some(&0));
        assert!(in_room(&index, &room, "w0", 10, 0).is_empty());
        assert!(index.disk_victim().is_none());
    }

    #[async_test]
    async fn test_one_older_page_keeps_scanning_until_it_finds_something() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room = room_id!("!deep:localhost").to_owned();
        let core = logged_in(&server, &client, "search-older-deep").await;

        let mut room_index = super::RoomIndex::new();
        for chunk in 0..10_u32 {
            let start = u64::from(chunk) * 100;
            let body = if chunk == 0 { "the needle" } else { "hay" };
            let stored = super::persist::StoredChunk::new(
                vec![document(
                    &format!("c{chunk}"),
                    body,
                    "@erwan:localhost",
                    start + 1,
                    None,
                    Vec::new(),
                )],
                Vec::new(),
            );
            assert!(
                super::persist::write_chunk(&client, &room, chunk, &stored)
                    .await
                    .is_some()
            );
            room_index.chunks.insert(start, chunk);
            room_index.chunk_meta.insert(chunk, (100, 1));
            room_index.cold.insert(chunk);
        }
        room_index.next_chunk = 10;
        core.search_index
            .lock()
            .await
            .rooms
            .insert(room.clone(), room_index);

        let filter = super::IndexFilter::default();
        let start = core
            .older_start(&filter)
            .await
            .expect("cold chunks in scope");
        let (hits, next) = core
            .search_older(
                "needle",
                &filter,
                crate::api::search::SearchOrder::Rank,
                30,
                &start,
                0,
            )
            .await;

        assert_eq!(
            hits.iter()
                .map(|hit| hit.event_id.as_str())
                .collect::<Vec<_>>(),
            ["$c0"]
        );
        assert!(next.is_none());
    }

    #[test]
    fn test_a_migrated_picture_without_media_asks_to_be_hydrated_once() {
        let room = matrix_sdk::ruma::RoomId::parse("!migrated:localhost").expect("room id");
        let mut index = MessageIndex::new();
        index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new)
            .upsert(document(
                "old",
                "beach.png",
                "@erwan:localhost",
                1,
                Some(super::SearchAttachment::Image),
                Vec::new(),
            ));
        let page = |tried: std::collections::HashSet<matrix_sdk::ruma::OwnedEventId>| {
            index.attachment_page(
                &room,
                crate::protocol::RoomAttachmentKind::Media,
                &[],
                None,
                10,
                &super::index::PageWork {
                    tried,
                    ..super::index::PageWork::default()
                },
            )
        };

        let super::index::PageStep::Hydrate(asked) = page(std::collections::HashSet::new()) else {
            panic!("expected a hydrate step");
        };
        assert_eq!(asked, [event_id!("$old").to_owned()]);

        assert!(
            matches!(page(asked.into_iter().collect()), super::index::PageStep::Done(items, None) if items.is_empty())
        );
    }

    #[async_test]
    async fn test_the_gallery_fills_in_media_for_a_migrated_message() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!hydrate:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    EventFactory::new()
                        .room(&room_id)
                        .sender(user_id!("@erwan:localhost"))
                        .image(
                            "beach.png".to_owned(),
                            matrix_sdk::ruma::owned_mxc_uri!("mxc://localhost/beach"),
                        )
                        .event_id(event_id!("$image")),
                ),
            )
            .await;
        let core = logged_in(&server, &client, "search-hydrate").await;
        core.search_index
            .lock()
            .await
            .rooms
            .entry(room_id.clone())
            .or_insert_with(super::RoomIndex::new)
            .upsert(document(
                "image",
                "beach.png",
                "@erwan:localhost",
                1,
                Some(super::SearchAttachment::Image),
                Vec::new(),
            ));

        let (items, _) = core
            .attachment_page(
                &room_id,
                crate::protocol::RoomAttachmentKind::Media,
                &[],
                None,
                10,
            )
            .await;

        assert!(matches!(
            items.as_slice(),
            [crate::protocol::RoomAttachmentView {
                content: crate::protocol::RoomAttachmentContentView::Image { source, .. },
                ..
            }] if source == "mxc://localhost/beach"
        ));
        let index = core.search_index.lock().await;
        let stored = index.rooms[&room_id]
            .document(&event_id!("$image").to_owned())
            .expect("still indexed");
        assert_eq!(stored.media.len(), 1);
        assert!(index.rooms[&room_id].dirty);
        drop(room);
    }

    #[test]
    fn test_redacting_an_unloaded_message_is_recorded_for_the_next_save() {
        let mut index = budgeted_room(3_000, 0);
        let oldest = *index.chunks.values().next().expect("a chunk");
        index.unload(oldest);

        index.forget_message(&event_id!("$d0").to_owned());

        assert!(index.pending_redactions.contains(event_id!("$d0")));
        assert!(index.dirty);
        let flush = index.take_flush();
        assert!(flush.scan.contains(&oldest));
        assert!(
            flush
                .manifest
                .pending_redactions
                .contains(&event_id!("$d0").to_owned())
        );
    }

    #[async_test]
    async fn test_the_crawl_resumes_from_the_checkpoint_it_persisted() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!resume:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"))
            .server_ts(super::now_ms());

        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous")
                    .add_timeline_event(factory.text_msg("latest").event_id(event_id!("$latest"))),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-resume",
            Box::new(crate::store::MemorySessionStore::default()),
        );

        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default()
                .end_token("page-two")
                .events(vec![
                    factory.text_msg("first page").event_id(event_id!("$one")),
                ]))
            .mock_once()
            .mount()
            .await;

        let reached_start = core
            .crawl_once(&client, &room_id)
            .await
            .expect("crawl one batch");
        assert!(
            matches!(
                reached_start,
                CrawlOutcome::Batch(CrawlBatch {
                    reached_start: false,
                    ..
                })
            ),
            "a room with a next token is not exhausted"
        );

        let checkpoints = core.search_crawl.lock().await.checkpoints();
        assert_eq!(
            checkpoints
                .get(&room_id)
                .and_then(|room| room.token.clone())
                .as_deref(),
            Some("page-two"),
            "the next page's token is what a reload has to resume from"
        );

        // A fresh core, as after a reload: it must ask for the second page.
        let (next, _next_events) = crate::Core::new(
            "search-resume",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        next.search_crawl.lock().await.restore(checkpoints);

        server
            .mock_room_messages()
            .match_from("page-two")
            .ok(RoomMessagesResponseTemplate::default().events(vec![
                factory.text_msg("second page").event_id(event_id!("$two")),
            ]))
            .mock_once()
            .mount()
            .await;

        let reached_start = next
            .crawl_once(&client, &room_id)
            .await
            .expect("crawl the resumed batch");
        assert!(
            matches!(
                reached_start,
                CrawlOutcome::Batch(CrawlBatch {
                    reached_start: true,
                    exhausted: true,
                    ..
                })
            ),
            "no next token means the room is done"
        );

        let hits = in_room(&*next.search_index.lock().await, &room_id, "second", 10, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].event_id, event_id!("$two"));

        drop(room);
    }

    #[async_test]
    async fn test_the_crawler_deepens_a_room_and_records_reaching_its_start() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!crawl:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"))
            .server_ts(super::now_ms());

        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous")
                    .add_timeline_event(
                        factory
                            .text_msg("latest deploy")
                            .event_id(event_id!("$latest")),
                    ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-crawl",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;
        assert!(
            in_room(
                &*core.search_index.lock().await,
                &room_id,
                "archaeology",
                10,
                0
            )
            .is_empty(),
            "nothing has paged back to the older message yet"
        );

        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default().events(vec![
                factory
                    .text_msg("older archaeology")
                    .event_id(event_id!("$older")),
            ]))
            .mock_once()
            .mount()
            .await;

        let reached_start = core
            .crawl_once(&client, &room_id)
            .await
            .expect("crawl one batch");

        let hits = in_room(
            &*core.search_index.lock().await,
            &room_id,
            "archaeology",
            10,
            0,
        );
        assert_eq!(hits.len(), 1, "the crawler must index what it paginated");
        assert_eq!(hits[0].event_id, event_id!("$older"));
        assert!(matches!(
            reached_start,
            CrawlOutcome::Batch(CrawlBatch {
                reached_start: true,
                ..
            })
        ));

        drop(room);
    }

    pub(super) fn seed_room(index: &mut super::RoomIndex, count: usize) {
        for seed in 0..count {
            index.upsert(document(
                &format!("s{seed}"),
                &format!("message {seed}"),
                "@erwan:localhost",
                seed as u64,
                None,
                Vec::new(),
            ));
        }
    }

    fn chunked_room(count: usize) -> super::RoomIndex {
        let mut index = super::RoomIndex::new();
        for seed in 0..count {
            index.upsert(document(
                &format!("m{seed}"),
                &format!("message {seed}"),
                "@erwan:localhost",
                seed as u64,
                None,
                Vec::new(),
            ));
        }
        index
    }

    #[test]
    fn test_a_flush_rewrites_only_the_chunk_that_changed() {
        let mut index = chunked_room(5_000);
        let first = index.take_flush();
        assert!(first.chunks.len() > 2);
        let mut written: Vec<String> = first
            .chunks
            .iter()
            .flat_map(|(_, chunk)| {
                chunk
                    .documents
                    .iter()
                    .map(|document| document.event_id.to_string())
            })
            .collect();
        written.sort();
        written.dedup();
        assert_eq!(written.len(), 5_000);

        index.upsert(document(
            "late",
            "a late message",
            "@erwan:localhost",
            10_000,
            None,
            Vec::new(),
        ));
        let second = index.take_flush();
        assert_eq!(second.chunks.len(), 1);
        assert!(
            second.chunks[0]
                .1
                .documents
                .iter()
                .any(|document| document.event_id == event_id!("$late"))
        );
    }

    #[test]
    fn test_a_removed_message_leaves_its_chunk_on_the_next_flush() {
        let mut index = chunked_room(3_000);
        index.take_flush();

        index.remove(&event_id!("$m10").to_owned());
        let flush = index.take_flush();
        assert_eq!(flush.chunks.len(), 1);
        assert!(
            flush.chunks[0]
                .1
                .documents
                .iter()
                .all(|document| document.event_id != event_id!("$m10"))
        );
    }

    #[async_test]
    async fn test_a_chunked_room_restores_every_document_and_classified_id() {
        let mut index = chunked_room(3_000);
        index.mark_classified(event_id!("$reaction").to_owned(), 1_500);
        let flush = index.take_flush();
        let restored = super::RoomIndex::restored(super::persist::Restored {
            manifest: flush.manifest,
            loaded: flush.chunks,
            legacy: false,
        })
        .await;

        assert_eq!(restored.len(), 3_000);
        assert!(restored.already_classified(event_id!("$reaction")));
        assert!(!restored.dirty);
    }

    #[test]
    fn test_a_plaintext_edit_cannot_rewrite_an_encrypted_message() {
        use matrix_sdk::deserialized_responses::{
            AlgorithmInfo, DecryptedRoomEvent, EncryptionInfo, TimelineEvent, VerificationState,
        };
        use serde_json::json;

        let original = json!({
            "type": "m.room.message",
            "event_id": "$original",
            "room_id": "!room:localhost",
            "sender": "@alice:localhost",
            "origin_server_ts": 1_000,
            "content": { "msgtype": "m.text", "body": "hello" }
        });
        let edit = TimelineEvent::from_plaintext(
            serde_json::from_value(json!({
                "type": "m.room.message",
                "event_id": "$edit",
                "sender": "@alice:localhost",
                "origin_server_ts": 2_000,
                "content": {
                    "msgtype": "m.text",
                    "body": "* forged",
                    "m.new_content": { "msgtype": "m.text", "body": "forged" },
                    "m.relates_to": { "rel_type": "m.replace", "event_id": "$original" }
                }
            }))
            .expect("edit"),
        );
        let encrypted = TimelineEvent::from_decrypted(
            DecryptedRoomEvent {
                event: serde_json::from_value(original.clone()).expect("original"),
                encryption_info: std::sync::Arc::new(EncryptionInfo {
                    sender: user_id!("@alice:localhost").to_owned(),
                    sender_device: None,
                    forwarder: None,
                    algorithm_info: AlgorithmInfo::MegolmV1AesSha2 {
                        curve25519_key: String::new(),
                        sender_claimed_keys: std::collections::BTreeMap::new(),
                        session_id: None,
                    },
                    verification_state: VerificationState::Verified,
                }),
                unsigned_encryption_info: None,
            },
            None,
        );
        let plain = TimelineEvent::from_plaintext(serde_json::from_value(original).expect("raw"));
        let redacted = std::collections::HashSet::new();

        let kept =
            super::document::edited_document(&encrypted, std::slice::from_ref(&edit), &redacted)
                .expect("a document");
        assert_eq!(kept.body, "hello");
        assert_eq!(kept.edited_at, None);

        let applied =
            super::document::edited_document(&plain, std::slice::from_ref(&edit), &redacted)
                .expect("a document");
        assert_eq!(applied.body, "forged");
    }

    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "one sequential corpus kept in a single function"
    )]
    fn test_ingest_output_matches_the_golden_corpus() {
        use matrix_sdk::ruma::{
            events::{AnySyncMessageLikeEvent, AnySyncStateEvent, AnySyncTimelineEvent},
            serde::Raw,
        };
        use serde_json::json;

        let encrypted = json!({
            "hashes": { "sha256": "LddWbhqio1QFowJZotQFXzsDBdJpipd5OhiY1jKLv0M" },
            "iv": "38FDuSh6tsgAAAAAAAAAAA",
            "key": {
                "alg": "A256CTR",
                "ext": true,
                "k": "iClvSnBe_h01iKMzGdeyDrWSmSZ0Omhy-9tc5m7Ra6s",
                "key_ops": ["decrypt", "encrypt"],
                "kty": "oct"
            },
            "url": "mxc://localhost/statuts",
            "v": "v2"
        });
        let messages = [
            json!({
                "msgtype": "m.text",
                "body": "see https://example.org/a now",
                "m.mentions": { "user_ids": ["@erwan:localhost"] }
            }),
            json!({
                "msgtype": "m.image",
                "body": "beach.png",
                "url": "mxc://localhost/beach",
                "info": { "mimetype": "image/png", "w": 640, "h": 480, "size": 1024 },
                "page.codeberg.everypizza.msc4193.spoiler": true
            }),
            json!({
                "msgtype": "m.file",
                "body": "notes.pdf",
                "url": "mxc://localhost/notes",
                "info": { "mimetype": "application/pdf", "size": 4096 }
            }),
            json!({
                "msgtype": "m.audio",
                "body": "memo.ogg",
                "url": "mxc://localhost/memo",
                "info": { "mimetype": "audio/ogg", "size": 2048 }
            }),
            json!({
                "msgtype": "m.text",
                "body": "> <@erwan:localhost> see https://example.org/a now\n\nreply text",
                "m.relates_to": {
                    "rel_type": "m.thread",
                    "event_id": "$golden0",
                    "m.in_reply_to": { "event_id": "$golden0" },
                    "is_falling_back": true
                }
            }),
            json!({
                "msgtype": "dm.filament.gallery",
                "body": "",
                "itemtypes": [
                    { "itemtype": "m.image", "body": "dune.png", "url": "mxc://localhost/dune" },
                    {
                        "itemtype": "m.file",
                        "body": "statuts.pdf",
                        "info": { "mimetype": "application/pdf", "size": 86253 },
                        "file": encrypted
                    }
                ]
            }),
        ];
        let event = |position: usize, kind: &str, content: serde_json::Value| {
            let raw: Raw<AnySyncTimelineEvent> = serde_json::from_value(json!({
                "type": kind,
                "event_id": format!("$golden{position}"),
                "sender": "@erwan:localhost",
                "origin_server_ts": 1_000 + position,
                "content": content,
            }))
            .expect("event");
            matrix_sdk::deserialized_responses::TimelineEvent::from_plaintext(raw)
        };

        let mut documents: Vec<serde_json::Value> = messages
            .into_iter()
            .enumerate()
            .map(|(position, content)| {
                let event = event(position, "m.room.message", content);
                let (message, content) =
                    super::document::room_message(&event).expect("a room message");
                serde_json::to_value(super::document::document_of(&message, content.as_ref()))
                    .expect("document json")
            })
            .collect();

        let original = event(
            0,
            "m.room.message",
            json!({ "msgtype": "m.text", "body": "see" }),
        );
        let (original, original_content) =
            super::document::room_message(&original).expect("an original");
        let edit = event(
            6,
            "m.room.message",
            json!({
                "msgtype": "m.text",
                "body": "* see https://example.org/b",
                "m.new_content": {
                    "msgtype": "m.text",
                    "body": "see https://example.org/b",
                    "m.mentions": { "user_ids": ["@alice:localhost"] }
                },
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$golden0" }
            }),
        );
        let (edit, edit_content) = super::document::room_message(&edit).expect("an edit");
        let replacement = super::replacement_of(&edit).expect("a replacement");
        documents.push(
            serde_json::to_value(super::document::with_edit(
                super::document::document_of(&original, original_content.as_ref()),
                &edit,
                replacement,
                edit_content.as_ref(),
            ))
            .expect("edit json"),
        );
        documents.push(
            serde_json::to_value(super::document::provisional_edit(
                &edit,
                event_id!("$golden0").to_owned(),
            ))
            .expect("provisional json"),
        );

        let poll: AnySyncMessageLikeEvent = serde_json::from_value(json!({
            "type": "org.matrix.msc3381.poll.start",
            "event_id": "$golden8",
            "sender": "@erwan:localhost",
            "origin_server_ts": 1_008,
            "content": {
                "org.matrix.msc3381.poll.start": {
                    "question": { "org.matrix.msc1767.text": "Lunch spot?" },
                    "kind": "org.matrix.msc3381.poll.disclosed",
                    "max_selections": 1,
                    "answers": [
                        { "id": "a", "org.matrix.msc1767.text": "Ramen" },
                        { "id": "b", "org.matrix.msc1767.text": "Tacos" }
                    ]
                },
                "org.matrix.msc1767.text": "Lunch spot?\n1. Ramen\n2. Tacos"
            }
        }))
        .expect("a poll start");
        documents.push(
            serde_json::to_value(
                super::document::poll_start_document(&poll).expect("a poll document"),
            )
            .expect("poll json"),
        );

        let sticker: matrix_sdk::ruma::events::sticker::OriginalSyncStickerEvent =
            serde_json::from_value(json!({
                "type": "m.sticker",
                "event_id": "$golden9",
                "sender": "@erwan:localhost",
                "origin_server_ts": 1_009,
                "content": { "body": "moai", "info": {}, "url": "mxc://localhost/moai" }
            }))
            .expect("a sticker");
        documents.push(
            serde_json::to_value(super::document::sticker_document(&sticker))
                .expect("sticker json"),
        );

        let topic =
            json!({ "topic": "Design crew", "m.topic": { "m.text": [{ "body": "ignored" }] } });
        let state: AnySyncStateEvent = serde_json::from_value(json!({
            "type": "m.room.topic",
            "event_id": "$golden10",
            "state_key": "",
            "sender": "@erwan:localhost",
            "origin_server_ts": 1_010,
            "content": topic
        }))
        .expect("a state event");
        documents.push(
            serde_json::to_value(super::document::state_document(&state, Some(&topic)))
                .expect("state json"),
        );

        let expected: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("golden_documents.json")).expect("golden json");
        assert_eq!(
            documents, expected,
            "document_of changed what it stores: update golden_documents.json and bump persist::DERIVATION"
        );
    }

    #[async_test]
    async fn test_a_stale_derivation_keeps_documents_and_opens_a_rederive_window() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!derived:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(&client, JoinedRoomBuilder::new(&room_id))
            .await;

        let mut index = chunked_room(10);
        let mut flush = index.take_flush();
        flush.manifest.derived = 0;
        assert!(super::persist::list_room(&client, &room_id).await);
        for (chunk, stored) in &flush.chunks {
            assert!(
                super::persist::write_chunk(&client, &room_id, *chunk, stored)
                    .await
                    .is_some()
            );
        }
        assert!(super::persist::write_manifest(&client, &room_id, &flush.manifest).await);

        let (core, _events) = crate::Core::new(
            "search-derived",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.restore_persisted_index(&client).await;

        {
            let index = core.search_index.lock().await;
            assert_eq!(in_room(&index, &room_id, "message", 50, 0).len(), 10);
            assert!(index.rooms[&room_id].rederive_from > 0);
            assert!(index.rooms[&room_id].dirty);
        }

        let mut progress = core.search_crawl.lock().await;
        progress.restore(std::collections::BTreeMap::from([(
            room_id.clone(),
            super::persist::StoredCrawlRoom {
                token: None,
                reached_start: true,
            },
        )]));
        assert!(!progress.checkpoints().contains_key(&room_id));
        drop(progress);

        core.flush_search_index(&client).await;
        let super::persist::Opened::Manifest(reopened) =
            super::persist::open(&client, &room_id).await
        else {
            panic!("the migrated room should be stored as a manifest");
        };
        assert_eq!(reopened.derived, super::persist::DERIVATION);
        assert!(reopened.rederive_from > 0);

        core.search_index.lock().await.finish_rederive(&room_id);
        core.flush_search_index(&client).await;
        let super::persist::Opened::Manifest(finished) =
            super::persist::open(&client, &room_id).await
        else {
            panic!("the finished room should be stored as a manifest");
        };
        assert_eq!(finished.rederive_from, 0);

        drop(room);
    }

    #[async_test]
    async fn test_only_the_crawl_rederives_classified_documents() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!rederive:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    serde_json::from_value::<
                        matrix_sdk::ruma::serde::Raw<
                            matrix_sdk::ruma::events::AnySyncTimelineEvent,
                        >,
                    >(serde_json::json!({
                        "type": "m.room.message",
                        "event_id": "$gallery",
                        "sender": "@erwan:localhost",
                        "origin_server_ts": 5_000,
                        "content": {
                            "msgtype": "dm.filament.gallery",
                            "body": "",
                            "itemtypes": [{
                                "itemtype": "m.file",
                                "body": "notes.pdf",
                                "url": "mxc://localhost/notes"
                            }]
                        }
                    }))
                    .expect("gallery event"),
                ),
            )
            .await;
        let (cache, _drop_handles) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        let events = cache.events().await.expect("cached events");

        let mut index = MessageIndex::new();
        index
            .ingest(&room_id, events.clone(), &cache, &RedactionRules::V11)
            .await;
        let stale = |index: &mut MessageIndex| {
            let room_index = index.rooms.get_mut(&room_id).expect("room");
            let mut document = room_index
                .document(&event_id!("$gallery").to_owned())
                .cloned()
                .expect("the gallery document");
            document.media = Vec::new();
            document.attachments = Vec::new();
            room_index.upsert(document);
        };
        let media = |index: &MessageIndex| {
            index.rooms[&room_id]
                .document(&event_id!("$gallery").to_owned())
                .map_or(0, |document| document.media.len())
        };

        stale(&mut index);
        index
            .ingest_with(&room_id, events.clone(), &cache, &RedactionRules::V11, true)
            .await;
        assert_eq!(media(&index), 0);

        index.rooms.get_mut(&room_id).expect("room").rederive_from = 1;
        index
            .ingest_with(
                &room_id,
                events.clone(),
                &cache,
                &RedactionRules::V11,
                false,
            )
            .await;
        assert_eq!(media(&index), 0);

        index
            .ingest_with(&room_id, events.clone(), &cache, &RedactionRules::V11, true)
            .await;
        assert_eq!(media(&index), 1);

        index.finish_rederive(&room_id);
        stale(&mut index);
        index
            .ingest_with(&room_id, events, &cache, &RedactionRules::V11, true)
            .await;
        assert_eq!(media(&index), 0);

        drop(room);
    }

    #[async_test]
    async fn test_a_v3_blob_from_main_is_split_into_chunks_without_a_recrawl() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!legacy:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(&client, JoinedRoomBuilder::new(&room_id))
            .await;

        let documents: Vec<super::Document> = (0..3_000)
            .map(|seed| {
                document(
                    &format!("old{seed}"),
                    &format!("archaeology {seed}"),
                    "@erwan:localhost",
                    seed,
                    None,
                    Vec::new(),
                )
            })
            .collect();
        let documents: Vec<serde_json::Value> = documents
            .iter()
            .map(|document| {
                let mut json = serde_json::to_value(document).expect("document json");
                json.as_object_mut().expect("an object").remove("media");
                json
            })
            .collect();
        let legacy = serde_json::json!({
            "version": 3,
            "documents": documents,
            "classified": ["$old0", "$reaction"],
            "edits": [],
        });
        client
            .state_store()
            .set_custom_value(
                format!("sable.search.documents.{room_id}").as_bytes(),
                serde_json::to_vec(&legacy).expect("legacy json"),
            )
            .await
            .expect("legacy blob");

        let (core, _events) = crate::Core::new(
            "search-legacy",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.restore_persisted_index(&client).await;
        assert_eq!(
            in_room(
                &*core.search_index.lock().await,
                &room_id,
                "archaeology",
                5_000,
                0
            )
            .len(),
            3_000
        );
        core.flush_search_index(&client).await;

        let store = client.state_store();
        assert!(
            store
                .get_custom_value(format!("sable.search.documents.{room_id}").as_bytes())
                .await
                .expect("read")
                .is_none()
        );
        assert_eq!(
            super::persist::listed_rooms(&client).await,
            vec![room_id.clone()]
        );

        let (second, _second_events) = crate::Core::new(
            "search-legacy-second",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        second.restore_persisted_index(&client).await;
        let index = second.search_index.lock().await;
        assert_eq!(
            in_room(&index, &room_id, "archaeology", 5_000, 0).len(),
            3_000
        );
        assert!(index.rooms[&room_id].already_classified(event_id!("$reaction")));
        assert!(index.rooms[&room_id].chunks.len() > 1);

        drop(room);
    }

    #[async_test]
    async fn test_a_room_left_between_sessions_is_wiped_at_restore() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let left = room_id!("!left:localhost").to_owned();
        server
            .sync_room(&client, matrix_sdk_test::LeftRoomBuilder::new(&left))
            .await;

        let mut index = chunked_room(10);
        let flush = index.take_flush();
        assert!(super::persist::list_room(&client, &left).await);
        for (chunk, stored) in &flush.chunks {
            assert!(
                super::persist::write_chunk(&client, &left, *chunk, stored)
                    .await
                    .is_some()
            );
        }
        assert!(super::persist::write_manifest(&client, &left, &flush.manifest).await);

        let (core, _events) = crate::Core::new(
            "search-left-room",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.restore_persisted_index(&client).await;

        assert_eq!(
            super::persist::listed_rooms(&client).await,
            [] as [matrix_sdk::ruma::OwnedRoomId; 0]
        );
        assert!(matches!(
            super::persist::open(&client, &left).await,
            super::persist::Opened::Absent
        ));
    }

    #[async_test]
    async fn test_a_flushed_index_is_searchable_in_the_next_session() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!persisted:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("crawled archaeology")
                        .event_id(event_id!("$crawled")),
                ),
            )
            .await;

        let (first, _first_events) = crate::Core::new(
            "search-persist-first",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        first.prime_persisted_rooms(&client).await;
        assert_eq!(
            in_room(
                &*first.search_index.lock().await,
                &room_id,
                "archaeology",
                10,
                0
            )
            .len(),
            1
        );
        first.flush_search_index(&client).await;

        let (second, _second_events) = crate::Core::new(
            "search-persist-second",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        second.restore_persisted_index(&client).await;

        let hits = in_room(
            &*second.search_index.lock().await,
            &room_id,
            "archaeology",
            10,
            0,
        );
        assert_eq!(
            hits.len(),
            1,
            "a restored session must find what was crawled"
        );
        assert_eq!(hits[0].event_id, event_id!("$crawled"));

        drop(room);
    }

    #[test]
    fn test_a_lightly_edited_room_waits_before_its_snapshot_is_rewritten() {
        let room = matrix_sdk::ruma::RoomId::parse("!throttle:localhost").expect("room id");
        let mut index = MessageIndex::new();
        index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new)
            .upsert(document(
                "one",
                "a single word",
                "@erwan:localhost",
                1,
                None,
                Vec::new(),
            ));

        assert_eq!(index.dirty_rooms(), vec![room.clone()]);

        for tick in 1..super::TICKS_BEFORE_FLUSH {
            assert!(
                index.rooms_due_to_flush().is_empty(),
                "one change must not rewrite the whole room on tick {tick}"
            );
        }
        assert_eq!(
            index.rooms_due_to_flush(),
            vec![room.clone()],
            "a lightly edited room must still be persisted eventually"
        );

        index.take_flush(&room);
        assert_eq!(
            index.rooms_due_to_flush(),
            [] as [matrix_sdk::ruma::OwnedRoomId; 0]
        );
    }

    #[test]
    fn test_a_busy_room_is_persisted_without_waiting_out_the_ticks() {
        let room = matrix_sdk::ruma::RoomId::parse("!busy:localhost").expect("room id");
        let mut index = MessageIndex::new();
        let room_index = index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new);

        for seed in 0..super::CHANGES_BEFORE_FLUSH {
            room_index.upsert(document(
                &format!("busy{seed}"),
                &format!("message number {seed}"),
                "@erwan:localhost",
                seed as u64,
                None,
                Vec::new(),
            ));
        }

        assert_eq!(
            index.rooms_due_to_flush(),
            vec![room],
            "a room past the change threshold must not wait for the tick deadline"
        );
    }

    #[async_test]
    async fn test_a_restored_room_does_not_charge_the_crawl_budget_again() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!budget:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("crawled archaeology")
                        .event_id(event_id!("$crawled")),
                ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-budget",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;
        core.flush_search_index(&client).await;

        let (cache, _drop_handles) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        let events = cache.events().await.expect("cached events");
        let rules = room.clone_info().room_version_rules_or_default().redaction;

        let virgin = MessageIndex::new()
            .ingest(&room_id, events.clone(), &cache, &rules)
            .await;
        assert!(virgin > 0, "an unseen batch must cost the budget something");

        let (restored, _restored_events) = crate::Core::new(
            "search-budget-restored",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        restored.restore_persisted_index(&client).await;

        let fresh = restored
            .search_index
            .lock()
            .await
            .ingest(&room_id, events, &cache, &rules)
            .await;
        assert_eq!(
            fresh, 0,
            "re-reading persisted events must not spend the crawl budget"
        );

        drop(room);
    }

    #[async_test]
    async fn test_a_failed_room_reports_partial_not_complete() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!failed:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    EventFactory::new()
                        .room(&room_id)
                        .sender(user_id!("@erwan:localhost"))
                        .text_msg("latest deploy")
                        .event_id(event_id!("$latest")),
                ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-coverage-partial",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;
        core.search_crawl.lock().await.fail(room_id);

        let coverage = core.search_coverage(&client).await;
        assert_eq!(
            coverage.state,
            crate::protocol::SearchCoverageState::Partial,
            "a room whose pagination errored must not be reported as fully indexed"
        );
        assert_eq!(coverage.rooms_failed, 1);
        assert_eq!(coverage.rooms_pending, 0);

        drop(room);
    }

    #[async_test]
    async fn test_a_room_walked_to_its_start_reports_complete() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!walked:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"))
            .server_ts(super::now_ms());

        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous")
                    .add_timeline_event(
                        factory
                            .text_msg("latest deploy")
                            .event_id(event_id!("$latest")),
                    ),
            )
            .await;

        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default().events(vec![
                factory
                    .text_msg("older archaeology")
                    .event_id(event_id!("$older")),
            ]))
            .mount()
            .await;

        let (core, _events) = crate::Core::new(
            "search-coverage-complete",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;

        let reached_start = core
            .crawl_once(&client, &room_id)
            .await
            .expect("crawl one batch");
        assert!(matches!(
            reached_start,
            CrawlOutcome::Batch(CrawlBatch {
                reached_start: true,
                ..
            })
        ));
        core.search_crawl.lock().await.settle(room_id, true);

        let coverage = core.search_coverage(&client).await;
        assert_eq!(
            coverage.state,
            crate::protocol::SearchCoverageState::Complete
        );
        assert_eq!(coverage.rooms_failed, 0);
        assert_eq!(coverage.rooms_pending, 0);
        assert_eq!(coverage.documents, 2);

        drop(room);
    }

    #[async_test]
    async fn test_a_spent_budget_reports_stopped_even_with_rooms_left() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!stopped:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous")
                    .add_timeline_event(
                        EventFactory::new()
                            .room(&room_id)
                            .sender(user_id!("@erwan:localhost"))
                            .text_msg("latest deploy")
                            .event_id(event_id!("$latest")),
                    ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-coverage-stopped",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;
        assert_eq!(
            core.search_coverage(&client).await.state,
            crate::protocol::SearchCoverageState::Indexing
        );

        core.search_crawl.lock().await.exhaust_budget_for_test();

        let coverage = core.search_coverage(&client).await;
        assert_eq!(
            coverage.state,
            crate::protocol::SearchCoverageState::Stopped,
            "a spent budget outranks the rooms still queued"
        );
        assert_eq!(coverage.rooms_pending, 1);

        drop(room);
    }

    #[async_test]
    async fn test_the_crawl_serves_every_room_before_deepening_one() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let busy = room_id!("!busy:localhost").to_owned();
        let quiet = room_id!("!quiet:localhost").to_owned();

        server.mock_room_state_encryption().plain().mount().await;
        let busy_room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&busy)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("busy-previous")
                    .add_timeline_event(
                        EventFactory::new()
                            .room(&busy)
                            .sender(user_id!("@erwan:localhost"))
                            .text_msg("newest deploy")
                            .event_id(event_id!("$busy"))
                            .server_ts(9_000),
                    ),
            )
            .await;
        let quiet_room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&quiet)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("quiet-previous")
                    .add_timeline_event(
                        EventFactory::new()
                            .room(&quiet)
                            .sender(user_id!("@erwan:localhost"))
                            .text_msg("ancient deploy")
                            .event_id(event_id!("$quiet"))
                            .server_ts(1_000),
                    ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-crawl-fairness",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;

        assert_eq!(
            core.next_room_to_crawl(&client).await.as_ref(),
            Some(&busy),
            "the first turn goes to the room with the newest message"
        );

        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default().events(vec![
                EventFactory::new()
                    .room(&busy)
                    .sender(user_id!("@erwan:localhost"))
                    .text_msg("older busy archaeology")
                    .event_id(event_id!("$busy_older")),
            ]))
            .mount()
            .await;
        core.crawl_once(&client, &busy).await.expect("crawl busy");

        assert_eq!(
            core.next_room_to_crawl(&client).await.as_ref(),
            Some(&quiet),
            "the quiet room must get a turn before the busy one is deepened again"
        );

        drop(busy_room);
        drop(quiet_room);
    }

    async fn logged_in(
        server: &MatrixMockServer,
        client: &matrix_sdk::Client,
        account_id: &str,
    ) -> Arc<crate::Core> {
        let sync_service = Arc::new(
            matrix_sdk_ui::sync_service::SyncService::builder(client.clone())
                .build()
                .await
                .expect("sync service"),
        );
        let (core, _events) = crate::Core::new(
            account_id,
            Box::new(crate::store::MemorySessionStore::default()),
        );
        *core.session.write().await = Some(crate::session::Session {
            account_id: account_id.to_owned(),
            client: client.clone(),
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
        });
        core
    }

    fn one_server_hit(room_id: &matrix_sdk::ruma::OwnedRoomId) -> serde_json::Value {
        json!({
            "search_categories": {
                "room_events": {
                    "count": 1,
                    "highlights": [],
                    "results": [{
                        "rank": 0.9,
                        "result": {
                            "type": "m.room.message",
                            "event_id": "$older-than-the-crawl",
                            "room_id": room_id,
                            "sender": "@erwan:localhost",
                            "origin_server_ts": 1_000,
                            "content": { "msgtype": "m.text", "body": "deploy notes from years ago" }
                        }
                    }]
                }
            }
        })
    }

    fn scoped_to(room_id: &matrix_sdk::ruma::OwnedRoomId) -> super::IndexFilter {
        super::IndexFilter {
            rooms: vec![room_id.clone()],
            ..super::IndexFilter::default()
        }
    }

    #[async_test]
    async fn test_an_unencrypted_room_is_searched_on_the_homeserver() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!plain:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(&client, JoinedRoomBuilder::new(&room_id))
            .await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(one_server_hit(&room_id)))
            .expect(1)
            .mount(server.server())
            .await;

        let core = logged_in(&server, &client, "search-server-plain").await;
        let hits = core
            .search_messages(
                "deploy",
                &scoped_to(&room_id),
                crate::api::search::SearchOrder::Rank,
                10,
                0,
                0,
            )
            .await;

        assert_eq!(
            hits.len(),
            1,
            "the local index never crawled this room, so a hit can only be the server's"
        );
        assert_eq!(hits[0].event_id, event_id!("$older-than-the-crawl"));
        assert_eq!(hits[0].body, "deploy notes from years ago");

        drop(room);
    }

    #[async_test]
    async fn test_an_encrypted_room_is_never_searched_on_the_homeserver() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!secret:localhost").to_owned();
        let sender = user_id!("@erwan:localhost");
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_state_event(
                        EventFactory::new()
                            .room(&room_id)
                            .sender(sender)
                            .room_encryption(),
                    )
                    .add_timeline_event(
                        EventFactory::new()
                            .room(&room_id)
                            .sender(sender)
                            .text_msg("deploy notes we keep to ourselves")
                            .event_id(event_id!("$local")),
                    ),
            )
            .await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(one_server_hit(&room_id)))
            .expect(0)
            .mount(server.server())
            .await;

        let core = logged_in(&server, &client, "search-server-encrypted").await;
        let (cache, _drop_handles) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

        let hits = core
            .search_messages(
                "deploy",
                &scoped_to(&room_id),
                crate::api::search::SearchOrder::Rank,
                10,
                0,
                0,
            )
            .await;

        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0].event_id,
            event_id!("$local"),
            "an encrypted room is answered from the local index alone"
        );

        drop(room);
    }

    #[async_test]
    async fn test_room_attachments_sort_the_index_into_media_files_and_links() {
        use crate::protocol::RoomAttachmentKind;

        use matrix_sdk::ruma::events::room::message::{
            FileMessageEventContent, MessageType, RoomMessageEventContent,
        };

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!attachments:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_timeline_event(
                        factory
                            .image(
                                "beach.png".to_owned(),
                                matrix_sdk::ruma::owned_mxc_uri!("mxc://localhost/beach"),
                            )
                            .event_id(event_id!("$image")),
                    )
                    .add_timeline_event(
                        factory
                            .event(RoomMessageEventContent::new(MessageType::File(
                                FileMessageEventContent::plain(
                                    "notes.pdf".to_owned(),
                                    matrix_sdk::ruma::owned_mxc_uri!("mxc://localhost/notes"),
                                ),
                            )))
                            .event_id(event_id!("$file")),
                    )
                    .add_timeline_event(
                        factory
                            .text_msg(
                                "tickets at https://example.org/tickets and javascript://%0Aalert(1)",
                            )
                            .event_id(event_id!("$link")),
                    )
                    .add_timeline_event(
                        factory
                            .text_msg("nothing to see")
                            .event_id(event_id!("$plain")),
                    ),
            )
            .await;

        let core = logged_in(&server, &client, "room-attachments").await;
        let (cache, _drop_handles) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

        let (media, next) = core
            .room_attachments(&room_id, RoomAttachmentKind::Media, 10, None)
            .await
            .expect("media");
        assert!(next.is_none());
        assert!(matches!(
            media.as_slice(),
            [crate::protocol::RoomAttachmentView {
                content: crate::protocol::RoomAttachmentContentView::Image { filename, source, .. },
                ..
            }] if filename == "beach.png" && source == "mxc://localhost/beach"
        ));

        let (files, _) = core
            .room_attachments(&room_id, RoomAttachmentKind::File, 10, None)
            .await
            .expect("files");
        assert!(matches!(
            files.as_slice(),
            [crate::protocol::RoomAttachmentView {
                content: crate::protocol::RoomAttachmentContentView::File { filename, .. },
                ..
            }] if filename == "notes.pdf"
        ));

        let (links, _) = core
            .room_attachments(&room_id, RoomAttachmentKind::Link, 10, None)
            .await
            .expect("links");
        assert!(matches!(
            links.as_slice(),
            [crate::protocol::RoomAttachmentView {
                content: crate::protocol::RoomAttachmentContentView::Link { urls, .. },
                ..
            }] if urls == &["https://example.org/tickets".to_owned()]
        ));

        drop(room);
    }

    #[async_test]
    async fn test_room_attachments_list_each_gallery_item_under_its_tab() {
        use crate::protocol::RoomAttachmentKind;

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!gallery-attachments:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    serde_json::from_value::<
                        matrix_sdk::ruma::serde::Raw<
                            matrix_sdk::ruma::events::AnySyncTimelineEvent,
                        >,
                    >(serde_json::json!({
                        "type": "m.room.message",
                        "event_id": "$gallery",
                        "sender": "@erwan:localhost",
                        "origin_server_ts": 1,
                        "content": {
                            "msgtype": "dm.filament.gallery",
                            "body": "",
                            "itemtypes": [
                                {
                                    "itemtype": "m.image",
                                    "body": "beach.png",
                                    "url": "mxc://localhost/beach",
                                    "page.codeberg.everypizza.msc4193.spoiler": true
                                },
                                {
                                    "itemtype": "m.file",
                                    "body": "notes.pdf",
                                    "url": "mxc://localhost/notes",
                                    "info": { "mimetype": "application/pdf", "size": 4096 }
                                },
                                {
                                    "itemtype": "m.video",
                                    "body": "wave.mp4",
                                    "url": "mxc://localhost/wave"
                                }
                            ]
                        }
                    }))
                    .expect("gallery event"),
                ),
            )
            .await;

        let core = logged_in(&server, &client, "gallery-attachments").await;
        let (cache, _drop_handles) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

        let (media, _) = core
            .room_attachments(&room_id, RoomAttachmentKind::Media, 10, None)
            .await
            .expect("media");
        let media = serde_json::to_value(&media).expect("media json");
        assert_eq!(media.as_array().map(Vec::len), Some(2));
        assert_eq!(media[0]["event_id"], "$gallery");
        assert_eq!(media[0]["gallery_index"], 0);
        assert_eq!(media[0]["content"]["spoiler"], "");
        assert_eq!(media[1]["gallery_index"], 2);
        assert_eq!(media[1]["content"]["kind"], "video");

        let (files, _) = core
            .room_attachments(&room_id, RoomAttachmentKind::File, 10, None)
            .await
            .expect("files");
        let files = serde_json::to_value(&files).expect("files json");
        assert_eq!(files.as_array().map(Vec::len), Some(1));
        assert_eq!(files[0]["gallery_index"], 1);
        assert_eq!(files[0]["content"]["filename"], "notes.pdf");
        assert_eq!(files[0]["content"]["size"], 4096);

        let filter = super::IndexFilter {
            rooms: vec![room_id.clone()],
            ..super::IndexFilter::default()
        };
        let hits = core
            .search_messages(
                "notes",
                &filter,
                crate::api::search::SearchOrder::Rank,
                10,
                0,
                0,
            )
            .await;
        assert_eq!(
            hits.iter()
                .map(|hit| hit.event_id.as_str())
                .collect::<Vec<_>>(),
            ["$gallery"]
        );

        drop(room);
    }

    #[async_test]
    async fn test_a_homeserver_that_cannot_search_falls_back_to_the_local_index() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!plain:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    EventFactory::new()
                        .room(&room_id)
                        .sender(user_id!("@erwan:localhost"))
                        .text_msg("deploy notes the crawl did reach")
                        .event_id(event_id!("$local")),
                ),
            )
            .await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/search"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_UNRECOGNIZED",
                "error": "Unrecognized request"
            })))
            .mount(server.server())
            .await;

        let core = logged_in(&server, &client, "search-server-missing").await;
        let (cache, _drop_handles) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

        let hits = core
            .search_messages(
                "deploy",
                &scoped_to(&room_id),
                crate::api::search::SearchOrder::Rank,
                10,
                0,
                0,
            )
            .await;

        assert_eq!(
            hits.len(),
            1,
            "a server without /search must degrade to the local index, not fail the search"
        );
        assert_eq!(hits[0].event_id, event_id!("$local"));

        drop(room);
    }

    #[async_test]
    async fn test_a_dated_query_stays_local_even_for_an_unencrypted_room() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!plain:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    EventFactory::new()
                        .room(&room_id)
                        .sender(user_id!("@erwan:localhost"))
                        .text_msg("deploy notes the crawl did reach")
                        .server_ts(5_000)
                        .event_id(event_id!("$local")),
                ),
            )
            .await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(one_server_hit(&room_id)))
            .expect(0)
            .mount(server.server())
            .await;

        let core = logged_in(&server, &client, "search-server-dated").await;
        let (cache, _drop_handles) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

        let filter = super::IndexFilter {
            after_ts: Some(1_000),
            ..scoped_to(&room_id)
        };
        let hits = core
            .search_messages(
                "deploy",
                &filter,
                crate::api::search::SearchOrder::Rank,
                10,
                0,
                0,
            )
            .await;

        assert_eq!(
            hits.len(),
            1,
            "`/search` cannot carry a date bound, so the query stays where it can be answered"
        );
        assert_eq!(hits[0].event_id, event_id!("$local"));

        drop(room);
    }

    #[async_test]
    async fn test_a_filter_only_query_stays_local_even_for_an_unencrypted_room() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!plain:localhost").to_owned();
        let sender = user_id!("@erwan:localhost");
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    EventFactory::new()
                        .room(&room_id)
                        .sender(sender)
                        .text_msg("deploy notes the crawl did reach")
                        .event_id(event_id!("$local")),
                ),
            )
            .await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(one_server_hit(&room_id)))
            .expect(0)
            .mount(server.server())
            .await;

        let core = logged_in(&server, &client, "search-server-filter-only").await;
        let (cache, _drop_handles) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

        let filter = super::IndexFilter {
            senders: vec![sender.to_owned()],
            ..scoped_to(&room_id)
        };
        let hits = core
            .search_messages(
                "",
                &filter,
                crate::api::search::SearchOrder::Recent,
                10,
                0,
                0,
            )
            .await;

        assert_eq!(hits.len(), 1, "`/search` needs a term to match anything");
        assert_eq!(hits[0].event_id, event_id!("$local"));

        drop(room);
    }

    #[test]
    fn test_an_unreadable_room_is_never_flushed_over_its_blob() {
        let room = matrix_sdk::ruma::RoomId::parse("!unreadable:localhost").expect("room id");
        let mut index = MessageIndex::new();
        index.mark_unreadable(&room);
        let room_index = index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new);
        for seed in 0..super::CHANGES_BEFORE_FLUSH {
            room_index.upsert(document(
                &format!("shallow{seed}"),
                &format!("shallow crawl {seed}"),
                "@erwan:localhost",
                seed as u64,
                None,
                Vec::new(),
            ));
        }

        assert_eq!(
            index.dirty_rooms(),
            [] as [matrix_sdk::ruma::OwnedRoomId; 0]
        );
        for _ in 0..super::TICKS_BEFORE_FLUSH {
            assert!(
                index.rooms_due_to_flush().is_empty(),
                "a room whose blob could not be read must not be overwritten"
            );
        }
    }

    #[async_test]
    async fn test_a_restored_room_waits_out_the_ticks_before_it_is_rewritten() {
        let room = matrix_sdk::ruma::RoomId::parse("!restored:localhost").expect("room id");
        let documents = (0..super::CHANGES_BEFORE_FLUSH)
            .map(|seed| {
                document(
                    &format!("kept{seed}"),
                    &format!("kept message {seed}"),
                    "@erwan:localhost",
                    seed as u64,
                    None,
                    Vec::new(),
                )
            })
            .collect();

        let mut index = MessageIndex::new();
        index.restore_room(&room, restored_from(documents)).await;
        index
            .rooms
            .get_mut(&room)
            .expect("the restored room")
            .upsert(document(
                "fresh",
                "one new message",
                "@erwan:localhost",
                99,
                None,
                Vec::new(),
            ));

        assert!(
            index.rooms_due_to_flush().is_empty(),
            "one change after a restore must not rewrite the whole room"
        );
    }

    #[async_test]
    async fn test_ignored_senders_are_read_from_the_store() {
        use matrix_sdk::ruma::events::GlobalAccountDataEventType;
        use matrix_sdk::ruma::serde::Raw;

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let mut changes = matrix_sdk::StateChanges::default();
        changes.account_data.insert(
            GlobalAccountDataEventType::IgnoredUserList,
            Raw::from_json(
                serde_json::value::to_raw_value(&json!({
                    "type": "m.ignored_user_list",
                    "content": { "ignored_users": { "@troll:localhost": {} } }
                }))
                .expect("raw account data"),
            ),
        );
        client
            .state_store()
            .save_changes(&changes)
            .await
            .expect("saved account data");

        let core = logged_in(&server, &client, "search-ignored-store").await;

        assert_eq!(
            client.subscribe_to_ignore_user_list_changes().get(),
            [] as [matrix_sdk::ruma::OwnedUserId; 0]
        );
        assert_eq!(
            core.ignored_senders().await,
            vec![user_id!("@troll:localhost").to_owned()],
            "a restored session has an ignore list before any sync changes it"
        );
    }

    async fn empty_cache(
        server: &MatrixMockServer,
        client: &matrix_sdk::Client,
        room_id: &matrix_sdk::ruma::OwnedRoomId,
    ) -> (
        matrix_sdk::Room,
        matrix_sdk::event_cache::RoomEventCache,
        Arc<matrix_sdk::event_cache::EventCacheDropHandles>,
    ) {
        let room = server.sync_joined_room(client, room_id).await;
        let (cache, drop_handles) = client
            .event_cache()
            .unwrap()
            .room(room_id)
            .await
            .expect("room event cache");
        (room, cache, drop_handles)
    }

    #[async_test]
    async fn test_an_edit_keeps_the_originals_time_and_takes_its_new_mentions() {
        use matrix_sdk::ruma::events::Mentions;

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!edited:localhost").to_owned();
        let original_id = event_id!("$original");
        let alice = user_id!("@alice:localhost");
        let (room, cache, _drop) = empty_cache(&server, &client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        let events = vec![
            factory
                .text_msg("deploy starts at noon")
                .event_id(original_id)
                .server_ts(1_000)
                .into_event(),
            factory
                .text_msg("* deploy starts at one")
                .edit(
                    original_id,
                    RoomMessageEventContentWithoutRelation::text_plain("deploy starts at one")
                        .add_mentions(Mentions::with_user_ids([alice.to_owned()])),
                )
                .event_id(event_id!("$edit"))
                .server_ts(9_000)
                .into_event(),
        ];

        let mut index = MessageIndex::new();
        index
            .ingest(&room_id, events, &cache, &RedactionRules::V11)
            .await;

        let hits = index.search(
            "deploy",
            &super::IndexFilter {
                mentions: vec![alice.to_owned()],
                ..super::IndexFilter::default()
            },
            crate::api::search::SearchOrder::Rank,
            10,
            0,
        );
        assert_eq!(
            hits.len(),
            1,
            "the edit's m.new_content carries the mention"
        );
        assert_eq!(hits[0].event_id, original_id);
        assert_eq!(
            hits[0].origin_server_ts, 1_000,
            "an edit does not move the message in time"
        );
        assert_eq!(hits[0].body, "deploy starts at one");

        drop(room);
    }

    #[async_test]
    async fn test_an_edit_crawled_a_batch_before_its_original_is_fixed_up_when_it_lands() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!split:localhost").to_owned();
        let original_id = event_id!("$original");
        let (room, cache, _drop) = empty_cache(&server, &client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        let mut index = MessageIndex::new();
        index
            .ingest(
                &room_id,
                vec![
                    factory
                        .text_msg("* the rollback finished")
                        .edit(
                            original_id,
                            RoomMessageEventContentWithoutRelation::text_plain(
                                "the rollback finished",
                            ),
                        )
                        .event_id(event_id!("$edit"))
                        .server_ts(9_000)
                        .into_event(),
                ],
                &cache,
                &RedactionRules::V11,
            )
            .await;
        index
            .ingest(
                &room_id,
                vec![
                    factory
                        .text_msg("the deploy pipeline is broken")
                        .event_id(original_id)
                        .server_ts(1_000)
                        .into_event(),
                ],
                &cache,
                &RedactionRules::V11,
            )
            .await;

        assert!(in_room(&index, &room_id, "deploying", 10, 0).is_empty());
        let hits = in_room(&index, &room_id, "rollback", 10, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].event_id, original_id);
        assert_eq!(hits[0].origin_server_ts, 1_000);

        drop(room);
    }

    #[async_test]
    async fn test_an_edit_from_someone_else_is_ignored() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!forged:localhost").to_owned();
        let original_id = event_id!("$original");
        let erwan = user_id!("@erwan:localhost");
        let (room, cache, _drop) = empty_cache(&server, &client, &room_id).await;
        let factory = EventFactory::new().room(&room_id);

        let original = || {
            factory
                .text_msg("the deploy is green")
                .sender(erwan)
                .event_id(original_id)
                .server_ts(1_000)
                .into_event()
        };
        let forged = || {
            factory
                .text_msg("* the deploy is red")
                .sender(user_id!("@mallory:localhost"))
                .edit(
                    original_id,
                    RoomMessageEventContentWithoutRelation::text_plain("the deploy is red"),
                )
                .event_id(event_id!("$forged"))
                .server_ts(2_000)
                .into_event()
        };

        let mut together = MessageIndex::new();
        together
            .ingest(
                &room_id,
                vec![original(), forged()],
                &cache,
                &RedactionRules::V11,
            )
            .await;

        let mut forged_first = MessageIndex::new();
        forged_first
            .ingest(&room_id, vec![forged()], &cache, &RedactionRules::V11)
            .await;
        forged_first
            .ingest(&room_id, vec![original()], &cache, &RedactionRules::V11)
            .await;

        for index in [&together, &forged_first] {
            assert!(in_room(index, &room_id, "red", 10, 0).is_empty());
            let hits = in_room(index, &room_id, "green", 10, 0);
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].sender, erwan);
        }

        drop(room);
    }

    #[async_test]
    async fn test_redacting_an_edit_brings_the_previous_body_back() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room_id!("!unedited:localhost").to_owned();
        let original_id = event_id!("$original");
        let edit_id = event_id!("$edit");
        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_timeline_event(
                        factory
                            .text_msg("the deploy pipeline is broken")
                            .event_id(original_id),
                    )
                    .add_timeline_event(
                        factory
                            .text_msg("* the rollback finished")
                            .edit(
                                original_id,
                                RoomMessageEventContentWithoutRelation::text_plain(
                                    "the rollback finished",
                                ),
                            )
                            .event_id(edit_id),
                    ),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;
        assert_eq!(in_room(&index, &room_id, "rollback", 10, 0).len(), 1);

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory.redaction(edit_id).event_id(event_id!("$redaction")),
                ),
            )
            .await;
        reingest_whole_room(&mut index, &cache, &room_id).await;

        assert!(
            in_room(&index, &room_id, "rollback", 10, 0).is_empty(),
            "a redacted edit must not leave its text searchable"
        );
        let hits = in_room(&index, &room_id, "deploying", 10, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].event_id, original_id);

        drop(room);
    }
}
