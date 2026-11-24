//! What the crawler and the ignored-user watcher keep next to the index, and
//! the removal of what older versions stored in the SDK state store instead.

use std::collections::BTreeMap;

use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, OwnedUserId};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::store::Store;
use crate::store::StoreError;

const CRAWL_SCHEMA: u32 = 4;
const CRAWL_KEY: &str = "crawl";
const IGNORED_KEY: &str = "ignored";
const LEGACY_PURGED_KEY: &str = "legacy-purged";

#[derive(Default, Serialize, Deserialize)]
pub(super) struct StoredCrawl {
    pub(super) version: u32,
    pub(super) rooms: BTreeMap<OwnedRoomId, StoredCrawlRoom>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct StoredCrawlRoom {
    #[serde(default)]
    pub(super) shared_resume: bool,
    #[serde(default)]
    pub(super) frontier: Option<u64>,
    #[serde(default = "default_gapped")]
    pub(super) gapped: bool,
    pub(super) token: Option<String>,
    pub(super) reached_start: bool,
    #[serde(default)]
    pub(super) cover: Option<Cover>,
    #[serde(default)]
    pub(super) hole: Option<Hole>,
}

/// Events missing between the newest indexed one and a batch that sync delivered detached from it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Hole {
    pub(super) anchor: OwnedEventId,
    pub(super) until: OwnedEventId,
    pub(super) token: Option<String>,
}

