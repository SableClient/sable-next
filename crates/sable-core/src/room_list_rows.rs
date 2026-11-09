//! The host's copy of the room list, kept so that a push-rule change can resend
//! only the rows whose notification mode it changed.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::BuildHasher;

use matrix_sdk::ruma::push::Ruleset;
use matrix_sdk::ruma::{OwnedRoomId, RoomId};
use matrix_sdk_ui::room_list_service::RoomListItem;

use crate::api::rooms::RoomKind;
use crate::nicknames::Nicknames;
use crate::protocol::{RoomListItemView, SpaceChildEdge, VectorDiff};
use crate::push_rules::room_settings;
use crate::space_parents::ParentSpaceLinks;
use crate::view::{RoomInfo, apply_diff, room_counts, room_list_item};

pub(crate) type DmSpaceLinks = BTreeMap<OwnedRoomId, Vec<OwnedRoomId>>;

#[derive(Debug, Default)]
pub(crate) struct RoomListRows {
    rows: Vec<RoomListItemView>,
}

impl RoomListRows {
    pub(crate) fn rows(&self) -> &[RoomListItemView] {
        &self.rows
    }

    pub(crate) fn relink<S: BuildHasher>(
        &mut self,
        cache: &HashMap<OwnedRoomId, RoomInfo, S>,
        links: &DmSpaceLinks,
        parents: &ParentSpaceLinks,
    ) -> Vec<VectorDiff<RoomListItemView>> {
        let listed: HashSet<&RoomId> = self.rows.iter().map(|row| &*row.room_id).collect();
        let mut linked: HashMap<OwnedRoomId, Vec<OwnedRoomId>> = HashMap::new();
        for (room_id, space_ids) in links {
            if !listed.contains(&**room_id) {
                continue;
            }
            for space_id in space_ids {
                linked
                    .entry(space_id.clone())
                    .or_default()
                    .push(room_id.clone());
            }
        }
        let mut parent_children: HashMap<&RoomId, Vec<(&RoomId, &[String])>> = HashMap::new();
        for (room_id, spaces) in parents {
            if !listed.contains(&**room_id) {
                continue;
            }
            for (space_id, via) in spaces {
                parent_children
                    .entry(space_id)
                    .or_default()
                    .push((room_id, via));
            }
        }

        let mut diffs = Vec::new();
        for (index, row) in self.rows.iter_mut().enumerate() {
            if row.room_kind != Some(RoomKind::Space) {
                continue;
            }
            let Some(info) = cache.get(&row.room_id) else {
                continue;
            };
            // The room-list view combines parent claims with actual child events.
            let mut children = info.children.clone();
            for (room_id, via) in parent_children.get(&*row.room_id).into_iter().flatten() {
                if children
                    .iter()
                    .any(|edge| edge.room_id == room_id.as_str() && !edge.via.is_empty())
                {
                    continue;
                }
                children.retain(|edge| edge.room_id != room_id.as_str());
                children.push(SpaceChildEdge {
                    room_id: room_id.to_string(),
                    via: via.to_vec(),
                    order: None,
                    origin_server_ts: 0,
                    suggested: false,
                });
            }
            for room_id in linked.get(&row.room_id).into_iter().flatten() {
                if children.iter().any(|edge| edge.room_id == room_id.as_str()) {
                    continue;
                }
                children.push(SpaceChildEdge {
                    room_id: room_id.to_string(),
                    via: room_id
                        .server_name()
                        .map(|server| vec![server.to_string()])
                        .unwrap_or_default(),
                    order: None,
                    origin_server_ts: 0,
                    suggested: false,
                });
            }
            if children == row.space_children {
                continue;
            }
            row.space_children = children;
            diffs.push(VectorDiff::Set {
                index,
                value: row.clone(),
            });
        }
        diffs
    }

    pub(crate) fn apply(&mut self, diff: &VectorDiff<RoomListItemView>) {
        apply_diff(&mut self.rows, diff);
    }

    /// Forgets what the cache holds for rooms that left the list.
    pub(crate) fn evict<S: BuildHasher>(&self, cache: &mut HashMap<OwnedRoomId, RoomInfo, S>) {
        let listed: std::collections::HashSet<_> =
            self.rows.iter().map(|row| &row.room_id).collect();
        cache.retain(|room_id, _| listed.contains(room_id));
    }

