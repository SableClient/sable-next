//! `m.space.child` order strings (MSC1772): printable ASCII, at most 50 characters.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use crate::spaces::SpaceChildEdge;

const FIRST: i32 = 0x20;
const LAST: i32 = 0x7e;
const SPAN: u64 = 95;
const MAX_LENGTH: usize = 50;

/// A child and the order string it carries or should carry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ChildOrder {
    pub room_id: String,
    pub order: Option<String>,
}

fn code(character: char) -> i32 {
    i32::try_from(u32::from(character)).unwrap_or(i32::MAX)
}

fn from_codes(codes: &[i32]) -> Option<String> {
    codes
        .iter()
        .map(|&value| u32::try_from(value).ok().and_then(char::from_u32))
        .collect()
}

/// A key sorting strictly between the two, or `None` once it would outgrow the length limit.
#[must_use]
pub fn order_between(before: Option<&str>, after: Option<&str>) -> Option<String> {
    let low: Vec<i32> = before.unwrap_or_default().chars().map(code).collect();
    let high: Vec<i32> = after.unwrap_or_default().chars().map(code).collect();
    let mut result = Vec::new();

    for index in 0..MAX_LENGTH {
        let lower = low.get(index).copied().unwrap_or(FIRST - 1);
        let upper = high.get(index).copied().unwrap_or(LAST + 1);

        if upper - lower > 1 {
            result.push(i32::midpoint(lower, upper));
            return from_codes(&result);
        }

        result.push(lower.max(FIRST));
    }

    None
}

fn renumber(count: usize) -> Vec<String> {
    let count = u64::try_from(count).unwrap_or(u64::MAX);
    let mut places = 0;
    let mut reach = 1u64;
    while reach < count {
        reach = reach.saturating_mul(SPAN);
        places += 1;
    }
    let width = places + 1;
    let step = SPAN.saturating_pow(width) / (count + 1);

    (1..=count)
        .map(|position| {
            let mut value = step.saturating_mul(position);
            let mut digits = Vec::new();
            for _ in 0..width {
                digits.push(u64::from(FIRST.unsigned_abs()) + value % SPAN);
                value /= SPAN;
            }
            digits
                .into_iter()
                .rev()
                .filter_map(|digit| u8::try_from(digit).ok())
                .map(char::from)
                .collect()
        })
        .collect()
}

fn fully_ordered(orders: &[Option<&str>]) -> bool {
    orders.iter().enumerate().all(|(index, order)| {
        order.is_some_and(|order| {
            index.checked_sub(1).is_none_or(|previous| {
                orders.get(previous).copied().flatten().unwrap_or_default() < order
            })
        })
    })
}

/// The entries whose key must change to move `room_id` to `target_index`.
#[must_use]
pub fn reorder_children(
    children: &[ChildOrder],
    room_id: &str,
    target_index: usize,
) -> Vec<ChildOrder> {
    let Some(from) = children.iter().position(|child| child.room_id == room_id) else {
        return Vec::new();
    };

    let mut moved = children.to_vec();
    let entry = moved.remove(from);
    let to = target_index.min(moved.len());
    moved.insert(to, entry);
    if to == from {
        return Vec::new();
    }

    let others: Vec<Option<&str>> = moved
        .iter()
        .filter(|child| child.room_id != room_id)
        .map(|child| child.order.as_deref())
        .collect();

    if fully_ordered(&others) {
        let neighbour = |index: Option<usize>| {
            index
                .and_then(|index| moved.get(index))
                .and_then(|child| child.order.as_deref())
        };
        if let Some(order) = order_between(neighbour(to.checked_sub(1)), neighbour(Some(to + 1))) {
            return vec![ChildOrder {
                room_id: room_id.to_owned(),
                order: Some(order),
            }];
        }
    }

    moved
        .iter()
        .zip(renumber(moved.len()))
        .filter(|(child, key)| child.order.as_deref() != Some(key))
        .map(|(child, key)| ChildOrder {
            room_id: child.room_id.clone(),
            order: Some(key),
        })
        .collect()
}

