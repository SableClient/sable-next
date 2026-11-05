use sable_model::text::visible_name;

use std::collections::BTreeSet;

use matrix_sdk::ruma::UInt;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::events::poll::start::PollKind;
use matrix_sdk::ruma::events::room::message::{
    GalleryMessageEventContent, MessageType, RoomMessageEventContent,
};
use matrix_sdk::ruma::events::sticker::StickerEventContent;
use matrix_sdk::ruma::{OwnedUserId, UserId};
use matrix_sdk_base::crypto::types::events::UtdCause;
use matrix_sdk_ui::timeline::{
    EncryptedMessage, LiveLocationState, MsgLikeKind, PollState, TimelineItemContent,
};
use sable_model::jumbo;

use crate::matrix_html::{display_html, strip_profile_fallback_body, strip_profile_fallback_html};
use crate::protocol::{
    AvatarChangeView, DisplayNameChangeView, MessageKind, PerMessageProfileView, PollAnswerView,
    PollView, TimelineItemContentView, UtdCauseView,
};

use super::media::{
    audio_duration_ms, audio_metadata, audio_waveform, caption_view, gallery_item, image_thumbnail,
    media_source, video_playback, video_thumbnail,
};
use super::raw::RawFields;
use super::state::{membership_change, membership_reason, pinned_change, state_change};

fn text_message(
    msgtype: &MessageType,
    edited: bool,
    profile: Option<&PerMessageProfileView>,
    raw: &RawFields,
) -> TimelineItemContentView {
    let formatted = formatted_body(msgtype);
    let formatted = formatted
        .as_ref()
        .and_then(|_| raw.formatted_body().map(ToOwned::to_owned))
        .or(formatted);
    let fallback = profile
        .filter(|profile| profile.has_fallback)
        .and_then(|profile| profile.display_name.as_deref());
    let body = strip_profile_fallback_body(msgtype.body(), fallback);
    let formatted = formatted.map(|formatted| strip_profile_fallback_html(&formatted, fallback));
    let html = display_html(&body, formatted.as_deref());
    let kind = match msgtype {
        MessageType::Emote(_) => MessageKind::Emote,
        MessageType::Notice(_) => MessageKind::Notice,
        _ => MessageKind::Text,
    };
    let jumbo = (kind != MessageKind::Emote)
        .then(|| jumbo::emoji_level(&body).or_else(|| jumbo::emoticon_level(&html)))
        .flatten();
    TimelineItemContentView::Message {
        html,
        body,
        msgtype: kind,
        edited,
        jumbo,
    }
}

/// RFC 5870 `geo:lat,long[,alt]` with optional `;`-separated parameters.
pub(crate) fn geo_coordinates(geo_uri: &str) -> Option<(f64, f64)> {
    // RFC 3986: schemes are case-insensitive.
    let scheme = geo_uri.get(..4)?;
    if !scheme.eq_ignore_ascii_case("geo:") {
        return None;
    }
    let coordinates = geo_uri.get(4..)?.split(';').next()?;
    let mut parts = coordinates.split(',');
    let latitude: f64 = parts.next()?.trim().parse().ok()?;
    let longitude: f64 = parts.next()?.trim().parse().ok()?;

    // RFC 5870 declares anything outside these ranges invalid.
    ((-90.0..=90.0).contains(&latitude) && (-180.0..=180.0).contains(&longitude))
        .then_some((latitude, longitude))
}

