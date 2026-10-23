use std::sync::Arc;

use async_trait::async_trait;
use napi::{
    Env, Status,
    bindgen_prelude::{PromiseRaw, within_runtime_if_available},
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use sable_core::{Core, protocol::RpcError, session::snapshot_dir};
use sable_ffi::{AccountGate, AppError, Ffi, FileStorage, Tabs};
use sable_runtime::{App, Backend, Ports, Registry};
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

fn rejection(error: AppError) -> napi::Error {
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
        };
        let runtime = within_runtime_if_available(tokio::runtime::Handle::try_current)
            .map_err(|error| napi::Error::new(Status::GenericFailure, error.to_string()))?;
        let registry = Registry::new();
        #[cfg(feature = "demo")]
        let registry = sable_ffi::demo::register(registry)
            .map_err(|error| napi::Error::new(Status::GenericFailure, error.to_string()))?;
        let ffi = Ffi::new(App::new(registry, ports, ""), runtime);
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

    #[napi]
    pub fn open<'env>(&self, env: &'env Env, tab: u32) -> napi::Result<PromiseRaw<'env, ()>> {
        let tabs = self.tabs.clone();
        env.spawn_future(async move {
            tabs.open(tab).await;
            Ok(())
        })
    }

    #[napi]
    pub fn close<'env>(&self, env: &'env Env, tab: u32) -> napi::Result<PromiseRaw<'env, ()>> {
        let tabs = self.tabs.clone();
        env.spawn_future(async move {
            tabs.close(&tab).await;
            Ok(())
        })
    }

    #[napi]
    pub fn handshake(&self) -> napi::Result<String> {
        self.ffi.handshake().map_err(rejection)
    }

    #[napi]
    pub fn subscribe<'env>(
        &self,
        env: &'env Env,
        tab: u32,
        request: String,
    ) -> napi::Result<PromiseRaw<'env, String>> {
        let tabs = self.tabs.clone();
        env.spawn_future(async move { tabs.subscribe(&tab, &request).await.map_err(rejection) })
    }

    #[napi]
    pub fn unsubscribe<'env>(
        &self,
        env: &'env Env,
        tab: u32,
        sub: u32,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let tabs = self.tabs.clone();
        env.spawn_future(async move { tabs.unsubscribe(&tab, sub).await.map_err(rejection) })
    }

    #[napi]
    pub fn resync<'env>(
        &self,
        env: &'env Env,
        tab: u32,
        sub: u32,
    ) -> napi::Result<PromiseRaw<'env, String>> {
        let tabs = self.tabs.clone();
        env.spawn_future(async move { tabs.resync(&tab, sub).await.map_err(rejection) })
    }

    #[napi]
    pub fn range<'env>(
        &self,
        env: &'env Env,
        tab: u32,
        sub: u32,
        window: String,
    ) -> napi::Result<PromiseRaw<'env, String>> {
        let tabs = self.tabs.clone();
        env.spawn_future(async move { tabs.range(&tab, sub, &window).await.map_err(rejection) })
    }

    #[napi]
    pub fn dispatch<'env>(
        &self,
        env: &'env Env,
        target: String,
        action: String,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let tabs = self.tabs.clone();
        env.spawn_future(async move { tabs.dispatch(&target, &action).await.map_err(rejection) })
    }

    #[napi]
    pub fn request<'env>(
        &self,
        env: &'env Env,
        tab: u32,
        target: String,
        action: String,
    ) -> napi::Result<PromiseRaw<'env, i64>> {
        let tabs = self.tabs.clone();
        env.spawn_future(async move {
            let req = tabs
                .request(&tab, &target, &action)
                .await
                .map_err(rejection)?;
            i64::try_from(req).map_err(|_| rejection(AppError::Encode))
        })
    }

    #[napi]
    pub fn shutdown<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
        let ffi = self.ffi.clone();
        env.spawn_future(async move {
            let _ = ffi.shutdown().await;
            Ok(())
        })
    }
}
