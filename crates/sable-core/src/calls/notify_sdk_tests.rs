use std::sync::Arc;

use matrix_sdk::{ruma::room_id, test_utils::mocks::MatrixMockServer};
use matrix_sdk_ui::sync_service::SyncService;
use serde_json::json;
use wiremock::{
    Mock, ResponseTemplate,
    matchers::{body_json, method, path, path_regex},
};

use crate::{Core, api::calls::DeclineParams, session::Session, store::MemorySessionStore};

#[tokio::test]
async fn core_declines_legacy_notifications_but_rejects_invalid_and_own_events() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
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
        .and(body_json(json!({
            "m.mentions": {},
            "m.relates_to": {"rel_type": "m.reference", "event_id": "$legacy"},
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$declined"})))
        .expect(1)
        .mount(server.server())
        .await;

    for event_id in ["$own", "$invalid"] {
        core.run(DeclineParams {
            room_id: room_id.to_owned(),
            notification_event_id: event_id.to_owned(),
        })
        .await
        .expect_err("own and malformed notifications cannot be declined");
    }
    core.run(DeclineParams {
        room_id: room_id.to_owned(),
        notification_event_id: "$legacy".to_owned(),
    })
    .await
    .unwrap();
    assert!(
        updates.try_recv().is_err(),
        "a decline must not leave a local echo the timeline filter never replaces"
    );
}

async fn sticky_update(room: &matrix_sdk::Room, events: Vec<serde_json::Value>) {
    use ruma::{api::client::sync::sync_events::v5, serde::Raw};
    let mut response = v5::Response::new("invites".to_owned());
    let mut sticky = v5::response::StickyEventsRoom::default();
    sticky.events = events
        .iter()
        .map(|event| Raw::new(event).unwrap().cast_unchecked())
        .collect();
    response
        .extensions
        .sticky_events
        .rooms
        .insert(room.room_id().to_owned(), sticky);
    room.client()
        .process_sliding_sync_test_helper(
            &response,
            &matrix_sdk_base::RequestedRequiredStates::default(),
        )
        .await
        .unwrap();
}

async fn incoming_event(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<crate::protocol::CoreEvent>,
    stage: &str,
) -> crate::protocol::CoreEvent {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let event = events.recv().await.unwrap();
            if matches!(
                event,
                crate::protocol::CoreEvent::IncomingCall { .. }
                    | crate::protocol::CoreEvent::IncomingCallEnded { .. }
            ) {
                return event;
            }
        }
    })
    .await
    .expect(stage)
}

#[tokio::test]
async fn deployed_non_sticky_invites_reach_the_call_handler_and_push_validation() {
    use crate::protocol::CoreEvent;
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk_test::{JoinedRoomBuilder, event_factory::EventFactory};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!fallback:example.org");
    server.mock_room_state_encryption().plain().mount().await;
    let own = client.user_id().unwrap();
    let factory = EventFactory::new().room(room_id).sender(own);
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_event(factory.member(own))
                .add_state_event(factory.power_levels()),
        )
        .await;
    let (core, mut events) = Core::new("fallback", Box::new(MemorySessionStore::default()));
    core.watch_incoming_calls(&client, core.lifecycle.current());
    let now = crate::now_ms();
    let event = json!({
        "type":"org.matrix.msc4075.rtc.notification", "event_id":"$fallback",
        "room_id":room_id, "sender":"@caller:example.org", "origin_server_ts":now,
        "content":{"slot_id":"m.call#ROOM", "msc4354_sticky_key":"m.call#ROOM",
            "notification_type":"ring", "sender_ts":now, "lifetime":90_000,
            "m.mentions":{"user_ids":[own]}}
    });
    assert!(!room.is_direct().await.unwrap());
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/event/$fallback"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(event.clone()))
        .mount(server.server())
        .await;
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(Raw::new(&event).unwrap().cast_unchecked()),
        )
        .await;
    assert!(
        matches!(incoming_event(&mut events, "non-sticky fallback rings").await,
        CoreEvent::IncomingCall { notification_event_id, ring: true, .. } if notification_event_id == "$fallback")
    );
    let validated = super::invite_service::validate_invite(&room, &event)
        .await
        .unwrap();
    assert!(validated.ring);
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    *core.session.write().await = Some(Session {
        account_id: "fallback".to_owned(),
        client: client.clone(),
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });
    Mock::given(method("PUT"))
        .and(path_regex(r"/send/org\.matrix\.msc4310\.rtc\.decline/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id":"$declined"})))
        .expect(1)
        .mount(server.server())
        .await;
    core.run(DeclineParams {
        room_id: room_id.to_owned(),
        notification_event_id: "$fallback".to_owned(),
    })
    .await
    .unwrap();
    let requests = server.received_requests().await.unwrap();
    let decline = requests
        .iter()
        .find(|request| request.method.as_str() == "PUT")
        .unwrap();
    assert!(
        !decline
            .url
            .query_pairs()
            .any(|(key, _)| key.contains("sticky"))
    );
    core.session_tasks.lock().clear();
}

