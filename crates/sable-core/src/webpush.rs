//! MSC4174 web push. The homeserver encrypts and delivers, and custom pusher data stays raw.

use crate::api::push::WebPusherView;
use crate::errors::{CoreError, ReportExt};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use matrix_sdk::SupportedPathBuilder;
use matrix_sdk::{Client, HttpResult};
use ruma::api::{
    Metadata, auth_scheme, client::discovery::get_capabilities, error::IntoHttpError,
    path_builder::PathBuilder,
};
use ruma::push::PushFormat;

use crate::protocol::RegisteredPusherView;

/// The capability name once upstreamed, and the unstable one meanwhile.
const CAPABILITIES: [&str; 2] = ["m.webpush", "org.matrix.msc4174.webpush"];

/// The kind the pusher goes on the wire as.
const PUSHER_KIND: &str = "org.matrix.msc4174.webpush";

#[derive(Deserialize)]
struct WebpushCapability {
    enabled: bool,
    #[serde(default)]
    vapid: Option<String>,
}

/// A key is only usable when the capability is enabled and actually sets one.
fn vapid(capability: &JsonValue) -> Option<String> {
    let capability = serde_json::from_value::<WebpushCapability>(capability.clone()).ok()?;
    let vapid = capability.vapid?;
    (capability.enabled && !vapid.trim().is_empty()).then_some(vapid)
}

/// `None` unless the homeserver serves a web push capability with a VAPID key.
///
/// # Errors
///
/// When the homeserver query fails.
pub async fn support(client: &Client) -> Result<Option<String>, CoreError> {
    let capabilities = client
        .send(get_capabilities::v3::Request::new())
        .await
        .backend()?;

    Ok(CAPABILITIES.iter().find_map(|name| {
        capabilities
            .capabilities
            .get(name)
            .and_then(|capability| vapid(&capability))
    }))
}

/// # Errors
///
/// When the homeserver rejects the registration.
pub async fn set_pusher(client: &Client, mut pusher: WebPusherView) -> Result<(), CoreError> {
    pusher.device_display_name =
        crate::notifications::pusher_display_name(client, pusher.device_display_name).await;
    let body = pusher_body(pusher, client.user_id().map(ToString::to_string)).backend()?;

    client
        .send(SetWebPusher { body })
        .await
        .map(|response| drop(response.body))
        .backend()
}

/// MSC4174's pusher body: `url` is the subscription, not a gateway, and the
/// server merges `default_payload` into every notification it encrypts.
fn pusher_body(
    pusher: WebPusherView,
    user_id: Option<String>,
) -> Result<JsonValue, serde_json::Error> {
    #[derive(Serialize)]
    struct DefaultPayloadOut {
        user_id: String,
    }

    #[derive(Serialize)]
    enum AppDisplayNameOut {
        Sable,
    }

    #[derive(Serialize)]
    enum LangOut {
        #[serde(rename = "en")]
        English,
    }

    #[derive(Serialize)]
    struct DataOut {
        url: String,
        auth: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<PushFormat>,
        #[serde(skip_serializing_if = "Option::is_none")]
        default_payload: Option<DefaultPayloadOut>,
    }

    #[derive(Serialize)]
    #[serde(tag = "kind")]
    enum BodyOut {
        #[serde(rename = "org.matrix.msc4174.webpush")]
        WebPush {
            pushkey: String,
            app_id: String,
            app_display_name: AppDisplayNameOut,
            device_display_name: String,
            lang: LangOut,
            data: DataOut,
            append: bool,
        },
    }

    serde_json::to_value(BodyOut::WebPush {
        pushkey: pusher.pushkey,
        app_id: pusher.app_id,
        app_display_name: AppDisplayNameOut::Sable,
        device_display_name: pusher.device_display_name,
        lang: LangOut::English,
        data: DataOut {
            url: pusher.endpoint,
            auth: pusher.auth,
            format: pusher.event_id_only.then_some(PushFormat::EventIdOnly),
            default_payload: user_id.map(|user_id| DefaultPayloadOut { user_id }),
        },
        append: true,
    })
}

use set_web_pusher::Request as SetWebPusher;

mod set_web_pusher {
    use ruma::{
        api::{auth_scheme::AccessToken, request},
        metadata,
    };

    type Response = super::empty_response::Response;

    metadata! {
        method: POST,
        rate_limited: true,
        authentication: AccessToken,
        history: {
            1.0 => "/_matrix/client/r0/pushers/set",
            1.1 => "/_matrix/client/v3/pushers/set",
        }
    }

