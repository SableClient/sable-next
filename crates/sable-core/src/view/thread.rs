use sable_model::text::visible_name;

use matrix_sdk::ruma::events::room::message::{MessageType, RoomMessageEventContent};
use matrix_sdk::ruma::events::sticker::StickerEventContent;
use matrix_sdk::ruma::{MilliSecondsSinceUnixEpoch, OwnedEventId};
use matrix_sdk_ui::timeline::{
    EmbeddedEvent, MsgLikeContent, MsgLikeKind, TimelineDetails, TimelineEventItemId,
    TimelineItemContent,
};
use serde::Deserialize as _;
use serde_with::{DefaultOnError, serde_as};

use crate::matrix_html::{PreviewEmote, preview_body, preview_emotes};
use sable_model::event_preview::VERIFICATION_REQUEST_MSGTYPE;

use crate::protocol::{ReplyFallbackView, ReplyView, ThreadReplyView, ThreadSummaryView};

use super::content::formatted_body;
use super::media::gallery_filenames;
use super::raw::{ObjectOnly, ObjectOrDefault};

pub(super) const fn msg_like(content: &TimelineItemContent) -> Option<&MsgLikeContent> {
    match content {
        TimelineItemContent::MsgLike(msg) => Some(msg),
        _ => None,
    }
}

/// The event `content` replies to, while the SDK holds no body for it.
pub(crate) fn reply_without_body(content: &TimelineItemContent) -> Option<OwnedEventId> {
    in_reply_to(content)
        .filter(|reply| reply.body.is_none() && reply.fallback.is_none())
        .map(|reply| reply.event_id)
}

/// An unloaded event still yields its id.
pub(super) fn in_reply_to(content: &TimelineItemContent) -> Option<ReplyView> {
    let reply = msg_like(content)?.in_reply_to.as_ref()?;

    let embedded = match &reply.event {
        TimelineDetails::Ready(event) => Some(event),
        _ => None,
    };
    let sender = embedded.map(|event| event.sender.clone());
    let sender_mentioned = msg_like(content)
        .and_then(|msg| match &msg.kind {
            MsgLikeKind::Message(message) => message.mentions(),
            _ => None,
        })
        .is_some_and(|mentions| {
            sender
                .as_ref()
                .is_some_and(|sender| mentions.user_ids.contains(sender))
        });

    let (body, fallback, emotes) = embedded.map_or((None, None, Vec::new()), |event| {
        embedded_reply_preview(event)
    });

    Some(ReplyView {
        event_id: reply.event_id.clone(),
        sender,
        sender_mentioned,
        sender_name: embedded.and_then(|event| match &event.sender_profile {
            TimelineDetails::Ready(profile) => profile
                .display_name
                .as_deref()
                .and_then(visible_name)
                .map(str::to_owned),
            _ => None,
        }),
        body,
        fallback,
        emotes,
    })
}

pub(super) fn thread_summary(content: &TimelineItemContent) -> Option<ThreadSummaryView> {
    let summary = msg_like(content)?.thread_summary.as_ref()?;

    let (
        latest_event_id,
        latest_timestamp,
        latest_sender,
        (latest_body, latest_fallback, latest_emotes),
    ) = match &summary.latest_event {
        TimelineDetails::Ready(event) => (
            match &event.identifier {
                TimelineEventItemId::EventId(event_id) => Some(event_id.to_string()),
                TimelineEventItemId::TransactionId(_) => None,
            },
            Some(event.timestamp.0.into()),
            Some(event.sender.to_string()),
            embedded_reply_preview(event),
        ),
        _ => (None, None, None, (None, None, Vec::new())),
    };

    Some(ThreadSummaryView {
        num_replies: summary.num_replies,
        latest_event_id,
        latest_timestamp,
        latest_sender,
        current_user_participated: None,
        latest_body,
        latest_fallback,
        latest_emotes,
    })
}

pub(super) fn merge_thread_summary(
    local: Option<ThreadSummaryView>,
    bundled: Option<ThreadSummaryView>,
) -> Option<ThreadSummaryView> {
    match (local, bundled) {
        (Some(local), Some(bundled)) => {
            let (latest_event_id, latest_body, latest_fallback, latest_emotes) =
                if local.latest_event_id.is_some() {
                    (
                        local.latest_event_id,
                        local.latest_body,
                        local.latest_fallback,
                        local.latest_emotes,
                    )
                } else {
                    (
                        bundled.latest_event_id,
                        bundled.latest_body,
                        bundled.latest_fallback,
                        bundled.latest_emotes,
                    )
                };
            Some(ThreadSummaryView {
                num_replies: local.num_replies.max(bundled.num_replies),
                latest_event_id,
                latest_timestamp: local.latest_timestamp.or(bundled.latest_timestamp),
                latest_sender: local.latest_sender.or(bundled.latest_sender),
                current_user_participated: local
                    .current_user_participated
                    .or(bundled.current_user_participated),
                latest_body,
                latest_fallback,
                latest_emotes,
            })
        }
        (local, bundled) => local.or(bundled),
    }
}

