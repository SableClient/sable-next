use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use matrix_sdk::event_handler::EventHandlerDropGuard;
use matrix_sdk::executor::{JoinHandleExt as _, spawn};
use matrix_sdk::ruma::api::client::delayed_events::update_delayed_event::UpdateAction;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::{OwnedDeviceId, OwnedRoomId, OwnedServerName, OwnedUserId};
use matrix_sdk::{Client, Room};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{Mutex, Notify};

use super::content::content;
use super::discover::{Discovered, ModeInfo, discover};
use super::keys::{self, KeyDistributor, Rolled};
use super::membership::{self, CallMember, StickyMemberships};
use super::{HANGUP_DELAY, USE_KEY_DELAY, sfu, sticky};
use crate::api::calls::JoinOk;
use crate::protocol::{
    CallBackendView, CallIntent, CallMemberView, CallMode, CallSessionId, CoreEvent, RpcCode,
    RpcError,
};
use crate::{CallSession, Core};

const UPDATE_INTERVAL: Duration = Duration::from_secs(5);
const UNRESOLVED_KEY_REPORT_MS: u64 = 30_000;
const SILENT_MEMBER_REPORT_MS: u64 = 10_000;
const RENEW_INTERVAL_MS: u64 = 600_000;
const STICKY_RENEW_INTERVAL_MS: u64 = 3_300_000;
const SLOT_CHECK_INTERVAL_MS: u64 = 5_000;
const PUBLISHER_RETRY_MS: u64 = 30_000;

struct PendingKey {
    sender: OwnedUserId,
    device: OwnedDeviceId,
    content: keys::ToDeviceCallEncryptionKeysEventContent,
    received: u64,
    reported: bool,
}

pub(crate) struct State {
    own: CallMember,
    sticky: StickyMemberships,
    members: Vec<CallMember>,
    emitted_members: Option<Vec<CallMemberView>>,
    backends: BTreeMap<String, CallBackendView>,
    pending_keys: Vec<PendingKey>,
    latest_keys: HashMap<(String, u8), (u64, Vec<u8>)>,
    member_first_seen: HashMap<String, u64>,
    silent_reported: HashSet<String>,
    rotation_due_ms: Option<u64>,
    distributor: Option<Arc<Mutex<KeyDistributor>>>,
    own_observed: bool,
    revision: u64,
    intent: Option<CallIntent>,
    slot_closed: bool,
    slot_closed_midcall: bool,
    slot_checked_ms: u64,
    publisher_attempt_ms: u64,
}

impl State {
    pub(super) fn own_member(&self) -> CallMember {
        self.own.clone()
    }

    pub(super) const fn wire(&self) -> membership::RtcWire {
        self.own.wire
    }
    pub(super) const fn left_because_slot_closed(&self) -> bool {
        self.slot_closed_midcall
    }

    fn new(
        own: CallMember,
        members: Vec<CallMember>,
        sticky: StickyMemberships,
        room_id: &OwnedRoomId,
        encrypt_media: bool,
        intent: Option<CallIntent>,
        slot_closed: bool,
    ) -> Self {
        let distributor = encrypt_media.then(|| {
            let mut distributor = KeyDistributor::new(
                room_id.clone(),
                own.user_id.clone(),
                own.own_device_id().to_owned(),
                own.member_id
                    .clone()
                    .unwrap_or_else(|| own.identity.clone()),
                own.identity.clone(),
            );
            distributor.set_wire(own.wire);
            Arc::new(Mutex::new(distributor))
        });
        Self {
            own,
            members,
            sticky,
            distributor,
            emitted_members: None,
            backends: BTreeMap::new(),
            pending_keys: Vec::new(),
            latest_keys: HashMap::new(),
            member_first_seen: HashMap::new(),
            silent_reported: HashSet::new(),
            rotation_due_ms: None,
            revision: 0,
            own_observed: false,
            intent,
            slot_closed,
            slot_closed_midcall: false,
            slot_checked_ms: crate::now_ms(),
            publisher_attempt_ms: 0,
        }
    }
}

fn backend_id(room_id: &OwnedRoomId, service: &str) -> String {
    STANDARD_NO_PAD.encode(Sha256::digest(
        Value::from([
            room_id.as_str(),
            "m.call#ROOM",
            service.trim_end_matches('/'),
        ])
        .to_string()
        .as_bytes(),
    ))
}

fn member_service<'a>(member: &'a CallMember, members: &'a [CallMember]) -> Option<&'a str> {
    if member.mode != CallMode::Legacy {
        return member.foci.first().map(String::as_str);
    }
    let mut owners: Vec<&CallMember> = members.iter().collect();
    owners.sort_by_key(|entry| entry.created_ts);
    owners
        .iter()
        .find_map(|entry| entry.foci.first())
        .map(String::as_str)
}

fn state_key(
    room: &Room,
    own: &CallMember,
) -> matrix_sdk::ruma::events::call::member::CallMemberStateKey {
    super::membership_state_key(
        &own.user_id,
        own.own_device_id(),
        room.version()
            .as_ref()
            .map_or("", |version| version.as_str()),
    )
}

async fn publish_membership(
    room: &Room,
    own: &CallMember,
    intent: Option<CallIntent>,
) -> Result<matrix_sdk::ruma::OwnedEventId, matrix_sdk::Error> {
    let room_id = room.room_id().to_owned();
    let body = content(&room_id, own, intent);
    if own.mode == CallMode::Matrix2 {
        sticky::send_wire(room, &body, own.wire).await
    } else {
        let key = state_key(room, own);
        let raw = matrix_sdk::ruma::serde::Raw::new(&body)?.cast_unchecked();
        Ok(room
            .send_state_event_raw(&StateEventType::CallMember.to_string(), key.as_ref(), raw)
            .await?
            .event_id)
    }
}

async fn retract(core: &Core, room: &Room, own: &CallMember, delay: Option<String>) {
    core.withdraw_call_invite(room, own, false).await;
    if let Some(delay) = delay
        && core.fire_hangup(delay).await.is_ok()
    {
        return;
    }
    if own.mode == CallMode::Matrix2 {
        if sticky::send_wire(
            room,
            sticky::LeaveOut::for_wire(own.member_id.clone(), sticky::LeaveCode::Leave, own.wire),
            own.wire,
        )
        .await
        .is_err()
        {
            tracing::warn!("could not retract sticky call membership");
        }
    } else {
        core.retract_membership(room, &state_key(room, own), None)
            .await;
    }
}

