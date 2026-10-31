use matrix_sdk::ruma::owned_room_id;

use crate::calls::membership::CallMember;
use crate::calls::runtime::tests::member;
use crate::protocol::{CallIntent, CallMode};

fn content(
    room_id: &matrix_sdk::ruma::OwnedRoomId,
    own: &CallMember,
    intent: Option<CallIntent>,
) -> serde_json::Value {
    serde_json::to_value(super::content(room_id, own, intent)).unwrap()
}

fn content_at(
    room_id: &matrix_sdk::ruma::OwnedRoomId,
    own: &CallMember,
    intent: Option<CallIntent>,
    now_ms: u64,
) -> serde_json::Value {
    serde_json::to_value(super::content_at(room_id, own, intent, now_ms)).unwrap()
}

#[test]
fn stable_membership_uses_stable_wire_fields() {
    let mut own = member(CallMode::Matrix2, 100, &["wss://focus.example"]);
    own.wire = crate::calls::membership::RtcWire::Stable;
    own.member_id = Some("member".to_owned());
    let body = content(&owned_room_id!("!room:example.org"), &own, None);
    assert_eq!(body["slot_id"], "m.call#room");
    assert_eq!(body["sticky_key"], "member");
    assert_eq!(
        body["member"],
        serde_json::json!({"id":"member", "membership":"join"})
    );
    assert_eq!(body["transports"]["published"][0]["type"], "m.livekit");
    assert_eq!(
        body["transports"]["can_subscribe"],
        serde_json::json!(["m.livekit"])
    );
    assert!(body.get("msc4354_sticky_key").is_none());
    assert_eq!(
        body["application"]["capabilities"],
        serde_json::json!(["m.render_audio", "m.render_video"])
    );
    assert!(body["application"].get("intent").is_none());
    for (intent, value) in [
        (CallIntent::Audio, "m.audio"),
        (CallIntent::Video, "m.video"),
    ] {
        let body = content(&owned_room_id!("!room:example.org"), &own, Some(intent));
        assert_eq!(body["application"]["intent"], value);
        assert!(body["application"].get("m.call.intent").is_none());
    }
}

#[test]
fn compatibility_and_matrix2_membership_shapes_match_deployed_element_call() {
    let compatibility = member(CallMode::Compatibility, 7, &["https://sfu.example.org"]);
    let compatibility = content(
        &"!room:example.org".try_into().unwrap(),
        &compatibility,
        None,
    );
    assert_eq!(
        compatibility["focus_active"]["focus_selection"],
        "multi_sfu"
    );
    assert_eq!(
        compatibility["foci_preferred"][0]["livekit_service_url"],
        "https://sfu.example.org"
    );

    let mut sticky = member(CallMode::Matrix2, 8, &["https://sfu.example.org"]);
    sticky.member_id = Some("member".to_owned());
    sticky.identity = "identity".to_owned();
    let sticky = content(&"!room:example.org".try_into().unwrap(), &sticky, None);
    assert_eq!(sticky["slot_id"], "m.call#ROOM");
    assert_eq!(sticky["member"]["id"], "member");
    assert_eq!(sticky["transports"]["published"][0]["type"], "livekit");
}

#[test]
fn legacy_content_uses_the_room_call_shape_with_an_empty_call_id() {
    let legacy = content(
        &"!room:example.org".try_into().unwrap(),
        &member(CallMode::Legacy, 7, &["https://sfu.example.org"]),
        None,
    );
    assert_eq!(legacy["application"], "m.call");
    assert_eq!(legacy["call_id"], "");
    assert_eq!(
        legacy["focus_active"]["focus_selection"],
        "oldest_membership"
    );
}