pub(crate) fn thread_reply(raw: &serde_json::Value) -> Option<ThreadReplyView> {
    let obj = raw.as_object()?;
    if matches!(
        obj.get("type").and_then(serde_json::Value::as_str),
        Some("m.reaction" | "m.room.redaction")
    ) {
        return None;
    }
    if let Some(rel) = obj
        .get("content")
        .and_then(|c| c.get("m.relates_to"))
        .and_then(serde_json::Value::as_object)
        && (rel.get("key").is_some_and(|v| !v.is_null())
            || rel
                .get("rel_type")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|rel_type| rel_type != "m.thread"))
    {
        return None;
    }
    let ts: MilliSecondsSinceUnixEpoch =
        serde::Deserialize::deserialize(obj.get("origin_server_ts")?).ok()?;
    Some(ThreadReplyView {
        event_id: obj.get("event_id")?.as_str()?.to_owned(),
        sender: obj.get("sender")?.as_str()?.to_owned(),
        timestamp: ts.0.into(),
    })
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct BundledRelationsIn {
    #[serde_as(as = "ObjectOnly")]
    #[serde(rename = "m.thread")]
    thread: Option<BundledThreadIn>,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct BundledThreadIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    count: Option<u64>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    current_user_participated: Option<bool>,
    #[serde_as(as = "ObjectOrDefault")]
    latest_event: Option<BundledReplyIn>,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct BundledReplyIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    event_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    origin_server_ts: Option<MilliSecondsSinceUnixEpoch>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    sender: Option<String>,
    #[serde_as(as = "ObjectOnly")]
    content: Option<BundledReplyContentIn>,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct BundledReplyContentIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    msgtype: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    body: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    formatted_body: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "org.matrix.msc4553.forwarded")]
    forwarded: Option<serde_json::Value>,
}

pub(super) fn bundled_thread_summary(unsigned: &serde_json::Value) -> Option<ThreadSummaryView> {
    #[serde_as]
    #[derive(Default, serde::Deserialize)]
    #[serde(default)]
    struct UnsignedIn {
        #[serde_as(as = "ObjectOnly")]
        #[serde(rename = "m.relations")]
        relations: Option<BundledRelationsIn>,
    }

    if !unsigned.is_object() {
        return None;
    }
    let summary = UnsignedIn::deserialize(unsigned).ok()?.relations?.thread?;
    let count = u32::try_from(summary.count?).ok()?;
    let latest = summary.latest_event?;
    let latest_content = latest.content;
    let forwarded_preview = latest_content
        .as_ref()
        .and_then(|content| content.forwarded.as_ref())
        .and_then(|forwarded| forwarded.get("content"))
        .and_then(forwarded_content_preview);
    let verification = forwarded_preview.as_ref().map_or_else(
        || {
            latest_content.as_ref().is_some_and(|content| {
                content.msgtype.as_deref() == Some(VERIFICATION_REQUEST_MSGTYPE)
            })
        },
        |(_, fallback, _)| matches!(fallback, Some(ReplyFallbackView::VerificationRequest)),
    );
    let (latest_body, latest_emotes) = if let Some((body, _, emotes)) = forwarded_preview {
        (body, emotes)
    } else {
        latest_content
            .filter(|_| !verification)
            .and_then(|content| {
                let formatted = content.formatted_body.as_deref();
                content.body.as_deref().map(|body| {
                    (
                        Some(preview_body(body, formatted)),
                        preview_emotes(formatted),
                    )
                })
            })
            .unwrap_or_default()
    };

    Some(ThreadSummaryView {
        num_replies: count,
        latest_event_id: latest.event_id,
        latest_timestamp: latest.origin_server_ts.map(|ts| ts.0.into()),
        latest_sender: latest.sender,
        current_user_participated: summary.current_user_participated,
        latest_body,
        latest_fallback: verification.then_some(ReplyFallbackView::VerificationRequest),
        latest_emotes,
    })
}

/// The quoted body as plain text, since a preview must not run untrusted HTML,
/// or what the event was when it has none.
type Preview = (Option<String>, Option<ReplyFallbackView>, Vec<PreviewEmote>);

