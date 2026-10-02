use sable_core::v1_migration::{Entry, IndexedDbSnapshot, LegacySession};
use tauri::{Manager as _, State};

use crate::{AppState, BrowserEngine};

#[tauri::command]
pub async fn v1_migration_complete(state: State<'_, AppState>) -> Result<bool, String> {
    state.core.v1_migration_complete().await
}

#[tauri::command]
pub async fn begin_v1_migration(
    app: tauri::AppHandle<BrowserEngine>,
    state: State<'_, AppState>,
    sessions: Vec<LegacySession>,
    active_user_id: Option<String>,
    snapshots: Vec<Option<IndexedDbSnapshot>>,
) -> Result<(), String> {
    let roots = vec![
        app.path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?,
    ];
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let mut roots = roots;
    #[cfg(target_os = "android")]
    roots.push(roots.first().ok_or("missing app directory")?.join("files"));
    #[cfg(target_os = "ios")]
    if let Ok(shared) = crate::ios::shared_store_dir()
        && let Some(parent) = shared.parent()
    {
        roots.push(parent.to_path_buf());
    }
    state
        .core
        .begin_v1_migration(sessions, active_user_id, snapshots, roots)
        .await
}

#[tauri::command]
pub async fn import_v1_crypto_batch(
    state: State<'_, AppState>,
    account_index: usize,
    store: String,
    entries: Vec<Entry>,
) -> Result<(), String> {
    state
        .core
        .import_v1_crypto_batch(account_index, &store, entries)
        .await
}

#[tauri::command]
pub async fn skip_v1_migration(state: State<'_, AppState>) -> Result<(), String> {
    state.core.skip_v1_migration().await
}

#[tauri::command]
pub async fn finish_v1_migration(state: State<'_, AppState>) -> Result<(), String> {
    state.core.finish_v1_migration().await
}
