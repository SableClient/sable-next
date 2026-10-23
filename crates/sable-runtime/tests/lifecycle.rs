//! Stress tests run on several threads; the others hold a call back with a gate
//! to force the interleaving under test.

#![cfg(test)]

use std::{
    collections::{BTreeMap, HashSet},
    sync::Mutex,
    time::Duration,
};

use sable_protocol::{RpcError, VectorDiff};
use sable_runtime::{
    AppError, AppEvent, Cmd, Cx, Doc, Lifetime, ListDoc, Outcome, Registry, Rpc, Slice,
    SubscribeRequest, Subscribed, Target, Window,
    testing::{Gate, Replica, TestApp},
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
    Count,
}

enum In {
    Act(Act),
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
        grace: Duration::from_millis(1),
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
                state.0.edit_fields(|totals| totals.seen += 1);
                Cmd::reply(cx.req(), Ok::<_, RpcError>(json!("echo")))
            }
            In::Act(Act::Count) => {
                state.0.edit_fields(|totals| totals.seen += 1);
                Cmd::none()
            }
            In::Act(Act::Panic) => panic!("reducer panic"),
            In::Act(Act::Push { .. }) => Cmd::none(),
        }
    }
}

/// Saves its list.
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
            Act::Panic | Act::Count => {}
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

fn harness() -> TestApp {
    let mut registry = Registry::new();
    registry
        .add::<Echo>()
        .and_then(|registry| registry.add::<Notes>())
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

async fn subscribe(harness: &TestApp, slice: &str, key: &str) -> Subscribed {
    harness.app.subscribe(request(slice, key)).await.unwrap()
}

async fn dispatch(harness: &TestApp, slice: &str, key: &str, action: Value) {
    harness
        .app
        .dispatch(&target(slice, key), action)
        .await
        .unwrap();
}

async fn abandoned_notes(harness: &TestApp, key: &str) -> Subscribed {
    let subscribed = subscribe(harness, "notes", key).await;
    harness.app.switch_account("account-b").await;
    harness.settle().await;
    harness.events().await;
    subscribed
}

fn spawn_switch(harness: &TestApp) -> tokio::task::JoinHandle<()> {
    let app = harness.app.clone();
    tokio::spawn(async move { app.switch_account("account-b").await })
}

fn spawn_subscribe(
    harness: &TestApp,
    key: &str,
) -> tokio::task::JoinHandle<Result<Subscribed, AppError>> {
    let (app, key) = (harness.app.clone(), key.to_owned());
    tokio::spawn(async move { app.subscribe(request("notes", &key)).await })
}

async fn switching_over_a_held_write(
    harness: &TestApp,
    key: &str,
    gate: &Gate,
) -> tokio::task::JoinHandle<()> {
    subscribe(harness, "notes", key).await;
    dispatch(harness, "notes", key, json!({"type": "push", "value": 1})).await;
    harness.settle().await;
    harness.platform.hold_writes(gate);
    let switching = spawn_switch(harness);
    pump().await;
    switching
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
                for turn in 0..40 {
                    if let Ok(subscribed) = app.subscribe(request("echo", &key)).await {
                        tokio::task::yield_now().await;
                        app.unsubscribe(subscribed.sub).await;
                    }
                    if turn % 4 == 0 {
                        tokio::time::sleep(Duration::from_millis(2)).await;
                    }
                }
            })
        };

        let sent = sender.await.unwrap();
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
        for (req, _) in &replies {
            assert!(answered.insert(*req), "{req} was answered twice");
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
    let switching = switching_over_a_held_write(&harness, "wait", &gate).await;
    let subscribing = spawn_subscribe(&harness, "wait");
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
}

