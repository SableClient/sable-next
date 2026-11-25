use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use std::time::Duration;

use crate::tasks::JoinHandleExt;
use matrix_sdk::executor::spawn;
use matrix_sdk_ui::sync_service::SyncService;
use tokio::sync::{Notify, RwLock, watch};

use crate::Core;
use crate::SignedIn;
use crate::supervisor::Supervised;

const PRESENCE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(not(target_family = "wasm"))]
const STORE_PAUSE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(not(target_family = "wasm"))]
const REOPEN_RETRY: Duration = Duration::from_millis(250);
#[cfg(not(target_family = "wasm"))]
const REOPEN_RETRY_MAX: Duration = Duration::from_secs(5);

pub(crate) struct Activity {
    app_active: AtomicBool,
    revision: AtomicU64,
    wake: Notify,
    sync_suspended: AtomicBool,
    network_available: AtomicBool,
    locked_generation: AtomicU64,
    session_generation: AtomicU64,
    /// iOS kills a suspended app that still holds a lock in its App Group container.
    #[cfg(not(target_family = "wasm"))]
    closes_stores: AtomicBool,
    #[cfg(not(target_family = "wasm"))]
    reopen_failures: std::sync::atomic::AtomicU32,
    stores_open: watch::Sender<bool>,
    /// Held for reading by short store reads, so closing the stores waits for them to finish.
    stores: RwLock<()>,
}

impl Activity {
    pub(crate) fn new() -> Self {
        Self {
            app_active: AtomicBool::new(true),
            revision: AtomicU64::new(0),
            wake: Notify::new(),
            sync_suspended: AtomicBool::new(false),
            network_available: AtomicBool::new(true),
            locked_generation: AtomicU64::new(0),
            session_generation: AtomicU64::new(1),
            #[cfg(not(target_family = "wasm"))]
            closes_stores: AtomicBool::new(cfg!(target_os = "ios")),
            #[cfg(not(target_family = "wasm"))]
            reopen_failures: std::sync::atomic::AtomicU32::new(0),
            stores_open: watch::Sender::new(true),
            stores: RwLock::new(()),
        }
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
        self.locked_generation.load(Ordering::SeqCst)
            == self.session_generation.load(Ordering::SeqCst)
    }

    pub(crate) fn lock_account(&self, generation: u64) -> bool {
        self.locked_generation.swap(generation, Ordering::SeqCst) == generation
    }

    pub(crate) fn unlock_account(&self) {
        self.locked_generation.store(0, Ordering::SeqCst);
        self.wake.notify_waiters();
    }