    #[request]
    pub(super) struct Request {
        #[ruma_api(body)]
        pub body: serde_json::Value,
    }
}

mod empty_response {
    use ruma::api::response;

    /// Accepts successful responses without requiring a JSON body.
    #[response]
    pub(super) struct Response {
        #[ruma_api(raw_body)]
        pub body: Vec<u8>,
    }
}

/// # Errors
///
/// When the homeserver rejects the read.
pub async fn pushers(client: &Client) -> Result<Vec<RegisteredPusherView>, CoreError> {
    Ok(raw_pushers(client)
        .await?
        .into_iter()
        .map(Into::into)
        .collect())
}

pub(crate) async fn raw_pushers(client: &Client) -> Result<Vec<RawPusher>, CoreError> {
    let response = client.send(ListWebPushers {}).await.backend()?;

    Ok(response.pushers)
}

use list_web_pushers::Request as ListWebPushers;

mod list_web_pushers {
    use ruma::{
        api::{auth_scheme::AccessToken, request, response},
        metadata,
    };

    metadata! {
        method: GET,
        rate_limited: false,
        authentication: AccessToken,
        history: {
            1.0 => "/_matrix/client/r0/pushers",
            1.1 => "/_matrix/client/v3/pushers",
        }
    }

    #[request]
    pub(super) struct Request {}

    #[response]
    pub(super) struct Response {
        pub pushers: Vec<super::RawPusher>,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct RawPusher {
    pub(crate) pushkey: String,
    pub(crate) app_id: String,
    /// `http`, the web push kind, or a server-defined kind.
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    device_display_name: Option<String>,
    /// Set by servers implementing the MSC4174 validation handshake.
    #[serde(default)]
    activated: Option<bool>,
    #[serde(default)]
    pub(crate) data: serde_json::Map<String, serde_json::Value>,
}

impl RawPusher {
    pub(crate) fn endpoint(&self) -> Option<String> {
        if self.kind.as_deref() != Some(PUSHER_KIND) {
            return None;
        }
        self.data
            .get("url")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned)
    }

    pub(crate) fn gateway(&self) -> Option<String> {
        if self.kind.as_deref() == Some(PUSHER_KIND) {
            return None;
        }
        self.data
            .get("url")
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned)
    }
}

impl From<RawPusher> for RegisteredPusherView {
    fn from(pusher: RawPusher) -> Self {
        Self {
            gateway: pusher.gateway(),
            endpoint: pusher.endpoint(),
            pushkey: pusher.pushkey,
            app_id: pusher.app_id,
            kind: pusher.kind,
            device_display_name: pusher.device_display_name,
            activated: pusher.activated,
        }
    }
}

/// # Errors
///
/// When the homeserver rejects the acknowledgement.
pub async fn ack(client: &Client, app_id: String, ack_token: String) -> Result<(), CoreError> {
    client
        .send(AckWebPusher { app_id, ack_token })
        .await
        .map(|response| drop(response.body))
        .backend()
}

use acknowledge_web_pusher::Request as AckWebPusher;

mod acknowledge_web_pusher {
    use ruma::api::request;

    type Response = super::empty_response::Response;

    #[request]
    pub(super) struct Request {
        pub app_id: String,
        pub ack_token: String,
    }
}

impl Metadata for AckWebPusher {
    const METHOD: http::Method = http::Method::POST;
    const RATE_LIMITED: bool = false;
    type Authentication = auth_scheme::AccessToken;
    type PathBuilder = UnstablePath;
    const PATH_BUILDER: UnstablePath =
        UnstablePath("/_matrix/client/unstable/org.matrix.msc4174/pushers/ack");
}

/// Unstable endpoints do not negotiate versions.
#[derive(Clone, Copy, Debug)]
struct UnstablePath(&'static str);

impl PathBuilder for UnstablePath {
    type Input<'a> = ();

    fn select_path(&self, (): ()) -> Result<&'static str, IntoHttpError> {
        Ok(self.0)
    }

    fn all_paths(&self) -> impl Iterator<Item = &'static str> {
        [self.0].into_iter()
    }

    fn _path_parameters(&self) -> Vec<&'static str> {
        Vec::new()
    }
}

