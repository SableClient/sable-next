use serde_json::json;

use super::*;

fn item(event: &Value) -> CalendarItem {
    read_entry("$e", "@a:x", event).expect("an entry")
}

#[test]
fn durations_round_trip() {
    assert_eq!(parse_duration("PT2H30M"), 150 * MINUTE_MS);
    assert_eq!(parse_duration("P1W"), 7 * MS_PER_DAY);
    assert_eq!(parse_duration("P1H"), 0);
    assert_eq!(format_duration(150 * MINUTE_MS), "PT2H30M");
    assert_eq!(format_duration(MS_PER_DAY), "P1D");
    assert_eq!(format_duration(-5), "PT0S");
}

#[test]
fn an_entry_needs_a_uid_and_a_real_start() {
    assert!(
        read_entry(
            "$e",
            "@a:x",
            &json!({"uid": "u", "start": "2026-02-30T10:00"})
        )
        .is_none()
    );
    assert!(read_entry("$e", "@a:x", &json!({"start": "2026-02-01T10:00"})).is_none());
    assert!(
        read_entry(
            "$e",
            "@a:x",
            &json!({"uid": "u", "start": "0099-02-01T10:00"})
        )
        .is_none()
    );
}

#[test]
fn a_monthly_step_onto_a_missing_day_is_skipped() {
    let event = item(&json!({
        "uid": "u", "start": "2026-01-31T20:00:00",
        "recurrenceRules": [{"frequency": "monthly", "count": 3}]
    }));
    assert_eq!(
        wall_times(&event, "9999"),
        [
            "2026-01-31T20:00:00",
            "2026-03-31T20:00:00",
            "2026-05-31T20:00:00"
        ]
    );
}

#[test]
fn calendar_starts_keep_the_wall_time_grammar() {
    for start in [
        "2026-01-01T00+01",
        "2026-01-01t00:00",
        "2026-01-01 00:00",
        "2026-01-01T00:00Z",
        "2026-01-01T00:00:60",
        "2026-01-01T00:00:00.1",
        "2026-01-01T24:00",
        "0000-01-01T00:00",
    ] {
        assert!(
            read_entry("$e", "@a:x", &json!({"uid": "u", "start": start})).is_none(),
            "{start}"
        );
    }
    for start in ["0100-01-01T00:00", "9999-12-31T23:59:59"] {
        assert_eq!(item(&json!({"uid": "u", "start": start})).start, start);
    }
}

#[test]
fn yearly_leap_days_are_skipped_without_clamping() {
    let event = item(&json!({
        "uid": "u", "start": "2024-02-29T09:00",
        "recurrenceRules": [{"frequency": "yearly", "count": 3}]
    }));
    assert_eq!(
        wall_times(&event, "9999"),
        [
            "2024-02-29T09:00",
            "2028-02-29T09:00:00",
            "2032-02-29T09:00:00"
        ]
    );
}

#[test]
fn daily_wall_times_keep_the_clock_across_a_dst_transition() {
    let event = item(&json!({
        "uid": "u", "start": "2026-03-28T09:00", "timeZone": "Europe/Paris",
        "recurrenceRules": [{"frequency": "daily", "count": 3}]
    }));
    assert_eq!(
        wall_times(&event, "9999"),
        [
            "2026-03-28T09:00",
            "2026-03-29T09:00:00",
            "2026-03-30T09:00:00"
        ]
    );
}

#[test]
fn recurrence_stops_at_the_date_range_and_large_intervals() {
    let event = item(&json!({
        "uid": "u", "start": "9999-12-30T09:00",
        "recurrenceRules": [{"frequency": "daily", "count": 3}]
    }));
    assert_eq!(
        wall_times(&event, "9999-12-31T23:59:59"),
        ["9999-12-30T09:00", "9999-12-31T09:00:00"]
    );
    for frequency in ["daily", "weekly", "monthly", "yearly"] {
        let event = item(&json!({
            "uid": "u", "start": "2026-01-01T09:00",
            "recurrenceRules": [{"frequency": frequency, "interval": u32::MAX, "count": 2}]
        }));
        assert_eq!(
            wall_times(&event, "9999"),
            ["2026-01-01T09:00"],
            "{frequency}"
        );
    }
}

#[test]
fn weekly_days_and_monthly_nth_days_expand() {
    let weekly = item(&json!({
        "uid": "u", "start": "2026-10-01T20:00:00",
        "recurrenceRules": [{"frequency": "weekly", "byDay": [{"day": "mo"}, {"day": "th"}]}]
    }));
    assert_eq!(
        wall_times(&weekly, "2026-10-09"),
        [
            "2026-10-01T20:00:00",
            "2026-10-05T20:00:00",
            "2026-10-08T20:00:00"
        ]
    );
    let last_friday = item(&json!({
        "uid": "u", "start": "2026-01-30T18:00",
        "recurrenceRules": [{"frequency": "monthly", "byDay": [{"day": "fr", "nthOfPeriod": -1}]}]
    }));
    assert_eq!(
        wall_times(&last_friday, "2026-04-01"),
        [
            "2026-01-30T18:00",
            "2026-02-27T18:00:00",
            "2026-03-27T18:00:00"
        ]
    );
}

