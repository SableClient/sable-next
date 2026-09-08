use std::{collections::BTreeMap, sync::Arc};

use matrix_sdk::{
    ruma::{device_id, owned_room_id, owned_user_id},
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