impl SupportedPathBuilder for UnstablePath {
    fn get_path_builder_input(
        _client: &Client,
        _skip_auth: bool,
    ) -> impl Future<Output = HttpResult<()>> {
        std::future::ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::collections::BTreeSet;

    use http::header::CONTENT_TYPE;
    use matrix_sdk::ruma::api::SupportedVersions;
    use matrix_sdk::ruma::api::auth_scheme::SendAccessToken;
    use matrix_sdk::ruma::api::{MatrixVersion, OutgoingRequestExt};
    use serde_json::json;

    use super::*;

    fn pusher() -> WebPusherView {
        WebPusherView {
            pushkey: "B5Dw".to_owned(),
            app_id: "moe.sable.webpush".to_owned(),
            device_display_name: "This browser".to_owned(),
            endpoint: "https://push.example/sub/1".to_owned(),
            auth: "KqYm".to_owned(),
            event_id_only: true,
        }
    }

    fn versions(values: &[MatrixVersion]) -> Cow<'_, SupportedVersions> {
        Cow::Owned(SupportedVersions {
            versions: values.iter().copied().collect(),
            features: BTreeSet::new(),
        })
    }

    #[test]
    fn successful_write_responses_do_not_require_json() {
        for body in [b"".as_slice(), b"{}", b"not JSON"] {
            let response = http::Response::builder().body(body).expect("a response");
            let parsed = <empty_response::Response as ruma::api::IncomingResponse>::try_from_http_response_inner(response)
                .expect("the write response body is ignored");
            assert_eq!(parsed.body, body);
        }
    }

    #[test]
    fn the_webpush_pusher_body_matches_msc4174() {
        assert_eq!(
            pusher_body(pusher(), Some("@alice:example.org".to_owned())).unwrap(),
            serde_json::json!({
                "pushkey": "B5Dw",
                "app_id": "moe.sable.webpush",
                "kind": "org.matrix.msc4174.webpush",
                "app_display_name": "Sable",
                "device_display_name": "This browser",
                "lang": "en",
                "data": {
                    "url": "https://push.example/sub/1",
                    "auth": "KqYm",
                    "format": "event_id_only",
                    "default_payload": { "user_id": "@alice:example.org" },
                },
                "append": true,
            })
        );
    }

    #[test]
    fn rich_payloads_leave_the_format_to_the_server() {
        let rich = WebPusherView {
            event_id_only: false,
            ..pusher()
        };
        let body = pusher_body(rich, Some("@alice:example.org".to_owned())).unwrap();

        assert!(body["data"].get("format").is_none());
        assert_eq!(
            body["data"]["default_payload"]["user_id"],
            "@alice:example.org"
        );
    }

    #[test]
    fn an_msc4174_subscription_url_is_not_a_push_gateway() {
        let pusher: RawPusher = serde_json::from_value(json!({
            "pushkey": "B5Dw",
            "app_id": "moe.sable.webpush",
            "kind": "org.matrix.msc4174.webpush",
            "data": { "url": "https://ntfy.example/sub/1" },
        }))
        .expect("valid pusher");

        assert_eq!(pusher.gateway(), None);
        let view = RegisteredPusherView::from(pusher);
        assert_eq!(view.gateway, None);
        assert_eq!(view.endpoint.as_deref(), Some("https://ntfy.example/sub/1"));
    }

    #[test]
    fn an_http_pusher_url_remains_a_push_gateway() {
        let pusher: RawPusher = serde_json::from_value(json!({
            "pushkey": "key",
            "app_id": "moe.sable.up",
            "kind": "http",
            "data": { "url": "https://ntfy.example/_matrix/push/v1/notify" },
        }))
        .expect("valid pusher");

        assert_eq!(
            pusher.gateway().as_deref(),
            Some("https://ntfy.example/_matrix/push/v1/notify")
        );
        assert_eq!(RegisteredPusherView::from(pusher).endpoint, None);
    }

