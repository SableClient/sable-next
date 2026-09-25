mod crawl;
mod persist;
mod server;
mod tokenize;

pub(crate) use crawl::CrawlProgress;
pub(crate) use server::ServerSearch;

use std::collections::hash_map::Entry;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{StreamExt, stream};
use linkify::LinkFinder;
use matrix_sdk::RoomState;
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::event_cache::{RoomEventCache, RoomEventCacheUpdate};
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::events::ignored_user_list::IgnoredUserListEventContent;
use matrix_sdk::ruma::events::relation::{RelationType, Replacement};
use matrix_sdk::ruma::events::room::message::{
    GalleryItemType, MessageType, OriginalSyncRoomMessageEvent, Relation,
    RoomMessageEventContentWithoutRelation, sanitize::remove_plain_reply_fallback,
};
use matrix_sdk::ruma::events::{
    AnySyncMessageLikeEvent, AnySyncTimelineEvent, Mentions, SyncMessageLikeEvent,
    room::redaction::SyncRoomRedactionEvent,
};
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId, OwnedUserId, RoomId};
use probly_search::{Index, score::bm25};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::Core;
use crate::protocol::{SearchAttachment, SearchFilter, SearchOrder};

const BODY_FIELD_COUNT: usize = 1;
const BODY_FIELD_BOOST: [f64; BODY_FIELD_COUNT] = [1.0];
const EVENTS_PER_INGEST_YIELD: usize = 16;
const DOCUMENTS_PER_RESTORE_YIELD: usize = 256;
const RETIRED_KEYS_BEFORE_VACUUM: usize = 64;

const MAX_INDEXED_MESSAGES: usize = 50_000;
const PINNED_FETCH_CONCURRENCY: usize = 4;

const INITIAL_DOCUMENTS: usize = 64;
const PERSIST_INTERVAL: Duration = Duration::from_secs(20);
const CHANGES_BEFORE_FLUSH: usize = 32;
const TICKS_BEFORE_FLUSH: u32 = 15;

type DocKey = u32;

struct Body(String);

#[derive(Clone, Serialize, Deserialize)]
struct Document {
    event_id: OwnedEventId,
    body: String,
    #[serde(skip)]
    folded: String,
    sender: OwnedUserId,
    origin_server_ts: u64,
    attachments: Vec<SearchAttachment>,
    has_link: bool,
    mentions: Vec<OwnedUserId>,
    in_thread: bool,
    #[serde(default)]
    edited_at: Option<u64>,
}

impl Document {
    fn same_metadata(&self, other: &Self) -> bool {
        self.sender == other.sender
            && self.origin_server_ts == other.origin_server_ts
            && self.attachments == other.attachments
            && self.has_link == other.has_link
            && self.mentions == other.mentions
            && self.in_thread == other.in_thread
            && self.edited_at == other.edited_at
    }

    fn carries(&self, attachment: SearchAttachment) -> bool {
        match attachment {
            SearchAttachment::Link => self.has_link,
            other => self.attachments.contains(&other),
        }
    }

    fn matches(&self, filter: &SearchFilter, terms: &FoldedTerms) -> bool {
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

struct FoldedTerms {
    phrases: Vec<String>,
    exclude: Vec<String>,
    pinned: HashSet<OwnedEventId>,
}

impl FoldedTerms {
    fn of(filter: &SearchFilter, pinned: HashSet<OwnedEventId>) -> Self {
        Self {
            pinned,
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

fn body_field(body: &Body) -> Vec<&str> {
    vec![body.0.as_str()]
}

struct RoomIndex {
    index: Index<DocKey>,
    documents: HashMap<DocKey, Document>,
    key_of: HashMap<OwnedEventId, DocKey>,
    classified: HashSet<OwnedEventId>,
    evicted: HashSet<OwnedEventId>,
    edits: HashMap<OwnedEventId, OwnedEventId>,
    redacted: HashSet<OwnedEventId>,
    by_age: BTreeSet<(u64, DocKey)>,
    next_key: DocKey,
    retired_keys: usize,
    changes: usize,
    ticks_since_flush: u32,
    dirty: bool,
}

impl RoomIndex {
    fn new() -> Self {
        Self::sized(INITIAL_DOCUMENTS)
    }

    fn sized(documents: usize) -> Self {
        Self {
            index: Index::new_with_capacity(BODY_FIELD_COUNT, documents, documents),
            documents: HashMap::new(),
            key_of: HashMap::new(),
            classified: HashSet::new(),
            evicted: HashSet::new(),
            edits: HashMap::new(),
            redacted: HashSet::new(),
            by_age: BTreeSet::new(),
            next_key: 0,
            retired_keys: 0,
            changes: 0,
            ticks_since_flush: 0,
            dirty: false,
        }
    }

    async fn restored(
        documents: Vec<Document>,
        classified: Vec<OwnedEventId>,
        edits: Vec<(OwnedEventId, OwnedEventId)>,
    ) -> Self {
        let mut index = Self::sized(documents.len().max(INITIAL_DOCUMENTS));
        for (position, document) in documents.into_iter().enumerate() {
            if position > 0 && position.is_multiple_of(DOCUMENTS_PER_RESTORE_YIELD) {
                matrix_sdk::sleep::sleep(Duration::ZERO).await;
            }
            index.upsert(document);
        }
        index.classified = classified.into_iter().collect();
        index.edits = edits.into_iter().collect();
        index.dirty = false;
        index.changes = 0;
        index
    }

    fn snapshot(&self) -> persist::StoredRoom {
        persist::StoredRoom::new(
            self.documents.values().map(Document::clone).collect(),
            self.classified.iter().cloned().collect(),
            self.edits
                .iter()
                .map(|(edit, target)| (edit.clone(), target.clone()))
                .collect(),
        )
    }

    fn len(&self) -> usize {
        self.documents.len()
    }

    fn oldest(&self) -> Option<(u64, DocKey)> {
        self.by_age.first().copied()
    }

    fn newest_ts(&self) -> Option<u64> {
        self.by_age.last().map(|&(ts, _)| ts)
    }

    fn evict(&mut self, key: DocKey) {
        let Some(document) = self.documents.remove(&key) else {
            return;
        };
        self.dirty = true;
        self.changes = self.changes.saturating_add(1);
        self.by_age.remove(&(document.origin_server_ts, key));
        self.key_of.remove(&document.event_id);
        self.classified.remove(&document.event_id);
        self.edits.retain(|_, target| *target != document.event_id);
        self.evicted.insert(document.event_id.clone());
        self.index.remove_document(key);
        self.retired_keys = self.retired_keys.saturating_add(1);
        self.vacuum_if_due();
    }

    fn already_classified(&self, event_id: &EventId) -> bool {
        self.classified.contains(event_id) || self.evicted.contains(event_id)
    }

    fn mark_classified(&mut self, event_id: OwnedEventId) {
        self.dirty |= self.classified.insert(event_id);
    }

    fn document(&self, event_id: &OwnedEventId) -> Option<&Document> {
        let key = self.key_of.get(event_id)?;
        self.documents.get(key)
    }

    fn upsert(&mut self, document: Document) {
        if let Some(&key) = self.key_of.get(&document.event_id)
            && let Some(indexed) = self.documents.get_mut(&key)
            && indexed.body == document.body
        {
            if !indexed.same_metadata(&document) {
                self.by_age.remove(&(indexed.origin_server_ts, key));
                self.by_age.insert((document.origin_server_ts, key));
                *indexed = Document {
                    folded: std::mem::take(&mut indexed.folded),
                    ..document
                };
                self.dirty = true;
                self.changes = self.changes.saturating_add(1);
            }
            return;
        }
        self.retire(&document.event_id);
        self.vacuum_if_due();
        self.dirty = true;
        self.changes = self.changes.saturating_add(1);

        let key = self.take_unused_key();
        let folded = document.body.to_lowercase();
        let body = Body(document.body);
        self.index
            .add_document(&[body_field], tokenize::tokenize, key, &body);
        self.key_of.insert(document.event_id.clone(), key);
        self.by_age.insert((document.origin_server_ts, key));
        self.documents.insert(
            key,
            Document {
                body: body.0,
                folded,
                ..document
            },
        );
    }

    fn remove(&mut self, event_id: &OwnedEventId) {
        self.retire(event_id);
        self.vacuum_if_due();
    }

    fn retire(&mut self, event_id: &OwnedEventId) {
        let Some(key) = self.key_of.remove(event_id) else {
            return;
        };
        self.dirty = true;
        self.changes = self.changes.saturating_add(1);
        if let Some(document) = self.documents.remove(&key) {
            self.by_age.remove(&(document.origin_server_ts, key));
        }
        self.index.remove_document(key);
        self.retired_keys = self.retired_keys.saturating_add(1);
    }

    fn vacuum_if_due(&mut self) {
        if self.retired_keys >= RETIRED_KEYS_BEFORE_VACUUM {
            self.index.vacuum();
            self.retired_keys = 0;
        }
    }

    const fn take_unused_key(&mut self) -> DocKey {
        let key = self.next_key;
        self.next_key = self.next_key.wrapping_add(1);
        key
    }

    fn ranked<'index>(
        &'index self,
        room_id: &'index OwnedRoomId,
        query: &str,
        filter: &SearchFilter,
        terms: &FoldedTerms,
    ) -> Vec<Ranked<'index>> {
        if query.is_empty() {
            return self
                .documents
                .values()
                .filter(|document| document.matches(filter, terms))
                .map(|document| Ranked::from_document(room_id, document, 0.0))
                .collect();
        }

        self.index
            .query(
                query,
                &mut bm25::new(),
                tokenize::tokenize,
                &BODY_FIELD_BOOST,
            )
            .into_iter()
            .filter_map(|result| {
                let document = self.documents.get(&result.key)?;
                document
                    .matches(filter, terms)
                    .then(|| Ranked::from_document(room_id, document, result.score))
            })
            .collect()
    }
}

pub(crate) struct MessageIndex {
    rooms: HashMap<OwnedRoomId, RoomIndex>,
    unreadable: HashSet<OwnedRoomId>,
    capacity: usize,
}

#[derive(Clone)]
pub(crate) struct Hit {
    pub(crate) room_id: OwnedRoomId,
    pub(crate) event_id: OwnedEventId,
    pub(crate) body: String,
    pub(crate) sender: OwnedUserId,
    pub(crate) origin_server_ts: u64,
    pub(crate) score: f64,
}

struct Ranked<'index> {
    room_id: &'index OwnedRoomId,
    event_id: &'index EventId,
    origin_server_ts: u64,
    score: f64,
}

impl<'index> Ranked<'index> {
    fn from_document(room_id: &'index OwnedRoomId, document: &'index Document, score: f64) -> Self {
        Self {
            room_id,
            event_id: document.event_id.as_ref(),
            origin_server_ts: document.origin_server_ts,
            score,
        }
    }
}

impl MessageIndex {
    pub(crate) fn new() -> Self {
        Self::with_capacity(MAX_INDEXED_MESSAGES)
    }

    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            rooms: HashMap::new(),
            unreadable: HashSet::new(),
            capacity,
        }
    }

    pub(crate) fn forget_room(&mut self, room_id: &OwnedRoomId) {
        self.rooms.remove(room_id);
        self.unreadable.remove(room_id);
    }

    fn mark_unreadable(&mut self, room_id: &OwnedRoomId) {
        self.unreadable.insert(room_id.clone());
    }

