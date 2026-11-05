use crate::errors::CoreError;
use matrix_sdk::ruma::RoomId;
use matrix_sdk::ruma::push::{
    Action, AnyPushRuleRef, HighlightTweakValue, NewConditionalPushRule, NewPushRule,
    NewSimplePushRule, PredefinedUnderrideRuleId, PushCondition, RuleKind, Ruleset,
    SoundTweakValue, Tweak,
};

use crate::protocol::{
    DefaultNotificationModesView, MentionNotificationModeView, NotificationModeView,
    NotificationSettingsView,
};

mod alignment;
mod categories;
mod direct;
mod keywords;
mod related;
mod store;

pub use alignment::plan_cleanup;
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
        None => direct::inherited_mode(rules, room_id).map_or_else(
            || {
                rules
                    .get(RuleKind::Underride, message_rule(true).as_str())
                    .is_none_or(rule_notifies)
            },
            |mode| mode == NotificationModeView::All,
        ),
    }
}

const fn message_rule(direct: bool) -> PredefinedUnderrideRuleId {
    if direct {
        PredefinedUnderrideRuleId::RoomOneToOne
    } else {
        PredefinedUnderrideRuleId::Message
    }
}

const fn default_family(direct: bool) -> [&'static str; 6] {
    if direct {
        [
            ".m.rule.room_one_to_one",
            ".m.rule.encrypted_room_one_to_one",
            ".m.rule.poll_start_one_to_one",
            ".m.rule.poll_end_one_to_one",
            ".org.matrix.msc3930.rule.poll_start_one_to_one",
            ".org.matrix.msc3930.rule.poll_end_one_to_one",
        ]
    } else {
        [
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
        .get(RuleKind::Underride, message_rule(direct).as_str())
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
    }
}

#[must_use]
pub fn room_settings(rules: &Ruleset, room_id: &RoomId, direct: bool) -> NotificationSettingsView {
    NotificationSettingsView {
        room: room_mode(rules, room_id),
        default: direct::inherited_mode(rules, room_id)
            .unwrap_or_else(|| default_mode(rules, direct)),
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
pub fn plan_room_mode(
    room_id: &RoomId,
    direct: bool,
    mode: Option<NotificationModeView>,
) -> Vec<RuleWrite> {
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
                    matrix_sdk::ruma::push::EventMatchConditionData::new(
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
                spec_actions(direct),
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

/// # Errors
///
/// When the server has no rule for this kind of room.
pub fn plan_default_mode(
    rules: &Ruleset,
    direct: bool,
    mode: NotificationModeView,
) -> Result<Vec<RuleWrite>, CoreError> {
    let message = message_rule(direct);
    if rules.get(RuleKind::Underride, message.as_str()).is_none() {
        return Err(format!("the server has no {message} rule").into());
    }
    Ok(default_family(direct)
        .into_iter()
        .filter(|rule_id| rules.get(RuleKind::Underride, rule_id).is_some())
        .flat_map(|rule_id| {
            let actions = match mode {
                NotificationModeView::All => spec_actions(direct),
                NotificationModeView::Mentions | NotificationModeView::Mute => vec![],
            };
            [
                RuleWrite::Actions {
                    kind: RuleKind::Underride,
                    rule_id: rule_id.to_owned(),
                    actions,
                },
                RuleWrite::Enabled {
                    kind: RuleKind::Underride,
                    rule_id: rule_id.to_owned(),
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
