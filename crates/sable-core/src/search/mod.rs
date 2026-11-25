mod apply;
mod ban;
mod core_api;
mod crawl;
mod document;
mod index;
mod network;
mod sharing;
pub(crate) use network::CrawlNetwork;
mod exec;
mod filter;
mod persist;
mod server;
mod store;
#[cfg(target_family = "wasm")]
mod store_web;

pub(crate) const MAX_SEARCH_RESULTS: usize = 200;

pub(crate) use crawl::CrawlProgress;
pub(crate) use filter::IndexFilter;
pub(crate) use server::ServerSearch;
pub(crate) use sharing::SearchPeers;

use crate::now_ms;
use std::time::Duration;

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::ruma::events::ignored_user_list::IgnoredUserListEventContent;
use matrix_sdk::ruma::events::room::message::{OriginalSyncRoomMessageEvent, Relation};
use matrix_sdk::ruma::events::room::redaction::SyncRoomRedactionEvent;
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{OwnedEventId, OwnedUserId};

#[cfg(test)]
use self::document::Document;
use self::document::{indexable_body, replacement_of};
pub(crate) use self::index::{ContextLine, Hit, MessageIndex};
#[cfg(not(target_family = "wasm"))]
pub(crate) use self::store::DIRECTORY;
#[cfg(not(target_family = "wasm"))]
pub(crate) use self::store::Store;
pub(crate) use self::store::expands;
#[cfg(target_family = "wasm")]
pub use self::store_web::attach_search_port;
#[cfg(target_family = "wasm")]
pub(crate) use self::store_web::remove as remove_database;

const INGEST_CHUNK: usize = 64;
const INGEST_WAIT: Duration = Duration::from_millis(25);
const INGEST_WAIT_ATTEMPTS: usize = 200;

const REDACTABLE_KINDS: [&str; 4] = [
    "m.room.message",
    "m.sticker",
    "m.poll.start",
    "org.matrix.msc3381.poll.start",
];

const DISK_BUDGET: u64 = 512 * 1024 * 1024;
const HYDRATE_BATCH: usize = 30;
const HYDRATE_CONCURRENCY: usize = 8;
const PINNED_FETCH_CONCURRENCY: usize = 4;

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

/// A redacted event carries `redacted_because`, or else comes back with the
/// content a redaction leaves of a message.
fn is_redacted(event: &TimelineEvent) -> bool {
    let raw = event.raw();
    let because = raw
        .get_field::<serde_json::Value>("unsigned")
        .ok()
        .flatten()
        .is_some_and(|unsigned| unsigned.get("redacted_because").is_some());
    because
        || (raw
            .get_field::<String>("type")
            .ok()
            .flatten()
            .is_some_and(|kind| REDACTABLE_KINDS.contains(&kind.as_str()))
            && raw
                .get_field::<serde_json::Map<String, serde_json::Value>>("content")
                .ok()
                .flatten()
                .is_some_and(|content| content.is_empty()))
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

/// Fills an account's database as an earlier session would have left it.
#[cfg(all(test, not(target_family = "wasm")))]
pub(crate) async fn seed_account_index(store_id: &str, room_id: &ruma::RoomId, count: usize) {
    let index = MessageIndex::with_store(Store::open_account(store_id).await);
    for position in 0..count {
        index.upsert(
            room_id,
            tests::document(
                &format!("indexed-{position}"),
                "retained archaeology",
                "@alice:example.org",
                100 + position as u64,
                None,
                Vec::new(),
            ),
        );
    }
}
