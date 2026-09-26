use matrix_sdk::Client;
use matrix_sdk::ruma::TransactionId;
use serde_json::{Value, json};

use crate::protocol::DiagnosticPushView;

pub const DIAGNOSTIC_EVENT_PREFIX: &str = "$sable-diagnostic-";
const DIAGNOSTIC_ROOM: &str = "!sable-diagnostic:sable.invalid";
const PING_APP_ID: &str = "moe.sable.diagnostic";
const PING_PUSHKEY: &str = "sable-diagnostic-ping";

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
async fn notify(url: &str, body: &Value) -> Result<Option<Vec<String>>, String> {
    #[derive(serde::Deserialize)]
    struct NotifyResponse {
        #[serde(default)]
        rejected: Vec<String>,
    }

    let http = crate::tls::apply(matrix_sdk::reqwest::Client::builder())
        .build()
        .map_err(|error| error.to_string())?;
    let response = http
        .post(url)
        .header(
            matrix_sdk::reqwest::header::CONTENT_TYPE,
            "application/json",
        )
        .body(body.to_string())
        .send()
        .await
        .and_then(matrix_sdk::reqwest::Response::error_for_status)
        .map_err(|error| error.to_string())?;
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
        Err(_) => Some(false),
    }
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
    use serde_json::json;

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
}
