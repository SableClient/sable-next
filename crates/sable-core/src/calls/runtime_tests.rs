use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
};

use base64::Engine as _;
use matrix_sdk::{
    ruma::{device_id, event_id, owned_device_id, owned_room_id, owned_user_id, room_id},
    test_utils::mocks::MatrixMockServer,
};
use matrix_sdk_ui::sync_service::SyncService;
use tokio::sync::Mutex;

use super::{
    CallMember, CallMode, CallSessionId, Core, Refreshed, State, backend_id, member_service,
    own_is_present, refresh,
};
use crate::SignedIn;
use crate::{protocol::CallBackendView, session::Session, store::MemorySessionStore};

pub(in crate::calls) fn member(mode: CallMode, created_ts: u64, foci: &[&str]) -> CallMember {
    CallMember {
        user_id: owned_user_id!("@user:example.org"),
        device_id: Some(device_id!("DEVICE").to_owned()),
        member_id: None,
        identity: "@user:example.org:DEVICE".to_owned(),
        mode,
        created_ts,
        joined_ts: created_ts,
        expires_at_ms: None,
        foci: foci.iter().map(ToString::to_string).collect(),
        screen_sharing: false,
        wire: super::membership::RtcWire::Deployed,
        focus_servers: HashMap::default(),
    }
}

const GET_TOKEN: &str = "/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token";

fn token(sub: &str, room: &str) -> String {
    let claims = serde_json::json!({"sub": sub, "video": {"room": room}});
    format!(
        "x.{}.x",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

async fn provision_backend(
    room: &matrix_sdk::Room,
    state: &parking_lot::Mutex<State>,
    own: &CallMember,
    backend: (String, String, Option<ruma::OwnedServerName>),
) {
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    super::provision_missing(&core, 1, CallSessionId(1), room, state, own, vec![backend]).await;
}

#[tokio::test]
async fn encrypted_media_key_reaches_another_sable_call_member() {
    let server = MatrixMockServer::new().await;
    server.mock_crypto_endpoints_preset().await;
    let (alice, bob) = server.set_up_alice_and_bob_for_encryption().await;
    let room_id = owned_room_id!("!call:example.org");
    let room = server.sync_joined_room(&alice, &room_id).await;
    let mut sender = member(CallMode::Compatibility, 1, &["https://sfu.example.org"]);
    sender.user_id = alice.user_id().unwrap().to_owned();
    sender.device_id = Some(alice.device_id().unwrap().to_owned());
    sender.member_id = Some("alice-member".to_owned());
    sender.identity = "alice-livekit-identity".to_owned();
    let mut receiver = member(CallMode::Matrix2, 1, &["https://sfu.example.org"]);
    receiver.user_id = bob.user_id().unwrap().to_owned();
    receiver.device_id = Some(bob.device_id().unwrap().to_owned());
    receiver.member_id = Some("bob-member".to_owned());
    let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let state = Arc::new(parking_lot::Mutex::new(State::new(
        receiver.clone(),
        vec![sender.clone(), receiver.clone()],
        super::StickyMemberships::default(),
        &room_id,
        false,
        None,
        false,
    )));
    let _guards = super::watch_keys(&core, &bob, 1, CallSessionId(1), room_id.clone(), state);
    let synced = server
        .mock_capture_put_to_device_then_sync_back(alice.user_id().unwrap(), &bob)
        .await;
    let mut distributor = super::keys::KeyDistributor::new(
        room_id,
        sender.user_id.clone(),
        sender.device_id.clone().unwrap(),
        sender.member_id.clone().unwrap(),
        sender.identity.clone(),
    );
    assert!(matches!(
        distributor.roll(&room, &[receiver]).await,
        super::keys::Rolled::Rotated { .. }
    ));
    synced.await;
    assert!(
        matches!(events.try_recv(), Ok(crate::protocol::CoreEvent::CallEncryptionKey { identity, own: false, .. }) if identity == sender.identity)
    );
}

#[tokio::test]
async fn joining_an_unsupported_slot_does_not_publish_membership() {
    use matrix_sdk::ruma::{events::AnySyncStateEvent, serde::Raw};
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path_regex},
    };

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!call:example.org");
    let power = json!({
        "type": "m.room.power_levels", "state_key": "", "event_id": "$power",
        "sender": client.user_id().unwrap(), "origin_server_ts": 1,
        "content": {"users_default": 100, "state_default": 50}
    });
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_state_event(
                Raw::new(&power)
                    .unwrap()
                    .cast_unchecked::<AnySyncStateEvent>(),
            ),
        )
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/state/org\.matrix\.msc4143\.rtc\.slot/.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "status": "open", "application": {"type": "m.call"},
            "encryption": {"type": "example.unsupported"}
        })))
        .mount(server.server())
        .await;

    let session = crate::test_support::session_for(&server, room.client()).await;
    let mut own = member(CallMode::Matrix2, 1, &[]);
    own.user_id = client.user_id().unwrap().to_owned();
    own.device_id = Some(client.device_id().unwrap().to_owned());
    own.member_id = Some("member".to_owned());
    assert!(
        super::publish(&session, &room, &own, "https://sfu.example.org", true, None)
            .await
            .is_err()
    );
    let requests = server.received_requests().await.unwrap();
    assert!(
        !requests
            .iter()
            .any(|request| request.method.as_str() == "PUT"
                && (request.url.path().contains("/send/")
                    || request.url.path().contains("/state/")))
    );
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
    oldest.device_id = Some(device_id!("PEER").to_owned());
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
#[expect(
    clippy::too_many_lines,
    reason = "one sequential flow kept in a single function"
)]
async fn pending_key_with_a_custom_membership_id_is_emitted() {
    use matrix_sdk::ruma::{events::AnySyncStateEvent, serde::Raw};
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let parsed_room_id = room_id!("!call:example.org");
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
            media_key: None,
            keys: Some(super::keys::KeyPayload {
                index,
                key: base64::engine::general_purpose::STANDARD.encode([index; 16]),
            }),
            room_id: room_id.clone(),
            member_id: None,
            member: Some(super::keys::MemberRef {
                claimed_device_id: "DEVICE".to_owned(),
                id: id.map(str::to_owned),
            }),
            session: super::keys::SessionRef::default(),
            sent_ts: Some(1),
        },
        received: crate::now_ms(),
        reported: false,
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
    let now = crate::now_ms();
    let event = json!({
        "type": "org.matrix.msc3401.call.member",
        "state_key": "_@peer:remote.example.org_PEERDEVICE_m.call",
        "sender": "@peer:remote.example.org", "event_id": "$peer",
        "origin_server_ts": now - 5_000,
        "content": {
            "application": "m.call", "call_id": "", "scope": "m.room",
            "device_id": "PEERDEVICE", "membershipID": "@peer:remote.example.org:PEERDEVICE",
            "created_ts": now - 5_000, "expires": 14_400_000, "m.call.intent": "video",
            "focus_active": {"type":"livekit", "focus_selection":"oldest_membership"},
            "foci_preferred": [{"type":"livekit", "livekit_service_url":"https://sfu.remote.example.org", "livekit_alias":parsed_room_id}]
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
        "member": {"claimed_device_id": "PEERDEVICE", "id": "@peer:remote.example.org:PEERDEVICE"},
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
        backend_aliases: BTreeMap::new(),
        latest_keys: HashMap::new(),
        member_first_seen: HashMap::new(),
        silent_reported: HashSet::new(),
        rotation_due_ms: None,
        pending_keys: vec![super::PendingKey {
            sender: owned_user_id!("@peer:remote.example.org"),
            device: owned_device_id!("PEERDEVICE"),
            content,
            received: now,
            reported: false,
        }],
        distributor: None,
        own_observed: false,
        revision: 0,
        intent: None,
        slot_closed: false,
        slot_closed_midcall: false,
        slot_checked_ms: 0,
        publisher_attempt_ms: 0,
    };

    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);

    let expected = backend_id(&room_id, "https://sfu.remote.example.org");
    assert!(matches!(
        events.try_recv(),
        Ok(crate::protocol::CoreEvent::CallEncryptionKey { identity, key_index: 1, own: false, backend_id: Some(id), .. })
            if identity == "@peer:remote.example.org:PEERDEVICE" && id == expected
    ));
    assert!(state.pending_keys.is_empty());
}

