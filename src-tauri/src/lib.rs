#![recursion_limit = "512"]

//! The native carrier. A feature adds an RPC handler in `sable_core::api`, except to move bytes or reach something only this process has.

#[cfg(target_os = "linux")]
mod app_dirs;
#[cfg(any(all(feature = "cef", target_os = "linux"), test))]
mod deep_link_delivery;
#[cfg(any(all(feature = "cef", target_os = "linux"), all(test, unix)))]
pub mod deep_link_ipc;
#[cfg(target_os = "ios")]
// Objective-C bindings expose PhotoKit calls as unsafe; keep that exception out
// of the Rust-only application code.
#[expect(unsafe_code, reason = "FFI call")]
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
#[cfg(mobile)]
mod network;
mod notifications;
#[cfg(target_os = "linux")]
pub mod permission_grants;
#[cfg(all(feature = "cef", target_os = "linux"))]
mod portal_theme;
#[cfg(desktop)]
pub mod proxy;
mod runtime;
#[cfg(target_os = "linux")]
pub mod screen_audio;
mod sentry;
mod share_inbox;
#[cfg(target_os = "linux")]
pub mod smooth_scrolling;
#[cfg(target_os = "windows")]
mod snap_layouts;
#[cfg(desktop)]
mod tray;
mod v1_migration;
#[cfg(desktop)]
pub mod verbose;
mod web_resources;
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
    Core,
    protocol::{CoreEvent, RpcError},
};
use sable_ffi::AccountGate;
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
    gate: AccountGate,
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
    state
        .gate
        .run(
            &method,
            Box::pin(state.core.call(&method, params.get())),
            || Box::pin(state.core.call("session.active_session", params.get())),
            |json| json.get(),
            || RpcError::Unavailable,
        )
        .await
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
    app: AppHandle<BrowserEngine>,
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
    app: AppHandle<BrowserEngine>,
    user_id: String,
    device_id: String,
) -> Result<Option<notifications::DevicePusher>, RpcError> {
    notifications::device_pusher(&app, &user_id, &device_id)
}

#[tauri::command]
async fn unregister_push(app: AppHandle<BrowserEngine>) -> Result<(), RpcError> {
    Box::pin(notifications::unregister_push(&app)).await
}

#[tauri::command]
async fn test_notification(
    app: AppHandle<BrowserEngine>,
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
    app: AppHandle<BrowserEngine>,
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
        let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?
            .on_web_resource_request(|request, response| {
                web_resources::fix_content_type(&request, response);
            });
        #[cfg(desktop)]
        let builder = window_geometry::restore(app.handle(), builder, &config.label);
        #[cfg(desktop)]
        let builder = window_geometry::restore_title_bar(app.handle(), builder);
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
    let gate = AccountGate::default();
    let runtime = runtime::Runtime::new(&core, &gate, &data_dir.to_string_lossy());
    #[cfg(target_os = "ios")]
    follow_ios_lifecycle(&core, &runtime);
    #[cfg(mobile)]
    network::attach(&core);
    let pushing = core.clone();
    #[cfg(target_os = "android")]
    let _ = cold_push::CORE.set(core.clone());
    app.manage(runtime);
    tauri::async_runtime::spawn(restore_ahead_of_webview(core.clone(), gate.clone()));
    let offering = gate.clone();
    app.manage(AppState {
        core,
        gate,
        event_sink: event_sink.clone(),
    });
    spawn_event_pump(app.handle().clone(), pushing, offering, events, event_sink);
    #[cfg(desktop)]
    notifications::register_actions(app.handle());
    #[cfg(desktop)]
    app.manage(tray::DesktopWindowStore::default());

    #[cfg(target_os = "ios")]
    if let Some(window) = app.get_webview_window("main") {
        ios::hide_form_accessory_bar(&window);
    }

    #[cfg(all(not(feature = "cef"), target_os = "linux"))]
    webkit::configure(app.handle());

    map_tiles::cleanup_cache(app.handle());

    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "the framework passes this argument by value"
)]
fn apply_desktop_window_settings(
    app: AppHandle<BrowserEngine>,
    settings: tray::DesktopWindowSettings,
) -> Result<tray::DesktopWindowState, String> {
    tray::apply(&app, settings).map_err(|error| error.to_string())
}

#[cfg(desktop)]
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "the framework passes this argument by value"
)]
fn set_tray_unread(app: AppHandle<BrowserEngine>, unread: bool) -> Result<(), String> {
    tray::set_unread_dot(&app, unread).map_err(|error| error.to_string())
}

#[cfg(desktop)]
fn hide_to_tray_on_close(window: &tauri::Window<BrowserEngine>, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if tray::hides_to_tray(window.app_handle()) {
                api.prevent_close();
                tray::hide_to_tray(window);
            }
        }
        tauri::WindowEvent::Resized(_)
            if tray::minimizes_to_tray(window.app_handle())
                && window.is_minimized().unwrap_or(false) =>
        {
            tray::hide_to_tray(window);
        }
        _ => {}
    }
}

