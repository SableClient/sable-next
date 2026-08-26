use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use matrix_sdk::Room;
use matrix_sdk::ruma::events::macros::EventContent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{MilliSecondsSinceUnixEpoch, OwnedDeviceId, OwnedRoomId, OwnedUserId};
use matrix_sdk_base::crypto::CollectStrategy;
use serde::{Deserialize, Serialize};

use super::membership::CallMember;

pub(crate) const KEY_BYTES: usize = 16;
pub(crate) const ROTATION_GRACE_MS: u64 = 10_000;

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

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "io.element.call.encryption_keys", kind = ToDevice)]
pub(crate) struct ToDeviceCallEncryptionKeysEventContent {
    pub(crate) keys: KeyPayload,
    pub(crate) room_id: OwnedRoomId,
    pub(crate) member: MemberRef,
    #[serde(default)]
    pub(crate) session: SessionRef,
    pub(crate) sent_ts: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OutboundKey {
    pub(crate) key: [u8; KEY_BYTES],
    pub(crate) index: u8,
    pub(crate) created_ts: u64,
    pub(crate) shared_with: Vec<CallMember>,
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
        })
    }

    pub(crate) const fn next_index(current: Option<&Self>) -> u8 {
        match current {
            Some(key) => key.index.wrapping_add(1),
            None => 0,
        }
    }

    pub(crate) fn encoded(&self) -> String {
        STANDARD.encode(self.key)
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
    if anyone_left {
        return Rollout::Rotate {
            targets: members.to_vec(),
        };
    }

    let joined: Vec<CallMember> = members
        .iter()
        .filter(|member| {
            !still_valid
                .iter()
                .any(|shared| shared.same_generation(member))
        })
        .cloned()
        .collect();

    if joined.is_empty() {
        return Rollout::Unchanged;
    }

    if now_ms.saturating_sub(current.created_ts) < grace_ms {
        Rollout::Share { targets: joined }
    } else {
        Rollout::Rotate {
            targets: members.to_vec(),
        }
    }
}

