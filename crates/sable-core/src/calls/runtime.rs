use std::collections::BTreeMap;
use std::sync::{Arc, atomic::Ordering};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use matrix_sdk::event_handler::EventHandlerDropGuard;
use matrix_sdk::executor::{JoinHandleExt as _, spawn};
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::{OwnedDeviceId, OwnedRoomId, OwnedUserId, TransactionId};
use matrix_sdk::{Client, Room};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use tokio::sync::{Mutex, Notify};

use super::keys::{self, KeyDistributor, Rolled};
use super::membership::{self, CallMember, StickyMemberships};
use super::{HANGUP_DELAY, USE_KEY_DELAY, sfu, sticky};
use crate::protocol::{
    CallBackendView, CallIntent, CallMode, CallSessionId, CommandErr, CommandOk, CoreEvent,
};
use crate::{CallSession, Core};

const UPDATE_INTERVAL: Duration = Duration::from_secs(5);
const RENEW_INTERVAL_MS: u64 = 600_000;
const STICKY_RENEW_INTERVAL_MS: u64 = 3_300_000;
const SLOT_CHECK_INTERVAL_MS: u64 = 30_000;
const PUBLISHER_RETRY_MS: u64 = 30_000;

struct PendingKey {
    sender: OwnedUserId,
    device: OwnedDeviceId,
    content: keys::ToDeviceCallEncryptionKeysEventContent,
    received: u64,
}

struct State {
    own: CallMember,
    sticky: StickyMemberships,
    members: Vec<CallMember>,
    backends: BTreeMap<String, CallBackendView>,
    pending_keys: Vec<PendingKey>,
    distributor: Option<Arc<Mutex<KeyDistributor>>>,
    own_observed: bool,
    revision: u64,
    intent: Option<CallIntent>,
    slot_closed: bool,
    slot_checked_ms: u64,
    publisher_attempt_ms: u64,
}

impl State {
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
            Arc::new(Mutex::new(KeyDistributor::new(
                room_id.clone(),
                own.user_id.clone(),
                own.device_id.clone(),
                own.member_id
                    .clone()
                    .unwrap_or_else(|| own.identity.clone()),
                own.identity.clone(),
            )))
        });
        Self {
            own,
            members,
            sticky,
            distributor,
            backends: BTreeMap::new(),
            pending_keys: Vec::new(),
            revision: 0,
            own_observed: false,
            intent,
            slot_closed,
            slot_checked_ms: keys::now_ms(),
            publisher_attempt_ms: 0,
        }
    }
}

