use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::ruma::{event_id, serde::Raw, user_id};
use serde_json::json;

use super::{can_annotate, group_reactions, is_redacted, shortcodes};

#[test]
fn group_reactions_preserves_order_and_deduplicates_senders() {
    let rx = |ty, sender, target, key| {
        json!({
            "type": ty,
            "sender": sender,
            "content": { "m.relates_to": { "rel_type": "m.annotation", "event_id": target, "key": key } }
        })
    };
    let events = [
        rx("m.reaction", "@alice:example.org", "$target", "👍"),
        rx("m.reaction", "@alice:example.org", "$target", "👍"),
        rx("m.reaction", "@bob:example.org", "$target", "🎉"),
        rx("m.reaction", "@bob:example.org", "$other", "🚀"),
        rx("m.room.message", "@bob:example.org", "$target", "🤖"),
    ];
    let groups = group_reactions(&events, event_id!("$target"));
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].key, "👍");
    assert_eq!(groups[0].senders, [user_id!("@alice:example.org")]);
    assert_eq!(groups[1].key, "🎉");
    assert_eq!(groups[1].senders, [user_id!("@bob:example.org")]);
}

#[test]
fn annotation_targets_are_checked_by_relation_type() {
    for (relation, allowed) in [
        (
            json!({"rel_type": "m.annotation", "event_id": "$original"}),
            false,
        ),
        (
            json!({"rel_type": "m.replace", "event_id": "$original"}),
            false,
        ),
        (
            json!({"rel_type": "m.thread", "event_id": "$original"}),
            true,
        ),
        (
            json!({"rel_type": "m.reference", "event_id": "$original"}),
            true,
        ),
        (json!({"m.in_reply_to": {"event_id": "$original"}}), true),
        (serde_json::Value::Null, true),
    ] {
        let event = Raw::new(&json!({
            "type": "com.example.custom",
            "content": {"m.relates_to": relation},
        }))
        .unwrap();
        assert_eq!(can_annotate(&event), allowed);
    }
}

#[tokio::test]
#[cfg(not(target_family = "wasm"))]
async fn reaction_ids_follow_pages_and_match_sender_and_key() {
    use matrix_sdk::{ruma::room_id, test_utils::mocks::MatrixMockServer};
    use matrix_sdk_test::JoinedRoomBuilder;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path_regex, query_param, query_param_is_missing},
    };

    let reaction = |id: &str, sender: &str, key: &str, target: &str| {
        json!({
            "type": "m.reaction", "event_id": id, "sender": sender,
            "content": {"m.relates_to": {
                "rel_type": "m.annotation", "event_id": target, "key": key,
            }},
        })
    };
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!reactions:example.org");
    server
        .sync_room(&client, JoinedRoomBuilder::new(room_id))
        .await;
    let relations = "/_matrix/client/v1/rooms/.*/relations/.*/m.annotation";
    Mock::given(method("GET"))
        .and(path_regex(relations))
        .and(query_param_is_missing("from"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "chunk": [
                reaction("$mine", "@me:example.org", "👍", "$target"),
                reaction("$other_sender", "@you:example.org", "👍", "$target"),
                reaction("$other_key", "@me:example.org", "🎉", "$target"),
            ],
            "next_batch": "page2",
        })))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(relations))
        .and(query_param("from", "page2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "chunk": [
                reaction("$again", "@me:example.org", "👍", "$target"),
                reaction("$other_target", "@me:example.org", "👍", "$elsewhere"),
            ],
        })))
        .expect(1)
        .mount(server.server())
        .await;
    let core = crate::test_support::signed_in_core(&server, client).await.0;
    let session = core.signed_in().unwrap();

    let ids = session
        .reaction_event_ids(
            &room_id.to_owned(),
            &event_id!("$target").to_owned(),
            "👍",
            user_id!("@me:example.org"),
        )
        .await
        .unwrap();
    assert_eq!(ids, [event_id!("$mine"), event_id!("$again")]);
}

