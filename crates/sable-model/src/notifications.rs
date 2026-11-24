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

const RING_EVENT_TYPES: [&str; 3] = [
    "m.rtc.invite",
    "m.rtc.notification",
    "org.matrix.msc4075.rtc.notification",
];
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

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct DeviceActivity {
    pub devices: std::collections::BTreeMap<String, DeviceActivityEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct DeviceActivityEntry {
    pub active: bool,
    pub at: u64,
}

const DEVICE_ACTIVITY_FRESH_MS: u64 = 3 * 60_000;
const DEVICE_ACTIVITY_CLOCK_SKEW_MS: u64 = 60_000;

#[must_use]
pub fn active_elsewhere(content: &DeviceActivity, own_device_id: &str, now_ms: u64) -> bool {
    content.devices.iter().any(|(device_id, entry)| {
        device_id != own_device_id
            && entry.active
            && entry.at <= now_ms.saturating_add(DEVICE_ACTIVITY_CLOCK_SKEW_MS)
            && now_ms.saturating_sub(entry.at) < DEVICE_ACTIVITY_FRESH_MS
    })
}

#[must_use]
pub fn active_elsewhere_json(content: &str, own_device_id: &str, now_ms: u64) -> bool {
    serde_json::from_str::<DeviceActivity>(content)
        .is_ok_and(|content| active_elsewhere(&content, own_device_id, now_ms))
}

#[cfg(test)]
#[path = "notifications_tests.rs"]
mod tests;
