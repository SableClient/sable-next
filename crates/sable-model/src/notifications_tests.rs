use serde_json::json;

use super::*;

fn parsed(raw: &Value) -> PushNotification {
    parse_push_payload(&raw.to_string()).expect("a valid push")
}

#[test]
fn hidden_push_names_use_the_sender() {
    for name in [
        "",
        "   ",
        "\u{200b}\u{2800}\u{feff}",
        "\u{3164}",
        "\u{2060}\u{2066}\u{2069}",
        "\u{fe0f}\u{e0100}",
        "\u{0085}",
        "\u{0600}",
        "\u{fff9}\u{fffa}\u{fffb}",
        "\u{13430}",
    ] {
        let push = parsed(&json!({
            "room_id": "!r:x", "sender": "@alice:x", "sender_display_name": name,
        }));
        assert_eq!(push.sender_display_name.as_deref(), Some("@alice:x"));
    }
}

#[test]
fn rich_text_pushes_use_formatted_text() {
    let content = json!({
        "msgtype": "m.text",
        "body": "<a data-mention-type=\"user\" href=\"https://matrix.to/#/@alice:example.org\" contenteditable=\"false\">Alice</a> hi &amp; welcome",
        "format": "org.matrix.custom.html",
        "formatted_body": "<a href=\"https://matrix.to/#/@alice:example.org\">Alice</a> hi &amp; welcome"
    });
    assert_eq!(
        push_content(&content).body.as_deref(),
        Some("Alice hi & welcome")
    );
    let push = parsed(&json!({
        "room_id": "!r:x", "event_id": "$e", "sender_display_name": "Bob",
        "type": "m.room.message", "content": content
    }));
    let shown = alert(&push, None, true).expect("an alert");
    assert_eq!(shown.body, "Bob: Alice hi & welcome");
    assert_eq!(shown.line.body, "Alice hi & welcome");
}

#[test]
fn push_previews_keep_literal_plain_text() {
    for format in [json!(null), json!("org.example.other"), json!(5)] {
        assert_eq!(
            push_content(&json!({
                "body": "<b>literal</b> &amp; text", "format": format,
                "formatted_body": "<b>formatted</b>"
            }))
            .body
            .as_deref(),
            Some("<b>literal</b> &amp; text")
        );
    }
}

#[test]
fn push_previews_hide_spoilers_and_reply_fallbacks() {
    let content = push_content(&json!({
        "body": "quoted secret",
        "format": "org.matrix.custom.html",
        "formatted_body": "<mx-reply><blockquote>quoted</blockquote></mx-reply>look <span data-mx-spoiler>secret</span>"
    }));
    assert_eq!(content.body.as_deref(), Some("look [Spoiler]"));
}

#[test]
fn a_counts_only_push_is_a_badge_update() {
    let counts = parsed(&json!({"notification": {"counts": {"unread": 4}}}));
    assert_eq!(counts.unread, Some(4));
    assert_eq!(alert(&counts, None, true), None);
}

#[test]
fn a_flattened_notification_reads_its_top_level_unread() {
    let flat = parsed(&json!({"room_id": "!r:x", "event_id": "$e", "unread": 2}));
    assert_eq!(flat.unread, Some(2));
    let whole = parsed(&json!({"room_id": "!r:x", "unread": 2.0}));
    assert_eq!(whole.unread, Some(2));
    let fraction = parsed(&json!({"room_id": "!r:x", "unread": 2.5}));
    assert_eq!(fraction.unread, None);
}

#[test]
fn every_envelope_keeps_its_recipient() {
    let inner = json!({"room_id": "!r:x", "event_id": "$e"});
    for raw in [
        json!({"room_id": "!r:x", "event_id": "$e", "user_id": "@me:x"}),
        json!({"user_id": "@me:x", "notification": inner}),
        json!({"user_id": "@me:x", "notification": inner.to_string()}),
        json!({"notification": {"room_id": "!r:x", "devices": [{"data": {"default_payload": {"user_id": "@me:x"}}}]}}),
    ] {
        assert_eq!(parsed(&raw).user_id.as_deref(), Some("@me:x"), "{raw}");
    }
}

