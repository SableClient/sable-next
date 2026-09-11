use std::time::Duration;

use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_test::async_test;
use ruma::room_id;
use serde_json::json;
use wiremock::{
    Mock, ResponseTemplate,
    matchers::{method, path_regex},
};

use super::{StickySync, send, send_delayed};

async fn room() -> (MatrixMockServer, matrix_sdk::Room) {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = server
        .sync_joined_room(&client, room_id!("!sticky:example.org"))
        .await;
    (server, room)
}

#[async_test]
async fn test_send_includes_sticky_duration_and_raw_content() {
    let (server, room) = room().await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/rooms/.*/send/m\.rtc\.member/.*"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"event_id": "$sent:example.org"})),
        )
        .mount(server.server())
        .await;

    send(
        &room.client(),
        &room,
        json!({
            "msc4354_sticky_key": "call",
        }),
    )
    .await
    .expect("sticky send");

    let request = server
        .received_requests()
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|request| request.url.path().contains("/send/m.rtc.member/"))
        .expect("send request");
    assert_eq!(request.method, "PUT");
    assert_eq!(request.headers.get("authorization").unwrap(), "Bearer 1234");
    assert_eq!(
        request
            .url
            .query_pairs()
            .find(|(key, _)| key == "org.matrix.msc4354.sticky_duration_ms")
            .unwrap()
            .1,
        "900000"
    );
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(body["msc4354_sticky_key"], "call");
}

#[async_test]
async fn test_delayed_send_includes_delay_and_sticky_duration() {
    let (server, room) = room().await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/rooms/.*/send/m\.rtc\.member/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"delay_id": "$delay"})))
        .mount(server.server())
        .await;

    send_delayed(
        &room.client(),
        &room,
        json!({"msc4354_sticky_key": "call"}),
        Duration::from_secs(20),
    )
    .await
    .expect("delayed sticky send");

    let request = server
        .received_requests()
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|request| request.url.path().contains("/send/m.rtc.member/"))
        .expect("delayed send request");
    let query = request.url.query_pairs().collect::<Vec<_>>();
    assert!(query.contains(&("org.matrix.msc4140.delay".into(), "20000".into())));
    assert!(query.contains(&(
        "org.matrix.msc4354.sticky_duration_ms".into(),
        "900000".into()
    )));
    assert_eq!(request.headers.get("authorization").unwrap(), "Bearer 1234");
}

#[async_test]
async fn test_sticky_sync_sends_bounded_extensions_and_parses_both_event_locations() {
    let (server, room) = room().await;
    Mock::given(method("POST"))
        .and(path_regex(".*sync.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "pos": "p1",
            "rooms": { room.room_id().as_str(): { "timeline": [{"type":"m.room.message","event_id":"$timeline","sender":"@a:example.org","origin_server_ts":1,"content":{}}] } },
            "extensions": { "org.matrix.msc4354.sticky_events": { "next_batch":"s1", "rooms": { room.room_id().as_str(): { "events": [{"type":"m.room.message","event_id":"$sticky","sender":"@a:example.org","origin_server_ts":1,"content":{}}] } } } }
        })))
        .mount(server.server())
        .await;

    let mut sync = StickySync::new(42);
    let events = sync
        .sync(&room, Duration::from_secs(1))
        .await
        .expect("sticky sync");
    assert_eq!(events.len(), 2);

    let request = server
        .received_requests()
        .await
        .unwrap_or_default()
        .into_iter()
        .find(|request| request.method == "POST" && request.url.path().contains("sync"))
        .expect("sync request");
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(body["conn_id"], "call-42");
    assert_eq!(
        body["room_subscriptions"][room.room_id().as_str()]["timeline_limit"],
        0
    );
    assert_eq!(body["extensions"]["to_device"]["enabled"], false);
    assert_eq!(
        body["extensions"]["org.matrix.msc4354.sticky_events"]["enabled"],
        true
    );
}

