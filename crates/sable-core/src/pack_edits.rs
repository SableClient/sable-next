use std::collections::BTreeSet;

use matrix_sdk::ruma::OwnedRoomId;
use sable_model::shortcodes::{self, normalize_shortcode, unique_shortcode};
use serde_json::{Map, Value, json};

use crate::image_packs::{EmoteRooms, IMAGE_PACK_ROOMS, ROOM_EMOTES, ROOM_IMAGE_PACK, USER_EMOTES};
use crate::protocol::{
    CommandErr, ImageUsageView, PackAddressView, PackDraftView, PackImageDraftView,
    PackImageInfoView, PackTargetView,
};
use crate::{Core, ResultExt};

const ALL_USAGES: [ImageUsageView; 2] = [ImageUsageView::Emoticon, ImageUsageView::Sticker];

pub(crate) fn invalid_shortcode(images: &[PackImageDraftView]) -> Option<&str> {
    shortcodes::invalid_shortcode(images.iter().map(|image| image.shortcode.as_str()))
}

fn same_usage(left: &[ImageUsageView], right: &[ImageUsageView]) -> bool {
    left.len() == right.len() && left.iter().all(|usage| right.contains(usage))
}

const fn usage_name(usage: ImageUsageView) -> &'static str {
    match usage {
        ImageUsageView::Emoticon => "emoticon",
        ImageUsageView::Sticker => "sticker",
    }
}

fn usage_json(usage: &[ImageUsageView]) -> Value {
    json!(
        usage
            .iter()
            .map(|usage| usage_name(*usage))
            .collect::<Vec<_>>()
    )
}

fn info_content(info: Option<&PackImageInfoView>) -> Option<Value> {
    let info = info?;
    let mut content = Map::new();
    if let Some(width) = info.width {
        content.insert("w".to_owned(), json!(width));
    }
    if let Some(height) = info.height {
        content.insert("h".to_owned(), json!(height));
    }
    if let Some(mimetype) = &info.mimetype {
        content.insert("mimetype".to_owned(), json!(mimetype));
    }
    if let Some(size) = info.size {
        content.insert("size".to_owned(), json!(size));
    }
    (!content.is_empty()).then_some(Value::Object(content))
}

/// An image's usage is written only where it differs from its pack's.
fn image_content(image: &PackImageDraftView, pack_usage: &[ImageUsageView]) -> Value {
    let mut content = Map::new();
    content.insert("url".to_owned(), json!(image.url));
    if let Some(body) = &image.body {
        content.insert("body".to_owned(), json!(body));
    }
    if !same_usage(&image.usage, pack_usage) {
        content.insert("usage".to_owned(), usage_json(&image.usage));
    }
    if let Some(info) = info_content(image.info.as_ref()) {
        content.insert("info".to_owned(), info);
    }
    Value::Object(content)
}

pub(crate) fn pack_content(draft: &PackDraftView) -> Result<Value, CommandErr> {
    if let Some(shortcode) = invalid_shortcode(&draft.images) {
        return Err(CommandErr::InvalidShortcode {
            shortcode: shortcode.to_owned(),
        });
    }
    let mut pack = Map::new();
    if !draft.name.is_empty() {
        pack.insert("display_name".to_owned(), json!(draft.name));
    }
    if let Some(avatar_url) = &draft.avatar_url {
        pack.insert("avatar_url".to_owned(), json!(avatar_url));
    }
    if !draft.attribution.is_empty() {
        pack.insert("attribution".to_owned(), json!(draft.attribution));
    }
    if draft.usage.len() != ALL_USAGES.len() {
        pack.insert("usage".to_owned(), usage_json(&draft.usage));
    }
    let images: Map<String, Value> = draft
        .images
        .iter()
        .map(|image| (image.shortcode.clone(), image_content(image, &draft.usage)))
        .collect();
    Ok(json!({ "pack": pack, "images": images }))
}

fn declared_usage(pack: Option<&Value>) -> Vec<ImageUsageView> {
    let declared: Vec<ImageUsageView> = pack
        .and_then(|pack| pack.get("usage"))
        .and_then(Value::as_array)
        .map(|usage| {
            ALL_USAGES
                .into_iter()
                .filter(|wanted| {
                    usage
                        .iter()
                        .any(|entry| entry.as_str() == Some(usage_name(*wanted)))
                })
                .collect()
        })
        .unwrap_or_default();
    if declared.is_empty() {
        ALL_USAGES.to_vec()
    } else {
        declared
    }
}

