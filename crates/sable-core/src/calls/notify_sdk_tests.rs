#![allow(clippy::large_futures)]

use std::{sync::Arc, time::Duration};

use matrix_sdk::{
    ruma::room_id, send_queue::RoomSendQueueUpdate, test_utils::mocks::MatrixMockServer,
};
use matrix_sdk_ui::sync_service::SyncService;
use serde_json::json;
use wiremock::{
    Mock, ResponseTemplate,
    matchers::{body_json, method, path, path_regex},
};

use crate::{Core, protocol::Command, session::Session, store::MemorySessionStore};

#[tokio::test]
async fn core_declines_legacy_notifications_but_rejects_invalid_and_own_events() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    server.mock_room_state_encryption().plain().mount().await;
    let room_id = room_id!("!legacy-call:example.org");
    let room = server.sync_joined_room(&client, room_id).await;
    let (_, mut updates) = room.send_queue().subscribe().await.unwrap();
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let own_user_id = client.user_id().unwrap().to_owned();
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });

    for (event_id, sender, notification_type) in [
        ("$legacy", "@caller:example.org", "notification"),
        ("$own", own_user_id.as_str(), "notification"),
        ("$invalid", "@caller:example.org", "ring"),
    ] {
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room_id}/event/{event_id}"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "type": "org.matrix.msc4075.rtc.notification", "event_id": event_id,
                "room_id": room_id, "sender": sender, "origin_server_ts": 1000,
                "content": {"notification_type": notification_type, "sender_ts": 1000,
                    "m.mentions": {"room": true}}
            })))
            .mount(server.server())
            .await;
    }
    Mock::given(method("PUT"))
        .and(path_regex(
            r"/rooms/.*/send/org\.matrix\.msc4310\.rtc\.decline/.*",
        ))
        .and(body_json(
            json!({"m.relates_to": {"rel_type": "m.reference", "event_id": "$legacy"}}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$declined"})))
        .expect(1)
        .mount(server.server())
        .await;

    for event_id in ["$own", "$invalid"] {
        core.dispatch(Command::DeclineCall {
            room_id: room_id.to_owned(),
            notification_event_id: event_id.to_owned(),
        })
        .await
        .expect_err("own and malformed notifications cannot be declined");
    }
    core.dispatch(Command::DeclineCall {
        room_id: room_id.to_owned(),
        notification_event_id: "$legacy".to_owned(),
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if matches!(
                updates.recv().await.unwrap(),
                RoomSendQueueUpdate::SentEvent { .. }
            ) {
                break;
            }
        }
    })
    .await
    .expect("the typed decline is sent from the queue");
}
