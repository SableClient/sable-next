use std::{collections::HashMap, marker::PhantomData, sync::Arc, time::Duration};

use async_trait::async_trait;
use futures_util::FutureExt;
use sable_protocol::CoreEvent;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::{
    cmd::{Effect, Name},
    error::AppError,
    outbox::Outbox,
    persist,
    ports::Ports,
    registry::AnySlice,
    requests::Requests,
    rt::{
        Activity, BoxAny, BoxOnce, Busy, SendOutsideWasm, SyncOutsideWasm, Task, sleep, spawn,
        spawn_detached,
    },
    slice::{Cx, Interest, Lifetime, Render, Slice},
    wire::{AppEvent, LostReason, Op, Outcome, ReplyError, ReqId, Snapshot, SubId, Window},
};

const BATCH: usize = 256;
const INBOX: usize = 256;
const PERSIST_DELAY: Duration = Duration::from_secs(2);
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct InstanceId {
    pub slice: &'static str,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    pub id: InstanceId,
    pub generation: u64,
}

#[derive(Debug, Clone)]
pub struct Era {
    pub epoch: u64,
    pub account: Arc<str>,
}

pub struct Shared {
    pub ports: Ports,
    pub outbox: Arc<Outbox>,
    pub requests: Requests,
    pub activity: Activity,
}

impl Shared {
    pub fn lose(&self, matching: impl Fn(&Origin) -> bool, reason: LostReason) {
        for req in self.requests.lose(matching) {
            self.lose_reply(req, reason);
        }
    }

    pub fn lose_reply(&self, req: ReqId, reason: LostReason) {
        self.reply(
            req,
            self.outbox.epoch(),
            Outcome::Error {
                error: ReplyError::Lost { reason },
            },
        );
    }

    pub fn reply(&self, req: ReqId, epoch: u64, outcome: Outcome) {
        self.outbox.push(AppEvent::Reply {
            req,
            epoch,
            outcome,
        });
    }
}

type Written = futures_util::future::Shared<oneshot::Receiver<()>>;

pub struct Started {
    pub instance: Arc<dyn Instance>,
}

