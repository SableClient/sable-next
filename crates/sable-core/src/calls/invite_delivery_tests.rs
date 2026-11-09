use std::collections::HashMap;
use std::sync::Arc;

use matrix_sdk::Room;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{event_id, room_id, user_id};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_test::{JoinedRoomBuilder, event_factory::EventFactory};
use matrix_sdk_ui::sync_service::SyncService;
use serde_json::{Value, json};
use wiremock::{
    Mock, Request, ResponseTemplate,
    matchers::{method, path_regex},
};

use super::{CallMember, membership::RtcWire};
use crate::{Core, protocol::CallMode, session::Session, store::MemorySessionStore};

async fn setup(
    wire: RtcWire,
    sticky: bool,
    direct: bool,
) -> (MatrixMockServer, Arc<Core>, Room, CallMember) {
    setup_room(wire, sticky, direct, false).await
}

async fn setup_room(
    wire: RtcWire,
    sticky: bool,
    direct: bool,
    voice: bool,
) -> (MatrixMockServer, Arc<Core>, Room, CallMember) {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().no_server_versions().build().await;
    server
        .mock_versions()
        .with_feature("org.matrix.msc4354", sticky)
        .ok()
        .mount()
        .await;
    server.mock_room_state_encryption().plain().mount().await;
    let room_id = room_id!("!invite-delivery:example.org");
    let factory = EventFactory::new()
        .room(room_id)
        .sender(client.user_id().unwrap());
    let slot = json!({
        "type": if wire == RtcWire::Stable { "m.rtc.slot" } else { "org.matrix.msc4143.rtc.slot" },
        "state_key": wire.slot(), "event_id": "$slot", "origin_server_ts": 1,
        "sender": client.user_id().unwrap(),
        "content": {"status": "open", "application": {"type": "m.call"}}
    });
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_joined_room(
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(
                        Raw::new(&json!({
                            "type": "m.room.create", "state_key": "", "event_id": "$create",
                            "origin_server_ts": 1, "sender": client.user_id().unwrap(),
                            "content": {
                                "room_version": "10",
                                "type": voice.then_some("org.matrix.msc3417.call"),
                            },
                        }))
                        .unwrap()
                        .cast_unchecked(),
                    )
                    .add_state_event(factory.member(client.user_id().unwrap()))
                    .add_state_event(factory.member(user_id!("@peer:example.org")))
                    .add_state_event(
                        factory
                            .power_levels()
                            .set_users([(client.user_id().unwrap().to_owned(), 100_i8)]),
                    )
                    .add_state_event(
                        matrix_sdk::ruma::serde::Raw::new(&slot)
                            .unwrap()
                            .cast_unchecked(),
                    ),
            );
            if direct {
                builder.add_global_account_data(
                    factory
                        .direct()
                        .add_user(user_id!("@peer:example.org"), room_id),
                );
            }
        })
        .await;
    let room = client.get_room(room_id).unwrap();
    Mock::given(method("PUT"))
        .and(path_regex(r"/rooms/.*/send/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id":"$sent"})))
        .mount(server.server())
        .await;
    let own = CallMember {
        user_id: client.user_id().unwrap().to_owned(),
        device_id: Some(client.device_id().unwrap().to_owned()),
        member_id: Some("own-member".to_owned()),
        identity: "own-identity".to_owned(),
        mode: CallMode::Matrix2,
        created_ts: crate::now_ms(),
        joined_ts: crate::now_ms(),
        expires_at_ms: None,
        foci: vec!["wss://focus.example.org".to_owned()],
        screen_sharing: false,
        wire,
        focus_servers: HashMap::new(),
    };
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("invite-delivery", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "invite-delivery".to_owned(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });
    (server, core, room, own)
}

async fn sends(server: &MatrixMockServer) -> Vec<Request> {
    server
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|request| request.method.as_str() == "PUT" && request.url.path().contains("/send/"))
        .collect()
}

async fn sticky_update(room: &Room, value: Value) {
    let mut response =
        matrix_sdk::ruma::api::client::sync::sync_events::v5::Response::new("next".to_owned());
    let mut events =
        matrix_sdk::ruma::api::client::sync::sync_events::v5::response::StickyEventsRoom::default();
    events.events.push(
        matrix_sdk::ruma::serde::Raw::new(&value)
            .unwrap()
            .cast_unchecked(),
    );
    response
        .extensions
        .sticky_events
        .rooms
        .insert(room.room_id().to_owned(), events);
    room.client()
        .process_sliding_sync_test_helper(
            &response,
            &matrix_sdk_base::RequestedRequiredStates::default(),
        )
        .await
        .unwrap();
}

