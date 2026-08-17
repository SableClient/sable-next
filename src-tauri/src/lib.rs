#![recursion_limit = "512"]

//! The native carrier. A feature adds a `Command` variant, not a tauri command,
//! except to move bytes or to reach something only this process has: the push
//! registration, the system browser, the crash reporter.

mod notifications;
mod sentry;

use std::sync::{Arc, Mutex};

use sable_core::{
    protocol::{Command, CommandErr, CommandOk, CoreEvent},
    Core,
};
use tauri::{
    ipc::{Channel, InvokeBody, Request, Response},
    AppHandle, Manager, State,
};
use tauri_plugin_opener::OpenerExt;

struct AppState {
    core: Arc<Core>,
    event_sink: Arc<EventSink>,
}

#[derive(Default)]
struct EventSink(Mutex<Option<Channel<CoreEvent>>>);

impl EventSink {
    fn replace(&self, channel: Channel<CoreEvent>) {
        *self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(channel);
    }

    fn send(&self, event: CoreEvent) {
        let channel = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(channel) = channel {
            let _ = channel.send(event);
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

/// `Response` keeps the bytes out of JSON.
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

/// Bytes in the raw body, metadata in the headers: a `Vec<u8>` argument would be
/// marshalled as a JSON array of numbers.
#[tauri::command]
async fn send_attachment(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<(), CommandErr> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandErr::InvalidMedia);
    };

    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };

    state
        .core
        .send_attachment(
            header("room-id").ok_or(CommandErr::UnknownRoom)?,
            header("filename").ok_or(CommandErr::InvalidMedia)?,
            header("mime").ok_or(CommandErr::InvalidMedia)?,
            bytes.clone(),
            header("caption"),
            header("in-reply-to"),
        )
        .await
}

/// Returns the `mxc:` URI.
#[tauri::command]
async fn upload_media(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<String, CommandErr> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(CommandErr::InvalidMedia);
    };

    let mime = request
        .headers()
        .get("mime")
        .and_then(|value| value.to_str().ok())
        .ok_or(CommandErr::InvalidMedia)?;

    state
        .core
        .upload_media(mime.to_owned(), bytes.clone())
        .await
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri extracts command state by value
fn subscribe_events(state: State<'_, AppState>, channel: Channel<CoreEvent>) {
    state.event_sink.replace(channel);
}

#[tauri::command]
async fn register_push(
    app: AppHandle,
    state: State<'_, AppState>,
    config: notifications::PushConfig,
) -> Result<(), CommandErr> {
    let core = state.core.clone();
    notifications::register_push(&app, &core, config).await
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri extracts command inputs by value
fn open_auth_url(app: AppHandle, url: String) -> Result<(), CommandErr> {
    let parsed = tauri::Url::parse(&url).map_err(|_| CommandErr::Denied)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(CommandErr::Denied);
    }

    app.opener()
        .open_url(parsed.to_string(), None::<String>)
        .map_err(|_| CommandErr::Unavailable)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("SABLE_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    if let Err(error) = tracing_subscriber::fmt().with_env_filter(filter).try_init() {
        eprintln!("could not install the log subscriber: {error}");
    }

    // Before the threads Tauri spawns, so they inherit the panic handler.
    let _sentry_guard = sentry::init();

    let builder = tauri::Builder::default();

    // Before every other plugin, as its docs require: it has to win the race
    // with a second process carrying the OIDC redirect.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    }));

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    if let Err(error) = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notifications::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Linux never registers schemes at install time, and a Windows dev
            // build skips the installer, so claim it at runtime.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }

            let data_dir = app.path().app_data_dir()?;
            let (core, mut events) = Core::new(
                data_dir.to_string_lossy().into_owned(),
                Box::new(sable_core::store::FileSessionStore::new(&data_dir)),
            );
            let event_sink = Arc::new(EventSink::default());
            app.manage(AppState {
                core,
                event_sink: event_sink.clone(),
            });
            let notifier = app.handle().clone();
            let pushing = app.state::<AppState>().core.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    if let CoreEvent::Notification { notification } = &event {
                        notifications::show(&notifier, &pushing, notification).await;
                    }
                    event_sink.send(event);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            submit_command,
            subscribe_events,
            fetch_media,
            send_attachment,
            upload_media,
            open_auth_url,
            register_push,
            sentry::set_native_sentry_enabled
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
        sink.send(CoreEvent::SessionEnded {
            reason: "test".to_owned(),
        });

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
