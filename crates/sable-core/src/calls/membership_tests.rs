use matrix_sdk::ruma::{device_id, owned_user_id, user_id};

use serde_json::json;

use super::{CallMember, StickyMemberships, advertised_service_urls, sticky_member};
use crate::protocol::CallMode;

#[test]
fn stable_membership_uses_the_specified_identity_without_a_device_claim() {
    let raw = r#"{
            "sender":"@alice:example.com",
            "content":{
                "slot_id":"m.call#room",
                "application":{"type":"m.call"},
                "member":{"id":"memberABC","membership":"join"},
                "transports":{"published":[{"type":"m.livekit","url":"wss://focus.example.com"}]}
            }
        }"#;
    let member = sticky_member(raw).unwrap();
    assert_eq!(member.device_id, None);
    assert_eq!(
        member.identity,
        "M3VnsLXrkbxIDINXO64u8PZzFyD9ZYFiQULR2dshWYs"
    );
    assert_eq!(
        member.focus_servers["wss://focus.example.com"].as_str(),
        "example.com"
    );
}

fn member(device: &str, created_ts: u64, foci: &[&str]) -> CallMember {
    CallMember {
        user_id: owned_user_id!("@kris:localhost"),
        device_id: Some(device.into()),
        member_id: None,
        identity: format!("@kris:localhost:{device}"),
        mode: CallMode::Legacy,
        created_ts,
        joined_ts: created_ts,
        expires_at_ms: None,
        foci: foci.iter().map(|url| (*url).to_owned()).collect(),
        screen_sharing: false,
        wire: super::RtcWire::Deployed,
        focus_servers: std::collections::HashMap::default(),
    }
}

#[test]
fn test_a_rejoin_is_a_different_generation() {
    assert!(!member("PHONE", 100, &[]).same_generation(&member("PHONE", 200, &[])));
    assert!(member("PHONE", 100, &[]).same_generation(&member("PHONE", 100, &[])));
}

#[test]
fn test_two_devices_of_one_user_are_two_members() {
    let laptop = member("LAPTOP", 100, &[]);

    assert!(!laptop.same_generation(&member("PHONE", 100, &[])));
    assert!(laptop.is_own(user_id!("@kris:localhost"), device_id!("LAPTOP")));
    assert!(!laptop.is_own(user_id!("@kris:localhost"), device_id!("PHONE")));
}

#[test]
fn test_the_running_calls_focus_wins_and_does_not_repeat() {
    let members = [
        member("LAPTOP", 100, &["https://sfu.one"]),
        member("PHONE", 110, &["https://sfu.one", "https://sfu.two"]),
    ];

    assert_eq!(
        advertised_service_urls(&members),
        vec!["https://sfu.one".to_owned(), "https://sfu.two".to_owned()]
    );
}

#[test]
fn test_a_sticky_member_reads_the_screen_share_flag() {
    let raw = |extra: &str| {
        format!(
            r#"{{
                    "sender":"@kris:localhost",
                    "content": {{
                        "slot_id":"m.call#ROOM",
                        "application":{{"type":"m.call"}},
                        "member":{{"user_id":"@kris:localhost","device_id":"LAPTOP","id":"member-1"}},
                        "transports":{{"published":[]}}{extra}
                    }}
                }}"#
        )
    };
    assert!(!sticky_member(&raw("")).unwrap().screen_sharing);
    assert!(
        sticky_member(&raw(r#","org.sable.screen_sharing":true"#))
            .unwrap()
            .screen_sharing
    );
}

#[test]
fn test_a_sticky_member_uses_its_member_id_for_the_deployed_identity() {
    let member = sticky_member(
            r#"{
                "sender":"@kris:localhost",
                "content": {
                    "slot_id":"m.call#ROOM",
                    "application":{"type":"m.call"},
                    "member":{"user_id":"@kris:localhost","device_id":"LAPTOP","id":"member-1"},
                    "versions":[],
                    "transports":{"published":[{"type":"livekit","livekit_service_url":"https://focus.example.org"}]}
                }
            }"#,
        )
        .unwrap();

    assert_eq!(member.user_id, user_id!("@kris:localhost"));
    assert_eq!(member.device_id.as_deref(), Some(device_id!("LAPTOP")));
    assert_eq!(member.member_id, "member-1");
    assert_eq!(member.foci, ["https://focus.example.org"]);
    assert_eq!(
        member.identity,
        "fy53C+VzB2i4DYEzQ2rL8RixeS0KyRA1qnFiggsxWhs"
    );
}