#[tokio::test]
async fn sticky_only_invites_are_cancelled_by_withdrawals_and_cross_device_actions() {
    use crate::protocol::CoreEvent;
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk_test::{JoinedRoomBuilder, event_factory::EventFactory};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    server.mock_room_state_encryption().plain().mount().await;
    let room_id = room_id!("!invites:example.org");
    let factory = EventFactory::new()
        .room(room_id)
        .sender(client.user_id().unwrap());
    let slot = json!({
        "type":"m.rtc.slot", "state_key":"m.call#room", "event_id":"$slot",
        "sender":client.user_id().unwrap(), "origin_server_ts":1,
        "content":{"status":"open", "application":{"type":"m.call"}}
    });
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_event(factory.member(client.user_id().unwrap()))
                .add_state_event(factory.power_levels())
                .add_state_event(Raw::new(&slot).unwrap().cast_unchecked()),
        )
        .await;
    let (core, mut events) = Core::new("invites", Box::new(MemorySessionStore::default()));
    core.watch_incoming_calls(&client, core.lifecycle.current());
    let now = crate::now_ms();
    for (index, action) in ["withdraw", "join", "leave", "decline", "close"]
        .into_iter()
        .enumerate()
    {
        let id = format!("$invite{index}");
        let slot_id = format!("m.call#room{index}");
        // Distinct slots isolate each acceptance history from later invitations.
        let mut slot = slot.clone();
        slot["state_key"] = slot_id.clone().into();
        slot["event_id"] = format!("$slot{index}").into();
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(Raw::new(&slot).unwrap().cast_unchecked()),
            )
            .await;
        let invite = json!({
            "type": if index % 2 == 0 { "m.rtc.invite" } else { "org.matrix.msc4075.rtc.notification" }, "event_id":id, "sender":"@caller:example.org", "origin_server_ts":now,
            "msc4354_sticky":{"duration_ms":300_000},
            "content":{"slot_id":slot_id, "sticky_key":slot_id, "sender_ts":now, "lifetime":90_000,
                "m.mentions":{"user_ids":[client.user_id().unwrap()]}}
        });
        sticky_update(&room, vec![invite.clone()]).await;
        assert!(
            matches!(incoming_event(&mut events, &format!("{action}: incoming")).await, CoreEvent::IncomingCall { notification_event_id, ring: true, .. } if notification_event_id == id)
        );
        let mut update = json!({
            "event_id":format!("$acted{index}"), "origin_server_ts":now + 1,
            "sender":client.user_id().unwrap(), "msc4354_sticky":{"duration_ms":300_000}
        });
        match action {
            "withdraw" => {
                update["type"] = "m.rtc.invite".into();
                update["sender"] = "@caller:example.org".into();
                update["content"] = json!({"sticky_key":slot_id});
            }
            "join" | "leave" => {
                update["type"] = "m.rtc.member".into();
                update["content"] = json!({"slot_id":slot_id, "sticky_key":"OTHER_DEVICE",
                    "member":{"id":"OTHER_DEVICE", "membership":action}});
            }
            "decline" => {
                update["type"] = "m.rtc.decline".into();
                update["content"] = json!({"sticky_key":id,
                    "m.relates_to":{"rel_type":"m.reference", "event_id":id}});
            }
            "close" => {
                slot["content"]["status"] = "closed".into();
                slot["event_id"] = "$closed".into();
                server
                    .sync_room(
                        &client,
                        JoinedRoomBuilder::new(room_id)
                            .add_state_event(Raw::new(&slot).unwrap().cast_unchecked()),
                    )
                    .await;
            }
            _ => unreachable!(),
        }
        if action != "close" {
            sticky_update(&room, vec![update]).await;
        }
        assert!(
            matches!(incoming_event(&mut events, &format!("{action}: ended")).await, CoreEvent::IncomingCallEnded { notification_event_id } if notification_event_id == id)
        );
    }
    core.session_tasks.lock().clear();
}

