use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::{OwnedRoomId, UInt};
use tracing::warn;

use super::persist::{self, StoredCrawlRoom};
use crate::Core;
use crate::protocol::{CoreEvent, SearchCoverageState, SearchCoverageView};

const CRAWL_BATCH: u16 = 100;
const CRAWL_PAUSE: Duration = Duration::from_secs(3);
const CRAWL_IDLE: Duration = Duration::from_secs(30);
const MAX_CRAWLED_EVENTS: usize = 20_000;

#[derive(Default)]
pub(crate) struct CrawlProgress {
    reached_start: HashSet<OwnedRoomId>,
    exhausted: HashSet<OwnedRoomId>,
    failed: HashSet<OwnedRoomId>,
    ingesting: Option<OwnedRoomId>,
    visits: HashMap<OwnedRoomId, usize>,
    tokens: HashMap<OwnedRoomId, Option<String>>,
    events: usize,
}

impl CrawlProgress {
    fn skips(&self, room_id: &OwnedRoomId) -> bool {
        self.reached_start.contains(room_id) || self.failed.contains(room_id)
    }

    const fn spent(&self) -> bool {
        self.events >= MAX_CRAWLED_EVENTS
    }

    pub(crate) fn is_ingesting(&self, room_id: &OwnedRoomId) -> bool {
        self.ingesting.as_ref() == Some(room_id)
    }

    fn visit(&mut self, room_id: &OwnedRoomId) {
        *self.visits.entry(room_id.clone()).or_default() += 1;
    }

    pub(super) fn settle(&mut self, room_id: OwnedRoomId, exhausted: bool) {
        self.tokens.remove(&room_id);
        if exhausted {
            self.exhausted.insert(room_id.clone());
        }
        self.reached_start.insert(room_id);
    }

    fn token(&self, room_id: &OwnedRoomId) -> Option<String> {
        self.tokens.get(room_id).cloned().flatten()
    }

    fn advance(&mut self, room_id: &OwnedRoomId, token: Option<String>) {
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

    pub(super) fn restore(&mut self, rooms: BTreeMap<OwnedRoomId, StoredCrawlRoom>) {
        for (room_id, room) in rooms {
            if room.reached_start {
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

    pub(crate) fn reset(&mut self) {
        *self = Self::default();
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
        self.search_crawl.lock().await.restore(stored.rooms);

        loop {
            self.report_coverage(client, &mut reported).await;

            if self.foreground_paginations() > 0 {
                matrix_sdk::sleep::sleep(CRAWL_PAUSE).await;
                continue;
            }

            let spent = self.search_crawl.lock().await.spent();
            let full = self.search_index.lock().await.is_full();

            if spent || full {
                matrix_sdk::sleep::sleep(CRAWL_IDLE).await;
                continue;
            }

            let Some(room_id) = self.next_room_to_crawl(client).await else {
                matrix_sdk::sleep::sleep(CRAWL_IDLE).await;
                continue;
            };

            match self.crawl_once(client, &room_id).await {
                Ok(outcome) if outcome.reached_start => {
                    self.search_crawl
                        .lock()
                        .await
                        .settle(room_id, outcome.exhausted);
                }
                Ok(_) => {}
                Err(error) => {
                    warn!(%room_id, "search crawl pagination failed: {error}");
                    self.search_crawl.lock().await.fail(room_id);
                }
            }

            let checkpoints = self.search_crawl.lock().await.checkpoints();
            persist::save_crawl(client, checkpoints).await;

            matrix_sdk::sleep::sleep(CRAWL_PAUSE).await;
        }
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
        let documents = index.documents();
        let full = index.is_full();
        drop(index);

        let progress = self.search_crawl.lock().await;
        let rooms_pending = client
            .joined_rooms()
            .into_iter()
            .filter(|room| !progress.skips(&room.room_id().to_owned()))
            .count();
        let rooms_failed = progress.failed.len();
        let stopped = full || progress.spent();
        drop(progress);

        let state = if stopped {
            SearchCoverageState::Stopped
        } else if rooms_pending > 0 {
            SearchCoverageState::Indexing
        } else if rooms_failed > 0 {
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

    pub(super) async fn next_room_to_crawl(
        &self,
        client: &matrix_sdk::Client,
    ) -> Option<OwnedRoomId> {
        let newest = self.search_index.lock().await.newest_per_room();
        let progress = self.search_crawl.lock().await;

        client
            .joined_rooms()
            .into_iter()
            .map(|room| room.room_id().to_owned())
            .filter(|room_id| !progress.skips(room_id))
            .min_by_key(|room_id| {
                (
                    progress.visits.get(room_id).copied().unwrap_or(0),
                    Reverse(newest.get(room_id).copied().flatten()),
                )
            })
    }

    pub(super) async fn crawl_once(
        &self,
        client: &matrix_sdk::Client,
        room_id: &OwnedRoomId,
    ) -> matrix_sdk::Result<CrawlOutcome> {
        let Some(room) = client.get_room(room_id) else {
            return Ok(CrawlOutcome {
                reached_start: true,
                exhausted: true,
            });
        };

        let from = self.search_crawl.lock().await.token(room_id);

        let mut options = MessagesOptions::backward().from(from.as_deref());
        options.limit = UInt::from(CRAWL_BATCH);
        let messages = room.messages(options).await?;

        self.search_crawl.lock().await.visit(room_id);
        let outcome = CrawlOutcome {
            reached_start: messages.end.is_none() || messages.chunk.is_empty(),
            exhausted: messages.end.is_none(),
        };
        self.search_crawl
            .lock()
            .await
            .advance(room_id, messages.end);

        if !messages.chunk.is_empty() {
            let (cache, _drop_handles) = client.event_cache().room(room_id).await?;
            let rules = room.clone_info().room_version_rules_or_default().redaction;
            let mut events = messages.chunk;
            events.reverse();

            self.search_crawl.lock().await.ingesting = Some(room_id.clone());

            let fresh = self
                .search_index
                .lock()
                .await
                .ingest(room_id, events, &cache, &rules)
                .await;

            let mut progress = self.search_crawl.lock().await;
            progress.ingesting = None;
            progress.events = progress.events.saturating_add(fresh);
        }

        Ok(outcome)
    }
}

pub(super) struct CrawlOutcome {
    pub(super) reached_start: bool,
    pub(super) exhausted: bool,
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use matrix_sdk::ruma::{OwnedRoomId, room_id};

    use super::{CrawlProgress, MAX_CRAWLED_EVENTS};

    fn room() -> OwnedRoomId {
        room_id!("!crawled:localhost").to_owned()
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
}
