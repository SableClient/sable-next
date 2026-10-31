use std::{sync::Arc, time::Duration};

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::{
    ruma::{
        event_id,
        events::{
            key::verification::VerificationMethod,
            key::verification::done::KeyVerificationDoneEventContent,
            receipt::{ReceiptThread, ReceiptType},
            relation::Reference,
            room::avatar::RoomAvatarEventContent,
            room::message::{
                KeyVerificationRequestEventContent, LocationMessageEventContent, MessageType,
                RoomMessageEventContent,
            },
        },
        room_id, user_id,
    },
    send_queue::RoomSendQueueUpdate,
    test_utils::mocks::{
        MatrixMockServer, RoomContextResponseTemplate, RoomMessagesResponseTemplate,
    },
};
use matrix_sdk_test::{InvitedRoomBuilder, JoinedRoomBuilder, User, event_factory::EventFactory};
use matrix_sdk_ui::sync_service::{State as SyncState, SyncService};
use serde_json::json;
use wiremock::{
    Mock, ResponseTemplate,
    matchers::{body_partial_json, method, path, path_regex},
};

use super::{
    Core,
    api::timeline::TimelineFocusView,
    protocol::{CoreEvent, Outgoing, RpcError},
    session::{self, Session},
    store::MemorySessionStore,
};
use crate::api::packs::ConvertLegacyParams;
use crate::api::room_state::{EventParams, SendEventParams};
use crate::api::timeline::{
    MarkReadParams, MarkUnreadParams, ReadMarkerParams, SetPinnedParams, SubscribeOk,
    SubscribeParams, UnsubscribeParams, WarmRoomsParams,
};
use crate::timelines::build_room_timeline;

#[tokio::test]
async fn started_sync_recovers_after_an_offline_failure() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    server
        .mock_sliding_sync()
        .error_unrecognized()
        .expect(1..)
        .mount()
        .await;
    let versions_failure = server.mock_versions().error500().mount_as_scoped().await;

    let sync_service = session::start_sync(client).await.unwrap();
    let mut states = sync_service.state();
    let offline_state = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let state = states.next().await.expect("open sync state stream");
            if matches!(state, SyncState::Offline | SyncState::Error(_)) {
                break state;
            }
        }
    })
    .await
    .expect("sync failure state");

    assert!(matches!(offline_state, SyncState::Offline));

    drop(versions_failure);
    server.mock_versions().ok().expect(1..).mount().await;
    let recovered_state = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let state = states.next().await.expect("open sync state stream");
            if matches!(state, SyncState::Running) {
                break state;
            }
        }
    })
    .await
    .expect("sync recovery state");

    assert!(matches!(recovered_state, SyncState::Running));
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
async fn timeline_view_preserves_available_read_receipt_timestamps() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!receipts:example.org");
    let event_id = event_id!("$read");
    let bob = user_id!("@bob:example.org");
    let carol = user_id!("@carol:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let timestamp = matrix_sdk::ruma::MilliSecondsSinceUnixEpoch::from_system_time(
        std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000),
    )
    .unwrap();
    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("read me").event_id(event_id))
                .add_receipt(
                    factory
                        .read_receipts()
                        .add_with_timestamp(
                            event_id,
                            bob,
                            ReceiptType::Read,
                            ReceiptThread::Unthreaded,
                            Some(timestamp),
                        )
                        .add_with_timestamp(
                            event_id,
                            carol,
                            ReceiptType::Read,
                            ReceiptThread::Unthreaded,
                            None,
                        )
                        .into_event(),
                ),
        )
        .await;
    let timeline = build_room_timeline(&room, &TimelineFocusView::Live, false)
        .await
        .unwrap();
    let items = timeline.items().await;
    let item = items
        .iter()
        .find(|item| item.as_event().and_then(|event| event.event_id()) == Some(event_id))
        .unwrap();
    let view = crate::view::timeline_item(
        item,
        client.user_id(),
        &crate::view::Highlights::default(),
        &crate::view::LocalContent::default(),
    );
    assert!(view.read_by.iter().any(|reader| reader == bob));
    assert!(view.read_by.iter().any(|reader| reader == carol));
    assert_eq!(
        view.read_timestamps.get(bob.as_str()),
        Some(&1_700_000_000_000)
    );
    assert!(!view.read_timestamps.contains_key(carol.as_str()));
    let serialized = serde_json::to_value(&view).unwrap();
    assert_eq!(
        serialized["read_timestamps"][bob.as_str()],
        1_700_000_000_000_u64
    );
}

#[tokio::test]
async fn live_timeline_receives_sync_and_reconciles_a_limited_gap() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!timeline:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("old").event_id(event_id!("$old"))),
        )
        .await;
    let timeline = build_room_timeline(&room, &TimelineFocusView::Live, false)
        .await
        .unwrap();
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
    let room_id = room_id!("!pagination:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

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
    let timeline = build_room_timeline(&room, &TimelineFocusView::Live, false)
        .await
        .unwrap();

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
async fn hidden_events_admit_only_events_the_sdk_can_render_and_place() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!hidden:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
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
                )
                .add_timeline_event(
                    matrix_sdk::ruma::serde::Raw::<matrix_sdk::ruma::events::AnySyncTimelineEvent>::from_json_string(
                        json!({
                            "type": "com.example.custom",
                            "event_id": "$custom",
                            "sender": User::Alice.as_str(),
                            "origin_server_ts": 9,
                            "content": {"m.relates_to": {"rel_type": "m.thread", "event_id": target}},
                        })
                        .to_string(),
                    )
                    .unwrap(),
                ),
        )
        .await;
    let timeline = build_room_timeline(&room, &TimelineFocusView::Live, true)
        .await
        .unwrap();

    assert_eq!(event_ids(timeline.items().await), ["$target", "$done"]);
}

#[tokio::test]
async fn a_failed_send_wedges_the_room_queue_until_it_is_re_enabled() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
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

const MAX_EVENT_CONTENT_BYTES: usize = 65_536;

#[tokio::test]
async fn oversized_sends_return_message_too_large() {
    use crate::api::messages::SendParams;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!oversized:example.org");
    server.mock_room_state_encryption().plain().mount().await;
    let room = server.sync_joined_room(&client, room_id).await;
    room.send_queue().set_enabled(false);
    let core = core_for(&server, client).await;

    let result = core
        .run(
            serde_json::from_value::<SendParams>(json!({
                "room_id": room_id,
                "body": "x".repeat(MAX_EVENT_CONTENT_BYTES + 1),
            }))
            .unwrap(),
        )
        .await;

    assert!(
        matches!(result, Err(RpcError::MessageTooLarge)),
        "{result:?}"
    );
    assert!(room.send_queue().subscribe().await.unwrap().0.is_empty());
}

#[tokio::test]
async fn oversized_edits_return_message_too_large() {
    use crate::api::messages::EditParams;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!oversized-edit:example.org");
    let event_id = event_id!("$original");
    let factory = EventFactory::new()
        .room(room_id)
        .sender(client.user_id().unwrap());
    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("original").event_id(event_id)),
        )
        .await;
    room.send_queue().set_enabled(false);
    let core = core_for(&server, client).await;
    core.timeline(&room_id.to_owned()).await.unwrap();

    let result = core
        .run(
            serde_json::from_value::<EditParams>(json!({
                "room_id": room_id,
                "event_id": event_id,
                "body": "x".repeat(MAX_EVENT_CONTENT_BYTES + 1),
                "formatted": null,
            }))
            .unwrap(),
        )
        .await;

    assert!(
        matches!(result, Err(RpcError::MessageTooLarge)),
        "{result:?}"
    );
    assert!(room.send_queue().subscribe().await.unwrap().0.is_empty());
}

#[tokio::test]
async fn oversized_direct_sends_return_message_too_large() {
    use crate::api::messages::SendRawEventParams;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!oversized-raw:example.org");
    server.mock_room_state_encryption().plain().mount().await;
    server.sync_joined_room(&client, room_id).await;
    Mock::given(method("PUT"))
        .and(path_regex("/_matrix/client/v3/rooms/.*/send/.*"))
        .respond_with(ResponseTemplate::new(413).set_body_json(json!({
            "errcode": "M_TOO_LARGE",
            "error": "Event too large",
        })))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core_for(&server, client).await;

    let result = core
        .run(
            serde_json::from_value::<SendRawEventParams>(json!({
                "room_id": room_id,
                "event_type": "m.room.message",
                "content": {
                    "msgtype": "m.text",
                    "body": "x".repeat(MAX_EVENT_CONTENT_BYTES + 1),
                },
            }))
            .unwrap(),
        )
        .await;

    assert!(
        matches!(result, Err(RpcError::MessageTooLarge)),
        "{result:?}"
    );
}

#[tokio::test]
async fn permalink_timeline_loads_and_contains_its_target() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!permalink:example.org");
    let target = event_id!("$target");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

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

    let focus = TimelineFocusView::Event {
        event_id: target.to_owned(),
    };
    let timeline = build_room_timeline(&room, &focus, false).await.unwrap();
    assert_eq!(event_ids(timeline.items().await), [target.as_str()]);
}

#[tokio::test]
async fn custom_room_state_reads_from_the_server_when_not_in_the_store() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!banner:example.org");
    let event_type = "page.codeberg.everypizza.room.banner";

    server.sync_joined_room(&client, room_id).await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/state/{event_type}/"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "type": event_type,
            "content": { "url": "mxc://example.org/banner" }
        })))
        .mount(server.server())
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

    let content = core
        .run(EventParams {
            room_id: room_id.to_owned(),
            event_type: event_type.to_owned(),
            state_key: String::new(),
        })
        .await
        .unwrap()
        .map(|json| json.0);

    assert_eq!(content, Some(json!({"url": "mxc://example.org/banner"})));
}

#[expect(clippy::unwrap_used, reason = "test code")]
async fn core_for(server: &MatrixMockServer, client: matrix_sdk::Client) -> Arc<Core> {
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });
    core
}

#[expect(clippy::unwrap_used, reason = "test code")]
async fn read_state(
    core: &Arc<Core>,
    room_id: &matrix_sdk::ruma::RoomId,
    event_type: &str,
) -> Option<serde_json::Value> {
    core.run(EventParams {
        room_id: room_id.to_owned(),
        event_type: event_type.to_owned(),
        state_key: String::new(),
    })
    .await
    .unwrap()
    .map(|json| json.0)
}

#[tokio::test]
async fn reopening_a_room_reuses_the_state_it_probed() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!probe:example.org");
    server.sync_joined_room(&client, room_id).await;

    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{room_id}/state")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
            "type": "moe.sable.room.abbreviations",
            "state_key": "",
            "sender": "@alice:example.org",
            "event_id": "$abbr",
            "origin_server_ts": 1,
            "content": { "terms": { "HS": "homeserver" } }
        }])))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/state/[^/]+/$"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "errcode": "M_NOT_FOUND",
            "error": "not found"
        })))
        .mount(server.server())
        .await;

    let core = core_for(&server, client).await;
    for _ in 0..2 {
        core.run(crate::api::rooms::OpenParams {
            room_id: room_id.to_owned(),
        })
        .await
        .unwrap();
    }

    assert_eq!(
        read_state(&core, room_id, "moe.sable.room.abbreviations").await,
        Some(json!({ "terms": { "HS": "homeserver" } }))
    );
    assert_eq!(
        read_state(&core, room_id, "moe.sable.room.member_list").await,
        None
    );

    let per_key = server
        .server()
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|request| {
            request
                .url
                .path()
                .ends_with("/in.cinny.room.power_level_tags/")
        })
        .count();
    assert!(per_key <= 1, "power level tags fetched {per_key} times");
}

#[tokio::test]
async fn opening_a_room_and_its_cosmetics_fetch_its_state_once() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!shared:example.org");
    server.sync_joined_room(&client, room_id).await;
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{room_id}/state")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!([]))
                .set_delay(Duration::from_millis(50)),
        )
        .expect(1)
        .mount(server.server())
        .await;

    let core = core_for(&server, client).await;
    let (open, cosmetics) = tokio::join!(
        core.run(crate::api::rooms::OpenParams {
            room_id: room_id.to_owned(),
        }),
        core.run(crate::api::rooms::CosmeticsParams {
            room_id: room_id.to_owned(),
            space_id: None,
        })
    );
    open.unwrap();
    cosmetics.unwrap();
}

#[tokio::test]
async fn a_synced_state_event_drops_the_room_state_snapshot() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!snapshot:example.org");
    server.sync_joined_room(&client, room_id).await;
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{room_id}/state")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .expect(2)
        .mount(server.server())
        .await;

    let core = core_for(&server, client.clone()).await;
    core.watch_room_state(&client);
    core.room_state_snapshot(&client, room_id).await.unwrap();
    core.room_state_snapshot(&client, room_id).await.unwrap();
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_state_event(
                EventFactory::new()
                    .sender(user_id!("@alice:example.org"))
                    .room_topic("changed"),
            ),
        )
        .await;
    core.room_state_snapshot(&client, room_id).await.unwrap();
}

#[tokio::test]
async fn a_limited_sync_right_after_a_member_load_does_not_refetch_members() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!members:example.org");
    server.sync_joined_room(&client, room_id).await;
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{room_id}/members")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "chunk": [] })))
        .expect(1)
        .mount(server.server())
        .await;
    server.mock_room_state_encryption().plain().mount().await;

    let core = core_for(&server, client.clone()).await;
    let members = || crate::api::members::ListParams {
        room_id: room_id.to_owned(),
        memberships: Vec::new(),
    };
    core.run(members()).await.unwrap();
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).set_timeline_limited(),
        )
        .await;
    assert!(!client.get_room(room_id).unwrap().are_members_synced());
    core.run(members()).await.unwrap();
}

#[tokio::test]
async fn missing_room_state_is_remembered_until_it_is_written() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!missing:example.org");
    let event_type = "moe.sable.room.member_list";
    server.sync_joined_room(&client, room_id).await;

    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/state/{event_type}/"
        )))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "errcode": "M_NOT_FOUND",
            "error": "not found"
        })))
        .expect(1)
        .mount(server.server())
        .await;
    server
        .mock_room_send_state()
        .ok(event_id!("$written"))
        .mount()
        .await;

    let core = core_for(&server, client).await;
    assert_eq!(read_state(&core, room_id, event_type).await, None);
    assert_eq!(read_state(&core, room_id, event_type).await, None);

    core.run(SendEventParams {
        room_id: room_id.to_owned(),
        event_type: event_type.to_owned(),
        state_key: String::new(),
        content: json!({ "hidden": true }),
    })
    .await
    .unwrap();

    assert_eq!(
        read_state(&core, room_id, event_type).await,
        Some(json!({ "hidden": true }))
    );
}

#[tokio::test]
async fn a_refused_pin_puts_back_the_marker_it_advanced() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!pins:example.org");
    let seen = vec![event_id!("$a").to_owned()];
    let marker = json!({
        "type": "moe.sable.app.pins_read_marker",
        "content": {
            "hash": crate::pin_marker::pins_hash(&seen),
            "count": 1,
            "last_seen_id": "$a",
        },
    });
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_event(
                    EventFactory::new()
                        .room(room_id)
                        .sender(User::Alice)
                        .room_pinned_events(seen.clone()),
                )
                .add_account_data(
                    matrix_sdk::ruma::serde::Raw::new(&marker)
                        .unwrap()
                        .cast_unchecked(),
                ),
        )
        .await;
    let advanced = json!({
        "hash": crate::pin_marker::pins_hash(&[
            event_id!("$a").to_owned(),
            event_id!("$b").to_owned(),
        ]),
        "count": 2,
        "last_seen_id": "$b",
    });
    for body in [advanced, marker["content"].clone()] {
        Mock::given(method("PUT"))
            .and(path_regex("/account_data/moe.sable.app.pins_read_marker$"))
            .and(wiremock::matchers::body_json(body))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
    }
    server
        .mock_set_room_pinned_events()
        .unauthorized()
        .mount()
        .await;

    let core = core_for(&server, client).await;
    let refused = core
        .run(SetPinnedParams {
            room_id: room_id.to_owned(),
            event_id: event_id!("$b").to_owned(),
            pinned: true,
        })
        .await;
    assert!(refused.err().is_some());
}

