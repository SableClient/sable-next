use matrix_sdk::ruma::push::{
    ConditionalPushRule, NewPushRule, PredefinedOverrideRuleId, PredefinedUnderrideRuleId,
    RuleKind, Ruleset,
};
use matrix_sdk::ruma::{room_id, user_id};
use serde_json::json;

use super::categories::event_notifies;
use super::{
    RuleWrite, default_modes, event_notifications, keywords, level_actions, master_muted,
    mention_notifications, new_rule, plan_add_keyword, plan_cleanup, plan_default_mode, plan_event,
    plan_keyword_mode, plan_master, plan_mention, plan_remove_keyword, plan_room_mode,
    pushes_every_encrypted_event, room_mode, rule_notifies,
};
use crate::protocol::{
    EventNotificationView, MentionNotificationModeView, MentionRuleView, NotificationModeView,
};

fn describe(writes: &[RuleWrite]) -> Vec<String> {
    writes
        .iter()
        .map(|write| match write {
            RuleWrite::Put(rule) => {
                let actions = match rule {
                    NewPushRule::Override(rule) | NewPushRule::Underride(rule) => &rule.actions,
                    NewPushRule::Content(rule) => &rule.actions,
                    NewPushRule::Room(rule) => &rule.actions,
                    NewPushRule::Sender(rule) => &rule.actions,
                    _ => panic!("an unexpected push rule kind"),
                };
                format!(
                    "put {} {}",
                    rule.rule_id(),
                    serde_json::to_value(actions).unwrap_or_default()
                )
            }
            RuleWrite::Actions {
                kind,
                rule_id,
                actions,
            } => format!(
                "actions {kind} {rule_id} {}",
                serde_json::to_value(actions).unwrap_or_default()
            ),
            RuleWrite::Enabled {
                kind,
                rule_id,
                enabled,
            } => format!("enabled {kind} {rule_id} {enabled}"),
            RuleWrite::Delete { kind, rule_id } => format!("delete {kind} {rule_id}"),
        })
        .collect()
}

fn applied(mut rules: Ruleset, writes: Vec<RuleWrite>) -> Ruleset {
    for write in writes {
        write.apply_to(&mut rules);
    }
    rules
}

fn me() -> &'static matrix_sdk::ruma::UserId {
    user_id!("@me:example.org")
}

#[test]
fn a_room_mode_does_not_depend_on_what_the_cache_believed() {
    let room = room_id!("!r:example.org");

    assert_eq!(
        describe(&plan_room_mode(
            room,
            false,
            Some(NotificationModeView::All)
        )),
        vec![
            r#"put !r:example.org ["notify"]"#,
            "enabled room !r:example.org true",
            "delete override !r:example.org",
        ]
    );
    assert_eq!(
        describe(&plan_room_mode(room, false, None)),
        vec![
            "delete override !r:example.org",
            "delete room !r:example.org"
        ]
    );
}

#[test]
fn a_room_rule_matching_the_default_is_still_an_explicit_choice() {
    let room = room_id!("!bridged:example.org");
    let rules = Ruleset::server_default(me());
    let chosen = applied(
        rules,
        plan_room_mode(room, true, Some(NotificationModeView::All)),
    );
    let settings = super::room_settings(&chosen, room, false);
    assert_eq!(settings.room, Some(NotificationModeView::All));
}

#[test]
fn a_room_mode_round_trips_through_the_ruleset() {
    let room = room_id!("!r:example.org");
    let mut rules = Ruleset::server_default(me());
    for mode in [
        Some(NotificationModeView::Mute),
        Some(NotificationModeView::All),
        Some(NotificationModeView::Mentions),
        Some(NotificationModeView::Mute),
        None,
        Some(NotificationModeView::Mentions),
        Some(NotificationModeView::All),
    ] {
        rules = applied(rules.clone(), plan_room_mode(room, false, mode));
        assert_eq!(room_mode(&rules, room), mode);
    }
}

#[test]
fn all_messages_in_a_room_rings_only_where_the_spec_default_does() {
    let room = room_id!("!r:example.org");

    assert_eq!(
        describe(&plan_room_mode(
            room,
            false,
            Some(NotificationModeView::All)
        ))[0],
        r#"put !r:example.org ["notify"]"#
    );
    assert_eq!(
        describe(&plan_room_mode(room, true, Some(NotificationModeView::All)))[0],
        r#"put !r:example.org ["notify",{"set_tweak":"sound","value":"default"}]"#
    );
}

