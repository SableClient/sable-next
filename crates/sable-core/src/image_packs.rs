//! MSC2545 image packs: custom emotes and stickers published by an account or
//! a room.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::protocol::{ImagePackOriginView, ImagePackView, ImageUsageView, PackImageView};

pub const USER_EMOTES: &str = "im.ponies.user_emotes";
pub const ROOM_EMOTES: &str = "im.ponies.room_emotes";
pub const EMOTE_ROOMS: &str = "im.ponies.emote_rooms";

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

use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::ruma::api::client::state::get_state_events;
use matrix_sdk::ruma::events::{GlobalAccountDataEventType, StateEventType};
use matrix_sdk::ruma::{OwnedRoomId, RoomId};

use crate::Core;
use crate::protocol::{CommandErr, CommandOk};

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
        packs.extend(
            Self::room_packs(&client, &room, ImagePackOriginView::Room, None)
                .await
                .map_err(|error| self.failed("image_packs_room", error))?,
        );

        let subscribed = client
            .account()
            .account_data_raw(GlobalAccountDataEventType::from(EMOTE_ROOMS))
            .await
            .map_err(|error| self.failed("image_packs_global", error))?;
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
                    )
                    .await
                    .map_err(|error| self.failed("image_packs_global_room", error))?,
                );
            }
        }

        packs.retain(|pack| !pack.images.is_empty());
        Ok(CommandOk::ImagePacks { packs })
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
    ) -> Result<Vec<ImagePackView>, matrix_sdk::Error> {
        let stored = room
            .get_state_events(StateEventType::from(ROOM_EMOTES))
            .await?;
        let mut parsed: Vec<RoomPackEvent> = stored
            .iter()
            .filter_map(|event| {
                let json = match event {
                    RawAnySyncOrStrippedState::Sync(raw) => raw.json(),
                    RawAnySyncOrStrippedState::Stripped(raw) => raw.json(),
                };
                serde_json::from_str::<RoomPackEvent>(json.get()).ok()
            })
            .collect();

        if parsed.is_empty() {
            let response = client
                .send(get_state_events::v3::Request::new(
                    room.room_id().to_owned(),
                ))
                .await?;
            parsed = response
                .room_state
                .iter()
                .filter_map(|raw| {
                    let event = serde_json::from_str::<RoomPackEvent>(raw.json().get()).ok()?;
                    (event.event_type == ROOM_EMOTES).then_some(event)
                })
                .collect();
        }

        let mut packs = Vec::new();
        for event in parsed {
            if wanted.is_some_and(|keys| !keys.contains(&event.state_key)) {
                continue;
            }
            packs.push(pack_view(
                event.content,
                event.state_key,
                origin,
                Some(room.room_id().to_string()),
            ));
        }
        Ok(packs)
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
    fn emote_rooms_lists_every_subscribed_state_key() {
        let rooms: EmoteRooms = serde_json::from_str(
            r#"{"rooms":{"!a:example.org":{"":{},"extra":{}},"!b:example.org":{"":{}}}}"#,
        )
        .expect("emote rooms");

        assert_eq!(rooms.rooms.len(), 2);
        assert_eq!(rooms.rooms["!a:example.org"].len(), 2);
    }
}