#[async_test]
async fn test_sticky_sync_reuses_since_when_incremental_response_is_empty() {
    let (server, room) = room().await;
    Mock::given(method("POST"))
        .and(path_regex(".*sync.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "pos": "p1",
            "extensions": {"org.matrix.msc4354.sticky_events": {"next_batch": "s1"}}
        })))
        .expect(1)
        .up_to_n_times(1)
        .with_priority(1)
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path_regex(".*sync.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "pos": "p2",
            "extensions": {"org.matrix.msc4354.sticky_events": {}}
        })))
        .mount(server.server())
        .await;
    let mut sync = StickySync::new(1);
    sync.sync(&room, Duration::from_secs(1))
        .await
        .expect("initial sync");
    sync.sync(&room, Duration::from_secs(1))
        .await
        .expect("incremental sync");
    sync.sync(&room, Duration::from_secs(1))
        .await
        .expect("empty incremental sync");

    let received = server
        .received_requests()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|request| request.method == "POST" && request.url.path().contains("sync"))
        .collect::<Vec<_>>();
    assert_eq!(received.len(), 3);
    assert!(
        received[0]
            .url
            .query_pairs()
            .find(|(key, _)| key == "pos")
            .is_none()
    );
    assert_eq!(
        received[1]
            .url
            .query_pairs()
            .find(|(key, _)| key == "pos")
            .unwrap()
            .1,
        "p1"
    );
    let second: serde_json::Value = serde_json::from_slice(&received[1].body).unwrap();
    assert_eq!(
        second["extensions"]["org.matrix.msc4354.sticky_events"]["since"],
        "s1"
    );
    let third: serde_json::Value = serde_json::from_slice(&received[2].body).unwrap();
    assert_eq!(
        third["extensions"]["org.matrix.msc4354.sticky_events"]["since"],
        "s1"
    );
}

#[async_test]
async fn test_sticky_sync_accepts_an_empty_initial_extension_and_keeps_its_position() {
    let (server, room) = room().await;
    Mock::given(method("POST"))
        .and(path_regex(".*sync.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"pos":"p1","rooms":{}})))
        .expect(1)
        .up_to_n_times(1)
        .with_priority(1)
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path_regex(".*sync.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "pos":"p2",
            "extensions": {"org.matrix.msc4354.sticky_events": {"next_batch":"s2"}}
        })))
        .mount(server.server())
        .await;
    let mut sync = StickySync::new(2);
    sync.sync(&room, Duration::from_secs(1))
        .await
        .expect("empty initial sync");
    sync.sync(&room, Duration::from_secs(1))
        .await
        .expect("token sync");

    let requests = server
        .received_requests()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|request| request.method == "POST" && request.url.path().contains("sync"))
        .collect::<Vec<_>>();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1]
            .url
            .query_pairs()
            .find(|(key, _)| key == "pos")
            .unwrap()
            .1,
        "p1"
    );
    let second: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert!(
        second["extensions"]["org.matrix.msc4354.sticky_events"]
            .get("since")
            .is_none()
    );
}

#[async_test]
async fn test_delayed_send_refreshes_expired_credentials_and_preserves_sticky_query() {
    use matrix_sdk::{SessionTokens, authentication::matrix::MatrixSession};
    use wiremock::matchers::{header, path};

    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .unlogged()
        .on_builder(matrix_sdk::ClientBuilder::handle_refresh_tokens)
        .build()
        .await;
    let mut session: MatrixSession = matrix_sdk::test_utils::client::mock_matrix_session();
    session.tokens = SessionTokens {
        access_token: "expired".into(),
        refresh_token: Some("refresh".into()),
    };
    client
        .matrix_auth()
        .restore_session(session, matrix_sdk::store::RoomLoadSettings::default())
        .await
        .unwrap();
    let room = server
        .sync_joined_room(&client, room_id!("!sticky:example.org"))
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/rooms/.*/send/m\.rtc\.member/.*"))
        .and(header("authorization", "Bearer expired"))
        .respond_with(ResponseTemplate::new(401).set_body_json(
            json!({"errcode":"M_UNKNOWN_TOKEN", "error":"expired", "soft_logout":true}),
        ))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/refresh"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"access_token":"fresh", "refresh_token":"new-refresh"})),
        )
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/rooms/.*/send/m\.rtc\.member/.*"))
        .and(header("authorization", "Bearer fresh"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"delay_id":"cleanup"})))
        .expect(1)
        .mount(server.server())
        .await;
    assert_eq!(
        send_delayed(
            &client,
            &room,
            json!({"msc4354_sticky_key":"call"}),
            Duration::from_secs(20)
        )
        .await
        .unwrap(),
        "cleanup"
    );
    let requests = server.received_requests().await.unwrap();
    let sends: Vec<_> = requests
        .iter()
        .filter(|request| request.url.path().contains("/send/m.rtc.member/"))
        .collect();
    assert_eq!(sends.len(), 2);
    assert_eq!(sends[0].url, sends[1].url);
    assert_eq!(sends[0].body, sends[1].body);
    assert!(
        sends[1].url.query_pairs().any(|(key, value)| key
            == "org.matrix.msc4354.sticky_duration_ms"
            && value == "900000")
    );
}
