use super::{RelationsFilter, managers_from_account_data, managers_from_well_known};
use crate::{
    Core,
    api::calls::RtcLivekitEndpoint,
    api::room_state::SendEventParams,
    protocol::{CoreEvent, RpcCode, RpcError},
    session::Session,
    store::MemorySessionStore,
};
use matrix_sdk::{ruma::room_id, test_utils::mocks::MatrixMockServer};
use matrix_sdk_test::JoinedRoomBuilder;
use matrix_sdk_ui::sync_service::SyncService;
use serde_json::json;
use std::{sync::Arc, time::Duration};
use wiremock::{
    Mock, ResponseTemplate,
    matchers::{body_json, header, method, path, path_regex, query_param},
};

#[test]
fn an_invalid_directory_user_does_not_fail_the_search() {
    use ruma::api::IncomingResponseExt as _;

    let body = json!({
        "results": [
            {"user_id": "@first:example.org", "display_name": "First"},
            {"user_id": "@broken:not a server"},
            {"user_id": "@fine:example.org"},
        ],
        "limited": true,
    })
    .to_string();

    let response = super::lenient_user_directory::Response::try_from_http_response(
        http::Response::new(body.as_bytes()),
    )
    .expect("the search parses");
    let users: Vec<_> = super::directory_entries(&response.results)
        .into_iter()
        .map(|user| user.user_id)
        .collect();

    assert_eq!(users, ["@first:example.org", "@fine:example.org"]);
    assert!(response.limited);
}

#[tokio::test]
async fn widget_sends_return_the_created_event_id() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!widgets:example.org");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    Mock::given(method("PUT"))
        .and(path_regex(
            "/_matrix/client/v3/rooms/.*/(send|state|redact)/.*",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$created"})))
        .expect(3)
        .mount(server.server())
        .await;
    let (core, _events) = Core::new("widgets", Box::new(MemorySessionStore::default()));
    crate::test_support::set_session(
        &core,
        Some(Session {
            account_id: "widgets".to_owned(),
            homeserver: server.server().uri(),
            oauth: false,
            state: Arc::default(),
            sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
            client,
        }),
    );
    let sent = Box::pin(core.run(crate::api::messages::SendRawEventParams {
        persona: None,
        room_id: room_id.to_owned(),
        event_type: "com.example.message".to_owned(),
        content: json!({}),
    }))
    .await
    .unwrap();
    assert_eq!(sent, "$created");
    let redaction = Box::pin(core.run(crate::api::messages::SendRedactionParams {
        room_id: room_id.to_owned(),
        event_id: "$target".try_into().unwrap(),
        reason: None,
    }))
    .await
    .unwrap();
    assert_eq!(redaction, "$created");
    let event_id = core
        .run(SendEventParams {
            room_id: room_id.to_owned(),
            event_type: "com.example.state".to_owned(),
            state_key: String::new(),
            content: json!({}),
        })
        .await
        .unwrap();
    assert_eq!(event_id, "$created");
}

async fn core_with(server: &MatrixMockServer, client: matrix_sdk::Client) -> Arc<Core> {
    crate::test_support::signed_in_core(server, client).await.0
}

async fn delayed_events_server() -> (MatrixMockServer, matrix_sdk::Client) {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().no_server_versions().build().await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"versions": ["v1.13"], "unstable_features": {"org.matrix.msc4140": true}}),
        ))
        .mount(server.server())
        .await;
    (server, client)
}

#[tokio::test]
async fn a_stable_only_server_offers_no_user_scheduling_because_it_cannot_list() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().no_server_versions().build().await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "versions": ["v1.13"],
            "unstable_features": {"org.matrix.msc4140.stable": true}
        })))
        .mount(server.server())
        .await;
    let room_id = room_id!("!stable:example.org");
    server.sync_joined_room(&client, room_id).await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    assert!(!session.scheduling_supported().await.unwrap());
    assert!(matches!(
        session
            .schedule_message(
                &room_id.to_owned(),
                ruma::events::room::message::RoomMessageEventContent::text_plain("later"),
                5000,
                None,
            )
            .await,
        Err(RpcError {
            code: RpcCode::DelayedEventsUnsupported,
            ..
        })
    ));
    assert!(session.delayed_events_support().await.unwrap().any());
}

