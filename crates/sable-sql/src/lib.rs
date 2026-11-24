//! The database the search index lives in, spoken to in batches of statements.
//! The same code runs beside the core and, on the web, in the dedicated worker
//! that owns the OPFS file.

use serde::{Deserialize, Serialize};

#[cfg(feature = "engine")]
pub use rusqlite;
#[cfg(feature = "engine")]
use rusqlite::types::{Value as SqliteValue, ValueRef};
#[cfg(feature = "engine")]
use rusqlite::{Connection, params_from_iter};

#[cfg(feature = "engine")]
const SCHEMA: i64 = 2;
#[cfg(feature = "engine")]
/// The page cache the index may use, as the memory budget it reports.
const CACHE_KIB: i64 = 64 * 1024;
#[cfg(feature = "engine")]
/// What the write-ahead log shrinks back to once a large batch is checkpointed.
const LOG_BYTES: i64 = 16 * 1024 * 1024;

/// A statement that answers with the bytes the page cache holds, which no SQL says.
pub const CACHE_USED: &str = "sable:cache-used";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Value {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Value {
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Integer(number) => u64::try_from(*number).ok(),
            _ => None,
        }
    }

    #[must_use]
    pub const fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Real(number) => Some(*number),
            #[expect(clippy::cast_precision_loss, reason = "scores are approximate")]
            Self::Integer(number) => Some(*number as f64),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_blob(&self) -> Option<&[u8]> {
        match self {
            Self::Blob(bytes) => Some(bytes),
            Self::Text(text) => Some(text.as_bytes()),
            _ => None,
        }
    }
}

impl From<&str> for Value {
    fn from(text: &str) -> Self {
        Self::Text(text.to_owned())
    }
}

impl From<String> for Value {
    fn from(text: String) -> Self {
        Self::Text(text)
    }
}

impl From<i64> for Value {
    fn from(number: i64) -> Self {
        Self::Integer(number)
    }
}

impl From<u64> for Value {
    fn from(number: u64) -> Self {
        Self::Integer(i64::try_from(number).unwrap_or(i64::MAX))
    }
}

impl From<usize> for Value {
    fn from(number: usize) -> Self {
        Self::from(number as u64)
    }
}

impl From<bool> for Value {
    fn from(flag: bool) -> Self {
        Self::Integer(i64::from(flag))
    }
}

impl From<Vec<u8>> for Value {
    fn from(bytes: Vec<u8>) -> Self {
        Self::Blob(bytes)
    }
}

/// A statement with its parameters, each anything a [`Value`] can be made from.
#[macro_export]
macro_rules! statement {
    ($sql:expr $(, $param:expr)* $(,)?) => {
        $crate::Statement {
            sql: ($sql).to_owned(),
            params: vec![$($crate::Value::from($param)),*],
        }
    };
}

#[cfg(feature = "engine")]
impl From<Value> for SqliteValue {
    fn from(value: Value) -> Self {
        match value {
            Value::Null => Self::Null,
            Value::Integer(number) => Self::Integer(number),
            Value::Real(number) => Self::Real(number),
            Value::Text(text) => Self::Text(text),
            Value::Blob(bytes) => Self::Blob(bytes),
        }
    }
}

