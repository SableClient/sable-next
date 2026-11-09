#[cfg(not(target_family = "wasm"))]
use backon::Retryable;

use crate::errors::CoreError;
use matrix_sdk::Client;
use matrix_sdk::ruma::TransactionId;
use serde::Serialize;

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

#[derive(Serialize)]
pub struct NotifyBodyOut {
    notification: NotificationOut,
}

#[derive(Serialize)]
struct NotificationOut {
    event_id: String,
    room_id: &'static str,
    prio: PrioOut,
    devices: [DeviceOut; 1],
}

#[derive(Serialize)]
enum PrioOut {
    #[serde(rename = "high")]
    High,
}

#[derive(Serialize)]
struct DeviceOut {
    app_id: String,
    pushkey: String,
    data: serde_json::Map<String, serde_json::Value>,
}

#[must_use]
pub fn notify_body(
    event_id: &str,
    app_id: &str,
    pushkey: &str,
    data: serde_json::Map<String, serde_json::Value>,
) -> NotifyBodyOut {
    NotifyBodyOut {
        notification: NotificationOut {
            event_id: event_id.to_owned(),
            room_id: DIAGNOSTIC_ROOM,
            prio: PrioOut::High,
            devices: [DeviceOut {
                app_id: app_id.to_owned(),
                pushkey: pushkey.to_owned(),
                data,
            }],
        },
    }
}

#[cfg(not(target_family = "wasm"))]
fn transient(error: &matrix_sdk::reqwest::Error) -> bool {
    error.is_connect() || error.is_dns() || error.is_timeout()
}

#[cfg(not(target_family = "wasm"))]
async fn retry_transient<T, F, Fut>(request: F, delays: &[Duration]) -> Result<T, CoreError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, matrix_sdk::reqwest::Error>>,
{
    request
        .retry(delays.iter().copied())
        .when(transient)
        .notify(|error, _| tracing::debug!(%error, "retrying push gateway request"))
        .sleep(matrix_sdk::sleep::sleep)
        .await
        .map_err(CoreError::backend)
}

pub enum GatewayAnswer {
    Read(Vec<String>),
    Opaque,
    /// The gateway took the push but its push service refused or never answered.
    Unforwarded,
}

#[cfg(not(target_family = "wasm"))]
async fn notify_endpoint(url: &str, sealed: Vec<u8>) -> Result<bool, CoreError> {
    let http = crate::tls::apply(matrix_sdk::reqwest::Client::builder())
        .build()
        .map_err(CoreError::backend)?;
    let response = retry_transient(
        || async {
            http.post(url)
                .header(
                    matrix_sdk::reqwest::header::CONTENT_TYPE,
                    "application/octet-stream",
                )
                .header(matrix_sdk::reqwest::header::CONTENT_ENCODING, "aes128gcm")
                .header("TTL", "60")
                .body(sealed.clone())
                .send()
                .await
        },
        &NOTIFY_RETRY_DELAYS,
    )
    .await?;
    Ok(response.status().is_success())
}

/// Encrypts to the subscription keys (RFC 8291) as the homeserver does: distributors
/// drop plaintext once keys are published.
#[cfg(not(target_family = "wasm"))]
fn seal(p256dh: &str, auth: &str, plaintext: &[u8]) -> Result<Vec<u8>, CoreError> {
    let mut secret = [0u8; 32];
    let mut salt = [0u8; 16];
    getrandom::fill(&mut secret).map_err(CoreError::backend)?;
    getrandom::fill(&mut salt).map_err(CoreError::backend)?;
    seal_with(p256dh, auth, plaintext, &secret, salt)
}

