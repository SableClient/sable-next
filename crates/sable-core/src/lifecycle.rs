use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

use crate::{Core, session::Session};

/// The active session. Looking it up never waits, so code that pins the session, or runs while
/// a teardown is queued behind such a pin, can still reach the client.
pub(crate) struct SessionSlot {
    pinned: RwLock<Option<Session>>,
    current: parking_lot::RwLock<Option<Session>>,
}

pub(crate) struct SessionWrite<'a> {
    session: RwLockWriteGuard<'a, Option<Session>>,
    current: &'a parking_lot::RwLock<Option<Session>>,
}

impl SessionSlot {
    pub(crate) fn new() -> Self {
        Self {
            pinned: RwLock::new(None),
            current: parking_lot::RwLock::new(None),
        }
    }

    pub(crate) fn current<T>(&self, read: impl FnOnce(&Session) -> T) -> Option<T> {
        self.current.read().as_ref().map(read)
    }

    /// Keeps the session from being ended or replaced until the guard drops. Waiting for it
    /// again while holding it deadlocks once a teardown is queued, use `current` for lookups.
    pub(crate) async fn read(&self) -> RwLockReadGuard<'_, Option<Session>> {
        self.pinned.read().await
    }

    pub(crate) async fn write(&self) -> SessionWrite<'_> {
        SessionWrite {
            session: self.pinned.write().await,
            current: &self.current,
        }
    }
}

impl std::ops::Deref for SessionWrite<'_> {
    type Target = Option<Session>;

    fn deref(&self) -> &Self::Target {
        &self.session
    }
}

impl std::ops::DerefMut for SessionWrite<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.session
    }
}

impl Drop for SessionWrite<'_> {
    fn drop(&mut self) {
        self.current.write().clone_from(&self.session);
    }
}

/// Lock order is `restore`, then `activation`, then `swap`.
pub(crate) struct Lifecycle {
    current: AtomicU64,
    attempt: AtomicU64,
    restore: Mutex<()>,
    activation: Mutex<()>,
    swap: Mutex<()>,
}

pub(crate) struct Restoring<'a> {
    _restore: MutexGuard<'a, ()>,
}

pub(crate) struct SessionTransition<'a> {
    lifecycle: &'a Lifecycle,
    _restore: Option<MutexGuard<'a, ()>>,
    _activation: MutexGuard<'a, ()>,
    _swap: MutexGuard<'a, ()>,
}

/// Only the newest attempt may become the current session.
pub(crate) struct SessionGeneration<'a> {
    value: u64,
    lifecycle: &'a Lifecycle,
    _activation: MutexGuard<'a, ()>,
}

pub(crate) struct SessionSwap<'a> {
    value: u64,
    lifecycle: &'a Lifecycle,
    _swap: MutexGuard<'a, ()>,
}

impl Lifecycle {
    pub(crate) fn new() -> Self {
        Self {
            current: AtomicU64::new(1),
            attempt: AtomicU64::new(1),
            restore: Mutex::new(()),
            activation: Mutex::new(()),
            swap: Mutex::new(()),
        }
    }

    pub(crate) fn current(&self) -> u64 {
        self.current.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn set_current(&self, generation: u64) {
        self.current.store(generation, Ordering::SeqCst);
    }

    pub(crate) async fn restoring(&self) -> Restoring<'_> {
        Restoring {
            _restore: self.restore.lock().await,
        }
    }

    pub(crate) async fn claim(&self) -> SessionGeneration<'_> {
        let activation = self.activation.lock().await;
        SessionGeneration {
            value: self.attempt.fetch_add(1, Ordering::SeqCst) + 1,
            lifecycle: self,
            _activation: activation,
        }
    }

    pub(crate) async fn transition(&self) -> SessionTransition<'_> {
        self.lock_transition(None).await
    }

    /// A transition that also keeps a restore or an account switch from starting.
    pub(crate) async fn exclusive_transition(&self) -> SessionTransition<'_> {
        let restore = self.restore.lock().await;
        self.lock_transition(Some(restore)).await
    }

    async fn lock_transition<'a>(
        &'a self,
        restore: Option<MutexGuard<'a, ()>>,
    ) -> SessionTransition<'a> {
        let activation = self.activation.lock().await;
        SessionTransition {
            lifecycle: self,
            _restore: restore,
            _activation: activation,
            _swap: self.swap.lock().await,
        }
    }
}

impl SessionTransition<'_> {
    /// Makes every running session task and every pending start stale.
    pub(crate) fn invalidate(&self) {
        let invalidated = self.lifecycle.attempt.fetch_add(1, Ordering::SeqCst) + 1;
        self.lifecycle.current.store(invalidated, Ordering::SeqCst);
    }
}

impl<'a> SessionGeneration<'a> {
    pub(crate) const fn value(&self) -> u64 {
        self.value
    }

    /// `None` when a transition invalidated this attempt while it was preparing.
    pub(crate) async fn swap(&self) -> Option<SessionSwap<'a>> {
        let swap = self.lifecycle.swap.lock().await;
        (self.lifecycle.attempt.load(Ordering::SeqCst) == self.value).then_some(SessionSwap {
            value: self.value,
            lifecycle: self.lifecycle,
            _swap: swap,
        })
    }
}

impl SessionSwap<'_> {
    pub(crate) fn commit(&self) {
        self.lifecycle.current.store(self.value, Ordering::SeqCst);
    }
}

impl Core {
    pub(crate) fn is_current(&self, generation: u64) -> bool {
        self.lifecycle.current() == generation
    }

    pub(crate) async fn lock_session_transition(&self) -> SessionTransition<'_> {
        self.lifecycle.transition().await
    }

    pub(crate) async fn claim_session_generation(&self) -> SessionGeneration<'_> {
        self.lifecycle.claim().await
    }
}
