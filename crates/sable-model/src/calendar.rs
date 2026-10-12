//! Commet calendar events (RFC 8984 `JSCalendar`), expanded as wall-clock times without a time zone database.

use serde::de::{IntoDeserializer, value};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::civil::{MS_PER_DAY, days_from_civil, days_in_month, format_ms, weekday};

const MINUTE_MS: i64 = 60_000;
const MAX_STEPS: u32 = 100_000;
const WEEKDAYS: [&str; 7] = ["su", "mo", "tu", "we", "th", "fr", "sa"];
const UNMODELLED_PARTS: [&str; 7] = [
    "byMonth",
    "byYearDay",
    "byWeekNo",
    "byHour",
    "byMinute",
    "bySecond",
    "bySetPosition",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct NDay {
    /// 0 for Sunday.
    pub day: u8,
    pub nth: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct Recurrence {
    pub frequency: Frequency,
    pub interval: u32,
    pub count: Option<f64>,
    pub until: Option<String>,
    pub by_day: Vec<NDay>,
    #[cfg_attr(feature = "typegen", specta(type = Vec<specta_typescript::Number>))]
    pub by_month_day: Vec<i64>,
    pub first_day_of_week: u8,
    /// False for a rule part this does not expand; only the start is shown.
    pub modelled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct CalendarItem {
    pub event_id: String,
    pub sender: String,
    pub uid: String,
    pub title: String,
    pub description: String,
    pub location: String,
    pub all_day: bool,
    /// Wall-clock `YYYY-MM-DDTHH:MM[:SS]` in `time_zone`, or floating if none.
    pub start: String,
    pub time_zone: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub duration_ms: i64,
    pub recurrence: Option<Recurrence>,
    #[cfg_attr(feature = "typegen", specta(type = std::collections::HashMap<String, specta_typescript::Unknown>))]
    pub raw: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RsvpStatusView {
    Accepted,
    Tentative,
    Declined,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct CalendarRsvpView {
    pub sender: String,
    pub calendar_event_id: String,
    pub uid: String,
    pub recurrence_id: Option<String>,
    pub status: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub timestamp: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RsvpPeople {
    pub accepted: Vec<String>,
    pub tentative: Vec<String>,
    pub declined: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RsvpTally {
    pub accepted: u32,
    pub tentative: u32,
    pub declined: u32,
    pub mine: Option<RsvpStatusView>,
    pub people: RsvpPeople,
}

/// What the event dialog edits, with its start already read as local wall time.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct EventDraft {
    pub title: String,
    pub description: String,
    pub location: String,
    pub start: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub duration_ms: i64,
    pub all_day: bool,
    pub frequency: Option<Frequency>,
    /// A date; the series ends after that day.
    pub until: Option<String>,
}

fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn number_run(text: &str) -> Option<(i64, &str)> {
    let run = text.bytes().take_while(u8::is_ascii_digit).count();
    if run == 0 {
        return None;
    }
    Some((text.get(..run)?.parse().ok()?, text.get(run..)?))
}

/// `P[nW][nD][T[nH][nM][nS]]` in milliseconds, or 0 if it is not one.
#[must_use]
pub fn parse_duration(value: &str) -> i64 {
    fn read(value: &str) -> Option<i64> {
        let mut rest = value.strip_prefix('P')?;
        let mut total_seconds = 0_i64;
        let mut unit = |rest: &mut &str, suffix: char, seconds: i64| -> Option<()> {
            if let Some((amount, after)) = number_run(rest)
                && let Some(after) = after.strip_prefix(suffix)
            {
                total_seconds = total_seconds.checked_add(amount.checked_mul(seconds)?)?;
                *rest = after;
            }
            Some(())
        };
        unit(&mut rest, 'W', 7 * 86_400)?;
        unit(&mut rest, 'D', 86_400)?;
        if let Some(time) = rest.strip_prefix('T') {
            rest = time;
            unit(&mut rest, 'H', 3600)?;
            unit(&mut rest, 'M', 60)?;
            unit(&mut rest, 'S', 1)?;
        }
        rest.is_empty().then_some(total_seconds.checked_mul(1000)?)
    }
    read(value).unwrap_or(0)
}

/// Whole minutes as `P[nD][T[nH][nM]]`, or `PT0S`.
#[must_use]
pub fn format_duration(ms: i64) -> String {
    let minutes = (ms.max(0) + MINUTE_MS / 2) / MINUTE_MS;
    if minutes == 0 {
        return "PT0S".to_owned();
    }
    let (days, hours, rest) = (minutes / 1440, minutes % 1440 / 60, minutes % 60);
    let date = if days > 0 {
        format!("{days}D")
    } else {
        String::new()
    };
    let time = match (hours, rest) {
        (0, 0) => String::new(),
        (0, rest) => format!("T{rest}M"),
        (hours, 0) => format!("T{hours}H"),
        (hours, rest) => format!("T{hours}H{rest}M"),
    };
    format!("P{date}{time}")
}

/// `YYYY-MM-DDTHH:MM[:SS]` as its fields, without checking them.
fn wall_fields(local: &str) -> Option<[i64; 6]> {
    let bytes = local.as_bytes();
    if !matches!(bytes.len(), 16 | 19)
        || [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':')]
            .iter()
            .any(|&(at, byte)| bytes.get(at) != Some(&byte))
        || (bytes.len() == 19 && bytes.get(16) != Some(&b':'))
    {
        return None;
    }
    let field = |at: usize, len: usize| -> Option<i64> {
        let run = local.get(at..at + len)?;
        run.bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| run.parse().ok())?
    };
    let second = if bytes.len() == 19 { field(17, 2)? } else { 0 };
    Some([
        field(0, 4)?,
        field(5, 2)?,
        field(8, 2)?,
        field(11, 2)?,
        field(14, 2)?,
        second,
    ])
}

/// A date the calendar can place, from year 100 on.
fn is_real_date_time(local: &str) -> bool {
    wall_fields(local).is_some_and(|[year, month, day, hour, minute, second]| {
        year >= 100
            && (1..=12).contains(&month)
            && day >= 1
            && day <= days_in_month(year, month)
            && hour <= 23
            && minute <= 59
            && second <= 59
    })
}

const fn wall_ms([year, month, day, hour, minute, second]: [i64; 6]) -> i64 {
    days_from_civil(year, month, day) * MS_PER_DAY + ((hour * 60 + minute) * 60 + second) * 1000
}

fn weekday_index(value: Option<&Value>) -> Option<u8> {
    let name = value?.as_str()?;
    WEEKDAYS
        .iter()
        .position(|day| *day == name)
        .and_then(|day| u8::try_from(day).ok())
}

fn read_n_days(value: Option<&Value>) -> Option<Vec<NDay>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    value
        .as_array()?
        .iter()
        .map(|entry| {
            let entry = entry.as_object()?;
            Some(NDay {
                day: weekday_index(entry.get("day"))?,
                nth: entry
                    .get("nthOfPeriod")
                    .and_then(Value::as_f64)
                    .filter(|nth| *nth != 0.0),
            })
        })
        .collect()
}

/// `Number.isInteger`; anything past a month's length stays past it.
#[expect(
    clippy::cast_possible_truncation,
    reason = "a whole f64 clamped well inside the i64 range converts exactly"
)]
fn whole(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0).then_some(number.clamp(-1.0e15, 1.0e15) as i64)
}

