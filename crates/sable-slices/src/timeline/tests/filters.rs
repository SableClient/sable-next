//! Comparison cases from the removed JavaScript filtering helpers.

use super::{defaults, item, join, read_marker, rows, shared, text, with};
use crate::timeline::view::{Shared, TimelineFiltersView};
use sable_protocol::TimelineItemView;
use serde_json::{Value, json};

fn filters() -> TimelineFiltersView {
    TimelineFiltersView {
        hide_member_in_read_only: true,
        show_tombstone_events: false,
        ..defaults()
    }
}

fn names(items: &[Shared]) -> Vec<&str> {
    items.iter().map(|item| item.id.as_str()).collect()
}

fn visible(
    items: Vec<TimelineItemView>,
    filters: TimelineFiltersView,
    read_only: bool,
) -> Vec<Shared> {
    rows::visible_timeline_items(&shared(items), &filters, read_only)
}

fn rename() -> TimelineItemView {
    item(
        json!({"kind":"profile_change", "user_id":"@a:x", "display_name":{"old":"A", "new":"B"}, "avatar":null}),
        "rename",
    )
}

fn state(event_type: &str, change: &Value) -> TimelineItemView {
    item(
        json!({"kind":"state_event", "event_type":event_type, "state_key":"", "content":{}, "prev_content":null, "change":change}),
        event_type,
    )
}

fn divider() -> TimelineItemView {
    with(
        &item(json!({"kind":"date_divider", "timestamp":0}), "day"),
        &json!({"event_id":null}),
    )
}

#[test]
fn visibility_switches_are_independent_and_read_only_members_can_be_shown() {
    let items = vec![
        join("join"),
        rename(),
        state("m.room.topic", &Value::Null),
        text("message"),
    ];
    assert_eq!(
        names(&visible(items.clone(), filters(), false)),
        ["join", "message"]
    );
    let shown = visible(
        items,
        TimelineFiltersView {
            hide_membership_events: true,
            hide_profile_changes: false,
            show_hidden_events: true,
            ..filters()
        },
        false,
    );
    assert_eq!(names(&shown), ["rename", "m.room.topic", "message"]);
    for read_only in [false, true] {
        for hide_member_in_read_only in [false, true] {
            let shown = visible(
                vec![join("join"), rename(), text("message")],
                TimelineFiltersView {
                    hide_profile_changes: false,
                    hide_member_in_read_only,
                    ..filters()
                },
                read_only,
            );
            assert_eq!(
                names(&shown),
                if read_only && hide_member_in_read_only {
                    vec!["message"]
                } else {
                    vec!["join", "rename", "message"]
                }
            );
        }
    }
}

#[test]
fn every_raw_state_type_requires_both_hidden_switches() {
    for event_type in [
        "m.room.topic",
        "m.room.server_acl",
        "com.example.custom_state",
        "m.room.power_levels",
    ] {
        for show_hidden_events in [false, true] {
            for hidden_event_other in [false, true] {
                let shown = visible(
                    vec![state(event_type, &Value::Null), text("message")],
                    TimelineFiltersView {
                        show_hidden_events,
                        hidden_event_other,
                        ..filters()
                    },
                    false,
                );
                assert_eq!(
                    names(&shown),
                    if show_hidden_events && hidden_event_other {
                        vec![event_type, "message"]
                    } else {
                        vec!["message"]
                    }
                );
            }
        }
    }
}

#[test]
fn described_changes_stay_visible_and_only_topic_changes_obey_the_topic_switch() {
    let changes = vec![
        state(
            "m.room.name",
            &json!({"kind":"room_name", "name":"Lobby", "previous":null}),
        ),
        state("m.room.topic", &json!({"kind":"room_topic", "topic":"hi"})),
        state(
            "m.room.avatar",
            &json!({"kind":"room_avatar", "removed":true}),
        ),
        state(
            "m.room.pinned_events",
            &json!({"kind":"pinned_events", "added":["$pin"], "removed":[], "total":1}),
        ),
        state(
            "org.matrix.msc3401.call.member",
            &json!({"kind":"call_membership", "joined":true}),
        ),
    ];
    for show_hidden_events in [false, true] {
        for hide_topic_changes in [false, true] {
            let shown = visible(
                changes.clone(),
                TimelineFiltersView {
                    hide_topic_changes,
                    show_hidden_events,
                    hidden_event_other: false,
                    ..filters()
                },
                false,
            );
            let expected: Vec<_> = changes
                .iter()
                .filter(|item| !hide_topic_changes || item.id != "m.room.topic")
                .map(|item| item.id.as_str())
                .collect();
            assert_eq!(names(&shown), expected);
        }
    }
}

