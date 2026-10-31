use sable_model::text::visible_name;

use crate::api::account::ReportUserParams;
use crate::api::rooms::ReportParams;
use std::collections::{HashMap, HashSet};

use futures_util::future::join_all;
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::room::{IncludeRelations, MessagesOptions, RelationsOptions};
use matrix_sdk::ruma::api::Direction;
use matrix_sdk::ruma::api::client::reporting::report_user;
use matrix_sdk::ruma::api::client::room::get_room_event;
use matrix_sdk::ruma::api::client::room::{report_content, report_room};
use matrix_sdk::ruma::api::client::state::get_state_event_for_key;
use matrix_sdk::ruma::events::relation::RelationType;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::room::pinned_events::RoomPinnedEventsEventContent;
use matrix_sdk::ruma::events::sticker::StickerEventContent;
use matrix_sdk::ruma::events::{
    AnyMessageLikeEventContent, AnySyncTimelineEvent, Mentions, StateEventType,
};
use matrix_sdk::ruma::room::JoinRule;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{
    EventId, MilliSecondsSinceUnixEpoch, OwnedEventId, OwnedRoomId, OwnedServerName, OwnedUserId,
    RoomId, UInt, UserId,
};
use matrix_sdk_ui::timeline::TimelineEventItemId;

use crate::Core;
use crate::ResultExt;
use crate::link_previews::BUNDLED_LINK_PREVIEWS;
use crate::link_previews::LEGACY_BUNDLED_LINK_PREVIEWS;
use crate::matrix_html::{display_html, strip_profile_fallback_body, strip_profile_fallback_html};
use crate::outgoing::message_content;
use crate::personas::PER_MESSAGE_PROFILE;
use crate::protocol::{
    EditVersionView, MessageKind, PerMessageProfileView, RpcError, TimelineItemView,
};
use crate::view::{
    FAMEDLY_FORWARDED, FORWARDED, SABLE_FORWARDED, SPOILER_PROPERTY, SPOILER_REASON_PROPERTY,
    per_message_profile, standalone_item,
};
use serde_with::{DefaultOnError, VecSkipError, serde_as};

pub(crate) fn outgoing_mentions(user_ids: Vec<OwnedUserId>, room: bool) -> Mentions {
    let mut mentions = Mentions::with_user_ids(user_ids);
    mentions.room = room;
    mentions
}

pub(crate) fn edit_content(
    body: String,
    formatted: Option<String>,
    kind: MessageKind,
    media_caption: bool,
    mentions: Vec<OwnedUserId>,
    room: bool,
) -> EditedContent {
    if media_caption {
        EditedContent::MediaCaption {
            caption: (!body.is_empty()).then_some(body),
            formatted_caption: formatted
                .map(matrix_sdk::ruma::events::room::message::FormattedBody::html),
            mentions: Some(outgoing_mentions(mentions, room)),
        }
    } else {
        EditedContent::RoomMessage(message_content(body, formatted, kind, mentions, room).into())
    }
}

fn spoiler_keys(event: &serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    [SPOILER_PROPERTY, SPOILER_REASON_PROPERTY]
        .into_iter()
        .filter_map(|key| {
            let value = event.get("content")?.get(key)?;
            Some((key.to_owned(), value.clone()))
        })
        .collect()
}

#[serde_as]
#[derive(serde::Deserialize)]
pub(crate) struct LenientPins {
    #[serde_as(as = "VecSkipError<_>")]
    #[serde(default)]
    pub(crate) pinned: Vec<OwnedEventId>,
}

fn unique_pins(events: Vec<OwnedEventId>) -> Vec<OwnedEventId> {
    let mut seen = std::collections::BTreeSet::new();
    events
        .into_iter()
        .filter(|event| seen.insert(event.clone()))
        .collect()
}

fn latest_message(event: &serde_json::Value) -> Option<&serde_json::Value> {
    let content = event.get("content")?;
    let replaces = content
        .get("m.relates_to")
        .and_then(|relation| relation.get("rel_type"))
        .and_then(serde_json::Value::as_str)
        == Some("m.replace");
    if replaces {
        content.get("m.new_content")
    } else {
        Some(content)
    }
}

fn preview_keys(event: &serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    let Some(content) = latest_message(event) else {
        return serde_json::Map::new();
    };
    [BUNDLED_LINK_PREVIEWS, LEGACY_BUNDLED_LINK_PREVIEWS]
        .into_iter()
        .filter_map(|key| {
            content
                .get(key)
                .map(|value| (key.to_owned(), value.clone()))
        })
        .collect()
}

pub(crate) fn previews_removed_edit(
    event_id: &EventId,
    event: &serde_json::Value,
) -> Option<serde_json::Value> {
    replacement_edit(event_id, event, |new_content| {
        for field in [BUNDLED_LINK_PREVIEWS, LEGACY_BUNDLED_LINK_PREVIEWS] {
            new_content.insert(field.to_owned(), serde_json::Value::Array(Vec::new()));
        }
    })
}

pub(crate) fn reprofiled_edit(
    event_id: &EventId,
    event: &serde_json::Value,
    persona: Option<&PerMessageProfileView>,
) -> Option<serde_json::Value> {
    replacement_edit(event_id, event, |new_content| {
        new_content.remove(PER_MESSAGE_PROFILE);
        new_content.remove("m.per_message_profile");
        if let Some(persona) = persona {
            let mut content = serde_json::Value::Object(std::mem::take(new_content));
            crate::personas::stamp_profile(
                &mut content,
                &crate::personas::without_fallback(persona),
            );
            if let serde_json::Value::Object(object) = content {
                *new_content = object;
            }
        }
    })
}

fn replacement_edit(
    event_id: &EventId,
    event: &serde_json::Value,
    update: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
) -> Option<serde_json::Value> {
    if event.get("type").and_then(serde_json::Value::as_str) != Some("m.room.message") {
        return None;
    }
    let mut new_content = latest_message(event)?.as_object()?.clone();
    new_content.remove("m.relates_to");
    update(&mut new_content);

    let mut edit = new_content.clone();
    for field in ["body", "formatted_body"] {
        if let Some(text) = edit.get(field).and_then(serde_json::Value::as_str) {
            let fallback = format!("* {text}");
            edit.insert(field.to_owned(), serde_json::Value::String(fallback));
        }
    }
    serde_json::to_value(ReplacementEditOut {
        fields: edit,
        mentions: serde_json::Map::new(),
        new_content,
        relates_to: ReplaceRelationOut::Replace {
            event_id: event_id.to_string(),
        },
    })
    .ok()
}

fn pretty_json(raw: &str) -> String {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| serde_json::to_string_pretty(&value).ok())
        .unwrap_or_else(|| raw.to_owned())
}

async fn retain_reply_mention(
    room: &matrix_sdk::Room,
    original: &serde_json::Value,
    latest: &serde_json::Value,
    edited: &mut EditedContent,
) {
    let Some(reply_id) = original
        .pointer("/m.relates_to/m.in_reply_to/event_id")
        .and_then(serde_json::Value::as_str)
        .and_then(|id| OwnedEventId::try_from(id).ok())
    else {
        return;
    };
    let Some(previous) = latest
        .get("m.mentions")
        .and_then(|value| serde_json::from_value::<Mentions>(value.clone()).ok())
        .filter(|mentions| !mentions.user_ids.is_empty())
    else {
        return;
    };
    // An unavailable reply target must not prevent editing the message.
    let Ok(reply) = room.load_or_fetch_event(&reply_id, None).await else {
        return;
    };
    let Some(sender) = reply
        .raw()
        .get_field::<OwnedUserId>("sender")
        .ok()
        .flatten()
        .filter(|sender| previous.user_ids.contains(sender))
    else {
        return;
    };
    let mentions = match edited {
        EditedContent::RoomMessage(message) => &mut message.mentions,
        EditedContent::MediaCaption { mentions, .. } => mentions,
        EditedContent::PollStart { .. } => return,
    };
    mentions
        .get_or_insert_with(Mentions::new)
        .user_ids
        .insert(sender);
}

impl Core {
    #[expect(clippy::too_many_arguments, reason = "mirrors the protocol fields")]
    pub(crate) async fn edit_message(
        &self,
        room_id: &OwnedRoomId,
        event_id: Option<OwnedEventId>,
        transaction_id: Option<String>,
        body: String,
        formatted: Option<String>,
        kind: MessageKind,
        media_caption: bool,
        thread_root: Option<OwnedEventId>,
        mentions: Vec<OwnedUserId>,
        mentions_room: bool,
        persona: Option<PerMessageProfileView>,
        forum_title: Option<String>,
    ) -> Result<(), RpcError> {
        let mut edited = edit_content(
            body,
            formatted,
            kind,
            media_caption,
            mentions,
            mentions_room,
        );

        let item_id = match (event_id, transaction_id) {
            (Some(event_id), None) => TimelineEventItemId::EventId(event_id),
            (None, Some(transaction_id)) => {
                TimelineEventItemId::TransactionId(transaction_id.into())
            }
            _ => return Err(RpcError::Unsupported),
        };
        if let TimelineEventItemId::TransactionId(transaction_id) = &item_id {
            let room = self.room(room_id).await?;
            let (echoes, _updates) = room
                .send_queue()
                .subscribe()
                .await
                .or_failed(self, "edit_message")?;
            if let Some(echo) = echoes
                .into_iter()
                .find(|echo| echo.transaction_id == *transaction_id)
                && let matrix_sdk::send_queue::LocalEchoContent::Event {
                    serialized_event, ..
                } = echo.content
            {
                let previous = serialized_event
                    .raw()
                    .0
                    .deserialize_as_unchecked::<serde_json::Value>()
                    .or_failed(self, "edit_message")?;
                retain_reply_mention(&room, &previous, &previous, &mut edited).await;
            }
            let queued = if let EditedContent::RoomMessage(message) = &edited {
                self.edit_local_message(&room, transaction_id, message.clone(), persona.as_ref())
                    .await?
            } else {
                false
            };
            if !queued {
                self.timeline_for(room_id, thread_root.as_ref())
                    .await?
                    .edit(&item_id, edited)
                    .await
                    .or_failed(self, "edit_message")?;
            }
        } else if let TimelineEventItemId::EventId(event_id) = item_id {
            let room = self.room(room_id).await?;
            let (event, replacements) = room
                .load_or_fetch_event_with_relations(
                    &event_id,
                    Some(vec![RelationType::Replacement]),
                    None,
                )
                .await
                .or_failed(self, "edit_message")?;
            let content = raw_content(&event).ok_or(RpcError::Unsupported)?;
            if [FORWARDED, FAMEDLY_FORWARDED, SABLE_FORWARDED]
                .iter()
                .any(|key| content.get(key).is_some())
            {
                return Err(RpcError::Unsupported);
            }
            let original = event
                .raw()
                .deserialize_as_unchecked::<serde_json::Value>()
                .or_failed(self, "edit_message")?;
            let latest = latest_valid_replacement(&event, &replacements)
                .unwrap_or(&event)
                .raw()
                .deserialize_as_unchecked::<serde_json::Value>()
                .or_failed(self, "edit_message")?;
            retain_reply_mention(
                &room,
                &content,
                latest_message(&latest).ok_or(RpcError::Unsupported)?,
                &mut edited,
            )
            .await;
            let content = room
                .make_edit_event(&event_id, edited)
                .await
                .or_failed(self, "edit_message")?;
            let mut retained = preview_keys(&latest);
            if media_caption {
                retained.extend(spoiler_keys(&original));
            }
            self.edit_with_persona(&room, &content, persona.as_ref(), forum_title, retained)
                .await?;
        }

        Ok(())
    }

