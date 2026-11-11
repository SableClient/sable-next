use crate::api::packs::PackTargetView;
use std::collections::{BTreeMap, BTreeSet};

use matrix_sdk::ruma::OwnedRoomId;
use matrix_sdk::ruma::events::image_pack::rooms::{ImagePackRoomsEventContent, RoomImagePackMeta};
use sable_model::shortcodes::{self, normalize_shortcode, unique_shortcode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use serde_with::{DefaultOnError, VecSkipError, serde_as};

use crate::image_packs::{
    EMOTE_ROOMS, EmoteRooms, IMAGE_PACK_ROOMS, ROOM_EMOTES, ROOM_IMAGE_PACK, USER_EMOTES,
};
use crate::protocol::{
    ImageUsageView, PackAddressView, PackDraftView, PackImageDraftView, PackImageInfoView, RpcCode,
    RpcError,
};
use crate::room_settings::EmptyContent;
use crate::{Core, ResultExt};

const ALL_USAGES: [ImageUsageView; 2] = [ImageUsageView::Emoticon, ImageUsageView::Sticker];

fn same_usage(left: &[ImageUsageView], right: &[ImageUsageView]) -> bool {
    left.len() == right.len() && left.iter().all(|usage| right.contains(usage))
}

#[derive(Serialize)]
struct InfoOut {
    #[serde(rename = "w", skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(rename = "h", skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mimetype: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u32>,
}

fn info_content(info: Option<&PackImageInfoView>) -> Option<InfoOut> {
    let info = info?;
    let out = InfoOut {
        width: info.width,
        height: info.height,
        mimetype: info.mimetype.clone(),
        size: info.size,
    };
    (out.width.is_some() || out.height.is_some() || out.mimetype.is_some() || out.size.is_some())
        .then_some(out)
}

#[derive(Serialize)]
struct ImageOut {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Vec<ImageUsageView>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    info: Option<InfoOut>,
}

/// An image's usage is written only where it differs from its pack's.
fn image_content(image: &PackImageDraftView, pack_usage: &[ImageUsageView]) -> ImageOut {
    ImageOut {
        url: image.url.clone(),
        body: image.body.clone(),
        usage: (!same_usage(&image.usage, pack_usage)).then(|| image.usage.clone()),
        info: info_content(image.info.as_ref()),
    }
}

#[derive(Serialize)]
struct PackOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attribution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Vec<ImageUsageView>>,
}

#[derive(Serialize)]
pub(crate) struct PackContentOut {
    pack: PackOut,
    images: BTreeMap<String, ImageOut>,
}

pub(crate) fn pack_content(
    draft: &PackDraftView,
    current: Option<&Value>,
) -> Result<PackContentOut, RpcError> {
    let original = current
        .and_then(|content| content.get("images"))
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|images| images.keys().map(String::as_str));
    if let Some(shortcode) = shortcodes::invalid_shortcode(
        draft.images.iter().map(|image| image.shortcode.as_str()),
        original,
    ) {
        return Err(RpcCode::InvalidShortcode {
            shortcode: shortcode.to_owned(),
        }
        .into());
    }
    Ok(PackContentOut {
        pack: PackOut {
            display_name: (!draft.name.is_empty()).then(|| draft.name.clone()),
            avatar_url: draft.avatar_url.clone(),
            attribution: (!draft.attribution.is_empty()).then(|| draft.attribution.clone()),
            usage: (draft.usage.len() != ALL_USAGES.len()).then(|| draft.usage.clone()),
        },
        images: draft
            .images
            .iter()
            .map(|image| (image.shortcode.clone(), image_content(image, &draft.usage)))
            .collect(),
    })
}

#[serde_as]
#[derive(Default, Deserialize)]
struct PackUsageIn {
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    usage: Vec<ImageUsageView>,
}

