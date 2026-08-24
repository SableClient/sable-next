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
