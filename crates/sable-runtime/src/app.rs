//! Routes shell calls to slice instances and moves them from one account to the next.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};

use futures_util::future::join_all;
use sable_protocol::CoreEvent;
use serde_json::Value;
use tokio::sync::{oneshot, watch};
use tracing::Instrument;

use crate::{
    error::AppError,
    instance::{Era, Exit, Instance, InstanceId, Origin, Shared},
    outbox::Outbox,
    ports::Ports,
    registry::{AnySlice, Registry},
    requests::Requests,
    rt::{Activity, Task, spawn, spawn_detached},
    slice::{Interest, Lifetime},
    wire::{
        Batch, Handshake, LostReason, ReqId, Snapshot, SubId, SubscribeRequest, Subscribed, Target,
        WIRE_SCHEMA, Window,
    },
};

const REQUEST_TTL: Duration = Duration::from_secs(30);
/// Panics after which an instance stays down until the account changes.
const MAX_FAILURES: u32 = 3;

struct Entry {
    instance: Arc<dyn Instance>,
    generation: u64,
    refs: usize,
    grace: Option<Task>,
    lifetime: Lifetime,
    interest: Interest,
}

struct Sub {
    id: InstanceId,
    /// The run of the instance this subscription is attached to, or 0 when
    /// that run has gone. It reattaches to a new one on its next resync.
    generation: u64,
    window: Option<Window>,
}

struct Host {
    entries: HashMap<InstanceId, Entry>,
    /// Instances that are on their way out. Nothing new starts under their id
    /// until they are gone, so two runs of one instance never overlap.
    stopping: HashMap<InstanceId, watch::Receiver<bool>>,
    subs: HashMap<SubId, Sub>,
    failures: HashMap<InstanceId, u32>,
    generations: u64,
    era: Era,
}

struct Inner {
    slices: HashMap<&'static str, Box<dyn AnySlice>>,
    shared: Arc<Shared>,
    host: Mutex<Host>,
    next_sub: AtomicU32,
}

struct Held {
    id: InstanceId,
    generation: u64,
    instance: Arc<dyn Instance>,
}

/// Finishes a stop even if the call that began it is dropped.
struct Stopping {
    app: App,
    id: InstanceId,
    done: watch::Sender<bool>,
}

impl Drop for Stopping {
    fn drop(&mut self) {
        self.app.host().stopping.remove(&self.id);
        self.done.send_replace(true);
    }
}

/// Removes the subscription if the call that made it is dropped first.
struct Registered {
    app: App,
    sub: SubId,
    armed: bool,
}

impl Drop for Registered {
    fn drop(&mut self) {
        if self.armed {
            let (app, sub) = (self.app.clone(), self.sub);
            spawn_detached(async move { app.unsubscribe(sub).await });
        }
    }
}

#[derive(Clone)]
pub struct App {
    inner: Arc<Inner>,
}