    /// The `Set` diffs for every row whose mode `rules` changed. `direct`
    /// answers whether a room falls under the one-to-one defaults.
    pub(crate) fn renotify(
        &mut self,
        rules: &Ruleset,
        direct: impl Fn(&RoomId) -> bool,
    ) -> Vec<VectorDiff<RoomListItemView>> {
        let mut diffs = Vec::new();
        for (index, row) in self.rows.iter_mut().enumerate() {
            let notification = room_settings(rules, &row.room_id, direct(&row.room_id));
            if notification == row.notification {
                continue;
            }
            row.notification = notification;
            row.counts = room_counts(
                notification,
                row.unread,
                row.notifying,
                row.highlight,
                row.marked_unread,
            );
            diffs.push(VectorDiff::Set {
                index,
                value: row.clone(),
            });
        }
        diffs
    }

    pub(crate) fn rename<S: BuildHasher>(
        &mut self,
        nicknames: &Nicknames,
        cache: &HashMap<OwnedRoomId, RoomInfo, S>,
    ) -> Vec<VectorDiff<RoomListItemView>> {
        let mut diffs = Vec::new();
        for (index, row) in self.rows.iter_mut().enumerate() {
            let (name, avatar) = (row.display_name.clone(), row.display_avatar_url.clone());
            nicknames.apply_room(row);
            crate::view::apply_avatar_override(row, cache.get(&row.room_id));
            if row.display_name != name || row.display_avatar_url != avatar {
                diffs.push(VectorDiff::Set {
                    index,
                    value: row.clone(),
                });
            }
        }
        diffs
    }

