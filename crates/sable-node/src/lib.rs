#![recursion_limit = "512"]
#![expect(
    clippy::missing_errors_doc,
    reason = "every export rejects with the JSON `RpcError` as its message"
)]

#[cfg(windows)]
mod screen_audio;

mod call_shortcuts;

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
    binding::{
        DEFAULT_LOG_FILTER, EVENT_BATCH_LIMIT, REPORTED_LOG_MARK, encode_event_batch,
        is_reported_event, rpc_error_json,
    },
    protocol::{CoreEvent, RpcError},
    store::ExclusiveFileSessionStore,
};
use tokio::sync::mpsc::UnboundedReceiver;

type Callback = ThreadsafeFunction<String, (), String, Status, false>;

const PANIC_MARKER: &str = "SABLE_CORE_PANIC ";

static LOG_HANDLER: Mutex<Option<Callback>> = Mutex::new(None);
static LOG_CAPTURE: AtomicBool = AtomicBool::new(false);
static INIT: Once = Once::new();

fn js_err(error: &RpcError) -> napi::Error {
    napi::Error::new(Status::GenericFailure, rpc_error_json(error))
}

struct JsLogWriter {
    capturing: bool,
    reported: bool,
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
            let mut line = std::mem::take(&mut self.line);
            if self.reported {
                line.insert(0, REPORTED_LOG_MARK);
            }
            handler.call(line, ThreadsafeFunctionCallMode::NonBlocking);
        }
    }
}

struct MakeJsLogWriter;

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for MakeJsLogWriter {
    type Writer = JsLogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        JsLogWriter {
            capturing: LOG_CAPTURE.load(Ordering::Relaxed),
            reported: false,
            line: String::new(),
        }
    }

    fn make_writer_for(&'a self, meta: &tracing::Metadata<'_>) -> Self::Writer {
        let reported = is_reported_event(meta);
        JsLogWriter {
            capturing: LOG_CAPTURE.load(Ordering::Relaxed)
                || meta.level() == &tracing::Level::ERROR
                || reported,
            reported,
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

/// Must succeed before a `SableCore` is made.
///
/// # Errors
/// When the keyring `data_dir` keeps its keys in is unavailable.
#[napi]
pub fn install_keyring(
    service: String,
    data_dir: String,
    log_filter: Option<String>,
) -> napi::Result<()> {
    init(&log_filter.unwrap_or_else(|| DEFAULT_LOG_FILTER.to_owned()));
    sable_core::secrets::install_os_keyring_or_files(service, &std::path::PathBuf::from(data_dir))
        .map_err(|error| napi::Error::new(Status::GenericFailure, error.to_string()))
}

/// Must run before a `SableCore` is made.
///
/// # Errors
/// When `url` is not a usable proxy or a proxy was already set.
#[napi]
pub fn set_proxy(url: String) -> napi::Result<()> {
    sable_core::tls::set_proxy(url)
        .map_err(|error| napi::Error::new(Status::GenericFailure, error.to_string()))
}

#[napi]
pub struct SableCore {
    core: Arc<Core>,
    events: Mutex<Option<UnboundedReceiver<CoreEvent>>>,
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
        }
    }

    #[napi]
    pub fn restore<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
        // Keep JS-owned borrows on this thread: pending futures are dropped by Tokio at shutdown.
        let core = self.core.clone();
        env.spawn_future(async move {
            if let Err(error) = Box::pin(core.run(sable_core::api::session::RestoreParams {})).await
            {
                tracing::warn!(?error, "early session restore failed");
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
            core.update_app_active(active).await;
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
        env.spawn_future(async move {
            Box::pin(core.call(&method, &params))
                .await
                .map(|json| Box::<str>::from(json).into_string())
                .map_err(|error| js_err(&error))
        })
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
    pub fn rtc_data<'env>(
        &self,
        env: &'env Env,
        session_id: String,
        frame: Buffer,
    ) -> napi::Result<PromiseRaw<'env, Buffer>> {
        let core = self.core.clone();
        let frame = Vec::from(frame);
        env.spawn_future_with_callback(
            async move {
                core.rtc_data(&session_id, &frame)
                    .await
                    .map_err(|error| js_err(&error))
            },
            |_env, bytes| Ok(Buffer::from(bytes)),
        )
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
                let encoded = encode_event_batch(&batch);
                batch.clear();
                if let Some(json) = encoded {
                    on_events.call(json, ThreadsafeFunctionCallMode::NonBlocking);
                }
            }
        });

        Ok(())
    }
}
