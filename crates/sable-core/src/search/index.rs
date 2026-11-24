use crate::api::search::SearchOrder;
use std::collections::HashSet;
use std::time::Duration;

use super::apply::{self, Item, Latest, Planned};
use super::document::{Document, latest_content};
#[cfg(test)]
use super::store::RoomTx;
use super::store::{PageStep, Removal, Result, Stats, Store};
use super::{DISK_BUDGET, INGEST_CHUNK, IndexFilter, is_redacted};
use crate::protocol::RoomAttachmentKind;
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::event_cache::RoomEventCache;
use matrix_sdk::latest_events::LatestEventValue;
#[cfg(test)]
use matrix_sdk::ruma::EventId;
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, OwnedUserId, RoomId};
use tracing::warn;

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

pub(super) type AttachmentMedia = Vec<(Option<u32>, crate::protocol::RoomAttachmentContentView)>;

pub(crate) struct MessageIndex {
    store: Store,
    disk_budget: u64,
    unedited: parking_lot::Mutex<Vec<(OwnedRoomId, OwnedEventId)>>,
}

impl MessageIndex {
    /// An index that lives only as long as this value, until an account's own
    /// database replaces it.
    pub(crate) fn new() -> Self {
        Self::with_store(Store::memory())
    }

    pub(crate) const fn with_store(store: Store) -> Self {
        Self {
            store,
            disk_budget: DISK_BUDGET,
            unedited: parking_lot::Mutex::new(Vec::new()),
        }
    }

    pub(super) fn replace_store(&mut self, store: Store) {
        self.store = store;
    }

    pub(crate) fn set_disk_budget_mb(&mut self, disk_budget_mb: u32) {
        self.disk_budget = u64::from(disk_budget_mb) << 20;
    }

    pub(crate) const fn disk_budget(&self) -> u64 {
        self.disk_budget
    }

    pub(super) const fn store(&self) -> &Store {
        &self.store
    }

    /// Whether the database can be reached. The web has none until a worker is attached.
    pub(crate) fn ready(&self) -> bool {
        self.store.ready()
    }

    /// Reports a failed database call to the log, unless the database is not there yet.
    fn ok<R>(&self, what: &'static str, result: Result<R>) -> Option<R> {
        match result {
            Ok(result) => Some(result),
            Err(error) => {
                if self.ready() {
                    warn!("search index {what} failed: {error}");
                }
                None
            }
        }
    }

    pub(crate) async fn forget_room(&self, room_id: &OwnedRoomId) {
        self.ok("room removal", self.store.forget_room(room_id).await);
        self.ok("room removal", self.store.forget_removals(room_id).await);
    }

    pub(super) async fn has_room(&self, room_id: &RoomId) -> bool {
        self.ok("lookup", self.store.has_room(room_id).await)
            .unwrap_or(false)
    }

    pub(super) async fn rooms(&self) -> Vec<OwnedRoomId> {
        self.ok("room listing", self.store.rooms().await)
            .unwrap_or_default()
    }

    pub(super) async fn latest_indexed(&self, room_id: &RoomId, latest: &LatestEventValue) -> bool {
        if let LatestEventValue::Remote(event) = latest
            && is_redacted(event)
        {
            return false;
        }
        let Some(event_id) = latest.event_id() else {
            return false;
        };
        self.ok(
            "lookup",
            self.store.is_classified(room_id, event_id.as_str()).await,
        )
        .unwrap_or(false)
    }

    pub(super) async fn unclassified(
        &self,
        room_id: &OwnedRoomId,
        events: Vec<TimelineEvent>,
    ) -> Vec<TimelineEvent> {
        let ids: Vec<String> = events
            .iter()
            .filter_map(|event| event.event_id().map(ToString::to_string))
            .collect();
        let Some(known) = self.ok("lookup", self.store.classified_among(room_id, &ids).await)
        else {
            return events;
        };
        events
            .into_iter()
            .filter(|event| {
                event
                    .event_id()
                    .is_some_and(|event_id| !known.contains(event_id) || is_redacted(event))
            })
            .collect()
    }

    pub(crate) async fn documents(&self) -> usize {
        self.ok("count", self.store.documents().await)
            .unwrap_or_default()
    }