#[test]
fn a_mute_from_another_client_under_its_own_id_is_preserved() {
    let room = room_id!("!r:example.org");
    let mut rules = Ruleset::server_default(me());
    rules.override_.insert(
        serde_json::from_value::<ConditionalPushRule>(json!({
            "rule_id": "other-client-mute",
            "default": false,
            "enabled": true,
            "conditions": [{"kind": "event_match", "key": "room_id", "pattern": "!r:example.org"}],
            "actions": [],
        }))
        .unwrap(),
    );
    assert_eq!(room_mode(&rules, room), Some(NotificationModeView::Mute));

    let rules = applied(rules.clone(), plan_room_mode(room, false, None));

    assert_eq!(room_mode(&rules, room), Some(NotificationModeView::Mute));
    assert!(rules.override_.get("other-client-mute").is_some());
}

#[test]
fn a_disabled_room_rule_is_not_the_room_mode() {
    let room = room_id!("!r:example.org");
    let mut rules = Ruleset::server_default(me());
    rules = applied(
        rules.clone(),
        plan_room_mode(room, false, Some(NotificationModeView::All)),
    );
    rules
        .set_enabled(RuleKind::Room, room.as_str(), false)
        .unwrap();

    assert_eq!(room_mode(&rules, room), None);
}

#[test]
fn a_default_switched_back_to_all_restores_the_spec_actions() {
    let rules = Ruleset::server_default(me());
    let mentions = applied(
        rules.clone(),
        plan_default_mode(&rules, false, NotificationModeView::Mentions).unwrap(),
    );
    assert_eq!(
        default_modes(&mentions).group,
        NotificationModeView::Mentions
    );

    let all = applied(
        mentions.clone(),
        plan_default_mode(&mentions, false, NotificationModeView::All).unwrap(),
    );

    assert_eq!(default_modes(&all).group, NotificationModeView::All);
    for rule_id in [
        PredefinedUnderrideRuleId::Message,
        PredefinedUnderrideRuleId::Encrypted,
        PredefinedUnderrideRuleId::PollStart,
        PredefinedUnderrideRuleId::PollEnd,
    ] {
        let actions = |rules: &Ruleset| {
            serde_json::to_value(
                rules
                    .get(RuleKind::Underride, rule_id.as_str())
                    .unwrap()
                    .actions(),
            )
            .unwrap()
        };
        assert_eq!(
            actions(&all),
            actions(&rules),
            "{rule_id} should be back to its spec default"
        );
    }
}

#[test]
fn a_default_is_refused_where_the_server_has_no_rule() {
    let mut rules = Ruleset::server_default(me());
    rules.underride.clear();

    plan_default_mode(&rules, false, NotificationModeView::All).unwrap_err();
}

#[test]
fn mention_levels_write_highlighting_actions() {
    assert_eq!(
        serde_json::to_value(level_actions(MentionNotificationModeView::Notify, true)).unwrap(),
        json!(["notify", {"set_tweak": "highlight"}])
    );
    assert_eq!(
        serde_json::to_value(level_actions(MentionNotificationModeView::Loud, true)).unwrap(),
        json!(["notify", {"set_tweak": "sound", "value": "default"}, {"set_tweak": "highlight"}])
    );
    assert_eq!(
        serde_json::to_value(level_actions(MentionNotificationModeView::Off, true)).unwrap(),
        json!([])
    );
}

#[test]
fn a_mention_turned_off_is_disabled_and_turned_on_is_rewritten_then_enabled() {
    let rules = Ruleset::server_default(me());

    assert_eq!(
        describe(
            &plan_mention(
                &rules,
                MentionRuleView::User,
                MentionNotificationModeView::Off
            )
            .unwrap()
        ),
        vec!["enabled override .m.rule.is_user_mention false"]
    );
    let off = applied(
        rules.clone(),
        plan_mention(
            &rules,
            MentionRuleView::User,
            MentionNotificationModeView::Off,
        )
        .unwrap(),
    );
    assert_eq!(
        mention_notifications(&off).user,
        Some(MentionNotificationModeView::Off)
    );

    let on = applied(
        off.clone(),
        plan_mention(
            &off,
            MentionRuleView::User,
            MentionNotificationModeView::Notify,
        )
        .unwrap(),
    );
    assert_eq!(
        mention_notifications(&on).user,
        Some(MentionNotificationModeView::Notify)
    );
}

