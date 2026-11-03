//! The sidebar's sections, favourites, space trees and badges, built from the room list rows.

use std::collections::{BTreeMap, HashMap, HashSet};

use icu_normalizer::DecomposingNormalizerBorrowed;
use icu_normalizer::properties::CanonicalCombiningClassMapBorrowed;
use matrix_sdk::ruma::OwnedRoomId;

use crate::api::rooms::RoomKind;
use crate::protocol::{
    BadgeModeView, NotificationModeView, RoomBadgeView, RoomListItemView, RoomListOptionsView,
    RoomSectionView, RoomSectionsUpdate, RoomSortView, RoomStateView, RoomTag, RoomUnreadView,
    SpaceTreeNodeView,
};

pub(crate) const HOME: &str = "home";
pub(crate) const UNSPACED: &str = "unspaced";
pub(crate) const DIRECT: &str = "direct";

type Row = RoomListItemView;

#[derive(Debug, Default)]
pub(crate) struct RoomSections {
    sections: BTreeMap<String, RoomSectionView>,
    badges: Vec<RoomBadgeView>,
    quiet_rooms: Vec<OwnedRoomId>,
}

impl RoomSections {
    pub(crate) fn build(rows: &[Row], options: &RoomListOptionsView) -> Self {
        let lists = Lists::new(rows, options);
        let mut sections = BTreeMap::new();
        for section in [lists.home(), lists.unspaced(), lists.direct()] {
            sections.insert(section.key.clone(), section);
        }
        for space in rows.iter().filter(|row| joined(row) && is_space(row)) {
            let section = lists.space(space);
            sections.insert(section.key.clone(), section);
        }

        let mut quiet_rooms: Vec<_> = lists
            .quiet
            .iter()
            .filter_map(|id| OwnedRoomId::try_from(*id).ok())
            .collect();
        quiet_rooms.sort_unstable();
        let badges = rows
            .iter()
            .filter_map(|row| {
                let counts = lists.badge(row);
                (counts != RoomUnreadView::default()).then(|| RoomBadgeView {
                    room_id: row.room_id.clone(),
                    counts,
                })
            })
            .collect();

        Self {
            sections,
            badges,
            quiet_rooms,
        }
    }

    pub(crate) fn update(&mut self, next: Self) -> Option<RoomSectionsUpdate> {
        let sections: Vec<_> = next
            .sections
            .values()
            .filter(|section| self.sections.get(&section.key) != Some(section))
            .cloned()
            .collect();
        let removed: Vec<_> = self
            .sections
            .keys()
            .filter(|key| !next.sections.contains_key(*key))
            .cloned()
            .collect();
        let badges = (self.badges != next.badges).then(|| next.badges.clone());
        let quiet_rooms = (self.quiet_rooms != next.quiet_rooms).then(|| next.quiet_rooms.clone());
        *self = next;

        let update = RoomSectionsUpdate {
            sections,
            removed,
            badges,
            quiet_rooms,
        };
        (update != RoomSectionsUpdate::default()).then_some(update)
    }
}

const fn joined(row: &Row) -> bool {
    matches!(row.state, RoomStateView::Joined)
}

const fn invited(row: &Row) -> bool {
    matches!(row.state, RoomStateView::Invited)
}

fn is_space(row: &Row) -> bool {
    row.room_kind == Some(RoomKind::Space)
}

fn favourite(row: &Row) -> bool {
    row.tags.iter().any(|tag| matches!(tag, RoomTag::Favourite))
}

const fn has_unread(counts: RoomUnreadView) -> bool {
    counts.unread > 0 || counts.highlight > 0 || counts.marked
}

const fn add_unread(total: &mut RoomUnreadView, counts: RoomUnreadView) {
    total.unread = total.unread.saturating_add(counts.unread);
    total.notifying = total.notifying.saturating_add(counts.notifying);
    total.highlight = total.highlight.saturating_add(counts.highlight);
    total.marked |= counts.marked;
}

/// A muted room's counts are already empty.
fn badge_counts(row: &Row, quiet: bool, options: &RoomListOptionsView) -> RoomUnreadView {
    let counts = row.counts;
    let mode = match row.notification.room {
        Some(NotificationModeView::Mute) => return counts,
        Some(NotificationModeView::All) => BadgeModeView::All,
        Some(NotificationModeView::Mentions) => BadgeModeView::Mentions,
        None if row.is_direct => options.badge_default_direct,
        None => options.badge_default_group,
    };
    match if quiet { BadgeModeView::Quiet } else { mode } {
        BadgeModeView::Quiet => RoomUnreadView {
            unread: counts.highlight,
            notifying: 0,
            ..counts
        },
        BadgeModeView::Mentions => RoomUnreadView {
            notifying: 0,
            ..counts
        },
        BadgeModeView::All => RoomUnreadView {
            notifying: counts.notifying.max(counts.unread),
            ..counts
        },
    }
}

