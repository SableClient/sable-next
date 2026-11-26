use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::sticker::StickerEventContent;
use matrix_sdk_ui::timeline::EventTimelineItem;
use serde::Deserialize as _;
use serde_with::{DefaultOnError, serde_as};

use crate::protocol::ForwardedView;

use super::raw::{ObjectOnly, RawFields};

pub(crate) const FORWARDED: &str = "org.matrix.msc4553.forwarded";
pub(crate) const FAMEDLY_FORWARDED: &str = "com.famedly.app.forwarded";
pub(crate) const SABLE_FORWARDED: &str = "moe.sable.message.forward";

#[derive(serde::Deserialize)]
struct OriginalContent {
    content: Option<serde_json::Value>,
}

pub(super) fn original_content(event: &EventTimelineItem) -> Option<serde_json::Value> {
    let original = event
        .original_json()?
        .deserialize_as_unchecked::<OriginalContent>()
        .ok()?;
    original.content
}

pub(super) fn forwarded(event: &EventTimelineItem, raw: &RawFields) -> Option<ForwardedView> {
    if event.latest_edit_json().is_none() {
        return forward_meta(raw.content.as_ref()?);
    }
    let original = event
        .original_json()?
        .deserialize_as_unchecked::<OriginalContent>()
        .ok()?;
    forward_meta(original.content.as_ref()?)
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct ForwardContentIn {
    #[serde_as(as = "ObjectOnly")]
    #[serde(rename = "org.matrix.msc4553.forwarded")]
    msc4553: Option<ForwardIn>,
    #[serde_as(as = "ObjectOnly")]
    #[serde(rename = "moe.sable.message.forward")]
    sable: Option<SableForwardIn>,
    #[serde_as(as = "ObjectOnly")]
    #[serde(rename = "com.famedly.app.forwarded")]
    famedly: Option<ForwardIn>,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SableForwardIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "original_event_private")]
    private: Option<bool>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "original_timestamp")]
    timestamp: Option<u64>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "original_room_id")]
    room_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "original_event_id")]
    event_id: Option<String>,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct ForwardIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    origin_server_ts: Option<u64>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    room_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    room_name: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    event_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    sender: Option<String>,
}

pub(super) fn forward_meta(content: &serde_json::Value) -> Option<ForwardedView> {
    if !content.is_object() {
        return None;
    }
    let msc_content_valid = msc_forward_content_valid(content);
    let content = ForwardContentIn::deserialize(content).ok()?;
    if let Some(meta) = content.msc4553 {
        return Some(forward_view(meta, msc_content_valid));
    }
    if let Some(meta) = content.sable {
        let private = meta.private.unwrap_or(false);
        return Some(ForwardedView {
            timestamp: meta.timestamp,
            room_id: (!private).then(|| meta.room_id?.try_into().ok()).flatten(),
            room_name: None,
            event_id: (!private).then(|| meta.event_id?.try_into().ok()).flatten(),
            sender: None,
            content_valid: None,
        });
    }
    content.famedly.map(|meta| forward_view(meta, None))
}

fn forward_view(meta: ForwardIn, content_valid: Option<bool>) -> ForwardedView {
    ForwardedView {
        timestamp: meta.origin_server_ts,
        room_id: meta.room_id.and_then(|room| room.try_into().ok()),
        room_name: meta.room_name,
        event_id: meta.event_id.and_then(|event| event.try_into().ok()),
        sender: meta.sender.and_then(|sender| sender.try_into().ok()),
        content_valid,
    }
}

