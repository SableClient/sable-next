#![cfg(target_family = "wasm")]
#![recursion_limit = "512"]

mod session_store;

use std::{
    cell::RefCell,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use js_sys::Function;
use sable_core::{
    Core,
    protocol::{Command, CommandErr, CoreEvent},
};
use session_store::JsSessionStore;
use tokio::sync::mpsc::UnboundedReceiver;
use wasm_bindgen::{JsValue, prelude::*};

/// Most events a single crossing into JS carries.
const EVENT_BATCH_LIMIT: usize = 256;

/// The rejection payload must stay valid `CommandErr` JSON, so never
/// interpolate a message into hand-written JSON.
fn err_json(error: impl std::fmt::Display) -> String {
    serde_json::to_string(&CommandErr::Failed {
        log_id: error.to_string(),
    })
    .unwrap_or_else(|_| r#"{"code":"failed","log_id":"serialization failed"}"#.to_owned())
}

const DEFAULT_LOG_FILTER: &str = "info,matrix_sdk::http_client=off,matrix_sdk::latest_events::latest_event::builder=off,matrix_sdk_base::room::display_name=off";

/// Without this the core's `tracing` output is discarded and a
/// `Failed { log_id }` names a line that was never written.
fn init_tracing(filter: &str) {
    use tracing_subscriber::{EnvFilter, prelude::*};

    let layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .without_time()
        .with_writer(tracing_web::MakeWebConsoleWriter::new());

    // A second call fails, so a reconnecting port must stay harmless.
    let _ = tracing_subscriber::registry()
        .with(layer)
        .with(EnvFilter::new(filter))
        .try_init();
}

thread_local! {
    static PANIC_NOTIFIER: RefCell<Option<Function>> = const { RefCell::new(None) };
}

static PANIC_HOOK_CHAINED: AtomicBool = AtomicBool::new(false);

#[wasm_bindgen(js_name = setPanicHandler)]
#[allow(clippy::needless_pass_by_value)] // wasm-bindgen maps the JS function boundary to an owned value
pub fn set_panic_handler(notify: Function) {
    PANIC_NOTIFIER.with_borrow_mut(|slot| *slot = Some(notify));

    if PANIC_HOOK_CHAINED.swap(true, Ordering::Relaxed) {
        return;
    }
    console_error_panic_hook::set_once();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        previous(info);
        let message = info.to_string();
        PANIC_NOTIFIER.with_borrow(|slot| {
            if let Some(notify) = slot.as_ref() {
                let _ = notify.call1(&JsValue::NULL, &JsValue::from_str(&message));
            }
        });
    }));
}

/// The web carrier, mirroring `src-tauri/src/lib.rs`. JSON both ways, so the
/// frontend cannot tell the two apart.
#[wasm_bindgen]
pub struct SableCore {
    core: Arc<Core>,
    events: RefCell<Option<UnboundedReceiver<CoreEvent>>>,
}

#[wasm_bindgen]
impl SableCore {
    /// `store_id` names the `IndexedDB` database, and the three functions are the
    /// session store, each of which must return a Promise.
    ///
    /// `log_filter` is an `EnvFilter` directive.
    /// `"info,matrix_sdk::http_client=debug"` is the only way to see the SDK's
    /// requests at all: a `SharedWorker`'s never reach the page's network panel.
    #[wasm_bindgen(constructor)]
    #[allow(clippy::needless_pass_by_value)] // wasm-bindgen maps the JS string boundary to an owned value
    #[must_use]
    pub fn new(
        store_id: String,
        load: Function,
        save: Function,
        clear: Function,
        log_filter: Option<String>,
    ) -> SableCore {
        console_error_panic_hook::set_once();
        init_tracing(log_filter.as_deref().unwrap_or(DEFAULT_LOG_FILTER));

        let (core, events) = Core::new(store_id, Box::new(JsSessionStore::new(load, save, clear)));

        SableCore {
            core,
            events: RefCell::new(Some(events)),
        }
    }

    /// Resolves with the JSON of `CommandOk`, rejects with that of `CommandErr`.
    ///
    /// # Errors
    ///
    /// Returns a JSON-encoded command error when parsing or dispatch fails.
    #[wasm_bindgen(js_name = submitCommand)]
    pub async fn submit_command(&self, command: String) -> Result<String, String> {
        let command: Command = serde_json::from_str(&command).map_err(err_json)?;

        match self.core.dispatch(command).await {
            Ok(response) => serde_json::to_string(&response).map_err(err_json),
            Err(error) => Err(serde_json::to_string(&error).unwrap_or_else(err_json)),
        }
    }