const fn default_gapped() -> bool {
    // Older checkpoints did not track undecryptable events.
    true
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Cover {
    #[serde(default)]
    pub(super) anchor: Option<OwnedEventId>,
    pub(super) from: u64,
    pub(super) until: u64,
    pub(super) resume: Option<String>,
    pub(super) stops: bool,
}

async fn read(store: &Store, key: &'static str) -> Option<Vec<u8>> {
    match store.meta(key).await {
        Ok(value) => value,
        Err(error) => {
            warn!(key, "reading persisted search data failed: {error}");
            None
        }
    }
}

async fn write(store: &Store, key: &'static str, value: Vec<u8>) -> bool {
    match store.set_meta(key, value).await {
        Ok(()) => true,
        Err(error) => {
            warn!(key, "persisting search data failed: {error}");
            false
        }
    }
}

pub(super) async fn load_crawl(store: &Store) -> StoredCrawl {
    let Some(bytes) = read(store, CRAWL_KEY).await else {
        return StoredCrawl::default();
    };
    match serde_json::from_slice::<StoredCrawl>(&bytes) {
        Ok(stored) if stored.version == CRAWL_SCHEMA => stored,
        Ok(stored) => {
            info!(
                found = stored.version,
                expected = CRAWL_SCHEMA,
                "discarding crawl checkpoints written by another schema"
            );
            StoredCrawl::default()
        }
        Err(error) => {
            warn!("discarding crawl checkpoints that did not parse: {error}");
            StoredCrawl::default()
        }
    }
}

#[must_use]
pub(super) async fn save_crawl(
    store: &Store,
    rooms: BTreeMap<OwnedRoomId, StoredCrawlRoom>,
) -> bool {
    let stored = StoredCrawl {
        version: CRAWL_SCHEMA,
        rooms,
    };
    match serde_json::to_vec(&stored) {
        Ok(json) => write(store, CRAWL_KEY, json).await,
        Err(error) => {
            warn!("serialising the crawl checkpoints failed: {error}");
            false
        }
    }
}

#[must_use]
pub(super) async fn forget_crawl(store: &Store) -> bool {
    match store.remove_meta(CRAWL_KEY).await {
        Ok(()) => true,
        Err(error) => {
            warn!("dropping the persisted crawl checkpoints failed: {error}");
            false
        }
    }
}

pub(super) async fn ignored_unchanged(store: &Store, ignored: &[OwnedUserId]) -> bool {
    saved_ignored(store)
        .await
        .is_some_and(|stored| stored == ignored)
}

pub(super) async fn saved_ignored(store: &Store) -> Option<Vec<OwnedUserId>> {
    read(store, IGNORED_KEY)
        .await
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

pub(super) async fn save_ignored(store: &Store, ignored: &[OwnedUserId]) {
    if let Ok(json) = serde_json::to_vec(ignored) {
        write(store, IGNORED_KEY, json).await;
    }
}

/// Removes what versions before the SQLite index kept in the SDK state store,
/// once. The crawler rebuilds the index, so none of it is converted.
pub(super) async fn purge_legacy(store: &Store, client: &matrix_sdk::Client, store_id: &str) {
    if read(store, LEGACY_PURGED_KEY).await.is_some() {
        return;
    }
    #[cfg(target_family = "wasm")]
    remove_search_database(store_id).await;
    #[cfg(not(target_family = "wasm"))]
    let _ = store_id;
    match purge_state_store(client).await {
        Ok(()) => {
            write(store, LEGACY_PURGED_KEY, vec![1]).await;
        }
        Err(error) => warn!("removing the old search index failed: {error}"),
    }
}

fn legacy_key(room_id: &OwnedRoomId) -> Vec<u8> {
    format!("sable.search.documents.{room_id}").into_bytes()
}

fn manifest_key(room_id: &OwnedRoomId) -> Vec<u8> {
    format!("sable.search.room.{room_id}").into_bytes()
}

fn chunk_key(room_id: &OwnedRoomId, chunk: u64) -> Vec<u8> {
    format!("sable.search.chunk.{room_id}.{chunk}").into_bytes()
}

const ROOMS_KEY: &[u8] = b"sable.search.rooms";
const OLD_CRAWL_KEY: &[u8] = b"sable.search.crawl";
const OLD_IGNORED_KEY: &[u8] = b"sable.search.ignored";
const ZLIB_HEADER: u8 = 0x78;

fn inflated(bytes: &[u8]) -> Vec<u8> {
    if bytes.first() == Some(&ZLIB_HEADER) {
        miniz_oxide::inflate::decompress_to_vec_zlib(bytes).unwrap_or_default()
    } else {
        bytes.to_vec()
    }
}

async fn purge_state_store(client: &matrix_sdk::Client) -> Result<(), StoreError> {
    let state = client.state_store();
    let mut rooms: Vec<OwnedRoomId> = state
        .get_custom_value(ROOMS_KEY)
        .await
        .map_err(StoreError::backend)?
        .map_or_else(Vec::new, |bytes| {
            serde_json::from_slice(&inflated(&bytes)).unwrap_or_default()
        });
    for room in client.joined_rooms() {
        if !rooms.iter().any(|listed| listed == room.room_id()) {
            rooms.push(room.room_id().to_owned());
        }
    }

    for room_id in &rooms {
        let chunks = state
            .remove_custom_value(&manifest_key(room_id))
            .await
            .map_err(StoreError::backend)?
            .and_then(|manifest| {
                serde_json::from_slice::<serde_json::Value>(&inflated(&manifest)).ok()
            })
            .and_then(|manifest| manifest.get("next_chunk")?.as_u64())
            .unwrap_or(0);
        for chunk in 0..chunks {
            state
                .remove_custom_value(&chunk_key(room_id, chunk))
                .await
                .map_err(StoreError::backend)?;
        }
        state
            .remove_custom_value(&legacy_key(room_id))
            .await
            .map_err(StoreError::backend)?;
    }
    for key in [ROOMS_KEY, OLD_CRAWL_KEY, OLD_IGNORED_KEY] {
        state
            .remove_custom_value(key)
            .await
            .map_err(StoreError::backend)?;
    }
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
pub(super) async fn remove_dictionary(base_store: &str) {
    let directory = std::path::Path::new(base_store).join("search-dictionaries");
    if let Err(error) = tokio::fs::remove_dir_all(directory).await
        && error.kind() != std::io::ErrorKind::NotFound
    {
        warn!("removing the old search dictionary failed: {error}");
    }
}

#[cfg(target_family = "wasm")]
pub(super) async fn remove_dictionary() {
    remove_indexed_database("sable-search-dictionary").await;
}

/// Older versions kept the index in an `IndexedDB` database of its own.
#[cfg(target_family = "wasm")]
async fn remove_search_database(store_id: &str) {
    remove_indexed_database(&format!("{store_id}::sable-search")).await;
}

#[cfg(target_family = "wasm")]
async fn remove_indexed_database(name: &str) {
    let deleted = match matrix_indexed_db_futures::database::Database::delete_by_name(name) {
        Ok(request) => request.await.map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    if let Err(error) = deleted {
        warn!(name, "removing the old search database failed: {error}");
    }
}

#[cfg(test)]
#[path = "persist_tests.rs"]
mod tests;
