use matrix_sdk::ruma::{owned_room_id, owned_server_name, owned_user_id, room_id};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use serde_json::{Value, json};
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, ResponseTemplate};

use super::{
    STABLE, UNSTABLE, answered, carried_prompted, carried_sharing, edited_sharing, hint, keys_for,
    sharing_view, with_prompted,
};
use crate::protocol::{
    PresenceHintView, PresencePromptView, PresenceSharingEdit, PresenceUserSharingView, RpcCode,
    RpcError,
};

#[test]
fn the_stable_flag_wins_over_the_unstable_one() {
    assert_eq!(keys_for(&[]), None);
    assert_eq!(keys_for(&[super::FEATURE]), Some(UNSTABLE));
    assert_eq!(
        keys_for(&[super::FEATURE, super::STABLE_FEATURE]),
        Some(STABLE)
    );
}

#[test]
fn the_view_reads_the_msc_sample() {
    let sharing = json!({
        "share_locally": true,
        "users": {"@alice:example.com": "allow", "@mallory:example.com": "deny"},
        "rooms": {"!family-group-chat": "allow"},
        "servers": {"matrix.org": "deny"},
    });
    let prompted = json!({"users": ["@joey:example.com"], "rooms": ["!apartment"]});

    let view = sharing_view(UNSTABLE, Some(&sharing), Some(&prompted));

    assert!(view.configured);
    assert!(view.share_locally);
    assert_eq!(view.allowed_users, ["@alice:example.com"]);
    assert_eq!(view.denied_users, ["@mallory:example.com"]);
    assert_eq!(view.allowed_rooms, ["!family-group-chat"]);
    assert_eq!(view.denied_servers, ["matrix.org"]);
    assert_eq!(view.prompted_users, ["@joey:example.com"]);
    assert_eq!(view.prompted_rooms, ["!apartment"]);
}

#[test]
fn values_the_msc_forbids_for_a_kind_are_not_listed() {
    let sharing = json!({
        "rooms": {"!a:x": "deny"},
        "servers": {"x": "allow"},
    });

    let view = sharing_view(UNSTABLE, Some(&sharing), None);

    assert_eq!(view.allowed_rooms, Vec::<String>::new());
    assert_eq!(view.denied_servers, Vec::<String>::new());
}

#[test]
fn a_missing_document_is_not_configured() {
    let view = sharing_view(UNSTABLE, None, None);

    assert!(!view.configured);
    assert!(!view.share_locally);
}

#[test]
fn an_edit_keeps_fields_it_does_not_touch() {
    let stored = json!({
        "share_locally": true,
        "users": {"@a:x": "allow"},
        "com.example.extra": 1,
    });

    let edited = edited_sharing(
        Some(stored),
        &PresenceSharingEdit::User {
            user_id: owned_user_id!("@b:x"),
            sharing: Some(PresenceUserSharingView::Deny),
        },
    )
    .unwrap();

    assert_eq!(
        edited,
        json!({
            "share_locally": true,
            "users": {"@a:x": "allow", "@b:x": "deny"},
            "com.example.extra": 1,
        })
    );
}

#[test]
fn an_edit_removes_entries() {
    let stored = json!({
        "users": {"@a:x": "allow"},
        "rooms": {"!r:x": "allow"},
        "servers": {"x": "deny"},
    });
    let edits = [
        PresenceSharingEdit::User {
            user_id: owned_user_id!("@a:x"),
            sharing: None,
        },
        PresenceSharingEdit::Room {
            room_id: owned_room_id!("!r:x"),
            allowed: false,
        },
        PresenceSharingEdit::Server {
            server: owned_server_name!("x"),
            denied: false,
        },
    ];

    let edited = edits.iter().fold(stored, |content, edit| {
        edited_sharing(Some(content), edit).unwrap()
    });

    assert_eq!(edited, json!({"users": {}, "rooms": {}, "servers": {}}));
}

#[test]
fn an_edit_that_changes_nothing_is_not_written() {
    let stored = json!({"share_locally": false, "servers": {"x": "deny"}});

    assert!(
        edited_sharing(
            Some(stored.clone()),
            &PresenceSharingEdit::ShareLocally { enabled: false }
        )
        .is_none()
    );
    assert!(
        edited_sharing(
            Some(stored),
            &PresenceSharingEdit::Server {
                server: owned_server_name!("x"),
                denied: true,
            }
        )
        .is_none()
    );
}

