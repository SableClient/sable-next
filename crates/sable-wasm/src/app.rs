use std::sync::Arc;

use async_trait::async_trait;
use js_sys::Function;
use sable_core::{Core, protocol::RpcError};
use sable_ffi::{AccountGate, AppError, Ffi, Tabs};
use sable_runtime::{App, Backend, Platform, PlatformError, Ports};
use serde_json::value::RawValue;
use wasm_bindgen::{JsValue, prelude::*};

use crate::{SableCore, session_store::settle};

struct CoreBackend {
    core: Arc<Core>,
    gate: AccountGate,
}

#[async_trait(?Send)]
impl Backend for CoreBackend {
    async fn call(&self, method: &str, params: &str) -> Result<Box<RawValue>, RpcError> {
        let _serving = self.gate.serving().await;
        Box::pin(self.core.call(method, params)).await
    }
}

struct JsPlatform {
    get: Function,
    set: Function,
}

fn failed(error: &JsValue) -> PlatformError {
    PlatformError::Failed(format!("{error:?}"))
}

#[async_trait(?Send)]
impl Platform for JsPlatform {
    async fn storage_get(&self, key: &str) -> Result<Option<String>, PlatformError> {
        let value = settle(self.get.call1(&JsValue::NULL, &JsValue::from_str(key)))
            .await
            .map_err(|error| failed(&error))?;
        Ok(value.as_string())
    }

    async fn storage_set(&self, key: &str, value: &str) -> Result<(), PlatformError> {
        settle(self.set.call2(
            &JsValue::NULL,
            &JsValue::from_str(key),
            &JsValue::from_str(value),
        ))
        .await
        .map(drop)
        .map_err(|error| failed(&error))
    }
}

#[wasm_bindgen]
pub struct SableApp {
    ffi: Ffi,
    tabs: Tabs<u32>,
}

fn code(error: AppError) -> String {
    error.code().to_owned()
}

#[wasm_bindgen]
impl SableApp {
    #[wasm_bindgen(constructor)]
    #[expect(
        clippy::arc_with_non_send_sync,
        reason = "the worker is one thread, and `Ports` holds its parts in `Arc`s"
    )]
    pub fn new(
        core: &SableCore,
        get: Function,
        set: Function,
        send: Function,
    ) -> Result<SableApp, String> {
        let ports = Ports {
            backend: Arc::new(CoreBackend {
                core: core.core.clone(),
                gate: core.gate.clone(),
            }),
            platform: Arc::new(JsPlatform { get, set }),
        };
        let registry = sable_ffi::registry().map_err(|error| error.to_string())?;
        let ffi = Ffi::new(App::new(registry, ports, ""));
        core.gate.attach(ffi.clone());
        let tabs = Tabs::new(ffi.clone(), move |tab: &u32, batch| {
            if let Ok(json) = serde_json::to_string(&batch) {
                let _ = send.call2(
                    &JsValue::NULL,
                    &JsValue::from(*tab),
                    &JsValue::from_str(&json),
                );
            }
        });
        wasm_bindgen_futures::spawn_local({
            let tabs = tabs.clone();
            async move { tabs.pump().await }
        });
        Ok(SableApp { ffi, tabs })
    }

    pub async fn open(&self, tab: u32) {
        self.tabs.open(tab).await;
    }

    pub async fn close(&self, tab: u32) {
        self.tabs.close(&tab).await;
    }

    pub fn handshake(&self) -> Result<String, String> {
        self.ffi.handshake().map_err(code)
    }

    pub async fn subscribe(&self, tab: u32, request: String) -> Result<String, String> {
        self.tabs.subscribe(&tab, &request).await.map_err(code)
    }

    pub async fn unsubscribe(&self, tab: u32, sub: u32) -> Result<(), String> {
        self.tabs.unsubscribe(&tab, sub).await.map_err(code)
    }

    pub async fn resync(&self, tab: u32, sub: u32) -> Result<String, String> {
        self.tabs.resync(&tab, sub).await.map_err(code)
    }

    pub async fn range(&self, tab: u32, sub: u32, window: String) -> Result<String, String> {
        self.tabs.range(&tab, sub, &window).await.map_err(code)
    }

    pub async fn dispatch(&self, target: String, action: String) -> Result<(), String> {
        self.tabs.dispatch(&target, &action).await.map_err(code)
    }

    pub async fn request(&self, tab: u32, target: String, action: String) -> Result<u64, String> {
        self.tabs
            .request(&tab, &target, &action)
            .await
            .map_err(code)
    }

    pub async fn shutdown(&self) {
        let _ = self.ffi.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use js_sys::Function;
    use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

    use super::SableApp;
    use crate::SableCore;

    wasm_bindgen_test_configure!(run_in_shared_worker);

    fn app() -> SableApp {
        let core = SableCore::new(
            "sable-app-tests".to_owned(),
            Function::new_no_args("return Promise.resolve(null);"),
            Function::new_with_args("bytes", "return Promise.resolve();"),
            Function::new_no_args("return Promise.resolve();"),
            true,
        );
        SableApp::new(
            &core,
            Function::new_with_args("key", "return Promise.resolve(globalThis[key] ?? null);"),
            Function::new_with_args(
                "key, value",
                "globalThis[key] = value; return Promise.resolve();",
            ),
            Function::new_with_args("tab, batch", ""),
        )
        .expect("the app builds")
    }

    #[wasm_bindgen_test]
    fn the_handshake_names_the_wire_and_the_slices() {
        let handshake: serde_json::Value =
            serde_json::from_str(&app().handshake().expect("handshake")).expect("JSON");

        assert_eq!(handshake["schema"], sable_runtime::WIRE_SCHEMA);
        assert_eq!(
            handshake["slices"],
            serde_json::json!(if cfg!(feature = "demo") {
                vec!["counter", "rooms", "sidebar", "timeline"]
            } else {
                vec!["rooms", "sidebar", "timeline"]
            })
        );
    }

    #[wasm_bindgen_test]
    async fn an_unknown_slice_rejects_with_its_code() {
        let rejection = app()
            .subscribe(1, r#"{"slice":"nope","key":null}"#.to_owned())
            .await
            .expect_err("no such slice");

        assert_eq!(rejection, "unknown_slice");
    }
}
