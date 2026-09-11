use std::collections::HashMap;
use std::time::Duration;

use matrix_sdk::ruma::events::rtc::notification::NotificationType;
pub(crate) use matrix_sdk::ruma::events::rtc::notification::RtcNotificationEventContent;
use matrix_sdk::ruma::events::{Mentions, relation::Reference};
use matrix_sdk::ruma::{
    EventId, MilliSecondsSinceUnixEpoch, OwnedEventId, OwnedRoomId, RoomId, UserId,
};

pub(crate) const NOTIFICATION_EVENT_TYPE: &str = "org.matrix.msc4075.rtc.notification";
const DECLINE_EVENT_TYPE: &str = "org.matrix.msc4310.rtc.decline";
pub(crate) const NOTIFICATION_LIFETIME_MS: u64 = 30_000;
const MAX_NOTIFICATION_LIFETIME_MS: u64 = 120_000;
const ANNOUNCEMENT_FALLBACK_TEXT: &str = "Call started";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NotificationKind {
    Ring,
    Notification,
}

pub(crate) fn notification_content(
    membership_event_id: &EventId,
    kind: NotificationKind,
) -> RtcNotificationEventContent {
    let mut content = RtcNotificationEventContent::new(
        MilliSecondsSinceUnixEpoch::now(),
        Duration::from_millis(NOTIFICATION_LIFETIME_MS),
        match kind {
            NotificationKind::Ring => NotificationType::Ring,
            NotificationKind::Notification => NotificationType::Notification,
        },
    );
    content.mentions = Some(Mentions::with_room_mention());
    content.relates_to = Some(Reference::new(membership_event_id.to_owned()));
    content
}

pub(crate) fn announcement(
    membership_event_id: &EventId,
    kind: NotificationKind,
) -> Option<matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::AnyMessageLikeEventContent>> {
    let mut content = serde_json::to_value(notification_content(membership_event_id, kind)).ok()?;
    content.as_object_mut()?.insert(
        "m.text".to_owned(),
        serde_json::json!([{ "body": ANNOUNCEMENT_FALLBACK_TEXT }]),
    );
    matrix_sdk::ruma::serde::Raw::new(&content)
        .ok()
        .map(matrix_sdk::ruma::serde::Raw::cast_unchecked)
}

pub(super) fn is_call_event_type(
    raw: &matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::AnySyncMessageLikeEvent>,
) -> bool {
    matches!(
        raw.get_field::<String>("type").ok().flatten().as_deref(),
        Some("m.rtc.notification" | NOTIFICATION_EVENT_TYPE | "m.rtc.decline" | DECLINE_EVENT_TYPE)
    )
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
    let mentions = content.mentions.as_ref()?;
    if !mentions.room && !mentions.user_ids.contains(own_user_id) {
        return None;
    }
    let kind = match content.notification_type {
        NotificationType::Ring => NotificationKind::Ring,
        NotificationType::Notification => NotificationKind::Notification,
        _ => return None,
    };
    let mut content = content.clone();
    content.lifetime = content
        .lifetime
        .min(Duration::from_millis(MAX_NOTIFICATION_LIFETIME_MS));
    let origin_server_ts = MilliSecondsSinceUnixEpoch(origin_server_ts.try_into().ok()?);
    let expires_at = content.expiration_ts(origin_server_ts, None).get().into();
    (now_ms < expires_at).then_some(Incoming { kind, expires_at })
}

pub(super) async fn make_decline_event(
    room: &matrix_sdk::Room,
    event_id: &EventId,
) -> Result<
    matrix_sdk::ruma::events::rtc::decline::RtcDeclineEventContent,
    matrix_sdk::room::calls::CallError,