#[tokio::test]
#[cfg(not(target_family = "wasm"))]
async fn a_reaction_outside_the_timeline_is_sent_then_taken_back() {
    use matrix_sdk::{ruma::room_id, test_utils::mocks::MatrixMockServer};
    use matrix_sdk_test::JoinedRoomBuilder;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{body_partial_json, method, path_regex},
    };

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let me = client.user_id().unwrap().to_owned();
    let room_id = room_id!("!old-post:example.org");
    server
        .sync_room(&client, JoinedRoomBuilder::new(room_id))
        .await;
    server.mock_room_state_encryption().plain().mount().await;
    let relations = "/_matrix/client/v1/rooms/.*/relations/.*/m.annotation";
    let relation = json!({"rel_type": "m.annotation", "event_id": "$post", "key": "👍"});
    let none = Mock::given(method("GET"))
        .and(path_regex(relations))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
        .mount_as_scoped(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex("/_matrix/client/v3/rooms/.*/send/m.reaction/.*"))
        .and(body_partial_json(
            json!({"m.relates_to": relation, "shortcode": ":up:"}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$mine"})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = crate::test_support::signed_in_core(&server, client).await.0;
    let session = core.signed_in().unwrap();
    let toggle = |extra| {
        let session = &session;
        async move {
            session
                .toggle_reaction_outside_timeline(
                    &room_id.to_owned(),
                    &event_id!("$post").to_owned(),
                    "👍",
                    extra,
                )
                .await
                .unwrap()
        }
    };

    let extra = serde_json::Map::from_iter([("shortcode".to_owned(), json!(":up:"))]);
    assert!(toggle(Some(extra)).await);

    drop(none);
    Mock::given(method("GET"))
        .and(path_regex(relations))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [{
            "type": "m.reaction", "event_id": "$mine", "sender": me,
            "content": {"m.relates_to": relation},
        }]})))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex("/_matrix/client/v3/rooms/.*/redact/.*mine/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$gone"})))
        .expect(1)
        .mount(server.server())
        .await;
    assert!(!toggle(None).await);
}

#[tokio::test]
#[cfg(not(target_family = "wasm"))]
async fn reacting_to_a_message_the_timeline_has_not_loaded_sends_the_reaction() {
    use matrix_sdk::{ruma::room_id, test_utils::mocks::MatrixMockServer};
    use matrix_sdk_test::JoinedRoomBuilder;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{body_partial_json, method, path_regex},
    };

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!old-post:example.org");
    server
        .sync_room(&client, JoinedRoomBuilder::new(room_id))
        .await;
    server.mock_room_state_encryption().plain().mount().await;
    Mock::given(method("GET"))
        .and(path_regex("/_matrix/client/v3/rooms/.*/event/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "type": "m.room.message", "event_id": "$post", "sender": "@ana:example.org",
            "origin_server_ts": 1, "room_id": room_id,
            "content": {"msgtype": "m.text", "body": "an old post"},
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            "/_matrix/client/v1/rooms/.*/relations/.*/m.annotation",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex("/_matrix/client/v3/rooms/.*/send/m.reaction/.*"))
        .and(body_partial_json(json!({"m.relates_to": {
            "rel_type": "m.annotation", "event_id": "$post", "key": "👍",
        }})))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$mine"})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = crate::test_support::signed_in_core(&server, client).await.0;

    core.run(crate::api::messages::ReactParams {
        room_id: room_id.to_owned(),
        event_id: event_id!("$post").to_owned(),
        key: "👍".to_owned(),
        source_pack: None,
        shortcode: None,
        thread_root: None,
        subscription: None,
        persona: None,
    })
    .await
    .unwrap();
}

