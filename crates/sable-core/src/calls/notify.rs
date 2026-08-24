use matrix_sdk::ruma::events::macros::EventContent;
use matrix_sdk::ruma::{EventId, MilliSecondsSinceUnixEpoch, OwnedEventId, UserId};
use serde::{Deserialize, Serialize};

pub(crate) const NOTIFICATION_EVENT_TYPE: &str = "org.matrix.msc4075.rtc.notification";
pub(crate) const DECLINE_EVENT_TYPE: &str = "org.matrix.msc4310.rtc.decline";
const REFERENCE_REL_TYPE: &str = "m.reference";

pub(crate) const NOTIFICATION_LIFETIME_MS: u64 = 30_000;
const MAX_NOTIFICATION_LIFETIME_MS: u64 = 120_000;
const SENDER_CLOCK_TOLERANCE_MS: u64 = 20_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NotificationKind {
    Ring,
    Notification,
}

impl NotificationKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Ring => "ring",
            Self::Notification => "notification",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "ring" => Some(Self::Ring),
            "notification" => Some(Self::Notification),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(crate) struct Mentions {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) room: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) user_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Reference {
    pub(crate) rel_type: String,
    pub(crate) event_id: OwnedEventId,
}

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "org.matrix.msc4075.rtc.notification", kind = MessageLike)]
pub(crate) struct RtcNotificationEventContent {
    #[serde(rename = "m.mentions", default)]
    pub(crate) mentions: Mentions,
    pub(crate) notification_type: String,
    #[serde(rename = "m.relates_to")]
    pub(crate) relates_to: Reference,
    pub(crate) sender_ts: u64,
    #[serde(default = "default_lifetime")]
    pub(crate) lifetime: u64,
    #[serde(rename = "m.text", default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) text: Vec<TextBlock>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct TextBlock {
    pub(crate) body: String,
}

const fn default_lifetime() -> u64 {
    NOTIFICATION_LIFETIME_MS
}

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "org.matrix.msc4310.rtc.decline", kind = MessageLike)]
pub(crate) struct RtcDeclineEventContent {
    #[serde(rename = "m.relates_to")]
    pub(crate) relates_to: Reference,
}

pub(crate) fn notification_content(
    membership_event_id: &EventId,
    kind: NotificationKind,
) -> RtcNotificationEventContent {
    RtcNotificationEventContent {
        mentions: Mentions {
            room: true,
            user_ids: Vec::new(),
        },
        notification_type: kind.as_str().to_owned(),
        relates_to: Reference {
            rel_type: REFERENCE_REL_TYPE.to_owned(),
            event_id: membership_event_id.to_owned(),
        },
        sender_ts: MilliSecondsSinceUnixEpoch::now().get().into(),
        lifetime: NOTIFICATION_LIFETIME_MS,
        text: vec![TextBlock {
            body: "Call started".to_owned(),
        }],
    }
}

pub(crate) fn decline_content(notification_event_id: &EventId) -> RtcDeclineEventContent {
    RtcDeclineEventContent {
        relates_to: Reference {
            rel_type: REFERENCE_REL_TYPE.to_owned(),
            event_id: notification_event_id.to_owned(),
        },
    }
}

pub(crate) struct Incoming {
    pub(crate) kind: NotificationKind,
    pub(crate) expires_at: u64,
}

pub(crate) fn accept(
    content: &RtcNotificationEventContent,
    sender: &UserId,
    own_user_id: &UserId,
    origin_server_ts: u64,
    now_ms: u64,
) -> Option<Incoming> {
    if sender == own_user_id {
        return None;
    }
    if content.relates_to.rel_type != REFERENCE_REL_TYPE {
        return None;
    }
    if !mentions_us(&content.mentions, own_user_id) {
        return None;
    }

    let kind = NotificationKind::parse(&content.notification_type)?;
    let sender_ts = if content.sender_ts.abs_diff(origin_server_ts) > SENDER_CLOCK_TOLERANCE_MS {
        origin_server_ts
    } else {
        content.sender_ts
    };
    let expires_at = sender_ts.saturating_add(content.lifetime.min(MAX_NOTIFICATION_LIFETIME_MS));

    (now_ms < expires_at).then_some(Incoming { kind, expires_at })
}