    pub(crate) async fn disk(&self) -> u64 {
        self.ok("sizing", self.store.used_bytes().await)
            .unwrap_or_default()
    }

    pub(super) async fn stats(&self) -> Option<Stats> {
        self.ok("statistics", self.store.stats().await)
    }

    pub(crate) async fn is_full(&self) -> bool {
        self.disk().await >= self.disk_budget
    }

    /// Deletes the oldest documents while the database exceeds its budget, and
    /// returns the rooms that lost some.
    pub(super) async fn enforce_disk_budget(&self) -> Vec<OwnedRoomId> {
        self.ok("eviction", self.store.evict_to(self.disk_budget).await)
            .unwrap_or_default()
    }

    pub(crate) async fn floor_of(&self, room_id: &RoomId) -> u64 {
        self.ok("lookup", self.store.floor(room_id).await)
            .unwrap_or_default()
    }

    pub(super) async fn newest_event_in(&self, room_id: &RoomId) -> Option<OwnedEventId> {
        self.ok("lookup", self.store.newest_event(room_id).await)
            .flatten()
    }

    pub(crate) async fn newest_in(&self, room_id: &RoomId) -> Option<u64> {
        self.ok("lookup", self.store.newest(room_id).await)
            .flatten()
    }

    pub(crate) async fn search_pinned(
        &self,
        query: &str,
        filter: &IndexFilter,
        pinned: HashSet<OwnedEventId>,
        order: SearchOrder,
        limit: usize,
        offset: usize,
    ) -> Vec<Hit> {
        self.ok(
            "search",
            self.store
                .search(query, filter, pinned, order, limit, offset)
                .await,
        )
        .unwrap_or_default()
    }

    pub(super) async fn fill_context(
        &self,
        hits: Vec<Hit>,
        not_senders: &[OwnedUserId],
        lines: usize,
    ) -> Vec<Hit> {
        self.ok(
            "context lookup",
            self.store.fill_context(hits, not_senders, lines).await,
        )
        .unwrap_or_default()
    }

    pub(super) async fn attachment_page(
        &self,
        room_id: &RoomId,
        kind: RoomAttachmentKind,
        not_senders: &[OwnedUserId],
        before: Option<(u64, &str)>,
        limit: usize,
        tried: &HashSet<OwnedEventId>,
    ) -> PageStep {
        self.ok(
            "attachment listing",
            self.store
                .attachment_page(room_id, kind, not_senders, before, limit, tried)
                .await,
        )
        .unwrap_or(PageStep::Done(Vec::new(), None))
    }

    /// Stores `document` in place of the one with its event id.
    pub(super) async fn put(&self, room_id: &RoomId, document: Document) {
        let stored = async {
            let mut tx = self.store.room(room_id).await?;
            tx.upsert(&document).await?;
            tx.commit().await
        }
        .await;
        self.ok("update", stored);
    }

    pub(super) async fn document(
        &self,
        room_id: &RoomId,
        event_id: &OwnedEventId,
    ) -> Option<Document> {
        let found = async { self.store.room(room_id).await?.document(event_id).await }.await;
        self.ok("lookup", found).flatten()
    }

    /// A failure is only logged: the events stay unclassified, so the next
    /// update of the room brings them back.
    pub(crate) async fn ingest(
        &self,
        room_id: &OwnedRoomId,
        events: Vec<TimelineEvent>,
        cache: &RoomEventCache,
        rules: &RedactionRules,
    ) -> usize {
        let ingested = self.ingest_with(room_id, events, cache, rules, false).await;
        self.ok("ingest", ingested).unwrap_or_default()
    }

    pub(super) async fn ingest_with(
        &self,
        room_id: &OwnedRoomId,
        events: Vec<TimelineEvent>,
        cache: &RoomEventCache,
        rules: &RedactionRules,
        crawled: bool,
    ) -> Result<usize> {
        let mut fresh = 0;
        let mut events = events.into_iter();
        loop {
            let chunk: Vec<TimelineEvent> = events.by_ref().take(INGEST_CHUNK).collect();
            if chunk.is_empty() {
                return Ok(fresh);
            }
            fresh += self
                .ingest_chunk(room_id, chunk, cache, rules, crawled)
                .await?;
            matrix_sdk::sleep::sleep(Duration::ZERO).await;
        }
    }

