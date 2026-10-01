use matrix_sdk::ruma::events::{
    StateEventType,
    room::power_levels::{RoomPowerLevels, RoomPowerLevelsEventContent},
};
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId, RoomId, RoomVersionId, ServerName, UserId};
use matrix_sdk_base::deserialized_responses::RawAnySyncOrStrippedState;
use serde::Deserialize;
use serde_json::Value;

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
                for raw in room.get_state_events(kind).await.unwrap_or_default() {
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

fn legitimate(state: &[Value], child: &RoomId, sender: &UserId) -> bool {
    let Some(create) = state
        .iter()
        .find(|event| event["type"] == "m.room.create" && event["state_key"] == "")
    else {
        return false;
    };
    if create.pointer("/content/type").and_then(Value::as_str) != Some("m.space") {
        return false;
    }
    if state.iter().any(|event| {
        event["type"] == "m.space.child"
            && event["state_key"] == child.as_str()
            && event
                .pointer("/content/via")
                .and_then(Value::as_array)
                .is_some_and(|via| {
                    !via.is_empty()
                        && via.iter().all(|server| {
                            server
                                .as_str()
                                .is_some_and(|server| ServerName::parse(server).is_ok())
                        })
                })
    }) {
        return true;
    }
    if !state.iter().any(|event| {
        event["type"] == "m.room.member"
            && event["state_key"] == sender.as_str()
            && event.pointer("/content/membership").and_then(Value::as_str) == Some("join")
    }) {
        return false;
    }
    let Ok(version) = RoomVersionId::try_from(
        create
            .pointer("/content/room_version")
            .and_then(Value::as_str)
            .unwrap_or("1"),
    ) else {
        return false;
    };
    let Some(rules) = version.rules() else {
        return false;
    };
    let mut creators = create
        .pointer("/content/creator")
        .and_then(Value::as_str)
        .or_else(|| create["sender"].as_str())
        .and_then(|id| UserId::parse(id).ok())
        .into_iter()
        .collect::<Vec<_>>();
    creators.extend(
        create
            .pointer("/content/additional_creators")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|id| id.as_str().and_then(|id| UserId::parse(id).ok())),
    );
    let levels = match state
        .iter()
        .find(|event| event["type"] == "m.room.power_levels" && event["state_key"] == "")
    {
        Some(event) => {
            match serde_json::from_value::<RoomPowerLevelsEventContent>(event["content"].clone()) {
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
}
