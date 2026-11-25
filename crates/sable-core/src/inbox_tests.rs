use std::{collections::BTreeMap, sync::Arc};

use matrix_sdk::ruma::{OwnedEventId, owned_room_id, owned_user_id, push::Action, serde::Raw};
use matrix_sdk::{
    Client, Room,
    ruma::{
        event_id,
        events::AnySyncTimelineEvent,
        events::receipt::{ReceiptThread, ReceiptType},
        room_id,
    },
    test_utils::mocks::MatrixMockServer,
};
use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
use matrix_sdk_ui::sync_service::SyncService;
use serde_json::json;
use wiremock::{
    Mock, ResponseTemplate,
    matchers::{method, path_regex, query_param, query_param_is_missing},
};

use super::{
    Entry, InboxScope, MAX_ENTRIES, PreviewEmote, RoomReadState, UnreadScan, is_reply, is_unread,
    merge, preview,
};
use crate::{Core, api::notifications::InboxFilter, session::Session, store::MemorySessionStore};

async fn setup(server: &MatrixMockServer, notified: u64) -> (Arc<Core>, Client, Room) {
    let client = server.client_builder().build().await;
    let room_id = room_id!("!room:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_event(factory.member(client.user_id().unwrap()))
                .add_state_event(factory.member(User::Alice))
                .add_state_event(factory.power_levels())
                .set_unread_notifications_count(
                    json!({"notification_count": notified, "highlight_count": notified}),
                ),
        )
        .await;
    let (core, _) = Core::new("inbox", Box::new(MemorySessionStore::default()));
    crate::test_support::set_session(
        &core,
        Some(Session {
            account_id: "inbox".to_owned(),
            client: client.clone(),
            sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
            homeserver: server.server().uri(),
            oauth: false,
            state: Arc::default(),
        }),
    );
    (core, client, room)
}

fn message(event_id: &str, ts: u64, user: Option<&ruma::UserId>) -> serde_json::Value {
    json!({"type": "m.room.message", "event_id": event_id, "room_id": "!room:example.org",
            "sender": User::Alice, "origin_server_ts": ts,
            "content": {"msgtype": "m.text", "body": "hello", "m.mentions": {"user_ids": user.into_iter().collect::<Vec<_>>()}}})
}

#[tokio::test]
async fn an_unknown_encryption_state_hides_the_inbox_preview() {
    let server = MatrixMockServer::new().await;
    let (core, _client, room) = setup(&server, 1).await;
    assert!(room.encryption_state().is_unknown());
    let raw =
        Raw::<AnySyncTimelineEvent>::from_json_string(message("$message", 1, None).to_string())
            .unwrap();

    let entry = core
        .inbox_entry(&room, &raw, &[Action::Notify])
        .await
        .unwrap();
    assert!(entry.encrypted);
    assert!(entry.body.is_none());
}

#[tokio::test]
async fn recorded_notifications_reach_the_store_only_on_flush() {
    let server = MatrixMockServer::new().await;
    let (core, client, _room) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    for (event, ts) in [("first", 100), ("second", 200)] {
        session
            .record_inbox(vec![entry(event, ts)], BTreeMap::new(), BTreeMap::new())
            .await
            .unwrap();
    }
    assert_eq!(super::load(&client).await.unwrap().entries, []);

    session.flush_inbox().await;

    let stored = super::load(&client).await.unwrap();
    assert_eq!(stored.entries.len(), 2);
    *session.state().inbox.cache.lock().await = super::InboxCache::default();
    assert_eq!(session.stored_inbox().await.unwrap().entries.len(), 2);
}

#[tokio::test]
async fn suspending_with_unsaved_notifications_saves_them_and_lets_sync_resume() {
    let server = MatrixMockServer::new().await;
    let (core, client, _room) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    session
        .record_inbox(vec![entry("first", 100)], BTreeMap::new(), BTreeMap::new())
        .await
        .unwrap();

    let cycle = async {
        core.update_app_active(false).await;
        core.update_app_active(true).await;
    };
    matrix_sdk::timeout::timeout(cycle, std::time::Duration::from_secs(5))
        .await
        .expect("suspending must not deadlock");

    assert_eq!(super::load(&client).await.unwrap().entries.len(), 1);
}