    async fn restore_room(
        &mut self,
        room_id: &OwnedRoomId,
        documents: Vec<Document>,
        classified: Vec<OwnedEventId>,
        edits: Vec<(OwnedEventId, OwnedEventId)>,
    ) {
        let index = RoomIndex::restored(documents, classified, edits).await;
        self.rooms.insert(room_id.clone(), index);
    }

    fn unclassified(
        &self,
        room_id: &OwnedRoomId,
        events: Vec<TimelineEvent>,
    ) -> Vec<TimelineEvent> {
        let Some(index) = self.rooms.get(room_id) else {
            return events;
        };

        events
            .into_iter()
            .filter(|event| {
                event
                    .event_id()
                    .is_some_and(|event_id| !index.already_classified(event_id))
            })
            .collect()
    }

    fn mark_dirty(&mut self, room_id: &OwnedRoomId) {
        if let Some(index) = self.rooms.get_mut(room_id) {
            index.dirty = true;
        }
    }

    fn dirty_rooms(&self) -> Vec<OwnedRoomId> {
        self.rooms
            .iter()
            .filter(|(room_id, index)| index.dirty && !self.unreadable.contains(*room_id))
            .map(|(room_id, _)| room_id.clone())
            .collect()
    }

    fn rooms_due_to_flush(&mut self) -> Vec<OwnedRoomId> {
        let mut due = Vec::new();
        for (room_id, index) in &mut self.rooms {
            if !index.dirty || self.unreadable.contains(room_id) {
                index.ticks_since_flush = 0;
                continue;
            }
            index.ticks_since_flush = index.ticks_since_flush.saturating_add(1);
            if index.changes >= CHANGES_BEFORE_FLUSH
                || index.ticks_since_flush >= TICKS_BEFORE_FLUSH
            {
                due.push(room_id.clone());
            }
        }
        due
    }

    fn take_snapshot(&mut self, room_id: &OwnedRoomId) -> Option<persist::StoredRoom> {
        let index = self.rooms.get_mut(room_id)?;
        index.dirty = false;
        index.changes = 0;
        index.ticks_since_flush = 0;
        Some(index.snapshot())
    }

    fn finish_restore(&mut self) {
        self.trim_to_capacity();
    }

    pub(crate) fn documents(&self) -> usize {
        self.rooms.values().map(RoomIndex::len).sum()
    }

    pub(crate) fn is_full(&self) -> bool {
        self.documents() >= self.capacity
    }

    pub(crate) fn newest_in(&self, room_id: &RoomId) -> Option<u64> {
        self.rooms.get(room_id).and_then(RoomIndex::newest_ts)
    }

    fn trim_to_capacity(&mut self) {
        let mut held = self.documents();

        while held > self.capacity {
            let Some((room_id, key)) = self
                .rooms
                .iter()
                .filter_map(|(room_id, index)| index.oldest().map(|(ts, key)| (ts, room_id, key)))
                .min()
                .map(|(_, room_id, key)| (room_id.clone(), key))
            else {
                return;
            };

            let Some(index) = self.rooms.get_mut(&room_id) else {
                return;
            };
            index.evict(key);
            held -= 1;
        }
    }

    #[cfg(test)]
    pub(crate) fn search(
        &self,
        query: &str,
        filter: &SearchFilter,
        order: SearchOrder,
        limit: usize,
        offset: usize,
    ) -> Vec<Hit> {
        self.search_pinned(query, filter, HashSet::new(), order, limit, offset)
    }

    pub(crate) fn search_pinned(
        &self,
        query: &str,
        filter: &SearchFilter,
        pinned: HashSet<OwnedEventId>,
        order: SearchOrder,
        limit: usize,
        offset: usize,
    ) -> Vec<Hit> {
        let terms = FoldedTerms::of(filter, pinned);
        let ranked = self
            .rooms
            .iter()
            .filter(|(room_id, _)| {
                (filter.rooms.is_empty() || filter.rooms.iter().any(|wanted| wanted == *room_id))
                    && !filter.not_rooms.iter().any(|denied| denied == *room_id)
            })
            .flat_map(|(room_id, index)| index.ranked(room_id, query, filter, &terms))
            .collect();

        self.materialize(page_ranked(ranked, order, limit, offset))
    }

    fn materialize(&self, ranked: Vec<Ranked<'_>>) -> Vec<Hit> {
        ranked
            .into_iter()
            .filter_map(|entry| {
                let index = self.rooms.get(entry.room_id)?;
                let key = index.key_of.get(entry.event_id)?;
                let document = index.documents.get(key)?;
                Some(Hit {
                    room_id: entry.room_id.clone(),
                    event_id: document.event_id.clone(),
                    body: document.body.clone(),
                    sender: document.sender.clone(),
                    origin_server_ts: document.origin_server_ts,
                    score: entry.score,
                })
            })
            .collect()
    }

    pub(crate) async fn ingest(
        &mut self,
        room_id: &OwnedRoomId,
        events: Vec<TimelineEvent>,
        cache: &RoomEventCache,
        rules: &RedactionRules,
    ) -> usize {
        self.rooms
            .entry(room_id.clone())
            .or_insert_with(RoomIndex::new);
        let mut fresh = 0;
        let mut since_yield = 0;

        for event in events {
            if since_yield == EVENTS_PER_INGEST_YIELD {
                since_yield = 0;
                self.trim_to_capacity();
                matrix_sdk::sleep::sleep(Duration::ZERO).await;
            }

            let Some(index) = self.rooms.get_mut(room_id) else {
                continue;
            };

            let Some(event_id) = event.event_id() else {
                continue;
            };

            if index.already_classified(event_id) {
                continue;
            }
            fresh += 1;
            since_yield += 1;

            if event.kind.is_utd() {
                continue;
            }
            index.mark_classified(event_id.to_owned());

            let Ok(AnySyncTimelineEvent::MessageLike(message)) = event.raw().deserialize() else {
                continue;
            };

            match message {
                AnySyncMessageLikeEvent::RoomMessage(message) => {
                    let Some(message) = message.as_original() else {
                        continue;
                    };
                    let target = edited_or_own_event_id(message);
                    if index.redacted.contains(&message.event_id)
                        || index.redacted.contains(&target)
                    {
                        continue;
                    }

                    let cached = latest_content(cache, &target, &index.redacted).await;
                    let existing = index.document(&target).cloned();
                    let document = match replacement_of(message) {
                        Some(replacement) => {
                            index.edits.insert(message.event_id.clone(), target.clone());
                            let base = cached
                                .or(existing)
                                .unwrap_or_else(|| provisional_edit(message, target));
                            with_edit(base, message, replacement)
                        }
                        None => adopt_edit(
                            cached.unwrap_or_else(|| document_of(message)),
                            existing.as_ref(),
                        ),
                    };

                    index.upsert(document);
                }

                AnySyncMessageLikeEvent::RoomRedaction(redaction) => {
                    let Some(redacted) = redacted_event_id(&redaction, rules) else {
                        continue;
                    };
                    index.redacted.insert(redacted.clone());

                    if let Some(target) = index.edits.remove(&redacted) {
                        match latest_content(cache, &target, &index.redacted).await {
                            Some(document) => index.upsert(document),
                            None => index.remove(&target),
                        }
                    } else {
                        index.edits.retain(|_, target| *target != redacted);
                        index.remove(&redacted);
                    }
                }

                _ => {}
            }
        }

        self.trim_to_capacity();
        fresh
    }
}

fn by_rank(left: &Ranked<'_>, right: &Ranked<'_>) -> std::cmp::Ordering {
    right
        .score
        .partial_cmp(&left.score)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| left.event_id.cmp(right.event_id))
}

fn by_recency(left: &Ranked<'_>, right: &Ranked<'_>) -> std::cmp::Ordering {
    right
        .origin_server_ts
        .cmp(&left.origin_server_ts)
        .then_with(|| left.event_id.cmp(right.event_id))
}

fn by_age(left: &Ranked<'_>, right: &Ranked<'_>) -> std::cmp::Ordering {
    left.origin_server_ts
        .cmp(&right.origin_server_ts)
        .then_with(|| left.event_id.cmp(right.event_id))
}

fn page_ranked(
    mut ranked: Vec<Ranked<'_>>,
    order: SearchOrder,
    limit: usize,
    offset: usize,
) -> Vec<Ranked<'_>> {
    let compare = match order {
        SearchOrder::Rank => by_rank,
        SearchOrder::Recent => by_recency,
        SearchOrder::Oldest => by_age,
    };
    let wanted = offset.saturating_add(limit);

    if wanted < ranked.len() {
        ranked.select_nth_unstable_by(wanted, compare);
        ranked.truncate(wanted);
    }
    ranked.sort_unstable_by(compare);

    ranked.drain(..offset.min(ranked.len()));
    ranked.truncate(limit);
    ranked
}

fn edited_or_own_event_id(original: &OriginalSyncRoomMessageEvent) -> OwnedEventId {
    match &original.content.relates_to {
        Some(Relation::Replacement(replacement)) => replacement.event_id.clone(),
        _ => original.event_id.clone(),
    }
}

fn ingestable_events(
    diffs: Vec<matrix_sdk_ui::eyeball_im::VectorDiff<TimelineEvent>>,
) -> Vec<TimelineEvent> {
    use matrix_sdk_ui::eyeball_im::VectorDiff as In;

    diffs
        .into_iter()
        .flat_map(|diff| match diff {
            In::Append { values } | In::Reset { values } => values.into_iter().collect(),
            In::PushFront { value }
            | In::PushBack { value }
            | In::Insert { value, .. }
            | In::Set { value, .. } => vec![value],
            _ => Vec::new(),
        })
        .collect()
}

fn indexable_body(body: &str) -> String {
    remove_plain_reply_fallback(body).to_owned()
}

const fn replacement_of(
    message: &OriginalSyncRoomMessageEvent,
) -> Option<&Replacement<RoomMessageEventContentWithoutRelation>> {
    match &message.content.relates_to {
        Some(Relation::Replacement(replacement)) => Some(replacement),
        _ => None,
    }
}

fn document_of(message: &OriginalSyncRoomMessageEvent) -> Document {
    let body = indexable_body(message.content.body());
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
    }
}

fn provisional_edit(edit: &OriginalSyncRoomMessageEvent, target: OwnedEventId) -> Document {
    Document {
        event_id: target,
        body: String::new(),
        folded: String::new(),
        sender: edit.sender.clone(),
        origin_server_ts: edit.origin_server_ts.get().into(),
        attachments: Vec::new(),
        has_link: false,
        mentions: Vec::new(),
        in_thread: false,
        edited_at: None,
    }
}

fn with_edit(
    mut document: Document,
    edit: &OriginalSyncRoomMessageEvent,
    replacement: &Replacement<RoomMessageEventContentWithoutRelation>,
) -> Document {
    let edited_at: u64 = edit.origin_server_ts.get().into();
    if document.sender != edit.sender || document.edited_at.is_some_and(|at| at > edited_at) {
        return document;
    }

    let content = &replacement.new_content;
    document.body = indexable_body(content.msgtype.body());
    document.has_link = contains_link(&document.body);
    document.attachments = attachments_of(&content.msgtype);
    document.mentions = mentioned_users(content.mentions.as_ref());
    document.edited_at = Some(edited_at);
    document
}

fn adopt_edit(mut document: Document, existing: Option<&Document>) -> Document {
    let Some(existing) = existing else {
        return document;
    };
    if existing.sender != document.sender || existing.edited_at <= document.edited_at {
        return document;
    }

    document.body.clone_from(&existing.body);
    document.has_link = existing.has_link;
    document.attachments.clone_from(&existing.attachments);
    document.mentions.clone_from(&existing.mentions);
    document.edited_at = existing.edited_at;
    document
}

