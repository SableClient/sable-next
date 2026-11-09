use matrix_sdk::ruma::{EventId, event_id, room_id, user_id};
use matrix_sdk::test_utils::mocks::{MatrixMockServer, RoomMessagesResponseTemplate};
use matrix_sdk_test::{JoinedRoomBuilder, async_test, event_factory::EventFactory};
use std::time::Duration;

use super::{in_room, reingest_whole_room};
use crate::search::MessageIndex;
use crate::search::crawl::{CrawlBatch, CrawlOutcome};

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

#[async_test]
async fn test_search_watcher_releases_paginated_room_cache() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!retention:localhost").to_owned();
    let factory = EventFactory::new()
        .room(&room_id)
        .sender(user_id!("@kris:localhost"));
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
    core.watch_search_index("", &client, "");
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
        .sender(user_id!("@kris:localhost"));

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
async fn test_the_crawler_deepens_a_room_and_records_reaching_its_start() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;

    let room_id = room_id!("!crawl:localhost").to_owned();
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

#[async_test]
async fn test_a_restored_room_does_not_charge_the_crawl_budget_again() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;

    let room_id = room_id!("!budget:localhost").to_owned();
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
                    .sender(user_id!("@kris:localhost"))
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
        .sender(user_id!("@kris:localhost"))
        .server_ts(crate::search::now_ms());

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
                        .sender(user_id!("@kris:localhost"))
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
                        .sender(user_id!("@kris:localhost"))
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
                        .sender(user_id!("@kris:localhost"))
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
                .sender(user_id!("@kris:localhost"))
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
