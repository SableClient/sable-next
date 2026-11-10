#![expect(clippy::unwrap_used, clippy::indexing_slicing, reason = "test code")]

use std::collections::BTreeMap;

use matrix_sdk::ruma::push::Ruleset;
use matrix_sdk::ruma::{OwnedRoomId, RoomId};
use parking_lot::Mutex;
use serde_json::Value;
use wiremock::{Request, Respond};

use super::*;
use crate::api::notifications::{
    DefaultModesParams, SetDefaultModeParams, SetRoomNotificationModeParams, SettingsParams,
};
use crate::protocol::NotificationModeView;

const PREFERENCE: &str = "moe.sable.dm_notification_default";

struct Remote {
    rules: Ruleset,
    preference: Option<Value>,
    direct: BTreeMap<String, Vec<OwnedRoomId>>,
    fail_rule: bool,
}

#[derive(Clone)]
struct PushServer(Arc<Mutex<Remote>>);

impl Respond for PushServer {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let path = percent_encoding::percent_decode_str(request.url.path())
            .decode_utf8()
            .unwrap();
        let verb = request.method.as_str();
        let mut remote = self.0.lock();
        if path.ends_with("/pushrules/") {
            return ResponseTemplate::new(200).set_body_json(json!({"global": remote.rules}));
        }
        if path.contains("/account_data/") {
            if verb == "PUT" {
                assert!(
                    path.ends_with(PREFERENCE),
                    "unexpected account data PUT {path}"
                );
                remote.preference = Some(request.body_json().unwrap());
                return ResponseTemplate::new(200).set_body_json(json!({}));
            }
            if path.ends_with("/m.direct") {
                return ResponseTemplate::new(200).set_body_json(json!(remote.direct));
            }
            return remote.preference.as_ref().map_or_else(
                || {
                    ResponseTemplate::new(404)
                        .set_body_json(json!({"errcode":"M_NOT_FOUND", "error":"not set"}))
                },
                |content| ResponseTemplate::new(200).set_body_json(content),
            );
        }
        let suffix = path.split("/pushrules/global/").nth(1).unwrap();
        let (kind, suffix) = suffix.split_once('/').unwrap();
        let kind: RuleKind = kind.into();
        if verb == "DELETE" {
            let _ = remote.rules.remove(kind, suffix);
        } else {
            if remote.fail_rule && suffix.starts_with("moe.sable.dm_default.") {
                remote.fail_rule = false;
                return ResponseTemplate::new(403)
                    .set_body_json(json!({"errcode":"M_FORBIDDEN", "error":"try again"}));
            }
            let mut body: Value = request.body_json().unwrap();
            if let Some(id) = suffix.strip_suffix("/actions") {
                remote
                    .rules
                    .set_actions(
                        kind,
                        id,
                        serde_json::from_value(body["actions"].take()).unwrap(),
                    )
                    .unwrap();
            } else if let Some(id) = suffix.strip_suffix("/enabled") {
                remote
                    .rules
                    .set_enabled(kind, id, body["enabled"].as_bool().unwrap())
                    .unwrap();
            } else {
                body["rule_id"] = json!(suffix);
                let rule = crate::push_rules::new_rule(&kind, body).unwrap();
                remote.rules.insert(rule, None, None).unwrap();
            }
        }
        ResponseTemplate::new(200).set_body_json(json!({}))
    }
}

async fn fixture() -> (
    MatrixMockServer,
    Client,
    Arc<Core>,
    UnboundedReceiver<CoreEvent>,
    PushServer,
) {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    server.mock_room_state_encryption().plain().mount().await;
    let room = room_id!("!bridge:example.org");
    let other = room_id!("!group:example.org");
    let mut rules = Ruleset::server_default(client.user_id().unwrap());
    for id in [".m.rule.message", ".m.rule.encrypted"] {
        rules.set_actions(RuleKind::Underride, id, vec![]).unwrap();
    }
    let remote = PushServer(Arc::new(Mutex::new(Remote {
        rules: rules.clone(),
        preference: None,
        direct: BTreeMap::from([(
            "@other:example.org".to_owned(),
            vec![room.to_owned(), other.to_owned()],
        )]),
        fail_rule: false,
    })));
    Mock::given(path_regex(
        r"/_matrix/client/v3/(pushrules/|user/.*/account_data/).*",
    ))
    .respond_with(remote.clone())
    .mount(server.server())
    .await;
    server
        .mock_sync()
        .ok_and_run(&client, |sync| {
            sync.add_global_account_data(EventFactory::new().push_rules(rules));
            let factory = EventFactory::new().room(room).sender(User::Alice);
            sync.add_joined_room(
                JoinedRoomBuilder::new(room)
                    .set_joined_members_count(3)
                    .add_state_event(factory.member(client.user_id().unwrap()))
                    .add_state_event(factory.member(User::Alice))
                    .add_state_event(factory.power_levels()),
            );
            sync.add_joined_room(JoinedRoomBuilder::new(other).set_joined_members_count(5));
        })
        .await;
    let (core, events) = watching(&server, &client).await;
    (server, client, core, events, remote)
}