#[test]
fn room_mentions_fall_back_to_the_legacy_rule_and_absent_rules_hide() {
    let mut rules = Ruleset::server_default(me());
    let view = mention_notifications(&rules);
    assert_eq!(view.room, Some(MentionNotificationModeView::Notify));
    assert_eq!(view.user, Some(MentionNotificationModeView::Loud));
    assert_eq!(view.display_name, None);
    assert_eq!(view.username, None);

    rules
        .override_
        .shift_remove(PredefinedOverrideRuleId::IsRoomMention.as_str());
    rules.override_.insert(
        serde_json::from_value::<ConditionalPushRule>(json!({
            "rule_id": ".m.rule.roomnotif",
            "default": true,
            "enabled": true,
            "conditions": [{"kind": "event_match", "key": "content.body", "pattern": "@room"}],
            "actions": ["notify", {"set_tweak": "highlight"}],
        }))
        .unwrap(),
    );
    assert_eq!(
        describe(
            &plan_mention(
                &rules,
                MentionRuleView::Room,
                MentionNotificationModeView::Off
            )
            .unwrap()
        ),
        vec!["enabled override .m.rule.roomnotif false"]
    );

    rules.override_.clear();
    assert_eq!(mention_notifications(&rules).room, None);
    plan_mention(
        &rules,
        MentionRuleView::Room,
        MentionNotificationModeView::Off,
    )
    .unwrap_err();
}

#[test]
fn the_master_rule_reads_as_muted_only_while_enabled() {
    let mut rules = Ruleset::server_default(me());
    assert_eq!(master_muted(&rules), Some(false));

    rules = applied(rules.clone(), plan_master(true));
    assert_eq!(master_muted(&rules), Some(true));

    rules = applied(rules.clone(), plan_master(false));
    assert_eq!(master_muted(&rules), Some(false));

    rules.override_.clear();
    assert_eq!(master_muted(&rules), None);
}

#[test]
fn each_event_rule_reads_as_on_only_while_it_notifies() {
    use EventNotificationView::{Calls, Edits, Invites, Membership, Notices, Reactions};

    let defaults = Ruleset::server_default(me());
    let read = |rules: &Ruleset| {
        let view = event_notifications(rules);
        [
            view.membership,
            view.reactions,
            view.edits,
            view.notices,
            view.invites,
            view.calls,
        ]
    };
    assert_eq!(
        read(&defaults),
        [
            Some(false),
            Some(false),
            Some(false),
            Some(false),
            Some(true),
            Some(true)
        ]
    );

    for event in [Membership, Reactions, Edits, Notices, Invites, Calls] {
        let on = applied(
            defaults.clone(),
            plan_event(&defaults, event, true, me()).unwrap(),
        );
        assert_eq!(event_notifies(&on, event), Some(true));
        let off = applied(on.clone(), plan_event(&on, event, false, me()).unwrap());
        assert_eq!(event_notifies(&off, event), Some(false));
    }
}

#[test]
fn turning_an_event_back_on_restores_the_spec_actions() {
    let defaults = Ruleset::server_default(me());
    let off = applied(
        defaults.clone(),
        plan_event(&defaults, EventNotificationView::Calls, false, me()).unwrap(),
    );
    let on = applied(
        off.clone(),
        plan_event(&off, EventNotificationView::Calls, true, me()).unwrap(),
    );
    let actions = |rules: &Ruleset| {
        serde_json::to_value(
            rules
                .get(
                    RuleKind::Underride,
                    PredefinedUnderrideRuleId::Call.as_str(),
                )
                .unwrap()
                .actions(),
        )
        .unwrap()
    };
    assert_eq!(actions(&on), actions(&defaults));
}

#[test]
fn missing_reaction_rules_are_not_installed_automatically() {
    let mut rules = Ruleset::server_default(me());
    rules
        .override_
        .shift_remove(PredefinedOverrideRuleId::Reaction.as_str());
    assert_eq!(event_notifications(&rules).reactions, None);
    assert!(plan_cleanup(&rules, me()).is_empty());
}

#[test]
fn a_missing_event_rule_has_no_state_and_no_plan() {
    let mut rules = Ruleset::server_default(me());
    rules.override_.clear();
    assert_eq!(event_notifications(&rules).membership, None);
    plan_event(&rules, EventNotificationView::Membership, true, me()).unwrap_err();
}

#[test]
fn a_keyword_disabled_elsewhere_is_listed_and_re_enabled_by_adding_it() {
    let mut rules = Ruleset::server_default(me());
    rules.content.insert(
        serde_json::from_value(json!({
            "rule_id": "keyword-1",
            "pattern": "sable",
            "default": false,
            "enabled": false,
            "actions": ["notify"],
        }))
        .unwrap(),
    );
    assert_eq!(keywords(&rules)[0].mode, MentionNotificationModeView::Off);

    let rules = applied(rules.clone(), plan_add_keyword(&rules, " sable ").unwrap());

    assert_eq!(keywords(&rules).len(), 1);
    assert_eq!(
        keywords(&rules)[0].mode,
        MentionNotificationModeView::Notify
    );
}

