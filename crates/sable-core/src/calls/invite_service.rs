#![expect(
    clippy::indexing_slicing,
    reason = "serde_json::Value indexing returns Null for missing keys"
)]

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::executor::{JoinHandleExt as _, spawn};
use matrix_sdk::ruma::OwnedUserId;
use matrix_sdk::ruma::events::{AnySyncMessageLikeEvent, AnySyncStateEvent, TimelineEventType};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::{Client, Room};
use matrix_sdk_base::sticky::{StickyEventsUpdate, StickyKey};
use serde_json::Value;
use tokio::sync::broadcast::{
    Receiver,
    error::{RecvError, TryRecvError},
};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use web_time::Instant;

use super::{
    ValidatedInvite,
    invites::{Invitations, Invite},
    notify, sticky,
};
use crate::{Core, protocol::CoreEvent};

type Event = (Room, Value, Instant);

const MAX_ALLOWED: usize = 1_000;

struct WatchedRoom {
    invitations: Invitations,
    sticky: Receiver<StickyEventsUpdate>,
    slot_checked: HashMap<String, Instant>,
    closed_slots: HashSet<String>,
    withdrawn: HashSet<String>,
    /// Whether each sender may notify the room, until power levels change.
    allowed: HashMap<OwnedUserId, bool>,
    members_read: bool,
}

impl WatchedRoom {
    fn new(room: &Room) -> Self {
        Self {
            invitations: Invitations::default(),
            sticky: room.sticky_events().subscribe(),
            slot_checked: HashMap::new(),
            closed_slots: HashSet::new(),
            withdrawn: HashSet::new(),
            allowed: HashMap::new(),
            members_read: false,
        }
    }

    async fn allowed(&mut self, room: &Room, event: &Value) -> bool {
        let Some(sender) = event["sender"]
            .as_str()
            .and_then(|sender| OwnedUserId::try_from(sender).ok())
        else {
            return false;
        };
        if let Some(allowed) = self.allowed.get(&sender) {
            return *allowed;
        }
        let allowed = room
            .power_levels_or_default()
            .await
            .user_can_trigger_room_notification(&sender);
        if self.allowed.len() < MAX_ALLOWED {
            self.allowed.insert(sender, allowed);
        }
        allowed
    }

    fn set_slot(&mut self, slot: &str, content: &Value, received: Instant) {
        self.invitations.slots.insert(
            slot.to_owned(),
            content["status"] == "open" && content["application"]["type"] == "m.call",
        );
        match content["status"].as_str() {
            Some("closed") => {
                self.closed_slots.insert(slot.to_owned());
            }
            Some("open") => {
                self.closed_slots.remove(slot);
            }
            _ => {}
        }
        self.slot_checked.insert(slot.to_owned(), received);
    }

    fn observe_state(&mut self, event: &Value, received: Instant) {
        if super::SLOT_TYPES.contains(&event["type"].as_str().unwrap_or_default())
            && let Some(slot) = event["state_key"].as_str()
        {
            if self
                .slot_checked
                .get(slot)
                .is_some_and(|checked| received < *checked)
            {
                return;
            }
            self.set_slot(slot, &event["content"], received);
        }
    }

    fn reconcile_sticky(&mut self, values: &[Value], now: u64) {
        let mut lagged = false;
        loop {
            match self.sticky.try_recv() {
                Ok(update) => {
                    for (key, _) in update.removed {
                        if !values.iter().any(|value| matches_key(value, &key)) {
                            self.remove_sticky_key(&key, now);
                        }
                    }
                }
                Err(TryRecvError::Lagged(_)) => lagged = true,
                Err(TryRecvError::Empty | TryRecvError::Closed) => break,
            }
        }
        if lagged {
            let ids = values
                .iter()
                .filter_map(|value| value["event_id"].as_str().map(str::to_owned))
                .collect();
            self.invitations.reconcile_snapshot(&ids, now);
        }
    }

