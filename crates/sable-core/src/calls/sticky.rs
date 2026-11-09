use std::time::Duration;

use crate::delayed_events::DelayedEventsSupport;
use matrix_sdk::deserialized_responses::{EncryptionInfo, VerificationLevel, VerificationState};
use matrix_sdk::{Client, Room};
use ruma::api::client::sync::sync_events::v5;
use ruma::events::{StateEventType, room::encrypted::OriginalSyncRoomEncryptedEvent};
use ruma::serde::Raw;
use ruma::{OwnedDeviceId, OwnedEventId};
use serde_json::Value;

pub(super) const STICKY_DURATION_MS: u32 = 3_600_000;

pub(super) struct StickySync {
    conn_id: String,
    include_invite_state: bool,
    pos: Option<String>,
    since: Option<String>,
    pending: Vec<(Value, u64)>,
}

pub(crate) struct Event {
    value: Value,
    device: Option<OwnedDeviceId>,
    redacts: Option<OwnedEventId>,
}

fn redaction_target(room: &Room, value: &Value) -> Option<OwnedEventId> {
    if value.get("type")?.as_str()? != "m.room.redaction" {
        return None;
    }
    let event: ruma::events::room::redaction::SyncRoomRedactionEvent =
        serde_json::from_value(value.clone()).ok()?;
    event
        .redacts(&room.clone_info().room_version_rules_or_default().redaction)
        .map(ToOwned::to_owned)
}

fn authenticated_device(info: Option<&EncryptionInfo>, value: &Value) -> Option<OwnedDeviceId> {
    let info = info?;
    if value.get("sender")?.as_str()? != info.sender.as_str() {
        return None;
    }
    match &info.verification_state {
        VerificationState::Verified
        | VerificationState::Unverified(
            VerificationLevel::UnverifiedIdentity | VerificationLevel::UnsignedDevice,
        ) => info.sender_device.clone(),
        VerificationState::Unverified(_) => None,
    }
}

impl Event {
    pub(crate) fn into_value(self) -> Value {
        self.value
    }
    pub(crate) fn apply(
        &self,
        memberships: &mut super::membership::StickyMemberships,
        encrypted: bool,
        now: u64,
    ) -> bool {
        if let Some(event_id) = &self.redacts {
            memberships.redact(event_id.as_str(), now);
            return true;
        }
        if encrypted {
            let Some(device) = &self.device else {
                return memberships.apply_untrusted(&self.value, now);
            };
            memberships.apply_authenticated(&self.value, device, now)
        } else {
            memberships.apply(&self.value, now)
        }
    }
}

impl StickySync {
    pub(super) fn new(session: u32) -> Self {
        Self {
            conn_id: format!("call-{session}"),
            include_invite_state: false,
            pos: None,
            since: None,
            pending: Vec::new(),
        }
    }

    pub(super) fn for_invites() -> Self {
        Self {
            conn_id: format!("call-invites-{}", ruma::TransactionId::new()),
            include_invite_state: true,
            pos: None,
            since: None,
            pending: Vec::new(),
        }
    }

    fn request(&self, room: &Room, timeout: Duration) -> v5::Request {
        let mut request = v5::Request::new();
        request.pos.clone_from(&self.pos);
        request.conn_id = Some(self.conn_id.clone());
        request.timeout = Some(timeout);
        let mut subscription = v5::request::RoomSubscription::default();
        subscription
            .required_state
            .push((StateEventType::RoomCreate, String::new()));
        if self.include_invite_state {
            for event_type in super::SLOT_TYPES {
                subscription
                    .required_state
                    .push((event_type.into(), "*".to_owned()));
            }
            subscription
                .required_state
                .push(("org.matrix.msc3401.call.member".into(), "*".to_owned()));
            subscription
                .required_state
                .push((StateEventType::RoomPowerLevels, String::new()));
        }
        request
            .room_subscriptions
            .insert(room.room_id().to_owned(), subscription);
        request.extensions.to_device.enabled = Some(false);
        request.extensions.sticky_events.enabled = Some(true);
        request
            .extensions
            .sticky_events
            .since
            .clone_from(&self.since);
        request
    }

