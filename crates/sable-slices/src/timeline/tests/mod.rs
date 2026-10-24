mod filters;
mod fixtures;
mod unread;

use sable_protocol::TimelineItemView;
use serde_json::json;

use sable_model::timeline::TimelineReplyStyleView;

use self::fixtures::{item, join, read_marker, text, with};
use super::{
    identity::Identity,
    rows::{self, RowsInput},
    view::{Shared, TimelineFiltersView, TimelineRow},
};

fn defaults() -> TimelineFiltersView {
    TimelineFiltersView {
        hide_membership_events: false,
        hide_profile_changes: true,
        hide_topic_changes: false,
        hide_member_in_read_only: false,
        show_tombstone_events: true,
        show_hidden_events: false,
        hidden_event_edits: true,
        hidden_event_reactions: true,
        hidden_event_redactions: true,
        hidden_event_other: true,
    }
}

fn shared(items: Vec<TimelineItemView>) -> Vec<Shared> {
    items.into_iter().map(Shared::new).collect()
}

#[expect(
    clippy::struct_excessive_bools,
    reason = "a test names the switches it turns"
)]
struct Build<'a> {
    filters: TimelineFiltersView,
    aggregations: Vec<Shared>,
    unread: Option<&'a str>,
    hide_marker: bool,
    start_loaded: bool,
    end_loaded: bool,
    read_only: bool,
    reply_style: TimelineReplyStyleView,
}

impl Default for Build<'_> {
    fn default() -> Self {
        Self {
            filters: defaults(),
            aggregations: Vec::new(),
            unread: None,
            hide_marker: false,
            start_loaded: false,
            end_loaded: true,
            read_only: false,
            reply_style: TimelineReplyStyleView::Connected,
        }
    }
}

fn build_with(
    items: Vec<TimelineItemView>,
    setup: &Build<'_>,
    identity: &mut Identity,
) -> Vec<TimelineRow> {
    let items = shared(items);
    let built = rows::build(
        &RowsInput {
            items: &items,
            aggregations: &setup.aggregations,
            filters: &setup.filters,
            reply_style: setup.reply_style,
            read_only: setup.read_only,
            start_loaded: setup.start_loaded,
            end_loaded: setup.end_loaded,
            unread_event_id: setup.unread,
            hide_read_marker: setup.hide_marker,
            thread_root: None,
            utc_offset_ms: 0,
        },
        identity,
    );
    built.rows
}

fn build(items: Vec<TimelineItemView>) -> Vec<TimelineRow> {
    build_with(items, &Build::default(), &mut Identity::default())
}

fn collapsed(rows: &[TimelineRow]) -> Vec<bool> {
    rows.iter().map(|row| row.collapsed).collect()
}

fn ids(rows: &[TimelineRow]) -> Vec<&str> {
    rows.iter().map(|row| row.item.id.as_str()).collect()
}

#[test]
fn collapses_consecutive_messages_from_one_sender() {
    let rows = build(vec![
        text("a"),
        with(&text("b"), &json!({ "timestamp": 2_000 })),
    ]);
    assert_eq!(collapsed(&rows), [false, true]);
}

#[test]
fn an_undecryptable_message_keeps_its_sender_and_avatar_in_a_message_row() {
    let encrypted = with(
        &item(
            json!({ "kind": "unable_to_decrypt", "reason": "unknown", "session_id": null }),
            "encrypted",
        ),
        &json!({ "sender_avatar": "mxc://x/alice" }),
    );
    let rows = build(vec![encrypted]);
    let row = rows.first().expect("the undecryptable message is visible");
    assert_eq!(row.item.row, sable_protocol::TimelineRowKind::Message);
    assert_eq!(
        row.item.sender.as_deref().expect("the sender").as_str(),
        "@alice:x"
    );
    assert_eq!(row.item.sender_name.as_deref(), Some("Alice"));
    assert_eq!(row.item.sender_avatar.as_deref(), Some("mxc://x/alice"));
    assert!(row.reply_target);
}