impl App {
    /// `account` names the account the app starts on; it scopes what instances persist.
    #[must_use]
    pub fn new(registry: Registry, ports: Ports, account: impl Into<String>) -> Self {
        Self::with_activity(registry, ports, account, Arc::default())
    }

    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::arc_with_non_send_sync,
            reason = "wasm keeps the app on one event-loop thread"
        )
    )]
    pub(crate) fn with_activity(
        registry: Registry,
        ports: Ports,
        account: impl Into<String>,
        activity: Arc<Activity>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                slices: registry.into_slices(),
                shared: Arc::new(Shared {
                    ports,
                    outbox: Arc::new(Outbox::default()),
                    requests: Requests::default(),
                    activity,
                }),
                host: Mutex::new(Host {
                    entries: HashMap::new(),
                    stopping: HashMap::new(),
                    subs: HashMap::new(),
                    failures: HashMap::new(),
                    generations: 0,
                    era: Era {
                        epoch: 0,
                        account: account.into().into(),
                    },
                }),
                next_sub: AtomicU32::new(1),
            }),
        }
    }

    fn host(&self) -> MutexGuard<'_, Host> {
        self.inner
            .host
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn slice(&self, name: &str) -> Result<&dyn AnySlice, AppError> {
        self.inner
            .slices
            .get(name)
            .map(Box::as_ref)
            .ok_or(AppError::UnknownSlice)
    }

    #[must_use]
    pub fn handshake(&self) -> Handshake {
        let mut slices: Vec<String> = self
            .inner
            .slices
            .keys()
            .map(|name| (*name).to_owned())
            .collect();
        slices.sort_unstable();
        Handshake {
            schema: WIRE_SCHEMA.to_owned(),
            slices,
        }
    }

    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.inner.shared.outbox.epoch()
    }

    pub async fn next_batch(&self) -> Batch {
        self.inner.shared.outbox.next().await
    }

    #[must_use]
    pub fn try_next_batch(&self) -> Option<Batch> {
        self.inner.shared.outbox.take()
    }

    async fn acquire(&self, target: &Target) -> Result<Held, AppError> {
        let slice = self.slice(&target.slice)?;
        let id = InstanceId {
            slice: slice.name(),
            key: slice.key_id(&target.key)?,
        };
        loop {
            let mut gone = {
                let mut host = self.host();
                match host.stopping.get(&id) {
                    Some(stopping) => stopping.clone(),
                    None => return self.hold(&mut host, slice, &target.key, id),
                }
            };
            let _ = gone.wait_for(|gone| *gone).await;
        }
    }

    fn hold(
        &self,
        host: &mut Host,
        slice: &dyn AnySlice,
        key: &Value,
        id: InstanceId,
    ) -> Result<Held, AppError> {
        if host
            .failures
            .get(&id)
            .is_some_and(|failures| *failures >= MAX_FAILURES)
        {
            return Err(AppError::Stopped);
        }
        if let Some(entry) = host.entries.get_mut(&id) {
            entry.refs += 1;
            entry.grace = None;
            return Ok(Held {
                id,
                generation: entry.generation,
                instance: entry.instance.clone(),
            });
        }
        host.generations += 1;
        let generation = host.generations;
        let weak = Arc::downgrade(&self.inner);
        let exit_id = id.clone();
        let started = slice.start(
            key,
            self.inner.shared.clone(),
            host.era.clone(),
            generation,
            Box::new(move |exit| {
                if exit == Exit::Panicked
                    && let Some(inner) = weak.upgrade()
                {
                    Self { inner }.failed(&exit_id, generation);
                }
            }),
        )?;
        host.entries.insert(
            id.clone(),
            Entry {
                instance: started.instance.clone(),
                generation,
                refs: 1,
                grace: None,
                lifetime: slice.lifetime(),
                interest: slice.interest(),
            },
        );
        Ok(Held {
            id,
            generation,
            instance: started.instance,
        })
    }

    /// A refcounted instance nobody holds is disposed once its grace is over.
    fn release(&self, id: &InstanceId, generation: u64) {
        let mut host = self.host();
        let Some(entry) = host.entries.get_mut(id) else {
            return;
        };
        if entry.generation != generation {
            return;
        }
        entry.refs = entry.refs.saturating_sub(1);
        if entry.refs == 0
            && let Lifetime::RefCounted { grace } = entry.lifetime
        {
            entry.grace = Some(self.grace(id.clone(), generation, grace));
        }
    }

    fn grace(&self, id: InstanceId, generation: u64, grace: Duration) -> Task {
        let weak = Arc::downgrade(&self.inner);
        let clock = self.inner.shared.ports.clock.clone();
        spawn(async move {
            loop {
                clock.sleep(grace).await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let app = Self { inner };
                if !app.inner.shared.requests.has(&id) {
                    app.dispose(&id, generation).await;
                    return;
                }
            }
        })
    }

    async fn dispose(&self, id: &InstanceId, generation: u64) {
        let retired = {
            let mut host = self.host();
            let idle = host
                .entries
                .get(id)
                .is_some_and(|entry| entry.generation == generation && entry.refs == 0);
            idle.then(|| Self::retire_one(&mut host, id)).flatten()
        };
        if let Some(retired) = retired {
            self.stop(retired).await;
        }
    }

    /// The instance counts as stopping until `stop` has seen it out.
    fn retire_one(host: &mut Host, id: &InstanceId) -> Option<Retired> {
        let entry = host.entries.remove(id)?;
        let (done, gone) = watch::channel(false);
        host.stopping.insert(id.clone(), gone);
        Some(Retired {
            id: id.clone(),
            entry,
            done,
        })
    }

    fn retire_all(host: &mut Host) -> Vec<Retired> {
        let ids: Vec<InstanceId> = host.entries.keys().cloned().collect();
        ids.iter()
            .filter_map(|id| Self::retire_one(host, id))
            .collect()
    }

    /// Runs on its own task so that a dropped caller, such as an aborted grace task,
    /// cannot leave the instance half stopped with its id free to start again.
    async fn stop(&self, retired: Retired) {
        let (finished, stopped) = oneshot::channel();
        let app = self.clone();
        spawn_detached(async move {
            let Retired { id, entry, done } = retired;
            let _stopping = Stopping { app, id, done };
            entry.instance.stop().await;
            // The entry's grace task may be the one running this, so it goes last.
            drop(entry.grace);
            let _ = finished.send(());
        });
        let _ = stopped.await;
    }

    /// Subscribers of a panicked instance resync and reattach to a fresh one.
    fn failed(&self, id: &InstanceId, generation: u64) {
        let lagging: Vec<SubId> = {
            let mut host = self.host();
            if host
                .entries
                .get(id)
                .is_none_or(|entry| entry.generation != generation)
            {
                return;
            }
            host.entries.remove(id);
            *host.failures.entry(id.clone()).or_default() += 1;
            host.subs
                .iter()
                .filter(|(_, sub)| sub.id == *id && sub.generation == generation)
                .map(|(sub, _)| *sub)
                .collect()
        };
        for sub in lagging {
            self.inner.shared.outbox.lag(sub);
        }
    }

    /// # Errors
    ///
    /// `UnknownSlice` or `Invalid` for a bad target, `Stopped` when the instance keeps failing.
    pub async fn subscribe(&self, request: SubscribeRequest) -> Result<Subscribed, AppError> {
        let held = self.acquire(&request.target).await?;
        let sub = SubId(self.inner.next_sub.fetch_add(1, Ordering::Relaxed));
        self.host().subs.insert(
            sub,
            Sub {
                id: held.id.clone(),
                generation: held.generation,
                window: request.window,
            },
        );
        let mut registered = Registered {
            app: self.clone(),
            sub,
            armed: true,
        };
        let snapshot = held.instance.subscribe(sub, request.window).await?;
        registered.armed = false;
        Ok(Subscribed { sub, snapshot })
    }

    pub async fn unsubscribe(&self, sub: SubId) {
        let (id, generation, instance) = {
            let mut host = self.host();
            let Some(gone) = host.subs.remove(&sub) else {
                return;
            };
            let instance = host
                .entries
                .get(&gone.id)
                .filter(|entry| entry.generation == gone.generation)
                .map(|entry| entry.instance.clone());
            (gone.id, gone.generation, instance)
        };
        if let Some(instance) = instance {
            instance.detach(sub).await;
        }
        self.inner.shared.outbox.forget(sub);
        self.release(&id, generation);
    }

    /// # Errors
    ///
    /// `UnknownSub` when the subscription is not live.
    pub async fn resync(&self, sub: SubId) -> Result<Snapshot, AppError> {
        let window = self
            .host()
            .subs
            .get(&sub)
            .ok_or(AppError::UnknownSub)?
            .window;
        self.refresh(sub, window).await
    }

    /// `None` follows the whole list.
    ///
    /// # Errors
    ///
    /// `UnknownSub` when the subscription is not live.
    pub async fn range(&self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError> {
        self.refresh(sub, window).await
    }

    async fn refresh(&self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError> {
        let (id, attached) = {
            let host = self.host();
            let current = host.subs.get(&sub).ok_or(AppError::UnknownSub)?;
            let attached = host
                .entries
                .get(&current.id)
                .filter(|entry| entry.generation == current.generation)
                .map(|entry| entry.instance.clone());
            (current.id.clone(), attached)
        };
        if let Some(instance) = attached {
            let snapshot = instance.resync(sub, window).await?;
            if let Some(current) = self.host().subs.get_mut(&sub) {
                current.window = window;
            }
            return Ok(snapshot);
        }

        let target = Target {
            slice: id.slice.to_owned(),
            key: serde_json::from_str(&id.key).map_err(|_| AppError::Invalid)?,
        };
        let held = self.acquire(&target).await?;
        let adopted = {
            let mut host = self.host();
            match host.subs.get_mut(&sub) {
                Some(current) if current.generation != held.generation => {
                    current.generation = held.generation;
                    current.window = window;
                    true
                }
                _ => false,
            }
        };
        if !adopted {
            self.release(&held.id, held.generation);
        }
        let snapshot = match held.instance.subscribe(sub, window).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                if adopted {
                    if let Some(current) = self.host().subs.get_mut(&sub) {
                        current.generation = 0;
                    }
                    self.release(&held.id, held.generation);
                }
                return Err(error);
            }
        };
        if self.host().subs.contains_key(&sub) {
            Ok(snapshot)
        } else {
            held.instance.detach(sub).await;
            Err(AppError::UnknownSub)
        }
    }

    /// # Errors
    ///
    /// `Invalid` when the target or the action is not valid for the slice.
    pub async fn dispatch(&self, target: &Target, action: Value) -> Result<(), AppError> {
        let held = self.acquire(target).await?;
        let sent = held.instance.action(action, None).await;
        self.release(&held.id, held.generation);
        sent
    }

    /// The slice answers with a `Reply` carrying the returned id, or the request is lost after `REQUEST_TTL`.
    ///
    /// # Errors
    ///
    /// `Invalid` when the target or the action is not valid for the slice.
    pub async fn request(&self, target: &Target, action: Value) -> Result<ReqId, AppError> {
        let held = self.acquire(target).await?;
        let weak = Arc::downgrade(&self.inner);
        let clock = self.inner.shared.ports.clock.clone();
        let origin = Origin {
            id: held.id.clone(),
            generation: held.generation,
        };
        let req = self.inner.shared.requests.open(origin, |req| {
            spawn(async move {
                clock.sleep(REQUEST_TTL).await;
                if let Some(inner) = weak.upgrade()
                    && inner.shared.requests.finish(req)
                {
                    inner.shared.lose_reply(req, LostReason::Expired);
                }
            })
        });
        let span = tracing::debug_span!("request", slice = held.id.slice, %req);
        let sent = held
            .instance
            .action(action, Some(req))
            .instrument(span)
            .await;
        self.release(&held.id, held.generation);
        if let Err(error) = sent {
            self.inner.shared.requests.finish(req);
            return Err(error);
        }
        Ok(req)
    }

    pub async fn offer(&self, event: &CoreEvent) {
        let wanting: Vec<Arc<dyn Instance>> = self
            .host()
            .entries
            .values()
            .filter(|entry| entry.interest.wants(event))
            .map(|entry| entry.instance.clone())
            .collect();
        join_all(wanting.iter().map(|instance| instance.core(event))).await;
    }

    /// Every instance of the old account has drained before this returns.
    pub async fn switch_account(&self, account: impl Into<String>) {
        let (retired, subs) = {
            let mut host = self.host();
            host.era = Era {
                epoch: self.inner.shared.outbox.next_epoch(),
                account: account.into().into(),
            };
            host.failures.clear();
            (
                Self::retire_all(&mut host),
                host.subs.keys().copied().collect::<Vec<_>>(),
            )
        };
        self.inner.shared.lose(|_| true, LostReason::EpochChanged);
        join_all(retired.into_iter().map(|retired| self.stop(retired))).await;
        for sub in subs {
            self.inner.shared.outbox.lag(sub);
        }
    }

    /// Writes changed views now and leaves the instances running.
    pub async fn flush(&self) {
        let instances: Vec<Arc<dyn Instance>> = self
            .host()
            .entries
            .values()
            .map(|entry| entry.instance.clone())
            .collect();
        join_all(instances.iter().map(|instance| instance.flush())).await;
    }

    /// Without this, instances stop when the last `App` is dropped, unawaited.
    pub async fn shutdown(&self) {
        let retired = Self::retire_all(&mut self.host());
        join_all(retired.into_iter().map(|retired| self.stop(retired))).await;
    }
}

struct Retired {
    id: InstanceId,
    entry: Entry,
    done: watch::Sender<bool>,
}