fn attachments_of(msgtype: &MessageType) -> Vec<SearchAttachment> {
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

fn contains_link(body: &str) -> bool {
    LinkFinder::new().links(body).next().is_some()
}

fn mentioned_users(mentions: Option<&Mentions>) -> Vec<OwnedUserId> {
    mentions
        .map(|mentions| mentions.user_ids.iter().cloned().collect())
        .unwrap_or_default()
}

fn redacted_event_id(
    redaction: &SyncRoomRedactionEvent,
    rules: &RedactionRules,
) -> Option<OwnedEventId> {
    let original = redaction.as_original()?;
    let (preferred, fallback) = if rules.content_field_redacts {
        (&original.content.redacts, &original.redacts)
    } else {
        (&original.redacts, &original.content.redacts)
    };
    preferred.clone().or_else(|| fallback.clone())
}

fn room_message(event: &TimelineEvent) -> Option<OriginalSyncRoomMessageEvent> {
    match event.raw().deserialize().ok()? {
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
            SyncMessageLikeEvent::Original(message),
        )) => Some(message),
        _ => None,
    }
}

async fn latest_content(
    cache: &RoomEventCache,
    event_id: &OwnedEventId,
    redacted: &HashSet<OwnedEventId>,
) -> Option<Document> {
    let (original, replacements) = cache
        .find_event_with_relations(event_id, Some(vec![RelationType::Replacement]))
        .await
        .ok()
        .flatten()?;

    let original = room_message(&original)?;
    if replacement_of(&original).is_some() {
        return None;
    }

    Some(
        replacements
            .iter()
            .filter_map(room_message)
            .filter(|edit| !redacted.contains(&edit.event_id))
            .fold(
                document_of(&original),
                |document, edit| match replacement_of(&edit) {
                    Some(replacement) => with_edit(document, &edit, replacement),
                    None => document,
                },
            ),
    )
}

impl Core {
    pub(crate) async fn search_messages(
        &self,
        query: &str,
        filter: &SearchFilter,
        order: SearchOrder,
        limit: usize,
        offset: usize,
    ) -> Vec<Hit> {
        if order != SearchOrder::Oldest
            && let Ok(client) = self.client().await
            && let Some(room_id) = server::target(&client, query, filter).await
        {
            let target = server::ServerQuery {
                room_id: &room_id,
                query,
                filter,
                order,
                limit,
                offset,
            };

            match self.search_server(&client, target).await {
                Ok(hits) => return hits,
                Err(error) => {
                    warn!(%room_id, "server-side search failed, falling back to the local index: {error}");
                }
            }
        }

        let mut filter = filter.clone();
        filter.not_senders.extend(self.ignored_senders().await);
        let pinned = if filter.pinned.is_some() {
            self.pinned_in_scope(&filter).await
        } else {
            HashSet::new()
        };

        self.search_index
            .lock()
            .await
            .search_pinned(query, &filter, pinned, order, limit, offset)
    }

    async fn pinned_in_scope(&self, filter: &SearchFilter) -> HashSet<OwnedEventId> {
        let Ok(client) = self.client().await else {
            return HashSet::new();
        };

        let in_scope: Vec<OwnedRoomId> = client
            .joined_rooms()
            .into_iter()
            .map(|room| room.room_id().to_owned())
            .filter(|room_id| {
                (filter.rooms.is_empty() || filter.rooms.contains(room_id))
                    && !filter.not_rooms.contains(room_id)
            })
            .collect();

        stream::iter(in_scope)
            .map(|room_id| async move { self.pinned_events(&room_id).await.unwrap_or_default() })
            .buffer_unordered(PINNED_FETCH_CONCURRENCY)
            .flat_map(stream::iter)
            .collect()
            .await
    }

    async fn ignored_senders(&self) -> Vec<OwnedUserId> {
        let Ok(client) = self.client().await else {
            return Vec::new();
        };

        client
            .account()
            .account_data::<IgnoredUserListEventContent>()
            .await
            .ok()
            .flatten()
            .and_then(|raw| raw.deserialize().ok())
            .map(|content| content.ignored_users.into_keys().collect())
            .unwrap_or_default()
    }

    pub(crate) async fn restore_persisted_index(self: &Arc<Self>, client: &matrix_sdk::Client) {
        for room in client.joined_rooms() {
            let room_id = room.room_id().to_owned();

            match persist::load(client, &room_id).await {
                persist::Loaded::Restored(documents, classified, edits) => {
                    self.search_index
                        .lock()
                        .await
                        .restore_room(&room_id, documents, classified, edits)
                        .await;
                }
                persist::Loaded::Unreadable => {
                    self.search_index.lock().await.mark_unreadable(&room_id);
                }
                persist::Loaded::Discarded => {
                    self.search_crawl.lock().await.discard(room_id);
                }
                persist::Loaded::Absent => {}
            }
        }

        self.search_index.lock().await.finish_restore();
    }