#[test]
fn starts_a_new_header_after_another_sender_speaks() {
    let rows = build(vec![
        text("a"),
        with(&text("b"), &json!({ "sender": "@bob:x" })),
    ]);
    let starts: Vec<bool> = rows.iter().map(|row| row.group_start).collect();
    assert_eq!(starts, [false, true]);
}

#[test]
fn a_gap_of_two_minutes_starts_a_new_header() {
    let rows = build(vec![
        text("a"),
        with(&text("b"), &json!({ "timestamp": 121_000 })),
    ]);
    assert_eq!(collapsed(&rows), [false, false]);
}

#[test]
fn folds_consecutive_membership_events_into_one_row() {
    let rows = build(vec![join("a"), join("b"), text("c")]);
    assert_eq!(rows.len(), 2);
    let group: Vec<&str> = rows
        .first()
        .and_then(|row| row.group.as_ref())
        .map(|group| group.iter().map(|member| member.item.id.as_str()).collect())
        .unwrap_or_default();
    assert_eq!(group, ["a", "b"]);
    assert_eq!(
        rows.first().map(|row| row.item.id.as_str()),
        Some("b"),
        "the run is keyed on its newest event"
    );
}

#[test]
fn a_run_says_who_did_what() {
    let rows = build(vec![join("a"), join("b")]);
    let segments = rows
        .first()
        .map(|row| serde_json::to_value(&row.segments).unwrap())
        .unwrap();
    assert_eq!(
        segments,
        json!([{
            "category": "joined",
            "users": [
                { "user_id": "@a:x", "name": "a" },
                { "user_id": "@b:x", "name": "b" }
            ]
        }])
    );
}

#[test]
fn places_the_unread_marker_before_the_first_unread_event_and_counts_what_follows() {
    let rows = build_with(
        vec![
            text("a"),
            with(&text("b"), &json!({ "sender": "@bob:x" })),
            text("c"),
        ],
        &Build {
            unread: Some("$b"),
            ..Build::default()
        },
        &mut Identity::default(),
    );
    assert_eq!(ids(&rows), ["a", "unread-marker", "b", "c"]);
    assert_eq!(rows.get(1).map(|row| row.unread_count), Some(2));
}

#[test]
fn keeps_a_keyed_row_stable_when_an_event_arrives_before_it() {
    let mut identity = Identity::default();
    let before = build_with(vec![text("b")], &Build::default(), &mut identity);
    let after = build_with(
        vec![with(&text("a"), &json!({ "sender": "@bob:x" })), text("b")],
        &Build::default(),
        &mut identity,
    );
    assert_eq!(
        before.first().map(|row| row.key.clone()),
        after.get(1).map(|row| row.key.clone())
    );
}

#[test]
fn drops_the_core_read_marker_once_the_reader_has_caught_up() {
    let items = vec![
        text("a"),
        read_marker(),
        with(&text("b"), &json!({ "sender": "@bob:x" })),
    ];
    assert!(ids(&build(items.clone())).contains(&"marker"));
    let hidden = build_with(
        items,
        &Build {
            hide_marker: true,
            ..Build::default()
        },
        &mut Identity::default(),
    );
    assert!(!ids(&hidden).contains(&"marker"));
}

#[test]
fn an_event_the_sdk_left_in_twice_shows_once_where_it_first_appears() {
    let rows = build(vec![
        text("a"),
        with(&text("b"), &json!({ "event_id": "$a", "id": "b" })),
    ]);
    assert_eq!(ids(&rows), ["a"]);
}

#[test]
fn a_receipt_on_a_hidden_event_moves_to_the_last_event_before_it() {
    let hidden = with(
        &item(
            json!({ "kind": "profile_change", "user_id": "@a:x", "display_name": null, "avatar": { "old": null, "new": "mxc://x/y" } }),
            "hidden",
        ),
        &json!({ "read_by": ["@carol:x"], "read_timestamps": { "@carol:x": 9 } }),
    );
    let rows = build(vec![text("a"), hidden]);
    let holder = rows.first().map(|row| &row.item).unwrap();
    assert_eq!(
        holder
            .read_by
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        ["@carol:x"]
    );
    assert_eq!(holder.read_timestamps.get("@carol:x"), Some(&9));
}

