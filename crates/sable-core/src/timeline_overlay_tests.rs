use std::collections::BTreeMap;

use matrix_sdk::ruma::{EventId, event_id, user_id};
use serde_json::json;

use super::*;
use crate::protocol::{
    MembershipChangeView, MentionView, MessageShieldView, ReplyView, TimelineItemContentView,
};

fn item(id: &str, sender: &str, reply: Option<ReplyView>) -> TimelineItemView {
    let content = TimelineItemContentView::Message {
        body: id.to_owned(),
        html: id.to_owned(),
        msgtype: crate::protocol::MessageKind::Text,
        edited: false,
        jumbo: None,
    };
    TimelineItemView {
        id: id.to_owned(),
        row: content.row_kind(),
        forwardable: content.forwardable(),
        redactable: content.redactable(),
        visibility: content.visibility(),
        event_id: OwnedEventId::try_from(format!("${id}")).ok(),
        transaction_id: None,
        send_state: None,
        sender: OwnedUserId::try_from(sender).ok(),
        sender_name: Some("Old".to_owned()),
        sender_avatar: None,
        timestamp: 0,
        content,
        in_reply_to: reply,
        thread_root: None,
        thread_summary: None,
        reactions: Vec::new(),
        is_own: false,
        read_by: Vec::new(),
        read_timestamps: BTreeMap::new(),
        per_message_profile: None,
        bundled_link_previews: Vec::new(),
        link_previews_removed: None,
        mention: MentionView::None,
        forwarded: None,
        forum_title: None,
        shield: None,
        shared_by: None,
        redacted_on_ban: None,
    }
}

fn reply_to(event_id: &EventId, sender: Option<&str>, body: Option<&str>) -> ReplyView {
    ReplyView {
        event_id: event_id.to_owned(),
        sender: sender.and_then(|sender| OwnedUserId::try_from(sender).ok()),
        sender_mentioned: false,
        sender_name: Some("Old".to_owned()),
        body: body.map(ToOwned::to_owned),
        fallback: None,
        emotes: Vec::new(),
    }
}

fn read(source: &Value) -> ReplyFallback {
    ReplyFallback::from_source(source).expect("a stand-in")
}

fn shielded(id: &str, code: MessageShieldCode) -> TimelineItemView {
    TimelineItemView {
        shield: Some(MessageShieldView {
            code,
            critical: true,
        }),
        ..item(id, "@ghost:x", None)
    }
}

#[test]
fn a_bridged_room_drops_only_mismatched_sender_shields() {
    let mut overlay = TimelineOverlay::default();
    overlay.reset(vec![
        shielded("a", MessageShieldCode::MismatchedSender),
        shielded("b", MessageShieldCode::UnknownDevice),
    ]);

    let diffs = overlay.set_bridged();

    assert!(matches!(
        diffs.as_slice(),
        [VectorDiff::Set { index: 0, .. }]
    ));
    assert_eq!(overlay.items[0].shield, None);
    assert!(overlay.items[1].shield.is_some());
    let [VectorDiff::PushBack { value }] = &overlay.apply(VectorDiff::PushBack {
        value: shielded("c", MessageShieldCode::MismatchedSender),
    })[..] else {
        unreachable!()
    };
    assert_eq!(value.shield, None);
}

#[test]
fn a_rename_relabels_loaded_rows_and_later_arrivals() {
    let mut overlay = TimelineOverlay::default();
    overlay.reset(vec![
        item("a", "@alice:x", None),
        item(
            "b",
            "@bob:x",
            Some(reply_to(event_id!("$a"), Some("@alice:x"), Some("a"))),
        ),
        item("c", "@carol:x", None),
    ]);
    let alicia = || (Some("Alicia".to_owned()), Some("mxc://x/a".to_owned()));

    let (name, avatar) = alicia();
    let diffs = overlay.set_profile(user_id!("@alice:x").to_owned(), name, avatar);

    let indices: Vec<Option<usize>> = diffs
        .iter()
        .map(|diff| match diff {
            VectorDiff::Set { index, .. } => Some(*index),
            _ => None,
        })
        .collect();
    assert_eq!(indices, [Some(0), Some(1)]);
    assert_eq!(overlay.items[0].sender_avatar.as_deref(), Some("mxc://x/a"));
    assert_eq!(overlay.items[1].sender_name.as_deref(), Some("Old"));
    assert_eq!(
        overlay.items[1]
            .in_reply_to
            .as_ref()
            .and_then(|reply| reply.sender_name.as_deref()),
        Some("Alicia")
    );
    let (name, avatar) = alicia();
    assert!(
        overlay
            .set_profile(user_id!("@alice:x").to_owned(), name, avatar)
            .is_empty()
    );

    let [VectorDiff::PushBack { value }] = &overlay.apply(VectorDiff::PushBack {
        value: item("d", "@alice:x", None),
    })[..] else {
        panic!("a push back");
    };
    assert_eq!(value.sender_name.as_deref(), Some("Alicia"));
    assert_eq!(overlay.items.len(), 4);
}