    pub(crate) async fn remove_link_previews(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        thread_root: Option<&OwnedEventId>,
    ) -> Result<(), RpcError> {
        Box::pin(self.replace_own_message(
            room_id,
            event_id,
            thread_root,
            "remove_link_previews",
            |event| previews_removed_edit(event_id, event),
        ))
        .await
    }

    pub(crate) async fn reprofile_message(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        thread_root: Option<&OwnedEventId>,
        persona: Option<&PerMessageProfileView>,
    ) -> Result<(), RpcError> {
        Box::pin(self.replace_own_message(
            room_id,
            event_id,
            thread_root,
            "reprofile_message",
            |event| reprofiled_edit(event_id, event, persona),
        ))
        .await
    }

    async fn replace_own_message(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        thread_root: Option<&OwnedEventId>,
        context: &'static str,
        build: impl FnOnce(&serde_json::Value) -> Option<serde_json::Value>,
    ) -> Result<(), RpcError> {
        let item = self
            .timeline_for(room_id, thread_root)
            .await?
            .item_by_event_id(event_id)
            .await
            .ok_or(RpcError::Unsupported)?;
        if !item.is_own() {
            return Err(RpcError::Denied);
        }
        let event = item
            .latest_json()
            .or_else(|| item.original_json())
            .and_then(|raw| raw.deserialize_as_unchecked::<serde_json::Value>().ok())
            .ok_or(RpcError::Unsupported)?;
        let edit = build(&event).ok_or(RpcError::Unsupported)?;
        let raw = Raw::<AnyMessageLikeEventContent>::from_json_string(edit.to_string())
            .or_failed(self, context)?;
        self.room(room_id)
            .await?
            .send_queue()
            .send_raw(raw, "m.room.message".to_owned())
            .await
            .or_failed(self, context)?;
        Ok(())
    }

    /// Servers do not cascade a redaction to `m.replace` events, which keep the edited text.
    pub(crate) async fn redact_edits(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        reason: Option<&str>,
    ) -> Result<(), RpcError> {
        let room = self.room(room_id).await?;
        let (event, replacements) = match room
            .load_or_fetch_event_with_relations(
                event_id,
                Some(vec![RelationType::Replacement]),
                None,
            )
            .await
        {
            Ok(loaded) => loaded,
            Err(error) => {
                tracing::warn!(%event_id, "edits not loaded before redaction: {error}");
                return Ok(());
            }
        };
        for edit_id in valid_replacements(&event, &replacements).filter_map(TimelineEvent::event_id)
        {
            room.redact(edit_id, reason, None)
                .await
                .or_failed(self, "redact")?;
        }
        Ok(())
    }

    pub(crate) async fn delete_thread(
        &self,
        room_id: &OwnedRoomId,
        root_event_id: &OwnedEventId,
        reason: Option<&str>,
    ) -> Result<(), RpcError> {
        let room = self.room(room_id).await?;
        let mut event_ids = vec![root_event_id.clone()];
        let mut seen = HashSet::from([root_event_id.clone()]);
        let mut from = None;

        loop {
            let relations = room
                .relations(
                    root_event_id.clone(),
                    RelationsOptions {
                        from,
                        dir: Direction::Backward,
                        limit: Some(UInt::from(100u16)),
                        include_relations: IncludeRelations::RelationsOfType(RelationType::Thread),
                        recurse: false,
                    },
                )
                .await
                .or_failed(self, "delete_thread")?;

            for event in relations.chunk {
                let Ok(raw) = serde_json::from_str::<RawEventHead>(event.raw().json().get()) else {
                    continue;
                };
                if raw.redacted() {
                    continue;
                }
                let Some(event_id) = raw.event_id.as_deref() else {
                    continue;
                };
                let event_id = EventId::parse(event_id).or_failed(self, "delete_thread")?;
                if seen.insert(event_id.clone()) {
                    event_ids.push(event_id);
                }
            }

            let Some(next) = relations.next_batch_token else {
                break;
            };
            from = Some(next);
        }

        for event_id in event_ids {
            room.redact(&event_id, reason, None)
                .await
                .or_failed(self, "delete_thread")?;
        }
        Ok(())
    }

    pub(crate) async fn bulk_redact(
        &self,
        room_id: &OwnedRoomId,
        senders: &[String],
        after_ts: u64,
        event_types: &[String],
        reason: Option<&str>,
    ) -> Result<u32, RpcError> {
        let room = self.room(room_id).await?;
        let mut from: Option<String> = None;
        let mut redacted = 0;

        loop {
            let mut options = MessagesOptions::backward().from(from.as_deref());
            options.limit = UInt::from(100u16);
            let messages = room
                .messages(options)
                .await
                .or_failed(self, "bulk_redact")?;
            if messages.chunk.is_empty() {
                break;
            }

            let mut older_than_cutoff = true;
            for event in messages.chunk {
                let Ok(raw) = serde_json::from_str::<RawEventHead>(event.raw().json().get()) else {
                    continue;
                };
                let ts = raw.origin_server_ts.unwrap_or_default();
                if ts >= after_ts {
                    older_than_cutoff = false;
                }
                if ts < after_ts
                    || !senders
                        .iter()
                        .any(|sender| raw.sender.as_deref() == Some(sender))
                    || (!event_types.is_empty()
                        && !event_types
                            .iter()
                            .any(|event_type| raw.event_type.as_deref() == Some(event_type)))
                    || raw.redacted()
                {
                    continue;
                }

                let Some(event_id) = raw.event_id.as_deref() else {
                    continue;
                };
                let event_id = EventId::parse(event_id).or_failed(self, "bulk_redact")?;
                room.redact(&event_id, reason, None)
                    .await
                    .or_failed(self, "bulk_redact")?;
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
    ) -> Result<Vec<OwnedEventId>, RpcError> {
        let room = self.room(room_id).await?;
        if let Some(events) = room.pinned_event_ids() {
            return Ok(unique_pins(events));
        }
        if let Some(events) = self
            .probed_pinned_rooms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(room_id)
        {
            return Ok(events.clone());
        }
        let events = self.load_pinned(&room, "pinned_events").await?;
        self.remember_pinned(room_id, &events);
        Ok(events)
    }

    async fn load_pinned(
        &self,
        room: &matrix_sdk::Room,
        context: &str,
    ) -> Result<Vec<OwnedEventId>, RpcError> {
        let response = match room
            .client()
            .send(get_state_event_for_key::v3::Request::new(
                room.room_id().to_owned(),
                StateEventType::RoomPinnedEvents,
                String::new(),
            ))
            .await
        {
            Ok(response) => response,
            Err(error)
                if error.as_client_api_error().is_some_and(|api_error| {
                    api_error.status_code == http::StatusCode::NOT_FOUND
                }) =>
            {
                return Ok(Vec::new());
            }
            Err(error) => return Err(self.homeserver_http_error(context, error)),
        };
        let lenient = response
            .into_content()
            .deserialize_as_unchecked::<LenientPins>()
            .or_failed(self, context)?;
        Ok(unique_pins(lenient.pinned))
    }

    fn remember_pinned(&self, room_id: &OwnedRoomId, events: &[OwnedEventId]) {
        self.probed_pinned_rooms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(room_id.clone(), events.to_vec());
    }

    pub(crate) async fn set_pinned(
        &self,
        room_id: &OwnedRoomId,
        event_id: OwnedEventId,
        pinned: bool,
    ) -> Result<Vec<OwnedEventId>, RpcError> {
        let _guard = self.account_data_lock.lock().await;
        let room = self.room(room_id).await?;
        // The SDK's pin_event/unpin_event start from the locally cached list,
        // which can lag the server and would drop pins it has not seen.
        let mut events = self.load_pinned(&room, "set_pinned").await?;
        let changed = if pinned {
            let missing = !events.contains(&event_id);
            if missing {
                events.push(event_id);
            }
            missing
        } else {
            let before = events.len();
            events.retain(|id| *id != event_id);
            events.len() != before
        };
        if changed {
            room.send_state_event(RoomPinnedEventsEventContent::new(events))
                .await
                .map_err(|error| self.room_error("set_pinned", error))?;
        }

        let events = self.load_pinned(&room, "set_pinned").await?;
        self.remember_pinned(room_id, &events);
        Ok(events)
    }

    pub(crate) async fn report_message(
        &self,
        room_id: &OwnedRoomId,
        event_id: OwnedEventId,
        reason: Option<String>,
    ) -> Result<(), RpcError> {
        let room = self.room(room_id).await?;
        let mut request = report_content::v3::Request::new(room.room_id().to_owned(), event_id);
        request.reason = reason;

        room.client()
            .send(request)
            .await
            .or_failed(self, "report_message")?;

        Ok(())
    }

    pub(crate) async fn report_room(
        &self,
        ReportParams { room_id, reason }: ReportParams,
    ) -> Result<(), RpcError> {
        self.client()
            .await?
            .send(report_room::v3::Request::new(room_id, reason))
            .await
            .map_err(|error| self.homeserver_http_error("report_room", error))?;
        Ok(())
    }

    pub(crate) async fn report_user(
        &self,
        ReportUserParams { user_id, reason }: ReportUserParams,
    ) -> Result<(), RpcError> {
        self.client()
            .await?
            .send(report_user::v3::Request::new(user_id, reason))
            .await
            .map_err(|error| self.homeserver_http_error("report_user", error))?;
        Ok(())
    }

    pub(crate) async fn event_source(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        include_original: bool,
    ) -> Result<(String, bool, Option<String>), RpcError> {
        let event = self
            .room(room_id)
            .await?
            .event(event_id, None)
            .await
            .or_failed(self, "event_source")?;

        let encrypted = event.encryption_info().is_some();
        let original = if encrypted && include_original {
            match self
                .client()
                .await?
                .send(get_room_event::v3::Request::new(
                    room_id.clone(),
                    event_id.clone(),
                ))
                .await
            {
                Ok(response) => Some(pretty_json(response.event.json().get())),
                Err(error) => {
                    tracing::debug!("encrypted original unavailable: {error}");
                    None
                }
            }
        } else {
            None
        };
        Ok((pretty_json(event.raw().json().get()), encrypted, original))
    }

    pub(crate) async fn forward_message(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        to_room_id: &OwnedRoomId,
        persona: Option<&PerMessageProfileView>,
        include_metadata: bool,
    ) -> Result<(), RpcError> {
        let source = self.room(room_id).await?;
        let (event, replacements) = source
            .load_or_fetch_event_with_relations(
                event_id,
                Some(vec![RelationType::Replacement]),
                None,
            )
            .await
            .or_failed(self, "forward_message")?;

        let raw = event
            .raw()
            .deserialize()
            .or_failed(self, "forward_message")?;

        let AnySyncTimelineEvent::MessageLike(message) = raw else {
            return Err(RpcError::Unsupported);
        };
        let event_type = match message.original_content() {
            Some(AnyMessageLikeEventContent::RoomMessage(_)) => "m.room.message",
            Some(AnyMessageLikeEventContent::Sticker(_)) => "m.sticker",
            _ => return Err(RpcError::Unsupported),
        };

        let original = raw_content(&event).ok_or(RpcError::Unsupported)?;
        let is_forward = [FORWARDED, FAMEDLY_FORWARDED, SABLE_FORWARDED]
            .iter()
            .any(|key| original.get(key).is_some());
        let edited = (!is_forward && event_type == "m.room.message")
            .then(|| latest_valid_replacement(&event, &replacements))
            .flatten()
            .and_then(|edit| {
                let edit =
                    serde_json::from_str::<serde_json::Value>(edit.raw().json().get()).ok()?;
                latest_message(&edit)?.as_object().cloned()
            });
        let source_content = match (edited, original) {
            (Some(edited), _) => edited,
            (None, serde_json::Value::Object(original)) => original,
            (None, _) => return Err(RpcError::Unsupported),
        };

        let public = matches!(source.join_rule(), Some(JoinRule::Public));
        let mut origin = serde_json::Map::new();
        if include_metadata {
            origin.insert(
                "origin_server_ts".to_owned(),
                u64::from(message.origin_server_ts().0).into(),
            );
        }
        if include_metadata && public {
            origin.insert("event_id".to_owned(), event_id.to_string().into());
            origin.insert("room_id".to_owned(), room_id.to_string().into());
            origin.insert("sender".to_owned(), message.sender().to_string().into());
        }
        let attributed = prior_forward(&source_content)
            .and_then(|prior| prior.get("sender")?.as_str()?.parse::<OwnedUserId>().ok())
            .unwrap_or_else(|| message.sender().to_owned());
        let sender_name = source
            .get_member_no_sync(&attributed)
            .await
            .ok()
            .flatten()
            .and_then(|member| {
                member
                    .display_name()
                    .and_then(visible_name)
                    .map(ToOwned::to_owned)
            });
        let route = source.route().await.unwrap_or_default();
        let mut content = serde_json::Value::Object(forward_content_for_event(
            source_content,
            origin,
            event_type,
            &route,
            sender_name.as_deref(),
        ));

        if let Some(profile) = persona {
            crate::personas::stamp_profile(
                &mut content,
                &crate::personas::without_fallback(profile),
            );
        }

        self.room(to_room_id)
            .await?
            .send_raw(event_type, content)
            .await
            .or_failed(self, "forward_message")?;

        Ok(())
    }

    pub(crate) async fn edit_history(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
    ) -> Result<Vec<EditVersionView>, RpcError> {
        let (event, replacements) = self
            .room(room_id)
            .await?
            .load_or_fetch_event_with_relations(
                event_id,
                Some(vec![RelationType::Replacement]),
                None,
            )
            .await
            .or_failed(self, "edit_history")?;

        let mut edits: Vec<EditVersionView> = valid_replacements(&event, &replacements)
            .filter_map(|replacement| edit_version(replacement, true))
            .collect();
        edits.sort_by_key(|version| version.timestamp);

        Ok(edit_version(&event, false)
            .into_iter()
            .chain(edits)
            .collect())
    }

    pub(crate) async fn watch_pinned(&self, room_id: &OwnedRoomId) {
        if self
            .pinned_caches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(room_id)
        {
            return;
        }
        let Ok(room) = self.room(room_id).await else {
            return;
        };
        let client = room.client();
        let Some(event_cache) = client.event_cache() else {
            return;
        };
        match event_cache.pinned_events(room_id).await {
            Ok(entry) => {
                self.pinned_caches
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(room_id.clone(), entry);
            }
            Err(error) => tracing::debug!(%room_id, "pinned events cache unavailable: {error}"),
        }
    }

    async fn pinned_snapshot(
        &self,
        room_id: &OwnedRoomId,
    ) -> HashMap<OwnedEventId, (TimelineEvent, Vec<TimelineEvent>)> {
        let cache = self
            .pinned_caches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(room_id)
            .map(|(cache, _)| cache.clone());
        let Some(cache) = cache else {
            return HashMap::new();
        };
        let Ok((events, _)) = cache.subscribe().await else {
            return HashMap::new();
        };

        let mut targets = HashMap::new();
        let mut edits = Vec::new();
        for event in events {
            if let Some(target) = replaced_event(&event) {
                edits.push((target, event));
            } else if let Some(event_id) = event.event_id().map(ToOwned::to_owned) {
                targets.insert(event_id, (event, Vec::new()));
            }
        }
        for (target, edit) in edits {
            if let Some((_, replacements)) = targets.get_mut(&target) {
                replacements.push(edit);
            }
        }
        targets
    }

    pub(crate) async fn event_items(
        &self,
        room_id: &OwnedRoomId,
        event_ids: &[OwnedEventId],
    ) -> Result<Vec<TimelineItemView>, RpcError> {
        let room = self.room(room_id).await?;
        let push = room.push_context().await.ok().flatten();
        let cached = self.pinned_snapshot(room_id).await;
        let (room, push, cached) = (&room, push.as_ref(), &cached);
        let mut items = Vec::with_capacity(event_ids.len());
        for chunk in event_ids.chunks(PINNED_FETCH_CONCURRENCY) {
            let loaded = join_all(chunk.iter().map(|event_id| async move {
                let (event, replacements) = match cached.get(event_id) {
                    Some(hit) => hit.clone(),
                    None => room
                        .load_or_fetch_event_with_relations(
                            event_id,
                            Some(vec![RelationType::Replacement]),
                            None,
                        )
                        .await
                        .inspect_err(|error| {
                            tracing::debug!(%event_id, "event item unavailable: {error}");
                        })
                        .ok()?,
                };
                let latest = latest_valid_replacement(&event, &replacements).cloned();
                standalone_item(self, room, event, latest, push).await
            }))
            .await;
            items.extend(loaded.into_iter().flatten());
        }
        Ok(items)
    }
}

/// A wrong-typed field reads as missing; an event that is not an object is skipped.
#[serde_as]
#[derive(serde::Deserialize)]
struct RawEventHead {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    event_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    origin_server_ts: Option<u64>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    sender: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "type", default)]
    event_type: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    unsigned: Option<serde_json::Map<String, serde_json::Value>>,
}