struct Published {
    event: matrix_sdk::ruma::OwnedEventId,
    provision: sfu::Provisioned,
    delay: Option<String>,
    postpone: Option<crate::Task>,
}

async fn send_delayed_leave(
    room: &Room,
    support: crate::delayed_events::DelayedEventsSupport,
    own: &CallMember,
) -> Result<String, matrix_sdk::Error> {
    sticky::send_delayed_event(
        &room.client(),
        support,
        room,
        if own.wire == membership::RtcWire::Stable {
            "m.rtc.member"
        } else {
            membership::RTC_MEMBER_EVENT_TYPE
        },
        sticky::LeaveOut::for_wire(
            own.member_id.clone(),
            sticky::LeaveCode::DelayedLeave,
            own.wire,
        ),
        HANGUP_DELAY,
        sticky::STICKY_DURATION_MS,
    )
    .await
}

async fn publish(
    core: &Arc<Core>,
    room: &Room,
    own: &CallMember,
    service: &str,
    encrypted: bool,
    intent: Option<CallIntent>,
) -> Result<Published, RpcError> {
    let state_key = state_key(room, own);
    let delay = if own.mode == CallMode::Matrix2 {
        if !super::ensure_open_slot(room, encrypted, own.wire).await {
            return Err(core.failed("join_call", "no compatible open RTC slot"));
        }
        let support = core.delayed_events_support().await.unwrap_or_default();
        if support.any() {
            match send_delayed_leave(room, support, own).await {
                Ok(id) => Some(id),
                Err(error) => {
                    tracing::warn!(?error, "could not schedule a delayed call leave");
                    None
                }
            }
        } else {
            None
        }
    } else {
        core.schedule_hangup(&room.room_id().to_owned(), &state_key)
            .await
    };
    let postpone = delay.clone().map(|id| core.spawn_postpone_loop(id));
    let membership_event = match publish_membership(room, own, intent).await {
        Ok(event) => event,
        Err(error) => {
            drop(postpone);
            retract(core, room, own, delay).await;
            return Err(core.rpc_error("join_call", &error));
        }
    };
    let provision = if own.mode == CallMode::Matrix2 && own.wire == membership::RtcWire::Stable {
        sfu::provision_stable(
            room,
            service,
            own.focus_servers.get(service).map(AsRef::as_ref),
            own.member_id.as_deref().unwrap_or(&own.identity),
        )
        .await
    } else if own.mode == CallMode::Matrix2 {
        sfu::provision_matrix2(
            room,
            service,
            own.own_device_id(),
            own.member_id.as_deref().unwrap_or(&own.identity),
        )
        .await
    } else {
        sfu::provision(room, service, own.own_device_id()).await
    };
    let provision = match provision {
        Ok(provision) if provision.identity == own.identity => provision,
        Ok(_) => {
            drop(postpone);
            retract(core, room, own, delay).await;
            return Err(core.failed("join_call", "SFU publisher identity mismatch"));
        }
        Err(error) => {
            drop(postpone);
            retract(core, room, own, delay).await;
            return Err(core.provision_error(service, &error));
        }
    };
    Ok(Published {
        event: membership_event,
        provision,
        delay,
        postpone,
    })
}

async fn publish_elsewhere(
    core: &Core,
    room: &Room,
    own: &CallMember,
    configured: Option<String>,
    intent: Option<CallIntent>,
) -> Option<(CallMember, sfu::Provisioned)> {
    let service = if own.mode == CallMode::Matrix2 && own.wire == membership::RtcWire::Stable {
        super::stable_transports(&room.client())
            .await
            .into_iter()
            .next()?
    } else {
        core.resolve_focus(&[], configured, room).await?
    };
    if own
        .foci
        .first()
        .is_some_and(|current| same_service(current, &service))
    {
        return None;
    }
    let moved = CallMember {
        mode: if own.mode == CallMode::Legacy {
            CallMode::Compatibility
        } else {
            own.mode
        },
        foci: vec![service.clone()],
        ..own.clone()
    };
    let provisioned =
        if moved.mode == CallMode::Matrix2 && moved.wire == membership::RtcWire::Stable {
            sfu::provision_stable(
                room,
                &service,
                None,
                moved.member_id.as_deref().unwrap_or(&moved.identity),
            )
            .await
        } else if moved.mode == CallMode::Matrix2 {
            sfu::provision_matrix2(
                room,
                &service,
                moved.own_device_id(),
                moved.member_id.as_deref().unwrap_or(&moved.identity),
            )
            .await
        } else {
            sfu::provision(room, &service, moved.own_device_id()).await
        };
    match provisioned {
        Ok(provision) if provision.identity == moved.identity && provision.can_publish => {
            if let Err(error) = publish_membership(room, &moved, intent).await {
                tracing::warn!(%error, "could not move the call membership to our own focus");
                return None;
            }
            Some((moved, provision))
        }
        Ok(_) => None,
        Err(error) => {
            tracing::warn!(%error, "could not provision our own focus");
            None
        }
    }
}

async fn publish_where_allowed(
    core: &Arc<Core>,
    room: &Room,
    state: &Mutex<State>,
    encrypted: bool,
    configured: Option<String>,
) -> Result<(CallMember, Published), RpcError> {
    let (mut own, intent) = {
        let state = state.lock().await;
        (state.own.clone(), state.intent)
    };
    let service = own.foci.first().cloned().ok_or(RpcCode::NoCallFocus)?;
    let mut published = publish(core, room, &own, &service, encrypted, intent).await?;
    if !published.provision.can_publish
        && let Some((moved, provision)) =
            publish_elsewhere(core, room, &own, configured, intent).await
    {
        own = moved;
        published.provision = provision;
    }
    if !published.provision.can_publish {
        tracing::warn!("no focus lets this account publish, joining listen-only");
    }
    state.lock().await.own = own.clone();
    Ok((own, published))
}

