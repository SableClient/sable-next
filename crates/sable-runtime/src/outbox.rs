//! A subscriber that does not keep up gets one `Resync` in place of what it
//! missed, and nothing more until it asks for a snapshot.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Mutex, PoisonError},
};

use tokio::sync::Notify;

use crate::wire::{AppEvent, Batch, Op, SubId};

/// The most weighted ops that wait for one subscription.
const PENDING_CAP: usize = 1024;
/// The most events one batch carries.
const BATCH_LIMIT: usize = 256;
/// The most notices that wait; the oldest go first.
const NOTICE_CAP: usize = 32;

#[derive(Default)]
struct SubQueue {
    pending: usize,
    lagging: bool,
}

#[derive(Default)]
struct State {
    epoch: u64,
    tick: u64,
    queue: VecDeque<AppEvent>,
    subs: HashMap<SubId, SubQueue>,
}

#[derive(Default)]
pub struct Outbox {
    state: Mutex<State>,
    ready: Notify,
}

fn weight(ops: &[Op]) -> usize {
    ops.iter().map(Op::weight).sum()
}

impl State {
    const fn is_stale(event: &AppEvent, epoch: u64) -> bool {
        match event {
            AppEvent::Patch { epoch: at, .. }
            | AppEvent::Reply { epoch: at, .. }
            | AppEvent::Resync { epoch: at, .. } => *at != epoch,
            AppEvent::Notice { .. } => false,
        }
    }

    fn lag(&mut self, sub: SubId) {
        let epoch = self.epoch;
        let queue = self.subs.entry(sub).or_default();
        if queue.lagging {
            return;
        }
        queue.lagging = true;
        queue.pending = 0;
        self.queue.retain(
            |event| !matches!(event, AppEvent::Patch { sub: queued, .. } if *queued == sub),
        );
        self.queue.push_back(AppEvent::Resync { sub, epoch });
    }
}