#[cfg(feature = "engine")]
impl From<ValueRef<'_>> for Value {
    fn from(value: ValueRef<'_>) -> Self {
        match value {
            ValueRef::Null => Self::Null,
            ValueRef::Integer(number) => Self::Integer(number),
            ValueRef::Real(number) => Self::Real(number),
            ValueRef::Text(text) => Self::Text(String::from_utf8_lossy(text).into_owned()),
            ValueRef::Blob(bytes) => Self::Blob(bytes.to_vec()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Statement {
    pub sql: String,
    pub params: Vec<Value>,
}

pub type Rows = Vec<Vec<Value>>;

/// A batch runs in one transaction and answers with the rows of each statement.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Request {
    pub id: u32,
    pub database: String,
    pub statements: Vec<Statement>,
    /// Drops the database instead of running anything.
    pub remove: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Response {
    pub id: u32,
    pub result: Result<Vec<Rows>, String>,
}

/// # Errors
/// Fails when `bytes` is not a message of the expected kind.
pub fn decode<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Result<T, String> {
    rmp_serde::from_slice(bytes).map_err(|error| error.to_string())
}

#[must_use]
pub fn encode<T: Serialize>(message: &T) -> Vec<u8> {
    rmp_serde::to_vec(message).unwrap_or_default()
}

#[cfg(feature = "engine")]
/// # Errors
/// Fails with the first statement that fails, and leaves nothing of the batch behind.
pub fn run_batch(
    connection: &mut Connection,
    statements: &[Statement],
) -> rusqlite::Result<Vec<Rows>> {
    let transaction = connection.transaction()?;
    let mut answers = Vec::with_capacity(statements.len());
    for statement in statements {
        if statement.sql == CACHE_USED {
            answers.push(vec![vec![Value::Integer(cache_used(&transaction))]]);
            continue;
        }
        let mut prepared = transaction.prepare_cached(&statement.sql)?;
        let params = statement.params.iter().cloned().map(SqliteValue::from);
        let columns = prepared.column_count();
        let mut found = prepared.query(params_from_iter(params))?;
        let mut rows = Rows::new();
        while let Some(row) = found.next()? {
            rows.push(
                (0..columns)
                    .map(|column| row.get_ref(column).map(Value::from))
                    .collect::<rusqlite::Result<_>>()?,
            );
        }
        answers.push(rows);
    }
    transaction.commit()?;
    Ok(answers)
}

#[cfg(feature = "engine")]
#[expect(unsafe_code, reason = "SQLite has no safe way to read its cache use")]
fn cache_used(connection: &Connection) -> i64 {
    let (mut current, mut highest) = (0, 0);
    // SAFETY: the handle is open while `connection` is borrowed.
    let handle = unsafe { connection.handle() };
    // SAFETY: the call only writes its counters into the two integers.
    unsafe {
        rusqlite::ffi::sqlite3_db_status(
            handle,
            rusqlite::ffi::SQLITE_DBSTATUS_CACHE_USED,
            &raw mut current,
            &raw mut highest,
            0,
        );
    }
    i64::from(current)
}

#[cfg(feature = "engine")]
#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("the database was written by schema {0}")]
    Schema(i64),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

#[cfg(feature = "engine")]
impl OpenError {
    /// Whether the file itself is at fault, so that only starting it over
    /// helps. A busy or unreadable file is left alone.
    #[must_use]
    pub fn starts_over(&self) -> bool {
        use rusqlite::ErrorCode::{DatabaseCorrupt, NotADatabase};

        match self {
            Self::Schema(_) => true,
            Self::Sqlite(error) => matches!(
                error.sqlite_error_code(),
                Some(NotADatabase | DatabaseCorrupt)
            ),
        }
    }
}

#[cfg(feature = "engine")]
/// Gets a database ready for use, creating its tables when it is new.
///
/// # Errors
/// Fails when the file is not a search database, or one of another version.
pub fn prepare(connection: &Connection, write_ahead_log: bool) -> Result<(), OpenError> {
    let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version != 0 && version != SCHEMA {
        return Err(OpenError::Schema(version));
    }
    if version == 0 {
        connection.execute_batch("PRAGMA auto_vacuum = INCREMENTAL;")?;
    }
    if write_ahead_log {
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "journal_size_limit", LOG_BYTES)?;
    }
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "cache_size", -CACHE_KIB)?;
    if version == 0 {
        connection.execute_batch(&format!(
            "BEGIN; {SCHEMA_SQL} PRAGMA user_version = {SCHEMA}; COMMIT;"
        ))?;
    }
    Ok(())
}

#[cfg(feature = "engine")]
const SCHEMA_SQL: &str =
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID;
                 CREATE TABLE room (
                     room_id TEXT PRIMARY KEY,
                     floor INTEGER NOT NULL DEFAULT 0
                 ) WITHOUT ROWID;
                 CREATE TABLE doc (
                     id INTEGER PRIMARY KEY,
                     room_id TEXT NOT NULL,
                     event_id TEXT NOT NULL,
                     ts INTEGER NOT NULL,
                     sender TEXT NOT NULL,
                     state INTEGER NOT NULL,
                     attachment INTEGER NOT NULL,
                     json BLOB NOT NULL
                 );
                 CREATE UNIQUE INDEX doc_by_event ON doc (room_id, event_id);
                 CREATE INDEX doc_by_age ON doc (room_id, ts, event_id);
                 CREATE INDEX doc_by_ts ON doc (ts);
                 CREATE INDEX doc_by_attachment ON doc (room_id, ts, event_id)
                     WHERE attachment = 1;
                 CREATE TABLE classified (
                     room_id TEXT NOT NULL,
                     event_id TEXT NOT NULL,
                     ts INTEGER NOT NULL,
                     PRIMARY KEY (room_id, event_id)
                 ) WITHOUT ROWID;
                 CREATE INDEX classified_by_age ON classified (room_id, ts);
                 CREATE TABLE edit (
                     room_id TEXT NOT NULL,
                     edit_id TEXT NOT NULL,
                     target_id TEXT NOT NULL,
                     PRIMARY KEY (room_id, edit_id)
                 ) WITHOUT ROWID;
                 CREATE INDEX edit_by_target ON edit (room_id, target_id);
                 CREATE TABLE redacted (
                     room_id TEXT NOT NULL,
                     event_id TEXT NOT NULL,
                     PRIMARY KEY (room_id, event_id)
                 ) WITHOUT ROWID;
                 CREATE TABLE pending_edit (
                     room_id TEXT NOT NULL,
                     target_id TEXT NOT NULL,
                     edit_id TEXT NOT NULL,
                     event BLOB NOT NULL,
                     PRIMARY KEY (room_id, edit_id)
                 ) WITHOUT ROWID;
                 CREATE INDEX pending_edit_by_target ON pending_edit (room_id, target_id);
                 -- Terms arrive split by our tokenizer, so only white space may
                 -- separate them. The default categories also cut at marks and
                 -- symbols, which breaks Indic, Khmer, Myanmar and Lao words and
                 -- drops emoji.
                 CREATE VIRTUAL TABLE fts USING fts5(
                     text,
                     content = '',
                     contentless_delete = 1,
                     tokenize = \"unicode61 remove_diacritics 0 categories 'L* M* N* P* S* C*'\"
                 );
                 CREATE VIRTUAL TABLE fts_vocab USING fts5vocab(fts, row);
                 CREATE TRIGGER doc_deleted AFTER DELETE ON doc
                     BEGIN DELETE FROM fts WHERE rowid = old.id; END;";

#[cfg(all(test, feature = "engine"))]
mod tests {
    use super::*;

    fn statement(sql: &str, params: Vec<Value>) -> Statement {
        Statement {
            sql: sql.to_owned(),
            params,
        }
    }

    #[test]
    fn every_kind_of_value_survives_the_wire() {
        let request = Request {
            id: 7,
            database: "account".to_owned(),
            remove: false,
            statements: vec![statement(
                "SELECT ?1, ?2, ?3, ?4, ?5",
                vec![
                    Value::Null,
                    Value::Integer(i64::MIN),
                    Value::Real(1.5),
                    Value::Text("สวัสดี".to_owned()),
                    Value::Blob(vec![0, 255, 7]),
                ],
            )],
        };

        let decoded: Request = decode(&encode(&request)).unwrap();

        assert_eq!(decoded.id, 7);
        assert_eq!(decoded.database, "account");
        assert_eq!(decoded.statements, request.statements);
    }

    #[test]
    fn a_response_carries_its_error_text() {
        let failed = Response {
            id: 3,
            result: Err("no such table".to_owned()),
        };
        let decoded: Response = decode(&encode(&failed)).unwrap();
        assert_eq!(decoded.result, Err("no such table".to_owned()));
    }

    #[test]
    fn a_batch_answers_per_statement_and_is_all_or_nothing() {
        let mut connection = Connection::open_in_memory().unwrap();
        prepare(&connection, false).unwrap();

        let answers = run_batch(
            &mut connection,
            &[
                statement(
                    "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                    vec![Value::Text("a".to_owned()), Value::Blob(vec![1])],
                ),
                statement("SELECT key, value FROM meta", Vec::new()),
            ],
        )
        .unwrap();
        assert_eq!(answers[0], Rows::new());
        assert_eq!(
            answers[1],
            [vec![Value::Text("a".to_owned()), Value::Blob(vec![1])]]
        );

        let failed = run_batch(
            &mut connection,
            &[
                statement("DELETE FROM meta", Vec::new()),
                statement("SELECT * FROM missing", Vec::new()),
            ],
        );
        failed.unwrap_err();
        let kept = run_batch(
            &mut connection,
            &[statement("SELECT count(*) FROM meta", Vec::new())],
        )
        .unwrap();
        assert_eq!(kept[0], [vec![Value::Integer(1)]]);
    }

    #[test]
    fn only_a_file_at_fault_is_started_over() {
        let connection = Connection::open_in_memory().unwrap();
        connection.pragma_update(None, "user_version", 1).unwrap();
        let outdated = prepare(&connection, false).unwrap_err();
        assert!(matches!(outdated, OpenError::Schema(1)));
        assert!(outdated.starts_over());

        let busy = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            None,
        );
        assert!(!OpenError::from(busy).starts_over());
        let foreign = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTADB),
            None,
        );
        assert!(OpenError::from(foreign).starts_over());
    }
}
