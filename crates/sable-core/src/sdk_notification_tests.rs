use std::{sync::Arc, time::Duration};

use matrix_sdk::{
    Client,
    ruma::{MilliSecondsSinceUnixEpoch, room_id, user_id},
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

#[expect(clippy::unwrap_used, reason = "test code")]
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

#[expect(clippy::unwrap_used, clippy::expect_used, reason = "test code")]
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
async fn a_replayed_message_alerts_once() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!replay:example.org");
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

    let message = |event_id: &str, body: &str| {
        json!({
            "type": "m.room.message", "event_id": event_id, "room_id": room_id,
            "sender": *ALICE, "origin_server_ts": MilliSecondsSinceUnixEpoch::now(),
            "content": { "msgtype": "m.text", "body": body }
        })
    };
    for (event_id, body) in [("$one", "first"), ("$two", "second")] {
        Mock::given(method("GET"))
            .and(path_regex(format!(
                r"/context/.*{}$",
                event_id.trim_start_matches('$')
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "event": message(event_id, body), "events_before": [], "events_after": [],
                "state": [], "start": "s", "end": "e"
            })))
            .mount(server.server())
            .await;
    }

    for (event_id, body) in [("$one", "first"), ("$one", "first"), ("$two", "second")] {
        let message = message(event_id, body);
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_global_account_data(factory.push_rules(rules.clone()));
                builder.add_joined_room(
                    JoinedRoomBuilder::new(room_id)
                        .set_unread_notifications_count(
                            json!({"notification_count": 1, "highlight_count": 0}),
                        )
                        .add_timeline_event(
                            matrix_sdk::ruma::serde::Raw::new(&message)
                                .unwrap()
                                .cast_unchecked::<matrix_sdk::ruma::events::AnySyncTimelineEvent>(),
                        ),
                );
            })
            .await;
    }

    assert_eq!(
        next_notification(&mut events)
            .await
            .event_id
            .map(|event_id| event_id.to_string()),
        Some("$one".to_owned())
    );
    assert_eq!(
        next_notification(&mut events)
            .await
            .event_id
            .map(|event_id| event_id.to_string()),
        Some("$two".to_owned()),
        "the replayed event must not alert a second time"
    );
    core.session_tasks.lock().unwrap().clear();
}

