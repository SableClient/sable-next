#[cfg(any(mobile, test))]
use sable_core::protocol::WebPushKeys;
use sable_core::protocol::{CommandErr, NotificationView};
use sable_core::ruma::{owned_event_id, owned_room_id, owned_user_id};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Runtime};
use tauri_plugin_notifications::{NotificationMessage, NotificationsExt};

const MESSAGES_CHANNEL: &str = "messages.v2";
const NOTIFICATION_GROUP: &str = "matrix_messages";
const MESSAGE_ACTIONS: &str = "sable-message";
const MAX_CONVERSATION_LINES: usize = 8;

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

fn conversation_key(user_id: &str, room_id: &str) -> String {
    format!("{user_id}\0{room_id}")
}

#[derive(Clone)]
struct Line {
    sender_name: String,
    sender_key: String,
    body: String,
    at: i64,
}

static CONVERSATIONS: LazyLock<Mutex<HashMap<String, Vec<Line>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or_default()
}

fn group_key(view: &NotificationView) -> String {
    if cfg!(any(target_os = "ios", target_os = "macos")) {
        conversation_key(view.user_id.as_str(), view.room_id.as_str())
    } else {
        NOTIFICATION_GROUP.to_owned()
    }
}

const fn shows_content(encrypted_room: bool, content: bool, encrypted_content: bool) -> bool {
    content && (!encrypted_room || encrypted_content)
}

fn line(view: &NotificationView, content: bool) -> Line {
    Line {
        sender_name: view
            .sender_name
            .clone()
            .unwrap_or_else(|| view.sender.to_string()),
        sender_key: view.sender.to_string(),
        body: if content {
            view.body.clone()
        } else {
            "New message".to_owned()
        },
        at: now_ms(),
    }
}

fn remember(view: &NotificationView, content: bool) -> Vec<Line> {
    let fresh = line(view, content);
    let Ok(mut conversations) = CONVERSATIONS.lock() else {
        return vec![fresh];
    };

    let lines = conversations
        .entry(conversation_key(
            view.user_id.as_str(),
            view.room_id.as_str(),
        ))
        .or_default();
    lines.push(fresh);
    if lines.len() > MAX_CONVERSATION_LINES {
        lines.drain(..lines.len() - MAX_CONVERSATION_LINES);
    }
    lines.clone()
}

fn forget(user_id: &str, room_id: &str) {
    if let Ok(mut conversations) = CONVERSATIONS.lock() {
        conversations.remove(&conversation_key(user_id, room_id));
    }
}

fn conversation_message(line: &Line) -> Option<NotificationMessage> {
    serde_json::from_value(serde_json::json!({
        "body": line.body,
        "timestamp": line.at,
        "senderName": line.sender_name,
        "senderKey": line.sender_key,
    }))
    .ok()
}

fn collapsed(lines: &[Line]) -> String {
    lines
        .iter()
        .map(|line| format!("{}: {}", line.sender_name, line.body))
        .collect::<Vec<_>>()
        .join("\n")
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
    let content = shows_content(
        view.encrypted,
        core.notification_content(),
        core.notification_encrypted_content(),
    );
    let lines = remember(view, content);

    let mut builder = app
        .notifications()
        .builder()
        .id(room_notification_id(
            view.user_id.as_str(),
            view.room_id.as_str(),
        ))
        .title(view.room_name.clone())
        .body(body(view, content))
        .channel_id(MESSAGES_CHANNEL)
        .group(group_key(view))
        .group_conversation(!view.is_direct)
        .action_type_id(MESSAGE_ACTIONS)
        .auto_cancel()
        .extra("user_id", view.user_id.as_str())
        .extra("room_id", view.room_id.as_str())
        .extra("event_id", view.event_id.as_str());

    if cfg!(target_os = "android") {
        builder = builder.icon("notification_icon");
    }
    if lines.len() > 1 {
        builder = builder.large_body(collapsed(&lines));
    }
    for line in &lines {
        if let Some(message) = conversation_message(line) {
            builder = builder.message(message);
        }
    }

    if let Err(error) = builder.show().await {
        log::warn!("could not show a notification: {error}");
    }
}

