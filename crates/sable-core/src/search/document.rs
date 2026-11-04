use std::collections::HashSet;

use linkify::LinkFinder;
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::event_cache::RoomEventCache;
use matrix_sdk::ruma::events::poll::unstable_start::UnstablePollStartEventContent;
use matrix_sdk::ruma::events::relation::{RelationType, Replacement};
use matrix_sdk::ruma::events::room::message::{
    GalleryItemType, MessageType, OriginalSyncRoomMessageEvent, Relation,
    RoomMessageEventContentWithoutRelation, sanitize::remove_plain_reply_fallback,
};
use matrix_sdk::ruma::events::{
    AnySyncMessageLikeEvent, AnySyncStateEvent, AnySyncTimelineEvent, Mentions,
    SyncMessageLikeEvent, sticker::OriginalSyncStickerEvent,
};
use matrix_sdk::ruma::{OwnedEventId, OwnedUserId};
use regex_lite::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use super::IndexFilter;
use crate::attachments::{attachment_contents, fits, link_urls};
use crate::messages::{raw_content, valid_replacements};
use crate::protocol::{
    RoomAttachmentContentView, RoomAttachmentKind, RoomAttachmentView, SearchAttachment,
};

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Document {
    pub(super) event_id: OwnedEventId,
    pub(super) body: String,
    #[serde(skip)]
    pub(super) folded: String,
    pub(super) sender: OwnedUserId,
    pub(super) origin_server_ts: u64,
    pub(super) attachments: Vec<SearchAttachment>,
    pub(super) has_link: bool,
    pub(super) mentions: Vec<OwnedUserId>,
    pub(super) in_thread: bool,
    #[serde(default)]
    pub(super) edited_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) edit_id: Option<OwnedEventId>,
    // None for legacy documents and events other than m.room.message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) encrypted: Option<bool>,
    #[serde(default)]
    pub(super) media: Vec<(Option<u32>, RoomAttachmentContentView)>,
    #[serde(default)]
    pub(super) state: bool,
}

impl Document {
    pub(super) fn same_metadata(&self, other: &Self) -> bool {
        self.sender == other.sender
            && self.origin_server_ts == other.origin_server_ts
            && self.attachments == other.attachments
            && self.has_link == other.has_link
            && self.mentions == other.mentions
            && self.in_thread == other.in_thread
            && self.edited_at == other.edited_at
            && self.edit_id == other.edit_id
            && self.encrypted == other.encrypted
            && self.media == other.media
            && self.state == other.state
    }

    pub(super) fn is_redacted(&self, redacted: &HashSet<OwnedEventId>) -> bool {
        redacted.contains(&self.event_id)
            || self
                .edit_id
                .as_ref()
                .is_some_and(|edit| redacted.contains(edit))
    }

    pub(super) fn attachment_items(&self, kind: RoomAttachmentKind) -> Vec<RoomAttachmentView> {
        let item = |gallery_index, content| RoomAttachmentView {
            event_id: self.event_id.clone(),
            gallery_index,
            sender: self.sender.clone(),
            timestamp: self.origin_server_ts,
            content,
        };
        if kind == RoomAttachmentKind::Link {
            if !self.has_link {
                return Vec::new();
            }
            let urls = link_urls(&self.body);
            if urls.is_empty() {
                return Vec::new();
            }
            return vec![item(
                None,
                RoomAttachmentContentView::Link {
                    urls,
                    body: self.body.clone(),
                },
            )];
        }
        self.media
            .iter()
            .filter(|(_, content)| fits(kind, content))
            .map(|(gallery_index, content)| item(*gallery_index, content.clone()))
            .collect()
    }

    pub(super) fn needs_media(&self, kind: RoomAttachmentKind) -> bool {
        self.media.is_empty()
            && match kind {
                RoomAttachmentKind::Media => {
                    self.carries(SearchAttachment::Image) || self.carries(SearchAttachment::Video)
                }
                RoomAttachmentKind::File => {
                    self.carries(SearchAttachment::File) || self.carries(SearchAttachment::Audio)
                }
                RoomAttachmentKind::Link => false,
            }
    }

