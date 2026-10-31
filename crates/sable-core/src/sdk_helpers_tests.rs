use crate::api::timeline::TimelineFocusView;
use crate::api::{account::ProfilePropagationView, rooms::RoomKind};
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
    matchers::{method, path, path_regex},
};

use crate::{
    Core,
    api::Handler,
    api::encryption::{
        CancelIdentityResetParams, ContinueIdentityResetParams, RecoverIdentityParams,
        RenameDeviceParams, ResetIdentityParams,
    },
    api::packs::{ListAllParams, ListOk, ListParams},
    api::spaces::{
        AddParams, SetChildOrderParams, SetChildSuggestedParams, SetSidebarParams, SidebarParams,
    },
    api::timeline::{
        SubscribeOk, SubscribeParams, SubscribeRoomListOk, SubscribeRoomListParams,
        UnsubscribeParams,
    },
    protocol::{CoreEvent, IdentityResetStep, RpcError},
    session::Session,
    store::MemorySessionStore,
};

async fn core(server: &MatrixMockServer, client: matrix_sdk::Client) -> Arc<Core> {
    core_with_events(server, client).await.0
}

#[tokio::test]
async fn preview_thumbnails_are_reuploaded_and_encrypted_for_encrypted_rooms() {
    use matrix_sdk::ruma::events::room::EncryptedFile;

    for encrypted in [false, true] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!preview:example.org");
        server.sync_joined_room(&client, room_id).await;
        server
            .mock_authenticated_media_config()
            .ok_default()
            .mount()
            .await;
        if encrypted {
            server
                .mock_room_state_encryption()
                .encrypted()
                .mount()
                .await;
        } else {
            server.mock_room_state_encryption().plain().mount().await;
        }
        let bytes = b"preview thumbnail";
        Mock::given(method("GET"))
            .and(path(
                "/_matrix/client/v1/media/download/example.org/temporary",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/_matrix/media/v3/upload"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "content_uri": "mxc://example.org/persistent",
            })))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        let preview = crate::link_previews::url_preview("https://example.org".to_owned(), &json!({
            "og:title": "Example", "og:image": "mxc://example.org/temporary", "og:image:type": "image/png",
        })).unwrap();
        let previews = [preview];
        let images = core
            .prepare_preview_images(&room_id.to_owned(), &previews)
            .await;
        let bundles =
            crate::link_previews::bundled_link_previews(&previews, &images, true).unwrap();
        let legacy =
            crate::link_previews::bundled_link_previews(&previews, &images, false).unwrap();
        let requests = server.server().received_requests().await.unwrap();
        let upload = requests
            .iter()
            .find(|request| request.url.path() == "/_matrix/media/v3/upload")
            .unwrap();
        if encrypted {
            assert!(bundles[0].get("og:image").is_none());
            assert!(legacy[0].get("og:image").is_none());
            assert_eq!(
                legacy[0]["beeper:image:encryption"],
                bundles[0]["matrix:image:encrypted"]
            );
            assert!(legacy[0].get("matrix:image:encrypted").is_none());
            assert!(bundles[0].get("beeper:image:encryption").is_none());
            let file: EncryptedFile =
                serde_json::from_value(bundles[0]["matrix:image:encrypted"].clone()).unwrap();
            assert_eq!(file.url.as_str(), "mxc://example.org/persistent");
            assert_ne!(upload.body, bytes);
            let mut cursor = std::io::Cursor::new(&upload.body);
            let mut reader =
                matrix_sdk_base::crypto::AttachmentDecryptor::new(&mut cursor, file.into())
                    .unwrap();
            let mut decrypted = Vec::new();
            std::io::Read::read_to_end(&mut reader, &mut decrypted).unwrap();
            assert_eq!(decrypted, bytes);
        } else {
            assert_eq!(bundles[0]["og:image"], "mxc://example.org/persistent");
            assert_eq!(upload.body, bytes);
        }
    }
}

#[tokio::test]
async fn preview_thumbnail_failures_omit_images() {
    for oversized in [false, true] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!preview:example.org");
        server.sync_joined_room(&client, room_id).await;
        server
            .mock_authenticated_media_config()
            .ok_default()
            .mount()
            .await;
        server
            .mock_room_state_encryption()
            .encrypted()
            .mount()
            .await;
        let bytes = vec![7; if oversized { 1024 * 1024 + 1 } else { 12 }];
        Mock::given(method("GET"))
            .and(path(
                "/_matrix/client/v1/media/download/example.org/temporary",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/_matrix/media/v3/upload"))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                "errcode": "M_FORBIDDEN", "error": "Uploads disabled",
            })))
            .expect(u64::from(!oversized))
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        let preview = crate::link_previews::url_preview(
            "https://example.org".to_owned(),
            &json!({
                "og:title": "Example", "og:image": "mxc://example.org/temporary",
                "og:image:type": "image/png", "og:image:width": 640,
            }),
        )
        .unwrap();
        let previews = [preview];
        let images = core
            .prepare_preview_images(&room_id.to_owned(), &previews)
            .await;
        assert!(images.is_empty());
        for stable in [false, true] {
            let bundles =
                crate::link_previews::bundled_link_previews(&previews, &images, stable).unwrap();
            assert_eq!(bundles[0]["og:title"], "Example");
            assert!(bundles[0].get("og:image").is_none());
            assert!(bundles[0].get("og:image:type").is_none());
            assert!(bundles[0].get("og:image:width").is_none());
            assert!(bundles[0].get("matrix:image:encrypted").is_none());
            assert!(bundles[0].get("beeper:image:encryption").is_none());
        }
    }
}

#[expect(clippy::unwrap_used, reason = "test code")]
async fn core_with_events(
    server: &MatrixMockServer,
    client: matrix_sdk::Client,
) -> (Arc<Core>, tokio::sync::mpsc::UnboundedReceiver<CoreEvent>) {
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, events) = Core::new("helpers-test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".into(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });
    (core, events)
}

fn persona_json(id: &str, display_name: &str, avatar_url: Option<&str>) -> serde_json::Value {
    json!({
        "id": id,
        "display_name": display_name,
        "avatar_url": avatar_url,
        "pronouns": [],
        "color_on_light": null,
        "color_on_dark": null,
        "triggers": [],
        "pluralkit": null,
        "last_used": null,
        "alternate_avatars": null
    })
}

async fn persona_core(server: &MatrixMockServer, response: ResponseTemplate) -> Arc<Core> {
    let client = server.client_builder().build().await;
    let catalog_type = "fi.mau.msc4461.per_message_profiles.v3";
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_custom_global_account_data(json!({
                "type": catalog_type,
                "content": { "profiles": [{ "id": "stale", "displayname": "Stale" }] }
            }));
        })
        .await;
    Mock::given(method("GET"))
        .and(path_regex(format!(
            "/_matrix/client/v3/user/.*/account_data/{catalog_type}"
        )))
        .respond_with(response)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            "/_matrix/client/v3/user/.*/account_data/fyi.cisnt.permessageprofile.*",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(server.server())
        .await;
    core(server, client).await
}

#[tokio::test]
async fn persona_save_preserves_the_server_catalog_before_sync() {
    use crate::api::personas::SaveParams;

    let server = MatrixMockServer::new().await;
    let core = persona_core(
        &server,
        ResponseTemplate::new(200).set_body_json(json!({
            "profiles": [{ "id": "remote", "displayname": "Remote" }]
        })),
    )
    .await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    let params = serde_json::from_value::<SaveParams>(json!({
        "persona": persona_json("new", "New", None),
        "base_persona": persona_json("new", "New", None)
    }))
    .unwrap();
    let saved = core.run(params).await.unwrap();
    assert_eq!(saved.len(), 2);
    assert_eq!(saved[0].id, "remote");
    assert_eq!(saved[1].id, "new");
    let requests = server.server().received_requests().await.unwrap();
    let write = requests
        .iter()
        .find(|request| request.method == "PUT")
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&write.body).unwrap();
    assert_eq!(body["profiles"][0]["id"], "remote");
    assert_eq!(body["profiles"][1]["id"], "new");
}

