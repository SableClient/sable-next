use matrix_sdk::Room;
use matrix_sdk::ruma::events::call::member::{CallMemberEventContent, Focus};
use matrix_sdk::ruma::{DeviceId, OwnedDeviceId, OwnedUserId, UserId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CallMember {
    pub(crate) user_id: OwnedUserId,
    pub(crate) device_id: OwnedDeviceId,
    pub(crate) created_ts: u64,
    pub(crate) foci: Vec<String>,
}

impl CallMember {
    pub(crate) fn is_own(&self, user_id: &UserId, device_id: &DeviceId) -> bool {
        self.user_id == user_id && self.device_id == device_id
    }

    pub(crate) fn same_generation(&self, other: &Self) -> bool {
        self.user_id == other.user_id
            && self.device_id == other.device_id
            && self.created_ts == other.created_ts
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
        let Ok(event) = raw.deserialize() else {
            continue;
        };
        let Some(event) = event.as_sync().and_then(|sync| sync.as_original()) else {
            continue;
        };

        let origin_server_ts = event.origin_server_ts;
        for membership in event.content.active_memberships(Some(origin_server_ts)) {
            members.push(CallMember {
                user_id: event.state_key.user_id().to_owned(),
                device_id: membership.device_id().to_owned(),
                created_ts: membership
                    .created_ts()
                    .unwrap_or(origin_server_ts)
                    .get()
                    .into(),
                foci: livekit_urls(membership.foci_preferred()),
            });
        }
    }
    members
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

    use super::{CallMember, advertised_service_urls};

    fn member(device: &str, created_ts: u64, foci: &[&str]) -> CallMember {
        CallMember {
            user_id: owned_user_id!("@erwan:localhost"),
            device_id: device.into(),
            created_ts,
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
}
