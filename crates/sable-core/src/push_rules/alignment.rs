use matrix_sdk::ruma::OwnedRoomId;
use matrix_sdk::ruma::push::{
    EventMatchConditionData, EventPropertyIsConditionData, NewConditionalPushRule, NewPushRule,
    PredefinedOverrideRuleId, PushCondition, RoomMemberCountConditionData, RuleKind, Ruleset,
    ScalarJsonValue, SenderNotificationPermissionConditionData,
};

use super::{
    RuleWrite, encrypted_rule, event_actions, event_notifies, message_rule, notifies,
    rule_notifies, sound, spec_actions,
};
use crate::protocol::EventNotificationView;

pub(super) const SHAPE_PREFIX: &str = "moe.sable.shape.";
pub(super) const STICKER: &str = "moe.sable.sticker";
pub(super) const STICKER_DIRECT: &str = "moe.sable.sticker_one_to_one";
pub(super) const RING_ONE_TO_ONE: &str = "moe.sable.ring_one_to_one";
pub(super) const RTC_INVITE_TYPES: [(&str, &str, &str); 3] = [
    (
        "m.rtc.invite",
        "moe.sable.rtc.invite_for_me",
        "moe.sable.rtc.invite_for_room",
    ),
    (
        "org.matrix.msc4075.rtc.notification",
        "moe.sable.rtc.invite_for_me.unstable",
        "moe.sable.rtc.invite_for_room.unstable",
    ),
    (
        "m.rtc.notification",
        "moe.sable.rtc.invite_for_me.legacy",
        "moe.sable.rtc.invite_for_room.legacy",
    ),
];
const RTC_INVITE_GUARDS: [(&str, &str); 3] = [
    ("m.rtc.invite", "moe.sable.rtc.suppress_invite"),
    (
        "org.matrix.msc4075.rtc.notification",
        "moe.sable.rtc.suppress_invite.unstable",
    ),
    ("m.rtc.notification", "moe.sable.rtc.suppress_invite.legacy"),
];
pub(super) const RTC_SERVER_USER_RULES: [&str; 2] = [
    ".m.rule.rtc.invite_for_me",
    ".org.matrix.msc4075.rule.rtc.invite_for_me",
];
pub(super) const RTC_SERVER_ROOM_RULES: [&str; 2] = [
    ".m.rule.rtc.invite_for_room",
    ".org.matrix.msc4075.rule.rtc.invite_for_room",
];
pub(super) const SUPPRESS_BRIDGE_STATUS: &str = "moe.sable.suppress_bridge_status";
pub(super) const SUPPRESS_REACTIONS: &str = "moe.sable.suppress_reactions";
/// A room rule matches every event, so these would notify in a room set to all messages.
pub(super) const SUPPRESSED_ROOM_EVENTS: [&str; 15] = [
    "m.room.name",
    "m.room.topic",
    "m.room.avatar",
    "m.room.canonical_alias",
    "m.room.pinned_events",
    "m.room.power_levels",
    "m.room.join_rules",
    "m.room.history_visibility",
    "m.room.redaction",
    "org.matrix.msc3401.call.member",
    "m.call.member",
    "org.matrix.msc4143.rtc.member",
    "m.rtc.member",
    "m.rtc.decline",
    "org.matrix.msc4310.rtc.decline",
];

