use std::sync::Arc;

use async_trait::async_trait;
use napi::{
    Status,
    bindgen_prelude::within_runtime_if_available,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use sable_core::{Core, protocol::RpcError, session::snapshot_dir};
use sable_ffi::{AccountGate, Ffi, FfiError, FileStorage, Queries, Tabs};
use sable_runtime::{App, Backend, Ports, Registry, SystemClock};
use serde_json::value::RawValue;

use crate::SableCore;

struct CoreBackend {
    core: Arc<Core>,
    gate: AccountGate,
}

#[async_trait]
impl Backend for CoreBackend {
    async fn call(&self, method: &str, params: &str) -> Result<Box<RawValue>, RpcError> {
        let _serving = self.gate.serving().await;
        Box::pin(self.core.call(method, params)).await
    }
}

fn rejection(error: FfiError) -> napi::Error {
    napi::Error::new(Status::GenericFailure, error.code())
}

type BatchSink = ThreadsafeFunction<(u32, String), (), (u32, String), Status, false>;

#[napi]
pub struct SableApp {
    ffi: Ffi,
    tabs: Tabs<u32>,
}

#[napi]
impl SableApp {
    /// `send([tab, batch])` takes the JSON of the batch that belongs to a window.
    #[napi(constructor)]
    pub fn new(core: &SableCore, data_dir: String, send: BatchSink) -> napi::Result<Self> {
        let ports = Ports {
            backend: Arc::new(CoreBackend {
                core: core.core.clone(),
                gate: core.gate.clone(),
            }),
            platform: Arc::new(FileStorage::new(move |account: &str| {
                snapshot_dir(&data_dir, account)
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
        core.gate.attach(ffi.clone());
        let tabs = Tabs::new(ffi.clone(), move |tab: &u32, batch| {
            if let Ok(json) = serde_json::to_string(&batch) {
                send.call((*tab, json), ThreadsafeFunctionCallMode::NonBlocking);
            }
        });
        napi::bindgen_prelude::spawn({
            let tabs = tabs.clone();
            async move { tabs.pump().await }
        });
        Ok(Self { ffi, tabs })
    }

    /// Lets go of what an earlier tab of that number held.
    #[napi]
    pub async fn open(&self, tab: u32) {
        self.tabs.open(tab).await;
    }

    #[napi]
    pub async fn close(&self, tab: u32) {
        self.tabs.close(&tab).await;
    }

    #[napi]
    pub fn handshake(&self) -> napi::Result<String> {
        self.ffi.handshake().map_err(rejection)
    }

    #[napi]
    pub async fn subscribe(&self, tab: u32, request: String) -> napi::Result<String> {
        self.tabs.subscribe(&tab, &request).await.map_err(rejection)
    }

    #[napi]
    pub async fn unsubscribe(&self, tab: u32, sub: u32) -> napi::Result<()> {
        self.tabs.unsubscribe(&tab, sub).await.map_err(rejection)
    }

    #[napi]
    pub async fn resync(&self, tab: u32, sub: u32) -> napi::Result<String> {
        self.tabs.resync(&tab, sub).await.map_err(rejection)
    }

    #[napi]
    pub async fn range(&self, tab: u32, sub: u32, window: String) -> napi::Result<String> {
        self.tabs.range(&tab, sub, &window).await.map_err(rejection)
    }

    #[napi]
    pub async fn dispatch(&self, target: String, action: String) -> napi::Result<()> {
        self.tabs
            .dispatch(&target, &action)
            .await
            .map_err(rejection)
    }

    #[napi]
    pub async fn request(&self, tab: u32, target: String, action: String) -> napi::Result<i64> {
        let req = self
            .tabs
            .request(&tab, &target, &action)
            .await
            .map_err(rejection)?;
        i64::try_from(req).map_err(|_| rejection(FfiError::Encode))
    }

    #[napi]
    pub async fn shutdown(&self) {
        let _ = self.ffi.shutdown().await;
    }
}