#[test]
fn a_first_edit_creates_the_document_even_for_a_default() {
    let edited =
        edited_sharing(None, &PresenceSharingEdit::ShareLocally { enabled: false }).unwrap();

    assert_eq!(edited, json!({"share_locally": false}));
}

#[test]
fn a_prompt_is_recorded_once() {
    let prompt = PresencePromptView::User {
        user_id: owned_user_id!("@a:x"),
    };

    let recorded = with_prompted(Some(json!({"rooms": ["!r:x"]})), &prompt).unwrap();

    assert_eq!(recorded, json!({"rooms": ["!r:x"], "users": ["@a:x"]}));
    assert!(with_prompted(Some(recorded), &prompt).is_none());
}

#[test]
fn a_missing_or_unknown_hint_forbids() {
    assert_eq!(hint(None), PresenceHintView::Forbid);
    assert_eq!(hint(Some(&json!({}))), PresenceHintView::Forbid);
    assert_eq!(
        hint(Some(&json!({"presence_sharing": "always"}))),
        PresenceHintView::Forbid
    );
    assert_eq!(
        hint(Some(&json!({"presence_sharing": "suggest"}))),
        PresenceHintView::Suggest
    );
}

#[test]
fn an_answer_in_a_predecessor_counts_for_the_room() {
    let view = sharing_view(UNSTABLE, None, Some(&json!({"rooms": ["!old:x"]})));
    let prompt = PresencePromptView::Room {
        room_id: owned_room_id!("!new:x"),
    };

    assert!(!answered(&view, &prompt, &[]));
    assert!(answered(&view, &prompt, &[owned_room_id!("!old:x")]));
}

#[test]
fn any_entry_for_a_user_answers_their_prompt() {
    let prompt = PresencePromptView::User {
        user_id: owned_user_id!("@a:x"),
    };

    for sharing in [
        json!({"users": {"@a:x": "deny"}}),
        json!({"users": {"@a:x": "allow"}}),
    ] {
        assert!(answered(
            &sharing_view(UNSTABLE, Some(&sharing), None),
            &prompt,
            &[]
        ));
    }
    assert!(!answered(&sharing_view(UNSTABLE, None, None), &prompt, &[]));
}

#[test]
fn an_upgrade_carries_the_room_answers() {
    let new = owned_room_id!("!new:x");

    let sharing = carried_sharing(
        Some(json!({"rooms": {"!old:x": "allow"}})),
        room_id!("!old:x"),
        &new,
    );
    let prompted = carried_prompted(Some(json!({"rooms": ["!old:x"]})), room_id!("!old:x"), &new);

    assert_eq!(
        sharing,
        Some(json!({"rooms": {"!old:x": "allow", "!new:x": "allow"}}))
    );
    assert_eq!(prompted, Some(json!({"rooms": ["!old:x", "!new:x"]})));
    assert_eq!(carried_sharing(None, room_id!("!old:x"), &new), None);
    assert_eq!(
        carried_prompted(Some(json!({"rooms": []})), room_id!("!old:x"), &new),
        None
    );
}

async fn advertise(server: &MatrixMockServer, features: Value) {
    Mock::given(method("GET"))
        .and(path("/_matrix/client/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "versions": ["v1.19"],
            "unstable_features": features,
        })))
        .mount(server.server())
        .await;
}

async fn put_body(server: &MatrixMockServer, suffix: &str) -> Option<Value> {
    server
        .server()
        .received_requests()
        .await
        .unwrap()
        .iter()
        .rev()
        .find(|request| request.method.as_str() == "PUT" && request.url.path().ends_with(suffix))
        .map(|request| serde_json::from_slice(&request.body).unwrap())
}

