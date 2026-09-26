mod crawl;
mod persist;
mod server;
mod tokenize;

pub(crate) use crawl::CrawlProgress;
pub(crate) use server::ServerSearch;

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::{StreamExt, stream};
use linkify::LinkFinder;
use matrix_sdk::RoomState;
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::event_cache::{RoomEventCache, RoomEventCacheUpdate};
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::events::ignored_user_list::IgnoredUserListEventContent;
use matrix_sdk::ruma::events::poll::unstable_start::UnstablePollStartEventContent;
use matrix_sdk::ruma::events::relation::{RelationType, Replacement};
use matrix_sdk::ruma::events::room::message::{
    GalleryItemType, MessageType, OriginalSyncRoomMessageEvent, Relation,
    RoomMessageEventContentWithoutRelation, sanitize::remove_plain_reply_fallback,
};
use matrix_sdk::ruma::events::{
    AnySyncMessageLikeEvent, AnySyncStateEvent, AnySyncTimelineEvent, Mentions,
    SyncMessageLikeEvent, room::redaction::SyncRoomRedactionEvent,
};
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId, OwnedUserId, RoomId};
use probly_search::{Index, score::bm25};
use regex_lite::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use tracing::warn;

use self::persist::ChunkId;
use crate::Core;
use crate::attachments::{attachment_contents, fits, link_urls};
use crate::protocol::{
    RoomAttachmentContentView, RoomAttachmentKind, RoomAttachmentView, SearchAttachment,
    SearchFilter, SearchOrder,
};

const BODY_FIELD_COUNT: usize = 1;
const BODY_FIELD_BOOST: [f64; BODY_FIELD_COUNT] = [1.0];
const EVENTS_PER_INGEST_YIELD: usize = 16;
const DOCUMENTS_PER_RESTORE_YIELD: usize = 256;
const RETIRED_KEYS_BEFORE_VACUUM: usize = 64;

#[cfg(target_family = "wasm")]
const MEMORY_BUDGET: usize = 64 * 1024 * 1024;
#[cfg(not(target_family = "wasm"))]
const MEMORY_BUDGET: usize = 256 * 1024 * 1024;
const DISK_BUDGET: usize = 512 * 1024 * 1024;
const COLD_CHUNKS_PER_PAGE: usize = 32;
const OLDER_PAGE_BUDGET_MS: u64 = 50;
const HYDRATE_BATCH: usize = 30;
const HYDRATE_CONCURRENCY: usize = 8;
const DOCUMENT_OVERHEAD: usize = 1_600;
const CLASSIFIED_OVERHEAD: usize = 96;
const PINNED_FETCH_CONCURRENCY: usize = 4;

