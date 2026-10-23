//! The surface a binding wraps, driven the way a binding drives it: strings of JSON in and out.

#![cfg(test)]

use sable_ffi::{Ffi, FfiError, Queries};
use sable_protocol::{CoreEvent, CoreEventKind, RpcError};
use sable_runtime::{
    AppEvent, Batch, Cmd, Cx, Doc, Handshake, Interest, Lifetime, Outcome, Registry, Slice,
    Snapshot, Subscribed, WIRE_SCHEMA, testing::TestApp,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Serialize, Deserialize, Default)]
struct View {
    count: i64,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Action {
    Add { n: i64 },
    Read,
}

struct Counter;

impl Slice for Counter {
    const NAME: &'static str = "counter";
    const LIFETIME: Lifetime = Lifetime::Singleton;
    const INTEREST: Interest = Interest::of(&[CoreEventKind::InboxChanged]);

    type Key = ();
    type State = Doc<View>;
    type View = Doc<View>;
    type Action = Action;
    type Input = Action;

    fn init((): &(), _: Option<Value>) -> (Self::State, Cmd<Action>) {
        (Doc::new(View::default()), Cmd::none())
    }

    fn core_input(event: &CoreEvent) -> Option<Action> {
        matches!(event, CoreEvent::InboxChanged).then_some(Action::Add { n: 100 })
    }

    fn view(state: &mut Self::State) -> &mut Self::View {
        state
    }

