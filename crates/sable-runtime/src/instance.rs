use std::{
    collections::{HashMap, VecDeque},
    marker::PhantomData,
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use futures_util::StreamExt;
use sable_protocol::CoreEvent;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::{
    cmd::{Cmd, Effect, Name},
    error::AppError,
    outbox::Outbox,
    ports::Ports,
    registry::AnySlice,
    requests::Requests,
    rt::{Activity, BoxOnce, Busy, SendOutsideWasm, SyncOutsideWasm, Task, spawn, spawn_detached},
    slice::{Cx, Interest, Lifetime, Render, Slice},
    wire::{AppEvent, LostReason, Outcome, ReplyError, ReqId, Snapshot, SubId, Window},
};

/// Messages an instance reads before it publishes what they changed.
const BATCH: usize = 256;
/// Messages that wait for one instance; senders wait when it is full.
const INBOX: usize = 256;
/// How long a persisted view waits for further changes before it is written.
const PERSIST_DELAY: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct InstanceId {
    pub slice: &'static str,
    pub key: String,
}

/// What every instance shares with the host.
pub struct Shared {
    pub ports: Ports,
    pub outbox: Arc<Outbox>,
    pub requests: Requests,
    pub activity: Arc<Activity>,
}

impl Shared {
    /// Answers the requests of the instances `matching` with `Lost`.
    pub fn lose(&self, matching: impl Fn(&InstanceId) -> bool, reason: LostReason) {
        for req in self.requests.lose(matching) {
            self.lose_reply(req, reason);
        }
    }

    pub fn lose_reply(&self, req: ReqId, reason: LostReason) {
        self.reply(
            req,
            Outcome::Error {
                error: ReplyError::Lost { reason },
            },
        );
    }

    pub fn reply(&self, req: ReqId, outcome: Outcome) {
        self.outbox.push(AppEvent::Reply {
            req,
            epoch: self.outbox.epoch(),
            outcome,
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    Stopped,
    Panicked,
}

/// Called once, when the instance's task has ended and its requests are lost.
pub type ExitHook = BoxOnce<Exit, ()>;

pub struct Started {
    pub key: String,
    pub instance: Arc<dyn Instance>,
}

/// An instance without its slice's types, for the host to route to.
#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
pub trait Instance: SendOutsideWasm + SyncOutsideWasm {
    async fn subscribe(&self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError>;

    async fn resync(&self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError>;

    async fn detach(&self, sub: SubId);

    async fn action(&self, action: Value, req: Option<ReqId>) -> Result<(), AppError>;

    async fn core(&self, event: &CoreEvent);

    /// Returns once the instance has disposed, drained and persisted.
    async fn stop(&self);
}

enum Msg<S: Slice> {
    Input {
        input: S::Input,
        req: Option<ReqId>,
        _busy: Busy,
    },
    Timer {
        name: Name,
        generation: u64,
        input: S::Input,
        _busy: Busy,
    },
    Item {
        name: Name,
        generation: u64,
        input: S::Input,
        _busy: Busy,
    },
    Subscribe {
        sub: SubId,
        window: Option<Window>,
        reply: oneshot::Sender<Result<Snapshot, AppError>>,
        _busy: Busy,
    },
    Resync {
        sub: SubId,
        window: Option<Window>,
        reply: oneshot::Sender<Result<Snapshot, AppError>>,
        _busy: Busy,
    },
    Detach {
        sub: SubId,
        _busy: Busy,
    },
    Persist,
    Stop(oneshot::Sender<()>),
}

struct Handle<S: Slice> {
    tx: mpsc::Sender<Msg<S>>,
    activity: Arc<Activity>,
}

impl<S: Slice> Handle<S> {
    async fn send(&self, msg: Msg<S>) -> Result<(), AppError> {
        self.tx.send(msg).await.map_err(|_| AppError::Stopped)
    }

    async fn ask(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<Snapshot, AppError>>, Busy) -> Msg<S> + SendOutsideWasm,
    ) -> Result<Snapshot, AppError> {
        let (reply, answer) = oneshot::channel();
        self.send(make(reply, self.activity.begin())).await?;
        answer.await.map_err(|_| AppError::Stopped)?
    }
}

#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
impl<S: Slice> Instance for Handle<S> {
    async fn subscribe(&self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError> {
        self.ask(|reply, _busy| Msg::Subscribe {
            sub,
            window,
            reply,
            _busy,
        })
        .await
    }

    async fn resync(&self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError> {
        self.ask(|reply, _busy| Msg::Resync {
            sub,
            window,
            reply,
            _busy,
        })
        .await
    }

    async fn detach(&self, sub: SubId) {
        let _ = self
            .send(Msg::Detach {
                sub,
                _busy: self.activity.begin(),
            })
            .await;
    }

    async fn action(&self, action: Value, req: Option<ReqId>) -> Result<(), AppError> {
        let action: S::Action = serde_json::from_value(action).map_err(|error| {
            tracing::debug!(slice = S::NAME, %error, "undecodable action");
            AppError::Invalid
        })?;
        self.send(Msg::Input {
            input: S::Input::from(action),
            req,
            _busy: self.activity.begin(),
        })
        .await
    }

    async fn core(&self, event: &CoreEvent) {
        if let Some(input) = S::core_input(event) {
            let _ = self
                .send(Msg::Input {
                    input,
                    req: None,
                    _busy: self.activity.begin(),
                })
                .await;
        }
    }

    async fn stop(&self) {
        let (done, stopped) = oneshot::channel();
        if self.send(Msg::Stop(done)).await.is_ok() {
            let _ = stopped.await;
        }
    }
}

pub struct Typed<S>(PhantomData<fn() -> S>);

impl<S> Typed<S> {
    pub const fn new() -> Self {
        Self(PhantomData)
    }
}

impl<S: Slice> AnySlice for Typed<S> {
    fn name(&self) -> &'static str {
        S::NAME
    }

    fn lifetime(&self) -> Lifetime {
        S::LIFETIME
    }

    fn interest(&self) -> Interest {
        S::INTEREST
    }

    fn key_id(&self, key: &Value) -> Result<String, AppError> {
        let key: S::Key = serde_json::from_value(key.clone()).map_err(|_| AppError::Invalid)?;
        serde_json::to_string(&key).map_err(|_| AppError::Invalid)
    }

    fn start(
        &self,
        key: &Value,
        shared: Arc<Shared>,
        on_exit: ExitHook,
    ) -> Result<Started, AppError> {
        let key: S::Key = serde_json::from_value(key.clone()).map_err(|_| AppError::Invalid)?;
        let key_json = serde_json::to_string(&key).map_err(|_| AppError::Invalid)?;
        let id = InstanceId {
            slice: S::NAME,
            key: key_json.clone(),
        };
        let (tx, rx) = mpsc::channel(INBOX);
        let handle = Handle::<S> {
            tx: tx.clone(),
            activity: shared.activity.clone(),
        };
        spawn_detached(supervise::<S>(key, id, tx, rx, shared, on_exit));
        Ok(Started {
            key: key_json,
            instance: Arc::new(handle),
        })
    }
}

async fn supervise<S: Slice>(
    key: S::Key,
    id: InstanceId,
    tx: mpsc::Sender<Msg<S>>,
    rx: mpsc::Receiver<Msg<S>>,
    shared: Arc<Shared>,
    on_exit: ExitHook,
) {
    let actor = {
        let (id, shared) = (id.clone(), shared.clone());
        async move {
            let cached = load::<S>(&shared, &id).await;
            let (state, init) = S::init(&key, cached);
            let mut actor = Actor::new(key, state, id, tx, shared);
            actor.exec_all(init);
            actor.run(rx).await
        }
    };
    let (exit, done) = guarded(actor).await.map_or_else(
        || {
            tracing::error!(slice = S::NAME, "an instance panicked");
            (Exit::Panicked, None)
        },
        |done| (Exit::Stopped, done),
    );
    let reason = match exit {
        Exit::Stopped => LostReason::InstanceStopped,
        Exit::Panicked => LostReason::InstanceFailed,
    };
    shared.lose(|lost| *lost == id, reason);
    on_exit(exit);
    if let Some(done) = done {
        let _ = done.send(());
    }
}

fn storage_key(id: &InstanceId) -> String {
    format!("snapshot/{}/{}", id.slice, id.key)
}

async fn load<S: Slice>(shared: &Shared, id: &InstanceId) -> Option<Value> {
    if !S::PERSIST {
        return None;
    }
    let stored = shared
        .ports
        .platform
        .storage_get(&storage_key(id))
        .await
        .ok()??;
    serde_json::from_str(&stored).ok()
}

/// `None` when the future panicked. Wasm aborts on a panic, so a page there
/// recovers by restarting its worker instead.
#[cfg(not(target_family = "wasm"))]
async fn guarded<T>(future: impl std::future::Future<Output = T>) -> Option<T> {
    use futures_util::FutureExt;
    std::panic::AssertUnwindSafe(future)
        .catch_unwind()
        .await
        .ok()
}

#[cfg(target_family = "wasm")]
async fn guarded<T>(future: impl std::future::Future<Output = T>) -> Option<T> {
    Some(future.await)
}

struct Armed {
    generation: u64,
    _task: Task,
}

struct Subscriber {
    id: SubId,
    window: Option<Window>,
    rev: u64,
}

struct Actor<S: Slice> {
    key: S::Key,
    id: InstanceId,
    tx: mpsc::Sender<Msg<S>>,
    shared: Arc<Shared>,
    epoch: u64,
    state: S::State,
    subscribers: Vec<Subscriber>,
    timers: HashMap<Name, Armed>,
    streams: HashMap<Name, Armed>,
    next_generation: u64,
    persisting: Option<Task>,
    replies: Vec<(ReqId, Outcome)>,
    notices: Vec<(String, String)>,
}

impl<S: Slice> Actor<S> {
    fn new(
        key: S::Key,
        state: S::State,
        id: InstanceId,
        tx: mpsc::Sender<Msg<S>>,
        shared: Arc<Shared>,
    ) -> Self {
        Self {
            key,
            epoch: shared.outbox.epoch(),
            id,
            tx,
            shared,
            state,
            subscribers: Vec::new(),
            timers: HashMap::new(),
            streams: HashMap::new(),
            next_generation: 0,
            persisting: None,
            replies: Vec::new(),
            notices: Vec::new(),
        }
    }

    async fn run(mut self, mut rx: mpsc::Receiver<Msg<S>>) -> Option<oneshot::Sender<()>> {
        self.settle();

        let mut batch = Vec::with_capacity(BATCH);
        while rx.recv_many(&mut batch, BATCH).await > 0 {
            let mut stop = None;
            for msg in batch.drain(..) {
                if let Msg::Stop(done) = msg {
                    stop = Some(done);
                    break;
                }
                self.handle(msg);
            }
            self.settle();
            if stop.is_some() {
                self.dispose().await;
                return stop;
            }
        }
        None
    }

    fn handle(&mut self, msg: Msg<S>) {
        match msg {
            Msg::Input { input, req, .. } => self.reduce(input, req),
            Msg::Timer {
                name,
                generation,
                input,
                ..
            } => {
                if self
                    .timers
                    .get(name)
                    .is_some_and(|timer| timer.generation == generation)
                {
                    self.timers.remove(name);
                    self.reduce(input, None);
                }
            }
            Msg::Item {
                name,
                generation,
                input,
                ..
            } => {
                if self
                    .streams
                    .get(name)
                    .is_some_and(|stream| stream.generation == generation)
                {
                    self.reduce(input, None);
                }
            }
            Msg::Subscribe {
                sub, window, reply, ..
            } => {
                self.settle();
                let snapshot = S::view(&mut self.state).snapshot(window);
                let _ = reply.send(snapshot.map(|state| {
                    self.subscribers.push(Subscriber {
                        id: sub,
                        window,
                        rev: 0,
                    });
                    self.shared.outbox.caught_up(sub);
                    Snapshot {
                        rev: 0,
                        epoch: self.epoch,
                        state,
                    }
                }));
            }
            Msg::Resync {
                sub, window, reply, ..
            } => {
                self.settle();
                let answer = self.resync(sub, window);
                let _ = reply.send(answer);
            }
            Msg::Detach { sub, .. } => {
                self.settle();
                self.subscribers.retain(|subscriber| subscriber.id != sub);
            }
            Msg::Persist => {
                self.persisting = None;
                if let Some(json) = self.cache_json() {
                    let platform = self.shared.ports.platform.clone();
                    let key = storage_key(&self.id);
                    spawn_detached(async move {
                        if let Err(error) = platform.storage_set(&key, &json).await {
                            tracing::warn!(%error, "a view was not persisted");
                        }
                    });
                }
            }
            Msg::Stop(_) => {}
        }
    }

    fn resync(&mut self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError> {
        let at = self
            .subscribers
            .iter()
            .position(|subscriber| subscriber.id == sub)
            .ok_or(AppError::UnknownSub)?;
        let window = window.or_else(|| self.subscribers.get(at).and_then(|s| s.window));
        let state = S::view(&mut self.state).snapshot(window)?;
        let subscriber = self.subscribers.get_mut(at).ok_or(AppError::UnknownSub)?;
        subscriber.window = window;
        self.shared.outbox.caught_up(sub);
        Ok(Snapshot {
            rev: subscriber.rev,
            epoch: self.epoch,
            state,
        })
    }

    fn reduce(&mut self, input: S::Input, req: Option<ReqId>) {
        let mut queue = VecDeque::from([(input, req)]);
        while let Some((input, req)) = queue.pop_front() {
            let span = tracing::debug_span!("reduce", slice = S::NAME, ?req);
            let cmd = span.in_scope(|| S::reduce(&self.key, &mut self.state, input, &Cx::new(req)));
            for effect in cmd.0 {
                if let Some(next) = self.exec(effect) {
                    queue.push_back((next, None));
                }
            }
        }
    }

    fn exec_all(&mut self, cmd: Cmd<S::Input>) {
        for effect in cmd.0 {
            if let Some(input) = self.exec(effect) {
                self.reduce(input, None);
            }
        }
    }

    fn exec(&mut self, effect: Effect<S::Input>) -> Option<S::Input> {
        match effect {
            Effect::Input(input) => return Some(input),
            Effect::Task(work) => {
                let tx = self.tx.clone();
                let activity = self.shared.activity.clone();
                let working = activity.begin();
                let work = work(self.shared.ports.clone());
                spawn_detached(async move {
                    if let Some(input) = work.await {
                        let _ = tx
                            .send(Msg::Input {
                                input,
                                req: None,
                                _busy: activity.begin(),
                            })
                            .await;
                    }
                    drop(working);
                });
            }
            Effect::After(name, delay, input) => {
                if !self.timers.contains_key(name) {
                    self.arm_timer(name, delay, input);
                }
            }
            Effect::Debounce(name, delay, input) => self.arm_timer(name, delay, input),
            Effect::Cancel(name) => {
                self.timers.remove(name);
            }
            Effect::Stream(name, open) => {
                let generation = self.generation();
                let mut stream = open(self.shared.ports.clone());
                let tx = self.tx.clone();
                let activity = self.shared.activity.clone();
                let task = spawn(async move {
                    while let Some(input) = stream.next().await {
                        let msg = Msg::Item {
                            name,
                            generation,
                            input,
                            _busy: activity.begin(),
                        };
                        if tx.send(msg).await.is_err() {
                            break;
                        }
                    }
                });
                self.streams.insert(
                    name,
                    Armed {
                        generation,
                        _task: task,
                    },
                );
            }
            Effect::EndStream(name) => {
                self.streams.remove(name);
            }
            Effect::Notice { stage, text } => self.notices.push((stage, text)),
            Effect::Reply(req, outcome) => self.replies.push((req, outcome)),
        }
        None
    }

    const fn generation(&mut self) -> u64 {
        self.next_generation += 1;
        self.next_generation
    }

    fn arm_timer(&mut self, name: Name, delay: Duration, input: S::Input) {
        let generation = self.generation();
        let tx = self.tx.clone();
        let clock = self.shared.ports.clock.clone();
        let activity = self.shared.activity.clone();
        let task = spawn(async move {
            clock.sleep(delay).await;
            let _ = tx
                .send(Msg::Timer {
                    name,
                    generation,
                    input,
                    _busy: activity.begin(),
                })
                .await;
        });
        self.timers.insert(
            name,
            Armed {
                generation,
                _task: task,
            },
        );
    }

    /// Patches go out before the replies of the same batch.
    fn settle(&mut self) {
        self.publish();
        for (req, outcome) in self.replies.drain(..) {
            if self.shared.requests.finish(req) {
                self.shared.reply(req, outcome);
            }
        }
        for (stage, text) in self.notices.drain(..) {
            self.shared.outbox.push(AppEvent::Notice {
                slice: S::NAME.to_owned(),
                stage,
                text,
            });
        }
    }

    fn publish(&mut self) {
        let view = S::view(&mut self.state);
        let changes = match view.drain() {
            Ok(Some(changes)) => changes,
            Ok(None) => return,
            Err(error) => {
                tracing::error!(slice = S::NAME, %error, "a change could not be published");
                for subscriber in &self.subscribers {
                    self.shared.outbox.lag(subscriber.id);
                }
                return;
            }
        };
        for subscriber in &mut self.subscribers {
            match view.project(&changes, subscriber.window) {
                Ok(ops) if ops.is_empty() => {}
                Ok(ops) => {
                    subscriber.rev += 1;
                    self.shared
                        .outbox
                        .patch(subscriber.id, subscriber.rev, self.epoch, ops);
                }
                Err(error) => {
                    tracing::error!(slice = S::NAME, %error, "a change could not be projected");
                    self.shared.outbox.lag(subscriber.id);
                }
            }
        }
        if S::PERSIST && self.persisting.is_none() {
            let tx = self.tx.clone();
            let clock = self.shared.ports.clock.clone();
            self.persisting = Some(spawn(async move {
                clock.sleep(PERSIST_DELAY).await;
                let _ = tx.send(Msg::Persist).await;
            }));
        }
    }

    fn cache_json(&mut self) -> Option<String> {
        match S::view(&mut self.state).snapshot(None) {
            Ok(view) => Some(view.to_string()),
            Err(error) => {
                tracing::error!(slice = S::NAME, %error, "a view could not be persisted");
                None
            }
        }
    }

    async fn dispose(&mut self) {
        let cmd = S::dispose(&self.key, &mut self.state);
        for effect in cmd.0 {
            self.exec(effect);
        }
        self.settle();
        self.timers.clear();
        self.streams.clear();
        self.persisting = None;
        if S::PERSIST
            && let Some(json) = self.cache_json()
            && let Err(error) = self
                .shared
                .ports
                .platform
                .storage_set(&storage_key(&self.id), &json)
                .await
        {
            tracing::warn!(%error, "a view was not persisted");
        }
    }
}