> {
    use matrix_sdk::room::calls::CallError;
    use matrix_sdk::ruma::events::rtc::decline::RtcDeclineEventContent;
    use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, SyncMessageLikeEvent};

    match room.make_decline_call_event(event_id).await {
        Ok(content) => Ok(content),
        Err(error @ CallError::Deserialize(_)) => {
            let target = room
                .load_or_fetch_event(event_id, None)
                .await
                .map_err(|error| CallError::Fetch(Box::new(error)))?;
            let content = target.raw().get_field::<serde_json::Value>("content")?;
            if content
                .as_ref()
                .is_none_or(|content| content.get("lifetime").is_some())
            {
                return Err(error);
            }
            let Some(AnySyncMessageLikeEvent::RtcNotification(SyncMessageLikeEvent::Original(
                notification,
            ))) = parse(target.raw().json().get())
            else {
                return Err(error);
            };
            if notification.content.notification_type != NotificationType::Notification
                || notification.event_id != event_id
            {
                return Err(error);
            }
            if notification.sender == room.own_user_id() {
                return Err(CallError::DeclineOwnCall);
            }
            Ok(RtcDeclineEventContent::new(event_id))
        }
        Err(error) => Err(error),
    }
}

#[derive(Default)]
pub(super) struct PendingCalls(HashMap<(OwnedRoomId, OwnedEventId), u64>);

impl PendingCalls {
    pub(super) fn insert(&mut self, room: &RoomId, event: &EventId, expires_at: u64, now: u64) {
        self.0.retain(|_, expires_at| *expires_at > now);
        self.0
            .insert((room.to_owned(), event.to_owned()), expires_at);
    }

    pub(super) fn decline(
        &mut self,
        room: &RoomId,
        event: &EventId,
        sender: &UserId,
        own: &UserId,
        now: u64,
    ) -> bool {
        self.0.retain(|_, expires_at| *expires_at > now);
        sender == own
            && self
                .0
                .remove(&(room.to_owned(), event.to_owned()))
                .is_some()
    }
}

