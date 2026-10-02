use std::sync::{Arc, Mutex, Weak};

use sable_core::Core;

static CONNECTION: Mutex<(bool, Option<Weak<Core>>)> = Mutex::new((false, None));

pub(crate) fn attach(core: &Arc<Core>) {
    let mut connection = CONNECTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    core.set_search_network_unmetered(connection.0);
    connection.1 = Some(Arc::downgrade(core));

    #[cfg(target_os = "ios")]
    if let Err(error) = crate::ios::watch_network(core) {
        tracing::warn!(%error, "could not monitor network cost");
    }
}

#[cfg(target_os = "android")]
pub(crate) fn set_unmetered(unmetered: bool) {
    let mut connection = CONNECTION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    connection.0 = unmetered;
    if let Some(core) = connection.1.as_ref().and_then(Weak::upgrade) {
        core.set_search_network_unmetered(unmetered);
    }
}