fn reply_preview(content: &TimelineItemContent) -> Preview {
    let TimelineItemContent::MsgLike(msg) = content else {
        return (None, None, Vec::new());
    };
    let mut emotes = Vec::new();
    let body = match &msg.kind {
        MsgLikeKind::Message(message) => match message.msgtype() {
            MessageType::VerificationRequest(_) => {
                return (
                    None,
                    Some(ReplyFallbackView::VerificationRequest),
                    Vec::new(),
                );
            }
            MessageType::Gallery(gallery) if gallery.body.is_empty() => {
                gallery_filenames(gallery).join(", ")
            }
            _ => {
                let formatted = formatted_body(message.msgtype());
                emotes = preview_emotes(formatted.as_deref());
                preview_body(message.body(), formatted.as_deref())
            }
        },
        MsgLikeKind::Sticker(sticker) => sticker.content().body.clone(),
        MsgLikeKind::Poll(state) => state.results().question,
        _ => return (None, None, Vec::new()),
    };
    (Some(body), None, emotes)
}

fn embedded_reply_preview(event: &EmbeddedEvent) -> Preview {
    if event.content.is_redacted() {
        return reply_preview(&event.content);
    }
    let preview = (|| {
        let original = event
            .original_json
            .as_ref()?
            .deserialize_as_unchecked::<serde_json::Value>()
            .ok()?;
        let event_type = original.get("type")?.as_str()?;
        let content = original.get("content")?;
        let forwarded = content.get(super::forward::FORWARDED)?.as_object()?;
        let nested = forwarded.get("content").filter(|nested| match event_type {
            "m.room.message" => {
                serde_json::from_value::<RoomMessageEventContent>((*nested).clone()).is_ok()
            }
            "m.sticker" => serde_json::from_value::<StickerEventContent>((*nested).clone()).is_ok(),
            _ => false,
        });
        let selected = nested.unwrap_or(content);
        let (mut body, fallback, emotes) = forwarded_content_preview(selected)?;
        if nested.is_some()
            && selected.get("msgtype").and_then(serde_json::Value::as_str) == Some("m.emote")
        {
            let actor = forwarded
                .get("sender")
                .and_then(serde_json::Value::as_str)
                .and_then(|sender| ruma::UserId::parse(sender).ok());
            if let Some(body) = &mut body {
                *body = format!(
                    "{} {body}",
                    actor.as_deref().map_or("Sender", |sender| sender.as_str())
                );
            }
        }
        Some((body, fallback, emotes))
    })();
    preview.unwrap_or_else(|| reply_preview(&event.content))
}