fn bobby() -> Nicknames {
    Nicknames::from_overrides(
        vec![crate::protocol::ProfileOverrideView {
            user_id: user_id!("@bob:x").to_owned(),
            display_name: crate::protocol::OverrideTextView::Set {
                value: "Bobby".to_owned(),
            },
            avatar: crate::protocol::OverrideTextView::Unset,
            color: crate::protocol::OverrideColorView::Unset,
        }],
        None,
    )
}

#[test]
fn a_nickname_covers_senders_and_replies_and_lifts_when_removed() {
    let mut overlay = TimelineOverlay::new(bobby());
    let items = overlay.reset(vec![
        item("a", "@bob:x", None),
        item(
            "b",
            "@carol:x",
            Some(reply_to(event_id!("$a"), Some("@bob:x"), Some("a"))),
        ),
    ]);
    assert_eq!(items[0].sender_name.as_deref(), Some("Bobby"));
    assert_eq!(
        items[1]
            .in_reply_to
            .as_ref()
            .and_then(|reply| reply.sender_name.as_deref()),
        Some("Bobby")
    );
    assert_eq!(items[1].sender_name.as_deref(), Some("Old"));

    let diffs = overlay.set_nicknames(Nicknames::default(), &[user_id!("@bob:x").to_owned()]);

    assert_eq!(diffs.len(), 2);
    assert_eq!(overlay.items[0].sender_name.as_deref(), Some("Old"));
    assert_eq!(
        overlay.items[1]
            .in_reply_to
            .as_ref()
            .and_then(|reply| reply.sender_name.as_deref()),
        Some("Old")
    );
}

#[test]
fn real_names_are_forgotten_with_the_rows_that_leave() {
    let mut overlay = TimelineOverlay::new(bobby());
    overlay.reset(vec![item("a", "@bob:x", None), item("b", "@bob:x", None)]);

    overlay.apply(VectorDiff::PopFront);
    assert_eq!(overlay.real_names.len(), 1);
    overlay.apply(VectorDiff::Clear);
    assert!(overlay.real_names.is_empty());
}

#[test]
fn a_nickname_survives_a_profile_change_underneath() {
    let mut overlay = TimelineOverlay::new(bobby());
    overlay.reset(vec![item("a", "@bob:x", None)]);

    overlay.set_profile(
        user_id!("@bob:x").to_owned(),
        Some("Robert".to_owned()),
        None,
    );
    assert_eq!(overlay.items[0].sender_name.as_deref(), Some("Bobby"));

    overlay.set_nicknames(Nicknames::default(), &[user_id!("@bob:x").to_owned()]);
    assert_eq!(overlay.items[0].sender_name.as_deref(), Some("Robert"));
}

#[test]
fn a_reply_stand_in_fills_the_preview_now_and_on_later_diffs() {
    let mut overlay = TimelineOverlay::default();
    let reply = item(
        "r",
        "@bob:x",
        Some(reply_to(event_id!("$gone"), None, None)),
    );
    overlay.reset(vec![item("a", "@alice:x", None), reply.clone()]);

    let stand_in = read(&json!({
        "type": "m.reaction",
        "sender": "@ana:x",
        "content": {"m.relates_to": {"rel_type": "m.annotation", "event_id": "$x", "key": "👍"}}
    }));
    assert_eq!(
        overlay
            .set_reply(event_id!("$gone").to_owned(), stand_in)
            .len(),
        1
    );

    let [VectorDiff::Set { value, .. }] = &overlay.apply(VectorDiff::Set {
        index: 1,
        value: reply,
    })[..] else {
        panic!("a set");
    };
    let shown = value.in_reply_to.as_ref().expect("a reply");
    assert_eq!(shown.sender, Some(user_id!("@ana:x").to_owned()));
    assert_eq!(shown.body, None);
    assert_eq!(
        shown.fallback,
        Some(ReplyFallbackView::Reaction {
            key: "👍".to_owned()
        })
    );
}