#[must_use]
pub fn plan_alignment(rules: &Ruleset) -> Vec<RuleWrite> {
    let mut writes: Vec<_> = [true, false]
        .into_iter()
        .filter_map(|direct| {
            let plain = rules.get(RuleKind::Underride, message_rule(direct).as_str())?;
            let encrypted_id = encrypted_rule(direct);
            let encrypted = rules.get(RuleKind::Underride, encrypted_id.as_str())?;
            let notify = rule_notifies(plain);
            (notify != rule_notifies(encrypted)).then(|| {
                [
                    RuleWrite::Actions {
                        kind: RuleKind::Underride,
                        rule_id: encrypted_id.to_string(),
                        actions: if notify { spec_actions(direct) } else { vec![] },
                    },
                    RuleWrite::Enabled {
                        kind: RuleKind::Underride,
                        rule_id: encrypted_id.to_string(),
                        enabled: true,
                    },
                ]
            })
        })
        .flatten()
        .collect();

    writes.extend(align_stickers(rules, false));
    writes.extend(align_stickers(rules, true));
    writes.extend(align_rtc_invites(rules));
    writes.extend(silence_event_type(
        rules,
        SUPPRESS_BRIDGE_STATUS,
        "com.beeper.message_send_status",
        None,
    ));
    writes.extend(silence_event_type(
        rules,
        SUPPRESS_REACTIONS,
        "m.reaction",
        Some(PredefinedOverrideRuleId::Reaction.as_str()),
    ));
    writes.extend(SUPPRESSED_ROOM_EVENTS.iter().filter_map(|event_type| {
        silence_event_type(
            rules,
            &format!("moe.sable.suppress.{event_type}"),
            event_type,
            None,
        )
    }));
    writes
}
/// direct flag disagrees gets its own copies of the rules of the kind it is flagged as.
/// `rooms` holds those rooms with their flag; every other room's copies are removed.
#[must_use]
pub fn plan_room_shapes(rules: &Ruleset, rooms: &[(OwnedRoomId, bool)]) -> Vec<RuleWrite> {
    let kinds = [
        (
            "message",
            ".m.rule.room_one_to_one",
            ".m.rule.message",
            "m.room.message",
        ),
        (
            "encrypted",
            ".m.rule.encrypted_room_one_to_one",
            ".m.rule.encrypted",
            "m.room.encrypted",
        ),
        ("sticker", STICKER_DIRECT, STICKER, "m.sticker"),
    ];
    let mut wanted = std::collections::BTreeMap::new();
    for (room_id, direct) in rooms {
        for (kind, one_to_one, group, event_type) in kinds {
            let Some(source) = rules.get(
                RuleKind::Underride,
                if *direct { one_to_one } else { group },
            ) else {
                continue;
            };
            let actions = if rule_notifies(source) {
                source.actions().to_vec()
            } else {
                vec![]
            };
            wanted.insert(
                format!("{SHAPE_PREFIX}{kind}.{room_id}"),
                (room_id, event_type, actions),
            );
        }
    }

    let mut writes = Vec::new();
    for (rule_id, (room_id, event_type, actions)) in &wanted {
        match rules.underride.iter().find(|rule| rule.rule_id == *rule_id) {
            Some(rule)
                if rule.enabled
                    && notifies(&rule.actions) == notifies(actions)
                    && sound(&rule.actions) == sound(actions) => {}
            Some(_) => writes.extend([
                RuleWrite::Actions {
                    kind: RuleKind::Underride,
                    rule_id: rule_id.clone(),
                    actions: actions.clone(),
                },
                RuleWrite::Enabled {
                    kind: RuleKind::Underride,
                    rule_id: rule_id.clone(),
                    enabled: true,
                },
            ]),
            None => writes.push(RuleWrite::Put(NewPushRule::Underride(
                NewConditionalPushRule::new(
                    rule_id.clone(),
                    vec![
                        PushCondition::EventMatch(EventMatchConditionData::new(
                            "room_id".to_owned(),
                            room_id.to_string(),
                        )),
                        PushCondition::EventMatch(EventMatchConditionData::new(
                            "type".to_owned(),
                            (*event_type).to_owned(),
                        )),
                    ],
                    actions.clone(),
                ),
            ))),
        }
    }
    writes.extend(
        rules
            .underride
            .iter()
            .filter(|rule| {
                rule.rule_id.starts_with(SHAPE_PREFIX) && !wanted.contains_key(&rule.rule_id)
            })
            .map(|rule| RuleWrite::Delete {
                kind: RuleKind::Underride,
                rule_id: rule.rule_id.clone(),
            }),
    );
    writes
}

