use std::collections::{BTreeMap, BTreeSet};

use matrix_sdk::ruma::push::{
    ConditionalPushRule, EventMatchConditionData, NewConditionalPushRule, NewPushRule,
    PushCondition, Ruleset,
};
use matrix_sdk::ruma::{OwnedRoomId, RoomId};
use serde::{Deserialize, Serialize};

use super::{RuleWrite, notifies, spec_actions};
use crate::protocol::NotificationModeView;

pub(super) const DEFAULT_EVENT: &str = "moe.sable.dm_notification_default";
const PREFIX: &str = "moe.sable.dm_default.";
const EVENTS: [(&str, &str); 7] = [
    ("message", "m.room.message"),
    ("encrypted", "m.room.encrypted"),
    ("sticker", "m.sticker"),
    ("poll_start", "m.poll.start"),
    ("poll_end", "m.poll.end"),
    ("poll_start_unstable", "org.matrix.msc3381.poll.start"),
    ("poll_end_unstable", "org.matrix.msc3381.poll.end"),
];

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct DirectDefault {
    pub mode: NotificationModeView,
    #[serde(default)]
    pub pending_one_to_one: bool,
    #[serde(default)]
    pub managed: BTreeMap<OwnedRoomId, ManagedRoom>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ManagedRoom {
    mode: NotificationModeView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending: Option<NotificationModeView>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    customized: BTreeSet<String>,
}

fn rule_id(family: &str, room: &RoomId) -> String {
    format!("{PREFIX}{family}.{room}")
}

fn rule(
    room: &RoomId,
    family: &str,
    event_type: &str,
    mode: NotificationModeView,
) -> NewConditionalPushRule {
    NewConditionalPushRule::new(
        rule_id(family, room),
        vec![
            PushCondition::EventMatch(EventMatchConditionData::new(
                "room_id".to_owned(),
                room.to_string(),
            )),
            PushCondition::EventMatch(EventMatchConditionData::new(
                "type".to_owned(),
                event_type.to_owned(),
            )),
        ],
        if mode == NotificationModeView::All {
            spec_actions(true)
        } else {
            vec![]
        },
    )
}

fn same_rule(left: &ConditionalPushRule, right: &ConditionalPushRule) -> bool {
    serde_json::to_value(left).ok() == serde_json::to_value(right).ok()
}

fn owned(
    current: &ConditionalPushRule,
    room: &RoomId,
    family: &str,
    event_type: &str,
    managed: &ManagedRoom,
) -> bool {
    !managed.customized.contains(family)
        && [Some(managed.mode), managed.pending]
            .into_iter()
            .flatten()
            .any(|mode| same_rule(current, &rule(room, family, event_type, mode).into()))
}

pub(super) fn inherited_mode(rules: &Ruleset, room: &RoomId) -> Option<NotificationModeView> {
    let inherited = rules.underride.get(rule_id("message", room).as_str())?;
    let expected = rule(room, "message", "m.room.message", NotificationModeView::All);
    (inherited.enabled
        && !inherited.default
        && serde_json::to_value(&inherited.conditions).ok()
            == serde_json::to_value(&expected.conditions).ok())
    .then(|| {
        if notifies(&inherited.actions) {
            NotificationModeView::All
        } else {
            NotificationModeView::Mentions
        }
    })
}

pub(super) fn plan(
    rules: &Ruleset,
    preference: &DirectDefault,
    rooms: &BTreeSet<OwnedRoomId>,
) -> (Vec<RuleWrite>, DirectDefault, DirectDefault) {
    let mut writes = Vec::new();
    let mut pending = preference.clone();
    let mut next = DirectDefault {
        mode: preference.mode,
        pending_one_to_one: false,
        managed: BTreeMap::new(),
    };
    for (room, managed) in &preference.managed {
        if !rooms.contains(room) {
            for (family, event_type) in EVENTS {
                let id = rule_id(family, room);
                if rules
                    .underride
                    .get(id.as_str())
                    .is_some_and(|current| owned(current, room, family, event_type, managed))
                {
                    writes.push(RuleWrite::Delete {
                        kind: super::RuleKind::Underride,
                        rule_id: id,
                    });
                }
            }
        }
    }
    for room in rooms {
        let previous = preference.managed.get(room);
        let mut managed = previous.cloned().unwrap_or(ManagedRoom {
            mode: preference.mode,
            pending: None,
            customized: BTreeSet::new(),
        });
        for (family, event_type) in EVENTS {
            if managed.customized.contains(family) {
                continue;
            }
            let wanted = rule(room, family, event_type, preference.mode);
            let expected = ConditionalPushRule::from(wanted.clone());
            let current = rules.underride.get(wanted.rule_id.as_str());
            if current.is_some_and(|current| {
                !previous.is_some_and(|previous| owned(current, room, family, event_type, previous))
            }) {
                managed.customized.insert(family.to_owned());
                continue;
            }
            if current.is_none_or(|current| !same_rule(current, &expected)) {
                writes.push(RuleWrite::Put(NewPushRule::Underride(wanted)));
            }
        }
        managed.pending = Some(
            managed
                .pending
                .filter(|mode| *mode != managed.mode)
                .unwrap_or(preference.mode),
        );
        pending.managed.insert(room.clone(), managed.clone());
        managed.mode = preference.mode;
        managed.pending = None;
        next.managed.insert(room.clone(), managed);
    }
    (writes, pending, next)
}

#[cfg(test)]
mod tests;