#[test]
fn a_new_keyword_notifies_with_a_highlight_under_a_valid_rule_id() {
    let rules = Ruleset::server_default(me());

    assert_eq!(
        describe(&plan_add_keyword(&rules, ".net").unwrap()),
        vec![
            r#"put moe.sable.keyword.Lm5ldA ["notify",{"set_tweak":"highlight"}]"#,
            "enabled content moe.sable.keyword.Lm5ldA true",
        ]
    );
    let rules = applied(rules.clone(), plan_add_keyword(&rules, "a/b").unwrap());
    assert_eq!(keywords(&rules)[0].keyword, "a/b");
    plan_add_keyword(&rules, "  ").unwrap_err();
}

#[test]
fn distinct_keywords_never_replace_each_other() {
    let mut rules = Ruleset::server_default(me());
    let patterns = ["a/b", "a_b", "a\\b", ".alert", "keyword.alert", "café"];
    for pattern in patterns {
        let writes = plan_add_keyword(&rules, pattern).unwrap();
        rules = applied(rules, writes);
    }
    for pattern in patterns {
        assert_eq!(
            rules
                .content
                .iter()
                .filter(|rule| rule.pattern == pattern)
                .count(),
            1
        );
    }
    let removed = applied(rules.clone(), plan_remove_keyword(&rules, "a/b"));
    assert!(
        !keywords(&removed)
            .iter()
            .any(|entry| entry.keyword == "a/b")
    );
    assert!(
        keywords(&removed)
            .iter()
            .any(|entry| entry.keyword == "a_b")
    );
    assert!(plan_remove_keyword(&removed, "a/b").is_empty());
}

#[test]
fn a_reserved_keyword_id_keeps_the_existing_rule() {
    let mut rules = Ruleset::server_default(me());
    rules.content.insert(
        serde_json::from_value(json!({
            "rule_id": "moe.sable.keyword.YS9i", "pattern": "other", "default": false,
            "enabled": true, "actions": ["notify"]
        }))
        .unwrap(),
    );
    let writes = plan_add_keyword(&rules, "a/b").unwrap();
    let updated = applied(rules, writes);
    assert_eq!(
        updated
            .content
            .iter()
            .find(|rule| rule.rule_id == "moe.sable.keyword.YS9i")
            .unwrap()
            .pattern,
        "other"
    );
    assert!(updated.content.iter().any(|rule| rule.pattern == "a/b"));
}

#[test]
fn a_keyword_level_and_removal_reach_every_rule_carrying_it() {
    let mut rules = Ruleset::server_default(me());
    for id in ["one", "two"] {
        rules.content.insert(
            serde_json::from_value(json!({
                "rule_id": id, "pattern": "sable", "default": false, "enabled": true,
                "actions": ["notify"],
            }))
            .unwrap(),
        );
    }

    let loud = applied(
        rules.clone(),
        plan_keyword_mode(&rules, "sable", MentionNotificationModeView::Loud),
    );
    assert_eq!(keywords(&loud)[0].mode, MentionNotificationModeView::Loud);

    let removed = applied(loud.clone(), plan_remove_keyword(&loud, "sable"));
    assert_eq!(
        keywords(&removed),
        [] as [crate::protocol::KeywordNotificationView; 0]
    );
    assert!(plan_remove_keyword(&removed, "other").is_empty());
}

#[test]
fn the_msc4028_rule_is_detected_only_while_it_notifies() {
    let mut rules = Ruleset::server_default(me());
    assert!(!pushes_every_encrypted_event(&rules));

    let rule = |enabled: bool, actions: serde_json::Value| {
        serde_json::from_value::<ConditionalPushRule>(json!({
            "rule_id": ".org.matrix.msc4028.encrypted_event",
            "default": true,
            "enabled": enabled,
            "conditions": [{"kind": "event_match", "key": "type", "pattern": "m.room.encrypted"}],
            "actions": actions,
        }))
        .unwrap()
    };

    rules.override_.insert(rule(true, json!(["notify"])));
    assert!(pushes_every_encrypted_event(&rules));

    rules
        .override_
        .shift_remove(".org.matrix.msc4028.encrypted_event");
    rules.override_.insert(rule(false, json!(["notify"])));
    assert!(!pushes_every_encrypted_event(&rules));

    rules
        .override_
        .shift_remove(".org.matrix.msc4028.encrypted_event");
    rules.override_.insert(rule(true, json!([])));
    assert!(!pushes_every_encrypted_event(&rules));
}