/// The spec's default rules only match `m.room.message`, so a sticker would never notify.
fn align_stickers(rules: &Ruleset, direct: bool) -> Vec<RuleWrite> {
    let Some(message) = rules.get(RuleKind::Underride, message_rule(direct).as_str()) else {
        return vec![];
    };
    let notify = rule_notifies(message);
    let rule_id = if direct { STICKER_DIRECT } else { STICKER };
    let actions = if notify { spec_actions(direct) } else { vec![] };
    match rules.underride.iter().find(|rule| rule.rule_id == rule_id) {
        None => {
            let mut conditions = vec![PushCondition::EventMatch(EventMatchConditionData::new(
                "type".to_owned(),
                "m.sticker".to_owned(),
            ))];
            if direct {
                conditions.insert(
                    0,
                    PushCondition::RoomMemberCount(RoomMemberCountConditionData::new(
                        matrix_sdk::ruma::uint!(2).into(),
                    )),
                );
            }
            vec![RuleWrite::Put(NewPushRule::Underride(
                NewConditionalPushRule::new(rule_id.to_owned(), conditions, actions),
            ))]
        }
        Some(rule) if rule.enabled && notifies(&rule.actions) == notify => vec![],
        Some(_) => vec![
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
        ],
    }
}

pub(super) fn is_rtc_rule(rule_id: &str) -> bool {
    RTC_SERVER_USER_RULES.contains(&rule_id)
        || RTC_SERVER_ROOM_RULES.contains(&rule_id)
        || RTC_INVITE_TYPES
            .iter()
            .any(|(_, user, room)| *user == rule_id || *room == rule_id)
}

fn rtc_server_rule<'a>(
    rules: &'a Ruleset,
    user: bool,
    event_type: Option<&str>,
) -> Option<&'a matrix_sdk::ruma::push::ConditionalPushRule> {
    let ids = if user {
        &RTC_SERVER_USER_RULES
    } else {
        &RTC_SERVER_ROOM_RULES
    };
    ids.iter()
        .filter_map(|id| rules.override_.get(*id))
        .find(|rule| {
            event_type.is_none_or(|event_type| {
                rule.conditions.iter().any(|condition| match condition {
                    PushCondition::EventPropertyIs(data) => {
                        data.key == "type"
                            && data.value == ScalarJsonValue::String(event_type.to_owned())
                    }
                    PushCondition::EventMatch(data) => {
                        data.key == "type" && data.pattern == event_type
                    }
                    _ => false,
                })
            })
        })
}

fn align_rtc_invites(rules: &Ruleset) -> Vec<RuleWrite> {
    let mut writes = Vec::new();
    if rules.override_.get(RING_ONE_TO_ONE).is_some() {
        writes.push(RuleWrite::Delete {
            kind: RuleKind::Override,
            rule_id: RING_ONE_TO_ONE.to_owned(),
        });
    }
    let user_condition = rules
        .override_
        .get(PredefinedOverrideRuleId::IsUserMention.as_str())
        .or_else(|| rtc_server_rule(rules, true, None))
        .and_then(|rule| {
            rule.conditions.iter().find(|condition| {
                matches!(condition, PushCondition::EventPropertyContains(data)
                if data.key == "content.m\\.mentions.user_ids")
            })
        })
        .cloned();
    let mut after = rules
        .override_
        .iter()
        .rev()
        .find(|rule| {
            !rule.default
                && rule.rule_id != RING_ONE_TO_ONE
                && !is_rtc_rule(&rule.rule_id)
                && !RTC_INVITE_GUARDS.iter().any(|(_, id)| *id == rule.rule_id)
        })
        .map(|rule| rule.rule_id.clone());
    for (event_type, user_id, room_id) in RTC_INVITE_TYPES {
        for (user, rule_id) in [(true, user_id), (false, room_id)] {
            let Some(conditions) = rtc_invite_conditions(event_type, user, user_condition.as_ref())
            else {
                continue;
            };
            let source = rtc_server_rule(rules, user, Some(event_type))
                .or_else(|| rtc_server_rule(rules, user, None));
            let actions = source.map_or_else(
                || {
                    if event_notifies(rules, EventNotificationView::Calls).unwrap_or(true) {
                        event_actions(EventNotificationView::Calls)
                    } else {
                        vec![]
                    }
                },
                |rule| rule.actions.clone(),
            );
            let enabled = source.is_none_or(|rule| rule.enabled);
            let existing = rules.override_.get(rule_id);
            match existing {
                None => {
                    let rule = NewPushRule::Override(NewConditionalPushRule::new(
                        rule_id.to_owned(),
                        conditions,
                        actions,
                    ));
                    writes.push(match &after {
                        Some(after) => RuleWrite::PutAfter {
                            rule,
                            after: after.clone(),
                        },
                        None => RuleWrite::Put(rule),
                    });
                }
                Some(rule) => {
                    if serde_json::to_value(&rule.conditions).ok()
                        != serde_json::to_value(&conditions).ok()
                    {
                        writes.push(RuleWrite::Put(NewPushRule::Override(
                            NewConditionalPushRule::new(
                                rule_id.to_owned(),
                                conditions,
                                actions.clone(),
                            ),
                        )));
                    } else if serde_json::to_value(&rule.actions).ok()
                        != serde_json::to_value(&actions).ok()
                    {
                        writes.push(RuleWrite::Actions {
                            kind: RuleKind::Override,
                            rule_id: rule_id.to_owned(),
                            actions,
                        });
                    }
                }
            }
            if existing.is_none_or(|rule| rule.enabled) != enabled {
                writes.push(RuleWrite::Enabled {
                    kind: RuleKind::Override,
                    rule_id: rule_id.to_owned(),
                    enabled,
                });
            }
            after = Some(rule_id.to_owned());
        }
    }
    writes.extend(align_invite_guards(rules, after));
    writes
}

