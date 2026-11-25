//! The search database: `SQLite` with an `FTS5` index, sealed by `SQLCipher` when the account has a key.

mod lifecycle;
mod query;
mod tx;

use std::collections::HashSet;
use std::sync::Arc;

use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, RoomId};
use sable_sql::{Rows, Statement, Value, statement};

pub(super) use self::lifecycle::Removal;
pub(super) use self::query::PageStep;
pub(crate) use self::query::expands;
pub(super) use self::tx::RoomTx;
use super::document::Document;
use super::exec::Exec;
pub(super) use super::exec::{Result, SqlError};

#[cfg(not(target_family = "wasm"))]
pub(crate) const DIRECTORY: &str = "search";
#[cfg(not(target_family = "wasm"))]
const DATABASE: &str = "search.sqlite3";
#[cfg(not(target_family = "wasm"))]
const SEARCH_KEY_INFO: &[u8] = b"sable.search";
const EVICTION_ROUNDS: usize = 20;

/// The database key for an account, apart from the key its stores use.
#[cfg(not(target_family = "wasm"))]
pub(crate) fn search_key(store_key: &crate::secrets::Key) -> Option<crate::secrets::Key> {
    use hkdf::Hkdf;
    use sha2::Sha256;

    let mut key = crate::secrets::Key::default();
    Hkdf::<Sha256>::new(None, store_key.as_slice())
        .expand(SEARCH_KEY_INFO, key.as_mut_slice())
        .ok()?;
    Some(key)
}

#[cfg(not(target_family = "wasm"))]
pub(super) enum Location {
    Memory,
    File(std::path::PathBuf),
}

/// # Errors
/// Fails when the file is not a search database sealed with `key`.
#[cfg(not(target_family = "wasm"))]
pub(super) fn open_connection(
    location: &Location,
    key: Option<&crate::secrets::Key>,
) -> std::result::Result<rusqlite::Connection, sable_sql::OpenError> {
    use std::fmt::Write as _;

    let connection = match location {
        Location::Memory => rusqlite::Connection::open_in_memory()?,
        Location::File(path) => rusqlite::Connection::open(path)?,
    };
    if let Some(key) = key {
        let mut pragma = zeroize::Zeroizing::new(String::from("PRAGMA key = \"x'"));
        for byte in key.iter() {
            let _ = write!(pragma, "{byte:02x}");
        }
        pragma.push_str("'\";");
        connection.execute_batch(&pragma)?;
    }
    sable_sql::prepare(&connection, matches!(location, Location::File(_)))?;
    Ok(connection)
}

#[cfg(not(target_family = "wasm"))]
pub(super) fn open_or_start_over(
    directory: &std::path::Path,
    key: Option<&crate::secrets::Key>,
) -> std::result::Result<rusqlite::Connection, sable_sql::OpenError> {
    let location = Location::File(directory.join(DATABASE));
    open_connection(&location, key).or_else(|error| {
        if !error.starts_over() {
            return Err(error);
        }
        tracing::warn!("the search database cannot be used, starting it over: {error}");
        remove_files(directory);
        open_connection(&location, key)
    })
}

#[cfg(not(target_family = "wasm"))]
fn remove_files(directory: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(directory.join(format!("{DATABASE}{suffix}")));
    }
}

#[derive(Default)]
pub(super) struct Stats {
    pub(super) documents: usize,
    pub(super) memory_used: u64,
    pub(super) memory_budget: u64,
    pub(super) disk: u64,
    pub(super) disk_index: u64,
    pub(super) disk_bookkeeping: u64,
}

fn int(row: &[Value], column: usize) -> Option<u64> {
    row.get(column)?.as_u64()
}

fn text(row: &[Value], column: usize) -> Option<&str> {
    row.get(column)?.as_str()
}

#[derive(Clone)]
pub(crate) struct Store {
    exec: Arc<Exec>,
    #[cfg(not(target_family = "wasm"))]
    file: Option<Arc<(Location, Option<crate::secrets::Key>)>>,
}

impl Store {
    pub(super) fn from_exec(exec: Exec) -> Self {
        Self {
            exec: Arc::new(exec),
            #[cfg(not(target_family = "wasm"))]
            file: None,
        }
    }

