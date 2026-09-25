use std::{collections::HashMap, sync::Arc};

use matrix_sdk::{
    ruma::{api::MatrixVersion, room_id, serde::Raw},
    test_utils::mocks::MatrixMockServer,
};
use matrix_sdk_test::JoinedRoomBuilder;
use matrix_sdk_ui::{
    eyeball_im::VectorDiff, room_list_service::RoomListItem, sync_service::SyncService,
};
use serde_json::json;
use wiremock::{
    Mock, ResponseTemplate,
    matchers::{method, path},
};

use crate::{
    Core,
    protocol::{Command, CommandErr, CommandOk, CoreEvent},
    session::Session,
    store::MemorySessionStore,
};

#[allow(clippy::unwrap_used)]
async fn core(server: &MatrixMockServer, client: matrix_sdk::Client) -> Arc<Core> {
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("helpers-test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".into(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });
    core
}

#[tokio::test]
async fn devices_without_uploaded_crypto_keys_remain_visible() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET")).and(path("/_matrix/client/v3/devices"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"devices": [
            {"device_id": "NO_KEYS", "display_name": "New phone", "last_seen_ts": 123, "last_seen_ip": "192.0.2.1"}
        ]}))).expect(1).mount(server.server()).await;
    let devices = crate::verification::own_devices(&client).await;
    let device = devices
        .iter()
        .find(|device| device.device_id == "NO_KEYS")
        .expect("server device is visible without crypto keys");
    assert!(!device.is_verified);
    assert!(!device.cross_signed);
    assert_eq!(device.display_name.as_deref(), Some("New phone"));
    assert_eq!(device.last_seen_ts, Some(123));
}

#[tokio::test]
async fn image_pack_listing_fetches_complete_state_when_one_pack_is_cached() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!packs:example.org");
    let pack = |key: &str| {
        json!({
            "type": "im.ponies.room_emotes", "state_key": key, "sender": "@alice:example.org",
            "event_id": format!("${key}"), "origin_server_ts": 1,
            "content": {"images": {"wave": {"url": "mxc://example.org/wave"}}}
        })
    };
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_event(Raw::new(&pack("cached")).unwrap().cast_unchecked()),
        )
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{room_id}/state")))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!([pack("cached"), pack("missing")])),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let CommandOk::ImagePacks { packs, .. } = core
        .dispatch(Command::ImagePacks {
            room_id: room_id.to_owned(),
            cached_only: false,
        })
        .await
        .unwrap()
    else {
        panic!("wrong response")
    };
    assert_eq!(
        packs
            .iter()
            .map(|pack| pack.id.as_str())
            .collect::<Vec<_>>(),
        ["cached", "missing"]
    );
}

#[tokio::test]
async fn healthy_space_summary_does_not_fetch_missing_tombstone_state() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!space:example.org");
    server.sync_room(&client, JoinedRoomBuilder::new(room_id).add_state_event(
        Raw::new(&json!({"type": "m.room.create", "state_key": "", "sender": "@alice:example.org", "event_id": "$create", "origin_server_ts": 1,
            "content": {"type": "m.space", "room_version": "10", "creator": "@alice:example.org"}})).unwrap().cast_unchecked()
    )).await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/state/m.room.tombstone/"
        )))
        .respond_with(ResponseTemplate::new(404))
        .expect(0)
        .mount(server.server())
        .await;
    let item = RoomListItem::from(client.get_room(room_id).unwrap());
    let mut cache = HashMap::new();
    crate::view::enrich_room_fields(
        &VectorDiff::Set {
            index: 0,
            value: item.clone(),
        },
        &mut cache,
    )
    .await;
    let summary = crate::view::room_summary(&item, &cache, false);
    assert!(summary.is_space);
    assert!(!summary.is_tombstoned);
}

#[test]
fn space_child_ties_follow_ruma_room_id_order() {
    let events = ["!z:example.org", "!a:example.org"].map(|room| {
        Raw::new(&json!({
            "type": "m.space.child", "state_key": room, "origin_server_ts": 1, "sender": "@alice:example.org",
            "content": {"via": ["example.org"], "order": "same"}
        }))
        .unwrap()
        .cast_unchecked()
    });
    let edges = crate::view::hierarchy_child_edges(&events);
    assert_eq!(
        edges
            .iter()
            .map(|edge| edge.room_id.as_str())
            .collect::<Vec<_>>(),
        ["!a:example.org", "!z:example.org"]
    );
}

