use futures_util::StreamExt;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi_derive::napi;

use super::Callback;

#[napi]
pub(crate) fn watch_flatpak_updates(notify: Callback) {
    napi::bindgen_prelude::spawn(async move {
        if let Err(error) = watch(&notify).await {
            tracing::warn!(%error, "flatpak update monitor unavailable");
        }
    });
}

async fn watch(notify: &Callback) -> ashpd::Result<()> {
    let portal = ashpd::flatpak::Flatpak::new().await?;
    let monitor = portal
        .create_update_monitor(ashpd::flatpak::CreateUpdateMonitorOptions::default())
        .await?;
    let mut updates = monitor.receive_update_available().await?;
    while let Some(update) = updates.next().await {
        notify.call(
            update.remote_commit().to_owned(),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
    Ok(())
}
