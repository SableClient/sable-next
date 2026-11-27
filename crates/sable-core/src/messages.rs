use sable_model::text::visible_name;

use crate::api::account::ReportUserParams;
use crate::api::messages::EditParams;
use crate::api::rooms::ReportParams;
use std::collections::{HashMap, HashSet};

use futures_util::future::join_all;
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::media::{MediaFormat, MediaRequestParameters};
use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::room::{IncludeRelations, MessagesOptions, RelationsOptions};
use matrix_sdk::ruma::api::Direction;
use matrix_sdk::ruma::api::client::reporting::report_user;
use matrix_sdk::ruma::api::client::room::get_room_event;
use matrix_sdk::ruma::api::client::room::{report_content, report_room};
use matrix_sdk::ruma::api::client::state::get_state_event_for_key;
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::relation::RelationType;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::room::pinned_events::RoomPinnedEventsEventContent;
use matrix_sdk::ruma::events::room::{EncryptedFile, MediaSource};
use matrix_sdk::ruma::events::sticker::StickerEventContent;
use matrix_sdk::ruma::events::{
    AnyMessageLikeEventContent, AnySyncTimelineEvent, Mentions, StateEventType,
};
use matrix_sdk::ruma::room::JoinRule;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{
    EventId, MilliSecondsSinceUnixEpoch, OwnedEventId, OwnedRoomId, OwnedUserId, RoomId, UInt,
    UserId,
};
use matrix_sdk_ui::timeline::TimelineEventItemId;

use crate::Core;
use crate::ResultExt;
use crate::SignedIn;
use crate::link_previews::BUNDLED_LINK_PREVIEWS;
use crate::link_previews::LEGACY_BUNDLED_LINK_PREVIEWS;
use crate::matrix_html::{display_html, strip_profile_fallback_body, strip_profile_fallback_html};
use crate::outgoing::message_content;
use crate::personas::PER_MESSAGE_PROFILE;
use crate::protocol::{
    EditVersionView, MessageKind, PerMessageProfileView, RpcCode, RpcError, TimelineItemView,
    UnredactedEventView,
};
use crate::routing::Route;
use crate::view::{
    FAMEDLY_FORWARDED, FORWARDED, SABLE_FORWARDED, SPOILER_PROPERTY, SPOILER_REASON_PROPERTY,
    per_message_profile, standalone_item,
};
use serde_with::{DefaultOnError, VecSkipError, serde_as};

const MSC2815: &str = "fi.mau.msc2815";
const MSC2815_CONTENT_DELETED: &str = "FI.MAU.MSC2815_UNREDACTED_CONTENT_DELETED";
const MSC2815_CONTENT_NOT_RECEIVED: &str = "FI.MAU.MSC2815_UNREDACTED_CONTENT_NOT_RECEIVED";
const MSC2815_CONTENT_KEEP_MS: &str = "fi.mau.msc2815.content_keep_ms";

mod get_unredacted_event {
    use matrix_sdk::ruma::{
        OwnedEventId, OwnedRoomId,
        api::{auth_scheme::AccessToken, request, response},
        events::AnyTimelineEvent,
        metadata,
        serde::Raw,
    };

    metadata! {
        method: GET,
        rate_limited: false,
        authentication: AccessToken,
        history: {
            1.0 => "/_matrix/client/r0/rooms/{room_id}/event/{event_id}",
            1.1 => "/_matrix/client/v3/rooms/{room_id}/event/{event_id}",
        }
    }

    #[request]
    pub(super) struct Request {
        #[ruma_api(path)]
        pub room_id: OwnedRoomId,
        #[ruma_api(path)]
        pub event_id: OwnedEventId,
        #[ruma_api(query)]
        #[serde(rename = "fi.mau.msc2815.include_unredacted_content")]
        pub include_unredacted_content: bool,
    }

    #[response]
    pub(super) struct Response {
        #[ruma_api(body)]
        pub event: Raw<AnyTimelineEvent>,
    }
}

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
            formatted_caption: formatted.map(ruma::events::room::message::FormattedBody::html),
            mentions: Some(outgoing_mentions(mentions, room)),
        }
    } else {
        EditedContent::RoomMessage(message_content(body, formatted, kind, mentions, room).into())
    }
}

