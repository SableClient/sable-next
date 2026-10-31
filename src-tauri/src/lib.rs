#![recursion_limit = "512"]

//! The native carrier. A feature adds an RPC handler in `sable_core::api`, except to move bytes or reach something only this process has.

#[cfg(target_os = "android")]
mod android_secrets;
#[cfg(target_os = "android")]
mod cold_push;
#[cfg(target_os = "ios")]
// Objective-C bindings expose PhotoKit calls as unsafe; keep that exception out
// of the Rust-only application code.
#[expect(unsafe_code, reason = "FFI call")]
mod ios;
mod map_tiles;
#[cfg(target_os = "android")]
mod mobile;
#[cfg(mobile)]
mod network;
mod notifications;
mod sentry;
mod share_inbox;
mod v1_migration;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use sable_core::{
    Core,
    protocol::{CoreEvent, RpcError},
};
use tauri::{
    AppHandle, Manager, State,
    ipc::{Channel, InvokeBody, Request, Response},
};
use tauri_plugin_opener::OpenerExt;

struct AppState {
    core: Arc<Core>,
    event_sink: Arc<EventSink>,
}

/// Most events one `Channel::send` carries: on Android each in-flight send pins a JNI global reference, and 51200 abort the app.
const EVENT_BATCH_LIMIT: usize = 256;

const EVENT_BACKLOG_LIMIT: usize = 4096;

#[derive(Default)]
struct EventSink(Mutex<SinkState>);

#[derive(Default)]
struct SinkState {
    channel: Option<Channel<Vec<CoreEvent>>>,
    backlog: Vec<CoreEvent>,
}

impl EventSink {
    fn replace(&self, channel: Channel<Vec<CoreEvent>>) -> bool {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut pending = std::mem::take(&mut state.backlog);
        while !pending.is_empty() {
            let tail = pending.split_off(pending.len().min(EVENT_BATCH_LIMIT));
            let _ = channel.send(std::mem::replace(&mut pending, tail));
        }
        state.channel.replace(channel).is_some()
    }

    fn send(&self, events: Vec<CoreEvent>) {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(channel) = state.channel.clone() {
            drop(state);
            let _ = channel.send(events);
        } else if state.backlog.len() < EVENT_BACKLOG_LIMIT {
            state.backlog.extend(events);
        }
    }
}

#[tauri::command]
async fn call(
    state: State<'_, AppState>,
    method: String,
    params: Box<serde_json::value::RawValue>,
) -> Result<Box<serde_json::value::RawValue>, RpcError> {
    Box::pin(state.core.call(&method, params.get())).await
}

#[tauri::command]
async fn fetch_media(
    state: State<'_, AppState>,
    source: String,
    width: u32,
    height: u32,
    background: Option<bool>,
) -> Result<Response, RpcError> {
    let bytes = state
        .core
        .fetch_media(source, width, height, background.unwrap_or(false))
        .await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
async fn forget_media(state: State<'_, AppState>, source: String) -> Result<(), RpcError> {
    state.core.forget_media(source).await
}

pub(crate) fn decode_header(request: &Request<'_>, name: &str) -> Option<String> {
    let value = request.headers().get(name)?.to_str().ok()?;
    decode_header_value(value)
}

#[tauri::command]
async fn import_persona_avatar(
    state: State<'_, AppState>,
    url: String,
) -> Result<String, RpcError> {
    state.core.import_persona_avatar(url).await
}

fn decode_header_value(value: &str) -> Option<String> {
    Some(
        percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .ok()?
            .into_owned(),
    )
}

#[derive(serde::Deserialize)]
struct Base64Invoke {
    bytes: String,
    headers: HashMap<String, String>,
}

trait Carried {
    fn header(&self, name: &str) -> Option<String>;
    fn bytes(&self) -> Result<Vec<u8>, RpcError>;

    fn metadata<T: serde::de::DeserializeOwned>(&self) -> Result<T, RpcError> {
        self.header("request")
            .and_then(|json| serde_json::from_str(&json).ok())
            .ok_or(RpcError::InvalidMedia)
    }
}

impl Carried for Base64Invoke {
    fn bytes(&self) -> Result<Vec<u8>, RpcError> {
        STANDARD
            .decode(&self.bytes)
            .map_err(|_| RpcError::InvalidMedia)
    }

    fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .and_then(|value| decode_header_value(value))
    }
}