#[test]
fn monthly_weekdays_preserve_fractional_ordinals_and_skip_missing_fifths() {
    for (nth, january, february) in [
        (0.5, Some(1), Some(5)),
        (-0.5, Some(1), Some(5)),
        (2.75, Some(8), Some(12)),
        (-1.75, Some(29), Some(26)),
        (5.0, Some(29), None),
        (-5.0, Some(1), None),
        (6.0, None, None),
    ] {
        let event = item(&json!({
            "uid": "u", "start": "2026-01-01T09:00",
            "recurrenceRules": [{"frequency": "monthly", "byDay": [{"day": "th", "nthOfPeriod": nth}]}]
        }));
        let rule = event.recurrence.unwrap();
        for (month, expected) in [(1, january), (2, february)] {
            assert_eq!(
                month_days(Date::new(2026, month, 1).unwrap(), &rule),
                expected.into_iter().collect::<Vec<_>>(),
                "month {month}, ordinal {nth}"
            );
        }
    }
}

#[test]
fn rules_expand_weekdays_intervals_nth_days_and_month_ends() {
    let times = |rule: Value, start: &str, count: u32| {
        let mut rule = rule;
        rule["count"] = json!(count);
        wall_times(
            &item(&json!({"uid": "u", "start": start, "recurrenceRules": [rule]})),
            "9999",
        )
        .iter()
        .map(|time| time.chars().take(10).collect::<String>())
        .collect::<Vec<_>>()
    };
    let day = |name: &str| json!({"@type": "NDay", "day": name});
    let nth = |name: &str, nth: i64| json!({"@type": "NDay", "day": name, "nthOfPeriod": nth});

    assert_eq!(
        times(
            json!({"frequency": "weekly", "byDay": [day("mo"), day("we"), day("fr")]}),
            "2026-10-05T18:00:00",
            5
        ),
        [
            "2026-10-05",
            "2026-10-07",
            "2026-10-09",
            "2026-10-12",
            "2026-10-14"
        ]
    );
    assert_eq!(
        times(
            json!({"frequency": "weekly", "byDay": [day("mo")]}),
            "2026-10-07T18:00:00",
            3
        ),
        ["2026-10-07", "2026-10-12", "2026-10-19"]
    );
    assert_eq!(
        times(
            json!({"frequency": "weekly", "interval": 2, "byDay": [day("tu"), day("th")]}),
            "2026-10-06T18:00:00",
            4
        ),
        ["2026-10-06", "2026-10-08", "2026-10-20", "2026-10-22"]
    );
    assert_eq!(
        times(
            json!({"frequency": "monthly", "byDay": [nth("tu", 2)]}),
            "2026-10-13T18:00:00",
            3
        ),
        ["2026-10-13", "2026-11-10", "2026-12-08"]
    );
    assert_eq!(
        times(
            json!({"frequency": "monthly", "byMonthDay": [-1]}),
            "2026-10-31T09:00:00",
            5
        ),
        [
            "2026-10-31",
            "2026-11-30",
            "2026-12-31",
            "2027-01-31",
            "2027-02-28"
        ]
    );
    assert_eq!(
        times(
            json!({"frequency": "yearly", "byMonth": ["3"], "byDay": [nth("su", -1)]}),
            "2026-03-29T09:00:00",
            4
        ),
        ["2026-03-29"]
    );
}

#[test]
fn n_days_read_leniently_and_a_bad_entry_voids_the_list() {
    let days = |value: Value| read_n_days(Some(&value));
    assert_eq!(
        days(
            json!([{"day": "mo", "nthOfPeriod": 0}, {"day": "fr", "nthOfPeriod": -1}, {"day": "su", "nthOfPeriod": "x"}])
        ),
        Some(vec![
            NDay { day: 1, nth: None },
            NDay {
                day: 5,
                nth: Some(-1.0)
            },
            NDay { day: 0, nth: None }
        ])
    );
    assert_eq!(days(json!([{"day": "xx"}])), None);
    assert_eq!(days(json!([{}])), None);
    assert_eq!(days(json!([["mo"]])), None);
    assert_eq!(days(json!("mo")), None);
}

#[test]
fn an_unmodelled_rule_shows_only_its_start() {
    let event = item(&json!({
        "uid": "u", "start": "2026-01-01T10:00",
        "recurrenceRules": [{"frequency": "yearly", "byMonth": [1]}]
    }));
    assert!(!event.recurrence.as_ref().is_some_and(|rule| rule.modelled));
    assert_eq!(wall_times(&event, "9999"), ["2026-01-01T10:00"]);
}