#[tokio::test]
async fn a_message_delivered_late_by_a_resumed_sync_does_not_alert() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!late:example.org");
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
    let rules = matrix_sdk::ruma::push::Ruleset::server_default(client.user_id().unwrap());
    let long_ago = MilliSecondsSinceUnixEpoch::from_system_time(
        std::time::SystemTime::now() - Duration::from_secs(600),
    )
    .unwrap();
    let message = |event_id: &str, sent: MilliSecondsSinceUnixEpoch| {
        json!({
            "type": "m.room.message", "event_id": event_id, "room_id": room_id,
            "sender": *ALICE, "origin_server_ts": sent,
            "content": { "msgtype": "m.text", "body": event_id }
        })
    };
    for (event_id, sent) in [
        ("$late", long_ago),
        ("$live", MilliSecondsSinceUnixEpoch::now()),
    ] {
        let event = message(event_id, sent);
        Mock::given(method("GET"))
            .and(path_regex(format!(
                r"/context/.*{}$",
                event_id.trim_start_matches('$')
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "event": event, "events_before": [], "events_after": [],
                "state": [], "start": "s", "end": "e"
            })))
            .mount(server.server())
            .await;
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
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
            })
            .await;
    }

    assert_eq!(
        next_notification(&mut events)
            .await
            .event_id
            .map(|event_id| event_id.to_string()),
        Some("$live".to_owned()),
        "a message from before the gap is a catch-up, not an arrival"
    );
    core.session_tasks.lock().unwrap().clear();
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one sequential flow kept in a single function"
)]
async fn bridge_status_events_do_not_notify() {
    use matrix_sdk::ruma::push::{Action, NewPushRule, NewSimplePushRule, Ruleset};
    use matrix_sdk::ruma::{
        event_id,
        events::receipt::{ReceiptThread, ReceiptType},
    };

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!signal:example.org");
    let bot = user_id!("@signalbot:example.org");
    let factory = EventFactory::new().room(room_id).sender(bot);
    let mut rules = Ruleset::server_default(client.user_id().unwrap());
    rules
        .insert(
            NewPushRule::Room(NewSimplePushRule::new(
                room_id.to_owned(),
                vec![Action::Notify],
            )),
            None,
            None,
        )
        .unwrap();
    server.mock_room_state_encryption().plain().mount().await;
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_global_account_data(factory.push_rules(rules.clone()));
            builder.add_joined_room(
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(factory.member(client.user_id().unwrap()))
                    .add_state_event(factory.member(bot))
                    .add_state_event(factory.default_power_levels())
                    .add_timeline_event(factory.text_msg("read").event_id(event_id!("$read")))
                    .add_receipt(
                        factory
                            .read_receipts()
                            .add(
                                event_id!("$read"),
                                client.user_id().unwrap(),
                                ReceiptType::Read,
                                ReceiptThread::Unthreaded,
                            )
                            .into_event(),
                    ),
            );
        })
        .await;
    let (core, mut events) = watching(&server, &client).await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/pushrules/global/override/moe\.sable\.suppress_bridge_status$"))
        .and(wiremock::matchers::body_json(json!({
            "conditions": [{"kind": "event_match", "key": "type", "pattern": "com.beeper.message_send_status"}],
            "actions": []
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    core.align_notification_rules().await;
    let rules = core.push_rules().await.unwrap().snapshot().await;

    for (event_id, event_type, content, unread) in [
        (
            "$status",
            "com.beeper.message_send_status",
            json!({"status": "SUCCESS", "m.relates_to": {
                "rel_type": "m.reference", "event_id": "$outgoing"
            }}),
            0,
        ),
        (
            "$message",
            "m.room.message",
            json!({"msgtype": "m.text", "body": "hello from Signal"}),
            1,
        ),
    ] {
        let event = json!({
            "type": event_type, "event_id": event_id, "room_id": room_id,
            "sender": bot, "origin_server_ts": MilliSecondsSinceUnixEpoch::now(),
            "content": content
        });
        Mock::given(method("GET"))
            .and(path_regex(format!(
                r"/context/.*{}$",
                event_id.trim_start_matches('$')
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "event": event, "events_before": [], "events_after": [],
                "state": [], "start": "s", "end": "e"
            })))
            .mount(server.server())
            .await;
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_global_account_data(factory.push_rules(rules.clone()));
                builder.add_joined_room(
                    JoinedRoomBuilder::new(room_id).add_timeline_event(
                        matrix_sdk::ruma::serde::Raw::new(&event)
                            .unwrap()
                            .cast_unchecked::<matrix_sdk::ruma::events::AnySyncTimelineEvent>(),
                    ),
                );
            })
            .await;
        let item =
            matrix_sdk_ui::room_list_service::RoomListItem::from(client.get_room(room_id).unwrap());
        assert_eq!(item.num_unread_notifications(), u64::from(unread));
        assert_eq!(
            crate::view::unread_counts(&item, Some(event_id.try_into().unwrap()), false),
            (unread, 0)
        );
    }

    let notification = next_notification(&mut events).await;
    assert_eq!(
        notification.event_id.as_deref(),
        Some(event_id!("$message"))
    );
    core.session_tasks.lock().unwrap().clear();
}

