use sable_core::protocol::NotificationView;
#[cfg(any(mobile, test))]
use sable_core::protocol::WebPushKeys;
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

fn body(view: &NotificationView, content: bool) -> String {
    let sender = view
        .sender_name
        .clone()
        .unwrap_or_else(|| view.sender.to_string());

    match (content, view.is_direct) {
        (true, true) => view.body.clone(),
        (true, false) => format!("{sender}: {}", view.body),
        (false, true) => "New message".to_owned(),
        (false, false) => format!("New message from {sender}"),
    }
}

pub async fn show<R: Runtime>(
    app: &AppHandle<R>,
    core: &sable_core::Core,
    view: &NotificationView,
) {
    let builder = app
        .notifications()
        .builder()
        .id(room_notification_id(
            view.user_id.as_str(),
            view.room_id.as_str(),
        ))
        .title(view.room_name.clone())
        .body(body(view, core.notification_content()))
        .channel_id(MESSAGES_CHANNEL);

    if let Err(error) = builder.show().await {
        log::warn!("could not show a notification: {error}");
    }
}

#[cfg(any(mobile, test))]
struct Registration {
    token: String,
    p256dh: Option<String>,
    auth: Option<String>,
}

#[cfg(any(mobile, test))]
fn pusher(
    registration: Registration,
    native_app_id: Option<&str>,
    web_app_id: Option<&str>,
) -> Option<(String, String, Option<WebPushKeys>)> {
    match (registration.p256dh, registration.auth) {
        (Some(p256dh), Some(auth)) => Some((
            web_app_id?.to_owned(),
            p256dh.clone(),
            Some(WebPushKeys {
                endpoint: registration.token,
                p256dh,
                auth,
            }),
        )),
        _ => Some((native_app_id?.to_owned(), registration.token, None)),
    }
}

#[cfg(mobile)]
pub async fn register_push<R: Runtime>(app: &AppHandle<R>, core: &sable_core::Core) {
    use sable_core::protocol::{Command, PusherView};

    let Some(url) = option_env!("PUSH_GATEWAY_URL") else {
        return;
    };

    let registered = match app
        .notifications()
        .register_for_push_notifications(option_env!("PUSH_VAPID_KEY").map(str::to_owned), None)
        .await
    {
        Ok(registered) => Registration {
            token: registered.device_token,
            p256dh: registered.p256dh,
            auth: registered.auth,
        },
        Err(error) => {
            log::warn!("could not register for push: {error}");
            return;
        }
    };

    let Some((app_id, pushkey, web_push)) = pusher(
        registered,
        option_env!("PUSH_APP_ID"),
        option_env!("PUSH_WEB_APP_ID"),
    ) else {
        return;
    };

    let command = Command::SetPusher {
        pusher: PusherView {
            pushkey,
            app_id,
            url: url.to_owned(),
            device_display_name: format!("Sable on {}", std::env::consts::OS),
            web_push,
            event_id_only: !core.notification_content(),
            append: false,
        },
    };

    if let Err(error) = core.dispatch(command).await {
        log::warn!("could not tell the homeserver where to push: {error:?}");
    }
}

#[cfg(not(mobile))]
#[expect(clippy::unused_async, reason = "mirrors the mobile signature")]
pub async fn register_push<R: Runtime>(_app: &AppHandle<R>, _core: &sable_core::Core) {}

#[cfg(test)]
mod tests {
    use sable_core::protocol::NotificationView;

    use super::{body, java_hash, pusher, room_notification_id, Registration};

    fn view(is_direct: bool) -> NotificationView {
        NotificationView {
            user_id: "@me:example.org".parse().expect("a user id"),
            room_id: "!room:example.org".parse().expect("a room id"),
            event_id: "$event".parse().expect("an event id"),
            room_name: "Design crew".to_owned(),
            room_avatar_url: None,
            is_direct,
            sender: "@ada:example.org".parse().expect("a user id"),
            sender_name: Some("Ada".to_owned()),
            sender_avatar_url: None,
            body: "shipped the patch".to_owned(),
            mention: false,
            noisy: Some(true),
        }
    }

    #[test]
    fn a_hidden_body_names_the_sender_but_not_the_message() {
        assert_eq!(body(&view(false), true), "Ada: shipped the patch");
        assert_eq!(body(&view(true), true), "shipped the patch");
        assert_eq!(body(&view(false), false), "New message from Ada");
        assert_eq!(body(&view(true), false), "New message");
    }

    #[test]
    fn a_web_push_distributor_registers_its_keys() {
        let (app_id, pushkey, web_push) = pusher(
            Registration {
                token: "https://push.example/endpoint".to_owned(),
                p256dh: Some("key".to_owned()),
                auth: Some("secret".to_owned()),
            },
            Some("moe.sable.client.android"),
            Some("moe.sable.app.sygnal"),
        )
        .expect("a web push registration has an app id");

        assert_eq!(app_id, "moe.sable.app.sygnal");
        assert_eq!(pushkey, "key");
        let keys = web_push.expect("the gateway needs the keys");
        assert_eq!(keys.endpoint, "https://push.example/endpoint");
        assert_eq!(keys.auth, "secret");
    }

    #[test]
    fn a_bare_token_registers_as_the_pushkey() {
        let (app_id, pushkey, web_push) = pusher(
            Registration {
                token: "fcm-token".to_owned(),
                p256dh: None,
                auth: None,
            },
            Some("moe.sable.client.android"),
            Some("moe.sable.app.sygnal"),
        )
        .expect("a token registration has an app id");

        assert_eq!(app_id, "moe.sable.client.android");
        assert_eq!(pushkey, "fcm-token");
        assert!(web_push.is_none());
    }

    #[test]
    fn a_build_without_the_matching_app_id_registers_nothing() {
        assert!(pusher(
            Registration {
                token: "fcm-token".to_owned(),
                p256dh: None,
                auth: None,
            },
            None,
            Some("moe.sable.app.sygnal"),
        )
        .is_none());
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