/// Case and accents aside, like a base-sensitivity `localeCompare`.
fn name_key(name: &str) -> String {
    let combining = CanonicalCombiningClassMapBorrowed::new();
    DecomposingNormalizerBorrowed::new_nfd()
        .normalize_iter(name.chars())
        .filter(|c| combining.get_u8(*c) == 0)
        .flat_map(char::to_lowercase)
        .collect()
}

struct Lists<'a> {
    options: &'a RoomListOptionsView,
    rows: &'a [Row],
    by_id: HashMap<&'a str, &'a Row>,
    position: HashMap<&'a str, usize>,
    quiet: HashSet<&'a str>,
    claimed: HashSet<&'a str>,
}

impl<'a> Lists<'a> {
    fn new(rows: &'a [Row], options: &'a RoomListOptionsView) -> Self {
        let by_id: HashMap<_, _> = rows.iter().map(|row| (row.room_id.as_str(), row)).collect();
        let position = rows
            .iter()
            .enumerate()
            .map(|(index, row)| (row.room_id.as_str(), index))
            .collect();

        let mut quiet = HashSet::new();
        let mut stack: Vec<&str> = options.quiet_rooms.iter().map(|id| id.as_str()).collect();
        while let Some(room_id) = stack.pop() {
            if !quiet.insert(room_id) {
                continue;
            }
            if let Some(row) = by_id.get(room_id) {
                stack.extend(row.space_children.iter().map(|edge| edge.room_id.as_str()));
            }
        }

        let claimed = rows
            .iter()
            .filter(|row| is_space(row) && joined(row) && !row.is_tombstoned)
            .flat_map(|space| &space.space_children)
            .filter(|edge| !edge.via.is_empty())
            .map(|edge| edge.room_id.as_str())
            .collect();

        Self {
            options,
            rows,
            by_id,
            position,
            quiet,
            claimed,
        }
    }

    fn badge(&self, row: &Row) -> RoomUnreadView {
        badge_counts(row, self.quiet.contains(row.room_id.as_str()), self.options)
    }

    fn grouped(&self, key: &str) -> bool {
        !self
            .options
            .ungrouped_favourites
            .iter()
            .any(|view| view == key)
    }

    fn sort(&self, rows: &mut [&'a Row], sort: RoomSortView) {
        match sort {
            RoomSortView::Recent => {
                rows.sort_by_key(|row| self.position.get(row.room_id.as_str()).copied());
            }
            RoomSortView::NameAsc | RoomSortView::NameDesc => {
                let mut keyed: Vec<_> = rows
                    .iter()
                    .map(|row| (name_key(&row.display_name), *row))
                    .collect();
                if sort == RoomSortView::NameAsc {
                    keyed.sort_by(|left, right| left.0.cmp(&right.0));
                } else {
                    keyed.sort_by(|left, right| right.0.cmp(&left.0));
                }
                for (slot, (_, row)) in rows.iter_mut().zip(keyed) {
                    *slot = row;
                }
            }
        }
    }

    fn listed(&self, keep: impl Fn(&Row) -> bool) -> Vec<&'a Row> {
        self.rows
            .iter()
            .filter(|row| joined(row) && !row.is_tombstoned && keep(row))
            .collect()
    }

    fn invites(&self, keep: impl Fn(&Row) -> bool) -> Vec<OwnedRoomId> {
        self.rows
            .iter()
            .filter(|row| invited(row) && keep(row))
            .map(|row| row.room_id.clone())
            .collect()
    }

    fn home(&self) -> RoomSectionView {
        let listed = self.listed(|row| !is_space(row));
        self.flat(HOME, listed, self.options.room_sort, self.invites(|_| true))
    }

    fn unspaced(&self) -> RoomSectionView {
        let unspaced = |row: &Row| !row.is_direct && !self.claimed.contains(row.room_id.as_str());
        let listed = self.listed(|row| !is_space(row) && unspaced(row));
        self.flat(
            UNSPACED,
            listed,
            self.options.room_sort,
            self.invites(unspaced),
        )
    }

