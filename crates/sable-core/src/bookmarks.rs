use matrix_sdk::ruma::events::GlobalAccountDataEventType;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_with::{DefaultOnError, VecSkipError, serde_as};

use crate::Core;
use crate::ResultExt;
use crate::protocol::BookmarkView;
use crate::protocol::RpcError;
use crate::room_settings::EmptyContent;

const INDEX_EVENT: &str = "pl.chrome.bookmarks.index";
const ITEM_PREFIX: &str = "pl.chrome.bookmark.";

pub(crate) fn bookmark_id(room_id: &str, event_id: &str) -> String {
    let mut hash: i32 = 0;
    for ch in format!("{room_id}|{event_id}").encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(ch));
    }
    format!("bmk_{:08x}", hash.cast_unsigned())
}

#[derive(Serialize)]
struct IndexOut {
    version: u8,
    revision: u64,
    updated_ts: u64,
    bookmark_ids: Vec<String>,
}

#[derive(Serialize)]
struct ItemOut {
    version: u8,
    bookmark_id: String,
    uri: String,
    room_id: OwnedRoomId,
    event_id: OwnedEventId,
    event_ts: u64,
    bookmarked_ts: u64,
    sender: Option<String>,
    room_name: Option<String>,
    body_preview: Option<String>,
    msgtype: Option<String>,
}

fn unique_ids(ids: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    ids.into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

#[serde_as]
#[derive(Default, Deserialize)]
struct IndexIn {
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    bookmark_ids: Vec<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    revision: Option<u64>,
}

#[serde_as]
#[derive(Deserialize)]
struct ItemIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    room_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    event_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    room_name: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    sender: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    body_preview: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    event_ts: Option<u64>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    bookmarked_ts: Option<u64>,
}

#[serde_as]
#[derive(Default, Deserialize)]
struct SourceEventIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    origin_server_ts: Option<u64>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    sender: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    content: Option<SourceContentIn>,
}

#[serde_as]
#[derive(Deserialize)]
struct SourceContentIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    body: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    msgtype: Option<String>,
}

fn item_event(id: &str) -> GlobalAccountDataEventType {
    GlobalAccountDataEventType::from(format!("{ITEM_PREFIX}{id}"))
}

impl Core {
    async fn bookmark_account_data<T: DeserializeOwned>(
        &self,
        event_type: GlobalAccountDataEventType,
    ) -> Result<Option<T>, RpcError> {
        Ok(self
            .global_account_data(event_type, "bookmarks")
            .await?
            .and_then(|raw| raw.deserialize_as_unchecked::<T>().ok()))
    }

    /// Fails rather than reading as empty, so a rewrite never starts from a
    /// list the homeserver could not be asked for.
    async fn bookmark_index(&self) -> Result<IndexIn, RpcError> {
        Ok(self
            .global_account_data(GlobalAccountDataEventType::from(INDEX_EVENT), "bookmarks")
            .await?
            .and_then(|raw| raw.deserialize_as_unchecked::<IndexIn>().ok())
            .unwrap_or_default())
    }

    async fn bookmark_ids(&self) -> Result<Vec<String>, RpcError> {
        Ok(unique_ids(self.bookmark_index().await?.bookmark_ids))
    }

    pub(crate) async fn bookmarks(&self) -> Result<Vec<BookmarkView>, RpcError> {
        let mut bookmarks = Vec::new();

        for id in self.bookmark_ids().await? {
            let Some(item) = self
                .bookmark_account_data::<ItemIn>(item_event(&id))
                .await?
            else {
                continue;
            };
            let (Some(room_id), Some(event_id)) = (item.room_id, item.event_id) else {
                continue;
            };

            bookmarks.push(BookmarkView {
                bookmark_id: id,
                room_id,
                event_id,
                room_name: item.room_name,
                sender: item.sender,
                body_preview: item.body_preview,
                event_ts: item.event_ts.unwrap_or(0),
                bookmarked_ts: item.bookmarked_ts.unwrap_or(0),
            });
        }

        bookmarks.sort_by_key(|bookmark| std::cmp::Reverse(bookmark.bookmarked_ts));
        Ok(bookmarks)
    }

    pub(crate) async fn set_bookmark(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        bookmarked: bool,
        now_ms: u64,
    ) -> Result<bool, RpcError> {
        let _guard = self.account_data_lock.lock().await;
        let id = bookmark_id(room_id.as_str(), event_id.as_str());
        let index = self.bookmark_index().await?;
        let revision = index.revision.unwrap_or(0);
        let mut ids = unique_ids(index.bookmark_ids);
        let held = ids.iter().any(|candidate| candidate == &id);

        if bookmarked == held {
            return Ok(held);
        }

        if bookmarked {
            self.write_bookmark_item(&id, room_id, event_id, now_ms)
                .await?;
            ids.push(id);
        } else {
            self.put_global_account_data(item_event(&id), &EmptyContent {}, "bookmarks")
                .await?;
            ids.retain(|candidate| candidate != &id);
        }

        self.put_global_account_data(
            GlobalAccountDataEventType::from(INDEX_EVENT),
            &IndexOut {
                version: 1,
                revision: revision.saturating_add(1),
                updated_ts: now_ms,
                bookmark_ids: ids,
            },
            "bookmarks",
        )
        .await?;

        Ok(bookmarked)
    }

