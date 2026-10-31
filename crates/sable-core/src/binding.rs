//! Glue shared by the JS bindings (`sable-wasm`, `sable-node`) and the Tauri app.

use crate::protocol::{CoreEvent, RpcError};

/// Most events a single crossing into JS carries.
pub const EVENT_BATCH_LIMIT: usize = 256;

pub const DEFAULT_LOG_FILTER: &str = "info,matrix_sdk::http_client=off,matrix_sdk::latest_events::latest_event::builder=off,matrix_sdk_base::room::display_name=off";

/// Serializes a batch, dropping only the events that fail rather than the whole batch.
#[must_use]
pub fn encode_event_batch(batch: &[CoreEvent]) -> Option<String> {
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

#[must_use]
pub fn rpc_error_json(error: &RpcError) -> String {
    serde_json::to_string(error)
        .unwrap_or_else(|_| r#"{"code":"failed","log_id":"serialization failed"}"#.to_owned())
}
