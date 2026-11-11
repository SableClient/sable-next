use matrix_sdk::Client;
use matrix_sdk::ruma::api::client::push::{PusherIds, PusherInit, PusherKind};
use matrix_sdk::ruma::push::{HttpPusherData, PushFormat};
use url::Url;

use crate::api::push::PusherView;
use crate::errors::{CoreError, ReportExt};

pub(crate) const GATEWAY_PATH: &str = "/_matrix/push/v1/notify";

pub(crate) async fn pusher_display_name(client: &Client, fallback: String) -> String {
    let Some(device_id) = client.device_id() else {
        return fallback;
    };
    let Ok(devices) = client.devices().await else {
        return fallback;
    };
    devices
        .devices
        .iter()
        .find(|device| device.device_id == device_id)
        .and_then(|device| device.display_name.as_deref())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("Sable")
        .to_owned()
}

/// A device token must not be handed to anything but a Matrix push gateway.
/// # Errors
///
/// When the address is not a gateway's.
pub(crate) fn gateway(url: &str) -> Result<String, CoreError> {
    let parsed = Url::parse(url).map_err(|_| "the push gateway is not a URL")?;
    let plain = parsed.scheme() != "https";
    let addressed = !parsed.username().is_empty() || parsed.password().is_some();
    if plain || addressed || parsed.fragment().is_some() || parsed.path() != GATEWAY_PATH {
        return Err(format!("{url} is not an https {GATEWAY_PATH} endpoint").into());
    }

    Ok(parsed.to_string())
}

#[derive(serde::Serialize)]
struct AlertOut {
    #[serde(rename = "loc-key")]
    loc_key: &'static str,
}

#[derive(serde::Serialize)]
struct ApsOut {
    alert: AlertOut,
    #[serde(rename = "mutable-content")]
    mutable_content: u8,
}

#[derive(serde::Serialize)]
struct DefaultPayloadOut {
    user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    aps: Option<ApsOut>,
}

/// Sygnal's `event_id_only` payload has no alert, and iOS drops a push without one.
fn default_payload(user_id: String, ios: bool) -> DefaultPayloadOut {
    DefaultPayloadOut {
        user_id,
        aps: ios.then_some(ApsOut {
            alert: AlertOut {
                loc_key: "MSG_FROM_USER",
            },
            mutable_content: 1,
        }),
    }
}

#[derive(serde::Serialize)]
struct PusherDataOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_payload: Option<DefaultPayloadOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    p256dh: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth: Option<String>,
}

/// A cold platform notification is built from this payload, and it derives its
/// identity from `user_id`, so leaving it out stops a running app replacing it.
/// # Errors
///
/// When the gateway is not a push gateway, or the server rejects the registration.
pub async fn set_pusher(client: &Client, pusher: PusherView) -> Result<(), CoreError> {
    let mut pusher_data = HttpPusherData::new(gateway(&pusher.url)?);
    let device_display_name = pusher_display_name(client, pusher.device_display_name).await;
    if pusher.event_id_only {
        pusher_data.format = Some(PushFormat::EventIdOnly);
    }
    let user_id = client.user_id().map(ToString::to_string);
    let (endpoint, p256dh, auth) = pusher.web_push.map_or((None, None, None), |keys| {
        (Some(keys.endpoint), Some(keys.p256dh), Some(keys.auth))
    });
    pusher_data.data = serde_json::to_value(PusherDataOut {
        default_payload: user_id
            .clone()
            .map(|user_id| default_payload(user_id, cfg!(target_os = "ios"))),
        user_id,
        endpoint,
        p256dh,
        auth,
    })
    .and_then(serde_json::from_value)
    .map_err(|error| error.to_string())?;

    client
        .pusher()
        .set(
            PusherInit {
                ids: PusherIds::new(pusher.pushkey, pusher.app_id),
                kind: PusherKind::Http(pusher_data),
                app_display_name: "Sable".to_owned(),
                device_display_name,
                profile_tag: None,
                lang: "en".to_owned(),
            }
            .into(),
            pusher.append,
        )
        .await
        .backend()
}