impl Outbox {
    pub fn epoch(&self) -> u64 {
        self.lock().epoch
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Dropped for a subscriber already lagging or pushed past the cap.
    pub fn patch(&self, sub: SubId, rev: u64, epoch: u64, ops: Vec<Op>) {
        let mut state = self.lock();
        if epoch != state.epoch {
            return;
        }
        let cost = weight(&ops);
        let queue = state.subs.entry(sub).or_default();
        if queue.lagging {
            return;
        }
        queue.pending += cost;
        if queue.pending > PENDING_CAP {
            state.lag(sub);
        } else {
            state.queue.push_back(AppEvent::Patch {
                sub,
                rev,
                epoch,
                ops,
            });
        }
        drop(state);
        self.ready.notify_one();
    }

    /// Tells a subscriber to ask for a snapshot, once.
    pub fn lag(&self, sub: SubId) {
        self.lock().lag(sub);
        self.ready.notify_one();
    }

    /// The subscriber has a snapshot again, so patches flow to it.
    pub fn caught_up(&self, sub: SubId) {
        if let Some(queue) = self.lock().subs.get_mut(&sub) {
            queue.lagging = false;
        }
    }

    pub fn forget(&self, sub: SubId) {
        let mut state = self.lock();
        state.subs.remove(&sub);
        state.queue.retain(
            |event| !matches!(event, AppEvent::Patch { sub: queued, .. } if *queued == sub),
        );
    }

    /// Queues a reply or notice behind the patches that came before it.
    pub fn push(&self, event: AppEvent) {
        let mut state = self.lock();
        if State::is_stale(&event, state.epoch) {
            return;
        }
        if matches!(event, AppEvent::Notice { .. }) {
            let notices = state
                .queue
                .iter()
                .filter(|queued| matches!(queued, AppEvent::Notice { .. }))
                .count();
            if notices >= NOTICE_CAP
                && let Some(oldest) = state
                    .queue
                    .iter()
                    .position(|queued| matches!(queued, AppEvent::Notice { .. }))
            {
                state.queue.remove(oldest);
            }
        }
        state.queue.push_back(event);
        drop(state);
        self.ready.notify_one();
    }

    /// Drops what was queued for the old epoch.
    pub fn next_epoch(&self) -> u64 {
        let mut state = self.lock();
        state.epoch += 1;
        let epoch = state.epoch;
        state.queue.retain(|event| !State::is_stale(event, epoch));
        for queue in state.subs.values_mut() {
            *queue = SubQueue::default();
        }
        epoch
    }

    pub fn take(&self) -> Option<Batch> {
        let mut state = self.lock();
        if state.queue.is_empty() {
            return None;
        }
        let count = state.queue.len().min(BATCH_LIMIT);
        let events: Vec<AppEvent> = state.queue.drain(..count).collect();
        for event in &events {
            if let AppEvent::Patch { sub, ops, .. } = event
                && let Some(queue) = state.subs.get_mut(sub)
            {
                queue.pending = queue.pending.saturating_sub(weight(ops));
            }
        }
        state.tick += 1;
        let tick = state.tick;
        let more = !state.queue.is_empty();
        drop(state);
        if more {
            self.ready.notify_one();
        }
        Some(Batch { tick, events })
    }

    pub async fn next(&self) -> Batch {
        loop {
            if let Some(batch) = self.take() {
                return batch;
            }
            self.ready.notified().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::wire::{Outcome, ReqId};

    fn replace(n: usize) -> Vec<Op> {
        vec![Op::Replace {
            path: "/n".to_owned(),
            value: json!(n),
        }]
    }

    #[test]
    fn a_slow_subscriber_gets_one_resync_in_place_of_its_patches() {
        let outbox = Outbox::default();
        for rev in 1..=PENDING_CAP as u64 + 10 {
            outbox.patch(SubId(1), rev, 0, replace(0));
        }
        outbox.patch(SubId(2), 1, 0, replace(0));
        let batch = outbox.take().unwrap();
        assert_eq!(
            batch.events,
            [
                AppEvent::Resync {
                    sub: SubId(1),
                    epoch: 0
                },
                AppEvent::Patch {
                    sub: SubId(2),
                    rev: 1,
                    epoch: 0,
                    ops: replace(0)
                }
            ]
        );
    }

    #[test]
    fn a_lagging_subscriber_gets_nothing_until_it_catches_up() {
        let outbox = Outbox::default();
        outbox.lag(SubId(1));
        outbox.lag(SubId(1));
        outbox.patch(SubId(1), 1, 0, replace(1));
        assert_eq!(outbox.take().unwrap().events.len(), 1);
        outbox.caught_up(SubId(1));
        outbox.patch(SubId(1), 2, 0, replace(2));
        assert!(matches!(
            outbox.take().unwrap().events.as_slice(),
            [AppEvent::Patch { rev: 2, .. }]
        ));
    }

    #[test]
    fn draining_makes_room_under_the_cap() {
        let outbox = Outbox::default();
        for round in 0..4 {
            for rev in 0..PENDING_CAP as u64 {
                outbox.patch(SubId(1), round * 10_000 + rev, 0, replace(0));
            }
            assert_eq!(outbox.take().unwrap().events.len(), BATCH_LIMIT);
            while outbox.take().is_some() {}
        }
    }

    #[test]
    fn ticks_count_batches() {
        let outbox = Outbox::default();
        outbox.patch(SubId(1), 1, 0, replace(1));
        assert_eq!(outbox.take().unwrap().tick, 1);
        assert!(outbox.take().is_none());
        outbox.patch(SubId(1), 2, 0, replace(2));
        assert_eq!(outbox.take().unwrap().tick, 2);
    }

    #[test]
    fn a_new_epoch_drops_the_old_one() {
        let outbox = Outbox::default();
        outbox.patch(SubId(1), 1, 0, replace(1));
        outbox.push(AppEvent::Reply {
            req: ReqId(1),
            epoch: 0,
            outcome: Outcome::Ok { value: json!(1) },
        });
        assert_eq!(outbox.next_epoch(), 1);
        outbox.patch(SubId(1), 2, 0, replace(2));
        outbox.lag(SubId(1));
        assert_eq!(
            outbox.take().unwrap().events,
            [AppEvent::Resync {
                sub: SubId(1),
                epoch: 1
            }]
        );
    }

    #[test]
    fn old_notices_make_room_for_new_ones() {
        let outbox = Outbox::default();
        for n in 0..NOTICE_CAP + 3 {
            outbox.push(AppEvent::Notice {
                slice: "s".to_owned(),
                stage: n.to_string(),
                text: String::new(),
            });
        }
        let events = outbox.take().unwrap().events;
        assert_eq!(events.len(), NOTICE_CAP);
        assert!(matches!(&events[0], AppEvent::Notice { stage, .. } if stage == "3"));
    }

    #[test]
    fn a_forgotten_subscriber_leaves_nothing_behind() {
        let outbox = Outbox::default();
        outbox.patch(SubId(1), 1, 0, replace(1));
        outbox.forget(SubId(1));
        assert!(outbox.take().is_none());
    }
}