#[tokio::test]
async fn a_key_whose_member_has_not_resolved_waits_for_the_roster() {
    use serde_json::json;

    let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let room_id = owned_room_id!("!call:example.org");
    let content: super::keys::ToDeviceCallEncryptionKeysEventContent =
        serde_json::from_value(json!({
            "keys": {"index": 1, "key": "ag8zYq5ohmf0xrnZrzJ2Bw=="},
            "room_id": room_id,
            "member": {"claimed_device_id": "DEVICE"},
            "session": {"call_id": "", "application": "m.call", "scope": "m.room"},
            "sent_ts": 1
        }))
        .unwrap();
    let mut state = State::new(
        member(CallMode::Compatibility, 1, &[]),
        Vec::new(),
        super::StickyMemberships::default(),
        &room_id,
        false,
        None,
        false,
    );
    state.pending_keys = vec![super::PendingKey {
        sender: owned_user_id!("@user:example.org"),
        device: owned_device_id!("DEVICE"),
        content,
        received: crate::now_ms() - super::UNRESOLVED_KEY_REPORT_MS,
        reported: false,
    }];

    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);

    assert_eq!(state.pending_keys.len(), 1);
    assert!(state.pending_keys[0].reported);
    assert_eq!(
        super::unresolved_reason(&state.pending_keys[0], &state.members),
        "no membership for the sending device"
    );
    assert_eq!(
        events.try_recv().unwrap_err(),
        tokio::sync::mpsc::error::TryRecvError::Empty
    );
}

