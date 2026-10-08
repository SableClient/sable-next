use std::{collections::BTreeMap, sync::Arc};

use base64::Engine as _;
use matrix_sdk::{
    ruma::{device_id, event_id, owned_device_id, owned_room_id, owned_user_id, room_id},
    test_utils::mocks::MatrixMockServer,
};
use matrix_sdk_ui::sync_service::SyncService;
use tokio::sync::Mutex;

use super::{
    CallMember, CallMode, CallSessionId, Core, State, backend_id, content, member_service,
    own_is_present, refresh, select_mode,
};
use crate::{protocol::CallBackendView, session::Session, store::MemorySessionStore};

fn member(mode: CallMode, created_ts: u64, foci: &[&str]) -> CallMember {
    CallMember {
        user_id: owned_user_id!("@user:example.org"),
        device_id: device_id!("DEVICE").to_owned(),
        member_id: None,
        identity: "@user:example.org:DEVICE".to_owned(),
        mode,
        created_ts,
        joined_ts: created_ts,
        expires_at_ms: None,
        foci: foci.iter().map(ToString::to_string).collect(),
        screen_sharing: false,
    }
}

async fn discover_with_peers(
    mode: CallMode,
    peers: &[(u64, &str)],
    configured: Option<&str>,
) -> super::Discovered {
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
    let now = super::keys::now_ms();
    let mut builder = JoinedRoomBuilder::new(&room_id);
    let mut sticky_events = Vec::new();
    for (age, service) in peers {
        let mut peer = member(mode, now - age, &[service]);
        peer.user_id = owned_user_id!("@peer:example.org");
        peer.device_id = format!("DEVICE{age}").into();
        peer.member_id = Some(format!("peer-{age}"));
        let mut event = json!({
            "type": if mode == CallMode::Matrix2 {
                super::membership::RTC_MEMBER_EVENT_TYPE
            } else {
                "org.matrix.msc3401.call.member"
            },
            "event_id": format!("$peer-{age}"), "sender": peer.user_id,
            "origin_server_ts": peer.created_ts,
            "content": super::content_at(&room_id, &peer, None, now),
        });
        if mode == CallMode::Matrix2 {
            event["msc4354_sticky"] = json!({"duration_ms": 3_600_000});
            sticky_events.push(event);
        } else {
            event["state_key"] = format!("_{}_{}_m.call", peer.user_id, peer.device_id).into();
            builder = builder.add_state_event(
                Raw::new(&event)
                    .unwrap()
                    .cast_unchecked::<AnySyncStateEvent>(),
            );
        }
    }
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
    let discovered = super::discover(
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
fn legacy_mode_uses_the_oldest_state_membership_focus() {
    let oldest = member(CallMode::Compatibility, 1, &["https://old.example.org"]);
    let later = member(CallMode::Legacy, 2, &["https://later.example.org"]);
    let compatibility = member(CallMode::Compatibility, 3, &["https://remote.example.org"]);
    let members = vec![later.clone(), compatibility.clone(), oldest];

    assert_eq!(
        member_service(&later, &members),
        Some("https://old.example.org")
    );
    assert_eq!(
        member_service(&compatibility, &members),
        Some("https://remote.example.org")
    );
}

#[test]
fn legacy_mode_skips_an_oldest_member_that_advertises_no_focus() {
    let mut oldest = member(CallMode::Legacy, 1, &[]);
    oldest.device_id = device_id!("PEER").to_owned();
    let own = member(CallMode::Legacy, 2, &["https://own.example.org"]);
    let members = vec![own.clone(), oldest.clone()];

    assert_eq!(
        member_service(&oldest, &members),
        Some("https://own.example.org")
    );
    assert_eq!(
        member_service(&own, &members),
        Some("https://own.example.org")
    );
    assert_eq!(member_service(&oldest, &[oldest.clone()]), None);
}

#[test]
fn mode_selection_preserves_legacy_and_selects_sticky_only_when_available() {
    assert!(matches!(
        select_mode(None, &[member(CallMode::Legacy, 1, &[])], true),
        Ok(CallMode::Legacy)
    ));
    assert!(matches!(
        select_mode(Some(CallMode::Matrix2), &[], false),
        Err(crate::protocol::CommandErr::Unsupported)
    ));
    assert!(matches!(
        select_mode(None, &[member(CallMode::Matrix2, 1, &[])], true),
        Ok(CallMode::Matrix2)
    ));
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
fn call_modes_serialize_to_the_protocol_values() {
    assert_eq!(serde_json::to_value(CallMode::Legacy).unwrap(), "legacy");
    assert_eq!(
        serde_json::to_value(CallMode::Compatibility).unwrap(),
        "compatibility"
    );
    assert_eq!(serde_json::to_value(CallMode::Matrix2).unwrap(), "matrix_2");
}

#[test]
fn own_liveness_requires_the_current_generation() {
    let mut own = member(CallMode::Matrix2, 1, &["https://sfu.example.org"]);
    own.member_id = Some("current".to_owned());
    own.identity = "current-identity".to_owned();
    let mut stale = own.clone();
    stale.member_id = Some("stale".to_owned());
    stale.identity = "stale-identity".to_owned();
    assert!(!own_is_present(&[stale], &own));

    let mut current = own.clone();
    current.identity = "different-grant-identity".to_owned();
    assert!(own_is_present(&[current], &own));
}

#[tokio::test]
async fn pending_key_with_a_custom_membership_id_is_emitted() {
    use matrix_sdk::ruma::{events::AnySyncStateEvent, serde::Raw};
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let parsed_room_id = room_id!("!call:example.org");
    let now = super::keys::now_ms();
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
            "foci_preferred": [{"type":"livekit", "livekit_service_url":"https://sfu.example.org", "livekit_alias":parsed_room_id}]
        }
    });
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(parsed_room_id).add_state_event(
                Raw::new(&event)
                    .unwrap()
                    .cast_unchecked::<AnySyncStateEvent>(),
            ),
        )
        .await;
    let members = super::membership::active_members(&room).await;
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].member_id.as_deref(), Some("custom-membership"));

    let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let room_id = owned_room_id!("!call:example.org");
    let pending = |index, id: Option<&str>| super::PendingKey {
        sender: owned_user_id!("@user:example.org"),
        device: owned_device_id!("DEVICE"),
        content: super::keys::ToDeviceCallEncryptionKeysEventContent {
            keys: super::keys::KeyPayload {
                index,
                key: base64::engine::general_purpose::STANDARD.encode([index; 16]),
            },
            room_id: room_id.clone(),
            member: super::keys::MemberRef {
                claimed_device_id: "DEVICE".to_owned(),
                id: id.map(str::to_owned),
            },
            session: super::keys::SessionRef::default(),
            sent_ts: 1,
        },
        received: super::keys::now_ms(),
    };
    let mut state = State::new(
        member(CallMode::Compatibility, 1, &[]),
        members,
        super::StickyMemberships::default(),
        &room_id,
        false,
        None,
        false,
    );
    state.pending_keys = vec![pending(3, Some("custom-membership"))];

    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);

    assert!(matches!(
        events.try_recv(),
        Ok(crate::protocol::CoreEvent::CallEncryptionKey { identity, key_index: 3, own: false, .. })
            if identity == "@user:example.org:DEVICE"
    ));
    assert!(state.pending_keys.is_empty());

    state.pending_keys.push(pending(4, Some("a-random-uuid")));
    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);
    assert!(
        matches!(
            events.try_recv(),
            Ok(crate::protocol::CoreEvent::CallEncryptionKey { key_index: 4, .. })
        ),
        "element call sends a random member id with a legacy membership id"
    );
    assert!(state.pending_keys.is_empty());

    state.pending_keys.push(pending(5, None));
    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);
    assert!(matches!(
        events.try_recv(),
        Ok(crate::protocol::CoreEvent::CallEncryptionKey {
            key_index: 5,
            own: false,
            ..
        })
    ));

    let mut sticky = member(CallMode::Matrix2, 1, &["https://sfu.example.org"]);
    sticky.member_id = Some("sticky-member".to_owned());
    state.members = vec![sticky];
    state.pending_keys.push(pending(6, None));
    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);
    assert_eq!(
        events.try_recv().unwrap_err(),
        tokio::sync::mpsc::error::TryRecvError::Empty
    );
}