#[tokio::test]
async fn persona_save_merges_a_stale_edit_with_the_server_persona() {
    use crate::api::personas::SaveParams;

    let server = MatrixMockServer::new().await;
    let core = persona_core(
        &server,
        ResponseTemplate::new(200).set_body_json(json!({
            "profiles": [{
                "id": "kris",
                "displayname": "Kris",
                "avatar_url": "mxc://example.org/new"
            }]
        })),
    )
    .await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;

    let params = serde_json::from_value::<SaveParams>(json!({
        "persona": persona_json("kris", "Kris Renamed", Some("mxc://example.org/old")),
        "base_persona": persona_json("kris", "Kris", Some("mxc://example.org/old")),
        "previous_id": "kris"
    }))
    .unwrap();

    let saved = core.run(params).await.unwrap();

    assert_eq!(saved[0].display_name, "Kris Renamed");
    assert_eq!(
        saved[0].avatar_url.as_deref(),
        Some("mxc://example.org/new")
    );
}

#[tokio::test]
async fn persona_remove_and_reorder_read_the_server_catalog() {
    use crate::api::personas::{RemoveParams, ReorderParams};

    let server = MatrixMockServer::new().await;
    let core = persona_core(&server, ResponseTemplate::new(200).set_body_json(json!({
        "profiles": [{ "id": "remote", "displayname": "Remote" }, { "id": "removed", "displayname": "Removed" }]
    }))).await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(2)
        .mount(server.server())
        .await;

    let removed = core
        .run(RemoveParams {
            id: "removed".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].id, "remote");
    let reordered = core
        .run(ReorderParams {
            ids: vec!["removed".to_owned()],
        })
        .await
        .unwrap();
    assert_eq!(reordered.len(), 2);
    assert_eq!(reordered[0].id, "removed");
    assert_eq!(reordered[1].id, "remote");
}

#[tokio::test]
async fn persona_mutations_do_not_write_when_the_catalog_read_fails() {
    use crate::api::personas::{RemoveParams, ReorderParams};

    let server = MatrixMockServer::new().await;
    let core = persona_core(
        &server,
        ResponseTemplate::new(403).set_body_json(json!({
            "errcode": "M_FORBIDDEN", "error": "Cannot read catalog"
        })),
    )
    .await;
    Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(0)
        .mount(server.server())
        .await;

    core.run(RemoveParams {
        id: "stale".to_owned(),
    })
    .await
    .unwrap_err();
    core.run(ReorderParams {
        ids: vec!["stale".to_owned()],
    })
    .await
    .unwrap_err();
}

#[tokio::test]
async fn room_list_keeps_joined_rooms_redirected_to_a_joined_successor() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let old_id = room_id!("!old:example.org");
    let new_id = room_id!("!new:example.org");
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder
                .add_joined_room(
                    JoinedRoomBuilder::new(old_id).add_state_event(
                        Raw::new(&json!({
                            "type": "m.room.tombstone", "state_key": "",
                            "sender": "@alice:example.org", "event_id": "$grave",
                            "origin_server_ts": 1,
                            "content": {"body": "moved", "replacement_room": new_id}
                        }))
                        .unwrap()
                        .cast_unchecked(),
                    ),
                )
                .add_joined_room(JoinedRoomBuilder::new(new_id));
        })
        .await;
    let (core, mut events) = core_with_events(&server, client).await;
    let SubscribeRoomListOk { subscription, .. } =
        core.run(SubscribeRoomListParams {}).await.unwrap();
    let diffs = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(CoreEvent::RoomListDiff {
                subscription: current,
                diffs,
            }) = events.recv().await
                && current == subscription
            {
                break diffs;
            }
        }
    })
    .await
    .unwrap();
    let rooms = diffs
        .into_iter()
        .find_map(|diff| match diff {
            crate::protocol::VectorDiff::Reset { values } => Some(values),
            _ => None,
        })
        .expect("initial room list snapshot");
    let old = rooms.iter().find(|room| room.room_id == old_id).unwrap();
    assert!(old.is_tombstoned);
    assert!(matches!(old.state, crate::protocol::RoomStateView::Joined));
    assert!(rooms.iter().any(|room| room.room_id == new_id));
    core.run(UnsubscribeParams { subscription }).await.unwrap();
}

#[tokio::test]
async fn a_synced_room_rule_reaches_the_listed_room() {
    use matrix_sdk::ruma::push::{NewPushRule, NewSimplePushRule, Ruleset};
    use matrix_sdk_test::event_factory::EventFactory;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!chatty:example.org");
    server.sync_joined_room(&client, room_id).await;
    let (core, mut events) = core_with_events(&server, client.clone()).await;
    let SubscribeRoomListOk { subscription, .. } =
        core.run(SubscribeRoomListParams {}).await.unwrap();
    let mut next_room = async || {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Some(CoreEvent::RoomListDiff {
                    subscription: current,
                    diffs,
                }) = events.recv().await
                    && current == subscription
                    && let Some(room) = diffs.into_iter().find_map(|diff| match diff {
                        crate::protocol::VectorDiff::Reset { values } => values.into_iter().next(),
                        crate::protocol::VectorDiff::Set { value, .. } => Some(value),
                        _ => None,
                    })
                {
                    break room;
                }
            }
        })
        .await
        .unwrap()
    };
    assert_eq!(next_room().await.notification.room, None);

    let mut rules = Ruleset::server_default(client.user_id().unwrap());
    rules
        .insert(
            NewPushRule::Room(NewSimplePushRule::new(room_id.to_owned(), vec![])),
            None,
            None,
        )
        .unwrap();
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_global_account_data(EventFactory::new().push_rules(rules));
        })
        .await;

    assert_eq!(
        next_room().await.notification.room,
        Some(crate::protocol::NotificationModeView::Mentions)
    );
    core.run(UnsubscribeParams { subscription }).await.unwrap();
}

#[tokio::test]
async fn room_members_use_cached_or_fetched_power_levels() {
    use matrix_sdk::ruma::user_id;
    use matrix_sdk_test::event_factory::EventFactory;

    for (version, cached, status, valid) in [
        ("10", false, 200, true),
        ("10", true, 200, true),
        ("10", false, 404, true),
        ("10", false, 403, true),
        ("10", false, 200, false),
        ("12", false, 200, true),
    ] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!members:example.org");
        let admin = user_id!("@admin:example.org");
        let moderator = user_id!("@moderator:example.org");
        let factory = EventFactory::new().room(room_id).sender(admin);
        let levels = json!({"users": {admin: 100, moderator: 50}});
        let members = vec![
            factory.member(admin).into_raw(),
            factory.member(moderator).into_raw(),
        ];
        let mut builder = JoinedRoomBuilder::new(room_id)
            .add_state_bulk(members)
            .add_state_event(factory.create(admin, version.try_into().unwrap()));
        if cached {
            builder = builder.add_state_event(
                Raw::new(&json!({
                    "type": "m.room.power_levels", "state_key": "", "sender": admin,
                    "event_id": "$levels", "origin_server_ts": 1, "content": levels
                }))
                .unwrap()
                .cast_unchecked(),
            );
        }
        server.sync_room(&client, builder).await;
        server
            .mock_get_members()
            .ok(vec![
                factory.member(admin).into_raw(),
                factory.member(moderator).into_raw(),
            ])
            .mount()
            .await;
        let response = match status {
            403 => json!({"errcode": "M_FORBIDDEN", "error": "Forbidden"}),
            404 => json!({"errcode": "M_NOT_FOUND", "error": "No power levels"}),
            _ if !valid => json!({"users": {moderator: "invalid"}}),
            _ => levels,
        };
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room_id}/state/m.room.power_levels/"
            )))
            .respond_with(ResponseTemplate::new(status).set_body_json(response))
            .expect(u64::from(!cached))
            .mount(server.server())
            .await;

        let room = client.get_room(room_id).unwrap();
        let core = core(&server, client).await;
        let members = core
            .run(crate::api::members::ListParams {
                room_id: room_id.to_owned(),
                memberships: vec![],
            })
            .await
            .unwrap();
        let admin_level = if version == "12" {
            9_007_199_254_740_992
        } else {
            100
        };
        let moderator_level = if status == 200 && valid { 50 } else { 0 };
        for (user_id, level) in [(admin, admin_level), (moderator, moderator_level)] {
            let member = members
                .iter()
                .find(|member| member.user_id == user_id)
                .unwrap();
            assert_eq!(
                member.power_level, level,
                "{version}, cached={cached}, status={status}, valid={valid}, {user_id}"
            );
        }
        if cached || status != 200 || !valid {
            let expected = room
                .members_no_sync(matrix_sdk::RoomMemberships::JOIN)
                .await
                .unwrap();
            let expected: Vec<_> = expected.iter().map(crate::view::member_view).collect();
            assert_eq!(
                serde_json::to_value(members).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
        }
    }
}