async fn invite_actions(
    rules: &Ruleset,
    event_type: &str,
    mentions: serde_json::Value,
    sender_power: i8,
) -> Vec<super::Action> {
    use matrix_sdk::ruma::power_levels::NotificationPowerLevels;
    use matrix_sdk::ruma::push::{PushConditionPowerLevelsCtx, PushConditionRoomCtx};
    use matrix_sdk::ruma::room_version_rules::{AuthorizationRules, RoomPowerLevelsRules};
    use matrix_sdk::ruma::serde::Raw;

    let context = PushConditionRoomCtx::new(
        room_id!("!call:example.org").to_owned(),
        5_u8.into(),
        me().to_owned(),
        "me".to_owned(),
    )
    .with_power_levels(PushConditionPowerLevelsCtx::new(
        std::collections::BTreeMap::new(),
        sender_power.into(),
        NotificationPowerLevels::new(),
        RoomPowerLevelsRules::new(&AuthorizationRules::V1, None),
    ));
    let event = Raw::new(&json!({
        "type": event_type, "event_id": "$announcement", "sender": "@caller:example.org",
        "room_id": "!call:example.org", "origin_server_ts": 1000,
        "content": {
            "slot_id": "m.call#room", "sender_ts": 1000, "lifetime": 90000,
            "notification_type": "notification", "m.mentions": mentions,
            "m.relates_to": {"rel_type": "m.reference", "event_id": "$membership"},
            "m.text": [{"body": "Call started"}]
        }
    }))
    .unwrap();
    rules.get_actions(&event, &context).await.to_vec()
}

fn rtc_rules() -> Ruleset {
    let mut rules = Ruleset::server_default(me());
    for (event_type, user, room) in [
        (
            "m.rtc.invite",
            ".m.rule.rtc.invite_for_me",
            ".m.rule.rtc.invite_for_room",
        ),
        (
            "org.matrix.msc4075.rtc.notification",
            ".org.matrix.msc4075.rule.rtc.invite_for_me",
            ".org.matrix.msc4075.rule.rtc.invite_for_room",
        ),
    ] {
        for (id, target, before) in [
            (
                user,
                json!([{"kind":"event_property_contains", "key":r"content.m\.mentions.user_ids", "value":me()}]),
                ".m.rule.is_user_mention",
            ),
            (
                room,
                json!([
                    {"kind":"event_property_is", "key":r"content.m\.mentions.room", "value":true},
                    {"kind":"sender_notification_permission", "key":"room"}
                ]),
                ".m.rule.is_room_mention",
            ),
        ] {
            let mut conditions =
                vec![json!({"kind":"event_property_is", "key":"type", "value":event_type})];
            conditions.extend(target.as_array().unwrap().clone());
            let index = rules.override_.get_index_of(before).unwrap();
            rules.override_.insert(
                serde_json::from_value(json!({
                    "rule_id":id, "default":true, "enabled":true, "conditions":conditions,
                    "actions":["notify", {"set_tweak":"sound", "value":"ring"}],
                }))
                .unwrap(),
            );
            rules.override_.move_index(rules.override_.len() - 1, index);
        }
    }
    rules
}

#[tokio::test]
async fn server_rtc_rules_respect_targets_mentions_only_and_mutes() {
    let rules = rtc_rules();
    assert!(plan_cleanup(&rules, me()).is_empty());
    let room = room_id!("!call:example.org");
    for mode in [
        None,
        Some(NotificationModeView::Mentions),
        Some(NotificationModeView::Mute),
    ] {
        let rules = applied(rules.clone(), plan_room_mode(room, false, mode));
        for event_type in ["m.rtc.invite", "org.matrix.msc4075.rtc.notification"] {
            for mentions in [json!({"user_ids":[me()]}), json!({"room":true})] {
                let actions = invite_actions(&rules, event_type, mentions, 100).await;
                assert_eq!(
                    super::notifies(&actions),
                    mode != Some(NotificationModeView::Mute)
                );
                assert!(!actions.iter().any(super::Action::is_highlight));
            }
            for mentions in [json!({}), json!({"user_ids":["@other:example.org"]})] {
                assert!(!super::notifies(
                    &invite_actions(&rules, event_type, mentions, 100).await
                ));
            }
            assert!(!super::notifies(
                &invite_actions(&rules, event_type, json!({"room":true}), 0).await
            ));
        }
    }
}