#[tokio::test]
async fn suspending_during_the_first_inbox_load_does_not_deadlock() {
    let server = MatrixMockServer::new().await;
    let (core, _client, _room) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    let closing = core.activity.closing_stores().await;
    let record = session.record_inbox(vec![entry("first", 100)], BTreeMap::new(), BTreeMap::new());
    tokio::pin!(record);
    assert!(futures_util::poll!(record.as_mut()).is_pending());

    matrix_sdk::timeout::timeout(
        core.update_app_active(false),
        std::time::Duration::from_secs(5),
    )
    .await
    .expect("suspending must not wait for the inbox a pending load holds");
    drop(closing);
    let recorded = record.await;
    assert_eq!(recorded.unwrap(), 1);
}

#[tokio::test]
async fn the_inbox_can_be_limited_to_one_room() {
    let server = MatrixMockServer::new().await;
    let (core, _client, room) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    session
        .record_inbox(vec![entry("here", 200)], BTreeMap::new(), BTreeMap::new())
        .await
        .unwrap();

    let (here, _) = session
        .inbox_notifications(
            InboxFilter::All,
            true,
            30,
            None,
            InboxScope {
                room_id: Some(room.room_id()),
                ..InboxScope::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(here.len(), 1);
    let (elsewhere, _) = session
        .inbox_notifications(
            InboxFilter::All,
            true,
            30,
            None,
            InboxScope {
                room_id: Some(room_id!("!other:example.org")),
                ..InboxScope::default()
            },
        )
        .await
        .unwrap();
    assert!(elsewhere.is_empty());
}

#[tokio::test]
async fn the_inbox_can_be_searched_by_sender() {
    let server = MatrixMockServer::new().await;
    let (core, _client, _) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    session
        .record_inbox(
            vec![entry("from-alice", 200)],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();

    for (query, found) in [("ALICE", 1), ("bob", 0), ("", 1)] {
        let (items, _) = session
            .inbox_notifications(
                InboxFilter::All,
                true,
                30,
                None,
                InboxScope {
                    query: Some(query),
                    ..InboxScope::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(items.len(), found, "{query}");
    }
}

#[tokio::test]
async fn highlights_keep_inbox_notifications_unread() {
    let server = MatrixMockServer::new().await;
    let (core, client, room) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    session
        .record_inbox(vec![entry("unread", 200)], BTreeMap::new(), BTreeMap::new())
        .await
        .unwrap();
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room.room_id()).set_unread_notifications_count(
                json!({"notification_count": 0, "highlight_count": 1}),
            ),
        )
        .await;
    let (items, _) = session
        .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert!(!items[0].read);
}

#[tokio::test]
async fn a_stored_encrypted_preview_is_hidden_once_the_setting_is_off() {
    let server = MatrixMockServer::new().await;
    let (core, _client, _room) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    let stored = Entry {
        body: Some("secret".to_owned()),
        emotes: vec![PreviewEmote {
            alt: ":blob:".to_owned(),
            source: "mxc://example.org/blob".to_owned(),
        }],
        encrypted: true,
        ..entry("secret", 200)
    };
    session
        .record_inbox(vec![stored], BTreeMap::new(), BTreeMap::new())
        .await
        .unwrap();
    core.settings
        .notification_content
        .store(true, std::sync::atomic::Ordering::Relaxed);

    core.settings
        .notification_encrypted_content
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let (items, _) = session
        .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
        .await
        .unwrap();
    assert_eq!(items[0].body.as_deref(), Some("secret"));
    assert_eq!(items[0].emotes.len(), 1);

    core.settings
        .notification_encrypted_content
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let (items, _) = session
        .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
        .await
        .unwrap();
    assert_eq!(items[0].body, None);
    assert_eq!(items[0].emotes, []);
}

#[tokio::test]
async fn direct_filter_uses_current_room_status() {
    let server = MatrixMockServer::new().await;
    let (core, client, room) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    session
        .record_inbox(vec![entry("unread", 200)], BTreeMap::new(), BTreeMap::new())
        .await
        .unwrap();
    let factory = EventFactory::new().room(room.room_id()).sender(User::Alice);
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_global_account_data(factory.direct().add_user(User::Alice, room.room_id()));
        })
        .await;
    assert!(room.is_direct().await.unwrap());
    let (items, _) = session
        .inbox_notifications(InboxFilter::Direct, false, 30, None, InboxScope::default())
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert!(items[0].is_direct);
}

#[tokio::test]
async fn a_direct_room_records_messages_the_push_rules_did_not_notify() {
    let server = MatrixMockServer::new().await;
    let (core, client, room) = setup(&server, 0).await;
    let raw = serde_json::from_value(message("$bridged", 200, None)).unwrap();
    assert!(core.inbox_entry(&room, &raw, &[]).await.is_none());
    let factory = EventFactory::new().room(room.room_id()).sender(User::Alice);
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_global_account_data(factory.direct().add_user(User::Alice, room.room_id()));
        })
        .await;
    let entry = core.inbox_entry(&room, &raw, &[]).await.unwrap();
    assert!(entry.is_direct);
}