/// A positive whole interval; any other is not expanded.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "checked to be a whole number inside the u32 range"
)]
fn whole_interval(value: Option<&Value>) -> Option<u32> {
    let Some(interval) = value
        .and_then(Value::as_f64)
        .filter(|interval| *interval > 0.0)
    else {
        return Some(1);
    };
    (interval.fract() == 0.0 && interval <= f64::from(u32::MAX)).then_some(interval as u32)
}

fn read_recurrence(value: Option<&Value>) -> Option<Recurrence> {
    let rule = value?.as_array()?.first()?.as_object()?;
    let frequency = match rule.get("frequency")?.as_str()? {
        "daily" => Frequency::Daily,
        "weekly" => Frequency::Weekly,
        "monthly" => Frequency::Monthly,
        "yearly" => Frequency::Yearly,
        _ => return None,
    };
    let by_day = read_n_days(rule.get("byDay"));
    let by_month_day: Vec<i64> = rule
        .get("byMonthDay")
        .and_then(Value::as_array)
        .map(|days| {
            days.iter()
                .filter_map(whole)
                .filter(|day| *day != 0)
                .collect()
        })
        .unwrap_or_default();
    let interval = whole_interval(rule.get("interval"));
    let gregorian = rule.get("rscale").is_none_or(|rscale| {
        rscale
            .as_str()
            .is_some_and(|rscale| rscale.eq_ignore_ascii_case("gregorian"))
    });
    let unmodelled = UNMODELLED_PARTS.iter().any(|part| {
        rule.get(*part)
            .and_then(Value::as_array)
            .is_some_and(|values| !values.is_empty())
    });
    let modelled = by_day.as_ref().is_some_and(|by_day| {
        by_day.is_empty()
            || frequency == Frequency::Monthly
            || (frequency == Frequency::Weekly && by_day.iter().all(|day| day.nth.is_none()))
    }) && interval.is_some()
        && gregorian
        && !unmodelled
        && (by_month_day.is_empty() || frequency == Frequency::Monthly);
    Some(Recurrence {
        frequency,
        interval: interval.unwrap_or(1),
        count: rule.get("count").and_then(Value::as_f64),
        until: rule.get("until").and_then(Value::as_str).map(str::to_owned),
        by_day: by_day.unwrap_or_default(),
        by_month_day,
        first_day_of_week: weekday_index(rule.get("firstDayOfWeek")).unwrap_or(1),
        modelled,
    })
}

