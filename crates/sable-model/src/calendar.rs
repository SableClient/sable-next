//! Commet calendar events (RFC 8984 `JSCalendar`), expanded as wall-clock times without a time zone database.

use jiff::{
    Span,
    civil::{Date, DateTime, Weekday},
};
use serde::de::{IntoDeserializer, value};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use serde_with::{DefaultOnError, serde_as};

use crate::civil::{MS_PER_DAY, date, format_datetime, format_ms};

const MINUTE_MS: i64 = 60_000;
const MS_PER_SECOND: i64 = 1000;
const SECONDS_PER_MINUTE: i64 = 60;
const SECONDS_PER_HOUR: i64 = 60 * SECONDS_PER_MINUTE;
const SECONDS_PER_DAY: i64 = 24 * SECONDS_PER_HOUR;
const SECONDS_PER_WEEK: i64 = 7 * SECONDS_PER_DAY;
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
        unit(&mut rest, 'W', SECONDS_PER_WEEK)?;
        unit(&mut rest, 'D', SECONDS_PER_DAY)?;
        if let Some(time) = rest.strip_prefix('T') {
            rest = time;
            unit(&mut rest, 'H', SECONDS_PER_HOUR)?;
            unit(&mut rest, 'M', SECONDS_PER_MINUTE)?;
            unit(&mut rest, 'S', 1)?;
        }
        rest.is_empty()
            .then_some(total_seconds.checked_mul(MS_PER_SECOND)?)
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

/// A calendar wall time, from year 100 on, without an offset or fractional seconds.
fn wall_datetime(local: &str) -> Option<DateTime> {
    let bytes = local.as_bytes();
    if !matches!(bytes.len(), 16 | 19)
        || [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':')]
            .iter()
            .any(|&(at, byte)| bytes.get(at) != Some(&byte))
        || (bytes.len() == 19 && (bytes.get(16) != Some(&b':') || local.get(17..) == Some("60")))
    {
        return None;
    }
    let at: DateTime = local.parse().ok()?;
    (at.year() >= 100).then_some(at)
}

fn days_after(at: DateTime, days: i64) -> Option<DateTime> {
    at.checked_add(Span::new().try_days(days).ok()?).ok()
}

fn weekday_index(value: Option<&Value>) -> Option<u8> {
    let name = value?.as_str()?;
    WEEKDAYS
        .iter()
        .position(|day| *day == name)
        .and_then(|day| u8::try_from(day).ok())
}

#[serde_as]
#[derive(Deserialize)]
struct NDayIn {
    #[serde(deserialize_with = "rule_weekday")]
    day: Option<u8>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "nthOfPeriod")]
    nth: Option<f64>,
}

fn read_n_days(value: Option<&Value>) -> Option<Vec<NDay>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    value
        .as_array()?
        .iter()
        .map(|entry| {
            if !entry.is_object() {
                return None;
            }
            let entry = NDayIn::deserialize(entry).ok()?;
            Some(NDay {
                day: entry.day?,
                nth: entry.nth.filter(|nth| *nth != 0.0),
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

fn rule_by_day<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Vec<NDay>>, D::Error> {
    Ok(read_n_days(Some(&Value::deserialize(deserializer)?)))
}

#[expect(
    clippy::unnecessary_wraps,
    reason = "serde's default for `rule_by_day`"
)]
const fn no_days() -> Option<Vec<NDay>> {
    Some(Vec::new())
}

fn rule_by_month_day<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<i64>, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::Array(days) => days
            .iter()
            .filter_map(whole)
            .filter(|day| *day != 0)
            .collect(),
        _ => Vec::new(),
    })
}

fn rule_interval<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u32>, D::Error> {
    Ok(whole_interval(Some(&Value::deserialize(deserializer)?)))
}

#[expect(
    clippy::unnecessary_wraps,
    reason = "serde's default for `rule_interval`"
)]
const fn one() -> Option<u32> {
    Some(1)
}

fn rule_weekday<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u8>, D::Error> {
    Ok(weekday_index(Some(&Value::deserialize(deserializer)?)))
}

fn rule_gregorian<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    Ok(Value::deserialize(deserializer)?
        .as_str()
        .is_some_and(|rscale| rscale.eq_ignore_ascii_case("gregorian")))
}

const fn gregorian() -> bool {
    true
}

#[serde_as]
#[derive(Deserialize)]
struct RuleIn {
    frequency: String,
    #[serde(
        default = "no_days",
        rename = "byDay",
        deserialize_with = "rule_by_day"
    )]
    by_day: Option<Vec<NDay>>,
    #[serde(default, rename = "byMonthDay", deserialize_with = "rule_by_month_day")]
    by_month_day: Vec<i64>,
    #[serde(default = "one", deserialize_with = "rule_interval")]
    interval: Option<u32>,
    #[serde(default = "gregorian", deserialize_with = "rule_gregorian")]
    rscale: bool,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    count: Option<f64>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    until: Option<String>,
    #[serde(default, rename = "firstDayOfWeek", deserialize_with = "rule_weekday")]
    first_day_of_week: Option<u8>,
    #[serde(flatten)]
    rest: Map<String, Value>,
}

