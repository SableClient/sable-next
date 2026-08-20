use std::{sync::Arc, time::Duration};

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::{
    ruma::{
        event_id,
        events::{
            key::verification::done::KeyVerificationDoneEventContent, relation::Reference,
            room::message::RoomMessageEventContent,
        },
        room_id,
    },
    send_queue::RoomSendQueueUpdate,
    test_utils::mocks::{
        MatrixMockServer, RoomContextResponseTemplate, RoomMessagesResponseTemplate,
    },
};
use matrix_sdk_test::{ALICE, JoinedRoomBuilder, event_factory::EventFactory};
use matrix_sdk_ui::sync_service::{State as SyncState, SyncService};
use serde_json::json;
use wiremock::{
    Mock, ResponseTemplate,
    matchers::{method, path},
};

use super::{
    Core, build_room_timeline,
    protocol::{Command, CommandOk, CoreEvent},
    session::{self, Session},
    store::MemorySessionStore,
};

#[tokio::test]
async fn started_sync_enters_offline_recovery_after_failure() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    server
        .mock_sliding_sync()
        .error_unrecognized()
        .expect(1..)
        .mount()
        .await;
    server.mock_versions().error500().expect(1..).mount().await;

    let sync_service = session::start_sync(client).await.unwrap();
    let mut states = sync_service.state();
    let terminal_state = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let state = states.next().await.expect("open sync state stream");
            if matches!(state, SyncState::Offline | SyncState::Error(_)) {
                break state;
            }
        }
    })
    .await
    .expect("sync failure state");

    assert!(matches!(terminal_state, SyncState::Offline));
    sync_service.stop().await;
}

fn event_ids(
    items: impl IntoIterator<Item = Arc<matrix_sdk_ui::timeline::TimelineItem>>,
) -> Vec<String> {
    items
        .into_iter()
        .filter_map(|item| item.as_event()?.event_id().map(ToString::to_string))
        .collect()
}

#[tokio::test]
async fn live_timeline_receives_sync_and_reconciles_a_limited_gap() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!timeline:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("old").event_id(event_id!("$old"))),
        )
        .await;
    let timeline = build_room_timeline(&room, None, false).await.unwrap();
    let (_, mut stream) = timeline.subscribe().await;

    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .set_timeline_limited()
                .set_timeline_prev_batch("gap")
                .add_timeline_event(factory.text_msg("new").event_id(event_id!("$new"))),
        )
        .await;

    tokio::time::timeout(Duration::from_secs(1), stream.next())
        .await
        .expect("timeline update")
        .expect("open timeline stream");
    assert_eq!(event_ids(timeline.items().await), ["$new"]);
}

#[tokio::test]
async fn live_timeline_back_paginates_through_the_event_cache() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!pagination:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .set_timeline_limited()
                .set_timeline_prev_batch("previous")
                .add_timeline_event(factory.text_msg("latest").event_id(event_id!("$latest"))),
        )
        .await;
    let timeline = build_room_timeline(&room, None, false).await.unwrap();

    server
        .mock_room_messages()
        .ok(RoomMessagesResponseTemplate::default().events(vec![
            factory.text_msg("older").event_id(event_id!("$older")),
        ]))
        .mock_once()
        .mount()
        .await;

    timeline.paginate_backwards(10).await.unwrap();
    assert_eq!(event_ids(timeline.items().await), ["$older", "$latest"]);
}

#[tokio::test]
async fn hidden_events_admit_only_events_the_sdk_can_render() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!hidden:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);
    let target = event_id!("$target");

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("target").event_id(target))
                .add_timeline_event(factory.reaction(target, "👍").event_id(event_id!("$react")))
                .add_timeline_event(
                    factory
                        .text_msg("edited")
                        .edit(target, RoomMessageEventContent::text_plain("edited").into())
                        .event_id(event_id!("$edit")),
                )
                .add_timeline_event(
                    factory
                        .event(KeyVerificationDoneEventContent::new(Reference::new(
                            target.to_owned(),
                        )))
                        .event_id(event_id!("$done")),
                ),
        )
        .await;
    let timeline = build_room_timeline(&room, None, true).await.unwrap();

    assert_eq!(event_ids(timeline.items().await), ["$target", "$done"]);
}

