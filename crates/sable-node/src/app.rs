//! The app runtime over the core the process already holds.

use std::{path::PathBuf, sync::Arc};

use async_trait::async_trait;
use napi::{Status, bindgen_prelude::within_runtime_if_available};
use napi_derive::napi;
use sable_core::{
    Core,
    protocol::RpcError,
    session::{SNAPSHOT_DIR, account_store_id},
};
use sable_ffi::{Ffi, FfiError, FileStorage, Queries};
use sable_runtime::{App, Backend, Ports, Registry, SystemClock};
use serde_json::value::RawValue;
use tokio::sync::RwLock;

use crate::SableCore;

/// Holds the runtime's calls back while an account change is under way, so
/// that the core serves the new account only after `switch_account` returned.
struct CoreBackend {
    core: Arc<Core>,
    switching: Arc<RwLock<()>>,
}

#[async_trait]
impl Backend for CoreBackend {
    async fn call(&self, method: &str, params: &str) -> Result<Box<RawValue>, RpcError> {
        let _serving = self.switching.read().await;
        Box::pin(self.core.call(method, params)).await
    }
}

fn rejection(error: FfiError) -> napi::Error {
    napi::Error::new(Status::GenericFailure, error.code())
}

/// The runtime for the windows of one process. Every failure rejects with the
/// `code` of an `FfiError`. `SableCore.call` keeps it informed of the account.
#[napi]
pub struct SableApp {
    ffi: Ffi,
}

#[napi]
impl SableApp {
    /// Views are saved in the data directory of their account.
    #[napi(constructor)]
    pub fn new(core: &SableCore, data_dir: String) -> napi::Result<Self> {
        let ports = Ports {
            backend: Arc::new(CoreBackend {
                core: core.core.clone(),
                switching: core.switching.clone(),
            }),
            platform: Arc::new(FileStorage::new(move |account: &str| {
                if account.is_empty() {
                    PathBuf::from(&data_dir)
                } else {
                    PathBuf::from(account_store_id(&data_dir, account))
                }
                .join(SNAPSHOT_DIR)
            })),
            clock: Arc::new(SystemClock),
        };
        let runtime = within_runtime_if_available(tokio::runtime::Handle::try_current)
            .map_err(|error| napi::Error::new(Status::GenericFailure, error.to_string()))?;
        let registry = Registry::new();
        #[cfg(feature = "demo")]
        let registry = sable_ffi::demo::register(registry)
            .map_err(|error| napi::Error::new(Status::GenericFailure, error.to_string()))?;
        let ffi = Ffi::new(App::new(registry, ports, ""), Queries::default(), runtime);
        let _ = core.app.set(ffi.clone());
        Ok(Self { ffi })
    }

    #[napi]
    pub fn handshake(&self) -> napi::Result<String> {
        self.ffi.handshake().map_err(rejection)
    }

    #[napi]
    pub async fn subscribe(&self, request: String) -> napi::Result<String> {
        self.ffi.subscribe(&request).await.map_err(rejection)
    }

    #[napi]
    pub async fn unsubscribe(&self, sub: u32) -> napi::Result<()> {
        self.ffi.unsubscribe(sub).await.map_err(rejection)
    }

    #[napi]
    pub async fn resync(&self, sub: u32) -> napi::Result<String> {
        self.ffi.resync(sub).await.map_err(rejection)
    }

    #[napi]
    pub async fn range(&self, sub: u32, window: String) -> napi::Result<String> {
        self.ffi.range(sub, &window).await.map_err(rejection)
    }

    #[napi]
    pub async fn dispatch(&self, target: String, action: String) -> napi::Result<()> {
        self.ffi.dispatch(&target, &action).await.map_err(rejection)
    }

    /// Resolves with the id that the answering `Reply` carries.
    #[napi]
    pub async fn request(&self, target: String, action: String) -> napi::Result<i64> {
        let req = self
            .ffi
            .request(&target, &action)
            .await
            .map_err(rejection)?;
        i64::try_from(req).map_err(|_| rejection(FfiError::Encode))
    }

    /// The next `Batch` as JSON, waiting for one.
    #[napi]
    pub async fn next_batch(&self) -> napi::Result<String> {
        self.ffi.next_batch().await.map_err(rejection)
    }

    #[napi]
    pub async fn shutdown(&self) {
        let _ = self.ffi.shutdown().await;
    }
}
