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

const ZLIB_HEADER: u8 = 0x78;
const COMPRESSION_LEVEL: u8 = 6;

fn encode(json: &[u8]) -> Vec<u8> {
    miniz_oxide::deflate::compress_to_vec_zlib(json, COMPRESSION_LEVEL)
}

fn decode(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if bytes.first() == Some(&ZLIB_HEADER) {
        miniz_oxide::inflate::decompress_to_vec_zlib(&bytes).map_err(|error| error.to_string())
    } else {
        Ok(bytes)
    }
}

async fn seam_get(client: &matrix_sdk::Client, key: &[u8]) -> Result<Option<Vec<u8>>, String> {
    client
        .state_store()
        .get_custom_value(key)
        .await
        .map_err(|error| error.to_string())
}

async fn seam_put(client: &matrix_sdk::Client, key: &[u8], bytes: Vec<u8>) -> Result<(), String> {
    client
        .state_store()
        .set_custom_value_no_read(key, bytes)
        .await
        .map_err(|error| error.to_string())
}

async fn seam_delete(client: &matrix_sdk::Client, key: &[u8]) -> Result<(), String> {
    client
        .state_store()
        .remove_custom_value(key)
        .await
        .map(drop)
        .map_err(|error| error.to_string())
}

#[cfg(target_family = "wasm")]
fn text_key(key: &[u8]) -> Result<&str, String> {
    std::str::from_utf8(key).map_err(|error| error.to_string())
}

#[cfg(target_family = "wasm")]
async fn get(client: &matrix_sdk::Client, key: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let database = match super::idb::attached(client) {
        super::idb::Attached::Open(database) => database,
        super::idb::Attached::Closed => return Err("the search database is closed".to_owned()),
        super::idb::Attached::Detached => return seam_get(client, key).await,
    };
    let text = text_key(key)?;
    if let Some(bytes) = super::idb::get(&database, text).await? {
        return Ok(Some(bytes));
    }
    let Some(bytes) = seam_get(client, key).await? else {
        return Ok(None);
    };
    if super::idb::put(&database, text, &bytes).await.is_ok()
        && let Err(error) = seam_delete(client, key).await
    {
        warn!(key = text, "dropping migrated search data failed: {error}");
    }
    Ok(Some(bytes))
}

#[cfg(not(target_family = "wasm"))]
async fn get(client: &matrix_sdk::Client, key: &[u8]) -> Result<Option<Vec<u8>>, String> {
    seam_get(client, key).await
}

#[cfg(target_family = "wasm")]
async fn put(client: &matrix_sdk::Client, key: &[u8], bytes: Vec<u8>) -> Result<(), String> {
    match super::idb::attached(client) {
        super::idb::Attached::Open(database) => {
            super::idb::put(&database, text_key(key)?, &bytes).await
        }
        super::idb::Attached::Closed => Err("the search database is closed".to_owned()),
        super::idb::Attached::Detached => seam_put(client, key, bytes).await,
    }
}

#[cfg(not(target_family = "wasm"))]
async fn put(client: &matrix_sdk::Client, key: &[u8], bytes: Vec<u8>) -> Result<(), String> {
    seam_put(client, key, bytes).await
}

#[cfg(target_family = "wasm")]
async fn delete(client: &matrix_sdk::Client, key: &[u8]) -> Result<(), String> {
    match super::idb::attached(client) {
        super::idb::Attached::Open(database) => {
            super::idb::delete(&database, text_key(key)?).await?;
            seam_delete(client, key).await
        }
        super::idb::Attached::Closed => Err("the search database is closed".to_owned()),
        super::idb::Attached::Detached => seam_delete(client, key).await,
    }
}

#[cfg(not(target_family = "wasm"))]
async fn delete(client: &matrix_sdk::Client, key: &[u8]) -> Result<(), String> {
    seam_delete(client, key).await
}

#[cfg(target_family = "wasm")]
pub(super) async fn attach(client: &matrix_sdk::Client, store_id: &str) {
    if let Err(error) = super::idb::attach(client, store_id).await {
        warn!("opening the search database failed, using the state store: {error}");
    }
}

async fn read<T: DeserializeOwned>(client: &matrix_sdk::Client, key: &[u8]) -> Read<T> {
    match get(client, key).await.map(|bytes| bytes.map(decode)) {
        Ok(Some(Ok(bytes))) => match serde_json::from_slice(&bytes) {
            Ok(value) => Read::Found(value),
            Err(error) => {
                warn!(key = %String::from_utf8_lossy(key), "persisted search data did not parse: {error}");
                Read::Unparsable
            }
        },
        Ok(Some(Err(error))) => {
            warn!(key = %String::from_utf8_lossy(key), "persisted search data did not decompress: {error}");
            Read::Unparsable
        }
        Ok(None) => Read::Absent,
        Err(error) => {
            warn!(key = %String::from_utf8_lossy(key), "reading persisted search data failed: {error}");
            Read::Unreadable
        }
    }
}

async fn write(client: &matrix_sdk::Client, key: &[u8], value: &impl Serialize) -> Option<usize> {
    let json = match serde_json::to_vec(value) {
        Ok(json) => json,
        Err(error) => {
            warn!(key = %String::from_utf8_lossy(key), "serialising search data failed: {error}");
            return None;
        }
    };
    match put(client, key, encode(&json)).await {
        Ok(()) => Some(json.len()),
        Err(error) => {
            warn!(key = %String::from_utf8_lossy(key), "persisting search data failed: {error}");
            None
        }
    }
}

async fn remove(client: &matrix_sdk::Client, key: &[u8]) -> bool {
    match delete(client, key).await {
        Ok(()) => true,
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
    let bytes = match get(client, &crawl_key())
        .await
        .map(|bytes| bytes.map(decode))
    {
        Ok(Some(Ok(bytes))) => bytes,
        Ok(None) => return StoredCrawl::default(),
        Ok(Some(Err(error))) => {
            warn!("discarding crawl checkpoints that did not decompress: {error}");
            return StoredCrawl::default();
        }
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
    let json = match serde_json::to_vec(&stored) {
        Ok(json) => json,
        Err(error) => {
            warn!("serialising the crawl checkpoints failed: {error}");
            return false;
        }
    };

    match put(client, &crawl_key(), encode(&json)).await {
        Ok(()) => true,
        Err(error) => {
            warn!("persisting the crawl checkpoints failed: {error}");
            false
        }
    }
}

#[must_use]
pub(super) async fn forget_crawl(client: &matrix_sdk::Client) -> bool {
    match delete(client, &crawl_key()).await {
        Ok(()) => true,
        Err(error) => {
            warn!("dropping the persisted crawl checkpoints failed: {error}");
            false
        }
    }
}

#[cfg(test)]
mod codec_tests {
    use super::{decode, encode};

    #[test]
    fn a_compressed_value_reads_back_and_shrinks() {
        let json = br#"{"version":5,"documents":[]}"#.repeat(200);
        let stored = encode(&json);
        assert!(stored.len() < json.len() / 4);
        assert_eq!(decode(stored), Ok(json));
    }

    #[test]
    fn a_value_written_before_compression_passes_through() {
        let object = br#"{"version":5}"#.to_vec();
        let list = br#"["!a:b"]"#.to_vec();
        assert_eq!(decode(object.clone()), Ok(object));
        assert_eq!(decode(list.clone()), Ok(list));
    }
}