fn poll(state: &PollState, own_user_id: Option<&UserId>) -> PollView {
    let results = state.results();
    // MSC3381 says to assume `m.undisclosed` for a kind we do not recognise, so
    // only an explicit `m.disclosed` reveals a running tally.
    let undisclosed = !matches!(results.kind, PollKind::Disclosed);
    let reveal = results.end_time.is_some() || !undisclosed;
    let tally = results.votes;
    let mut seen = BTreeSet::new();

    PollView {
        question: results.question,
        answers: results
            .answers
            .into_iter()
            .filter(|answer| seen.insert(answer.id.clone()))
            .map(|answer| {
                let voters = tally.get(&answer.id);
                PollAnswerView {
                    votes: reveal.then(|| {
                        voters.map_or(0, |voters| u32::try_from(voters.len()).unwrap_or(u32::MAX))
                    }),
                    voters: reveal.then(|| {
                        voters.map_or_else(Vec::new, |voters| {
                            voters
                                .iter()
                                .filter_map(|voter| OwnedUserId::try_from(voter.as_str()).ok())
                                .collect()
                        })
                    }),
                    selected: own_user_id.is_some_and(|own| {
                        voters
                            .is_some_and(|voters| voters.iter().any(|voter| voter == own.as_str()))
                    }),
                    id: answer.id,
                    text: answer.text,
                }
            })
            .collect(),
        max_selections: u32::try_from(results.max_selections).unwrap_or(u32::MAX),
        undisclosed,
        ended_at: results.end_time.map(|at| at.0.into()),
        edited: results.has_been_edited,
    }
}

const fn utd_cause(message: &EncryptedMessage) -> UtdCauseView {
    let EncryptedMessage::MegolmV1AesSha2 { cause, .. } = message else {
        return UtdCauseView::Unknown;
    };

    match cause {
        UtdCause::SentBeforeWeJoined => UtdCauseView::SentBeforeWeJoined,
        UtdCause::VerificationViolation => UtdCauseView::VerificationViolation,
        UtdCause::UnsignedDevice => UtdCauseView::UnsignedDevice,
        UtdCause::UnknownDevice => UtdCauseView::UnknownDevice,
        UtdCause::HistoricalMessageAndBackupIsDisabled => {
            UtdCauseView::HistoricalMessageBackupDisabled
        }
        UtdCause::HistoricalMessageAndDeviceIsUnverified => {
            UtdCauseView::HistoricalMessageDeviceUnverified
        }
        UtdCause::WithheldForUnverifiedOrInsecureDevice => {
            UtdCauseView::WithheldForUnverifiedOrInsecureDevice
        }
        UtdCause::WithheldBySender => UtdCauseView::WithheldBySender,
        UtdCause::Unknown | UtdCause::Malformed => UtdCauseView::Unknown,
    }
}

fn message_content(
    message: &matrix_sdk_ui::timeline::Message,
    profile: Option<&PerMessageProfileView>,
    raw: &RawFields,
) -> TimelineItemContentView {
    message_type_content(message.msgtype(), message.is_edited(), profile, raw)
}

fn gallery_content(
    gallery: &GalleryMessageEventContent,
    raw: &RawFields,
) -> TimelineItemContentView {
    TimelineItemContentView::Gallery {
        html: display_html(
            &gallery.body,
            gallery
                .formatted
                .as_ref()
                .map(|formatted| formatted.body.as_str()),
        ),
        body: gallery.body.clone(),
        items: gallery
            .itemtypes
            .iter()
            .enumerate()
            .filter_map(|(index, item)| gallery_item(item, raw.gallery_spoiler_reason(index)))
            .collect(),
    }
}