#[tokio::test]
async fn device_rename_updates_pusher_state() {
    use wiremock::matchers::body_json;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let device_id = client.device_id().unwrap().to_owned();
    Mock::given(method("PUT"))
        .and(path(format!("/_matrix/client/v3/devices/{device_id}")))
        .and(body_json(json!({"display_name": "Work phone"})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/devices"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "devices": [{"device_id": device_id, "display_name": "Work phone"}]
        })))
        .expect(1)
        .mount(server.server())
        .await;
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, mut events) = Core::new("rename-test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".into(),
        client,
        sync_service,
        homeserver: server.uri(),
        oauth: false,
    });

    core.run(RenameDeviceParams {
        device_id: device_id.clone(),
        display_name: "Work phone".to_owned(),
    })
    .await
    .unwrap();

    let CoreEvent::DevicesChanged { devices } = events.try_recv().unwrap() else {
        panic!("expected refreshed devices after renaming");
    };
    let device = devices.iter().find(|device| device.is_own).unwrap();
    assert_eq!(device.device_id, device_id);
    assert_eq!(device.display_name.as_deref(), Some("Work phone"));
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
async fn local_devices_never_ask_the_server() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/devices"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"devices": []})))
        .expect(0)
        .mount(server.server())
        .await;
    let devices = crate::verification::local_own_devices(&client).await;
    let own = devices.iter().find(|device| device.is_own).unwrap();
    assert_eq!(Some(own.device_id.as_ref()), client.device_id());
    assert!(own.has_keys);
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
    let ListOk { packs, .. } = core
        .run(ListParams {
            room_id: room_id.to_owned(),
            cached_only: false,
        })
        .await
        .unwrap();
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
    crate::view::enrich_room_batch(
        &[VectorDiff::Set {
            index: 0,
            value: item.clone(),
        }],
        &mut cache,
    )
    .await;
    let summary =
        crate::view::room_list_item(&item, &cache, &matrix_sdk::ruma::push::Ruleset::new());
    assert_eq!(summary.room_kind, Some(RoomKind::Space));
    assert!(!summary.is_tombstoned);
}

#[tokio::test]
async fn unreadable_space_children_keep_the_last_edges() {
    let server = MatrixMockServer::new().await;
    let store = tempfile::tempdir().unwrap();
    let client = server
        .client_builder()
        .on_builder(|builder| builder.sqlite_store(store.path(), None))
        .build()
        .await;
    let room_id = room_id!("!space:example.org");
    let state = |kind: &str, key: &str, content: serde_json::Value| {
        Raw::new(
            &json!({"type": kind, "state_key": key, "sender": "@alice:example.org",
            "event_id": format!("${kind}{key}"), "origin_server_ts": 1, "content": content}),
        )
        .unwrap()
        .cast_unchecked()
    };
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_event(state(
                    "m.room.create",
                    "",
                    json!({"type": "m.space", "room_version": "10", "creator": "@alice:example.org"}),
                ))
                .add_state_event(state(
                    "m.space.child",
                    "!a:example.org",
                    json!({"via": ["example.org"]}),
                ))
                .add_state_event(state(
                    "m.space.child",
                    "!b:example.org",
                    json!({"via": ["example.org"]}),
                )),
        )
        .await;
    let item = RoomListItem::from(client.get_room(room_id).unwrap());
    let diffs = [VectorDiff::Set {
        index: 0,
        value: item,
    }];
    let mut cache = HashMap::new();
    crate::view::enrich_room_batch(&diffs, &mut cache).await;
    assert_eq!(cache[room_id].children.len(), 2);
    assert!(!cache[room_id].children_stale);

    rusqlite::Connection::open(store.path().join("matrix-sdk-state.sqlite3"))
        .unwrap()
        .execute_batch("ALTER TABLE state_event RENAME TO state_event_gone")
        .unwrap();
    crate::view::enrich_room_batch(&diffs, &mut cache).await;

    assert_eq!(cache[room_id].children.len(), 2);
    assert!(cache[room_id].children_stale);
}

#[expect(clippy::unwrap_used, reason = "test code")]
async fn space_client(server: &MatrixMockServer, store: &std::path::Path) -> matrix_sdk::Client {
    let client = server
        .client_builder()
        .on_builder(|builder| builder.sqlite_store(store, None))
        .build()
        .await;
    let state = |kind: &str, key: &str, content: serde_json::Value| {
        Raw::new(&json!({
            "type": kind, "state_key": key, "sender": "@alice:example.org",
            "event_id": format!("${kind}{key}"), "origin_server_ts": 1, "content": content
        }))
        .unwrap()
        .cast_unchecked()
    };
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id!("!space:example.org"))
                .add_state_event(state(
                    "m.room.create",
                    "",
                    json!({"type": "m.space", "room_version": "10", "creator": "@alice:example.org"}),
                ))
                .add_state_event(state(
                    "m.space.child",
                    "!child:example.org",
                    json!({"via": ["example.org"]}),
                )),
        )
        .await;
    client
}

#[expect(clippy::unwrap_used, reason = "test code")]
async fn next_room_list_diff(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<CoreEvent>,
    subscription: crate::protocol::SubscriptionId,
) -> Vec<crate::protocol::VectorDiff<crate::protocol::RoomListItemView>> {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(CoreEvent::RoomListDiff {
                subscription: current,
                diffs,
            }) = events.recv().await
                && current == subscription
            {
                break diffs;
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn local_read_waits_for_open_stores() {
    let server = MatrixMockServer::new().await;
    let store = tempfile::tempdir().unwrap();
    let client = space_client(&server, store.path()).await;
    let core = core(&server, client.clone()).await;
    core.stores_open.send_replace(false);
    client.pause().await.unwrap();
    let ran = std::sync::atomic::AtomicBool::new(false);

    let pending = core.with_open_stores(async || {
        assert!(*core.stores_open.borrow());
        core.activity_lock.try_lock().unwrap_err();
        ran.store(true, std::sync::atomic::Ordering::SeqCst);
        client.state_store().get_custom_value(b"missing").await
    });
    tokio::pin!(pending);
    tokio::time::timeout(std::time::Duration::from_millis(200), &mut pending)
        .await
        .expect_err("the read waits for reopened stores");
    assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));

    client.resume().await.unwrap();
    core.stores_open.send_replace(true);
    assert_eq!(pending.await.unwrap(), None);
    assert!(ran.load(std::sync::atomic::Ordering::SeqCst));
    drop(core.activity_lock.try_lock().unwrap());
}

#[tokio::test]
async fn space_sidebar_waits_for_stores_to_reopen() {
    let server = MatrixMockServer::new().await;
    let store = tempfile::tempdir().unwrap();
    let client = space_client(&server, store.path()).await;
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_custom_global_account_data(json!({
                "type": "in.cinny.spaces",
                "content": { "sidebar": ["!second:example.org", "!space:example.org"] }
            }));
        })
        .await;
    let core = core(&server, client.clone()).await;
    core.stores_open.send_replace(false);
    client.pause().await.unwrap();

    let pending = core.run(SidebarParams {});
    tokio::pin!(pending);
    tokio::time::timeout(std::time::Duration::from_millis(200), &mut pending)
        .await
        .expect_err("the layout read waits for reopened stores");

    client.resume().await.unwrap();
    core.stores_open.send_replace(true);
    let items = pending.await.unwrap();
    assert_eq!(
        items,
        vec![
            crate::protocol::SidebarItemView::Space {
                room_id: "!second:example.org".into(),
            },
            crate::protocol::SidebarItemView::Space {
                room_id: "!space:example.org".into(),
            },
        ]
    );
}

