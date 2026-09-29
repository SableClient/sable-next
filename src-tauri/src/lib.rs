#![recursion_limit = "512"]

//! The native carrier. A feature adds a `Command` variant, not a tauri command,
//! except to move bytes or to reach something only this process has: the push
//! registration, the system browser, the crash reporter.

#[cfg(any(all(feature = "cef", target_os = "linux"), test))]
mod deep_link_delivery;
#[cfg(any(all(feature = "cef", target_os = "linux"), all(test, unix)))]
pub mod deep_link_ipc;
#[cfg(target_os = "ios")]
// Objective-C bindings expose PhotoKit calls as unsafe; keep that exception out
// of the Rust-only application code.
#[allow(unsafe_code)]
mod ios;
mod map_tiles;
#[cfg(all(feature = "cef", target_os = "linux"))]
pub use map_tiles::TILE_URI_SCHEME;
#[cfg(target_os = "android")]
mod cold_push;
#[cfg(target_os = "linux")]
mod hdr_share;
#[cfg(target_os = "android")]
mod mobile;
mod notifications;
#[cfg(target_os = "linux")]
pub mod permission_grants;
#[cfg(all(feature = "cef", target_os = "linux"))]
mod portal_theme;
#[cfg(desktop)]
pub mod proxy;
#[cfg(target_os = "linux")]
pub mod screen_audio;
#[cfg(mobile)]
use tauri_plugin_notifications::NotificationsExt;
mod sentry;
mod share_inbox;
#[cfg(target_os = "windows")]
mod snap_layouts;
#[cfg(desktop)]
mod tray;
#[cfg(all(feature = "cef", target_os = "linux"))]
mod video_transcode;
#[cfg(all(not(feature = "cef"), target_os = "linux"))]
mod webkit;
#[cfg(desktop)]
mod window_geometry;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use sable_core::{
    Core, GalleryAttachment,
    protocol::{Command, CommandErr, CommandOk, CoreEvent},
};
use tauri::{
    AppHandle, Manager, State,
    ipc::{Channel, InvokeBody, Request, Response},
};
use tauri_plugin_opener::OpenerExt;

/// CEF (Chromium) on Linux, wry everywhere else.
#[cfg(all(feature = "cef", target_os = "linux"))]
type BrowserEngine = tauri_runtime_cef::CefRuntime<tauri::EventLoopMessage>;
#[cfg(not(all(feature = "cef", target_os = "linux")))]
use tauri::Wry as BrowserEngine;

struct AppState {
    core: Arc<Core>,
    event_sink: Arc<EventSink>,
}

/// Most events a single `Channel::send` carries. Every send is one
/// `evaluateJavascript`, and on Android each in-flight one pins a JNI global
/// reference until the renderer answers - 51200 of those and the app aborts.
const EVENT_BATCH_LIMIT: usize = 256;

#[derive(Default)]
struct EventSink(Mutex<Option<Channel<Vec<CoreEvent>>>>);

impl EventSink {
    fn replace(&self, channel: Channel<Vec<CoreEvent>>) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(channel);
    }

    fn send(&self, events: Vec<CoreEvent>) {
        let channel = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(channel) = channel {
            let _ = channel.send(events);
        }
    }
}

#[tauri::command]
async fn submit_command(
    state: State<'_, AppState>,
    command: Command,
) -> Result<CommandOk, CommandErr> {
    Box::pin(state.core.dispatch(command)).await
}

#[tauri::command]
async fn fetch_media(
    state: State<'_, AppState>,
    source: String,
    width: u32,
    height: u32,
) -> Result<Response, CommandErr> {
    let bytes = state.core.media_thumbnail(source, width, height).await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
async fn forget_media(state: State<'_, AppState>, source: String) -> Result<(), CommandErr> {
    state.core.forget_media(source).await
}

/// The MIME type [`stream_video`] delivers.
#[cfg(all(feature = "cef", target_os = "linux"))]
#[tauri::command]
#[allow(clippy::unnecessary_wraps)] // The frontend transport expects a Result.
async fn video_stream_mime() -> Result<&'static str, CommandErr> {
    Ok(video_transcode::STREAM_MIME)
}