#[expect(clippy::unwrap_used, reason = "test code")]
fn clear_override(user_id: &str) -> crate::api::account::SetProfileOverrideParams {
    crate::api::account::SetProfileOverrideParams {
        user_id: user_id.try_into().unwrap(),
        display_name: crate::protocol::FieldEdit::Clear,
        avatar: crate::api::account::AvatarEditView::Clear,
        color: crate::protocol::FieldEdit::Clear,
    }
}

#[tokio::test]
async fn a_stable_profile_override_is_written_back_plain() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET"))
        .and(path_regex("/account_data/m.profile_overrides$"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "@s:example.org": { "displayname": "Mum" } })),
        )
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            "/account_data/org.matrix.msc4529.profile_overrides$",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(0)
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex("/account_data/m.profile_overrides$"))
        .and(wiremock::matchers::body_json(json!({})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;

    let core = core_for(&server, client).await;
    let view = core.run(clear_override("@s:example.org")).await.unwrap();
    assert_eq!(
        view.overrides,
        [] as [crate::protocol::ProfileOverrideView; 0]
    );
}

#[tokio::test]
async fn a_locked_profile_override_document_refuses_a_write() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET"))
        .and(path_regex("/account_data/m.profile_overrides$"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "errcode": "M_NOT_FOUND",
            "error": "not found"
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            "/account_data/org.matrix.msc4529.profile_overrides$",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "encrypted": { "iv": "iv", "ciphertext": "sealed", "mac": "mac" }
        })))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex("/account_data/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(0)
        .mount(server.server())
        .await;

    let core = core_for(&server, client).await;
    assert!(matches!(
        core.run(clear_override("@s:example.org")).await,
        Err(crate::protocol::RpcError::DocumentLocked)
    ));
}

#[tokio::test]
async fn account_data_keeps_its_key_order_through_the_editor() {
    use crate::api::account::{DataParams, SetDataParams};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let stored = r#"{"zeta":1,"alpha":{"yankee":1,"bravo":2}}"#;
    Mock::given(method("GET"))
        .and(path_regex("/account_data/org.example.ordered$"))
        .respond_with(ResponseTemplate::new(200).set_body_raw(stored, "application/json"))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex("/account_data/org.example.ordered$"))
        .and(wiremock::matchers::body_string(stored))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;

    let core = core_for(&server, client).await;
    let read = core
        .run(DataParams {
            event_type: "org.example.ordered".to_owned(),
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(serde_json::to_string(&read).unwrap(), stored);

    let edit: SetDataParams = serde_json::from_str(&format!(
        r#"{{"event_type":"org.example.ordered","content":{stored}}}"#
    ))
    .unwrap();
    core.run(edit).await.unwrap();
}

async fn bookmark_core(
    index: ResponseTemplate,
    items: &[(&str, ResponseTemplate)],
) -> (Arc<Core>, MatrixMockServer) {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET"))
        .and(path_regex("/account_data/pl.chrome.bookmarks.index$"))
        .respond_with(index)
        .mount(server.server())
        .await;
    for (id, response) in items {
        Mock::given(method("GET"))
            .and(path_regex(format!(
                "/account_data/pl.chrome.bookmark.{id}$"
            )))
            .respond_with(response.clone())
            .mount(server.server())
            .await;
    }
    let core = core_for(&server, client).await;
    (core, server)
}

fn server_error() -> ResponseTemplate {
    ResponseTemplate::new(500).set_body_json(json!({ "errcode": "M_UNKNOWN", "error": "down" }))
}

#[tokio::test]
async fn bookmarks_fail_when_the_index_cannot_be_read() {
    use crate::api::account::BookmarksParams;

    let (core, _server) = bookmark_core(server_error(), &[]).await;

    core.run(BookmarksParams {}).await.unwrap_err();
}

#[tokio::test]
async fn bookmarks_fail_when_an_item_cannot_be_read() {
    use crate::api::account::BookmarksParams;

    let index = ResponseTemplate::new(200).set_body_json(json!({ "bookmark_ids": ["a"] }));
    let (core, _server) = bookmark_core(index, &[("a", server_error())]).await;

    core.run(BookmarksParams {}).await.unwrap_err();
}

#[tokio::test]
async fn a_corrupt_bookmark_is_skipped_and_the_rest_are_listed() {
    use crate::api::account::BookmarksParams;

    let index = ResponseTemplate::new(200).set_body_json(json!({ "bookmark_ids": ["a", "b"] }));
    let corrupt = ResponseTemplate::new(200).set_body_json(json!({ "room_id": 5 }));
    let valid = ResponseTemplate::new(200).set_body_json(json!({
        "room_id": "!room:example.org",
        "event_id": "$event",
        "bookmarked_ts": 7,
    }));
    let (core, _server) = bookmark_core(index, &[("a", corrupt), ("b", valid)]).await;

    let listed = core.run(BookmarksParams {}).await.unwrap();

    assert_eq!(
        listed
            .iter()
            .map(|bookmark| bookmark.bookmark_id.as_str())
            .collect::<Vec<_>>(),
        ["b"]
    );
}

#[tokio::test]
async fn a_legacy_pack_is_copied_verbatim_to_the_stable_type() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!packs:example.org");
    server.sync_joined_room(&client, room_id).await;
    let legacy = json!({ "pack": { "display_name": "Neo", "x.custom": 1 }, "images": {} });
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/state/im.ponies.room_emotes/stickers"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(&legacy))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/state/m.room.image_pack/stickers"
        )))
        .and(wiremock::matchers::body_json(&legacy))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "event_id": "$copy" })))
        .expect(1)
        .mount(server.server())
        .await;

    let core = core_for(&server, client).await;
    core.run(ConvertLegacyParams {
        room_id: room_id.to_owned(),
        state_keys: vec!["stickers".to_owned()],
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_legacy_pack_keyed_by_a_file_path_is_copied_under_a_generated_key() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!packs:example.org");
    server.sync_joined_room(&client, room_id).await;
    let legacy = json!({ "pack": { "display_name": "Animals" }, "images": {} });
    Mock::given(method("GET"))
        .and(path_regex(format!(
            "^/_matrix/client/v3/rooms/{room_id}/state/im.ponies.room_emotes/.+"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(&legacy))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{room_id}/state")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/state/m.room.image_pack/Etemp"
        )))
        .and(wiremock::matchers::body_json(&legacy))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "event_id": "$copy" })))
        .expect(1)
        .mount(server.server())
        .await;

    let core = core_for(&server, client).await;
    core.run(ConvertLegacyParams {
        room_id: room_id.to_owned(),
        state_keys: vec![r"E:\temp".to_owned()],
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_written_state_event_is_read_back_until_sync_delivers_it() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!written:example.org");
    let event_type = "m.room.topic";
    server.sync_joined_room(&client, room_id).await;
    server
        .mock_room_send_state()
        .ok(event_id!("$topic"))
        .mount()
        .await;

    let core = core_for(&server, client.clone()).await;
    core.watch_room_state(&client);
    core.run(SendEventParams {
        room_id: room_id.to_owned(),
        event_type: event_type.to_owned(),
        state_key: String::new(),
        content: json!({ "topic": "ours" }),
    })
    .await
    .unwrap();
    assert_eq!(
        read_state(&core, room_id, event_type).await,
        Some(json!({ "topic": "ours" }))
    );

    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_state_event(
                EventFactory::new()
                    .room(room_id)
                    .sender(User::Alice)
                    .room_topic("theirs"),
            ),
        )
        .await;
    assert_eq!(
        read_state(&core, room_id, event_type)
            .await
            .and_then(|content| content.get("topic").cloned()),
        Some(json!("theirs"))
    );
}

#[tokio::test]
async fn warmed_rooms_join_the_subscription_set_up_to_a_cap() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let open_room_id = room_id!("!open:example.org");
    server.sync_joined_room(&client, open_room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    let warm_ids = (0..=super::subscriptions::MAX_WARM_ROOMS)
        .map(|index| {
            matrix_sdk::ruma::OwnedRoomId::try_from(format!("!warm{index}:example.org")).unwrap()
        })
        .collect::<Vec<_>>();
    for room_id in &warm_ids {
        server.sync_joined_room(&client, room_id).await;
    }

    let core = core_for(&server, client).await;
    core.run(SubscribeParams {
        room_id: open_room_id.to_owned(),
        focus: TimelineFocusView::Live,
        hidden_events: false,
    })
    .await
    .unwrap();
    core.run(WarmRoomsParams {
        room_ids: vec![room_id!("!unknown:example.org").to_owned()],
    })
    .await
    .unwrap();
    for room_id in &warm_ids {
        core.run(WarmRoomsParams {
            room_ids: vec![room_id.clone()],
        })
        .await
        .unwrap();
    }

    let subscribed = core.room_subscriptions.lock().await.clone();
    assert!(subscribed.contains(open_room_id));
    assert!(!subscribed.contains(room_id!("!unknown:example.org")));
    assert!(!subscribed.contains(&warm_ids[0]));
    assert!(
        warm_ids[1..]
            .iter()
            .all(|room_id| subscribed.contains(room_id))
    );
    assert_eq!(subscribed.len(), super::subscriptions::MAX_WARM_ROOMS + 1);
}

#[tokio::test]
async fn an_opened_room_stays_subscribed_after_another_room_opens() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let first_room_id = room_id!("!first-open:example.org");
    let second_room_id = room_id!("!second-open:example.org");
    server.sync_joined_room(&client, first_room_id).await;
    server.sync_joined_room(&client, second_room_id).await;
    server.mock_room_state_encryption().plain().mount().await;

    let core = core_for(&server, client).await;
    let SubscribeOk {
        subscription: first,
        ..
    } = core
        .run(SubscribeParams {
            room_id: first_room_id.to_owned(),
            focus: TimelineFocusView::Live,
            hidden_events: false,
        })
        .await
        .unwrap();
    core.run(UnsubscribeParams {
        subscription: first,
    })
    .await
    .unwrap();
    core.run(SubscribeParams {
        room_id: second_room_id.to_owned(),
        focus: TimelineFocusView::Live,
        hidden_events: false,
    })
    .await
    .unwrap();

    let subscribed = core.room_subscriptions.lock().await.clone();
    assert!(subscribed.contains(first_room_id));
    assert!(subscribed.contains(second_room_id));
}

#[tokio::test]
async fn timeline_subscriptions_remain_active_until_each_is_unsubscribed() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
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

    let SubscribeOk {
        subscription: first,
        ..
    } = core
        .run(SubscribeParams {
            room_id: first_room_id.to_owned(),
            focus: TimelineFocusView::Live,
            hidden_events: false,
        })
        .await
        .unwrap();
    let SubscribeOk {
        subscription: second,
        ..
    } = core
        .run(SubscribeParams {
            room_id: second_room_id.to_owned(),
            focus: TimelineFocusView::Live,
            hidden_events: false,
        })
        .await
        .unwrap();

    assert!(core.subscriptions.lock().await.contains_key(&first));
    assert!(core.subscriptions.lock().await.contains_key(&second));

    core.run(UnsubscribeParams {
        subscription: first,
    })
    .await
    .unwrap();
    assert!(!core.subscriptions.lock().await.contains_key(&first));
    assert!(core.subscriptions.lock().await.contains_key(&second));
    assert!(core.timelines.lock().await.contains_key(first_room_id));

    core.run(UnsubscribeParams {
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

    let SubscribeOk { subscription, .. } = core
        .run(SubscribeParams {
            room_id: room_id.to_owned(),
            focus: TimelineFocusView::Live,
            hidden_events: false,
        })
        .await
        .unwrap();

    let event = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let event = events.recv().await.expect("open event stream");
            if matches!(event, CoreEvent::TimelinePagination { .. }) {
                break event;
            }
        }
    })
    .await
    .expect("pagination status event");
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
    let room_id = room_id!("!sliding:example.org");
    let sliding_sync = client
        .sliding_sync("timeline-test")
        .unwrap()
        .build()
        .await
        .unwrap();
    sliding_sync.add_room_subscriptions(&[room_id], None, true);
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
    let timeline = build_room_timeline(&room, &TimelineFocusView::Live, false)
        .await
        .unwrap();
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
    let room_id = room_id!("!cleared:example.org");
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

    core.run(SubscribeParams {
        room_id: room_id.to_owned(),
        focus: TimelineFocusView::Live,
        hidden_events: false,
    })
    .await
    .unwrap();

    let result = core
        .run(crate::api::messages::SendStickerParams {
            room_id: room_id.to_owned(),
            url: "mxc://example.org/blob".to_owned(),
            body: "blobwave".to_owned(),
            info: None,
            source_pack: None,
            in_reply_to: None,
            thread_root: None,
            persona: None,
        })
        .await;

    assert!(matches!(result, Ok(())), "{result:?}");

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

#[expect(clippy::unwrap_used, reason = "test code")]
fn attachment_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&u64::try_from(bytes.len()).unwrap().to_le_bytes());
    body.extend_from_slice(&[0; 16]);
    body.extend_from_slice(bytes);
    body
}

async fn send_media_reply(
    core: &Arc<Core>,
    room_id: &matrix_sdk::ruma::RoomId,
    kind: &str,
    outgoing: crate::protocol::Outgoing,
) -> Result<(), RpcError> {
    use crate::protocol::{SendAttachmentRequest, SendGalleryRequest};

    match kind {
        "attachment" => {
            Box::pin(core.send_attachment(
                SendAttachmentRequest {
                    room_id: room_id.to_owned(),
                    filename: "picture.png".to_owned(),
                    mime: "image/png".to_owned(),
                    caption: None,
                    formatted_caption: None,
                    info: None,
                    outgoing,
                    spoiler: false,
                },
                attachment_bytes(&[1, 2, 3]),
            ))
            .await?;
        }
        "gallery" => {
            let view = || crate::protocol::GalleryAttachmentView {
                filename: "picture.png".to_owned(),
                mime: "image/png".to_owned(),
                info: None,
            };
            core.send_gallery(
                SendGalleryRequest {
                    room_id: room_id.to_owned(),
                    attachments: vec![view(), view()],
                    caption: None,
                    formatted_caption: None,
                    outgoing,
                },
                [attachment_bytes(&[1, 2, 3]), attachment_bytes(&[1, 2, 3])].concat(),
            )
            .await?;
        }
        "gif" => {
            core.run(crate::api::messages::SendGifParams {
                room_id: room_id.to_owned(),
                url: "mxc://example.org/gif".to_owned(),
                body: "cat.gif".to_owned(),
                width: None,
                height: None,
                mimetype: "image/gif".to_owned(),
                size: None,
                in_reply_to: outgoing.in_reply_to,
                silent_reply: outgoing.silent_reply,
                thread_root: outgoing.thread_root,
                persona: outgoing.persona,
            })
            .await?;
        }
        "location" => {
            core.run(crate::api::messages::SendLocationParams {
                persona: outgoing.persona,
                room_id: room_id.to_owned(),
                body: "here".to_owned(),
                geo_uri: "geo:48,2".to_owned(),
                in_reply_to: outgoing.in_reply_to,
                silent_reply: outgoing.silent_reply,
                thread_root: outgoing.thread_root,
            })
            .await?;
        }
        _ => unreachable!(),
    }
    Ok(())
}