#[tokio::test]
async fn a_thread_receipt_marks_its_replies_read_and_threads_filter_them() {
    let server = MatrixMockServer::new().await;
    let (core, client, room) = setup(&server, 0).await;
    let session = core.signed_in().unwrap();
    let factory = EventFactory::new().room(room.room_id()).sender(User::Alice);
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room.room_id()).add_receipt(
                factory
                    .read_receipts()
                    .add(
                        event_id!("$read-reply"),
                        client.user_id().unwrap(),
                        ReceiptType::Read,
                        ReceiptThread::Thread(event_id!("$root").to_owned()),
                    )
                    .into_event(),
            ),
        )
        .await;
    Mock::given(method("GET"))
        .and(path_regex("/event/.*read-reply$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(message("$read-reply", 250, None)))
        .mount(server.server())
        .await;
    let in_thread = |event: &str, ts| Entry {
        thread_root: Some(event_id!("$root").to_owned()),
        ..entry(event, ts)
    };
    session
        .record_inbox(
            vec![
                in_thread("seen", 200),
                in_thread("new", 300),
                entry("main", 100),
            ],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();

    let (items, _) = session
        .inbox_notifications(InboxFilter::Threads, true, 30, None, InboxScope::default())
        .await
        .unwrap();
    let read: Vec<_> = items
        .iter()
        .map(|item| (item.event_id.as_str(), item.read))
        .collect();
    assert_eq!(read, [("$new", false), ("$seen", true)]);
    assert!(
        items
            .iter()
            .all(|item| item.thread_root.as_deref() == Some("$root"))
    );
}

#[tokio::test]
async fn a_room_receipt_reads_thread_replies_in_a_room_without_notifications() {
    let server = MatrixMockServer::new().await;
    let (core, client, room) = setup(&server, 0).await;
    let session = core.signed_in().unwrap();
    let factory = EventFactory::new().room(room.room_id()).sender(User::Alice);
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room.room_id()).add_receipt(
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
        )
        .await;
    Mock::given(method("GET"))
        .and(path_regex("/event/.*read$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(message("$read", 250, None)))
        .mount(server.server())
        .await;
    let in_thread = |event: &str, ts| Entry {
        thread_root: Some(event_id!("$root").to_owned()),
        ..entry(event, ts)
    };
    session
        .record_inbox(
            vec![in_thread("seen", 200), in_thread("new", 300)],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();

    let (items, _) = session
        .inbox_notifications(InboxFilter::All, true, 30, None, InboxScope::default())
        .await
        .unwrap();
    let read: Vec<_> = items
        .iter()
        .map(|item| (item.event_id.as_str(), item.read))
        .collect();
    assert_eq!(read, [("$new", false), ("$seen", true)]);
}

#[tokio::test]
async fn a_mention_after_the_receipt_stays_unread_when_the_server_clears_its_counts() {
    let server = MatrixMockServer::new().await;
    let (core, client, room) = setup(&server, 0).await;
    let session = core.signed_in().unwrap();
    let factory = EventFactory::new().room(room.room_id()).sender(User::Alice);
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room.room_id()).add_receipt(
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
        )
        .await;
    Mock::given(method("GET"))
        .and(path_regex("/event/.*read$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(message("$read", 150, None)))
        .mount(server.server())
        .await;
    let mention = |event: &str, ts| Entry {
        highlight: true,
        ..entry(event, ts)
    };
    session
        .record_inbox(
            vec![
                mention("seen", 100),
                mention("ping", 200),
                entry("after", 300),
            ],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();

    let (items, _) = session
        .inbox_notifications(
            InboxFilter::Mentions,
            false,
            30,
            None,
            InboxScope::default(),
        )
        .await
        .unwrap();

    assert_eq!(
        items
            .iter()
            .map(|item| item.event_id.as_str())
            .collect::<Vec<_>>(),
        ["$ping"]
    );
}

#[test]
fn an_entry_stored_before_threads_were_recorded_is_not_in_a_thread() {
    let stored = json!({"room_id": "!room:example.org", "event_id": "$old", "ts": 1,
            "sender": "@alice:example.org", "sender_name": null, "body": null,
            "highlight": false, "is_direct": false, "encrypted": false});
    let entry: Entry = serde_json::from_value(stored).unwrap();
    assert_eq!(entry.thread_root, None);
    assert!(!super::matches(&entry, InboxFilter::Threads));
}

#[tokio::test]
async fn delayed_receipt_does_not_hide_a_newer_unread_message() {
    let server = MatrixMockServer::new().await;
    let (core, client, room) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    let factory = EventFactory::new().room(room.room_id()).sender(User::Alice);
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room.room_id())
                .add_receipt(
                    factory
                        .read_receipts()
                        .add_with_timestamp(
                            event_id!("$read"),
                            client.user_id().unwrap(),
                            ReceiptType::Read,
                            ReceiptThread::Unthreaded,
                            Some(ruma::MilliSecondsSinceUnixEpoch(300u32.into())),
                        )
                        .into_event(),
                )
                .set_unread_notifications_count(
                    json!({"notification_count": 1, "highlight_count": 1}),
                ),
        )
        .await;
    Mock::given(method("GET"))
        .and(path_regex("/event/.*read$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(message("$read", 100, None)))
        .expect(1)
        .mount(server.server())
        .await;
    session
        .record_inbox(vec![entry("unread", 200)], BTreeMap::new(), BTreeMap::new())
        .await
        .unwrap();

    for _ in 0..2 {
        let (items, _) = session
            .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].event_id, "$unread");
        assert!(!items[0].read);
    }
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room.room_id())
                .add_receipt(
                    factory
                        .read_receipts()
                        .add(
                            event_id!("$unavailable"),
                            client.user_id().unwrap(),
                            ReceiptType::Read,
                            ReceiptThread::Unthreaded,
                        )
                        .into_event(),
                )
                .set_unread_notifications_count(
                    json!({"notification_count": 0, "highlight_count": 0}),
                ),
        )
        .await;
    let (items, _) = session
        .inbox_notifications(InboxFilter::All, true, 30, None, InboxScope::default())
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert!(items[0].read);
}

#[tokio::test]
async fn an_unfetchable_receipt_event_falls_back_to_the_receipt_time() {
    let server = MatrixMockServer::new().await;
    let (core, client, room) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    let factory = EventFactory::new().room(room.room_id()).sender(User::Alice);
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room.room_id())
                .add_receipt(
                    factory
                        .read_receipts()
                        .add_with_timestamp(
                            event_id!("$gone"),
                            client.user_id().unwrap(),
                            ReceiptType::Read,
                            ReceiptThread::Unthreaded,
                            Some(ruma::MilliSecondsSinceUnixEpoch(150u32.into())),
                        )
                        .into_event(),
                )
                .set_unread_notifications_count(
                    json!({"notification_count": 1, "highlight_count": 1}),
                ),
        )
        .await;
    Mock::given(method("GET"))
        .and(path_regex("/event/.*gone$"))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "gone"})),
        )
        .mount(server.server())
        .await;
    session
        .record_inbox(
            vec![entry("old", 100), entry("new", 200)],
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .await
        .unwrap();

    let (items, _) = session
        .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
        .await
        .unwrap();

    assert_eq!(
        items
            .iter()
            .map(|item| item.event_id.as_str())
            .collect::<Vec<_>>(),
        ["$new"]
    );
}

