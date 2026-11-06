use sable_model::text::visible_name;

use matrix_sdk::ruma::OwnedEventId;
use matrix_sdk::ruma::events::room::message::{MessageType, RoomMessageEventContent};
use matrix_sdk::ruma::events::sticker::StickerEventContent;
use matrix_sdk_ui::timeline::{
    EmbeddedEvent, MsgLikeContent, MsgLikeKind, TimelineDetails, TimelineEventItemId,
    TimelineItemContent,
};
use serde::Deserialize as _;
use serde_with::{DefaultOnError, serde_as};

use crate::matrix_html::preview_body;
use sable_model::event_preview::VERIFICATION_REQUEST_MSGTYPE;

use crate::protocol::{ReplyFallbackView, ReplyView, ThreadSummaryView};

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

    let (body, fallback) = embedded.map_or((None, None), |event| embedded_reply_preview(event));

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
    })
}

pub(super) fn thread_summary(content: &TimelineItemContent) -> Option<ThreadSummaryView> {
    let summary = msg_like(content)?.thread_summary.as_ref()?;

    let (latest_event_id, (latest_body, latest_fallback)) = match &summary.latest_event {
        TimelineDetails::Ready(event) => (
            match &event.identifier {
                TimelineEventItemId::EventId(event_id) => Some(event_id.to_string()),
                TimelineEventItemId::TransactionId(_) => None,
            },
            embedded_reply_preview(event),
        ),
        _ => (None, (None, None)),
    };

    Some(ThreadSummaryView {
        num_replies: summary.num_replies,
        latest_event_id,
        latest_body,
        latest_fallback,
    })
}

pub(super) fn merge_thread_summary(
    local: Option<ThreadSummaryView>,
    bundled: Option<ThreadSummaryView>,
) -> Option<ThreadSummaryView> {
    match (local, bundled) {
        (Some(local), Some(bundled)) if bundled.num_replies > local.num_replies => {
            Some(ThreadSummaryView {
                num_replies: bundled.num_replies,
                ..local
            })
        }
        (local, bundled) => local.or(bundled),
    }
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
    #[serde_as(as = "ObjectOrDefault")]
    latest_event: Option<BundledReplyIn>,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct BundledReplyIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    event_id: Option<String>,
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
        |(_, fallback)| matches!(fallback, Some(ReplyFallbackView::VerificationRequest)),
    );
    let latest_body = if let Some((body, _)) = forwarded_preview {
        body
    } else {
        latest_content
            .filter(|_| !verification)
            .and_then(|content| {
                let formatted = content.formatted_body.as_deref();
                content
                    .body
                    .as_deref()
                    .map(|body| preview_body(body, formatted))
            })
    };

    Some(ThreadSummaryView {
        num_replies: count,
        latest_event_id: latest.event_id,
        latest_body,
        latest_fallback: verification.then_some(ReplyFallbackView::VerificationRequest),
    })
}

/// The quoted body as plain text, since a preview must not run untrusted HTML,
/// or what the event was when it has none.
fn reply_preview(content: &TimelineItemContent) -> (Option<String>, Option<ReplyFallbackView>) {
    let TimelineItemContent::MsgLike(msg) = content else {
        return (None, None);
    };
    let body = match &msg.kind {
        MsgLikeKind::Message(message) => match message.msgtype() {
            MessageType::VerificationRequest(_) => {
                return (None, Some(ReplyFallbackView::VerificationRequest));
            }
            MessageType::Gallery(gallery) if gallery.body.is_empty() => {
                gallery_filenames(gallery).join(", ")
            }
            _ => preview_body(message.body(), formatted_body(message.msgtype()).as_deref()),
        },
        MsgLikeKind::Sticker(sticker) => sticker.content().body.clone(),
        MsgLikeKind::Poll(state) => state.results().question,
        _ => return (None, None),
    };
    (Some(body), None)
}

fn embedded_reply_preview(event: &EmbeddedEvent) -> (Option<String>, Option<ReplyFallbackView>) {
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
        let (mut body, fallback) = forwarded_content_preview(selected)?;
        if nested.is_some()
            && selected.get("msgtype").and_then(serde_json::Value::as_str) == Some("m.emote")
        {
            let actor = forwarded
                .get("sender")
                .and_then(serde_json::Value::as_str)
                .and_then(|sender| matrix_sdk::ruma::UserId::parse(sender).ok());
            if let Some(body) = &mut body {
                *body = format!(
                    "{} {body}",
                    actor.as_deref().map_or("Sender", |sender| sender.as_str())
                );
            }
        }
        Some((body, fallback))
    })();
    preview.unwrap_or_else(|| reply_preview(&event.content))
}

fn forwarded_content_preview(
    forwarded: &serde_json::Value,
) -> Option<(Option<String>, Option<ReplyFallbackView>)> {
    if let Ok(message) = serde_json::from_value::<RoomMessageEventContent>(forwarded.clone()) {
        if matches!(message.msgtype, MessageType::VerificationRequest(_)) {
            return Some((None, Some(ReplyFallbackView::VerificationRequest)));
        }
        let body = message.msgtype.body();
        let formatted = formatted_body(&message.msgtype);
        return Some((Some(preview_body(body, formatted.as_deref())), None));
    }
    if let Ok(sticker) = serde_json::from_value::<StickerEventContent>(forwarded.clone()) {
        return Some((Some(sticker.body), None));
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
            (Some("original".to_owned()), None)
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
            (Some("original fallback".to_owned()), None)
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
        assert_eq!(embedded_reply_preview(&event), (None, None));
    }

    #[test]
    fn standalone_thread_root_uses_bundled_reply_summary() {
        let unsigned = json!({
            "m.relations": {
                "m.thread": {
                    "count": 3,
                    "latest_event": {
                        "event_id": "$reply:example.org",
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
        let view = |num_replies, latest: &str| ThreadSummaryView {
            num_replies,
            latest_event_id: Some(latest.to_owned()),
            latest_body: None,
            latest_fallback: None,
        };
        let merged = merge_thread_summary(Some(view(0, "$local")), Some(view(5, "$bundled")))
            .expect("summary");
        assert_eq!(merged.num_replies, 5);
        assert_eq!(merged.latest_event_id.as_deref(), Some("$local"));
        let merged = merge_thread_summary(Some(view(7, "$local")), Some(view(5, "$bundled")))
            .expect("summary");
        assert_eq!(merged.num_replies, 7);
        assert!(merge_thread_summary(None, Some(view(2, "$b"))).is_some());
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
}
