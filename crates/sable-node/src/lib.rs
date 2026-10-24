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
        Arc, Mutex, Once, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
};

use napi::{
    Env, Status,
    bindgen_prelude::{Buffer, PromiseRaw},
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use sable_core::{
    Core,
    protocol::{CoreEvent, RpcError},
    store::ExclusiveFileSessionStore,
};
use sable_ffi::AccountGate;
use tokio::sync::mpsc::UnboundedReceiver;

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

/// The events the page reads, as JSON.
fn encode_batch(batch: &[CoreEvent]) -> Option<String> {
    let page: Vec<&CoreEvent> = batch.iter().filter(|event| event.reaches_page()).collect();
    if page.is_empty() {
        return None;
    }
    match serde_json::to_string(&page) {
        Ok(json) => return Some(json),
        Err(error) => {
            tracing::error!(
                ?error,
                "a core event batch did not serialize; dropping what fails"
            );
        }
    }

    let kept: Vec<&CoreEvent> = page
        .into_iter()
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

async fn gate_call(
    gate: &AccountGate,
    core: &Arc<Core>,
    method: &str,
    params: &str,
) -> napi::Result<String> {
    gate.run(
        method,
        async {
            Box::pin(core.call(method, params))
                .await
                .map(|json| Box::<str>::from(json).into_string())
                .map_err(|error| js_err(&error))
        },
        || async {
            Box::pin(core.call("session.active_session", params))
                .await
                .map(|json| Box::<str>::from(json).into_string())
                .map_err(|error| js_err(&error))
        },
        String::as_str,
        || js_err(&RpcError::Unavailable),
    )
    .await
}

#[napi]
pub struct SableCore {
    core: Arc<Core>,
    events: Mutex<Option<UnboundedReceiver<CoreEvent>>>,
    gate: AccountGate,
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
            gate: AccountGate::default(),
        }
    }

    #[napi]
    pub fn restore<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
        // Keep JS-owned borrows on this thread: pending futures are dropped by Tokio at shutdown.
        let core = self.core.clone();
        let gate = self.gate.clone();
        env.spawn_future(async move {
            if !matches!(core.v1_migration_complete().await, Ok(true)) {
                return Ok(());
            }
            if let Err(error) = gate_call(&gate, &core, "session.restore", "{}").await {
                tracing::warn!(%error, "early session restore failed");
            }
            Ok(())
        })
    }

    #[napi]
    pub fn set_active<'env>(
        &self,
        env: &'env Env,
        active: bool,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let core = self.core.clone();
        env.spawn_future(async move {
            core.set_app_active(active);
            core.apply_app_activity(active).await;
            Ok(())
        })
    }

    #[napi]
    pub fn call<'env>(
        &self,
        env: &'env Env,
        method: String,
        params: String,
    ) -> napi::Result<PromiseRaw<'env, String>> {
        let core = self.core.clone();
        let gate = self.gate.clone();
        env.spawn_future(async move { gate_call(&gate, &core, &method, &params).await })
    }

    #[napi]
    pub fn fetch_media<'env>(
        &self,
        env: &'env Env,
        source: String,
        width: u32,
        height: u32,
        background: bool,
    ) -> napi::Result<PromiseRaw<'env, Buffer>> {
        let core = self.core.clone();
        env.spawn_future_with_callback(
            async move {
                core.fetch_media(source, width, height, background)
                    .await
                    .map_err(|error| js_err(&error))
            },
            |_env, bytes| Ok(Buffer::from(bytes)),
        )
    }

    #[napi]
    pub fn forget_media<'env>(
        &self,
        env: &'env Env,
        source: String,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let core = self.core.clone();
        env.spawn_future(async move {
            core.forget_media(source)
                .await
                .map_err(|error| js_err(&error))
        })
    }

    #[napi]
    pub fn send_attachment<'env>(
        &self,
        env: &'env Env,
        request: String,
        bytes: Buffer,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let core = self.core.clone();
        let bytes = Vec::from(bytes);
        env.spawn_future(async move {
            let request = serde_json::from_str(&request)
                .map_err(|error| js_err(&core.failed("send_attachment", error)))?;
            core.send_attachment(request, bytes)
                .await
                .map_err(|error| js_err(&error))
        })
    }

    #[napi]
    pub fn send_gallery<'env>(
        &self,
        env: &'env Env,
        request: String,
        bytes: Buffer,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let core = self.core.clone();
        let bytes = Vec::from(bytes);
        env.spawn_future(async move {
            let request = serde_json::from_str(&request)
                .map_err(|error| js_err(&core.failed("send_gallery", error)))?;
            core.send_gallery(request, bytes)
                .await
                .map_err(|error| js_err(&error))
        })
    }

    #[napi]
    pub fn upload_media<'env>(
        &self,
        env: &'env Env,
        mime: String,
        bytes: Buffer,
    ) -> napi::Result<PromiseRaw<'env, String>> {
        let core = self.core.clone();
        let bytes = Vec::from(bytes);
        env.spawn_future(async move {
            core.upload_media(mime, bytes)
                .await
                .map_err(|error| js_err(&error))
        })
    }

    #[napi]
    pub fn subscribe_events(&self, on_events: Callback) -> napi::Result<()> {
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
            .ok_or_else(|| napi::Error::new(Status::InvalidArg, "events are already subscribed"))?;

        let gate = self.gate.clone();
        napi::bindgen_prelude::spawn(async move {
            let mut batch = Vec::new();
            while events.recv_many(&mut batch, EVENT_BATCH_LIMIT).await > 0 {
                if let Some(json) = encode_batch(&batch) {
                    on_events.call(json, ThreadsafeFunctionCallMode::NonBlocking);
                }
                gate.offer(&batch).await;
                batch.clear();
            }
        });

        Ok(())
    }
}