    fn direct(&self) -> RoomSectionView {
        let listed = self.listed(|row| row.is_direct);
        self.flat(
            DIRECT,
            listed,
            self.options.direct_sort,
            self.invites(|row| row.is_direct),
        )
    }

    fn flat(
        &self,
        key: &str,
        mut listed: Vec<&'a Row>,
        sort: RoomSortView,
        invites: Vec<OwnedRoomId>,
    ) -> RoomSectionView {
        self.sort(&mut listed, sort);
        let grouped = self.grouped(key);
        let (favourites, rooms): (Vec<_>, Vec<_>) = listed
            .into_iter()
            .partition(|row| grouped && favourite(row));

        let mut unread = RoomUnreadView::default();
        let mut unread_rooms = Vec::new();
        for row in favourites.iter().chain(&rooms) {
            let counts = self.badge(row);
            add_unread(&mut unread, counts);
            if has_unread(counts) {
                unread_rooms.push(row.room_id.clone());
            }
        }

        RoomSectionView {
            key: key.to_owned(),
            favourites: favourites.iter().map(|row| row.room_id.clone()).collect(),
            rooms: rooms.iter().map(|row| row.room_id.clone()).collect(),
            subspaces: Vec::new(),
            calendars: Vec::new(),
            invites,
            unread,
            unread_rooms,
            descendants: Vec::new(),
        }
    }

    fn space(&self, space: &'a Row) -> RoomSectionView {
        let key = space.room_id.as_str();
        let tree = SpaceTree::new(self.rows, self.options.subspace_depth).build(space);
        let calendars = tree
            .iter()
            .filter_map(|node| match node {
                SpaceTreeNodeView::Room { room_id, .. } => Some(room_id),
                _ => None,
            })
            .filter(|room_id| {
                self.by_id
                    .get(room_id.as_str())
                    .is_some_and(|row| row.room_kind == Some(RoomKind::Calendar))
            })
            .cloned()
            .collect();

        let grouped = self.grouped(key);
        let mut favourites = Vec::new();
        if grouped {
            let mut seen = HashSet::new();
            tree_rooms(&tree, &mut |room_id| {
                if let Some(row) = self.by_id.get(room_id.as_str())
                    && favourite(row)
                    && seen.insert(room_id.as_str())
                {
                    favourites.push(*row);
                }
            });
            self.sort(&mut favourites, self.options.room_sort);
        }
        let shown = if grouped {
            self.without_favourites(tree)
        } else {
            tree
        };
        let (rooms, subspaces): (Vec<_>, Vec<_>) = shown
            .into_iter()
            .partition(|node| matches!(node, SpaceTreeNodeView::Room { .. }));
        let rooms = rooms
            .into_iter()
            .filter_map(|node| match node {
                SpaceTreeNodeView::Room { room_id, .. } => Some(room_id),
                _ => None,
            })
            .collect();

        let children: HashSet<_> = space
            .space_children
            .iter()
            .map(|edge| edge.room_id.as_str())
            .collect();
        let (unread, unread_rooms, descendants) = self.space_totals(space);

        RoomSectionView {
            key: key.to_owned(),
            favourites: favourites.iter().map(|row| row.room_id.clone()).collect(),
            rooms,
            subspaces,
            calendars,
            invites: self.invites(|row| children.contains(row.room_id.as_str())),
            unread,
            unread_rooms,
            descendants,
        }
    }

    fn without_favourites(&self, nodes: Vec<SpaceTreeNodeView>) -> Vec<SpaceTreeNodeView> {
        nodes
            .into_iter()
            .filter_map(|node| match node {
                SpaceTreeNodeView::Room { ref room_id, .. } => {
                    let fav = self
                        .by_id
                        .get(room_id.as_str())
                        .is_some_and(|row| favourite(row));
                    (!fav).then_some(node)
                }
                SpaceTreeNodeView::Link { .. } => Some(node),
                SpaceTreeNodeView::Category {
                    room_id,
                    key,
                    depth,
                    children,
                } => {
                    let children = self.without_favourites(children);
                    (!children.is_empty()).then_some(SpaceTreeNodeView::Category {
                        room_id,
                        key,
                        depth,
                        children,
                    })
                }
            })
            .collect()
    }

    fn space_totals(&self, space: &Row) -> (RoomUnreadView, Vec<OwnedRoomId>, Vec<OwnedRoomId>) {
        let mut visited = HashSet::new();
        let mut descendants = Vec::new();
        self.collect_descendants(space.room_id.as_str(), &mut visited, &mut descendants);

        let mut unread = RoomUnreadView::default();
        let mut unread_rooms = Vec::new();
        for row in &descendants {
            let counts = self.badge(row);
            add_unread(&mut unread, counts);
            if has_unread(counts) {
                unread_rooms.push(row.room_id.clone());
            }
        }
        let descendants = descendants.iter().map(|row| row.room_id.clone()).collect();
        (unread, unread_rooms, descendants)
    }

