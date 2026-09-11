use std::{collections::HashMap, sync::Arc};

use matrix_sdk::{
    ruma::{room_id, serde::Raw},
    test_utils::mocks::MatrixMockServer,
};
use matrix_sdk_test::JoinedRoomBuilder;
use matrix_sdk_ui::{
    eyeball_im::VectorDiff, room_list_service::RoomListItem, sync_service::SyncService,
};
use serde_json::json;
use wiremock::{
    Mock, ResponseTemplate,
    matchers::{method, path},
};

use crate::{
    Core,
    protocol::{Command, CommandOk},
    session::Session,
    store::MemorySessionStore,
};

#[allow(clippy::unwrap_used)]
async fn core(server: &MatrixMockServer, client: matrix_sdk::Client) -> Arc<Core> {
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("helpers-test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".into(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });
    core
}

#[tokio::test]
async fn devices_without_uploaded_crypto_keys_remain_visible() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET")).and(path("/_matrix/client/v3/devices"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"devices": [
            {"device_id": "NO_KEYS", "display_name": "New phone", "last_seen_ts": 123, "last_seen_ip": "192.0.2.1"}
        ]}))).expect(1).mount(server.server()).await;
    let devices = crate::verification::own_devices(&client).await;
    let device = devices
        .iter()
        .find(|device| device.device_id == "NO_KEYS")
        .expect("server device is visible without crypto keys");
    assert!(!device.is_verified);
    assert_eq!(device.display_name.as_deref(), Some("New phone"));
    assert_eq!(device.last_seen_ts, Some(123));
}

#[tokio::test]
async fn image_pack_listing_fetches_complete_state_when_one_pack_is_cached() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!packs:example.org");
    let pack = |key: &str| {
        json!({
            "type": "im.ponies.room_emotes", "state_key": key, "sender": "@alice:example.org",
            "event_id": format!("${key}"), "origin_server_ts": 1,
            "content": {"images": {"wave": {"url": "mxc://example.org/wave"}}}
        })
    };
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_event(Raw::new(&pack("cached")).unwrap().cast_unchecked()),
        )
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{room_id}/state")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!([pack("cached"), pack("missing")])),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let CommandOk::ImagePacks { packs } = core
        .dispatch(Command::ImagePacks {
            room_id: room_id.to_owned(),
            cached_only: false,
        })
        .await
        .unwrap()
    else {
        panic!("wrong response")
    };
    assert_eq!(
        packs
            .iter()
            .map(|pack| pack.id.as_str())
            .collect::<Vec<_>>(),
        ["cached", "missing"]
    );
}

#[tokio::test]
async fn healthy_space_summary_does_not_fetch_missing_tombstone_state() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!space:example.org");
    server.sync_room(&client, JoinedRoomBuilder::new(room_id).add_state_event(
        Raw::new(&json!({"type": "m.room.create", "state_key": "", "sender": "@alice:example.org", "event_id": "$create", "origin_server_ts": 1,
            "content": {"type": "m.space", "room_version": "10", "creator": "@alice:example.org"}})).unwrap().cast_unchecked()
    )).await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/state/m.room.tombstone/"
        )))
        .respond_with(ResponseTemplate::new(404))
        .expect(0)
        .mount(server.server())
        .await;
    let item = RoomListItem::from(client.get_room(room_id).unwrap());
    let mut cache = HashMap::new();
    crate::view::enrich_room_fields(
        &VectorDiff::Set {
            index: 0,
            value: item.clone(),
        },
        &mut cache,
    )
    .await;
    let summary = crate::view::room_summary(&item, &cache);
    assert!(summary.is_space);
    assert!(!summary.is_tombstoned);
}

#[test]
fn space_child_ties_follow_ruma_room_id_order() {
    let events = ["!z:example.org", "!a:example.org"].map(|room| {
        Raw::new(&json!({
            "type": "m.space.child", "state_key": room, "origin_server_ts": 1, "sender": "@alice:example.org",
            "content": {"via": ["example.org"], "order": "same"}
        }))
        .unwrap()
        .cast_unchecked()
    });
    let edges = crate::view::hierarchy_child_edges(&events);
    assert_eq!(
        edges
            .iter()
            .map(|edge| edge.room_id.as_str())
            .collect::<Vec<_>>(),
        ["!a:example.org", "!z:example.org"]
    );
}

