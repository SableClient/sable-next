use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{
    EventId, event_id, events::room::message::RoomMessageEventContentWithoutRelation, room_id,
    user_id,
};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_test::{JoinedRoomBuilder, async_test, event_factory::EventFactory};
use serde_json::json;
use std::sync::Arc;

use super::{document, filtered_index, in_room, logged_in, reingest_whole_room};
use crate::search::MessageIndex;

pub(super) async fn empty_cache(
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
        &crate::search::IndexFilter::default(),
        crate::api::search::SearchOrder::Rank,
        10,
        0,
    );
    hits.extend(index.search(
        "finished",
        &crate::search::IndexFilter::default(),
        crate::api::search::SearchOrder::Rank,
        10,
        0,
    ));

    index.fill_context(
        &mut hits,
        &[matrix_sdk::ruma::user_id!("@troll:localhost").to_owned()],
        1,
    );

    let ids = |lines: &[crate::search::ContextLine]| {
        lines
            .iter()
            .map(|line| line.event_id.to_string())
            .collect::<Vec<_>>()
    };
    assert!(hits[0].before.is_empty());
    assert_eq!(ids(&hits[0].after), ["$alice"]);
    assert_eq!(ids(&hits[1].before), ["$kris"]);
    assert_eq!(ids(&hits[1].after), ["$screenshot"]);
}

#[test]
fn test_a_cache_refill_costs_nothing_when_the_index_already_holds_it() {
    use crate::search::{MessageIndex, RoomIndex};
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
async fn test_reindexing_a_classified_cache_does_not_reload_it_from_storage() {
    use std::time::Duration;

    use matrix_sdk::config::StoreConfig;
    use matrix_sdk_base::event_cache::store::ControlledMemoryStore;
    use matrix_sdk_common::cross_process_lock::CrossProcessLockConfig;

    let server = MatrixMockServer::new().await;
    let store = ControlledMemoryStore::new();
    let client = server
        .client_builder()
        .on_builder(|builder| {
            builder.store_config(
                StoreConfig::new(CrossProcessLockConfig::SingleProcess)
                    .event_cache_store(Arc::new(store.clone())),
            )
        })
        .build()
        .await;
    let room_id = room_id!("!classified:localhost").to_owned();
    let factory = EventFactory::new()
        .room(&room_id)
        .sender(user_id!("@kris:localhost"));
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(&room_id).add_timeline_event(
                factory
                    .text_msg("already searchable")
                    .event_id(event_id!("$classified")),
            ),
        )
        .await;
    store.wait_for_write_to_finish().await;

    let (cache, _handles) = client.event_cache().unwrap().room(&room_id).await.unwrap();
    let (core, _events) = crate::Core::new(
        "search-classified",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;
    store.wait_for_write_to_start().await;
    store.fail_next_last_chunk_load();

    core.prime_persisted_rooms(&client).await;
    core.prime_persisted_rooms(&client).await;

    assert!(
        tokio::time::timeout(Duration::from_millis(200), store.wait_for_write_to_start())
            .await
            .is_err(),
        "a no-op indexing pass must not reload the cache and clear it on a storage read failure"
    );
    assert_eq!(cache.events().await.unwrap().len(), 1);
    assert_eq!(
        in_room(
            &*core.search_index.lock().await,
            &room_id,
            "searchable",
            10,
            0
        )
        .len(),
        1
    );
}

#[async_test]
async fn test_a_room_with_no_new_activity_is_indexed_from_its_persisted_cache() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;

    let room_id = room_id!("!quiet:localhost").to_owned();
    let factory = EventFactory::new()
        .room(&room_id)
        .sender(user_id!("@kris:localhost"));

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
async fn test_an_encrypted_rooms_plaintext_is_searchable_and_edits_replace_the_body() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;

    let room_id = room_id!("!search:localhost").to_owned();
    let original_id = event_id!("$original");
    let edit_id = event_id!("$edit");

    let room = server.sync_joined_room(&client, &room_id).await;
    let factory = EventFactory::new()
        .room(&room_id)
        .sender(user_id!("@kris:localhost"));

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
                        RoomMessageEventContentWithoutRelation::text_plain("the rollback finished"),
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
        .sender(user_id!("@kris:localhost"));

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
        .sender(user_id!("@kris:localhost"));
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
                &crate::search::IndexFilter {
                    in_thread: Some(wanted),
                    ..crate::search::IndexFilter::default()
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
        .sender(user_id!("@kris:localhost"));

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
        .sender(user_id!("@kris:localhost"));

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

    let ids = |hits: Vec<crate::search::Hit>| {
        hits.into_iter().map(|hit| hit.event_id).collect::<Vec<_>>()
    };

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
        .sender(user_id!("@kris:localhost"));

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
                &crate::search::IndexFilter::default(),
                crate::api::search::SearchOrder::Rank,
                10,
                0,
            )
            .is_empty()
    );

    drop(room);
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

    let kept = crate::search::document::edited_document(
        &encrypted,
        std::slice::from_ref(&edit),
        &redacted,
    )
    .expect("a document");
    assert_eq!(kept.body, "hello");
    assert_eq!(kept.edited_at, None);

    let applied =
        crate::search::document::edited_document(&plain, std::slice::from_ref(&edit), &redacted)
            .expect("a document");
    assert_eq!(applied.body, "forged");
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
        .sender(user_id!("@kris:localhost"));

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
        &crate::search::IndexFilter {
            mentions: vec![alice.to_owned()],
            ..crate::search::IndexFilter::default()
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
        .sender(user_id!("@kris:localhost"));

    let mut index = MessageIndex::new();
    index
        .ingest(
            &room_id,
            vec![
                factory
                    .text_msg("* the rollback finished")
                    .edit(
                        original_id,
                        RoomMessageEventContentWithoutRelation::text_plain("the rollback finished"),
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
    let kris = user_id!("@kris:localhost");
    let (room, cache, _drop) = empty_cache(&server, &client, &room_id).await;
    let factory = EventFactory::new().room(&room_id);

    let original = || {
        factory
            .text_msg("the deploy is green")
            .sender(kris)
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
        assert_eq!(hits[0].sender, kris);
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
        .sender(user_id!("@kris:localhost"));

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
            JoinedRoomBuilder::new(&room_id)
                .add_timeline_event(factory.redaction(edit_id).event_id(event_id!("$redaction"))),
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

#[async_test]
async fn test_a_live_pass_applies_an_edit_that_arrives_with_its_original() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!live:localhost").to_owned();
    let original_id = event_id!("$original");
    let room = server.sync_joined_room(&client, &room_id).await;
    let factory = EventFactory::new()
        .room(&room_id)
        .sender(user_id!("@kris:localhost"));

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
                        .event_id(event_id!("$edit")),
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

    assert!(in_room(&index, &room_id, "deploy", 10, 0).is_empty());
    let hits = in_room(&index, &room_id, "rollback", 10, 0);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].event_id, original_id);

    drop(room);
}