pub async fn show_test<R: Runtime>(app: &AppHandle<R>, core: &sable_core::Core, sequence: u32) {
    show(app, core, &test_view(sequence)).await;
}

fn test_view(sequence: u32) -> NotificationView {
    NotificationView {
        user_id: owned_user_id!("@sable:notification.test"),
        room_id: owned_room_id!("!notification:notification.test"),
        event_id: owned_event_id!("$notification-test"),
        room_name: "Notification test".to_owned(),
        room_avatar_url: None,
        is_direct: false,
        encrypted: false,
        sender: owned_user_id!("@sable:notification.test"),
        sender_name: Some("Sable".to_owned()),
        sender_avatar_url: None,
        body: format!("Test notification {sequence}"),
        mention: false,
        noisy: Some(false),
    }
}

#[cfg(desktop)]
pub fn register_actions<R: Runtime>(app: &AppHandle<R>) {
    let Some(declared) = app.config().plugins.0.get("notifications") else {
        return;
    };
    let parsed: Result<tauri_plugin_notifications::PluginConfig, _> =
        serde_json::from_value(declared.clone());

    match parsed {
        Ok(config) => {
            if let Err(error) = app
                .notifications()
                .register_action_types(config.action_types)
            {
                log::warn!("could not register the notification actions: {error}");
            }
        }
        Err(error) => log::warn!("the notification actions are not readable: {error}"),
    }
}

pub fn allow_encrypted_content<R: Runtime>(app: &AppHandle<R>, allowed: bool) {
    if let Err(error) = app.notifications().set_encrypted_content_allowed(allowed) {
        log::debug!("could not set the encrypted content policy: {error}");
    }
}

#[cfg_attr(
    desktop,
    expect(clippy::unused_async, reason = "the mobile backend awaits the plugin")
)]
pub async fn dismiss<R: Runtime>(app: &AppHandle<R>, user_id: &str, room_id: &str) {
    forget(user_id, room_id);
    let ids = vec![room_notification_id(user_id, room_id)];

    #[cfg(mobile)]
    let dismissed = app.notifications().remove_active(ids).await;
    #[cfg(desktop)]
    let dismissed = app.notifications().remove_active(ids);

    if let Err(error) = dismissed {
        log::debug!("could not dismiss a notification: {error}");
    }
}

/// Resolved by the webview, so the binary bakes no gateway of its own.
#[derive(serde::Deserialize)]
#[cfg_attr(
    not(mobile),
    expect(dead_code, reason = "only a mobile build registers a pusher")
)]
pub struct PushConfig {
    pub gateway_url: String,
    pub vapid_key: String,
    pub web_app_id: String,
    pub event_id_only: bool,
    pub user_id: Option<String>,
    pub device_id: Option<String>,
    /// Absent when the reader has retargeted the gateway: a token distributor
    /// needs an app id that gateway serves, and only the deployment names one.
    pub native_app_id: Option<String>,
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

/// # Errors
///
/// When the platform refuses a push registration, or the homeserver rejects the
/// pusher the distributor asked for.
#[cfg(mobile)]
pub async fn register_push<R: Runtime>(
    app: &AppHandle<R>,
    core: &Arc<sable_core::Core>,
    config: PushConfig,
) -> Result<(), CommandErr> {
    use sable_core::protocol::{Command, PusherView};

    let registered = app
        .notifications()
        .register_for_push_notifications(
            Some(config.vapid_key),
            None,
            None,
            config.user_id,
            config.device_id,
        )
        .await
        .map_err(|error| {
            log::warn!("could not register for push: {error}");
            CommandErr::Unavailable
        })?;

    let registration = Registration {
        token: registered.device_token,
        p256dh: registered.p256dh,
        auth: registered.auth,
    };

    // No app id for what the platform handed back means this build does not
    // configure that half.
    let Some((app_id, pushkey, web_push)) = pusher(
        registration,
        config.native_app_id.as_deref(),
        Some(&config.web_app_id),
    ) else {
        return Ok(());
    };

    let command = Command::SetPusher {
        pusher: PusherView {
            pushkey,
            app_id,
            url: config.gateway_url,
            device_display_name: format!("Sable on {}", std::env::consts::OS),
            web_push,
            event_id_only: config.event_id_only,
            append: false,
        },
    };

    core.dispatch(command).await.map(|_| ())
}

/// A desktop build has no distributor to register with, and nothing runs to
/// receive a push once it is closed.
///
/// # Errors
///
/// Never; the signature mirrors the mobile one.
#[cfg(not(mobile))]
#[expect(clippy::unused_async, reason = "mirrors the mobile signature")]
pub async fn register_push<R: Runtime>(
    _app: &AppHandle<R>,
    _core: &Arc<sable_core::Core>,
    _config: PushConfig,
) -> Result<(), CommandErr> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use sable_core::protocol::NotificationView;