#[test]
fn an_encrypted_stand_in_is_replaced_once_its_key_arrives() {
    let mut overlay = TimelineOverlay::default();
    let reply = item(
        "r",
        "@bob:x",
        Some(reply_to(event_id!("$secret"), None, None)),
    );
    overlay.reset(vec![reply]);

    let encrypted = read(&json!({
        "type": "m.room.encrypted",
        "sender": "@ana:x",
        "content": {"algorithm": "m.megolm.v1.aes-sha2", "session_id": "s1", "ciphertext": "x"}
    }));
    overlay.set_reply(event_id!("$secret").to_owned(), encrypted);
    assert_eq!(
        overlay.encrypted_replies(|session| session == "s1"),
        vec![event_id!("$secret").to_owned()]
    );
    assert_eq!(
        overlay.encrypted_replies(|session| session == "s2"),
        Vec::<OwnedEventId>::new()
    );

    let decrypted = read(&json!({
        "type": "m.room.message",
        "sender": "@ana:x",
        "content": {"msgtype": "m.text", "body": "hello"}
    }));
    let diffs = overlay.set_reply(event_id!("$secret").to_owned(), decrypted);
    let [VectorDiff::Set { value, .. }] = diffs.as_slice() else {
        panic!("one set");
    };
    let shown = value.in_reply_to.as_ref().expect("a reply");
    assert_eq!(shown.body.as_deref(), Some("hello"));
    assert_eq!(shown.fallback, None);
    assert_eq!(
        overlay.encrypted_replies(|_| true),
        Vec::<OwnedEventId>::new()
    );
}

#[test]
fn a_redaction_reason_fills_the_deleted_row_now_and_on_later_diffs() {
    let mut overlay = TimelineOverlay::default();
    let deleted = |id: &str| {
        let mut row = item(id, "@alice:x", None);
        row.content = TimelineItemContentView::Redacted {
            reason: None,
            redacted_by: None,
        };
        row
    };
    overlay.reset(vec![item("a", "@alice:x", None), deleted("b")]);

    let diffs = overlay.set_redaction_reason(event_id!("$b").to_owned(), "spam".to_owned());
    assert_eq!(diffs.len(), 1);
    assert_eq!(redaction_reason(&overlay.items[1]), Some("spam"));
    assert!(
        overlay
            .set_redaction_reason(event_id!("$b").to_owned(), "spam".to_owned())
            .is_empty()
    );

    let [VectorDiff::Set { value, .. }] = &overlay.apply(VectorDiff::Set {
        index: 1,
        value: deleted("b"),
    })[..] else {
        panic!("a set");
    };
    assert_eq!(redaction_reason(value), Some("spam"));
}

#[test]
fn a_reason_never_replaces_one_the_sdk_already_knows() {
    let mut overlay = TimelineOverlay::default();
    let mut row = item("b", "@alice:x", None);
    row.content = TimelineItemContentView::Redacted {
        reason: Some("rude".to_owned()),
        redacted_by: None,
    };
    overlay.reset(vec![row]);

    assert!(
        overlay
            .set_redaction_reason(event_id!("$b").to_owned(), "spam".to_owned())
            .is_empty()
    );
    assert_eq!(redaction_reason(&overlay.items[0]), Some("rude"));
}

fn levels(levels: Value) -> RoomPowerLevels {
    use matrix_sdk::ruma::events::room::power_levels::RoomPowerLevelsEventContent;
    use matrix_sdk::ruma::room_version_rules::AuthorizationRules;

    let content: RoomPowerLevelsEventContent = serde_json::from_value(levels).unwrap();
    RoomPowerLevels::new(content.into(), &AuthorizationRules::V1, [])
}

fn membership(content: Value) -> RoomMemberEventContent {
    serde_json::from_value(content).unwrap()
}

#[test]
fn only_a_kick_or_ban_with_redact_events_by_a_moderator_hides_messages() {
    let pl = levels(json!({"users": {"@mod:x": 50, "@user:x": 0}}));
    let (moderator, spammer) = (user_id!("@mod:x"), user_id!("@spam:x"));
    let ban =
        json!({"membership": "ban", "reason": "spam", "org.matrix.msc4293.redact_events": true});
    let kick = json!({"membership": "leave", "org.matrix.msc4293.redact_events": true});

    assert_eq!(
        BanRedaction::from_membership(moderator, spammer, &membership(ban.clone()), &pl, 0),
        Some(BanRedaction {
            by: moderator.to_owned(),
            reason: Some("spam".to_owned()),
            at: 0,
        })
    );
    assert!(
        BanRedaction::from_membership(moderator, spammer, &membership(kick.clone()), &pl, 0)
            .is_some()
    );
    assert!(BanRedaction::from_membership(spammer, spammer, &membership(kick), &pl, 0).is_none());
    assert!(
        BanRedaction::from_membership(
            user_id!("@user:x"),
            spammer,
            &membership(ban.clone()),
            &pl,
            0
        )
        .is_none()
    );
    assert!(
        BanRedaction::from_membership(
            moderator,
            spammer,
            &membership(json!({"membership": "ban"})),
            &pl,
            0
        )
        .is_none()
    );
    let redaction_locked =
        levels(json!({"users": {"@mod:x": 50}, "events": {"m.room.redaction": 100}}));
    assert!(
        BanRedaction::from_membership(moderator, spammer, &membership(ban), &redaction_locked, 0)
            .is_none()
    );
}