#[tokio::test]
async fn space_sidebar_does_not_read_while_stores_are_closing() {
    let server = MatrixMockServer::new().await;
    let store = tempfile::tempdir().unwrap();
    let client = space_client(&server, store.path()).await;
    let core = core(&server, client.clone()).await;
    let activity = core.activity_lock.lock().await;

    let pending = core.run(SidebarParams {});
    tokio::pin!(pending);
    tokio::time::timeout(std::time::Duration::from_millis(200), &mut pending)
        .await
        .expect_err("the layout read waits for the activity transition");

    core.stores_open.send_replace(false);
    client.pause().await.unwrap();
    drop(activity);
    tokio::time::timeout(std::time::Duration::from_millis(200), &mut pending)
        .await
        .expect_err("the layout read waits for reopened stores");

    client.resume().await.unwrap();
    core.stores_open.send_replace(true);
    assert_eq!(pending.await.unwrap(), []);
}

#[tokio::test]
async fn room_list_waits_for_stores_to_open() {
    let server = MatrixMockServer::new().await;
    let store = tempfile::tempdir().unwrap();
    let client = space_client(&server, store.path()).await;
    let (core, mut events) = core_with_events(&server, client.clone()).await;
    core.stores_open.send_replace(false);
    client.pause().await.unwrap();

    let subscribing = tokio::spawn({
        let core = core.clone();
        async move { core.run(SubscribeRoomListParams {}).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(!subscribing.is_finished());
    assert!(core.push_rules.lock().await.is_none());

    client.resume().await.unwrap();
    core.stores_open.send_replace(true);
    let SubscribeRoomListOk { subscription, .. } = subscribing.await.unwrap().unwrap();
    let diffs = next_room_list_diff(&mut events, subscription).await;
    let [crate::protocol::VectorDiff::Reset { values }] = diffs.as_slice() else {
        panic!("expected initial room list, got {diffs:?}");
    };
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].space_children[0].room_id, "!child:example.org");
    core.run(UnsubscribeParams { subscription }).await.unwrap();
}

#[tokio::test]
async fn timeline_waits_for_stores_to_open() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!room:example.org");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    let core = core(&server, client).await;
    core.stores_open.send_replace(false);

    let pending = core.run(SubscribeParams {
        room_id: room_id.to_owned(),
        focus: TimelineFocusView::Live,
        hidden_events: false,
    });
    tokio::pin!(pending);
    tokio::time::timeout(std::time::Duration::from_millis(200), &mut pending)
        .await
        .expect_err("subscribing waits for the stores");
    assert!(core.timelines.lock().await.is_empty());

    core.stores_open.send_replace(true);
    let SubscribeOk { subscription, .. } =
        tokio::time::timeout(std::time::Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap();
    core.run(UnsubscribeParams { subscription }).await.unwrap();
}

#[tokio::test]
async fn room_list_retries_stale_spaces_when_stores_reopen() {
    let server = MatrixMockServer::new().await;
    let store = tempfile::tempdir().unwrap();
    let client = space_client(&server, store.path()).await;
    let (core, mut events) = core_with_events(&server, client).await;
    let database =
        rusqlite::Connection::open(store.path().join("matrix-sdk-state.sqlite3")).unwrap();
    database
        .execute_batch("ALTER TABLE state_event RENAME TO state_event_gone")
        .unwrap();

    let SubscribeRoomListOk { subscription, .. } =
        core.run(SubscribeRoomListParams {}).await.unwrap();
    let diffs = next_room_list_diff(&mut events, subscription).await;
    let [crate::protocol::VectorDiff::Reset { values }] = diffs.as_slice() else {
        panic!("expected initial room list, got {diffs:?}");
    };
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].space_children, Vec::new());

    core.stores_open.send_replace(false);
    database
        .execute_batch("ALTER TABLE state_event_gone RENAME TO state_event")
        .unwrap();
    core.stores_open.send_replace(true);
    let diffs = next_room_list_diff(&mut events, subscription).await;
    let [crate::protocol::VectorDiff::Set { index: 0, value }] = diffs.as_slice() else {
        panic!("expected recovered space, got {diffs:?}");
    };
    assert_eq!(value.space_children[0].room_id, "!child:example.org");

    core.stores_open.send_replace(false);
    core.stores_open.send_replace(true);
    tokio::time::timeout(
        std::time::Duration::from_millis(200),
        next_room_list_diff(&mut events, subscription),
    )
    .await
    .expect_err("a recovered space is not sent again");
    core.run(UnsubscribeParams { subscription }).await.unwrap();
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
async fn event_focus_clears_its_explicit_sync_subscription_after_unsubscribing() {
    use futures_util::StreamExt;
    use matrix_sdk::{ruma::event_id, test_utils::mocks::RoomContextResponseTemplate};
    use matrix_sdk_test::{User, event_factory::EventFactory};
    use wiremock::matchers::path_regex;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
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
                .sender(User::Alice)
                .text_msg("target")
                .event_id(target)
                .into_event(),
        ))
        .mount()
        .await;
    let core = core(&server, client).await;
    let SubscribeOk { subscription, .. } = core
        .run(SubscribeParams {
            room_id: room_id.to_owned(),
            focus: TimelineFocusView::Event {
                event_id: target.to_owned(),
            },
            hidden_events: false,
        })
        .await
        .unwrap();
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
    core.run(UnsubscribeParams { subscription }).await.unwrap();
    stream.next().await.unwrap().unwrap();
    let requests = server.server().received_requests().await.unwrap();
    let request = requests
        .iter()
        .rev()
        .find(|request| request.method == "POST" && request.url.path().contains("sync"))
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert!(body["room_subscriptions"].get(room_id.as_str()).is_none());
}

#[tokio::test]
async fn an_open_room_is_resubscribed_after_the_sync_session_expires() {
    use futures_util::StreamExt;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!open:example.org");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    let core = core(&server, client).await;
    core.run(SubscribeParams {
        room_id: room_id.to_owned(),
        focus: TimelineFocusView::Live,
        hidden_events: false,
    })
    .await
    .unwrap();
    Mock::given(method("POST"))
        .and(path_regex(".*sync.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"pos": "p1", "rooms": {}})))
        .mount(server.server())
        .await;
    let sync = core.sync_service().await.unwrap();
    sync.expire_sessions().await;

    core.resubscribe_timeline_rooms().await;
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
    assert!(body["room_subscriptions"].get(room_id.as_str()).is_some());
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
async fn scheduled_attachments_keep_the_spoiler_on_the_wire() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().no_server_versions().build().await;
    let room_id = room_id!("!scheduled-spoiler:example.org");
    Mock::given(method("GET"))
        .and(path("/_matrix/client/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            json!({"versions": ["v1.13"], "unstable_features": {"org.matrix.msc4140": true}}),
        ))
        .mount(server.server())
        .await;
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/rooms/.*/send/m\.room\.message/"))
        .and(wiremock::matchers::body_partial_json(
            json!({"msgtype": "m.image", "page.codeberg.everypizza.msc4193.spoiler": true}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"delay_id": "spoiled"})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    let delay_id = core
        .schedule_attachment(
            &room_id.to_owned(),
            "a.png".to_owned(),
            "image/png".to_owned(),
            "mxc://example.org/abc".to_owned(),
            7,
            None,
            true,
            1000,
            None,
        )
        .await
        .unwrap();
    assert_eq!(delay_id, "spoiled");
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
    let params: ListParams =
        serde_json::from_value(json!({"room_id": room_id, "cached_only": true})).unwrap();
    let ListOk { packs, .. } =
        tokio::time::timeout(std::time::Duration::from_millis(500), core.run(params))
            .await
            .expect("cached emotes do not wait for the server")
            .unwrap();
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
async fn all_image_packs_return_without_waiting_for_room_state() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!cached-all-packs:example.org");
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

    let packs = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        core.run(ListAllParams {}),
    )
    .await
    .expect("settings packs do not wait for the homeserver")
    .unwrap();
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
    let params: ListParams =
        serde_json::from_value(json!({"room_id": room_id, "cached_only": true})).unwrap();
    let ListOk { packs, .. } = core.run(params).await.unwrap();
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
    let params: crate::api::rooms::CreateDmParams =
        serde_json::from_value(json!({"user_id": "@bob:example.org"})).unwrap();
    let found = core.run(params).await.unwrap();
    assert_eq!(found, room_id.as_str());
}

#[tokio::test]
async fn an_unencrypted_dm_request_reuses_an_unencrypted_dm() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!plain-dm:example.org");
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
    let params: crate::api::rooms::CreateDmParams =
        serde_json::from_value(json!({"user_id": "@bob:example.org", "encrypted": false})).unwrap();
    let found = core.run(params).await.unwrap();
    assert_eq!(found, room_id.as_str());
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

    let room = core
        .run(crate::api::rooms::ListItemParams {
            room_id: room_id.to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(room.room_id, room_id);
    assert!(room.is_tombstoned);
}

#[tokio::test]
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

fn remote_media_error(status: u16) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_json(json!({
        "errcode": "M_UNKNOWN",
        "error": "Unknown error when fetching thumbnail",
    }))
}

#[tokio::test]
async fn corrupt_encrypted_media_is_rejected_before_returning_plaintext() {
    use std::io::Read;
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    let mut plaintext = std::io::Cursor::new(b"room key bundle".to_vec());
    let mut encryptor = matrix_sdk_base::crypto::AttachmentEncryptor::new(&mut plaintext);
    let mut ciphertext = Vec::new();
    encryptor.read_to_end(&mut ciphertext).unwrap();
    let keys = encryptor.finish();
    ciphertext[0] ^= 1;
    let file = matrix_sdk::ruma::events::room::EncryptedFile::new(
        "mxc://example.org/corrupt".into(),
        keys.encryption_info,
        keys.hashes,
    );
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/download/example.org/corrupt",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(ciphertext))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let source = serde_json::to_string(&matrix_sdk::ruma::events::room::MediaSource::Encrypted(
        Box::new(file),
    ))
    .unwrap();
    assert!(matches!(
        core.media_thumbnail(source, 0, 0).await,
        Err(RpcError::Unavailable)
    ));
}

