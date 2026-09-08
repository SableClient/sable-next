use base64::Engine as _;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use std::collections::HashMap;

use matrix_sdk::Room;
use matrix_sdk::ruma::events::call::member::{
    ActiveFocus, Application, CallMemberEventContent, CallScope, Focus, MembershipData,
};
use matrix_sdk::ruma::{DeviceId, OwnedDeviceId, OwnedUserId, UserId};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

use crate::protocol::CallMode;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StickyMember {
    pub(crate) user_id: OwnedUserId,
    pub(crate) device_id: OwnedDeviceId,
    pub(crate) member_id: String,
    pub(crate) identity: String,
    pub(crate) foci: Vec<String>,
}

#[derive(Default)]
pub(crate) struct StickyMemberships {
    entries: HashMap<(OwnedUserId, String), StickyEntry>,
}

struct StickyEntry {
    member: Option<StickyMember>,
    expires_at_ms: u64,
    event_id: String,
    order_expires_at_ms: u64,
    created_ts: u64,
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
}

#[derive(Debug, Deserialize)]
struct StickyApplication {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Deserialize)]
struct StickyMemberRef {
    user_id: OwnedUserId,
    device_id: OwnedDeviceId,
    id: String,
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
}

pub(crate) fn sticky_member(raw: &str) -> Option<StickyMember> {
    let event: StickyEvent = serde_json::from_str(raw).ok()?;
    let member = event.content.member?;
    if event.content.slot_id != "m.call#ROOM"
        || event.content.application.kind != "m.call"
        || member.user_id != event.sender
    {
        return None;
    }
    if member.id.is_empty() {
        return None;
    }
    let foci = event
        .content
        .transports
        .published
        .into_iter()
        .filter(|transport| transport.kind == "livekit")
        .filter_map(|transport| transport.livekit_service_url)
        .filter(|url| !url.is_empty())
        .collect();
    let identity = sticky_identity(&event.sender, &member.device_id, &member.id);
    Some(StickyMember {
        user_id: event.sender,
        device_id: member.device_id,
        member_id: member.id,
        identity,
        foci,
    })
}

pub(crate) fn sticky_identity(user_id: &UserId, device_id: &DeviceId, member_id: &str) -> String {
    let source = serde_json::json!([user_id.as_str(), device_id.as_str(), member_id]).to_string();
    STANDARD_NO_PAD.encode(Sha256::digest(source.as_bytes()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallMember {
    pub(crate) user_id: OwnedUserId,
    pub(crate) device_id: OwnedDeviceId,
    pub(crate) member_id: Option<String>,
    pub(crate) identity: String,
    pub(crate) mode: CallMode,
    pub(crate) created_ts: u64,
    pub(crate) expires_at_ms: Option<u64>,
    pub(crate) foci: Vec<String>,
}

impl CallMember {
    pub(crate) fn is_own(&self, user_id: &UserId, device_id: &DeviceId) -> bool {
        self.user_id == user_id && self.device_id == device_id
    }

    pub(crate) fn same_generation(&self, other: &Self) -> bool {
        self.user_id == other.user_id
            && self.device_id == other.device_id
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
        let membership_id = match &raw {
            matrix_sdk::deserialized_responses::RawSyncOrStrippedState::Sync(raw) => raw
                .deserialize_as::<serde_json::Value>()
                .ok()
                .and_then(|event| {
                    event
                        .get("content")?
                        .get("membershipID")?
                        .as_str()
                        .map(str::to_owned)
                }),
            matrix_sdk::deserialized_responses::RawSyncOrStrippedState::Stripped(_) => None,
        };
        let Ok(event) = raw.deserialize() else {
            continue;
        };
        let Some(event) = event.as_sync().and_then(|sync| sync.as_original()) else {
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
            members.push(CallMember {
                user_id: event.state_key.user_id().to_owned(),
                device_id: membership.device_id().to_owned(),
                member_id: Some(match membership {
                    MembershipData::Legacy(data) => data.membership_id.clone(),
                    MembershipData::Session(_) => membership_id.clone().unwrap_or_else(|| {
                        format!("{}:{}", event.state_key.user_id(), membership.device_id())
                    }),
                    _ => format!("{}:{}", event.state_key.user_id(), membership.device_id()),
                }),
                identity: format!("{}:{}", event.state_key.user_id(), membership.device_id()),
                mode,
                created_ts: membership
                    .created_ts()
                    .unwrap_or(origin_server_ts)
                    .get()
                    .into(),
                expires_at_ms: membership
                    .expires_ts(Some(origin_server_ts))
                    .map(|expires| expires.get().into()),
                foci: livekit_urls(membership.foci_preferred()),
            });
        }
    }
    members
}

impl StickyMemberships {
    pub(crate) fn apply(&mut self, value: &serde_json::Value, now_ms: u64) -> bool {
        use serde_json::Value;
        self.entries.retain(|_, entry| entry.expires_at_ms > now_ms);
        if value.get("type").and_then(Value::as_str) != Some("m.rtc.member") {
            return false;
        }
        let Some(content) = value.get("content").and_then(Value::as_object) else {
            return false;
        };
        let stable_key = content.get("sticky_key").and_then(Value::as_str);
        let unstable_key = content.get("msc4354_sticky_key").and_then(Value::as_str);
        if stable_key.is_some() && unstable_key.is_some() && stable_key != unstable_key {
            return false;
        }
        let Some(key) = unstable_key.or(stable_key).filter(|key| !key.is_empty()) else {
            return false;
        };
        let Some(sender) = value
            .get("sender")
            .and_then(Value::as_str)
            .and_then(|id| OwnedUserId::try_from(id).ok())
        else {
            return false;
        };
        let Some(event_id) = value
            .get("event_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return false;
        };
        let Some(created_ts) = value.get("origin_server_ts").and_then(Value::as_u64) else {
            return false;
        };
        let Some(duration) = value
            .get("msc4354_sticky")
            .or_else(|| value.get("sticky"))
            .and_then(|sticky| sticky.get("duration_ms"))
            .and_then(Value::as_u64)
        else {
            return false;
        };
        let duration = duration.min(3_600_000);
        let order_expires_at_ms = created_ts.saturating_add(duration);
        let expires_at_ms = value
            .get("unsigned")
            .and_then(|unsigned| {
                unsigned
                    .get("msc4354_sticky_duration_ttl_ms")
                    .or_else(|| unsigned.get("sticky_duration_ttl_ms"))
            })
            .and_then(Value::as_u64)
            .map_or(now_ms.min(created_ts).saturating_add(duration), |ttl| {
                now_ms.saturating_add(ttl.min(duration))
            });
        let entry_key = (sender, key.to_owned());
        if self.entries.get(&entry_key).is_some_and(|old| {
            (order_expires_at_ms, event_id) <= (old.order_expires_at_ms, old.event_id.as_str())
        }) {
            return false;
        }
        let tombstone = content
            .keys()
            .all(|field| field == "sticky_key" || field == "msc4354_sticky_key");
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
        self.entries.insert(
            entry_key,
            StickyEntry {
                member,
                expires_at_ms,
                event_id: event_id.to_owned(),
                order_expires_at_ms,
                created_ts,
            },
        );
        true
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
                    expires_at_ms: Some(entry.expires_at_ms),
                    foci: member.foci.clone(),
                })
            })
            .collect()
    }
}

