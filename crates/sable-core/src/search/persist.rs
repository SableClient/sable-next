use std::collections::BTreeMap;

use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::Document;

const SCHEMA: u32 = 1;

fn key_for(room_id: &OwnedRoomId) -> Vec<u8> {
    format!("sable.search.documents.{room_id}").into_bytes()
}

#[derive(Serialize, Deserialize)]
pub(super) struct StoredRoom {
    version: u32,
    documents: Vec<Document>,
    classified: Vec<OwnedEventId>,
}

impl StoredRoom {
    pub(super) const fn new(documents: Vec<Document>, classified: Vec<OwnedEventId>) -> Self {
        Self {
            version: SCHEMA,
            documents,
            classified,
        }
    }
}

pub(super) enum Loaded {
    Restored(Vec<Document>, Vec<OwnedEventId>),
    Absent,
    Unreadable,
}

pub(super) async fn load(client: &matrix_sdk::Client, room_id: &OwnedRoomId) -> Loaded {
    let bytes = match client
        .state_store()
        .get_custom_value(&key_for(room_id))
        .await
    {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Loaded::Absent,
        Err(error) => {
            warn!(%room_id, "reading the persisted search index failed: {error}");
            return Loaded::Unreadable;
        }
    };

    match serde_json::from_slice::<StoredRoom>(&bytes) {
        Ok(stored) if stored.version == SCHEMA => {
            Loaded::Restored(stored.documents, stored.classified)
        }
        Ok(stored) => {
            info!(
                %room_id,
                found = stored.version,
                expected = SCHEMA,
                "discarding a persisted search index written by another schema"
            );
            let _ = forget(client, room_id).await;
            Loaded::Absent
        }
        Err(error) => {
            warn!(%room_id, "discarding a persisted search index that did not parse: {error}");
            let _ = forget(client, room_id).await;
            Loaded::Absent
        }
    }
}

#[must_use]
pub(super) async fn save(
    client: &matrix_sdk::Client,
    room_id: &OwnedRoomId,
    stored: &StoredRoom,
) -> bool {
    let bytes = match serde_json::to_vec(stored) {
        Ok(bytes) => bytes,
        Err(error) => {
            warn!(%room_id, "serialising the search index failed: {error}");
            return false;
        }
    };

    match client
        .state_store()
        .set_custom_value_no_read(&key_for(room_id), bytes)
        .await
    {
        Ok(()) => true,
        Err(error) => {
            warn!(%room_id, "persisting the search index failed: {error}");
            false
        }
    }
}

#[must_use]
pub(super) async fn forget(client: &matrix_sdk::Client, room_id: &OwnedRoomId) -> bool {
    match client
        .state_store()
        .remove_custom_value(&key_for(room_id))
        .await
    {
        Ok(_) => true,
        Err(error) => {
            warn!(%room_id, "dropping the persisted search index failed: {error}");
            false
        }
    }
}

const CRAWL_SCHEMA: u32 = 1;

fn crawl_key() -> Vec<u8> {
    b"sable.search.crawl".to_vec()
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct StoredCrawl {
    pub(super) version: u32,
    pub(super) rooms: BTreeMap<OwnedRoomId, StoredCrawlRoom>,
}

#[derive(Serialize, Deserialize)]
pub(super) struct StoredCrawlRoom {
    pub(super) token: Option<String>,
    pub(super) reached_start: bool,
}

pub(super) async fn load_crawl(client: &matrix_sdk::Client) -> StoredCrawl {
    let bytes = match client.state_store().get_custom_value(&crawl_key()).await {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return StoredCrawl::default(),
        Err(error) => {
            warn!("reading the persisted crawl checkpoints failed: {error}");
            return StoredCrawl::default();
        }
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

pub(super) async fn save_crawl(
    client: &matrix_sdk::Client,
    rooms: BTreeMap<OwnedRoomId, StoredCrawlRoom>,
) {
    let stored = StoredCrawl {
        version: CRAWL_SCHEMA,
        rooms,
    };
    let bytes = match serde_json::to_vec(&stored) {
        Ok(bytes) => bytes,
        Err(error) => {
            warn!("serialising the crawl checkpoints failed: {error}");
            return;
        }
    };

    if let Err(error) = client
        .state_store()
        .set_custom_value_no_read(&crawl_key(), bytes)
        .await
    {
        warn!("persisting the crawl checkpoints failed: {error}");
    }
}
