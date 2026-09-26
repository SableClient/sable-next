use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::api::error::{ErrorKind, RetryAfter};
use matrix_sdk::ruma::{MilliSecondsSinceUnixEpoch, OwnedRoomId, RoomId, UInt};
use matrix_sdk::{EncryptionState, Room, RoomState};
use tracing::warn;

use super::persist::{self, StoredCrawlRoom};
use crate::Core;
use crate::protocol::{
    CoreEvent, SearchCoverageState, SearchCoverageView, SearchCrawlPhase, SearchMetricsView,
};

const CRAWL_BATCH: u16 = 100;
const CRAWL_PAUSE: Duration = Duration::from_secs(3);
const CRAWL_READABLE_PAUSE: Duration = Duration::from_millis(500);
const CRAWL_IDLE: Duration = Duration::from_secs(30);
const CRAWL_BASE_EVENTS: usize = 20_000;
const MAX_CRAWLED_EVENTS: usize = 200_000;
const CRAWL_TRICKLE_PAUSE: Duration = Duration::from_secs(5);
const BLIND_EVENTS_BEFORE_SKIP: usize = 200;
const CRAWL_BACKOFF_CAP: Duration = Duration::from_mins(5);
const PUSHBACKS_BEFORE_SKIP: u32 = 5;

enum Pushback {
    Transient(Option<Duration>),
    Permanent,
}

fn pushback(error: &matrix_sdk::Error) -> Pushback {
    let Some(api) = error.as_client_api_error() else {
        return Pushback::Transient(None);
    };
    if let Some(ErrorKind::LimitExceeded(limit)) = api.error_kind() {
        return Pushback::Transient(match limit.retry_after {
            Some(RetryAfter::Delay(delay)) => Some(delay),
            _ => None,
        });
    }
    if api.status_code.as_u16() == 429 || api.status_code.is_server_error() {
        return Pushback::Transient(None);
    }
    Pushback::Permanent
}

#[derive(Default)]
pub(crate) struct CrawlProgress {
    reached_start: HashSet<OwnedRoomId>,
    exhausted: HashSet<OwnedRoomId>,
    failed: HashSet<OwnedRoomId>,
    ingesting: Option<OwnedRoomId>,
    visits: HashMap<OwnedRoomId, usize>,
    tokens: HashMap<OwnedRoomId, Option<String>>,
    probed: HashSet<OwnedRoomId>,
    blind: HashMap<OwnedRoomId, usize>,
    stalled: HashMap<OwnedRoomId, u32>,
    discarded: HashSet<OwnedRoomId>,
    awaiting: HashMap<OwnedRoomId, u64>,
    saved: BTreeMap<OwnedRoomId, StoredCrawlRoom>,
    events: usize,
    changed: bool,
    metrics: CrawlMetrics,
}

#[derive(Default)]
struct CrawlMetrics {
    phase: SearchCrawlPhase,
    started_ms: Option<u64>,
    batches: u64,
    pushbacks: u64,
    request_ms_total: u64,
    last_request_ms: Option<u64>,
}

impl CrawlMetrics {
    const fn request(&mut self, elapsed_ms: u64) {
        self.batches = self.batches.saturating_add(1);
        self.request_ms_total = self.request_ms_total.saturating_add(elapsed_ms);
        self.last_request_ms = Some(elapsed_ms);
    }

    const fn average_request_ms(&self) -> Option<u64> {
        self.request_ms_total.checked_div(self.batches)
    }
}

fn now_ms() -> u64 {
    MilliSecondsSinceUnixEpoch::now().get().into()
}

impl CrawlProgress {
    fn skips(&self, room_id: &RoomId) -> bool {
        self.reached_start.contains(room_id) || self.failed.contains(room_id)
    }

    const fn spent(&self) -> bool {
        self.events >= MAX_CRAWLED_EVENTS
    }

    const fn trickling(&self) -> bool {
        self.events >= CRAWL_BASE_EVENTS
    }

    fn paced(&self, pause: Duration) -> Duration {
        if self.trickling() {
            pause.max(CRAWL_TRICKLE_PAUSE)
        } else {
            pause
        }
    }

    pub(crate) fn is_ingesting(&self, room_id: &OwnedRoomId) -> bool {
        self.ingesting.as_ref() == Some(room_id)
    }

    fn visit(&mut self, room_id: &OwnedRoomId) {
        *self.visits.entry(room_id.clone()).or_default() += 1;
    }

    pub(super) fn settle(&mut self, room_id: OwnedRoomId, exhausted: bool) {
        self.changed = true;
        self.tokens.remove(&room_id);
        if exhausted {
            self.exhausted.insert(room_id.clone());
        }
        self.reached_start.insert(room_id);
    }