    pub(crate) fn session_started(&self, _: &Supervised<'_>, generation: u64) {
        self.session_generation.store(generation, Ordering::SeqCst);
        self.unlock_account();
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

    #[cfg(not(target_family = "wasm"))]
    fn closes_stores(&self) -> bool {
        self.closes_stores.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn close_stores_when_suspended(&self) {
        self.closes_stores.store(true, Ordering::SeqCst);
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

impl Activity {
    pub(crate) async fn start_sync(&self, _: &Supervised<'_>, sync_service: &SyncService) {
        if self.sync_allowed() {
            sync_service.start().await;
        }
    }

    fn is_current(&self, active: bool, revision: Option<u64>) -> bool {
        revision.is_none_or(|revision| self.revision.load(Ordering::SeqCst) == revision)
            && self.app_active() == active
    }

    fn suspend_sync(&self, _: &Supervised<'_>, suspended: bool) {
        self.sync_suspended.store(suspended, Ordering::SeqCst);
        if !suspended {
            self.wake.notify_waiters();
        }
    }

    #[cfg(not(target_family = "wasm"))]
    fn publish_stores_open(&self, _: &Supervised<'_>, open: bool) {
        self.stores_open.send_replace(open);
    }
}

impl Core {
    pub fn set_app_active(&self, active: bool) -> u64 {
        self.activity.set_app_active(active)
    }

    #[must_use]
    pub fn is_app_active(&self) -> bool {
        self.activity.app_active()
    }

    /// `Suspended` found no session to stop while this one was still starting, and a retry to
    /// reopen the stores ended with the previous session.
    pub(crate) async fn apply_activity_after_session_start(
        self: &Arc<Self>,
        supervised: &Supervised<'_>,
    ) {
        let active = self.activity.app_active();
        if !active || self.activity.sync_suspended() {
            self.reconcile_activity(supervised, active, None).await;
        }
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
        let _ = self
            .supervise("app activity", move |core, supervised| {
                Box::pin(async move {
                    core.reconcile_activity(&supervised, active, revision).await;
                })
            })
            .await;
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "reports the sync state of whichever session is current"
    )]
    pub async fn update_network_conditions(self: &Arc<Self>, available: bool, unmetered: bool) {
        let was_available = self
            .activity
            .network_available
            .swap(available, Ordering::SeqCst);
        self.search_network.set_unmetered(unmetered);
        if available && !was_available && !self.sync_paused() {
            self.apply_activity(self.activity.app_active(), None).await;
        }
        if !available
            && was_available
            && !self.sync_paused()
            && let Some(state) = self
                .session
                .current(|session| session.sync_service.state().get())
        {
            self.emit(crate::protocol::CoreEvent::SyncStatus(
                self.shown_sync_status(state),
            ));
        }
        self.refresh_search_peers().await;
    }

    /// For when the OS reports the network gone and is wrong, which would block every restart.
    pub(crate) async fn retry_sync(self: &Arc<Self>, sync_service: &Arc<SyncService>) {
        self.activity
            .network_available
            .store(true, Ordering::SeqCst);
        self.resume_sync(sync_service).await;
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "tells whether a session's sync is still the current one"
    )]
    pub(crate) fn is_current_sync(&self, sync_service: &Arc<SyncService>) -> bool {
        self.session
            .current(|session| Arc::ptr_eq(&session.sync_service, sync_service))
            .unwrap_or(false)
    }

    pub(crate) async fn resume_sync(self: &Arc<Self>, sync_service: &Arc<SyncService>) {
        let sync_service = sync_service.clone();
        let _ = self
            .supervise("resume sync", move |core, supervised| {
                Box::pin(async move {
                    if core.is_current_sync(&sync_service) {
                        core.activity.start_sync(&supervised, &sync_service).await;
                    }
                })
            })
            .await;
    }

    pub(crate) fn sync_paused(&self) -> bool {
        self.activity.sync_paused()
    }

    pub(crate) fn sync_allowed(&self) -> bool {
        self.activity.sync_allowed()
    }

    #[cfg(not(target_family = "wasm"))]
    #[expect(
        clippy::disallowed_methods,
        reason = "lists the stores to pause, whichever session is current"
    )]
    pub(crate) async fn store_clients(&self) -> Vec<matrix_sdk::Client> {
        let mut clients = self.clients.clients();
        let active = self
            .session
            .current(|session| (session.account_id.clone(), session.client.clone()));
        if let Some((account_id, client)) = active
            && !self.clients.contains(&account_id)
        {
            clients.push(client);
        }
        if let Some(pending) = self.sign_in.pending_login.lock().await.as_ref() {
            clients.push(pending.client.clone());
        }
        clients.extend(
            self.sign_in
                .pending_registration
                .lock()
                .as_ref()
                .map(crate::registration::PendingRegistration::client),
        );
        clients
    }