#[test]
fn malformed_and_conflicting_payloads_are_refused() {
    for raw in ["invalid", "[]", "null", r#"{"notification":null}"#] {
        assert_eq!(parse_push_payload(raw), None, "{raw}");
    }
    let conflicting =
        json!({"user_id": "@a:x", "notification": {"user_id": "@b:x", "room_id": "!r:x"}});
    assert_eq!(parse_push_payload(&conflicting.to_string()), None);
}

#[test]
fn a_sound_or_highlight_tweak_makes_a_push_noisy() {
    let noisy = |tweaks: Value| {
        parsed(&json!({"notification": {"room_id": "!r:x", "devices": [{"pushkey": "k", "tweaks": tweaks}]}}))
                .noisy
    };
    assert!(noisy(json!({"sound": "default"})));
    assert!(noisy(json!({"highlight": true})));
    assert!(!noisy(json!({"highlight": false})));
    assert!(!noisy(json!({})));
}

#[test]
fn the_validation_handshake_is_not_a_notification() {
    let handshake = json!({"app_id": "moe.sable.webpush", "ack_token": "tok"}).to_string();
    assert_eq!(parse_push_payload(&handshake), None);
    assert_eq!(
        web_push_validation(&handshake),
        Some(WebPushValidation {
            app_id: "moe.sable.webpush".to_owned(),
            ack_token: "tok".to_owned()
        })
    );
    for raw in [
        json!({"app_id": "a", "ack_token": "tok", "room_id": "!r:x"}),
        json!({"app_id": "a", "ack_token": "tok", "unread": 0}),
        json!({"app_id": "", "ack_token": "tok"}),
        json!({"app_id": "a"}),
    ] {
        assert_eq!(web_push_validation(&raw.to_string()), None, "{raw}");
    }
    assert_eq!(web_push_validation("not json"), None);
}

#[test]
fn an_invitation_without_content_still_reads_as_one() {
    let invite = parsed(&json!({"notification": {
        "room_id": "!r:x", "type": "m.room.member", "membership": "invite",
        "sender_display_name": "Ada", "user_id": "@me:x"
    }}));
    let shown = alert(&invite, Some("Crew"), true).expect("an alert");
    assert_eq!(shown.body, "Ada invited you");
    assert!(shown.invite);
}

#[test]
fn a_ring_reads_as_a_call() {
    let ring = PushNotification {
        room_id: Some("!r:x".to_owned()),
        event_type: Some("org.matrix.msc4075.rtc.notification".to_owned()),
        sender_display_name: Some("Ada".to_owned()),
        content: PushContent {
            body: Some("ignored".to_owned()),
            notification_type: Some("ring".to_owned()),
            ..PushContent::default()
        },
        ..PushNotification::default()
    };
    let shown = alert(&ring, None, true).expect("an alert");
    assert_eq!(shown.body, "Ada is calling");
    assert_eq!(shown.line.body, "Ada is calling");
    assert_eq!(shown.line.sender, None);
    assert!(shown.ring);
}

#[test]
fn stable_call_invites_use_the_receivers_presentation() {
    let mut invite = PushNotification {
        room_id: Some("!room:example.org".to_owned()),
        event_type: Some("m.rtc.invite".to_owned()),
        content: PushContent {
            notification_type: Some("ring".to_owned()),
            ..PushContent::default()
        },
        ..PushNotification::default()
    };
    assert!(alert(&invite, None, true).unwrap().ring);
    invite.content.notification_type = Some("notification".to_owned());
    assert!(!alert(&invite, None, true).unwrap().ring);
    invite.content.notification_type = None;
    assert!(!alert(&invite, None, true).unwrap().ring);
}