    pub(crate) fn refresh<S: BuildHasher>(
        &mut self,
        rooms: &[RoomListItem],
        cache: &HashMap<OwnedRoomId, RoomInfo, S>,
        rules: &Ruleset,
        nicknames: &Nicknames,
    ) -> Vec<VectorDiff<RoomListItemView>> {
        let mut diffs = Vec::new();
        for (index, row) in self.rows.iter_mut().enumerate() {
            let Some(room) = rooms.iter().find(|room| room.room_id() == row.room_id) else {
                continue;
            };
            *row = room_list_item(room, cache, rules, nicknames);
            diffs.push(VectorDiff::Set {
                index,
                value: row.clone(),
            });
        }
        diffs
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::push::{
        EventMatchConditionData, NewConditionalPushRule, NewPushRule, PushCondition,
    };
    use matrix_sdk::ruma::{room_id, user_id};

    use super::*;
    use crate::api::rooms::RoomKind;
    use crate::protocol::{NotificationModeView, RoomJoinRuleView, RoomStateView};

    fn summary(room_id: &RoomId, rules: &Ruleset) -> RoomListItemView {
        let notification = room_settings(rules, room_id, false);
        RoomListItemView {
            room_id: room_id.to_owned(),
            canonical_alias: None,
            name: None,
            topic: None,
            topic_html: None,
            avatar_url: None,
            display_name: room_id.to_string(),
            display_avatar_url: None,
            is_direct: false,
            direct_targets: Vec::new(),
            join_rule: RoomJoinRuleView::Invite,
            tags: Vec::new(),
            state: RoomStateView::Joined,
            encrypted: Some(false),
            is_tombstoned: false,
            room_kind: None,
            call_participants: Vec::new(),
            screen_sharers: Vec::new(),
            supports_knock: false,
            supports_restricted: false,
            supports_knock_restricted: false,
            space_children: Vec::new(),
            bridge: None,
            unread: 4,
            notifying: 4,
            highlight: 1,
            marked_unread: false,
            notification,
            counts: room_counts(notification, 4, 4, 1, false),
            latest_event: None,
        }
    }

    fn muted(rules: &Ruleset, room_id: &RoomId) -> Ruleset {
        let mut next = rules.clone();
        let mute = NewConditionalPushRule::new(
            room_id.to_string(),
            vec![PushCondition::EventMatch(EventMatchConditionData::new(
                "room_id".to_owned(),
                room_id.to_string(),
            ))],
            vec![],
        );
        next.insert(NewPushRule::Override(mute), None, None)
            .expect("a new override");
        next
    }

    #[test]
    fn evict_drops_rooms_that_left_the_list() {
        let rules = Ruleset::server_default(user_id!("@me:example.org"));
        let kept = room_id!("!kept:example.org");
        let gone = room_id!("!gone:example.org");
        let info = || RoomInfo {
            room_kind: Some(RoomKind::Text),
            is_direct: false,
            is_tombstoned: false,
            supports_knock: false,
            supports_restricted: false,
            supports_knock_restricted: false,
            canonical_alias: None,
            avatar_url: None,
            avatar_source: None,
            direct_name: None,
            children: Vec::new(),
            children_stale: false,
            tags: Vec::new(),
            screen_sharers: Vec::new(),
            avatar_override: None,
            bridge: None,
        };
        let mut cache = HashMap::from([(kept.to_owned(), info()), (gone.to_owned(), info())]);
        let mut rows = RoomListRows::default();
        rows.apply(&VectorDiff::Reset {
            values: vec![summary(kept, &rules), summary(gone, &rules)],
        });

        rows.apply(&VectorDiff::Remove { index: 1 });
        rows.evict(&mut cache);

        assert_eq!(cache.keys().collect::<Vec<_>>(), [kept]);
    }

    fn space_info(children: Vec<SpaceChildEdge>) -> RoomInfo {
        RoomInfo {
            room_kind: Some(RoomKind::Space),
            is_direct: false,
            is_tombstoned: false,
            supports_knock: false,
            supports_restricted: false,
            supports_knock_restricted: false,
            canonical_alias: None,
            avatar_url: None,
            avatar_source: None,
            direct_name: None,
            children,
            children_stale: false,
            tags: Vec::new(),
            screen_sharers: Vec::new(),
            avatar_override: None,
            bridge: None,
        }
    }

    #[test]
    fn relink_leaves_a_chat_the_space_already_lists_as_a_child() {
        let rules = Ruleset::server_default(user_id!("@me:example.org"));
        let space = room_id!("!space:example.org");
        let chat = room_id!("!chat:example.org");
        let edge = SpaceChildEdge {
            room_id: chat.to_string(),
            via: vec!["example.org".to_owned()],
            order: None,
            origin_server_ts: 7,
            suggested: false,
        };
        let cache = HashMap::from([(space.to_owned(), space_info(vec![edge.clone()]))]);
        let mut space_row = summary(space, &rules);
        space_row.room_kind = Some(RoomKind::Space);
        space_row.space_children = vec![edge.clone()];
        let mut rows = RoomListRows::default();
        rows.apply(&VectorDiff::Reset {
            values: vec![space_row, summary(chat, &rules)],
        });
        let links = DmSpaceLinks::from([(chat.to_owned(), vec![space.to_owned()])]);

        assert!(
            rows.relink(&cache, &links, &ParentSpaceLinks::new())
                .is_empty()
        );
        assert_eq!(rows.rows[0].space_children, [edge]);
    }

    #[test]
    fn relink_lists_a_listed_chat_under_its_private_spaces_once() {
        let rules = Ruleset::server_default(user_id!("@me:example.org"));
        let space = room_id!("!space:example.org");
        let chat = room_id!("!chat:other.org");
        let away = room_id!("!away:example.org");
        let info = space_info(Vec::new());
        let cache = HashMap::from([(space.to_owned(), info)]);
        let mut space_row = summary(space, &rules);
        space_row.room_kind = Some(RoomKind::Space);
        let mut rows = RoomListRows::default();
        rows.apply(&VectorDiff::Reset {
            values: vec![space_row, summary(chat, &rules)],
        });
        let links = DmSpaceLinks::from([
            (chat.to_owned(), vec![space.to_owned()]),
            (away.to_owned(), vec![space.to_owned()]),
        ]);

        let diffs = rows.relink(&cache, &links, &ParentSpaceLinks::new());

        let [VectorDiff::Set { index: 0, value }] = diffs.as_slice() else {
            panic!("expected the space's row to change, got {diffs:?}");
        };
        let children: Vec<_> = value
            .space_children
            .iter()
            .map(|edge| (edge.room_id.as_str(), edge.via.clone()))
            .collect();
        assert_eq!(children, [(chat.as_str(), vec!["other.org".to_owned()])]);
        assert!(
            rows.relink(&cache, &links, &ParentSpaceLinks::new())
                .is_empty()
        );
    }

    #[test]
    fn relink_uses_validated_parent_claims_and_removes_them_when_revoked() {
        let rules = Ruleset::server_default(user_id!("@me:example.org"));
        let space = room_id!("!space:example.org");
        let room = room_id!("!TSu72vOzgRWPPXopf7dUlfzwXvrBCKMGerwFTWkXtpA");
        let cache = HashMap::from([(space.to_owned(), space_info(Vec::new()))]);
        let mut space_row = summary(space, &rules);
        space_row.room_kind = Some(RoomKind::Space);
        let mut rows = RoomListRows::default();
        rows.apply(&VectorDiff::Reset {
            values: vec![space_row, summary(room, &rules)],
        });
        let parents = ParentSpaceLinks::from([(
            room.to_owned(),
            vec![(space.to_owned(), vec!["sable.moe".into()])],
        )]);

        rows.relink(&cache, &DmSpaceLinks::new(), &parents);
        assert_eq!(rows.rows[0].space_children[0].room_id, room.as_str());
        assert_eq!(rows.rows[0].space_children[0].via, ["sable.moe"]);
        rows.relink(&cache, &DmSpaceLinks::new(), &ParentSpaceLinks::new());
        assert_eq!(rows.rows[0].space_children, []);
    }

    #[test]
    fn a_mute_resends_only_the_muted_row_and_clears_its_counts() {
        let rules = Ruleset::server_default(user_id!("@me:example.org"));
        let quiet = room_id!("!quiet:example.org");
        let mut rows = RoomListRows::default();
        rows.apply(&VectorDiff::Reset {
            values: vec![
                summary(room_id!("!busy:example.org"), &rules),
                summary(quiet, &rules),
            ],
        });

        let rules = muted(&rules, quiet);
        let diffs = rows.renotify(&rules, |_| false);

        let [VectorDiff::Set { index: 1, value }] = diffs.as_slice() else {
            panic!("one set for the muted room, got {diffs:?}");
        };
        assert_eq!(value.notification.room, Some(NotificationModeView::Mute));
        assert_eq!((value.counts.unread, value.counts.highlight), (0, 0));
        assert!(rows.renotify(&rules, |_| false).is_empty());
    }

    #[test]
    fn a_nickname_renames_only_the_one_to_one_room_with_that_person() {
        let rules = Ruleset::new();
        let mut direct = summary(room_id!("!dm:x"), &rules);
        direct.name = Some("Bob".to_owned());
        direct.is_direct = true;
        direct.direct_targets = vec![user_id!("@bob:x").to_owned()];
        let mut group = summary(room_id!("!group:x"), &rules);
        group.name = Some("Bob and friends".to_owned());
        let mut rows = RoomListRows::default();
        for mut row in [direct, group] {
            Nicknames::default().apply_room(&mut row);
            rows.apply(&VectorDiff::PushBack { value: row });
        }
        let nicknames = Nicknames::from_overrides(
            vec![crate::protocol::ProfileOverrideView {
                user_id: user_id!("@bob:x").to_owned(),
                display_name: crate::protocol::OverrideTextView::Set {
                    value: "Bobby".to_owned(),
                },
                avatar: crate::protocol::OverrideTextView::Unset,
                color: crate::protocol::OverrideColorView::Unset,
            }],
            None,
        );

        let diffs = rows.rename(&nicknames, &HashMap::<OwnedRoomId, RoomInfo>::new());

        let [VectorDiff::Set { index: 0, value }] = diffs.as_slice() else {
            panic!("one set, got {diffs:?}");
        };
        assert_eq!(value.display_name, "Bobby");
        assert_eq!(value.name.as_deref(), Some("Bob"));
        assert!(
            rows.rename(&nicknames, &HashMap::<OwnedRoomId, RoomInfo>::new())
                .is_empty()
        );
    }
}
