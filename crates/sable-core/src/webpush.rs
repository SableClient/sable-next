//! MSC4174 web push: the homeserver encrypts and delivers, so no gateway.
//!
//! Ruma's client API types cannot express the custom pusher kind, so the three
//! requests are hand-rolled into the [`OutgoingRequest`] shape.

use serde::Deserialize;
use serde_json::Value as JsonValue;

use http::{self, header::CONTENT_TYPE};
use matrix_sdk::SupportedPathBuilder;
use matrix_sdk::{Client, HttpResult};
use ruma::api::{
    BytesBody, EmptyBody, IncomingResponse, MatrixVersion, Metadata, OutgoingRequest, auth_scheme,
    client::discovery::get_capabilities,
    error::{DeserializationError, IntoHttpError},
    path_builder::{PathBuilder, StablePathSelector, VersionHistory},
};
use ruma::http_headers::APPLICATION_JSON;

use crate::protocol::{RegisteredPusherView, WebPusherView};

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
pub async fn support(client: &Client) -> Result<Option<String>, String> {
    let capabilities = client
        .send(get_capabilities::v3::Request::new())
        .await
        .map_err(|error| error.to_string())?;

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
pub async fn set_pusher(client: &Client, pusher: WebPusherView) -> Result<(), String> {
    let body = pusher_body(&pusher, client.user_id().map(ToString::to_string));

    client
        .send(SetWebPusher { body })
        .await
        .map(|EmptyResponse| ())
        .map_err(|error| error.to_string())
}

/// MSC4174's pusher body: `url` is the subscription, not a gateway, and the
/// server merges `default_payload` into every notification it encrypts.
fn pusher_body(pusher: &WebPusherView, user_id: Option<String>) -> JsonValue {
    let mut data = serde_json::Map::new();
    data.insert("url".to_owned(), pusher.endpoint.clone().into());
    data.insert("auth".to_owned(), pusher.auth.clone().into());
    if pusher.event_id_only {
        data.insert(
            "format".to_owned(),
            JsonValue::String("event_id_only".to_owned()),
        );
    }
    if let Some(user_id) = user_id {
        data.insert(
            "default_payload".to_owned(),
            serde_json::json!({ "user_id": user_id }),
        );
    }

    serde_json::json!({
        "pushkey": pusher.pushkey,
        "app_id": pusher.app_id,
        "kind": PUSHER_KIND,
        "app_display_name": "Sable",
        "device_display_name": pusher.device_display_name,
        "lang": "en",
        "data": data,
        "append": false,
    })
}

#[derive(Clone, Debug)]
struct SetWebPusher {
    body: JsonValue,
}

impl Metadata for SetWebPusher {
    const METHOD: http::Method = http::Method::POST;
    const RATE_LIMITED: bool = true;
    type Authentication = auth_scheme::AccessToken;
    type PathBuilder = VersionHistory;
    const PATH_BUILDER: VersionHistory = VersionHistory::new(
        &[],
        &[
            (
                StablePathSelector::Version(MatrixVersion::V1_0),
                "/_matrix/client/r0/pushers/set",
            ),
            (
                StablePathSelector::Version(MatrixVersion::V1_1),
                "/_matrix/client/v3/pushers/set",
            ),
        ],
        None,
        None,
    );
}

impl OutgoingRequest for SetWebPusher {
    type Body = BytesBody;
    type EndpointError = ruma::api::error::Error;
    type IncomingResponse = EmptyResponse;

    fn try_into_http_request_inner(
        self,
        base_url: &str,
        path_builder_input: <VersionHistory as PathBuilder>::Input<'_>,
    ) -> Result<http::Request<Self::Body>, IntoHttpError> {
        http::Request::builder()
            .method(Self::METHOD)
            .uri(Self::make_endpoint_url(
                path_builder_input,
                base_url,
                &[],
                "",
            )?)
            .header(CONTENT_TYPE, APPLICATION_JSON)
            .body(BytesBody(serde_json::to_vec(&self.body)?))
            .map_err(Into::into)
    }
}

/// For bodies the endpoint defines but the client doesn't care about.
#[derive(Debug)]
struct EmptyResponse;

impl IncomingResponse for EmptyResponse {
    type EndpointError = ruma::api::error::Error;

    fn try_from_http_response_inner(
        _: http::Response<&[u8]>,
    ) -> Result<Self, DeserializationError> {
        Ok(Self)
    }
}

/// # Errors
///
/// When the homeserver rejects the read.
pub async fn pushers(client: &Client) -> Result<Vec<RegisteredPusherView>, String> {
    let Webpushers { pushers } = client
        .send(ListWebPushers)
        .await
        .map_err(|error| error.to_string())?;

    Ok(pushers)
}

/// Read raw: ruma's `Pusher` carries neither a custom kind nor `activated`.
#[derive(Clone, Debug, Default)]
struct ListWebPushers;

impl Metadata for ListWebPushers {
    const METHOD: http::Method = http::Method::GET;
    const RATE_LIMITED: bool = false;
    type Authentication = auth_scheme::AccessToken;
    type PathBuilder = VersionHistory;
    const PATH_BUILDER: VersionHistory = VersionHistory::new(
        &[],
        &[
            (
                StablePathSelector::Version(MatrixVersion::V1_0),
                "/_matrix/client/r0/pushers",
            ),
            (
                StablePathSelector::Version(MatrixVersion::V1_1),
                "/_matrix/client/v3/pushers",
            ),
        ],
        None,
        None,
    );
}

impl OutgoingRequest for ListWebPushers {
    type Body = EmptyBody;
    type EndpointError = ruma::api::error::Error;
    type IncomingResponse = Webpushers;

    fn try_into_http_request_inner(
        self,
        base_url: &str,
        path_builder_input: <VersionHistory as PathBuilder>::Input<'_>,
    ) -> Result<http::Request<Self::Body>, IntoHttpError> {
        http::Request::builder()
            .method(Self::METHOD)
            .uri(Self::make_endpoint_url(
                path_builder_input,
                base_url,
                &[],
                "",
            )?)
            .body(EmptyBody)
            .map_err(Into::into)
    }
}

#[derive(Deserialize)]
struct RawPushers {
    pushers: Vec<RawPusher>,
}

#[derive(Deserialize)]
struct RawPusher {
    pushkey: String,
    app_id: String,
    /// `http`, the web push kind, or a server-defined kind.
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    device_display_name: Option<String>,
    /// Set by servers implementing the MSC4174 validation handshake.
    #[serde(default)]
    activated: Option<bool>,
}

impl From<RawPusher> for RegisteredPusherView {
    fn from(pusher: RawPusher) -> Self {
        Self {
            pushkey: pusher.pushkey,
            app_id: pusher.app_id,
            kind: pusher.kind,
            device_display_name: pusher.device_display_name,
            activated: pusher.activated,
        }
    }
}

#[derive(Debug)]
struct Webpushers {
    pushers: Vec<RegisteredPusherView>,
}

impl IncomingResponse for Webpushers {
    type EndpointError = ruma::api::error::Error;

    fn try_from_http_response_inner(
        response: http::Response<&[u8]>,
    ) -> Result<Self, DeserializationError> {
        let RawPushers { pushers } = serde_json::from_slice(response.body())?;
        Ok(Self {
            pushers: pushers.into_iter().map(Into::into).collect(),
        })
    }
}

/// # Errors
///
/// When the homeserver rejects the acknowledgement.
pub async fn ack(client: &Client, app_id: String, ack_token: String) -> Result<(), String> {
    client
        .send(AckWebPusher { app_id, ack_token })
        .await
        .map(|EmptyResponse| ())
        .map_err(|error| error.to_string())
}

/// Returns the token the validation push carried.
#[derive(Clone, Debug)]
struct AckWebPusher {
    app_id: String,
    ack_token: String,
}

impl Metadata for AckWebPusher {
    const METHOD: http::Method = http::Method::POST;
    const RATE_LIMITED: bool = false;
    type Authentication = auth_scheme::AccessToken;
    type PathBuilder = UnstablePath;
    const PATH_BUILDER: UnstablePath =
        UnstablePath("/_matrix/client/unstable/org.matrix.msc4174/pushers/ack");
}

impl OutgoingRequest for AckWebPusher {
    type Body = BytesBody;
    type EndpointError = ruma::api::error::Error;
    type IncomingResponse = EmptyResponse;

    fn try_into_http_request_inner(
        self,
        base_url: &str,
        path_builder_input: <UnstablePath as PathBuilder>::Input<'_>,
    ) -> Result<http::Request<Self::Body>, IntoHttpError> {
        let body = serde_json::json!({
            "app_id": self.app_id,
            "ack_token": self.ack_token,
        });

        http::Request::builder()
            .method(Self::METHOD)
            .uri(Self::make_endpoint_url(
                path_builder_input,
                base_url,
                &[],
                "",
            )?)
            .header(CONTENT_TYPE, APPLICATION_JSON)
            .body(BytesBody(serde_json::to_vec(&body)?))
            .map_err(Into::into)
    }
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

    use matrix_sdk::ruma::api::OutgoingRequestExt;
    use matrix_sdk::ruma::api::SupportedVersions;
    use matrix_sdk::ruma::api::auth_scheme::SendAccessToken;
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
    fn the_webpush_pusher_body_matches_msc4174() {
        assert_eq!(
            pusher_body(&pusher(), Some("@alice:example.org".to_owned())),
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
                "append": false,
            })
        );
    }

    #[test]
    fn rich_payloads_leave_the_format_to_the_server() {
        let rich = WebPusherView {
            event_id_only: false,
            ..pusher()
        };
        let body = pusher_body(&rich, Some("@alice:example.org".to_owned()));

        assert!(body["data"].get("format").is_none());
        assert_eq!(
            body["data"]["default_payload"]["user_id"],
            "@alice:example.org"
        );
    }

    #[test]
    fn the_pusher_is_registered_on_the_versioned_path() {
        let http_request: http::Request<Vec<u8>> = SetWebPusher {
            body: pusher_body(&pusher(), Some("@alice:example.org".to_owned())),
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
            pusher_body(&pusher(), Some("@alice:example.org".to_owned()))
        );
    }

    #[test]
    fn old_homeservers_still_get_the_r0_path() {
        let http_request: http::Request<Vec<u8>> = SetWebPusher {
            body: pusher_body(&pusher(), Some("@alice:example.org".to_owned())),
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
        let http_request: http::Request<Vec<u8>> = ListWebPushers
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

        assert_eq!(support(&client).await, Ok(Some("BRaw".to_owned())));
    }

    #[tokio::test]
    async fn the_stable_capability_is_read_without_the_unstable_feature() {
        let client = homeserver(
            json!({}),
            json!({"m.webpush": {"enabled": true, "vapid": "BStable"}}),
        )
        .await;

        assert_eq!(support(&client).await, Ok(Some("BStable".to_owned())));
    }

    #[tokio::test]
    async fn a_feature_without_a_capability_makes_no_homeserver_delivery() {
        let client = homeserver(json!({"org.matrix.msc4174": true}), json!({})).await;

        assert_eq!(support(&client).await, Ok(None));
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