#[tokio::test]
async fn event_focus_keeps_its_explicit_sync_subscription_after_unsubscribing() {
    use crate::protocol::TimelineFocusView;
    use futures_util::StreamExt;
    use matrix_sdk::{ruma::event_id, test_utils::mocks::RoomContextResponseTemplate};
    use matrix_sdk_test::{ALICE, event_factory::EventFactory};
    use wiremock::matchers::path_regex;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.event_cache().subscribe().unwrap();
    let room_id = room_id!("!focus:example.org");
    let target = event_id!("$target");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    server
        .mock_room_event_context()
        .match_event_id()
        .ok(RoomContextResponseTemplate::new(
            EventFactory::new()
                .room(room_id)
                .sender(*ALICE)
                .text_msg("target")
                .event_id(target)
                .into_event(),
        ))
        .mount()
        .await;
    let core = core(&server, client).await;
    let CommandOk::SubscribeTimeline { subscription, .. } = core
        .dispatch(Command::SubscribeTimeline {
            room_id: room_id.to_owned(),
            focus: TimelineFocusView::Event {
                event_id: target.to_owned(),
            },
            hidden_events: false,
        })
        .await
        .unwrap()
    else {
        panic!("wrong response")
    };
    Mock::given(method("POST"))
        .and(path_regex(".*sync.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"pos": "p1", "rooms": {}})))
        .mount(server.server())
        .await;
    let sync = core.sync_service().await.unwrap();
    let room_list = sync.room_list_service();
    let stream = room_list.sync();
    futures_util::pin_mut!(stream);
    stream.next().await.unwrap().unwrap();
    let requests = server.server().received_requests().await.unwrap();
    let request = requests
        .iter()
        .rev()
        .find(|request| request.method == "POST" && request.url.path().contains("sync"))
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(
        body["room_subscriptions"][room_id.as_str()]["timeline_limit"],
        20
    );
    core.dispatch(Command::Unsubscribe { subscription })
        .await
        .unwrap();
    stream.next().await.unwrap().unwrap();
    let requests = server.server().received_requests().await.unwrap();
    let request = requests
        .iter()
        .rev()
        .find(|request| request.method == "POST" && request.url.path().contains("sync"))
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(
        body["room_subscriptions"][room_id.as_str()]["timeline_limit"],
        20
    );
}

#[tokio::test]
async fn scheduled_listing_refreshes_credentials_and_omits_finalized_events() {
    use matrix_sdk::SessionTokens;
    use wiremock::matchers::header;
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .unlogged()
        .no_server_versions()
        .on_builder(matrix_sdk::ClientBuilder::handle_refresh_tokens)
        .build()
        .await;
    let mut session = matrix_sdk::test_utils::client::mock_matrix_session();
    session.tokens = SessionTokens {
        access_token: "expired".into(),
        refresh_token: Some("refresh".into()),
    };
    client
        .matrix_auth()
        .restore_session(session, matrix_sdk::store::RoomLoadSettings::default())
        .await
        .unwrap();
    Mock::given(method("GET"))
        .and(path("/_matrix/client/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"versions": ["v1.13"], "unstable_features": {"org.matrix.msc4140": true}}),
        ))
        .mount(server.server())
        .await;
    let endpoint = "/_matrix/client/unstable/org.matrix.msc4140/delayed_events";
    Mock::given(method("GET"))
        .and(path(endpoint))
        .and(header("authorization", "Bearer expired"))
        .respond_with(ResponseTemplate::new(401).set_body_json(
            json!({"errcode": "M_UNKNOWN_TOKEN", "error": "expired", "soft_logout": true}),
        ))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/refresh"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"access_token": "fresh", "refresh_token": "next"})),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let pending = json!({"delay_id": "pending", "room_id": "!room:example.org", "type": "m.room.message", "content": {"msgtype": "m.text", "body": "later", "format": "org.matrix.custom.html", "formatted_body": "<b>later</b>"}, "delay": 5000, "running_since": 1000});
    let mut finalized = pending.clone();
    finalized["delay_id"] = json!("done");
    finalized["finalised_ts"] = json!(6000);
    Mock::given(method("GET"))
        .and(path(endpoint))
        .and(header("authorization", "Bearer fresh"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"delayed_events": [pending, finalized]})),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let messages = core.scheduled_messages(None).await.unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].delay_id, "pending");
    assert_eq!(messages[0].body, "later");
}