async fn wait_for_sent_message(
    server: &MatrixMockServer,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    Ok(tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let requests = server
                .server()
                .received_requests()
                .await
                .unwrap_or_default();
            if let Some(request) = requests
                .iter()
                .find(|request| request.url.path().contains("/send/m.room.message/"))
            {
                break request.body_json::<serde_json::Value>();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await??)
}

#[tokio::test]
async fn media_replies_preserve_silent_mentions_on_the_wire() {
    for kind in ["attachment", "gallery", "gif", "location"] {
        for (silent_reply, explicit_mention) in [(false, false), (true, false), (true, true)] {
            if explicit_mention && matches!(kind, "gif" | "location") {
                continue;
            }
            let server = MatrixMockServer::new().await;
            let client = server.client_builder().build().await;
            let room_id = room_id!("!silent-media:example.org");
            let target = event_id!("$target");
            let sender = user_id!("@ana:example.org");
            let mentioned = user_id!("@bea:example.org");
            let factory = EventFactory::new().room(room_id).sender(sender);
            server
                .sync_room(
                    &client,
                    JoinedRoomBuilder::new(room_id)
                        .add_timeline_event(factory.text_msg("original").event_id(target)),
                )
                .await;
            server.mock_room_state_encryption().plain().mount().await;
            server
                .mock_authenticated_media_config()
                .ok_default()
                .mount()
                .await;
            server
                .mock_upload()
                .ok(matrix_sdk::ruma::mxc_uri!("mxc://example.org/uploaded"))
                .mount()
                .await;
            server.mock_room_send().ok(event_id!("$sent")).mount().await;

            let sync_service =
                Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
            let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
            *core.session.write().await = Some(Session {
                account_id: "test".to_owned(),
                client,
                sync_service,
                homeserver: server.server().uri(),
                oauth: false,
            });
            core.run(SubscribeParams {
                room_id: room_id.to_owned(),
                focus: TimelineFocusView::Live,
                hidden_events: false,
            })
            .await
            .unwrap();

            let outgoing = Outgoing {
                in_reply_to: Some(target.to_owned()),
                silent_reply,
                thread_root: None,
                mentions: if explicit_mention {
                    vec![mentioned.to_owned()]
                } else {
                    Vec::new()
                },
                mentions_room: false,
                persona: Some(crate::protocol::PerMessageProfileView {
                    id: Some("kris".to_owned()),
                    display_name: Some("Kris".to_owned()),
                    avatar_url: None,
                    pronouns: Vec::new(),
                    color_on_light: None,
                    color_on_dark: None,
                    has_fallback: false,
                    biography: None,
                    banner_url: None,
                    is_animal: None,
                    has_animal: None,
                    animal_need: None,
                }),
            };
            Box::pin(send_media_reply(&core, room_id, kind, outgoing))
                .await
                .unwrap();

            let sent = wait_for_sent_message(&server).await.unwrap();
            assert_eq!(
                sent["m.relates_to"]["m.in_reply_to"]["event_id"],
                target.as_str(),
                "{kind}"
            );
            assert_eq!(
                sent[crate::personas::PER_MESSAGE_PROFILE]["id"],
                "kris",
                "{kind}"
            );
            let expected = if explicit_mention {
                json!({ "user_ids": [mentioned] })
            } else if silent_reply {
                json!({})
            } else {
                json!({ "user_ids": [sender] })
            };
            assert_eq!(
                sent["m.mentions"], expected,
                "{kind}, silent={silent_reply}"
            );
        }
    }
}

#[tokio::test]
async fn media_config_is_cached_per_account_and_supports_legacy_servers() {
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    for (version, upload_size) in [("v1.11", 500_000_000), ("v1.1", 10_000_000)] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().no_server_versions().build().await;
        server
            .mock_versions()
            .with_versions(vec![version])
            .ok()
            .mount()
            .await;
        if version == "v1.11" {
            server
                .mock_authenticated_media_config()
                .ok(upload_size.try_into().unwrap())
                .expect(1)
                .mount()
                .await;
        } else {
            server
                .mock_media_config()
                .ok(upload_size.try_into().unwrap())
                .expect(1)
                .mount()
                .await;
        }
        let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
        *core.session.write().await = Some(Session {
            account_id: version.to_owned(),
            client,
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
        });
        for _ in 0..2 {
            let response = core
                .run(crate::api::messages::MediaConfigParams {})
                .await
                .unwrap();
            assert_eq!(response.upload_size, upload_size);
        }
    }
}

#[tokio::test]
async fn attachments_use_the_server_upload_limit_instead_of_100_mib() {
    for (upload_size, file_size) in [(2_u64, 3_usize), (200 * 1024 * 1024, 100 * 1024 * 1024 + 1)] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.send_queue().set_enabled(false).await;
        let room_id = room_id!("!upload-limit:example.org");
        server.sync_joined_room(&client, room_id).await;
        server.mock_room_state_encryption().plain().mount().await;
        server
            .mock_authenticated_media_config()
            .ok(upload_size.try_into().unwrap())
            .expect(1)
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
        let request = serde_json::from_value(json!({
            "room_id": room_id,
            "filename": "large.bin",
            "mime": "application/octet-stream",
        }))
        .unwrap();
        let result =
            Box::pin(core.send_attachment(request, attachment_bytes(&vec![0; file_size]))).await;
        if u64::try_from(file_size).unwrap() > upload_size {
            assert!(matches!(result, Err(RpcError::InvalidMedia)));
        } else {
            result.unwrap();
        }
    }
}

#[tokio::test]
async fn a_gallery_mixing_a_picture_and_a_pdf_sends_each_as_its_own_itemtype() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!send-gallery:example.org");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    server
        .mock_authenticated_media_config()
        .ok(matrix_sdk::ruma::uint!(4))
        .mount()
        .await;
    server
        .mock_upload()
        .ok(matrix_sdk::ruma::mxc_uri!("mxc://example.org/uploaded"))
        .mount()
        .await;
    server
        .mock_room_send()
        .ok(event_id!("$gallery"))
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

    core.send_gallery(
        crate::protocol::SendGalleryRequest {
            room_id: room_id.to_owned(),
            attachments: vec![
                crate::protocol::GalleryAttachmentView {
                    filename: "beach.png".to_owned(),
                    mime: "image/png".to_owned(),
                    info: None,
                },
                crate::protocol::GalleryAttachmentView {
                    filename: "report.pdf".to_owned(),
                    mime: "application/pdf".to_owned(),
                    info: None,
                },
            ],
            caption: None,
            formatted_caption: None,
            outgoing: crate::protocol::Outgoing {
                mentions: Vec::new(),
                mentions_room: false,
                in_reply_to: None,
                silent_reply: false,
                thread_root: None,
                persona: None,
            },
        },
        [
            attachment_bytes(&[1, 2, 3]),
            attachment_bytes(&[4, 5, 6, 7]),
        ]
        .concat(),
    )
    .await
    .unwrap();

    let sent = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let requests = server
                .server()
                .received_requests()
                .await
                .unwrap_or_default();
            if let Some(request) = requests
                .iter()
                .find(|request| request.url.path().contains("/send/m.room.message/"))
            {
                break request
                    .body_json::<serde_json::Value>()
                    .expect("gallery body");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the send queue flushed the gallery");

    assert_eq!(sent["itemtypes"][0]["itemtype"], "m.image");
    assert_eq!(sent["itemtypes"][1]["itemtype"], "m.file");
    assert_eq!(sent["itemtypes"][1]["body"], "report.pdf");
    assert_eq!(sent["itemtypes"][1]["info"]["mimetype"], "application/pdf");
    assert_eq!(sent["itemtypes"][1]["info"]["size"], 4);
    assert_eq!(sent["itemtypes"][1]["url"], "mxc://example.org/uploaded");
}

#[tokio::test]
async fn videos_and_galleries_upload_their_thumbnails() {
    for gallery in [false, true] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!video:example.org");
        server.sync_joined_room(&client, room_id).await;
        server.mock_room_state_encryption().plain().mount().await;
        server
            .mock_authenticated_media_config()
            .ok(matrix_sdk::ruma::uint!(4))
            .mount()
            .await;
        server
            .mock_upload()
            .ok(matrix_sdk::ruma::mxc_uri!("mxc://example.org/uploaded"))
            .mount()
            .await;
        server
            .mock_room_send()
            .ok(event_id!("$video"))
            .mount()
            .await;
        let core = core_for(&server, client).await;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2_u64.to_le_bytes());
        bytes.extend_from_slice(&3_u64.to_le_bytes());
        bytes.extend_from_slice(&800_u32.to_le_bytes());
        bytes.extend_from_slice(&450_u32.to_le_bytes());
        bytes.extend_from_slice(&[1, 2, 255, 216, 255]);
        let attachment = json!({"filename": "video.mp4", "mime": "video/mp4"});
        if gallery {
            core.send_gallery(
                serde_json::from_value(json!({
                    "room_id": room_id, "attachments": [attachment, attachment],
                }))
                .unwrap(),
                [bytes.clone(), bytes].concat(),
            )
            .await
            .unwrap();
        } else {
            Box::pin(
                core.send_attachment(
                    serde_json::from_value(json!({
                        "room_id": room_id, "filename": "video.mp4", "mime": "video/mp4",
                    }))
                    .unwrap(),
                    bytes,
                ),
            )
            .await
            .unwrap();
        }
        let sent = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let requests = server
                    .server()
                    .received_requests()
                    .await
                    .unwrap_or_default();
                if let Some(request) = requests
                    .iter()
                    .find(|request| request.url.path().contains("/send/m.room.message/"))
                {
                    break request.body_json::<serde_json::Value>().unwrap();
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("the video was sent");
        let items = if gallery {
            sent["itemtypes"].as_array().unwrap().clone()
        } else {
            vec![sent]
        };
        for item in items {
            assert_eq!(item["info"]["thumbnail_url"], "mxc://example.org/uploaded");
            assert_eq!(
                item["info"]["thumbnail_info"],
                json!({"w": 800, "h": 450, "size": 3, "mimetype": "image/jpeg"})
            );
        }
        let requests = server.server().received_requests().await.unwrap();
        assert!(
            requests
                .iter()
                .any(|request| request.body == [255, 216, 255])
        );
    }
}

#[tokio::test]
async fn a_room_read_elsewhere_reports_the_server_unread_count() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!read-elsewhere:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

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
    let summary = super::view::room_list_item(
        &item,
        &std::collections::HashMap::new(),
        &matrix_sdk::ruma::push::Ruleset::new(),
    );

    assert_eq!(item.num_unread_messages(), 2);
    assert_eq!(summary.unread, 0);
    assert_eq!(summary.highlight, 0);
}

#[tokio::test]
async fn a_count_truncated_by_the_local_cache_falls_back_to_the_server_count() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!truncated:example.org");
    let me = client
        .user_id()
        .expect("the mock client is logged in")
        .to_owned();
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

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
                .add_receipt(
                    factory
                        .read_receipts()
                        .add(
                            event_id!("$one"),
                            &me,
                            ReceiptType::Read,
                            ReceiptThread::Unthreaded,
                        )
                        .into_event(),
                )
                .set_unread_notifications_count(json!({
                    "notification_count": 9,
                    "highlight_count": 2,
                })),
        )
        .await;

    let item = matrix_sdk_ui::room_list_service::RoomListItem::from(room);

    assert_eq!(item.num_unread_messages(), 1);
    assert_eq!(
        super::view::unread_counts(&item, Some(event_id!("$two")), false),
        (9, 2)
    );
    assert_eq!(
        super::view::notifying_count(&item, Some(event_id!("$two")), false),
        9
    );
}

#[tokio::test]
async fn a_server_that_pushes_every_encrypted_event_does_not_count_them_as_unread() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!pushes-everything:example.org");
    let me = client
        .user_id()
        .expect("the mock client is logged in")
        .to_owned();
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_event(factory.room_encryption())
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
                .add_receipt(
                    factory
                        .read_receipts()
                        .add(
                            event_id!("$one"),
                            &me,
                            ReceiptType::Read,
                            ReceiptThread::Unthreaded,
                        )
                        .into_event(),
                )
                .set_unread_notifications_count(json!({
                    "notification_count": 9,
                    "highlight_count": 0,
                })),
        )
        .await;

    let item = matrix_sdk_ui::room_list_service::RoomListItem::from(room);

    assert!(item.encryption_state().is_encrypted());
    assert_eq!(
        super::view::unread_counts(&item, Some(event_id!("$two")), false),
        (9, 0)
    );
    assert_eq!(
        super::view::unread_counts(&item, Some(event_id!("$two")), true),
        (1, 0)
    );
    assert_eq!(
        super::view::notifying_count(&item, Some(event_id!("$two")), true),
        u32::try_from(item.num_unread_notifications()).unwrap()
    );
    assert_eq!(
        super::view::notifying_count(&item, Some(event_id!("$two")), false),
        9
    );
}

#[tokio::test]
async fn unread_reply_counts_persist_until_read() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!old-mentions:example.org");
    let me = client
        .user_id()
        .expect("the mock client is logged in")
        .to_owned();
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let mention = |event_id| {
        factory
            .text_msg("hey")
            .reply_to(event_id!("$original"))
            .mentions(matrix_sdk::ruma::events::Mentions::with_user_ids([
                me.clone()
            ]))
            .event_id(event_id)
            .into_raw()
    };
    let rules = matrix_sdk::ruma::push::Ruleset::server_default(&me);
    let joined = JoinedRoomBuilder::new(room_id)
        .add_state_event(factory.member(&me))
        .add_state_event(factory.power_levels())
        .add_timeline_bulk([mention(event_id!("$one")), mention(event_id!("$two"))])
        .add_receipt(
            factory
                .read_receipts()
                .add(
                    event_id!("$uncached"),
                    &me,
                    ReceiptType::Read,
                    ReceiptThread::Unthreaded,
                )
                .into_event(),
        )
        .set_unread_notifications_count(json!({
            "notification_count": 2,
            "highlight_count": 2,
        }));
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_global_account_data(factory.push_rules(rules));
            builder.add_joined_room(joined);
        })
        .await;
    let item =
        matrix_sdk_ui::room_list_service::RoomListItem::from(client.get_room(room_id).unwrap());

    assert_eq!(
        super::view::unread_counts(&item, Some(event_id!("$two")), false),
        (2, 2)
    );

    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).set_unread_notifications_count(json!({
                "notification_count": 0,
                "highlight_count": 0,
            })),
        )
        .await;

    assert_eq!(item.num_unread_mentions(), 2);
    assert_eq!(
        super::view::unread_counts(&item, Some(event_id!("$two")), false),
        (2, 2)
    );

    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_receipt(
                    factory
                        .read_receipts()
                        .add(
                            event_id!("$two"),
                            &me,
                            ReceiptType::Read,
                            ReceiptThread::Unthreaded,
                        )
                        .into_event(),
                )
                .set_unread_notifications_count(json!({
                    "notification_count": 2,
                    "highlight_count": 2,
                })),
        )
        .await;

    assert_eq!(
        super::view::unread_counts(&item, Some(event_id!("$two")), false),
        (0, 0)
    );
}

