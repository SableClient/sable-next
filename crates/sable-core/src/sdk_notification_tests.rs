use std::{sync::Arc, time::Duration};

use matrix_sdk::{
    Client,
    ruma::{MilliSecondsSinceUnixEpoch, room_id},
    test_utils::mocks::MatrixMockServer,
};
use matrix_sdk_test::{
    ALICE, InvitedRoomBuilder, JoinedRoomBuilder, event_factory::EventFactory, stripped_state_event,
};
use matrix_sdk_ui::sync_service::SyncService;
use serde_json::json;
use tokio::sync::mpsc::UnboundedReceiver;
use wiremock::{
    Mock, ResponseTemplate,
    matchers::{method, path_regex},
};

use crate::{
    Core, notifications,
    protocol::{CoreEvent, NotificationView},
    session::Session,
    store::MemorySessionStore,
};

#[allow(clippy::unwrap_used)]
async fn watching(
    server: &MatrixMockServer,
    client: &Client,
) -> (Arc<Core>, UnboundedReceiver<CoreEvent>) {
    let (core, events) = Core::new("notifications", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "notifications".to_owned(),
        client: client.clone(),
        sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
        homeserver: server.server().uri(),
        oauth: false,
    });
    core.watch_notifications(
        client,
        core.session_generation
            .load(std::sync::atomic::Ordering::SeqCst),
    )
    .await;
    (core, events)
}

#[allow(clippy::unwrap_used, clippy::expect_used)]
async fn next_notification(events: &mut UnboundedReceiver<CoreEvent>) -> NotificationView {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let CoreEvent::Notification { notification } = events.recv().await.unwrap() {
                return notification;
            }
        }
    })
    .await
    .expect("a foreground notification")
}

#[tokio::test]
async fn stripped_invite_notifies_without_an_invented_event_id() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let (core, mut events) = watching(&server, &client).await;
    for room_id in [
        room_id!("!invite:example.org"),
        room_id!("!invite-again:example.org"),
    ] {
        let own = client.user_id().unwrap();
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_invited_room(InvitedRoomBuilder::new(room_id).add_state_bulk([
                    stripped_state_event!({
                        "type": "m.room.member", "sender": *ALICE, "state_key": *ALICE,
                        "content": { "membership": "join", "displayname": "Alice" }
                    }),
                    stripped_state_event!({
                        "type": "m.room.member", "sender": *ALICE, "state_key": own,
                        "content": { "membership": "invite", "is_direct": true }
                    }),
                ]));
            })
            .await;
        let view = next_notification(&mut events).await;
        assert_eq!(view.room_id, room_id);
        assert_eq!(view.event_id, None);
        assert_eq!(view.sender, *ALICE);
        assert_eq!(view.sender_name.as_deref(), Some("Alice"));
        assert_eq!(view.body, "invited you");
        assert!(view.is_direct);
        core.session_tasks.lock().unwrap().clear();
        core.watch_notifications(
            &client,
            core.session_generation
                .load(std::sync::atomic::Ordering::SeqCst),
        )
        .await;
    }
    core.session_tasks.lock().unwrap().clear();
}

#[tokio::test]
async fn a_replayed_invite_alerts_once() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let own = client.user_id().unwrap().to_owned();
    let invite = |room_id: &matrix_sdk::ruma::RoomId| {
        InvitedRoomBuilder::new(room_id).add_state_event(stripped_state_event!({
            "type": "m.room.member", "sender": *ALICE, "state_key": own,
            "content": { "membership": "invite" }
        }))
    };
    let known = room_id!("!known:example.org");
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_invited_room(invite(known));
        })
        .await;
    let (core, mut events) = watching(&server, &client).await;
    let fresh = room_id!("!fresh:example.org");
    for _ in 0..2 {
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_invited_room(invite(known));
                builder.add_invited_room(invite(fresh));
            })
            .await;
    }
    let after = room_id!("!after:example.org");
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_invited_room(invite(after));
        })
        .await;
    assert_eq!(next_notification(&mut events).await.room_id, fresh);
    assert_eq!(next_notification(&mut events).await.room_id, after);
    core.session_tasks.lock().unwrap().clear();
}

