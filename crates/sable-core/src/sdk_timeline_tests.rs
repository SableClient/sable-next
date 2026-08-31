use std::{collections::BTreeSet, sync::Arc, time::Duration};

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::{
    ruma::{
        event_id,
        events::{
            key::verification::done::KeyVerificationDoneEventContent,
            relation::Reference,
            room::message::{LocationMessageEventContent, MessageType, RoomMessageEventContent},
        },
        room_id, user_id,
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
    matchers::{method, path, path_regex},
};

use super::{
    Core,
    protocol::{Command, CommandErr, CommandOk, CoreEvent, TimelineFocusView},
    session::{self, Session},
    store::MemorySessionStore,
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
    let timeline = build_room_timeline(&room, &TimelineFocusView::Live, true)
        .await
        .unwrap();

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

    let response = core
        .dispatch(Command::RoomStateEvent {
            room_id: room_id.to_owned(),
            event_type: event_type.to_owned(),
            state_key: String::new(),
        })
        .await
        .unwrap();

    assert!(matches!(
        response,
        CommandOk::RoomStateEvent {
            content: Some(content)
        } if content == json!({"url": "mxc://example.org/banner"})
    ));
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
            focus: TimelineFocusView::Live,
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
            focus: TimelineFocusView::Live,
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
            focus: TimelineFocusView::Live,
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
        focus: TimelineFocusView::Live,
        hidden_events: false,
    })
    .await
    .unwrap();

    let result = core
        .dispatch(Command::SendSticker {
            room_id: room_id.to_owned(),
            url: "mxc://example.org/blob".to_owned(),
            body: "blobwave".to_owned(),
            info: None,
            in_reply_to: None,
            thread_root: None,
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
            .map(|item| super::view::timeline_item(item, client.user_id(), &BTreeSet::new()))
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
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!poll:example.org");
    let own = client.user_id().expect("a logged-in client").to_owned();
    let factory = EventFactory::new().room(room_id).sender(*ALICE);
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
async fn an_undisclosed_poll_withholds_its_tally_until_it_closes() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!undisclosed:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);
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
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!custom:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);
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
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!location:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);

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
async fn a_notice_is_marked_as_one_rather_than_read_as_speech() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!notice:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);

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
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!gallery:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);

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
        [crate::protocol::GalleryItemView::Image { body, .. }] if body == "beach.jpg"
    ));
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
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!named:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);

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
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!pinned:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);

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
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!call:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);

    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                factory
                    .call_membership_state(ALICE.to_owned(), "DEVICE".to_owned())
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
async fn room_command_error(response: ResponseTemplate) -> Option<crate::protocol::CommandErr> {
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
        matches!(error, CommandErr::Denied),
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
            CommandErr::RateLimited {
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
        matches!(error, CommandErr::Unavailable),
        "expected Unavailable, got {error:?}"
    );
}

#[tokio::test]
async fn fetching_members_names_a_bridge_ghost_the_sync_never_shipped() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
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

#[allow(clippy::unwrap_used, clippy::expect_used)]
async fn mark_read_body(private_receipt: bool) -> serde_json::Value {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!receipts:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);

    server.mock_room_state_encryption().plain().mount().await;
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("read me").event_id(event_id!("$read"))),
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

    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });

    core.dispatch(Command::MarkRead {
        room_id: room_id.to_owned(),
        event_id: event_id!("$read").to_owned(),
        private_receipt,
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

    serde_json::from_slice(&marker.body).expect("a JSON body")
}

#[allow(clippy::unwrap_used, clippy::expect_used)]
#[tokio::test]
async fn marking_unread_writes_the_room_account_data_flag() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
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

    core.dispatch(Command::MarkUnread {
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

#[allow(clippy::unwrap_used, clippy::expect_used)]
#[tokio::test]
async fn marking_unread_from_a_message_walks_the_read_marker_back() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!unread-from:example.org");
    let factory = EventFactory::new().room(room_id).sender(*ALICE);

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

    core.dispatch(Command::MarkUnread {
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
    let body = mark_read_body(false).await;

    assert_eq!(body["m.read"], json!("$read"));
    assert_eq!(body["m.fully_read"], json!("$read"));
    assert!(body.get("m.read.private").is_none(), "{body}");
}

#[tokio::test]
async fn a_private_reader_still_moves_the_marker_without_telling_the_room() {
    let body = mark_read_body(true).await;

    assert_eq!(body["m.read.private"], json!("$read"));
    assert_eq!(
        body["m.fully_read"],
        json!("$read"),
        "the unread badge tracks the marker, so it has to move either way"
    );
    assert!(body.get("m.read").is_none(), "{body}");
}

async fn sender_names(timeline: &Arc<matrix_sdk_ui::timeline::Timeline>) -> Vec<Option<String>> {
    timeline
        .items()
        .await
        .iter()
        .filter(|item| item.as_event().is_some())
        .map(|item| crate::view::timeline_item(item, None, &BTreeSet::new()).sender_name)
        .collect()
}