fn livekit_urls(foci: &[Focus]) -> Vec<String> {
    foci.iter()
        .filter_map(|focus| match focus {
            Focus::Livekit(livekit) => Some(livekit.service_url.clone()),
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

    use super::{CallMember, advertised_service_urls, sticky_member};
    use crate::protocol::CallMode;

    fn member(device: &str, created_ts: u64, foci: &[&str]) -> CallMember {
        CallMember {
            user_id: owned_user_id!("@erwan:localhost"),
            device_id: device.into(),
            member_id: None,
            identity: format!("@erwan:localhost:{device}"),
            mode: CallMode::Legacy,
            created_ts,
            expires_at_ms: None,
            foci: foci.iter().map(|url| (*url).to_owned()).collect(),
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
        assert_eq!(member.device_id, device_id!("LAPTOP"));
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
            "type":"m.rtc.member", "sender":"@erwan:localhost", "event_id":id,
            "origin_server_ts":origin,"msc4354_sticky":{"duration_ms":900_000},
            "content":{"msc4354_sticky_key":"member", "slot_id":"m.call#ROOM", "application":{"type":"m.call"},
                "member":{"user_id":"@erwan:localhost","device_id":"PHONE","id":"member"},
                "transports":{"published":[{"type":"livekit","livekit_service_url":"https://sfu.example"}]}}
        })
    }

    #[test]
    fn sticky_expiry_uses_the_envelope_and_receipt_ttl_without_extending_replays() {
        let mut store = super::StickyMemberships::default();
        let event = sticky_event("$a", 100);
        assert!(store.apply(&event, 200));
        assert_eq!(store.members(200)[0].expires_at_ms, Some(900_100));
        assert!(store.members(900_100).is_empty());
        let mut event = sticky_event("$b", 500);
        event["unsigned"] = serde_json::json!({"msc4354_sticky_duration_ttl_ms": 300});
        assert!(store.apply(&event, 1000));
        assert_eq!(store.members(1000)[0].expires_at_ms, Some(1300));
        assert!(!store.apply(&event, 1100));
        assert!(store.members(1300).is_empty());
    }

    #[test]
    fn sticky_expiry_without_a_ttl_does_not_extend_a_future_timestamp() {
        let mut store = super::StickyMemberships::default();
        let event = sticky_event("$future", 2_000);
        assert!(store.apply(&event, 1_000));
        assert_eq!(store.members(1_000)[0].expires_at_ms, Some(901_000));
        assert!(store.members(901_000).is_empty());
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
        assert!(store.members(200).is_empty());
        assert!(!store.apply(&event, 300));
        assert!(store.members(300).is_empty());
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
        assert!(store.members(100).is_empty());
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
                .find(|member| member.device_id == device)
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
}