#[tokio::test]
async fn an_element_call_focus_without_an_alias_still_counts() {
    use matrix_sdk::ruma::{events::AnySyncStateEvent, serde::Raw};
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let parsed_room_id = room_id!("!call:example.org");
    let now = crate::now_ms();
    let event = json!({
        "type": "org.matrix.msc3401.call.member",
        "state_key": "_@peer:remote.example.org_PEERDEVICE_m.call",
        "sender": "@peer:remote.example.org", "event_id": "$peer",
        "origin_server_ts": now - 5_000,
        "content": {
            "application": "m.call", "call_id": "", "scope": "m.room",
            "device_id": "PEERDEVICE", "membershipID": "@peer:remote.example.org:PEERDEVICE",
            "created_ts": now - 5_000, "expires": 14_400_000, "m.call.intent": "video",
            "focus_active": {"type":"livekit", "focus_selection":"oldest_membership"},
            "foci_preferred": [{"type":"livekit", "livekit_service_url":"https://sfu.remote.example.org"}]
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
        vec!["https://sfu.remote.example.org".to_owned()]
    );
}

async fn refresh_fixture(
    created_ts: u64,
    observed: bool,
) -> (
    SignedIn,
    tokio::sync::mpsc::UnboundedReceiver<crate::protocol::CoreEvent>,
    matrix_sdk::Room,
    parking_lot::Mutex<State>,
) {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = owned_room_id!("!call:example.org");
    server.sync_joined_room(&client, &room_id).await;
    let room = client.get_room(&room_id).unwrap();
    let (core, events) = crate::test_support::signed_in_core(&server, client).await;
    let session = core.signed_in().unwrap();
    let mut own = member(
        CallMode::Compatibility,
        created_ts,
        &["https://focus.example.org"],
    );
    own.user_id = session.client().user_id().unwrap().to_owned();
    own.device_id = Some(session.client().device_id().unwrap().to_owned());
    own.identity = format!("{}:{}", own.user_id, own.own_device_id());
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
        session,
        events,
        room,
        parking_lot::Mutex::new(State {
            own,
            sticky: super::StickyMemberships::default(),
            members: Vec::new(),
            emitted_members: None,
            backends,
            backend_aliases: BTreeMap::new(),
            pending_keys: Vec::new(),
            latest_keys: HashMap::new(),
            member_first_seen: HashMap::new(),
            silent_reported: HashSet::new(),
            rotation_due_ms: None,
            distributor: None,
            own_observed: observed,
            revision: 0,
            intent: None,
            slot_closed: false,
            slot_closed_midcall: false,
            slot_checked_ms: 0,
            publisher_attempt_ms: 0,
        }),
    )
}

#[tokio::test]
async fn refresh_rejoins_when_an_observed_membership_disappears() {
    let (core, _events, room, state) = refresh_fixture(crate::now_ms(), true).await;
    assert_eq!(
        refresh(&core, 0, CallSessionId(1), &room, &state).await,
        Refreshed::Absent
    );
}

#[tokio::test]
async fn sdk_redaction_removes_sticky_membership_and_wakes_the_call() {
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = server
        .sync_joined_room(&client, room_id!("!call:example.org"))
        .await;
    let state = Arc::new(parking_lot::Mutex::new(State::new(
        member(CallMode::Matrix2, 100, &[]),
        Vec::new(),
        super::StickyMemberships::default(),
        &room.room_id().to_owned(),
        false,
        None,
        false,
    )));
    let event = json!({
        "type":"m.rtc.member", "event_id":"$member", "sender":"@user:example.org",
        "origin_server_ts":100, "sticky":{"duration_ms":60000},
        "content":{"sticky_key":"member", "slot_id":"m.call#room", "application":{"type":"m.call"},
            "member":{"id":"member", "membership":"join"}}
    });
    assert!(state.lock().sticky.apply(&event, 100));
    let wake = Arc::new(tokio::sync::Notify::new());
    let _guard = super::watch_redactions(
        &client,
        &room.room_id().to_owned(),
        state.clone(),
        wake.clone(),
    );
    server.sync_room(&client, JoinedRoomBuilder::new(room.room_id()).add_timeline_event(
        Raw::new(&json!({
            "type":"m.room.redaction", "event_id":"$redaction", "sender":"@moderator:example.org",
            "origin_server_ts":200, "redacts":"$member", "content":{"redacts":"$member"}
        })).unwrap().cast_unchecked::<ruma::events::AnySyncTimelineEvent>()
    )).await;
    tokio::time::timeout(std::time::Duration::from_secs(1), wake.notified())
        .await
        .unwrap();
    assert_eq!(state.lock().sticky.members(200), Vec::<CallMember>::new());
}

#[tokio::test]
async fn refresh_allows_a_recent_unobserved_membership() {
    let (core, _events, room, state) = refresh_fixture(crate::now_ms(), false).await;
    assert_eq!(
        refresh(&core, 0, CallSessionId(1), &room, &state).await,
        Refreshed::Current
    );
}

#[tokio::test]
async fn an_unchanged_roster_is_emitted_once() {
    let (core, mut events, room, state) = refresh_fixture(crate::now_ms(), false).await;
    assert_eq!(
        refresh(&core, 1, CallSessionId(1), &room, &state).await,
        Refreshed::Current
    );
    assert_eq!(
        refresh(&core, 1, CallSessionId(1), &room, &state).await,
        Refreshed::Current
    );
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
        refresh_fixture(crate::now_ms().saturating_sub(30_001), false).await;
    assert_eq!(
        refresh(&core, 0, CallSessionId(1), &room, &state).await,
        Refreshed::Ended
    );
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
    crate::test_support::set_session(
        &core,
        Some(Session {
            account_id: "test".to_owned(),
            client: client.clone(),
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
            state: Arc::default(),
        }),
    );
    let session = core.signed_in().unwrap();
    let state_key = super::super::membership_state_key(
        client.user_id().unwrap(),
        client.device_id().unwrap(),
        "",
    );

    assert!(
        session
            .schedule_hangup(&owned_room_id!("!call:example.org"), &state_key)
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

async fn delayed_leave_fixture() -> (MatrixMockServer, SignedIn, matrix_sdk::Room) {
    let server = MatrixMockServer::new().await;
    server
        .mock_versions()
        .with_feature("org.matrix.msc4140", true)
        .ok()
        .mount()
        .await;
    server.mock_room_state_encryption().plain().mount().await;
    let client = server.client_builder().no_server_versions().build().await;
    let room = server
        .sync_joined_room(&client, room_id!("!call:example.org"))
        .await;
    let session = crate::test_support::session_for(&server, client).await;
    (server, session, room)
}

#[tokio::test]
async fn a_delayed_leave_the_server_already_sent_is_reported_gone() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let (server, session, _room) = delayed_leave_fixture().await;
    Mock::given(method("POST"))
        .and(path(
            "/_matrix/client/unstable/org.matrix.msc4140/delayed_events/fired",
        ))
        .respond_with(ResponseTemplate::new(404).set_body_json(
            serde_json::json!({"errcode": "M_NOT_FOUND", "error": "Delayed event not found"}),
        ))
        .mount(server.server())
        .await;

    assert_eq!(
        session.postpone_hangup("fired").await,
        super::super::Postponed::Gone
    );
}

#[tokio::test]
async fn renewal_checks_that_the_delayed_leave_is_still_pending() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let (server, session, _room) = delayed_leave_fixture().await;
    Mock::given(method("POST"))
        .and(path(
            "/_matrix/client/unstable/org.matrix.msc4140/delayed_events/fired",
        ))
        .respond_with(ResponseTemplate::new(404).set_body_json(
            serde_json::json!({"errcode": "M_NOT_FOUND", "error": "Delayed event not found"}),
        ))
        .expect(1)
        .mount(server.server())
        .await;
    let delay = Mutex::new(super::super::DelayState {
        id: Some("fired".to_owned()),
        active: true,
        lost: false,
    });
    assert_eq!(
        super::protect_membership_renewal(&session, &delay).await,
        super::super::Postponed::Gone
    );
    let delay = delay.lock().await;
    assert!(delay.lost);
    assert!(delay.id.is_none());
}

#[tokio::test]
async fn a_lost_delayed_leave_is_scheduled_again_once() {
    use wiremock::matchers::{method, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    let (server, session, room) = delayed_leave_fixture().await;
    Mock::given(method("PUT"))
        .and(path_regex(
            r"/rooms/.*/send/org\.matrix\.msc4143\.rtc\.member/.*",
        ))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"delay_id":"new"})),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let mut own = member(CallMode::Matrix2, 1, &[]);
    own.member_id = Some("member".to_owned());
    let delay = Mutex::new(super::super::DelayState {
        id: None,
        active: true,
        lost: true,
    });

    super::restore_hangup(&session, &room, &own, &delay).await;
    super::restore_hangup(&session, &room, &own, &delay).await;

    let delay = delay.lock().await;
    assert_eq!(delay.id.as_deref(), Some("new"));
    assert!(!delay.lost);
}

#[tokio::test]
async fn refreshing_a_delayed_leave_cancels_the_old_event_and_respects_hangup() {
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    let (server, session, room) = delayed_leave_fixture().await;
    Mock::given(method("POST"))
        .and(path(
            "/_matrix/client/unstable/org.matrix.msc4140/delayed_events/old",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("PUT"))
        .and(path_regex(
            r"/rooms/.*/send/org\.matrix\.msc4143\.rtc\.member/.*",
        ))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"delay_id":"new"})),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let mut own = member(CallMode::Matrix2, 1, &[]);
    own.member_id = Some("member".to_owned());
    let delay = super::super::DelayState::shared(Some("old".to_owned()));
    super::refresh_encrypted_hangup(session.clone(), room.clone(), own.clone(), delay.clone())
        .await;
    assert_eq!(delay.lock().await.id.as_deref(), Some("new"));
    delay.lock().await.active = false;
    super::refresh_encrypted_hangup(session, room, own, delay.clone()).await;
    assert_eq!(delay.lock().await.id.as_deref(), Some("new"));
}