fn spoiler_keys(content: &serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    [SPOILER_PROPERTY, SPOILER_REASON_PROPERTY]
        .into_iter()
        .filter_map(|key| Some((key.to_owned(), content.get(key)?.clone())))
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

impl SignedIn {
    pub(crate) async fn edit_message(&self, params: EditParams) -> Result<(), RpcError> {
        let EditParams {
            room_id,
            event_id,
            transaction_id,
            body,
            formatted,
            kind,
            media_caption,
            thread_root,
            mentions,
            mentions_room,
            persona,
            forum_title,
        } = params;
        let edited = edit_content(
            body,
            formatted,
            kind,
            media_caption,
            mentions,
            mentions_room,
        );

        let room = self.room(&room_id)?;
        match (event_id, transaction_id) {
            (Some(event_id), None) => {
                self.core()
                    .edit_sent_message(
                        &room,
                        &event_id,
                        edited,
                        media_caption,
                        persona.as_ref(),
                        forum_title,
                    )
                    .await
            }
            (None, Some(transaction_id)) => {
                self.edit_queued_message(
                    &room,
                    transaction_id.into(),
                    edited,
                    persona.as_ref(),
                    thread_root.as_ref(),
                )
                .await
            }
            _ => Err(RpcCode::Unsupported.into()),
        }
    }

    async fn edit_queued_message(
        &self,
        room: &matrix_sdk::Room,
        transaction_id: ruma::OwnedTransactionId,
        mut edited: EditedContent,
        persona: Option<&PerMessageProfileView>,
        thread_root: Option<&OwnedEventId>,
    ) -> Result<(), RpcError> {
        let (echoes, _updates) = room
            .send_queue()
            .subscribe()
            .await
            .or_failed(self.core(), "edit_message")?;
        if let Some(echo) = echoes
            .into_iter()
            .find(|echo| echo.transaction_id == transaction_id)
            && let matrix_sdk::send_queue::LocalEchoContent::Event {
                serialized_event, ..
            } = echo.content
        {
            let previous = serialized_event
                .raw()
                .0
                .deserialize_as_unchecked::<serde_json::Value>()
                .or_failed(self.core(), "edit_message")?;
            retain_reply_mention(room, &previous, &previous, &mut edited).await;
        }
        let queued = if let EditedContent::RoomMessage(message) = &edited {
            self.core()
                .edit_local_message(room, &transaction_id, message.clone(), persona)
                .await?
        } else {
            false
        };
        if !queued {
            self.timeline_for(&room.room_id().to_owned(), thread_root)
                .await?
                .edit(&TimelineEventItemId::TransactionId(transaction_id), edited)
                .await
                .or_failed(self.core(), "edit_message")?;
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
            .ok_or(RpcCode::Unsupported)?;
        if !item.is_own() {
            return Err(RpcCode::Denied.into());
        }
        let event = item
            .latest_json()
            .or_else(|| item.original_json())
            .and_then(|raw| raw.deserialize_as_unchecked::<serde_json::Value>().ok())
            .ok_or(RpcCode::Unsupported)?;
        let edit = build(&event).ok_or(RpcCode::Unsupported)?;
        let raw = Raw::<AnyMessageLikeEventContent>::from_json_string(edit.to_string())
            .or_failed(self.core(), context)?;
        self.room(room_id)?
            .send_queue()
            .send_raw(raw, "m.room.message".to_owned())
            .await
            .or_failed(self.core(), context)?;
        Ok(())
    }

    /// Servers do not cascade a redaction to `m.replace` events, which keep the edited text.
    pub(crate) async fn redact_edits(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        reason: Option<&str>,
    ) -> Result<(), RpcError> {
        let room = self.room(room_id)?;
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
                .or_failed(self.core(), "redact")?;
        }
        Ok(())
    }

    pub(crate) async fn delete_thread(
        &self,
        room_id: &OwnedRoomId,
        root_event_id: &OwnedEventId,
        reason: Option<&str>,
    ) -> Result<(), RpcError> {
        let room = self.room(room_id)?;
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
                .or_failed(self.core(), "delete_thread")?;

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
                let event_id = EventId::parse(event_id).or_failed(self.core(), "delete_thread")?;
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
                .or_failed(self.core(), "delete_thread")?;
        }
        Ok(())
    }

    /// Kicks or bans with MSC4293's `redact_events`. Servers without MSC4293
    /// drop the flag, so when the new membership lost it, the user's messages
    /// since they joined are redacted one by one; the count is of those.
    pub(crate) async fn remove_redacting_events(
        &self,
        room: &matrix_sdk::Room,
        user_id: &UserId,
        reason: Option<&str>,
        ban: bool,
    ) -> Result<u32, RpcError> {
        use matrix_sdk::ruma::api::client::membership::{ban_user, kick_user};

        let joined_at = room
            .get_member_no_sync(user_id)
            .await
            .ok()
            .flatten()
            .and_then(|member| member.event().origin_server_ts());
        let (room_id, user) = (room.room_id().to_owned(), user_id.to_owned());
        let sent = if ban {
            let mut request = ban_user::v3::Request::new(room_id, user);
            request.reason = reason.map(ToOwned::to_owned);
            request.redact_events = true;
            room.client().send(request).await.map(drop)
        } else {
            let mut request = kick_user::v3::Request::new(room_id, user);
            request.reason = reason.map(ToOwned::to_owned);
            request.redact_events = true;
            room.client().send(request).await.map(drop)
        };
        sent.or_failed(self.core(), "remove_redacting_events")?;
        let Some(joined_at) = joined_at else {
            return Ok(0);
        };
        // A failed fetch must not read as "the server did not redact" and trigger a second bulk redaction.
        let member = room
            .client()
            .send(get_state_event_for_key::v3::Request::new(
                room.room_id().to_owned(),
                StateEventType::RoomMember,
                user_id.to_string(),
            ))
            .await
            .or_failed(self.core(), "remove_redacting_events")?;
        let kept = member
            .into_content()
            .get_field::<bool>("org.matrix.msc4293.redact_events")
            .ok()
            .flatten()
            .unwrap_or(false);
        if kept {
            return Ok(0);
        }
        self.bulk_redact(
            &room.room_id().to_owned(),
            &[user_id.to_string()],
            joined_at.0.into(),
            &[],
            true,
            reason,
        )
        .await
    }

    pub(crate) async fn bulk_redact(
        &self,
        room_id: &OwnedRoomId,
        senders: &[String],
        after_ts: u64,
        event_types: &[String],
        messages_only: bool,
        reason: Option<&str>,
    ) -> Result<u32, RpcError> {
        let room = self.room(room_id)?;
        let mut from: Option<String> = None;
        let mut redacted = 0;

        loop {
            let mut options = MessagesOptions::backward().from(from.as_deref());
            options.limit = UInt::from(100u16);
            let messages = room
                .messages(options)
                .await
                .or_failed(self.core(), "bulk_redact")?;
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
                    || (messages_only && raw.state_key.is_some())
                {
                    continue;
                }

                let Some(event_id) = raw.event_id.as_deref() else {
                    continue;
                };
                let event_id = EventId::parse(event_id).or_failed(self.core(), "bulk_redact")?;
                room.redact(&event_id, reason, None)
                    .await
                    .or_failed(self.core(), "bulk_redact")?;
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
        let room = self.room(room_id)?;
        if let Some(events) = room.pinned_event_ids() {
            return Ok(unique_pins(events));
        }
        if let Some(events) = self.state().probed_pinned_rooms.lock().get(room_id) {
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
            Err(error) => return Err(self.core().rpc_error(context, &error)),
        };
        let lenient = response
            .into_content()
            .deserialize_as_unchecked::<LenientPins>()
            .or_failed(self.core(), context)?;
        Ok(unique_pins(lenient.pinned))
    }

    fn remember_pinned(&self, room_id: &OwnedRoomId, events: &[OwnedEventId]) {
        self.state()
            .probed_pinned_rooms
            .lock()
            .insert(room_id.clone(), events.to_vec());
    }

    pub(crate) async fn set_pinned(
        &self,
        room_id: &OwnedRoomId,
        event_id: OwnedEventId,
        pinned: bool,
    ) -> Result<Vec<OwnedEventId>, RpcError> {
        let _guard = self.state().account_data_writes.lock().await;
        let room = self.room(room_id)?;
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
                .or_failed(self.core(), "set_pinned")?;
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
        let room = self.room(room_id)?;
        let mut request = report_content::v3::Request::new(room.room_id().to_owned(), event_id);
        request.reason = reason;

        room.client()
            .send(request)
            .await
            .or_failed(self.core(), "report_message")?;

        Ok(())
    }

    pub(crate) async fn report_room(
        &self,
        ReportParams { room_id, reason }: ReportParams,
    ) -> Result<(), RpcError> {
        self.client()
            .send(report_room::v3::Request::new(room_id, reason))
            .await
            .or_failed(self.core(), "report_room")?;
        Ok(())
    }

    pub(crate) async fn report_user(
        &self,
        ReportUserParams { user_id, reason }: ReportUserParams,
    ) -> Result<(), RpcError> {
        self.client()
            .send(report_user::v3::Request::new(user_id, reason))
            .await
            .or_failed(self.core(), "report_user")?;
        Ok(())
    }

    pub(crate) async fn event_source(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        include_original: bool,
    ) -> Result<(String, bool, Option<String>, Option<String>), RpcError> {
        let event = self
            .room(room_id)?
            .event(event_id, None)
            .await
            .or_failed(self.core(), "event_source")?;

        let encrypted = event.encryption_info().is_some();
        let original = if encrypted && include_original {
            match self
                .client()
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
        let encryption = match event.encryption_info() {
            Some(info) if include_original => self.encryption_details(room_id, info).await,
            _ => None,
        };
        Ok((
            pretty_json(event.raw().json().get()),
            encrypted,
            original,
            encryption,
        ))
    }

    /// MSC2815: a moderator re-reads the content of an event the server has
    /// redacted, or one a ban hides here (MSC4293). Nothing is stored, so the
    /// timeline keeps it removed.
    pub(crate) async fn unredacted_event(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
    ) -> Result<UnredactedEventView, RpcError> {
        const LABEL: &str = "unredacted_event";
        if let Some(content) = self.ban_hidden_content(room_id, event_id) {
            return Ok(UnredactedEventView::Content {
                content: Box::new(content),
            });
        }
        let client = self.client();
        if !client
            .unstable_features()
            .await
            .or_failed(self.core(), LABEL)?
            .iter()
            .any(|feature| feature.as_str() == MSC2815)
        {
            return Err(RpcCode::Unsupported.into());
        }
        let room = self.room(room_id)?;
        let request = get_unredacted_event::Request {
            room_id: room_id.clone(),
            event_id: event_id.clone(),
            include_unredacted_content: true,
        };
        let raw = match client.send(request).await {
            Ok(response) => response.event,
            Err(error) => {
                let kind = error.client_api_error_kind();
                return match kind.map(ErrorKind::errcode) {
                    Some(code) if code.as_str() == MSC2815_CONTENT_DELETED => {
                        Ok(UnredactedEventView::Deleted {
                            content_keep_ms: kind
                                .and_then(|kind| kind.custom_json_data())
                                .and_then(|data| data.get(MSC2815_CONTENT_KEEP_MS))
                                .and_then(serde_json::Value::as_u64),
                        })
                    }
                    Some(code) if code.as_str() == MSC2815_CONTENT_NOT_RECEIVED => {
                        Ok(UnredactedEventView::NotReceived)
                    }
                    _ => Err(error).or_failed(self.core(), LABEL),
                };
            }
        };

        let mut json: serde_json::Value =
            serde_json::from_str(raw.json().get()).or_failed(self.core(), LABEL)?;
        // A server that only ever saw the redacted event answers with it.
        if json
            .get("content")
            .and_then(serde_json::Value::as_object)
            .is_none_or(serde_json::Map::is_empty)
        {
            return Ok(UnredactedEventView::NotReceived);
        }
        // An event carrying `redacted_because` reads as redacted whatever its content.
        if let Some(unsigned) = json
            .get_mut("unsigned")
            .and_then(serde_json::Value::as_object_mut)
        {
            unsigned.remove("redacted_because");
        }
        let encrypted =
            json.get("type").and_then(serde_json::Value::as_str) == Some("m.room.encrypted");
        let raw = Raw::<AnySyncTimelineEvent>::from_json_string(json.to_string())
            .or_failed(self.core(), LABEL)?;
        let event = if encrypted {
            let Some(decrypted) = room
                .decrypt_event(raw.cast_ref_unchecked(), None)
                .await
                .ok()
                .filter(|event| event.encryption_info().is_some())
            else {
                return Ok(UnredactedEventView::Undecryptable);
            };
            decrypted
        } else {
            TimelineEvent::from_plaintext(raw)
        };
        let item = standalone_item(self, &room, event, None, None)
            .await
            .ok_or(RpcCode::Unavailable)?;
        Ok(UnredactedEventView::Content {
            content: Box::new(item.content),
        })
    }

    pub(crate) async fn forward_message(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        to_room_id: &OwnedRoomId,
        persona: Option<&PerMessageProfileView>,
        include_metadata: bool,
    ) -> Result<(), RpcError> {
        let source = self.room(room_id)?;
        let (event, replacements) = source
            .load_or_fetch_event_with_relations(
                event_id,
                Some(vec![RelationType::Replacement]),
                None,
            )
            .await
            .or_failed(self.core(), "forward_message")?;

        let raw = event
            .raw()
            .deserialize()
            .or_failed(self.core(), "forward_message")?;

        let AnySyncTimelineEvent::MessageLike(message) = raw else {
            return Err(RpcCode::Unsupported.into());
        };
        let event_type = match message.original_content() {
            Some(AnyMessageLikeEventContent::RoomMessage(_)) => "m.room.message",
            Some(AnyMessageLikeEventContent::Sticker(_)) => "m.sticker",
            _ => return Err(RpcCode::Unsupported.into()),
        };

        let original = raw_content(&event).ok_or(RpcCode::Unsupported)?;
        let is_forward = [FORWARDED, FAMEDLY_FORWARDED, SABLE_FORWARDED]
            .iter()
            .any(|key| original.get(key).is_some());
        let edited = (!is_forward && event_type == "m.room.message")
            .then(|| latest_valid_replacement(&event, &replacements))
            .flatten()
            .and_then(|edit| {
                let edit = edit
                    .raw()
                    .deserialize_as_unchecked::<serde_json::Value>()
                    .ok()?;
                latest_message(&edit)?.as_object().cloned()
            });
        let mut source_content = match (edited, original) {
            (Some(edited), _) => edited,
            (None, serde_json::Value::Object(original)) => original,
            (None, _) => return Err(RpcCode::Unsupported.into()),
        };
        let target = self.room(to_room_id)?;
        publish_encrypted_media(&target, &mut source_content)
            .await
            .or_failed(self.core(), "forward_message")?;

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
            if let Some(name) = source.cached_display_name() {
                origin.insert("room_name".to_owned(), name.to_string().into());
            }
            if let Some(avatar) = source.avatar_url() {
                origin.insert("room_avatar_url".to_owned(), avatar.to_string().into());
            }
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
        let prior = prior_forward(&source_content);
        let route = forward_route(&source, &origin, prior.as_ref()).await;
        let mut content = serde_json::Value::Object(forward_content_for_event(
            source_content,
            origin,
            event_type,
            route.as_ref(),
            sender_name.as_deref(),
        ));

        if let Some(profile) = persona {
            crate::personas::stamp_profile(
                &mut content,
                &crate::personas::without_fallback(profile),
            );
        }

        target
            .send_raw(event_type, content)
            .await
            .or_failed(self.core(), "forward_message")?;

        Ok(())
    }

    pub(crate) async fn edit_history(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
    ) -> Result<Vec<EditVersionView>, RpcError> {
        let (event, replacements) = self
            .room(room_id)?
            .load_or_fetch_event_with_relations(
                event_id,
                Some(vec![RelationType::Replacement]),
                None,
            )
            .await
            .or_failed(self.core(), "edit_history")?;

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
        let session_state = self.state();
        if session_state.pinned_caches.lock().contains_key(room_id) {
            return;
        }
        let Ok(room) = self.room(room_id) else {
            return;
        };
        let client = room.client();
        let Some(event_cache) = client.event_cache() else {
            return;
        };
        match event_cache.pinned_events(room_id).await {
            Ok(entry) => {
                session_state
                    .pinned_caches
                    .lock()
                    .insert(room_id.clone(), entry);
            }
            Err(error) => tracing::debug!(%room_id, "pinned events cache unavailable: {error}"),
        }
    }

    pub(crate) async fn event_items(
        &self,
        room_id: &OwnedRoomId,
        event_ids: &[OwnedEventId],
    ) -> Result<Vec<TimelineItemView>, RpcError> {
        let room = self.room(room_id)?;
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

    async fn pinned_snapshot(
        &self,
        room_id: &OwnedRoomId,
    ) -> HashMap<OwnedEventId, (TimelineEvent, Vec<TimelineEvent>)> {
        let cache = self
            .state()
            .pinned_caches
            .lock()
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
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    state_key: Option<String>,
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

pub(crate) fn valid_replacements<'a>(
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
    if event.kind.is_utd() {
        return None;
    }
    let raw = raw_content(event)?;
    let content = if replacement {
        raw.get("m.new_content")?
    } else {
        &raw
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

/// An encrypted file carries its key in the event, so an unencrypted room gets a plain
/// copy of the media instead of the key.
async fn publish_encrypted_media(
    target: &matrix_sdk::Room,
    content: &mut serde_json::Map<String, serde_json::Value>,
) -> matrix_sdk::Result<()> {
    if target.latest_encryption_state().await?.is_encrypted() {
        return Ok(());
    }
    let mut found = Vec::new();
    each_object(content, &mut |object| {
        for (sealed, _, info) in ENCRYPTED_MEDIA {
            if let Some(file) = object.get(sealed).and_then(as_encrypted_file) {
                let mime = object
                    .get(info)
                    .and_then(|info| info.get("mimetype")?.as_str());
                found.push((file, mime.and_then(|mime| mime.parse().ok())));
            }
        }
    });
    let client = target.client();
    let mut plain = HashMap::new();
    for (file, mime) in found {
        if plain.contains_key(&file.url) {
            continue;
        }
        let request = MediaRequestParameters {
            source: MediaSource::Encrypted(Box::new(file.clone())),
            format: MediaFormat::File,
        };
        let bytes = client.media().get_media_content(&request, true).await?;
        let mime = mime.unwrap_or(mime::APPLICATION_OCTET_STREAM);
        let uploaded = client.media().upload(&mime, bytes, None).await?;
        plain.insert(file.url, uploaded.content_uri);
    }
    // Any other encrypted file, such as a link preview image, is dropped with its key.
    each_object(content, &mut |object| {
        for (sealed, open, _) in ENCRYPTED_MEDIA {
            let uri = object
                .get(sealed)
                .and_then(as_encrypted_file)
                .and_then(|file| plain.get(&file.url));
            if let Some(uri) = uri {
                object.insert(open.to_owned(), uri.to_string().into());
            }
        }
        object.retain(|_, child| as_encrypted_file(child).is_none());
    });
    Ok(())
}

/// The encrypted key, its plain counterpart and the sibling that holds its type.
const ENCRYPTED_MEDIA: [(&str, &str, &str); 2] = [
    ("file", "url", "info"),
    ("thumbnail_file", "thumbnail_url", "thumbnail_info"),
];

fn as_encrypted_file(value: &serde_json::Value) -> Option<EncryptedFile> {
    value.get("key")?;
    serde_json::from_value(value.clone()).ok()
}

fn each_object(
    object: &mut serde_json::Map<String, serde_json::Value>,
    visit: &mut impl FnMut(&mut serde_json::Map<String, serde_json::Value>),
) {
    visit(object);
    for child in object.values_mut() {
        match child {
            serde_json::Value::Object(child) => each_object(child, visit),
            serde_json::Value::Array(items) => {
                for item in items
                    .iter_mut()
                    .filter_map(serde_json::Value::as_object_mut)
                {
                    each_object(item, visit);
                }
            }
            _ => {}
        }
    }
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

/// Forward metadata is whatever its sender wrote, so the room it names is never looked up.
async fn forward_route(
    source: &matrix_sdk::Room,
    origin: &serde_json::Map<String, serde_json::Value>,
    prior: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<Route> {
    if let Some(prior) = prior {
        let sender = UserId::parse(prior.get("sender")?.as_str()?).ok()?;
        return Route::claimed_by(&sender);
    }
    if !origin.contains_key("room_id") {
        return None;
    }
    Route::cached(source).await
}

fn strip_reply_fallback(content: &mut serde_json::Map<String, serde_json::Value>) {
    if let Some(serde_json::Value::String(body)) = content.get_mut("body") {
        *body = ruma::events::room::message::sanitize::remove_plain_reply_fallback(body).to_owned();
    }
    let html = content
        .get("format")
        .is_some_and(|format| format == "org.matrix.custom.html");
    if html && let Some(serde_json::Value::String(formatted)) = content.get_mut("formatted_body") {
        *formatted = ruma::html::remove_html_reply_fallback(formatted);
    }
}

#[cfg(test)]
fn forward_content(
    source: serde_json::Map<String, serde_json::Value>,
    origin: serde_json::Map<String, serde_json::Value>,
    route: Option<&Route>,
    sender_name: Option<&str>,
) -> serde_json::Map<String, serde_json::Value> {
    forward_content_for_event(source, origin, "m.room.message", route, sender_name)
}

fn forward_content_for_event(
    mut source: serde_json::Map<String, serde_json::Value>,
    origin: serde_json::Map<String, serde_json::Value>,
    event_type: &str,
    route: Option<&Route>,
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
        PER_MESSAGE_PROFILE,
        "m.per_message_profile",
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
    route: &Route,
) -> Option<String> {
    let id = |key| forwarded.get(key).and_then(serde_json::Value::as_str);
    let room = RoomId::parse(id("room_id")?).ok()?;
    let event = EventId::parse(id("event_id")?).ok()?;
    let query = route
        .servers()
        .iter()
        .map(|server| format!("via={server}"))
        .collect::<Vec<_>>()
        .join("&");
    Some(format!(
        "https://matrix.to/#/{}/{}?{query}",
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
    route: Option<&Route>,
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
        route
            .and_then(|route| original_permalink(forwarded, route))
            .as_deref(),
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
#[path = "messages_tests.rs"]
mod tests;

impl Core {
    async fn edit_sent_message(
        &self,
        room: &matrix_sdk::Room,
        event_id: &OwnedEventId,
        mut edited: EditedContent,
        media_caption: bool,
        persona: Option<&PerMessageProfileView>,
        forum_title: Option<String>,
    ) -> Result<(), RpcError> {
        let (event, replacements) = room
            .load_or_fetch_event_with_relations(
                event_id,
                Some(vec![RelationType::Replacement]),
                None,
            )
            .await
            .or_failed(self, "edit_message")?;
        let original = raw_content(&event).ok_or(RpcCode::Unsupported)?;
        if [FORWARDED, FAMEDLY_FORWARDED, SABLE_FORWARDED]
            .iter()
            .any(|key| original.get(key).is_some())
        {
            return Err(RpcCode::Unsupported.into());
        }
        let latest = latest_valid_replacement(&event, &replacements)
            .unwrap_or(&event)
            .raw()
            .deserialize_as_unchecked::<serde_json::Value>()
            .or_failed(self, "edit_message")?;
        retain_reply_mention(
            room,
            &original,
            latest_message(&latest).ok_or(RpcCode::Unsupported)?,
            &mut edited,
        )
        .await;
        let content = room
            .make_edit_event(event_id, edited)
            .await
            .or_failed(self, "edit_message")?;
        let mut retained = preview_keys(&latest);
        if media_caption {
            retained.extend(spoiler_keys(&original));
        }
        self.edit_with_persona(room, &content, persona, forum_title, retained)
            .await
    }
}
