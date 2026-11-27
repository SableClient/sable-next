#[test]
fn an_undecryptable_version_is_left_out_of_the_edit_history() {
    use matrix_sdk::deserialized_responses::{
        TimelineEvent, UnableToDecryptInfo, UnableToDecryptReason,
    };

    let raw = serde_json::from_value(serde_json::json!({
        "type": "m.room.encrypted",
        "event_id": "$utd",
        "sender": "@alice:example.org",
        "origin_server_ts": 1,
        "content": { "algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "x" },
    }))
    .unwrap();
    let utd = TimelineEvent::from_utd(
        raw,
        UnableToDecryptInfo {
            session_id: None,
            reason: UnableToDecryptReason::Unknown,
        },
    );
    assert!(super::edit_version(&utd, false).is_none());
}
use parking_lot::Mutex;
use std::sync::Arc;

use matrix_sdk::{
    ruma::{event_id, room_id, user_id},
    test_utils::mocks::MatrixMockServer,
};
use serde_json::{Value, json};

use wiremock::{
    Mock, ResponseTemplate,
    matchers::{method, path},
};

#[test]
fn a_caption_edit_keeps_the_spoiler_and_its_reason() {
    let content = json!({
        "body": "photo.png",
        "page.codeberg.everypizza.msc4193.spoiler": true,
        "page.codeberg.everypizza.msc4193.spoiler.reason": "plot",
    });

    let kept = super::spoiler_keys(&content);

    assert_eq!(kept.len(), 2);
    assert_eq!(
        kept["page.codeberg.everypizza.msc4193.spoiler.reason"],
        "plot"
    );
    assert!(super::spoiler_keys(&json!({"body": "x"})).is_empty());
}

use crate::Core;

fn object(value: Value) -> serde_json::Map<String, Value> {
    let Value::Object(map) = value else {
        panic!("expected an object")
    };
    map
}

#[test]
fn forwarding_writes_msc4553_with_the_original_content() {
    let source = object(json!({
        "msgtype": "m.text",
        "body": "> <@bob:x> quoted\n\nanswer",
        "format": "org.matrix.custom.html",
        "formatted_body": "<mx-reply><blockquote>quoted</blockquote></mx-reply>answer",
        "m.relates_to": { "m.in_reply_to": { "event_id": "$parent" } },
        "m.mentions": { "user_ids": ["@bob:x"] },
        "page.codeberg.everypizza.msc4193.spoiler": true,
    }));
    let origin = object(
        json!({ "origin_server_ts": 7, "room_id": "!r:x", "event_id": "$e", "sender": "@alice:x" }),
    );

    let route = super::Route::new([matrix_sdk::ruma::server_name!("a.example").to_owned()]);
    let content = Value::Object(super::forward_content(source, origin, route.as_ref(), None));

    assert_eq!(
        content["org.matrix.msc4553.forwarded"],
        json!({
            "origin_server_ts": 7, "room_id": "!r:x", "event_id": "$e", "sender": "@alice:x",
            "content": {
                "msgtype": "m.text",
                "body": "answer",
                "format": "org.matrix.custom.html",
                "formatted_body": "answer",
                "m.relates_to": { "m.in_reply_to": { "event_id": "$parent" } },
                "m.mentions": { "user_ids": ["@bob:x"] },
                "page.codeberg.everypizza.msc4193.spoiler": true,
            }
        })
    );
    assert_eq!(
        content["body"],
        "Forwarded from @alice:x - view original message: https://matrix.to/#/!r%3Ax/%24e?via=a.example\nanswer"
    );
    assert_eq!(
        content["formatted_body"],
        "<strong>Forwarded from <a href=\"https://matrix.to/#/%40alice%3Ax\">@alice:x</a> - <a href=\"https://matrix.to/#/!r%3Ax/%24e?via=a.example\">view original message</a></strong><br><blockquote>answer</blockquote>"
    );
    assert_eq!(content["format"], "org.matrix.custom.html");
    assert_eq!(content["m.mentions"], json!({}));
    assert_eq!(content["page.codeberg.everypizza.msc4193.spoiler"], true);
    assert!(content.get("m.relates_to").is_none());
    assert!(content.get("com.famedly.app.forwarded").is_none());
    assert_eq!(
        content["moe.sable.message.forward"],
        json!({
            "v": 1,
            "is_forwarded": true,
            "original_timestamp": 7,
            "original_room_id": "!r:x",
            "original_event_id": "$e",
            "original_event_private": false,
        })
    );
}

#[test]
fn forwarding_keeps_the_original_profile_inside_the_forwarded_content() {
    for key in ["com.beeper.per_message_profile", "m.per_message_profile"] {
        for (event_type, mut source) in [
            (
                "m.room.message",
                json!({ "msgtype": "m.text", "body": "hello" }),
            ),
            (
                "m.sticker",
                json!({ "body": "seal", "url": "mxc://example.org/seal", "info": {} }),
            ),
        ] {
            source[key] =
                json!({ "displayname": "Alice", "avatar_url": "mxc://example.org/alice" });
            let content = Value::Object(super::forward_content_for_event(
                object(source.clone()),
                object(json!({})),
                event_type,
                None,
                None,
            ));

            assert!(crate::view::per_message_profile(Some(&content)).is_none());
            assert_eq!(content["org.matrix.msc4553.forwarded"]["content"], source);

            let forwarded_again = Value::Object(super::forward_content_for_event(
                object(content.clone()),
                object(json!({ "sender": "@bob:example.org" })),
                event_type,
                None,
                None,
            ));
            assert!(crate::view::per_message_profile(Some(&forwarded_again)).is_none());
            assert_eq!(
                forwarded_again["org.matrix.msc4553.forwarded"],
                content["org.matrix.msc4553.forwarded"]
            );
        }
    }
}

#[test]
fn forwarding_a_sticker_keeps_its_event_content_without_a_text_fallback() {
    let sticker = json!({
        "body": "seal",
        "url": "mxc://example.org/seal",
        "info": {}
    });
    let content = Value::Object(super::forward_content_for_event(
        object(sticker.clone()),
        object(json!({ "origin_server_ts": 7 })),
        "m.sticker",
        None,
        None,
    ));

    assert_eq!(content["body"], "seal");
    assert!(content.get("format").is_none());
    assert_eq!(content["m.mentions"], json!({}));
    assert_eq!(content["org.matrix.msc4553.forwarded"]["content"], sticker);
    assert!(super::is_valid_forward_content(
        &content["org.matrix.msc4553.forwarded"]["content"],
        "m.sticker"
    ));
}

#[test]
fn forwarding_from_a_private_room_omits_the_ids_in_both_objects() {
    let source = object(json!({ "msgtype": "m.text", "body": "hi" }));
    let origin = object(json!({ "origin_server_ts": 7 }));

    let content = Value::Object(super::forward_content(source, origin, None, None));

    assert_eq!(content["body"], "Forwarded message\nhi");
    assert_eq!(
        content["moe.sable.message.forward"],
        json!({
            "v": 1,
            "is_forwarded": true,
            "original_timestamp": 7,
            "original_event_private": true,
        })
    );
    assert_eq!(
        content["org.matrix.msc4553.forwarded"]["origin_server_ts"],
        7
    );
    assert!(
        content["org.matrix.msc4553.forwarded"]
            .get("room_id")
            .is_none()
    );
}

#[test]
fn the_original_permalink_carries_the_routing_servers() {
    let route = super::Route::new([
        matrix_sdk::ruma::server_name!("a.example").to_owned(),
        matrix_sdk::ruma::server_name!("b.example").to_owned(),
    ]);
    let origin = object(json!({ "room_id": "!r:x", "event_id": "$e" }));

    let content = super::forward_content(
        object(json!({ "msgtype": "m.text", "body": "hi" })),
        origin,
        route.as_ref(),
        None,
    );

    assert_eq!(
        content["body"],
        "Forwarded message - view original message: https://matrix.to/#/!r%3Ax/%24e?via=a.example&via=b.example\nhi"
    );
}

#[test]
fn a_forwarded_emote_reads_as_text_by_its_sender() {
    let source = object(json!({ "msgtype": "m.emote", "body": "waves" }));
    let origin = object(json!({ "sender": "@alice:example.org" }));

    let content = Value::Object(super::forward_content(source, origin, None, Some("Alice")));

    assert_eq!(content["msgtype"], "m.text");
    assert_eq!(
        content["body"],
        "Forwarded from @alice:example.org\nAlice waves"
    );
    assert_eq!(
        content["formatted_body"],
        "<strong>Forwarded from <a href=\"https://matrix.to/#/%40alice%3Aexample.org\">@alice:example.org</a></strong><br><blockquote><em><strong><a href=\"https://matrix.to/#/%40alice%3Aexample.org\">Alice</a></strong> waves</em></blockquote>"
    );
    assert_eq!(
        content["org.matrix.msc4553.forwarded"]["content"]["msgtype"],
        "m.emote"
    );

    let anonymous = Value::Object(super::forward_content(
        object(json!({ "msgtype": "m.emote", "body": "waves" })),
        object(json!({})),
        None,
        None,
    ));
    assert_eq!(anonymous["body"], "Forwarded message\nSender waves");
}

#[test]
fn a_forwarded_file_moves_its_name_to_filename_and_keeps_no_caption() {
    let source = object(json!({
        "msgtype": "m.file", "body": "agenda.pdf", "url": "mxc://example.org/agenda"
    }));
    let origin = object(json!({ "sender": "@alice:example.org" }));

    let content = Value::Object(super::forward_content(source, origin, None, None));

    assert_eq!(content["filename"], "agenda.pdf");
    assert_eq!(content["body"], "Forwarded from @alice:example.org");
    assert_eq!(content["url"], "mxc://example.org/agenda");

    let captioned = Value::Object(super::forward_content(
        object(json!({ "msgtype": "m.image", "body": "sunset", "filename": "a.png" })),
        object(json!({})),
        None,
        None,
    ));
    assert_eq!(captioned["filename"], "a.png");
    assert_eq!(captioned["body"], "Forwarded message\nsunset");
}

#[test]
fn a_location_keeps_its_own_body() {
    let content = Value::Object(super::forward_content(
        object(json!({ "msgtype": "m.location", "body": "Cafe", "geo_uri": "geo:1,2" })),
        object(json!({})),
        None,
        None,
    ));

    assert_eq!(content["body"], "Cafe");
    assert!(content.get("formatted_body").is_none());
}

#[test]
fn forwarding_a_forward_keeps_the_original_attribution() {
    let forwarded = json!({
        "sender": "@alice:x",
        "origin_server_ts": 1,
        "room_name": "Origin",
        "room_avatar_url": "mxc://x/origin",
        "content": {
            "msgtype": "m.text",
            "body": "original",
            "m.relates_to": { "m.in_reply_to": { "event_id": "$parent" } },
            "m.mentions": { "user_ids": ["@carol:x"] }
        }
    });
    let source = object(json!({
        "msgtype": "m.text",
        "body": "fallback",
        "m.mentions": {},
        "org.matrix.msc4553.forwarded": forwarded,
    }));
    let origin = object(json!({ "origin_server_ts": 9, "sender": "@bob:x" }));

    let content = Value::Object(super::forward_content(source, origin, None, None));

    assert_eq!(content["org.matrix.msc4553.forwarded"], forwarded);
    assert_eq!(content["body"], "Forwarded from @alice:x\noriginal");
    assert_eq!(content["m.mentions"], json!({}));
    assert!(content.get("m.relates_to").is_none());
}

#[test]
fn forwarding_a_legacy_forward_keeps_its_origin_and_fills_the_content() {
    let source = object(json!({
        "msgtype": "m.text",
        "body": "hello",
        "com.famedly.app.forwarded": { "origin_server_ts": 1, "room_id": null, "event_id": "$e" },
        "moe.sable.message.forward": { "original_timestamp": 1, "original_event_private": true },
    }));
    let origin = object(json!({ "origin_server_ts": 9 }));

    let content = Value::Object(super::forward_content(source, origin, None, None));

    assert_eq!(
        content["org.matrix.msc4553.forwarded"],
        json!({
            "origin_server_ts": 1,
            "event_id": "$e",
            "content": { "msgtype": "m.text", "body": "hello" }
        })
    );
    assert!(content.get("com.famedly.app.forwarded").is_none());
    assert_eq!(
        content["moe.sable.message.forward"],
        json!({
            "v": 1,
            "is_forwarded": true,
            "original_timestamp": 1,
            "original_event_id": "$e",
            "original_event_private": true,
        })
    );
}

#[test]
fn reprofiling_a_gallery_replaces_its_profile_without_a_name_prefix() {
    let gallery = json!({
        "type": "m.room.message",
        "content": { "msgtype": "dev.mscxxxx.gallery", "body": "trip", "itemtypes": [] },
    });
    let persona = crate::protocol::PerMessageProfileView {
        id: Some("p".to_owned()),
        display_name: Some("Kris".to_owned()),
        avatar_url: None,
        pronouns: Vec::new(),
        color_on_light: None,
        color_on_dark: None,
        has_fallback: true,
        biography: None,
        banner_url: None,
        is_animal: None,
        has_animal: None,
        animal_need: None,
    };
    let edit = super::reprofiled_edit(event_id!("$event"), &gallery, Some(&persona)).unwrap();

    let new_content = &edit["m.new_content"];
    assert_eq!(new_content["body"], "trip");
    assert!(new_content.get("formatted_body").is_none());
    assert_eq!(
        new_content[crate::personas::PER_MESSAGE_PROFILE]["displayname"],
        "Kris"
    );
    assert_eq!(
        edit["m.relates_to"],
        json!({ "rel_type": "m.replace", "event_id": "$event" })
    );

    let cleared = super::reprofiled_edit(
        event_id!("$event"),
        &json!({ "type": "m.room.message", "content": edit }),
        None,
    )
    .unwrap();
    assert!(
        cleared["m.new_content"]
            .get(crate::personas::PER_MESSAGE_PROFILE)
            .is_none()
    );
}

#[test]
fn removing_previews_edits_the_latest_version_with_an_empty_list() {
    let original = json!({
        "type": "m.room.message",
        "content": {
            "msgtype": "m.text",
            "body": "see https://example.org",
            "m.relates_to": { "m.in_reply_to": { "event_id": "$parent" } },
            "com.beeper.linkpreviews": [{ "matched_url": "https://example.org" }],
            "com.beeper.per_message_profile": { "id": "p" },
        },
    });
    let edit = super::previews_removed_edit(event_id!("$event"), &original).unwrap();

    assert_eq!(edit["body"], "* see https://example.org");
    assert_eq!(edit["m.mentions"], json!({}));
    assert_eq!(
        edit["m.relates_to"],
        json!({ "rel_type": "m.replace", "event_id": "$event" })
    );
    let new_content = &edit["m.new_content"];
    assert_eq!(new_content["body"], "see https://example.org");
    assert_eq!(new_content["com.beeper.linkpreviews"], json!([]));
    assert_eq!(
        new_content["com.beeper.per_message_profile"],
        json!({ "id": "p" })
    );
    assert!(new_content.get("m.relates_to").is_none());

    let edited = json!({
        "type": "m.room.message",
        "content": {
            "body": "* fixed https://example.org",
            "m.new_content": { "msgtype": "m.text", "body": "fixed https://example.org" },
            "m.relates_to": { "rel_type": "m.replace", "event_id": "$event" },
        },
    });
    let edit = super::previews_removed_edit(event_id!("$event"), &edited).unwrap();
    assert_eq!(edit["m.new_content"]["body"], "fixed https://example.org");

    let sticker = json!({ "type": "m.sticker", "content": { "body": "hi" } });
    assert!(super::previews_removed_edit(event_id!("$event"), &sticker).is_none());
}

#[test]
fn a_pin_listed_twice_is_kept_once_in_order() {
    let pins = super::unique_pins(vec![
        event_id!("$b").to_owned(),
        event_id!("$a").to_owned(),
        event_id!("$b").to_owned(),
    ]);
    assert_eq!(pins, [event_id!("$b"), event_id!("$a")]);
}

async fn core(server: &MatrixMockServer, client: matrix_sdk::Client) -> Arc<Core> {
    let (core, _events) = crate::test_support::signed_in_core(server, client).await;
    core
}

async fn sent_message(server: &MatrixMockServer) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let requests = server.server().received_requests().await.unwrap();
            if let Some(request) = requests
                .iter()
                .find(|request| request.url.path().contains("/send/m.room.message/"))
            {
                break request.body_json().unwrap();
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn editing_replies_preserves_mentions_without_repinging() {
    for media_caption in [false, true] {
        for threaded in [false, true] {
            for (ping, already_edited) in [(false, false), (true, false), (true, true)] {
                let server = MatrixMockServer::new().await;
                let client = server.client_builder().build().await;
                let sender = client.user_id().unwrap().to_owned();
                let room = room_id!("!reply-edits:example.org");
                let bob = user_id!("@bob:example.org");
                let carol = user_id!("@carol:example.org");
                server.sync_joined_room(&client, room).await;
                server.mock_room_state_encryption().plain().mount().await;
                let mut content = if media_caption {
                    json!({"msgtype": "m.image", "body": "before", "filename": "photo.png", "url": "mxc://example.org/photo"})
                } else {
                    json!({"msgtype": "m.text", "body": "before"})
                };
                content["m.relates_to"] = if threaded {
                    json!({"rel_type": "m.thread", "event_id": "$root", "m.in_reply_to": {"event_id": "$target"}})
                } else {
                    json!({"m.in_reply_to": {"event_id": "$target"}})
                };
                content["m.mentions"] =
                    json!({"user_ids": if ping { vec![bob, carol] } else { vec![carol] }});
                let mut latest = content.clone();
                latest["m.mentions"] = json!({"user_ids": [carol]});
                let target = json!({"msgtype": "m.text", "body": "target"});
                for (id, event_sender, event_content) in [
                    ("$original", sender.as_str(), content),
                    ("$target", bob.as_str(), target),
                ] {
                    Mock::given(method("GET"))
                        .and(path(format!("/_matrix/client/v3/rooms/{room}/event/{id}")))
                        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                            "type": "m.room.message", "event_id": id, "sender": event_sender,
                            "origin_server_ts": 1, "room_id": room, "content": event_content,
                        })))
                        .mount(server.server())
                        .await;
                }
                let replacements = if already_edited {
                    vec![json!({
                        "type": "m.room.message", "event_id": "$previous-edit", "sender": sender,
                        "origin_server_ts": 2, "room_id": room,
                        "content": {
                            "msgtype": "m.text", "body": "* before", "m.mentions": {},
                            "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"},
                            "m.new_content": latest,
                        },
                    })]
                } else {
                    Vec::new()
                };
                Mock::given(method("GET"))
                    .and(path(format!(
                        "/_matrix/client/v1/rooms/{room}/relations/$original/m.replace"
                    )))
                    .respond_with(
                        ResponseTemplate::new(200).set_body_json(json!({"chunk": replacements})),
                    )
                    .mount(server.server())
                    .await;
                server
                    .mock_room_send()
                    .ok(event_id!("$edited"))
                    .expect(1)
                    .mount()
                    .await;
                let core = core(&server, client).await;
                core.run(crate::api::messages::EditParams {
                    room_id: room.to_owned(),
                    event_id: Some(event_id!("$original").to_owned()),
                    transaction_id: None,
                    body: "after".to_owned(),
                    formatted: None,
                    kind: crate::protocol::MessageKind::Text,
                    media_caption,
                    thread_root: threaded.then(|| event_id!("$root").to_owned()),
                    mentions: Vec::new(),
                    mentions_room: false,
                    persona: None,
                    forum_title: None,
                })
                .await
                .unwrap();
                let sent = sent_message(&server).await;
                assert_eq!(sent["m.new_content"]["body"], "after");
                assert_eq!(
                    sent["m.new_content"]["m.mentions"],
                    if ping && !already_edited {
                        json!({"user_ids": [bob]})
                    } else {
                        json!({})
                    }
                );
                assert_eq!(sent["m.mentions"], json!({}));
            }
        }
    }
}

