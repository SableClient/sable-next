use matrix_sdk::ruma::events::{
    StateEventType,
    room::power_levels::{RoomPowerLevels, RoomPowerLevelsEventContent},
};
use matrix_sdk::ruma::{
    OwnedRoomId, OwnedServerName, OwnedUserId, RoomId, RoomVersionId, ServerName, UserId,
};
use matrix_sdk_base::deserialized_responses::RawAnySyncOrStrippedState;
use serde::Deserialize;
use serde_json::Value;
use serde_with::{DefaultOnError, VecSkipError, serde_as};

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ParentClaim {
    #[serde(rename = "type", default)]
    pub event_type: String,
    pub state_key: String,
    #[serde(default)]
    pub sender: Option<OwnedUserId>,
    #[serde(default)]
    pub content: ParentContent,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct ParentContent {
    #[serde(default)]
    pub canonical: bool,
    #[serde(default)]
    pub via: Vec<String>,
}

impl ParentClaim {
    pub(crate) fn room_id(&self) -> Option<OwnedRoomId> {
        if self.sender.is_none()
            || self.content.via.is_empty()
            || self
                .content
                .via
                .iter()
                .any(|via| ServerName::parse(via).is_err())
        {
            return None;
        }
        RoomId::parse(&self.state_key).ok()
    }
}

pub(crate) async fn validate(
    core: &crate::Core,
    client: &matrix_sdk::Client,
    child: &RoomId,
    claims: &[ParentClaim],
    network: bool,
) -> Vec<ParentClaim> {
    let mut accepted = Vec::new();
    for claim in claims {
        let Some(parent) = claim.room_id().filter(|parent| parent != child) else {
            continue;
        };
        let Some(sender) = claim.sender.as_deref() else {
            continue;
        };
        let mut state = Vec::new();
        if let Some(room) = client.get_room(&parent) {
            for kind in [
                StateEventType::RoomCreate,
                StateEventType::RoomMember,
                StateEventType::RoomPowerLevels,
                StateEventType::SpaceChild,
            ] {
                for raw in core
                    .with_open_stores(async || room.get_state_events(kind).await)
                    .await
                    .unwrap_or_default()
                {
                    let raw = match raw {
                        RawAnySyncOrStrippedState::Sync(raw) => raw.json().to_owned(),
                        RawAnySyncOrStrippedState::Stripped(raw) => raw.json().to_owned(),
                    };
                    if let Ok(value) = serde_json::from_str(raw.get()) {
                        state.push(value);
                    }
                }
            }
        }
        let mut valid = legitimate(&state, child, sender);
        if !valid && network {
            use matrix_sdk::{config::RequestConfig, ruma::api::client::state::get_state_events};
            if let Ok(response) = client
                .send(get_state_events::v3::Request::new(parent))
                .with_request_config(
                    RequestConfig::new()
                        .timeout(std::time::Duration::from_secs(15))
                        .disable_retry(),
                )
                .await
            {
                let state = response
                    .room_state
                    .iter()
                    .filter_map(|raw| raw.deserialize_as_unchecked::<Value>().ok())
                    .collect::<Vec<_>>();
                valid = legitimate(&state, child, sender);
            }
        }
        if valid {
            accepted.push(claim.clone());
        }
    }
    accepted.sort_by(|left, right| {
        right
            .content
            .canonical
            .cmp(&left.content.canonical)
            .then_with(|| left.state_key.cmp(&right.state_key))
    });
    accepted.dedup_by(|left, right| left.state_key == right.state_key);
    accepted
}

#[serde_as]
#[derive(Deserialize)]
struct StateEventIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    state_key: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    sender: Option<String>,
    #[serde(default)]
    content: Value,
}

#[serde_as]
#[derive(Default, Deserialize)]
struct CreateContentIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    room_version: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    creator: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    additional_creators: Vec<String>,
}

#[serde_as]
#[derive(Default, Deserialize)]
struct ChildContentIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    via: Option<Vec<OwnedServerName>>,
}

#[serde_as]
#[derive(Default, Deserialize)]
struct MemberContentIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    membership: Option<String>,
}

fn content_of<T: Default + serde::de::DeserializeOwned>(event: &StateEventIn) -> T {
    T::deserialize(&event.content).unwrap_or_default()
}