#[tokio::test]
async fn rtc_controls_are_independent_of_mentions_and_legacy_calls() {
    let rules = rtc_rules();
    let off = applied(
        rules.clone(),
        plan_event(&rules, EventNotificationView::RtcUser, false, me()).unwrap(),
    );
    assert_eq!(event_notifications(&off).rtc_user, Some(false));
    assert_eq!(event_notifications(&off).rtc_room, Some(true));
    assert_eq!(event_notifications(&off).calls, Some(true));
    assert_eq!(
        serde_json::to_value(mention_notifications(&off)).unwrap(),
        serde_json::to_value(mention_notifications(&rules)).unwrap()
    );
    for event_type in ["m.rtc.invite", "org.matrix.msc4075.rtc.notification"] {
        assert!(!super::notifies(
            &invite_actions(&off, event_type, json!({"user_ids":[me()]}), 0).await
        ));
        assert!(super::notifies(
            &invite_actions(&off, event_type, json!({"room":true}), 100).await
        ));
    }
    let room_off = applied(
        off.clone(),
        plan_event(&off, EventNotificationView::RtcRoom, false, me()).unwrap(),
    );
    let legacy_off = applied(
        rules.clone(),
        plan_event(&rules, EventNotificationView::Calls, false, me()).unwrap(),
    );
    assert_eq!(event_notifications(&legacy_off).rtc_user, Some(true));
    assert_eq!(event_notifications(&legacy_off).rtc_room, Some(true));
    assert_eq!(event_notifications(&room_off).rtc_room, Some(false));
    assert!(plan_cleanup(&off, me()).is_empty());
    let on = applied(
        off.clone(),
        plan_event(&off, EventNotificationView::RtcUser, true, me()).unwrap(),
    );
    assert_eq!(event_notifications(&on).rtc_user, Some(true));
}

#[test]
fn rtc_controls_require_server_rules_and_do_not_depend_on_legacy_calls() {
    let defaults = Ruleset::server_default(me());
    assert_eq!(event_notifications(&defaults).rtc_user, None);
    assert_eq!(event_notifications(&defaults).rtc_room, None);
    plan_event(&defaults, EventNotificationView::RtcUser, true, me()).unwrap_err();
    let mut rules = rtc_rules();
    rules.underride.shift_remove(".m.rule.call");
    assert_eq!(event_notifications(&rules).calls, None);
    plan_event(&rules, EventNotificationView::RtcUser, false, me()).unwrap();
}

#[test]
fn rtc_controls_report_any_enabled_alias_and_can_disable_it() {
    let mut rules = rtc_rules();
    rules
        .set_enabled(RuleKind::Override, ".m.rule.rtc.invite_for_me", false)
        .unwrap();
    assert_eq!(event_notifications(&rules).rtc_user, Some(true));
    let off = applied(
        rules.clone(),
        plan_event(&rules, EventNotificationView::RtcUser, false, me()).unwrap(),
    );
    assert_eq!(event_notifications(&off).rtc_user, Some(false));
    rules.override_.shift_remove(".m.rule.rtc.invite_for_me");
    let off = applied(
        rules.clone(),
        plan_event(&rules, EventNotificationView::RtcUser, false, me()).unwrap(),
    );
    assert_eq!(event_notifications(&off).rtc_user, Some(false));
}

#[test]
fn a_reaction_rule_can_be_disabled_without_a_server_suppression_rule() {
    let defaults = Ruleset::server_default(me());
    let mut rules = applied(
        defaults.clone(),
        plan_event(&defaults, EventNotificationView::Reactions, true, me()).unwrap(),
    );
    rules.override_.shift_remove(".m.rule.reaction");
    assert_eq!(event_notifications(&rules).reactions, Some(true));
    let off = applied(
        rules.clone(),
        plan_event(&rules, EventNotificationView::Reactions, false, me()).unwrap(),
    );
    assert!(off.override_.get("moe.sable.reaction_to_me").is_none());
    assert!(plan_cleanup(&off, me()).is_empty());
}