/// Sends a re-encode over `chunks`, ending with the empty end-of-stream chunk.
#[cfg(all(feature = "cef", target_os = "linux"))]
#[tauri::command]
async fn stream_video(
    app: AppHandle<BrowserEngine>,
    state: State<'_, AppState>,
    source: String,
    id: u64,
    chunks: tauri::ipc::Channel<Response>,
) -> Result<(), CommandErr> {
    tracing::info!(%source, id, "video stream requested");
    let input = state
        .core
        .media_thumbnail(source.clone(), 0, 0)
        .await
        .inspect_err(
            |error| tracing::warn!(%source, ?error, "video stream could not fetch the attachment"),
        )?;
    tracing::info!(id, bytes = input.len(), "video stream fetched, encoding");
    tauri::async_runtime::spawn_blocking(move || {
        video_transcode::stream_to(&app, &source, &input, &chunks, id)
    })
    .await
    .map_err(|error| {
        tracing::error!(%error, "video encode task did not finish");
        CommandErr::Unavailable
    })?
}

pub(crate) fn decode_header(request: &Request<'_>, name: &str) -> Option<String> {
    let value = request.headers().get(name)?.to_str().ok()?;
    decode_header_value(value)
}

#[tauri::command]
async fn import_persona_avatar(
    state: State<'_, AppState>,
    url: String,
) -> Result<String, CommandErr> {
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
    fn bytes(&self) -> Result<Vec<u8>, CommandErr>;
}