fn join_handlers(
    core: &Arc<Core>,
    generation: u64,
    session: CallSessionId,
    room: &Room,
    state: &Arc<Mutex<State>>,
    encrypt_media: bool,
) -> (Arc<Notify>, Vec<EventHandlerDropGuard>) {
    let client = room.client();
    let room_id = room.room_id().to_owned();
    let wake = Arc::new(Notify::new());
    let mut handlers = vec![watch_members(&client, &room_id, wake.clone())];
    handlers.push(watch_redactions(
        &client,
        &room_id,
        state.clone(),
        wake.clone(),
    ));
    if encrypt_media {
        handlers.extend(watch_keys(
            core,
            &client,
            generation,
            session,
            room_id,
            state.clone(),
        ));
    }
    (wake, handlers)
}

async fn confirm_join(
    core: &Arc<Core>,
    generation: u64,
    session: CallSessionId,
    room: &Room,
    state: &Mutex<State>,
    provision: &sfu::Provisioned,
    membership_event: &matrix_sdk::ruma::OwnedEventId,
) -> Option<(String, Vec<CallBackendView>)> {
    let own = state.lock().await.own.clone();
    let publisher_id = backend_id(&room.room_id().to_owned(), own.foci.first()?);
    state.lock().await.backends.insert(
        publisher_id.clone(),
        CallBackendView {
            id: publisher_id.clone(),
            url: provision.url.clone(),
            jwt: provision.jwt.clone(),
            identity: provision.identity.clone(),
        },
    );
    if refresh(core, generation, session, room, state).await != Refreshed::Current {
        return None;
    }
    let (backends, was_running) = {
        let state = state.lock().await;
        (
            state.backends.values().cloned().collect(),
            state
                .members
                .iter()
                .any(|member| !member.is_own(&own.user_id, own.own_device_id())),
        )
    };
    if !was_running {
        core.announce_call(room, membership_event, &own).await;
    }
    Some((publisher_id, backends))
}

fn same_service(left: &str, right: &str) -> bool {
    left.trim_end_matches('/') == right.trim_end_matches('/')
}

async fn discover_state(
    core: &Arc<Core>,
    room: &Room,
    session: CallSessionId,
    configured: Option<String>,
    requested: Option<CallMode>,
    intent: Option<CallIntent>,
    encrypt_media: bool,
) -> Result<(Arc<Mutex<State>>, Option<sticky::StickySync>, ModeInfo), RpcError> {
    let Discovered {
        own,
        members,
        sticky,
        sticky_sync,
        slot_closed,
        mode_info,
    } = discover(core, room, session, configured, requested).await?;
    let state = Arc::new(Mutex::new(State::new(
        own,
        members,
        sticky,
        &room.room_id().to_owned(),
        encrypt_media,
        intent,
        slot_closed,
    )));
    Ok((state, sticky_sync, mode_info))
}

pub(super) async fn join(
    core: &Arc<Core>,
    room_id: OwnedRoomId,
    configured: Option<String>,
    requested: Option<CallMode>,
    intent: Option<CallIntent>,
) -> Result<JoinOk, RpcError> {
    let generation = core.lifecycle.current();
    let room = core.room(&room_id).await?;
    let encrypt_media = core.room_is_encrypted(&room).await?;
    let session = CallSessionId(core.allocate_subscription().0);
    let (state, sticky_sync, mode_info) = discover_state(
        core,
        &room,
        session,
        configured.clone(),
        requested,
        intent,
        encrypt_media,
    )
    .await?;
    let (wake, handlers) = join_handlers(core, generation, session, &room, &state, encrypt_media);
    let (
        own,
        Published {
            event: membership_event,
            provision,
            delay,
            postpone,
        },
    ) = publish_where_allowed(core, &room, &state, encrypt_media, configured).await?;
    if own.mode == CallMode::Matrix2 {
        state.lock().await.slot_closed = false;
    }
    let mode = own.mode;
    let state_key = state_key(&room, &own);
    if !core.is_current(generation) {
        abort_join(core, &room, &own, delay, postpone).await;
        return Err(RpcCode::NotLoggedIn.into());
    }
    let Some((publisher_id, backends)) = confirm_join(
        core,
        generation,
        session,
        &room,
        &state,
        &provision,
        &membership_event,
    )
    .await
    else {
        abort_join(core, &room, &own, delay, postpone).await;
        return Err(core.failed("join_call", "call membership was not confirmed"));
    };
    let mut calls = core.call_sessions.lock().await;
    if !core.is_current(generation) {
        drop(calls);
        abort_join(core, &room, &own, delay, postpone).await;
        return Err(RpcCode::NotLoggedIn.into());
    }
    let shared = state.clone();
    let delay = super::DelayState::shared(delay);
    drop(postpone);
    let postpone = Some(core.spawn_managed_postpone_loop(delay.clone(), wake.clone()));
    let updates = updates(
        UpdateContext {
            core: core.clone(),
            generation,
            session,
            room,
            state,
            wake,
            delay: delay.clone(),
            encrypted: encrypt_media,
        },
        sticky_sync,
    );
    calls.insert(
        session,
        CallSession {
            room_id,
            state_key,
            delay_id: delay,
            postpone,
            _handlers: handlers,
            updates: Some(updates),
            state: shared,
            sticky_member: own.member_id.filter(|_| mode == CallMode::Matrix2),
        },
    );
    drop(calls);
    core.apply_app_activity(core.activity.app_active()).await;
    core.refresh_presence().await;
    if !core.is_current(generation) {
        return Err(RpcCode::NotLoggedIn.into());
    }
    Ok(join_ok(
        session,
        encrypt_media,
        mode,
        mode_info,
        provision,
        publisher_id,
        backends,
    ))
}

async fn abort_join(
    core: &Core,
    room: &Room,
    own: &CallMember,
    delay: Option<String>,
    postpone: Option<crate::Task>,
) {
    drop(postpone);
    retract(core, room, own, delay).await;
}

