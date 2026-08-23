use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::OwnedRoomId;
use tracing::warn;

use crate::Core;

const CRAWL_BATCH: u16 = 100;
const CRAWL_PAUSE: Duration = Duration::from_secs(2);
const CRAWL_IDLE: Duration = Duration::from_secs(30);
const MAX_CRAWLED_EVENTS: usize = 20_000;

#[derive(Default)]
pub(crate) struct CrawlProgress {
    reached_start: HashSet<OwnedRoomId>,
    failed: HashSet<OwnedRoomId>,
    ingesting: Option<OwnedRoomId>,
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

    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }
}

impl Core {
    pub(crate) fn watch_search_crawl(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let core = self.clone();
        let client = client.clone();

        self.track_session_task(spawn(async move { core.crawl(&client).await }).abort_on_drop());
    }

    async fn crawl(self: Arc<Self>, client: &matrix_sdk::Client) {
        loop {
            if self.search_crawl.lock().await.spent() || self.search_index.lock().await.is_full() {
                matrix_sdk::sleep::sleep(CRAWL_IDLE).await;
                continue;
            }

            let Some(room_id) = self.next_room_to_crawl(client).await else {
                matrix_sdk::sleep::sleep(CRAWL_IDLE).await;
                continue;
            };

            match self.crawl_once(client, &room_id).await {
                Ok(true) => {
                    self.search_crawl.lock().await.reached_start.insert(room_id);
                }
                Ok(false) => {}
                Err(error) => {
                    warn!(%room_id, "search crawl pagination failed: {error}");
                    self.search_crawl.lock().await.failed.insert(room_id);
                }
            }

            matrix_sdk::sleep::sleep(CRAWL_PAUSE).await;
        }
    }

    async fn next_room_to_crawl(&self, client: &matrix_sdk::Client) -> Option<OwnedRoomId> {
        let newest = self.search_index.lock().await.newest_per_room();
        let progress = self.search_crawl.lock().await;

        client
            .joined_rooms()
            .into_iter()
            .map(|room| room.room_id().to_owned())
            .filter(|room_id| !progress.skips(room_id))
            .max_by_key(|room_id| newest.get(room_id).copied().flatten())
    }

    pub(super) async fn crawl_once(
        &self,
        client: &matrix_sdk::Client,
        room_id: &OwnedRoomId,
    ) -> matrix_sdk::Result<bool> {
        let Some(room) = client.get_room(room_id) else {
            return Ok(true);
        };

        let (cache, _drop_handles) = client.event_cache().room(room_id).await?;
        let outcome = cache.pagination().run_backwards_once(CRAWL_BATCH).await?;

        if !outcome.events.is_empty() {
            let rules = room.clone_info().room_version_rules_or_default().redaction;
            let mut events = outcome.events;
            events.reverse();

            {
                let mut progress = self.search_crawl.lock().await;
                progress.events = progress.events.saturating_add(events.len());
                progress.ingesting = Some(room_id.clone());
            }

            self.search_index
                .lock()
                .await
                .ingest(room_id, events, &cache, &rules)
                .await;

            self.search_crawl.lock().await.ingesting = None;
        }

        Ok(outcome.reached_start)
    }
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