#[tokio::test]
async fn a_failed_send_wedges_the_room_queue_until_it_is_re_enabled() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!wedged:example.org");

    server.mock_room_state_encryption().plain().mount().await;
    let room = server.sync_joined_room(&client, room_id).await;
    let (_, mut updates) = room.send_queue().subscribe().await.unwrap();

    let failing = server.mock_room_send().error500().mount_as_scoped().await;
    room.send_queue()
        .send(RoomMessageEventContent::text_plain("first").into())
        .await
        .unwrap();
    let recoverable = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(RoomSendQueueUpdate::SendError { is_recoverable, .. }) = updates.recv().await
            {
                break is_recoverable;
            }
        }
    })
    .await
    .expect("a send failure");
    assert!(recoverable, "a 500 leaves the request queued, not wedged");
    drop(failing);

    let unused = server
        .mock_room_send()
        .ok(event_id!("$never"))
        .expect(0)
        .mount_as_scoped()
        .await;
    room.send_queue()
        .send(RoomMessageEventContent::text_plain("second").into())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(unused);

    let sending = server
        .mock_room_send()
        .ok(event_id!("$sent"))
        .expect(1..)
        .mount_as_scoped()
        .await;
    client.send_queue().set_enabled(true).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(RoomSendQueueUpdate::SentEvent { .. }) = updates.recv().await {
                break;
            }
        }
    })
    .await
    .expect("re-enabling drains the queue");
    drop(sending);
}

#[tokio::test]
async fn permalink_timeline_loads_and_contains_its_target() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!permalink:example.org");
    let target = event_id!("$target");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);

    let room = server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    server
        .mock_room_event_context()
        .match_event_id()
        .ok(RoomContextResponseTemplate::new(
            factory.text_msg("target").event_id(target).into_event(),
        ))
        .mock_once()
        .mount()
        .await;

    let timeline = build_room_timeline(&room, Some(target.to_owned()), false)
        .await
        .unwrap();
    assert_eq!(event_ids(timeline.items().await), [target.as_str()]);
}

#[tokio::test]
async fn timeline_subscriptions_remain_active_until_each_is_unsubscribed() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let first_room_id = room_id!("!first:example.org");
    let second_room_id = room_id!("!second:example.org");
    server.sync_joined_room(&client, first_room_id).await;
    server.sync_joined_room(&client, second_room_id).await;
    server.mock_room_state_encryption().plain().mount().await;

    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });

    let CommandOk::SubscribeTimeline {
        subscription: first,
        ..
    } = core
        .dispatch(Command::SubscribeTimeline {
            room_id: first_room_id.to_owned(),
            event_id: None,
            hidden_events: false,
        })
        .await
        .unwrap()
    else {
        panic!("wrong response");
    };
    let CommandOk::SubscribeTimeline {
        subscription: second,
        ..
    } = core
        .dispatch(Command::SubscribeTimeline {
            room_id: second_room_id.to_owned(),
            event_id: None,
            hidden_events: false,
        })
        .await
        .unwrap()
    else {
        panic!("wrong response");
    };

    assert!(core.subscriptions.lock().await.contains_key(&first));
    assert!(core.subscriptions.lock().await.contains_key(&second));

    core.dispatch(Command::Unsubscribe {
        subscription: first,
    })
    .await
    .unwrap();
    assert!(!core.subscriptions.lock().await.contains_key(&first));
    assert!(core.subscriptions.lock().await.contains_key(&second));

    core.dispatch(Command::Unsubscribe {
        subscription: second,
    })
    .await
    .unwrap();
    assert!(core.subscriptions.lock().await.is_empty());
}

#[tokio::test]
async fn live_timeline_reports_its_back_pagination_status() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!pagination-status:example.org");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;

    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });

    let CommandOk::SubscribeTimeline { subscription, .. } = core
        .dispatch(Command::SubscribeTimeline {
            room_id: room_id.to_owned(),
            event_id: None,
            hidden_events: false,
        })
        .await
        .unwrap()
    else {
        panic!("wrong response");
    };

    let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
        .await
        .expect("pagination status event")
        .expect("open event stream");
    assert!(matches!(
        event,
        CoreEvent::TimelinePagination {
            subscription: event_subscription,
            loading: false,
            reached_start: false,
        } if event_subscription == subscription
    ));
}

#[tokio::test]
async fn concurrent_first_access_returns_one_live_timeline() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!race:example.org");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;

    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });

    let owned_room_id = room_id.to_owned();
    let (first, second) =
        tokio::join!(core.timeline(&owned_room_id), core.timeline(&owned_room_id));
    assert!(Arc::ptr_eq(&first.unwrap(), &second.unwrap()));
}