#[tokio::test]
async fn text_edits_preserve_removed_previews_from_the_latest_version() {
    for field in [
        super::BUNDLED_LINK_PREVIEWS,
        super::LEGACY_BUNDLED_LINK_PREVIEWS,
    ] {
        for removed_after_send in [false, true] {
            let server = MatrixMockServer::new().await;
            let client = server.client_builder().build().await;
            let sender = client.user_id().unwrap().to_owned();
            let room = room_id!("!previews:example.org");
            server.sync_joined_room(&client, room).await;
            server.mock_room_state_encryption().plain().mount().await;
            let mut original = json!({
                "type": "m.room.message", "event_id": "$original",
                "sender": sender, "origin_server_ts": 1, "room_id": room,
                "content": {"msgtype": "m.text", "body": "https://example.org"},
            });
            original["content"][field] = if removed_after_send {
                json!([{"matched_url": "https://example.org"}])
            } else {
                json!([])
            };
            let replacements = if removed_after_send {
                vec![json!({
                    "type": "m.room.message", "event_id": "$removed",
                    "sender": sender, "origin_server_ts": 2, "room_id": room,
                    "content": {
                        "msgtype": "m.text", "body": "* https://example.org",
                        "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"},
                        "m.new_content": {
                            "msgtype": "m.text", "body": "https://example.org", (field): [],
                        },
                    },
                })]
            } else {
                Vec::new()
            };
            Mock::given(method("GET"))
                .and(path(format!(
                    "/_matrix/client/v3/rooms/{room}/event/$original"
                )))
                .respond_with(ResponseTemplate::new(200).set_body_json(original))
                .mount(server.server())
                .await;
            Mock::given(method("GET"))
                .and(path(format!(
                    "/_matrix/client/v1/rooms/{room}/relations/$original/m.replace"
                )))
                .respond_with(
                    ResponseTemplate::new(200).set_body_json(json!({"chunk": replacements})),
                )
                .mount(server.server())
                .await;
            let sent = Arc::new(Mutex::new(Value::Null));
            let write = sent.clone();
            Mock::given(method("PUT"))
                .and(wiremock::matchers::path_regex(format!(
                    "/_matrix/client/v3/rooms/{room}/send/m.room.message/.*"
                )))
                .respond_with(move |request: &wiremock::Request| {
                    *write.lock() = serde_json::from_slice(&request.body).unwrap();
                    ResponseTemplate::new(200).set_body_json(json!({"event_id": "$edited"}))
                })
                .expect(1)
                .mount(server.server())
                .await;
            let core = core(&server, client).await;
            core.run(crate::api::messages::EditParams {
                room_id: room.to_owned(),
                event_id: Some(event_id!("$original").to_owned()),
                transaction_id: None,
                body: "https://example.org extra text".to_owned(),
                formatted: None,
                kind: crate::protocol::MessageKind::Text,
                media_caption: false,
                thread_root: None,
                mentions: Vec::new(),
                mentions_room: false,
                persona: None,
                forum_title: None,
            })
            .await
            .unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), async {
                while sent.lock().is_null() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            let sent = sent.lock();
            assert_eq!(sent["m.new_content"][field], json!([]));
            assert_eq!(
                sent["m.new_content"]["body"],
                "https://example.org extra text"
            );
        }
    }
}