#[tokio::test]
async fn declining_a_draft_invite_sends_a_sticky_reference_without_a_local_echo() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    server.mock_room_state_encryption().plain().mount().await;
    let room_id = room_id!("!decline:example.org");
    let room = server.sync_joined_room(&client, room_id).await;
    let (_, mut updates) = room.send_queue().subscribe().await.unwrap();
    let now = crate::now_ms();
    let invite = json!({
        "type":"m.rtc.invite", "event_id":"$invite", "room_id":room_id,
        "sender":"@caller:example.org", "origin_server_ts":now,
        "msc4354_sticky":{"duration_ms":300_000},
        "content":{"slot_id":"m.call#room", "sticky_key":"m.call#room", "sender_ts":now,
            "lifetime":90_000, "m.mentions":{"user_ids":[client.user_id().unwrap()]}}
    });
    let slot = json!({"type":"m.rtc.slot", "state_key":"m.call#room", "event_id":"$slot",
        "sender":client.user_id().unwrap(), "origin_server_ts":now,
        "content":{"status":"open", "application":{"type":"m.call"}}});
    server
        .sync_room(
            &client,
            matrix_sdk_test::JoinedRoomBuilder::new(room_id)
                .add_state_event(ruma::serde::Raw::new(&slot).unwrap().cast_unchecked()),
        )
        .await;
    sticky_update(&room, vec![invite.clone()]).await;
    Mock::given(method("POST"))
        .and(path_regex(r"/sync$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "pos":"decline", "rooms": {room_id.as_str(): {"required_state":[slot]}},
            "extensions":{"org.matrix.msc4354.sticky_events":{"next_batch":"s1",
                "rooms": {room_id.as_str(): {"events":[invite.clone()]}}}}
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/event/$invite"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(invite))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(
            r"/rooms/.*/send/org\.matrix\.msc4310\.rtc\.decline/.*",
        ))
        .and(wiremock::matchers::query_param(
            "org.matrix.msc4354.sticky_duration_ms",
            "300000",
        ))
        .and(body_json(
            json!({"msc4354_sticky_key":"$invite", "m.mentions":{},
            "m.relates_to":{"rel_type":"m.reference", "event_id":"$invite"}}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id":"$declined"})))
        .expect(1)
        .mount(server.server())
        .await;
    let (core, _) = Core::new("decline", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "decline".to_owned(),
        client: client.clone(),
        sync_service: Arc::new(SyncService::builder(client).build().await.unwrap()),
        homeserver: server.server().uri(),
        oauth: false,
    });
    core.decline_call(DeclineParams {
        room_id: room_id.to_owned(),
        notification_event_id: "$invite".to_owned(),
    })
    .await
    .unwrap();
    updates
        .try_recv()
        .expect_err("a decline must not enqueue a local echo");
}
