use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::events::room::message::{MessageFormat, MessageType};
use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, AnySyncStateEvent, AnySyncTimelineEvent};
use sable_model::truncate::truncate_graphemes;

const FALLBACK: &str = "sent a message";
const MAX_REACTION_BYTES: usize = 256;

pub(crate) fn describe(event: &AnySyncTimelineEvent) -> String {
    let message = match event {
        AnySyncTimelineEvent::MessageLike(message) => message,
        AnySyncTimelineEvent::State(AnySyncStateEvent::RoomMember(member)) => {
            return member
                .as_original()
                .and_then(|event| describe_membership(&event.content.membership))
                .unwrap_or(FALLBACK)
                .to_owned();
        }
        AnySyncTimelineEvent::State(_) => return FALLBACK.to_owned(),
    };

    match message {
        AnySyncMessageLikeEvent::RoomMessage(message) => message.as_original().map_or_else(
            || FALLBACK.to_owned(),
            |event| describe_message(&event.content.msgtype),
        ),
        AnySyncMessageLikeEvent::RoomEncrypted(_) => "sent an encrypted message".to_owned(),
        AnySyncMessageLikeEvent::Sticker(_) => "sent a sticker".to_owned(),
        AnySyncMessageLikeEvent::Reaction(reaction) => reaction.as_original().map_or_else(
            || FALLBACK.to_owned(),
            |event| describe_reaction(&event.content.relates_to.key),
        ),
        AnySyncMessageLikeEvent::UnstablePollStart(poll) => poll.as_original().map_or_else(
            || FALLBACK.to_owned(),
            |event| event.content.poll_start().question.text.clone(),
        ),
        AnySyncMessageLikeEvent::CallInvite(_) => "started a call".to_owned(),
        _ => FALLBACK.to_owned(),
    }
}

const fn describe_membership(membership: &MembershipState) -> Option<&'static str> {
    match membership {
        MembershipState::Join => Some("joined the room"),
        MembershipState::Leave => Some("left the room"),
        MembershipState::Knock => Some("requested to join"),
        MembershipState::Invite => Some("was invited"),
        MembershipState::Ban => Some("was banned"),
        _ => None,
    }
}

fn describe_reaction(key: &str) -> String {
    if key.starts_with("mxc://") {
        return "reacted with a custom emote".to_owned();
    }
    let shown = truncate_graphemes(key, MAX_REACTION_BYTES);
    let ellipsis = if shown.len() < key.len() { "…" } else { "" };
    format!("reacted with {shown}{ellipsis}")
}

