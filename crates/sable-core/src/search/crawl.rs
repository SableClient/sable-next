use crate::SignedIn;
use crate::api::session::SearchTuning;
use crate::now_ms;
use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use crate::tasks::JoinHandleExt;
use matrix_sdk::deserialized_responses::{
    TimelineEvent, UnableToDecryptInfo, UnableToDecryptReason,
};
use matrix_sdk::executor::spawn;
use matrix_sdk::ruma::api::Direction;
use matrix_sdk::ruma::api::client::message::get_message_events;
use matrix_sdk::ruma::api::error::{ErrorKind, RetryAfter};
use matrix_sdk::ruma::events::AnyTimelineEvent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, RoomId, UInt};
use matrix_sdk::{EncryptionState, Room, RoomState};
use tracing::warn;

use super::persist::{self, Cover, Hole, StoredCrawlRoom};
use super::sharing::DISCOVERY;
use crate::protocol::{
    CoreEvent, SearchCoverageState, SearchCoverageView, SearchCrawlPhase, SearchMetricsView,
};

const CRAWL_BATCH: u16 = 100;
const CRAWL_DEFAULT_BATCH: u16 = 50;
const CRAWL_PAUSE: Duration = Duration::from_secs(3);
const CRAWL_READABLE_PAUSE: Duration = Duration::from_secs(3);
pub(super) const CRAWL_MAX_AGE_MS: u64 = 26 * 7 * 24 * 60 * 60 * 1000;
const CRAWL_IDLE: Duration = Duration::from_secs(30);
/// A busy crawl rewrites the whole checkpoint map at most this often; a crawl that stops does so
/// at once.
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(30);
const COVERAGE_PROGRESS_INTERVAL: Duration = Duration::from_secs(10);
const CRAWL_BASE_EVENTS: usize = 20_000;
const MAX_CRAWLED_EVENTS: usize = 50_000;
const CRAWL_LATENCY_FACTOR: u32 = 10;
const CRAWL_TRICKLE_PAUSE: Duration = Duration::from_secs(10);
const BLIND_EVENTS_BEFORE_SKIP: usize = 200;
const CRAWL_BACKOFF_CAP: Duration = Duration::from_mins(5);
const PUSHBACKS_BEFORE_SKIP: u32 = 5;

const PERSIST_INTERVAL_SECS: u32 = 60;

impl Default for SearchTuning {
    fn default() -> Self {
        Self {
            crawl_pause_ms: duration_ms(CRAWL_READABLE_PAUSE),
            trickle_pause_ms: duration_ms(CRAWL_TRICKLE_PAUSE),
            flush_interval_secs: PERSIST_INTERVAL_SECS,
            batch: u32::from(CRAWL_DEFAULT_BATCH),
            base_events: u32::try_from(CRAWL_BASE_EVENTS).unwrap_or(u32::MAX),
            max_events: u32::try_from(MAX_CRAWLED_EVENTS).unwrap_or(u32::MAX),
        }
    }
}

fn duration_ms(duration: Duration) -> u32 {
    u32::try_from(duration.as_millis()).unwrap_or(u32::MAX)
}

impl SearchTuning {
    pub(crate) fn clamped(self) -> Self {
        let base_events = self.base_events.clamp(1_000, 1_000_000);
        Self {
            crawl_pause_ms: self.crawl_pause_ms.clamp(500, 60_000),
            trickle_pause_ms: self.trickle_pause_ms.clamp(1_000, 300_000),
            flush_interval_secs: self.flush_interval_secs.clamp(10, 3_600),
            batch: self.batch.clamp(10, u32::from(CRAWL_BATCH)),
            base_events,
            max_events: self.max_events.clamp(base_events, 2_000_000),
        }
    }

    pub(crate) fn flush_interval(&self) -> Duration {
        Duration::from_secs(u64::from(self.flush_interval_secs))
    }
}

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
    frontiers: HashMap<OwnedRoomId, u64>,
    resumed: HashSet<OwnedRoomId>,
    gapped: HashSet<OwnedRoomId>,
    pub(super) holes: HashMap<OwnedRoomId, Hole>,
    covered: HashMap<OwnedRoomId, Cover>,
    anchored: HashSet<OwnedRoomId>,
    probed: HashSet<OwnedRoomId>,
    blind: HashMap<OwnedRoomId, usize>,
    lost_sessions: HashSet<(OwnedRoomId, String)>,
    stalled: HashMap<OwnedRoomId, u32>,
    saved: BTreeMap<OwnedRoomId, StoredCrawlRoom>,
    /// When the checkpoints were last written, so a busy crawl saves them in batches.
    checkpointed: Option<web_time::Instant>,
    #[cfg(test)]
    checkpoint_writes: usize,
    events: usize,
    changed: bool,
    metrics: CrawlMetrics,
    pub(crate) tuning: SearchTuning,
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

fn decrypted_or_utd(
    event: Raw<AnyTimelineEvent>,
    result: matrix_sdk::Result<TimelineEvent>,
) -> TimelineEvent {
    result.unwrap_or_else(|_| {
        TimelineEvent::from_utd(
            event.cast(),
            UnableToDecryptInfo {
                session_id: None,
                reason: UnableToDecryptReason::Unknown,
            },
        )
    })
}

impl CrawlProgress {
    fn skips(&self, room_id: &RoomId) -> bool {
        (self.reached_start.contains(room_id) && !self.holes.contains_key(room_id))
            || self.failed.contains(room_id)
    }

    /// Notes that events after `anchor` and before `until` were never seen.
    pub(super) fn open_hole(
        &mut self,
        room_id: &OwnedRoomId,
        anchor: OwnedEventId,
        until: OwnedEventId,
    ) {
        self.changed = true;
        self.holes
            .entry(room_id.clone())
            .and_modify(|hole| hole.until.clone_from(&until))
            .or_insert(Hole {
                anchor,
                until,
                token: None,
            });
    }

    const fn spent(&self) -> bool {
        self.events >= self.tuning.max_events as usize
    }

    const fn trickling(&self) -> bool {
        self.events >= self.tuning.base_events as usize
    }

