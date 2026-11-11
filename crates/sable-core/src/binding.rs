//! Glue shared by the JS bindings (`sable-wasm`, `sable-node`) and the Tauri app.

use crate::protocol::{CoreEvent, RpcError};

pub use tracing_error::ErrorLayer;

/// Most events a single crossing into JS carries.
pub const EVENT_BATCH_LIMIT: usize = 256;

pub const DEFAULT_LOG_FILTER: &str = "info,matrix_sdk::http_client=off,matrix_sdk::latest_events::latest_event::builder=off,matrix_sdk_base::room::display_name=off";

/// The one SDK warning worth an issue: it carries the decryption failures that
/// UTD reports are investigated from.
const REPORTED_SDK_WARNING: &str = "matrix_sdk_crypto::olm::account";

/// Prefixes a log line the policy reports, so a shell that only sees text can
/// tell it apart. Keep in step with `REPORTED_MARK` in `wasm-log.ts`.
pub const REPORTED_LOG_MARK: char = '\u{1e}';

fn is_own_target(target: &str) -> bool {
    let root = target.split("::").next().unwrap_or(target);
    root.starts_with("sable_") || root == "app" || root == "app_lib"
}

/// Whether an event becomes an issue. Everything else is a breadcrumb or a log:
/// an error from the SDK or a homeserver is not ours to act on.
#[must_use]
pub fn is_reported_event(metadata: &tracing::Metadata<'_>) -> bool {
    let level = *metadata.level();
    let target = metadata.target();
    let failure = metadata.fields().field("log_id").is_some();
    (level == tracing::Level::ERROR && is_own_target(target) && !failure)
        || (level <= tracing::Level::WARN && metadata.fields().field("reported").is_some())
        || (level == tracing::Level::WARN && target.starts_with(REPORTED_SDK_WARNING))
}

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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use tracing_subscriber::{Layer, layer::SubscriberExt};

    use super::{encode_event_batch, is_reported_event, rpc_error_json};
    use crate::protocol::{CoreEvent, RpcCode};

    struct Verdict(&'static AtomicBool);

    impl<S: tracing::Subscriber> Layer<S> for Verdict {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            self.0
                .store(is_reported_event(event.metadata()), Ordering::Relaxed);
        }
    }

    fn reported(emit: impl FnOnce()) -> bool {
        static VERDICT: AtomicBool = AtomicBool::new(false);
        VERDICT.store(false, Ordering::Relaxed);
        let subscriber = tracing_subscriber::registry().with(Verdict(&VERDICT));
        tracing::subscriber::with_default(subscriber, emit);
        VERDICT.load(Ordering::Relaxed)
    }

    #[test]
    fn an_sdk_error_is_not_an_issue() {
        assert!(!reported(
            || tracing::error!(target: "matrix_sdk::sliding_sync", "failed")
        ));
        assert!(!reported(
            || tracing::error!(target: "tauri_plugin_updater", "failed")
        ));
    }

    #[test]
    fn a_core_failure_is_left_to_its_event() {
        assert!(!reported(
            || tracing::error!(target: "sable_core::errors", log_id = "e1", "failed")
        ));
    }

    #[test]
    fn an_error_of_ours_is_an_issue() {
        assert!(reported(
            || tracing::error!(target: "sable_core::errors", "failed")
        ));
        assert!(reported(|| tracing::error!(target: "sable_wasm", "failed")));
        assert!(reported(
            || tracing::error!(target: "app_lib::sentry", "failed")
        ));
    }

    #[test]
    fn only_the_olm_account_warning_of_the_sdk_is_an_issue() {
        assert!(reported(
            || tracing::warn!(target: "matrix_sdk_crypto::olm::account", "failed")
        ));
        assert!(!reported(
            || tracing::warn!(target: "matrix_sdk_crypto::gossiping::machine", "request")
        ));
        assert!(!reported(
            || tracing::warn!(target: "matrix_sdk_crypto::session_manager::sessions", "keys")
        ));
        assert!(!reported(
            || tracing::warn!(target: "matrix_sdk_crypto::session_manager::group_sessions", "unsafe")
        ));
    }

    #[test]
    fn a_warning_marked_reported_is_an_issue() {
        assert!(reported(
            || tracing::warn!(target: "sable_core::utd", reported = true, "utd")
        ));
        assert!(!reported(
            || tracing::warn!(target: "sable_core::utd", "utd")
        ));
        assert!(!reported(
            || tracing::info!(target: "sable_core::utd", reported = true, "utd")
        ));
    }

    #[test]
    fn a_batch_encodes_as_one_json_array() {
        let json = encode_event_batch(&[
            CoreEvent::SessionTokensRefreshed,
            CoreEvent::SessionTokensRefreshed,
        ])
        .unwrap();

        let events: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        assert_eq!(events.len(), 2, "both events survive: {json}");
    }

    #[test]
    fn an_rpc_error_keeps_its_code() {
        let json: serde_json::Value =
            serde_json::from_str(&rpc_error_json(&RpcCode::Unavailable.into())).unwrap();

        assert_eq!(json["code"], "unavailable");
    }
}