const INITIAL_DOCUMENTS: usize = 64;
const PERSIST_INTERVAL: Duration = Duration::from_secs(20);
const CHANGES_BEFORE_FLUSH: usize = 32;
const TICKS_BEFORE_FLUSH: u32 = 15;
const CHUNK_WEIGHT: usize = 8_000;
const DOCUMENT_WEIGHT: usize = 8;

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
    #[serde(default)]
    media: Vec<(Option<u32>, RoomAttachmentContentView)>,
    #[serde(default)]
    state: bool,
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
            && self.media == other.media
            && self.state == other.state
    }

    fn attachment_items(&self, kind: RoomAttachmentKind) -> Vec<RoomAttachmentView> {
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

    fn needs_media(&self, kind: RoomAttachmentKind) -> bool {
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

    fn carries(&self, attachment: SearchAttachment) -> bool {
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

struct FoldedTerms {
    phrases: Vec<String>,
    exclude: Vec<String>,
    pinned: HashSet<OwnedEventId>,
    pattern: Option<BodyPattern>,
}

const PATTERN_SIZE_LIMIT: usize = 1 << 20;

enum BodyPattern {
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
    fn of(filter: &SearchFilter, pinned: HashSet<OwnedEventId>) -> Self {
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

fn body_field(body: &Body) -> Vec<&str> {
    vec![body.0.as_str()]
}

struct RoomIndex {
    index: Index<DocKey>,
    documents: HashMap<DocKey, Document>,
    key_of: HashMap<OwnedEventId, DocKey>,
    classified: HashMap<OwnedEventId, u64>,
    edits: HashMap<OwnedEventId, OwnedEventId>,
    redacted: HashSet<OwnedEventId>,
    by_age: BTreeSet<(u64, DocKey)>,
    next_key: DocKey,
    retired_keys: usize,
    changes: usize,
    ticks_since_flush: u32,
    dirty: bool,
    revision: u64,
    durable: u64,
    chunks: BTreeMap<u64, ChunkId>,
    next_chunk: ChunkId,
    dirty_chunks: HashSet<ChunkId>,
    stale_chunks: Vec<ChunkId>,
    legacy: bool,
    listed: bool,
    cold: HashSet<ChunkId>,
    chunk_meta: HashMap<ChunkId, (usize, usize)>,
    bytes: usize,
    pending_redactions: HashSet<OwnedEventId>,
    pending_edits: HashMap<OwnedEventId, Document>,
    floor: u64,
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
            classified: HashMap::new(),
            edits: HashMap::new(),
            redacted: HashSet::new(),
            by_age: BTreeSet::new(),
            next_key: 0,
            retired_keys: 0,
            changes: 0,
            ticks_since_flush: 0,
            dirty: false,
            revision: 0,
            durable: 0,
            chunks: BTreeMap::new(),
            next_chunk: 0,
            dirty_chunks: HashSet::new(),
            stale_chunks: Vec::new(),
            legacy: false,
            listed: false,
            cold: HashSet::new(),
            chunk_meta: HashMap::new(),
            bytes: 0,
            pending_redactions: HashSet::new(),
            pending_edits: HashMap::new(),
            floor: 0,
        }
    }

    async fn restored(restored: persist::Restored) -> Self {
        let persist::Restored {
            manifest,
            loaded,
            legacy,
        } = restored;
        let documents = loaded
            .iter()
            .map(|(_, stored)| stored.documents.len())
            .sum::<usize>();
        let mut index = Self::sized(documents.max(INITIAL_DOCUMENTS));
        index.next_chunk = manifest.next_chunk;
        for entry in &manifest.chunks {
            index.chunks.insert(entry.start, entry.id);
            if !legacy {
                index
                    .chunk_meta
                    .insert(entry.id, (entry.bytes, entry.count));
            }
        }
        if let Some((&lowest, &chunk)) = index.chunks.first_key_value()
            && lowest != 0
        {
            index.chunks.remove(&lowest);
            index.chunks.insert(0, chunk);
        }
        let loaded_ids: HashSet<ChunkId> = loaded.iter().map(|(chunk, _)| *chunk).collect();
        index.cold = index
            .chunks
            .values()
            .filter(|chunk| !loaded_ids.contains(chunk))
            .copied()
            .collect();

        let mut misplaced = HashSet::new();
        let mut position = 0_usize;
        for (chunk, stored) in loaded {
            for document in stored.documents {
                if position > 0 && position.is_multiple_of(DOCUMENTS_PER_RESTORE_YIELD) {
                    matrix_sdk::sleep::sleep(Duration::ZERO).await;
                }
                position += 1;
                let home = index.chunk_for(document.origin_server_ts);
                if home != chunk {
                    misplaced.extend([home, chunk]);
                }
                index.upsert(document);
            }
            for (event_id, ts) in stored.classified {
                let home = index.chunk_for(ts);
                if home != chunk {
                    misplaced.extend([home, chunk]);
                }
                if index.classified.insert(event_id, ts).is_none() {
                    index.bytes += CLASSIFIED_OVERHEAD;
                }
            }
        }

        index.edits = manifest.edits.into_iter().collect();
        index.pending_redactions = manifest.pending_redactions.into_iter().collect();
        index.pending_edits = manifest
            .pending_edits
            .into_iter()
            .map(|document| (document.event_id.clone(), document))
            .collect();
        index.floor = manifest.floor;
        index.legacy = legacy;
        index.listed = !legacy;
        if legacy {
            misplaced.extend(index.chunks.values().copied());
        }
        index.dirty = !misplaced.is_empty()
            || !index.pending_redactions.is_empty()
            || !index.pending_edits.is_empty();
        index.dirty_chunks = misplaced;
        index.changes = 0;
        index.durable = index.revision;
        index
    }

    fn has_cold(&self) -> bool {
        !self.cold.is_empty()
    }

    fn is_hot(&self, event_id: &OwnedEventId) -> bool {
        self.document(event_id).is_some_and(|document| {
            self.chunk_at(document.origin_server_ts)
                .is_none_or(|chunk| !self.cold.contains(&chunk))
        })
    }

    fn range_of(&self, chunk: ChunkId) -> Option<(u64, Option<u64>)> {
        let start = self
            .chunks
            .iter()
            .find(|(_, id)| **id == chunk)
            .map(|(start, _)| *start)?;
        let end = self
            .chunks
            .range((std::ops::Bound::Excluded(start), std::ops::Bound::Unbounded))
            .next()
            .map(|(end, _)| *end);
        Some((start, end))
    }

    fn keys_in(&self, start: u64, end: Option<u64>) -> Vec<(u64, DocKey)> {
        let upper = end.map_or(std::ops::Bound::Unbounded, |end| {
            std::ops::Bound::Excluded((end, 0))
        });
        self.by_age
            .range((std::ops::Bound::Included((start, 0)), upper))
            .copied()
            .collect()
    }

    fn drop_range(&mut self, chunk: ChunkId) {
        let Some((start, end)) = self.range_of(chunk) else {
            return;
        };
        for (ts, key) in self.keys_in(start, end) {
            if let Some(document) = self.documents.remove(&key) {
                self.key_of.remove(&document.event_id);
                self.bytes = self.bytes.saturating_sub(document_bytes(&document));
            }
            self.by_age.remove(&(ts, key));
            self.index.remove_document(key);
            self.retired_keys = self.retired_keys.saturating_add(1);
        }
        self.vacuum_if_due();
        let before = self.classified.len();
        self.classified
            .retain(|_, ts| *ts < start || end.is_some_and(|end| *ts >= end));
        self.bytes = self
            .bytes
            .saturating_sub((before - self.classified.len()) * CLASSIFIED_OVERHEAD);
    }

    fn unload(&mut self, chunk: ChunkId) {
        self.drop_range(chunk);
        self.cold.insert(chunk);
    }

    fn unloadable(&self) -> impl Iterator<Item = (u64, ChunkId)> + '_ {
        self.chunks
            .iter()
            .zip(
                self.chunks
                    .keys()
                    .skip(1)
                    .copied()
                    .chain(std::iter::once(u64::MAX)),
            )
            .filter(|((_, chunk), _)| {
                !self.cold.contains(chunk)
                    && !self.dirty_chunks.contains(chunk)
                    && self.chunk_meta.contains_key(chunk)
            })
            .map(|((_, chunk), end)| (end, *chunk))
    }

    fn oldest_evictable(&self) -> Option<(ChunkId, u64)> {
        let mut starts = self.chunks.iter();
        let (_, &oldest) = starts.next()?;
        let (&next, _) = starts.next()?;
        self.chunk_meta
            .contains_key(&oldest)
            .then_some((oldest, next))
    }

    fn evict_oldest_chunk(&mut self, chunk: ChunkId, next: u64) {
        if !self.cold.contains(&chunk) {
            self.drop_range(chunk);
        }
        self.cold.remove(&chunk);
        self.chunk_meta.remove(&chunk);
        self.dirty_chunks.remove(&chunk);
        self.chunks.remove(&0);
        if let Some(following) = self.chunks.remove(&next) {
            self.chunks.insert(0, following);
        }
        self.floor = self.floor.max(next);
        self.dirty = true;
    }

    fn stored_documents(&self) -> usize {
        self.documents.len()
            + self
                .cold
                .iter()
                .filter_map(|chunk| self.chunk_meta.get(chunk))
                .map(|(_, count)| count)
                .sum::<usize>()
    }

    fn disk_bytes(&self) -> usize {
        self.chunk_meta.values().map(|(bytes, _)| bytes).sum()
    }

    fn chunk_at(&self, ts: u64) -> Option<ChunkId> {
        self.chunks
            .range(..=ts)
            .next_back()
            .map(|(_, chunk)| *chunk)
    }

    fn chunk_for(&mut self, ts: u64) -> ChunkId {
        if let Some(chunk) = self.chunk_at(ts) {
            return chunk;
        }
        let chunk = self.next_chunk;
        self.next_chunk = self.next_chunk.wrapping_add(1);
        self.chunks.insert(0, chunk);
        chunk
    }

    fn take_flush(&mut self) -> persist::Flush {
        let bounds: Vec<(u64, Option<u64>, ChunkId)> = self
            .chunks
            .iter()
            .zip(
                self.chunks
                    .keys()
                    .skip(1)
                    .map(Some)
                    .chain(std::iter::once(None)),
            )
            .map(|((&start, &chunk), end)| (start, end.copied(), chunk))
            .filter(|(_, _, chunk)| self.dirty_chunks.contains(chunk))
            .collect();
        self.dirty_chunks.clear();

        let mut classified: HashMap<ChunkId, Vec<(OwnedEventId, u64)>> = HashMap::new();
        for (event_id, &ts) in &self.classified {
            if let Some(chunk) = self.chunk_at(ts)
                && bounds.iter().any(|(_, _, dirty)| *dirty == chunk)
            {
                classified
                    .entry(chunk)
                    .or_default()
                    .push((event_id.clone(), ts));
            }
        }

        let mut written = Vec::new();
        let mut cold = Vec::new();
        for (start, end, chunk) in bounds {
            let upper = end.map_or(std::ops::Bound::Unbounded, |end| {
                std::ops::Bound::Excluded((end, 0))
            });
            let documents: Vec<Document> = self
                .by_age
                .range((std::ops::Bound::Included((start, 0)), upper))
                .filter_map(|(_, key)| self.documents.get(key).cloned())
                .collect();
            let ids = classified.remove(&chunk).unwrap_or_default();

            if self.cold.contains(&chunk) {
                cold.push((chunk, persist::StoredChunk::new(documents, ids)));
                continue;
            }

            if documents.is_empty() && ids.is_empty() && start != 0 {
                self.chunks.remove(&start);
                self.stale_chunks.push(chunk);
                continue;
            }

            for (position, (piece_start, documents, ids)) in
                split_chunk(start, documents, ids).into_iter().enumerate()
            {
                let piece = if position == 0 {
                    chunk
                } else {
                    let piece = self.next_chunk;
                    self.next_chunk = self.next_chunk.wrapping_add(1);
                    self.chunks.insert(piece_start, piece);
                    piece
                };
                written.push((piece, persist::StoredChunk::new(documents, ids)));
            }
        }

        let pending = !self.pending_redactions.is_empty() || !self.pending_edits.is_empty();
        let mut manifest = persist::Manifest::new(
            self.next_chunk,
            self.chunks
                .iter()
                .map(|(&start, &chunk)| {
                    let (bytes, count) = self.chunk_meta.get(&chunk).copied().unwrap_or_default();
                    persist::ChunkEntry {
                        id: chunk,
                        start,
                        bytes,
                        count,
                    }
                })
                .collect(),
            self.edits
                .iter()
                .map(|(edit, target)| (edit.clone(), target.clone()))
                .collect(),
            self.floor,
        );
        manifest.pending_redactions = self.pending_redactions.iter().cloned().collect();
        manifest.pending_edits = self.pending_edits.values().cloned().collect();

        persist::Flush {
            chunks: written,
            cold,
            scan: if pending {
                self.cold.iter().copied().collect()
            } else {
                Vec::new()
            },
            removed: self.stale_chunks.clone(),
            manifest,
            legacy: self.legacy,
        }
    }

    fn len(&self) -> usize {
        self.documents.len()
    }

    fn newest_ts(&self) -> Option<u64> {
        self.by_age.last().map(|&(ts, _)| ts)
    }

    fn touch(&mut self, ts: u64) {
        self.dirty = true;
        self.changes = self.changes.saturating_add(1);
        self.revision = self.revision.wrapping_add(1);
        let chunk = self.chunk_for(ts);
        self.dirty_chunks.insert(chunk);
    }

    fn already_classified(&self, event_id: &EventId) -> bool {
        self.classified.contains_key(event_id)
    }

    fn mark_classified(&mut self, event_id: OwnedEventId, ts: u64) {
        if self.classified.insert(event_id, ts).is_none() {
            self.bytes += CLASSIFIED_OVERHEAD;
            self.dirty = true;
            let chunk = self.chunk_for(ts);
            self.dirty_chunks.insert(chunk);
        }
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
                let (was, now) = (indexed.origin_server_ts, document.origin_server_ts);
                let before = document_bytes(indexed);
                self.by_age.remove(&(was, key));
                self.by_age.insert((now, key));
                *indexed = Document {
                    folded: std::mem::take(&mut indexed.folded),
                    ..document
                };
                let after = document_bytes(indexed);
                self.bytes = (self.bytes + after).saturating_sub(before);
                self.touch(now);
                let left = self.chunk_for(was);
                self.dirty_chunks.insert(left);
            }
            return;
        }
        self.retire(&document.event_id);
        self.vacuum_if_due();
        self.touch(document.origin_server_ts);

        let key = self.take_unused_key();
        let folded = document.body.to_lowercase();
        let body = Body(document.body);
        self.index
            .add_document(&[body_field], tokenize::tokenize, key, &body);
        self.key_of.insert(document.event_id.clone(), key);
        self.by_age.insert((document.origin_server_ts, key));
        let document = Document {
            body: body.0,
            folded,
            ..document
        };
        self.bytes += document_bytes(&document);
        self.documents.insert(key, document);
    }

    fn remove(&mut self, event_id: &OwnedEventId) {
        self.retire(event_id);
        self.vacuum_if_due();
    }

    fn forget_message(&mut self, event_id: &OwnedEventId) {
        let hot = self.is_hot(event_id);
        self.pending_edits.remove(event_id);
        self.remove(event_id);
        if !hot && self.has_cold() {
            self.pending_redactions.insert(event_id.clone());
            self.dirty = true;
        }
    }

    fn retire(&mut self, event_id: &OwnedEventId) {
        let Some(key) = self.key_of.remove(event_id) else {
            return;
        };
        let ts = self.documents.remove(&key).map_or(0, |document| {
            self.by_age.remove(&(document.origin_server_ts, key));
            self.bytes = self.bytes.saturating_sub(document_bytes(&document));
            document.origin_server_ts
        });
        self.touch(ts);
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
    memory_budget: usize,
    disk_budget: usize,
}

#[derive(Clone)]
pub(crate) struct Hit {
    pub(crate) room_id: OwnedRoomId,
    pub(crate) event_id: OwnedEventId,
    pub(crate) body: String,
    pub(crate) sender: OwnedUserId,
    pub(crate) origin_server_ts: u64,
    pub(crate) score: f64,
    pub(crate) before: Vec<ContextLine>,
    pub(crate) after: Vec<ContextLine>,
}

#[derive(Clone)]
pub(crate) struct ContextLine {
    pub(crate) event_id: OwnedEventId,
    pub(crate) body: String,
    pub(crate) sender: OwnedUserId,
    pub(crate) origin_server_ts: u64,
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
        Self::with_budgets(MEMORY_BUDGET, DISK_BUDGET)
    }

    pub(crate) const fn set_disk_budget(&mut self, disk_budget: usize) {
        self.disk_budget = disk_budget;
    }

    pub(crate) fn with_budgets(memory_budget: usize, disk_budget: usize) -> Self {
        Self {
            rooms: HashMap::new(),
            unreadable: HashSet::new(),
            memory_budget,
            disk_budget,
        }
    }

    pub(crate) fn forget_room(&mut self, room_id: &OwnedRoomId) {
        self.rooms.remove(room_id);
        self.unreadable.remove(room_id);
    }

    fn mark_unreadable(&mut self, room_id: &OwnedRoomId) {
        self.unreadable.insert(room_id.clone());
    }

    async fn restore_room(&mut self, room_id: &OwnedRoomId, restored: persist::Restored) {
        let index = RoomIndex::restored(restored).await;
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

    fn flush_failed(&mut self, room_id: &OwnedRoomId, flush: &persist::Flush) {
        if let Some(index) = self.rooms.get_mut(room_id) {
            index.dirty = true;
            index.dirty_chunks.extend(
                flush
                    .chunks
                    .iter()
                    .chain(&flush.cold)
                    .map(|(chunk, _)| *chunk),
            );
        }
    }

    fn flushed(&mut self, room_id: &OwnedRoomId, saved: Saved, revision: u64) {
        let Some(index) = self.rooms.get_mut(room_id) else {
            return;
        };
        index.durable = index.durable.max(revision);
        index.legacy = false;
        index.listed = true;
        index
            .stale_chunks
            .retain(|chunk| !saved.removed.contains(chunk));
        index.chunk_meta.extend(saved.sizes);
        for chunk in saved.lost {
            index.chunk_meta.remove(&chunk);
            index.cold.remove(&chunk);
            if let Some((start, _)) = index.range_of(chunk)
                && start != 0
            {
                index.chunks.remove(&start);
            }
        }
        index
            .pending_redactions
            .retain(|event_id| !saved.redactions.contains(event_id));
        for edit in saved.edits {
            if index
                .pending_edits
                .get(&edit.event_id)
                .is_some_and(|pending| pending.edited_at == edit.edited_at)
            {
                index.pending_edits.remove(&edit.event_id);
            }
            if !saved.resolved.contains(&edit.event_id) {
                index.upsert(edit);
            }
        }
        for chunk in saved.merged {
            if !index.dirty_chunks.contains(&chunk) {
                index.drop_range(chunk);
            }
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

    fn take_flush(&mut self, room_id: &OwnedRoomId) -> Option<(persist::Flush, u64, bool)> {
        let index = self.rooms.get_mut(room_id)?;
        index.dirty = false;
        index.changes = 0;
        index.ticks_since_flush = 0;
        Some((index.take_flush(), index.revision, index.listed))
    }

    pub(crate) fn revision(&self, room_id: &RoomId) -> u64 {
        self.rooms.get(room_id).map_or(0, |index| index.revision)
    }

    pub(crate) fn is_durable(&self, room_id: &RoomId, revision: u64) -> bool {
        self.rooms
            .get(room_id)
            .is_none_or(|index| index.durable >= revision)
    }

    fn finish_restore(&mut self) {
        self.unload_to_budget();
    }

    pub(crate) fn documents(&self) -> usize {
        self.rooms.values().map(RoomIndex::len).sum()
    }

    pub(crate) fn stored_documents(&self) -> usize {
        self.rooms.values().map(RoomIndex::stored_documents).sum()
    }

    pub(crate) fn memory(&self) -> usize {
        self.rooms.values().map(|index| index.bytes).sum()
    }

    pub(crate) fn disk(&self) -> usize {
        self.rooms.values().map(RoomIndex::disk_bytes).sum()
    }

    pub(crate) const fn budgets(&self) -> (usize, usize) {
        (self.memory_budget, self.disk_budget)
    }

    pub(crate) fn is_full(&self) -> bool {
        self.disk() >= self.disk_budget
    }

    fn disk_victim(&self) -> Option<(OwnedRoomId, ChunkId, u64)> {
        if self.disk() <= self.disk_budget {
            return None;
        }
        self.rooms
            .iter()
            .filter_map(|(room_id, index)| {
                index
                    .oldest_evictable()
                    .map(|(chunk, next)| (index.disk_bytes(), room_id, chunk, next))
            })
            .max_by_key(|(bytes, ..)| *bytes)
            .map(|(_, room_id, chunk, next)| (room_id.clone(), chunk, next))
    }

    pub(crate) fn floor_of(&self, room_id: &RoomId) -> u64 {
        self.rooms.get(room_id).map_or(0, |index| index.floor)
    }

    fn over_memory_budget(&self) -> bool {
        self.memory() > self.memory_budget
    }

    pub(crate) fn newest_in(&self, room_id: &RoomId) -> Option<u64> {
        self.rooms.get(room_id).and_then(RoomIndex::newest_ts)
    }

    fn unload_to_budget(&mut self) {
        while self.over_memory_budget() {
            let Some((room_id, chunk)) = self
                .rooms
                .iter()
                .flat_map(|(room_id, index)| {
                    index
                        .unloadable()
                        .map(move |(end, chunk)| (end, room_id, chunk))
                })
                .min()
                .map(|(_, room_id, chunk)| (room_id.clone(), chunk))
            else {
                return;
            };
            let Some(index) = self.rooms.get_mut(&room_id) else {
                return;
            };
            index.unload(chunk);
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

    fn attachment_page(
        &self,
        room_id: &RoomId,
        kind: RoomAttachmentKind,
        not_senders: &[OwnedUserId],
        before: Option<(u64, &str)>,
        limit: usize,
        work: &PageWork,
    ) -> PageStep {
        let Some(index) = self.rooms.get(room_id) else {
            return PageStep::Done(Vec::new(), None);
        };

        let ceiling = before.map_or(u64::MAX, |(ts, _)| ts);
        let chunks: Vec<(u64, ChunkId)> = index
            .chunks
            .range(..=ceiling)
            .rev()
            .map(|(start, chunk)| (*start, *chunk))
            .collect();
        let mut found: Vec<(u64, OwnedEventId, Vec<RoomAttachmentView>)> = Vec::new();
        let mut more = false;
        for (position, &(start, chunk)) in chunks.iter().enumerate() {
            let end = index
                .chunks
                .range((std::ops::Bound::Excluded(start), std::ops::Bound::Unbounded))
                .next()
                .map(|(end, _)| *end);
            let in_memory = index
                .keys_in(start, end)
                .into_iter()
                .filter_map(|(_, key)| index.documents.get(&key));
            let stored: Vec<&Document> = if index.cold.contains(&chunk) {
                let Some(stored) = work.loaded.get(&chunk) else {
                    return PageStep::Need(chunk);
                };
                stored
                    .documents
                    .iter()
                    .filter(|document| {
                        !index.key_of.contains_key(&document.event_id)
                            && !index.pending_redactions.contains(&document.event_id)
                    })
                    .collect()
            } else {
                Vec::new()
            };

            let mut unhydrated = Vec::new();
            for document in in_memory.chain(stored) {
                let ts = document.origin_server_ts;
                if before.is_some_and(|(cursor_ts, cursor_id)| {
                    ts > cursor_ts || (ts == cursor_ts && document.event_id.as_str() >= cursor_id)
                }) || not_senders.contains(&document.sender)
                {
                    continue;
                }
                if document.needs_media(kind) && !work.tried.contains(&document.event_id) {
                    unhydrated.push(document.event_id.clone());
                    continue;
                }
                let items = document.attachment_items(kind);
                if !items.is_empty() {
                    found.push((ts, document.event_id.clone(), items));
                }
            }
            if !unhydrated.is_empty() {
                unhydrated.truncate(HYDRATE_BATCH);
                return PageStep::Hydrate(unhydrated);
            }
            if found.len() >= limit {
                more = position + 1 < chunks.len();
                break;
            }
        }

        found.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
        if found.len() > limit {
            found.truncate(limit);
            more = true;
        }

        let next = found
            .last()
            .filter(|_| more)
            .map(|(ts, event_id, _)| (*ts, event_id.clone()));
        PageStep::Done(
            found.into_iter().flat_map(|(_, _, items)| items).collect(),
            next,
        )
    }

    fn in_scope(filter: &SearchFilter, room_id: &RoomId) -> bool {
        (filter.rooms.is_empty() || filter.rooms.iter().any(|wanted| wanted == room_id))
            && !filter.not_rooms.iter().any(|denied| denied == room_id)
    }

    fn cold_queue(&self, filter: &SearchFilter) -> Vec<OlderCursor> {
        let mut queue: Vec<OlderCursor> = self
            .rooms
            .iter()
            .filter(|(room_id, _)| Self::in_scope(filter, room_id))
            .flat_map(|(room_id, index)| {
                index
                    .chunks
                    .iter()
                    .filter(|(_, chunk)| index.cold.contains(chunk))
                    .map(|(start, chunk)| OlderCursor {
                        start: *start,
                        room_id: room_id.clone(),
                        chunk: *chunk,
                    })
            })
            .collect();
        queue.sort_by(OlderCursor::order);
        queue
    }

    fn scan_cold(
        &self,
        room_id: &OwnedRoomId,
        stored: &persist::StoredChunk,
        query: &str,
        filter: &SearchFilter,
        terms: &FoldedTerms,
        context: usize,
    ) -> Vec<Hit> {
        let Some(index) = self.rooms.get(room_id) else {
            return Vec::new();
        };
        let mut documents: Vec<Document> = stored
            .documents
            .iter()
            .filter(|document| {
                !index.key_of.contains_key(&document.event_id)
                    && !index.pending_redactions.contains(&document.event_id)
            })
            .cloned()
            .collect();
        documents.sort_by(|left, right| {
            left.origin_server_ts
                .cmp(&right.origin_server_ts)
                .then_with(|| left.event_id.cmp(&right.event_id))
        });
        for document in &mut documents {
            document.folded = document.body.to_lowercase();
        }

        let matched: Vec<(usize, f64)> = if query.is_empty() {
            documents
                .iter()
                .enumerate()
                .filter(|(_, document)| document.matches(filter, terms))
                .map(|(position, _)| (position, 0.0))
                .collect()
        } else {
            let mut scratch: Index<usize> =
                Index::new_with_capacity(BODY_FIELD_COUNT, documents.len(), documents.len());
            for (position, document) in documents.iter().enumerate() {
                scratch.add_document(
                    &[body_field],
                    tokenize::tokenize,
                    position,
                    &Body(document.body.clone()),
                );
            }
            scratch
                .query(
                    query,
                    &mut bm25::new(),
                    tokenize::tokenize,
                    &BODY_FIELD_BOOST,
                )
                .into_iter()
                .filter(|result| {
                    documents
                        .get(result.key)
                        .is_some_and(|document| document.matches(filter, terms))
                })
                .map(|result| (result.key, result.score))
                .collect()
        };

        let line = |document: &Document| {
            (!document.body.is_empty() && !filter.not_senders.contains(&document.sender)).then(
                || ContextLine {
                    event_id: document.event_id.clone(),
                    body: document.body.clone(),
                    sender: document.sender.clone(),
                    origin_server_ts: document.origin_server_ts,
                },
            )
        };
        matched
            .into_iter()
            .filter_map(|(position, score)| {
                let document = documents.get(position)?;
                let mut before: Vec<ContextLine> = documents
                    .get(..position)
                    .unwrap_or_default()
                    .iter()
                    .rev()
                    .filter_map(line)
                    .take(context)
                    .collect();
                before.reverse();
                let after = documents
                    .get(position + 1..)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(line)
                    .take(context)
                    .collect();
                Some(Hit {
                    room_id: room_id.clone(),
                    event_id: document.event_id.clone(),
                    body: document.body.clone(),
                    sender: document.sender.clone(),
                    origin_server_ts: document.origin_server_ts,
                    score,
                    before,
                    after,
                })
            })
            .collect()
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
                    before: Vec::new(),
                    after: Vec::new(),
                })
            })
            .collect()
    }

    fn fill_context(&self, hits: &mut [Hit], not_senders: &[OwnedUserId], lines: usize) {
        if lines == 0 {
            return;
        }
        for hit in hits {
            let Some(index) = self.rooms.get(&hit.room_id) else {
                continue;
            };
            let Some(&key) = index.key_of.get(&hit.event_id) else {
                continue;
            };
            let at = (hit.origin_server_ts, key);
            let line = |&(_, key): &(u64, DocKey)| {
                let document = index.documents.get(&key)?;
                (!document.body.is_empty() && !not_senders.contains(&document.sender)).then(|| {
                    ContextLine {
                        event_id: document.event_id.clone(),
                        body: document.body.clone(),
                        sender: document.sender.clone(),
                        origin_server_ts: document.origin_server_ts,
                    }
                })
            };
            hit.before = index
                .by_age
                .range(..at)
                .rev()
                .filter_map(line)
                .take(lines)
                .collect();
            hit.before.reverse();
            hit.after = index
                .by_age
                .range((std::ops::Bound::Excluded(at), std::ops::Bound::Unbounded))
                .filter_map(line)
                .take(lines)
                .collect();
        }
    }

    #[allow(clippy::too_many_lines)]
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
                self.unload_to_budget();
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
            let ts = event.timestamp_raw().map_or(0, |ts| ts.get().into());
            if ts < index.floor {
                continue;
            }
            index.mark_classified(event_id.to_owned(), ts);

            let message = match event.raw().deserialize() {
                Ok(AnySyncTimelineEvent::MessageLike(message)) => message,
                Ok(AnySyncTimelineEvent::State(state)) => {
                    if !index.redacted.contains(state.event_id()) {
                        index.upsert(state_document(&state, raw_content(&event).as_ref()));
                    }
                    continue;
                }
                Err(_) => continue,
            };

            if let Some(document) = poll_start_document(&message) {
                if !index.redacted.contains(&document.event_id) {
                    index.upsert(document);
                }
                continue;
            }

            match message {
                AnySyncMessageLikeEvent::RoomMessage(message) => {
                    let Some(message) = message.as_original() else {
                        continue;
                    };
                    let content = raw_content(&event);
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
                            let base = cached.or(existing);
                            if base.is_none() && index.has_cold() {
                                let pending = index
                                    .pending_edits
                                    .remove(&target)
                                    .unwrap_or_else(|| provisional_edit(message, target.clone()));
                                let edited =
                                    with_edit(pending, message, replacement, content.as_ref());
                                index.pending_edits.insert(target, edited);
                                index.dirty = true;
                                continue;
                            }
                            let base = base.unwrap_or_else(|| provisional_edit(message, target));
                            with_edit(base, message, replacement, content.as_ref())
                        }
                        None => adopt_edit(
                            cached.unwrap_or_else(|| document_of(message, content.as_ref())),
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
                            None => index.forget_message(&target),
                        }
                    } else {
                        index.edits.retain(|_, target| *target != redacted);
                        index.forget_message(&redacted);
                    }
                }

                _ => {}
            }
        }

        self.unload_to_budget();
        fresh
    }
}