    fn blinded(&mut self, room_id: &OwnedRoomId, undecryptable: usize) -> bool {
        if undecryptable == 0 {
            self.blind.remove(room_id);
            return false;
        }

        let seen = self.blind.entry(room_id.clone()).or_default();
        *seen = seen.saturating_add(undecryptable);
        *seen >= BLIND_EVENTS_BEFORE_SKIP
    }

    fn blind_rooms(&self) -> usize {
        self.blind
            .values()
            .filter(|seen| **seen >= BLIND_EVENTS_BEFORE_SKIP)
            .count()
    }

    fn token_or(&self, room_id: &OwnedRoomId, fresh: Option<String>) -> Option<String> {
        self.tokens.get(room_id).map_or(fresh, Clone::clone)
    }

    fn advance(&mut self, room_id: &OwnedRoomId, token: Option<String>) {
        self.changed = true;
        self.tokens.insert(room_id.clone(), token);
    }

    pub(super) fn checkpoints(&self) -> BTreeMap<OwnedRoomId, StoredCrawlRoom> {
        let mut rooms: BTreeMap<OwnedRoomId, StoredCrawlRoom> = self
            .tokens
            .iter()
            .map(|(room_id, token)| {
                (
                    room_id.clone(),
                    StoredCrawlRoom {
                        token: token.clone(),
                        reached_start: false,
                    },
                )
            })
            .collect();
        for room_id in &self.exhausted {
            rooms.insert(
                room_id.clone(),
                StoredCrawlRoom {
                    token: None,
                    reached_start: true,
                },
            );
        }
        rooms
    }

    fn changed_checkpoints(
        &mut self,
        unflushed: &HashSet<OwnedRoomId>,
    ) -> Option<BTreeMap<OwnedRoomId, StoredCrawlRoom>> {
        if !self.changed {
            return None;
        }
        let mut rooms = self.checkpoints();
        for room_id in unflushed {
            match self.saved.get(room_id) {
                Some(saved) => rooms.insert(room_id.clone(), saved.clone()),
                None => rooms.remove(room_id),
            };
        }
        self.awaiting
            .retain(|room_id, _| unflushed.contains(room_id));
        self.changed = !unflushed.is_empty();
        Some(rooms)
    }

    pub(super) fn restore(&mut self, rooms: BTreeMap<OwnedRoomId, StoredCrawlRoom>) {
        self.changed = false;
        self.saved.clone_from(&rooms);
        for (room_id, room) in rooms {
            if self.discarded.contains(&room_id) {
                self.changed = true;
            } else if room.reached_start {
                self.exhausted.insert(room_id.clone());
                self.reached_start.insert(room_id);
            } else {
                self.tokens.insert(room_id, room.token);
            }
        }
    }

    pub(super) fn fail(&mut self, room_id: OwnedRoomId) {
        self.failed.insert(room_id);
    }

    fn stall(&mut self, room_id: &OwnedRoomId, retry_after: Option<Duration>) -> Option<Duration> {
        let attempts = self.stalled.entry(room_id.clone()).or_default();
        *attempts += 1;
        if *attempts > PUSHBACKS_BEFORE_SKIP {
            return None;
        }
        let backoff = retry_after.unwrap_or_else(|| CRAWL_PAUSE * 2u32.saturating_pow(*attempts));
        Some(backoff.min(CRAWL_BACKOFF_CAP))
    }

    fn steady(&mut self, room_id: &OwnedRoomId) {
        self.stalled.remove(room_id);
    }

    pub(super) fn discard(&mut self, room_id: OwnedRoomId) {
        self.discarded.insert(room_id);
    }

    pub(super) fn forget(&mut self, room_id: &RoomId) {
        self.reached_start.remove(room_id);
        self.exhausted.remove(room_id);
        self.failed.remove(room_id);
        self.visits.remove(room_id);
        self.tokens.remove(room_id);
        self.probed.remove(room_id);
        self.blind.remove(room_id);
        self.stalled.remove(room_id);
        self.awaiting.remove(room_id);
        self.changed = true;
    }

    pub(crate) fn reset(&mut self) {
        *self = Self {
            changed: true,
            metrics: std::mem::take(&mut self.metrics),
            ..Self::default()
        };
    }

    const fn enter(&mut self, phase: SearchCrawlPhase) {
        self.metrics.phase = phase;
    }

    #[cfg(test)]
    pub(super) const fn exhaust_budget_for_test(&mut self) {
        self.events = MAX_CRAWLED_EVENTS;
    }
}