#[test]
fn a_row_with_a_receipt_says_who_has_read_that_far() {
    let rows = build(vec![
        with(
            &text("a"),
            &json!({ "read_by": ["@carol:x"], "read_timestamps": { "@carol:x": 5 } }),
        ),
        text("b"),
        with(
            &text("c"),
            &json!({
                "read_by": ["@dave:x", "@eve:x"],
                "read_timestamps": { "@dave:x": 9 }
            }),
        ),
        text("d"),
    ]);
    let readers = |id: &str| -> Option<Vec<&str>> {
        let row = rows.iter().find(|row| row.item.id == id)?;
        let receipts = row.later_receipts.as_ref()?;
        Some(receipts.readers.iter().map(String::as_str).collect())
    };
    assert_eq!(
        readers("c"),
        None,
        "the newest receipt has no later readers"
    );
    assert_eq!(
        readers("a"),
        Some(vec!["@dave:x", "@eve:x"]),
        "those who read later have read this too"
    );
    assert_eq!(readers("b"), None, "a row without a receipt carries none");
    assert_eq!(readers("d"), None);
    let carried = rows
        .iter()
        .find(|row| row.item.id == "a")
        .and_then(|row| row.later_receipts.as_ref())
        .map(|receipts| receipts.timestamps.clone())
        .unwrap_or_default();
    assert_eq!(
        carried.into_iter().collect::<Vec<_>>(),
        [("@dave:x".to_owned(), 9)],
        "a reader without a time has none"
    );
}

#[test]
fn a_date_divider_with_nothing_below_it_is_dropped() {
    let divider = item(json!({ "kind": "date_divider", "timestamp": 0 }), "day");
    let rows = build(vec![text("a"), divider]);
    assert_eq!(ids(&rows), ["a"]);
}

#[test]
fn the_read_marker_shows_only_before_unread_messages() {
    let own = with(&text("own"), &json!({ "is_own": true }));
    let only_own = build(vec![text("a"), read_marker(), own]);
    assert!(!ids(&only_own).contains(&"marker"));
}

#[test]
fn a_persona_message_stays_out_of_the_accounts_collapsed_run() {
    let persona = with(
        &text("b"),
        &json!({ "per_message_profile": { "id": "p", "display_name": "P", "avatar_url": null } }),
    );
    assert_eq!(collapsed(&build(vec![text("a"), persona])), [false, false]);
}

#[test]
fn a_connected_reply_preview_starts_a_new_group() {
    let reply = with(
        &text("b"),
        &json!({ "in_reply_to": {
            "event_id": "$a", "sender": "@alice:x", "sender_mentioned": false,
            "sender_name": "Alice", "body": "a", "fallback": null
        } }),
    );
    let items = vec![text("a"), reply];
    assert_eq!(collapsed(&build(items.clone())), [false, false]);
    let compact = build_with(
        items,
        &Build {
            reply_style: TimelineReplyStyleView::Compact,
            ..Build::default()
        },
        &mut Identity::default(),
    );
    assert_eq!(collapsed(&compact), [false, true]);
}

#[test]
fn consecutive_state_rows_stack_without_a_gap() {
    let name = |id: &str| {
        item(
            json!({ "kind": "state_event", "event_type": "m.room.name", "state_key": "", "content": null, "prev_content": null, "change": { "kind": "room_name", "name": "n", "previous": null } }),
            id,
        )
    };
    let rows = build(vec![name("a"), name("b")]);
    assert_eq!(collapsed(&rows), [false, true]);
}