fn join_ok(
    session: CallSessionId,
    encrypt_media: bool,
    mode: CallMode,
    mode_info: ModeInfo,
    provision: sfu::Provisioned,
    publisher_id: String,
    backends: Vec<CallBackendView>,
) -> JoinOk {
    JoinOk {
        session,
        url: provision.url,
        jwt: provision.jwt,
        identity: provision.identity,
        encrypt_media,
        mode,
        mode_reason: mode_info.reason,
        sticky_available: mode_info.sticky_available,
        peer_modes: mode_info.peer_modes,
        can_publish: provision.can_publish,
        publisher_id,
        backends,
    }
}

pub(super) fn merge_sticky(members: &mut Vec<CallMember>, sticky: Vec<CallMember>) {
    members.retain(|member| {
        !sticky.iter().any(|new| {
            member
                .device_id
                .as_deref()
                .is_some_and(|device| new.is_own(&member.user_id, device))
        })
    });
    members.extend(sticky);
}

fn own_is_present(members: &[CallMember], own: &CallMember) -> bool {
    members.iter().any(|member| {
        member.user_id == own.user_id
            && member.member_id == own.member_id
            && (member.device_id.is_none() || member.is_own(&own.user_id, own.own_device_id()))
    })
}

#[derive(Debug, PartialEq, Eq)]
enum Refreshed {
    Current,
    Absent,
    Ended,
}

async fn current_members(
    room: &Room,
    shared: &Mutex<State>,
) -> Result<(Vec<CallMember>, CallMember), Refreshed> {
    let mut members = membership::active_members(room).await;
    let own = {
        let mut state = shared.lock().await;
        let mut sticky = state.sticky.members(crate::now_ms());
        sticky.retain(|member| member.wire == state.own.wire);
        if state.own.mode == CallMode::Matrix2 && state.own.wire == membership::RtcWire::Stable {
            members.clear();
        }
        if state.slot_closed {
            sticky.retain(|member| member.is_own(&state.own.user_id, state.own.own_device_id()));
        }
        merge_sticky(&mut members, sticky);
        let present = own_is_present(&members, &state.own);
        if !present && state.own_observed {
            return Err(Refreshed::Absent);
        }
        if !present && crate::now_ms().saturating_sub(state.own.created_ts) > 30_000 {
            return Err(Refreshed::Ended);
        }
        state.own_observed |= present;
        state.own.clone()
    };
    members.retain(|member| {
        !(member.is_own(&own.user_id, own.own_device_id())
            || member.user_id == own.user_id && member.member_id == own.member_id)
    });
    members.push(own.clone());
    Ok((members, own))
}

async fn verified_members(
    room: &Room,
    members: Vec<CallMember>,
    own: &CallMember,
) -> Vec<CallMember> {
    let mut verified = Vec::new();
    for member in members {
        if member.is_own(&own.user_id, own.own_device_id())
            || room
                .get_member(&member.user_id)
                .await
                .ok()
                .flatten()
                .is_some_and(|user| {
                    user.membership()
                        == &matrix_sdk::ruma::events::room::member::MembershipState::Join
                })
        {
            verified.push(member);
        } else {
            tracing::info!(
                user_id = %member.user_id,
                device_id = ?member.device_id,
                "ignoring a call membership of a user who is not joined in the local room state"
            );
        }
    }
    verified
}

fn wanted_backends(
    room: &Room,
    verified: &[CallMember],
    own: &CallMember,
) -> BTreeMap<String, (String, Option<OwnedServerName>)> {
    let mut wanted = BTreeMap::new();
    for member in verified {
        if let Some(service) = member_service(member, verified) {
            wanted.insert(
                backend_id(&room.room_id().to_owned(), service),
                (
                    service.to_owned(),
                    member.focus_servers.get(service).cloned(),
                ),
            );
        }
    }
    let own_service = own.foci.first().cloned().unwrap_or_default();
    let publisher_id = backend_id(&room.room_id().to_owned(), &own_service);
    wanted.insert(
        publisher_id,
        (
            own_service.clone(),
            own.focus_servers.get(&own_service).cloned(),
        ),
    );
    wanted
}

async fn refresh(
    core: &Arc<Core>,
    generation: u64,
    session: CallSessionId,
    room: &Room,
    shared: &Mutex<State>,
) -> Refreshed {
    recheck_slot(room, shared).await;
    if shared.lock().await.slot_closed_midcall {
        return Refreshed::Ended;
    }
    let (members, own) = match current_members(room, shared).await {
        Ok(current) => current,
        Err(outcome) => return outcome,
    };
    let mut verified = verified_members(room, members, &own).await;
    let own = if own.mode == CallMode::Legacy {
        let own = follow_oldest_focus(room, shared, own, &verified).await;
        if let Some(entry) = verified
            .iter_mut()
            .find(|member| member.is_own(&own.user_id, own.own_device_id()))
        {
            entry.clone_from(&own);
        }
        own
    } else {
        own
    };
    let wanted = wanted_backends(room, &verified, &own);
    let missing = {
        let mut state = shared.lock().await;
        state.members.clone_from(&verified);
        state.backends.retain(|id, _| wanted.contains_key(id));
        emit_pending(
            core,
            generation,
            session,
            &room.room_id().to_owned(),
            &mut state,
        );
        wanted
            .into_iter()
            .filter(|(id, _)| !state.backends.contains_key(id))
            .map(|(id, (url, server))| (id, url, server))
            .collect::<Vec<_>>()
    };
    provision_missing(core, generation, session, room, shared, &own, missing).await;
    publish_update(core, generation, session, room, shared).await;
    Refreshed::Current
}

async fn recheck_slot(room: &Room, shared: &Mutex<State>) {
    let now = crate::now_ms();
    let (due, encrypted) = {
        let state = shared.lock().await;
        (
            now.saturating_sub(state.slot_checked_ms) >= SLOT_CHECK_INTERVAL_MS
                && (state.own.mode == CallMode::Matrix2
                    || state.sticky.members(now).iter().any(|member| {
                        !member.is_own(&state.own.user_id, state.own.own_device_id())
                    })),
            state.distributor.is_some(),
        )
    };
    if due {
        let wire = shared.lock().await.own.wire;
        let closed = super::slot_closed(room, encrypted, wire).await;
        let mut state = shared.lock().await;
        state.slot_closed_midcall |= closed && !state.slot_closed;
        state.slot_closed = closed;
        state.slot_checked_ms = now;
    }
}