#[tokio::test]
async fn cached_image_packs_return_without_waiting_for_room_state() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!cached-packs:example.org");
    let pack = json!({
        "type": "im.ponies.room_emotes", "state_key": "cached", "sender": "@alice:example.org",
        "event_id": "$cached-pack", "origin_server_ts": 1,
        "content": {"images": {"wave": {"url": "mxc://example.org/wave"}}}
    });
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_event(Raw::new(&pack).unwrap().cast_unchecked()),
        )
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{room_id}/state")))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(std::time::Duration::from_secs(2))
                .set_body_json(json!([pack])),
        )
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let command = serde_json::from_value(
        json!({"type": "image_packs", "room_id": room_id, "cached_only": true}),
    )
    .unwrap();
    let response = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        core.dispatch(command),
    )
    .await
    .expect("cached emotes do not wait for the server")
    .unwrap();
    let CommandOk::ImagePacks { packs, .. } = response else {
        panic!("wrong response")
    };
    assert_eq!(packs.len(), 1);
    assert_eq!(packs[0].id, "cached");
    assert!(
        !server
            .server()
            .received_requests()
            .await
            .unwrap()
            .iter()
            .any(|request| request.url.path().ends_with("/state"))
    );
}

#[tokio::test]
async fn a_pack_with_no_images_is_still_listed() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!empty-pack:example.org");
    let pack = json!({
        "type": "m.room.image_pack", "state_key": "fresh", "sender": "@alice:example.org",
        "event_id": "$empty-pack", "origin_server_ts": 1,
        "content": {"pack": {"display_name": "Fresh"}, "images": {}}
    });
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_event(Raw::new(&pack).unwrap().cast_unchecked()),
        )
        .await;
    let core = core(&server, client).await;
    let command = serde_json::from_value(
        json!({"type": "image_packs", "room_id": room_id, "cached_only": true}),
    )
    .unwrap();
    let CommandOk::ImagePacks { packs, .. } = core.dispatch(command).await.unwrap() else {
        panic!("wrong response")
    };
    assert_eq!(packs.len(), 1);
    assert_eq!(packs[0].id, "fresh");
    assert!(packs[0].images.is_empty());
}

#[tokio::test]
async fn messaging_a_user_reuses_the_dm_that_already_exists() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!existing-dm:example.org");
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder
                .add_joined_room(JoinedRoomBuilder::new(room_id))
                .add_custom_global_account_data(json!({
                    "type": "m.direct",
                    "content": { "@bob:example.org": [room_id] }
                }));
        })
        .await;
    let core = core(&server, client).await;
    let command =
        serde_json::from_value(json!({"type": "create_dm", "user_id": "@bob:example.org"}))
            .unwrap();
    let CommandOk::CreateDm { room_id: found } = core.dispatch(command).await.unwrap() else {
        panic!("wrong response")
    };
    assert_eq!(found, room_id);
}

#[tokio::test]
async fn memberships_follow_the_server_joined_rooms() {
    use matrix_sdk::RoomState;
    use matrix_sdk_test::{InvitedRoomBuilder, LeftRoomBuilder};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let stale = room_id!("!stale:example.org");
    let kept = room_id!("!kept:example.org");
    let rejoined = room_id!("!rejoined:example.org");
    let accepted = room_id!("!accepted:example.org");
    let pending = room_id!("!pending:example.org");
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder
                .add_joined_room(JoinedRoomBuilder::new(stale))
                .add_joined_room(JoinedRoomBuilder::new(kept))
                .add_left_room(LeftRoomBuilder::new(rejoined))
                .add_invited_room(InvitedRoomBuilder::new(accepted))
                .add_invited_room(InvitedRoomBuilder::new(pending));
        })
        .await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/joined_rooms"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"joined_rooms": [kept, rejoined, accepted]})),
        )
        .expect(1)
        .mount(server.server())
        .await;

    crate::rooms::reconcile_memberships(&client).await.unwrap();

    let membership = |room_id| client.get_room(room_id).unwrap().state();
    assert_eq!(membership(stale), RoomState::Left);
    assert_eq!(membership(kept), RoomState::Joined);
    assert_eq!(membership(rejoined), RoomState::Joined);
    assert_eq!(membership(accepted), RoomState::Joined);
    assert_eq!(membership(pending), RoomState::Invited);
}