    fn remove_sticky_key(&mut self, key: &StickyKey, now: u64) {
        for kind in [
            "m.rtc.invite",
            "m.rtc.notification",
            notify::NOTIFICATION_EVENT_TYPE,
            "m.rtc.decline",
            notify::DECLINE_EVENT_TYPE,
            "m.rtc.member",
            super::membership::RTC_MEMBER_EVENT_TYPE,
        ] {
            if TimelineEventType::from(kind) == key.event_type {
                self.invitations
                    .remove_key(key.sender.as_str(), kind, &key.sticky_key, now);
            }
        }
    }
}

fn matches_key(event: &Value, key: &StickyKey) -> bool {
    event["sender"].as_str() == Some(key.sender.as_str())
        && event["type"]
            .as_str()
            .is_some_and(|kind| TimelineEventType::from(kind) == key.event_type)
        && event["content"]
            .get("sticky_key")
            .or_else(|| event["content"].get("msc4354_sticky_key"))
            .and_then(Value::as_str)
            == Some(key.sticky_key.as_str())
}

async fn enqueue<T>(send: &UnboundedSender<Event>, room: Room, raw: &Raw<T>) {
    let relevant = notify::is_call_event_type(raw)
        || notify::is_call_membership_event_type(raw)
        || raw
            .get_field::<String>("type")
            .ok()
            .flatten()
            .is_some_and(|kind| {
                kind == "m.room.redaction"
                    || kind == "m.room.power_levels"
                    || super::SLOT_TYPES.contains(&kind.as_str())
            });
    if relevant
        && let Ok(value) = serde_json::from_str(raw.json().get())
        && let Some(value) = invite_event(&room, &value).await
    {
        let _ = send.send((room, value, Instant::now()));
    }
}

pub(super) fn watch(core: &Arc<Core>, client: &Client, generation: u64) {
    let (send, receive) = unbounded_channel();
    let messages = send.clone();
    let handler = client.add_event_handler(move |raw: Raw<AnySyncMessageLikeEvent>, room: Room| {
        let send = messages.clone();
        async move {
            enqueue(&send, room, &raw).await;
        }
    });
    core.track_session_handler(client, handler);
    let handler = client.add_event_handler(move |raw: Raw<AnySyncStateEvent>, room: Room| {
        let send = send.clone();
        async move {
            enqueue(&send, room, &raw).await;
        }
    });
    core.track_session_handler(client, handler);
    core.track_session_task(
        spawn(run(core.clone(), client.clone(), generation, receive)).abort_on_drop(),
    );
}

async fn run(
    core: Arc<Core>,
    client: Client,
    generation: u64,
    mut receive: UnboundedReceiver<Event>,
) {
    let mut watcher = Watcher::default();
    let mut updates = client.subscribe_to_all_room_updates();
    loop {
        let mut changed = HashSet::new();
        tokio::select! {
            event = receive.recv() => {
                let Some((room, value, received)) = event else { break; };
                watcher.observe(&room, &value, received).await;
            }
            update = updates.recv() => match update {
                Ok(update) => changed.extend(update.iter_all_room_ids().cloned()),
                Err(RecvError::Lagged(_)) => {
                    changed.extend(client.joined_rooms().iter().map(|room| room.room_id().to_owned()));
                }
                Err(RecvError::Closed) => break,
            },
            () = matrix_sdk::sleep::sleep(Duration::from_secs(1)) => {}
        }
        watcher.step(&core, &client, generation, &changed).await;
    }
}

/// Reads stored call state only for rooms that changed since the last step.
#[derive(Default)]
struct Watcher {
    rooms: HashMap<matrix_sdk::ruma::OwnedRoomId, WatchedRoom>,
}

impl Watcher {
    async fn observe(&mut self, room: &Room, value: &Value, received: Instant) {
        if value["type"] == "m.room.power_levels" {
            if let Some(watched) = self.rooms.get_mut(room.room_id()) {
                watched.allowed.clear();
            }
            return;
        }
        let watched = self
            .rooms
            .entry(room.room_id().to_owned())
            .or_insert_with(|| WatchedRoom::new(room));
        watched.observe_state(value, received);
        let allowed = watched.allowed(room, value).await;
        watched.invitations.apply(value, crate::now_ms(), allowed);
    }