fn forwarded_content_preview(forwarded: &serde_json::Value) -> Option<Preview> {
    if let Ok(message) = serde_json::from_value::<RoomMessageEventContent>(forwarded.clone()) {
        if matches!(message.msgtype, MessageType::VerificationRequest(_)) {
            return Some((
                None,
                Some(ReplyFallbackView::VerificationRequest),
                Vec::new(),
            ));
        }
        let body = message.msgtype.body();
        let formatted = formatted_body(&message.msgtype);
        return Some((
            Some(preview_body(body, formatted.as_deref())),
            None,
            preview_emotes(formatted.as_deref()),
        ));
    }
    if let Ok(sticker) = serde_json::from_value::<StickerEventContent>(forwarded.clone()) {
        return Some((Some(sticker.body), None, Vec::new()));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    fn embedded_forward(content: &serde_json::Value) -> EmbeddedEvent {
        use matrix_sdk::ruma::{
            MilliSecondsSinceUnixEpoch, owned_event_id, owned_user_id, serde::Raw,
        };
        EmbeddedEvent {
            content: TimelineItemContent::CallInvite,
            original_json: Some(
                Raw::from_json_string(
                    json!({
                        "type": "m.room.message",
                        "content": content
                    })
                    .to_string(),
                )
                .unwrap(),
            ),
            sender: owned_user_id!("@forwarder:example.org"),
            sender_profile: TimelineDetails::Unavailable,
            timestamp: MilliSecondsSinceUnixEpoch::now(),
            identifier: TimelineEventItemId::EventId(owned_event_id!("$forward")),
        }
    }

    #[test]
    fn embedded_forwards_use_nested_content_instead_of_sdk_fallback() {
        let event = embedded_forward(&json!({
            "msgtype": "m.text", "body": "Forwarded message\nfallback",
            "org.matrix.msc4553.forwarded": {
                "content": { "msgtype": "m.text", "body": "original",
                    "format": "org.matrix.custom.html", "formatted_body": "<b>original</b>" }
            }
        }));
        assert_eq!(
            embedded_reply_preview(&event),
            (Some("original".to_owned()), None, Vec::new())
        );
    }

    #[test]
    fn embedded_forwards_with_invalid_content_use_the_original_fallback() {
        let event = embedded_forward(&json!({
            "msgtype": "m.text", "body": "original fallback",
            "org.matrix.msc4553.forwarded": { "content": { "msgtype": "m.text" } }
        }));
        assert_eq!(
            embedded_reply_preview(&event),
            (Some("original fallback".to_owned()), None, Vec::new())
        );
    }

    #[test]
    fn embedded_forwarded_emotes_attribute_the_original_sender_or_a_generic_actor() {
        for (metadata, expected) in [
            (
                json!({ "sender": "@alice:example.org", "content": { "msgtype": "m.emote", "body": "waves" } }),
                "@alice:example.org waves",
            ),
            (
                json!({ "content": { "msgtype": "m.emote", "body": "waves" } }),
                "Sender waves",
            ),
        ] {
            let event = embedded_forward(&json!({
                "msgtype": "m.text", "body": "fallback",
                "org.matrix.msc4553.forwarded": metadata
            }));
            assert_eq!(embedded_reply_preview(&event).0.as_deref(), Some(expected));
        }
    }

    #[test]
    fn redacted_embedded_forwards_do_not_display_original_content() {
        let mut event = embedded_forward(&json!({
            "msgtype": "m.text", "body": "fallback",
            "org.matrix.msc4553.forwarded": { "content": { "msgtype": "m.text", "body": "secret" } }
        }));
        event.content = TimelineItemContent::MsgLike(MsgLikeContent {
            kind: MsgLikeKind::Redacted,
            thread_root: None,
            in_reply_to: None,
            thread_summary: None,
        });
        assert_eq!(embedded_reply_preview(&event), (None, None, Vec::new()));
    }

    #[test]
    fn standalone_thread_root_uses_bundled_reply_summary() {
        let unsigned = json!({
            "m.relations": {
                "m.thread": {
                    "count": 3,
                    "current_user_participated": true,
                    "latest_event": {
                        "event_id": "$reply:example.org",
                        "origin_server_ts": 1_700_000_005_000_u64,
                        "sender": "@bob:example.org",
                        "content": { "body": "Latest reply" }
                    }
                }
            }
        });

        let summary = bundled_thread_summary(&unsigned).expect("thread summary");
        assert_eq!(summary.num_replies, 3);
        assert_eq!(
            summary.latest_event_id.as_deref(),
            Some("$reply:example.org")
        );
        assert_eq!(summary.latest_timestamp, Some(1_700_000_005_000));
        assert_eq!(summary.latest_sender.as_deref(), Some("@bob:example.org"));
        assert_eq!(summary.current_user_participated, Some(true));
        assert_eq!(summary.latest_body.as_deref(), Some("Latest reply"));
    }

    #[test]
    fn bundled_thread_summary_uses_valid_forwarded_content() {
        let summary = bundled_thread_summary(&json!({
            "m.relations": {
                "m.thread": {
                    "count": 1,
                    "latest_event": {
                        "event_id": "$forward:example.org",
                        "content": {
                            "msgtype": "m.text",
                            "body": "Forwarded message\nfallback",
                            "org.matrix.msc4553.forwarded": {
                                "content": { "msgtype": "m.text", "body": "original" }
                            }
                        }
                    }
                }
            }
        }))
        .expect("thread summary");

        assert_eq!(summary.latest_body.as_deref(), Some("original"));
    }

    #[test]
    fn a_bundled_latest_reply_keeps_its_custom_emotes() {
        let summary = bundled_thread_summary(&json!({
            "m.relations": { "m.thread": { "count": 1, "latest_event": {
                "event_id": "$reply:example.org",
                "content": {
                    "msgtype": "m.text",
                    "body": "hi :blob:",
                    "format": "org.matrix.custom.html",
                    "formatted_body": "hi <img data-mx-emoticon src=\"mxc://example.org/blob\" alt=\":blob:\">"
                }
            } } },
        }))
        .expect("thread summary");

        assert_eq!(summary.latest_body.as_deref(), Some("hi :blob:"));
        assert_eq!(
            summary.latest_emotes,
            [PreviewEmote {
                alt: ":blob:".to_owned(),
                source: "mxc://example.org/blob".to_owned(),
            }]
        );
    }

    #[test]
    fn a_verification_request_as_the_latest_reply_shows_its_fallback_not_its_body() {
        let unsigned = json!({
            "m.relations": {
                "m.thread": {
                    "count": 1,
                    "latest_event": {
                        "event_id": "$request:example.org",
                        "content": {
                            "msgtype": "m.key.verification.request",
                            "body": "Your client does not support verification"
                        }
                    }
                }
            }
        });

        let summary = bundled_thread_summary(&unsigned).expect("thread summary");
        assert_eq!(summary.latest_body, None);
        assert_eq!(
            summary.latest_fallback,
            Some(ReplyFallbackView::VerificationRequest)
        );
    }

    #[test]
    fn merge_prefers_the_larger_bundled_count_and_keeps_local_preview() {
        let view = |num_replies, latest: Option<&str>| ThreadSummaryView {
            num_replies,
            latest_event_id: latest.map(ToOwned::to_owned),
            latest_timestamp: None,
            latest_sender: None,
            current_user_participated: None,
            latest_body: None,
            latest_fallback: None,
            latest_emotes: Vec::new(),
        };
        let merged = merge_thread_summary(
            Some(view(0, Some("$local"))),
            Some(view(5, Some("$bundled"))),
        )
        .expect("summary");
        assert_eq!(merged.num_replies, 5);
        assert_eq!(merged.latest_event_id.as_deref(), Some("$local"));
        let merged = merge_thread_summary(
            Some(view(7, Some("$local"))),
            Some(view(5, Some("$bundled"))),
        )
        .expect("summary");
        assert_eq!(merged.num_replies, 7);
        assert!(merge_thread_summary(None, Some(view(2, Some("$b")))).is_some());

        let bundled = ThreadSummaryView {
            num_replies: 2,
            latest_event_id: Some("$bundled".to_owned()),
            latest_timestamp: Some(42),
            latest_sender: Some("@bob:example.org".to_owned()),
            current_user_participated: Some(true),
            latest_body: Some("Latest".to_owned()),
            latest_fallback: None,
            latest_emotes: Vec::new(),
        };
        let fallback = merge_thread_summary(Some(view(1, None)), Some(bundled)).expect("summary");
        assert_eq!(fallback.latest_event_id.as_deref(), Some("$bundled"));
        assert_eq!(fallback.latest_body.as_deref(), Some("Latest"));
        assert_eq!(fallback.latest_timestamp, Some(42));
        assert_eq!(fallback.latest_sender.as_deref(), Some("@bob:example.org"));
    }

    #[test]
    fn a_bundled_thread_summary_tolerates_a_sparse_latest_event() {
        let summary = bundled_thread_summary(&json!({
            "m.relations": { "m.thread": { "count": 3, "latest_event": null } },
        }))
        .expect("summary");
        assert_eq!(summary.num_replies, 3);
        assert_eq!(summary.latest_event_id, None);
        assert_eq!(summary.latest_body, None);

        assert!(
            bundled_thread_summary(&json!({
                "m.relations": { "m.thread": { "count": "3", "latest_event": {} } },
            }))
            .is_none()
        );
        assert!(
            bundled_thread_summary(&json!({ "m.relations": { "m.thread": { "count": 3 } } }))
                .is_none()
        );
    }

    #[test]
    fn thread_reply_filters_aggregations_and_extracts_fields() {
        let reply = json!({
            "event_id": "$r1",
            "sender": "@bob:example.org",
            "origin_server_ts": 1_700_000_000_000_u64,
            "type": "m.room.message",
            "content": { "m.relates_to": { "rel_type": "m.thread", "event_id": "$root" } }
        });
        assert_eq!(
            thread_reply(&reply),
            Some(ThreadReplyView {
                event_id: "$r1".to_owned(),
                sender: "@bob:example.org".to_owned(),
                timestamp: 1_700_000_000_000,
            })
        );

        for raw in [
            json!({
                "event_id": "$rx",
                "sender": "@bob:example.org",
                "origin_server_ts": 100,
                "type": "m.reaction",
                "content": { "m.relates_to": { "rel_type": "m.annotation", "key": "👍" } }
            }),
            json!({
                "event_id": "$del",
                "sender": "@bob:example.org",
                "origin_server_ts": 100,
                "type": "m.room.redaction"
            }),
            json!({
                "event_id": "$ed",
                "sender": "@bob:example.org",
                "origin_server_ts": 100,
                "type": "m.room.message",
                "content": { "m.relates_to": { "rel_type": "m.replace", "event_id": "$r1" } }
            }),
        ] {
            assert_eq!(thread_reply(&raw), None);
        }
    }
}
