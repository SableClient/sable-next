//! MSC2545 image packs: custom emotes and stickers published by an account or
//! a room.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::protocol::{
    ImagePackOriginView, ImagePackView, ImageUsageView, PackImageInfoView, PackImageView,
};

pub const USER_EMOTES: &str = "im.ponies.user_emotes";
pub const ROOM_EMOTES: &str = "im.ponies.room_emotes";
pub const ROOM_IMAGE_PACK: &str = "m.room.image_pack";
pub const EMOTE_ROOMS: &str = "im.ponies.emote_rooms";
pub const IMAGE_PACK_ROOMS: &str = "m.image_pack.rooms";
pub const SPACE_PARENT: &str = "m.space.parent";

const MAX_SPACE_CHAIN: usize = 4;
const STATE_FETCH_CONCURRENCY: usize = 4;

#[derive(Debug, Deserialize)]
pub struct PackContent {
    #[serde(default)]
    pub images: BTreeMap<String, PackImage>,
    pub pack: Option<PackMeta>,
}

#[derive(Debug, Deserialize)]
pub struct PackImage {
    pub url: String,
    pub body: Option<String>,
    pub usage: Option<Vec<String>>,
    pub info: Option<PackImageInfo>,
}

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
pub struct PackMeta {
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub attribution: Option<String>,
    pub usage: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
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
        images,
    }
}

use std::collections::BTreeSet;

use futures_util::{StreamExt, stream};
use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::ruma::api::client::state::get_state_events;
use matrix_sdk::ruma::events::{GlobalAccountDataEventType, StateEventType};
use matrix_sdk::ruma::{OwnedRoomId, RoomId};

use crate::Core;
use crate::protocol::{CommandErr, CommandOk};

struct RoomPacks {
    packs: Vec<ImagePackView>,
    canonical_parents: Vec<OwnedRoomId>,
}

fn push_canonical(parents: &mut Vec<OwnedRoomId>, event: &SpaceParentEvent) {
    if !event.content.canonical {
        return;
    }
    let Ok(parent) = RoomId::parse(&event.state_key) else {
        return;
    };
    if !parents.contains(&parent) {
        parents.push(parent);
    }
}

impl Core {
    pub(crate) async fn image_packs(&self, room_id: OwnedRoomId) -> Result<CommandOk, CommandErr> {
        let client = self.client().await?;
        let mut packs = Vec::new();

        let own = client
            .account()
            .account_data_raw(GlobalAccountDataEventType::from(USER_EMOTES))
            .await
            .map_err(|error| self.failed("image_packs_account", error))?;
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

        let room = self.room(&room_id).await?;
        let own_room = Self::room_packs(&client, &room, ImagePackOriginView::Room, None, true)
            .await
            .map_err(|error| self.failed("image_packs_room", error))?;
        packs.extend(own_room.packs);

        let mut subscribed = client
            .account()
            .account_data_raw(GlobalAccountDataEventType::from(IMAGE_PACK_ROOMS))
            .await
            .map_err(|error| self.failed("image_packs_global", error))?;
        if subscribed.is_none() {
            subscribed = client
                .account()
                .account_data_raw(GlobalAccountDataEventType::from(EMOTE_ROOMS))
                .await
                .map_err(|error| self.failed("image_packs_global", error))?;
        }
        if let Some(rooms) =
            subscribed.and_then(|raw| raw.deserialize_as_unchecked::<EmoteRooms>().ok())
        {
            for (subscribed_id, state_keys) in rooms.rooms {
                let Ok(parsed) = RoomId::parse(&subscribed_id) else {
                    continue;
                };
                if parsed == room_id {
                    continue;
                }
                let Some(subscribed_room) = client.get_room(&parsed) else {
                    continue;
                };
                let wanted: Vec<String> = state_keys.into_keys().collect();
                packs.extend(
                    Self::room_packs(
                        &client,
                        &subscribed_room,
                        ImagePackOriginView::Global,
                        Some(&wanted),
                        true,
                    )
                    .await
                    .map_err(|error| self.failed("image_packs_global_room", error))?
                    .packs,
                );
            }
        }

        packs.extend(
            self.space_packs(&client, &room_id, own_room.canonical_parents)
                .await,
        );

        let mut seen = BTreeSet::new();
        packs.retain(|pack| {
            !pack.images.is_empty() && seen.insert((pack.room_id.clone(), pack.id.clone()))
        });
        Ok(CommandOk::ImagePacks { packs })
    }