#[test]
fn a_sticky_member_on_an_sfu_url_uses_the_msc4195_identity() {
    let member = sticky_member(
            r#"{
                "sender":"@alice:example.com",
                "content": {
                    "slot_id":"m.call#ROOM",
                    "application":{"type":"m.call"},
                    "member":{"user_id":"@alice:example.com","device_id":"DEVICE","id":"memberABC"},
                    "transports":{"published":[{"type":"livekit","url":"wss://sfu.example.com","server_name":"other.example"}]}
                }
            }"#,
        )
        .unwrap();

    assert_eq!(member.foci, ["wss://sfu.example.com"]);
    assert_eq!(
        member.focus_servers["wss://sfu.example.com"].as_str(),
        "other.example"
    );
    assert_eq!(
        member.identity,
        "M3VnsLXrkbxIDINXO64u8PZzFyD9ZYFiQULR2dshWYs"
    );
}

#[test]
fn an_sfu_url_is_not_a_service_to_publish_on() {
    let members = [member("PHONE", 110, &["wss://sfu.one", "https://sfu.two"])];

    assert_eq!(
        advertised_service_urls(&members),
        vec!["https://sfu.two".to_owned()]
    );
}

#[test]
fn a_sticky_member_without_versions_uses_the_jwt_service_identity() {
    let member = sticky_member(
            r#"{
                "sender":"@kris:localhost",
                "content": {
                    "slot_id":"m.call#ROOM",
                    "application":{"type":"m.call"},
                    "member":{"user_id":"@kris:localhost","device_id":"LAPTOP","id":"member-1","membership":"join"},
                    "transports":{"published":[{"type":"livekit","livekit_service_url":"https://focus.example.org"}]}
                }
            }"#,
        )
        .unwrap();

    assert_eq!(member.identity, "@kris:localhost:LAPTOP");
}

#[test]
fn test_a_sticky_member_cannot_claim_another_sender() {
    assert!(
        sticky_member(
            r#"{
                "sender":"@kris:localhost",
                "content": {
                    "slot_id":"m.call#ROOM",
                    "application":{"type":"m.call"},
                    "member":{"user_id":"@other:localhost","device_id":"LAPTOP","id":"member-1"}
                }
            }"#,
        )
        .is_none()
    );
}
fn sticky_event(id: &str, origin: u64) -> serde_json::Value {
    serde_json::json!({
        "type":"org.matrix.msc4143.rtc.member", "sender":"@kris:localhost", "event_id":id,
        "origin_server_ts":origin,"msc4354_sticky":{"duration_ms":900_000},
        "content":{"msc4354_sticky_key":"member", "slot_id":"m.call#ROOM", "application":{"type":"m.call"},
            "member":{"user_id":"@kris:localhost","device_id":"PHONE","id":"member"},
            "transports":{"published":[{"type":"livekit","livekit_service_url":"https://sfu.example"}]}}
    })
}

#[test]
fn redaction_removes_membership_and_rejects_stale_replays() {
    let mut store = StickyMemberships::default();
    let event = sticky_event("$member", 100);
    assert!(store.apply(&event, 100));
    store.redact("$member", 200);
    assert_eq!(store.members(200), Vec::<CallMember>::new());
    assert!(!store.apply(&event, 200));
    assert!(!store.apply(&sticky_event("$older", 50), 200));
    assert_eq!(store.members(200), Vec::<CallMember>::new());
    assert!(store.apply(&sticky_event("$renewed", 300), 300));
    assert_eq!(store.members(300).len(), 1);
}

