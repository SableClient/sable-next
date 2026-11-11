use sable_core::protocol::NotificationView;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_notifications::Attachment;
use tauri_plugin_notifications::NotificationMessage;
use tauri_plugin_notifications::NotificationsExt;

const MESSAGES_CHANNEL: &str = "messages.v2";
const MESSAGE_ACTIONS: &str = "sable-message";
const MAX_CONVERSATION_LINES: usize = 8;
const NOTIFY_ONCE_WINDOW: Duration = Duration::from_mins(5);
const AVATAR_SIZE: u32 = 96;
const AVATAR_DIR: &str = "notification-avatars";

fn conversation_key(user_id: &str, room_id: &str) -> String {
    format!("{user_id}\0{room_id}")
}

#[derive(Clone)]
struct Line {
    sender_name: String,
    sender_key: String,
    body: String,
    at: i64,
    event_id: Option<String>,
}

static CONVERSATIONS: LazyLock<Mutex<HashMap<String, Vec<Line>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static ALERTED: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or_default()
}

fn group_key(view: &NotificationView) -> String {
    conversation_key(view.user_id.as_str(), view.room_id.as_str())
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
        event_id: view.event_id.as_ref().map(ToString::to_string),
    }
}

fn remember(view: &NotificationView, content: bool) -> Option<Vec<Line>> {
    let fresh = line(view, content);
    let Ok(mut conversations) = CONVERSATIONS.lock() else {
        return Some(vec![fresh]);
    };

    let lines = conversations
        .entry(conversation_key(
            view.user_id.as_str(),
            view.room_id.as_str(),
        ))
        .or_default();
    if !content {
        for line in lines.iter_mut() {
            "New message".clone_into(&mut line.body);
        }
    }
    if fresh.event_id.is_some() && lines.iter().any(|line| line.event_id == fresh.event_id) {
        return None;
    }
    lines.push(fresh);
    if lines.len() > MAX_CONVERSATION_LINES {
        lines.drain(..lines.len() - MAX_CONVERSATION_LINES);
    }
    Some(lines.clone())
}

pub(super) fn forget(user_id: &str, room_id: &str) {
    if let Ok(mut conversations) = CONVERSATIONS.lock() {
        conversations.remove(&conversation_key(user_id, room_id));
    }
    if let Ok(mut alerted) = ALERTED.lock() {
        alerted.remove(&conversation_key(user_id, room_id));
    }
}

fn cooling(view: &NotificationView, now: Instant) -> bool {
    if view.mention || view.noisy != Some(false) {
        return false;
    }
    let Ok(mut alerted) = ALERTED.lock() else {
        return false;
    };
    let key = conversation_key(view.user_id.as_str(), view.room_id.as_str());
    let quiet = alerted
        .get(&key)
        .is_some_and(|at| now.saturating_duration_since(*at) < NOTIFY_ONCE_WINDOW);
    if !quiet {
        alerted.insert(key, now);
    }
    quiet
}

