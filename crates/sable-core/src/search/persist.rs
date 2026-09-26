use std::collections::{BTreeMap, HashMap};

use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::Document;

const SCHEMA: u32 = 5;
const LEGACY_SCHEMAS: [u32; 2] = [3, 4];

pub(super) type ChunkId = u32;

fn legacy_key(room_id: &OwnedRoomId) -> Vec<u8> {
    format!("sable.search.documents.{room_id}").into_bytes()
}

fn manifest_key(room_id: &OwnedRoomId) -> Vec<u8> {
    format!("sable.search.room.{room_id}").into_bytes()
}

fn chunk_key(room_id: &OwnedRoomId, chunk: ChunkId) -> Vec<u8> {
    format!("sable.search.chunk.{room_id}.{chunk}").into_bytes()
}

fn rooms_key() -> Vec<u8> {
    b"sable.search.rooms".to_vec()
}

#[derive(Clone, Copy, Serialize, Deserialize)]
pub(super) struct ChunkEntry {
    pub(super) id: ChunkId,
    pub(super) start: u64,
    pub(super) bytes: usize,
    pub(super) count: usize,
}

#[derive(Serialize, Deserialize)]
pub(super) struct Manifest {
    version: u32,
    pub(super) next_chunk: ChunkId,
    pub(super) chunks: Vec<ChunkEntry>,
    pub(super) edits: Vec<(OwnedEventId, OwnedEventId)>,
    #[serde(default)]
    pub(super) pending_redactions: Vec<OwnedEventId>,
    #[serde(default)]
    pub(super) pending_edits: Vec<Document>,
    #[serde(default)]
    pub(super) floor: u64,
}

impl Manifest {
    pub(super) const fn new(
        next_chunk: ChunkId,
        chunks: Vec<ChunkEntry>,
        edits: Vec<(OwnedEventId, OwnedEventId)>,
        floor: u64,
    ) -> Self {
        Self {
            version: SCHEMA,
            next_chunk,
            chunks,
            edits,
            pending_redactions: Vec::new(),
            pending_edits: Vec::new(),
            floor,
        }
    }
}

#[derive(Serialize, Deserialize)]
pub(super) struct StoredChunk {
    version: u32,
    pub(super) documents: Vec<Document>,
    pub(super) classified: Vec<(OwnedEventId, u64)>,
}

impl StoredChunk {
    pub(super) const fn new(
        documents: Vec<Document>,
        classified: Vec<(OwnedEventId, u64)>,
    ) -> Self {
        Self {
            version: SCHEMA,
            documents,
            classified,
        }
    }
}

#[derive(Deserialize)]
struct LegacyRoom {
    version: u32,
    documents: Vec<Document>,
    classified: Vec<OwnedEventId>,
    #[serde(default)]
    edits: Vec<(OwnedEventId, OwnedEventId)>,
}

pub(super) struct Restored {
    pub(super) manifest: Manifest,
    pub(super) loaded: Vec<(ChunkId, StoredChunk)>,
    pub(super) legacy: bool,
}

pub(super) struct Flush {
    pub(super) chunks: Vec<(ChunkId, StoredChunk)>,
    pub(super) cold: Vec<(ChunkId, StoredChunk)>,
    pub(super) scan: Vec<ChunkId>,
    pub(super) removed: Vec<ChunkId>,
    pub(super) manifest: Manifest,
    pub(super) legacy: bool,
}

pub(super) enum Opened {
    Manifest(Manifest),
    Legacy(Restored),
    Absent,
    Discarded,
    Unreadable,
}

pub(super) enum ChunkRead {
    Found(StoredChunk),
    Missing,
    Unreadable,
}

enum Read<T> {
    Found(T),
    Absent,
    Unreadable,
    Unparsable,
}

async fn read<T: DeserializeOwned>(client: &matrix_sdk::Client, key: &[u8]) -> Read<T> {
    match client.state_store().get_custom_value(key).await {
        Ok(Some(bytes)) => match serde_json::from_slice(&bytes) {
            Ok(value) => Read::Found(value),
            Err(error) => {
                warn!(key = %String::from_utf8_lossy(key), "persisted search data did not parse: {error}");
                Read::Unparsable
            }
        },
        Ok(None) => Read::Absent,
        Err(error) => {
            warn!(key = %String::from_utf8_lossy(key), "reading persisted search data failed: {error}");
            Read::Unreadable
        }
    }
}

