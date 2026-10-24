//! Timeline items for the tests.

use sable_protocol::{TimelineItemContentView, TimelineItemView};
use serde_json::{Value, json};

/// An item as the core sends it, with the row fields its content implies.
#[must_use]
pub(super) fn item(content: Value, id: &str) -> TimelineItemView {
    let content: TimelineItemContentView =
        serde_json::from_value(content).expect("the content is a timeline content");
    serde_json::from_value(json!({
        "id": id,
        "row": content.row_kind(),
        "forwardable": content.forwardable(),
        "redactable": content.redactable(),
        "visibility": content.visibility(),
        "event_id": format!("${id}"),
        "transaction_id": null,
        "send_state": null,
        "sender": "@alice:x",
        "sender_name": "Alice",
        "sender_avatar": null,
        "timestamp": 1_000,
        "content": content,
        "in_reply_to": null,
        "thread_root": null,
        "thread_summary": null,
        "reactions": [],
        "is_own": false,
        "read_by": [],
        "read_timestamps": {},
        "per_message_profile": null,
        "bundled_link_previews": [],
        "link_previews_removed": null,
        "mention": "none",
        "forwarded": null,
        "forum_title": null,
    }))
    .expect("the item is a timeline item")
}

/// `item` with some of its fields replaced.
#[must_use]
pub(super) fn with(item: &TimelineItemView, changes: &Value) -> TimelineItemView {
    let mut value = serde_json::to_value(item).expect("an item serialises");
    if let (Value::Object(fields), Value::Object(changes)) = (&mut value, changes) {
        for (name, change) in changes {
            fields.insert(name.clone(), change.clone());
        }
    }
    serde_json::from_value(value).expect("the changed item is a timeline item")
}

#[must_use]
pub(super) fn text(id: &str) -> TimelineItemView {
    item(
        json!({
            "kind": "message",
            "body": id,
            "html": id,
            "emote": false,
            "notice": false,
            "edited": false,
        }),
        id,
    )
}

#[must_use]
pub(super) fn join(id: &str) -> TimelineItemView {
    with(
        &item(
            json!({
                "kind": "membership",
                "user_id": format!("@{id}:x"),
                "change": "joined",
                "display_name": id,
                "reason": null,
            }),
            id,
        ),
        &json!({ "sender": format!("@{id}:x") }),
    )
}

#[must_use]
pub(super) fn read_marker() -> TimelineItemView {
    with(
        &item(json!({ "kind": "read_marker" }), "marker"),
        &json!({ "event_id": null }),
    )
}