#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
pub trait Instance: SendOutsideWasm + SyncOutsideWasm {
    async fn subscribe(&self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError>;

    async fn resync(&self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError>;

    async fn detach(&self, sub: SubId);

    async fn action(&self, action: Value, req: Option<ReqId>) -> Result<(), AppError>;

    async fn core(&self, event: Arc<CoreEvent>);

    async fn stop(&self);

    async fn flush(&self);
}

enum Msg {
    Input {
        input: BoxAny,
        req: Option<ReqId>,
        _busy: Busy,
    },
    Timer {
        name: Name,
        input: BoxAny,
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
    Core {
        event: Arc<CoreEvent>,
        _busy: Busy,
    },
    Persist,
    Flush(oneshot::Sender<Option<Written>>),
    Stop(oneshot::Sender<()>),
}

async fn deliver(tx: &mpsc::WeakSender<Msg>, msg: Msg) -> bool {
    match tx.upgrade() {
        Some(tx) => tx.send(msg).await.is_ok(),
        None => false,
    }
}

struct Handle {
    tx: mpsc::Sender<Msg>,
    activity: Activity,
    decode: fn(Value) -> Result<BoxAny, AppError>,
}

impl Handle {
    async fn send(&self, msg: Msg) -> Result<(), AppError> {
        self.tx.send(msg).await.map_err(|_| AppError::Stopped)
    }

    async fn ask(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<Snapshot, AppError>>) -> Msg + SendOutsideWasm,
    ) -> Result<Snapshot, AppError> {
        let (reply, answer) = oneshot::channel();
        self.send(make(reply)).await?;
        answer.await.map_err(|_| AppError::Stopped)?
    }
}

#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
impl Instance for Handle {
    async fn subscribe(&self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError> {
        self.ask(|reply| Msg::Subscribe {
            sub,
            window,
            reply,
            _busy: self.activity.begin(),
        })
        .await
    }

    async fn resync(&self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError> {
        self.ask(|reply| Msg::Resync {
            sub,
            window,
            reply,
            _busy: self.activity.begin(),
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
        self.send(Msg::Input {
            input: (self.decode)(action)?,
            req,
            _busy: self.activity.begin(),
        })
        .await
    }

    async fn core(&self, event: Arc<CoreEvent>) {
        let _ = self
            .send(Msg::Core {
                event,
                _busy: self.activity.begin(),
            })
            .await;
    }

    async fn stop(&self) {
        let (done, stopped) = oneshot::channel();
        if self.send(Msg::Stop(done)).await.is_ok() {
            let _ = stopped.await;
        }
    }

    async fn flush(&self) {
        let (reply, answer) = oneshot::channel();
        if self.send(Msg::Flush(reply)).await.is_ok()
            && let Ok(Some(written)) = answer.await
        {
            let _ = written.await;
        }
    }
}

pub struct Typed<S>(PhantomData<fn() -> S>);

impl<S> Typed<S> {
    pub const fn new() -> Self {
        Self(PhantomData)
    }
}

trait Logic: SendOutsideWasm {
    fn reduce(&mut self, input: BoxAny, cx: &Cx) -> Vec<Effect>;

    fn core_input(&self, event: &CoreEvent) -> Option<BoxAny>;

    fn dispose(&mut self) -> Vec<Effect>;

    fn view(&mut self) -> &mut dyn View;
}

trait View {
    fn snapshot(&self, window: Option<Window>) -> Result<Value, AppError>;

    fn drain(&mut self) -> Result<Option<BoxAny>, AppError>;

    fn clear(&mut self);

    fn project(&self, changes: &BoxAny, window: Option<Window>) -> Result<Vec<Op>, AppError>;
}

impl<R: Render> View for R {
    fn snapshot(&self, window: Option<Window>) -> Result<Value, AppError> {
        Render::snapshot(self, window)
    }

    fn drain(&mut self) -> Result<Option<BoxAny>, AppError> {
        Ok(Render::drain(self)?.map(|changes| Box::new(changes) as BoxAny))
    }

    fn clear(&mut self) {
        Render::clear(self);
    }

    #[expect(
        clippy::expect_used,
        reason = "the erased view and changes share a concrete type"
    )]
    fn project(&self, changes: &BoxAny, window: Option<Window>) -> Result<Vec<Op>, AppError> {
        Render::project(
            self,
            changes
                .downcast_ref()
                .expect("changes were produced by this Render"),
            window,
        )
    }
}

struct Cell<S: Slice> {
    key: S::Key,
    state: S::State,
}

impl<S: Slice> Logic for Cell<S> {
    #[expect(clippy::expect_used, reason = "only this slice constructs its inputs")]
    fn reduce(&mut self, input: BoxAny, cx: &Cx) -> Vec<Effect> {
        let input = input
            .downcast::<S::Input>()
            .expect("inputs are decoded or constructed by this slice");
        S::reduce(&self.key, &mut self.state, *input, cx).into_effects()
    }

    fn core_input(&self, event: &CoreEvent) -> Option<BoxAny> {
        S::core_input(&self.state, event).map(|input| Box::new(input) as BoxAny)
    }

    fn dispose(&mut self) -> Vec<Effect> {
        S::dispose(&self.key, &mut self.state).into_effects()
    }

    fn view(&mut self) -> &mut dyn View {
        S::view(&mut self.state)
    }
}

fn decode<S: Slice>(action: Value) -> Result<BoxAny, AppError> {
    let action: S::Action = serde_json::from_value(action).map_err(|_| {
        tracing::debug!(slice = S::NAME, "undecodable action");
        AppError::Invalid
    })?;
    Ok(Box::new(S::Input::from(action)))
}

type Init = BoxOnce<Option<Value>, (Box<dyn Logic>, Vec<Effect>)>;

struct Completion {
    origin: Origin,
    shared: Arc<Shared>,
    ended: Option<BoxOnce<Origin, ()>>,
}

impl Drop for Completion {
    fn drop(&mut self) {
        self.shared
            .lose(|lost| *lost == self.origin, LostReason::InstanceStopped);
        if let Some(ended) = self.ended.take() {
            ended(self.origin.clone());
        }
    }
}

struct Start {
    ended: BoxOnce<Origin, ()>,
    name: &'static str,
    persist: bool,
    init: Init,
    origin: Origin,
    era: Era,
    tx: mpsc::WeakSender<Msg>,
    shared: Arc<Shared>,
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

    fn event_key(&self, event: &CoreEvent) -> Option<String> {
        S::event_key(event).map(|key| serde_json::to_string(&key).unwrap_or_default())
    }

    fn key_id(&self, key: &Value) -> Result<String, AppError> {
        let key: S::Key = serde_json::from_value(key.clone()).map_err(|_| AppError::Invalid)?;
        serde_json::to_string(&key).map_err(|_| AppError::Invalid)
    }

    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::arc_with_non_send_sync,
            reason = "the worker is one thread, and inputs need not be `Send` there"
        )
    )]
    fn start(
        &self,
        key: &Value,
        shared: Arc<Shared>,
        era: Era,
        generation: u64,
        ended: BoxOnce<Origin, ()>,
    ) -> Result<Started, AppError> {
        let key: S::Key = serde_json::from_value(key.clone()).map_err(|_| AppError::Invalid)?;
        let origin = Origin {
            id: InstanceId {
                slice: S::NAME,
                key: serde_json::to_string(&key).map_err(|_| AppError::Invalid)?,
            },
            generation,
        };
        let (tx, rx) = mpsc::channel(INBOX);
        let handle = Handle {
            tx,
            activity: shared.activity.clone(),
            decode: decode::<S>,
        };
        spawn_detached(supervise(
            Start {
                name: S::NAME,
                persist: S::PERSIST,
                init: Box::new(move |cached| {
                    let (state, init) = S::init(&key, cached);
                    (Box::new(Cell::<S> { key, state }), init.into_effects())
                }),
                ended,
                origin,
                era,
                tx: handle.tx.downgrade(),
                shared,
            },
            rx,
        ));
        Ok(Started {
            instance: Arc::new(handle),
        })
    }
}

async fn supervise(start: Start, rx: mpsc::Receiver<Msg>) {
    let Start {
        name,
        persist: persisted,
        init,
        origin,
        era,
        tx,
        shared,
        ended,
    } = start;
    let completion = Completion {
        origin: origin.clone(),
        shared: shared.clone(),
        ended: Some(ended),
    };
    let cached = if persisted {
        let saved = persist::storage_key(&era, &origin.id);
        persist::load(&*shared.ports.platform, &saved).await
    } else {
        None
    };
    let (logic, init) = init(cached);
    let mut actor = Actor::new(
        name,
        persisted,
        logic,
        origin.clone(),
        era,
        tx,
        shared.clone(),
    );
    actor.exec_all(init);
    let done = actor.run(rx).await;
    drop(completion);
    if let Some(done) = done {
        let _ = done.send(());
    }
}

struct Subscriber {
    id: SubId,
    window: Option<Window>,
    rev: u64,
}

enum Flow {
    Continue,
    Stop(oneshot::Sender<()>),
}

struct Actor {
    name: &'static str,
    persist: bool,
    logic: Box<dyn Logic>,
    origin: Origin,
    era: Era,
    tx: mpsc::WeakSender<Msg>,
    shared: Arc<Shared>,
    subscribers: Vec<Subscriber>,
    timers: HashMap<Name, Task>,
    persisting: Option<Task>,
    last_write: Option<Written>,
    replies: Vec<(ReqId, Outcome)>,
    notices: Vec<Value>,
}

impl Actor {
    fn new(
        name: &'static str,
        persist: bool,
        logic: Box<dyn Logic>,
        origin: Origin,
        era: Era,
        tx: mpsc::WeakSender<Msg>,
        shared: Arc<Shared>,
    ) -> Self {
        Self {
            name,
            persist,
            logic,
            origin,
            era,
            tx,
            shared,
            subscribers: Vec::new(),
            timers: HashMap::new(),
            persisting: None,
            last_write: None,
            replies: Vec::new(),
            notices: Vec::new(),
        }
    }

