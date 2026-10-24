//! The timeline slice through the app, with the core's side faked.

#![cfg(test)]

use std::time::Duration;

use proptest::prelude::*;
use sable_protocol::{
    CoreEvent, RpcError, SubscriptionId, TimelineItemView, TimelineKey, VectorDiff,
};
use sable_runtime::{
    AppEvent, Outcome, Registry, ReqId, Target, Window,
    testing::{Gate, Replica, Step, TestApp, assert_patches_converge},
};
use sable_slices::rpc::timeline::{
    FetchEventDetails, Focus, Paginate, PaginateOk, ReadMarker, Subscribe, SubscribeOk, Unsubscribe,
};
use sable_slices::timeline::Timeline;

mod support;

use serde_json::{Value, json};
use support::feed;

const ROOM: &str = "!room:x";
const SUB: SubscriptionId = SubscriptionId(7);

fn item(content: &Value, id: &str, timestamp: u64) -> TimelineItemView {
    serde_json::from_value(json!({
        "id": id,
        "row": row_kind(content),
        "forwardable": false,
        "redactable": true,
        "visibility": visibility(content),
        "event_id": format!("${id}"),
        "transaction_id": null,
        "send_state": null,
        "sender": "@alice:x",
        "sender_name": "Alice",
        "sender_avatar": null,
        "timestamp": timestamp,
        "content": content,
        "in_reply_to": null,
        "thread_root": null,
        "thread_summary": null,
        "reactions": [],
        "is_own": false,
        "read_by": [],
        "read_timestamps": {},
        "per_message_profile": null,
        "bundled_link_previews": [],
        "link_previews_removed": null,
        "mention": "none",
        "forwarded": null,
        "forum_title": null,
    }))
    .expect("a timeline item")
}

fn row_kind(content: &Value) -> &'static str {
    match content["kind"].as_str() {
        Some("message") => "message",
        Some("read_marker" | "date_divider" | "timeline_start") => "annotation",
        _ => "event",
    }
}

fn visibility(content: &Value) -> &'static str {
    match content["kind"].as_str() {
        Some("membership") => "membership",
        Some("hidden_event") => "hidden",
        _ => "always",
    }
}

fn changed(item: &TimelineItemView, changes: &Value) -> TimelineItemView {
    let mut value = serde_json::to_value(item).expect("an item encodes");
    for (name, change) in changes.as_object().expect("changes are an object") {
        value[name] = change.clone();
    }
    serde_json::from_value(value).expect("the changed item")
}

fn message(id: &str, timestamp: u64) -> TimelineItemView {
    item(
        &json!({
            "kind": "message", "body": id, "html": id, "emote": false, "notice": false, "edited": false
        }),
        id,
        timestamp,
    )
}

fn joined(id: &str, timestamp: u64) -> TimelineItemView {
    changed(
        &item(
            &json!({
                "kind": "membership", "user_id": format!("@{id}:x"), "change": "joined",
                "display_name": id, "reason": null
            }),
            id,
            timestamp,
        ),
        &json!({ "sender": format!("@{id}:x") }),
    )
}

fn read_marker() -> TimelineItemView {
    changed(
        &item(&json!({ "kind": "read_marker" }), "marker", 0),
        &json!({ "event_id": null }),
    )
}

fn aggregation(id: &str, timestamp: u64) -> TimelineItemView {
    item(
        &json!({
            "kind": "hidden_event", "event_type": "m.reaction", "content": null, "redacts": null
        }),
        id,
        timestamp,
    )
}

fn opened(subscription: u32, items: Vec<TimelineItemView>) -> SubscribeOk {
    SubscribeOk {
        subscription: SubscriptionId(subscription),
        items,
        aggregations: Vec::new(),
    }
}

fn key() -> Value {
    json!({ "room_id": ROOM, "view": "main" })
}

fn target() -> Target {
    support::target("timeline", key())
}

fn harness() -> TestApp {
    let mut registry = Registry::new();
    registry
        .add::<Timeline>()
        .expect("timeline is registered once");
    let harness = TestApp::new(registry);
    expect_core(&harness);
    harness
}

fn expect_core(harness: &TestApp) {
    harness
        .backend
        .expect::<Subscribe>()
        .returns(opened(7, vec![message("a", 1_000), message("b", 2_000)]));
    harness.backend.expect::<Unsubscribe>().returns(());
    harness.backend.expect::<FetchEventDetails>().returns(());
    harness
        .backend
        .expect::<Paginate>()
        .returns(PaginateOk { reached_end: false });
    harness.backend.expect::<ReadMarker>().returns(None);
}