impl Carried for Base64Invoke {
    fn bytes(&self) -> Result<Vec<u8>, CommandErr> {
        STANDARD
            .decode(&self.bytes)
            .map_err(|_| CommandErr::InvalidMedia)
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

    fn bytes(&self) -> Result<Vec<u8>, CommandErr> {
        let InvokeBody::Raw(bytes) = self.body() else {
            return Err(CommandErr::InvalidMedia);
        };
        Ok(bytes.clone())
    }
}

async fn carried_attachment(
    core: &sable_core::Core,
    request: &impl Carried,
) -> Result<(), CommandErr> {
    let attachment = request
        .header("request")
        .and_then(|json| serde_json::from_str(&json).ok())
        .ok_or(CommandErr::InvalidMedia)?;
    core.send_attachment(attachment, request.bytes()?).await
}

async fn carried_upload(
    core: &sable_core::Core,
    request: &impl Carried,
) -> Result<String, CommandErr> {
    let mime = request.header("mime").ok_or(CommandErr::InvalidMedia)?;
    core.upload_media(mime, request.bytes()?).await
}

#[tauri::command]
async fn send_gallery(
    state: State<'_, AppState>,
    request: sable_core::protocol::SendGalleryRequest,
    items: Vec<GalleryAttachment>,
) -> Result<(), CommandErr> {
    state.core.send_gallery(request, items).await
}

#[tauri::command]
async fn send_attachment(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<(), CommandErr> {
    carried_attachment(&state.core, &request).await
}

/// Returns the `mxc:` URI.
#[tauri::command]
async fn upload_media(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<String, CommandErr> {
    carried_upload(&state.core, &request).await
}

#[tauri::command]
async fn send_attachment_base64(
    state: State<'_, AppState>,
    request: Base64Invoke,
) -> Result<(), CommandErr> {
    carried_attachment(&state.core, &request).await
}

#[tauri::command]
async fn upload_media_base64(
    state: State<'_, AppState>,
    request: Base64Invoke,
) -> Result<String, CommandErr> {
    carried_upload(&state.core, &request).await
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri extracts command state by value
fn subscribe_events(state: State<'_, AppState>, channel: Channel<Vec<CoreEvent>>) {
    state.event_sink.replace(channel);
}

#[tauri::command]
async fn register_push(
    app: AppHandle<BrowserEngine>,
    state: State<'_, AppState>,
    config: notifications::PushConfig,
) -> Result<(), notifications::PushRegistrationError> {
    let core = state.core.clone();
    Box::pin(notifications::register_push(&app, &core, config)).await
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri extracts command state by value
fn device_pusher(
    app: AppHandle<BrowserEngine>,
    user_id: String,
    device_id: String,
) -> Result<Option<notifications::DevicePusher>, CommandErr> {
    notifications::device_pusher(&app, &user_id, &device_id)
}

#[tauri::command]
async fn unregister_push(app: AppHandle<BrowserEngine>) -> Result<(), CommandErr> {
    Box::pin(notifications::unregister_push(&app)).await
}

#[tauri::command]
async fn test_notification(
    app: AppHandle<BrowserEngine>,
    state: State<'_, AppState>,
    sequence: u32,
) -> Result<(), CommandErr> {
    let core = state.core.clone();
    notifications::show_test(&app, &core, sequence).await;
    Ok(())
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri extracts command state by value
#[expect(
    clippy::fn_params_excessive_bools,
    reason = "notification preference command arguments"
)]
async fn set_notification_encrypted_content(
    app: AppHandle<BrowserEngine>,
    allowed: bool,
    content: bool,
    enabled: bool,
    sounds: bool,
    notify_once: bool,
) -> Result<(), CommandErr> {
    #[cfg(mobile)]
    app.notifications()
        .set_push_policy(enabled, content, allowed, sounds, notify_once)
        .await
        .map_err(|_| CommandErr::Unavailable)?;
    #[cfg(not(mobile))]
    let _ = (content, enabled, sounds, notify_once);
    #[cfg(target_os = "ios")]
    ios::write_push_policy(enabled, content, allowed, sounds, notify_once)
        .map_err(|_| CommandErr::Unavailable)?;
    notifications::allow_encrypted_content(&app, allowed).await;
    Ok(())
}

fn setup(app: &mut tauri::App<BrowserEngine>) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(desktop)]
    proxy::apply_to_core();
    #[cfg(desktop)]
    if let Some(error) = proxy::launch_error() {
        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
        app.dialog()
            .message(error)
            .title("Sable")
            .kind(MessageDialogKind::Error)
            .show(|_| std::process::exit(2));
        return Ok(());
    }

    for config in &app.config().app.windows {
        let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?;
        #[cfg(desktop)]
        let builder = window_geometry::restore(app.handle(), builder, &config.label);
        #[cfg(all(desktop, not(all(feature = "cef", target_os = "linux"))))]
        let builder = match proxy::launch_proxy() {
            Ok(Some(url)) => builder.proxy_url(tauri::Url::parse(url)?),
            _ => builder,
        };
        #[cfg(target_os = "android")]
        let builder = builder.on_navigation(|url| url.as_str().parse::<tauri::http::Uri>().is_ok());
        builder.build()?;
    }

    // GTK's X11 backend swaps out the X error handlers on the way in,
    // so the runtime's have to go back on after it.
    #[cfg(all(feature = "cef", target_os = "linux"))]
    {
        gtk::init()?;
        tauri_runtime_cef::install_x_error_handlers();
    }

    // Linux never registers schemes at install time, and a Windows dev
    // build skips the installer, so claim it at runtime.
    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link().register_all()?;
    }

    #[cfg(all(feature = "cef", target_os = "linux"))]
    deep_link_ipc::install_handler(app.handle());

    #[cfg(all(feature = "cef", target_os = "linux"))]
    portal_theme::follow(app.handle().clone());

    let data_dir = app.path().app_data_dir()?;
    // Android resolves that to the app data root, which the app
    // itself may not write to; only `files` under it.
    #[cfg(target_os = "android")]
    let data_dir = data_dir.join("files");
    #[cfg(target_os = "ios")]
    let data_dir = {
        let shared = ios::shared_store_dir().unwrap_or_else(|error| {
            log::warn!("Shared notification storage unavailable: {error}");
            data_dir.clone()
        });
        // Do not silently abandon an older installation's credentials or SDK store.
        if data_dir.join("session.json").exists() && !shared.join("session.json").exists() {
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
        Box::new(sable_core::store::FileSessionStore::exclusive(&data_dir)?),
    );
    let event_sink = Arc::new(EventSink::default());
    let pushing = core.clone();
    #[cfg(target_os = "android")]
    let _ = cold_push::CORE.set(core.clone());
    app.manage(AppState {
        core,
        event_sink: event_sink.clone(),
    });
    spawn_event_pump(app.handle().clone(), pushing, events, event_sink);
    #[cfg(desktop)]
    notifications::register_actions(app.handle());
    #[cfg(target_os = "android")]
    {
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move { notifications::ensure_channel(&handle).await });
    }
    #[cfg(desktop)]
    app.manage(tray::DesktopWindowStore::default());

    #[cfg(target_os = "ios")]
    if let Some(window) = app.get_webview_window("main") {
        ios::hide_form_accessory_bar(&window);
    }

    #[cfg(all(not(feature = "cef"), target_os = "linux"))]
    webkit::configure(app.handle());

    map_tiles::cleanup_cache(app.handle());
    #[cfg(all(feature = "cef", target_os = "linux"))]
    video_transcode::cleanup_cache(app.handle());

    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn apply_desktop_window_settings(
    app: AppHandle<BrowserEngine>,
    settings: tray::DesktopWindowSettings,
) -> Result<tray::DesktopWindowState, String> {
    tray::apply(&app, settings).map_err(|error| error.to_string())
}

#[cfg(desktop)]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn set_tray_unread(app: AppHandle<BrowserEngine>, unread: bool) -> Result<(), String> {
    tray::set_unread_dot(&app, unread).map_err(|error| error.to_string())
}

#[cfg(desktop)]
fn hide_to_tray_on_close(window: &tauri::Window<BrowserEngine>, event: &tauri::WindowEvent) {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if tray::hides_to_tray(window.app_handle()) {
        api.prevent_close();
        tray::hide_to_tray(window);
    }
}

#[tauri::command]
async fn notification_permission(app: AppHandle<BrowserEngine>) -> &'static str {
    notifications::permission(&app).await
}