fn message_type_content(
    msgtype: &MessageType,
    edited: bool,
    profile: Option<&PerMessageProfileView>,
    raw: &RawFields,
) -> TimelineItemContentView {
    let dimension = |value: Option<UInt>| value.map(u64::from);

    match msgtype {
        MessageType::Image(image) => {
            let (caption, caption_html) =
                caption_view(image.caption(), image.formatted_caption(), profile);
            TimelineItemContentView::Image {
                filename: image.filename().to_owned(),
                caption,
                html: caption_html,
                source: media_source(&image.source),
                external_url: raw.external_url(),
                mime: image.info.as_ref().and_then(|info| info.mimetype.clone()),
                width: dimension(image.info.as_ref().and_then(|info| info.width)),
                height: dimension(image.info.as_ref().and_then(|info| info.height)),
                size: dimension(image.info.as_ref().and_then(|info| info.size)),
                blurhash: image.info.as_ref().and_then(|info| info.blurhash.clone()),
                thumbnail: image.info.as_deref().and_then(image_thumbnail),
                spoiler: raw.spoiler_reason(),
                animated: image.info.as_ref().and_then(|info| info.is_animated),
            }
        }
        MessageType::Video(video) => {
            let (caption, caption_html) =
                caption_view(video.caption(), video.formatted_caption(), profile);
            TimelineItemContentView::Video {
                filename: video.filename().to_owned(),
                caption,
                html: caption_html,
                source: media_source(&video.source),
                external_url: raw.external_url(),
                mime: video.info.as_ref().and_then(|info| info.mimetype.clone()),
                width: dimension(video.info.as_ref().and_then(|info| info.width)),
                height: dimension(video.info.as_ref().and_then(|info| info.height)),
                blurhash: video.info.as_ref().and_then(|info| info.blurhash.clone()),
                thumbnail: video.info.as_deref().and_then(video_thumbnail),
                spoiler: raw.spoiler_reason(),
                playback: video_playback(raw.message()),
            }
        }
        MessageType::Audio(audio) => {
            let (caption, caption_html) =
                caption_view(audio.caption(), audio.formatted_caption(), profile);
            TimelineItemContentView::Audio {
                filename: audio.filename().to_owned(),
                caption,
                html: caption_html,
                source: media_source(&audio.source),
                external_url: raw.external_url(),
                mime: audio.info.as_ref().and_then(|info| info.mimetype.clone()),
                duration_ms: audio_duration_ms(audio),
                waveform: audio_waveform(audio),
                voice: audio.voice.is_some(),
                metadata: audio_metadata(raw.message()),
            }
        }
        MessageType::File(file) => {
            let (caption, caption_html) =
                caption_view(file.caption(), file.formatted_caption(), profile);
            TimelineItemContentView::File {
                filename: file.filename().to_owned(),
                caption,
                html: caption_html,
                source: media_source(&file.source),
                external_url: raw.external_url(),
                mime: file.info.as_ref().and_then(|info| info.mimetype.clone()),
                size: file.info.as_ref().and_then(|info| info.size).map(u64::from),
            }
        }
        MessageType::Location(location) => {
            let coordinates = geo_coordinates(&location.geo_uri);
            TimelineItemContentView::Location {
                body: location.body.clone(),
                geo_uri: location.geo_uri.clone(),
                latitude: coordinates.map(|(latitude, _)| latitude),
                longitude: coordinates.map(|(_, longitude)| longitude),
            }
        }
        MessageType::Gallery(gallery) => gallery_content(gallery, raw),
        MessageType::VerificationRequest(_) => TimelineItemContentView::VerificationRequest,
        msgtype => {
            cute_event(msgtype).unwrap_or_else(|| text_message(msgtype, edited, profile, raw))
        }
    }
}

fn forwarded_message_type(raw: &RawFields) -> Option<(MessageType, RawFields)> {
    let event_content = raw.original_content.as_ref().or(raw.content.as_ref())?;
    let original = event_content
        .get(super::forward::FORWARDED)?
        .get("content")?;
    let message = serde_json::from_value::<RoomMessageEventContent>(original.clone()).ok()?;
    let msgtype = message.msgtype;
    let mut original = original.as_object()?.clone();
    for key in ["m.relates_to", "m.mentions", "m.new_content"] {
        original.remove(key);
    }
    let raw = RawFields {
        content: Some(serde_json::Value::Object(original)),
        ..RawFields::default()
    };
    Some((msgtype, raw))
}

fn forwarded_fallback_message_type(raw: &RawFields) -> Option<(MessageType, RawFields)> {
    let original = raw.original_content.as_ref()?;
    super::forward::forward_meta(original)?;
    let message = serde_json::from_value::<RoomMessageEventContent>(original.clone()).ok()?;
    let mut original = original.as_object()?.clone();
    for key in ["m.relates_to", "m.mentions", "m.new_content"] {
        original.remove(key);
    }
    let raw = RawFields {
        content: Some(serde_json::Value::Object(original)),
        ..RawFields::default()
    };
    Some((message.msgtype, raw))
}

fn forwarded_sticker(raw: &RawFields) -> Option<StickerEventContent> {
    serde_json::from_value(
        raw.original_content
            .as_ref()
            .or(raw.content.as_ref())?
            .get(super::forward::FORWARDED)?
            .get("content")?
            .clone(),
    )
    .ok()
}

