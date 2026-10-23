//! Fakes and a harness that never sleeps: tests move time with [`TestApp::advance`]
//! and wait for quiet with [`TestApp::settle`]. Run them on tokio's current-thread runtime.

#![expect(
    clippy::expect_used,
    clippy::missing_panics_doc,
    reason = "a failed expectation here is a failed test"
)]

use std::{
    collections::HashMap,
    marker::PhantomData,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use async_trait::async_trait;
use sable_protocol::{CoreEvent, RpcError};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, value::RawValue};
use tokio::sync::watch;

use crate::{
    App, AppEvent, Backend, Batch, Platform, PlatformError, Ports, Registry, Rpc, Slice, Snapshot,
    SubId, SubscribeRequest, Subscribed, Target, Window,
    patch::{PatchError, apply},
    rt::Activity,
};

pub fn set_now_ms(ms: u64) {
    crate::rt::CLOCK_OVERRIDE.store(ms, std::sync::atomic::Ordering::SeqCst);
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Holds calls back until a test opens it. `settle` does not wait for a held call,
/// which only works for calls made by a `Cmd`.
#[derive(Clone)]
pub struct Gate(Arc<watch::Sender<bool>>);

impl Default for Gate {
    fn default() -> Self {
        Self(Arc::new(watch::channel(false).0))
    }
}

impl Gate {
    pub fn open(&self) {
        self.0.send_replace(true);
    }

    async fn wait(&self) {
        let _ = self.0.subscribe().wait_for(|open| *open).await;
    }
}

type Handler = Arc<dyn Fn(&str) -> Result<String, RpcError> + Send + Sync>;

struct Answer {
    handler: Handler,
    gate: Option<Gate>,
}

pub struct FakeBackend {
    answers: Mutex<HashMap<&'static str, Answer>>,
    calls: Mutex<Vec<(String, String)>>,
    activity: Activity,
}

pub struct Expect<'a, P> {
    backend: &'a FakeBackend,
    gate: Option<Gate>,
    params: PhantomData<fn() -> P>,
}

impl<P: Rpc> Expect<'_, P> {
    #[must_use]
    pub fn after(mut self, gate: &Gate) -> Self {
        self.gate = Some(gate.clone());
        self
    }

    fn handler(self, handler: Handler) {
        locked(&self.backend.answers).insert(
            P::METHOD,
            Answer {
                handler,
                gate: self.gate,
            },
        );
    }
}

impl<P: Rpc + DeserializeOwned> Expect<'_, P>
where
    P::Ok: Serialize,
{
    pub fn answers(self, answer: impl Fn(P) -> Result<P::Ok, RpcError> + Send + Sync + 'static) {
        self.handler(Arc::new(move |params| {
            let params = serde_json::from_str(params).map_err(|_| RpcError::Unsupported)?;
            let ok = answer(params)?;
            serde_json::to_string(&ok).map_err(|_| RpcError::Unsupported)
        }));
    }

    pub fn returns(self, ok: P::Ok)
    where
        P::Ok: Clone + Send + Sync + 'static,
    {
        self.answers(move |_| Ok(ok.clone()));
    }

    pub fn fails(self, error: impl Fn() -> RpcError + Send + Sync + 'static) {
        self.answers(move |_| Err(error()));
    }
}

impl FakeBackend {
    #[must_use]
    pub fn expect<P: Rpc>(&self) -> Expect<'_, P> {
        Expect {
            backend: self,
            gate: None,
            params: PhantomData,
        }
    }

    #[must_use]
    pub fn calls<P: Rpc + DeserializeOwned>(&self) -> Vec<P> {
        locked(&self.calls)
            .iter()
            .filter(|(method, _)| method == P::METHOD)
            .filter_map(|(_, params)| serde_json::from_str(params).ok())
            .collect()
    }

    #[must_use]
    pub fn unexpected(&self) -> Vec<String> {
        let answers = locked(&self.answers);
        locked(&self.calls)
            .iter()
            .filter(|(method, _)| !answers.contains_key(method.as_str()))
            .map(|(method, _)| method.clone())
            .collect()
    }
}

#[async_trait]
impl Backend for FakeBackend {
    async fn call(&self, method: &str, params: &str) -> Result<Box<RawValue>, RpcError> {
        locked(&self.calls).push((method.to_owned(), params.to_owned()));
        let (handler, gate) = {
            let answers = locked(&self.answers);
            let answer = answers.get(method).ok_or(RpcError::UnknownCall)?;
            (answer.handler.clone(), answer.gate.clone())
        };
        if let Some(gate) = gate {
            self.activity.parked(gate.wait()).await;
        }
        RawValue::from_string(handler(params)?).map_err(|_| RpcError::Unsupported)
    }
}

#[derive(Default)]
pub struct FakePlatform {
    storage: Mutex<HashMap<String, String>>,
    writes: Mutex<Vec<(String, String)>>,
    held: Mutex<Option<Gate>>,
    held_reads: Mutex<Option<Gate>>,
}

impl FakePlatform {
    #[must_use]
    pub fn stored(&self, key: &str) -> Option<String> {
        locked(&self.storage).get(key).cloned()
    }

    pub fn store(&self, key: &str, value: &str) {
        locked(&self.storage).insert(key.to_owned(), value.to_owned());
    }

    #[must_use]
    pub fn writes(&self, key: &str) -> Vec<String> {
        locked(&self.writes)
            .iter()
            .filter(|(written, _)| written == key)
            .map(|(_, value)| value.clone())
            .collect()
    }

    pub fn hold_reads(&self, gate: &Gate) {
        *locked(&self.held_reads) = Some(gate.clone());
    }

    pub fn hold_writes(&self, gate: &Gate) {
        *locked(&self.held) = Some(gate.clone());
    }
}