#[test]
fn tombstones_and_unclassified_membership_obey_their_switches() {
    let deleted = item(json!({"kind":"redacted", "reason":null}), "deleted");
    assert_eq!(
        visible(vec![deleted.clone()], filters(), false),
        Vec::<Shared>::new()
    );
    assert_eq!(
        names(&visible(
            vec![deleted],
            TimelineFiltersView {
                show_tombstone_events: true,
                ..filters()
            },
            false
        )),
        ["deleted"]
    );
    let other = item(
        json!({"kind":"membership", "user_id":"@a:x", "change":"other", "display_name":null, "reason":null}),
        "other",
    );
    for show_hidden_events in [false, true] {
        for hide_membership_events in [false, true] {
            let shown = visible(
                vec![other.clone(), text("message")],
                TimelineFiltersView {
                    hide_membership_events,
                    show_hidden_events,
                    ..filters()
                },
                false,
            );
            assert_eq!(
                names(&shown),
                if show_hidden_events && !hide_membership_events {
                    vec!["other", "message"]
                } else {
                    vec!["message"]
                }
            );
        }
    }
}

#[test]
fn receipt_merging_preserves_existing_readers_and_drops_hidden_prefix_receipts() {
    let hidden = with(
        &rename(),
        &json!({"read_by":["@carol:x"], "read_timestamps":{"@carol:x":7}}),
    );
    let first = with(
        &text("first"),
        &json!({"read_by":["@bob:x"], "read_timestamps":{"@bob:x":5}}),
    );
    let shown = visible(vec![first, hidden.clone()], filters(), false);
    let holder = shown.first().unwrap();
    assert_eq!(
        holder
            .read_by
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        ["@bob:x", "@carol:x"]
    );
    assert_eq!(holder.read_timestamps.get("@bob:x"), Some(&5));
    assert_eq!(holder.read_timestamps.get("@carol:x"), Some(&7));
    let shown = visible(vec![hidden, text("message")], filters(), false);
    assert!(shown.first().is_some_and(|item| item.read_by.is_empty()));
    assert!(shown.first().unwrap().read_timestamps.is_empty());
}

#[test]
fn duplicate_events_preserve_the_first_receipt_data() {
    let first = with(&text("first"), &json!({"read_by":["@bob:x"]}));
    let duplicate = with(&text("duplicate"), &json!({"event_id":"$first"}));
    let shown = visible(vec![first, text("next"), duplicate], filters(), false);
    assert_eq!(names(&shown), ["first", "next"]);
    assert_eq!(
        shown
            .first()
            .unwrap()
            .read_by
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        ["@bob:x"]
    );
}

#[test]
fn dividers_and_markers_follow_the_remaining_unread_messages() {
    let cases = [
        (
            vec![divider(), rename(), divider(), text("message")],
            vec!["day", "message"],
        ),
        (vec![divider(), rename()], vec![]),
        (vec![text("message"), read_marker()], vec!["message"]),
        (
            vec![read_marker(), text("message"), read_marker()],
            vec!["marker", "message"],
        ),
        (
            vec![read_marker(), divider(), text("message")],
            vec!["marker", "day", "message"],
        ),
        (
            vec![divider(), read_marker(), text("message")],
            vec!["day", "marker", "message"],
        ),
        (
            vec![
                text("message"),
                read_marker(),
                with(&text("own"), &json!({"is_own":true})),
            ],
            vec!["message", "own"],
        ),
        (
            vec![
                text("message"),
                read_marker(),
                state(
                    "m.room.name",
                    &json!({"kind":"room_name", "name":"Lobby", "previous":null}),
                ),
            ],
            vec!["message", "m.room.name"],
        ),
    ];
    for (items, expected) in cases {
        assert_eq!(names(&visible(items, filters(), false)), expected);
    }
}