#[cfg(not(target_family = "wasm"))]
fn seal_with(
    p256dh: &str,
    auth: &str,
    plaintext: &[u8],
    secret: &[u8; 32],
    salt: [u8; 16],
) -> Result<Vec<u8>, CoreError> {
    use aes_gcm::aead::{Aead, KeyInit};
    use base64::Engine as _;
    use hkdf::Hkdf;
    use sha2::Sha256;

    let base64url = base64::engine::GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );
    let decode = |value: &str| {
        base64url
            .decode(value)
            .map_err(|_| CoreError::from("the web push keys are not base64url"))
    };
    let receiver = p256::PublicKey::from_sec1_bytes(&decode(p256dh)?)
        .map_err(|_| "the web push key is not a P-256 point")?;
    let auth = decode(auth)?;
    let sender = p256::SecretKey::from_slice(secret).map_err(|_| "no usable web push key")?;
    let sender_public = sender.public_key().to_sec1_bytes();
    let receiver_public = receiver.to_sec1_bytes();
    let shared = p256::ecdh::diffie_hellman(sender.to_nonzero_scalar(), receiver.as_affine());

    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(&receiver_public);
    key_info.extend_from_slice(&sender_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&auth), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| "web push key derivation failed")?;
    let prk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .and_then(|()| prk.expand(b"Content-Encoding: nonce\0", &mut nonce))
        .map_err(|_| "web push key derivation failed")?;

    let mut record = plaintext.to_vec();
    record.push(2);
    let ciphertext = aes_gcm::Aes128Gcm::new(&cek.into())
        .encrypt(&nonce.into(), record.as_slice())
        .map_err(|_| "web push encryption failed")?;

    let record_size =
        u32::try_from(ciphertext.len().max(4096)).map_err(|_| "web push body is too large")?;
    let mut sealed = salt.to_vec();
    sealed.extend_from_slice(&record_size.to_be_bytes());
    sealed.push(65);
    sealed.extend_from_slice(&sender_public);
    sealed.extend_from_slice(&ciphertext);
    Ok(sealed)
}

#[cfg(not(target_family = "wasm"))]
async fn notify(url: &str, body: &impl Serialize) -> Result<GatewayAnswer, CoreError> {
    #[derive(serde::Deserialize)]
    struct NotifyResponse {
        #[serde(default)]
        rejected: Vec<String>,
    }

    let http = crate::tls::apply(matrix_sdk::reqwest::Client::builder())
        .build()
        .map_err(CoreError::backend)?;
    let body = serde_json::to_string(body).map_err(CoreError::backend)?;
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
        },
        &NOTIFY_RETRY_DELAYS,
    )
    .await?;
    if matches!(
        response.status(),
        http::StatusCode::BAD_GATEWAY | http::StatusCode::GATEWAY_TIMEOUT
    ) {
        return Ok(GatewayAnswer::Unforwarded);
    }
    let response = response.error_for_status().map_err(CoreError::backend)?;
    let bytes = response.bytes().await.map_err(CoreError::backend)?;
    let answer: NotifyResponse = serde_json::from_slice(&bytes).map_err(CoreError::backend)?;
    Ok(GatewayAnswer::Read(answer.rejected))
}

#[cfg(target_family = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen::prelude::wasm_bindgen(js_name = fetch)]
    fn js_fetch(request: &web_sys::Request) -> js_sys::Promise;
}

/// Not reqwest: it parses the response URL with `expect_throw`, and a no-cors
/// response is opaque with an empty one.
#[cfg(target_family = "wasm")]
async fn notify(url: &str, body: &impl Serialize) -> Result<GatewayAnswer, CoreError> {
    let js_error = |error: wasm_bindgen::JsValue| CoreError::from(format!("{error:?}"));
    let init = web_sys::RequestInit::new();
    init.set_method("POST");
    init.set_mode(web_sys::RequestMode::NoCors);
    init.set_body(&wasm_bindgen::JsValue::from_str(
        &serde_json::to_string(body).map_err(CoreError::backend)?,
    ));
    let request = web_sys::Request::new_with_str_and_init(url, &init).map_err(js_error)?;
    wasm_bindgen_futures::JsFuture::from(js_fetch(&request))
        .await
        .map_err(js_error)?;
    Ok(GatewayAnswer::Opaque)
}

