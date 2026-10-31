use base64::Engine as _;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use std::collections::HashMap;

use matrix_sdk::Room;
use matrix_sdk::ruma::events::call::member::{
    ActiveFocus, Application, CallMemberEventContent, CallScope, Focus, MembershipData,
};
use matrix_sdk::ruma::{DeviceId, OwnedDeviceId, OwnedServerName, OwnedUserId, UserId};
use serde::Deserialize;
use serde_with::{DefaultOnError, serde_as};
use sha2::{Digest as _, Sha256};

use crate::protocol::CallMode;

pub(crate) const RTC_MEMBER_EVENT_TYPE: &str = "org.matrix.msc4143.rtc.member";
pub(crate) const SCREEN_SHARING_FIELD: &str = "org.sable.screen_sharing";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum RtcWire {
    Deployed,
    Stable,
}

impl RtcWire {
    pub(crate) const fn slot(self) -> &'static str {
        match self {
            Self::Deployed => "m.call#ROOM",
            Self::Stable => "m.call#room",
        }
    }
}

pub(crate) fn is_rtc_member_type(event_type: &str) -> bool {
    event_type == RTC_MEMBER_EVENT_TYPE || event_type == "m.rtc.member"
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StickyMember {
    pub(crate) user_id: OwnedUserId,
    pub(crate) device_id: Option<OwnedDeviceId>,
    pub(crate) member_id: String,
    pub(crate) identity: String,
    pub(crate) foci: Vec<String>,
    pub(crate) screen_sharing: bool,
    pub(crate) wire: RtcWire,
    pub(crate) focus_servers: HashMap<String, OwnedServerName>,
}

#[derive(Default)]
pub(crate) struct StickyMemberships {
    entries: HashMap<(OwnedUserId, String, RtcWire, String), StickyEntry>,
    redacted: HashMap<String, u64>,
}

struct StickyEntry {
    member: Option<StickyMember>,
    expires_at_ms: u64,
    event_id: String,
    order_expires_at_ms: u64,
    created_ts: u64,
    joined_ts: u64,
}

#[derive(Debug, Deserialize)]
struct StickyEvent {
    sender: OwnedUserId,
    content: StickyContent,
}

#[derive(Debug, Deserialize)]
struct StickyContent {
    #[serde(default)]
    slot_id: String,
    application: StickyApplication,
    member: Option<StickyMemberRef>,
    #[serde(default)]
    transports: StickyTransports,
    #[serde(default, rename = "org.sable.screen_sharing")]
    screen_sharing: bool,
}

#[derive(Debug, Deserialize)]
struct StickyApplication {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Deserialize)]
struct StickyMemberRef {
    user_id: Option<OwnedUserId>,
    device_id: Option<OwnedDeviceId>,
    id: String,
    membership: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct StickyTransports {
    #[serde(default)]
    published: Vec<StickyTransport>,
}

#[derive(Debug, Deserialize)]
struct StickyTransport {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    livekit_service_url: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    server_name: Option<OwnedServerName>,
}

pub(crate) fn sticky_member(raw: &str) -> Option<StickyMember> {
    let event: StickyEvent = serde_json::from_str(raw).ok()?;
    let member = event.content.member?;
    let wire = match event.content.slot_id.as_str() {
        "m.call#ROOM" => RtcWire::Deployed,
        "m.call#room" => RtcWire::Stable,
        _ => return None,
    };
    if event.content.application.kind != "m.call"
        || (wire == RtcWire::Stable && member.membership.as_deref() != Some("join"))
        || member
            .user_id
            .as_ref()
            .is_some_and(|user| user != &event.sender)
    {
        return None;
    }
    if member.id.is_empty() {
        return None;
    }
    let mut foci = Vec::new();
    let mut focus_servers = HashMap::new();
    for transport in event.content.transports.published {
        let url = match wire {
            RtcWire::Deployed if transport.kind == "livekit" => transport.livekit_service_url,
            RtcWire::Stable if transport.kind == "m.livekit" => transport.url,
            _ => None,
        };
        if let Some(url) = url.filter(|url| {
            !url.is_empty()
                && (wire != RtcWire::Stable
                    || url::Url::parse(url).is_ok_and(|url| url.scheme() == "wss"))
        }) {
            if wire == RtcWire::Stable {
                focus_servers.insert(
                    url.clone(),
                    transport
                        .server_name
                        .unwrap_or_else(|| event.sender.server_name().to_owned()),
                );
            }
            foci.push(url);
        }
    }
    let device_id = member.device_id;
    let identity = match wire {
        RtcWire::Deployed => sticky_identity(&event.sender, device_id.as_deref()?, &member.id),
        RtcWire::Stable => stable_identity(&event.sender, &member.id),
    };
    Some(StickyMember {
        user_id: event.sender,
        device_id,
        member_id: member.id,
        identity,
        foci,
        screen_sharing: event.content.screen_sharing,
        wire,
        focus_servers,
    })
}

pub(crate) fn stable_identity(user_id: &UserId, member_id: &str) -> String {
    let source = serde_json::Value::from([user_id.as_str(), member_id]).to_string();
    STANDARD_NO_PAD.encode(Sha256::digest(source.as_bytes()))
}

pub(crate) fn sticky_identity(user_id: &UserId, device_id: &DeviceId, member_id: &str) -> String {
    let source =
        serde_json::Value::from([user_id.as_str(), device_id.as_str(), member_id]).to_string();
    STANDARD_NO_PAD.encode(Sha256::digest(source.as_bytes()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallMember {
    pub(crate) user_id: OwnedUserId,
    pub(crate) device_id: Option<OwnedDeviceId>,
    pub(crate) member_id: Option<String>,
    pub(crate) identity: String,
    pub(crate) mode: CallMode,
    pub(crate) created_ts: u64,
    pub(crate) joined_ts: u64,
    pub(crate) expires_at_ms: Option<u64>,
    pub(crate) foci: Vec<String>,
    pub(crate) screen_sharing: bool,
    pub(crate) wire: RtcWire,
    pub(crate) focus_servers: HashMap<String, OwnedServerName>,
}

impl CallMember {
    pub(crate) fn is_own(&self, user_id: &UserId, device_id: &DeviceId) -> bool {
        self.user_id == user_id && self.device_id.as_deref() == Some(device_id)
    }

    #[expect(
        clippy::expect_used,
        reason = "The local member has the logged-in device ID"
    )]
    pub(crate) fn own_device_id(&self) -> &DeviceId {
        self.device_id
            .as_deref()
            .expect("own call member has a device ID")
    }

    pub(crate) fn same_generation(&self, other: &Self) -> bool {
        self.user_id == other.user_id
            && self.device_id == other.device_id
            && self.wire == other.wire
            && match (&self.member_id, &other.member_id) {
                (Some(left), Some(right)) => {
                    left == right
                        && match (self.mode, other.mode) {
                            (CallMode::Matrix2, CallMode::Matrix2) => true,
                            (CallMode::Matrix2, _) | (_, CallMode::Matrix2) => false,
                            _ => self.created_ts == other.created_ts,
                        }
                }
                (None, None) => self.created_ts == other.created_ts,
                _ => false,
            }
    }
}

pub(crate) async fn active_members(room: &Room) -> Vec<CallMember> {
    let Ok(events) = room
        .get_state_events_static::<CallMemberEventContent>()
        .await
    else {
        return Vec::new();
    };

    let mut members = Vec::new();
    for raw in events {
        let matrix_sdk::deserialized_responses::RawSyncOrStrippedState::Sync(raw) = raw else {
            continue;
        };
        let Ok(mut value) = raw.deserialize_as::<serde_json::Value>() else {
            continue;
        };
        let membership_id = value
            .get("content")
            .and_then(|content| content.get("membershipID"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);
        let screen_sharing = value
            .get("content")
            .and_then(|content| content.get(SCREEN_SHARING_FIELD))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        alias_foci(&mut value, room.room_id().as_str());
        let Ok(event) = serde_json::from_value::<
            matrix_sdk::ruma::events::SyncStateEvent<CallMemberEventContent>,
        >(value) else {
            continue;
        };
        let Some(event) = event.as_original() else {
            continue;
        };

        if event.sender != event.state_key.user_id() {
            continue;
        }
        let origin_server_ts = event.origin_server_ts;
        for membership in event.content.active_memberships(Some(origin_server_ts)) {
            let Application::Call(application) = membership.application() else {
                continue;
            };
            if !application.call_id.is_empty() || application.scope != CallScope::Room {
                continue;
            }
            let ActiveFocus::Livekit(focus) = membership.focus_active() else {
                continue;
            };
            let mode = match focus.focus_selection.as_str() {
                "oldest_membership" => CallMode::Legacy,
                "multi_sfu" => CallMode::Compatibility,
                _ => continue,
            };
            let created_ts = membership
                .created_ts()
                .unwrap_or(origin_server_ts)
                .get()
                .into();
            members.push(CallMember {
                user_id: event.state_key.user_id().to_owned(),
                device_id: Some(membership.device_id().to_owned()),
                member_id: Some(match membership {
                    MembershipData::Legacy(data) => data.membership_id.clone(),
                    MembershipData::Session(_) => membership_id.clone().unwrap_or_else(|| {
                        format!("{}:{}", event.state_key.user_id(), membership.device_id())
                    }),
                    _ => format!("{}:{}", event.state_key.user_id(), membership.device_id()),
                }),
                identity: format!("{}:{}", event.state_key.user_id(), membership.device_id()),
                mode,
                created_ts,
                joined_ts: created_ts,
                expires_at_ms: membership
                    .expires_ts(Some(origin_server_ts))
                    .map(|expires| expires.get().into()),
                foci: livekit_urls(membership.foci_preferred()),
                screen_sharing,
                wire: RtcWire::Deployed,
                focus_servers: HashMap::new(),
            });
        }
    }
    members
}

#[serde_as]
#[derive(Deserialize)]
struct StickyEventIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    content: Option<StickyContentIn>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    sender: Option<OwnedUserId>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    event_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    origin_server_ts: Option<u64>,
    #[serde(default, deserialize_with = "sable_model::field::present")]
    msc4354_sticky: Option<StickyField>,
    #[serde(default, deserialize_with = "sable_model::field::present")]
    sticky: Option<StickyField>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    unsigned: Option<StickyUnsignedIn>,
}

#[serde_as]
#[derive(Deserialize)]
struct StickyContentIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    sticky_key: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    msc4354_sticky_key: Option<String>,
    #[serde(flatten)]
    rest: serde_json::Map<String, serde_json::Value>,
}

#[serde_as]
#[derive(Deserialize)]
struct StickyDurationIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    duration_ms: Option<u64>,
}