#[tokio::test]
async fn pin_and_unpin_load_existing_server_state() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!pins:example.org");
    server.sync_joined_room(&client, room_id).await;
    let pins = Arc::new(Mutex::new(json!({"pinned": ["$old"]})));
    let endpoint = format!("/_matrix/client/v3/rooms/{room_id}/state/m.room.pinned_events/");
    let read_pins = pins.clone();
    Mock::given(method("GET"))
        .and(path(endpoint.clone()))
        .respond_with(move |_: &wiremock::Request| {
            ResponseTemplate::new(200).set_body_json(read_pins.lock().clone())
        })
        .mount(server.server())
        .await;
    let write_pins = pins.clone();
    Mock::given(method("PUT"))
        .and(path(endpoint))
        .respond_with(move |request: &wiremock::Request| {
            *write_pins.lock() = serde_json::from_slice::<Value>(&request.body).unwrap();
            ResponseTemplate::new(200).set_body_json(json!({"event_id": "$pins"}))
        })
        .expect(2)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    let result = session
        .set_pinned(&room_id.to_owned(), event_id!("$new").to_owned(), true)
        .await
        .unwrap();
    assert_eq!(result, vec![event_id!("$old"), event_id!("$new")]);
    let result = session
        .set_pinned(&room_id.to_owned(), event_id!("$new").to_owned(), false)
        .await
        .unwrap();
    assert_eq!(result, vec![event_id!("$old")]);
    assert_eq!(*pins.lock(), json!({"pinned": ["$old"]}));
}

