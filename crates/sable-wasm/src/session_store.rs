use std::{future::Future, pin::Pin};

use js_sys::{Function, Promise, Uint8Array};
use sable_core::store::SessionStore;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;

/// A SharedWorker has no `localStorage`, so the JS side owns IndexedDB and hands
/// it over as three functions.
pub struct JsSessionStore {
    load: Function,
    save: Function,
    clear: Function,
}

impl JsSessionStore {
    pub fn new(load: Function, save: Function, clear: Function) -> Self {
        Self { load, save, clear }
    }
}

async fn call(function: &Function, argument: &JsValue) -> Result<JsValue, JsValue> {
    let returned = function.call1(&JsValue::NULL, argument)?;
    JsFuture::from(Promise::from(returned)).await
}

impl SessionStore for JsSessionStore {
    fn load(&self) -> Pin<Box<dyn Future<Output = Option<Vec<u8>>> + '_>> {
        Box::pin(async move {
            let value = call(&self.load, &JsValue::UNDEFINED).await.ok()?;
            if value.is_null() || value.is_undefined() {
                return None;
            }
            Some(Uint8Array::new(&value).to_vec())
        })
    }

    fn save(&self, bytes: Vec<u8>) -> Pin<Box<dyn Future<Output = Result<(), String>> + '_>> {
        Box::pin(async move {
            let payload = Uint8Array::from(bytes.as_slice());
            call(&self.save, &payload.into())
                .await
                .map(|_| ())
                .map_err(|error| format!("{error:?}"))
        })
    }

    fn clear(&self) -> Pin<Box<dyn Future<Output = ()> + '_>> {
        Box::pin(async move {
            let _ = call(&self.clear, &JsValue::UNDEFINED).await;
        })
    }
}