    pub(super) fn carries(&self, attachment: SearchAttachment) -> bool {
        match attachment {
            SearchAttachment::Link => self.has_link,
            other => self.attachments.contains(&other),
        }
    }

    fn has_file_type(&self, kind: &str) -> bool {
        let kind = kind.trim_start_matches('.').to_ascii_lowercase();
        let named = |filename: &str, mime: Option<&str>| {
            filename
                .rsplit_once('.')
                .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case(&kind))
                || mime.is_some_and(|mime| {
                    mime.rsplit_once('/')
                        .is_some_and(|(_, subtype)| subtype.eq_ignore_ascii_case(&kind))
                })
        };
        if self.media.is_empty() {
            return !self.attachments.is_empty() && named(&self.body, None);
        }
        self.media.iter().any(|(_, content)| match content {
            RoomAttachmentContentView::Image { filename, mime, .. }
            | RoomAttachmentContentView::Video { filename, mime, .. }
            | RoomAttachmentContentView::File { filename, mime, .. } => {
                named(filename, mime.as_deref())
            }
            RoomAttachmentContentView::Link { .. } => false,
        })
    }

    pub(super) fn matches(&self, filter: &IndexFilter, terms: &FoldedTerms) -> bool {
        if !filter.senders.is_empty() && !filter.senders.contains(&self.sender) {
            return false;
        }
        if filter.not_senders.contains(&self.sender) {
            return false;
        }
        if filter
            .not_mentions
            .iter()
            .any(|mention| self.mentions.contains(mention))
        {
            return false;
        }
        if filter
            .not_has
            .iter()
            .any(|attachment| self.carries(*attachment))
        {
            return false;
        }
        if !filter.mentions.is_empty()
            && !filter
                .mentions
                .iter()
                .any(|mention| self.mentions.contains(mention))
        {
            return false;
        }
        if !filter.has.is_empty()
            && !filter
                .has
                .iter()
                .any(|attachment| self.carries(*attachment))
        {
            return false;
        }
        if filter
            .after_ts
            .is_some_and(|after| self.origin_server_ts < after)
        {
            return false;
        }
        if filter
            .before_ts
            .is_some_and(|before| self.origin_server_ts > before)
        {
            return false;
        }
        if filter
            .in_thread
            .is_some_and(|wanted| wanted != self.in_thread)
        {
            return false;
        }
        if filter
            .pinned
            .is_some_and(|wanted| wanted != terms.pinned.contains(&self.event_id))
        {
            return false;
        }

        if filter.state_events.unwrap_or(false) != self.state {
            return false;
        }
        if !filter.file_types.is_empty()
            && !filter
                .file_types
                .iter()
                .any(|kind| self.has_file_type(kind))
        {
            return false;
        }
        if filter
            .not_file_types
            .iter()
            .any(|kind| self.has_file_type(kind))
        {
            return false;
        }
        if terms
            .pattern
            .as_ref()
            .is_some_and(|pattern| !pattern.matches(self))
        {
            return false;
        }
        if !terms
            .phrases
            .iter()
            .all(|phrase| self.folded.contains(phrase))
        {
            return false;
        }
        if terms.exclude.iter().any(|term| self.folded.contains(term)) {
            return false;
        }

        true
    }
}

pub(super) struct FoldedTerms {
    pub(super) phrases: Vec<String>,
    pub(super) exclude: Vec<String>,
    pub(super) pinned: HashSet<OwnedEventId>,
    pub(super) pattern: Option<BodyPattern>,
}

const PATTERN_SIZE_LIMIT: usize = 1 << 20;

pub(super) enum BodyPattern {
    Regex(Regex),
    Literal(String),
}