    pub(super) async fn sync(
        &mut self,
        room: &Room,
        timeout: Duration,
    ) -> Result<Vec<Event>, matrix_sdk::HttpError> {
        let response = match room.client().send(self.request(room, timeout)).await {
            Ok(response) => response,
            Err(error) => {
                self.pos = None;
                self.since = None;
                return Err(error);
            }
        };
        let sticky = response.extensions.sticky_events;
        self.pos = Some(response.pos);
        if sticky.next_batch.is_some() {
            self.since = sticky.next_batch;
        }
        let mut events: Vec<Value> = Vec::new();
        if let Some(room_events) = sticky.rooms.get(room.room_id()) {
            events.extend(
                room_events
                    .events
                    .iter()
                    .filter_map(|event| serde_json::from_str(event.json().get()).ok()),
            );
        }
        if let Some(room_events) = response.rooms.get(room.room_id()) {
            if self.include_invite_state {
                events.extend(
                    room_events
                        .required_state
                        .iter()
                        .filter_map(|event| serde_json::from_str(event.json().get()).ok()),
                );
            }
            events.extend(
                room_events
                    .timeline
                    .iter()
                    .filter_map(|event| serde_json::from_str(event.json().get()).ok()),
            );
        }
        let now = crate::now_ms();
        let mut candidates = std::mem::take(&mut self.pending);
        candidates.retain(|(_, expires)| *expires > now);
        for value in events {
            let expires = sticky_expiry(&value, now);
            candidates.push((value, expires));
        }
        let mut resolved = Vec::new();
        for (value, expires) in candidates {
            if value.get("type").and_then(Value::as_str) != Some("m.room.encrypted") {
                resolved.push(Event {
                    redacts: redaction_target(room, &value),
                    value,
                    device: None,
                });
                continue;
            }
            if expires <= now
                || (value.get("msc4354_sticky").is_none() && value.get("sticky").is_none())
            {
                continue;
            }
            if let Some(event) = self.decrypt_candidate(room, value, expires, now).await {
                resolved.push(event);
            }
        }
        Ok(resolved)
    }

    async fn decrypt_candidate(
        &mut self,
        room: &Room,
        value: Value,
        expires: u64,
        now: u64,
    ) -> Option<Event> {
        let raw = Raw::new(&value)
            .map(Raw::cast_unchecked::<OriginalSyncRoomEncryptedEvent>)
            .ok()?;
        let Ok(decrypted) = room.decrypt_event(&raw, None).await else {
            self.defer(value, expires);
            return None;
        };
        let Some(info) = decrypted.encryption_info() else {
            self.defer(value, expires);
            return None;
        };
        let mut plaintext = serde_json::from_str::<Value>(decrypted.raw().json().get()).ok()?;
        if let Some(object) = plaintext.as_object_mut() {
            for field in ["msc4354_sticky", "sticky"] {
                if let Some(envelope) = value.get(field) {
                    object.insert(field.to_owned(), envelope.clone());
                }
            }
            let unsigned = object
                .entry("unsigned")
                .or_insert_with(|| serde_json::json!({}));
            if let Some(unsigned) = unsigned.as_object_mut() {
                unsigned.insert(
                    "msc4354_sticky_duration_ttl_ms".to_owned(),
                    expires.saturating_sub(now).into(),
                );
            }
        }
        let device = authenticated_device(Some(info), &plaintext);
        Some(Event {
            value: plaintext,
            device,
            redacts: None,
        })
    }

    fn defer(&mut self, value: Value, expires: u64) {
        if self.pending.len() < 1024 {
            self.pending.push((value, expires));
        }
    }
}

fn sticky_expiry(value: &Value, now: u64) -> u64 {
    let duration = value
        .get("msc4354_sticky")
        .or_else(|| value.get("sticky"))
        .and_then(|sticky| sticky.get("duration_ms"))
        .and_then(Value::as_u64)
        .unwrap_or(3_600_000)
        .min(3_600_000);
    let sent = value
        .get("origin_server_ts")
        .and_then(Value::as_u64)
        .unwrap_or(now)
        .min(now);
    let ttl = value
        .get("unsigned")
        .and_then(|u| {
            u.get("msc4354_sticky_duration_ttl_ms")
                .or_else(|| u.get("sticky_duration_remaining_ms"))
                .or_else(|| u.get("sticky_duration_ttl_ms"))
        })
        .and_then(Value::as_u64);
    ttl.map_or_else(
        || sent.saturating_add(duration),
        |ttl| now.saturating_add(ttl.min(duration)),
    )
}

pub(crate) fn live_events(room: &Room) -> Vec<Event> {
    room.sticky_events()
        .live()
        .iter()
        .filter_map(|event| {
            let object: serde_json::Map<String, Value> =
                serde_json::from_str(event.raw().json().get()).ok()?;
            let sticky = if object.contains_key("msc4354_sticky") || object.contains_key("sticky") {
                None
            } else {
                let sent = object.get("origin_server_ts").and_then(Value::as_u64)?;
                let expires = u64::from(event.expires_at.get());
                Some(StickyOut {
                    duration_ms: expires.saturating_sub(sent),
                })
            };
            let value = serde_json::to_value(StampedEventOut {
                event: object,
                msc4354_sticky: sticky,
            })
            .ok()?;
            let device = authenticated_device(event.encryption_info().map(AsRef::as_ref), &value);
            Some(Event {
                value,
                device,
                redacts: None,
            })
        })
        .collect()
}

