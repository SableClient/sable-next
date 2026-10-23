use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
};

use async_trait::async_trait;
use sable_core::{Core, protocol::RpcError, session::snapshot_dir};
use sable_ffi::{AccountGate, Ffi, FfiError, FileStorage, Queries, Tabs};
use sable_runtime::{App, Backend, Batch, Ports, Registry, SystemClock};
use serde_json::value::RawValue;
use tauri::{
    State, Window,
    async_runtime::{RuntimeHandle, handle, spawn},
    ipc::Channel,
};

use crate::BrowserEngine;

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

type Channels = Arc<Mutex<HashMap<String, Channel<Batch>>>>;

pub struct Runtime {
    ffi: Ffi,
    tabs: Tabs<String>,
    channels: Channels,
}

impl Runtime {
    pub fn new(core: &Arc<Core>, gate: &AccountGate, data_dir: &str) -> Self {
        let data_dir = data_dir.to_owned();
        let ports = Ports {
            backend: Arc::new(CoreBackend {
                core: core.clone(),
                gate: gate.clone(),
            }),
            platform: Arc::new(FileStorage::new(move |account: &str| {
                snapshot_dir(&data_dir, account)
            })),
            clock: Arc::new(SystemClock),
        };
        let registry = Registry::new();
        #[cfg(feature = "demo")]
        let registry = match sable_ffi::demo::register(registry) {
            Ok(registry) => registry,
            Err(error) => {
                tracing::error!(%error, "a demo slice is registered twice");
                Registry::new()
            }
        };
        let RuntimeHandle::Tokio(tokio) = handle();
        let ffi = Ffi::new(App::new(registry, ports, ""), Queries::default(), tokio);
        gate.attach(ffi.clone());

        let channels = Channels::default();
        let sink = channels.clone();
        let tabs = Tabs::new(ffi.clone(), move |window: &String, batch| {
            let channel = sink
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(window)
                .cloned();
            if let Some(channel) = channel {
                let _ = channel.send(batch);
            }
        });
        spawn({
            let tabs = tabs.clone();
            async move { tabs.pump().await }
        });
        Self {
            ffi,
            tabs,
            channels,
        }
    }

    pub async fn close(&self, window: &str) {
        self.channels
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(window);
        self.tabs.close(&window.to_owned()).await;
    }

    /// Saves the views the runtime holds, which a quitting process has to do before it exits.
    pub async fn shutdown(&self) {
        let _ = self.ffi.shutdown().await;
    }
}

/// Every command rejects with the `code` of an `FfiError`.
fn answer(result: Result<String, FfiError>) -> Result<Box<RawValue>, &'static str> {
    result
        .and_then(|json| RawValue::from_string(json).map_err(|_| FfiError::Encode))
        .map_err(FfiError::code)
}

fn label(window: &Window<BrowserEngine>) -> String {
    window.label().to_owned()
}

#[tauri::command]
pub async fn runtime_connect(
    window: Window<BrowserEngine>,
    state: State<'_, Runtime>,
    channel: Channel<Batch>,
) -> Result<(), &'static str> {
    let label = label(&window);
    state.tabs.open(label.clone()).await;
    state
        .channels
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(label, channel);
    Ok(())
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri extracts command state by value"
)]
pub fn runtime_handshake(state: State<'_, Runtime>) -> Result<Box<RawValue>, &'static str> {
    answer(state.ffi.handshake())
}

#[tauri::command]
pub async fn runtime_subscribe(
    window: Window<BrowserEngine>,
    state: State<'_, Runtime>,
    request: Box<RawValue>,
) -> Result<Box<RawValue>, &'static str> {
    answer(state.tabs.subscribe(&label(&window), request.get()).await)
}

#[tauri::command]
pub async fn runtime_unsubscribe(
    window: Window<BrowserEngine>,
    state: State<'_, Runtime>,
    sub: u32,
) -> Result<(), &'static str> {
    state
        .tabs
        .unsubscribe(&label(&window), sub)
        .await
        .map_err(FfiError::code)
}

#[tauri::command]
pub async fn runtime_resync(
    window: Window<BrowserEngine>,
    state: State<'_, Runtime>,
    sub: u32,
) -> Result<Box<RawValue>, &'static str> {
    answer(state.tabs.resync(&label(&window), sub).await)
}

#[tauri::command]
pub async fn runtime_range(
    window: Window<BrowserEngine>,
    state: State<'_, Runtime>,
    sub: u32,
    range: Box<RawValue>,
) -> Result<Box<RawValue>, &'static str> {
    answer(state.tabs.range(&label(&window), sub, range.get()).await)
}

#[tauri::command]
pub async fn runtime_dispatch(
    state: State<'_, Runtime>,
    target: Box<RawValue>,
    action: Box<RawValue>,
) -> Result<(), &'static str> {
    state
        .tabs
        .dispatch(target.get(), action.get())
        .await
        .map_err(FfiError::code)
}

#[tauri::command]
pub async fn runtime_request(
    window: Window<BrowserEngine>,
    state: State<'_, Runtime>,
    target: Box<RawValue>,
    action: Box<RawValue>,
) -> Result<u64, &'static str> {
    state
        .tabs
        .request(&label(&window), target.get(), action.get())
        .await
        .map_err(FfiError::code)
}