pub(super) fn parse(raw: &str) -> Option<matrix_sdk::ruma::events::AnySyncMessageLikeEvent> {
    let mut event: serde_json::Value = serde_json::from_str(raw).ok()?;
    match event.get("type")?.as_str()? {
        "m.rtc.notification" | NOTIFICATION_EVENT_TYPE => {
            let content = event.get_mut("content")?.as_object_mut()?;
            if content
                .get("notification_type")
                .and_then(serde_json::Value::as_str)
                == Some("notification")
            {
                content
                    .entry("lifetime")
                    .or_insert(NOTIFICATION_LIFETIME_MS.into());
            }
        }
        "m.rtc.decline" | DECLINE_EVENT_TYPE => {}
        _ => return None,
    }
    serde_json::from_value(event).ok()
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{event_id, user_id};

    use super::{Mentions, NotificationKind, accept, notification_content};

    fn content(sender_ts: u64, lifetime: u64) -> super::RtcNotificationEventContent {
        let mut content = notification_content(event_id!("$membership"), NotificationKind::Ring);
        content.sender_ts =
            matrix_sdk::ruma::MilliSecondsSinceUnixEpoch(sender_ts.try_into().unwrap());
        content.lifetime = std::time::Duration::from_millis(lifetime);
        content
    }

    #[test]
    fn test_our_own_notification_never_rings_us() {
        let us = user_id!("@erwan:localhost");

        assert!(accept(&content(1_000, 30_000), us, us, 1_000, 1_100).is_none());
    }

    #[test]
    fn test_a_notification_mentioning_nobody_is_ignored() {
        let mut content = content(1_000, 30_000);
        content.mentions = Some(Mentions::default());

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
        content.mentions = Some(Mentions::with_user_ids([
            user_id!("@erwan:localhost").to_owned()
        ]));
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

        assert_eq!(content.notification_type, super::NotificationType::Ring);
        assert_eq!(
            content.relates_to.unwrap().event_id,
            event_id!("$membership")
        );
        assert!(content.mentions.unwrap().room);
    }
    #[test]
    fn test_an_announcement_is_the_deployed_wire_shape_with_the_text_fallback() {
        let raw = super::announcement(event_id!("$membership"), NotificationKind::Ring).unwrap();
        let mut content: serde_json::Value = raw.deserialize_as_unchecked().unwrap();
        let sender_ts = content
            .as_object_mut()
            .unwrap()
            .remove("sender_ts")
            .unwrap();

        assert!(sender_ts.is_u64());
        assert_eq!(
            content,
            serde_json::json!({
                "notification_type": "ring",
                "lifetime": 30_000,
                "m.mentions": { "room": true },
                "m.relates_to": { "rel_type": "m.reference", "event_id": "$membership" },
                "m.text": [{ "body": "Call started" }],
            })
        );
    }

    #[test]
    fn test_only_call_event_types_reach_the_parser() {
        for (event_type, expected) in [
            ("m.rtc.notification", true),
            (super::NOTIFICATION_EVENT_TYPE, true),
            ("m.rtc.decline", true),
            (super::DECLINE_EVENT_TYPE, true),
            ("m.room.message", false),
            ("m.reaction", false),
        ] {
            let raw = matrix_sdk::ruma::serde::Raw::new(&serde_json::json!({
                "type": event_type, "event_id": "$e", "sender": "@bob:localhost",
                "origin_server_ts": 1000, "content": {}
            }))
            .unwrap()
            .cast_unchecked();
            assert_eq!(super::is_call_event_type(&raw), expected, "{event_type}");
        }
    }

    #[test]
    fn stable_and_unstable_notifications_without_reference_are_accepted() {
        for event_type in ["m.rtc.notification", super::NOTIFICATION_EVENT_TYPE] {
            let raw = serde_json::json!({
                "type": event_type, "event_id": "$ring", "sender": "@bob:localhost", "origin_server_ts": 1000,
                "content": {"notification_type": "ring", "m.mentions": {"room": true}, "sender_ts": 1000, "lifetime": 30000}
            });
            let matrix_sdk::ruma::events::AnySyncMessageLikeEvent::RtcNotification(event) =
                super::parse(&raw.to_string()).unwrap()
            else {
                panic!("notification");
            };
            assert!(
                accept(
                    &event.as_original().unwrap().content,
                    user_id!("@bob:localhost"),
                    user_id!("@erwan:localhost"),
                    1000,
                    1100
                )
                .is_some()
            );
        }
    }

    #[test]
    fn non_ringing_legacy_notification_can_omit_lifetime() {
        let raw = serde_json::json!({
            "type": super::NOTIFICATION_EVENT_TYPE, "event_id": "$ring", "sender": "@bob:localhost", "origin_server_ts": 1000,
            "content": {"notification_type": "notification", "m.mentions": {"room": true}, "sender_ts": 1000}
        });
        assert!(super::parse(&raw.to_string()).is_some());
    }

    #[test]
    fn decline_names_and_room_and_sender_scope() {
        let own = user_id!("@erwan:localhost");
        let room = matrix_sdk::ruma::room_id!("!room:localhost");
        for event_type in ["m.rtc.decline", "org.matrix.msc4310.rtc.decline"] {
            let raw = serde_json::json!({
                "type": event_type, "event_id": "$decline", "sender": own, "origin_server_ts": 1000,
                "content": {"m.relates_to": {"rel_type": "m.reference", "event_id": "$ring"}}
            });
            let matrix_sdk::ruma::events::AnySyncMessageLikeEvent::RtcDecline(event) =
                super::parse(&raw.to_string()).unwrap()
            else {
                panic!("decline");
            };
            let event = event.as_original().unwrap();
            let mut pending = super::PendingCalls::default();
            pending.insert(room, event_id!("$ring"), 31000, 1000);
            assert!(!pending.decline(
                room,
                &event.content.relates_to.event_id,
                user_id!("@bob:localhost"),
                own,
                1100
            ));
            assert!(!pending.decline(
                matrix_sdk::ruma::room_id!("!elsewhere:localhost"),
                &event.content.relates_to.event_id,
                &event.sender,
                own,
                1100
            ));
            assert!(pending.decline(
                room,
                &event.content.relates_to.event_id,
                &event.sender,
                own,
                1100
            ));
            assert!(!pending.decline(
                room,
                &event.content.relates_to.event_id,
                &event.sender,
                own,
                1100
            ));
        }
    }
}

#[cfg(test)]
#[path = "notify_sdk_tests.rs"]
mod sdk_tests;