fn mentions_us(mentions: &Mentions, own_user_id: &UserId) -> bool {
    mentions.room
        || mentions
            .user_ids
            .iter()
            .any(|id| id == own_user_id.as_str())
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{event_id, user_id};

    use super::{Mentions, NotificationKind, Reference, accept, notification_content};

    fn content(sender_ts: u64, lifetime: u64) -> super::RtcNotificationEventContent {
        super::RtcNotificationEventContent {
            mentions: Mentions {
                room: true,
                user_ids: Vec::new(),
            },
            notification_type: "ring".to_owned(),
            relates_to: Reference {
                rel_type: "m.reference".to_owned(),
                event_id: event_id!("$membership").to_owned(),
            },
            sender_ts,
            lifetime,
            text: Vec::new(),
        }
    }

    #[test]
    fn test_our_own_notification_never_rings_us() {
        let us = user_id!("@erwan:localhost");

        assert!(accept(&content(1_000, 30_000), us, us, 1_000, 1_100).is_none());
    }

    #[test]
    fn test_a_notification_mentioning_nobody_is_ignored() {
        let mut content = content(1_000, 30_000);
        content.mentions = Mentions::default();

        assert!(
            accept(
                &content,
                user_id!("@bob:localhost"),
                user_id!("@erwan:localhost"),
                1_000,
                1_100
            )
            .is_none()
        );
    }

    #[test]
    fn test_a_named_mention_rings_only_the_named_user() {
        let mut content = content(1_000, 30_000);
        content.mentions = Mentions {
            room: false,
            user_ids: vec!["@erwan:localhost".to_owned()],
        };
        let sender = user_id!("@bob:localhost");

        assert!(accept(&content, sender, user_id!("@erwan:localhost"), 1_000, 1_100).is_some());
        assert!(accept(&content, sender, user_id!("@carol:localhost"), 1_000, 1_100).is_none());
    }

    #[test]
    fn test_an_expired_notification_does_not_ring() {
        assert!(
            accept(
                &content(1_000, 30_000),
                user_id!("@bob:localhost"),
                user_id!("@erwan:localhost"),
                1_000,
                40_000
            )
            .is_none()
        );
    }

    #[test]
    fn test_a_sender_clock_running_fast_cannot_extend_the_expiry() {
        let incoming = accept(
            &content(10_000_000, 30_000),
            user_id!("@bob:localhost"),
            user_id!("@erwan:localhost"),
            1_000,
            1_100,
        )
        .expect("the notification is still live against the server's own stamp");

        assert_eq!(
            incoming.expires_at, 31_000,
            "origin_server_ts must win over a sender_ts far in the future"
        );
    }

    #[test]
    fn test_a_sender_clock_running_slow_falls_back_to_the_server_stamp() {
        let incoming = accept(
            &content(1_000, 30_000),
            user_id!("@bob:localhost"),
            user_id!("@erwan:localhost"),
            10_000_000,
            10_000_100,
        )
        .expect("a sender whose clock is behind must still ring");

        assert_eq!(
            incoming.expires_at, 10_030_000,
            "MSC4075 takes the absolute difference, so a slow clock falls back too"
        );
    }

    #[test]
    fn test_a_notification_without_a_lifetime_is_still_accepted() {
        let json = serde_json::json!({
            "notification_type": "notification",
            "m.mentions": { "room": true },
            "m.relates_to": { "rel_type": "m.reference", "event_id": "$membership" },
            "sender_ts": 1_000,
        });
        let content: super::RtcNotificationEventContent =
            serde_json::from_value(json).expect("lifetime is only required for a ring");

        assert!(
            accept(
                &content,
                user_id!("@bob:localhost"),
                user_id!("@erwan:localhost"),
                1_000,
                1_100
            )
            .is_some()
        );
    }

    #[test]
    fn test_a_lifetime_beyond_the_cap_is_clamped() {
        let incoming = accept(
            &content(1_000, 10_000_000),
            user_id!("@bob:localhost"),
            user_id!("@erwan:localhost"),
            1_000,
            1_100,
        )
        .expect("a long-lived notification is still valid, just clamped");

        assert_eq!(incoming.expires_at, 121_000);
    }

    #[test]
    fn test_a_ring_is_written_as_a_reference_to_the_membership() {
        let content = notification_content(event_id!("$membership"), NotificationKind::Ring);

        assert_eq!(content.notification_type, "ring");
        assert_eq!(content.relates_to.rel_type, "m.reference");
        assert_eq!(content.relates_to.event_id, event_id!("$membership"));
        assert!(content.mentions.room);
    }
}
