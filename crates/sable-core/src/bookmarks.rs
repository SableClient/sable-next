use matrix_sdk::ruma::events::{AnyGlobalAccountDataEventContent, GlobalAccountDataEventType};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};
use serde_json::{Value, json};

use crate::Core;
use crate::protocol::BookmarkView;
use crate::protocol::CommandErr;

const INDEX_EVENT: &str = "pl.chrome.bookmarks.index";
const ITEM_PREFIX: &str = "pl.chrome.bookmark.";
const PREVIEW_LIMIT: usize = 120;

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

fn item_event(id: &str) -> GlobalAccountDataEventType {
    GlobalAccountDataEventType::from(format!("{ITEM_PREFIX}{id}"))
}

impl Core {
    async fn account_data(&self, event_type: GlobalAccountDataEventType) -> Option<Value> {
        self.client()
            .await
            .ok()?
            .account()
            .fetch_account_data(event_type)
            .await
            .ok()
            .flatten()
            .and_then(|raw| raw.deserialize_as::<Value>().ok())
    }

    async fn put_account_data(
        &self,
        event_type: GlobalAccountDataEventType,
        content: Value,
    ) -> Result<(), CommandErr> {
        let raw = Raw::<AnyGlobalAccountDataEventContent>::from_json_string(content.to_string())
            .map_err(|error| self.failed("bookmarks", error))?;

        self.client()
            .await?
            .account()
            .set_account_data_raw(event_type, raw)
            .await
            .map_err(|error| self.failed("bookmarks", error))?;

        Ok(())
    }

    async fn bookmark_ids(&self) -> Vec<String> {
        self.account_data(GlobalAccountDataEventType::from(INDEX_EVENT))
            .await
            .and_then(|index| {
                index.get("bookmark_ids")?.as_array().map(|ids| {
                    ids.iter()
                        .filter_map(|id| id.as_str())
                        .map(str::to_owned)
                        .collect()
                })
            })
            .unwrap_or_default()
    }

    pub(crate) async fn bookmarks(&self) -> Result<Vec<BookmarkView>, CommandErr> {
        let mut bookmarks = Vec::new();

        for id in self.bookmark_ids().await {
            let Some(item) = self.account_data(item_event(&id)).await else {
                continue;
            };
            let (Some(room_id), Some(event_id)) = (
                item.get("room_id").and_then(Value::as_str),
                item.get("event_id").and_then(Value::as_str),
            ) else {
                continue;
            };

            bookmarks.push(BookmarkView {
                bookmark_id: id,
                room_id: room_id.to_owned(),
                event_id: event_id.to_owned(),
                room_name: item
                    .get("room_name")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                sender: item
                    .get("sender")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                body_preview: item
                    .get("body_preview")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                event_ts: item.get("event_ts").and_then(Value::as_u64).unwrap_or(0),
                bookmarked_ts: item
                    .get("bookmarked_ts")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
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
    ) -> Result<bool, CommandErr> {
        let _guard = self.account_data_lock.lock().await;
        let id = bookmark_id(room_id.as_str(), event_id.as_str());
        let mut ids = self.bookmark_ids().await;
        let held = ids.iter().any(|candidate| candidate == &id);

        if bookmarked == held {
            return Ok(held);
        }

        if bookmarked {
            let item = self.bookmark_item(&id, room_id, event_id, now_ms).await?;
            self.put_account_data(item_event(&id), item).await?;
            ids.push(id);
        } else {
            self.put_account_data(item_event(&id), json!({})).await?;
            ids.retain(|candidate| candidate != &id);
        }

        let revision = self
            .account_data(GlobalAccountDataEventType::from(INDEX_EVENT))
            .await
            .and_then(|index| index.get("revision").and_then(Value::as_u64))
            .unwrap_or(0);

        self.put_account_data(
            GlobalAccountDataEventType::from(INDEX_EVENT),
            json!({
                "version": 1,
                "revision": revision.saturating_add(1),
                "updated_ts": now_ms,
                "bookmark_ids": ids,
            }),
        )
        .await?;

        Ok(bookmarked)
    }

    async fn bookmark_item(
        &self,
        id: &str,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        now_ms: u64,
    ) -> Result<Value, CommandErr> {
        let room = self.room(room_id).await?;
        let encrypted = room
            .latest_encryption_state()
            .await
            .is_ok_and(|state| state.is_encrypted());
        let event = room
            .event(event_id, None)
            .await
            .map_err(|error| self.failed("set_bookmark", error))?;
        let raw = event.raw().deserialize_as::<Value>().ok();

        let body = raw
            .as_ref()
            .and_then(|value| value.pointer("/content/body"))
            .and_then(Value::as_str)
            .map(|body| {
                if body.chars().count() <= PREVIEW_LIMIT {
                    body.to_owned()
                } else {
                    format!("{}…", body.chars().take(PREVIEW_LIMIT).collect::<String>())
                }
            });

        Ok(json!({
            "version": 1,
            "bookmark_id": id,
            "uri": room_id.matrix_event_uri(event_id.clone()).to_string(),
            "room_id": room_id,
            "event_id": event_id,
            "event_ts": raw
                .as_ref()
                .and_then(|value| value.get("origin_server_ts"))
                .and_then(Value::as_u64)
                .unwrap_or(now_ms),
            "bookmarked_ts": now_ms,
            "sender": raw
                .as_ref()
                .and_then(|value| value.get("sender"))
                .and_then(Value::as_str),
            "room_name": room.cached_display_name().map(|name| name.to_string()),
            "body_preview": (!encrypted).then_some(body).flatten(),
            "msgtype": raw
                .as_ref()
                .and_then(|value| value.pointer("/content/msgtype"))
                .and_then(Value::as_str),
        }))
    }
}