#[test]
fn redaction_before_decryption_prevents_a_late_join() {
    let mut store = StickyMemberships::default();
    store.redact("$member", 200);
    assert!(!store.apply(&sticky_event("$member", 100), 300));
    assert_eq!(store.members(300), Vec::<CallMember>::new());
}

#[test]
fn redacting_an_older_event_preserves_its_replacement() {
    let mut store = StickyMemberships::default();
    assert!(store.apply(&sticky_event("$old", 100), 100));
    assert!(store.apply(&sticky_event("$new", 200), 200));
    store.redact("$old", 300);
    assert_eq!(store.members(300).len(), 1);
}

#[test]
fn non_sticky_and_expired_events_cannot_replace_a_live_member() {
    let mut store = StickyMemberships::default();
    assert!(store.apply(&sticky_event("$live", 100), 100));
    let mut event = sticky_event("$zero-duration", 1_000_000);
    event["msc4354_sticky"]["duration_ms"] = json!(0);
    assert!(!store.apply(&event, 200));
    let mut event = sticky_event("$expired", 200);
    event["unsigned"] = json!({"sticky_duration_remaining_ms": 0});
    assert!(!store.apply(&event, 200));
    assert_eq!(store.members(200).len(), 1);
}

#[test]
fn authenticated_memberships_bind_join_and_leave_to_the_sending_device() {
    let mut store = StickyMemberships::default();
    let event = sticky_event("$a", 100);
    assert!(!store.apply_authenticated(&event, device_id!("LAPTOP"), 100));
    assert!(store.apply_authenticated(&event, device_id!("PHONE"), 100));
    let mut replacement = sticky_event("$b", 200);
    replacement["content"]["member"]["device_id"] = json!("LAPTOP");
    assert!(!store.apply_authenticated(&replacement, device_id!("LAPTOP"), 200));
    replacement["content"] = json!({"msc4354_sticky_key":"member", "slot_id":"m.call#ROOM", "member":{"id":"member", "membership":"leave"}});
    assert!(!store.apply_authenticated(&replacement, device_id!("LAPTOP"), 200));
    assert_eq!(store.members(200).len(), 1);
    assert!(store.apply_authenticated(&replacement, device_id!("PHONE"), 200));
    assert_eq!(store.members(200), Vec::<CallMember>::new());
}

#[test]
fn authenticated_membership_uses_the_sending_device_if_not_claimed() {
    let mut store = StickyMemberships::default();
    let mut event = sticky_event("$a", 100);
    event["content"]["member"]
        .as_object_mut()
        .unwrap()
        .remove("device_id");
    assert!(store.apply_authenticated(&event, device_id!("PHONE"), 100));
    assert_eq!(
        store.members(100)[0].device_id.as_deref(),
        Some(device_id!("PHONE"))
    );
}

#[test]
fn plaintext_replacement_cannot_remove_an_authenticated_member() {
    let mut store = StickyMemberships::default();
    assert!(store.apply_authenticated(&sticky_event("$a", 100), device_id!("PHONE"), 100));
    assert!(!store.apply_untrusted(&sticky_event("$b", 200), 200));
    assert_eq!(store.members(200).len(), 1);
    assert!(!store.apply_authenticated(&sticky_event("$a", 100), device_id!("PHONE"), 300));
}

#[test]
fn stable_and_deployed_slots_keep_distinct_memberships() {
    let mut store = StickyMemberships::default();
    assert!(store.apply(&sticky_event("$a", 100), 100));
    let mut stable = sticky_event("$b", 100);
    stable["type"] = json!("m.rtc.member");
    stable["content"] = json!({
        "slot_id": "m.call#room",
        "sticky_key": "member",
        "application": {"type": "m.call"},
        "member": {"id": "member", "membership": "join"},
        "transports": {"published": [{"type": "m.livekit", "url": "wss://focus.example"}]}
    });
    assert!(store.apply(&stable, 100));
    assert_eq!(store.members(100).len(), 2);
    stable["event_id"] = json!("$c");
    stable["origin_server_ts"] = json!(200);
    stable["content"] = json!({
        "slot_id": "m.call#room", "sticky_key": "member",
        "member": {"id": "member", "membership": "leave"}
    });
    assert!(store.apply(&stable, 200));
    let remaining = store.members(200);
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].wire, super::RtcWire::Deployed);
}