impl Carried for Request<'_> {
    fn header(&self, name: &str) -> Option<String> {
        decode_header(self, name)
    }

    fn bytes(&self) -> Result<Vec<u8>, RpcError> {
        let InvokeBody::Raw(bytes) = self.body() else {
            return Err(RpcError::InvalidMedia);
        };
        Ok(bytes.clone())
    }
}

async fn carried_attachment(
    core: &sable_core::Core,
    request: &impl Carried,
) -> Result<(), RpcError> {
    core.send_attachment(request.metadata()?, request.bytes()?)
        .await
}

async fn carried_upload(
    core: &sable_core::Core,
    request: &impl Carried,
) -> Result<String, RpcError> {
    let mime = request.header("mime").ok_or(RpcError::InvalidMedia)?;
    core.upload_media(mime, request.bytes()?).await
}

async fn carried_gallery(core: &sable_core::Core, request: &impl Carried) -> Result<(), RpcError> {
    core.send_gallery(request.metadata()?, request.bytes()?)
        .await
}

#[tauri::command]
async fn send_gallery(state: State<'_, AppState>, request: Request<'_>) -> Result<(), RpcError> {
    carried_gallery(&state.core, &request).await
}

#[tauri::command]
async fn send_gallery_base64(
    state: State<'_, AppState>,
    request: Base64Invoke,
) -> Result<(), RpcError> {
    carried_gallery(&state.core, &request).await
}

#[tauri::command]
async fn send_attachment(state: State<'_, AppState>, request: Request<'_>) -> Result<(), RpcError> {
    carried_attachment(&state.core, &request).await
}

/// Returns the `mxc:` URI.
#[tauri::command]
async fn upload_media(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<String, RpcError> {
    carried_upload(&state.core, &request).await
}

#[tauri::command]
async fn send_attachment_base64(
    state: State<'_, AppState>,
    request: Base64Invoke,
) -> Result<(), RpcError> {
    carried_attachment(&state.core, &request).await
}

#[tauri::command]
const fn has_geolocation() -> bool {
    cfg!(feature = "geolocation")
}

#[tauri::command]
async fn upload_media_base64(
    state: State<'_, AppState>,
    request: Base64Invoke,
) -> Result<String, RpcError> {
    carried_upload(&state.core, &request).await
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri extracts command state by value"
)]
fn subscribe_events(state: State<'_, AppState>, channel: Channel<Vec<CoreEvent>>) {
    if state.event_sink.replace(channel) {
        let core = state.core.clone();
        tauri::async_runtime::spawn(async move { core.end_all_calls().await });
    }
}

#[tauri::command]
async fn register_push(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    config: notifications::PushConfig,
) -> Result<(), notifications::PushRegistrationError> {
    let core = state.core.clone();
    Box::pin(notifications::register_push(&app, &core, config)).await
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri extracts command state by value"
)]
fn device_pusher(
    app: AppHandle<tauri::Wry>,
    user_id: String,
    device_id: String,
) -> Result<Option<notifications::DevicePusher>, RpcError> {
    notifications::device_pusher(&app, &user_id, &device_id)
}

#[tauri::command]
async fn unregister_push(app: AppHandle<tauri::Wry>) -> Result<(), RpcError> {
    Box::pin(notifications::unregister_push(&app)).await
}

#[tauri::command]
async fn test_notification(
    app: AppHandle<tauri::Wry>,
    state: State<'_, AppState>,
    sequence: u32,
) -> Result<(), RpcError> {
    let core = state.core.clone();
    notifications::show_test(&app, &core, sequence).await;
    Ok(())
}

