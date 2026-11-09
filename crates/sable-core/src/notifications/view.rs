use matrix_sdk::Client;
use matrix_sdk::ruma::api::client::state::get_state_event_for_key;
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::events::TimelineEventType;
use matrix_sdk::ruma::push::Action;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{EventId, MilliSecondsSinceUnixEpoch, OwnedUserId, RoomId};
use matrix_sdk_ui::notification_client::{
    NotificationClient, NotificationEvent, NotificationItem, NotificationProcessSetup,
    NotificationStatus, RawNotificationEvent,
};
use sable_model::text::visible_name;

use crate::preview;
use crate::protocol::{NotificationView, PushEventView, PushFetchView};

pub async fn fetch_push_event(
    client: &Client,
    sync_service: std::sync::Arc<matrix_sdk_ui::sync_service::SyncService>,
    room_id: &RoomId,
    event_id: &EventId,
) -> PushFetchView {
    let setup = NotificationProcessSetup::SingleProcess { sync_service };
    fetch_push_event_with(client, setup, room_id, event_id).await
}

pub(super) async fn fetch_push_event_with(
    client: &Client,
    setup: NotificationProcessSetup,
    room_id: &RoomId,
    event_id: &EventId,
) -> PushFetchView {
    let Ok(notifications) = NotificationClient::new(client.clone(), setup).await else {
        return PushFetchView::Unavailable;
    };
    match related_notification(&notifications, client, room_id, event_id).await {
        Ok(NotificationStatus::Event(item))
            if item
                .actions
                .as_deref()
                .is_some_and(|actions| !notifies(actions)) =>
        {
            PushFetchView::Discard
        }
        Ok(NotificationStatus::Event(item))
            if item.actions.is_none()
                && item.is_room_encrypted == Some(true)
                && every_encrypted_event_pushed(client).await =>
        {
            PushFetchView::Discard
        }
        Ok(NotificationStatus::Event(item)) => {
            let raw = match &item.raw_event {
                RawNotificationEvent::Timeline(raw) => raw.json().get(),
                RawNotificationEvent::Invite(raw) => raw.json().get(),
            };
            let normalized = if let Ok(mut raw) = serde_json::from_str::<serde_json::Value>(raw)
                && is_rtc_invite(&raw)
            {
                let Some(room) = client.get_room(room_id) else {
                    return PushFetchView::Discard;
                };
                if !prepare_invite(&room, &mut raw).await {
                    return PushFetchView::Discard;
                }
                raw.get_mut("content").map(serde_json::Value::take)
            } else {
                None
            };
            let Some(mut event) = push_event_view(*item) else {
                return PushFetchView::Unavailable;
            };
            if let Some(content) = normalized {
                event.content = content;
            }
            if let Some(room) = client.get_room(room_id) {
                let is_direct = room.is_direct().await.unwrap_or(false);
                apply_direct_name(&room, &mut event.room_name, is_direct).await;
            }
            if event.sender_display_name.is_none() {
                event.sender_display_name = Some(sender_name(client, room_id, &event.sender).await);
            }
            PushFetchView::Event { event }
        }
        Ok(NotificationStatus::EventFilteredOut | NotificationStatus::EventRedacted) => {
            PushFetchView::Discard
        }
        Ok(NotificationStatus::EventNotFound) | Err(_) => PushFetchView::Unavailable,
    }
}

pub(super) async fn related_notification(
    notifications: &NotificationClient,
    client: &Client,
    room_id: &RoomId,
    event_id: &EventId,
) -> Result<NotificationStatus, matrix_sdk_ui::notification_client::Error> {
    let mut status = notifications.get_notification(room_id, event_id).await;
    if let Ok(NotificationStatus::Event(item)) = &mut status
        && let (Some(actions), RawNotificationEvent::Timeline(raw), Some(room)) = (
            item.actions.take(),
            &item.raw_event,
            client.get_room(room_id),
        )
    {
        item.actions = Some(crate::push_rules::related_actions(&room, raw, actions).await);
    }
    status
}

