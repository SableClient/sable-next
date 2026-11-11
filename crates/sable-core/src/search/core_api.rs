use crate::api::search::SearchOrder;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::{StreamExt, stream};
use matrix_sdk::RoomState;
use matrix_sdk::event_cache::RoomEventCacheUpdate;
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, OwnedUserId};
use tracing::warn;

use super::chunks::save_room;
use super::document::{FoldedTerms, room_message};
use super::index::{
    AttachmentMedia, ColdWindow, Hit, MessageIndex, OlderCursor, PageStep, PageWork,
    newest_chunks_within,
};
use super::persist::{self, ChunkId};
use super::server;
use super::{
    COLD_CHUNKS_PER_PAGE, HYDRATE_CONCURRENCY, INGEST_WAIT, INGEST_WAIT_ATTEMPTS, IndexFilter,
    OLDER_PAGE_BUDGET_MS, PINNED_FETCH_CONCURRENCY, dictionary, ignored_user_ids,
    ingestable_events, now_ms, tokenize,
};
use crate::Core;
use crate::attachments::attachment_contents;
use crate::protocol::{RoomAttachmentKind, RoomAttachmentView, RpcCode, RpcError};

impl Core {
    pub(crate) async fn prepare_search_query(&self, query: &str) -> Result<(), RpcError> {
        if tokenize::contains_chinese(query) {
            dictionary::ensure(&self.store_id).await.map_err(|error| {
                crate::errors::coded("search_dictionary", RpcCode::Unavailable, &error)
            })?;
            self.search_index.lock().await.refresh_chinese().await;
        }
        Ok(())
    }