#[test]
fn hidden_events_are_gated_by_their_switches() {
    let hidden = item(
        json!({ "kind": "state_event", "event_type": "m.room.history_visibility", "state_key": "", "content": null, "prev_content": null, "change": null }),
        "h",
    );
    assert_eq!(ids(&build(vec![text("a"), hidden.clone()])), ["a"]);
    let shown = build_with(
        vec![text("a"), hidden.clone()],
        &Build {
            filters: TimelineFiltersView {
                show_hidden_events: true,
                ..defaults()
            },
            ..Build::default()
        },
        &mut Identity::default(),
    );
    assert_eq!(ids(&shown), ["a", "h"]);
    let other_off = build_with(
        vec![text("a"), hidden],
        &Build {
            filters: TimelineFiltersView {
                show_hidden_events: true,
                hidden_event_other: false,
                ..defaults()
            },
            ..Build::default()
        },
        &mut Identity::default(),
    );
    assert_eq!(ids(&other_off), ["a"]);
}

#[test]
fn member_events_are_dropped_in_a_read_only_room_when_asked() {
    let filters = TimelineFiltersView {
        hide_member_in_read_only: true,
        ..defaults()
    };
    let setup = Build {
        filters,
        read_only: true,
        ..Build::default()
    };
    let rows = build_with(vec![join("a"), text("b")], &setup, &mut Identity::default());
    assert_eq!(ids(&rows), ["b"]);
}

fn aggregation(id: &str, timestamp: u64) -> Shared {
    Shared::new(with(
        &item(
            json!({ "kind": "hidden_event", "event_type": "m.reaction", "content": null, "redacts": null }),
            id,
        ),
        &json!({ "timestamp": timestamp }),
    ))
}

#[test]
fn aggregations_slot_into_the_timeline_by_timestamp() {
    let filters = TimelineFiltersView {
        show_hidden_events: true,
        ..defaults()
    };
    let rows = build_with(
        vec![
            with(&text("a"), &json!({ "timestamp": 10 })),
            with(&text("b"), &json!({ "timestamp": 30 })),
        ],
        &Build {
            filters,
            aggregations: vec![aggregation("agg", 20)],
            start_loaded: true,
            ..Build::default()
        },
        &mut Identity::default(),
    );
    assert_eq!(ids(&rows), ["a", "agg", "b"]);
}

#[test]
fn aggregations_outside_the_loaded_range_are_dropped() {
    let filters = TimelineFiltersView {
        show_hidden_events: true,
        ..defaults()
    };
    let rows = build_with(
        vec![
            with(&text("a"), &json!({ "timestamp": 10 })),
            with(&text("b"), &json!({ "timestamp": 30 })),
        ],
        &Build {
            filters,
            aggregations: vec![aggregation("old", 5), aggregation("new", 40)],
            start_loaded: false,
            end_loaded: false,
            ..Build::default()
        },
        &mut Identity::default(),
    );
    assert_eq!(ids(&rows), ["a", "b"]);
}

#[test]
fn a_date_divider_keeps_earlier_aggregations_above_it() {
    let filters = TimelineFiltersView {
        show_hidden_events: true,
        ..defaults()
    };
    let day = 86_400_000;
    let divider = with(
        &item(json!({ "kind": "date_divider", "timestamp": day }), "day"),
        &json!({ "timestamp": day + 5 }),
    );
    let rows = build_with(
        vec![
            with(&text("a"), &json!({ "timestamp": day - 10 })),
            divider,
            with(&text("b"), &json!({ "timestamp": day + 10 })),
        ],
        &Build {
            filters,
            aggregations: vec![aggregation("late", day - 5)],
            start_loaded: true,
            ..Build::default()
        },
        &mut Identity::default(),
    );
    assert_eq!(ids(&rows), ["a", "late", "day", "b"]);
}

#[test]
fn a_local_echo_keeps_its_key_when_its_event_id_appears() {
    let mut identity = Identity::default();
    let echo = with(
        &text("echo"),
        &json!({ "event_id": null, "transaction_id": "txn" }),
    );
    let sent = with(&text("echo"), &json!({ "transaction_id": null }));
    let first = build_with(vec![echo], &Build::default(), &mut identity);
    let second = build_with(vec![sent], &Build::default(), &mut identity);
    assert_eq!(
        first.first().map(|row| row.key.clone()),
        second.first().map(|row| row.key.clone())
    );
}

