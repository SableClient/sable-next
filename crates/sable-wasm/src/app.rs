use std::sync::Arc;

use async_trait::async_trait;
use js_sys::Function;
use sable_core::{Core, protocol::RpcError};
use sable_ffi::{AccountGate, Ffi, Queries};
use sable_runtime::{App, Backend, Platform, PlatformError, Ports, Registry, SystemClock};
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

/// The worker owns `IndexedDB`, so storage goes through two JS functions returning Promises.
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
}

#[wasm_bindgen]
impl SableApp {
    /// `get` and `set` are the platform's storage and each must return a Promise.
    ///
    /// # Errors
    ///
    /// Returns the name of a slice registered twice.
    #[wasm_bindgen(constructor)]
    #[expect(
        clippy::arc_with_non_send_sync,
        reason = "the worker is one thread, and `Ports` holds its parts in `Arc`s"
    )]
    #[cfg_attr(
        not(feature = "demo"),
        expect(
            clippy::unnecessary_wraps,
            reason = "only registering a slice can fail, and none is registered without `demo`"
        )
    )]
    pub fn new(core: &SableCore, get: Function, set: Function) -> Result<SableApp, String> {
        let ports = Ports {
            backend: Arc::new(CoreBackend {
                core: core.core.clone(),
                gate: core.gate.clone(),
            }),
            platform: Arc::new(JsPlatform { get, set }),
            clock: Arc::new(SystemClock),
        };
        let registry = Registry::new();
        #[cfg(feature = "demo")]
        let registry = sable_ffi::demo::register(registry).map_err(|error| error.to_string())?;
        let ffi = Ffi::new(App::new(registry, ports, ""), Queries::default());
        core.gate.attach(ffi.clone());
        Ok(SableApp { ffi })
    }

    /// # Errors
    ///
    /// Rejects with the code of the `FfiError`.
    pub fn handshake(&self) -> Result<String, String> {
        self.ffi
            .handshake()
            .map_err(|error| error.code().to_owned())
    }

    /// # Errors
    ///
    /// Rejects with the code of the `FfiError`.
    pub async fn subscribe(&self, request: String) -> Result<String, String> {
        self.ffi
            .subscribe(&request)
            .await
            .map_err(|error| error.code().to_owned())
    }

    /// # Errors
    ///
    /// Rejects with the code of the `FfiError`.
    pub async fn unsubscribe(&self, sub: u32) -> Result<(), String> {
        self.ffi
            .unsubscribe(sub)
            .await
            .map_err(|error| error.code().to_owned())
    }

    /// # Errors
    ///
    /// Rejects with the code of the `FfiError`.
    pub async fn resync(&self, sub: u32) -> Result<String, String> {
        self.ffi
            .resync(sub)
            .await
            .map_err(|error| error.code().to_owned())
    }

    /// # Errors
    ///
    /// Rejects with the code of the `FfiError`.
    pub async fn range(&self, sub: u32, window: String) -> Result<String, String> {
        self.ffi
            .range(sub, &window)
            .await
            .map_err(|error| error.code().to_owned())
    }

    /// # Errors
    ///
    /// Rejects with the code of the `FfiError`.
    pub async fn dispatch(&self, target: String, action: String) -> Result<(), String> {
        self.ffi
            .dispatch(&target, &action)
            .await
            .map_err(|error| error.code().to_owned())
    }

    /// Resolves with the id that the answering `Reply` carries.
    ///
    /// # Errors
    ///
    /// Rejects with the code of the `FfiError`.
    pub async fn request(&self, target: String, action: String) -> Result<u64, String> {
        self.ffi
            .request(&target, &action)
            .await
            .map_err(|error| error.code().to_owned())
    }

    /// The next `Batch` as JSON, waiting for one.
    ///
    /// # Errors
    ///
    /// Rejects with the code of the `FfiError`.
    #[wasm_bindgen(js_name = nextBatch)]
    pub async fn next_batch(&self) -> Result<String, String> {
        self.ffi
            .next_batch()
            .await
            .map_err(|error| error.code().to_owned())
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
                vec!["counter"]
            } else {
                vec![]
            })
        );
    }

    #[wasm_bindgen_test]
    async fn an_unknown_slice_rejects_with_its_code() {
        let rejection = app()
            .subscribe(r#"{"slice":"nope","key":null}"#.to_owned())
            .await
            .expect_err("no such slice");

        assert_eq!(rejection, "unknown_slice");
    }
}