#[tauri::command]
#[expect(
    clippy::fn_params_excessive_bools,
    clippy::too_many_arguments,
    reason = "notification preference command arguments"
)]
async fn set_notification_encrypted_content(
    app: AppHandle<tauri::Wry>,
    allowed: bool,
    content: bool,
    enabled: bool,
    sounds: bool,
    notify_once: bool,
    clear_on_read: bool,
    private_receipts: bool,
    quiet_when_active_elsewhere: bool,
) -> Result<(), RpcError> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_sable_push::SablePushExt;
        app.sable_push()
            .set_policy(tauri_plugin_sable_push::Policy {
                enabled,
                content,
                encrypted_content: allowed,
                sounds,
                notify_once,
                clear_on_read,
                private_receipts,
                quiet_when_active_elsewhere,
            })
            .await
            .map_err(|_| RpcError::Unavailable)?;
    }
    #[cfg(target_os = "ios")]
    ios::write_push_policy(
        enabled,
        content,
        allowed,
        sounds,
        notify_once,
        clear_on_read,
        quiet_when_active_elsewhere,
    )
    .map_err(|_| RpcError::Unavailable)?;
    #[cfg(not(target_os = "android"))]
    let _ = (&app, private_receipts);
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let _ = (
        allowed,
        content,
        enabled,
        sounds,
        notify_once,
        clear_on_read,
        quiet_when_active_elsewhere,
    );
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn install_keyring(app: &tauri::App<tauri::Wry>) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    let (service, group) = {
        let _ = app;
        let group = ios::keychain_group()?;
        (group.clone(), Some(group))
    };
    #[cfg(not(target_os = "ios"))]
    let (service, group) = (app.config().identifier.clone(), None::<String>);
    sable_core::secrets::install_os_keyring(service, group.as_deref())
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
fn refuse_without_keyring(app: &tauri::App<tauri::Wry>, error: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    log::error!("no usable credential store: {error}");
    let handle = app.handle().clone();
    app.dialog()
        .message(format!(
            "Sable keeps your login and message keys in the system keyring, and none is available.\n\n\
             On Linux, install and unlock a Secret Service provider such as GNOME Keyring or KWallet, \
             then start Sable again.\n\n{error}"
        ))
        .title("No system keyring")
        .kind(MessageDialogKind::Error)
        .show(move |_| handle.exit(1));
}

fn setup(app: &mut tauri::App<tauri::Wry>) -> Result<(), Box<dyn std::error::Error>> {
    // Before any window, so no page asks a core that never started.
    #[cfg(not(target_os = "android"))]
    if let Err(error) = install_keyring(app) {
        refuse_without_keyring(app, &error);
        return Ok(());
    }
    for config in &app.config().app.windows {
        let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?;
        #[cfg(target_os = "android")]
        let builder = builder.on_navigation(|url| url.as_str().parse::<tauri::http::Uri>().is_ok());
        builder.build()?;
    }

    let data_dir = app.path().app_data_dir()?;
    // Android resolves that to the app data root, which the app
    // itself may not write to; only `files` under it.
    #[cfg(target_os = "android")]
    let data_dir = data_dir.join("files");
    #[cfg(target_os = "ios")]
    let data_dir = {
        let shared = ios::shared_store_dir().map_err(std::io::Error::other)?;
        // Do not silently abandon an older installation's credentials or SDK store.
        if !shared.join("session.json").try_exists()?
            && data_dir.join("session.json").try_exists()?
        {
            log::warn!(
                "Keeping the existing private iOS session; cold previews require signing in with shared storage"
            );
            data_dir
        } else {
            shared
        }
    };
    app.manage(notifications::PushStore(data_dir.clone()));
    let (core, events) = Core::new(
        data_dir.to_string_lossy().into_owned(),
        session_store(&data_dir),
    );
    let event_sink = Arc::new(EventSink::default());
    #[cfg(target_os = "ios")]
    follow_ios_lifecycle(&core);
    #[cfg(mobile)]
    network::attach(&core);
    let pushing = core.clone();
    #[cfg(target_os = "android")]
    let _ = cold_push::CORE.set(core.clone());
    #[cfg(target_os = "android")]
    mobile::attach_activity(&core);
    tauri::async_runtime::spawn(restore_ahead_of_webview(core.clone()));
    app.manage(AppState {
        core,
        event_sink: event_sink.clone(),
    });
    spawn_event_pump(app.handle().clone(), pushing, events, event_sink);

    #[cfg(target_os = "ios")]
    if let Some(window) = app.get_webview_window("main") {
        ios::hide_form_accessory_bar(&window);
    }

    map_tiles::cleanup_cache(app.handle());

    Ok(())
}

