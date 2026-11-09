use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{event_id, room_id, user_id};
use matrix_sdk::test_utils::mocks::{MatrixMockServer, RoomMessagesResponseTemplate};
use matrix_sdk_test::{JoinedRoomBuilder, async_test, event_factory::EventFactory};

use super::{document, found, in_restored_room, in_room, picture};
use crate::search::MessageIndex;
use crate::search::crawl::{CrawlBatch, CrawlOutcome};

fn restored_from(documents: Vec<crate::search::Document>) -> crate::search::persist::Restored {
    let count = documents.len();
    crate::search::persist::Restored {
        manifest: crate::search::persist::Manifest::new(
            1,
            vec![crate::search::persist::ChunkEntry {
                id: 0,
                start: 0,
                bytes: 0,
                count,
            }],
            Vec::new(),
            0,
        ),
        loaded: vec![(
            0,
            crate::search::persist::StoredChunk::new(documents, Vec::new()),
        )],
        legacy: false,
    }
}

fn chunked_room(count: usize) -> crate::search::RoomIndex {
    let mut index = crate::search::RoomIndex::new();
    for seed in 0..count {
        index.upsert(document(
            &format!("m{seed}"),
            &format!("message {seed}"),
            "@kris:localhost",
            seed as u64,
            None,
            Vec::new(),
        ));
    }
    index
}

#[async_test]
async fn test_chinese_search_survives_restore() {
    crate::search::tokenize::load_bundled_chinese();
    let room = room_id!("!chinese:localhost").to_owned();
    let document = document(
        "chinese",
        "今天我们一起讨论中文搜索功能，然后测试加密房间里的消息索引。",
        "@kris:localhost",
        1_000,
        None,
        Vec::new(),
    );
    let mut fresh = crate::search::RoomIndex::new();
    fresh.upsert(document.clone());
    let restored = crate::search::RoomIndex::restored(restored_from(vec![document])).await;

    for room_index in [fresh, restored] {
        let mut index = MessageIndex::new();
        index.rooms.insert(room.clone(), room_index);
        for query in ["中文", "搜索", "功能", "加密", "消息", "索引"] {
            assert_eq!(
                found(&index, query, &crate::search::IndexFilter::default()),
                ["$chinese"],
                "missing Chinese search result for {query:?}"
            );
        }
        assert_eq!(
            found(&index, "天气", &crate::search::IndexFilter::default()),
            [] as [String; 0]
        );
    }
}

#[async_test]
async fn test_pending_chinese_reindex() {
    crate::search::tokenize::load_bundled_chinese();
    let room = room_id!("!pending-chinese:localhost").to_owned();
    let mut room_index = crate::search::RoomIndex::new();
    room_index.upsert(document(
        "pending",
        "稍后搜索中文消息",
        "@kris:localhost",
        1_000,
        None,
        Vec::new(),
    ));
    // Simulate indexing before the dictionary is available.
    room_index.index = crate::search::inverted::InvertedIndex::with_capacity(0);
    room_index
        .chinese_pending
        .extend(room_index.documents.keys().copied());
    let revision = room_index.revision;
    let mut index = MessageIndex::new();
    index.rooms.insert(room.clone(), room_index);
    assert!(index.chinese_pending());
    assert_eq!(
        found(&index, "搜索", &crate::search::IndexFilter::default()),
        [] as [String; 0]
    );

    index.refresh_chinese().await;

    assert!(!index.chinese_pending());
    assert_eq!(index.revision(&room), revision);
    assert_eq!(
        found(&index, "搜索", &crate::search::IndexFilter::default()),
        ["$pending"]
    );
}