#[async_trait]
impl Platform for FakePlatform {
    async fn storage_get(&self, key: &str) -> Result<Option<String>, PlatformError> {
        let held = locked(&self.held_reads).clone();
        if let Some(gate) = held {
            gate.wait().await;
        }
        Ok(self.stored(key))
    }

    async fn storage_set(&self, key: &str, value: &str) -> Result<(), PlatformError> {
        let held = locked(&self.held).clone();
        if let Some(gate) = held {
            gate.wait().await;
        }
        self.store(key, value);
        locked(&self.writes).push((key.to_owned(), value.to_owned()));
        Ok(())
    }
}

#[derive(Debug, PartialEq, thiserror::Error)]
pub enum ReplicaError {
    #[error("patch {got} follows {had}, so one went missing")]
    Gap { had: u64, got: u64 },
    #[error(transparent)]
    Patch(#[from] PatchError),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Replica {
    pub sub: SubId,
    pub rev: u64,
    pub epoch: u64,
    pub state: Value,
    pub lagging: bool,
}

impl Replica {
    #[must_use]
    pub fn new(subscribed: &Subscribed) -> Self {
        let mut replica = Self {
            sub: subscribed.sub,
            rev: 0,
            epoch: 0,
            state: Value::Null,
            lagging: false,
        };
        replica.reset(&subscribed.snapshot);
        replica
    }

    pub fn reset(&mut self, snapshot: &Snapshot) {
        self.rev = snapshot.rev;
        self.epoch = snapshot.epoch;
        self.state = snapshot.state.clone();
        self.lagging = false;
    }

    pub fn apply(&mut self, event: &AppEvent) -> Result<(), ReplicaError> {
        match event {
            AppEvent::Patch {
                sub,
                rev,
                epoch,
                ops,
            } if *sub == self.sub && *epoch == self.epoch && !self.lagging => {
                if *rev != self.rev + 1 {
                    return Err(ReplicaError::Gap {
                        had: self.rev,
                        got: *rev,
                    });
                }
                apply(&mut self.state, ops)?;
                self.rev = *rev;
            }
            AppEvent::Resync { sub, .. } if *sub == self.sub => self.lagging = true,
            _ => {}
        }
        Ok(())
    }
}

pub struct TestApp {
    pub app: App,
    pub backend: Arc<FakeBackend>,
    pub platform: Arc<FakePlatform>,
    activity: Activity,
}

pub const ACCOUNT: &str = "account-a";

const SETTLE_LIMIT: usize = 100_000;

impl TestApp {
    #[must_use]
    pub fn new(registry: Registry) -> Self {
        let activity = Activity::default();
        let backend = Arc::new(FakeBackend {
            answers: Mutex::default(),
            calls: Mutex::default(),
            activity: activity.clone(),
        });
        let platform = Arc::new(FakePlatform::default());
        let ports = Ports {
            backend: backend.clone(),
            platform: platform.clone(),
        };
        Self {
            app: App::with_activity(registry, ports, ACCOUNT, activity.clone()),
            backend,
            platform,
            activity,
        }
    }

    pub async fn settle(&self) {
        for _ in 0..SETTLE_LIMIT {
            tokio::task::yield_now().await;
            if self.activity.is_idle() {
                tokio::task::yield_now().await;
                if self.activity.is_idle() {
                    return;
                }
            }
        }
        assert!(self.activity.is_idle(), "the app did not settle");
    }

    /// Lets every timer start sleeping before time moves, so none is skipped.
    /// The test must run with `start_paused = true`.
    pub async fn advance(&self, by: Duration) {
        self.settle().await;
        tokio::time::advance(by).await;
        self.settle().await;
    }

    pub async fn subscribe(&self, slice: &str, key: Value, window: Option<Window>) -> Replica {
        let subscribed = self
            .app
            .subscribe(SubscribeRequest {
                target: Target {
                    slice: slice.to_owned(),
                    key,
                },
                window,
            })
            .await
            .expect("the subscription succeeds");
        self.settle().await;
        Replica::new(&subscribed)
    }

    pub async fn batches(&self) -> Vec<Batch> {
        self.settle().await;
        std::iter::from_fn(|| self.app.try_next_batch()).collect()
    }

    pub async fn events(&self) -> Vec<AppEvent> {
        self.batches()
            .await
            .into_iter()
            .flat_map(|batch| batch.events)
            .collect()
    }
}

#[derive(Debug, Clone)]
pub enum Step {
    Action(Value),
    Core(CoreEvent),
}

pub async fn assert_patches_converge<S: Slice>(
    expect: impl FnOnce(&FakeBackend),
    key: Value,
    window: Option<Window>,
    steps: &[Vec<Step>],
) {
    let mut registry = Registry::new();
    registry.add::<S>().expect("the slice is registered once");
    let harness = TestApp::new(registry);
    expect(&harness.backend);
    let mut replica = harness.subscribe(S::NAME, key.clone(), window).await;
    let target = Target {
        slice: S::NAME.to_owned(),
        key,
    };
    for step in steps {
        for input in step {
            match input {
                Step::Action(action) => harness
                    .app
                    .dispatch(&target, action.clone())
                    .await
                    .expect("the action decodes"),
                Step::Core(event) => {
                    harness.app.offer(event).await;
                    harness.settle().await;
                }
            }
        }
        for event in harness.events().await {
            replica.apply(&event).expect("the patch applies");
        }
        let fresh = harness
            .app
            .resync(replica.sub)
            .await
            .expect("the subscription is live");
        assert_eq!(replica.state, fresh.state, "after {step:?}");
        assert_eq!(replica.rev, fresh.rev, "after {step:?}");
    }
}