async fn invite_sent(room: &Room, own: &CallMember, wire: RtcWire) {
    sticky_update(
        room,
        json!({
            "type":super::notify::NOTIFICATION_EVENT_TYPE, "event_id":"$own-invite",
            "sender":own.user_id, "origin_server_ts":crate::now_ms(),
            "msc4354_sticky":{"duration_ms":300_000},
            "content":super::invites::content(wire.slot(), false, &[], "$own-member")
        }),
    )
    .await;
}

fn assert_sticky(request: &Request) {
    assert_eq!(
        request
            .url
            .query_pairs()
            .find(|(key, _)| key == "org.matrix.msc4354.sticky_duration_ms")
            .unwrap()
            .1,
        "300000"
    );
}

#[tokio::test]
async fn draft_invitations_are_sent_sticky_in_both_wire_formats() {
    for wire in [RtcWire::Stable, RtcWire::Deployed] {
        for direct in [false, true] {
            let (server, core, room, own) = setup(wire, true, direct).await;
            core.announce_call(&room, event_id!("$membership"), &own)
                .await;
            let requests = sends(&server).await;
            assert_eq!(requests.len(), 1);
            let request = &requests[0];
            assert_sticky(request);
            let content: Value = serde_json::from_slice(&request.body).unwrap();
            assert_eq!(content["slot_id"], wire.slot());
            assert_eq!(content["lifetime"], 90_000);
            assert!(content["sender_ts"].as_u64().is_some());
            assert_eq!(
                content["m.mentions"],
                if direct {
                    json!({"user_ids":["@peer:example.org"]})
                } else {
                    json!({"room":true})
                }
            );
            assert!(
                request
                    .url
                    .path()
                    .contains("/send/org.matrix.msc4075.rtc.notification/")
            );
            assert_eq!(content["msc4354_sticky_key"], wire.slot());
            assert!(content.get("sticky_key").is_none());
            assert_eq!(
                content["notification_type"],
                if direct { "ring" } else { "notification" }
            );
            assert_eq!(content["m.relates_to"]["event_id"], "$membership");
        }
    }
}

#[tokio::test]
async fn legacy_calls_keep_the_deployed_fallback_without_sticky_support() {
    let (server, core, room, mut own) = setup(RtcWire::Deployed, false, false).await;
    own.mode = CallMode::Legacy;
    core.announce_call(&room, event_id!("$membership"), &own)
        .await;
    let requests = sends(&server).await;
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert!(
        request
            .url
            .query_pairs()
            .all(|(key, _)| key != "org.matrix.msc4354.sticky_duration_ms")
    );
    let content: Value = serde_json::from_slice(&request.body).unwrap();
    assert!(content.get("slot_id").is_none());
    assert_eq!(content["notification_type"], "notification");
    assert_eq!(content["m.mentions"], json!({"room":true}));
    assert_eq!(content["m.relates_to"]["event_id"], "$membership");
}

#[tokio::test]
async fn compatibility_calls_announce_without_sticky_support() {
    let (server, core, room, mut own) = setup(RtcWire::Deployed, false, false).await;
    own.mode = CallMode::Compatibility;
    core.announce_call(&room, event_id!("$membership"), &own)
        .await;
    let requests = sends(&server).await;
    assert_eq!(requests.len(), 1);
    let content: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert!(content.get("slot_id").is_none());
    assert_eq!(content["m.relates_to"]["event_id"], "$membership");
}

#[tokio::test]
async fn room_invitations_need_permission_to_notify_the_room() {
    let (server, core, room, own) = setup(RtcWire::Stable, true, false).await;
    let client = room.client();
    let factory = EventFactory::new()
        .room(room.room_id())
        .sender(client.user_id().unwrap());
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_joined_room(
                JoinedRoomBuilder::new(room.room_id()).add_state_event(
                    factory
                        .power_levels()
                        .set_users([(client.user_id().unwrap().to_owned(), 0_i8)]),
                ),
            );
        })
        .await;
    core.announce_call(&room, event_id!("$membership"), &own)
        .await;
    assert!(sends(&server).await.is_empty());
}

#[tokio::test]
async fn joining_a_voice_room_does_not_notify_the_room() {
    let (server, core, room, own) = setup_room(RtcWire::Stable, true, false, true).await;
    core.announce_call(&room, event_id!("$membership"), &own)
        .await;
    assert!(sends(&server).await.is_empty());
}

#[tokio::test]
async fn draft_calls_do_not_send_non_sticky_invitations() {
    for wire in [RtcWire::Stable, RtcWire::Deployed] {
        let (server, core, room, own) = setup(wire, false, false).await;
        core.announce_call(&room, event_id!("$membership"), &own)
            .await;
        assert!(sends(&server).await.is_empty());
    }
}