#[derive(Clone, PartialEq, Eq)]
struct OlderCursor {
    start: u64,
    room_id: OwnedRoomId,
    chunk: ChunkId,
}

impl OlderCursor {
    fn order(left: &Self, right: &Self) -> std::cmp::Ordering {
        right
            .start
            .cmp(&left.start)
            .then_with(|| left.room_id.cmp(&right.room_id))
            .then_with(|| left.chunk.cmp(&right.chunk))
    }

    fn encode(&self) -> String {
        format!("{}:{}:{}", self.start, self.chunk, self.room_id)
    }

    fn decode(cursor: &str) -> Option<Self> {
        let mut parts = cursor.splitn(3, ':');
        let start = parts.next()?.parse().ok()?;
        let chunk = parts.next()?.parse().ok()?;
        let room_id = OwnedRoomId::try_from(parts.next()?).ok()?;
        Some(Self {
            start,
            room_id,
            chunk,
        })
    }
}

#[derive(Default)]
struct PageWork {
    loaded: HashMap<ChunkId, persist::StoredChunk>,
    tried: HashSet<OwnedEventId>,
}

type AttachmentMedia = Vec<(Option<u32>, RoomAttachmentContentView)>;

enum PageStep {
    Done(Vec<RoomAttachmentView>, Option<(u64, OwnedEventId)>),
    Need(ChunkId),
    Hydrate(Vec<OwnedEventId>),
}

