//! MSC2545 image packs: custom emotes and stickers published by an account or
//! a room.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::ResultExt;
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

type SpaceParentEvent = crate::space_parents::ParentClaim;

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

    let name = content
        .pack
        .as_ref()
        .and_then(|meta| meta.display_name.clone());
    let avatar_url = content
        .pack
        .as_ref()
        .and_then(|meta| meta.avatar_url.clone());
    ImagePackView {
        id,
        origin,
        room_id,
        declared_name: name.clone(),
        declared_avatar_url: avatar_url.clone(),
        name,
        avatar_url,
        attribution: content
            .pack
            .as_ref()
            .and_then(|meta| meta.attribution.clone()),
        usage: usages(pack_usage),
        images,
        stable_event: false,
        legacy_event: false,
    }
}

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use futures_util::{StreamExt, future, stream};
use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::executor::{JoinHandleExt as _, spawn};
use matrix_sdk::ruma::api::client::state::get_state_events;
use matrix_sdk::ruma::events::{
    AnyGlobalAccountDataEvent, AnyGlobalAccountDataEventContent, AnyStateEvent, AnySyncStateEvent,
    GlobalAccountDataEventType, StateEventType,
};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedRoomId, RoomId};

use crate::Core;
use crate::api::packs::ListOk;
use crate::protocol::{CoreEvent, RpcError};
use tokio::sync::broadcast::error::RecvError;

type AccountDataContent = Option<Raw<AnyGlobalAccountDataEventContent>>;

pub(crate) struct PackCache {
    account_data: HashMap<String, AccountDataContent>,
    rooms: hashlink::LruCache<OwnedRoomId, RoomPackState>,
    /// A fetch that raced a change must not be cached.
    changes: u64,
}

impl Default for PackCache {
    fn default() -> Self {
        Self {
            account_data: HashMap::new(),
            rooms: hashlink::LruCache::new(MAX_CACHED_ROOMS),
            changes: 0,
        }
    }
}

impl PackCache {
    fn room(&mut self, room_id: &RoomId) -> Option<RoomPackState> {
        self.rooms.get(room_id).cloned()
    }

    fn remember_room(&mut self, changes: u64, room_id: OwnedRoomId, state: RoomPackState) {
        if self.changes == changes {
            self.rooms.insert(room_id, state);
        }
    }

    fn remember_account_data(
        &mut self,
        changes: u64,
        event_type: &str,
        content: AccountDataContent,
    ) {
        if self.changes == changes {
            self.account_data.insert(event_type.to_owned(), content);
        }
    }

    pub(crate) fn note_state(
        &mut self,
        room_id: &RoomId,
        event_type: &str,
        state_key: &str,
        content: &serde_json::Value,
    ) {
        match event_type {
            ROOM_EMOTES | ROOM_IMAGE_PACK => {
                self.changes += 1;
                let Some(state) = self.rooms.get_mut(room_id) else {
                    return;
                };
                match PackContent::deserialize(content) {
                    Ok(content) => state.apply(RoomPackEvent {
                        event_type: event_type.to_owned(),
                        state_key: state_key.to_owned(),
                        content,
                    }),
                    Err(_) => {
                        self.rooms.remove(room_id);
                    }
                }
            }
            SPACE_PARENT => {
                self.changes += 1;
                self.rooms.remove(room_id);
            }
            _ => {}
        }
    }

    fn forget_room(&mut self, room_id: &RoomId) {
        self.changes += 1;
        self.rooms.remove(room_id);
    }

    fn forget_rooms(&mut self) {
        self.changes += 1;
        self.rooms.clear();
    }

    pub(crate) fn note_account_data(&mut self, event_type: &str, content: AccountDataContent) {
        self.changes += 1;
        self.account_data.insert(event_type.to_owned(), content);
    }

    pub(crate) fn forget_account_data(&mut self, event_type: &str) {
        self.changes += 1;
        self.account_data.remove(event_type);
    }
}

#[derive(Clone, Default)]
struct RoomPackState {
    packs: BTreeMap<String, RoomPackEvent>,
    legacy: BTreeSet<String>,
    canonical_parents: Vec<SpaceParentEvent>,
}