#[tokio::test]
async fn a_screen_share_update_after_hangup_does_not_republish_the_membership() {
    use wiremock::matchers::{method, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    let (server, _session, room) = delayed_leave_fixture().await;
    Mock::given(method("PUT"))
        .and(path_regex(r"/rooms/.*/state/.*call\.member/.*"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"event_id":"$member"})),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let state = parking_lot::Mutex::new(State::new(
        member(CallMode::Legacy, 1, &["https://focus.example.org"]),
        Vec::new(),
        super::StickyMemberships::default(),
        &room.room_id().to_owned(),
        false,
        None,
        false,
    ));
    let delay = super::super::DelayState::shared(None);
    super::set_screen_sharing(&room, &state, &delay, true)
        .await
        .unwrap();
    delay.lock().await.active = false;
    super::set_screen_sharing(&room, &state, &delay, false)
        .await
        .unwrap();
}

async fn legacy_move_fixture(
    can_publish: bool,
) -> (
    MatrixMockServer,
    wiremock::MockServer,
    matrix_sdk::Room,
    CallMember,
    CallMember,
    parking_lot::Mutex<State>,
) {
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    let server = MatrixMockServer::new().await;
    server.mock_room_state_encryption().plain().mount().await;
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
    own.device_id = Some(client.device_id().unwrap().to_owned());
    own.identity = format!("{}:{}", own.user_id, own.own_device_id());
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
    let state = parking_lot::Mutex::new(State::new(
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
async fn rejoining_a_call_resumes_sync_after_a_background_leave() {
    use matrix_sdk_ui::sync_service::State as SyncState;
    use std::time::Duration;

    let (server, sfu, room, _, _, _) = legacy_move_fixture(true).await;
    server
        .mock_sliding_sync()
        .with_delay(Duration::from_secs(1))
        .ok_json(serde_json::json!({"pos": "p", "lists": {}, "rooms": {}}))
        .mount()
        .await;
    server
        .mock_room_send()
        .ok(event_id!("$invite"))
        .mount()
        .await;
    let client = room.client();
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    crate::test_support::set_session(
        &core,
        Some(Session {
            account_id: "test".to_owned(),
            client,
            sync_service: sync_service.clone(),
            homeserver: server.server().uri(),
            oauth: false,
            state: Arc::default(),
        }),
    );
    let session = core.signed_in().unwrap();
    core.apply_app_activity(true).await;
    let first = session
        .join_call(
            room.room_id().to_owned(),
            Some(sfu.uri()),
            Some(CallMode::Legacy),
            None,
        )
        .await
        .unwrap();

    core.set_app_active(false);
    core.apply_app_activity(false).await;
    session.leave_call(first.session).await.unwrap();
    assert!(matches!(sync_service.state().get(), SyncState::Idle));
    assert!(core.activity.sync_suspended());

    let second = session
        .join_call(
            room.room_id().to_owned(),
            Some(sfu.uri()),
            Some(CallMode::Legacy),
            None,
        )
        .await
        .unwrap();

    assert!(matches!(sync_service.state().get(), SyncState::Running));
    assert!(!core.activity.sync_suspended());
    assert!(!core.activity.app_active());

    core.update_network_conditions(false, true).await;
    sync_service.stop().await;
    core.update_network_conditions(true, true).await;
    assert!(matches!(sync_service.state().get(), SyncState::Running));

    session.leave_call(second.session).await.unwrap();
    assert!(matches!(sync_service.state().get(), SyncState::Idle));
}

async fn join_on_an_sfu_url_only_homeserver(
    subject: impl Fn(&ruma::UserId, &str) -> String,
) -> (
    MatrixMockServer,
    Arc<Core>,
    String,
    Result<crate::api::calls::JoinOk, crate::protocol::RpcError>,
) {
    use std::time::Duration;
    use wiremock::matchers::{body_partial_json, method, path, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    let (server, _sfu, room, _, _, _) = legacy_move_fixture(true).await;
    server
        .mock_sliding_sync()
        .with_delay(Duration::from_secs(1))
        .ok_json(serde_json::json!({"pos": "p", "lists": {}, "rooms": {}}))
        .mount()
        .await;
    server
        .mock_room_send()
        .ok(event_id!("$invite"))
        .mount()
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"/rtc/transports$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "rtc_transports": [{"type": "livekit", "url": "wss://sfu.example.org"}],
        })))
        .mount(server.server())
        .await;
    let client = room.client();
    let user_id = client.user_id().unwrap().to_owned();
    let member_id = format!("{user_id}:{}", client.device_id().unwrap());
    let jwt = token(&subject(&user_id, &member_id), "r");
    Mock::given(method("POST"))
        .and(path(GET_TOKEN))
        .and(body_partial_json(serde_json::json!({
            "url": "wss://sfu.example.org", "room_id": room.room_id(),
            "slot_id": "m.call#ROOM", "member_id": member_id,
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"jwt": jwt})))
        .expect(1)
        .mount(server.server())
        .await;
    let (core, _events) = crate::test_support::signed_in_core(&server, client).await;
    let session = core.signed_in().unwrap();
    let joined = session
        .join_call(
            room.room_id().to_owned(),
            None,
            Some(CallMode::Compatibility),
            None,
        )
        .await;
    (server, core, member_id, joined)
}

#[tokio::test]
async fn a_homeserver_with_only_an_sfu_url_is_joined_through_get_token() {
    let (server, core, member_id, joined) =
        join_on_an_sfu_url_only_homeserver(super::membership::stable_identity).await;
    let session = core.signed_in().unwrap();
    let joined = joined.unwrap();
    assert_eq!(joined.url, "wss://sfu.example.org");

    let membership = server
        .server()
        .received_requests()
        .await
        .unwrap()
        .into_iter()
        .filter(|request| {
            request.method.as_str() == "PUT"
                && request
                    .url
                    .path()
                    .contains("/state/org.matrix.msc3401.call.member/")
        })
        .map(|request| serde_json::from_slice::<serde_json::Value>(&request.body).unwrap())
        .find(|body| body.get("foci_preferred").is_some())
        .unwrap();
    assert_eq!(
        membership["foci_preferred"],
        serde_json::json!([{"type": "livekit", "url": "wss://sfu.example.org"}])
    );
    assert_eq!(membership["membershipID"], member_id.as_str());
    session.leave_call(joined.session).await.unwrap();
}

