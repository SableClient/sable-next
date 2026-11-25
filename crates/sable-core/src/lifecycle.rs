use std::sync::atomic::{AtomicU64, Ordering};

use crate::supervisor::Supervised;
use crate::{Core, session::Session};

pub(crate) struct SessionSlot {
    current: parking_lot::RwLock<Option<Session>>,
}

impl SessionSlot {
    pub(crate) const fn new() -> Self {
        Self {
            current: parking_lot::RwLock::new(None),
        }
    }

    pub(crate) fn current<T>(&self, read: impl FnOnce(&Session) -> T) -> Option<T> {
        self.current.read().as_ref().map(read)
    }

    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> Option<Session> {
        self.current.read().clone()
    }

    pub(crate) fn write(&self) -> parking_lot::RwLockWriteGuard<'_, Option<Session>> {
        self.current.write()
    }
}

pub(crate) struct Lifecycle {
    current: AtomicU64,
    attempt: AtomicU64,
}

/// Only the newest attempt may become the current session.
pub(crate) struct SessionGeneration {
    value: u64,
}

impl Lifecycle {
    pub(crate) const fn new() -> Self {
        Self {
            current: AtomicU64::new(1),
            attempt: AtomicU64::new(1),
        }
    }

    pub(crate) fn current(&self) -> u64 {
        self.current.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn set_current(&self, generation: u64) {
        self.current.store(generation, Ordering::SeqCst);
    }

    pub(crate) fn claim(&self, _: &Supervised<'_>) -> SessionGeneration {
        SessionGeneration {
            value: self.attempt.fetch_add(1, Ordering::SeqCst) + 1,
        }
    }

    /// Makes every running session task and every pending start stale.
    pub(crate) fn invalidate(&self, _: &Supervised<'_>) {
        let invalidated = self.attempt.fetch_add(1, Ordering::SeqCst) + 1;
        self.current.store(invalidated, Ordering::SeqCst);
    }
}

impl SessionGeneration {
    pub(crate) const fn value(&self) -> u64 {
        self.value
    }

    #[cfg(test)]
    pub(crate) fn is_newest(&self, lifecycle: &Lifecycle) -> bool {
        lifecycle.attempt.load(Ordering::SeqCst) == self.value
    }

    pub(crate) fn commit(&self, lifecycle: &Lifecycle) {
        lifecycle.current.store(self.value, Ordering::SeqCst);
    }
}

impl Core {
    pub(crate) fn is_current(&self, generation: u64) -> bool {
        self.lifecycle.current() == generation
    }
}