impl Core {
    pub(crate) fn watch_search_crawl(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let core = self.clone();
        let client = client.clone();

        self.track_session_task(spawn(async move { core.crawl(&client).await }).abort_on_drop());
    }

    async fn crawl(self: Arc<Self>, client: &matrix_sdk::Client) {
        let mut reported: Option<SearchCoverageView> = None;

        let stored = persist::load_crawl(client).await;
        {
            let mut progress = self.search_crawl.lock().await;
            progress.restore(stored.rooms);
            progress.metrics.started_ms.get_or_insert_with(now_ms);
        }

        loop {
            self.report_coverage(client, &mut reported).await;
            self.save_changed_checkpoints(client).await;

            if self.foreground_paginations() > 0 {
                self.search_crawl
                    .lock()
                    .await
                    .enter(SearchCrawlPhase::Yielding);
                matrix_sdk::sleep::sleep(CRAWL_PAUSE).await;
                continue;
            }

            let spent = self.search_crawl.lock().await.spent();
            let full = self.search_index.lock().await.is_full();

            if spent || full {
                self.search_crawl.lock().await.enter(if spent {
                    SearchCrawlPhase::BudgetSpent
                } else {
                    SearchCrawlPhase::IndexFull
                });
                matrix_sdk::sleep::sleep(CRAWL_IDLE).await;
                continue;
            }

            let Some(room_id) = self.next_room_to_crawl(client).await else {
                self.search_crawl.lock().await.enter(SearchCrawlPhase::Idle);
                matrix_sdk::sleep::sleep(CRAWL_IDLE).await;
                continue;
            };

            {
                let mut progress = self.search_crawl.lock().await;
                let phase = if progress.trickling() {
                    SearchCrawlPhase::Trickling
                } else {
                    SearchCrawlPhase::Crawling
                };
                progress.enter(phase);
            }
            let pause = match self.crawl_once(client, &room_id).await {
                Ok(outcome) if outcome.reached_start => {
                    let mut progress = self.search_crawl.lock().await;
                    progress.steady(&room_id);
                    progress.settle(room_id, outcome.exhausted);
                    outcome.pause()
                }
                Ok(outcome) => {
                    let mut progress = self.search_crawl.lock().await;
                    progress.steady(&room_id);
                    if progress.blinded(&room_id, outcome.undecryptable) {
                        progress.settle(room_id, false);
                    }
                    outcome.pause()
                }
                Err(error) => {
                    if let Some(delay) = self.settle_pushback(&room_id, &error).await {
                        self.search_crawl
                            .lock()
                            .await
                            .enter(SearchCrawlPhase::BackingOff);
                        matrix_sdk::sleep::sleep(delay).await;
                        continue;
                    }
                    CRAWL_PAUSE
                }
            };

            let pause = self.search_crawl.lock().await.paced(pause);
            matrix_sdk::sleep::sleep(pause).await;
        }
    }

    async fn save_changed_checkpoints(&self, client: &matrix_sdk::Client) {
        let awaiting = self.search_crawl.lock().await.awaiting.clone();
        let unflushed: HashSet<OwnedRoomId> = {
            let index = self.search_index.lock().await;
            awaiting
                .into_iter()
                .filter(|(room_id, revision)| !index.is_durable(room_id, *revision))
                .map(|(room_id, _)| room_id)
                .collect()
        };
        let Some(checkpoints) = self
            .search_crawl
            .lock()
            .await
            .changed_checkpoints(&unflushed)
        else {
            return;
        };
        if checkpoints == self.search_crawl.lock().await.saved {
            return;
        }
        if persist::save_crawl(client, checkpoints.clone()).await {
            self.search_crawl.lock().await.saved = checkpoints;
        } else {
            self.search_crawl.lock().await.changed = true;
        }
    }

    async fn settle_pushback(
        &self,
        room_id: &OwnedRoomId,
        error: &matrix_sdk::Error,
    ) -> Option<Duration> {
        let mut progress = self.search_crawl.lock().await;

        let Pushback::Transient(retry_after) = pushback(error) else {
            progress.fail(room_id.clone());
            warn!(%room_id, "search crawl pagination failed: {error}");
            return None;
        };

        progress.visit(room_id);
        progress.metrics.pushbacks = progress.metrics.pushbacks.saturating_add(1);
        let Some(delay) = progress.stall(room_id, retry_after) else {
            progress.fail(room_id.clone());
            warn!(%room_id, "search crawl stopped after repeated pushback: {error}");
            return None;
        };

        warn!(%room_id, "search crawl backing off {delay:?}: {error}");
        Some(delay)
    }