#[tokio::test]
async fn a_receipt_on_the_latest_event_clears_a_stale_server_count() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!caught-up:example.org");
    let me = client
        .user_id()
        .expect("the mock client is logged in")
        .to_owned();
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

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
                .add_receipt(
                    factory
                        .read_receipts()
                        .add(
                            event_id!("$two"),
                            &me,
                            ReceiptType::Read,
                            ReceiptThread::Unthreaded,
                        )
                        .into_event(),
                )
                .set_unread_notifications_count(json!({
                    "notification_count": 9,
                    "highlight_count": 2,
                })),
        )
        .await;

    let item = matrix_sdk_ui::room_list_service::RoomListItem::from(room);

    assert_eq!(
        super::view::unread_counts(&item, Some(event_id!("$two")), false),
        (0, 0)
    );
}

async fn timeline_views(
    client: &matrix_sdk::Client,
    room: &matrix_sdk::Room,
    hidden_events: bool,
) -> Option<Vec<crate::protocol::TimelineItemView>> {
    let timeline = build_room_timeline(room, &TimelineFocusView::Live, hidden_events)
        .await
        .ok()?;

    Some(
        timeline
            .items()
            .await
            .iter()
            .map(|item| {
                super::view::timeline_item(
                    item,
                    client.user_id(),
                    &super::view::Highlights::default(),
                    &super::view::LocalContent::default(),
                )
            })
            .collect(),
    )
}

fn only_poll(views: &[crate::protocol::TimelineItemView]) -> Option<crate::protocol::PollView> {
    views.iter().find_map(|view| match &view.content {
        crate::protocol::TimelineItemContentView::Poll { poll } => Some(poll.clone()),
        _ => None,
    })
}

/// The factory's poll is undisclosed, which is ruma's default for an absent
/// `kind`, so a disclosed poll has to be built here.
fn poll_content(
    question: &str,
    answers: &[&str],
    undisclosed: bool,
) -> Option<matrix_sdk::ruma::events::poll::unstable_start::UnstablePollStartEventContent> {
    let answers: Vec<String> = answers.iter().map(|text| (*text).to_owned()).collect();
    let mut content = crate::polls::start(question, &answers, undisclosed, 1)?;
    content.text = None;
    Some(content.into())
}

#[tokio::test]
async fn a_poll_carries_its_tally_and_the_answer_this_account_picked() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!poll:example.org");
    let own = client.user_id().expect("a logged-in client").to_owned();
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let start = event_id!("$poll");

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(
                    factory
                        .event(
                            poll_content("lunch?", &["ramen", "curry"], false)
                                .expect("a question and two answers are a valid poll"),
                        )
                        .event_id(start),
                )
                .add_timeline_event(
                    factory
                        .poll_response(vec!["1"], start)
                        .sender(&own)
                        .event_id(event_id!("$mine")),
                )
                .add_timeline_event(
                    factory
                        .poll_response(vec!["0"], start)
                        .event_id(event_id!("$theirs")),
                ),
        )
        .await;

    let views = timeline_views(&client, &room, false)
        .await
        .expect("a timeline for a joined room");
    let poll = only_poll(&views).expect("a poll on the timeline");

    assert_eq!(poll.question, "lunch?");
    assert_eq!(poll.max_selections, 1);
    assert!(!poll.undisclosed);
    assert_eq!(poll.ended_at, None);
    let answers: Vec<_> = poll
        .answers
        .iter()
        .map(|answer| (answer.text.as_str(), answer.votes, answer.selected))
        .collect();
    assert_eq!(
        answers,
        [("ramen", Some(1), false), ("curry", Some(1), true)]
    );
}

#[tokio::test]
async fn a_poll_that_repeats_an_answer_id_lists_it_once() {
    use matrix_sdk::ruma::events::poll::unstable_start::{
        NewUnstablePollStartEventContent, UnstablePollAnswer, UnstablePollAnswers,
        UnstablePollStartContentBlock, UnstablePollStartEventContent,
    };

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!poll-repeat:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let answers = UnstablePollAnswers::try_from(vec![
        UnstablePollAnswer::new("0", "ramen"),
        UnstablePollAnswer::new("0", "curry"),
        UnstablePollAnswer::new("1", "soup"),
    ])
    .expect("three answers are within the limits");
    let content: UnstablePollStartEventContent = NewUnstablePollStartEventContent::new(
        UnstablePollStartContentBlock::new("lunch?", answers),
    )
    .into();

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.event(content).event_id(event_id!("$repeat"))),
        )
        .await;

    let views = timeline_views(&client, &room, false)
        .await
        .expect("a timeline for a joined room");
    let poll = only_poll(&views).expect("a poll on the timeline");
    let ids: Vec<_> = poll
        .answers
        .iter()
        .map(|answer| answer.id.as_str())
        .collect();
    assert_eq!(ids, ["0", "1"]);
}

#[tokio::test]
async fn an_undisclosed_poll_withholds_its_tally_until_it_closes() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!undisclosed:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let start = event_id!("$poll");

    let content = poll_content("lunch?", &["ramen"], true)
        .expect("a question and one answer are a valid poll");

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.event(content).event_id(start))
                .add_timeline_event(
                    factory
                        .poll_response(vec!["0"], start)
                        .event_id(event_id!("$vote")),
                ),
        )
        .await;

    let open_views = timeline_views(&client, &room, false)
        .await
        .expect("a timeline for a joined room");
    let open = only_poll(&open_views).expect("a poll on the timeline");

    assert!(open.undisclosed);
    assert_eq!(open.answers.first().map(|answer| answer.votes), Some(None));

    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                factory
                    .poll_end("closed", start)
                    .event_id(event_id!("$end")),
            ),
        )
        .await;

    let closed_views = timeline_views(&client, &room, false)
        .await
        .expect("a timeline for a joined room");
    let closed = only_poll(&closed_views).expect("a poll on the timeline");

    assert!(closed.ended_at.is_some());
    assert_eq!(
        closed.answers.first().map(|answer| answer.votes),
        Some(Some(1))
    );
}

fn contents(
    views: &[crate::protocol::TimelineItemView],
) -> Vec<crate::protocol::TimelineItemContentView> {
    views.iter().map(|view| view.content.clone()).collect()
}

#[tokio::test]
async fn a_poll_kind_we_do_not_recognise_withholds_its_tally() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!custom:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let start = event_id!("$poll");

    let mut content = poll_content("lunch?", &["ramen"], false)
        .expect("a question and one answer are a valid poll");
    if let matrix_sdk::ruma::events::poll::unstable_start::UnstablePollStartEventContent::New(new) =
        &mut content
    {
        new.poll_start.kind =
            matrix_sdk::ruma::events::poll::start::PollKind::from("org.example.secret");
    }

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.event(content).event_id(start))
                .add_timeline_event(
                    factory
                        .poll_response(vec!["0"], start)
                        .event_id(event_id!("$vote")),
                ),
        )
        .await;

    let views = timeline_views(&client, &room, false)
        .await
        .expect("a timeline for a joined room");
    let poll = only_poll(&views).expect("a poll on the timeline");

    assert!(poll.undisclosed);
    assert_eq!(poll.answers.first().map(|answer| answer.votes), Some(None));
}

#[tokio::test]
async fn a_location_reaches_the_view_with_its_coordinates_parsed() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!location:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                factory
                    .event(RoomMessageEventContent::new(MessageType::Location(
                        LocationMessageEventContent::new(
                            "Big Ben".to_owned(),
                            "geo:51.5007,-0.1246;u=35".to_owned(),
                        ),
                    )))
                    .event_id(event_id!("$where")),
            ),
        )
        .await;

    let views = timeline_views(&client, &room, false)
        .await
        .expect("a timeline for a joined room");
    let location = contents(&views)
        .into_iter()
        .find_map(|content| match content {
            crate::protocol::TimelineItemContentView::Location {
                body,
                geo_uri,
                latitude,
                longitude,
            } => Some((body, geo_uri, latitude, longitude)),
            _ => None,
        })
        .expect("a location on the timeline");

    assert_eq!(location.0, "Big Ben");
    assert_eq!(location.1, "geo:51.5007,-0.1246;u=35");
    assert_eq!(location.2, Some(51.5007));
    assert_eq!(location.3, Some(-0.1246));
}

#[tokio::test]
async fn live_location_beacons_reach_the_view_as_updated_coordinates() {
    use matrix_sdk::ruma::MilliSecondsSinceUnixEpoch;
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!live-location:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let timestamp = MilliSecondsSinceUnixEpoch::now();
    server.mock_room_state_encryption().plain().mount().await;
    let share_event_id = event_id!("$share");
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(
                    factory
                        .beacon_info(
                            Some("Walk".to_owned()),
                            Duration::from_mins(1),
                            true,
                            Some(timestamp),
                        )
                        .state_key(User::Alice)
                        .event_id(share_event_id),
                )
                .add_timeline_event(
                    factory
                        .beacon(share_event_id.to_owned(), 48.8, 2.3, 10, Some(timestamp))
                        .event_id(event_id!("$position")),
                ),
        )
        .await;
    let views = timeline_views(&client, &room, false).await.unwrap();
    let location = views
        .iter()
        .find(|view| view.event_id.as_deref() == Some(share_event_id))
        .unwrap();
    let json = serde_json::to_value(&location.content).unwrap();
    assert_eq!(json["kind"], "live_location");
    assert_eq!(json["latitude"], 48.8);
    assert_eq!(json["longitude"], 2.3);
    assert_eq!(json["live"], true);
    assert_eq!(json["updated_at"], u64::from(timestamp.get()));
    assert!(
        !views
            .iter()
            .any(|view| view.event_id.as_deref() == Some(event_id!("$position")))
    );
}

#[tokio::test]
async fn an_emoji_only_message_is_sized_as_jumbo() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!jumbo:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("👍🎉").event_id(event_id!("$emoji")))
                .add_timeline_event(factory.text_msg("nice 👍").event_id(event_id!("$words"))),
        )
        .await;

    let sizes: Vec<_> = contents(
        &timeline_views(&client, &room, false)
            .await
            .expect("a timeline for a joined room"),
    )
    .into_iter()
    .filter_map(|content| match content {
        crate::protocol::TimelineItemContentView::Message { jumbo, .. } => Some(jumbo),
        _ => None,
    })
    .collect();

    assert_eq!(sizes, [Some(2), None]);
}

#[tokio::test]
async fn a_notice_is_marked_as_one_rather_than_read_as_speech() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!notice:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.notice("build failed").event_id(event_id!("$bot")))
                .add_timeline_event(factory.text_msg("hello").event_id(event_id!("$human"))),
        )
        .await;

    let flags: Vec<_> = contents(
        &timeline_views(&client, &room, false)
            .await
            .expect("a timeline for a joined room"),
    )
    .into_iter()
    .filter_map(|content| match content {
        crate::protocol::TimelineItemContentView::Message { body, notice, .. } => {
            Some((body, notice))
        }
        _ => None,
    })
    .collect();

    assert_eq!(
        flags,
        [
            ("build failed".to_owned(), true),
            ("hello".to_owned(), false)
        ]
    );
}

#[tokio::test]
async fn a_gallery_reaches_the_view_as_one_item_per_attachment() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!gallery:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                factory
                    .gallery(
                        "holiday".to_owned(),
                        "beach.jpg".to_owned(),
                        matrix_sdk::ruma::owned_mxc_uri!("mxc://example.org/beach"),
                    )
                    .event_id(event_id!("$gallery")),
            ),
        )
        .await;

    let gallery = contents(
        &timeline_views(&client, &room, false)
            .await
            .expect("a timeline for a joined room"),
    )
    .into_iter()
    .find_map(|content| match content {
        crate::protocol::TimelineItemContentView::Gallery { body, items, .. } => {
            Some((body, items))
        }
        _ => None,
    })
    .expect("a gallery on the timeline");

    assert_eq!(gallery.0, "holiday");
    assert!(matches!(
        gallery.1.as_slice(),
        [crate::protocol::GalleryItemView::Image { filename, .. }] if filename == "beach.jpg"
    ));
}

#[tokio::test]
async fn a_gallery_item_carries_what_a_single_attachment_does() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!gallery-items:example.org");

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                serde_json::from_value::<
                    matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::AnySyncTimelineEvent>,
                >(json!({
                    "type": "m.room.message",
                    "event_id": "$gallery",
                    "sender": User::Alice,
                    "origin_server_ts": 1,
                    "content": {
                        "msgtype": "dm.filament.gallery",
                        "body": "",
                        "itemtypes": [
                            {
                                "itemtype": "m.image",
                                "body": "the beach",
                                "filename": "beach.jpg",
                                "url": "mxc://example.org/beach",
                                "info": { "mimetype": "image/jpeg", "size": 2048 },
                                "page.codeberg.everypizza.msc4193.spoiler": true,
                                "page.codeberg.everypizza.msc4193.spoiler.reason": "sunburn"
                            },
                            {
                                "itemtype": "m.audio",
                                "body": "memo.ogg",
                                "url": "mxc://example.org/memo",
                                "info": { "mimetype": "audio/ogg" },
                                "org.matrix.msc1767.audio": { "duration": 4000, "waveform": [0, 1024] }
                            },
                            {
                                "itemtype": "m.file",
                                "body": "report.pdf",
                                "url": "mxc://example.org/report",
                                "info": { "mimetype": "application/pdf", "size": 4096 }
                            }
                        ]
                    }
                }))
                .unwrap(),
            ),
        )
        .await;

    let items = contents(
        &timeline_views(&client, &room, false)
            .await
            .expect("a timeline for a joined room"),
    )
    .into_iter()
    .find_map(|content| match content {
        crate::protocol::TimelineItemContentView::Gallery { items, .. } => Some(items),
        _ => None,
    })
    .expect("a gallery on the timeline");

    let json = serde_json::to_value(&items).unwrap();
    assert_eq!(json[0]["filename"], "beach.jpg");
    assert_eq!(json[0]["caption"], "the beach");
    assert_eq!(json[0]["size"], 2048);
    assert_eq!(json[0]["spoiler"], "sunburn");
    assert_eq!(json[1]["filename"], "memo.ogg");
    assert_eq!(json[1]["caption"], serde_json::Value::Null);
    assert_eq!(json[1]["duration_ms"], 4000);
    assert_eq!(json[1]["waveform"], json!([0.0, 1.0]));
    assert_eq!(json[2]["filename"], "report.pdf");
    assert_eq!(json[2]["size"], 4096);
}

#[tokio::test]
async fn a_reply_quotes_formatted_text() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!formatted-reply:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(
                    factory
                        .text_html(
                            "**bold** and `code`",
                            "<strong>bold</strong> and <code>code</code>",
                        )
                        .event_id(event_id!("$formatted")),
                )
                .add_timeline_event(
                    factory
                        .text_msg("nice")
                        .reply_to(event_id!("$formatted"))
                        .event_id(event_id!("$reply")),
                ),
        )
        .await;

    let views = timeline_views(&client, &room, false).await.unwrap();
    let reply = views
        .iter()
        .find(|view| view.event_id.as_deref() == Some(event_id!("$reply")))
        .and_then(|view| view.in_reply_to.as_ref())
        .unwrap();
    assert_eq!(reply.body.as_deref(), Some("bold and code"));
}

#[tokio::test]
async fn a_reply_to_an_uncaptioned_gallery_quotes_its_file_names() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!gallery-reply:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(
                    factory
                        .gallery(
                            String::new(),
                            "beach.jpg".to_owned(),
                            matrix_sdk::ruma::owned_mxc_uri!("mxc://example.org/beach"),
                        )
                        .event_id(event_id!("$gallery")),
                )
                .add_timeline_event(
                    factory
                        .text_msg("nice")
                        .reply_to(event_id!("$gallery"))
                        .event_id(event_id!("$reply")),
                ),
        )
        .await;

    let views = timeline_views(&client, &room, false)
        .await
        .expect("a timeline for a joined room");
    let reply = views
        .iter()
        .find(|view| view.event_id.as_deref() == Some(event_id!("$reply")))
        .and_then(|view| view.in_reply_to.as_ref())
        .expect("a reply");

    assert_eq!(reply.body.as_deref(), Some("beach.jpg"));
}

