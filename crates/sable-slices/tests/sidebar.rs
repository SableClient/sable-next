//! The space sidebar slice through the app, with the core's layout faked.

#![cfg(test)]

use std::time::Duration;

use proptest::prelude::*;
use sable_protocol::{CoreEvent, RpcError, SidebarItemView};
use sable_runtime::{
    AppEvent, Registry, Target,
    testing::{Gate, Replica, Step, TestApp, assert_patches_converge},
};
use sable_slices::rpc::spaces::{SetSpaceSidebar, SpaceSidebar};
use sable_slices::sidebar::Sidebar;
use serde_json::{Value, json};

mod support;

use support::feed;

const PERSIST_KEY: &str = "snapshot/account-a/sidebar/null";

fn space(room_id: &str) -> SidebarItemView {
    SidebarItemView::Space {
        room_id: room_id.to_owned(),
    }
}

fn folder(id: &str, content: &[&str]) -> SidebarItemView {
    SidebarItemView::Folder {
        id: id.to_owned(),
        name: None,
        content: content.iter().map(|room| (*room).to_owned()).collect(),
    }
}

fn harness_with(layout: Vec<SidebarItemView>) -> TestApp {
    let mut registry = Registry::new();
    registry
        .add::<Sidebar>()
        .expect("sidebar is registered once");
    let harness = TestApp::new(registry);
    harness.backend.expect::<SpaceSidebar>().returns(layout);
    harness.backend.expect::<SetSpaceSidebar>().returns(());
    harness
}

fn target() -> Target {
    support::target("sidebar", Value::Null)
}

async fn open(harness: &TestApp) -> Replica {
    let mut replica = harness.subscribe("sidebar", Value::Null, None).await;
    feed(harness, &mut replica).await;
    replica
}

async fn dispatch(harness: &TestApp, replica: &mut Replica, action: Value) {
    harness
        .app
        .dispatch(&target(), action)
        .await
        .expect("the action is valid");
    feed(harness, replica).await;
}

async fn write(harness: &TestApp, replica: &mut Replica, items: &[SidebarItemView]) {
    dispatch(harness, replica, json!({"type": "write", "items": items})).await;
}

async fn changed(harness: &TestApp, replica: &mut Replica, items: Vec<SidebarItemView>) {
    harness
        .app
        .offer(&CoreEvent::SpaceSidebarChanged { items })
        .await;
    feed(harness, replica).await;
}

fn items(replica: &Replica) -> Value {
    replica.state["items"].clone()
}

