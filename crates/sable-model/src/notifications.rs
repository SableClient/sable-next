use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use serde_with::{DefaultOnError, DeserializeAs, VecSkipError, serde_as};

use crate::text::{trim, visible_name};

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

/// A string that is not blank, kept as received; anything else reads as nothing.
struct NonBlankText;

impl<'de> DeserializeAs<'de, Option<String>> for NonBlankText {
    fn deserialize_as<D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
        Ok(match Value::deserialize(deserializer)? {
            Value::String(text) if !trim(&text).is_empty() => Some(text),
            _ => None,
        })
    }
}

/// A user id, trimmed; anything blank or not a string reads as nothing.
struct Recipient;

impl<'de> DeserializeAs<'de, Option<String>> for Recipient {
    fn deserialize_as<D: Deserializer<'de>>(deserializer: D) -> Result<Option<String>, D::Error> {
        Ok(match Value::deserialize(deserializer)? {
            Value::String(user) => Some(trim(&user).to_owned()).filter(|user| !user.is_empty()),
            _ => None,
        })
    }
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

#[serde_as]
#[derive(Default, Deserialize)]
struct ContentIn {
    #[serde_as(as = "NonBlankText")]
    #[serde(default)]
    body: Option<String>,
    #[serde_as(as = "NonBlankText")]
    #[serde(default)]
    format: Option<String>,
    #[serde_as(as = "NonBlankText")]
    #[serde(default)]
    formatted_body: Option<String>,
    #[serde_as(as = "NonBlankText")]
    #[serde(default)]
    membership: Option<String>,
    #[serde_as(as = "NonBlankText")]
    #[serde(default)]
    notification_type: Option<String>,
}

impl From<ContentIn> for PushContent {
    fn from(content: ContentIn) -> Self {
        Self {
            body: content.body.map(|body| {
                let formatted = content
                    .formatted_body
                    .as_deref()
                    .filter(|_| content.format.as_deref() == Some("org.matrix.custom.html"));
                crate::html::preview_body(&body, formatted)
            }),
            membership: content.membership,
            notification_type: content.notification_type,
        }
    }
}

#[must_use]
pub fn push_content(value: &Value) -> PushContent {
    ContentIn::deserialize(value).unwrap_or_default().into()
}

#[serde_as]
#[derive(Default, Deserialize)]
struct Envelope {
    #[serde_as(as = "Recipient")]
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default, deserialize_with = "crate::field::present")]
    notification: Option<Value>,
}

#[serde_as]
#[derive(Default, Deserialize)]
struct DefaultPayload {
    #[serde_as(as = "Recipient")]
    #[serde(default)]
    user_id: Option<String>,
}

#[serde_as]
#[derive(Default, Deserialize)]
struct DeviceData {
    #[serde_as(as = "Recipient")]
    #[serde(default)]
    user_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    default_payload: Option<DefaultPayload>,
}

#[serde_as]
#[derive(Deserialize)]
struct Device {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    tweaks: Option<Map<String, Value>>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    data: Option<DeviceData>,
}

#[derive(Default, Deserialize)]
struct Counts {
    unread: Option<Value>,
}

#[serde_as]
#[derive(Deserialize)]
struct NotificationIn {
    #[serde_as(as = "NonBlankText")]
    #[serde(default)]
    sender: Option<String>,
    #[serde_as(as = "Recipient")]
    #[serde(default)]
    user_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    devices: Vec<Device>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    counts: Option<Counts>,
    unread: Option<Value>,
    #[serde_as(as = "NonBlankText")]
    #[serde(default)]
    room_id: Option<String>,
    #[serde_as(as = "NonBlankText")]
    #[serde(default)]
    event_id: Option<String>,
    #[serde_as(as = "NonBlankText")]
    #[serde(default)]
    room_name: Option<String>,
    #[serde_as(as = "NonBlankText")]
    #[serde(default)]
    sender_display_name: Option<String>,
    #[serde_as(as = "NonBlankText")]
    #[serde(default, rename = "type")]
    event_type: Option<String>,
    #[serde_as(as = "NonBlankText")]
    #[serde(default)]
    membership: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    content: Option<ContentIn>,
}

fn add_recipient(recipients: &mut Vec<String>, recipient: Option<String>) {
    if let Some(recipient) = recipient
        && !recipients.contains(&recipient)
    {
        recipients.push(recipient);
    }
}