    use super::{
        body, collapsed, forget, java_hash, pusher, remember, room_notification_id, shows_content,
        Line, Registration, MAX_CONVERSATION_LINES, MESSAGE_ACTIONS,
    };

    fn view(is_direct: bool) -> NotificationView {
        NotificationView {
            user_id: "@me:example.org".parse().expect("a user id"),
            room_id: "!room:example.org".parse().expect("a room id"),
            event_id: "$event".parse().expect("an event id"),
            room_name: "Design crew".to_owned(),
            room_avatar_url: None,
            is_direct,
            encrypted: false,
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

    fn in_room(room: &str) -> NotificationView {
        NotificationView {
            room_id: room.parse().expect("a room id"),
            ..view(false)
        }
    }

    #[test]
    fn a_conversation_keeps_the_newest_lines() {
        let view = in_room("!trimmed:example.org");
        for _ in 0..=MAX_CONVERSATION_LINES {
            remember(&view, true);
        }

        let lines = remember(&view, true);
        assert_eq!(lines.len(), MAX_CONVERSATION_LINES);
        forget(view.user_id.as_str(), view.room_id.as_str());
    }

    #[test]
    fn reading_the_room_empties_its_conversation() {
        let view = in_room("!read:example.org");
        remember(&view, true);
        remember(&view, true);
        forget(view.user_id.as_str(), view.room_id.as_str());

        assert_eq!(remember(&view, true).len(), 1);
        forget(view.user_id.as_str(), view.room_id.as_str());
    }

    #[test]
    fn a_hidden_body_reaches_the_conversation_too() {
        let view = in_room("!hidden:example.org");
        let lines = remember(&view, false);

        assert_eq!(collapsed(&lines), "Ada: New message");
        forget(view.user_id.as_str(), view.room_id.as_str());
    }

    #[test]
    fn every_line_names_its_sender() {
        let lines = vec![
            Line {
                sender_name: "Ada".to_owned(),
                sender_key: "@ada:example.org".to_owned(),
                body: "one".to_owned(),
                at: 0,
            },
            Line {
                sender_name: "Bo".to_owned(),
                sender_key: "@bo:example.org".to_owned(),
                body: "two".to_owned(),
                at: 1,
            },
        ];

        assert_eq!(collapsed(&lines), "Ada: one\nBo: two");
    }

    #[test]
    fn an_encrypted_room_needs_its_own_permission() {
        assert!(shows_content(false, true, false));
        assert!(!shows_content(true, true, false));
        assert!(shows_content(true, true, true));
        assert!(!shows_content(false, false, true));
    }

    #[test]
    fn the_reply_action_is_the_shape_the_plugin_reads() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("a Tauri config");
        let notifications = config
            .pointer("/plugins/notifications")
            .expect("a notifications plugin config");

        let parsed: tauri_plugin_notifications::PluginConfig =
            serde_json::from_value(notifications.clone()).expect("the plugin reads its own config");

        let category = parsed
            .action_types
            .iter()
            .find(|action_type| action_type.id() == MESSAGE_ACTIONS)
            .expect("the category the notifications name");
        let reply = category
            .actions()
            .iter()
            .find(|action| action.id() == "sable-reply")
            .expect("a reply action");

        assert_eq!(reply.title(), "Reply");
        assert!(!reply.foreground());
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
