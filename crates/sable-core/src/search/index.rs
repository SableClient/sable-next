use crate::api::search::SearchOrder;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::time::Duration;

use super::chunks::{Saved, document_bytes, split_chunk};
use super::document::{
    Document, FoldedTerms, adopt_edit, apply_replacement, document_of, edited_document,
    latest_content, poll_start_document, replacement_of, state_document, sticker_document,
};
use super::inverted::InvertedIndex;
use super::persist::{self, ChunkId};
use super::{
    CHANGES_BEFORE_FLUSH, CLASSIFIED_OVERHEAD, DISK_BUDGET, DOCUMENT_OVERHEAD,
    DOCUMENTS_PER_RESTORE_YIELD, EVENTS_PER_INGEST_YIELD, HYDRATE_BATCH, INITIAL_DOCUMENTS,
    IndexFilter, MEMORY_BUDGET, RETIRED_KEYS_BEFORE_VACUUM, TICKS_BEFORE_FLUSH, crawl,
    edited_or_own_event_id, is_redacted, now_ms, redacted_event_id, tokenize,
};
use crate::messages::{raw_content, valid_replacements};
use crate::protocol::{RoomAttachmentContentView, RoomAttachmentKind, RoomAttachmentView};
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::event_cache::RoomEventCache;
use matrix_sdk::latest_events::LatestEventValue;
use matrix_sdk::ruma::events::relation::RelationType;
use matrix_sdk::ruma::events::room::message::SyncRoomMessageEvent;
use matrix_sdk::ruma::events::{
    AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
};
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId, OwnedUserId, RoomId};

type DocKey = u32;

pub(super) struct RoomIndex {
    pub(super) index: InvertedIndex<DocKey>,
    pub(super) documents: HashMap<DocKey, Document>,
    pub(super) key_of: HashMap<OwnedEventId, DocKey>,
    pub(super) classified: HashMap<OwnedEventId, u64>,
    pub(super) edits: HashMap<OwnedEventId, OwnedEventId>,
    pub(super) redacted: HashSet<OwnedEventId>,
    pub(super) by_age: BTreeSet<(u64, DocKey)>,
    pub(super) next_key: DocKey,
    pub(super) retired_keys: usize,
    pub(super) changes: usize,
    pub(super) ticks_since_flush: u32,
    pub(super) dirty: bool,
    pub(super) revision: u64,
    pub(super) durable: u64,
    pub(super) chunks: BTreeMap<u64, ChunkId>,
    pub(super) next_chunk: ChunkId,
    pub(super) dirty_chunks: HashSet<ChunkId>,
    pub(super) stale_chunks: Vec<ChunkId>,
    pub(super) legacy: bool,
    pub(super) listed: bool,
    pub(super) cold: HashSet<ChunkId>,
    pub(super) chunk_meta: HashMap<ChunkId, (usize, usize)>,
    pub(super) bytes: usize,
    pub(super) pending_redactions: HashSet<OwnedEventId>,
    pub(super) pending_replacements: HashMap<OwnedEventId, HashMap<OwnedEventId, TimelineEvent>>,
    pub(super) floor: u64,
    pub(super) rederive_from: u64,
    pub(super) chinese_pending: HashSet<DocKey>,
}

impl RoomIndex {
    pub(super) fn new() -> Self {
        Self::sized(INITIAL_DOCUMENTS)
    }

    fn sized(documents: usize) -> Self {
        Self {
            index: InvertedIndex::with_capacity(documents),
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
            pending_replacements: HashMap::new(),
            floor: 0,
            rederive_from: 0,
            chinese_pending: HashSet::new(),
        }
    }

    #[cfg(test)]
    pub(super) async fn restored(restored: persist::Restored) -> Self {
        Self::restored_with(restored, false).await
    }

    async fn restored_with(restored: persist::Restored, deferred: bool) -> Self {
        let persist::Restored {
            manifest,
            loaded,
            legacy,
        } = restored;
        let stale = manifest.derived < persist::DERIVATION;
        let documents = loaded
            .iter()
            .map(|(_, stored)| stored.documents.len())
            .sum::<usize>();
        let mut index = Self::new();
        index.index.defer(deferred && documents > 0);
        index.next_chunk = manifest.next_chunk;
        index.redacted = manifest.redacted.into_iter().collect();
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
                if document.is_redacted(&index.redacted) {
                    misplaced.insert(chunk);
                    continue;
                }
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

        index.edits.extend(manifest.edits);
        index.pending_redactions = manifest.pending_redactions.into_iter().collect();
        for event in manifest.pending_replacements {
            if let Some(edit) = event.event_id()
                && let Some(target) = index.edits.get(edit)
            {
                index
                    .pending_replacements
                    .entry(target.clone())
                    .or_default()
                    .insert(edit.to_owned(), event);
            }
        }
        index.floor = manifest.floor;
        index.legacy = legacy;
        index.listed = !legacy;
        if legacy {
            misplaced.extend(index.chunks.values().copied());
        }
        index.rederive_from = if stale {
            now_ms().saturating_sub(crawl::CRAWL_MAX_AGE_MS).max(1)
        } else {
            manifest.rederive_from
        };
        index.dirty = stale
            || !misplaced.is_empty()
            || !index.pending_redactions.is_empty()
            || !index.pending_replacements.is_empty();
        index.dirty_chunks = misplaced;
        index.changes = 0;
        index.durable = index.revision;
        index.apply_pending_to_loaded();
        index
    }

