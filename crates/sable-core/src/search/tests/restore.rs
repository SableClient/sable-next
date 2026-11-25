use matrix_sdk::ruma::{event_id, room_id, user_id};
use matrix_sdk::test_utils::mocks::{MatrixMockServer, RoomMessagesResponseTemplate};
use matrix_sdk_test::{JoinedRoomBuilder, async_test, event_factory::EventFactory};

use super::{attachment_pages, document, in_restored_room, in_room, picture};
use crate::search::crawl::{CrawlBatch, CrawlOutcome};
use crate::search::{IndexFilter, MessageIndex};

fn store_id(directory: &tempfile::TempDir) -> String {
    directory.path().to_str().unwrap().to_owned()
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

    let (core, _events) = crate::test_support::signed_in_core(&server, client.clone()).await;
    let session = core.signed_in().unwrap();

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

    let reached_start = session.crawl_once(&room_id).await.expect("crawl one batch");
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

    let checkpoints = session.state().search_crawl.lock().checkpoints();
    assert_eq!(
        checkpoints
            .get(&room_id)
            .and_then(|room| room.token.clone())
            .as_deref(),
        Some("page-two"),
        "the next page's token is what a reload has to resume from"
    );

    // A fresh core, as after a reload: it must ask for the second page.
    let (next, _next_events) = crate::test_support::signed_in_core(&server, client.clone()).await;
    let next_session = next.signed_in().unwrap();
    next_session
        .state()
        .search_crawl
        .lock()
        .restore(checkpoints);

    server
        .mock_room_messages()
        .match_from("page-two")
        .ok(RoomMessagesResponseTemplate::default().events(vec![
            factory.text_msg("second page").event_id(event_id!("$two")),
        ]))
        .mock_once()
        .mount()
        .await;

    let reached_start = next_session
        .crawl_once(&room_id)
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

    let session_state = next_session.state();
    let hits = in_room(
        &*session_state.search_index.lock().await,
        &room_id,
        "second",
        10,
        0,
    );
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].event_id, event_id!("$two"));

    drop(room);
}

#[async_test]
async fn test_chinese_search_survives_a_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let room = room_id!("!chinese:localhost").to_owned();
    {
        let index = MessageIndex::with_store(
            crate::search::store::Store::open_account(&store_id(&directory)).await,
        );
        index.upsert(
            &room,
            document(
                "zh",
                "今天我们一起讨论中文搜索功能",
                "@kris:localhost",
                1,
                None,
                Vec::new(),
            ),
        );
    }

    let index = MessageIndex::with_store(
        crate::search::store::Store::open_account(&store_id(&directory)).await,
    );
    let hits = index
        .search_pinned(
            "搜索",
            &IndexFilter {
                words: vec!["搜索".to_owned()],
                ..IndexFilter::default()
            },
            std::collections::HashSet::new(),
            crate::api::search::SearchOrder::Rank,
            10,
            0,
        )
        .await;

    assert_eq!(hits.len(), 1);
}

#[async_test]
async fn test_a_reopened_index_lists_media_without_the_event_cache() {
    let directory = tempfile::tempdir().unwrap();
    let room = room_id!("!gallery:localhost").to_owned();
    {
        let index = MessageIndex::with_store(
            crate::search::store::Store::open_account(&store_id(&directory)).await,
        );
        index.upsert(&room, picture("kept", "@kris:localhost", 1));
    }

    let index = MessageIndex::with_store(
        crate::search::store::Store::open_account(&store_id(&directory)).await,
    );

    assert_eq!(attachment_pages(&index, &room, &[], 10), [vec!["$kept"]]);
}

#[async_test]
async fn test_a_room_left_between_sessions_is_wiped_at_open() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let directory = tempfile::tempdir().unwrap();
    let left = room_id!("!left:localhost").to_owned();
    let kept = room_id!("!kept:localhost").to_owned();
    server
        .sync_room(&client, matrix_sdk_test::LeftRoomBuilder::new(&left))
        .await;
    {
        let index = MessageIndex::with_store(
            crate::search::store::Store::open_account(&store_id(&directory)).await,
        );
        index.upsert(&left, picture("gone", "@kris:localhost", 1));
        index.upsert(&kept, picture("stays", "@kris:localhost", 1));
    }

    let (core, _events) = crate::Core::new(
        "search-left-room",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    crate::test_support::sign_in(&core, &server, client.clone()).await;
    let session = core.signed_in().unwrap();
    session.open_search_index(&store_id(&directory)).await;

    let session_state = session.state();
    let index = session_state.search_index.lock().await;
    assert_eq!(index.rooms().await, [kept]);
    assert_eq!(index.documents().await, 1);
}

#[async_test]
async fn test_an_index_is_searchable_in_the_next_session() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let directory = tempfile::tempdir().unwrap();

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
    crate::test_support::sign_in(&first, &server, client.clone()).await;
    let first_session = first.signed_in().unwrap();
    first_session.open_search_index(&store_id(&directory)).await;
    first_session.prime_persisted_rooms().await;
    assert_eq!(
        in_room(
            &*first_session.state().search_index.lock().await,
            &room_id,
            "archaeology",
            10,
            0
        )
        .len(),
        1
    );
    drop(first);

    let (second, _second_events) = crate::Core::new(
        "search-persist-second",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    crate::test_support::sign_in(&second, &server, client.clone()).await;
    let second_session = second.signed_in().unwrap();
    second_session
        .open_search_index(&store_id(&directory))
        .await;

    let hits = in_restored_room(
        &*second_session.state().search_index.lock().await,
        &room_id,
        "archaeology",
        10,
    )
    .await;
    assert_eq!(
        hits.len(),
        1,
        "a reopened session must find what was crawled"
    );
    assert_eq!(hits[0].event_id, event_id!("$crawled"));

    drop(room);
}

#[async_test]
async fn test_a_room_whose_latest_event_is_classified_needs_no_priming() {
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

    let index = MessageIndex::new();
    assert!(!index.latest_indexed(&room, &latest).await);

    index.ensure_room(&room);
    assert!(!index.latest_indexed(&room, &latest).await);
    assert!(!index.latest_indexed(&room, &LatestEventValue::None).await);

    index.mark_classified(&room, event_id!("$latest"), 1);
    assert!(index.latest_indexed(&room, &latest).await);
}

#[async_test]
async fn test_a_closed_database_keeps_its_rooms_after_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let room = room_id!("!suspended:localhost").to_owned();
    let index = MessageIndex::with_store(
        crate::search::store::Store::open_account(&store_id(&directory)).await,
    );
    index.upsert(
        &room,
        document(
            "one",
            "kept across suspension",
            "@kris:localhost",
            1,
            None,
            Vec::new(),
        ),
    );

    index.store().close().await;
    index.store().rooms().await.unwrap_err();

    index.store().reopen().await;
    assert_eq!(index.store().rooms().await.unwrap(), vec![room]);
}
