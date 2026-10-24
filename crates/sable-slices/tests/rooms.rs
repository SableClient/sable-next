//! The room list slice through the app, with the core's room list faked.

#![cfg(test)]

use std::time::Duration;

use proptest::prelude::*;
use ruma::{OwnedRoomId, OwnedUserId};
use sable_protocol::{CoreEvent, RoomListItemView, RpcError, SubscriptionId, VectorDiff};
use sable_runtime::{
    Registry, Target, Window,
    testing::{Gate, Replica, Step, TestApp, assert_patches_converge},
};
use sable_slices::rooms::Rooms;
use sable_slices::rpc::timeline::{RoomListSubscribed, SubscribeRoomList, Unsubscribe, WarmRooms};
use serde_json::{Value, json};

mod support;
use support::feed;

const SUB: SubscriptionId = SubscriptionId(7);
const GRACE: Duration = Duration::from_secs(10);
const PERSIST_KEY: &str = "snapshot/account-a/rooms/null";

fn row(id: &str) -> RoomListItemView {
    unread_row(id, 0, 0, 0)
}

fn unread_row(id: &str, unread: u32, notifying: u32, highlight: u32) -> RoomListItemView {
    serde_json::from_value(json!({
        "room_id": id,
        "canonical_alias": null,
        "name": null,
        "topic": null,
        "avatar_url": null,
        "is_direct": false,
        "direct_targets": [],
        "join_rule": "invite",
        "tags": [],
        "state": "joined",
        "encrypted": null,
        "is_tombstoned": false,
        "room_kind": "text",
        "call_participants": [],
        "screen_sharers": [],
        "supports_knock": false,
        "supports_restricted": false,
        "supports_knock_restricted": false,
        "space_children": [],
        "unread": unread,
        "notifying": notifying,
        "highlight": highlight,
        "marked_unread": false,
        "notification": { "room": null, "default": "mentions" },
        "counts": {
            "unread": unread,
            "notifying": notifying,
            "highlight": highlight,
            "marked": false
        },
        "latest_event": null
    }))
    .expect("a room list row")
}

fn space(id: &str, children: &[&str]) -> RoomListItemView {
    let mut value = serde_json::to_value(row(id)).expect("a row encodes");
    value["room_kind"] = json!("space");
    value["space_children"] = children
        .iter()
        .map(|child| {
            json!({
                "room_id": child,
                "via": [],
                "order": null,
                "origin_server_ts": 1,
                "suggested": false
            })
        })
        .collect();
    serde_json::from_value(value).expect("a space row")
}

fn muted_with_mark(id: &str) -> RoomListItemView {
    let mut value = serde_json::to_value(row(id)).expect("a row encodes");
    value["counts"]["marked"] = json!(true);
    value["notification"]["room"] = json!("mute");
    serde_json::from_value(value).expect("a muted row")
}

fn diff(subscription: SubscriptionId, diffs: Vec<VectorDiff<RoomListItemView>>) -> CoreEvent {
    CoreEvent::RoomListDiff {
        subscription,
        diffs,
    }
}

fn reset(rows: Vec<RoomListItemView>) -> CoreEvent {
    diff(
        SUB,
        vec![VectorDiff::Reset {
            values: rows.into(),
        }],
    )
}

fn typing(room: &str, users: &[&str]) -> CoreEvent {
    CoreEvent::Typing {
        room_id: OwnedRoomId::try_from(room).expect("a room id"),
        user_ids: users
            .iter()
            .map(|user| OwnedUserId::try_from(*user).expect("a user id"))
            .collect(),
    }
}

fn registry() -> Registry {
    let mut registry = Registry::new();
    registry.add::<Rooms>().expect("rooms is registered once");
    registry
}

fn harness() -> TestApp {
    let harness = TestApp::new(registry());
    expect_core(&harness);
    harness
}

fn expect_core(harness: &TestApp) {
    harness
        .backend
        .expect::<SubscribeRoomList>()
        .returns(RoomListSubscribed { subscription: SUB });
    harness.backend.expect::<Unsubscribe>().returns(());
    harness.backend.expect::<WarmRooms>().returns(());
}

fn target() -> Target {
    support::target("rooms", Value::Null)
}

async fn offer(harness: &TestApp, replica: &mut Replica, event: CoreEvent) {
    harness.app.offer(&event).await;
    feed(harness, replica).await;
}