fn first_location_name(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_object)
        .and_then(|locations| locations.values().find_map(Value::as_object))
        .map(|location| text(location.get("name")))
        .unwrap_or_default()
}

/// `None` for an event without a uid or a start that is a real date.
#[must_use]
pub fn read_entry(event_id: &str, sender: &str, event: &Value) -> Option<CalendarItem> {
    let event = event.as_object()?;
    let uid = text(event.get("uid"));
    let start = text(event.get("start"));
    if uid.is_empty() || !is_real_date_time(&start) {
        return None;
    }
    Some(CalendarItem {
        event_id: event_id.to_owned(),
        sender: sender.to_owned(),
        uid,
        title: text(event.get("title")),
        description: text(event.get("description")),
        location: first_location_name(event.get("locations")),
        all_day: event.get("showWithoutTime") == Some(&Value::Bool(true)),
        start,
        time_zone: event
            .get("timeZone")
            .and_then(Value::as_str)
            .map(str::to_owned),
        duration_ms: event
            .get("duration")
            .and_then(Value::as_str)
            .map_or(0, parse_duration),
        recurrence: read_recurrence(event.get("recurrenceRules")),
        raw: event.clone(),
    })
}

/// Array `at` on the weeks of a month a weekday falls in.
fn nth_match(matches: &[i64], nth: f64) -> Option<i64> {
    let index = if nth > 0.0 { nth - 1.0 } else { nth }.trunc();
    if !index.is_finite() || index.abs() > 64.0 {
        return None;
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a whole number of at most 64 converts exactly"
    )]
    let index = index as i64;
    let at = if index >= 0 {
        index
    } else {
        i64::try_from(matches.len()).ok()? + index
    };
    matches.get(usize::try_from(at).ok()?).copied()
}

fn month_days(year: i64, month: i64, rule: &Recurrence) -> Vec<i64> {
    let length = days_in_month(year, month);
    let mut days: Vec<i64> = rule
        .by_month_day
        .iter()
        .map(|&day| if day > 0 { day } else { length + day + 1 })
        .filter(|date| (1..=length).contains(date))
        .collect();
    let first_weekday = weekday(days_from_civil(year, month, 1));
    for n_day in &rule.by_day {
        let first = (i64::from(n_day.day) - first_weekday + 7) % 7 + 1;
        let matches: Vec<i64> = (first..=length).step_by(7).collect();
        match n_day.nth {
            None => days.extend(matches),
            Some(nth) => days.extend(nth_match(&matches, nth)),
        }
    }
    days.sort_unstable();
    days.dedup();
    days
}