#[cfg(mobile)]
const SYNC_STOP_DELAY: std::time::Duration = std::time::Duration::from_secs(3);

#[cfg(target_os = "ios")]
fn follow_ios_lifecycle(core: &Arc<Core>) {
    use std::cell::RefCell;

    if ios::in_background() {
        set_mobile_activity(core.clone(), false);
    }
    let core = core.clone();
    let preparation = RefCell::new(None);
    ios::observe_lifecycle(move |change| match change {
        ios::Lifecycle::ResignActive => {
            preparation
                .borrow_mut()
                .get_or_insert_with(|| ios::BackgroundTask::begin("Prepare sync pause"));
        }
        ios::Lifecycle::EnterBackground => {
            let _preparation = preparation.borrow_mut().take();
            set_mobile_activity(core.clone(), false);
        }
        ios::Lifecycle::EnterForeground => {
            preparation.borrow_mut().take();
            set_mobile_activity(core.clone(), true);
        }
        ios::Lifecycle::BecomeActive => {
            preparation.borrow_mut().take();
        }
    });
}

/// A mobile OS never runs two copies of the app, and iOS kills a suspended app that
/// still holds a file lock in the shared App Group container.
fn session_store(data_dir: &std::path::Path) -> Box<dyn sable_core::store::SessionStore> {
    Box::new(sable_core::store::FileSessionStore::new(data_dir))
}

#[cfg(mobile)]
fn set_mobile_activity(core: Arc<Core>, active: bool) {
    let revision = core.set_app_active(active);
    #[cfg(target_os = "ios")]
    let background_task = (!active).then(|| ios::BackgroundTask::begin("Pause sync"));
    let stop_delay = SYNC_STOP_DELAY;
    #[cfg(target_os = "ios")]
    let stop_delay = if background_task
        .as_ref()
        .is_some_and(|task| !task.is_active())
    {
        std::time::Duration::ZERO
    } else {
        stop_delay
    };
    tauri::async_runtime::spawn(async move {
        if !active {
            tokio::time::sleep(stop_delay).await;
        }
        core.apply_app_activity_if_current(active, revision).await;
        #[cfg(target_os = "ios")]
        drop(background_task);
    });
}

#[tauri::command]
async fn notification_permission(app: AppHandle<tauri::Wry>) -> &'static str {
    notifications::permission(&app).await
}

#[tauri::command]
async fn request_notification_permission(app: AppHandle<tauri::Wry>) -> &'static str {
    notifications::request_permission(&app).await
}

#[tauri::command]
async fn dismiss_room_notifications(
    app: AppHandle<tauri::Wry>,
    user_id: String,
    room_ids: Vec<String>,
) {
    notifications::dismiss(&app, &user_id, &room_ids).await;
}

#[tauri::command]
async fn set_open_conversation(
    app: AppHandle<tauri::Wry>,
    user_id: Option<String>,
    room_id: Option<String>,
) {
    #[cfg(target_os = "android")]
    notifications::set_open_conversation(&app, user_id.as_deref(), room_id.as_deref()).await;
    #[cfg(not(target_os = "android"))]
    let _ = (app, user_id, room_id);
}

#[tauri::command]
async fn forget_left_conversations(app: AppHandle<tauri::Wry>) {
    #[cfg(target_os = "android")]
    {
        let core = app.state::<AppState>().core.clone();
        notifications::forget_left_conversations(&app, &core).await;
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
}

#[tauri::command]
async fn dismiss_read_room_notifications(
    app: AppHandle<tauri::Wry>,
    user_id: String,
    room_ids: Vec<String>,
) {
    notifications::dismiss_read(&app, &user_id, &room_ids).await;
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri extracts command inputs by value"
)]
fn open_external_url(app: AppHandle<tauri::Wry>, url: String) -> Result<(), RpcError> {
    let parsed = tauri::Url::parse(&url).map_err(|_| RpcError::Denied)?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto" | "tel") {
        return Err(RpcError::Denied);
    }

    app.opener()
        .open_url(parsed.to_string(), None::<String>)
        .map_err(|_| RpcError::Unavailable)
}