    async fn report_coverage(
        &self,
        client: &matrix_sdk::Client,
        reported: &mut Option<SearchCoverageView>,
    ) {
        let coverage = self.search_coverage(client).await;
        if reported.as_ref() == Some(&coverage) {
            return;
        }
        *reported = Some(coverage);
        self.emit(CoreEvent::SearchCoverage { coverage });
    }

    pub(crate) async fn search_coverage(&self, client: &matrix_sdk::Client) -> SearchCoverageView {
        let index = self.search_index.lock().await;
        let documents = index.stored_documents();
        let full = index.is_full();
        drop(index);

        let progress = self.search_crawl.lock().await;
        let rooms_pending = client
            .joined_rooms()
            .into_iter()
            .filter(|room| !progress.skips(room.room_id()))
            .count();
        let rooms_failed = progress.failed.len();
        let rooms_blind = progress.blind_rooms();
        let stopped = full || progress.spent();
        drop(progress);

        let state = if stopped {
            SearchCoverageState::Stopped
        } else if rooms_pending > 0 {
            SearchCoverageState::Indexing
        } else if rooms_failed > 0 || rooms_blind > 0 {
            SearchCoverageState::Partial
        } else {
            SearchCoverageState::Complete
        };

        SearchCoverageView {
            documents,
            rooms_pending,
            rooms_failed,
            state,
        }
    }

    pub(crate) async fn search_metrics(&self, client: &matrix_sdk::Client) -> SearchMetricsView {
        let index = self.search_index.lock().await;
        let documents = index.stored_documents();
        let documents_loaded = index.documents();
        let (memory_budget, disk_budget) = index.budgets();
        let memory_bytes = index.memory();
        let disk_bytes = index.disk();
        let rooms_indexed = index.rooms.len();
        let rooms_unreadable = index.unreadable.len();
        drop(index);

        let rooms = client.joined_rooms();
        let progress = self.search_crawl.lock().await;
        let metrics = &progress.metrics;

        SearchMetricsView {
            phase: metrics.phase,
            documents,
            documents_loaded,
            memory_bytes,
            memory_budget,
            disk_bytes,
            disk_budget,
            rooms_joined: rooms.len(),
            rooms_indexed,
            rooms_pending: rooms
                .iter()
                .filter(|room| !progress.skips(room.room_id()))
                .count(),
            rooms_exhausted: progress.exhausted.len(),
            rooms_failed: progress.failed.len(),
            rooms_blind: progress.blind_rooms(),
            rooms_unreadable,
            events_crawled: progress.events,
            event_budget: MAX_CRAWLED_EVENTS,
            batches: metrics.batches,
            pushbacks: metrics.pushbacks,
            last_request_ms: metrics.last_request_ms,
            average_request_ms: metrics.average_request_ms(),
            running_ms: metrics
                .started_ms
                .map(|started| now_ms().saturating_sub(started)),
        }
    }

    pub(super) async fn next_room_to_crawl(
        &self,
        client: &matrix_sdk::Client,
    ) -> Option<OwnedRoomId> {
        let rooms = client.joined_rooms();
        self.settle_one_encryption_state(&rooms).await;

        let candidates: Vec<(&RoomId, bool, usize)> = {
            let progress = self.search_crawl.lock().await;
            let tiered = rooms.iter().all(|room| {
                !room.encryption_state().is_unknown() || progress.probed.contains(room.room_id())
            });

            rooms
                .iter()
                .filter(|room| !progress.skips(room.room_id()))
                .map(|room| {
                    (
                        room.room_id(),
                        tiered && crawls_first(room),
                        progress.visits.get(room.room_id()).copied().unwrap_or(0),
                    )
                })
                .collect()
        };

        let index = self.search_index.lock().await;
        candidates
            .into_iter()
            .min_by_key(|&(room_id, first, visits)| {
                (!first, visits, Reverse(index.newest_in(room_id)))
            })
            .map(|(room_id, ..)| room_id.to_owned())
    }

    async fn settle_one_encryption_state(&self, rooms: &[Room]) {
        let unsettled = {
            let progress = self.search_crawl.lock().await;
            rooms
                .iter()
                .find(|room| {
                    room.encryption_state().is_unknown()
                        && !progress.probed.contains(room.room_id())
                })
                .cloned()
        };
        let Some(room) = unsettled else {
            return;
        };

        self.search_crawl
            .lock()
            .await
            .probed
            .insert(room.room_id().to_owned());

        if let Err(error) = room.request_encryption_state().await {
            warn!(room_id = %room.room_id(), "could not settle a room's encryption state: {error}");
        }
    }