#[tokio::test]
async fn forwarded_links_never_reveal_the_rooms_we_are_in() {
    for (prior_room, via) in [
        (None, "localhost"),
        (Some("!known"), "origin.example"),
        (Some("!source"), "origin.example"),
        (Some("!unknown"), "origin.example"),
    ] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let source = room_id!("!source");
        let member: ruma::serde::Raw<_> = ruma::serde::Raw::new(&json!({
            "type": "m.room.member", "state_key": "@carol:source.example", "event_id": "$carol",
            "sender": "@carol:source.example", "origin_server_ts": 1,
            "content": {"membership": "join"}
        }))
        .unwrap()
        .cast_unchecked();
        let rules: ruma::serde::Raw<_> = ruma::serde::Raw::new(&json!({
            "type": "m.room.join_rules", "state_key": "", "event_id": "$rules",
            "sender": "@example:localhost", "origin_server_ts": 1,
            "content": {"join_rule": "public"}
        }))
        .unwrap()
        .cast_unchecked();
        let mut joined = matrix_sdk_test::JoinedRoomBuilder::new(source).add_state_event(rules);
        if prior_room.is_some() {
            joined = joined.add_state_event(member);
        }
        server.sync_room(&client, joined).await;
        let secret: ruma::serde::Raw<_> = ruma::serde::Raw::new(&json!({
            "type": "m.room.member", "state_key": "@dave:secret.example", "event_id": "$dave",
            "sender": "@dave:secret.example", "origin_server_ts": 1,
            "content": {"membership": "join"}
        }))
        .unwrap()
        .cast_unchecked();
        let known = matrix_sdk_test::JoinedRoomBuilder::new(room_id!("!known"));
        server
            .sync_room(&client, known.add_state_event(secret))
            .await;
        server.mock_room_state_encryption().plain().mount().await;

        let mut content = json!({"msgtype": "m.text", "body": "hi"});
        if let Some(room) = prior_room {
            content[super::FORWARDED] = json!({
                "room_id": room, "event_id": "$original", "sender": "@alice:origin.example",
                "content": {"msgtype": "m.text", "body": "hi"}
            });
        }
        Mock::given(method("GET"))
            .and(wiremock::matchers::path_regex("/event/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "type": "m.room.message", "event_id": "$message", "room_id": source,
                "sender": "@bob:source.example", "origin_server_ts": 2, "content": content,
            })))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(wiremock::matchers::path_regex("/relations/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(wiremock::matchers::path_regex("/send/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$sent"})))
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        let session = core.signed_in().unwrap();

        let (source, event) = (source.to_owned(), event_id!("$message").to_owned());
        session
            .forward_message(&source, &event, &source, None, true)
            .await
            .unwrap();

        let requests = server.server().received_requests().await.unwrap();
        let sent = requests
            .iter()
            .find(|request| request.url.path().contains("/send/"))
            .unwrap();
        let body: Value = serde_json::from_slice(&sent.body).unwrap();
        let text = body["body"].as_str().unwrap();
        assert!(
            text.contains(&format!("?via={via}\n")),
            "{prior_room:?}: {text}"
        );
    }
}

#[tokio::test]
async fn pinning_keeps_server_pins_the_local_cache_has_not_seen() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!stale:example.org");
    let stale: ruma::serde::Raw<_> = ruma::serde::Raw::new(&json!({
        "type": "m.room.pinned_events", "state_key": "", "event_id": "$state",
        "sender": "@alice:example.org", "origin_server_ts": 1,
        "content": {"pinned": ["$a"]}
    }))
    .unwrap()
    .cast_unchecked();
    server
        .sync_room(
            &client,
            matrix_sdk_test::JoinedRoomBuilder::new(room_id).add_state_event(stale),
        )
        .await;
    let endpoint = format!("/_matrix/client/v3/rooms/{room_id}/state/m.room.pinned_events/");
    Mock::given(method("GET"))
        .and(path(endpoint.clone()))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({"pinned": ["$a", "$b", "$c"]})),
        )
        .mount(server.server())
        .await;
    let sent = Arc::new(Mutex::new(Value::Null));
    let write = sent.clone();
    Mock::given(method("PUT"))
        .and(path(endpoint))
        .respond_with(move |request: &wiremock::Request| {
            *write.lock() = serde_json::from_slice::<Value>(&request.body).unwrap();
            ResponseTemplate::new(200).set_body_json(json!({"event_id": "$pins"}))
        })
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    session
        .set_pinned(&room_id.to_owned(), event_id!("$d").to_owned(), true)
        .await
        .unwrap();
    assert_eq!(*sent.lock(), json!({"pinned": ["$a", "$b", "$c", "$d"]}));
}

#[tokio::test]
async fn typing_in_a_room_that_is_not_joined_is_a_no_op() {
    use crate::api::Handler;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!invited:example.org");
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_invited_room(matrix_sdk_test::InvitedRoomBuilder::new(room_id));
        })
        .await;
    let core = core(&server, client).await;
    let params = crate::api::messages::SetTypingParams {
        room_id: room_id.to_owned(),
        typing: false,
    };
    params.run(&core).await.unwrap();
}

#[tokio::test]
async fn a_malformed_pin_does_not_hide_the_valid_ones() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!bad-pin:example.org");
    server
        .sync_room(&client, matrix_sdk_test::JoinedRoomBuilder::new(room_id))
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/state/m.room.pinned_events/"
        )))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"pinned": ["$a", "!not-an-event:example.org", "$a", "$b"]})),
        )
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    let pins = session.pinned_events(&room_id.to_owned()).await.unwrap();
    assert_eq!(
        pins,
        [event_id!("$a").to_owned(), event_id!("$b").to_owned()]
    );
}

