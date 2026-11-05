use matrix_sdk::ruma::push::{
    Action, EventMatchConditionData, NewConditionalPushRule, NewPushRule, PredefinedContentRuleId,
    PredefinedOverrideRuleId, PredefinedUnderrideRuleId, PushCondition, RuleKind, Ruleset,
    SoundTweakValue, Tweak,
};

use matrix_sdk::ruma::UserId;

use super::alignment::{
    REACTION_TO_ME, RTC_SERVER_ROOM_RULES, RTC_SERVER_USER_RULES, SUPPRESS_REACTIONS,
};
use super::related::related_condition;
use super::{RuleWrite, level, notifies, plan_level, rule_notifies};
use crate::errors::CoreError;
use crate::protocol::{
    EventNotificationView, EventNotificationsView, MentionNotificationModeView,
    MentionNotificationsView, MentionRuleView,
};

const ENCRYPTED_EVENT_RULES: [&str; 2] = [
    ".m.rule.encrypted_event",
    ".org.matrix.msc4028.encrypted_event",
];

#[must_use]
pub fn pushes_every_encrypted_event(rules: &Ruleset) -> bool {
    rules.override_.iter().any(|rule| {
        rule.enabled
            && ENCRYPTED_EVENT_RULES.contains(&rule.rule_id.as_str())
            && notifies(&rule.actions)
    })
}

fn mention_rule(rules: &Ruleset, rule: MentionRuleView) -> Option<(RuleKind, String)> {
    #[expect(
        deprecated,
        reason = "the legacy room-notif rule is still matched on older servers"
    )]
    let candidates: &[(RuleKind, &str)] = match rule {
        MentionRuleView::Room => &[
            (
                RuleKind::Override,
                PredefinedOverrideRuleId::IsRoomMention.as_str(),
            ),
            (
                RuleKind::Override,
                PredefinedOverrideRuleId::RoomNotif.as_str(),
            ),
        ],
        MentionRuleView::User => &[(
            RuleKind::Override,
            PredefinedOverrideRuleId::IsUserMention.as_str(),
        )],
        MentionRuleView::DisplayName => &[(
            RuleKind::Override,
            PredefinedOverrideRuleId::ContainsDisplayName.as_str(),
        )],
        MentionRuleView::Username => &[(
            RuleKind::Content,
            PredefinedContentRuleId::ContainsUserName.as_str(),
        )],
    };
    candidates
        .iter()
        .find(|(kind, rule_id)| rules.get(kind.clone(), rule_id).is_some())
        .map(|(kind, rule_id)| (kind.clone(), (*rule_id).to_owned()))
}

fn mention_level(rules: &Ruleset, rule: MentionRuleView) -> Option<MentionNotificationModeView> {
    let (kind, rule_id) = mention_rule(rules, rule)?;
    rules
        .get(kind, rule_id)
        .map(|rule| level(rule.enabled(), rule.actions()))
}

#[must_use]
pub fn mention_notifications(rules: &Ruleset) -> MentionNotificationsView {
    MentionNotificationsView {
        room: mention_level(rules, MentionRuleView::Room),
        user: mention_level(rules, MentionRuleView::User),
        display_name: mention_level(rules, MentionRuleView::DisplayName),
        username: mention_level(rules, MentionRuleView::Username),
    }
}

/// # Errors
///
/// When the server has no rule for this kind of mention.
pub fn plan_mention(
    rules: &Ruleset,
    rule: MentionRuleView,
    mode: MentionNotificationModeView,
) -> Result<Vec<RuleWrite>, CoreError> {
    let (kind, rule_id) =
        mention_rule(rules, rule).ok_or("the server has no rule for this mention")?;
    Ok(plan_level(kind, &rule_id, mode, true))
}

fn event_rule(rules: &Ruleset, event: EventNotificationView) -> Option<(RuleKind, String)> {
    let candidates = match event {
        EventNotificationView::Membership => {
            vec![(
                RuleKind::Override,
                PredefinedOverrideRuleId::MemberEvent.as_str(),
            )]
        }
        EventNotificationView::Reactions => vec![
            (
                RuleKind::Override,
                PredefinedOverrideRuleId::Reaction.as_str(),
            ),
            (RuleKind::Override, SUPPRESS_REACTIONS),
        ],
        EventNotificationView::Edits => {
            vec![(
                RuleKind::Override,
                PredefinedOverrideRuleId::SuppressEdits.as_str(),
            )]
        }
        EventNotificationView::Notices => {
            vec![(
                RuleKind::Override,
                PredefinedOverrideRuleId::SuppressNotices.as_str(),
            )]
        }
        EventNotificationView::Invites => {
            vec![(
                RuleKind::Override,
                PredefinedOverrideRuleId::InviteForMe.as_str(),
            )]
        }
        EventNotificationView::Calls => vec![(
            RuleKind::Underride,
            PredefinedUnderrideRuleId::Call.as_str(),
        )],
        EventNotificationView::RtcUser => RTC_SERVER_USER_RULES
            .into_iter()
            .map(|id| (RuleKind::Override, id))
            .collect(),
        EventNotificationView::RtcRoom => RTC_SERVER_ROOM_RULES
            .into_iter()
            .map(|id| (RuleKind::Override, id))
            .collect(),
    };
    candidates
        .into_iter()
        .find(|(kind, id)| rules.get(kind.clone(), id).is_some())
        .map(|(kind, id)| (kind, id.to_owned()))
}

pub(super) fn event_actions(event: EventNotificationView) -> Vec<Action> {
    match event {
        EventNotificationView::Invites => vec![
            Action::Notify,
            Action::SetTweak(Tweak::Sound(SoundTweakValue::Default)),
        ],
        EventNotificationView::Calls
        | EventNotificationView::RtcUser
        | EventNotificationView::RtcRoom => vec![
            Action::Notify,
            Action::SetTweak(Tweak::Sound("ring".into())),
        ],
        _ => vec![Action::Notify],
    }
}