#[test]
fn sticky_map_separates_event_types() {
    let mut store = StickyMemberships::default();
    assert!(store.apply(&sticky_event("$a", 100), 100));
    let mut other_type = sticky_event("$b", 100);
    other_type["type"] = json!("m.rtc.member");
    assert!(store.apply(&other_type, 100));
    other_type["event_id"] = json!("$c");
    other_type["origin_server_ts"] = json!(200);
    other_type["content"] = json!({"slot_id": "m.call#ROOM", "msc4354_sticky_key": "member"});
    assert!(store.apply(&other_type, 200));
    assert_eq!(store.members(200).len(), 1);
}

#[test]
fn sticky_expiry_uses_the_envelope_and_receipt_ttl_without_extending_replays() {
    let mut store = StickyMemberships::default();
    let event = sticky_event("$a", 100);
    assert!(store.apply(&event, 200));
    assert_eq!(store.members(200)[0].expires_at_ms, Some(900_100));
    assert_eq!(store.members(900_100), Vec::<CallMember>::new());
    let mut event = sticky_event("$b", 500);
    event["unsigned"] = serde_json::json!({"msc4354_sticky_duration_ttl_ms": 300});
    assert!(store.apply(&event, 1000));
    assert_eq!(store.members(1000)[0].expires_at_ms, Some(1300));
    assert!(!store.apply(&event, 1100));
    assert_eq!(store.members(1300), Vec::<CallMember>::new());
}

#[test]
fn sticky_expiry_accepts_the_stable_remaining_duration() {
    let mut store = StickyMemberships::default();
    let mut event = sticky_event("$a", 100);
    event["unsigned"] = json!({"sticky_duration_remaining_ms": 300});
    assert!(store.apply(&event, 1000));
    assert_eq!(store.members(1000)[0].expires_at_ms, Some(1300));
}

#[test]
fn sticky_expiry_without_a_ttl_does_not_extend_a_future_timestamp() {
    let mut store = StickyMemberships::default();
    let event = sticky_event("$future", 2_000);
    assert!(store.apply(&event, 1_000));
    assert_eq!(store.members(1_000)[0].expires_at_ms, Some(901_000));
    assert_eq!(store.members(901_000), Vec::<CallMember>::new());
}

#[test]
fn sticky_tombstones_override_older_memberships_and_are_sender_scoped() {
    let mut store = StickyMemberships::default();
    let event = sticky_event("$a", 100);
    assert!(store.apply(&event, 100));
    let mut leave = sticky_event("$b", 200);
    leave["content"] = serde_json::json!({"msc4354_sticky_key":"member"});
    leave["sender"] = serde_json::json!("@other:localhost");
    assert!(store.apply(&leave, 200));
    assert_eq!(store.members(200).len(), 1);
    leave["sender"] = serde_json::json!("@kris:localhost");
    assert!(store.apply(&leave, 200));
    assert_eq!(store.members(200), Vec::<CallMember>::new());
    assert!(!store.apply(&event, 300));
    assert_eq!(store.members(300), Vec::<CallMember>::new());
}

#[test]
fn a_sticky_renewal_keeps_the_time_the_member_joined() {
    let mut store = StickyMemberships::default();
    assert!(store.apply(&sticky_event("$a", 100), 100));
    assert!(store.apply(&sticky_event("$b", 600_000), 600_000));
    let member = &store.members(600_000)[0];
    assert_eq!(member.created_ts, 600_000);
    assert_eq!(member.joined_ts, 100);

    let mut rejoin = sticky_event("$c", 700_000);
    rejoin["content"]["member"]["id"] = serde_json::json!("fresh");
    rejoin["content"]["msc4354_sticky_key"] = serde_json::json!("fresh");
    assert!(store.apply(&rejoin, 700_000));
    let fresh = store
        .members(700_000)
        .into_iter()
        .find(|member| member.member_id.as_deref() == Some("fresh"));
    assert_eq!(fresh.map(|member| member.joined_ts), Some(700_000));
}