const MOD: &str = "@mod:x";
const SPAM: &str = "@spam:x";

fn member_row(
    id: &str,
    sender: &str,
    user: &str,
    change: MembershipChangeView,
    removes_events: bool,
) -> TimelineItemView {
    let content = TimelineItemContentView::Membership {
        user_id: OwnedUserId::try_from(user).unwrap(),
        change,
        display_name: None,
        reason: Some("spam".to_owned()),
        removes_events,
    };
    TimelineItemView {
        row: content.row_kind(),
        visibility: content.visibility(),
        content,
        ..item(id, sender, None)
    }
}

fn ban_row(id: &str) -> TimelineItemView {
    member_row(id, MOD, SPAM, MembershipChangeView::Banned, true)
}

fn at(timestamp: u64, item: TimelineItemView) -> TimelineItemView {
    TimelineItemView { timestamp, ..item }
}

/// An overlay of a room where `@mod:x` may redact other people's events.
fn moderated() -> TimelineOverlay {
    let mut overlay = TimelineOverlay::default();
    overlay.seed_ban_redactions(HashMap::new(), Some(levels(json!({"users": {MOD: 50}}))));
    overlay
}

fn removed(overlay: &TimelineOverlay) -> Vec<&str> {
    overlay
        .items
        .iter()
        .filter(|item| item.redacted_on_ban == Some(true))
        .map(|item| item.id.as_str())
        .collect()
}

/// MSC4293's own example: the removal stops at the member event before the ban.
fn rejoined_then_banned() -> Vec<TimelineItemView> {
    vec![
        item("a", SPAM, None),
        item("b", SPAM, None),
        member_row("left", SPAM, SPAM, MembershipChangeView::Left, false),
        member_row("joined", SPAM, SPAM, MembershipChangeView::Joined, false),
        item("d", SPAM, None),
        item("other", "@ok:x", None),
        item("e", SPAM, None),
        ban_row("banned"),
    ]
}

#[test]
fn a_ban_removes_only_what_was_sent_since_the_previous_member_event() {
    let mut overlay = moderated();
    let spam = TimelineItemView {
        reactions: vec![crate::protocol::ReactionGroup {
            key: "👍".to_owned(),
            senders: Vec::new(),
        }],
        ..item("d", SPAM, None)
    };
    let mut items = rejoined_then_banned();
    items[4] = spam;

    let sent = overlay.reset(items);

    assert_eq!(removed(&overlay), ["d", "e"]);
    let hidden = &sent[4];
    assert!(hidden.reactions.is_empty());
    assert!(!hidden.redactable);
    assert!(matches!(
        &hidden.content,
        TimelineItemContentView::Redacted { reason: Some(reason), redacted_by: Some(by) }
            if reason == "spam" && by == MOD
    ));
    assert!(matches!(
        overlay.hidden_content(&OwnedEventId::try_from("$d").unwrap()),
        Some(TimelineItemContentView::Message { body, .. }) if body == "d"
    ));
}

#[test]
fn an_unban_or_a_rejoin_leaves_removed_events_removed() {
    let mut overlay = moderated();
    overlay.reset(rejoined_then_banned());

    for row in [
        member_row("unbanned", MOD, SPAM, MembershipChangeView::Unbanned, false),
        member_row("back", SPAM, SPAM, MembershipChangeView::Joined, false),
        item("f", SPAM, None),
    ] {
        let diffs = overlay.apply(VectorDiff::PushBack { value: row });
        assert_eq!(diffs.len(), 1, "nothing already shown changes");
    }
    overlay.set_ban_redaction(user_id!("@spam:x"), None, None);
    assert_eq!(removed(&overlay), ["d", "e"]);

    // Reopened while the user is back in the room, with nothing but the rows to go by.
    let rows = overlay.hidden.clone();
    let reopened: Vec<_> = overlay
        .items
        .iter()
        .map(|item| rows.get(&item.id).unwrap_or(item).clone())
        .collect();
    let mut overlay = moderated();
    overlay.reset(reopened);
    assert_eq!(removed(&overlay), ["d", "e"]);
}