#[tokio::test]
async fn a_message_alerts_when_the_server_reports_no_counts() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!synapse:example.org");
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
    let message = json!({
        "type": "m.room.message", "event_id": "$fresh", "room_id": room_id,
        "sender": *ALICE, "origin_server_ts": MilliSecondsSinceUnixEpoch::now(),
        "content": { "msgtype": "m.text", "body": "hello" }
    });
    Mock::given(method("GET"))
        .and(path_regex(r"/context/.*fresh$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "event": message, "events_before": [], "events_after": [],
            "state": [], "start": "s", "end": "e"
        })))
        .mount(server.server())
        .await;
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_global_account_data(factory.push_rules(rules.clone()));
            builder.add_joined_room(
                JoinedRoomBuilder::new(room_id)
                    .set_unread_notifications_count(
                        json!({"notification_count": 0, "highlight_count": 0}),
                    )
                    .add_timeline_event(
                        matrix_sdk::ruma::serde::Raw::new(&message)
                            .unwrap()
                            .cast_unchecked::<matrix_sdk::ruma::events::AnySyncTimelineEvent>(),
                    ),
            );
        })
        .await;

    assert_eq!(
        next_notification(&mut events)
            .await
            .event_id
            .map(|event_id| event_id.to_string()),
        Some("$fresh".to_owned())
    );
    core.session_tasks.lock().unwrap().clear();
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one sequential flow kept in a single function"
)]
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
        let sent = MilliSecondsSinceUnixEpoch::now();
        let event = json!({
            "type": "m.sticker", "event_id": "$sticker", "room_id": room_id,
            "sender": *ALICE, "origin_server_ts": sent,
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
                .set_unread_notifications_count(json!({"notification_count": 0, "highlight_count": 0}))
                .add_receipt(factory.read_receipts().add_with_timestamp(
                    matrix_sdk::ruma::event_id!("$sticker"),
                    client.user_id().unwrap(),
                    matrix_sdk::ruma::events::receipt::ReceiptType::Read,
                    matrix_sdk::ruma::events::receipt::ReceiptThread::Unthreaded,
                    Some(MilliSecondsSinceUnixEpoch::now()),
                ).into_event()));
            builder.add_invited_room(InvitedRoomBuilder::new(invite_room).add_state_event(stripped_state_event!({
                "type": "m.room.member", "sender": *ALICE, "state_key": client.user_id().unwrap(),
                "content": { "membership": "invite" }
            })));
        })).await.expect("read sync completes before context response");
            assert!(notifications::is_read(&client.get_room(room_id).unwrap(), sent).await);
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
async fn an_encrypted_room_defaults_to_the_rule_its_decrypted_messages_hit() {
    use matrix_sdk::ruma::push::{PredefinedUnderrideRuleId, RuleKind, Ruleset};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!settings:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);
    let mut rules = Ruleset::server_default(client.user_id().unwrap());
    rules
        .set_actions(
            RuleKind::Underride,
            PredefinedUnderrideRuleId::Message.as_str(),
            vec![],
        )
        .unwrap();
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_global_account_data(factory.push_rules(rules.clone()));
            builder.add_joined_room(
                JoinedRoomBuilder::new(room_id).add_state_event(factory.room_encryption()),
            );
        })
        .await;
    let room = client.get_room(room_id).unwrap();
    assert!(room.encryption_state().is_encrypted());

    let rules = crate::push_rules::PushRules::load(&client)
        .await
        .snapshot()
        .await;
    let direct = notifications::uses_direct_push_rules(&room);
    let result = crate::push_rules::room_settings(&rules, room_id, direct);
    let modes = crate::push_rules::room_modes(&rules, [(room_id.to_owned(), direct)]);

    assert!(result.room.is_none());
    assert_eq!(
        serde_json::to_value(result.default).unwrap(),
        json!("mentions")
    );
    assert_eq!(
        serde_json::to_value(modes[0].default).unwrap(),
        json!("mentions")
    );
}

#[tokio::test]
async fn a_second_room_mode_change_before_the_sync_echo_still_lands() {
    use crate::protocol::NotificationModeView;
    use crate::push_rules::{PushRules, plan_room_mode, room_mode};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!rapid:example.org");
    for verb in ["PUT", "DELETE"] {
        Mock::given(method(verb))
            .and(path_regex(r"/_matrix/client/v3/pushrules/global/.*"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(server.server())
            .await;
    }
    let rules = PushRules::load(&client).await;

    rules
        .apply(plan_room_mode(
            &rules.snapshot().await,
            room_id,
            false,
            Some(NotificationModeView::Mute),
        ))
        .await
        .unwrap();
    assert_eq!(
        room_mode(&rules.snapshot().await, room_id),
        Some(NotificationModeView::Mute)
    );

    rules
        .apply(plan_room_mode(
            &rules.snapshot().await,
            room_id,
            false,
            None,
        ))
        .await
        .unwrap();

    assert_eq!(room_mode(&rules.snapshot().await, room_id), None);
    let deleted_override = server
        .server()
        .received_requests()
        .await
        .unwrap()
        .iter()
        .any(|request| {
            request.method.as_str() == "DELETE"
                && request.url.path().contains("/override/")
                && request.url.path().contains("rapid")
        });
    assert!(deleted_override, "the mute must be removed on the server");
}

#[tokio::test]
async fn a_missing_rule_on_delete_is_not_a_failure() {
    use crate::push_rules::{PushRules, plan_room_mode};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("DELETE"))
        .and(path_regex(r"/_matrix/client/v3/pushrules/global/.*"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "errcode": "M_NOT_FOUND", "error": "Unknown rule"
        })))
        .mount(server.server())
        .await;
    let rules = PushRules::load(&client).await;

    rules
        .apply(plan_room_mode(
            &rules.snapshot().await,
            room_id!("!gone:example.org"),
            false,
            None,
        ))
        .await
        .unwrap();
}