fn newest_chunks_within(
    manifests: &[&persist::Manifest],
    budget: usize,
) -> HashMap<usize, Vec<ChunkId>> {
    let mut newest_first: Vec<(u64, usize, ChunkId, usize)> = manifests
        .iter()
        .enumerate()
        .flat_map(|(room, manifest)| {
            let mut entries = manifest.chunks.clone();
            entries.sort_by_key(|entry| entry.start);
            let ends: Vec<u64> = entries
                .iter()
                .skip(1)
                .map(|entry| entry.start)
                .chain(std::iter::once(u64::MAX))
                .collect();
            entries
                .into_iter()
                .zip(ends)
                .map(move |(entry, end)| {
                    let estimate = entry.count * DOCUMENT_OVERHEAD + entry.bytes * 2;
                    (end, room, entry.id, estimate)
                })
                .collect::<Vec<_>>()
        })
        .collect();
    newest_first.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    let mut spent = 0;
    let mut wanted: HashMap<usize, Vec<ChunkId>> = HashMap::new();
    for (_, room, chunk, estimate) in newest_first {
        if spent + estimate > budget {
            break;
        }
        spent += estimate;
        wanted.entry(room).or_default().push(chunk);
    }
    wanted
}

fn now_ms() -> u64 {
    matrix_sdk::ruma::MilliSecondsSinceUnixEpoch::now()
        .get()
        .into()
}

struct Saved {
    sizes: HashMap<ChunkId, (usize, usize)>,
    lost: Vec<ChunkId>,
    removed: Vec<ChunkId>,
    merged: Vec<ChunkId>,
    redactions: HashSet<OwnedEventId>,
    edits: Vec<Document>,
    resolved: HashSet<OwnedEventId>,
}

async fn save_room(
    client: &matrix_sdk::Client,
    room_id: &OwnedRoomId,
    mut flush: persist::Flush,
) -> Result<Saved, Box<persist::Flush>> {
    let mut sizes = HashMap::new();
    for (chunk, stored) in &flush.chunks {
        let Some(bytes) = persist::write_chunk(client, room_id, *chunk, stored).await else {
            return Err(Box::new(flush));
        };
        sizes.insert(*chunk, (bytes, stored.documents.len()));
    }
    apply_sizes(&mut flush.manifest, &sizes, &[]);
    if !persist::write_manifest(client, room_id, &flush.manifest).await {
        return Err(Box::new(flush));
    }

    let redactions: HashSet<OwnedEventId> =
        flush.manifest.pending_redactions.iter().cloned().collect();
    let edits = flush.manifest.pending_edits.clone();
    let mut targets: Vec<ChunkId> = flush.cold.iter().map(|(chunk, _)| *chunk).collect();
    for chunk in &flush.scan {
        if !targets.contains(chunk) {
            targets.push(*chunk);
        }
    }

    let mut resolved = HashSet::new();
    let mut lost = Vec::new();
    let mut merged = Vec::new();
    for chunk in targets {
        let mut stored = match persist::load_chunk(client, room_id, chunk).await {
            persist::ChunkRead::Found(stored) => stored,
            persist::ChunkRead::Missing => {
                lost.push(chunk);
                continue;
            }
            persist::ChunkRead::Unreadable => return Err(Box::new(flush)),
        };
        let patch = flush
            .cold
            .iter()
            .find(|(id, _)| *id == chunk)
            .map(|(_, patch)| patch);
        if merge_cold(&mut stored, patch, &redactions, &edits, &mut resolved) {
            let Some(bytes) = persist::write_chunk(client, room_id, chunk, &stored).await else {
                return Err(Box::new(flush));
            };
            sizes.insert(chunk, (bytes, stored.documents.len()));
        }
        if patch.is_some() {
            merged.push(chunk);
        }
    }

    if !merged.is_empty() || !lost.is_empty() || !redactions.is_empty() || !edits.is_empty() {
        apply_sizes(&mut flush.manifest, &sizes, &lost);
        flush.manifest.pending_redactions.clear();
        flush.manifest.pending_edits.clear();
        if !persist::write_manifest(client, room_id, &flush.manifest).await {
            return Err(Box::new(flush));
        }
    }
    for chunk in &flush.removed {
        persist::remove_chunk(client, room_id, *chunk).await;
    }
    if flush.legacy {
        persist::remove_legacy(client, room_id).await;
    }

    Ok(Saved {
        sizes,
        lost,
        removed: flush.removed,
        merged,
        redactions,
        edits,
        resolved,
    })
}

fn apply_sizes(
    manifest: &mut persist::Manifest,
    sizes: &HashMap<ChunkId, (usize, usize)>,
    lost: &[ChunkId],
) {
    manifest.chunks.retain(|entry| !lost.contains(&entry.id));
    for entry in &mut manifest.chunks {
        if let Some((bytes, count)) = sizes.get(&entry.id) {
            entry.bytes = *bytes;
            entry.count = *count;
        }
    }
}

fn merge_cold(
    stored: &mut persist::StoredChunk,
    patch: Option<&persist::StoredChunk>,
    redactions: &HashSet<OwnedEventId>,
    edits: &[Document],
    resolved: &mut HashSet<OwnedEventId>,
) -> bool {
    let mut changed = false;
    if let Some(patch) = patch {
        let mut position: HashMap<OwnedEventId, usize> = stored
            .documents
            .iter()
            .enumerate()
            .map(|(index, document)| (document.event_id.clone(), index))
            .collect();
        for overlay in &patch.documents {
            if let Some(&index) = position.get(&overlay.event_id) {
                if let Some(disk) = stored.documents.get_mut(index) {
                    *disk = adopt_edit(overlay.clone(), Some(disk));
                }
            } else {
                position.insert(overlay.event_id.clone(), stored.documents.len());
                stored.documents.push(overlay.clone());
            }
            changed = true;
        }
        let known: HashSet<OwnedEventId> = stored
            .classified
            .iter()
            .map(|(event_id, _)| event_id.clone())
            .collect();
        for (event_id, ts) in &patch.classified {
            if !known.contains(event_id) {
                stored.classified.push((event_id.clone(), *ts));
                changed = true;
            }
        }
    }

    let before = stored.documents.len();
    stored
        .documents
        .retain(|document| !redactions.contains(&document.event_id));
    changed |= stored.documents.len() != before;

    for edit in edits {
        if let Some(disk) = stored
            .documents
            .iter_mut()
            .find(|document| document.event_id == edit.event_id)
        {
            *disk = adopt_edit(disk.clone(), Some(edit));
            resolved.insert(edit.event_id.clone());
            changed = true;
        }
    }
    changed
}

fn document_bytes(document: &Document) -> usize {
    let media: usize = document
        .media
        .iter()
        .map(|(_, content)| match content {
            RoomAttachmentContentView::Image {
                filename,
                source,
                blurhash,
                thumbnail,
                ..
            }
            | RoomAttachmentContentView::Video {
                filename,
                source,
                blurhash,
                thumbnail,
                ..
            } => {
                filename.len()
                    + source.len()
                    + blurhash.as_ref().map_or(0, String::len)
                    + thumbnail.as_ref().map_or(0, String::len)
            }
            RoomAttachmentContentView::File {
                filename, source, ..
            } => filename.len() + source.len(),
            RoomAttachmentContentView::Link { urls, body } => {
                body.len() + urls.iter().map(String::len).sum::<usize>()
            }
        })
        .sum();
    DOCUMENT_OVERHEAD + document.body.len() * 2 + media
}

type ChunkPiece = (u64, Vec<Document>, Vec<(OwnedEventId, u64)>);

fn split_chunk(
    start: u64,
    documents: Vec<Document>,
    classified: Vec<(OwnedEventId, u64)>,
) -> Vec<ChunkPiece> {
    let mut weights: Vec<(u64, usize)> = documents
        .iter()
        .map(|document| (document.origin_server_ts, DOCUMENT_WEIGHT))
        .chain(classified.iter().map(|(_, ts)| (*ts, 1)))
        .collect();
    if weights.iter().map(|(_, weight)| weight).sum::<usize>() <= CHUNK_WEIGHT * 2 {
        return vec![(start, documents, classified)];
    }
    weights.sort_unstable();

    let mut starts = vec![start];
    let mut held = 0;
    for pair in weights.windows(2) {
        let &[(ts, weight), (next, _)] = pair else {
            continue;
        };
        held += weight;
        if held >= CHUNK_WEIGHT && next > ts {
            starts.push(next);
            held = 0;
        }
    }

    let piece_of = |ts: u64| {
        starts
            .partition_point(|&start| start <= ts)
            .saturating_sub(1)
    };
    let mut pieces: Vec<ChunkPiece> = starts
        .iter()
        .map(|&start| (start, Vec::new(), Vec::new()))
        .collect();
    for document in documents {
        if let Some(piece) = pieces.get_mut(piece_of(document.origin_server_ts)) {
            piece.1.push(document);
        }
    }
    for (event_id, ts) in classified {
        if let Some(piece) = pieces.get_mut(piece_of(ts)) {
            piece.2.push((event_id, ts));
        }
    }
    pieces
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

fn message_text(msgtype: &MessageType) -> String {
    let body = indexable_body(msgtype.body());
    let MessageType::Gallery(gallery) = msgtype else {
        return body;
    };
    std::iter::once(body.as_str())
        .chain(crate::view::gallery_filenames(gallery))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

const fn replacement_of(
    message: &OriginalSyncRoomMessageEvent,
) -> Option<&Replacement<RoomMessageEventContentWithoutRelation>> {
    match &message.content.relates_to {
        Some(Relation::Replacement(replacement)) => Some(replacement),
        _ => None,
    }
}

fn raw_content(event: &TimelineEvent) -> Option<serde_json::Value> {
    event
        .raw()
        .get_field::<serde_json::Value>("content")
        .ok()
        .flatten()
}

fn document_of(
    message: &OriginalSyncRoomMessageEvent,
    content: Option<&serde_json::Value>,
) -> Document {
    let body = message_text(&message.content.msgtype);
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
        media: attachment_contents(&message.content.msgtype, content),
        state: false,
    }
}

fn poll_start_document(message: &AnySyncMessageLikeEvent) -> Option<Document> {
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
        media: Vec::new(),
        state: false,
    }
}