async fn sender_name(client: &Client, room_id: &RoomId, sender: &str) -> String {
    let request = get_state_event_for_key::v3::Request::new(
        room_id.to_owned(),
        StateEventType::RoomMember,
        sender.to_owned(),
    );
    let fetched = client.send(request).await.ok().and_then(|response| {
        serde_json::from_str::<serde_json::Value>(response.event_or_content.get()).ok()
    });
    fetched
        .as_ref()
        .map(|value| value.get("content").unwrap_or(value))
        .and_then(|content| content.get("displayname")?.as_str())
        .map(str::trim)
        .and_then(visible_name)
        .unwrap_or(sender)
        .to_owned()
}

fn push_event_view(item: NotificationItem) -> Option<PushEventView> {
    let raw = match &item.raw_event {
        RawNotificationEvent::Timeline(raw) => raw.json().get(),
        RawNotificationEvent::Invite(raw) => raw.json().get(),
    };
    let mut event: serde_json::Value = serde_json::from_str(raw).ok()?;
    let noisy = item.is_noisy == Some(true) || item.has_mention == Some(true);
    Some(PushEventView {
        event_type: event.get("type")?.as_str()?.to_owned(),
        content: event
            .get_mut("content")
            .map(serde_json::Value::take)
            .unwrap_or_default(),
        sender: item.event.sender().to_string(),
        sender_display_name: item.sender_display_name.and_then(visible_name),
        room_name: item.room_computed_display_name,
        room_avatar_url: item.room_avatar_url,
        encrypted: item.is_room_encrypted == Some(true),
        noisy,
    })
}

pub use crate::push_rules::notifies;

#[must_use]
pub fn uses_direct_push_rules(room: &matrix_sdk::Room) -> bool {
    room.joined_members_count() == 2
}

pub async fn every_encrypted_event_pushed(client: &Client) -> bool {
    client
        .account()
        .push_rules()
        .await
        .is_ok_and(|rules| crate::push_rules::pushes_every_encrypted_event(&rules))
}

pub async fn notification(
    client: &Client,
    setup: NotificationProcessSetup,
    room_id: &RoomId,
    event_id: &EventId,
) -> Option<NotificationView> {
    let notifications = NotificationClient::new(client.clone(), setup).await.ok()?;

    match related_notification(&notifications, client, room_id, event_id).await {
        Ok(NotificationStatus::Event(item)) if item.actions.as_deref().is_some_and(notifies) => {
            let mut view = view(client.user_id()?.to_owned(), room_id, event_id, *item);
            if let Some(room) = client.get_room(room_id) {
                apply_direct_name(&room, &mut view.room_name, view.is_direct).await;
            }
            Some(view)
        }
        _ => None,
    }
}

pub(crate) async fn foreground_notification(
    notifications: &NotificationClient,
    room: &matrix_sdk::Room,
    event_id: &EventId,
    discard_undecryptable: bool,
) -> Option<NotificationView> {
    match notifications
        .get_notification_with_context(room.room_id(), event_id)
        .await
    {
        Ok(NotificationStatus::Event(item))
            if !(discard_undecryptable && still_encrypted(&item.event)) =>
        {
            let mut view = view(
                room.own_user_id().to_owned(),
                room.room_id(),
                event_id,
                *item,
            );
            apply_direct_name(room, &mut view.room_name, view.is_direct).await;
            Some(view)
        }
        _ => None,
    }
}

fn still_encrypted(event: &NotificationEvent) -> bool {
    matches!(
        event,
        NotificationEvent::Timeline(event)
            if event.event_type() == TimelineEventType::RoomEncrypted
    )
}

pub(crate) fn raw_is_encrypted(raw: &Raw<AnySyncTimelineEvent>) -> bool {
    raw.get_field::<String>("type").ok().flatten().as_deref() == Some("m.room.encrypted")
}

async fn apply_direct_name(room: &matrix_sdk::Room, name: &mut String, is_direct: bool) {
    if is_direct
        && room.name().is_none()
        && let Some(peer) = crate::view::direct_peer_name(room).await
    {
        *name = peer;
    }
}

