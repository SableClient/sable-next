use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use matrix_sdk::executor::spawn;
use matrix_sdk::ruma::api::client::state::get_state_event_for_key;
use matrix_sdk::ruma::events::{AnySyncStateEvent, StateEventType};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId, RoomId, UserId};
use matrix_sdk_base::deserialized_responses::RawAnySyncOrStrippedState;
use serde::Deserialize;
use serde_json::Value;

use crate::Core;
use crate::profiles::{profile_hex_color, pronoun_sets};
use crate::protocol::{CommandErr, CoreEvent, PronounView, RoomCosmeticsView, SenderCosmeticsView};

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
        member_text(content, "displayname"),
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
                entry.display_name = member_text(content, "displayname");
                entry.avatar_url = member_text(content, "avatar_url");
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
                    .or(theme(inherited).as_ref())
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
        &self,
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
        self.layers
            .iter()
            .filter(|(id, (layer, _))| {
                *id != room_id
                    && layer.users.get(user_id).is_some_and(|entry| {
                        let shown = (entry.display_name.clone(), entry.avatar_url.clone());
                        shown != current
                            && replaced.as_ref().is_none_or(|replaced| *replaced == shown)
                    })
            })
            .map(|(id, _)| id.clone())
            .collect()
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

pub(crate) async fn space_parents(room: &matrix_sdk::Room) -> Vec<(OwnedRoomId, Vec<String>)> {
    let events = room
        .get_state_events(StateEventType::SpaceParent)
        .await
        .unwrap_or_default();
    let claims = events
        .iter()
        .filter_map(|event| {
            let raw = match event {
                RawAnySyncOrStrippedState::Sync(raw) => raw.json(),
                RawAnySyncOrStrippedState::Stripped(raw) => raw.json(),
            };
            serde_json::from_str::<crate::space_parents::ParentClaim>(raw.get()).ok()
        })
        .collect::<Vec<_>>();
    crate::space_parents::validate(&room.client(), room.room_id(), &claims, true)
        .await
        .into_iter()
        .filter_map(|parent| parent.room_id().map(|id| (id, parent.content.via)))
        .collect()
}

