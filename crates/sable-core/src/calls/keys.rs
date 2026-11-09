use crate::now_ms;
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use matrix_sdk::Room;
use matrix_sdk::ruma::events::macros::EventContent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedDeviceId, OwnedRoomId, OwnedUserId};
use matrix_sdk_base::crypto::CollectStrategy;
use serde::{Deserialize, Serialize};

use super::membership::CallMember;

pub(crate) const KEY_BYTES: usize = 32;
const MIN_RECEIVED_KEY_BYTES: usize = 16;
pub(crate) const ROTATION_GRACE_MS: u64 = 10_000;
pub(crate) const USE_KEY_DELAY_MS: u64 = 5_000;
pub(crate) const RESHARE_INTERVAL_MS: u64 = 60_000;
const KEY_ROTATION_INTERVAL_MS: u64 = 3_600_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct KeyPayload {
    pub(crate) index: u8,
    pub(crate) key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct MemberRef {
    pub(crate) claimed_device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct SessionRef {
    pub(crate) call_id: String,
    pub(crate) application: String,
    pub(crate) scope: String,
}

impl Default for SessionRef {
    fn default() -> Self {
        Self {
            call_id: String::new(),
            application: "m.call".to_owned(),
            scope: "m.room".to_owned(),
        }
    }
}

impl SessionRef {
    pub(crate) fn is_legacy_room_call(&self) -> bool {
        self.call_id.is_empty() && self.application == "m.call" && self.scope == "m.room"
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "io.element.call.encryption_keys", kind = ToDevice)]
pub(crate) struct ToDeviceCallEncryptionKeysEventContent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) media_key: Option<KeyPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) keys: Option<KeyPayload>,
    pub(crate) room_id: OwnedRoomId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) member_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) member: Option<MemberRef>,
    #[serde(default)]
    pub(crate) session: SessionRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) sent_ts: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "m.rtc.encryption_key", kind = ToDevice)]
pub(crate) struct StableEncryptionKeyEventContent {
    #[serde(flatten)]
    pub(crate) content: ToDeviceCallEncryptionKeysEventContent,
}

impl ToDeviceCallEncryptionKeysEventContent {
    pub(crate) fn key(&self) -> Option<&KeyPayload> {
        self.media_key.as_ref().or(self.keys.as_ref())
    }

    pub(crate) fn member_id(&self) -> Option<&str> {
        self.member_id
            .as_deref()
            .or_else(|| self.member.as_ref()?.id.as_deref())
    }