#[tokio::test]
async fn an_element_call_peers_key_is_emitted_on_the_oldest_members_focus() {
    use matrix_sdk::ruma::{events::AnySyncStateEvent, serde::Raw};
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let parsed_room_id = room_id!("!call:example.org");
    let now = super::keys::now_ms();
    let event = json!({
        "type": "org.matrix.msc3401.call.member",
        "state_key": "_@genchu:federated.nexus_spDmuPm52O_m.call",
        "sender": "@genchu:federated.nexus", "event_id": "$peer",
        "origin_server_ts": now - 5_000,
        "content": {
            "application": "m.call", "call_id": "", "scope": "m.room",
            "device_id": "spDmuPm52O", "membershipID": "@genchu:federated.nexus:spDmuPm52O",
            "created_ts": now - 5_000, "expires": 14_400_000, "m.call.intent": "video",
            "focus_active": {"type":"livekit", "focus_selection":"oldest_membership"},
            "foci_preferred": [{"type":"livekit", "livekit_service_url":"https://sfu.federated.nexus", "livekit_alias":parsed_room_id}]
        }
    });
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(parsed_room_id).add_state_event(
                Raw::new(&event)
                    .unwrap()
                    .cast_unchecked::<AnySyncStateEvent>(),
            ),
        )
        .await;
    let mut members = super::membership::active_members(&room).await;
    assert_eq!(members.len(), 1);
    members.push(member(
        CallMode::Compatibility,
        now,
        &["https://sfu.example.org"],
    ));

    let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let room_id = owned_room_id!("!call:example.org");
    let content: super::keys::ToDeviceCallEncryptionKeysEventContent = serde_json::from_value(json!({
        "keys": {"index": 1, "key": "ag8zYq5ohmf0xrnZrzJ2Bw=="},
        "room_id": room_id,
        "member": {"claimed_device_id": "spDmuPm52O", "id": "@genchu:federated.nexus:spDmuPm52O"},
        "session": {"call_id": "", "application": "m.call", "scope": "m.room"},
        "sent_ts": now
    }))
    .unwrap();
    let mut state = State {
        own: member(CallMode::Compatibility, now, &["https://sfu.example.org"]),
        sticky: super::StickyMemberships::default(),
        members,
        emitted_members: None,
        backends: BTreeMap::new(),
        pending_keys: vec![super::PendingKey {
            sender: owned_user_id!("@genchu:federated.nexus"),
            device: owned_device_id!("spDmuPm52O"),
            content,
            received: now,
        }],
        distributor: None,
        own_observed: false,
        revision: 0,
        intent: None,
        slot_closed: false,
        slot_checked_ms: 0,
        publisher_attempt_ms: 0,
    };

    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);

    let expected = backend_id(&room_id, "https://sfu.federated.nexus");
    assert!(matches!(
        events.try_recv(),
        Ok(crate::protocol::CoreEvent::CallEncryptionKey { identity, key_index: 1, own: false, backend_id: Some(id), .. })
            if identity == "@genchu:federated.nexus:spDmuPm52O" && id == expected
    ));
    assert!(state.pending_keys.is_empty());
}