#[tokio::test]
async fn our_own_membership_is_fetched_for_small_rooms_that_lack_it() {
    use matrix_sdk::ruma::events::room::member::{MembershipState, RoomMemberEventContent};
    use matrix_sdk_test::event_factory::EventFactory;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let own = client.user_id().unwrap().to_owned();
    let direct = room_id!("!direct:example.org");
    let large = room_id!("!large:example.org");
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder
                .add_joined_room(JoinedRoomBuilder::new(direct).set_joined_members_count(2))
                .add_joined_room(JoinedRoomBuilder::new(large).set_joined_members_count(500));
        })
        .await;
    let member: Raw<matrix_sdk::ruma::events::AnyStateEvent> = EventFactory::new()
        .room(direct)
        .event(RoomMemberEventContent::new(MembershipState::Join))
        .sender(&own)
        .state_key(own.as_str())
        .into_raw();
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{direct}/members")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "chunk": [member] })))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{large}/members")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "chunk": [] })))
        .expect(0)
        .mount(server.server())
        .await;

    crate::rooms::fill_own_members(&client).await.unwrap();
    crate::rooms::fill_own_members(&client).await.unwrap();

    let room = client.get_room(direct).unwrap();
    assert!(room.get_member_no_sync(&own).await.unwrap().is_some());
}

#[tokio::test]
async fn an_upgraded_room_names_its_predecessor_and_the_creators_servers() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!new:example.org");
    server.sync_room(&client, JoinedRoomBuilder::new(room_id).add_state_event(
        Raw::new(&json!({"type": "m.room.create", "state_key": "", "sender": "@alice:example.org", "event_id": "$create", "origin_server_ts": 1,
            "content": {"room_version": "12", "additional_creators": ["@bob:other.org", "@carol:example.org"],
                "predecessor": {"room_id": "!old:example.org"}}})).unwrap().cast_unchecked()
    )).await;

    let predecessor = crate::view::predecessor(&client.get_room(room_id).unwrap()).unwrap();
    assert_eq!(predecessor.room_id, "!old:example.org");
    assert_eq!(predecessor.via, ["example.org", "other.org"]);
}

#[tokio::test]
async fn a_room_without_a_predecessor_names_none() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!fresh:example.org");
    server.sync_room(&client, JoinedRoomBuilder::new(room_id).add_state_event(
        Raw::new(&json!({"type": "m.room.create", "state_key": "", "sender": "@alice:example.org", "event_id": "$create", "origin_server_ts": 1,
            "content": {"room_version": "10", "creator": "@alice:example.org"}})).unwrap().cast_unchecked()
    )).await;

    assert!(crate::view::predecessor(&client.get_room(room_id).unwrap()).is_none());
}

#[tokio::test]
async fn a_room_outside_the_list_still_has_a_summary() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!old:example.org");
    server.sync_room(&client, JoinedRoomBuilder::new(room_id).add_state_event(
        Raw::new(&json!({"type": "m.room.tombstone", "state_key": "", "sender": "@alice:example.org", "event_id": "$grave", "origin_server_ts": 1,
            "content": {"body": "moved", "replacement_room": "!new:example.org"}})).unwrap().cast_unchecked()
    )).await;
    let core = core(&server, client).await;

    let CommandOk::RoomSummary { room } = core
        .dispatch(Command::RoomSummary {
            room_id: room_id.to_owned(),
        })
        .await
        .unwrap()
    else {
        panic!("wrong response")
    };
    assert_eq!(room.room_id, room_id);
    assert!(room.is_tombstoned);
}