async fn provision_missing(
    core: &Arc<Core>,
    generation: u64,
    session: CallSessionId,
    room: &Room,
    shared: &Mutex<State>,
    own: &CallMember,
    missing: Vec<(String, String, Option<matrix_sdk::ruma::OwnedServerName>)>,
) {
    for (id, service, server_name) in missing {
        let provision = if own.mode == CallMode::Matrix2 && own.wire == membership::RtcWire::Stable
        {
            sfu::provision_stable(
                room,
                &service,
                server_name.as_deref(),
                own.member_id.as_deref().unwrap_or(&own.identity),
            )
            .await
        } else {
            sfu::provision_remote(
                room,
                &service,
                own.own_device_id(),
                own.member_id.as_deref().unwrap_or(&own.identity),
                own.mode == CallMode::Matrix2,
            )
            .await
        };
        match provision {
            Ok(provision) if provision.identity == own.identity => {
                shared.lock().await.backends.insert(
                    id.clone(),
                    CallBackendView {
                        id,
                        url: provision.url,
                        jwt: provision.jwt,
                        identity: provision.identity,
                    },
                );
            }
            Ok(_) | Err(_) => core.emit_if_current(
                generation,
                CoreEvent::CallSignalingError {
                    session,
                    stage: crate::protocol::CallSignalingStage::Provision,
                    fatal: false,
                },
            ),
        }
    }
}

async fn follow_oldest_focus(
    room: &Room,
    shared: &Mutex<State>,
    own: CallMember,
    members: &[CallMember],
) -> CallMember {
    let Some(target) = member_service(&own, members).map(ToOwned::to_owned) else {
        return own;
    };
    if own
        .foci
        .first()
        .is_some_and(|current| same_service(current, &target))
    {
        return own;
    }
    let now = crate::now_ms();
    let intent = {
        let mut state = shared.lock().await;
        if now.saturating_sub(state.publisher_attempt_ms) < PUBLISHER_RETRY_MS {
            return own;
        }
        state.publisher_attempt_ms = now;
        state.intent
    };
    let provision = match sfu::provision(room, &target, own.own_device_id()).await {
        Ok(provision) if provision.identity == own.identity && provision.can_publish => provision,
        Ok(_) => {
            tracing::warn!("the oldest member's focus will not let this device publish");
            return own;
        }
        Err(error) => {
            tracing::warn!(%error, "could not provision the oldest member's focus");
            return own;
        }
    };
    let moved = CallMember {
        foci: vec![target.clone()],
        ..own.clone()
    };
    if let Err(error) = publish_membership(room, &moved, intent).await {
        tracing::warn!(%error, "could not move the call membership to the oldest member's focus");
        return own;
    }
    let id = backend_id(&room.room_id().to_owned(), &target);
    let mut state = shared.lock().await;
    state.own.foci.clone_from(&moved.foci);
    state.backends.insert(
        id.clone(),
        CallBackendView {
            id,
            url: provision.url,
            jwt: provision.jwt,
            identity: provision.identity,
        },
    );
    moved
}

pub(super) async fn set_screen_sharing(
    room: &Room,
    state: &Mutex<State>,
    active: bool,
) -> Result<(), matrix_sdk::Error> {
    let (own, intent) = {
        let mut state = state.lock().await;
        if state.own.screen_sharing == active {
            return Ok(());
        }
        state.own.screen_sharing = active;
        (state.own.clone(), state.intent)
    };
    if let Err(error) = publish_membership(room, &own, intent).await {
        state.lock().await.own.screen_sharing = !active;
        return Err(error);
    }
    Ok(())
}

async fn emit_roster(
    core: &Arc<Core>,
    generation: u64,
    session: CallSessionId,
    room: &Room,
    shared: &Mutex<State>,
) -> (Vec<CallMember>, Option<Arc<Mutex<KeyDistributor>>>, String) {
    let mut state = shared.lock().await;
    let mut views = super::member_views(&state.members);
    for (view, member) in views.iter_mut().zip(&state.members) {
        view.backend_id = member_service(member, &state.members)
            .map(|service| backend_id(&room.room_id().to_owned(), service));
    }
    if state.emitted_members.as_ref() != Some(&views) {
        state.emitted_members = Some(views.clone());
        core.emit_if_current(
            generation,
            CoreEvent::CallMembers {
                session,
                members: views,
            },
        );
    }
    let publisher_id = backend_id(
        &room.room_id().to_owned(),
        state.own.foci.first().map_or("", String::as_str),
    );
    report_silent_members(&mut state, crate::now_ms());
    state.revision = state.revision.saturating_add(1);
    core.emit_if_current(
        generation,
        CoreEvent::CallBackends {
            session,
            revision: state.revision,
            publisher_id: publisher_id.clone(),
            backends: state.backends.values().cloned().collect(),
        },
    );
    (
        state.members.clone(),
        state.distributor.clone(),
        publisher_id,
    )
}

fn log_rolled(rolled: &Rolled, members: usize) {
    match rolled {
        Rolled::Nothing => {}
        Rolled::Deferred { wait_ms } => tracing::info!(
            members = members,
            wait_ms,
            "deferred the call media key rotation until the previous key is in use"
        ),
        Rolled::Shared => tracing::info!(
            members = members,
            "shared the call media key with new members"
        ),
        Rolled::Reshared => tracing::debug!(
            members = members,
            "shared the call media key again with every member"
        ),
        Rolled::Rotated {
            announcement,
            first,
        } => tracing::info!(
            members = members,
            index = announcement.index,
            first,
            "rotated the call media key"
        ),
    }
}