#[tokio::test]
async fn a_bridge_bot_still_counts_for_one_to_one_push_rules() {
    use std::collections::BTreeSet;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!bridged:example.org");
    let own = client.user_id().unwrap().to_owned();
    let ghost = user_id!("@whatsapp_123:example.org");
    let bot = user_id!("@whatsappbot:example.org");
    let factory = EventFactory::new().room(room_id);
    let members = [own.as_ref(), ghost, bot];
    server
        .mock_get_members()
        .ok(members
            .iter()
            .map(|member| factory.member(member).into_raw())
            .collect())
        .mount()
        .await;
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_joined_room(
                JoinedRoomBuilder::new(room_id)
                    .add_state_bulk(members.iter().map(|member| factory.member(member).into()))
                    .add_state_event(
                        factory
                            .member_hints(BTreeSet::from([bot.to_owned()]))
                            .sender(ghost),
                    )
                    .set_joined_members_count(3),
            );
        })
        .await;
    let room = client.get_room(room_id).unwrap();

    assert!(!notifications::uses_direct_push_rules(&room));
}

#[tokio::test]
async fn resetting_a_bridged_dm_to_default_does_not_create_a_room_push_rule() {
    use std::collections::BTreeSet;

    use crate::protocol::{Command, CommandOk, NotificationModeView};
    use matrix_sdk::ruma::push::{PredefinedUnderrideRuleId, RuleKind, Ruleset};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!bridged:example.org");
    let own = client.user_id().unwrap();
    let ghost = user_id!("@whatsapp_123:example.org");
    let bot = user_id!("@whatsappbot:example.org");
    let members = [own, ghost, bot];
    let factory = EventFactory::new().room(room_id).sender(ghost);
    let mut rules = Ruleset::server_default(own);
    rules
        .set_actions(
            RuleKind::Underride,
            PredefinedUnderrideRuleId::Message.as_str(),
            vec![],
        )
        .unwrap();
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_global_account_data(factory.push_rules(rules.clone()));
            builder.add_joined_room(
                JoinedRoomBuilder::new(room_id)
                    .add_state_bulk(members.iter().map(|member| factory.member(member).into()))
                    .add_state_event(factory.member_hints(BTreeSet::from([bot.to_owned()])))
                    .set_joined_members_count(3),
            );
        })
        .await;
    for verb in ["PUT", "DELETE"] {
        Mock::given(method(verb))
            .and(path_regex(r"/_matrix/client/v3/pushrules/global/.*"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(server.server())
            .await;
    }
    let (core, _events) = watching(&server, &client).await;
    core.dispatch(Command::SetRoomNotificationMode {
        room_id: room_id.to_owned(),
        mode: None,
    })
    .await
    .unwrap();

    let requests = server.server().received_requests().await.unwrap();
    assert!(
        !requests.iter().any(|request| {
            request.method.as_str() == "PUT"
                && request.url.path().contains("/pushrules/global/room/")
        }),
        "resetting to default must not install a room override"
    );
    let CommandOk::NotificationSettings(settings) = core
        .dispatch(Command::NotificationSettings {
            room_id: room_id.to_owned(),
        })
        .await
        .unwrap()
    else {
        panic!("notification settings");
    };
    assert!(settings.room.is_none());
    assert_eq!(settings.default, NotificationModeView::Mentions);

    let CommandOk::RoomNotificationModes { modes } = core
        .dispatch(Command::RoomNotificationModes {
            room_ids: vec![room_id.to_owned()],
        })
        .await
        .unwrap()
    else {
        panic!("room notification modes");
    };
    assert!(modes[0].room.is_none());
    assert_eq!(modes[0].default, NotificationModeView::Mentions);

    core.dispatch(Command::SetRoomNotificationMode {
        room_id: room_id.to_owned(),
        mode: Some(NotificationModeView::All),
    })
    .await
    .unwrap();
    for direct in [true, false] {
        core.dispatch(Command::SetDefaultNotificationMode {
            direct,
            mode: NotificationModeView::Mentions,
        })
        .await
        .unwrap();
        let CommandOk::NotificationSettings(settings) = core
            .dispatch(Command::NotificationSettings {
                room_id: room_id.to_owned(),
            })
            .await
            .unwrap()
        else {
            panic!("notification settings");
        };
        assert_eq!(settings.room, Some(NotificationModeView::All));
    }
    core.session_tasks.lock().unwrap().clear();
}
