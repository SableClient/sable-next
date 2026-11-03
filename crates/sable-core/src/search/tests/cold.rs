use matrix_sdk::ruma::{event_id, room_id};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_test::async_test;

use super::{budgeted_room, document, in_room, logged_in, seed_room};
use crate::search::MessageIndex;

#[test]
fn test_a_cold_chunk_with_nothing_left_to_scan_finds_nothing() {
    let room = room_id!("!room:localhost").to_owned();
    let mut index = MessageIndex::new();
    index
        .rooms
        .insert(room.clone(), crate::search::RoomIndex::new());
    let filter = crate::search::IndexFilter::default();
    let stored = crate::search::persist::StoredChunk::new(Vec::new(), Vec::new());

    let (hits, total) = index.scan_cold(
        &room,
        &stored,
        "deploy",
        &filter,
        &crate::search::document::FoldedTerms::of(&filter, std::collections::HashSet::new()),
        crate::search::index::ColdWindow::all(1),
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
        let mut room_index = crate::search::RoomIndex::new();
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

    let crate::search::persist::ChunkRead::Found(stored) =
        crate::search::persist::load_chunk(&client, &room, oldest).await
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
        let mut room_index = crate::search::RoomIndex::new();
        for seed in 0..3_000_u64 {
            room_index.upsert(document(
                &format!("o{seed}"),
                &format!("archive entry w{seed}x"),
                "@kris:localhost",
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
    let filter = crate::search::IndexFilter::default();

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
            let mut room_index = crate::search::RoomIndex::new();
            for seed in 0..3_000_u64 {
                room_index.upsert(document(
                    &format!("{offset}c{seed}"),
                    &format!("archive entry w{seed}x"),
                    "@kris:localhost",
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
            let filter = crate::search::IndexFilter {
                rooms: scope.clone(),
                ..crate::search::IndexFilter::default()
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
            let expected = on_disk / 2 * scope.len().max(1) * if scope.is_empty() { 2 } else { 1 };
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

    let mut room_index = crate::search::RoomIndex::new();
    for chunk in 0..10_u32 {
        let start = u64::from(chunk) * 100;
        let body = if chunk == 0 { "the needle" } else { "hay" };
        let stored = crate::search::persist::StoredChunk::new(
            vec![document(
                &format!("c{chunk}"),
                body,
                "@kris:localhost",
                start + 1,
                None,
                Vec::new(),
            )],
            Vec::new(),
        );
        assert!(
            crate::search::persist::write_chunk(&client, &room, chunk, &stored)
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

    let filter = crate::search::IndexFilter::default();
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
