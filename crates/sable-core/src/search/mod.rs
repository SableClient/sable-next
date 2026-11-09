mod chunks;
mod core_api;
mod crawl;
mod document;
mod index;
mod inverted;
mod network;
mod sharing;
pub(crate) use network::CrawlNetwork;
mod dictionary;
mod filter;
#[cfg(target_family = "wasm")]
mod idb;
mod persist;
mod server;
mod tokenize;

pub(crate) const MAX_SEARCH_RESULTS: usize = 200;

pub(crate) use core_api::save_index;
pub(crate) use crawl::CrawlProgress;
pub(crate) use filter::IndexFilter;
#[cfg(not(target_family = "wasm"))]
pub(crate) use persist::reset_state_cache;
pub(crate) use server::ServerSearch;
pub(crate) use sharing::SearchSharing;

use crate::now_ms;
use std::time::Duration;

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::ruma::events::ignored_user_list::IgnoredUserListEventContent;
use matrix_sdk::ruma::events::room::message::{OriginalSyncRoomMessageEvent, Relation};
use matrix_sdk::ruma::events::room::redaction::SyncRoomRedactionEvent;
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{OwnedEventId, OwnedUserId};

use self::document::{Document, indexable_body, replacement_of};
#[cfg(test)]
use self::index::RoomIndex;
pub(crate) use self::index::{ContextLine, Hit, MessageIndex};

const EVENTS_PER_INGEST_YIELD: usize = 16;
const DOCUMENTS_PER_RESTORE_YIELD: usize = 256;
const INGEST_WAIT: Duration = Duration::from_millis(25);
const INGEST_WAIT_ATTEMPTS: usize = 200;
const RETIRED_KEYS_BEFORE_VACUUM: usize = 64;

const MEMORY_BUDGET: usize = 64 * 1024 * 1024;
const DISK_BUDGET: u64 = 512 * 1024 * 1024;
const COLD_CHUNKS_PER_PAGE: usize = 32;
const OLDER_PAGE_BUDGET_MS: u64 = 50;
const HYDRATE_BATCH: usize = 30;
const HYDRATE_CONCURRENCY: usize = 8;
const DOCUMENT_OVERHEAD: usize = 1_600;
const CLASSIFIED_OVERHEAD: usize = 96;
const PINNED_FETCH_CONCURRENCY: usize = 4;

const INITIAL_DOCUMENTS: usize = 64;
const CHANGES_BEFORE_FLUSH: usize = 32;
const TICKS_BEFORE_FLUSH: u32 = 5;
pub(super) fn edited_or_own_event_id(original: &OriginalSyncRoomMessageEvent) -> OwnedEventId {
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

fn is_redacted(event: &TimelineEvent) -> bool {
    event
        .raw()
        .get_field::<serde_json::Value>("unsigned")
        .ok()
        .flatten()
        .is_some_and(|unsigned| unsigned.get("redacted_because").is_some())
}

pub(crate) async fn ignored_user_ids(client: &matrix_sdk::Client) -> Vec<OwnedUserId> {
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

#[cfg(test)]
mod tests;