#[tokio::test]
async fn sticker_notifications_do_not_block_sync_or_reappear_after_reading() {
    for mark_read in [false, true] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!stickers:example.org");
        server.mock_room_state_encryption().plain().mount().await;
        let factory = EventFactory::new().room(room_id).sender(*ALICE);
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(factory.member(client.user_id().unwrap()))
                    .add_state_event(factory.default_power_levels()),
            )
            .await;
        let (core, mut events) = watching(&server, &client).await;
        let mut rules = matrix_sdk::ruma::push::Ruleset::server_default(client.user_id().unwrap());
        rules
            .insert(
                matrix_sdk::ruma::push::NewPushRule::Room(
                    matrix_sdk::ruma::push::NewSimplePushRule::new(
                        room_id.to_owned(),
                        vec![matrix_sdk::ruma::push::Action::Notify],
                    ),
                ),
                None,
                None,
            )
            .unwrap();
        let event = json!({
            "type": "m.sticker", "event_id": "$sticker", "room_id": room_id,
            "sender": *ALICE, "origin_server_ts": MilliSecondsSinceUnixEpoch::now(),
            "content": { "body": "wave", "url": "mxc://example.org/wave", "info": { "w": 1, "h": 1, "mimetype": "image/png", "size": 1 } }
        });
        let requested = Arc::new(tokio::sync::Notify::new());
        let context_requested = requested.clone();
        let response = ResponseTemplate::new(200)
        .set_delay(Duration::from_secs(2))
        .set_body_json(json!({
            "event": event, "events_before": [], "events_after": [], "state": [], "start": "s", "end": "e"
        }));
        Mock::given(method("GET"))
            .and(path_regex(r"/_matrix/client/v3/rooms/.*/context/.*"))
            .respond_with(move |_: &wiremock::Request| {
                context_requested.notify_one();
                response.clone()
            })
            .expect(1)
            .mount(server.server())
            .await;
        tokio::time::timeout(
            Duration::from_millis(500),
            server.mock_sync().ok_and_run(&client, |builder| {
                builder.add_global_account_data(factory.push_rules(rules.clone()));
                builder.add_joined_room(
                    JoinedRoomBuilder::new(room_id)
                        .set_unread_notifications_count(
                            json!({"notification_count": 1, "highlight_count": 0}),
                        )
                        .add_timeline_event(
                            matrix_sdk::ruma::serde::Raw::new(&event)
                                .unwrap()
                                .cast_unchecked::<matrix_sdk::ruma::events::AnySyncTimelineEvent>(),
                        ),
                );
            }),
        )
        .await
        .expect("sync must finish before the slow context lookup");
        tokio::time::timeout(Duration::from_secs(1), requested.notified())
            .await
            .unwrap();
        let invite_room = room_id!("!after-context:example.org");
        if mark_read {
            tokio::time::timeout(Duration::from_millis(500), server.mock_sync().ok_and_run(&client, |builder| {
            builder.add_joined_room(JoinedRoomBuilder::new(room_id)
                .set_unread_notifications_count(json!({"notification_count": 0, "highlight_count": 0})));
            builder.add_invited_room(InvitedRoomBuilder::new(invite_room).add_state_event(stripped_state_event!({
                "type": "m.room.member", "sender": *ALICE, "state_key": client.user_id().unwrap(),
                "content": { "membership": "invite" }
            })));
        })).await.expect("read sync completes before context response");
            assert!(notifications::is_read(&client.get_room(room_id).unwrap()));
        }
        let view = next_notification(&mut events).await;
        if mark_read {
            assert_eq!(
                view.room_id, invite_room,
                "the stale sticker notification must be suppressed"
            );
            assert!(view.event_id.is_none());
        } else {
            assert_eq!(
                view.event_id.as_deref().map(ToString::to_string).as_deref(),
                Some("$sticker")
            );
            assert_eq!(view.body, "sent a sticker");
        }
        core.session_tasks.lock().unwrap().clear();
    }
}

#[tokio::test]
async fn notification_settings_resolve_unknown_encryption() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = server
        .sync_joined_room(&client, room_id!("!settings:example.org"))
        .await;
    server
        .mock_room_state_encryption()
        .encrypted()
        .expect(1)
        .mount()
        .await;
    assert!(!room.encryption_state().is_encrypted());
    let result = notifications::settings(&room).await.unwrap();
    assert!(room.encryption_state().is_encrypted());
    assert!(result.room.is_none());
    let expected = client
        .notification_settings()
        .await
        .get_default_room_notification_mode(
            matrix_sdk::notification_settings::IsEncrypted::Yes,
            matrix_sdk::notification_settings::IsOneToOne::No,
        )
        .await;
    assert_eq!(
        serde_json::to_value(result.default).unwrap(),
        serde_json::to_value(crate::protocol::NotificationModeView::from(expected)).unwrap()
    );
}