#[tokio::test]
async fn sharing_is_absent_without_server_support() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().no_server_versions().build().await;
    advertise(&server, json!({})).await;
    let (core, _) = crate::test_support::signed_in_core(&server, client).await;
    let session = core.signed_in().unwrap();

    assert_eq!(session.presence_sharing().await.unwrap(), None);
    assert!(matches!(
        session
            .edit_presence_sharing(&PresenceSharingEdit::ShareLocally { enabled: true })
            .await,
        Err(RpcError {
            code: RpcCode::Failed { .. },
            ..
        })
    ));
}

#[tokio::test]
async fn an_edit_writes_the_unstable_document() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().no_server_versions().build().await;
    advertise(
        &server,
        json!({"org.continuwuity.presence_v2.msc4495": true}),
    )
    .await;
    Mock::given(method("GET"))
        .and(path_regex(format!(
            "/account_data/{}$",
            regex_lite::escape(UNSTABLE.sharing)
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"users": {"@a:x": "allow"}})))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/account_data/"))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "not found"})),
        )
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/account_data/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(server.server())
        .await;
    let (core, _) = crate::test_support::signed_in_core(&server, client).await;
    let session = core.signed_in().unwrap();

    let view = session
        .edit_presence_sharing(&PresenceSharingEdit::ShareLocally { enabled: true })
        .await
        .unwrap();

    assert!(view.share_locally);
    assert_eq!(view.allowed_users, ["@a:x"]);
    assert_eq!(
        put_body(&server, UNSTABLE.sharing).await,
        Some(json!({"users": {"@a:x": "allow"}, "share_locally": true}))
    );
}

#[tokio::test]
async fn the_stable_flag_writes_stable_and_reads_the_unstable_fallback() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().no_server_versions().build().await;
    advertise(
        &server,
        json!({
            "org.continuwuity.presence_v2.msc4495": true,
            "org.continuwuity.presence_v2.msc4495.stable": true,
        }),
    )
    .await;
    Mock::given(method("GET"))
        .and(path_regex(format!(
            "/account_data/{}$",
            regex_lite::escape(UNSTABLE.sharing)
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"servers": {"x": "deny"}})))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/account_data/"))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "not found"})),
        )
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/account_data/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .mount(server.server())
        .await;
    let (core, _) = crate::test_support::signed_in_core(&server, client).await;
    let session = core.signed_in().unwrap();

    session
        .edit_presence_sharing(&PresenceSharingEdit::ShareLocally { enabled: true })
        .await
        .unwrap();

    assert_eq!(
        put_body(&server, STABLE.sharing).await,
        Some(json!({"servers": {"x": "deny"}, "share_locally": true}))
    );
    assert_eq!(put_body(&server, UNSTABLE.sharing).await, None);
}

#[tokio::test]
async fn a_suggesting_dm_prompts_about_its_other_member() {
    use matrix_sdk_test::{JoinedRoomBuilder, event_factory::EventFactory};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().no_server_versions().build().await;
    advertise(
        &server,
        json!({"org.continuwuity.presence_v2.msc4495": true}),
    )
    .await;
    let room_id = owned_room_id!("!dm:example.org");
    let own = client.user_id().unwrap().to_owned();
    let partner = owned_user_id!("@bob:example.org");
    let factory = EventFactory::new().room(&room_id);
    let hint = ruma::serde::Raw::new(&json!({
        "type": UNSTABLE.hint,
        "state_key": "",
        "sender": own,
        "event_id": "$hint",
        "origin_server_ts": 1,
        "content": {"presence_sharing": "suggest"},
    }))
    .unwrap()
    .cast_unchecked();
    server
        .mock_sync()
        .ok_and_run(&client, |sync| {
            sync.add_global_account_data(
                EventFactory::new()
                    .direct()
                    .add_user(partner.clone(), &room_id),
            );
            sync.add_joined_room(
                JoinedRoomBuilder::new(&room_id)
                    .add_state_event(factory.member(&own).sender(&own))
                    .add_state_event(factory.member(&partner).sender(&partner))
                    .add_state_bulk([hint]),
            );
        })
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/account_data/"))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "not found"})),
        )
        .mount(server.server())
        .await;
    let (core, _) = crate::test_support::signed_in_core(&server, client).await;
    let session = core.signed_in().unwrap();

    assert_eq!(
        session.presence_prompt(&room_id).await.unwrap(),
        Some(PresencePromptView::User { user_id: partner })
    );
}