#[tokio::test]
async fn forwarding_uses_latest_valid_edit_even_when_relations_are_unordered() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let source = room_id!("!source:example.org");
    let target = room_id!("!target:example.org");
    server.sync_joined_room(&client, source).await;
    server.sync_joined_room(&client, target).await;
    server.mock_room_state_encryption().plain().mount().await;
    let original = json!({"type": "m.room.message", "event_id": "$original", "sender": "@alice:example.org", "origin_server_ts": 1,
            "room_id": source, "content": {"msgtype": "m.text", "body": "original"}});
    let edit = |id: &str, sender: &str, ts: u64, body: &str| {
        json!({
            "type": "m.room.message", "event_id": id, "sender": sender, "origin_server_ts": ts,
            "room_id": source, "content": {"msgtype": "m.text", "body": "* fallback",
            "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"},
            "m.new_content": {"msgtype": "m.text", "body": body}}})
    };
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{source}/event/$original"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(original))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v1/rooms/{source}/relations/$original/m.replace"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [
            edit("$new", "@alice:example.org", 3, "latest"),
            edit("$old", "@alice:example.org", 2, "older"),
            edit("$forged", "@mallory:example.org", 4, "forged")
        ]})))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(wiremock::matchers::path_regex(format!(
            "/_matrix/client/v3/rooms/{target}/send/m.room.message/.*"
        )))
        .and(wiremock::matchers::body_partial_json(json!({
            "moe.sable.message.forward": {"is_forwarded": true},
            "org.matrix.msc4553.forwarded": {"content": {"msgtype": "m.text", "body": "latest"}}
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$forward"})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    session
        .forward_message(
            &source.to_owned(),
            &event_id!("$original").to_owned(),
            &target.to_owned(),
            None,
            true,
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn forwarding_uses_the_forwarders_selected_profile() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let source = room_id!("!source:example.org");
    let target = room_id!("!target:example.org");
    server.sync_joined_room(&client, source).await;
    server.sync_joined_room(&client, target).await;
    server.mock_room_state_encryption().plain().mount().await;
    let original_content = json!({
        "msgtype": "m.text", "body": "original",
        "com.beeper.per_message_profile": { "displayname": "Alice" },
        "m.per_message_profile": { "displayname": "Alice" }
    });
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{source}/event/$original"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "type": "m.room.message", "event_id": "$original", "sender": "@alice:example.org",
            "origin_server_ts": 1, "room_id": source, "content": original_content
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v1/rooms/{source}/relations/$original/m.replace"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(wiremock::matchers::path_regex(format!(
            "/_matrix/client/v3/rooms/{target}/send/m.room.message/.*"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$forward"})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    let persona =
        serde_json::from_value(json!({ "display_name": "Bob", "has_fallback": true })).unwrap();
    session
        .forward_message(
            &source.to_owned(),
            &event_id!("$original").to_owned(),
            &target.to_owned(),
            Some(&persona),
            true,
        )
        .await
        .unwrap();

    let content = sent_message(&server).await;
    assert_eq!(
        content["com.beeper.per_message_profile"],
        json!({ "displayname": "Bob" })
    );
    assert!(content.get("m.per_message_profile").is_none());
    assert_eq!(
        content["org.matrix.msc4553.forwarded"]["content"],
        original_content
    );
}

#[tokio::test]
async fn forwarding_without_metadata_keeps_only_required_content() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let source = room_id!("!source:example.org");
    let target = room_id!("!target:example.org");
    server.sync_joined_room(&client, source).await;
    server.sync_joined_room(&client, target).await;
    server.mock_room_state_encryption().plain().mount().await;
    let original = json!({"type": "m.room.message", "event_id": "$original", "sender": "@alice:example.org", "origin_server_ts": 1,
            "room_id": source, "content": {"msgtype": "m.text", "body": "original"}});
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{source}/event/$original"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(original))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v1/rooms/{source}/relations/$original/m.replace"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(wiremock::matchers::path_regex(format!(
            "/_matrix/client/v3/rooms/{target}/send/m.room.message/.*"
        )))
        .and(|request: &wiremock::Request| {
            let body: Value = request.body_json().unwrap();
            body["org.matrix.msc4553.forwarded"]
                == json!({
                    "content": {"msgtype": "m.text", "body": "original"}
                })
                && body["moe.sable.message.forward"]
                    == json!({
                        "v": 1, "is_forwarded": true, "original_event_private": true
                    })
                && body["body"] == "Forwarded message\noriginal"
        })
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$forward"})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    session
        .forward_message(
            &source.to_owned(),
            &event_id!("$original").to_owned(),
            &target.to_owned(),
            None,
            false,
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn forwarding_from_a_public_room_names_the_room() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let source = room_id!("!source:example.org");
    let target = room_id!("!target:example.org");
    let factory = matrix_sdk_test::event_factory::EventFactory::new()
        .room(source)
        .sender(user_id!("@alice:example.org"));
    server
        .sync_room(
            &client,
            matrix_sdk_test::JoinedRoomBuilder::new(source)
                .add_state_event(
                    factory.room_join_rules(ruma::events::room::join_rules::JoinRule::Public),
                )
                .add_state_event(factory.room_name("Announcements"))
                .add_state_event(
                    factory
                        .room_avatar()
                        .url(ruma::mxc_uri!("mxc://example.org/a")),
                ),
        )
        .await;
    server.sync_joined_room(&client, target).await;
    server.mock_room_state_encryption().plain().mount().await;
    let original = json!({"type": "m.room.message", "event_id": "$original", "sender": "@alice:example.org", "origin_server_ts": 1,
            "room_id": source, "content": {"msgtype": "m.text", "body": "original"}});
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{source}/event/$original"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(original))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v1/rooms/{source}/relations/$original/m.replace"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(wiremock::matchers::path_regex(format!(
            "/_matrix/client/v3/rooms/{target}/send/m.room.message/.*"
        )))
        .and(|request: &wiremock::Request| {
            let body: Value = request.body_json().unwrap();
            let forwarded = &body["org.matrix.msc4553.forwarded"];
            forwarded["room_name"] == "Announcements"
                && forwarded["room_avatar_url"] == "mxc://example.org/a"
        })
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$forward"})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    session
        .forward_message(
            &source.to_owned(),
            &event_id!("$original").to_owned(),
            &target.to_owned(),
            None,
            true,
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn an_edit_of_a_forward_is_ignored_when_forwarding_it() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let source = room_id!("!source:example.org");
    let target = room_id!("!target:example.org");
    server.sync_joined_room(&client, source).await;
    server.sync_joined_room(&client, target).await;
    server.mock_room_state_encryption().plain().mount().await;
    let forwarded =
        json!({"origin_server_ts": 1, "content": {"msgtype": "m.text", "body": "original"}});
    Mock::given(method("GET"))
            .and(path(format!("/_matrix/client/v3/rooms/{source}/event/$forward")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "type": "m.room.message", "event_id": "$forward", "sender": "@alice:example.org",
                "origin_server_ts": 2, "room_id": source,
                "content": {"msgtype": "m.text", "body": "fallback", "org.matrix.msc4553.forwarded": forwarded}
            })))
            .mount(server.server())
            .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v1/rooms/{source}/relations/$forward/m.replace"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [{
            "type": "m.room.message", "event_id": "$edit", "sender": "@alice:example.org",
            "origin_server_ts": 3, "room_id": source,
            "content": {"msgtype": "m.text", "body": "* edited",
                "m.relates_to": {"rel_type": "m.replace", "event_id": "$forward"},
                "m.new_content": {"msgtype": "m.text", "body": "edited"}}
        }]})))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(wiremock::matchers::path_regex(format!(
            "/_matrix/client/v3/rooms/{target}/send/m.room.message/.*"
        )))
        .and(wiremock::matchers::body_partial_json(json!({
            "org.matrix.msc4553.forwarded": forwarded
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$new"})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    session
        .forward_message(
            &source.to_owned(),
            &event_id!("$forward").to_owned(),
            &target.to_owned(),
            None,
            false,
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn edit_history_lists_the_original_then_valid_edits_by_time() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!history:example.org");
    server.sync_joined_room(&client, room).await;
    server.mock_room_state_encryption().plain().mount().await;
    let edit = |id: &str, sender: &str, ts: u64, body: &str| {
        json!({
            "type": "m.room.message", "event_id": id, "sender": sender, "origin_server_ts": ts,
            "room_id": room, "content": {"msgtype": "m.text", "body": "* fallback",
            "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"},
            "m.new_content": {"msgtype": "m.text", "body": body,
                "format": "org.matrix.custom.html", "formatted_body": format!("<b>{body}</b>")}}})
    };
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room}/event/$original"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "type": "m.room.message", "event_id": "$original", "sender": "@alice:example.org",
            "origin_server_ts": 1, "room_id": room,
            "content": {"msgtype": "m.text", "body": "first"}
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v1/rooms/{room}/relations/$original/m.replace"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [
            edit("$third", "@alice:example.org", 3, "third"),
            edit("$second", "@alice:example.org", 2, "second"),
            edit("$forged", "@mallory:example.org", 4, "forged")
        ]})))
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    let versions = session
        .edit_history(&room.to_owned(), &event_id!("$original").to_owned())
        .await
        .unwrap();
    let summary: Vec<_> = versions
        .iter()
        .map(|version| {
            (
                version.event_id.as_str(),
                version.timestamp,
                version.body.as_str(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            ("$original", 1, "first"),
            ("$second", 2, "second"),
            ("$third", 3, "third")
        ]
    );
    assert_eq!(versions[2].html, "<b>third</b>");
}

#[tokio::test]
async fn redacting_edits_redacts_each_valid_edit() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!redact:example.org");
    server.sync_joined_room(&client, room).await;
    server.mock_room_state_encryption().plain().mount().await;
    let edit = |id: &str, sender: &str| {
        json!({
            "type": "m.room.message", "event_id": id, "sender": sender, "origin_server_ts": 2,
            "room_id": room, "content": {"msgtype": "m.text", "body": "* fallback",
            "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"},
            "m.new_content": {"msgtype": "m.text", "body": "edited"}}})
    };
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room}/event/$original"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "type": "m.room.message", "event_id": "$original", "sender": "@alice:example.org",
            "origin_server_ts": 1, "room_id": room,
            "content": {"msgtype": "m.text", "body": "first"}
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v1/rooms/{room}/relations/$original/m.replace"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [
            edit("$one", "@alice:example.org"),
            edit("$two", "@alice:example.org"),
            edit("$forged", "@mallory:example.org")
        ]})))
        .mount(server.server())
        .await;
    for edit_id in ["$one", "$two"] {
        Mock::given(method("PUT"))
            .and(wiremock::matchers::path_regex(format!(
                r"/_matrix/client/v3/rooms/{room}/redact/\{edit_id}/.*"
            )))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"event_id": "$redaction"})),
            )
            .expect(1)
            .mount(server.server())
            .await;
    }
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    session
        .redact_edits(&room.to_owned(), &event_id!("$original").to_owned(), None)
        .await
        .unwrap();
}

