//! Stress tests run on several threads; the others hold a call back with a gate
//! to force the interleaving under test.

#![cfg(test)]

use std::{
    collections::{BTreeMap, HashSet},
    sync::Mutex,
    time::Duration,
};

use futures_util::stream;
use sable_protocol::{RpcError, VectorDiff};
use sable_runtime::{
    AppError, AppEvent, Cmd, Cx, Doc, Lifetime, ListDoc, LostReason, Outcome, Registry, ReplyError,
    Rpc, Slice, SubscribeRequest, Target, Window,
    testing::{Gate, TestApp},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize)]
struct CloseCall {
    room: String,
}

impl Rpc for CloseCall {
    const METHOD: &'static str = "demo.close";
    type Ok = ();
}

#[derive(Default)]
struct Counts {
    live: i64,
    most: i64,
    started: i64,
}

static LIVE: Mutex<BTreeMap<String, Counts>> = Mutex::new(BTreeMap::new());

/// Counts the instances of a key that exist at once, for as long as it lives in their state.
struct Live(String);

impl Live {
    fn new(name: &str, key: &str) -> Self {
        let name = format!("{name}/{key}");
        let mut live = LIVE.lock().unwrap();
        let counts = live.entry(name.clone()).or_default();
        counts.live += 1;
        counts.started += 1;
        counts.most = counts.most.max(counts.live);
        Self(name)
    }
}

impl Drop for Live {
    fn drop(&mut self) {
        LIVE.lock().unwrap().entry(self.0.clone()).or_default().live -= 1;
    }
}