    #[tracing::instrument(skip_all, target = "sable_core::tasks", name = "calls.invite.step")]
    async fn step(
        &mut self,
        core: &Core,
        client: &Client,
        generation: u64,
        changed: &HashSet<matrix_sdk::ruma::OwnedRoomId>,
    ) {
        for room in client.joined_rooms() {
            let values: Vec<_> = sticky::live_events(&room)
                .into_iter()
                .map(sticky::Event::into_value)
                .collect();
            if values.is_empty() && !self.rooms.contains_key(room.room_id()) {
                continue;
            }
            let watched = self
                .rooms
                .entry(room.room_id().to_owned())
                .or_insert_with(|| WatchedRoom::new(&room));
            let reread = !watched.members_read
                || !watched.sticky.is_empty()
                || changed.contains(room.room_id());
            watched.reconcile_sticky(&values, crate::now_ms());
            for value in values {
                let allowed = watched.allowed(&room, &value).await;
                watched.invitations.apply(&value, crate::now_ms(), allowed);
            }
            if reread {
                read_call_members(&room, watched).await;
            }
            reconcile_room(core, &room, watched, generation).await;
        }
        let left: Vec<_> = self
            .rooms
            .keys()
            .filter(|id| {
                !client
                    .get_room(id)
                    .is_some_and(|room| room.state() == matrix_sdk::RoomState::Joined)
            })
            .cloned()
            .collect();
        for id in left {
            if let Some(mut watched) = self.rooms.remove(&id) {
                emit_ended(core, generation, watched.invitations.clear());
            }
        }
    }
}

fn state_value(event: RawAnySyncOrStrippedState) -> Option<Value> {
    match event {
        RawAnySyncOrStrippedState::Sync(raw) => serde_json::from_str(raw.json().get()).ok(),
        RawAnySyncOrStrippedState::Stripped(raw) => serde_json::from_str(raw.json().get()).ok(),
    }
}

async fn cached_state(room: &Room, kind: &str) -> Vec<Value> {
    room.get_state_events(kind.into())
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(state_value)
        .collect()
}

fn slot_types(slot: &str) -> &[&str] {
    if slot == "m.call#room" {
        &["m.rtc.slot"]
    } else {
        &super::SLOT_TYPES
    }
}

async fn refresh_slots(room: &Room, watched: &mut WatchedRoom) {
    for slot in watched.invitations.slots_to_check(crate::now_ms()) {
        let now = Instant::now();
        if watched
            .slot_checked
            .get(&slot)
            .is_some_and(|checked| now.duration_since(*checked) < Duration::from_secs(5))
        {
            continue;
        }
        watched.slot_checked.insert(slot.clone(), now);
        let mut found = None;
        for kind in slot_types(&slot) {
            if let Some(content) = super::fetched_slot(room, kind, &slot).await {
                found = Some(content);
                break;
            }
        }
        if let Some(content) = found {
            watched.set_slot(&slot, &content, now);
        } else {
            watched.invitations.slots.entry(slot).or_insert(false);
        }
    }
}

async fn withdraw_closed(room: &Room, watched: &mut WatchedRoom) {
    for invite in watched
        .invitations
        .outgoing(room.own_user_id().as_str(), crate::now_ms())
    {
        if !watched.closed_slots.contains(&invite.slot)
            || !watched.withdrawn.insert(invite.id.clone())
        {
            continue;
        }
        let stable = invite.event["content"].get("sticky_key").is_some();
        let content = serde_json::json!({if stable { "sticky_key" } else { "msc4354_sticky_key" }: invite.slot});
        let duration = invite
            .event
            .get("sticky")
            .or_else(|| invite.event.get("msc4354_sticky"))
            .and_then(|sticky| sticky["duration_ms"].as_u64())
            .unwrap_or(super::invites::STICKY_MS)
            .clamp(super::invites::STICKY_MS, 3_600_000);
        if room
            .send_raw(
                invite.event["type"]
                    .as_str()
                    .unwrap_or(notify::NOTIFICATION_EVENT_TYPE),
                content,
            )
            .with_sticky_duration(Duration::from_millis(duration))
            .await
            .is_err()
        {
            watched.withdrawn.remove(&invite.id);
        }
    }
}