#[test]
fn aggregation_types_have_independent_filters() {
    let entries = shared(["m.reaction", "m.room.redaction", "m.room.message", "m.beacon"].map(|event_type| item(json!({"kind":"hidden_event", "event_type":event_type, "content":null, "redacts":null}), event_type)).to_vec());
    assert_eq!(
        rows::visible_aggregations(&entries, &filters()),
        Vec::<Shared>::new()
    );
    let on = TimelineFiltersView {
        show_hidden_events: true,
        ..filters()
    };
    assert_eq!(rows::visible_aggregations(&entries, &on).len(), 4);
    let cases = [
        (
            TimelineFiltersView {
                hidden_event_reactions: false,
                ..on
            },
            vec!["m.room.redaction", "m.room.message", "m.beacon"],
        ),
        (
            TimelineFiltersView {
                hidden_event_redactions: false,
                ..on
            },
            vec!["m.reaction", "m.room.message", "m.beacon"],
        ),
        (
            TimelineFiltersView {
                hidden_event_edits: false,
                ..on
            },
            vec!["m.reaction", "m.room.redaction", "m.beacon"],
        ),
        (
            TimelineFiltersView {
                hidden_event_other: false,
                ..on
            },
            vec!["m.reaction", "m.room.redaction", "m.room.message"],
        ),
        (
            TimelineFiltersView {
                hidden_event_reactions: false,
                hidden_event_other: false,
                ..on
            },
            vec!["m.room.redaction", "m.room.message"],
        ),
        (
            TimelineFiltersView {
                hidden_event_edits: false,
                hidden_event_redactions: false,
                ..on
            },
            vec!["m.reaction", "m.beacon"],
        ),
    ];
    for (filters, expected) in cases {
        assert_eq!(
            names(&rows::visible_aggregations(&entries, &filters)),
            expected
        );
    }
}

#[test]
fn live_location_messages_count_as_unread_and_marker_moves_preserve_its_identity() {
    let location = item(
        json!({"kind":"live_location", "body":"here", "latitude":null, "longitude":null, "live":true, "expires_at":10000, "updated_at":null}),
        "share",
    );
    assert_eq!(
        rows::unread_count_from(&shared(vec![read_marker(), location]), 1),
        1
    );
    let items = shared(vec![read_marker(), text("first"), text("last")]);
    assert_eq!(
        names(&rows::with_read_marker_before(&items, "$last")),
        ["first", "marker", "last"]
    );
    assert_eq!(
        names(&rows::with_read_marker_before(&items, "$missing")),
        ["first", "last"]
    );
}

fn aggregate(id: &str, timestamp: u64) -> TimelineItemView {
    with(
        &item(
            json!({"kind":"hidden_event", "event_type":"m.reaction", "content":null, "redacts":null}),
            id,
        ),
        &json!({"timestamp":timestamp}),
    )
}

#[test]
fn aggregation_merge_preserves_known_items_and_loaded_range_edges() {
    let first = with(&text("first"), &json!({"timestamp":10}));
    let last = with(&text("last"), &json!({"timestamp":20}));
    let items = shared(vec![first.clone(), last]);
    let aggregations = shared(vec![
        aggregate("newer", 25),
        aggregate("inside", 15),
        aggregate("older", 5),
    ]);
    let cases = [
        (false, false, vec!["first", "inside", "last"]),
        (false, true, vec!["first", "inside", "last", "newer"]),
        (true, false, vec!["older", "first", "inside", "last"]),
        (
            true,
            true,
            vec!["older", "first", "inside", "last", "newer"],
        ),
    ];
    for (start, end, expected) in cases {
        assert_eq!(
            names(&rows::merge_aggregations(
                &items,
                &aggregations,
                start,
                end,
                0
            )),
            expected
        );
    }
    assert_eq!(
        rows::merge_aggregations(&[], &aggregations, false, true, 0),
        Vec::<Shared>::new()
    );
    assert_eq!(
        names(&rows::merge_aggregations(&items, &[], true, true, 0)),
        ["first", "last"]
    );
    let known = shared(vec![first, aggregate("known", 9)]);
    assert_eq!(
        names(&rows::merge_aggregations(
            &known,
            &shared(vec![aggregate("known", 9)]),
            true,
            true,
            0
        )),
        ["first", "known"]
    );
}

#[test]
fn aggregation_midnight_belongs_below_its_local_date_divider() {
    const HOUR: u64 = 3_600_000;
    let at = |day: u64, hour: u64| (day * 24 + hour) * HOUR - 2 * HOUR;
    let day = |number| {
        with(
            &item(
                json!({"kind":"date_divider", "timestamp":at(number, 20)}),
                &format!("day-{number}"),
            ),
            &json!({"event_id":null, "timestamp":at(number, 20)}),
        )
    };
    let sent = |id, number, hour| with(&text(id), &json!({"timestamp":at(number, hour)}));
    let items = shared(vec![
        day(6),
        sent("first", 6, 10),
        sent("second", 6, 20),
        day(7),
        sent("third", 7, 20),
    ]);
    let aggregations = shared(vec![
        aggregate("noon", at(6, 12)),
        aggregate("late", at(6, 23)),
        aggregate("midnight", at(7, 0)),
        aggregate("next-noon", at(7, 12)),
    ]);
    let merged = rows::merge_aggregations(&items, &aggregations, false, true, 2 * 3_600_000);
    assert_eq!(
        names(&merged),
        [
            "day-6",
            "first",
            "noon",
            "second",
            "late",
            "day-7",
            "midnight",
            "next-noon",
            "third"
        ]
    );
}