#[tokio::test]
async fn an_sfu_token_for_another_identity_aborts_the_join() {
    let (_server, _core, _member_id, joined) =
        join_on_an_sfu_url_only_homeserver(|_, _| "someone-else".to_owned()).await;
    let error = joined.unwrap_err();
    assert!(
        format!("{error:?}").contains("identity mismatch"),
        "{error:?}"
    );
}

#[tokio::test]
async fn a_legacy_publisher_follows_the_oldest_members_focus() {
    let (_homeserver, sfu, room, own, oldest, state) = legacy_move_fixture(true).await;

    let moved =
        super::follow_oldest_focus(&room, &state, own.clone(), &[oldest, own.clone()]).await;

    assert_eq!(moved.foci, vec![sfu.uri()]);
    let state = state.lock();
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
    let state = state.lock();
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
        let session = crate::test_support::session_for(&homeserver, room.client()).await;

        let (moved, provision) =
            super::publish_elsewhere(&session, &room, &own, Some(sfu.uri()), None)
                .await
                .unwrap_or_else(|| panic!("{mode:?} did not move"));

        assert_eq!(moved.mode, moved_mode, "{mode:?}");
        assert_eq!(moved.foci, vec![sfu.uri()], "{mode:?}");
        assert!(provision.can_publish, "{mode:?}");
        assert_eq!(provision.identity, own.identity, "{mode:?}");
    }
}

#[tokio::test]
async fn an_unusable_focus_is_not_advertised() {
    for mode in [CallMode::Legacy, CallMode::Compatibility, CallMode::Matrix2] {
        let (homeserver, sfu, room, mut own, _oldest, _state) = legacy_move_fixture(false).await;
        own.mode = mode;
        let session = crate::test_support::session_for(&homeserver, room.client()).await;

        assert!(
            super::publish_elsewhere(&session, &room, &own, Some(sfu.uri()), None)
                .await
                .is_none()
        );
        let requests = homeserver.server().received_requests().await.unwrap();
        assert!(
            !requests.iter().any(|request| {
                request.method == wiremock::http::Method::PUT
                    && (request.url.path().contains("/state/m.call.member/")
                        || request.url.path().contains("/send/"))
            }),
            "{mode:?}"
        );
    }
}

#[tokio::test]
async fn a_stable_focus_token_is_requested_from_the_homeserver() {
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, ResponseTemplate};

    let (homeserver, _sfu, room, _own, _oldest, _state) = legacy_move_fixture(true).await;
    let claims = serde_json::json!({"sub":"participant", "video":{"room":"room"}});
    let jwt = format!(
        "x.{}.x",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    Mock::given(method("POST"))
        .and(path(
            "/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token",
        ))
        .and(body_partial_json(serde_json::json!({
            "url":"wss://focus.example.org", "server_name":"remote.example.org",
            "room_id":room.room_id(), "slot_id":"m.call#room", "member_id":"member",
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"jwt":jwt})))
        .expect(1)
        .mount(homeserver.server())
        .await;
    let provision = super::sfu::provision_stable(
        &room,
        "wss://focus.example.org",
        Some(matrix_sdk::ruma::server_name!("remote.example.org")),
        "m.call#room",
        "member",
    )
    .await
    .unwrap();
    assert_eq!(provision.identity, "participant");
    assert_eq!(provision.url, "wss://focus.example.org");
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
        own.own_device_id(),
        own.member_id.as_deref().unwrap(),
        false,
    )
    .await
    .unwrap();

    assert_eq!(provisioned.identity, own.identity);
}

#[tokio::test]
async fn a_remote_focus_cannot_change_the_participant_identity() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let (_homeserver, _sfu, room, own, _oldest, state) = legacy_move_fixture(true).await;
    let claims = serde_json::json!({"sub": "different", "video": {"room": "r"}});
    let jwt = format!(
        "x.{}.x",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    let focus = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/sfu/get"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"url": "wss://remote.example.org", "jwt": jwt})),
        )
        .mount(&focus)
        .await;
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    super::provision_missing(
        &core,
        1,
        CallSessionId(1),
        &room,
        &state,
        &own,
        vec![("remote".to_owned(), focus.uri(), None)],
    )
    .await;
    assert!(!state.lock().backends.contains_key("remote"));
}

#[tokio::test]
async fn a_matrix2_token_comes_from_the_endpoint_that_grants_the_members_identity() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    for (older, endpoint) in [(false, "/sfu/get"), (true, "/get_token")] {
        let (_homeserver, _sfu, room, mut own, _oldest, _state) = legacy_move_fixture(true).await;
        own.mode = CallMode::Matrix2;
        own.member_id = Some("member".to_owned());
        if older {
            own.identity =
                super::membership::sticky_identity(&own.user_id, own.own_device_id(), "member");
        }
        let service = wiremock::MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(endpoint))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "url": "wss://sfu.example.org", "jwt": token(&own.identity, "r"),
            })))
            .mount(&service)
            .await;

        let provisioned = super::provision_focus(&room, &own, &service.uri(), None).await;

        assert_eq!(
            provisioned.map(|provisioned| provisioned.identity).ok(),
            Some(own.identity.clone()),
            "{endpoint}"
        );
    }
}

#[test]
fn legacy_mode_follows_only_jwt_services() {
    let first = member(CallMode::Legacy, 1, &["wss://sfu.example.org"]);
    let second = member(CallMode::Legacy, 2, &["wss://other.example.org"]);
    let third = member(CallMode::Legacy, 3, &["https://focus.example.org"]);
    let members = [first, second, third];
    for member in &members {
        assert_eq!(
            member_service(member, &members),
            member.foci.first().map(String::as_str)
        );
    }
}