fn rtc_invite_conditions(
    event_type: &str,
    user: bool,
    user_condition: Option<&PushCondition>,
) -> Option<Vec<PushCondition>> {
    let mut conditions = vec![PushCondition::EventPropertyIs(
        EventPropertyIsConditionData::new(
            "type".to_owned(),
            ScalarJsonValue::String(event_type.to_owned()),
        ),
    )];
    if user {
        conditions.push(user_condition?.clone());
    } else {
        conditions.extend([
            PushCondition::EventPropertyIs(EventPropertyIsConditionData::new(
                "content.m\\.mentions.room".to_owned(),
                ScalarJsonValue::Bool(true),
            )),
            PushCondition::SenderNotificationPermission(
                SenderNotificationPermissionConditionData::new("room".into()),
            ),
        ]);
    }
    Some(conditions)
}

fn align_invite_guards(rules: &Ruleset, mut after: Option<String>) -> Vec<RuleWrite> {
    let mut writes = Vec::new();
    // Invalid invites and withdrawals must not reach broad room rules.
    for (event_type, rule_id) in RTC_INVITE_GUARDS {
        let existing = rules.override_.get(rule_id);
        if existing.is_none_or(|rule| !rule.actions.is_empty()) {
            let rule = NewPushRule::Override(NewConditionalPushRule::new(
                rule_id.to_owned(),
                vec![PushCondition::EventPropertyIs(
                    EventPropertyIsConditionData::new(
                        "type".to_owned(),
                        ScalarJsonValue::String(event_type.to_owned()),
                    ),
                )],
                vec![],
            ));
            writes.push(match &after {
                Some(after) => RuleWrite::PutAfter {
                    rule,
                    after: after.clone(),
                },
                None => RuleWrite::Put(rule),
            });
        }
        if existing.is_some_and(|rule| !rule.enabled) {
            writes.push(RuleWrite::Enabled {
                kind: RuleKind::Override,
                rule_id: rule_id.to_owned(),
                enabled: true,
            });
        }
        after = Some(rule_id.to_owned());
    }
    writes
}

fn silence_event_type(
    rules: &Ruleset,
    rule_id: &str,
    event_type: &str,
    covered_by: Option<&str>,
) -> Option<RuleWrite> {
    let has = |id: &str| rules.override_.iter().find(|rule| rule.rule_id == id);
    match has(rule_id) {
        Some(rule) if rule.enabled => None,
        Some(_) => Some(RuleWrite::Enabled {
            kind: RuleKind::Override,
            rule_id: rule_id.to_owned(),
            enabled: true,
        }),
        None if covered_by.is_some_and(|id| has(id).is_some()) => None,
        None => Some(RuleWrite::Put(NewPushRule::Override(
            NewConditionalPushRule::new(
                rule_id.to_owned(),
                vec![PushCondition::EventMatch(EventMatchConditionData::new(
                    "type".to_owned(),
                    event_type.to_owned(),
                ))],
                vec![],
            ),
        ))),
    }
}
