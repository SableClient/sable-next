use matrix_sdk::ruma::{event_id, room_id, user_id};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_test::{JoinedRoomBuilder, async_test, event_factory::EventFactory};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

use super::{logged_in, reingest_whole_room};

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
                        "sender": "@kris:localhost",
                        "origin_server_ts": 1_000,
                        "content": { "msgtype": "m.text", "body": "deploy notes from years ago" }
                    }
                }]
            }
        }
    })
}

fn scoped_to(room_id: &matrix_sdk::ruma::OwnedRoomId) -> crate::search::IndexFilter {
    crate::search::IndexFilter {
        rooms: vec![room_id.clone()],
        ..crate::search::IndexFilter::default()
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
    let sender = user_id!("@kris:localhost");
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
                    .sender(user_id!("@kris:localhost"))
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
                    .sender(user_id!("@kris:localhost"))
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

    let filter = crate::search::IndexFilter {
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
    let sender = user_id!("@kris:localhost");
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

    let filter = crate::search::IndexFilter {
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