#[tokio::test]
async fn an_sfu_focus_token_comes_from_the_homeserver_and_a_shared_room_is_not_joined_twice() {
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, ResponseTemplate};

    let (homeserver, _sfu, room, mut own, _oldest, state) = legacy_move_fixture(true).await;
    own.mode = CallMode::Compatibility;
    let member_id = own.member_id.clone().unwrap();
    let hashed = super::membership::stable_identity(&own.user_id, &member_id);
    Mock::given(method("POST"))
        .and(path(GET_TOKEN))
        .and(body_partial_json(serde_json::json!({
            "url": "wss://sfu.example.org", "server_name": "example.org",
            "room_id": room.room_id(), "slot_id": "m.call#ROOM", "member_id": member_id,
        })))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"jwt": token(&hashed, "shared")})),
        )
        .expect(2)
        .mount(homeserver.server())
        .await;
    let publisher = backend_id(&room.room_id().to_owned(), "https://old.example.org");
    state.lock().backends.insert(
        publisher.clone(),
        CallBackendView {
            id: publisher.clone(),
            url: "wss://sfu.example.org/".to_owned(),
            jwt: token(&own.identity, "shared"),
            identity: own.identity.clone(),
        },
    );
    let missing = |id: &str| {
        (
            id.to_owned(),
            "wss://sfu.example.org".to_owned(),
            Some(matrix_sdk::ruma::server_name!("example.org").to_owned()),
        )
    };

    provision_backend(&room, &state, &own, missing("element")).await;
    {
        let state = state.lock();
        assert!(!state.backends.contains_key("element"));
        assert_eq!(state.backend_aliases["element"], publisher);
    }

    state.lock().backends.get_mut(&publisher).unwrap().jwt = token(&own.identity, "elsewhere");
    provision_backend(&room, &state, &own, missing("other")).await;
    assert_eq!(state.lock().backends["other"].identity, hashed);
}

#[tokio::test]
async fn a_member_cannot_redirect_the_token_request_for_another_members_sfu() {
    let (_homeserver, _sfu, room, own, _oldest, _state) = legacy_move_fixture(true).await;
    let url = "wss://sfu.remote.example";
    let on_server = |user: ruma::OwnedUserId, server: ruma::OwnedServerName| CallMember {
        user_id: user,
        focus_servers: [(url.to_owned(), server)].into(),
        ..member(CallMode::Compatibility, 1, &[url])
    };
    let honest = on_server(
        owned_user_id!("@honest:remote.example"),
        ruma::server_name!("remote.example").to_owned(),
    );
    let other = on_server(
        owned_user_id!("@other:other.example"),
        ruma::server_name!("other.example").to_owned(),
    );

    let wanted = super::wanted_backends(&room, &[honest, other], &own);

    let servers: HashSet<_> = wanted
        .values()
        .filter(|(service, _)| service == url)
        .filter_map(|(_, server)| server.as_ref().map(ToString::to_string))
        .collect();
    assert_eq!(
        servers,
        HashSet::from(["remote.example".to_owned(), "other.example".to_owned()])
    );
}

#[tokio::test]
async fn a_focus_cannot_capture_another_members_backend() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    let (_homeserver, _sfu, room, own, _oldest, state) = legacy_move_fixture(true).await;
    let jwt = token(&own.identity, "r");
    let focus = wiremock::MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/sfu/get"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(serde_json::json!({"url": "wss://remote.example", "jwt": jwt})),
        )
        .mount(&focus)
        .await;
    state.lock().backends.insert(
        "another-member".to_owned(),
        CallBackendView {
            id: "another-member".to_owned(),
            url: "wss://remote.example".to_owned(),
            jwt: jwt.clone(),
            identity: own.identity.clone(),
        },
    );

    provision_backend(
        &room,
        &state,
        &own,
        ("honest".to_owned(), focus.uri(), None),
    )
    .await;

    let state = state.lock();
    assert!(state.backends.contains_key("honest"));
    assert!(state.backend_aliases.is_empty());
}

#[tokio::test]
async fn a_remote_sfu_is_joined_once_for_its_homeservers_url_and_service_members() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    for (service_first, service_user, joined) in [
        (true, "@service:remote.example", 1),
        (false, "@service:remote.example", 1),
        (true, "@service:stranger.example", 2),
        (false, "@service:stranger.example", 2),
    ] {
        let (homeserver, _sfu, room, mut own, _oldest, state) = legacy_move_fixture(true).await;
        own.mode = CallMode::Compatibility;
        let url = "wss://sfu.remote.example";
        let hashed =
            super::membership::stable_identity(&own.user_id, own.member_id.as_deref().unwrap());
        Mock::given(method("POST"))
            .and(path(GET_TOKEN))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"jwt": token(&hashed, "shared")})),
            )
            .mount(homeserver.server())
            .await;
        let service = wiremock::MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/sfu/get"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"url": url, "jwt": token(&own.identity, "shared")}),
            ))
            .mount(&service)
            .await;

        let remote = ruma::server_name!("remote.example").to_owned();
        let by_url = CallMember {
            user_id: owned_user_id!("@url:remote.example"),
            focus_servers: [(url.to_owned(), remote.clone())].into(),
            ..member(CallMode::Compatibility, 1, &[url])
        };
        let by_service = CallMember {
            user_id: service_user.try_into().unwrap(),
            ..member(CallMode::Compatibility, 2, &[&service.uri()])
        };
        let room_id = room.room_id().to_owned();
        let url_id = super::focus_backend_id(&room_id, &own, &by_url, url);
        let service_id = backend_id(&room_id, &service.uri());
        state.lock().members = vec![by_url, by_service];
        let mut missing = vec![
            (service_id, service.uri(), None),
            (url_id.clone(), url.to_owned(), Some(remote)),
        ];
        if !service_first {
            missing.reverse();
        }
        for backend in missing {
            provision_backend(&room, &state, &own, backend).await;
        }

        let state = state.lock();
        assert_eq!(
            state.backends.len(),
            joined,
            "{service_user} {service_first}"
        );
        assert!(state.backends.contains_key(&url_id));
    }
}

#[tokio::test]
async fn a_publisher_refused_on_the_calls_focus_moves_to_its_homeservers_sfu_url() {
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    let (homeserver, refusing, room, mut own, _oldest, _state) = legacy_move_fixture(false).await;
    own.mode = CallMode::Compatibility;
    own.foci = vec![refusing.uri()];
    let hashed =
        super::membership::stable_identity(&own.user_id, own.member_id.as_deref().unwrap());
    let jwt = token(&hashed, "r");
    Mock::given(method("GET"))
        .and(path_regex(r"/rtc/transports$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "rtc_transports": [{"type": "livekit", "url": "wss://own.example.org"}],
        })))
        .mount(homeserver.server())
        .await;
    Mock::given(method("POST"))
        .and(path(GET_TOKEN))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"jwt": jwt})))
        .mount(homeserver.server())
        .await;
    let session = crate::test_support::session_for(&homeserver, room.client()).await;
    let state = parking_lot::Mutex::new(State::new(
        own,
        Vec::new(),
        super::StickyMemberships::default(),
        &room.room_id().to_owned(),
        true,
        None,
        false,
    ));

    let (moved, published) = super::publish_where_allowed(&session, &room, &state, false, None)
        .await
        .unwrap();

    assert_eq!(moved.foci, ["wss://own.example.org"]);
    assert_eq!(moved.identity, hashed);
    assert!(published.provision.can_publish);
    let distributor = state.lock().distributor.clone().unwrap();
    assert_eq!(distributor.lock().await.identity(), hashed);
}

