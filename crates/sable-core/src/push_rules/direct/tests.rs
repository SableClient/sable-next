use matrix_sdk::ruma::push::{PushConditionRoomCtx, RuleKind};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{room_id, user_id};
use serde_json::json;

use super::*;
use crate::push_rules::{plan_room_mode, room_settings};

fn defaults(mode: NotificationModeView) -> DirectDefault {
    DirectDefault {
        mode,
        pending_one_to_one: false,
        managed: BTreeMap::new(),
    }
}

fn apply(rules: &mut Ruleset, writes: Vec<RuleWrite>) {
    for write in writes {
        write.apply_to(rules);
    }
}

fn reconcile(rules: &mut Ruleset, preference: &mut DirectDefault, rooms: &BTreeSet<OwnedRoomId>) {
    let (writes, _, next) = plan(rules, preference, rooms);
    apply(rules, writes);
    *preference = next;
}

async fn alerts(
    rules: &Ruleset,
    room: &RoomId,
    members: u8,
    event_type: &str,
    mentions: bool,
) -> bool {
    let context = PushConditionRoomCtx::new(
        room.to_owned(),
        members.into(),
        user_id!("@me:example.org").to_owned(),
        "Me".to_owned(),
    );
    let event = Raw::new(&json!({
        "type": event_type, "sender": "@other:example.org", "room_id": room,
        "content": { "body": "Hello", "m.mentions": {"user_ids": if mentions {vec!["@me:example.org"]} else {vec![]}} }
    })).unwrap();
    notifies(rules.get_actions(&event, &context).await)
}

#[tokio::test]
async fn dm_defaults_notify_for_messages_at_any_member_count_without_promoting_other_events() {
    let dm = room_id!("!bridge:example.org");
    let other = room_id!("!other:example.org");
    let mut rules = Ruleset::server_default(user_id!("@me:example.org"));
    apply(
        &mut rules,
        super::super::plan_default_mode(
            &Ruleset::server_default(user_id!("@me:example.org")),
            false,
            NotificationModeView::Mentions,
        )
        .unwrap(),
    );
    let mut preference = defaults(NotificationModeView::All);
    reconcile(
        &mut rules,
        &mut preference,
        &BTreeSet::from([dm.to_owned()]),
    );
    for members in [2, 3, 5] {
        for event_type in ["m.room.message", "m.room.encrypted", "m.sticker"] {
            assert!(
                alerts(&rules, dm, members, event_type, false).await,
                "{members} {event_type}"
            );
        }
    }
    for event_type in [
        "com.beeper.message_send_status",
        "m.room.topic",
        "m.rtc.member",
        "m.reaction",
    ] {
        assert!(
            !alerts(&rules, dm, 3, event_type, false).await,
            "{event_type}"
        );
    }
    assert!(!alerts(&rules, other, 3, "m.room.message", false).await);
    assert_eq!(
        room_settings(&rules, dm, false).default,
        NotificationModeView::All
    );
    assert!(room_settings(&rules, dm, false).room.is_none());
    assert!(super::super::plan_cleanup(&rules, user_id!("@me:example.org")).is_empty());
}

#[tokio::test]
async fn explicit_room_settings_and_mentions_take_precedence_over_dm_defaults() {
    let dm = room_id!("!dm:example.org");
    let rooms = BTreeSet::from([dm.to_owned()]);
    let mut rules = Ruleset::server_default(user_id!("@me:example.org"));
    let mut preference = defaults(NotificationModeView::All);
    reconcile(&mut rules, &mut preference, &rooms);
    for mode in [NotificationModeView::Mute, NotificationModeView::Mentions] {
        apply(&mut rules, plan_room_mode(dm, false, Some(mode)));
        reconcile(&mut rules, &mut preference, &rooms);
        assert!(!alerts(&rules, dm, 3, "m.room.message", false).await);
        assert_eq!(room_settings(&rules, dm, false).room, Some(mode));
    }
    apply(&mut rules, plan_room_mode(dm, false, None));
    assert!(alerts(&rules, dm, 3, "m.room.message", false).await);
    preference.mode = NotificationModeView::Mentions;
    reconcile(&mut rules, &mut preference, &rooms);
    assert!(!alerts(&rules, dm, 3, "m.room.message", false).await);
    assert!(alerts(&rules, dm, 3, "m.room.message", true).await);
    apply(
        &mut rules,
        plan_room_mode(dm, false, Some(NotificationModeView::All)),
    );
    assert!(alerts(&rules, dm, 3, "m.room.message", false).await);
    apply(&mut rules, plan_room_mode(dm, false, None));
    let keyword = super::super::plan_add_keyword(&rules, "Hello").unwrap();
    apply(&mut rules, keyword);
    assert!(alerts(&rules, dm, 3, "m.room.message", false).await);
}