fn emit_ended(core: &Core, generation: u64, ids: Vec<String>) {
    for id in ids {
        core.emit_if_current(
            generation,
            CoreEvent::IncomingCallEnded {
                notification_event_id: id,
            },
        );
    }
}

async fn present_invite(core: &Core, room: &Room, invite: &Invite, generation: u64) -> bool {
    let Ok(raw) = Raw::new(&invite.event) else {
        return true;
    };
    match room.event_push_actions(&raw).await {
        Ok(Some(actions)) if crate::push_rules::notifies(&actions) => {}
        Ok(Some(_)) => return true,
        Ok(None) | Err(_) => return false,
    }
    let Ok(sender) = matrix_sdk::ruma::UserId::parse(&invite.sender) else {
        return true;
    };
    let sender_name = room
        .get_member_no_sync(&sender)
        .await
        .ok()
        .flatten()
        .and_then(|member| {
            member
                .display_name()
                .and_then(sable_model::text::visible_name)
                .map(str::to_owned)
        });
    let ring = invite.should_ring(
        room.own_user_id().as_str(),
        room.is_direct().await.unwrap_or(false),
    );
    let events: Vec<_> = sticky::live_events(room)
        .into_iter()
        .map(sticky::Event::into_value)
        .collect();
    let has_video = invite.has_video(&events);
    core.emit_if_current(
        generation,
        CoreEvent::IncomingCall {
            room_id: room.room_id().to_owned(),
            notification_event_id: invite.id.clone(),
            sender_name: core.nicknames().name(&sender, sender_name.as_deref()),
            sender,
            room_name: room.cached_display_name().map(|name| name.to_string()),
            ring,
            has_video,
            expires_at_ms: invite.expires,
        },
    );
    true
}

/// Later call members arrive through `observe`.
async fn read_call_members(room: &Room, watched: &mut WatchedRoom) {
    for kind in ["org.matrix.msc3401.call.member", "m.call.member"] {
        for event in cached_state(room, kind).await {
            watched.invitations.apply(&event, crate::now_ms(), false);
        }
    }
    watched.members_read = true;
}

async fn reconcile_room(core: &Core, room: &Room, watched: &mut WatchedRoom, generation: u64) {
    refresh_slots(room, watched).await;
    withdraw_closed(room, watched).await;
    let (starts, ends) = watched
        .invitations
        .reconcile(room.own_user_id().as_str(), crate::now_ms());
    emit_ended(core, generation, ends);
    for invite in starts {
        if !present_invite(core, room, &invite, generation).await {
            watched.invitations.retry(&invite.id);
        }
    }
}

// Megolm decryption omits the outer sticky envelope. Recover it before deciding
// whether a deployed invitation used the regular-event fallback.
pub(super) async fn invite_event(room: &Room, event: &Value) -> Option<Value> {
    let mut event = event.clone();
    if !matches!(
        event["type"].as_str(),
        Some("m.rtc.invite" | "m.rtc.notification" | notify::NOTIFICATION_EVENT_TYPE)
    ) || event["content"].get("slot_id").is_none()
        || event.get("sticky").is_some()
        || event.get("msc4354_sticky").is_some()
    {
        return Some(event);
    }
    if let Some(current) = sticky::live_events(room)
        .into_iter()
        .map(sticky::Event::into_value)
        .find(|current| current["event_id"] == event["event_id"])
    {
        return Some(current);
    }
    let id = matrix_sdk::ruma::EventId::parse(event["event_id"].as_str()?).ok()?;
    let response = room
        .client()
        .send(
            matrix_sdk::ruma::api::client::room::get_room_event::v3::Request::new(
                room.room_id().to_owned(),
                id,
            ),
        )
        .await
        .ok()?;
    let source: Value = serde_json::from_str(response.event.json().get()).ok()?;
    if source["event_id"] != event["event_id"]
        || source["sender"] != event["sender"]
        || source["unsigned"].get("redacted_because").is_some()
    {
        return None;
    }
    for field in ["sticky", "msc4354_sticky"] {
        if let Some(value) = source.get(field) {
            event[field] = value.clone();
        }
    }
    Some(event)
}

