//! Walks over the space tree as a room list holds it: who sits under a space,
//! which spaces sit over a room, and where a room's `via` comes from.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::spaces::{HierarchyRoomView, RoomJoinRuleView, SpaceChildEdge};

/// Spaces nested deeper than this are not walked upwards.
const MAX_SPACE_DEPTH: usize = 4;

#[derive(Debug, Clone, Copy)]
pub struct SpaceNode<'a> {
    pub room_id: &'a str,
    pub display_name: &'a str,
    pub is_space: bool,
    pub joined: bool,
    pub tombstoned: bool,
    pub children: &'a [SpaceChildEdge],
}

/// A room as the web page sends it, with what a lobby shows of it.
#[derive(Debug, Clone, Default, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(default)]
pub struct SpaceRoomInput {
    pub room_id: String,
    pub display_name: String,
    pub is_space: bool,
    pub joined: bool,
    pub tombstoned: bool,
    pub children: Vec<SpaceChildEdge>,
    pub canonical_alias: Option<String>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    pub join_rule: RoomJoinRuleView,
}

impl SpaceRoomInput {
    #[must_use]
    pub fn node(&self) -> SpaceNode<'_> {
        SpaceNode {
            room_id: &self.room_id,
            display_name: &self.display_name,
            is_space: self.is_space,
            joined: self.joined,
            tombstoned: self.tombstoned,
            children: &self.children,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ParentSpace {
    pub space_id: String,
    pub via: Vec<String>,
}

/// Where a room sits in the spaces this account has joined.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomSpacesView {
    pub room_id: String,
    pub joined: bool,
    /// The joined spaces above the room, the nearest level first.
    pub levels: Vec<Vec<String>>,
    /// The top-level space the room sits under, which tells apart rooms sharing a name.
    pub root_name: Option<String>,
    /// The first joined space listing the room, and the `via` of its edge.
    pub parent: Option<ParentSpace>,
    /// Every space holding the room at any depth, whatever its state.
    pub containing: Vec<String>,
    /// Every joined room and subspace below a joined space, nearest first.
    pub descendants: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SpaceLeaveOrder {
    pub order: Vec<String>,
    pub room_count: u32,
    pub subspace_count: u32,
}

pub struct SpaceGraph<'a> {
    nodes: Vec<SpaceNode<'a>>,
    by_id: HashMap<&'a str, usize>,
    /// Joined spaces listing a room, by position in `nodes`.
    parents: HashMap<&'a str, BTreeSet<usize>>,
    /// The first joined space listing a room, and its edge.
    routing: HashMap<&'a str, (usize, &'a SpaceChildEdge)>,
    /// The first live joined space listing a room.
    name_parents: HashMap<&'a str, usize>,
    /// Every node listing a room whose own node exists.
    holders: HashMap<&'a str, Vec<usize>>,
}

impl<'a> SpaceGraph<'a> {
    #[must_use]
    pub fn new(nodes: Vec<SpaceNode<'a>>) -> Self {
        let by_id: HashMap<&str, usize> = nodes
            .iter()
            .enumerate()
            .map(|(index, node)| (node.room_id, index))
            .collect();
        let mut parents: HashMap<&str, BTreeSet<usize>> = HashMap::new();
        let mut routing = HashMap::new();
        let mut name_parents = HashMap::new();
        let mut holders: HashMap<&str, Vec<usize>> = HashMap::new();
        for (index, node) in nodes.iter().enumerate() {
            for edge in node
                .children
                .iter()
                .filter(|edge| by_id.contains_key(edge.room_id.as_str()))
            {
                holders
                    .entry(edge.room_id.as_str())
                    .or_default()
                    .push(index);
            }
        }
        for (index, space) in nodes
            .iter()
            .enumerate()
            .filter(|(_, node)| node.is_space && node.joined)
        {
            for edge in space.children {
                let room_id = edge.room_id.as_str();
                parents.entry(room_id).or_default().insert(index);
                routing.entry(room_id).or_insert((index, edge));
                if !space.tombstoned {
                    name_parents.entry(room_id).or_insert(index);
                }
            }
        }
        Self {
            nodes,
            by_id,
            parents,
            routing,
            name_parents,
            holders,
        }
    }