#[async_test]
async fn test_a_restored_index_lists_media_without_the_event_cache() {
    let room = matrix_sdk::ruma::RoomId::parse("!pictures:localhost").expect("room id");
    let mut index = MessageIndex::new();
    index.rooms.insert(
        room.clone(),
        crate::search::RoomIndex::restored(restored_from(vec![picture(
            "beach",
            "@kris:localhost",
            1,
        )]))
        .await,
    );

    let crate::search::index::PageStep::Done(items, next) = index.attachment_page(
        &room,
        crate::protocol::RoomAttachmentKind::Media,
        &[],
        None,
        10,
        &crate::search::index::PageWork::default(),
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

#[async_test]
async fn test_the_crawl_resumes_from_the_checkpoint_it_persisted() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;

    let room_id = room_id!("!resume:localhost").to_owned();
    let factory = EventFactory::new()
        .room(&room_id)
        .sender(user_id!("@kris:localhost"))
        .server_ts(crate::search::now_ms());

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
        "@kris:localhost",
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
    let restored = crate::search::RoomIndex::restored(crate::search::persist::Restored {
        manifest: flush.manifest,
        loaded: flush.chunks,
        legacy: false,
    })
    .await;

    assert_eq!(restored.len(), 3_000);
    assert!(restored.already_classified(event_id!("$reaction")));
    assert!(!restored.dirty);
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
    assert!(crate::search::persist::list_room(&client, &room_id).await);
    for (chunk, stored) in &flush.chunks {
        assert!(
            crate::search::persist::write_chunk(&client, &room_id, *chunk, stored)
                .await
                .is_some()
        );
    }
    assert!(crate::search::persist::write_manifest(&client, &room_id, &flush.manifest).await);

    let (core, _events) = crate::Core::new(
        "search-derived",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    core.restore_persisted_index(&client).await;

    {
        let mut index = core.search_index.lock().await;
        assert_eq!(
            in_restored_room(&mut index, &room_id, "message", 50)
                .await
                .len(),
            10
        );
        assert!(index.rooms[&room_id].rederive_from > 0);
        assert!(index.rooms[&room_id].dirty);
    }

    let mut progress = core.search_crawl.lock().await;
    progress.restore(std::collections::BTreeMap::from([(
        room_id.clone(),
        crate::search::persist::StoredCrawlRoom {
            shared_resume: false,
            frontier: None,
            gapped: false,
            token: None,
            reached_start: true,
            cover: None,
        },
    )]));
    assert!(!progress.checkpoints().contains_key(&room_id));
    drop(progress);

    core.flush_search_index(&client).await;
    let crate::search::persist::Opened::Manifest(reopened) =
        crate::search::persist::open(&client, &room_id).await
    else {
        panic!("the migrated room should be stored as a manifest");
    };
    assert_eq!(reopened.derived, crate::search::persist::DERIVATION);
    assert!(reopened.rederive_from > 0);

    core.search_index.lock().await.finish_rederive(&room_id);
    core.flush_search_index(&client).await;
    let crate::search::persist::Opened::Manifest(finished) =
        crate::search::persist::open(&client, &room_id).await
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
                    matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::AnySyncTimelineEvent>,
                >(serde_json::json!({
                    "type": "m.room.message",
                    "event_id": "$gallery",
                    "sender": "@kris:localhost",
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

    let documents: Vec<crate::search::Document> = (0..3_000)
        .map(|seed| {
            document(
                &format!("old{seed}"),
                &format!("archaeology {seed}"),
                "@kris:localhost",
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
        in_restored_room(
            &mut *core.search_index.lock().await,
            &room_id,
            "archaeology",
            5_000,
        )
        .await
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
        crate::search::persist::listed_rooms(&client).await,
        vec![room_id.clone()]
    );

    let (second, _second_events) = crate::Core::new(
        "search-legacy-second",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    second.restore_persisted_index(&client).await;
    let mut index = second.search_index.lock().await;
    assert_eq!(
        in_restored_room(&mut index, &room_id, "archaeology", 5_000)
            .await
            .len(),
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
    assert!(crate::search::persist::list_room(&client, &left).await);
    for (chunk, stored) in &flush.chunks {
        assert!(
            crate::search::persist::write_chunk(&client, &left, *chunk, stored)
                .await
                .is_some()
        );
    }
    assert!(crate::search::persist::write_manifest(&client, &left, &flush.manifest).await);

    let (core, _events) = crate::Core::new(
        "search-left-room",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    core.restore_persisted_index(&client).await;

    assert_eq!(
        crate::search::persist::listed_rooms(&client).await,
        [] as [matrix_sdk::ruma::OwnedRoomId; 0]
    );
    assert!(matches!(
        crate::search::persist::open(&client, &left).await,
        crate::search::persist::Opened::Absent
    ));
}

#[async_test]
async fn test_a_flushed_index_is_searchable_in_the_next_session() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;

    let room_id = room_id!("!persisted:localhost").to_owned();
    let factory = EventFactory::new()
        .room(&room_id)
        .sender(user_id!("@kris:localhost"));

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

    let hits = in_restored_room(
        &mut *second.search_index.lock().await,
        &room_id,
        "archaeology",
        10,
    )
    .await;
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
        .or_insert_with(crate::search::RoomIndex::new)
        .upsert(document(
            "one",
            "a single word",
            "@kris:localhost",
            1,
            None,
            Vec::new(),
        ));

    assert_eq!(index.dirty_rooms(), vec![room.clone()]);

    for tick in 1..crate::search::TICKS_BEFORE_FLUSH {
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
        .or_insert_with(crate::search::RoomIndex::new);

    for seed in 0..crate::search::CHANGES_BEFORE_FLUSH {
        room_index.upsert(document(
            &format!("busy{seed}"),
            &format!("message number {seed}"),
            "@kris:localhost",
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

#[test]
fn test_an_unreadable_room_is_never_flushed_over_its_blob() {
    let room = matrix_sdk::ruma::RoomId::parse("!unreadable:localhost").expect("room id");
    let mut index = MessageIndex::new();
    index.mark_unreadable(&room);
    let room_index = index
        .rooms
        .entry(room.clone())
        .or_insert_with(crate::search::RoomIndex::new);
    for seed in 0..crate::search::CHANGES_BEFORE_FLUSH {
        room_index.upsert(document(
            &format!("shallow{seed}"),
            &format!("shallow crawl {seed}"),
            "@kris:localhost",
            seed as u64,
            None,
            Vec::new(),
        ));
    }

    assert_eq!(
        index.dirty_rooms(),
        [] as [matrix_sdk::ruma::OwnedRoomId; 0]
    );
    for _ in 0..crate::search::TICKS_BEFORE_FLUSH {
        assert!(
            index.rooms_due_to_flush().is_empty(),
            "a room whose blob could not be read must not be overwritten"
        );
    }
}

#[async_test]
async fn test_a_restored_room_waits_out_the_ticks_before_it_is_rewritten() {
    let room = matrix_sdk::ruma::RoomId::parse("!restored:localhost").expect("room id");
    let documents = (0..crate::search::CHANGES_BEFORE_FLUSH)
        .map(|seed| {
            document(
                &format!("kept{seed}"),
                &format!("kept message {seed}"),
                "@kris:localhost",
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
            "@kris:localhost",
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
async fn test_a_deferred_restore_tokenizes_only_when_a_search_needs_the_room() {
    let room = room_id!("!deferred:localhost").to_owned();
    let mut index = MessageIndex::new();
    index
        .restore_room_deferred(
            &room,
            restored_from(vec![document(
                "late",
                "deploy finished",
                "@kris:localhost",
                1_000,
                None,
                Vec::new(),
            )]),
        )
        .await;
    assert!(index.rooms[&room].index.is_deferred());

    let elsewhere = crate::search::IndexFilter {
        rooms: vec![room_id!("!other:localhost").to_owned()],
        ..crate::search::IndexFilter::default()
    };
    index.build_indexes(&elsewhere).await;
    assert!(index.rooms[&room].index.is_deferred());

    let hits = index
        .search_pinned(
            "deploy",
            &crate::search::IndexFilter::default(),
            std::collections::HashSet::new(),
            crate::api::search::SearchOrder::Rank,
            20,
            0,
        )
        .await;
    assert!(!index.rooms[&room].index.is_deferred());
    assert_eq!(
        hits.iter()
            .map(|hit| hit.event_id.as_str())
            .collect::<Vec<_>>(),
        ["$late"]
    );
}

#[async_test]
async fn test_documents_ingested_before_a_deferred_build_stay_searchable() {
    let room = room_id!("!deferred-ingest:localhost").to_owned();
    let mut index = MessageIndex::new();
    index
        .restore_room_deferred(
            &room,
            restored_from(vec![document(
                "old",
                "alpha message",
                "@kris:localhost",
                1_000,
                None,
                Vec::new(),
            )]),
        )
        .await;
    index
        .rooms
        .get_mut(&room)
        .expect("the room")
        .upsert(document(
            "new",
            "alpha reply",
            "@kris:localhost",
            2_000,
            None,
            Vec::new(),
        ));
    index
        .build_indexes(&crate::search::IndexFilter::default())
        .await;
    let mut hits = found(&index, "alpha", &crate::search::IndexFilter::default());
    hits.sort();
    assert_eq!(hits, ["$new", "$old"]);
}

#[test]
fn test_a_room_whose_latest_event_is_classified_needs_no_priming() {
    use matrix_sdk::deserialized_responses::TimelineEvent;
    use matrix_sdk::latest_events::LatestEventValue;

    let room = room_id!("!primed:localhost").to_owned();
    let factory = EventFactory::new()
        .room(&room)
        .sender(user_id!("@kris:localhost"));
    let latest = LatestEventValue::Remote(TimelineEvent::from_plaintext(
        factory
            .text_msg("hello")
            .event_id(event_id!("$latest"))
            .into_raw_sync(),
    ));

    let mut index = MessageIndex::new();
    assert!(!index.latest_indexed(&room, &latest));

    index
        .rooms
        .insert(room.clone(), crate::search::RoomIndex::new());
    assert!(!index.latest_indexed(&room, &latest));
    assert!(!index.latest_indexed(&room, &LatestEventValue::None));

    index
        .rooms
        .get_mut(&room)
        .expect("the room")
        .mark_classified(event_id!("$latest").to_owned(), 1);
    assert!(index.latest_indexed(&room, &latest));
}

#[async_test]
async fn test_a_switched_away_index_saves_in_the_background_before_its_account_restores() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!retired:localhost").to_owned();
    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(&client, JoinedRoomBuilder::new(&room_id))
        .await;
    let mut index = MessageIndex::new();
    index.rooms.insert(room_id.clone(), chunked_room(10));

    let (core, _events) = crate::Core::new(
        "search-retired",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    core.retire_search_index("first", &client, index).await;
    let gate = core.retiring_search.lock()["first"].clone();
    gate.try_lock().unwrap_err();
    core.settle_retired_search(Some("first")).await;

    let (restored, _restored_events) = crate::Core::new(
        "search-retired-restored",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    restored.restore_persisted_index(&client).await;
    assert_eq!(
        in_restored_room(
            &mut *restored.search_index.lock().await,
            &room_id,
            "message",
            50
        )
        .await
        .len(),
        10
    );

    drop(room);
}
