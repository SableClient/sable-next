//! What to quote for an event read from its source, when there is no rendered
//! timeline item for it: its body, or what it was instead.

use serde::Serialize;
use serde_json::Value;

/// What a quoted event was, when it has no body to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ReplyFallbackView {
    Redacted,
    Reaction { key: String },
    Redaction,
    Event { event_type: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct EventPreview {
    pub sender: Option<String>,
    pub body: Option<String>,
    pub fallback: Option<ReplyFallbackView>,
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

/// A custom reaction's `:shortcode:`, else its key.
#[must_use]
pub fn reaction_key(content: &Value) -> Option<String> {
    let shortcode = text(content.get("shortcode"))
        .or_else(|| text(content.get("com.beeper.reaction.shortcode")));
    let name = shortcode.map(|shortcode| shortcode.trim().trim_matches(':').trim().to_owned());
    name.filter(|name| !name.is_empty()).map_or_else(
        || {
            text(
                content
                    .get("m.relates_to")
                    .and_then(|relation| relation.get("key")),
            )
        },
        |name| Some(format!(":{name}:")),
    )
}

#[must_use]
pub fn event_preview(source: &Value) -> Option<EventPreview> {
    let event_type = source.get("type")?.as_str()?;
    let sender = source
        .get("sender")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let content = source.get("content").unwrap_or(&Value::Null);
    let stand_in = |fallback| {
        Some(EventPreview {
            sender: sender.clone(),
            body: None,
            fallback: Some(fallback),
        })
    };
    if source
        .get("unsigned")
        .and_then(|unsigned| unsigned.get("redacted_because"))
        .is_some_and(Value::is_object)
    {
        return stand_in(ReplyFallbackView::Redacted);
    }
    if event_type == "m.reaction"
        && let Some(key) = reaction_key(content)
    {
        return stand_in(ReplyFallbackView::Reaction { key });
    }
    if event_type == "m.room.redaction" {
        return stand_in(ReplyFallbackView::Redaction);
    }
    if let Some(body) = text(content.get("body")) {
        return Some(EventPreview {
            sender,
            body: Some(body),
            fallback: None,
        });
    }
    stand_in(ReplyFallbackView::Event {
        event_type: event_type.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn read(source: &Value) -> EventPreview {
        event_preview(source).expect("a preview")
    }

    #[test]
    fn a_source_reads_as_its_body_or_what_it_was() {
        assert_eq!(
            read(&json!({"type": "org.example.note", "sender": "@b:x", "content": {"body": "hi"}})),
            EventPreview {
                sender: Some("@b:x".to_owned()),
                body: Some("hi".to_owned()),
                fallback: None
            }
        );
        assert_eq!(
            read(&json!({"type": "m.room.topic", "content": {}})).fallback,
            Some(ReplyFallbackView::Event {
                event_type: "m.room.topic".to_owned()
            })
        );
        assert_eq!(
            read(&json!({
                "type": "m.room.message",
                "content": {"body": "Old body"},
                "unsigned": {"redacted_because": {"type": "m.room.redaction", "content": {}}}
            }))
            .fallback,
            Some(ReplyFallbackView::Redacted)
        );
        assert_eq!(
            read(&json!({"type": "m.room.redaction", "content": {}})).fallback,
            Some(ReplyFallbackView::Redaction)
        );
        assert_eq!(
            read(&json!({
                "type": "m.reaction",
                "content": {"shortcode": "::blob::", "m.relates_to": {"key": "mxc://x/y"}}
            }))
            .fallback,
            Some(ReplyFallbackView::Reaction {
                key: ":blob:".to_owned()
            })
        );
        assert!(event_preview(&json!([])).is_none());
    }
}