impl BodyPattern {
    fn of(source: &str) -> Self {
        RegexBuilder::new(source)
            .case_insensitive(true)
            .size_limit(PATTERN_SIZE_LIMIT)
            .build()
            .map_or_else(|_| Self::Literal(source.to_lowercase()), Self::Regex)
    }

    fn matches(&self, document: &Document) -> bool {
        match self {
            Self::Regex(pattern) => {
                pattern.is_match(&document.body) || pattern.is_match(&document.folded)
            }
            Self::Literal(text) => document.folded.contains(text.as_str()),
        }
    }
}

impl FoldedTerms {
    pub(super) fn of(filter: &IndexFilter, pinned: HashSet<OwnedEventId>) -> Self {
        Self {
            pinned,
            pattern: filter.pattern.as_deref().map(BodyPattern::of),
            phrases: filter
                .phrases
                .iter()
                .map(|term| term.to_lowercase())
                .collect(),
            exclude: filter
                .exclude
                .iter()
                .map(|term| term.to_lowercase())
                .collect(),
        }
    }
}

pub(super) fn indexable_body(body: &str) -> String {
    remove_plain_reply_fallback(body).to_owned()
}

pub(super) fn without_profile_name(body: &str, raw: Option<&serde_json::Value>) -> String {
    let Some(profile) = crate::view::per_message_profile(raw) else {
        return body.to_owned();
    };
    crate::matrix_html::strip_profile_fallback_body(
        body,
        profile
            .display_name
            .as_deref()
            .filter(|_| profile.has_fallback),
    )
}

pub(super) fn message_text(msgtype: &MessageType, raw: Option<&serde_json::Value>) -> String {
    let body = indexable_body(&without_profile_name(msgtype.body(), raw));
    let filenames = match msgtype {
        MessageType::Gallery(gallery) => crate::view::gallery_filenames(gallery),
        MessageType::Image(image) => vec![image.filename()],
        MessageType::Video(video) => vec![video.filename()],
        MessageType::Audio(audio) => vec![audio.filename()],
        MessageType::File(file) => vec![file.filename()],
        _ => return body,
    };
    std::iter::once(body.as_str())
        .chain(filenames)
        .filter(|text| !text.is_empty())
        .fold(Vec::<&str>::new(), |mut lines, text| {
            if !lines.contains(&text) {
                lines.push(text);
            }
            lines
        })
        .join("\n")
}

pub(super) const fn replacement_of(
    message: &OriginalSyncRoomMessageEvent,
) -> Option<&Replacement<RoomMessageEventContentWithoutRelation>> {
    match &message.content.relates_to {
        Some(Relation::Replacement(replacement)) => Some(replacement),
        _ => None,
    }
}

pub(super) fn document_of(
    message: &OriginalSyncRoomMessageEvent,
    content: Option<&serde_json::Value>,
    encrypted: bool,
) -> Document {
    let body = message_text(&message.content.msgtype, content);
    Document {
        event_id: message.event_id.clone(),
        has_link: contains_link(&body),
        folded: String::new(),
        body,
        sender: message.sender.clone(),
        origin_server_ts: message.origin_server_ts.get().into(),
        attachments: attachments_of(&message.content.msgtype),
        mentions: mentioned_users(message.content.mentions.as_ref()),
        in_thread: matches!(message.content.relates_to, Some(Relation::Thread(_))),
        edited_at: None,
        edit_id: None,
        encrypted: Some(encrypted),
        media: attachment_contents(&message.content.msgtype, content),
        state: false,
    }
}