fn state_document(state: &AnySyncStateEvent, content: Option<&serde_json::Value>) -> Document {
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
        media: Vec::new(),
        state: true,
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
        media: Vec::new(),
        state: false,
    }
}

fn with_edit(
    mut document: Document,
    edit: &OriginalSyncRoomMessageEvent,
    replacement: &Replacement<RoomMessageEventContentWithoutRelation>,
    raw: Option<&serde_json::Value>,
) -> Document {
    let edited_at: u64 = edit.origin_server_ts.get().into();
    if document.sender != edit.sender || document.edited_at.is_some_and(|at| at > edited_at) {
        return document;
    }

    let content = &replacement.new_content;
    document.body = message_text(&content.msgtype);
    document.has_link = contains_link(&document.body);
    document.attachments = attachments_of(&content.msgtype);
    document.mentions = mentioned_users(content.mentions.as_ref());
    document.edited_at = Some(edited_at);
    document.media = attachment_contents(
        &content.msgtype,
        raw.and_then(|raw| raw.get("m.new_content")),
    );
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
    document.media.clone_from(&existing.media);
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

fn room_message(
    event: &TimelineEvent,
) -> Option<(OriginalSyncRoomMessageEvent, Option<serde_json::Value>)> {
    match event.raw().deserialize().ok()? {
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
            SyncMessageLikeEvent::Original(message),
        )) => Some((message, raw_content(event))),
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

    let (original, content) = room_message(&original)?;
    if replacement_of(&original).is_some() {
        return None;
    }

    Some(
        replacements
            .iter()
            .filter_map(room_message)
            .filter(|(edit, _)| !redacted.contains(&edit.event_id))
            .fold(
                document_of(&original, content.as_ref()),
                |document, (edit, raw)| match replacement_of(&edit) {
                    Some(replacement) => with_edit(document, &edit, replacement, raw.as_ref()),
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
        context: usize,
    ) -> Vec<Hit> {
        if order != SearchOrder::Oldest
            && self.server_search_enabled.load(Ordering::Relaxed)
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
                context,
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

        let index = self.search_index.lock().await;
        let mut hits = index.search_pinned(query, &filter, pinned, order, limit, offset);
        index.fill_context(&mut hits, &filter.not_senders, context);
        hits
    }

    pub(crate) async fn searches_locally(
        &self,
        query: &str,
        filter: &SearchFilter,
        order: SearchOrder,
    ) -> bool {
        if order == SearchOrder::Oldest || !self.server_search_enabled.load(Ordering::Relaxed) {
            return true;
        }
        let Ok(client) = self.client().await else {
            return true;
        };
        server::target(&client, query, filter).await.is_none()
    }

    pub(crate) async fn older_start(&self, filter: &SearchFilter) -> Option<String> {
        let index = self.search_index.lock().await;
        (!index.cold_queue(filter).is_empty()).then(String::new)
    }

    pub(crate) async fn search_older(
        &self,
        query: &str,
        filter: &SearchFilter,
        order: SearchOrder,
        limit: usize,
        cursor: &str,
        context: usize,
    ) -> (Vec<Hit>, Option<String>) {
        let Ok(client) = self.client().await else {
            return (Vec::new(), None);
        };
        let mut filter = filter.clone();
        filter.not_senders.extend(self.ignored_senders().await);
        let pinned = if filter.pinned.is_some() {
            self.pinned_in_scope(&filter).await
        } else {
            HashSet::new()
        };
        let terms = FoldedTerms::of(&filter, pinned);

        let mut after = OlderCursor::decode(cursor);
        let mut hits = Vec::new();
        let mut next = None;
        let started = now_ms();
        for _ in 0..COLD_CHUNKS_PER_PAGE {
            let queue = self.search_index.lock().await.cold_queue(&filter);
            let mut remaining = queue.into_iter().filter(|candidate| {
                after.as_ref().is_none_or(|after| {
                    OlderCursor::order(after, candidate) == std::cmp::Ordering::Less
                })
            });
            let Some(position) = remaining.next() else {
                next = None;
                break;
            };
            let stored = match persist::load_chunk(&client, &position.room_id, position.chunk).await
            {
                persist::ChunkRead::Found(stored) => stored,
                persist::ChunkRead::Missing | persist::ChunkRead::Unreadable => {
                    persist::StoredChunk::new(Vec::new(), Vec::new())
                }
            };
            hits.extend(self.search_index.lock().await.scan_cold(
                &position.room_id,
                &stored,
                query,
                &filter,
                &terms,
                context,
            ));
            next = remaining.next().map(|_| position.encode());
            after = Some(position);
            if next.is_none()
                || hits.len() >= limit
                || now_ms().saturating_sub(started) >= OLDER_PAGE_BUDGET_MS
            {
                break;
            }
        }

        hits.sort_by(|left, right| match order {
            SearchOrder::Rank => right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.event_id.cmp(&right.event_id)),
            SearchOrder::Recent => right
                .origin_server_ts
                .cmp(&left.origin_server_ts)
                .then_with(|| left.event_id.cmp(&right.event_id)),
            SearchOrder::Oldest => left
                .origin_server_ts
                .cmp(&right.origin_server_ts)
                .then_with(|| left.event_id.cmp(&right.event_id)),
        });
        (hits, next)
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

    pub(crate) async fn ignored_senders(&self) -> Vec<OwnedUserId> {
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
        let joined: Vec<OwnedRoomId> = client
            .joined_rooms()
            .iter()
            .map(|room| room.room_id().to_owned())
            .collect();
        for room_id in persist::listed_rooms(client).await {
            if !joined.contains(&room_id) {
                let _ = persist::forget(client, &room_id).await;
            }
        }

        let mut opened = Vec::new();
        for room_id in joined {
            match persist::open(client, &room_id).await {
                persist::Opened::Manifest(manifest) => opened.push((room_id, manifest)),
                persist::Opened::Legacy(restored) => {
                    self.search_index
                        .lock()
                        .await
                        .restore_room(&room_id, restored)
                        .await;
                }
                persist::Opened::Unreadable => {
                    self.search_index.lock().await.mark_unreadable(&room_id);
                }
                persist::Opened::Discarded => {
                    self.search_crawl.lock().await.discard(room_id);
                }
                persist::Opened::Absent => {}
            }
        }

        let (budget, _) = self.search_index.lock().await.budgets();
        let spent = self.search_index.lock().await.memory();
        let manifests: Vec<&persist::Manifest> =
            opened.iter().map(|(_, manifest)| manifest).collect();
        let mut wanted = newest_chunks_within(&manifests, budget.saturating_sub(spent));

        for (room, (room_id, mut manifest)) in opened.into_iter().enumerate() {
            let mut loaded = Vec::new();
            let mut missing = Vec::new();
            let mut unreadable = false;
            for chunk in wanted.remove(&room).unwrap_or_default() {
                match persist::load_chunk(client, &room_id, chunk).await {
                    persist::ChunkRead::Found(stored) => loaded.push((chunk, stored)),
                    persist::ChunkRead::Missing => missing.push(chunk),
                    persist::ChunkRead::Unreadable => {
                        unreadable = true;
                        break;
                    }
                }
            }
            if unreadable {
                self.search_index.lock().await.mark_unreadable(&room_id);
                continue;
            }
            manifest.chunks.retain(|entry| !missing.contains(&entry.id));
            let mut index = self.search_index.lock().await;
            index
                .restore_room(
                    &room_id,
                    persist::Restored {
                        manifest,
                        loaded,
                        legacy: false,
                    },
                )
                .await;
            if !missing.is_empty()
                && let Some(restored) = index.rooms.get_mut(&room_id)
            {
                restored.dirty = true;
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
        let due = {
            let mut index = self.search_index.lock().await;
            if index.over_memory_budget() {
                index.dirty_rooms()
            } else {
                index.rooms_due_to_flush()
            }
        };
        self.save_rooms(client, due).await;
    }

    async fn save_rooms(&self, client: &matrix_sdk::Client, rooms: Vec<OwnedRoomId>) {
        for room_id in rooms {
            let Some((flush, revision, listed)) =
                self.search_index.lock().await.take_flush(&room_id)
            else {
                continue;
            };

            let saved = if listed || persist::list_room(client, &room_id).await {
                save_room(client, &room_id, flush).await
            } else {
                Err(Box::new(flush))
            };
            let mut index = self.search_index.lock().await;
            match saved {
                Ok(saved) => index.flushed(&room_id, saved, revision),
                Err(flush) => index.flush_failed(&room_id, &flush),
            }
            index.unload_to_budget();
        }
        self.enforce_disk_budget(client).await;
    }

    pub(crate) async fn attachment_page(
        &self,
        room_id: &OwnedRoomId,
        kind: RoomAttachmentKind,
        not_senders: &[OwnedUserId],
        before: Option<(u64, &str)>,
        limit: usize,
    ) -> (Vec<RoomAttachmentView>, Option<(u64, OwnedEventId)>) {
        let mut work = PageWork::default();
        loop {
            let step = self.search_index.lock().await.attachment_page(
                room_id,
                kind,
                not_senders,
                before,
                limit,
                &work,
            );
            let chunk = match step {
                PageStep::Done(items, next) => return (items, next),
                PageStep::Need(chunk) => chunk,
                PageStep::Hydrate(event_ids) => {
                    self.hydrate_media(room_id, &event_ids, &work.loaded).await;
                    work.tried.extend(event_ids);
                    continue;
                }
            };
            let stored = match self.client().await {
                Ok(client) => match persist::load_chunk(&client, room_id, chunk).await {
                    persist::ChunkRead::Found(stored) => stored,
                    persist::ChunkRead::Missing | persist::ChunkRead::Unreadable => {
                        persist::StoredChunk::new(Vec::new(), Vec::new())
                    }
                },
                Err(_) => persist::StoredChunk::new(Vec::new(), Vec::new()),
            };
            work.loaded.insert(chunk, stored);
        }
    }

    async fn hydrate_media(
        &self,
        room_id: &OwnedRoomId,
        event_ids: &[OwnedEventId],
        loaded: &HashMap<ChunkId, persist::StoredChunk>,
    ) {
        let Some(room) = self
            .client()
            .await
            .ok()
            .and_then(|client| client.get_room(room_id))
        else {
            return;
        };
        let fetched: Vec<(OwnedEventId, AttachmentMedia)> = stream::iter(event_ids.iter().cloned())
            .map(|event_id| {
                let room = room.clone();
                async move {
                    let media = room
                        .load_or_fetch_event(&event_id, None)
                        .await
                        .ok()
                        .and_then(|event| room_message(&event))
                        .map(|(message, content)| {
                            attachment_contents(&message.content.msgtype, content.as_ref())
                        })
                        .unwrap_or_default();
                    (event_id, media)
                }
            })
            .buffered(HYDRATE_CONCURRENCY)
            .collect()
            .await;

        let mut index = self.search_index.lock().await;
        let Some(room_index) = index.rooms.get_mut(room_id) else {
            return;
        };
        for (event_id, media) in fetched {
            if media.is_empty() {
                continue;
            }
            let document = room_index.document(&event_id).cloned().or_else(|| {
                loaded
                    .values()
                    .flat_map(|stored| &stored.documents)
                    .find(|document| document.event_id == event_id)
                    .cloned()
            });
            if let Some(mut document) = document {
                document.media = media;
                room_index.upsert(document);
            }
        }
    }

    async fn enforce_disk_budget(&self, client: &matrix_sdk::Client) {
        loop {
            let Some((room_id, chunk, next)) = self.search_index.lock().await.disk_victim() else {
                return;
            };
            persist::remove_chunk(client, &room_id, chunk).await;
            if let Some(index) = self.search_index.lock().await.rooms.get_mut(&room_id) {
                index.evict_oldest_chunk(chunk, next);
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
                    let mut rooms = persist::listed_rooms(&client).await;
                    for room in client.joined_rooms() {
                        if !rooms.iter().any(|listed| listed == room.room_id()) {
                            rooms.push(room.room_id().to_owned());
                        }
                    }
                    for room_id in rooms {
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
            media: Vec::new(),
            state: false,
        }
    }

    fn restored_from(documents: Vec<super::Document>) -> super::persist::Restored {
        let count = documents.len();
        super::persist::Restored {
            manifest: super::persist::Manifest::new(
                1,
                vec![super::persist::ChunkEntry {
                    id: 0,
                    start: 0,
                    bytes: 0,
                    count,
                }],
                Vec::new(),
                0,
            ),
            loaded: vec![(0, super::persist::StoredChunk::new(documents, Vec::new()))],
            legacy: false,
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

    fn picture(seed: &str, sender: &str, ts: u64) -> super::Document {
        super::Document {
            media: vec![(
                None,
                super::RoomAttachmentContentView::Image {
                    filename: format!("{seed}.png"),
                    source: format!("mxc://localhost/{seed}"),
                    mime: None,
                    width: None,
                    height: None,
                    blurhash: None,
                    thumbnail: None,
                    spoiler: None,
                },
            )],
            ..document(
                seed,
                &format!("{seed}.png"),
                sender,
                ts,
                Some(super::SearchAttachment::Image),
                Vec::new(),
            )
        }
    }

    fn attachment_pages(
        index: &MessageIndex,
        room: &matrix_sdk::ruma::RoomId,
        not_senders: &[matrix_sdk::ruma::OwnedUserId],
        limit: usize,
    ) -> Vec<Vec<String>> {
        attachment_pages_with(index, room, not_senders, limit, &mut |_| None)
    }

    fn attachment_pages_with(
        index: &MessageIndex,
        room: &matrix_sdk::ruma::RoomId,
        not_senders: &[matrix_sdk::ruma::OwnedUserId],
        limit: usize,
        load: &mut dyn FnMut(super::ChunkId) -> Option<super::persist::StoredChunk>,
    ) -> Vec<Vec<String>> {
        let mut pages = Vec::new();
        let mut work = super::PageWork::default();
        let mut before: Option<(u64, matrix_sdk::ruma::OwnedEventId)> = None;
        loop {
            let step = index.attachment_page(
                room,
                super::RoomAttachmentKind::Media,
                not_senders,
                before
                    .as_ref()
                    .map(|(ts, event_id)| (*ts, event_id.as_str())),
                limit,
                &work,
            );
            let (items, next) = match step {
                super::PageStep::Done(items, next) => (items, next),
                super::PageStep::Hydrate(_) => panic!("unexpected hydrate step"),
                super::PageStep::Need(chunk) => {
                    let stored = load(chunk).expect("stored chunk");
                    work.loaded.insert(chunk, stored);
                    continue;
                }
            };
            pages.push(
                items
                    .into_iter()
                    .map(|item| item.event_id.to_string())
                    .collect(),
            );
            match next {
                Some(cursor) => before = Some(cursor),
                None => return pages,
            }
        }
    }

    #[test]
    fn test_attachment_pages_walk_every_picture_once_across_a_timestamp_tie() {
        let room = matrix_sdk::ruma::RoomId::parse("!pictures:localhost").expect("room id");
        let mut index = MessageIndex::new();
        let room_index = index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new);
        for (seed, ts) in [("a", 3), ("d", 2), ("b", 2), ("c", 2), ("e", 1)] {
            room_index.upsert(picture(seed, "@erwan:localhost", ts));
        }
        room_index.upsert(document(
            "text",
            "no picture here",
            "@erwan:localhost",
            2,
            None,
            Vec::new(),
        ));

        assert_eq!(
            attachment_pages(&index, &room, &[], 2),
            [vec!["$a", "$d"], vec!["$c", "$b"], vec!["$e"],]
        );
    }

    #[test]
    fn test_attachment_pages_reach_into_an_unloaded_chunk() {
        let room = matrix_sdk::ruma::RoomId::parse("!gallery:localhost").expect("room id");
        let mut room_index = super::RoomIndex::new();
        for seed in 0..2_500_u64 {
            room_index.upsert(picture(&format!("p{seed}"), "@erwan:localhost", seed));
        }
        let flush = room_index.take_flush();
        let mut stored: std::collections::HashMap<super::ChunkId, super::persist::StoredChunk> =
            std::collections::HashMap::new();
        for (chunk, contents) in flush.chunks {
            room_index
                .chunk_meta
                .insert(chunk, (1_000, contents.documents.len()));
            stored.insert(chunk, contents);
        }
        let oldest = *room_index.chunks.values().next().expect("a chunk");
        room_index.unload(oldest);
        let mut index = MessageIndex::new();
        index.rooms.insert(room.clone(), room_index);

        let mut asked = Vec::new();
        let pages = attachment_pages_with(&index, &room, &[], 100, &mut |chunk| {
            asked.push(chunk);
            stored.remove(&chunk)
        });

        let mut seen: Vec<String> = pages.into_iter().flatten().collect();
        assert_eq!(asked, [oldest]);
        assert_eq!(seen.first().map(String::as_str), Some("$p2499"));
        assert_eq!(seen.last().map(String::as_str), Some("$p0"));
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 2_500);
    }

    #[test]
    fn test_attachment_pages_skip_ignored_senders() {
        let room = matrix_sdk::ruma::RoomId::parse("!pictures:localhost").expect("room id");
        let mut index = MessageIndex::new();
        let room_index = index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new);
        room_index.upsert(picture("kept", "@erwan:localhost", 2));
        room_index.upsert(picture("hidden", "@troll:localhost", 1));

        assert_eq!(
            attachment_pages(
                &index,
                &room,
                &[matrix_sdk::ruma::user_id!("@troll:localhost").to_owned()],
                10,
            ),
            [vec!["$kept"]]
        );
    }

    #[async_test]
    async fn test_a_restored_index_lists_media_without_the_event_cache() {
        let room = matrix_sdk::ruma::RoomId::parse("!pictures:localhost").expect("room id");
        let mut index = MessageIndex::new();
        index.rooms.insert(
            room.clone(),
            super::RoomIndex::restored(restored_from(vec![picture(
                "beach",
                "@erwan:localhost",
                1,
            )]))
            .await,
        );

        let super::PageStep::Done(items, next) = index.attachment_page(
            &room,
            super::RoomAttachmentKind::Media,
            &[],
            None,
            10,
            &super::PageWork::default(),
        ) else {
            panic!("nothing is cold");
        };
        assert!(next.is_none());
        assert!(matches!(
            items.as_slice(),
            [crate::protocol::RoomAttachmentView {
                content: crate::protocol::RoomAttachmentContentView::Image { source, .. },
                ..
            }] if source == "mxc://localhost/beach"
        ));
    }

    #[test]
    fn test_a_hit_carries_its_indexed_neighbours_minus_ignored_senders() {
        let (mut index, room) = filtered_index();
        index
            .rooms
            .get_mut(&room)
            .expect("room index")
            .upsert(document(
                "troll",
                "noise",
                "@troll:localhost",
                2_500,
                None,
                Vec::new(),
            ));
        let mut hits = index.search(
            "pipeline",
            &super::SearchFilter::default(),
            super::SearchOrder::Rank,
            10,
            0,
        );
        hits.extend(index.search(
            "finished",
            &super::SearchFilter::default(),
            super::SearchOrder::Rank,
            10,
            0,
        ));

        index.fill_context(
            &mut hits,
            &[matrix_sdk::ruma::user_id!("@troll:localhost").to_owned()],
            1,
        );

        let ids = |lines: &[super::ContextLine]| {
            lines
                .iter()
                .map(|line| line.event_id.to_string())
                .collect::<Vec<_>>()
        };
        assert!(hits[0].before.is_empty());
        assert_eq!(ids(&hits[0].after), ["$alice"]);
        assert_eq!(ids(&hits[1].before), ["$erwan"]);
        assert_eq!(ids(&hits[1].after), ["$screenshot"]);
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
                .mark_classified(event.event_id().expect("an event id").to_owned(), 0);
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
    fn test_state_events_file_types_and_patterns_filter_documents() {
        let (mut index, room) = filtered_index();
        let room_index = index.rooms.get_mut(&room).expect("the room");
        room_index.upsert(super::Document {
            state: true,
            ..document(
                "renamed",
                "deploy crew",
                "@alice:localhost",
                4_000,
                None,
                Vec::new(),
            )
        });
        room_index.upsert(super::Document {
            media: vec![(
                None,
                super::RoomAttachmentContentView::File {
                    filename: "deploy-notes.pdf".to_owned(),
                    source: "mxc://localhost/notes".to_owned(),
                    mime: Some("application/pdf".to_owned()),
                    size: None,
                },
            )],
            ..document(
                "notes",
                "deploy-notes.pdf",
                "@alice:localhost",
                5_000,
                Some(super::SearchAttachment::File),
                Vec::new(),
            )
        });
        let filter = |filter: super::SearchFilter| {
            found(
                &index,
                "deploy",
                &super::SearchFilter {
                    rooms: vec![room.clone()],
                    ..filter
                },
            )
        };

        let plain = filter(super::SearchFilter::default());
        assert!(!plain.contains(&"$renamed".to_owned()));
        assert_eq!(
            filter(super::SearchFilter {
                state_events: Some(true),
                ..super::SearchFilter::default()
            }),
            vec!["$renamed".to_owned()]
        );
        assert_eq!(
            filter(super::SearchFilter {
                file_types: vec!["PDF".to_owned()],
                ..super::SearchFilter::default()
            }),
            vec!["$notes".to_owned()]
        );
        assert!(
            filter(super::SearchFilter {
                pattern: Some(r"pipe\w+ is".to_owned()),
                ..super::SearchFilter::default()
            })
            .contains(&"$erwan".to_owned())
        );
        assert!(
            filter(super::SearchFilter {
                pattern: Some("(unclosed".to_owned()),
                ..super::SearchFilter::default()
            })
            .is_empty()
        );
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

    fn persisted(index: &mut super::RoomIndex) {
        let flush = index.take_flush();
        for (chunk, stored) in flush.chunks {
            index
                .chunk_meta
                .insert(chunk, (1_000, stored.documents.len()));
        }
    }

    fn budgeted_room(count: usize, from: u64) -> super::RoomIndex {
        let mut index = super::RoomIndex::new();
        for seed in 0..count {
            let ts = from + seed as u64;
            index.upsert(document(
                &format!("d{ts}"),
                &format!("deploy note w{ts}"),
                "@erwan:localhost",
                ts,
                None,
                Vec::new(),
            ));
        }
        persisted(&mut index);
        index
    }

    #[test]
    fn test_the_memory_budget_unloads_the_oldest_chunk_and_keeps_it_on_disk() {
        let room = matrix_sdk::ruma::RoomId::parse("!budget:localhost").expect("room id");
        let room_index = budgeted_room(5_000, 0);
        let full = room_index.bytes;
        let mut index = MessageIndex::with_budgets(full / 2, usize::MAX);
        index.rooms.insert(room.clone(), room_index);

        index.unload_to_budget();

        assert!(index.memory() <= full / 2);
        assert!(in_room(&index, &room, "w0", 10, 0).is_empty());
        assert_eq!(in_room(&index, &room, "w4999", 10, 0).len(), 1);
        assert_eq!(index.stored_documents(), 5_000);
    }

    #[test]
    fn test_the_memory_budget_spans_rooms_rather_than_each_room_separately() {
        let busy = matrix_sdk::ruma::RoomId::parse("!busy:localhost").expect("room id");
        let quiet = matrix_sdk::ruma::RoomId::parse("!quiet:localhost").expect("room id");
        let busy_index = budgeted_room(2_500, 1_000_000);
        let quiet_index = budgeted_room(2_500, 0);
        let budget = busy_index.bytes + quiet_index.bytes / 2;
        let mut index = MessageIndex::with_budgets(budget, usize::MAX);
        index.rooms.insert(busy.clone(), busy_index);
        index.rooms.insert(quiet.clone(), quiet_index);

        index.unload_to_budget();

        assert!(in_room(&index, &quiet, "w0", 10, 0).is_empty());
        assert_eq!(in_room(&index, &busy, "w1000000", 10, 0).len(), 1);
    }

    #[test]
    fn test_a_dirty_chunk_is_never_unloaded() {
        let room = matrix_sdk::ruma::RoomId::parse("!dirty:localhost").expect("room id");
        let mut room_index = super::RoomIndex::new();
        seed_room(&mut room_index, 3_000);
        let mut index = MessageIndex::with_budgets(1, usize::MAX);
        index.rooms.insert(room, room_index);

        index.unload_to_budget();

        assert_eq!(index.documents(), 3_000);
    }

    #[test]
    fn test_the_disk_budget_reports_the_index_full() {
        let room = matrix_sdk::ruma::RoomId::parse("!full:localhost").expect("room id");
        let mut room_index = budgeted_room(10, 0);
        room_index
            .chunk_meta
            .values_mut()
            .for_each(|meta| meta.0 = 60);
        let mut index = MessageIndex::with_budgets(usize::MAX, 100);
        index.rooms.insert(room.clone(), room_index);
        assert!(index.disk() < 100 || index.is_full());

        index
            .rooms
            .get_mut(&room)
            .expect("room")
            .chunk_meta
            .insert(99, (60, 1));
        assert!(index.is_full());
    }

    #[test]
    fn test_merging_into_a_cold_chunk_keeps_one_copy_and_purges_redactions() {
        let mut stored = super::persist::StoredChunk::new(
            vec![
                document("kept", "old body", "@erwan:localhost", 1, None, Vec::new()),
                document("gone", "secret", "@erwan:localhost", 2, None, Vec::new()),
            ],
            vec![(event_id!("$kept").to_owned(), 1)],
        );
        let overlay = super::persist::StoredChunk::new(
            vec![document(
                "kept",
                "old body",
                "@erwan:localhost",
                1,
                None,
                Vec::new(),
            )],
            vec![
                (event_id!("$kept").to_owned(), 1),
                (event_id!("$reaction").to_owned(), 1),
            ],
        );
        let redactions = [event_id!("$gone").to_owned()].into_iter().collect();
        let mut resolved = std::collections::HashSet::new();

        assert!(super::merge_cold(
            &mut stored,
            Some(&overlay),
            &redactions,
            &[],
            &mut resolved
        ));

        let ids: Vec<String> = stored
            .documents
            .iter()
            .map(|document| document.event_id.to_string())
            .collect();
        assert_eq!(ids, ["$kept"]);
        assert_eq!(stored.classified.len(), 2);
    }

    #[test]
    fn test_a_pending_edit_lands_on_the_stored_original() {
        let mut stored = super::persist::StoredChunk::new(
            vec![document(
                "original",
                "typo",
                "@erwan:localhost",
                5,
                None,
                Vec::new(),
            )],
            Vec::new(),
        );
        let mut edit = document(
            "original",
            "fixed",
            "@erwan:localhost",
            900,
            None,
            Vec::new(),
        );
        edit.edited_at = Some(900);
        let mut resolved = std::collections::HashSet::new();

        super::merge_cold(
            &mut stored,
            None,
            &std::collections::HashSet::new(),
            &[edit],
            &mut resolved,
        );

        let [original] = stored.documents.as_slice() else {
            panic!("one document");
        };
        assert_eq!(original.body, "fixed");
        assert_eq!(original.origin_server_ts, 5);
        assert!(resolved.contains(event_id!("$original")));
    }

    #[async_test]
    async fn test_a_redaction_of_an_unloaded_message_is_purged_from_disk() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room = room_id!("!purge:localhost").to_owned();
        let (core, _events) = crate::Core::new(
            "search-cold-purge",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        {
            let mut index = core.search_index.lock().await;
            *index = MessageIndex::with_budgets(usize::MAX, usize::MAX);
            let mut room_index = super::RoomIndex::new();
            seed_room(&mut room_index, 3_000);
            index.rooms.insert(room.clone(), room_index);
        }
        core.flush_search_index(&client).await;

        let oldest = {
            let mut index = core.search_index.lock().await;
            let room_index = index.rooms.get_mut(&room).expect("room");
            let oldest = *room_index.chunks.values().next().expect("a chunk");
            room_index.unload(oldest);
            room_index.forget_message(&event_id!("$s0").to_owned());
            oldest
        };
        core.flush_search_index(&client).await;

        let super::persist::ChunkRead::Found(stored) =
            super::persist::load_chunk(&client, &room, oldest).await
        else {
            panic!("missing chunk");
        };
        assert!(
            stored
                .documents
                .iter()
                .all(|document| document.event_id != event_id!("$s0"))
        );
        assert!(stored.documents.len() > 100);
        let index = core.search_index.lock().await;
        assert!(index.rooms[&room].pending_redactions.is_empty());
    }

    #[async_test]
    async fn test_older_pages_search_what_is_only_on_disk() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room = room_id!("!older:localhost").to_owned();
        let core = logged_in(&server, &client, "search-older").await;
        {
            let mut index = core.search_index.lock().await;
            *index = MessageIndex::with_budgets(usize::MAX, usize::MAX);
            let mut room_index = super::RoomIndex::new();
            for seed in 0..3_000_u64 {
                room_index.upsert(document(
                    &format!("o{seed}"),
                    &format!("archive entry w{seed}x"),
                    "@erwan:localhost",
                    seed,
                    None,
                    Vec::new(),
                ));
            }
            index.rooms.insert(room.clone(), room_index);
        }
        core.flush_search_index(&client).await;
        {
            let mut index = core.search_index.lock().await;
            let room_index = index.rooms.get_mut(&room).expect("room");
            let oldest = *room_index.chunks.values().next().expect("a chunk");
            room_index.unload(oldest);
        }
        let filter = super::SearchFilter::default();

        let hot = core
            .search_messages("w1x", &filter, super::SearchOrder::Rank, 30, 0, 0)
            .await;
        assert!(hot.is_empty());
        let start = core
            .older_start(&filter)
            .await
            .expect("a cold chunk is in scope");

        let (older, next) = core
            .search_older("w1x", &filter, super::SearchOrder::Rank, 30, &start, 1)
            .await;
        assert_eq!(
            older
                .iter()
                .map(|hit| hit.event_id.as_str())
                .collect::<Vec<_>>(),
            ["$o1"]
        );
        assert_eq!(older[0].before[0].event_id, event_id!("$o0"));
        assert_eq!(older[0].after[0].event_id, event_id!("$o2"));
        assert!(next.is_none());
    }

    #[test]
    fn test_the_disk_budget_drops_the_oldest_chunk_and_raises_the_floor() {
        let room = matrix_sdk::ruma::RoomId::parse("!disk:localhost").expect("room id");
        let room_index = budgeted_room(3_000, 0);
        let chunks = room_index.chunks.len();
        assert!(chunks > 2);
        let mut index = MessageIndex::with_budgets(usize::MAX, 1_000 * (chunks - 1));
        index.rooms.insert(room.clone(), room_index);

        let (victim_room, chunk, next) = index.disk_victim().expect("over the disk budget");
        assert_eq!(victim_room, room);
        index
            .rooms
            .get_mut(&room)
            .expect("room")
            .evict_oldest_chunk(chunk, next);

        let evicted = &index.rooms[&room];
        assert_eq!(evicted.floor, next);
        assert_eq!(evicted.chunks.len(), chunks - 1);
        assert_eq!(evicted.chunks.keys().next(), Some(&0));
        assert!(in_room(&index, &room, "w0", 10, 0).is_empty());
        assert!(index.disk_victim().is_none());
    }

    #[async_test]
    async fn test_one_older_page_keeps_scanning_until_it_finds_something() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room = room_id!("!deep:localhost").to_owned();
        let core = logged_in(&server, &client, "search-older-deep").await;

        let mut room_index = super::RoomIndex::new();
        for chunk in 0..10_u32 {
            let start = u64::from(chunk) * 100;
            let body = if chunk == 0 { "the needle" } else { "hay" };
            let stored = super::persist::StoredChunk::new(
                vec![document(
                    &format!("c{chunk}"),
                    body,
                    "@erwan:localhost",
                    start + 1,
                    None,
                    Vec::new(),
                )],
                Vec::new(),
            );
            assert!(
                super::persist::write_chunk(&client, &room, chunk, &stored)
                    .await
                    .is_some()
            );
            room_index.chunks.insert(start, chunk);
            room_index.chunk_meta.insert(chunk, (100, 1));
            room_index.cold.insert(chunk);
        }
        room_index.next_chunk = 10;
        core.search_index
            .lock()
            .await
            .rooms
            .insert(room.clone(), room_index);

        let filter = super::SearchFilter::default();
        let start = core
            .older_start(&filter)
            .await
            .expect("cold chunks in scope");
        let (hits, next) = core
            .search_older("needle", &filter, super::SearchOrder::Rank, 30, &start, 0)
            .await;

        assert_eq!(
            hits.iter()
                .map(|hit| hit.event_id.as_str())
                .collect::<Vec<_>>(),
            ["$c0"]
        );
        assert!(next.is_none());
    }

    #[test]
    fn test_a_migrated_picture_without_media_asks_to_be_hydrated_once() {
        let room = matrix_sdk::ruma::RoomId::parse("!migrated:localhost").expect("room id");
        let mut index = MessageIndex::new();
        index
            .rooms
            .entry(room.clone())
            .or_insert_with(super::RoomIndex::new)
            .upsert(document(
                "old",
                "beach.png",
                "@erwan:localhost",
                1,
                Some(super::SearchAttachment::Image),
                Vec::new(),
            ));
        let page = |tried: std::collections::HashSet<matrix_sdk::ruma::OwnedEventId>| {
            index.attachment_page(
                &room,
                super::RoomAttachmentKind::Media,
                &[],
                None,
                10,
                &super::PageWork {
                    tried,
                    ..super::PageWork::default()
                },
            )
        };

        let super::PageStep::Hydrate(asked) = page(std::collections::HashSet::new()) else {
            panic!("expected a hydrate step");
        };
        assert_eq!(asked, [event_id!("$old").to_owned()]);

        assert!(
            matches!(page(asked.into_iter().collect()), super::PageStep::Done(items, None) if items.is_empty())
        );
    }

    #[async_test]
    async fn test_the_gallery_fills_in_media_for_a_migrated_message() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");
        let room_id = room_id!("!hydrate:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    EventFactory::new()
                        .room(&room_id)
                        .sender(user_id!("@erwan:localhost"))
                        .image(
                            "beach.png".to_owned(),
                            matrix_sdk::ruma::owned_mxc_uri!("mxc://localhost/beach"),
                        )
                        .event_id(event_id!("$image")),
                ),
            )
            .await;
        let core = logged_in(&server, &client, "search-hydrate").await;
        core.search_index
            .lock()
            .await
            .rooms
            .entry(room_id.clone())
            .or_insert_with(super::RoomIndex::new)
            .upsert(document(
                "image",
                "beach.png",
                "@erwan:localhost",
                1,
                Some(super::SearchAttachment::Image),
                Vec::new(),
            ));

        let (items, _) = core
            .attachment_page(&room_id, super::RoomAttachmentKind::Media, &[], None, 10)
            .await;

        assert!(matches!(
            items.as_slice(),
            [crate::protocol::RoomAttachmentView {
                content: crate::protocol::RoomAttachmentContentView::Image { source, .. },
                ..
            }] if source == "mxc://localhost/beach"
        ));
        let index = core.search_index.lock().await;
        let stored = index.rooms[&room_id]
            .document(&event_id!("$image").to_owned())
            .expect("still indexed");
        assert_eq!(stored.media.len(), 1);
        assert!(index.rooms[&room_id].dirty);
        drop(room);
    }

    #[test]
    fn test_redacting_an_unloaded_message_is_recorded_for_the_next_save() {
        let mut index = budgeted_room(3_000, 0);
        let oldest = *index.chunks.values().next().expect("a chunk");
        index.unload(oldest);

        index.forget_message(&event_id!("$d0").to_owned());

        assert!(index.pending_redactions.contains(event_id!("$d0")));
        assert!(index.dirty);
        let flush = index.take_flush();
        assert!(flush.scan.contains(&oldest));
        assert!(
            flush
                .manifest
                .pending_redactions
                .contains(&event_id!("$d0").to_owned())
        );
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

    fn seed_room(index: &mut super::RoomIndex, count: usize) {
        for seed in 0..count {
            index.upsert(document(
                &format!("s{seed}"),
                &format!("message {seed}"),
                "@erwan:localhost",
                seed as u64,
                None,
                Vec::new(),
            ));
        }
    }

    fn chunked_room(count: usize) -> super::RoomIndex {
        let mut index = super::RoomIndex::new();
        for seed in 0..count {
            index.upsert(document(
                &format!("m{seed}"),
                &format!("message {seed}"),
                "@erwan:localhost",
                seed as u64,
                None,
                Vec::new(),
            ));
        }
        index
    }

    #[test]
    fn test_a_flush_rewrites_only_the_chunk_that_changed() {
        let mut index = chunked_room(5_000);
        let first = index.take_flush();
        assert!(first.chunks.len() > 2);
        let mut written: Vec<String> = first
            .chunks
            .iter()
            .flat_map(|(_, chunk)| {
                chunk
                    .documents
                    .iter()
                    .map(|document| document.event_id.to_string())
            })
            .collect();
        written.sort();
        written.dedup();
        assert_eq!(written.len(), 5_000);

        index.upsert(document(
            "late",
            "a late message",
            "@erwan:localhost",
            10_000,
            None,
            Vec::new(),
        ));
        let second = index.take_flush();
        assert_eq!(second.chunks.len(), 1);
        assert!(
            second.chunks[0]
                .1
                .documents
                .iter()
                .any(|document| document.event_id == event_id!("$late"))
        );
    }

    #[test]
    fn test_a_removed_message_leaves_its_chunk_on_the_next_flush() {
        let mut index = chunked_room(3_000);
        index.take_flush();

        index.remove(&event_id!("$m10").to_owned());
        let flush = index.take_flush();
        assert_eq!(flush.chunks.len(), 1);
        assert!(
            flush.chunks[0]
                .1
                .documents
                .iter()
                .all(|document| document.event_id != event_id!("$m10"))
        );
    }

    #[async_test]
    async fn test_a_chunked_room_restores_every_document_and_classified_id() {
        let mut index = chunked_room(3_000);
        index.mark_classified(event_id!("$reaction").to_owned(), 1_500);
        let flush = index.take_flush();
        let restored = super::RoomIndex::restored(super::persist::Restored {
            manifest: flush.manifest,
            loaded: flush.chunks,
            legacy: false,
        })
        .await;

        assert_eq!(restored.len(), 3_000);
        assert!(restored.already_classified(event_id!("$reaction")));
        assert!(!restored.dirty);
    }

    #[async_test]
    async fn test_a_v3_blob_from_main_is_split_into_chunks_without_a_recrawl() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!legacy:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;
        let room = server
            .sync_room(&client, JoinedRoomBuilder::new(&room_id))
            .await;

        let documents: Vec<super::Document> = (0..3_000)
            .map(|seed| {
                document(
                    &format!("old{seed}"),
                    &format!("archaeology {seed}"),
                    "@erwan:localhost",
                    seed,
                    None,
                    Vec::new(),
                )
            })
            .collect();
        let documents: Vec<serde_json::Value> = documents
            .iter()
            .map(|document| {
                let mut json = serde_json::to_value(document).expect("document json");
                json.as_object_mut().expect("an object").remove("media");
                json
            })
            .collect();
        let legacy = serde_json::json!({
            "version": 3,
            "documents": documents,
            "classified": ["$old0", "$reaction"],
            "edits": [],
        });
        client
            .state_store()
            .set_custom_value(
                format!("sable.search.documents.{room_id}").as_bytes(),
                serde_json::to_vec(&legacy).expect("legacy json"),
            )
            .await
            .expect("legacy blob");

        let (core, _events) = crate::Core::new(
            "search-legacy",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.restore_persisted_index(&client).await;
        assert_eq!(
            in_room(
                &*core.search_index.lock().await,
                &room_id,
                "archaeology",
                5_000,
                0
            )
            .len(),
            3_000
        );
        core.flush_search_index(&client).await;

        let store = client.state_store();
        assert!(
            store
                .get_custom_value(format!("sable.search.documents.{room_id}").as_bytes())
                .await
                .expect("read")
                .is_none()
        );
        assert_eq!(
            super::persist::listed_rooms(&client).await,
            vec![room_id.clone()]
        );

        let (second, _second_events) = crate::Core::new(
            "search-legacy-second",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        second.restore_persisted_index(&client).await;
        let index = second.search_index.lock().await;
        assert_eq!(
            in_room(&index, &room_id, "archaeology", 5_000, 0).len(),
            3_000
        );
        assert!(index.rooms[&room_id].already_classified(event_id!("$reaction")));
        assert!(index.rooms[&room_id].chunks.len() > 1);

        drop(room);
    }

    #[async_test]
    async fn test_a_room_left_between_sessions_is_wiped_at_restore() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let left = room_id!("!left:localhost").to_owned();

        let mut index = chunked_room(10);
        let flush = index.take_flush();
        assert!(super::persist::list_room(&client, &left).await);
        for (chunk, stored) in &flush.chunks {
            assert!(
                super::persist::write_chunk(&client, &left, *chunk, stored)
                    .await
                    .is_some()
            );
        }
        assert!(super::persist::write_manifest(&client, &left, &flush.manifest).await);

        let (core, _events) = crate::Core::new(
            "search-left-room",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.restore_persisted_index(&client).await;

        assert!(super::persist::listed_rooms(&client).await.is_empty());
        assert!(matches!(
            super::persist::open(&client, &left).await,
            super::persist::Opened::Absent
        ));
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

        index.take_flush(&room);
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
        use crate::protocol::RoomAttachmentKind;

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

        let (media, next) = core
            .room_attachments(&room_id, RoomAttachmentKind::Media, 10, None)
            .await
            .expect("media");
        assert!(next.is_none());
        assert!(matches!(
            media.as_slice(),
            [crate::protocol::RoomAttachmentView {
                content: crate::protocol::RoomAttachmentContentView::Image { filename, source, .. },
                ..
            }] if filename == "beach.png" && source == "mxc://localhost/beach"
        ));

        let (files, _) = core
            .room_attachments(&room_id, RoomAttachmentKind::File, 10, None)
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
            .room_attachments(&room_id, RoomAttachmentKind::Link, 10, None)
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
        use crate::protocol::RoomAttachmentKind;

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
            .room_attachments(&room_id, RoomAttachmentKind::Media, 10, None)
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
            .room_attachments(&room_id, RoomAttachmentKind::File, 10, None)
            .await
            .expect("files");
        let files = serde_json::to_value(&files).expect("files json");
        assert_eq!(files.as_array().map(Vec::len), Some(1));
        assert_eq!(files[0]["gallery_index"], 1);
        assert_eq!(files[0]["content"]["filename"], "notes.pdf");
        assert_eq!(files[0]["content"]["size"], 4096);

        let filter = super::SearchFilter {
            rooms: vec![room_id.clone()],
            ..super::SearchFilter::default()
        };
        let hits = core
            .search_messages("notes", &filter, super::SearchOrder::Rank, 10, 0, 0)
            .await;
        assert_eq!(
            hits.iter()
                .map(|hit| hit.event_id.as_str())
                .collect::<Vec<_>>(),
            ["$gallery"]
        );

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
            .search_messages("deploy", &filter, super::SearchOrder::Rank, 10, 0, 0)
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
            .search_messages("", &filter, super::SearchOrder::Recent, 10, 0, 0)
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
        index.restore_room(&room, restored_from(documents)).await;
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
            origin_server_ts: seed as u64,
            attachments: Vec::new(),
            has_link: false,
            mentions: Vec::new(),
            in_thread: false,
            edited_at: None,
            media: Vec::new(),
            state: false,
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
        let first = index.take_flush();
        let first_bytes: usize = first
            .chunks
            .iter()
            .map(|(_, chunk)| serde_json::to_vec(chunk).map_or(0, |bytes| bytes.len()))
            .sum();
        let first_flush = started.elapsed();
        index.upsert(stress_document(count, "one more message".to_owned()));
        let started = Instant::now();
        let next = index.take_flush();
        let next_bytes: usize = next
            .chunks
            .iter()
            .map(|(_, chunk)| serde_json::to_vec(chunk).map_or(0, |bytes| bytes.len()))
            .sum();
        let next_flush = started.elapsed();
        let sample = first.chunks.first().map(|(_, chunk)| {
            super::persist::StoredChunk::new(chunk.documents.clone(), Vec::new())
        });
        let started = Instant::now();
        let mut probe = super::MessageIndex::new();
        probe.rooms.insert(room_id(), RoomIndex::new());
        let cold_hits = sample.map_or(0, |sample| {
            probe
                .scan_cold(
                    &room_id(),
                    &sample,
                    "deploy",
                    &super::SearchFilter::default(),
                    &super::FoldedTerms::of(
                        &super::SearchFilter::default(),
                        std::collections::HashSet::new(),
                    ),
                    1,
                )
                .len()
        });
        let cold_scan = started.elapsed();
        println!(
            "{count:>7} msgs | one cold chunk searched in {cold_scan:>8.2?} ({cold_hits} hits)"
        );
        println!(
            "{count:>7} msgs | first flush {first_flush:>8.2?} {} chunks {} KiB | next flush {next_flush:>8.2?} {} chunk {} KiB",
            first.chunks.len(),
            first_bytes / 1024,
            next.chunks.len(),
            next_bytes / 1024,
        );

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