async fn dispatch(harness: &TestApp, action: Value) {
    harness
        .app
        .dispatch(&target(), action)
        .await
        .expect("the action is valid");
}

async fn preferences(harness: &TestApp, quiet: &[&str], direct: &str, group: &str) {
    dispatch(
        harness,
        json!({
            "type": "set_preferences",
            "quiet_targets": quiet,
            "badge_defaults": { "direct": direct, "group": group }
        }),
    )
    .await;
}

fn ids(replica: &Replica) -> Vec<&str> {
    replica.state["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| item["room_id"].as_str().expect("a room id"))
        .collect()
}

fn status(replica: &Replica) -> &Value {
    &replica.state
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn it_subscribes_and_an_unsaved_list_is_settled_at_once() {
    let harness = harness();
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;
    feed(&harness, &mut replica).await;

    assert_eq!(harness.backend.calls::<SubscribeRoomList>().len(), 1);
    assert_eq!(status(&replica)["settled"], true);
    assert_eq!(ids(&replica), Vec::<&str>::new());
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_saved_list_waits_for_the_server_before_it_is_settled() {
    let first = harness();
    let mut replica = first.subscribe("rooms", Value::Null, None).await;
    offer(&first, &mut replica, reset(vec![row("!old:x")])).await;
    first.advance(Duration::from_secs(2)).await;
    let saved = first
        .platform
        .stored(PERSIST_KEY)
        .expect("the view is saved");

    let second = harness();
    second.platform.store(PERSIST_KEY, &saved);
    let gate = Gate::default();
    second
        .backend
        .expect::<SubscribeRoomList>()
        .after(&gate)
        .returns(RoomListSubscribed { subscription: SUB });
    let mut replica = second.subscribe("rooms", Value::Null, None).await;
    assert_eq!(ids(&replica), ["!old:x"]);
    assert_eq!(status(&replica)["settled"], false);

    gate.open();
    second.settle().await;
    feed(&second, &mut replica).await;
    assert_eq!(status(&replica)["settled"], false);

    offer(
        &second,
        &mut replica,
        diff(
            SUB,
            vec![VectorDiff::Append {
                values: vec![row("!a:x")].into(),
            }],
        ),
    )
    .await;
    assert_eq!(ids(&replica), ["!a:x"]);
    assert_eq!(status(&replica)["settled"], true);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn diffs_that_beat_the_answer_are_held_and_replayed() {
    let harness = harness();
    let gate = Gate::default();
    harness
        .backend
        .expect::<SubscribeRoomList>()
        .after(&gate)
        .returns(RoomListSubscribed { subscription: SUB });
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;

    harness.app.offer(&reset(vec![row("!a:x")])).await;
    harness
        .app
        .offer(&diff(
            SubscriptionId(99),
            vec![VectorDiff::PushBack {
                value: row("!other:x"),
            }],
        ))
        .await;
    feed(&harness, &mut replica).await;
    assert_eq!(ids(&replica), Vec::<&str>::new());

    gate.open();
    harness.advance(Duration::from_secs(11)).await;
    feed(&harness, &mut replica).await;
    assert_eq!(ids(&replica), ["!a:x"]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn diffs_of_another_subscription_are_ignored() {
    let harness = harness();
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;
    offer(&harness, &mut replica, reset(vec![row("!a:x")])).await;

    offer(
        &harness,
        &mut replica,
        diff(SubscriptionId(8), vec![VectorDiff::Clear]),
    )
    .await;

    assert_eq!(ids(&replica), ["!a:x"]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_core_subscription_ends_when_the_last_view_has_gone() {
    let harness = harness();
    let replica = harness.subscribe("rooms", Value::Null, None).await;
    harness.settle().await;
    harness.app.unsubscribe(replica.sub).await;

    harness.advance(Duration::from_secs(9)).await;
    assert_eq!(harness.backend.calls::<Unsubscribe>().len(), 0);

    harness.advance(Duration::from_secs(2)).await;
    let ended = harness.backend.calls::<Unsubscribe>();
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].subscription, SUB);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn disposing_while_the_subscription_is_starting_still_unsubscribes_it() {
    let harness = harness();
    let gate = Gate::default();
    harness
        .backend
        .expect::<SubscribeRoomList>()
        .after(&gate)
        .returns(RoomListSubscribed { subscription: SUB });
    let replica = harness.subscribe("rooms", Value::Null, None).await;
    harness.settle().await;
    harness.app.unsubscribe(replica.sub).await;

    gate.open();
    harness.advance(Duration::from_secs(11)).await;

    let ended = harness.backend.calls::<Unsubscribe>();
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].subscription, SUB);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_failed_subscription_is_tried_again_until_it_works() {
    let harness = harness();
    harness
        .backend
        .expect::<SubscribeRoomList>()
        .fails(|| RpcError::Unavailable);
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["settled"], false);

    harness.advance(Duration::from_secs(1)).await;
    assert_eq!(harness.backend.calls::<SubscribeRoomList>().len(), 2);
    harness
        .backend
        .expect::<SubscribeRoomList>()
        .returns(RoomListSubscribed { subscription: SUB });
    harness.advance(Duration::from_secs(2)).await;
    feed(&harness, &mut replica).await;

    assert_eq!(harness.backend.calls::<SubscribeRoomList>().len(), 3);
    assert_eq!(status(&replica)["settled"], true);
    offer(&harness, &mut replica, reset(vec![row("!a:x")])).await;
    assert_eq!(ids(&replica), ["!a:x"]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_subscription_that_keeps_failing_is_retried_at_the_cap() {
    let harness = harness();
    harness
        .backend
        .expect::<SubscribeRoomList>()
        .fails(|| RpcError::Unavailable);
    let _replica = harness.subscribe("rooms", Value::Null, None).await;

    for _ in 0..12 {
        harness.advance(Duration::from_secs(30)).await;
    }

    assert_eq!(harness.backend.calls::<SubscribeRoomList>().len(), 13);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn typing_is_absolute_per_room() {
    let harness = harness();
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;

    offer(&harness, &mut replica, typing("!a:x", &["@u:x", "@v:x"])).await;
    assert_eq!(
        status(&replica)["typing"],
        json!({"!a:x": ["@u:x", "@v:x"]})
    );

    offer(&harness, &mut replica, typing("!a:x", &[])).await;
    assert_eq!(status(&replica)["typing"], json!({}));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn nobody_typing_in_a_room_that_was_quiet_sends_nothing() {
    let harness = harness();
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;
    feed(&harness, &mut replica).await;

    harness.app.offer(&typing("!a:x", &[])).await;

    assert_eq!(harness.events().await, Vec::new());
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_room_shows_its_counts_under_the_default_for_its_kind() {
    let harness = harness();
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;
    offer(
        &harness,
        &mut replica,
        reset(vec![unread_row("!a:x", 6, 6, 1)]),
    )
    .await;

    preferences(&harness, &[], "all", "mentions").await;
    feed(&harness, &mut replica).await;
    assert_eq!(
        status(&replica)["badges"]["!a:x"],
        json!({"unread": 6, "highlight": 1, "marked": false, "notifying": 0})
    );

    preferences(&harness, &[], "all", "all").await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["badges"]["!a:x"]["notifying"], 6);

    preferences(&harness, &[], "all", "quiet").await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["badges"]["!a:x"]["unread"], 1);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_room_that_shows_nothing_has_no_badge() {
    let harness = harness();
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;
    offer(&harness, &mut replica, reset(vec![row("!a:x")])).await;

    assert_eq!(status(&replica)["badges"], json!({}));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_muted_room_keeps_a_hand_mark_and_nothing_else() {
    let harness = harness();
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;
    offer(&harness, &mut replica, reset(vec![muted_with_mark("!a:x")])).await;

    assert_eq!(
        status(&replica)["badges"]["!a:x"],
        json!({"unread": 0, "highlight": 0, "marked": true, "notifying": 0})
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_hidden_space_silences_what_is_beneath_it() {
    let harness = harness();
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;
    offer(
        &harness,
        &mut replica,
        reset(vec![
            space("!s:x", &["!a:x"]),
            unread_row("!a:x", 5, 5, 1),
            unread_row("!b:x", 3, 3, 0),
        ]),
    )
    .await;

    preferences(&harness, &["!s:x"], "all", "all").await;
    feed(&harness, &mut replica).await;

    assert_eq!(status(&replica)["quiet_room_ids"], json!(["!a:x", "!s:x"]));
    assert_eq!(
        status(&replica)["badges"]["!a:x"],
        json!({"unread": 1, "highlight": 1, "marked": false, "notifying": 0})
    );
    assert_eq!(status(&replica)["badges"]["!b:x"]["notifying"], 3);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_space_totals_its_rooms_under_the_same_rules() {
    let harness = harness();
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;
    offer(
        &harness,
        &mut replica,
        reset(vec![
            space("!s:x", &["!a:x", "!b:x"]),
            unread_row("!a:x", 4, 4, 1),
            unread_row("!b:x", 2, 0, 0),
        ]),
    )
    .await;

    preferences(&harness, &[], "all", "all").await;
    feed(&harness, &mut replica).await;

    assert_eq!(
        status(&replica)["space_unread"]["!s:x"],
        json!({"unread": 6, "highlight": 1, "marked": false, "notifying": 6})
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_change_that_leaves_the_badges_alone_does_not_resend_them() {
    let harness = harness();
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;
    offer(
        &harness,
        &mut replica,
        reset(vec![unread_row("!a:x", 2, 2, 0)]),
    )
    .await;

    harness
        .app
        .offer(&diff(
            SUB,
            vec![VectorDiff::Set {
                index: 0,
                value: unread_row("!a:x", 2, 2, 0),
            }],
        ))
        .await;
    let events = harness.events().await;

    assert!(
        events
            .iter()
            .any(|event| { matches!(event, sable_runtime::AppEvent::Patch { .. }) })
    );
}

/// A room update replaces one row and its derived badges.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_change_to_a_rows_counts_costs_the_fields_it_changed() {
    let harness = harness();
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;
    offer(
        &harness,
        &mut replica,
        reset(vec![unread_row("!a:x", 0, 0, 0)]),
    )
    .await;

    harness
        .app
        .offer(&diff(
            SUB,
            vec![VectorDiff::Set {
                index: 0,
                value: unread_row("!a:x", 1, 1, 0),
            }],
        ))
        .await;
    let events = harness.events().await;
    for event in &events {
        replica.apply(event).expect("the patch applies");
    }

    assert_eq!(replica.state["items"][0]["unread"], 1);
    let bytes: usize = events
        .iter()
        .filter(|event| matches!(event, sable_runtime::AppEvent::Patch { .. }))
        .map(|event| {
            serde_json::to_string(event)
                .expect("an event encodes")
                .len()
        })
        .sum();
    assert!(bytes > 0, "the row update emitted no patch");
}

fn warmed(harness: &TestApp) -> Vec<Vec<String>> {
    harness
        .backend
        .calls::<WarmRooms>()
        .into_iter()
        .map(|call| call.room_ids)
        .collect()
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn warming_batches_and_remembers_what_it_warmed() {
    let harness = harness();
    let _replica = harness.subscribe("rooms", Value::Null, None).await;
    let warm = |room: &str| json!({"type": "warm", "room_id": room});

    dispatch(&harness, warm("!a:x")).await;
    dispatch(&harness, warm("!b:x")).await;
    dispatch(&harness, warm("!a:x")).await;
    assert_eq!(warmed(&harness), Vec::<Vec<String>>::new());

    harness.advance(Duration::from_millis(100)).await;
    assert_eq!(warmed(&harness), [["!a:x", "!b:x"]]);

    dispatch(&harness, warm("!a:x")).await;
    harness.advance(Duration::from_millis(100)).await;
    assert_eq!(warmed(&harness).len(), 1);

    dispatch(&harness, warm("!c:x")).await;
    harness.advance(Duration::from_millis(100)).await;
    assert_eq!(warmed(&harness), [vec!["!a:x", "!b:x"], vec!["!c:x"]]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn only_the_latest_rooms_are_remembered_as_warm() {
    let harness = harness();
    let _replica = harness.subscribe("rooms", Value::Null, None).await;
    for n in 0..=32 {
        dispatch(
            &harness,
            json!({"type": "warm", "room_id": format!("!r{n}:x")}),
        )
        .await;
    }
    harness.advance(Duration::from_millis(100)).await;

    dispatch(&harness, json!({"type": "warm", "room_id": "!r0:x"})).await;
    harness.advance(Duration::from_millis(100)).await;

    assert_eq!(warmed(&harness).last(), Some(&vec!["!r0:x".to_owned()]));
}

fn pool_row() -> BoxedStrategy<RoomListItemView> {
    (0u8..6, 0u32..4, 0u32..3, any::<bool>())
        .prop_map(|(n, unread, highlight, is_space)| {
            let id = format!("!r{n}:x");
            if is_space {
                space(&id, &["!r0:x", "!r1:x", "!r2:x"])
            } else {
                unread_row(&id, unread, unread, highlight)
            }
        })
        .boxed()
}

fn vector_diff() -> BoxedStrategy<VectorDiff<RoomListItemView>> {
    prop_oneof![
        proptest::collection::vec(pool_row(), 0..5).prop_map(|values| VectorDiff::Reset {
            values: values.into()
        }),
        pool_row().prop_map(|value| VectorDiff::PushBack { value }),
        pool_row().prop_map(|value| VectorDiff::PushFront { value }),
        (0usize..6, pool_row()).prop_map(|(index, value)| VectorDiff::Set { index, value }),
        (0usize..6, pool_row()).prop_map(|(index, value)| VectorDiff::Insert { index, value }),
        (0usize..6).prop_map(|index| VectorDiff::Remove { index }),
        Just(VectorDiff::PopFront),
        Just(VectorDiff::Clear),
    ]
    .boxed()
}

fn step() -> impl Strategy<Value = Step> {
    let mode = || prop_oneof![Just("all"), Just("mentions"), Just("quiet")];
    prop_oneof![
        proptest::collection::vec(vector_diff(), 1..4)
            .prop_map(|diffs| Step::Core(diff(SUB, diffs))),
        (0u8..6, proptest::collection::vec(0u8..3, 0..3)).prop_map(|(room, users)| {
            let users: Vec<String> = users.iter().map(|user| format!("@u{user}:x")).collect();
            let users: Vec<&str> = users.iter().map(String::as_str).collect();
            Step::Core(typing(&format!("!r{room}:x"), &users))
        }),
        (proptest::collection::vec(0u8..6, 0..3), mode(), mode()).prop_map(
            |(quiet, direct, group)| {
                Step::Action(json!({
                    "type": "set_preferences",
                    "quiet_targets": quiet.iter().map(|n| format!("!r{n}:x")).collect::<Vec<_>>(),
                    "badge_defaults": { "direct": direct, "group": group }
                }))
            }
        ),
        (0u8..6).prop_map(|n| Step::Action(json!({"type": "warm", "room_id": format!("!r{n}:x")}))),
    ]
}

proptest! {
    #[test]
    fn patches_converge_to_a_fresh_snapshot(
        windowed in any::<bool>(),
        steps in proptest::collection::vec(proptest::collection::vec(step(), 1..4), 1..10),
    ) {
        let window = windowed.then_some(Window { start: 1, end: 4 });
        tokio::runtime::Builder::new_current_thread()
            .start_paused(true)
            .enable_time()
            .build()
            .unwrap()
            .block_on(assert_patches_converge::<Rooms>(
                |backend| {
                    backend
                        .expect::<SubscribeRoomList>()
                        .returns(RoomListSubscribed { subscription: SUB });
                    backend.expect::<Unsubscribe>().returns(());
                    backend.expect::<WarmRooms>().returns(());
                },
                Value::Null,
                window,
                &steps,
            ));
    }
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_room_list_follows_a_reader_through_a_session() {
    let harness = harness();
    let mut replica = harness.subscribe("rooms", Value::Null, None).await;

    preferences(&harness, &["!s:x"], "all", "mentions").await;
    offer(
        &harness,
        &mut replica,
        reset(vec![
            space("!s:x", &["!a:x"]),
            unread_row("!a:x", 3, 3, 0),
            unread_row("!b:x", 2, 2, 1),
        ]),
    )
    .await;
    assert_eq!(ids(&replica), ["!s:x", "!a:x", "!b:x"]);
    assert_eq!(status(&replica)["badges"]["!b:x"]["highlight"], 1);
    assert_eq!(status(&replica)["badges"].get("!a:x"), None);

    offer(&harness, &mut replica, typing("!b:x", &["@u:x"])).await;
    offer(
        &harness,
        &mut replica,
        diff(
            SUB,
            vec![VectorDiff::Set {
                index: 2,
                value: unread_row("!b:x", 0, 0, 0),
            }],
        ),
    )
    .await;
    assert_eq!(status(&replica)["badges"].get("!b:x"), None);

    let fresh = harness.app.resync(replica.sub).await.expect("live");
    assert_eq!(replica.state, fresh.state);

    harness.app.unsubscribe(replica.sub).await;
    harness.advance(GRACE + Duration::from_secs(1)).await;
    assert_eq!(harness.backend.calls::<Unsubscribe>().len(), 1);
    assert_eq!(harness.backend.unexpected(), Vec::<String>::new());
}