#[test]
fn a_different_device_with_the_same_member_id_has_a_new_join_time() {
    let mut store = StickyMemberships::default();
    assert!(store.apply(&sticky_event("$a", 100), 100));
    let mut replacement = sticky_event("$b", 200);
    replacement["content"]["member"]["device_id"] = json!("LAPTOP");
    assert!(store.apply(&replacement, 200));
    let member = &store.members(200)[0];
    assert_eq!(member.device_id.as_deref(), Some(device_id!("LAPTOP")));
    assert_eq!(member.joined_ts, 200);
}

#[test]
fn a_sticky_leave_that_names_its_slot_is_a_tombstone() {
    let mut store = StickyMemberships::default();
    assert!(store.apply(&sticky_event("$a", 100), 100));
    let mut leave = sticky_event("$b", 200);
    leave["type"] = serde_json::json!("org.matrix.msc4143.rtc.member");
    leave["content"] = serde_json::json!({"slot_id":"m.call#ROOM", "msc4354_sticky_key":"member"});
    assert!(store.apply(&leave, 200));
    assert_eq!(store.members(200), Vec::<CallMember>::new());
}

#[test]
fn an_explicit_sticky_leave_is_a_tombstone() {
    let mut store = StickyMemberships::default();
    assert!(store.apply(&sticky_event("$a", 100), 100));
    let mut leave = sticky_event("$b", 200);
    leave["content"] = serde_json::json!({
        "slot_id": "m.call#ROOM",
        "member": {"id": "member", "membership": "leave"},
        "leave_reason": {"code": "leave"},
        "msc4354_sticky_key": "member",
    });
    assert!(store.apply(&leave, 200));
    assert_eq!(store.members(200), Vec::<CallMember>::new());
}

#[test]
fn a_non_joined_membership_replaces_an_older_join() {
    let mut store = StickyMemberships::default();
    let joined = sticky_event("$a", 100);
    assert!(store.apply(&joined, 100));
    let mut updated = sticky_event("$b", 200);
    updated["content"]["member"]["membership"] = serde_json::json!("other");
    assert!(store.apply(&updated, 200));
    assert_eq!(store.members(200), Vec::<CallMember>::new());
    assert!(!store.apply(&joined, 300));
}

#[test]
fn sticky_order_uses_server_expiry_and_event_id_not_receipt_time() {
    let mut store = StickyMemberships::default();
    let newer = sticky_event("$z", 200);
    assert!(store.apply(&newer, 200));
    let mut stale = sticky_event("$a", 100);
    stale["unsigned"] = serde_json::json!({"msc4354_sticky_duration_ttl_ms":900_000});
    assert!(!store.apply(&stale, 1000));
    stale["origin_server_ts"] = serde_json::json!(200);
    assert!(!store.apply(&stale, 1000));
    assert_eq!(store.members(1000)[0].created_ts, 200);
}

#[test]
fn sticky_order_uses_the_unclamped_duration() {
    let mut store = StickyMemberships::default();
    let mut first = sticky_event("$a", 100);
    first["msc4354_sticky"]["duration_ms"] = serde_json::json!(3_600_200);
    assert!(store.apply(&first, 100));
    let mut second = sticky_event("$b", 200);
    second["msc4354_sticky"]["duration_ms"] = serde_json::json!(3_600_000);
    assert!(!store.apply(&second, 200));
    assert_eq!(store.members(200)[0].created_ts, 100);
}