#[tokio::test]
async fn event_items_render_the_latest_valid_edit_and_skip_missing_events() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!pins:example.org");
    server.sync_joined_room(&client, room).await;
    server.mock_room_state_encryption().plain().mount().await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room}/event/$pinned"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "type": "m.room.message", "event_id": "$pinned", "sender": "@alice:example.org",
            "origin_server_ts": 1, "room_id": room,
            "content": {"msgtype": "m.text", "body": "**rules**",
                "format": "org.matrix.custom.html", "formatted_body": "<b>rules</b>"}
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v1/rooms/{room}/relations/$pinned/m.replace"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [
            {"type": "m.room.message", "event_id": "$edit", "sender": "@alice:example.org",
             "origin_server_ts": 2, "room_id": room,
             "content": {"msgtype": "m.text", "body": "* new rules",
                "m.relates_to": {"rel_type": "m.replace", "event_id": "$pinned"},
                "m.new_content": {"msgtype": "m.text", "body": "new rules",
                    "format": "org.matrix.custom.html",
                    "formatted_body": "<em>new</em> rules"}}},
            {"type": "m.room.message", "event_id": "$forged", "sender": "@mallory:example.org",
             "origin_server_ts": 3, "room_id": room,
             "content": {"msgtype": "m.text", "body": "* forged",
                "m.relates_to": {"rel_type": "m.replace", "event_id": "$pinned"},
                "m.new_content": {"msgtype": "m.text", "body": "forged"}}}
        ]})))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{room}/event/$gone")))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "errcode": "M_NOT_FOUND", "error": "Event not found"
        })))
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    let items = session
        .event_items(
            &room.to_owned(),
            &[
                event_id!("$pinned").to_owned(),
                event_id!("$gone").to_owned(),
            ],
        )
        .await
        .unwrap();

    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.event_id.as_deref(), Some(event_id!("$pinned")));
    assert_eq!(item.sender.as_deref(), Some(user_id!("@alice:example.org")));
    assert_eq!(item.timestamp, 1);
    let crate::protocol::TimelineItemContentView::Message {
        body, html, edited, ..
    } = &item.content
    else {
        panic!("expected a message, got {:?}", item.content);
    };
    assert_eq!(body, "new rules");
    assert_eq!(html, "<em>new</em> rules");
    assert!(edited);
}

async fn preview_core(server: &MatrixMockServer) -> Arc<Core> {
    let client = server.client_builder().build().await;
    let room = room_id!("!bookmarks:example.org");
    server.sync_joined_room(&client, room).await;
    server.mock_room_state_encryption().plain().mount().await;
    let event = json!({
        "type": "m.room.message", "event_id": "$saved", "sender": "@alice:example.org",
        "origin_server_ts": 1, "room_id": room,
        "content": {"msgtype": "m.text", "body": "Saved message"}
    });
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room}/event/$saved"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(event.clone()))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v1/rooms/{room}/threads")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [event]})))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v1/rooms/{room}/relations/$saved/m.replace"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room}/state/m.room.member/@alice:example.org"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "membership": "join", "displayname": "Room Alice",
            "avatar_url": "mxc://example.org/alice"
        })))
        .expect(1)
        .mount(server.server())
        .await;
    core(server, client).await
}

#[tokio::test]
async fn event_items_and_thread_roots_share_missing_sender_state() {
    use crate::api::timeline::ListThreadsParams;

    let server = MatrixMockServer::new().await;
    let core = preview_core(&server).await;
    let session = core.signed_in().unwrap();
    let room = room_id!("!bookmarks:example.org");
    let items = session
        .event_items(&room.to_owned(), &[event_id!("$saved").to_owned()])
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].sender_name.as_deref(), Some("Room Alice"));
    assert_eq!(
        items[0].sender_avatar.as_deref(),
        Some("mxc://example.org/alice")
    );

    let threads = core
        .run(ListThreadsParams {
            room_id: room.to_owned(),
            from: None,
            participated: false,
        })
        .await
        .unwrap();
    assert_eq!(threads.roots.len(), 1);
    assert_eq!(threads.roots[0].sender_name.as_deref(), Some("Room Alice"));
    assert_eq!(
        threads.roots[0].sender_avatar.as_deref(),
        Some("mxc://example.org/alice")
    );
}

#[tokio::test]
async fn thread_lists_keep_server_counts_when_local_history_is_empty() {
    use crate::api::timeline::ListThreadsParams;
    use wiremock::matchers::query_param;

    let server = MatrixMockServer::new().await;
    let core = preview_core(&server).await;
    let room = room_id!("!bookmarks:example.org");
    let client = core.signed_in().unwrap().client().clone();
    let _cache = client
        .event_cache()
        .unwrap()
        .thread(room, event_id!("$saved"))
        .await
        .unwrap();
    Mock::given(method("GET"))
            .and(path(format!("/_matrix/client/v1/rooms/{room}/threads")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "chunk": [{
                "type": "m.room.message", "event_id": "$saved", "sender": "@alice:example.org",
                "origin_server_ts": 1, "room_id": room,
                "content": {"msgtype": "m.text", "body": "Saved message"},
                "unsigned": {"m.relations": {"m.thread": {"count": 2, "current_user_participated": false, "latest_event": {
                    "event_id": "$latest", "type": "m.room.message", "sender": "@alice:example.org",
                    "origin_server_ts": 2, "content": {"msgtype": "m.text", "body": "Latest reply"}
                }}}}
            }] })))
            .up_to_n_times(1)
            .with_priority(1)
            .mount(server.server())
            .await;
    let result = core
        .run(ListThreadsParams {
            room_id: room.to_owned(),
            from: None,
            participated: false,
        })
        .await
        .unwrap();
    let summary = result.roots[0].thread_summary.as_ref().unwrap();
    assert_eq!(summary.num_replies, 2);
    assert_eq!(summary.latest_body.as_deref(), Some("Latest reply"));

    Mock::given(method("GET"))
            .and(path(format!("/_matrix/client/v1/rooms/{room}/threads")))
            .and(query_param("include", "participated"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "chunk": [{
                "type": "m.room.message", "event_id": "$saved", "sender": "@alice:example.org",
                "origin_server_ts": 1, "room_id": room,
                "content": {"msgtype": "m.text", "body": "Saved message"},
                "unsigned": {"m.relations": {"m.thread": {"count": 2, "current_user_participated": true, "latest_event": {
                    "event_id": "$latest", "type": "m.room.message", "sender": "@bob:example.org",
                    "origin_server_ts": 2_000, "content": {"msgtype": "m.text", "body": "Latest reply"}
                }}}}
            }] })))
            .with_priority(1)
            .expect(1)
            .mount(server.server())
            .await;

    let filtered = core
        .run(ListThreadsParams {
            room_id: room.to_owned(),
            from: None,
            participated: true,
        })
        .await
        .unwrap();
    assert_eq!(filtered.roots.len(), 1);
    let summary = filtered.roots[0].thread_summary.as_ref().unwrap();
    assert_eq!(summary.latest_timestamp, Some(2_000));
    assert_eq!(summary.latest_sender.as_deref(), Some("@bob:example.org"));
    assert_eq!(summary.current_user_participated, Some(true));
}

#[tokio::test]
async fn event_items_fetch_missing_sender_state_in_a_left_room() {
    use matrix_sdk_test::LeftRoomBuilder;

    let server = MatrixMockServer::new().await;
    let core = preview_core(&server).await;
    let session = core.signed_in().unwrap();
    let room = room_id!("!bookmarks:example.org");
    server
        .sync_room(
            &core.signed_in().unwrap().client().clone(),
            LeftRoomBuilder::new(room),
        )
        .await;

    let items = session
        .event_items(&room.to_owned(), &[event_id!("$saved").to_owned()])
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].sender_name.as_deref(), Some("Room Alice"));
    assert_eq!(
        items[0].sender_avatar.as_deref(),
        Some("mxc://example.org/alice")
    );
}

#[tokio::test]
async fn forwarding_media_from_a_private_room_keeps_the_attachment() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let source = room_id!("!private:example.org");
    let target = room_id!("!target:example.org");
    server.sync_joined_room(&client, source).await;
    server.sync_joined_room(&client, target).await;
    server.mock_room_state_encryption().plain().mount().await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{source}/event/$video"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "type": "m.room.message", "event_id": "$video", "sender": "@alice:example.org",
            "origin_server_ts": 1, "room_id": source,
            "content": {"msgtype": "m.video", "body": "seal.mp4", "url": "mxc://example.org/seal"}
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v1/rooms/{source}/relations/$video/m.replace"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
            .and(wiremock::matchers::path_regex(format!(
                "/_matrix/client/v3/rooms/{target}/send/m.room.message/.*"
            )))
            .and(wiremock::matchers::body_partial_json(json!({
                "msgtype": "m.video", "body": "Forwarded message", "filename": "seal.mp4",
                "url": "mxc://example.org/seal",
                "org.matrix.msc4553.forwarded": {"origin_server_ts": 1, "content": {"url": "mxc://example.org/seal"}}
            })))
            .and(|request: &wiremock::Request| {
                let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
                let forwarded = &body["org.matrix.msc4553.forwarded"];
                forwarded.get("room_id").is_none()
                    && forwarded.get("event_id").is_none()
                    && forwarded.get("sender").is_none()
            })
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$forward"})))
            .expect(1)
            .mount(server.server())
            .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    session
        .forward_message(
            &source.to_owned(),
            &event_id!("$video").to_owned(),
            &target.to_owned(),
            None,
            true,
        )
        .await
        .unwrap();
}