#[tokio::test]
async fn an_element_call_focus_without_an_alias_still_counts() {
    use matrix_sdk::ruma::{events::AnySyncStateEvent, serde::Raw};
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let parsed_room_id = room_id!("!call:example.org");
    let now = super::keys::now_ms();
    let event = json!({
        "type": "org.matrix.msc3401.call.member",
        "state_key": "_@genchu:federated.nexus_spDmuPm52O_m.call",
        "sender": "@genchu:federated.nexus", "event_id": "$peer",
        "origin_server_ts": now - 5_000,
        "content": {
            "application": "m.call", "call_id": "", "scope": "m.room",
            "device_id": "spDmuPm52O", "membershipID": "@genchu:federated.nexus:spDmuPm52O",
            "created_ts": now - 5_000, "expires": 14_400_000, "m.call.intent": "video",
            "focus_active": {"type":"livekit", "focus_selection":"oldest_membership"},
            "foci_preferred": [{"type":"livekit", "livekit_service_url":"https://sfu.federated.nexus"}]
        }
    });
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(parsed_room_id).add_state_event(
                Raw::new(&event)
                    .unwrap()
                    .cast_unchecked::<AnySyncStateEvent>(),
            ),
        )
        .await;
    let members = super::membership::active_members(&room).await;
    assert_eq!(members.len(), 1);
    assert_eq!(
        members[0].foci,
        vec!["https://sfu.federated.nexus".to_owned()]
    );
}