#[tokio::test]
async fn a_delayed_state_event_carries_the_delay() {
    let (server, client) = delayed_events_server().await;
    let room_id = room_id!("!delayed:example.org");
    server.sync_joined_room(&client, room_id).await;
    Mock::given(method("PUT"))
        .and(path_regex(
            "/_matrix/client/v3/rooms/.*/state/com.example.state/key",
        ))
        .and(query_param("org.matrix.msc4140.delay", "5000"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"delay_id": "d1"})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    let delay_id = session
        .widget_send_delayed_event(
            &room_id.to_owned(),
            "com.example.state",
            Some("key".to_owned()),
            json!({"a": 1}),
            5000,
            None,
        )
        .await
        .unwrap();

    assert_eq!(delay_id, "d1");
}

#[tokio::test]
async fn encrypted_delayed_events_are_rejected() {
    let (server, client) = delayed_events_server().await;
    let room_id = room_id!("!sticky:example.org");
    server.sync_joined_room(&client, room_id).await;
    server
        .mock_room_state_encryption()
        .encrypted()
        .mount()
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    let refused = session
        .widget_send_delayed_event(
            &room_id.to_owned(),
            "org.matrix.msc4143.rtc.member",
            None,
            json!({}),
            5000,
            Some(60_000),
        )
        .await;
    assert!(matches!(
        refused,
        Err(RpcError {
            code: RpcCode::EncryptedScheduleUnsupported,
            ..
        })
    ));

    let refused = session
        .widget_send_delayed_event(
            &room_id.to_owned(),
            "com.example.secret",
            None,
            json!({}),
            5000,
            Some(60_000),
        )
        .await;
    assert!(matches!(
        refused,
        Err(RpcError {
            code: RpcCode::EncryptedScheduleUnsupported,
            ..
        })
    ));
    let refused = session
        .widget_send_delayed_event(
            &room_id.to_owned(),
            "com.example.secret",
            None,
            json!({}),
            5000,
            None,
        )
        .await;
    assert!(matches!(
        refused,
        Err(RpcError {
            code: RpcCode::EncryptedScheduleUnsupported,
            ..
        })
    ));
}

#[tokio::test]
async fn a_sticky_event_carries_its_duration() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!sticky:example.org");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    Mock::given(method("PUT"))
        .and(path_regex(
            "/_matrix/client/v3/rooms/.*/send/com.example.sticky/.*",
        ))
        .and(query_param(
            "org.matrix.msc4354.sticky_duration_ms",
            "30000",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$sticky"})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    let sent = session
        .widget_send_sticky_event(&room_id.to_owned(), "com.example.sticky", json!({}), 30_000)
        .await
        .unwrap();

    assert_eq!(sent, "$sticky");
}

#[tokio::test]
async fn restarting_a_delayed_event_posts_the_restart_action() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("POST"))
        .and(path_regex(
            "/_matrix/client/unstable/org.matrix.msc4140/delayed_events/d3",
        ))
        .and(body_json(json!({"action": "restart"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    session
        .restart_delayed_event(crate::api::widgets::RestartDelayedEventParams {
            delay_id: "d3".to_owned(),
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn relations_come_back_with_their_room_id_and_the_event_type_filter() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!relations:example.org");
    server.sync_joined_room(&client, room_id).await;
    Mock::given(method("GET"))
        .and(path_regex(
            "/_matrix/client/v1/rooms/.*/relations/.*/m.thread",
        ))
        .and(query_param("limit", "5"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "chunk": [
                {"type": "m.room.message", "event_id": "$a", "content": {}},
                {"type": "m.reaction", "event_id": "$b", "content": {}},
            ],
            "next_batch": "next"
        })))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    let relations = session
        .room_event_relations(
            &room_id.to_owned(),
            &"$parent".try_into().unwrap(),
            RelationsFilter {
                rel_type: Some("m.thread"),
                event_type: Some("m.room.message"),
                from: None,
                to: None,
                limit: Some(5),
                direction: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(relations.chunk.len(), 1);
    assert_eq!(relations.chunk[0]["event_id"], "$a");
    assert_eq!(relations.chunk[0]["room_id"], room_id.as_str());
    assert_eq!(relations.next_batch.as_deref(), Some("next"));
    assert!(relations.prev_batch.is_none());
}

#[tokio::test]
async fn turn_credentials_report_their_lifetime_in_milliseconds() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/voip/turnServer"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "username": "u", "password": "p", "uris": ["turn:example.org"], "ttl": 86400
        })))
        .mount(server.server())
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    let server = session.turn_server().await.unwrap();

    assert_eq!(server.username, "u");
    assert_eq!(server.uris, ["turn:example.org"]);
    assert_eq!(server.ttl_ms, 86_400_000);
}

