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
    expiry: Option<Task>,
}

/// Only whoever removes a request (answer, expiry or loss) replies to it.
#[derive(Default)]
pub struct Requests {
    next: AtomicU64,
    pending: Mutex<HashMap<ReqId, Pending>>,
}

impl Requests {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ReqId, Pending>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers a request to `instance`. `expiry` makes the task that gives up on
    /// it, and runs once the request can already be finished.
    pub fn open(&self, instance: InstanceId, expiry: impl FnOnce(ReqId) -> Task) -> ReqId {
        let req = ReqId(self.next.fetch_add(1, Ordering::Relaxed) + 1);
        self.lock().insert(
            req,
            Pending {
                instance,
                expiry: None,
            },
        );
        let expiry = expiry(req);
        if let Some(pending) = self.lock().get_mut(&req) {
            pending.expiry.replace(expiry);
        }
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::rt::spawn;

    fn id() -> InstanceId {
        InstanceId {
            slice: "s",
            key: "null".to_owned(),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_expiry_task_finds_the_request_already_open() {
        let requests = Arc::new(Requests::default());
        let seen = Arc::new(Mutex::new(None));
        let req = requests.open(id(), |req| {
            let (requests, seen) = (requests.clone(), seen.clone());
            spawn(async move {
                *seen.lock().unwrap() = Some(requests.finish(req));
            })
        });
        tokio::task::yield_now().await;
        assert_eq!(*seen.lock().unwrap(), Some(true));
        assert!(!requests.finish(req), "only one finisher wins");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn losing_takes_only_the_requests_that_match() {
        let requests = Requests::default();
        let other = InstanceId {
            slice: "t",
            key: "null".to_owned(),
        };
        let mine = requests.open(id(), |_| spawn(async {}));
        let theirs = requests.open(other.clone(), |_| spawn(async {}));
        assert_eq!(requests.lose(|lost| *lost == id()), [mine]);
        assert!(requests.has(&other));
        assert!(requests.finish(theirs));
    }
}