    fn watch_search_dictionary(self: &Arc<Self>) {
        let core = self.clone();
        self.track_session_task(
            spawn(async move {
                loop {
                    let pending = core.search_index.lock().await.chinese_pending();
                    if pending
                        && core.search_crawl_active()
                        && dictionary::ensure(&core.store_id).await.is_ok()
                    {
                        core.search_index.lock().await.refresh_chinese().await;
                    }
                    matrix_sdk::sleep::sleep(Duration::from_secs(10)).await;
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn search_messages(
        &self,
        query: &str,
        filter: &IndexFilter,
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

        let mut index = self.search_index.lock().await;
        let mut hits = index
            .search_pinned(query, &filter, pinned, order, limit, offset)
            .await;
        index.fill_context(&mut hits, &filter.not_senders, context);
        hits
    }

    pub(crate) async fn searches_locally(
        &self,
        query: &str,
        filter: &IndexFilter,
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

    pub(crate) async fn older_start(&self, filter: &IndexFilter) -> Option<String> {
        let index = self.search_index.lock().await;
        (!index.cold_queue(filter).is_empty()).then(String::new)
    }

    pub(crate) async fn search_older(
        &self,
        query: &str,
        filter: &IndexFilter,
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
                after
                    .as_ref()
                    .is_none_or(|after| match OlderCursor::order(after, candidate) {
                        std::cmp::Ordering::Less => true,
                        std::cmp::Ordering::Equal => after.skip > 0,
                        std::cmp::Ordering::Greater => false,
                    })
            });
            let Some(position) = remaining.next() else {
                next = None;
                break;
            };
            let stored = match self
                .with_open_stores(async || {
                    persist::load_chunk(&client, &position.room_id, position.chunk).await
                })
                .await
            {
                persist::ChunkRead::Found(stored) => stored,
                persist::ChunkRead::Missing | persist::ChunkRead::Unreadable => {
                    persist::StoredChunk::new(Vec::new(), Vec::new())
                }
            };
            let skip = after
                .as_ref()
                .filter(|after| OlderCursor::order(after, &position) == std::cmp::Ordering::Equal)
                .map_or(0, |after| after.skip);
            let room = limit.saturating_sub(hits.len()).max(1);
            let (found, total) = self.search_index.lock().await.scan_cold(
                &position.room_id,
                &stored,
                query,
                &filter,
                &terms,
                ColdWindow {
                    skip,
                    take: room,
                    context,
                },
            );
            let consumed = skip + room;
            if consumed < total {
                hits.extend(found);
                next = Some(
                    OlderCursor {
                        skip: consumed,
                        ..position
                    }
                    .encode(),
                );
                break;
            }
            hits.extend(found);
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

    async fn pinned_in_scope(&self, filter: &IndexFilter) -> HashSet<OwnedEventId> {
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

        self.with_open_stores(async || ignored_user_ids(&client).await)
            .await
    }

    pub(crate) async fn restore_persisted_index(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let mut rooms: Vec<OwnedRoomId> = client
            .joined_rooms()
            .iter()
            .map(|room| room.room_id().to_owned())
            .collect();
        for room_id in persist::listed_rooms(client).await {
            if client
                .get_room(&room_id)
                .is_some_and(|room| room.state() != RoomState::Joined)
            {
                let _ = persist::forget(client, &room_id).await;
            } else if !rooms.contains(&room_id) {
                rooms.push(room_id);
            }
        }

        let mut opened = Vec::new();
        for room_id in rooms {
            match persist::open(client, &room_id).await {
                persist::Opened::Manifest(manifest) => {
                    if manifest.derived < persist::DERIVATION {
                        self.search_crawl.lock().await.discard(room_id.clone());
                    }
                    opened.push((room_id, manifest));
                }
                persist::Opened::Legacy(restored) => {
                    self.search_crawl.lock().await.discard(room_id.clone());
                    self.search_index
                        .lock()
                        .await
                        .restore_room_deferred(&room_id, restored)
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
                .restore_room_deferred(
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
                    let interval = core.search_crawl.lock().await.tuning.flush_interval();
                    matrix_sdk::sleep::sleep(interval).await;
                    core.flush_due_search_index(&client).await;
                }
            })
            .abort_on_drop(),
        );
    }

    #[cfg(test)]
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

    pub(super) async fn save_rooms(&self, client: &matrix_sdk::Client, rooms: Vec<OwnedRoomId>) {
        let _flushing = self.search_flush.lock().await;
        save_rooms_of(&self.search_index, client, rooms).await;
        self.enforce_disk_budget(client).await;
    }

    /// Restoring this account must first wait in `settle_retired_search`.
    pub(crate) async fn retire_search_index(
        &self,
        account_id: &str,
        client: &matrix_sdk::Client,
        index: MessageIndex,
    ) {
        let gate = self
            .retiring_search
            .lock()
            .entry(account_id.to_owned())
            .or_default()
            .clone();
        let saving = gate.lock_owned().await;
        let client = client.clone();
        drop(spawn(async move {
            save_index(&client, index).await;
            drop(saving);
        }));
    }

    pub(crate) async fn settle_retired_search(&self, account_id: Option<&str>) {
        let gates: Vec<_> = self
            .retiring_search
            .lock()
            .iter()
            .filter(|(retired, _)| account_id.is_none_or(|account_id| *retired == account_id))
            .map(|(_, gate)| gate.clone())
            .collect();
        for gate in gates {
            drop(gate.lock().await);
        }
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
                Ok(client) => match self
                    .with_open_stores(async || persist::load_chunk(&client, room_id, chunk).await)
                    .await
                {
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
            self.forget_shared_room(client, &room_id).await;
        }
    }

    pub(crate) async fn prime_persisted_rooms(self: &Arc<Self>, client: &matrix_sdk::Client) {
        for room in client.joined_rooms() {
            if self
                .search_index
                .lock()
                .await
                .latest_indexed(room.room_id(), &room.latest_event())
            {
                continue;
            }
            self.index_room_search(client, &room).await;
        }
    }

    pub(crate) fn watch_ignored_users(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let core = self.clone();
        let client = client.clone();
        let mut changes = client.subscribe_to_ignore_user_list_changes();

        self.track_session_task(
            spawn(async move {
                while changes.next().await.is_some() {
                    let mut ignored = core.ignored_senders().await;
                    ignored.sort();
                    if persist::ignored_unchanged(&client, &ignored).await {
                        continue;
                    }
                    *core.search_index.lock().await = MessageIndex::new();
                    core.search_crawl.lock().await.reset();
                    core.server_search.lock().await.reset();
                    core.forget_search_sharing(&client).await;

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
                    persist::save_ignored(&client, &ignored).await;
                }
            })
            .abort_on_drop(),
        );
    }

    #[cfg_attr(
        not(target_family = "wasm"),
        expect(
            unused_variables,
            reason = "only the WASM build reads the index handle"
        )
    )]
    pub(crate) fn watch_search_index(
        self: &Arc<Self>,
        account_id: &str,
        client: &matrix_sdk::Client,
        store_id: &str,
    ) {
        let core = self.clone();
        let client = client.clone();
        let account_id = account_id.to_owned();
        #[cfg(target_family = "wasm")]
        let store_id = store_id.to_owned();

        self.track_session_task(
            spawn(async move {
                let Some(event_cache) = client.event_cache() else {
                    return;
                };
                let mut updates = event_cache.subscribe_to_room_generic_updates();

                core.settle_retired_search(Some(&account_id)).await;
                #[cfg(target_family = "wasm")]
                persist::attach(&client, &store_id).await;
                core.restore_persisted_index(&client).await;
                core.prime_persisted_rooms(&client).await;

                core.watch_search_crawl(&client);
                core.watch_search_persist(&client);
                core.watch_search_dictionary();

                loop {
                    let room_id = match updates.recv().await {
                        Ok(update) => update.room_id,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                            warn!(missed, "missed room updates, resweeping the search index");
                            core.prime_persisted_rooms(&client).await;
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };

                    let Some(room) = client
                        .get_room(&room_id)
                        .filter(|room| room.state() == RoomState::Joined)
                    else {
                        core.search_index.lock().await.forget_room(&room_id);
                        core.search_crawl.lock().await.forget(&room_id);
                        let _ = persist::forget(&client, &room_id).await;
                        core.forget_shared_room(&client, &room_id).await;
                        continue;
                    };

                    core.index_room_search(&client, &room).await;
                }
            })
            .abort_on_drop(),
        );
    }

    #[tracing::instrument(
        skip_all,
        target = "sable_core::tasks",
        name = "search.index_room_search"
    )]
    async fn index_room_search(&self, client: &matrix_sdk::Client, room: &matrix_sdk::Room) {
        use tokio::sync::broadcast::error::TryRecvError;

        let room_id = room.room_id().to_owned();
        for _ in 0..INGEST_WAIT_ATTEMPTS {
            if !self.search_crawl.lock().await.is_ingesting(&room_id) {
                break;
            }
            matrix_sdk::sleep::sleep(INGEST_WAIT).await;
        }
        if self.search_crawl.lock().await.is_ingesting(&room_id) {
            return;
        }
        let Some(event_cache) = client.event_cache() else {
            return;
        };
        let Ok((cache, _drop_handles)) = event_cache.room(&room_id).await else {
            return;
        };
        let Ok(events) = cache.events().await else {
            return;
        };
        {
            let index = self.search_index.lock().await;
            // Dropping the last SDK subscriber reloads the cache from storage.
            if index.rooms.contains_key(&room_id) && index.unclassified(&room_id, events).is_empty()
            {
                return;
            }
        }
        // Pin only while indexing: a permanent subscriber disables SDK cache shrinking.
        let Ok((mut events, mut updates)) = cache.subscribe().await else {
            return;
        };
        let rules = room.clone_info().room_version_rules_or_default().redaction;

        loop {
            let mut index = self.search_index.lock().await;
            let fresh = index.unclassified(&room_id, events);
            index.ingest(&room_id, fresh, &cache, &rules).await;
            drop(index);

            // Include updates that arrived during ingestion before releasing the cache.
            events = loop {
                match updates.try_recv() {
                    Ok(RoomEventCacheUpdate::UpdateTimelineEvents(timeline)) => {
                        break ingestable_events(timeline.diffs);
                    }
                    Ok(_) => {}
                    Err(TryRecvError::Lagged(_)) => match cache.events().await {
                        Ok(events) => break events,
                        Err(error) => {
                            warn!(%room_id, "could not reread the event cache: {error}");
                            return;
                        }
                    },
                    Err(TryRecvError::Empty | TryRecvError::Closed) => return,
                }
            };
        }
    }
}

pub(crate) async fn save_index(client: &matrix_sdk::Client, index: MessageIndex) {
    let index = tokio::sync::Mutex::new(index);
    let dirty = index.lock().await.dirty_rooms();
    save_rooms_of(&index, client, dirty).await;
}

async fn save_rooms_of(
    index: &tokio::sync::Mutex<MessageIndex>,
    client: &matrix_sdk::Client,
    rooms: Vec<OwnedRoomId>,
) {
    for room_id in rooms {
        let Some((flush, revision, listed)) = index.lock().await.take_flush(&room_id) else {
            continue;
        };

        let saved = if listed || persist::list_room(client, &room_id).await {
            save_room(client, &room_id, flush).await
        } else {
            Err(Box::new(flush))
        };
        let mut index = index.lock().await;
        match saved {
            Ok(saved) => index.flushed(&room_id, saved, revision),
            Err(flush) => index.flush_failed(&room_id, &flush),
        }
        index.unload_to_budget();
    }
}
