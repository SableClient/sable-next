#![cfg(test)]

use std::sync::{Arc, Mutex};

use sable_ffi::{AccountGate, AppError, Ffi, Tabs};
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
    Notify,
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

    fn core_input(_: &Doc<View>, event: &CoreEvent) -> Option<Action> {
        matches!(event, CoreEvent::InboxChanged).then_some(Action::Add { n: 100 })
    }

    fn view(state: &mut Self::State) -> &mut Self::View {
        state
    }

    fn reduce((): &(), state: &mut Self::State, action: Action, cx: &Cx) -> Cmd<Action> {
        match action {
            Action::Add { n } => {
                state.edit_fields(|view| view.count += n);
                Cmd::none()
            }
            Action::Read => Cmd::reply(cx.req(), Ok::<_, RpcError>(state.view().count)),
            Action::Notify => Cmd::notice(&json!({"type": "saved"})),
        }
    }
}

fn ffi(runtime: &tokio::runtime::Runtime) -> (Ffi, TestApp) {
    let mut registry = Registry::new();
    registry.add::<Counter>().unwrap();
    let harness = TestApp::new(registry);
    (
        Ffi::new(harness.app.clone(), runtime.handle().clone()),
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

    let req = block(ffi.request(COUNTER, r#"{"type":"read"}"#)).unwrap();
    runtime.block_on(harness.settle());
    let batch: Batch = json(&block(ffi.next_batch()).unwrap());
    assert!(matches!(
        batch.events.as_slice(),
        [AppEvent::Reply { req: replied, outcome: Outcome::Ok { value }, .. }]
            if replied.0 == req && *value == json!(5)
    ));

    block(ffi.flush()).unwrap();
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
    assert_eq!(block(ffi.resync(sub)).unwrap_err(), AppError::UnknownSub);
    block(ffi.shutdown()).unwrap();
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
    ];
    assert!(failures.iter().all(|error| *error
        == AppError::TooLarge {
            limit: sable_runtime::MAX_INPUT_BYTES
        }));

    let failures = [
        block(ffi.subscribe(&deep)).unwrap_err(),
        block(ffi.dispatch(&deep, "{}")).unwrap_err(),
        block(ffi.dispatch(COUNTER, &"[".repeat(300))).unwrap_err(),
        block(ffi.request(COUNTER, &deep)).map(|_| ()).unwrap_err(),
        block(ffi.range(1, &deep)).unwrap_err(),
    ];
    assert!(failures.iter().all(|error| *error == AppError::Invalid));

    for error in [
        block(ffi.subscribe(secret)).unwrap_err(),
        block(ffi.dispatch(secret, r#"{"type":"secret-action"}"#)).unwrap_err(),
    ] {
        assert!(!error.to_string().contains("secret"), "{error}");
        assert!(!error.code().contains("secret"));
    }
    assert_eq!(
        block(ffi.dispatch(COUNTER, r#"{"type":"secret-action"}"#)).unwrap_err(),
        AppError::Invalid
    );
}

#[test]
fn errors_have_stable_codes() {
    let codes: Vec<&str> = [
        AppError::Invalid,
        AppError::TooLarge {
            limit: sable_runtime::MAX_INPUT_BYTES,
        },
        AppError::UnknownSlice,
        AppError::UnknownSub,
        AppError::Stopped,
        AppError::Encode,
    ]
    .map(|error| error.code())
    .into();
    assert_eq!(
        codes,
        [
            "invalid",
            "too_large",
            "unknown_slice",
            "unknown_sub",
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
    assert_eq!(result.unwrap_err(), AppError::Stopped);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_runtime_moves_to_the_new_account_before_the_call_that_changed_it_returns() {
    let mut registry = Registry::new();
    registry.add::<Counter>().unwrap();
    let harness = TestApp::new(registry);
    let ffi = Ffi::new(harness.app.clone(), tokio::runtime::Handle::current());
    let gate = AccountGate::default();
    gate.attach(ffi.clone());
    let epoch = || harness.app.epoch();
    let run = |method: &'static str, response: &'static str| {
        gate.run(
            method,
            async move { Ok::<_, ()>(response.to_owned()) },
            move || async move { Ok::<_, ()>(response.to_owned()) },
            String::as_str,
            || (),
        )
    };

    let serving = gate.serving().await;
    let changing = tokio::spawn({
        let gate = gate.clone();
        async move {
            gate.run(
                "session.switch_account",
                async { Ok::<_, ()>(r#"{"account_id":"b"}"#.to_owned()) },
                || async { Ok::<_, ()>("null".to_owned()) },
                String::as_str,
                || (),
            )
            .await
        }
    });
    tokio::task::yield_now().await;
    assert!(
        !changing.is_finished(),
        "the change waits for calls in flight"
    );
    drop(serving);

    changing.await.unwrap().unwrap();
    assert_eq!(epoch(), 1);

    run("rooms.list", "[]").await.unwrap();
    run("session.restore", r#"{"account_id":"b"}"#)
        .await
        .unwrap();
    assert_eq!(epoch(), 1, "the same account is not a change");
}

type Delivered = Arc<Mutex<Vec<(&'static str, Batch)>>>;

fn tabs() -> (
    TestApp,
    Tabs<&'static str>,
    Delivered,
    tokio::task::JoinHandle<()>,
) {
    let mut registry = Registry::new();
    registry.add::<Counter>().unwrap();
    let harness = TestApp::new(registry);
    let delivered = Delivered::default();
    let sink = delivered.clone();
    let tabs = Tabs::new(
        Ffi::new(harness.app.clone(), tokio::runtime::Handle::current()),
        move |window: &&'static str, batch| sink.lock().unwrap().push((window, batch)),
    );
    let pump = tokio::spawn({
        let tabs = tabs.clone();
        async move { tabs.pump().await }
    });
    (harness, tabs, delivered, pump)
}

const SUBSCRIBE: &str = r#"{"slice":"counter","key":null}"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_window_gets_only_its_own_subscriptions_and_replies() {
    let (harness, tabs, delivered, _pump) = tabs();
    tabs.open("one").await;
    tabs.open("two").await;
    let first: Subscribed = json(&tabs.subscribe(&"one", SUBSCRIBE).await.unwrap());
    let second: Subscribed = json(&tabs.subscribe(&"two", SUBSCRIBE).await.unwrap());

    tabs.dispatch(COUNTER, r#"{"type":"add","n":2}"#)
        .await
        .unwrap();
    harness.settle().await;
    let req = tabs
        .request(&"two", COUNTER, r#"{"type":"read"}"#)
        .await
        .unwrap();
    harness.settle().await;
    while !delivered
        .lock()
        .unwrap()
        .iter()
        .any(|(_, batch)| matches!(batch.events.as_slice(), [AppEvent::Reply { .. }]))
    {
        tokio::task::yield_now().await;
    }

    let delivered = delivered.lock().unwrap();
    let events_of = |window: &str| -> Vec<&AppEvent> {
        delivered
            .iter()
            .filter(|(to, _)| *to == window)
            .flat_map(|(_, batch)| &batch.events)
            .collect()
    };
    assert!(matches!(
        events_of("one").as_slice(),
        [AppEvent::Patch { sub, .. }] if *sub == first.sub
    ));
    assert!(matches!(
        events_of("two").as_slice(),
        [AppEvent::Patch { sub, .. }, AppEvent::Reply { req: replied, .. }]
            if *sub == second.sub && replied.0 == req
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_window_cannot_touch_another_windows_subscription_and_closing_lets_go() {
    let (harness, tabs, delivered, _pump) = tabs();
    tabs.open("one").await;
    tabs.open("two").await;
    let subscribed: Subscribed = json(&tabs.subscribe(&"one", SUBSCRIBE).await.unwrap());

    assert_eq!(
        tabs.resync(&"two", subscribed.sub.0).await,
        Err(AppError::UnknownSub)
    );
    assert_eq!(
        tabs.unsubscribe(&"two", subscribed.sub.0).await,
        Err(AppError::UnknownSub)
    );

    tabs.close(&"one").await;
    tabs.dispatch(COUNTER, r#"{"type":"add","n":1}"#)
        .await
        .unwrap();
    harness.settle().await;
    tokio::task::yield_now().await;

    assert!(delivered.lock().unwrap().is_empty());
    assert_eq!(
        tabs.resync(&"one", subscribed.sub.0).await,
        Err(AppError::UnknownSub)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_window_gets_a_notice() {
    let (harness, tabs, delivered, _pump) = tabs();
    tabs.open("one").await;
    tabs.open("two").await;
    tabs.subscribe(&"one", SUBSCRIBE).await.unwrap();

    tabs.dispatch(COUNTER, r#"{"type":"notify"}"#)
        .await
        .unwrap();
    harness.settle().await;
    while delivered.lock().unwrap().len() < 2 {
        tokio::task::yield_now().await;
    }

    let mut windows: Vec<_> = delivered
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, batch)| matches!(batch.events.as_slice(), [AppEvent::Notice { .. }]))
        .map(|(window, _)| *window)
        .collect();
    windows.sort_unstable();
    assert_eq!(windows, ["one", "two"]);
}

mod account_disposal {
    use super::*;
    use async_trait::async_trait;
    use sable_runtime::{App, Backend, Platform, PlatformError, Ports};
    use serde_json::value::RawValue;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Core {
        gate: AccountGate,
        changed: Arc<AtomicBool>,
        closed: Arc<AtomicBool>,
    }
    #[async_trait]
    impl Backend for Core {
        async fn call(&self, _: &str, _: &str) -> Result<Box<RawValue>, RpcError> {
            let _serving = self.gate.serving().await;
            assert!(!self.changed.load(Ordering::SeqCst));
            tokio::task::yield_now().await;
            self.closed.store(true, Ordering::SeqCst);
            Ok(RawValue::from_string("null".to_owned()).unwrap())
        }
    }
    struct Storage;
    #[async_trait]
    impl Platform for Storage {
        async fn storage_get(&self, _: &str) -> Result<Option<String>, PlatformError> {
            Ok(None)
        }
        async fn storage_set(&self, _: &str, _: &str) -> Result<(), PlatformError> {
            Ok(())
        }
    }
    struct Closing;
    impl Slice for Closing {
        const NAME: &'static str = "closing";
        const LIFETIME: Lifetime = Lifetime::Singleton;
        type Key = ();
        type State = Doc<()>;
        type View = Doc<()>;
        type Action = ();
        type Input = ();
        fn init((): &(), _: Option<Value>) -> (Doc<()>, Cmd<()>) {
            (Doc::new(()), Cmd::none())
        }
        fn view(state: &mut Doc<()>) -> &mut Doc<()> {
            state
        }
        fn reduce((): &(), _: &mut Doc<()>, (): (), _: &Cx) -> Cmd<()> {
            Cmd::none()
        }
        fn dispose((): &(), _: &mut Doc<()>) -> Cmd<()> {
            Cmd::task(|ports| async move {
                ports.backend.call("close", "{}").await.unwrap();
                None
            })
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn dispose_calls_finish_under_the_old_account_before_the_gate_changes_it() {
        let gate = AccountGate::default();
        let changed = Arc::new(AtomicBool::new(false));
        let closed = Arc::new(AtomicBool::new(false));
        let mut registry = Registry::new();
        registry.add::<Closing>().unwrap();
        let app = App::new(
            registry,
            Ports {
                backend: Arc::new(Core {
                    gate: gate.clone(),
                    changed: changed.clone(),
                    closed: closed.clone(),
                }),
                platform: Arc::new(Storage),
            },
            "a",
        );
        gate.attach(Ffi::new(app.clone(), tokio::runtime::Handle::current()));
        app.subscribe(sable_runtime::SubscribeRequest {
            target: sable_runtime::Target {
                slice: "closing".to_owned(),
                key: Value::Null,
            },
            window: None,
        })
        .await
        .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            gate.run(
                "session.switch_account",
                async {
                    assert!(closed.load(Ordering::SeqCst));
                    changed.store(true, Ordering::SeqCst);
                    Ok::<_, ()>(r#"{"account_id":"b"}"#)
                },
                || async { panic!("switch does not query the active session") },
                |json| json,
                || (),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        app.subscribe(sable_runtime::SubscribeRequest {
            target: sable_runtime::Target {
                slice: "closing".to_owned(),
                key: Value::Null,
            },
            window: None,
        })
        .await
        .unwrap();
        changed.store(false, Ordering::SeqCst);
        app.shutdown().await;
    }
}