pub(super) fn poll_start_document(message: &AnySyncMessageLikeEvent) -> Option<Document> {
    match message {
        AnySyncMessageLikeEvent::UnstablePollStart(SyncMessageLikeEvent::Original(poll)) => {
            let UnstablePollStartEventContent::New(content) = &poll.content else {
                return None;
            };
            let block = &content.poll_start;
            let lines = std::iter::once(block.question.text.as_str())
                .chain(block.answers.iter().map(|answer| answer.text.as_str()));
            Some(poll_document(
                poll.event_id.clone(),
                poll.sender.clone(),
                poll.origin_server_ts.get().into(),
                lines,
            ))
        }
        AnySyncMessageLikeEvent::PollStart(SyncMessageLikeEvent::Original(poll)) => {
            let block = &poll.content.poll;
            let lines = std::iter::once(block.question.text.find_plain().unwrap_or_default())
                .chain(
                    block
                        .answers
                        .iter()
                        .map(|answer| answer.text.find_plain().unwrap_or_default()),
                );
            Some(poll_document(
                poll.event_id.clone(),
                poll.sender.clone(),
                poll.origin_server_ts.get().into(),
                lines,
            ))
        }
        _ => None,
    }
}

pub(super) fn sticker_document(sticker: &OriginalSyncStickerEvent) -> Document {
    let mut document = poll_document(
        sticker.event_id.clone(),
        sticker.sender.clone(),
        sticker.origin_server_ts.get().into(),
        std::iter::once(sticker.content.body.as_str()),
    );
    document.attachments = Vec::new();
    document
}

fn poll_document<'text>(
    event_id: OwnedEventId,
    sender: OwnedUserId,
    origin_server_ts: u64,
    lines: impl Iterator<Item = &'text str>,
) -> Document {
    let body = lines
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    Document {
        event_id,
        has_link: contains_link(&body),
        folded: String::new(),
        body,
        sender,
        origin_server_ts,
        attachments: vec![SearchAttachment::Poll],
        mentions: Vec::new(),
        in_thread: false,
        edited_at: None,
        edit_id: None,
        encrypted: None,
        media: Vec::new(),
        state: false,
    }
}