#[test]
fn a_boundary_is_keyed_on_the_event_under_it() {
    let divider = with(
        &item(json!({ "kind": "date_divider", "timestamp": 0 }), "day"),
        &json!({ "event_id": null }),
    );
    let rows = build(vec![divider, text("a")]);
    assert_eq!(
        rows.first().map(|row| row.key.as_str()),
        Some("boundary:day:event:$a")
    );
}

#[test]
fn a_repeated_key_is_told_apart() {
    let one = with(
        &text("x"),
        &json!({ "event_id": null, "transaction_id": null }),
    );
    let two = with(
        &text("x"),
        &json!({ "event_id": null, "transaction_id": null }),
    );
    let keys: Vec<String> = build(vec![one, two])
        .iter()
        .map(|row| row.key.clone())
        .collect();
    assert_eq!(keys, ["item:x", "item:x#1"]);
}

#[test]
fn echoes_that_left_the_list_are_forgotten() {
    let mut identity = Identity::default();
    let echo = with(
        &text("echo"),
        &json!({ "event_id": null, "transaction_id": "t" }),
    );
    build_with(vec![echo], &Build::default(), &mut identity);
    build_with(vec![text("other")], &Build::default(), &mut identity);
}

#[test]
fn counts_the_messages_of_others_after_a_point() {
    let items = shared(vec![
        text("a"),
        with(&text("own"), &json!({ "is_own": true })),
        text("b"),
        text("c"),
    ]);
    assert_eq!(rows::unread_count_from(&items, 1), 2);
    assert_eq!(rows::latest_event_id(&items).as_deref(), Some("$c"));
}

#[test]
fn lone_moderated_reacted_and_unconfirmed_membership_events_stay_separate() {
    let banned = item(
        json!({"kind":"membership", "user_id":"@b:x", "change":"banned", "display_name":null, "reason":null}),
        "b",
    );
    let reacted = with(
        &join("c"),
        &json!({"reactions":[{"key":"👍", "senders":["@a:x"]}]}),
    );
    let pending = with(&join("d"), &json!({"event_id":null}));
    let rows = build(vec![join("a"), banned, reacted, pending]);
    assert_eq!(rows.len(), 4);
    assert!(rows.iter().all(|row| row.group.is_none()));
}

#[test]
fn reasons_do_not_prevent_grouping_membership_events() {
    let left = item(
        json!({"kind":"membership", "user_id":"@a:x", "change":"left", "display_name":"A", "reason":"IRC quit"}),
        "a",
    );
    let rows = build(vec![left, join("b")]);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows.first()
            .and_then(|row| row.group.as_ref())
            .map(Vec::len),
        Some(2)
    );
}

#[test]
fn segments_preserve_category_order_and_deduplicate_users_within_each_category() {
    let left = item(
        json!({"kind":"membership", "user_id":"@a:x", "change":"left", "display_name":"A", "reason":null}),
        "left",
    );
    let accepted = item(
        json!({"kind":"membership", "user_id":"@b:x", "change":"invitation_accepted", "display_name":"B", "reason":null}),
        "accepted",
    );
    let group = shared(vec![
        join("a"),
        left,
        accepted,
        with(&join("a"), &json!({"id":"again", "event_id":"$again"})),
    ]);
    assert_eq!(
        serde_json::to_value(rows::segments(&group)).unwrap(),
        json!([
            {"category":"joined", "users":[{"user_id":"@a:x", "name":"a"}, {"user_id":"@b:x", "name":"B"}]},
            {"category":"left", "users":[{"user_id":"@a:x", "name":"A"}]}
        ])
    );
}