#[tokio::test]
async fn sticker_previews_reuse_a_cached_original_without_retrying_thumbnails() {
    let server = MatrixMockServer::new().await;
    let store = tempfile::tempdir().unwrap();
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .on_builder(|builder| builder.sqlite_store(store.path(), None))
        .build()
        .await;
    let bytes = vec![7_u8; 32];
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/thumbnail/example.org/sticker",
        ))
        .respond_with(remote_media_error(404))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/download/example.org/sticker",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
        .expect(1)
        .mount(server.server())
        .await;
    let first = core(&server, client).await;
    let source = "mxc://example.org/sticker".to_owned();
    assert_eq!(
        first
            .media_thumbnail(source.clone(), 144, 144)
            .await
            .unwrap(),
        bytes
    );
    drop(first);

    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .on_builder(|builder| builder.sqlite_store(store.path(), None))
        .build()
        .await;
    let restored = core(&server, client).await;

    for size in [144, 96, 48] {
        assert_eq!(
            restored
                .media_thumbnail(source.clone(), size, size)
                .await
                .unwrap(),
            bytes
        );
    }
}

#[tokio::test]
async fn sticker_previews_prefer_the_persisted_thumbnail_over_the_original() {
    let server = MatrixMockServer::new().await;
    let store = tempfile::tempdir().unwrap();
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .on_builder(|builder| builder.sqlite_store(store.path(), None))
        .build()
        .await;
    let thumbnail = vec![2_u8; 8];
    let original = vec![7_u8; 32];
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/thumbnail/example.org/preview",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(thumbnail.clone()))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/download/example.org/preview",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(original.clone()))
        .expect(1)
        .mount(server.server())
        .await;
    let first = core(&server, client).await;
    let source = "mxc://example.org/preview".to_owned();
    assert_eq!(
        first
            .media_thumbnail(source.clone(), 144, 144)
            .await
            .unwrap(),
        thumbnail
    );
    assert_eq!(
        first.media_thumbnail(source.clone(), 0, 0).await.unwrap(),
        original
    );
    drop(first);

    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .on_builder(|builder| builder.sqlite_store(store.path(), None))
        .build()
        .await;
    let restored = core(&server, client).await;
    assert_eq!(
        restored
            .media_thumbnail(source.clone(), 144, 144)
            .await
            .unwrap(),
        thumbnail
    );
    assert_eq!(
        restored.media_thumbnail(source, 48, 48).await.unwrap(),
        original
    );
}

#[tokio::test]
async fn cached_sticker_reads_bypass_six_stalled_downloads() {
    let server = MatrixMockServer::new().await;
    let store = tempfile::tempdir().unwrap();
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .on_builder(|builder| builder.sqlite_store(store.path(), None))
        .build()
        .await;
    let bytes = vec![7_u8; 32];
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/download/example.org/cached-sticker",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            r"^/_matrix/client/v1/media/download/example\.org/stalled-",
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(vec![1_u8])
                .set_delay(std::time::Duration::from_secs(60)),
        )
        .expect(crate::media::MAX_MEDIA_DOWNLOADS as u64)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let source = "mxc://example.org/cached-sticker".to_owned();
    assert_eq!(
        core.media_thumbnail(source.clone(), 0, 0).await.unwrap(),
        bytes
    );

    let downloads = (0..=crate::media::MAX_MEDIA_DOWNLOADS)
        .map(|index| {
            let core = core.clone();
            tokio::spawn(async move {
                core.media_thumbnail(format!("mxc://example.org/stalled-{index}"), 0, 0)
                    .await
            })
        })
        .collect::<Vec<_>>();
    let cached = async {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let requests = server.server().received_requests().await.unwrap();
                if requests
                    .iter()
                    .filter(|request| request.url.path().contains("/stalled-"))
                    .count()
                    == crate::media::MAX_MEDIA_DOWNLOADS
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(core.media_downloads.available_permits(), 0);
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            core.media_thumbnail(source, 144, 144),
        )
        .await
    }
    .await;

    for download in &downloads {
        download.abort();
    }
    for download in downloads {
        let _ = download.await;
    }
    assert_eq!(
        core.media_downloads.available_permits(),
        crate::media::MAX_MEDIA_DOWNLOADS
    );
    assert_eq!(cached.unwrap().unwrap(), bytes);
}

#[tokio::test]
async fn large_cached_photos_do_not_replace_plain_thumbnails() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    let original = vec![7_u8; 1024 * 1024 + 1];
    let thumbnail = vec![2_u8; 8];
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v1/media/download/example.org/photo"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(original.clone()))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v1/media/thumbnail/example.org/photo"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(thumbnail.clone()))
        .expect(2)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let source = "mxc://example.org/photo".to_owned();
    assert_eq!(
        core.media_thumbnail(source.clone(), 0, 0).await.unwrap(),
        original
    );
    for (width, height) in [(800, 600), (144, 144), (800, 600)] {
        let preview = core
            .media_thumbnail(source.clone(), width, height)
            .await
            .unwrap();
        assert_eq!(preview.len(), thumbnail.len());
        assert_eq!(preview, thumbnail);
    }
    assert_eq!(core.media_thumbnail(source, 0, 0).await.unwrap(), original);
}

#[tokio::test]
async fn bulk_original_downloads_leave_all_preview_slots_available() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            r"^/_matrix/client/v1/media/download/example\.org/export-",
        ))
        .respond_with(ResponseTemplate::new(200).set_delay(std::time::Duration::from_secs(60)))
        .expect(4)
        .mount(server.server())
        .await;
    let thumbnail = vec![2_u8; 8];
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/thumbnail/example.org/visible",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(thumbnail.clone()))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let downloads = (0..4)
        .map(|index| {
            let core = core.clone();
            tokio::spawn(async move {
                core.fetch_media(format!("mxc://example.org/export-{index}"), 0, 0, true)
                    .await
            })
        })
        .collect::<Vec<_>>();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let requests = server.server().received_requests().await.unwrap();
            if requests
                .iter()
                .filter(|request| request.url.path().contains("/export-"))
                .count()
                == 4
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let slots = core.media_downloads.available_permits();
    let visible = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        core.media_thumbnail("mxc://example.org/visible".to_owned(), 144, 144),
    )
    .await;
    for download in &downloads {
        download.abort();
    }
    for download in downloads {
        let _ = download.await;
    }
    assert_eq!(slots, crate::media::MAX_MEDIA_DOWNLOADS);
    assert_eq!(visible.unwrap().unwrap(), thumbnail);
}