#[test]
fn the_latest_answer_per_sender_counts_for_its_occurrence() {
    let rsvp = |sender: &str, status: &str, recurrence: Option<&str>, timestamp| CalendarRsvpView {
        sender: sender.to_owned(),
        calendar_event_id: "$e".to_owned(),
        uid: "u".to_owned(),
        recurrence_id: recurrence.map(str::to_owned),
        status: status.to_owned(),
        timestamp,
    };
    let rsvps = [
        rsvp("@me:x", "accepted", None, 1),
        rsvp("@me:x", "declined", None, 2),
        rsvp("@bob:x", "tentative", Some("2026-01-08T10:00:00"), 1),
        rsvp("@eve:x", "maybe", None, 3),
    ];
    let tally = tally_rsvps(&rsvps, "u", Some("2026-01-01T10:00:00"), Some("@me:x"));
    assert_eq!((tally.accepted, tally.tentative, tally.declined), (0, 0, 1));
    assert_eq!(tally.mine, Some(RsvpStatusView::Declined));
}

#[test]
fn an_all_day_event_is_floating_whole_days() {
    let draft = EventDraft {
        title: "Trip".to_owned(),
        description: String::new(),
        location: "Lyon".to_owned(),
        start: "2026-04-05T10:07:00".to_owned(),
        duration_ms: 36 * 3_600_000,
        all_day: true,
        frequency: Some(Frequency::Weekly),
        until: Some("2026-06-01".to_owned()),
    };
    let base = json!({"description": "old", "x-kept": 1, "recurrenceRules": [{"frequency": "weekly", "count": 4, "interval": 2}]});
    let event = build_event(
        &draft,
        base.as_object(),
        "u",
        1_700_000_000_123,
        "Europe/Paris",
    );
    assert_eq!(
        Value::Object(event),
        json!({
            "@type": "Event", "uid": "u", "updated": "2023-11-14T22:13:20Z", "title": "Trip",
            "start": "2026-04-05T00:00:00", "timeZone": null, "duration": "P2D",
            "showWithoutTime": true, "x-kept": 1,
            "locations": {"main": {"@type": "Location", "name": "Lyon"}},
            "recurrenceRules": [{"@type": "RecurrenceRule", "frequency": "weekly", "interval": 2, "until": "2026-06-01T23:59:59"}]
        })
    );
}

#[test]
fn recurrence_rule_keeps_foreign_parts_and_the_count_without_an_until() {
    let base = json!({"recurrenceRules": [{"@type": "Old", "frequency": "daily", "count": 4, "until": "x", "byDay": [{"day": "mo"}]}]});
    let rule = recurrence_rule(Frequency::Daily, None, base.as_object());
    assert_eq!(
        serde_json::to_value(rule).unwrap(),
        json!({"@type": "RecurrenceRule", "frequency": "daily", "count": 4, "byDay": [{"day": "mo"}]})
    );
    let other = recurrence_rule(Frequency::Weekly, Some(""), base.as_object());
    assert_eq!(
        serde_json::to_value(other).unwrap(),
        json!({"@type": "RecurrenceRule", "frequency": "weekly"})
    );
}

#[test]
fn wrong_typed_event_fields_read_as_missing() {
    let event = item(&json!({
        "uid": "u", "start": "2026-02-01T10:00:00", "title": 3, "description": ["x"],
        "locations": {"a": "junk", "b": {"name": 7}, "c": {"name": "Later"}},
        "showWithoutTime": "true", "timeZone": 1, "duration": {}
    }));
    assert_eq!(event.title, "");
    assert_eq!(event.description, "");
    assert_eq!(event.location, "");
    assert!(!event.all_day);
    assert_eq!(event.time_zone, None);
    assert_eq!(event.duration_ms, 0);
}

#[test]
fn a_rule_reads_leniently_and_is_unmodelled_only_for_what_it_cannot_expand() {
    let rule = |rule: Value| {
        item(&json!({"uid": "u", "start": "2026-02-01T10:00:00", "recurrenceRules": [rule]}))
            .recurrence
    };
    let weekly = rule(
        json!({"frequency": "weekly", "count": "x", "until": 4, "interval": null, "firstDayOfWeek": "mo", "byMonthDay": [1, "a", 0]}),
    );
    let weekly = weekly.unwrap();
    assert_eq!(weekly.count, None);
    assert_eq!(weekly.until, None);
    assert_eq!(weekly.interval, 1);
    assert_eq!(weekly.first_day_of_week, 1);
    assert_eq!(weekly.by_month_day, [1]);
    assert!(!weekly.modelled);
    assert!(
        rule(json!({"frequency": "daily", "rscale": "gregorian"}))
            .unwrap()
            .modelled
    );
    assert!(
        !rule(json!({"frequency": "daily", "rscale": null}))
            .unwrap()
            .modelled
    );
    assert!(
        !rule(json!({"frequency": "daily", "byHour": [3]}))
            .unwrap()
            .modelled
    );
    assert!(
        !rule(json!({"frequency": "daily", "byDay": "mo"}))
            .unwrap()
            .modelled
    );
    assert!(rule(json!({"frequency": "hourly"})).is_none());
    assert!(rule(json!(["daily"])).is_none());
}