fn rejoined(shared: &CallMember, members: &[CallMember]) -> bool {
    members.iter().any(|member| {
        member.user_id == shared.user_id
            && member.device_id == shared.device_id
            && member.created_ts != shared.created_ts
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
    Rotated {
        announcement: Announcement,
        first: bool,
    },
}

pub(crate) struct KeyDistributor {
    room_id: OwnedRoomId,
    user_id: OwnedUserId,
    device_id: OwnedDeviceId,
    outbound: Option<OutboundKey>,
}

impl KeyDistributor {
    pub(crate) const fn new(
        room_id: OwnedRoomId,
        user_id: OwnedUserId,
        device_id: OwnedDeviceId,
    ) -> Self {
        Self {
            room_id,
            user_id,
            device_id,
            outbound: None,
        }
    }

    pub(crate) async fn roll(&mut self, room: &Room, members: &[CallMember]) -> Rolled {
        match plan_rollout(self.outbound.as_ref(), members, now_ms(), ROTATION_GRACE_MS) {
            Rollout::Unchanged => Rolled::Nothing,
            Rollout::Share { targets } => {
                let Some(key) = self.outbound.clone() else {
                    return Rolled::Nothing;
                };
                let reached = self.send(room, &key, &targets).await;
                if let Some(outbound) = self.outbound.as_mut() {
                    outbound.shared_with.extend(reached);
                }
                Rolled::Shared
            }
            Rollout::Rotate { targets } => {
                let first = self.outbound.is_none();
                let index = OutboundKey::next_index(self.outbound.as_ref());
                let Ok(key) = OutboundKey::generate(index, now_ms()) else {
                    tracing::error!("no entropy available for a call encryption key");
                    return Rolled::Nothing;
                };

                let reached = self.send(room, &key, &targets).await;

                let announcement = Announcement {
                    identity: super::sfu::livekit_identity(&self.user_id, &self.device_id),
                    index: key.index,
                    encoded: key.encoded(),
                };
                self.outbound = Some(OutboundKey {
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

    async fn send(
        &self,
        room: &Room,
        key: &OutboundKey,
        targets: &[CallMember],
    ) -> Vec<CallMember> {
        let encryption = room.client().encryption();
        let mut devices = Vec::new();
        let mut reached = Vec::new();
        for target in targets {
            if target.is_own(&self.user_id, &self.device_id) {
                reached.push(target.clone());
                continue;
            }
            match encryption
                .get_device(&target.user_id, &target.device_id)
                .await
            {
                Ok(Some(device)) => {
                    devices.push(device);
                    reached.push(target.clone());
                }
                Ok(None) => tracing::debug!(
                    user_id = %target.user_id,
                    device_id = %target.device_id,
                    "call member device is unknown, cannot send it a media key"
                ),
                Err(error) => tracing::warn!(?error, "could not look up a call member device"),
            }
        }

        if devices.is_empty() {
            return reached;
        }

        let content = ToDeviceCallEncryptionKeysEventContent {
            keys: KeyPayload {
                index: key.index,
                key: key.encoded(),
            },
            room_id: self.room_id.clone(),
            member: MemberRef {
                claimed_device_id: self.device_id.to_string(),
                id: Some(super::sfu::livekit_identity(&self.user_id, &self.device_id)),
            },
            session: SessionRef::default(),
            sent_ts: now_ms(),
        };

        let Ok(raw) = Raw::new(&content) else {
            tracing::error!("could not serialize a call media key");
            return Vec::new();
        };

        match encryption
            .encrypt_and_send_raw_to_device(
                devices.iter().collect(),
                "io.element.call.encryption_keys",
                raw.cast_unchecked(),
                CollectStrategy::AllDevices,
            )
            .await
        {
            Ok(failures) if failures.is_empty() => reached,
            Ok(failures) => {
                tracing::warn!(
                    count = failures.len(),
                    "some call members did not receive the media key"
                );
                reached.retain(|member| {
                    !failures.iter().any(|(user_id, device_id)| {
                        *user_id == member.user_id && *device_id == member.device_id
                    })
                });
                reached
            }
            Err(error) => {
                tracing::warn!(?error, "could not send the call media key");
                reached.retain(|member| member.is_own(&self.user_id, &self.device_id));
                reached
            }
        }
    }
}

pub(crate) fn decode_key(encoded: &str) -> Option<Vec<u8>> {
    STANDARD
        .decode(encoded)
        .or_else(|_| STANDARD_NO_PAD.decode(encoded))
        .ok()
        .filter(|key| key.len() == KEY_BYTES)
}

pub(crate) fn now_ms() -> u64 {
    MilliSecondsSinceUnixEpoch::now().get().into()
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::owned_user_id;

    use super::super::membership::CallMember;
    use super::{KEY_BYTES, OutboundKey, Rollout, decode_key, plan_rollout};

    fn member(device: &str, created_ts: u64) -> CallMember {
        CallMember {
            user_id: owned_user_id!("@erwan:localhost"),
            device_id: device.into(),
            created_ts,
            foci: Vec::new(),
        }
    }

    fn key_shared_with(members: &[CallMember], created_ts: u64) -> OutboundKey {
        OutboundKey {
            key: [7u8; KEY_BYTES],
            index: 3,
            created_ts,
            shared_with: members.to_vec(),
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
    fn test_the_index_wraps_rather_than_overflowing() {
        let last = OutboundKey {
            key: [0u8; KEY_BYTES],
            index: u8::MAX,
            created_ts: 0,
            shared_with: Vec::new(),
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
        };
        let encoded = key.encoded();

        assert_eq!(decode_key(&encoded).as_deref(), Some(&key.key[..]));
        assert_eq!(
            decode_key(encoded.trim_end_matches('=')).as_deref(),
            Some(&key.key[..])
        );
        assert_eq!(decode_key(""), None);
    }
}