async fn refresh_fixture(
    created_ts: u64,
    observed: bool,
) -> (
    Arc<Core>,
    tokio::sync::mpsc::UnboundedReceiver<crate::protocol::CoreEvent>,
    matrix_sdk::Room,
    Mutex<State>,
) {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = owned_room_id!("!call:example.org");
    server.sync_joined_room(&client, &room_id).await;
    let room = client.get_room(&room_id).unwrap();
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client,
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });
    let mut own = member(
        CallMode::Compatibility,
        created_ts,
        &["https://focus.example.org"],
    );
    own.user_id = core
        .session
        .read()
        .await
        .as_ref()
        .unwrap()
        .client
        .user_id()
        .unwrap()
        .to_owned();
    own.device_id = core
        .session
        .read()
        .await
        .as_ref()
        .unwrap()
        .client
        .device_id()
        .unwrap()
        .to_owned();
    own.identity = format!("{}:{}", own.user_id, own.device_id);
    let id = backend_id(&room_id, "https://focus.example.org");
    let mut backends = BTreeMap::new();
    backends.insert(
        id.clone(),
        CallBackendView {
            id,
            url: "wss://focus.example.org".to_owned(),
            jwt: "token".to_owned(),
            identity: own.identity.clone(),
        },
    );
    (
        core,
        events,
        room,
        Mutex::new(State {
            own,
            sticky: super::StickyMemberships::default(),
            members: Vec::new(),
            emitted_members: None,
            backends,
            pending_keys: Vec::new(),
            distributor: None,
            own_observed: observed,
            revision: 0,
            intent: None,
            slot_closed: false,
            slot_checked_ms: 0,
            publisher_attempt_ms: 0,
        }),
    )
}

#[tokio::test]
async fn refresh_stops_when_an_observed_membership_disappears() {
    let (core, _events, room, state) = refresh_fixture(super::keys::now_ms(), true).await;
    assert!(!refresh(&core, 0, CallSessionId(1), &room, &state).await);
}

#[tokio::test]
async fn refresh_allows_a_recent_unobserved_membership() {
    let (core, _events, room, state) = refresh_fixture(super::keys::now_ms(), false).await;
    assert!(refresh(&core, 0, CallSessionId(1), &room, &state).await);
}

#[tokio::test]
async fn an_unchanged_roster_is_emitted_once() {
    let (core, mut events, room, state) = refresh_fixture(super::keys::now_ms(), false).await;
    assert!(refresh(&core, 1, CallSessionId(1), &room, &state).await);
    assert!(refresh(&core, 1, CallSessionId(1), &room, &state).await);
    let mut rosters = 0;
    while let Ok(event) = events.try_recv() {
        if matches!(event, crate::protocol::CoreEvent::CallMembers { .. }) {
            rosters += 1;
        }
    }
    assert_eq!(rosters, 1);
}

