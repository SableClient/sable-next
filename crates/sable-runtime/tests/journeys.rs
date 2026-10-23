//! The runtime through its public API, with demo slices standing in for real ones.

#![cfg(test)]

use std::{
    collections::BTreeMap,
    fmt::{self, Debug},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use futures_util::stream;
use proptest::prelude::*;
use sable_protocol::{CoreEvent, CoreEventKind, RpcError, VectorDiff};
use sable_runtime::{
    AppError, AppEvent, Clock, Cmd, Cx, Doc, Followed, Interest, Lifetime, ListDoc, LostReason, Op,
    Outcome, Registry, ReplyError, ReqId, Rpc, Slice, SubscribeRequest, SystemClock, Target,
    Window,
    testing::{TestApp, Gate, Replica, assert_patches_converge},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tracing_subscriber::{Layer, layer::SubscriberExt};

#[derive(Serialize, Deserialize)]
struct DoubleCall {
    value: i64,
}

#[derive(Serialize, Deserialize, Clone)]
struct Doubled {
    value: i64,
}

impl Rpc for DoubleCall {
    const METHOD: &'static str = "demo.double";
    type Ok = Doubled;
}

#[derive(Serialize, Deserialize)]
struct OpenCall {
    room: String,
}

impl Rpc for OpenCall {
    const METHOD: &'static str = "demo.open";
    type Ok = ();
}

#[derive(Serialize, Deserialize)]
struct CloseCall {
    room: String,
}

impl Rpc for CloseCall {
    const METHOD: &'static str = "demo.close";
    type Ok = ();
}

#[derive(Serialize, Deserialize)]
struct LoadProfile {
    user: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct ProfileData {
    name: String,
}

impl Rpc for LoadProfile {
    const METHOD: &'static str = "demo.load_profile";
    type Ok = ProfileData;
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CounterView {
    count: i64,
    ticks: u32,
    idle: u32,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CounterAction {
    Add { n: i64 },
    Double,
    Panic,
    Open { url: String },
    Stream,
    EndStream,
    Debounce,
    Cancel,
    Notify,
    Chain,
}

enum CounterInput {
    Action(CounterAction),
    Doubled(Option<ReqId>, Result<Doubled, RpcError>),
    Ticked(u32),
    Idle,
}

impl From<CounterAction> for CounterInput {
    fn from(action: CounterAction) -> Self {
        Self::Action(action)
    }
}

static COUNTER_OFFERS: AtomicUsize = AtomicUsize::new(0);

struct Counter;

impl Slice for Counter {
    const NAME: &'static str = "counter";
    const LIFETIME: Lifetime = Lifetime::Singleton;
    const INTEREST: Interest = Interest::of(&[CoreEventKind::SessionTokensRefreshed]);

    type Key = ();
    type State = Doc<CounterView>;
    type View = Doc<CounterView>;
    type Action = CounterAction;
    type Input = CounterInput;

    fn init((): &(), _: Option<Value>) -> (Self::State, Cmd<CounterInput>) {
        (Doc::new(CounterView::default()), Cmd::none())
    }

    fn core_input(event: &CoreEvent) -> Option<CounterInput> {
        COUNTER_OFFERS.fetch_add(1, Ordering::SeqCst);
        matches!(event, CoreEvent::SessionTokensRefreshed).then_some(CounterInput::Ticked(1000))
    }

    fn view(state: &mut Self::State) -> &mut Self::View {
        state
    }

    fn reduce((): &(), state: &mut Self::State, input: CounterInput, cx: &Cx) -> Cmd<CounterInput> {
        match input {
            CounterInput::Action(CounterAction::Add { n }) => {
                state.edit("/count", |view| view.count += n);
                Cmd::none()
            }
            CounterInput::Action(CounterAction::Double) => {
                let req = cx.req();
                Cmd::rpc(
                    DoubleCall {
                        value: state.view().count,
                    },
                    move |result| CounterInput::Doubled(req, result),
                )
            }
            CounterInput::Doubled(req, Ok(done)) => {
                state.edit("/count", |view| view.count = done.value);
                Cmd::reply(req, Ok(done.value))
            }
            CounterInput::Doubled(req, Err(error)) => Cmd::reply::<i64>(req, Err(error)),
            CounterInput::Action(CounterAction::Panic) => panic!("a slice that is broken"),
            CounterInput::Action(CounterAction::Open { url }) => Cmd::task(|ports| async move {
                let _ = ports.platform.open_url(&url).await;
                None
            }),
            CounterInput::Action(CounterAction::Stream) => Cmd::stream("ticks", |ports| {
                stream::unfold(0, move |ticks| {
                    let clock = ports.clock.clone();
                    async move {
                        clock.sleep(Duration::from_secs(1)).await;
                        Some((CounterInput::Ticked(ticks + 1), ticks + 1))
                    }
                })
            }),
            CounterInput::Action(CounterAction::EndStream) => Cmd::end_stream("ticks"),
            CounterInput::Action(CounterAction::Debounce) => {
                Cmd::debounce("idle", Duration::from_secs(3), CounterInput::Idle)
            }
            CounterInput::Action(CounterAction::Cancel) => Cmd::cancel("idle"),
            CounterInput::Action(CounterAction::Notify) => Cmd::batch([
                Cmd::notice("saved", "Saved"),
                Cmd::input(CounterInput::Ticked(7)),
            ]),
            CounterInput::Action(CounterAction::Chain) => Cmd::cancel("idle")
                .then(Cmd::after(
                    "idle",
                    Duration::from_secs(1),
                    CounterInput::Idle,
                ))
                .then(Cmd::after(
                    "idle",
                    Duration::from_secs(9),
                    CounterInput::Idle,
                )),
            CounterInput::Ticked(ticks) => {
                state.edit("/ticks", |view| view.ticks = ticks);
                Cmd::none()
            }
            CounterInput::Idle => {
                state.edit("/idle", |view| view.idle += 1);
                Cmd::none()
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RoomAction {
    Push { value: u32 },
    Append { count: u32 },
    Insert { index: usize, value: u32 },
    Remove { index: usize },
    PopFront,
    Clear,
}

enum RoomInput {
    Action(RoomAction),
    Done,
}

impl From<RoomAction> for RoomInput {
    fn from(action: RoomAction) -> Self {
        Self::Action(action)
    }
}

struct Room;

impl Slice for Room {
    const NAME: &'static str = "room";
    const LIFETIME: Lifetime = Lifetime::RefCounted {
        grace: Duration::from_secs(5),
    };

    type Key = String;
    type State = ListDoc<u32>;
    type View = ListDoc<u32>;
    type Action = RoomAction;
    type Input = RoomInput;

    fn init(room: &String, _: Option<Value>) -> (Self::State, Cmd<RoomInput>) {
        (
            ListDoc::new(Vec::new()),
            Cmd::rpc(OpenCall { room: room.clone() }, |_| RoomInput::Done),
        )
    }

    fn view(state: &mut Self::State) -> &mut Self::View {
        state
    }

    fn reduce(_: &String, state: &mut Self::State, input: RoomInput, _: &Cx) -> Cmd<RoomInput> {
        let RoomInput::Action(action) = input else {
            return Cmd::none();
        };
        let diff = match action {
            RoomAction::Push { value } => VectorDiff::PushBack { value },
            RoomAction::Append { count } => VectorDiff::Append {
                values: (0..count).collect(),
            },
            RoomAction::Insert { index, value } => VectorDiff::Insert { index, value },
            RoomAction::Remove { index } => VectorDiff::Remove { index },
            RoomAction::PopFront => VectorDiff::PopFront,
            RoomAction::Clear => VectorDiff::Clear,
        };
        match state.apply(diff) {
            Ok(()) => Cmd::none(),
            Err(error) => Cmd::notice("rejected", error.to_string()),
        }
    }

    fn dispose(room: &String, _: &mut Self::State) -> Cmd<RoomInput> {
        Cmd::rpc(CloseCall { room: room.clone() }, |_| RoomInput::Done)
    }
}

#[derive(Serialize, Default)]
struct ProfilesView {
    names: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ProfilesAction {
    Follow { user: String },
    Unfollow { user: String },
}

enum ProfilesInput {
    Action(ProfilesAction),
    Loaded(String, Result<ProfileData, RpcError>),
}

impl From<ProfilesAction> for ProfilesInput {
    fn from(action: ProfilesAction) -> Self {
        Self::Action(action)
    }
}

struct ProfilesState {
    view: Doc<ProfilesView>,
    followed: Followed<String, ()>,
}

struct Profiles;

impl Slice for Profiles {
    const NAME: &'static str = "profiles";
    const LIFETIME: Lifetime = Lifetime::Singleton;

    type Key = ();
    type State = ProfilesState;
    type View = Doc<ProfilesView>;
    type Action = ProfilesAction;
    type Input = ProfilesInput;

    fn init((): &(), _: Option<Value>) -> (Self::State, Cmd<ProfilesInput>) {
        (
            ProfilesState {
                view: Doc::new(ProfilesView::default()),
                followed: Followed::default(),
            },
            Cmd::none(),
        )
    }

    fn view(state: &mut Self::State) -> &mut Self::View {
        &mut state.view
    }

    fn reduce(
        (): &(),
        state: &mut Self::State,
        input: ProfilesInput,
        _: &Cx,
    ) -> Cmd<ProfilesInput> {
        match input {
            ProfilesInput::Action(ProfilesAction::Follow { user }) => {
                if state.followed.follow(user.clone(), || ()) {
                    Cmd::rpc(LoadProfile { user: user.clone() }, move |result| {
                        ProfilesInput::Loaded(user, result)
                    })
                } else {
                    Cmd::none()
                }
            }
            ProfilesInput::Action(ProfilesAction::Unfollow { user }) => {
                if state.followed.unfollow(&user).is_some() {
                    state.view.edit("/names", |view| {
                        view.names.remove(&user);
                    });
                }
                Cmd::none()
            }
            ProfilesInput::Loaded(user, Ok(profile)) => {
                if state.followed.get(&user).is_some() {
                    state.view.edit("/names", |view| {
                        view.names.insert(user, profile.name);
                    });
                }
                Cmd::none()
            }
            ProfilesInput::Loaded(user, Err(error)) => {
                Cmd::notice("profile_failed", format!("{user}: {error:?}"))
            }
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct DraftsView {
    text: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum DraftsAction {
    Type { text: String },
}

struct Drafts;

impl Slice for Drafts {
    const NAME: &'static str = "drafts";
    const LIFETIME: Lifetime = Lifetime::Singleton;
    const PERSIST: bool = true;

    type Key = ();
    type State = Doc<DraftsView>;
    type View = Doc<DraftsView>;
    type Action = DraftsAction;
    type Input = DraftsAction;

    fn init((): &(), cached: Option<Value>) -> (Self::State, Cmd<DraftsAction>) {
        (
            cached
                .and_then(Doc::from_cached)
                .unwrap_or_else(|| Doc::new(DraftsView::default())),
            Cmd::none(),
        )
    }

    fn view(state: &mut Self::State) -> &mut Self::View {
        state
    }

    fn reduce(
        (): &(),
        state: &mut Self::State,
        DraftsAction::Type { text }: DraftsAction,
        _: &Cx,
    ) -> Cmd<DraftsAction> {
        state.edit("/text", |view| view.text = text);
        Cmd::none()
    }
}

static DEAF_OFFERS: AtomicUsize = AtomicUsize::new(0);

struct Deaf;

impl Slice for Deaf {
    const NAME: &'static str = "deaf";
    const LIFETIME: Lifetime = Lifetime::Singleton;

    type Key = ();
    type State = Doc<CounterView>;
    type View = Doc<CounterView>;
    type Action = DraftsAction;
    type Input = DraftsAction;

    fn init((): &(), _: Option<Value>) -> (Self::State, Cmd<DraftsAction>) {
        (Doc::new(CounterView::default()), Cmd::none())
    }

    fn core_input(_: &CoreEvent) -> Option<DraftsAction> {
        DEAF_OFFERS.fetch_add(1, Ordering::SeqCst);
        None
    }

    fn view(state: &mut Self::State) -> &mut Self::View {
        state
    }

    fn reduce((): &(), _: &mut Self::State, _: DraftsAction, _: &Cx) -> Cmd<DraftsAction> {
        Cmd::none()
    }
}

fn registry() -> Registry {
    let mut registry = Registry::new();
    registry
        .add::<Counter>()
        .and_then(|registry| registry.add::<Room>())
        .and_then(|registry| registry.add::<Profiles>())
        .and_then(|registry| registry.add::<Drafts>())
        .and_then(|registry| registry.add::<Deaf>())
        .expect("the demo slices have distinct names");
    registry
}

fn harness() -> TestApp {
    let harness = TestApp::new(registry());
    harness.backend.expect::<OpenCall>().returns(());
    harness.backend.expect::<CloseCall>().returns(());
    harness
}

fn counter() -> Target {
    Target {
        slice: "counter".to_owned(),
        key: Value::Null,
    }
}

fn room(name: &str) -> Target {
    Target {
        slice: "room".to_owned(),
        key: json!(name),
    }
}

async fn dispatch(harness: &TestApp, target: &Target, action: Value) {
    harness
        .app
        .dispatch(target, action)
        .await
        .expect("the action is valid");
}

fn patches(events: &[AppEvent]) -> Vec<&AppEvent> {
    events
        .iter()
        .filter(|event| matches!(event, AppEvent::Patch { .. }))
        .collect()
}

#[tokio::test(flavor = "current_thread")]
async fn a_batch_of_edits_is_one_patch_with_one_op_per_path() {
    let harness = harness();
    let mut replica = harness.subscribe("counter", Value::Null, None).await;
    assert_eq!(replica.state, json!({"count": 0, "ticks": 0, "idle": 0}));

    for n in [1, 2, 3] {
        dispatch(&harness, &counter(), json!({"type": "add", "n": n})).await;
    }
    let events = harness.events().await;
    assert_eq!(
        events,
        [AppEvent::Patch {
            sub: replica.sub,
            rev: 1,
            epoch: 0,
            ops: vec![Op::Replace {
                path: "/count".to_owned(),
                value: json!(6)
            }]
        }]
    );
    for event in &events {
        replica.apply(event).unwrap();
    }
    assert_eq!(replica.state["count"], 6);
}

#[tokio::test(flavor = "current_thread")]
async fn a_reply_follows_the_patches_it_caused() {
    let harness = harness();
    harness.backend.expect::<DoubleCall>().answers(|call| {
        Ok(Doubled {
            value: call.value * 2,
        })
    });
    let replica = harness.subscribe("counter", Value::Null, None).await;
    dispatch(&harness, &counter(), json!({"type": "add", "n": 4})).await;
    harness.settle().await;
    harness.events().await;

    let req = harness
        .app
        .request(&counter(), json!({"type": "double"}))
        .await
        .unwrap();
    let events = harness.events().await;
    assert!(matches!(
        events.as_slice(),
        [
            AppEvent::Patch { sub, rev: 2, .. },
            AppEvent::Reply { req: replied, epoch: 0, outcome: Outcome::Ok { value } }
        ] if *sub == replica.sub && *replied == req && *value == json!(8)
    ));
    assert_eq!(harness.backend.calls::<DoubleCall>().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn a_refused_request_replies_with_the_core_error() {
    let harness = harness();
    harness
        .backend
        .expect::<DoubleCall>()
        .fails(|| RpcError::Denied);
    let req = harness
        .app
        .request(&counter(), json!({"type": "double"}))
        .await
        .unwrap();
    assert_eq!(
        harness.events().await,
        [AppEvent::Reply {
            req,
            epoch: 0,
            outcome: Outcome::Error {
                error: ReplyError::Rpc {
                    error: json!({"code": "denied"})
                }
            }
        }]
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_request_that_nobody_answers_is_lost_after_its_ttl() {
    let harness = harness();
    let gate = Gate::default();
    harness
        .backend
        .expect::<DoubleCall>()
        .after(&gate)
        .returns(Doubled { value: 0 });
    let req = harness
        .app
        .request(&counter(), json!({"type": "double"}))
        .await
        .unwrap();
    harness.advance(Duration::from_secs(29)).await;
    assert_eq!(harness.events().await, []);

    harness.advance(Duration::from_secs(1)).await;
    assert_eq!(harness.events().await, [lost(req, 0, LostReason::Expired)]);
    gate.open();
    assert!(
        harness.events().await.is_empty(),
        "a lost request is not answered later"
    );
}

fn lost(req: ReqId, epoch: u64, reason: LostReason) -> AppEvent {
    AppEvent::Reply {
        req,
        epoch,
        outcome: Outcome::Error {
            error: ReplyError::Lost { reason },
        },
    }
}

#[tokio::test(flavor = "current_thread")]
async fn changing_account_loses_requests_disposes_instances_and_asks_for_resyncs() {
    let harness = harness();
    let gate = Gate::default();
    harness
        .backend
        .expect::<DoubleCall>()
        .after(&gate)
        .returns(Doubled { value: 2 });
    let mut counter_replica = harness.subscribe("counter", Value::Null, None).await;
    let room_replica = harness.subscribe("room", json!("a"), None).await;
    dispatch(&harness, &counter(), json!({"type": "add", "n": 1})).await;
    let first = harness.batches().await;
    let req = harness
        .app
        .request(&counter(), json!({"type": "double"}))
        .await
        .unwrap();
    harness.settle().await;

    harness.app.switch_account().await;
    harness.settle().await;
    assert_eq!(harness.app.epoch(), 1);
    assert_eq!(
        harness.backend.calls::<CloseCall>().len(),
        1,
        "the room was disposed"
    );

    let batches = harness.batches().await;
    assert!(batches[0].tick > first[0].tick, "ticks only grow");
    let events: Vec<AppEvent> = batches.into_iter().flat_map(|batch| batch.events).collect();
    assert!(events.contains(&lost(req, 1, LostReason::EpochChanged)));
    for sub in [counter_replica.sub, room_replica.sub] {
        assert!(events.contains(&AppEvent::Resync { sub, epoch: 1 }));
    }
    assert_eq!(events.len(), 3);

    gate.open();
    assert!(
        harness.events().await.is_empty(),
        "the old account's answer never arrives"
    );

    let fresh = harness.app.resync(counter_replica.sub).await.unwrap();
    assert_eq!((fresh.epoch, fresh.rev), (1, 0));
    assert_eq!(fresh.state["count"], 0, "the new account starts from init");
    counter_replica.reset(&fresh);
    dispatch(&harness, &counter(), json!({"type": "add", "n": 5})).await;
    for event in harness.events().await {
        counter_replica.apply(&event).unwrap();
    }
    assert_eq!(counter_replica.state["count"], 5);
    assert_eq!(counter_replica.epoch, 1);
}

#[tokio::test(flavor = "current_thread")]
async fn ticks_number_the_batches_a_shell_is_handed() {
    let harness = harness();
    harness.subscribe("counter", Value::Null, None).await;
    let mut ticks = Vec::new();
    for n in 1..=3 {
        dispatch(&harness, &counter(), json!({"type": "add", "n": n})).await;
        ticks.extend(harness.batches().await.iter().map(|batch| batch.tick));
    }
    assert_eq!(ticks, [1, 2, 3]);
}

#[tokio::test(flavor = "current_thread")]
async fn keyed_instances_live_while_used_and_a_grace_after() {
    let harness = harness();
    let opened = |name: &str| {
        harness
            .backend
            .calls::<OpenCall>()
            .iter()
            .filter(|call| call.room == name)
            .count()
    };
    let first = harness.subscribe("room", json!("a"), None).await;
    let second = harness.subscribe("room", json!("a"), None).await;
    harness.subscribe("room", json!("b"), None).await;
    assert_eq!((opened("a"), opened("b")), (1, 1), "a key is opened once");

    dispatch(&harness, &room("a"), json!({"type": "push", "value": 1})).await;
    let events = harness.events().await;
    assert_eq!(patches(&events).len(), 2, "both subscribers of a see it");

    harness.app.unsubscribe(first.sub).await;
    harness.advance(Duration::from_secs(6)).await;
    assert_eq!(harness.backend.calls::<CloseCall>().len(), 0);

    harness.app.unsubscribe(second.sub).await;
    harness.advance(Duration::from_secs(4)).await;
    let back = harness.subscribe("room", json!("a"), None).await;
    assert_eq!(
        back.state["total"], 1,
        "within the grace the instance is warm"
    );
    assert_eq!(opened("a"), 1);

    harness.app.unsubscribe(back.sub).await;
    harness.advance(Duration::from_secs(5)).await;
    let closed: Vec<String> = harness
        .backend
        .calls::<CloseCall>()
        .into_iter()
        .map(|call| call.room)
        .collect();
    assert_eq!(closed, ["a"]);

    let cold = harness.subscribe("room", json!("a"), None).await;
    assert_eq!(cold.state["total"], 0, "a disposed instance starts over");
    assert_eq!(opened("a"), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn an_instance_with_a_request_in_flight_outlives_its_grace() {
    let harness = harness();
    let req = harness
        .app
        .request(&room("a"), json!({"type": "push", "value": 1}))
        .await
        .unwrap();
    harness.advance(Duration::from_secs(10)).await;
    assert_eq!(harness.backend.calls::<CloseCall>().len(), 0);

    harness.advance(Duration::from_secs(20)).await;
    assert_eq!(harness.events().await, [lost(req, 0, LostReason::Expired)]);
    harness.advance(Duration::from_secs(5)).await;
    assert_eq!(harness.backend.calls::<CloseCall>().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn followed_values_live_until_the_last_follower_leaves() {
    let harness = harness();
    harness.backend.expect::<LoadProfile>().answers(|call| {
        Ok(ProfileData {
            name: call.user.to_uppercase(),
        })
    });
    let mut replica = harness.subscribe("profiles", Value::Null, None).await;
    let target = Target {
        slice: "profiles".to_owned(),
        key: Value::Null,
    };
    let act = |action: Value| dispatch(&harness, &target, action);

    act(json!({"type": "follow", "user": "ann"})).await;
    act(json!({"type": "follow", "user": "ann"})).await;
    for event in harness.events().await {
        replica.apply(&event).unwrap();
    }
    assert_eq!(replica.state, json!({"names": {"ann": "ANN"}}));
    assert_eq!(harness.backend.calls::<LoadProfile>().len(), 1);

    act(json!({"type": "unfollow", "user": "ann"})).await;
    assert!(harness.events().await.is_empty(), "one follower is left");
    act(json!({"type": "unfollow", "user": "ann"})).await;
    for event in harness.events().await {
        replica.apply(&event).unwrap();
    }
    assert_eq!(replica.state, json!({"names": {}}));
}

#[tokio::test(flavor = "current_thread")]
async fn a_debounced_timer_restarts_and_a_cancelled_one_never_fires() {
    let harness = harness();
    let replica = harness.subscribe("counter", Value::Null, None).await;
    let idle = || async { harness.app.resync(replica.sub).await.unwrap().state["idle"].clone() };

    dispatch(&harness, &counter(), json!({"type": "debounce"})).await;
    harness.advance(Duration::from_secs(2)).await;
    dispatch(&harness, &counter(), json!({"type": "debounce"})).await;
    harness.advance(Duration::from_secs(2)).await;
    assert_eq!(idle().await, 0, "the second call restarted the timer");
    harness.advance(Duration::from_secs(1)).await;
    assert_eq!(idle().await, 1);

    dispatch(&harness, &counter(), json!({"type": "debounce"})).await;
    harness.settle().await;
    harness.clock.advance(Duration::from_secs(3));
    dispatch(&harness, &counter(), json!({"type": "cancel"})).await;
    harness.settle().await;
    assert_eq!(idle().await, 1, "a cancel beats a timer already on its way");

    dispatch(&harness, &counter(), json!({"type": "debounce"})).await;
    harness.settle().await;
    harness.clock.advance(Duration::from_secs(3));
    dispatch(&harness, &counter(), json!({"type": "debounce"})).await;
    harness.settle().await;
    assert_eq!(
        idle().await,
        1,
        "a restart beats a timer already on its way"
    );
    harness.advance(Duration::from_secs(3)).await;
    assert_eq!(idle().await, 2);
}

#[tokio::test(flavor = "current_thread")]
async fn after_keeps_the_earlier_timer_and_commands_run_in_order() {
    let harness = harness();
    let replica = harness.subscribe("counter", Value::Null, None).await;
    dispatch(&harness, &counter(), json!({"type": "chain"})).await;
    harness.advance(Duration::from_secs(1)).await;
    let state = harness.app.resync(replica.sub).await.unwrap().state;
    assert_eq!(state["idle"], 1, "the one-second timer won");
    harness.advance(Duration::from_secs(9)).await;
    let state = harness.app.resync(replica.sub).await.unwrap().state;
    assert_eq!(state["idle"], 1, "the nine-second timer was never armed");
}

#[tokio::test(flavor = "current_thread")]
async fn a_stream_belongs_to_its_instance() {
    let harness = harness();
    let mut replica = harness.subscribe("counter", Value::Null, None).await;
    dispatch(&harness, &counter(), json!({"type": "stream"})).await;
    for _ in 0..3 {
        harness.advance(Duration::from_secs(1)).await;
    }
    for event in harness.events().await {
        replica.apply(&event).unwrap();
    }
    assert_eq!(replica.state["ticks"], 3);

    dispatch(&harness, &counter(), json!({"type": "end_stream"})).await;
    harness.advance(Duration::from_secs(5)).await;
    assert!(
        harness.events().await.is_empty(),
        "an ended stream is silent"
    );

    dispatch(&harness, &counter(), json!({"type": "stream"})).await;
    harness.advance(Duration::from_secs(1)).await;
    assert_eq!(
        harness.app.resync(replica.sub).await.unwrap().state["ticks"],
        1,
        "a new stream starts over"
    );
    harness.app.switch_account().await;
    harness.advance(Duration::from_secs(5)).await;
    let fresh = harness.app.resync(replica.sub).await.unwrap();
    assert_eq!(fresh.state["ticks"], 0, "the stream died with its instance");
}

#[tokio::test(flavor = "current_thread")]
async fn a_subscriber_that_falls_behind_is_told_to_resync_once() {
    let harness = harness();
    let mut replica = harness.subscribe("room", json!("a"), None).await;
    dispatch(
        &harness,
        &room("a"),
        json!({"type": "append", "count": 2000}),
    )
    .await;
    dispatch(&harness, &room("a"), json!({"type": "push", "value": 1})).await;
    let events = harness.events().await;
    assert_eq!(
        events,
        [AppEvent::Resync {
            sub: replica.sub,
            epoch: 0
        }]
    );
    for event in &events {
        replica.apply(event).unwrap();
    }
    assert!(replica.lagging);

    let snapshot = harness.app.resync(replica.sub).await.unwrap();
    assert_eq!(snapshot.state["total"], 2001);
    replica.reset(&snapshot);
    dispatch(&harness, &room("a"), json!({"type": "push", "value": 2})).await;
    for event in harness.events().await {
        replica.apply(&event).unwrap();
    }
    assert_eq!(replica.state["total"], 2002);
}

#[tokio::test(flavor = "current_thread")]
async fn a_rejected_edit_is_a_notice_not_a_crash() {
    let harness = harness();
    harness.subscribe("room", json!("a"), None).await;
    dispatch(&harness, &room("a"), json!({"type": "remove", "index": 3})).await;
    let events = harness.events().await;
    assert!(matches!(
        events.as_slice(),
        [AppEvent::Notice { slice, stage, .. }] if slice == "room" && stage == "rejected"
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn a_panicking_instance_is_replaced_when_its_subscribers_resync() {
    let harness = harness();
    let gate = Gate::default();
    harness
        .backend
        .expect::<DoubleCall>()
        .after(&gate)
        .returns(Doubled { value: 0 });
    let mut replica = harness.subscribe("counter", Value::Null, None).await;
    dispatch(&harness, &counter(), json!({"type": "add", "n": 5})).await;
    harness.events().await;
    let req = harness
        .app
        .request(&counter(), json!({"type": "double"}))
        .await
        .unwrap();
    harness.settle().await;

    dispatch(&harness, &counter(), json!({"type": "panic"})).await;
    let events = harness.events().await;
    assert!(events.contains(&AppEvent::Resync {
        sub: replica.sub,
        epoch: 0
    }));
    assert!(events.contains(&lost(req, 0, LostReason::InstanceFailed)));

    let fresh = harness.app.resync(replica.sub).await.unwrap();
    assert_eq!((fresh.rev, &fresh.state["count"]), (0, &json!(0)));
    replica.reset(&fresh);
    dispatch(&harness, &counter(), json!({"type": "add", "n": 1})).await;
    for event in harness.events().await {
        replica.apply(&event).unwrap();
    }
    assert_eq!(replica.state["count"], 1);
}

#[tokio::test(flavor = "current_thread")]
async fn an_instance_that_keeps_panicking_stays_down() {
    let harness = harness();
    let replica = harness.subscribe("counter", Value::Null, None).await;
    for _ in 0..3 {
        dispatch(&harness, &counter(), json!({"type": "panic"})).await;
        harness.settle().await;
        let _ = harness.app.resync(replica.sub).await;
    }
    assert_eq!(
        harness.app.resync(replica.sub).await.unwrap_err(),
        AppError::Stopped
    );
    harness.app.switch_account().await;
    harness.app.resync(replica.sub).await.unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn a_persisted_view_is_restored_at_cold_start_and_saved_after_changes() {
    let harness = harness();
    harness
        .platform
        .store("snapshot/drafts/null", r#"{"text":"saved"}"#);
    let replica = harness.subscribe("drafts", Value::Null, None).await;
    assert_eq!(replica.state, json!({"text": "saved"}));
    let target = Target {
        slice: "drafts".to_owned(),
        key: Value::Null,
    };

    dispatch(&harness, &target, json!({"type": "type", "text": "new"})).await;
    harness.advance(Duration::from_secs(1)).await;
    assert_eq!(
        harness.platform.stored("snapshot/drafts/null").as_deref(),
        Some(r#"{"text":"saved"}"#),
        "writes wait for the changes to settle"
    );
    harness.advance(Duration::from_secs(1)).await;
    assert_eq!(
        harness.platform.stored("snapshot/drafts/null").as_deref(),
        Some(r#"{"text":"new"}"#)
    );

    dispatch(&harness, &target, json!({"type": "type", "text": "newer"})).await;
    harness.settle().await;
    harness.app.switch_account().await;
    assert_eq!(
        harness.platform.stored("snapshot/drafts/null").as_deref(),
        Some(r#"{"text":"newer"}"#),
        "disposing saves at once"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_view_that_no_longer_fits_is_not_restored() {
    let harness = harness();
    harness
        .platform
        .store("snapshot/drafts/null", r#"{"text":3}"#);
    let replica = harness.subscribe("drafts", Value::Null, None).await;
    assert_eq!(replica.state, json!({"text": ""}));
}

#[tokio::test(flavor = "current_thread")]
async fn core_events_reach_only_the_instances_that_want_them() {
    let harness = harness();
    let mut replica = harness.subscribe("counter", Value::Null, None).await;
    harness.subscribe("deaf", Value::Null, None).await;
    let (counter_before, deaf_before) = (
        COUNTER_OFFERS.load(Ordering::SeqCst),
        DEAF_OFFERS.load(Ordering::SeqCst),
    );

    harness.app.offer(&CoreEvent::InboxChanged).await;
    harness.app.offer(&CoreEvent::SessionTokensRefreshed).await;
    for event in harness.events().await {
        replica.apply(&event).unwrap();
    }
    assert_eq!(replica.state["ticks"], 1000);
    assert_eq!(COUNTER_OFFERS.load(Ordering::SeqCst), counter_before + 1);
    assert_eq!(DEAF_OFFERS.load(Ordering::SeqCst), deaf_before);
}

#[tokio::test(flavor = "current_thread")]
async fn commands_reach_the_platform_and_notices_reach_the_shell() {
    let harness = harness();
    harness.subscribe("counter", Value::Null, None).await;
    dispatch(
        &harness,
        &counter(),
        json!({"type": "open", "url": "https://example.org"}),
    )
    .await;
    harness.settle().await;
    assert_eq!(harness.platform.opened(), ["https://example.org"]);

    dispatch(&harness, &counter(), json!({"type": "notify"})).await;
    let events = harness.events().await;
    assert!(matches!(
        events.as_slice(),
        [
            AppEvent::Patch { .. },
            AppEvent::Notice { stage, text, .. }
        ] if stage == "saved" && text == "Saved"
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn bad_calls_are_errors_and_never_panics() {
    let harness = harness();
    let subscribe = |slice: &str, key: Value| {
        harness.app.subscribe(SubscribeRequest {
            target: Target {
                slice: slice.to_owned(),
                key,
            },
            window: None,
        })
    };
    assert_eq!(
        subscribe("nope", Value::Null).await.unwrap_err(),
        AppError::UnknownSlice("nope".to_owned())
    );
    assert_eq!(
        subscribe("room", json!(5)).await.unwrap_err(),
        AppError::Invalid
    );
    assert_eq!(
        harness
            .app
            .dispatch(&counter(), json!({"type": "teleport"}))
            .await
            .unwrap_err(),
        AppError::Invalid
    );
    assert_eq!(
        harness
            .app
            .request(&counter(), json!([1]))
            .await
            .unwrap_err(),
        AppError::Invalid
    );
    assert_eq!(
        harness
            .app
            .resync(sable_runtime::SubId(99))
            .await
            .unwrap_err(),
        AppError::UnknownSub
    );
    assert_eq!(harness.backend.unexpected(), Vec::<String>::new());
}

#[tokio::test(flavor = "current_thread")]
async fn a_window_follows_part_of_a_list() {
    let harness = harness();
    let mut replica = harness
        .subscribe("room", json!("a"), Some(Window { start: 2, end: 4 }))
        .await;
    dispatch(&harness, &room("a"), json!({"type": "append", "count": 10})).await;
    for event in harness.events().await {
        replica.apply(&event).unwrap();
    }
    assert_eq!(replica.state, json!({"total": 10, "items": [2, 3]}));
    let moved = harness
        .app
        .range(replica.sub, Window { start: 7, end: 20 })
        .await
        .unwrap();
    assert_eq!(moved.state, json!({"total": 10, "items": [7, 8, 9]}));
}

#[tokio::test(flavor = "current_thread")]
async fn two_slices_with_one_name_are_refused() {
    let mut registry = Registry::new();
    registry.add::<Room>().unwrap();
    assert_eq!(
        registry.add::<Room>().err().unwrap().to_string(),
        "two slices are named `room`"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn the_system_clock_sleeps() {
    SystemClock.sleep(Duration::from_millis(1)).await;
}

#[derive(Clone, Default)]
struct SpanLog(Arc<Mutex<Vec<String>>>);

struct Fields(String);

impl tracing::field::Visit for Fields {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn Debug) {
        use fmt::Write;
        let _ = write!(self.0, " {}={value:?}", field.name());
    }
}

impl<S: tracing::Subscriber> Layer<S> for SpanLog {
    fn on_new_span(
        &self,
        attributes: &tracing::span::Attributes<'_>,
        _: &tracing::span::Id,
        _: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let mut fields = Fields(attributes.metadata().name().to_owned());
        attributes.record(&mut fields);
        self.0.lock().unwrap().push(fields.0);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn every_reduce_and_request_has_a_span() {
    let log = SpanLog::default();
    let _guard = tracing::subscriber::set_default(tracing_subscriber::registry().with(log.clone()));
    let harness = harness();
    harness
        .backend
        .expect::<DoubleCall>()
        .returns(Doubled { value: 0 });
    let req = harness
        .app
        .request(&counter(), json!({"type": "double"}))
        .await
        .unwrap();
    harness.settle().await;

    let spans = log.0.lock().unwrap().clone();
    assert!(
        spans.contains(&format!("request slice=\"counter\" req={req}")),
        "{spans:?}"
    );
    assert!(
        spans
            .iter()
            .any(|span| span.starts_with("reduce slice=\"counter\" req=Some(ReqId(")),
        "{spans:?}"
    );
}

fn step() -> impl Strategy<Value = Value> {
    (0u8..6, 0usize..40, 0u32..100, 0u32..8).prop_map(|(kind, index, value, count)| match kind {
        0 => json!({"type": "push", "value": value}),
        1 => json!({"type": "append", "count": count}),
        2 => json!({"type": "insert", "index": index, "value": value}),
        3 => json!({"type": "remove", "index": index}),
        4 => json!({"type": "pop_front"}),
        _ => json!({"type": "clear"}),
    })
}

proptest! {
    #[test]
    fn patches_converge_to_a_fresh_snapshot(
        start in 0usize..30,
        width in 1usize..12,
        windowed in any::<bool>(),
        steps in proptest::collection::vec(proptest::collection::vec(step(), 1..6), 1..8),
    ) {
        let window = windowed.then_some(Window { start, end: start + width });
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(assert_patches_converge::<Room>(
                |backend| {
                    backend.expect::<OpenCall>().returns(());
                    backend.expect::<CloseCall>().returns(());
                },
                json!("a"),
                window,
                &steps,
            ));
    }
}

#[test]
fn a_replica_refuses_a_gap_in_revisions() {
    let subscribed = sable_runtime::Subscribed {
        sub: sable_runtime::SubId(1),
        snapshot: sable_runtime::Snapshot {
            rev: 0,
            epoch: 0,
            state: json!({}),
        },
    };
    let mut replica = Replica::new(&subscribed);
    let skipped = AppEvent::Patch {
        sub: subscribed.sub,
        rev: 2,
        epoch: 0,
        ops: Vec::new(),
    };
    assert_eq!(
        replica.apply(&skipped).unwrap_err().to_string(),
        "patch 2 follows 0, so one went missing"
    );
}