pub(super) fn state_document(
    state: &AnySyncStateEvent,
    content: Option<&serde_json::Value>,
) -> Document {
    let body = content
        .and_then(serde_json::Value::as_object)
        .map(|fields| {
            fields
                .values()
                .filter_map(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    Document {
        event_id: state.event_id().to_owned(),
        has_link: false,
        folded: String::new(),
        body,
        sender: state.sender().to_owned(),
        origin_server_ts: state.origin_server_ts().get().into(),
        attachments: Vec::new(),
        mentions: Vec::new(),
        in_thread: false,
        edited_at: None,
        edit_id: None,
        encrypted: None,
        media: Vec::new(),
        state: true,
    }
}

pub(super) fn with_edit(
    document: &mut Document,
    edit: &OriginalSyncRoomMessageEvent,
    replacement: &Replacement<RoomMessageEventContentWithoutRelation>,
    raw: Option<&serde_json::Value>,
) -> bool {
    let edited_at: u64 = edit.origin_server_ts.get().into();
    if document.sender != edit.sender
        || document.edited_at.is_some_and(|at| at > edited_at)
        || document.edit_id.as_ref() == Some(&edit.event_id)
    {
        return false;
    }

    let content = &replacement.new_content;
    document.body = message_text(&content.msgtype, raw);
    document.has_link = contains_link(&document.body);
    document.attachments = attachments_of(&content.msgtype);
    document.mentions = mentioned_users(content.mentions.as_ref());
    document.edited_at = Some(edited_at);
    document.edit_id = Some(edit.event_id.clone());
    document.media = attachment_contents(
        &content.msgtype,
        raw.and_then(|raw| raw.get("m.new_content")),
    );
    true
}

pub(super) fn apply_replacement(
    document: &mut Document,
    event: &TimelineEvent,
    redacted: &HashSet<OwnedEventId>,
) -> Option<bool> {
    let encrypted = document.encrypted?;
    let (edit, raw) = room_message(event)?;
    let replacement = replacement_of(&edit)?;
    if replacement.event_id != document.event_id
        || edit.sender != document.sender
        || redacted.contains(&edit.event_id)
        || (encrypted && event.encryption_info().is_none())
    {
        return None;
    }
    Some(with_edit(document, &edit, replacement, raw.as_ref()))
}

pub(super) fn adopt_edit(
    mut document: Document,
    existing: Option<&Document>,
    redacted: &HashSet<OwnedEventId>,
) -> Document {
    let Some(existing) = existing else {
        return document;
    };
    if existing.sender != document.sender
        || existing.edited_at <= document.edited_at
        || existing.is_redacted(redacted)
        || existing.encrypted != document.encrypted
    {
        return document;
    }

    document.body.clone_from(&existing.body);
    document.has_link = existing.has_link;
    document.attachments.clone_from(&existing.attachments);
    document.mentions.clone_from(&existing.mentions);
    document.media.clone_from(&existing.media);
    document.edited_at = existing.edited_at;
    document.edit_id.clone_from(&existing.edit_id);
    document
}

pub(super) fn attachments_of(msgtype: &MessageType) -> Vec<SearchAttachment> {
    match msgtype {
        MessageType::Image(_) => vec![SearchAttachment::Image],
        MessageType::Video(_) => vec![SearchAttachment::Video],
        MessageType::Audio(_) => vec![SearchAttachment::Audio],
        MessageType::File(_) => vec![SearchAttachment::File],
        MessageType::Gallery(gallery) => {
            let mut attachments = Vec::new();
            for item in &gallery.itemtypes {
                let attachment = match item {
                    GalleryItemType::Image(_) => SearchAttachment::Image,
                    GalleryItemType::Video(_) => SearchAttachment::Video,
                    GalleryItemType::Audio(_) => SearchAttachment::Audio,
                    GalleryItemType::File(_) => SearchAttachment::File,
                    _ => continue,
                };
                if !attachments.contains(&attachment) {
                    attachments.push(attachment);
                }
            }
            attachments
        }
        _ => Vec::new(),
    }
}

pub(super) fn contains_link(body: &str) -> bool {
    LinkFinder::new().links(body).next().is_some()
}

pub(super) fn mentioned_users(mentions: Option<&Mentions>) -> Vec<OwnedUserId> {
    mentions
        .map(|mentions| mentions.user_ids.iter().cloned().collect())
        .unwrap_or_default()
}

pub(super) fn room_message(
    event: &TimelineEvent,
) -> Option<(OriginalSyncRoomMessageEvent, Option<serde_json::Value>)> {
    match event.raw().deserialize().ok()? {
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
            SyncMessageLikeEvent::Original(message),
        )) => Some((message, raw_content(event))),
        _ => None,
    }
}

pub(super) async fn latest_content(
    cache: &RoomEventCache,
    event_id: &OwnedEventId,
    redacted: &HashSet<OwnedEventId>,
) -> Option<Document> {
    let (original, replacements) = cache
        .find_event_with_relations(event_id, Some(vec![RelationType::Replacement]))
        .await
        .ok()
        .flatten()?;

    edited_document(&original, &replacements, redacted)
}

pub(super) fn edited_document(
    original: &TimelineEvent,
    replacements: &[TimelineEvent],
    redacted: &HashSet<OwnedEventId>,
) -> Option<Document> {
    let (message, content) = room_message(original)?;
    if replacement_of(&message).is_some() {
        return None;
    }

    let mut document = document_of(
        &message,
        content.as_ref(),
        original.encryption_info().is_some(),
    );
    for (edit, raw) in valid_replacements(original, replacements)
        .filter_map(room_message)
        .filter(|(edit, _)| !redacted.contains(&edit.event_id))
    {
        if let Some(replacement) = replacement_of(&edit) {
            with_edit(&mut document, &edit, replacement, raw.as_ref());
        }
    }
    Some(document)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn a_sticker_is_searchable_by_its_description() {
        let sticker: super::OriginalSyncStickerEvent = serde_json::from_value(json!({
            "type": "m.sticker",
            "event_id": "$sticker:localhost",
            "sender": "@ginger:localhost",
            "origin_server_ts": 1,
            "content": {
                "body": "moai",
                "info": {},
                "url": "mxc://localhost/moai"
            }
        }))
        .unwrap();

        let document = super::sticker_document(&sticker);
        assert_eq!(document.body, "moai");
        assert_eq!(
            document.attachments,
            [] as [sable_model::search_filter::SearchAttachment; 0]
        );
    }

    #[test]
    fn single_media_is_searchable_by_its_filename() {
        use matrix_sdk::ruma::{
            OwnedMxcUri,
            events::room::message::{
                FileMessageEventContent, ImageMessageEventContent, MessageType,
            },
        };

        let url = OwnedMxcUri::from("mxc://localhost/a");

        let mut captioned =
            ImageMessageEventContent::plain("Sunset at the pier".to_owned(), url.clone());
        captioned.filename = Some("holiday-2026.jpg".to_owned());
        assert_eq!(
            super::message_text(&MessageType::Image(captioned), None),
            "Sunset at the pier\nholiday-2026.jpg"
        );

        let bare = FileMessageEventContent::plain("report.pdf".to_owned(), url);
        assert_eq!(
            super::message_text(&MessageType::File(bare), None),
            "report.pdf"
        );
    }

    #[test]
    fn a_profile_name_fallback_is_not_indexed() {
        use matrix_sdk::ruma::events::room::message::{MessageType, TextMessageEventContent};
        use serde_json::json;

        let text = |body: &str| MessageType::Text(TextMessageEventContent::plain(body));
        let profiled =
            json!({"m.per_message_profile": {"displayname": "Kris", "has_fallback": true}});

        assert_eq!(
            super::message_text(&text("Kris: hello"), Some(&profiled)),
            "hello"
        );
        assert_eq!(
            super::message_text(&text("Kris: hello"), None),
            "Kris: hello"
        );
        assert_eq!(
            super::message_text(&text("hello"), Some(&profiled)),
            "hello"
        );
    }

    #[test]
    fn test_polls_and_state_events_become_searchable_documents() {
        let poll: super::AnySyncMessageLikeEvent = serde_json::from_value(json!({
            "type": "org.matrix.msc3381.poll.start",
            "event_id": "$poll",
            "sender": "@alice:localhost",
            "origin_server_ts": 5,
            "content": {
                "org.matrix.msc3381.poll.start": {
                    "question": { "org.matrix.msc1767.text": "Lunch spot?" },
                    "kind": "org.matrix.msc3381.poll.disclosed",
                    "max_selections": 1,
                    "answers": [
                        { "id": "a", "org.matrix.msc1767.text": "Ramen" },
                        { "id": "b", "org.matrix.msc1767.text": "Tacos" }
                    ]
                },
                "org.matrix.msc1767.text": "Lunch spot?\n1. Ramen\n2. Tacos"
            }
        }))
        .expect("a poll start");
        let poll = super::poll_start_document(&poll).expect("a poll document");
        assert_eq!(poll.body, "Lunch spot?\nRamen\nTacos");
        assert!(poll.carries(super::SearchAttachment::Poll));

        let content = json!({ "name": "Design crew" });
        let state: super::AnySyncStateEvent = serde_json::from_value(json!({
            "type": "m.room.name",
            "event_id": "$name",
            "state_key": "",
            "sender": "@alice:localhost",
            "origin_server_ts": 6,
            "content": content
        }))
        .expect("a state event");
        let state = super::state_document(&state, Some(&content));
        assert_eq!(state.body, "Design crew");
        assert!(state.state);
    }

    #[test]
    fn test_a_replys_quoted_fallback_is_not_indexed() {
        let replied = super::indexable_body(
            "> <@kris:localhost> the deploy pipeline is broken\n\nlooking at it now",
        );
        assert_eq!(replied, "looking at it now");

        assert_eq!(
            super::indexable_body("> * <@kris:localhost> waves\n\nhello"),
            "hello"
        );
        assert_eq!(
            super::indexable_body("> not a fallback, just a quote"),
            "> not a fallback, just a quote"
        );
    }
}