pub(super) async fn active_invite(
    room: &Room,
    event: &Value,
) -> Option<(super::invites::Invite, Vec<Value>)> {
    let now = crate::now_ms();
    let event = &invite_event(room, event).await?;
    let modern = Invite::parse(event, now)?.modern;
    let mut values = if modern {
        let mut sync = sticky::StickySync::for_invites();
        let events = sync.sync(room, Duration::ZERO).await.ok()?;
        events
            .into_iter()
            .map(sticky::Event::into_value)
            .collect::<Vec<_>>()
    } else {
        let mut values: Vec<_> = sticky::live_events(room)
            .into_iter()
            .map(sticky::Event::into_value)
            .collect();
        values.push(event.clone());
        values
    };
    let candidate = values
        .iter()
        .find(|value| value["event_id"] == event["event_id"])?;
    let parsed = super::invites::Invite::parse(candidate, now)?;
    if parsed.modern
        && !values.iter().any(|value| {
            super::SLOT_TYPES.contains(&value["type"].as_str().unwrap_or_default())
                && value["state_key"] == parsed.slot
        })
    {
        for event_type in slot_types(&parsed.slot) {
            if let Some(content) = super::fetched_slot(room, event_type, &parsed.slot).await {
                values.push(serde_json::json!({"type":event_type, "state_key":parsed.slot, "content":content}));
                break;
            }
        }
    }
    if !modern {
        for event_type in [
            "m.room.create",
            "m.room.power_levels",
            "org.matrix.msc3401.call.member",
            "m.call.member",
        ] {
            values.extend(cached_state(room, event_type).await);
        }
    }
    let invite = sable_model::rtc_invites::validate_snapshot(
        event,
        &values,
        room.own_user_id().as_str(),
        now,
    )?;
    Some((invite, values))
}

