use std::collections::HashSet;

use matrix_sdk::ruma::api::FeatureFlag;
use matrix_sdk::ruma::api::client::state::get_state_event_for_key;
use matrix_sdk::ruma::events::{GlobalAccountDataEventType, StateEventType};
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId, RoomId};
use matrix_sdk::{Room, RoomMemberships, RoomState};
use serde_json::{Map, Value, json};

use crate::SignedIn;
use crate::protocol::{
    PresenceHintView, PresencePromptView, PresenceSharingEdit, PresenceSharingView,
    PresenceUserSharingView, RpcError,
};

const FEATURE: &str = "org.continuwuity.presence_v2.msc4495";
const STABLE_FEATURE: &str = "org.continuwuity.presence_v2.msc4495.stable";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Keys {
    pub(crate) sharing: &'static str,
    pub(crate) prompted: &'static str,
    pub(crate) hint: &'static str,
}

const STABLE: Keys = Keys {
    sharing: "m.presence.sharing",
    prompted: "m.presence.prompted",
    hint: "m.room.presence_sharing",
};

const UNSTABLE: Keys = Keys {
    sharing: "org.continuwuity.presence_v2.msc4495.presence.sharing",
    prompted: "org.continuwuity.presence_v2.msc4495.presence.prompted",
    hint: "org.continuwuity.presence_v2.msc4495.room.presence_sharing",
};

const MAX_PREDECESSORS: usize = 16;

fn keys_for(features: &[&str]) -> Option<Keys> {
    if features.contains(&STABLE_FEATURE) {
        Some(STABLE)
    } else if features.contains(&FEATURE) {
        Some(UNSTABLE)
    } else {
        None
    }
}

fn object(content: Option<&Value>, field: &str) -> Map<String, Value> {
    content
        .and_then(|content| content.get(field)?.as_object().cloned())
        .unwrap_or_default()
}

fn ids_with(map: &Map<String, Value>, value: &str) -> Vec<String> {
    map.iter()
        .filter(|(_, state)| state.as_str() == Some(value))
        .map(|(id, _)| id.clone())
        .collect()
}