#[tokio::test]
async fn a_homeserver_without_turn_has_no_servers() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/voip/turnServer"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(server.server())
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    let server = session.turn_server().await.unwrap();

    assert_eq!(server.uris, Vec::<String>::new());
}

#[tokio::test]
async fn rtc_transports_are_relayed_as_the_homeserver_describes_them() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET"))
            .and(path("/_matrix/client/unstable/org.matrix.msc4143/rtc/transports"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "rtc_transports": [{"type": "livekit", "livekit_service_url": "https://sfu.example.org"}]
            })))
            .mount(server.server())
            .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    assert_eq!(
        session.rtc_transports().await.unwrap(),
        json!({"rtc_transports": [{"type": "livekit", "livekit_service_url": "https://sfu.example.org"}]})
    );
}

#[tokio::test]
async fn the_livekit_requests_carry_the_widget_body_verbatim() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let request = json!({"room_id": "!r:example.org", "slot_id": "m.call#ROOM", "extra": [1, 2]});
    Mock::given(method("POST"))
        .and(path(
            "/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token",
        ))
        .and(body_json(request.clone()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"jwt": "token"})))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path(
            "/_matrix/client/unstable/io.element.msc4195/rtc/livekit/delegate_delayed_leave",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    assert_eq!(
        session
            .rtc_livekit(RtcLivekitEndpoint::GetToken, &request)
            .await
            .unwrap(),
        json!({"jwt": "token"})
    );
    assert_eq!(
        session
            .rtc_livekit(RtcLivekitEndpoint::DelegateDelayedLeave, &json!({}))
            .await
            .unwrap(),
        json!({})
    );
}

#[tokio::test]
async fn a_missing_livekit_endpoint_reads_as_unsupported() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("POST"))
        .respond_with(
            ResponseTemplate::new(404).set_body_json(
                json!({"errcode": "M_UNRECOGNIZED", "error": "Unrecognized request"}),
            ),
        )
        .mount(server.server())
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    let result = session
        .rtc_livekit(RtcLivekitEndpoint::GetToken, &json!({}))
        .await;

    assert!(matches!(
        result,
        Err(RpcError {
            code: RpcCode::Unsupported,
            ..
        })
    ));
}

