use std::marker::PhantomData;
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::executor::spawn;
use tokio::sync::{mpsc, oneshot};

use crate::Core;
use crate::protocol::{RpcCode, RpcError};

const STALLED_JOB: Duration = Duration::from_secs(20);
/// Well past the bounded waits of one job together.
const JOB_DEADLINE: Duration = Duration::from_secs(120);
const RECOVERY_DEADLINE: Duration = Duration::from_secs(20);

pub(crate) struct Supervised<'job> {
    job: PhantomData<&'job ()>,
}

#[cfg(not(target_family = "wasm"))]
pub(crate) type JobFuture<'job, T> = futures_util::future::BoxFuture<'job, T>;
#[cfg(target_family = "wasm")]
pub(crate) type JobFuture<'job, T> = futures_util::future::LocalBoxFuture<'job, T>;

#[cfg(not(target_family = "wasm"))]
type Job = Box<dyn for<'job> FnOnce(Arc<Core>, Supervised<'job>) -> JobFuture<'job, ()> + Send>;
#[cfg(target_family = "wasm")]
type Job = Box<dyn for<'job> FnOnce(Arc<Core>, Supervised<'job>) -> JobFuture<'job, ()>>;

struct Queued {
    name: &'static str,
    job: Job,
}

pub(crate) struct Supervisor {
    /// Started again when the runtime it ran on has shut down, as a push's own runtime does.
    jobs: parking_lot::Mutex<Option<mpsc::UnboundedSender<Queued>>>,
    running: parking_lot::Mutex<Option<u64>>,
    #[cfg(test)]
    deadline: parking_lot::Mutex<Duration>,
    unbounded: std::sync::atomic::AtomicUsize,
    #[cfg(not(target_family = "wasm"))]
    runner: parking_lot::Mutex<Option<tokio::task::Id>>,
    #[cfg(not(target_family = "wasm"))]
    home: Option<tokio::runtime::Handle>,
}

impl Supervisor {
    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::missing_const_for_fn,
            reason = "native builds read the runtime the core is made on"
        )
    )]
    pub(crate) fn new() -> Self {
        Self {
            jobs: parking_lot::Mutex::new(None),
            running: parking_lot::Mutex::new(None),
            #[cfg(test)]
            deadline: parking_lot::Mutex::new(JOB_DEADLINE),
            unbounded: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(not(target_family = "wasm"))]
            runner: parking_lot::Mutex::new(None),
            #[cfg(not(target_family = "wasm"))]
            home: tokio::runtime::Handle::try_current().ok(),
        }
    }

    /// `None` when the queue has to start and no runtime can run it, as on a thread a platform
    /// callback uses.
    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::unnecessary_wraps,
            reason = "the web always runs on its event loop"
        )
    )]
    fn sender(&self, core: &Arc<Core>) -> Option<mpsc::UnboundedSender<Queued>> {
        let mut jobs = self.jobs.lock();
        if let Some(sender) = jobs.as_ref().filter(|sender| !sender.is_closed()) {
            return Some(sender.clone());
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        let runner = run(Arc::downgrade(core), receiver);
        #[cfg(not(target_family = "wasm"))]
        match (&self.home, tokio::runtime::Handle::try_current()) {
            (Some(home), _) => drop(home.spawn(runner)),
            (None, Ok(_)) => drop(spawn(runner)),
            (None, Err(_)) => return None,
        }
        #[cfg(target_family = "wasm")]
        drop(spawn(runner));
        *jobs = Some(sender.clone());
        Some(sender)
    }

    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::unused_self,
            reason = "the web has no task ids, so it marks the job while it is polled"
        )
    )]
    pub(crate) fn on_runner(&self) -> bool {
        #[cfg(not(target_family = "wasm"))]
        return tokio::task::try_id().is_some_and(|task| *self.runner.lock() == Some(task));
        #[cfg(target_family = "wasm")]
        POLLING_JOB.get()
    }

    /// Until the guard drops, the running job is not cancelled at its deadline. For slow local
    /// work that must not be cut short and tried again, never for a wait on something else.
    pub(crate) fn unbounded_step(&self) -> impl Drop + '_ {
        struct Step<'supervisor>(&'supervisor std::sync::atomic::AtomicUsize);
        impl Drop for Step<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        self.unbounded
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Step(&self.unbounded)
    }

    fn in_unbounded_step(&self) -> bool {
        self.unbounded.load(std::sync::atomic::Ordering::SeqCst) > 0
    }

    fn nested(&self, name: &'static str) -> bool {
        let nested = self.on_runner();
        if nested {
            tracing::error!(job = name, "a lifecycle job waited for another one");
            debug_assert!(
                false,
                "the lifecycle job {name} was queued from inside a job"
            );
        }
        nested
    }
}

