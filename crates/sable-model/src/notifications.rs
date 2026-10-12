use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::text::trim;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum NotificationModeView {
    All,
    Mentions,
    Mute,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(default)]
pub struct PushContent {
    pub body: Option<String>,
    pub membership: Option<String>,
    pub notification_type: Option<String>,
}

/// With `event_id_only` a push holds a room, an event and counts, and nothing
/// else, so none of this can be relied on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(default)]
pub struct PushNotification {
    pub user_id: Option<String>,
    pub room_id: Option<String>,
    pub event_id: Option<String>,
    pub room_name: Option<String>,
    pub sender_display_name: Option<String>,
    #[serde(rename = "type")]
    pub event_type: Option<String>,
    pub membership: Option<String>,
    pub content: PushContent,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub unread: Option<u64>,
    pub icon: Option<String>,
    pub decrypted: bool,
    pub noisy: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct WebPushValidation {
    pub app_id: String,
    pub ack_token: String,
}

/// Held in a shown notification's data and read back by the next push for the
/// same room, so it keeps the field names notifications already carry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ConversationLine {
    pub sender: Option<String>,
    pub body: String,
    pub event_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PushAlert {
    pub title: String,
    pub body: String,
    pub line: ConversationLine,
    pub tag: String,
    pub room_id: String,
    pub event_id: Option<String>,
    pub ring: bool,
    pub invite: bool,
}

const RING_EVENT_TYPES: [&str; 2] = ["m.rtc.notification", "org.matrix.msc4075.rtc.notification"];
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !trim(text).is_empty())
        .map(str::to_owned)
}

/// `Number.isSafeInteger(n) && n >= 0`, which a JSON `2.0` passes too.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "a whole, non-negative f64 at most 2^53 - 1 converts exactly"
)]
fn count(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| {
            value
                .as_f64()
                .filter(|n| n.fract() == 0.0 && *n >= 0.0)
                .map(|n| n as u64)
        })
        .filter(|n| *n <= MAX_SAFE_INTEGER)
}

#[must_use]
pub fn push_content(value: &Value) -> PushContent {
    PushContent {
        body: text(value.get("body")),
        membership: text(value.get("membership")),
        notification_type: text(value.get("notification_type")),
    }
}

fn add_recipient(recipients: &mut Vec<String>, value: Option<&Value>) {
    let Some(recipient) = value.and_then(Value::as_str).map(trim) else {
        return;
    };
    if !recipient.is_empty() && !recipients.iter().any(|held| held == recipient) {
        recipients.push(recipient.to_owned());
    }
}

/// A gateway sends the notification flat, wrapped, or wrapped as a JSON string;
/// one that names two recipients is refused rather than guessed at.
#[must_use]
pub fn parse_push_payload(raw: &str) -> Option<PushNotification> {
    let envelope: Value = serde_json::from_str(raw).ok()?;
    let envelope = envelope.as_object()?;
    let notification = match envelope.get("notification") {
        Some(Value::String(wrapped)) => serde_json::from_str(wrapped).ok()?,
        Some(notification) => notification.clone(),
        None => Value::Object(envelope.clone()),
    };
    let notification = notification.as_object()?;

    let mut recipients = Vec::new();
    let mut noisy = false;
    add_recipient(&mut recipients, envelope.get("user_id"));
    add_recipient(&mut recipients, notification.get("user_id"));
    let devices = notification.get("devices").and_then(Value::as_array);
    for device in devices.into_iter().flatten().filter_map(Value::as_object) {
        if let Some(tweaks) = device.get("tweaks").and_then(Value::as_object) {
            noisy |=
                tweaks.contains_key("sound") || tweaks.get("highlight") == Some(&Value::Bool(true));
        }
        let Some(data) = device.get("data").and_then(Value::as_object) else {
            continue;
        };
        add_recipient(&mut recipients, data.get("user_id"));
        let default_payload = data.get("default_payload").and_then(Value::as_object);
        add_recipient(
            &mut recipients,
            default_payload.and_then(|payload| payload.get("user_id")),
        );
    }
    if recipients.len() > 1 {
        return None;
    }

    let counted = notification
        .get("counts")
        .and_then(Value::as_object)
        .and_then(|counts| counts.get("unread"))
        .filter(|unread| !unread.is_null())
        .or_else(|| notification.get("unread"));
    let unread = counted.and_then(count);
    let room_id = text(notification.get("room_id"));
    if room_id.is_none() && unread.is_none() {
        return None;
    }
    Some(PushNotification {
        user_id: recipients.pop(),
        room_id,
        event_id: text(notification.get("event_id")),
        room_name: text(notification.get("room_name")),
        sender_display_name: text(notification.get("sender_display_name")),
        event_type: text(notification.get("type")),
        membership: text(notification.get("membership")),
        content: notification
            .get("content")
            .map(push_content)
            .unwrap_or_default(),
        unread,
        icon: None,
        decrypted: false,
        noisy,
    })
}