fn legitimate(state: &[Value], child: &RoomId, sender: &UserId) -> bool {
    let state: Vec<StateEventIn> = state
        .iter()
        .filter_map(|event| StateEventIn::deserialize(event).ok())
        .collect();
    let Some(create) = state.iter().find(|event| {
        event.kind.as_deref() == Some("m.room.create") && event.state_key.as_deref() == Some("")
    }) else {
        return false;
    };
    let create_content: CreateContentIn = content_of(create);
    if create_content.kind.as_deref() != Some("m.space") {
        return false;
    }
    if state.iter().any(|event| {
        event.kind.as_deref() == Some("m.space.child")
            && event.state_key.as_deref() == Some(child.as_str())
            && content_of::<ChildContentIn>(event)
                .via
                .is_some_and(|via| !via.is_empty())
    }) {
        return true;
    }
    if !state.iter().any(|event| {
        event.kind.as_deref() == Some("m.room.member")
            && event.state_key.as_deref() == Some(sender.as_str())
            && content_of::<MemberContentIn>(event).membership.as_deref() == Some("join")
    }) {
        return false;
    }
    let Ok(version) =
        RoomVersionId::try_from(create_content.room_version.as_deref().unwrap_or("1"))
    else {
        return false;
    };
    let Some(rules) = version.rules() else {
        return false;
    };
    let mut creators = create_content
        .creator
        .as_deref()
        .or(create.sender.as_deref())
        .and_then(|id| UserId::parse(id).ok())
        .into_iter()
        .collect::<Vec<_>>();
    creators.extend(
        create_content
            .additional_creators
            .iter()
            .filter_map(|id| UserId::parse(id).ok()),
    );
    let levels = match state.iter().find(|event| {
        event.kind.as_deref() == Some("m.room.power_levels")
            && event.state_key.as_deref() == Some("")
    }) {
        Some(event) => {
            match serde_json::from_value::<RoomPowerLevelsEventContent>(event.content.clone()) {
                Ok(content) => Some(content),
                Err(_) => return false,
            }
        }
        None => None,
    };
    RoomPowerLevels::new(levels.into(), &rules.authorization, creators)
        .user_can_send_state(sender, StateEventType::SpaceChild)
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{room_id, user_id};
    use serde_json::json;

    #[test]
    fn a_parent_requires_an_active_reciprocal_edge_or_an_authorized_sender() {
        let child = room_id!("!child:example.org");
        let sender = user_id!("@alice:example.org");
        let mut state = vec![
            json!({"type": "m.room.create", "state_key": "", "sender": "@owner:example.org", "content": {"type": "m.space"}}),
            json!({"type": "m.space.child", "state_key": child, "content": {"via": ["example.org"]}}),
        ];
        assert!(super::legitimate(&state, child, sender));
        state[1]["content"] = json!({"via": []});
        assert!(!super::legitimate(&state, child, sender));
        state.push(json!({"type": "m.room.member", "state_key": sender, "content": {"membership": "join"}}));
        state.push(json!({"type": "m.room.power_levels", "state_key": "", "content": {"users": {sender: 50}, "events": {"m.space.child": 50}}}));
        assert!(super::legitimate(&state, child, sender));
        state[3]["content"]["users"][sender.as_str()] = json!(49);
        assert!(!super::legitimate(&state, child, sender));
    }

    #[test]
    fn room_v12_creator_can_claim_a_parent_without_a_child_event() {
        let child = room_id!("!TSu72vOzgRWPPXopf7dUlfzwXvrBCKMGerwFTWkXtpA");
        let sender = user_id!("@seven:sable.moe");
        let mut state = vec![
            json!({"type": "m.room.create", "state_key": "", "sender": sender, "content": {"type": "m.space", "room_version": "12", "additional_creators": ["@7w1:matrix.org"]}}),
            json!({"type": "m.room.member", "state_key": sender, "content": {"membership": "join"}}),
            json!({"type": "m.room.power_levels", "state_key": "", "content": {"state_default": 50, "users": {}}}),
        ];
        assert!(super::legitimate(&state, child, sender));
        state[1]["content"]["membership"] = json!("leave");
        assert!(!super::legitimate(&state, child, sender));
    }
}