pub(super) fn event_notifies(rules: &Ruleset, event: EventNotificationView) -> Option<bool> {
    let rtc_ids = match event {
        EventNotificationView::RtcUser => Some(RTC_SERVER_USER_RULES),
        EventNotificationView::RtcRoom => Some(RTC_SERVER_ROOM_RULES),
        _ => None,
    };
    if let Some(ids) = rtc_ids {
        return ids
            .into_iter()
            .filter_map(|id| rules.get(RuleKind::Override, id))
            .fold(None, |state, rule| {
                Some(state.unwrap_or(false) || rule_notifies(rule))
            });
    }
    if matches!(event, EventNotificationView::Reactions)
        && let Some(rule) = rules.get(RuleKind::Override, REACTION_TO_ME)
    {
        return Some(rule_notifies(rule));
    }
    let (kind, rule_id) = event_rule(rules, event)?;
    rules.get(kind, &rule_id).map(rule_notifies)
}

#[must_use]
pub fn event_notifications(rules: &Ruleset) -> EventNotificationsView {
    EventNotificationsView {
        membership: event_notifies(rules, EventNotificationView::Membership),
        reactions: event_notifies(rules, EventNotificationView::Reactions),
        edits: event_notifies(rules, EventNotificationView::Edits),
        notices: event_notifies(rules, EventNotificationView::Notices),
        invites: event_notifies(rules, EventNotificationView::Invites),
        calls: event_notifies(rules, EventNotificationView::Calls),
        rtc_user: event_notifies(rules, EventNotificationView::RtcUser),
        rtc_room: event_notifies(rules, EventNotificationView::RtcRoom),
    }
}

/// # Errors
///
/// When the server has no rule for this kind of event.
pub fn plan_event(
    rules: &Ruleset,
    event: EventNotificationView,
    enabled: bool,
    user_id: &UserId,
) -> Result<Vec<RuleWrite>, CoreError> {
    if matches!(event, EventNotificationView::Reactions) {
        let mut writes = Vec::new();
        if let Some((kind, rule_id)) = event_rule(rules, event) {
            writes.extend([
                RuleWrite::Actions {
                    kind: kind.clone(),
                    rule_id: rule_id.clone(),
                    actions: vec![],
                },
                RuleWrite::Enabled {
                    kind,
                    rule_id,
                    enabled: true,
                },
            ]);
        } else if rules.get(RuleKind::Override, REACTION_TO_ME).is_none() {
            return Err("the server has no rule for this kind of event".into());
        }
        if enabled {
            writes.push(reaction_to_me(user_id));
        } else if rules.get(RuleKind::Override, REACTION_TO_ME).is_some() {
            writes.push(RuleWrite::Delete {
                kind: RuleKind::Override,
                rule_id: REACTION_TO_ME.to_owned(),
            });
        }
        return Ok(writes);
    }
    let (kind, rule_id) =
        event_rule(rules, event).ok_or("the server has no rule for this kind of event")?;
    let targets: Vec<_> = match event {
        EventNotificationView::RtcUser => RTC_SERVER_USER_RULES
            .into_iter()
            .filter(|id| rules.get(RuleKind::Override, id).is_some())
            .map(|id| (RuleKind::Override, id.to_owned()))
            .collect(),
        EventNotificationView::RtcRoom => RTC_SERVER_ROOM_RULES
            .into_iter()
            .filter(|id| rules.get(RuleKind::Override, id).is_some())
            .map(|id| (RuleKind::Override, id.to_owned()))
            .collect(),
        _ => vec![(kind, rule_id)],
    };
    Ok(targets
        .into_iter()
        .flat_map(|(kind, rule_id)| {
            [
                RuleWrite::Actions {
                    kind: kind.clone(),
                    rule_id: rule_id.clone(),
                    actions: if enabled {
                        event_actions(event)
                    } else {
                        vec![]
                    },
                },
                RuleWrite::Enabled {
                    kind,
                    rule_id,
                    enabled: true,
                },
            ]
        })
        .collect())
}

#[must_use]
pub fn master_muted(rules: &Ruleset) -> Option<bool> {
    rules
        .get(
            RuleKind::Override,
            PredefinedOverrideRuleId::Master.as_str(),
        )
        .map(ruma::push::AnyPushRuleRef::enabled)
}

#[must_use]
pub fn plan_master(muted: bool) -> Vec<RuleWrite> {
    vec![RuleWrite::Enabled {
        kind: RuleKind::Override,
        rule_id: PredefinedOverrideRuleId::Master.to_string(),
        enabled: muted,
    }]
}

#[must_use]
pub fn plan_membership(enabled: bool) -> Vec<RuleWrite> {
    let rule_id = PredefinedOverrideRuleId::MemberEvent.to_string();
    vec![
        RuleWrite::Actions {
            kind: RuleKind::Override,
            rule_id: rule_id.clone(),
            actions: if enabled {
                vec![Action::Notify]
            } else {
                vec![]
            },
        },
        RuleWrite::Enabled {
            kind: RuleKind::Override,
            rule_id,
            enabled: true,
        },
    ]
}

pub(super) fn reaction_to_me(user_id: &UserId) -> RuleWrite {
    RuleWrite::Put(NewPushRule::Override(NewConditionalPushRule::new(
        REACTION_TO_ME.to_owned(),
        vec![
            PushCondition::EventMatch(EventMatchConditionData::new(
                "type".to_owned(),
                "m.reaction".to_owned(),
            )),
            related_condition("m.annotation", "sender", user_id.as_str()),
        ],
        vec![Action::Notify],
    )))
}