#[tokio::test]
async fn a_key_from_a_member_on_an_aliased_focus_names_the_connected_backend() {
    let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let room_id = owned_room_id!("!call:example.org");
    let mut element = member(CallMode::Compatibility, 1, &["wss://sfu.example.org"]);
    element.user_id = owned_user_id!("@element:example.org");
    element.member_id = Some("@element:example.org:DEVICE".to_owned());
    element.identity = "hashed".to_owned();
    let mut state = State::new(
        member(CallMode::Compatibility, 1, &["https://focus.example.org"]),
        vec![element],
        super::StickyMemberships::default(),
        &room_id,
        false,
        None,
        false,
    );
    let publisher = backend_id(&room_id, "https://focus.example.org");
    state.backend_aliases.insert(
        backend_id(&room_id, "wss://sfu.example.org"),
        publisher.clone(),
    );
    state.pending_keys.push(super::PendingKey {
        sender: owned_user_id!("@element:example.org"),
        device: owned_device_id!("DEVICE"),
        content: super::keys::ToDeviceCallEncryptionKeysEventContent {
            media_key: None,
            keys: Some(super::keys::KeyPayload {
                index: 0,
                key: base64::engine::general_purpose::STANDARD.encode([1; 16]),
            }),
            room_id: room_id.clone(),
            member_id: None,
            member: None,
            session: super::keys::SessionRef::default(),
            sent_ts: Some(1),
        },
        received: crate::now_ms(),
        reported: false,
    });

    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);

    assert!(matches!(
        events.try_recv(),
        Ok(crate::protocol::CoreEvent::CallEncryptionKey { identity, backend_id: Some(id), .. })
            if identity == "hashed" && id == publisher
    ));
}

#[tokio::test]
async fn a_key_without_a_sent_timestamp_is_accepted() {
    let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let room_id = owned_room_id!("!call:example.org");
    let content = serde_json::from_value(serde_json::json!({
        "room_id": room_id,
        "member_id": "member",
        "media_key": {
            "index": 4,
            "key": base64::engine::general_purpose::STANDARD.encode([7u8; 16])
        },
        "member": { "claimed_device_id": "DEVICE" }
    }))
    .unwrap();
    let mut state = State::new(
        member(CallMode::Compatibility, 1, &[]),
        vec![member(
            CallMode::Compatibility,
            1,
            &["https://sfu.example.org"],
        )],
        super::StickyMemberships::default(),
        &room_id,
        false,
        None,
        false,
    );
    state.pending_keys = vec![super::PendingKey {
        sender: owned_user_id!("@user:example.org"),
        device: owned_device_id!("DEVICE"),
        content,
        received: crate::now_ms(),
        reported: false,
    }];

    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);

    assert!(matches!(
        events.try_recv(),
        Ok(crate::protocol::CoreEvent::CallEncryptionKey { key_index: 4, .. })
    ));
}

#[test]
fn a_member_that_sends_no_key_is_reported_once_after_a_wait() {
    let room_id = owned_room_id!("!call:example.org");
    let mut peer = member(CallMode::Compatibility, 1, &["https://sfu.example.org"]);
    peer.user_id = owned_user_id!("@peer:example.org");
    peer.device_id = Some(owned_device_id!("PEER"));
    peer.identity = "@peer:example.org:PEER".to_owned();
    let mut state = State::new(
        member(CallMode::Compatibility, 1, &[]),
        vec![peer.clone()],
        super::StickyMemberships::default(),
        &room_id,
        true,
        None,
        false,
    );

    super::report_silent_members(&mut state, 1_000);
    assert!(state.silent_reported.is_empty(), "it only just arrived");

    super::report_silent_members(&mut state, 1_000 + super::SILENT_MEMBER_REPORT_MS);
    assert!(state.silent_reported.contains(&peer.identity));

    state.silent_reported.clear();
    state
        .latest_keys
        .insert((peer.identity, 0), (1, vec![0; 16]));
    super::report_silent_members(&mut state, 1_000 + 2 * super::SILENT_MEMBER_REPORT_MS);
    assert!(state.silent_reported.is_empty(), "its key arrived");
}

#[tokio::test]
async fn a_key_follows_a_member_that_moves_to_an_sfu_url() {
    let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let room_id = owned_room_id!("!call:example.org");
    let mut before = member(CallMode::Compatibility, 1, &["https://focus.example.org"]);
    before.user_id = owned_user_id!("@peer:example.org");
    before.identity = "@peer:example.org:DEVICE".to_owned();
    before.member_id = Some(before.identity.clone());
    let mut state = State::new(
        member(CallMode::Compatibility, 1, &[]),
        vec![before.clone()],
        super::StickyMemberships::default(),
        &room_id,
        false,
        None,
        false,
    );
    state
        .latest_keys
        .insert((before.identity.clone(), 2), (100, vec![7; 16]));
    let moved = CallMember {
        identity: "hashed".to_owned(),
        foci: vec!["wss://sfu.example.org".to_owned()],
        ..before
    };

    super::set_members(
        &core,
        1,
        CallSessionId(1),
        &room_id,
        &mut state,
        vec![moved],
    );

    assert!(matches!(
        events.try_recv(),
        Ok(crate::protocol::CoreEvent::CallEncryptionKey { identity, key_index: 2, key, own: false, .. })
            if identity == "hashed"
                && key == base64::engine::general_purpose::STANDARD.encode([7; 16])
    ));
}