    pub(super) async fn crawl_once(
        &self,
        client: &matrix_sdk::Client,
        room_id: &OwnedRoomId,
    ) -> matrix_sdk::Result<CrawlOutcome> {
        let Some(room) = client.get_room(room_id) else {
            return Ok(CrawlOutcome::gone());
        };

        let from = self
            .search_crawl
            .lock()
            .await
            .token_or(room_id, room.last_prev_batch());

        let mut options = MessagesOptions::backward().from(from.as_deref());
        options.limit = UInt::from(CRAWL_BATCH);
        let requested = now_ms();
        let messages = room.messages(options).await?;

        {
            let mut progress = self.search_crawl.lock().await;
            progress.visit(room_id);
            progress.metrics.request(now_ms().saturating_sub(requested));
        }
        if room.state() != RoomState::Joined {
            return Ok(CrawlOutcome::gone());
        }

        let floor = self.search_index.lock().await.floor_of(room_id);
        if floor > 0
            && !messages.chunk.is_empty()
            && messages.chunk.iter().all(|event| {
                event
                    .timestamp_raw()
                    .is_some_and(|ts| u64::from(ts.get()) < floor)
            })
        {
            return Ok(CrawlOutcome {
                reached_start: true,
                exhausted: true,
                undecryptable: 0,
                readable: true,
            });
        }

        let undecryptable = if messages.chunk.iter().all(|event| event.kind.is_utd()) {
            messages.chunk.len()
        } else {
            0
        };
        let outcome = CrawlOutcome {
            reached_start: messages.end.is_none() || messages.chunk.is_empty(),
            exhausted: messages.end.is_none(),
            undecryptable,
            readable: !messages.chunk.iter().any(|event| event.kind.is_utd()),
        };

        if messages.chunk.is_empty() {
            self.search_crawl
                .lock()
                .await
                .advance(room_id, messages.end);
        } else {
            let (cache, _drop_handles) = client.event_cache().room(room_id).await?;
            self.search_crawl
                .lock()
                .await
                .advance(room_id, messages.end);
            let rules = room.clone_info().room_version_rules_or_default().redaction;
            let mut events = messages.chunk;
            events.reverse();

            self.search_crawl.lock().await.ingesting = Some(room_id.clone());

            let (fresh, revision) = {
                let mut index = self.search_index.lock().await;
                let fresh = index.ingest(room_id, events, &cache, &rules).await;
                (fresh, index.revision(room_id))
            };

            let mut progress = self.search_crawl.lock().await;
            progress.ingesting = None;
            progress.awaiting.insert(room_id.clone(), revision);
            progress.events = progress.events.saturating_add(fresh);
        }

        Ok(outcome)
    }
}

pub(super) struct CrawlOutcome {
    pub(super) reached_start: bool,
    pub(super) exhausted: bool,
    pub(super) undecryptable: usize,
    pub(super) readable: bool,
}

impl CrawlOutcome {
    const fn gone() -> Self {
        Self {
            reached_start: true,
            exhausted: false,
            undecryptable: 0,
            readable: true,
        }
    }

    const fn pause(&self) -> Duration {
        if self.readable {
            CRAWL_READABLE_PAUSE
        } else {
            CRAWL_PAUSE
        }
    }
}

fn crawls_first(room: &Room) -> bool {
    !matches!(room.encryption_state(), EncryptionState::NotEncrypted)
        || room.direct_targets_length() > 0
}

#[cfg(test)]
#[allow(clippy::large_futures)]
mod tests {
    use std::collections::HashSet;
    use std::time::Duration;

    use matrix_sdk::ruma::{OwnedRoomId, room_id, user_id};
    use matrix_sdk::test_utils::mocks::{MatrixMockServer, RoomMessagesResponseTemplate};
    use matrix_sdk_test::{JoinedRoomBuilder, async_test, event_factory::EventFactory};

    use std::collections::BTreeMap;

    use super::super::persist::StoredCrawlRoom;
    use super::{
        BLIND_EVENTS_BEFORE_SKIP, CRAWL_BACKOFF_CAP, CRAWL_BASE_EVENTS, CRAWL_BATCH, CRAWL_PAUSE,
        CRAWL_READABLE_PAUSE, CRAWL_TRICKLE_PAUSE, CrawlOutcome, CrawlProgress, MAX_CRAWLED_EVENTS,
        PUSHBACKS_BEFORE_SKIP,
    };

    fn room() -> OwnedRoomId {
        room_id!("!crawled:localhost").to_owned()
    }

    fn outcome(readable: bool) -> CrawlOutcome {
        CrawlOutcome {
            reached_start: false,
            exhausted: false,
            undecryptable: 0,
            readable,
        }
    }