#[test]
fn matrix2_and_legacy_membership_content_differ_in_shape() {
    let room_id = owned_room_id!("!room:example.org");
    let mut own = member(CallMode::Matrix2, 1_000, &["https://sfu.example.org"]);
    own.member_id = Some("m1".to_owned());
    own.screen_sharing = true;
    assert_eq!(
        content_at(&room_id, &own, Some(CallIntent::Video), 2_000),
        serde_json::json!({
            "application": {"type": "m.call", "m.call.intent": "video"},
            "slot_id": "m.call#ROOM",
            "member": {"user_id": "@user:example.org", "device_id": "DEVICE", "id": "m1", "membership": "join"},
            "transports": {
                "published": [{"type": "livekit", "livekit_service_url": "https://sfu.example.org"}],
                "can_subscribe": ["livekit"],
            },
            "versions": [],
            "msc4354_sticky_key": "m1",
            "org.sable.screen_sharing": true,
        })
    );
    own.mode = CallMode::Compatibility;
    own.screen_sharing = false;
    assert_eq!(
        content_at(&room_id, &own, Some(CallIntent::Audio), 2_000),
        serde_json::json!({
            "application": "m.call", "call_id": "", "scope": "m.room",
            "device_id": "DEVICE",
            "membershipID": "@user:example.org:DEVICE",
            "created_ts": 1_000,
            "expires": 14_401_000,
            "focus_active": {"type": "livekit", "focus_selection": "multi_sfu"},
            "foci_preferred": [{
                "type": "livekit",
                "livekit_service_url": "https://sfu.example.org",
                "livekit_alias": "!room:example.org",
            }],
            "m.call.intent": "audio",
        })
    );
}

#[test]
fn renewal_extends_membership_beyond_four_hours_without_changing_session_identity() {
    let created = 1_000;
    let now = created + 5 * 60 * 60 * 1000;
    for mode in [CallMode::Legacy, CallMode::Compatibility] {
        let member = member(mode, created, &["https://sfu.example.org"]);
        let body = content_at(&owned_room_id!("!room:example.org"), &member, None, now);
        assert_eq!(body["created_ts"], created);
        assert_eq!(body["membershipID"], member.identity);
        assert_eq!(
            body["expires"].as_u64().unwrap() + created,
            now + 14_400_000
        );
        let membership: matrix_sdk::ruma::events::call::member::CallMemberEventContent =
            serde_json::from_value(body).unwrap();
        assert_eq!(
            serde_json::to_value(membership).unwrap()["created_ts"],
            created
        );
    }
}

#[test]
fn the_call_intent_rides_where_each_membership_format_reads_it() {
    let room_id = owned_room_id!("!room:example.org");
    let legacy = content(
        &room_id,
        &member(CallMode::Compatibility, 7, &["https://sfu.example.org"]),
        Some(crate::protocol::CallIntent::Video),
    );
    assert_eq!(legacy["m.call.intent"], "video");

    let mut sticky = member(CallMode::Matrix2, 8, &["https://sfu.example.org"]);
    sticky.member_id = Some("member".to_owned());
    let sticky = content(&room_id, &sticky, Some(crate::protocol::CallIntent::Audio));
    assert_eq!(sticky["application"]["m.call.intent"], "audio");
    assert!(sticky.get("m.call.intent").is_none());
}

#[test]
fn a_screen_share_flag_is_top_level_and_leaves_the_membership_untouched() {
    let room_id = owned_room_id!("!room:example.org");
    for mode in [CallMode::Compatibility, CallMode::Matrix2] {
        let mut own = member(mode, 7, &["https://sfu.example.org"]);
        own.member_id = Some("member".to_owned());
        let quiet = content_at(&room_id, &own, None, 9_000);
        assert!(quiet.get("org.sable.screen_sharing").is_none());

        own.screen_sharing = true;
        let sharing = content_at(&room_id, &own, None, 9_000);
        assert_eq!(sharing["org.sable.screen_sharing"], true);

        let mut stripped = sharing.clone();
        stripped
            .as_object_mut()
            .unwrap()
            .remove("org.sable.screen_sharing");
        assert_eq!(stripped, quiet);
    }
}

#[test]
fn a_republish_while_sharing_keeps_created_ts() {
    let room_id = owned_room_id!("!room:example.org");
    let mut own = member(CallMode::Compatibility, 4_000, &["https://sfu.example.org"]);
    own.screen_sharing = true;
    let body = content_at(&room_id, &own, None, 9_000);
    assert_eq!(body["created_ts"], 4_000);
    assert_eq!(body["org.sable.screen_sharing"], true);
}
