use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use std::time::Duration;

use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk_ui::sync_service::SyncService;
use tokio::sync::{Mutex, MutexGuard, Notify, RwLock, watch};

use crate::Core;

const HEALTH_INTERVAL: Duration = Duration::from_secs(30);
const STUCK_AFTER: Duration = Duration::from_secs(60);
const STUCK_CONFIRMED_AFTER: Duration = Duration::from_secs(10);

pub(crate) struct Activity {
    app_active: AtomicBool,
    revision: AtomicU64,
    wake: Notify,
    sync_suspended: AtomicBool,
    network_available: AtomicBool,
    account_locked: AtomicBool,
    stores_open: watch::Sender<bool>,
    /// Separate from `transition`, so a store read never waits for sync to start or stop.
    stores: RwLock<()>,
    transition: Mutex<()>,
}

/// Waiting for another transition while holding one deadlocks.
pub(crate) struct Transition<'a> {
    activity: &'a Activity,
    _serial: MutexGuard<'a, ()>,
}

impl Activity {
    pub(crate) fn new() -> Self {
        Self {
            app_active: AtomicBool::new(true),
            revision: AtomicU64::new(0),
            wake: Notify::new(),
            sync_suspended: AtomicBool::new(false),
            network_available: AtomicBool::new(true),
            account_locked: AtomicBool::new(false),
            stores_open: watch::Sender::new(true),
            stores: RwLock::new(()),
            transition: Mutex::new(()),
        }
    }

    pub(crate) async fn transition(&self) -> Transition<'_> {
        Transition {
            activity: self,
            _serial: self.transition.lock().await,
        }
    }

    /// A process the OS froze wakes with the first wait already elapsed, so only a second one
    /// proves the transition is stuck.
    async fn stuck(&self, after: Duration, confirmed_after: Duration) -> bool {
        for wait in [after, confirmed_after] {
            if matrix_sdk::timeout::timeout(self.transition.lock(), wait)
                .await
                .is_ok()
            {
                return false;
            }
        }
        true
    }

    pub(crate) fn app_active(&self) -> bool {
        self.app_active.load(Ordering::Relaxed)
    }

    fn set_app_active(&self, active: bool) -> u64 {
        self.app_active.store(active, Ordering::Relaxed);
        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        if active {
            self.wake.notify_waiters();
        }
        revision
    }

    pub(crate) fn network_available(&self) -> bool {
        self.network_available.load(Ordering::SeqCst)
    }

    pub(crate) fn account_locked(&self) -> bool {
        self.account_locked.load(Ordering::SeqCst)
    }

    /// Whether the account was already locked.
    pub(crate) fn lock_account(&self) -> bool {
        self.account_locked.swap(true, Ordering::SeqCst)
    }

    pub(crate) fn unlock_account(&self) {
        self.account_locked.store(false, Ordering::SeqCst);
    }

    pub(crate) fn sync_suspended(&self) -> bool {
        self.sync_suspended.load(Ordering::SeqCst)
    }

    fn sync_paused(&self) -> bool {
        self.account_locked() || self.sync_suspended()
    }

    fn sync_allowed(&self) -> bool {
        !self.sync_paused() && self.network_available()
    }

    pub(crate) fn subscribe_stores(&self) -> watch::Receiver<bool> {
        self.stores_open.subscribe()
    }

    #[cfg(test)]
    pub(crate) fn stores_open(&self) -> bool {
        *self.stores_open.borrow()
    }

    #[cfg(test)]
    pub(crate) fn set_stores_open(&self, open: bool) {
        self.stores_open.send_replace(open);
    }

    #[cfg(test)]
    pub(crate) fn reading_stores(&self) -> bool {
        self.stores.try_write().is_err()
    }

    #[cfg(test)]
    pub(crate) async fn closing_stores(&self) -> tokio::sync::RwLockWriteGuard<'_, ()> {
        self.stores.write().await
    }
}

impl Transition<'_> {
    pub(crate) fn stores_open(&self) -> bool {
        *self.activity.stores_open.borrow()
    }

    pub(crate) fn sync_allowed(&self) -> bool {
        self.activity.sync_allowed()
    }

    pub(crate) async fn start_sync(&self, sync_service: &SyncService) {
        if self.sync_allowed() {
            sync_service.start().await;
        }
    }

    fn is_current(&self, active: bool, revision: Option<u64>) -> bool {
        revision.is_none_or(|revision| self.activity.revision.load(Ordering::SeqCst) == revision)
            && self.activity.app_active() == active
    }

    fn suspend_sync(&self, suspended: bool) {
        self.activity
            .sync_suspended
            .store(suspended, Ordering::SeqCst);
    }

    #[cfg(target_os = "ios")]
    fn set_stores_open(&self, open: bool) {
        self.activity.stores_open.send_replace(open);
    }
}

impl Core {
    pub fn set_app_active(&self, active: bool) -> u64 {
        self.activity.set_app_active(active)
    }

    pub async fn update_app_active(self: &Arc<Self>, active: bool) {
        self.set_app_active(active);
        self.apply_activity(active, None).await;
    }

    pub(crate) async fn apply_app_activity(self: &Arc<Self>, active: bool) {
        self.apply_activity(active, None).await;
    }

    pub async fn apply_app_activity_if_current(self: &Arc<Self>, active: bool, revision: u64) {
        self.apply_activity(active, Some(revision)).await;
    }

