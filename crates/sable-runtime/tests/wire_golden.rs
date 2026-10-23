//! The TypeScript tests read the same fixture. Regenerate it with
//! `SABLE_UPDATE_FIXTURES=1 cargo nextest run -p sable-runtime wire_golden`.

#![cfg(test)]

use std::path::Path;

use sable_protocol::VectorDiff;
use sable_runtime::{
    AppEvent, Batch, Handshake, LostReason, Op, Outcome, ReplyError, ReqId, Snapshot, SubId,
    Subscribed, WIRE_SCHEMA, decode,
};
use serde_json::{Value, json};

const FIXTURE: &str = "../../tests/fixtures/wire/forms.json";

fn batch(tick: u64, event: AppEvent) -> Value {
    serde_json::to_value(Batch {
        tick,
        events: vec![event],
    })
    .unwrap()
}

fn reply(outcome: Outcome) -> AppEvent {
    AppEvent::Reply {
        req: ReqId(7),
        epoch: 0,
        outcome,
    }
}

fn forms() -> Value {
    json!({
        "subscribed": Subscribed {
            sub: SubId(1),
            snapshot: Snapshot {
                rev: 0,
                epoch: 0,
                state: json!({"total": 2, "items": ["a", "b"]}),
            },
        },
        "patch": batch(4, AppEvent::Patch {
            sub: SubId(1),
            rev: 1,
            epoch: 0,
            ops: vec![
                Op::Replace { path: "/total".to_owned(), value: json!(3) },
                Op::List {
                    path: "/items".to_owned(),
                    diffs: vec![VectorDiff::PushBack { value: json!("c") }],
                },
            ],
        }),
        "document_patch": batch(5, AppEvent::Patch {
            sub: SubId(2),
            rev: 3,
            epoch: 1,
            ops: vec![
                Op::Replace { path: "/names/ann".to_owned(), value: json!("Ann") },
                Op::Remove { path: "/names/bob".to_owned() },
            ],
        }),
        "reply_ok": batch(6, reply(Outcome::Ok { value: json!({"id": "x"}) })),
        "reply_rpc_error": batch(7, reply(Outcome::Error {
            error: ReplyError::Rpc { error: json!({"code": "denied"}) },
        })),
        "reply_lost": batch(8, reply(Outcome::Error {
            error: ReplyError::Lost { reason: LostReason::EpochChanged },
        })),
        "notice": batch(9, AppEvent::Notice {
            slice: "bookmarks".to_owned(),
            notice: json!({"type": "saved"}),
            epoch: 0,
        }),
        "resync": batch(10, AppEvent::Resync { sub: SubId(1), epoch: 1 }),
        "handshake": Handshake {
            schema: "0123456789abcdef".to_owned(),
            slices: vec!["bookmarks".to_owned(), "timeline".to_owned()],
        },
    })
}

#[test]
fn the_forms_match_the_fixture() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    let current = format!("{}\n", serde_json::to_string_pretty(&forms()).unwrap());
    if std::env::var_os("SABLE_UPDATE_FIXTURES").is_some() {
        std::fs::write(&path, &current).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        current,
        "the wire changed; regenerate the fixture and update the shells together"
    );
}

#[test]
fn every_form_decodes_and_encodes_back_to_itself() {
    let forms = forms();
    for (name, form) in forms.as_object().unwrap() {
        let json = form.to_string();
        let again = match name.as_str() {
            "subscribed" => serde_json::to_value(decode::<Subscribed>(&json).unwrap()),
            "handshake" => serde_json::to_value(decode::<Handshake>(&json).unwrap()),
            _ => serde_json::to_value(decode::<Batch>(&json).unwrap()),
        }
        .unwrap();
        assert_eq!(&again, form, "{name}");
    }
}

#[test]
fn the_compiled_in_schema_is_a_hash() {
    assert_eq!(WIRE_SCHEMA.len(), 16);
    assert!(WIRE_SCHEMA.bytes().all(|byte| byte.is_ascii_hexdigit()));
}
