//! Routes shell calls to slice instances and moves them from one account to the next.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError, Weak,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};

use futures_util::future::join_all;
use sable_protocol::CoreEvent;
use serde_json::Value;
use tracing::Instrument;

use crate::{
    error::AppError,
    instance::{Exit, Instance, InstanceId, Shared},
    outbox::Outbox,
    ports::Ports,
    registry::{AnySlice, Registry},
    requests::Requests,
    rt::{Activity, Task, spawn},
    slice::{Interest, Lifetime},
    wire::{
        Batch, LostReason, ReqId, Snapshot, SubId, SubscribeRequest, Subscribed, Target, Window,
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
    /// The instance this subscription is attached to. When that instance has
    /// gone, the subscription reattaches to a new one on its next resync.
    generation: u64,
    window: Option<Window>,
}

#[derive(Default)]
struct Host {
    entries: HashMap<InstanceId, Entry>,
    subs: HashMap<SubId, Sub>,
    failures: HashMap<InstanceId, u32>,
    generations: u64,
}

struct Inner {
    slices: HashMap<&'static str, Box<dyn AnySlice>>,
    shared: Arc<Shared>,
    host: Mutex<Host>,
    next_sub: AtomicU32,
}

/// An instance this call has taken a hold on.
struct Held {
    id: InstanceId,
    generation: u64,
    instance: Arc<dyn Instance>,
}

#[derive(Clone)]
pub struct App {
    inner: Arc<Inner>,
}

impl App {
    #[must_use]
    pub fn new(registry: Registry, ports: Ports) -> Self {
        Self::with_activity(registry, ports, Arc::default())
    }

    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::arc_with_non_send_sync,
            reason = "wasm keeps the app on one event-loop thread"
        )
    )]
    pub(crate) fn with_activity(registry: Registry, ports: Ports, activity: Arc<Activity>) -> Self {
        Self {
            inner: Arc::new(Inner {
                slices: registry.into_slices(),
                shared: Arc::new(Shared {
                    ports,
                    outbox: Arc::new(Outbox::default()),
                    requests: Requests::default(),
                    activity,
                }),
                host: Mutex::new(Host::default()),
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
            .ok_or_else(|| AppError::UnknownSlice(name.to_owned()))
    }

    /// The account the runtime is serving. Patches and replies carry it.
    #[must_use]
    pub fn epoch(&self) -> u64 {
        self.inner.shared.outbox.epoch()
    }

    /// The next batch for the shell, waiting for one if there is none.
    pub async fn next_batch(&self) -> Batch {
        self.inner.shared.outbox.next().await
    }

    /// The next batch for the shell, if there is one now.
    #[must_use]
    pub fn try_next_batch(&self) -> Option<Batch> {
        self.inner.shared.outbox.take()
    }

    /// Takes a hold on the instance `target` names, starting it if need be.
    fn acquire(&self, target: &Target) -> Result<Held, AppError> {
        let slice = self.slice(&target.slice)?;
        let id = InstanceId {
            slice: slice.name(),
            key: slice.key_id(&target.key)?,
        };
        let mut host = self.host();
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
            &target.key,
            self.inner.shared.clone(),
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
        let instance = {
            let mut host = self.host();
            match host.entries.get(id) {
                Some(entry) if entry.generation == generation && entry.refs == 0 => {
                    host.entries.remove(id).map(|entry| entry.instance)
                }
                _ => None,
            }
        };
        if let Some(instance) = instance {
            instance.stop().await;
        }
    }

    /// An instance panicked: its subscribers are told to resync, and they
    /// reattach to a fresh instance when they do.
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
    /// `UnknownSlice` or `Invalid` for a target that is not one, `Stopped` when
    /// the instance keeps failing.
    pub async fn subscribe(&self, request: SubscribeRequest) -> Result<Subscribed, AppError> {
        let held = self.acquire(&request.target)?;
        let sub = SubId(self.inner.next_sub.fetch_add(1, Ordering::Relaxed));
        match held.instance.subscribe(sub, request.window).await {
            Ok(snapshot) => {
                self.host().subs.insert(
                    sub,
                    Sub {
                        id: held.id,
                        generation: held.generation,
                        window: request.window,
                    },
                );
                Ok(Subscribed { sub, snapshot })
            }
            Err(error) => {
                self.release(&held.id, held.generation);
                Err(error)
            }
        }
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
        self.inner.shared.outbox.forget(sub);
        if let Some(instance) = instance {
            instance.detach(sub).await;
            self.release(&id, generation);
        }
    }

    /// The current state, for a subscriber that lost track of it.
    ///
    /// # Errors
    ///
    /// `UnknownSub` when the subscription is not live.
    pub async fn resync(&self, sub: SubId) -> Result<Snapshot, AppError> {
        self.refresh(sub, None).await
    }

    /// Moves the window of a list subscription and returns the state in it.
    ///
    /// # Errors
    ///
    /// `UnknownSub` when the subscription is not live.
    pub async fn range(&self, sub: SubId, window: Window) -> Result<Snapshot, AppError> {
        self.refresh(sub, Some(window)).await
    }

    async fn refresh(&self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError> {
        let (id, generation, kept, attached) = {
            let host = self.host();
            let current = host.subs.get(&sub).ok_or(AppError::UnknownSub)?;
            let attached = host
                .entries
                .get(&current.id)
                .filter(|entry| entry.generation == current.generation)
                .map(|entry| entry.instance.clone());
            (
                current.id.clone(),
                current.generation,
                current.window,
                attached,
            )
        };
        let window = window.or(kept);
        let (snapshot, generation) = if let Some(instance) = attached {
            (instance.resync(sub, window).await?, generation)
        } else {
            let target = Target {
                slice: id.slice.to_owned(),
                key: serde_json::from_str(&id.key).map_err(|_| AppError::Invalid)?,
            };
            let held = self.acquire(&target)?;
            match held.instance.subscribe(sub, window).await {
                Ok(snapshot) => (snapshot, held.generation),
                Err(error) => {
                    self.release(&held.id, held.generation);
                    return Err(error);
                }
            }
        };
        if let Some(current) = self.host().subs.get_mut(&sub) {
            current.window = window;
            current.generation = generation;
        }
        Ok(snapshot)
    }

    /// Sends an action to an instance, starting it if need be.
    ///
    /// # Errors
    ///
    /// `Invalid` when the target or the action is not valid for the slice.
    pub async fn dispatch(&self, target: &Target, action: Value) -> Result<(), AppError> {
        let held = self.acquire(target)?;
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
        let held = self.acquire(target)?;
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        let clock = self.inner.shared.ports.clock.clone();
        let req = self.inner.shared.requests.open(held.id.clone(), |req| {
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
        for instance in wanting {
            instance.core(event).await;
        }
    }

    /// Moves to the next account. Every instance of the old one is disposed and
    /// has drained before this returns, its requests are lost, and its
    /// subscribers are told to resync into the new one.
    pub async fn switch_account(&self) {
        self.inner.shared.outbox.next_epoch();
        let (instances, subs): (Vec<Arc<dyn Instance>>, Vec<SubId>) = {
            let mut host = self.host();
            host.failures.clear();
            let instances = host
                .entries
                .drain()
                .map(|(_, entry)| entry.instance)
                .collect();
            (instances, host.subs.keys().copied().collect())
        };
        for sub in subs {
            self.inner.shared.outbox.lag(sub);
        }
        self.inner.shared.lose(|_| true, LostReason::EpochChanged);
        join_all(instances.iter().map(|instance| instance.stop())).await;
    }
}