    async fn space_packs(
        &self,
        client: &matrix_sdk::Client,
        room_id: &RoomId,
        parents: Vec<OwnedRoomId>,
    ) -> Vec<ImagePackView> {
        let mut packs = Vec::new();
        let mut seen: BTreeSet<OwnedRoomId> = BTreeSet::from([room_id.to_owned()]);
        let mut frontier = parents;

        for _ in 0..MAX_SPACE_CHAIN {
            if frontier.is_empty() {
                break;
            }
            let mut next = Vec::new();
            for parent_id in frontier {
                if !seen.insert(parent_id.clone()) {
                    continue;
                }
                let Some(space) = client.get_room(&parent_id) else {
                    continue;
                };
                if space.state() != matrix_sdk::RoomState::Joined {
                    continue;
                }
                match Self::room_packs(client, &space, ImagePackOriginView::Space, None, true).await
                {
                    Ok(found) => {
                        packs.extend(found.packs);
                        next.extend(found.canonical_parents);
                    }
                    Err(error) => {
                        tracing::warn!(space = %parent_id, %error, "space image packs unreadable");
                    }
                }
            }
            frontier = next;
        }
        packs
    }

    pub(crate) async fn all_image_packs(&self) -> Result<CommandOk, CommandErr> {
        let client = self.client().await?;
        let mut packs = Vec::new();

        let own = client
            .account()
            .account_data_raw(GlobalAccountDataEventType::from(USER_EMOTES))
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

        let rooms = client.joined_rooms();
        let mut found = stream::iter(rooms.iter())
            .map(|room| {
                let client = client.clone();
                async move {
                    (
                        room.room_id().to_owned(),
                        Self::room_packs(&client, room, ImagePackOriginView::Room, None, true)
                            .await,
                    )
                }
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

        packs.retain(|pack| pack.origin == ImagePackOriginView::Account || !pack.images.is_empty());
        Ok(CommandOk::AllImagePacks { packs })
    }

    /// `None` takes every pack the room publishes.
    ///
    /// `im.ponies.room_emotes` is not in the SDK's sliding-sync `required_state`
    /// and that list has no extension point, so the store holds these events
    /// only by luck. A room with none falls back to `/state` on the server.
    async fn room_packs(
        client: &matrix_sdk::Client,
        room: &matrix_sdk::Room,
        origin: ImagePackOriginView,
        wanted: Option<&[String]>,
        network_fallback: bool,
    ) -> Result<RoomPacks, matrix_sdk::Error> {
        let mut parsed: BTreeMap<String, RoomPackEvent> = BTreeMap::new();
        for event_type in [ROOM_EMOTES, ROOM_IMAGE_PACK] {
            let stored = room
                .get_state_events(StateEventType::from(event_type))
                .await?;
            for event in &stored {
                let json = match event {
                    RawAnySyncOrStrippedState::Sync(raw) => raw.json(),
                    RawAnySyncOrStrippedState::Stripped(raw) => raw.json(),
                };
                if let Ok(pack) = serde_json::from_str::<RoomPackEvent>(json.get()) {
                    parsed.insert(pack.state_key.clone(), pack);
                }
            }
        }

        let mut canonical_parents = Vec::new();
        for event in &room.get_state_events(StateEventType::SpaceParent).await? {
            let json = match event {
                RawAnySyncOrStrippedState::Sync(raw) => raw.json(),
                RawAnySyncOrStrippedState::Stripped(raw) => raw.json(),
            };
            if let Ok(parent) = serde_json::from_str::<SpaceParentEvent>(json.get()) {
                push_canonical(&mut canonical_parents, &parent);
            }
        }

        if parsed.is_empty() && network_fallback {
            let response = client
                .send(get_state_events::v3::Request::new(
                    room.room_id().to_owned(),
                ))
                .await?;
            for raw in &response.room_state {
                let json = raw.json();
                if let Ok(pack) = serde_json::from_str::<RoomPackEvent>(json.get()) {
                    if pack.event_type == ROOM_IMAGE_PACK {
                        parsed.insert(pack.state_key.clone(), pack);
                        continue;
                    }
                    if pack.event_type == ROOM_EMOTES {
                        parsed.entry(pack.state_key.clone()).or_insert(pack);
                        continue;
                    }
                }
                if let Ok(parent) = serde_json::from_str::<SpaceParentEvent>(json.get())
                    && parent.event_type == SPACE_PARENT
                {
                    push_canonical(&mut canonical_parents, &parent);
                }
            }
        }

        let mut packs = Vec::new();
        for (state_key, event) in parsed {
            if wanted.is_some_and(|keys| !keys.contains(&state_key)) {
                continue;
            }
            let mut view = pack_view(
                event.content,
                state_key,
                origin,
                Some(room.room_id().to_string()),
            );
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
            canonical_parents,
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
}
