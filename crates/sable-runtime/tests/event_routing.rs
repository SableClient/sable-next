//! Keyed core event routing.

#![cfg(test)]

use sable_protocol::{CoreEvent, CoreEventKind};
use sable_runtime::{
    Cmd, Cx, Doc, Interest, Lifetime, Registry, Slice, Target,
    testing::{Replica, TestApp},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Default, Serialize, Deserialize)]
struct Heard {
    events: u32,
    listening: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ListenerAction {
    Mute,
}

enum ListenerInput {
    Action(ListenerAction),
    Heard,
}

impl From<ListenerAction> for ListenerInput {
    fn from(action: ListenerAction) -> Self {
        Self::Action(action)
    }
}

/// Keyed by the account data type it follows.
struct Listener;

impl Slice for Listener {
    const NAME: &'static str = "listener";
    const LIFETIME: Lifetime = Lifetime::Singleton;
    const INTEREST: Interest = Interest::of(&[
        CoreEventKind::AccountDataChanged,
        CoreEventKind::SessionTokensRefreshed,
    ]);

    type Key = String;
    type State = Doc<Heard>;
    type View = Doc<Heard>;
    type Action = ListenerAction;
    type Input = ListenerInput;

    fn init(_: &String, _: Option<Value>) -> (Self::State, Cmd<ListenerInput>) {
        let heard = Heard {
            events: 0,
            listening: true,
        };
        (Doc::new(heard), Cmd::none())
    }

    fn event_key(event: &CoreEvent) -> Option<String> {
        match event {
            CoreEvent::AccountDataChanged { event_type } => Some(event_type.clone()),
            _ => None,
        }
    }

    fn core_input(state: &Self::State, _: &CoreEvent) -> Option<ListenerInput> {
        state.view().listening.then_some(ListenerInput::Heard)
    }

    fn view(state: &mut Self::State) -> &mut Self::View {
        state
    }

    fn reduce(
        _: &String,
        state: &mut Self::State,
        input: ListenerInput,
        _: &Cx,
    ) -> Cmd<ListenerInput> {
        match input {
            ListenerInput::Heard => state.edit_fields(|view| view.events += 1),
            ListenerInput::Action(ListenerAction::Mute) => {
                state.edit_fields(|view| view.listening = false);
            }
        }
        Cmd::none()
    }
}

fn harness() -> TestApp {
    let mut registry = Registry::new();
    registry
        .add::<Listener>()
        .expect("the slices have distinct names");
    TestApp::new(registry)
}

fn target(slice: &str, key: Value) -> Target {
    Target {
        slice: slice.to_owned(),
        key,
    }
}

async fn send(harness: &TestApp, target: &Target, action: Value) {
    harness
        .app
        .dispatch(target, action)
        .await
        .expect("the action is valid");
    harness.settle().await;
}

async fn feed(harness: &TestApp, replicas: &mut [&mut Replica]) {
    for event in harness.events().await {
        for replica in replicas.iter_mut() {
            replica.apply(&event).expect("the patch applies");
        }
    }
}

fn account_data(event_type: &str) -> CoreEvent {
    CoreEvent::AccountDataChanged {
        event_type: event_type.to_owned(),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn an_event_that_names_an_instance_reaches_only_that_one() {
    let harness = harness();
    let mut first = harness.subscribe("listener", json!("m.first"), None).await;
    let mut second = harness.subscribe("listener", json!("m.second"), None).await;

    harness.app.offer(&account_data("m.first")).await;
    feed(&harness, &mut [&mut first, &mut second]).await;

    assert_eq!(first.state["events"], 1);
    assert_eq!(second.state["events"], 0);
}

#[tokio::test(flavor = "current_thread")]
async fn an_event_that_names_no_instance_reaches_them_all() {
    let harness = harness();
    let mut first = harness.subscribe("listener", json!("m.first"), None).await;
    let mut second = harness.subscribe("listener", json!("m.second"), None).await;

    harness.app.offer(&CoreEvent::SessionTokensRefreshed).await;
    feed(&harness, &mut [&mut first, &mut second]).await;

    assert_eq!(first.state["events"], 1);
    assert_eq!(second.state["events"], 1);
}

#[tokio::test(flavor = "current_thread")]
async fn an_instance_turns_an_event_down_by_its_state() {
    let harness = harness();
    let mut muted = harness.subscribe("listener", json!("m.first"), None).await;
    let mut open = harness.subscribe("listener", json!("m.second"), None).await;
    send(
        &harness,
        &target("listener", json!("m.first")),
        json!({"type": "mute"}),
    )
    .await;

    harness.app.offer(&CoreEvent::SessionTokensRefreshed).await;
    feed(&harness, &mut [&mut muted, &mut open]).await;

    assert_eq!(muted.state["events"], 0);
    assert_eq!(open.state["events"], 1);
}