/// Present even when wrong-typed, so an `.or()` fallback only fires for a missing field.
#[serde_as]
#[derive(Deserialize)]
struct StickyField(#[serde_as(deserialize_as = "DefaultOnError")] Option<StickyDurationIn>);

#[serde_as]
#[derive(Deserialize)]
struct TtlField(#[serde_as(deserialize_as = "DefaultOnError")] Option<u64>);

#[serde_as]
#[derive(Deserialize)]
struct StickyUnsignedIn {
    #[serde(
        default,
        rename = "msc4354_sticky_duration_ttl_ms",
        deserialize_with = "sable_model::field::present"
    )]
    msc4354_ttl_ms: Option<TtlField>,
    #[serde(
        default,
        rename = "sticky_duration_ttl_ms",
        alias = "sticky_duration_remaining_ms",
        deserialize_with = "sable_model::field::present"
    )]
    ttl_ms: Option<TtlField>,
}

impl StickyMemberships {
    pub(crate) fn redact(&mut self, event_id: &str, now_ms: u64) {
        self.redacted.retain(|_, expires| *expires > now_ms);
        self.redacted
            .insert(event_id.to_owned(), now_ms.saturating_add(3_600_000));
        for entry in self.entries.values_mut() {
            if entry.event_id == event_id {
                entry.member = None;
            }
        }
    }

