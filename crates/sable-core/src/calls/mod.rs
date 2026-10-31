mod invite_service;
mod invites;
mod keys;
mod membership;
mod notify;
pub(crate) use invite_service::validate_invite;

pub(crate) struct ValidatedInvite {
    pub(crate) ring: bool,
    pub(crate) has_video: bool,
    pub(crate) expires_at_ms: u64,
}

#[cfg(test)]
mod invite_delivery_tests;
#[cfg(test)]
mod notify_sdk_tests;

#[cfg(test)]
pub(crate) use notify::NOTIFICATION_EVENT_TYPE;
pub(crate) use notify::{is_call_event_type, is_call_membership_event_type};
mod runtime;
pub(crate) use runtime::State as CallRuntimeState;
mod sfu;
pub(crate) mod sticky;

use crate::api::calls::DeclineParams;
use crate::api::calls::SetScreenSharingParams;
use crate::api::calls::SupportParams;
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::api::client::delayed_events::update_delayed_event::UpdateAction;
use matrix_sdk::ruma::api::client::rtc::RtcTransport;
use matrix_sdk::ruma::api::client::state::get_state_event_for_key;
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::events::call::member::{CallMemberEventContent, CallMemberStateKey};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{DeviceId, EventId, OwnedRoomId, OwnedUserId, UserId};
use matrix_sdk::{Client, Room};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_with::{DefaultOnError, serde_as};

use crate::ResultExt;
use crate::api::calls::JoinOk;
use crate::delayed_events::{self, DelayedEvent, DelayedEventsSupport};
use crate::protocol::{
    CallCompatibilityView, CallMemberView, CallMode, CallSessionId, CallSupportView, RpcError,
    RtcTransportSource,
};
use crate::{CallSession, Core};

use membership::CallMember;
use sfu::ProvisionError;

mod transport_discovery {
    use ruma::api::{auth_scheme::AccessToken, request, response};
    use ruma::metadata;

    metadata! {
        method: GET,
        rate_limited: false,
        authentication: AccessToken,
        history: {
            unstable => "/_matrix/client/unstable/org.matrix.msc4143/rtc/transports",
            stable("org.matrix.msc4143.stable") => "/_matrix/client/v1/rtc/transports",
        }
    }

    #[request]
    pub struct Request {}

    #[response]
    pub struct Response {
        #[serde(default)]
        pub transports: Vec<ruma::api::client::rtc::RtcTransport>,
        #[serde(default)]
        pub rtc_transports: Vec<ruma::api::client::rtc::RtcTransport>,
    }
}

async fn stable_transports(client: &Client) -> Vec<String> {
    let Ok(response) = client.send(transport_discovery::Request {}).await else {
        return Vec::new();
    };
    response
        .transports
        .iter()
        .chain(&response.rtc_transports)
        .filter_map(|transport| {
            (transport.transport_type() == "m.livekit")
                .then(|| {
                    transport
                        .data()
                        .get("url")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .flatten()
        })
        .filter(|url| url::Url::parse(url).is_ok_and(|url| url.scheme() == "wss"))
        .collect()
}

const HANGUP_DELAY: Duration = Duration::from_secs(20);
const HANGUP_POSTPONE_INTERVAL: Duration = Duration::from_secs(5);

pub(crate) struct DelayState {
    id: Option<String>,
    active: bool,
    lost: bool,
}
const HANGUP_RETRY_BACKOFF: Duration = Duration::from_secs(1);
const HANGUP_RETRY_BUDGET: Duration = Duration::from_secs(12);
const USE_KEY_DELAY: Duration = Duration::from_millis(keys::USE_KEY_DELAY_MS);

#[derive(Debug, PartialEq, Eq)]
enum Postponed {
    Restarted,
    Gone,
    Unreachable,
}

const APPLICATION_SUFFIX: &str = "m.call";

fn pick_focus(
    advertised: &[String],
    discovered: &[String],
    configured: Option<String>,
) -> Option<String> {
    advertised
        .iter()
        .chain(discovered)
        .find(|url| !url.trim().is_empty())
        .cloned()
        .or_else(|| configured.filter(|url| !url.trim().is_empty()))
}

#[expect(
    deprecated,
    reason = "calls still get their token from the JWT service of the earlier MSC4195"
)]
fn livekit_service_urls(transports: Vec<RtcTransport>) -> Vec<String> {
    transports
        .into_iter()
        .filter_map(|transport| match transport {
            RtcTransport::LiveKit(livekit) => livekit.service_url,
            _ => None,
        })
        .filter(|url| !url.trim().is_empty())
        .collect()
}

async fn discovered_service_urls(client: &Client) -> Vec<String> {
    let endpoint = client
        .discover_rtc_transports()
        .await
        .ok()
        .flatten()
        .map(livekit_service_urls)
        .unwrap_or_default();
    if !endpoint.is_empty() {
        return endpoint;
    }

    client
        .well_known_rtc_transports()
        .await
        .map(livekit_service_urls)
        .unwrap_or_default()
}

