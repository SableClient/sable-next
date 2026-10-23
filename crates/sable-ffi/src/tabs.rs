use std::{
    collections::{HashMap, HashSet},
    hash::Hash,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use sable_runtime::{AppEvent, Batch, Subscribed};

use crate::{Ffi, FfiError};

type Sink<K> = Arc<dyn Fn(&K, Batch) + Send + Sync>;

struct State<K> {
    windows: HashSet<K>,
    subs: HashMap<u32, K>,
    reqs: HashMap<u64, K>,
    /// Calls whose ids their events may outrun.
    issuing: usize,
    early: Vec<AppEvent>,
    tick: u64,
}

impl<K: Clone + Eq + Hash> State<K> {
    fn route(&mut self, events: Vec<AppEvent>) -> HashMap<K, Vec<AppEvent>> {
        let mut routed: HashMap<K, Vec<AppEvent>> = HashMap::new();
        for event in events {
            let owner = match &event {
                AppEvent::Notice { .. } => {
                    for window in &self.windows {
                        routed
                            .entry(window.clone())
                            .or_default()
                            .push(event.clone());
                    }
                    continue;
                }
                AppEvent::Reply { req, .. } => self.reqs.remove(&req.0),
                AppEvent::Patch { sub, .. } | AppEvent::Resync { sub, .. } => {
                    self.subs.get(&sub.0).cloned()
                }
            };
            match owner {
                Some(window) => routed.entry(window).or_default().push(event),
                None if self.issuing > 0 => self.early.push(event),
                None => {}
            }
        }
        routed
    }
}

/// Sends each window only the events of its own subscriptions and requests.
pub struct Tabs<K> {
    ffi: Ffi,
    state: Arc<Mutex<State<K>>>,
    send: Sink<K>,
}

impl<K> Clone for Tabs<K> {
    fn clone(&self) -> Self {
        Self {
            ffi: self.ffi.clone(),
            state: self.state.clone(),
            send: self.send.clone(),
        }
    }
}

impl<K: Clone + Eq + Hash + Send + 'static> Tabs<K> {
    #[must_use]
    pub fn new(ffi: Ffi, send: impl Fn(&K, Batch) + Send + Sync + 'static) -> Self {
        Self {
            ffi,
            state: Arc::new(Mutex::new(State {
                windows: HashSet::new(),
                subs: HashMap::new(),
                reqs: HashMap::new(),
                issuing: 0,
                early: Vec::new(),
                tick: 0,
            })),
            send: Arc::new(send),
        }
    }

    fn state(&self) -> MutexGuard<'_, State<K>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn deliver(&self, tick: u64, routed: HashMap<K, Vec<AppEvent>>) {
        for (window, events) in routed {
            (self.send)(&window, Batch { tick, events });
        }
    }

    fn replay_early(&self) {
        let (tick, routed) = {
            let mut state = self.state();
            let early = std::mem::take(&mut state.early);
            (state.tick, state.route(early))
        };
        self.deliver(tick, routed);
    }

    /// Holds the call's events until the window has its ids.
    async fn issuing<T>(
        &self,
        call: impl std::future::Future<Output = Result<T, FfiError>>,
        claim: impl FnOnce(&mut State<K>, &T),
    ) -> Result<T, FfiError> {
        self.state().issuing += 1;
        let result = call.await;
        {
            let mut state = self.state();
            state.issuing -= 1;
            if let Ok(value) = &result {
                claim(&mut state, value);
            }
        }
        self.replay_early();
        result
    }

    /// A window that was open already was reloaded, so what its old page held is let go.
    pub async fn open(&self, window: K) {
        self.close(&window).await;
        self.state().windows.insert(window);
    }

    pub async fn close(&self, window: &K) {
        let subs: Vec<u32> = {
            let mut state = self.state();
            state.windows.remove(window);
            state.reqs.retain(|_, owner| owner != window);
            let subs: Vec<u32> = state
                .subs
                .iter()
                .filter(|(_, owner)| *owner == window)
                .map(|(sub, _)| *sub)
                .collect();
            for sub in &subs {
                state.subs.remove(sub);
            }
            subs
        };
        for sub in subs {
            let _ = self.ffi.unsubscribe(sub).await;
        }
    }

    fn owns(&self, window: &K, sub: u32) -> Result<(), FfiError> {
        if self.state().subs.get(&sub) == Some(window) {
            Ok(())
        } else {
            Err(FfiError::UnknownSub)
        }
    }

    pub async fn subscribe(&self, window: &K, request: &str) -> Result<String, FfiError> {
        self.issuing(self.ffi.subscribe(request), |state, json| {
            if let Ok(subscribed) = serde_json::from_str::<Subscribed>(json) {
                state.subs.insert(subscribed.sub.0, window.clone());
            }
        })
        .await
    }

    pub async fn unsubscribe(&self, window: &K, sub: u32) -> Result<(), FfiError> {
        self.owns(window, sub)?;
        self.state().subs.remove(&sub);
        self.ffi.unsubscribe(sub).await
    }

    pub async fn resync(&self, window: &K, sub: u32) -> Result<String, FfiError> {
        self.owns(window, sub)?;
        self.ffi.resync(sub).await
    }

    pub async fn range(&self, window: &K, sub: u32, window_json: &str) -> Result<String, FfiError> {
        self.owns(window, sub)?;
        self.ffi.range(sub, window_json).await
    }

    pub async fn dispatch(&self, target: &str, action: &str) -> Result<(), FfiError> {
        self.ffi.dispatch(target, action).await
    }

    pub async fn request(&self, window: &K, target: &str, action: &str) -> Result<u64, FfiError> {
        self.issuing(self.ffi.request(target, action), |state, req| {
            state.reqs.insert(*req, window.clone());
        })
        .await
    }

    pub async fn pump(&self) {
        while let Ok(json) = self.ffi.next_batch().await {
            let Ok(batch) = serde_json::from_str::<Batch>(&json) else {
                continue;
            };
            let routed = {
                let mut state = self.state();
                state.tick = batch.tick;
                state.route(batch.events)
            };
            self.deliver(batch.tick, routed);
        }
    }
}
