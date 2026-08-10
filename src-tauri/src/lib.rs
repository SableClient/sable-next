#![recursion_limit = "512"]

//! The native carrier. A feature adds a `Command` variant, not a tauri command,
//! except for the three below that move bytes.

use std::sync::{Arc, Mutex};

use sable_core::{
    protocol::{Command, CommandErr, CommandOk, CoreEvent},
    Core,
};
use tauri::{
    ipc::{Channel, InvokeBody, Request, Response},
    Manager, State,
};
use tokio::sync::mpsc::UnboundedReceiver;

struct AppState {
    core: Arc<Core>,
    events: Mutex<Option<UnboundedReceiver<CoreEvent>>>,
}

#[tauri::command]
async fn submit_command(
    state: State<'_, AppState>,
    command: Command,
) -> Result<CommandOk, CommandErr> {
    state.core.dispatch(command).await
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

/// Called once at startup.
#[tauri::command]
fn subscribe_events(
    state: State<'_, AppState>,
    channel: Channel<CoreEvent>,
) -> Result<(), CommandErr> {
    let mut events = state.events.lock().expect("event receiver mutex poisoned");
    let mut rx = events.take().ok_or(CommandErr::Unavailable)?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if channel.send(event).is_err() {
                break;
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Before every other plugin, as its docs require: it has to win the race
    // with a second process carrying the OIDC redirect.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
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
            let (core, events) = Core::new(
                data_dir.to_string_lossy().into_owned(),
                Box::new(sable_core::store::FileSessionStore::new(&data_dir)),
            );
            app.manage(AppState {
                core,
                events: Mutex::new(Some(events)),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            submit_command,
            subscribe_events,
            fetch_media,
            send_attachment,
            upload_media
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
