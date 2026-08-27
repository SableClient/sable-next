use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::api::client::room::report_content;
use matrix_sdk::ruma::events::room::pinned_events::RoomPinnedEventsEventContent;
use matrix_sdk::ruma::events::{AnyMessageLikeEventContent, AnySyncTimelineEvent};
use matrix_sdk::ruma::room::JoinRule;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId, UInt};

use crate::Core;
use crate::personas::PER_MESSAGE_PROFILE;
use crate::protocol::CommandErr;

impl Core {
    pub(crate) async fn bulk_redact(
        &self,
        room_id: &OwnedRoomId,
        senders: &[String],
        after_ts: u64,
        event_types: &[String],
        reason: Option<&str>,
    ) -> Result<u32, CommandErr> {
        let room = self.room(room_id).await?;
        let mut from: Option<String> = None;
        let mut redacted = 0;

        loop {
            let mut options = MessagesOptions::backward().from(from.as_deref());
            options.limit = UInt::from(100u16);
            let messages = room
                .messages(options)
                .await
                .map_err(|error| self.failed("bulk_redact", error))?;
            if messages.chunk.is_empty() {
                break;
            }

            let mut older_than_cutoff = true;
            for event in messages.chunk {
                let Ok(raw) = serde_json::from_str::<serde_json::Value>(event.raw().json().get())
                else {
                    continue;
                };
                let ts = raw
                    .get("origin_server_ts")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or_default();
                if ts >= after_ts {
                    older_than_cutoff = false;
                }
                if ts < after_ts
                    || !senders.iter().any(|sender| {
                        raw.get("sender").and_then(serde_json::Value::as_str) == Some(sender)
                    })
                    || (!event_types.is_empty()
                        && !event_types.iter().any(|event_type| {
                            raw.get("type").and_then(serde_json::Value::as_str) == Some(event_type)
                        }))
                    || raw
                        .get("unsigned")
                        .and_then(|unsigned| unsigned.get("redacted_because"))
                        .is_some()
                {
                    continue;
                }

                let Some(event_id) = raw.get("event_id").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let event_id =
                    EventId::parse(event_id).map_err(|error| self.failed("bulk_redact", error))?;
                room.redact(&event_id, reason, None)
                    .await
                    .map_err(|error| self.failed("bulk_redact", error))?;
                redacted += 1;
            }

            if older_than_cutoff {
                break;
            }
            let Some(next) = messages.end else {
                break;
            };
            from = Some(next);
        }

        Ok(redacted)
    }

    pub(crate) async fn pinned_events(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<Vec<OwnedEventId>, CommandErr> {
        Ok(self
            .room(room_id)
            .await?
            .pinned_event_ids()
            .unwrap_or_default())
    }

    pub(crate) async fn set_pinned(
        &self,
        room_id: &OwnedRoomId,
        event_id: OwnedEventId,
        pinned: bool,
    ) -> Result<Vec<OwnedEventId>, CommandErr> {
        let _guard = self.account_data_lock.lock().await;
        let room = self.room(room_id).await?;
        let mut events = room.pinned_event_ids().unwrap_or_default();

        events.retain(|candidate| candidate != &event_id);
        if pinned {
            events.push(event_id);
        }

        room.send_state_event(RoomPinnedEventsEventContent::new(events.clone()))
            .await
            .map_err(|error| self.failed("set_pinned", error))?;

        Ok(events)
    }

    pub(crate) async fn report_message(
        &self,
        room_id: &OwnedRoomId,
        event_id: OwnedEventId,
        reason: Option<String>,
    ) -> Result<(), CommandErr> {
        let room = self.room(room_id).await?;
        let mut request = report_content::v3::Request::new(room.room_id().to_owned(), event_id);
        request.reason = reason;

        room.client()
            .send(request)
            .await
            .map_err(|error| self.failed("report_message", error))?;

        Ok(())
    }

    pub(crate) async fn event_source(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
    ) -> Result<String, CommandErr> {
        let event = self
            .room(room_id)
            .await?
            .event(event_id, None)
            .await
            .map_err(|error| self.failed("event_source", error))?;

        let raw = event.raw().json().get().to_owned();
        Ok(serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|value| serde_json::to_string_pretty(&value).ok())
            .unwrap_or(raw))
    }

    pub(crate) async fn forward_message(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        to_room_id: &OwnedRoomId,
    ) -> Result<(), CommandErr> {
        let source = self.room(room_id).await?;
        let event = source
            .event(event_id, None)
            .await
            .map_err(|error| self.failed("forward_message", error))?;

        let raw = event
            .raw()
            .deserialize()
            .map_err(|error| self.failed("forward_message", error))?;

        let AnySyncTimelineEvent::MessageLike(message) = raw else {
            return Err(CommandErr::Unsupported);
        };
        let origin_server_ts = message.origin_server_ts().0;
        let AnyMessageLikeEventContent::RoomMessage(original) =
            message.original_content().ok_or(CommandErr::Unsupported)?
        else {
            return Err(CommandErr::Unsupported);
        };

        let mut content = serde_json::to_value(&original)
            .map_err(|error| self.failed("forward_message", error))?;
        let Some(object) = content.as_object_mut() else {
            return Err(CommandErr::Unsupported);
        };

        object.remove("m.relates_to");
        object.remove("m.mentions");
        object.remove(PER_MESSAGE_PROFILE);

        let private = !matches!(source.join_rule(), Some(JoinRule::Public));
        if private {
            let body = object
                .get("body")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned();
            object.clear();
            object.insert("msgtype".to_owned(), "m.text".into());
            object.insert("body".to_owned(), body.into());
        }

        object.insert(
            FORWARD_META.to_owned(),
            serde_json::json!({
                "origin_server_ts": u64::from(origin_server_ts),
                "event_id": (!private).then(|| event_id.to_string()),
                "room_id": (!private).then(|| room_id.to_string()),
            }),
        );

        self.room(to_room_id)
            .await?
            .send_raw("m.room.message", content)
            .await
            .map_err(|error| self.failed("forward_message", error))?;

        Ok(())
    }
}

const FORWARD_META: &str = "com.famedly.app.forwarded";
