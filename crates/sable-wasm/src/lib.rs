#![cfg(target_family = "wasm")]
#![recursion_limit = "512"]

mod session_store;

use std::sync::Arc;

use futures_util::StreamExt;
use js_sys::Function;
use sable_core::{Core, protocol::Command};
use session_store::JsSessionStore;
use tokio_stream_compat::UnboundedReceiverStream;
use wasm_bindgen::{JsValue, prelude::*};

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

/// The web carrier, mirroring `src-tauri/src/lib.rs`. JSON both ways, so the
/// frontend cannot tell the two apart.
#[wasm_bindgen]
pub struct SableCore {
    core: Arc<Core>,
    events: Option<UnboundedReceiverStream>,
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
        init_tracing(log_filter.as_deref().unwrap_or("info"));

        let (core, events) = Core::new(store_id, Box::new(JsSessionStore::new(load, save, clear)));

        SableCore {
            core,
            events: Some(UnboundedReceiverStream::new(events)),
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
            .map_err(|error| format!(r#"{{"code":"failed","log_id":"{error}"}}"#))?;

        match self.core.dispatch(command).await {
            Ok(response) => serde_json::to_string(&response)
                .map_err(|error| format!(r#"{{"code":"failed","log_id":"{error}"}}"#)),
            Err(error) => Err(
                serde_json::to_string(&error).unwrap_or_else(|serialization| {
                    format!(r#"{{"code":"failed","log_id":"{serialization}"}}"#)
                }),
            ),
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
            .map_err(|error| {
                serde_json::to_string(&error).unwrap_or_else(|serialization| {
                    format!(r#"{{"code":"failed","log_id":"{serialization}"}}"#)
                })
            })
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
            .map_err(|error| {
                serde_json::to_string(&error).unwrap_or_else(|serialization| {
                    format!(r#"{{"code":"failed","log_id":"{serialization}"}}"#)
                })
            })
    }

    /// # Errors
    ///
    /// Returns a JSON-encoded command error when the upload fails.
    #[wasm_bindgen(js_name = uploadMedia)]
    pub async fn upload_media(&self, mime: String, bytes: Vec<u8>) -> Result<String, String> {
        self.core.upload_media(mime, bytes).await.map_err(|error| {
            serde_json::to_string(&error).unwrap_or_else(|serialization| {
                format!(r#"{{"code":"failed","log_id":"{serialization}"}}"#)
            })
        })
    }

    /// Called once. Each event arrives as the JSON of `CoreEvent`.
    ///
    /// # Errors
    ///
    /// Returns an error when events have already been subscribed.
    #[wasm_bindgen(js_name = subscribeEvents)]
    pub fn subscribe_events(&mut self, on_event: Function) -> Result<(), JsValue> {
        let mut events = self
            .events
            .take()
            .ok_or_else(|| JsValue::from_str("events are already subscribed"))?;

        wasm_bindgen_futures::spawn_local(async move {
            while let Some(event) = events.next().await {
                let Ok(json) = serde_json::to_string(&event) else {
                    tracing::error!("failed to serialize a core event");
                    break;
                };
                if on_event
                    .call1(&JsValue::NULL, &JsValue::from_str(&json))
                    .is_err()
                {
                    break;
                }
            }
        });

        Ok(())
    }
}

mod tokio_stream_compat {
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };

    use futures_util::Stream;
    use sable_core::protocol::CoreEvent;
    use tokio::sync::mpsc::UnboundedReceiver;

    /// `tokio-stream` would pull in more than this needs.
    pub struct UnboundedReceiverStream(UnboundedReceiver<CoreEvent>);

    impl UnboundedReceiverStream {
        pub const fn new(receiver: UnboundedReceiver<CoreEvent>) -> Self {
            Self(receiver)
        }
    }

    impl Stream for UnboundedReceiverStream {
        type Item = CoreEvent;

        fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<CoreEvent>> {
            self.0.poll_recv(cx)
        }
    }
}