pub async fn ping_gateway(url: &str) -> Option<bool> {
    let Ok(url) = crate::notifications::gateway(url) else {
        return Some(false);
    };
    let body = notify_body(
        &format!("{DIAGNOSTIC_EVENT_PREFIX}ping"),
        PING_APP_ID,
        PING_PUSHKEY,
        serde_json::Map::new(),
    );
    match notify(&url, &body).await {
        Ok(GatewayAnswer::Read(_) | GatewayAnswer::Unforwarded) => Some(true),
        Ok(GatewayAnswer::Opaque) => None,
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
#[expect(clippy::unused_async, reason = "mirrors the native signature")]
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
) -> Result<DiagnosticPushView, CoreError> {
    let pushers = crate::webpush::raw_pushers(client).await?;
    let Some(pusher) = pushers
        .into_iter()
        .find(|pusher| pusher.pushkey == pushkey && pusher.app_id == app_id)
    else {
        return Ok(DiagnosticPushView::NoPusher);
    };
    #[cfg(not(target_family = "wasm"))]
    if let Some(endpoint) = pusher.endpoint() {
        let endpoint =
            url::Url::parse(&endpoint).map_err(|_| "the web push endpoint is not a URL")?;
        if endpoint.scheme() != "https" {
            return Err("the web push endpoint must use https".into());
        }
        let auth = pusher
            .data
            .get("auth")
            .and_then(serde_json::Value::as_str)
            .ok_or("the web pusher has no auth secret")?
            .to_owned();
        let event_id = format!("{DIAGNOSTIC_EVENT_PREFIX}{}", TransactionId::new());
        let body = notify_body(&event_id, app_id, pushkey, pusher.data);
        let body = serde_json::to_vec(&body).map_err(CoreError::backend)?;
        return Ok(direct_delivery(
            notify_endpoint(endpoint.as_str(), seal(pushkey, &auth, &body)?).await?,
            event_id,
        ));
    }
    let Some(url) = pusher.gateway() else {
        return Ok(DiagnosticPushView::NoGateway);
    };
    let url = crate::notifications::gateway(&url)?;
    let event_id = format!("{DIAGNOSTIC_EVENT_PREFIX}{}", TransactionId::new());
    let body = notify_body(&event_id, app_id, pushkey, pusher.data);
    Ok(delivery(notify(&url, &body).await?, pushkey, event_id))
}

#[cfg(not(target_family = "wasm"))]
fn direct_delivery(accepted: bool, event_id: String) -> DiagnosticPushView {
    if accepted {
        DiagnosticPushView::Sent {
            event_id,
            accepted: Some(true),
        }
    } else {
        DiagnosticPushView::Refused
    }
}

#[must_use]
pub fn delivery(answer: GatewayAnswer, pushkey: &str, event_id: String) -> DiagnosticPushView {
    match answer {
        GatewayAnswer::Read(rejected) if rejected.iter().any(|key| key == pushkey) => {
            DiagnosticPushView::Rejected
        }
        GatewayAnswer::Read(_) => DiagnosticPushView::Sent {
            event_id,
            accepted: Some(true),
        },
        GatewayAnswer::Opaque => DiagnosticPushView::Sent {
            event_id,
            accepted: None,
        },
        GatewayAnswer::Unforwarded => DiagnosticPushView::Unforwarded,
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
    use super::{DIAGNOSTIC_EVENT_PREFIX, GatewayAnswer, delivery, notify_body};
    use crate::protocol::DiagnosticPushView;

    #[test]
    fn a_rejected_pushkey_is_reported_and_an_unreadable_answer_is_unknown() {
        assert!(matches!(
            delivery(
                GatewayAnswer::Read(vec!["key".to_owned()]),
                "key",
                "$e".to_owned()
            ),
            DiagnosticPushView::Rejected
        ));
        assert!(matches!(
            delivery(
                GatewayAnswer::Read(vec!["other".to_owned()]),
                "key",
                "$e".to_owned()
            ),
            DiagnosticPushView::Sent {
                accepted: Some(true),
                ..
            }
        ));
        assert!(matches!(
            delivery(GatewayAnswer::Opaque, "key", "$e".to_owned()),
            DiagnosticPushView::Sent { accepted: None, .. }
        ));
    }

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn a_gateway_that_cannot_reach_the_push_service_is_unforwarded() {
        for status in [502, 504] {
            let server = MockServer::start().await;
            Mock::given(any())
                .respond_with(ResponseTemplate::new(status))
                .mount(&server)
                .await;
            let answer = super::notify(&server.uri(), &serde_json::json!({}))
                .await
                .unwrap();
            assert!(matches!(answer, GatewayAnswer::Unforwarded));
        }
    }

    #[cfg(not(target_family = "wasm"))]
    #[test]
    fn diagnostics_are_sealed_like_the_rfc_8291_example() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let secret: [u8; 32] = b64
            .decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")
            .unwrap()
            .try_into()
            .unwrap();
        let salt: [u8; 16] = b64
            .decode("DGv6ra1nlYgDCS1FRnbzlw")
            .unwrap()
            .try_into()
            .unwrap();
        let sealed = super::seal_with(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
            "BTBZMqHH6r4Tts7J_aSIgg",
            b"When I grow up, I want to be a watermelon",
            &secret,
            salt,
        )
        .unwrap();
        assert_eq!(
            b64.encode(sealed),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn a_diagnostic_notify_carries_the_devices_own_pusher_data() {
        let body = notify_body(
            &format!("{DIAGNOSTIC_EVENT_PREFIX}abc"),
            "moe.sable.app",
            "key",
            json!({"url": "https://push.example/_matrix/push/v1/notify", "format": "event_id_only"})
                .as_object()
                .cloned()
                .unwrap(),
        );
        let body = serde_json::to_value(body).unwrap();

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
        let client = matrix_sdk::reqwest::Client::builder()
            .timeout(Duration::from_secs(1))
            .build()
            .unwrap();
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

        result.unwrap();
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

        result.unwrap_err();
        assert_eq!(attempts.load(Ordering::Relaxed), 1);
    }

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn a_direct_push_is_sent_sealed_with_its_diagnostic_event_id() {
        use wiremock::matchers::{body_bytes, header, method};

        let server = MockServer::start().await;
        let event_id = format!("{DIAGNOSTIC_EVENT_PREFIX}direct");
        let body = b"sealed".to_vec();
        Mock::given(method("POST"))
            .and(header("content-type", "application/octet-stream"))
            .and(header("content-encoding", "aes128gcm"))
            .and(header("ttl", "60"))
            .and(body_bytes(body.clone()))
            .respond_with(ResponseTemplate::new(201))
            .mount(&server)
            .await;

        let accepted = super::notify_endpoint(&server.uri(), body).await.unwrap();
        assert!(accepted);
        assert!(matches!(
            super::direct_delivery(accepted, event_id),
            DiagnosticPushView::Sent {
                accepted: Some(true),
                ..
            }
        ));
    }

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn a_direct_push_refused_by_the_service_is_not_sent() {
        let server = MockServer::start().await;
        Mock::given(any())
            .respond_with(ResponseTemplate::new(400))
            .mount(&server)
            .await;

        let event_id = "$sable-diagnostic-refused";
        let accepted = super::notify_endpoint(&server.uri(), Vec::new())
            .await
            .unwrap();
        assert!(!accepted);
        assert!(matches!(
            super::direct_delivery(accepted, event_id.to_owned()),
            DiagnosticPushView::Refused
        ));
    }
}