fn backend_id(room_id: &OwnedRoomId, service: &str) -> String {
    STANDARD_NO_PAD.encode(Sha256::digest(
        json!([room_id, "m.call#ROOM", service.trim_end_matches('/')])
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

fn select_mode(
    requested: Option<CallMode>,
    members: &[CallMember],
    sticky_available: bool,
) -> Result<CallMode, CommandErr> {
    if let Some(mode) = requested {
        return if mode == CallMode::Matrix2 && !sticky_available {
            Err(CommandErr::Unsupported)
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

fn content(room_id: &OwnedRoomId, own: &CallMember, intent: Option<CallIntent>) -> Value {
    content_at(room_id, own, intent, keys::now_ms())
}

fn content_at(
    room_id: &OwnedRoomId,
    own: &CallMember,
    intent: Option<CallIntent>,
    now_ms: u64,
) -> Value {
    let mut content = if own.mode == CallMode::Matrix2 {
        json!({
            "application": {"type": "m.call"}, "slot_id": "m.call#ROOM",
            "member": {"user_id": own.user_id, "device_id": own.device_id, "id": own.member_id},
            "transports": {"published": own.foci.iter().map(|service| json!({"type":"livekit", "livekit_service_url": service})).collect::<Vec<_>>(), "can_subscribe": ["livekit"]},
            "versions": [], "msc4354_sticky_key": own.member_id,
        })
    } else {
        json!({
            "application":"m.call", "call_id":"", "scope":"m.room", "device_id":own.device_id,
            "membershipID":own.identity, "created_ts":own.created_ts, "expires":now_ms.saturating_sub(own.created_ts).saturating_add(14_400_000),
            "focus_active":{"type":"livekit", "focus_selection":if own.mode == CallMode::Compatibility {"multi_sfu"} else {"oldest_membership"}},
            "foci_preferred":own.foci.iter().map(|service| json!({"type":"livekit", "livekit_service_url":service, "livekit_alias":room_id})).collect::<Vec<_>>()
        })
    };
    let target = if own.mode == CallMode::Matrix2 {
        content.get_mut("application")
    } else {
        Some(&mut content)
    };
    if let (Some(intent), Some(Value::Object(target))) = (intent, target) {
        target.insert("m.call.intent".to_owned(), json!(intent));
    }
    content
}

fn state_key(
    room: &Room,
    own: &CallMember,
) -> matrix_sdk::ruma::events::call::member::CallMemberStateKey {
    super::membership_state_key(
        &own.user_id,
        &own.device_id,
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
    let body = content(&room.room_id().to_owned(), own, intent);
    if own.mode == CallMode::Matrix2 {
        sticky::send(&room.client(), room, body).await
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
    if let Some(delay) = delay
        && core.fire_hangup(delay).await.is_ok()
    {
        return;
    }
    if own.mode == CallMode::Matrix2 {
        if sticky::send(
            &room.client(),
            room,
            json!({"msc4354_sticky_key": own.member_id}),
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

async fn discover(
    core: &Core,
    room: &Room,
    session: CallSessionId,
    configured: Option<String>,
    requested: Option<CallMode>,
) -> Result<Discovered, CommandErr> {
    let client = room.client();
    let user = client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned();
    let device = client
        .device_id()
        .ok_or(CommandErr::NotLoggedIn)?
        .to_owned();
    let mut sticky_members = StickyMemberships::default();
    let mut sticky_sync = None;
    let features = client.unstable_features().await.unwrap_or_default();
    if features.contains(&"org.matrix.msc4354".into()) {
        let mut sync = sticky::StickySync::new(session.0);
        if let Ok(events) = sync.sync(room, Duration::ZERO).await {
            for event in events {
                sticky_members.apply(&event, keys::now_ms());
            }
            sticky_sync = Some(sync);
        } else {
            tracing::warn!("sticky call membership sync is unavailable");
        }
    }
    let slot_closed = sticky_sync.is_some() && super::slot_closed(room).await;
    let mut members = membership::active_members(room).await;
    if !slot_closed {
        merge_sticky(&mut members, sticky_members.members(keys::now_ms()));
    }
    let requested = if requested.is_none()
        && sticky_sync.is_some()
        && !room
            .power_levels_or_default()
            .await
            .user_can_send_state(&user, StateEventType::CallMember)
    {
        Some(CallMode::Matrix2)
    } else {
        requested
    };
    let mode = select_mode(requested, &members, sticky_sync.is_some())?;
    members.sort_by_key(|member| member.created_ts);
    let focus_members = if mode == CallMode::Legacy {
        members.as_slice()
    } else {
        &[]
    };
    let service = match core.resolve_focus(focus_members, configured, room).await {
        Some(service) => service,
        None => core
            .resolve_focus(&members, None, room)
            .await
            .ok_or(CommandErr::NoCallFocus)?,
    };
    let member_id = if mode == CallMode::Matrix2 {
        TransactionId::new().to_string()
    } else {
        sfu::livekit_identity(&user, &device)
    };
    let identity = if mode == CallMode::Matrix2 {
        membership::sticky_identity(&user, &device, &member_id)
    } else {
        sfu::livekit_identity(&user, &device)
    };
    let own = CallMember {
        user_id: user,
        device_id: device,
        member_id: if mode == CallMode::Matrix2 {
            Some(member_id)
        } else {
            Some(identity.clone())
        },
        identity,
        mode,
        created_ts: keys::now_ms(),
        expires_at_ms: None,
        foci: vec![service],
    };
    Ok(Discovered {
        own,
        members,
        sticky: sticky_members,
        sticky_sync,
        slot_closed,
    })
}

struct Discovered {
    own: CallMember,
    members: Vec<CallMember>,
    sticky: StickyMemberships,
    sticky_sync: Option<sticky::StickySync>,
    slot_closed: bool,
}

struct Published {
    event: matrix_sdk::ruma::OwnedEventId,
    provision: sfu::Provisioned,
    delay: Option<String>,
    postpone: Option<crate::Task>,
}

async fn publish(
    core: &Arc<Core>,
    room: &Room,
    own: &CallMember,
    service: &str,
    encrypted: bool,
    intent: Option<CallIntent>,
) -> Result<Published, CommandErr> {
    let state_key = state_key(room, own);
    let delay = if own.mode == CallMode::Matrix2 {
        if !super::ensure_open_slot(room, encrypted).await {
            tracing::warn!("no open rtc slot and none could be opened");
        }
        if core.delayed_events_supported().await.unwrap_or(false) {
            sticky::send_delayed(
                &room.client(),
                room,
                json!({"msc4354_sticky_key":own.member_id}),
                HANGUP_DELAY,
            )
            .await
            .ok()
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
            return Err(core.room_error("join_call", error));
        }
    };
    let provision = if own.mode == CallMode::Matrix2 {
        sfu::provision_matrix2(
            room,
            service,
            &own.device_id,
            own.member_id.as_deref().unwrap_or(&own.identity),
        )
        .await
    } else {
        sfu::provision(room, service, &own.device_id).await
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
    let service = core.resolve_focus(&[], configured, room).await?;
    if own
        .foci
        .first()
        .is_some_and(|current| same_service(current, &service))
    {
        return None;
    }
    let moved = CallMember {
        mode: CallMode::Compatibility,
        foci: vec![service.clone()],
        ..own.clone()
    };
    if let Err(error) = publish_membership(room, &moved, intent).await {
        tracing::warn!(%error, "could not move the call membership to our own focus");
        return None;
    }
    match sfu::provision(room, &service, &moved.device_id).await {
        Ok(provision) if provision.identity == moved.identity && provision.can_publish => {
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
) -> Result<(CallMember, Published), CommandErr> {
    let (mut own, intent) = {
        let state = state.lock().await;
        (state.own.clone(), state.intent)
    };
    let service = own.foci.first().cloned().ok_or(CommandErr::NoCallFocus)?;
    let mut published = publish(core, room, &own, &service, encrypted, intent).await?;
    if !published.provision.can_publish
        && own.mode == CallMode::Legacy
        && let Some((moved, provision)) =
            publish_elsewhere(core, room, &own, configured, intent).await
    {
        own = moved;
        published.provision = provision;
    }
    if !published.provision.can_publish {
        drop(published.postpone);
        retract(core, room, &own, published.delay).await;
        return Err(core.failed(
            "join_call",
            "the call's focus does not let this account publish",
        ));
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
    if encrypt_media {
        handlers.push(watch_keys(
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
    if !refresh(core, generation, session, room, state).await {
        return None;
    }
    let (backends, was_running) = {
        let state = state.lock().await;
        (
            state.backends.values().cloned().collect(),
            state
                .members
                .iter()
                .any(|member| !member.is_own(&own.user_id, &own.device_id)),
        )
    };
    if !was_running {
        core.announce_call(room, membership_event).await;
    }
    Some((publisher_id, backends))
}

fn same_service(left: &str, right: &str) -> bool {
    left.trim_end_matches('/') == right.trim_end_matches('/')
}

pub(super) async fn join(
    core: &Arc<Core>,
    room_id: OwnedRoomId,
    configured: Option<String>,
    requested: Option<CallMode>,
    intent: Option<CallIntent>,
) -> Result<CommandOk, CommandErr> {
    let generation = core.session_generation.load(Ordering::SeqCst);
    let room = core.room(&room_id).await?;
    let encrypt_media = core.room_is_encrypted(&room).await?;
    let session = CallSessionId(core.allocate_subscription().0);
    let Discovered {
        own,
        members,
        sticky,
        sticky_sync,
        slot_closed,
    } = discover(core, &room, session, configured.clone(), requested).await?;
    let state = Arc::new(Mutex::new(State::new(
        own.clone(),
        members,
        sticky,
        &room_id,
        encrypt_media,
        intent,
        slot_closed,
    )));
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
    let mode = own.mode;
    let state_key = state_key(&room, &own);
    if core.session_generation.load(Ordering::SeqCst) != generation {
        drop(postpone);
        retract(core, &room, &own, delay).await;
        return Err(CommandErr::NotLoggedIn);
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
        drop(postpone);
        retract(core, &room, &own, delay).await;
        return Err(core.failed("join_call", "call membership was not confirmed"));
    };
    let mut calls = core.call_sessions.lock().await;
    if core.session_generation.load(Ordering::SeqCst) != generation {
        drop(calls);
        drop(postpone);
        retract(core, &room, &own, delay).await;
        return Err(CommandErr::NotLoggedIn);
    }
    let updates = updates(
        core.clone(),
        generation,
        session,
        room,
        state,
        sticky_sync,
        wake,
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
            sticky_member: own.member_id.filter(|_| mode == CallMode::Matrix2),
        },
    );
    Ok(CommandOk::JoinCall {
        session,
        url: provision.url,
        jwt: provision.jwt,
        identity: provision.identity,
        encrypt_media,
        mode,
        publisher_id,
        backends,
    })
}

fn merge_sticky(members: &mut Vec<CallMember>, sticky: Vec<CallMember>) {
    members.retain(|member| {
        !sticky
            .iter()
            .any(|new| new.is_own(&member.user_id, &member.device_id))
    });
    members.extend(sticky);
}

fn own_is_present(members: &[CallMember], own: &CallMember) -> bool {
    members.iter().any(|member| {
        member.is_own(&own.user_id, &own.device_id) && member.member_id == own.member_id
    })
}

async fn refresh(
    core: &Arc<Core>,
    generation: u64,
    session: CallSessionId,
    room: &Room,
    shared: &Mutex<State>,
) -> bool {
    recheck_slot(room, shared).await;
    let mut members = membership::active_members(room).await;
    let own = {
        let mut state = shared.lock().await;
        let mut sticky = state.sticky.members(keys::now_ms());
        if state.slot_closed {
            sticky.retain(|member| member.is_own(&state.own.user_id, &state.own.device_id));
        }
        merge_sticky(&mut members, sticky);
        let present = own_is_present(&members, &state.own);
        if !present
            && (state.own_observed || keys::now_ms().saturating_sub(state.own.created_ts) > 30_000)
        {
            return false;
        }
        state.own_observed |= present;
        state.own.clone()
    };
    members.retain(|member| !member.is_own(&own.user_id, &own.device_id));
    members.push(own.clone());
    let mut verified = Vec::new();
    for member in members {
        if member.is_own(&own.user_id, &own.device_id)
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
        }
    }
    let own = if own.mode == CallMode::Legacy {
        let own = follow_oldest_focus(room, shared, own, &verified).await;
        if let Some(entry) = verified
            .iter_mut()
            .find(|member| member.is_own(&own.user_id, &own.device_id))
        {
            entry.clone_from(&own);
        }
        own
    } else {
        own
    };
    let mut wanted = BTreeMap::new();
    for member in &verified {
        if let Some(service) = member_service(member, &verified) {
            wanted.insert(
                backend_id(&room.room_id().to_owned(), service),
                service.to_owned(),
            );
        }
    }
    let own_service = own.foci.first().cloned().unwrap_or_default();
    let publisher_id = backend_id(&room.room_id().to_owned(), &own_service);
    wanted.insert(publisher_id, own_service);
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
            .collect::<Vec<_>>()
    };
    provision_missing(core, generation, session, room, shared, &own, missing).await;
    publish_update(core, generation, session, room, shared).await;
    true
}

async fn recheck_slot(room: &Room, shared: &Mutex<State>) {
    let now = keys::now_ms();
    let due = {
        let state = shared.lock().await;
        now.saturating_sub(state.slot_checked_ms) >= SLOT_CHECK_INTERVAL_MS
            && state
                .sticky
                .members(now)
                .iter()
                .any(|member| !member.is_own(&state.own.user_id, &state.own.device_id))
    };
    if due {
        let closed = super::slot_closed(room).await;
        let mut state = shared.lock().await;
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
    missing: Vec<(String, String)>,
) {
    for (id, service) in missing {
        match sfu::provision_remote(
            room,
            &service,
            &own.device_id,
            own.member_id.as_deref().unwrap_or(&own.identity),
        )
        .await
        {
            Ok(provision) => {
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
            Err(_) => core.emit_if_current(
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
    let now = keys::now_ms();
    let intent = {
        let mut state = shared.lock().await;
        if now.saturating_sub(state.publisher_attempt_ms) < PUBLISHER_RETRY_MS {
            return own;
        }
        state.publisher_attempt_ms = now;
        state.intent
    };
    let provision = match sfu::provision(room, &target, &own.device_id).await {
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

async fn publish_update(
    core: &Arc<Core>,
    generation: u64,
    session: CallSessionId,
    room: &Room,
    shared: &Mutex<State>,
) {
    let (verified, distributor, publisher_id) = {
        let mut state = shared.lock().await;
        let mut views = super::member_views(&state.members);
        for (view, member) in views.iter_mut().zip(&state.members) {
            view.backend_id = member_service(member, &state.members)
                .map(|service| backend_id(&room.room_id().to_owned(), service));
        }
        core.emit_if_current(
            generation,
            CoreEvent::CallMembers {
                session,
                members: views,
            },
        );
        let publisher_id = backend_id(
            &room.room_id().to_owned(),
            state.own.foci.first().map_or("", String::as_str),
        );
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
    };
    if let Some(distributor) = distributor
        && let Rolled::Rotated {
            announcement,
            first,
        } = distributor.lock().await.roll(room, &verified).await
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

fn terminate(
    core: &Arc<Core>,
    generation: u64,
    session: CallSessionId,
    stage: crate::protocol::CallSignalingStage,
) {
    let core = core.clone();
    core.clone().track_session_task(
        spawn(async move {
            let _ = core.leave_call(session).await;
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
                && member.device_id == pending.device
                && (member.mode != CallMode::Matrix2
                    || (member.member_id.is_some()
                        && member.member_id == pending.content.member.id))
        });
        if let Some(member) = member
            && let Some(service) = member_service(member, &state.members)
        {
            core.emit_if_current(
                generation,
                CoreEvent::CallEncryptionKey {
                    session,
                    identity: member.identity.clone(),
                    backend_id: Some(backend_id(room_id, service)),
                    key_index: pending.content.keys.index,
                    key: pending.content.keys.key,
                    own: false,
                },
            );
        } else if keys::now_ms().saturating_sub(pending.received) < 30_000 {
            state.pending_keys.push(pending);
        } else {
            tracing::warn!(
                sender = %pending.sender,
                device = %pending.device,
                known_member = member.is_some(),
                "dropping a call media key whose member never resolved"
            );
        }
    }
}

fn watch_keys(
    core: &Arc<Core>,
    client: &Client,
    generation: u64,
    session: CallSessionId,
    room_id: OwnedRoomId,
    state: Arc<Mutex<State>>,
) -> EventHandlerDropGuard {
    let core = core.clone();
    let handle = client.add_event_handler(
        move |event: keys::ToDeviceCallEncryptionKeysEvent,
              encryption: Option<matrix_sdk::deserialized_responses::EncryptionInfo>| {
            let core = core.clone();
            let room_id = room_id.clone();
            let state = state.clone();
            async move {
                if event.content.room_id != room_id {
                    return;
                }
                if !event.content.session.is_legacy_room_call() {
                    tracing::warn!(sender = %event.sender, "ignoring a call media key for another session");
                    return;
                }
                if keys::decode_key(&event.content.keys.key).is_none() {
                    tracing::warn!(sender = %event.sender, "ignoring a call media key that is not 16 bytes");
                    return;
                }
                let Some(encryption) = encryption else {
                    tracing::warn!(sender = %event.sender, "ignoring a call media key sent in clear");
                    return;
                };
                let Some(device) = encryption.sender_device else {
                    tracing::warn!(sender = %event.sender, "ignoring a call media key from an unknown device");
                    return;
                };
                if encryption.sender != event.sender
                    || device.as_str() != event.content.member.claimed_device_id
                {
                    tracing::warn!(
                        sender = %event.sender,
                        %device,
                        claimed = %event.content.member.claimed_device_id,
                        "ignoring a call media key whose claimed device is not the sender"
                    );
                    return;
                }
                let mut state = state.lock().await;
                if state.pending_keys.len() >= 256 {
                    state.pending_keys.remove(0);
                }
                state.pending_keys.push(PendingKey {
                    sender: event.sender,
                    device,
                    content: event.content,
                    received: keys::now_ms(),
                });
                emit_pending(&core, generation, session, &room_id, &mut state);
            }
        },
    );
    client.event_handler_drop_guard(handle)
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

fn updates(
    core: Arc<Core>,
    generation: u64,
    session: CallSessionId,
    room: Room,
    state: Arc<Mutex<State>>,
    mut sync: Option<sticky::StickySync>,
    wake: Arc<Notify>,
) -> crate::Task {
    spawn(async move {
        let mut renewed = keys::now_ms();
        loop {
            if let Some(sync) = sync.as_mut() {
                let synced = tokio::select! {
                    synced = sync.sync(&room, UPDATE_INTERVAL) => Some(synced),
                    () = wake.notified() => None,
                };
                match synced {
                    Some(Ok(events)) => {
                        let mut state = state.lock().await;
                        for event in events {
                            state.sticky.apply(&event, keys::now_ms());
                        }
                    }
                    Some(Err(_)) => {
                        core.emit_if_current(
                            generation,
                            CoreEvent::CallSignalingError {
                                session,
                                stage: crate::protocol::CallSignalingStage::Sync,
                                fatal: false,
                            },
                        );
                        matrix_sdk::sleep::sleep(UPDATE_INTERVAL).await;
                    }
                    None => {}
                }
            } else {
                tokio::select! {
                    () = matrix_sdk::sleep::sleep(UPDATE_INTERVAL) => {}
                    () = wake.notified() => {}
                }
            }
            if core.session_generation.load(Ordering::SeqCst) != generation {
                return;
            }
            if !refresh(&core, generation, session, &room, &state).await {
                terminate(
                    &core,
                    generation,
                    session,
                    crate::protocol::CallSignalingStage::Membership,
                );
                return;
            }
            let (own, intent) = {
                let state = state.lock().await;
                (state.own.clone(), state.intent)
            };
            let renew_interval = if own.mode == CallMode::Matrix2 {
                STICKY_RENEW_INTERVAL_MS
            } else {
                RENEW_INTERVAL_MS
            };
            if keys::now_ms().saturating_sub(renewed) >= renew_interval {
                if publish_membership(&room, &own, intent).await.is_ok() {
                    renewed = keys::now_ms();
                } else {
                    terminate(
                        &core,
                        generation,
                        session,
                        crate::protocol::CallSignalingStage::Membership,
                    );
                    return;
                }
            }
        }
    })
    .abort_on_drop()
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
