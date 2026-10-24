//! A space lobby: the space's hierarchy as sections of rooms, one per
//! (sub)space, and which rooms the reader could join from it.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RoomJoinRuleView {
    Public,
    Invite,
    Knock,
    /// Members of an allowed space may join.
    Restricted,
    KnockRestricted,
    Private,
    /// Not loaded, or a rule this client has no name for.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SpaceChildEdge {
    pub room_id: String,
    pub via: Vec<String>,
    /// `m.space.child.content.order`, unordered children sort last.
    pub order: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub origin_server_ts: u64,
    /// The parent marked this child as worth surfacing first.
    pub suggested: bool,
}

/// A room as the lobby knows it, from the server's hierarchy or the local room
/// list; a local room has no member count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct HierarchyRoomView {
    pub room_id: String,
    pub canonical_alias: Option<String>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    pub is_space: bool,
    pub num_joined_members: Option<u32>,
    pub join_rule: RoomJoinRuleView,
    pub allowed_room_ids: Vec<String>,
    pub guest_can_join: bool,
    pub children: Vec<SpaceChildEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct HierarchyRoom {
    pub room: HierarchyRoomView,
    pub suggested: bool,
    pub via: Vec<String>,
    /// The path from the root, so a room listed under two spaces has two keys.
    pub key: String,
    /// What the reader can do to get in from this section, joined or not.
    pub action: Option<LobbyAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct HierarchySection {
    /// `None` for the root's own rooms.
    pub space: Option<HierarchyRoomView>,
    pub suggested: bool,
    pub depth: u32,
    pub key: String,
    pub rooms: Vec<HierarchyRoom>,
    pub parent_id: String,
    pub owner_id: Option<String>,
    pub siblings: Vec<SpaceChildEdge>,
    pub loaded: bool,
    pub failed: bool,
    /// Children named by an edge that the hierarchy has not described yet.
    pub pending: u32,
    /// What the reader can do to get into `space` from its owner.
    pub space_action: Option<LobbyAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct JoinCandidate {
    pub room: HierarchyRoomView,
    pub via: Vec<String>,
    pub parent_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum LobbyAction {
    Join,
    Knock,
}

/// What the sections depend on besides the rooms. `loaded: None` treats every
/// level as described; `keep_empty` names subspaces shown even without rooms.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(default)]
pub struct SectionInputs {
    pub loaded: Option<HashSet<String>>,
    pub failed: HashSet<String>,
    pub keep_empty: HashSet<String>,
    pub joined: HashSet<String>,
    pub invited: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ChildOrderOverride {
    pub parent_id: String,
    pub children: Vec<SpaceChildEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SuggestedOverride {
    pub parent_id: String,
    pub room_id: String,
    pub suggested: bool,
}

#[must_use]
pub const fn lobby_action(
    join_rule: RoomJoinRuleView,
    invited: bool,
    in_parent: bool,
) -> Option<LobbyAction> {
    if invited {
        return Some(LobbyAction::Join);
    }
    match join_rule {
        RoomJoinRuleView::Public => Some(LobbyAction::Join),
        RoomJoinRuleView::Restricted | RoomJoinRuleView::KnockRestricted if in_parent => {
            Some(LobbyAction::Join)
        }
        RoomJoinRuleView::KnockRestricted | RoomJoinRuleView::Knock => Some(LobbyAction::Knock),
        _ => None,
    }
}

/// A restricted room admits members of the rooms it names, or of its parent
/// when it names none.
fn in_allow_list(room: &HierarchyRoomView, joined: &HashSet<String>, parent_id: &str) -> bool {
    if room.allowed_room_ids.is_empty() {
        joined.contains(parent_id)
    } else {
        room.allowed_room_ids.iter().any(|id| joined.contains(id))
    }
}

/// Each room the reader could join outright and has not, once, from the first
/// section that lists it.
#[must_use]
pub fn join_candidates<S: std::hash::BuildHasher>(
    sections: &[HierarchySection],
    joined: &HashSet<String, S>,
) -> Vec<JoinCandidate> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let mut consider =
        |room: &HierarchyRoomView, action: Option<LobbyAction>, via: &[String], parent_id: &str| {
            if joined.contains(&room.room_id) || !seen.insert(room.room_id.clone()) {
                return;
            }
            if action == Some(LobbyAction::Join) {
                candidates.push(JoinCandidate {
                    room: room.clone(),
                    via: via.to_vec(),
                    parent_id: parent_id.to_owned(),
                });
            }
        };
    for section in sections {
        if let (Some(space), Some(owner_id)) = (&section.space, &section.owner_id) {
            consider(space, section.space_action, &[], owner_id);
        }
        for entry in &section.rooms {
            consider(&entry.room, entry.action, &entry.via, &section.parent_id);
        }
    }
    candidates
}

/// The server's rooms, with what the local room list knows laid over them.
#[must_use]
pub fn merge_hierarchy_rooms(
    local: &[HierarchyRoomView],
    fetched: &[HierarchyRoomView],
) -> Vec<HierarchyRoomView> {
    let mut merged: Vec<HierarchyRoomView> = Vec::with_capacity(fetched.len() + local.len());
    for room in fetched {
        match merged.iter_mut().find(|held| held.room_id == room.room_id) {
            Some(held) => *held = room.clone(),
            None => merged.push(room.clone()),
        }
    }
    for room in local {
        let Some(chunk) = merged.iter_mut().find(|held| held.room_id == room.room_id) else {
            merged.push(room.clone());
            continue;
        };
        *chunk = HierarchyRoomView {
            name: room.name.clone().or_else(|| chunk.name.take()),
            topic: room.topic.clone().or_else(|| chunk.topic.take()),
            avatar_url: room.avatar_url.clone().or_else(|| chunk.avatar_url.take()),
            canonical_alias: room
                .canonical_alias
                .clone()
                .or_else(|| chunk.canonical_alias.take()),
            num_joined_members: chunk.num_joined_members,
            guest_can_join: chunk.guest_can_join,
            children: {
                let mut children = std::mem::take(&mut chunk.children);
                for edge in &room.children {
                    match children
                        .iter_mut()
                        .find(|held| held.room_id == edge.room_id)
                    {
                        Some(held) => *held = edge.clone(),
                        None => children.push(edge.clone()),
                    }
                }
                children.retain(|edge| !edge.via.is_empty());
                children
            },
            ..room.clone()
        };
    }
    merged
}

struct Walk<'a> {
    by_id: std::collections::HashMap<&'a str, &'a HierarchyRoomView>,
    inputs: &'a SectionInputs,
    sections: Vec<HierarchySection>,
}

impl Walk<'_> {
    fn described(&self, space_id: &str) -> bool {
        self.inputs
            .loaded
            .as_ref()
            .is_none_or(|loaded| loaded.contains(space_id))
    }

    fn action(&self, room: &HierarchyRoomView, parent_id: &str) -> Option<LobbyAction> {
        lobby_action(
            room.join_rule,
            self.inputs.invited.contains(&room.room_id),
            in_allow_list(room, &self.inputs.joined, parent_id),
        )
    }

    fn walk(
        &mut self,
        space_id: &str,
        space: Option<&HierarchyRoomView>,
        suggested: bool,
        depth: u32,
        ancestry: &[String],
    ) {
        let Some(&current) = self.by_id.get(space_id) else {
            return;
        };
        let mut own_rooms = Vec::new();
        let mut subspaces: Vec<(&HierarchyRoomView, bool)> = Vec::new();
        let mut pending = 0;
        for edge in &current.children {
            let Some(&child) = self.by_id.get(edge.room_id.as_str()) else {
                pending += 1;
                continue;
            };
            if child.is_space {
                subspaces.push((child, edge.suggested));
                continue;
            }
            own_rooms.push(HierarchyRoom {
                room: child.clone(),
                suggested: edge.suggested,
                via: edge.via.clone(),
                key: [ancestry, std::slice::from_ref(&child.room_id)]
                    .concat()
                    .join("/"),
                action: self.action(child, space_id),
            });
        }
        let described = self.described(space_id);
        let failed = self.inputs.failed.contains(space_id);
        let kept = space.is_some() && self.inputs.keep_empty.contains(space_id);
        if !own_rooms.is_empty() || !described || failed || kept {
            let owner_id = ancestry
                .len()
                .checked_sub(2)
                .and_then(|at| ancestry.get(at))
                .cloned();
            let space_action = space
                .zip(owner_id.as_deref())
                .and_then(|(space, owner_id)| self.action(space, owner_id));
            self.sections.push(HierarchySection {
                space: space.cloned(),
                suggested,
                depth,
                key: ancestry.join("/"),
                rooms: own_rooms,
                parent_id: space_id.to_owned(),
                owner_id,
                siblings: current.children.clone(),
                loaded: described,
                failed,
                pending,
                space_action,
            });
        }
        for (subspace, suggested) in subspaces {
            if ancestry.contains(&subspace.room_id) {
                continue;
            }
            let ancestry = [ancestry, std::slice::from_ref(&subspace.room_id)].concat();
            self.walk(
                &subspace.room_id,
                Some(subspace),
                suggested,
                depth + 1,
                &ancestry,
            );
        }
    }
}

/// The root's rooms, then each subspace depth first; empty sections are left out unless loading, failed or in `keep_empty`.
#[must_use]
pub fn build_hierarchy_sections(
    rooms: &[HierarchyRoomView],
    root_id: &str,
    inputs: &SectionInputs,
) -> Vec<HierarchySection> {
    let mut walk = Walk {
        by_id: rooms
            .iter()
            .map(|room| (room.room_id.as_str(), room))
            .collect(),
        inputs,
        sections: Vec::new(),
    };
    walk.walk(root_id, None, false, 0, &[root_id.to_owned()]);
    walk.sections
}

#[must_use]
pub fn apply_child_overrides(
    rooms: &[HierarchyRoomView],
    overrides: &[ChildOrderOverride],
) -> Vec<HierarchyRoomView> {
    rooms
        .iter()
        .map(|room| {
            let reordered = overrides
                .iter()
                .rev()
                .find(|reorder| reorder.parent_id == room.room_id);
            reordered.map_or_else(
                || room.clone(),
                |reorder| HierarchyRoomView {
                    children: reorder.children.clone(),
                    ..room.clone()
                },
            )
        })
        .collect()
}

#[must_use]
pub fn apply_suggested_overrides(
    rooms: &[HierarchyRoomView],
    overrides: &[SuggestedOverride],
) -> Vec<HierarchyRoomView> {
    rooms
        .iter()
        .map(|room| {
            let mut room = room.clone();
            for edge in &mut room.children {
                if let Some(change) = overrides.iter().find(|change| {
                    change.parent_id == room.room_id && change.room_id == edge.room_id
                }) {
                    edge.suggested = change.suggested;
                }
            }
            room
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(room_id: &str, suggested: bool) -> SpaceChildEdge {
        SpaceChildEdge {
            room_id: room_id.to_owned(),
            via: vec!["x".to_owned()],
            order: None,
            origin_server_ts: 0,
            suggested,
        }
    }

    fn room(room_id: &str, children: &[&str]) -> HierarchyRoomView {
        HierarchyRoomView {
            room_id: room_id.to_owned(),
            canonical_alias: None,
            name: None,
            topic: None,
            avatar_url: None,
            is_space: !children.is_empty() || room_id.starts_with("!space"),
            num_joined_members: None,
            join_rule: RoomJoinRuleView::Public,
            allowed_room_ids: Vec::new(),
            guest_can_join: false,
            children: children.iter().map(|child| edge(child, false)).collect(),
        }
    }

    fn keys(sections: &[HierarchySection]) -> Vec<(String, Vec<String>, u32)> {
        sections
            .iter()
            .map(|section| {
                (
                    section.key.clone(),
                    section.rooms.iter().map(|room| room.key.clone()).collect(),
                    section.pending,
                )
            })
            .collect()
    }

    #[test]
    fn sections_walk_subspaces_depth_first_and_count_what_is_missing() {
        let rooms = [
            room("!root", &["!a", "!space1", "!gone"]),
            room("!a", &[]),
            room("!space1", &["!b", "!root"]),
            room("!b", &[]),
        ];
        let sections = build_hierarchy_sections(&rooms, "!root", &SectionInputs::default());
        assert_eq!(
            keys(&sections),
            [
                ("!root".to_owned(), vec!["!root/!a".to_owned()], 1),
                (
                    "!root/!space1".to_owned(),
                    vec!["!root/!space1/!b".to_owned()],
                    0
                ),
            ]
        );
        assert_eq!(sections[1].owner_id.as_deref(), Some("!root"));
    }

    #[test]
    fn an_empty_level_shows_while_loading_failed_or_kept() {
        let rooms = [room("!root", &["!space1"]), room("!space1", &["!c"])];
        let loading = SectionInputs {
            loaded: Some(["!root".to_owned()].into()),
            ..SectionInputs::default()
        };
        let sections = build_hierarchy_sections(&rooms, "!root", &loading);
        assert_eq!(
            keys(&sections),
            [("!root/!space1".to_owned(), Vec::new(), 1)]
        );
        assert!(!sections[0].loaded);

        let loaded = SectionInputs {
            loaded: Some(["!root".to_owned(), "!space1".to_owned()].into()),
            ..SectionInputs::default()
        };
        assert_eq!(
            build_hierarchy_sections(&rooms, "!root", &loaded),
            [] as [crate::spaces::HierarchySection; 0]
        );
        let kept = SectionInputs {
            keep_empty: ["!space1".to_owned()].into(),
            ..loaded
        };
        assert_eq!(build_hierarchy_sections(&rooms, "!root", &kept).len(), 1);
    }

    #[test]
    fn local_rooms_lay_over_the_servers() {
        let mut fetched = room("!a", &[]);
        fetched.name = Some("Server".to_owned());
        fetched.topic = Some("t".to_owned());
        fetched.num_joined_members = Some(4);
        let mut local = room("!a", &[]);
        local.name = Some("Local".to_owned());
        let merged = merge_hierarchy_rooms(&[local, room("!b", &[])], &[fetched]);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].name.as_deref(), Some("Local"));
        assert_eq!(merged[0].topic.as_deref(), Some("t"));
        assert_eq!(merged[0].num_joined_members, Some(4));
    }

    #[test]
    fn empty_local_children_preserve_fetched_rooms_and_subspaces() {
        let fetched = [
            room("!root", &["!a", "!space1"]),
            room("!a", &[]),
            room("!space1", &["!b"]),
            room("!b", &[]),
        ];
        let merged = merge_hierarchy_rooms(&[room("!root", &[])], &fetched);
        assert_eq!(
            merged[0].children,
            [edge("!a", false), edge("!space1", false)]
        );
        let sections = build_hierarchy_sections(&merged, "!root", &SectionInputs::default());
        assert_eq!(
            keys(&sections),
            [
                ("!root".to_owned(), vec!["!root/!a".to_owned()], 0),
                (
                    "!root/!space1".to_owned(),
                    vec!["!root/!space1/!b".to_owned()],
                    0
                ),
            ]
        );
    }

    #[test]
    fn partial_local_children_update_metadata_and_preserve_fetched_edges() {
        let fetched = [room("!root", &["!a", "!space1"])];
        let mut local = room("!root", &["!a"]);
        local.children[0].suggested = true;
        local.children[0].via = vec!["local.example".to_owned()];

        let merged = merge_hierarchy_rooms(&[local], &fetched);

        assert_eq!(
            merged[0].children,
            [
                SpaceChildEdge {
                    via: vec!["local.example".to_owned()],
                    ..edge("!a", true)
                },
                edge("!space1", false),
            ]
        );
    }

    #[test]
    fn new_local_children_are_added_alongside_fetched_edges() {
        let fetched = [room("!root", &["!a", "!space1"])];
        let local = room("!root", &["!a", "!c"]);

        let merged = merge_hierarchy_rooms(&[local], &fetched);

        assert_eq!(
            merged[0].children,
            [edge("!a", false), edge("!space1", false), edge("!c", false)]
        );
    }

    #[test]
    fn an_explicitly_removed_child_does_not_return_from_the_hierarchy() {
        let fetched = [room("!root", &["!a", "!b"])];
        let mut local = room("!root", &["!a"]);
        local.children[0].via.clear();
        let merged = merge_hierarchy_rooms(&[local], &fetched);
        assert_eq!(merged[0].children, [edge("!b", false)]);
    }

    #[test]
    fn join_candidates_follow_the_join_rule_once_each() {
        let mut restricted = room("!r", &[]);
        restricted.join_rule = RoomJoinRuleView::Restricted;
        let mut knock = room("!k", &[]);
        knock.join_rule = RoomJoinRuleView::Knock;
        let rooms = [
            room("!root", &["!r", "!k", "!p", "!joined"]),
            restricted,
            knock,
            room("!p", &[]),
            room("!joined", &[]),
        ];
        let joined: HashSet<String> = ["!root".to_owned(), "!joined".to_owned()].into();
        let inputs = SectionInputs {
            joined: joined.clone(),
            ..SectionInputs::default()
        };
        let sections = build_hierarchy_sections(&rooms, "!root", &inputs);
        assert_eq!(sections[0].rooms[1].action, Some(LobbyAction::Knock));
        let ids: Vec<String> = join_candidates(&sections, &joined)
            .into_iter()
            .map(|candidate| candidate.room.room_id)
            .collect();
        assert_eq!(ids, ["!r", "!p"]);
        assert_eq!(
            lobby_action(RoomJoinRuleView::KnockRestricted, false, false),
            Some(LobbyAction::Knock)
        );
        assert_eq!(
            lobby_action(RoomJoinRuleView::Invite, true, false),
            Some(LobbyAction::Join)
        );
    }

    #[test]
    fn overrides_replace_order_and_suggestion() {
        let rooms = [room("!root", &["!a", "!b"])];
        let reordered = apply_child_overrides(
            &rooms,
            &[ChildOrderOverride {
                parent_id: "!root".to_owned(),
                children: vec![edge("!b", false), edge("!a", false)],
            }],
        );
        assert_eq!(reordered[0].children[0].room_id, "!b");
        let suggested = apply_suggested_overrides(
            &rooms,
            &[SuggestedOverride {
                parent_id: "!root".to_owned(),
                room_id: "!b".to_owned(),
                suggested: true,
            }],
        );
        assert!(suggested[0].children[1].suggested);
    }
}
