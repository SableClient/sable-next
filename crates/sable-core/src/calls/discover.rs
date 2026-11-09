use std::time::Duration;

use matrix_sdk::Room;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::{
    DeviceId, OwnedDeviceId, OwnedServerName, OwnedUserId, TransactionId, UserId,
};

use super::membership::{self, CallMember, StickyMemberships};
use super::runtime::merge_sticky;
use super::{sfu, sticky};
use crate::Core;
use crate::protocol::{CallMode, CallModeReason, CallSessionId, RpcError};

fn select_mode(
    requested: Option<CallMode>,
    members: &[CallMember],
    sticky_available: bool,
) -> Result<CallMode, RpcError> {
    if let Some(mode) = requested {
        return if mode == CallMode::Matrix2 && !sticky_available {
            Err(RpcError::Unsupported)
        } else {
            Ok(mode)
        };
    }
    if members.iter().any(|member| member.mode == CallMode::Legacy) {
        return Ok(CallMode::Legacy);
    }
    if members
        .iter()
        .any(|member| member.mode == CallMode::Matrix2)
        && sticky_available
    {
        return Ok(CallMode::Matrix2);
    }
    Ok(CallMode::Compatibility)
}

fn mode_reason(
    requested: Option<CallMode>,
    forced_sticky: bool,
    members: &[CallMember],
    sticky_available: bool,
) -> CallModeReason {
    if forced_sticky {
        CallModeReason::StickyOnly
    } else if requested.is_some() {
        CallModeReason::Requested
    } else if members.iter().any(|member| member.mode == CallMode::Legacy) {
        CallModeReason::LegacyPeer
    } else if sticky_available
        && members
            .iter()
            .any(|member| member.mode == CallMode::Matrix2)
    {
        CallModeReason::StickyPeer
    } else {
        CallModeReason::Fresh
    }
}

async fn room_slot_closed(
    core: &Core,
    room: &Room,
    wire: membership::RtcWire,
) -> Result<bool, RpcError> {
    Ok(super::slot_closed(room, core.room_is_encrypted(room).await?, wire).await)
}

async fn sync_sticky(
    room: &Room,
    session: CallSessionId,
    encrypted: bool,
) -> (StickyMemberships, Option<sticky::StickySync>) {
    let mut sticky_members = StickyMemberships::default();
    let mut sticky_sync = None;
    let mut sync = sticky::StickySync::new(session.0);
    match sync.sync(room, Duration::ZERO).await {
        Ok(events) => {
            for event in events {
                event.apply(&mut sticky_members, encrypted, crate::now_ms());
            }
            sticky_sync = Some(sync);
        }
        Err(error) => {
            tracing::warn!(?error, "sticky call membership sync is unavailable");
        }
    }
    (sticky_members, sticky_sync)
}

fn select_wire(
    stable_supported: bool,
    sticky_candidates: &[CallMember],
    stable_services: &[String],
) -> membership::RtcWire {
    if stable_supported
        && (sticky_candidates
            .iter()
            .any(|member| member.wire == membership::RtcWire::Stable)
            || (!sticky_candidates
                .iter()
                .any(|member| member.wire == membership::RtcWire::Deployed)
                && !stable_services.is_empty()))
    {
        membership::RtcWire::Stable
    } else {
        membership::RtcWire::Deployed
    }
}

async fn resolve_service(
    core: &Core,
    room: &Room,
    members: &[CallMember],
    configured: Option<String>,
    stable_services: &[String],
    stable_matrix2: bool,
    wire: membership::RtcWire,
) -> Result<(String, Option<OwnedServerName>), RpcError> {
    if !stable_matrix2 {
        let url = core
            .resolve_focus(members, configured, room)
            .await
            .ok_or(RpcError::NoCallFocus)?;
        return Ok((url, None));
    }
    if let Some(url) = stable_services.first() {
        return Ok((url.clone(), None));
    }
    let (url, server) = members
        .iter()
        .filter(|member| member.wire == wire)
        .find_map(|member| {
            member.foci.first().and_then(|url| {
                member
                    .focus_servers
                    .get(url)
                    .map(|server| (url.clone(), server.clone()))
            })
        })
        .ok_or(RpcError::NoCallFocus)?;
    Ok((url, Some(server)))
}

fn own_identity(
    user: &UserId,
    device: &DeviceId,
    mode: CallMode,
    wire: membership::RtcWire,
) -> (String, String) {
    if mode != CallMode::Matrix2 {
        let identity = sfu::livekit_identity(user, device);
        return (identity.clone(), identity);
    }
    let member_id = TransactionId::new().to_string();
    let identity = if wire == membership::RtcWire::Stable {
        membership::stable_identity(user, &member_id)
    } else {
        membership::sticky_identity(user, device, &member_id)
    };
    (identity, member_id)
}