    pub(crate) fn watch_search_persist(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let core = self.clone();
        let client = client.clone();

        self.track_session_task(
            spawn(async move {
                loop {
                    matrix_sdk::sleep::sleep(PERSIST_INTERVAL).await;
                    core.flush_due_search_index(&client).await;
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn flush_search_index(&self, client: &matrix_sdk::Client) {
        let dirty = self.search_index.lock().await.dirty_rooms();
        self.save_rooms(client, dirty).await;
    }

    async fn flush_due_search_index(&self, client: &matrix_sdk::Client) {
        let due = self.search_index.lock().await.rooms_due_to_flush();
        self.save_rooms(client, due).await;
    }

    async fn save_rooms(&self, client: &matrix_sdk::Client, rooms: Vec<OwnedRoomId>) {
        for room_id in rooms {
            let Some(stored) = self.search_index.lock().await.take_snapshot(&room_id) else {
                continue;
            };

            if !persist::save(client, &room_id, &stored).await {
                self.search_index.lock().await.mark_dirty(&room_id);
            }
        }
    }

    pub(crate) async fn prime_persisted_rooms(self: &Arc<Self>, client: &matrix_sdk::Client) {
        for room in client.joined_rooms() {
            let room_id = room.room_id().to_owned();

            let Ok((cache, _drop_handles)) = client.event_cache().room(&room_id).await else {
                continue;
            };
            let Ok(events) = cache.events().await else {
                continue;
            };

            let rules = room.clone_info().room_version_rules_or_default().redaction;
            self.search_index
                .lock()
                .await
                .ingest(&room_id, events, &cache, &rules)
                .await;
        }
    }

    pub(crate) fn watch_ignored_users(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let core = self.clone();
        let client = client.clone();
        let mut changes = client.subscribe_to_ignore_user_list_changes();

        self.track_session_task(
            spawn(async move {
                while changes.next().await.is_some() {
                    *core.search_index.lock().await = MessageIndex::new();
                    core.search_crawl.lock().await.reset();
                    core.server_search.lock().await.reset();

                    if !persist::forget_crawl(&client).await {
                        let _ = persist::forget_crawl(&client).await;
                    }
                    for room in client.joined_rooms() {
                        let room_id = room.room_id().to_owned();
                        if !persist::forget(&client, &room_id).await {
                            let _ = persist::forget(&client, &room_id).await;
                        }
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) fn watch_search_index(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let core = self.clone();
        let client = client.clone();

        self.track_session_task(
            spawn(async move {
                let mut updates = client.event_cache().subscribe_to_room_generic_updates();

                core.restore_persisted_index(&client).await;
                core.prime_persisted_rooms(&client).await;

                core.watch_search_crawl(&client);
                core.watch_search_persist(&client);

                let mut subscribed: HashMap<OwnedRoomId, crate::Task> = HashMap::new();

                loop {
                    let room_id = match updates.recv().await {
                        Ok(update) => update.room_id,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                            warn!(
                                missed,
                                "missed room updates, resweeping for unwatched rooms"
                            );
                            for room in client.joined_rooms() {
                                if let Entry::Vacant(entry) =
                                    subscribed.entry(room.room_id().to_owned())
                                {
                                    entry.insert(core.watch_room_search_index(&client, room));
                                }
                            }
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };

                    let Some(room) = client
                        .get_room(&room_id)
                        .filter(|room| room.state() == RoomState::Joined)
                    else {
                        subscribed.remove(&room_id);
                        core.search_index.lock().await.forget_room(&room_id);
                        core.search_crawl.lock().await.forget(&room_id);
                        let _ = persist::forget(&client, &room_id).await;
                        continue;
                    };

                    if let Entry::Vacant(entry) = subscribed.entry(room_id) {
                        entry.insert(core.watch_room_search_index(&client, room));
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    fn watch_room_search_index(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        room: matrix_sdk::Room,
    ) -> crate::Task {
        let core = self.clone();
        let client = client.clone();

        spawn(async move {
            let room_id = room.room_id().to_owned();
            let Ok((cache, _drop_handles)) = client.event_cache().room(&room_id).await else {
                return;
            };
            let Ok((initial, mut updates)) = cache.subscribe().await else {
                return;
            };
            let rules = room.clone_info().room_version_rules_or_default().redaction;

            core.search_index
                .lock()
                .await
                .ingest(&room_id, initial, &cache, &rules)
                .await;

            loop {
                let events = match updates.recv().await {
                    Ok(RoomEventCacheUpdate::UpdateTimelineEvents(timeline)) => {
                        ingestable_events(timeline.diffs)
                    }
                    Ok(_) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                        warn!(
                            %room_id,
                            missed,
                            "the search index missed room updates, rebuilding from the cache"
                        );
                        match cache.events().await {
                            Ok(events) => events,
                            Err(error) => {
                                warn!(%room_id, "could not reread the event cache: {error}");
                                continue;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };

                let events = core
                    .search_index
                    .lock()
                    .await
                    .unclassified(&room_id, events);

                if events.is_empty() || core.search_crawl.lock().await.is_ingesting(&room_id) {
                    continue;
                }

                core.search_index
                    .lock()
                    .await
                    .ingest(&room_id, events, &cache, &rules)
                    .await;
            }
        })
        .abort_on_drop()
    }
}

#[cfg(test)]
#[allow(clippy::large_futures)]
mod tests {
    use matrix_sdk::ruma::room_version_rules::RedactionRules;
    use matrix_sdk::ruma::{
        EventId, event_id, events::room::message::RoomMessageEventContentWithoutRelation, room_id,
        user_id,
    };
    use matrix_sdk::test_utils::mocks::{MatrixMockServer, RoomMessagesResponseTemplate};
    use matrix_sdk_test::{JoinedRoomBuilder, async_test, event_factory::EventFactory};
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Duration;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    use super::MessageIndex;

    pub(super) fn in_room(
        index: &MessageIndex,
        room_id: &matrix_sdk::ruma::OwnedRoomId,
        query: &str,
        limit: usize,
        offset: usize,
    ) -> Vec<super::Hit> {
        index.search(
            query,
            &super::SearchFilter {
                rooms: vec![room_id.clone()],
                ..super::SearchFilter::default()
            },
            super::SearchOrder::Rank,
            limit,
            offset,
        )
    }

    async fn reingest_whole_room(
        index: &mut MessageIndex,
        cache: &matrix_sdk::event_cache::RoomEventCache,
        room_id: &matrix_sdk::ruma::OwnedRoomId,
    ) {
        let events = cache.events().await.expect("cached events");
        index
            .ingest(room_id, events, cache, &RedactionRules::V11)
            .await;
    }

    fn document(
        seed: &str,
        body: &str,
        sender: &str,
        ts: u64,
        attachment: Option<super::SearchAttachment>,
        mentions: Vec<matrix_sdk::ruma::OwnedUserId>,
    ) -> super::Document {
        super::Document {
            event_id: EventId::parse(format!("${seed}")).expect("event id"),
            has_link: super::contains_link(body),
            body: body.to_owned(),
            folded: String::new(),
            sender: matrix_sdk::ruma::UserId::parse(sender).expect("user id"),
            origin_server_ts: ts,
            attachments: attachment.into_iter().collect(),
            mentions,
            in_thread: false,
            edited_at: None,
        }
    }

    fn filtered_index() -> (MessageIndex, matrix_sdk::ruma::OwnedRoomId) {
        let room = matrix_sdk::ruma::RoomId::parse("!filters:localhost").expect("room id");
        let mut index = MessageIndex::new();
        let room_index = index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new);

        room_index.upsert(document(
            "erwan",
            "the deploy pipeline is broken",
            "@erwan:localhost",
            1_000,
            None,
            Vec::new(),
        ));
        room_index.upsert(document(
            "alice",
            "deploy finished, see https://example.org/build",
            "@alice:localhost",
            2_000,
            None,
            vec![matrix_sdk::ruma::user_id!("@erwan:localhost").to_owned()],
        ));
        room_index.upsert(document(
            "screenshot",
            "deploy screenshot.png",
            "@alice:localhost",
            3_000,
            Some(super::SearchAttachment::Image),
            Vec::new(),
        ));

        (index, room)
    }

    fn found(index: &MessageIndex, query: &str, filter: &super::SearchFilter) -> Vec<String> {
        index
            .search(query, filter, super::SearchOrder::Rank, 20, 0)
            .into_iter()
            .map(|hit| hit.event_id.to_string())
            .collect()
    }

    #[test]
    fn test_from_narrows_to_one_sender() {
        let (index, _room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::SearchFilter {
                senders: vec![matrix_sdk::ruma::user_id!("@alice:localhost").to_owned()],
                ..super::SearchFilter::default()
            },
        );

        assert_eq!(hits.len(), 2);
        assert!(!hits.contains(&"$erwan".to_owned()));
    }

    #[test]
    fn test_mentions_matches_only_messages_pinging_the_user() {
        let (index, _room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::SearchFilter {
                mentions: vec![matrix_sdk::ruma::user_id!("@erwan:localhost").to_owned()],
                ..super::SearchFilter::default()
            },
        );

        assert_eq!(hits, vec!["$alice"]);
    }

    #[test]
    fn test_has_image_and_has_link_select_by_content() {
        let (index, _room) = filtered_index();

        assert_eq!(
            found(
                &index,
                "deploy",
                &super::SearchFilter {
                    has: vec![super::SearchAttachment::Image],
                    ..super::SearchFilter::default()
                }
            ),
            vec!["$screenshot"]
        );
        assert_eq!(
            found(
                &index,
                "deploy",
                &super::SearchFilter {
                    has: vec![super::SearchAttachment::Link],
                    ..super::SearchFilter::default()
                }
            ),
            vec!["$alice"]
        );
    }

    #[test]
    fn test_date_bounds_are_inclusive_on_both_ends() {
        let (index, _room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::SearchFilter {
                after_ts: Some(2_000),
                before_ts: Some(3_000),
                ..super::SearchFilter::default()
            },
        );

        assert_eq!(hits.len(), 2);
        assert!(!hits.contains(&"$erwan".to_owned()));
    }

    #[test]
    fn test_a_quoted_phrase_must_appear_verbatim() {
        let (index, _room) = filtered_index();

        assert_eq!(
            found(
                &index,
                "deploy",
                &super::SearchFilter {
                    phrases: vec!["pipeline is broken".to_owned()],
                    ..super::SearchFilter::default()
                }
            ),
            vec!["$erwan"]
        );
    }

    #[test]
    fn test_an_excluded_term_removes_matches() {
        let (index, _room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::SearchFilter {
                exclude: vec!["screenshot".to_owned()],
                ..super::SearchFilter::default()
            },
        );

        assert!(!hits.contains(&"$screenshot".to_owned()));
    }

    #[test]
    fn test_recent_order_ignores_relevance() {
        let (index, _room) = filtered_index();

        let hits: Vec<String> = index
            .search(
                "deploy",
                &super::SearchFilter::default(),
                super::SearchOrder::Recent,
                20,
                0,
            )
            .into_iter()
            .map(|hit| hit.event_id.to_string())
            .collect();

        assert_eq!(hits, vec!["$screenshot", "$alice", "$erwan"]);
    }

    #[test]
    fn test_an_empty_query_with_filters_still_lists_messages() {
        let (index, _room) = filtered_index();

        let hits = found(
            &index,
            "",
            &super::SearchFilter {
                senders: vec![matrix_sdk::ruma::user_id!("@alice:localhost").to_owned()],
                ..super::SearchFilter::default()
            },
        );

        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn test_a_room_filter_excludes_other_rooms() {
        let (mut index, room) = filtered_index();
        let other = matrix_sdk::ruma::RoomId::parse("!other:localhost").expect("room id");
        index
            .rooms
            .entry(other)
            .or_insert_with(super::RoomIndex::new)
            .upsert(document(
                "elsewhere",
                "deploy elsewhere",
                "@erwan:localhost",
                4_000,
                None,
                Vec::new(),
            ));

        let hits = found(
            &index,
            "deploy",
            &super::SearchFilter {
                rooms: vec![room],
                ..super::SearchFilter::default()
            },
        );

        assert!(!hits.contains(&"$elsewhere".to_owned()));
        assert_eq!(hits.len(), 3);
    }

    #[test]
    fn test_a_cache_refill_costs_nothing_when_the_index_already_holds_it() {
        use super::{MessageIndex, RoomIndex};
        use matrix_sdk::deserialized_responses::TimelineEvent;

        let room_id = room_id!("!refilled:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@a:b.c"));
        let events: Vec<TimelineEvent> = ["one", "two"]
            .iter()
            .enumerate()
            .map(|(index, body)| {
                TimelineEvent::from_plaintext(
                    factory
                        .text_msg(*body)
                        .event_id(&EventId::parse(format!("$refill{index}")).expect("an event id"))
                        .into_raw_sync(),
                )
            })
            .collect();

        let mut index = MessageIndex::new();
        index
            .rooms
            .entry(room_id.clone())
            .or_insert_with(RoomIndex::new);

        assert_eq!(index.unclassified(&room_id, events.clone()).len(), 2);

        for event in &events {
            index
                .rooms
                .get_mut(&room_id)
                .expect("the room")
                .mark_classified(event.event_id().expect("an event id").to_owned());
        }

        assert!(index.unclassified(&room_id, events).is_empty());
    }

    #[async_test]
    async fn test_a_room_with_no_new_activity_is_indexed_from_its_persisted_cache() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!quiet:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("archived thought")
                        .event_id(event_id!("$archived")),
                ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-prime",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;

        let index = core.search_index.lock().await;
        assert_eq!(
            in_room(&index, &room_id, "archived", 10, 0).len(),
            1,
            "a room with no new activity must be indexed from its persisted cache"
        );
        drop(index);
        drop(room);
    }

    #[async_test]
    async fn test_back_pagination_reaches_the_index_and_notifies_it() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!backfill:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous")
                    .add_timeline_event(
                        factory
                            .text_msg("latest deploy")
                            .event_id(event_id!("$latest")),
                    ),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");

        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;
        assert!(
            in_room(&index, &room_id, "archaeology", 10, 0).is_empty(),
            "the older message is not in the cache yet"
        );

        let mut updates = client.event_cache().subscribe_to_room_generic_updates();

        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default().events(vec![
                factory
                    .text_msg("older archaeology")
                    .event_id(event_id!("$older")),
            ]))
            .mock_once()
            .mount()
            .await;

        let timeline = crate::timelines::build_room_timeline(
            &room,
            &crate::protocol::TimelineFocusView::Live,
            false,
        )
        .await
        .expect("timeline");
        timeline.paginate_backwards(10).await.expect("paginate");

        let notified = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(update) = updates.recv().await
                    && update.room_id == room_id
                {
                    return true;
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(notified, "back-pagination must wake the indexer");

        reingest_whole_room(&mut index, &cache, &room_id).await;

        let hits = in_room(&index, &room_id, "archaeology", 10, 0);
        assert_eq!(hits.len(), 1, "the backfilled message must be searchable");
        assert_eq!(hits[0].event_id, event_id!("$older"));
    }

    #[async_test]
    async fn test_an_encrypted_rooms_plaintext_is_searchable_and_edits_replace_the_body() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!search:localhost").to_owned();
        let original_id = event_id!("$original");
        let edit_id = event_id!("$edit");

        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("the deploy pipeline is broken")
                        .event_id(original_id),
                ),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;

        let hits = in_room(&index, &room_id, "deploying", 10, 0);
        assert_eq!(hits.len(), 1, "{hits:?}", hits = hits.len());
        assert_eq!(hits[0].event_id, original_id);

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("* the rollback finished")
                        .edit(
                            original_id,
                            RoomMessageEventContentWithoutRelation::text_plain(
                                "the rollback finished",
                            ),
                        )
                        .event_id(edit_id),
                ),
            )
            .await;

        reingest_whole_room(&mut index, &cache, &room_id).await;

        assert!(
            in_room(&index, &room_id, "deploying", 10, 0).is_empty(),
            "an edited message must not still match its old body"
        );

        let hits = in_room(&index, &room_id, "rollback", 10, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].event_id, original_id);
        assert_eq!(hits[0].body, "the rollback finished");

        drop(room);
    }

    #[async_test]
    async fn test_an_edit_crawled_before_its_original_keeps_the_new_body() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!crawl:localhost").to_owned();
        let original_id = event_id!("$original");
        let edit_id = event_id!("$edit");

        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");

        let crawled = vec![
            factory
                .text_msg("* the rollback finished")
                .edit(
                    original_id,
                    RoomMessageEventContentWithoutRelation::text_plain("the rollback finished"),
                )
                .event_id(edit_id)
                .into_event(),
            factory
                .text_msg("the deploy pipeline is broken")
                .event_id(original_id)
                .into_event(),
        ];

        let mut index = MessageIndex::new();
        index
            .ingest(&room_id, crawled, &cache, &RedactionRules::V11)
            .await;

        assert!(
            in_room(&index, &room_id, "deploying", 10, 0).is_empty(),
            "the pre-edit body must not win just because it was crawled last"
        );

        let hits = in_room(&index, &room_id, "rollback", 10, 0);
        assert_eq!(hits.len(), 1, "{hits:?}", hits = hits.len());
        assert_eq!(hits[0].event_id, original_id);
        assert_eq!(hits[0].body, "the rollback finished");

        drop(room);
    }

    #[async_test]
    async fn test_a_thread_reply_is_marked_and_keeps_the_mark_through_an_edit() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!threads:localhost").to_owned();
        let thread_root = event_id!("$root");
        let reply_id = event_id!("$reply");

        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));
        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");

        let events = vec![
            factory
                .text_msg("the deploy pipeline is broken")
                .event_id(thread_root)
                .into_event(),
            factory
                .text_msg("deploy retried")
                .in_thread(thread_root, thread_root)
                .event_id(reply_id)
                .into_event(),
            factory
                .text_msg("* deploy retried twice")
                .edit(
                    reply_id,
                    RoomMessageEventContentWithoutRelation::text_plain("deploy retried twice"),
                )
                .event_id(event_id!("$reply-edit"))
                .into_event(),
        ];

        let mut index = MessageIndex::new();
        index
            .ingest(&room_id, events, &cache, &RedactionRules::V11)
            .await;

        let threaded = |wanted| {
            index
                .search(
                    "deploy",
                    &super::SearchFilter {
                        in_thread: Some(wanted),
                        ..super::SearchFilter::default()
                    },
                    super::SearchOrder::Rank,
                    10,
                    0,
                )
                .into_iter()
                .map(|hit| hit.event_id.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(threaded(true), vec!["$reply"]);
        assert_eq!(threaded(false), vec!["$root"]);

        drop(room);
    }

    #[test]
    fn test_pinned_keeps_or_drops_the_pinned_events() {
        let (index, _room) = filtered_index();
        let pinned: std::collections::HashSet<_> =
            [event_id!("$alice").to_owned()].into_iter().collect();

        let search = |wanted| {
            index
                .search_pinned(
                    "deploy",
                    &super::SearchFilter {
                        pinned: Some(wanted),
                        ..super::SearchFilter::default()
                    },
                    pinned.clone(),
                    super::SearchOrder::Recent,
                    10,
                    0,
                )
                .into_iter()
                .map(|hit| hit.event_id.to_string())
                .collect::<Vec<_>>()
        };

        assert_eq!(search(true), vec!["$alice"]);
        assert_eq!(search(false), vec!["$screenshot", "$erwan"]);
    }

    #[test]
    fn test_oldest_orders_hits_by_ascending_time() {
        let (index, _room) = filtered_index();

        let hits: Vec<String> = index
            .search(
                "deploy",
                &super::SearchFilter::default(),
                super::SearchOrder::Oldest,
                10,
                0,
            )
            .into_iter()
            .map(|hit| hit.event_id.to_string())
            .collect();

        assert_eq!(hits, vec!["$erwan", "$alice", "$screenshot"]);
    }

    #[test]
    fn test_a_replys_quoted_fallback_is_not_indexed() {
        let replied = super::indexable_body(
            "> <@erwan:localhost> the deploy pipeline is broken\n\nlooking at it now",
        );
        assert_eq!(replied, "looking at it now");

        assert_eq!(
            super::indexable_body("> * <@erwan:localhost> waves\n\nhello"),
            "hello"
        );
        assert_eq!(
            super::indexable_body("> not a fallback, just a quote"),
            "> not a fallback, just a quote"
        );
    }

    #[async_test]
    async fn test_a_redaction_drops_the_message_from_the_index() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!redact:localhost").to_owned();
        let target_id = event_id!("$target");

        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_timeline_event(factory.text_msg("regrettable").event_id(target_id)),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;
        assert_eq!(in_room(&index, &room_id, "regrettable", 10, 0).len(), 1);

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .redaction(target_id)
                        .event_id(event_id!("$redaction")),
                ),
            )
            .await;

        reingest_whole_room(&mut index, &cache, &room_id).await;

        assert!(
            in_room(&index, &room_id, "regrettable", 10, 0).is_empty(),
            "a redacted message must leave no indexed body behind"
        );

        drop(room);
    }

    #[async_test]
    async fn test_pagination_walks_one_ordering_without_repeating_a_hit() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!paging:localhost").to_owned();
        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        let ids = ["$page0", "$page1", "$page2", "$page3", "$page4"];
        let mut builder = JoinedRoomBuilder::new(&room_id);
        for (position, raw_id) in ids.iter().enumerate() {
            let id = EventId::parse(*raw_id).expect("test event id");
            builder = builder.add_timeline_event(
                factory
                    .text_msg(format!("paginate this {position}"))
                    .event_id(&id),
            );
        }
        server.sync_room(&client, builder).await;

        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;

        let ids =
            |hits: Vec<super::Hit>| hits.into_iter().map(|hit| hit.event_id).collect::<Vec<_>>();

        let first = ids(in_room(&index, &room_id, "paginate", 2, 0));
        let second = ids(in_room(&index, &room_id, "paginate", 2, 2));
        let last = ids(in_room(&index, &room_id, "paginate", 2, 4));
        assert_eq!(first.len(), 2);
        assert_eq!(second.len(), 2);
        assert_eq!(last.len(), 1, "five matches paged two at a time");

        let mut walked: Vec<_> = first.iter().chain(&second).chain(&last).cloned().collect();
        let seen = walked.len();
        walked.sort();
        walked.dedup();
        assert_eq!(walked.len(), seen, "paging repeated a hit");

        assert_eq!(
            first,
            ids(in_room(&index, &room_id, "paginate", 2, 0)),
            "the same page must come back twice"
        );

        drop(room);
    }

    #[async_test]
    async fn test_leaving_a_room_forgets_its_documents() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!forget:localhost").to_owned();
        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_timeline_event(factory.text_msg("secret").event_id(event_id!("$secret"))),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;
        assert_eq!(in_room(&index, &room_id, "secret", 10, 0).len(), 1);

        index.forget_room(&room_id);

        assert!(in_room(&index, &room_id, "secret", 10, 0).is_empty());
        assert!(
            index
                .search(
                    "secret",
                    &super::SearchFilter::default(),
                    super::SearchOrder::Rank,
                    10,
                    0,
                )
                .is_empty()
        );

        drop(room);
    }

    #[test]
    fn test_a_denied_sender_is_dropped_by_identity() {
        let (index, room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::SearchFilter {
                rooms: vec![room],
                not_senders: vec![matrix_sdk::ruma::user_id!("@alice:localhost").to_owned()],
                ..super::SearchFilter::default()
            },
        );

        assert_eq!(hits, vec!["$erwan".to_owned()]);
    }

    #[test]
    fn test_a_denied_attachment_is_dropped_by_kind() {
        let (index, room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::SearchFilter {
                rooms: vec![room],
                not_has: vec![super::SearchAttachment::Image],
                ..super::SearchFilter::default()
            },
        );

        assert!(!hits.contains(&"$screenshot".to_owned()));
        assert!(hits.contains(&"$erwan".to_owned()));
    }

    #[test]
    fn test_a_denied_mention_is_dropped_by_identity() {
        let (index, room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::SearchFilter {
                rooms: vec![room],
                not_mentions: vec![matrix_sdk::ruma::user_id!("@erwan:localhost").to_owned()],
                ..super::SearchFilter::default()
            },
        );

        assert!(!hits.contains(&"$alice".to_owned()));
    }

    #[test]
    fn test_a_denied_room_is_skipped_even_with_no_room_filter() {
        let (mut index, room) = filtered_index();
        let other = matrix_sdk::ruma::RoomId::parse("!other:localhost").expect("room id");
        index
            .rooms
            .entry(other.clone())
            .or_insert_with(super::RoomIndex::new)
            .upsert(document(
                "elsewhere",
                "deploy elsewhere",
                "@erwan:localhost",
                4_000,
                None,
                Vec::new(),
            ));

        let hits = found(
            &index,
            "deploy",
            &super::SearchFilter {
                not_rooms: vec![other],
                ..super::SearchFilter::default()
            },
        );

        assert!(!hits.contains(&"$elsewhere".to_owned()));
        assert!(hits.contains(&"$erwan".to_owned()));
        drop(room);
    }

    fn seed(index: &mut MessageIndex, room: &matrix_sdk::ruma::OwnedRoomId, seeds: &[(&str, u64)]) {
        let room_index = index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new);

        for &(name, ts) in seeds {
            room_index.upsert(document(
                name,
                &format!("deploy note {name}"),
                "@erwan:localhost",
                ts,
                None,
                Vec::new(),
            ));
        }
    }

    #[test]
    fn test_the_budget_evicts_the_oldest_message_first() {
        let room = matrix_sdk::ruma::RoomId::parse("!budget:localhost").expect("room id");
        let mut index = MessageIndex::with_capacity(2);
        seed(
            &mut index,
            &room,
            &[("oldest", 1_000), ("middle", 2_000), ("newest", 3_000)],
        );

        index.trim_to_capacity();

        assert_eq!(index.documents(), 2, "the budget must be respected");
        let kept = found(&index, "deploy", &super::SearchFilter::default());
        assert!(
            !kept.contains(&"$oldest".to_owned()),
            "the oldest message must be the one dropped, kept: {kept:?}"
        );
        assert!(kept.contains(&"$newest".to_owned()));
    }

    #[test]
    fn test_the_budget_spans_rooms_rather_than_each_room_separately() {
        let busy = matrix_sdk::ruma::RoomId::parse("!busy:localhost").expect("room id");
        let quiet = matrix_sdk::ruma::RoomId::parse("!quiet:localhost").expect("room id");
        let mut index = MessageIndex::with_capacity(2);

        seed(&mut index, &busy, &[("recent", 9_000), ("newer", 8_000)]);
        seed(&mut index, &quiet, &[("ancient", 10)]);

        index.trim_to_capacity();

        assert_eq!(index.documents(), 2);
        assert!(
            in_room(&index, &quiet, "deploy", 10, 0).is_empty(),
            "the budget spans rooms"
        );
        assert_eq!(in_room(&index, &busy, "deploy", 10, 0).len(), 2);
    }

    #[test]
    fn test_a_full_index_reports_itself_full() {
        let room = matrix_sdk::ruma::RoomId::parse("!full:localhost").expect("room id");
        let mut index = MessageIndex::with_capacity(2);

        seed(&mut index, &room, &[("one", 1_000)]);
        assert!(!index.is_full(), "one of two is not full");

        seed(&mut index, &room, &[("two", 2_000)]);
        assert!(index.is_full());
    }

    #[async_test]
    async fn test_an_evicted_message_is_not_resurrected_by_the_next_ingest() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!churn:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_timeline_event(
                        factory
                            .text_msg("older sediment")
                            .event_id(event_id!("$older")),
                    )
                    .add_timeline_event(
                        factory
                            .text_msg("newer sediment")
                            .event_id(event_id!("$newer")),
                    ),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");

        let mut index = MessageIndex::with_capacity(1);
        reingest_whole_room(&mut index, &cache, &room_id).await;

        let kept = in_room(&index, &room_id, "sediment", 10, 0);
        assert_eq!(kept.len(), 1, "the budget holds one message");
        assert_eq!(kept[0].event_id, event_id!("$newer"));

        reingest_whole_room(&mut index, &cache, &room_id).await;

        let after = in_room(&index, &room_id, "sediment", 10, 0);
        assert_eq!(
            after.len(),
            1,
            "re-ingesting must not churn the evicted message back in"
        );
        assert_eq!(after[0].event_id, event_id!("$newer"));

        drop(room);
    }

    #[async_test]
    async fn test_the_crawl_resumes_from_the_checkpoint_it_persisted() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!resume:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous")
                    .add_timeline_event(factory.text_msg("latest").event_id(event_id!("$latest"))),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-resume",
            Box::new(crate::store::MemorySessionStore::default()),
        );

        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default()
                .end_token("page-two")
                .events(vec![
                    factory.text_msg("first page").event_id(event_id!("$one")),
                ]))
            .mock_once()
            .mount()
            .await;

        let reached_start = core
            .crawl_once(&client, &room_id)
            .await
            .expect("crawl one batch");
        assert!(
            !reached_start.reached_start,
            "a room with a next token is not exhausted"
        );

        let checkpoints = core.search_crawl.lock().await.checkpoints();
        assert_eq!(
            checkpoints
                .get(&room_id)
                .and_then(|room| room.token.clone())
                .as_deref(),
            Some("page-two"),
            "the next page's token is what a reload has to resume from"
        );

        // A fresh core, as after a reload: it must ask for the second page.
        let (next, _next_events) = crate::Core::new(
            "search-resume",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        next.search_crawl.lock().await.restore(checkpoints);

        server
            .mock_room_messages()
            .match_from("page-two")
            .ok(RoomMessagesResponseTemplate::default().events(vec![
                factory.text_msg("second page").event_id(event_id!("$two")),
            ]))
            .mock_once()
            .mount()
            .await;

        let reached_start = next
            .crawl_once(&client, &room_id)
            .await
            .expect("crawl the resumed batch");
        assert!(
            reached_start.reached_start && reached_start.exhausted,
            "no next token means the room is done"
        );

        let hits = in_room(&*next.search_index.lock().await, &room_id, "second", 10, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].event_id, event_id!("$two"));

        drop(room);
    }

    #[async_test]
    async fn test_the_crawler_deepens_a_room_and_records_reaching_its_start() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!crawl:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous")
                    .add_timeline_event(
                        factory
                            .text_msg("latest deploy")
                            .event_id(event_id!("$latest")),
                    ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-crawl",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;
        assert!(
            in_room(
                &*core.search_index.lock().await,
                &room_id,
                "archaeology",
                10,
                0
            )
            .is_empty(),
            "nothing has paged back to the older message yet"
        );

        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default().events(vec![
                factory
                    .text_msg("older archaeology")
                    .event_id(event_id!("$older")),
            ]))
            .mock_once()
            .mount()
            .await;

        let reached_start = core
            .crawl_once(&client, &room_id)
            .await
            .expect("crawl one batch");

        let hits = in_room(
            &*core.search_index.lock().await,
            &room_id,
            "archaeology",
            10,
            0,
        );
        assert_eq!(hits.len(), 1, "the crawler must index what it paginated");
        assert_eq!(hits[0].event_id, event_id!("$older"));
        assert!(reached_start.reached_start);

        drop(room);
    }

    #[async_test]
    async fn test_a_flushed_index_is_searchable_in_the_next_session() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!persisted:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("crawled archaeology")
                        .event_id(event_id!("$crawled")),
                ),
            )
            .await;

        let (first, _first_events) = crate::Core::new(
            "search-persist-first",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        first.prime_persisted_rooms(&client).await;
        assert_eq!(
            in_room(
                &*first.search_index.lock().await,
                &room_id,
                "archaeology",
                10,
                0
            )
            .len(),
            1
        );
        first.flush_search_index(&client).await;

        let (second, _second_events) = crate::Core::new(
            "search-persist-second",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        second.restore_persisted_index(&client).await;

        let hits = in_room(
            &*second.search_index.lock().await,
            &room_id,
            "archaeology",
            10,
            0,
        );
        assert_eq!(
            hits.len(),
            1,
            "a restored session must find what was crawled"
        );
        assert_eq!(hits[0].event_id, event_id!("$crawled"));

        drop(room);
    }

    #[test]
    fn test_a_lightly_edited_room_waits_before_its_snapshot_is_rewritten() {
        let room = matrix_sdk::ruma::RoomId::parse("!throttle:localhost").expect("room id");
        let mut index = MessageIndex::new();
        index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new)
            .upsert(document(
                "one",
                "a single word",
                "@erwan:localhost",
                1,
                None,
                Vec::new(),
            ));

        assert_eq!(index.dirty_rooms(), vec![room.clone()]);

        for tick in 1..super::TICKS_BEFORE_FLUSH {
            assert!(
                index.rooms_due_to_flush().is_empty(),
                "one change must not rewrite the whole room on tick {tick}"
            );
        }
        assert_eq!(
            index.rooms_due_to_flush(),
            vec![room.clone()],
            "a lightly edited room must still be persisted eventually"
        );

        index.take_snapshot(&room);
        assert!(index.rooms_due_to_flush().is_empty());
    }

    #[test]
    fn test_a_busy_room_is_persisted_without_waiting_out_the_ticks() {
        let room = matrix_sdk::ruma::RoomId::parse("!busy:localhost").expect("room id");
        let mut index = MessageIndex::new();
        let room_index = index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new);

        for seed in 0..super::CHANGES_BEFORE_FLUSH {
            room_index.upsert(document(
                &format!("busy{seed}"),
                &format!("message number {seed}"),
                "@erwan:localhost",
                seed as u64,
                None,
                Vec::new(),
            ));
        }

        assert_eq!(
            index.rooms_due_to_flush(),
            vec![room],
            "a room past the change threshold must not wait for the tick deadline"
        );
    }

    #[async_test]
    async fn test_a_restored_room_does_not_charge_the_crawl_budget_again() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!budget:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("crawled archaeology")
                        .event_id(event_id!("$crawled")),
                ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-budget",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;
        core.flush_search_index(&client).await;

        let (cache, _drop_handles) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        let events = cache.events().await.expect("cached events");
        let rules = room.clone_info().room_version_rules_or_default().redaction;

        let virgin = MessageIndex::new()
            .ingest(&room_id, events.clone(), &cache, &rules)
            .await;
        assert!(virgin > 0, "an unseen batch must cost the budget something");

        let (restored, _restored_events) = crate::Core::new(
            "search-budget-restored",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        restored.restore_persisted_index(&client).await;

        let fresh = restored
            .search_index
            .lock()
            .await
            .ingest(&room_id, events, &cache, &rules)
            .await;
        assert_eq!(
            fresh, 0,
            "re-reading persisted events must not spend the crawl budget"
        );

        drop(room);
    }

    #[async_test]
    async fn test_a_failed_room_reports_partial_not_complete() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!failed:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    EventFactory::new()
                        .room(&room_id)
                        .sender(user_id!("@erwan:localhost"))
                        .text_msg("latest deploy")
                        .event_id(event_id!("$latest")),
                ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-coverage-partial",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;
        core.search_crawl.lock().await.fail(room_id);

        let coverage = core.search_coverage(&client).await;
        assert_eq!(
            coverage.state,
            crate::protocol::SearchCoverageState::Partial,
            "a room whose pagination errored must not be reported as fully indexed"
        );
        assert_eq!(coverage.rooms_failed, 1);
        assert_eq!(coverage.rooms_pending, 0);

        drop(room);
    }

    #[async_test]
    async fn test_a_room_walked_to_its_start_reports_complete() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!walked:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous")
                    .add_timeline_event(
                        factory
                            .text_msg("latest deploy")
                            .event_id(event_id!("$latest")),
                    ),
            )
            .await;

        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default().events(vec![
                factory
                    .text_msg("older archaeology")
                    .event_id(event_id!("$older")),
            ]))
            .mount()
            .await;

        let (core, _events) = crate::Core::new(
            "search-coverage-complete",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;

        let reached_start = core
            .crawl_once(&client, &room_id)
            .await
            .expect("crawl one batch");
        assert!(reached_start.reached_start);
        core.search_crawl.lock().await.settle(room_id, true);

        let coverage = core.search_coverage(&client).await;
        assert_eq!(
            coverage.state,
            crate::protocol::SearchCoverageState::Complete
        );
        assert_eq!(coverage.rooms_failed, 0);
        assert_eq!(coverage.rooms_pending, 0);
        assert_eq!(coverage.documents, 2);

        drop(room);
    }

    #[async_test]
    async fn test_a_spent_budget_reports_stopped_even_with_rooms_left() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!stopped:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous")
                    .add_timeline_event(
                        EventFactory::new()
                            .room(&room_id)
                            .sender(user_id!("@erwan:localhost"))
                            .text_msg("latest deploy")
                            .event_id(event_id!("$latest")),
                    ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-coverage-stopped",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;
        assert_eq!(
            core.search_coverage(&client).await.state,
            crate::protocol::SearchCoverageState::Indexing
        );

        core.search_crawl.lock().await.exhaust_budget_for_test();

        let coverage = core.search_coverage(&client).await;
        assert_eq!(
            coverage.state,
            crate::protocol::SearchCoverageState::Stopped,
            "a spent budget outranks the rooms still queued"
        );
        assert_eq!(coverage.rooms_pending, 1);

        drop(room);
    }

    #[async_test]
    async fn test_the_crawl_serves_every_room_before_deepening_one() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let busy = room_id!("!busy:localhost").to_owned();
        let quiet = room_id!("!quiet:localhost").to_owned();

        server.mock_room_state_encryption().plain().mount().await;
        let busy_room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&busy)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("busy-previous")
                    .add_timeline_event(
                        EventFactory::new()
                            .room(&busy)
                            .sender(user_id!("@erwan:localhost"))
                            .text_msg("newest deploy")
                            .event_id(event_id!("$busy"))
                            .server_ts(9_000),
                    ),
            )
            .await;
        let quiet_room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&quiet)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("quiet-previous")
                    .add_timeline_event(
                        EventFactory::new()
                            .room(&quiet)
                            .sender(user_id!("@erwan:localhost"))
                            .text_msg("ancient deploy")
                            .event_id(event_id!("$quiet"))
                            .server_ts(1_000),
                    ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-crawl-fairness",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.prime_persisted_rooms(&client).await;

        assert_eq!(
            core.next_room_to_crawl(&client).await.as_ref(),
            Some(&busy),
            "the first turn goes to the room with the newest message"
        );

        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default().events(vec![
                EventFactory::new()
                    .room(&busy)
                    .sender(user_id!("@erwan:localhost"))
                    .text_msg("older busy archaeology")
                    .event_id(event_id!("$busy_older")),
            ]))
            .mount()
            .await;
        core.crawl_once(&client, &busy).await.expect("crawl busy");

        assert_eq!(
            core.next_room_to_crawl(&client).await.as_ref(),
            Some(&quiet),
            "the quiet room must get a turn before the busy one is deepened again"
        );

        drop(busy_room);
        drop(quiet_room);
    }

    async fn logged_in(
        server: &MatrixMockServer,
        client: &matrix_sdk::Client,
        account_id: &str,
    ) -> Arc<crate::Core> {
        let sync_service = Arc::new(
            matrix_sdk_ui::sync_service::SyncService::builder(client.clone())
                .build()
                .await
                .expect("sync service"),
        );
        let (core, _events) = crate::Core::new(
            account_id,
            Box::new(crate::store::MemorySessionStore::default()),
        );
        *core.session.write().await = Some(crate::session::Session {
            account_id: account_id.to_owned(),
            client: client.clone(),
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
        });
        core
    }

    fn one_server_hit(room_id: &matrix_sdk::ruma::OwnedRoomId) -> serde_json::Value {
        json!({
            "search_categories": {
                "room_events": {
                    "count": 1,
                    "highlights": [],
                    "results": [{
                        "rank": 0.9,
                        "result": {
                            "type": "m.room.message",
                            "event_id": "$older-than-the-crawl",
                            "room_id": room_id,
                            "sender": "@erwan:localhost",
                            "origin_server_ts": 1_000,
                            "content": { "msgtype": "m.text", "body": "deploy notes from years ago" }
                        }
                    }]
                }
            }
        })
    }

    fn scoped_to(room_id: &matrix_sdk::ruma::OwnedRoomId) -> super::SearchFilter {
        super::SearchFilter {
            rooms: vec![room_id.clone()],
            ..super::SearchFilter::default()
        }
    }

    #[async_test]
    async fn test_an_unencrypted_room_is_searched_on_the_homeserver() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!plain:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(&client, JoinedRoomBuilder::new(&room_id))
            .await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(one_server_hit(&room_id)))
            .expect(1)
            .mount(server.server())
            .await;

        let core = logged_in(&server, &client, "search-server-plain").await;
        let hits = core
            .search_messages(
                "deploy",
                &scoped_to(&room_id),
                super::SearchOrder::Rank,
                10,
                0,
            )
            .await;

        assert_eq!(
            hits.len(),
            1,
            "the local index never crawled this room, so a hit can only be the server's"
        );
        assert_eq!(hits[0].event_id, event_id!("$older-than-the-crawl"));
        assert_eq!(hits[0].body, "deploy notes from years ago");

        drop(room);
    }

    #[async_test]
    async fn test_an_encrypted_room_is_never_searched_on_the_homeserver() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!secret:localhost").to_owned();
        let sender = user_id!("@erwan:localhost");
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_state_event(
                        EventFactory::new()
                            .room(&room_id)
                            .sender(sender)
                            .room_encryption(),
                    )
                    .add_timeline_event(
                        EventFactory::new()
                            .room(&room_id)
                            .sender(sender)
                            .text_msg("deploy notes we keep to ourselves")
                            .event_id(event_id!("$local")),
                    ),
            )
            .await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(one_server_hit(&room_id)))
            .expect(0)
            .mount(server.server())
            .await;

        let core = logged_in(&server, &client, "search-server-encrypted").await;
        let (cache, _drop_handles) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

        let hits = core
            .search_messages(
                "deploy",
                &scoped_to(&room_id),
                super::SearchOrder::Rank,
                10,
                0,
            )
            .await;

        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0].event_id,
            event_id!("$local"),
            "an encrypted room is answered from the local index alone"
        );

        drop(room);
    }

    #[async_test]
    async fn test_room_attachments_sort_the_index_into_media_files_and_links() {
        use matrix_sdk::ruma::events::room::message::{
            FileMessageEventContent, MessageType, RoomMessageEventContent,
        };

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!attachments:localhost").to_owned();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_timeline_event(
                        factory
                            .image(
                                "beach.png".to_owned(),
                                matrix_sdk::ruma::owned_mxc_uri!("mxc://localhost/beach"),
                            )
                            .event_id(event_id!("$image")),
                    )
                    .add_timeline_event(
                        factory
                            .event(RoomMessageEventContent::new(MessageType::File(
                                FileMessageEventContent::plain(
                                    "notes.pdf".to_owned(),
                                    matrix_sdk::ruma::owned_mxc_uri!("mxc://localhost/notes"),
                                ),
                            )))
                            .event_id(event_id!("$file")),
                    )
                    .add_timeline_event(
                        factory
                            .text_msg(
                                "tickets at https://example.org/tickets and javascript://%0Aalert(1)",
                            )
                            .event_id(event_id!("$link")),
                    )
                    .add_timeline_event(
                        factory
                            .text_msg("nothing to see")
                            .event_id(event_id!("$plain")),
                    ),
            )
            .await;

        let core = logged_in(&server, &client, "room-attachments").await;
        let (cache, _drop_handles) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

        let (media, exhausted) = core
            .room_attachments(&room_id, crate::protocol::RoomAttachmentKind::Media, 10, 0)
            .await
            .expect("media");
        assert!(exhausted);
        assert!(matches!(
            media.as_slice(),
            [crate::protocol::RoomAttachmentView {
                content: crate::protocol::RoomAttachmentContentView::Image { filename, source, .. },
                ..
            }] if filename == "beach.png" && source == "mxc://localhost/beach"
        ));

        let (files, _) = core
            .room_attachments(&room_id, crate::protocol::RoomAttachmentKind::File, 10, 0)
            .await
            .expect("files");
        assert!(matches!(
            files.as_slice(),
            [crate::protocol::RoomAttachmentView {
                content: crate::protocol::RoomAttachmentContentView::File { filename, .. },
                ..
            }] if filename == "notes.pdf"
        ));

        let (links, _) = core
            .room_attachments(&room_id, crate::protocol::RoomAttachmentKind::Link, 10, 0)
            .await
            .expect("links");
        assert!(matches!(
            links.as_slice(),
            [crate::protocol::RoomAttachmentView {
                content: crate::protocol::RoomAttachmentContentView::Link { urls, .. },
                ..
            }] if urls == &["https://example.org/tickets".to_owned()]
        ));

        drop(room);
    }

    #[async_test]
    async fn test_room_attachments_list_each_gallery_item_under_its_tab() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!gallery-attachments:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    serde_json::from_value::<
                        matrix_sdk::ruma::serde::Raw<
                            matrix_sdk::ruma::events::AnySyncTimelineEvent,
                        >,
                    >(serde_json::json!({
                        "type": "m.room.message",
                        "event_id": "$gallery",
                        "sender": "@erwan:localhost",
                        "origin_server_ts": 1,
                        "content": {
                            "msgtype": "dm.filament.gallery",
                            "body": "",
                            "itemtypes": [
                                {
                                    "itemtype": "m.image",
                                    "body": "beach.png",
                                    "url": "mxc://localhost/beach",
                                    "page.codeberg.everypizza.msc4193.spoiler": true
                                },
                                {
                                    "itemtype": "m.file",
                                    "body": "notes.pdf",
                                    "url": "mxc://localhost/notes",
                                    "info": { "mimetype": "application/pdf", "size": 4096 }
                                },
                                {
                                    "itemtype": "m.video",
                                    "body": "wave.mp4",
                                    "url": "mxc://localhost/wave"
                                }
                            ]
                        }
                    }))
                    .expect("gallery event"),
                ),
            )
            .await;

        let core = logged_in(&server, &client, "gallery-attachments").await;
        let (cache, _drop_handles) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

        let (media, _) = core
            .room_attachments(&room_id, crate::protocol::RoomAttachmentKind::Media, 10, 0)
            .await
            .expect("media");
        let media = serde_json::to_value(&media).expect("media json");
        assert_eq!(media.as_array().map(Vec::len), Some(2));
        assert_eq!(media[0]["event_id"], "$gallery");
        assert_eq!(media[0]["gallery_index"], 0);
        assert_eq!(media[0]["content"]["spoiler"], "");
        assert_eq!(media[1]["gallery_index"], 2);
        assert_eq!(media[1]["content"]["kind"], "video");

        let (files, _) = core
            .room_attachments(&room_id, crate::protocol::RoomAttachmentKind::File, 10, 0)
            .await
            .expect("files");
        let files = serde_json::to_value(&files).expect("files json");
        assert_eq!(files.as_array().map(Vec::len), Some(1));
        assert_eq!(files[0]["gallery_index"], 1);
        assert_eq!(files[0]["content"]["filename"], "notes.pdf");
        assert_eq!(files[0]["content"]["size"], 4096);

        drop(room);
    }

    #[async_test]
    async fn test_a_homeserver_that_cannot_search_falls_back_to_the_local_index() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!plain:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    EventFactory::new()
                        .room(&room_id)
                        .sender(user_id!("@erwan:localhost"))
                        .text_msg("deploy notes the crawl did reach")
                        .event_id(event_id!("$local")),
                ),
            )
            .await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/search"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "errcode": "M_UNRECOGNIZED",
                "error": "Unrecognized request"
            })))
            .mount(server.server())
            .await;

        let core = logged_in(&server, &client, "search-server-missing").await;
        let (cache, _drop_handles) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

        let hits = core
            .search_messages(
                "deploy",
                &scoped_to(&room_id),
                super::SearchOrder::Rank,
                10,
                0,
            )
            .await;

        assert_eq!(
            hits.len(),
            1,
            "a server without /search must degrade to the local index, not fail the search"
        );
        assert_eq!(hits[0].event_id, event_id!("$local"));

        drop(room);
    }

    #[async_test]
    async fn test_a_dated_query_stays_local_even_for_an_unencrypted_room() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!plain:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    EventFactory::new()
                        .room(&room_id)
                        .sender(user_id!("@erwan:localhost"))
                        .text_msg("deploy notes the crawl did reach")
                        .server_ts(5_000)
                        .event_id(event_id!("$local")),
                ),
            )
            .await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(one_server_hit(&room_id)))
            .expect(0)
            .mount(server.server())
            .await;

        let core = logged_in(&server, &client, "search-server-dated").await;
        let (cache, _drop_handles) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

        let filter = super::SearchFilter {
            after_ts: Some(1_000),
            ..scoped_to(&room_id)
        };
        let hits = core
            .search_messages("deploy", &filter, super::SearchOrder::Rank, 10, 0)
            .await;

        assert_eq!(
            hits.len(),
            1,
            "`/search` cannot carry a date bound, so the query stays where it can be answered"
        );
        assert_eq!(hits[0].event_id, event_id!("$local"));

        drop(room);
    }

    #[async_test]
    async fn test_a_filter_only_query_stays_local_even_for_an_unencrypted_room() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!plain:localhost").to_owned();
        let sender = user_id!("@erwan:localhost");
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    EventFactory::new()
                        .room(&room_id)
                        .sender(sender)
                        .text_msg("deploy notes the crawl did reach")
                        .event_id(event_id!("$local")),
                ),
            )
            .await;

        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(one_server_hit(&room_id)))
            .expect(0)
            .mount(server.server())
            .await;

        let core = logged_in(&server, &client, "search-server-filter-only").await;
        let (cache, _drop_handles) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

        let filter = super::SearchFilter {
            senders: vec![sender.to_owned()],
            ..scoped_to(&room_id)
        };
        let hits = core
            .search_messages("", &filter, super::SearchOrder::Recent, 10, 0)
            .await;

        assert_eq!(hits.len(), 1, "`/search` needs a term to match anything");
        assert_eq!(hits[0].event_id, event_id!("$local"));

        drop(room);
    }

    #[test]
    fn test_an_unreadable_room_is_never_flushed_over_its_blob() {
        let room = matrix_sdk::ruma::RoomId::parse("!unreadable:localhost").expect("room id");
        let mut index = MessageIndex::new();
        index.mark_unreadable(&room);
        let room_index = index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new);
        for seed in 0..super::CHANGES_BEFORE_FLUSH {
            room_index.upsert(document(
                &format!("shallow{seed}"),
                &format!("shallow crawl {seed}"),
                "@erwan:localhost",
                seed as u64,
                None,
                Vec::new(),
            ));
        }

        assert!(index.dirty_rooms().is_empty());
        for _ in 0..super::TICKS_BEFORE_FLUSH {
            assert!(
                index.rooms_due_to_flush().is_empty(),
                "a room whose blob could not be read must not be overwritten"
            );
        }
    }

    #[async_test]
    async fn test_a_restored_room_waits_out_the_ticks_before_it_is_rewritten() {
        let room = matrix_sdk::ruma::RoomId::parse("!restored:localhost").expect("room id");
        let documents = (0..super::CHANGES_BEFORE_FLUSH)
            .map(|seed| {
                document(
                    &format!("kept{seed}"),
                    &format!("kept message {seed}"),
                    "@erwan:localhost",
                    seed as u64,
                    None,
                    Vec::new(),
                )
            })
            .collect();

        let mut index = MessageIndex::new();
        index
            .restore_room(&room, documents, Vec::new(), Vec::new())
            .await;
        index
            .rooms
            .get_mut(&room)
            .expect("the restored room")
            .upsert(document(
                "fresh",
                "one new message",
                "@erwan:localhost",
                99,
                None,
                Vec::new(),
            ));

        assert!(
            index.rooms_due_to_flush().is_empty(),
            "one change after a restore must not rewrite the whole room"
        );
    }

    #[async_test]
    async fn test_ignored_senders_are_read_from_the_store() {
        use matrix_sdk::ruma::events::GlobalAccountDataEventType;
        use matrix_sdk::ruma::serde::Raw;

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let mut changes = matrix_sdk::StateChanges::default();
        changes.account_data.insert(
            GlobalAccountDataEventType::IgnoredUserList,
            Raw::from_json(
                serde_json::value::to_raw_value(&json!({
                    "type": "m.ignored_user_list",
                    "content": { "ignored_users": { "@troll:localhost": {} } }
                }))
                .expect("raw account data"),
            ),
        );
        client
            .state_store()
            .save_changes(&changes)
            .await
            .expect("saved account data");

        let core = logged_in(&server, &client, "search-ignored-store").await;

        assert!(
            client
                .subscribe_to_ignore_user_list_changes()
                .get()
                .is_empty()
        );
        assert_eq!(
            core.ignored_senders().await,
            vec![user_id!("@troll:localhost").to_owned()],
            "a restored session has an ignore list before any sync changes it"
        );
    }

    async fn empty_cache(
        server: &MatrixMockServer,
        client: &matrix_sdk::Client,
        room_id: &matrix_sdk::ruma::OwnedRoomId,
    ) -> (
        matrix_sdk::Room,
        matrix_sdk::event_cache::RoomEventCache,
        Arc<matrix_sdk::event_cache::EventCacheDropHandles>,
    ) {
        let room = server.sync_joined_room(client, room_id).await;
        let (cache, drop_handles) = client
            .event_cache()
            .room(room_id)
            .await
            .expect("room event cache");
        (room, cache, drop_handles)
    }

    #[async_test]
    async fn test_an_edit_keeps_the_originals_time_and_takes_its_new_mentions() {
        use matrix_sdk::ruma::events::Mentions;

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!edited:localhost").to_owned();
        let original_id = event_id!("$original");
        let alice = user_id!("@alice:localhost");
        let (room, cache, _drop) = empty_cache(&server, &client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        let events = vec![
            factory
                .text_msg("deploy starts at noon")
                .event_id(original_id)
                .server_ts(1_000)
                .into_event(),
            factory
                .text_msg("* deploy starts at one")
                .edit(
                    original_id,
                    RoomMessageEventContentWithoutRelation::text_plain("deploy starts at one")
                        .add_mentions(Mentions::with_user_ids([alice.to_owned()])),
                )
                .event_id(event_id!("$edit"))
                .server_ts(9_000)
                .into_event(),
        ];

        let mut index = MessageIndex::new();
        index
            .ingest(&room_id, events, &cache, &RedactionRules::V11)
            .await;

        let hits = index.search(
            "deploy",
            &super::SearchFilter {
                mentions: vec![alice.to_owned()],
                ..super::SearchFilter::default()
            },
            super::SearchOrder::Rank,
            10,
            0,
        );
        assert_eq!(
            hits.len(),
            1,
            "the edit's m.new_content carries the mention"
        );
        assert_eq!(hits[0].event_id, original_id);
        assert_eq!(
            hits[0].origin_server_ts, 1_000,
            "an edit does not move the message in time"
        );
        assert_eq!(hits[0].body, "deploy starts at one");

        drop(room);
    }

    #[async_test]
    async fn test_an_edit_crawled_a_batch_before_its_original_is_fixed_up_when_it_lands() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!split:localhost").to_owned();
        let original_id = event_id!("$original");
        let (room, cache, _drop) = empty_cache(&server, &client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        let mut index = MessageIndex::new();
        index
            .ingest(
                &room_id,
                vec![
                    factory
                        .text_msg("* the rollback finished")
                        .edit(
                            original_id,
                            RoomMessageEventContentWithoutRelation::text_plain(
                                "the rollback finished",
                            ),
                        )
                        .event_id(event_id!("$edit"))
                        .server_ts(9_000)
                        .into_event(),
                ],
                &cache,
                &RedactionRules::V11,
            )
            .await;
        index
            .ingest(
                &room_id,
                vec![
                    factory
                        .text_msg("the deploy pipeline is broken")
                        .event_id(original_id)
                        .server_ts(1_000)
                        .into_event(),
                ],
                &cache,
                &RedactionRules::V11,
            )
            .await;

        assert!(in_room(&index, &room_id, "deploying", 10, 0).is_empty());
        let hits = in_room(&index, &room_id, "rollback", 10, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].event_id, original_id);
        assert_eq!(hits[0].origin_server_ts, 1_000);

        drop(room);
    }

    #[async_test]
    async fn test_an_edit_from_someone_else_is_ignored() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!forged:localhost").to_owned();
        let original_id = event_id!("$original");
        let erwan = user_id!("@erwan:localhost");
        let (room, cache, _drop) = empty_cache(&server, &client, &room_id).await;
        let factory = EventFactory::new().room(&room_id);

        let original = || {
            factory
                .text_msg("the deploy is green")
                .sender(erwan)
                .event_id(original_id)
                .server_ts(1_000)
                .into_event()
        };
        let forged = || {
            factory
                .text_msg("* the deploy is red")
                .sender(user_id!("@mallory:localhost"))
                .edit(
                    original_id,
                    RoomMessageEventContentWithoutRelation::text_plain("the deploy is red"),
                )
                .event_id(event_id!("$forged"))
                .server_ts(2_000)
                .into_event()
        };

        let mut together = MessageIndex::new();
        together
            .ingest(
                &room_id,
                vec![original(), forged()],
                &cache,
                &RedactionRules::V11,
            )
            .await;

        let mut forged_first = MessageIndex::new();
        forged_first
            .ingest(&room_id, vec![forged()], &cache, &RedactionRules::V11)
            .await;
        forged_first
            .ingest(&room_id, vec![original()], &cache, &RedactionRules::V11)
            .await;

        for index in [&together, &forged_first] {
            assert!(in_room(index, &room_id, "red", 10, 0).is_empty());
            let hits = in_room(index, &room_id, "green", 10, 0);
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].sender, erwan);
        }

        drop(room);
    }

    #[async_test]
    async fn test_redacting_an_edit_brings_the_previous_body_back() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!unedited:localhost").to_owned();
        let original_id = event_id!("$original");
        let edit_id = event_id!("$edit");
        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_timeline_event(
                        factory
                            .text_msg("the deploy pipeline is broken")
                            .event_id(original_id),
                    )
                    .add_timeline_event(
                        factory
                            .text_msg("* the rollback finished")
                            .edit(
                                original_id,
                                RoomMessageEventContentWithoutRelation::text_plain(
                                    "the rollback finished",
                                ),
                            )
                            .event_id(edit_id),
                    ),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;
        assert_eq!(in_room(&index, &room_id, "rollback", 10, 0).len(), 1);

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory.redaction(edit_id).event_id(event_id!("$redaction")),
                ),
            )
            .await;
        reingest_whole_room(&mut index, &cache, &room_id).await;

        assert!(
            in_room(&index, &room_id, "rollback", 10, 0).is_empty(),
            "a redacted edit must not leave its text searchable"
        );
        let hits = in_room(&index, &room_id, "deploying", 10, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].event_id, original_id);

        drop(room);
    }
}