    #[test]
    fn test_only_a_batch_with_an_undecryptable_event_earns_the_long_pause() {
        assert_eq!(outcome(true).pause(), CRAWL_READABLE_PAUSE);
        assert_eq!(outcome(false).pause(), CRAWL_PAUSE);
        assert!(CRAWL_READABLE_PAUSE < CRAWL_PAUSE);
    }

    #[test]
    fn test_past_the_base_budget_the_crawl_slows_to_a_trickle_before_it_stops() {
        let mut progress = CrawlProgress {
            events: CRAWL_BASE_EVENTS - 1,
            ..CrawlProgress::default()
        };
        assert_eq!(progress.paced(CRAWL_READABLE_PAUSE), CRAWL_READABLE_PAUSE);

        progress.events = CRAWL_BASE_EVENTS;
        assert_eq!(progress.paced(CRAWL_READABLE_PAUSE), CRAWL_TRICKLE_PAUSE);
        assert!(!progress.spent());

        progress.events = MAX_CRAWLED_EVENTS;
        assert!(progress.spent());
    }

    #[test]
    fn test_one_blind_batch_is_not_enough_to_give_up_on_a_room() {
        let mut progress = CrawlProgress::default();

        assert!(!progress.blinded(&room(), usize::from(CRAWL_BATCH)));
        assert!(progress.blinded(&room(), usize::from(CRAWL_BATCH)));
    }