    fn collect_descendants(
        &self,
        space_id: &'a str,
        visited: &mut HashSet<&'a str>,
        found: &mut Vec<&'a Row>,
    ) {
        if !visited.insert(space_id) {
            return;
        }
        let Some(space) = self.by_id.get(space_id).filter(|row| joined(row)) else {
            return;
        };
        for edge in &space.space_children {
            let Some(child) = self
                .by_id
                .get(edge.room_id.as_str())
                .filter(|row| joined(row))
            else {
                continue;
            };
            if is_space(child) {
                self.collect_descendants(child.room_id.as_str(), visited, found);
            } else if visited.insert(child.room_id.as_str()) {
                found.push(child);
            }
        }
    }
}

fn tree_rooms<'n>(nodes: &'n [SpaceTreeNodeView], visit: &mut impl FnMut(&'n OwnedRoomId)) {
    for node in nodes {
        match node {
            SpaceTreeNodeView::Room { room_id, .. } => visit(room_id),
            SpaceTreeNodeView::Category { children, .. } => tree_rooms(children, visit),
            SpaceTreeNodeView::Link { .. } => {}
        }
    }
}

struct SpaceTree<'a> {
    by_id: HashMap<&'a str, &'a Row>,
    limit: u32,
    holding: HashMap<&'a str, bool>,
}

impl<'a> SpaceTree<'a> {
    fn new(rows: &'a [Row], limit: u32) -> Self {
        let by_id = rows
            .iter()
            .filter(|row| joined(row) && !(is_space(row) && row.is_tombstoned))
            .map(|row| (row.room_id.as_str(), row))
            .collect();
        Self {
            by_id,
            limit,
            holding: HashMap::new(),
        }
    }

    fn build(mut self, root: &'a Row) -> Vec<SpaceTreeNodeView> {
        self.walk(root, 0, &[root.room_id.as_str()])
    }

    fn holds_room(&mut self, space: &'a Row, seen: &mut HashSet<&'a str>) -> bool {
        let id = space.room_id.as_str();
        if let Some(known) = self.holding.get(id) {
            return *known;
        }
        if !seen.insert(id) {
            return false;
        }
        let mut holds = false;
        for edge in &space.space_children {
            let Some(child) = self.by_id.get(edge.room_id.as_str()).copied() else {
                continue;
            };
            if !is_space(child) || self.holds_room(child, seen) {
                holds = true;
                break;
            }
        }
        seen.remove(id);
        self.holding.insert(id, holds);
        holds
    }

    fn walk(&mut self, space: &'a Row, depth: u32, ancestry: &[&'a str]) -> Vec<SpaceTreeNodeView> {
        let indent = depth.saturating_sub(1);
        let path = |room_id: &str| {
            let mut parts = ancestry.to_vec();
            parts.push(room_id);
            parts.join("/")
        };
        let mut nodes = Vec::new();

        for edge in &space.space_children {
            let Some(room) = self.by_id.get(edge.room_id.as_str()) else {
                continue;
            };
            if is_space(room) {
                continue;
            }
            nodes.push(SpaceTreeNodeView::Room {
                room_id: room.room_id.clone(),
                key: path(room.room_id.as_str()),
                depth: indent,
            });
        }

        for edge in &space.space_children {
            let Some(child) = self.by_id.get(edge.room_id.as_str()).copied() else {
                continue;
            };
            let id = child.room_id.as_str();
            if !is_space(child) || ancestry.contains(&id) {
                continue;
            }
            if !self.holds_room(child, &mut HashSet::new()) {
                continue;
            }
            let child_depth = depth + 1;
            let key = path(id);
            if child_depth >= self.limit {
                nodes.push(SpaceTreeNodeView::Link {
                    room_id: child.room_id.clone(),
                    key,
                    depth: indent,
                });
            } else {
                let mut nested = ancestry.to_vec();
                nested.push(id);
                nodes.push(SpaceTreeNodeView::Category {
                    room_id: child.room_id.clone(),
                    key,
                    depth: indent,
                    children: self.walk(child, child_depth, &nested),
                });
            }
        }

        nodes
    }
}

#[cfg(test)]
#[path = "room_sections_tests.rs"]
mod tests;