    pub(crate) fn apply_untrusted(&mut self, value: &serde_json::Value, now_ms: u64) -> bool {
        let Some(content) = value.get("content").and_then(serde_json::Value::as_object) else {
            return false;
        };
        let Some(slot) = content.get("slot_id").and_then(serde_json::Value::as_str) else {
            return false;
        };
        if !matches!(slot, "m.call#ROOM" | "m.call#room") {
            return false;
        }
        if let (Some(stable), Some(unstable)) =
            (content.get("sticky_key"), content.get("msc4354_sticky_key"))
            && stable != unstable
        {
            return false;
        }
        let Some(key) = content
            .get("msc4354_sticky_key")
            .or_else(|| content.get("sticky_key"))
            .and_then(serde_json::Value::as_str)
        else {
            return false;
        };
        let wire = if slot == "m.call#room" {
            RtcWire::Stable
        } else {
            RtcWire::Deployed
        };
        let sender = value.get("sender").and_then(serde_json::Value::as_str);
        let event_type = value.get("type").and_then(serde_json::Value::as_str);
        if self
            .entries
            .iter()
            .any(|((user, id, old_wire, kind), entry)| {
                Some(user.as_str()) == sender
                    && id == key
                    && *old_wire == wire
                    && Some(kind.as_str()) == event_type
                    && entry
                        .member
                        .as_ref()
                        .is_some_and(|member| member.device_id.is_some())
            })
        {
            return false;
        }
        if content
            .get("member")
            .is_some_and(|member| member.get("id").and_then(serde_json::Value::as_str) != Some(key))
        {
            return false;
        }
        let mut tombstone = value.clone();
        let Some(tombstone_content) = tombstone.get_mut("content") else {
            return false;
        };
        *tombstone_content = if wire == RtcWire::Stable {
            serde_json::json!({"sticky_key": key, "slot_id": slot})
        } else {
            serde_json::json!({"msc4354_sticky_key": key, "slot_id": slot})
        };
        self.apply(&tombstone, now_ms)
    }

    pub(crate) fn apply_authenticated(
        &mut self,
        value: &serde_json::Value,
        device: &DeviceId,
        now_ms: u64,
    ) -> bool {
        let Some(sender) = value.get("sender").and_then(serde_json::Value::as_str) else {
            return false;
        };
        let Some(content) = value.get("content") else {
            return false;
        };
        let Some(key) = content
            .get("msc4354_sticky_key")
            .or_else(|| content.get("sticky_key"))
            .and_then(serde_json::Value::as_str)
        else {
            return false;
        };
        if let Some(claimed) = content.get("member").and_then(|m| m.get("device_id"))
            && claimed.as_str() != Some(device.as_str())
        {
            return false;
        }
        let wire = match content.get("slot_id").and_then(serde_json::Value::as_str) {
            Some("m.call#ROOM") => RtcWire::Deployed,
            Some("m.call#room") => RtcWire::Stable,
            _ => return false,
        };
        let event_type = value.get("type").and_then(serde_json::Value::as_str);
        if self
            .entries
            .iter()
            .any(|((user, id, old_wire, kind), entry)| {
                user.as_str() == sender
                    && id == key
                    && *old_wire == wire
                    && Some(kind.as_str()) == event_type
                    && entry
                        .member
                        .as_ref()
                        .is_some_and(|member| member.device_id.as_deref() != Some(device))
            })
        {
            return false;
        }
        let mut value = value.clone();
        if let Some(member) = value
            .get_mut("content")
            .and_then(|content| content.get_mut("member"))
            .and_then(serde_json::Value::as_object_mut)
        {
            member
                .entry("device_id")
                .or_insert_with(|| device.as_str().into());
        }
        self.apply(&value, now_ms)
    }