async fn write(client: &matrix_sdk::Client, key: &[u8], value: &impl Serialize) -> Option<usize> {
    let bytes = match serde_json::to_vec(value) {
        Ok(bytes) => bytes,
        Err(error) => {
            warn!(key = %String::from_utf8_lossy(key), "serialising search data failed: {error}");
            return None;
        }
    };
    let written = bytes.len();
    match client
        .state_store()
        .set_custom_value_no_read(key, bytes)
        .await
    {
        Ok(()) => Some(written),
        Err(error) => {
            warn!(key = %String::from_utf8_lossy(key), "persisting search data failed: {error}");
            None
        }
    }
}

async fn remove(client: &matrix_sdk::Client, key: &[u8]) -> bool {
    match client.state_store().remove_custom_value(key).await {
        Ok(_) => true,
        Err(error) => {
            warn!(key = %String::from_utf8_lossy(key), "dropping persisted search data failed: {error}");
            false
        }
    }
}

pub(super) async fn open(client: &matrix_sdk::Client, room_id: &OwnedRoomId) -> Opened {
    match read::<Manifest>(client, &manifest_key(room_id)).await {
        Read::Found(manifest) if manifest.version == SCHEMA => return Opened::Manifest(manifest),
        Read::Found(manifest) => {
            info!(
                %room_id,
                found = manifest.version,
                expected = SCHEMA,
                "discarding a persisted search index written by another schema"
            );
            let _ = forget(client, room_id).await;
            return Opened::Discarded;
        }
        Read::Unparsable => {
            let _ = forget(client, room_id).await;
            return Opened::Discarded;
        }
        Read::Unreadable => return Opened::Unreadable,
        Read::Absent => {}
    }

    match read::<LegacyRoom>(client, &legacy_key(room_id)).await {
        Read::Found(legacy) if LEGACY_SCHEMAS.contains(&legacy.version) => {
            let stamps: HashMap<&OwnedEventId, u64> = legacy
                .documents
                .iter()
                .map(|document| (&document.event_id, document.origin_server_ts))
                .collect();
            let classified = legacy
                .classified
                .iter()
                .map(|event_id| (event_id.clone(), stamps.get(event_id).copied().unwrap_or(0)))
                .collect();
            let count = legacy.documents.len();
            Opened::Legacy(Restored {
                manifest: Manifest::new(
                    1,
                    vec![ChunkEntry {
                        id: 0,
                        start: 0,
                        bytes: 0,
                        count,
                    }],
                    legacy.edits,
                    0,
                ),
                loaded: vec![(0, StoredChunk::new(legacy.documents, classified))],
                legacy: true,
            })
        }
        Read::Found(_) | Read::Unparsable => {
            let _ = forget(client, room_id).await;
            Opened::Discarded
        }
        Read::Absent => Opened::Absent,
        Read::Unreadable => Opened::Unreadable,
    }
}

pub(super) async fn load_chunk(
    client: &matrix_sdk::Client,
    room_id: &OwnedRoomId,
    chunk: ChunkId,
) -> ChunkRead {
    match read::<StoredChunk>(client, &chunk_key(room_id, chunk)).await {
        Read::Found(stored) if stored.version == SCHEMA => ChunkRead::Found(stored),
        Read::Unreadable => ChunkRead::Unreadable,
        Read::Found(_) | Read::Absent | Read::Unparsable => {
            warn!(%room_id, chunk, "a listed search chunk is missing or stale");
            ChunkRead::Missing
        }
    }
}

#[must_use]
pub(super) async fn write_chunk(
    client: &matrix_sdk::Client,
    room_id: &OwnedRoomId,
    chunk: ChunkId,
    stored: &StoredChunk,
) -> Option<usize> {
    write(client, &chunk_key(room_id, chunk), stored).await
}

#[must_use]
pub(super) async fn write_manifest(
    client: &matrix_sdk::Client,
    room_id: &OwnedRoomId,
    manifest: &Manifest,
) -> bool {
    write(client, &manifest_key(room_id), manifest)
        .await
        .is_some()
}

