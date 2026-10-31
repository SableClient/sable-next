#[cfg(target_os = "android")]
mod android;
#[cfg(not(target_os = "android"))]
mod display;
#[cfg(any(mobile, test))]
mod gateway;
mod registration;

#[cfg(target_os = "android")]
pub(crate) use android::{
    forget_left_conversations, maintain_background_push, set_open_conversation,
};
#[cfg(target_os = "android")]
use android::{post_android, remove_posted};
#[cfg(not(target_os = "android"))]
use display::remove_posted;
pub(crate) use registration::{
    DevicePusher, PushConfig, PushRegistrationError, PushStore, device_pusher, register_push,
    unregister_push,
};
use sable_core::protocol::NotificationView;
use sable_core::ruma::{EventId, owned_room_id, owned_user_id};
use tauri::{AppHandle, Runtime};
use tauri_plugin_notifications::NotificationsExt;

fn java_hash(text: &str) -> i32 {
    text.encode_utf16().fold(0i32, |hash, unit| {
        hash.wrapping_mul(31).wrapping_add(i32::from(unit))
    })
}

/// Must equal what the plugin's Android service computes for a cold
/// notification, or a warm alert stacks beside it instead of replacing it.
pub(crate) fn room_notification_id(user_id: &str, room_id: &str) -> i32 {
    let hash = java_hash(&format!("{user_id}\0{room_id}"));
    if hash == i32::MIN { 0 } else { hash.abs() }
}

pub(crate) async fn show<R: Runtime>(
    app: &AppHandle<R>,
    core: &sable_core::Core,
    view: &NotificationView,
) {
    if !core.notifications_enabled() {
        return;
    }
    #[cfg(target_os = "android")]
    post_android(app, view).await;
    #[cfg(not(target_os = "android"))]
    display::show_generic(app, core, view).await;
}

pub(crate) async fn permission<R: Runtime>(app: &AppHandle<R>) -> &'static str {
    grant(app.notifications().permission_state().await)
}

pub(crate) async fn request_permission<R: Runtime>(app: &AppHandle<R>) -> &'static str {
    grant(app.notifications().request_permission().await)
}

fn grant(
    state: Result<tauri::plugin::PermissionState, tauri_plugin_notifications::Error>,
) -> &'static str {
    match state {
        Ok(tauri::plugin::PermissionState::Granted) => "granted",
        Ok(tauri::plugin::PermissionState::Denied) => "denied",
        Ok(_) => "prompt",
        Err(error) => {
            log::debug!("could not read the notification permission: {error}");
            "prompt"
        }
    }
}

pub(crate) async fn show_test<R: Runtime>(
    app: &AppHandle<R>,
    core: &sable_core::Core,
    sequence: u32,
) {
    show(app, core, &test_view(sequence)).await;
}

fn test_view(sequence: u32) -> NotificationView {
    NotificationView {
        user_id: owned_user_id!("@sable:notification.test"),
        room_id: owned_room_id!("!notification:notification.test"),
        event_id: EventId::parse(format!("$notification-test-{sequence}")).ok(),
        room_name: "Notification test".to_owned(),
        room_avatar_url: None,
        is_direct: false,
        encrypted: false,
        sender: owned_user_id!("@sable:notification.test"),
        sender_name: Some("Sable".to_owned()),
        sender_avatar_url: None,
        body: format!("Test notification {sequence}"),
        mention: false,
        noisy: Some(true),
    }
}

pub(crate) async fn dismiss<R: Runtime>(app: &AppHandle<R>, user_id: &str, room_ids: &[String]) {
    #[cfg(not(target_os = "android"))]
    for room_id in room_ids {
        display::forget(user_id, room_id);
    }
    if room_ids.is_empty() {
        return;
    }
    let ids = room_ids
        .iter()
        .map(|room_id| room_notification_id(user_id, room_id))
        .collect();
    remove_posted(app, ids).await;
}

pub(crate) async fn dismiss_read<R: Runtime>(
    app: &AppHandle<R>,
    user_id: &str,
    room_ids: &[String],
) {
    #[cfg(not(target_os = "android"))]
    for room_id in room_ids {
        display::forget(user_id, room_id);
    }
    let ids: Vec<i32> = room_ids
        .iter()
        .map(|room_id| room_notification_id(user_id, room_id))
        .collect();
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_sable_push::SablePushExt;
        if !ids.is_empty()
            && let Err(error) = app.sable_push().dismiss_shown(&ids).await
        {
            log::debug!("could not dismiss the read notifications: {error}");
        }
    }
    #[cfg(not(target_os = "android"))]
    if !ids.is_empty() {
        remove_posted(app, ids).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{java_hash, room_notification_id};

    #[test]
    fn the_invite_category_the_ios_extension_names_is_declared() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("a Tauri config");
        let parsed: tauri_plugin_notifications::PluginConfig = serde_json::from_value(
            config
                .pointer("/plugins/notifications")
                .expect("a notifications plugin config")
                .clone(),
        )
        .expect("the plugin reads its own config");

        let category = parsed
            .action_types
            .iter()
            .find(|action_type| action_type.id() == "sable-invite")
            .expect("the category the iOS extension sets on invites");
        let ids: Vec<_> = category
            .actions()
            .iter()
            .map(tauri_plugin_notifications::Action::id)
            .collect();

        assert_eq!(ids, ["sable-invite-accept", "sable-invite-decline"]);
    }

    #[test]
    fn hashes_as_java_does() {
        assert_eq!(java_hash(""), 0);
        assert_eq!(java_hash("a"), 97);
        assert_eq!(java_hash("hello"), 99_162_322);
    }

    #[test]
    fn ids_are_nonnegative() {
        let id = room_notification_id("@ada:example.org", "!room:example.org");
        assert!(id >= 0);
        assert_eq!(
            id,
            room_notification_id("@ada:example.org", "!room:example.org")
        );
    }
}
