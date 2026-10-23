//! The surface every shell binds: JSON strings, integers and a flat error enum,
//! so wasm-bindgen, napi, Tauri and uniffi can all wrap it.
//!
//! Input is decoded with the runtime's size and depth limits, and no error echoes it.
//!
//! On native targets every call runs on the tokio handle given to [`Ffi::new`],
//! because a shell's own threads are usually outside a tokio runtime.

#![expect(
    clippy::missing_errors_doc,
    reason = "every call fails with an `FfiError`, which says what each variant means"
)]

mod account;
#[cfg(feature = "demo")]
pub mod demo;
#[cfg(not(target_family = "wasm"))]
mod files;
mod tabs;

use std::{collections::HashMap, future::Future, sync::Arc};

pub use account::{AccountGate, account_after, changes_account};
#[cfg(not(target_family = "wasm"))]
pub use files::FileStorage;
use sable_protocol::CoreEvent;
use sable_runtime::{
    App, AppError, Batch, SubId, SubscribeRequest, Target, Window, decode, rt::SendOutsideWasm,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
pub use tabs::Tabs;

/// Shells log the code and report an opaque failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FfiError {
    #[error("input is not valid for this call")]
    Invalid,
    #[error("input is too large")]
    TooLarge,
    #[error("no such slice")]
    UnknownSlice,
    #[error("no such subscription")]
    UnknownSub,
    #[error("no such query")]
    UnknownQuery,
    #[error("the slice has stopped")]
    Stopped,
    #[error("the state does not serialize")]
    Encode,
}

impl FfiError {
    /// Stable, for shells that map errors by string.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::TooLarge => "too_large",
            Self::UnknownSlice => "unknown_slice",
            Self::UnknownSub => "unknown_sub",
            Self::UnknownQuery => "unknown_query",
            Self::Stopped => "stopped",
            Self::Encode => "encode",
        }
    }
}

impl From<AppError> for FfiError {
    fn from(error: AppError) -> Self {
        match error {
            AppError::Invalid => Self::Invalid,
            AppError::TooLarge { .. } => Self::TooLarge,
            AppError::UnknownSlice => Self::UnknownSlice,
            AppError::UnknownSub => Self::UnknownSub,
            AppError::Stopped => Self::Stopped,
            AppError::Encode => Self::Encode,
        }
    }
}

type Query = Box<dyn Fn(&str) -> Result<String, FfiError> + Send + Sync>;

/// Pure functions a shell calls by name, such as the model's parsers.
#[derive(Default)]
pub struct Queries(HashMap<&'static str, Query>);

impl Queries {
    #[must_use]
    pub fn add<I, O>(
        mut self,
        name: &'static str,
        query: impl Fn(I) -> O + Send + Sync + 'static,
    ) -> Self
    where
        I: DeserializeOwned,
        O: Serialize,
    {
        self.0
            .insert(name, Box::new(move |input| encode(&query(decode(input)?))));
        self
    }
}

fn encode<T: Serialize>(value: &T) -> Result<String, FfiError> {
    serde_json::to_string(value).map_err(|_| FfiError::Encode)
}

#[derive(Clone)]
pub struct Ffi {
    app: App,
    queries: Arc<Queries>,
    #[cfg(not(target_family = "wasm"))]
    runtime: tokio::runtime::Handle,
}

impl Ffi {
    #[cfg(not(target_family = "wasm"))]
    #[must_use]
    pub fn new(app: App, queries: Queries, runtime: tokio::runtime::Handle) -> Self {
        Self {
            app,
            queries: Arc::new(queries),
            runtime,
        }
    }

    #[cfg(target_family = "wasm")]
    #[must_use]
    pub fn new(app: App, queries: Queries) -> Self {
        Self {
            app,
            queries: Arc::new(queries),
        }
    }

    #[cfg(not(target_family = "wasm"))]
    async fn run<T>(
        &self,
        work: impl Future<Output = T> + SendOutsideWasm + 'static,
    ) -> Result<T, FfiError>
    where
        T: SendOutsideWasm + 'static,
    {
        self.runtime
            .spawn(work)
            .await
            .map_err(|_| FfiError::Stopped)
    }

    #[cfg(target_family = "wasm")]
    async fn run<T>(
        &self,
        work: impl Future<Output = T> + SendOutsideWasm + 'static,
    ) -> Result<T, FfiError> {
        Ok(work.await)
    }

    pub fn handshake(&self) -> Result<String, FfiError> {
        encode(&self.app.handshake())
    }

    /// `request` is a `SubscribeRequest`, the answer a `Subscribed`.
    pub async fn subscribe(&self, request: &str) -> Result<String, FfiError> {
        let request: SubscribeRequest = decode(request)?;
        let app = self.app.clone();
        let subscribed = self
            .run(async move { app.subscribe(request).await })
            .await??;
        encode(&subscribed)
    }

    pub async fn unsubscribe(&self, sub: u32) -> Result<(), FfiError> {
        let app = self.app.clone();
        self.run(async move { app.unsubscribe(SubId(sub)).await })
            .await
    }

    pub async fn resync(&self, sub: u32) -> Result<String, FfiError> {
        let app = self.app.clone();
        let snapshot = self
            .run(async move { app.resync(SubId(sub)).await })
            .await??;
        encode(&snapshot)
    }

    /// `window` is `null` for the whole list.
    pub async fn range(&self, sub: u32, window: &str) -> Result<String, FfiError> {
        let window: Option<Window> = decode(window)?;
        let app = self.app.clone();
        let snapshot = self
            .run(async move { app.range(SubId(sub), window).await })
            .await??;
        encode(&snapshot)
    }

    /// `target` is a `Target` and `action` the slice's action.
    pub async fn dispatch(&self, target: &str, action: &str) -> Result<(), FfiError> {
        let (target, action): (Target, Value) = (decode(target)?, decode(action)?);
        let app = self.app.clone();
        self.run(async move { app.dispatch(&target, action).await })
            .await??;
        Ok(())
    }

    /// Answered later by a `Reply` carrying the returned id.
    pub async fn request(&self, target: &str, action: &str) -> Result<u64, FfiError> {
        let (target, action): (Target, Value) = (decode(target)?, decode(action)?);
        let app = self.app.clone();
        let req = self
            .run(async move { app.request(&target, action).await })
            .await??;
        Ok(req.0)
    }

    pub fn query(&self, name: &str, input: &str) -> Result<String, FfiError> {
        let query = self.queries.0.get(name).ok_or(FfiError::UnknownQuery)?;
        query(input)
    }

    pub async fn next_batch(&self) -> Result<String, FfiError> {
        encode(&self.app.next_batch().await)
    }

    pub fn try_next_batch(&self) -> Result<Option<String>, FfiError> {
        self.app
            .try_next_batch()
            .map(|batch: Batch| encode(&batch))
            .transpose()
    }

    /// For a shell that holds the core in Rust and forwards its events.
    pub async fn offer(&self, event: CoreEvent) -> Result<(), FfiError> {
        let app = self.app.clone();
        self.run(async move { app.offer(&event).await }).await
    }

    /// Moves to the next account; see `App::switch_account`.
    pub async fn switch_account(&self, account: String) -> Result<(), FfiError> {
        let app = self.app.clone();
        self.run(async move { app.switch_account(account).await })
            .await
    }

    pub async fn shutdown(&self) -> Result<(), FfiError> {
        let app = self.app.clone();
        self.run(async move { app.shutdown().await }).await
    }
}