fn forwarded_fallback_sticker(raw: &RawFields) -> Option<StickerEventContent> {
    let original = raw.original_content.as_ref()?;
    super::forward::forward_meta(original)?;
    serde_json::from_value(original.clone()).ok()
}

pub(crate) const CUTE_EVENT_MSGTYPE: &str = "im.fluffychat.cute_event";

fn cute_event(msgtype: &MessageType) -> Option<TimelineItemContentView> {
    (msgtype.msgtype() == CUTE_EVENT_MSGTYPE).then(|| TimelineItemContentView::Cute {
        cute_type: msgtype
            .data()
            .get("cute_type")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned),
        body: msgtype.body().to_owned(),
    })
}

fn live_location(state: &LiveLocationState) -> TimelineItemContentView {
    let location = state.latest_location();
    let coordinates = location.and_then(|location| geo_coordinates(location.geo_uri()));
    let duration = u64::try_from(state.timeout().as_millis()).unwrap_or(u64::MAX);
    TimelineItemContentView::LiveLocation {
        body: location
            .and_then(|location| location.description())
            .or_else(|| state.description())
            .unwrap_or_default()
            .to_owned(),
        latitude: coordinates.map(|(latitude, _)| latitude),
        longitude: coordinates.map(|(_, longitude)| longitude),
        live: state.is_live(),
        expires_at: u64::from(state.ts().get()).saturating_add(duration),
        updated_at: location.map(|location| u64::from(location.ts().get())),
    }
}

fn unparsed(event_type: &str, raw: &RawFields) -> TimelineItemContentView {
    if raw.content_stripped() {
        TimelineItemContentView::Redacted {
            reason: raw.redaction_reason(),
            redacted_by: raw.redacted_by(),
        }
    } else {
        TimelineItemContentView::Malformed {
            event_type: event_type.to_owned(),
        }
    }
}

fn unparsed_message_like(event_type: &str, raw: &RawFields) -> TimelineItemContentView {
    // MSC4075 withdraws an invite with a content that holds only its sticky key.
    let withdrawal = matches!(
        event_type,
        "m.rtc.invite" | "m.rtc.notification" | "org.matrix.msc4075.rtc.notification"
    ) && raw
        .content
        .as_ref()
        .and_then(serde_json::Value::as_object)
        .is_some_and(|content| {
            !content.is_empty()
                && content
                    .keys()
                    .all(|key| matches!(key.as_str(), "sticky_key" | "msc4354_sticky_key"))
        });
    if withdrawal {
        TimelineItemContentView::HiddenEvent {
            event_type: event_type.to_owned(),
            content: raw.content.clone(),
            redacts: None,
        }
    } else {
        unparsed(event_type, raw)
    }
}

