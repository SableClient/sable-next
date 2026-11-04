use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::ruma::events::sticker::OriginalSyncStickerEvent;
use matrix_sdk::ruma::{
    events::{AnySyncMessageLikeEvent, AnySyncStateEvent, AnySyncTimelineEvent},
    serde::Raw,
};
use serde_json::{Value, json};

use crate::search::document::{
    document_of, poll_start_document, room_message, state_document, sticker_document, with_edit,
};
use crate::search::replacement_of;

fn golden_event(position: usize, kind: &str, content: &Value) -> TimelineEvent {
    let raw: Raw<AnySyncTimelineEvent> = serde_json::from_value(json!({
        "type": kind,
        "event_id": format!("$golden{position}"),
        "sender": "@kris:localhost",
        "origin_server_ts": 1_000 + position,
        "content": content,
    }))
    .expect("event");
    TimelineEvent::from_plaintext(raw)
}

fn message_documents() -> Vec<Value> {
    let encrypted = json!({
        "hashes": { "sha256": "LddWbhqio1QFowJZotQFXzsDBdJpipd5OhiY1jKLv0M" },
        "iv": "38FDuSh6tsgAAAAAAAAAAA",
        "key": {
            "alg": "A256CTR",
            "ext": true,
            "k": "iClvSnBe_h01iKMzGdeyDrWSmSZ0Omhy-9tc5m7Ra6s",
            "key_ops": ["decrypt", "encrypt"],
            "kty": "oct"
        },
        "url": "mxc://localhost/statuts",
        "v": "v2"
    });
    let messages = [
        json!({
            "msgtype": "m.text",
            "body": "see https://example.org/a now",
            "m.mentions": { "user_ids": ["@kris:localhost"] }
        }),
        json!({
            "msgtype": "m.image",
            "body": "beach.png",
            "url": "mxc://localhost/beach",
            "info": { "mimetype": "image/png", "w": 640, "h": 480, "size": 1024 },
            "page.codeberg.everypizza.msc4193.spoiler": true
        }),
        json!({
            "msgtype": "m.file",
            "body": "notes.pdf",
            "url": "mxc://localhost/notes",
            "info": { "mimetype": "application/pdf", "size": 4096 }
        }),
        json!({
            "msgtype": "m.audio",
            "body": "memo.ogg",
            "url": "mxc://localhost/memo",
            "info": { "mimetype": "audio/ogg", "size": 2048 }
        }),
        json!({
            "msgtype": "m.text",
            "body": "> <@kris:localhost> see https://example.org/a now\n\nreply text",
            "m.relates_to": {
                "rel_type": "m.thread",
                "event_id": "$golden0",
                "m.in_reply_to": { "event_id": "$golden0" },
                "is_falling_back": true
            }
        }),
        json!({
            "msgtype": "dm.filament.gallery",
            "body": "",
            "itemtypes": [
                { "itemtype": "m.image", "body": "dune.png", "url": "mxc://localhost/dune" },
                {
                    "itemtype": "m.file",
                    "body": "statuts.pdf",
                    "info": { "mimetype": "application/pdf", "size": 86253 },
                    "file": encrypted
                }
            ]
        }),
    ];
    messages
        .into_iter()
        .enumerate()
        .map(|(position, content)| {
            let event = golden_event(position, "m.room.message", &content);
            let (message, content) = room_message(&event).expect("a room message");
            serde_json::to_value(document_of(&message, content.as_ref(), false))
                .expect("document json")
        })
        .collect()
}

fn edit_documents() -> Vec<Value> {
    let original = golden_event(
        0,
        "m.room.message",
        &json!({ "msgtype": "m.text", "body": "see" }),
    );
    let (original, original_content) = room_message(&original).expect("an original");
    let edit = golden_event(
        6,
        "m.room.message",
        &json!({
            "msgtype": "m.text",
            "body": "* see https://example.org/b",
            "m.new_content": {
                "msgtype": "m.text",
                "body": "see https://example.org/b",
                "m.mentions": { "user_ids": ["@alice:localhost"] }
            },
            "m.relates_to": { "rel_type": "m.replace", "event_id": "$golden0" }
        }),
    );
    let (edit, edit_content) = room_message(&edit).expect("an edit");
    let replacement = replacement_of(&edit).expect("a replacement");
    let mut document = document_of(&original, original_content.as_ref(), false);
    with_edit(&mut document, &edit, replacement, edit_content.as_ref());
    vec![serde_json::to_value(document).expect("edit json")]
}

fn poll_document() -> Value {
    let poll: AnySyncMessageLikeEvent = serde_json::from_value(json!({
        "type": "org.matrix.msc3381.poll.start",
        "event_id": "$golden8",
        "sender": "@kris:localhost",
        "origin_server_ts": 1_008,
        "content": {
            "org.matrix.msc3381.poll.start": {
                "question": { "org.matrix.msc1767.text": "Lunch spot?" },
                "kind": "org.matrix.msc3381.poll.disclosed",
                "max_selections": 1,
                "answers": [
                    { "id": "a", "org.matrix.msc1767.text": "Ramen" },
                    { "id": "b", "org.matrix.msc1767.text": "Tacos" }
                ]
            },
            "org.matrix.msc1767.text": "Lunch spot?\n1. Ramen\n2. Tacos"
        }
    }))
    .expect("a poll start");
    serde_json::to_value(poll_start_document(&poll).expect("a poll document")).expect("poll json")
}

fn sticker_json() -> Value {
    let sticker: OriginalSyncStickerEvent = serde_json::from_value(json!({
        "type": "m.sticker",
        "event_id": "$golden9",
        "sender": "@kris:localhost",
        "origin_server_ts": 1_009,
        "content": { "body": "moai", "info": {}, "url": "mxc://localhost/moai" }
    }))
    .expect("a sticker");
    serde_json::to_value(sticker_document(&sticker)).expect("sticker json")
}

fn state_json() -> Value {
    let topic = json!({ "topic": "Design crew", "m.topic": { "m.text": [{ "body": "ignored" }] } });
    let state: AnySyncStateEvent = serde_json::from_value(json!({
        "type": "m.room.topic",
        "event_id": "$golden10",
        "state_key": "",
        "sender": "@kris:localhost",
        "origin_server_ts": 1_010,
        "content": topic
    }))
    .expect("a state event");
    serde_json::to_value(state_document(&state, Some(&topic))).expect("state json")
}

#[test]
fn test_ingest_output_matches_the_golden_corpus() {
    let mut documents = message_documents();
    documents.extend(edit_documents());
    documents.push(poll_document());
    documents.push(sticker_json());
    documents.push(state_json());

    let expected: Vec<Value> =
        serde_json::from_str(include_str!("golden_documents.json")).expect("golden json");
    assert_eq!(
        documents, expected,
        "document_of changed what it stores: update golden_documents.json and bump persist::DERIVATION"
    );
}