#[tokio::test]
async fn unread_backfill_resumes_after_five_empty_pages() {
    let server = MatrixMockServer::new().await;
    let (core, client, _) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    for page in 0..6 {
        let mock = Mock::given(method("GET")).and(path_regex("/messages$"));
        let mock = if page == 0 {
            mock.and(query_param_is_missing("from"))
        } else {
            mock.and(query_param("from", format!("p{page}")))
        };
        let mut event = message(
            &format!("$p{page}"),
            1000 - page,
            if page == 5 { client.user_id() } else { None },
        );
        if page < 5 {
            event["sender"] = json!(client.user_id().unwrap());
        }
        mock.respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "start": format!("p{page}"), "end": format!("p{}", page + 1), "chunk": [event], "state": []
            }))).expect(1).mount(server.server()).await;
    }

    assert_eq!(
        session.backfill_inbox(false, None).await.unwrap(),
        (0, true)
    );
    assert_eq!(
        session.backfill_inbox(false, None).await.unwrap(),
        (1, false)
    );
    assert_eq!(
        session.backfill_inbox(false, None).await.unwrap(),
        (0, false)
    );
    let (items, _) = session
        .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].event_id, "$p5");
}

#[tokio::test]
async fn backfill_fetch_errors_are_reported_and_can_be_retried() {
    let server = MatrixMockServer::new().await;
    let (core, client, _) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    let failure = Mock::given(method("GET"))
        .and(path_regex("/messages$"))
        .respond_with(
            ResponseTemplate::new(403)
                .set_body_json(json!({"errcode": "M_FORBIDDEN", "error": "denied"})),
        )
        .mount_as_scoped(server.server())
        .await;
    session.backfill_inbox(false, None).await.unwrap_err();
    drop(failure);
    Mock::given(method("GET")).and(path_regex("/messages$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"start": "p0", "chunk": [message("$retry", 100, client.user_id())], "state": []})))
            .mount(server.server()).await;
    assert_eq!(
        session.backfill_inbox(false, None).await.unwrap(),
        (1, false)
    );
}

#[tokio::test]
async fn unread_backfill_reaches_rooms_beyond_the_first_batch() {
    let server = MatrixMockServer::new().await;
    let (core, client, _) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    for index in 0..6 {
        let name = if index == 0 {
            "room".to_owned()
        } else {
            format!("extra{index}")
        };
        if index > 0 {
            let room_id = ruma::RoomId::parse(format!("!{name}:example.org")).unwrap();
            let factory = EventFactory::new().room(&room_id).sender(User::Alice);
            server
                .sync_room(
                    &client,
                    JoinedRoomBuilder::new(&room_id)
                        .add_state_event(factory.member(client.user_id().unwrap()))
                        .add_state_event(factory.member(User::Alice))
                        .add_state_event(factory.power_levels())
                        .set_unread_notifications_count(
                            json!({"notification_count": 1, "highlight_count": 1}),
                        ),
                )
                .await;
        }
        Mock::given(method("GET")).and(path_regex(format!("/rooms/.*{name}.*?/messages$")))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({"start": "p0", "chunk": [message(&format!("${name}"), 100, client.user_id())], "state": []})))
                .expect(1).mount(server.server()).await;
    }
    assert_eq!(
        session.backfill_inbox(false, None).await.unwrap(),
        (5, true)
    );
    assert_eq!(
        session.backfill_inbox(false, None).await.unwrap(),
        (1, false)
    );
    assert_eq!(
        session
            .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
            .await
            .unwrap()
            .0
            .len(),
        6
    );
}

