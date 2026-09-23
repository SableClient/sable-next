//! MSC2545 image packs: custom emotes and stickers published by an account or
//! a room.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::protocol::{
    ImagePackOriginView, ImagePackView, ImageSourcePackView, ImageUsageView, PackImageInfoView,
    PackImageView,
};

pub const USER_EMOTES: &str = "im.ponies.user_emotes";
pub const ROOM_EMOTES: &str = "im.ponies.room_emotes";
pub const ROOM_IMAGE_PACK: &str = "m.room.image_pack";
pub const EMOTE_ROOMS: &str = "im.ponies.emote_rooms";
pub const IMAGE_PACK_ROOMS: &str = "m.image_pack.rooms";
pub const SPACE_PARENT: &str = "m.space.parent";

const MAX_SPACE_CHAIN: usize = 4;
const STATE_FETCH_CONCURRENCY: usize = 4;
const MAX_CACHED_ROOMS: usize = 256;

#[derive(Debug, Clone, Deserialize)]
pub struct PackContent {
    #[serde(default)]
    pub images: BTreeMap<String, PackImage>,
    pub pack: Option<PackMeta>,
}

impl PackContent {
    #[must_use]
    pub fn is_deleted(&self) -> bool {
        self.images.is_empty() && self.pack.is_none()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackImage {
    pub url: String,
    pub body: Option<String>,
    pub usage: Option<Vec<String>>,
    pub info: Option<PackImageInfo>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackImageInfo {
    #[serde(rename = "w")]
    pub width: Option<u32>,
    #[serde(rename = "h")]
    pub height: Option<u32>,
    pub mimetype: Option<String>,
    pub size: Option<u32>,
}

impl From<PackImageInfo> for PackImageInfoView {
    fn from(info: PackImageInfo) -> Self {
        Self {
            width: info.width,
            height: info.height,
            mimetype: info.mimetype,
            size: info.size,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackMeta {
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub attribution: Option<String>,
    pub usage: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RoomPackEvent {
    #[serde(rename = "type", default)]
    pub event_type: String,
    #[serde(default)]
    pub state_key: String,
    pub content: PackContent,
}

#[derive(Debug, Deserialize)]
pub struct SpaceParentEvent {
    #[serde(rename = "type", default)]
    pub event_type: String,
    #[serde(default)]
    pub state_key: String,
    pub content: SpaceParentContent,
}

#[derive(Debug, Deserialize)]
pub struct SpaceParentContent {
    #[serde(default)]
    pub canonical: bool,
}

/// `im.ponies.emote_rooms`: room id → state key → selection object.
#[derive(Debug, Deserialize)]
pub struct EmoteRooms {
    #[serde(default)]
    pub rooms: BTreeMap<String, BTreeMap<String, serde_json::Value>>,
}

fn usages(declared: Option<&Vec<String>>) -> Vec<ImageUsageView> {
    let mut out = Vec::new();
    for value in declared.into_iter().flatten() {
        match value.as_str() {
            "emoticon" => out.push(ImageUsageView::Emoticon),
            "sticker" => out.push(ImageUsageView::Sticker),
            _ => {}
        }
    }
    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        vec![ImageUsageView::Emoticon, ImageUsageView::Sticker]
    } else {
        out
    }
}

#[must_use]
pub fn pack_view(
    content: PackContent,
    id: String,
    origin: ImagePackOriginView,
    room_id: Option<String>,
) -> ImagePackView {
    let pack_usage = content.pack.as_ref().and_then(|meta| meta.usage.as_ref());
    let images = content
        .images
        .into_iter()
        .filter(|(_, image)| image.url.starts_with("mxc://"))
        .map(|(shortcode, image)| PackImageView {
            source_pack: (origin == ImagePackOriginView::Room)
                .then(|| room_id.clone())
                .flatten()
                .map(|room_id| ImageSourcePackView {
                    room_id,
                    state_key: id.clone(),
                    shortcode: shortcode.clone(),
                    via: Vec::new(),
                }),
            usage: usages(image.usage.as_ref().or(pack_usage)),
            body: image.body,
            info: image.info.map(Into::into),
            url: image.url,
            shortcode,
        })
        .collect();

    ImagePackView {
        id,
        origin,
        room_id,
        name: content
            .pack
            .as_ref()
            .and_then(|meta| meta.display_name.clone()),
        avatar_url: content
            .pack
            .as_ref()
            .and_then(|meta| meta.avatar_url.clone()),
        attribution: content
            .pack
            .as_ref()
            .and_then(|meta| meta.attribution.clone()),
        usage: usages(pack_usage),
        images,
    }
}

use std::collections::{BTreeSet, HashMap};

use futures_util::{StreamExt, future, stream};
use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::ruma::api::client::state::get_state_events;
use matrix_sdk::ruma::events::{
    AnyGlobalAccountDataEventContent, AnyStateEvent, GlobalAccountDataEventType, StateEventType,
};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedRoomId, RoomId};

use crate::Core;
use crate::protocol::{CommandErr, CommandOk};

type AccountDataContent = Option<Raw<AnyGlobalAccountDataEventContent>>;

#[derive(Default)]
pub(crate) struct PackCache {
    account_data: HashMap<String, AccountDataContent>,
    rooms: HashMap<OwnedRoomId, (RoomPackState, u64)>,
    uses: u64,
}

impl PackCache {
    fn room(&mut self, room_id: &RoomId) -> Option<RoomPackState> {
        self.uses += 1;
        let uses = self.uses;
        self.rooms.get_mut(room_id).map(|(state, used)| {
            *used = uses;
            state.clone()
        })
    }

    fn remember_room(&mut self, room_id: OwnedRoomId, state: RoomPackState) {
        self.uses += 1;
        self.rooms.insert(room_id, (state, self.uses));
        if self.rooms.len() > MAX_CACHED_ROOMS
            && let Some(oldest) = self
                .rooms
                .iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(room_id, _)| room_id.clone())
        {
            self.rooms.remove(&oldest);
        }
    }

    pub(crate) fn forget_room(&mut self, room_id: &RoomId, event_type: &str) {
        if event_type == ROOM_EMOTES || event_type == ROOM_IMAGE_PACK {
            self.rooms.remove(room_id);
        }
    }

    pub(crate) fn forget_account_data(&mut self, event_type: &str) {
        self.account_data.remove(event_type);
    }
}

#[derive(Clone, Default)]
struct RoomPackState {
    packs: BTreeMap<String, RoomPackEvent>,
    canonical_parents: Vec<OwnedRoomId>,
}

impl RoomPackState {
    fn from_server(state: &[Raw<AnyStateEvent>]) -> Self {
        let mut parsed = Self::default();
        for raw in state {
            let json = raw.json();
            if let Ok(pack) = serde_json::from_str::<RoomPackEvent>(json.get()) {
                if pack.event_type == ROOM_IMAGE_PACK {
                    parsed.packs.insert(pack.state_key.clone(), pack);
                    continue;
                }
                if pack.event_type == ROOM_EMOTES {
                    parsed.packs.entry(pack.state_key.clone()).or_insert(pack);
                    continue;
                }
            }
            if let Ok(parent) = serde_json::from_str::<SpaceParentEvent>(json.get())
                && parent.event_type == SPACE_PARENT
            {
                push_canonical(&mut parsed.canonical_parents, &parent);
            }
        }
        parsed
    }
}

struct RoomPacks {
    packs: Vec<ImagePackView>,
    canonical_parents: Vec<OwnedRoomId>,
    complete: bool,
}

fn push_canonical(parents: &mut Vec<OwnedRoomId>, event: &SpaceParentEvent) {
    if event.content.canonical
        && let Ok(parent) = RoomId::parse(&event.state_key)
        && !parents.contains(&parent)
    {
        parents.push(parent);
    }
}

impl Core {
    async fn pack_account_data(
        &self,
        client: &matrix_sdk::Client,
        event_type: &str,
        network: bool,
    ) -> Result<(AccountDataContent, bool), matrix_sdk::Error> {
        let wanted = GlobalAccountDataEventType::from(event_type);
        if network {
            match client.account().fetch_account_data(wanted.clone()).await {
                Ok(found) => {
                    self.pack_cache
                        .lock()
                        .await
                        .account_data
                        .insert(event_type.to_owned(), found.clone());
                    return Ok((found, true));
                }
                Err(error) => {
                    tracing::warn!(event_type, %error, "using stored account data after a fetch failed");
                }
            }
        }
        let stored = client.account().account_data_raw(wanted).await?;
        if stored.is_some() {
            return Ok((stored, false));
        }
        let cached = self
            .pack_cache
            .lock()
            .await
            .account_data
            .get(event_type)
            .cloned();
        Ok((cached.flatten(), false))
    }

    async fn subscribed_pack_rooms(
        &self,
        client: &matrix_sdk::Client,
        network: bool,
    ) -> Result<(AccountDataContent, bool), matrix_sdk::Error> {
        let (stable, unstable) = future::join(
            self.pack_account_data(client, IMAGE_PACK_ROOMS, network),
            self.pack_account_data(client, EMOTE_ROOMS, network),
        )
        .await;
        let (stable, stable_complete) = stable?;
        if stable.is_some() {
            return Ok((stable, stable_complete));
        }
        let (unstable, unstable_complete) = unstable?;
        Ok((unstable, stable_complete && unstable_complete))
    }

    pub(crate) async fn image_packs(
        &self,
        room_id: OwnedRoomId,
        cached_only: bool,
    ) -> Result<CommandOk, CommandErr> {
        let client = self.client().await?;
        let network = !cached_only;
        let room = self.room(&room_id).await?;

        let (own, own_room, subscribed) = future::join3(
            self.pack_account_data(&client, USER_EMOTES, network),
            self.room_packs(&client, &room, ImagePackOriginView::Room, None, network),
            self.subscribed_pack_rooms(&client, network),
        )
        .await;
        let (own, own_complete) = own.map_err(|error| self.failed("image_packs_account", error))?;
        let own_room = own_room.map_err(|error| self.failed("image_packs_room", error))?;
        let (subscribed, subscribed_complete) =
            subscribed.map_err(|error| self.failed("image_packs_global", error))?;
        let mut complete = network && own_complete && own_room.complete && subscribed_complete;

        let mut packs = Vec::new();
        if let Some(content) =
            own.and_then(|raw| raw.deserialize_as_unchecked::<PackContent>().ok())
        {
            packs.push(pack_view(
                content,
                String::new(),
                ImagePackOriginView::Account,
                None,
            ));
        }
        packs.extend(own_room.packs);

        let subscribed_rooms: Vec<(matrix_sdk::Room, Vec<String>)> = subscribed
            .and_then(|raw| raw.deserialize_as_unchecked::<EmoteRooms>().ok())
            .map(|rooms| {
                rooms
                    .rooms
                    .into_iter()
                    .filter_map(|(subscribed_id, state_keys)| {
                        let parsed = RoomId::parse(&subscribed_id).ok()?;
                        if parsed == room_id {
                            return None;
                        }
                        let subscribed_room = client.get_room(&parsed)?;
                        Some((subscribed_room, state_keys.into_keys().collect()))
                    })
                    .collect()
            })
            .unwrap_or_default();

        let client = &client;
        let (global, (space, space_complete)) = future::join(
            stream::iter(subscribed_rooms)
                .map(|(subscribed_room, wanted)| async move {
                    let found = self
                        .room_packs(
                            client,
                            &subscribed_room,
                            ImagePackOriginView::Global,
                            Some(&wanted),
                            network,
                        )
                        .await;
                    (subscribed_room.room_id().to_owned(), found)
                })
                .buffered(STATE_FETCH_CONCURRENCY)
                .collect::<Vec<_>>(),
            self.space_packs(client, &room_id, own_room.canonical_parents, network),
        )
        .await;

        for (subscribed_id, found) in global {
            match found {
                Ok(found) => {
                    complete &= found.complete;
                    packs.extend(found.packs);
                }
                Err(error) => {
                    complete = false;
                    tracing::warn!(room = %subscribed_id, %error, "subscribed image packs unreadable");
                }
            }
        }
        complete &= space_complete;
        packs.extend(space);

        let mut seen = BTreeSet::new();
        packs.retain(|pack| seen.insert((pack.room_id.clone(), pack.id.clone())));
        Ok(CommandOk::ImagePacks { packs, complete })
    }

    async fn space_packs(
        &self,
        client: &matrix_sdk::Client,
        room_id: &RoomId,
        parents: Vec<OwnedRoomId>,
        network: bool,
    ) -> (Vec<ImagePackView>, bool) {
        let mut packs = Vec::new();
        let mut complete = true;
        let mut seen: BTreeSet<OwnedRoomId> = BTreeSet::from([room_id.to_owned()]);
        let mut frontier = parents;

        for _ in 0..MAX_SPACE_CHAIN {
            let spaces: Vec<matrix_sdk::Room> = frontier
                .into_iter()
                .filter(|parent_id| seen.insert(parent_id.clone()))
                .filter_map(|parent_id| client.get_room(&parent_id))
                .filter(|space| space.state() == matrix_sdk::RoomState::Joined)
                .collect();
            if spaces.is_empty() {
                break;
            }
            let found: Vec<_> = stream::iter(spaces)
                .map(|space| async move {
                    let found = self
                        .room_packs(client, &space, ImagePackOriginView::Space, None, network)
                        .await;
                    (space.room_id().to_owned(), found)
                })
                .buffered(STATE_FETCH_CONCURRENCY)
                .collect()
                .await;
            let mut next = Vec::new();
            for (space_id, found) in found {
                match found {
                    Ok(found) => {
                        complete &= found.complete;
                        packs.extend(found.packs);
                        next.extend(found.canonical_parents);
                    }
                    Err(error) => {
                        complete = false;
                        tracing::warn!(space = %space_id, %error, "space image packs unreadable");
                    }
                }
            }
            frontier = next;
        }
        (packs, complete)
    }

    pub(crate) async fn all_image_packs(&self) -> Result<CommandOk, CommandErr> {
        let client = self.client().await?;
        let mut packs = Vec::new();

        let (own, _) = self
            .pack_account_data(&client, USER_EMOTES, true)
            .await
            .map_err(|error| self.failed("all_image_packs_account", error))?;
        if let Some(content) =
            own.and_then(|raw| raw.deserialize_as_unchecked::<PackContent>().ok())
        {
            packs.push(pack_view(
                content,
                String::new(),
                ImagePackOriginView::Account,
                None,
            ));
        }

        let client = &client;
        let mut found = stream::iter(client.joined_rooms())
            .map(|room| async move {
                (
                    room.room_id().to_owned(),
                    self.room_packs(client, &room, ImagePackOriginView::Room, None, true)
                        .await,
                )
            })
            .buffer_unordered(STATE_FETCH_CONCURRENCY);
        while let Some((room_id, result)) = found.next().await {
            match result {
                Ok(room_packs) => packs.extend(room_packs.packs),
                Err(error) => {
                    tracing::warn!(room = %room_id, %error, "room image packs unreadable");
                }
            }
        }

        Ok(CommandOk::AllImagePacks { packs })
    }

    async fn room_pack_state(
        &self,
        client: &matrix_sdk::Client,
        room: &matrix_sdk::Room,
        network_fallback: bool,
    ) -> Result<(RoomPackState, bool), matrix_sdk::Error> {
        let mut stored = RoomPackState::default();
        for event_type in [ROOM_EMOTES, ROOM_IMAGE_PACK] {
            for event in &room
                .get_state_events(StateEventType::from(event_type))
                .await?
            {
                let json = match event {
                    RawAnySyncOrStrippedState::Sync(raw) => raw.json(),
                    RawAnySyncOrStrippedState::Stripped(raw) => raw.json(),
                };
                if let Ok(pack) = serde_json::from_str::<RoomPackEvent>(json.get()) {
                    stored.packs.insert(pack.state_key.clone(), pack);
                }
            }
        }
        for event in &room.get_state_events(StateEventType::SpaceParent).await? {
            let json = match event {
                RawAnySyncOrStrippedState::Sync(raw) => raw.json(),
                RawAnySyncOrStrippedState::Stripped(raw) => raw.json(),
            };
            if let Ok(parent) = serde_json::from_str::<SpaceParentEvent>(json.get()) {
                push_canonical(&mut stored.canonical_parents, &parent);
            }
        }

        let cached = self.pack_cache.lock().await.room(room.room_id());
        if network_fallback {
            match client
                .send(get_state_events::v3::Request::new(
                    room.room_id().to_owned(),
                ))
                .await
            {
                Ok(response) => {
                    let state = RoomPackState::from_server(&response.room_state);
                    self.pack_cache
                        .lock()
                        .await
                        .remember_room(room.room_id().to_owned(), state.clone());
                    return Ok((state, true));
                }
                Err(error) if stored.packs.is_empty() && cached.is_none() => {
                    return Err(error.into());
                }
                Err(error) => {
                    tracing::warn!(room = %room.room_id(), %error, "using cached image packs after state refresh failed");
                }
            }
        }
        if stored.packs.is_empty()
            && let Some(cached) = cached
        {
            return Ok((cached, false));
        }
        Ok((stored, false))
    }

    /// `None` takes every pack the room publishes.
    ///
    /// `im.ponies.room_emotes` is not in the SDK's sliding-sync `required_state`
    /// and that list has no extension point, so the store holds these events
    async fn room_packs(
        &self,
        client: &matrix_sdk::Client,
        room: &matrix_sdk::Room,
        origin: ImagePackOriginView,
        wanted: Option<&[String]>,
        network_fallback: bool,
    ) -> Result<RoomPacks, matrix_sdk::Error> {
        let (state, complete) = self.room_pack_state(client, room, network_fallback).await?;

        let mut packs = Vec::new();
        let own_server = client
            .user_id()
            .map(|user_id| user_id.server_name().to_string());
        for (state_key, event) in state.packs {
            if wanted.is_some_and(|keys| !keys.contains(&state_key)) {
                continue;
            }
            if event.content.is_deleted() {
                continue;
            }
            let mut view = pack_view(
                event.content,
                state_key,
                origin,
                Some(room.room_id().to_string()),
            );
            if let Some(server) = &own_server {
                for image in &mut view.images {
                    if let Some(source) = &mut image.source_pack {
                        source.via.push(server.clone());
                    }
                }
            }
            if view.name.is_none() {
                view.name = room.cached_display_name().map(|name| name.to_string());
            }
            if view.avatar_url.is_none() {
                view.avatar_url = room.avatar_url().map(|url| url.to_string());
            }
            packs.push(view);
        }
        Ok(RoomPacks {
            packs,
            canonical_parents: state.canonical_parents,
            complete,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> PackContent {
        serde_json::from_str(json).expect("pack content")
    }

    #[test]
    fn an_image_without_usage_serves_both_tabs() {
        let content = parse(r#"{"images":{"blob":{"url":"mxc://a/b"}}}"#);
        let view = pack_view(content, String::new(), ImagePackOriginView::Account, None);

        assert_eq!(
            view.images[0].usage,
            vec![ImageUsageView::Emoticon, ImageUsageView::Sticker]
        );
    }

    #[test]
    fn a_room_image_carries_its_source_pack() {
        let content = parse(r#"{"images":{"blob":{"url":"mxc://a/b"}}}"#);
        let view = pack_view(
            content,
            "pack".to_owned(),
            ImagePackOriginView::Room,
            Some("!room:example.org".to_owned()),
        );

        assert_eq!(
            view.images[0].source_pack.as_ref().map(|source| (
                source.room_id.as_str(),
                source.state_key.as_str(),
                source.shortcode.as_str(),
            )),
            Some(("!room:example.org", "pack", "blob")),
        );
    }

    #[test]
    fn an_image_usage_overrides_the_pack_usage() {
        let content = parse(
            r#"{"pack":{"usage":["emoticon"]},
                "images":{"wave":{"url":"mxc://a/b"},
                          "party":{"url":"mxc://a/c","usage":["sticker"]}}}"#,
        );
        let view = pack_view(content, String::new(), ImagePackOriginView::Room, None);

        let party = view
            .images
            .iter()
            .find(|image| image.shortcode == "party")
            .expect("party");
        let wave = view
            .images
            .iter()
            .find(|image| image.shortcode == "wave")
            .expect("wave");
        assert_eq!(party.usage, vec![ImageUsageView::Sticker]);
        assert_eq!(wave.usage, vec![ImageUsageView::Emoticon]);
    }

    #[test]
    fn an_unknown_usage_falls_back_rather_than_hiding_the_image() {
        let content = parse(r#"{"images":{"blob":{"url":"mxc://a/b","usage":["reaction"]}}}"#);
        let view = pack_view(content, String::new(), ImagePackOriginView::Account, None);

        assert_eq!(
            view.images[0].usage,
            vec![ImageUsageView::Emoticon, ImageUsageView::Sticker]
        );
    }

    #[test]
    fn an_image_carries_the_info_the_pack_declares() {
        let content = parse(
            r#"{"images":{"blob":{"url":"mxc://a/b",
                "info":{"w":1,"h":2,"mimetype":"image/png","size":3}}}}"#,
        );
        let view = pack_view(content, String::new(), ImagePackOriginView::Account, None);
        let info = view.images[0].info.as_ref().expect("info");

        assert_eq!(info.width, Some(1));
        assert_eq!(info.height, Some(2));
        assert_eq!(info.mimetype.as_deref(), Some("image/png"));
        assert_eq!(info.size, Some(3));
    }

    #[test]
    fn an_image_with_no_declared_info_carries_none() {
        let content = parse(r#"{"images":{"blob":{"url":"mxc://a/b"}}}"#);
        let view = pack_view(content, String::new(), ImagePackOriginView::Account, None);

        assert!(view.images[0].info.is_none());
    }

    #[test]
    fn a_non_mxc_url_is_dropped() {
        let content = parse(
            r#"{"images":{"bad":{"url":"https://example.org/a.png"},
                          "good":{"url":"mxc://a/b"}}}"#,
        );
        let view = pack_view(content, String::new(), ImagePackOriginView::Room, None);

        assert_eq!(view.images.len(), 1);
        assert_eq!(view.images[0].shortcode, "good");
    }

    #[test]
    fn pack_meta_carries_through() {
        let content = parse(
            r#"{"pack":{"display_name":"Blobs","avatar_url":"mxc://a/av","attribution":"CC BY 4.0"},
                "images":{"blob":{"url":"mxc://a/b","body":"blob party"}}}"#,
        );
        let view = pack_view(
            content,
            "blobs".to_owned(),
            ImagePackOriginView::Global,
            Some("!r:example.org".to_owned()),
        );

        assert_eq!(view.name.as_deref(), Some("Blobs"));
        assert_eq!(view.avatar_url.as_deref(), Some("mxc://a/av"));
        assert_eq!(view.attribution.as_deref(), Some("CC BY 4.0"));
        assert_eq!(view.room_id.as_deref(), Some("!r:example.org"));
        assert_eq!(view.images[0].body.as_deref(), Some("blob party"));
    }

    #[test]
    fn an_emptied_state_event_is_a_deleted_pack() {
        assert!(parse("{}").is_deleted());
        assert!(parse(r#"{"images":{}}"#).is_deleted());
        assert!(!parse(r#"{"pack":{"display_name":"Blobs"},"images":{}}"#).is_deleted());
        assert!(!parse(r#"{"images":{"blob":{"url":"mxc://a/b"}}}"#).is_deleted());
    }

    #[test]
    fn a_pack_url_passes_the_sticker_send_guard() {
        for url in ["mxc://sable.chat/AbCd123", "mxc://matrix.org/xyz"] {
            let uri = matrix_sdk::ruma::OwnedMxcUri::from(url);
            assert!(uri.parts().is_ok(), "{url} rejected by the sticker guard");
        }
    }

    #[test]
    fn only_a_canonical_parent_is_walked() {
        let canonical: SpaceParentEvent = serde_json::from_str(
            r#"{"type":"m.space.parent","state_key":"!space:example.org","content":{"canonical":true,"via":["example.org"]}}"#,
        )
        .expect("space parent");
        let secondary: SpaceParentEvent = serde_json::from_str(
            r#"{"type":"m.space.parent","state_key":"!other:example.org","content":{"via":["example.org"]}}"#,
        )
        .expect("space parent");

        let mut parents = Vec::new();
        push_canonical(&mut parents, &canonical);
        push_canonical(&mut parents, &secondary);
        push_canonical(&mut parents, &canonical);

        assert_eq!(parents.len(), 1);
        assert_eq!(parents[0].as_str(), "!space:example.org");
    }

    #[test]
    fn a_parent_that_is_not_a_room_id_is_dropped() {
        let broken: SpaceParentEvent = serde_json::from_str(
            r#"{"type":"m.space.parent","state_key":"","content":{"canonical":true}}"#,
        )
        .expect("space parent");

        let mut parents = Vec::new();
        push_canonical(&mut parents, &broken);

        assert!(parents.is_empty());
    }

    #[test]
    fn emote_rooms_lists_every_subscribed_state_key() {
        let rooms: EmoteRooms = serde_json::from_str(
            r#"{"rooms":{"!a:example.org":{"":{},"extra":{}},"!b:example.org":{"":{}}}}"#,
        )
        .expect("emote rooms");

        assert_eq!(rooms.rooms.len(), 2);
        assert_eq!(rooms.rooms["!a:example.org"].len(), 2);
    }

    fn cached_room(index: usize) -> OwnedRoomId {
        RoomId::parse(format!("!room{index}:example.org")).expect("room id")
    }

    #[test]
    fn the_pack_cache_evicts_the_least_recently_used_room() {
        let mut cache = PackCache::default();
        for index in 0..MAX_CACHED_ROOMS {
            cache.remember_room(cached_room(index), RoomPackState::default());
        }
        assert!(cache.room(&cached_room(0)).is_some());

        cache.remember_room(cached_room(MAX_CACHED_ROOMS), RoomPackState::default());

        assert_eq!(cache.rooms.len(), MAX_CACHED_ROOMS);
        assert!(cache.room(&cached_room(0)).is_some());
        assert!(cache.room(&cached_room(1)).is_none());
    }

    #[test]
    fn writing_a_pack_forgets_only_that_room() {
        let mut cache = PackCache::default();
        cache.remember_room(cached_room(0), RoomPackState::default());
        cache.remember_room(cached_room(1), RoomPackState::default());

        cache.forget_room(&cached_room(0), "m.room.topic");
        assert!(cache.room(&cached_room(0)).is_some());

        cache.forget_room(&cached_room(0), ROOM_IMAGE_PACK);
        assert!(cache.room(&cached_room(0)).is_none());
        assert!(cache.room(&cached_room(1)).is_some());
    }
}

#[cfg(test)]
mod server_tests {
    use std::sync::Arc;

    use matrix_sdk::ruma::room_id;
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;
    use wiremock::matchers::{method, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    use super::{AccountDataContent, PackContent, USER_EMOTES};
    use crate::Core;
    use crate::protocol::ImagePackOriginView;
    use crate::store::MemorySessionStore;

    const ACCOUNT_DATA_PATH: &str =
        r"^/_matrix/client/v3/user/.*/account_data/im\.ponies\.user_emotes$";
    const ROOM_STATE_PATH: &str = r"^/_matrix/client/v3/rooms/.*/state$";

    fn core() -> Arc<Core> {
        Core::new("image-packs", Box::new(MemorySessionStore::default())).0
    }

    fn images(found: AccountDataContent) -> Vec<String> {
        found
            .expect("pack")
            .deserialize_as_unchecked::<PackContent>()
            .expect("content")
            .images
            .into_keys()
            .collect()
    }

    #[tokio::test]
    async fn a_pack_sync_never_delivered_is_read_from_the_server() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let core = core();
        let _get = Mock::given(method("GET"))
            .and(path_regex(ACCOUNT_DATA_PATH))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "images": { "wave": { "url": "mxc://example.org/wave" } }
            })))
            .expect(1)
            .mount_as_scoped(server.server())
            .await;

        let (stored, _) = core
            .pack_account_data(&client, USER_EMOTES, false)
            .await
            .expect("store");
        assert!(stored.is_none());

        let (found, complete) = core
            .pack_account_data(&client, USER_EMOTES, true)
            .await
            .expect("fetch");

        assert!(complete);
        assert_eq!(images(found), ["wave"]);
    }

    #[tokio::test]
    async fn a_refused_fetch_falls_back_to_the_stored_pack() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let core = core();
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_custom_global_account_data(json!({
                    "type": "im.ponies.user_emotes",
                    "content": { "images": { "wave": { "url": "mxc://example.org/wave" } } }
                }));
            })
            .await;
        let _get = Mock::given(method("GET"))
            .and(path_regex(ACCOUNT_DATA_PATH))
            .respond_with(ResponseTemplate::new(500))
            .mount_as_scoped(server.server())
            .await;

        let (found, complete) = core
            .pack_account_data(&client, USER_EMOTES, true)
            .await
            .expect("fetch");

        assert!(!complete);
        assert_eq!(images(found), ["wave"]);
    }

    #[tokio::test]
    async fn a_refused_fetch_falls_back_to_the_last_fetched_pack() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let core = core();
        {
            let _get = Mock::given(method("GET"))
                .and(path_regex(ACCOUNT_DATA_PATH))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "images": { "wave": { "url": "mxc://example.org/wave" } }
                })))
                .mount_as_scoped(server.server())
                .await;
            core.pack_account_data(&client, USER_EMOTES, true)
                .await
                .expect("fetch");
        }
        let _get = Mock::given(method("GET"))
            .and(path_regex(ACCOUNT_DATA_PATH))
            .respond_with(ResponseTemplate::new(500))
            .mount_as_scoped(server.server())
            .await;

        let (found, complete) = core
            .pack_account_data(&client, USER_EMOTES, true)
            .await
            .expect("fallback");

        assert!(!complete);
        assert_eq!(images(found), ["wave"]);
    }

    #[tokio::test]
    async fn a_refused_state_fetch_falls_back_to_the_last_fetched_room_packs() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room = server
            .sync_joined_room(&client, room_id!("!packs:example.org"))
            .await;
        let core = core();
        {
            let _state = Mock::given(method("GET"))
                .and(path_regex(ROOM_STATE_PATH))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!([{
                    "type": "m.room.image_pack",
                    "state_key": "cats",
                    "event_id": "$pack",
                    "room_id": "!packs:example.org",
                    "sender": "@alice:example.org",
                    "origin_server_ts": 1,
                    "content": { "images": { "neocat": { "url": "mxc://example.org/neocat" } } }
                }])))
                .mount_as_scoped(server.server())
                .await;
            let fresh = core
                .room_packs(&client, &room, ImagePackOriginView::Room, None, true)
                .await
                .expect("fetch");
            assert!(fresh.complete);
        }

        let cached = core
            .room_packs(&client, &room, ImagePackOriginView::Room, None, false)
            .await
            .expect("cached");
        assert_eq!(cached.packs.len(), 1);

        let _state = Mock::given(method("GET"))
            .and(path_regex(ROOM_STATE_PATH))
            .respond_with(ResponseTemplate::new(500))
            .mount_as_scoped(server.server())
            .await;
        let fallback = core
            .room_packs(&client, &room, ImagePackOriginView::Room, None, true)
            .await
            .expect("fallback");

        assert!(!fallback.complete);
        assert_eq!(fallback.packs.len(), 1);
        assert_eq!(fallback.packs[0].id, "cats");
    }
}