fn strings(content: Option<&Value>, field: &str) -> Vec<String> {
    content
        .and_then(|content| content.get(field)?.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn sharing_view(
    keys: Keys,
    sharing: Option<&Value>,
    prompted: Option<&Value>,
) -> PresenceSharingView {
    let users = object(sharing, "users");
    PresenceSharingView {
        hint_event_type: keys.hint.to_owned(),
        configured: sharing.is_some_and(Value::is_object),
        share_locally: sharing
            .and_then(|content| content.get("share_locally")?.as_bool())
            .unwrap_or(false),
        allowed_users: ids_with(&users, "allow"),
        denied_users: ids_with(&users, "deny"),
        allowed_rooms: ids_with(&object(sharing, "rooms"), "allow"),
        denied_servers: ids_with(&object(sharing, "servers"), "deny"),
        prompted_users: strings(prompted, "users"),
        prompted_rooms: strings(prompted, "rooms"),
    }
}

pub(crate) fn edited_sharing(stored: Option<Value>, edit: &PresenceSharingEdit) -> Option<Value> {
    let configured = stored.as_ref().is_some_and(Value::is_object);
    let mut content = match stored {
        Some(Value::Object(content)) => content,
        _ => Map::new(),
    };
    let changed = match edit {
        PresenceSharingEdit::ShareLocally { enabled } => {
            let previous = content.insert("share_locally".to_owned(), Value::Bool(*enabled));
            previous.and_then(|value| value.as_bool()).unwrap_or(false) != *enabled
        }
        PresenceSharingEdit::User { user_id, sharing } => set_entry(
            &mut content,
            "users",
            user_id.as_str(),
            sharing.map(|sharing| match sharing {
                PresenceUserSharingView::Allow => "allow",
                PresenceUserSharingView::Deny => "deny",
            }),
        ),
        PresenceSharingEdit::Room { room_id, allowed } => set_entry(
            &mut content,
            "rooms",
            room_id.as_str(),
            allowed.then_some("allow"),
        ),
        PresenceSharingEdit::Server { server, denied } => set_entry(
            &mut content,
            "servers",
            server.as_str(),
            denied.then_some("deny"),
        ),
    };
    // A first edit creates the document even when it sets a default, since
    // having one is what opts the account in.
    (changed || !configured).then_some(Value::Object(content))
}

fn set_entry(
    content: &mut Map<String, Value>,
    field: &str,
    key: &str,
    value: Option<&str>,
) -> bool {
    let map = content.entry(field.to_owned()).or_insert_with(|| json!({}));
    if !map.is_object() {
        *map = json!({});
    }
    let Some(map) = map.as_object_mut() else {
        return false;
    };
    match value {
        Some(value) => {
            map.insert(key.to_owned(), Value::from(value))
                .as_ref()
                .and_then(Value::as_str)
                != Some(value)
        }
        None => map.shift_remove(key).is_some(),
    }
}

pub(crate) fn with_prompted(stored: Option<Value>, prompt: &PresencePromptView) -> Option<Value> {
    let mut content = match stored {
        Some(Value::Object(content)) => content,
        _ => Map::new(),
    };
    let (field, id) = match prompt {
        PresencePromptView::User { user_id } => ("users", user_id.as_str()),
        PresencePromptView::Room { room_id } => ("rooms", room_id.as_str()),
    };
    let list = content.entry(field.to_owned()).or_insert_with(|| json!([]));
    if !list.is_array() {
        *list = json!([]);
    }
    let list = list.as_array_mut()?;
    if list.iter().any(|entry| entry.as_str() == Some(id)) {
        return None;
    }
    list.push(Value::from(id));
    Some(Value::Object(content))
}

pub(crate) fn hint(content: Option<&Value>) -> PresenceHintView {
    match content.and_then(|content| content.get("presence_sharing")?.as_str()) {
        Some("suggest") => PresenceHintView::Suggest,
        _ => PresenceHintView::Forbid,
    }
}

pub(crate) fn hint_content(hint: PresenceHintView) -> Value {
    json!({
        "presence_sharing": match hint {
            PresenceHintView::Suggest => "suggest",
            PresenceHintView::Forbid => "forbid",
        }
    })
}

pub(crate) fn answered(
    view: &PresenceSharingView,
    prompt: &PresencePromptView,
    predecessors: &[OwnedRoomId],
) -> bool {
    match prompt {
        PresencePromptView::User { user_id } => {
            let id = user_id.as_str();
            [
                &view.prompted_users,
                &view.allowed_users,
                &view.denied_users,
            ]
            .iter()
            .any(|list| list.iter().any(|entry| entry == id))
        }
        PresencePromptView::Room { room_id } => {
            std::iter::once(room_id).chain(predecessors).any(|room| {
                let id = room.as_str();
                [&view.prompted_rooms, &view.allowed_rooms]
                    .iter()
                    .any(|list| list.iter().any(|entry| entry == id))
            })
        }
    }
}

pub(crate) fn carried_sharing(
    stored: Option<Value>,
    old: &RoomId,
    new: &OwnedRoomId,
) -> Option<Value> {
    let allowed = object(stored.as_ref(), "rooms")
        .get(old.as_str())
        .and_then(Value::as_str)
        == Some("allow");
    if !allowed {
        return None;
    }
    edited_sharing(
        stored,
        &PresenceSharingEdit::Room {
            room_id: new.clone(),
            allowed: true,
        },
    )
}

pub(crate) fn carried_prompted(
    stored: Option<Value>,
    old: &RoomId,
    new: &OwnedRoomId,
) -> Option<Value> {
    strings(stored.as_ref(), "rooms")
        .iter()
        .any(|room| room == old.as_str())
        .then(|| {
            with_prompted(
                stored,
                &PresencePromptView::Room {
                    room_id: new.clone(),
                },
            )
        })
        .flatten()
}

impl SignedIn {
    pub(crate) async fn presence_keys(&self) -> Option<Keys> {
        let client = self.client();
        let features = client.unstable_features().await.ok()?;
        let advertised: Vec<&str> = [STABLE_FEATURE, FEATURE]
            .into_iter()
            .filter(|flag| features.contains(&FeatureFlag::from(*flag)))
            .collect();
        keys_for(&advertised)
    }

    async fn presence_keys_or_unsupported(&self, label: &str) -> Result<Keys, RpcError> {
        self.presence_keys().await.ok_or_else(|| {
            self.core()
                .failed(label, "the homeserver does not support selective presence")
        })
    }

    /// A server that moved to the stable identifiers may still hold the unstable key.
    async fn sharing_document(
        &self,
        keys: Keys,
        kind: Document,
        label: &str,
    ) -> Result<Option<Value>, RpcError> {
        for key in kind.candidates(keys) {
            let content = self
                .global_account_data(GlobalAccountDataEventType::from(key), label)
                .await?
                .and_then(|raw| raw.deserialize_as::<Value>().ok());
            if content.is_some() {
                return Ok(content);
            }
        }
        Ok(None)
    }

    pub(crate) async fn presence_sharing(&self) -> Result<Option<PresenceSharingView>, RpcError> {
        let Some(keys) = self.presence_keys().await else {
            return Ok(None);
        };
        let sharing = self
            .sharing_document(keys, Document::Sharing, "presence_sharing")
            .await?;
        let prompted = self
            .sharing_document(keys, Document::Prompted, "presence_sharing")
            .await?;
        Ok(Some(sharing_view(
            keys,
            sharing.as_ref(),
            prompted.as_ref(),
        )))
    }

    pub(crate) async fn edit_presence_sharing(
        &self,
        edit: &PresenceSharingEdit,
    ) -> Result<PresenceSharingView, RpcError> {
        let label = "edit_presence_sharing";
        let keys = self.presence_keys_or_unsupported(label).await?;
        let content = self
            .update_account_data(&Document::Sharing.candidates(keys), label, async |stored| {
                Ok(edited_sharing(stored, edit))
            })
            .await?;
        let prompted = self
            .sharing_document(keys, Document::Prompted, label)
            .await?;
        Ok(sharing_view(keys, content.as_ref(), prompted.as_ref()))
    }

    pub(crate) async fn presence_hint(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<PresenceHintView, RpcError> {
        let keys = self.presence_keys().await.unwrap_or(UNSTABLE);
        Ok(hint(self.hint_content(room_id, keys).await?.as_ref()))
    }

    async fn hint_content(
        &self,
        room_id: &OwnedRoomId,
        keys: Keys,
    ) -> Result<Option<Value>, RpcError> {
        for key in Document::Hint.candidates(keys) {
            let content = self
                .room_state_event_content(room_id.clone(), key.to_owned(), String::new())
                .await?;
            if content.is_some() {
                return Ok(content);
            }
        }
        Ok(None)
    }

    pub(crate) async fn set_presence_hint(
        &self,
        room_id: OwnedRoomId,
        hint: PresenceHintView,
    ) -> Result<(), RpcError> {
        let keys = self
            .presence_keys_or_unsupported("set_presence_hint")
            .await?;
        self.send_state(room_id, keys.hint, "", &hint_content(hint))
            .await?;
        Ok(())
    }

    pub(crate) async fn presence_hint_initial_state(
        &self,
        hint: PresenceHintView,
    ) -> Option<ruma::serde::Raw<ruma::events::AnyInitialStateEvent>> {
        let keys = self.presence_keys().await?;
        ruma::serde::Raw::new(&json!({
            "type": keys.hint,
            "state_key": "",
            "content": hint_content(hint),
        }))
        .ok()
        .map(ruma::serde::Raw::cast_unchecked)
    }

    pub(crate) async fn presence_prompt(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<Option<PresencePromptView>, RpcError> {
        let Some(keys) = self.presence_keys().await else {
            return Ok(None);
        };
        let room = self.room(room_id)?;
        if room.state() != RoomState::Joined
            || hint(self.hint_content(room_id, keys).await?.as_ref()) != PresenceHintView::Suggest
        {
            return Ok(None);
        }
        let prompt = one_to_one_partner(&room).await.map_or_else(
            || PresencePromptView::Room {
                room_id: room_id.clone(),
            },
            |user_id| PresencePromptView::User { user_id },
        );
        let sharing = self
            .sharing_document(keys, Document::Sharing, "presence_prompt")
            .await?;
        let prompted = self
            .sharing_document(keys, Document::Prompted, "presence_prompt")
            .await?;
        let view = sharing_view(keys, sharing.as_ref(), prompted.as_ref());
        let predecessors = self.verified_predecessors(&room);
        Ok((!answered(&view, &prompt, &predecessors)).then_some(prompt))
    }

    /// Declining only marks the prompt as seen, it does not write `deny`.
    pub(crate) async fn answer_presence_prompt(
        &self,
        prompt: PresencePromptView,
        share: bool,
    ) -> Result<(), RpcError> {
        let label = "answer_presence_prompt";
        let keys = self.presence_keys_or_unsupported(label).await?;
        if share {
            let edit = match prompt {
                PresencePromptView::User { user_id } => PresenceSharingEdit::User {
                    user_id,
                    sharing: Some(PresenceUserSharingView::Allow),
                },
                PresencePromptView::Room { room_id } => PresenceSharingEdit::Room {
                    room_id,
                    allowed: true,
                },
            };
            self.edit_presence_sharing(&edit).await?;
            return Ok(());
        }
        self.update_account_data(
            &Document::Prompted.candidates(keys),
            label,
            async |stored| Ok(with_prompted(stored, &prompt)),
        )
        .await?;
        Ok(())
    }

    /// A create event can name any room as its predecessor, so the old room's tombstone must point back.
    fn verified_predecessors(&self, room: &Room) -> Vec<OwnedRoomId> {
        let client = self.client();
        let mut chain = Vec::new();
        let mut seen = HashSet::from([room.room_id().to_owned()]);
        let mut current = room.clone();
        while chain.len() < MAX_PREDECESSORS {
            let Some(predecessor) = current.predecessor_room() else {
                break;
            };
            let Some(previous) = client.get_room(&predecessor.room_id) else {
                break;
            };
            let replaces = previous
                .successor_room()
                .is_some_and(|successor| successor.room_id == current.room_id());
            if !replaces || !seen.insert(predecessor.room_id.clone()) {
                break;
            }
            chain.push(predecessor.room_id);
            current = previous;
        }
        chain
    }

    pub(crate) async fn carry_presence_sharing(&self, old: &RoomId, new: &OwnedRoomId) {
        let label = "carry_presence_sharing";
        let Some(keys) = self.presence_keys().await else {
            return;
        };
        let client = self.client();
        let replaced = client
            .get_room(old)
            .and_then(|room| room.successor_room())
            .is_some_and(|successor| &successor.room_id == new);
        if !replaced {
            return;
        }
        if let Err(error) = self
            .update_account_data(&Document::Sharing.candidates(keys), label, async |stored| {
                Ok(carried_sharing(stored, old, new))
            })
            .await
        {
            tracing::warn!(?error, "presence sharing not carried to the upgraded room");
        }
        if let Err(error) = self
            .update_account_data(
                &Document::Prompted.candidates(keys),
                label,
                async |stored| Ok(carried_prompted(stored, old, new)),
            )
            .await
        {
            tracing::warn!(
                ?error,
                "presence prompt answer not carried to the upgraded room"
            );
        }
    }

    pub(crate) async fn follow_presence_upgrade(&self, room_id: &OwnedRoomId) {
        let client = self.client();
        let request = get_state_event_for_key::v3::Request::new(
            room_id.clone(),
            StateEventType::RoomCreate,
            String::new(),
        );
        let predecessor = client
            .send(request)
            .await
            .ok()
            .and_then(|response| {
                serde_json::from_str::<Value>(response.event_or_content.get()).ok()
            })
            .and_then(|content| {
                RoomId::parse(content.get("predecessor")?.get("room_id")?.as_str()?).ok()
            });
        if let Some(old) = predecessor {
            self.carry_presence_sharing(&old, room_id).await;
        }
    }

    pub(crate) async fn copy_presence_hint(&self, old: &OwnedRoomId, new: &OwnedRoomId) {
        let Some(keys) = self.presence_keys().await else {
            return;
        };
        let Ok(Some(content)) = self.hint_content(old, keys).await else {
            return;
        };
        let client = self.client();
        let existing = client
            .send(get_state_event_for_key::v3::Request::new(
                new.clone(),
                keys.hint.into(),
                String::new(),
            ))
            .await;
        if existing.is_ok() {
            return;
        }
        if let Err(error) = self
            .send_state(
                new.clone(),
                keys.hint,
                "",
                &hint_content(hint(Some(&content))),
            )
            .await
        {
            tracing::warn!(?error, "presence hint not copied to the upgraded room");
        }
    }
}

#[derive(Clone, Copy)]
enum Document {
    Sharing,
    Prompted,
    Hint,
}

impl Document {
    fn candidates(self, keys: Keys) -> Vec<&'static str> {
        let pick = |keys: Keys| match self {
            Self::Sharing => keys.sharing,
            Self::Prompted => keys.prompted,
            Self::Hint => keys.hint,
        };
        if keys == STABLE {
            vec![pick(STABLE), pick(UNSTABLE)]
        } else {
            vec![pick(keys)]
        }
    }
}

async fn one_to_one_partner(room: &Room) -> Option<OwnedUserId> {
    if !room.is_direct().await.unwrap_or(false) {
        return None;
    }
    let own = room.own_user_id();
    let members = room.members_no_sync(RoomMemberships::JOIN).await.ok()?;
    let mut others = members
        .iter()
        .map(|member| member.user_id())
        .filter(|user_id| *user_id != own);
    let partner = others.next()?.to_owned();
    others.next().is_none().then_some(partner)
}

#[cfg(test)]
#[path = "presence_sharing_tests.rs"]
mod tests;