pub(crate) async fn invite_notification(
    room: &matrix_sdk::Room,
    actions: &[Action],
) -> Option<NotificationView> {
    let invite = room.invite_details().await.ok()?;
    Some(NotificationView {
        user_id: room.own_user_id().to_owned(),
        room_id: room.room_id().to_owned(),
        event_id: None,
        room_name: room.display_name().await.ok()?.to_string(),
        room_avatar_url: room.avatar_url().map(|url| url.to_string()),
        is_direct: room.is_direct().await.unwrap_or(false),
        encrypted: room.encryption_state().is_encrypted(),
        sender: invite.inviter_id,
        sender_name: invite.inviter.as_ref().and_then(|member| {
            member
                .display_name()
                .and_then(visible_name)
                .map(ToOwned::to_owned)
        }),
        sender_avatar_url: invite
            .inviter
            .as_ref()
            .and_then(|member| member.avatar_url().map(ToString::to_string)),
        body: "invited you".to_owned(),
        mention: actions.iter().any(Action::is_highlight),
        noisy: Some(actions.iter().any(|action| action.sound().is_some())),
    })
}

const BACKFILL_GRACE_MS: u64 = 60_000;
pub const NOISY_KEY: &str = "moe.sable.noisy";

#[must_use]
pub fn is_backfill(
    now: MilliSecondsSinceUnixEpoch,
    origin_server_ts: MilliSecondsSinceUnixEpoch,
) -> bool {
    let now: u64 = now.get().into();
    let sent: u64 = origin_server_ts.get().into();
    sent < now.saturating_sub(BACKFILL_GRACE_MS)
}

pub async fn is_read(room: &matrix_sdk::Room, sent: MilliSecondsSinceUnixEpoch) -> bool {
    room.unread_notification_counts().notification_count == 0
        && crate::inbox::receipt_ts(room).await.unwrap_or(0) >= u64::from(sent.get())
}

fn view(
    user_id: OwnedUserId,
    room_id: &RoomId,
    event_id: &EventId,
    item: NotificationItem,
) -> NotificationView {
    NotificationView {
        user_id,
        room_id: room_id.to_owned(),
        event_id: Some(event_id.to_owned()),
        room_name: item.room_computed_display_name,
        room_avatar_url: item.room_avatar_url,
        is_direct: item.is_direct_message_room,
        encrypted: item.is_room_encrypted.unwrap_or(false),
        sender: item.event.sender().to_owned(),
        sender_name: item.sender_display_name.and_then(visible_name),
        sender_avatar_url: item.sender_avatar_url,
        body: body(&item.event),
        mention: item.has_mention.unwrap_or(false),
        noisy: item.is_noisy,
    }
}

fn body(event: &NotificationEvent) -> String {
    match event {
        NotificationEvent::Invite(_) => "invited you".to_owned(),
        NotificationEvent::Timeline(event) => preview::describe(event.as_ref()),
    }
}

pub(super) fn is_rtc_invite(event: &serde_json::Value) -> bool {
    matches!(
        event["type"].as_str(),
        Some("m.rtc.invite" | "m.rtc.notification" | "org.matrix.msc4075.rtc.notification")
    )
}

pub(super) async fn prepare_invite(room: &matrix_sdk::Room, event: &mut serde_json::Value) -> bool {
    let Some(invite) = crate::calls::validate_invite(room, event).await else {
        return false;
    };
    let now = crate::now_ms();
    let remaining = invite.expires_at_ms.saturating_sub(now);
    if remaining == 0 {
        return false;
    }
    // These fields describe local presentation; they are never sent back into the room.
    let content = &mut event["content"];
    content["notification_type"] = if invite.ring { "ring" } else { "notification" }.into();
    content["sender_ts"] = now.into();
    content["lifetime"] = remaining.into();
    content["m.call.intent"] = if invite.has_video { "video" } else { "audio" }.into();
    content["body"] = "Call started".into();
    true
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{MilliSecondsSinceUnixEpoch, UInt};

    use super::is_backfill;

    fn ts(millis: u32) -> MilliSecondsSinceUnixEpoch {
        MilliSecondsSinceUnixEpoch(UInt::from(millis))
    }

    #[test]
    fn a_replayed_event_is_backfill_and_a_recent_one_is_not() {
        let now = ts(120_000);
        assert!(is_backfill(now, ts(1_000)));
        assert!(!is_backfill(now, ts(120_000)));
        assert!(!is_backfill(now, ts(200_000)));
        assert!(!is_backfill(now, ts(61_000)));
        assert!(is_backfill(now, ts(59_000)));
    }
}