    pub(crate) fn claimed_device_id(&self) -> Option<&str> {
        self.member
            .as_ref()
            .map(|member| member.claimed_device_id.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OutboundKey {
    pub(crate) key: [u8; KEY_BYTES],
    pub(crate) index: u8,
    pub(crate) created_ts: u64,
    pub(crate) shared_with: Vec<CallMember>,
    pub(crate) failed: Vec<CallMember>,
}

impl OutboundKey {
    pub(crate) fn generate(index: u8, created_ts: u64) -> Result<Self, getrandom::Error> {
        let mut key = [0u8; KEY_BYTES];
        getrandom::fill(&mut key)?;
        Ok(Self {
            key,
            index,
            created_ts,
            shared_with: Vec::new(),
            failed: Vec::new(),
        })
    }

    pub(crate) const fn next_index(current: Option<&Self>) -> u8 {
        match current {
            Some(key) => key.index.wrapping_add(1),
            None => 0,
        }
    }

    pub(crate) fn encoded(&self) -> String {
        STANDARD_NO_PAD.encode(self.key)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Rollout {
    Unchanged,
    Share { targets: Vec<CallMember> },
    Rotate { targets: Vec<CallMember> },
}

pub(crate) fn plan_rollout(
    current: Option<&OutboundKey>,
    members: &[CallMember],
    now_ms: u64,
    grace_ms: u64,
) -> Rollout {
    let Some(current) = current else {
        return Rollout::Rotate {
            targets: members.to_vec(),
        };
    };

    let still_valid: Vec<&CallMember> = current
        .shared_with
        .iter()
        .filter(|shared| !rejoined(shared, members))
        .collect();

    let anyone_left = still_valid
        .iter()
        .any(|shared| !members.iter().any(|member| member.same_generation(shared)));
    if anyone_left || now_ms.saturating_sub(current.created_ts) >= KEY_ROTATION_INTERVAL_MS {
        return Rollout::Rotate {
            targets: members.to_vec(),
        };
    }

    let (retry, fresh): (Vec<CallMember>, Vec<CallMember>) = members
        .iter()
        .filter(|member| {
            !still_valid
                .iter()
                .any(|shared| shared.same_generation(member))
        })
        .cloned()
        .partition(|member| {
            current
                .failed
                .iter()
                .any(|failed| failed.same_generation(member))
        });

    if fresh.is_empty() {
        return if retry.is_empty() {
            Rollout::Unchanged
        } else {
            Rollout::Share { targets: retry }
        };
    }

    if now_ms.saturating_sub(current.created_ts) < grace_ms {
        Rollout::Share {
            targets: [fresh, retry].concat(),
        }
    } else {
        Rollout::Rotate {
            targets: members.to_vec(),
        }
    }
}

pub(crate) fn rotation_wait_ms(
    current: Option<&OutboundKey>,
    now_ms: u64,
    delay_ms: u64,
) -> Option<u64> {
    let age = now_ms.saturating_sub(current?.created_ts);
    (age < delay_ms).then(|| delay_ms - age)
}

fn rejoined(shared: &CallMember, members: &[CallMember]) -> bool {
    members.iter().any(|member| {
        member.user_id == shared.user_id
            && member.device_id == shared.device_id
            && !member.same_generation(shared)
    })
}

pub(crate) struct Announcement {
    pub(crate) identity: String,
    pub(crate) index: u8,
    pub(crate) encoded: String,
}

pub(crate) enum Rolled {
    Nothing,
    Shared,
    Reshared,
    Deferred {
        wait_ms: u64,
    },
    Rotated {
        announcement: Announcement,
        first: bool,
    },
}

pub(crate) struct KeyDistributor {
    room_id: OwnedRoomId,
    user_id: OwnedUserId,
    device_id: OwnedDeviceId,
    member_id: String,
    identity: String,
    outbound: Option<OutboundKey>,
    last_sent_ms: u64,
    wire: super::membership::RtcWire,
}

impl KeyDistributor {
    pub(crate) const fn new(
        room_id: OwnedRoomId,
        user_id: OwnedUserId,
        device_id: OwnedDeviceId,
        member_id: String,
        identity: String,
    ) -> Self {
        Self {
            room_id,
            user_id,
            device_id,
            member_id,
            identity,
            outbound: None,
            last_sent_ms: 0,
            wire: super::membership::RtcWire::Deployed,
        }
    }

    pub(crate) const fn set_wire(&mut self, wire: super::membership::RtcWire) {
        self.wire = wire;
    }

    pub(crate) async fn roll(&mut self, room: &Room, members: &[CallMember]) -> Rolled {
        match plan_rollout(self.outbound.as_ref(), members, now_ms(), ROTATION_GRACE_MS) {
            Rollout::Unchanged => {
                let due = self.outbound.is_some()
                    && now_ms().saturating_sub(self.last_sent_ms) >= RESHARE_INTERVAL_MS;
                if !due {
                    return Rolled::Nothing;
                }
                self.share_current(room, members).await;
                Rolled::Reshared
            }
            Rollout::Share { targets } => {
                self.share_current(room, &targets).await;
                Rolled::Shared
            }
            Rollout::Rotate { targets } => {
                if let Some(wait_ms) =
                    rotation_wait_ms(self.outbound.as_ref(), now_ms(), USE_KEY_DELAY_MS)
                {
                    let fresh = self.unshared(&targets);
                    self.share_current(room, &fresh).await;
                    return Rolled::Deferred { wait_ms };
                }
                let first = self.outbound.is_none();
                let index = OutboundKey::next_index(self.outbound.as_ref());
                let Ok(mut key) = OutboundKey::generate(index, now_ms()) else {
                    tracing::error!("no entropy available for a call encryption key");
                    return Rolled::Nothing;
                };

                let reached = self.send(room, &key, &targets).await;
                self.last_sent_ms = now_ms();
                key.created_ts = self.last_sent_ms;

                let announcement = Announcement {
                    identity: self.identity.clone(),
                    index: key.index,
                    encoded: key.encoded(),
                };
                let failed = unreached(&targets, &reached);
                warn_unreached(&failed, &[]);
                self.outbound = Some(OutboundKey {
                    failed,
                    shared_with: reached,
                    ..key
                });
                Rolled::Rotated {
                    announcement,
                    first,
                }
            }
        }
    }

    fn unshared(&self, members: &[CallMember]) -> Vec<CallMember> {
        let shared = self
            .outbound
            .as_ref()
            .map_or(&[][..], |key| &key.shared_with);
        members
            .iter()
            .filter(|member| !shared.iter().any(|shared| shared.same_generation(member)))
            .cloned()
            .collect()
    }

    async fn share_current(&mut self, room: &Room, targets: &[CallMember]) {
        let Some(key) = self.outbound.clone() else {
            return;
        };
        if targets.is_empty() {
            return;
        }
        let reached = self.send(room, &key, targets).await;
        self.last_sent_ms = now_ms();
        if let Some(outbound) = self.outbound.as_mut() {
            let unreached = unreached(targets, &reached);
            warn_unreached(&unreached, &outbound.failed);
            outbound
                .failed
                .retain(|failed| !targets.iter().any(|target| target.same_generation(failed)));
            outbound.failed.extend(unreached);
            outbound
                .shared_with
                .retain(|shared| !reached.iter().any(|member| member.same_generation(shared)));
            outbound.shared_with.extend(reached);
        }
    }

    fn key_event(&self, key: &OutboundKey) -> ToDeviceCallEncryptionKeysEventContent {
        let payload = KeyPayload {
            index: key.index,
            key: key.encoded(),
        };
        ToDeviceCallEncryptionKeysEventContent {
            media_key: Some(payload.clone()),
            keys: Some(payload),
            room_id: self.room_id.clone(),
            member_id: Some(self.member_id.clone()),
            member: Some(MemberRef {
                claimed_device_id: self.device_id.to_string(),
                id: Some(self.member_id.clone()),
            }),
            session: SessionRef::default(),
            sent_ts: Some(now_ms()),
        }
    }

    async fn send(
        &self,
        room: &Room,
        key: &OutboundKey,
        targets: &[CallMember],
    ) -> Vec<CallMember> {
        let encryption = room.client().encryption();
        let mut devices = Vec::new();
        let mut reached = Vec::new();
        let mut queried = Vec::new();
        for target in targets {
            if target.is_own(&self.user_id, &self.device_id) {
                reached.push(target.clone());
                continue;
            }
            let Some(device_id) = target.device_id.as_deref() else {
                continue;
            };
            let mut device = encryption.get_device(&target.user_id, device_id).await;
            if matches!(device, Ok(None)) && !queried.contains(&target.user_id) {
                queried.push(target.user_id.clone());
                if let Err(error) = encryption.request_user_identity(&target.user_id).await {
                    tracing::warn!(?error, "could not query a call member's devices");
                }
                device = encryption.get_device(&target.user_id, device_id).await;
            }
            match device {
                Ok(Some(device)) => {
                    devices.push(device);
                    reached.push(target.clone());
                }
                Ok(None) => tracing::warn!(
                    reported = true,
                    user_id = %target.user_id,
                    device_id = %device_id,
                    "call member device is unknown, cannot send it a media key"
                ),
                Err(error) => tracing::warn!(?error, "could not look up a call member device"),
            }
        }

        if devices.is_empty() {
            return reached;
        }

        let content = self.key_event(key);

        let Ok(raw) = Raw::new(&content) else {
            tracing::error!("could not serialize a call media key");
            return Vec::new();
        };

        tracing::debug!(
            index = key.index,
            devices = devices.len(),
            "sending the call media key"
        );
        match encryption
            .encrypt_and_send_raw_to_device(
                devices.iter().collect(),
                if self.wire == super::membership::RtcWire::Stable {
                    "m.rtc.encryption_key"
                } else {
                    "io.element.call.encryption_keys"
                },
                raw.cast_unchecked(),
                CollectStrategy::AllDevices,
            )
            .await
        {
            Ok(failures) if failures.is_empty() => reached,
            Ok(failures) => {
                tracing::warn!(
                    reported = true,
                    count = failures.len(),
                    "some call members did not receive the media key"
                );
                reached.retain(|member| {
                    !failures.iter().any(|(user_id, device_id)| {
                        *user_id == member.user_id
                            && member.device_id.as_deref() == Some(device_id.as_ref())
                    })
                });
                reached
            }
            Err(error) => {
                tracing::warn!(reported = true, ?error, "could not send the call media key");
                reached.retain(|member| member.is_own(&self.user_id, &self.device_id));
                reached
            }
        }
    }
}

fn unreached(targets: &[CallMember], reached: &[CallMember]) -> Vec<CallMember> {
    targets
        .iter()
        .filter(|target| !reached.contains(target))
        .cloned()
        .collect()
}

fn warn_unreached(unreached: &[CallMember], known: &[CallMember]) {
    for member in unreached
        .iter()
        .filter(|member| !known.iter().any(|known| known.same_generation(member)))
    {
        tracing::warn!(
            reported = true,
            user_id = %member.user_id,
            device_id = ?member.device_id,
            "a call member did not receive the media key"
        );
    }
}

pub(crate) fn decode_key(encoded: &str) -> Option<Vec<u8>> {
    STANDARD
        .decode(encoded)
        .or_else(|_| STANDARD_NO_PAD.decode(encoded))
        .ok()
        .filter(|key| key.len() >= MIN_RECEIVED_KEY_BYTES)
}

pub(crate) fn decode_key_for_wire(
    encoded: &str,
    wire: super::membership::RtcWire,
) -> Option<Vec<u8>> {
    decode_key(encoded)
        .filter(|key| wire != super::membership::RtcWire::Stable || key.len() >= KEY_BYTES)
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{owned_room_id, owned_user_id};

    use super::super::membership::CallMember;
    use super::{
        KEY_BYTES, KeyDistributor, OutboundKey, Rollout, SessionRef,
        ToDeviceCallEncryptionKeysEventContent, decode_key, plan_rollout, rotation_wait_ms,
    };

    fn member(device: &str, created_ts: u64) -> CallMember {
        CallMember {
            user_id: owned_user_id!("@kris:localhost"),
            device_id: Some(device.into()),
            member_id: None,
            identity: format!("@kris:localhost:{device}"),
            mode: crate::protocol::CallMode::Legacy,
            created_ts,
            joined_ts: created_ts,
            expires_at_ms: None,
            foci: Vec::new(),
            screen_sharing: false,
            wire: super::super::membership::RtcWire::Deployed,
            focus_servers: std::collections::HashMap::default(),
        }
    }

    fn key_shared_with(members: &[CallMember], created_ts: u64) -> OutboundKey {
        OutboundKey {
            key: [7u8; KEY_BYTES],
            index: 3,
            created_ts,
            shared_with: members.to_vec(),
            failed: Vec::new(),
        }
    }

    #[test]
    fn test_the_first_key_goes_to_everyone() {
        let members = vec![member("LAPTOP", 100), member("PHONE", 100)];

        assert_eq!(
            plan_rollout(None, &members, 1_000, 10_000),
            Rollout::Rotate { targets: members }
        );
    }

    #[test]
    fn test_a_leaver_rotates_the_key_for_everyone_still_here() {
        let laptop = member("LAPTOP", 100);
        let phone = member("PHONE", 100);
        let current = key_shared_with(&[laptop.clone(), phone], 1_000);

        assert_eq!(
            plan_rollout(Some(&current), std::slice::from_ref(&laptop), 1_100, 10_000),
            Rollout::Rotate {
                targets: vec![laptop]
            },
            "a device that left keeps the old key, so it must stop working"
        );
    }

    #[test]
    fn test_a_fresh_key_is_shared_with_a_joiner_rather_than_rotated() {
        let laptop = member("LAPTOP", 100);
        let phone = member("PHONE", 200);
        let current = key_shared_with(std::slice::from_ref(&laptop), 1_000);

        assert_eq!(
            plan_rollout(Some(&current), &[laptop, phone.clone()], 1_500, 10_000),
            Rollout::Share {
                targets: vec![phone]
            }
        );
    }

    #[test]
    fn test_a_stale_key_rotates_for_a_joiner() {
        let laptop = member("LAPTOP", 100);
        let phone = member("PHONE", 200);
        let current = key_shared_with(std::slice::from_ref(&laptop), 1_000);
        let members = vec![laptop, phone];

        assert_eq!(
            plan_rollout(Some(&current), &members, 20_000, 10_000),
            Rollout::Rotate { targets: members }
        );
    }

    #[test]
    fn test_nothing_moves_when_the_roster_is_unchanged() {
        let members = vec![member("LAPTOP", 100)];
        let current = key_shared_with(&members, 1_000);

        assert_eq!(
            plan_rollout(Some(&current), &members, 1_100, 10_000),
            Rollout::Unchanged
        );
    }

    #[test]
    fn an_unchanged_roster_rotates_after_the_key_lifetime() {
        let members = vec![member("LAPTOP", 100)];
        let current = key_shared_with(&members, 1_000);
        assert_eq!(
            plan_rollout(
                Some(&current),
                &members,
                1_000 + super::KEY_ROTATION_INTERVAL_MS - 1,
                10_000
            ),
            Rollout::Unchanged
        );
        assert_eq!(
            plan_rollout(
                Some(&current),
                &members,
                1_000 + super::KEY_ROTATION_INTERVAL_MS,
                10_000
            ),
            Rollout::Rotate { targets: members }
        );
    }

    #[test]
    fn test_a_rejoin_is_resent_to_even_though_the_device_is_the_same() {
        let before = member("PHONE", 100);
        let after = member("PHONE", 500);
        let current = key_shared_with(&[before], 1_000);

        assert_eq!(
            plan_rollout(Some(&current), std::slice::from_ref(&after), 1_100, 10_000),
            Rollout::Share {
                targets: vec![after]
            },
            "a rejoiner cleared its keys, so it needs the current one again"
        );
    }

    #[test]
    fn test_a_renewed_sticky_membership_is_not_a_rejoin() {
        let sticky = |created_ts| CallMember {
            member_id: Some("member".to_owned()),
            mode: crate::protocol::CallMode::Matrix2,
            ..member("PHONE", created_ts)
        };
        let current = key_shared_with(&[sticky(100)], 1_000);

        assert_eq!(
            plan_rollout(Some(&current), &[sticky(3_600_100)], 3_600_200, 10_000),
            Rollout::Unchanged,
            "a renewal keeps its member id, so it still holds the current key"
        );
    }

    #[test]
    fn test_a_member_that_could_not_be_reached_does_not_rotate_the_key_again() {
        let laptop = member("LAPTOP", 100);
        let ghost = member("GHOST", 200);
        let members = vec![laptop.clone(), ghost.clone()];
        let current = OutboundKey {
            failed: vec![ghost.clone()],
            ..key_shared_with(std::slice::from_ref(&laptop), 1_000)
        };

        assert_eq!(
            plan_rollout(Some(&current), &members, 20_000, 10_000),
            Rollout::Share {
                targets: vec![ghost]
            },
            "a retry is not a new joiner, so it must not force a rotation"
        );
    }

    #[test]
    fn test_a_new_joiner_still_rotates_a_stale_key_beside_a_failed_member() {
        let laptop = member("LAPTOP", 100);
        let ghost = member("GHOST", 200);
        let phone = member("PHONE", 300);
        let members = vec![laptop.clone(), ghost.clone(), phone];
        let current = OutboundKey {
            failed: vec![ghost],
            ..key_shared_with(std::slice::from_ref(&laptop), 1_000)
        };

        assert_eq!(
            plan_rollout(Some(&current), &members, 20_000, 10_000),
            Rollout::Rotate { targets: members }
        );
    }

    #[test]
    fn test_the_index_wraps_rather_than_overflowing() {
        let last = OutboundKey {
            key: [0u8; KEY_BYTES],
            index: u8::MAX,
            created_ts: 0,
            shared_with: Vec::new(),
            failed: Vec::new(),
        };

        assert_eq!(OutboundKey::next_index(Some(&last)), 0);
        assert_eq!(OutboundKey::next_index(None), 0);
    }

    #[test]
    fn test_a_key_survives_the_round_trip_padded_or_not() {
        let key = OutboundKey {
            key: [9u8; KEY_BYTES],
            index: 0,
            created_ts: 0,
            shared_with: Vec::new(),
            failed: Vec::new(),
        };
        let encoded = key.encoded();

        assert_eq!(decode_key(&encoded).as_deref(), Some(&key.key[..]));
        assert_eq!(
            decode_key(encoded.trim_end_matches('=')).as_deref(),
            Some(&key.key[..])
        );
        assert_eq!(decode_key(""), None);
    }

    #[test]
    fn test_missing_key_session_uses_the_legacy_room_call() {
        let content =
            serde_json::from_value::<ToDeviceCallEncryptionKeysEventContent>(serde_json::json!({
                "keys": { "index": 0, "key": "CQkJCQkJCQkJCQkJCQkJCQ==" },
                "room_id": "!room:example.org",
                "member": { "claimed_device_id": "DEVICE" },
                "sent_ts": 0
            }));

        assert!(content.is_ok_and(|content| content.session.is_legacy_room_call()));
    }

    #[test]
    fn test_the_updated_format_without_sent_ts_or_session_is_accepted() {
        let content =
            serde_json::from_value::<ToDeviceCallEncryptionKeysEventContent>(serde_json::json!({
                "room_id": "!room:example.org",
                "member_id": "member",
                "media_key": { "index": 4, "key": "CQkJCQkJCQkJCQkJCQkJCQ==" },
                "member": { "claimed_device_id": "DEVICE" }
            }))
            .unwrap();

        assert_eq!(content.key().map(|key| key.index), Some(4));
        assert_eq!(content.member_id(), Some("member"));
        assert_eq!(content.claimed_device_id(), Some("DEVICE"));
        assert!(content.session.is_legacy_room_call());
        assert_eq!(content.sent_ts, None);
    }

    #[test]
    fn test_the_specified_format_without_a_member_object_is_accepted() {
        let content =
            serde_json::from_value::<ToDeviceCallEncryptionKeysEventContent>(serde_json::json!({
                "room_id": "!room:example.org",
                "member_id": "member",
                "media_key": { "index": 255, "key": "CQkJCQkJCQkJCQkJCQkJCQ" }
            }))
            .unwrap();

        assert_eq!(content.key().map(|key| key.index), Some(255));
        assert_eq!(content.member_id(), Some("member"));
        assert_eq!(content.claimed_device_id(), None);
    }

    #[test]
    fn accepts_legacy_and_current_key_lengths() {
        use base64::Engine as _;
        use base64::engine::general_purpose::STANDARD_NO_PAD;

        let current = OutboundKey::generate(0, 0).unwrap();
        assert_eq!(
            decode_key(&current.encoded()).map(|key| key.len()),
            Some(32)
        );
        assert_eq!(
            decode_key(&STANDARD_NO_PAD.encode([5u8; 16])).map(|key| key.len()),
            Some(16)
        );
        assert_eq!(decode_key(&STANDARD_NO_PAD.encode([5u8; 15])), None);
    }

    #[test]
    fn stable_livekit_requires_at_least_32_bytes() {
        use super::super::membership::RtcWire;
        use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};

        for length in [16, 31, 32, 64] {
            let encoded = STANDARD_NO_PAD.encode(vec![5; length]);
            assert_eq!(
                super::decode_key_for_wire(&encoded, RtcWire::Stable).is_some(),
                length >= 32,
            );
            assert!(super::decode_key_for_wire(&encoded, RtcWire::Deployed).is_some());
        }
    }

    #[test]
    fn test_the_deprecated_format_still_resolves_the_key_and_member() {
        let content =
            serde_json::from_value::<ToDeviceCallEncryptionKeysEventContent>(serde_json::json!({
                "keys": { "index": 2, "key": "CQkJCQkJCQkJCQkJCQkJCQ==" },
                "room_id": "!room:example.org",
                "member": { "claimed_device_id": "DEVICE", "id": "old" },
                "sent_ts": 5
            }))
            .unwrap();

        assert_eq!(content.key().map(|key| key.index), Some(2));
        assert_eq!(content.member_id(), Some("old"));
    }

    #[test]
    fn test_a_sent_key_carries_both_formats_for_older_receivers() {
        let distributor = KeyDistributor::new(
            owned_room_id!("!room:example.org"),
            owned_user_id!("@kris:localhost"),
            "LAPTOP".into(),
            "member".to_owned(),
            "@kris:localhost:LAPTOP".to_owned(),
        );
        let key = OutboundKey::generate(6, 0).unwrap();

        let content = serde_json::to_value(distributor.key_event(&key)).unwrap();

        assert_eq!(content["media_key"], content["keys"]);
        assert_eq!(content["media_key"]["index"], 6);
        assert_eq!(content["member_id"], "member");
        assert_eq!(content["member"]["id"], "member");
        assert!(!content["media_key"]["key"].as_str().unwrap().ends_with('='));
        assert_eq!(content["member"]["claimed_device_id"], "LAPTOP");
        assert!(content["sent_ts"].is_u64());
    }

    #[test]
    fn test_the_updated_key_wins_over_the_deprecated_one() {
        let content =
            serde_json::from_value::<ToDeviceCallEncryptionKeysEventContent>(serde_json::json!({
                "media_key": { "index": 3, "key": "CQkJCQkJCQkJCQkJCQkJCQ==" },
                "keys": { "index": 1, "key": "CQkJCQkJCQkJCQkJCQkJCQ==" },
                "room_id": "!room:example.org",
                "member_id": "new",
                "member": { "claimed_device_id": "DEVICE", "id": "old" }
            }))
            .unwrap();

        assert_eq!(content.key().map(|key| key.index), Some(3));
        assert_eq!(content.member_id(), Some("new"));
    }

    #[test]
    fn test_only_the_legacy_room_call_session_is_accepted() {
        assert!(SessionRef::default().is_legacy_room_call());
        assert!(
            !SessionRef {
                application: "m.other".to_owned(),
                ..SessionRef::default()
            }
            .is_legacy_room_call()
        );
        assert!(
            !SessionRef {
                scope: "m.space".to_owned(),
                ..SessionRef::default()
            }
            .is_legacy_room_call()
        );
        assert!(
            !SessionRef {
                call_id: "call".to_owned(),
                ..SessionRef::default()
            }
            .is_legacy_room_call()
        );
    }

    #[test]
    fn test_a_rotation_waits_until_the_previous_key_is_in_use() {
        let key = OutboundKey::generate(0, 1_000).unwrap();

        assert_eq!(rotation_wait_ms(None, 1_000, 5_000), None);
        assert_eq!(rotation_wait_ms(Some(&key), 1_000, 5_000), Some(5_000));
        assert_eq!(rotation_wait_ms(Some(&key), 3_000, 5_000), Some(3_000));
        assert_eq!(rotation_wait_ms(Some(&key), 6_000, 5_000), None);
        assert_eq!(rotation_wait_ms(Some(&key), 500, 5_000), Some(5_000));
    }
}

#[cfg(all(test, not(target_family = "wasm")))]
#[expect(clippy::unwrap_used, reason = "test code")]
mod sdk_tests {
    use matrix_sdk::ruma::{device_id, owned_room_id, owned_user_id, room_id, user_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;
    use wiremock::matchers::{method, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    use super::super::membership::CallMember;
    use super::{KeyDistributor, OutboundKey, RESHARE_INTERVAL_MS, Rolled, now_ms};

    fn member(user_id: &str, device_id: &str) -> CallMember {
        CallMember {
            user_id: user_id.try_into().unwrap(),
            device_id: Some(device_id.into()),
            member_id: None,
            identity: format!("{user_id}:{device_id}"),
            mode: crate::protocol::CallMode::Legacy,
            created_ts: 100,
            joined_ts: 100,
            expires_at_ms: None,
            foci: Vec::new(),
            screen_sharing: false,
            wire: super::super::membership::RtcWire::Deployed,
            focus_servers: std::collections::HashMap::default(),
        }
    }

    #[tokio::test]
    async fn a_media_key_reaches_a_device_the_store_has_not_seen() {
        let server = MatrixMockServer::new().await;
        server.mock_crypto_endpoints_preset().await;
        let alice = server
            .client_builder_for_crypto_end_to_end(
                user_id!("@alice:example.org"),
                device_id!("ALICE"),
            )
            .build()
            .await;
        let bob = server
            .client_builder_for_crypto_end_to_end(user_id!("@bob:example.org"), device_id!("BOB"))
            .build()
            .await;
        server.mock_sync().ok_and_run(&bob, |_| {}).await;
        let room = server
            .sync_joined_room(&alice, room_id!("!call:example.org"))
            .await;
        assert!(
            alice
                .encryption()
                .get_device(user_id!("@bob:example.org"), device_id!("BOB"))
                .await
                .unwrap()
                .is_none()
        );
        Mock::given(method("PUT"))
            .and(path_regex(r"/sendToDevice/m\.room\.encrypted/"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(std::time::Duration::from_millis(300))
                    .set_body_json(json!({})),
            )
            .expect(2)
            .mount(server.server())
            .await;

        let mut distributor = KeyDistributor::new(
            owned_room_id!("!call:example.org"),
            owned_user_id!("@alice:example.org"),
            "ALICE".into(),
            "@alice:example.org:ALICE".to_owned(),
            "@alice:example.org:ALICE".to_owned(),
        );
        let key = OutboundKey::generate(0, 100).unwrap();
        let bob_member = member("@bob:example.org", "BOB");
        let reached = distributor
            .send(&room, &key, std::slice::from_ref(&bob_member))
            .await;

        assert_eq!(reached, vec![bob_member]);
        let start = now_ms();
        assert!(matches!(
            distributor.roll(&room, &reached).await,
            Rolled::Rotated { .. }
        ));
        assert!(distributor.outbound.as_ref().unwrap().created_ts >= start + 250);
    }

    #[tokio::test]
    async fn a_leave_right_after_a_rotation_is_rotated_once_the_key_is_in_use() {
        let server = MatrixMockServer::new().await;
        let alice = server
            .client_builder_for_crypto_end_to_end(
                user_id!("@alice:example.org"),
                device_id!("ALICE"),
            )
            .build()
            .await;
        let room = server
            .sync_joined_room(&alice, room_id!("!call:example.org"))
            .await;
        let me = member("@alice:example.org", "ALICE");
        let leaver = member("@bob:example.org", "BOB");
        let mut distributor = KeyDistributor::new(
            owned_room_id!("!call:example.org"),
            owned_user_id!("@alice:example.org"),
            "ALICE".into(),
            me.identity.clone(),
            me.identity.clone(),
        );
        distributor.outbound = Some(OutboundKey {
            shared_with: vec![me.clone(), leaver],
            ..OutboundKey::generate(4, now_ms()).unwrap()
        });

        let rolled = distributor.roll(&room, std::slice::from_ref(&me)).await;

        assert!(matches!(rolled, Rolled::Deferred { wait_ms } if wait_ms > 0));
        assert_eq!(distributor.outbound.as_ref().unwrap().index, 4);

        distributor.outbound.as_mut().unwrap().created_ts = 0;
        let rolled = distributor.roll(&room, std::slice::from_ref(&me)).await;

        assert!(matches!(
            rolled,
            Rolled::Rotated { announcement, first: false } if announcement.index == 5
        ));
    }

    #[tokio::test]
    async fn an_unchanged_roster_is_sent_the_key_again_once_in_a_while() {
        let server = MatrixMockServer::new().await;
        let alice = server
            .client_builder_for_crypto_end_to_end(
                user_id!("@alice:example.org"),
                device_id!("ALICE"),
            )
            .build()
            .await;
        let room = server
            .sync_joined_room(&alice, room_id!("!call:example.org"))
            .await;
        let me = member("@alice:example.org", "ALICE");
        let mut distributor = KeyDistributor::new(
            owned_room_id!("!call:example.org"),
            owned_user_id!("@alice:example.org"),
            "ALICE".into(),
            me.identity.clone(),
            me.identity.clone(),
        );
        distributor.outbound = Some(OutboundKey {
            shared_with: vec![me.clone()],
            ..OutboundKey::generate(2, now_ms()).unwrap()
        });
        distributor.last_sent_ms = now_ms();

        let rolled = distributor.roll(&room, std::slice::from_ref(&me)).await;
        assert!(matches!(rolled, Rolled::Nothing));

        distributor.last_sent_ms = now_ms() - RESHARE_INTERVAL_MS;
        let rolled = distributor.roll(&room, std::slice::from_ref(&me)).await;
        assert!(matches!(rolled, Rolled::Reshared));
        assert_eq!(distributor.outbound.as_ref().unwrap().shared_with.len(), 1);

        let rolled = distributor.roll(&room, std::slice::from_ref(&me)).await;
        assert!(matches!(rolled, Rolled::Nothing));
    }
}