fn conversation_message(line: &Line, encrypted: bool) -> Option<NotificationMessage> {
    serde_json::from_value(serde_json::json!({
        "body": line.body,
        "timestamp": line.at,
        "senderName": line.sender_name,
        "senderKey": line.sender_key,
        "eventId": line.event_id,
        "encrypted": encrypted,
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

fn avatar_source(view: &NotificationView) -> Option<&str> {
    let room = view.room_avatar_url.as_deref().filter(|_| !view.is_direct);
    room.or(view.sender_avatar_url.as_deref())
}

/// Desktop notifiers only show a local image, so the thumbnail is kept in the cache folder.
async fn avatar_file<R: Runtime>(
    app: &AppHandle<R>,
    core: &sable_core::Core,
    view: &NotificationView,
) -> Option<tauri::Url> {
    use std::hash::{Hash as _, Hasher as _};

    let source = avatar_source(view)?;
    let directory = app.path().app_cache_dir().ok()?.join(AVATAR_DIR);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    source.hash(&mut hasher);
    let path = directory.join(format!("{:016x}.img", hasher.finish()));
    if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
        let bytes = core
            .fetch_media(source.to_owned(), AVATAR_SIZE, AVATAR_SIZE, true)
            .await
            .map_err(|error| log::debug!("could not fetch a notification avatar: {error:?}"))
            .ok()?;
        let saved = match tokio::fs::create_dir_all(&directory).await {
            Ok(()) => tokio::fs::write(&path, bytes).await,
            Err(error) => Err(error),
        };
        saved
            .map_err(|error| log::debug!("could not cache a notification avatar: {error}"))
            .ok()?;
    }
    tauri::Url::from_file_path(&path).ok()
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

pub(super) async fn show_generic<R: Runtime>(
    app: &AppHandle<R>,
    core: &sable_core::Core,
    view: &NotificationView,
) {
    let content = shows_content(
        view.encrypted,
        core.notification_content(),
        core.notification_encrypted_content(),
    );
    let Some(lines) = remember(view, content) else {
        return;
    };

    let mut builder = app
        .notifications()
        .builder()
        .id(super::room_notification_id(
            view.user_id.as_str(),
            view.room_id.as_str(),
        ))
        .title(view.room_name.clone())
        .body(body(view, content))
        .channel_id(MESSAGES_CHANNEL)
        .group(group_key(view))
        .group_conversation(!view.is_direct)
        .auto_cancel()
        .extra("user_id", view.user_id.as_str())
        .extra("room_id", view.room_id.as_str());

    if let Some(event_id) = &view.event_id {
        builder = builder
            .action_type_id(MESSAGE_ACTIONS)
            .extra("event_id", event_id.as_str());
    }

    if let Some(avatar) = avatar_file(app, core, view).await {
        builder = builder.attachment(Attachment::new("avatar", avatar));
    }

    builder = builder.only_alert_once(core.notify_once() && cooling(view, Instant::now()));
    if !core.notification_sounds() {
        builder = builder.silent();
    }
    if lines.len() > 1 {
        builder = builder.large_body(collapsed(&lines));
    }
    for line in &lines {
        if let Some(message) = conversation_message(line, view.encrypted) {
            builder = builder.message(message);
        }
    }

    if let Err(error) = builder.show().await {
        log::warn!("could not show a notification: {error}");
    }
}

pub(super) async fn remove_posted<R: Runtime>(app: &AppHandle<R>, ids: Vec<i32>) {
    #[cfg(mobile)]
    let dismissed = app.notifications().remove_active(ids).await;
    #[cfg(not(mobile))]
    let dismissed = app.notifications().remove_active(ids);

    if let Err(error) = dismissed {
        log::debug!("could not dismiss a notification: {error}");
    }
}

#[cfg(test)]
mod tests {
    use sable_core::protocol::NotificationView;

    use super::{
        Line, MAX_CONVERSATION_LINES, MESSAGE_ACTIONS, NOTIFY_ONCE_WINDOW, avatar_source, body,
        collapsed, cooling, forget, remember, shows_content,
    };

    fn view(is_direct: bool) -> NotificationView {
        NotificationView {
            user_id: "@me:example.org".parse().expect("a user id"),
            room_id: "!room:example.org".parse().expect("a room id"),
            event_id: Some("$event".parse().expect("an event id")),
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
    fn a_room_shows_its_picture_and_a_dm_its_sender() {
        let pictured = |is_direct, room: Option<&str>| NotificationView {
            room_avatar_url: room.map(str::to_owned),
            sender_avatar_url: Some("mxc://example.org/ada".to_owned()),
            ..view(is_direct)
        };
        assert_eq!(
            avatar_source(&pictured(false, Some("mxc://example.org/room"))),
            Some("mxc://example.org/room")
        );
        assert_eq!(
            avatar_source(&pictured(false, None)),
            Some("mxc://example.org/ada")
        );
        assert_eq!(
            avatar_source(&pictured(true, Some("mxc://example.org/room"))),
            Some("mxc://example.org/ada")
        );
    }

    #[test]
    fn a_hidden_body_names_the_sender_but_not_the_message() {
        assert_eq!(body(&view(false), true), "Ada: shipped the patch");
        assert_eq!(body(&view(true), true), "shipped the patch");
        assert_eq!(body(&view(false), false), "New message from Ada");
        assert_eq!(body(&view(true), false), "New message");
    }

    fn in_room(room: &str) -> NotificationView {
        NotificationView {
            room_id: room.parse().expect("a room id"),
            ..view(false)
        }
    }

    fn at_event(view: &NotificationView, event: &str) -> NotificationView {
        NotificationView {
            event_id: Some(event.parse().expect("an event id")),
            ..view.clone()
        }
    }

    #[test]
    fn a_quiet_room_alerts_again_once_the_notify_once_window_has_passed() {
        let quiet = NotificationView {
            noisy: Some(false),
            ..in_room("!cooling:example.org")
        };
        let start = std::time::Instant::now();

        assert!(!cooling(&quiet, start));
        assert!(cooling(&quiet, start + NOTIFY_ONCE_WINDOW / 2));
        assert!(!cooling(&quiet, start + NOTIFY_ONCE_WINDOW));
        assert!(cooling(
            &quiet,
            start + NOTIFY_ONCE_WINDOW + NOTIFY_ONCE_WINDOW / 2
        ));
        forget(quiet.user_id.as_str(), quiet.room_id.as_str());
        assert!(!cooling(
            &quiet,
            start + NOTIFY_ONCE_WINDOW + NOTIFY_ONCE_WINDOW / 2
        ));
        forget(quiet.user_id.as_str(), quiet.room_id.as_str());
    }

    #[test]
    fn a_ringing_rule_or_a_mention_is_never_quieted() {
        let room = in_room("!loud:example.org");
        let mention = NotificationView {
            noisy: Some(false),
            mention: true,
            ..room.clone()
        };
        let start = std::time::Instant::now();

        assert!(!cooling(&room, start));
        assert!(!cooling(&room, start));
        assert!(!cooling(&mention, start));
        assert!(!cooling(&mention, start));
        forget(room.user_id.as_str(), room.room_id.as_str());
    }

    #[test]
    fn a_conversation_keeps_the_newest_lines() {
        let view = in_room("!trimmed:example.org");
        for index in 0..=MAX_CONVERSATION_LINES {
            remember(&at_event(&view, &format!("$trim{index}")), true);
        }

        let lines = remember(&at_event(&view, "$trim-last"), true).expect("a fresh line");
        assert_eq!(lines.len(), MAX_CONVERSATION_LINES);
        forget(view.user_id.as_str(), view.room_id.as_str());
    }

    #[test]
    fn reading_the_room_empties_its_conversation() {
        let view = in_room("!read:example.org");
        remember(&at_event(&view, "$read-one"), true);
        remember(&at_event(&view, "$read-two"), true);
        forget(view.user_id.as_str(), view.room_id.as_str());

        assert_eq!(remember(&view, true).expect("a fresh line").len(), 1);
        forget(view.user_id.as_str(), view.room_id.as_str());
    }

    #[test]
    fn one_event_notified_twice_is_alerted_once() {
        let view = in_room("!repeat:example.org");
        assert_eq!(remember(&view, true).map(|lines| lines.len()), Some(1));
        assert!(remember(&view, true).is_none());
        forget(view.user_id.as_str(), view.room_id.as_str());
    }

    #[test]
    fn a_hidden_body_reaches_the_conversation_too() {
        let view = in_room("!hidden:example.org");
        let lines = remember(&view, false).expect("a fresh line");

        assert_eq!(collapsed(&lines), "Ada: New message");
        forget(view.user_id.as_str(), view.room_id.as_str());
    }

    #[test]
    fn disabling_previews_scrubs_previous_conversation_messages() {
        for (room, encrypted) in [
            ("!privacy:example.org", false),
            ("!encrypted-privacy:example.org", true),
        ] {
            let mut view = in_room(room);
            view.encrypted = encrypted;
            remember(&at_event(&view, "$privacy-one"), true);
            let content = shows_content(encrypted, encrypted, false);
            let lines = remember(&at_event(&view, "$privacy-two"), content).expect("a fresh line");
            assert!(lines.iter().all(|line| line.body == "New message"));
            let lines = remember(&at_event(&view, "$privacy-three"), true).expect("a fresh line");
            assert_eq!(lines[0].body, "New message");
            forget(view.user_id.as_str(), view.room_id.as_str());
        }
    }

    #[test]
    fn every_line_names_its_sender() {
        let lines = vec![
            Line {
                sender_name: "Ada".to_owned(),
                sender_key: "@ada:example.org".to_owned(),
                body: "one".to_owned(),
                at: 0,
                event_id: None,
            },
            Line {
                sender_name: "Bo".to_owned(),
                sender_key: "@bo:example.org".to_owned(),
                body: "two".to_owned(),
                at: 1,
                event_id: None,
            },
        ];

        assert_eq!(collapsed(&lines), "Ada: one\nBo: two");
    }

    #[test]
    fn a_native_conversation_message_carries_its_event_identity() {
        let message = super::conversation_message(
            &Line {
                sender_name: "Ada".to_owned(),
                sender_key: "@ada:example.org".to_owned(),
                body: "hello".to_owned(),
                at: 1,
                event_id: Some("$event".to_owned()),
            },
            true,
        )
        .expect("a native conversation message");
        let wire = serde_json::to_value(message).expect("the plugin message is serializable");

        assert_eq!(wire["eventId"], "$event");
        assert_eq!(wire["encrypted"], true);
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
            serde_json::from_str(include_str!("../../tauri.conf.json")).expect("a Tauri config");
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

        let mark_read = category
            .actions()
            .iter()
            .find(|action| action.id() == "sable-mark-read")
            .expect("a mark-as-read action");

        assert!(!mark_read.foreground());
    }
}