#[tokio::test]
async fn a_current_invitation_is_not_sent_again_to_the_same_recipients() {
    for wire in [RtcWire::Stable, RtcWire::Deployed] {
        let (server, core, room, own) = setup(wire, true, true).await;
        let event_type = super::notify::NOTIFICATION_EVENT_TYPE;
        let content = super::invites::content(
            wire.slot(),
            true,
            &["@peer:example.org".to_owned()],
            "$previous-member",
        );
        let event = json!({
            "type":event_type, "event_id":"$previous", "sender":own.user_id,
            "origin_server_ts":crate::now_ms(), "msc4354_sticky":{"duration_ms":300_000},
            "content":content
        });
        sticky_update(&room, event).await;
        core.announce_call(&room, event_id!("$membership"), &own)
            .await;
        assert!(sends(&server).await.is_empty());
        sticky_update(
            &room,
            json!({
                "type":event_type, "event_id":"$withdrawn", "sender":own.user_id,
                "origin_server_ts":crate::now_ms()+1, "msc4354_sticky":{"duration_ms":300_000},
                "content":{"msc4354_sticky_key":wire.slot()}
            }),
        )
        .await;
        core.announce_call(&room, event_id!("$membership"), &own)
            .await;
        assert_eq!(sends(&server).await.len(), 1);
    }
}

#[tokio::test]
async fn withdrawal_keeps_other_participants_invited_until_the_slot_closes() {
    for wire in [RtcWire::Stable, RtcWire::Deployed] {
        let (server, core, room, own) = setup(wire, true, false).await;
        let stable = wire == RtcWire::Stable;
        let mut content = json!({
            "slot_id":wire.slot(), "application":{"type":"m.call"},
            "member":{"id":"peer-member", "device_id":"PEER", "membership":"join"},
            "transports":{"published":[], "can_subscribe":[if stable { "m.livekit" } else { "livekit" }]}
        });
        content[if stable {
            "sticky_key"
        } else {
            "msc4354_sticky_key"
        }] = "peer-member".into();
        sticky_update(&room, json!({
            "type":if stable { "m.rtc.member" } else { "org.matrix.msc4143.rtc.member" },
            "event_id":"$peer-member", "sender":"@peer:example.org", "origin_server_ts":crate::now_ms(),
            "msc4354_sticky":{"duration_ms":300_000}, "content":content
        })).await;
        invite_sent(&room, &own, wire).await;
        core.withdraw_call_invite(&room, &own, false).await;
        assert!(sends(&server).await.is_empty());
        core.withdraw_call_invite(&room, &own, true).await;
        let requests = sends(&server).await;
        assert_eq!(requests.len(), 1);
        assert_sticky(&requests[0]);
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body, json!({"msc4354_sticky_key":wire.slot()}));
    }
}

#[tokio::test]
async fn the_last_participant_withdraws_their_invitation_on_leave() {
    for wire in [RtcWire::Stable, RtcWire::Deployed] {
        let (server, core, room, own) = setup(wire, true, false).await;
        invite_sent(&room, &own, wire).await;
        core.withdraw_call_invite(&room, &own, false).await;
        let requests = sends(&server).await;
        assert_eq!(requests.len(), 1);
        assert_sticky(&requests[0]);
        let content: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(content, json!({"msc4354_sticky_key":wire.slot()}));
    }
}

#[tokio::test]
async fn withdrawal_preserves_the_current_invitation_sticky_duration() {
    for wire in [RtcWire::Stable, RtcWire::Deployed] {
        let (server, core, room, own) = setup(wire, true, false).await;
        let content = super::invites::content(wire.slot(), false, &[], "$previous-member");
        sticky_update(
            &room,
            json!({
                "type":super::notify::NOTIFICATION_EVENT_TYPE, "event_id":"$long-invite",
                "sender":own.user_id, "origin_server_ts":crate::now_ms(),
                "msc4354_sticky":{"duration_ms":900_000}, "content":content
            }),
        )
        .await;
        core.withdraw_call_invite(&room, &own, false).await;
        let requests = sends(&server).await;
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0]
                .url
                .query_pairs()
                .find(|(key, _)| key == "org.matrix.msc4354.sticky_duration_ms")
                .unwrap()
                .1,
            "900000"
        );
        assert!(
            requests[0]
                .url
                .path()
                .contains("/send/org.matrix.msc4075.rtc.notification/")
        );
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(body, json!({"msc4354_sticky_key":wire.slot()}));
    }
}

#[tokio::test]
async fn nothing_is_withdrawn_without_an_invitation() {
    let (server, core, room, own) = setup(RtcWire::Stable, true, false).await;
    core.withdraw_call_invite(&room, &own, true).await;
    assert!(sends(&server).await.is_empty());
}