#[tokio::test]
async fn a_reply_to_a_verification_request_does_not_quote_its_fallback_body() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!verification-reply:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let request = RoomMessageEventContent::new(MessageType::VerificationRequest(
        KeyVerificationRequestEventContent::new(
            "Your client does not support verification".to_owned(),
            vec![VerificationMethod::SasV1],
            "DEVICE".into(),
            user_id!("@bob:example.org").to_owned(),
        ),
    ));
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.event(request).event_id(event_id!("$request")))
                .add_timeline_event(
                    factory
                        .text_msg("nice")
                        .reply_to(event_id!("$request"))
                        .event_id(event_id!("$reply")),
                ),
        )
        .await;

    let views = timeline_views(&client, &room, false)
        .await
        .expect("a timeline for a joined room");
    let reply = views
        .iter()
        .find(|view| view.event_id.as_deref() == Some(event_id!("$reply")))
        .and_then(|view| view.in_reply_to.as_ref())
        .expect("a reply");

    assert_eq!(reply.body, None);
    assert_eq!(
        reply.fallback,
        Some(crate::protocol::ReplyFallbackView::VerificationRequest)
    );
}

#[tokio::test]
async fn replies_to_state_and_membership_events_carry_no_body() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!state-reply:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.room_name("Sable").event_id(event_id!("$name")))
                .add_timeline_event(
                    factory
                        .text_msg("nice")
                        .reply_to(event_id!("$name"))
                        .event_id(event_id!("$reply")),
                )
                .add_timeline_event(factory.member(User::Alice).event_id(event_id!("$member")))
                .add_timeline_event(
                    factory
                        .text_msg("welcome")
                        .reply_to(event_id!("$member"))
                        .event_id(event_id!("$member-reply")),
                ),
        )
        .await;

    let views = timeline_views(&client, &room, false)
        .await
        .expect("a timeline for a joined room");
    let state_reply = views
        .iter()
        .find(|view| view.event_id.as_deref() == Some(event_id!("$reply")))
        .and_then(|view| view.in_reply_to.as_ref())
        .expect("a reply");
    let membership_reply = views
        .iter()
        .find(|view| view.event_id.as_deref() == Some(event_id!("$member-reply")))
        .and_then(|view| view.in_reply_to.as_ref())
        .expect("a membership reply");

    assert_eq!(state_reply.body, None);
    assert_eq!(membership_reply.body, None);
}

fn state_changes(
    views: &[crate::protocol::TimelineItemView],
) -> Vec<Option<crate::protocol::StateChangeView>> {
    views
        .iter()
        .filter_map(|view| match &view.content {
            crate::protocol::TimelineItemContentView::StateEvent { change, .. } => {
                Some(change.clone())
            }
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_renamed_room_carries_both_names_and_a_new_topic_carries_its_text() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!named:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.room_name("second").event_id(event_id!("$name")))
                .add_timeline_event(
                    factory
                        .room_topic("what we do")
                        .event_id(event_id!("$topic")),
                ),
        )
        .await;

    let changes = state_changes(
        &timeline_views(&client, &room, false)
            .await
            .expect("a timeline for a joined room"),
    );

    assert!(matches!(
        changes.as_slice(),
        [
            Some(crate::protocol::StateChangeView::RoomName { name, previous: None }),
            Some(crate::protocol::StateChangeView::RoomTopic { topic }),
        ] if name.as_deref() == Some("second") && topic.as_deref() == Some("what we do")
    ));
}

#[tokio::test]
async fn a_pin_change_reports_what_was_added_and_dropped() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!pinned:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                factory
                    .room_pinned_events(vec![
                        event_id!("$kept").to_owned(),
                        event_id!("$new").to_owned(),
                    ])
                    .event_id(event_id!("$pin")),
            ),
        )
        .await;

    let changes = state_changes(
        &timeline_views(&client, &room, false)
            .await
            .expect("a timeline for a joined room"),
    );

    assert!(matches!(
        changes.as_slice(),
        [Some(crate::protocol::StateChangeView::PinnedEvents { added, removed, total })]
            if added.len() == 2 && removed.is_empty() && *total == 2
    ));
}

#[tokio::test]
async fn joining_a_call_is_worded_as_a_join() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!call:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                factory
                    .call_membership_state(User::Alice, "DEVICE".to_owned())
                    .event_id(event_id!("$joined")),
            ),
        )
        .await;

    let changes = state_changes(
        &timeline_views(&client, &room, false)
            .await
            .expect("a timeline for a joined room"),
    );

    assert!(matches!(
        changes.as_slice(),
        [Some(crate::protocol::StateChangeView::CallMembership {
            joined: true
        })]
    ));
}

/// The UI branches on these variants, so the mapping is a contract.
/// `None` when the mocked server accepted the write.
async fn room_command_error(response: ResponseTemplate) -> Option<crate::protocol::RpcError> {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!errors:example.org");

    server.mock_room_state_encryption().plain().mount().await;
    let room = server.sync_joined_room(&client, room_id).await;
    server
        .mock_room_send_state()
        .respond_with(response)
        .mount()
        .await;

    let (core, _events) = Core::new("errors", Box::new(MemorySessionStore::default()));
    let error = room.set_room_topic("nope").await.err()?;

    Some(core.room_error("set_room_topic", error))
}

#[tokio::test]
async fn a_forbidden_room_write_is_reported_as_denied() {
    let error = room_command_error(ResponseTemplate::new(403).set_body_json(json!({
        "errcode": "M_FORBIDDEN",
        "error": "You don't have permission",
    })))
    .await
    .expect("the mocked server rejects the write");

    assert!(
        matches!(error, RpcError::Denied),
        "expected Denied, got {error:?}"
    );
}

#[tokio::test]
async fn a_rate_limited_room_write_carries_the_delay_in_milliseconds() {
    let error = room_command_error(ResponseTemplate::new(429).set_body_json(json!({
        "errcode": "M_LIMIT_EXCEEDED",
        "error": "Too many requests",
        "retry_after_ms": 5000,
    })))
    .await
    .expect("the mocked server rejects the write");

    assert!(
        matches!(
            error,
            RpcError::RateLimited {
                retry_after_ms: Some(5000)
            }
        ),
        "expected RateLimited with 5000ms, got {error:?}"
    );
}

#[tokio::test]
async fn an_unavailable_homeserver_is_retryable_rather_than_a_logged_failure() {
    let error = room_command_error(ResponseTemplate::new(500))
        .await
        .expect("the mocked server rejects the write");

    assert!(
        matches!(error, RpcError::Unavailable),
        "expected Unavailable, got {error:?}"
    );
}

#[tokio::test]
async fn invisible_member_names_use_the_user_id() {
    for name in [
        "\u{200b}",
        "\u{2800}",
        " \u{061c}\u{034f}\u{feff} ",
        "\u{3164}",
        "\u{2060}\u{2066}\u{2069}",
        "\u{fe0f}\u{e0100}",
        "\u{0085}",
    ] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!names:example.org");
        let factory = EventFactory::new().room(room_id).sender(User::Alice);
        server.mock_room_state_encryption().plain().mount().await;
        let builder = JoinedRoomBuilder::new(room_id)
            .add_state_event(factory.member(User::Alice).display_name(name))
            .add_state_event(factory.member(client.user_id().unwrap()))
            .add_timeline_event(factory.text_msg("hello").event_id(event_id!("$hidden")));
        let room = server.sync_room(&client, builder).await;
        let member = room
            .get_member_no_sync(User::Alice.into())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(crate::view::member_view(&member).display_name, None);

        let timeline = Arc::new(
            build_room_timeline(&room, &TimelineFocusView::Live, false)
                .await
                .unwrap(),
        );
        assert_eq!(sender_names(&timeline).await, vec![None]);
    }
}

#[tokio::test]
async fn fetching_members_names_a_bridge_ghost_the_sync_never_shipped() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!bridged:example.org");
    let ghost = user_id!("@whatsapp_33612345678:example.org");
    let factory = EventFactory::new().room(room_id).sender(ghost);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("salut").event_id(event_id!("$ghost"))),
        )
        .await;

    let timeline = Arc::new(
        build_room_timeline(&room, &TimelineFocusView::Live, false)
            .await
            .unwrap(),
    );
    let (_, mut stream) = timeline.subscribe().await;
    assert_eq!(sender_names(&timeline).await, vec![None]);

    server
        .mock_get_members()
        .ok(vec![
            EventFactory::new()
                .room(room_id)
                .member(ghost)
                .display_name("Marie")
                .into_raw(),
        ])
        .mock_once()
        .mount()
        .await;

    crate::timelines::fill_sender_profiles(&room, &timeline);

    let named = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            stream.next().await.expect("open timeline stream");
            if let [Some(name)] = sender_names(&timeline).await.as_slice() {
                break name.clone();
            }
        }
    })
    .await
    .expect("sender profile resolves once the members land");

    assert_eq!(named, "Marie");
}

#[expect(clippy::unwrap_used, reason = "test code")]
async fn dispatch_mark_read(
    server: &MatrixMockServer,
    client: matrix_sdk::Client,
    room_id: matrix_sdk::ruma::OwnedRoomId,
    event_id: Option<matrix_sdk::ruma::OwnedEventId>,
    private_receipt: bool,
    fully_read: bool,
) {
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });

    core.run(MarkReadParams {
        room_id,
        event_id,
        private_receipt,
        thread_root: None,
        subscription: None,
        fully_read,
    })
    .await
    .unwrap();
}