fn read_recurrence(value: Option<&Value>) -> Option<Recurrence> {
    let rule = value?.as_array()?.first()?;
    if !rule.is_object() {
        return None;
    }
    let rule = RuleIn::deserialize(rule).ok()?;
    let frequency = match rule.frequency.as_str() {
        "daily" => Frequency::Daily,
        "weekly" => Frequency::Weekly,
        "monthly" => Frequency::Monthly,
        "yearly" => Frequency::Yearly,
        _ => return None,
    };
    let by_day = rule.by_day;
    let unmodelled = UNMODELLED_PARTS.iter().any(|part| {
        rule.rest
            .get(*part)
            .and_then(Value::as_array)
            .is_some_and(|values| !values.is_empty())
    });
    let modelled = by_day.as_ref().is_some_and(|by_day| {
        by_day.is_empty()
            || frequency == Frequency::Monthly
            || (frequency == Frequency::Weekly && by_day.iter().all(|day| day.nth.is_none()))
    }) && rule.interval.is_some()
        && rule.rscale
        && !unmodelled
        && (rule.by_month_day.is_empty() || frequency == Frequency::Monthly);
    Some(Recurrence {
        frequency,
        interval: rule.interval.unwrap_or(1),
        count: rule.count,
        until: rule.until,
        by_day: by_day.unwrap_or_default(),
        by_month_day: rule.by_month_day,
        first_day_of_week: rule.first_day_of_week.unwrap_or(1),
        modelled,
    })
}

fn first_location_name<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    #[serde_as]
    #[derive(Deserialize)]
    struct Location {
        #[serde_as(deserialize_as = "DefaultOnError")]
        #[serde(default)]
        name: String,
    }
    Ok(match Value::deserialize(deserializer)? {
        Value::Object(locations) => locations
            .into_iter()
            .find(|(_, location)| location.is_object())
            .and_then(|(_, location)| serde_json::from_value::<Location>(location).ok())
            .map(|location| location.name)
            .unwrap_or_default(),
        _ => String::new(),
    })
}

#[serde_as]
#[derive(Deserialize)]
struct EventIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    uid: String,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    start: String,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    title: String,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    description: String,
    #[serde(default, deserialize_with = "first_location_name")]
    locations: String,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "showWithoutTime")]
    all_day: Option<bool>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "timeZone")]
    time_zone: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    duration: Option<String>,
    #[serde(default, rename = "recurrenceRules")]
    recurrence_rules: Option<Value>,
}

/// `None` for an event without a uid or a start that is a real date.
#[must_use]
pub fn read_entry(event_id: &str, sender: &str, event: &Value) -> Option<CalendarItem> {
    let raw = event.as_object()?;
    let fields = EventIn::deserialize(event).ok()?;
    if fields.uid.is_empty() || wall_datetime(&fields.start).is_none() {
        return None;
    }
    Some(CalendarItem {
        event_id: event_id.to_owned(),
        sender: sender.to_owned(),
        uid: fields.uid,
        title: fields.title,
        description: fields.description,
        location: fields.locations,
        all_day: fields.all_day == Some(true),
        start: fields.start,
        time_zone: fields.time_zone,
        duration_ms: fields.duration.as_deref().map_or(0, parse_duration),
        recurrence: read_recurrence(fields.recurrence_rules.as_ref()),
        raw: raw.clone(),
    })
}

/// Preserve the array-index coercion used for existing fractional ordinals.
fn weekday_ordinal(nth: f64) -> Option<i8> {
    let index = if nth > 0.0 { nth - 1.0 } else { nth }.trunc();
    let ordinal = if index >= 0.0 { index + 1.0 } else { index };
    if !(-5.0..=5.0).contains(&ordinal) {
        return None;
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "a whole ordinal between -5 and 5 converts exactly"
    )]
    Some(ordinal as i8)
}

