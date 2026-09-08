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
        expires_at_ms: None,
        foci: foci.iter().map(ToString::to_string).collect(),
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
    let compatibility = content(&"!room:example.org".try_into().unwrap(), &compatibility);
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
    let sticky = content(&"!room:example.org".try_into().unwrap(), &sticky);
    assert_eq!(sticky["slot_id"], "m.call#ROOM");
    assert_eq!(sticky["member"]["id"], "member");
    assert_eq!(sticky["transports"]["published"][0]["type"], "livekit");
}

#[test]
fn legacy_content_uses_the_room_call_shape_with_an_empty_call_id() {
    let legacy = content(
        &"!room:example.org".try_into().unwrap(),
        &member(CallMode::Legacy, 7, &["https://sfu.example.org"]),
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
    let mut state = State {
        own: member(CallMode::Compatibility, 1, &[]),
        sticky: super::StickyMemberships::default(),
        members,
        backends: BTreeMap::new(),
        pending_keys: vec![pending(3, Some("custom-membership"))],
        distributor: None,
        own_observed: false,
        revision: 0,
    };

    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);

    assert!(matches!(
        events.try_recv(),
        Ok(crate::protocol::CoreEvent::CallEncryptionKey { identity, key_index: 3, own: false, .. })
            if identity == "@user:example.org:DEVICE"
    ));
    assert!(state.pending_keys.is_empty());

    state
        .pending_keys
        .push(pending(4, Some("other-membership")));
    super::emit_pending(&core, 1, CallSessionId(1), &room_id, &mut state);
    assert_eq!(
        events.try_recv().unwrap_err(),
        tokio::sync::mpsc::error::TryRecvError::Empty
    );
    assert_eq!(state.pending_keys.len(), 1);

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

async fn refresh_fixture(
    created_ts: u64,
    observed: bool,
) -> (Arc<Core>, matrix_sdk::Room, Mutex<State>) {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = owned_room_id!("!call:example.org");
    server.sync_joined_room(&client, &room_id).await;
    let room = client.get_room(&room_id).unwrap();
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
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
        room,
        Mutex::new(State {
            own,
            sticky: super::StickyMemberships::default(),
            members: Vec::new(),
            backends,
            pending_keys: Vec::new(),
            distributor: None,
            own_observed: observed,
            revision: 0,
        }),
    )
}

#[tokio::test]
async fn refresh_stops_when_an_observed_membership_disappears() {
    let (core, room, state) = refresh_fixture(super::keys::now_ms(), true).await;
    assert!(!refresh(&core, 0, CallSessionId(1), &room, &state).await);
}

#[tokio::test]
async fn refresh_allows_a_recent_unobserved_membership() {
    let (core, room, state) = refresh_fixture(super::keys::now_ms(), false).await;
    assert!(refresh(&core, 0, CallSessionId(1), &room, &state).await);
}

#[tokio::test]
async fn refresh_stops_when_an_unobserved_membership_is_old() {
    let (core, room, state) =
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