#[tokio::test(flavor = "current_thread")]
async fn a_cancelled_account_change_does_not_free_the_id_before_the_instance_is_gone() {
    let harness = harness();
    let gate = Gate::default();
    let switching = switching_over_a_held_write(&harness, "cancel", &gate).await;
    switching.abort();
    let _ = switching.await;

    let subscribing = spawn_subscribe(&harness, "cancel");
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

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_subscription_whose_call_is_dropped_leaves_nothing_behind() {
    let harness = harness();
    let gate = Gate::default();
    harness.platform.hold_reads(&gate);

    let subscribing = spawn_subscribe(&harness, "drop");
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

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn two_resyncs_of_an_abandoned_instance_reattach_once() {
    let harness = harness();
    let subscribed = abandoned_notes(&harness, "dead").await;

    let (first, second) = tokio::join!(
        harness.app.resync(subscribed.sub),
        harness.app.resync(subscribed.sub)
    );
    first.unwrap();
    second.unwrap();
    assert_eq!(counts("notes", "dead").2, 2, "one new instance, not two");

    harness.app.unsubscribe(subscribed.sub).await;
    harness.advance(Duration::from_secs(5)).await;
    assert_eq!(
        closed(&harness),
        ["dead", "dead"],
        "every hold was given back"
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn unsubscribing_while_an_abandoned_instance_is_reattached_leaves_nothing_behind() {
    let harness = harness();
    let sub = abandoned_notes(&harness, "raced").await.sub;

    let gate = Gate::default();
    harness.platform.hold_reads(&gate);
    let app = harness.app.clone();
    let resyncing = tokio::spawn(async move { app.resync(sub).await });
    pump().await;
    harness.app.unsubscribe(sub).await;
    gate.open();
    assert_eq!(resyncing.await.unwrap().unwrap_err(), AppError::UnknownSub);

    pump().await;
    harness.advance(Duration::from_secs(5)).await;
    assert_eq!(closed(&harness), ["raced", "raced"]);
    assert_eq!(counts("notes", "raced").0, 0);
}

#[tokio::test(flavor = "current_thread")]
async fn two_subscribers_move_their_windows_apart() {
    let harness = harness();
    for value in 0..6 {
        dispatch(
            &harness,
            "notes",
            "windows",
            json!({"type": "push", "value": value}),
        )
        .await;
    }
    let at = |start, end| SubscribeRequest {
        target: target("notes", "windows"),
        window: Some(Window { start, end }),
    };
    let one = harness.app.subscribe(at(0, 2)).await.unwrap();
    let two = harness.app.subscribe(at(2, 4)).await.unwrap();
    assert_eq!(one.snapshot.state["items"], json!([0, 1]));
    assert_eq!(two.snapshot.state["items"], json!([2, 3]));

    for (window, items) in [
        (Some(Window { start: 4, end: 20 }), json!([4, 5])),
        (None, json!([0, 1, 2, 3, 4, 5])),
    ] {
        let moved = harness.app.range(one.sub, window).await.unwrap();
        assert_eq!(moved.state["items"], items);
    }
    assert_eq!(
        harness.app.resync(two.sub).await.unwrap().state["items"],
        json!([2, 3]),
        "the other window stayed"
    );
    let mut all = Replica::new(&one);
    all.reset(&harness.app.resync(one.sub).await.unwrap());
    let mut middle = Replica::new(&two);
    for value in 6..9 {
        dispatch(
            &harness,
            "notes",
            "windows",
            json!({"type": "push", "value": value}),
        )
        .await;
    }
    for event in harness.events().await {
        all.apply(&event).unwrap();
        middle.apply(&event).unwrap();
    }
    assert_eq!(
        all.state,
        json!({"total": 9, "items": (0..9).collect::<Vec<_>>()})
    );
    assert_eq!(middle.state, json!({"total": 9, "items": [2, 3]}));

    all.reset(
        &harness
            .app
            .range(one.sub, Some(Window { start: 7, end: 12 }))
            .await
            .unwrap(),
    );
    dispatch(
        &harness,
        "notes",
        "windows",
        json!({"type": "push", "value": 9}),
    )
    .await;
    for event in harness.events().await {
        all.apply(&event).unwrap();
        middle.apply(&event).unwrap();
    }
    assert_eq!(all.state, json!({"total": 10, "items": [7, 8, 9]}));
    assert_eq!(middle.state, json!({"total": 10, "items": [2, 3]}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_inbox_makes_senders_wait_and_loses_nothing() {
    let harness = harness();
    let subscribed = subscribe(&harness, "echo", "full").await;
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

#[tokio::test(flavor = "current_thread")]
async fn dropping_the_app_ends_its_instances_and_shutdown_waits_for_them() {
    let harness = harness();
    subscribe(&harness, "echo", "dropped").await;
    subscribe(&harness, "notes", "shut").await;
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

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_grace_task_survives_long_enough_to_finish_disposing() {
    let harness = harness();
    let subscribed = subscribe(&harness, "notes", "grace").await;
    harness.app.unsubscribe(subscribed.sub).await;
    let gate = Gate::default();
    harness.platform.hold_writes(&gate);
    dispatch(
        &harness,
        "notes",
        "grace",
        json!({"type": "push", "value": 1}),
    )
    .await;
    harness.advance(Duration::from_secs(5)).await;
    pump().await;
    assert_eq!(counts("notes", "grace").0, 1, "still saving");

    gate.open();
    pump().await;
    assert_eq!(counts("notes", "grace").0, 0);
    assert_eq!(closed(&harness), ["grace"]);
}

#[tokio::test(flavor = "current_thread")]
async fn a_reducer_panic_loses_requests_and_the_next_call_starts_a_working_instance() {
    let harness = harness();
    subscribe(&harness, "echo", "panic").await;
    let req = harness
        .app
        .request(&target("echo", "panic"), json!({"type": "panic"}))
        .await
        .unwrap();
    pump().await;
    assert!(harness.events().await.iter().any(|event| matches!(event,
        AppEvent::Reply { req: replied, outcome: Outcome::Error { error: sable_runtime::ReplyError::Lost { reason: sable_runtime::LostReason::InstanceStopped } }, .. } if *replied == req
    )));
    dispatch(&harness, "echo", "panic", json!({"type": "count"})).await;
    let fresh = subscribe(&harness, "echo", "panic").await;
    assert_eq!(fresh.snapshot.state["seen"], 1);
    assert_eq!(counts("echo", "panic").2, 2);
    harness.app.shutdown().await;
}

#[tokio::test(flavor = "current_thread")]
async fn account_switch_waits_for_dispose_calls() {
    let harness = harness();
    let gate = Gate::default();
    harness
        .backend
        .expect::<CloseCall>()
        .after(&gate)
        .returns(());
    subscribe(&harness, "notes", "dispose-call").await;
    let switching = spawn_switch(&harness);
    pump().await;
    assert_eq!(closed(&harness), ["dispose-call"]);
    assert!(!switching.is_finished());
    gate.open();
    switching.await.unwrap();
    assert_eq!(counts("notes", "dispose-call").0, 0);
}

#[tokio::test(flavor = "current_thread")]
async fn shutdown_holds_new_calls_until_the_account_changes() {
    let harness = harness();
    subscribe(&harness, "notes", "paused").await;
    harness.app.shutdown().await;
    let subscribing = spawn_subscribe(&harness, "paused");
    pump().await;
    assert!(!subscribing.is_finished());
    harness.app.switch_account("b").await;
    let subscribed = subscribing.await.unwrap().unwrap();
    assert_eq!(subscribed.snapshot.epoch, 1);
    harness.app.shutdown().await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn shutdown_and_account_switch_wait_for_disposal_already_started_by_grace() {
    let harness = harness();
    let gate = Gate::default();
    harness
        .backend
        .expect::<CloseCall>()
        .after(&gate)
        .returns(());
    let subscribed = subscribe(&harness, "notes", "closing").await;
    harness.app.unsubscribe(subscribed.sub).await;
    harness.advance(Duration::from_secs(5)).await;
    assert_eq!(closed(&harness), ["closing"]);
    let app = harness.app.clone();
    let shutdown = tokio::spawn(async move { app.shutdown().await });
    let switching = spawn_switch(&harness);
    pump().await;
    assert!(!shutdown.is_finished());
    assert!(!switching.is_finished());
    gate.open();
    shutdown.await.unwrap();
    switching.await.unwrap();
}