#[tokio::test]
#[allow(clippy::unwrap_used)]
async fn an_original_streams_with_progress_and_is_cached() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    let bytes = vec![7_u8; 256 * 1024];
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/download/example.org/original",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
        .expect(1)
        .mount(server.server())
        .await;
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, mut events) = Core::new("helpers-test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".into(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });
    let source = "mxc://example.org/original".to_owned();

    assert_eq!(
        core.media_thumbnail(source.clone(), 0, 0).await.unwrap(),
        bytes
    );
    assert_eq!(
        core.media_thumbnail(source.clone(), 0, 0).await.unwrap(),
        bytes
    );

    let mut last = None;
    while let Ok(event) = events.try_recv() {
        if let CoreEvent::MediaProgress {
            source: key,
            current,
            total,
        } = event
        {
            assert_eq!(key, source);
            last = Some((current, total));
        }
    }
    let length = u64::try_from(bytes.len()).unwrap();
    assert_eq!(last, Some((length, length)));
}

#[tokio::test]
#[allow(clippy::unwrap_used)]
async fn an_encrypted_thumbnail_downloads_the_original() {
    use std::io::Read;

    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    let plaintext = vec![3_u8; 64 * 1024];
    let mut cursor = std::io::Cursor::new(plaintext.clone());
    let mut encryptor = matrix_sdk_base::crypto::AttachmentEncryptor::new(&mut cursor);
    let mut ciphertext = Vec::new();
    encryptor.read_to_end(&mut ciphertext).unwrap();
    let keys = encryptor.finish();
    let file = matrix_sdk::ruma::events::room::EncryptedFile::new(
        matrix_sdk::ruma::OwnedMxcUri::from("mxc://example.org/sealed"),
        keys.encryption_info,
        keys.hashes,
    );
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v1/media/download/example.org/sealed"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(ciphertext))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/thumbnail/example.org/sealed",
        ))
        .respond_with(ResponseTemplate::new(404))
        .expect(0)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let source = serde_json::to_string(&matrix_sdk::ruma::events::room::MediaSource::Encrypted(
        Box::new(file),
    ))
    .unwrap();

    assert_eq!(
        core.media_thumbnail(source.clone(), 800, 600)
            .await
            .unwrap(),
        plaintext
    );
    assert_eq!(core.media_thumbnail(source, 0, 0).await.unwrap(), plaintext);
}

#[tokio::test]
#[allow(clippy::unwrap_used)]
async fn forgotten_media_is_fetched_again() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/download/example.org/forgotten",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![1_u8; 16]))
        .expect(2)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let source = "mxc://example.org/forgotten".to_owned();

    core.media_thumbnail(source.clone(), 0, 0).await.unwrap();
    core.media_thumbnail(source.clone(), 0, 0).await.unwrap();
    core.forget_media(source.clone()).await.unwrap();
    core.media_thumbnail(source, 0, 0).await.unwrap();
}