#[cfg(mobile)]
const SYNC_STOP_DELAY: std::time::Duration = std::time::Duration::from_secs(3);

#[cfg(target_os = "android")]
fn update_mobile_activity(window: &tauri::Window<BrowserEngine>, event: &tauri::WindowEvent) {
    let active = match event {
        tauri::WindowEvent::Suspended => false,
        tauri::WindowEvent::Resumed => true,
        _ => return,
    };
    if let (Some(state), Some(runtime)) = (
        window.try_state::<AppState>(),
        window.try_state::<runtime::Runtime>(),
    ) {
        set_mobile_activity(
            state.core.clone(),
            runtime.inner().clone(),
            active,
            SYNC_STOP_DELAY,
        );
    }
}

#[cfg(target_os = "ios")]
fn follow_ios_lifecycle(core: &Arc<Core>, runtime: &runtime::Runtime) {
    let (core, runtime) = (core.clone(), runtime.clone());
    if ios::in_background() {
        set_mobile_activity(
            core.clone(),
            runtime.clone(),
            false,
            std::time::Duration::ZERO,
        );
    }
    ios::observe_lifecycle(move |change| match change {
        ios::Lifecycle::ResignActive => {
            set_mobile_activity(core.clone(), runtime.clone(), false, SYNC_STOP_DELAY);
        }
        ios::Lifecycle::EnterBackground => {
            set_mobile_activity(
                core.clone(),
                runtime.clone(),
                false,
                std::time::Duration::ZERO,
            );
        }
        ios::Lifecycle::BecomeActive => {
            set_mobile_activity(
                core.clone(),
                runtime.clone(),
                true,
                std::time::Duration::ZERO,
            );
        }
    });
}

/// A mobile OS never runs two copies of the app, and iOS kills a suspended app that
/// still holds a file lock in the shared App Group container.
#[cfg(mobile)]
fn session_store(data_dir: &std::path::Path) -> Box<dyn sable_core::store::SessionStore> {
    Box::new(sable_core::store::FileSessionStore::new(data_dir))
}

#[cfg(not(mobile))]
fn session_store(data_dir: &std::path::Path) -> Box<dyn sable_core::store::SessionStore> {
    Box::new(sable_core::store::ExclusiveFileSessionStore::new(data_dir))
}

/// Views are flushed first, as the OS may kill a backgrounded app.
#[cfg(mobile)]
fn set_mobile_activity(
    core: Arc<Core>,
    runtime: runtime::Runtime,
    active: bool,
    stop_delay: std::time::Duration,
) {
    core.set_app_active(active);
    core.record_app_activity(active);
    #[cfg(target_os = "ios")]
    let background_task = (!active).then(|| ios::BackgroundTask::begin("Pause sync"));
    tauri::async_runtime::spawn(async move {
        if !active {
            runtime.flush().await;
            tokio::time::sleep(stop_delay).await;
        }
        core.apply_app_activity(active).await;
        #[cfg(target_os = "ios")]
        drop(background_task);
    });
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
async fn dismiss_room_notifications(
    app: AppHandle<BrowserEngine>,
    user_id: String,
    room_ids: Vec<String>,
) {
    notifications::dismiss(&app, &user_id, &room_ids).await;
}

#[tauri::command]
async fn set_open_conversation(
    app: AppHandle<BrowserEngine>,
    user_id: Option<String>,
    room_id: Option<String>,
) {
    #[cfg(target_os = "android")]
    notifications::set_open_conversation(&app, user_id.as_deref(), room_id.as_deref()).await;
    #[cfg(not(target_os = "android"))]
    let _ = (app, user_id, room_id);
}

#[tauri::command]
async fn forget_left_conversations(app: AppHandle<BrowserEngine>) {
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

#[cfg(all(feature = "cef", target_os = "linux"))]
#[tauri::command]
fn system_color_scheme() -> Option<&'static str> {
    portal_theme::current_scheme()
}

#[cfg(desktop)]
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri extracts command inputs by value"
)]
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