/// Wall-clock starts of `item` up to `before` (exclusive) and the rule's `count`; an unmodelled rule yields only the start.
#[must_use]
pub fn wall_times(item: &CalendarItem, before: &str) -> Vec<String> {
    let limit = item
        .recurrence
        .as_ref()
        .map_or(Some(1.0), |rule| rule.count);
    let full = |found: &Vec<String>| {
        limit
            .is_some_and(|limit| f64::from(u32::try_from(found.len()).unwrap_or(u32::MAX)) >= limit)
    };
    let mut found = Vec::new();
    if full(&found) {
        return found;
    }
    found.push(item.start.clone());
    let Some(rule) = item.recurrence.as_ref().filter(|rule| rule.modelled) else {
        return found;
    };
    let Some(fields) = wall_fields(&item.start) else {
        return found;
    };
    let [year, month, day, hour, minute, second] = fields;
    let first = wall_ms(fields);
    let clock = ((hour * 60 + minute) * 60 + second) * 1000;
    let interval = i64::from(rule.interval);
    let push = |found: &mut Vec<String>, at: i64| -> bool {
        if at <= first {
            return true;
        }
        let local = format_ms(at);
        if local.len() != 19 || local.as_str() >= before || full(found) {
            return false;
        }
        found.push(local);
        true
    };
    for period in 1..i64::from(MAX_STEPS) {
        if full(&found) {
            break;
        }
        let amount = interval * period;
        let keep_going = match rule.frequency {
            Frequency::Weekly if !rule.by_day.is_empty() => {
                let start_day = first.div_euclid(MS_PER_DAY);
                let first_day = i64::from(rule.first_day_of_week);
                let week_start = first - (weekday(start_day) - first_day + 7) % 7 * MS_PER_DAY;
                let mut offsets: Vec<i64> = rule
                    .by_day
                    .iter()
                    .map(|n_day| (i64::from(n_day.day) - first_day + 7) % 7)
                    .collect();
                offsets.sort_unstable();
                offsets.dedup();
                offsets.into_iter().all(|offset| {
                    push(
                        &mut found,
                        week_start + ((period - 1) * interval * 7 + offset) * MS_PER_DAY,
                    )
                })
            }
            Frequency::Monthly if !rule.by_day.is_empty() || !rule.by_month_day.is_empty() => {
                let index = month - 1 + (period - 1) * interval;
                let in_year = year + index.div_euclid(12);
                let in_month = index.rem_euclid(12) + 1;
                month_days(in_year, in_month, rule).into_iter().all(|date| {
                    push(
                        &mut found,
                        days_from_civil(in_year, in_month, date) * MS_PER_DAY + clock,
                    )
                })
            }
            Frequency::Daily => push(&mut found, first + amount * MS_PER_DAY),
            Frequency::Weekly => push(&mut found, first + amount * 7 * MS_PER_DAY),
            Frequency::Monthly | Frequency::Yearly => {
                let months = if rule.frequency == Frequency::Monthly {
                    amount
                } else {
                    amount * 12
                };
                let index = month - 1 + months;
                let (in_year, in_month) = (year + index.div_euclid(12), index.rem_euclid(12) + 1);
                if day > days_in_month(in_year, in_month) {
                    true
                } else {
                    push(
                        &mut found,
                        days_from_civil(in_year, in_month, day) * MS_PER_DAY + clock,
                    )
                }
            }
        };
        if !keep_going {
            break;
        }
    }
    found
}

/// The latest answer from each sender for `uid`, and for this occurrence of a
/// series; an answer without a `recurrence_id` holds for the whole series.
#[must_use]
pub fn tally_rsvps(
    rsvps: &[CalendarRsvpView],
    uid: &str,
    recurrence_id: Option<&str>,
    user_id: Option<&str>,
) -> RsvpTally {
    let mut latest: Vec<&CalendarRsvpView> = Vec::new();
    for rsvp in rsvps {
        if rsvp.uid != uid
            || !matches!(rsvp.status.as_str(), "accepted" | "tentative" | "declined")
            || rsvp
                .recurrence_id
                .as_deref()
                .is_some_and(|answered| Some(answered) != recurrence_id)
        {
            continue;
        }
        match latest.iter_mut().find(|held| held.sender == rsvp.sender) {
            Some(held) if held.timestamp <= rsvp.timestamp => *held = rsvp,
            Some(_) => {}
            None => latest.push(rsvp),
        }
    }
    let mut tally = RsvpTally::default();
    for rsvp in latest {
        let status = RsvpStatusView::deserialize(
            IntoDeserializer::<value::Error>::into_deserializer(rsvp.status.as_str()),
        )
        .unwrap_or(RsvpStatusView::Declined);
        let (count, people) = match status {
            RsvpStatusView::Accepted => (&mut tally.accepted, &mut tally.people.accepted),
            RsvpStatusView::Tentative => (&mut tally.tentative, &mut tally.people.tentative),
            RsvpStatusView::Declined => (&mut tally.declined, &mut tally.people.declined),
        };
        *count += 1;
        people.push(rsvp.sender.clone());
        if Some(rsvp.sender.as_str()) == user_id {
            tally.mine = Some(status);
        }
    }
    tally
}