#[cfg(test)]
mod stress {
    use std::time::Instant;

    use matrix_sdk::ruma::{EventId, OwnedEventId};

    use super::RoomIndex;

    const VOCABULARY: &[&str] = &[
        "deploy",
        "pipeline",
        "broken",
        "staging",
        "cluster",
        "release",
        "morning",
        "review",
        "merged",
        "reverted",
        "flaky",
        "timeout",
        "migration",
        "rollback",
        "incident",
        "postmortem",
        "dashboard",
        "latency",
        "throughput",
        "regression",
        "hotfix",
        "canary",
        "rollout",
        "database",
        "schema",
        "index",
        "query",
        "cache",
        "invalidate",
        "session",
        "token",
        "refresh",
        "encrypt",
        "decrypt",
        "verify",
        "device",
        "keys",
        "backup",
        "recovery",
        "timeline",
        "composer",
        "reaction",
        "thread",
        "redaction",
        "invite",
        "membership",
        "notification",
        "receipt",
        "presence",
        "typing",
    ];

    fn message(seed: usize) -> String {
        let mut state = seed.wrapping_mul(2_654_435_761);
        let mut words = Vec::with_capacity(12);
        for _ in 0..12 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let pick = (state >> 33) % VOCABULARY.len();
            words.push(VOCABULARY.get(pick).copied().unwrap_or("message"));
        }
        if seed.is_multiple_of(SELECTIVE_IN) {
            words.push(SELECTIVE_TERM);
        }
        words.join(" ")
    }

    const SELECTIVE_IN: usize = 500;

    const SELECTIVE_TERM: &str = "zanzibar";

    fn event_id(seed: usize) -> OwnedEventId {
        EventId::parse(format!("$stress{seed}:localhost")).expect("generated event id")
    }

    fn stress_document(seed: usize, body: String) -> super::Document {
        super::Document {
            event_id: event_id(seed),
            folded: String::new(),
            body,
            sender: matrix_sdk::ruma::user_id!("@erwan:localhost").to_owned(),
            origin_server_ts: 0,
            attachments: Vec::new(),
            has_link: false,
            mentions: Vec::new(),
            in_thread: false,
            edited_at: None,
        }
    }

    fn room_id() -> matrix_sdk::ruma::OwnedRoomId {
        matrix_sdk::ruma::RoomId::parse("!stress:localhost").expect("room id")
    }

    fn approximate_resident_kib() -> usize {
        std::fs::read_to_string("/proc/self/statm")
            .ok()
            .and_then(|statm| {
                let pages: usize = statm.split_whitespace().nth(1)?.parse().ok()?;
                Some(pages.saturating_mul(4))
            })
            .unwrap_or(0)
    }

    fn report(count: usize) {
        let before = approximate_resident_kib();

        let mut index = RoomIndex::new();
        let started = Instant::now();
        for seed in 0..count {
            index.upsert(stress_document(seed, message(seed)));
        }
        let indexing = started.elapsed();

        let resident = approximate_resident_kib().saturating_sub(before);

        let started = Instant::now();
        let matched = index
            .index
            .query(
                "deploy",
                &mut super::bm25::new(),
                super::tokenize::tokenize,
                &super::BODY_FIELD_BOOST,
            )
            .len();
        let raw = started.elapsed();

        let room = room_id();
        let mut owner = super::MessageIndex::new();
        owner.rooms.insert(room.clone(), index);

        let started = Instant::now();
        let common_hits = super::tests::in_room(&owner, &room, "deploy", 20, 0).len();
        let common = started.elapsed();

        let started = Instant::now();
        let selective_hits = super::tests::in_room(&owner, &room, SELECTIVE_TERM, 20, 0).len();
        let selective = started.elapsed();

        let mut index = owner.rooms.remove(&room).expect("room index");

        let started = Instant::now();
        for seed in 0..(count / 100).max(1) {
            index.upsert(stress_document(
                seed,
                format!("edited {}", message(seed + 7)),
            ));
        }
        let edits = started.elapsed();

        println!(
            "{count:>7} msgs | build {indexing:>8.2?} ({:>5.1?}/msg) | rss {:>4} MiB ({:>4} B/msg) \
             | raw {raw:>8.2?} over {matched:>6} matched \
             | common {common:>8.2?} ({common_hits}) | selective {selective:>8.2?} ({selective_hits}) \
             | {} edits {edits:>8.2?}",
            indexing / u32::try_from(count).unwrap_or(1),
            resident / 1024,
            resident.saturating_mul(1024) / count,
            (count / 100).max(1),
        );
    }

    #[test]
    #[ignore = "measures cost rather than asserting behaviour"]
    fn stress_index_cost_at_realistic_room_sizes() {
        println!();
        for count in [1_000, 10_000, 50_000, 100_000] {
            report(count);
        }
    }
}