#[test]
fn a_ban_arriving_after_the_events_hides_them() {
    let mut overlay = moderated();
    let mut items = rejoined_then_banned();
    let ban = items.pop().unwrap();
    overlay.reset(items);
    assert_eq!(removed(&overlay), Vec::<&str>::new());

    let diffs = overlay.apply(VectorDiff::PushBack { value: ban });

    assert!(matches!(
        diffs.as_slice(),
        [
            VectorDiff::PushBack { .. },
            VectorDiff::Set { index: 4, .. },
            VectorDiff::Set { index: 6, .. }
        ]
    ));
    assert_eq!(removed(&overlay), ["d", "e"]);
}

#[test]
fn older_events_loaded_later_fall_on_the_right_side_of_the_member_event() {
    let mut overlay = moderated();
    let mut items = rejoined_then_banned();
    let earlier: Vec<_> = items.drain(..5).collect();
    overlay.reset(items);
    assert_eq!(removed(&overlay), ["e"]);

    for value in earlier.into_iter().rev() {
        let diffs = overlay.apply(VectorDiff::PushFront { value });
        assert_eq!(diffs.len(), 1);
    }

    assert_eq!(removed(&overlay), ["d", "e"]);
}

#[test]
fn a_removal_is_honoured_only_from_a_moderator_removing_someone_else() {
    let rows = |ban: TimelineItemView| vec![item("d", SPAM, None), ban];
    let mut overlay = moderated();
    for ban in [
        member_row("ban", "@user:x", SPAM, MembershipChangeView::Banned, true),
        member_row("leave", SPAM, SPAM, MembershipChangeView::Left, true),
        member_row("plain", MOD, SPAM, MembershipChangeView::Banned, false),
        TimelineItemView {
            visibility: TimelineVisibility::Hidden,
            ..ban_row("forged")
        },
    ] {
        overlay.reset(rows(ban));
        assert_eq!(removed(&overlay), Vec::<&str>::new());
    }

    overlay.reset(rows(member_row(
        "kick",
        MOD,
        SPAM,
        MembershipChangeView::Kicked,
        true,
    )));
    assert_eq!(removed(&overlay), ["d"]);
}

#[test]
fn state_and_already_deleted_rows_are_left_as_they_are() {
    let mut overlay = moderated();
    let state = TimelineItemContentView::StateEvent {
        event_type: "m.room.topic".to_owned(),
        state_key: String::new(),
        content: None,
        prev_content: None,
        change: None,
    };
    let deleted = TimelineItemContentView::Redacted {
        reason: None,
        redacted_by: None,
    };
    let cute = TimelineItemContentView::Unsupported {
        description: "x.event".to_owned(),
    };
    let unseen = TimelineItemContentView::HiddenEvent {
        event_type: "x.unseen".to_owned(),
        content: None,
        redacts: None,
    };
    let row = |id: &str, content: TimelineItemContentView| TimelineItemView {
        row: content.row_kind(),
        visibility: content.visibility(),
        content,
        ..item(id, SPAM, None)
    };

    overlay.reset(vec![
        row("state", state),
        row("deleted", deleted),
        row("unseen", unseen),
        row("event", cute),
        ban_row("banned"),
    ]);

    assert_eq!(removed(&overlay), ["event"]);
}

/// A thread holds no member rows, so the ban known from the room decides.
#[test]
fn without_member_rows_a_known_ban_removes_what_was_sent_before_it() {
    let mut overlay = moderated();
    overlay.reset(vec![
        at(50, item("before", SPAM, None)),
        at(150, item("after", SPAM, None)),
    ]);
    let ban = BanRedaction {
        by: user_id!("@mod:x").to_owned(),
        reason: None,
        at: 100,
    };

    let diffs = overlay.set_ban_redaction(user_id!("@spam:x"), Some(ban), None);

    assert!(matches!(
        diffs.as_slice(),
        [VectorDiff::Set { index: 0, .. }]
    ));
    assert!(
        overlay
            .set_ban_redaction(user_id!("@spam:x"), None, None)
            .is_empty(),
        "a later member event lifts nothing"
    );
    assert_eq!(removed(&overlay), ["before"]);
}
