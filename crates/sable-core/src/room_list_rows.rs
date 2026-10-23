//! The host's copy of the room list, kept so that a push-rule change can resend
//! only the rows whose notification mode it changed.

use std::collections::HashMap;
use std::hash::BuildHasher;

use matrix_sdk::ruma::push::Ruleset;
use matrix_sdk::ruma::{OwnedRoomId, RoomId};
use matrix_sdk_ui::room_list_service::RoomListItem;

use crate::protocol::{RoomListItemView, VectorDiff};
use crate::push_rules::room_settings;
use crate::view::{RoomInfo, apply_diff, room_counts, room_list_item};

#[derive(Debug, Default)]
pub(crate) struct RoomListRows {
    rows: Vec<RoomListItemView>,
}

impl RoomListRows {
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

    pub(crate) fn refresh<S: BuildHasher>(
        &mut self,
        rooms: &[RoomListItem],
        cache: &HashMap<OwnedRoomId, RoomInfo, S>,
        rules: &Ruleset,
    ) -> Vec<VectorDiff<RoomListItemView>> {
        let mut diffs = Vec::new();
        for (index, row) in self.rows.iter_mut().enumerate() {
            let Some(room) = rooms.iter().find(|room| room.room_id() == row.room_id) else {
                continue;
            };
            *row = room_list_item(room, cache, rules);
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
            avatar_url: None,
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
            children: Vec::new(),
            children_stale: false,
            tags: Vec::new(),
            screen_sharers: Vec::new(),
        };
        let mut cache = HashMap::from([(kept.to_owned(), info()), (gone.to_owned(), info())]);
        let mut rows = RoomListRows::default();
        rows.apply(&VectorDiff::Reset {
            values: vec![summary(kept, &rules), summary(gone, &rules)].into(),
        });

        rows.apply(&VectorDiff::Remove { index: 1 });
        rows.evict(&mut cache);

        assert_eq!(cache.keys().collect::<Vec<_>>(), [kept]);
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
            ]
            .into(),
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
}