#[test]
fn reactions_notify_through_an_msc3664_rule_for_our_own_events() {
    let defaults = Ruleset::server_default(me());
    let on = applied(
        defaults.clone(),
        plan_event(&defaults, EventNotificationView::Reactions, true, me()).unwrap(),
    );
    let rule = on
        .override_
        .iter()
        .find(|rule| rule.rule_id == "moe.sable.reaction_to_me")
        .unwrap();
    assert_eq!(
        serde_json::to_value(&rule.conditions).unwrap(),
        json!([
            {"kind": "event_match", "key": "type", "pattern": "m.reaction"},
            {
                "kind": "im.nheko.msc3664.related_event_match",
                "rel_type": "m.annotation",
                "key": "sender",
                "pattern": "@me:example.org"
            }
        ])
    );
    assert!(!rule_notifies(
        on.get(
            RuleKind::Override,
            PredefinedOverrideRuleId::Reaction.as_str()
        )
        .unwrap()
    ));

    let off = applied(
        on.clone(),
        plan_event(&on, EventNotificationView::Reactions, false, me()).unwrap(),
    );
    assert!(
        off.get(RuleKind::Override, "moe.sable.reaction_to_me")
            .is_none()
    );
    assert_eq!(event_notifications(&off).reactions, Some(false));
}

#[test]
fn cleanup_preserves_existing_reaction_and_encrypted_preferences() {
    let mut rules = rtc_rules();
    for (kind, id, actions) in [
        (
            RuleKind::Override,
            ".m.rule.reaction",
            vec![super::Action::Notify],
        ),
        (RuleKind::Underride, ".m.rule.message", vec![]),
        (RuleKind::Override, ".m.rule.rtc.invite_for_me", vec![]),
    ] {
        rules.set_actions(kind, id, actions).unwrap();
    }
    rules
        .set_enabled(RuleKind::Underride, ".m.rule.encrypted", false)
        .unwrap();
    let rules = applied(
        rules.clone(),
        plan_event(&rules, EventNotificationView::Reactions, true, me()).unwrap(),
    );
    assert!(plan_cleanup(&rules, me()).is_empty());
}

#[expect(
    clippy::too_many_lines,
    reason = "historical rule fixtures kept together"
)]
fn legacy_rules() -> Ruleset {
    let mut rules = rtc_rules();
    let mut insert = |kind, id: &str, conditions, actions| {
        let value = json!({"rule_id":id, "default":false, "enabled":false, "conditions":conditions, "actions":actions});
        let rule = serde_json::from_value(value).unwrap();
        match kind {
            RuleKind::Override => {
                rules.override_.insert(rule);
            }
            RuleKind::Underride => {
                rules.underride.insert(rule);
            }
            _ => unreachable!(),
        }
    };
    for (id, conditions, actions) in [
        (
            "moe.sable.sticker",
            json!([{"kind":"event_match", "key":"type", "pattern":"m.sticker"}]),
            json!(["notify"]),
        ),
        (
            "moe.sable.sticker_one_to_one",
            json!([
                {"kind":"room_member_count", "is":"2"},
                {"kind":"event_match", "key":"type", "pattern":"m.sticker"}
            ]),
            json!(["notify", {"set_tweak":"sound", "value":"default"}]),
        ),
    ] {
        insert(RuleKind::Underride, id, conditions, actions);
    }
    for (id, event_type) in [
        (
            "moe.sable.suppress_bridge_status".to_owned(),
            "com.beeper.message_send_status",
        ),
        ("moe.sable.suppress_reactions".to_owned(), "m.reaction"),
    ]
    .into_iter()
    .chain(
        super::alignment::SUPPRESSED_ROOM_EVENTS
            .into_iter()
            .map(|event_type| (format!("moe.sable.suppress.{event_type}"), event_type)),
    ) {
        insert(
            RuleKind::Override,
            &id,
            json!([{"kind":"event_match", "key":"type", "pattern":event_type}]),
            json!([]),
        );
    }
    for (event_type, user, room) in super::alignment::RTC_INVITE_TYPES {
        for (id, target) in [
            (
                user,
                json!([{"kind":"event_property_contains", "key":r"content.m\.mentions.user_ids", "value":me()}]),
            ),
            (
                room,
                json!([
                    {"kind":"event_property_is", "key":r"content.m\.mentions.room", "value":true},
                    {"kind":"sender_notification_permission", "key":"room"}
                ]),
            ),
        ] {
            let mut conditions =
                vec![json!({"kind":"event_property_is", "key":"type", "value":event_type})];
            conditions.extend(target.as_array().unwrap().clone());
            insert(
                RuleKind::Override,
                id,
                json!(conditions),
                json!(["notify", {"set_tweak":"sound", "value":"ring"}]),
            );
        }
    }
    for (event_type, id) in super::alignment::RTC_INVITE_GUARDS {
        insert(
            RuleKind::Override,
            id,
            json!([{"kind":"event_property_is", "key":"type", "value":event_type}]),
            json!([]),
        );
    }
    insert(
        RuleKind::Override,
        "moe.sable.ring_one_to_one",
        json!([
            {"kind":"room_member_count", "is":"2"},
            {"kind":"event_match", "key":"type", "pattern":"org.matrix.msc4075.rtc.notification"},
            {"kind":"event_property_is", "key":"content.notification_type", "value":"ring"}
        ]),
        json!(["notify", {"set_tweak":"sound", "value":"ring"}]),
    );
    for (family, event_type) in [
        ("message", "m.room.message"),
        ("encrypted", "m.room.encrypted"),
        ("sticker", "m.sticker"),
    ] {
        insert(
            RuleKind::Underride,
            &format!("moe.sable.shape.{family}.!room:example.org"),
            json!([
                {"kind":"event_match", "key":"room_id", "pattern":"!room:example.org"},
                {"kind":"event_match", "key":"type", "pattern":event_type}
            ]),
            json!(["notify"]),
        );
    }
    rules
}