    fn reduce((): &(), state: &mut Self::State, action: Action, cx: &Cx) -> Cmd<Action> {
        match action {
            Action::Add { n } => {
                state.edit("/count", |view| view.count += n);
                Cmd::none()
            }
            Action::Read => Cmd::reply(cx.req(), Ok::<_, RpcError>(state.view().count)),
        }
    }
}

fn ffi(runtime: &tokio::runtime::Runtime) -> (Ffi, TestApp) {
    let mut registry = Registry::new();
    registry.add::<Counter>().unwrap();
    let harness = TestApp::new(registry);
    let queries = Queries::default().add("double", |n: i64| n * 2);
    (
        Ffi::new(harness.app.clone(), queries, runtime.handle().clone()),
        harness,
    )
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_time()
        .build()
        .unwrap()
}

fn block<F: std::future::Future>(future: F) -> F::Output {
    futures_executor::block_on(future)
}

const COUNTER: &str = r#"{"slice":"counter"}"#;

fn json<T: serde::de::DeserializeOwned>(text: &str) -> T {
    serde_json::from_str(text).unwrap()
}

#[test]
fn a_binding_on_its_own_thread_drives_the_whole_surface_without_a_runtime() {
    let runtime = runtime();
    let (ffi, harness) = ffi(&runtime);

    let handshake: Handshake = json(&ffi.handshake().unwrap());
    assert_eq!(handshake.schema, WIRE_SCHEMA);
    assert_eq!(handshake.slices, ["counter"]);

    let subscribed: Subscribed =
        json(&block(ffi.subscribe(r#"{"slice":"counter","key":null}"#)).unwrap());
    assert_eq!(subscribed.snapshot.state, json!({"count": 0}));
    let sub = subscribed.sub.0;

    block(ffi.dispatch(COUNTER, r#"{"type":"add","n":5}"#)).unwrap();
    runtime.block_on(harness.settle());
    let batch: Batch = json(&block(ffi.next_batch()).unwrap());
    assert!(matches!(
        batch.events.as_slice(),
        [AppEvent::Patch { rev: 1, .. }]
    ));
    assert_eq!(ffi.try_next_batch().unwrap(), None);

    let req = block(ffi.request(COUNTER, r#"{"type":"read"}"#)).unwrap();
    runtime.block_on(harness.settle());
    let batch: Batch = json(&block(ffi.next_batch()).unwrap());
    assert!(matches!(
        batch.events.as_slice(),
        [AppEvent::Reply { req: replied, outcome: Outcome::Ok { value }, .. }]
            if replied.0 == req && *value == json!(5)
    ));

    let snapshot: Snapshot = json(&block(ffi.resync(sub)).unwrap());
    assert_eq!((snapshot.rev, snapshot.state), (1, json!({"count": 5})));
    let ranged: Snapshot = json(&block(ffi.range(sub, "null")).unwrap());
    assert_eq!(ranged.state, json!({"count": 5}));

    runtime
        .block_on(ffi.offer(CoreEvent::InboxChanged))
        .unwrap();
    runtime.block_on(harness.settle());
    assert_eq!(
        json::<Snapshot>(&block(ffi.resync(sub)).unwrap()).state["count"],
        105
    );

    block(ffi.switch_account("account-b".to_owned())).unwrap();
    runtime.block_on(harness.settle());
    let batch: Batch = json(&block(ffi.next_batch()).unwrap());
    assert!(matches!(
        batch.events.as_slice(),
        [AppEvent::Resync { epoch: 1, .. }]
    ));

    block(ffi.unsubscribe(sub)).unwrap();
    assert_eq!(block(ffi.resync(sub)).unwrap_err(), FfiError::UnknownSub);
    block(ffi.shutdown()).unwrap();
}

#[test]
fn queries_run_by_name() {
    let runtime = runtime();
    let (ffi, _harness) = ffi(&runtime);
    assert_eq!(ffi.query("double", "21").unwrap(), "42");
    assert_eq!(
        ffi.query("double", r#""x""#).unwrap_err(),
        FfiError::Invalid
    );
    assert_eq!(ffi.query("nope", "1").unwrap_err(), FfiError::UnknownQuery);
}

#[test]
fn every_entry_point_applies_the_size_and_nesting_limits_and_echoes_nothing() {
    let runtime = runtime();
    let (ffi, _harness) = ffi(&runtime);
    let big = format!(r#"{{"slice":"{}"}}"#, "x".repeat(1 << 20));
    let deep = format!(
        r#"{{"slice":"counter","key":{}0{}}}"#,
        "[".repeat(300),
        "]".repeat(300)
    );
    let secret = r#"{"slice":"secret-slice-name","key":7}"#;

    let failures = [
        block(ffi.subscribe(&big)).unwrap_err(),
        block(ffi.dispatch(&big, "{}")).unwrap_err(),
        block(ffi.dispatch(COUNTER, &big)).unwrap_err(),
        block(ffi.request(&big, "{}")).map(|_| ()).unwrap_err(),
        block(ffi.range(1, &big)).unwrap_err(),
        ffi.query("double", &big).unwrap_err(),
    ];
    assert!(failures.iter().all(|error| *error == FfiError::TooLarge));

    let failures = [
        block(ffi.subscribe(&deep)).unwrap_err(),
        block(ffi.dispatch(&deep, "{}")).unwrap_err(),
        block(ffi.dispatch(COUNTER, &"[".repeat(300))).unwrap_err(),
        block(ffi.request(COUNTER, &deep)).map(|_| ()).unwrap_err(),
        block(ffi.range(1, &deep)).unwrap_err(),
        ffi.query("double", &deep).unwrap_err(),
    ];
    assert!(failures.iter().all(|error| *error == FfiError::Invalid));

    for error in [
        block(ffi.subscribe(secret)).unwrap_err(),
        block(ffi.dispatch(secret, r#"{"type":"secret-action"}"#)).unwrap_err(),
    ] {
        assert!(!error.to_string().contains("secret"), "{error}");
        assert!(!error.code().contains("secret"));
    }
    assert_eq!(
        block(ffi.dispatch(COUNTER, r#"{"type":"secret-action"}"#)).unwrap_err(),
        FfiError::Invalid
    );
}

#[test]
fn errors_have_stable_codes() {
    let codes: Vec<&str> = [
        FfiError::Invalid,
        FfiError::TooLarge,
        FfiError::UnknownSlice,
        FfiError::UnknownSub,
        FfiError::UnknownQuery,
        FfiError::Stopped,
        FfiError::Encode,
    ]
    .map(FfiError::code)
    .into();
    assert_eq!(
        codes,
        [
            "invalid",
            "too_large",
            "unknown_slice",
            "unknown_sub",
            "unknown_query",
            "stopped",
            "encode"
        ]
    );
}

#[test]
fn a_dropped_runtime_is_a_stopped_call_not_a_hang() {
    let runtime = runtime();
    let (ffi, _harness) = ffi(&runtime);
    drop(runtime);
    let result = block(ffi.dispatch(COUNTER, r#"{"type":"add","n":1}"#));
    assert_eq!(result.unwrap_err(), FfiError::Stopped);
}
