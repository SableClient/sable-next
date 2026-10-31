use matrix_sdk::ruma::push::{
    ConditionalPushRule, NewPushRule, PredefinedOverrideRuleId, PredefinedUnderrideRuleId,
    RuleKind, Ruleset,
};
use matrix_sdk::ruma::{RoomId, room_id, user_id};
use serde_json::json;

use super::alignment::{STICKER, STICKER_DIRECT, SUPPRESS_BRIDGE_STATUS, SUPPRESS_REACTIONS};
use super::{
    RuleWrite, default_modes, event_notifications, event_notifies, keywords, level_actions,
    master_muted, mention_notifications, plan_add_keyword, plan_alignment, plan_default_mode,
    plan_event, plan_keyword_mode, plan_master, plan_mention, plan_remove_keyword, plan_room_mode,
    plan_room_shapes, pushes_every_encrypted_event, room_mode, rule_notifies,
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
            RuleWrite::PutAfter { rule, after } => {
                format!("put {} after {after}", rule.rule_id())
            }
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
    let rules = Ruleset::server_default(me());

    assert_eq!(
        describe(&plan_room_mode(
            &rules,
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
        describe(&plan_room_mode(&rules, room, false, None)),
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
        rules.clone(),
        plan_room_mode(&rules, room, true, Some(NotificationModeView::All)),
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
        rules = applied(rules.clone(), plan_room_mode(&rules, room, false, mode));
        assert_eq!(room_mode(&rules, room), mode);
    }
}

#[test]
fn all_messages_in_a_room_rings_only_where_the_spec_default_does() {
    let room = room_id!("!r:example.org");
    let rules = Ruleset::server_default(me());

    assert_eq!(
        describe(&plan_room_mode(
            &rules,
            room,
            false,
            Some(NotificationModeView::All)
        ))[0],
        r#"put !r:example.org ["notify"]"#
    );
    assert_eq!(
        describe(&plan_room_mode(
            &rules,
            room,
            true,
            Some(NotificationModeView::All)
        ))[0],
        r#"put !r:example.org ["notify",{"set_tweak":"sound","value":"default"}]"#
    );
}

#[test]
fn a_mute_from_another_client_under_its_own_id_is_cleared() {
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

    let rules = applied(rules.clone(), plan_room_mode(&rules, room, false, None));

    assert_eq!(room_mode(&rules, room), None);
}

#[test]
fn a_disabled_room_rule_is_not_the_room_mode() {
    let room = room_id!("!r:example.org");
    let mut rules = Ruleset::server_default(me());
    rules = applied(
        rules.clone(),
        plan_room_mode(&rules, room, false, Some(NotificationModeView::All)),
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
fn a_default_left_notifying_for_encrypted_rooms_is_aligned() {
    let defaults = Ruleset::server_default(me());
    let mut rules = applied(defaults.clone(), plan_alignment(&defaults));
    assert!(plan_alignment(&rules).is_empty());

    rules
        .set_actions(
            RuleKind::Underride,
            PredefinedUnderrideRuleId::Message.as_str(),
            vec![],
        )
        .unwrap();
    rules
        .set_enabled(
            RuleKind::Underride,
            PredefinedUnderrideRuleId::EncryptedRoomOneToOne.as_str(),
            false,
        )
        .unwrap();

    assert_eq!(
        describe(&plan_alignment(&rules)),
        vec![
            r#"actions underride .m.rule.encrypted_room_one_to_one ["notify",{"set_tweak":"sound","value":"default"}]"#,
            "enabled underride .m.rule.encrypted_room_one_to_one true",
            "actions underride .m.rule.encrypted []",
            "enabled underride .m.rule.encrypted true",
            "actions underride moe.sable.sticker []",
            "enabled underride moe.sable.sticker true",
        ]
    );
    let aligned = applied(rules.clone(), plan_alignment(&rules));
    assert!(plan_alignment(&aligned).is_empty());
}

#[test]
fn stickers_notify_exactly_where_messages_do() {
    let defaults = Ruleset::server_default(me());
    let mut rules = applied(defaults.clone(), plan_alignment(&defaults));
    for mode in [NotificationModeView::Mentions, NotificationModeView::All] {
        for direct in [false, true] {
            rules = applied(
                rules.clone(),
                plan_default_mode(&rules, direct, mode).unwrap(),
            );
            let sticker = rules
                .get(
                    RuleKind::Underride,
                    if direct { STICKER_DIRECT } else { STICKER },
                )
                .unwrap();
            assert_eq!(rule_notifies(sticker), mode == NotificationModeView::All);
        }
    }
    assert!(plan_alignment(&rules).is_empty());
}

#[test]
fn a_direct_sticker_rule_ranks_above_the_group_one() {
    let defaults = Ruleset::server_default(me());
    let rules = applied(defaults.clone(), plan_alignment(&defaults));
    let position = |id: &str| rules.underride.iter().position(|rule| rule.rule_id == id);

    assert!(position(STICKER_DIRECT) < position(STICKER));
}

#[tokio::test]
async fn a_room_set_to_all_messages_ignores_room_changes_but_not_messages() {
    use matrix_sdk::ruma::push::PushConditionRoomCtx;
    use matrix_sdk::ruma::serde::Raw;

    let room = room_id!("!ann:example.org");
    let defaults = Ruleset::server_default(me());
    let mut rules = applied(defaults.clone(), plan_alignment(&defaults));
    rules = applied(
        rules.clone(),
        plan_room_mode(&rules, room, false, Some(NotificationModeView::All)),
    );
    let context = PushConditionRoomCtx::new(
        room.to_owned(),
        3_u8.into(),
        me().to_owned(),
        "me".to_owned(),
    );
    let notifies_for = async |event_type: &str, content: serde_json::Value| {
        let event = Raw::new(&json!({
            "type": event_type, "event_id": "$e", "sender": "@them:example.org",
            "origin_server_ts": 0, "content": content,
        }))
        .unwrap();
        super::notifies(rules.get_actions(&event, &context).await)
    };

    assert!(notifies_for("m.room.message", json!({"msgtype": "m.text", "body": "hi"})).await);
    for event_type in super::alignment::SUPPRESSED_ROOM_EVENTS {
        assert!(!notifies_for(event_type, json!({})).await, "{event_type}");
    }
    assert!(plan_alignment(&rules).is_empty());
}

async fn notifies_in(rules: &Ruleset, room: &RoomId, members: u8) -> bool {
    use matrix_sdk::ruma::push::PushConditionRoomCtx;
    use matrix_sdk::ruma::serde::Raw;

    let context = PushConditionRoomCtx::new(
        room.to_owned(),
        members.into(),
        me().to_owned(),
        "me".to_owned(),
    );
    let event = Raw::new(&json!({
        "type": "m.room.message", "event_id": "$e", "room_id": room,
        "sender": "@them:example.org", "origin_server_ts": 0,
        "content": {"msgtype": "m.text", "body": "hi"},
    }))
    .unwrap();
    super::notifies(rules.get_actions(&event, &context).await)
}

async fn rings_in(rules: &Ruleset, room: &RoomId, members: u8) -> bool {
    use matrix_sdk::ruma::power_levels::NotificationPowerLevels;
    use matrix_sdk::ruma::push::{PushConditionPowerLevelsCtx, PushConditionRoomCtx};
    use matrix_sdk::ruma::room_version_rules::{AuthorizationRules, RoomPowerLevelsRules};
    use matrix_sdk::ruma::serde::Raw;

    let context = PushConditionRoomCtx::new(
        room.to_owned(),
        members.into(),
        me().to_owned(),
        "me".to_owned(),
    )
    .with_power_levels(PushConditionPowerLevelsCtx::new(
        std::collections::BTreeMap::new(),
        0.into(),
        NotificationPowerLevels::new(),
        RoomPowerLevelsRules::new(&AuthorizationRules::V1, None),
    ));
    let event = Raw::new(&json!({
        "type": crate::calls::NOTIFICATION_EVENT_TYPE, "event_id": "$e", "room_id": room,
        "sender": "@them:example.org", "origin_server_ts": 0,
        "content": {"notification_type": "ring", "m.mentions": {"user_ids": [me()]}, "sender_ts": 0, "lifetime": 30000},
    }))
    .unwrap();
    super::notifies(rules.get_actions(&event, &context).await)
}

fn aligned() -> Ruleset {
    let defaults = Ruleset::server_default(me());
    applied(defaults.clone(), plan_alignment(&defaults))
}

#[tokio::test]
async fn a_named_invitation_does_not_depend_on_room_size() {
    let room = room_id!("!call:example.org");
    let rules = aligned();
    assert!(rings_in(&rules, room, 2).await);
    assert!(rings_in(&rules, room, 5).await);
    assert!(plan_alignment(&rules).is_empty());
}

#[tokio::test]
async fn a_one_to_one_ring_follows_the_room_and_calls_settings() {
    let room = room_id!("!call:example.org");
    let rules = aligned();

    let mentions = applied(
        rules.clone(),
        plan_room_mode(&rules, room, true, Some(NotificationModeView::Mentions)),
    );
    assert!(rings_in(&mentions, room, 2).await);

    let muted = applied(
        rules.clone(),
        plan_room_mode(&rules, room, true, Some(NotificationModeView::Mute)),
    );
    assert!(!rings_in(&muted, room, 2).await);

    let off = applied(
        rules.clone(),
        plan_event(&rules, EventNotificationView::Calls, false).unwrap(),
    );
    assert!(!rings_in(&off, room, 2).await);
    assert!(plan_alignment(&off).is_empty());
}

#[tokio::test]
async fn a_room_muted_before_the_ring_rule_existed_stays_muted() {
    let room = room_id!("!call:example.org");
    let defaults = Ruleset::server_default(me());
    let muted = applied(
        defaults.clone(),
        plan_room_mode(&defaults, room, true, Some(NotificationModeView::Mute)),
    );

    let rules = applied(muted.clone(), plan_alignment(&muted));
    assert!(!rings_in(&rules, room, 2).await);
    assert!(rings_in(&rules, room_id!("!other:example.org"), 2).await);
}

fn mentions_for_direct_only() -> Ruleset {
    let defaults = Ruleset::server_default(me());
    let rules = applied(defaults.clone(), plan_alignment(&defaults));
    applied(
        rules.clone(),
        plan_default_mode(&rules, true, NotificationModeView::Mentions).unwrap(),
    )
}

#[tokio::test]
async fn a_flagged_room_with_three_members_follows_the_direct_default() {
    let room = room_id!("!bridged:example.org");
    let rules = mentions_for_direct_only();
    assert!(notifies_in(&rules, room, 3).await);

    let shaped = applied(
        rules.clone(),
        plan_room_shapes(&rules, &[(room.to_owned(), true)]),
    );

    assert!(!notifies_in(&shaped, room, 3).await);
    assert!(notifies_in(&shaped, room_id!("!other:example.org"), 3).await);
    assert!(plan_room_shapes(&shaped, &[(room.to_owned(), true)]).is_empty());
}

#[tokio::test]
async fn an_unflagged_pair_follows_the_group_default() {
    let room = room_id!("!pair:example.org");
    let rules = mentions_for_direct_only();
    assert!(!notifies_in(&rules, room, 2).await);

    let shaped = applied(
        rules.clone(),
        plan_room_shapes(&rules, &[(room.to_owned(), false)]),
    );

    assert!(notifies_in(&shaped, room, 2).await);
}

#[tokio::test]
async fn room_copies_follow_the_default_and_go_with_the_room() {
    let room = room_id!("!bridged:example.org");
    let rules = mentions_for_direct_only();
    let shaped = applied(
        rules.clone(),
        plan_room_shapes(&rules, &[(room.to_owned(), true)]),
    );

    let louder = applied(
        shaped.clone(),
        plan_default_mode(&shaped, true, NotificationModeView::All).unwrap(),
    );
    let followed = applied(
        louder.clone(),
        plan_room_shapes(&louder, &[(room.to_owned(), true)]),
    );
    assert!(notifies_in(&followed, room, 3).await);

    let gone = applied(followed.clone(), plan_room_shapes(&followed, &[]));
    assert!(
        gone.underride
            .iter()
            .all(|rule| !rule.rule_id.starts_with(super::alignment::SHAPE_PREFIX))
    );
}

#[tokio::test]
async fn a_room_mode_survives_and_keeps_the_room_copies() {
    let room = room_id!("!bridged:example.org");
    let rules = mentions_for_direct_only();
    let shaped = applied(
        rules.clone(),
        plan_room_shapes(&rules, &[(room.to_owned(), true)]),
    );

    let chosen = applied(
        shaped.clone(),
        plan_room_mode(&shaped, room, true, Some(NotificationModeView::All)),
    );

    assert!(notifies_in(&chosen, room, 3).await);
    assert!(plan_room_shapes(&chosen, &[(room.to_owned(), true)]).is_empty());
}

#[test]
fn bridge_status_rule_is_enabled_without_rewriting() {
    let defaults = Ruleset::server_default(me());
    let mut rules = applied(defaults.clone(), plan_alignment(&defaults));
    assert!(plan_alignment(&rules).is_empty());

    rules
        .set_enabled(RuleKind::Override, SUPPRESS_BRIDGE_STATUS, false)
        .unwrap();
    let aligned = applied(rules.clone(), plan_alignment(&rules));
    assert!(
        aligned
            .get(RuleKind::Override, SUPPRESS_BRIDGE_STATUS)
            .unwrap()
            .enabled()
    );
    assert!(plan_alignment(&aligned).is_empty());
}

#[test]
fn reactions_are_silenced_only_when_the_account_lacks_the_default_rule() {
    let defaults = Ruleset::server_default(me());
    let kept = applied(defaults.clone(), plan_alignment(&defaults));
    assert!(kept.get(RuleKind::Override, SUPPRESS_REACTIONS).is_none());

    let mut old = defaults;
    old.override_
        .retain(|rule| rule.rule_id != PredefinedOverrideRuleId::Reaction.as_str());
    let aligned = applied(old.clone(), plan_alignment(&old));
    assert!(
        aligned
            .get(RuleKind::Override, SUPPRESS_REACTIONS)
            .is_some()
    );
    assert!(plan_alignment(&aligned).is_empty());
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
            plan_event(&defaults, event, true).unwrap(),
        );
        assert_eq!(event_notifies(&on, event), Some(true));
        let off = applied(on.clone(), plan_event(&on, event, false).unwrap());
        assert_eq!(event_notifies(&off, event), Some(false));
    }
}

#[test]
fn turning_an_event_back_on_restores_the_spec_actions() {
    let defaults = Ruleset::server_default(me());
    let off = applied(
        defaults.clone(),
        plan_event(&defaults, EventNotificationView::Calls, false).unwrap(),
    );
    let on = applied(
        off.clone(),
        plan_event(&off, EventNotificationView::Calls, true).unwrap(),
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
fn a_reaction_toggle_falls_back_to_the_rule_alignment_added() {
    let mut rules = Ruleset::server_default(me());
    rules
        .override_
        .retain(|rule| rule.rule_id != PredefinedOverrideRuleId::Reaction.as_str());
    assert_eq!(event_notifications(&rules).reactions, None);

    let aligned = applied(rules.clone(), plan_alignment(&rules));
    assert_eq!(event_notifications(&aligned).reactions, Some(false));
    let on = applied(
        aligned.clone(),
        plan_event(&aligned, EventNotificationView::Reactions, true).unwrap(),
    );
    assert_eq!(event_notifications(&on).reactions, Some(true));
    assert!(plan_alignment(&on).is_empty());
}

#[test]
fn a_missing_event_rule_has_no_state_and_no_plan() {
    let mut rules = Ruleset::server_default(me());
    rules.override_.clear();
    assert_eq!(event_notifications(&rules).membership, None);
    plan_event(&rules, EventNotificationView::Membership, true).unwrap_err();
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

#[tokio::test]
async fn call_announcements_notify_without_becoming_mentions() {
    let rules = aligned();
    for (event_type, _, _) in super::alignment::RTC_INVITE_TYPES {
        let actions = invite_actions(&rules, event_type, json!({"room": true}), 100).await;
        assert!(super::notifies(&actions), "{event_type}");
        assert!(
            !actions.iter().any(super::Action::is_highlight),
            "{event_type}"
        );
        assert_eq!(
            serde_json::to_value(actions.iter().find_map(super::Action::sound)).unwrap(),
            json!("ring")
        );
        assert!(!super::notifies(
            &invite_actions(&rules, event_type, json!({"room": true}), 0).await
        ));
    }
    let mention = invite_actions(&rules, "m.room.message", json!({"room": true}), 100).await;
    assert!(mention.iter().any(super::Action::is_highlight));
}

#[tokio::test]
async fn invitations_target_users_without_room_notification_permission() {
    let rules = aligned();
    for (event_type, _, _) in super::alignment::RTC_INVITE_TYPES {
        let actions = invite_actions(&rules, event_type, json!({"user_ids": [me()]}), 0).await;
        assert!(super::notifies(&actions), "{event_type}");
        assert!(!actions.iter().any(super::Action::is_highlight));
        assert!(!super::notifies(
            &invite_actions(
                &rules,
                event_type,
                json!({"user_ids": ["@someone:example.org"]}),
                0,
            )
            .await
        ));
        assert!(!super::notifies(
            &invite_actions(&rules, event_type, json!({}), 100).await
        ));
    }
}

#[tokio::test]
async fn invitation_rules_respect_mentions_only_mute_and_call_settings() {
    let rules = aligned();
    let room = room_id!("!call:example.org");
    let mentions = applied(
        rules.clone(),
        plan_room_mode(&rules, room, false, Some(NotificationModeView::Mentions)),
    );
    let muted = applied(
        rules.clone(),
        plan_room_mode(&rules, room, false, Some(NotificationModeView::Mute)),
    );
    let off = applied(
        rules.clone(),
        plan_event(&rules, EventNotificationView::Calls, false).unwrap(),
    );
    for (event_type, _, _) in super::alignment::RTC_INVITE_TYPES {
        for target in [json!({"room": true}), json!({"user_ids": [me()]})] {
            assert!(super::notifies(
                &invite_actions(&mentions, event_type, target.clone(), 100).await
            ));
            assert!(!super::notifies(
                &invite_actions(&muted, event_type, target.clone(), 100).await
            ));
            assert!(!super::notifies(
                &invite_actions(&off, event_type, target, 100).await
            ));
        }
    }
    assert!(plan_alignment(&off).is_empty());
}

#[test]
fn invitation_alignment_preserves_server_rules_and_other_overrides() {
    let mut rules = Ruleset::server_default(me());
    let server: ConditionalPushRule = serde_json::from_value(json!({
        "rule_id": ".m.rule.rtc.invite_for_me", "default": true, "enabled": true,
        "conditions": [
            {"kind": "event_property_is", "key": "type", "value": "m.rtc.invite"},
            {"kind": "event_property_contains", "key": "content.m\\.mentions.user_ids", "value": me()}
        ], "actions": []
    })).unwrap();
    let server_json = serde_json::to_value(&server).unwrap();
    let mention_index = rules
        .override_
        .get_index_of(".m.rule.is_user_mention")
        .unwrap();
    rules.override_.insert(server);
    rules
        .override_
        .move_index(rules.override_.len() - 1, mention_index);
    let custom: ConditionalPushRule = serde_json::from_value(json!({
        "rule_id": "another-client-custom-rule", "default": false, "enabled": false,
        "conditions": [], "actions": ["notify", {"set_tweak": "highlight"}]
    }))
    .unwrap();
    let custom_json = serde_json::to_value(&custom).unwrap();
    rules.override_.insert(custom);
    rules.override_.move_index(rules.override_.len() - 1, 1);
    let aligned = applied(rules.clone(), plan_alignment(&rules));
    assert_eq!(
        serde_json::to_value(aligned.override_.get(".m.rule.rtc.invite_for_me").unwrap()).unwrap(),
        server_json
    );
    assert_eq!(
        serde_json::to_value(aligned.override_.get("another-client-custom-rule").unwrap()).unwrap(),
        custom_json
    );
    assert!(
        aligned
            .override_
            .get("moe.sable.rtc.invite_for_me")
            .unwrap()
            .actions
            .is_empty()
    );
    assert!(
        aligned
            .override_
            .get("moe.sable.rtc.invite_for_me.unstable")
            .unwrap()
            .actions
            .is_empty()
    );
    assert!(plan_alignment(&aligned).is_empty());
}

#[test]
fn invitation_alignment_removes_the_old_room_size_bypass() {
    let mut rules = Ruleset::server_default(me());
    rules
        .insert(
            NewPushRule::Override(super::NewConditionalPushRule::new(
                super::alignment::RING_ONE_TO_ONE.to_owned(),
                vec![],
                vec![super::Action::Notify],
            )),
            None,
            None,
        )
        .unwrap();
    let rules = applied(rules.clone(), plan_alignment(&rules));
    assert!(
        rules
            .override_
            .get(super::alignment::RING_ONE_TO_ONE)
            .is_none()
    );
    assert!(plan_alignment(&rules).is_empty());
}

#[tokio::test]
async fn broad_room_rules_do_not_notify_for_withdrawals_or_invalid_targets() {
    let rules = aligned();
    let rules = applied(
        rules.clone(),
        plan_room_mode(
            &rules,
            room_id!("!call:example.org"),
            false,
            Some(NotificationModeView::All),
        ),
    );
    for (event_type, _, _) in super::alignment::RTC_INVITE_TYPES {
        for (mentions, power) in [
            (json!({}), 100),
            (json!({"room": true}), 0),
            (json!({"user_ids": ["@other:example.org"]}), 100),
        ] {
            assert!(
                !super::notifies(&invite_actions(&rules, event_type, mentions, power).await),
                "{event_type}"
            );
        }
        assert!(super::notifies(
            &invite_actions(&rules, event_type, json!({"room": true}), 100).await
        ));
        assert!(super::notifies(
            &invite_actions(&rules, event_type, json!({"user_ids": [me()]}), 0).await
        ));
    }
    for event_type in ["m.rtc.decline", "org.matrix.msc4310.rtc.decline"] {
        assert!(!super::notifies(
            &invite_actions(&rules, event_type, json!({}), 100).await
        ));
    }
}

#[tokio::test]
async fn server_invitation_settings_are_mirrored_without_reenabling_disabled_rules() {
    let mut rules = Ruleset::server_default(me());
    for (id, enabled, target) in [
        (
            ".m.rule.rtc.invite_for_me",
            false,
            json!([
                {"kind": "event_property_contains", "key": "content.m\\.mentions.user_ids", "value": me()}
            ]),
        ),
        (
            ".m.rule.rtc.invite_for_room",
            true,
            json!([
                {"kind": "event_property_is", "key": "content.m\\.mentions.room", "value": true},
                {"kind": "sender_notification_permission", "key": "room"}
            ]),
        ),
    ] {
        let mut conditions =
            vec![json!({"kind": "event_property_is", "key": "type", "value": "m.rtc.invite"})];
        conditions.extend(target.as_array().unwrap().clone());
        let rule: ConditionalPushRule = serde_json::from_value(json!({
            "rule_id": id, "default": true, "enabled": enabled, "conditions": conditions,
            "actions": ["notify", {"set_tweak": "sound", "value": "ring"}]
        }))
        .unwrap();
        let index = rules
            .override_
            .get_index_of(".m.rule.is_user_mention")
            .unwrap();
        rules.override_.insert(rule);
        rules.override_.move_index(rules.override_.len() - 1, index);
    }
    let rules = applied(rules.clone(), plan_alignment(&rules));
    assert!(
        !rules
            .override_
            .get(".m.rule.rtc.invite_for_me")
            .unwrap()
            .enabled
    );
    for (event_type, _, _) in super::alignment::RTC_INVITE_TYPES {
        assert!(!super::notifies(
            &invite_actions(&rules, event_type, json!({"user_ids": [me()]}), 0).await
        ));
        let actions = invite_actions(&rules, event_type, json!({"room": true}), 100).await;
        assert!(super::notifies(&actions));
        assert!(!actions.iter().any(super::Action::is_highlight));
    }
    let mut changed = rules;
    changed
        .set_actions(RuleKind::Override, ".m.rule.rtc.invite_for_room", vec![])
        .unwrap();
    let changed = applied(changed.clone(), plan_alignment(&changed));
    for (event_type, _, _) in super::alignment::RTC_INVITE_TYPES {
        assert!(!super::notifies(
            &invite_actions(&changed, event_type, json!({"room": true}), 100).await
        ));
    }
    assert!(plan_alignment(&changed).is_empty());
}

#[test]
fn calls_can_be_configured_without_the_legacy_call_rule() {
    let mut rules = aligned();
    rules
        .underride
        .shift_remove(PredefinedUnderrideRuleId::Call.as_str());
    let rules = applied(
        rules.clone(),
        plan_event(&rules, EventNotificationView::Calls, false).unwrap(),
    );
    for rule in rules
        .override_
        .iter()
        .filter(|rule| super::alignment::is_rtc_rule(&rule.rule_id))
    {
        assert!(rule.actions.is_empty());
    }
    assert!(plan_alignment(&rules).is_empty());
}