pub(super) fn content(
    content: &TimelineItemContent,
    profile: Option<&PerMessageProfileView>,
    raw: &RawFields,
    own_user_id: Option<&UserId>,
) -> TimelineItemContentView {
    match content {
        TimelineItemContent::MsgLike(msg) => match &msg.kind {
            MsgLikeKind::Message(message) => forwarded_message_type(raw)
                .or_else(|| forwarded_fallback_message_type(raw))
                .map_or_else(
                    || message_content(message, profile, raw),
                    |(msgtype, forwarded_raw)| {
                        message_type_content(&msgtype, false, None, &forwarded_raw)
                    },
                ),
            MsgLikeKind::Redacted => TimelineItemContentView::Redacted {
                reason: raw.redaction_reason(),
                redacted_by: raw.redacted_by(),
            },
            MsgLikeKind::UnableToDecrypt(message) => TimelineItemContentView::UnableToDecrypt {
                reason: utd_cause(message),
                session_id: match message {
                    EncryptedMessage::MegolmV1AesSha2 { session_id, .. } => {
                        Some(session_id.clone())
                    }
                    _ => None,
                },
            },
            MsgLikeKind::Sticker(sticker) => {
                let forwarded = forwarded_sticker(raw).or_else(|| forwarded_fallback_sticker(raw));
                let sticker = forwarded.as_ref().unwrap_or_else(|| sticker.content());
                TimelineItemContentView::Sticker {
                    body: sticker.body.clone(),
                    source: serde_json::to_string(&sticker.source).unwrap_or_default(),
                    mime: sticker.info.mimetype.clone(),
                    width: sticker.info.width.map(u64::from),
                    height: sticker.info.height.map(u64::from),
                }
            }
            MsgLikeKind::Poll(state) => TimelineItemContentView::Poll {
                poll: poll(state, own_user_id),
            },
            MsgLikeKind::LiveLocation(state) => live_location(state),
            MsgLikeKind::Other(other) => TimelineItemContentView::HiddenEvent {
                event_type: other.event_type().to_string(),
                content: raw.content.clone(),
                redacts: None,
            },
        },

        TimelineItemContent::MembershipChange(change) => TimelineItemContentView::Membership {
            user_id: change.user_id().to_owned(),
            change: membership_change(change.change()),
            display_name: change.display_name().and_then(visible_name),
            reason: membership_reason(change.content()),
        },

        TimelineItemContent::ProfileChange(change) => TimelineItemContentView::ProfileChange {
            user_id: change.user_id().to_owned(),
            display_name: change
                .displayname_change()
                .map(|change| DisplayNameChangeView {
                    old: change.old.clone().and_then(visible_name),
                    new: change.new.clone().and_then(visible_name),
                }),
            avatar: change.avatar_url_change().map(|change| AvatarChangeView {
                old: change.old.as_ref().map(ToString::to_string),
                new: change.new.as_ref().map(ToString::to_string),
            }),
        },

        TimelineItemContent::OtherState(state) => TimelineItemContentView::StateEvent {
            event_type: state.content().event_type().to_string(),
            state_key: state.state_key().to_owned(),
            change: state_change(state, raw.content.as_ref(), raw.prev_content()),
            content: raw.content.clone(),
            prev_content: raw.prev_content().cloned(),
        },
        TimelineItemContent::CallInvite | TimelineItemContent::RtcNotification { .. } => {
            TimelineItemContentView::CallInvite
        }
        TimelineItemContent::FailedToParseMessageLike { event_type, .. } => {
            unparsed_message_like(&event_type.to_string(), raw)
        }
        TimelineItemContent::FailedToParseState {
            event_type,
            state_key,
            ..
        } if raw.content_stripped() || *event_type == StateEventType::RoomPinnedEvents => {
            TimelineItemContentView::StateEvent {
                event_type: event_type.to_string(),
                state_key: state_key.clone(),
                change: (!raw.content_stripped())
                    .then(|| pinned_change(raw.content.as_ref(), raw.prev_content())),
                content: raw.content.clone(),
                prev_content: raw.prev_content().cloned(),
            }
        }
        TimelineItemContent::FailedToParseState { event_type, .. } => {
            unparsed(&event_type.to_string(), raw)
        }
    }
}

pub(super) fn formatted_body(msgtype: &MessageType) -> Option<String> {
    match msgtype {
        MessageType::Text(content) => content.formatted.as_ref().map(|f| f.body.clone()),
        MessageType::Notice(content) => content.formatted.as_ref().map(|f| f.body.clone()),
        MessageType::Emote(content) => content.formatted.as_ref().map(|f| f.body.clone()),
        _ => None,
    }
}