#[allow(clippy::unwrap_used)]
async fn space_child_writes(
    child: Option<serde_json::Value>,
    command: Command,
) -> Vec<serde_json::Value> {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let space_id = room_id!("!space:example.org");
    let mut space = JoinedRoomBuilder::new(space_id);
    if let Some(content) = child {
        space = space.add_state_event(
            Raw::new(&json!({
                "type": "m.space.child", "state_key": "!child:example.org", "sender": "@alice:example.org",
                "event_id": "$child", "origin_server_ts": 1, "content": content
            }))
            .unwrap()
            .cast_unchecked(),
        );
    }
    server.sync_room(&client, space).await;
    Mock::given(method("PUT"))
        .and(wiremock::matchers::path_regex(
            r"^/_matrix/client/v3/rooms/[^/]+/state/m\.space\.child/",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$written"})))
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    core.dispatch(command).await.unwrap();

    server
        .server()
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|request| request.method.as_str() == "PUT")
        .map(|request| serde_json::from_slice(&request.body).unwrap())
        .collect()
}

fn add_child() -> Command {
    Command::AddToSpace {
        space_id: room_id!("!space:example.org").to_owned(),
        room_id: room_id!("!child:example.org").to_owned(),
        suggested: None,
    }
}

#[tokio::test]
async fn adding_a_listed_child_keeps_its_edge() {
    let writes = space_child_writes(
        Some(json!({"via": ["other.org"], "order": "b", "suggested": true})),
        add_child(),
    )
    .await;

    assert!(writes.is_empty(), "rewrote the edge: {writes:?}");
}

#[tokio::test]
async fn adding_a_new_child_routes_through_our_server() {
    let writes = space_child_writes(None, add_child()).await;

    assert_eq!(writes, [json!({"via": ["localhost"]})]);
}

#[tokio::test]
async fn adding_a_delisted_child_lists_it_again() {
    let writes = space_child_writes(Some(json!({})), add_child()).await;

    assert_eq!(writes, [json!({"via": ["localhost"]})]);
}

#[tokio::test]
async fn adding_a_suggested_child_marks_it() {
    let writes = space_child_writes(
        None,
        Command::AddToSpace {
            space_id: room_id!("!space:example.org").to_owned(),
            room_id: room_id!("!child:example.org").to_owned(),
            suggested: Some(true),
        },
    )
    .await;

    assert_eq!(writes, [json!({"via": ["localhost"], "suggested": true})]);
}

#[tokio::test]
async fn suggesting_a_child_keeps_its_via_and_order() {
    let writes = space_child_writes(
        Some(json!({"via": ["other.org"], "order": "b"})),
        Command::SetSpaceChildSuggested {
            space_id: room_id!("!space:example.org").to_owned(),
            room_id: room_id!("!child:example.org").to_owned(),
            suggested: true,
        },
    )
    .await;

    assert_eq!(
        writes,
        [json!({"via": ["other.org"], "order": "b", "suggested": true})]
    );
}

#[tokio::test]
async fn reordering_a_child_keeps_its_via_and_suggestion() {
    let writes = space_child_writes(
        Some(json!({"via": ["other.org"], "order": "b", "suggested": true})),
        Command::SetSpaceChildOrder {
            space_id: room_id!("!space:example.org").to_owned(),
            room_id: room_id!("!child:example.org").to_owned(),
            order: Some("a".to_owned()),
        },
    )
    .await;

    assert_eq!(
        writes,
        [json!({"via": ["other.org"], "order": "a", "suggested": true})]
    );
}

#[tokio::test]
async fn forgetting_an_invalid_uri_is_refused() {
    let (core, _events) = Core::new("helpers-test", Box::new(MemorySessionStore::default()));

    assert!(matches!(
        core.forget_media("not-a-uri".to_owned()).await,
        Err(CommandErr::InvalidMedia)
    ));
}

#[allow(clippy::unwrap_used)]
async fn sync_secret_storage_key(
    server: &MatrixMockServer,
    client: &matrix_sdk::Client,
    key: &matrix_sdk_base::crypto::secret_storage::SecretStorageKey,
) {
    let content = serde_json::to_value(key.event_content()).unwrap();
    let key_id = key.key_id().to_owned();
    server
        .mock_sync()
        .ok_and_run(client, |builder| {
            builder
                .add_custom_global_account_data(json!({
                    "type": "m.secret_storage.default_key",
                    "content": {"key": key_id},
                }))
                .add_custom_global_account_data(json!({
                    "type": format!("m.secret_storage.key.{key_id}"),
                    "content": content,
                }));
        })
        .await;
}

#[tokio::test]
async fn encryption_status_reports_a_passphrase_on_the_default_key() {
    use matrix_sdk_base::crypto::secret_storage::SecretStorageKey;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    sync_secret_storage_key(
        &server,
        &client,
        &SecretStorageKey::new_from_passphrase("correct horse"),
    )
    .await;
    assert!(
        crate::verification::encryption_status(&client)
            .await
            .recovery_passphrase
    );

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    sync_secret_storage_key(&server, &client, &SecretStorageKey::new()).await;
    assert!(
        !crate::verification::encryption_status(&client)
            .await
            .recovery_passphrase
    );
}

#[tokio::test]
async fn recover_identity_accepts_the_passphrase_as_well_as_the_key() {
    use matrix_sdk_base::crypto::secret_storage::SecretStorageKey;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let key = SecretStorageKey::new_from_passphrase("correct horse");
    let user_id = client.user_id().unwrap().to_owned();
    server
        .mock_get_default_secret_storage_key()
        .ok(&user_id, key.key_id())
        .mount()
        .await;
    server
        .mock_get_secret_storage_key()
        .ok(&user_id, key.event_content())
        .mount()
        .await;
    let core = core(&server, client).await;
    let recover = async |recovery_key: String| {
        core.dispatch(Command::RecoverIdentity { recovery_key })
            .await
    };

    assert!(matches!(
        recover("wrong horse".to_owned()).await,
        Err(CommandErr::Denied)
    ));
    assert!(matches!(
        recover("correct horse".to_owned()).await,
        Err(CommandErr::Failed { .. })
    ));
    assert!(matches!(
        recover(key.to_base58()).await,
        Err(CommandErr::Failed { .. })
    ));
}

async fn mount_identity_reset_endpoints(server: &MatrixMockServer) {
    use wiremock::matchers::path_regex;

    let not_found = || {
        ResponseTemplate::new(404)
            .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "absent"}))
    };
    Mock::given(method("GET"))
        .and(path_regex(r"/room_keys/version$"))
        .respond_with(not_found())
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path_regex(r"/room_keys/version$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"version": "1"})))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/room_keys/keys$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"etag": "1", "count": 0})))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/account_data/"))
        .respond_with(not_found())
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/account_data/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(server.server())
        .await;
    server.mock_upload_keys().ok().mount().await;
    server.mock_query_keys().ok().mount().await;
    server
        .mock_upload_cross_signing_signatures()
        .ok()
        .mount()
        .await;
}