#[test]
fn modified_and_disabled_rules_are_preserved_across_default_changes_and_dm_removal() {
    let dm = room_id!("!dm:example.org");
    let rooms = BTreeSet::from([dm.to_owned()]);
    let mut rules = Ruleset::server_default(user_id!("@me:example.org"));
    let mut preference = defaults(NotificationModeView::All);
    reconcile(&mut rules, &mut preference, &rooms);
    let message = rule_id("message", dm);
    let encrypted = rule_id("encrypted", dm);
    rules
        .set_actions(RuleKind::Underride, &message, vec![])
        .unwrap();
    rules
        .set_enabled(RuleKind::Underride, &encrypted, false)
        .unwrap();
    preference.mode = NotificationModeView::Mentions;
    reconcile(&mut rules, &mut preference, &rooms);
    preference.mode = NotificationModeView::All;
    reconcile(&mut rules, &mut preference, &rooms);
    assert!(
        rules
            .underride
            .get(message.as_str())
            .unwrap()
            .actions
            .is_empty()
    );
    assert!(!rules.underride.get(encrypted.as_str()).unwrap().enabled);
    reconcile(&mut rules, &mut preference, &BTreeSet::new());
    assert!(rules.underride.get(message.as_str()).is_some());
    assert!(rules.underride.get(encrypted.as_str()).is_some());
    assert!(
        rules
            .underride
            .get(rule_id("sticker", dm).as_str())
            .is_none()
    );
    assert!(preference.managed.is_empty());
}

#[test]
fn interrupted_rule_creation_and_mode_changes_can_be_retried() {
    let dm = room_id!("!dm:example.org");
    let rooms = BTreeSet::from([dm.to_owned()]);
    let mut rules = Ruleset::server_default(user_id!("@me:example.org"));
    let (writes, pending, _) = plan(&rules, &defaults(NotificationModeView::All), &rooms);
    apply(&mut rules, writes.into_iter().take(1).collect());
    let mut preference = pending;
    reconcile(&mut rules, &mut preference, &rooms);
    preference.mode = NotificationModeView::Mentions;
    let (writes, pending, _) = plan(&rules, &preference, &rooms);
    apply(&mut rules, writes.into_iter().take(1).collect());
    preference = pending;
    reconcile(&mut rules, &mut preference, &rooms);
    assert_eq!(
        inherited_mode(&rules, dm),
        Some(NotificationModeView::Mentions)
    );
    assert!(plan(&rules, &preference, &rooms).0.is_empty());
}

#[test]
fn changing_the_default_again_while_a_write_is_pending_keeps_ownership_of_both_modes() {
    let dm = room_id!("!dm:example.org");
    let rooms = BTreeSet::from([dm.to_owned()]);
    let mut rules = Ruleset::server_default(user_id!("@me:example.org"));
    let mut preference = defaults(NotificationModeView::All);
    reconcile(&mut rules, &mut preference, &rooms);
    preference.mode = NotificationModeView::Mentions;
    let (writes, mut pending, _) = plan(&rules, &preference, &rooms);
    apply(&mut rules, writes.into_iter().take(1).collect());
    pending.mode = NotificationModeView::All;
    let (_, mut pending, _) = plan(&rules, &pending, &rooms);
    reconcile(&mut rules, &mut pending, &rooms);
    assert_eq!(inherited_mode(&rules, dm), Some(NotificationModeView::All));
    assert!(pending.managed[dm].customized.is_empty());
}