    #[expect(
        clippy::too_many_lines,
        reason = "Validation and ordering are kept together"
    )]
    pub(crate) fn apply(&mut self, value: &serde_json::Value, now_ms: u64) -> bool {
        self.entries.retain(|_, entry| entry.expires_at_ms > now_ms);
        self.redacted.retain(|_, expires| *expires > now_ms);
        let Ok(event) = StickyEventIn::deserialize(value) else {
            return false;
        };
        let Some(kind) = event.kind.filter(|kind| is_rtc_member_type(kind)) else {
            return false;
        };
        let Some(content) = event.content else {
            return false;
        };
        let stable_key = content.sticky_key.as_deref();
        let unstable_key = content.msc4354_sticky_key.as_deref();
        if stable_key.is_some() && unstable_key.is_some() && stable_key != unstable_key {
            return false;
        }
        let Some(key) = unstable_key.or(stable_key).filter(|key| !key.is_empty()) else {
            return false;
        };
        let Some(sender) = event.sender else {
            return false;
        };
        let Some(event_id) = event.event_id.as_deref().filter(|id| !id.is_empty()) else {
            return false;
        };
        if self.redacted.contains_key(event_id) {
            return false;
        }
        let Some(created_ts) = event.origin_server_ts else {
            return false;
        };
        let Some(duration) = event
            .msc4354_sticky
            .or(event.sticky)
            .and_then(|sticky| sticky.0?.duration_ms)
        else {
            return false;
        };
        let duration = duration.min(3_600_000);
        let order_expires_at_ms = created_ts.saturating_add(duration);
        let expires_at_ms = event
            .unsigned
            .and_then(|unsigned| unsigned.msc4354_ttl_ms.or(unsigned.ttl_ms)?.0)
            .map_or(now_ms.min(created_ts).saturating_add(duration), |ttl| {
                now_ms.saturating_add(ttl.min(duration))
            });
        if duration == 0 || expires_at_ms <= now_ms {
            return false;
        }
        let wire = match content
            .rest
            .get("slot_id")
            .and_then(serde_json::Value::as_str)
        {
            Some("m.call#ROOM") | None => RtcWire::Deployed,
            Some("m.call#room") => RtcWire::Stable,
            _ => return false,
        };
        if wire == RtcWire::Stable && kind != "m.rtc.member" {
            return false;
        }
        if wire == RtcWire::Stable && stable_key.is_none() {
            return false;
        }
        let entry_key = (sender, key.to_owned(), wire, kind);
        if self.entries.get(&entry_key).is_some_and(|old| {
            (order_expires_at_ms, event_id) <= (old.order_expires_at_ms, old.event_id.as_str())
        }) {
            return false;
        }
        let member_content = content.rest.get("member");
        let left = member_content
            .and_then(|member| member.get("membership"))
            .is_some_and(|membership| membership.as_str() != Some("join"));
        if left
            && (member_content
                .and_then(|member| member.get("id"))
                .and_then(serde_json::Value::as_str)
                != Some(key)
                || content
                    .rest
                    .get("slot_id")
                    .and_then(serde_json::Value::as_str)
                    != Some(wire.slot()))
        {
            return false;
        }
        let tombstone = left || content.rest.keys().all(|field| field == "slot_id");
        let member = if tombstone {
            None
        } else {
            let Some(member) = sticky_member(&value.to_string()) else {
                return false;
            };
            if member.member_id != key {
                return false;
            }
            Some(member)
        };
        let joined_ts = self.joined_ts(&entry_key, member.as_ref(), now_ms, created_ts);
        self.entries.insert(
            entry_key,
            StickyEntry {
                member,
                expires_at_ms,
                event_id: event_id.to_owned(),
                order_expires_at_ms,
                created_ts,
                joined_ts,
            },
        );
        true
    }

    fn joined_ts(
        &self,
        key: &(OwnedUserId, String, RtcWire, String),
        member: Option<&StickyMember>,
        now_ms: u64,
        created_ts: u64,
    ) -> u64 {
        let Some(member) = member else {
            return created_ts;
        };
        self.entries
            .get(key)
            .filter(|old| old.expires_at_ms > now_ms)
            .filter(|old| {
                old.member.as_ref().is_some_and(|previous| {
                    previous.member_id == member.member_id && previous.device_id == member.device_id
                })
            })
            .map_or(created_ts, |old| old.joined_ts)
    }

    pub(crate) fn members(&self, now_ms: u64) -> Vec<CallMember> {
        self.entries
            .values()
            .filter(|entry| entry.expires_at_ms > now_ms)
            .filter_map(|entry| {
                entry.member.as_ref().map(|member| CallMember {
                    user_id: member.user_id.clone(),
                    device_id: member.device_id.clone(),
                    member_id: Some(member.member_id.clone()),
                    identity: member.identity.clone(),
                    mode: CallMode::Matrix2,
                    created_ts: entry.created_ts,
                    joined_ts: entry.joined_ts,
                    expires_at_ms: Some(entry.expires_at_ms),
                    foci: member.foci.clone(),
                    screen_sharing: member.screen_sharing,
                    wire: member.wire,
                    focus_servers: member.focus_servers.clone(),
                })
            })
            .collect()
    }
}

fn alias_foci(event: &mut serde_json::Value, room_id: &str) {
    let Some(foci) = event
        .get_mut("content")
        .and_then(|content| content.get_mut("foci_preferred"))
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for focus in foci.iter_mut().filter_map(serde_json::Value::as_object_mut) {
        if focus.get("type").and_then(serde_json::Value::as_str) == Some("livekit")
            && !focus.contains_key("livekit_alias")
        {
            focus.insert("livekit_alias".to_owned(), room_id.into());
        }
    }
}

#[expect(
    deprecated,
    reason = "calls still get their token from the JWT service of the earlier MSC4195"
)]
fn livekit_urls(foci: &[Focus]) -> Vec<String> {
    foci.iter()
        .filter_map(|focus| match focus {
            Focus::Livekit(livekit) => livekit.service_url.clone(),
            _ => None,
        })
        .filter(|url| !url.is_empty())
        .collect()
}