#[cfg(target_family = "wasm")]
thread_local! {
    /// The web's one thread polls a job and whatever the job calls in the same turn.
    static POLLING_JOB: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(target_family = "wasm")]
struct PolledJob<'job>(JobFuture<'job, ()>);

#[cfg(target_family = "wasm")]
impl Future for PolledJob<'_> {
    type Output = ();

    fn poll(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<()> {
        POLLING_JOB.set(true);
        let polled = self.0.as_mut().poll(context);
        POLLING_JOB.set(false);
        polled
    }
}

async fn run(core: std::sync::Weak<Core>, mut jobs: mpsc::UnboundedReceiver<Queued>) {
    #[cfg(not(target_family = "wasm"))]
    if let (Some(core), Some(task)) = (core.upgrade(), tokio::task::try_id()) {
        *core.supervisor.runner.lock() = Some(task);
    }
    if let Some(core) = core.upgrade() {
        *core.supervisor.running.lock() = None;
    }
    let mut next = 0_u64;
    while let Some(Queued { name, job }) = jobs.recv().await {
        let Some(core) = core.upgrade() else {
            return;
        };
        next += 1;
        *core.supervisor.running.lock() = Some(next);
        let watchdog = report_stalled(&core, next, name);
        let before = core.session_marker();
        let running = job(core.clone(), Supervised { job: PhantomData });
        #[cfg(target_family = "wasm")]
        let running = PolledJob(running);
        let mut running = running;
        #[cfg(test)]
        let deadline = *core.supervisor.deadline.lock();
        #[cfg(not(test))]
        let deadline = JOB_DEADLINE;
        let cancelled = loop {
            match matrix_sdk::timeout::timeout(&mut running, deadline).await {
                Ok(()) => break false,
                Err(_) if core.supervisor.in_unbounded_step() => {}
                Err(_) => break true,
            }
        };
        drop(running);
        if cancelled {
            let step = core.current_session_step();
            tracing::error!(
                reported = true,
                job = name,
                step,
                "a lifecycle job was cancelled at its deadline"
            );
        }
        let recovery = core.recover_after_job(&Supervised { job: PhantomData }, cancelled, before);
        #[cfg(target_family = "wasm")]
        let recovery = PolledJob(Box::pin(recovery));
        if matrix_sdk::timeout::timeout(Box::pin(recovery), RECOVERY_DEADLINE)
            .await
            .is_err()
        {
            core.drop_session_after_failed_recovery();
        }
        drop(watchdog);
        *core.supervisor.running.lock() = None;
        core.session_step("idle");
    }
}

fn report_stalled(core: &Arc<Core>, job: u64, name: &'static str) -> impl Drop {
    use crate::tasks::JoinHandleExt as _;

    let core = Arc::downgrade(core);
    spawn(async move {
        matrix_sdk::sleep::sleep(STALLED_JOB).await;
        if let Some(core) = core.upgrade()
            && *core.supervisor.running.lock() == Some(job)
        {
            let step = core.current_session_step();
            tracing::warn!(
                reported = true,
                job = name,
                step,
                "a lifecycle job has not finished"
            );
        }
    })
    .abort_on_drop()
}

impl Core {
    pub(crate) async fn supervise<T, F>(
        self: &Arc<Self>,
        name: &'static str,
        job: F,
    ) -> Result<T, RpcError>
    where
        F: for<'job> FnOnce(Arc<Core>, Supervised<'job>) -> JobFuture<'job, T>
            + MaybeSend
            + 'static,
        T: MaybeSend + 'static,
    {
        if self.supervisor.nested(name) {
            return Err(RpcCode::Unavailable.into());
        }
        let (reply, result) = oneshot::channel();
        let job: Job = Box::new(move |core, supervised| {
            Box::pin(async move {
                let _ = reply.send(job(core, supervised).await);
            })
        });
        let Some(Ok(())) = self
            .supervisor
            .sender(self)
            .map(|jobs| jobs.send(Queued { name, job }))
        else {
            return Err(queue_stopped(name));
        };
        result.await.map_err(|_| queue_stopped(name))
    }

    pub(crate) fn supervise_later<F>(self: &Arc<Self>, name: &'static str, job: F)
    where
        F: for<'job> FnOnce(Arc<Core>, Supervised<'job>) -> JobFuture<'job, ()>
            + MaybeSend
            + 'static,
    {
        let job: Job = Box::new(job);
        let queued = self
            .supervisor
            .sender(self)
            .is_some_and(|jobs| jobs.send(Queued { name, job }).is_ok());
        if !queued {
            tracing::error!(job = name, "no lifecycle queue to run the job on");
        }
    }
}