#[test]
fn malformed_sticky_memberships_cannot_act_as_leave_events() {
    let mut store = StickyMemberships::default();
    assert!(store.apply(&sticky_event("$a", 100), 100));
    for (field, value) in [
        ("slot_id", serde_json::json!("m.call#OTHER")),
        ("application", serde_json::json!({"type":"other"})),
        (
            "member",
            serde_json::json!({"user_id":"@forged:localhost","device_id":"PHONE","id":"member"}),
        ),
    ] {
        let mut event = sticky_event("$b", 200);
        event["content"][field] = value;
        assert!(!store.apply(&event, 200));
        assert_eq!(store.members(200).len(), 1);
    }
}

#[test]
fn a_sticky_member_id_must_match_its_sticky_key() {
    let mut store = StickyMemberships::default();
    let mut event = sticky_event("$mismatch", 100);
    event["content"]["member"]["id"] = serde_json::json!("other");
    assert!(!store.apply(&event, 100));
    assert_eq!(store.members(100), Vec::<CallMember>::new());
}
#[tokio::test]
async fn state_memberships_survive_the_sdk_store_for_both_focus_modes() {
    use matrix_sdk::ruma::{events::AnySyncStateEvent, room_id, serde::Raw};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!call:example.org");
    let now = crate::now_ms();
    let mut builder = JoinedRoomBuilder::new(room_id);
    for (device, selection) in [("LEGACY", "oldest_membership"), ("COMPAT", "multi_sfu")] {
        let event = json!({
            "type": "org.matrix.msc3401.call.member",
            "state_key": format!("_@user:example.org_{device}_m.call"),
            "sender": "@user:example.org", "event_id": format!("${device}"),
            "origin_server_ts": now,
            "content": {
                "application": "m.call", "call_id": "", "scope": "m.room",
                "device_id": device, "created_ts": now, "expires": 14_400_000,
                "focus_active": {"type":"livekit", "focus_selection": selection},
                "foci_preferred": [{"type":"livekit", "livekit_service_url":"https://sfu.example.org", "livekit_alias":room_id}]
            }
        });
        builder = builder.add_state_event(
            Raw::new(&event)
                .unwrap()
                .cast_unchecked::<AnySyncStateEvent>(),
        );
    }
    let room = server.sync_room(&client, builder).await;
    let members = super::active_members(&room).await;
    assert_eq!(members.len(), 2);
    for (device, mode) in [
        ("LEGACY", CallMode::Legacy),
        ("COMPAT", CallMode::Compatibility),
    ] {
        let member = members
            .iter()
            .find(|member| {
                member
                    .device_id
                    .as_deref()
                    .is_some_and(|id| id.as_str() == device)
            })
            .unwrap();
        assert_eq!(member.mode, mode);
        assert_eq!(member.identity, format!("@user:example.org:{device}"));
        assert_eq!(
            member.member_id.as_deref(),
            Some(format!("@user:example.org:{device}").as_str())
        );
        assert_eq!(member.foci, ["https://sfu.example.org"]);
    }
}

#[tokio::test]
async fn state_membership_uses_its_custom_membership_id() {
    use matrix_sdk::ruma::{events::AnySyncStateEvent, room_id, serde::Raw};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!call:example.org");
    let now = crate::now_ms();
    let event = json!({
        "type": "org.matrix.msc3401.call.member",
        "state_key": "_@user:example.org_DEVICE_m.call",
        "sender": "@user:example.org", "event_id": "$custom",
        "origin_server_ts": now,
        "content": {
            "application": "m.call", "call_id": "", "scope": "m.room",
            "device_id": "DEVICE", "membershipID": "custom-membership",
            "created_ts": now, "expires": 14_400_000,
            "focus_active": {"type":"livekit", "focus_selection":"multi_sfu"},
            "foci_preferred": [{"type":"livekit", "livekit_service_url":"https://sfu.example.org", "livekit_alias":room_id}]
        }
    });
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_state_event(
                Raw::new(&event)
                    .unwrap()
                    .cast_unchecked::<AnySyncStateEvent>(),
            ),
        )
        .await;

    let members = super::active_members(&room).await;
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].member_id.as_deref(), Some("custom-membership"));
    assert_eq!(members[0].identity, "@user:example.org:DEVICE");
}

