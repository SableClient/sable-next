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
    instance::{Era, Instance, InstanceId, Origin, Shared},
    outbox::Outbox,
    ports::Ports,
    registry::{AnySlice, Registry},
    requests::Requests,
    rt::{Activity, Task, sleep, spawn, spawn_detached},
    slice::{Interest, Lifetime},
    wire::{
        Batch, Handshake, LostReason, ReqId, Snapshot, SubId, SubscribeRequest, Subscribed, Target,
        WIRE_SCHEMA, Window,
    },
};

const REQUEST_TTL: Duration = Duration::from_secs(30);

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
    paused: Option<watch::Sender<bool>>,
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
    #[must_use]
    pub fn new(registry: Registry, ports: Ports, account: impl Into<String>) -> Self {
        Self::build(registry, ports, account, Activity::default())
    }

    #[cfg(any(test, feature = "testing"))]
    pub(crate) fn with_activity(
        registry: Registry,
        ports: Ports,
        account: impl Into<String>,
        activity: Activity,
    ) -> Self {
        Self::build(registry, ports, account, activity)
    }

    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::arc_with_non_send_sync,
            reason = "wasm keeps the app on one event-loop thread"
        )
    )]
    fn build(
        registry: Registry,
        ports: Ports,
        account: impl Into<String>,
        activity: Activity,
    ) -> Self {
        let inner = Arc::new(Inner {
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
                paused: None,
                generations: 0,
                era: Era {
                    epoch: 0,
                    account: account.into().into(),
                },
            }),
            next_sub: AtomicU32::new(1),
        });
        Self { inner }
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

    #[cfg(any(test, feature = "testing"))]
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.inner.shared.outbox.epoch()
    }

    pub async fn next_batch(&self) -> Batch {
        self.inner.shared.outbox.next().await
    }

    #[cfg(any(test, feature = "testing"))]
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
                if let Some(paused) = &host.paused {
                    paused.subscribe()
                } else if let Some(stopping) = host.stopping.get(&id) {
                    stopping.clone()
                } else {
                    return self.hold(&mut host, slice, &target.key, id);
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
        let ended = Box::new(move |origin: Origin| {
            if let Some(inner) = weak.upgrade() {
                let app = Self { inner };
                let mut host = app.host();
                if host
                    .entries
                    .get(&origin.id)
                    .is_some_and(|entry| entry.generation == origin.generation)
                {
                    host.entries.remove(&origin.id);
                    for (sub, attached) in &host.subs {
                        if attached.id == origin.id && attached.generation == origin.generation {
                            app.inner.shared.outbox.lag(*sub);
                        }
                    }
                }
            }
        });
        let started = slice.start(
            key,
            self.inner.shared.clone(),
            host.era.clone(),
            generation,
            ended,
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
        spawn(async move {
            loop {
                sleep(grace).await;
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

    pub async fn resync(&self, sub: SubId) -> Result<Snapshot, AppError> {
        let window = self
            .host()
            .subs
            .get(&sub)
            .ok_or(AppError::UnknownSub)?
            .window;
        self.refresh(sub, window).await
    }

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

    pub async fn dispatch(&self, target: &Target, action: Value) -> Result<(), AppError> {
        let held = self.acquire(target).await?;
        let sent = held.instance.action(action, None).await;
        self.release(&held.id, held.generation);
        sent
    }

    pub async fn request(&self, target: &Target, action: Value) -> Result<ReqId, AppError> {
        let held = self.acquire(target).await?;
        let weak = Arc::downgrade(&self.inner);
        let origin = Origin {
            id: held.id.clone(),
            generation: held.generation,
        };
        let req = self.inner.shared.requests.open(origin, |req| {
            spawn(async move {
                sleep(REQUEST_TTL).await;
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
        self.offer_batch(std::slice::from_ref(event)).await;
    }

    pub async fn offer_batch(&self, events: &[CoreEvent]) {
        let deliveries = {
            let host = self.host();
            let mut deliveries = Vec::new();
            for event in events {
                let wanting: Vec<Arc<dyn Instance>> = {
                    let mut routes: HashMap<&str, Option<String>> = HashMap::new();
                    host.entries
                        .iter()
                        .filter(|(_, entry)| entry.interest.wants(event))
                        .filter(|(id, _)| {
                            routes
                                .entry(id.slice)
                                .or_insert_with(|| {
                                    self.slice(id.slice)
                                        .ok()
                                        .and_then(|slice| slice.event_key(event))
                                })
                                .as_ref()
                                .is_none_or(|key| *key == id.key)
                        })
                        .map(|(_, entry)| entry.instance.clone())
                        .collect()
                };
                if wanting.is_empty() {
                    continue;
                }
                let event = Arc::new(event.clone());
                deliveries.extend(wanting.into_iter().map(|instance| {
                    let event = event.clone();
                    async move { instance.core(event).await }
                }));
            }
            deliveries
        };
        join_all(deliveries).await;
    }

    pub async fn switch_account(&self, account: impl Into<String>) {
        let (retired, subs) = {
            let mut host = self.host();
            host.era = Era {
                epoch: self.inner.shared.outbox.next_epoch(),
                account: account.into().into(),
            };
            (
                Self::retire_all(&mut host),
                host.subs.keys().copied().collect::<Vec<_>>(),
            )
        };
        self.inner.shared.lose(|_| true, LostReason::EpochChanged);
        join_all(retired.into_iter().map(|retired| self.stop(retired))).await;
        self.wait_stopping().await;
        for sub in subs {
            self.inner.shared.outbox.lag(sub);
        }
        let paused = self.host().paused.take();
        if let Some(paused) = paused {
            paused.send_replace(true);
        }
    }

    async fn wait_stopping(&self) {
        let waiting = {
            let host = self.host();
            join_all(host.stopping.values().cloned().map(|mut gone| async move {
                let _ = gone.wait_for(|gone| *gone).await;
            }))
        };
        waiting.await;
    }

    pub async fn flush(&self) {
        let instances: Vec<Arc<dyn Instance>> = self
            .host()
            .entries
            .values()
            .map(|entry| entry.instance.clone())
            .collect();
        join_all(instances.iter().map(|instance| instance.flush())).await;
    }

    pub async fn shutdown(&self) {
        let retired = {
            let mut host = self.host();
            host.paused.get_or_insert_with(|| watch::channel(false).0);
            Self::retire_all(&mut host)
        };
        join_all(retired.into_iter().map(|retired| self.stop(retired))).await;
        self.wait_stopping().await;
    }
}

struct Retired {
    id: InstanceId,
    entry: Entry,
    done: watch::Sender<bool>,
}
