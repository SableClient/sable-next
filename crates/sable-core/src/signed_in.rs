use std::sync::{Arc, Weak};

use crate::protocol::{RpcCode, RpcError};
use crate::session::Session;
use crate::{Core, SessionState};

#[derive(Clone)]
pub struct SignedIn {
    core: Arc<Core>,
    session: Session,
}

impl SignedIn {
    pub(crate) const fn new(core: Arc<Core>, session: Session) -> Self {
        Self { core, session }
    }

    pub(crate) const fn core(&self) -> &Arc<Core> {
        &self.core
    }

    pub(crate) const fn session(&self) -> &Session {
        &self.session
    }

    pub(crate) const fn client(&self) -> &matrix_sdk::Client {
        &self.session.client
    }

    pub(crate) const fn state(&self) -> &Arc<SessionState> {
        &self.session.state
    }

    pub(crate) fn has_ended(&self) -> bool {
        self.state().ended.is_cancelled()
    }

    pub(crate) fn generation(&self) -> u64 {
        self.state()
            .generation
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// `None` when the session ends before `work` finishes, which is then dropped.
    pub(crate) async fn until_ended<T>(&self, work: impl Future<Output = T>) -> Option<T> {
        self.state().ended.run_until_cancelled(work).await
    }

    pub(crate) fn begin_operation(&self) -> Operation {
        self.state()
            .operations
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Operation(self.state().clone())
    }

    /// `None` when a logout ends the session before `work` finishes, which is then dropped.
    pub(crate) async fn until_discarded<T>(&self, work: impl Future<Output = T>) -> Option<T> {
        self.state().discarded.run_until_cancelled(work).await
    }

    pub(crate) fn downgrade(&self) -> WeakSignedIn {
        WeakSignedIn {
            core: Arc::downgrade(&self.core),
            state: Arc::downgrade(&self.session.state),
        }
    }
}

pub(crate) struct Operation(Arc<SessionState>);

impl Drop for Operation {
    fn drop(&mut self) {
        if self
            .0
            .operations
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst)
            == 1
        {
            self.0.operations_done.notify_waiters();
        }
    }
}

impl SessionState {
    pub(crate) async fn quiesced(&self) -> bool {
        let finished = async {
            loop {
                let done = self.operations_done.notified();
                if self.operations.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                    return;
                }
                done.await;
            }
        };
        let finished = matrix_sdk::timeout::timeout(Box::pin(finished), OPERATIONS_WAIT)
            .await
            .is_ok();
        if !finished {
            tracing::warn!("methods of an ended session are still running");
        }
        finished && self.tasks_stopped.load(std::sync::atomic::Ordering::SeqCst)
    }
}

const OPERATIONS_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Clone)]
pub(crate) struct WeakSignedIn {
    core: Weak<Core>,
    state: Weak<SessionState>,
}

impl WeakSignedIn {
    /// Compared by state, since a new sign-in to the same account is a different session.
    #[expect(
        clippy::disallowed_methods,
        reason = "resolves a weak handle to its session only while that session is current"
    )]
    pub(crate) fn upgrade(&self) -> Option<SignedIn> {
        let core = self.core.upgrade()?;
        let session = core
            .session
            .current(|session| {
                std::ptr::eq(Arc::as_ptr(&session.state), self.state.as_ptr())
                    .then(|| session.clone())
            })
            .flatten()?;
        Some(SignedIn::new(core, session))
    }
}

impl Core {
    #[expect(
        clippy::disallowed_methods,
        reason = "the one place an operation takes its session"
    )]
    pub(crate) fn signed_in(self: &Arc<Self>) -> Result<SignedIn, RpcError> {
        self.session
            .current(|session| {
                (!session.state.ended.is_cancelled())
                    .then(|| SignedIn::new(Arc::clone(self), session.clone()))
            })
            .flatten()
            .ok_or_else(|| RpcCode::NotLoggedIn.into())
    }
}