#[tokio::test]
async fn a_state_membership_on_an_sfu_url_uses_the_msc4195_identity() {
    use matrix_sdk::ruma::{events::AnySyncStateEvent, room_id, serde::Raw};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::JoinedRoomBuilder;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!call:example.com");
    let now = crate::now_ms();
    let event = json!({
        "type": "org.matrix.msc3401.call.member",
        "state_key": "_@alice:example.com_DEVICE_m.call",
        "sender": "@alice:example.com", "event_id": "$element",
        "origin_server_ts": now,
        "content": {
            "application": "m.call", "call_id": "", "scope": "m.room",
            "device_id": "DEVICE", "membershipID": "memberABC",
            "created_ts": now, "expires": 14_400_000,
            "focus_active": {"type":"livekit", "focus_selection":"multi_sfu"},
            "foci_preferred": [{"type":"livekit", "url":"wss://sfu.example.com"}]
        }
    });
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_state_event(
                Raw::new(&event)
                    .unwrap()
                    .cast_unchecked::<AnySyncStateEvent>(),
            ),
        )
        .await;

    let members = super::active_members(&room).await;
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].foci, ["wss://sfu.example.com"]);
    assert_eq!(
        members[0].focus_servers["wss://sfu.example.com"].as_str(),
        "example.com"
    );
    assert_eq!(
        members[0].identity,
        "M3VnsLXrkbxIDINXO64u8PZzFyD9ZYFiQULR2dshWYs"
    );
}

fn tombstone(extra: &serde_json::Value) -> serde_json::Value {
    let mut event = json!({
        "type": "org.matrix.msc4143.rtc.member",
        "sender": "@a:example.org",
        "event_id": "$e",
        "origin_server_ts": 1_000,
        "msc4354_sticky": { "duration_ms": 5_000 },
        "content": { "msc4354_sticky_key": "k", "slot_id": "m.call#ROOM" },
    });
    for (key, value) in extra.as_object().expect("object") {
        event[key] = value.clone();
    }
    event
}

#[test]
fn a_tombstone_applies_and_wrong_typed_fields_reject_the_event() {
    let apply = |event: serde_json::Value| StickyMemberships::default().apply(&event, 1_000);
    assert!(apply(tombstone(&json!({}))));
    assert!(!apply(tombstone(&json!({
        "msc4354_sticky": null, "sticky": { "duration_ms": 5_000 }
    }))));
    assert!(!apply(tombstone(&json!({
        "msc4354_sticky": { "duration_ms": "5" }, "sticky": { "duration_ms": 5_000 }
    }))));
    assert!(!apply(tombstone(&json!({
        "msc4354_sticky": null, "sticky": { "duration_ms": 5_000 }, "type": 3
    }))));
    assert!(!apply(tombstone(&json!({ "sender": 3 }))));
    assert!(!apply(tombstone(&json!({ "event_id": "" }))));
    assert!(!apply(tombstone(&json!({ "origin_server_ts": "1" }))));
    assert!(!apply(tombstone(&json!({ "content": "x" }))));
    assert!(!apply(json!("x")));
}

#[test]
fn the_legacy_sticky_key_and_extra_content_decide_what_a_member_is() {
    let mut sticky = StickyMemberships::default();
    let mut event = tombstone(&json!({ "sticky": { "duration_ms": 5_000 } }));
    event["msc4354_sticky"] = serde_json::Value::Null;
    event["content"] = json!({ "sticky_key": "k", "msc4354_sticky_key": "other" });
    assert!(!sticky.apply(&event, 1_000));
    event["content"] = json!({ "sticky_key": "k" });
    event
        .as_object_mut()
        .expect("object")
        .remove("msc4354_sticky");
    assert!(sticky.apply(&event, 1_000));
    event["event_id"] = json!("$f");
    event["content"] = json!({ "sticky_key": "k", "foreign": 1 });
    assert!(!sticky.apply(&event, 1_000), "not a tombstone nor a member");
}