#[test]
fn renames_and_invitations_group_with_membership_events_and_keep_the_first_name() {
    let rename = |id: &str, name: &str| {
        with(
            &item(
                json!({"kind":"profile_change", "user_id":"@a:x", "display_name":{"old":"a", "new":name}, "avatar":null}),
                id,
            ),
            &json!({"sender_name":name}),
        )
    };
    let invited = item(
        json!({"kind":"membership", "user_id":"@b:x", "change":"invited", "display_name":"B", "reason":null}),
        "invited",
    );
    let accepted = item(
        json!({"kind":"membership", "user_id":"@b:x", "change":"invitation_accepted", "display_name":"B", "reason":null}),
        "accepted",
    );
    let rows = build_with(
        vec![
            rename("rename-1", "A1"),
            rename("rename-2", "A2"),
            invited,
            accepted,
        ],
        &Build {
            filters: TimelineFiltersView {
                hide_profile_changes: false,
                ..defaults()
            },
            ..Build::default()
        },
        &mut Identity::default(),
    );
    assert_eq!(rows.len(), 1);
    let row = rows.first().unwrap();
    assert_eq!(row.group.as_ref().map(Vec::len), Some(4));
    assert_eq!(
        serde_json::to_value(&row.segments).unwrap(),
        json!([
            {"category":"name", "users":[{"user_id":"@a:x", "name":"A1"}]},
            {"category":"invited", "users":[{"user_id":"@b:x", "name":"B"}]},
            {"category":"joined", "users":[{"user_id":"@b:x", "name":"B"}]}
        ])
    );
}

#[test]
fn reply_navigation_skips_echoes_redactions_annotations_and_hidden_member_targets() {
    let items = vec![
        text("first"),
        join("joined"),
        item(json!({"kind":"redacted", "reason":null}), "redacted"),
        item(json!({"kind":"timeline_start"}), "annotation"),
        text("last"),
        with(&text("echo"), &json!({"event_id":null})),
    ];
    for show_hidden_events in [false, true] {
        let rows = build_with(
            items.clone(),
            &Build {
                filters: TimelineFiltersView {
                    show_hidden_events,
                    ..defaults()
                },
                ..Build::default()
            },
            &mut Identity::default(),
        );
        let targets: Vec<_> = rows
            .iter()
            .filter(|row| row.reply_target)
            .map(|row| row.item.id.as_str())
            .collect();
        assert_eq!(
            targets,
            if show_hidden_events {
                vec!["first", "joined", "last"]
            } else {
                vec!["first", "last"]
            }
        );
    }
}

#[test]
fn folded_members_keep_each_individual_reply_target_in_order() {
    let rows = build_with(
        vec![join("a"), join("b")],
        &Build {
            filters: TimelineFiltersView {
                show_hidden_events: true,
                ..defaults()
            },
            ..Build::default()
        },
        &mut Identity::default(),
    );
    let group = rows.first().unwrap().group.as_ref().unwrap();
    assert_eq!(
        group
            .iter()
            .filter(|member| member.reply_target)
            .map(|member| member.item.id.as_str())
            .collect::<Vec<_>>(),
        ["a", "b"]
    );
}

#[test]
fn reply_targets_follow_read_only_filters_and_do_not_include_aggregations() {
    let rows = build_with(
        vec![text("message"), join("joined")],
        &Build {
            filters: TimelineFiltersView {
                show_hidden_events: true,
                hide_member_in_read_only: true,
                ..defaults()
            },
            read_only: true,
            start_loaded: true,
            aggregations: shared(vec![item(
                json!({"kind":"hidden_event", "event_type":"m.reaction", "content":{"m.relates_to":{"event_id":"$message", "key":"👍"}}, "redacts":null}),
                "reaction",
            )]),
            ..Build::default()
        },
        &mut Identity::default(),
    );
    assert!(rows.iter().any(|row| row.item.id == "reaction"));
    assert_eq!(
        rows.iter()
            .filter(|row| row.reply_target)
            .map(|row| row.item.id.as_str())
            .collect::<Vec<_>>(),
        ["message"]
    );
}