async fn publish_update(
    core: &Arc<Core>,
    generation: u64,
    session: CallSessionId,
    room: &Room,
    shared: &Mutex<State>,
) {
    let (verified, distributor, publisher_id) =
        emit_roster(core, generation, session, room, shared).await;
    let Some(distributor) = distributor else {
        return;
    };
    let rolled = distributor.lock().await.roll(room, &verified).await;
    shared.lock().await.rotation_due_ms = match &rolled {
        Rolled::Deferred { wait_ms } => Some(crate::now_ms().saturating_add(*wait_ms)),
        _ => None,
    };
    log_rolled(&rolled, verified.len());
    if let Rolled::Rotated {
        announcement,
        first,
    } = rolled
    {
        let event = CoreEvent::CallEncryptionKey {
            session,
            identity: announcement.identity,
            backend_id: Some(publisher_id),
            key_index: announcement.index,
            key: announcement.encoded,
            own: true,
        };
        if first {
            core.emit_if_current(generation, event);
        } else {
            let core = core.clone();
            core.clone().track_session_task(
                spawn(async move {
                    matrix_sdk::sleep::sleep(USE_KEY_DELAY).await;
                    core.emit_if_current(generation, event);
                })
                .abort_on_drop(),
            );
        }
    }
}

pub(super) fn terminate(
    core: &Arc<Core>,
    generation: u64,
    session: CallSessionId,
    stage: crate::protocol::CallSignalingStage,
) {
    let core = core.clone();
    core.clone().track_session_task(
        spawn(async move {
            if let Err(error) = core.leave_call(session).await {
                tracing::warn!("could not leave the call after a signaling error: {error:?}");
            }
            core.emit_if_current(
                generation,
                CoreEvent::CallSignalingError {
                    session,
                    stage,
                    fatal: true,
                },
            );
        })
        .abort_on_drop(),
    );
}

fn emit_pending(
    core: &Core,
    generation: u64,
    session: CallSessionId,
    room_id: &OwnedRoomId,
    state: &mut State,
) {
    let pending = std::mem::take(&mut state.pending_keys);
    for pending in pending {
        let member = state.members.iter().find(|member| {
            member.user_id == pending.sender
                && member.device_id.as_deref() == Some(pending.device.as_ref())
                && (member.mode != CallMode::Matrix2
                    || (member.member_id.is_some()
                        && member.member_id.as_deref() == pending.content.member_id()))
        });
        if let Some(member) = member
            && let Some(service) = member_service(member, &state.members)
            && let Some(payload) = pending.content.key()
        {
            let slot = (member.identity.clone(), payload.index);
            let sent_ts = pending.content.sent_ts.unwrap_or(pending.received);
            let Some(raw_key) = keys::decode_key(&payload.key) else {
                continue;
            };
            let latest = state.latest_keys.get(&slot);
            if latest.is_some_and(|(latest, _)| *latest > sent_ts) {
                tracing::info!(
                    sender = %pending.sender,
                    index = payload.index,
                    "dropping an out of order call media key"
                );
                continue;
            }
            let repeated = latest.is_some_and(|(_, key)| *key == raw_key);
            state.latest_keys.insert(slot, (sent_ts, raw_key));
            if repeated {
                continue;
            }
            let waited = crate::now_ms().saturating_sub(pending.received);
            if pending.reported {
                tracing::warn!("a call media key resolved after {waited}ms");
            }
            core.emit_if_current(
                generation,
                CoreEvent::CallEncryptionKey {
                    session,
                    identity: member.identity.clone(),
                    backend_id: Some(backend_id(room_id, service)),
                    key_index: payload.index,
                    key: payload.key.clone(),
                    own: false,
                },
            );
        } else {
            let mut pending = pending;
            if !pending.reported
                && crate::now_ms().saturating_sub(pending.received) >= UNRESOLVED_KEY_REPORT_MS
            {
                pending.reported = true;
                tracing::warn!(
                    reported = true,
                    "a call media key is still unresolved after {UNRESOLVED_KEY_REPORT_MS}ms: {}",
                    unresolved_reason(&pending, &state.members)
                );
            }
            state.pending_keys.push(pending);
        }
    }
}

fn report_silent_members(state: &mut State, now_ms: u64) {
    if state.distributor.is_none() {
        return;
    }
    let members = state.members.clone();
    for member in members
        .iter()
        .filter(|member| !member.is_own(&state.own.user_id, state.own.own_device_id()))
    {
        let first_seen = *state
            .member_first_seen
            .entry(member.identity.clone())
            .or_insert(now_ms);
        let has_key = state
            .latest_keys
            .keys()
            .any(|(identity, _)| *identity == member.identity);
        if has_key
            || now_ms.saturating_sub(first_seen) < SILENT_MEMBER_REPORT_MS
            || !state.silent_reported.insert(member.identity.clone())
        {
            continue;
        }
        tracing::warn!(
            reported = true,
            user_id = %member.user_id,
            device_id = ?member.device_id,
            mode = ?member.mode,
            waiting_ms = now_ms.saturating_sub(first_seen),
            pending_keys = state.pending_keys.len(),
            "no call media key has arrived from a member in the call"
        );
    }
}

fn unresolved_reason(pending: &PendingKey, members: &[CallMember]) -> &'static str {
    let mut devices = members
        .iter()
        .filter(|member| {
            member.user_id == pending.sender
                && member.device_id.as_deref() == Some(pending.device.as_ref())
        })
        .peekable();
    if devices.peek().is_none() {
        return "no membership for the sending device";
    }
    let Some(member) = devices.find(|member| {
        member.mode != CallMode::Matrix2
            || (member.member_id.is_some()
                && member.member_id.as_deref() == pending.content.member_id())
    }) else {
        return "the member id does not match the sticky membership";
    };
    if member_service(member, members).is_none() {
        return "the member has no focus";
    }
    "unknown"
}

#[derive(Clone)]
struct KeySink {
    core: Arc<Core>,
    generation: u64,
    session: CallSessionId,
    room_id: OwnedRoomId,
    state: Arc<Mutex<State>>,
}