fn declared_usage(pack: Option<&Value>) -> Vec<ImageUsageView> {
    let usage = pack
        .and_then(|pack| PackUsageIn::deserialize(pack).ok())
        .unwrap_or_default()
        .usage;
    let declared: Vec<ImageUsageView> = ALL_USAGES
        .into_iter()
        .filter(|wanted| usage.contains(wanted))
        .collect();
    if declared.is_empty() {
        ALL_USAGES.to_vec()
    } else {
        declared
    }
}

/// The stored event with room for more images; `pack` and anything else we do
/// not model rides along in `extra`.
#[serde_as]
#[derive(Default, Deserialize, Serialize)]
pub(crate) struct StoredPackContent {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    images: Map<String, Value>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// Adds to the stored event as it is, so whatever we do not model survives.
pub(crate) fn merged_pack_content(
    current: Option<Value>,
    additions: &[PackImageDraftView],
) -> serde_json::Result<StoredPackContent> {
    let mut pack: StoredPackContent = current
        .and_then(|current| serde_json::from_value(current).ok())
        .unwrap_or_default();
    let pack_usage = declared_usage(pack.extra.get("pack"));
    for image in additions {
        let shortcode = unique_shortcode(&image.shortcode, |candidate| {
            pack.images.contains_key(candidate)
        });
        pack.images.insert(
            shortcode,
            serde_json::to_value(image_content(image, &pack_usage))?,
        );
    }
    Ok(pack)
}

pub(crate) fn subscription_addresses(rooms: &EmoteRooms) -> Vec<PackAddressView> {
    rooms
        .rooms
        .iter()
        .filter_map(|(room_id, packs)| {
            let room_id = OwnedRoomId::try_from(room_id.as_str()).ok()?;
            Some(packs.keys().map(move |state_key| PackAddressView {
                room_id: room_id.clone(),
                state_key: state_key.clone(),
            }))
        })
        .flatten()
        .collect()
}

pub(crate) fn with_subscriptions(
    current: &[PackAddressView],
    added: &[PackAddressView],
    removed: &[PackAddressView],
) -> Vec<PackAddressView> {
    let mut kept: Vec<PackAddressView> = Vec::new();
    for address in current.iter().chain(added) {
        if !kept.contains(address) && !removed.contains(address) {
            kept.push(address.clone());
        }
    }
    kept
}

#[expect(
    clippy::zero_sized_map_values,
    reason = "ruma models the empty selection object as a unit struct"
)]
pub(crate) fn subscriptions_content(addresses: &[PackAddressView]) -> ImagePackRoomsEventContent {
    let mut rooms: BTreeMap<OwnedRoomId, BTreeMap<String, RoomImagePackMeta>> = BTreeMap::new();
    for address in addresses {
        rooms
            .entry(address.room_id.clone())
            .or_default()
            .insert(address.state_key.clone(), RoomImagePackMeta::new());
    }
    ImagePackRoomsEventContent::new(rooms)
}

/// Whether a state key survives a request path; a pasted file path does not.
fn is_url_safe_key(state_key: &str) -> bool {
    !state_key.is_empty()
        && state_key
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ' '))
}

fn is_empty_content(content: Option<&Value>) -> bool {
    content.and_then(Value::as_object).is_none_or(Map::is_empty)
}

#[derive(Serialize)]
struct NewPackInfoOut {
    display_name: String,
}

#[derive(Serialize)]
struct NewPackOut {
    pack: NewPackInfoOut,
    images: EmptyContent,
}