    async fn build_index(&mut self) {
        let mut index = InvertedIndex::with_capacity(self.documents.len());
        for (position, (&key, document)) in self.documents.iter().enumerate() {
            if position > 0 && position.is_multiple_of(DOCUMENTS_PER_RESTORE_YIELD) {
                matrix_sdk::sleep::sleep(Duration::ZERO).await;
            }
            index.add_document(key, &document.body);
        }
        self.index = index;
        self.retired_keys = 0;
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
            self.chinese_pending.remove(&key);
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

    pub(super) fn unload(&mut self, chunk: ChunkId) {
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

    pub(super) fn evict_oldest_chunk(&mut self, chunk: ChunkId, next: u64) {
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

    fn disk_bytes(&self) -> u64 {
        self.chunk_meta
            .values()
            .map(|(bytes, _)| *bytes as u64)
            .sum()
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

    pub(super) fn take_flush(&mut self) -> persist::Flush {
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
        let mut classified: HashMap<ChunkId, Vec<(OwnedEventId, u64)>> = HashMap::new();
        for (event_id, &ts) in &self.classified {
            if let Some(chunk) = self.chunk_at(ts)
                && self.dirty_chunks.contains(&chunk)
            {
                classified
                    .entry(chunk)
                    .or_default()
                    .push((event_id.clone(), ts));
            }
        }
        self.dirty_chunks.clear();

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

            for (position, piece_chunk) in
                split_chunk(start, documents, ids).into_iter().enumerate()
            {
                let piece = if position == 0 {
                    chunk
                } else {
                    let piece = self.next_chunk;
                    self.next_chunk = self.next_chunk.wrapping_add(1);
                    self.chunks.insert(piece_chunk.start, piece);
                    piece
                };
                written.push((
                    piece,
                    persist::StoredChunk::new(piece_chunk.documents, piece_chunk.classified),
                ));
            }
        }

        let pending = !self.pending_redactions.is_empty() || !self.pending_replacements.is_empty();
        let manifest = self.manifest();

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

    fn manifest(&self) -> persist::Manifest {
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
        manifest.rederive_from = self.rederive_from;
        manifest.pending_redactions = self.pending_redactions.iter().cloned().collect();
        manifest.pending_replacements = self
            .pending_replacements
            .values()
            .flat_map(|edits| edits.values())
            .cloned()
            .collect();
        manifest.redacted = self.redacted.iter().cloned().collect();
        manifest
    }

    pub(super) fn len(&self) -> usize {
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

    pub(super) fn already_classified(&self, event_id: &EventId) -> bool {
        self.classified.contains_key(event_id)
    }

    pub(super) fn mark_classified(&mut self, event_id: OwnedEventId, ts: u64) {
        if self.classified.insert(event_id, ts).is_none() {
            self.bytes += CLASSIFIED_OVERHEAD;
            self.dirty = true;
            let chunk = self.chunk_for(ts);
            self.dirty_chunks.insert(chunk);
        }
    }

    pub(super) fn document(&self, event_id: &OwnedEventId) -> Option<&Document> {
        let key = self.key_of.get(event_id)?;
        self.documents.get(key)
    }

    pub(super) fn upsert(&mut self, document: Document) {
        if document.is_redacted(&self.redacted) {
            return;
        }
        self.pending_redactions.remove(&document.event_id);
        if let Some(edit) = &document.edit_id {
            self.edits.insert(edit.clone(), document.event_id.clone());
        }
        let chinese_pending =
            !tokenize::chinese_ready() && tokenize::contains_chinese(&document.body);
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
        self.index.add_document(key, &document.body);
        self.key_of.insert(document.event_id.clone(), key);
        if chinese_pending {
            self.chinese_pending.insert(key);
        }
        self.by_age.insert((document.origin_server_ts, key));
        let document = Document { folded, ..document };
        self.bytes += document_bytes(&document);
        self.documents.insert(key, document);
    }

    pub(super) fn remove(&mut self, event_id: &OwnedEventId) {
        self.retire(event_id);
        self.vacuum_if_due();
    }

    pub(super) fn forget_message(&mut self, event_id: &OwnedEventId) {
        let hot = self.is_hot(event_id);
        self.pending_replacements.remove(event_id);
        self.remove(event_id);
        if !hot && self.has_cold() {
            self.pending_redactions.insert(event_id.clone());
            self.dirty = true;
        }
    }

    fn remove_pending_edit(&mut self, edit: &EventId) {
        if let Some(target) = self.edits.get(edit)
            && let Some(edits) = self.pending_replacements.get_mut(target)
        {
            edits.remove(edit);
            if edits.is_empty() {
                self.pending_replacements.remove(target);
            }
        }
    }

    fn apply_pending_to_loaded(&mut self) {
        let targets: Vec<_> = self.pending_replacements.keys().cloned().collect();
        for target in targets {
            if let Some(document) = self.document(&target).cloned() {
                let document = self.apply_pending(document);
                self.upsert(document);
            }
        }
    }

    fn apply_pending(&mut self, mut document: Document) -> Document {
        if document.encrypted.is_none() {
            return document;
        }
        let Some(edits) = self.pending_replacements.remove(&document.event_id) else {
            return document;
        };
        let mut edits: Vec<_> = edits.into_iter().collect();
        edits.sort_by(|(left_id, left), (right_id, right)| {
            left.timestamp_raw()
                .cmp(&right.timestamp_raw())
                .then_with(|| left_id.cmp(right_id))
        });
        for (edit, event) in edits {
            if apply_replacement(&mut document, &event, &self.redacted).is_none() {
                self.edits.remove(&edit);
            }
        }
        document
    }

    fn retire(&mut self, event_id: &OwnedEventId) {
        let Some(key) = self.key_of.remove(event_id) else {
            return;
        };
        self.chinese_pending.remove(&key);
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
        filter: &IndexFilter,
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
            .query(query)
            .into_iter()
            .filter_map(|(key, score)| {
                let document = self.documents.get(&key)?;
                document
                    .matches(filter, terms)
                    .then(|| Ranked::from_document(room_id, document, score))
            })
            .collect()
    }
}

pub(crate) struct MessageIndex {
    pub(super) rooms: HashMap<OwnedRoomId, RoomIndex>,
    pub(super) unreadable: HashSet<OwnedRoomId>,
    pub(super) memory_budget: usize,
    pub(super) disk_budget: u64,
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
    pub(super) fn chinese_pending(&self) -> bool {
        self.rooms
            .values()
            .any(|room| !room.chinese_pending.is_empty())
    }

    pub(super) async fn refresh_chinese(&mut self) {
        if !tokenize::chinese_ready() {
            return;
        }
        for room in self
            .rooms
            .values_mut()
            .filter(|room| !room.chinese_pending.is_empty())
        {
            room.build_index().await;
            room.chinese_pending.clear();
        }
    }

    pub(super) async fn build_indexes(&mut self, filter: &IndexFilter) {
        for (room_id, room) in &mut self.rooms {
            if room.index.is_deferred() && Self::in_scope(filter, room_id) {
                room.build_index().await;
            }
        }
    }

    pub(crate) fn new() -> Self {
        Self::with_budgets(MEMORY_BUDGET, DISK_BUDGET)
    }

    pub(crate) fn set_disk_budget_mb(&mut self, disk_budget_mb: u32) {
        self.disk_budget = u64::from(disk_budget_mb) << 20;
    }

    pub(crate) fn with_budgets(memory_budget: usize, disk_budget: u64) -> Self {
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

    pub(super) fn mark_unreadable(&mut self, room_id: &OwnedRoomId) {
        self.unreadable.insert(room_id.clone());
    }

    #[cfg(test)]
    pub(super) async fn restore_room(
        &mut self,
        room_id: &OwnedRoomId,
        restored: persist::Restored,
    ) {
        let index = RoomIndex::restored(restored).await;
        self.rooms.insert(room_id.clone(), index);
    }

    pub(super) async fn restore_room_deferred(
        &mut self,
        room_id: &OwnedRoomId,
        restored: persist::Restored,
    ) {
        let index = RoomIndex::restored_with(restored, true).await;
        self.rooms.insert(room_id.clone(), index);
    }

    pub(super) fn latest_indexed(&self, room_id: &RoomId, latest: &LatestEventValue) -> bool {
        if let LatestEventValue::Remote(event) = latest
            && is_redacted(event)
        {
            return false;
        }
        latest.event_id().is_some_and(|event_id| {
            self.rooms
                .get(room_id)
                .is_some_and(|index| index.already_classified(&event_id))
        })
    }

    pub(super) fn unclassified(
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
                event.event_id().is_some_and(|event_id| {
                    !index.already_classified(event_id) || is_redacted(event)
                })
            })
            .collect()
    }

    pub(super) fn flush_failed(&mut self, room_id: &OwnedRoomId, flush: &persist::Flush) {
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

    pub(super) fn flushed(&mut self, room_id: &OwnedRoomId, saved: Saved, revision: u64) {
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
        for edit in saved.resolved {
            index.remove_pending_edit(&edit);
        }
        for chunk in saved.merged {
            if !index.dirty_chunks.contains(&chunk) {
                index.drop_range(chunk);
            }
        }
    }

    pub(super) fn dirty_rooms(&self) -> Vec<OwnedRoomId> {
        self.rooms
            .iter()
            .filter(|(room_id, index)| index.dirty && !self.unreadable.contains(*room_id))
            .map(|(room_id, _)| room_id.clone())
            .collect()
    }

    pub(super) fn rooms_due_to_flush(&mut self) -> Vec<OwnedRoomId> {
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

    pub(super) fn take_flush(
        &mut self,
        room_id: &OwnedRoomId,
    ) -> Option<(persist::Flush, u64, bool)> {
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

    pub(super) fn finish_restore(&mut self) {
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

    pub(crate) fn disk(&self) -> u64 {
        self.rooms.values().map(RoomIndex::disk_bytes).sum()
    }

    pub(crate) const fn budgets(&self) -> (usize, u64) {
        (self.memory_budget, self.disk_budget)
    }

    pub(crate) fn is_full(&self) -> bool {
        self.disk() >= self.disk_budget
    }

    pub(super) fn disk_victim(&self) -> Option<(OwnedRoomId, ChunkId, u64)> {
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

    pub(super) fn settled(&self, room_id: &RoomId) -> bool {
        !self.unreadable.contains(room_id)
            && self.rooms.get(room_id).is_some_and(|index| !index.dirty)
    }

    pub(crate) fn floor_of(&self, room_id: &RoomId) -> u64 {
        self.rooms.get(room_id).map_or(0, |index| index.floor)
    }

    pub(super) fn over_memory_budget(&self) -> bool {
        self.memory() > self.memory_budget
    }

    pub(crate) fn newest_in(&self, room_id: &RoomId) -> Option<u64> {
        self.rooms.get(room_id).and_then(RoomIndex::newest_ts)
    }

    pub(super) fn unload_to_budget(&mut self) {
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
        filter: &IndexFilter,
        order: SearchOrder,
        limit: usize,
        offset: usize,
    ) -> Vec<Hit> {
        self.ranked_hits(query, filter, HashSet::new(), order, limit, offset)
    }

    pub(crate) async fn search_pinned(
        &mut self,
        query: &str,
        filter: &IndexFilter,
        pinned: HashSet<OwnedEventId>,
        order: SearchOrder,
        limit: usize,
        offset: usize,
    ) -> Vec<Hit> {
        self.build_indexes(filter).await;
        self.ranked_hits(query, filter, pinned, order, limit, offset)
    }

    fn ranked_hits(
        &self,
        query: &str,
        filter: &IndexFilter,
        pinned: HashSet<OwnedEventId>,
        order: SearchOrder,
        limit: usize,
        offset: usize,
    ) -> Vec<Hit> {
        debug_assert!(
            !self
                .rooms
                .iter()
                .any(|(room_id, room)| room.index.is_deferred() && Self::in_scope(filter, room_id)),
            "a deferred room index must be built before it is searched"
        );
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

    pub(super) fn attachment_page(
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
            let stored = if index.cold.contains(&chunk) {
                let Some(stored) = work.loaded.get(&chunk) else {
                    return PageStep::Need(chunk);
                };
                unindexed_cold_documents(index, stored)
            } else {
                Vec::new()
            };

            let mut unhydrated = Vec::new();
            for document in in_memory.chain(stored.iter()) {
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

    fn in_scope(filter: &IndexFilter, room_id: &RoomId) -> bool {
        (filter.rooms.is_empty() || filter.rooms.iter().any(|wanted| wanted == room_id))
            && !filter.not_rooms.iter().any(|denied| denied == room_id)
    }

    pub(super) fn cold_queue(&self, filter: &IndexFilter) -> Vec<OlderCursor> {
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
                        skip: 0,
                    })
            })
            .collect();
        queue.sort_by(OlderCursor::order);
        queue
    }

    pub(super) fn scan_cold(
        &self,
        room_id: &OwnedRoomId,
        stored: &persist::StoredChunk,
        query: &str,
        filter: &IndexFilter,
        terms: &FoldedTerms,
        window: ColdWindow,
    ) -> (Vec<Hit>, usize) {
        let ColdWindow {
            skip,
            take,
            context,
        } = window;
        let Some(index) = self.rooms.get(room_id) else {
            return (Vec::new(), 0);
        };
        let documents = unindexed_cold_documents(index, stored);
        if documents.is_empty() {
            return (Vec::new(), 0);
        }
        let matched = rank_cold_documents(&documents, query, filter, terms);
        let total = matched.len();
        let hits = matched
            .into_iter()
            .skip(skip)
            .take(take)
            .filter_map(|(position, score)| {
                cold_hit(room_id, &documents, position, score, context, filter)
            })
            .collect();
        (hits, total)
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

    pub(super) fn fill_context(&self, hits: &mut [Hit], not_senders: &[OwnedUserId], lines: usize) {
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

    pub(crate) async fn ingest(
        &mut self,
        room_id: &OwnedRoomId,
        events: Vec<TimelineEvent>,
        cache: &RoomEventCache,
        rules: &RedactionRules,
    ) -> usize {
        self.ingest_with(room_id, events, cache, rules, false).await
    }

    pub(super) async fn import_redactions(
        &mut self,
        room_id: &OwnedRoomId,
        redacted: Vec<OwnedEventId>,
        cache: &RoomEventCache,
    ) {
        let index = self
            .rooms
            .entry(room_id.clone())
            .or_insert_with(RoomIndex::new);
        for event_id in redacted {
            apply_redacted(index, event_id, cache).await;
        }
    }

    pub(super) async fn import(
        &mut self,
        room_id: &OwnedRoomId,
        documents: Vec<Document>,
        classified: Vec<(OwnedEventId, u64)>,
        edits: Vec<(OwnedEventId, OwnedEventId)>,
    ) {
        let index = self
            .rooms
            .entry(room_id.clone())
            .or_insert_with(RoomIndex::new);
        for (event_id, ts) in classified {
            if ts >= index.floor {
                index.mark_classified(event_id, ts);
            }
        }
        for (edit, target) in edits {
            index.edits.entry(edit).or_insert(target);
        }
        for (position, document) in documents.into_iter().enumerate() {
            if position > 0 && position.is_multiple_of(DOCUMENTS_PER_RESTORE_YIELD) {
                matrix_sdk::sleep::sleep(Duration::ZERO).await;
            }
            if document.origin_server_ts < index.floor || document.is_redacted(&index.redacted) {
                continue;
            }
            let existing = index.document(&document.event_id).cloned();
            let document = adopt_edit(document, existing.as_ref(), &index.redacted);
            let document = index.apply_pending(document);
            index.upsert(document);
        }
        self.unload_to_budget();
    }

    pub(super) fn finish_rederive(&mut self, room_id: &OwnedRoomId) {
        if let Some(index) = self.rooms.get_mut(room_id)
            && index.rederive_from != 0
        {
            index.rederive_from = 0;
            index.dirty = true;
        }
    }

    pub(super) async fn ingest_with(
        &mut self,
        room_id: &OwnedRoomId,
        events: Vec<TimelineEvent>,
        cache: &RoomEventCache,
        rules: &RedactionRules,
        rederive: bool,
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

            if is_redacted(&event) {
                if !index.redacted.contains(event_id) {
                    apply_redacted(index, event_id.to_owned(), cache).await;
                    fresh += 1;
                    since_yield += 1;
                }
                continue;
            }

            let rederiving = rederive
                && index.rederive_from != 0
                && event
                    .timestamp_raw()
                    .is_some_and(|ts| u64::from(ts.get()) >= index.rederive_from);
            if index.already_classified(event_id) && !rederiving {
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

            apply_event(index, &event, cache, rules, rederive).await;
        }

        self.unload_to_budget();
        fresh
    }
}

/// Only crawled pages can hold an edit that never passes through this index.
async fn apply_event(
    index: &mut RoomIndex,
    event: &TimelineEvent,
    cache: &RoomEventCache,
    rules: &RedactionRules,
    crawled: bool,
) {
    let message = match event.raw().deserialize() {
        Ok(AnySyncTimelineEvent::MessageLike(message)) => message,
        Ok(AnySyncTimelineEvent::State(state)) => {
            if !index.redacted.contains(state.event_id()) {
                index.upsert(state_document(&state, raw_content(event).as_ref()));
            }
            return;
        }
        Err(_) => return,
    };

    if let Some(document) = poll_start_document(&message) {
        if !index.redacted.contains(&document.event_id) {
            index.upsert(document);
        }
        return;
    }

    if let AnySyncMessageLikeEvent::Sticker(SyncMessageLikeEvent::Original(sticker)) = &message {
        if !index.redacted.contains(&sticker.event_id) {
            index.upsert(sticker_document(sticker));
        }
        return;
    }

    match message {
        AnySyncMessageLikeEvent::RoomMessage(message) => {
            apply_room_message(index, event, &message, cache, crawled).await;
        }
        AnySyncMessageLikeEvent::RoomRedaction(redaction) => {
            if let Some(target) = redacted_event_id(&redaction, rules) {
                apply_redacted(index, target, cache).await;
            }
        }
        _ => {}
    }
}

async fn apply_room_message(
    index: &mut RoomIndex,
    event: &TimelineEvent,
    message: &SyncRoomMessageEvent,
    cache: &RoomEventCache,
    crawled: bool,
) {
    let Some(message) = message.as_original() else {
        return;
    };
    let is_edit = replacement_of(message).is_some();
    let target = edited_or_own_event_id(message);
    if index.redacted.contains(&message.event_id) || index.redacted.contains(&target) {
        return;
    }
    let cached = if is_edit || crawled {
        cache
            .find_event_with_relations(&target, Some(vec![RelationType::Replacement]))
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    let fallback = if is_edit && cached.is_none() {
        cache.find_event(&target).await.ok().flatten()
    } else {
        None
    };
    let original = cached
        .as_ref()
        .map(|(original, _)| original)
        .or(fallback.as_ref());
    if is_edit
        && let Some(original) = original
        && (is_redacted(original)
            || valid_replacements(original, std::slice::from_ref(event))
                .next()
                .is_none())
    {
        return;
    }
    let cached = cached.and_then(|(original, replacements)| {
        edited_document(&original, &replacements, &index.redacted)
    });
    let existing = index.document(&target).cloned();
    let document = if is_edit {
        index.edits.insert(message.event_id.clone(), target.clone());
        index
            .pending_replacements
            .entry(target.clone())
            .or_default()
            .insert(message.event_id.clone(), event.clone());
        index.dirty = true;
        index.revision = index.revision.wrapping_add(1);
        let base = cached
            .map(|document| adopt_edit(document, existing.as_ref(), &index.redacted))
            .or(existing);
        let Some(base) = base else {
            return;
        };
        base
    } else {
        adopt_edit(
            cached.unwrap_or_else(|| {
                document_of(
                    message,
                    raw_content(event).as_ref(),
                    event.encryption_info().is_some(),
                )
            }),
            existing.as_ref(),
            &index.redacted,
        )
    };

    let document = index.apply_pending(document);
    index.upsert(document);
}

async fn apply_redacted(index: &mut RoomIndex, redacted: OwnedEventId, cache: &RoomEventCache) {
    if !index.redacted.insert(redacted.clone()) {
        return;
    }
    index.remove_pending_edit(&redacted);
    index.dirty = true;
    index.revision = index.revision.wrapping_add(1);

    if let Some(target) = index.edits.remove(&redacted) {
        if let Some(document) = latest_content(cache, &target, &index.redacted).await {
            let document = adopt_edit(document, index.document(&target), &index.redacted);
            let document = index.apply_pending(document);
            index.upsert(document);
        } else {
            if index
                .document(&target)
                .is_some_and(|document| !document.is_redacted(&index.redacted))
            {
                return;
            }
            index.remove(&target);
            if index.has_cold() {
                index.pending_redactions.insert(redacted);
            }
            if let Some(ts) = index.classified.remove(&target) {
                index.bytes = index.bytes.saturating_sub(CLASSIFIED_OVERHEAD);
                index.touch(ts);
            }
        }
    } else {
        index.forget_message(&redacted);
        index.edits.retain(|_, target| *target != redacted);
    }
}

fn unindexed_cold_documents(index: &RoomIndex, stored: &persist::StoredChunk) -> Vec<Document> {
    let mut documents: Vec<Document> = stored
        .documents
        .iter()
        .filter(|document| {
            !index.key_of.contains_key(&document.event_id)
                && !index.pending_redactions.contains(&document.event_id)
                && !document.is_redacted(&index.redacted)
        })
        .cloned()
        .collect();
    documents.sort_by(|left, right| {
        left.origin_server_ts
            .cmp(&right.origin_server_ts)
            .then_with(|| left.event_id.cmp(&right.event_id))
    });
    for document in &mut documents {
        if let Some(edits) = index.pending_replacements.get(&document.event_id) {
            for edit in edits.values() {
                let _ = apply_replacement(document, edit, &index.redacted);
            }
        }
        document.folded = document.body.to_lowercase();
    }
    documents
}

fn rank_cold_documents(
    documents: &[Document],
    query: &str,
    filter: &IndexFilter,
    terms: &FoldedTerms,
) -> Vec<(usize, f64)> {
    let mut matched: Vec<(usize, f64)> = if query.is_empty() {
        documents
            .iter()
            .enumerate()
            .filter(|(_, document)| document.matches(filter, terms))
            .map(|(position, _)| (position, 0.0))
            .collect()
    } else {
        let mut scratch = InvertedIndex::with_capacity(documents.len());
        for (position, document) in documents.iter().enumerate() {
            scratch.add_document(position, &document.body);
        }
        scratch
            .query(query)
            .into_iter()
            .filter(|(position, _)| {
                documents
                    .get(*position)
                    .is_some_and(|document| document.matches(filter, terms))
            })
            .collect()
    };

    matched.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                let id =
                    |position: &usize| documents.get(*position).map(|document| &document.event_id);
                id(&left.0).cmp(&id(&right.0))
            })
    });
    matched
}

fn cold_hit(
    room_id: &OwnedRoomId,
    documents: &[Document],
    position: usize,
    score: f64,
    context: usize,
    filter: &IndexFilter,
) -> Option<Hit> {
    let line = |document: &Document| {
        (!document.body.is_empty() && !filter.not_senders.contains(&document.sender)).then(|| {
            ContextLine {
                event_id: document.event_id.clone(),
                body: document.body.clone(),
                sender: document.sender.clone(),
                origin_server_ts: document.origin_server_ts,
            }
        })
    };
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
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct OlderCursor {
    pub(super) start: u64,
    pub(super) room_id: OwnedRoomId,
    pub(super) chunk: ChunkId,
    pub(super) skip: usize,
}

impl OlderCursor {
    pub(super) fn order(left: &Self, right: &Self) -> std::cmp::Ordering {
        right
            .start
            .cmp(&left.start)
            .then_with(|| left.room_id.cmp(&right.room_id))
            .then_with(|| left.chunk.cmp(&right.chunk))
    }

    pub(super) fn encode(&self) -> String {
        format!(
            "{}:{}:{}:{}",
            self.start, self.chunk, self.skip, self.room_id
        )
    }

    pub(super) fn decode(cursor: &str) -> Option<Self> {
        let mut parts = cursor.splitn(4, ':');
        let start = parts.next()?.parse().ok()?;
        let chunk = parts.next()?.parse().ok()?;
        let skip = parts.next()?.parse().ok()?;
        let room_id = OwnedRoomId::try_from(parts.next()?).ok()?;
        Some(Self {
            start,
            room_id,
            chunk,
            skip,
        })
    }
}

#[derive(Clone, Copy)]
pub(super) struct ColdWindow {
    pub(super) skip: usize,
    pub(super) take: usize,
    pub(super) context: usize,
}

impl ColdWindow {
    #[cfg(test)]
    pub(super) const fn all(context: usize) -> Self {
        Self {
            skip: 0,
            take: usize::MAX,
            context,
        }
    }
}

#[derive(Default)]
pub(super) struct PageWork {
    pub(super) loaded: HashMap<ChunkId, persist::StoredChunk>,
    pub(super) tried: HashSet<OwnedEventId>,
}

pub(super) type AttachmentMedia = Vec<(Option<u32>, RoomAttachmentContentView)>;

pub(super) enum PageStep {
    Done(Vec<RoomAttachmentView>, Option<(u64, OwnedEventId)>),
    Need(ChunkId),
    Hydrate(Vec<OwnedEventId>),
}

pub(super) fn newest_chunks_within(
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

#[cfg(test)]
mod tests {
    use super::MessageIndex;
    use crate::protocol::SearchAttachment;
    use crate::search::tests::{
        attachment_pages, attachment_pages_with, budgeted_room, document, filtered_index, found,
        in_room, picture, seed_room,
    };
    use matrix_sdk::ruma::event_id;

    #[test]
    fn test_from_narrows_to_one_sender() {
        let (index, _room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::IndexFilter {
                senders: vec![matrix_sdk::ruma::user_id!("@alice:localhost").to_owned()],
                ..super::IndexFilter::default()
            },
        );

        assert_eq!(hits.len(), 2);
        assert!(!hits.contains(&"$kris".to_owned()));
    }

    #[test]
    fn test_mentions_matches_only_messages_pinging_the_user() {
        let (index, _room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::IndexFilter {
                mentions: vec![matrix_sdk::ruma::user_id!("@kris:localhost").to_owned()],
                ..super::IndexFilter::default()
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
                &super::IndexFilter {
                    has: vec![SearchAttachment::Image],
                    ..super::IndexFilter::default()
                }
            ),
            vec!["$screenshot"]
        );
        assert_eq!(
            found(
                &index,
                "deploy",
                &super::IndexFilter {
                    has: vec![SearchAttachment::Link],
                    ..super::IndexFilter::default()
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
            &super::IndexFilter {
                after_ts: Some(2_000),
                before_ts: Some(3_000),
                ..super::IndexFilter::default()
            },
        );

        assert_eq!(hits.len(), 2);
        assert!(!hits.contains(&"$kris".to_owned()));
    }

    #[test]
    fn test_a_quoted_phrase_must_appear_verbatim() {
        let (index, _room) = filtered_index();

        assert_eq!(
            found(
                &index,
                "deploy",
                &super::IndexFilter {
                    phrases: vec!["pipeline is broken".to_owned()],
                    ..super::IndexFilter::default()
                }
            ),
            vec!["$kris"]
        );
    }

    #[test]
    fn test_an_excluded_term_removes_matches() {
        let (index, _room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::IndexFilter {
                exclude: vec!["screenshot".to_owned()],
                ..super::IndexFilter::default()
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
                &super::IndexFilter::default(),
                super::SearchOrder::Recent,
                20,
                0,
            )
            .into_iter()
            .map(|hit| hit.event_id.to_string())
            .collect();

        assert_eq!(hits, vec!["$screenshot", "$alice", "$kris"]);
    }

    #[test]
    fn test_an_empty_query_with_filters_still_lists_messages() {
        let (index, _room) = filtered_index();

        let hits = found(
            &index,
            "",
            &super::IndexFilter {
                senders: vec![matrix_sdk::ruma::user_id!("@alice:localhost").to_owned()],
                ..super::IndexFilter::default()
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
                "@kris:localhost",
                4_000,
                None,
                Vec::new(),
            ));

        let hits = found(
            &index,
            "deploy",
            &super::IndexFilter {
                rooms: vec![room],
                ..super::IndexFilter::default()
            },
        );

        assert!(!hits.contains(&"$elsewhere".to_owned()));
        assert_eq!(hits.len(), 3);
    }

    #[test]
    fn test_pinned_keeps_or_drops_the_pinned_events() {
        let (index, _room) = filtered_index();
        let pinned: std::collections::HashSet<_> =
            [event_id!("$alice").to_owned()].into_iter().collect();

        let search = |wanted| {
            index
                .ranked_hits(
                    "deploy",
                    &super::IndexFilter {
                        pinned: Some(wanted),
                        ..super::IndexFilter::default()
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
        assert_eq!(search(false), vec!["$screenshot", "$kris"]);
    }

    #[test]
    fn test_oldest_orders_hits_by_ascending_time() {
        let (index, _room) = filtered_index();

        let hits: Vec<String> = index
            .search(
                "deploy",
                &super::IndexFilter::default(),
                super::SearchOrder::Oldest,
                10,
                0,
            )
            .into_iter()
            .map(|hit| hit.event_id.to_string())
            .collect();

        assert_eq!(hits, vec!["$kris", "$alice", "$screenshot"]);
    }

    #[test]
    fn test_a_denied_sender_is_dropped_by_identity() {
        let (index, room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::IndexFilter {
                rooms: vec![room],
                not_senders: vec![matrix_sdk::ruma::user_id!("@alice:localhost").to_owned()],
                ..super::IndexFilter::default()
            },
        );

        assert_eq!(hits, vec!["$kris".to_owned()]);
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
                crate::protocol::RoomAttachmentContentView::File {
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
                Some(SearchAttachment::File),
                Vec::new(),
            )
        });
        let filter = |filter: super::IndexFilter| {
            found(
                &index,
                "deploy",
                &super::IndexFilter {
                    rooms: vec![room.clone()],
                    ..filter
                },
            )
        };

        let plain = filter(super::IndexFilter::default());
        assert!(!plain.contains(&"$renamed".to_owned()));
        assert_eq!(
            filter(super::IndexFilter {
                state_events: Some(true),
                ..super::IndexFilter::default()
            }),
            vec!["$renamed".to_owned()]
        );
        assert_eq!(
            filter(super::IndexFilter {
                file_types: vec!["PDF".to_owned()],
                ..super::IndexFilter::default()
            }),
            vec!["$notes".to_owned()]
        );
        assert!(
            filter(super::IndexFilter {
                pattern: Some(r"pipe\w+ is".to_owned()),
                ..super::IndexFilter::default()
            })
            .contains(&"$kris".to_owned())
        );
        assert_eq!(
            filter(super::IndexFilter {
                pattern: Some("(unclosed".to_owned()),
                ..super::IndexFilter::default()
            }),
            [] as [String; 0]
        );
    }

    #[test]
    fn test_a_denied_attachment_is_dropped_by_kind() {
        let (index, room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::IndexFilter {
                rooms: vec![room],
                not_has: vec![SearchAttachment::Image],
                ..super::IndexFilter::default()
            },
        );

        assert!(!hits.contains(&"$screenshot".to_owned()));
        assert!(hits.contains(&"$kris".to_owned()));
    }

    #[test]
    fn test_a_denied_mention_is_dropped_by_identity() {
        let (index, room) = filtered_index();

        let hits = found(
            &index,
            "deploy",
            &super::IndexFilter {
                rooms: vec![room],
                not_mentions: vec![matrix_sdk::ruma::user_id!("@kris:localhost").to_owned()],
                ..super::IndexFilter::default()
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
                "@kris:localhost",
                4_000,
                None,
                Vec::new(),
            ));

        let hits = found(
            &index,
            "deploy",
            &super::IndexFilter {
                not_rooms: vec![other],
                ..super::IndexFilter::default()
            },
        );

        assert!(!hits.contains(&"$elsewhere".to_owned()));
        assert!(hits.contains(&"$kris".to_owned()));
        drop(room);
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
            room_index.upsert(picture(seed, "@kris:localhost", ts));
        }
        room_index.upsert(document(
            "text",
            "no picture here",
            "@kris:localhost",
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
            room_index.upsert(picture(&format!("p{seed}"), "@kris:localhost", seed));
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
        room_index.upsert(picture("kept", "@kris:localhost", 2));
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

    #[test]
    fn test_the_memory_budget_unloads_the_oldest_chunk_and_keeps_it_on_disk() {
        let room = matrix_sdk::ruma::RoomId::parse("!budget:localhost").expect("room id");
        let room_index = budgeted_room(5_000, 0);
        let full = room_index.bytes;
        let mut index = MessageIndex::with_budgets(full / 2, u64::MAX);
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
        let mut index = MessageIndex::with_budgets(budget, u64::MAX);
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
        let mut index = MessageIndex::with_budgets(1, u64::MAX);
        index.rooms.insert(room, room_index);

        index.unload_to_budget();

        assert_eq!(index.documents(), 3_000);
    }

    #[test]
    fn test_four_gib_disk_budget_and_totals() {
        let room = matrix_sdk::ruma::RoomId::parse("!large:localhost").expect("room id");
        let mut room_index = super::RoomIndex::new();
        // Each chunk fits in 32 bits; the total must also work on wasm32.
        room_index.chunk_meta.insert(0, (2_147_483_648, 1));
        room_index.chunk_meta.insert(1, (2_147_483_648, 1));
        let mut index = MessageIndex::new();
        index.set_disk_budget_mb(4096);
        assert_eq!(index.budgets().1, 4_294_967_296);
        assert!(!index.is_full());
        index.rooms.insert(room, room_index);
        assert_eq!(index.disk(), 4_294_967_296);
        assert!(index.is_full());
        assert!(index.disk_victim().is_none());
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
}
