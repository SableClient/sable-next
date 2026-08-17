use matrix_sdk::Client;
use matrix_sdk::notification_settings::{IsEncrypted, IsOneToOne, RoomNotificationMode};
use matrix_sdk::ruma::api::client::push::{PusherIds, PusherInit, PusherKind};
use matrix_sdk::ruma::events::AnySyncMessageLikeEvent;
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::events::room::message::MessageType;
use matrix_sdk::ruma::push::{Action, HttpPusherData, PushFormat};
use matrix_sdk::ruma::{EventId, OwnedUserId, RoomId};
use matrix_sdk_ui::notification_client::{
    NotificationClient, NotificationEvent, NotificationItem, NotificationProcessSetup,
    NotificationStatus,
};

use crate::protocol::{NotificationModeView, NotificationSettingsView, NotificationView};

impl From<NotificationModeView> for RoomNotificationMode {
    fn from(mode: NotificationModeView) -> Self {
        match mode {
            NotificationModeView::All => Self::AllMessages,
            NotificationModeView::Mentions => Self::MentionsAndKeywordsOnly,
            NotificationModeView::Mute => Self::Mute,
        }
    }
}

impl From<RoomNotificationMode> for NotificationModeView {
    fn from(mode: RoomNotificationMode) -> Self {
        match mode {
            RoomNotificationMode::AllMessages => Self::All,
            RoomNotificationMode::MentionsAndKeywordsOnly => Self::Mentions,
            RoomNotificationMode::Mute => Self::Mute,
        }
    }
}

fn room_kind(room: &matrix_sdk::Room) -> (IsEncrypted, IsOneToOne) {
    let encrypted = if room.encryption_state().is_encrypted() {
        IsEncrypted::Yes
    } else {
        IsEncrypted::No
    };
    (
        encrypted,
        IsOneToOne::from(room.active_members_count() == 2),
    )
}

pub async fn settings(room: &matrix_sdk::Room) -> NotificationSettingsView {
    let settings = room.client().notification_settings().await;
    let (encrypted, one_to_one) = room_kind(room);

    NotificationSettingsView {
        room: settings
            .get_user_defined_room_notification_mode(room.room_id())
            .await
            .map(Into::into),
        default: settings
            .get_default_room_notification_mode(encrypted, one_to_one)
            .await
            .into(),
    }
}

pub async fn default_modes(client: &Client) -> (NotificationModeView, NotificationModeView) {
    let settings = client.notification_settings().await;
    let direct = settings
        .get_default_room_notification_mode(IsEncrypted::Yes, IsOneToOne::Yes)
        .await;
    let group = settings
        .get_default_room_notification_mode(IsEncrypted::Yes, IsOneToOne::No)
        .await;
    (direct.into(), group.into())
}

/// # Errors
///
/// When the server rejects the push rule write.
pub async fn set_default_mode(
    client: &Client,
    direct: bool,
    mode: NotificationModeView,
) -> Result<(), String> {
    let settings = client.notification_settings().await;
    let one_to_one = IsOneToOne::from(direct);

    for encrypted in [IsEncrypted::Yes, IsEncrypted::No] {
        settings
            .set_default_room_notification_mode(encrypted, one_to_one, mode.into())
            .await
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

/// # Errors
///
/// When the server rejects the push rule write.
pub async fn set_room_mode(
    room: &matrix_sdk::Room,
    mode: Option<NotificationModeView>,
) -> Result<(), String> {
    let settings = room.client().notification_settings().await;

    match mode {
        Some(mode) => {
            settings
                .set_room_notification_mode(room.room_id(), mode.into())
                .await
        }
        None => {
            settings
                .delete_user_defined_room_rules(room.room_id())
                .await
        }
    }
    .map_err(|error| error.to_string())
}

pub async fn notification(
    client: &Client,
    setup: NotificationProcessSetup,
    room_id: &RoomId,
    event_id: &EventId,
) -> Option<NotificationView> {
    let notifications = NotificationClient::new(client.clone(), setup).await.ok()?;

    match notifications.get_notification(room_id, event_id).await {
        Ok(NotificationStatus::Event(item)) => {
            Some(view(client.user_id()?.to_owned(), room_id, event_id, *item))
        }
        _ => None,
    }
}

/// A cold platform notification is built from this payload, and it derives its
/// identity from `user_id`, so leaving it out stops a running app replacing it.
///
/// # Errors
///
/// When the server rejects the registration.
pub async fn set_pusher(
    client: &Client,
    pushkey: String,
    app_id: String,
    url: String,
    device_display_name: String,
    event_id_only: bool,
    append: bool,
) -> Result<(), String> {
    let mut pusher_data = HttpPusherData::new(url);
    if event_id_only {
        pusher_data.format = Some(PushFormat::EventIdOnly);
    }
    if let Some(user_id) = client.user_id() {
        pusher_data
            .data
            .insert("user_id".to_owned(), user_id.as_str().into());
    }

    client
        .pusher()
        .set(
            PusherInit {
                ids: PusherIds::new(pushkey, app_id),
                kind: PusherKind::Http(pusher_data),
                app_display_name: "Sable".to_owned(),
                device_display_name,
                profile_tag: None,
                lang: "en".to_owned(),
            }
            .into(),
            append,
        )
        .await
        .map_err(|error| error.to_string())
}

/// # Errors
///
/// When the server rejects the removal.
pub async fn remove_pusher(client: &Client, pushkey: String, app_id: String) -> Result<(), String> {
    client
        .pusher()
        .delete(PusherIds::new(pushkey, app_id))
        .await
        .map_err(|error| error.to_string())
}

#[must_use]
pub fn notifies(actions: &[Action]) -> bool {
    actions
        .iter()
        .any(|action| matches!(action, Action::Notify))
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
        event_id: event_id.to_owned(),
        room_name: item.room_computed_display_name,
        room_avatar_url: item.room_avatar_url,
        is_direct: item.is_direct_message_room,
        sender: item.event.sender().to_owned(),
        sender_name: item.sender_display_name,
        sender_avatar_url: item.sender_avatar_url,
        body: body(&item.event),
        mention: item.has_mention.unwrap_or(false),
        noisy: item.is_noisy,
    }
}

fn body(event: &NotificationEvent) -> String {
    match event {
        NotificationEvent::Invite(_) => "invited you".to_owned(),
        NotificationEvent::Timeline(event) => timeline_body(event),
    }
}

fn timeline_body(event: &AnySyncTimelineEvent) -> String {
    let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(message)) = event
    else {
        return String::new();
    };
    let Some(content) = message.as_original().map(|original| &original.content) else {
        return String::new();
    };

    match &content.msgtype {
        MessageType::Image(_) => "sent an image".to_owned(),
        MessageType::Video(_) => "sent a video".to_owned(),
        MessageType::Audio(_) => "sent an audio file".to_owned(),
        MessageType::File(_) => "sent a file".to_owned(),
        _ => content.body().to_owned(),
    }
}
