use std::time::Duration;

use matrix_sdk::ruma::events::rtc::notification::NotificationType;
pub(crate) use matrix_sdk::ruma::events::rtc::notification::RtcNotificationEventContent;
use matrix_sdk::ruma::events::{Mentions, relation::Reference};
use matrix_sdk::ruma::{EventId, MilliSecondsSinceUnixEpoch, OwnedUserId};

pub(crate) const NOTIFICATION_EVENT_TYPE: &str = "org.matrix.msc4075.rtc.notification";
pub(crate) const DECLINE_EVENT_TYPE: &str = "org.matrix.msc4310.rtc.decline";
pub(crate) const NOTIFICATION_LIFETIME_MS: u64 = 30_000;
const ANNOUNCEMENT_FALLBACK_TEXT: &str = "Call started";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NotificationKind {
    Ring,
    Notification,
}

pub(crate) fn notification_content(
    membership_event_id: &EventId,
    kind: NotificationKind,
    ring: &[OwnedUserId],
) -> RtcNotificationEventContent {
    let mut content = RtcNotificationEventContent::new(
        MilliSecondsSinceUnixEpoch::now(),
        Duration::from_millis(NOTIFICATION_LIFETIME_MS),
        match kind {
            NotificationKind::Ring => NotificationType::Ring,
            NotificationKind::Notification => NotificationType::Notification,
        },
    );
    let mut mentions = Mentions::with_room_mention();
    mentions.user_ids = ring.iter().cloned().collect();
    content.mentions = Some(mentions);
    content.relates_to = Some(Reference::new(membership_event_id.to_owned()));
    content
}

pub(crate) fn announcement(
    membership_event_id: &EventId,
    kind: NotificationKind,
    ring: &[OwnedUserId],
) -> Option<ruma::serde::Raw<ruma::events::AnyMessageLikeEventContent>> {
    let content = notification_content(membership_event_id, kind, ring);
    ruma::serde::Raw::new(&AnnouncementOut {
        content,
        text: [TextOut {
            body: ANNOUNCEMENT_FALLBACK_TEXT,
        }],
    })
    .ok()
    .map(ruma::serde::Raw::cast_unchecked)
}

#[derive(serde::Serialize)]
struct TextOut {
    body: &'static str,
}

#[derive(serde::Serialize)]
struct AnnouncementOut {
    #[serde(flatten)]
    content: RtcNotificationEventContent,
    #[serde(rename = "m.text")]
    text: [TextOut; 1],
}

/// A decline event stamped with the empty `m.mentions` message events carry.
#[derive(serde::Serialize)]
pub(super) struct DeclineOut {
    #[serde(flatten)]
    pub(super) content: ruma::events::rtc::decline::RtcDeclineEventContent,
    #[serde(rename = "m.mentions")]
    pub(super) mentions: serde_json::Map<String, serde_json::Value>,
}

pub(crate) fn is_call_event_type<T>(raw: &ruma::serde::Raw<T>) -> bool {
    matches!(
        raw.get_field::<String>("type").ok().flatten().as_deref(),
        Some(
            "m.rtc.invite"
                | "m.rtc.notification"
                | NOTIFICATION_EVENT_TYPE
                | "m.rtc.decline"
                | DECLINE_EVENT_TYPE
        )
    )
}

pub(crate) fn is_call_membership_event_type<T>(raw: &ruma::serde::Raw<T>) -> bool {
    raw.get_field::<String>("type")
        .ok()
        .flatten()
        .is_some_and(|event_type| {
            matches!(
                event_type.as_str(),
                "org.matrix.msc3401.call.member" | "m.call.member"
            ) || super::membership::is_rtc_member_type(&event_type)
        })
}

pub(super) async fn make_decline_event(
    room: &matrix_sdk::Room,
    event_id: &EventId,
) -> Result<ruma::events::rtc::decline::RtcDeclineEventContent, matrix_sdk::room::calls::CallError>
{
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

pub(super) fn parse(raw: &str) -> Option<ruma::events::AnySyncMessageLikeEvent> {
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
    use serde_json::json;

    #[test]
    fn legacy_announcements_keep_the_deployed_wire_format() {
        let raw = super::announcement(
            event_id!("$membership"),
            super::NotificationKind::Ring,
            &[user_id!("@bob:example.org").to_owned()],
        )
        .unwrap();
        let content: serde_json::Value = raw.deserialize_as_unchecked().unwrap();
        assert_eq!(content["notification_type"], "ring");
        assert_eq!(
            content["m.mentions"]["user_ids"],
            json!(["@bob:example.org"])
        );
        assert_eq!(content["m.relates_to"]["event_id"], "$membership");
        assert_eq!(content["m.text"], json!([{"body":"Call started"}]));
    }

    #[test]
    fn legacy_visual_notifications_can_omit_lifetime() {
        let event = json!({
            "type": super::NOTIFICATION_EVENT_TYPE, "event_id":"$legacy",
            "sender":"@bob:example.org", "origin_server_ts":1000,
            "content":{"notification_type":"notification", "sender_ts":1000,
                "m.mentions":{"room":true}}
        });
        assert!(super::parse(&event.to_string()).is_some());
    }

    #[test]
    fn both_invite_names_are_call_events() {
        for event_type in [
            "m.rtc.invite",
            "m.rtc.notification",
            super::NOTIFICATION_EVENT_TYPE,
            "m.rtc.decline",
            super::DECLINE_EVENT_TYPE,
        ] {
            let raw = ruma::serde::Raw::new(&json!({"type":event_type})).unwrap();
            assert!(super::is_call_event_type(&raw), "{event_type}");
        }
    }
}