    async fn ingest_chunk(
        &self,
        room_id: &OwnedRoomId,
        chunk: Vec<TimelineEvent>,
        cache: &RoomEventCache,
        rules: &RedactionRules,
        crawled: bool,
    ) -> Result<usize> {
        let ids: Vec<String> = chunk
            .iter()
            .filter_map(|event| event.event_id().map(ToString::to_string))
            .collect();
        let mut known = self.store.classified_among(room_id, &ids).await?;
        let removals = self.store.removals(room_id).await?;
        let (floor, mut redacted) = {
            let mut tx = self.store.room(room_id).await?;
            (tx.floor().await?, tx.redacted.clone())
        };

        let mut fresh = 0;
        let mut batch: Vec<Item> = Vec::new();
        for event in &chunk {
            let Some(event_id) = event.event_id().map(ToOwned::to_owned) else {
                continue;
            };

            if is_redacted(event) {
                if redacted.insert(event_id.clone()) {
                    self.write_items(room_id, std::mem::take(&mut batch))
                        .await?;
                    self.apply_redaction(room_id, Some(cache), None, event_id)
                        .await?;
                    fresh += 1;
                }
                continue;
            }

            if known.contains(&event_id) {
                continue;
            }
            fresh += 1;

            if event.kind.is_utd() {
                continue;
            }
            let ts = event.timestamp_raw().map_or(0, |ts| ts.get().into());
            if ts < floor || removed_by_ban(event, ts, &removals) {
                continue;
            }
            known.insert(event_id.clone());

            match apply::plan(event, event_id, ts, cache, rules, crawled).await {
                Planned::Item(item) => batch.push(*item),
                Planned::Redaction(redaction) => {
                    self.write_items(room_id, std::mem::take(&mut batch))
                        .await?;
                    self.apply_redaction(
                        room_id,
                        Some(cache),
                        redaction.classify,
                        redaction.target,
                    )
                    .await?;
                }
            }
        }
        self.write_items(room_id, batch).await?;
        Ok(fresh)
    }

    async fn write_items(&self, room_id: &OwnedRoomId, items: Vec<Item>) -> Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        let mut tx = self.store.room(room_id).await?;
        for item in items {
            if let Some(uid) = item.calendar_uid() {
                match tx
                    .replace_calendar_version(uid, &item.event_id, item.ts)
                    .await?
                {
                    None => continue,
                    Some(Some(older)) => tx.remove(&older),
                    Some(None) => {}
                }
            }
            apply::apply(&mut tx, item).await?;
        }
        tx.commit().await
    }

    /// Without `cache`, an edit that is redacted is taken for a redacted message.
    async fn apply_redaction(
        &self,
        room_id: &OwnedRoomId,
        cache: Option<&RoomEventCache>,
        classify: Option<(OwnedEventId, u64)>,
        target: OwnedEventId,
    ) -> Result<()> {
        let mut tx = self.store.room(room_id).await?;
        let latest = match (cache, tx.edit_target(&target).await?) {
            (Some(cache), Some(edited)) => {
                let mut redacted = tx.redacted.clone();
                redacted.insert(target.clone());
                latest_content(cache, &edited, &redacted)
                    .await
                    .map_or(Latest::Gone, |document| Latest::Content(Box::new(document)))
            }
            _ => Latest::Unasked,
        };
        let unedited = apply::apply_redacted(&mut tx, &target, latest).await?;
        if let Some((event_id, ts)) = &classify {
            tx.mark_classified(event_id, *ts);
        }
        tx.commit().await?;
        if let Some(message) = unedited {
            self.unedited.lock().push((room_id.clone(), message));
        }
        Ok(())
    }

    /// The messages whose latest edit was redacted and which now have no
    /// document, for the homeserver to be asked what they said before.
    pub(super) fn take_unedited(&self, room_id: &RoomId) -> Vec<OwnedEventId> {
        let mut unedited = self.unedited.lock();
        let (these, others) = std::mem::take(&mut *unedited)
            .into_iter()
            .partition(|(room, _)| room == room_id);
        *unedited = others;
        these.into_iter().map(|(_, message)| message).collect()
    }

    pub(super) async fn import_redactions(
        &self,
        room_id: &OwnedRoomId,
        redacted: Vec<OwnedEventId>,
        cache: Option<&RoomEventCache>,
    ) {
        for event_id in redacted {
            let applied = self.apply_redaction(room_id, cache, None, event_id).await;
            self.ok("redaction", applied);
        }
    }

    pub(super) async fn import(
        &self,
        room_id: &OwnedRoomId,
        documents: Vec<Document>,
        classified: Vec<(OwnedEventId, u64)>,
        edits: Vec<(OwnedEventId, OwnedEventId)>,
    ) {
        let imported = async {
            self.store
                .room(room_id)
                .await?
                .import(documents, classified, edits)
                .await
        }
        .await;
        self.ok("import", imported);
    }
}

