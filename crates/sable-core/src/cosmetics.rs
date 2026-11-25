use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use matrix_sdk::executor::spawn;
use matrix_sdk::ruma::api::client::state::get_state_event_for_key;
use matrix_sdk::ruma::events::{AnySyncStateEvent, StateEventType};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId, RoomId, UserId};
use matrix_sdk_base::deserialized_responses::RawAnySyncOrStrippedState;
use sable_model::text::visible_name;
use serde::Deserialize;
use serde_json::Value;

use crate::Core;
use crate::SignedIn;
use crate::profiles::{profile_hex_color, pronoun_sets};
use crate::protocol::{
    CoreEvent, PronounView, RoomCosmeticsView, RpcCode, RpcError, SenderCosmeticsView,
};

pub(crate) const MEMBER_EVENT: &str = "m.room.member";
pub(crate) const MEMBER_COLOR_FIELD: &str = "eu.she-a.color";
pub(crate) const COLOR_EVENT: &str = "moe.sable.room.cosmetics.color";
pub(crate) const PRONOUNS_EVENT: &str = "moe.sable.room.cosmetics.pronouns";
const SPACE_PARENT_EVENT: &str = "m.space.parent";
const MAX_CACHED_ROOMS: usize = 16;

fn is_cosmetic(event_type: &str) -> bool {
    matches!(event_type, MEMBER_EVENT | COLOR_EVENT | PRONOUNS_EVENT)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Entry {
    on_light: Option<String>,
    on_dark: Option<String>,
    color: Option<String>,
    pronouns: Vec<PronounView>,
    display_name: Option<String>,
    avatar_url: Option<String>,
}

fn member_text(content: &Value, field: &str) -> Option<String> {
    content
        .get(field)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn shown_identity(content: &Value) -> (Option<String>, Option<String>) {
    (
        member_text(content, "displayname").and_then(visible_name),
        member_text(content, "avatar_url"),
    )
}

impl Entry {
    fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Layer {
    users: HashMap<OwnedUserId, Entry>,
}

impl Layer {
    fn apply(&mut self, event_type: &str, state_key: &str, content: &Value) -> bool {
        let Ok(user_id) = UserId::parse(state_key) else {
            return false;
        };
        let before = self.users.get(&user_id);
        let mut entry = before.cloned().unwrap_or_default();
        match event_type {
            MEMBER_EVENT => {
                let colors = content.get(MEMBER_COLOR_FIELD);
                entry.on_light =
                    profile_hex_color(colors.and_then(|colors| colors.get("on_light")));
                entry.on_dark = profile_hex_color(colors.and_then(|colors| colors.get("on_dark")));
                (entry.display_name, entry.avatar_url) = shown_identity(content);
            }
            COLOR_EVENT => entry.color = profile_hex_color(content.get("color")),
            PRONOUNS_EVENT => entry.pronouns = pronoun_sets(content.get("pronouns")),
            _ => return false,
        }

        match before {
            Some(before) if before == &entry => false,
            None if entry.is_empty() => false,
            _ => {
                if entry.is_empty() {
                    self.users.remove(&user_id);
                } else {
                    self.users.insert(user_id, entry);
                }
                true
            }
        }
    }

    fn from_events<'a>(events: impl IntoIterator<Item = StateFields<'a>>) -> Self {
        let mut layer = Self::default();
        for event in events {
            if !is_cosmetic(&event.event_type) {
                continue;
            }
            let (Some(state_key), Some(content)) = (event.state_key, event.content) else {
                continue;
            };
            if let Ok(content) = serde_json::from_str::<Value>(content.get()) {
                layer.apply(&event.event_type, &state_key, &content);
            }
        }
        layer
    }
}

#[derive(Deserialize)]
struct StateFields<'a> {
    #[serde(rename = "type", borrow)]
    event_type: std::borrow::Cow<'a, str>,
    #[serde(borrow, default)]
    state_key: Option<std::borrow::Cow<'a, str>>,
    #[serde(borrow, default)]
    content: Option<&'a serde_json::value::RawValue>,
}

pub(crate) fn resolve(room: &Layer, space: Option<&Layer>) -> Vec<SenderCosmeticsView> {
    let empty = Entry::default();
    let users: BTreeSet<&OwnedUserId> = room
        .users
        .keys()
        .chain(space.into_iter().flat_map(|space| space.users.keys()))
        .collect();

    users
        .into_iter()
        .filter_map(|user_id| {
            let own = room.users.get(user_id).unwrap_or(&empty);
            let inherited = space
                .and_then(|space| space.users.get(user_id))
                .unwrap_or(&empty);
            let pick = |theme: fn(&Entry) -> &Option<String>| {
                theme(own)
                    .as_ref()
                    .or(own.color.as_ref())
                    .or_else(|| theme(inherited).as_ref())
                    .or(inherited.color.as_ref())
                    .cloned()
            };
            let differs = |inherited: &Option<String>, own: &Option<String>| {
                inherited.clone().filter(|_| inherited != own)
            };
            let view = SenderCosmeticsView {
                user_id: user_id.clone(),
                color_on_light: pick(|entry| &entry.on_light),
                color_on_dark: pick(|entry| &entry.on_dark),
                pronouns: if own.pronouns.is_empty() {
                    inherited.pronouns.clone()
                } else {
                    own.pronouns.clone()
                },
                space_display_name: differs(&inherited.display_name, &own.display_name),
                space_avatar_url: differs(&inherited.avatar_url, &own.avatar_url),
            };
            let bare = view.color_on_light.is_none()
                && view.color_on_dark.is_none()
                && view.pronouns.is_empty()
                && view.space_display_name.is_none()
                && view.space_avatar_url.is_none();
            (!bare).then_some(view)
        })
        .collect()
}

#[derive(Debug, Default)]
pub(crate) struct CosmeticsCache {
    layers: HashMap<OwnedRoomId, (Layer, u64)>,
    checked: HashMap<(OwnedRoomId, OwnedUserId), (Option<String>, Option<String>)>,
    tick: u64,
}

impl CosmeticsCache {
    fn get(&mut self, room_id: &RoomId) -> Option<Layer> {
        self.tick += 1;
        let tick = self.tick;
        self.layers.get_mut(room_id).map(|(layer, used)| {
            *used = tick;
            layer.clone()
        })
    }

    fn insert(&mut self, room_id: OwnedRoomId, layer: Layer) {
        self.tick += 1;
        self.layers.insert(room_id, (layer, self.tick));
        while self.layers.len() > MAX_CACHED_ROOMS {
            let Some(oldest) = self
                .layers
                .iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(room_id, _)| room_id.clone())
            else {
                break;
            };
            self.layers.remove(&oldest);
        }
    }

    fn contains(&self, room_id: &RoomId) -> bool {
        self.layers.contains_key(room_id)
    }

    fn outdated_member(
        &mut self,
        room_id: &RoomId,
        user_id: &UserId,
        content: &Value,
        previous: Option<&Value>,
    ) -> Vec<OwnedRoomId> {
        let current = shown_identity(content);
        let replaced = previous.map(shown_identity);
        if replaced.as_ref() == Some(&current) {
            return Vec::new();
        }
        let outdated: Vec<OwnedRoomId> = self
            .layers
            .iter()
            .filter(|(id, (layer, _))| {
                *id != room_id
                    && self.checked.get(&((*id).clone(), user_id.to_owned())) != Some(&current)
                    && layer.users.get(user_id).is_some_and(|entry| {
                        let shown = (entry.display_name.clone(), entry.avatar_url.clone());
                        shown != current
                            && replaced.as_ref().is_none_or(|replaced| *replaced == shown)
                    })
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &outdated {
            self.checked
                .insert((id.clone(), user_id.to_owned()), current.clone());
        }
        outdated
    }

    fn apply(
        &mut self,
        room_id: &RoomId,
        event_type: &str,
        state_key: &str,
        content: &Value,
    ) -> bool {
        self.layers
            .get_mut(room_id)
            .is_some_and(|(layer, _)| layer.apply(event_type, state_key, content))
    }
}

pub(crate) async fn unjoined_space_parents(
    core: &Core,
    client: &matrix_sdk::Client,
    room: &matrix_sdk::Room,
) -> Vec<crate::protocol::SpaceParentView> {
    crate::space_parents::parents(core, room)
        .await
        .into_iter()
        .filter(|(parent, _)| {
            client
                .get_room(parent)
                .is_none_or(|space| space.state() != matrix_sdk::RoomState::Joined)
        })
        .map(|(room_id, via)| crate::protocol::SpaceParentView { room_id, via })
        .collect()
}

pub(crate) async fn first_space_parent(
    core: &Core,
    client: &matrix_sdk::Client,
    room: &matrix_sdk::Room,
) -> Option<OwnedRoomId> {
    if let Some(space) = crate::view::listing_spaces(Some(core), client, room.room_id())
        .await
        .into_iter()
        .next()
    {
        return Some(space);
    }
    crate::space_parents::parents(core, room)
        .await
        .into_iter()
        .next()
        .map(|(room_id, _)| room_id)
}

async fn stored_layer(room: &matrix_sdk::Room) -> Result<Layer, matrix_sdk::Error> {
    let mut raws = Vec::new();
    for event_type in [MEMBER_EVENT, COLOR_EVENT, PRONOUNS_EVENT] {
        for event in room
            .get_state_events(StateEventType::from(event_type))
            .await?
        {
            if let RawAnySyncOrStrippedState::Sync(raw) = event {
                raws.push(raw);
            }
        }
    }
    Ok(Layer::from_events(raws.iter().filter_map(|raw| {
        raw.deserialize_as_unchecked::<StateFields<'_>>().ok()
    })))
}

impl SignedIn {
    pub(crate) async fn room_cosmetics(
        &self,
        room_id: &OwnedRoomId,
        space_id: Option<OwnedRoomId>,
    ) -> Result<RoomCosmeticsView, RpcError> {
        let client = self.client();
        let room = client.get_room(room_id).ok_or(RpcCode::UnknownRoom)?;
        Ok(self.cosmetics_for(&room, space_id).await)
    }

    pub(crate) async fn cosmetics_for(
        &self,
        room: &matrix_sdk::Room,
        space_id: Option<OwnedRoomId>,
    ) -> RoomCosmeticsView {
        let client = self.client();
        let space_id = match space_id {
            Some(space_id) if space_id != room.room_id() => Some(space_id),
            Some(_) => None,
            None => first_space_parent(self.core(), client, room).await,
        };
        let space = space_id
            .as_ref()
            .and_then(|space_id| client.get_room(space_id));
        let (own, inherited) = futures_util::join!(self.cosmetics_layer(room), async {
            match &space {
                Some(space) => Some(self.cosmetics_layer(space).await),
                None => None,
            }
        });

        RoomCosmeticsView {
            space_id: space.map(|space| space.room_id().to_owned()),
            users: resolve(&own, inherited.as_ref()),
        }
    }

    async fn cosmetics_layer(&self, room: &matrix_sdk::Room) -> Layer {
        let cached = self.cosmetics_cache().get(room.room_id());
        if let Some(layer) = cached {
            return layer;
        }

        let fetch = self.cosmetics_fetch_lock(room.room_id());
        let _fetching = fetch.lock().await;
        let cached = self.cosmetics_cache().get(room.room_id());
        if let Some(layer) = cached {
            return layer;
        }

        match self.room_state_snapshot(room.room_id()).await {
            Ok(snapshot) => {
                let layer = Layer::from_events(
                    snapshot
                        .iter()
                        .filter_map(|raw| raw.deserialize_as_unchecked::<StateFields<'_>>().ok()),
                );
                self.cosmetics_cache()
                    .insert(room.room_id().to_owned(), layer.clone());
                layer
            }
            Err(error) => {
                tracing::warn!(room = %room.room_id(), %error, "room cosmetics read from the store after the state fetch failed");
                self.core()
                    .with_open_stores(async || stored_layer(room).await)
                    .await
                    .unwrap_or_default()
            }
        }
    }

    fn cosmetics_cache(&self) -> parking_lot::ArcMutexGuard<parking_lot::RawMutex, CosmeticsCache> {
        self.state().cosmetics.lock_arc()
    }

    pub(crate) fn note_cosmetic_state(
        &self,
        room_id: &RoomId,
        event_type: &str,
        state_key: &str,
        content: &Value,
    ) -> bool {
        let mut cache = self.cosmetics_cache();
        if event_type == SPACE_PARENT_EVENT {
            return cache.contains(room_id);
        }
        is_cosmetic(event_type) && cache.apply(room_id, event_type, state_key, content)
    }

    async fn refresh_member(&self, layers: Vec<OwnedRoomId>, user_id: &UserId, generation: u64) {
        let client = self.client();
        for room_id in layers {
            let request = get_state_event_for_key::v3::Request::new(
                room_id.clone(),
                StateEventType::RoomMember,
                user_id.to_string(),
            );
            let content = match client.send(request).await {
                Ok(response) => {
                    crate::room_settings::state_event_content(response.event_or_content.get())
                        .unwrap_or(Value::Null)
                }
                Err(error) => {
                    tracing::warn!(room = %room_id, %error, "member refresh for room cosmetics failed");
                    continue;
                }
            };
            if self.note_cosmetic_state(&room_id, MEMBER_EVENT, user_id.as_str(), &content) {
                self.core()
                    .emit_if_current(generation, CoreEvent::RoomCosmeticsChanged { room_id });
            }
        }
    }

    pub(crate) fn watch_cosmetics(&self, generation: u64) {
        let client = self.client();
        let handle = client.add_event_handler({
            let core = self.clone();
            move |raw: Raw<AnySyncStateEvent>, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    let Ok(fields) = raw.deserialize_as_unchecked::<StateFields<'_>>() else {
                        return;
                    };
                    if !is_cosmetic(&fields.event_type) && fields.event_type != SPACE_PARENT_EVENT {
                        return;
                    }
                    let content = fields
                        .content
                        .and_then(|content| serde_json::from_str::<Value>(content.get()).ok())
                        .unwrap_or(Value::Null);
                    if core.note_cosmetic_state(
                        room.room_id(),
                        &fields.event_type,
                        fields.state_key.as_deref().unwrap_or_default(),
                        &content,
                    ) {
                        core.core().emit_if_current(
                            generation,
                            CoreEvent::RoomCosmeticsChanged {
                                room_id: room.room_id().to_owned(),
                            },
                        );
                    }
                    if fields.event_type != MEMBER_EVENT
                        || content.get("membership").and_then(Value::as_str) != Some("join")
                    {
                        return;
                    }
                    let Some(Ok(user_id)) = fields.state_key.as_deref().map(UserId::parse) else {
                        return;
                    };
                    let previous = raw
                        .get_field::<Value>("unsigned")
                        .ok()
                        .flatten()
                        .and_then(|unsigned| unsigned.get("prev_content").cloned());
                    let outdated = core.cosmetics_cache().outdated_member(
                        room.room_id(),
                        &user_id,
                        &content,
                        previous.as_ref(),
                    );
                    if !outdated.is_empty() {
                        spawn(async move {
                            core.refresh_member(outdated, &user_id, generation).await;
                        });
                    }
                }
            }
        });
        self.track_session_handler(client, handle);
    }
}

#[cfg(test)]
#[path = "cosmetics_tests.rs"]
mod tests;

impl SignedIn {
    fn cosmetics_fetch_lock(&self, room_id: &RoomId) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.state().cosmetics_fetches.lock();
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        locks.entry(room_id.to_owned()).or_default().clone()
    }
}