#[expect(
    clippy::expect_used,
    reason = "test code; one sequential flow kept in a single function"
)]
async fn mark_read_body(
    private_receipt: bool,
    event_id: Option<matrix_sdk::ruma::OwnedEventId>,
    include_threaded_reply: bool,
) -> (
    serde_json::Value,
    serde_json::Value,
    String,
    String,
    Vec<(String, serde_json::Value)>,
) {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .on_builder(|builder| builder.with_threading_support(crate::session::THREADING_SUPPORT))
        .build()
        .await;
    let room_id = room_id!("!receipts:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = JoinedRoomBuilder::new(room_id)
        .add_timeline_event(factory.text_msg("read me").event_id(event_id!("$read")));
    let room = if include_threaded_reply {
        room.add_timeline_event(
            factory
                .text_msg("threaded reply")
                .in_thread(event_id!("$read"), event_id!("$read"))
                .event_id(event_id!("$threaded")),
        )
    } else {
        room
    };
    server.sync_room(&client, room).await;
    if event_id.is_some() {
        Mock::given(method("POST"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room_id}/read_markers"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
    } else {
        Mock::given(method("POST"))
            .and(path_regex(format!(
                r"^/_matrix/client/v3/rooms/{room_id}/receipt/m\.fully_read/.*$"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
    }

    let receipt_type = if private_receipt {
        "m.read.private"
    } else {
        "m.read"
    };
    Mock::given(method("POST"))
        .and(path_regex(format!(
            r"^/_matrix/client/v3/rooms/{room_id}/receipt/{receipt_type}/.*$"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(if event_id.is_some() { 1 } else { 2 })
        .mount(server.server())
        .await;

    dispatch_mark_read(
        &server,
        client,
        room_id.to_owned(),
        event_id,
        private_receipt,
        true,
    )
    .await;

    let requests = server
        .server()
        .received_requests()
        .await
        .expect("wiremock records requests");
    let marker = requests.iter().rev().find(|request| {
        request.url.path().ends_with("/read_markers")
            || request.url.path().contains("/receipt/m.fully_read/")
    });

    let marker_path = marker
        .map(|request| request.url.path().to_owned())
        .unwrap_or_default();
    let scoped: Vec<(String, serde_json::Value)> = requests
        .iter()
        .filter(|request| {
            request.url.path().contains("/receipt/")
                && !request.url.path().contains("/receipt/m.fully_read/")
        })
        .map(|request| {
            (
                request.url.path().to_owned(),
                serde_json::from_slice(&request.body).expect("a receipt body"),
            )
        })
        .collect();
    let (receipt_path, receipt) = scoped.first().cloned().expect("a scoped receipt request");
    (
        marker
            .map(|request| serde_json::from_slice(&request.body).expect("a JSON body"))
            .unwrap_or_default(),
        receipt,
        marker_path,
        receipt_path,
        scoped,
    )
}

#[tokio::test]
async fn marking_unread_writes_the_room_account_data_flag() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!unread:example.org");

    server.mock_room_state_encryption().plain().mount().await;
    server
        .sync_room(&client, JoinedRoomBuilder::new(room_id))
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(
            r"^/_matrix/client/v3/user/.*/rooms/.*/account_data/m\.marked_unread$",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
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

    core.run(MarkUnreadParams {
        room_id: room_id.to_owned(),
        read_marker: None,
    })
    .await
    .unwrap();

    let requests = server
        .server()
        .received_requests()
        .await
        .expect("wiremock records requests");
    let write = requests
        .iter()
        .rev()
        .find(|request| {
            request
                .url
                .path()
                .ends_with("/account_data/m.marked_unread")
        })
        .expect("a marked-unread write");
    let body: serde_json::Value = serde_json::from_slice(&write.body).expect("a JSON body");

    assert_eq!(body["unread"], json!(true));
}

#[tokio::test]
async fn marking_unread_from_a_message_walks_the_read_marker_back() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!unread-from:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("first").event_id(event_id!("$first")))
                .add_timeline_event(factory.text_msg("second").event_id(event_id!("$second"))),
        )
        .await;
    Mock::given(method("POST"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/read_markers"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(
            r"^/_matrix/client/v3/user/.*/rooms/.*/account_data/m\.marked_unread$",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
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

    core.run(MarkUnreadParams {
        room_id: room_id.to_owned(),
        read_marker: Some(event_id!("$first").to_owned()),
    })
    .await
    .unwrap();

    let requests = server
        .server()
        .received_requests()
        .await
        .expect("wiremock records requests");
    let marker = requests
        .iter()
        .rev()
        .find(|request| request.url.path().ends_with("/read_markers"))
        .expect("a read marker request");
    let body: serde_json::Value = serde_json::from_slice(&marker.body).expect("a JSON body");

    assert_eq!(body["m.fully_read"], json!("$first"));
    assert!(body.get("m.read").is_none());
}

#[tokio::test]
async fn marking_read_publishes_a_receipt_and_moves_the_marker() {
    let (body, receipt, _, _, _) =
        mark_read_body(false, Some(event_id!("$read").to_owned()), false).await;

    assert_eq!(receipt["thread_id"], json!("main"));
    assert!(body.get("m.read").is_none());
    assert_eq!(body["m.fully_read"], json!("$read"));
    assert!(body.get("m.read.private").is_none(), "{body}");
}

#[tokio::test]
async fn a_private_reader_still_moves_the_marker_without_telling_the_room() {
    let (body, receipt, _, _, _) =
        mark_read_body(true, Some(event_id!("$read").to_owned()), false).await;

    assert_eq!(receipt["thread_id"], json!("main"));
    assert!(body.get("m.read.private").is_none());
    assert_eq!(
        body["m.fully_read"],
        json!("$read"),
        "the unread badge tracks the marker, so it has to move either way"
    );
    assert!(body.get("m.read").is_none(), "{body}");
}

#[tokio::test]
async fn marking_a_room_read_uses_the_latest_threaded_event() {
    let (body, _, fully_read_path, read_path, receipts) = mark_read_body(false, None, true).await;

    assert_eq!(body, json!({}));
    assert!(read_path.ends_with("/m.read/$threaded"));
    assert!(fully_read_path.ends_with("/m.fully_read/$threaded"));
    assert!(
        receipts
            .iter()
            .any(|(path, body)| path.ends_with("/m.read/$read") && body["thread_id"] == "main"),
        "{receipts:?}"
    );
}

#[tokio::test]
async fn a_receipt_short_of_the_latest_message_leaves_the_marker() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .on_builder(|builder| builder.with_threading_support(crate::session::THREADING_SUPPORT))
        .build()
        .await;
    let room_id = room_id!("!receipts:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    server.mock_room_state_encryption().plain().mount().await;
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("read me").event_id(event_id!("$read"))),
        )
        .await;
    Mock::given(method("POST"))
        .and(path_regex(format!(
            r"^/_matrix/client/v3/rooms/{room_id}/receipt/m\.read/.*$"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/read_markers"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(0)
        .mount(server.server())
        .await;

    dispatch_mark_read(
        &server,
        client,
        room_id.to_owned(),
        Some(event_id!("$read").to_owned()),
        false,
        false,
    )
    .await;
}

#[expect(clippy::unwrap_used, clippy::expect_used, reason = "test code")]
async fn read_marker_for(fully_read: bool) -> Option<String> {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!marker:example.org");
    let me = client
        .user_id()
        .expect("the mock client is logged in")
        .to_owned();
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let room = JoinedRoomBuilder::new(room_id)
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
        .add_receipt(
            factory
                .read_receipts()
                .add(
                    event_id!("$two"),
                    &me,
                    ReceiptType::Read,
                    ReceiptThread::Unthreaded,
                )
                .into_event(),
        );
    let room = if fully_read {
        room.add_account_data(factory.fully_read(event_id!("$one")))
    } else {
        room
    };
    server.sync_room(&client, room).await;

    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });
    core.run(ReadMarkerParams {
        room_id: room_id.to_owned(),
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn the_read_marker_is_the_fully_read_event() {
    let event_id = read_marker_for(true).await;
    assert_eq!(event_id.as_deref(), Some("$one"));
}

#[tokio::test]
async fn the_read_marker_falls_back_to_the_read_receipt() {
    let event_id = read_marker_for(false).await;
    assert_eq!(event_id.as_deref(), Some("$two"));
}

async fn sender_names(timeline: &Arc<matrix_sdk_ui::timeline::Timeline>) -> Vec<Option<String>> {
    timeline
        .items()
        .await
        .iter()
        .filter(|item| item.as_event().is_some())
        .map(|item| {
            crate::view::timeline_item(
                item,
                None,
                &crate::view::Highlights::default(),
                &crate::view::LocalContent::default(),
            )
            .sender_name
        })
        .collect()
}

#[tokio::test]
async fn invited_direct_room_summary_is_direct() {
    for (is_direct, expected) in [(true, true), (false, false)] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!dm-invite:example.org");
        let own = client.user_id().expect("a logged-in client").to_owned();
        let member = matrix_sdk::ruma::serde::Raw::new(&json!({
            "type": "m.room.member",
            "sender": User::Alice,
            "state_key": own,
            "content": { "membership": "invite", "is_direct": is_direct },
        }))
        .unwrap()
        .cast_unchecked();

        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_invited_room(
                    InvitedRoomBuilder::new(room_id).add_state_event(member.clone()),
                );
            })
            .await;

        let item =
            matrix_sdk_ui::room_list_service::RoomListItem::from(client.get_room(room_id).unwrap());
        let mut cache = std::collections::HashMap::new();
        super::view::enrich_room_batch(
            &[matrix_sdk_ui::eyeball_im::VectorDiff::Set {
                index: 0,
                value: item.clone(),
            }],
            &mut cache,
        )
        .await;
        let summary =
            super::view::room_list_item(&item, &cache, &matrix_sdk::ruma::push::Ruleset::new());

        assert_eq!(
            summary.direct_targets,
            [] as [matrix_sdk::ruma::OwnedUserId; 0]
        );
        assert_eq!(summary.is_direct, expected);
    }
}

#[tokio::test]
async fn direct_room_summary_uses_the_other_members_avatar() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!dm-avatar:example.org");
    let avatar = matrix_sdk::ruma::mxc_uri!("mxc://example.org/alice");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_global_account_data(factory.direct().add_user(User::Alice, room_id));
            builder.add_joined_room(
                JoinedRoomBuilder::new(room_id)
                    .set_room_summary(
                        json!({"m.heroes": [User::Alice], "m.joined_member_count": 2}),
                    )
                    .add_state_event(
                        factory
                            .member(User::Alice)
                            .display_name("Alice")
                            .avatar_url(avatar),
                    ),
            );
        })
        .await;
    let item =
        matrix_sdk_ui::room_list_service::RoomListItem::from(client.get_room(room_id).unwrap());
    let mut cache = std::collections::HashMap::new();
    super::view::enrich_room_batch(
        &[matrix_sdk_ui::eyeball_im::VectorDiff::Set {
            index: 0,
            value: item.clone(),
        }],
        &mut cache,
    )
    .await;
    let summary =
        super::view::room_list_item(&item, &cache, &matrix_sdk::ruma::push::Ruleset::new());
    assert!(summary.is_direct);
    assert_eq!(summary.avatar_url.as_deref(), Some(avatar.as_str()));

    let updated = matrix_sdk::ruma::mxc_uri!("mxc://example.org/alice-new");
    let explicit = matrix_sdk::ruma::mxc_uri!("mxc://example.org/room-picture");
    for (update, expected) in [
        (
            JoinedRoomBuilder::new(room_id)
                .add_state_event(factory.member(User::Alice).avatar_url(updated)),
            Some(updated.as_str()),
        ),
        (
            JoinedRoomBuilder::new(room_id).add_state_event(factory.room_avatar().url(explicit)),
            Some(explicit.as_str()),
        ),
        (
            JoinedRoomBuilder::new(room_id).add_state_event(factory.room_avatar()),
            Some(updated.as_str()),
        ),
        (
            JoinedRoomBuilder::new(room_id).add_state_event(factory.member(User::Alice)),
            None,
        ),
    ] {
        server.sync_room(&client, update).await;
        super::view::enrich_room_batch(
            &[matrix_sdk_ui::eyeball_im::VectorDiff::Set {
                index: 0,
                value: item.clone(),
            }],
            &mut cache,
        )
        .await;
        assert_eq!(
            super::view::room_list_item(&item, &cache, &matrix_sdk::ruma::push::Ruleset::new())
                .avatar_url
                .as_deref(),
            expected
        );
    }

    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_global_account_data(factory.direct());
            builder.add_joined_room(
                JoinedRoomBuilder::new(room_id)
                    .add_state_event(factory.member(User::Alice).avatar_url(avatar)),
            );
        })
        .await;
    super::view::enrich_room_batch(
        &[matrix_sdk_ui::eyeball_im::VectorDiff::Set {
            index: 0,
            value: item.clone(),
        }],
        &mut cache,
    )
    .await;
    let summary =
        super::view::room_list_item(&item, &cache, &matrix_sdk::ruma::push::Ruleset::new());
    assert!(!summary.is_direct);
    assert_eq!(summary.avatar_url, None);
}

#[tokio::test]
async fn room_summary_clears_removed_avatars_when_rooms_are_reinserted() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!room-avatar:example.org");
    let avatar = matrix_sdk::ruma::mxc_uri!("mxc://example.org/room-picture");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_state_event(factory.room_avatar().url(avatar)),
        )
        .await;
    let item =
        matrix_sdk_ui::room_list_service::RoomListItem::from(client.get_room(room_id).unwrap());
    let mut cache = std::collections::HashMap::new();
    super::view::enrich_room_batch(
        &[matrix_sdk_ui::eyeball_im::VectorDiff::Set {
            index: 0,
            value: item.clone(),
        }],
        &mut cache,
    )
    .await;
    assert_eq!(
        super::view::room_list_item(&item, &cache, &matrix_sdk::ruma::push::Ruleset::new())
            .avatar_url
            .as_deref(),
        Some(avatar.as_str())
    );

    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_state_event(
                matrix_sdk::ruma::serde::Raw::new(&json!({
                    "content": {"url": null},
                    "event_id": "$room-avatar-cleared",
                    "origin_server_ts": 0,
                    "sender": User::Alice,
                    "state_key": "",
                    "type": "m.room.avatar",
                }))
                .unwrap()
                .cast_unchecked::<matrix_sdk::ruma::events::AnySyncStateEvent>(),
            ),
        )
        .await;
    let item =
        matrix_sdk_ui::room_list_service::RoomListItem::from(client.get_room(room_id).unwrap());
    super::view::enrich_room_batch(
        &[matrix_sdk_ui::eyeball_im::VectorDiff::PushFront {
            value: item.clone(),
        }],
        &mut cache,
    )
    .await;

    let summary =
        super::view::room_list_item(&item, &cache, &matrix_sdk::ruma::push::Ruleset::new());
    assert!(!summary.is_direct);
    assert_eq!(summary.avatar_url, None);
}

#[tokio::test]
async fn sliding_sync_room_summary_prefers_avatar_state_over_the_avatar_property() {
    for (name, room_id, avatar_content, expected_avatar) in [
        (
            "missing",
            room_id!("!sliding-avatar-missing:example.org"),
            None,
            None,
        ),
        (
            "cleared",
            room_id!("!sliding-avatar-cleared:example.org"),
            Some(json!({"url": null})),
            None,
        ),
        (
            "replaced",
            room_id!("!sliding-avatar-replaced:example.org"),
            Some(json!({"url": "mxc://example.org/new-room-picture"})),
            Some("mxc://example.org/new-room-picture"),
        ),
    ] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let sliding_sync = client.sliding_sync(name).unwrap().build().await.unwrap();
        sliding_sync.add_room_subscriptions(&[room_id], None, true);
        let stream = sliding_sync.sync();
        pin_mut!(stream);

        let mut room_response = json!({
            "avatar": "mxc://example.org/stale-room-picture",
            "initial": true,
        });
        if let Some(content) = avatar_content.as_ref() {
            room_response["required_state"] = json!([{
                "content": content,
                "event_id": "$room-avatar",
                "origin_server_ts": 0,
                "sender": User::Alice,
                "state_key": "",
                "type": "m.room.avatar",
            }]);
        }
        let mut rooms = serde_json::Map::new();
        rooms.insert(room_id.to_string(), room_response);
        let response = Mock::given(method("POST"))
            .and(path(
                "/_matrix/client/unstable/org.matrix.simplified_msc3575/sync",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "pos": "1",
                "lists": {},
                "rooms": rooms,
                "extensions": {}
            })))
            .mount_as_scoped(server.server())
            .await;
        stream.next().await.unwrap().unwrap();
        drop(response);

        let room = client.get_room(room_id).expect("subscribed room");
        let cached_avatar = room
            .get_state_event_static::<RoomAvatarEventContent>()
            .await
            .unwrap();
        let expected_cached_avatar: Option<Option<matrix_sdk::ruma::OwnedMxcUri>> = avatar_content
            .as_ref()
            .map(|content| content["url"].as_str().map(Into::into));
        assert_eq!(
            cached_avatar.map(|event| event
                .deserialize()
                .unwrap()
                .original_content()
                .unwrap()
                .url
                .clone()),
            expected_cached_avatar,
            "{name} cached avatar state"
        );

        let item = matrix_sdk_ui::room_list_service::RoomListItem::from(room);
        let mut cache = std::collections::HashMap::new();
        super::view::enrich_room_batch(
            &[matrix_sdk_ui::eyeball_im::VectorDiff::Set {
                index: 0,
                value: item.clone(),
            }],
            &mut cache,
        )
        .await;
        assert_eq!(
            super::view::room_list_item(&item, &cache, &matrix_sdk::ruma::push::Ruleset::new())
                .avatar_url
                .as_deref(),
            expected_avatar,
            "{name} room summary"
        );
    }
}

#[tokio::test]
async fn sliding_sync_hero_avatar_is_not_the_avatar_of_a_room_that_is_not_direct() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!sliding-hero-avatar:example.org");
    let sliding_sync = client
        .sliding_sync("hero-avatar")
        .unwrap()
        .build()
        .await
        .unwrap();
    sliding_sync.add_room_subscriptions(&[room_id], None, true);
    let stream = sliding_sync.sync();
    pin_mut!(stream);

    let response = Mock::given(method("POST"))
        .and(path(
            "/_matrix/client/unstable/org.matrix.simplified_msc3575/sync",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "pos": "1",
            "lists": {},
            "rooms": {
                room_id.to_string(): {
                    "avatar": "mxc://example.org/alice",
                    "heroes": [{
                        "user_id": User::Alice,
                        "displayname": "Alice",
                        "avatar_url": "mxc://example.org/alice",
                    }],
                    "joined_count": 1,
                    "invited_count": 1,
                    "initial": true,
                }
            },
            "extensions": {}
        })))
        .mount_as_scoped(server.server())
        .await;
    stream.next().await.unwrap().unwrap();
    drop(response);

    let item = matrix_sdk_ui::room_list_service::RoomListItem::from(
        client.get_room(room_id).expect("subscribed room"),
    );
    let mut cache = std::collections::HashMap::new();
    super::view::enrich_room_batch(
        &[matrix_sdk_ui::eyeball_im::VectorDiff::Set {
            index: 0,
            value: item.clone(),
        }],
        &mut cache,
    )
    .await;
    let summary =
        super::view::room_list_item(&item, &cache, &matrix_sdk::ruma::push::Ruleset::new());
    assert!(!summary.is_direct);
    assert_eq!(summary.avatar_url, None);
}

#[tokio::test]
async fn a_mention_is_loud_from_the_ruleset_not_the_stamped_flag() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let own_user_id = client.user_id().expect("a logged-in user").to_owned();
    let room_id = room_id!("!mention:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_bulk([
                    factory.member(&own_user_id).into_raw(),
                    factory.member(User::Alice).into_raw(),
                    factory.power_levels().into_raw(),
                ])
                .add_timeline_event(
                    factory
                        .text_msg("hey")
                        .mentions(matrix_sdk::ruma::events::Mentions::with_user_ids([
                            own_user_id.clone(),
                        ]))
                        .event_id(event_id!("$mention")),
                ),
        )
        .await;

    let timeline = build_room_timeline(&room, &TimelineFocusView::Live, false)
        .await
        .expect("a timeline");
    let items = timeline.items().await;

    let push = room
        .push_context()
        .await
        .expect("a push context")
        .expect("a room the ruleset can be evaluated against");
    let highlights = super::view::Highlights::compute(Some(&push), items.iter()).await;

    let views = items
        .iter()
        .map(|item| {
            super::view::timeline_item(
                item,
                Some(&own_user_id),
                &highlights,
                &super::view::LocalContent::default(),
            )
        })
        .collect::<Vec<_>>();
    let mention = views
        .iter()
        .find_map(|view| match &view.content {
            crate::protocol::TimelineItemContentView::Message { .. } => Some(view.mention),
            _ => None,
        })
        .expect("the mentioning message");

    assert_eq!(mention, crate::protocol::MentionView::Loud);
}