async fn follow(harness: &TestApp, replicas: &mut [&mut Replica]) {
    for event in harness.events().await {
        for replica in replicas.iter_mut() {
            replica.apply(&event).expect("the patch applies");
        }
    }
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

async fn request(harness: &TestApp, action: Value) -> ReqId {
    harness
        .app
        .request(&target(), action)
        .await
        .expect("the action is valid")
}

fn open_live() -> Value {
    json!({
        "type": "open",
        "target": { "kind": "live" },
        "hidden_events": false,
        "unread": false,
        "has_unread": false,
        "landing": null
    })
}

fn open(target: &Value) -> Value {
    json!({
        "type": "open",
        "target": target,
        "hidden_events": false,
        "unread": false,
        "has_unread": false,
        "landing": null
    })
}

fn configure(overrides: &Value) -> Value {
    let mut action = json!({
        "type": "configure",
        "filters": {
            "hide_membership_events": false,
            "hide_profile_changes": true,
            "hide_topic_changes": false,
            "hide_member_in_read_only": false,
            "show_tombstone_events": true,
            "show_hidden_events": false,
            "hidden_event_edits": true,
            "hidden_event_reactions": true,
            "hidden_event_redactions": true,
            "hidden_event_other": true
        },
        "reply_style": "connected",
        "read_only": false,
        "utc_offset_minutes": 0,
        "thread_root": null
    });
    for (name, value) in overrides.as_object().expect("overrides are an object") {
        action[name] = value.clone();
    }
    action
}

fn diff(subscription: SubscriptionId, diffs: Vec<VectorDiff<TimelineItemView>>) -> CoreEvent {
    CoreEvent::TimelineDiff {
        subscription,
        key: Some(serde_json::from_value(key()).expect("a timeline key")),
        diffs,
    }
}

fn row_ids(replica: &Replica) -> Vec<&str> {
    replica.state["items"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| row["item"]["id"].as_str().expect("an item id"))
        .collect()
}

fn status(replica: &Replica) -> &Value {
    &replica.state["status"]
}

fn outcomes(events: &[AppEvent]) -> Vec<(ReqId, &Outcome)> {
    events
        .iter()
        .filter_map(|event| match event {
            AppEvent::Reply { req, outcome, .. } => Some((*req, outcome)),
            _ => None,
        })
        .collect()
}

fn answered(events: &[AppEvent], req: ReqId) -> Option<&Outcome> {
    outcomes(events)
        .into_iter()
        .find_map(|(found, outcome)| (found == req).then_some(outcome))
}

async fn opened_live(harness: &TestApp) -> Replica {
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(harness, open_live()).await;
    feed(harness, &mut replica).await;
    replica
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn it_opens_the_live_timeline_and_answers_the_open() {
    let harness = harness();
    let mut replica = harness.subscribe("timeline", key(), None).await;
    assert_eq!(status(&replica)["has_snapshot"], false);

    let req = request(&harness, open_live()).await;
    let events = feed(&harness, &mut replica).await;

    let calls = harness.backend.calls::<Subscribe>();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].room_id, ROOM);
    assert!(matches!(calls[0].focus, Focus::Live));
    assert_eq!(row_ids(&replica), ["a", "b"]);
    assert_eq!(status(&replica)["has_snapshot"], true);
    assert_eq!(status(&replica)["loading"], false);
    assert_eq!(status(&replica)["mode"]["kind"], "live");
    assert_eq!(status(&replica)["subscription"], 7);
    assert_eq!(status(&replica)["latest_event_id"], "$b");
    assert_eq!(status(&replica)["reaches_latest"], true);
    assert_eq!(
        answered(&events, req),
        Some(&Outcome::Ok { value: Value::Null })
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_open_that_fails_says_so_in_the_status_and_still_answers() {
    let harness = harness();
    harness
        .backend
        .expect::<Subscribe>()
        .fails(|| RpcError::Unavailable);
    let mut replica = harness.subscribe("timeline", key(), None).await;
    let req = request(&harness, open_live()).await;
    let events = feed(&harness, &mut replica).await;

    assert_eq!(status(&replica)["error"], "load_failed");
    assert_eq!(status(&replica)["loading"], false);
    assert_eq!(status(&replica)["has_snapshot"], false);
    assert_eq!(
        answered(&events, req),
        Some(&Outcome::Ok { value: Value::Null })
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn diffs_that_beat_the_answer_are_held_and_the_others_dropped() {
    let harness = harness();
    let gate = Gate::default();
    harness
        .backend
        .expect::<Subscribe>()
        .after(&gate)
        .returns(opened(7, vec![message("a", 1_000)]));
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(&harness, open_live()).await;

    harness
        .app
        .offer(&diff(
            SUB,
            vec![VectorDiff::PushBack {
                value: message("b", 2_000),
            }],
        ))
        .await;
    harness
        .app
        .offer(&CoreEvent::TimelineDiff {
            subscription: SubscriptionId(99),
            key: Some(TimelineKey {
                room_id: "!other:x".to_owned(),
                view: "other".to_owned(),
            }),
            diffs: vec![VectorDiff::PushBack {
                value: message("other", 3_000),
            }],
        })
        .await;
    feed(&harness, &mut replica).await;
    assert_eq!(row_ids(&replica), Vec::<&str>::new());

    gate.open();
    harness.settle().await;
    feed(&harness, &mut replica).await;
    assert_eq!(row_ids(&replica), ["a", "b"]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_new_message_is_one_row_patch_and_collapses_into_the_run() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;

    harness
        .app
        .offer(&diff(
            SUB,
            vec![VectorDiff::PushBack {
                value: message("c", 3_000),
            }],
        ))
        .await;
    let events = harness.events().await;
    for event in &events {
        replica.apply(event).expect("the patch applies");
    }

    assert_eq!(row_ids(&replica), ["a", "b", "c"]);
    assert_eq!(replica.state["items"][2]["collapsed"], true);
    let patches = events
        .iter()
        .filter(|event| matches!(event, AppEvent::Patch { .. }))
        .count();
    assert_eq!(patches, 1);
}

/// An item the way the core sends one for a live room, so the sizes below are the real ones.
fn chat_message(index: usize, body: &str, read_by: &[&str]) -> TimelineItemView {
    let event_id = format!("${index:0>43}");
    changed(
        &item(
            &json!({
                "kind": "message", "body": body,
                "html": format!("<span data-plain-body>{body}</span>"),
                "emote": false, "notice": false, "edited": false, "jumbo": null
            }),
            &index.to_string(),
            1_792_864_655_000 + index as u64 * 60_000,
        ),
        &json!({
            "event_id": event_id,
            "sender": "@bob:test.local",
            "sender_name": "bob",
            "read_by": read_by,
            "read_timestamps": read_by
                .iter()
                .map(|reader| ((*reader).to_owned(), json!(1_792_864_655_000_u64)))
                .collect::<serde_json::Map<_, _>>(),
        }),
    )
}

fn patch_bytes(events: &[AppEvent]) -> usize {
    events
        .iter()
        .filter(|event| matches!(event, AppEvent::Patch { .. }))
        .map(|event| {
            serde_json::to_string(event)
                .expect("an event encodes")
                .len()
        })
        .sum()
}

async fn live_chat(readers: &[&str]) -> (TestApp, Replica) {
    let harness = harness();
    let items: Vec<_> = (0..30)
        .map(|index| {
            chat_message(
                index,
                &format!("Long message {index}"),
                if index == 29 { readers } else { &[] },
            )
        })
        .collect();
    harness
        .backend
        .expect::<Subscribe>()
        .returns(opened(7, items));
    let replica = opened_live(&harness).await;
    (harness, replica)
}

/// A row leaves off the fields that are null, empty or at their defaults.
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_new_message_costs_its_row_and_a_little_more() {
    let (harness, mut replica) = live_chat(&["@bob:test.local"]).await;

    let diffs = vec![
        VectorDiff::Set {
            index: 29,
            value: chat_message(29, "Long message 29", &[]),
        },
        VectorDiff::PushBack {
            value: chat_message(30, "Probe message", &["@bob:test.local"]),
        },
    ];
    harness.app.offer(&diff(SUB, diffs)).await;
    let events = feed(&harness, &mut replica).await;

    assert_eq!(replica.state["total"], 31);
    let bytes = patch_bytes(&events);
    assert!(bytes <= 1_600, "a new message crossed as {bytes} bytes");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_edit_costs_the_fields_it_changed() {
    let (harness, mut replica) = live_chat(&[]).await;

    let mut edited = chat_message(29, "edited", &[]);
    edited = changed(
        &edited,
        &json!({ "content": {
            "kind": "message", "body": "edited", "html": "<span data-plain-body>edited</span>",
            "emote": false, "notice": false, "edited": true, "jumbo": null
        } }),
    );
    harness
        .app
        .offer(&diff(
            SUB,
            vec![VectorDiff::Set {
                index: 29,
                value: edited,
            }],
        ))
        .await;
    let events = feed(&harness, &mut replica).await;

    assert_eq!(
        replica.state["items"][29]["item"]["content"]["body"],
        "edited"
    );
    let bytes = patch_bytes(&events);
    assert!(bytes <= 600, "an edit crossed as {bytes} bytes");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_reaction_costs_the_reactions_it_changed() {
    let (harness, mut replica) = live_chat(&[]).await;

    let reacted = changed(
        &chat_message(29, "Long message 29", &[]),
        &json!({ "reactions": [{ "key": "👍", "senders": ["@bob:test.local"] }] }),
    );
    harness
        .app
        .offer(&diff(
            SUB,
            vec![VectorDiff::Set {
                index: 29,
                value: reacted,
            }],
        ))
        .await;
    let events = feed(&harness, &mut replica).await;

    assert_eq!(
        replica.state["items"][29]["item"]["reactions"][0]["key"],
        "👍"
    );
    let bytes = patch_bytes(&events);
    assert!(bytes > 0, "a reaction emitted no patch");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn diffs_of_another_subscription_are_ignored() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    offer(
        &harness,
        &mut replica,
        diff(SubscriptionId(8), vec![VectorDiff::Clear]),
    )
    .await;
    assert_eq!(row_ids(&replica), ["a", "b"]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_filters_decide_which_events_make_rows() {
    let harness = harness();
    harness.backend.expect::<Subscribe>().returns(opened(
        7,
        vec![message("a", 1_000), joined("j", 2_000), message("b", 3_000)],
    ));
    let mut replica = opened_live(&harness).await;
    assert_eq!(row_ids(&replica), ["a", "j", "b"]);

    dispatch(
        &harness,
        configure(&json!({
            "filters": {
                "hide_membership_events": true,
                "hide_profile_changes": true,
                "hide_topic_changes": false,
                "hide_member_in_read_only": false,
                "show_tombstone_events": true,
                "show_hidden_events": false,
                "hidden_event_edits": true,
                "hidden_event_reactions": true,
                "hidden_event_redactions": true,
                "hidden_event_other": true
            }
        })),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(row_ids(&replica), ["a", "b"]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn hidden_event_aggregations_slot_in_by_time_when_shown() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    dispatch(
        &harness,
        configure(&json!({
            "filters": {
                "hide_membership_events": false,
                "hide_profile_changes": true,
                "hide_topic_changes": false,
                "hide_member_in_read_only": false,
                "show_tombstone_events": true,
                "show_hidden_events": true,
                "hidden_event_edits": true,
                "hidden_event_reactions": true,
                "hidden_event_redactions": true,
                "hidden_event_other": true
            }
        })),
    )
    .await;
    offer(
        &harness,
        &mut replica,
        CoreEvent::TimelineAggregations {
            subscription: SUB,
            items: vec![aggregation("agg", 1_500)],
        },
    )
    .await;

    assert_eq!(row_ids(&replica), ["a", "agg", "b"]);
    assert_eq!(replica.state["aggregations"]["total"], 1);

    offer(
        &harness,
        &mut replica,
        CoreEvent::TimelineAggregations {
            subscription: SUB,
            items: vec![aggregation("agg", 1_600)],
        },
    )
    .await;
    assert_eq!(replica.state["aggregations"]["total"], 1);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_unread_marker_goes_before_the_first_unread_message_and_counts_what_follows() {
    let harness = harness();
    harness.backend.expect::<Subscribe>().returns(opened(
        7,
        vec![
            message("a", 1_000),
            read_marker(),
            message("b", 2_000),
            message("c", 3_000),
        ],
    ));
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        &harness,
        json!({
            "type": "open", "target": { "kind": "live" }, "hidden_events": false,
            "unread": false, "has_unread": true, "landing": null
        }),
    )
    .await;
    feed(&harness, &mut replica).await;

    assert_eq!(row_ids(&replica), ["a", "marker", "b", "c"]);
    assert_eq!(replica.state["items"][1]["unread_count"], 2);
    assert_eq!(status(&replica)["unread"]["active"], true);
    assert_eq!(status(&replica)["unread"]["first_event_id"], "$b");
    assert_eq!(status(&replica)["unread"]["count"], 2);
    assert_eq!(status(&replica)["unread"]["blocking"], true);

    dispatch(
        &harness,
        json!({ "type": "observe_unread", "first_visible": "$b" }),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["blocking"], false);

    dispatch(&harness, json!({ "type": "read", "event_id": "$c" })).await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["active"], false);
    assert_eq!(row_ids(&replica), ["a", "marker", "b", "c"]);

    dispatch(&harness, json!({ "type": "clear_unread" })).await;
    feed(&harness, &mut replica).await;
    assert_eq!(row_ids(&replica), ["a", "b", "c"]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_tracker_asks_for_the_read_marker_when_the_timeline_holds_no_boundary() {
    let harness = harness();
    let mut replica = harness.subscribe("timeline", key(), None).await;
    let gate = Gate::default();
    harness
        .backend
        .expect::<ReadMarker>()
        .after(&gate)
        .returns(Some("$a".to_owned()));
    dispatch(
        &harness,
        json!({
            "type": "open", "target": { "kind": "live" }, "hidden_events": false,
            "unread": false, "has_unread": true, "landing": null
        }),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["loading"], true);
    assert_eq!(status(&replica)["unread"]["blocking"], true);

    let req = request(
        &harness,
        json!({ "type": "initialize_unread", "has_unread": true }),
    )
    .await;
    let events = feed(&harness, &mut replica).await;
    assert_eq!(answered(&events, req), None);
    assert_eq!(harness.backend.calls::<ReadMarker>().len(), 1);

    gate.open();
    let events = feed(&harness, &mut replica).await;
    assert_eq!(
        answered(&events, req),
        Some(&Outcome::Ok { value: Value::Null })
    );
    assert_eq!(status(&replica)["unread"]["loading"], false);
    assert_eq!(status(&replica)["unread"]["first_event_id"], "$b");
    assert_eq!(row_ids(&replica), ["a", "unread-marker", "b"]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_read_marker_answer_after_release_is_ignored() {
    let harness = harness();
    let gate = Gate::default();
    harness
        .backend
        .expect::<ReadMarker>()
        .after(&gate)
        .returns(Some("$a".to_owned()));
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        &harness,
        json!({
            "type": "open", "target": { "kind": "live" }, "hidden_events": false,
            "unread": false, "has_unread": true, "landing": null
        }),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["loading"], true);

    dispatch(&harness, json!({ "type": "release" })).await;
    feed(&harness, &mut replica).await;
    gate.open();
    feed(&harness, &mut replica).await;

    assert_eq!(status(&replica)["unread"]["initialized"], false);
    assert_eq!(status(&replica)["unread"]["active"], false);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn opening_the_same_mode_with_a_new_landing_event_reopens_it() {
    let harness = harness();
    harness
        .backend
        .expect::<Subscribe>()
        .answers(|params| match params.focus {
            Focus::Live => Ok(opened(7, vec![message("a", 1_000), message("b", 2_000)])),
            Focus::Event { .. } => Ok(opened(8, vec![message("b", 2_000)])),
            Focus::Thread { .. } => unreachable!(),
        });
    let mut replica = harness.subscribe("timeline", key(), None).await;

    dispatch(&harness, open_live()).await;
    feed(&harness, &mut replica).await;
    dispatch(
        &harness,
        json!({
            "type": "open", "target": { "kind": "live" }, "hidden_events": false,
            "unread": false, "has_unread": false, "landing": "$missing"
        }),
    )
    .await;
    feed(&harness, &mut replica).await;

    assert_eq!(harness.backend.calls::<Subscribe>().len(), 3);
    assert_eq!(status(&replica)["subscription"], 8);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn releasing_the_view_forgets_the_unread_boundary() {
    let harness = harness();
    harness.backend.expect::<Subscribe>().returns(opened(
        7,
        vec![message("a", 1_000), read_marker(), message("b", 2_000)],
    ));
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        &harness,
        json!({
            "type": "open", "target": { "kind": "live" }, "hidden_events": false,
            "unread": false, "has_unread": true, "landing": null
        }),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["active"], true);

    dispatch(&harness, json!({ "type": "release" })).await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["initialized"], false);
    assert_eq!(row_ids(&replica), ["a", "b"]);
}

async fn opened_unread(harness: &TestApp) -> Replica {
    harness.backend.expect::<Subscribe>().returns(opened(
        7,
        vec![
            message("a", 1_000),
            read_marker(),
            message("b", 2_000),
            message("c", 3_000),
        ],
    ));
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        harness,
        json!({
            "type": "open", "target": { "kind": "live" }, "hidden_events": false,
            "unread": false, "has_unread": true, "landing": null
        }),
    )
    .await;
    feed(harness, &mut replica).await;
    replica
}

fn viewing(focused: bool, newest: Option<&str>) -> Value {
    json!({ "type": "viewing", "focused": focused, "newest": newest })
}

async fn arrive(harness: &TestApp, id: &str, timestamp: u64) {
    harness
        .app
        .offer(&diff(
            SUB,
            vec![VectorDiff::PushBack {
                value: message(id, timestamp),
            }],
        ))
        .await;
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn messages_that_arrive_while_the_window_is_in_the_background_start_a_boundary() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    dispatch(
        &harness,
        json!({ "type": "initialize_unread", "has_unread": false }),
    )
    .await;
    dispatch(&harness, viewing(true, None)).await;
    feed(&harness, &mut replica).await;
    arrive(&harness, "c", 3_000).await;
    dispatch(&harness, viewing(false, None)).await;
    feed(&harness, &mut replica).await;

    assert_eq!(status(&replica)["unread"]["first_event_id"], "$c");
    assert_eq!(row_ids(&replica), ["a", "b", "unread-marker", "c"]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_unfocused_window_needs_no_new_report_for_each_arrival() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    dispatch(
        &harness,
        json!({ "type": "initialize_unread", "has_unread": false }),
    )
    .await;
    dispatch(&harness, viewing(false, None)).await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["active"], false);

    arrive(&harness, "c", 3_000).await;
    feed(&harness, &mut replica).await;

    assert_eq!(status(&replica)["unread"]["first_event_id"], "$c");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_focused_window_that_shows_the_newest_row_reaches_the_end_of_the_unread_messages() {
    let harness = harness();
    harness.backend.expect::<Subscribe>().returns(opened(
        7,
        vec![
            message("a", 1_000),
            read_marker(),
            message("b", 2_000),
            message("c", 3_000),
        ],
    ));
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        &harness,
        json!({
            "type": "open", "target": { "kind": "live" }, "hidden_events": false,
            "unread": false, "has_unread": true, "landing": null
        }),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["blocking"], true);

    dispatch(&harness, viewing(false, Some("$c"))).await;
    feed(&harness, &mut replica).await;
    assert_eq!(
        status(&replica)["unread"]["blocking"],
        true,
        "an unfocused window reads nothing"
    );

    dispatch(&harness, viewing(true, Some("$b"))).await;
    feed(&harness, &mut replica).await;
    assert_eq!(
        status(&replica)["unread"]["blocking"],
        true,
        "the newest row is not in view"
    );

    dispatch(&harness, viewing(true, Some("$c"))).await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["blocking"], false);
    assert_eq!(status(&replica)["unread"]["active"], true);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_background_boundary_is_not_reached_by_showing_the_newest_row() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    dispatch(
        &harness,
        json!({ "type": "initialize_unread", "has_unread": false }),
    )
    .await;
    dispatch(&harness, viewing(false, None)).await;
    feed(&harness, &mut replica).await;
    arrive(&harness, "c", 3_000).await;
    feed(&harness, &mut replica).await;

    dispatch(&harness, viewing(true, Some("$c"))).await;
    feed(&harness, &mut replica).await;

    assert_eq!(status(&replica)["unread"]["blocking"], true);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_receipt_sent_for_the_newest_event_dismisses_the_boundary_and_an_older_one_does_not() {
    let harness = harness();
    let mut replica = opened_unread(&harness).await;
    assert_eq!(status(&replica)["unread"]["active"], true);

    dispatch(&harness, json!({ "type": "read", "event_id": "$b" })).await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["active"], true);

    dispatch(&harness, json!({ "type": "read", "event_id": "$c" })).await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["active"], false);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn reading_the_room_elsewhere_dismisses_the_boundary() {
    let harness = harness();
    let mut replica = opened_unread(&harness).await;
    assert_eq!(status(&replica)["unread"]["active"], true);

    dispatch(
        &harness,
        json!({ "type": "room_unread", "has_unread": true }),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["active"], true);

    dispatch(
        &harness,
        json!({ "type": "room_unread", "has_unread": false }),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["active"], false);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn releasing_the_view_forgets_what_the_window_showed() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    dispatch(
        &harness,
        json!({ "type": "initialize_unread", "has_unread": false }),
    )
    .await;
    dispatch(&harness, viewing(false, None)).await;
    dispatch(&harness, json!({ "type": "release" })).await;
    dispatch(&harness, open_live()).await;
    feed(&harness, &mut replica).await;
    arrive(&harness, "c", 3_000).await;
    feed(&harness, &mut replica).await;

    assert_eq!(status(&replica)["unread"]["active"], false);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn paginating_backward_asks_the_core_and_answers_with_whether_the_end_came() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    let gate = Gate::default();
    harness
        .backend
        .expect::<Paginate>()
        .after(&gate)
        .returns(PaginateOk { reached_end: true });

    let req = request(
        &harness,
        json!({ "type": "paginate", "direction": "backward", "count": 20 }),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["backward_pagination"], "loading");

    gate.open();
    let events = feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["backward_pagination"], "end");
    assert_eq!(
        answered(&events, req),
        Some(&Outcome::Ok {
            value: json!({ "reached_end": true })
        })
    );
    let calls = harness.backend.calls::<Paginate>();
    assert_eq!(calls[0].subscription, SUB);
    assert_eq!(calls[0].count, 20);

    let again = request(
        &harness,
        json!({ "type": "paginate", "direction": "backward", "count": 20 }),
    )
    .await;
    let events = feed(&harness, &mut replica).await;
    assert_eq!(harness.backend.calls::<Paginate>().len(), 1);
    assert_eq!(
        answered(&events, again),
        Some(&Outcome::Ok {
            value: json!({ "reached_end": true })
        })
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_pagination_that_fails_sets_the_error_and_rejects_the_request() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    harness
        .backend
        .expect::<Paginate>()
        .fails(|| RpcError::Unavailable);

    let req = request(
        &harness,
        json!({ "type": "paginate", "direction": "backward", "count": 20 }),
    )
    .await;
    let events = feed(&harness, &mut replica).await;

    assert_eq!(status(&replica)["error"], "load_failed");
    assert_eq!(status(&replica)["backward_pagination"], "idle");
    assert!(matches!(
        answered(&events, req),
        Some(Outcome::Error { .. })
    ));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_live_timeline_never_paginates_forward() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    let req = request(
        &harness,
        json!({ "type": "paginate", "direction": "forward", "count": 20 }),
    )
    .await;
    let events = feed(&harness, &mut replica).await;

    assert_eq!(harness.backend.calls::<Paginate>().len(), 0);
    assert_eq!(
        answered(&events, req),
        Some(&Outcome::Ok {
            value: json!({ "reached_end": true })
        })
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn reaching_the_end_of_forward_pagination_updates_reaches_latest() {
    let harness = harness();
    harness
        .backend
        .expect::<Subscribe>()
        .returns(opened(7, vec![message("a", 1_000)]));
    harness
        .backend
        .expect::<Paginate>()
        .returns(PaginateOk { reached_end: true });
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        &harness,
        open(&json!({ "kind": "focused", "event_id": "$a" })),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["reaches_latest"], false);

    request(
        &harness,
        json!({ "type": "paginate", "direction": "forward", "count": 20 }),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["forward_pagination"], "end");
    assert_eq!(status(&replica)["reaches_latest"], true);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_cores_pagination_events_set_the_backward_state_only_when_live() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    offer(
        &harness,
        &mut replica,
        CoreEvent::TimelinePagination {
            subscription: SUB,
            loading: true,
            reached_start: false,
        },
    )
    .await;
    assert_eq!(status(&replica)["backward_pagination"], "loading");
    offer(
        &harness,
        &mut replica,
        CoreEvent::TimelinePagination {
            subscription: SUB,
            loading: false,
            reached_start: true,
        },
    )
    .await;
    assert_eq!(status(&replica)["backward_pagination"], "end");
    offer(
        &harness,
        &mut replica,
        CoreEvent::TimelinePagination {
            subscription: SubscriptionId(9),
            loading: true,
            reached_start: false,
        },
    )
    .await;
    assert_eq!(status(&replica)["backward_pagination"], "end");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn jumping_to_an_event_leaves_the_live_subscription_for_its_context() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    harness
        .backend
        .expect::<Subscribe>()
        .answers(|params| match params.focus {
            Focus::Event { .. } => Ok(opened(8, vec![message("old", 100), message("old2", 200)])),
            _ => Ok(opened(7, vec![message("a", 1_000)])),
        });

    let req = request(
        &harness,
        open(&json!({ "kind": "focused", "event_id": "$old" })),
    )
    .await;
    let events = feed(&harness, &mut replica).await;

    assert_eq!(row_ids(&replica), ["old", "old2"]);
    assert_eq!(status(&replica)["mode"]["kind"], "focused");
    assert_eq!(status(&replica)["subscription"], 8);
    assert_eq!(status(&replica)["forward_pagination"], "idle");
    assert_eq!(status(&replica)["reaches_latest"], false);
    let ended = harness.backend.calls::<Unsubscribe>();
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].subscription, SUB);
    assert_eq!(
        answered(&events, req),
        Some(&Outcome::Ok { value: Value::Null })
    );

    let again = request(
        &harness,
        open(&json!({ "kind": "focused", "event_id": "$old" })),
    )
    .await;
    let events = feed(&harness, &mut replica).await;
    assert_eq!(harness.backend.calls::<Subscribe>().len(), 2);
    assert_eq!(
        answered(&events, again),
        Some(&Outcome::Ok { value: Value::Null })
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_new_subscription_waits_for_the_old_one_to_end() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    let gate = Gate::default();
    harness
        .backend
        .expect::<Unsubscribe>()
        .after(&gate)
        .returns(());

    dispatch(
        &harness,
        open(&json!({ "kind": "focused", "event_id": "$old" })),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(harness.backend.calls::<Subscribe>().len(), 1);
    assert_eq!(row_ids(&replica), Vec::<&str>::new());

    gate.open();
    harness.settle().await;
    feed(&harness, &mut replica).await;
    assert_eq!(harness.backend.calls::<Subscribe>().len(), 2);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn an_unread_open_falls_back_to_live_when_the_context_cannot_be_had() {
    let harness = harness();
    harness
        .backend
        .expect::<Subscribe>()
        .answers(|params| match params.focus {
            Focus::Event { .. } => Err(RpcError::Unavailable),
            _ => Ok(opened(7, vec![message("a", 1_000)])),
        });
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        &harness,
        open(&json!({ "kind": "unread", "event_id": "$gone" })),
    )
    .await;
    feed(&harness, &mut replica).await;

    assert_eq!(harness.backend.calls::<Subscribe>().len(), 2);
    assert_eq!(status(&replica)["mode"]["kind"], "live");
    assert_eq!(row_ids(&replica), ["a"]);
    assert_eq!(status(&replica)["error"], Value::Null);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_landing_event_that_is_not_loaded_opens_its_context() {
    let harness = harness();
    harness
        .backend
        .expect::<Subscribe>()
        .answers(|params| match params.focus {
            Focus::Event { .. } => Ok(opened(8, vec![message("landed", 100)])),
            _ => Ok(opened(7, vec![message("a", 1_000)])),
        });
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        &harness,
        json!({
            "type": "open", "target": { "kind": "live" }, "hidden_events": false,
            "unread": false, "has_unread": false, "landing": "$landed"
        }),
    )
    .await;
    feed(&harness, &mut replica).await;

    assert_eq!(row_ids(&replica), ["landed"]);
    assert_eq!(status(&replica)["mode"]["kind"], "unread");
    assert_eq!(status(&replica)["mode"]["event_id"], "$landed");
    assert_eq!(status(&replica)["unread"]["read_event_id"], "$landed");
    assert_eq!(harness.backend.calls::<Unsubscribe>()[0].subscription, SUB);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_loaded_landing_event_keeps_the_live_timeline() {
    let harness = harness();
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        &harness,
        json!({
            "type": "open", "target": { "kind": "live" }, "hidden_events": false,
            "unread": false, "has_unread": false, "landing": "$a"
        }),
    )
    .await;
    feed(&harness, &mut replica).await;

    assert_eq!(harness.backend.calls::<Subscribe>().len(), 1);
    assert_eq!(status(&replica)["mode"]["kind"], "live");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn opening_at_unread_looks_up_the_read_marker_and_opens_its_context() {
    let harness = harness();
    harness
        .backend
        .expect::<ReadMarker>()
        .returns(Some("$old".to_owned()));
    harness
        .backend
        .expect::<Subscribe>()
        .answers(|params| match params.focus {
            Focus::Event { .. } => Ok(opened(8, vec![message("old", 100), message("new", 200)])),
            _ => Ok(opened(7, vec![message("a", 1_000)])),
        });
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        &harness,
        json!({
            "type": "open", "target": { "kind": "live" }, "hidden_events": false,
            "unread": true, "has_unread": false, "landing": null
        }),
    )
    .await;
    feed(&harness, &mut replica).await;

    assert_eq!(harness.backend.calls::<ReadMarker>().len(), 1);
    assert_eq!(status(&replica)["mode"]["event_id"], "$old");
    assert_eq!(status(&replica)["unread"]["read_event_id"], "$old");
    assert_eq!(row_ids(&replica), ["old", "new"]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_read_marker_in_the_snapshot_needs_no_lookup() {
    let harness = harness();
    harness.backend.expect::<Subscribe>().returns(opened(
        7,
        vec![message("a", 1_000), read_marker(), message("b", 2_000)],
    ));
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        &harness,
        json!({
            "type": "open", "target": { "kind": "live" }, "hidden_events": false,
            "unread": true, "has_unread": false, "landing": null
        }),
    )
    .await;
    feed(&harness, &mut replica).await;

    assert_eq!(harness.backend.calls::<ReadMarker>().len(), 0);
    assert_eq!(status(&replica)["mode"]["kind"], "live");
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn resuming_live_reopens_the_live_timeline_and_answers_when_it_is_back() {
    let harness = harness();
    harness
        .backend
        .expect::<Subscribe>()
        .answers(|params| match params.focus {
            Focus::Event { .. } => Ok(opened(8, vec![message("old", 100)])),
            _ => Ok(opened(9, vec![message("a", 1_000)])),
        });
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        &harness,
        open(&json!({ "kind": "unread", "event_id": "$old" })),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["can_resume_live"], true);

    let req = request(&harness, json!({ "type": "resume_live" })).await;
    let events = feed(&harness, &mut replica).await;

    assert_eq!(status(&replica)["mode"]["kind"], "live");
    assert_eq!(status(&replica)["resuming_live"], false);
    assert_eq!(status(&replica)["subscription"], 9);
    assert_eq!(row_ids(&replica), ["a"]);
    assert_eq!(
        answered(&events, req),
        Some(&Outcome::Ok { value: Value::Null })
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn resuming_live_that_fails_rejects_and_keeps_the_error() {
    let harness = harness();
    harness
        .backend
        .expect::<Subscribe>()
        .answers(|params| match params.focus {
            Focus::Event { .. } => Ok(opened(8, vec![message("old", 100)])),
            _ => Err(RpcError::Unavailable),
        });
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(
        &harness,
        open(&json!({ "kind": "unread", "event_id": "$old" })),
    )
    .await;
    feed(&harness, &mut replica).await;

    let req = request(&harness, json!({ "type": "resume_live" })).await;
    let events = feed(&harness, &mut replica).await;

    assert_eq!(status(&replica)["error"], "load_failed");
    assert_eq!(status(&replica)["resuming_live"], false);
    assert!(matches!(
        answered(&events, req),
        Some(Outcome::Error { .. })
    ));
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn stopping_empties_the_timeline_and_ends_the_subscription() {
    let harness = harness();
    let mut replica = opened_live(&harness).await;
    dispatch(&harness, json!({ "type": "stop" })).await;
    feed(&harness, &mut replica).await;

    assert_eq!(row_ids(&replica), Vec::<&str>::new());
    assert_eq!(status(&replica)["has_snapshot"], false);
    assert_eq!(status(&replica)["subscription"], Value::Null);
    assert_eq!(harness.backend.calls::<Unsubscribe>()[0].subscription, SUB);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn the_core_subscription_ends_when_the_last_view_has_gone() {
    let harness = harness();
    let replica = opened_live(&harness).await;
    harness.app.unsubscribe(replica.sub).await;

    harness.advance(Duration::from_secs(9)).await;
    assert_eq!(harness.backend.calls::<Unsubscribe>().len(), 0);

    harness.advance(Duration::from_secs(2)).await;
    let ended = harness.backend.calls::<Unsubscribe>();
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].subscription, SUB);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn disposing_while_a_subscription_starts_ends_the_subscription_after_it_arrives() {
    let harness = harness();
    let gate = Gate::default();
    harness
        .backend
        .expect::<Subscribe>()
        .after(&gate)
        .returns(opened(7, vec![]));
    let replica = harness.subscribe("timeline", key(), None).await;
    dispatch(&harness, open_live()).await;
    harness.app.unsubscribe(replica.sub).await;
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(10)).await;
    tokio::task::yield_now().await;
    assert!(harness.backend.calls::<Unsubscribe>().is_empty());

    gate.open();
    harness.settle().await;
    assert_eq!(harness.backend.calls::<Unsubscribe>()[0].subscription, SUB);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_view_that_returns_within_the_grace_finds_the_rows_still_there() {
    let harness = harness();
    let first = opened_live(&harness).await;
    harness.app.unsubscribe(first.sub).await;
    harness.advance(Duration::from_secs(2)).await;

    let second = harness.subscribe("timeline", key(), None).await;
    assert_eq!(row_ids(&second), ["a", "b"]);
    assert_eq!(harness.backend.calls::<Subscribe>().len(), 1);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn replies_without_a_preview_ask_the_core_for_their_details_once() {
    let harness = harness();
    let reply = changed(
        &message("r", 2_000),
        &json!({ "in_reply_to": {
            "event_id": "$a", "sender": null, "sender_mentioned": false,
            "sender_name": null, "body": null, "fallback": null
        }}),
    );
    harness
        .backend
        .expect::<Subscribe>()
        .returns(opened(7, vec![message("a", 1_000), reply]));
    let mut replica = harness.subscribe("timeline", key(), None).await;
    dispatch(&harness, open_live()).await;
    feed(&harness, &mut replica).await;

    let asked = harness.backend.calls::<FetchEventDetails>();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].event_id, "$r");
    assert_eq!(asked[0].room_id, ROOM);

    offer(
        &harness,
        &mut replica,
        diff(
            SUB,
            vec![VectorDiff::PushBack {
                value: message("c", 3_000),
            }],
        ),
    )
    .await;
    assert_eq!(harness.backend.calls::<FetchEventDetails>().len(), 1);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn two_timelines_of_one_room_follow_their_own_subscriptions() {
    let harness = harness();
    let thread_key = json!({ "room_id": ROOM, "view": "thread" });
    harness
        .backend
        .expect::<Subscribe>()
        .answers(|params| match params.focus {
            Focus::Thread { .. } => Ok(opened(8, vec![message("t1", 500)])),
            _ => Ok(opened(7, vec![message("a", 1_000)])),
        });
    let mut room = harness.subscribe("timeline", key(), None).await;
    let mut thread = harness
        .subscribe("timeline", thread_key.clone(), None)
        .await;
    dispatch(&harness, open_live()).await;
    harness
        .app
        .dispatch(
            &Target {
                slice: "timeline".to_owned(),
                key: thread_key.clone(),
            },
            open(&json!({ "kind": "thread", "root_event_id": "$t1" })),
        )
        .await
        .expect("the action is valid");
    follow(&harness, &mut [&mut room, &mut thread]).await;
    assert_eq!(row_ids(&room), ["a"]);
    assert_eq!(row_ids(&thread), ["t1"]);
    assert_eq!(status(&thread)["forward_pagination"], "end");

    harness
        .app
        .offer(&CoreEvent::TimelineDiff {
            subscription: SubscriptionId(8),
            key: Some(serde_json::from_value(thread_key).expect("a timeline key")),
            diffs: vec![VectorDiff::PushBack {
                value: message("t2", 600),
            }],
        })
        .await;
    follow(&harness, &mut [&mut room, &mut thread]).await;
    assert_eq!(row_ids(&room), ["a"]);
    assert_eq!(row_ids(&thread), ["t1", "t2"]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_window_follows_only_the_rows_it_names() {
    let harness = harness();
    harness.backend.expect::<Subscribe>().returns(opened(
        7,
        (0..10)
            .map(|index| message(&format!("m{index}"), 1_000 + index * 200_000))
            .collect(),
    ));
    let mut full = harness.subscribe("timeline", key(), None).await;
    assert!(full.state.get("events").is_none());
    let mut replica = harness
        .subscribe("timeline", key(), Some(Window { start: 2, end: 5 }))
        .await;
    dispatch(&harness, open_live()).await;
    follow(&harness, &mut [&mut full, &mut replica]).await;

    assert_eq!(row_ids(&replica), ["m2", "m3", "m4"]);
    assert_eq!(replica.state["total"], 10);
    assert_eq!(
        replica.state["events"]["items"].as_array().unwrap().len(),
        10
    );
    assert_eq!(full.state["items"].as_array().unwrap().len(), 10);
    assert!(full.state.get("events").is_none());
}

fn item_for(index: u8) -> TimelineItemView {
    message(&format!("m{index}"), 1_000 + u64::from(index) * 60_000)
}

fn fixed(make: fn() -> Step) -> impl Strategy<Value = Step> {
    Just(()).prop_map(move |()| make())
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        (0..8_u8).prop_map(|index| Step::Core(CoreEvent::TimelineDiff {
            subscription: SUB,
            key: None,
            diffs: vec![VectorDiff::PushBack {
                value: item_for(index)
            }],
        })),
        (0..8_u8).prop_map(|index| Step::Core(CoreEvent::TimelineDiff {
            subscription: SUB,
            key: None,
            diffs: vec![VectorDiff::PushFront {
                value: item_for(index + 10)
            }],
        })),
        fixed(|| Step::Core(CoreEvent::TimelineDiff {
            subscription: SUB,
            key: None,
            diffs: vec![VectorDiff::PopBack],
        })),
        fixed(|| Step::Core(CoreEvent::TimelineDiff {
            subscription: SUB,
            key: None,
            diffs: vec![VectorDiff::Clear],
        })),
        (0..8_u8).prop_map(|index| Step::Core(CoreEvent::TimelineDiff {
            subscription: SUB,
            key: None,
            diffs: vec![VectorDiff::Reset {
                values: vec![item_for(index), item_for(index + 1)].into()
            }],
        })),
        (0..8_u8).prop_map(|index| Step::Core(CoreEvent::TimelineAggregations {
            subscription: SUB,
            items: vec![aggregation(
                &format!("agg{index}"),
                1_000 + u64::from(index) * 70_000
            )],
        })),
        fixed(|| Step::Action(configure(&json!({
            "filters": {
                "hide_membership_events": false,
                "hide_profile_changes": true,
                "hide_topic_changes": false,
                "hide_member_in_read_only": false,
                "show_tombstone_events": true,
                "show_hidden_events": true,
                "hidden_event_edits": true,
                "hidden_event_reactions": true,
                "hidden_event_redactions": true,
                "hidden_event_other": true
            }
        })))),
        fixed(|| Step::Action(json!({ "type": "stop" }))),
        fixed(|| Step::Action(json!({ "type": "release" }))),
        fixed(|| Step::Action(json!({ "type": "initialize_unread", "has_unread": true }))),
        fixed(|| Step::Action(json!({ "type": "observe_unread", "first_visible": "$m3" }))),
        fixed(|| Step::Action(viewing(false, None))),
        fixed(|| Step::Action(viewing(true, Some("$m3")))),
        fixed(|| Step::Action(viewing(true, Some("$b")))),
        fixed(|| Step::Action(json!({ "type": "read", "event_id": "$b" }))),
        fixed(|| Step::Action(json!({ "type": "room_unread", "has_unread": false }))),
        fixed(|| Step::Action(json!({ "type": "room_unread", "has_unread": true }))),
        fixed(|| Step::Action(json!({ "type": "clear_unread" }))),
        fixed(|| Step::Action(open_live())),
    ]
}

proptest! {
    #[test]
    fn patches_converge_to_a_fresh_snapshot(
        windowed in any::<bool>(),
        steps in proptest::collection::vec(proptest::collection::vec(step(), 1..4), 1..10),
    ) {
        let window = windowed.then_some(Window { start: 1, end: 4 });
        let mut steps = steps;
        steps.insert(0, vec![Step::Action(open_live())]);
        tokio::runtime::Builder::new_current_thread()
            .start_paused(true)
            .enable_time()
            .build()
            .unwrap()
            .block_on(assert_patches_converge::<Timeline>(
                |backend| {
                    backend
                        .expect::<Subscribe>()
                        .returns(opened(7, vec![message("a", 1_000), message("b", 2_000)]));
                    backend.expect::<Unsubscribe>().returns(());
                    backend.expect::<FetchEventDetails>().returns(());
                    backend.expect::<ReadMarker>().returns(Some("$m1".to_owned()));
                },
                key(),
                window,
                &steps,
            ));
    }
}

const FOLLOWING: usize = 4_294_967_295;

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_window_with_no_end_takes_the_rows_that_arrive() {
    let harness = harness();
    harness.backend.expect::<Subscribe>().returns(opened(
        7,
        (0..10)
            .map(|index| message(&format!("m{index}"), 1_000 + index * 200_000))
            .collect(),
    ));
    let mut replica = harness
        .subscribe(
            "timeline",
            key(),
            Some(Window {
                start: 8,
                end: FOLLOWING,
            }),
        )
        .await;
    dispatch(&harness, open_live()).await;
    feed(&harness, &mut replica).await;
    assert_eq!(row_ids(&replica), ["m8", "m9"]);
    assert_eq!(replica.state["total"], 10);

    harness
        .app
        .offer(&diff(
            SUB,
            vec![VectorDiff::PushBack {
                value: message("m10", 3_000_000),
            }],
        ))
        .await;
    feed(&harness, &mut replica).await;
    assert_eq!(row_ids(&replica), ["m8", "m9", "m10"]);
    assert_eq!(replica.state["total"], 11);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_window_past_the_rows_holds_none_until_it_moves() {
    let harness = harness();
    let mut replica = harness
        .subscribe(
            "timeline",
            key(),
            Some(Window {
                start: FOLLOWING - 1,
                end: FOLLOWING,
            }),
        )
        .await;
    dispatch(&harness, open_live()).await;
    feed(&harness, &mut replica).await;
    assert_eq!(row_ids(&replica), Vec::<&str>::new());
    assert_eq!(replica.state["total"], 2);

    let moved = harness
        .app
        .range(
            replica.sub,
            Some(Window {
                start: 1,
                end: FOLLOWING,
            }),
        )
        .await
        .expect("the subscription is live");
    replica.reset(&moved);
    assert_eq!(row_ids(&replica), ["b"]);
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn reading_at_latest_can_keep_the_unread_jump_after_the_room_is_marked_read() {
    let harness = harness();
    let mut replica = opened_unread(&harness).await;
    dispatch(&harness, viewing(true, Some("$c"))).await;
    dispatch(
        &harness,
        json!({
            "type": "room_unread", "has_unread": false, "keep_boundary": true
        }),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["active"], true);
    assert_eq!(status(&replica)["unread"]["blocking"], false);
    assert_eq!(status(&replica)["unread"]["first_event_id"], "$b");

    dispatch(
        &harness,
        json!({
            "type": "room_unread", "has_unread": false, "keep_boundary": false
        }),
    )
    .await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["active"], true);

    dispatch(&harness, json!({ "type": "read", "event_id": "$c" })).await;
    feed(&harness, &mut replica).await;
    assert_eq!(status(&replica)["unread"]["active"], false);
}
