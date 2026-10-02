use matrix_sdk::Client;
use matrix_sdk::ruma::TransactionId;
use serde_json::{Value, json};

#[cfg(not(target_family = "wasm"))]
use std::future::Future;
#[cfg(not(target_family = "wasm"))]
use std::time::Duration;

use crate::protocol::DiagnosticPushView;

pub const DIAGNOSTIC_EVENT_PREFIX: &str = "$sable-diagnostic-";
const DIAGNOSTIC_ROOM: &str = "!sable-diagnostic:sable.invalid";
const PING_APP_ID: &str = "moe.sable.diagnostic";
const PING_PUSHKEY: &str = "sable-diagnostic-ping";

#[cfg(not(target_family = "wasm"))]
const NOTIFY_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_millis(750)];

#[must_use]
pub fn notify_body(event_id: &str, app_id: &str, pushkey: &str, data: &Value) -> Value {
    json!({
        "notification": {
            "event_id": event_id,
            "room_id": DIAGNOSTIC_ROOM,
            "prio": "high",
            "devices": [{ "app_id": app_id, "pushkey": pushkey, "data": data }],
        }
    })
}

#[cfg(not(target_family = "wasm"))]
fn transient(error: &matrix_sdk::reqwest::Error) -> bool {
    error.is_connect() || error.is_dns() || error.is_timeout()
}