#[tokio::test]
async fn an_identity_reset_without_authentication_returns_the_new_key() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    mount_identity_reset_endpoints(&server).await;
    server.mock_upload_cross_signing_keys().ok().mount().await;
    let core = core(&server, client).await;

    let Ok(CommandOk::ResetIdentity {
        step: crate::protocol::IdentityResetStep::Done { recovery_key },
    }) = core.dispatch(Command::ResetIdentity).await
    else {
        panic!("the reset needed no authentication")
    };
    assert!(!recovery_key.is_empty());
}

#[tokio::test]
async fn an_identity_reset_retries_a_wrong_password_and_returns_the_new_key() {
    use matrix_sdk::ruma::api::client::uiaa::{AuthData, Password, UserIdentifier};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    mount_identity_reset_endpoints(&server).await;
    let user_id = client.user_id().unwrap().to_owned();
    let password = |secret: &str| {
        let mut auth = Password::new(
            UserIdentifier::Matrix(user_id.clone().into()),
            secret.into(),
        );
        auth.session = Some("oFIJVvtEOCKmRUTYKTYIIPHL".into());
        AuthData::Password(auth)
    };
    server
        .mock_upload_cross_signing_keys()
        .expect_uiaa_auth_data(&password("hunter2"))
        .ok()
        .with_priority(1)
        .expect(1)
        .mount()
        .await;
    server
        .mock_upload_cross_signing_keys()
        .expect_uiaa_auth_data(&password("wrong"))
        .uiaa_invalid_password()
        .with_priority(2)
        .expect(1)
        .mount()
        .await;
    server
        .mock_upload_cross_signing_keys()
        .uiaa()
        .with_priority(3)
        .expect(1)
        .mount()
        .await;
    let core = core(&server, client).await;

    assert!(matches!(
        core.dispatch(Command::ResetIdentity).await,
        Ok(CommandOk::ResetIdentity {
            step: crate::protocol::IdentityResetStep::Password
        })
    ));
    assert!(matches!(
        core.dispatch(Command::ContinueIdentityReset {
            password: Some("wrong".into())
        })
        .await,
        Err(CommandErr::Denied)
    ));
    let Ok(CommandOk::ContinueIdentityReset { recovery_key }) = core
        .dispatch(Command::ContinueIdentityReset {
            password: Some("hunter2".into()),
        })
        .await
    else {
        panic!("the right password completes the reset")
    };
    assert!(!recovery_key.is_empty());
    assert!(matches!(
        core.dispatch(Command::ContinueIdentityReset { password: None })
            .await,
        Err(CommandErr::Unavailable)
    ));
}