pub(super) fn raw_formatted_body(content: Option<&serde_json::Value>) -> Option<&str> {
    let content = content?;
    if content.get("format")?.as_str()? != "org.matrix.custom.html" {
        return None;
    }
    content.get("formatted_body")?.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::Arc;

    use serde_json::json;

    use crate::protocol::TimelineVisibility;
    use crate::view::raw::RawFields;

    #[test]
    fn supported_forwards_render_the_nested_original_content() {
        let raw = serde_json::from_value::<RawFields>(serde_json::json!({
            "content": {
                "msgtype": "m.text",
                "body": "Forwarded message\\nfallback copy",
                "org.matrix.msc4553.forwarded": {
                    "content": {
                        "msgtype": "m.text",
                        "body": "original content",
                        "format": "org.matrix.custom.html",
                        "formatted_body": "<strong>original</strong> content"
                    }
                }
            }
        }))
        .unwrap();

        let (msgtype, forwarded_raw) = forwarded_message_type(&raw).unwrap();
        let view = message_type_content(&msgtype, false, None, &forwarded_raw);
        let serialized = serde_json::to_value(view).unwrap();

        assert_eq!(serialized["body"], "original content");
        assert_eq!(serialized["html"], "<strong>original</strong> content");
    }

    #[test]
    fn invalid_forward_content_uses_the_original_fallback_and_ignores_edits() {
        let mut raw = serde_json::from_value::<RawFields>(serde_json::json!({
            "content": { "msgtype": "m.text", "body": "edited body" }
        }))
        .unwrap();
        raw.original_content = Some(serde_json::json!({
            "msgtype": "m.text",
            "body": "Forwarded message\noriginal fallback",
            "org.matrix.msc4553.forwarded": { "content": { "msgtype": "m.text" } }
        }));

        let (msgtype, original_raw) = forwarded_fallback_message_type(&raw).unwrap();
        let view = message_type_content(&msgtype, false, None, &original_raw);
        let serialized = serde_json::to_value(view).unwrap();

        assert_eq!(serialized["body"], "Forwarded message\noriginal fallback");
    }

    #[test]
    fn call_invites_have_a_dedicated_view() {
        let view = super::content(
            &TimelineItemContent::CallInvite,
            None,
            &RawFields::default(),
            None,
        );
        let serialized = serde_json::to_value(view).unwrap();
        assert_eq!(serialized["kind"], "call_invite");
    }

    #[test]
    fn an_invite_withdrawal_is_hidden_but_a_broken_notification_is_malformed() {
        let view = |content| {
            let raw = serde_json::from_value::<RawFields>(json!({ "content": content })).unwrap();
            let unparsed = TimelineItemContent::FailedToParseMessageLike {
                event_type: "org.matrix.msc4075.rtc.notification".into(),
                error: Arc::new(serde_json::from_str::<u8>("x").unwrap_err()),
            };
            super::content(&unparsed, None, &raw, None)
        };

        let withdrawal = view(json!({ "msc4354_sticky_key": "m.call#ROOM" }));
        assert_eq!(withdrawal.visibility(), TimelineVisibility::Hidden);
        let broken = view(json!({ "msc4354_sticky_key": "m.call#ROOM", "lifetime": "soon" }));
        assert_eq!(serde_json::to_value(broken).unwrap()["kind"], "malformed");
    }

    #[test]
    fn fluffychat_cute_events_have_a_dedicated_view() {
        let msgtype = |content| serde_json::from_value::<MessageType>(content).unwrap();

        let hug = cute_event(&msgtype(json!({
            "msgtype": "im.fluffychat.cute_event",
            "cute_type": "hug",
            "body": "🤗",
        })))
        .unwrap();
        let serialized = serde_json::to_value(&hug).unwrap();
        assert_eq!(serialized["kind"], "cute");
        assert_eq!(serialized["cute_type"], "hug");
        assert_eq!(serialized["body"], "🤗");
        assert_eq!(hug.row_kind(), crate::protocol::TimelineRowKind::Event);

        let text = msgtype(json!({ "msgtype": "m.text", "body": "🤗" }));
        assert!(cute_event(&text).is_none());
    }

    #[test]
    fn a_stripped_event_reads_as_redacted_without_redacted_because() {
        let raw = serde_json::from_value::<RawFields>(json!({
            "content": {},
            "unsigned": { "age": 137_912 },
        }))
        .unwrap();
        let serialized = serde_json::to_value(unparsed("m.room.message", &raw)).unwrap();
        assert_eq!(serialized["kind"], "redacted");
        assert_eq!(serialized["reason"], serde_json::Value::Null);
    }

    #[test]
    fn a_deletion_names_the_redactor_only_when_it_is_not_the_author() {
        let redacted = |redactor: &str| {
            let raw = serde_json::from_value::<RawFields>(json!({
                "sender": "@alice:x",
                "content": {},
                "unsigned": { "redacted_because": { "sender": redactor, "content": {} } },
            }))
            .unwrap();
            serde_json::to_value(unparsed("m.room.message", &raw)).unwrap()
        };

        assert_eq!(redacted("@mod:x")["redacted_by"], "@mod:x");
        assert_eq!(redacted("@alice:x")["redacted_by"], serde_json::Value::Null);
    }

    #[test]
    fn an_edit_reads_the_spoiler_from_its_new_content() {
        let raw = serde_json::from_value::<RawFields>(json!({
            "content": {
                "body": "* caption",
                "m.relates_to": {"rel_type": "m.replace", "event_id": "$image"},
                "m.new_content": {
                    "body": "caption",
                    "page.codeberg.everypizza.msc4193.spoiler": true,
                },
            },
        }))
        .unwrap();

        assert_eq!(raw.spoiler_reason().as_deref(), Some(""));
    }

    #[test]
    fn bridged_media_keeps_the_link_it_came_from() {
        let content = json!({
            "msgtype": "m.video",
            "body": "https://www.instagram.com/reel/a/",
            "filename": "reel.mp4",
            "url": "mxc://example.org/reel",
            "external_url": "https://www.instagram.com/reel/a/?id=1",
        });
        let raw = serde_json::from_value::<RawFields>(json!({ "content": content })).unwrap();
        let msgtype = serde_json::from_value::<MessageType>(content).unwrap();
        let serialized =
            serde_json::to_value(message_type_content(&msgtype, false, None, &raw)).unwrap();

        assert_eq!(
            serialized["external_url"],
            "https://www.instagram.com/reel/a/?id=1"
        );
    }

    #[test]
    fn an_event_that_kept_its_content_is_still_malformed() {
        let raw = serde_json::from_value::<RawFields>(json!({
            "content": { "msgtype": "m.text" },
        }))
        .unwrap();
        let serialized = serde_json::to_value(unparsed("m.room.message", &raw)).unwrap();
        assert_eq!(serialized["kind"], "malformed");
        assert_eq!(serialized["event_type"], "m.room.message");
    }

    #[test]
    fn live_location_sessions_are_not_unsupported_events() {
        use matrix_sdk::ruma::{
            MilliSecondsSinceUnixEpoch, events::beacon_info::BeaconInfoEventContent,
        };
        use matrix_sdk_ui::timeline::{
            LiveLocationState, MsgLikeContent, MsgLikeKind, TimelineItemContent,
        };
        let beacon = BeaconInfoEventContent::new(
            None,
            std::time::Duration::from_mins(1),
            true,
            Some(MilliSecondsSinceUnixEpoch::now()),
        );
        let content = TimelineItemContent::MsgLike(MsgLikeContent {
            kind: MsgLikeKind::LiveLocation(LiveLocationState::new(beacon)),
            in_reply_to: None,
            thread_root: None,
            thread_summary: None,
        });
        let serialized =
            serde_json::to_value(super::content(&content, None, &RawFields::default(), None))
                .unwrap();
        assert_eq!(serialized["kind"], "live_location");
        assert_eq!(serialized["live"], true);
        assert_eq!(serialized["latitude"], serde_json::Value::Null);
    }

    #[test]
    fn reads_a_geo_uri_with_parameters_an_altitude_or_an_upper_case_scheme() {
        assert_eq!(geo_coordinates("geo:51.5,-0.12"), Some((51.5, -0.12)));
        assert_eq!(geo_coordinates("geo:51.5,-0.12;u=35"), Some((51.5, -0.12)));
        assert_eq!(geo_coordinates("geo:51.5,-0.12,120"), Some((51.5, -0.12)));
        assert_eq!(geo_coordinates("GEO:51.5,-0.12"), Some((51.5, -0.12)));
    }

    #[test]
    fn leaves_an_unreadable_geo_uri_without_coordinates() {
        assert_eq!(geo_coordinates("https://example.org/map"), None);
        assert_eq!(geo_coordinates("geo:somewhere"), None);
        assert_eq!(geo_coordinates("geo:"), None);
        assert_eq!(geo_coordinates("geo:51.5"), None);
    }

    #[test]
    fn rejects_coordinates_outside_the_ranges_rfc_5870_allows() {
        assert_eq!(geo_coordinates("geo:91,0"), None);
        assert_eq!(geo_coordinates("geo:0,181"), None);
        assert_eq!(geo_coordinates("geo:-90,-180"), Some((-90.0, -180.0)));
    }
}