/// A gateway sends the notification flat, wrapped, or wrapped as a JSON string;
/// one that names two recipients is refused rather than guessed at.
#[must_use]
pub fn parse_push_payload(raw: &str) -> Option<PushNotification> {
    let envelope: Value = serde_json::from_str(raw).ok()?;
    if !envelope.is_object() {
        return None;
    }
    let outer = Envelope::deserialize(&envelope).ok()?;
    let notification = match outer.notification {
        Some(Value::String(inner)) => serde_json::from_str(&inner).ok()?,
        Some(notification) => notification,
        None => envelope,
    };
    if !notification.is_object() {
        return None;
    }
    let notification = NotificationIn::deserialize(&notification).ok()?;

    let mut recipients = Vec::new();
    let mut noisy = false;
    add_recipient(&mut recipients, outer.user_id);
    add_recipient(&mut recipients, notification.user_id);
    for device in notification.devices {
        if let Some(tweaks) = device.tweaks {
            noisy |=
                tweaks.contains_key("sound") || tweaks.get("highlight") == Some(&Value::Bool(true));
        }
        let Some(data) = device.data else {
            continue;
        };
        add_recipient(&mut recipients, data.user_id);
        add_recipient(
            &mut recipients,
            data.default_payload.and_then(|payload| payload.user_id),
        );
    }
    if recipients.len() > 1 {
        return None;
    }

    let unread = notification
        .counts
        .and_then(|counts| counts.unread)
        .or(notification.unread)
        .as_ref()
        .and_then(count);
    if notification.room_id.is_none() && unread.is_none() {
        return None;
    }
    Some(PushNotification {
        user_id: recipients.pop(),
        room_id: notification.room_id,
        event_id: notification.event_id,
        room_name: notification.room_name,
        sender_display_name: notification
            .sender_display_name
            .and_then(visible_name)
            .or(notification.sender),
        event_type: notification.event_type,
        membership: notification.membership,
        content: notification.content.unwrap_or_default().into(),
        unread,
        icon: None,
        decrypted: false,
        noisy,
    })
}

/// The MSC4174 validation handshake, exclusive of a real notification.
#[must_use]
pub fn web_push_validation(raw: &str) -> Option<WebPushValidation> {
    #[serde_as]
    #[derive(Deserialize)]
    struct Handshake {
        #[serde_as(as = "NonBlankText")]
        #[serde(default)]
        app_id: Option<String>,
        #[serde_as(as = "NonBlankText")]
        #[serde(default)]
        ack_token: Option<String>,
        #[serde(flatten)]
        rest: Map<String, Value>,
    }
    let payload: Handshake = serde_json::from_str(raw).ok()?;
    let notifies = ["notification", "room_id", "event_id", "type"]
        .iter()
        .any(|key| payload.rest.contains_key(*key))
        || payload.rest.get("unread").is_some_and(Value::is_number);
    let (app_id, ack_token) = (payload.app_id?, payload.ack_token?);
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

#[derive(Debug, Default, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct OwnPresence {
    #[serde(default)]
    pub presence: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub last_active_ago: Option<u64>,
}

/// Outlasts an open client's presence refresh; bounds how long a client that
/// crashed while online keeps alerts quiet.
const ELSEWHERE_FRESH_MS: u64 = 3 * 60_000;
/// Presence is per account, so the latest report may be this device's own.
/// Clients record their own use at least this often.
const OWN_REPORT_MARGIN_MS: u64 = 60_000;