pub(super) async fn remove_chunk(
    client: &matrix_sdk::Client,
    room_id: &OwnedRoomId,
    chunk: ChunkId,
) {
    let _ = remove(client, &chunk_key(room_id, chunk)).await;
}

pub(super) async fn remove_legacy(client: &matrix_sdk::Client, room_id: &OwnedRoomId) {
    let _ = remove(client, &legacy_key(room_id)).await;
}

#[must_use]
pub(super) async fn forget(client: &matrix_sdk::Client, room_id: &OwnedRoomId) -> bool {
    let next_chunk = match read::<Manifest>(client, &manifest_key(room_id)).await {
        Read::Found(manifest) => manifest.next_chunk,
        Read::Unreadable => return false,
        Read::Absent | Read::Unparsable => 0,
    };
    let mut forgotten = remove(client, &manifest_key(room_id)).await;
    for chunk in 0..next_chunk {
        forgotten &= remove(client, &chunk_key(room_id, chunk)).await;
    }
    forgotten &= remove(client, &legacy_key(room_id)).await;
    forgotten && unlist_room(client, room_id).await
}

pub(super) async fn listed_rooms(client: &matrix_sdk::Client) -> Vec<OwnedRoomId> {
    match read::<Vec<OwnedRoomId>>(client, &rooms_key()).await {
        Read::Found(rooms) => rooms,
        Read::Absent | Read::Unreadable | Read::Unparsable => Vec::new(),
    }
}

#[must_use]
pub(super) async fn list_room(client: &matrix_sdk::Client, room_id: &OwnedRoomId) -> bool {
    let mut rooms = match read::<Vec<OwnedRoomId>>(client, &rooms_key()).await {
        Read::Found(rooms) => rooms,
        Read::Absent | Read::Unparsable => Vec::new(),
        Read::Unreadable => return false,
    };
    if rooms.contains(room_id) {
        return true;
    }
    rooms.push(room_id.clone());
    write(client, &rooms_key(), &rooms).await.is_some()
}

async fn unlist_room(client: &matrix_sdk::Client, room_id: &OwnedRoomId) -> bool {
    let mut rooms = match read::<Vec<OwnedRoomId>>(client, &rooms_key()).await {
        Read::Found(rooms) => rooms,
        Read::Absent | Read::Unparsable => return true,
        Read::Unreadable => return false,
    };
    let before = rooms.len();
    rooms.retain(|listed| listed != room_id);
    rooms.len() == before || write(client, &rooms_key(), &rooms).await.is_some()
}

const CRAWL_SCHEMA: u32 = 3;
const CRAWL_SCHEMAS_READ: [u32; 2] = [3, 4];

fn crawl_key() -> Vec<u8> {
    b"sable.search.crawl".to_vec()
}

#[derive(Default, Serialize, Deserialize)]
pub(super) struct StoredCrawl {
    pub(super) version: u32,
    pub(super) rooms: BTreeMap<OwnedRoomId, StoredCrawlRoom>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
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
        Ok(stored) if CRAWL_SCHEMAS_READ.contains(&stored.version) => stored,
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
    client: &matrix_sdk::Client,
    rooms: BTreeMap<OwnedRoomId, StoredCrawlRoom>,
) -> bool {
    let stored = StoredCrawl {
        version: CRAWL_SCHEMA,
        rooms,
    };
    let bytes = match serde_json::to_vec(&stored) {
        Ok(bytes) => bytes,
        Err(error) => {
            warn!("serialising the crawl checkpoints failed: {error}");
            return false;
        }
    };

    match client
        .state_store()
        .set_custom_value_no_read(&crawl_key(), bytes)
        .await
    {
        Ok(()) => true,
        Err(error) => {
            warn!("persisting the crawl checkpoints failed: {error}");
            false
        }
    }
}

#[must_use]
pub(super) async fn forget_crawl(client: &matrix_sdk::Client) -> bool {
    match client.state_store().remove_custom_value(&crawl_key()).await {
        Ok(_) => true,
        Err(error) => {
            warn!("dropping the persisted crawl checkpoints failed: {error}");
            false
        }
    }
}