#[test]
fn cleanup_removes_generated_rules_without_installing_or_reenabling_any() {
    let defaults = rtc_rules();
    let old = legacy_rules();
    let writes = plan_cleanup(&old, me());
    assert_eq!(writes.len(), 32);
    assert!(
        writes
            .iter()
            .all(|write| matches!(write, RuleWrite::Delete { .. }))
    );
    let cleaned = applied(old, writes);
    assert_eq!(
        serde_json::to_value(&cleaned).unwrap(),
        serde_json::to_value(defaults).unwrap()
    );
    assert!(plan_cleanup(&cleaned, me()).is_empty());
}

#[test]
fn cleanup_keeps_modified_rules_keywords_and_explicit_reaction_notifications() {
    let mut rules = legacy_rules();
    rules
        .set_actions(
            RuleKind::Underride,
            "moe.sable.sticker",
            level_actions(MentionNotificationModeView::Loud, true),
        )
        .unwrap();
    let mut bridge = rules
        .override_
        .get("moe.sable.suppress_bridge_status")
        .unwrap()
        .clone();
    rules
        .override_
        .shift_remove("moe.sable.suppress_bridge_status");
    bridge.conditions.clear();
    rules.override_.insert(bridge);
    let mut shape = rules
        .underride
        .get("moe.sable.shape.message.!room:example.org")
        .unwrap()
        .clone();
    rules
        .underride
        .shift_remove("moe.sable.shape.message.!room:example.org");
    shape.conditions.clear();
    rules.underride.insert(shape);
    let rules = applied(rules.clone(), plan_add_keyword(&rules, "sticker").unwrap());
    let rules = applied(
        rules.clone(),
        plan_event(&rules, EventNotificationView::Reactions, true, me()).unwrap(),
    );
    let writes = plan_cleanup(&rules, me());
    let cleaned = applied(rules.clone(), writes);
    for (kind, id) in [
        (RuleKind::Underride, "moe.sable.sticker"),
        (RuleKind::Override, "moe.sable.suppress_bridge_status"),
        (
            RuleKind::Underride,
            "moe.sable.shape.message.!room:example.org",
        ),
        (RuleKind::Override, "moe.sable.reaction_to_me"),
    ] {
        let before = rules.get(kind.clone(), id).unwrap();
        let after = cleaned.get(kind, id).unwrap();
        assert_eq!(
            serde_json::to_value(before.actions()).unwrap(),
            serde_json::to_value(after.actions()).unwrap()
        );
        assert_eq!(before.enabled(), after.enabled());
    }
    assert_eq!(keywords(&cleaned)[0].keyword, "sticker");
}

#[test]
fn a_new_rule_is_read_for_its_kind() {
    let rule = new_rule(
        &RuleKind::Override,
        json!({ "rule_id": "bots", "conditions": [], "actions": [] }),
    )
    .unwrap();
    assert!(matches!(rule, NewPushRule::Override(rule) if rule.rule_id == "bots"));

    let room = new_rule(
        &RuleKind::Room,
        json!({ "rule_id": "!room:example.org", "actions": ["notify"] }),
    )
    .unwrap();
    assert!(matches!(room, NewPushRule::Room(_)));

    new_rule(
        &RuleKind::Room,
        json!({ "rule_id": "not a room", "actions": [] }),
    )
    .unwrap_err();
    new_rule(&RuleKind::Content, json!({ "rule_id": "x", "actions": [] })).unwrap_err();
}