async fn mock_unedited_event(
    server: &MatrixMockServer,
    room: &ruma::RoomId,
    event: &str,
    content: Value,
) {
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room}/event/{event}"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "type": "m.room.message", "event_id": event, "sender": "@alice:example.org",
            "origin_server_ts": 1, "room_id": room, "content": content
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v1/rooms/{room}/relations/{event}/m.replace"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
        .mount(server.server())
        .await;
}

#[tokio::test]
async fn forwarding_encrypted_media_to_an_unencrypted_room_sends_a_plain_copy() {
    use std::io::Read;

    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .server_versions(vec![ruma::api::MatrixVersion::V1_11])
        .build()
        .await;
    let source = room_id!("!source:example.org");
    let target = room_id!("!target:example.org");
    server.sync_joined_room(&client, source).await;
    server.sync_joined_room(&client, target).await;
    server.mock_room_state_encryption().plain().mount().await;

    let plaintext = b"a picture".to_vec();
    let mut cursor = std::io::Cursor::new(plaintext.clone());
    let mut encryptor = matrix_sdk_base::crypto::AttachmentEncryptor::new(&mut cursor);
    let mut ciphertext = Vec::new();
    encryptor.read_to_end(&mut ciphertext).unwrap();
    let keys = encryptor.finish();
    let file = |media: &str| {
        ruma::events::room::EncryptedFile::new(
            ruma::OwnedMxcUri::from(format!("mxc://example.org/{media}")),
            keys.encryption_info.clone(),
            keys.hashes.clone(),
        )
    };
    for media in ["sealed", "sealedthumb"] {
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v1/media/download/example.org/{media}"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(ciphertext.clone()))
            .mount(server.server())
            .await;
    }
    let content = json!({
        "msgtype": "m.image", "body": "cat.png", "file": file("sealed"),
        "info": {
            "mimetype": "image/png",
            "thumbnail_file": file("sealedthumb"),
            "thumbnail_info": {"mimetype": "image/png"}
        }
    });
    mock_unedited_event(&server, source, "$image", content).await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v1/media/config"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"m.upload.size": 1_000_000})))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/media/v3/upload"))
        .and(wiremock::matchers::header("content-type", "image/png"))
        .and(move |request: &wiremock::Request| request.body == plaintext)
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "content_uri": "mxc://example.org/plain",
        })))
        .expect(2)
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(wiremock::matchers::path_regex(format!(
            "/_matrix/client/v3/rooms/{target}/send/m.room.message/.*"
        )))
        .and(wiremock::matchers::body_partial_json(json!({
            "msgtype": "m.image",
            "url": "mxc://example.org/plain",
            "info": {"thumbnail_url": "mxc://example.org/plain"},
            "org.matrix.msc4553.forwarded": {"content": {
                "url": "mxc://example.org/plain",
                "info": {"thumbnail_url": "mxc://example.org/plain"}
            }}
        })))
        .and(|request: &wiremock::Request| {
            let body = String::from_utf8_lossy(&request.body);
            !["\"file\"", "thumbnail_file", "\"iv\"", "sealed"]
                .iter()
                .any(|leak| body.contains(leak))
        })
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$forward"})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    session
        .forward_message(
            &source.to_owned(),
            &event_id!("$image").to_owned(),
            &target.to_owned(),
            None,
            true,
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn a_queued_message_is_cancelled_through_its_send_queue_handle() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.send_queue().set_enabled(false).await;
    let room_id = room_id!("!pending:example.org");
    let room = server.sync_joined_room(&client, room_id).await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    let params = serde_json::from_value::<crate::api::messages::SendParams>(json!({
        "room_id": room_id,
        "body": "queued",
    }))
    .unwrap();
    core.run(params).await.unwrap();
    let (echoes, _updates) = room.send_queue().subscribe().await.unwrap();
    let transaction_id = echoes[0].transaction_id.to_string();

    let handle = session
        .local_echo(&room_id.to_owned(), &transaction_id)
        .await
        .unwrap();
    assert!(handle.abort().await.unwrap());
    session
        .local_echo(&room_id.to_owned(), &transaction_id)
        .await
        .unwrap_err();
}

#[tokio::test]
async fn a_preview_image_prepared_in_the_composer_is_not_uploaded_again_on_send() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!preview:example.org");
    server.sync_joined_room(&client, room_id).await;
    server
        .mock_authenticated_media_config()
        .ok_default()
        .mount()
        .await;
    server.mock_room_state_encryption().plain().mount().await;
    Mock::given(method("GET"))
        .and(path(
            "/_matrix/client/v1/media/download/example.org/temporary",
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(b"preview thumbnail".as_slice())
                .set_delay(std::time::Duration::from_secs(1)),
        )
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
    let preview = crate::link_previews::url_preview(
        "https://example.org".to_owned(),
        &json!({"og:title": "Example", "og:image": "mxc://example.org/temporary"}),
    )
    .unwrap();

    core.run(
        serde_json::from_value::<crate::api::messages::PreparePreviewImagesParams>(json!({
            "room_id": room_id,
            "previews": [preview],
        }))
        .unwrap(),
    )
    .await
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while server
            .server()
            .received_requests()
            .await
            .unwrap()
            .iter()
            .all(|request| request.url.path() != "/_matrix/media/v3/upload")
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();

    let send = serde_json::from_value::<crate::api::messages::SendParams>(json!({
        "room_id": room_id,
        "body": "https://example.org",
        "link_previews": [preview],
    }))
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_millis(500), core.run(send))
        .await
        .expect("the send does not wait on the preview image again")
        .unwrap();
}

#[tokio::test]
async fn sending_previews_validates_the_whitelist_and_honors_optout() {
    for opt_out in [false, true] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.send_queue().set_enabled(false).await;
        let room_id = room_id!("!pending:example.org");
        let room = server.sync_joined_room(&client, room_id).await;
        let core = core(&server, client).await;
        let preview = |url: &str| {
            crate::link_previews::url_preview(
                url.to_owned(),
                &json!({
                    "og:title": "Example"
                }),
            )
            .unwrap()
        };
        let params = serde_json::from_value::<crate::api::messages::SendParams>(json!({
            "room_id": room_id,
            "body": "https://example.org/allowed javascript:alert(1)",
            "link_previews": [
                preview("https://example.org/allowed"),
                preview("https://example.org/allowed"),
                preview("https://example.org/absent"),
                preview("javascript:alert(1)"),
            ],
            "no_link_previews": opt_out,
        }))
        .unwrap();
        core.run(params).await.unwrap();
        let (echoes, _updates) = room.send_queue().subscribe().await.unwrap();
        let matrix_sdk::send_queue::LocalEchoContent::Event {
            serialized_event, ..
        } = &echoes[0].content
        else {
            panic!("expected a queued message")
        };
        let content: Value = serialized_event.raw().0.deserialize_as_unchecked().unwrap();
        for (field, matched_url) in [
            (super::BUNDLED_LINK_PREVIEWS, "matrix:matched_url"),
            (super::LEGACY_BUNDLED_LINK_PREVIEWS, "matched_url"),
        ] {
            let previews = content[field].as_array().unwrap();
            assert_eq!(previews.len(), usize::from(!opt_out));
            if !opt_out {
                assert_eq!(previews[0][matched_url], "https://example.org/allowed");
            }
        }
    }
}