    fn paced(&self, pause: Duration) -> Duration {
        let pause = if self.trickling() {
            pause.max(Duration::from_millis(u64::from(
                self.tuning.trickle_pause_ms,
            )))
        } else {
            pause
        };
        let latency = self
            .metrics
            .last_request_ms
            .map_or(Duration::ZERO, Duration::from_millis);
        pause.max((latency * CRAWL_LATENCY_FACTOR).min(CRAWL_BACKOFF_CAP))
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

    pub(super) fn complete_rooms(&self) -> usize {
        self.reached_start.len()
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

    pub(super) fn advance(&mut self, room_id: &OwnedRoomId, token: Option<String>) {
        self.changed = true;
        self.tokens.insert(room_id.clone(), token);
    }

    pub(super) fn checkpoints(&self) -> BTreeMap<OwnedRoomId, StoredCrawlRoom> {
        let stored =
            |room_id: &OwnedRoomId, token: Option<String>, reached_start: bool| StoredCrawlRoom {
                shared_resume: self.resumed.contains(room_id),
                frontier: self.frontiers.get(room_id).copied(),
                gapped: self.gapped.contains(room_id),
                token,
                reached_start,
                cover: self.covered.get(room_id).cloned(),
                hole: self.holes.get(room_id).cloned(),
            };
        let mut rooms: BTreeMap<OwnedRoomId, StoredCrawlRoom> = self
            .tokens
            .keys()
            .chain(self.covered.keys())
            .chain(self.holes.keys())
            .map(|room_id| {
                let token = self.tokens.get(room_id).cloned().flatten();
                (room_id.clone(), stored(room_id, token, false))
            })
            .collect();
        for room_id in &self.exhausted {
            rooms.insert(room_id.clone(), stored(room_id, None, true));
        }
        rooms
    }

    pub(super) fn cover_of(&self, room_id: &RoomId) -> Option<&Cover> {
        self.covered.get(room_id)
    }

    fn stop_at(&self, room_id: &RoomId) -> u64 {
        self.covered
            .get(room_id)
            .filter(|cover| cover.stops)
            .map_or(0, |cover| cover.until)
    }

    pub(super) fn has_token(&self, room_id: &RoomId) -> bool {
        self.tokens.get(room_id).is_some_and(Option::is_some)
    }

    pub(super) fn share_boundary(&self, room_id: &RoomId) -> (Option<u64>, Option<String>) {
        let Some(saved) = self.saved.get(room_id) else {
            return (None, None);
        };
        if saved.gapped {
            return (None, None);
        }
        if saved.reached_start {
            (Some(0), None)
        } else {
            (saved.frontier, saved.token.clone())
        }
    }

    fn jump(&mut self, room_id: &OwnedRoomId) -> bool {
        let Some(token) = self
            .covered
            .get_mut(room_id)
            .filter(|cover| cover.stops)
            .and_then(|cover| {
                cover.stops = false;
                cover.resume.take()
            })
        else {
            return false;
        };
        self.advance(room_id, Some(token));
        self.resumed.insert(room_id.clone());
        true
    }

    fn reject_shared_resume(&mut self, room_id: &RoomId) -> bool {
        if !self.resumed.remove(room_id) {
            return false;
        }
        self.tokens.remove(room_id);
        self.covered.remove(room_id);
        self.anchored.remove(room_id);
        self.frontiers.remove(room_id);
        self.exhausted.remove(room_id);
        self.reached_start.remove(room_id);
        self.saved.remove(room_id);
        self.changed = true;
        true
    }

    pub(super) fn cover(&mut self, room_id: &OwnedRoomId, cover: Cover) {
        if self.covered.get(room_id) != Some(&cover) {
            self.covered.insert(room_id.clone(), cover);
            self.anchored.remove(room_id);
            self.changed = true;
        }
    }

    fn changed_checkpoints(&mut self) -> Option<BTreeMap<OwnedRoomId, StoredCrawlRoom>> {
        if !self.changed {
            return None;
        }
        self.changed = false;
        Some(self.checkpoints())
    }

    pub(super) fn restore(&mut self, rooms: BTreeMap<OwnedRoomId, StoredCrawlRoom>) {
        self.changed = false;
        self.saved.clone_from(&rooms);
        for (room_id, room) in rooms {
            if room.shared_resume {
                self.resumed.insert(room_id.clone());
            }
            if let Some(frontier) = room.frontier {
                self.frontiers.insert(room_id.clone(), frontier);
            }
            if room.gapped {
                self.gapped.insert(room_id.clone());
            }
            if let Some(cover) = room.cover {
                self.covered.insert(room_id.clone(), cover);
            }
            if let Some(hole) = room.hole {
                self.holes.insert(room_id.clone(), hole);
            }
            if room.reached_start {
                self.exhausted.insert(room_id.clone());
                self.reached_start.insert(room_id);
            } else if room.token.is_some() {
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

    pub(super) fn forget(&mut self, room_id: &RoomId) {
        self.reached_start.remove(room_id);
        self.exhausted.remove(room_id);
        self.failed.remove(room_id);
        self.visits.remove(room_id);
        self.tokens.remove(room_id);
        self.frontiers.remove(room_id);
        self.resumed.remove(room_id);
        self.gapped.remove(room_id);
        self.holes.remove(room_id);
        self.anchored.remove(room_id);
        self.covered.remove(room_id);
        self.probed.remove(room_id);
        self.blind.remove(room_id);
        self.stalled.remove(room_id);
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
        self.events = self.tuning.max_events as usize;
    }
}

impl SignedIn {
    pub(crate) fn watch_search_crawl(&self) {
        let core = self.clone();

        self.track_session_task(spawn(async move { core.crawl().await }).abort_on_drop());
    }

    async fn crawl(self) {
        let mut reported: Option<(SearchCoverageView, web_time::Instant)> = None;

        let stored = persist::load_crawl(&self.search_store().await).await;
        {
            let mut progress = self.state().search_crawl.lock();
            progress.restore(stored.rooms);
            progress.metrics.started_ms.get_or_insert_with(now_ms);
        }

        self.report_coverage(&mut reported).await;
        if self.discovering_peers() {
            let deadline = web_time::Instant::now() + DISCOVERY;
            while self.discovering_peers() && web_time::Instant::now() < deadline {
                matrix_sdk::sleep::sleep(Duration::from_millis(100)).await;
            }
        }

        loop {
            self.report_coverage(&mut reported).await;

            if self.held_back().await {
                continue;
            }

            let Some(room_id) = self.next_room_to_crawl().await else {
                self.save_changed_checkpoints().await;
                self.state()
                    .search_crawl
                    .lock()
                    .enter(SearchCrawlPhase::Idle);
                matrix_sdk::sleep::sleep(CRAWL_IDLE).await;
                continue;
            };

            {
                let mut progress = self.state().search_crawl.lock();
                let phase = if progress.trickling() {
                    SearchCrawlPhase::Trickling
                } else {
                    SearchCrawlPhase::Crawling
                };
                progress.enter(phase);
            }
            let pause = match self.crawl_once(&room_id).await {
                Ok(CrawlOutcome::Paused) => continue,
                Ok(CrawlOutcome::Unwritten) => CRAWL_IDLE,
                Ok(CrawlOutcome::Batch(outcome)) if outcome.reached_start => {
                    let mut progress = self.state().search_crawl.lock();
                    progress.steady(&room_id);
                    progress.settle(room_id, outcome.exhausted);
                    outcome.pause(&progress.tuning)
                }
                Ok(CrawlOutcome::Batch(outcome)) => {
                    let mut progress = self.state().search_crawl.lock();
                    progress.steady(&room_id);
                    if progress.blinded(&room_id, outcome.undecryptable) {
                        progress.settle(room_id, false);
                    }
                    outcome.pause(&progress.tuning)
                }
                Err(error) => {
                    if let Some(delay) = self.settle_pushback(&room_id, &error) {
                        self.state()
                            .search_crawl
                            .lock()
                            .enter(SearchCrawlPhase::BackingOff);
                        matrix_sdk::sleep::sleep(delay).await;
                        continue;
                    }
                    CRAWL_PAUSE
                }
            };

            let pause = self.state().search_crawl.lock().paced(pause);
            matrix_sdk::sleep::sleep(pause).await;
        }
    }

    /// Waits out whatever keeps the crawler from its next room, and says whether it did.
    async fn held_back(&self) -> bool {
        if !self.core().activity.app_active() {
            self.save_changed_checkpoints().await;
            self.state()
                .search_crawl
                .lock()
                .enter(SearchCrawlPhase::Paused);
            self.core().wait_until_active().await;
            return true;
        }

        if !self.state().search_index.lock().await.ready() {
            self.state()
                .search_crawl
                .lock()
                .enter(SearchCrawlPhase::Idle);
            matrix_sdk::sleep::sleep(CRAWL_IDLE).await;
            return true;
        }

        if !self
            .core()
            .settings
            .search_crawler_enabled
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            self.state()
                .search_crawl
                .lock()
                .enter(SearchCrawlPhase::Idle);
            matrix_sdk::sleep::sleep(CRAWL_IDLE).await;
            return true;
        }

        if !self.checkpoint_batch_open() {
            self.save_changed_checkpoints().await;
        }

        if !self.core().search_crawl_active() {
            self.save_changed_checkpoints().await;
            self.state()
                .search_crawl
                .lock()
                .enter(SearchCrawlPhase::Paused);
            if self.core().activity.app_active() {
                matrix_sdk::sleep::sleep(CRAWL_PAUSE).await;
            } else {
                self.core().wait_until_active().await;
            }
            return true;
        }

        if self.core().foreground_paginations() > 0 {
            self.state()
                .search_crawl
                .lock()
                .enter(SearchCrawlPhase::Yielding);
            matrix_sdk::sleep::sleep(CRAWL_PAUSE).await;
            return true;
        }

        let spent = self.state().search_crawl.lock().spent();
        let full = self.state().search_index.lock().await.is_full().await;
        if spent || full {
            self.save_changed_checkpoints().await;
            self.state().search_crawl.lock().enter(if spent {
                SearchCrawlPhase::BudgetSpent
            } else {
                SearchCrawlPhase::IndexFull
            });
            matrix_sdk::sleep::sleep(CRAWL_IDLE).await;
            return true;
        }

        false
    }

    pub(super) async fn save_changed_checkpoints(&self) {
        let Some(checkpoints) = self.state().search_crawl.lock().changed_checkpoints() else {
            return;
        };
        if checkpoints == self.state().search_crawl.lock().saved {
            return;
        }
        if persist::save_crawl(&self.search_store().await, checkpoints.clone()).await {
            let mut progress = self.state().search_crawl.lock();
            progress.saved = checkpoints;
            progress.checkpointed = Some(web_time::Instant::now());
            #[cfg(test)]
            {
                progress.checkpoint_writes += 1;
            }
        } else {
            self.state().search_crawl.lock().changed = true;
        }
    }

    async fn report_coverage(
        &self,
        reported: &mut Option<(SearchCoverageView, web_time::Instant)>,
    ) {
        let coverage = self.search_coverage().await;
        if let Some((last, at)) = reported.as_ref() {
            let progress_only =
                last.state == coverage.state && last.rooms_failed == coverage.rooms_failed;
            if *last == coverage || (progress_only && at.elapsed() < COVERAGE_PROGRESS_INTERVAL) {
                return;
            }
        }
        *reported = Some((coverage, web_time::Instant::now()));
        self.core().emit(CoreEvent::SearchCoverage { coverage });
    }

    pub(crate) async fn search_coverage(&self) -> SearchCoverageView {
        let client = self.client();
        let session_state = self.state();
        let index = session_state.search_index.lock().await;
        let documents = index.documents().await;
        let full = index.is_full().await;
        drop(index);

        let joined = client.joined_rooms();
        let progress = self.state().search_crawl.lock();
        let rooms_pending = joined
            .iter()
            .filter(|room| !progress.skips(room.room_id()))
            .count();
        let rooms_failed = progress.failed.len();
        let rooms_blind = progress.blind_rooms();
        let stopped = full
            || progress.spent()
            || !self
                .core()
                .settings
                .search_crawler_enabled
                .load(std::sync::atomic::Ordering::Relaxed);
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

    pub(crate) async fn search_metrics(&self) -> SearchMetricsView {
        let client = self.client();
        let session_state = self.state();
        let index = session_state.search_index.lock().await;
        let stats = index.stats().await.unwrap_or_default();
        let disk_budget = index.disk_budget();
        let rooms_indexed = index.rooms().await.len();
        drop(index);

        let rooms = client.joined_rooms();
        let progress = self.state().search_crawl.lock();
        let metrics = &progress.metrics;

        SearchMetricsView {
            phase: metrics.phase,
            documents: stats.documents,
            documents_loaded: stats.documents,
            memory_bytes: stats.memory_used,
            memory_budget: stats.memory_budget,
            disk_bytes: stats.disk,
            disk_index_bytes: stats.disk_index,
            disk_bookkeeping_bytes: stats.disk_bookkeeping,
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
            events_crawled: progress.events,
            event_budget: progress.tuning.max_events as usize,
            batches: metrics.batches,
            pushbacks: metrics.pushbacks,
            last_request_ms: metrics.last_request_ms,
            average_request_ms: metrics.average_request_ms(),
            running_ms: metrics
                .started_ms
                .map(|started| now_ms().saturating_sub(started)),
            sharing: self.search_sharing_view(),
        }
    }

    pub(super) async fn next_room_to_crawl(&self) -> Option<OwnedRoomId> {
        let client = self.client();
        let rooms = client.joined_rooms();
        self.settle_one_encryption_state(&rooms).await;

        let candidates: Vec<(&RoomId, bool, usize, bool)> = {
            let progress = self.state().search_crawl.lock();
            let tiered = rooms.iter().all(|room| {
                !room.encryption_state().is_unknown() || progress.probed.contains(room.room_id())
            });

            rooms
                .iter()
                .filter(|room| {
                    !progress.skips(room.room_id())
                        && !self.state().search_peers.restoring(room.room_id())
                })
                .map(|room| {
                    (
                        room.room_id(),
                        tiered && crawls_first(room),
                        progress.visits.get(room.room_id()).copied().unwrap_or(0),
                        progress.holes.contains_key(room.room_id()),
                    )
                })
                .collect()
        };

        let session_state = self.state();
        let index = session_state.search_index.lock().await;
        let mut ranked = Vec::with_capacity(candidates.len());
        for (room_id, first, visits, holed) in candidates {
            ranked.push((
                (
                    !holed,
                    !first,
                    visits,
                    Reverse(index.newest_in(room_id).await),
                ),
                room_id,
            ));
        }
        ranked
            .into_iter()
            .min_by(|(left, _), (right, _)| left.cmp(right))
            .map(|(_, room_id)| room_id.to_owned())
    }

    async fn crawl_page(
        &self,
        room: &Room,
        request: get_message_events::v3::Request,
    ) -> matrix_sdk::Result<CrawlPage> {
        let response = room.client().send(request).await?;
        let mut chunk = Vec::with_capacity(response.chunk.len());
        for event in response.chunk {
            chunk.push(self.crawl_event(room, event).await);
        }
        Ok(CrawlPage {
            chunk,
            end: response.end,
        })
    }

    pub(super) async fn crawl_once(
        &self,
        room_id: &OwnedRoomId,
    ) -> matrix_sdk::Result<CrawlOutcome> {
        let client = self.client();
        let hole = self.state().search_crawl.lock().holes.get(room_id).cloned();
        let Some(hole) = hole else {
            return self.crawl_back(room_id).await;
        };
        let event_cache = client
            .event_cache()
            .ok_or_else(|| matrix_sdk::Error::UnknownError("event cache is disabled".into()))?;
        let Some(room) = client.get_room(room_id) else {
            return Ok(CrawlOutcome::gone());
        };
        self.fill_hole(event_cache, &room, hole).await
    }

    async fn crawl_back(&self, room_id: &OwnedRoomId) -> matrix_sdk::Result<CrawlOutcome> {
        let client = self.client();
        let event_cache = client
            .event_cache()
            .ok_or_else(|| matrix_sdk::Error::UnknownError("event cache is disabled".into()))?;
        let Some(room) = client.get_room(room_id) else {
            return Ok(CrawlOutcome::gone());
        };

        let (from, batch, stop) = {
            let progress = self.state().search_crawl.lock();
            (
                progress.token_or(room_id, room.last_prev_batch()),
                progress.tuning.batch,
                progress.stop_at(room_id),
            )
        };

        let mut request =
            get_message_events::v3::Request::new(room_id.clone(), Direction::Backward);
        request.from = from;
        request.limit = UInt::from(batch);
        request.filter.not_types = vec!["m.reaction".to_owned()];
        let requested = now_ms();
        let Some(messages) = self
            .core()
            .search_network
            .run(self.crawl_page(&room, request))
            .await
        else {
            return Ok(CrawlOutcome::Paused);
        };
        let messages = messages?;

        {
            let mut progress = self.state().search_crawl.lock();
            progress.visit(room_id);
            progress.metrics.request(now_ms().saturating_sub(requested));
        }
        if room.state() != RoomState::Joined {
            return Ok(CrawlOutcome::gone());
        }

        if let Some(outcome) = self.below_floor(room_id, &messages.chunk, stop).await {
            return Ok(outcome);
        }

        let undecryptable = if messages.chunk.iter().all(|event| event.kind.is_utd()) {
            messages.chunk.len()
        } else {
            0
        };
        let outcome = CrawlBatch {
            reached_start: messages.end.is_none() || messages.chunk.is_empty(),
            exhausted: messages.end.is_none(),
            undecryptable,
            readable: !messages.chunk.iter().any(|event| event.kind.is_utd()),
        };

        if messages.chunk.is_empty() {
            self.state()
                .search_crawl
                .lock()
                .advance(room_id, messages.end);
        } else {
            let (cache, _drop_handles) = event_cache.room(room_id).await?;
            let rules = room.clone_info().room_version_rules_or_default().redaction;
            let gap = messages.chunk.iter().any(|event| event.kind.is_utd());
            let frontier = messages
                .chunk
                .iter()
                .filter_map(|event| event.timestamp_raw().map(|ts| u64::from(ts.get())))
                .min();
            let bans = super::ban::bans_in(&messages.chunk);
            let mut events = messages.chunk;
            events.reverse();

            let Some(fresh) = self.ingest_page(room_id, events, &cache, &rules).await else {
                return Ok(CrawlOutcome::Unwritten);
            };

            {
                let mut progress = self.state().search_crawl.lock();
                progress.advance(room_id, messages.end);
                if gap {
                    progress.gapped.insert(room_id.clone());
                }
                if !progress.gapped.contains(room_id)
                    && let Some(frontier) = frontier
                {
                    progress
                        .frontiers
                        .entry(room_id.clone())
                        .and_modify(|previous| *previous = (*previous).min(frontier))
                        .or_insert(frontier);
                }
                progress.events = progress.events.saturating_add(fresh);
            }
            self.settle_bans(&room, bans).await;
            self.refetch_unedited(&room, &cache, &rules).await;
        }

        Ok(CrawlOutcome::Batch(outcome))
    }

    async fn below_floor(
        &self,
        room_id: &OwnedRoomId,
        chunk: &[TimelineEvent],
        stop: u64,
    ) -> Option<CrawlOutcome> {
        let floor = self
            .state()
            .search_index
            .lock()
            .await
            .floor_of(room_id)
            .await
            .max(now_ms().saturating_sub(CRAWL_MAX_AGE_MS));
        let below = |floor: u64| {
            floor > 0
                && !chunk.is_empty()
                && chunk.iter().all(|event| {
                    event
                        .timestamp_raw()
                        .is_some_and(|ts| u64::from(ts.get()) < floor)
                })
        };
        let anchor = self
            .state()
            .search_crawl
            .lock()
            .cover_of(room_id)
            .filter(|cover| cover.stops)
            .and_then(|cover| cover.anchor.clone());
        if let Some(anchor) = anchor {
            let mut progress = self.state().search_crawl.lock();
            if progress.anchored.contains(room_id) {
                let jumped = progress.jump(room_id);
                return Some(CrawlOutcome::Batch(CrawlBatch {
                    reached_start: !jumped,
                    exhausted: !jumped,
                    undecryptable: 0,
                    readable: true,
                }));
            }
            if chunk
                .iter()
                .any(|event| event.event_id() == Some(anchor.as_ref()))
            {
                progress.anchored.insert(room_id.clone());
            }
            return below(floor).then_some(CrawlOutcome::Batch(CrawlBatch {
                reached_start: true,
                exhausted: true,
                undecryptable: 0,
                readable: true,
            }));
        }
        if !below(floor) && below(stop) && self.state().search_crawl.lock().jump(room_id) {
            return Some(CrawlOutcome::Batch(CrawlBatch {
                reached_start: false,
                exhausted: false,
                undecryptable: 0,
                readable: true,
            }));
        }
        below(floor.max(stop)).then_some(CrawlOutcome::Batch(CrawlBatch {
            reached_start: true,
            exhausted: true,
            undecryptable: 0,
            readable: true,
        }))
    }

    async fn ingest_page(
        &self,
        room_id: &OwnedRoomId,
        events: Vec<TimelineEvent>,
        cache: &matrix_sdk::event_cache::RoomEventCache,
        rules: &ruma::room_version_rules::RedactionRules,
    ) -> Option<usize> {
        self.state().search_crawl.lock().ingesting = Some(room_id.clone());
        let ingested = self
            .state()
            .search_index
            .lock()
            .await
            .ingest_with(room_id, events, cache, rules, true)
            .await;
        self.state().search_crawl.lock().ingesting = None;
        ingested
            .inspect_err(|error| {
                warn!(%room_id, "the search index could not take a crawled page: {error}");
            })
            .ok()
    }

    fn checkpoint_batch_open(&self) -> bool {
        self.state()
            .search_crawl
            .lock()
            .checkpointed
            .is_some_and(|at| at.elapsed() < CHECKPOINT_INTERVAL)
    }

    fn close_hole(&self, room_id: &OwnedRoomId) -> CrawlOutcome {
        let mut progress = self.state().search_crawl.lock();
        progress.holes.remove(room_id);
        progress.changed = true;
        CrawlOutcome::Batch(CrawlBatch {
            reached_start: false,
            exhausted: false,
            undecryptable: 0,
            readable: true,
        })
    }

    async fn crawl_event(&self, room: &Room, event: Raw<AnyTimelineEvent>) -> TimelineEvent {
        let Some(session_id) = megolm_session(&event) else {
            return TimelineEvent::from_plaintext(event.cast());
        };
        let session = (room.room_id().to_owned(), session_id);
        if self
            .state()
            .search_crawl
            .lock()
            .lost_sessions
            .contains(&session)
        {
            return TimelineEvent::from_utd(
                event.cast(),
                UnableToDecryptInfo {
                    session_id: Some(session.1),
                    reason: UnableToDecryptReason::MissingMegolmSession {
                        withheld_code: None,
                    },
                },
            );
        }
        let result = room
            .decrypt_event_without_key_request(event.cast_ref_unchecked())
            .await;
        if result
            .as_ref()
            .is_ok_and(|decrypted| decrypted.kind.is_utd())
        {
            self.state()
                .search_crawl
                .lock()
                .lost_sessions
                .insert(session);
        }
        decrypted_or_utd(event, result)
    }

    async fn settle_one_encryption_state(&self, rooms: &[Room]) {
        let unsettled = {
            let progress = self.state().search_crawl.lock();
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

        let Some(result) = self
            .core()
            .search_network
            .run(room.request_encryption_state())
            .await
        else {
            return;
        };
        self.state()
            .search_crawl
            .lock()
            .probed
            .insert(room.room_id().to_owned());

        if let Err(error) = result {
            warn!(room_id = %room.room_id(), "could not settle a room's encryption state: {error}");
        }
    }

    fn settle_pushback(
        &self,
        room_id: &OwnedRoomId,
        error: &matrix_sdk::Error,
    ) -> Option<Duration> {
        let mut progress = self.state().search_crawl.lock();
        if error
            .as_client_api_error()
            .is_some_and(|api| api.status_code.as_u16() == 400)
            && progress.reject_shared_resume(room_id)
        {
            return Some(Duration::ZERO);
        }

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
}

impl SignedIn {
    /// Pages forward from the newest event indexed before a limited sync until
    /// the batch that sync delivered, which the live pass has indexed already.
    async fn fill_hole(
        &self,
        event_cache: &matrix_sdk::event_cache::EventCache,
        room: &Room,
        hole: Hole,
    ) -> matrix_sdk::Result<CrawlOutcome> {
        let room_id = room.room_id().to_owned();
        let from = if let Some(token) = hole.token.clone() {
            token
        } else {
            let Some(context) = self
                .core()
                .search_network
                .run(room.event_with_context(&hole.anchor, false, UInt::MIN, None))
                .await
            else {
                return Ok(CrawlOutcome::Paused);
            };
            match context.map(|context| context.next_batch_token) {
                Ok(Some(token)) => token,
                Ok(None) => return Ok(self.close_hole(&room_id)),
                Err(error)
                    if error
                        .as_client_api_error()
                        .is_some_and(|api| api.status_code.as_u16() == 404) =>
                {
                    return Ok(self.close_hole(&room_id));
                }
                Err(error) => return Err(error),
            }
        };

        let batch = self.state().search_crawl.lock().tuning.batch;
        let mut request = get_message_events::v3::Request::new(room_id.clone(), Direction::Forward);
        request.from = Some(from);
        request.limit = UInt::from(batch);
        request.filter.not_types = vec!["m.reaction".to_owned()];
        let requested = now_ms();
        let Some(messages) = self
            .core()
            .search_network
            .run(self.crawl_page(room, request))
            .await
        else {
            return Ok(CrawlOutcome::Paused);
        };
        let messages = messages?;
        {
            let mut progress = self.state().search_crawl.lock();
            progress.visit(&room_id);
            progress.metrics.request(now_ms().saturating_sub(requested));
        }
        if room.state() != RoomState::Joined {
            return Ok(CrawlOutcome::gone());
        }

        let closed = messages.end.is_none()
            || messages.chunk.is_empty()
            || messages
                .chunk
                .iter()
                .any(|event| event.event_id() == Some(hole.until.as_ref()));
        let gap = messages.chunk.iter().any(|event| event.kind.is_utd());
        let readable = !gap;
        let bans = super::ban::bans_in(&messages.chunk);
        let (cache, _drop_handles) = event_cache.room(&room_id).await?;
        let rules = room.clone_info().room_version_rules_or_default().redaction;

        let Some(fresh) = self
            .ingest_page(&room_id, messages.chunk, &cache, &rules)
            .await
        else {
            return Ok(CrawlOutcome::Unwritten);
        };
        {
            let mut progress = self.state().search_crawl.lock();
            if gap {
                progress.gapped.insert(room_id.clone());
            }
            progress.events = progress.events.saturating_add(fresh);
            progress.changed = true;
            if closed {
                progress.holes.remove(&room_id);
            } else if let Some(open) = progress.holes.get_mut(&room_id) {
                open.token = messages.end;
            }
        }
        self.settle_bans(room, bans).await;
        self.refetch_unedited(room, &cache, &rules).await;

        Ok(CrawlOutcome::Batch(CrawlBatch {
            reached_start: false,
            exhausted: false,
            undecryptable: 0,
            readable,
        }))
    }
}

pub(super) enum CrawlOutcome {
    Paused,
    Unwritten,
    Batch(CrawlBatch),
}

pub(super) struct CrawlBatch {
    pub(super) reached_start: bool,
    pub(super) exhausted: bool,
    pub(super) undecryptable: usize,
    pub(super) readable: bool,
}

impl CrawlOutcome {
    const fn gone() -> Self {
        Self::Batch(CrawlBatch {
            reached_start: true,
            exhausted: false,
            undecryptable: 0,
            readable: true,
        })
    }
}

impl CrawlBatch {
    fn pause(&self, tuning: &SearchTuning) -> Duration {
        let readable = Duration::from_millis(u64::from(tuning.crawl_pause_ms));
        if self.readable {
            readable
        } else {
            CRAWL_PAUSE.max(readable)
        }
    }
}

fn crawls_first(room: &Room) -> bool {
    !matches!(room.encryption_state(), EncryptionState::NotEncrypted)
        || room.direct_targets_length() > 0
}

struct CrawlPage {
    chunk: Vec<TimelineEvent>,
    end: Option<String>,
}

#[derive(serde::Deserialize)]
struct EncryptedContent {
    session_id: String,
}

fn megolm_session(event: &Raw<AnyTimelineEvent>) -> Option<String> {
    if event.get_field::<String>("type").ok().flatten().as_deref() != Some("m.room.encrypted") {
        return None;
    }
    event
        .get_field::<EncryptedContent>("content")
        .ok()
        .flatten()
        .map(|content| content.session_id)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use matrix_sdk::ruma::{OwnedRoomId, room_id, user_id};
    use matrix_sdk::test_utils::mocks::{MatrixMockServer, RoomMessagesResponseTemplate};
    use matrix_sdk_test::{JoinedRoomBuilder, async_test, event_factory::EventFactory};

    use std::collections::BTreeMap;

    use super::super::persist::StoredCrawlRoom;
    use super::{
        BLIND_EVENTS_BEFORE_SKIP, CRAWL_BACKOFF_CAP, CRAWL_BASE_EVENTS, CRAWL_BATCH, CRAWL_PAUSE,
        CRAWL_READABLE_PAUSE, CRAWL_TRICKLE_PAUSE, CrawlBatch, CrawlOutcome, CrawlProgress,
        MAX_CRAWLED_EVENTS, PUSHBACKS_BEFORE_SKIP, decrypted_or_utd,
    };

    #[test]
    fn test_a_decrypt_error_is_retried_like_an_undecryptable_event() {
        let event = serde_json::from_value(serde_json::json!({
            "type": "m.room.encrypted",
            "event_id": "$failed",
            "sender": "@alice:localhost",
            "origin_server_ts": 1_000,
            "room_id": "!crawled:localhost",
            "content": {
                "algorithm": "m.megolm.v1.aes-sha2",
                "session_id": "session",
                "ciphertext": "x"
            }
        }))
        .expect("raw event");

        let failed = decrypted_or_utd(
            event,
            Err(matrix_sdk::Error::UnknownError("store failure".into())),
        );

        assert!(failed.kind.is_utd());
    }

    fn room() -> OwnedRoomId {
        room_id!("!crawled:localhost").to_owned()
    }

    fn outcome(readable: bool) -> CrawlBatch {
        CrawlBatch {
            reached_start: false,
            exhausted: false,
            undecryptable: 0,
            readable,
        }
    }

    #[test]
    fn test_tuning_is_clamped_so_the_crawl_cannot_be_driven_out_of_bounds() {
        let wild = crate::api::session::SearchTuning {
            crawl_pause_ms: 0,
            trickle_pause_ms: u32::MAX,
            flush_interval_secs: 0,
            batch: 5_000,
            base_events: 10,
            max_events: 1,
        };
        let tuning = wild.clamped();
        assert_eq!(tuning.crawl_pause_ms, 500);
        assert_eq!(tuning.trickle_pause_ms, 300_000);
        assert_eq!(tuning.flush_interval_secs, 10);
        assert_eq!(tuning.batch, u32::from(CRAWL_BATCH));
        assert!(tuning.max_events >= tuning.base_events);
        assert_eq!(
            crate::api::session::SearchTuning::default().clamped(),
            crate::api::session::SearchTuning::default()
        );
    }

    #[test]
    fn test_only_a_batch_with_an_undecryptable_event_earns_the_long_pause() {
        let tuning = crate::api::session::SearchTuning {
            crawl_pause_ms: 1_000,
            ..crate::api::session::SearchTuning::default()
        };
        assert_eq!(outcome(true).pause(&tuning), Duration::from_secs(1));
        assert_eq!(outcome(false).pause(&tuning), CRAWL_PAUSE);
        assert_eq!(
            outcome(true).pause(&crate::api::session::SearchTuning::default()),
            CRAWL_READABLE_PAUSE
        );
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
    fn test_a_slow_homeserver_stretches_the_pause() {
        let mut progress = CrawlProgress::default();
        assert_eq!(progress.paced(CRAWL_READABLE_PAUSE), CRAWL_READABLE_PAUSE);

        progress.metrics.last_request_ms = Some(800);
        assert_eq!(progress.paced(CRAWL_READABLE_PAUSE), Duration::from_secs(8));

        progress.metrics.last_request_ms = Some(u64::MAX / 100);
        assert_eq!(progress.paced(CRAWL_READABLE_PAUSE), CRAWL_BACKOFF_CAP);
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
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
        session
            .crawl_once(&room_id)
            .await
            .expect("the first batch should land");
        let Err(error) = session.crawl_once(&room_id).await else {
            panic!("the mocked server error should have surfaced");
        };
        session.settle_pushback(&room_id, &error);

        let metrics = session.search_metrics().await;
        assert_eq!(metrics.batches, 1);
        assert_eq!(metrics.pushbacks, 1);
        assert!(metrics.last_request_ms.is_some());
        assert_eq!(metrics.average_request_ms, metrics.last_request_ms);
        assert_eq!(metrics.rooms_joined, 1);
        assert_eq!(metrics.event_budget, MAX_CRAWLED_EVENTS);
    }

    fn encrypted(
        event_id: &str,
        session_id: &str,
    ) -> ruma::serde::Raw<ruma::events::AnyTimelineEvent> {
        ruma::serde::Raw::new(&serde_json::json!({
            "type": "m.room.encrypted",
            "event_id": event_id,
            "room_id": room(),
            "sender": "@bridge:localhost",
            "origin_server_ts": super::now_ms(),
            "content": {
                "algorithm": "m.megolm.v1.aes-sha2",
                "ciphertext": "AwgAEhAA",
                "device_id": "BRIDGE",
                "sender_key": "DeHIg4gwhClxzFYcmNntPNF9YtsdZbmMy8+3kzCMXHA",
                "session_id": session_id
            }
        }))
        .expect("event")
        .cast_unchecked()
    }

    #[async_test]
    async fn test_a_session_that_failed_once_is_not_decrypted_again() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room();
        server.sync_joined_room(&client, &room_id).await;
        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default()
                .events(vec![encrypted("$a", "lost"), encrypted("$b", "lost")])
                .end_token("older"))
            .mock_once()
            .mount()
            .await;
        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default()
                .events(vec![encrypted("$c", "lost")])
                .end_token("oldest"))
            .mock_once()
            .mount()
            .await;
        let (core, _events) = crate::Core::new(
            "crawl-lost-sessions",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();

        for _ in 0..2 {
            let Ok(CrawlOutcome::Batch(batch)) = session.crawl_once(&room_id).await else {
                panic!("the batch should land");
            };
            assert!(!batch.readable);
        }

        assert!(
            session
                .state()
                .search_crawl
                .lock()
                .lost_sessions
                .contains(&(room_id, "lost".to_owned()))
        );
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
    async fn test_disabling_the_crawler_stops_search_coverage() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let (core, _events) = crate::Core::new(
            "disabled-search-crawler",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
        core.settings
            .search_crawler_enabled
            .store(false, Ordering::Relaxed);

        let coverage = session.search_coverage().await;

        assert_eq!(
            coverage.state,
            crate::protocol::SearchCoverageState::Stopped
        );
    }

    #[async_test]
    async fn test_a_disabled_crawler_sleeps_until_the_app_is_active() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let (core, _events) = crate::Core::new(
            "inactive-disabled-search-crawler",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
        core.settings
            .search_crawler_enabled
            .store(false, Ordering::Relaxed);
        core.set_app_active(false);
        tokio::time::pause();

        let held = session.held_back();
        tokio::pin!(held);
        tokio::time::timeout(Duration::from_secs(300), &mut held)
            .await
            .expect_err("an inactive app keeps the crawler parked");

        core.set_app_active(true);
        assert!(held.await);
    }

    #[async_test]
    async fn test_metered_crawl_pauses_and_resumes() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room();
        server.sync_joined_room(&client, &room_id).await;
        server
            .mock_room_messages()
            .ok(RoomMessagesResponseTemplate::default().end_token("older"))
            .mock_once()
            .mount()
            .await;
        let (core, _events) = crate::Core::new(
            "metered-search-crawler",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();

        core.search_network.set_unmetered(false);
        session.crawl_once(&room_id).await.expect("paused crawl");
        assert_eq!(session.state().search_crawl.lock().metrics.batches, 0);
        assert!(session.state().search_crawl.lock().tokens.is_empty());

        core.search_network.set_unmetered(true);
        session.crawl_once(&room_id).await.expect("resumed crawl");
        assert_eq!(session.state().search_crawl.lock().metrics.batches, 1);

        server
            .mock_room_messages()
            .match_from("older")
            .ok(RoomMessagesResponseTemplate::default().end_token("oldest"))
            .mock_once()
            .mount()
            .await;
        core.search_network.set_unmetered(false);
        let outcome = session.crawl_once(&room_id).await.expect("paused again");
        assert!(matches!(outcome, CrawlOutcome::Paused));
        assert_eq!(session.state().search_crawl.lock().metrics.batches, 1);
        assert_eq!(
            session.state().search_crawl.lock().tokens[&room_id].as_deref(),
            Some("older")
        );

        core.search_network.set_unmetered_only(false);
        session.crawl_once(&room_id).await.expect("opted out");
        assert_eq!(session.state().search_crawl.lock().metrics.batches, 2);
        assert_eq!(
            session.state().search_crawl.lock().tokens[&room_id].as_deref(),
            Some("oldest")
        );
    }

    #[async_test]
    async fn test_metered_crawl_cancels_requests() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room();
        server.sync_joined_room(&client, &room_id).await;
        server
            .mock_room_messages()
            .with_delay(Duration::from_secs(30))
            .ok(RoomMessagesResponseTemplate::default().end_token("older"))
            .mock_once()
            .mount()
            .await;
        let (core, _events) = crate::Core::new(
            "metered-search-request",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
        core.search_network.set_unmetered(true);

        let switch_network = async {
            loop {
                let requests = server
                    .server()
                    .received_requests()
                    .await
                    .expect("recorded requests");
                if requests
                    .iter()
                    .any(|request| request.url.path().ends_with("/messages"))
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
            core.search_network.set_unmetered(false);
        };
        let (outcome, ()) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(session.crawl_once(&room_id), switch_network)
        })
        .await
        .expect("request cancelled before the response");

        assert!(matches!(
            outcome.expect("paused crawl"),
            CrawlOutcome::Paused
        ));
        let progress = session.state().search_crawl.lock();
        assert_eq!(progress.metrics.batches, 0);
        assert!(progress.tokens.is_empty());
        assert!(progress.failed.is_empty());
        assert!(progress.stalled.is_empty());
    }

    #[async_test]
    async fn test_a_room_without_a_cursor_starts_behind_what_sync_delivered() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
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
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();

        session
            .crawl_once(&room_id)
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
        let room_id = room();
        server.sync_joined_room(&client, &room_id).await;
        server.mock_room_messages().error500().mount().await;

        let (core, _events) = crate::Core::new(
            "crawl",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
        let Err(error) = session.crawl_once(&room_id).await else {
            panic!("the mocked server error should have surfaced");
        };

        assert!(session.settle_pushback(&room_id, &error).is_some());
        assert!(!session.state().search_crawl.lock().skips(&room_id));
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
    fn test_legacy_checkpoints_do_not_advertise_coverage() {
        for reached_start in [false, true] {
            let stored: StoredCrawlRoom = serde_json::from_value(serde_json::json!({
                "token": "t42",
                "frontier": 42,
                "reached_start": reached_start,
            }))
            .unwrap();
            let mut progress = CrawlProgress::default();
            progress.restore([(room(), stored)].into());
            assert_eq!(progress.share_boundary(&room()), (None, None));
        }
        let stored: StoredCrawlRoom = serde_json::from_value(serde_json::json!({
            "token": null,
            "reached_start": true,
            "gapped": false,
        }))
        .unwrap();
        let mut progress = CrawlProgress::default();
        progress.restore([(room(), stored)].into());
        assert_eq!(progress.share_boundary(&room()), (Some(0), None));
    }

    #[test]
    fn test_checkpoints_are_only_rewritten_when_they_change() {
        let mut progress = CrawlProgress::default();
        assert!(progress.changed_checkpoints().is_none());

        progress.advance(&room(), Some("next".to_owned()));
        assert!(progress.changed_checkpoints().is_some());
        assert!(progress.changed_checkpoints().is_none());

        progress.visit(&room());
        assert!(
            progress.changed_checkpoints().is_none(),
            "a visit is not a checkpoint"
        );
    }

    #[async_test]
    async fn test_an_idle_crawl_writes_no_checkpoints_and_a_busy_one_batches_them() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@kris:localhost"))
            .server_ts(super::now_ms());
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
            "crawl-quiescent",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
        session.crawl_once(&room_id).await.expect("crawl one batch");
        session.save_changed_checkpoints().await;
        assert_eq!(session.state().search_crawl.lock().checkpoint_writes, 1);
        assert!(session.checkpoint_batch_open(), "a busy crawl batches");

        for _ in 0..3 {
            session.save_changed_checkpoints().await;
        }
        session
            .crawl_once(&room_id)
            .await
            .expect("crawl the same batch again");
        session.save_changed_checkpoints().await;
        assert_eq!(
            session.state().search_crawl.lock().checkpoint_writes,
            1,
            "nothing new, so nothing is written"
        );

        drop(joined);
    }

    #[async_test]
    async fn test_the_crawl_stops_a_room_below_its_floor() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@kris:localhost"));
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
                    ruma::MilliSecondsSinceUnixEpoch(
                        ruma::UInt::try_from(super::now_ms() - 1_000).expect("a timestamp"),
                    ),
                )])
                .end_token("deeper"))
            .mount()
            .await;

        let (core, _events) = crate::Core::new(
            "crawl-floor",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
        {
            let session_state = session.state();
            let index = session_state.search_index.lock().await;
            crate::search::exec::block_on(index.store().set_floor(&room_id, super::now_ms()))
                .unwrap();
        }

        let outcome = session.crawl_once(&room_id).await.expect("crawl one batch");
        assert!(matches!(
            outcome,
            CrawlOutcome::Batch(CrawlBatch {
                exhausted: true,
                ..
            })
        ));
        assert_eq!(
            session.state().search_index.lock().await.documents().await,
            0
        );

        drop(joined);
    }

    #[async_test]
    async fn test_the_crawl_skips_history_received_from_a_peer() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@kris:localhost"));
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
                .events(vec![factory.text_msg("imported history").server_ts(
                    ruma::MilliSecondsSinceUnixEpoch(
                        ruma::UInt::try_from(super::now_ms() - 1_000).expect("a timestamp"),
                    ),
                )])
                .end_token("deeper"))
            .mount()
            .await;

        let (core, _events) = crate::Core::new(
            "crawl-covered",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
        session.state().search_crawl.lock().cover(
            &room_id,
            super::super::persist::Cover {
                anchor: None,
                from: 0,
                until: super::now_ms(),
                resume: None,
                stops: true,
            },
        );

        let outcome = session.crawl_once(&room_id).await.expect("crawl one batch");
        assert!(matches!(
            outcome,
            CrawlOutcome::Batch(CrawlBatch {
                exhausted: true,
                ..
            })
        ));
        assert_eq!(
            session.state().search_index.lock().await.documents().await,
            0
        );

        drop(joined);
    }

    #[async_test]
    async fn test_the_crawl_resumes_below_history_received_from_a_peer() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@kris:localhost"));
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
                .events(vec![factory.text_msg("imported history").server_ts(
                    ruma::MilliSecondsSinceUnixEpoch(
                        ruma::UInt::try_from(super::now_ms() - 1_000).expect("a timestamp"),
                    ),
                )])
                .end_token("deeper"))
            .mount()
            .await;