/// Keyed edges first by key, then by age.
pub(crate) fn compare_edges(left: &SpaceChildEdge, right: &SpaceChildEdge) -> Ordering {
    match (&left.order, &right.order) {
        (Some(left), Some(right)) => left.cmp(right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
    .then_with(|| left.origin_server_ts.cmp(&right.origin_server_ts))
}

#[must_use]
pub fn sort_edges(edges: &[SpaceChildEdge]) -> Vec<SpaceChildEdge> {
    let mut sorted = edges.to_vec();
    sorted.sort_by(compare_edges);
    sorted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn child(room_id: &str, order: Option<&str>) -> ChildOrder {
        ChildOrder {
            room_id: room_id.to_owned(),
            order: order.map(str::to_owned),
        }
    }

    fn between(before: Option<&str>, after: Option<&str>) -> String {
        order_between(before, after).expect("a key")
    }

    fn ascending(orders: &[Option<String>]) -> bool {
        let keys: Vec<&String> = orders.iter().flatten().collect();
        keys.windows(2).all(|pair| pair[0] < pair[1])
    }

    fn apply(children: &[ChildOrder], room_id: &str, target_index: usize) -> Vec<ChildOrder> {
        let changes = reorder_children(children, room_id, target_index);
        let from = children
            .iter()
            .position(|entry| entry.room_id == room_id)
            .expect("a known room");
        let mut moved = children.to_vec();
        let entry = moved.remove(from);
        moved.insert(target_index, entry);
        moved
            .into_iter()
            .map(|entry| {
                changes
                    .iter()
                    .find(|change| change.room_id == entry.room_id)
                    .cloned()
                    .unwrap_or(entry)
            })
            .collect()
    }

    fn orders(children: &[ChildOrder]) -> Vec<Option<String>> {
        children.iter().map(|entry| entry.order.clone()).collect()
    }

    fn ids(children: &[ChildOrder]) -> Vec<&str> {
        children
            .iter()
            .map(|entry| entry.room_id.as_str())
            .collect()
    }

    #[test]
    fn a_key_between_two_orders_sorts_strictly_between_them() {
        let key = between(Some("a"), Some("c"));
        assert!("a" < key.as_str() && key.as_str() < "c");
    }

    #[test]
    fn a_key_before_everything_sorts_below_the_first_order() {
        assert!(between(None, Some("b")).as_str() < "b");
    }

    #[test]
    fn a_key_after_everything_sorts_above_the_last_order() {
        assert!("y" < between(Some("y"), None).as_str());
    }

    #[test]
    fn adjacent_orders_are_split_by_lengthening_rather_than_colliding() {
        let key = between(Some("a"), Some("b"));
        assert!("a" < key.as_str() && key.as_str() < "b");
    }

    #[test]
    fn generated_keys_stay_inside_the_printable_ascii_range_the_spec_allows() {
        let mut low: Option<String> = None;
        for _ in 0..40 {
            let next = between(low.as_deref(), Some("b"));
            assert!(
                next.chars()
                    .all(|character| (' '..='~').contains(&character))
            );
            assert!(next.len() <= MAX_LENGTH);
            low = Some(next);
        }
    }

    #[test]
    fn moving_a_room_reports_only_the_entries_whose_key_changed() {
        let children = [
            child("!a", Some("a")),
            child("!b", Some("b")),
            child("!c", Some("c")),
        ];
        let changes = reorder_children(&children, "!c", 0);

        assert_eq!(ids(&changes), ["!c"]);
        assert!(changes[0].order.as_deref().expect("a key") < "a");
    }

    #[test]
    fn the_reported_keys_place_the_moved_room_at_its_new_index() {
        let children = [
            child("!a", Some("a")),
            child("!b", Some("b")),
            child("!c", Some("c")),
        ];
        let result = apply(&children, "!a", 2);

        assert_eq!(ids(&result), ["!b", "!c", "!a"]);
        assert!(ascending(&orders(&result)));
    }

    #[test]
    fn moving_an_unordered_room_into_place_assigns_keys_to_what_it_passes() {
        let children = [child("!a", None), child("!b", None), child("!c", None)];
        let result = apply(&children, "!c", 0);

        assert_eq!(ids(&result), ["!c", "!a", "!b"]);
        assert!(result.iter().all(|entry| entry.order.is_some()));
        assert!(ascending(&orders(&result)));
    }

    #[test]
    fn moving_a_room_nowhere_changes_nothing() {
        let children = [child("!a", Some("a")), child("!b", Some("b"))];
        assert_eq!(reorder_children(&children, "!a", 0), Vec::new());
    }

    #[test]
    fn an_unknown_room_is_not_a_reorder() {
        assert_eq!(
            reorder_children(&[child("!a", Some("a"))], "!missing", 0),
            Vec::new()
        );
    }

    #[test]
    fn repeatedly_moving_to_the_front_stays_inside_the_key_length_limit() {
        let mut children = vec![
            child("!a", Some("a")),
            child("!b", Some("b")),
            child("!c", Some("c")),
        ];

        for _ in 0..60 {
            let last = children.last().expect("a child").room_id.clone();
            children = apply(&children, &last, 0);
            assert!(
                children
                    .iter()
                    .flat_map(|entry| &entry.order)
                    .all(|order| order.len() <= MAX_LENGTH)
            );
        }

        assert!(ascending(&orders(&children)));
    }

    fn edge(order: Option<&str>, origin_server_ts: u64) -> SpaceChildEdge {
        SpaceChildEdge {
            room_id: String::new(),
            via: Vec::new(),
            order: order.map(str::to_owned),
            origin_server_ts,
            suggested: false,
            private: false,
        }
    }

    #[test]
    fn keyed_edges_sort_ahead_of_unkeyed_ones() {
        let sorted = sort_edges(&[edge(None, 1), edge(Some("b"), 9), edge(Some("a"), 8)]);
        let keys: Vec<_> = sorted.iter().map(|edge| edge.order.as_deref()).collect();
        assert_eq!(keys, [Some("a"), Some("b"), None]);
    }

    #[test]
    fn edges_with_equal_keys_fall_back_to_their_timestamp() {
        let sorted = sort_edges(&[edge(Some("a"), 5), edge(Some("a"), 2)]);
        let stamps: Vec<_> = sorted.iter().map(|edge| edge.origin_server_ts).collect();
        assert_eq!(stamps, [2, 5]);
    }
}
