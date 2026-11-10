use std::collections::HashSet;

use matrix_sdk::ruma::api::FeatureFlag;
use matrix_sdk::ruma::api::client::state::get_state_event_for_key;
use matrix_sdk::ruma::events::{GlobalAccountDataEventType, StateEventType};
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId, RoomId};
use matrix_sdk::{Room, RoomMemberships, RoomState};
use serde_json::{Map, Value, json};

use crate::Core;
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

impl Core {
    pub(crate) async fn presence_keys(&self) -> Option<Keys> {
        let client = self.client().await.ok()?;
        let features = client.unstable_features().await.ok()?;
        let advertised: Vec<&str> = [STABLE_FEATURE, FEATURE]
            .into_iter()
            .filter(|flag| features.contains(&FeatureFlag::from(*flag)))
            .collect();
        keys_for(&advertised)
    }

    async fn presence_keys_or_unsupported(&self, label: &str) -> Result<Keys, RpcError> {
        self.presence_keys()
            .await
            .ok_or_else(|| self.failed(label, "the homeserver does not support selective presence"))
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
        let stored = self
            .sharing_document(keys, Document::Sharing, label)
            .await?;
        let content = match edited_sharing(stored.clone(), edit) {
            Some(content) => {
                self.put_global_account_data(keys.sharing.into(), &content, label)
                    .await?;
                Some(content)
            }
            None => stored,
        };
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
    ) -> Option<matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::AnyInitialStateEvent>> {
        let keys = self.presence_keys().await?;
        matrix_sdk::ruma::serde::Raw::new(&json!({
            "type": keys.hint,
            "state_key": "",
            "content": hint_content(hint),
        }))
        .ok()
        .map(matrix_sdk::ruma::serde::Raw::cast_unchecked)
    }

