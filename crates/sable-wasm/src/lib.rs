#![cfg(target_family = "wasm")]
#![recursion_limit = "512"]

mod session_store;

use std::{
    cell::{Cell, RefCell},
    io::{self, Write},
    sync::Arc,
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

fn js_err(error: &CommandErr) -> String {
    serde_json::to_string(error)
        .unwrap_or_else(|_| r#"{"code":"failed","log_id":"serialization failed"}"#.to_owned())
}

const DEFAULT_LOG_FILTER: &str = "info,matrix_sdk::http_client=off,matrix_sdk::latest_events::latest_event::builder=off,matrix_sdk_base::room::display_name=off";

/// Without this the core's `tracing` output is discarded and a
/// `Failed { log_id }` names a line that was never written.
fn init_tracing(filter: &str) {
    use tracing_subscriber::{filter::Targets, prelude::*};

    let console_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .without_time()
        .with_writer(tracing_web::MakeWebConsoleWriter::new());
    let debug_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .without_time()
        .with_writer(MakeJsLogWriter);

    let targets = filter
        .parse::<Targets>()
        .unwrap_or_else(|_| Targets::new().with_default(tracing::Level::INFO));

    // A second call fails, so a reconnecting port must stay harmless.
    let _ = tracing_subscriber::registry()
        .with(console_layer)
        .with(debug_layer)
        .with(targets)
        .try_init();
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

    /// Error lines always reach the page: the `Failed` command error only
    /// carries a `log_id`, and the real cause lives in the log line that
    /// Sentry's `reportCoreError` feeds on.
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

#[wasm_bindgen(js_name = setLogCapture)]
pub fn set_log_capture(enabled: bool) {
    LOG_CAPTURE.set(enabled);
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
    /// `"info,matrix_sdk::http_client=debug"` is the only way to see the SDK's
    /// requests at all: a `SharedWorker`'s never reach the page's network panel.
    #[wasm_bindgen(constructor)]
    #[expect(
        clippy::needless_pass_by_value,
        reason = "wasm-bindgen maps the JS string boundary to an owned value"
    )]
    #[must_use]
    pub fn new(
        store_id: String,
        load: Function,
        save: Function,
        clear: Function,
        log_filter: Option<String>,
        persistent_event_cache: bool,
    ) -> SableCore {
        console_error_panic_hook::set_once();
        init_tracing(log_filter.as_deref().unwrap_or(DEFAULT_LOG_FILTER));

        let (core, events) = Core::new_with_event_cache(
            store_id,
            Box::new(JsSessionStore::new(load, save, clear)),
            persistent_event_cache,
        );

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
        let command: Command = serde_json::from_str(&command)
            .map_err(|error| js_err(&self.core.failed("submit_command", error)))?;

        match Box::pin(self.core.dispatch(command)).await {
            Ok(response) => serde_json::to_string(&response)
                .map_err(|error| js_err(&self.core.failed("submit_command", error))),
            Err(error) => Err(js_err(&error)),
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

    /// Resolves once the event is queued, not once the upload completes.
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
        let items = serde_json::from_str(&items).map_err(|_| js_err(&CommandErr::InvalidMedia))?;
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
            true,
        )
    }

    #[wasm_bindgen_test]
    async fn an_unparseable_command_rejects_with_a_protocol_error() {
        let rejection = core()
            .submit_command("not json".to_owned())
            .await
            .expect_err("an unparseable command must reject");

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
