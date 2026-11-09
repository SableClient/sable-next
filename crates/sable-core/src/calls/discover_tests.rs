use matrix_sdk::ruma::{owned_room_id, owned_user_id};
use matrix_sdk::test_utils::mocks::MatrixMockServer;

use super::{Discovered, discover, mode_reason, select_mode};
use crate::Core;
use crate::calls::runtime::tests::member;
use crate::protocol::{CallMode, CallSessionId};
use crate::store::MemorySessionStore;

async fn discover_with_peers(
    mode: CallMode,
    peers: &[(u64, &str)],
    configured: Option<&str>,
) -> Discovered {
    use matrix_sdk::ruma::{events::AnySyncStateEvent, serde::Raw};
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;
    use wiremock::matchers::{method, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    let server = MatrixMockServer::new().await;
    server
        .mock_versions()
        .with_feature("org.matrix.msc4354", mode == CallMode::Matrix2)
        .ok()
        .mount()
        .await;
    let client = server
        .client_builder()
        .no_server_versions()
        .on_builder(|builder| builder.disable_well_known_lookup(true))
        .build()
        .await;
    let room_id = owned_room_id!("!call:example.org");
    let now = crate::now_ms();
    let mut builder = JoinedRoomBuilder::new(&room_id);
    let mut sticky_events = Vec::new();
    for (age, service) in peers {
        let mut peer = member(mode, now - age, &[service]);
        peer.user_id = owned_user_id!("@peer:example.org");
        peer.device_id = Some(format!("DEVICE{age}").into());
        peer.member_id = Some(format!("peer-{age}"));
        let mut event = json!({
            "type": if mode == CallMode::Matrix2 {
                crate::calls::membership::RTC_MEMBER_EVENT_TYPE
            } else {
                "org.matrix.msc3401.call.member"
            },
            "event_id": format!("$peer-{age}"), "sender": peer.user_id,
            "origin_server_ts": peer.created_ts,
            "content": serde_json::to_value(crate::calls::content::content_at(&room_id, &peer, None, now)).unwrap(),
        });
        if mode == CallMode::Matrix2 {
            event["msc4354_sticky"] = json!({"duration_ms": 3_600_000});
            sticky_events.push(event);
        } else {
            event["state_key"] =
                format!("_{}_{}_m.call", peer.user_id, peer.own_device_id()).into();
            builder = builder.add_state_event(
                Raw::new(&event)
                    .unwrap()
                    .cast_unchecked::<AnySyncStateEvent>(),
            );
        }
    }
    server.mock_room_state_encryption().plain().mount().await;
    let room = server.sync_room(&client, builder).await;
    if mode == CallMode::Matrix2 {
        Mock::given(method("POST"))
            .and(path_regex(".*sync.*"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "pos": "p1",
                "extensions": {"org.matrix.msc4354.sticky_events": {
                    "next_batch": "s1", "rooms": {room_id.as_str(): {"events": sticky_events}}
                }}
            })))
            .expect(1)
            .mount(server.server())
            .await;
    }
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let discovered = discover(
        &core,
        &room,
        CallSessionId(1),
        configured.map(str::to_owned),
        peers.is_empty().then_some(mode),
    )
    .await
    .unwrap();
    assert_eq!(discovered.own.mode, mode);
    discovered
}

const PEERS: [(u64, &str); 2] = [
    (1_000, "https://later.example.org"),
    (2_000, "https://oldest.example.org"),
];

#[tokio::test]
async fn joining_an_existing_call_uses_the_oldest_focus_in_every_mode() {
    for mode in [CallMode::Legacy, CallMode::Compatibility, CallMode::Matrix2] {
        let discovered = discover_with_peers(mode, &PEERS, Some("https://own.example.org")).await;
        assert_eq!(
            discovered.own.foci,
            vec!["https://oldest.example.org"],
            "{mode:?}"
        );
    }
}

#[tokio::test]
async fn joining_a_call_without_a_focus_uses_the_configured_fallback() {
    for mode in [CallMode::Legacy, CallMode::Compatibility, CallMode::Matrix2] {
        let discovered = discover_with_peers(mode, &[], Some("https://own.example.org")).await;
        assert_eq!(discovered.own.foci, vec!["https://own.example.org"]);
    }
}

#[test]
fn mode_selection_preserves_legacy_and_selects_sticky_only_when_available() {
    assert!(matches!(
        select_mode(None, &[member(CallMode::Legacy, 1, &[])], true),
        Ok(CallMode::Legacy)
    ));
    assert!(matches!(
        select_mode(Some(CallMode::Matrix2), &[], false),
        Err(crate::protocol::RpcError::Unsupported)
    ));
    assert!(matches!(
        select_mode(None, &[member(CallMode::Matrix2, 1, &[])], true),
        Ok(CallMode::Matrix2)
    ));
}

#[test]
fn mode_reason_names_what_pinned_the_mode() {
    use crate::protocol::CallModeReason::{Fresh, LegacyPeer, Requested, StickyOnly, StickyPeer};
    let legacy = [member(CallMode::Legacy, 1, &[])];
    let sticky = [member(CallMode::Matrix2, 1, &[])];
    assert_eq!(mode_reason(None, true, &[], true), StickyOnly);
    assert_eq!(
        mode_reason(Some(CallMode::Legacy), false, &legacy, true),
        Requested
    );
    assert_eq!(mode_reason(None, false, &legacy, true), LegacyPeer);
    assert_eq!(mode_reason(None, false, &sticky, true), StickyPeer);
    assert_eq!(mode_reason(None, false, &sticky, false), Fresh);
    assert_eq!(mode_reason(None, false, &[], true), Fresh);
}
