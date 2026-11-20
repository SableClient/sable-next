use std::sync::{Arc, LazyLock};

use sable_core::Core;
use tokio::sync::watch;

static STATE: LazyLock<watch::Sender<(bool, bool)>> =
    LazyLock::new(|| watch::Sender::new((true, false)));

pub(crate) fn attach(core: &Arc<Core>) {
    let core = Arc::downgrade(core);
    let mut states = STATE.subscribe();
    states.mark_changed();
    // One task, so the states apply in the order they were reported: a lost network applied
    // after the one that replaced it would keep sync waiting for good.
    tauri::async_runtime::spawn(async move {
        while states.changed().await.is_ok() {
            let (available, unmetered) = *states.borrow_and_update();
            let Some(core) = core.upgrade() else {
                break;
            };
            core.update_network_conditions(available, unmetered).await;
        }
    });

    #[cfg(target_os = "ios")]
    if let Err(error) = crate::ios::watch_network() {
        tracing::warn!(%error, "could not monitor the network");
    }
}

#[cfg(mobile)]
pub(crate) fn set_state(available: bool, unmetered: bool) {
    STATE.send_replace((available, unmetered));
}
