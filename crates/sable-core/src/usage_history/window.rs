//! When uses happened, kept beside the cumulative `total` that other clients share.
//! Uses past the window fold into one bucket, so `total` less every bucket is
//! what other clients added without a date.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Outside MSC4356. The shape is the one earlier builds of Sable read.
pub(super) const FIELD: &str = "moe.sable.usage";
pub(super) const DAY_MS: u64 = 86_400_000;
const DAYS: u64 = 30;

#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Uses {
    day: u64,
    device: String,
    pub(super) count: u64,
    last_used: u64,
}

impl Uses {
    pub(super) fn at(device: &str, count: u64, time: u64) -> Self {
        Self {
            day: time / DAY_MS,
            device: device.to_owned(),
            count,
            last_used: time,
        }
    }

    const fn recent(&self, now: u64) -> bool {
        self.day.saturating_add(DAYS) > now / DAY_MS
    }
}

pub(super) fn read(entry: &Value) -> Vec<Uses> {
    entry
        .get(FIELD)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|uses| Uses::deserialize(uses).ok())
        .collect()
}

pub(super) fn write(entry: &mut Value, buckets: &[Uses]) {
    if let (Ok(buckets), Some(fields)) = (serde_json::to_value(buckets), entry.as_object_mut()) {
        fields.insert(FIELD.to_owned(), buckets);
    }
}

pub(super) fn sum<'a>(uses: impl IntoIterator<Item = &'a Uses>) -> u64 {
    uses.into_iter()
        .fold(0, |sum, uses| sum.saturating_add(uses.count))
}

pub(super) fn add(buckets: &mut Vec<Uses>, uses: Uses) {
    if let Some(bucket) = buckets
        .iter_mut()
        .find(|bucket| bucket.day == uses.day && bucket.device == uses.device)
    {
        bucket.count = bucket.count.saturating_add(uses.count);
        bucket.last_used = bucket.last_used.max(uses.last_used);
    } else {
        buckets.push(uses);
    }
}

/// Undated uses count as recent, as nothing says they are old.
pub(super) fn frequency(buckets: &[Uses], total: u64, now: u64) -> u64 {
    let undated = total.saturating_sub(sum(buckets));
    sum(buckets.iter().filter(|uses| uses.recent(now)))
        .saturating_add(undated)
        .min(total)
}

pub(super) fn compact(buckets: Vec<Uses>, now: u64) -> Vec<Uses> {
    let mut compacted = Vec::new();
    for uses in buckets {
        let uses = if uses.recent(now) {
            uses
        } else {
            Uses::at("earlier", uses.count, 0)
        };
        add(&mut compacted, uses);
    }
    compacted.sort_by(|left, right| {
        left.day
            .cmp(&right.day)
            .then_with(|| left.device.cmp(&right.device))
    });
    compacted
}

/// Uses nobody dated are dated when first written, so they age out from then on.
pub(super) fn date(mut buckets: Vec<Uses>, total: u64, now: u64) -> Vec<Uses> {
    let undated = total.saturating_sub(sum(&buckets));
    if undated > 0 {
        add(&mut buckets, Uses::at("undated", undated, now));
    }
    compact(buckets, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 100 * DAY_MS;

    #[test]
    fn expired_uses_still_account_for_the_total() {
        let buckets = vec![
            Uses::at("phone", 500, NOW - 45 * DAY_MS),
            Uses::at("laptop", 20, NOW - 30 * DAY_MS),
            Uses::at("phone", 2, NOW - 29 * DAY_MS),
        ];
        assert_eq!(frequency(&buckets, 522, NOW), 2);
        let compacted = compact(buckets, NOW);
        assert_eq!(compacted.len(), 2);
        assert_eq!(sum(&compacted), 522);
        assert_eq!(frequency(&compacted, 522, NOW), 2);
        assert_eq!(frequency(&compacted, 522, NOW + DAY_MS), 0);
    }

    #[test]
    fn undated_uses_count_now_and_age_once_dated() {
        assert_eq!(frequency(&[], 84, NOW), 84);
        let dated = date(Vec::new(), 84, NOW);
        assert_eq!(frequency(&dated, 84, NOW + 29 * DAY_MS), 84);
        assert_eq!(frequency(&dated, 84, NOW + 30 * DAY_MS), 0);
        assert_eq!(frequency(&dated, 85, NOW + 30 * DAY_MS), 1);
    }
}