const fn frequency_name(frequency: Frequency) -> &'static str {
    match frequency {
        Frequency::Daily => "daily",
        Frequency::Weekly => "weekly",
        Frequency::Monthly => "monthly",
        Frequency::Yearly => "yearly",
    }
}

fn recurrence_rule(
    frequency: Frequency,
    until: Option<&str>,
    base: Option<&Map<String, Value>>,
) -> Value {
    let previous = base
        .and_then(|base| base.get("recurrenceRules"))
        .and_then(Value::as_array)
        .and_then(|rules| rules.first())
        .and_then(Value::as_object)
        .filter(|rule| {
            rule.get("frequency").and_then(Value::as_str) == Some(frequency_name(frequency))
        });
    let mut rule = previous.cloned().unwrap_or_default();
    rule.remove("until");
    let count = rule.remove("count");
    rule.insert("@type".to_owned(), json!("RecurrenceRule"));
    rule.insert("frequency".to_owned(), json!(frequency_name(frequency)));
    match (until.filter(|until| !until.is_empty()), count) {
        (Some(until), _) => {
            rule.insert("until".to_owned(), json!(format!("{until}T23:59:59")));
        }
        (None, Some(count)) => {
            rule.insert("count".to_owned(), count);
        }
        (None, None) => {}
    }
    Value::Object(rule)
}

/// The event to send for `draft`, keeping what `base` carried that the dialog
/// does not edit. An all-day event is a floating run of whole days.
#[must_use]
pub fn build_event(
    draft: &EventDraft,
    base: Option<&Map<String, Value>>,
    uid: &str,
    now_ms: i64,
    time_zone: &str,
) -> Map<String, Value> {
    let mut event = base.cloned().unwrap_or_default();
    for key in ["recurrenceRules", "locations", "description"] {
        event.remove(key);
    }
    let start = if draft.all_day {
        let date = draft
            .start
            .split_once('T')
            .map_or(draft.start.as_str(), |(date, _)| date);
        format!("{date}T00:00:00")
    } else {
        draft.start.clone()
    };
    let duration = if draft.all_day {
        let days = (draft.duration_ms + MS_PER_DAY / 2).div_euclid(MS_PER_DAY);
        format!("P{}D", days.max(1))
    } else {
        format_duration(draft.duration_ms)
    };
    let fields = [
        ("@type", json!("Event")),
        ("uid", json!(uid)),
        ("updated", json!(format!("{}Z", format_ms(now_ms)))),
        ("title", json!(draft.title)),
        ("start", json!(start)),
        (
            "timeZone",
            if draft.all_day {
                Value::Null
            } else {
                json!(time_zone)
            },
        ),
        ("duration", json!(duration)),
        ("showWithoutTime", json!(draft.all_day)),
    ];
    for (key, value) in fields {
        event.insert(key.to_owned(), value);
    }
    if !draft.description.is_empty() {
        event.insert("description".to_owned(), json!(draft.description));
    }
    if !draft.location.is_empty() {
        event.insert(
            "locations".to_owned(),
            json!({"main": {"@type": "Location", "name": draft.location}}),
        );
    }
    if let Some(frequency) = draft.frequency {
        event.insert(
            "recurrenceRules".to_owned(),
            json!([recurrence_rule(frequency, draft.until.as_deref(), base)]),
        );
    }
    event
}

#[cfg(test)]
mod tests {
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
        let rsvp =
            |sender: &str, status: &str, recurrence: Option<&str>, timestamp| CalendarRsvpView {
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
}
