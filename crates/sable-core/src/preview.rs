use matrix_sdk::ruma::events::room::message::MessageType;
use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, AnySyncTimelineEvent};

const FALLBACK: &str = "sent a message";

pub(crate) fn describe(event: &AnySyncTimelineEvent) -> String {
    let AnySyncTimelineEvent::MessageLike(message) = event else {
        return FALLBACK.to_owned();
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
            |event| format!("reacted with {}", event.content.relates_to.key),
        ),
        AnySyncMessageLikeEvent::UnstablePollStart(poll) => poll.as_original().map_or_else(
            || FALLBACK.to_owned(),
            |event| event.content.poll_start().question.text.clone(),
        ),
        AnySyncMessageLikeEvent::CallInvite(_) => "started a call".to_owned(),
        _ => FALLBACK.to_owned(),
    }
}

fn describe_message(msgtype: &MessageType) -> String {
    match msgtype {
        MessageType::Image(_) => "sent an image".to_owned(),
        MessageType::Video(_) => "sent a video".to_owned(),
        MessageType::Audio(_) => "sent an audio file".to_owned(),
        MessageType::File(_) => "sent a file".to_owned(),
        MessageType::Gallery(_) => "sent a gallery".to_owned(),
        MessageType::VerificationRequest(_) => "requested verification".to_owned(),
        _ => msgtype.body().to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::events::{AnySyncTimelineEvent, room::message::RoomMessageEventContent};
    use matrix_sdk::ruma::serde::Raw;
    use serde_json::json;

    use super::{describe, describe_message};

    fn message(content: serde_json::Value) -> RoomMessageEventContent {
        serde_json::from_value(content).expect("a valid message content")
    }

    fn event(event_type: &str, content: &serde_json::Value) -> AnySyncTimelineEvent {
        Raw::<AnySyncTimelineEvent>::from_json_string(
            json!({
                "type": event_type,
                "event_id": "$event:example.org",
                "sender": "@alice:example.org",
                "origin_server_ts": 1,
                "content": content,
            })
            .to_string(),
        )
        .expect("valid JSON")
        .deserialize()
        .expect("a valid timeline event")
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
                "m.call.invite",
                json!({"call_id": "call", "lifetime": 60_000, "version": 0, "offer": {"type": "offer", "sdp": "v=0"}}),
                "started a call",
            ),
        ] {
            assert_eq!(describe(&event(event_type, &content)), expected);
        }
    }
}