    async fn apply_activity(self: &Arc<Self>, active: bool, revision: Option<u64>) {
        if self.activity.app_active() != active {
            return;
        }
        let transition = self.activity.transition().await;
        if !transition.is_current(active, revision) {
            return;
        }
        let should_sync = active || !self.call_sessions.lock().await.is_empty();
        #[cfg(target_os = "ios")]
        if should_sync && self.activity.sync_suspended() {
            self.reopen_stores(&transition).await;
        }
        transition.suspend_sync(!should_sync);
        let Ok(sync_service) = self.sync_service().await else {
            return;
        };
        if should_sync {
            // Starting a running service is a no-op, but from `Offline` it retries at once.
            self.set_sync_presence(self.sync_presence().await).await;
            transition.start_sync(&sync_service).await;
            drop(transition);
            // Fetches replied-to events, which must not hold up local reads or the next pause.
            Box::pin(self.until_stores_close(self.retry_cached_decryption())).await;
        } else {
            if let Ok(client) = self.client().await {
                self.flush_inbox_locked(&client, &transition).await;
            }
            // Background push fetches must not report the user online.
            self.set_sync_presence(matrix_sdk::ruma::presence::PresenceState::Offline)
                .await;
            sync_service.stop().await;
            #[cfg(target_os = "ios")]
            self.close_stores(&transition).await;
        }
    }

    pub async fn update_network_conditions(self: &Arc<Self>, available: bool, unmetered: bool) {
        let was_available = self
            .activity
            .network_available
            .swap(available, Ordering::SeqCst);
        self.search_network.set_unmetered(unmetered);
        self.refresh_search_peers();
        if available && !was_available && !self.sync_paused() {
            self.apply_activity(self.activity.app_active(), None).await;
        }
    }

    pub(crate) fn watch_activity_health(self: &Arc<Self>) {
        let core = self.clone();
        self.track_session_task(
            spawn(async move {
                loop {
                    matrix_sdk::sleep::sleep(HEALTH_INTERVAL).await;
                    if core
                        .activity
                        .stuck(STUCK_AFTER, STUCK_CONFIRMED_AFTER)
                        .await
                    {
                        tracing::error!("sync has been unable to start or stop for over a minute");
                        return;
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn resume_sync(&self, sync_service: &SyncService) {
        self.activity
            .transition()
            .await
            .start_sync(sync_service)
            .await;
    }

    pub(crate) fn sync_paused(&self) -> bool {
        self.activity.sync_paused()
    }

    pub(crate) fn sync_allowed(&self) -> bool {
        self.activity.sync_allowed()
    }

    async fn set_sync_presence(&self, presence: matrix_sdk::ruma::presence::PresenceState) {
        if let Ok(client) = self.client().await
            && let Err(error) = client.set_presence(presence, None, false).await
        {
            tracing::debug!("sync presence not applied: {error}");
        }
    }

    #[cfg(target_os = "ios")]
    async fn store_clients(&self) -> Vec<matrix_sdk::Client> {
        let mut clients: Vec<_> = self
            .account_clients
            .lock()
            .await
            .values()
            .cloned()
            .collect();
        clients.extend(self.client().await.ok());
        if let Some(pending) = self.pending_login.lock().await.as_ref() {
            clients.push(pending.client.clone());
        }
        clients.extend(
            self.pending_registration
                .lock()
                .await
                .as_ref()
                .map(crate::registration::PendingRegistration::client),
        );
        clients
    }

    #[cfg(target_os = "ios")]
    async fn close_stores(&self, transition: &Transition<'_>) {
        transition.set_stores_open(false);
        let clients = self.store_clients().await;
        let _closing = self.activity.stores.write().await;
        for client in clients {
            if let Err(error) = client.pause().await {
                tracing::warn!("closing the stores before suspension failed: {error}");
            }
        }
    }

    #[cfg(target_os = "ios")]
    async fn reopen_stores(&self, transition: &Transition<'_>) {
        let clients = self.store_clients().await;
        let _reopening = self.activity.stores.write().await;
        for client in clients {
            if let Err(error) = client.resume().await {
                tracing::warn!("reopening the stores after suspension failed: {error}");
            }
        }
        transition.set_stores_open(true);
    }

    pub(crate) async fn wait_for_stores(&self) {
        let _ = self
            .activity
            .subscribe_stores()
            .wait_for(|open| *open)
            .await;
    }

    /// Only short local reads belong here; network work would delay iOS suspension. Never nest
    /// it: a pending close between the two reads would block the inner one forever. Inside a
    /// suspension it would wait for stores that only the next resume reopens.
    pub(crate) async fn with_open_stores<T>(&self, read: impl AsyncFnOnce() -> T) -> T {
        loop {
            self.wait_for_stores().await;
            let _reading = self.activity.stores.read().await;
            if *self.activity.stores_open.borrow() {
                return read().await;
            }
        }
    }

    /// Drops `work` once the stores close, so it must be started again after they reopen.
    pub(crate) async fn until_stores_close<T>(
        &self,
        work: impl std::future::Future<Output = T>,
    ) -> Option<T> {
        let mut open = self.activity.subscribe_stores();
        tokio::select! {
            biased;
            _ = open.wait_for(|open| !*open) => None,
            output = work => Some(output),
        }
    }

    pub(crate) async fn wait_until_active(&self) {
        loop {
            let woken = self.activity.wake.notified();
            if self.activity.app_active() {
                return;
            }
            woken.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::Activity;

    #[tokio::test]
    async fn only_a_transition_that_stays_held_counts_as_stuck() {
        let activity = Activity::new();
        let wait = Duration::from_millis(20);
        assert!(!activity.stuck(wait, wait).await);

        let held = activity.transition().await;
        assert!(activity.stuck(wait, wait).await);

        let release = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            drop(held);
        };
        let (stuck, ()) = tokio::join!(activity.stuck(wait, Duration::from_secs(5)), release);
        assert!(!stuck);
    }
}