    /// Resolves with the raw thumbnail bytes.
    ///
    /// # Errors
    ///
    /// Returns a JSON-encoded command error when the media request fails.
    #[wasm_bindgen(js_name = fetchMedia)]
    pub async fn fetch_media(
        &self,
        source: String,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, String> {
        self.core
            .media_thumbnail(source, width, height)
            .await
            .map_err(|error| serde_json::to_string(&error).unwrap_or_else(err_json))
    }

    /// Resolves once the event is queued, not once the upload completes.
    ///
    /// # Errors
    ///
    /// Returns a JSON-encoded command error when queuing fails.
    #[wasm_bindgen(js_name = sendAttachment)]
    #[allow(clippy::too_many_arguments)]
    pub async fn send_attachment(
        &self,
        room_id: String,
        filename: String,
        mime: String,
        bytes: Vec<u8>,
        caption: Option<String>,
        in_reply_to: Option<String>,
    ) -> Result<(), String> {
        self.core
            .send_attachment(room_id, filename, mime, bytes, caption, in_reply_to)
            .await
            .map_err(|error| serde_json::to_string(&error).unwrap_or_else(err_json))
    }

    /// # Errors
    ///
    /// Returns a JSON-encoded command error when the upload fails.
    #[wasm_bindgen(js_name = uploadMedia)]
    pub async fn upload_media(&self, mime: String, bytes: Vec<u8>) -> Result<String, String> {
        self.core
            .upload_media(mime, bytes)
            .await
            .map_err(|error| serde_json::to_string(&error).unwrap_or_else(err_json))
    }

    /// Called once. Each call carries the JSON of a `CoreEvent[]`: whatever had
    /// queued up when the batch was drained.
    ///
    /// # Errors
    ///
    /// Returns an error when events have already been subscribed.
    #[wasm_bindgen(js_name = subscribeEvents)]
    pub fn subscribe_events(&self, on_event: Function) -> Result<(), JsValue> {
        let mut events = self
            .events
            .borrow_mut()
            .take()
            .ok_or_else(|| JsValue::from_str("events are already subscribed"))?;

        wasm_bindgen_futures::spawn_local(async move {
            let mut batch = Vec::new();
            while events.recv_many(&mut batch, EVENT_BATCH_LIMIT).await > 0 {
                let Ok(json) = serde_json::to_string(&batch) else {
                    tracing::error!("failed to serialize a core event");
                    break;
                };
                batch.clear();
                if let Err(error) = on_event.call1(&JsValue::NULL, &JsValue::from_str(&json)) {
                    tracing::error!(?error, "event callback threw, stopping the event stream");
                    break;
                }
            }
        });

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use js_sys::Function;
    use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

    use super::{SableCore, err_json};

    wasm_bindgen_test_configure!(run_in_browser);

    /// `CommandErr` is serialize-only, so the page's decoding is mirrored here
    /// rather than reused.
    fn command_err(json: &str) -> serde_json::Value {
        let error: serde_json::Value = serde_json::from_str(json).expect("JSON");
        assert!(error["code"].is_string(), "{json}");
        error
    }

    fn core() -> SableCore {
        SableCore::new(
            "sable-wasm-tests".to_owned(),
            Function::new_no_args("return Promise.resolve(null);"),
            Function::new_with_args("bytes", "return Promise.resolve();"),
            Function::new_no_args("return Promise.resolve();"),
            None,
        )
    }

    #[wasm_bindgen_test]
    fn a_failure_is_reported_as_command_err_json() {
        let error = command_err(&err_json("boom"));

        assert_eq!(error["code"], "failed");
        assert_eq!(error["log_id"], "boom");
    }

    #[wasm_bindgen_test]
    async fn an_unparseable_command_rejects_with_a_protocol_error() {
        let rejection = core()
            .submit_command("not json".to_owned())
            .await
            .expect_err("an unparseable command must reject");

        command_err(&rejection);
    }

    #[wasm_bindgen_test]
    fn events_can_only_be_subscribed_once() {
        let core = core();
        let noop = Function::new_with_args("json", "");

        core.subscribe_events(noop.clone())
            .expect("first subscribe");

        assert!(core.subscribe_events(noop).is_err());
    }
}
