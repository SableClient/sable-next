use crate::errors::CoreError;
use matrix_sdk::ruma::RoomId;
use matrix_sdk::ruma::push::{
    Action, AnyPushRuleRef, HighlightTweakValue, NewConditionalPushRule, NewPushRule,
    NewSimplePushRule, PushCondition, RuleKind, Ruleset, SoundTweakValue, Tweak,
};

use crate::protocol::{
    DefaultNotificationModesView, MentionNotificationModeView, NotificationModeView,
    NotificationSettingsView,
};

mod alignment;
mod authored;
mod categories;
mod keywords;
mod related;
mod store;

pub use alignment::{plan_cleanup, plan_suppressions};
pub use authored::authored_event;
pub use categories::{
    event_notifications, master_muted, mention_notifications, plan_event, plan_master,
    plan_membership, plan_mention, pushes_every_encrypted_event,
};
pub use keywords::{keywords, plan_add_keyword, plan_keyword_mode, plan_remove_keyword};
pub use related::related_actions;
pub use store::{PushRules, RuleWrite};

#[must_use]
pub fn notifies(actions: &[Action]) -> bool {
    actions
        .iter()
        .any(|action| matches!(action, Action::Notify))
}

pub(super) fn rule_notifies(rule: AnyPushRuleRef<'_>) -> bool {
    rule.enabled() && notifies(rule.actions())
}

#[must_use]
pub fn level(enabled: bool, actions: &[Action]) -> MentionNotificationModeView {
    if !enabled || !notifies(actions) {
        MentionNotificationModeView::Off
    } else if sound(actions) {
        MentionNotificationModeView::Loud
    } else {
        MentionNotificationModeView::Notify
    }
}

#[must_use]
pub fn level_actions(level: MentionNotificationModeView, highlight: bool) -> Vec<Action> {
    let mut actions = match level {
        MentionNotificationModeView::Off => return vec![],
        MentionNotificationModeView::Notify => vec![Action::Notify],
        MentionNotificationModeView::Loud => vec![
            Action::Notify,
            Action::SetTweak(Tweak::Sound(SoundTweakValue::Default)),
        ],
    };
    if highlight {
        actions.push(Action::SetTweak(Tweak::Highlight(HighlightTweakValue::Yes)));
    }
    actions
}

pub(super) fn plan_level(
    kind: RuleKind,
    rule_id: &str,
    level: MentionNotificationModeView,
    highlight: bool,
) -> Vec<RuleWrite> {
    let enabled = RuleWrite::Enabled {
        kind: kind.clone(),
        rule_id: rule_id.to_owned(),
        enabled: level != MentionNotificationModeView::Off,
    };
    if level == MentionNotificationModeView::Off {
        return vec![enabled];
    }
    vec![
        RuleWrite::Actions {
            kind,
            rule_id: rule_id.to_owned(),
            actions: level_actions(level, highlight),
        },
        enabled,
    ]
}

fn targets_room(conditions: &[PushCondition], room_id: &RoomId) -> bool {
    conditions.iter().any(|condition| {
        matches!(
            condition,
            PushCondition::EventMatch(data) if data.key == "room_id" && data.pattern == room_id.as_str()
        )
    })
}

fn muted(rules: &Ruleset, room_id: &RoomId) -> bool {
    rules.override_.iter().any(|rule| {
        !rule.default
            && rule.enabled
            && !notifies(&rule.actions)
            && targets_room(&rule.conditions, room_id)
    })
}

fn room_rule<'a>(rules: &'a Ruleset, room_id: &RoomId) -> Option<&'a [Action]> {
    rules
        .room
        .iter()
        .find(|rule| rule.enabled && rule.rule_id == *room_id)
        .map(|rule| rule.actions.as_slice())
}

#[must_use]
pub fn room_mode(rules: &Ruleset, room_id: &RoomId) -> Option<NotificationModeView> {
    if muted(rules, room_id) {
        return Some(NotificationModeView::Mute);
    }
    room_rule(rules, room_id).map(|actions| {
        if notifies(actions) {
            NotificationModeView::All
        } else {
            NotificationModeView::Mentions
        }
    })
}

#[must_use]
pub fn dm_notifies(rules: &Ruleset, room_id: &RoomId) -> bool {
    match room_mode(rules, room_id) {
        Some(NotificationModeView::Mute | NotificationModeView::Mentions) => false,
        Some(NotificationModeView::All) => true,
        None => rules
            .get(RuleKind::Underride, message_rule(rules, true))
            .is_none_or(rule_notifies),
    }
}

const DIRECT: &str = ".eu.cyrneko.msc4563.direct";
const ONE_TO_ONE: &str = ".m.rule.room_one_to_one";

fn served(rules: &Ruleset, rule_id: &str) -> bool {
    rules.get(RuleKind::Underride, rule_id).is_some()
}

/// MSC4563 covers the rooms listed in `m.direct`, the one-to-one rule those with two members.
#[must_use]
pub fn direct_defaults(rules: &Ruleset, listed: bool, two_members: bool) -> bool {
    (listed && served(rules, DIRECT)) || (two_members && served(rules, ONE_TO_ONE))
}

fn message_rule(rules: &Ruleset, direct: bool) -> &'static str {
    if !direct {
        ".m.rule.message"
    } else if served(rules, DIRECT) {
        DIRECT
    } else {
        ONE_TO_ONE
    }
}

