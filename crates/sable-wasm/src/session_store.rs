use std::{future::Future, pin::Pin};

use js_sys::{Function, Promise, Uint8Array};
use sable_core::store::SessionStore;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

/// A `SharedWorker` has no `localStorage`, so the JS side owns `IndexedDB` and hands
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
    // A non-Promise return must fail loudly, not hang on a missing `then`.
    let promise = returned.dyn_into::<Promise>()?;
    JsFuture::from(promise).await
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

    fn clear(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + '_>> {
        Box::pin(async move {
            call(&self.clear, &JsValue::UNDEFINED)
                .await
                .map(|_| ())
                .map_err(|error| format!("{error:?}"))
        })
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use js_sys::Function;
    use sable_core::store::SessionStore;
    use wasm_bindgen_test::wasm_bindgen_test;

    use super::JsSessionStore;

    fn store() -> JsSessionStore {
        JsSessionStore::new(
            Function::new_no_args("return Promise.resolve(globalThis.__sableTestSession ?? null);"),
            Function::new_with_args(
                "bytes",
                "globalThis.__sableTestSession = bytes; return Promise.resolve();",
            ),
            Function::new_no_args("globalThis.__sableTestSession = null; return Promise.resolve();"),
        )
    }

    #[wasm_bindgen_test]
    async fn a_saved_session_loads_back_unchanged() {
        let store = store();

        store.save(vec![1, 2, 3]).await.expect("save");
        assert_eq!(store.load().await, Some(vec![1, 2, 3]));

        store.clear().await.expect("clear");
        assert_eq!(store.load().await, None);
    }

    #[wasm_bindgen_test]
    async fn a_callback_that_forgets_its_promise_fails_rather_than_hangs() {
        let store = JsSessionStore::new(
            Function::new_no_args("return 42;"),
            Function::new_with_args("bytes", "return 42;"),
            Function::new_no_args("return 42;"),
        );

        assert!(store.load().await.is_none());
        assert!(store.save(vec![1]).await.is_err());
        assert!(store.clear().await.is_err());
    }
}