fn removed_by_ban(event: &TimelineEvent, ts: u64, removals: &[Removal]) -> bool {
    !removals.is_empty()
        && event
            .raw()
            .get_field::<serde_json::Value>("state_key")
            .ok()
            .flatten()
            .is_none()
        && event
            .raw()
            .get_field::<OwnedUserId>("sender")
            .ok()
            .flatten()
            .is_some_and(|sender| removals.iter().any(|removal| removal.covers(&sender, ts)))
}

#[cfg(test)]
impl MessageIndex {
    pub(super) fn search(
        &self,
        query: &str,
        filter: &IndexFilter,
        order: SearchOrder,
        limit: usize,
        offset: usize,
    ) -> Vec<Hit> {
        self.search_pinned_sync(query, filter, HashSet::new(), order, limit, offset)
    }

    pub(super) fn search_pinned_sync(
        &self,
        query: &str,
        filter: &IndexFilter,
        pinned: HashSet<OwnedEventId>,
        order: SearchOrder,
        limit: usize,
        offset: usize,
    ) -> Vec<Hit> {
        super::exec::block_on(
            self.store
                .search(query, filter, pinned, order, limit, offset),
        )
        .expect("search")
    }

    pub(super) fn attachment_step(
        &self,
        room_id: &RoomId,
        kind: RoomAttachmentKind,
        not_senders: &[OwnedUserId],
        before: Option<(u64, &str)>,
        limit: usize,
    ) -> PageStep {
        super::exec::block_on(self.store.attachment_page(
            room_id,
            kind,
            not_senders,
            before,
            limit,
            &HashSet::new(),
        ))
        .expect("attachment page")
    }

    pub(super) fn context(&self, hits: &mut Vec<Hit>, not_senders: &[OwnedUserId], lines: usize) {
        *hits = super::exec::block_on(self.store.fill_context(
            std::mem::take(hits),
            not_senders,
            lines,
        ))
        .expect("context");
    }

    pub(super) fn upsert(&self, room_id: &RoomId, document: Document) {
        self.with_room(room_id, async move |tx| tx.upsert(&document).await);
    }

    pub(super) fn len(&self) -> usize {
        super::exec::block_on(self.store.documents()).expect("count")
    }

    fn with_room<R>(
        &self,
        room_id: &RoomId,
        work: impl AsyncFnOnce(&mut RoomTx<'_>) -> Result<R>,
    ) -> R {
        super::exec::block_on(async {
            let mut tx = self.store.room(room_id).await?;
            let result = work(&mut tx).await?;
            tx.commit().await?;
            Ok::<_, super::exec::SqlError>(result)
        })
        .expect("room work")
    }

    pub(super) fn ensure_room(&self, room_id: &RoomId) {
        self.with_room(room_id, async |_| Ok(()));
    }

    pub(super) fn mark_classified(&self, room_id: &RoomId, event_id: &EventId, ts: u64) {
        self.with_room(room_id, async |tx| {
            tx.mark_classified(event_id, ts);
            Ok(())
        });
    }

    pub(super) fn remove(&self, room_id: &RoomId, event_id: &EventId) {
        self.with_room(room_id, async |tx| {
            tx.remove(event_id);
            Ok(())
        });
    }
}