    /// An index that lives only as long as this value, until an account's own
    /// database replaces it. On the web there is none until a worker is attached.
    #[cfg(not(target_family = "wasm"))]
    #[expect(
        clippy::expect_used,
        reason = "an empty in-memory database always opens"
    )]
    pub(super) fn memory() -> Self {
        let connection =
            open_connection(&Location::Memory, None).expect("an in-memory database opens");
        Self::from_exec(Exec::Native(Arc::new(parking_lot::Mutex::new(Some(
            connection,
        )))))
    }

    #[cfg(target_family = "wasm")]
    pub(super) fn memory() -> Self {
        Self::from_exec(Exec::Web(None))
    }

    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn open_account(store_id: &str) -> Self {
        let key = match crate::store_encryption::saved_key(store_id) {
            Ok(key) => key.as_ref().and_then(search_key),
            Err(error) => {
                tracing::warn!("the search index keeps to memory without its key: {error}");
                return Self::memory();
            }
        };
        let directory = std::path::Path::new(store_id).join(DIRECTORY);
        let file = Arc::new((Location::File(directory.join(DATABASE)), key.clone()));
        let opened = tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&directory)?;
            open_or_start_over(&directory, key.as_ref()).map_err(std::io::Error::other)
        })
        .await;
        match opened {
            Ok(Ok(connection)) => Self {
                exec: Arc::new(Exec::Native(Arc::new(parking_lot::Mutex::new(Some(
                    connection,
                ))))),
                file: Some(file),
            },
            Ok(Err(error)) => {
                tracing::warn!("the search index keeps to memory: {error}");
                Self::memory()
            }
            Err(error) => std::panic::resume_unwind(error.into_panic()),
        }
    }

    /// iOS kills a suspended app that still holds a lock on a file in the App Group container.
    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn close(&self) {
        let (Exec::Native(connection), Some(_)) = (&*self.exec, &self.file) else {
            return;
        };
        let connection = connection.clone();
        if let Err(error) =
            tokio::task::spawn_blocking(move || drop(connection.lock().take())).await
        {
            std::panic::resume_unwind(error.into_panic());
        }
    }

    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn reopen(&self) {
        let (Exec::Native(connection), Some(file)) = (&*self.exec, &self.file) else {
            return;
        };
        let connection = connection.clone();
        let file = file.clone();
        let reopened = tokio::task::spawn_blocking(move || {
            let mut connection = connection.lock();
            if connection.is_none() {
                *connection = Some(open_connection(&file.0, file.1.as_ref())?);
            }
            Ok::<_, sable_sql::OpenError>(())
        })
        .await;
        match reopened {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!("the search database did not reopen: {error}"),
            Err(error) => std::panic::resume_unwind(error.into_panic()),
        }
    }

    #[cfg(target_family = "wasm")]
    pub(crate) fn open_account(store_id: &str) -> std::future::Ready<Self> {
        std::future::ready(super::store_web::open_account(store_id))
    }

    /// Whether statements can run now. On the web a worker has to be attached first.
    pub(crate) fn ready(&self) -> bool {
        self.exec.ready()
    }

    pub(super) async fn run(&self, statements: Vec<Statement>) -> Result<Vec<Rows>> {
        self.exec.batch(statements).await
    }

    pub(super) async fn rows(&self, statement: Statement) -> Result<Rows> {
        Ok(self.run(vec![statement]).await?.pop().unwrap_or_default())
    }

    pub(super) async fn meta(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let rows = self
            .rows(statement!("SELECT value FROM meta WHERE key = ?1", key))
            .await?;
        Ok(rows
            .first()
            .and_then(|row| row.first())
            .and_then(Value::as_blob)
            .map(<[u8]>::to_vec))
    }

    pub(super) async fn set_meta(&self, key: &str, value: Vec<u8>) -> Result<()> {
        self.rows(statement!(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            key,
            value
        ))
        .await
        .map(drop)
    }

    pub(super) async fn remove_meta(&self, key: &str) -> Result<()> {
        self.rows(statement!("DELETE FROM meta WHERE key = ?1", key))
            .await
            .map(drop)
    }

    pub(super) async fn rooms(&self) -> Result<Vec<OwnedRoomId>> {
        let rows = self.rows(statement!("SELECT room_id FROM room")).await?;
        Ok(rows
            .iter()
            .filter_map(|row| OwnedRoomId::try_from(text(row, 0)?).ok())
            .collect())
    }

    pub(super) async fn has_room(&self, room_id: &RoomId) -> Result<bool> {
        Ok(!self
            .rows(statement!(
                "SELECT 1 FROM room WHERE room_id = ?1",
                room_id.as_str()
            ))
            .await?
            .is_empty())
    }

    pub(super) async fn floor(&self, room_id: &RoomId) -> Result<u64> {
        let rows = self
            .rows(statement!(
                "SELECT floor FROM room WHERE room_id = ?1",
                room_id.as_str()
            ))
            .await?;
        Ok(rows.first().and_then(|row| int(row, 0)).unwrap_or(0))
    }

    pub(super) async fn newest(&self, room_id: &RoomId) -> Result<Option<u64>> {
        let rows = self
            .rows(statement!(
                "SELECT max(ts) FROM doc WHERE room_id = ?1",
                room_id.as_str()
            ))
            .await?;
        Ok(rows.first().and_then(|row| int(row, 0)))
    }

    pub(super) async fn documents(&self) -> Result<usize> {
        let rows = self.rows(statement!("SELECT count(*) FROM doc")).await?;
        Ok(rows
            .first()
            .and_then(|row| int(row, 0))
            .and_then(|count| usize::try_from(count).ok())
            .unwrap_or(0))
    }

    pub(super) async fn is_classified(&self, room_id: &RoomId, event_id: &str) -> Result<bool> {
        Ok(!self
            .rows(statement!(
                "SELECT 1 FROM classified WHERE room_id = ?1 AND event_id = ?2",
                room_id.as_str(),
                event_id
            ))
            .await?
            .is_empty())
    }

    pub(super) async fn classified_among(
        &self,
        room_id: &RoomId,
        event_ids: &[String],
    ) -> Result<HashSet<OwnedEventId>> {
        let statements = event_ids
            .iter()
            .map(|event_id| {
                statement!(
                    "SELECT event_id FROM classified WHERE room_id = ?1 AND event_id = ?2",
                    room_id.as_str(),
                    event_id.as_str()
                )
            })
            .collect();
        Ok(self
            .run(statements)
            .await?
            .iter()
            .flatten()
            .filter_map(|row| OwnedEventId::try_from(text(row, 0)?).ok())
            .collect())
    }

    /// Starts work on a room, which exists from now on.
    pub(super) async fn room(&self, room_id: &RoomId) -> Result<RoomTx<'_>> {
        RoomTx::open(self, room_id).await
    }

    pub(super) async fn forget_room(&self, room_id: &RoomId) -> Result<()> {
        let room = room_id.as_str();
        let statements = [
            "doc",
            "classified",
            "edit",
            "redacted",
            "pending_edit",
            "room",
        ]
        .map(|table| statement!(format!("DELETE FROM {table} WHERE room_id = ?1"), room));
        self.run(statements.into()).await.map(drop)
    }

    /// The bytes the database holds, not counting pages waiting for reuse.
    pub(super) async fn used_bytes(&self) -> Result<u64> {
        let rows = self
            .rows(statement!(
                "SELECT (page_count - freelist_count) * page_size
                 FROM pragma_page_count, pragma_freelist_count, pragma_page_size"
            ))
            .await?;
        Ok(rows.first().and_then(|row| int(row, 0)).unwrap_or(0))
    }

    /// Deletes the oldest documents until the database fits `budget`, and
    /// returns the rooms that lost some.
    pub(super) async fn evict_to(&self, budget: u64) -> Result<Vec<OwnedRoomId>> {
        let mut evicted = HashSet::new();
        for _ in 0..EVICTION_ROUNDS {
            if self.used_bytes().await? <= budget {
                break;
            }
            let documents = self.documents().await?;
            if documents == 0 {
                break;
            }
            let oldest = self
                .rows(statement!(
                    "SELECT room_id, max(ts) FROM
                         (SELECT room_id, ts FROM doc ORDER BY ts, id LIMIT ?1)
                     GROUP BY room_id",
                    documents / 10 + 1
                ))
                .await?;
            let mut statements = Vec::new();
            for row in &oldest {
                let (Some(room_id), Some(newest)) = (text(row, 0), int(row, 1)) else {
                    continue;
                };
                let floor = newest.saturating_add(1);
                statements.extend([
                    statement!(
                        "DELETE FROM doc WHERE room_id = ?1 AND ts < ?2",
                        room_id,
                        floor
                    ),
                    statement!(
                        "DELETE FROM classified WHERE room_id = ?1 AND ts < ?2",
                        room_id,
                        floor
                    ),
                    statement!(
                        "INSERT INTO room (room_id, floor) VALUES (?1, ?2)
                         ON CONFLICT (room_id) DO UPDATE SET floor = max(floor, excluded.floor)",
                        room_id,
                        floor
                    ),
                ]);
                if let Ok(room_id) = OwnedRoomId::try_from(room_id) {
                    evicted.insert(room_id);
                }
            }
            statements.push(statement!("PRAGMA incremental_vacuum"));
            self.run(statements).await?;
        }
        Ok(evicted.into_iter().collect())
    }

    pub(super) async fn stats(&self) -> Result<Stats> {
        let answers = self
            .run(vec![
                statement!(sable_sql::CACHE_USED),
                statement!("PRAGMA cache_size"),
                statement!("PRAGMA page_size"),
                statement!(
                    "SELECT (page_count - freelist_count) * page_size
                     FROM pragma_page_count, pragma_freelist_count, pragma_page_size"
                ),
                statement!("SELECT name, sum(pgsize) FROM dbstat GROUP BY name"),
                statement!("SELECT count(*) FROM doc"),
            ])
            .await?;
        let one = |at: usize| answers.get(at)?.first()?.first();
        let memory_used = one(0).and_then(Value::as_u64).unwrap_or(0);
        let cache = match one(1) {
            Some(Value::Integer(size)) => *size,
            _ => 0,
        };
        let page_size = one(2).and_then(Value::as_u64).unwrap_or(0);
        let disk = one(3).and_then(Value::as_u64).unwrap_or(0);
        let documents = one(5).and_then(Value::as_u64).unwrap_or(0);
        let parts: &[Vec<Value>] = answers.get(4).map_or(&[], Vec::as_slice);
        let (mut index, mut table) = (0, 0);
        for row in parts {
            let (Some(name), Some(bytes)) = (text(row, 0), int(row, 1)) else {
                continue;
            };
            if name.starts_with("fts") {
                index += bytes;
            } else if name == "doc" || name.starts_with("doc_by_") {
                table += bytes;
            }
        }
        Ok(Stats {
            documents: usize::try_from(documents).unwrap_or(usize::MAX),
            memory_used,
            memory_budget: if cache < 0 {
                cache.unsigned_abs() * 1024
            } else {
                cache.unsigned_abs() * page_size
            },
            disk,
            disk_index: index,
            disk_bookkeeping: disk.saturating_sub(index + table),
        })
    }

    #[cfg(test)]
    pub(super) async fn set_floor(&self, room_id: &RoomId, floor: u64) -> Result<()> {
        self.rows(statement!(
            "INSERT INTO room (room_id, floor) VALUES (?1, ?2)
             ON CONFLICT (room_id) DO UPDATE SET floor = excluded.floor",
            room_id.as_str(),
            floor
        ))
        .await
        .map(drop)
    }

    #[cfg(test)]
    pub(super) async fn pending_edits(&self) -> usize {
        let rows = self
            .rows(statement!("SELECT count(*) FROM pending_edit"))
            .await
            .unwrap_or_default();
        rows.first()
            .and_then(|row| int(row, 0))
            .and_then(|count| usize::try_from(count).ok())
            .unwrap_or(0)
    }
}

#[expect(clippy::expect_used, reason = "a document is plain data")]
pub(super) fn document_json(document: &Document) -> Vec<u8> {
    serde_json::to_vec(document).expect("a document serializes")
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