fn as_json(items: &[SidebarItemView]) -> Value {
    serde_json::to_value(items).expect("items encode")
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn it_loads_the_layout() {
    let harness = harness_with(vec![space("!a"), folder("f", &["!b"])]);
    let replica = open(&harness).await;

    assert_eq!(replica.state["loaded"], true);
    assert_eq!(
        items(&replica),
        as_json(&[space("!a"), folder("f", &["!b"])])
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_empty_layout_finishes_loading() {
    let harness = harness_with(Vec::new());
    let replica = open(&harness).await;

    assert_eq!(items(&replica), as_json(&[]));
    assert_eq!(replica.state["loaded"], true);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_failed_load_keeps_the_saved_layout() {
    let first = harness_with(vec![folder("f", &["!a"])]);
    open(&first).await;
    first.advance(Duration::from_secs(2)).await;
    let saved = first
        .platform
        .stored(PERSIST_KEY)
        .expect("the view is saved");

    let second = harness_with(Vec::new());
    second.platform.store(PERSIST_KEY, &saved);
    second
        .backend
        .expect::<SpaceSidebar>()
        .fails(|| RpcError::Unavailable);
    let replica = open(&second).await;

    assert_eq!(items(&replica), as_json(&[folder("f", &["!a"])]));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_failed_load_is_tried_again() {
    let harness = harness_with(vec![space("!a")]);
    harness
        .backend
        .expect::<SpaceSidebar>()
        .fails(|| RpcError::Unavailable);
    let mut replica = open(&harness).await;
    assert_eq!(items(&replica), as_json(&[]));
    assert_eq!(replica.state["loaded"], false);

    harness
        .backend
        .expect::<SpaceSidebar>()
        .returns(vec![space("!a")]);
    harness.advance(Duration::from_secs(1)).await;
    feed(&harness, &mut replica).await;

    assert_eq!(items(&replica), as_json(&[space("!a")]));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn it_writes_the_layout_optimistically() {
    let harness = harness_with(vec![space("!a")]);
    let mut replica = open(&harness).await;

    write(&harness, &mut replica, &[space("!b")]).await;

    assert_eq!(items(&replica), as_json(&[space("!b")]));
    let writes = harness.backend.calls::<SetSpaceSidebar>();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].items, [space("!b")]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn it_reloads_after_the_core_refuses_a_layout() {
    let harness = harness_with(vec![space("!a")]);
    let mut replica = open(&harness).await;
    harness
        .backend
        .expect::<SetSpaceSidebar>()
        .fails(|| RpcError::Unavailable);

    write(&harness, &mut replica, &[space("!b")]).await;

    assert_eq!(items(&replica), as_json(&[space("!a")]));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_refused_write_before_the_first_load_reloads_the_empty_loaded_layout() {
    let harness = harness_with(Vec::new());
    let gate = Gate::default();
    harness
        .backend
        .expect::<SpaceSidebar>()
        .after(&gate)
        .returns(Vec::new());
    let mut replica = harness.subscribe("sidebar", Value::Null, None).await;
    harness
        .backend
        .expect::<SetSpaceSidebar>()
        .fails(|| RpcError::Unavailable);

    write(&harness, &mut replica, &[space("!b")]).await;

    assert_eq!(replica.state["loaded"], true);
    assert_eq!(items(&replica), as_json(&[space("!b")]));
    assert_eq!(harness.backend.calls::<SpaceSidebar>().len(), 2);

    gate.open();
    harness.settle().await;
    feed(&harness, &mut replica).await;

    assert_eq!(replica.state["loaded"], true);
    assert_eq!(items(&replica), as_json(&[]));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_refused_write_tells_the_user() {
    let harness = harness_with(vec![space("!a")]);
    let mut replica = open(&harness).await;
    harness
        .backend
        .expect::<SetSpaceSidebar>()
        .fails(|| RpcError::Unavailable);

    harness
        .app
        .dispatch(&target(), json!({"type": "write", "items": [space("!b")]}))
        .await
        .expect("the action is valid");
    let events = feed(&harness, &mut replica).await;

    assert_eq!(notices(&events), [json!({"type": "save_failed"})]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_refusal_of_an_older_write_changes_nothing() {
    let harness = harness_with(vec![space("!a")]);
    let mut replica = open(&harness).await;
    let first = Gate::default();
    harness
        .backend
        .expect::<SetSpaceSidebar>()
        .after(&first)
        .fails(|| RpcError::Unavailable);

    write(&harness, &mut replica, &[space("!b")]).await;
    harness.backend.expect::<SetSpaceSidebar>().returns(());
    write(&harness, &mut replica, &[space("!c")]).await;
    first.open();
    harness.settle().await;
    feed(&harness, &mut replica).await;

    assert_eq!(items(&replica), as_json(&[space("!c")]));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_stale_layout_from_the_core_is_ignored_while_a_write_is_in_flight() {
    let harness = harness_with(vec![space("!a")]);
    let mut replica = open(&harness).await;
    let gate = Gate::default();
    harness
        .backend
        .expect::<SetSpaceSidebar>()
        .after(&gate)
        .returns(());
    write(&harness, &mut replica, &[space("!b")]).await;

    changed(&harness, &mut replica, vec![space("!a")]).await;
    assert_eq!(items(&replica), as_json(&[space("!b")]));

    changed(&harness, &mut replica, vec![space("!b")]).await;
    changed(&harness, &mut replica, vec![space("!c")]).await;
    assert_eq!(items(&replica), as_json(&[space("!c")]));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_core_wins_again_once_a_write_is_stored() {
    let harness = harness_with(vec![space("!a")]);
    let mut replica = open(&harness).await;
    write(&harness, &mut replica, &[space("!b")]).await;

    changed(&harness, &mut replica, vec![space("!other")]).await;

    assert_eq!(items(&replica), as_json(&[space("!other")]));
}

fn pool_item() -> BoxedStrategy<SidebarItemView> {
    prop_oneof![
        (0u8..4).prop_map(|n| space(&format!("!s{n}"))),
        (0u8..3, 0u8..4).prop_map(|(id, room)| folder(&format!("f{id}"), &[&format!("!s{room}")])),
    ]
    .boxed()
}

fn step() -> impl Strategy<Value = Step> {
    let layout = proptest::collection::vec(pool_item(), 0..4);
    prop_oneof![
        layout
            .clone()
            .prop_map(|items| Step::Action(json!({"type": "write", "items": items}))),
        layout.prop_map(|items| Step::Core(CoreEvent::SpaceSidebarChanged { items })),
    ]
}

proptest! {
    #[test]
    fn patches_converge_to_a_fresh_snapshot(
        steps in proptest::collection::vec(proptest::collection::vec(step(), 1..4), 1..10),
    ) {
        tokio::runtime::Builder::new_current_thread()
            .start_paused(true)
            .enable_time()
            .build()
            .unwrap()
            .block_on(assert_patches_converge::<Sidebar>(
                |backend| {
                    backend.expect::<SpaceSidebar>().returns(vec![space("!s0")]);
                    backend.expect::<SetSpaceSidebar>().returns(());
                },
                Value::Null,
                None,
                &steps,
            ));
    }
}

fn notices(events: &[AppEvent]) -> Vec<Value> {
    events
        .iter()
        .filter_map(|event| match event {
            AppEvent::Notice { notice, .. } => Some(notice.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_read_started_before_a_write_does_not_undo_it() {
    let harness = harness_with(vec![space("!a")]);
    let reading = Gate::default();
    harness
        .backend
        .expect::<SpaceSidebar>()
        .after(&reading)
        .returns(vec![space("!a")]);
    let mut replica = open(&harness).await;
    write(&harness, &mut replica, &[space("!b")]).await;

    reading.open();
    harness.settle().await;
    feed(&harness, &mut replica).await;
    assert_eq!(items(&replica), as_json(&[space("!b")]));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_retry_started_during_a_write_does_not_undo_its_answer() {
    let harness = harness_with(Vec::new());
    harness
        .backend
        .expect::<SpaceSidebar>()
        .fails(|| RpcError::Unavailable);
    let mut replica = open(&harness).await;
    let writing = Gate::default();
    harness
        .backend
        .expect::<SetSpaceSidebar>()
        .after(&writing)
        .returns(());
    write(&harness, &mut replica, &[space("!b")]).await;

    let reading = Gate::default();
    harness
        .backend
        .expect::<SpaceSidebar>()
        .after(&reading)
        .returns(vec![space("!a")]);
    harness.advance(Duration::from_secs(1)).await;
    writing.open();
    harness.settle().await;
    reading.open();
    harness.settle().await;
    feed(&harness, &mut replica).await;
    assert_eq!(items(&replica), as_json(&[space("!b")]));
}