/// The MSC4174 validation handshake, exclusive of a real notification.
#[must_use]
pub fn web_push_validation(raw: &str) -> Option<WebPushValidation> {
    let payload: Map<String, Value> = serde_json::from_str(raw).ok()?;
    let app_id = text(payload.get("app_id"))?;
    let ack_token = text(payload.get("ack_token"))?;
    let notifies = ["notification", "room_id", "event_id", "type"]
        .iter()
        .any(|key| payload.contains_key(*key))
        || payload.get("unread").is_some_and(Value::is_number);
    (!notifies).then_some(WebPushValidation { app_id, ack_token })
}

#[must_use]
pub fn room_tag(user_id: Option<&str>, room_id: &str) -> String {
    format!("{} {room_id}", user_id.unwrap_or_default())
}

#[must_use]
pub fn rings(notification: &PushNotification) -> bool {
    notification
        .event_type
        .as_deref()
        .is_some_and(|kind| RING_EVENT_TYPES.contains(&kind))
        && notification.content.notification_type.as_deref() == Some("ring")
}

fn invites(notification: &PushNotification) -> bool {
    notification.event_type.as_deref() == Some("m.room.member")
        && notification
            .membership
            .as_ref()
            .or(notification.content.membership.as_ref())
            .is_some_and(|membership| membership == "invite")
}

#[must_use]
pub fn silenced_by_room_mode(
    notification: &PushNotification,
    mode: Option<NotificationModeView>,
) -> bool {
    match mode {
        Some(NotificationModeView::Mute) => true,
        Some(NotificationModeView::Mentions) => {
            notification.event_type.as_deref() == Some("m.room.encrypted")
        }
        _ => false,
    }
}

fn said(notification: &PushNotification, show_content: bool) -> Option<&str> {
    notification
        .content
        .body
        .as_deref()
        .filter(|said| show_content && !said.is_empty())
}

fn body(notification: &PushNotification, sender: Option<&str>, show_content: bool) -> String {
    if invites(notification) {
        return sender.map_or_else(
            || "Invited you".to_owned(),
            |sender| format!("{sender} invited you"),
        );
    }
    if rings(notification) {
        return sender.map_or_else(
            || "Incoming call".to_owned(),
            |sender| format!("{sender} is calling"),
        );
    }
    match (said(notification, show_content), sender) {
        (Some(said), Some(sender)) => format!("{sender}: {said}"),
        (Some(said), None) => said.to_owned(),
        (None, Some(sender)) => format!("New message from {sender}"),
        (None, None) => "New message".to_owned(),
    }
}

fn line(
    notification: &PushNotification,
    sender: Option<&str>,
    show_content: bool,
) -> ConversationLine {
    let event_id = notification.event_id.clone();
    match said(notification, show_content) {
        Some(said) if !invites(notification) && !rings(notification) => ConversationLine {
            sender: sender.map(str::to_owned),
            body: said.to_owned(),
            event_id,
        },
        _ => ConversationLine {
            sender: None,
            body: body(notification, sender, show_content),
            event_id,
        },
    }
}