/// # Errors
///
/// When the server rejects the removal.
pub async fn remove_pusher(
    client: &Client,
    pushkey: String,
    app_id: String,
) -> Result<(), CoreError> {
    client
        .pusher()
        .delete(PusherIds::new(pushkey, app_id))
        .await
        .backend()
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{owned_device_id, user_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;

    use super::{
        DefaultPayloadOut, PusherDataOut, default_payload, gateway, pusher_display_name, set_pusher,
    };
    use crate::api::push::{PusherView, WebPusherView};

    #[test]
    fn an_ios_default_payload_asks_for_the_notification_extension() {
        assert_eq!(
            serde_json::to_value(default_payload("@a:b".to_owned(), true)).unwrap(),
            json!({
                "user_id": "@a:b",
                "aps": { "alert": { "loc-key": "MSG_FROM_USER" }, "mutable-content": 1 }
            })
        );
        assert_eq!(
            serde_json::to_value(default_payload("@a:b".to_owned(), false)).unwrap(),
            json!({ "user_id": "@a:b" })
        );
    }

    #[test]
    fn pusher_data_omits_what_is_absent_and_nests_the_default_payload() {
        assert_eq!(
            serde_json::to_value(PusherDataOut {
                user_id: Some("@a:b".to_owned()),
                default_payload: Some(DefaultPayloadOut {
                    user_id: "@a:b".to_owned(),
                    aps: None,
                }),
                endpoint: Some("https://push.example/sub".to_owned()),
                p256dh: Some("key".to_owned()),
                auth: Some("secret".to_owned()),
            })
            .unwrap(),
            json!({
                "user_id": "@a:b",
                "default_payload": { "user_id": "@a:b" },
                "endpoint": "https://push.example/sub",
                "p256dh": "key",
                "auth": "secret",
            })
        );
        assert_eq!(
            serde_json::to_value(PusherDataOut {
                user_id: None,
                default_payload: None,
                endpoint: None,
                p256dh: None,
                auth: None,
            })
            .unwrap(),
            json!({})
        );
    }

    #[tokio::test]
    async fn pushers_use_the_current_device_name() {
        use matrix_sdk::test_utils::client::MockClientBuilder;
        use wiremock::matchers::{body_partial_json, method, path};
        use wiremock::{Mock, ResponseTemplate};

        let server = MatrixMockServer::new().await;
        let client = MockClientBuilder::new(Some(&server.uri()))
            .logged_in_with_token(
                "token".to_owned(),
                user_id!("@alice:example.org").to_owned(),
                owned_device_id!("PHONE"),
            )
            .build()
            .await;

        for (display_name, expected) in [
            (Some("  Personal phone  "), "Personal phone"),
            (Some("Work phone"), "Work phone"),
            (Some("  "), "Sable"),
            (None, "Sable"),
        ] {
            let devices = Mock::given(method("GET"))
                .and(path("/_matrix/client/v3/devices"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "devices": [
                        {"device_id": "OTHER", "display_name": "Other session"},
                        {"device_id": "PHONE", "display_name": display_name},
                    ]
                })))
                .expect(2)
                .mount_as_scoped(server.server())
                .await;
            let registration = Mock::given(method("POST"))
                .and(path("/_matrix/client/v3/pushers/set"))
                .and(body_partial_json(json!({
                    "app_display_name": "Sable",
                    "device_display_name": expected,
                })))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
                .expect(2)
                .mount_as_scoped(server.server())
                .await;

            set_pusher(
                &client,
                PusherView {
                    pushkey: "token".to_owned(),
                    app_id: "moe.sable.android".to_owned(),
                    url: "https://push.example/_matrix/push/v1/notify".to_owned(),
                    device_display_name: "Sable on Android".to_owned(),
                    web_push: None,
                    event_id_only: false,
                    append: false,
                },
            )
            .await
            .expect("register gateway pusher");
            crate::webpush::set_pusher(
                &client,
                WebPusherView {
                    pushkey: "key".to_owned(),
                    app_id: "moe.sable.webpush".to_owned(),
                    device_display_name: "Sable on Android".to_owned(),
                    endpoint: "https://push.example/sub".to_owned(),
                    auth: "auth".to_owned(),
                    event_id_only: true,
                },
            )
            .await
            .expect("register server pusher");
            drop(registration);
            drop(devices);
        }
    }

    #[tokio::test]
    async fn pusher_name_lookup_failure_uses_the_fallback() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("GET"))
            .and(path("/_matrix/client/v3/devices"))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                "errcode": "M_FORBIDDEN", "error": "Device list unavailable"
            })))
            .expect(1)
            .mount(server.server())
            .await;

        assert_eq!(
            pusher_display_name(&client, "Known phone".to_owned()).await,
            "Known phone"
        );
    }

    #[test]
    fn a_gateway_must_be_an_https_notify_endpoint() {
        assert_eq!(
            gateway("https://sygnal.example/_matrix/push/v1/notify").unwrap(),
            "https://sygnal.example/_matrix/push/v1/notify"
        );

        let accepted: Vec<&str> = [
            "http://sygnal.example/_matrix/push/v1/notify",
            "https://user:pass@sygnal.example/_matrix/push/v1/notify",
            "https://sygnal.example/_matrix/push/v1/notify#fragment",
            "https://sygnal.example/",
            "not a url",
        ]
        .into_iter()
        .filter(|address| gateway(address).is_ok())
        .collect();

        assert!(accepted.is_empty(), "these are not gateways: {accepted:?}");
    }
}