async fn restore_ahead_of_webview(core: Arc<Core>) {
    if !matches!(core.v1_migration_complete().await, Ok(true)) {
        return;
    }
    if let Err(error) = Box::pin(core.run(sable_core::api::session::RestoreParams {})).await {
        log::warn!("Early session restore failed: {error:?}");
    }
}

fn spawn_event_pump<R: tauri::Runtime>(
    notifier: AppHandle<R>,
    pushing: Arc<Core>,
    mut events: tokio::sync::mpsc::UnboundedReceiver<CoreEvent>,
    event_sink: Arc<EventSink>,
) {
    tauri::async_runtime::spawn(async move {
        let mut batch = Vec::new();
        while events.recv_many(&mut batch, EVENT_BATCH_LIMIT).await > 0 {
            let showing: Vec<_> = batch
                .iter()
                .filter_map(|event| match event {
                    CoreEvent::Notification { notification } => Some(notification.clone()),
                    _ => None,
                })
                .collect();
            event_sink.send(std::mem::take(&mut batch));

            if showing.is_empty() {
                continue;
            }
            let notifier = notifier.clone();
            let pushing = pushing.clone();
            tauri::async_runtime::spawn(async move {
                for notification in showing {
                    notifications::show(&notifier, &pushing, &notification).await;
                }
            });
        }
    });
}

/// Silences two SDK sites that log once per room per sync response.
fn install_logging() {
    use tracing_subscriber::prelude::*;

    let filter = tracing_subscriber::EnvFilter::try_from_env("SABLE_LOG").unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new(
            "info,matrix_sdk_base::room::display_name=error,matrix_sdk::latest_events=off,matrix_sdk::http_client=off",
        )
    });
    let sentry = ::sentry::integrations::tracing::layer()
        .event_filter(sentry::tracing_filter)
        .span_filter(|_| false);
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_filter(filter))
        .with(sentry);
    if let Err(error) = subscriber.try_init() {
        eprintln!("could not install the log subscriber: {error}");
    }
}

