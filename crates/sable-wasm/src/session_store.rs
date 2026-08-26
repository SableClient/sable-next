use async_trait::async_trait;
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

#[async_trait(?Send)]
impl SessionStore for JsSessionStore {
    async fn load(&self) -> Result<Option<Vec<u8>>, String> {
        let value = call(&self.load, &JsValue::UNDEFINED)
            .await
            .map_err(|error| format!("{error:?}"))?;
        if value.is_null() || value.is_undefined() {
            return Ok(None);
        }
        Ok(Some(Uint8Array::new(&value).to_vec()))
    }

    async fn save(&self, bytes: Vec<u8>) -> Result<(), String> {
        let payload = Uint8Array::from(bytes.as_slice());
        call(&self.save, &payload.into())
            .await
            .map(|_| ())
            .map_err(|error| format!("{error:?}"))
    }

    async fn clear(&self) -> Result<(), String> {
        call(&self.clear, &JsValue::UNDEFINED)
            .await
            .map(|_| ())
            .map_err(|error| format!("{error:?}"))
    }
}

#[cfg(test)]
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
            Function::new_no_args(
                "globalThis.__sableTestSession = null; return Promise.resolve();",
            ),
        )
    }

    #[wasm_bindgen_test]
    async fn a_saved_session_loads_back_unchanged() {
        let store = store();

        store.save(vec![1, 2, 3]).await.expect("save");
        assert_eq!(store.load().await, Ok(Some(vec![1, 2, 3])));

        store.clear().await.expect("clear");
        assert_eq!(store.load().await, Ok(None));
    }

    #[wasm_bindgen_test]
    async fn a_callback_that_forgets_its_promise_fails_rather_than_hangs() {
        let store = JsSessionStore::new(
            Function::new_no_args("return 42;"),
            Function::new_with_args("bytes", "return 42;"),
            Function::new_no_args("return 42;"),
        );

        store.load().await.unwrap_err();
        assert!(store.save(vec![1]).await.is_err());
        assert!(store.clear().await.is_err());
    }
}
