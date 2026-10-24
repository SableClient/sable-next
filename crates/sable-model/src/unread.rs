//! Unread counts as a badge shows them: under the reader's per-kind default
//! and the room's own notification mode, with quiet spaces silenced and spaces
//! totalling the rooms beneath them.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::notifications::NotificationModeView;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct UnreadCountView {
    pub unread: u32,
    pub highlight: u32,
    pub marked: bool,
    pub notifying: u32,
}

impl UnreadCountView {
    #[must_use]
    pub const fn any(self) -> bool {
        self.unread > 0 || self.highlight > 0 || self.marked
    }

    #[must_use]
    pub const fn plus(self, other: Self) -> Self {
        Self {
            unread: self.unread.saturating_add(other.unread),
            highlight: self.highlight.saturating_add(other.highlight),
            marked: self.marked || other.marked,
            notifying: self.notifying.saturating_add(other.notifying),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum BadgeNotificationMode {
    All,
    Mentions,
    Quiet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct BadgeDefaults {
    pub direct: BadgeNotificationMode,
    pub group: BadgeNotificationMode,
}

impl Default for BadgeDefaults {
    fn default() -> Self {
        Self {
            direct: BadgeNotificationMode::All,
            group: BadgeNotificationMode::Mentions,
        }
    }
}

/// `None` is a muted room: its counts are shown as they are.
#[must_use]
pub const fn badge_mode_for(
    is_direct: bool,
    room_override: Option<NotificationModeView>,
    defaults: BadgeDefaults,
) -> Option<BadgeNotificationMode> {
    match room_override {
        Some(NotificationModeView::Mute) => None,
        Some(NotificationModeView::All) => Some(BadgeNotificationMode::All),
        Some(NotificationModeView::Mentions) => Some(BadgeNotificationMode::Mentions),
        None => Some(if is_direct {
            defaults.direct
        } else {
            defaults.group
        }),
    }
}

#[must_use]
pub const fn quiet_unread(count: UnreadCountView) -> UnreadCountView {
    UnreadCountView {
        unread: count.highlight,
        notifying: 0,
        ..count
    }
}

#[must_use]
pub const fn apply_badge_mode(
    count: UnreadCountView,
    mode: Option<BadgeNotificationMode>,
) -> UnreadCountView {
    match mode {
        None => count,
        Some(BadgeNotificationMode::Quiet) => quiet_unread(count),
        Some(BadgeNotificationMode::Mentions) => UnreadCountView {
            notifying: 0,
            ..count
        },
        Some(BadgeNotificationMode::All) => UnreadCountView {
            notifying: if count.notifying > count.unread {
                count.notifying
            } else {
                count.unread
            },
            ..count
        },
    }
}

/// A room as the space arithmetic sees it.
#[derive(Debug, Clone, Default)]
pub struct SpaceNode<'a> {
    pub room_id: &'a str,
    pub is_space: bool,
    pub joined: bool,
    pub children: Vec<&'a str>,
}

/// The unread fields of one room.
pub struct RoomBadge<'a> {
    pub room_id: &'a str,
    pub is_direct: bool,
    pub room_override: Option<NotificationModeView>,
    pub counts: UnreadCountView,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomBadgesView {
    pub quiet_room_ids: Vec<String>,
    pub badges: BTreeMap<String, UnreadCountView>,
    pub space_unread: BTreeMap<String, UnreadCountView>,
}

#[must_use]
pub fn room_badges<'a>(
    nodes: &[SpaceNode<'a>],
    rooms: impl IntoIterator<Item = RoomBadge<'a>>,
    quiet_targets: impl IntoIterator<Item = &'a str>,
    defaults: BadgeDefaults,
) -> RoomBadgesView {
    let quiet = quiet_room_ids(nodes, quiet_targets);
    let shown: HashMap<&str, UnreadCountView> = rooms
        .into_iter()
        .map(|room| {
            let counts = if quiet.contains(room.room_id) {
                quiet_unread(room.counts)
            } else {
                apply_badge_mode(
                    room.counts,
                    badge_mode_for(room.is_direct, room.room_override, defaults),
                )
            };
            (room.room_id, counts)
        })
        .collect();
    let mut quiet_room_ids: Vec<String> = quiet.into_iter().map(str::to_owned).collect();
    quiet_room_ids.sort_unstable();
    RoomBadgesView {
        quiet_room_ids,
        badges: shown
            .iter()
            .filter(|(_, counts)| counts.any() || counts.notifying > 0)
            .map(|(id, counts)| ((*id).to_owned(), *counts))
            .collect(),
        space_unread: space_unread_totals(nodes, |id| shown.get(id).copied().unwrap_or_default())
            .into_iter()
            .map(|(id, counts)| (id.to_owned(), counts))
            .collect(),
    }
}

/// The rooms that a hidden space silences: each target, and everything
/// beneath it.
#[must_use]
pub fn quiet_room_ids<'a>(
    nodes: &[SpaceNode<'a>],
    targets: impl IntoIterator<Item = &'a str>,
) -> HashSet<&'a str> {
    let by_id: HashMap<&str, &SpaceNode> = nodes.iter().map(|node| (node.room_id, node)).collect();
    let mut quiet = HashSet::new();
    let mut pending: Vec<&str> = targets.into_iter().collect();
    while let Some(room_id) = pending.pop() {
        let Some((&key, node)) = by_id.get_key_value(room_id) else {
            quiet.insert(room_id);
            continue;
        };
        if quiet.insert(key) {
            pending.extend(node.children.iter().copied());
        }
    }
    quiet
}

/// What each joined space shows: the counts of the joined, non-space rooms
/// beneath it, each room once however many spaces hold it. A space with
/// nothing unread is left out.
#[must_use]
pub fn space_unread_totals<'a>(
    nodes: &[SpaceNode<'a>],
    unread_of: impl Fn(&'a str) -> UnreadCountView,
) -> HashMap<&'a str, UnreadCountView> {
    let joined: HashMap<&str, &SpaceNode> = nodes
        .iter()
        .filter(|node| node.joined)
        .map(|node| (node.room_id, node))
        .collect();

    let mut totals = HashMap::new();
    for space in nodes.iter().filter(|node| node.joined && node.is_space) {
        let mut visited: HashSet<&str> = HashSet::new();
        let mut total = UnreadCountView::default();
        let mut stack = vec![space.room_id];
        while let Some(space_id) = stack.pop() {
            if !visited.insert(space_id) {
                continue;
            }
            let Some(parent) = joined.get(space_id) else {
                continue;
            };
            for &child_id in &parent.children {
                let Some(child) = joined.get(child_id) else {
                    continue;
                };
                if child.is_space {
                    stack.push(child_id);
                } else if visited.insert(child_id) {
                    total = total.plus(unread_of(child.room_id));
                }
            }
        }
        if total.any() {
            totals.insert(space.room_id, total);
        }
    }
    totals
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(unread: u32, notifying: u32, highlight: u32, marked: bool) -> UnreadCountView {
        UnreadCountView {
            unread,
            highlight,
            marked,
            notifying,
        }
    }

    fn room(room_id: &str) -> SpaceNode<'_> {
        SpaceNode {
            room_id,
            joined: true,
            ..SpaceNode::default()
        }
    }

    fn space<'a>(room_id: &'a str, children: &[&'a str]) -> SpaceNode<'a> {
        SpaceNode {
            room_id,
            is_space: true,
            joined: true,
            children: children.to_vec(),
        }
    }

    #[test]
    fn mentions_mode_keeps_unread_and_drops_the_counted_badge() {
        assert_eq!(
            apply_badge_mode(
                counts(6, 6, 1, false),
                Some(BadgeNotificationMode::Mentions)
            ),
            counts(6, 0, 1, false)
        );
    }

    #[test]
    fn quiet_mode_keeps_only_the_mentions() {
        assert_eq!(
            apply_badge_mode(counts(6, 6, 2, false), Some(BadgeNotificationMode::Quiet)),
            counts(2, 0, 2, false)
        );
        assert_eq!(
            apply_badge_mode(counts(6, 6, 0, false), Some(BadgeNotificationMode::Quiet)).unread,
            0
        );
    }

    #[test]
    fn all_mode_promotes_quiet_unread_into_a_counted_badge() {
        assert_eq!(
            apply_badge_mode(counts(6, 0, 0, false), Some(BadgeNotificationMode::All)),
            counts(6, 6, 0, false)
        );
    }

    #[test]
    fn a_muted_room_shows_its_counts_unchanged() {
        let muted = counts(0, 0, 0, true);
        assert_eq!(apply_badge_mode(muted, None), muted);
    }

    #[test]
    fn the_room_override_beats_the_default() {
        let defaults = BadgeDefaults {
            direct: BadgeNotificationMode::All,
            group: BadgeNotificationMode::Mentions,
        };
        let mode = |is_direct, room| badge_mode_for(is_direct, room, defaults);
        assert_eq!(mode(false, None), Some(BadgeNotificationMode::Mentions));
        assert_eq!(mode(true, None), Some(BadgeNotificationMode::All));
        assert_eq!(
            mode(false, Some(NotificationModeView::All)),
            Some(BadgeNotificationMode::All)
        );
        assert_eq!(
            mode(true, Some(NotificationModeView::Mentions)),
            Some(BadgeNotificationMode::Mentions)
        );
        assert_eq!(mode(false, Some(NotificationModeView::Mute)), None);
    }

    #[test]
    fn a_space_sums_nested_rooms_once_each() {
        let nodes = [
            space("!root", &["!sub", "!shared"]),
            space("!sub", &["!deep", "!shared"]),
            room("!deep"),
            room("!shared"),
        ];
        let unread_of = |id: &str| match id {
            "!deep" => counts(4, 4, 1, false),
            _ => counts(2, 2, 2, false),
        };

        let totals = space_unread_totals(&nodes, unread_of);

        assert_eq!(totals.len(), 2);
        assert_eq!(totals["!root"], counts(6, 6, 3, false));
        assert_eq!(totals["!sub"], counts(6, 6, 3, false));
    }

    #[test]
    fn a_space_with_nothing_unread_is_left_out() {
        let nodes = [space("!space", &["!a"]), room("!a")];
        assert!(space_unread_totals(&nodes, |_| counts(0, 0, 0, false)).is_empty());
    }

    #[test]
    fn a_hand_marked_room_dots_its_space() {
        let nodes = [space("!space", &["!a"]), room("!a")];
        let totals = space_unread_totals(&nodes, |_| counts(0, 0, 0, true));
        assert_eq!(totals["!space"], counts(0, 0, 0, true));
    }

    #[test]
    fn unjoined_children_and_cycles_add_nothing() {
        let mut left = room("!left");
        left.joined = false;
        let nodes = [
            space("!root", &["!sub", "!left", "!absent"]),
            space("!sub", &["!root", "!a"]),
            room("!a"),
            left,
        ];
        let totals = space_unread_totals(&nodes, |_| counts(1, 1, 0, false));
        assert_eq!(totals["!root"], counts(1, 1, 0, false));
    }

    #[test]
    fn a_hidden_space_hides_everything_beneath_it() {
        let nodes = [
            space("!root", &["!sub", "!top"]),
            space("!sub", &["!deep", "!root"]),
            room("!top"),
            room("!deep"),
        ];

        let quiet = quiet_room_ids(&nodes, ["!sub"]);
        assert_eq!(quiet, HashSet::from(["!sub", "!deep", "!root", "!top"]));
        assert_eq!(quiet_room_ids(&nodes, ["!top"]), HashSet::from(["!top"]));
        assert_eq!(
            quiet_room_ids(&nodes, ["!unknown"]),
            HashSet::from(["!unknown"])
        );
    }
}