    #[cfg(not(target_family = "wasm"))]
    #[expect(
        clippy::disallowed_methods,
        reason = "closes the current session's search store on suspension"
    )]
    async fn current_search_store(&self) -> Option<crate::search::Store> {
        let state = self.session.current(|session| session.state.clone())?;
        Some(state.search_store().await)
    }

    #[cfg(not(target_family = "wasm"))]
    async fn close_stores(&self, supervised: &Supervised<'_>) {
        self.activity.publish_stores_open(supervised, false);
        let clients = self.store_clients().await;
        let _closing = self.activity.stores.write().await;
        if let Some(search) = self.current_search_store().await {
            search.close().await;
        }
        for client in clients {
            match matrix_sdk::timeout::timeout(client.pause(), STORE_PAUSE_TIMEOUT).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!("closing the stores before suspension failed: {error}");
                }
                Err(_) => tracing::warn!("closing the stores before suspension timed out"),
            }
        }
    }

    /// Whether every store reopened. A client whose reopen failed stays paused, so the stores
    /// must not be reported open: its locks would never be granted.
    #[cfg(not(target_family = "wasm"))]
    async fn reopen_stores(&self, supervised: &Supervised<'_>) -> bool {
        let clients = self.store_clients().await;
        let _reopening = self.activity.stores.write().await;
        for client in clients {
            let resumed = matrix_sdk::timeout::timeout(client.resume(), STORE_PAUSE_TIMEOUT)
                .await
                .map_err(|_| "timed out".to_owned())
                .and_then(|resumed| resumed.map_err(|error| error.to_string()));
            if let Err(error) = resumed {
                if self.activity.reopen_failures.fetch_add(1, Ordering::SeqCst) == 0 {
                    tracing::error!("reopening the stores after suspension failed: {error}");
                }
                return false;
            }
        }
        self.activity.reopen_failures.store(0, Ordering::SeqCst);
        if let Some(search) = self.current_search_store().await {
            search.reopen().await;
        }
        self.activity.publish_stores_open(supervised, true);
        true
    }

    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::unused_async,
            clippy::unused_async_trait_impl,
            reason = "the web never closes its stores"
        )
    )]
    pub(crate) async fn open_stores_for_session_start(
        &self,
        supervised: &Supervised<'_>,
    ) -> Result<(), crate::protocol::RpcError> {
        #[cfg(not(target_family = "wasm"))]
        if !*self.activity.stores_open.borrow() && !self.reopen_stores(supervised).await {
            return Err(crate::protocol::RpcCode::Unavailable.into());
        }
        #[cfg(target_family = "wasm")]
        let _ = supervised;
        Ok(())
    }

    /// Reopening is idempotent, so the clients that did reopen are safe to resume again. A session
    /// change ends the retries, and `start_session` applies the activity again.
    #[cfg(not(target_family = "wasm"))]
    fn retry_reopening_stores(self: &Arc<Self>, active: bool, revision: Option<u64>) {
        let failures = self.activity.reopen_failures.load(Ordering::SeqCst);
        let delay = REOPEN_RETRY
            .saturating_mul(1 << failures.min(8))
            .min(REOPEN_RETRY_MAX);
        self.emit(crate::protocol::CoreEvent::SyncStatus(
            crate::protocol::SyncStatus::Error {
                message: "Local storage could not be reopened.".to_owned(),
            },
        ));
        let core = self.clone();
        let retry = spawn(async move {
            matrix_sdk::sleep::sleep(delay).await;
            core.apply_activity(active, revision).await;
        });
        if let Ok(session) = self.signed_in() {
            *session.state().reopen_retry.lock() = Some(retry.abort_on_drop());
        }
    }

    pub(crate) async fn wait_for_stores(&self) {
        if !*self.activity.stores_open.borrow() && self.supervisor.on_runner() {
            tracing::error!("a lifecycle job waited for stores only a later job reopens");
            debug_assert!(false, "a lifecycle job waited for closed stores");
        }
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
    pub(crate) async fn until_stores_close<T>(&self, work: impl Future<Output = T>) -> Option<T> {
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

    /// Unlike `wait_until_active`, this returns in the background while a call keeps sync running.
    pub(crate) async fn wait_until_sync_resumes(&self) {
        loop {
            let woken = self.activity.wake.notified();
            if !self.sync_paused() {
                return;
            }
            woken.await;
        }
    }

    async fn reconcile_activity(
        self: &Arc<Self>,
        supervised: &Supervised<'_>,
        active: bool,
        revision: Option<u64>,
    ) {
        if !self.activity.is_current(active, revision) {
            return;
        }
        let signed_in = self.signed_in().ok();
        let in_call = match &signed_in {
            Some(session) => !session.state().calls.lock().await.is_empty(),
            None => false,
        };
        let should_sync = active || in_call;
        #[cfg(not(target_family = "wasm"))]
        if self.activity.closes_stores()
            && should_sync
            && self.activity.sync_suspended()
            && !self.reopen_stores(supervised).await
        {
            self.retry_reopening_stores(active, revision);
            return;
        }
        self.activity.suspend_sync(supervised, !should_sync);
        let Some(signed_in) = signed_in else {
            // A login or registration still in progress holds open stores of its own.
            #[cfg(not(target_family = "wasm"))]
            if !should_sync && self.activity.closes_stores() {
                self.close_stores(supervised).await;
            }
            return;
        };
        let sync_service = signed_in.sync_service();
        if should_sync {
            signed_in
                .set_sync_presence(signed_in.cached_sync_presence().await)
                .await;
            self.activity.start_sync(supervised, &sync_service).await;
            if !self.sync_paused() && !self.activity.network_available() {
                self.emit(crate::protocol::CoreEvent::SyncStatus(
                    self.shown_sync_status(sync_service.state().get()),
                ));
            }
            let session = signed_in.clone();
            *signed_in.state().foreground_work.lock() = Some(
                spawn(async move {
                    session.retry_unsaved_tokens().await;
                    Box::pin(
                        session
                            .core()
                            .until_stores_close(session.retry_cached_decryption()),
                    )
                    .await;
                })
                .abort_on_drop(),
            );
        } else {
            // Background push fetches must not report the user online.
            signed_in
                .set_sync_presence(ruma::presence::PresenceState::Offline)
                .await;
            crate::sync_support::stop(&sync_service).await;
            // After the sync stopped, so nothing it recorded is left unsaved.
            self.flush_inbox_if_open(signed_in.session()).await;
            #[cfg(not(target_family = "wasm"))]
            if self.activity.closes_stores() {
                self.close_stores(supervised).await;
            }
        }
    }
}

impl SignedIn {
    pub(crate) async fn apply_app_activity(&self, active: bool) {
        self.until_ended(self.core().apply_app_activity(active))
            .await;
    }

    pub(crate) async fn reapply_app_activity(&self) {
        self.apply_app_activity(self.core().activity.app_active())
            .await;
    }

    async fn set_sync_presence(&self, presence: ruma::presence::PresenceState) {
        let client = self.client();
        match matrix_sdk::timeout::timeout(
            Box::pin(client.set_presence(presence, None, false)),
            PRESENCE_TIMEOUT,
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::debug!("sync presence not applied: {error}"),
            Err(_) => tracing::debug!("sync presence timed out"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    #[tokio::test]
    async fn waiting_for_sync_ends_when_it_resumes_behind_a_backgrounded_app() {
        let (core, _events) = crate::Core::new(
            "test",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.set_app_active(false);
        core.supervise("test suspend", |core, supervised| {
            Box::pin(async move {
                core.activity.suspend_sync(&supervised, true);
            })
        })
        .await
        .unwrap();
        core.activity.lock_account(1);
        let resumed = tokio::spawn({
            let core = core.clone();
            async move { core.wait_until_sync_resumes().await }
        });
        let parked = || tokio::time::sleep(Duration::from_millis(20));
        parked().await;

        core.activity.unlock_account();
        parked().await;
        assert!(!resumed.is_finished(), "sync is still suspended");

        // A call starts: sync resumes while the app stays in the background.
        core.supervise("test resume", |core, supervised| {
            Box::pin(async move {
                core.activity.suspend_sync(&supervised, false);
            })
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(1), resumed)
            .await
            .expect("resuming sync ends the wait")
            .unwrap();
        assert!(!core.is_app_active());
    }
}