#[tokio::test]
async fn a_deleted_mention_is_not_highlighted() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let own_user_id = client.user_id().expect("a logged-in user").to_owned();
    let room_id = room_id!("!deleted-mention:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_bulk([
                    factory.member(&own_user_id).into_raw(),
                    factory.member(User::Alice).into_raw(),
                    factory.power_levels().into_raw(),
                ])
                .add_timeline_event(
                    factory
                        .text_msg("hey")
                        .mentions(matrix_sdk::ruma::events::Mentions::with_user_ids([
                            own_user_id.clone(),
                        ]))
                        .event_id(event_id!("$mention")),
                ),
        )
        .await;

    let timeline = build_room_timeline(&room, &TimelineFocusView::Live, false)
        .await
        .expect("a timeline");

    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                factory
                    .redaction(event_id!("$mention"))
                    .event_id(event_id!("$redaction")),
            ),
        )
        .await;

    let items = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let items = timeline.items().await;
            if items.iter().any(|item| {
                item.as_event()
                    .is_some_and(|event| event.content().is_redacted())
            }) {
                break items;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the redaction reached the timeline");

    let mention = items
        .iter()
        .map(|item| {
            super::view::timeline_item(
                item,
                Some(&own_user_id),
                &super::view::Highlights::default(),
                &super::view::LocalContent::default(),
            )
        })
        .find_map(|view| match &view.content {
            crate::protocol::TimelineItemContentView::Redacted { .. } => Some(view.mention),
            _ => None,
        })
        .expect("the deleted message");

    assert_eq!(mention, crate::protocol::MentionView::None);
}

#[tokio::test]
async fn a_live_redaction_drops_the_reactions() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let own_user_id = client.user_id().expect("a logged-in user").to_owned();
    let room_id = room_id!("!live-redaction:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let target = event_id!("$target");

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_bulk([
                    factory.member(&own_user_id).into_raw(),
                    factory.member(User::Alice).into_raw(),
                    factory.power_levels().into_raw(),
                ])
                .add_timeline_event(factory.text_msg("hey").event_id(target))
                .add_timeline_event(
                    factory
                        .reaction(target, "👍")
                        .event_id(event_id!("$reaction")),
                ),
        )
        .await;

    let timeline = build_room_timeline(&room, &TimelineFocusView::Live, false)
        .await
        .expect("a timeline");

    let redaction = json!({
        "type": "m.room.redaction",
        "sender": User::Alice.to_string(),
        "event_id": "$redaction",
        "origin_server_ts": 1_000_000,
        "redacts": target,
        "content": { "redacts": target, "reason": "spam" },
    });
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                matrix_sdk::ruma::serde::Raw::new(&redaction)
                    .expect("a redaction")
                    .cast_unchecked(),
            ),
        )
        .await;

    let items = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let items = timeline.items().await;
            if items.iter().any(|item| {
                item.as_event()
                    .is_some_and(|event| event.content().is_redacted())
            }) {
                break items;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the redaction reached the timeline");

    let view = items
        .iter()
        .map(|item| {
            super::view::timeline_item(
                item,
                Some(&own_user_id),
                &super::view::Highlights::default(),
                &super::view::LocalContent::default(),
            )
        })
        .find(|view| {
            matches!(
                view.content,
                crate::protocol::TimelineItemContentView::Redacted { .. }
            )
        })
        .expect("the deleted message");

    assert!(view.reactions.is_empty());
}

#[tokio::test]
async fn a_redaction_the_server_rejects_restores_the_message() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let own_user_id = client.user_id().expect("a logged-in user").to_owned();
    let room_id = room_id!("!rejected-redaction:example.org");
    let factory = EventFactory::new().room(room_id).sender(&own_user_id);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_bulk([
                    factory.member(&own_user_id).into_raw(),
                    factory.power_levels().into_raw(),
                ])
                .add_timeline_event(factory.text_msg("keep me").event_id(event_id!("$kept"))),
        )
        .await;
    server
        .mock_room_redact()
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({
            "errcode": "M_FORBIDDEN",
            "error": "You don't have permission to redact",
        })))
        .mount()
        .await;

    let timeline = Arc::new(
        build_room_timeline(&room, &TimelineFocusView::Live, false)
            .await
            .expect("a timeline"),
    );
    let item_id =
        matrix_sdk_ui::timeline::TimelineEventItemId::EventId(event_id!("$kept").to_owned());
    timeline
        .redact(&item_id, None)
        .await
        .expect("the redaction is queued");

    let rejected = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let items = timeline.items().await;
            if let Some(item) = items.iter().find(|item| {
                item.as_event().is_some_and(|event| {
                    matches!(
                        event.redaction_send_state(),
                        Some(matrix_sdk_ui::timeline::EventSendState::SendingFailed {
                            is_recoverable: false,
                            ..
                        })
                    )
                })
            }) {
                break item.clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the server rejected the redaction");
    assert!(
        rejected
            .as_event()
            .is_some_and(|event| event.content().is_redacted())
    );

    crate::subscriptions::abort_rejected_redaction(&timeline, &rejected);

    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let items = timeline.items().await;
            if items.iter().any(|item| {
                item.as_event().is_some_and(|event| {
                    event.event_id() == Some(event_id!("$kept"))
                        && !event.content().is_redacted()
                        && event.redaction_send_state().is_none()
                })
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the message is shown again");
}

fn message_htmls(views: &[crate::protocol::TimelineItemView]) -> Vec<String> {
    contents(views)
        .into_iter()
        .filter_map(|content| match content {
            crate::protocol::TimelineItemContentView::Message { html, .. } => Some(html),
            _ => None,
        })
        .collect()
}

const TIME_HTML: &str = "<time datetime=\"1970-01-01T00:00:00Z\">1 Jan 1970, 00:00 (UTC)</time>";

#[tokio::test]
async fn incoming_messages_preserve_literal_markdown_and_authored_html() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!literal-markdown:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let plain = "*test* **bold** `code` ||bars|| $x$ $[unixtime 0] <b>literal</b>";
    let formatted = "<p>*test* **bold** `code` ||bars|| $x$ $[unixtime 0] <em>authored</em></p>";

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg(plain).event_id(event_id!("$plain")))
                .add_timeline_event(
                    factory
                        .text_html("fallback", formatted)
                        .event_id(event_id!("$formatted")),
                ),
        )
        .await;

    let htmls = message_htmls(
        &timeline_views(&client, &room, false)
            .await
            .expect("a timeline for a joined room"),
    );
    assert_eq!(
        htmls,
        [
            "<span data-plain-body>*test* **bold** `code` ||bars|| $x$ $[unixtime 0] &lt;b&gt;literal&lt;/b&gt;</span>",
            formatted,
        ]
    );
}

#[tokio::test]
async fn a_time_element_survives_the_sdk_sanitizer() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!time:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                factory
                    .text_html("$[unixtime 0]", TIME_HTML)
                    .event_id(event_id!("$time")),
            ),
        )
        .await;

    let htmls = message_htmls(
        &timeline_views(&client, &room, false)
            .await
            .expect("a timeline for a joined room"),
    );
    assert_eq!(htmls, [TIME_HTML]);
}

#[tokio::test]
async fn an_edit_renders_the_formatted_body_of_its_new_content() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!edited-time:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let original = event_id!("$original");

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(
                    factory
                        .text_html("before", "<em>before</em>")
                        .event_id(original),
                )
                .add_timeline_event(
                    factory
                        .text_html("* fallback", "* <em>fallback</em>")
                        .edit(
                            original,
                            matrix_sdk::ruma::events::room::message::RoomMessageEventContentWithoutRelation::text_html(
                                "$[unixtime 0]",
                                TIME_HTML,
                            ),
                        )
                        .event_id(event_id!("$edit")),
                ),
        )
        .await;

    let htmls = message_htmls(
        &timeline_views(&client, &room, false)
            .await
            .expect("a timeline for a joined room"),
    );
    assert_eq!(htmls, [TIME_HTML]);
}

#[tokio::test]
async fn a_local_echo_keeps_the_formatted_body_it_was_sent_with() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!echo-time:example.org");

    server.mock_room_state_encryption().plain().mount().await;
    server.mock_room_send().error500().mount().await;
    let room = server.sync_joined_room(&client, room_id).await;
    let timeline = build_room_timeline(&room, &TimelineFocusView::Live, false)
        .await
        .expect("a timeline for a joined room");

    timeline
        .send(RoomMessageEventContent::text_html("$[unixtime 0]", TIME_HTML).into())
        .await
        .expect("the message is queued");
    let (echoes, _) = room.send_queue().subscribe().await.expect("the send queue");
    let local_content = super::view::LocalContent::new(&echoes);

    let items = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let items = timeline.items().await;
            if items.iter().any(|item| item.as_event().is_some()) {
                break items;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the local echo reaches the timeline");
    let views = |local_content: &super::view::LocalContent| {
        items
            .iter()
            .map(|item| {
                super::view::timeline_item(
                    item,
                    client.user_id(),
                    &super::view::Highlights::default(),
                    local_content,
                )
            })
            .collect::<Vec<_>>()
    };

    assert_eq!(message_htmls(&views(&local_content)), [TIME_HTML]);
    assert_ne!(
        message_htmls(&views(&super::view::LocalContent::default())),
        [TIME_HTML],
        "the SDK's own copy of a local echo drops the time element"
    );
}

#[tokio::test]
async fn an_invite_joined_without_a_required_state_member_becomes_joined() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let own = client.user_id().unwrap().to_owned();
    let room_id = room_id!("!joined-invite:example.org");
    let sliding_sync = client
        .sliding_sync("invite")
        .unwrap()
        .build()
        .await
        .unwrap();
    sliding_sync.add_room_subscriptions(&[room_id], None, true);
    let stream = sliding_sync.sync();
    pin_mut!(stream);
    let respond = |room: serde_json::Value| {
        let mut rooms = serde_json::Map::new();
        rooms.insert(room_id.to_string(), room);
        Mock::given(method("POST"))
            .and(path(
                "/_matrix/client/unstable/org.matrix.simplified_msc3575/sync",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "pos": "1", "lists": {}, "rooms": rooms, "extensions": {}
            })))
    };

    let invite = respond(json!({
        "initial": true,
        "invite_state": [
            {"content": {"name": "Invited"}, "sender": User::Alice, "state_key": "", "type": "m.room.name"},
            {"content": {"membership": "invite"}, "sender": User::Alice, "state_key": own, "type": "m.room.member"}
        ]
    }))
    .mount_as_scoped(server.server())
    .await;
    stream.next().await.unwrap().unwrap();
    drop(invite);
    assert_eq!(
        client.get_room(room_id).unwrap().state(),
        matrix_sdk::RoomState::Invited
    );

    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/joined_rooms"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"joined_rooms": [room_id]})))
        .mount(server.server())
        .await;
    let watcher =
        matrix_sdk::executor::spawn(crate::rooms::reconcile_joined_invites(client.clone()));
    let join = respond(json!({
        "initial": false,
        "name": "Invited",
        "timeline": [{
            "content": {"membership": "join"}, "event_id": "$join", "origin_server_ts": 1,
            "sender": own, "state_key": own, "type": "m.room.member",
            "unsigned": {"prev_content": {"membership": "invite"}}
        }],
        "required_state": [
            {"content": {"name": "Invited"}, "event_id": "$name", "origin_server_ts": 1, "sender": User::Alice, "state_key": "", "type": "m.room.name"}
        ]
    }))
    .mount_as_scoped(server.server())
    .await;
    stream.next().await.unwrap().unwrap();
    drop(join);

    tokio::time::timeout(Duration::from_secs(2), async {
        while client.get_room(room_id).unwrap().state() != matrix_sdk::RoomState::Joined {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the joined invite is marked joined");
    watcher.abort();
}

#[tokio::test]
async fn redacting_an_event_outside_the_timeline_redacts_it_in_the_room() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!calendar:example.org");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    server
        .mock_room_redact()
        .ok(event_id!("$redaction"))
        .expect(1)
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

    core.run(crate::api::messages::RedactParams {
        room_id: room_id.to_owned(),
        event_id: event_id!("$calendar-entry").to_owned(),
        reason: None,
        thread_root: None,
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn a_new_calendar_room_is_set_up_by_its_creator() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    server.mock_create_room().ok().mock_once().mount().await;
    server.mock_room_state_encryption().plain().mount().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/rooms/.*/state/chat\.commet\.calendars/?$"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "errcode": "M_NOT_FOUND",
            "error": "Event not found.",
        })))
        .mount(server.server())
        .await;
    server
        .mock_room_send()
        .for_type("chat.commet.calendar_create".into())
        .ok(event_id!("$calendar"))
        .expect(1)
        .mount()
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/rooms/.*/state/chat\.commet\.calendars/?$"))
        .and(wiremock::matchers::body_json(
            json!({ "calendars": ["$calendar"] }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "event_id": "$state" })))
        .expect(1)
        .mount(server.server())
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

    core.run(crate::api::rooms::CreateParams {
        name: Some("Raids".to_owned()),
        topic: None,
        kind: crate::api::rooms::RoomKind::Calendar,
        public: false,
        encrypted: false,
        invite: Vec::new(),
        parent_space: None,
        alias: None,
        room_version: None,
        join_rule: None,
        federate: true,
        predecessor: None,
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn an_encrypted_private_space_includes_encryption_in_its_creation_request() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/createRoom"))
        .and(body_partial_json(json!({
            "creation_content": { "type": "m.space" },
            "initial_state": [{
                "type": "m.room.encryption",
                "state_key": "",
                "content": { "algorithm": "m.megolm.v1.aes-sha2" }
            }]
        })))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "room_id": "!space:example.org" })),
        )
        .expect(1)
        .mount(server.server())
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

    core.run(crate::api::rooms::CreateParams {
        name: Some("Private space".to_owned()),
        topic: None,
        kind: crate::api::rooms::RoomKind::Space,
        public: false,
        encrypted: true,
        invite: Vec::new(),
        parent_space: None,
        alias: None,
        room_version: None,
        join_rule: None,
        federate: true,
        predecessor: None,
    })
    .await
    .unwrap();
}

fn calendar_event(event_id: &str, uid: &str) -> serde_json::Value {
    json!({
        "type": "chat.commet.calendar_events", "event_id": event_id,
        "sender": "@ana:example.org", "origin_server_ts": 1,
        "room_id": "!calendar:example.org",
        "content": {
            "format": "chat.commet.calendar.event.rfc8984",
            "events": [{ "event": { "uid": uid, "start": "2026-10-01T20:00:00" } }]
        }
    })
}

#[tokio::test]
async fn a_calendar_reload_reads_back_only_to_what_it_already_has() {
    let raw_timeline_event = |event: serde_json::Value| {
        matrix_sdk::ruma::serde::Raw::new(&event)
            .unwrap()
            .cast_unchecked::<matrix_sdk::ruma::events::AnyTimelineEvent>()
    };
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!calendar:example.org");
    server.sync_joined_room(&client, room_id).await;
    server
        .mock_room_messages()
        .ok(RoomMessagesResponseTemplate::default()
            .events(vec![raw_timeline_event(calendar_event("$a", "raid"))]))
        .mock_once()
        .mount()
        .await;
    server
        .mock_room_messages()
        .ok(RoomMessagesResponseTemplate::default()
            .events(vec![
                raw_timeline_event(calendar_event("$b", "picnic")),
                raw_timeline_event(json!({
                    "type": "m.room.redaction", "event_id": "$r",
                    "sender": "@ana:example.org", "origin_server_ts": 2,
                    "room_id": "!calendar:example.org",
                    "redacts": "$a", "content": { "redacts": "$a" }
                })),
                raw_timeline_event(calendar_event("$a", "raid")),
            ])
            .end_token("older"))
        .mock_once()
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

    let first = core.calendar_entries(&room_id.to_owned()).await.unwrap();
    assert_eq!(first.entries.len(), 1);
    assert_eq!(first.entries[0].event_id, "$a");

    let second = core.calendar_entries(&room_id.to_owned()).await.unwrap();
    let ids: Vec<_> = second
        .entries
        .iter()
        .map(|entry| entry.event_id.as_str())
        .collect();
    assert_eq!(ids, ["$b"]);
}

