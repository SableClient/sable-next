use std::{
    collections::HashMap,
    sync::{
        Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
};

use crate::{instance::InstanceId, rt::Task, wire::ReqId};

struct Pending {
    instance: InstanceId,
    _expiry: Task,
}

/// The requests that have not been answered. A request leaves this when it is
/// answered, expires, or is lost, and only the one that removes it replies.
#[derive(Default)]
pub struct Requests {
    next: AtomicU64,
    pending: Mutex<HashMap<ReqId, Pending>>,
}

impl Requests {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ReqId, Pending>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers a request to `instance`. `expiry` is the task that gives up on it.
    pub fn open(&self, instance: InstanceId, expiry: impl FnOnce(ReqId) -> Task) -> ReqId {
        let req = ReqId(self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let pending = Pending {
            instance,
            _expiry: expiry(req),
        };
        self.lock().insert(req, pending);
        req
    }

    /// Returns whether the request was still waiting.
    pub fn finish(&self, req: ReqId) -> bool {
        self.lock().remove(&req).is_some()
    }

    pub fn has(&self, instance: &InstanceId) -> bool {
        self.lock()
            .values()
            .any(|request| request.instance == *instance)
    }

    pub fn lose(&self, matching: impl Fn(&InstanceId) -> bool) -> Vec<ReqId> {
        let mut pending = self.lock();
        let lost: Vec<ReqId> = pending
            .iter()
            .filter(|(_, request)| matching(&request.instance))
            .map(|(req, _)| *req)
            .collect();
        for req in &lost {
            pending.remove(req);
        }
        lost
    }
}