#[tokio::test]
async fn a_clear_to_device_message_goes_out_in_one_request_and_internal_types_are_dropped() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("PUT"))
        .and(path_regex(
            "/_matrix/client/v3/sendToDevice/com.example.ping/.*",
        ))
        .and(body_json(
            json!({"messages": {"@a:example.org": {"*": {"n": 1}}}}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    session
        .widget_send_to_device(
            "com.example.ping",
            false,
            json!({"@a:example.org": {"*": {"n": 1}}}),
        )
        .await
        .unwrap();

    session
        .widget_send_to_device(
            "m.room_key_request",
            false,
            json!({"@a:example.org": {"*": {}}}),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn an_encrypted_to_device_message_to_an_unknown_device_sends_nothing() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    session
        .widget_send_to_device(
            "com.example.ping",
            true,
            json!({"@a:example.org": {"DEVICE": {"n": 1}}}),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn sticky_reads_come_from_the_sdk_sticky_map() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!stickyread:example.org");
    server.sync_joined_room(&client, room_id).await;
    let now = crate::now_ms();
    let mut response = ruma::api::client::sync::sync_events::msc4186::Response::new("1".to_owned());
    let mut sticky_room =
        ruma::api::client::sync::sync_events::msc4186::response::StickyEventsRoom::default();
    sticky_room.events.push(
        ruma::serde::Raw::new(&json!({
            "type": "com.example.presence", "event_id": "$sticky", "sender": "@a:example.org",
            "origin_server_ts": now, "msc4354_sticky": {"duration_ms": 600_000},
            "content": {"msc4354_sticky_key": "slot", "status": "here"}
        }))
        .unwrap()
        .cast_unchecked(),
    );
    response
        .extensions
        .sticky_events
        .rooms
        .insert(room_id.to_owned(), sticky_room);
    client
        .process_sliding_sync_test_helper(
            &response,
            &matrix_sdk_base::RequestedRequiredStates::default(),
        )
        .await
        .unwrap();
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    let events = session.room_sticky_events(&room_id.to_owned()).unwrap();

    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event_id"], "$sticky");
    assert_eq!(events[0]["room_id"], room_id.as_str());
}

#[tokio::test]
async fn the_feed_forwards_synced_events_only_while_it_is_on() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let (core, mut events) = Core::new("widgets", Box::new(MemorySessionStore::default()));
    crate::test_support::sign_in(&core, &server, client.clone()).await;
    let session = core.signed_in().unwrap();
    session.watch_widget_feed(1);
    let room_id = room_id!("!feed:example.org");
    let event = |id: &str| {
        ruma::serde::Raw::new(&json!({
            "type": "com.example.thing", "event_id": id, "sender": "@a:example.org",
            "origin_server_ts": 1, "content": {}
        }))
        .unwrap()
        .cast_unchecked::<ruma::events::AnySyncTimelineEvent>()
    };

    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(event("$off")),
        )
        .await;
    tokio::time::timeout(Duration::from_millis(200), events.recv())
        .await
        .unwrap_err();

    core.set_widget_feed(true);
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(event("$on")),
        )
        .await;
    let forwarded = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Some(CoreEvent::WidgetRoomEvent { event }) = events.recv().await {
                break event;
            }
        }
    })
    .await
    .expect("a forwarded event");
    assert_eq!(forwarded["event_id"], "$on");
    assert_eq!(forwarded["room_id"], room_id.as_str());
}

#[tokio::test]
async fn a_widget_state_change_tells_the_room_to_reload_its_widgets() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let (core, mut events) = Core::new("widgets", Box::new(MemorySessionStore::default()));
    crate::test_support::sign_in(&core, &server, client.clone()).await;
    let session = core.signed_in().unwrap();
    session.watch_room_widgets(1);
    let room_id = room_id!("!widgetstate:example.org");

    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_state_event(
                ruma::serde::Raw::new(&json!({
                    "type": "im.vector.modular.widgets", "state_key": "doom",
                    "event_id": "$widget", "sender": "@a:example.org", "origin_server_ts": 1,
                    "content": {"type": "m.custom", "url": "https://doom.example/", "name": "Doom"}
                }))
                .unwrap()
                .cast_unchecked(),
            ),
        )
        .await;

    let changed = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Some(CoreEvent::RoomWidgetsChanged { room_id }) = events.recv().await {
                break room_id;
            }
        }
    })
    .await
    .expect("a widgets change");
    assert_eq!(changed, room_id);
}