const fn default_family(direct: bool) -> &'static [&'static str] {
    if direct {
        &[
            DIRECT,
            ".eu.cyrneko.msc4563.encrypted_direct",
            ONE_TO_ONE,
            ".m.rule.encrypted_room_one_to_one",
            ".m.rule.poll_start_one_to_one",
            ".m.rule.poll_end_one_to_one",
            ".org.matrix.msc3930.rule.poll_start_one_to_one",
            ".org.matrix.msc3930.rule.poll_end_one_to_one",
        ]
    } else {
        &[
            ".m.rule.message",
            ".m.rule.encrypted",
            ".m.rule.poll_start",
            ".m.rule.poll_end",
            ".org.matrix.msc3930.rule.poll_start",
            ".org.matrix.msc3930.rule.poll_end",
        ]
    }
}

fn spec_actions(direct: bool) -> Vec<Action> {
    if direct {
        vec![
            Action::Notify,
            Action::SetTweak(Tweak::Sound(SoundTweakValue::Default)),
        ]
    } else {
        vec![Action::Notify]
    }
}

#[must_use]
pub fn default_mode(rules: &Ruleset, direct: bool) -> NotificationModeView {
    if rules
        .get(RuleKind::Underride, message_rule(rules, direct))
        .is_some_and(rule_notifies)
    {
        NotificationModeView::All
    } else {
        NotificationModeView::Mentions
    }
}

#[must_use]
pub fn default_modes(rules: &Ruleset) -> DefaultNotificationModesView {
    DefaultNotificationModesView {
        direct: default_mode(rules, true),
        group: default_mode(rules, false),
        direct_rule: served(rules, DIRECT),
    }
}

#[must_use]
pub fn room_settings(rules: &Ruleset, room_id: &RoomId, direct: bool) -> NotificationSettingsView {
    NotificationSettingsView {
        room: room_mode(rules, room_id),
        default: default_mode(rules, direct),
    }
}

/// # Errors
///
/// When `rule` does not fit `kind`, or `kind` is one the server does not accept new rules for.
pub fn new_rule(
    kind: &RuleKind,
    rule: serde_json::Value,
) -> Result<NewPushRule, serde_json::Error> {
    Ok(match kind {
        RuleKind::Override => NewPushRule::Override(serde_json::from_value(rule)?),
        RuleKind::Content => NewPushRule::Content(serde_json::from_value(rule)?),
        RuleKind::Room => NewPushRule::Room(serde_json::from_value(rule)?),
        RuleKind::Sender => NewPushRule::Sender(serde_json::from_value(rule)?),
        RuleKind::Underride => NewPushRule::Underride(serde_json::from_value(rule)?),
        _ => {
            return Err(serde::de::Error::custom(format!(
                "no new {kind} push rules"
            )));
        }
    })
}

#[must_use]
pub fn plan_room_mode(room_id: &RoomId, mode: Option<NotificationModeView>) -> Vec<RuleWrite> {
    let kept = match mode {
        Some(NotificationModeView::Mute) => Some(RuleKind::Override),
        Some(_) => Some(RuleKind::Room),
        None => None,
    };
    let mut writes = Vec::new();
    match mode {
        Some(NotificationModeView::Mute) => writes.push(RuleWrite::Put(NewPushRule::Override(
            NewConditionalPushRule::new(
                room_id.to_string(),
                vec![PushCondition::EventMatch(
                    ruma::push::EventMatchConditionData::new(
                        "room_id".to_owned(),
                        room_id.to_string(),
                    ),
                )],
                vec![],
            ),
        ))),
        Some(NotificationModeView::All) => {
            writes.push(RuleWrite::Put(NewPushRule::Room(NewSimplePushRule::new(
                room_id.to_owned(),
                level_actions(MentionNotificationModeView::Loud, false),
            ))));
        }
        Some(NotificationModeView::Mentions) => {
            writes.push(RuleWrite::Put(NewPushRule::Room(NewSimplePushRule::new(
                room_id.to_owned(),
                vec![],
            ))));
        }
        None => {}
    }
    if let Some(kind) = &kept {
        writes.push(RuleWrite::Enabled {
            kind: kind.clone(),
            rule_id: room_id.to_string(),
            enabled: true,
        });
    }

    for kind in [RuleKind::Override, RuleKind::Room] {
        if kept.as_ref() != Some(&kind) {
            writes.push(RuleWrite::Delete {
                kind,
                rule_id: room_id.to_string(),
            });
        }
    }
    writes
}

#[must_use]
pub fn plan_direct_default(rules: &Ruleset, room_id: &RoomId) -> Vec<RuleWrite> {
    let direct = default_mode(rules, true);
    if room_mode(rules, room_id).is_some() || direct == default_mode(rules, false) {
        return Vec::new();
    }
    let mut writes = plan_room_mode(room_id, Some(direct));
    if direct == NotificationModeView::All {
        writes.extend(plan_suppressions(rules));
    }
    writes
}

/// # Errors
///
/// When the server has no rule for this kind of room.
pub fn plan_default_mode(
    rules: &Ruleset,
    direct: bool,
    mode: NotificationModeView,
) -> Result<Vec<RuleWrite>, CoreError> {
    let message = message_rule(rules, direct);
    if !served(rules, message) {
        return Err(format!("the server has no {message} rule").into());
    }
    Ok(default_family(direct)
        .iter()
        .filter(|rule_id| served(rules, rule_id))
        .flat_map(|rule_id| {
            let actions = match mode {
                NotificationModeView::All => spec_actions(direct),
                NotificationModeView::Mentions | NotificationModeView::Mute => vec![],
            };
            [
                RuleWrite::Actions {
                    kind: RuleKind::Underride,
                    rule_id: (*rule_id).to_owned(),
                    actions,
                },
                RuleWrite::Enabled {
                    kind: RuleKind::Underride,
                    rule_id: (*rule_id).to_owned(),
                    enabled: true,
                },
            ]
        })
        .collect())
}

pub(super) fn sound(actions: &[Action]) -> bool {
    actions.iter().any(|action| action.sound().is_some())
}

#[cfg(test)]
mod tests;