#[test]
fn content_stays_out_when_previews_are_off() {
    let message = PushNotification {
        room_id: Some("!r:x".to_owned()),
        sender_display_name: Some("Ada".to_owned()),
        content: PushContent {
            body: Some("the merger".to_owned()),
            ..PushContent::default()
        },
        ..PushNotification::default()
    };
    assert_eq!(
        alert(&message, None, false).expect("an alert").body,
        "New message from Ada"
    );
    let shown = alert(&message, None, true).expect("an alert");
    assert_eq!(shown.body, "Ada: the merger");
    assert_eq!(shown.line.sender.as_deref(), Some("Ada"));
    assert_eq!(shown.title, "Sable");
}

#[test]
fn an_encrypted_push_is_silenced_where_only_mentions_count() {
    let encrypted = PushNotification {
        event_type: Some("m.room.encrypted".to_owned()),
        ..PushNotification::default()
    };
    assert!(silenced_by_room_mode(
        &encrypted,
        Some(NotificationModeView::Mentions)
    ));
    assert!(!silenced_by_room_mode(
        &encrypted,
        Some(NotificationModeView::All)
    ));
    assert!(!silenced_by_room_mode(&encrypted, None));
    assert!(silenced_by_room_mode(
        &PushNotification::default(),
        Some(NotificationModeView::Mute)
    ));
}

#[test]
fn an_event_id_only_push_is_named_from_the_cached_room() {
    let push = parsed(&json!({
        "room_id": "!r:x", "event_id": "$e", "user_id": "@me:x", "unread": 1
    }));
    assert_eq!(
        alert(&push, Some("Design crew"), true),
        Some(PushAlert {
            title: "Design crew".to_owned(),
            body: "New message".to_owned(),
            line: ConversationLine {
                sender: None,
                body: "New message".to_owned(),
                event_id: Some("$e".to_owned()),
            },
            tag: room_tag(Some("@me:x"), "!r:x"),
            room_id: "!r:x".to_owned(),
            event_id: Some("$e".to_owned()),
            ring: false,
            invite: false,
        })
    );
    assert_eq!(room_tag(Some("@me:x"), "!r:x"), "@me:x !r:x");
}

#[test]
fn a_rich_push_prefers_the_name_the_server_sent() {
    let push = parsed(&json!({
        "room_id": "!r:x", "room_name": "Design crew", "sender_display_name": "Ada",
        "content": {"body": "shipped the patch"}
    }));
    let shown = alert(&push, Some("Stale name"), true).expect("an alert");
    assert_eq!(shown.title, "Design crew");
    assert_eq!(shown.body, "Ada: shipped the patch");
}

#[test]
fn an_invitation_with_membership_content_says_so() {
    let invite = parsed(&json!({
        "room_id": "!r:x", "type": "m.room.member", "sender_display_name": "Ada",
        "content": {"membership": "invite"}
    }));
    let shown = alert(&invite, Some("Design crew"), true).expect("an alert");
    assert_eq!(shown.body, "Ada invited you");
    assert!(shown.invite);
}

#[test]
fn a_call_notification_that_does_not_ring_stays_a_plain_alert() {
    let notify = parsed(&json!({
        "room_id": "!r:x", "type": "m.rtc.notification", "sender_display_name": "Ada",
        "content": {"notification_type": "notification"}
    }));
    assert!(!alert(&notify, Some("Design crew"), true).unwrap().ring);
}

#[test]
fn hidden_previews_also_hide_the_conversation_line() {
    let message = parsed(&json!({
        "room_id": "!r:x", "event_id": "$e", "sender_display_name": "Ada",
        "content": {"body": "the merger closes friday"}
    }));
    let hidden = alert(&message, Some("Design crew"), false).expect("an alert");
    assert_eq!(hidden.body, "New message from Ada");
    assert_eq!(hidden.line.body, "New message from Ada");
}