#[must_use]
pub fn active_elsewhere(presence: &OwnPresence, inactive_here_ms: Option<u64>) -> bool {
    presence.presence == "online"
        && presence.last_active_ago.is_some_and(|ago| {
            ago < ELSEWHERE_FRESH_MS
                && inactive_here_ms.is_none_or(|here| ago + OWN_REPORT_MARGIN_MS < here)
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
    fn hidden_push_names_use_the_sender() {
        for name in ["", "   ", "\u{200b}\u{2800}\u{feff}"] {
            let push = parsed(&json!({
                "room_id": "!r:x", "sender": "@alice:x", "sender_display_name": name,
            }));
            assert_eq!(push.sender_display_name.as_deref(), Some("@alice:x"));
        }
    }

    #[test]
    fn rich_text_pushes_use_formatted_text() {
        let content = json!({
            "msgtype": "m.text",
            "body": "<a data-mention-type=\"user\" href=\"https://matrix.to/#/@alice:example.org\" contenteditable=\"false\">Alice</a> hi &amp; welcome",
            "format": "org.matrix.custom.html",
            "formatted_body": "<a href=\"https://matrix.to/#/@alice:example.org\">Alice</a> hi &amp; welcome"
        });
        assert_eq!(
            push_content(&content).body.as_deref(),
            Some("Alice hi & welcome")
        );
        let push = parsed(&json!({
            "room_id": "!r:x", "event_id": "$e", "sender_display_name": "Bob",
            "type": "m.room.message", "content": content
        }));
        let shown = alert(&push, None, true).expect("an alert");
        assert_eq!(shown.body, "Bob: Alice hi & welcome");
        assert_eq!(shown.line.body, "Alice hi & welcome");
    }

    #[test]
    fn push_previews_keep_literal_plain_text() {
        for format in [json!(null), json!("org.example.other"), json!(5)] {
            assert_eq!(
                push_content(&json!({
                    "body": "<b>literal</b> &amp; text", "format": format,
                    "formatted_body": "<b>formatted</b>"
                }))
                .body
                .as_deref(),
                Some("<b>literal</b> &amp; text")
            );
        }
    }

    #[test]
    fn push_previews_hide_spoilers_and_reply_fallbacks() {
        let content = push_content(&json!({
            "body": "quoted secret",
            "format": "org.matrix.custom.html",
            "formatted_body": "<mx-reply><blockquote>quoted</blockquote></mx-reply>look <span data-mx-spoiler>secret</span>"
        }));
        assert_eq!(content.body.as_deref(), Some("look [Spoiler]"));
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

    #[test]
    fn wrong_typed_parts_of_a_push_are_skipped() {
        let push = parsed(&json!({
            "user_id": 4,
            "notification": {
                "room_id": "!r:x", "event_id": 3, "room_name": "  ",
                "devices": ["junk", {"tweaks": "loud", "data": 1}, {"tweaks": {"sound": null}}],
                "counts": "many", "unread": 2.0, "content": "text"
            }
        }));
        assert_eq!(push.room_id.as_deref(), Some("!r:x"));
        assert_eq!(push.event_id, None);
        assert_eq!(push.room_name, None);
        assert!(push.noisy);
        assert_eq!(push.unread, Some(2));
        assert_eq!(push.content, PushContent::default());
        assert_eq!(push.user_id, None);
    }

    #[test]
    fn a_handshake_with_wrong_typed_credentials_is_not_one() {
        assert!(web_push_validation(r#"{"app_id": 1, "ack_token": "t"}"#).is_none());
        assert!(web_push_validation(r#"{"app_id": "a", "ack_token": "t", "unread": 1}"#).is_none());
        assert_eq!(
            web_push_validation(r#"{"app_id": "a", "ack_token": "t", "unread": "1"}"#),
            Some(WebPushValidation {
                app_id: "a".to_owned(),
                ack_token: "t".to_owned()
            })
        );
    }

    #[test]
    fn devices_that_are_not_a_list_are_ignored() {
        let push = parsed(
            &json!({"notification": {"room_id": "!r:x", "devices": {"tweaks": {"sound": 1}}}}),
        );
        assert!(!push.noisy);
    }

    #[test]
    fn text_is_kept_untrimmed_but_a_recipient_is_trimmed() {
        let push = parsed(&json!({"user_id": " @me:x ", "room_id": "!r:x", "room_name": " Den "}));
        assert_eq!(push.room_name.as_deref(), Some(" Den "));
        assert_eq!(push.user_id.as_deref(), Some("@me:x"));
    }

    fn presence(value: &Value) -> OwnPresence {
        serde_json::from_value(value.clone()).expect("a presence response")
    }

    #[test]
    fn a_fresh_online_report_from_another_device_keeps_this_one_quiet() {
        let online = presence(&json!({"presence": "online", "last_active_ago": 20_000}));
        assert!(active_elsewhere(&online, None));
        assert!(active_elsewhere(&online, Some(120_000)));
    }

    #[test]
    fn this_devices_own_last_report_does_not_count() {
        let online = presence(&json!({"presence": "online", "last_active_ago": 20_000}));
        assert!(!active_elsewhere(&online, Some(10_000)));
        assert!(!active_elsewhere(&online, Some(70_000)));
    }

    #[test]
    fn away_stale_or_unknown_presence_alerts() {
        for value in [
            json!({"presence": "unavailable", "last_active_ago": 1_000}),
            json!({"presence": "offline", "last_active_ago": 1_000}),
            json!({"presence": "online", "last_active_ago": 180_000}),
            json!({"presence": "online"}),
            json!({}),
        ] {
            assert!(!active_elsewhere(&presence(&value), None), "{value}");
        }
    }
}
