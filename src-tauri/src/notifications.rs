use sable_core::protocol::{CommandErr, NotificationView};
#[cfg(any(mobile, test))]
use sable_core::protocol::{WebPushKeys, WebPusherView};
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
    if hash == i32::MIN { 0 } else { hash.abs() }
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
    event_id: Option<String>,
}

static CONVERSATIONS: LazyLock<Mutex<HashMap<String, Vec<Line>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

static PUSH_REGISTRATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct RegisteredPusher {
    user_id: String,
    device_id: String,
    pushkey: String,
    app_id: String,
    #[serde(default)]
    gateway: Option<String>,
    #[serde(default)]
    event_id_only: bool,
}

fn push_store<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, CommandErr> {
    use tauri::Manager;
    app.try_state::<PushStore>()
        .map(|store| store.0.clone())
        .ok_or(CommandErr::Unavailable)
}

pub struct PushStore(pub std::path::PathBuf);

fn registered_pushers(root: &std::path::Path) -> Result<Vec<RegisteredPusher>, CommandErr> {
    match std::fs::read(root.join("pushers.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| CommandErr::Unavailable),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(CommandErr::Unavailable),
    }
}

fn save_pushers(root: &std::path::Path, pushers: &[RegisteredPusher]) -> Result<(), CommandErr> {
    std::fs::create_dir_all(root).map_err(|_| CommandErr::Unavailable)?;
    let bytes = serde_json::to_vec(pushers).map_err(|_| CommandErr::Unavailable)?;
    std::fs::write(root.join("pushers.tmp"), bytes).map_err(|_| CommandErr::Unavailable)?;
    std::fs::rename(root.join("pushers.tmp"), root.join("pushers.json"))
        .map_err(|_| CommandErr::Unavailable)
}

async fn remove_saved_pusher(
    root: &std::path::Path,
    pusher: &RegisteredPusher,
) -> Result<(), CommandErr> {
    let client = pusher_client(root, pusher).await?;
    sable_core::notifications::remove_pusher(&client, pusher.pushkey.clone(), pusher.app_id.clone())
        .await
        .map_err(|_| CommandErr::Unavailable)
}

async fn pusher_client(
    root: &std::path::Path,
    pusher: &RegisteredPusher,
) -> Result<sable_core::MatrixClient, CommandErr> {
    use sable_core::store::SessionStore;
    let bytes = sable_core::store::FileSessionStore::new(root)
        .load()
        .await
        .map_err(|_| CommandErr::Unavailable)?
        .ok_or(CommandErr::Unavailable)?;
    let (mut accounts, _) =
        sable_core::session::AccountRegistry::from_bytes(&bytes, &root.to_string_lossy())
            .map_err(|_| CommandErr::Unavailable)?;
    accounts.reanchor_stores(&root.to_string_lossy());
    let account = accounts
        .accounts
        .iter()
        .find(|account| {
            !account.needs_reauth
                && account.session.credentials.user_id() == pusher.user_id
                && account.session.credentials.device_id() == pusher.device_id
        })
        .ok_or(CommandErr::Unavailable)?;
    sable_core::session::restore_authenticated_client(&account.store_id, &account.session)
        .await
        .map_err(|_| CommandErr::Unavailable)
}

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum BackgroundPush {
    Rotate {
        user_id: String,
        device_id: String,
        endpoint: String,
        p256dh: Option<String>,
        auth: Option<String>,
    },
    Activate {
        app_id: String,
        ack_token: String,
    },
}

#[cfg(target_os = "android")]
pub async fn maintain_background_push(
    root: &std::path::Path,
    operation: BackgroundPush,
) -> Result<(), CommandErr> {
    let _guard = PUSH_REGISTRATION_LOCK.lock().await;
    let pushers = registered_pushers(root)?;
    match operation {
        BackgroundPush::Activate { app_id, ack_token } => {
            let current = pushers
                .iter()
                .rev()
                .find(|pusher| pusher.app_id == app_id)
                .ok_or(CommandErr::Unavailable)?;
            let client = pusher_client(root, current).await?;
            sable_core::webpush::ack(&client, app_id, ack_token)
                .await
                .map_err(|_| CommandErr::Unavailable)
        }
        BackgroundPush::Rotate {
            user_id,
            device_id,
            endpoint,
            p256dh,
            auth,
        } => {
            let known = pushers
                .iter()
                .any(|pusher| pusher.user_id == user_id && pusher.device_id == device_id);
            if !known || !is_unified_push_endpoint(&endpoint) {
                return Err(CommandErr::Unavailable);
            }
            let registration = Registration {
                token: endpoint,
                p256dh,
                auth,
            };
            for pusher in pushers {
                rotate_pusher(root, &pusher, &registration).await?;
            }
            Ok(())
        }
    }
}

#[cfg(target_os = "android")]
async fn rotate_pusher(
    root: &std::path::Path,
    pusher: &RegisteredPusher,
    registration: &Registration,
) -> Result<(), CommandErr> {
    use sable_core::protocol::{PusherView, WebPushKeys};
    let client = pusher_client(root, pusher).await?;
    let pushkey = if let Some(gateway) = &pusher.gateway {
        let key = registration
            .p256dh
            .clone()
            .unwrap_or_else(|| registration.token.clone());
        let web_push = match (&registration.p256dh, &registration.auth) {
            (Some(p256dh), Some(auth)) => Some(WebPushKeys {
                endpoint: registration.token.clone(),
                p256dh: p256dh.clone(),
                auth: auth.clone(),
            }),
            (None, None) => None,
            _ => return Err(CommandErr::Unavailable),
        };
        sable_core::notifications::set_pusher(
            &client,
            PusherView {
                pushkey: key.clone(),
                app_id: pusher.app_id.clone(),
                url: gateway.clone(),
                device_display_name: "Sable on Android".into(),
                web_push,
                event_id_only: pusher.event_id_only,
                append: false,
            },
        )
        .await
        .map_err(|_| CommandErr::Unavailable)?;
        key
    } else {
        let rotated = server_web_pusher(registration, &pusher.app_id, pusher.event_id_only)
            .ok_or(CommandErr::Unavailable)?;
        let key = rotated.pushkey.clone();
        sable_core::webpush::set_pusher(&client, rotated)
            .await
            .map_err(|_| CommandErr::Unavailable)?;
        key
    };
    let identity = (pusher.user_id.clone(), pusher.device_id.clone());
    remember_pusher(
        root,
        &identity,
        pushkey,
        pusher.app_id.clone(),
        pusher.gateway.clone(),
        pusher.event_id_only,
    )?;
    retire_old_pushers(root, &identity).await;
    Ok(())
}

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

const fn alerts_silently(noisy: Option<bool>, sounds: bool) -> bool {
    matches!(noisy, Some(false)) || !sounds
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

fn forget(user_id: &str, room_id: &str) {
    if let Ok(mut conversations) = CONVERSATIONS.lock() {
        conversations.remove(&conversation_key(user_id, room_id));
    }
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
    if !core.notifications_enabled() {
        return;
    }

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
        .id(room_notification_id(
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

    if cfg!(target_os = "android") {
        builder = builder.icon("notification_icon");
    }
    builder = builder.only_alert_once(core.notify_once() && !view.mention);
    if alerts_silently(view.noisy, core.notification_sounds()) {
        builder = builder.silent();
    }
    if lines.len() > 1 {
        builder = builder.large_body(collapsed(&lines));
    }
    // Android retains displayed history in the OS, including cold deliveries.
    let skip = if cfg!(target_os = "android") {
        lines.len().saturating_sub(1)
    } else {
        0
    };
    for line in lines.iter().skip(skip) {
        if let Some(message) = conversation_message(line, view.encrypted) {
            builder = builder.message(message);
        }
    }

    if let Err(error) = builder.show().await {
        log::warn!("could not show a notification: {error}");
    }
}

pub async fn permission<R: Runtime>(app: &AppHandle<R>) -> &'static str {
    grant(app.notifications().permission_state().await)
}

pub async fn request_permission<R: Runtime>(app: &AppHandle<R>) -> &'static str {
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

#[cfg(target_os = "android")]
pub async fn ensure_channel<R: Runtime>(app: &AppHandle<R>) {
    let channel = tauri_plugin_notifications::Channel::builder(MESSAGES_CHANNEL, "Messages")
        .description("Matrix message notifications")
        .importance(tauri_plugin_notifications::Importance::High)
        .visibility(tauri_plugin_notifications::Visibility::Private)
        .vibration(true)
        .build();

    if let Err(error) = app.notifications().create_channel(channel).await {
        log::warn!("could not create the message notification channel: {error}");
    }
}

pub async fn show_test<R: Runtime>(app: &AppHandle<R>, core: &sable_core::Core, sequence: u32) {
    show(app, core, &test_view(sequence)).await;
}

fn test_view(sequence: u32) -> NotificationView {
    NotificationView {
        user_id: owned_user_id!("@sable:notification.test"),
        room_id: owned_room_id!("!notification:notification.test"),
        event_id: Some(owned_event_id!("$notification-test")),
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

#[cfg_attr(desktop, allow(clippy::unused_async))]
pub async fn allow_encrypted_content<R: Runtime>(app: &AppHandle<R>, allowed: bool) {
    #[cfg(mobile)]
    let result = app
        .notifications()
        .set_encrypted_content_allowed(allowed)
        .await;
    #[cfg(desktop)]
    let result = app.notifications().set_encrypted_content_allowed(allowed);
    if let Err(error) = result {
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

#[derive(serde::Deserialize)]
#[cfg_attr(
    not(mobile),
    expect(dead_code, reason = "only a mobile build registers a pusher")
)]
pub struct PushAccount {
    pub user_id: String,
    pub device_id: String,
}

/// Resolved by the webview, so the binary bakes no gateway of its own.
#[derive(serde::Deserialize)]
#[cfg_attr(
    not(mobile),
    expect(dead_code, reason = "only a mobile build registers a pusher")
)]
pub struct PushConfig {
    pub gateway_url: String,
    #[serde(default)]
    pub gateway_override: bool,
    pub vapid_key: String,
    pub web_app_id: String,
    pub event_id_only: bool,
    pub user_id: Option<String>,
    pub device_id: Option<String>,
    #[serde(default)]
    pub accounts: Vec<PushAccount>,
    /// Absent when the reader has retargeted the gateway: a token distributor
    /// needs an app id that gateway serves, and only the deployment names one.
    pub native_app_id: Option<String>,
    #[serde(default)]
    pub ios_app_id: Option<String>,
    #[serde(default)]
    pub unified_push_gateway_url: Option<String>,
    #[serde(default)]
    pub embedded_gateway_url: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
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
        (None, None) if is_unified_push_endpoint(&registration.token) => {
            Some(("moe.sable.up".to_owned(), registration.token, None))
        }
        (None, None) if !registration.token.is_empty() && !registration.token.contains("://") => {
            Some((native_app_id?.to_owned(), registration.token, None))
        }
        _ => None,
    }
}

/// An MSC4174 pusher belongs to the homeserver: its endpoint is the Web Push
/// subscription, never an HTTP push gateway.
#[cfg(any(mobile, test))]
fn server_web_pusher(
    registration: &Registration,
    app_id: &str,
    event_id_only: bool,
) -> Option<WebPusherView> {
    Some(WebPusherView {
        pushkey: registration.p256dh.clone()?,
        app_id: app_id.to_owned(),
        device_display_name: format!("Sable on {}", std::env::consts::OS),
        endpoint: registration.token.clone(),
        auth: registration.auth.clone()?,
        event_id_only,
    })
}

/// Let the platform resolve Auto using its installed distributors and services.
#[cfg(any(mobile, test))]
fn provider_for_server_delivery(
    _server_vapid: Option<&str>,
    provider: Option<&str>,
) -> Option<String> {
    provider.map(str::to_owned)
}

#[cfg(any(mobile, test))]
fn is_unified_push_endpoint(token: &str) -> bool {
    tauri::Url::parse(token).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

#[cfg(any(mobile, test))]
fn registration_gateway<'a>(
    registration: &Registration,
    config: &'a PushConfig,
) -> Option<&'a str> {
    if config.gateway_override {
        return Some(&config.gateway_url);
    }
    if registration.p256dh.is_none()
        && registration.auth.is_none()
        && is_unified_push_endpoint(&registration.token)
    {
        config
            .unified_push_gateway_url
            .as_deref()
            .filter(|url| !url.trim().is_empty())
    } else {
        Some(&config.gateway_url)
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
    let _guard = PUSH_REGISTRATION_LOCK.lock().await;
    let root = push_store(app)?;
    let identity = (
        config.user_id.clone().ok_or(CommandErr::Unavailable)?,
        config.device_id.clone().ok_or(CommandErr::Unavailable)?,
    );
    let accounts = config
        .accounts
        .iter()
        .map(|account| (account.user_id.clone(), account.device_id.clone()))
        .chain(std::iter::once(identity.clone()))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    if let Err(error) = app.notifications().set_push_accounts(accounts).await {
        log::warn!("could not declare the signed-in accounts: {error}");
    }

    // MSC4174 makes the homeserver the push gateway. Query before creating the
    // subscription because the distributor must bind it to the server's VAPID key.
    let server_vapid = if config.gateway_override || cfg!(target_os = "ios") {
        None
    } else {
        server_vapid_from_response(Box::pin(core.dispatch(Command::WebPusherSupport)).await)?
    };
    let registered = app
        .notifications()
        .register_for_push_notifications(
            Some(
                server_vapid
                    .as_deref()
                    .unwrap_or(&config.vapid_key)
                    .to_owned(),
            ),
            provider_for_server_delivery(server_vapid.as_deref(), config.provider.as_deref()),
            config.embedded_gateway_url.clone(),
            config.user_id.clone(),
            config.device_id.clone(),
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
    if server_vapid.is_some() {
        if let Some(pusher) =
            server_web_pusher(&registration, &config.web_app_id, config.event_id_only)
        {
            let pushkey = pusher.pushkey.clone();
            let app_id = pusher.app_id.clone();
            if let Err(error) = Box::pin(core.dispatch(Command::SetWebPusher { pusher })).await {
                log::warn!("homeserver rejected the MSC4174 pusher: {error:?}");
                return Err(error);
            }
            log::debug!("registered an MSC4174 pusher through the homeserver");
            remember_pusher(
                &root,
                &identity,
                pushkey,
                app_id,
                None,
                config.event_id_only,
            )?;
            retire_old_pushers(&root, &identity).await;
            return Ok(());
        }
    }

    let gateway_url = registration_gateway(&registration, &config)
        .ok_or_else(|| {
            log::warn!("no UnifiedPush gateway is configured for this distributor");
            CommandErr::Unavailable
        })?
        .to_owned();

    let Some((app_id, pushkey, web_push)) = pusher(
        registration,
        if cfg!(target_os = "ios") {
            config.ios_app_id.as_deref()
        } else {
            config.native_app_id.as_deref()
        },
        Some(&config.web_app_id),
    ) else {
        return Err(CommandErr::Unavailable);
    };

    let command = Command::SetPusher {
        pusher: PusherView {
            pushkey: pushkey.clone(),
            app_id: app_id.clone(),
            url: gateway_url.clone(),
            device_display_name: format!("Sable on {}", std::env::consts::OS),
            web_push,
            event_id_only: config.event_id_only,
            append: false,
        },
    };

    Box::pin(core.dispatch(command)).await.map(|_| ())?;
    remember_pusher(
        &root,
        &identity,
        pushkey,
        app_id,
        Some(gateway_url),
        config.event_id_only,
    )?;
    retire_old_pushers(&root, &identity).await;
    Ok(())
}

#[cfg(any(mobile, test))]
fn server_vapid_from_response(
    response: Result<sable_core::protocol::CommandOk, CommandErr>,
) -> Result<Option<String>, CommandErr> {
    match response? {
        sable_core::protocol::CommandOk::WebPusherSupport { vapid } => Ok(vapid),
        _ => Err(CommandErr::Unavailable),
    }
}

#[cfg(any(mobile, test))]
fn remember_pusher(
    root: &std::path::Path,
    identity: &(String, String),
    pushkey: String,
    app_id: String,
    gateway: Option<String>,
    event_id_only: bool,
) -> Result<(), CommandErr> {
    let mut pushers = registered_pushers(root)?;
    pushers.retain(|p| {
        !(p.user_id == identity.0
            && p.device_id == identity.1
            && p.pushkey == pushkey
            && p.app_id == app_id)
    });
    pushers.push(RegisteredPusher {
        user_id: identity.0.clone(),
        device_id: identity.1.clone(),
        pushkey,
        app_id,
        gateway,
        event_id_only,
    });
    save_pushers(root, &pushers)
}

#[cfg(any(mobile, test))]
fn stale_pusher(pushers: &[RegisteredPusher], identity: &(String, String)) -> Option<usize> {
    let mut mine = pushers
        .iter()
        .enumerate()
        .filter(|(_, pusher)| pusher.user_id == identity.0 && pusher.device_id == identity.1)
        .map(|(index, _)| index);
    let first = mine.next()?;
    mine.next().map(|_| first)
}

#[cfg(any(mobile, test))]
async fn retire_old_pushers(root: &std::path::Path, identity: &(String, String)) {
    let Ok(mut pushers) = registered_pushers(root) else {
        return;
    };
    loop {
        let Some((index, stale)) = stale_pusher(&pushers, identity)
            .and_then(|index| Some((index, pushers.get(index)?.clone())))
        else {
            return;
        };
        if remove_saved_pusher(root, &stale).await.is_err() {
            return;
        }
        pushers.remove(index);
        if save_pushers(root, &pushers).is_err() {
            return;
        }
    }
}

/// # Errors
///
/// When the homeserver refuses to delete the pusher.
pub async fn unregister_push<R: Runtime>(app: &AppHandle<R>) -> Result<(), CommandErr> {
    let _guard = PUSH_REGISTRATION_LOCK.lock().await;
    #[cfg(mobile)]
    app.notifications()
        .unregister_for_push_notifications()
        .await
        .map_err(|_| CommandErr::Unavailable)?;
    let root = push_store(app)?;
    let mut pushers = registered_pushers(&root)?;
    while let Some(pusher) = pushers.first() {
        remove_saved_pusher(&root, pusher).await?;
        pushers.remove(0);
        save_pushers(&root, &pushers)?;
    }
    Ok(())
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
        Line, MAX_CONVERSATION_LINES, MESSAGE_ACTIONS, Registration, alerts_silently, body,
        collapsed, forget, java_hash, provider_for_server_delivery, pusher, remember,
        room_notification_id, server_web_pusher, shows_content,
    };

    #[test]
    fn failed_capability_lookup_does_not_select_a_fallback_gateway() {
        super::server_vapid_from_response(Err(super::CommandErr::Unavailable)).unwrap_err();
        assert!(matches!(
            super::server_vapid_from_response(Ok(
                sable_core::protocol::CommandOk::WebPusherSupport { vapid: None }
            )),
            Ok(None)
        ));
    }

    #[test]
    fn explicit_gateway_applies_to_direct_unifiedpush_too() {
        let config = serde_json::from_value(serde_json::json!({
            "gateway_url": "https://custom.example/_matrix/push/v1/notify",
            "gateway_override": true,
            "vapid_key": "key",
            "web_app_id": "custom",
            "event_id_only": false,
            "unified_push_gateway_url": "https://default.example/_matrix/push/v1/notify"
        }))
        .expect("push config");
        let registration = Registration {
            token: "https://ntfy.example/endpoint".into(),
            p256dh: None,
            auth: None,
        };
        assert_eq!(
            super::registration_gateway(&registration, &config),
            Some("https://custom.example/_matrix/push/v1/notify")
        );
    }

    #[tokio::test]
    async fn pusher_rotation_survives_restart_and_failed_retirement() {
        let root = std::env::temp_dir().join(format!("sable-pusher-ledger-{}", std::process::id()));
        let identity = ("@alice:example.org".to_owned(), "DEVICE".to_owned());
        for endpoint in ["old", "new", "new"] {
            super::remember_pusher(
                &root,
                &identity,
                endpoint.to_owned(),
                "app".to_owned(),
                None,
                false,
            )
            .expect("persist pusher");
        }
        let saved = super::registered_pushers(&root).expect("reload ledger");
        assert_eq!(saved.len(), 2);
        assert_eq!(saved.last().expect("current pusher").pushkey, "new");
        // No session: deletion must fail without discarding its retry identity.
        super::retire_old_pushers(&root, &identity).await;
        assert_eq!(
            super::registered_pushers(&root)
                .expect("retained ledger")
                .len(),
            2
        );
        std::fs::remove_dir_all(root).expect("remove test ledger");
    }

    #[test]
    fn a_second_account_keeps_its_pusher() {
        let pushers: Vec<super::RegisteredPusher> = serde_json::from_value(serde_json::json!([
            { "user_id": "@alice:example.org", "device_id": "A", "pushkey": "old", "app_id": "app" },
            { "user_id": "@bob:example.org", "device_id": "B", "pushkey": "new", "app_id": "app" },
            { "user_id": "@alice:example.org", "device_id": "A", "pushkey": "new", "app_id": "app" }
        ]))
        .expect("a pusher ledger");
        let alice = ("@alice:example.org".to_owned(), "A".to_owned());
        let bob = ("@bob:example.org".to_owned(), "B".to_owned());
        assert_eq!(super::stale_pusher(&pushers, &alice), Some(0));
        assert_eq!(super::stale_pusher(&pushers, &bob), None);
        assert_eq!(super::stale_pusher(&pushers[1..], &alice), None);
    }

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
    fn a_hidden_body_names_the_sender_but_not_the_message() {
        assert_eq!(body(&view(false), true), "Ada: shipped the patch");
        assert_eq!(body(&view(true), true), "shipped the patch");
        assert_eq!(body(&view(false), false), "New message from Ada");
        assert_eq!(body(&view(true), false), "New message");
    }

    #[test]
    fn only_a_soundless_rule_or_muted_sounds_silences_an_alert() {
        assert!(!alerts_silently(Some(true), true));
        assert!(!alerts_silently(None, true));
        assert!(alerts_silently(Some(false), true));
        assert!(alerts_silently(Some(true), false));
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
    fn a_unified_push_url_is_not_an_fcm_token() {
        let (app_id, pushkey, web_push) = pusher(
            Registration {
                token: "https://ntfy.sh/up123?up=1".to_owned(),
                p256dh: None,
                auth: None,
            },
            Some("moe.sable.client.android"),
            Some("moe.sable.app.sygnal"),
        )
        .expect("UnifiedPush registration");
        assert_eq!(app_id, "moe.sable.up");
        assert_eq!(pushkey, "https://ntfy.sh/up123?up=1");
        assert!(web_push.is_none());
    }

    #[test]
    fn incomplete_keys_and_unsafe_endpoints_are_rejected() {
        for (token, p256dh, auth) in [
            ("https://ntfy.sh/topic", Some("key"), None),
            ("https://ntfy.sh/topic", None, Some("auth")),
            ("http://ntfy.sh/topic", None, None),
            ("https://user:password@ntfy.sh/topic", None, None),
            ("", None, None),
        ] {
            assert!(
                pusher(
                    Registration {
                        token: token.to_owned(),
                        p256dh: p256dh.map(str::to_owned),
                        auth: auth.map(str::to_owned),
                    },
                    Some("native"),
                    Some("web"),
                )
                .is_none()
            );
        }
    }

    #[test]
    fn ntfy_and_webpush_use_their_own_gateways() {
        let mut config: super::PushConfig = serde_json::from_value(serde_json::json!({
            "gateway_url": "https://sygnal.example/_matrix/push/v1/notify",
            "unified_push_gateway_url": "https://ntfy.example/_matrix/push/v1/notify",
            "vapid_key": "key", "web_app_id": "web", "event_id_only": true,
        }))
        .expect("push config");
        let mut registration = Registration {
            token: "https://ntfy.example/topic".to_owned(),
            p256dh: None,
            auth: None,
        };
        assert_eq!(
            super::registration_gateway(&registration, &config),
            config.unified_push_gateway_url.as_deref()
        );
        config.unified_push_gateway_url = None;
        assert!(super::registration_gateway(&registration, &config).is_none());
        registration.p256dh = Some("key".to_owned());
        registration.auth = Some("auth".to_owned());
        assert_eq!(
            super::registration_gateway(&registration, &config),
            Some(config.gateway_url.as_str())
        );
        registration.token = "fcm-token".to_owned();
        registration.p256dh = None;
        registration.auth = None;
        assert_eq!(
            super::registration_gateway(&registration, &config),
            Some(config.gateway_url.as_str())
        );
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
        assert!(
            pusher(
                Registration {
                    token: "fcm-token".to_owned(),
                    p256dh: None,
                    auth: None,
                },
                None,
                Some("moe.sable.app.sygnal"),
            )
            .is_none()
        );
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

    #[test]
    fn msc4174_uses_the_distributor_subscription_without_a_gateway() {
        let registration = Registration {
            token: "https://push.example/subscription".to_owned(),
            p256dh: Some("public-key".to_owned()),
            auth: Some("auth-secret".to_owned()),
        };

        let pusher = server_web_pusher(&registration, "org.example.sable", true)
            .expect("web push keys create an MSC4174 pusher");
        assert_eq!(pusher.pushkey, "public-key");
        assert_eq!(pusher.endpoint, registration.token);
        assert_eq!(pusher.auth, "auth-secret");
        assert_eq!(pusher.app_id, "org.example.sable");
        assert!(pusher.event_id_only);
    }

    #[test]
    fn msc4174_auto_preserves_platform_provider_selection() {
        assert_eq!(
            provider_for_server_delivery(Some("server-key"), None).as_deref(),
            None
        );
        assert_eq!(
            provider_for_server_delivery(Some("server-key"), Some("auto")).as_deref(),
            Some("auto")
        );
        assert_eq!(
            provider_for_server_delivery(Some("server-key"), Some("unifiedpush")).as_deref(),
            Some("unifiedpush")
        );
        assert_eq!(provider_for_server_delivery(None, None), None);
    }
}