impl RawEventHead {
    fn redacted(&self) -> bool {
        self.unsigned
            .as_ref()
            .is_some_and(|unsigned| unsigned.contains_key("redacted_because"))
    }
}

const PINNED_FETCH_CONCURRENCY: usize = 10;

fn replaced_event(event: &TimelineEvent) -> Option<OwnedEventId> {
    let content = event
        .raw()
        .get_field::<serde_json::Value>("content")
        .ok()
        .flatten()?;
    let relation = content.get("m.relates_to")?;
    if relation.get("rel_type")?.as_str()? != "m.replace" {
        return None;
    }
    relation.get("event_id")?.as_str()?.parse().ok()
}

fn valid_replacements<'a>(
    event: &'a TimelineEvent,
    replacements: &'a [TimelineEvent],
) -> impl Iterator<Item = &'a TimelineEvent> {
    replacements.iter().filter(|replacement| {
        matrix_sdk::check_validity_of_replacement_events(
            event.raw(),
            event.encryption_info().map(|info| &**info),
            replacement.raw(),
            replacement.encryption_info().map(|info| &**info),
        )
        .is_ok()
    })
}

pub(crate) fn latest_valid_replacement<'a>(
    event: &'a TimelineEvent,
    replacements: &'a [TimelineEvent],
) -> Option<&'a TimelineEvent> {
    valid_replacements(event, replacements).max_by_key(|replacement| {
        replacement
            .raw()
            .get_field::<MilliSecondsSinceUnixEpoch>("origin_server_ts")
            .ok()
            .flatten()
    })
}

fn edit_version(event: &TimelineEvent, replacement: bool) -> Option<EditVersionView> {
    let raw = serde_json::from_str::<serde_json::Value>(event.raw().json().get()).ok()?;
    let content = raw.get("content")?;
    let content = if replacement {
        content.get("m.new_content")?
    } else {
        content
    };
    let formatted = content
        .get("format")
        .and_then(serde_json::Value::as_str)
        .filter(|format| *format == "org.matrix.custom.html")
        .and_then(|_| content.get("formatted_body")?.as_str());
    let profile = per_message_profile(Some(content)).filter(|profile| profile.has_fallback);
    let fallback = profile
        .as_ref()
        .and_then(|profile| profile.display_name.as_deref());
    let body = strip_profile_fallback_body(
        content
            .get("body")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default(),
        fallback,
    );
    let formatted = formatted.map(|formatted| strip_profile_fallback_html(formatted, fallback));

    Some(EditVersionView {
        event_id: event.event_id()?.to_string(),
        timestamp: event.timestamp().map_or(0, |ts| u64::from(ts.0)),
        html: display_html(&body, formatted.as_deref()),
        body,
    })
}

/// `fields` comes first so the explicit keys below override any copy of them.
#[derive(serde::Serialize)]
struct ReplacementEditOut {
    #[serde(flatten)]
    fields: serde_json::Map<String, serde_json::Value>,
    #[serde(rename = "m.mentions")]
    mentions: serde_json::Map<String, serde_json::Value>,
    #[serde(rename = "m.new_content")]
    new_content: serde_json::Map<String, serde_json::Value>,
    #[serde(rename = "m.relates_to")]
    relates_to: ReplaceRelationOut,
}

#[derive(serde::Serialize)]
#[serde(tag = "rel_type")]
enum ReplaceRelationOut {
    #[serde(rename = "m.replace")]
    Replace { event_id: String },
}

pub(crate) fn raw_content(event: &TimelineEvent) -> Option<serde_json::Value> {
    event
        .raw()
        .get_field::<serde_json::Value>("content")
        .ok()
        .flatten()
}

fn is_valid_forward_content(content: &serde_json::Value, event_type: &str) -> bool {
    match event_type {
        "m.room.message" => {
            serde_json::from_value::<RoomMessageEventContent>(content.clone()).is_ok()
        }
        "m.sticker" => serde_json::from_value::<StickerEventContent>(content.clone()).is_ok(),
        _ => false,
    }
}