impl RoomPackState {
    fn note_legacy(&mut self, pack: &RoomPackEvent) {
        if pack.event_type == ROOM_EMOTES && !pack.content.is_deleted() {
            self.legacy.insert(pack.state_key.clone());
        }
    }

    fn apply(&mut self, pack: RoomPackEvent) {
        if pack.event_type == ROOM_IMAGE_PACK {
            self.packs.insert(pack.state_key.clone(), pack);
            return;
        }
        if pack.content.is_deleted() {
            self.legacy.remove(&pack.state_key);
        }
        self.note_legacy(&pack);
        if self
            .packs
            .get(&pack.state_key)
            .is_none_or(|current| current.event_type != ROOM_IMAGE_PACK)
        {
            self.packs.insert(pack.state_key.clone(), pack);
        }
    }

    fn from_server(state: &[Raw<AnyStateEvent>]) -> Self {
        let mut parsed = Self::default();
        for raw in state {
            let json = raw.json();
            if let Ok(pack) = serde_json::from_str::<RoomPackEvent>(json.get())
                && (pack.event_type == ROOM_IMAGE_PACK || pack.event_type == ROOM_EMOTES)
            {
                parsed.apply(pack);
                continue;
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

fn push_canonical(parents: &mut Vec<SpaceParentEvent>, event: &SpaceParentEvent) {
    if event.content.canonical
        && event.room_id().is_some()
        && !parents
            .iter()
            .any(|parent| parent.state_key == event.state_key)
    {
        parents.push(event.clone());
    }
}

impl Core {
    pub(crate) fn watch_image_packs(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        generation: u64,
    ) {
        let handle = client.add_event_handler({
            let core = self.clone();
            move |raw: Raw<AnySyncStateEvent>, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    let kind = raw.get_field::<String>("type").ok().flatten();
                    if let Some(kind) = kind.as_deref()
                        && matches!(kind, ROOM_EMOTES | ROOM_IMAGE_PACK | SPACE_PARENT)
                    {
                        let state_key = raw
                            .get_field::<String>("state_key")
                            .ok()
                            .flatten()
                            .unwrap_or_default();
                        let content = raw
                            .get_field::<serde_json::Value>("content")
                            .ok()
                            .flatten()
                            .unwrap_or_default();
                        core.pack_cache.lock().await.note_state(
                            room.room_id(),
                            kind,
                            &state_key,
                            &content,
                        );
                    }
                    if matches!(kind.as_deref(), Some(ROOM_EMOTES | ROOM_IMAGE_PACK)) {
                        core.emit_if_current(
                            generation,
                            CoreEvent::ImagePacksChanged {
                                room_id: room.room_id().to_owned(),
                            },
                        );
                    }
                }
            }
        });
        self.track_session_handler(client, handle);

        let handle = client.add_event_handler({
            let core = self.clone();
            move |raw: Raw<AnyGlobalAccountDataEvent>| {
                let core = core.clone();
                async move {
                    let Some(event_type) = raw.get_field::<String>("type").ok().flatten() else {
                        return;
                    };
                    if matches!(
                        event_type.as_str(),
                        USER_EMOTES | EMOTE_ROOMS | IMAGE_PACK_ROOMS
                    ) {
                        let content = raw.get_field("content").ok().flatten();
                        core.pack_cache
                            .lock()
                            .await
                            .note_account_data(&event_type, content);
                    }
                }
            }
        });
        self.track_session_handler(client, handle);

        let core = self.clone();
        let mut updates = client.subscribe_to_all_room_updates();
        self.track_session_task(
            spawn(async move {
                loop {
                    match updates.recv().await {
                        Ok(updates) => {
                            let mut cache = core.pack_cache.lock().await;
                            for (room_id, update) in &updates.joined {
                                if update.timeline.limited {
                                    cache.forget_room(room_id);
                                }
                            }
                        }
                        Err(RecvError::Lagged(_)) => core.pack_cache.lock().await.forget_rooms(),
                        Err(RecvError::Closed) => break,
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    async fn pack_account_data(
        &self,
        client: &matrix_sdk::Client,
        event_type: &str,
        network: bool,
    ) -> Result<(AccountDataContent, bool), matrix_sdk::Error> {
        let changes = {
            let cache = self.pack_cache.lock().await;
            if let Some(cached) = cache.account_data.get(event_type) {
                return Ok((cached.clone(), true));
            }
            cache.changes
        };
        let wanted = GlobalAccountDataEventType::from(event_type);
        if network {
            match client.account().fetch_account_data(wanted.clone()).await {
                Ok(found) => {
                    self.pack_cache.lock().await.remember_account_data(
                        changes,
                        event_type,
                        found.clone(),
                    );
                    return Ok((found, true));
                }
                Err(error) => {
                    tracing::warn!(event_type, %error, "using stored account data after a fetch failed");
                }
            }
        }
        let stored = self
            .with_open_stores(async || client.account().account_data_raw(wanted).await)
            .await?;
        Ok((stored, false))
    }

    pub(crate) async fn subscribed_pack_rooms(
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
    ) -> Result<ListOk, RpcError> {
        let client = self.client().await?;
        let network = !cached_only;
        let room = self.room(&room_id).await?;

        let (own, own_room, subscribed) = future::join3(
            self.pack_account_data(&client, USER_EMOTES, network),
            self.room_packs(&client, &room, ImagePackOriginView::Room, None, network),
            self.subscribed_pack_rooms(&client, network),
        )
        .await;
        let (own, own_complete) = own.or_failed(self, "image_packs_account")?;
        let own_room = own_room.or_failed(self, "image_packs_room")?;
        let (subscribed, subscribed_complete) = subscribed.or_failed(self, "image_packs_global")?;
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

        let subscribed_rooms: Vec<(matrix_sdk::Room, Vec<String>)> = subscribed
            .and_then(|raw| raw.deserialize_as_unchecked::<EmoteRooms>().ok())
            .map(|rooms| {
                rooms
                    .rooms
                    .into_iter()
                    .filter_map(|(subscribed_id, state_keys)| {
                        let parsed = RoomId::parse(&subscribed_id).ok()?;
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
        packs.extend(own_room.packs);
        complete &= space_complete;
        packs.extend(space);

        let mut seen = BTreeSet::new();
        packs.retain(|pack| seen.insert((pack.room_id.clone(), pack.id.clone())));
        Ok(ListOk { packs, complete })
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
        let listing = crate::view::listing_spaces(Some(self), client, room_id).await;
        let mut frontier = if listing.is_empty() { parents } else { listing };
        frontier.extend(Self::synced_dm_spaces_of(client, room_id).await);

        for _ in 0..MAX_SPACE_CHAIN {
            let spaces: Vec<matrix_sdk::Room> = frontier
                .into_iter()
                .filter(|parent_id| seen.insert(parent_id.clone()))
                .filter_map(|parent_id| client.get_room(&parent_id))
                .filter(|space| {
                    space.state() == matrix_sdk::RoomState::Joined && !space.is_tombstoned()
                })
                .collect();
            if spaces.is_empty() {
                break;
            }
            let found: Vec<_> = stream::iter(spaces)
                .map(|space| async move {
                    let found = self
                        .room_packs(client, &space, ImagePackOriginView::Space, None, network)
                        .await;
                    let listed_in =
                        crate::view::listing_spaces(Some(self), client, space.room_id()).await;
                    (space.room_id().to_owned(), found, listed_in)
                })
                .buffered(STATE_FETCH_CONCURRENCY)
                .collect()
                .await;
            let mut next = Vec::new();
            for (space_id, found, listed_in) in found {
                let listed = !listed_in.is_empty();
                next.extend(listed_in);
                match found {
                    Ok(found) => {
                        complete &= found.complete;
                        packs.extend(found.packs);
                        if !listed {
                            next.extend(found.canonical_parents);
                        }
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

    pub(crate) async fn all_image_packs(&self) -> Result<Vec<ImagePackView>, RpcError> {
        let client = self.client().await?;
        let mut packs = Vec::new();

        let (own, _) = self
            .pack_account_data(&client, USER_EMOTES, true)
            .await
            .or_failed(self, "all_image_packs_account")?;
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
                    self.room_packs(client, &room, ImagePackOriginView::Room, None, false)
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

        Ok(packs)
    }

    pub(crate) async fn copy_room_packs(
        &self,
        client: &matrix_sdk::Client,
        from: &RoomId,
        to: &RoomId,
    ) {
        let events = match client
            .send(get_state_events::v3::Request::new(from.to_owned()))
            .await
        {
            Ok(response) => response.room_state,
            Err(error) => {
                tracing::warn!(room = %from, %error, "image packs not copied to the upgraded room");
                return;
            }
        };
        for event in events {
            let Ok(value) = event.deserialize_as_unchecked::<serde_json::Value>() else {
                continue;
            };
            let event_type = value
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or_default();
            let Some(content) = value.get("content").filter(|content| {
                [ROOM_EMOTES, ROOM_IMAGE_PACK].contains(&event_type)
                    && content.as_object().is_some_and(|map| !map.is_empty())
            }) else {
                continue;
            };
            let state_key = value
                .get("state_key")
                .and_then(|k| k.as_str())
                .unwrap_or_default();
            let Ok(body) = Raw::new(content).map(Raw::cast_unchecked) else {
                continue;
            };
            let request =
                matrix_sdk::ruma::api::client::state::send_state_event::v3::Request::new_raw(
                    to.to_owned(),
                    StateEventType::from(event_type),
                    state_key.to_owned(),
                    body,
                );
            if let Err(error) = client.send(request).await {
                tracing::warn!(room = %to, event_type, %error, "image pack not copied to the upgraded room");
            }
        }
    }

    async fn room_pack_state(
        &self,
        client: &matrix_sdk::Client,
        room: &matrix_sdk::Room,
        network_fallback: bool,
    ) -> Result<(RoomPackState, bool), matrix_sdk::Error> {
        let changes = {
            let mut cache = self.pack_cache.lock().await;
            if let Some(cached) = cache.room(room.room_id()) {
                return Ok((cached, true));
            }
            cache.changes
        };
        let mut stored = RoomPackState::default();
        for event_type in [ROOM_EMOTES, ROOM_IMAGE_PACK] {
            for event in &self
                .with_open_stores(async || {
                    room.get_state_events(StateEventType::from(event_type))
                        .await
                })
                .await?
            {
                let json = match event {
                    RawAnySyncOrStrippedState::Sync(raw) => raw.json(),
                    RawAnySyncOrStrippedState::Stripped(raw) => raw.json(),
                };
                if let Ok(pack) = serde_json::from_str::<RoomPackEvent>(json.get()) {
                    stored.note_legacy(&pack);
                    stored.packs.insert(pack.state_key.clone(), pack);
                }
            }
        }
        for event in &self
            .with_open_stores(async || room.get_state_events(StateEventType::SpaceParent).await)
            .await?
        {
            let json = match event {
                RawAnySyncOrStrippedState::Sync(raw) => raw.json(),
                RawAnySyncOrStrippedState::Stripped(raw) => raw.json(),
            };
            if let Ok(parent) = serde_json::from_str::<SpaceParentEvent>(json.get()) {
                push_canonical(&mut stored.canonical_parents, &parent);
            }
        }

        if network_fallback {
            match self.room_state_snapshot(client, room.room_id()).await {
                Ok(snapshot) => {
                    let state = RoomPackState::from_server(&snapshot);
                    self.pack_cache.lock().await.remember_room(
                        changes,
                        room.room_id().to_owned(),
                        state.clone(),
                    );
                    return Ok((state, true));
                }
                Err(error) if stored.packs.is_empty() => return Err(error),
                Err(error) => {
                    tracing::warn!(room = %room.room_id(), %error, "using stored image packs after state refresh failed");
                }
            }
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
            let stable_event = event.event_type == ROOM_IMAGE_PACK;
            let legacy_event = state.legacy.contains(&state_key);
            let mut view = pack_view(
                event.content,
                state_key,
                origin,
                Some(room.room_id().to_string()),
            );
            view.stable_event = stable_event;
            view.legacy_event = legacy_event;
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
            canonical_parents: crate::space_parents::validate(
                self,
                client,
                room.room_id(),
                &state.canonical_parents,
                network_fallback,
            )
            .await
            .into_iter()
            .filter_map(|parent| parent.room_id())
            .collect(),
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
    fn only_a_canonical_parent_is_walked() {
        let canonical: SpaceParentEvent = serde_json::from_str(
            r#"{"type":"m.space.parent","state_key":"!space:example.org","sender":"@alice:example.org","content":{"canonical":true,"via":["example.org"]}}"#,
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
        assert_eq!(parents[0].state_key.as_str(), "!space:example.org");
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
            cache.remember_room(0, cached_room(index), RoomPackState::default());
        }
        assert!(cache.room(&cached_room(0)).is_some());

        cache.remember_room(0, cached_room(MAX_CACHED_ROOMS), RoomPackState::default());

        assert_eq!(cache.rooms.len(), MAX_CACHED_ROOMS);
        assert!(cache.room(&cached_room(0)).is_some());
        assert!(cache.room(&cached_room(1)).is_none());
    }

    fn pack_ids(cache: &mut PackCache, room: usize) -> Vec<(String, String)> {
        cache
            .room(&cached_room(room))
            .expect("cached room")
            .packs
            .into_values()
            .map(|pack| (pack.state_key, pack.event_type))
            .collect()
    }

    #[test]
    fn a_pack_edit_patches_only_that_room() {
        let mut cache = PackCache::default();
        cache.remember_room(0, cached_room(0), RoomPackState::default());
        cache.remember_room(0, cached_room(1), RoomPackState::default());
        let pack = serde_json::json!({"images": {"wave": {"url": "mxc://a/b"}}});

        cache.note_state(&cached_room(0), "m.room.topic", "", &pack);
        cache.note_state(&cached_room(0), ROOM_IMAGE_PACK, "cats", &pack);

        assert_eq!(
            pack_ids(&mut cache, 0),
            [("cats".to_owned(), ROOM_IMAGE_PACK.to_owned())]
        );
        assert_eq!(pack_ids(&mut cache, 1), []);
    }

    #[test]
    fn a_legacy_edit_does_not_replace_the_stable_pack() {
        let mut cache = PackCache::default();
        cache.remember_room(0, cached_room(0), RoomPackState::default());
        let pack = serde_json::json!({"images": {"wave": {"url": "mxc://a/b"}}});

        cache.note_state(&cached_room(0), ROOM_IMAGE_PACK, "cats", &pack);
        cache.note_state(&cached_room(0), ROOM_EMOTES, "cats", &pack);
        assert_eq!(
            pack_ids(&mut cache, 0),
            [("cats".to_owned(), ROOM_IMAGE_PACK.to_owned())]
        );
        assert!(
            cache
                .room(&cached_room(0))
                .expect("room")
                .legacy
                .contains("cats")
        );

        cache.note_state(&cached_room(0), ROOM_EMOTES, "cats", &serde_json::json!({}));
        assert!(cache.room(&cached_room(0)).expect("room").legacy.is_empty());
    }

    #[test]
    fn a_new_space_parent_drops_the_room() {
        let mut cache = PackCache::default();
        cache.remember_room(0, cached_room(0), RoomPackState::default());

        cache.note_state(
            &cached_room(0),
            SPACE_PARENT,
            "!space:example.org",
            &serde_json::json!({}),
        );

        assert!(cache.room(&cached_room(0)).is_none());
    }

    #[test]
    fn a_fetch_that_raced_a_change_is_not_kept() {
        let mut cache = PackCache::default();
        let before = cache.changes;
        cache.note_account_data(USER_EMOTES, None);

        cache.remember_room(before, cached_room(0), RoomPackState::default());
        cache.remember_account_data(before, EMOTE_ROOMS, None);

        assert!(cache.room(&cached_room(0)).is_none());
        assert!(!cache.account_data.contains_key(EMOTE_ROOMS));
    }
}

#[cfg(test)]
mod server_tests {
    use std::sync::Arc;

    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk::ruma::{OwnedRoomId, RoomId, room_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;
    use wiremock::matchers::{method, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    use super::{AccountDataContent, PackContent, USER_EMOTES};
    use crate::Core;
    use crate::protocol::{CoreEvent, ImagePackOriginView};
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
    async fn globally_selected_packs_precede_room_packs_including_the_current_room() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!room:example.org");
        let global_id = room_id!("!global:example.org");
        let pack = |key: &str| {
            Raw::new(&json!({
                "type": "m.room.image_pack", "state_key": key, "event_id": format!("${key}"),
                "sender": "@alice:example.org", "origin_server_ts": 1,
                "content": {"images": {"wave": {"url": format!("mxc://example.org/{key}")}}}
            }))
            .unwrap()
            .cast_unchecked()
        };
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_state_bulk([pack("local"), pack("selected")]),
            )
            .await;
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(global_id).add_state_event(pack("global")),
            )
            .await;
        server
            .mock_sync()
            .ok_and_run(&client, |sync| {
                sync.add_custom_global_account_data(json!({
                    "type": "m.image_pack.rooms", "content": {"rooms": {
                        room_id: {"selected": {}}, global_id: {"global": {}}
                    }}
                }));
            })
            .await;
        let core = core();
        let service = Arc::new(
            matrix_sdk_ui::sync_service::SyncService::builder(client.clone())
                .build()
                .await
                .unwrap(),
        );
        *core.session.write().await = Some(crate::session::Session {
            account_id: "a1".to_owned(),
            client,
            sync_service: service,
            homeserver: server.server().uri(),
            oauth: false,
        });
        let crate::api::packs::ListOk { packs, .. } =
            core.image_packs(room_id.to_owned(), true).await.unwrap();
        assert_eq!(
            packs
                .iter()
                .map(|pack| (pack.id.as_str(), pack.origin))
                .collect::<Vec<_>>(),
            [
                ("global", ImagePackOriginView::Global),
                ("selected", ImagePackOriginView::Global),
                ("local", ImagePackOriginView::Room)
            ]
        );
    }

    #[tokio::test]
    async fn a_replaced_space_does_not_offer_its_packs() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!room:example.org");
        let live = room_id!("!live:example.org");
        let old = room_id!("!old:example.org");
        let state = |event_type: &str, key: &str, content: serde_json::Value| {
            Raw::new(&json!({
                "type": event_type, "state_key": key, "event_id": format!("${event_type}{key}"),
                "sender": "@alice:example.org", "origin_server_ts": 1, "content": content
            }))
            .unwrap()
            .cast_unchecked()
        };
        let space = |id: &RoomId, key: &str, tombstoned: bool| {
            let mut events = vec![
                state(
                    "m.room.create",
                    "",
                    json!({"type": "m.space", "room_version": "11"}),
                ),
                state(
                    "m.space.child",
                    room_id.as_str(),
                    json!({"via": ["example.org"]}),
                ),
                state(
                    "m.room.image_pack",
                    key,
                    json!({"images": {"wave": {"url": "mxc://example.org/wave"}}}),
                ),
            ];
            if tombstoned {
                events.push(state(
                    "m.room.tombstone",
                    "",
                    json!({"body": "", "replacement_room": "!new:example.org"}),
                ));
            }
            JoinedRoomBuilder::new(id).add_state_bulk(events)
        };
        server
            .sync_room(&client, JoinedRoomBuilder::new(room_id))
            .await;
        server.sync_room(&client, space(live, "live", false)).await;
        server.sync_room(&client, space(old, "old", true)).await;
        let core = core();
        let service = Arc::new(
            matrix_sdk_ui::sync_service::SyncService::builder(client.clone())
                .build()
                .await
                .unwrap(),
        );
        *core.session.write().await = Some(crate::session::Session {
            account_id: "a1".to_owned(),
            client,
            sync_service: service,
            homeserver: server.server().uri(),
            oauth: false,
        });
        let crate::api::packs::ListOk { packs, .. } =
            core.image_packs(room_id.to_owned(), true).await.unwrap();
        assert_eq!(
            packs
                .iter()
                .map(|pack| (pack.id.as_str(), pack.origin))
                .collect::<Vec<_>>(),
            [("live", ImagePackOriginView::Space)]
        );
    }

    #[tokio::test]
    async fn a_room_pack_keeps_its_declared_meta_and_reports_both_formats() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!room:example.org");
        let state = |event_type: &str, key: &str, content: serde_json::Value| {
            Raw::new(&json!({
                "type": event_type, "state_key": key, "event_id": format!("${event_type}{key}"),
                "sender": "@alice:example.org", "origin_server_ts": 1, "content": content
            }))
            .unwrap()
            .cast_unchecked()
        };
        let images = json!({"wave": {"url": "mxc://example.org/wave"}});
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_state_bulk([
                    state("m.room.name", "", json!({"name": "Neo"})),
                    state(
                        "m.room.avatar",
                        "",
                        json!({"url": "mxc://example.org/room"}),
                    ),
                    state("im.ponies.room_emotes", "old", json!({"images": images})),
                    state("im.ponies.room_emotes", "both", json!({"images": images})),
                    state("m.room.image_pack", "both", json!({"images": images})),
                    state(
                        "m.room.image_pack",
                        "new",
                        json!({"pack": {"avatar_url": "mxc://example.org/cat"}, "images": images}),
                    ),
                ]),
            )
            .await;
        let core = core();
        let service = Arc::new(
            matrix_sdk_ui::sync_service::SyncService::builder(client.clone())
                .build()
                .await
                .unwrap(),
        );
        *core.session.write().await = Some(crate::session::Session {
            account_id: "a1".to_owned(),
            client,
            sync_service: service,
            homeserver: server.server().uri(),
            oauth: false,
        });
        let crate::api::packs::ListOk { packs, .. } =
            core.image_packs(room_id.to_owned(), true).await.unwrap();
        let summary = packs
            .iter()
            .map(|pack| {
                (
                    pack.id.as_str(),
                    pack.avatar_url.as_deref(),
                    pack.declared_avatar_url.as_deref(),
                    pack.declared_name.as_deref(),
                    pack.stable_event,
                    pack.legacy_event,
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            [
                (
                    "both",
                    Some("mxc://example.org/room"),
                    None,
                    None,
                    true,
                    true
                ),
                (
                    "new",
                    Some("mxc://example.org/cat"),
                    Some("mxc://example.org/cat"),
                    None,
                    true,
                    false
                ),
                (
                    "old",
                    Some("mxc://example.org/room"),
                    None,
                    None,
                    false,
                    true
                ),
            ]
        );
        assert!(packs.iter().all(|pack| pack.name.as_deref() == Some("Neo")));
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
    async fn a_fetched_pack_is_served_without_another_request() {
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
            .expect(0)
            .mount_as_scoped(server.server())
            .await;

        let (found, complete) = core
            .pack_account_data(&client, USER_EMOTES, true)
            .await
            .expect("cached");

        assert!(complete);
        assert_eq!(images(found), ["wave"]);
    }

    #[tokio::test]
    async fn fetched_room_packs_are_served_without_another_request() {
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

        *core.recent_state.lock() = crate::probed_state::RecentState::default();
        let _state = Mock::given(method("GET"))
            .and(path_regex(ROOM_STATE_PATH))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount_as_scoped(server.server())
            .await;
        let again = core
            .room_packs(&client, &room, ImagePackOriginView::Room, None, true)
            .await
            .expect("cached");

        assert!(again.complete);
        assert_eq!(again.packs.len(), 1);
        assert_eq!(again.packs[0].id, "cats");
    }

    #[tokio::test]
    async fn a_synced_pack_edit_is_announced() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!space:example.org");
        server.sync_joined_room(&client, room_id).await;
        let (core, mut events) = Core::new("image-packs", Box::new(MemorySessionStore::default()));
        core.watch_image_packs(&client, 1);

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_timeline_event(
                        Raw::new(&json!({
                            "type": "m.room.image_pack",
                            "state_key": "cats",
                            "event_id": "$pack",
                            "sender": "@alice:example.org",
                            "origin_server_ts": 1,
                            "content": { "images": { "neocat": { "url": "mxc://example.org/neocat" } } }
                        }))
                        .unwrap()
                        .cast_unchecked(),
                    )
                    .add_timeline_event(
                        Raw::new(&json!({
                            "type": "m.room.topic",
                            "state_key": "",
                            "event_id": "$topic",
                            "sender": "@alice:example.org",
                            "origin_server_ts": 2,
                            "content": { "topic": "cats" }
                        }))
                        .unwrap()
                        .cast_unchecked(),
                    ),
            )
            .await;

        let announced: Vec<OwnedRoomId> = std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|event| match event {
                CoreEvent::ImagePacksChanged { room_id } => Some(room_id),
                _ => None,
            })
            .collect();
        assert_eq!(announced, [room_id.to_owned()]);
    }
}