    #[test]
    fn the_pusher_is_registered_on_the_versioned_path() {
        let http_request: http::Request<Vec<u8>> = SetWebPusher {
            body: pusher_body(pusher(), Some("@alice:example.org".to_owned())).unwrap(),
        }
        .try_into_http_request(
            "https://homeserver.example",
            SendAccessToken::IfRequired("token"),
            versions(&[MatrixVersion::V1_11]),
        )
        .expect("the request is expressible");

        assert_eq!(http_request.method(), &http::Method::POST);
        assert_eq!(http_request.uri().path(), "/_matrix/client/v3/pushers/set");
        assert_eq!(
            http_request.headers().get("Authorization").unwrap(),
            "Bearer token"
        );
        assert_eq!(
            http_request.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
        assert_eq!(
            serde_json::from_slice::<JsonValue>(http_request.body().as_slice()).unwrap(),
            pusher_body(pusher(), Some("@alice:example.org".to_owned())).unwrap()
        );
    }

    #[test]
    fn old_homeservers_still_get_the_r0_path() {
        let http_request: http::Request<Vec<u8>> = SetWebPusher {
            body: pusher_body(pusher(), Some("@alice:example.org".to_owned())).unwrap(),
        }
        .try_into_http_request(
            "https://homeserver.example",
            SendAccessToken::IfRequired("token"),
            versions(&[MatrixVersion::V1_0]),
        )
        .expect("the request is expressible");

        assert_eq!(http_request.uri().path(), "/_matrix/client/r0/pushers/set");
    }

    #[test]
    fn the_pushers_list_is_a_bare_get() {
        let http_request: http::Request<Vec<u8>> = ListWebPushers {}
            .try_into_http_request(
                "https://homeserver.example",
                SendAccessToken::IfRequired("token"),
                versions(&[MatrixVersion::V1_11]),
            )
            .expect("the request is expressible");

        assert_eq!(http_request.method(), &http::Method::GET);
        assert_eq!(http_request.uri().path(), "/_matrix/client/v3/pushers");
    }

    #[test]
    fn the_ack_goes_to_the_unstable_path() {
        let http_request: http::Request<Vec<u8>> = AckWebPusher {
            app_id: "moe.sable.webpush".to_owned(),
            ack_token: "token".to_owned(),
        }
        .try_into_http_request(
            "https://homeserver.example",
            SendAccessToken::IfRequired("token"),
            (),
        )
        .expect("the request is expressible");

        assert_eq!(http_request.method(), &http::Method::POST);
        assert_eq!(
            http_request.uri().path(),
            "/_matrix/client/unstable/org.matrix.msc4174/pushers/ack"
        );
        assert_eq!(
            http_request.headers().get("Authorization").unwrap(),
            "Bearer token"
        );
        assert_eq!(
            serde_json::from_slice::<JsonValue>(http_request.body().as_slice()).unwrap(),
            serde_json::json!({"app_id": "moe.sable.webpush", "ack_token": "token"})
        );
    }

    /// Mounts a homeserver's `/versions` and `/capabilities`, whose contents
    /// are the caller's choice, and returns a logged-in client against them.
    async fn homeserver(
        unstable_features: JsonValue,
        capabilities: JsonValue,
    ) -> matrix_sdk::Client {
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};

        let server = MatrixMockServer::new().await;
        Mock::given(method("GET"))
            .and(path("/_matrix/client/versions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"versions": ["v1.11"], "unstable_features": unstable_features}),
            ))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path("/_matrix/client/v3/capabilities"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "capabilities": capabilities })),
            )
            .mount(server.server())
            .await;

        matrix_sdk::test_utils::client::MockClientBuilder::new(Some(&server.uri()))
            .logged_in_with_token(
                "token".to_owned(),
                matrix_sdk::ruma::owned_user_id!("@sable:example.org"),
                matrix_sdk::ruma::owned_device_id!("DEVICE"),
            )
            .build()
            .await
    }

    #[tokio::test]
    async fn a_capability_alone_announces_the_homeserver_delivery() {
        let client = homeserver(
            json!({}),
            json!({"org.matrix.msc4174.webpush": {"enabled": true, "vapid": "BRaw"}}),
        )
        .await;

        assert_eq!(support(&client).await.unwrap(), Some("BRaw".to_owned()));
    }

    #[tokio::test]
    async fn the_stable_capability_is_read_without_the_unstable_feature() {
        let client = homeserver(
            json!({}),
            json!({"m.webpush": {"enabled": true, "vapid": "BStable"}}),
        )
        .await;

        assert_eq!(support(&client).await.unwrap(), Some("BStable".to_owned()));
    }

    #[tokio::test]
    async fn a_feature_without_a_capability_makes_no_homeserver_delivery() {
        let client = homeserver(json!({"org.matrix.msc4174": true}), json!({})).await;

        assert_eq!(support(&client).await.unwrap(), None);
    }

    #[test]
    fn only_an_enabled_capability_with_a_vapid_key_is_a_webpush_server() {
        assert_eq!(
            vapid(&serde_json::json!({"enabled": true, "vapid": "BExx"})),
            Some("BExx".to_owned())
        );
        assert_eq!(
            vapid(&serde_json::json!({"enabled": true, "vapid": " "})),
            None
        );
        assert_eq!(
            vapid(&serde_json::json!({"enabled": false, "vapid": "BExx"})),
            None
        );
        assert_eq!(vapid(&serde_json::json!({"enabled": true})), None);
        assert_eq!(
            vapid(&serde_json::json!({"enabled": true, "other": 1})),
            None
        );
    }
}
