use sable_core::protocol::NotificationView;
use tauri::{AppHandle, Runtime};
use tauri_plugin_notifications::NotificationsExt;

const MESSAGES_CHANNEL: &str = "messages.v2";

fn java_hash(text: &str) -> i32 {
    text.encode_utf16().fold(0i32, |hash, unit| {
        hash.wrapping_mul(31).wrapping_add(i32::from(unit))
    })
}

/// Must equal what the plugin's Android service computes for a cold
/// notification, or a warm alert stacks beside it instead of replacing it.
pub fn room_notification_id(user_id: &str, room_id: &str) -> i32 {
    let hash = java_hash(&format!("{user_id}\0{room_id}"));
    if hash == i32::MIN {
        0
    } else {
        hash.abs()
    }
}

fn body(view: &NotificationView) -> String {
    if view.is_direct {
        return view.body.clone();
    }

    let sender = view
        .sender_name
        .clone()
        .unwrap_or_else(|| view.sender.to_string());
    format!("{sender}: {}", view.body)
}

pub async fn show<R: Runtime>(app: &AppHandle<R>, view: &NotificationView) {
    let builder = app
        .notifications()
        .builder()
        .id(room_notification_id(
            view.user_id.as_str(),
            view.room_id.as_str(),
        ))
        .title(view.room_name.clone())
        .body(body(view))
        .channel_id(MESSAGES_CHANNEL);

    if let Err(error) = builder.show().await {
        log::warn!("could not show a notification: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::{java_hash, room_notification_id};

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