    async fn write_bookmark_item(
        &self,
        id: &str,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        now_ms: u64,
    ) -> Result<(), RpcError> {
        let room = self.room(room_id).await?;
        let encrypted = self.room_is_encrypted(&room).await?;
        let event = room
            .event(event_id, None)
            .await
            .or_failed(self, "set_bookmark")?;
        let raw = event
            .raw()
            .deserialize_as_unchecked::<SourceEventIn>()
            .unwrap_or_default();
        let content = raw.content.as_ref();

        let body = content
            .and_then(|content| content.body.as_deref())
            .map(|body| crate::inbox::preview(body.to_owned()));

        let item = ItemOut {
            version: 1,
            bookmark_id: id.to_owned(),
            uri: room_id.matrix_event_uri(event_id.clone()).to_string(),
            room_id: room_id.clone(),
            event_id: event_id.clone(),
            event_ts: raw.origin_server_ts.unwrap_or(now_ms),
            bookmarked_ts: now_ms,
            sender: raw.sender,
            room_name: room.cached_display_name().map(|name| name.to_string()),
            body_preview: (!encrypted).then_some(body).flatten(),
            msgtype: (!encrypted)
                .then(|| raw.content.and_then(|content| content.msgtype))
                .flatten(),
        };
        self.put_global_account_data(item_event(id), &item, "bookmarks")
            .await
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{owned_event_id, owned_room_id};
    use serde_json::json;

    use super::{IndexIn, IndexOut, ItemIn, ItemOut, SourceEventIn};

    #[test]
    fn the_index_is_the_stored_shape() {
        assert_eq!(
            serde_json::to_value(IndexOut {
                version: 1,
                revision: 3,
                updated_ts: 9,
                bookmark_ids: vec!["bmk_1".to_owned()],
            })
            .unwrap(),
            json!({ "version": 1, "revision": 3, "updated_ts": 9, "bookmark_ids": ["bmk_1"] })
        );
    }

    #[test]
    fn an_item_keeps_absent_fields_as_null() {
        let room_id = owned_room_id!("!r:example.org");
        let event_id = owned_event_id!("$e");
        assert_eq!(
            serde_json::to_value(ItemOut {
                version: 1,
                bookmark_id: "bmk_1".to_owned(),
                uri: "matrix:roomid/r:example.org/e/e".to_owned(),
                room_id,
                event_id,
                event_ts: 5,
                bookmarked_ts: 6,
                sender: None,
                room_name: Some("Room".to_owned()),
                body_preview: None,
                msgtype: Some("m.text".to_owned()),
            })
            .unwrap(),
            json!({
                "version": 1,
                "bookmark_id": "bmk_1",
                "uri": "matrix:roomid/r:example.org/e/e",
                "room_id": "!r:example.org",
                "event_id": "$e",
                "event_ts": 5,
                "bookmarked_ts": 6,
                "sender": null,
                "room_name": "Room",
                "body_preview": null,
                "msgtype": "m.text",
            })
        );
    }

    #[test]
    fn stored_bookmarks_read_leniently() {
        let index: IndexIn =
            serde_json::from_value(json!({ "bookmark_ids": ["a", 3, "b"], "revision": "x" }))
                .unwrap();
        assert_eq!(index.bookmark_ids, ["a", "b"]);
        assert_eq!(index.revision, None);
        let index: IndexIn = serde_json::from_value(json!({ "bookmark_ids": "a" })).unwrap();
        assert_eq!(index.bookmark_ids, [] as [String; 0]);

        let item: ItemIn = serde_json::from_value(
            json!({ "room_id": "!r:x", "event_id": 4, "event_ts": 2, "sender": null }),
        )
        .unwrap();
        assert_eq!(item.room_id.as_deref(), Some("!r:x"));
        assert_eq!(item.event_id, None);
        assert_eq!(item.event_ts, Some(2));
        assert_eq!(item.sender, None);

        let source: SourceEventIn = serde_json::from_value(
            json!({ "origin_server_ts": 5, "content": { "body": 1, "msgtype": "m.text" } }),
        )
        .unwrap();
        assert_eq!(source.origin_server_ts, Some(5));
        let content = source.content.expect("content");
        assert_eq!(
            (content.body, content.msgtype.as_deref()),
            (None, Some("m.text"))
        );
    }
}