pub(crate) fn advertised_service_urls(members: &[CallMember]) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for url in members.iter().flat_map(|member| &member.foci) {
        if !urls.contains(url) {
            urls.push(url.clone());
        }
    }
    urls
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{device_id, owned_user_id, user_id};

    use serde_json::json;

    use super::{CallMember, StickyMemberships, advertised_service_urls, sticky_member};
    use crate::protocol::CallMode;

    #[test]
    fn stable_membership_uses_the_specified_identity_without_a_device_claim() {
        let raw = r#"{
            "sender":"@alice:example.com",
            "content":{
                "slot_id":"m.call#room",
                "application":{"type":"m.call"},
                "member":{"id":"memberABC","membership":"join"},
                "transports":{"published":[{"type":"m.livekit","url":"wss://focus.example.com"}]}
            }
        }"#;
        let member = sticky_member(raw).unwrap();
        assert_eq!(member.device_id, None);
        assert_eq!(
            member.identity,
            "M3VnsLXrkbxIDINXO64u8PZzFyD9ZYFiQULR2dshWYs"
        );
        assert_eq!(
            member.focus_servers["wss://focus.example.com"].as_str(),
            "example.com"
        );
    }

    fn member(device: &str, created_ts: u64, foci: &[&str]) -> CallMember {
        CallMember {
            user_id: owned_user_id!("@erwan:localhost"),
            device_id: Some(device.into()),
            member_id: None,
            identity: format!("@erwan:localhost:{device}"),
            mode: CallMode::Legacy,
            created_ts,
            joined_ts: created_ts,
            expires_at_ms: None,
            foci: foci.iter().map(|url| (*url).to_owned()).collect(),
            screen_sharing: false,
            wire: super::RtcWire::Deployed,
            focus_servers: std::collections::HashMap::default(),
        }
    }

    #[test]
    fn test_a_rejoin_is_a_different_generation() {
        assert!(!member("PHONE", 100, &[]).same_generation(&member("PHONE", 200, &[])));
        assert!(member("PHONE", 100, &[]).same_generation(&member("PHONE", 100, &[])));
    }

    #[test]
    fn test_two_devices_of_one_user_are_two_members() {
        let laptop = member("LAPTOP", 100, &[]);

        assert!(!laptop.same_generation(&member("PHONE", 100, &[])));
        assert!(laptop.is_own(user_id!("@erwan:localhost"), device_id!("LAPTOP")));
        assert!(!laptop.is_own(user_id!("@erwan:localhost"), device_id!("PHONE")));
    }

    #[test]
    fn test_the_running_calls_focus_wins_and_does_not_repeat() {
        let members = [
            member("LAPTOP", 100, &["https://sfu.one"]),
            member("PHONE", 110, &["https://sfu.one", "https://sfu.two"]),
        ];

        assert_eq!(
            advertised_service_urls(&members),
            vec!["https://sfu.one".to_owned(), "https://sfu.two".to_owned()]
        );
    }

    #[test]
    fn test_a_sticky_member_reads_the_screen_share_flag() {
        let raw = |extra: &str| {
            format!(
                r#"{{
                    "sender":"@erwan:localhost",
                    "content": {{
                        "slot_id":"m.call#ROOM",
                        "application":{{"type":"m.call"}},
                        "member":{{"user_id":"@erwan:localhost","device_id":"LAPTOP","id":"member-1"}},
                        "transports":{{"published":[]}}{extra}
                    }}
                }}"#
            )
        };
        assert!(!sticky_member(&raw("")).unwrap().screen_sharing);
        assert!(
            sticky_member(&raw(r#","org.sable.screen_sharing":true"#))
                .unwrap()
                .screen_sharing
        );
    }

    #[test]
    fn test_a_sticky_member_uses_its_member_id_for_the_deployed_identity() {
        let member = sticky_member(
            r#"{
                "sender":"@erwan:localhost",
                "content": {
                    "slot_id":"m.call#ROOM",
                    "application":{"type":"m.call"},
                    "member":{"user_id":"@erwan:localhost","device_id":"LAPTOP","id":"member-1"},
                    "transports":{"published":[{"type":"livekit","livekit_service_url":"https://focus.example.org"}]}
                }
            }"#,
        )
        .unwrap();

        assert_eq!(member.user_id, user_id!("@erwan:localhost"));
        assert_eq!(member.device_id.as_deref(), Some(device_id!("LAPTOP")));
        assert_eq!(member.member_id, "member-1");
        assert_eq!(member.foci, ["https://focus.example.org"]);
        assert_eq!(
            member.identity,
            "HDygEJZPKxdLyHX7ic7VpvsISAOOtDo/FX8oZfgj3+0"
        );
    }

    #[test]
    fn test_a_sticky_member_cannot_claim_another_sender() {
        assert!(
            sticky_member(
                r#"{
                "sender":"@erwan:localhost",
                "content": {
                    "slot_id":"m.call#ROOM",
                    "application":{"type":"m.call"},
                    "member":{"user_id":"@other:localhost","device_id":"LAPTOP","id":"member-1"}
                }
            }"#,
            )
            .is_none()
        );
    }
    fn sticky_event(id: &str, origin: u64) -> serde_json::Value {
        serde_json::json!({
            "type":"org.matrix.msc4143.rtc.member", "sender":"@erwan:localhost", "event_id":id,
            "origin_server_ts":origin,"msc4354_sticky":{"duration_ms":900_000},
            "content":{"msc4354_sticky_key":"member", "slot_id":"m.call#ROOM", "application":{"type":"m.call"},
                "member":{"user_id":"@erwan:localhost","device_id":"PHONE","id":"member"},
                "transports":{"published":[{"type":"livekit","livekit_service_url":"https://sfu.example"}]}}
        })
    }

    #[test]
    fn redaction_removes_membership_and_rejects_stale_replays() {
        let mut store = StickyMemberships::default();
        let event = sticky_event("$member", 100);
        assert!(store.apply(&event, 100));
        store.redact("$member", 200);
        assert_eq!(
            store.members(200),
            [] as [crate::calls::membership::CallMember; 0]
        );
        assert!(!store.apply(&event, 200));
        assert!(!store.apply(&sticky_event("$older", 50), 200));
        assert_eq!(
            store.members(200),
            [] as [crate::calls::membership::CallMember; 0]
        );
        assert!(store.apply(&sticky_event("$renewed", 300), 300));
        assert_eq!(store.members(300).len(), 1);
    }

    #[test]
    fn redaction_before_decryption_prevents_a_late_join() {
        let mut store = StickyMemberships::default();
        store.redact("$member", 200);
        assert!(!store.apply(&sticky_event("$member", 100), 300));
        assert_eq!(
            store.members(300),
            [] as [crate::calls::membership::CallMember; 0]
        );
    }

    #[test]
    fn redacting_an_older_event_preserves_its_replacement() {
        let mut store = StickyMemberships::default();
        assert!(store.apply(&sticky_event("$old", 100), 100));
        assert!(store.apply(&sticky_event("$new", 200), 200));
        store.redact("$old", 300);
        assert_eq!(store.members(300).len(), 1);
    }

    #[test]
    fn non_sticky_and_expired_events_cannot_replace_a_live_member() {
        let mut store = StickyMemberships::default();
        assert!(store.apply(&sticky_event("$live", 100), 100));
        let mut event = sticky_event("$zero-duration", 1_000_000);
        event["msc4354_sticky"]["duration_ms"] = json!(0);
        assert!(!store.apply(&event, 200));
        let mut event = sticky_event("$expired", 200);
        event["unsigned"] = json!({"sticky_duration_remaining_ms": 0});
        assert!(!store.apply(&event, 200));
        assert_eq!(store.members(200).len(), 1);
    }

    #[test]
    fn authenticated_memberships_bind_join_and_leave_to_the_sending_device() {
        let mut store = StickyMemberships::default();
        let event = sticky_event("$a", 100);
        assert!(!store.apply_authenticated(&event, device_id!("LAPTOP"), 100));
        assert!(store.apply_authenticated(&event, device_id!("PHONE"), 100));
        let mut replacement = sticky_event("$b", 200);
        replacement["content"]["member"]["device_id"] = json!("LAPTOP");
        assert!(!store.apply_authenticated(&replacement, device_id!("LAPTOP"), 200));
        replacement["content"] = json!({"msc4354_sticky_key":"member", "slot_id":"m.call#ROOM", "member":{"id":"member", "membership":"leave"}});
        assert!(!store.apply_authenticated(&replacement, device_id!("LAPTOP"), 200));
        assert_eq!(store.members(200).len(), 1);
        assert!(store.apply_authenticated(&replacement, device_id!("PHONE"), 200));
        assert_eq!(
            store.members(200),
            [] as [crate::calls::membership::CallMember; 0]
        );
    }

    #[test]
    fn authenticated_membership_uses_the_sending_device_if_not_claimed() {
        let mut store = StickyMemberships::default();
        let mut event = sticky_event("$a", 100);
        event["content"]["member"]
            .as_object_mut()
            .unwrap()
            .remove("device_id");
        assert!(store.apply_authenticated(&event, device_id!("PHONE"), 100));
        assert_eq!(
            store.members(100)[0].device_id.as_deref(),
            Some(device_id!("PHONE"))
        );
    }

    #[test]
    fn plaintext_replacement_cannot_remove_an_authenticated_member() {
        let mut store = StickyMemberships::default();
        assert!(store.apply_authenticated(&sticky_event("$a", 100), device_id!("PHONE"), 100));
        assert!(!store.apply_untrusted(&sticky_event("$b", 200), 200));
        assert_eq!(store.members(200).len(), 1);
        assert!(!store.apply_authenticated(&sticky_event("$a", 100), device_id!("PHONE"), 300));
    }

    #[test]
    fn stable_and_deployed_slots_keep_distinct_memberships() {
        let mut store = StickyMemberships::default();
        assert!(store.apply(&sticky_event("$a", 100), 100));
        let mut stable = sticky_event("$b", 100);
        stable["type"] = json!("m.rtc.member");
        stable["content"] = json!({
            "slot_id": "m.call#room",
            "sticky_key": "member",
            "application": {"type": "m.call"},
            "member": {"id": "member", "membership": "join"},
            "transports": {"published": [{"type": "m.livekit", "url": "wss://focus.example"}]}
        });
        assert!(store.apply(&stable, 100));
        assert_eq!(store.members(100).len(), 2);
        stable["event_id"] = json!("$c");
        stable["origin_server_ts"] = json!(200);
        stable["content"] = json!({
            "slot_id": "m.call#room", "sticky_key": "member",
            "member": {"id": "member", "membership": "leave"}
        });
        assert!(store.apply(&stable, 200));
        let remaining = store.members(200);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].wire, super::RtcWire::Deployed);
    }

    #[test]
    fn sticky_map_separates_event_types() {
        let mut store = StickyMemberships::default();
        assert!(store.apply(&sticky_event("$a", 100), 100));
        let mut other_type = sticky_event("$b", 100);
        other_type["type"] = json!("m.rtc.member");
        assert!(store.apply(&other_type, 100));
        other_type["event_id"] = json!("$c");
        other_type["origin_server_ts"] = json!(200);
        other_type["content"] = json!({"slot_id": "m.call#ROOM", "msc4354_sticky_key": "member"});
        assert!(store.apply(&other_type, 200));
        assert_eq!(store.members(200).len(), 1);
    }

    #[test]
    fn sticky_expiry_uses_the_envelope_and_receipt_ttl_without_extending_replays() {
        let mut store = super::StickyMemberships::default();
        let event = sticky_event("$a", 100);
        assert!(store.apply(&event, 200));
        assert_eq!(store.members(200)[0].expires_at_ms, Some(900_100));
        assert_eq!(
            store.members(900_100),
            [] as [crate::calls::membership::CallMember; 0]
        );
        let mut event = sticky_event("$b", 500);
        event["unsigned"] = serde_json::json!({"msc4354_sticky_duration_ttl_ms": 300});
        assert!(store.apply(&event, 1000));
        assert_eq!(store.members(1000)[0].expires_at_ms, Some(1300));
        assert!(!store.apply(&event, 1100));
        assert_eq!(
            store.members(1300),
            [] as [crate::calls::membership::CallMember; 0]
        );
    }

    #[test]
    fn sticky_expiry_accepts_the_stable_remaining_duration() {
        let mut store = StickyMemberships::default();
        let mut event = sticky_event("$a", 100);
        event["unsigned"] = json!({"sticky_duration_remaining_ms": 300});
        assert!(store.apply(&event, 1000));
        assert_eq!(store.members(1000)[0].expires_at_ms, Some(1300));
    }

    #[test]
    fn sticky_expiry_without_a_ttl_does_not_extend_a_future_timestamp() {
        let mut store = super::StickyMemberships::default();
        let event = sticky_event("$future", 2_000);
        assert!(store.apply(&event, 1_000));
        assert_eq!(store.members(1_000)[0].expires_at_ms, Some(901_000));
        assert_eq!(
            store.members(901_000),
            [] as [crate::calls::membership::CallMember; 0]
        );
    }

    #[test]
    fn sticky_tombstones_override_older_memberships_and_are_sender_scoped() {
        let mut store = super::StickyMemberships::default();
        let event = sticky_event("$a", 100);
        assert!(store.apply(&event, 100));
        let mut leave = sticky_event("$b", 200);
        leave["content"] = serde_json::json!({"msc4354_sticky_key":"member"});
        leave["sender"] = serde_json::json!("@other:localhost");
        assert!(store.apply(&leave, 200));
        assert_eq!(store.members(200).len(), 1);
        leave["sender"] = serde_json::json!("@erwan:localhost");
        assert!(store.apply(&leave, 200));
        assert_eq!(
            store.members(200),
            [] as [crate::calls::membership::CallMember; 0]
        );
        assert!(!store.apply(&event, 300));
        assert_eq!(
            store.members(300),
            [] as [crate::calls::membership::CallMember; 0]
        );
    }

    #[test]
    fn a_sticky_renewal_keeps_the_time_the_member_joined() {
        let mut store = super::StickyMemberships::default();
        assert!(store.apply(&sticky_event("$a", 100), 100));
        assert!(store.apply(&sticky_event("$b", 600_000), 600_000));
        let member = &store.members(600_000)[0];
        assert_eq!(member.created_ts, 600_000);
        assert_eq!(member.joined_ts, 100);

        let mut rejoin = sticky_event("$c", 700_000);
        rejoin["content"]["member"]["id"] = serde_json::json!("fresh");
        rejoin["content"]["msc4354_sticky_key"] = serde_json::json!("fresh");
        assert!(store.apply(&rejoin, 700_000));
        let fresh = store
            .members(700_000)
            .into_iter()
            .find(|member| member.member_id.as_deref() == Some("fresh"));
        assert_eq!(fresh.map(|member| member.joined_ts), Some(700_000));
    }

    #[test]
    fn a_different_device_with_the_same_member_id_has_a_new_join_time() {
        let mut store = StickyMemberships::default();
        assert!(store.apply(&sticky_event("$a", 100), 100));
        let mut replacement = sticky_event("$b", 200);
        replacement["content"]["member"]["device_id"] = json!("LAPTOP");
        assert!(store.apply(&replacement, 200));
        let member = &store.members(200)[0];
        assert_eq!(member.device_id.as_deref(), Some(device_id!("LAPTOP")));
        assert_eq!(member.joined_ts, 200);
    }

    #[test]
    fn a_sticky_leave_that_names_its_slot_is_a_tombstone() {
        let mut store = super::StickyMemberships::default();
        assert!(store.apply(&sticky_event("$a", 100), 100));
        let mut leave = sticky_event("$b", 200);
        leave["type"] = serde_json::json!("org.matrix.msc4143.rtc.member");
        leave["content"] =
            serde_json::json!({"slot_id":"m.call#ROOM", "msc4354_sticky_key":"member"});
        assert!(store.apply(&leave, 200));
        assert_eq!(
            store.members(200),
            [] as [crate::calls::membership::CallMember; 0]
        );
    }

    #[test]
    fn an_explicit_sticky_leave_is_a_tombstone() {
        let mut store = super::StickyMemberships::default();
        assert!(store.apply(&sticky_event("$a", 100), 100));
        let mut leave = sticky_event("$b", 200);
        leave["content"] = serde_json::json!({
            "slot_id": "m.call#ROOM",
            "member": {"id": "member", "membership": "leave"},
            "leave_reason": {"code": "leave"},
            "msc4354_sticky_key": "member",
        });
        assert!(store.apply(&leave, 200));
        assert_eq!(
            store.members(200),
            [] as [crate::calls::membership::CallMember; 0]
        );
    }

    #[test]
    fn a_non_joined_membership_replaces_an_older_join() {
        let mut store = super::StickyMemberships::default();
        let joined = sticky_event("$a", 100);
        assert!(store.apply(&joined, 100));
        let mut updated = sticky_event("$b", 200);
        updated["content"]["member"]["membership"] = serde_json::json!("other");
        assert!(store.apply(&updated, 200));
        assert_eq!(
            store.members(200),
            [] as [crate::calls::membership::CallMember; 0]
        );
        assert!(!store.apply(&joined, 300));
    }

    #[test]
    fn sticky_order_uses_server_expiry_and_event_id_not_receipt_time() {
        let mut store = super::StickyMemberships::default();
        let newer = sticky_event("$z", 200);
        assert!(store.apply(&newer, 200));
        let mut stale = sticky_event("$a", 100);
        stale["unsigned"] = serde_json::json!({"msc4354_sticky_duration_ttl_ms":900_000});
        assert!(!store.apply(&stale, 1000));
        stale["origin_server_ts"] = serde_json::json!(200);
        assert!(!store.apply(&stale, 1000));
        assert_eq!(store.members(1000)[0].created_ts, 200);
    }

    #[test]
    fn malformed_sticky_memberships_cannot_act_as_leave_events() {
        let mut store = super::StickyMemberships::default();
        assert!(store.apply(&sticky_event("$a", 100), 100));
        for (field, value) in [
            ("slot_id", serde_json::json!("m.call#OTHER")),
            ("application", serde_json::json!({"type":"other"})),
            (
                "member",
                serde_json::json!({"user_id":"@forged:localhost","device_id":"PHONE","id":"member"}),
            ),
        ] {
            let mut event = sticky_event("$b", 200);
            event["content"][field] = value;
            assert!(!store.apply(&event, 200));
            assert_eq!(store.members(200).len(), 1);
        }
    }

    #[test]
    fn a_sticky_member_id_must_match_its_sticky_key() {
        let mut store = super::StickyMemberships::default();
        let mut event = sticky_event("$mismatch", 100);
        event["content"]["member"]["id"] = serde_json::json!("other");
        assert!(!store.apply(&event, 100));
        assert_eq!(
            store.members(100),
            [] as [crate::calls::membership::CallMember; 0]
        );
    }
    #[tokio::test]
    async fn state_memberships_survive_the_sdk_store_for_both_focus_modes() {
        use matrix_sdk::ruma::{events::AnySyncStateEvent, room_id, serde::Raw};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use matrix_sdk_test::JoinedRoomBuilder;
        use serde_json::json;

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!call:example.org");
        let now = super::super::keys::now_ms();
        let mut builder = JoinedRoomBuilder::new(room_id);
        for (device, selection) in [("LEGACY", "oldest_membership"), ("COMPAT", "multi_sfu")] {
            let event = json!({
                "type": "org.matrix.msc3401.call.member",
                "state_key": format!("_@user:example.org_{device}_m.call"),
                "sender": "@user:example.org", "event_id": format!("${device}"),
                "origin_server_ts": now,
                "content": {
                    "application": "m.call", "call_id": "", "scope": "m.room",
                    "device_id": device, "created_ts": now, "expires": 14_400_000,
                    "focus_active": {"type":"livekit", "focus_selection": selection},
                    "foci_preferred": [{"type":"livekit", "livekit_service_url":"https://sfu.example.org", "livekit_alias":room_id}]
                }
            });
            builder = builder.add_state_event(
                Raw::new(&event)
                    .unwrap()
                    .cast_unchecked::<AnySyncStateEvent>(),
            );
        }
        let room = server.sync_room(&client, builder).await;
        let members = super::active_members(&room).await;
        assert_eq!(members.len(), 2);
        for (device, mode) in [
            ("LEGACY", CallMode::Legacy),
            ("COMPAT", CallMode::Compatibility),
        ] {
            let member = members
                .iter()
                .find(|member| {
                    member
                        .device_id
                        .as_deref()
                        .is_some_and(|id| id.as_str() == device)
                })
                .unwrap();
            assert_eq!(member.mode, mode);
            assert_eq!(member.identity, format!("@user:example.org:{device}"));
            assert_eq!(
                member.member_id.as_deref(),
                Some(format!("@user:example.org:{device}").as_str())
            );
            assert_eq!(member.foci, ["https://sfu.example.org"]);
        }
    }

    #[tokio::test]
    async fn state_membership_uses_its_custom_membership_id() {
        use matrix_sdk::ruma::{events::AnySyncStateEvent, room_id, serde::Raw};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use matrix_sdk_test::JoinedRoomBuilder;
        use serde_json::json;

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!call:example.org");
        let now = super::super::keys::now_ms();
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
                "foci_preferred": [{"type":"livekit", "livekit_service_url":"https://sfu.example.org", "livekit_alias":room_id}]
            }
        });
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_state_event(
                    Raw::new(&event)
                        .unwrap()
                        .cast_unchecked::<AnySyncStateEvent>(),
                ),
            )
            .await;

        let members = super::active_members(&room).await;
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].member_id.as_deref(), Some("custom-membership"));
        assert_eq!(members[0].identity, "@user:example.org:DEVICE");
    }

    fn tombstone(extra: &serde_json::Value) -> serde_json::Value {
        let mut event = json!({
            "type": "org.matrix.msc4143.rtc.member",
            "sender": "@a:example.org",
            "event_id": "$e",
            "origin_server_ts": 1_000,
            "msc4354_sticky": { "duration_ms": 5_000 },
            "content": { "msc4354_sticky_key": "k", "slot_id": "m.call#ROOM" },
        });
        for (key, value) in extra.as_object().expect("object") {
            event[key] = value.clone();
        }
        event
    }

    #[test]
    fn a_tombstone_applies_and_wrong_typed_fields_reject_the_event() {
        let apply = |event: serde_json::Value| StickyMemberships::default().apply(&event, 1_000);
        assert!(apply(tombstone(&json!({}))));
        assert!(!apply(tombstone(&json!({
            "msc4354_sticky": null, "sticky": { "duration_ms": 5_000 }
        }))));
        assert!(!apply(tombstone(&json!({
            "msc4354_sticky": { "duration_ms": "5" }, "sticky": { "duration_ms": 5_000 }
        }))));
        assert!(!apply(tombstone(&json!({
            "msc4354_sticky": null, "sticky": { "duration_ms": 5_000 }, "type": 3
        }))));
        assert!(!apply(tombstone(&json!({ "sender": 3 }))));
        assert!(!apply(tombstone(&json!({ "event_id": "" }))));
        assert!(!apply(tombstone(&json!({ "origin_server_ts": "1" }))));
        assert!(!apply(tombstone(&json!({ "content": "x" }))));
        assert!(!apply(json!("x")));
    }

    #[test]
    fn the_legacy_sticky_key_and_extra_content_decide_what_a_member_is() {
        let mut sticky = StickyMemberships::default();
        let mut event = tombstone(&json!({ "sticky": { "duration_ms": 5_000 } }));
        event["msc4354_sticky"] = serde_json::Value::Null;
        event["content"] = json!({ "sticky_key": "k", "msc4354_sticky_key": "other" });
        assert!(!sticky.apply(&event, 1_000));
        event["content"] = json!({ "sticky_key": "k" });
        event
            .as_object_mut()
            .expect("object")
            .remove("msc4354_sticky");
        assert!(sticky.apply(&event, 1_000));
        event["event_id"] = json!("$f");
        event["content"] = json!({ "sticky_key": "k", "foreign": 1 });
        assert!(!sticky.apply(&event, 1_000), "not a tombstone nor a member");
    }
}
