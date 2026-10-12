//! The host's copy of the room list, kept so that a push-rule change can resend
//! only the rows whose notification mode it changed.

use matrix_sdk::ruma::RoomId;
use matrix_sdk::ruma::push::Ruleset;

use crate::protocol::{RoomSummary, VectorDiff};
use crate::push_rules::room_settings;
use crate::view::{apply_diff, room_counts};

#[derive(Debug, Default)]
pub(crate) struct RoomListRows {
    rows: Vec<RoomSummary>,
}

impl RoomListRows {
    pub(crate) fn apply(&mut self, diff: &VectorDiff<RoomSummary>) {
        apply_diff(&mut self.rows, diff);
    }

    /// The `Set` diffs for every row whose mode `rules` changed. `direct`
    /// answers whether a room falls under the one-to-one defaults.
    pub(crate) fn renotify(
        &mut self,
        rules: &Ruleset,
        direct: impl Fn(&RoomId) -> bool,
    ) -> Vec<VectorDiff<RoomSummary>> {
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
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::push::{
        EventMatchConditionData, NewConditionalPushRule, NewPushRule, PushCondition,
    };
    use matrix_sdk::ruma::{room_id, user_id};

    use super::*;
    use crate::protocol::{NotificationModeView, RoomJoinRuleView, RoomStateView};

    fn summary(room_id: &RoomId, rules: &Ruleset) -> RoomSummary {
        let notification = room_settings(rules, room_id, false);
        RoomSummary {
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
            is_space: false,
            is_tombstoned: false,
            room_type: None,
            is_voice: false,
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
}