fn queue_stopped(job: &'static str) -> RpcError {
    tracing::warn!(job, "the lifecycle queue has stopped");
    RpcCode::Unavailable.into()
}

#[cfg(not(target_family = "wasm"))]
pub(crate) trait MaybeSend: Send {}
#[cfg(not(target_family = "wasm"))]
impl<T: Send> MaybeSend for T {}
#[cfg(target_family = "wasm")]
pub(crate) trait MaybeSend {}
#[cfg(target_family = "wasm")]
impl<T> MaybeSend for T {}

#[cfg(test)]
impl Core {
    pub(crate) fn set_job_deadline(&self, deadline: Duration) {
        *self.supervisor.deadline.lock() = deadline;
    }

    pub(crate) async fn hold_supervisor(self: &Arc<Self>) -> oneshot::Sender<()> {
        let (started, running) = oneshot::channel();
        let (release, released) = oneshot::channel::<()>();
        self.supervise_later("test hold", move |_, _| {
            Box::pin(async move {
                let _ = started.send(());
                let _ = released.await;
            })
        });
        running.await.unwrap();
        release
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use crate::Core;
    use crate::store::MemorySessionStore;

    fn core() -> Arc<Core> {
        Core::new("supervisor", Box::new(MemorySessionStore::default())).0
    }

    #[tokio::test]
    async fn jobs_run_one_at_a_time_in_the_order_they_were_queued() {
        let core = core();
        let order = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let release = core.hold_supervisor().await;
        for job in 1..=3 {
            let order = order.clone();
            core.supervise_later("ordered", move |_, _| {
                Box::pin(async move {
                    order.lock().push(job);
                    tokio::task::yield_now().await;
                    order.lock().push(job);
                })
            });
        }
        drop(release);
        core.supervise("settle", |_, _| Box::pin(async {}))
            .await
            .unwrap();
        assert_eq!(*order.lock(), [1, 1, 2, 2, 3, 3]);
    }

    #[tokio::test]
    async fn a_job_knows_it_runs_on_the_queue() {
        let core = core();
        assert!(!core.supervisor.on_runner());
        let inside = core
            .supervise("outer", |core, _| {
                Box::pin(async move { core.supervisor.on_runner() })
            })
            .await
            .unwrap();
        assert!(inside);
    }

    #[tokio::test]
    async fn a_job_past_its_deadline_is_cancelled_and_the_queue_goes_on() {
        let core = core();
        core.set_job_deadline(std::time::Duration::from_millis(50));
        let stuck = core
            .supervise("stuck", |_, _| Box::pin(std::future::pending::<()>()))
            .await;
        stuck.unwrap_err();
        assert_eq!(
            core.supervise("after", |_, _| Box::pin(async { 7 }))
                .await
                .unwrap(),
            7
        );
    }

    #[tokio::test]
    async fn a_step_marked_unbounded_outlasts_the_deadline() {
        let core = core();
        core.set_job_deadline(std::time::Duration::from_millis(20));
        let finished = core
            .supervise("slow upgrade", |core, _| {
                Box::pin(async move {
                    let _upgrading = core.supervisor.unbounded_step();
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    7
                })
            })
            .await;
        assert_eq!(finished.unwrap(), 7);
    }

    #[test]
    fn the_queue_starts_again_once_the_runtime_it_ran_on_is_gone() {
        let core = core();
        let runtime = || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
        };
        let first = runtime();
        first.block_on(async {
            core.supervise("first", |_, _| Box::pin(async {}))
                .await
                .unwrap();
        });
        drop(first);
        let second = runtime();
        let answer = second.block_on(async {
            core.supervise("second", |_, _| Box::pin(async { 2 }))
                .await
                .unwrap()
        });
        assert_eq!(answer, 2);
    }
}