fn month_days(month_start: Date, rule: &Recurrence) -> Vec<i64> {
    let length = i64::from(month_start.days_in_month());
    let mut days: Vec<i64> = rule
        .by_month_day
        .iter()
        .map(|&day| if day > 0 { day } else { length + day + 1 })
        .filter(|date| (1..=length).contains(date))
        .collect();
    for n_day in &rule.by_day {
        let Some(weekday) = i8::try_from(n_day.day % 7)
            .ok()
            .and_then(|day| Weekday::from_sunday_zero_offset(day).ok())
        else {
            continue;
        };
        let nth_date = |ordinal| {
            month_start
                .nth_weekday_of_month(ordinal, weekday)
                .ok()
                .map(|date| i64::from(date.day()))
        };
        match n_day.nth {
            None => days.extend((1..=5).filter_map(nth_date)),
            Some(nth) => days.extend(weekday_ordinal(nth).and_then(nth_date)),
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
    let Some(first) = wall_datetime(&item.start) else {
        return found;
    };
    let (year, month, day) = (
        i64::from(first.year()),
        i64::from(first.month()),
        i64::from(first.day()),
    );
    let interval = i64::from(rule.interval);
    let push = |found: &mut Vec<String>, at: DateTime| -> bool {
        if at <= first {
            return true;
        }
        let local = format_datetime(at);
        if local.as_str() >= before || full(found) {
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
                let first_day = i64::from(rule.first_day_of_week);
                let weekday = i64::from(first.weekday().to_sunday_zero_offset());
                let Some(week_start) = days_after(first, -((weekday - first_day + 7) % 7)) else {
                    break;
                };
                let mut offsets: Vec<i64> = rule
                    .by_day
                    .iter()
                    .map(|n_day| (i64::from(n_day.day) - first_day + 7) % 7)
                    .collect();
                offsets.sort_unstable();
                offsets.dedup();
                offsets.into_iter().all(|offset| {
                    days_after(week_start, (period - 1) * interval * 7 + offset)
                        .is_some_and(|at| push(&mut found, at))
                })
            }
            Frequency::Monthly if !rule.by_day.is_empty() || !rule.by_month_day.is_empty() => {
                let index = month - 1 + (period - 1) * interval;
                let in_year = year + index.div_euclid(12);
                let in_month = index.rem_euclid(12) + 1;
                date(in_year, in_month, 1).is_some_and(|month_start| {
                    month_days(month_start, rule).into_iter().all(|day| {
                        date(in_year, in_month, day)
                            .is_some_and(|date| push(&mut found, date.to_datetime(first.time())))
                    })
                })
            }
            Frequency::Daily => days_after(first, amount).is_some_and(|at| push(&mut found, at)),
            Frequency::Weekly => {
                days_after(first, amount * 7).is_some_and(|at| push(&mut found, at))
            }
            Frequency::Monthly | Frequency::Yearly => {
                let months = if rule.frequency == Frequency::Monthly {
                    amount
                } else {
                    amount * 12
                };
                let index = month - 1 + months;
                let (in_year, in_month) = (year + index.div_euclid(12), index.rem_euclid(12) + 1);
                date(in_year, in_month, 1).is_some_and(|month_start| {
                    // Recurrences skip missing dates rather than constraining them to month end.
                    day > i64::from(month_start.days_in_month())
                        || date(in_year, in_month, day)
                            .is_some_and(|date| push(&mut found, date.to_datetime(first.time())))
                })
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

/// A recurrence rule to send; `extra` carries the parts of an existing rule the dialog does not edit.
#[derive(Serialize)]
#[serde(tag = "@type")]
enum RuleOut {
    RecurrenceRule {
        frequency: Frequency,
        #[serde(skip_serializing_if = "Option::is_none")]
        until: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        count: Option<Value>,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
}

fn recurrence_rule(
    frequency: Frequency,
    until: Option<&str>,
    base: Option<&Map<String, Value>>,
) -> RuleOut {
    let previous = base
        .and_then(|base| base.get("recurrenceRules"))
        .and_then(Value::as_array)
        .and_then(|rules| rules.first())
        .and_then(Value::as_object)
        .filter(|rule| {
            rule.get("frequency").is_some_and(|value| {
                Frequency::deserialize(value).is_ok_and(|rule| rule == frequency)
            })
        });
    let mut extra = previous.cloned().unwrap_or_default();
    let count = extra.remove("count");
    for key in ["until", "@type", "frequency"] {
        extra.remove(key);
    }
    let until = until
        .filter(|until| !until.is_empty())
        .map(|until| format!("{until}T23:59:59"));
    RuleOut::RecurrenceRule {
        frequency,
        count: if until.is_some() { None } else { count },
        until,
        extra,
    }
}

#[derive(Serialize)]
#[serde(tag = "@type")]
enum LocationOut {
    Location { name: String },
}

#[derive(Serialize)]
struct LocationsOut {
    main: LocationOut,
}

#[derive(Serialize)]
#[serde(tag = "@type", rename_all_fields = "camelCase")]
enum EventOut {
    Event {
        uid: String,
        updated: String,
        title: String,
        start: String,
        time_zone: Option<String>,
        duration: String,
        show_without_time: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        locations: Option<LocationsOut>,
        #[serde(skip_serializing_if = "Option::is_none")]
        recurrence_rules: Option<[RuleOut; 1]>,
    },
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
    let fields = EventOut::Event {
        uid: uid.to_owned(),
        updated: format!("{}Z", format_ms(now_ms).unwrap_or_default()),
        title: draft.title.clone(),
        start,
        time_zone: (!draft.all_day).then(|| time_zone.to_owned()),
        duration,
        show_without_time: draft.all_day,
        description: (!draft.description.is_empty()).then(|| draft.description.clone()),
        locations: (!draft.location.is_empty()).then(|| LocationsOut {
            main: LocationOut::Location {
                name: draft.location.clone(),
            },
        }),
        recurrence_rules: draft
            .frequency
            .map(|frequency| [recurrence_rule(frequency, draft.until.as_deref(), base)]),
    };
    if let Ok(Value::Object(fields)) = serde_json::to_value(fields) {
        event.extend(fields);
    }
    event
}

#[cfg(test)]
#[path = "calendar_tests.rs"]
mod tests;