#[tokio::test]
async fn a_key_sent_again_unchanged_is_not_applied_twice() {
    let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let room_id = owned_room_id!("!call:example.org");
    let pending = |sent_ts, fill: u8| super::PendingKey {
        sender: owned_user_id!("@user:example.org"),
        device: owned_device_id!("DEVICE"),
        content: super::keys::ToDeviceCallEncryptionKeysEventContent {
            media_key: Some(super::keys::KeyPayload {
                index: 3,
                key: base64::engine::general_purpose::STANDARD_NO_PAD.encode([fill; 16]),
            }),
            keys: None,
            room_id: room_id.clone(),
            member_id: None,
            member: None,
            session: super::keys::SessionRef::default(),
            sent_ts: Some(sent_ts),
        },
        received: crate::now_ms(),
        reported: false,
    };
    let mut state = State::new(
        member(CallMode::Compatibility, 1, &[]),
        vec![member(
            CallMode::Compatibility,
            1,
            &["https://sfu.example.org"],
        )],
        super::StickyMemberships::default(),
        &room_id,
        false,
        None,
        false,
    );

    state.pending_keys = vec![pending(100, 1)];
    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);
    assert!(matches!(
        events.try_recv(),
        Ok(crate::protocol::CoreEvent::CallEncryptionKey { .. })
    ));

    state.pending_keys = vec![pending(200, 1)];
    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);
    assert_eq!(
        events.try_recv().unwrap_err(),
        tokio::sync::mpsc::error::TryRecvError::Empty,
        "the same key at the same index changes nothing"
    );

    state.pending_keys = vec![pending(300, 2)];
    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);
    assert!(
        matches!(
            events.try_recv(),
            Ok(crate::protocol::CoreEvent::CallEncryptionKey { .. })
        ),
        "a different key at the same index is applied"
    );
}

#[tokio::test]
async fn a_key_older_than_one_already_emitted_for_the_same_index_is_dropped() {
    let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let room_id = owned_room_id!("!call:example.org");
    let pending = |sent_ts, fill: u8| super::PendingKey {
        sender: owned_user_id!("@user:example.org"),
        device: owned_device_id!("DEVICE"),
        content: super::keys::ToDeviceCallEncryptionKeysEventContent {
            media_key: None,
            keys: Some(super::keys::KeyPayload {
                index: 0,
                key: base64::engine::general_purpose::STANDARD.encode([fill; 16]),
            }),
            room_id: room_id.clone(),
            member_id: None,
            member: Some(super::keys::MemberRef {
                claimed_device_id: "DEVICE".to_owned(),
                id: None,
            }),
            session: super::keys::SessionRef::default(),
            sent_ts: Some(sent_ts),
        },
        received: crate::now_ms(),
        reported: false,
    };
    let mut state = State::new(
        member(CallMode::Compatibility, 1, &[]),
        vec![member(
            CallMode::Compatibility,
            1,
            &["https://sfu.example.org"],
        )],
        super::StickyMemberships::default(),
        &room_id,
        false,
        None,
        false,
    );

    state.pending_keys = vec![pending(200, 2), pending(100, 1)];
    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);

    let Ok(crate::protocol::CoreEvent::CallEncryptionKey { key, .. }) = events.try_recv() else {
        panic!("the newer key is emitted");
    };
    assert_eq!(
        key,
        base64::engine::general_purpose::STANDARD.encode([2u8; 16])
    );
    assert_eq!(
        events.try_recv().unwrap_err(),
        tokio::sync::mpsc::error::TryRecvError::Empty,
        "the older key for the same index is dropped"
    );

    state.pending_keys.push(pending(300, 3));
    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);
    assert!(matches!(
        events.try_recv(),
        Ok(crate::protocol::CoreEvent::CallEncryptionKey { .. })
    ));
}

#[tokio::test]
async fn a_jwt_service_from_any_source_is_preferred_to_an_sfu_url() {
    use serde_json::json;
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    let sfu = "wss://sfu.example.org";
    let listed = "https://listed.example.org";
    let well_known = "https://well-known.example.org";
    let configured = "https://configured.example.org";
    let url_only = json!({"type": "livekit", "url": sfu});
    let cases = [
        (
            "a later transport of the endpoint",
            json!([
                {"type": "m.livekit", "url": sfu},
                {"type": "livekit", "url": sfu, "livekit_service_url": listed},
            ]),
            Some(well_known),
            Some(configured),
            listed,
        ),
        (
            "the well-known",
            json!([url_only]),
            Some(well_known),
            Some(configured),
            well_known,
        ),
        (
            "the settings",
            json!([url_only]),
            None,
            Some(configured),
            configured,
        ),
        ("no JWT service", json!([url_only]), None, None, sfu),
    ];
    for (source, transports, announced, fallback, expected) in cases {
        let server = MatrixMockServer::new().await;
        Mock::given(method("GET"))
            .and(path_regex(r"/rtc/transports$"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"rtc_transports": transports})),
            )
            .mount(server.server())
            .await;
        let foci: Vec<_> = announced
            .iter()
            .map(|service| json!({"type": "livekit", "livekit_service_url": service}))
            .collect();
        Mock::given(method("GET"))
            .and(path("/.well-known/matrix/client"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "m.homeserver": {"base_url": server.server().uri()},
                "org.matrix.msc4143.rtc_foci": foci,
            })))
            .mount(server.server())
            .await;
        let client = server.client_builder().build().await;
        let room_id = owned_room_id!("!call:example.org");
        server.sync_joined_room(&client, &room_id).await;
        let room = client.get_room(&room_id).unwrap();
        let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();

        let focus = session
            .resolve_focus(&[], fallback.map(str::to_owned), &room)
            .await;

        assert_eq!(focus.as_deref(), Some(expected), "{source}");
    }
}

#[tokio::test]
async fn a_malformed_rtc_transport_does_not_hide_the_valid_ones() {
    use serde_json::json;
    use wiremock::matchers::{method, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    let server = MatrixMockServer::new().await;
    Mock::given(method("GET"))
        .and(path_regex(r"/rtc/transports$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "rtc_transports": [
                {"type": "m.livekit"},
                {"type": "m.livekit", "url": "wss://sfu.example.org"},
            ],
        })))
        .mount(server.server())
        .await;
    let client = server.client_builder().build().await;

    assert_eq!(
        crate::calls::stable_transports(&client).await,
        ["wss://sfu.example.org"]
    );
}

#[tokio::test]
async fn call_support_reuses_the_prefetched_well_known() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = owned_room_id!("!call:example.org");
    server.sync_joined_room(&client, &room_id).await;
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    crate::test_support::set_session(
        &core,
        Some(Session {
            account_id: "test".to_owned(),
            client: client.clone(),
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
            state: Arc::default(),
        }),
    );
    let session = core.signed_in().unwrap();
    let well_known_requests = || async {
        server
            .server()
            .received_requests()
            .await
            .unwrap()
            .iter()
            .filter(|request| request.url.path() == "/.well-known/matrix/client")
            .count()
    };

    let _ = client.well_known_rtc_transports().await;
    let prefetched = well_known_requests().await;
    session
        .call_support(crate::api::calls::SupportParams {
            room_id,
            livekit_service_url: None,
        })
        .await
        .unwrap();

    assert!(prefetched > 0);
    assert_eq!(well_known_requests().await, prefetched);
}