#[tokio::test]
async fn inactive_timelines_use_least_recently_used_eviction() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    server.mock_room_state_encryption().plain().mount().await;
    let room_ids = [
        room_id!("!room1:example.org").to_owned(),
        room_id!("!room2:example.org").to_owned(),
        room_id!("!room3:example.org").to_owned(),
        room_id!("!room4:example.org").to_owned(),
        room_id!("!room5:example.org").to_owned(),
    ];
    for room_id in &room_ids {
        server.sync_joined_room(&client, room_id).await;
    }

    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });

    for room_id in &room_ids[..4] {
        core.live_timeline(room_id, false).await.unwrap();
    }
    core.live_timeline(&room_ids[0], false).await.unwrap();
    core.live_timeline(&room_ids[4], false).await.unwrap();

    let timelines = core.timelines.lock().await;
    assert_eq!(timelines.len(), 4);
    assert!(timelines.contains_key(&room_ids[0]));
    assert!(!timelines.contains_key(&room_ids[1]));
}

#[tokio::test]
async fn explicit_room_subscription_delivers_simplified_sliding_sync_events() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!sliding:example.org");
    let sliding_sync = client
        .sliding_sync("timeline-test")
        .unwrap()
        .build()
        .await
        .unwrap();
    sliding_sync.subscribe_to_rooms(&[room_id], None, true);
    let stream = sliding_sync.sync();
    pin_mut!(stream);

    let endpoint = "/_matrix/client/unstable/org.matrix.simplified_msc3575/sync";
    let first_response = Mock::given(method("POST"))
        .and(path(endpoint))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "pos": "1",
            "lists": {},
            "rooms": {
                room_id: {
                    "initial": true,
                    "timeline": []
                }
            },
            "extensions": {}
        })))
        .mount_as_scoped(server.server())
        .await;
    stream.next().await.unwrap().unwrap();
    drop(first_response);

    server.mock_room_state_encryption().plain().mount().await;
    let room = client.get_room(room_id).expect("subscribed room");
    let timeline = build_room_timeline(&room, None, false).await.unwrap();
    let (_, mut timeline_stream) = timeline.subscribe().await;

    let second_response = Mock::given(method("POST"))
        .and(path(endpoint))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "pos": "2",
            "lists": {},
            "rooms": {
                room_id: {
                    "timeline": [{
                        "event_id": "$live",
                        "sender": "@alice:example.org",
                        "type": "m.room.message",
                        "content": { "body": "live", "msgtype": "m.text" },
                        "origin_server_ts": 1
                    }]
                }
            },
            "extensions": {}
        })))
        .mount_as_scoped(server.server())
        .await;
    stream.next().await.unwrap().unwrap();
    drop(second_response);

    tokio::time::timeout(Duration::from_secs(1), timeline_stream.next())
        .await
        .expect("timeline update")
        .expect("open timeline stream");
    assert_eq!(event_ids(timeline.items().await), ["$live"]);
}

#[tokio::test]
async fn a_sticker_reaches_the_server_as_an_m_sticker_event() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!packs:example.org");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    server
        .mock_room_send()
        .ok(event_id!("$sticker"))
        .mount()
        .await;

    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });

    core.dispatch(Command::SubscribeTimeline {
        room_id: room_id.to_owned(),
        event_id: None,
        hidden_events: false,
    })
    .await
    .unwrap();

    let result = core
        .dispatch(Command::SendSticker {
            room_id: room_id.to_owned(),
            url: "mxc://example.org/blob".to_owned(),
            body: "blobwave".to_owned(),
        })
        .await;

    assert!(matches!(result, Ok(CommandOk::SendSticker)), "{result:?}");

    let sent = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let requests = server
                .server()
                .received_requests()
                .await
                .unwrap_or_default();
            if let Some(request) = requests
                .iter()
                .find(|request| request.url.path().contains("/send/m.sticker/"))
            {
                break request
                    .body_json::<serde_json::Value>()
                    .expect("sticker body");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the send queue flushed the sticker");

    assert_eq!(sent["url"], "mxc://example.org/blob");
    assert_eq!(sent["body"], "blobwave");
}

#[tokio::test]
async fn a_room_read_elsewhere_reports_the_server_unread_count() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!read-elsewhere:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);

    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_bulk([
                    factory
                        .text_msg("one")
                        .event_id(event_id!("$one"))
                        .into_raw(),
                    factory
                        .text_msg("two")
                        .event_id(event_id!("$two"))
                        .into_raw(),
                ])
                .set_unread_notifications_count(json!({
                    "notification_count": 0,
                    "highlight_count": 0,
                })),
        )
        .await;

    let item = matrix_sdk_ui::room_list_service::RoomListItem::from(room);
    let summary = super::view::room_summary(&item, &std::collections::HashMap::new());

    assert_eq!(item.num_unread_messages(), 2);
    assert_eq!(summary.unread, 0);
    assert_eq!(summary.highlight, 0);
}