#[tokio::test]
async fn backfill_can_be_limited_to_one_room() {
    let server = MatrixMockServer::new().await;
    let (core, client, room) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    let other = matrix_sdk::ruma::room_id!("!other:example.org");
    let factory = EventFactory::new().room(other).sender(User::Alice);
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(other)
                .add_state_event(factory.member(client.user_id().unwrap()))
                .add_state_event(factory.member(User::Alice))
                .add_state_event(factory.power_levels())
                .set_unread_notifications_count(
                    json!({"notification_count": 1, "highlight_count": 1}),
                ),
        )
        .await;
    for (name, calls) in [("room", 1), ("other", 0)] {
        Mock::given(method("GET")).and(path_regex(format!("/rooms/.*{name}.*?/messages$")))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({"start": "p0", "chunk": [message(&format!("${name}"), 100, client.user_id())], "state": []})))
                .expect(calls).mount(server.server()).await;
    }

    assert_eq!(
        session
            .backfill_inbox(false, Some(room.room_id()))
            .await
            .unwrap(),
        (1, false)
    );
}

#[tokio::test]
async fn a_cached_notification_does_not_stop_backfill_before_a_missing_one() {
    let server = MatrixMockServer::new().await;
    let (core, client, _) = setup(&server, 2).await;
    let session = core.signed_in().unwrap();
    session
        .record_inbox(vec![entry("known", 200)], BTreeMap::new(), BTreeMap::new())
        .await
        .unwrap();
    for (from, end, id, ts) in [
        (None, Some("older"), "$known", 200),
        (Some("older"), None, "$missing", 100),
    ] {
        let mock = Mock::given(method("GET")).and(path_regex("/messages$"));
        let mock = if let Some(from) = from {
            mock.and(query_param("from", from))
        } else {
            mock.and(query_param_is_missing("from"))
        };
        mock.respond_with(ResponseTemplate::new(200).set_body_json(json!({"start": "p0", "end": end, "chunk": [message(id, ts, client.user_id())], "state": []})))
                .expect(1).mount(server.server()).await;
    }
    assert_eq!(
        session.backfill_inbox(false, None).await.unwrap(),
        (1, false)
    );
    assert_eq!(
        session
            .inbox_notifications(InboxFilter::All, false, 30, None, InboxScope::default())
            .await
            .unwrap()
            .0
            .len(),
        2
    );
}

