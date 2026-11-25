use std::collections::HashMap;

use crate::watchers::NotificationRoute;

#[derive(Default)]
struct Maps {
    clients: HashMap<String, matrix_sdk::Client>,
    /// The writer each account's token refreshes are saved under, so a replaced client's are not.
    writers: HashMap<String, u64>,
    routes: HashMap<String, NotificationRoute>,
    loans: HashMap<String, usize>,
}

/// Outside the maps' lock: the route has a lock of its own.
fn close(route: Option<NotificationRoute>) {
    if let Some(route) = route {
        route.lock().take();
    }
}

#[derive(Default)]
pub(crate) struct AccountClients {
    inner: parking_lot::Mutex<Maps>,
    loans_returned: tokio::sync::Notify,
}

impl AccountClients {
    pub(crate) fn get(&self, account_id: &str) -> Option<matrix_sdk::Client> {
        self.inner.lock().clients.get(account_id).cloned()
    }

    pub(crate) fn contains(&self, account_id: &str) -> bool {
        self.inner.lock().clients.contains_key(account_id)
    }

    pub(crate) fn insert(&self, account_id: &str, client: matrix_sdk::Client) {
        self.inner
            .lock()
            .clients
            .insert(account_id.to_owned(), client);
    }

    pub(crate) fn account_ids(&self) -> Vec<String> {
        self.inner.lock().clients.keys().cloned().collect()
    }

    #[cfg(not(target_family = "wasm"))]
    pub(crate) fn clients(&self) -> Vec<matrix_sdk::Client> {
        self.inner.lock().clients.values().cloned().collect()
    }

    pub(crate) fn writer(&self, account_id: &str) -> Option<u64> {
        self.inner.lock().writers.get(account_id).copied()
    }

    pub(crate) fn set_writer(&self, account_id: &str, writer: u64) {
        self.inner
            .lock()
            .writers
            .insert(account_id.to_owned(), writer);
    }

    pub(crate) fn route(&self, account_id: &str) -> Option<NotificationRoute> {
        self.inner.lock().routes.get(account_id).cloned()
    }

    /// The route already kept for the account wins over `route`.
    pub(crate) fn keep_route(
        &self,
        account_id: &str,
        route: NotificationRoute,
    ) -> NotificationRoute {
        self.inner
            .lock()
            .routes
            .entry(account_id.to_owned())
            .or_insert(route)
            .clone()
    }

    pub(crate) fn remove(&self, account_id: &str) {
        let route = {
            let mut inner = self.inner.lock();
            inner.writers.remove(account_id);
            inner.clients.remove(account_id);
            inner.routes.remove(account_id)
        };
        close(route);
    }

    pub(crate) fn is_lent(&self, account_id: &str) -> bool {
        self.inner.lock().loans.contains_key(account_id)
    }

    #[cfg(not(target_family = "wasm"))]
    pub(crate) fn lend(
        &self,
        supervised: &crate::supervisor::Supervised<'_>,
        account_id: &str,
    ) -> Option<matrix_sdk::Client> {
        let client = self.get(account_id)?;
        self.count_loan(supervised, account_id);
        Some(client)
    }

    #[cfg(not(target_family = "wasm"))]
    pub(crate) fn count_loan(&self, _: &crate::supervisor::Supervised<'_>, account_id: &str) {
        *self
            .inner
            .lock()
            .loans
            .entry(account_id.to_owned())
            .or_default() += 1;
    }

    /// Whether this was the last loan. Returns synchronously, so a lifecycle job waiting for the
    /// loans never waits on the lifecycle queue.
    #[cfg(not(target_family = "wasm"))]
    pub(crate) fn give_back(&self, account_id: &str) -> bool {
        let mut inner = self.inner.lock();
        let Some(count) = inner.loans.get_mut(account_id) else {
            return true;
        };
        *count = count.saturating_sub(1);
        if *count > 0 {
            return false;
        }
        inner.loans.remove(account_id);
        drop(inner);
        self.loans_returned.notify_waiters();
        true
    }

    /// Before the store under a lent client is rebuilt or removed, whose Olm sessions a second
    /// client would overwrite.
    pub(crate) async fn wait_until_returned(&self, account_id: &str) {
        loop {
            let returned = self.loans_returned.notified();
            if !self.is_lent(account_id) {
                return;
            }
            returned.await;
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.inner.lock().clients.len()
    }

    #[cfg(test)]
    pub(crate) fn is_empty(&self) -> bool {
        self.inner.lock().clients.is_empty()
    }

    #[cfg(test)]
    pub(crate) fn writers(&self) -> usize {
        self.inner.lock().writers.len()
    }
}
