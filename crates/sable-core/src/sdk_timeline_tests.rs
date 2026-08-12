use std::{sync::Arc, time::Duration};

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::{
    ruma::{event_id, room_id},
    test_utils::mocks::{
        MatrixMockServer, RoomContextResponseTemplate, RoomMessagesResponseTemplate,
    },
};
use matrix_sdk_test::{ALICE, JoinedRoomBuilder, event_factory::EventFactory};
use matrix_sdk_ui::sync_service::SyncService;
use serde_json::json;
use wiremock::{
    Mock, ResponseTemplate,
    matchers::{method, path},
};

use super::{
    Core, build_room_timeline,
    protocol::{Command, CommandOk},
    session::Session,
    store::MemorySessionStore,
};

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
    let timeline = build_room_timeline(&room, None).await.unwrap();
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
    let timeline = build_room_timeline(&room, None).await.unwrap();

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

    let timeline = build_room_timeline(&room, Some(target.to_owned()))
        .await
        .unwrap();
    assert_eq!(event_ids(timeline.items().await), [target.as_str()]);
}

#[tokio::test]
async fn a_stale_unsubscribe_does_not_clear_the_new_room_subscription() {
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
        })
        .await
        .unwrap()
    else {
        panic!("wrong response");
    };

    core.dispatch(Command::Unsubscribe {
        subscription: first,
    })
    .await
    .unwrap();
    assert_eq!(*core.active_room_subscription.lock().await, Some(second));

    core.dispatch(Command::Unsubscribe {
        subscription: second,
    })
    .await
    .unwrap();
    assert_eq!(*core.active_room_subscription.lock().await, None);
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
    let timeline = build_room_timeline(&room, None).await.unwrap();
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