#[cfg(mobile)]
fn with_platform_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let builder = builder
        .plugin(tauri_plugin_app_icon::init())
        .plugin(tauri_plugin_edge_to_edge::init())
        .plugin(tauri_plugin_livekit_mobile::init());

    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_auth_session::init());

    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_sable_push::init());

    #[cfg(feature = "geolocation")]
    let builder = builder.plugin(tauri_plugin_geolocation::init());

    let builder = builder.plugin(tauri_plugin_sharekit::init());

    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_fs::init());

    builder
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[expect(
    clippy::too_many_lines,
    reason = "the platform-specific builder remains together"
)]
pub fn run() {
    // Before the threads Tauri spawns, so they inherit the panic handler.
    let sentry_guard = sentry::init();
    install_logging();

    let builder = tauri::Builder::<tauri::Wry>::new();
    #[cfg(target_os = "ios")]
    let builder = builder.on_web_content_process_terminate(|webview| {
        tracing::error!("webview content process terminated");
        // WebKit leaves the page blank until reloaded.
        if let Err(error) = webview.reload() {
            tracing::error!(%error, "webview reload failed");
        }
    });
    let builder = if let Some(client) = sentry_guard.as_ref() {
        builder.plugin(tauri_plugin_sentry::init_with_no_injection(client))
    } else {
        builder
    };

    #[cfg(mobile)]
    let builder = with_platform_plugins(builder);

    let app = match builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notifications::init())
        .register_asynchronous_uri_scheme_protocol(map_tiles::TILE_URI_SCHEME, map_tiles::respond)
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            v1_migration::v1_migration_complete,
            v1_migration::begin_v1_migration,
            v1_migration::import_v1_crypto_batch,
            v1_migration::finish_v1_migration,
            v1_migration::skip_v1_migration,
            call,
            subscribe_events,
            fetch_media,
            forget_media,
            import_persona_avatar,
            send_attachment,
            send_gallery,
            send_gallery_base64,
            send_attachment_base64,
            upload_media,
            upload_media_base64,
            open_external_url,
            register_push,
            unregister_push,
            device_pusher,
            dismiss_room_notifications,
            forget_left_conversations,
            set_open_conversation,
            dismiss_read_room_notifications,
            notification_permission,
            request_notification_permission,
            test_notification,
            set_notification_encrypted_content,
            share_inbox::share_inbox_drain,
            share_inbox::share_inbox_read,
            share_inbox::share_inbox_clear,
            sentry::set_native_sentry_enabled,
            has_geolocation,
            #[cfg(target_os = "ios")]
            ios::save_media_to_photos,
            #[cfg(target_os = "ios")]
            ios::open_in_app_auth_url,
            #[cfg(target_os = "ios")]
            ios::close_in_app_auth_window,
            #[cfg(target_os = "android")]
            mobile::open_in_app_auth_url,
            #[cfg(target_os = "android")]
            mobile::close_in_app_auth_window,
            #[cfg(target_os = "ios")]
            ios::haptic_feedback,
            #[cfg(target_os = "ios")]
            ios::set_system_bars_hidden,
            #[cfg(target_os = "android")]
            mobile::copy_image_to_clipboard,
            #[cfg(target_os = "android")]
            mobile::haptic_feedback,
            #[cfg(target_os = "android")]
            mobile::set_status_bar_light,
            #[cfg(target_os = "android")]
            mobile::set_navigation_bar_light,
            #[cfg(target_os = "android")]
            mobile::set_system_bars_hidden,
            #[cfg(target_os = "android")]
            mobile::set_window_background
        ])
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(error) => {
            log::error!("error while running Tauri application: {error}");
            return;
        }
    };
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            hang_up_before_exit(app);
        }
    });
}

const EXIT_HANGUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Quitting mid-call would otherwise leave our membership in the room.
fn hang_up_before_exit(app: &AppHandle<tauri::Wry>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let core = state.core.clone();
    let ended = tauri::async_runtime::block_on(async {
        tokio::time::timeout(EXIT_HANGUP_TIMEOUT, core.end_all_calls()).await
    });
    if ended.is_err() {
        log::warn!("calls were still hanging up when the app exited");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::EventSink;
    use sable_core::protocol::CoreEvent;
    use tauri::ipc::{Channel, InvokeResponseBody};

    #[test]
    fn replaces_the_event_channel_after_a_frontend_reload() {
        let first_messages = Arc::new(Mutex::new(0));
        let first_count = first_messages.clone();
        let first = Channel::new(move |_| {
            *first_count
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) += 1;
            Ok(())
        });

        let second_messages = Arc::new(Mutex::new(0));
        let second_count = second_messages.clone();
        let second = Channel::new(move |_| {
            *second_count
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) += 1;
            Ok(())
        });

        let sink = EventSink::default();
        assert!(!sink.replace(first));
        assert!(sink.replace(second));
        sink.send(vec![CoreEvent::SessionEnded {
            reason: "test".to_owned(),
        }]);

        assert_eq!(
            *first_messages
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            0
        );
        assert_eq!(
            *second_messages
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            1
        );
    }

    #[test]
    fn replays_events_sent_before_the_first_subscription_in_batches() {
        let batches = Arc::new(Mutex::new(Vec::new()));
        let seen = batches.clone();
        let channel = Channel::new(move |body| {
            let InvokeResponseBody::Json(json) = body else {
                unreachable!("events are serialised as JSON");
            };
            let events: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
            seen.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(events.len());
            Ok(())
        });

        let sink = EventSink::default();
        sink.send(
            (0..300)
                .map(|_| CoreEvent::SessionEnded {
                    reason: "early".to_owned(),
                })
                .collect(),
        );
        sink.replace(channel);
        sink.send(vec![CoreEvent::SessionEnded {
            reason: "live".to_owned(),
        }]);

        assert_eq!(
            *batches
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            [256, 44, 1]
        );
    }
}
