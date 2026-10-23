#![cfg(target_family = "wasm")]
#![recursion_limit = "512"]

mod app;
mod session_store;

use std::{
    cell::{Cell, RefCell},
    io::{self, Write},
    sync::{Arc, OnceLock},
};

use js_sys::Function;
use sable_core::{
    Core,
    protocol::{CoreEvent, RpcError},
};
use sable_ffi::Ffi;
use session_store::JsSessionStore;
use tokio::sync::{RwLock, mpsc::UnboundedReceiver};
use wasm_bindgen::{JsValue, prelude::*};

/// Most events a single crossing into JS carries.
const EVENT_BATCH_LIMIT: usize = 256;

fn encode_batch(batch: &[CoreEvent]) -> Option<String> {
    match serde_json::to_string(batch) {
        Ok(json) => return Some(json),
        Err(error) => {
            tracing::error!(
                ?error,
                "a core event batch did not serialize; dropping what fails"
            );
        }
    }

    let kept: Vec<&CoreEvent> = batch
        .iter()
        .filter(|event| serde_json::to_string(event).is_ok())
        .collect();

    if kept.is_empty() {
        return None;
    }
    serde_json::to_string(&kept).ok()
}

pub(crate) fn js_err(error: &RpcError) -> String {
    serde_json::to_string(error)
        .unwrap_or_else(|_| r#"{"code":"failed","log_id":"serialization failed"}"#.to_owned())
}

const DEFAULT_LOG_FILTER: &str = "info,matrix_sdk::http_client=off,matrix_sdk::latest_events::latest_event::builder=off,matrix_sdk_base::room::display_name=off";

static LOG_FILTER: OnceLock<
    tracing_subscriber::reload::Handle<
        tracing_subscriber::filter::Targets,
        tracing_subscriber::Registry,
    >,
> = OnceLock::new();

fn log_targets(filter: &str) -> tracing_subscriber::filter::Targets {
    filter.parse().unwrap_or_else(|_| {
        tracing_subscriber::filter::Targets::new().with_default(tracing::Level::INFO)
    })
}

/// Without this the core's `tracing` output is discarded and a
/// `Failed { log_id }` names a line that was never written.
fn init_tracing() {
    use tracing_subscriber::prelude::*;

    let console_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .without_time()
        .with_writer(tracing_web::MakeWebConsoleWriter::new());
    let debug_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .without_time()
        .with_writer(MakeJsLogWriter);

    let (targets, handle) = tracing_subscriber::reload::Layer::new(log_targets(DEFAULT_LOG_FILTER));

    // A second call fails, so a reconnecting port must stay harmless.
    if tracing_subscriber::registry()
        .with(targets)
        .with(console_layer)
        .with(debug_layer)
        .try_init()
        .is_ok()
    {
        let _ = LOG_FILTER.set(handle);
    }
}

thread_local! {
    static PANIC_NOTIFIER: RefCell<Option<Function>> = const { RefCell::new(None) };
    static LOG_NOTIFIER: RefCell<Option<Function>> = const { RefCell::new(None) };
    static PANIC_HOOK_CHAINED: Cell<bool> = const { Cell::new(false) };
    static LOG_CAPTURE: Cell<bool> = const { Cell::new(false) };
    static LOG_NOTIFYING: Cell<bool> = const { Cell::new(false) };
}

struct JsLogWriter {
    capturing: bool,
    line: String,
}

impl Write for JsLogWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.capturing {
            self.line.push_str(&String::from_utf8_lossy(bytes));
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for JsLogWriter {
    fn drop(&mut self) {
        if !self.capturing || self.line.is_empty() || LOG_NOTIFYING.replace(true) {
            return;
        }
        let notify = LOG_NOTIFIER.with_borrow(Clone::clone);
        if let Some(notify) = notify {
            let _ = notify.call1(&JsValue::NULL, &JsValue::from_str(&self.line));
        }
        LOG_NOTIFYING.set(false);
    }
}

struct MakeJsLogWriter;

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for MakeJsLogWriter {
    type Writer = JsLogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        JsLogWriter {
            capturing: LOG_CAPTURE.get(),
            line: String::new(),
        }
    }

    /// Error lines always reach the page, since `Failed` carries only a `log_id`.
    fn make_writer_for(&'a self, meta: &tracing::Metadata<'_>) -> Self::Writer {
        JsLogWriter {
            capturing: LOG_CAPTURE.get() || meta.level() == &tracing::Level::ERROR,
            line: String::new(),
        }
    }
}

#[wasm_bindgen(js_name = setPanicHandler)]
pub fn set_panic_handler(notify: Function) {
    PANIC_NOTIFIER.with_borrow_mut(|slot| *slot = Some(notify));

    if PANIC_HOOK_CHAINED.replace(true) {
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

#[wasm_bindgen(js_name = setLogHandler)]
pub fn set_log_handler(notify: Function) {
    LOG_NOTIFIER.with_borrow_mut(|slot| *slot = Some(notify));
}

/// `"info,matrix_sdk::http_client=debug"` is the only way to see the SDK's
/// requests at all: a `SharedWorker`'s never reach the page's network panel.
#[wasm_bindgen(js_name = setLogFilter)]
pub fn set_log_filter(filter: &str) {
    if let Some(handle) = LOG_FILTER.get() {
        let _ = handle.reload(log_targets(filter));
    }
}

#[wasm_bindgen(js_name = setLogCapture)]
pub fn set_log_capture(enabled: bool) {
    LOG_CAPTURE.set(enabled);
}

/// The web carrier, mirroring `src-tauri/src/lib.rs`. JSON both ways, so the
/// frontend cannot tell the two apart.
#[wasm_bindgen]
pub struct SableCore {
    pub(crate) core: Arc<Core>,
    /// Held for writing while the account changes, so the runtime's calls wait for it.
    pub(crate) switching: Arc<RwLock<()>>,
    app: RefCell<Option<Ffi>>,
    account: RefCell<String>,
    events: RefCell<Option<UnboundedReceiver<CoreEvent>>>,
}

impl SableCore {
    /// Moves the runtime to the account `method` left active, before the call returns to its caller.
    async fn follow_account(&self, method: &str, json: &str) -> Result<(), String> {
        let Some(account) = sable_ffi::account_after(method, json) else {
            return Ok(());
        };
        if *self.account.borrow() == account {
            return Ok(());
        }
        let app = self.app.borrow().clone();
        if let Some(app) = app {
            app.switch_account(account.clone())
                .await
                .map_err(|_| js_err(&RpcError::Unavailable))?;
        }
        *self.account.borrow_mut() = account;
        Ok(())
    }
}

#[wasm_bindgen]
impl SableCore {
    /// `store_id` names the `IndexedDB` database, and the three functions are the
    /// session store, each of which must return a Promise.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(
        store_id: String,
        load: Function,
        save: Function,
        clear: Function,
        persistent_event_cache: bool,
    ) -> SableCore {
        console_error_panic_hook::set_once();
        init_tracing();

        let (core, events) = Core::new_with_event_cache(
            store_id,
            Box::new(JsSessionStore::new(load, save, clear)),
            persistent_event_cache,
        );

        SableCore {
            core,
            switching: Arc::new(RwLock::new(())),
            app: RefCell::new(None),
            account: RefCell::new(String::new()),
            events: RefCell::new(Some(events)),
        }
    }

    /// Runs `"<domain>.<method>"` on JSON params. Resolves with the JSON
    /// result, rejects with that of `RpcError`.
    ///
    /// # Errors
    ///
    /// Returns a JSON-encoded command error when parsing or the call fails.
    #[wasm_bindgen]
    pub async fn call(&self, method: String, params: String) -> Result<String, String> {
        let moving = if sable_ffi::changes_account(&method) {
            Some(self.switching.write().await)
        } else {
            None
        };
        let json = Box::pin(self.core.call(&method, &params))
            .await
            .map(|json| Box::<str>::from(json).into_string())
            .map_err(|error| js_err(&error))?;
        if moving.is_some() {
            self.follow_account(&method, &json).await?;
        }
        Ok(json)
    }

    /// Stops syncing and refuses further calls, before another worker takes the stores.
    #[wasm_bindgen]
    pub async fn shutdown(&self) {
        self.core.shutdown().await;
    }

    #[wasm_bindgen(js_name = setActive)]
    pub async fn set_active(&self, active: bool) {
        self.core.set_app_active(active);
        self.core.apply_app_activity(active).await;
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
        background: bool,
    ) -> Result<Vec<u8>, String> {
        self.core
            .fetch_media(source, width, height, background)
            .await
            .map_err(|error| js_err(&error))
    }

    /// Resolves once every stored copy of the source is gone.
    ///
    /// # Errors
    ///
    /// Returns a JSON-encoded command error when the media store cannot be written.
    #[wasm_bindgen(js_name = forgetMedia)]
    pub async fn forget_media(&self, source: String) -> Result<(), String> {
        self.core
            .forget_media(source)
            .await
            .map_err(|error| js_err(&error))
    }

    /// Resolves once the event is queued.
    ///
    /// # Errors
    ///
    /// Returns a JSON-encoded command error when queuing fails.
    #[wasm_bindgen(js_name = sendAttachment)]
    pub async fn send_attachment(&self, request: String, bytes: Vec<u8>) -> Result<(), String> {
        let request = serde_json::from_str(&request)
            .map_err(|error| js_err(&self.core.failed("send_attachment", error)))?;

        self.core
            .send_attachment(request, bytes)
            .await
            .map_err(|error| js_err(&error))
    }

    /// # Errors
    ///
    /// Returns a JSON-encoded command error when an attachment is invalid or sending fails.
    #[wasm_bindgen(js_name = sendGallery)]
    pub async fn send_gallery(&self, request: String, items: String) -> Result<(), String> {
        let request = serde_json::from_str(&request)
            .map_err(|error| js_err(&self.core.failed("send_gallery", error)))?;
        let items = serde_json::from_str(&items).map_err(|_| js_err(&RpcError::InvalidMedia))?;
        self.core
            .send_gallery(request, items)
            .await
            .map_err(|error| js_err(&error))
    }

    /// # Errors
    ///
    /// Returns a JSON-encoded command error when the upload fails.
    #[wasm_bindgen(js_name = uploadMedia)]
    pub async fn upload_media(&self, mime: String, bytes: Vec<u8>) -> Result<String, String> {
        self.core
            .upload_media(mime, bytes)
            .await
            .map_err(|error| js_err(&error))
    }

    /// Called once; each call carries a `CoreEvent[]` as JSON.
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
                let encoded = encode_batch(&batch);
                batch.clear();
                if let Some(json) = encoded
                    && let Err(error) = on_event.call1(&JsValue::NULL, &JsValue::from_str(&json))
                {
                    tracing::error!(?error, "the event callback threw; keeping the stream open");
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

    use super::SableCore;

    wasm_bindgen_test_configure!(run_in_shared_worker);

    /// `RpcError` is serialize-only, so the page's decoding is mirrored here
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
            true,
        )
    }

    #[wasm_bindgen_test]
    async fn unparseable_params_reject_with_a_protocol_error() {
        let rejection = core()
            .call("session.restore".to_owned(), "not json".to_owned())
            .await
            .expect_err("unparseable params must reject");

        let error = command_err(&rejection);

        assert_eq!(error["code"], "failed");
        assert!(
            error["log_id"]
                .as_str()
                .is_some_and(|id| id.starts_with('e'))
        );
    }

    #[wasm_bindgen_test]
    fn events_can_only_be_subscribed_once() {
        let core = core();
        let noop = Function::new_with_args("json", "");

        core.subscribe_events(noop.clone())
            .expect("first subscribe");

        assert!(core.subscribe_events(noop).is_err());
    }

    #[wasm_bindgen_test]
    fn unmatched_end_tags_cannot_nest_markup_past_the_stack() {
        let formatted = "<b></i>".repeat(20_000);

        let html = sable_core::matrix_html::display_html("body", Some(&formatted));

        assert!(html.contains("data-plain-body"), "{html}");
    }
}