pub(crate) async fn validate_invite(room: &Room, event: &Value) -> Option<ValidatedInvite> {
    let (invite, values) = active_invite(room, event).await?;
    let Ok(raw) = Raw::new(event) else {
        return None;
    };
    if !room
        .event_push_actions(&raw)
        .await
        .ok()
        .flatten()
        .is_some_and(|actions| crate::push_rules::notifies(&actions))
    {
        return None;
    }
    let presentation = sable_model::rtc_invites::InvitePresentation::from_invite(&invite, &values)?;
    Some(ValidatedInvite {
        ring: invite.should_ring(
            room.own_user_id().as_str(),
            room.is_direct().await.unwrap_or(false),
        ),
        has_video: presentation.has_video,
        expires_at_ms: presentation.expires_at_ms,
    })
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::room_id;
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };

    use std::collections::HashSet;

    use super::{WatchedRoom, Watcher, refresh_slots};
    use crate::store_reads::counting_client;

    async fn cached_open_room(server: &MatrixMockServer) -> matrix_sdk::Room {
        let client = server.client_builder().build().await;
        let room_id = room_id!("!slot:example.org");
        server.sync_room(&client, JoinedRoomBuilder::new(room_id).add_state_event(
            matrix_sdk::ruma::serde::Raw::new(&json!({
                "type":"m.rtc.slot", "event_id":"$cached", "sender":client.user_id().unwrap(),
                "state_key":"m.call#room", "origin_server_ts":1,
                "content":{"status":"open", "application":{"type":"m.call"}}
            })).unwrap().cast_unchecked(),
        )).await
    }

    #[tokio::test]
    async fn decrypted_invites_recover_their_original_sticky_envelope() {
        let server = MatrixMockServer::new().await;
        let room = cached_open_room(&server).await;
        let now = crate::now_ms();
        let clear = json!({"type":"org.matrix.msc4075.rtc.notification", "event_id":"$encrypted",
            "sender":"@caller:example.org", "origin_server_ts":now,
            "content":{"slot_id":"m.call#ROOM", "msc4354_sticky_key":"m.call#ROOM",
                "sender_ts":now,"lifetime":90000,"notification_type":"ring",
                "m.mentions":{"user_ids":[room.own_user_id()]}}});
        for (sticky, redacted) in [(true, false), (false, false), (false, true)] {
            let mut source = json!({"type":"m.room.encrypted", "event_id":"$encrypted",
                "sender":"@caller:example.org", "content":{"ciphertext":"encrypted"}});
            if sticky {
                source["msc4354_sticky"] = json!({"duration_ms":300_000});
            }
            if redacted {
                source["unsigned"] = json!({"redacted_because":{"type":"m.room.redaction"}});
            }
            let guard = Mock::given(method("GET"))
                .and(path(format!(
                    "/_matrix/client/v3/rooms/{}/event/$encrypted",
                    room.room_id()
                )))
                .respond_with(ResponseTemplate::new(200).set_body_json(source))
                .mount_as_scoped(server.server())
                .await;
            let recovered = super::invite_event(&room, &clear).await;
            if redacted {
                assert!(recovered.is_none());
            } else {
                let recovered = recovered.unwrap();
                assert_eq!(
                    super::Invite::parse(&recovered, now).unwrap().modern,
                    sticky
                );
                assert_eq!(recovered["content"], clear["content"]);
            }
            drop(guard);
        }
    }

    fn pending(room: &matrix_sdk::Room) -> WatchedRoom {
        let mut watched = WatchedRoom::new(room);
        let now = crate::now_ms();
        watched.invitations.apply(
            &json!({
                "type":"m.rtc.invite", "event_id":"$invite", "sender":"@caller:example.org",
                "origin_server_ts":now, "sticky":{"duration_ms":300_000},
                "content":{"slot_id":"m.call#room", "sticky_key":"m.call#room", "sender_ts":now,
                    "lifetime":90_000, "m.mentions":{"user_ids":[room.own_user_id()]}}
            }),
            now,
            false,
        );
        watched
    }

    #[tokio::test]
    async fn a_fresh_slot_closure_overrides_cached_open_state() {
        let server = MatrixMockServer::new().await;
        let room = cached_open_room(&server).await;
        let mut watched = pending(&room);
        watched
            .invitations
            .slots
            .insert("m.call#room".to_owned(), true);
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{}/state/m.rtc.slot/m.call%23room",
                room.room_id()
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status":"closed"})))
            .expect(1)
            .mount(server.server())
            .await;

        refresh_slots(&room, &mut watched).await;
        assert_eq!(watched.invitations.slots.get("m.call#room"), Some(&false));
        assert!(watched.closed_slots.contains("m.call#room"));
        refresh_slots(&room, &mut watched).await;
        assert_eq!(watched.invitations.slots.get("m.call#room"), Some(&false));
    }

    #[tokio::test]
    async fn a_failed_initial_slot_refresh_does_not_trust_cached_open_state() {
        let server = MatrixMockServer::new().await;
        let room = cached_open_room(&server).await;
        let mut watched = pending(&room);
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{}/state/m.rtc.slot/m.call%23room",
                room.room_id()
            )))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(server.server())
            .await;

        refresh_slots(&room, &mut watched).await;
        assert_eq!(watched.invitations.slots.get("m.call#room"), Some(&false));
        assert!(!watched.closed_slots.contains("m.call#room"));
        assert!(
            watched
                .invitations
                .reconcile(room.own_user_id().as_str(), crate::now_ms())
                .0
                .is_empty()
        );
    }

    async fn watched_call_room(
        server: &MatrixMockServer,
        client: &matrix_sdk::Client,
    ) -> matrix_sdk::Room {
        let room_id = room_id!("!call:example.org");
        server
            .sync_room(
                client,
                JoinedRoomBuilder::new(room_id).add_state_event(
                    matrix_sdk::ruma::serde::Raw::new(&json!({
                        "type":"org.matrix.msc3401.call.member", "event_id":"$member",
                        "sender":"@caller:example.org", "state_key":"@caller:example.org",
                        "origin_server_ts":1, "content":{}
                    }))
                    .unwrap()
                    .cast_unchecked(),
                ),
            )
            .await
    }

    #[tokio::test]
    async fn a_watched_room_reads_its_call_state_once_until_it_changes() {
        let server = MatrixMockServer::new().await;
        let (client, reads) = counting_client(&server).await;
        let (core, _events) = crate::test_support::signed_in_core(&server, client.clone()).await;
        let room = watched_call_room(&server, &client).await;
        let mut watcher = Watcher::default();
        watcher
            .observe(
                &room,
                &json!({"type":"m.rtc.decline", "sender":"@caller:example.org"}),
                web_time::Instant::now(),
            )
            .await;

        reads.reset();
        watcher.step(&core, &client, 0, &HashSet::new()).await;
        assert_eq!(
            reads.state(),
            2,
            "the first pass reads both call member types"
        );

        reads.reset();
        for _ in 0..10 {
            watcher.step(&core, &client, 0, &HashSet::new()).await;
        }
        let other = room_id!("!other:example.org").to_owned();
        watcher
            .step(&core, &client, 0, &HashSet::from([other]))
            .await;
        assert_eq!(
            reads.state(),
            0,
            "ticks and other rooms' updates stay in memory"
        );

        watcher
            .step(
                &core,
                &client,
                0,
                &HashSet::from([room.room_id().to_owned()]),
            )
            .await;
        assert_eq!(
            reads.state(),
            2,
            "an update to the room reads its call state again"
        );
    }

    #[tokio::test]
    async fn power_levels_alone_do_not_start_watching_a_room() {
        let server = MatrixMockServer::new().await;
        let (client, reads) = counting_client(&server).await;
        let (core, _events) = crate::test_support::signed_in_core(&server, client.clone()).await;
        let room = server
            .sync_joined_room(&client, room_id!("!quiet:example.org"))
            .await;
        let mut watcher = Watcher::default();
        watcher
            .observe(
                &room,
                &json!({"type":"m.room.power_levels"}),
                web_time::Instant::now(),
            )
            .await;

        reads.reset();
        watcher.step(&core, &client, 0, &HashSet::new()).await;
        assert_eq!(reads.state(), 0);
    }

    #[tokio::test]
    async fn a_sender_permission_is_read_once_until_power_levels_change() {
        let server = MatrixMockServer::new().await;
        let (client, reads) = counting_client(&server).await;
        let room = watched_call_room(&server, &client).await;
        let mut watcher = Watcher::default();
        let decline = json!({"type":"m.rtc.decline", "sender":"@caller:example.org"});

        reads.reset();
        for _ in 0..5 {
            watcher
                .observe(&room, &decline, web_time::Instant::now())
                .await;
        }
        let first = reads.state();
        assert!(first > 0, "the first event reads power levels");

        watcher
            .observe(
                &room,
                &json!({"type":"m.room.power_levels"}),
                web_time::Instant::now(),
            )
            .await;
        watcher
            .observe(&room, &decline, web_time::Instant::now())
            .await;
        assert_eq!(
            reads.state(),
            first * 2,
            "new power levels are read once more"
        );
    }

    #[tokio::test]
    async fn a_queued_old_slot_event_cannot_reopen_a_freshly_closed_slot() {
        let server = MatrixMockServer::new().await;
        let room = cached_open_room(&server).await;
        let mut watched = pending(&room);
        let received = web_time::Instant::now();
        watched.set_slot(
            "m.call#room",
            &json!({"status":"closed"}),
            received + std::time::Duration::from_millis(1),
        );
        let open = json!({"type":"m.rtc.slot", "state_key":"m.call#room",
            "content":{"status":"open", "application":{"type":"m.call"}}});
        watched.observe_state(&open, received);
        assert_eq!(watched.invitations.slots.get("m.call#room"), Some(&false));
        watched.observe_state(&open, received + std::time::Duration::from_millis(2));
        assert_eq!(watched.invitations.slots.get("m.call#room"), Some(&true));
    }
}