fn describe_message(msgtype: &MessageType) -> String {
    let formatted = match msgtype {
        MessageType::Text(content) => content.formatted.as_ref(),
        MessageType::Notice(content) => content.formatted.as_ref(),
        MessageType::Emote(content) => content.formatted.as_ref(),
        _ => None,
    }
    .filter(|formatted| formatted.format == MessageFormat::Html)
    .map(|formatted| formatted.body.as_str());
    match msgtype {
        MessageType::Image(_) => "sent an image".to_owned(),
        MessageType::Video(_) => "sent a video".to_owned(),
        MessageType::Audio(_) => "sent an audio file".to_owned(),
        MessageType::File(_) => "sent a file".to_owned(),
        MessageType::Gallery(_) => "sent a gallery".to_owned(),
        MessageType::VerificationRequest(_) => "requested verification".to_owned(),
        _ => crate::matrix_html::preview_body(msgtype.body(), formatted),
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::events::{AnySyncTimelineEvent, room::message::RoomMessageEventContent};
    use matrix_sdk::ruma::serde::Raw;
    use serde_json::json;

    use super::{MAX_REACTION_BYTES, describe, describe_message, describe_reaction};

    fn message(content: serde_json::Value) -> RoomMessageEventContent {
        serde_json::from_value(content).expect("a valid message content")
    }

    fn event(event_type: &str, content: &serde_json::Value) -> AnySyncTimelineEvent {
        let mut event = json!({
            "type": event_type,
            "event_id": "$event:example.org",
            "sender": "@alice:example.org",
            "origin_server_ts": 1,
            "content": content,
        });
        if event_type == "m.room.member" {
            event["state_key"] = json!("@alice:example.org");
        }
        Raw::<AnySyncTimelineEvent>::from_json_string(event.to_string())
            .expect("valid JSON")
            .deserialize()
            .expect("a valid timeline event")
    }

    #[test]
    fn rich_text_notifications_use_formatted_text() {
        for msgtype in ["m.text", "m.notice", "m.emote"] {
            let content = json!({
                "msgtype": msgtype,
                "body": "<a data-mention-type=\"user\" href=\"https://matrix.to/#/@alice:example.org\" contenteditable=\"false\">Alice</a> hi &amp; welcome",
                "format": "org.matrix.custom.html",
                "formatted_body": "<a href=\"https://matrix.to/#/@alice:example.org\">Alice</a> hi &amp; welcome"
            });
            assert_eq!(
                describe(&event("m.room.message", &content)),
                "Alice hi & welcome"
            );
        }
    }

    #[test]
    fn notification_previews_keep_literal_plain_text() {
        for format in [None, Some("org.example.other")] {
            let mut content = json!({
                "msgtype": "m.text", "body": "<b>literal</b> &amp; text",
                "formatted_body": "<b>formatted</b>"
            });
            if let Some(format) = format {
                content["format"] = json!(format);
            }
            assert_eq!(
                describe_message(&message(content).msgtype),
                "<b>literal</b> &amp; text"
            );
        }
    }

    #[test]
    fn message_types_have_consistent_previews() {
        for (content, expected) in [
            (json!({"msgtype": "m.text", "body": "hello"}), "hello"),
            (json!({"msgtype": "m.emote", "body": "waves"}), "waves"),
            (json!({"msgtype": "m.notice", "body": "notice"}), "notice"),
            (
                json!({"msgtype": "m.server_notice", "body": "server", "server_notice_type": "com.example.notice"}),
                "server",
            ),
            (
                json!({"msgtype": "m.location", "body": "there", "geo_uri": "geo:1,2"}),
                "there",
            ),
            (
                json!({"msgtype": "m.key.verification.request", "body": "verify", "methods": ["m.sas.v1"], "from_device": "DEVICE", "to": "@alice:example.org"}),
                "requested verification",
            ),
            (
                json!({"msgtype": "com.example.message", "body": "custom"}),
                "custom",
            ),
            (
                json!({"msgtype": "m.image", "body": "cat.png", "url": "mxc://example.org/cat"}),
                "sent an image",
            ),
            (
                json!({"msgtype": "m.video", "body": "cat.mp4", "url": "mxc://example.org/cat"}),
                "sent a video",
            ),
            (
                json!({"msgtype": "m.audio", "body": "cat.ogg", "url": "mxc://example.org/cat"}),
                "sent an audio file",
            ),
            (
                json!({"msgtype": "m.file", "body": "cat.txt", "url": "mxc://example.org/cat"}),
                "sent a file",
            ),
            (
                json!({"msgtype": "dm.filament.gallery", "body": "cats", "itemtypes": [{"itemtype": "m.image", "body": "cat.png", "url": "mxc://example.org/cat"}]}),
                "sent a gallery",
            ),
        ] {
            assert_eq!(describe_message(&message(content).msgtype), expected);
        }
    }

    #[test]
    fn a_reaction_preview_hides_media_urls_and_shortens_long_text() {
        assert_eq!(
            describe_reaction("mxc://example.org/cat"),
            "reacted with a custom emote"
        );
        let long = "a".repeat(1000);
        assert_eq!(
            describe_reaction(&long),
            format!("reacted with {}…", "a".repeat(MAX_REACTION_BYTES))
        );
    }

    #[test]
    fn timeline_events_have_consistent_previews() {
        for (event_type, content, expected) in [
            (
                "m.room.encrypted",
                json!({"algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "x", "sender_key": "k", "device_id": "D", "session_id": "s"}),
                "sent an encrypted message",
            ),
            (
                "m.sticker",
                json!({"body": "wave", "url": "mxc://example.org/sticker", "info": {"w": 1, "h": 1, "mimetype": "image/png", "size": 1}}),
                "sent a sticker",
            ),
            (
                "m.reaction",
                json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": "$other:example.org", "key": "👍"}}),
                "reacted with 👍",
            ),
            (
                "org.matrix.msc3381.poll.start",
                json!({"org.matrix.msc3381.poll.start": {"question": {"org.matrix.msc1767.text": "Lunch?"}, "answers": [{"id": "yes", "org.matrix.msc1767.text": "Yes"}]}}),
                "Lunch?",
            ),
            (
                "m.room.member",
                json!({"membership": "knock", "displayname": "Alice"}),
                "requested to join",
            ),
            (
                "m.room.member",
                json!({"membership": "join"}),
                "joined the room",
            ),
            (
                "m.call.invite",
                json!({"call_id": "call", "lifetime": 60_000, "version": 0, "offer": {"type": "offer", "sdp": "v=0"}}),
                "started a call",
            ),
        ] {
            assert_eq!(describe(&event(event_type, &content)), expected);
        }
    }
}