#[tokio::test]
async fn a_cancelled_oauth_identity_reset_hands_back_no_key() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    mount_identity_reset_endpoints(&server).await;
    server
        .mock_upload_cross_signing_keys()
        .uiaa_unstable_oauth()
        .mount()
        .await;
    let core = core(&server, client).await;

    let Ok(CommandOk::ResetIdentity {
        step: crate::protocol::IdentityResetStep::Approve { url },
    }) = core.dispatch(Command::ResetIdentity).await
    else {
        panic!("an OAuth account is sent to approve the reset")
    };
    assert!(url.contains("org.matrix.cross_signing_reset"));

    let (waiting, ()) = tokio::join!(
        core.dispatch(Command::ContinueIdentityReset { password: None }),
        async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            core.dispatch(Command::CancelIdentityReset).await.unwrap();
        }
    );
    assert!(matches!(waiting, Err(CommandErr::Unavailable)));
}

#[tokio::test]
async fn an_approved_oauth_identity_reset_completes_its_session() {
    use wiremock::matchers::{body_partial_json, path_regex};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    mount_identity_reset_endpoints(&server).await;
    Mock::given(method("POST"))
        .and(path_regex(r"/keys/device_signing/upload$"))
        .and(body_partial_json(
            json!({"auth": {"type": "m.oauth", "session": "approved"}}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .with_priority(1)
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path_regex(r"/keys/device_signing/upload$"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "session": "approved",
            "flows": [{"stages": ["m.oauth"]}],
            "params": {"m.oauth": {"url": "https://auth.example.org/approve"}},
        })))
        .with_priority(2)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    let Ok(CommandOk::ResetIdentity {
        step: crate::protocol::IdentityResetStep::Approve { url },
    }) = core.dispatch(Command::ResetIdentity).await
    else {
        panic!("an OAuth account is sent to approve the reset")
    };
    assert_eq!(url, "https://auth.example.org/approve");

    let Ok(CommandOk::ContinueIdentityReset { recovery_key }) = core
        .dispatch(Command::ContinueIdentityReset { password: None })
        .await
    else {
        panic!("the approved session completes the reset")
    };
    assert!(!recovery_key.is_empty());
}

#[tokio::test]
#[allow(clippy::unwrap_used)]
async fn profile_updates_send_the_chosen_msc4466_propagation() {
    use crate::protocol::ProfilePropagationView;
    use wiremock::matchers::{path_regex, query_param, query_param_is_missing};

    const PROPAGATE_TO: &str = "computer.gingershaped.msc4466.propagate_to";
    async fn expect_put(
        server: &MatrixMockServer,
        field: &str,
        query: impl wiremock::Match + 'static,
    ) {
        Mock::given(method("PUT"))
            .and(path_regex(format!("/profile/[^/]+/{field}$")))
            .and(query)
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
    }
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().no_server_versions().build().await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "versions": ["v1.13"],
            "unstable_features": {"computer.gingershaped.msc4466": true}
        })))
        .mount(server.server())
        .await;
    expect_put(&server, "displayname", query_param(PROPAGATE_TO, "none")).await;
    expect_put(
        &server,
        "avatar_url",
        query_param(PROPAGATE_TO, "unchanged"),
    )
    .await;
    expect_put(&server, "displayname", query_param_is_missing(PROPAGATE_TO)).await;
    let core = core(&server, client).await;

    core.dispatch(Command::SetDisplayName {
        name: Some("Quiet".to_owned()),
        propagate_to: ProfilePropagationView::None,
    })
    .await
    .unwrap();
    core.dispatch(Command::SetAvatarUrl {
        url: Some("mxc://example.org/avatar".to_owned()),
        propagate_to: ProfilePropagationView::Unchanged,
    })
    .await
    .unwrap();
    core.dispatch(Command::SetDisplayName {
        name: Some("Loud".to_owned()),
        propagate_to: ProfilePropagationView::All,
    })
    .await
    .unwrap();
}