#[tokio::test]
async fn a_synced_calendar_entry_tells_the_page_to_reload() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
    core.watch_calendars(&client, 1);

    let room_id = room_id!("!calendar:example.org");
    let state = |event: serde_json::Value| {
        matrix_sdk::ruma::serde::Raw::new(&event)
            .unwrap()
            .cast_unchecked()
    };
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_bulk([state(json!({
                    "type": "m.room.create", "state_key": "", "event_id": "$create",
                    "sender": "@ana:example.org", "origin_server_ts": 0,
                    "content": { "room_version": "11", "type": "chat.commet.calendar" }
                }))])
                .add_timeline_event(
                    matrix_sdk::ruma::serde::Raw::new(&calendar_event("$a", "raid"))
                        .unwrap()
                        .cast_unchecked::<matrix_sdk::ruma::events::AnySyncTimelineEvent>(),
                ),
        )
        .await;

    let changed = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Some(CoreEvent::CalendarChanged { room_id }) = events.recv().await {
                break room_id;
            }
        }
    })
    .await
    .expect("a calendar change");
    assert_eq!(changed, room_id);
}

#[tokio::test]
async fn an_emptied_state_event_is_a_state_event_not_a_deleted_message() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!cleared:example.org");
    let cleared = |id: &str| {
        serde_json::from_value::<
            matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::AnySyncTimelineEvent>,
        >(json!({
            "type": "m.room.pinned_events",
            "state_key": "",
            "event_id": id,
            "sender": User::Alice.to_string(),
            "origin_server_ts": 1,
            "content": {},
        }))
        .unwrap()
    };

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(cleared("$cleared")),
        )
        .await;
    let views = timeline_views(&client, &room, true).await.unwrap();
    let item = views
        .iter()
        .find(|view| view.event_id.as_deref() == Some(event_id!("$cleared")))
        .unwrap();

    match &item.content {
        crate::protocol::TimelineItemContentView::StateEvent {
            event_type,
            state_key,
            change,
            ..
        } => {
            assert_eq!(event_type, "m.room.pinned_events");
            assert_eq!(state_key, "");
            assert!(change.is_none());
        }
        other => panic!("expected a state event, got {other:?}"),
    }
}

#[tokio::test]
async fn a_pin_list_with_junk_entries_still_reads_as_a_pin_change() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!junk-pins:example.org");
    let event = serde_json::from_value::<
        matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::AnySyncTimelineEvent>,
    >(json!({
        "type": "m.room.pinned_events",
        "state_key": "",
        "event_id": "$pins",
        "sender": User::Alice.to_string(),
        "origin_server_ts": 1,
        "content": { "pinned": ["$a", "nex", "$b", "$new", "@nex:example.org", 4, [], {}] },
        "unsigned": { "prev_content": { "pinned": ["$a", "nex", "$b"] } },
    }))
    .unwrap();

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(event),
        )
        .await;
    let views = timeline_views(&client, &room, true).await.unwrap();
    let item = views
        .iter()
        .find(|view| view.event_id.as_deref() == Some(event_id!("$pins")))
        .unwrap();

    let crate::protocol::TimelineItemContentView::StateEvent {
        change:
            Some(crate::protocol::StateChangeView::PinnedEvents {
                added,
                removed,
                total,
            }),
        ..
    } = &item.content
    else {
        panic!("expected a pin change, got {:?}", item.content);
    };
    assert_eq!(added, &[event_id!("$new").to_owned()]);
    assert_eq!(removed, &[] as &[matrix_sdk::ruma::OwnedEventId]);
    assert_eq!(*total, 3);
}

#[expect(
    clippy::too_many_lines,
    reason = "test code; one sequential flow kept in a single function"
)]
#[tokio::test]
async fn an_ignore_change_resyncs_rooms_with_their_history_gap() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!ignored:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let ignore_change = Arc::new(AtomicBool::new(false));
    let ignore_sent = Arc::new(AtomicBool::new(false));

    let room_update = |events: Vec<serde_json::Value>, prev_batch: &str| {
        json!({
            room_id.as_str(): {
                "initial": true,
                "limited": true,
                "prev_batch": prev_batch,
                "timeline": events,
            }
        })
    };
    let sync_event = |body: &str, id: &matrix_sdk::ruma::EventId| {
        serde_json::from_str::<serde_json::Value>(
            factory
                .text_msg(body)
                .event_id(id)
                .into_raw_sync()
                .json()
                .get(),
        )
        .unwrap()
    };
    let h2 = sync_event("h2", event_id!("$h2"));
    let new1 = sync_event("new1", event_id!("$new1"));
    let first_sync = room_update(vec![h2.clone()], "before-h2");
    let resync = room_update(vec![h2, new1], "before-h2");

    let trigger = ignore_change.clone();
    let sent = ignore_sent.clone();
    Mock::given(method("POST"))
        .and(path(
            "/_matrix/client/unstable/org.matrix.simplified_msc3575/sync",
        ))
        .respond_with(move |request: &wiremock::Request| {
            let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
            let has_pos = request.url.query_pairs().any(|(key, _)| key == "pos");
            let mut response = json!({"pos": "1", "lists": {}, "rooms": {}, "extensions": {}});
            if body["conn_id"] != "encryption" {
                if !has_pos {
                    response["rooms"] = if trigger.load(Ordering::SeqCst) {
                        resync.clone()
                    } else {
                        first_sync.clone()
                    };
                } else if trigger.load(Ordering::SeqCst) && !sent.swap(true, Ordering::SeqCst) {
                    response["extensions"] = json!({"account_data": {"global": [{
                        "type": "m.ignored_user_list",
                        "content": {"ignored_users": {"@troll:localhost": {}}},
                    }]}});
                }
            }
            ResponseTemplate::new(200)
                .set_body_json(response)
                .set_delay(Duration::from_millis(100))
        })
        .mount(server.server())
        .await;
    server.mock_room_state_encryption().plain().mount().await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/_matrix/client/v3/rooms/.*/messages$"))
        .and(wiremock::matchers::query_param("from", "before-h2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "start": "before-h2",
            "chunk": [factory.text_msg("h1").event_id(event_id!("$h1")).into_raw_timeline()],
        })))
        .mount(server.server())
        .await;

    let sync_service = session::start_sync(client.clone()).await.unwrap();
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client: client.clone(),
        sync_service: sync_service.clone(),
        homeserver: server.server().uri(),
        oauth: false,
    });
    core.watch_ignored_history(&client, &sync_service);

    tokio::time::timeout(Duration::from_secs(10), async {
        while client.get_room(room_id).is_none() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let timeline = core.timeline(&room_id.to_owned()).await.unwrap();
    ignore_change.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(10), async {
        while !event_ids(timeline.items().await).contains(&"$new1".to_owned()) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            timeline.paginate_backwards(20).await.unwrap();
            let ids = event_ids(timeline.items().await);
            if ids.contains(&"$h1".to_owned()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(event_ids(timeline.items().await), ["$h1", "$h2", "$new1"]);
}

#[tokio::test]
async fn message_types_send_the_selected_profile() {
    for (method_name, fields) in [
        (
            "create_poll",
            json!({"question": "Lunch?", "answers": ["Soup", "Pasta"], "undisclosed": false, "max_selections": 1}),
        ),
        ("vote_poll", json!({"event_id": "$poll", "answers": ["0"]})),
        ("end_poll", json!({"event_id": "$poll"})),
        (
            "send_location",
            json!({"body": "here", "geo_uri": "geo:48,2"}),
        ),
        ("send_gesture", json!({"gesture": "hug", "target": null})),
        (
            "send_raw_event",
            json!({"event_type": "m.room.message", "content": {"msgtype": "m.text", "body": "hello"}}),
        ),
        ("react", json!({"event_id": "$target", "key": "👍"})),
    ] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!profile:example.org");
        let factory = EventFactory::new()
            .room(room_id)
            .sender(user_id!("@ana:example.org"));
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_timeline_event(
                    factory.text_msg("original").event_id(event_id!("$target")),
                ),
            )
            .await;
        server.mock_room_state_encryption().plain().mount().await;
        Mock::given(method("PUT"))
            .and(path_regex(r"^/_matrix/client/v3/rooms/.*/send/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$sent"})))
            .mount(server.server())
            .await;
        let core = core_for(&server, client).await;
        core.run(SubscribeParams {
            room_id: room_id.to_owned(),
            focus: TimelineFocusView::Live,
            hidden_events: false,
        })
        .await
        .unwrap();
        let mut params = fields;
        params["room_id"] = json!(room_id);
        params["persona"] = json!({
            "id": "kris", "display_name": "Kris", "avatar_url": "mxc://example.org/kris",
            "pronouns": [{"summary": "they/them", "language": "en"}],
            "color_on_light": null, "color_on_dark": null, "has_fallback": true,
        });
        core.call(&format!("messages.{method_name}"), &params.to_string())
            .await
            .unwrap();
        let sent = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                for request in server
                    .server()
                    .received_requests()
                    .await
                    .unwrap_or_default()
                {
                    if request.url.path().contains("/send/") {
                        return request.body_json::<serde_json::Value>().unwrap();
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("message sent");
        let profile = &sent[crate::personas::PER_MESSAGE_PROFILE];
        assert_eq!(profile["id"], "kris", "{method_name}: {sent}");
        assert_eq!(profile["displayname"], "Kris", "{method_name}: {sent}");
        assert_eq!(
            profile["avatar_url"], "mxc://example.org/kris",
            "{method_name}: {sent}"
        );
        assert_ne!(profile["has_fallback"], true, "{method_name}: {sent}");
    }
}

#[tokio::test]
async fn notification_replies_resolve_room_and_account_profiles() {
    for (association, expected) in [
        (json!({"profileId": "room"}), Some("Room profile")),
        (
            json!({"profileId": "room", "validUntil": 1}),
            Some("Account profile"),
        ),
        (serde_json::Value::Null, Some("Account profile")),
        (json!(false), None),
    ] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!profile:example.org");
        server.sync_joined_room(&client, room_id).await;
        for (event_type, content) in [
            (
                "fyi.cisnt.permessageprofile.roomassociation",
                json!({"associations": {room_id.as_str(): association}}),
            ),
            (
                "fyi.cisnt.permessageprofile.globalassociation",
                json!({"association": {"profileId": "account"}}),
            ),
            (
                "fi.mau.msc4461.per_message_profiles.v3",
                json!({"profiles": [
                    {"id": "room", "displayname": "Room profile"},
                    {"id": "account", "displayname": "Account profile"},
                ]}),
            ),
        ] {
            Mock::given(method("GET"))
                .and(path_regex(format!(
                    "/account_data/{}$",
                    event_type.replace('.', "\\.")
                )))
                .respond_with(ResponseTemplate::new(200).set_body_json(content))
                .mount(server.server())
                .await;
        }
        let profile = crate::personas::notification_profile(&client, room_id)
            .await
            .unwrap();
        assert_eq!(
            profile
                .as_ref()
                .and_then(|profile| profile.display_name.as_deref()),
            expected
        );
    }
}

#[tokio::test]
async fn thread_lists_are_notified_when_room_cache_changes() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!thread-updates:example.org");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client: client.clone(),
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });
    core.run(SubscribeParams {
        room_id: room_id.to_owned(),
        focus: TimelineFocusView::Live,
        hidden_events: false,
    })
    .await
    .unwrap();
    while events.try_recv().is_ok() {}
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                factory
                    .text_msg("new reply")
                    .event_id(event_id!("$new-reply"))
                    .in_thread(event_id!("$root"), event_id!("$root")),
            ),
        )
        .await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while let Some(event) = events.recv().await {
            if matches!(event, CoreEvent::ThreadsChanged { room_id: id } if id == room_id) {
                return;
            }
        }
        panic!("event stream closed");
    })
    .await
    .expect("room cache update must refresh thread discovery");
}

#[tokio::test]
async fn thread_actions_accept_linked_context_only_for_its_inferred_root() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .on_builder(|builder| builder.with_threading_support(crate::session::THREADING_SUPPORT))
        .build()
        .await;
    let room_id = room_id!("!linked-thread:example.org");
    let root = event_id!("$root");
    let target = event_id!("$older-reply");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("root").event_id(root)),
        )
        .await;
    server.mock_room_state_encryption().plain().mount().await;
    server
        .mock_room_event_context()
        .match_event_id()
        .ok(RoomContextResponseTemplate::new(
            factory
                .text_msg("older reply")
                .event_id(target)
                .in_thread(root, root)
                .into_event(),
        ))
        .mount()
        .await;
    let core = core_for(&server, client).await;
    let result = core
        .run(SubscribeParams {
            room_id: room_id.to_owned(),
            focus: TimelineFocusView::Event {
                event_id: target.to_owned(),
            },
            hidden_events: false,
        })
        .await
        .unwrap();
    let timeline = core
        .subscribed_timeline(
            &room_id.to_owned(),
            Some(&root.to_owned()),
            Some(result.subscription),
        )
        .await
        .unwrap();
    assert!(timeline.is_threaded());
    assert!(matches!(
        core.subscribed_timeline(
            &room_id.to_owned(),
            Some(&event_id!("$other").to_owned()),
            Some(result.subscription)
        )
        .await,
        Err(RpcError::UnknownSubscription)
    ));
    assert!(matches!(
        core.subscribed_timeline(
            &room_id!("!other:example.org").to_owned(),
            Some(&root.to_owned()),
            Some(result.subscription)
        )
        .await,
        Err(RpcError::UnknownSubscription)
    ));
}

#[tokio::test]
async fn redacting_a_topic_the_server_already_stripped_leaves_the_room_without_topic() {
    let server = MatrixMockServer::new().await;
    let directory = tempfile::tempdir().unwrap();
    let client = server
        .client_builder()
        .on_builder(|builder| builder.sqlite_store(directory.path(), None))
        .build()
        .await;
    let room_id = room_id!("!redacted-topic:example.org");
    let topic = json!({
        "type": "m.room.topic",
        "state_key": "",
        "sender": User::Alice.to_string(),
        "event_id": "$topic",
        "origin_server_ts": 1_000_000,
        "content": {},
    });
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_state_event(
                matrix_sdk::ruma::serde::Raw::new(&topic)
                    .unwrap()
                    .cast_unchecked(),
            ),
        )
        .await;
    assert_eq!(client.get_room(room_id).unwrap().topic(), None);

    let redaction = json!({
        "type": "m.room.redaction",
        "sender": User::Alice.to_string(),
        "event_id": "$redaction",
        "origin_server_ts": 2_000_000,
        "redacts": "$topic",
        "content": { "redacts": "$topic" },
    });
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                matrix_sdk::ruma::serde::Raw::new(&redaction)
                    .unwrap()
                    .cast_unchecked(),
            ),
        )
        .await;

    assert_eq!(room.topic(), None);
    let stored = client
        .state_store()
        .get_state_event(
            room_id,
            matrix_sdk::ruma::events::StateEventType::RoomTopic,
            "",
        )
        .await
        .unwrap()
        .expect("the redacted topic is kept");
    assert!(
        serde_json::to_value(stored).unwrap()["unsigned"]
            .get("redacted_because")
            .is_some()
    );
}