#[tokio::test]
async fn queued_previews_recheck_the_original_cache() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    let bytes = vec![7_u8; 1024 * 1024];
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v1/media/download/example.org/queued"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/thumbnail/example.org/queued",
        ))
        .respond_with(ResponseTemplate::new(404))
        .expect(0)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let slots = core
        .media_downloads
        .acquire_many(u32::try_from(crate::media::MAX_MEDIA_DOWNLOADS).unwrap())
        .await
        .unwrap();
    let source = "mxc://example.org/queued".to_owned();
    let mut preview = Box::pin(core.media_thumbnail(source.clone(), 144, 144));
    tokio::time::timeout(std::time::Duration::from_millis(50), &mut preview)
        .await
        .unwrap_err();
    assert_eq!(core.fetch_media(source, 0, 0, true).await.unwrap(), bytes);
    drop(slots);
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(1), preview)
            .await
            .unwrap()
            .unwrap(),
        bytes
    );
}

#[tokio::test]
async fn a_transient_download_failure_is_retried() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    let bytes = vec![7_u8; 32];
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v1/media/download/example.org/blip"))
        .respond_with(remote_media_error(502))
        .with_priority(1)
        .up_to_n_times(1)
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v1/media/download/example.org/blip"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
        .with_priority(2)
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    assert_eq!(
        core.media_thumbnail("mxc://example.org/blip".to_owned(), 0, 0)
            .await
            .unwrap(),
        bytes
    );
}

#[tokio::test]
async fn a_refused_authenticated_download_falls_back_to_the_legacy_endpoint() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    let bytes = vec![7_u8; 32];
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/download/example.org/legacy-only",
        ))
        .respond_with(ResponseTemplate::new(404))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path("/_matrix/media/v3/download/example.org/legacy-only"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    assert_eq!(
        core.media_thumbnail("mxc://example.org/legacy-only".to_owned(), 0, 0)
            .await
            .unwrap(),
        bytes
    );
}

#[tokio::test]
async fn legacy_original_downloads_can_take_longer_than_thirty_seconds() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_10])
        .build()
        .await;
    let bytes = vec![7_u8; 32];
    Mock::given(method("GET"))
        .and(path("/_matrix/media/v3/download/example.org/slow"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(bytes.clone())
                .set_delay(std::time::Duration::from_secs(31)),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let source = "mxc://example.org/slow".to_owned();
    assert_eq!(
        core.media_thumbnail(source.clone(), 0, 0).await.unwrap(),
        bytes
    );
    assert_eq!(core.media_thumbnail(source, 0, 0).await.unwrap(), bytes);
}

#[tokio::test]
async fn sdk_original_retry_can_take_longer_than_thirty_seconds() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    let bytes = vec![7_u8; 32];
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/download/example.org/slow-retry",
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(bytes.clone())
                .set_delay(std::time::Duration::from_secs(31)),
        )
        .with_priority(2)
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/download/example.org/slow-retry",
        ))
        .respond_with(remote_media_error(401))
        .with_priority(1)
        .up_to_n_times(1)
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let source = "mxc://example.org/slow-retry".to_owned();
    assert_eq!(
        core.media_thumbnail(source.clone(), 0, 0).await.unwrap(),
        bytes
    );
    assert_eq!(core.media_thumbnail(source, 0, 0).await.unwrap(), bytes);
}

#[tokio::test]
async fn a_server_whose_media_keeps_failing_is_refused_without_a_request() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            r"^/_matrix/client/v1/media/thumbnail/dead\.example/",
        ))
        .respond_with(remote_media_error(400))
        .expect(3)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            r"^/_matrix/client/v1/media/download/dead\.example/",
        ))
        .respond_with(remote_media_error(400))
        .expect(3)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    for id in ["one", "two", "three"] {
        assert!(matches!(
            core.media_thumbnail(format!("mxc://dead.example/{id}"), 64, 64)
                .await,
            Err(RpcError::Unavailable)
        ));
    }

    assert!(matches!(
        core.media_thumbnail("mxc://dead.example/four".to_owned(), 64, 64)
            .await,
        Err(RpcError::MediaServerUnavailable { retry_after_ms }) if retry_after_ms > 0
    ));
}

#[tokio::test]
async fn a_refused_server_still_serves_what_is_cached() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    let bytes = vec![7_u8; 32];
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v1/media/download/dead.example/kept"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            r"^/_matrix/client/v1/media/download/dead\.example/gone",
        ))
        .respond_with(remote_media_error(502))
        .expect(9)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    core.media_thumbnail("mxc://dead.example/kept".to_owned(), 0, 0)
        .await
        .unwrap();
    for id in ["gone1", "gone2", "gone3"] {
        core.media_thumbnail(format!("mxc://dead.example/{id}"), 0, 0)
            .await
            .unwrap_err();
    }

    assert_eq!(
        core.media_thumbnail("mxc://dead.example/kept".to_owned(), 0, 0)
            .await
            .unwrap(),
        bytes
    );
}

#[tokio::test]
async fn forbidden_media_never_opens_the_circuit() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            r"^/_matrix/client/v1/media/download/policy\.example/",
        ))
        .respond_with(remote_media_error(403))
        .expect(4)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    for id in ["a", "b", "c", "d"] {
        assert!(matches!(
            core.media_thumbnail(format!("mxc://policy.example/{id}"), 0, 0)
                .await,
            Err(RpcError::Unavailable)
        ));
    }
}

#[tokio::test]
async fn missing_media_never_opens_the_circuit() {
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![MatrixVersion::V1_11])
        .build()
        .await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v1/media/download/gone.example/ok"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![1_u8; 16]))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            r"^/_matrix/client/v1/media/download/gone\.example/",
        ))
        .respond_with(remote_media_error(404))
        .expect(4)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    for id in ["a", "b", "c", "d"] {
        assert!(matches!(
            core.media_thumbnail(format!("mxc://gone.example/{id}"), 0, 0)
                .await,
            Err(RpcError::Unavailable)
        ));
    }
    core.media_thumbnail("mxc://gone.example/ok".to_owned(), 0, 0)
        .await
        .unwrap();
}

#[tokio::test]
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