#[tauri::command]
async fn request_notification_permission(app: AppHandle<BrowserEngine>) -> &'static str {
    notifications::request_permission(&app).await
}

#[tauri::command]
async fn dismiss_room_notification(
    app: AppHandle<BrowserEngine>,
    user_id: String,
    room_id: String,
) {
    notifications::dismiss(&app, &user_id, &room_id).await;
}

#[tauri::command]
async fn dismiss_read_room_notifications(
    app: AppHandle<BrowserEngine>,
    user_id: String,
    room_ids: Vec<String>,
) {
    notifications::dismiss_read(&app, &user_id, &room_ids).await;
}

#[cfg(all(feature = "cef", target_os = "linux"))]
#[tauri::command]
fn pending_deep_links() -> Vec<String> {
    deep_link_ipc::take_pending_urls()
}

#[cfg(desktop)]
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri extracts command inputs by value
fn toggle_devtools(window: tauri::WebviewWindow<BrowserEngine>) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn hdr_monitors() -> Vec<sable_hdr::share::HdrMonitor> {
    tauri::async_runtime::spawn_blocking(sable_hdr::share::list)
        .await
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn start_hdr_share(app: AppHandle<BrowserEngine>, index: usize) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sable_hdr::share::start(app, index))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn hdr_frame_done(slot: usize) {
    sable_hdr::share::release(slot);
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn stop_hdr_share() {
    let _ = tauri::async_runtime::spawn_blocking(sable_hdr::share::stop).await;
}

#[cfg(target_os = "linux")]
#[tauri::command]
async fn hdr_monitors() -> Vec<hdr_share::HdrMonitor> {
    tauri::async_runtime::spawn_blocking(hdr_share::monitors)
        .await
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
#[tauri::command]
async fn start_hdr_share(frames: tauri::ipc::Channel<tauri::ipc::Response>) -> Result<(), String> {
    let _ = tauri::async_runtime::spawn_blocking(hdr_share::stop).await;
    hdr_share::start(frames).await
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn hdr_frame_done() {
    hdr_share::release();
}

#[cfg(target_os = "linux")]
#[tauri::command]
async fn stop_hdr_share() {
    let _ = tauri::async_runtime::spawn_blocking(hdr_share::stop).await;
}

#[cfg(target_os = "linux")]
#[tauri::command]
async fn start_screen_audio(selection: screen_audio::Selection) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || screen_audio::start(selection))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(target_os = "linux")]
#[tauri::command]
async fn screen_audio_apps() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(screen_audio::list_apps)
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(target_os = "linux")]
#[tauri::command]
async fn stop_screen_audio() {
    let _ = tauri::async_runtime::spawn_blocking(screen_audio::stop).await;
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri extracts command inputs by value
fn open_external_url(app: AppHandle<BrowserEngine>, url: String) -> Result<(), CommandErr> {
    let parsed = tauri::Url::parse(&url).map_err(|_| CommandErr::Denied)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(CommandErr::Denied);
    }

    app.opener()
        .open_url(parsed.to_string(), None::<String>)
        .map_err(|_| CommandErr::Unavailable)
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

#[cfg(desktop)]
fn auto_update_supported() -> bool {
    !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some()
}

#[cfg(desktop)]
fn with_updates(builder: tauri::Builder<BrowserEngine>) -> tauri::Builder<BrowserEngine> {
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri::plugin::Builder::<BrowserEngine, ()>::new("sable-updates")
                .js_init_script(format!(
                    "window.__SABLE_AUTO_UPDATE__ = {};",
                    auto_update_supported()
                ))
                .build(),
        )
}