async fn receive_call_key(
    sink: KeySink,
    sender: OwnedUserId,
    content: keys::ToDeviceCallEncryptionKeysEventContent,
    encryption: Option<matrix_sdk::deserialized_responses::EncryptionInfo>,
    wire: membership::RtcWire,
) {
    let KeySink {
        core,
        generation,
        session,
        room_id,
        state,
    } = sink;
    if content.room_id != room_id {
        return;
    }
    if !content.session.is_legacy_room_call() {
        tracing::warn!(
            reported = true,
            sender = %sender,
            "ignoring a call media key for another session"
        );
        return;
    }
    let Some(payload) = content.key() else {
        tracing::warn!(
            reported = true,
            sender = %sender,
            "ignoring a call media key event without a key"
        );
        return;
    };
    if keys::decode_key_for_wire(&payload.key, wire).is_none() {
        tracing::warn!(
            reported = true,
            sender = %sender,
            "ignoring a call media key with invalid encoding or length"
        );
        return;
    }
    tracing::debug!(
        sender = %sender,
        index = payload.index,
        "received a call media key"
    );
    let Some(encryption) = encryption else {
        tracing::warn!(
            reported = true,
            sender = %sender,
            "ignoring a call media key sent in clear"
        );
        return;
    };
    let Some(device) = encryption.sender_device else {
        tracing::warn!(
            reported = true,
            sender = %sender,
            "ignoring a call media key from an unknown device"
        );
        return;
    };
    if encryption.sender != sender
        || content
            .claimed_device_id()
            .is_some_and(|claimed| claimed != device.as_str())
    {
        tracing::warn!(
            reported = true,
            sender = %sender,
            %device,
            claimed = ?content.claimed_device_id(),
            "ignoring a call media key whose claimed device is not the sender"
        );
        return;
    }
    let mut state = state.lock().await;
    if state.own.wire != wire {
        return;
    }
    if state.pending_keys.len() >= 256 {
        let dropped = state.pending_keys.remove(0);
        tracing::warn!(
            sender = %dropped.sender,
            device = %dropped.device,
            "dropping a call media key whose member never resolved"
        );
    }
    state.pending_keys.push(PendingKey {
        sender,
        device,
        content,
        received: crate::now_ms(),
        reported: false,
    });
    emit_pending(&core, generation, session, &room_id, &mut state);
}

fn watch_keys(
    core: &Arc<Core>,
    client: &Client,
    generation: u64,
    session: CallSessionId,
    room_id: OwnedRoomId,
    state: Arc<Mutex<State>>,
) -> Vec<EventHandlerDropGuard> {
    let sink = KeySink {
        core: core.clone(),
        generation,
        session,
        room_id,
        state,
    };
    let legacy_sink = sink.clone();
    let legacy = client.add_event_handler(
        move |event: keys::ToDeviceCallEncryptionKeysEvent,
              encryption: Option<matrix_sdk::deserialized_responses::EncryptionInfo>| {
            receive_call_key(
                legacy_sink.clone(),
                event.sender,
                event.content,
                encryption,
                membership::RtcWire::Deployed,
            )
        },
    );
    let stable = client.add_event_handler(
        move |event: keys::StableEncryptionKeyEvent,
              encryption: Option<matrix_sdk::deserialized_responses::EncryptionInfo>| {
            receive_call_key(
                sink.clone(),
                event.sender,
                event.content.content,
                encryption,
                membership::RtcWire::Stable,
            )
        },
    );
    vec![
        client.event_handler_drop_guard(legacy),
        client.event_handler_drop_guard(stable),
    ]
}

fn watch_members(
    client: &Client,
    room_id: &OwnedRoomId,
    wake: Arc<Notify>,
) -> EventHandlerDropGuard {
    let handle = client.add_room_event_handler(
        room_id,
        move |_: matrix_sdk::ruma::serde::Raw<
            matrix_sdk::ruma::events::call::member::SyncCallMemberEvent,
        >| {
            let wake = wake.clone();
            async move { wake.notify_one() }
        },
    );
    client.event_handler_drop_guard(handle)
}

fn watch_redactions(
    client: &Client,
    room_id: &OwnedRoomId,
    state: Arc<Mutex<State>>,
    wake: Arc<Notify>,
) -> EventHandlerDropGuard {
    let handle = client.add_room_event_handler(
        room_id,
        move |event: matrix_sdk::ruma::events::room::redaction::SyncRoomRedactionEvent,
              room: Room| {
            let state = state.clone();
            let wake = wake.clone();
            async move {
                if let Some(event_id) =
                    event.redacts(&room.clone_info().room_version_rules_or_default().redaction)
                {
                    state
                        .lock()
                        .await
                        .sticky
                        .redact(event_id.as_str(), crate::now_ms());
                    wake.notify_one();
                }
            }
        },
    );
    client.event_handler_drop_guard(handle)
}

async fn refresh_encrypted_hangup(
    core: Arc<Core>,
    room: Room,
    own: CallMember,
    delay: Arc<Mutex<super::DelayState>>,
) {
    let Ok(support) = core.delayed_events_support().await else {
        return;
    };
    if !support.any() {
        return;
    }
    let mut delay = delay.lock().await;
    if !delay.active {
        return;
    }
    if let Some(id) = delay.id.as_ref() {
        let result =
            crate::delayed_events::update(&room.client(), id.clone(), UpdateAction::Cancel).await;
        if result.is_err() {
            return;
        }
        delay.id = None;
    }
    delay.lost = true;
    match send_delayed_leave(&room, support, &own).await {
        Ok(id) => {
            delay.id = Some(id);
            delay.lost = false;
        }
        Err(error) => tracing::warn!(?error, "could not refresh the delayed call leave"),
    }
}

async fn restore_hangup(
    core: &Core,
    room: &Room,
    own: &CallMember,
    delay: &Mutex<super::DelayState>,
) {
    let mut delay = delay.lock().await;
    if !delay.active || !delay.lost {
        return;
    }
    let id = if own.mode == CallMode::Matrix2 {
        let Ok(support) = core.delayed_events_support().await else {
            return;
        };
        send_delayed_leave(room, support, own)
            .await
            .inspect_err(|error| tracing::warn!(?error, "could not restore the delayed call leave"))
            .ok()
    } else {
        core.schedule_hangup(&room.room_id().to_owned(), &state_key(room, own))
            .await
    };
    if let Some(id) = id {
        delay.id = Some(id);
        delay.lost = false;
    }
}

async fn protect_membership_renewal(
    core: &Core,
    delay: &Mutex<super::DelayState>,
) -> super::Postponed {
    let mut delay = delay.lock().await;
    if !delay.active {
        return super::Postponed::Gone;
    }
    let Some(id) = delay.id.as_deref() else {
        return if delay.lost {
            super::Postponed::Unreachable
        } else {
            super::Postponed::Restarted
        };
    };
    let result = core.postpone_hangup(id).await;
    if result == super::Postponed::Gone {
        delay.id = None;
        delay.lost = true;
    }
    result
}