#[tokio::test]
async fn refresh_stops_when_an_unobserved_membership_is_old() {
    let (core, _events, room, state) =
        refresh_fixture(super::keys::now_ms().saturating_sub(30_001), false).await;
    assert!(!refresh(&core, 0, CallSessionId(1), &room, &state).await);
}

#[tokio::test]
async fn schedule_hangup_does_not_write_when_delayed_events_are_unsupported() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    server
        .mock_room_send_state()
        .ok(event_id!("$left"))
        .mount()
        .await;
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        client: client.clone(),
        sync_service,
        homeserver: server.server().uri(),
        oauth: false,
    });
    let state_key = super::super::membership_state_key(
        client.user_id().unwrap(),
        client.device_id().unwrap(),
        "",
    );

    assert!(
        core.schedule_hangup(&owned_room_id!("!call:example.org"), &state_key)
            .await
            .is_none()
    );

    let requests = server.server().received_requests().await.unwrap();
    assert!(!requests.iter().any(|request| {
        request
            .url
            .query_pairs()
            .any(|(key, _)| key == "org.matrix.msc4140.delay")
    }));
}

#[test]
fn renewal_extends_membership_beyond_four_hours_without_changing_session_identity() {
    let created = 1_000;
    let now = created + 5 * 60 * 60 * 1000;
    for mode in [CallMode::Legacy, CallMode::Compatibility] {
        let member = member(mode, created, &["https://sfu.example.org"]);
        let body = super::content_at(&owned_room_id!("!room:example.org"), &member, None, now);
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
        let quiet = content(&room_id, &own, None);
        assert!(quiet.get("org.sable.screen_sharing").is_none());

        own.screen_sharing = true;
        let sharing = content(&room_id, &own, None);
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
    let body = super::content_at(&room_id, &own, None, 9_000);
    assert_eq!(body["created_ts"], 4_000);
    assert_eq!(body["org.sable.screen_sharing"], true);
}

async fn legacy_move_fixture(
    can_publish: bool,
) -> (
    MatrixMockServer,
    wiremock::MockServer,
    matrix_sdk::Room,
    CallMember,
    CallMember,
    Mutex<State>,
) {
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .on_builder(|builder| builder.disable_well_known_lookup(true))
        .build()
        .await;
    let room_id = owned_room_id!("!call:example.org");
    server.sync_joined_room(&client, &room_id).await;
    let room = client.get_room(&room_id).unwrap();
    server
        .mock_room_send_state()
        .ok(event_id!("$moved"))
        .mount()
        .await;
    Mock::given(method("POST"))
        .and(path_regex(r"/openid/request_token$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "access_token": "openid", "token_type": "Bearer",
            "matrix_server_name": "example.org", "expires_in": 3600,
        })))
        .mount(server.server())
        .await;

    let mut own = member(CallMode::Legacy, 5, &["https://old.example.org"]);
    own.user_id = client.user_id().unwrap().to_owned();
    own.device_id = client.device_id().unwrap().to_owned();
    own.identity = format!("{}:{}", own.user_id, own.device_id);
    own.member_id = Some(own.identity.clone());

    let sfu = wiremock::MockServer::start().await;
    let claims = serde_json::json!({
        "sub": own.identity, "video": {"room": "r", "canPublish": can_publish},
    });
    let jwt = format!(
        "x.{}.x",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    Mock::given(method("POST"))
        .and(path("/sfu/get"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"url": "wss://oldest.example.org", "jwt": jwt})),
        )
        .mount(&sfu)
        .await;

    let oldest = CallMember {
        user_id: owned_user_id!("@oldest:example.org"),
        identity: "@oldest:example.org:DEVICE".to_owned(),
        ..member(CallMode::Legacy, 1, &[&sfu.uri()])
    };
    let state = Mutex::new(State::new(
        own.clone(),
        Vec::new(),
        super::StickyMemberships::default(),
        &room_id,
        false,
        None,
        false,
    ));
    (server, sfu, room, own, oldest, state)
}