/// Adds to the stored event as it is, so whatever we do not model survives.
pub(crate) fn merged_pack_content(
    current: Option<Value>,
    additions: &[PackImageDraftView],
) -> Value {
    let mut pack = match current {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let mut images = match pack.remove("images") {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let pack_usage = declared_usage(pack.get("pack"));
    for image in additions {
        let shortcode =
            unique_shortcode(&image.shortcode, |candidate| images.contains_key(candidate));
        images.insert(shortcode, image_content(image, &pack_usage));
    }
    pack.insert("images".to_owned(), Value::Object(images));
    Value::Object(pack)
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

pub(crate) fn subscriptions_content(addresses: &[PackAddressView]) -> Value {
    let mut rooms: Map<String, Value> = Map::new();
    for address in addresses {
        let packs = rooms
            .entry(address.room_id.to_string())
            .or_insert_with(|| json!({}));
        if let Some(packs) = packs.as_object_mut() {
            packs.insert(address.state_key.clone(), json!({}));
        }
    }
    json!({ "rooms": rooms })
}

fn is_empty_content(content: Option<&Value>) -> bool {
    content.and_then(Value::as_object).is_none_or(Map::is_empty)
}

impl Core {
    async fn room_pack_state_keys(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<BTreeSet<String>, CommandErr> {
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
    ) -> Result<Option<Value>, CommandErr> {
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
    ) -> Result<(), CommandErr> {
        let content = pack_content(draft)?;
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
    ) -> Result<String, CommandErr> {
        let taken = self.room_pack_state_keys(&room_id).await?;
        let wanted = match normalize_shortcode(name).to_lowercase() {
            wanted if wanted.is_empty() => "pack".to_owned(),
            wanted => wanted,
        };
        let state_key = unique_shortcode(&wanted, |candidate| taken.contains(candidate));
        let content = json!({ "pack": { "display_name": name.trim() }, "images": {} });
        self.send_state(room_id, ROOM_IMAGE_PACK, &state_key, &content)
            .await?;
        Ok(state_key)
    }

    pub(crate) async fn delete_room_image_pack(
        &self,
        room_id: OwnedRoomId,
        state_key: &str,
    ) -> Result<(), CommandErr> {
        if let Err(error) = self.remove_legacy_pack(&room_id, state_key).await {
            tracing::warn!(?error, "legacy pack not cleared");
        }
        self.send_state(room_id, ROOM_IMAGE_PACK, state_key, &json!({}))
            .await?;
        Ok(())
    }

    async fn remove_legacy_pack(
        &self,
        room_id: &OwnedRoomId,
        state_key: &str,
    ) -> Result<(), CommandErr> {
        if self.legacy_pack(room_id, state_key).await?.is_some() {
            self.send_state(room_id.clone(), ROOM_EMOTES, state_key, &json!({}))
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn remove_legacy_image_packs(
        &self,
        room_id: &OwnedRoomId,
        state_keys: &[String],
    ) -> Result<(), CommandErr> {
        for state_key in state_keys {
            self.remove_legacy_pack(room_id, state_key).await?;
        }
        Ok(())
    }

    /// Copies each legacy `im.ponies.room_emotes` pack to `m.room.image_pack`.
    pub(crate) async fn convert_legacy_image_packs(
        &self,
        room_id: &OwnedRoomId,
        state_keys: &[String],
    ) -> Result<(), CommandErr> {
        for state_key in state_keys {
            if let Some(legacy) = self.legacy_pack(room_id, state_key).await? {
                self.send_state(room_id.clone(), ROOM_IMAGE_PACK, state_key, &legacy)
                    .await?;
            }
        }
        Ok(())
    }

    pub(crate) async fn add_account_pack_images(
        &self,
        images: &[PackImageDraftView],
    ) -> Result<(), CommandErr> {
        let _guard = self.account_data_lock.lock().await;
        let current = self
            .global_account_data(USER_EMOTES.into(), "add_account_pack_images")
            .await?
            .and_then(|raw| raw.deserialize_as::<Value>().ok());
        self.set_account_data(USER_EMOTES, &merged_pack_content(current, images))
            .await
    }

    pub(crate) async fn pack_subscriptions(&self) -> Result<Vec<PackAddressView>, CommandErr> {
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
    ) -> Result<Vec<PackAddressView>, CommandErr> {
        let _guard = self.account_data_lock.lock().await;
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
        invalid_shortcode, merged_pack_content, pack_content, subscriptions_content,
        with_subscriptions,
    };
    use crate::protocol::{
        CommandErr, ImageUsageView, PackAddressView, PackDraftView, PackImageDraftView,
        PackImageInfoView,
    };

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
    fn a_malformed_or_repeated_shortcode_is_reported() {
        assert_eq!(invalid_shortcode(&[image("ok", &BOTH)]), None);
        assert_eq!(
            invalid_shortcode(&[image("no space", &BOTH)]),
            Some("no space")
        );
        assert_eq!(
            invalid_shortcode(&[image("dup", &BOTH), image("dup", &BOTH)]),
            Some("dup")
        );
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
            pack_content(&draft).expect("valid pack"),
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
            pack_content(&draft).expect("valid pack"),
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
            pack_content(&draft).expect("valid pack"),
            json!({ "pack": {}, "images": {} })
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
            pack_content(&draft),
            Err(CommandErr::InvalidShortcode { shortcode }) if shortcode == "bad code"
        ));
    }

    #[test]
    fn merging_keeps_the_stored_event_and_renames_clashes() {
        let current = json!({
            "pack": { "usage": ["emoticon"], "x-extra": true },
            "images": { "cat": { "url": "mxc://example.org/old" } },
        });
        let merged =
            merged_pack_content(Some(current), &[image("cat", &[ImageUsageView::Emoticon])]);

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
            merged_pack_content(None, &[image("cat", &BOTH)]),
            json!({ "images": { "cat": { "url": "mxc://example.org/cat" } } })
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
            subscriptions_content(&next),
            json!({ "rooms": { "!a:example.org": { "": {} }, "!c:example.org": { "": {} } } })
        );
    }
}