#[tokio::test]
#[cfg(not(target_family = "wasm"))]
async fn reaction_pagination_that_repeats_a_token_fails() {
    use matrix_sdk::{ruma::room_id, test_utils::mocks::MatrixMockServer};
    use matrix_sdk_test::JoinedRoomBuilder;
    use wiremock::{Mock, ResponseTemplate, matchers::method, matchers::path_regex};

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!reactions:example.org");
    server
        .sync_room(&client, JoinedRoomBuilder::new(room_id))
        .await;
    Mock::given(method("GET"))
        .and(path_regex(
            "/_matrix/client/v1/rooms/.*/relations/.*/m.annotation",
        ))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"chunk": [], "next_batch": "stuck"})),
        )
        .mount(server.server())
        .await;
    let core = crate::test_support::signed_in_core(&server, client).await.0;
    let session = core.signed_in().unwrap();

    let result = session
        .reaction_event_ids(
            &room_id.to_owned(),
            &event_id!("$target").to_owned(),
            "👍",
            user_id!("@me:example.org"),
        )
        .await;
    result.unwrap_err();
}

#[tokio::test]
#[cfg(not(target_family = "wasm"))]
#[expect(
    clippy::too_many_lines,
    reason = "one sequential flow kept in a single function"
)]
async fn nested_reactions_are_ignored() {
    use std::sync::Arc;

    use crate::{
        Core,
        api::timeline::TimelineFocusView,
        protocol::{RpcCode, RpcError},
        session::Session,
        store::MemorySessionStore,
    };
    use matrix_sdk::{
        ruma::{event_id, room_id},
        test_utils::mocks::MatrixMockServer,
    };
    use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
    use matrix_sdk_ui::sync_service::SyncService;

    for reactions_first in [false, true] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        let room_id = room_id!("!reactions:example.org");
        let factory = EventFactory::new().room(room_id).sender(User::Alice);
        let original = event_id!("$original");
        let annotation = event_id!("$annotation");
        let replacement = event_id!("$replacement");
        let edit = event_id!("$edit");
        let reaction = event_id!("$reaction");
        let custom = |event_id, relation| {
            Raw::new(&json!({
                "type": "com.example.custom", "event_id": event_id,
                "sender": User::Alice, "origin_server_ts": 1,
                "content": {"m.relates_to": {"rel_type": relation, "event_id": original}},
            }))
            .unwrap()
            .cast_unchecked()
        };
        let image_reaction = |target, event_id| {
            Raw::new(&json!({
                    "type": "m.reaction", "event_id": event_id,
                    "sender": User::Alice, "origin_server_ts": 2,
                    "content": {
                        "shortcode": "invalid",
                        "m.relates_to": {"rel_type": "m.annotation", "event_id": target, "key": "mxc://example.org/invalid"},
                    },
                }))
                .unwrap()
                .cast_unchecked()
        };
        let targets = [
            factory.text_msg("original").event_id(original).into_raw(),
            custom(annotation, "m.annotation"),
            custom(replacement, "m.replace"),
            factory
                .text_msg("edited")
                .edit(
                    original,
                    ruma::events::room::message::RoomMessageEventContent::text_plain("edited")
                        .into(),
                )
                .event_id(edit)
                .into_raw(),
            factory
                .reaction(original, "👍")
                .event_id(reaction)
                .into_raw(),
        ];
        let annotations = [
            image_reaction(annotation, event_id!("$nested")),
            image_reaction(replacement, event_id!("$on-replacement")),
            factory
                .reaction(edit, "👎")
                .event_id(event_id!("$on-edit"))
                .into_raw(),
            image_reaction(reaction, event_id!("$on-reaction")),
        ];
        let events = if reactions_first {
            annotations.into_iter().chain(targets).collect::<Vec<_>>()
        } else {
            targets.into_iter().chain(annotations).collect::<Vec<_>>()
        };
        let mut joined = JoinedRoomBuilder::new(room_id);
        for event in events {
            joined = joined.add_timeline_event(event);
        }
        let room = server.sync_room(&client, joined).await;
        let timeline = crate::timelines::build_room_timeline(&room, &TimelineFocusView::Live, true)
            .await
            .unwrap();
        let views = timeline
            .items()
            .await
            .iter()
            .map(|item| {
                crate::view::timeline_item(
                    item,
                    client.user_id(),
                    &crate::view::Highlights::default(),
                    &crate::view::LocalContent::default(),
                )
            })
            .collect::<Vec<_>>();
        let original_view = views
            .iter()
            .find(|item| item.event_id.as_deref() == Some(original))
            .unwrap();
        assert_eq!(original_view.reactions.len(), 1);
        assert_eq!(original_view.reactions[0].key, "👍");
        assert!(matches!(
            &original_view.content,
            crate::protocol::TimelineItemContentView::Message { edited: true, .. }
        ));
        assert!(
            views
                .iter()
                .filter(|item| item.event_id.as_deref() != Some(original))
                .all(|item| item.reactions.is_empty())
        );

        let (core, _events) = Core::new("reactions-test", Box::new(MemorySessionStore::default()));
        crate::test_support::set_session(
            &core,
            Some(Session {
                account_id: "test".to_owned(),
                sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
                client,
                homeserver: server.server().uri(),
                oauth: false,
                state: Arc::default(),
            }),
        );
        let session = core.signed_in().unwrap();
        session
            .ensure_reaction_target(&room_id.to_owned(), &original.to_owned())
            .await
            .unwrap();
        assert!(
            session
                .reaction_shortcodes(&room_id.to_owned(), &original.to_owned())
                .await
                .unwrap()
                .is_empty()
        );
        for target in [annotation, replacement, edit, reaction] {
            assert!(
                session
                    .reaction_shortcodes(&room_id.to_owned(), &target.to_owned())
                    .await
                    .unwrap()
                    .is_empty()
            );
            assert!(matches!(
                Box::pin(core.run(crate::api::messages::ReactParams {
                    persona: None,
                    room_id: room_id.to_owned(),
                    event_id: target.to_owned(),
                    key: "👍".to_owned(),
                    source_pack: None,
                    shortcode: None,
                    thread_root: None,
                    subscription: None,
                }))
                .await,
                Err(RpcError {
                    code: RpcCode::Unsupported,
                    ..
                })
            ));
        }
    }
}