/// `None` for a push that only carries counts, which is a badge update and not
/// something to put on screen.
#[must_use]
pub fn alert(
    notification: &PushNotification,
    room_name: Option<&str>,
    show_content: bool,
) -> Option<PushAlert> {
    let room_id = notification.room_id.clone()?;
    let sender = notification.sender_display_name.as_deref();
    Some(PushAlert {
        title: notification
            .room_name
            .as_deref()
            .or(room_name)
            .unwrap_or("Sable")
            .to_owned(),
        body: body(notification, sender, show_content),
        line: line(notification, sender, show_content),
        tag: room_tag(notification.user_id.as_deref(), &room_id),
        room_id,
        event_id: notification.event_id.clone(),
        ring: rings(notification),
        invite: invites(notification),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn parsed(raw: &Value) -> PushNotification {
        parse_push_payload(&raw.to_string()).expect("a valid push")
    }

    #[test]
    fn a_counts_only_push_is_a_badge_update() {
        let counts = parsed(&json!({"notification": {"counts": {"unread": 4}}}));
        assert_eq!(counts.unread, Some(4));
        assert_eq!(alert(&counts, None, true), None);
    }

    #[test]
    fn a_flattened_notification_reads_its_top_level_unread() {
        let flat = parsed(&json!({"room_id": "!r:x", "event_id": "$e", "unread": 2}));
        assert_eq!(flat.unread, Some(2));
        let whole = parsed(&json!({"room_id": "!r:x", "unread": 2.0}));
        assert_eq!(whole.unread, Some(2));
        let fraction = parsed(&json!({"room_id": "!r:x", "unread": 2.5}));
        assert_eq!(fraction.unread, None);
    }

    #[test]
    fn every_envelope_keeps_its_recipient() {
        let inner = json!({"room_id": "!r:x", "event_id": "$e"});
        for raw in [
            json!({"room_id": "!r:x", "event_id": "$e", "user_id": "@me:x"}),
            json!({"user_id": "@me:x", "notification": inner}),
            json!({"user_id": "@me:x", "notification": inner.to_string()}),
            json!({"notification": {"room_id": "!r:x", "devices": [{"data": {"default_payload": {"user_id": "@me:x"}}}]}}),
        ] {
            assert_eq!(parsed(&raw).user_id.as_deref(), Some("@me:x"), "{raw}");
        }
    }

    #[test]
    fn malformed_and_conflicting_payloads_are_refused() {
        for raw in ["invalid", "[]", "null", r#"{"notification":null}"#] {
            assert_eq!(parse_push_payload(raw), None, "{raw}");
        }
        let conflicting =
            json!({"user_id": "@a:x", "notification": {"user_id": "@b:x", "room_id": "!r:x"}});
        assert_eq!(parse_push_payload(&conflicting.to_string()), None);
    }

    #[test]
    fn a_sound_or_highlight_tweak_makes_a_push_noisy() {
        let noisy = |tweaks: Value| {
            parsed(&json!({"notification": {"room_id": "!r:x", "devices": [{"pushkey": "k", "tweaks": tweaks}]}}))
                .noisy
        };
        assert!(noisy(json!({"sound": "default"})));
        assert!(noisy(json!({"highlight": true})));
        assert!(!noisy(json!({"highlight": false})));
        assert!(!noisy(json!({})));
    }

    #[test]
    fn the_validation_handshake_is_not_a_notification() {
        let handshake = json!({"app_id": "moe.sable.webpush", "ack_token": "tok"}).to_string();
        assert_eq!(parse_push_payload(&handshake), None);
        assert_eq!(
            web_push_validation(&handshake),
            Some(WebPushValidation {
                app_id: "moe.sable.webpush".to_owned(),
                ack_token: "tok".to_owned()
            })
        );
        for raw in [
            json!({"app_id": "a", "ack_token": "tok", "room_id": "!r:x"}),
            json!({"app_id": "a", "ack_token": "tok", "unread": 0}),
            json!({"app_id": "", "ack_token": "tok"}),
            json!({"app_id": "a"}),
        ] {
            assert_eq!(web_push_validation(&raw.to_string()), None, "{raw}");
        }
        assert_eq!(web_push_validation("not json"), None);
    }

    #[test]
    fn an_invitation_without_content_still_reads_as_one() {
        let invite = parsed(&json!({"notification": {
            "room_id": "!r:x", "type": "m.room.member", "membership": "invite",
            "sender_display_name": "Ada", "user_id": "@me:x"
        }}));
        let shown = alert(&invite, Some("Crew"), true).expect("an alert");
        assert_eq!(shown.body, "Ada invited you");
        assert!(shown.invite);
    }

    #[test]
    fn a_ring_reads_as_a_call() {
        let ring = PushNotification {
            room_id: Some("!r:x".to_owned()),
            event_type: Some("org.matrix.msc4075.rtc.notification".to_owned()),
            sender_display_name: Some("Ada".to_owned()),
            content: PushContent {
                body: Some("ignored".to_owned()),
                notification_type: Some("ring".to_owned()),
                ..PushContent::default()
            },
            ..PushNotification::default()
        };
        let shown = alert(&ring, None, true).expect("an alert");
        assert_eq!(shown.body, "Ada is calling");
        assert_eq!(shown.line.body, "Ada is calling");
        assert_eq!(shown.line.sender, None);
        assert!(shown.ring);
    }

    #[test]
    fn content_stays_out_when_previews_are_off() {
        let message = PushNotification {
            room_id: Some("!r:x".to_owned()),
            sender_display_name: Some("Ada".to_owned()),
            content: PushContent {
                body: Some("the merger".to_owned()),
                ..PushContent::default()
            },
            ..PushNotification::default()
        };
        assert_eq!(
            alert(&message, None, false).expect("an alert").body,
            "New message from Ada"
        );
        let shown = alert(&message, None, true).expect("an alert");
        assert_eq!(shown.body, "Ada: the merger");
        assert_eq!(shown.line.sender.as_deref(), Some("Ada"));
        assert_eq!(shown.title, "Sable");
    }

    #[test]
    fn an_encrypted_push_is_silenced_where_only_mentions_count() {
        let encrypted = PushNotification {
            event_type: Some("m.room.encrypted".to_owned()),
            ..PushNotification::default()
        };
        assert!(silenced_by_room_mode(
            &encrypted,
            Some(NotificationModeView::Mentions)
        ));
        assert!(!silenced_by_room_mode(
            &encrypted,
            Some(NotificationModeView::All)
        ));
        assert!(!silenced_by_room_mode(&encrypted, None));
        assert!(silenced_by_room_mode(
            &PushNotification::default(),
            Some(NotificationModeView::Mute)
        ));
    }

    #[test]
    fn a_conversation_line_keeps_its_stored_field_names() {
        let line = ConversationLine {
            sender: None,
            body: "hi".to_owned(),
            event_id: Some("$e".to_owned()),
        };
        assert_eq!(
            serde_json::to_value(&line).expect("serializes"),
            json!({"sender": null, "body": "hi", "eventId": "$e"})
        );
    }
}