#[cfg(not(target_family = "wasm"))]
async fn retry_transient<T, F, Fut>(mut request: F, delays: &[Duration]) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, matrix_sdk::reqwest::Error>>,
{
    for delay in delays {
        match request().await {
            Ok(value) => return Ok(value),
            Err(error) if transient(&error) => {
                tracing::debug!(%error, "retrying push gateway request");
                matrix_sdk::sleep::sleep(*delay).await;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    request().await.map_err(|error| error.to_string())
}

#[cfg(not(target_family = "wasm"))]
async fn notify(url: &str, body: &Value) -> Result<Option<Vec<String>>, String> {
    #[derive(serde::Deserialize)]
    struct NotifyResponse {
        #[serde(default)]
        rejected: Vec<String>,
    }

    let http = crate::tls::apply(matrix_sdk::reqwest::Client::builder())
        .build()
        .map_err(|error| error.to_string())?;
    let body = body.to_string();
    let response = retry_transient(
        || async {
            http.post(url)
                .header(
                    matrix_sdk::reqwest::header::CONTENT_TYPE,
                    "application/json",
                )
                .body(body.clone())
                .send()
                .await
                .and_then(matrix_sdk::reqwest::Response::error_for_status)
        },
        &NOTIFY_RETRY_DELAYS,
    )
    .await?;
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    let answer: NotifyResponse =
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    Ok(Some(answer.rejected))
}

#[cfg(target_family = "wasm")]
async fn notify(url: &str, body: &Value) -> Result<Option<Vec<String>>, String> {
    let http = crate::tls::apply(matrix_sdk::reqwest::Client::builder())
        .build()
        .map_err(|error| error.to_string())?;
    http.post(url)
        .header(matrix_sdk::reqwest::header::CONTENT_TYPE, "text/plain")
        .body(body.to_string())
        .fetch_mode_no_cors()
        .send()
        .await
        .map_err(|error| error.to_string())?;
    Ok(None)
}

pub async fn ping_gateway(url: &str) -> Option<bool> {
    let Ok(url) = crate::notifications::gateway(url) else {
        return Some(false);
    };
    let body = notify_body(
        &format!("{DIAGNOSTIC_EVENT_PREFIX}ping"),
        PING_APP_ID,
        PING_PUSHKEY,
        &json!({}),
    );
    match notify(&url, &body).await {
        Ok(Some(_)) => Some(true),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(%error, %url, "push gateway probe failed");
            Some(false)
        }
    }
}

#[cfg(not(target_family = "wasm"))]
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);

#[cfg(not(target_family = "wasm"))]
fn advertises_matrix_gateway(body: &[u8]) -> bool {
    #[derive(serde::Deserialize)]
    struct Advertisement {
        unifiedpush: Option<UnifiedPush>,
    }
    #[derive(serde::Deserialize)]
    struct UnifiedPush {
        gateway: Option<String>,
    }

    serde_json::from_slice::<Advertisement>(body).is_ok_and(|answer| {
        answer.unifiedpush.and_then(|up| up.gateway).as_deref() == Some("matrix")
    })
}

#[cfg(not(target_family = "wasm"))]
pub async fn discover_gateway(endpoint: &str) -> Option<String> {
    let mut url = url::Url::parse(endpoint).ok()?;
    url.set_path(crate::notifications::GATEWAY_PATH);
    url.set_query(None);
    let gateway = crate::notifications::gateway(url.as_str()).ok()?;
    let http = crate::tls::apply(matrix_sdk::reqwest::Client::builder())
        .timeout(DISCOVERY_TIMEOUT)
        .build()
        .ok()?;
    let response = http
        .get(&gateway)
        .send()
        .await
        .and_then(matrix_sdk::reqwest::Response::error_for_status)
        .inspect_err(|error| tracing::debug!(%error, %gateway, "push gateway discovery failed"))
        .ok()?;
    let body = response.bytes().await.ok()?;
    advertises_matrix_gateway(&body).then_some(gateway)
}

#[cfg(target_family = "wasm")]
#[allow(clippy::unused_async)]
pub async fn discover_gateway(_endpoint: &str) -> Option<String> {
    None
}

/// # Errors
///
/// When the homeserver's pusher list cannot be read or the gateway refuses.
pub async fn send_diagnostic_push(
    client: &Client,
    pushkey: &str,
    app_id: &str,
) -> Result<DiagnosticPushView, String> {
    let pushers = crate::webpush::raw_pushers(client).await?;
    let Some(pusher) = pushers
        .into_iter()
        .find(|pusher| pusher.pushkey == pushkey && pusher.app_id == app_id)
    else {
        return Ok(DiagnosticPushView::NoPusher);
    };
    let Some(url) = pusher.gateway() else {
        return Ok(DiagnosticPushView::NoGateway);
    };
    let url = crate::notifications::gateway(&url)?;
    let event_id = format!("{DIAGNOSTIC_EVENT_PREFIX}{}", TransactionId::new());
    let body = notify_body(&event_id, app_id, pushkey, &Value::Object(pusher.data));
    Ok(delivery(notify(&url, &body).await?, pushkey, event_id))
}

#[must_use]
pub fn delivery(
    rejected: Option<Vec<String>>,
    pushkey: &str,
    event_id: String,
) -> DiagnosticPushView {
    match rejected {
        Some(rejected) if rejected.iter().any(|key| key == pushkey) => DiagnosticPushView::Rejected,
        Some(_) => DiagnosticPushView::Sent {
            event_id,
            accepted: Some(true),
        },
        None => DiagnosticPushView::Sent {
            event_id,
            accepted: None,
        },
    }
}

#[cfg(test)]
mod tests {
    #[cfg(not(target_family = "wasm"))]
    use std::sync::Arc;
    #[cfg(not(target_family = "wasm"))]
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[cfg(not(target_family = "wasm"))]
    use std::time::Duration;

    use serde_json::json;
    #[cfg(not(target_family = "wasm"))]
    use wiremock::matchers::any;
    #[cfg(not(target_family = "wasm"))]
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[cfg(not(target_family = "wasm"))]
    use super::retry_transient;
    use super::{DIAGNOSTIC_EVENT_PREFIX, delivery, notify_body};
    use crate::protocol::DiagnosticPushView;

    #[test]
    fn a_rejected_pushkey_is_reported_and_an_unreadable_answer_is_unknown() {
        assert!(matches!(
            delivery(Some(vec!["key".to_owned()]), "key", "$e".to_owned()),
            DiagnosticPushView::Rejected
        ));
        assert!(matches!(
            delivery(Some(vec!["other".to_owned()]), "key", "$e".to_owned()),
            DiagnosticPushView::Sent {
                accepted: Some(true),
                ..
            }
        ));
        assert!(matches!(
            delivery(None, "key", "$e".to_owned()),
            DiagnosticPushView::Sent { accepted: None, .. }
        ));
    }

    #[test]
    fn a_diagnostic_notify_carries_the_devices_own_pusher_data() {
        let body = notify_body(
            &format!("{DIAGNOSTIC_EVENT_PREFIX}abc"),
            "moe.sable.app",
            "key",
            &json!({"url": "https://push.example/_matrix/push/v1/notify", "format": "event_id_only"}),
        );

        assert_eq!(body["notification"]["event_id"], "$sable-diagnostic-abc");
        assert_eq!(body["notification"]["devices"][0]["pushkey"], "key");
        assert_eq!(
            body["notification"]["devices"][0]["app_id"],
            "moe.sable.app"
        );
        assert_eq!(
            body["notification"]["devices"][0]["data"]["format"],
            "event_id_only"
        );
        assert!(body["notification"].get("counts").is_none());
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn only_the_matrix_gateway_advertisement_is_accepted() {
        use super::advertises_matrix_gateway as advertised;
        assert!(advertised(br#"{"unifiedpush":{"gateway":"matrix"}}"#));
        assert!(!advertised(br#"{"unifiedpush":{"gateway":"other"}}"#));
        assert!(!advertised(br#"{"unifiedpush":{}}"#));
        assert!(!advertised(b"<html></html>"));
    }

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn a_gateway_request_retries_transient_connection_failures() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let client = matrix_sdk::reqwest::Client::new();
        let result = retry_transient(
            || {
                let attempt = attempts.fetch_add(1, Ordering::Relaxed);
                let client = client.clone();
                async move {
                    if attempt < 2 {
                        client.get("http://127.0.0.1:0").send().await.map(|_| ())
                    } else {
                        Ok(())
                    }
                }
            },
            &[Duration::ZERO, Duration::ZERO],
        )
        .await;

        assert_eq!(result, Ok(()));
        assert_eq!(attempts.load(Ordering::Relaxed), 3);
    }

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn a_gateway_request_does_not_retry_an_http_error() {
        let server = MockServer::start().await;
        Mock::given(any())
            .respond_with(ResponseTemplate::new(400))
            .mount(&server)
            .await;
        let attempts = AtomicUsize::new(0);
        let client = matrix_sdk::reqwest::Client::new();
        let result = retry_transient(
            || {
                attempts.fetch_add(1, Ordering::Relaxed);
                let request = client.get(server.uri()).send();
                async {
                    request
                        .await
                        .and_then(matrix_sdk::reqwest::Response::error_for_status)
                }
            },
            &[Duration::ZERO, Duration::ZERO],
        )
        .await;

        assert_ne!(result.err(), None);
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
    }
}