fn raw(event: &serde_json::Value) -> Raw<serde_json::Value> {
    Raw::new(event).expect("raw event")
}

#[test]
fn a_redaction_marker_counts_even_when_null_and_wrong_shapes_read_as_absent() {
    assert!(is_redacted(&raw(
        &json!({ "unsigned": { "redacted_because": null } })
    )));
    assert!(!is_redacted(&raw(&json!({ "unsigned": {} }))));
    assert!(!is_redacted(&raw(&json!({ "unsigned": "x" }))));
    assert!(can_annotate(&raw(
        &json!({ "content": { "m.relates_to": "x" } })
    )));
    assert!(can_annotate(&raw(&json!({ "content": "x" }))));
    assert!(!can_annotate(&raw(&json!({
        "content": { "m.relates_to": { "rel_type": "m.replace" } }
    }))));
}

fn reaction(key: &str, shortcode: Option<&str>) -> TimelineEvent {
    reaction_to(key, shortcode, "$target")
}

fn reaction_to(key: &str, shortcode: Option<&str>, target: &str) -> TimelineEvent {
    let mut content = json!({
        "m.relates_to": { "rel_type": "m.annotation", "event_id": target, "key": key },
    });
    if let Some(shortcode) = shortcode {
        content["shortcode"] = json!(shortcode);
    }
    TimelineEvent::from_plaintext(
        Raw::new(&json!({
            "type": "m.reaction",
            "event_id": format!("${key}{}", shortcode.unwrap_or_default()),
            "sender": "@alice:example.org",
            "origin_server_ts": 1,
            "content": content,
        }))
        .unwrap_or_else(|error| panic!("{error}"))
        .cast_unchecked(),
    )
}