#[derive(serde::Serialize)]
struct StickyOut {
    duration_ms: u64,
}

/// Only stamped when the event lacks both sticky keys, so `event` never
/// carries the key that `msc4354_sticky` would override.
#[derive(serde::Serialize)]
struct StampedEventOut {
    #[serde(flatten)]
    event: serde_json::Map<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    msc4354_sticky: Option<StickyOut>,
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum LeaveCode {
    Leave,
    DelayedLeave,
    SlotClosed,
}

#[derive(serde::Serialize)]
struct LeaveMember {
    id: Option<String>,
    membership: &'static str,
}

#[derive(serde::Serialize)]
struct LeaveReason {
    code: LeaveCode,
}

#[derive(serde::Serialize)]
pub(super) struct LeaveOut {
    slot_id: &'static str,
    member: LeaveMember,
    leave_reason: LeaveReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    msc4354_sticky_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sticky_key: Option<String>,
}

impl LeaveOut {
    #[cfg(test)]
    pub(super) fn new(member_id: Option<String>, code: LeaveCode) -> Self {
        Self::for_wire(member_id, code, super::membership::RtcWire::Deployed)
    }

    pub(super) fn for_wire(
        member_id: Option<String>,
        code: LeaveCode,
        wire: super::membership::RtcWire,
    ) -> Self {
        Self {
            slot_id: wire.slot(),
            member: LeaveMember {
                id: member_id.clone(),
                membership: "leave",
            },
            leave_reason: LeaveReason { code },
            msc4354_sticky_key: (wire == super::membership::RtcWire::Deployed)
                .then(|| member_id.clone())
                .flatten(),
            sticky_key: (wire == super::membership::RtcWire::Stable)
                .then_some(member_id)
                .flatten(),
        }
    }
}

#[cfg(test)]
pub(super) async fn send(
    _client: &Client,
    room: &Room,
    content: impl serde::Serialize,
) -> Result<ruma::OwnedEventId, matrix_sdk::Error> {
    send_wire(room, content, super::membership::RtcWire::Deployed).await
}

pub(super) async fn send_wire(
    room: &Room,
    content: impl serde::Serialize,
    wire: super::membership::RtcWire,
) -> Result<ruma::OwnedEventId, matrix_sdk::Error> {
    let content = serde_json::to_value(content)?;
    match room.latest_encryption_state().await? {
        matrix_sdk::EncryptionState::NotEncrypted => {}
        state if state.is_encrypted() => {}
        _ => return Err(matrix_sdk::Error::InsufficientData),
    }
    Ok(room
        .send_raw(
            if wire == super::membership::RtcWire::Stable {
                "m.rtc.member"
            } else {
                super::membership::RTC_MEMBER_EVENT_TYPE
            },
            content,
        )
        .with_sticky_duration(Duration::from_millis(STICKY_DURATION_MS.into()))
        .await?
        .response
        .event_id)
}

#[cfg(test)]
pub(super) async fn send_delayed(
    client: &Client,
    support: DelayedEventsSupport,
    room: &Room,
    content: impl serde::Serialize,
    delay: Duration,
) -> Result<String, matrix_sdk::Error> {
    send_delayed_event(
        client,
        support,
        room,
        super::membership::RTC_MEMBER_EVENT_TYPE,
        content,
        delay,
        STICKY_DURATION_MS,
    )
    .await
}

pub(crate) async fn send_delayed_event(
    client: &Client,
    support: DelayedEventsSupport,
    room: &Room,
    event_type: &str,
    content: impl serde::Serialize,
    delay: Duration,
    duration_ms: u32,
) -> Result<String, matrix_sdk::Error> {
    let content = serde_json::value::to_raw_value(&content)?;
    let (event_type, content) = match room.latest_encryption_state().await? {
        matrix_sdk::EncryptionState::NotEncrypted => (event_type.to_owned(), content),
        state if state.is_encrypted() => {
            let raw = Raw::<ruma::events::AnyMessageLikeEventContent>::from_json(content);
            let encrypted = Box::pin(room.encrypt_raw_event(event_type, &raw)).await?;
            ("m.room.encrypted".to_owned(), encrypted.into_json())
        }
        _ => return Err(matrix_sdk::Error::InsufficientData),
    };
    let event = crate::delayed_events::DelayedEvent {
        room_id: room.room_id().to_owned(),
        event_type,
        state_key: None,
        content,
        delay,
        sticky_duration_ms: Some(duration_ms),
    };
    Ok(crate::delayed_events::send(client, support, event).await?)
}

#[cfg(test)]
#[path = "sticky_tests.rs"]
mod tests;
