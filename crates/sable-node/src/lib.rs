#![recursion_limit = "512"]
#![expect(
    clippy::missing_errors_doc,
    reason = "every export rejects with the JSON `RpcError` as its message"
)]

mod app;
#[cfg(windows)]
mod screen_audio;

use std::{
    io::{self, Write},
    sync::{
        Arc, Mutex, Once, OnceLock, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
};

use napi::{
    Status,
    bindgen_prelude::Buffer,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use sable_core::{
    Core,
    protocol::{CoreEvent, RpcError},
    store::ExclusiveFileSessionStore,
};
use sable_ffi::Ffi;
use tokio::sync::{RwLock, mpsc::UnboundedReceiver};

type Callback = ThreadsafeFunction<String, (), String, Status, false>;

const EVENT_BATCH_LIMIT: usize = 256;

const DEFAULT_LOG_FILTER: &str = "info,matrix_sdk::http_client=off,matrix_sdk::latest_events::latest_event::builder=off,matrix_sdk_base::room::display_name=off";

const PANIC_MARKER: &str = "SABLE_CORE_PANIC ";

static LOG_HANDLER: Mutex<Option<Callback>> = Mutex::new(None);
static LOG_CAPTURE: AtomicBool = AtomicBool::new(false);
static INIT: Once = Once::new();

fn js_err(error: &RpcError) -> napi::Error {
    let json = serde_json::to_string(error)
        .unwrap_or_else(|_| r#"{"code":"failed","log_id":"serialization failed"}"#.to_owned());
    napi::Error::new(Status::GenericFailure, json)
}

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
        if !self.capturing || self.line.is_empty() {
            return;
        }
        let handler = LOG_HANDLER.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(handler) = handler.as_ref() {
            handler.call(
                std::mem::take(&mut self.line),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
    }
}

struct MakeJsLogWriter;

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for MakeJsLogWriter {
    type Writer = JsLogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        JsLogWriter {
            capturing: LOG_CAPTURE.load(Ordering::Relaxed),
            line: String::new(),
        }
    }

    fn make_writer_for(&'a self, meta: &tracing::Metadata<'_>) -> Self::Writer {
        JsLogWriter {
            capturing: LOG_CAPTURE.load(Ordering::Relaxed)
                || meta.level() == &tracing::Level::ERROR,
            line: String::new(),
        }
    }
}

fn init(filter: &str) {
    use tracing_subscriber::{filter::Targets, prelude::*};

    INIT.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            previous(info);
            eprintln!("{PANIC_MARKER}{}", info.to_string().replace('\n', " "));
        }));

        let targets = filter
            .parse::<Targets>()
            .unwrap_or_else(|_| Targets::new().with_default(tracing::Level::INFO));
        let _ = tracing_subscriber::registry()
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(io::stderr),
            )
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .without_time()
                    .with_writer(MakeJsLogWriter),
            )
            .with(targets)
            .try_init();
    });
}

#[napi]
pub fn set_log_handler(notify: Callback) {
    *LOG_HANDLER.lock().unwrap_or_else(PoisonError::into_inner) = Some(notify);
}

#[napi]
pub fn set_log_capture(enabled: bool) {
    LOG_CAPTURE.store(enabled, Ordering::Relaxed);
}

#[napi]
pub struct SableCore {
    core: Arc<Core>,
    events: Mutex<Option<UnboundedReceiver<CoreEvent>>>,
    /// Held for writing while the account changes, so the runtime's calls wait for it.
    switching: Arc<RwLock<()>>,
    app: OnceLock<Ffi>,
    account: Mutex<String>,
}

impl SableCore {
    /// Moves the runtime to the account `method` left active, before the call returns to its caller.
    async fn follow_account(&self, method: &str, json: &str) -> napi::Result<()> {
        let Some(account) = sable_ffi::account_after(method, json) else {
            return Ok(());
        };
        if *self.account.lock().unwrap_or_else(PoisonError::into_inner) == account {
            return Ok(());
        }
        if let Some(app) = self.app.get() {
            app.switch_account(account.clone())
                .await
                .map_err(|_| js_err(&RpcError::Unavailable))?;
        }
        *self.account.lock().unwrap_or_else(PoisonError::into_inner) = account;
        Ok(())
    }
}

#[napi]
impl SableCore {
    #[napi(constructor)]
    #[must_use]
    pub fn new(data_dir: String, log_filter: Option<String>) -> Self {
        init(&log_filter.unwrap_or_else(|| DEFAULT_LOG_FILTER.to_owned()));

        let (core, events) = Core::new(
            data_dir.clone(),
            Box::new(ExclusiveFileSessionStore::new(data_dir)),
        );

        Self {
            core,
            events: Mutex::new(Some(events)),
            switching: Arc::new(RwLock::new(())),
            app: OnceLock::new(),
            account: Mutex::new(String::new()),
        }
    }

    #[napi]
    pub async fn restore(&self) {
        if !matches!(self.core.v1_migration_complete().await, Ok(true)) {
            return;
        }
        if let Err(error) = self
            .call("session.restore".to_owned(), "{}".to_owned())
            .await
        {
            tracing::warn!(%error, "early session restore failed");
        }
    }

    #[napi]
    pub async fn set_active(&self, active: bool) {
        self.core.set_app_active(active);
        self.core.apply_app_activity(active).await;
    }

    #[napi]
    pub async fn call(&self, method: String, params: String) -> napi::Result<String> {
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

    #[napi]
    pub async fn fetch_media(
        &self,
        source: String,
        width: u32,
        height: u32,
        background: bool,
    ) -> napi::Result<Buffer> {
        self.core
            .fetch_media(source, width, height, background)
            .await
            .map(Buffer::from)
            .map_err(|error| js_err(&error))
    }

    #[napi]
    pub async fn forget_media(&self, source: String) -> napi::Result<()> {
        self.core
            .forget_media(source)
            .await
            .map_err(|error| js_err(&error))
    }

    #[napi]
    pub async fn send_attachment(&self, request: String, bytes: Buffer) -> napi::Result<()> {
        let request = serde_json::from_str(&request)
            .map_err(|error| js_err(&self.core.failed("send_attachment", error)))?;
        self.core
            .send_attachment(request, bytes.to_vec())
            .await
            .map_err(|error| js_err(&error))
    }

    #[napi]
    pub async fn send_gallery(&self, request: String, items: String) -> napi::Result<()> {
        let request = serde_json::from_str(&request)
            .map_err(|error| js_err(&self.core.failed("send_gallery", error)))?;
        let items = serde_json::from_str(&items).map_err(|_| js_err(&RpcError::InvalidMedia))?;
        self.core
            .send_gallery(request, items)
            .await
            .map_err(|error| js_err(&error))
    }

    #[napi]
    pub async fn upload_media(&self, mime: String, bytes: Buffer) -> napi::Result<String> {
        self.core
            .upload_media(mime, bytes.to_vec())
            .await
            .map_err(|error| js_err(&error))
    }

    #[napi]
    pub fn subscribe_events(&self, on_events: Callback) -> napi::Result<()> {
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
            .ok_or_else(|| napi::Error::new(Status::InvalidArg, "events are already subscribed"))?;

        napi::bindgen_prelude::spawn(async move {
            let mut batch = Vec::new();
            while events.recv_many(&mut batch, EVENT_BATCH_LIMIT).await > 0 {
                let encoded = encode_batch(&batch);
                batch.clear();
                if let Some(json) = encoded {
                    on_events.call(json, ThreadsafeFunctionCallMode::NonBlocking);
                }
            }
        });

        Ok(())
    }
}