        let (core, _events) = crate::Core::new(
            "crawl-resume",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
        session.state().search_crawl.lock().cover(
            &room_id,
            super::super::persist::Cover {
                anchor: None,
                from: 0,
                until: super::now_ms(),
                resume: Some("resume-here".to_owned()),
                stops: true,
            },
        );

        let outcome = session.crawl_once(&room_id).await.expect("crawl one batch");
        assert!(matches!(
            outcome,
            CrawlOutcome::Batch(CrawlBatch {
                reached_start: false,
                ..
            })
        ));
        let progress = session.state().search_crawl.lock();
        assert_eq!(
            progress.token_or(&room_id, None).as_deref(),
            Some("resume-here")
        );
        assert_eq!(progress.stop_at(&room_id), 0);
        drop(progress);

        drop(joined);
    }

    #[async_test]
    async fn test_the_crawl_stops_a_room_older_than_its_age_limit() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let room_id = room();
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@kris:localhost"));
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
                    ruma::MilliSecondsSinceUnixEpoch(ruma::UInt::from(10_u32)),
                )])
                .end_token("deeper"))
            .mount()
            .await;

        let (core, _events) = crate::Core::new(
            "crawl-age",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
        {
            let session_state = session.state();
            let index = session_state.search_index.lock().await;
            index.ensure_room(&room_id);
        }

        let outcome = session.crawl_once(&room_id).await.expect("crawl one batch");
        assert!(matches!(
            outcome,
            CrawlOutcome::Batch(CrawlBatch {
                exhausted: true,
                ..
            })
        ));
        assert_eq!(
            session.state().search_index.lock().await.documents().await,
            0
        );

        drop(joined);
    }

    #[async_test]
    async fn test_a_room_that_is_gone_is_not_written_off_for_good() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let (core, _events) = crate::Core::new(
            "crawl-gone",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
        let outcome = session
            .crawl_once(&room())
            .await
            .expect("a missing room is not an error");

        assert!(
            matches!(
                outcome,
                CrawlOutcome::Batch(CrawlBatch {
                    reached_start: true,
                    exhausted: false,
                    ..
                })
            ),
            "a rejoin must walk the room again"
        );
    }

    #[async_test]
    async fn test_the_crawl_reaches_an_encrypted_room_before_one_the_server_can_search() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;

        let sender = user_id!("@kris:localhost");
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
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();

        {
            let mut progress = session.state().search_crawl.lock();
            progress.visit(&secret_id);
            progress.visit(&secret_id);
        }

        assert_eq!(
            session.next_room_to_crawl().await.as_ref(),
            Some(&secret_id),
            "the crawl is the only thing that can ever search an encrypted room"
        );

        session.state().search_crawl.lock().settle(secret_id, true);
        assert_eq!(
            session.next_room_to_crawl().await.as_ref(),
            Some(&plain_id),
            "a plain room is still crawled once the encrypted ones are done"
        );

        drop((plain, secret));
    }

    #[test]
    fn a_megolm_session_is_read_only_from_an_encrypted_event_with_a_string_id() {
        let event = |value: serde_json::Value| {
            super::Raw::<serde_json::Value>::new(&value)
                .unwrap()
                .cast_unchecked::<super::AnyTimelineEvent>()
        };
        let encrypted = |content: serde_json::Value| {
            event(serde_json::json!({"type": "m.room.encrypted", "content": content}))
        };
        assert_eq!(
            super::megolm_session(&encrypted(serde_json::json!({"session_id": "s"}))).as_deref(),
            Some("s")
        );
        assert_eq!(
            super::megolm_session(&encrypted(serde_json::json!({"session_id": 1}))),
            None
        );
        assert_eq!(
            super::megolm_session(&encrypted(serde_json::json!("x"))),
            None
        );
        assert_eq!(
            super::megolm_session(&event(
                serde_json::json!({"type": "m.room.message", "content": {"session_id": "s"}})
            )),
            None
        );
    }

    #[test]
    fn test_an_expired_shared_resume_token_restarts_from_the_live_timeline() {
        let room = matrix_sdk::ruma::room_id!("!resume:localhost").to_owned();
        let mut progress = CrawlProgress::default();
        progress.restore(BTreeMap::from([(
            room.clone(),
            StoredCrawlRoom {
                shared_resume: true,
                frontier: Some(10),
                gapped: false,
                token: Some("expired".into()),
                reached_start: false,
                cover: Some(super::Cover {
                    from: 10,
                    until: 20,
                    stops: false,
                    ..super::Cover::default()
                }),
                hole: None,
            },
        )]));
        assert!(progress.reject_shared_resume(&room));
        assert_eq!(
            progress.token_or(&room, Some("live".into())).as_deref(),
            Some("live")
        );
        assert!(progress.cover_of(&room).is_none());
        assert_eq!(progress.share_boundary(&room), (None, None));
        assert!(!progress.reject_shared_resume(&room));
    }
}