pub(crate) async fn unjoined_space_parents(
    client: &matrix_sdk::Client,
    room: &matrix_sdk::Room,
) -> Vec<crate::protocol::SpaceParentView> {
    space_parents(room)
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

async fn first_space_parent(
    client: &matrix_sdk::Client,
    room: &matrix_sdk::Room,
) -> Option<OwnedRoomId> {
    if let Some(space) = crate::view::listing_spaces(client, room.room_id())
        .await
        .into_iter()
        .next()
    {
        return Some(space);
    }
    space_parents(room)
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

impl Core {
    pub(crate) async fn room_cosmetics(
        &self,
        room_id: &OwnedRoomId,
        space_id: Option<OwnedRoomId>,
    ) -> Result<RoomCosmeticsView, CommandErr> {
        let client = self.client().await?;
        let room = client.get_room(room_id).ok_or(CommandErr::UnknownRoom)?;
        Ok(self.cosmetics_for(&client, &room, space_id).await)
    }

    pub(crate) async fn cosmetics_for(
        &self,
        client: &matrix_sdk::Client,
        room: &matrix_sdk::Room,
        space_id: Option<OwnedRoomId>,
    ) -> RoomCosmeticsView {
        let space_id = match space_id {
            Some(space_id) if space_id != room.room_id() => Some(space_id),
            Some(_) => None,
            None => first_space_parent(client, room).await,
        };
        let space = space_id
            .as_ref()
            .and_then(|space_id| client.get_room(space_id));
        let (own, inherited) = futures_util::join!(self.cosmetics_layer(client, room), async {
            match &space {
                Some(space) => Some(self.cosmetics_layer(client, space).await),
                None => None,
            }
        });

        RoomCosmeticsView {
            space_id: space.map(|space| space.room_id().to_owned()),
            users: resolve(&own, inherited.as_ref()),
        }
    }

    async fn cosmetics_layer(&self, client: &matrix_sdk::Client, room: &matrix_sdk::Room) -> Layer {
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

        match self.room_state_snapshot(client, room.room_id()).await {
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
                stored_layer(room).await.unwrap_or_default()
            }
        }
    }

    fn cosmetics_fetch_lock(&self, room_id: &RoomId) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .cosmetics_fetches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        locks.entry(room_id.to_owned()).or_default().clone()
    }

    fn cosmetics_cache(&self) -> std::sync::MutexGuard<'_, CosmeticsCache> {
        self.cosmetics
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
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

    async fn refresh_member(
        &self,
        client: &matrix_sdk::Client,
        layers: Vec<OwnedRoomId>,
        user_id: &UserId,
        generation: u64,
    ) {
        for room_id in layers {
            let request = get_state_event_for_key::v3::Request::new(
                room_id.clone(),
                StateEventType::RoomMember,
                user_id.to_string(),
            );
            let content = match client.send(request).await {
                Ok(response) => {
                    crate::dispatch::state_event_content(response.event_or_content.get())
                        .unwrap_or(Value::Null)
                }
                Err(error) => {
                    tracing::warn!(room = %room_id, %error, "member refresh for room cosmetics failed");
                    continue;
                }
            };
            if self.note_cosmetic_state(&room_id, MEMBER_EVENT, user_id.as_str(), &content) {
                self.emit_if_current(generation, CoreEvent::RoomCosmeticsChanged { room_id });
            }
        }
    }

    pub(crate) fn watch_cosmetics(self: &Arc<Self>, client: &matrix_sdk::Client, generation: u64) {
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
                        core.emit_if_current(
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
                        let client = room.client();
                        spawn(async move {
                            core.refresh_member(&client, outdated, &user_id, generation)
                                .await;
                        });
                    }
                }
            }
        });
        self.track_session_handler(client, handle);
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk::ruma::{OwnedRoomId, RoomId, room_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::{Value, json};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    use super::{COLOR_EVENT, Layer, MEMBER_EVENT, PRONOUNS_EVENT, resolve};
    use crate::Core;
    use crate::protocol::{CoreEvent, PronounView, SenderCosmeticsView};
    use crate::store::MemorySessionStore;

    const ALICE: &str = "@alice:example.org";
    const BOB: &str = "@bob:example.org";

    fn layer(events: &[(&str, &str, Value)]) -> Layer {
        let mut layer = Layer::default();
        for (event_type, state_key, content) in events {
            layer.apply(event_type, state_key, content);
        }
        layer
    }

    fn state(event_type: &str, state_key: &str, content: &Value) -> Value {
        json!({
            "type": event_type,
            "state_key": state_key,
            "sender": ALICE,
            "event_id": format!("${event_type}-{state_key}"),
            "origin_server_ts": 1,
            "content": content,
        })
    }

    fn pronoun(summary: &str, language: Option<&str>) -> PronounView {
        PronounView {
            summary: summary.to_owned(),
            language: language.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn the_room_wins_over_the_space_per_field() {
        let room = layer(&[
            (
                MEMBER_EVENT,
                ALICE,
                json!({ "membership": "join", "eu.she-a.color": { "on_dark": "#111111" } }),
            ),
            (COLOR_EVENT, ALICE, json!({ "color": "#222222" })),
        ]);
        let space = layer(&[
            (
                MEMBER_EVENT,
                ALICE,
                json!({
                    "membership": "join",
                    "eu.she-a.color": { "on_light": "#333333", "on_dark": "#444444" }
                }),
            ),
            (
                PRONOUNS_EVENT,
                ALICE,
                json!({ "pronouns": [{ "summary": "she/her" }] }),
            ),
            (COLOR_EVENT, BOB, json!({ "color": "#555555" })),
        ]);

        assert_eq!(
            resolve(&room, Some(&space)),
            [
                SenderCosmeticsView {
                    user_id: ALICE.try_into().unwrap(),
                    color_on_light: Some("#222222".to_owned()),
                    color_on_dark: Some("#111111".to_owned()),
                    pronouns: vec![pronoun("she/her", None)],
                    space_display_name: None,
                    space_avatar_url: None,
                },
                SenderCosmeticsView {
                    user_id: BOB.try_into().unwrap(),
                    color_on_light: Some("#555555".to_owned()),
                    color_on_dark: Some("#555555".to_owned()),
                    pronouns: Vec::new(),
                    space_display_name: None,
                    space_avatar_url: None,
                },
            ]
        );
    }

    #[test]
    fn the_space_name_and_picture_are_handed_on_beside_the_room_ones() {
        let room = layer(&[(
            MEMBER_EVENT,
            ALICE,
            json!({ "membership": "join", "displayname": "Room Alice" }),
        )]);
        let space = layer(&[(
            MEMBER_EVENT,
            ALICE,
            json!({
                "membership": "join",
                "displayname": "Space Alice",
                "avatar_url": "mxc://example.org/space"
            }),
        )]);

        let resolved = resolve(&room, Some(&space));

        assert_eq!(
            resolved[0].space_display_name.as_deref(),
            Some("Space Alice")
        );
        assert_eq!(
            resolved[0].space_avatar_url.as_deref(),
            Some("mxc://example.org/space")
        );
    }

    #[test]
    fn a_member_without_cosmetics_is_left_out() {
        let room = layer(&[
            (MEMBER_EVENT, ALICE, json!({ "membership": "join" })),
            (COLOR_EVENT, BOB, json!({})),
            (COLOR_EVENT, ALICE, json!({ "color": "red" })),
        ]);

        assert!(resolve(&room, None).is_empty());
    }

    #[test]
    fn only_a_changed_value_counts_as_a_change() {
        let mut room = Layer::default();
        let colored = json!({ "membership": "join", "eu.she-a.color": { "on_dark": "#111111" } });
        let renamed = json!({
            "membership": "join",
            "displayname": "Alice",
            "eu.she-a.color": { "on_dark": "#111111" }
        });

        assert!(!room.apply(MEMBER_EVENT, ALICE, &json!({ "membership": "join" })));
        assert!(room.apply(MEMBER_EVENT, ALICE, &colored));
        assert!(room.apply(MEMBER_EVENT, ALICE, &renamed));
        assert!(!room.apply(MEMBER_EVENT, ALICE, &renamed));
        assert!(room.apply(MEMBER_EVENT, ALICE, &json!({ "membership": "leave" })));
        assert!(resolve(&room, None).is_empty());
    }

    #[test]
    fn legacy_font_events_are_ignored() {
        let mut room = Layer::default();
        assert!(!room.apply(
            "moe.sable.room.cosmetics.font",
            ALICE,
            &json!({ "font": "Georgia" })
        ));
        assert!(resolve(&room, None).is_empty());
    }

    async fn joined(server: &MatrixMockServer, rooms: &[&RoomId]) -> matrix_sdk::Client {
        let client = server.client_builder().build().await;
        for room_id in rooms {
            server.sync_joined_room(&client, room_id).await;
        }
        client
    }

    async fn reciprocal(
        server: &MatrixMockServer,
        client: &matrix_sdk::Client,
        parent: &RoomId,
        child: &RoomId,
    ) {
        server
            .sync_room(
                client,
                JoinedRoomBuilder::new(parent).add_state_bulk([
                    Raw::new(&state(
                        "m.room.create",
                        "",
                        &json!({"type": "m.space", "creator": ALICE, "room_version": "10"}),
                    ))
                    .unwrap()
                    .cast_unchecked(),
                    Raw::new(&state(
                        "m.space.child",
                        child.as_str(),
                        &json!({"via": ["example.org"]}),
                    ))
                    .unwrap()
                    .cast_unchecked(),
                ]),
            )
            .await;
    }

    async fn serve_state(server: &MatrixMockServer, room_id: &RoomId, events: Value, times: u64) {
        Mock::given(method("GET"))
            .and(path(format!("/_matrix/client/v3/rooms/{room_id}/state")))
            .respond_with(ResponseTemplate::new(200).set_body_json(events))
            .expect(times)
            .mount(server.server())
            .await;
    }

    async fn serve_member(
        server: &MatrixMockServer,
        room_id: &RoomId,
        content: &Value,
        times: u64,
    ) {
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room_id}/state/m.room.member/{ALICE}"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(content))
            .expect(times)
            .mount(server.server())
            .await;
    }

    async fn rename(
        server: &MatrixMockServer,
        client: &matrix_sdk::Client,
        room_id: &RoomId,
        old: &Value,
        new: &Value,
    ) {
        let mut renamed = state(MEMBER_EVENT, ALICE, new);
        renamed["event_id"] = json!("$renamed");
        renamed["unsigned"] = json!({ "prev_content": old });
        server
            .sync_room(
                client,
                JoinedRoomBuilder::new(room_id)
                    .add_timeline_event(Raw::new(&renamed).unwrap().cast_unchecked()),
            )
            .await;
    }

    #[tokio::test]
    async fn a_room_is_fetched_once_and_served_from_the_cache() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let space_id = room_id!("!space:example.org");
        let client = joined(&server, &[room_id, space_id]).await;
        let (core, _events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
        serve_state(
            &server,
            room_id,
            json!([
                state(COLOR_EVENT, ALICE, &json!({ "color": "#123456" })),
                state("m.room.name", "", &json!({ "name": "Room" })),
            ]),
            1,
        )
        .await;
        serve_state(
            &server,
            space_id,
            json!([state(
                PRONOUNS_EVENT,
                ALICE,
                &json!({ "pronouns": [{ "summary": "they/them", "language": "EN" }] })
            )]),
            1,
        )
        .await;
        let room = client.get_room(room_id).unwrap();

        for _ in 0..2 {
            let found = core
                .cosmetics_for(&client, &room, Some(space_id.to_owned()))
                .await;
            assert_eq!(found.space_id.as_deref(), Some(space_id));
            assert_eq!(found.users.len(), 1);
            assert_eq!(found.users[0].color_on_light.as_deref(), Some("#123456"));
            assert_eq!(found.users[0].pronouns, [pronoun("they/them", Some("en"))]);
        }
    }

    #[tokio::test]
    async fn concurrent_reads_of_one_room_share_a_single_fetch() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let space_id = room_id!("!space:example.org");
        let client = joined(&server, &[room_id, space_id]).await;
        let (core, _events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
        serve_state(
            &server,
            room_id,
            json!([state(COLOR_EVENT, ALICE, &json!({ "color": "#123456" }))]),
            1,
        )
        .await;
        serve_state(&server, space_id, json!([]), 1).await;
        let room = client.get_room(room_id).unwrap();

        let found = futures_util::future::join_all(
            (0..5).map(|_| core.cosmetics_for(&client, &room, Some(space_id.to_owned()))),
        )
        .await;

        assert!(
            found
                .iter()
                .all(|view| view.users[0].color_on_light.as_deref() == Some("#123456"))
        );
    }

    #[tokio::test]
    async fn only_parents_we_are_not_in_are_offered_canonical_first() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let joined_space = room_id!("!joined:example.org");
        let client = joined(&server, &[joined_space]).await;
        reciprocal(&server, &client, joined_space, room_id).await;
        for id in ["!other:example.org", "!canonical:example.org"] {
            serve_state(
                &server,
                &RoomId::parse(id).unwrap(),
                json!([
                    state(
                        "m.room.create",
                        "",
                        &json!({"type": "m.space", "creator": ALICE, "room_version": "10"})
                    ),
                    state(
                        "m.space.child",
                        room_id.as_str(),
                        &json!({"via": ["example.org"]})
                    )
                ]),
                1,
            )
            .await;
        }
        let parent = |space: &str, content: Value| {
            Raw::new(&state("m.space.parent", space, &content))
                .unwrap()
                .cast_unchecked()
        };
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_state_bulk([
                    parent(joined_space.as_str(), json!({ "via": ["example.org"] })),
                    parent("!other:example.org", json!({ "via": ["other.org"] })),
                    parent(
                        "!canonical:example.org",
                        json!({ "via": ["example.org"], "canonical": true }),
                    ),
                    parent("!stale:example.org", json!({ "via": [] })),
                ]),
            )
            .await;
        let room = client.get_room(room_id).unwrap();

        let offered: Vec<(String, Vec<String>)> = super::unjoined_space_parents(&client, &room)
            .await
            .into_iter()
            .map(|parent| (parent.room_id.to_string(), parent.via))
            .collect();
        assert_eq!(
            offered,
            [
                (
                    "!canonical:example.org".to_owned(),
                    vec!["example.org".to_owned()]
                ),
                (
                    "!other:example.org".to_owned(),
                    vec!["other.org".to_owned()]
                ),
            ]
        );
    }

    #[tokio::test]
    async fn without_a_space_the_first_parent_is_used() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let space_id = room_id!("!space:example.org");
        let client = joined(&server, &[space_id]).await;
        reciprocal(&server, &client, space_id, room_id).await;
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_state_event(
                    Raw::new(&state(
                        "m.space.parent",
                        space_id.as_str(),
                        &json!({ "via": ["example.org"] }),
                    ))
                    .unwrap()
                    .cast_unchecked(),
                ),
            )
            .await;
        let (core, _events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
        serve_state(&server, room_id, json!([]), 1).await;
        serve_state(
            &server,
            space_id,
            json!([state(COLOR_EVENT, ALICE, &json!({ "color": "#abcdef" }))]),
            1,
        )
        .await;

        let found = core
            .cosmetics_for(&client, &client.get_room(room_id).unwrap(), None)
            .await;

        assert_eq!(found.space_id.as_deref(), Some(space_id));
        assert_eq!(found.users[0].color_on_dark.as_deref(), Some("#abcdef"));
    }

    #[tokio::test]
    async fn a_synced_change_updates_the_cache_and_is_announced() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let client = joined(&server, &[room_id]).await;
        let (core, mut events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
        core.watch_cosmetics(&client, 1);
        serve_state(&server, room_id, json!([]), 1).await;
        let room = client.get_room(room_id).unwrap();
        assert!(
            core.cosmetics_for(&client, &room, None)
                .await
                .users
                .is_empty()
        );

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_timeline_event(
                    Raw::new(&state(COLOR_EVENT, ALICE, &json!({ "color": "#123456" })))
                        .unwrap()
                        .cast_unchecked(),
                ),
            )
            .await;

        let announced: Vec<OwnedRoomId> = std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|event| match event {
                CoreEvent::RoomCosmeticsChanged { room_id } => Some(room_id),
                _ => None,
            })
            .collect();
        assert_eq!(announced, [room_id.to_owned()]);
        let found = core.cosmetics_for(&client, &room, None).await;
        assert_eq!(found.users[0].color_on_light.as_deref(), Some("#123456"));
    }

    #[tokio::test]
    async fn a_rename_in_one_room_refreshes_the_cached_space() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let space_id = room_id!("!space:example.org");
        let client = joined(&server, &[room_id, space_id]).await;
        let (core, mut events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
        core.watch_cosmetics(&client, 1);
        let old = json!({ "membership": "join", "displayname": "Old Alice" });
        let new = json!({ "membership": "join", "displayname": "New Alice" });
        serve_state(
            &server,
            room_id,
            json!([state(MEMBER_EVENT, ALICE, &old)]),
            1,
        )
        .await;
        serve_state(
            &server,
            space_id,
            json!([state(MEMBER_EVENT, ALICE, &old)]),
            1,
        )
        .await;
        serve_member(&server, space_id, &new, 1).await;
        let room = client.get_room(room_id).unwrap();
        assert!(
            core.cosmetics_for(&client, &room, Some(space_id.to_owned()))
                .await
                .users
                .is_empty()
        );

        rename(&server, &client, room_id, &old, &new).await;

        loop {
            let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
                .await
                .expect("the space is announced")
                .expect("the core is running");
            if matches!(&event, CoreEvent::RoomCosmeticsChanged { room_id } if room_id == space_id)
            {
                break;
            }
        }
        let found = core
            .cosmetics_for(&client, &room, Some(space_id.to_owned()))
            .await;
        assert!(found.users.is_empty(), "{:?}", found.users);
    }

    #[tokio::test]
    async fn a_rename_leaves_a_space_name_set_on_purpose() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let space_id = room_id!("!space:example.org");
        let client = joined(&server, &[room_id, space_id]).await;
        let (core, _events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
        core.watch_cosmetics(&client, 1);
        let old = json!({ "membership": "join", "displayname": "Alice" });
        let new = json!({ "membership": "join", "displayname": "New Alice" });
        let space = json!({ "membership": "join", "displayname": "Space Alice" });
        serve_state(
            &server,
            room_id,
            json!([state(MEMBER_EVENT, ALICE, &old)]),
            1,
        )
        .await;
        serve_state(
            &server,
            space_id,
            json!([state(MEMBER_EVENT, ALICE, &space)]),
            1,
        )
        .await;
        serve_member(&server, space_id, &space, 0).await;
        let room = client.get_room(room_id).unwrap();
        core.cosmetics_for(&client, &room, Some(space_id.to_owned()))
            .await;

        rename(&server, &client, room_id, &old, &new).await;

        let found = core
            .cosmetics_for(&client, &room, Some(space_id.to_owned()))
            .await;
        assert_eq!(
            found.users[0].space_display_name.as_deref(),
            Some("Space Alice")
        );
    }
}
