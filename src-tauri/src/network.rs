use std::sync::{Arc, Mutex, Weak};

use sable_core::Core;

struct Connection {
    available: bool,
    unmetered: bool,
    core: Option<Weak<Core>>,
}

static CONNECTION: Mutex<Connection> = Mutex::new(Connection {
    available: true,
    unmetered: false,
    core: None,
});

pub(crate) fn attach(core: &Arc<Core>) {
    let mut connection = CONNECTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    core.set_search_network_unmetered(connection.unmetered);
    set_available_on(core.clone(), connection.available);
    connection.core = Some(Arc::downgrade(core));

    #[cfg(target_os = "ios")]
    if let Err(error) = crate::ios::watch_network() {
        tracing::warn!(%error, "could not monitor the network");
    }
}

#[cfg(mobile)]
pub(crate) fn set_state(available: bool, unmetered: bool) {
    let mut connection = CONNECTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    connection.available = available;
    connection.unmetered = unmetered;
    if let Some(core) = connection.core.as_ref().and_then(Weak::upgrade) {
        core.set_search_network_unmetered(unmetered);
        set_available_on(core, available);
    }
}

fn set_available_on(core: Arc<Core>, available: bool) {
    tauri::async_runtime::spawn(async move {
        core.set_network_available(available).await;
    });
}