#[tokio::test]
async fn a_legacy_publisher_follows_the_oldest_members_focus() {
    let (_homeserver, sfu, room, own, oldest, state) = legacy_move_fixture(true).await;

    let moved =
        super::follow_oldest_focus(&room, &state, own.clone(), &[oldest, own.clone()]).await;

    assert_eq!(moved.foci, vec![sfu.uri()]);
    let state = state.lock().await;
    assert_eq!(state.own.foci, vec![sfu.uri()]);
    let backend = &state.backends[&backend_id(&room.room_id().to_owned(), &sfu.uri())];
    assert_eq!(backend.url, "wss://oldest.example.org");
    assert_eq!(backend.identity, own.identity);
}

#[tokio::test]
async fn a_legacy_publisher_stays_put_when_the_oldest_focus_will_not_let_it_publish() {
    let (_homeserver, _sfu, room, own, oldest, state) = legacy_move_fixture(false).await;

    let kept = super::follow_oldest_focus(&room, &state, own.clone(), &[oldest, own.clone()]).await;

    assert_eq!(kept.foci, own.foci);
    let state = state.lock().await;
    assert_eq!(state.own.foci, own.foci);
    assert!(state.backends.is_empty());
}

#[tokio::test]
async fn a_publisher_refused_on_the_calls_focus_moves_to_its_own_in_every_mode() {
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    for (mode, moved_mode) in [
        (CallMode::Legacy, CallMode::Compatibility),
        (CallMode::Compatibility, CallMode::Compatibility),
        (CallMode::Matrix2, CallMode::Matrix2),
    ] {
        let (homeserver, sfu, room, mut own, _oldest, _state) = legacy_move_fixture(true).await;
        own.mode = mode;
        let claims = serde_json::json!({
            "sub": own.identity, "video": {"room": "r", "canPublish": true},
        });
        let jwt = format!(
            "x.{}.x",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        Mock::given(method("POST"))
            .and(path("/get_token"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"url": "wss://own.example.org", "jwt": jwt})),
            )
            .mount(&sfu)
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(r"/rooms/.*/send/"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"event_id": "$moved"})),
            )
            .mount(homeserver.server())
            .await;
        let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));

        let (moved, provision) =
            super::publish_elsewhere(&core, &room, &own, Some(sfu.uri()), None)
                .await
                .unwrap_or_else(|| panic!("{mode:?} did not move"));

        assert_eq!(moved.mode, moved_mode, "{mode:?}");
        assert_eq!(moved.foci, vec![sfu.uri()], "{mode:?}");
        assert!(provision.can_publish, "{mode:?}");
        assert_eq!(provision.identity, own.identity, "{mode:?}");
    }
}

#[tokio::test]
async fn a_legacy_call_subscribes_to_another_focus_under_its_publishing_identity() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let (_homeserver, _sfu, room, own, _oldest, _state) = legacy_move_fixture(true).await;
    let jwt = |sub: &str| {
        let claims = serde_json::json!({"sub": sub, "video": {"room": "r"}});
        format!(
            "x.{}.x",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string())
        )
    };
    let focus = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/sfu/get"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"url": "wss://remote.example.org", "jwt": jwt(&own.identity)}),
        ))
        .mount(&focus)
        .await;
    Mock::given(method("POST"))
        .and(path("/get_token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"url": "wss://remote.example.org", "jwt": jwt("hashed")}),
        ))
        .expect(0)
        .mount(&focus)
        .await;

    let provisioned = super::sfu::provision_remote(
        &room,
        &focus.uri(),
        &own.device_id,
        own.member_id.as_deref().unwrap(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(provisioned.identity, own.identity);
}