#[tokio::test]
async fn event_focus_keeps_explicit_sync_subscription_until_unsubscribed() {
    use crate::protocol::TimelineFocusView;
    use futures_util::StreamExt;
    use matrix_sdk::{ruma::event_id, test_utils::mocks::RoomContextResponseTemplate};
    use matrix_sdk_test::{ALICE, event_factory::EventFactory};
    use wiremock::matchers::path_regex;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!focus:example.org");
    let target = event_id!("$target");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    server
        .mock_room_event_context()
        .match_event_id()
        .ok(RoomContextResponseTemplate::new(
            EventFactory::new()
                .room(room_id)
                .sender(*ALICE)
                .text_msg("target")
                .event_id(target)
                .into_event(),
        ))
        .mount()
        .await;
    let core = core(&server, client).await;
    let CommandOk::SubscribeTimeline { subscription, .. } = core
        .dispatch(Command::SubscribeTimeline {
            room_id: room_id.to_owned(),
            focus: TimelineFocusView::Event {
                event_id: target.to_owned(),
            },
            hidden_events: false,
        })
        .await
        .unwrap()
    else {
        panic!("wrong response")
    };
    Mock::given(method("POST"))
        .and(path_regex(".*sync.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"pos": "p1", "rooms": {}})))
        .mount(server.server())
        .await;
    let sync = core.sync_service().await.unwrap();
    let room_list = sync.room_list_service();
    let stream = room_list.sync();
    futures_util::pin_mut!(stream);
    stream.next().await.unwrap().unwrap();
    let requests = server.server().received_requests().await.unwrap();
    let request = requests
        .iter()
        .rev()
        .find(|request| request.method == "POST" && request.url.path().contains("sync"))
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(
        body["room_subscriptions"][room_id.as_str()]["timeline_limit"],
        20
    );
    core.dispatch(Command::Unsubscribe { subscription })
        .await
        .unwrap();
    stream.next().await.unwrap().unwrap();
    let requests = server.server().received_requests().await.unwrap();
    let request = requests
        .iter()
        .rev()
        .find(|request| request.method == "POST" && request.url.path().contains("sync"))
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert!(body["room_subscriptions"].get(room_id.as_str()).is_none());
}

#[tokio::test]
async fn scheduled_listing_refreshes_credentials_and_omits_finalized_events() {
    use matrix_sdk::SessionTokens;
    use wiremock::matchers::header;
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .unlogged()
        .no_server_versions()
        .on_builder(matrix_sdk::ClientBuilder::handle_refresh_tokens)
        .build()
        .await;
    let mut session = matrix_sdk::test_utils::client::mock_matrix_session();
    session.tokens = SessionTokens {
        access_token: "expired".into(),
        refresh_token: Some("refresh".into()),
    };
    client
        .matrix_auth()
        .restore_session(session, matrix_sdk::store::RoomLoadSettings::default())
        .await
        .unwrap();
    Mock::given(method("GET"))
        .and(path("/_matrix/client/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"versions": ["v1.13"], "unstable_features": {"org.matrix.msc4140": true}}),
        ))
        .mount(server.server())
        .await;
    let endpoint = "/_matrix/client/unstable/org.matrix.msc4140/delayed_events";
    Mock::given(method("GET"))
        .and(path(endpoint))
        .and(header("authorization", "Bearer expired"))
        .respond_with(ResponseTemplate::new(401).set_body_json(
            json!({"errcode": "M_UNKNOWN_TOKEN", "error": "expired", "soft_logout": true}),
        ))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/refresh"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"access_token": "fresh", "refresh_token": "next"})),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let pending = json!({"delay_id": "pending", "room_id": "!room:example.org", "type": "m.room.message", "content": {"msgtype": "m.text", "body": "later", "format": "org.matrix.custom.html", "formatted_body": "<b>later</b>"}, "delay": 5000, "running_since": 1000});
    let mut finalized = pending.clone();
    finalized["delay_id"] = json!("done");
    finalized["finalised_ts"] = json!(6000);
    Mock::given(method("GET"))
        .and(path(endpoint))
        .and(header("authorization", "Bearer fresh"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"delayed_events": [pending, finalized]})),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let messages = core.scheduled_messages(None).await.unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].delay_id, "pending");
    assert_eq!(messages[0].body, "later");
}

#[tokio::test]
async fn cached_image_packs_return_without_waiting_for_room_state() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!cached-packs:example.org");
    let pack = json!({
        "type": "im.ponies.room_emotes", "state_key": "cached", "sender": "@alice:example.org",
        "event_id": "$cached-pack", "origin_server_ts": 1,
        "content": {"images": {"wave": {"url": "mxc://example.org/wave"}}}
    });
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_event(Raw::new(&pack).unwrap().cast_unchecked()),
        )
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{room_id}/state")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(std::time::Duration::from_secs(2))
                .set_body_json(json!([pack])),
        )
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let command = serde_json::from_value(
        json!({"type": "image_packs", "room_id": room_id, "cached_only": true}),
    )
    .unwrap();
    let response = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        core.dispatch(command),
    )
    .await
    .expect("cached emotes do not wait for the server")
    .unwrap();
    let CommandOk::ImagePacks { packs } = response else {
        panic!("wrong response")
    };
    assert_eq!(packs.len(), 1);
    assert_eq!(packs[0].id, "cached");
    assert!(
        !server
            .server()
            .received_requests()
            .await
            .unwrap()
            .iter()
            .any(|request| request.url.path().ends_with("/state"))
    );
}