#[expect(clippy::unwrap_used, reason = "test code")]
async fn space_child_writes(
    child: Option<serde_json::Value>,
    command: impl Handler,
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

    core.run(command).await.unwrap();

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

fn add_child() -> AddParams {
    AddParams {
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
        AddParams {
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
        SetChildSuggestedParams {
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
        SetChildOrderParams {
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
        Err(RpcError::InvalidMedia)
    ));
}

#[expect(clippy::unwrap_used, reason = "test code")]
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
    let recover =
        async |recovery_key: String| core.run(RecoverIdentityParams { recovery_key }).await;

    assert!(matches!(
        recover("wrong horse".to_owned()).await,
        Err(RpcError::Denied)
    ));
    assert!(matches!(
        recover("correct horse".to_owned()).await,
        Err(RpcError::Failed { .. })
    ));
    assert!(matches!(
        recover(key.to_base58()).await,
        Err(RpcError::Failed { .. })
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

    let Ok(IdentityResetStep::Done { recovery_key }) = core.run(ResetIdentityParams {}).await
    else {
        panic!("the reset needed no authentication")
    };
    assert_ne!(recovery_key, "");
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
        core.run(ResetIdentityParams {}).await,
        Ok(IdentityResetStep::Password)
    ));
    assert!(matches!(
        core.run(ContinueIdentityResetParams {
            password: Some("wrong".into())
        })
        .await,
        Err(RpcError::Denied)
    ));
    let Ok(recovery_key) = core
        .run(ContinueIdentityResetParams {
            password: Some("hunter2".into()),
        })
        .await
    else {
        panic!("the right password completes the reset")
    };
    assert_ne!(recovery_key, "");
    assert!(matches!(
        core.run(ContinueIdentityResetParams { password: None })
            .await,
        Err(RpcError::Unavailable)
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

    let Ok(IdentityResetStep::Approve { url }) = core.run(ResetIdentityParams {}).await else {
        panic!("an OAuth account is sent to approve the reset")
    };
    assert!(url.contains("org.matrix.cross_signing_reset"));

    let (waiting, ()) = tokio::join!(
        core.run(ContinueIdentityResetParams { password: None }),
        async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            core.run(CancelIdentityResetParams {}).await.unwrap();
        }
    );
    assert!(matches!(waiting, Err(RpcError::Unavailable)));
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

    let Ok(IdentityResetStep::Approve { url }) = core.run(ResetIdentityParams {}).await else {
        panic!("an OAuth account is sent to approve the reset")
    };
    assert_eq!(url, "https://auth.example.org/approve");

    let Ok(recovery_key) = core
        .run(ContinueIdentityResetParams { password: None })
        .await
    else {
        panic!("the approved session completes the reset")
    };
    assert_ne!(recovery_key, "");
}

#[tokio::test]
async fn profile_updates_send_the_chosen_msc4466_propagation() {
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

    core.run(crate::api::account::SetDisplayNameParams {
        name: Some("Quiet".to_owned()),
        propagate_to: ProfilePropagationView::None,
    })
    .await
    .unwrap();
    core.run(crate::api::account::SetAvatarUrlParams {
        url: Some("mxc://example.org/avatar".to_owned()),
        propagate_to: ProfilePropagationView::Unchanged,
    })
    .await
    .unwrap();
    core.run(crate::api::account::SetDisplayNameParams {
        name: Some("Loud".to_owned()),
        propagate_to: ProfilePropagationView::All,
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn account_data_types_survive_a_restart_and_include_stored_known_types() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_global_account_data(
                Raw::new(&json!({"type": "m.direct", "content": {}}))
                    .unwrap()
                    .cast_unchecked(),
            );
        })
        .await;

    let before = core(&server, client.clone()).await;
    before
        .remember_account_data_type("org.example.custom")
        .await;

    let after = core(&server, client).await;
    let event_types = after
        .run(crate::api::account::DataTypesParams {})
        .await
        .unwrap();
    assert!(
        event_types
            .iter()
            .any(|event_type| event_type == "m.direct")
    );
    assert!(
        event_types
            .iter()
            .any(|event_type| event_type == "org.example.custom")
    );
}

#[tokio::test]
async fn account_data_types_include_what_the_server_lists_but_sync_never_delivered() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    server
        .mock_sync()
        .ok(|builder| {
            builder.add_global_account_data(
                Raw::new(&json!({"type": "org.example.legacy", "content": {"a": 1}}))
                    .unwrap()
                    .cast_unchecked(),
            );
        })
        .mount()
        .await;

    let core = core(&server, client).await;
    let event_types = core
        .run(crate::api::account::DataTypesParams {})
        .await
        .unwrap();
    assert!(
        event_types
            .iter()
            .any(|event_type| event_type == "org.example.legacy")
    );
}

#[expect(clippy::unwrap_used, reason = "test code")]
async fn last_put_body(server: &MatrixMockServer, event_type: &str) -> serde_json::Value {
    let requests = server.server().received_requests().await.unwrap();
    let request = requests
        .iter()
        .rev()
        .find(|request| {
            request.method.as_str() == "PUT" && request.url.path().ends_with(event_type)
        })
        .unwrap();
    serde_json::from_slice(&request.body).unwrap()
}

#[tokio::test]
async fn recovery_adopts_an_account_data_key_that_seals_our_documents() {
    use matrix_sdk_base::crypto::secret_storage::SecretStorageKey;

    use crate::protocol::SealStateView;
    use crate::sealed_account_data::{ADK_SECRET, cached_key, is_sealed};

    const DRAFTS: &str = "moe.sable.next.drafts";

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let key = SecretStorageKey::new();
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
    Mock::given(method("GET"))
        .and(path_regex(format!(
            r"/account_data/{}$",
            regex_lite::escape(ADK_SECRET)
        )))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "errcode": "M_NOT_FOUND",
            "error": "not found",
        })))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/account_data/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(server.server())
        .await;
    let core = core(&server, client.clone()).await;

    assert!(matches!(
        core.run(crate::api::account::SetSealedDataParams {
            event_type: "m.push_rules".to_owned(),
            content: json!({}),
        })
        .await,
        Err(RpcError::Unsupported)
    ));

    core.adopt_account_data_key(&client, &key.to_base58()).await;

    assert!(cached_key(&client).await.is_some());
    let stored = last_put_body(&server, ADK_SECRET).await;
    assert!(stored["encrypted"][key.key_id()]["ciphertext"].is_string());

    let draft = json!({ "v": 1, "drafts": { "!room:example.org": "unsent" } });
    core.run(crate::api::account::SetSealedDataParams {
        event_type: DRAFTS.to_owned(),
        content: draft.clone(),
    })
    .await
    .unwrap();
    let sealed = last_put_body(&server, DRAFTS).await;
    assert!(is_sealed(&sealed));
    assert!(!sealed.to_string().contains("unsent"));

    Mock::given(method("GET"))
        .and(path_regex(format!(
            r"/account_data/{}$",
            regex_lite::escape(DRAFTS)
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(sealed))
        .mount(server.server())
        .await;
    let Ok(document) = core
        .run(crate::api::account::SealedDataParams {
            event_type: DRAFTS.to_owned(),
        })
        .await
    else {
        panic!("the sealed drafts could not be read");
    };

    assert_eq!(document.state, SealStateView::Sealed);
    assert_eq!(document.content, Some(draft));
    assert!(document.can_seal);
}

#[tokio::test]
async fn markdown_to_content_needs_no_session() {
    use crate::protocol::ComposerPill;

    let (core, _events) = Core::new("markdown-test", Box::new(MemorySessionStore::default()));
    let content = core
        .run(crate::api::messages::MarkdownToContentParams {
            markdown: "**hi** \u{FFFC}".to_owned(),
            pills: vec![ComposerPill::Mention {
                user_id: "@ana:example.org".to_owned(),
                name: "Ana".to_owned(),
                via: Vec::new(),
            }],
        })
        .await
        .unwrap();
    assert_eq!(content.body, "**hi** Ana");
    assert_eq!(
        content.formatted_body.as_deref(),
        Some("<strong>hi</strong> <a href=\"https://matrix.to/#/@ana:example.org\">Ana</a>")
    );
    assert_eq!(content.mentions.user_ids, ["@ana:example.org"]);
}

/// An account-data event the server stores, served back slowly enough that two
/// unguarded read-modify-writes would both read the empty document.
#[derive(Clone, Default)]
struct StoredAccountData(Arc<std::sync::Mutex<Option<serde_json::Value>>>);

impl wiremock::Respond for StoredAccountData {
    fn respond(&self, request: &wiremock::Request) -> ResponseTemplate {
        let mut stored = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if request.method == wiremock::http::Method::PUT {
            *stored = request.body_json().ok();
            return ResponseTemplate::new(200).set_body_json(json!({}));
        }
        let delay = std::time::Duration::from_millis(50);
        stored.as_ref().map_or_else(
            || {
                ResponseTemplate::new(404)
                    .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "absent"}))
                    .set_delay(delay)
            },
            |content| {
                ResponseTemplate::new(200)
                    .set_body_json(content)
                    .set_delay(delay)
            },
        )
    }
}

#[tokio::test]
async fn invites_dismissed_at_once_are_all_kept() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let stored = StoredAccountData::default();
    Mock::given(path_regex(r"/account_data/moe\.sable\.dismissed_invites$"))
        .respond_with(stored.clone())
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    let dismiss = |room_id: &'static str| {
        core.run(crate::api::account::SetInviteDismissedParams {
            room_id: room_id.try_into().expect("a room id"),
            dismissed: true,
        })
    };
    let (first, second) = tokio::join!(
        dismiss("!first:example.org"),
        dismiss("!second:example.org")
    );
    assert!(first.is_ok() && second.is_ok());

    let kept = stored
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    assert_eq!(
        kept,
        Some(json!({"roomIds": ["!first:example.org", "!second:example.org"]}))
    );
}

#[tokio::test]
async fn a_sidebar_naming_something_that_is_not_a_room_is_refused() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let core = core(&server, client).await;

    let refused = core
        .run(SetSidebarParams {
            items: vec![sable_model::sidebar::SidebarItemView::Folder {
                id: "folder".to_owned(),
                name: None,
                content: vec!["not a room".to_owned()],
            }],
        })
        .await;

    assert!(matches!(refused, Err(RpcError::UnknownRoom)));
}