    #[async_test]
    async fn test_the_metrics_count_batches_and_pushbacks() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");
        let room_id = room();
        server.sync_joined_room(&client, &room_id).await;
        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default().end_token("older"))
            .mock_once()
            .mount()
            .await;
        server.mock_room_messages().error500().mount().await;

        let (core, _events) = crate::Core::new(
            "crawl-metrics",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.crawl_once(&client, &room_id)
            .await
            .expect("the first batch should land");
        let Err(error) = core.crawl_once(&client, &room_id).await else {
            panic!("the mocked server error should have surfaced");
        };
        core.settle_pushback(&room_id, &error).await;

        let metrics = core.search_metrics(&client).await;
        assert_eq!(metrics.batches, 1);
        assert_eq!(metrics.pushbacks, 1);
        assert!(metrics.last_request_ms.is_some());
        assert_eq!(metrics.average_request_ms, metrics.last_request_ms);
        assert_eq!(metrics.rooms_joined, 1);
        assert_eq!(metrics.event_budget, MAX_CRAWLED_EVENTS);
    }

    #[test]
    fn test_a_reset_keeps_the_session_metrics() {
        let mut progress = CrawlProgress::default();
        progress.metrics.request(40);

        progress.reset();

        assert_eq!(progress.metrics.batches, 1);
        assert_eq!(progress.metrics.last_request_ms, Some(40));
    }

    #[async_test]
    async fn test_a_room_without_a_cursor_starts_behind_what_sync_delivered() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");
        let room_id = room();
        let joined = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).set_timeline_prev_batch("behind-sync"),
            )
            .await;
        server
            .mock_room_messages()
            .match_from("behind-sync")
            .ok(RoomMessagesResponseTemplate::default())
            .mock_once()
            .mount()
            .await;

        let (core, _events) = crate::Core::new(
            "crawl-prev-batch",
            Box::new(crate::store::MemorySessionStore::default()),
        );

        core.crawl_once(&client, &room_id)
            .await
            .expect("the first batch should start from the sync's prev_batch");

        drop(joined);
    }

    #[test]
    fn test_a_failed_room_is_skipped_so_the_crawl_moves_on() {
        let progress = CrawlProgress {
            failed: HashSet::from([room()]),
            ..CrawlProgress::default()
        };

        assert!(progress.skips(&room()));
    }

    #[test]
    fn test_a_room_that_keeps_pushing_back_is_given_up_on_eventually() {
        let mut progress = CrawlProgress::default();

        for _ in 0..PUSHBACKS_BEFORE_SKIP {
            assert!(progress.stall(&room(), None).is_some());
        }
        assert!(progress.stall(&room(), None).is_none());
    }

    #[test]
    fn test_the_server_retry_after_wins_but_cannot_park_the_crawl() {
        let mut progress = CrawlProgress::default();

        assert_eq!(
            progress.stall(&room(), Some(Duration::from_secs(9))),
            Some(Duration::from_secs(9))
        );
        assert_eq!(
            progress.stall(&room(), Some(Duration::from_hours(1))),
            Some(CRAWL_BACKOFF_CAP)
        );
    }

    #[test]
    fn test_a_batch_that_lands_clears_the_backoff() {
        let mut progress = CrawlProgress::default();

        for _ in 0..PUSHBACKS_BEFORE_SKIP {
            progress.stall(&room(), None);
        }
        progress.steady(&room());

        assert!(progress.stall(&room(), None).is_some());
    }

    #[async_test]
    async fn test_a_server_error_backs_the_crawl_off_instead_of_dropping_the_room() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");
        let room_id = room();
        server.sync_joined_room(&client, &room_id).await;
        server.mock_room_messages().error500().mount().await;

        let (core, _events) = crate::Core::new(
            "crawl",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        let Err(error) = core.crawl_once(&client, &room_id).await else {
            panic!("the mocked server error should have surfaced");
        };

        assert!(core.settle_pushback(&room_id, &error).await.is_some());
        assert!(!core.search_crawl.lock().await.skips(&room_id));
    }

    #[test]
    fn test_a_room_this_device_cannot_decrypt_stops_after_enough_blind_events() {
        let mut progress = CrawlProgress::default();

        assert!(!progress.blinded(&room(), BLIND_EVENTS_BEFORE_SKIP - 1));
        assert!(progress.blinded(&room(), 1));
    }

    #[test]
    fn test_one_decryptable_batch_clears_the_blind_streak() {
        let mut progress = CrawlProgress::default();

        assert!(!progress.blinded(&room(), BLIND_EVENTS_BEFORE_SKIP - 1));
        assert!(!progress.blinded(&room(), 0));
        assert!(!progress.blinded(&room(), BLIND_EVENTS_BEFORE_SKIP - 1));
    }

    #[test]
    fn test_a_blinded_room_is_re_walked_next_session() {
        let mut progress = CrawlProgress::default();
        while !progress.blinded(&room(), usize::from(CRAWL_BATCH)) {}
        progress.settle(room(), false);

        assert!(progress.skips(&room()));
        assert!(!progress.checkpoints().contains_key(&room()));
    }

    #[test]
    fn test_a_blinded_room_is_never_reported_as_complete_coverage() {
        let mut progress = CrawlProgress::default();
        assert_eq!(progress.blind_rooms(), 0);

        while !progress.blinded(&room(), usize::from(CRAWL_BATCH)) {}
        progress.settle(room(), false);

        assert_eq!(progress.blind_rooms(), 1);
    }

    #[test]
    fn test_the_event_budget_stops_the_crawl_even_with_room_in_the_index() {
        let mut progress = CrawlProgress {
            events: MAX_CRAWLED_EVENTS - 1,
            ..CrawlProgress::default()
        };
        assert!(!progress.spent());

        progress.events += 1;
        assert!(progress.spent());
    }

    #[test]
    fn test_a_reset_clears_finished_and_failed_rooms() {
        let mut progress = CrawlProgress {
            reached_start: HashSet::from([room()]),
            failed: HashSet::from([room_id!("!other:localhost").to_owned()]),
            events: 500,
            ..CrawlProgress::default()
        };

        progress.reset();

        assert!(!progress.skips(&room()));
        assert!(!progress.spent());
        assert_eq!(progress.events, 0);
    }

    #[test]
    fn test_a_forgotten_room_is_crawled_again() {
        let mut progress = CrawlProgress::default();
        progress.settle(room(), true);
        progress.visit(&room());

        progress.forget(&room());

        assert!(!progress.skips(&room()));
        assert!(!progress.checkpoints().contains_key(&room()));
    }

    #[test]
    fn test_a_discarded_index_does_not_keep_its_room_written_off() {
        let mut progress = CrawlProgress::default();
        progress.discard(room());

        progress.restore(BTreeMap::from([(
            room(),
            StoredCrawlRoom {
                token: None,
                reached_start: true,
            },
        )]));

        assert!(!progress.skips(&room()));
        assert!(
            progress
                .changed_checkpoints(&HashSet::new())
                .is_some_and(|checkpoints| checkpoints.is_empty()),
            "the stale checkpoint must be rewritten away"
        );
    }

    #[async_test]
    async fn test_checkpoints_written_by_main_survive_the_upgrade() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client
            .state_store()
            .set_custom_value(
                b"sable.search.crawl",
                serde_json::to_vec(&serde_json::json!({
                    "version": 3,
                    "rooms": { "!crawled:localhost": { "token": "t42", "reached_start": false } },
                }))
                .expect("json"),
            )
            .await
            .expect("stored");

        let stored = super::super::persist::load_crawl(&client).await;

        assert_eq!(
            stored
                .rooms
                .get(&room())
                .and_then(|room| room.token.as_deref()),
            Some("t42")
        );
    }

    #[test]
    fn test_checkpoints_are_only_rewritten_when_they_change() {
        let mut progress = CrawlProgress::default();
        assert!(progress.changed_checkpoints(&HashSet::new()).is_none());

        progress.advance(&room(), Some("next".to_owned()));
        assert!(progress.changed_checkpoints(&HashSet::new()).is_some());
        assert!(progress.changed_checkpoints(&HashSet::new()).is_none());

        progress.visit(&room());
        assert!(
            progress.changed_checkpoints(&HashSet::new()).is_none(),
            "a visit is not a checkpoint"
        );
    }

    #[async_test]
    async fn test_a_checkpoint_is_not_persisted_ahead_of_the_documents_it_skips() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));
        server.mock_room_state_encryption().plain().mount().await;
        let joined = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous"),
            )
            .await;
        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default()
                .events(vec![factory.text_msg("older archaeology")])
                .end_token("deeper"))
            .mount()
            .await;

        let (core, _events) = crate::Core::new(
            "crawl-durable-checkpoint",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.crawl_once(&client, &room_id)
            .await
            .expect("crawl one batch");

        core.save_changed_checkpoints(&client).await;
        assert!(
            !super::persist::load_crawl(&client)
                .await
                .rooms
                .contains_key(&room_id)
        );

        core.flush_search_index(&client).await;
        core.save_changed_checkpoints(&client).await;
        assert_eq!(
            super::persist::load_crawl(&client)
                .await
                .rooms
                .get(&room_id)
                .and_then(|room| room.token.as_deref()),
            Some("deeper")
        );

        drop(joined);
    }

    #[async_test]
    async fn test_the_crawl_stops_a_room_below_its_floor() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));
        server.mock_room_state_encryption().plain().mount().await;
        let joined = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .set_timeline_limited()
                    .set_timeline_prev_batch("previous"),
            )
            .await;
        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default()
                .events(vec![factory.text_msg("deleted history").server_ts(
                    matrix_sdk::ruma::MilliSecondsSinceUnixEpoch(matrix_sdk::ruma::UInt::from(
                        10_u32,
                    )),
                )])
                .end_token("deeper"))
            .mount()
            .await;

        let (core, _events) = crate::Core::new(
            "crawl-floor",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        {
            let mut index = core.search_index.lock().await;
            let mut room_index = super::super::RoomIndex::new();
            room_index.floor = 1_000;
            index.rooms.insert(room_id.clone(), room_index);
        }

        let outcome = core
            .crawl_once(&client, &room_id)
            .await
            .expect("crawl one batch");
        assert!(outcome.exhausted);
        assert_eq!(core.search_index.lock().await.documents(), 0);

        drop(joined);
    }

    #[async_test]
    async fn test_a_room_that_is_gone_is_not_written_off_for_good() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let (core, _events) = crate::Core::new(
            "crawl-gone",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        let outcome = core
            .crawl_once(&client, &room())
            .await
            .expect("a missing room is not an error");

        assert!(outcome.reached_start);
        assert!(!outcome.exhausted, "a rejoin must walk the room again");
    }

    #[async_test]
    async fn test_the_crawl_reaches_an_encrypted_room_before_one_the_server_can_search() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let sender = user_id!("@erwan:localhost");
        let plain_id = room_id!("!plain:localhost").to_owned();
        let secret_id = room_id!("!secret:localhost").to_owned();
        server.mock_room_state_encryption().plain().mount().await;

        let plain = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&plain_id).add_timeline_event(
                    EventFactory::new()
                        .room(&plain_id)
                        .sender(sender)
                        .text_msg("public deploy"),
                ),
            )
            .await;
        let secret = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&secret_id)
                    .add_state_event(
                        EventFactory::new()
                            .room(&secret_id)
                            .sender(sender)
                            .room_encryption(),
                    )
                    .add_timeline_event(
                        EventFactory::new()
                            .room(&secret_id)
                            .sender(sender)
                            .text_msg("private deploy"),
                    ),
            )
            .await;

        let (core, _events) = crate::Core::new(
            "search-crawl-priority",
            Box::new(crate::store::MemorySessionStore::default()),
        );

        {
            let mut progress = core.search_crawl.lock().await;
            progress.visit(&secret_id);
            progress.visit(&secret_id);
        }

        assert_eq!(
            core.next_room_to_crawl(&client).await.as_ref(),
            Some(&secret_id),
            "the crawl is the only thing that can ever search an encrypted room"
        );

        core.search_crawl.lock().await.settle(secret_id, true);
        assert_eq!(
            core.next_room_to_crawl(&client).await.as_ref(),
            Some(&plain_id),
            "a plain room is still crawled once the encrypted ones are done"
        );

        drop((plain, secret));
    }
}