fn counts(name: &str, key: &str) -> (i64, i64, i64) {
    let live = LIVE.lock().unwrap();
    live.get(&format!("{name}/{key}"))
        .map_or((0, 0, 0), |counts| {
            (counts.live, counts.most, counts.started)
        })
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Act {
    Echo,
    Push { value: u32 },
    Panic,
    Loop,
    Flood,
    Count,
}

enum In {
    Act(Act),
    Flooded,
}

impl From<Act> for In {
    fn from(act: Act) -> Self {
        Self::Act(act)
    }
}

#[derive(Serialize, Default)]
struct Totals {
    seen: u32,
}

struct Echo;

impl Slice for Echo {
    const NAME: &'static str = "echo";
    const LIFETIME: Lifetime = Lifetime::RefCounted {
        grace: Duration::from_secs(1),
    };

    type Key = String;
    type State = (Doc<Totals>, Live);
    type View = Doc<Totals>;
    type Action = Act;
    type Input = In;

    fn init(key: &String, _: Option<Value>) -> (Self::State, Cmd<In>) {
        (
            (Doc::new(Totals::default()), Live::new("echo", key)),
            Cmd::none(),
        )
    }

    fn view(state: &mut Self::State) -> &mut Doc<Totals> {
        &mut state.0
    }

    fn reduce(_: &String, state: &mut Self::State, input: In, cx: &Cx) -> Cmd<In> {
        match input {
            In::Act(Act::Echo) => {
                state.0.edit("/seen", |totals| totals.seen += 1);
                Cmd::reply(cx.req(), Ok::<_, RpcError>(json!("echo")))
            }
            In::Act(Act::Count) => {
                state.0.edit("/seen", |totals| totals.seen += 1);
                Cmd::none()
            }
            In::Act(Act::Loop) => {
                state.0.edit("/seen", |totals| totals.seen += 1);
                Cmd::input(In::Act(Act::Loop))
            }
            In::Act(Act::Flood) => Cmd::stream("flood", |_| {
                stream::unfold(0, |n| async move { Some((In::Flooded, n + 1)) })
            }),
            In::Flooded => {
                state.0.edit("/seen", |totals| totals.seen += 1);
                Cmd::none()
            }
            In::Act(Act::Push { .. } | Act::Panic) => Cmd::none(),
        }
    }
}

/// Saves its list and can be made to panic.
struct Notes;

impl Slice for Notes {
    const NAME: &'static str = "notes";
    const LIFETIME: Lifetime = Lifetime::RefCounted {
        grace: Duration::from_secs(5),
    };
    const PERSIST: bool = true;

    type Key = String;
    type State = (ListDoc<u32>, Live);
    type View = ListDoc<u32>;
    type Action = Act;
    type Input = Act;

    fn init(key: &String, cached: Option<Value>) -> (Self::State, Cmd<Act>) {
        (
            (
                cached
                    .and_then(ListDoc::from_cached)
                    .unwrap_or_else(|| ListDoc::new(Vec::new())),
                Live::new("notes", key),
            ),
            Cmd::none(),
        )
    }

    fn view(state: &mut Self::State) -> &mut ListDoc<u32> {
        &mut state.0
    }

    fn reduce(_: &String, state: &mut Self::State, act: Act, cx: &Cx) -> Cmd<Act> {
        match act {
            Act::Push { value } => {
                let _ = state.0.apply(VectorDiff::PushBack { value });
            }
            Act::Echo => return Cmd::reply(cx.req(), Ok::<_, RpcError>(json!("echo"))),
            Act::Panic => panic!("a slice that is broken"),
            Act::Loop | Act::Flood | Act::Count => {}
        }
        Cmd::none()
    }

    fn dispose(key: &String, _: &mut Self::State) -> Cmd<Act> {
        Cmd::task({
            let room = key.clone();
            |ports| async move {
                let _ = ports.backend.run(CloseCall { room }).await;
                None
            }
        })
    }
}

/// Fails in the place its key names.
struct Fragile;

impl Slice for Fragile {
    const NAME: &'static str = "fragile";
    const LIFETIME: Lifetime = Lifetime::Singleton;

    type Key = String;
    type State = Doc<Totals>;
    type View = Doc<Totals>;
    type Action = Act;
    type Input = Act;

    fn init(key: &String, _: Option<Value>) -> (Self::State, Cmd<Act>) {
        assert!(key != "init", "a slice that cannot start");
        (Doc::new(Totals::default()), Cmd::none())
    }

    fn view(state: &mut Self::State) -> &mut Doc<Totals> {
        state
    }

    fn reduce(key: &String, _: &mut Self::State, act: Act, _: &Cx) -> Cmd<Act> {
        match (key.as_str(), act) {
            ("task", Act::Echo) => Cmd::task(|_| async { panic!("a task that is broken") }),
            ("stream", Act::Echo) => Cmd::stream("broken", |_| {
                stream::once(async { panic!("a stream that is broken") })
            }),
            _ => Cmd::none(),
        }
    }

    fn dispose(key: &String, _: &mut Self::State) -> Cmd<Act> {
        assert!(key != "dispose", "a slice that cannot stop");
        Cmd::none()
    }
}

fn harness() -> TestApp {
    let mut registry = Registry::new();
    registry
        .add::<Echo>()
        .and_then(|registry| registry.add::<Notes>())
        .and_then(|registry| registry.add::<Fragile>())
        .unwrap();
    let harness = TestApp::new(registry);
    harness.backend.expect::<CloseCall>().returns(());
    harness
}

fn target(slice: &str, key: &str) -> Target {
    Target {
        slice: slice.to_owned(),
        key: json!(key),
    }
}

fn request(slice: &str, key: &str) -> SubscribeRequest {
    SubscribeRequest {
        target: target(slice, key),
        window: None,
    }
}

async fn pump() {
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
}

fn closed(harness: &TestApp) -> Vec<String> {
    harness
        .backend
        .calls::<CloseCall>()
        .into_iter()
        .map(|call| call.room)
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn calls_racing_disposal_and_account_changes_never_overlap_or_lose_a_live_request() {
    for round in 0..20 {
        let harness = harness();
        let key = format!("race-{round}");
        let sent = harness.app.clone();
        let sender = {
            let (app, key) = (sent, key.clone());
            tokio::spawn(async move {
                let mut sent = Vec::new();
                for _ in 0..60 {
                    sent.push(
                        app.request(&target("echo", &key), json!({"type": "echo"}))
                            .await,
                    );
                    tokio::task::yield_now().await;
                }
                sent
            })
        };
        let clock = harness.clock.clone();
        let ticker = tokio::spawn(async move {
            for _ in 0..200 {
                clock.advance(Duration::from_secs(2));
                tokio::task::yield_now().await;
            }
        });
        let app = harness.app.clone();
        let switcher = tokio::spawn(async move {
            for turn in 0..10 {
                app.switch_account(format!("account-{turn}")).await;
                tokio::task::yield_now().await;
            }
        });
        let app = harness.app.clone();
        let subscriber = {
            let key = key.clone();
            tokio::spawn(async move {
                for _ in 0..40 {
                    if let Ok(subscribed) = app.subscribe(request("echo", &key)).await {
                        tokio::task::yield_now().await;
                        app.unsubscribe(subscribed.sub).await;
                    }
                }
            })
        };

        let sent = sender.await.unwrap();
        ticker.await.unwrap();
        switcher.await.unwrap();
        subscriber.await.unwrap();
        harness.app.shutdown().await;

        let replies: Vec<(sable_runtime::ReqId, Outcome)> = harness
            .events()
            .await
            .into_iter()
            .filter_map(|event| match event {
                AppEvent::Reply { req, outcome, .. } => Some((req, outcome)),
                _ => None,
            })
            .collect();
        let mut answered = HashSet::new();
        for (req, outcome) in &replies {
            assert!(answered.insert(*req), "{req} was answered twice");
            assert!(
                !matches!(
                    outcome,
                    Outcome::Error {
                        error: ReplyError::Lost {
                            reason: LostReason::InstanceFailed
                        }
                    }
                ),
                "{req} was lost to a failure nothing caused"
            );
        }
        for req in sent.into_iter().flatten() {
            assert!(
                answered.contains(&req),
                "{req} never got an answer (round {round})"
            );
        }
        let (live, most, started) = counts("echo", &key);
        assert_eq!(live, 0, "an instance outlived the app");
        assert_eq!(
            most, 1,
            "two instances of one key at once ({started} started)"
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_new_instance_waits_for_the_old_one_to_finish_disposing() {
    let harness = harness();
    let gate = Gate::default();
    let first = harness
        .app
        .subscribe(request("notes", "wait"))
        .await
        .unwrap();
    harness
        .app
        .dispatch(
            &target("notes", "wait"),
            json!({"type": "push", "value": 1}),
        )
        .await
        .unwrap();
    harness.settle().await;
    harness.platform.hold_writes(&gate);

    let app = harness.app.clone();
    let switching = tokio::spawn(async move { app.switch_account("account-b").await });
    pump().await;
    let app = harness.app.clone();
    let subscribing = tokio::spawn(async move { app.subscribe(request("notes", "wait")).await });
    pump().await;
    assert_eq!(
        counts("notes", "wait").2,
        1,
        "no second instance while the first is stopping"
    );
    assert!(!subscribing.is_finished());

    let app = harness.app.clone();
    let requesting = tokio::spawn(async move {
        app.request(&target("notes", "wait"), json!({"type": "echo"}))
            .await
    });
    pump().await;
    assert!(!requesting.is_finished());

    gate.open();
    switching.await.unwrap();
    let second = subscribing.await.unwrap().unwrap();
    let req = requesting.await.unwrap().unwrap();
    let events = harness.events().await;
    assert!(
        events.iter().any(|event| matches!(
            event,
            AppEvent::Reply { req: replied, epoch: 1, outcome: Outcome::Ok { .. } } if *replied == req
        )),
        "a request to the new instance is answered, not lost to the old one: {events:?}"
    );
    assert_eq!(counts("notes", "wait").2, 2);
    assert_eq!(counts("notes", "wait").1, 1, "the two never overlapped");
    assert_eq!(second.snapshot.epoch, 1);
    assert_eq!(
        second.snapshot.state,
        json!({"total": 0, "items": []}),
        "account b does not see account a's list"
    );
    let _ = first;
}

#[tokio::test(flavor = "current_thread")]
async fn a_cancelled_account_change_does_not_free_the_id_before_the_instance_is_gone() {
    let harness = harness();
    let gate = Gate::default();
    harness
        .app
        .subscribe(request("notes", "cancel"))
        .await
        .unwrap();
    harness
        .app
        .dispatch(
            &target("notes", "cancel"),
            json!({"type": "push", "value": 1}),
        )
        .await
        .unwrap();
    harness.settle().await;
    harness.platform.hold_writes(&gate);

    let app = harness.app.clone();
    let switching = tokio::spawn(async move { app.switch_account("account-b").await });
    pump().await;
    switching.abort();
    let _ = switching.await;

    let app = harness.app.clone();
    let subscribing = tokio::spawn(async move { app.subscribe(request("notes", "cancel")).await });
    pump().await;
    assert_eq!(
        counts("notes", "cancel").2,
        1,
        "the old instance is still saving"
    );
    gate.open();
    subscribing.await.unwrap().unwrap();
    assert_eq!(counts("notes", "cancel").1, 1, "the two never overlapped");
}

#[tokio::test(flavor = "current_thread")]
async fn a_subscription_whose_call_is_dropped_leaves_nothing_behind() {
    let harness = harness();
    let gate = Gate::default();
    harness.platform.hold_reads(&gate);

    let app = harness.app.clone();
    let subscribing = tokio::spawn(async move { app.subscribe(request("notes", "drop")).await });
    pump().await;
    subscribing.abort();
    let _ = subscribing.await;
    gate.open();
    pump().await;
    harness.settle().await;

    harness.advance(Duration::from_secs(5)).await;
    assert_eq!(
        closed(&harness),
        ["drop"],
        "its hold on the instance was given back"
    );
    assert_eq!(counts("notes", "drop").0, 0);
}

#[tokio::test(flavor = "current_thread")]
async fn two_resyncs_of_a_dead_instance_reattach_once() {
    let harness = harness();
    let subscribed = harness
        .app
        .subscribe(request("notes", "dead"))
        .await
        .unwrap();
    harness
        .app
        .dispatch(&target("notes", "dead"), json!({"type": "panic"}))
        .await
        .unwrap();
    harness.settle().await;
    harness.events().await;

    let (first, second) = tokio::join!(
        harness.app.resync(subscribed.sub),
        harness.app.resync(subscribed.sub)
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(counts("notes", "dead").2, 2, "one new instance, not two");

    harness.app.unsubscribe(subscribed.sub).await;
    harness.advance(Duration::from_secs(5)).await;
    assert_eq!(closed(&harness), ["dead"], "every hold was given back");
}

#[tokio::test(flavor = "current_thread")]
async fn unsubscribing_while_a_dead_instance_is_reattached_leaves_nothing_behind() {
    let harness = harness();
    let subscribed = harness
        .app
        .subscribe(request("notes", "raced"))
        .await
        .unwrap();
    harness
        .app
        .dispatch(&target("notes", "raced"), json!({"type": "panic"}))
        .await
        .unwrap();
    harness.settle().await;
    harness.events().await;

    let gate = Gate::default();
    harness.platform.hold_reads(&gate);
    let app = harness.app.clone();
    let sub = subscribed.sub;
    let resyncing = tokio::spawn(async move { app.resync(sub).await });
    pump().await;
    harness.app.unsubscribe(sub).await;
    gate.open();
    assert_eq!(resyncing.await.unwrap().unwrap_err(), AppError::UnknownSub);

    pump().await;
    harness.advance(Duration::from_secs(5)).await;
    assert_eq!(closed(&harness), ["raced"]);
    assert_eq!(counts("notes", "raced").0, 0);
}

#[tokio::test(flavor = "current_thread")]
async fn two_subscribers_move_their_windows_apart() {
    let harness = harness();
    for value in 0..6 {
        harness
            .app
            .dispatch(
                &target("notes", "windows"),
                json!({"type": "push", "value": value}),
            )
            .await
            .unwrap();
    }
    let at = |start, end| SubscribeRequest {
        target: target("notes", "windows"),
        window: Some(Window { start, end }),
    };
    let one = harness.app.subscribe(at(0, 2)).await.unwrap();
    let two = harness.app.subscribe(at(2, 4)).await.unwrap();
    assert_eq!(one.snapshot.state["items"], json!([0, 1]));
    assert_eq!(two.snapshot.state["items"], json!([2, 3]));

    let whole = harness.app.range(one.sub, None).await.unwrap();
    assert_eq!(
        whole.state["items"],
        json!([0, 1, 2, 3, 4, 5]),
        "back to the whole list"
    );
    assert_eq!(
        harness.app.resync(two.sub).await.unwrap().state["items"],
        json!([2, 3]),
        "the other window stayed"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_panic_in_a_task_a_stream_or_init_fails_only_that_instance() {
    let harness = harness();
    for key in ["task", "stream"] {
        let subscribed = harness
            .app
            .subscribe(request("fragile", key))
            .await
            .unwrap();
        harness
            .app
            .dispatch(&target("fragile", key), json!({"type": "echo"}))
            .await
            .unwrap();
        let events = harness.events().await;
        assert!(
            events.contains(&AppEvent::Resync {
                sub: subscribed.sub,
                epoch: 0
            }),
            "{key}: {events:?}"
        );
    }

    assert_eq!(
        harness
            .app
            .subscribe(request("fragile", "init"))
            .await
            .unwrap_err(),
        AppError::Stopped
    );
    let healthy = harness
        .app
        .subscribe(request("echo", "fine"))
        .await
        .unwrap();
    assert_eq!(healthy.snapshot.state, json!({"seen": 0}));
}

#[tokio::test(flavor = "current_thread")]
async fn a_request_to_an_instance_whose_task_panics_is_lost_at_once() {
    let harness = harness();
    harness
        .app
        .subscribe(request("fragile", "task"))
        .await
        .unwrap();
    let req = harness
        .app
        .request(&target("fragile", "task"), json!({"type": "echo"}))
        .await
        .unwrap();
    let events = harness.events().await;
    assert!(
        events.iter().any(|event| matches!(
            event,
            AppEvent::Reply { req: lost, outcome: Outcome::Error {
                error: ReplyError::Lost { reason: LostReason::InstanceFailed }
            }, .. } if *lost == req
        )),
        "{events:?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_panic_while_disposing_does_not_hold_up_the_account_change() {
    let harness = harness();
    harness
        .app
        .subscribe(request("fragile", "dispose"))
        .await
        .unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        harness.app.switch_account("account-b"),
    )
    .await
    .expect("the switch finishes");
    harness
        .app
        .subscribe(request("fragile", "dispose"))
        .await
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn a_slice_that_keeps_producing_inputs_still_answers_the_inbox() {
    let harness = harness();
    let subscribed = harness
        .app
        .subscribe(request("echo", "loop"))
        .await
        .unwrap();
    harness
        .app
        .dispatch(&target("echo", "loop"), json!({"type": "loop"}))
        .await
        .unwrap();
    harness.settle().await;
    let seen = harness.app.resync(subscribed.sub).await.unwrap().state["seen"]
        .as_u64()
        .unwrap();
    assert!((1..=10_001).contains(&seen), "{seen}");
    tokio::time::timeout(
        Duration::from_secs(5),
        harness.app.switch_account("account-b"),
    )
    .await
    .expect("it still stops");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_inbox_makes_senders_wait_and_loses_nothing() {
    let harness = harness();
    let subscribed = harness
        .app
        .subscribe(request("echo", "full"))
        .await
        .unwrap();
    let sends: Vec<_> = (0..2000)
        .map(|_| {
            let app = harness.app.clone();
            tokio::spawn(async move {
                app.dispatch(&target("echo", "full"), json!({"type": "count"}))
                    .await
            })
        })
        .collect();
    for send in sends {
        send.await.unwrap().unwrap();
    }
    harness.settle().await;
    assert_eq!(
        harness.app.resync(subscribed.sub).await.unwrap().state["seen"],
        2000
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stream_that_never_pauses_does_not_keep_its_instance_from_stopping() {
    let harness = harness();
    harness
        .app
        .subscribe(request("echo", "flood"))
        .await
        .unwrap();
    harness
        .app
        .dispatch(&target("echo", "flood"), json!({"type": "flood"}))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    tokio::time::timeout(
        Duration::from_secs(5),
        harness.app.switch_account("account-b"),
    )
    .await
    .expect("the stop gets through the flood");
    assert_eq!(counts("echo", "flood").0, 0);
}

#[tokio::test(flavor = "current_thread")]
async fn dropping_the_app_ends_its_instances_and_shutdown_waits_for_them() {
    let harness = harness();
    harness
        .app
        .subscribe(request("echo", "dropped"))
        .await
        .unwrap();
    harness
        .app
        .subscribe(request("notes", "shut"))
        .await
        .unwrap();
    harness.app.shutdown().await;
    assert_eq!(
        counts("notes", "shut").0,
        0,
        "shutdown returned after the disposal"
    );
    harness.settle().await;
    assert_eq!(closed(&harness), ["shut"]);

    drop(harness);
    pump().await;
    assert_eq!(
        counts("echo", "dropped").0,
        0,
        "nothing keeps an instance of a dropped app alive"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn the_grace_task_survives_long_enough_to_finish_disposing() {
    let harness = harness();
    let subscribed = harness
        .app
        .subscribe(request("notes", "grace"))
        .await
        .unwrap();
    harness.app.unsubscribe(subscribed.sub).await;
    let gate = Gate::default();
    harness.platform.hold_writes(&gate);
    harness
        .app
        .dispatch(
            &target("notes", "grace"),
            json!({"type": "push", "value": 1}),
        )
        .await
        .unwrap();
    harness.advance(Duration::from_secs(5)).await;
    pump().await;
    assert_eq!(counts("notes", "grace").0, 1, "still saving");

    gate.open();
    pump().await;
    assert_eq!(counts("notes", "grace").0, 0);
    assert_eq!(closed(&harness), ["grace"]);
}