    async fn run(mut self, mut rx: mpsc::Receiver<Msg>) -> Option<oneshot::Sender<()>> {
        self.settle();

        let mut batch = Vec::with_capacity(BATCH);
        while rx.recv_many(&mut batch, BATCH).await > 0 {
            let mut flow = Flow::Continue;
            for msg in batch.drain(..) {
                flow = self.handle(msg);
                if !matches!(flow, Flow::Continue) {
                    break;
                }
            }
            self.settle();
            match flow {
                Flow::Continue => {}
                Flow::Stop(done) => {
                    self.dispose().await;
                    Self::drain(&mut rx).await;
                    return Some(done);
                }
            }
        }
        self.dispose().await;
        None
    }

    /// A sender that already holds a permit can still push after the receiver is dropped,
    /// and that message would sit in the channel for good with its reply sender.
    /// Closing first and reading until the channel is empty drops every such message
    /// before the instance's requests are lost.
    async fn drain(rx: &mut mpsc::Receiver<Msg>) {
        rx.close();
        while rx.recv().await.is_some() {}
    }

    fn handle(&mut self, msg: Msg) -> Flow {
        match msg {
            Msg::Input { input, req, .. } => self.reduce(input, req),
            Msg::Timer { name, input, .. } => {
                self.timers.remove(name);
                self.reduce(input, None);
            }
            Msg::Core { event, .. } => {
                if let Some(input) = self.logic.core_input(&event) {
                    self.reduce(input, None);
                }
            }
            Msg::Subscribe {
                sub, window, reply, ..
            } => {
                self.settle();
                match self.logic.view().snapshot(window) {
                    Ok(state) => {
                        let snapshot = Snapshot {
                            rev: 0,
                            epoch: self.era.epoch,
                            state,
                        };
                        if reply.send(Ok(snapshot)).is_ok() {
                            self.subscribers.retain(|known| known.id != sub);
                            self.subscribers.push(Subscriber {
                                id: sub,
                                window,
                                rev: 0,
                            });
                            self.shared.outbox.caught_up(sub);
                        }
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
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
                self.save();
            }
            Msg::Flush(reply) => {
                if self.persist && self.persisting.take().is_some() {
                    self.save();
                }
                let _ = reply.send(self.last_write.clone());
            }
            Msg::Stop(done) => return Flow::Stop(done),
        }
        Flow::Continue
    }

    fn resync(&mut self, sub: SubId, window: Option<Window>) -> Result<Snapshot, AppError> {
        let subscriber = self
            .subscribers
            .iter_mut()
            .find(|subscriber| subscriber.id == sub)
            .ok_or(AppError::UnknownSub)?;
        let state = self.logic.view().snapshot(window)?;
        subscriber.window = window;
        self.shared.outbox.caught_up(sub);
        Ok(Snapshot {
            rev: subscriber.rev,
            epoch: self.era.epoch,
            state,
        })
    }

    fn reduce(&mut self, input: BoxAny, req: Option<ReqId>) {
        let span = tracing::debug_span!("reduce", slice = self.name, ?req);
        let effects = span.in_scope(|| self.logic.reduce(input, &Cx::new(req)));
        self.exec_all(effects);
    }

    fn exec_all(&mut self, effects: Vec<Effect>) {
        for effect in effects {
            self.exec(effect);
        }
    }

    fn exec(&mut self, effect: Effect) {
        match effect {
            Effect::Task(work) => {
                let tx = self.tx.clone();
                let working = self.shared.activity.begin();
                let work = work(self.shared.ports.clone());
                spawn_detached(async move {
                    if let Some(input) = work.await {
                        let msg = Msg::Input {
                            input,
                            req: None,
                            _busy: working,
                        };
                        deliver(&tx, msg).await;
                    }
                });
            }
            Effect::After(name, delay, input) => {
                if !self.timers.contains_key(name) {
                    self.arm_timer(name, delay, input);
                }
            }
            Effect::Notice(notice) => self.notices.push(notice),
            Effect::Reply(req, outcome) => self.replies.push((req, outcome)),
        }
    }

    fn arm_timer(&mut self, name: Name, delay: Duration, input: BoxAny) {
        let tx = self.tx.clone();
        let activity = self.shared.activity.clone();
        let task = spawn(async move {
            sleep(delay).await;
            let msg = Msg::Timer {
                name,
                input,
                _busy: activity.begin(),
            };
            deliver(&tx, msg).await;
        });
        self.timers.insert(name, task);
    }

    /// Patches go out before the replies of the same batch.
    fn settle(&mut self) {
        self.publish();
        for (req, outcome) in self.replies.drain(..) {
            if self.shared.requests.finish(req) {
                self.shared.reply(req, self.era.epoch, outcome);
            }
        }
        for notice in self.notices.drain(..) {
            self.shared.outbox.push(AppEvent::Notice {
                slice: self.name.to_owned(),
                notice,
                epoch: self.era.epoch,
            });
        }
    }

    fn publish(&mut self) {
        let view = self.logic.view();
        if self.subscribers.is_empty() && !self.persist {
            view.clear();
            return;
        }
        let changes = match view.drain() {
            Ok(Some(changes)) => changes,
            Ok(None) => return,
            Err(error) => {
                tracing::error!(slice = self.name, %error, "a change could not be published");
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
                        .patch(subscriber.id, subscriber.rev, self.era.epoch, ops);
                }
                Err(error) => {
                    tracing::error!(slice = self.name, %error, "a change could not be projected");
                    self.shared.outbox.lag(subscriber.id);
                }
            }
        }
        if self.persist && self.persisting.is_none() {
            let tx = self.tx.clone();
            self.persisting = Some(spawn(async move {
                sleep(PERSIST_DELAY).await;
                deliver(&tx, Msg::Persist).await;
            }));
        }
    }

    /// Chained after the previous write, so the last one saved is the latest.
    fn save(&mut self) {
        let view = match self.logic.view().snapshot(None) {
            Ok(view) => view,
            Err(error) => {
                tracing::error!(slice = self.name, %error, "a view could not be persisted");
                return;
            }
        };
        let Some(json) = persist::encode(&view) else {
            return;
        };
        let previous = self.last_write.take();
        let (done, written) = oneshot::channel();
        self.last_write = Some(written.shared());
        let platform = self.shared.ports.platform.clone();
        let key = persist::storage_key(&self.era, &self.origin.id);
        spawn_detached(async move {
            if let Some(previous) = previous {
                let _ = previous.await;
            }
            if let Err(error) = platform.storage_set(&key, &json).await {
                tracing::warn!(%error, "a view was not persisted");
            }
            let _ = done.send(());
        });
    }

    async fn dispose(&mut self) {
        for effect in self.logic.dispose() {
            match effect {
                Effect::Task(work) => {
                    let _working = self.shared.activity.begin();
                    work(self.shared.ports.clone()).await;
                }
                effect => self.exec(effect),
            }
        }
        self.settle();
        self.timers.clear();
        self.persisting = None;
        if self.persist {
            self.save();
        }
        if let Some(written) = self.last_write.take() {
            let _ = written.await;
        }
    }
}