struct UpdateContext {
    core: Arc<Core>,
    generation: u64,
    session: CallSessionId,
    room: Room,
    state: Arc<Mutex<State>>,
    wake: Arc<Notify>,
    delay: Arc<Mutex<super::DelayState>>,
    encrypted: bool,
}

struct StickyWatch<T> {
    receiver: tokio::sync::broadcast::Receiver<T>,
    open: bool,
}

impl<T: Clone> StickyWatch<T> {
    async fn changed(&mut self) {
        let update = self.receiver.recv().await;
        self.open = !matches!(update, Err(RecvError::Closed));
    }
}

impl UpdateContext {
    async fn wait_for_change<T: Clone>(
        &self,
        sync: &mut Option<sticky::StickySync>,
        watch: &mut StickyWatch<T>,
        interval: Duration,
    ) {
        let Some(sync) = sync.as_mut() else {
            tokio::select! {
                () = matrix_sdk::sleep::sleep(interval) => {}
                () = self.wake.notified() => {}
                () = watch.changed(), if watch.open => {}
            }
            return;
        };
        let synced = tokio::select! {
            synced = sync.sync(&self.room, interval) => Some(synced),
            () = self.wake.notified() => None,
            () = watch.changed(), if watch.open => None,
        };
        match synced {
            Some(Ok(events)) => {
                let encrypted = self
                    .core
                    .room_is_encrypted(&self.room)
                    .await
                    .unwrap_or(true);
                let mut state = self.state.lock().await;
                for event in events {
                    event.apply(&mut state.sticky, encrypted, crate::now_ms());
                }
            }
            Some(Err(_)) => {
                self.core.emit_if_current(
                    self.generation,
                    CoreEvent::CallSignalingError {
                        session: self.session,
                        stage: crate::protocol::CallSignalingStage::Sync,
                        fatal: false,
                    },
                );
                matrix_sdk::sleep::sleep(UPDATE_INTERVAL).await;
            }
            None => {}
        }
    }

    async fn apply_live_events(&self) {
        let encrypted = self
            .core
            .room_is_encrypted(&self.room)
            .await
            .unwrap_or(true);
        let mut state = self.state.lock().await;
        for event in sticky::live_events(&self.room) {
            event.apply(&mut state.sticky, encrypted, crate::now_ms());
        }
    }

    async fn encryption_changed(&self) -> bool {
        match self.core.room_is_encrypted(&self.room).await {
            Ok(encrypted) => encrypted != self.state.lock().await.distributor.is_some(),
            Err(_) => false,
        }
    }

    fn terminate_membership(&self) {
        terminate(
            &self.core,
            self.generation,
            self.session,
            crate::protocol::CallSignalingStage::Membership,
        );
    }

    async fn renew_membership(
        &self,
        renewed: &mut u64,
        delay_roster: &mut HashSet<(OwnedUserId, Option<OwnedDeviceId>, Option<String>)>,
        absent: bool,
    ) {
        let (own, intent, roster_changed) = {
            let state = self.state.lock().await;
            let roster: HashSet<_> = state
                .members
                .iter()
                .map(|member| {
                    (
                        member.user_id.clone(),
                        member.device_id.clone(),
                        member.member_id.clone(),
                    )
                })
                .collect();
            let changed = roster != *delay_roster;
            *delay_roster = roster;
            (state.own.clone(), state.intent, changed)
        };
        if absent && self.delay.lock().await.lost {
            self.terminate_membership();
            return;
        }
        restore_hangup(&self.core, &self.room, &own, &self.delay).await;
        let mut refresh_delay = self.encrypted && own.mode == CallMode::Matrix2 && roster_changed;
        let renew_interval = if own.mode == CallMode::Matrix2 {
            STICKY_RENEW_INTERVAL_MS
        } else {
            RENEW_INTERVAL_MS
        };
        if absent || crate::now_ms().saturating_sub(*renewed) >= renew_interval {
            match protect_membership_renewal(&self.core, &self.delay).await {
                super::Postponed::Gone => {
                    self.terminate_membership();
                    return;
                }
                super::Postponed::Unreachable => return,
                super::Postponed::Restarted => {}
            }
            match publish_membership(&self.room, &own, intent).await {
                Ok(_) => {
                    *renewed = crate::now_ms();
                    refresh_delay |= self.encrypted && own.mode == CallMode::Matrix2;
                }
                Err(error) => {
                    tracing::warn!(?error, absent, "could not publish the call membership");
                }
            }
        }
        if refresh_delay {
            drop(spawn(refresh_encrypted_hangup(
                self.core.clone(),
                self.room.clone(),
                own,
                self.delay.clone(),
            )));
        }
    }

    async fn run(self, mut sync: Option<sticky::StickySync>) {
        let mut renewed = crate::now_ms();
        let mut delay_roster = HashSet::new();
        let mut watch = StickyWatch {
            receiver: self.room.sticky_events().subscribe(),
            open: true,
        };
        loop {
            let interval = {
                let due = self.state.lock().await.rotation_due_ms;
                due.map_or(UPDATE_INTERVAL, |due| {
                    UPDATE_INTERVAL.min(Duration::from_millis(
                        due.saturating_sub(crate::now_ms()).max(100),
                    ))
                })
            };
            self.wait_for_change(&mut sync, &mut watch, interval).await;
            self.apply_live_events().await;
            if self.core.lifecycle.current() != self.generation {
                return;
            }
            if self.encryption_changed().await {
                self.terminate_membership();
                return;
            }
            let refreshed = refresh(
                &self.core,
                self.generation,
                self.session,
                &self.room,
                &self.state,
            )
            .await;
            let absent = match refreshed {
                Refreshed::Current => false,
                Refreshed::Absent => true,
                Refreshed::Ended => {
                    self.terminate_membership();
                    return;
                }
            };
            self.renew_membership(&mut renewed, &mut delay_roster, absent)
                .await;
        }
    }
}

fn updates(context: UpdateContext, sync: Option<sticky::StickySync>) -> crate::Task {
    spawn(context.run(sync)).abort_on_drop()
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
pub(super) mod tests;