const SLOT_TYPES: [&str; 2] = [crate::view::RTC_SLOT_TYPE, "m.rtc.slot"];

#[serde_as]
#[derive(Default, Deserialize)]
struct SlotRead {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    status: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    application: Option<ApplicationRead>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    encryption: Option<EncryptionRead>,
    #[serde(skip)]
    encryption_present: bool,
}

#[serde_as]
#[derive(Deserialize)]
struct EncryptionRead {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

#[serde_as]
#[derive(Deserialize)]
struct ApplicationRead {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

fn read_slot(content: &Value) -> SlotRead {
    let mut slot = SlotRead::deserialize(content).unwrap_or_default();
    slot.encryption_present = content.get("encryption").is_some();
    slot
}

fn slot_is_open(slot: &SlotRead, encrypted: bool) -> bool {
    slot.status.as_deref() == Some("open")
        && slot
            .application
            .as_ref()
            .and_then(|application| application.kind.as_deref())
            == Some(APPLICATION_SUFFIX)
        && (!encrypted
            || slot
                .encryption
                .as_ref()
                .and_then(|encryption| encryption.kind.as_deref())
                .is_some_and(supported_slot_encryption))
}

fn slot_is_compatible(slot: &SlotRead, encrypted: bool, wire: membership::RtcWire) -> bool {
    slot_is_open(slot, encrypted)
        && (wire != membership::RtcWire::Stable
            || if encrypted {
                slot.encryption
                    .as_ref()
                    .and_then(|value| value.kind.as_deref())
                    == Some("m.per_member")
            } else {
                !slot.encryption_present
            })
}

fn supported_slot_encryption(kind: &str) -> bool {
    matches!(kind, "org.matrix.msc4143.per_member" | "m.per_member")
}

fn slot_has_unknown_encryption(slot: &SlotRead, encrypted: bool) -> bool {
    encrypted
        && slot.status.as_deref() == Some("open")
        && slot
            .encryption
            .as_ref()
            .and_then(|encryption| encryption.kind.as_deref())
            .is_some_and(|kind| !supported_slot_encryption(kind))
}

async fn stored_slot(room: &Room, event_type: &str, slot_id: &str) -> Option<Value> {
    let raw = room
        .get_state_event(event_type.into(), slot_id)
        .await
        .ok()
        .flatten()?;
    let content = match raw {
        RawAnySyncOrStrippedState::Sync(event) => event.get_field("content"),
        RawAnySyncOrStrippedState::Stripped(event) => event.get_field("content"),
    };
    content.ok().flatten()
}

async fn fetched_slot(room: &Room, event_type: &str, slot_id: &str) -> Option<Value> {
    let response = room
        .client()
        .send(get_state_event_for_key::v3::Request::new(
            room.room_id().to_owned(),
            event_type.into(),
            slot_id.to_owned(),
        ))
        .await
        .ok()?;
    let value = serde_json::from_str::<Value>(response.event_or_content.get()).ok()?;
    Some(value.get("content").cloned().unwrap_or(value))
}

async fn existing_slot(room: &Room, encrypted: bool, wire: membership::RtcWire) -> (bool, bool) {
    let mut unsupported = false;
    for event_type in SLOT_TYPES {
        if wire == membership::RtcWire::Stable && event_type != "m.rtc.slot" {
            continue;
        }
        let content = match stored_slot(room, event_type, wire.slot()).await {
            Some(content) => Some(content),
            None => fetched_slot(room, event_type, wire.slot()).await,
        };
        if let Some(content) = content {
            let slot = read_slot(&content);
            if slot_is_compatible(&slot, encrypted, wire) {
                return (true, unsupported);
            }
            unsupported |= slot_has_unknown_encryption(&slot, encrypted);
        }
    }
    (false, unsupported)
}

pub(super) async fn slot_closed(room: &Room, encrypted: bool, wire: membership::RtcWire) -> bool {
    let mut closed = false;
    for event_type in SLOT_TYPES {
        if wire == membership::RtcWire::Stable && event_type != "m.rtc.slot" {
            continue;
        }
        let content = match stored_slot(room, event_type, wire.slot()).await {
            Some(content) => Some(content),
            None => fetched_slot(room, event_type, wire.slot()).await,
        };
        if let Some(content) = content {
            let slot = read_slot(&content);
            if slot_is_compatible(&slot, encrypted, wire) {
                return false;
            }
            closed |= matches!(slot.status.as_deref(), Some("closed" | "open"));
        }
    }
    closed || wire == membership::RtcWire::Stable
}

#[derive(Serialize)]
enum SlotStatus {
    #[serde(rename = "open")]
    Open,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum SlotApplication {
    #[serde(rename = "m.call")]
    Call,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum SlotEncryption {
    #[serde(rename = "org.matrix.msc4143.per_member")]
    PerMember,
    #[serde(rename = "m.per_member")]
    StablePerMember,
}

#[derive(Serialize)]
pub(crate) struct OpenSlot {
    status: SlotStatus,
    application: SlotApplication,
    #[serde(skip_serializing_if = "Option::is_none")]
    encryption: Option<SlotEncryption>,
}

impl OpenSlot {
    pub(crate) const fn new(encrypted: bool) -> Self {
        Self {
            status: SlotStatus::Open,
            application: SlotApplication::Call,
            encryption: if encrypted {
                Some(SlotEncryption::PerMember)
            } else {
                None
            },
        }
    }
}

pub(super) async fn ensure_open_slot(
    room: &Room,
    encrypted: bool,
    wire: membership::RtcWire,
) -> bool {
    let (open, unsupported) = existing_slot(room, encrypted, wire).await;
    if open {
        return true;
    }
    if unsupported {
        return false;
    }
    let client = room.client();
    let Some(user_id) = client.user_id() else {
        return false;
    };
    let event_type = if wire == membership::RtcWire::Stable {
        "m.rtc.slot"
    } else {
        crate::view::RTC_SLOT_TYPE
    };
    if !room
        .power_levels_or_default()
        .await
        .user_can_send_state(user_id, event_type.into())
    {
        return false;
    }
    let mut slot = OpenSlot::new(encrypted);
    if encrypted && wire == membership::RtcWire::Stable {
        slot.encryption = Some(SlotEncryption::StablePerMember);
    }
    let Ok(raw) = Raw::new(&slot) else {
        return false;
    };
    room.send_state_event_raw(event_type, wire.slot(), raw.cast_unchecked())
        .await
        .inspect_err(|error| tracing::warn!(?error, "could not open the call slot"))
        .is_ok()
}

const fn can_join_call(state_allowed: bool, sticky_available: bool, message_allowed: bool) -> bool {
    state_allowed || (sticky_available && message_allowed)
}

fn membership_state_key(
    user_id: &UserId,
    device_id: &DeviceId,
    room_version: &str,
) -> CallMemberStateKey {
    let namespaced_keys = room_version == "org.matrix.msc3757"
        || room_version.starts_with("org.matrix.msc3757.")
        || room_version == "org.matrix.msc3779"
        || room_version.starts_with("org.matrix.msc3779.");
    CallMemberStateKey::new(
        user_id.to_owned(),
        Some(format!("{device_id}_{APPLICATION_SUFFIX}")),
        !namespaced_keys,
    )
}

fn left_membership() -> CallMemberEventContent {
    CallMemberEventContent::new_empty(None)
}

pub(crate) async fn screen_sharers(room: &Room) -> Vec<OwnedUserId> {
    let mut members = membership::active_members(room).await;
    let now = keys::now_ms();
    let encrypted = !matches!(
        room.latest_encryption_state().await,
        Ok(matrix_sdk::EncryptionState::NotEncrypted)
    );
    let mut sticky = membership::StickyMemberships::default();
    for event in sticky::live_events(room) {
        event.apply(&mut sticky, encrypted, now);
    }
    let mut sticky_members = sticky.members(now);
    if sticky_members
        .iter()
        .any(|member| member.wire == membership::RtcWire::Stable)
        && slot_closed(room, encrypted, membership::RtcWire::Stable).await
    {
        sticky_members.retain(|member| member.wire != membership::RtcWire::Stable);
    }
    members.extend(sticky_members);
    members.retain(|member| member.screen_sharing);
    members.sort_by_key(|member| member.joined_ts);
    let mut users = Vec::new();
    for member in members {
        if member.wire == membership::RtcWire::Stable
            && !room
                .get_member(&member.user_id)
                .await
                .ok()
                .flatten()
                .is_some_and(|user| {
                    user.membership()
                        == &matrix_sdk::ruma::events::room::member::MembershipState::Join
                })
        {
            continue;
        }
        if !users.contains(&member.user_id) {
            users.push(member.user_id);
        }
    }
    users
}

fn member_views(members: &[CallMember]) -> Vec<CallMemberView> {
    members
        .iter()
        .map(|member| CallMemberView {
            user_id: member.user_id.clone(),
            device_id: member
                .device_id
                .as_ref()
                .map_or_else(String::new, ToString::to_string),
            identity: member.identity.clone(),
            backend_id: None,
            joined_ts: member.joined_ts,
            screen_sharing: member.screen_sharing,
        })
        .collect()
}

impl Core {
    pub(crate) async fn join_call(
        self: &Arc<Self>,
        room_id: OwnedRoomId,
        livekit_service_url: Option<String>,
        mode: Option<CallMode>,
        intent: Option<crate::protocol::CallIntent>,
    ) -> Result<JoinOk, RpcError> {
        runtime::join(self, room_id, livekit_service_url, mode, intent).await
    }

    pub(crate) async fn call_compatibility(&self) -> Result<CallCompatibilityView, RpcError> {
        let client = self.client().await?;
        let features = client
            .unstable_features()
            .await
            .or_failed(self, "call_compatibility")?;
        let endpoint = (features.contains(&"org.matrix.msc4143.stable".into())
            && !stable_transports(&client).await.is_empty())
            || client
                .discover_rtc_transports()
                .await
                .ok()
                .flatten()
                .is_some_and(|transports| !livekit_service_urls(transports).is_empty());
        let rtc_transports = if endpoint {
            RtcTransportSource::Endpoint
        } else if client
            .well_known_rtc_transports()
            .await
            .is_ok_and(|transports| !livekit_service_urls(transports).is_empty())
        {
            RtcTransportSource::WellKnown
        } else {
            RtcTransportSource::None
        };
        Ok(CallCompatibilityView {
            sticky_events: features.contains(&"org.matrix.msc4354".into()),
            delayed_events: DelayedEventsSupport::from_features(&features).any(),
            rtc_transports,
        })
    }

    pub(crate) async fn call_support(
        &self,
        SupportParams {
            room_id,
            livekit_service_url,
        }: SupportParams,
    ) -> Result<CallSupportView, RpcError> {
        let room = self.room(&room_id).await?;
        let user_id = room
            .client()
            .user_id()
            .ok_or(RpcError::NotLoggedIn)?
            .to_owned();

        let members = membership::active_members(&room).await;
        let mut has_focus = self
            .resolve_focus(&members, livekit_service_url, &room)
            .await
            .is_some();
        let features = room.client().unstable_features().await.unwrap_or_default();
        let stable = features.contains(&"org.matrix.msc4143.stable".into());
        if !has_focus && stable {
            has_focus = !stable_transports(&room.client()).await.is_empty();
        }
        let levels = room.power_levels_or_default().await;
        let state_allowed = levels.user_can_send_state(&user_id, StateEventType::CallMember);
        let sticky_available =
            (!has_focus || !state_allowed) && features.contains(&"org.matrix.msc4354".into());
        if !has_focus && sticky_available {
            let encrypted = self.room_is_encrypted(&room).await?;
            let mut sync = sticky::StickySync::new(self.allocate_subscription().0);
            if let Ok(events) = sync.sync(&room, Duration::ZERO).await {
                let mut sticky_members = membership::StickyMemberships::default();
                for event in events {
                    event.apply(&mut sticky_members, encrypted, keys::now_ms());
                }
                has_focus =
                    !membership::advertised_service_urls(&sticky_members.members(keys::now_ms()))
                        .is_empty();
            }
        }
        let can_join = can_join_call(
            state_allowed,
            sticky_available,
            levels.user_can_send_message(
                &user_id,
                if stable {
                    "m.rtc.member"
                } else {
                    membership::RTC_MEMBER_EVENT_TYPE
                }
                .into(),
            ),
        );

        Ok(CallSupportView {
            has_focus,
            can_join,
        })
    }

    async fn resolve_focus(
        &self,
        members: &[CallMember],
        configured: Option<String>,
        room: &Room,
    ) -> Option<String> {
        let advertised = membership::advertised_service_urls(members);
        if let Some(url) = pick_focus(&advertised, &[], None) {
            return Some(url);
        }

        let discovered = discovered_service_urls(&room.client()).await;
        pick_focus(&[], &discovered, configured)
    }

    pub(crate) fn watch_incoming_calls(self: &Arc<Self>, client: &Client, generation: u64) {
        invite_service::watch(self, client, generation);
    }

    async fn retract_membership(
        &self,
        room: &Room,
        state_key: &CallMemberStateKey,
        delay_id: Option<String>,
    ) {
        if let Some(delay_id) = delay_id
            && self.fire_hangup(delay_id).await.is_ok()
        {
            return;
        }

        if let Err(error) = room
            .send_state_event_for_key(state_key, left_membership())
            .await
        {
            tracing::warn!(?error, "could not retract a call membership");
        }
    }

    #[expect(
        clippy::indexing_slicing,
        reason = "serde_json::Value indexing returns Null for missing fields"
    )]
    async fn announce_call(
        self: &Arc<Self>,
        room: &Room,
        membership_event_id: &EventId,
        own: &CallMember,
    ) {
        let direct = room.is_direct().await.unwrap_or(false);
        let mut users: Vec<String> = room
            .joined_user_ids()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|user| user != room.own_user_id())
            .map(|user| user.to_string())
            .collect();
        users.sort();
        users.dedup();
        if direct && users.is_empty() {
            return;
        }
        let power_levels = room.power_levels_or_default().await;
        if !direct && !power_levels.user_can_trigger_room_notification(room.own_user_id()) {
            tracing::warn!("call invitation not sent: no permission to notify the room");
            return;
        }
        let slot = own.wire.slot();
        let supported = room
            .client()
            .supports_sticky_events()
            .await
            .unwrap_or(false);
        if supported
            && ensure_open_slot(
                room,
                self.room_is_encrypted(room).await.unwrap_or(true),
                own.wire,
            )
            .await
        {
            let content = invites::content(slot, direct, &users, membership_event_id.as_str());
            let mut current = invites::Invitations::default();
            current.slots.insert(slot.to_owned(), true);
            for event in sticky::live_events(room) {
                let event = event.into_value();
                let allowed = event["sender"]
                    .as_str()
                    .and_then(|user| UserId::parse(user).ok())
                    .is_some_and(|sender| power_levels.user_can_trigger_room_notification(&sender));
                current.apply(&event, keys::now_ms(), allowed);
            }
            if current.duplicate(&content, &users, keys::now_ms()) {
                return;
            }
            if let Err(error) = room
                .send_raw(notify::NOTIFICATION_EVENT_TYPE, content)
                .with_sticky_duration(Duration::from_millis(invites::STICKY_MS))
                .await
            {
                tracing::warn!(?error, "could not invite the room to the call");
            }
        } else if own.mode == crate::protocol::CallMode::Matrix2 {
            tracing::warn!("call invitation not sent: no open call slot or sticky event support");
        } else {
            let kind = if direct {
                notify::NotificationKind::Ring
            } else {
                notify::NotificationKind::Notification
            };
            let targets: Vec<_> = if direct {
                users
                    .iter()
                    .filter_map(|user| UserId::parse(user).ok())
                    .collect()
            } else {
                Vec::new()
            };
            if let Some(raw) = notify::announcement(membership_event_id, kind, &targets)
                && let Err(error) = room.send_raw(notify::NOTIFICATION_EVENT_TYPE, raw).await
            {
                tracing::warn!(?error, "could not announce the legacy call");
            }
        }
    }