#[tokio::test]
async fn the_integration_manager_page_carries_a_scalar_token_from_the_openid_exchange() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let uri = server.server().uri();
    Mock::given(method("GET"))
        .and(path("/.well-known/matrix/client"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "m.integrations": {"managers": [
                {"api_url": format!("{uri}/scalar/api"), "ui_url": format!("{uri}/scalar")}
            ]}
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            "/_matrix/client/v3/user/.*/account_data/m.widgets",
        ))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "Not found"})),
        )
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path_regex(
            "/_matrix/client/v3/user/.*/openid/request_token",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "openid", "token_type": "Bearer",
            "matrix_server_name": "example.org", "expires_in": 3600
        })))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/scalar/api/register"))
        .and(body_json(json!({
            "access_token": "openid", "token_type": "Bearer",
            "matrix_server_name": "example.org", "expires_in": 3600
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"scalar_token": "s3"})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    let url = session
        .integration_manager_url(&room_id!("!room:example.org").to_owned())
        .await
        .unwrap();

    assert_eq!(
        url,
        format!("{uri}/index.html?scalar_token=s3&room_id=%21room%3Aexample.org")
    );
}

#[test]
fn pending_policies_skip_accepted_urls_and_prefer_english() {
    let terms = json!({"policies": {
        "privacy": {
            "version": "1",
            "en": {"name": "Privacy", "url": "https://im/privacy-en"},
            "fr": {"name": "Confidentialité", "url": "https://im/privacy-fr"}
        },
        "tos": {"version": "2", "fr": {"name": "Conditions", "url": "https://im/tos-fr"}},
        "old": {"version": "1", "en": {"name": "Old", "url": "https://im/old"}}
    }});

    let pending = super::pending_policies(&terms, &["https://im/old".to_owned()]);

    let mut urls: Vec<_> = pending.iter().map(|policy| policy.url.as_str()).collect();
    urls.sort_unstable();
    assert_eq!(urls, ["https://im/privacy-en", "https://im/tos-fr"]);
    assert!(pending.iter().any(|policy| policy.name == "Privacy"));
}

#[tokio::test]
async fn accepting_integration_manager_terms_signs_with_the_scalar_token_and_remembers_it() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let uri = server.server().uri();
    Mock::given(method("GET"))
        .and(path("/.well-known/matrix/client"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "m.integrations": {"managers": [
                {"api_url": format!("{uri}/scalar/api"), "ui_url": format!("{uri}/scalar")}
            ]}
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            "/_matrix/client/v3/user/.*/account_data/m.(widgets|accepted_terms)",
        ))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "Not found"})),
        )
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path_regex(
            "/_matrix/client/v3/user/.*/openid/request_token",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "openid", "token_type": "Bearer",
            "matrix_server_name": "example.org", "expires_in": 3600
        })))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/scalar/api/register"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"scalar_token": "s3"})))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/scalar/api/_matrix/integrations/v1/terms"))
        .and(header("Authorization", "Bearer s3"))
        .and(body_json(json!({"user_accepts": ["https://im/tos"]})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(
            "/_matrix/client/v3/user/.*/account_data/m.accepted_terms",
        ))
        .and(body_json(json!({"accepted": ["https://im/tos"]})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    session
        .accept_integration_manager_terms(vec!["https://im/tos".to_owned()])
        .await
        .unwrap();
}

#[tokio::test]
async fn terms_the_account_lists_are_signed_with_a_manager_that_never_saw_them() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let uri = server.server().uri();
    Mock::given(method("GET"))
        .and(path("/.well-known/matrix/client"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "m.integrations": {"managers": [
                {"api_url": format!("{uri}/scalar/api"), "ui_url": format!("{uri}/scalar")}
            ]}
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            "/_matrix/client/v3/user/.*/account_data/m.widgets",
        ))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "Not found"})),
        )
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            "/_matrix/client/v3/user/.*/account_data/m.accepted_terms",
        ))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"accepted": ["https://im/tos"]})),
        )
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path_regex(
            "/_matrix/client/v3/user/.*/openid/request_token",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "access_token": "openid", "token_type": "Bearer",
            "matrix_server_name": "example.org", "expires_in": 3600
        })))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/scalar/api/register"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"scalar_token": "s3"})))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path("/scalar/api/_matrix/integrations/v1/terms"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"policies": {
                "tos": {"version": "1", "en": {"name": "Terms", "url": "https://im/tos"}}
            }})),
        )
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path("/scalar/api/account"))
        .and(query_param("scalar_token", "s3"))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({
            "errcode": "M_TERMS_NOT_SIGNED", "error": "Terms not signed"
        })))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/scalar/api/_matrix/integrations/v1/terms"))
        .and(header("Authorization", "Bearer s3"))
        .and(body_json(json!({"user_accepts": ["https://im/tos"]})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(
            "/_matrix/client/v3/user/.*/account_data/m.accepted_terms",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(server.server())
        .await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    let pending = session.integration_manager_terms().await.unwrap();

    assert_eq!(pending, Vec::new());
    let url = session
        .integration_manager_url(&room_id!("!room:example.org").to_owned())
        .await
        .unwrap();
    assert!(url.contains("scalar_token=s3"));
}

#[test]
fn integration_managers_come_from_well_known_then_account_data_without_duplicates() {
    let mut managers = managers_from_well_known(&json!({
        "m.integrations": {"managers": [
            {"api_url": "https://a/api", "ui_url": "https://a"},
            {"api_url": "https://broken"}
        ]}
    }));
    managers_from_account_data(
        &json!({
            "one": {"type": "m.integration_manager", "url": "https://a"},
            "two": {"type": "m.integration_manager", "url": "https://b", "data": {"api_url": "https://b/api"}},
            "three": {"type": "m.custom", "url": "https://c"}
        }),
        &mut managers,
    );

    let urls: Vec<_> = managers
        .iter()
        .map(|manager| (manager.ui_url.as_str(), manager.api_url.as_str()))
        .collect();
    assert_eq!(
        urls,
        [
            ("https://a", "https://a/api"),
            ("https://b", "https://b/api")
        ]
    );
}

#[tokio::test]
async fn known_rooms_are_the_joined_ones() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!known:example.org");
    server.sync_joined_room(&client, room_id).await;
    let core = core_with(&server, client).await;
    let session = core.signed_in().unwrap();

    assert_eq!(session.known_room_ids(), [room_id.to_owned()]);
}

#[test]
fn well_known_managers_skip_malformed_entries() {
    let managers = managers_from_well_known(&json!({ "m.integrations": { "managers": [
            { "api_url": "https://a/api", "ui_url": "https://a/ui" },
            { "api_url": "https://b/api" },
            "junk",
            { "api_url": 1, "ui_url": "https://c" },
        ] } }));
    assert_eq!(managers.len(), 1);
    assert_eq!(managers[0].ui_url, "https://a/ui");
    assert!(managers_from_well_known(&json!({ "m.integrations": ["x"] })).is_empty());
}

#[test]
fn account_data_managers_fall_back_to_the_widget_url() {
    let mut known = Vec::new();
    managers_from_account_data(
        &json!({
            "a": { "type": "m.integration_manager", "url": "https://a/ui",
                   "data": { "api_url": "https://a/api" } },
            "b": { "type": "m.integration_manager", "url": "https://b/ui", "data": 5 },
            "c": { "type": "other", "url": "https://c" },
            "d": "junk",
        }),
        &mut known,
    );
    let pairs: Vec<_> = known.iter().map(|m| (&*m.api_url, &*m.ui_url)).collect();
    assert_eq!(
        pairs,
        [
            ("https://a/api", "https://a/ui"),
            ("https://b/ui", "https://b/ui")
        ]
    );
}