#[test]
fn a_plain_push_is_not_silenced_where_only_mentions_count() {
    let plain = PushNotification {
        event_type: Some("m.room.message".to_owned()),
        ..PushNotification::default()
    };
    assert!(!silenced_by_room_mode(
        &plain,
        Some(NotificationModeView::Mentions)
    ));
    assert!(silenced_by_room_mode(
        &plain,
        Some(NotificationModeView::Mute)
    ));
}

#[test]
fn a_conversation_line_keeps_its_stored_field_names() {
    let line = ConversationLine {
        sender: None,
        body: "hi".to_owned(),
        event_id: Some("$e".to_owned()),
    };
    assert_eq!(
        serde_json::to_value(&line).expect("serializes"),
        json!({"sender": null, "body": "hi", "eventId": "$e"})
    );
}

#[test]
fn wrong_typed_parts_of_a_push_are_skipped() {
    let push = parsed(&json!({
        "user_id": 4,
        "notification": {
            "room_id": "!r:x", "event_id": 3, "room_name": "  ",
            "devices": ["junk", {"tweaks": "loud", "data": 1}, {"tweaks": {"sound": null}}],
            "counts": "many", "unread": 2.0, "content": "text"
        }
    }));
    assert_eq!(push.room_id.as_deref(), Some("!r:x"));
    assert_eq!(push.event_id, None);
    assert_eq!(push.room_name, None);
    assert!(push.noisy);
    assert_eq!(push.unread, Some(2));
    assert_eq!(push.content, PushContent::default());
    assert_eq!(push.user_id, None);
}

#[test]
fn a_handshake_with_wrong_typed_credentials_is_not_one() {
    assert!(web_push_validation(r#"{"app_id": 1, "ack_token": "t"}"#).is_none());
    assert!(web_push_validation(r#"{"app_id": "a", "ack_token": "t", "unread": 1}"#).is_none());
    assert_eq!(
        web_push_validation(r#"{"app_id": "a", "ack_token": "t", "unread": "1"}"#),
        Some(WebPushValidation {
            app_id: "a".to_owned(),
            ack_token: "t".to_owned()
        })
    );
}

#[test]
fn devices_that_are_not_a_list_are_ignored() {
    let push =
        parsed(&json!({"notification": {"room_id": "!r:x", "devices": {"tweaks": {"sound": 1}}}}));
    assert!(!push.noisy);
}

#[test]
fn text_is_kept_untrimmed_but_a_recipient_is_trimmed() {
    let push = parsed(&json!({"user_id": " @me:x ", "room_id": "!r:x", "room_name": " Den "}));
    assert_eq!(push.room_name.as_deref(), Some(" Den "));
    assert_eq!(push.user_id.as_deref(), Some("@me:x"));
}

const NOW: u64 = 1_000_000;

fn activity(value: &Value) -> DeviceActivity {
    serde_json::from_value(value.clone()).expect("device activity content")
}

#[test]
fn a_fresh_active_report_from_another_device_keeps_this_one_quiet() {
    let content = activity(&json!({
        "devices": { "OTHER": { "active": true, "at": NOW - 20_000 } }
    }));
    assert!(active_elsewhere(&content, "OWN", NOW));
}

#[test]
fn this_devices_own_report_does_not_count() {
    let content = activity(&json!({
        "devices": { "OWN": { "active": true, "at": NOW - 20_000 } }
    }));
    assert!(!active_elsewhere(&content, "OWN", NOW));
}

#[test]
fn stale_future_inactive_or_malformed_reports_alert() {
    for value in [
        json!({ "devices": { "OTHER": { "active": true, "at": NOW - 180_000 } } }),
        json!({ "devices": { "OTHER": { "active": true, "at": NOW + 60_001 } } }),
        json!({ "devices": { "OTHER": { "active": false, "at": NOW - 20_000 } } }),
    ] {
        assert!(!active_elsewhere(&activity(&value), "OWN", NOW), "{value}");
    }
    assert!(!active_elsewhere_json("{\"devices\":true}", "OWN", NOW));
}