#[test]
fn test_each_custom_key_takes_the_first_shortcode_it_was_sent_with() {
    let found = shortcodes(
        &[
            reaction("mxc://example.org/parrot", Some(":partyparrot:")),
            reaction("mxc://example.org/parrot", Some(":other:")),
            reaction("mxc://example.org/cat", Some("blobcat")),
        ],
        event_id!("$target"),
    );

    let pairs: Vec<_> = found
        .iter()
        .map(|view| (view.key.as_str(), view.shortcode.as_str()))
        .collect();
    assert_eq!(
        pairs,
        [
            ("mxc://example.org/cat", "blobcat"),
            ("mxc://example.org/parrot", "partyparrot"),
        ]
    );
}

#[test]
fn test_emoji_keys_and_reactions_without_a_shortcode_are_skipped() {
    let found = shortcodes(
        &[
            reaction("👍", Some(":thumbsup:")),
            reaction("mxc://example.org/nameless", None),
            reaction("mxc://example.org/blank", Some("::")),
        ],
        event_id!("$target"),
    );

    assert!(found.is_empty());
}

#[test]
fn test_an_oversized_shortcode_is_cut_to_100_bytes() {
    let long = "é".repeat(80);
    let found = shortcodes(
        &[reaction("mxc://example.org/long", Some(&long))],
        event_id!("$target"),
    );

    assert_eq!(found.first().map(|view| view.shortcode.len()), Some(100));
}

#[test]
fn shortcodes_exclude_nested_reactions() {
    let found = shortcodes(
        &[
            reaction_to("mxc://example.org/parrot", Some("wrong"), "$reaction"),
            reaction("mxc://example.org/parrot", Some("parrot")),
            reaction_to("mxc://example.org/cat", Some("cat"), "$edit"),
        ],
        event_id!("$target"),
    );

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].shortcode, "parrot");
}
#[tokio::test]
#[cfg(not(target_family = "wasm"))]
async fn a_redacted_message_shows_no_reactions() {
    use matrix_sdk::{
        ruma::{event_id, room_id},
        test_utils::mocks::MatrixMockServer,
    };
    use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
    use matrix_sdk_ui::timeline::RoomExt as _;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    server.mock_room_state_encryption().plain().mount().await;
    let room_id = room_id!("!redacted:example.org");
    let me = client.user_id().unwrap().to_owned();
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    let target = event_id!("$target");
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("hi").event_id(target))
                .add_timeline_event(factory.redaction(target).event_id(event_id!("$redaction"))),
        )
        .await;
    let timeline = room.timeline().await.unwrap();
    let reactions = |items: Vec<std::sync::Arc<matrix_sdk_ui::timeline::TimelineItem>>| {
        items
            .iter()
            .find(|item| item.as_event().and_then(|e| e.event_id()) == Some(target))
            .map(|item| item.as_event().unwrap().reactions().len())
    };
    let item_id = timeline
        .items()
        .await
        .iter()
        .find_map(|item| item.as_event().filter(|e| e.event_id() == Some(target)))
        .unwrap()
        .identifier();

    server
        .mock_room_send()
        .ok(event_id!("$reaction"))
        .mock_once()
        .mount()
        .await;
    timeline.toggle_reaction(&item_id, "👍").await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                EventFactory::new()
                    .room(room_id)
                    .sender(&me)
                    .reaction(target, "👍")
                    .event_id(event_id!("$reaction")),
            ),
        )
        .await;
    assert_eq!(
        reactions(timeline.items().await.iter().cloned().collect()),
        Some(1)
    );

    let views = timeline
        .items()
        .await
        .iter()
        .map(|item| {
            crate::view::timeline_item(
                item,
                client.user_id(),
                &crate::view::Highlights::default(),
                &crate::view::LocalContent::default(),
            )
        })
        .collect::<Vec<_>>();
    let view = views
        .iter()
        .find(|item| item.event_id.as_deref() == Some(target))
        .unwrap();
    assert!(view.reactions.is_empty());
}