/// Two SDK sites log once per room per sync response, which on a phone costs
/// more than they are worth: heroes it cannot name, and the latest-event
/// builder choking on the bare `{}` a space child removal carries.
fn install_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("SABLE_LOG").unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new(
            "info,matrix_sdk_base::room::display_name=error,matrix_sdk::latest_events=off,matrix_sdk::http_client=off",
        )
    });
    if let Err(error) = tracing_subscriber::fmt().with_env_filter(filter).try_init() {
        eprintln!("could not install the log subscriber: {error}");
    }
}

#[cfg(not(target_os = "linux"))]
fn with_platform_plugins(builder: tauri::Builder<BrowserEngine>) -> tauri::Builder<BrowserEngine> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder
        .plugin(tauri_plugin_app_icon::init())
        .plugin(tauri_plugin_edge_to_edge::init())
        .plugin(tauri_plugin_geolocation::init())
        .plugin(tauri_plugin_livekit_mobile::init());

    #[cfg(any(
        target_os = "android",
        target_os = "ios",
        target_os = "macos",
        target_os = "windows"
    ))]
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
    install_logging();

    // Before the threads Tauri spawns, so they inherit the panic handler.
    let sentry_guard = sentry::init();
    #[cfg(desktop)]
    let sentry_minidump_guard = sentry_guard
        .as_ref()
        .map(|guard| tauri_plugin_sentry::minidump::init(guard));
    #[cfg(desktop)]
    let _ = &sentry_minidump_guard;

    let builder = tauri::Builder::<BrowserEngine>::new();
    let builder = if let Some(client) = sentry_guard.as_ref() {
        builder.plugin(tauri_plugin_sentry::init_with_no_injection(client))
    } else {
        builder
    };

    // Before every other plugin, as its docs require: it has to win the race
    // with a second process carrying the OIDC redirect.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    }));

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(window_geometry::plugin())
        .on_window_event(hide_to_tray_on_close);

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = with_updates(builder);

    #[cfg(not(target_os = "linux"))]
    let builder = with_platform_plugins(builder);

    if let Err(error) = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notifications::init())
        .register_asynchronous_uri_scheme_protocol(map_tiles::TILE_URI_SCHEME, map_tiles::respond)
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            submit_command,
            subscribe_events,
            fetch_media,
            forget_media,
            #[cfg(all(feature = "cef", target_os = "linux"))]
            stream_video,
            #[cfg(all(feature = "cef", target_os = "linux"))]
            video_stream_mime,
            import_persona_avatar,
            send_attachment,
            send_gallery,
            send_attachment_base64,
            upload_media,
            upload_media_base64,
            open_external_url,
            #[cfg(target_os = "linux")]
            start_screen_audio,
            #[cfg(target_os = "linux")]
            stop_screen_audio,
            #[cfg(target_os = "linux")]
            screen_audio_apps,
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            hdr_monitors,
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            start_hdr_share,
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            hdr_frame_done,
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            stop_hdr_share,
            #[cfg(desktop)]
            toggle_devtools,
            #[cfg(all(feature = "cef", target_os = "linux"))]
            pending_deep_links,
            register_push,
            unregister_push,
            device_pusher,
            dismiss_room_notification,
            dismiss_read_room_notifications,
            notification_permission,
            request_notification_permission,
            test_notification,
            set_notification_encrypted_content,
            #[cfg(desktop)]
            apply_desktop_window_settings,
            #[cfg(desktop)]
            set_tray_unread,
            #[cfg(target_os = "windows")]
            snap_layouts::show_snap_layouts,
            #[cfg(target_os = "windows")]
            snap_layouts::release_snap_layouts,
            #[cfg(target_os = "windows")]
            snap_layouts::dismiss_snap_layouts,
            share_inbox::share_inbox_drain,
            share_inbox::share_inbox_read,
            share_inbox::share_inbox_clear,
            sentry::set_native_sentry_enabled,
            #[cfg(target_os = "ios")]
            ios::save_media_to_photos,
            #[cfg(target_os = "ios")]
            ios::haptic_feedback,
            #[cfg(target_os = "ios")]
            ios::set_system_bars_hidden,
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
        .run(tauri::generate_context!())
    {
        log::error!("error while running Tauri application: {error}");
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::EventSink;
    use sable_core::protocol::CoreEvent;
    use tauri::ipc::Channel;

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
        sink.replace(first);
        sink.replace(second);
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
}