#[tokio::test]
async fn server_features_lists_only_enabled_unstable_features() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().no_server_versions().build().await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "versions": ["v1.19"],
            "unstable_features": {
                "org.matrix.msc4354": true,
                "org.matrix.msc4140": false,
                "org.matrix.simplified_msc3575": true,
            },
        })))
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let Ok(unstable_features) = core.run(crate::api::session::ServerFeaturesParams {}).await else {
        panic!("server features failed");
    };
    assert_eq!(
        unstable_features,
        ["org.matrix.msc4354", "org.matrix.simplified_msc3575"]
    );
}

#[tokio::test]
async fn a_live_redaction_shows_its_reason_in_an_open_timeline() {
    use matrix_sdk::ruma::event_id;
    use matrix_sdk_test::{User, event_factory::EventFactory};

    use crate::protocol::TimelineItemContentView;
    use crate::view::apply_diff;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!reason:example.org");
    let target = event_id!("$target");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    server.mock_room_state_encryption().plain().mount().await;
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("hey").event_id(target)),
        )
        .await;
    let (core, mut events) = core_with_events(&server, client.clone()).await;
    core.watch_redactions(&client);
    let SubscribeOk {
        subscription,
        mut items,
        ..
    } = core
        .run(SubscribeParams {
            room_id: room_id.to_owned(),
            focus: TimelineFocusView::Live,
            hidden_events: false,
        })
        .await
        .unwrap();

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
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(Raw::new(&redaction).unwrap().cast_unchecked()),
        )
        .await;

    let reason = |items: &[crate::protocol::TimelineItemView]| {
        items.iter().find_map(|item| match &item.content {
            TimelineItemContentView::Redacted { reason, .. } => Some(reason.clone()),
            _ => None,
        })
    };
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while reason(&items) != Some(Some("spam".to_owned())) {
            let Some(event) = events.recv().await else {
                break;
            };
            if let CoreEvent::TimelineDiff {
                subscription: from,
                diffs,
            } = event
                && from == subscription
            {
                for diff in &diffs {
                    apply_diff(&mut items, diff);
                }
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(reason(&items), Some(Some("spam".to_owned())));
}

#[tokio::test]
async fn a_queued_reproxy_reaches_an_open_timeline_before_the_server_echoes_it() {
    use matrix_sdk::ruma::{
        event_id,
        events::{AnyMessageLikeEventContent, MessageLikeEventType},
        serde::Raw,
    };
    use matrix_sdk_test::event_factory::EventFactory;

    use crate::view::apply_diff;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let own = client.user_id().unwrap().to_owned();
    let room_id = room_id!("!reproxy:example.org");
    let target = event_id!("$target");
    let factory = EventFactory::new().room(room_id).sender(&own);
    server.mock_room_state_encryption().plain().mount().await;
    server.mock_room_send().error500().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("hey").event_id(target)),
        )
        .await;
    let (core, mut events) = core_with_events(&server, client.clone()).await;
    let SubscribeOk {
        subscription,
        mut items,
        ..
    } = core
        .run(SubscribeParams {
            room_id: room_id.to_owned(),
            focus: TimelineFocusView::Live,
            hidden_events: false,
        })
        .await
        .unwrap();

    let edit = json!({
        "msgtype": "m.text",
        "body": "* hey",
        "m.new_content": { "msgtype": "m.text", "body": "hey" },
        "m.relates_to": { "rel_type": "m.replace", "event_id": target },
        "com.beeper.per_message_profile": { "id": "kris", "displayname": "Kris" },
    });
    room.send_queue()
        .send_raw(
            Raw::<AnyMessageLikeEventContent>::from_json_string(edit.to_string()).unwrap(),
            MessageLikeEventType::RoomMessage.to_string(),
        )
        .await
        .unwrap();

    let profile_name = |items: &[crate::protocol::TimelineItemView]| {
        items
            .iter()
            .find(|item| item.event_id.as_deref() == Some(target))
            .and_then(|item| item.per_message_profile.as_ref()?.display_name.clone())
    };
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while profile_name(&items).is_none() {
            let Some(event) = events.recv().await else {
                break;
            };
            if let CoreEvent::TimelineDiff {
                subscription: from,
                diffs,
            } = event
                && from == subscription
            {
                for diff in &diffs {
                    apply_diff(&mut items, diff);
                }
            }
        }
    })
    .await
    .unwrap();

    assert_eq!(profile_name(&items).as_deref(), Some("Kris"));
}

#[tokio::test]
async fn a_remote_profile_the_homeserver_rejects_is_unavailable() {
    use crate::api::account::UserProfileParams;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/_matrix/client/v3/profile/"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "errcode": "M_BAD_JSON",
            "error": "Profile key names must follow the Common Namespaced Identifier Grammar."
        })))
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    let result = UserProfileParams {
        user_id: matrix_sdk::ruma::owned_user_id!("@remote:other.example"),
    }
    .run(&core)
    .await;

    assert!(matches!(result, Err(RpcError::Unavailable)));
}

#[tokio::test]
async fn mutual_rooms_are_empty_when_the_server_lacks_the_endpoint() {
    use crate::api::account::UserRelationsParams;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/account_data/m\.ignored_user_list$"))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "absent"})),
        )
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    let relations = UserRelationsParams {
        user_id: matrix_sdk::ruma::owned_user_id!("@remote:other.example"),
    }
    .run(&core)
    .await
    .unwrap();

    assert!(relations.mutual_rooms.is_empty());
    assert!(!relations.ignored);
}

#[tokio::test]
async fn join_by_alias_routes_through_the_resolved_servers_and_the_caller_via() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET"))
        .and(path_regex("^/_matrix/client/v3/directory/room/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "room_id": "!target:creator.example",
            "servers": ["resolved.example"],
        })))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path_regex("^/_matrix/client/v3/join/(!|%21)target"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"room_id": "!target:creator.example"})),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    let room_id = core
        .join_room("#lobby:alias.example", &["child.example".to_owned()])
        .await
        .unwrap();

    assert_eq!(room_id, "!target:creator.example");
    let requests = server.server().received_requests().await.unwrap();
    let join = requests
        .iter()
        .find(|request| request.method.as_str() == "POST")
        .unwrap();
    let via: Vec<String> = join
        .url
        .query_pairs()
        .filter(|(key, _)| key == "via")
        .map(|(_, value)| value.into_owned())
        .collect();
    assert_eq!(
        via,
        [
            "child.example",
            "alias.example",
            "creator.example",
            "resolved.example"
        ]
    );
}

#[tokio::test]
async fn join_by_alias_caps_the_servers_of_a_big_room() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let resolved: Vec<String> = (0..500).map(|i| format!("s{i}.example")).collect();
    Mock::given(method("GET"))
        .and(path_regex("^/_matrix/client/v3/directory/room/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "room_id": "!target:creator.example",
            "servers": resolved,
        })))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path_regex("^/_matrix/client/v3/join/(!|%21)target"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"room_id": "!target:creator.example"})),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    core.join_room("#lobby:alias.example", &[]).await.unwrap();

    let requests = server.server().received_requests().await.unwrap();
    let join = requests
        .iter()
        .find(|request| request.method.as_str() == "POST")
        .unwrap();
    let via: Vec<String> = join
        .url
        .query_pairs()
        .filter(|(key, _)| key == "via")
        .map(|(_, value)| value.into_owned())
        .collect();
    assert_eq!(via.len(), 10);
    assert_eq!(via[..3], ["alias.example", "creator.example", "s0.example"]);
}

#[tokio::test]
async fn knock_by_alias_targets_the_resolved_room_id() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("GET"))
        .and(path_regex("^/_matrix/client/v3/directory/room/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "room_id": "!target:creator.example",
            "servers": [],
        })))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path_regex("^/_matrix/client/v3/knock/(!|%21)target"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"room_id": "!target:creator.example"})),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;

    let room_id = core
        .knock_room("#lobby:alias.example", &[], None)
        .await
        .unwrap();

    assert_eq!(room_id, "!target:creator.example");
}