    pub(crate) async fn presence_prompt(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<Option<PresencePromptView>, RpcError> {
        let Some(keys) = self.presence_keys().await else {
            return Ok(None);
        };
        let room = self.room(room_id).await?;
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
        let predecessors = self.verified_predecessors(&room).await;
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
        let stored = self
            .sharing_document(keys, Document::Prompted, label)
            .await?;
        if let Some(content) = with_prompted(stored, &prompt) {
            self.put_global_account_data(keys.prompted.into(), &content, label)
                .await?;
        }
        Ok(())
    }

    /// A create event can name any room as its predecessor, so the old room's tombstone must point back.
    async fn verified_predecessors(&self, room: &Room) -> Vec<OwnedRoomId> {
        let Ok(client) = self.client().await else {
            return Vec::new();
        };
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
        let Ok(client) = self.client().await else {
            return;
        };
        let replaced = client
            .get_room(old)
            .and_then(|room| room.successor_room())
            .is_some_and(|successor| &successor.room_id == new);
        if !replaced {
            return;
        }
        if let Ok(stored) = self.sharing_document(keys, Document::Sharing, label).await
            && let Some(content) = carried_sharing(stored, old, new)
            && let Err(error) = self
                .put_global_account_data(keys.sharing.into(), &content, label)
                .await
        {
            tracing::warn!(?error, "presence sharing not carried to the upgraded room");
        }
        if let Ok(stored) = self.sharing_document(keys, Document::Prompted, label).await
            && let Some(content) = carried_prompted(stored, old, new)
            && let Err(error) = self
                .put_global_account_data(keys.prompted.into(), &content, label)
                .await
        {
            tracing::warn!(
                ?error,
                "presence prompt answer not carried to the upgraded room"
            );
        }
    }

    pub(crate) async fn follow_presence_upgrade(&self, room_id: &OwnedRoomId) {
        let Ok(client) = self.client().await else {
            return;
        };
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
        let Ok(client) = self.client().await else {
            return;
        };
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
mod tests {
    use matrix_sdk::ruma::{owned_room_id, owned_server_name, owned_user_id, room_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::{Value, json};
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    use super::{
        STABLE, UNSTABLE, answered, carried_prompted, carried_sharing, edited_sharing, hint,
        keys_for, sharing_view, with_prompted,
    };
    use crate::protocol::{
        PresenceHintView, PresencePromptView, PresenceSharingEdit, PresenceUserSharingView,
        RpcError,
    };

    #[test]
    fn the_stable_flag_wins_over_the_unstable_one() {
        assert_eq!(keys_for(&[]), None);
        assert_eq!(keys_for(&[super::FEATURE]), Some(UNSTABLE));
        assert_eq!(
            keys_for(&[super::FEATURE, super::STABLE_FEATURE]),
            Some(STABLE)
        );
    }

    #[test]
    fn the_view_reads_the_msc_sample() {
        let sharing = json!({
            "share_locally": true,
            "users": {"@alice:example.com": "allow", "@mallory:example.com": "deny"},
            "rooms": {"!family-group-chat": "allow"},
            "servers": {"matrix.org": "deny"},
        });
        let prompted = json!({"users": ["@joey:example.com"], "rooms": ["!apartment"]});

        let view = sharing_view(UNSTABLE, Some(&sharing), Some(&prompted));

        assert!(view.configured);
        assert!(view.share_locally);
        assert_eq!(view.allowed_users, ["@alice:example.com"]);
        assert_eq!(view.denied_users, ["@mallory:example.com"]);
        assert_eq!(view.allowed_rooms, ["!family-group-chat"]);
        assert_eq!(view.denied_servers, ["matrix.org"]);
        assert_eq!(view.prompted_users, ["@joey:example.com"]);
        assert_eq!(view.prompted_rooms, ["!apartment"]);
    }

    #[test]
    fn values_the_msc_forbids_for_a_kind_are_not_listed() {
        let sharing = json!({
            "rooms": {"!a:x": "deny"},
            "servers": {"x": "allow"},
        });

        let view = sharing_view(UNSTABLE, Some(&sharing), None);

        assert_eq!(view.allowed_rooms, Vec::<String>::new());
        assert_eq!(view.denied_servers, Vec::<String>::new());
    }

    #[test]
    fn a_missing_document_is_not_configured() {
        let view = sharing_view(UNSTABLE, None, None);

        assert!(!view.configured);
        assert!(!view.share_locally);
    }

    #[test]
    fn an_edit_keeps_fields_it_does_not_touch() {
        let stored = json!({
            "share_locally": true,
            "users": {"@a:x": "allow"},
            "com.example.extra": 1,
        });

        let edited = edited_sharing(
            Some(stored),
            &PresenceSharingEdit::User {
                user_id: owned_user_id!("@b:x"),
                sharing: Some(PresenceUserSharingView::Deny),
            },
        )
        .unwrap();

        assert_eq!(
            edited,
            json!({
                "share_locally": true,
                "users": {"@a:x": "allow", "@b:x": "deny"},
                "com.example.extra": 1,
            })
        );
    }

    #[test]
    fn an_edit_removes_entries() {
        let stored = json!({
            "users": {"@a:x": "allow"},
            "rooms": {"!r:x": "allow"},
            "servers": {"x": "deny"},
        });
        let edits = [
            PresenceSharingEdit::User {
                user_id: owned_user_id!("@a:x"),
                sharing: None,
            },
            PresenceSharingEdit::Room {
                room_id: owned_room_id!("!r:x"),
                allowed: false,
            },
            PresenceSharingEdit::Server {
                server: owned_server_name!("x"),
                denied: false,
            },
        ];

        let edited = edits.iter().fold(stored, |content, edit| {
            edited_sharing(Some(content), edit).unwrap()
        });

        assert_eq!(edited, json!({"users": {}, "rooms": {}, "servers": {}}));
    }

    #[test]
    fn an_edit_that_changes_nothing_is_not_written() {
        let stored = json!({"share_locally": false, "servers": {"x": "deny"}});

        assert!(
            edited_sharing(
                Some(stored.clone()),
                &PresenceSharingEdit::ShareLocally { enabled: false }
            )
            .is_none()
        );
        assert!(
            edited_sharing(
                Some(stored),
                &PresenceSharingEdit::Server {
                    server: owned_server_name!("x"),
                    denied: true,
                }
            )
            .is_none()
        );
    }

    #[test]
    fn a_first_edit_creates_the_document_even_for_a_default() {
        let edited =
            edited_sharing(None, &PresenceSharingEdit::ShareLocally { enabled: false }).unwrap();

        assert_eq!(edited, json!({"share_locally": false}));
    }

    #[test]
    fn a_prompt_is_recorded_once() {
        let prompt = PresencePromptView::User {
            user_id: owned_user_id!("@a:x"),
        };

        let recorded = with_prompted(Some(json!({"rooms": ["!r:x"]})), &prompt).unwrap();

        assert_eq!(recorded, json!({"rooms": ["!r:x"], "users": ["@a:x"]}));
        assert!(with_prompted(Some(recorded), &prompt).is_none());
    }

    #[test]
    fn a_missing_or_unknown_hint_forbids() {
        assert_eq!(hint(None), PresenceHintView::Forbid);
        assert_eq!(hint(Some(&json!({}))), PresenceHintView::Forbid);
        assert_eq!(
            hint(Some(&json!({"presence_sharing": "always"}))),
            PresenceHintView::Forbid
        );
        assert_eq!(
            hint(Some(&json!({"presence_sharing": "suggest"}))),
            PresenceHintView::Suggest
        );
    }

    #[test]
    fn an_answer_in_a_predecessor_counts_for_the_room() {
        let view = sharing_view(UNSTABLE, None, Some(&json!({"rooms": ["!old:x"]})));
        let prompt = PresencePromptView::Room {
            room_id: owned_room_id!("!new:x"),
        };

        assert!(!answered(&view, &prompt, &[]));
        assert!(answered(&view, &prompt, &[owned_room_id!("!old:x")]));
    }

    #[test]
    fn any_entry_for_a_user_answers_their_prompt() {
        let prompt = PresencePromptView::User {
            user_id: owned_user_id!("@a:x"),
        };

        for sharing in [
            json!({"users": {"@a:x": "deny"}}),
            json!({"users": {"@a:x": "allow"}}),
        ] {
            assert!(answered(
                &sharing_view(UNSTABLE, Some(&sharing), None),
                &prompt,
                &[]
            ));
        }
        assert!(!answered(&sharing_view(UNSTABLE, None, None), &prompt, &[]));
    }

    #[test]
    fn an_upgrade_carries_the_room_answers() {
        let new = owned_room_id!("!new:x");

        let sharing = carried_sharing(
            Some(json!({"rooms": {"!old:x": "allow"}})),
            room_id!("!old:x"),
            &new,
        );
        let prompted =
            carried_prompted(Some(json!({"rooms": ["!old:x"]})), room_id!("!old:x"), &new);

        assert_eq!(
            sharing,
            Some(json!({"rooms": {"!old:x": "allow", "!new:x": "allow"}}))
        );
        assert_eq!(prompted, Some(json!({"rooms": ["!old:x", "!new:x"]})));
        assert_eq!(carried_sharing(None, room_id!("!old:x"), &new), None);
        assert_eq!(
            carried_prompted(Some(json!({"rooms": []})), room_id!("!old:x"), &new),
            None
        );
    }

    async fn advertise(server: &MatrixMockServer, features: Value) {
        Mock::given(method("GET"))
            .and(path("/_matrix/client/versions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "versions": ["v1.19"],
                "unstable_features": features,
            })))
            .mount(server.server())
            .await;
    }

    async fn put_body(server: &MatrixMockServer, suffix: &str) -> Option<Value> {
        server
            .server()
            .received_requests()
            .await
            .unwrap()
            .iter()
            .rev()
            .find(|request| {
                request.method.as_str() == "PUT" && request.url.path().ends_with(suffix)
            })
            .map(|request| serde_json::from_slice(&request.body).unwrap())
    }

    #[tokio::test]
    async fn sharing_is_absent_without_server_support() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().no_server_versions().build().await;
        advertise(&server, json!({})).await;
        let (core, _) = crate::test_support::signed_in_core(&server, client).await;

        assert_eq!(core.presence_sharing().await.unwrap(), None);
        assert!(matches!(
            core.edit_presence_sharing(&PresenceSharingEdit::ShareLocally { enabled: true })
                .await,
            Err(RpcError::Failed { .. })
        ));
    }

    #[tokio::test]
    async fn an_edit_writes_the_unstable_document() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().no_server_versions().build().await;
        advertise(
            &server,
            json!({"org.continuwuity.presence_v2.msc4495": true}),
        )
        .await;
        Mock::given(method("GET"))
            .and(path_regex(format!(
                "/account_data/{}$",
                regex_lite::escape(UNSTABLE.sharing)
            )))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"users": {"@a:x": "allow"}})),
            )
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"/account_data/"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "not found"})),
            )
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(r"/account_data/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(server.server())
            .await;
        let (core, _) = crate::test_support::signed_in_core(&server, client).await;

        let view = core
            .edit_presence_sharing(&PresenceSharingEdit::ShareLocally { enabled: true })
            .await
            .unwrap();

        assert!(view.share_locally);
        assert_eq!(view.allowed_users, ["@a:x"]);
        assert_eq!(
            put_body(&server, UNSTABLE.sharing).await,
            Some(json!({"users": {"@a:x": "allow"}, "share_locally": true}))
        );
    }

    #[tokio::test]
    async fn the_stable_flag_writes_stable_and_reads_the_unstable_fallback() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().no_server_versions().build().await;
        advertise(
            &server,
            json!({
                "org.continuwuity.presence_v2.msc4495": true,
                "org.continuwuity.presence_v2.msc4495.stable": true,
            }),
        )
        .await;
        Mock::given(method("GET"))
            .and(path_regex(format!(
                "/account_data/{}$",
                regex_lite::escape(UNSTABLE.sharing)
            )))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"servers": {"x": "deny"}})),
            )
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"/account_data/"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "not found"})),
            )
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(r"/account_data/"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(server.server())
            .await;
        let (core, _) = crate::test_support::signed_in_core(&server, client).await;

        core.edit_presence_sharing(&PresenceSharingEdit::ShareLocally { enabled: true })
            .await
            .unwrap();

        assert_eq!(
            put_body(&server, STABLE.sharing).await,
            Some(json!({"servers": {"x": "deny"}, "share_locally": true}))
        );
        assert_eq!(put_body(&server, UNSTABLE.sharing).await, None);
    }

    #[tokio::test]
    async fn a_suggesting_dm_prompts_about_its_other_member() {
        use matrix_sdk_test::{JoinedRoomBuilder, event_factory::EventFactory};

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().no_server_versions().build().await;
        advertise(
            &server,
            json!({"org.continuwuity.presence_v2.msc4495": true}),
        )
        .await;
        let room_id = owned_room_id!("!dm:example.org");
        let own = client.user_id().unwrap().to_owned();
        let partner = owned_user_id!("@bob:example.org");
        let factory = EventFactory::new().room(&room_id);
        let hint = matrix_sdk::ruma::serde::Raw::new(&json!({
            "type": UNSTABLE.hint,
            "state_key": "",
            "sender": own,
            "event_id": "$hint",
            "origin_server_ts": 1,
            "content": {"presence_sharing": "suggest"},
        }))
        .unwrap()
        .cast_unchecked();
        server
            .mock_sync()
            .ok_and_run(&client, |sync| {
                sync.add_global_account_data(
                    EventFactory::new()
                        .direct()
                        .add_user(partner.clone(), &room_id),
                );
                sync.add_joined_room(
                    JoinedRoomBuilder::new(&room_id)
                        .add_state_event(factory.member(&own).sender(&own))
                        .add_state_event(factory.member(&partner).sender(&partner))
                        .add_state_bulk([hint]),
                );
            })
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"/account_data/"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "not found"})),
            )
            .mount(server.server())
            .await;
        let (core, _) = crate::test_support::signed_in_core(&server, client).await;

        assert_eq!(
            core.presence_prompt(&room_id).await.unwrap(),
            Some(PresencePromptView::User { user_id: partner })
        );
    }
}