fn prior_forward(
    content: &serde_json::Map<String, serde_json::Value>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    if let Some(serde_json::Value::Object(forwarded)) = content.get(FORWARDED) {
        return Some(forwarded.clone());
    }
    let serde_json::Value::Object(famedly) = content.get(FAMEDLY_FORWARDED)? else {
        return None;
    };
    Some(
        famedly
            .iter()
            .filter(|(key, value)| match key.as_str() {
                "event_id" | "room_id" | "sender" => value.is_string(),
                "origin_server_ts" => value.is_u64(),
                _ => false,
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    )
}

fn strip_reply_fallback(content: &mut serde_json::Map<String, serde_json::Value>) {
    if let Some(serde_json::Value::String(body)) = content.get_mut("body") {
        *body =
            matrix_sdk::ruma::events::room::message::sanitize::remove_plain_reply_fallback(body)
                .to_owned();
    }
    let html = content
        .get("format")
        .is_some_and(|format| format == "org.matrix.custom.html");
    if html && let Some(serde_json::Value::String(formatted)) = content.get_mut("formatted_body") {
        *formatted = matrix_sdk::ruma::html::remove_html_reply_fallback(formatted);
    }
}

#[cfg(test)]
fn forward_content(
    source: serde_json::Map<String, serde_json::Value>,
    origin: serde_json::Map<String, serde_json::Value>,
    route: &[OwnedServerName],
    sender_name: Option<&str>,
) -> serde_json::Map<String, serde_json::Value> {
    forward_content_for_event(source, origin, "m.room.message", route, sender_name)
}

fn forward_content_for_event(
    mut source: serde_json::Map<String, serde_json::Value>,
    origin: serde_json::Map<String, serde_json::Value>,
    event_type: &str,
    route: &[OwnedServerName],
    sender_name: Option<&str>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut forwarded = prior_forward(&source).unwrap_or(origin);
    if !forwarded
        .get("content")
        .is_some_and(|content| is_valid_forward_content(content, event_type))
    {
        for key in [FORWARDED, FAMEDLY_FORWARDED, SABLE_FORWARDED] {
            source.remove(key);
        }
        strip_reply_fallback(&mut source);
        forwarded.insert("content".to_owned(), serde_json::Value::Object(source));
    }

    let mut fallback = forwarded
        .get("content")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    for key in [
        "m.relates_to",
        "m.mentions",
        "m.new_content",
        FORWARDED,
        FAMEDLY_FORWARDED,
        SABLE_FORWARDED,
    ] {
        fallback.remove(key);
    }
    add_forward_fallback(&mut fallback, &forwarded, route, sender_name);
    fallback.insert(
        "m.mentions".to_owned(),
        serde_json::Value::Object(serde_json::Map::new()),
    );
    fallback.insert(
        SABLE_FORWARDED.to_owned(),
        serde_json::Value::Object(sable_forward(&forwarded)),
    );
    fallback.insert(FORWARDED.to_owned(), serde_json::Value::Object(forwarded));
    fallback
}

fn sable_forward(
    forwarded: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut sable = serde_json::Map::new();
    sable.insert("v".to_owned(), 1.into());
    sable.insert("is_forwarded".to_owned(), true.into());
    for (from, to) in [
        ("origin_server_ts", "original_timestamp"),
        ("room_id", "original_room_id"),
        ("event_id", "original_event_id"),
    ] {
        if let Some(value) = forwarded.get(from) {
            sable.insert(to.to_owned(), value.clone());
        }
    }
    let public = forwarded.contains_key("room_id") && forwarded.contains_key("event_id");
    sable.insert("original_event_private".to_owned(), (!public).into());
    sable
}

const URI_COMPONENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'!')
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

fn matrix_to(id: &str) -> String {
    percent_encoding::utf8_percent_encode(id, URI_COMPONENT).to_string()
}

fn html_text(text: &str) -> String {
    html_escape::encode_text(text).replace('\n', "<br>")
}

fn user_link(sender: &UserId, text: &str) -> String {
    format!(
        "<a href=\"https://matrix.to/#/{}\">{}</a>",
        matrix_to(sender.as_str()),
        html_escape::encode_text(text)
    )
}

fn original_permalink(
    forwarded: &serde_json::Map<String, serde_json::Value>,
    route: &[OwnedServerName],
) -> Option<String> {
    let id = |key| forwarded.get(key).and_then(serde_json::Value::as_str);
    let room = RoomId::parse(id("room_id")?).ok()?;
    let event = EventId::parse(id("event_id")?).ok()?;
    let via: Vec<String> = route.iter().map(|server| format!("via={server}")).collect();
    let query = if via.is_empty() {
        String::new()
    } else {
        format!("?{}", via.join("&"))
    };
    Some(format!(
        "https://matrix.to/#/{}/{}{query}",
        matrix_to(room.as_str()),
        matrix_to(event.as_str())
    ))
}

fn forward_headers(sender: Option<&UserId>, permalink: Option<&str>) -> (String, String) {
    let mut plain = sender.map_or_else(
        || "Forwarded message".to_owned(),
        |sender| format!("Forwarded from {sender}"),
    );
    let mut rich = sender.map_or_else(
        || "Forwarded message".to_owned(),
        |sender| format!("Forwarded from {}", user_link(sender, sender.as_str())),
    );
    if let Some(permalink) = permalink {
        plain.push_str(" - view original message: ");
        plain.push_str(permalink);
        rich = format!(
            "{rich} - <a href=\"{}\">view original message</a>",
            html_escape::encode_double_quoted_attribute(permalink)
        );
    }
    (plain, format!("<strong>{rich}</strong>"))
}

fn add_forward_fallback(
    content: &mut serde_json::Map<String, serde_json::Value>,
    forwarded: &serde_json::Map<String, serde_json::Value>,
    route: &[OwnedServerName],
    sender_name: Option<&str>,
) {
    let Some(source) = forwarded
        .get("content")
        .and_then(serde_json::Value::as_object)
    else {
        return;
    };
    let field = |key: &str| source.get(key).and_then(serde_json::Value::as_str);
    let body = field("body").unwrap_or_default();
    let html = field("formatted_body")
        .filter(|_| field("format") == Some("org.matrix.custom.html"))
        .map_or_else(|| html_text(body), ToOwned::to_owned);
    let sender = forwarded
        .get("sender")
        .and_then(serde_json::Value::as_str)
        .and_then(|sender| UserId::parse(sender).ok());

    let (quoted, quoted_html) = match field("msgtype") {
        Some("m.text" | "m.notice") => (body.to_owned(), html),
        Some("m.emote") => {
            content.insert("msgtype".to_owned(), "m.text".into());
            let (actor, actor_html) = sender.as_ref().map_or_else(
                || ("Sender".to_owned(), "Sender".to_owned()),
                |sender| {
                    let name = sender_name.unwrap_or_else(|| sender.as_str());
                    (name.to_owned(), user_link(sender, name))
                },
            );
            (
                format!("{actor} {body}"),
                format!("<em><strong>{actor_html}</strong> {html}</em>"),
            )
        }
        Some("m.image" | "m.file" | "m.audio" | "m.video") => {
            content.insert(
                "filename".to_owned(),
                field("filename").unwrap_or(body).into(),
            );
            if field("filename").is_some_and(|name| name != body) {
                (body.to_owned(), html)
            } else {
                (String::new(), String::new())
            }
        }
        _ => return,
    };

    let (mut plain, mut rich) = forward_headers(
        sender.as_deref(),
        original_permalink(forwarded, route).as_deref(),
    );
    if !quoted.is_empty() {
        plain.push('\n');
        plain.push_str(&quoted);
        rich = format!("{rich}<br><blockquote>{quoted_html}</blockquote>");
    }
    content.insert("body".to_owned(), plain.into());
    content.insert("format".to_owned(), "org.matrix.custom.html".into());
    content.insert("formatted_body".to_owned(), rich.into());
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use matrix_sdk::{
        ruma::{event_id, room_id, user_id},
        test_utils::mocks::MatrixMockServer,
    };
    use matrix_sdk_ui::sync_service::SyncService;
    use serde_json::{Value, json};

    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };

    #[test]
    fn a_caption_edit_keeps_the_spoiler_and_its_reason() {
        let event = json!({"content": {
            "body": "photo.png",
            "page.codeberg.everypizza.msc4193.spoiler": true,
            "page.codeberg.everypizza.msc4193.spoiler.reason": "plot",
        }});

        let kept = super::spoiler_keys(&event);

        assert_eq!(kept.len(), 2);
        assert_eq!(
            kept["page.codeberg.everypizza.msc4193.spoiler.reason"],
            "plot"
        );
        assert!(super::spoiler_keys(&json!({"content": {"body": "x"}})).is_empty());
    }

    use crate::{Core, session::Session, store::MemorySessionStore};

    fn object(value: Value) -> serde_json::Map<String, Value> {
        let Value::Object(map) = value else {
            panic!("expected an object")
        };
        map
    }

    #[test]
    fn forwarding_writes_msc4553_with_the_original_content() {
        let source = object(json!({
            "msgtype": "m.text",
            "body": "> <@bob:x> quoted\n\nanswer",
            "format": "org.matrix.custom.html",
            "formatted_body": "<mx-reply><blockquote>quoted</blockquote></mx-reply>answer",
            "m.relates_to": { "m.in_reply_to": { "event_id": "$parent" } },
            "m.mentions": { "user_ids": ["@bob:x"] },
            "page.codeberg.everypizza.msc4193.spoiler": true,
        }));
        let origin = object(
            json!({ "origin_server_ts": 7, "room_id": "!r:x", "event_id": "$e", "sender": "@alice:x" }),
        );

        let content = Value::Object(super::forward_content(source, origin, &[], None));

        assert_eq!(
            content["org.matrix.msc4553.forwarded"],
            json!({
                "origin_server_ts": 7, "room_id": "!r:x", "event_id": "$e", "sender": "@alice:x",
                "content": {
                    "msgtype": "m.text",
                    "body": "answer",
                    "format": "org.matrix.custom.html",
                    "formatted_body": "answer",
                    "m.relates_to": { "m.in_reply_to": { "event_id": "$parent" } },
                    "m.mentions": { "user_ids": ["@bob:x"] },
                    "page.codeberg.everypizza.msc4193.spoiler": true,
                }
            })
        );
        assert_eq!(
            content["body"],
            "Forwarded from @alice:x - view original message: https://matrix.to/#/!r%3Ax/%24e\nanswer"
        );
        assert_eq!(
            content["formatted_body"],
            "<strong>Forwarded from <a href=\"https://matrix.to/#/%40alice%3Ax\">@alice:x</a> - <a href=\"https://matrix.to/#/!r%3Ax/%24e\">view original message</a></strong><br><blockquote>answer</blockquote>"
        );
        assert_eq!(content["format"], "org.matrix.custom.html");
        assert_eq!(content["m.mentions"], json!({}));
        assert_eq!(content["page.codeberg.everypizza.msc4193.spoiler"], true);
        assert!(content.get("m.relates_to").is_none());
        assert!(content.get("com.famedly.app.forwarded").is_none());
        assert_eq!(
            content["moe.sable.message.forward"],
            json!({
                "v": 1,
                "is_forwarded": true,
                "original_timestamp": 7,
                "original_room_id": "!r:x",
                "original_event_id": "$e",
                "original_event_private": false,
            })
        );
    }

    #[test]
    fn forwarding_a_sticker_keeps_its_event_content_without_a_text_fallback() {
        let sticker = json!({
            "body": "seal",
            "url": "mxc://example.org/seal",
            "info": {}
        });
        let content = Value::Object(super::forward_content_for_event(
            object(sticker.clone()),
            object(json!({ "origin_server_ts": 7 })),
            "m.sticker",
            &[],
            None,
        ));

        assert_eq!(content["body"], "seal");
        assert!(content.get("format").is_none());
        assert_eq!(content["m.mentions"], json!({}));
        assert_eq!(content["org.matrix.msc4553.forwarded"]["content"], sticker);
        assert!(super::is_valid_forward_content(
            &content["org.matrix.msc4553.forwarded"]["content"],
            "m.sticker"
        ));
    }

    #[test]
    fn forwarding_from_a_private_room_omits_the_ids_in_both_objects() {
        let source = object(json!({ "msgtype": "m.text", "body": "hi" }));
        let origin = object(json!({ "origin_server_ts": 7 }));

        let content = Value::Object(super::forward_content(source, origin, &[], None));

        assert_eq!(content["body"], "Forwarded message\nhi");
        assert_eq!(
            content["moe.sable.message.forward"],
            json!({
                "v": 1,
                "is_forwarded": true,
                "original_timestamp": 7,
                "original_event_private": true,
            })
        );
        assert_eq!(
            content["org.matrix.msc4553.forwarded"]["origin_server_ts"],
            7
        );
        assert!(
            content["org.matrix.msc4553.forwarded"]
                .get("room_id")
                .is_none()
        );
    }

    #[test]
    fn the_original_permalink_carries_the_routing_servers() {
        let route = [
            matrix_sdk::ruma::server_name!("a.example").to_owned(),
            matrix_sdk::ruma::server_name!("b.example").to_owned(),
        ];
        let origin = object(json!({ "room_id": "!r:x", "event_id": "$e" }));

        let content = super::forward_content(
            object(json!({ "msgtype": "m.text", "body": "hi" })),
            origin,
            &route,
            None,
        );

        assert_eq!(
            content["body"],
            "Forwarded message - view original message: https://matrix.to/#/!r%3Ax/%24e?via=a.example&via=b.example\nhi"
        );
    }

    #[test]
    fn a_forwarded_emote_reads_as_text_by_its_sender() {
        let source = object(json!({ "msgtype": "m.emote", "body": "waves" }));
        let origin = object(json!({ "sender": "@alice:example.org" }));

        let content = Value::Object(super::forward_content(source, origin, &[], Some("Alice")));

        assert_eq!(content["msgtype"], "m.text");
        assert_eq!(
            content["body"],
            "Forwarded from @alice:example.org\nAlice waves"
        );
        assert_eq!(
            content["formatted_body"],
            "<strong>Forwarded from <a href=\"https://matrix.to/#/%40alice%3Aexample.org\">@alice:example.org</a></strong><br><blockquote><em><strong><a href=\"https://matrix.to/#/%40alice%3Aexample.org\">Alice</a></strong> waves</em></blockquote>"
        );
        assert_eq!(
            content["org.matrix.msc4553.forwarded"]["content"]["msgtype"],
            "m.emote"
        );

        let anonymous = Value::Object(super::forward_content(
            object(json!({ "msgtype": "m.emote", "body": "waves" })),
            object(json!({})),
            &[],
            None,
        ));
        assert_eq!(anonymous["body"], "Forwarded message\nSender waves");
    }

    #[test]
    fn a_forwarded_file_moves_its_name_to_filename_and_keeps_no_caption() {
        let source = object(json!({
            "msgtype": "m.file", "body": "agenda.pdf", "url": "mxc://example.org/agenda"
        }));
        let origin = object(json!({ "sender": "@alice:example.org" }));

        let content = Value::Object(super::forward_content(source, origin, &[], None));

        assert_eq!(content["filename"], "agenda.pdf");
        assert_eq!(content["body"], "Forwarded from @alice:example.org");
        assert_eq!(content["url"], "mxc://example.org/agenda");

        let captioned = Value::Object(super::forward_content(
            object(json!({ "msgtype": "m.image", "body": "sunset", "filename": "a.png" })),
            object(json!({})),
            &[],
            None,
        ));
        assert_eq!(captioned["filename"], "a.png");
        assert_eq!(captioned["body"], "Forwarded message\nsunset");
    }

    #[test]
    fn a_location_keeps_its_own_body() {
        let content = Value::Object(super::forward_content(
            object(json!({ "msgtype": "m.location", "body": "Cafe", "geo_uri": "geo:1,2" })),
            object(json!({})),
            &[],
            None,
        ));

        assert_eq!(content["body"], "Cafe");
        assert!(content.get("formatted_body").is_none());
    }

    #[test]
    fn forwarding_a_forward_keeps_the_original_attribution() {
        let forwarded = json!({
            "sender": "@alice:x",
            "origin_server_ts": 1,
            "content": {
                "msgtype": "m.text",
                "body": "original",
                "m.relates_to": { "m.in_reply_to": { "event_id": "$parent" } },
                "m.mentions": { "user_ids": ["@carol:x"] }
            }
        });
        let source = object(json!({
            "msgtype": "m.text",
            "body": "fallback",
            "m.mentions": {},
            "org.matrix.msc4553.forwarded": forwarded,
        }));
        let origin = object(json!({ "origin_server_ts": 9, "sender": "@bob:x" }));

        let content = Value::Object(super::forward_content(source, origin, &[], None));

        assert_eq!(content["org.matrix.msc4553.forwarded"], forwarded);
        assert_eq!(content["body"], "Forwarded from @alice:x\noriginal");
        assert_eq!(content["m.mentions"], json!({}));
        assert!(content.get("m.relates_to").is_none());
    }

    #[test]
    fn forwarding_a_legacy_forward_keeps_its_origin_and_fills_the_content() {
        let source = object(json!({
            "msgtype": "m.text",
            "body": "hello",
            "com.famedly.app.forwarded": { "origin_server_ts": 1, "room_id": null, "event_id": "$e" },
            "moe.sable.message.forward": { "original_timestamp": 1, "original_event_private": true },
        }));
        let origin = object(json!({ "origin_server_ts": 9 }));

        let content = Value::Object(super::forward_content(source, origin, &[], None));

        assert_eq!(
            content["org.matrix.msc4553.forwarded"],
            json!({
                "origin_server_ts": 1,
                "event_id": "$e",
                "content": { "msgtype": "m.text", "body": "hello" }
            })
        );
        assert!(content.get("com.famedly.app.forwarded").is_none());
        assert_eq!(
            content["moe.sable.message.forward"],
            json!({
                "v": 1,
                "is_forwarded": true,
                "original_timestamp": 1,
                "original_event_id": "$e",
                "original_event_private": true,
            })
        );
    }

    #[test]
    fn reprofiling_a_gallery_replaces_its_profile_without_a_name_prefix() {
        let gallery = json!({
            "type": "m.room.message",
            "content": { "msgtype": "dev.mscxxxx.gallery", "body": "trip", "itemtypes": [] },
        });
        let persona = crate::protocol::PerMessageProfileView {
            id: Some("p".to_owned()),
            display_name: Some("Kris".to_owned()),
            avatar_url: None,
            pronouns: Vec::new(),
            color_on_light: None,
            color_on_dark: None,
            has_fallback: true,
            biography: None,
            banner_url: None,
            is_animal: None,
            has_animal: None,
            animal_need: None,
        };
        let edit = super::reprofiled_edit(event_id!("$event"), &gallery, Some(&persona)).unwrap();

        let new_content = &edit["m.new_content"];
        assert_eq!(new_content["body"], "trip");
        assert!(new_content.get("formatted_body").is_none());
        assert_eq!(
            new_content[crate::personas::PER_MESSAGE_PROFILE]["displayname"],
            "Kris"
        );
        assert_eq!(
            edit["m.relates_to"],
            json!({ "rel_type": "m.replace", "event_id": "$event" })
        );

        let cleared = super::reprofiled_edit(
            event_id!("$event"),
            &json!({ "type": "m.room.message", "content": edit }),
            None,
        )
        .unwrap();
        assert!(
            cleared["m.new_content"]
                .get(crate::personas::PER_MESSAGE_PROFILE)
                .is_none()
        );
    }

    #[test]
    fn removing_previews_edits_the_latest_version_with_an_empty_list() {
        let original = json!({
            "type": "m.room.message",
            "content": {
                "msgtype": "m.text",
                "body": "see https://example.org",
                "m.relates_to": { "m.in_reply_to": { "event_id": "$parent" } },
                "com.beeper.linkpreviews": [{ "matched_url": "https://example.org" }],
                "com.beeper.per_message_profile": { "id": "p" },
            },
        });
        let edit = super::previews_removed_edit(event_id!("$event"), &original).unwrap();

        assert_eq!(edit["body"], "* see https://example.org");
        assert_eq!(edit["m.mentions"], json!({}));
        assert_eq!(
            edit["m.relates_to"],
            json!({ "rel_type": "m.replace", "event_id": "$event" })
        );
        let new_content = &edit["m.new_content"];
        assert_eq!(new_content["body"], "see https://example.org");
        assert_eq!(new_content["com.beeper.linkpreviews"], json!([]));
        assert_eq!(
            new_content["com.beeper.per_message_profile"],
            json!({ "id": "p" })
        );
        assert!(new_content.get("m.relates_to").is_none());

        let edited = json!({
            "type": "m.room.message",
            "content": {
                "body": "* fixed https://example.org",
                "m.new_content": { "msgtype": "m.text", "body": "fixed https://example.org" },
                "m.relates_to": { "rel_type": "m.replace", "event_id": "$event" },
            },
        });
        let edit = super::previews_removed_edit(event_id!("$event"), &edited).unwrap();
        assert_eq!(edit["m.new_content"]["body"], "fixed https://example.org");

        let sticker = json!({ "type": "m.sticker", "content": { "body": "hi" } });
        assert!(super::previews_removed_edit(event_id!("$event"), &sticker).is_none());
    }

    #[test]
    fn a_pin_listed_twice_is_kept_once_in_order() {
        let pins = super::unique_pins(vec![
            event_id!("$b").to_owned(),
            event_id!("$a").to_owned(),
            event_id!("$b").to_owned(),
        ]);
        assert_eq!(pins, [event_id!("$b"), event_id!("$a")]);
    }

    async fn core(server: &MatrixMockServer, client: matrix_sdk::Client) -> Arc<Core> {
        let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
        let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
        *core.session.write().await = Some(Session {
            account_id: "test".to_owned(),
            client,
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
        });
        core
    }

    async fn sent_message(server: &MatrixMockServer) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let requests = server.server().received_requests().await.unwrap();
                if let Some(request) = requests
                    .iter()
                    .find(|request| request.url.path().contains("/send/m.room.message/"))
                {
                    break request.body_json().unwrap();
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn editing_replies_preserves_mentions_without_repinging() {
        for media_caption in [false, true] {
            for threaded in [false, true] {
                for (ping, already_edited) in [(false, false), (true, false), (true, true)] {
                    let server = MatrixMockServer::new().await;
                    let client = server.client_builder().build().await;
                    let sender = client.user_id().unwrap().to_owned();
                    let room = room_id!("!reply-edits:example.org");
                    let bob = user_id!("@bob:example.org");
                    let carol = user_id!("@carol:example.org");
                    server.sync_joined_room(&client, room).await;
                    server.mock_room_state_encryption().plain().mount().await;
                    let mut content = if media_caption {
                        json!({"msgtype": "m.image", "body": "before", "filename": "photo.png", "url": "mxc://example.org/photo"})
                    } else {
                        json!({"msgtype": "m.text", "body": "before"})
                    };
                    content["m.relates_to"] = if threaded {
                        json!({"rel_type": "m.thread", "event_id": "$root", "m.in_reply_to": {"event_id": "$target"}})
                    } else {
                        json!({"m.in_reply_to": {"event_id": "$target"}})
                    };
                    content["m.mentions"] =
                        json!({"user_ids": if ping { vec![bob, carol] } else { vec![carol] }});
                    let mut latest = content.clone();
                    latest["m.mentions"] = json!({"user_ids": [carol]});
                    let target = json!({"msgtype": "m.text", "body": "target"});
                    for (id, event_sender, event_content) in [
                        ("$original", sender.as_str(), content),
                        ("$target", bob.as_str(), target),
                    ] {
                        Mock::given(method("GET"))
                            .and(path(format!("/_matrix/client/v3/rooms/{room}/event/{id}")))
                            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                                "type": "m.room.message", "event_id": id, "sender": event_sender,
                                "origin_server_ts": 1, "room_id": room, "content": event_content,
                            })))
                            .mount(server.server())
                            .await;
                    }
                    let replacements = if already_edited {
                        vec![json!({
                            "type": "m.room.message", "event_id": "$previous-edit", "sender": sender,
                            "origin_server_ts": 2, "room_id": room,
                            "content": {
                                "msgtype": "m.text", "body": "* before", "m.mentions": {},
                                "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"},
                                "m.new_content": latest,
                            },
                        })]
                    } else {
                        Vec::new()
                    };
                    Mock::given(method("GET"))
                        .and(path(format!(
                            "/_matrix/client/v1/rooms/{room}/relations/$original/m.replace"
                        )))
                        .respond_with(
                            ResponseTemplate::new(200)
                                .set_body_json(json!({"chunk": replacements})),
                        )
                        .mount(server.server())
                        .await;
                    server
                        .mock_room_send()
                        .ok(event_id!("$edited"))
                        .expect(1)
                        .mount()
                        .await;
                    let core = core(&server, client).await;
                    core.run(crate::api::messages::EditParams {
                        room_id: room.to_owned(),
                        event_id: Some(event_id!("$original").to_owned()),
                        transaction_id: None,
                        body: "after".to_owned(),
                        formatted: None,
                        kind: crate::protocol::MessageKind::Text,
                        media_caption,
                        thread_root: threaded.then(|| event_id!("$root").to_owned()),
                        mentions: Vec::new(),
                        mentions_room: false,
                        persona: None,
                        forum_title: None,
                    })
                    .await
                    .unwrap();
                    let sent = sent_message(&server).await;
                    assert_eq!(sent["m.new_content"]["body"], "after");
                    assert_eq!(
                        sent["m.new_content"]["m.mentions"],
                        if ping && !already_edited {
                            json!({"user_ids": [bob]})
                        } else {
                            json!({})
                        }
                    );
                    assert_eq!(sent["m.mentions"], json!({}));
                }
            }
        }
    }

    #[tokio::test]
    async fn text_edits_preserve_removed_previews_from_the_latest_version() {
        for field in [
            super::BUNDLED_LINK_PREVIEWS,
            super::LEGACY_BUNDLED_LINK_PREVIEWS,
        ] {
            for removed_after_send in [false, true] {
                let server = MatrixMockServer::new().await;
                let client = server.client_builder().build().await;
                let sender = client.user_id().unwrap().to_owned();
                let room = room_id!("!previews:example.org");
                server.sync_joined_room(&client, room).await;
                server.mock_room_state_encryption().plain().mount().await;
                let mut original = json!({
                    "type": "m.room.message", "event_id": "$original",
                    "sender": sender, "origin_server_ts": 1, "room_id": room,
                    "content": {"msgtype": "m.text", "body": "https://example.org"},
                });
                original["content"][field] = if removed_after_send {
                    json!([{"matched_url": "https://example.org"}])
                } else {
                    json!([])
                };
                let replacements = if removed_after_send {
                    vec![json!({
                        "type": "m.room.message", "event_id": "$removed",
                        "sender": sender, "origin_server_ts": 2, "room_id": room,
                        "content": {
                            "msgtype": "m.text", "body": "* https://example.org",
                            "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"},
                            "m.new_content": {
                                "msgtype": "m.text", "body": "https://example.org", (field): [],
                            },
                        },
                    })]
                } else {
                    Vec::new()
                };
                Mock::given(method("GET"))
                    .and(path(format!(
                        "/_matrix/client/v3/rooms/{room}/event/$original"
                    )))
                    .respond_with(ResponseTemplate::new(200).set_body_json(original))
                    .mount(server.server())
                    .await;
                Mock::given(method("GET"))
                    .and(path(format!(
                        "/_matrix/client/v1/rooms/{room}/relations/$original/m.replace"
                    )))
                    .respond_with(
                        ResponseTemplate::new(200).set_body_json(json!({"chunk": replacements})),
                    )
                    .mount(server.server())
                    .await;
                let sent = Arc::new(Mutex::new(Value::Null));
                let write = sent.clone();
                Mock::given(method("PUT"))
                    .and(wiremock::matchers::path_regex(format!(
                        "/_matrix/client/v3/rooms/{room}/send/m.room.message/.*"
                    )))
                    .respond_with(move |request: &wiremock::Request| {
                        *write.lock().unwrap() = serde_json::from_slice(&request.body).unwrap();
                        ResponseTemplate::new(200).set_body_json(json!({"event_id": "$edited"}))
                    })
                    .expect(1)
                    .mount(server.server())
                    .await;
                let core = core(&server, client).await;
                core.run(crate::api::messages::EditParams {
                    room_id: room.to_owned(),
                    event_id: Some(event_id!("$original").to_owned()),
                    transaction_id: None,
                    body: "https://example.org extra text".to_owned(),
                    formatted: None,
                    kind: crate::protocol::MessageKind::Text,
                    media_caption: false,
                    thread_root: None,
                    mentions: Vec::new(),
                    mentions_room: false,
                    persona: None,
                    forum_title: None,
                })
                .await
                .unwrap();
                tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    while sent.lock().unwrap().is_null() {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                let sent = sent.lock().unwrap();
                assert_eq!(sent["m.new_content"][field], json!([]));
                assert_eq!(
                    sent["m.new_content"]["body"],
                    "https://example.org extra text"
                );
            }
        }
    }

    #[tokio::test]
    async fn pin_and_unpin_load_existing_server_state() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!pins:example.org");
        server.sync_joined_room(&client, room_id).await;
        let pins = Arc::new(Mutex::new(json!({"pinned": ["$old"]})));
        let endpoint = format!("/_matrix/client/v3/rooms/{room_id}/state/m.room.pinned_events/");
        let read_pins = pins.clone();
        Mock::given(method("GET"))
            .and(path(endpoint.clone()))
            .respond_with(move |_: &wiremock::Request| {
                ResponseTemplate::new(200).set_body_json(read_pins.lock().unwrap().clone())
            })
            .mount(server.server())
            .await;
        let write_pins = pins.clone();
        Mock::given(method("PUT"))
            .and(path(endpoint))
            .respond_with(move |request: &wiremock::Request| {
                *write_pins.lock().unwrap() =
                    serde_json::from_slice::<Value>(&request.body).unwrap();
                ResponseTemplate::new(200).set_body_json(json!({"event_id": "$pins"}))
            })
            .expect(2)
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        let result = core
            .set_pinned(&room_id.to_owned(), event_id!("$new").to_owned(), true)
            .await
            .unwrap();
        assert_eq!(result, vec![event_id!("$old"), event_id!("$new")]);
        let result = core
            .set_pinned(&room_id.to_owned(), event_id!("$new").to_owned(), false)
            .await
            .unwrap();
        assert_eq!(result, vec![event_id!("$old")]);
        assert_eq!(*pins.lock().unwrap(), json!({"pinned": ["$old"]}));
    }

    #[tokio::test]
    async fn pinning_keeps_server_pins_the_local_cache_has_not_seen() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!stale:example.org");
        let stale: matrix_sdk::ruma::serde::Raw<_> = matrix_sdk::ruma::serde::Raw::new(&json!({
            "type": "m.room.pinned_events", "state_key": "", "event_id": "$state",
            "sender": "@alice:example.org", "origin_server_ts": 1,
            "content": {"pinned": ["$a"]}
        }))
        .unwrap()
        .cast_unchecked();
        server
            .sync_room(
                &client,
                matrix_sdk_test::JoinedRoomBuilder::new(room_id).add_state_event(stale),
            )
            .await;
        let endpoint = format!("/_matrix/client/v3/rooms/{room_id}/state/m.room.pinned_events/");
        Mock::given(method("GET"))
            .and(path(endpoint.clone()))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"pinned": ["$a", "$b", "$c"]})),
            )
            .mount(server.server())
            .await;
        let sent = Arc::new(Mutex::new(Value::Null));
        let write = sent.clone();
        Mock::given(method("PUT"))
            .and(path(endpoint))
            .respond_with(move |request: &wiremock::Request| {
                *write.lock().unwrap() = serde_json::from_slice::<Value>(&request.body).unwrap();
                ResponseTemplate::new(200).set_body_json(json!({"event_id": "$pins"}))
            })
            .expect(1)
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        core.set_pinned(&room_id.to_owned(), event_id!("$d").to_owned(), true)
            .await
            .unwrap();
        assert_eq!(
            *sent.lock().unwrap(),
            json!({"pinned": ["$a", "$b", "$c", "$d"]})
        );
    }

    #[tokio::test]
    async fn typing_in_a_room_that_is_not_joined_is_a_no_op() {
        use crate::api::Handler;

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!invited:example.org");
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_invited_room(matrix_sdk_test::InvitedRoomBuilder::new(room_id));
            })
            .await;
        let core = core(&server, client).await;
        let params = crate::api::messages::SetTypingParams {
            room_id: room_id.to_owned(),
            typing: false,
        };
        params.run(&core).await.unwrap();
    }

    #[tokio::test]
    async fn a_malformed_pin_does_not_hide_the_valid_ones() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!bad-pin:example.org");
        server
            .sync_room(&client, matrix_sdk_test::JoinedRoomBuilder::new(room_id))
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room_id}/state/m.room.pinned_events/"
            )))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(
                    json!({"pinned": ["$a", "!not-an-event:example.org", "$a", "$b"]}),
                ),
            )
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        let pins = core.pinned_events(&room_id.to_owned()).await.unwrap();
        assert_eq!(
            pins,
            [event_id!("$a").to_owned(), event_id!("$b").to_owned()]
        );
    }

    #[tokio::test]
    async fn forwarding_uses_latest_valid_edit_even_when_relations_are_unordered() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let source = room_id!("!source:example.org");
        let target = room_id!("!target:example.org");
        server.sync_joined_room(&client, source).await;
        server.sync_joined_room(&client, target).await;
        server.mock_room_state_encryption().plain().mount().await;
        let original = json!({"type": "m.room.message", "event_id": "$original", "sender": "@alice:example.org", "origin_server_ts": 1,
            "room_id": source, "content": {"msgtype": "m.text", "body": "original"}});
        let edit = |id: &str, sender: &str, ts: u64, body: &str| {
            json!({
            "type": "m.room.message", "event_id": id, "sender": sender, "origin_server_ts": ts,
            "room_id": source, "content": {"msgtype": "m.text", "body": "* fallback",
            "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"},
            "m.new_content": {"msgtype": "m.text", "body": body}}})
        };
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{source}/event/$original"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(original))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v1/rooms/{source}/relations/$original/m.replace"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [
                edit("$new", "@alice:example.org", 3, "latest"),
                edit("$old", "@alice:example.org", 2, "older"),
                edit("$forged", "@mallory:example.org", 4, "forged")
            ]})))
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(wiremock::matchers::path_regex(format!(
                "/_matrix/client/v3/rooms/{target}/send/m.room.message/.*"
            )))
            .and(wiremock::matchers::body_partial_json(json!({
                "moe.sable.message.forward": {"is_forwarded": true},
                "org.matrix.msc4553.forwarded": {"content": {"msgtype": "m.text", "body": "latest"}}
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$forward"})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        core.forward_message(
            &source.to_owned(),
            &event_id!("$original").to_owned(),
            &target.to_owned(),
            None,
            true,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn forwarding_without_metadata_keeps_only_required_content() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let source = room_id!("!source:example.org");
        let target = room_id!("!target:example.org");
        server.sync_joined_room(&client, source).await;
        server.sync_joined_room(&client, target).await;
        server.mock_room_state_encryption().plain().mount().await;
        let original = json!({"type": "m.room.message", "event_id": "$original", "sender": "@alice:example.org", "origin_server_ts": 1,
            "room_id": source, "content": {"msgtype": "m.text", "body": "original"}});
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{source}/event/$original"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(original))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v1/rooms/{source}/relations/$original/m.replace"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(wiremock::matchers::path_regex(format!(
                "/_matrix/client/v3/rooms/{target}/send/m.room.message/.*"
            )))
            .and(|request: &wiremock::Request| {
                let body: serde_json::Value = request.body_json().unwrap();
                body["org.matrix.msc4553.forwarded"]
                    == json!({
                        "content": {"msgtype": "m.text", "body": "original"}
                    })
                    && body["moe.sable.message.forward"]
                        == json!({
                            "v": 1, "is_forwarded": true, "original_event_private": true
                        })
                    && body["body"] == "Forwarded message\noriginal"
            })
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$forward"})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        core.forward_message(
            &source.to_owned(),
            &event_id!("$original").to_owned(),
            &target.to_owned(),
            None,
            false,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn an_edit_of_a_forward_is_ignored_when_forwarding_it() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let source = room_id!("!source:example.org");
        let target = room_id!("!target:example.org");
        server.sync_joined_room(&client, source).await;
        server.sync_joined_room(&client, target).await;
        server.mock_room_state_encryption().plain().mount().await;
        let forwarded =
            json!({"origin_server_ts": 1, "content": {"msgtype": "m.text", "body": "original"}});
        Mock::given(method("GET"))
            .and(path(format!("/_matrix/client/v3/rooms/{source}/event/$forward")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "type": "m.room.message", "event_id": "$forward", "sender": "@alice:example.org",
                "origin_server_ts": 2, "room_id": source,
                "content": {"msgtype": "m.text", "body": "fallback", "org.matrix.msc4553.forwarded": forwarded}
            })))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v1/rooms/{source}/relations/$forward/m.replace"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [{
                "type": "m.room.message", "event_id": "$edit", "sender": "@alice:example.org",
                "origin_server_ts": 3, "room_id": source,
                "content": {"msgtype": "m.text", "body": "* edited",
                    "m.relates_to": {"rel_type": "m.replace", "event_id": "$forward"},
                    "m.new_content": {"msgtype": "m.text", "body": "edited"}}
            }]})))
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(wiremock::matchers::path_regex(format!(
                "/_matrix/client/v3/rooms/{target}/send/m.room.message/.*"
            )))
            .and(wiremock::matchers::body_partial_json(json!({
                "org.matrix.msc4553.forwarded": forwarded
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$new"})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        core.forward_message(
            &source.to_owned(),
            &event_id!("$forward").to_owned(),
            &target.to_owned(),
            None,
            false,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn edit_history_lists_the_original_then_valid_edits_by_time() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room = room_id!("!history:example.org");
        server.sync_joined_room(&client, room).await;
        server.mock_room_state_encryption().plain().mount().await;
        let edit = |id: &str, sender: &str, ts: u64, body: &str| {
            json!({
            "type": "m.room.message", "event_id": id, "sender": sender, "origin_server_ts": ts,
            "room_id": room, "content": {"msgtype": "m.text", "body": "* fallback",
            "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"},
            "m.new_content": {"msgtype": "m.text", "body": body,
                "format": "org.matrix.custom.html", "formatted_body": format!("<b>{body}</b>")}}})
        };
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room}/event/$original"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "type": "m.room.message", "event_id": "$original", "sender": "@alice:example.org",
                "origin_server_ts": 1, "room_id": room,
                "content": {"msgtype": "m.text", "body": "first"}
            })))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v1/rooms/{room}/relations/$original/m.replace"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [
                edit("$third", "@alice:example.org", 3, "third"),
                edit("$second", "@alice:example.org", 2, "second"),
                edit("$forged", "@mallory:example.org", 4, "forged")
            ]})))
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        let versions = core
            .edit_history(&room.to_owned(), &event_id!("$original").to_owned())
            .await
            .unwrap();
        let summary: Vec<_> = versions
            .iter()
            .map(|version| {
                (
                    version.event_id.as_str(),
                    version.timestamp,
                    version.body.as_str(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                ("$original", 1, "first"),
                ("$second", 2, "second"),
                ("$third", 3, "third")
            ]
        );
        assert_eq!(versions[2].html, "<b>third</b>");
    }

    #[tokio::test]
    async fn redacting_edits_redacts_each_valid_edit() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room = room_id!("!redact:example.org");
        server.sync_joined_room(&client, room).await;
        server.mock_room_state_encryption().plain().mount().await;
        let edit = |id: &str, sender: &str| {
            json!({
            "type": "m.room.message", "event_id": id, "sender": sender, "origin_server_ts": 2,
            "room_id": room, "content": {"msgtype": "m.text", "body": "* fallback",
            "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"},
            "m.new_content": {"msgtype": "m.text", "body": "edited"}}})
        };
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room}/event/$original"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "type": "m.room.message", "event_id": "$original", "sender": "@alice:example.org",
                "origin_server_ts": 1, "room_id": room,
                "content": {"msgtype": "m.text", "body": "first"}
            })))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v1/rooms/{room}/relations/$original/m.replace"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [
                edit("$one", "@alice:example.org"),
                edit("$two", "@alice:example.org"),
                edit("$forged", "@mallory:example.org")
            ]})))
            .mount(server.server())
            .await;
        for edit_id in ["$one", "$two"] {
            Mock::given(method("PUT"))
                .and(wiremock::matchers::path_regex(format!(
                    r"/_matrix/client/v3/rooms/{room}/redact/\{edit_id}/.*"
                )))
                .respond_with(
                    ResponseTemplate::new(200).set_body_json(json!({"event_id": "$redaction"})),
                )
                .expect(1)
                .mount(server.server())
                .await;
        }
        let core = core(&server, client).await;
        core.redact_edits(&room.to_owned(), &event_id!("$original").to_owned(), None)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn event_items_render_the_latest_valid_edit_and_skip_missing_events() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room = room_id!("!pins:example.org");
        server.sync_joined_room(&client, room).await;
        server.mock_room_state_encryption().plain().mount().await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room}/event/$pinned"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "type": "m.room.message", "event_id": "$pinned", "sender": "@alice:example.org",
                "origin_server_ts": 1, "room_id": room,
                "content": {"msgtype": "m.text", "body": "**rules**",
                    "format": "org.matrix.custom.html", "formatted_body": "<b>rules</b>"}
            })))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v1/rooms/{room}/relations/$pinned/m.replace"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [
                {"type": "m.room.message", "event_id": "$edit", "sender": "@alice:example.org",
                 "origin_server_ts": 2, "room_id": room,
                 "content": {"msgtype": "m.text", "body": "* new rules",
                    "m.relates_to": {"rel_type": "m.replace", "event_id": "$pinned"},
                    "m.new_content": {"msgtype": "m.text", "body": "new rules",
                        "format": "org.matrix.custom.html",
                        "formatted_body": "<em>new</em> rules"}}},
                {"type": "m.room.message", "event_id": "$forged", "sender": "@mallory:example.org",
                 "origin_server_ts": 3, "room_id": room,
                 "content": {"msgtype": "m.text", "body": "* forged",
                    "m.relates_to": {"rel_type": "m.replace", "event_id": "$pinned"},
                    "m.new_content": {"msgtype": "m.text", "body": "forged"}}}
            ]})))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/_matrix/client/v3/rooms/{room}/event/$gone")))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_NOT_FOUND", "error": "Event not found"
            })))
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        let items = core
            .event_items(
                &room.to_owned(),
                &[
                    event_id!("$pinned").to_owned(),
                    event_id!("$gone").to_owned(),
                ],
            )
            .await
            .unwrap();

        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.event_id.as_deref(), Some(event_id!("$pinned")));
        assert_eq!(item.sender.as_deref(), Some(user_id!("@alice:example.org")));
        assert_eq!(item.timestamp, 1);
        let crate::protocol::TimelineItemContentView::Message {
            body, html, edited, ..
        } = &item.content
        else {
            panic!("expected a message, got {:?}", item.content);
        };
        assert_eq!(body, "new rules");
        assert_eq!(html, "<em>new</em> rules");
        assert!(edited);
    }

    async fn preview_core(server: &MatrixMockServer) -> Arc<Core> {
        let client = server.client_builder().build().await;
        let room = room_id!("!bookmarks:example.org");
        server.sync_joined_room(&client, room).await;
        server.mock_room_state_encryption().plain().mount().await;
        let event = json!({
            "type": "m.room.message", "event_id": "$saved", "sender": "@alice:example.org",
            "origin_server_ts": 1, "room_id": room,
            "content": {"msgtype": "m.text", "body": "Saved message"}
        });
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room}/event/$saved"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(event.clone()))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/_matrix/client/v1/rooms/{room}/threads")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [event]})))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v1/rooms/{room}/relations/$saved/m.replace"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room}/state/m.room.member/@alice:example.org"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "membership": "join", "displayname": "Room Alice",
                "avatar_url": "mxc://example.org/alice"
            })))
            .expect(1)
            .mount(server.server())
            .await;
        core(server, client).await
    }

    #[tokio::test]
    async fn event_items_and_thread_roots_share_missing_sender_state() {
        use crate::api::timeline::ListThreadsParams;

        let server = MatrixMockServer::new().await;
        let core = preview_core(&server).await;
        let room = room_id!("!bookmarks:example.org");
        let items = core
            .event_items(&room.to_owned(), &[event_id!("$saved").to_owned()])
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].sender_name.as_deref(), Some("Room Alice"));
        assert_eq!(
            items[0].sender_avatar.as_deref(),
            Some("mxc://example.org/alice")
        );

        let threads = core
            .run(ListThreadsParams {
                room_id: room.to_owned(),
                from: None,
            })
            .await
            .unwrap();
        assert_eq!(threads.roots.len(), 1);
        assert_eq!(threads.roots[0].sender_name.as_deref(), Some("Room Alice"));
        assert_eq!(
            threads.roots[0].sender_avatar.as_deref(),
            Some("mxc://example.org/alice")
        );
    }

    #[tokio::test]
    async fn thread_lists_keep_server_counts_when_local_history_is_empty() {
        use crate::api::timeline::ListThreadsParams;
        let server = MatrixMockServer::new().await;
        let core = preview_core(&server).await;
        let room = room_id!("!bookmarks:example.org");
        let client = core.client().await.unwrap();
        let _cache = client
            .event_cache()
            .unwrap()
            .thread(room, event_id!("$saved"))
            .await
            .unwrap();
        Mock::given(method("GET"))
            .and(path(format!("/_matrix/client/v1/rooms/{room}/threads")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "chunk": [{
                "type": "m.room.message", "event_id": "$saved", "sender": "@alice:example.org",
                "origin_server_ts": 1, "room_id": room,
                "content": {"msgtype": "m.text", "body": "Saved message"},
                "unsigned": {"m.relations": {"m.thread": {"count": 2, "current_user_participated": false, "latest_event": {
                    "event_id": "$latest", "type": "m.room.message", "sender": "@alice:example.org",
                    "origin_server_ts": 2, "content": {"msgtype": "m.text", "body": "Latest reply"}
                }}}}
            }] })))
            .with_priority(1)
            .mount(server.server())
            .await;
        let result = core
            .run(ListThreadsParams {
                room_id: room.to_owned(),
                from: None,
            })
            .await
            .unwrap();
        let summary = result.roots[0].thread_summary.as_ref().unwrap();
        assert_eq!(summary.num_replies, 2);
        assert_eq!(summary.latest_body.as_deref(), Some("Latest reply"));
    }

    #[tokio::test]
    async fn event_items_fetch_missing_sender_state_in_a_left_room() {
        use matrix_sdk_test::LeftRoomBuilder;

        let server = MatrixMockServer::new().await;
        let core = preview_core(&server).await;
        let room = room_id!("!bookmarks:example.org");
        server
            .sync_room(&core.client().await.unwrap(), LeftRoomBuilder::new(room))
            .await;

        let items = core
            .event_items(&room.to_owned(), &[event_id!("$saved").to_owned()])
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].sender_name.as_deref(), Some("Room Alice"));
        assert_eq!(
            items[0].sender_avatar.as_deref(),
            Some("mxc://example.org/alice")
        );
    }

    #[tokio::test]
    async fn forwarding_media_from_a_private_room_keeps_the_attachment() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let source = room_id!("!private:example.org");
        let target = room_id!("!target:example.org");
        server.sync_joined_room(&client, source).await;
        server.sync_joined_room(&client, target).await;
        server.mock_room_state_encryption().plain().mount().await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{source}/event/$video"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "type": "m.room.message", "event_id": "$video", "sender": "@alice:example.org",
                "origin_server_ts": 1, "room_id": source,
                "content": {"msgtype": "m.video", "body": "seal.mp4", "url": "mxc://example.org/seal"}
            })))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v1/rooms/{source}/relations/$video/m.replace"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(wiremock::matchers::path_regex(format!(
                "/_matrix/client/v3/rooms/{target}/send/m.room.message/.*"
            )))
            .and(wiremock::matchers::body_partial_json(json!({
                "msgtype": "m.video", "body": "Forwarded message", "filename": "seal.mp4",
                "url": "mxc://example.org/seal",
                "org.matrix.msc4553.forwarded": {"origin_server_ts": 1, "content": {"url": "mxc://example.org/seal"}}
            })))
            .and(|request: &wiremock::Request| {
                let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
                let forwarded = &body["org.matrix.msc4553.forwarded"];
                forwarded.get("room_id").is_none()
                    && forwarded.get("event_id").is_none()
                    && forwarded.get("sender").is_none()
            })
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$forward"})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        core.forward_message(
            &source.to_owned(),
            &event_id!("$video").to_owned(),
            &target.to_owned(),
            None,
            true,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn sending_previews_validates_the_whitelist_and_honors_optout() {
        for opt_out in [false, true] {
            let server = MatrixMockServer::new().await;
            let client = server.client_builder().build().await;
            client.send_queue().set_enabled(false).await;
            let room_id = room_id!("!pending:example.org");
            let room = server.sync_joined_room(&client, room_id).await;
            let core = core(&server, client).await;
            let preview = |url: &str| {
                crate::link_previews::url_preview(
                    url.to_owned(),
                    &json!({
                        "og:title": "Example"
                    }),
                )
                .unwrap()
            };
            let params = serde_json::from_value::<crate::api::messages::SendParams>(json!({
                "room_id": room_id,
                "body": "https://example.org/allowed javascript:alert(1)",
                "link_previews": [
                    preview("https://example.org/allowed"),
                    preview("https://example.org/allowed"),
                    preview("https://example.org/absent"),
                    preview("javascript:alert(1)"),
                ],
                "no_link_previews": opt_out,
            }))
            .unwrap();
            core.run(params).await.unwrap();
            let (echoes, _updates) = room.send_queue().subscribe().await.unwrap();
            let matrix_sdk::send_queue::LocalEchoContent::Event {
                serialized_event, ..
            } = &echoes[0].content
            else {
                panic!("expected a queued message")
            };
            let content: Value = serialized_event.raw().0.deserialize_as_unchecked().unwrap();
            for (field, matched_url) in [
                (super::BUNDLED_LINK_PREVIEWS, "matrix:matched_url"),
                (super::LEGACY_BUNDLED_LINK_PREVIEWS, "matched_url"),
            ] {
                let previews = content[field].as_array().unwrap();
                assert_eq!(previews.len(), usize::from(!opt_out));
                if !opt_out {
                    assert_eq!(previews[0][matched_url], "https://example.org/allowed");
                }
            }
        }
    }

    #[tokio::test]
    async fn editing_a_pending_reply_updates_the_queue_and_keeps_the_relation() {
        use crate::protocol::MessageKind;
        use matrix_sdk::ruma::events::relation::Reply;
        use matrix_sdk::ruma::events::room::message::{Relation, RoomMessageEventContent};
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.send_queue().set_enabled(false).await;
        let room_id = room_id!("!pending:example.org");
        server.sync_joined_room(&client, room_id).await;
        server.mock_room_state_encryption().plain().mount().await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room_id}/event/$reply"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "type": "m.room.message", "event_id": "$reply", "sender": "@bob:example.org",
                "origin_server_ts": 1, "room_id": room_id,
                "content": {"msgtype": "m.text", "body": "target"},
            })))
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        let timeline = core.timeline(&room_id.to_owned()).await.unwrap();
        let mut content = RoomMessageEventContent::text_plain("before");
        content.mentions = Some(super::outgoing_mentions(
            vec![user_id!("@bob:example.org").to_owned()],
            false,
        ));
        content.relates_to = Some(Relation::Reply(Reply::with_event_id(
            event_id!("$reply").to_owned(),
        )));
        timeline
            .send_with_extra_content(
                content.into(),
                Some(
                    [
                        (super::BUNDLED_LINK_PREVIEWS.to_owned(), json!([])),
                        (super::LEGACY_BUNDLED_LINK_PREVIEWS.to_owned(), json!([])),
                    ]
                    .into_iter()
                    .collect(),
                ),
            )
            .await
            .unwrap();
        let transaction_id = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Some(id) = timeline
                    .items()
                    .await
                    .iter()
                    .find_map(|item| item.as_event()?.transaction_id().map(ToString::to_string))
                {
                    break id;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        core.run(crate::api::messages::EditParams {
            room_id: room_id.to_owned(),
            event_id: None,
            transaction_id: Some(transaction_id),
            body: "after".to_owned(),
            formatted: None,
            kind: MessageKind::Text,
            media_caption: false,
            thread_root: None,
            mentions: Vec::new(),
            mentions_room: false,
            persona: None,
            forum_title: None,
        })
        .await
        .unwrap();
        let room = core.room(&room_id.to_owned()).await.unwrap();
        let (echoes, _updates) = room.send_queue().subscribe().await.unwrap();
        let matrix_sdk::send_queue::LocalEchoContent::Event {
            serialized_event, ..
        } = &echoes[0].content
        else {
            panic!("expected a queued message")
        };
        let content: Value = serialized_event.raw().0.deserialize_as_unchecked().unwrap();
        assert_eq!(content["body"], "after");
        assert_eq!(
            content["m.relates_to"]["m.in_reply_to"]["event_id"],
            "$reply"
        );
        assert_eq!(
            content["m.mentions"]["user_ids"],
            json!(["@bob:example.org"])
        );
        assert_eq!(content[super::BUNDLED_LINK_PREVIEWS], json!([]));
        assert_eq!(content[super::LEGACY_BUNDLED_LINK_PREVIEWS], json!([]));
    }

    #[tokio::test]
    async fn reading_a_thread_sends_only_a_receipt_scoped_to_its_root() {
        use crate::api::timeline::MarkReadParams;
        use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!thread:example.org");
        let root = event_id!("$root");
        let factory = EventFactory::new().room(room_id).sender(User::Alice);
        server.mock_room_state_encryption().plain().mount().await;
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_timeline_event(factory.text_msg("root").event_id(root))
                    .add_timeline_event(
                        factory
                            .text_msg("reply")
                            .event_id(event_id!("$reply"))
                            .in_thread(root, root),
                    ),
            )
            .await;
        Mock::given(method("POST"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room_id}/receipt/m.read/$reply"
            )))
            .and(wiremock::matchers::body_json(json!({"thread_id": "$root"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room_id}/read_markers"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(0)
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        let subscription = core.allocate_subscription();
        let timeline = core
            .thread_timeline(&room_id.to_owned(), &root.to_owned())
            .await
            .unwrap();
        core.subscriptions.lock().await.insert(
            subscription,
            crate::Subscription {
                tasks: Vec::new(),
                timeline: Some(timeline),
                overlay: None,
                thread_root: Some(root.to_owned()),
                kind: crate::SubscriptionKind::FocusedTimeline(room_id.to_owned()),
            },
        );
        core.run(MarkReadParams {
            room_id: room_id.to_owned(),
            event_id: Some(event_id!("$reply").to_owned()),
            private_receipt: false,
            thread_root: Some(root.to_owned()),
            subscription: Some(subscription),
            fully_read: false,
        })
        .await
        .unwrap();
    }

    async fn receipt_body(read: &str, viewed: Option<&str>) -> serde_json::Value {
        use crate::api::timeline::MarkReadParams;
        use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!thread:example.org");
        let factory = EventFactory::new().room(room_id).sender(User::Alice);
        server.mock_room_state_encryption().plain().mount().await;
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_timeline_event(factory.text_msg("root").event_id(event_id!("$root")))
                    .add_timeline_event(
                        factory
                            .text_msg("reply")
                            .event_id(event_id!("$reply"))
                            .in_thread(event_id!("$root"), event_id!("$root")),
                    )
                    .add_timeline_event(
                        factory
                            .reaction(event_id!("$reply"), "x")
                            .event_id(event_id!("$reaction")),
                    )
                    .add_timeline_event(factory.text_msg("main").event_id(event_id!("$main"))),
            )
            .await;
        Mock::given(method("POST"))
            .and(wiremock::matchers::path_regex(format!(
                "^/_matrix/client/v3/rooms/{room_id}/receipt/m.read/.*$"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        core.run(MarkReadParams {
            room_id: room_id.to_owned(),
            event_id: Some(read.try_into().unwrap()),
            private_receipt: false,
            thread_root: viewed.map(|root| root.try_into().unwrap()),
            subscription: None,
            fully_read: false,
        })
        .await
        .unwrap();
        let requests = server.server().received_requests().await.unwrap();
        let receipt = requests
            .iter()
            .find(|request| request.url.path().contains("/receipt/m.read/"))
            .unwrap();
        serde_json::from_slice(&receipt.body).unwrap()
    }

    #[tokio::test]
    async fn a_receipt_names_the_thread_of_its_event() {
        assert_eq!(
            receipt_body("$reply", None).await,
            json!({"thread_id": "$root"})
        );
        assert_eq!(
            receipt_body("$reaction", None).await,
            json!({"thread_id": "$root"})
        );
        assert_eq!(
            receipt_body("$reply", Some("$other")).await,
            json!({"thread_id": "$root"})
        );
        assert_eq!(
            receipt_body("$main", None).await,
            json!({"thread_id": "main"})
        );
        assert_eq!(
            receipt_body("$main", Some("$root")).await,
            json!({"thread_id": "main"})
        );
    }

    #[tokio::test]
    async fn the_root_of_a_viewed_thread_is_read_in_it() {
        assert_eq!(
            receipt_body("$root", Some("$root")).await,
            json!({"thread_id": "$root"})
        );
    }

    #[tokio::test]
    async fn a_thread_timeline_is_already_at_its_end_going_forward() {
        use crate::api::timeline::{PaginateOk, PaginateParams};
        use crate::protocol::PaginationDirection;
        use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!thread:example.org");
        let root = event_id!("$root");
        let factory = EventFactory::new().room(room_id).sender(User::Alice);
        server.mock_room_state_encryption().plain().mount().await;
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_timeline_event(factory.text_msg("root").event_id(root)),
            )
            .await;
        let core = core(&server, client).await;
        let subscription = core.allocate_subscription();
        let timeline = core
            .thread_timeline(&room_id.to_owned(), &root.to_owned())
            .await
            .unwrap();
        core.subscriptions.lock().await.insert(
            subscription,
            crate::Subscription {
                tasks: Vec::new(),
                timeline: Some(timeline),
                overlay: None,
                thread_root: Some(root.to_owned()),
                kind: crate::SubscriptionKind::FocusedTimeline(room_id.to_owned()),
            },
        );

        let result = core
            .run(PaginateParams {
                subscription,
                direction: PaginationDirection::Forward,
                count: 20,
            })
            .await;

        assert!(matches!(
            result,
            Ok(PaginateOk {
                direction: PaginationDirection::Forward,
                reached_end: true,
            })
        ));
    }
}