async fn settings(core: &Arc<Core>, room: &RoomId) -> crate::protocol::NotificationSettingsView {
    core.run(SettingsParams {
        room_id: room.to_owned(),
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn dm_defaults_apply_on_startup_to_bridged_and_group_dms_and_respect_room_overrides() {
    let (_server, _client, core, _events, remote) = fixture().await;
    let room = room_id!("!bridge:example.org");
    assert!(remote.0.lock().preference.is_none());
    assert_eq!(
        settings(&core, room).await.default,
        NotificationModeView::Mentions
    );
    let generation = core.lifecycle.current();
    core.watch_notification_settings(generation);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let preference = remote.0.lock().preference.clone();
            if settings(&core, room).await.default == NotificationModeView::All
                && preference.as_ref().is_some_and(|preference| {
                    preference["managed"]["!bridge:example.org"]["pending"].is_null()
                })
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    for room in [room, room_id!("!group:example.org")] {
        assert_eq!(
            settings(&core, room).await.default,
            NotificationModeView::All
        );
        assert!(settings(&core, room).await.room.is_none());
    }
    for mode in [NotificationModeView::Mute, NotificationModeView::Mentions] {
        core.run(SetRoomNotificationModeParams {
            room_id: room.to_owned(),
            mode: Some(mode),
        })
        .await
        .unwrap();
        core.push_rules()
            .await
            .unwrap()
            .reconcile_direct_default()
            .await
            .unwrap();
        assert_eq!(settings(&core, room).await.room, Some(mode));
    }
    core.run(SetRoomNotificationModeParams {
        room_id: room.to_owned(),
        mode: None,
    })
    .await
    .unwrap();
    assert!(settings(&core, room).await.room.is_none());
    assert_eq!(
        settings(&core, room).await.default,
        NotificationModeView::All
    );
    core.run(SetDefaultModeParams {
        direct: true,
        mode: NotificationModeView::Mentions,
    })
    .await
    .unwrap();
    assert_eq!(
        settings(&core, room).await.default,
        NotificationModeView::Mentions
    );
    assert_eq!(
        core.run(DefaultModesParams {}).await.unwrap().direct,
        NotificationModeView::Mentions
    );
    assert_eq!(
        remote.0.lock().preference.as_ref().unwrap()["mode"],
        "mentions"
    );
    core.session_tasks.lock().clear();
}

#[tokio::test]
async fn a_partial_write_is_retried_and_dm_changes_reconcile_on_the_settings_watcher() {
    let (server, client, core, _events, remote) = fixture().await;
    remote.0.lock().fail_rule = true;
    assert!(
        core.run(SetDefaultModeParams {
            direct: true,
            mode: NotificationModeView::All
        })
        .await
        .is_err()
    );
    assert_eq!(remote.0.lock().preference.as_ref().unwrap()["mode"], "all");
    let generation = core.lifecycle.current();
    core.watch_notification_settings(generation);
    tokio::time::timeout(Duration::from_secs(5), async {
        while settings(&core, room_id!("!bridge:example.org"))
            .await
            .default
            != NotificationModeView::All
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    let new_room = room_id!("!new:example.org");
    remote.0.lock().direct =
        BTreeMap::from([("@other:example.org".to_owned(), vec![new_room.to_owned()])]);
    server
        .mock_sync()
        .ok_and_run(&client, |sync| {
            sync.add_global_account_data(
                EventFactory::new()
                    .direct()
                    .add_user(user_id!("@other:example.org").to_owned(), new_room),
            );
            sync.add_joined_room(JoinedRoomBuilder::new(new_room).set_joined_members_count(4));
        })
        .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = core.push_rules().await.unwrap().snapshot().await;
            if snapshot
                .underride
                .iter()
                .any(|rule| rule.rule_id.contains("!new:example.org"))
                && !snapshot
                    .underride
                    .iter()
                    .any(|rule| rule.rule_id.contains("!bridge:example.org"))
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        settings(&core, new_room).await.default,
        NotificationModeView::All
    );
    core.session_tasks.lock().clear();
}

#[tokio::test]
async fn a_dm_default_saved_in_another_session_is_loaded_and_reconciled() {
    let (server, client, core, _events, remote) = fixture().await;
    core.push_rules()
        .await
        .unwrap()
        .reconcile_direct_default()
        .await
        .unwrap();
    let generation = core.lifecycle.current();
    core.watch_notification_settings(generation);
    for mode in ["mentions", "all"] {
        let content = {
            let mut remote = remote.0.lock();
            for id in [
                ".m.rule.room_one_to_one",
                ".m.rule.encrypted_room_one_to_one",
            ] {
                remote
                    .rules
                    .set_actions(
                        RuleKind::Underride,
                        id,
                        if mode == "all" {
                            vec![Action::Notify]
                        } else {
                            vec![]
                        },
                    )
                    .unwrap();
            }
            let mut content = remote.preference.clone().unwrap_or(json!({"managed":{}}));
            content["mode"] = json!(mode);
            remote.preference = Some(content.clone());
            content
        };
        server
            .mock_sync()
            .ok_and_run(&client, |sync| {
                sync.add_custom_global_account_data(
                    json!({"type": PREFERENCE, "content": content}),
                );
            })
            .await;
        let expected = if mode == "all" {
            NotificationModeView::All
        } else {
            NotificationModeView::Mentions
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let preference = remote.0.lock().preference.clone().unwrap();
                if settings(&core, room_id!("!bridge:example.org"))
                    .await
                    .default
                    == expected
                    && preference["managed"]["!bridge:example.org"]["mode"] == mode
                    && preference["managed"]["!bridge:example.org"]["pending"].is_null()
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            core.run(DefaultModesParams {}).await.unwrap().direct,
            expected
        );
    }
    core.session_tasks.lock().clear();
}

#[tokio::test]
async fn an_unmentioned_bridged_message_is_delivered_with_the_automatic_dm_default() {
    let (server, client, core, mut events, remote) = fixture().await;
    core.push_rules()
        .await
        .unwrap()
        .reconcile_direct_default()
        .await
        .unwrap();
    let room = room_id!("!bridge:example.org");
    let event = json!({
        "type":"m.room.message", "event_id":"$bridged", "room_id": room,
        "sender": User::Alice, "origin_server_ts": MilliSecondsSinceUnixEpoch::now(),
        "content":{"msgtype":"m.text", "body":"hello from the bridge", "m.mentions":{}}
    });
    Mock::given(method("GET")).and(path_regex(r"/context/.*bridged$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "event": event, "events_before":[], "events_after":[], "state":[], "start":"s", "end":"e"
        }))).mount(server.server()).await;
    let rules = remote.0.lock().rules.clone();
    server
        .mock_sync()
        .ok_and_run(&client, |sync| {
            sync.add_global_account_data(EventFactory::new().push_rules(rules));
            sync.add_joined_room(
                JoinedRoomBuilder::new(room)
                    .set_joined_members_count(3)
                    .add_timeline_event(
                        matrix_sdk::ruma::serde::Raw::new(&event)
                            .unwrap()
                            .cast_unchecked::<matrix_sdk::ruma::events::AnySyncTimelineEvent>(),
                    ),
            );
        })
        .await;
    let notification = next_notification(&mut events).await;
    assert_eq!(
        notification.event_id.as_deref(),
        Some(matrix_sdk::ruma::event_id!("$bridged"))
    );
    core.session_tasks.lock().clear();
}

#[tokio::test]
async fn automatic_inheritance_preserves_an_existing_mentions_default_and_room_choices() {
    let (_server, _client, core, _events, remote) = fixture().await;
    for id in [
        ".m.rule.room_one_to_one",
        ".m.rule.encrypted_room_one_to_one",
    ] {
        remote
            .0
            .lock()
            .rules
            .set_actions(RuleKind::Underride, id, vec![])
            .unwrap();
    }
    for (room, mode) in [
        (room_id!("!bridge:example.org"), NotificationModeView::Mute),
        (room_id!("!group:example.org"), NotificationModeView::All),
    ] {
        core.run(SetRoomNotificationModeParams {
            room_id: room.to_owned(),
            mode: Some(mode),
        })
        .await
        .unwrap();
    }
    core.push_rules()
        .await
        .unwrap()
        .reconcile_direct_default()
        .await
        .unwrap();
    assert_eq!(
        core.run(DefaultModesParams {}).await.unwrap().direct,
        NotificationModeView::Mentions
    );
    for (room, mode) in [
        (room_id!("!bridge:example.org"), NotificationModeView::Mute),
        (room_id!("!group:example.org"), NotificationModeView::All),
    ] {
        let settings = settings(&core, room).await;
        assert_eq!(settings.default, NotificationModeView::Mentions);
        assert_eq!(settings.room, Some(mode));
    }
    assert_eq!(
        remote.0.lock().preference.as_ref().unwrap()["mode"],
        "mentions"
    );
    core.session_tasks.lock().clear();
}