fn own_member(
    user: OwnedUserId,
    device: OwnedDeviceId,
    mode: CallMode,
    wire: membership::RtcWire,
    service: String,
    focus_server: Option<OwnedServerName>,
) -> CallMember {
    let (identity, member_id) = own_identity(&user, &device, mode, wire);
    let now = crate::now_ms();
    CallMember {
        user_id: user,
        device_id: Some(device),
        member_id: Some(member_id),
        identity,
        mode,
        created_ts: now,
        joined_ts: now,
        expires_at_ms: None,
        foci: vec![service.clone()],
        screen_sharing: false,
        wire,
        focus_servers: focus_server
            .map(|server| [(service, server)].into())
            .unwrap_or_default(),
    }
}

pub(super) async fn discover(
    core: &Core,
    room: &Room,
    session: CallSessionId,
    configured: Option<String>,
    requested: Option<CallMode>,
) -> Result<Discovered, RpcError> {
    let client = room.client();
    let user = client.user_id().ok_or(RpcError::NotLoggedIn)?.to_owned();
    let device = client.device_id().ok_or(RpcError::NotLoggedIn)?.to_owned();
    let encrypted = core.room_is_encrypted(room).await?;
    let features = client.unstable_features().await.unwrap_or_default();
    let (mut sticky_members, sticky_sync) = if features.contains(&"org.matrix.msc4354".into()) {
        sync_sticky(room, session, encrypted).await
    } else {
        (StickyMemberships::default(), None)
    };
    for event in sticky::live_events(room) {
        event.apply(&mut sticky_members, encrypted, crate::now_ms());
    }
    let sticky_candidates = sticky_members.members(crate::now_ms());
    let stable_supported = features.contains(&"org.matrix.msc4143.stable".into());
    let stable_services = if stable_supported {
        super::stable_transports(&client).await
    } else {
        Vec::new()
    };
    let wire = select_wire(stable_supported, &sticky_candidates, &stable_services);
    let slot_closed = sticky_sync.is_some() && room_slot_closed(core, room, wire).await?;
    let mut members = membership::active_members(room).await;
    if !slot_closed {
        merge_sticky(
            &mut members,
            sticky_candidates
                .into_iter()
                .filter(|member| member.wire == wire)
                .collect(),
        );
    }
    let forced_sticky = requested.is_none()
        && sticky_sync.is_some()
        && !room
            .power_levels_or_default()
            .await
            .user_can_send_state(&user, StateEventType::CallMember);
    let requested = if forced_sticky {
        Some(CallMode::Matrix2)
    } else {
        requested
    };
    let mode = if requested.is_none()
        && wire == membership::RtcWire::Stable
        && sticky_sync.is_some()
        && members.is_empty()
    {
        CallMode::Matrix2
    } else {
        select_mode(requested, &members, sticky_sync.is_some())?
    };
    let wire = if mode == CallMode::Matrix2 {
        wire
    } else {
        membership::RtcWire::Deployed
    };
    let sticky_available = sticky_sync.is_some();
    let reason = mode_reason(requested, forced_sticky, &members, sticky_available);
    let mut peer_modes = members
        .iter()
        .filter(|member| !member.is_own(&user, &device))
        .map(|member| member.mode)
        .collect::<Vec<_>>();
    peer_modes.dedup();
    members.sort_by_key(|member| member.created_ts);
    let (service, focus_server) = resolve_service(
        core,
        room,
        &members,
        configured,
        &stable_services,
        mode == CallMode::Matrix2 && wire == membership::RtcWire::Stable,
        wire,
    )
    .await?;
    let own = own_member(user, device, mode, wire, service, focus_server);
    Ok(Discovered {
        own,
        members,
        sticky: sticky_members,
        sticky_sync,
        slot_closed,
        mode_info: ModeInfo {
            reason,
            sticky_available,
            peer_modes,
        },
    })
}

pub(super) struct Discovered {
    pub(super) own: CallMember,
    pub(super) members: Vec<CallMember>,
    pub(super) sticky: StickyMemberships,
    pub(super) sticky_sync: Option<sticky::StickySync>,
    pub(super) slot_closed: bool,
    pub(super) mode_info: ModeInfo,
}

pub(super) struct ModeInfo {
    pub(super) reason: CallModeReason,
    pub(super) sticky_available: bool,
    pub(super) peer_modes: Vec<CallMode>,
}

#[cfg(test)]
#[path = "discover_tests.rs"]
mod tests;