/// `WebView2` parents its browser process to Explorer when we run elevated, so
/// it is not always in our process tree.
#[cfg(target_os = "windows")]
async fn webview_process(webview: &tauri::Webview<BrowserEngine>) -> Result<u32, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            let mut pid = 0;
            // SAFETY: `pid` outlives the call, which only writes through it.
            #[expect(unsafe_code, reason = "FFI call")]
            let outcome = unsafe {
                platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.BrowserProcessId(&raw mut pid))
            };
            let _ = sender.send(outcome.map(|()| pid).map_err(|error| error.to_string()));
        })
        .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn start_screen_audio_stream(
    webview: tauri::Webview<BrowserEngine>,
    selection: sable_loopback::capture::Selection,
    frames: tauri::ipc::Channel<tauri::ipc::Response>,
) -> Result<(), String> {
    let browser = webview_process(&webview).await?;
    tauri::async_runtime::spawn_blocking(move || {
        sable_loopback::share::start(&selection, browser, frames)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn screen_audio_apps(webview: tauri::Webview<BrowserEngine>) -> Result<Vec<String>, String> {
    let browser = webview_process(&webview).await?;
    tauri::async_runtime::spawn_blocking(move || sable_loopback::share::list_apps(browser))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn stop_screen_audio() {
    let _ = tauri::async_runtime::spawn_blocking(sable_loopback::share::stop).await;
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri extracts command inputs by value"
)]
fn open_external_url(app: AppHandle<BrowserEngine>, url: String) -> Result<(), RpcError> {
    let parsed = tauri::Url::parse(&url).map_err(|_| RpcError::Denied)?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto" | "tel") {
        return Err(RpcError::Denied);
    }

    app.opener()
        .open_url(parsed.to_string(), None::<String>)
        .map_err(|_| RpcError::Unavailable)
}

async fn restore_ahead_of_webview(core: Arc<Core>, gate: AccountGate) {
    if !matches!(core.v1_migration_complete().await, Ok(true)) {
        return;
    }
    let restore = gate.run(
        "session.restore",
        Box::pin(core.call("session.restore", "{}")),
        || Box::pin(core.call("session.active_session", "{}")),
        |json| json.get(),
        || RpcError::Unavailable,
    );
    if let Err(error) = restore.await {
        log::warn!("Early session restore failed: {error:?}");
    }
}

fn spawn_event_pump<R: tauri::Runtime>(
    notifier: AppHandle<R>,
    pushing: Arc<Core>,
    gate: AccountGate,
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
            gate.offer(&batch).await;
            batch.retain(CoreEvent::reaches_page);
            if !batch.is_empty() {
                event_sink.send(std::mem::take(&mut batch));
            }

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

#[cfg(not(target_os = "linux"))]
fn with_platform_plugins(builder: tauri::Builder<BrowserEngine>) -> tauri::Builder<BrowserEngine> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder
        .plugin(tauri_plugin_app_icon::init())
        .plugin(tauri_plugin_edge_to_edge::init())
        .plugin(tauri_plugin_livekit_mobile::init());

    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_auth_session::init());

    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_sable_push::init());

    #[cfg(all(any(target_os = "android", target_os = "ios"), feature = "geolocation"))]
    let builder = builder.plugin(tauri_plugin_geolocation::init());

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
    // Before the threads Tauri spawns, so they inherit the panic handler.
    let sentry_guard = sentry::init();
    install_logging();

    let builder = tauri::Builder::<BrowserEngine>::new();
    #[cfg(any(target_os = "macos", target_os = "ios"))]
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

    // Before every other plugin, as its docs require: it has to win the race
    // with a second process carrying the OIDC redirect.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    }));

    #[cfg(desktop)]
    let builder = if verbose::enabled() {
        builder.plugin(verbose::plugin())
    } else {
        builder
    };

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(window_geometry::plugin())
        .on_window_event(hide_to_tray_on_close);

    #[cfg(target_os = "android")]
    let builder = builder.on_window_event(update_mobile_activity);

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = with_updates(builder);

    #[cfg(not(target_os = "linux"))]
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
            runtime::runtime_connect,
            runtime::runtime_handshake,
            runtime::runtime_subscribe,
            runtime::runtime_unsubscribe,
            runtime::runtime_resync,
            runtime::runtime_range,
            runtime::runtime_dispatch,
            runtime::runtime_request,
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
            #[cfg(target_os = "linux")]
            start_screen_audio,
            #[cfg(target_os = "windows")]
            start_screen_audio_stream,
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            stop_screen_audio,
            #[cfg(any(target_os = "windows", target_os = "linux"))]
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
            #[cfg(desktop)]
            verbose::log_console,
            #[cfg(all(feature = "cef", target_os = "linux"))]
            pending_deep_links,
            #[cfg(all(feature = "cef", target_os = "linux"))]
            system_color_scheme,
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
            has_geolocation,
            #[cfg(target_os = "ios")]
            ios::save_media_to_photos,
            #[cfg(target_os = "ios")]
            ios::open_in_app_auth_url,
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
    app.run(|app, event| match event {
        tauri::RunEvent::Exit => {
            hang_up_before_exit(app);
            stop_runtime_before_exit(app);
        }
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } => {
            if let Some(runtime) = app.try_state::<runtime::Runtime>() {
                tauri::async_runtime::block_on(runtime.close(&label));
            }
        }
        _ => {}
    });
}

const EXIT_HANGUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Quitting mid-call would otherwise leave our membership in the room.
fn hang_up_before_exit(app: &AppHandle<BrowserEngine>) {
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

fn stop_runtime_before_exit(app: &AppHandle<BrowserEngine>) {
    let Some(runtime) = app.try_state::<runtime::Runtime>() else {
        return;
    };
    let stopped = tauri::async_runtime::block_on(async {
        tokio::time::timeout(EXIT_HANGUP_TIMEOUT, runtime.shutdown()).await
    });
    if stopped.is_err() {
        log::warn!("the runtime was still saving when the app exited");
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
