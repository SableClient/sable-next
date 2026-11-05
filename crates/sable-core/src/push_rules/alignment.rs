use matrix_sdk::ruma::push::{ConditionalPushRule, RuleKind, Ruleset};
use matrix_sdk::ruma::{RoomId, UserId};
use serde_json::{Value, json};

use super::RuleWrite;

/// Per-room DM copies written by older versions.
const SHAPE_PREFIX: &str = "moe.sable.shape.";
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
pub(super) const RTC_INVITE_GUARDS: [(&str, &str); 3] = [
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
pub(super) const REACTION_TO_ME: &str = "moe.sable.reaction_to_me";
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

/// Delete unchanged rules added by older Sable versions.
#[must_use]
pub fn plan_cleanup(rules: &Ruleset, user_id: &UserId) -> Vec<RuleWrite> {
    let mut writes = Vec::new();
    for (kind, rules) in [
        (RuleKind::Override, &rules.override_),
        (RuleKind::Underride, &rules.underride),
    ] {
        for rule in rules
            .iter()
            .filter(|rule| is_generated(rule, &kind, user_id))
        {
            writes.push(RuleWrite::Delete {
                kind: kind.clone(),
                rule_id: rule.rule_id.clone(),
            });
        }
    }
    writes
}

fn definition(rule: &ConditionalPushRule, conditions: Value, actions: &Value) -> bool {
    !rule.default
        && serde_json::to_value(&rule.conditions).ok() == Some(conditions)
        && serde_json::to_value(&rule.actions)
            .is_ok_and(|value| value == json!([]) || value == *actions)
}

fn event_match(event_type: &str) -> Value {
    json!({"kind":"event_match", "key":"type", "pattern":event_type})
}

fn is_generated(rule: &ConditionalPushRule, kind: &RuleKind, user_id: &UserId) -> bool {
    if *kind == RuleKind::Underride {
        if [STICKER, STICKER_DIRECT].contains(&rule.rule_id.as_str()) {
            let direct = rule.rule_id == STICKER_DIRECT;
            let mut conditions = vec![event_match("m.sticker")];
            if direct {
                conditions.insert(0, json!({"kind":"room_member_count", "is":"2"}));
            }
            return definition(rule, json!(conditions), &json!(super::spec_actions(direct)));
        }
        if let Some(suffix) = rule.rule_id.strip_prefix(SHAPE_PREFIX)
            && let Some((family, room_id)) = suffix.split_once('.')
            && RoomId::parse(room_id).is_ok()
        {
            let event_type = match family {
                "message" => "m.room.message",
                "encrypted" => "m.room.encrypted",
                "sticker" => "m.sticker",
                _ => return false,
            };
            let conditions = json!([
                {"kind":"event_match", "key":"room_id", "pattern":room_id},
                event_match(event_type),
            ]);
            return [false, true].into_iter().any(|direct| {
                definition(
                    rule,
                    conditions.clone(),
                    &json!(super::spec_actions(direct)),
                )
            });
        }
        return false;
    }

    let event_type = match rule.rule_id.as_str() {
        SUPPRESS_BRIDGE_STATUS => Some("com.beeper.message_send_status"),
        SUPPRESS_REACTIONS => Some("m.reaction"),
        id => id
            .strip_prefix("moe.sable.suppress.")
            .filter(|event_type| SUPPRESSED_ROOM_EVENTS.contains(event_type)),
    };
    if let Some(event_type) = event_type {
        return definition(rule, json!([event_match(event_type)]), &json!([]));
    }
    for (event_type, id) in RTC_INVITE_GUARDS {
        if rule.rule_id == id {
            return definition(
                rule,
                json!([
                    {"kind":"event_property_is", "key":"type", "value":event_type}
                ]),
                &json!([]),
            );
        }
    }
    for (event_type, user, room) in RTC_INVITE_TYPES {
        if rule.rule_id != user && rule.rule_id != room {
            continue;
        }
        let mut conditions =
            vec![json!({"kind":"event_property_is", "key":"type", "value":event_type})];
        if rule.rule_id == user {
            conditions.push(json!({"kind":"event_property_contains", "key":r"content.m\.mentions.user_ids", "value":user_id}));
        } else {
            conditions.extend([
                json!({"kind":"event_property_is", "key":r"content.m\.mentions.room", "value":true}),
                json!({"kind":"sender_notification_permission", "key":"room"}),
            ]);
        }
        return definition(
            rule,
            json!(conditions),
            &json!(["notify", {"set_tweak":"sound", "value":"ring"}]),
        );
    }
    if rule.rule_id == RING_ONE_TO_ONE {
        return definition(
            rule,
            json!([
                {"kind":"room_member_count", "is":"2"},
                event_match("org.matrix.msc4075.rtc.notification"),
                {"kind":"event_property_is", "key":"content.notification_type", "value":"ring"},
            ]),
            &json!(["notify", {"set_tweak":"sound", "value":"ring"}]),
        );
    }
    false
}