    #[expect(
        clippy::indexing_slicing,
        reason = "serde_json::Value indexing returns Null for missing fields"
    )]
    async fn withdraw_call_invite(&self, room: &Room, own: &CallMember, slot_closed: bool) {
        if !room
            .client()
            .supports_sticky_events()
            .await
            .unwrap_or(false)
        {
            return;
        }
        let others = membership::active_members(room)
            .await
            .into_iter()
            .any(|member| !member.is_own(&own.user_id, own.own_device_id()))
            || sticky::live_events(room).into_iter().any(|event| {
                membership::sticky_member(&event.into_value().to_string()).is_some_and(|member| {
                    member.user_id != own.user_id
                        || member.member_id.as_str() != own.member_id.as_deref().unwrap_or_default()
                })
            });
        if others && !slot_closed {
            return;
        }
        let Some(duration) = sticky::live_events(room)
            .into_iter()
            .map(sticky::Event::into_value)
            .filter(|event| {
                event["sender"].as_str() == Some(own.user_id.as_str())
                    && event["content"]["slot_id"] == own.wire.slot()
                    && matches!(
                        event["type"].as_str(),
                        Some(
                            "m.rtc.invite" | "m.rtc.notification" | notify::NOTIFICATION_EVENT_TYPE
                        )
                    )
            })
            .map(|event| {
                event
                    .get("sticky")
                    .or_else(|| event.get("msc4354_sticky"))
                    .and_then(|sticky| sticky["duration_ms"].as_u64())
                    .unwrap_or(invites::STICKY_MS)
            })
            .max()
        else {
            return;
        };
        let duration = duration.clamp(invites::STICKY_MS, 3_600_000);
        let content = serde_json::json!({"msc4354_sticky_key": own.wire.slot()});
        if let Err(error) = room
            .send_raw(notify::NOTIFICATION_EVENT_TYPE, content)
            .with_sticky_duration(Duration::from_millis(duration))
            .await
        {
            tracing::warn!(?error, "could not withdraw the call invitation");
        }
    }

    #[expect(
        clippy::indexing_slicing,
        reason = "serde_json::Value indexing returns Null for missing fields"
    )]
    pub(crate) async fn decline_call(
        &self,
        DeclineParams {
            room_id,
            notification_event_id,
        }: DeclineParams,
    ) -> Result<(), RpcError> {
        let event_id = EventId::parse(&notification_event_id).or_failed(self, "decline_call")?;
        let room = self.room(&room_id).await?;
        let value = if let Some(value) = sticky::live_events(&room)
            .into_iter()
            .map(sticky::Event::into_value)
            .find(|value| value["event_id"].as_str() == Some(event_id.as_str()))
        {
            value
        } else {
            let event = room
                .load_or_fetch_event(&event_id, None)
                .await
                .or_failed(self, "decline_call")?;
            serde_json::from_str::<Value>(event.raw().json().get())
                .or_failed(self, "decline_call")?
        };
        let value = invite_service::invite_event(&room, &value)
            .await
            .ok_or_else(|| self.failed("decline_call", "could not read the invitation"))?;
        if (value["content"].get("slot_id").is_some() || value["type"] == "m.rtc.invite")
            && invites::Invite::parse(&value, keys::now_ms()).is_none_or(|invite| invite.modern)
        {
            let (invite, _) = invite_service::active_invite(&room, &value)
                .await
                .ok_or_else(|| self.failed("decline_call", "the invitation is not active"))?;
            let content = serde_json::json!({
                "m.relates_to": {"rel_type": "m.reference", "event_id": event_id},
                "m.mentions": {},
                "msc4354_sticky_key": invite.id,
            });
            let sticky_duration = value
                .get("sticky")
                .or_else(|| value.get("msc4354_sticky"))
                .and_then(|sticky| sticky["duration_ms"].as_u64())
                .unwrap_or(invites::STICKY_MS)
                .clamp(invites::STICKY_MS, 3_600_000);
            room.send_raw(notify::DECLINE_EVENT_TYPE, content)
                .with_sticky_duration(Duration::from_millis(sticky_duration))
                .await
                .or_failed(self, "decline_call")?;
        } else {
            let content = notify::make_decline_event(&room, &event_id)
                .await
                .or_failed(self, "decline_call")?;
            let content = Raw::new(&notify::DeclineOut {
                content,
                mentions: serde_json::Map::new(),
            })
            .or_failed(self, "decline_call")?
            .cast_unchecked();
            room.send_raw(notify::DECLINE_EVENT_TYPE, content)
                .await
                .or_failed(self, "decline_call")?;
        }
        Ok(())
    }

    fn provision_error(&self, service_url: &str, error: &ProvisionError) -> RpcError {
        match error {
            ProvisionError::NotLoggedIn => RpcError::NotLoggedIn,
            ProvisionError::Unreachable | ProvisionError::OpenIdUnavailable => {
                tracing::warn!(service_url, "{error}");
                RpcError::Unavailable
            }
            ProvisionError::Refused(_) | ProvisionError::MalformedResponse => {
                self.failed("join_call_provision", format!("{service_url}: {error}"))
            }
        }
    }

    pub async fn end_all_calls(&self) {
        let calls: Vec<CallSession> = self
            .call_sessions
            .lock()
            .await
            .drain()
            .map(|(_, call)| call)
            .collect();

        for mut call in calls {
            drop(call.updates.take());
            drop(call.postpone.take());
            let result = self.hang_up(&call).await;
            if let Err(error) = result {
                tracing::warn!(?error, room_id = %call.room_id, "could not hang up on session end");
            }
        }
    }

    pub(crate) async fn leave_call(
        self: &Arc<Self>,
        session: CallSessionId,
    ) -> Result<(), RpcError> {
        let mut call = self
            .call_sessions
            .lock()
            .await
            .remove(&session)
            .ok_or(RpcError::UnknownCall)?;

        drop(call.updates.take());
        drop(call.postpone.take());
        let result = self.hang_up(&call).await;
        // A call kept sync running past `Suspended`; stop it before the audio session ends.
        self.apply_app_activity(false).await;
        result
    }

    pub(crate) async fn set_call_screen_sharing(
        &self,
        SetScreenSharingParams { session, active }: SetScreenSharingParams,
    ) -> Result<(), RpcError> {
        let (room_id, state) = {
            let calls = self.call_sessions.lock().await;
            let call = calls.get(&session).ok_or(RpcError::UnknownCall)?;
            (call.room_id.clone(), call.state.clone())
        };
        let room = self.room(&room_id).await?;
        runtime::set_screen_sharing(&room, &state, active)
            .await
            .map_err(|error| self.room_error("set_call_screen_sharing", error))?;
        Ok(())
    }

    async fn fire_hangup(&self, delay_id: String) -> Result<(), RpcError> {
        delayed_events::update(&self.client().await?, delay_id, UpdateAction::Send)
            .await
            .or_failed(self, "leave_call")
    }

    async fn hang_up(&self, call: &CallSession) -> Result<(), RpcError> {
        let (slot_closed, own) = {
            let state = call.state.lock().await;
            (state.left_because_slot_closed(), state.own_member())
        };
        if let Ok(room) = self.room(&call.room_id).await {
            self.withdraw_call_invite(&room, &own, slot_closed).await;
        }
        let delay_id = {
            let mut delay = call.delay_id.lock().await;
            delay.active = false;
            delay.id.take()
        };
        let Some(delay_id) = delay_id else {
            return self.send_left_membership(call, slot_closed).await;
        };
        if call.sticky_member.is_some() {
            let result = self.send_left_membership(call, slot_closed).await;
            if result.is_ok()
                && let Ok(client) = self.client().await
            {
                let _ = delayed_events::update(&client, delay_id, UpdateAction::Cancel).await;
            }
            return result;
        }
        match self.fire_hangup(delay_id).await {
            Ok(result) => Ok(result),
            Err(_) => self.send_left_membership(call, false).await,
        }
    }

    async fn send_left_membership(
        &self,
        call: &CallSession,
        slot_closed: bool,
    ) -> Result<(), RpcError> {
        if let Some(member_id) = &call.sticky_member {
            let room = self.room(&call.room_id).await?;
            let wire = call.state.lock().await.wire();
            let code = if slot_closed {
                sticky::LeaveCode::SlotClosed
            } else {
                sticky::LeaveCode::Leave
            };
            sticky::send_wire(
                &room,
                sticky::LeaveOut::for_wire(Some(member_id.clone()), code, wire),
                wire,
            )
            .await
            .map_err(|error| self.room_error("leave_call", error))?;
            return Ok(());
        }
        self.room(&call.room_id)
            .await?
            .send_state_event_for_key(&call.state_key, left_membership())
            .await
            .map_err(|error| self.room_error("leave_call", error))?;

        Ok(())
    }

    async fn schedule_hangup(
        &self,
        room_id: &OwnedRoomId,
        state_key: &CallMemberStateKey,
    ) -> Option<String> {
        let support = self.delayed_events_support().await.ok()?;
        if !support.any() {
            return None;
        }
        let event = DelayedEvent {
            room_id: room_id.clone(),
            event_type: StateEventType::CallMember.to_string(),
            state_key: Some(state_key.as_ref().to_owned()),
            content: serde_json::value::to_raw_value(&left_membership()).ok()?,
            delay: HANGUP_DELAY,
            sticky_duration_ms: None,
        };

        match delayed_events::send(&self.client().await.ok()?, support, event).await {
            Ok(delay_id) => Some(delay_id),
            Err(error) => {
                tracing::warn!(
                    ?error,
                    "delayed events unavailable, membership will expire instead of hanging up"
                );
                None
            }
        }
    }

    async fn postpone_hangup(&self, delay_id: &str) -> Postponed {
        let mut backoff = HANGUP_RETRY_BACKOFF;
        let mut spent = Duration::ZERO;

        loop {
            let Ok(client) = self.client().await else {
                return Postponed::Unreachable;
            };

            let Err(error) =
                delayed_events::update(&client, delay_id.to_owned(), UpdateAction::Restart).await
            else {
                return Postponed::Restarted;
            };

            if matches!(
                error.client_api_error_kind(),
                Some(ErrorKind::NotFound | ErrorKind::Forbidden)
            ) {
                tracing::warn!(?error, "the delayed hangup is gone");
                return Postponed::Gone;
            }

            if spent.saturating_add(backoff) >= HANGUP_RETRY_BUDGET {
                tracing::warn!(?error, "could not postpone the call hangup in time");
                return Postponed::Unreachable;
            }

            matrix_sdk::sleep::sleep(backoff).await;
            spent = spent.saturating_add(backoff);
            backoff = backoff.saturating_mul(2);
        }
    }

    fn spawn_postpone_loop(self: &Arc<Self>, delay_id: String) -> crate::Task {
        let core = self.clone();

        spawn(async move {
            loop {
                matrix_sdk::sleep::sleep(HANGUP_POSTPONE_INTERVAL).await;

                if core.postpone_hangup(&delay_id).await != Postponed::Restarted {
                    return;
                }
            }
        })
        .abort_on_drop()
    }

    fn spawn_managed_postpone_loop(
        self: &Arc<Self>,
        delay: Arc<tokio::sync::Mutex<DelayState>>,
        wake: Arc<tokio::sync::Notify>,
    ) -> crate::Task {
        let core = self.clone();
        spawn(async move {
            loop {
                matrix_sdk::sleep::sleep(HANGUP_POSTPONE_INTERVAL).await;
                let id = {
                    let delay = delay.lock().await;
                    if !delay.active {
                        return;
                    }
                    delay.id.clone()
                };
                let Some(id) = id else { continue };
                if core.postpone_hangup(&id).await == Postponed::Gone {
                    let mut delay = delay.lock().await;
                    if delay.id.as_deref() == Some(id.as_str()) {
                        delay.id = None;
                        delay.lost = true;
                        wake.notify_one();
                    }
                }
            }
        })
        .abort_on_drop()
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{device_id, owned_user_id, user_id};

    use super::membership::CallMember;
    use super::{can_join_call, member_views, membership_state_key, pick_focus};

    #[test]
    fn test_sticky_membership_can_join_without_legacy_state_permission() {
        assert!(can_join_call(false, true, true));
        assert!(!can_join_call(false, true, false));
    }

    #[test]
    fn test_a_membership_is_keyed_per_device() {
        let user = user_id!("@erwan:localhost");

        let first = membership_state_key(user, device_id!("AAAAAAAA"), "12");
        let second = membership_state_key(user, device_id!("BBBBBBBB"), "12");

        assert_eq!(first.as_ref(), "_@erwan:localhost_AAAAAAAA_m.call");
        assert_ne!(
            first.as_ref(),
            second.as_ref(),
            "two devices sharing a state key means the second evicts the first"
        );
    }

    #[test]
    fn test_open_slot_serializes_with_optional_encryption() {
        let slot = |encrypted: bool| serde_json::to_value(super::OpenSlot::new(encrypted)).unwrap();
        assert_eq!(
            slot(false),
            serde_json::json!({"status": "open", "application": {"type": "m.call"}})
        );
        assert_eq!(
            slot(true),
            serde_json::json!({
                "status": "open",
                "application": {"type": "m.call"},
                "encryption": {"type": "org.matrix.msc4143.per_member"},
            })
        );
    }

    #[test]
    fn test_an_encrypted_room_needs_a_slot_with_encryption() {
        let open = |content: serde_json::Value, encrypted| {
            super::slot_is_open(&super::read_slot(&content), encrypted)
        };
        let plain = serde_json::json!({"status": "open", "application": {"type": "m.call"}});
        let encrypted = serde_json::json!({
            "status": "open",
            "application": {"type": "m.call"},
            "encryption": {"type": "org.matrix.msc4143.per_member"},
        });
        assert!(open(plain.clone(), false));
        assert!(!open(plain, true));
        assert!(open(encrypted.clone(), true));
        assert!(open(encrypted, false));
        let stable = serde_json::json!({
            "status": "open", "application": {"type": "m.call"},
            "encryption": {"type": "m.per_member"},
        });
        assert!(open(stable, true));
        let unknown = serde_json::json!({
            "status": "open", "application": {"type": "m.call"},
            "encryption": {"type": "example.other"},
        });
        assert!(!open(unknown.clone(), true));
        assert!(super::slot_has_unknown_encryption(
            &super::read_slot(&unknown),
            true
        ));
    }

    #[test]
    fn stable_unencrypted_room_rejects_an_encrypted_slot() {
        let slot = super::read_slot(&serde_json::json!({
            "status": "open", "application": {"type": "m.call"},
            "encryption": {"type": "m.per_member"},
        }));
        assert!(!super::slot_is_compatible(
            &slot,
            false,
            super::membership::RtcWire::Stable
        ));
        assert!(super::slot_is_compatible(
            &slot,
            true,
            super::membership::RtcWire::Stable
        ));
        let malformed = super::read_slot(&serde_json::json!({
            "status": "open", "application": {"type": "m.call"}, "encryption": null,
        }));
        assert!(!super::slot_is_compatible(
            &malformed,
            false,
            super::membership::RtcWire::Stable
        ));
    }

    #[test]
    fn stable_transport_discovery_reads_the_stable_response() {
        let transport: matrix_sdk::ruma::api::client::rtc::RtcTransport = serde_json::from_value(
            serde_json::json!({"type":"m.livekit", "url":"wss://focus.example"}),
        )
        .unwrap();
        assert_eq!(transport.transport_type(), "m.livekit");
        assert_eq!(transport.data()["url"], "wss://focus.example");
    }

    #[test]
    fn test_slot_reads_ignore_wrong_typed_fields() {
        let open =
            |content: serde_json::Value| super::slot_is_open(&super::read_slot(&content), false);
        assert!(open(
            serde_json::json!({"status": "open", "application": {"type": "m.call"}})
        ));
        assert!(!open(
            serde_json::json!({"status": "open", "application": "m.call"})
        ));
        assert!(!open(
            serde_json::json!({"status": 1, "application": {"type": "m.call"}})
        ));
        assert!(!open(
            serde_json::json!({"status": "open", "application": {"type": 3}})
        ));
        assert!(!open(serde_json::json!("open")));
        let closed = super::read_slot(&serde_json::json!({"status": "closed"}));
        assert_eq!(closed.status.as_deref(), Some("closed"));
    }

    #[test]
    fn test_experimental_room_versions_use_namespaced_state_keys() {
        for version in ["org.matrix.msc3757", "org.matrix.msc3779.10"] {
            let key =
                membership_state_key(user_id!("@user:example.org"), device_id!("DEVICE"), version);
            assert_eq!(key.as_ref(), "@user:example.org_DEVICE_m.call");
        }
    }

    #[test]
    fn test_the_state_key_carries_the_users_own_id() {
        let key = membership_state_key(user_id!("@erwan:localhost"), device_id!("DEVICEID"), "12");

        assert_eq!(key.user_id(), user_id!("@erwan:localhost"));
    }

    #[test]
    fn test_a_member_view_carries_the_identity_the_sfu_granted() {
        let views = member_views(&[CallMember {
            user_id: owned_user_id!("@erwan:localhost"),
            device_id: Some("LAPTOP".into()),
            member_id: None,
            identity: "@erwan:localhost:LAPTOP".to_owned(),
            mode: crate::protocol::CallMode::Legacy,
            created_ts: 0,
            joined_ts: 0,
            expires_at_ms: None,
            foci: Vec::new(),
            screen_sharing: false,
            wire: super::membership::RtcWire::Deployed,
            focus_servers: std::collections::HashMap::default(),
        }]);

        assert_eq!(views[0].identity, "@erwan:localhost:LAPTOP");
        assert_eq!(views[0].device_id, "LAPTOP");
    }

    #[test]
    fn test_a_running_call_outranks_the_server_which_outranks_the_deployment() {
        let advertised = vec!["https://running.example".to_owned()];
        let discovered = vec!["https://server.example".to_owned()];
        let configured = Some("https://deployment.example".to_owned());

        assert_eq!(
            pick_focus(&advertised, &discovered, configured.clone()),
            Some("https://running.example".to_owned())
        );
        assert_eq!(
            pick_focus(&[], &discovered, configured.clone()),
            Some("https://server.example".to_owned())
        );
        assert_eq!(
            pick_focus(&[], &[], configured),
            Some("https://deployment.example".to_owned())
        );
        assert_eq!(pick_focus(&[], &[], None), None);
    }

    #[test]
    fn test_a_blank_focus_is_not_a_focus() {
        assert_eq!(
            pick_focus(
                &["  ".to_owned()],
                &[String::new()],
                Some("https://deployment.example".to_owned())
            ),
            Some("https://deployment.example".to_owned())
        );
        assert_eq!(pick_focus(&[], &[], Some("   ".to_owned())), None);
    }
}
