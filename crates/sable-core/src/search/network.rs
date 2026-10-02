use std::future::Future;

use tokio::sync::watch;

#[derive(Clone, Copy)]
struct Policy {
    unmetered_only: bool,
    unmetered: bool,
}

impl Policy {
    const fn allows_crawl(self) -> bool {
        !self.unmetered_only || self.unmetered
    }
}

pub(crate) struct CrawlNetwork(watch::Sender<Policy>);

impl Default for CrawlNetwork {
    fn default() -> Self {
        Self(
            watch::channel(Policy {
                unmetered_only: true,
                unmetered: !cfg!(any(target_os = "android", target_os = "ios")),
            })
            .0,
        )
    }
}

impl CrawlNetwork {
    pub(crate) fn set_unmetered(&self, unmetered: bool) {
        self.0.send_modify(|policy| policy.unmetered = unmetered);
    }

    pub(crate) fn set_unmetered_only(&self, unmetered_only: bool) {
        self.0
            .send_modify(|policy| policy.unmetered_only = unmetered_only);
    }

    pub(crate) fn allows_crawl(&self) -> bool {
        self.0.borrow().allows_crawl()
    }

    pub(crate) async fn run<F: Future>(&self, request: F) -> Option<F::Output> {
        let mut policy = self.0.subscribe();
        tokio::select! {
            biased;
            _ = policy.wait_for(|policy| !policy.allows_crawl()) => None,
            result = request => Some(result),
        }
    }
}
