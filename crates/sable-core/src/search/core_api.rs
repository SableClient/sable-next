use crate::api::search::SearchOrder;
use std::collections::HashSet;
use std::sync::atomic::Ordering;

use crate::tasks::JoinHandleExt;
use futures_util::{StreamExt, stream};
use matrix_sdk::RoomState;
use matrix_sdk::event_cache::RoomEventCacheUpdate;
use matrix_sdk::executor::spawn;
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, OwnedUserId};
use tracing::warn;

use super::ban;
use super::document::room_message;
use super::index::{AttachmentMedia, Hit};
use super::persist;
use super::server;
use super::store::{PageStep, Store};
use super::{
    HYDRATE_CONCURRENCY, INGEST_WAIT, INGEST_WAIT_ATTEMPTS, IndexFilter, PINNED_FETCH_CONCURRENCY,
    ignored_user_ids, ingestable_events,
};
use crate::SignedIn;
use crate::attachments::attachment_contents;
use crate::protocol::{RoomAttachmentKind, RoomAttachmentView};

impl SignedIn {
    pub(crate) async fn search_messages(
        &self,
        query: &str,
        filter: &IndexFilter,
        order: SearchOrder,
        limit: usize,
        offset: usize,
        context: usize,
    ) -> Vec<Hit> {
        let local_ready = self.state().search_index.lock().await.ready();
        if order != SearchOrder::Oldest
            && (!local_ready
                || self
                    .core()
                    .settings
                    .server_search_enabled
                    .load(Ordering::Relaxed))
            && let Some(room_id) = server::target(self.client(), query, filter).await
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

            match self.search_server(target).await {
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

        let session_state = self.state();
        let index = session_state.search_index.lock().await;
        let hits = index
            .search_pinned(query, &filter, pinned, order, limit, offset)
            .await;
        index.fill_context(hits, &filter.not_senders, context).await
    }

    async fn pinned_in_scope(&self, filter: &IndexFilter) -> HashSet<OwnedEventId> {
        let client = self.client();

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
        let client = self.client();

        self.core()
            .with_open_stores(async || ignored_user_ids(client).await)
            .await
    }

    /// Replaces the index with the account's own database, and forgets the rooms left since.
    pub(super) async fn open_search_index(&self, store_id: &str) {
        let client = self.client();
        let session_state = self.state();
        // Opened while the stores are open, so a suspension closes it with them.
        let store = self
            .core()
            .with_open_stores(async || {
                let store = Store::open_account(store_id).await;
                let mut index = session_state.search_index.lock().await;
                // The teardown closed the index under this lock, and nothing would close this one.
                if self.has_ended() {
                    #[cfg(not(target_family = "wasm"))]
                    store.close().await;
                    return None;
                }
                index.replace_store(store.clone());
                Some(store)
            })
            .await;
        let Some(store) = store else {
            return;
        };
        persist::purge_legacy(&store, client, store_id).await;
        let index = session_state.search_index.lock().await;
        for room_id in index.rooms().await {
            if client
                .get_room(&room_id)
                .is_some_and(|room| room.state() != RoomState::Joined)
            {
                index.forget_room(&room_id).await;
                self.state().search_crawl.lock().forget(&room_id);
            }
        }
    }

    pub(crate) fn watch_search_persist(&self) {
        let core = self.clone();

        self.track_session_task(
            spawn(async move {
                loop {
                    let interval = core.state().search_crawl.lock().tuning.flush_interval();
                    matrix_sdk::sleep::sleep(interval).await;
                    core.core().wait_until_active().await;
                    core.core()
                        .with_open_stores(async || core.enforce_disk_budget().await)
                        .await;
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn attachment_page(
        &self,
        room_id: &OwnedRoomId,
        kind: RoomAttachmentKind,
        not_senders: &[OwnedUserId],
        before: Option<(u64, &str)>,
        limit: usize,
    ) -> (Vec<RoomAttachmentView>, Option<(u64, OwnedEventId)>) {
        let mut tried = HashSet::new();
        loop {
            let step = self
                .state()
                .search_index
                .lock()
                .await
                .attachment_page(room_id, kind, not_senders, before, limit, &tried)
                .await;
            match step {
                PageStep::Done(items, next) => return (items, next),
                PageStep::Hydrate(event_ids) => {
                    self.hydrate_media(room_id, &event_ids).await;
                    tried.extend(event_ids);
                }
            }
        }
    }

    async fn hydrate_media(&self, room_id: &OwnedRoomId, event_ids: &[OwnedEventId]) {
        let Some(room) = self.client().get_room(room_id) else {
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

        let session_state = self.state();
        let index = session_state.search_index.lock().await;
        for (event_id, media) in fetched {
            if media.is_empty() {
                continue;
            }
            if let Some(mut document) = index.document(room_id, &event_id).await {
                document.media = media;
                index.put(room_id, document).await;
            }
        }
    }

    pub(crate) async fn prime_persisted_rooms(&self) {
        let client = self.client();
        for room in client.joined_rooms() {
            if self
                .state()
                .search_index
                .lock()
                .await
                .latest_indexed(room.room_id(), &room.latest_event())
                .await
            {
                continue;
            }
            self.index_room_search(&room).await;
        }
    }

    pub(crate) fn watch_ignored_users(&self) {
        let client = self.client();
        let core = self.clone();
        let client = client.clone();
        let mut changes = client.subscribe_to_ignore_user_list_changes();

        self.track_session_task(
            spawn(async move {
                while changes.next().await.is_some() {
                    let mut ignored = core.ignored_senders().await;
                    ignored.sort();
                    core.ignored_users_changed(&ignored).await;
                }
            })
            .abort_on_drop(),
        );
    }

    /// Ignored users are filtered when searching, so the index keeps their
    /// messages. The homeserver withholds what they sent while ignored, so
    /// unignoring makes the crawler walk the rooms again for those.
    pub(super) async fn ignored_users_changed(&self, ignored: &[OwnedUserId]) {
        let store = self.search_store().await;
        if persist::ignored_unchanged(&store, ignored).await {
            return;
        }
        let previous = persist::saved_ignored(&store).await;
        let unignored =
            previous.is_some_and(|previous| previous.iter().any(|user| !ignored.contains(user)));
        if unignored {
            self.state().search_crawl.lock().reset();
            if !persist::forget_crawl(&store).await {
                let _ = persist::forget_crawl(&store).await;
            }
        }
        persist::save_ignored(&store, ignored).await;
    }

    pub(crate) fn watch_search_index(&self, store_id: &str) {
        let client = self.client();
        let core = self.clone();
        let client = client.clone();
        let store_id = store_id.to_owned();

        self.track_session_task(
            spawn(async move {
                let Some(event_cache) = client.event_cache() else {
                    return;
                };
                let mut updates = event_cache.subscribe_to_room_generic_updates();

                #[cfg(not(target_family = "wasm"))]
                persist::remove_dictionary(&core.core().store_id).await;
                // A tab still on an older version keeps the delete blocked until it closes.
                #[cfg(target_family = "wasm")]
                drop(spawn(persist::remove_dictionary()));
                core.open_search_index(&store_id).await;
                core.prime_persisted_rooms().await;

                core.watch_search_crawl();
                core.watch_search_persist();

                loop {
                    let room_id = match updates.recv().await {
                        Ok(update) => update.room_id,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                            warn!(missed, "missed room updates, resweeping the search index");
                            core.prime_persisted_rooms().await;
                            continue;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };

                    let Some(room) = client
                        .get_room(&room_id)
                        .filter(|room| room.state() == RoomState::Joined)
                    else {
                        core.state()
                            .search_index
                            .lock()
                            .await
                            .forget_room(&room_id)
                            .await;
                        core.state().search_crawl.lock().forget(&room_id);
                        core.forget_shared_room(&room_id).await;
                        continue;
                    };

                    core.index_room_search(&room).await;
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
    pub(super) async fn index_room_search(&self, room: &matrix_sdk::Room) {
        let client = self.client();
        use tokio::sync::broadcast::error::TryRecvError;

        let room_id = room.room_id().to_owned();
        for _ in 0..INGEST_WAIT_ATTEMPTS {
            if !self.state().search_crawl.lock().is_ingesting(&room_id) {
                break;
            }
            matrix_sdk::sleep::sleep(INGEST_WAIT).await;
        }
        if self.state().search_crawl.lock().is_ingesting(&room_id) {
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
            let session_state = self.state();
            let index = session_state.search_index.lock().await;
            // Dropping the last SDK subscriber reloads the cache from storage.
            if index.has_room(&room_id).await
                && index.unclassified(&room_id, events).await.is_empty()
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
            let session_state = self.state();
            let index = session_state.search_index.lock().await;
            let total = events.len();
            let fresh = index.unclassified(&room_id, events).await;
            let bans = ban::bans_in(&fresh);
            let detached = if total > 0 && fresh.len() == total {
                let anchor = index.newest_event_in(&room_id).await;
                anchor.zip(
                    fresh
                        .first()
                        .and_then(|event| event.event_id().map(ToOwned::to_owned)),
                )
            } else {
                None
            };
            index.ingest(&room_id, fresh, &cache, &rules).await;
            drop(index);
            if let Some((anchor, until)) = detached {
                self.state()
                    .search_crawl
                    .lock()
                    .open_hole(&room_id, anchor, until);
            }
            self.settle_bans(room, bans).await;
            self.refetch_unedited(room, &cache, &rules).await;

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

    pub(crate) async fn search_store(&self) -> Store {
        self.state().search_store().await
    }

    pub(super) async fn enforce_disk_budget(&self) {
        let evicted = self
            .state()
            .search_index
            .lock()
            .await
            .enforce_disk_budget()
            .await;
        for room_id in evicted {
            self.forget_shared_room(&room_id).await;
        }
    }

    /// Indexes again, from the homeserver, the messages that lost their
    /// document with their latest edit, which it serves with the edit before.
    pub(super) async fn refetch_unedited(
        &self,
        room: &matrix_sdk::Room,
        cache: &matrix_sdk::event_cache::RoomEventCache,
        rules: &RedactionRules,
    ) {
        let messages = self
            .state()
            .search_index
            .lock()
            .await
            .take_unedited(room.room_id());
        for event_id in messages {
            let Ok(event) = room.load_or_fetch_event(&event_id, None).await else {
                continue;
            };
            let ingested = self
                .state()
                .search_index
                .lock()
                .await
                .ingest_with(&room.room_id().to_owned(), vec![event], cache, rules, true)
                .await;
            if let Err(error) = ingested {
                warn!(%event_id, "the search index could not take a message back: {error}");
            }
        }
    }
}

impl crate::SessionState {
    pub(crate) async fn search_store(&self) -> Store {
        self.search_index.lock().await.store().clone()
    }
}
