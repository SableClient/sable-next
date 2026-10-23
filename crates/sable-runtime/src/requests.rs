use std::{
    collections::HashMap,
    sync::{
        Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
};

use crate::{
    instance::{InstanceId, Origin},
    rt::Task,
    wire::ReqId,
};

struct Pending {
    origin: Origin,
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

    /// `expiry` runs once the request can already be finished.
    pub fn open(&self, origin: Origin, expiry: impl FnOnce(ReqId) -> Task) -> ReqId {
        let req = ReqId(self.next.fetch_add(1, Ordering::Relaxed) + 1);
        self.lock().insert(
            req,
            Pending {
                origin,
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

    /// Across every run of the instance.
    pub fn has(&self, id: &InstanceId) -> bool {
        self.lock().values().any(|request| request.origin.id == *id)
    }

    pub fn lose(&self, matching: impl Fn(&Origin) -> bool) -> Vec<ReqId> {
        let mut pending = self.lock();
        let lost: Vec<ReqId> = pending
            .iter()
            .filter(|(_, request)| matching(&request.origin))
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

    fn origin(slice: &'static str, generation: u64) -> Origin {
        Origin {
            id: InstanceId {
                slice,
                key: "null".to_owned(),
            },
            generation,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_expiry_task_finds_the_request_already_open() {
        let requests = Arc::new(Requests::default());
        let seen = Arc::new(Mutex::new(None));
        let req = requests.open(origin("s", 1), |req| {
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
        let old = requests.open(origin("s", 1), |_| spawn(async {}));
        let new = requests.open(origin("s", 2), |_| spawn(async {}));
        let other = requests.open(origin("t", 1), |_| spawn(async {}));
        assert_eq!(requests.lose(|lost| *lost == origin("s", 1)), [old]);
        assert!(requests.has(&origin("s", 2).id));
        assert!(requests.finish(new));
        assert!(requests.finish(other));
    }
}