#[test]
fn a_new_head_or_read_boundary_restarts_a_completed_scan() {
    let mut scan = UnreadScan::for_room(None, 100, 1, Some(event_id!("$old").to_owned()));
    scan.complete = true;
    scan.from = Some("old-page".to_owned());
    let fresh = UnreadScan::for_room(Some(&scan), 100, 1, Some(event_id!("$new").to_owned()));
    assert!(!fresh.complete);
    assert!(fresh.from.is_none());
    let fresh = UnreadScan::for_room(Some(&scan), 200, 1, scan.head.clone());
    assert!(!fresh.complete);
    assert!(fresh.from.is_none());
}

fn entry(event: &str, ts: u64) -> Entry {
    Entry {
        room_id: owned_room_id!("!room:example.org"),
        event_id: OwnedEventId::try_from(format!("${event}")).unwrap(),
        ts,
        sender: owned_user_id!("@alice:example.org"),
        sender_name: None,
        body: None,
        emotes: Vec::new(),
        highlight: false,
        is_direct: false,
        encrypted: false,
        undecryptable: false,
        thread_root: None,
        reply: false,
    }
}

#[test]
fn only_real_replies_count_as_replies() {
    let event = |relation: serde_json::Value| {
        Raw::<AnySyncTimelineEvent>::from_json_string(
            json!({
                "type": "m.room.message",
                "event_id": "$e",
                "sender": "@a:example.org",
                "origin_server_ts": 1,
                "content": { "msgtype": "m.text", "body": "hi", "m.relates_to": relation },
            })
            .to_string(),
        )
        .unwrap()
    };

    assert!(is_reply(&event(
        json!({ "m.in_reply_to": { "event_id": "$p" } })
    )));
    assert!(!is_reply(&event(json!({
        "rel_type": "m.thread",
        "event_id": "$root",
        "is_falling_back": true,
        "m.in_reply_to": { "event_id": "$p" },
    }))));
    assert!(is_reply(&event(json!({
        "rel_type": "m.thread",
        "event_id": "$root",
        "is_falling_back": false,
        "m.in_reply_to": { "event_id": "$p" },
    }))));
    assert!(!is_reply(&event(json!({}))));
}

