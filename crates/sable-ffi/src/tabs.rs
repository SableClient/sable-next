use std::{
    collections::{HashMap, HashSet},
    hash::Hash,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use sable_runtime::{
    AppEvent, Batch, Subscribed,
    rt::{SendOutsideWasm, SyncOutsideWasm},
};

use crate::{AppError, Ffi};

#[cfg(not(target_family = "wasm"))]
type Sink<K> = Arc<dyn Fn(&K, Batch) + Send + Sync>;
#[cfg(target_family = "wasm")]
type Sink<K> = Arc<dyn Fn(&K, Batch)>;

struct State<K> {
    windows: HashSet<K>,
    subs: HashMap<u32, K>,
    reqs: HashMap<u64, K>,
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

impl<K: Clone + Eq + Hash + SendOutsideWasm + 'static> Tabs<K> {
    #[must_use]
    pub fn new(
        ffi: Ffi,
        send: impl Fn(&K, Batch) + SendOutsideWasm + SyncOutsideWasm + 'static,
    ) -> Self {
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
        call: impl std::future::Future<Output = Result<T, AppError>>,
        claim: impl FnOnce(&mut State<K>, &T),
    ) -> Result<T, AppError> {
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

    fn owns(&self, window: &K, sub: u32) -> Result<(), AppError> {
        if self.state().subs.get(&sub) == Some(window) {
            Ok(())
        } else {
            Err(AppError::UnknownSub)
        }
    }

    pub async fn subscribe(&self, window: &K, request: &str) -> Result<String, AppError> {
        self.issuing(self.ffi.subscribe(request), |state, json| {
            if let Ok(subscribed) = serde_json::from_str::<Subscribed>(json) {
                state.subs.insert(subscribed.sub.0, window.clone());
            }
        })
        .await
    }

    pub async fn unsubscribe(&self, window: &K, sub: u32) -> Result<(), AppError> {
        self.owns(window, sub)?;
        self.state().subs.remove(&sub);
        self.ffi.unsubscribe(sub).await
    }

    pub async fn resync(&self, window: &K, sub: u32) -> Result<String, AppError> {
        self.owns(window, sub)?;
        self.ffi.resync(sub).await
    }

    pub async fn range(&self, window: &K, sub: u32, window_json: &str) -> Result<String, AppError> {
        self.owns(window, sub)?;
        self.ffi.range(sub, window_json).await
    }

    pub async fn dispatch(&self, target: &str, action: &str) -> Result<(), AppError> {
        self.ffi.dispatch(target, action).await
    }

    pub async fn request(&self, window: &K, target: &str, action: &str) -> Result<u64, AppError> {
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

#[cfg(test)]
mod tests {
    use sable_runtime::{Outcome, ReqId, SubId};

    use super::*;

    fn state() -> State<&'static str> {
        State {
            windows: HashSet::from(["one"]),
            subs: HashMap::new(),
            reqs: HashMap::new(),
            issuing: 0,
            early: Vec::new(),
            tick: 0,
        }
    }

    fn patch(sub: u32) -> AppEvent {
        AppEvent::Patch {
            sub: SubId(sub),
            rev: 1,
            epoch: 0,
            ops: Vec::new(),
        }
    }

    fn reply(req: u64) -> AppEvent {
        AppEvent::Reply {
            req: ReqId(req),
            epoch: 0,
            outcome: Outcome::Ok {
                value: serde_json::json!(1),
            },
        }
    }

    #[test]
    fn an_event_that_outruns_its_call_is_held_and_placed_once_the_owner_is_known() {
        let mut state = state();
        state.issuing = 1;
        assert_eq!(state.route(vec![patch(7), reply(3)]), HashMap::new());
        assert_eq!(state.early.len(), 2);

        state.subs.insert(7, "one");
        state.reqs.insert(3, "one");
        let held = std::mem::take(&mut state.early);
        let routed = state.route(held);

        assert_eq!(routed["one"], [patch(7), reply(3)]);
    }

    #[test]
    fn an_event_nobody_owns_is_dropped_when_no_call_is_in_flight() {
        let mut state = state();

        assert_eq!(state.route(vec![patch(7), reply(3)]), HashMap::new());
        assert_eq!(state.early, []);
    }

    #[test]
    fn a_reply_goes_out_once() {
        let mut state = state();
        state.reqs.insert(3, "one");

        assert_eq!(state.route(vec![reply(3)])["one"], [reply(3)]);
        assert_eq!(state.route(vec![reply(3)]), HashMap::new());
    }
}