fn msc_forward_content_valid(content: &serde_json::Value) -> Option<bool> {
    let forwarded = content.get(FORWARDED)?.as_object()?;
    Some(forwarded.get("content").is_some_and(|original| {
        if content.get("msgtype").is_some() {
            serde_json::from_value::<RoomMessageEventContent>(original.clone()).is_ok()
        } else {
            serde_json::from_value::<StickerEventContent>(original.clone()).is_ok()
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    use matrix_sdk::ruma::RoomId;
    use serde_json::json;

    #[test]
    fn forward_meta_prefers_the_sable_key_and_hides_private_origins() {
        let sable = forward_meta(&json!({
            "moe.sable.message.forward": {
                "original_timestamp": 5,
                "original_room_id": "!secret:example.org",
                "original_event_id": "$secret",
                "original_event_private": true
            },
            "com.famedly.app.forwarded": {
                "origin_server_ts": 9,
                "room_id": "!other:example.org",
                "event_id": "$other"
            }
        }))
        .unwrap();
        assert_eq!(sable.timestamp, Some(5));
        assert_eq!(sable.room_id, None);
        assert_eq!(sable.event_id, None);

        let famedly = forward_meta(&json!({
            "com.famedly.app.forwarded": {
                "origin_server_ts": 9,
                "room_id": "!room:example.org",
                "event_id": "$event"
            }
        }))
        .unwrap();
        assert_eq!(famedly.timestamp, Some(9));
        assert_eq!(
            famedly.room_id.as_deref().map(RoomId::as_str),
            Some("!room:example.org")
        );
        assert_eq!(
            famedly.event_id.as_deref().map(ruma::EventId::as_str),
            Some("$event")
        );

        assert!(forward_meta(&json!({ "body": "hello" })).is_none());
    }

    #[test]
    fn forward_meta_prefers_msc4553_over_legacy_keys() {
        let meta = forward_meta(&json!({
            "msgtype": "m.text",
            "body": "fallback",
            "org.matrix.msc4553.forwarded": {
                "origin_server_ts": 3,
                "room_id": "!room:example.org",
                "event_id": "$event",
                "content": { "msgtype": "m.text", "body": "hi" }
            },
            "moe.sable.message.forward": { "original_timestamp": 5 },
            "com.famedly.app.forwarded": { "origin_server_ts": 9 }
        }))
        .unwrap();
        assert_eq!(meta.timestamp, Some(3));
        assert_eq!(
            meta.event_id.as_deref().map(ruma::EventId::as_str),
            Some("$event")
        );
        assert_eq!(meta.room_name, None);
        assert_eq!(meta.content_valid, Some(true));

        let named = forward_meta(&json!({
            "msgtype": "m.text",
            "body": "fallback",
            "org.matrix.msc4553.forwarded": {
                "room_name": "Announcements",
                "content": { "msgtype": "m.text", "body": "hi" }
            }
        }))
        .unwrap();
        assert_eq!(named.room_name.as_deref(), Some("Announcements"));

        let bare = forward_meta(&json!({
            "msgtype": "m.text",
            "body": "fallback",
            "org.matrix.msc4553.forwarded": { "content": { "msgtype": "m.text", "body": "hi" } }
        }))
        .unwrap();
        assert_eq!(bare.timestamp, None);
        assert_eq!(bare.room_id, None);
        assert_eq!(bare.content_valid, Some(true));

        let invalid = forward_meta(&json!({
            "msgtype": "m.text",
            "body": "fallback",
            "org.matrix.msc4553.forwarded": { "content": { "msgtype": "m.text" } }
        }))
        .unwrap();
        assert_eq!(invalid.content_valid, Some(false));

        let missing = forward_meta(&json!({
            "msgtype": "m.text",
            "body": "fallback",
            "org.matrix.msc4553.forwarded": {}
        }))
        .unwrap();
        assert_eq!(missing.content_valid, Some(false));
    }

    #[test]
    fn forwarded_sticker_content_is_validated_as_a_sticker_event() {
        let sticker = json!({ "body": "seal", "url": "mxc://example.org/seal", "info": {} });
        let meta = forward_meta(&json!({
            "body": "seal",
            "url": "mxc://example.org/seal",
            "info": {},
            "org.matrix.msc4553.forwarded": { "content": sticker }
        }))
        .unwrap();

        assert_eq!(meta.content_valid, Some(true));
    }

    #[test]
    fn forwarded_metadata_skips_wrong_typed_fields() {
        let meta = forward_meta(&json!({ "moe.sable.message.forward": {
            "original_timestamp": "soon",
            "original_event_private": 1,
            "original_room_id": "!r:example.org",
        } }))
        .expect("forwarded");
        assert_eq!(meta.timestamp, None);
        assert_eq!(
            meta.room_id.as_deref().map(RoomId::as_str),
            Some("!r:example.org")
        );

        let falls_through = forward_meta(&json!({
            "moe.sable.message.forward": "no",
            "com.famedly.app.forwarded": { "origin_server_ts": 9 },
        }))
        .expect("forwarded");
        assert_eq!(falls_through.timestamp, Some(9));

        let unnamed = forward_meta(&json!({
            "org.matrix.msc4553.forwarded": { "room_name": 5, "origin_server_ts": 2 }
        }))
        .expect("forwarded");
        assert_eq!(unnamed.room_name, None);
        assert_eq!(unnamed.timestamp, Some(2));
    }
}