#[tokio::test]
async fn editing_a_pending_reply_updates_the_queue_and_keeps_the_relation() {
    use crate::protocol::MessageKind;
    use matrix_sdk::ruma::events::relation::Reply;
    use matrix_sdk::ruma::events::room::message::{Relation, RoomMessageEventContent};
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.send_queue().set_enabled(false).await;
    let room_id = room_id!("!pending:example.org");
    server.sync_joined_room(&client, room_id).await;
    server.mock_room_state_encryption().plain().mount().await;
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/event/$reply"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "type": "m.room.message", "event_id": "$reply", "sender": "@bob:example.org",
            "origin_server_ts": 1, "room_id": room_id,
            "content": {"msgtype": "m.text", "body": "target"},
        })))
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    let timeline = session.timeline(&room_id.to_owned()).await.unwrap();
    let mut content = RoomMessageEventContent::text_plain("before");
    content.mentions = Some(super::outgoing_mentions(
        vec![user_id!("@bob:example.org").to_owned()],
        false,
    ));
    content.relates_to = Some(Relation::Reply(Reply::with_event_id(
        event_id!("$reply").to_owned(),
    )));
    timeline
        .send_with_extra_content(
            content.into(),
            Some(
                [
                    (super::BUNDLED_LINK_PREVIEWS.to_owned(), json!([])),
                    (super::LEGACY_BUNDLED_LINK_PREVIEWS.to_owned(), json!([])),
                ]
                .into_iter()
                .collect(),
            ),
        )
        .await
        .unwrap();
    let transaction_id = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if let Some(id) = timeline
                .items()
                .await
                .iter()
                .find_map(|item| item.as_event()?.transaction_id().map(ToString::to_string))
            {
                break id;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    core.run(crate::api::messages::EditParams {
        room_id: room_id.to_owned(),
        event_id: None,
        transaction_id: Some(transaction_id),
        body: "after".to_owned(),
        formatted: None,
        kind: MessageKind::Text,
        media_caption: false,
        thread_root: None,
        mentions: Vec::new(),
        mentions_room: false,
        persona: None,
        forum_title: None,
    })
    .await
    .unwrap();
    let room = session.room(&room_id.to_owned()).unwrap();
    let (echoes, _updates) = room.send_queue().subscribe().await.unwrap();
    let matrix_sdk::send_queue::LocalEchoContent::Event {
        serialized_event, ..
    } = &echoes[0].content
    else {
        panic!("expected a queued message")
    };
    let content: Value = serialized_event.raw().0.deserialize_as_unchecked().unwrap();
    assert_eq!(content["body"], "after");
    assert_eq!(
        content["m.relates_to"]["m.in_reply_to"]["event_id"],
        "$reply"
    );
    assert_eq!(
        content["m.mentions"]["user_ids"],
        json!(["@bob:example.org"])
    );
    assert_eq!(content[super::BUNDLED_LINK_PREVIEWS], json!([]));
    assert_eq!(content[super::LEGACY_BUNDLED_LINK_PREVIEWS], json!([]));
}

#[tokio::test]
async fn reading_a_thread_sends_only_a_receipt_scoped_to_its_root() {
    use crate::api::timeline::MarkReadParams;
    use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!thread:example.org");
    let root = event_id!("$root");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    server.mock_room_state_encryption().plain().mount().await;
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("root").event_id(root))
                .add_timeline_event(
                    factory
                        .text_msg("reply")
                        .event_id(event_id!("$reply"))
                        .in_thread(root, root),
                ),
        )
        .await;
    Mock::given(method("POST"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/receipt/m.read/$reply"
        )))
        .and(wiremock::matchers::body_json(json!({"thread_id": "$root"})))
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
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    let subscription = core.allocate_subscription();
    let timeline = session
        .thread_timeline(&room_id.to_owned(), &root.to_owned())
        .await
        .unwrap();
    session.state().subscriptions.lock().insert(
        subscription,
        crate::Subscription {
            tasks: Vec::new(),
            timeline: Some(timeline),
            overlay: None,
            thread_root: Some(root.to_owned()),
            kind: crate::SubscriptionKind::FocusedTimeline(room_id.to_owned()),
        },
    );
    core.settings
        .private_receipts
        .store(false, std::sync::atomic::Ordering::Relaxed);
    core.run(MarkReadParams {
        room_id: room_id.to_owned(),
        event_id: Some(event_id!("$reply").to_owned()),
        thread_root: Some(root.to_owned()),
        subscription: Some(subscription),
        fully_read: false,
    })
    .await
    .unwrap();
}

async fn receipt_body(read: &str, viewed: Option<&str>) -> Value {
    use crate::api::timeline::MarkReadParams;
    use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!thread:example.org");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    server.mock_room_state_encryption().plain().mount().await;
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("root").event_id(event_id!("$root")))
                .add_timeline_event(
                    factory
                        .text_msg("reply")
                        .event_id(event_id!("$reply"))
                        .in_thread(event_id!("$root"), event_id!("$root")),
                )
                .add_timeline_event(
                    factory
                        .reaction(event_id!("$reply"), "x")
                        .event_id(event_id!("$reaction")),
                )
                .add_timeline_event(factory.text_msg("main").event_id(event_id!("$main"))),
        )
        .await;
    Mock::given(method("POST"))
        .and(wiremock::matchers::path_regex(format!(
            "^/_matrix/client/v3/rooms/{room_id}/receipt/m.read/.*$"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    let core = core(&server, client).await;
    core.settings
        .private_receipts
        .store(false, std::sync::atomic::Ordering::Relaxed);
    core.run(MarkReadParams {
        room_id: room_id.to_owned(),
        event_id: Some(read.try_into().unwrap()),
        thread_root: viewed.map(|root| root.try_into().unwrap()),
        subscription: None,
        fully_read: false,
    })
    .await
    .unwrap();
    let requests = server.server().received_requests().await.unwrap();
    let receipt = requests
        .iter()
        .find(|request| request.url.path().contains("/receipt/m.read/"))
        .unwrap();
    serde_json::from_slice(&receipt.body).unwrap()
}

#[tokio::test]
async fn a_receipt_names_the_thread_of_its_event() {
    assert_eq!(
        receipt_body("$reply", None).await,
        json!({"thread_id": "$root"})
    );
    assert_eq!(
        receipt_body("$reaction", None).await,
        json!({"thread_id": "$root"})
    );
    assert_eq!(
        receipt_body("$reply", Some("$other")).await,
        json!({"thread_id": "$root"})
    );
    assert_eq!(
        receipt_body("$main", None).await,
        json!({"thread_id": "main"})
    );
    assert_eq!(
        receipt_body("$main", Some("$root")).await,
        json!({"thread_id": "main"})
    );
}

#[tokio::test]
async fn the_root_of_a_viewed_thread_is_read_in_it() {
    assert_eq!(
        receipt_body("$root", Some("$root")).await,
        json!({"thread_id": "$root"})
    );
}

#[tokio::test]
async fn reacting_to_a_thread_reply_reads_the_thread_up_to_the_reaction() {
    use crate::api::timeline::UnreadDiagnosticsParams;
    use matrix_sdk::ruma::events::receipt::{ReceiptThread, ReceiptType};
    use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .on_builder(|builder| builder.with_threading_support(crate::session::THREADING_SUPPORT))
        .build()
        .await;
    let me = client.user_id().unwrap().to_owned();
    let room_id = room_id!("!thread:example.org");
    let root = event_id!("$root");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    server.mock_room_state_encryption().plain().mount().await;
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("root").event_id(root).server_ts(1))
                .add_timeline_event(
                    factory
                        .text_msg("reply")
                        .event_id(event_id!("$reply"))
                        .in_thread(root, root)
                        .server_ts(2),
                )
                .add_receipt(
                    factory
                        .read_receipts()
                        .add(
                            event_id!("$reply"),
                            &me,
                            ReceiptType::Read,
                            ReceiptThread::Thread(root.to_owned()),
                        )
                        .into_event(),
                ),
        )
        .await;
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                factory
                    .reaction(event_id!("$reply"), "x")
                    .sender(&me)
                    .event_id(event_id!("$reaction"))
                    .server_ts(3),
            ),
        )
        .await;
    let core = core(&server, client).await;
    let diagnostics = core
        .run(UnreadDiagnosticsParams {
            room_id: room_id.to_owned(),
            thread_roots: vec![root.to_owned()],
        })
        .await
        .unwrap();
    let thread = &diagnostics.threads[0];
    assert_eq!(thread.read.unread, 0);
    assert_eq!(thread.read.receipt_event_id.as_deref(), Some("$reaction"));
    assert_eq!(thread.receipt_timestamp, Some(3));
}

#[tokio::test]
async fn a_thread_timeline_is_already_at_its_end_going_forward() {
    use crate::api::timeline::{PaginateOk, PaginateParams};
    use crate::protocol::PaginationDirection;
    use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!thread:example.org");
    let root = event_id!("$root");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    server.mock_room_state_encryption().plain().mount().await;
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("root").event_id(root)),
        )
        .await;
    let core = core(&server, client).await;
    let session = core.signed_in().unwrap();
    let subscription = core.allocate_subscription();
    let timeline = session
        .thread_timeline(&room_id.to_owned(), &root.to_owned())
        .await
        .unwrap();
    session.state().subscriptions.lock().insert(
        subscription,
        crate::Subscription {
            tasks: Vec::new(),
            timeline: Some(timeline),
            overlay: None,
            thread_root: Some(root.to_owned()),
            kind: crate::SubscriptionKind::FocusedTimeline(room_id.to_owned()),
        },
    );

    let result = core
        .run(PaginateParams {
            subscription,
            direction: PaginationDirection::Forward,
            count: 20,
        })
        .await;

    assert!(matches!(
        result,
        Ok(PaginateOk {
            direction: PaginationDirection::Forward,
            reached_end: true,
        })
    ));
}
