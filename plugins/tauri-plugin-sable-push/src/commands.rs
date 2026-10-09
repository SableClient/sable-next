use tauri::{AppHandle, Runtime, State, command};

use crate::{
    Result, SablePush,
    models::{Diagnostics, History},
};

#[command]
pub(crate) async fn push_history<R: Runtime>(
    _app: AppHandle<R>,
    push: State<'_, SablePush<R>>,
) -> Result<History> {
    push.history().await
}

#[command]
pub(crate) async fn clear_push_history<R: Runtime>(
    _app: AppHandle<R>,
    push: State<'_, SablePush<R>>,
) -> Result<()> {
    push.clear_history().await
}

#[command]
pub(crate) async fn take_push_diagnostics<R: Runtime>(
    _app: AppHandle<R>,
    push: State<'_, SablePush<R>>,
) -> Result<Diagnostics> {
    push.take_diagnostics().await
}
