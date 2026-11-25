//! Where statements run: against a connection in this process, or, on the web,
//! in the dedicated worker that owns the file.

use sable_sql::{Rows, Statement};

#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

#[cfg(not(target_family = "wasm"))]
use parking_lot::Mutex;
#[cfg(not(target_family = "wasm"))]
use rusqlite::Connection;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(super) struct SqlError(pub(super) String);

pub(super) type Result<T> = std::result::Result<T, SqlError>;

pub(super) enum Exec {
    /// `None` while the app is suspended.
    #[cfg(not(target_family = "wasm"))]
    Native(Arc<Mutex<Option<Connection>>>),
    /// Like `Native`, but every batch crosses the wire format first, as it does to the worker.
    #[cfg(all(test, not(target_family = "wasm")))]
    Wire(Arc<Mutex<Connection>>),
    /// `None` until a database is chosen for the account.
    #[cfg(target_family = "wasm")]
    Web(Option<String>),
}

impl Exec {
    #[cfg_attr(
        not(target_family = "wasm"),
        expect(
            clippy::missing_const_for_fn,
            reason = "the web build asks the worker link"
        )
    )]
    pub(super) fn ready(&self) -> bool {
        match self {
            #[cfg(not(target_family = "wasm"))]
            Self::Native(_) => true,
            #[cfg(all(test, not(target_family = "wasm")))]
            Self::Wire(_) => true,
            #[cfg(target_family = "wasm")]
            Self::Web(database) => database.is_some() && super::store_web::attached(),
        }
    }

    /// Runs `statements` as one transaction.
    #[cfg_attr(
        test,
        expect(
            clippy::unused_async,
            clippy::unused_async_trait_impl,
            reason = "tests run inline"
        )
    )]
    pub(super) async fn batch(&self, statements: Vec<Statement>) -> Result<Vec<Rows>> {
        match self {
            #[cfg(all(not(target_family = "wasm"), not(test)))]
            Self::Native(connection) => {
                let connection = connection.clone();
                match tokio::task::spawn_blocking(move || run_native(&connection, &statements))
                    .await
                {
                    Ok(answers) => answers,
                    Err(error) => std::panic::resume_unwind(error.into_panic()),
                }
            }
            #[cfg(all(not(target_family = "wasm"), test))]
            Self::Native(connection) => run_native(connection, &statements),
            #[cfg(all(test, not(target_family = "wasm")))]
            Self::Wire(connection) => {
                let request = sable_sql::Request {
                    id: 1,
                    database: String::new(),
                    remove: false,
                    statements,
                };
                let request: sable_sql::Request =
                    sable_sql::decode(&sable_sql::encode(&request)).map_err(SqlError)?;
                let result = sable_sql::run_batch(&mut connection.lock(), &request.statements)
                    .map_err(|error| error.to_string());
                let response = sable_sql::Response {
                    id: request.id,
                    result,
                };
                let response: sable_sql::Response =
                    sable_sql::decode(&sable_sql::encode(&response)).map_err(SqlError)?;
                response.result.map_err(SqlError)
            }
            #[cfg(target_family = "wasm")]
            Self::Web(database) => {
                let database = database
                    .as_deref()
                    .ok_or_else(|| SqlError("no search database yet".to_owned()))?;
                super::store_web::send(database, statements).await
            }
        }
    }
}

#[cfg(not(target_family = "wasm"))]
fn run_native(
    connection: &Mutex<Option<Connection>>,
    statements: &[Statement],
) -> Result<Vec<Rows>> {
    let mut connection = connection.lock();
    let connection = connection.as_mut().ok_or_else(|| {
        SqlError("the search database is closed while the app is suspended".to_owned())
    })?;
    sable_sql::run_batch(connection, statements).map_err(|error| SqlError(error.to_string()))
}

/// Runs a future that never waits, which is every future of an inline executor.
#[cfg(test)]
pub(super) fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let waker = futures_util::task::noop_waker();
    let mut context = std::task::Context::from_waker(&waker);
    match future.as_mut().poll(&mut context) {
        std::task::Poll::Ready(output) => output,
        std::task::Poll::Pending => panic!("an inline executor waited"),
    }
}