    fn node(&self, room_id: &str) -> Option<&SpaceNode<'a>> {
        self.by_id
            .get(room_id)
            .and_then(|index| self.nodes.get(*index))
    }

    fn joined(&self, room_id: &str) -> Option<&SpaceNode<'a>> {
        self.node(room_id).filter(|node| node.joined)
    }

    fn live(&self, room_id: &str) -> Option<&SpaceNode<'a>> {
        self.joined(room_id).filter(|node| !node.tombstoned)
    }

    /// The joined spaces above a room, one level of parents at a time, nearest first.
    #[must_use]
    pub fn ancestor_levels(&self, room_id: &'a str) -> Vec<Vec<&'a str>> {
        let mut levels = Vec::new();
        let mut seen: HashSet<&str> = HashSet::from([room_id]);
        let mut frontier = vec![room_id];

        for _ in 0..MAX_SPACE_DEPTH {
            let found: BTreeSet<usize> = frontier
                .iter()
                .filter_map(|id| self.parents.get(id))
                .flatten()
                .copied()
                .collect();
            frontier = found
                .into_iter()
                .filter_map(|index| self.nodes.get(index))
                .map(|node| node.room_id)
                .filter(|id| !seen.contains(id))
                .collect();
            if frontier.is_empty() {
                break;
            }
            seen.extend(&frontier);
            levels.push(frontier.clone());
        }

        levels
    }

    /// Every joined room and subspace below a space, nearest first.
    #[must_use]
    pub fn descendants(&self, space_id: &'a str) -> Vec<&'a str> {
        let mut seen: HashSet<&str> = HashSet::from([space_id]);
        let mut found = Vec::new();
        let mut frontier = vec![space_id];

        while !frontier.is_empty() {
            let mut next = Vec::new();
            for id in frontier {
                let Some(space) = self.joined(id) else {
                    continue;
                };
                for edge in space.children {
                    let child_id = edge.room_id.as_str();
                    if self.joined(child_id).is_some() && seen.insert(child_id) {
                        found.push(child_id);
                        next.push(child_id);
                    }
                }
            }
            frontier = next;
        }

        found
    }

    #[must_use]
    pub fn root_name(&self, room_id: &'a str) -> Option<&'a str> {
        let mut root = *self.name_parents.get(room_id)?;
        let mut seen: HashSet<&str> = HashSet::from([room_id]);
        while let Some(node) = self
            .nodes
            .get(root)
            .filter(|node| seen.insert(node.room_id))
        {
            let Some(parent) = self.name_parents.get(node.room_id).filter(|parent| {
                self.nodes
                    .get(**parent)
                    .is_some_and(|parent| !seen.contains(parent.room_id))
            }) else {
                break;
            };
            root = *parent;
        }
        self.nodes.get(root).map(|node| node.display_name)
    }

    #[must_use]
    pub fn parent(&self, room_id: &str) -> Option<ParentSpace> {
        let (index, edge) = self.routing.get(room_id)?;
        Some(ParentSpace {
            space_id: self.nodes.get(*index)?.room_id.to_owned(),
            via: edge.via.clone(),
        })
    }

    /// Every joined space and every room a space lists, by id.
    #[must_use]
    pub fn room_spaces(&self) -> Vec<RoomSpacesView> {
        let listed: BTreeSet<&str> = self
            .holders
            .keys()
            .copied()
            .chain(self.parents.keys().copied())
            .chain(
                self.nodes
                    .iter()
                    .filter(|node| node.is_space && node.joined)
                    .map(|node| node.room_id),
            )
            .collect();
        listed
            .into_iter()
            .map(|room_id| {
                let own = self.joined(room_id);
                RoomSpacesView {
                    room_id: room_id.to_owned(),
                    joined: own.is_some(),
                    levels: self
                        .ancestor_levels(room_id)
                        .into_iter()
                        .map(|level| level.into_iter().map(str::to_owned).collect())
                        .collect(),
                    root_name: self.root_name(room_id).map(str::to_owned),
                    parent: self.parent(room_id),
                    containing: self
                        .containing(room_id)
                        .into_iter()
                        .map(str::to_owned)
                        .collect(),
                    descendants: if own.is_some_and(|node| node.is_space) {
                        self.descendants(room_id)
                            .into_iter()
                            .map(str::to_owned)
                            .collect()
                    } else {
                        Vec::new()
                    },
                }
            })
            .collect()
    }

    /// Every space holding a room at any depth, whatever the state of the spaces between.
    #[must_use]
    pub fn containing(&self, room_id: &'a str) -> Vec<&'a str> {
        let mut seen: HashSet<usize> = HashSet::new();
        let mut stack = vec![room_id];
        while let Some(id) = stack.pop() {
            for &holder in self.holders.get(id).into_iter().flatten() {
                if seen.insert(holder)
                    && let Some(node) = self.nodes.get(holder)
                {
                    stack.push(node.room_id);
                }
            }
        }
        let mut holders: Vec<usize> = seen.into_iter().collect();
        holders.sort_unstable();
        holders
            .into_iter()
            .filter_map(|index| self.nodes.get(index))
            .map(|node| node.room_id)
            .collect()
    }

    /// The joined rooms below a space, depth first, subspaces left out.
    #[must_use]
    pub fn joined_space_rooms(&self, space_id: &'a str) -> Vec<&'a str> {
        let mut found = Vec::new();
        if let Some(space) = self.node(space_id) {
            let mut seen = HashSet::from([space_id]);
            self.walk_rooms(space, &mut seen, &mut found);
        }
        found
    }

    fn walk_rooms(
        &self,
        parent: &SpaceNode<'a>,
        seen: &mut HashSet<&'a str>,
        found: &mut Vec<&'a str>,
    ) {
        for edge in parent.children {
            if !seen.insert(edge.room_id.as_str()) {
                continue;
            }
            let Some(child) = self.joined(&edge.room_id) else {
                continue;
            };
            if child.is_space {
                self.walk_rooms(child, seen, found);
            } else {
                found.push(child.room_id);
            }
        }
    }

    /// Rooms before their space, deepest first, the root space itself not included.
    #[must_use]
    pub fn leave_order(&self, root_id: &str) -> SpaceLeaveOrder {
        let mut leave = SpaceLeaveOrder {
            order: Vec::new(),
            room_count: 0,
            subspace_count: 0,
        };
        self.leave_space(root_id, root_id, &mut HashSet::new(), &mut leave);
        leave
    }

    fn leave_space(
        &self,
        space_id: &str,
        root_id: &str,
        visited: &mut HashSet<String>,
        leave: &mut SpaceLeaveOrder,
    ) {
        if !visited.insert(space_id.to_owned()) {
            return;
        }
        let Some(space) = self.live(space_id) else {
            return;
        };

        for edge in space.children {
            if visited.contains(&edge.room_id) {
                continue;
            }
            let Some(child) = self.live(&edge.room_id) else {
                continue;
            };
            if child.is_space {
                self.leave_space(child.room_id, root_id, visited, leave);
                continue;
            }
            visited.insert(child.room_id.to_owned());
            leave.order.push(child.room_id.to_owned());
            leave.room_count += 1;
        }

        if space_id != root_id {
            leave.order.push(space_id.to_owned());
            leave.subspace_count += 1;
        }
    }
}

/// This account's own view of a space and what it holds, breadth first and each room once.
#[must_use]
pub fn local_hierarchy_rooms(rooms: &[SpaceRoomInput], root_id: &str) -> Vec<HierarchyRoomView> {
    let by_id: HashMap<&str, &SpaceRoomInput> = rooms
        .iter()
        .map(|room| (room.room_id.as_str(), room))
        .collect();
    let mut views = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = vec![root_id];

    let mut at = 0;
    while let Some(&room_id) = queue.get(at) {
        at += 1;
        if !seen.insert(room_id) {
            continue;
        }
        let Some(summary) = by_id.get(room_id) else {
            continue;
        };

        let children = if summary.is_space && summary.joined {
            summary.children.as_slice()
        } else {
            &[]
        };
        queue.extend(children.iter().map(|edge| edge.room_id.as_str()));
        views.push(HierarchyRoomView {
            room_id: summary.room_id.clone(),
            canonical_alias: summary.canonical_alias.clone(),
            name: summary.name.clone(),
            topic: summary.topic.clone(),
            avatar_url: summary.avatar_url.clone(),
            is_space: summary.is_space,
            num_joined_members: None,
            join_rule: summary.join_rule,
            allowed_room_ids: Vec::new(),
            guest_can_join: false,
            children: children.to_vec(),
        });
    }

    views
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(room_id: &str) -> SpaceChildEdge {
        SpaceChildEdge {
            room_id: room_id.to_owned(),
            via: vec!["x".to_owned()],
            order: None,
            origin_server_ts: 0,
            suggested: false,
            private: false,
        }
    }

    fn room(room_id: &str) -> SpaceRoomInput {
        SpaceRoomInput {
            room_id: room_id.to_owned(),
            display_name: room_id.to_owned(),
            joined: true,
            ..SpaceRoomInput::default()
        }
    }

    fn space(room_id: &str, children: &[&str]) -> SpaceRoomInput {
        SpaceRoomInput {
            is_space: true,
            children: children.iter().map(|child| edge(child)).collect(),
            ..room(room_id)
        }
    }

    fn graph(rooms: &[SpaceRoomInput]) -> SpaceGraph<'_> {
        SpaceGraph::new(rooms.iter().map(SpaceRoomInput::node).collect())
    }

    fn spaces_of(rooms: &[SpaceRoomInput], room_id: &str) -> RoomSpacesView {
        graph(rooms)
            .room_spaces()
            .into_iter()
            .find(|entry| entry.room_id == room_id)
            .expect("a listed room")
    }

    fn flat(room_spaces: &RoomSpacesView) -> Vec<&str> {
        room_spaces
            .levels
            .iter()
            .rev()
            .flatten()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn leaves_rooms_before_their_space_deepest_first() {
        let rooms = [
            space("!root", &["!a", "!sub"]),
            room("!a"),
            space("!sub", &["!b"]),
            room("!b"),
        ];
        let leave = graph(&rooms).leave_order("!root");

        assert_eq!(leave.order, ["!a", "!b", "!sub"]);
        assert_eq!((leave.room_count, leave.subspace_count), (2, 1));
    }

    #[test]
    fn leave_order_skips_rooms_that_are_not_joined_or_were_replaced() {
        let invited = SpaceRoomInput {
            joined: false,
            ..room("!left")
        };
        let old = SpaceRoomInput {
            tombstoned: true,
            ..room("!old")
        };
        let rooms = [
            space("!root", &["!a", "!left", "!old"]),
            room("!a"),
            invited,
            old,
        ];
        let leave = graph(&rooms).leave_order("!root");

        assert_eq!(leave.order, ["!a"]);
        assert_eq!(leave.room_count, 1);
    }

    #[test]
    fn leave_order_does_not_loop_on_a_cycle() {
        let rooms = [space("!root", &["!sub"]), space("!sub", &["!root"])];
        assert_eq!(graph(&rooms).leave_order("!root").order, ["!sub"]);
    }

    #[test]
    fn an_unjoined_root_leaves_nothing() {
        let rooms = [SpaceRoomInput {
            joined: false,
            ..space("!root", &[])
        }];
        assert_eq!(
            graph(&rooms).leave_order("!root").order,
            Vec::<String>::new()
        );
    }

    #[test]
    fn ancestors_are_every_joined_space_above_the_room_farthest_first() {
        let rooms = [space("!root", &["!mid"]), space("!mid", &["!room"])];
        assert_eq!(flat(&spaces_of(&rooms, "!room")), ["!root", "!mid"]);
    }

    #[test]
    fn ancestor_levels_group_the_parents_at_each_distance() {
        let rooms = [
            space("!root", &["!mid"]),
            space("!mid", &["!room"]),
            space("!other", &["!room"]),
        ];
        assert_eq!(
            spaces_of(&rooms, "!room").levels,
            [vec!["!mid", "!other"], vec!["!root"]]
        );
    }

    #[test]
    fn ancestors_stop_on_a_cycle() {
        let rooms = [space("!a", &["!b"]), space("!b", &["!a"])];
        assert_eq!(flat(&spaces_of(&rooms, "!a")), ["!b"]);
    }

    #[test]
    fn ancestors_stop_at_the_depth_limit() {
        let rooms = [
            space("!s1", &["!s2"]),
            space("!s2", &["!s3"]),
            space("!s3", &["!s4"]),
            space("!s4", &["!s5"]),
            space("!s5", &["!s6"]),
            space("!s6", &["!room"]),
        ];
        assert_eq!(
            flat(&spaces_of(&rooms, "!room")),
            ["!s3", "!s4", "!s5", "!s6"]
        );
    }

    #[test]
    fn descendants_are_every_joined_room_and_subspace_below_nearest_first() {
        let rooms = [
            space("!root", &["!mid", "!a", "!gone"]),
            space("!mid", &["!b", "!root"]),
            room("!a"),
            room("!b"),
        ];
        assert_eq!(graph(&rooms).descendants("!root"), ["!mid", "!a", "!b"]);
    }

    #[test]
    fn root_names_pick_the_top_level_space_through_nesting_and_cycles() {
        let named = |room_id: &str, name: &str, children: &[&str]| SpaceRoomInput {
            display_name: name.to_owned(),
            ..space(room_id, children)
        };
        let rooms = [
            named("!community", "Community", &["!games"]),
            named("!games", "Games", &["!general"]),
            named("!other", "Other", &["!general-2"]),
            named("!a", "A", &["!b"]),
            named("!b", "B", &["!a"]),
            room("!loose"),
        ];
        let name = |room_id: &str| spaces_of(&rooms, room_id).root_name;

        assert_eq!(name("!general").as_deref(), Some("Community"));
        assert_eq!(name("!games").as_deref(), Some("Community"));
        assert_eq!(name("!general-2").as_deref(), Some("Other"));
        assert_eq!(name("!a").as_deref(), Some("B"));
        assert!(
            graph(&rooms)
                .room_spaces()
                .iter()
                .all(|entry| entry.room_id != "!loose")
        );
    }

    #[test]
    fn a_replaced_space_does_not_name_its_rooms() {
        let rooms = [
            SpaceRoomInput {
                tombstoned: true,
                ..space("!old", &["!room"])
            },
            space("!new", &["!room"]),
        ];
        assert_eq!(
            spaces_of(&rooms, "!room").root_name.as_deref(),
            Some("!new")
        );
    }

    #[test]
    fn routing_comes_from_the_first_joined_space_listing_the_room() {
        let unjoined = SpaceRoomInput {
            joined: false,
            ..space("!left", &["!child"])
        };
        let mut listing = space("!space", &["!child"]);
        listing.children[0].via = vec!["a.example".to_owned()];
        let rooms = [unjoined.clone(), listing, room("!child")];

        let parent = spaces_of(&rooms, "!child").parent.expect("a parent");
        assert_eq!(parent.space_id, "!space");
        assert_eq!(parent.via, ["a.example"]);
        let only_unjoined = [unjoined, room("!child")];
        assert!(spaces_of(&only_unjoined, "!child").parent.is_none());
    }

    #[test]
    fn containing_finds_every_space_holding_the_room_at_any_depth() {
        let rooms = [
            space("!root", &["!sub"]),
            space("!sub", &["!voice", "!left"]),
            space("!quiet", &["!left"]),
            room("!voice"),
            SpaceRoomInput {
                joined: false,
                ..room("!left")
            },
        ];
        let room_spaces = spaces_of(&rooms, "!voice");
        assert_eq!(room_spaces.containing, ["!root", "!sub"]);
        assert_eq!(
            spaces_of(&rooms, "!left").containing,
            ["!root", "!sub", "!quiet"]
        );
    }

    #[test]
    fn joined_space_rooms_walk_subspaces_and_skip_what_is_not_joined() {
        let rooms = [
            space("!root", &["!a", "!sub", "!left", "!a"]),
            room("!a"),
            space("!sub", &["!b", "!root"]),
            room("!b"),
            SpaceRoomInput {
                joined: false,
                ..room("!left")
            },
        ];
        assert_eq!(graph(&rooms).joined_space_rooms("!root"), ["!a", "!b"]);
    }

    #[test]
    fn the_local_tree_is_walked_from_this_accounts_own_state() {
        let rooms = [
            space("!space", &["!a", "!sub"]),
            room("!a"),
            space("!sub", &["!nested"]),
            room("!nested"),
            room("!elsewhere"),
        ];
        let local = local_hierarchy_rooms(&rooms, "!space");

        let ids: Vec<_> = local.iter().map(|room| room.room_id.as_str()).collect();
        assert_eq!(ids, ["!space", "!a", "!sub", "!nested"]);
        assert!(local.iter().all(|room| room.num_joined_members.is_none()));
    }

    #[test]
    fn a_space_this_account_has_left_contributes_no_children() {
        let rooms = [
            SpaceRoomInput {
                joined: false,
                ..space("!space", &["!a"])
            },
            room("!a"),
        ];
        let local = local_hierarchy_rooms(&rooms, "!space");
        assert_eq!(local.len(), 1);
    }

    #[test]
    fn a_local_cycle_terminates() {
        let rooms = [space("!space", &["!sub"]), space("!sub", &["!space"])];
        let local = local_hierarchy_rooms(&rooms, "!space");
        assert_eq!(local.len(), 2);
    }
}