#[test]
fn merge_skips_known_events_and_keeps_newest_first() {
    let mut entries = vec![entry("a", 10), entry("b", 30)];

    let added = merge(&mut entries, vec![entry("a", 10), entry("c", 20)]);

    assert_eq!(added, 1);
    let order: Vec<u64> = entries.iter().map(|entry| entry.ts).collect();
    assert_eq!(order, vec![30, 20, 10]);
}

#[test]
fn merge_replaces_an_undecryptable_entry_with_its_decrypted_version() {
    let mut stale = entry("a", 10);
    stale.undecryptable = true;
    stale.highlight = true;
    let mut decrypted = entry("a", 10);
    decrypted.body = Some("hello".to_owned());
    let mut entries = vec![stale];

    let changed = merge(&mut entries, vec![decrypted.clone()]);

    assert_eq!(changed, 1);
    assert_eq!(entries, vec![decrypted.clone()]);

    let mut still_encrypted = entry("a", 10);
    still_encrypted.undecryptable = true;
    assert_eq!(merge(&mut entries, vec![still_encrypted]), 0);
    assert_eq!(entries, vec![decrypted]);
}

#[test]
fn merge_drops_the_oldest_past_the_cap() {
    let mut entries: Vec<Entry> = (0..MAX_ENTRIES as u64)
        .map(|index| entry(&format!("e{index}"), index + 1))
        .collect();

    merge(&mut entries, vec![entry("newest", u64::MAX)]);

    assert_eq!(entries.len(), MAX_ENTRIES);
    assert_eq!(entries.first().map(|entry| entry.ts), Some(u64::MAX));
    assert!(entries.iter().all(|entry| entry.ts != 1));
}

#[test]
fn unread_stops_at_the_receipt_and_the_server_count() {
    let mut state = RoomReadState {
        receipt_ts: 15,
        remaining: 1,
    };

    assert!(is_unread(&entry("new", 30), &mut state));
    assert!(!is_unread(&entry("newer-than-receipt", 20), &mut state));
    assert!(!is_unread(&entry("old", 10), &mut state));
}

#[test]
fn previews_are_truncated_on_characters() {
    let long = "é".repeat(200);

    let short = preview(long);

    assert_eq!(short.chars().count(), 121);
    assert!(short.ends_with('…'));
}

#[tokio::test]
async fn logging_out_while_suspended_with_unsaved_notifications_finishes() {
    let server = MatrixMockServer::new().await;
    let (core, _client, _room) = setup(&server, 1).await;
    let session = core.signed_in().unwrap();
    session
        .record_inbox(vec![entry("first", 100)], BTreeMap::new(), BTreeMap::new())
        .await
        .unwrap();
    *core.accounts.lock().await = Some(crate::session::AccountRegistry::empty());
    core.activity.close_stores_when_suspended();
    core.update_app_active(false).await;
    session.state().inbox.cache.lock().await.revision += 1;

    matrix_sdk::timeout::timeout(Box::pin(core.logout()), std::time::Duration::from_secs(15))
        .await
        .expect("a logout while the stores are closed must not wait for them")
        .unwrap();
}