impl Core {
    async fn room_pack_state_keys(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<BTreeSet<String>, RpcError> {
        let mut keys = BTreeSet::new();
        for event_type in [ROOM_IMAGE_PACK, ROOM_EMOTES] {
            for event in self.room_state_events(room_id, event_type).await? {
                if !is_empty_content(Some(&event.content)) {
                    keys.insert(event.state_key);
                }
            }
        }
        Ok(keys)
    }

    async fn legacy_pack(
        &self,
        room_id: &OwnedRoomId,
        state_key: &str,
    ) -> Result<Option<Value>, RpcError> {
        Ok(self
            .room_state_event_content(
                room_id.clone(),
                ROOM_EMOTES.to_owned(),
                state_key.to_owned(),
            )
            .await?
            .filter(|content| !is_empty_content(Some(content))))
    }

    pub(crate) async fn save_image_pack(
        &self,
        target: PackTargetView,
        draft: &PackDraftView,
    ) -> Result<(), RpcError> {
        let current = match &target {
            PackTargetView::Room { room_id, state_key } => {
                let stable = self
                    .room_state_event_content(
                        room_id.clone(),
                        ROOM_IMAGE_PACK.to_owned(),
                        state_key.clone(),
                    )
                    .await?
                    .filter(|content| !is_empty_content(Some(content)));
                match stable {
                    Some(content) => Some(content),
                    None => self.legacy_pack(room_id, state_key).await?,
                }
            }
            PackTargetView::Account => self
                .global_account_data(USER_EMOTES.into(), "save_image_pack")
                .await?
                .and_then(|raw| raw.deserialize_as::<Value>().ok()),
        };
        let content = pack_content(draft, current.as_ref())?;
        match target {
            PackTargetView::Room { room_id, state_key } => {
                self.send_state(room_id, ROOM_IMAGE_PACK, &state_key, &content)
                    .await?;
            }
            PackTargetView::Account => self.set_account_data(USER_EMOTES, &content).await?,
        }
        Ok(())
    }

    pub(crate) async fn create_room_image_pack(
        &self,
        room_id: OwnedRoomId,
        name: &str,
    ) -> Result<String, RpcError> {
        let taken = self.room_pack_state_keys(&room_id).await?;
        let wanted = match normalize_shortcode(name).to_lowercase() {
            wanted if wanted.is_empty() => "pack".to_owned(),
            wanted => wanted,
        };
        let state_key = unique_shortcode(&wanted, |candidate| taken.contains(candidate));
        let content = NewPackOut {
            pack: NewPackInfoOut {
                display_name: name.trim().to_owned(),
            },
            images: EmptyContent {},
        };
        self.send_state(room_id, ROOM_IMAGE_PACK, &state_key, &content)
            .await?;
        Ok(state_key)
    }

    pub(crate) async fn delete_room_image_pack(
        &self,
        room_id: OwnedRoomId,
        state_key: &str,
    ) -> Result<(), RpcError> {
        if let Err(error) = self.remove_legacy_pack(&room_id, state_key).await {
            tracing::warn!(?error, "legacy pack not cleared");
        }
        self.send_state(room_id, ROOM_IMAGE_PACK, state_key, &EmptyContent {})
            .await?;
        Ok(())
    }

    async fn remove_legacy_pack(
        &self,
        room_id: &OwnedRoomId,
        state_key: &str,
    ) -> Result<(), RpcError> {
        if self.legacy_pack(room_id, state_key).await?.is_some() {
            self.send_state(room_id.clone(), ROOM_EMOTES, state_key, &EmptyContent {})
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn remove_legacy_image_packs(
        &self,
        room_id: &OwnedRoomId,
        state_keys: &[String],
    ) -> Result<(), RpcError> {
        for state_key in state_keys {
            self.remove_legacy_pack(room_id, state_key).await?;
        }
        Ok(())
    }

    /// Copies each legacy `im.ponies.room_emotes` pack to `m.room.image_pack`.
    /// A key a URL cannot carry is replaced by a generated one, and a pack that
    /// fails does not stop the rest; the first failure is returned at the end.
    pub(crate) async fn convert_legacy_image_packs(
        &self,
        room_id: &OwnedRoomId,
        state_keys: &[String],
    ) -> Result<(), RpcError> {
        let mut taken: Option<BTreeSet<String>> = None;
        let mut first_error = None;
        for state_key in state_keys {
            let result = async {
                let Some(legacy) = self.legacy_pack(room_id, state_key).await? else {
                    return Ok(());
                };
                let target = if is_url_safe_key(state_key) {
                    state_key.clone()
                } else {
                    let keys = match taken.take() {
                        Some(keys) => keys,
                        None => self.room_pack_state_keys(room_id).await?,
                    };
                    let target = unique_shortcode(state_key, |candidate| keys.contains(candidate));
                    taken = Some(keys);
                    target
                };
                self.send_state(room_id.clone(), ROOM_IMAGE_PACK, &target, &legacy)
                    .await?;
                if let Some(keys) = taken.as_mut() {
                    keys.insert(target);
                }
                Ok(())
            }
            .await;
            if let Err(error) = result {
                tracing::warn!(?error, "legacy pack not converted");
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub(crate) async fn add_account_pack_images(
        &self,
        images: &[PackImageDraftView],
    ) -> Result<(), RpcError> {
        let _guard = self.account_data_lock.lock().await;
        let current = self
            .global_account_data(USER_EMOTES.into(), "add_account_pack_images")
            .await?
            .and_then(|raw| raw.deserialize_as::<Value>().ok());
        let merged =
            merged_pack_content(current, images).or_failed(self, "add_account_pack_images")?;
        self.set_account_data(USER_EMOTES, &merged).await
    }

    pub(crate) async fn pack_subscriptions(&self) -> Result<Vec<PackAddressView>, RpcError> {
        let client = self.client().await?;
        let (raw, _) = self
            .subscribed_pack_rooms(&client, true)
            .await
            .or_failed(self, "pack_subscriptions")?;
        Ok(raw
            .and_then(|raw| raw.deserialize_as_unchecked::<EmoteRooms>().ok())
            .map(|rooms| subscription_addresses(&rooms))
            .unwrap_or_default())
    }

    pub(crate) async fn set_pack_subscriptions(
        &self,
        added: &[PackAddressView],
        removed: &[PackAddressView],
    ) -> Result<Vec<PackAddressView>, RpcError> {
        let _guard = self.account_data_lock.lock().await;
        {
            let mut cache = self.pack_cache.lock().await;
            cache.forget_account_data(IMAGE_PACK_ROOMS);
            cache.forget_account_data(EMOTE_ROOMS);
        }
        let next = with_subscriptions(&self.pack_subscriptions().await?, added, removed);
        self.set_account_data(IMAGE_PACK_ROOMS, &subscriptions_content(&next))
            .await?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        is_url_safe_key, merged_pack_content, pack_content, subscriptions_content,
        with_subscriptions,
    };
    use crate::protocol::{
        ImageUsageView, PackAddressView, PackDraftView, PackImageDraftView, PackImageInfoView,
        RpcCode, RpcError,
    };

    fn to_json(content: impl serde::Serialize) -> serde_json::Value {
        serde_json::to_value(content).expect("serializes")
    }

    fn image(shortcode: &str, usage: &[ImageUsageView]) -> PackImageDraftView {
        PackImageDraftView {
            shortcode: shortcode.to_owned(),
            url: format!("mxc://example.org/{shortcode}"),
            body: None,
            usage: usage.to_vec(),
            info: None,
        }
    }

    const BOTH: [ImageUsageView; 2] = [ImageUsageView::Emoticon, ImageUsageView::Sticker];

    fn address(room: &str, key: &str) -> PackAddressView {
        PackAddressView {
            room_id: room.try_into().expect("room id"),
            state_key: key.to_owned(),
        }
    }

    #[test]
    fn a_pasted_file_path_is_not_a_url_safe_key() {
        assert!(is_url_safe_key("Cat Pack_2.0-é"));
        assert!(!is_url_safe_key(
            r"E:\temp\Pictures\Stickers-&-Emoji\Animals"
        ));
        assert!(!is_url_safe_key("a/b"));
        assert!(!is_url_safe_key(""));
    }

    #[test]
    fn pack_content_writes_only_what_differs_from_the_defaults() {
        let mut sticker = image("wave", &[ImageUsageView::Sticker]);
        sticker.body = Some("Wave".to_owned());
        sticker.info = Some(PackImageInfoView {
            width: Some(32),
            height: None,
            mimetype: Some("image/png".to_owned()),
            size: None,
        });
        let draft = PackDraftView {
            name: "Cats".to_owned(),
            avatar_url: None,
            attribution: String::new(),
            usage: BOTH.to_vec(),
            images: vec![image("cat", &BOTH), sticker],
        };

        assert_eq!(
            to_json(pack_content(&draft, None).expect("valid pack")),
            json!({
                "pack": { "display_name": "Cats" },
                "images": {
                    "cat": { "url": "mxc://example.org/cat" },
                    "wave": {
                        "url": "mxc://example.org/wave",
                        "body": "Wave",
                        "usage": ["sticker"],
                        "info": { "w": 32, "mimetype": "image/png" },
                    },
                },
            })
        );
    }

    #[test]
    fn a_sticker_only_pack_keeps_its_usage_and_its_followers_inherit_it() {
        let draft = PackDraftView {
            name: "Blobs".to_owned(),
            avatar_url: Some("mxc://a/av".to_owned()),
            attribution: "CC BY 4.0".to_owned(),
            usage: vec![ImageUsageView::Sticker],
            images: vec![
                image("wave", &[ImageUsageView::Sticker]),
                image("both", &BOTH),
            ],
        };

        assert_eq!(
            to_json(pack_content(&draft, None).expect("valid pack")),
            json!({
                "pack": {
                    "display_name": "Blobs",
                    "avatar_url": "mxc://a/av",
                    "attribution": "CC BY 4.0",
                    "usage": ["sticker"],
                },
                "images": {
                    "wave": { "url": "mxc://example.org/wave" },
                    "both": { "url": "mxc://example.org/both", "usage": ["emoticon", "sticker"] },
                },
            })
        );
    }

    #[test]
    fn an_empty_draft_writes_no_meta() {
        let draft = PackDraftView {
            name: String::new(),
            avatar_url: None,
            attribution: String::new(),
            usage: BOTH.to_vec(),
            images: Vec::new(),
        };

        assert_eq!(
            to_json(pack_content(&draft, None).expect("valid pack")),
            json!({ "pack": {}, "images": {} })
        );
    }

    #[test]
    fn pack_content_preserves_dots_in_sticker_shortcodes() {
        let draft = PackDraftView {
            name: String::new(),
            avatar_url: None,
            attribution: String::new(),
            usage: vec![ImageUsageView::Sticker],
            images: vec![image("blob.wave", &[ImageUsageView::Sticker])],
        };

        let content = to_json(pack_content(&draft, None).expect("valid dotted shortcode"));
        assert_eq!(
            content["images"]["blob.wave"]["url"],
            "mxc://example.org/blob.wave"
        );
    }

    #[test]
    fn pack_content_refuses_an_invalid_shortcode() {
        let draft = PackDraftView {
            name: String::new(),
            avatar_url: None,
            attribution: String::new(),
            usage: BOTH.to_vec(),
            images: vec![image("bad code", &BOTH)],
        };

        assert!(matches!(
            pack_content(&draft, None),
            Err(RpcError { code: RpcCode::InvalidShortcode { shortcode }, .. }) if shortcode == "bad code"
        ));
    }

    #[test]
    fn pack_content_keeps_existing_shortcodes_when_an_image_is_edited() {
        let current = json!({
            "images": {
                "blob wave": { "url": "mxc://example.org/blob" },
                "a.b": { "url": "mxc://example.org/dot" },
                "cat": { "url": "mxc://example.org/cat" },
            },
        });
        let mut cat = image("cat", &BOTH);
        cat.body = Some("A cat".to_owned());
        let mut draft = PackDraftView {
            name: String::new(),
            avatar_url: None,
            attribution: String::new(),
            usage: BOTH.to_vec(),
            images: vec![image("blob wave", &BOTH), image("a.b", &BOTH), cat],
        };

        let content = to_json(pack_content(&draft, Some(&current)).expect("existing shortcodes"));
        assert_eq!(
            content["images"]["blob wave"]["url"],
            "mxc://example.org/blob wave"
        );
        assert_eq!(content["images"]["a.b"]["url"], "mxc://example.org/a.b");
        assert_eq!(content["images"]["cat"]["body"], "A cat");

        draft.images.push(image("blob wave", &BOTH));
        assert!(matches!(
            pack_content(&draft, Some(&current)),
            Err(RpcError { code: RpcCode::InvalidShortcode { shortcode }, .. }) if shortcode == "blob wave"
        ));
        draft.images.pop();
        draft.images.push(image("bad code", &BOTH));
        assert!(matches!(
            pack_content(&draft, Some(&current)),
            Err(RpcError { code: RpcCode::InvalidShortcode { shortcode }, .. }) if shortcode == "bad code"
        ));
        draft.images.pop();
        draft.images[0].shortcode = "bad code".to_owned();
        assert!(matches!(
            pack_content(&draft, Some(&current)),
            Err(RpcError { code: RpcCode::InvalidShortcode { shortcode }, .. }) if shortcode == "bad code"
        ));
    }

    #[test]
    fn merging_keeps_the_stored_event_and_renames_clashes() {
        let current = json!({
            "pack": { "usage": ["emoticon"], "x-extra": true },
            "images": { "cat": { "url": "mxc://example.org/old" } },
        });
        let merged =
            merged_pack_content(Some(current), &[image("cat", &[ImageUsageView::Emoticon])])
                .map(to_json)
                .expect("merged");

        assert_eq!(
            merged,
            json!({
                "pack": { "usage": ["emoticon"], "x-extra": true },
                "images": {
                    "cat": { "url": "mxc://example.org/old" },
                    "cat-1": { "url": "mxc://example.org/cat" },
                },
            })
        );
        assert_eq!(
            merged_pack_content(None, &[image("cat", &BOTH)])
                .map(to_json)
                .expect("merged"),
            json!({ "images": { "cat": { "url": "mxc://example.org/cat" } } })
        );
    }

    #[test]
    fn merging_treats_unreadable_images_as_empty_and_keeps_foreign_keys() {
        let current = json!({ "images": "nope", "x-extra": [1] });

        assert_eq!(
            merged_pack_content(Some(current), &[image("cat", &BOTH)])
                .map(to_json)
                .expect("merged"),
            json!({
                "x-extra": [1],
                "images": { "cat": { "url": "mxc://example.org/cat" } },
            })
        );
        assert_eq!(
            merged_pack_content(Some(json!("nonsense")), &[])
                .map(to_json)
                .expect("merged"),
            json!({ "images": {} })
        );
    }

    #[test]
    fn subscriptions_add_once_and_drop_removed_addresses() {
        let current = [
            address("!a:example.org", ""),
            address("!b:example.org", "x"),
        ];
        let next = with_subscriptions(
            &current,
            &[address("!a:example.org", ""), address("!c:example.org", "")],
            &[address("!b:example.org", "x")],
        );

        assert_eq!(
            next,
            vec![address("!a:example.org", ""), address("!c:example.org", "")]
        );
        assert_eq!(
            to_json(subscriptions_content(&next)),
            json!({ "rooms": { "!a:example.org": { "": {} }, "!c:example.org": { "": {} } } })
        );
    }

    #[test]
    fn declared_usage_skips_unknown_entries_and_falls_back_to_both() {
        assert_eq!(
            super::declared_usage(Some(&json!({ "usage": ["sticker", 3, "nonsense"] }))),
            vec![ImageUsageView::Sticker]
        );
        for pack in [
            json!({ "usage": "sticker" }),
            json!({ "usage": [] }),
            json!(3),
        ] {
            assert_eq!(super::declared_usage(Some(&pack)), BOTH.to_vec());
        }
        assert_eq!(super::declared_usage(None), BOTH.to_vec());
    }
}
