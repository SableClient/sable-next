#[cfg(not(target_family = "wasm"))]
use std::time::Duration;

use base64::Engine;
use matrix_sdk::Room;
use matrix_sdk::ruma::api::client::account::request_openid_token;
use matrix_sdk::ruma::{DeviceId, UserId};
use serde::{Deserialize, Serialize};

#[cfg(not(target_family = "wasm"))]
const PROVISION_TIMEOUT: Duration = Duration::from_secs(15);
const RTC_FOCI_WELL_KNOWN_KEY: &str = "org.matrix.msc4143.rtc_foci";

pub(crate) fn livekit_identity(user_id: &UserId, device_id: &DeviceId) -> String {
    format!("{user_id}:{device_id}")
}

#[derive(Debug, Serialize)]
struct OpenIdCredentials<'a> {
    access_token: &'a str,
    token_type: &'a str,
    matrix_server_name: &'a str,
    expires_in: u64,
}

#[derive(Debug, Serialize)]
struct SfuGetRequest<'a> {
    room: &'a str,
    openid_token: OpenIdCredentials<'a>,
    device_id: &'a str,
}

#[derive(Debug, Serialize)]
struct SfuGetTokenRequest<'a> {
    room_id: &'a str,
    slot_id: &'static str,
    openid_token: OpenIdCredentials<'a>,
    member: SfuMember<'a>,
}

#[derive(Debug, Serialize)]
struct SfuMember<'a> {
    id: &'a str,
    claimed_user_id: &'a str,
    claimed_device_id: &'a str,
}

#[derive(Debug, Deserialize)]
struct SfuGetResponse {
    url: String,
    jwt: String,
}

pub(crate) struct Provisioned {
    pub(crate) url: String,
    pub(crate) jwt: String,
    pub(crate) identity: String,
}

fn http_client() -> Option<matrix_sdk::reqwest::Client> {
    let builder = crate::tls::apply(matrix_sdk::reqwest::Client::builder());
    #[cfg(not(target_family = "wasm"))]
    let builder = builder.timeout(PROVISION_TIMEOUT);
    builder.build().ok()
}

pub(crate) async fn well_known_service_urls(server: &url::Url) -> Vec<String> {
    let Ok(endpoint) = server.join("/.well-known/matrix/client") else {
        return Vec::new();
    };
    let Some(http) = http_client() else {
        return Vec::new();
    };

    let response = match http.get(endpoint).send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            tracing::debug!(status = %response.status(), "no rtc foci in well-known");
            return Vec::new();
        }
        Err(error) => {
            tracing::debug!(?error, "could not read well-known for rtc foci");
            return Vec::new();
        }
    };

    let Ok(body) = response.text().await else {
        return Vec::new();
    };
    let Ok(document) = serde_json::from_str::<serde_json::Value>(&body) else {
        return Vec::new();
    };
    let Some(foci) = document
        .get(RTC_FOCI_WELL_KNOWN_KEY)
        .and_then(|f| f.as_array())
    else {
        return Vec::new();
    };

    foci.iter()
        .filter(|focus| focus.get("type").and_then(|t| t.as_str()) == Some("livekit"))
        .filter_map(|focus| focus.get("livekit_service_url")?.as_str())
        .filter(|url| !url.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

pub(crate) async fn provision(
    room: &Room,
    service_url: &str,
    device_id: &DeviceId,
) -> Result<Provisioned, ProvisionError> {
    let client = room.client();
    let user_id = client
        .user_id()
        .ok_or(ProvisionError::NotLoggedIn)?
        .to_owned();

    let token = client
        .send(request_openid_token::v3::Request::new(user_id))
        .await
        .map_err(|_| ProvisionError::OpenIdUnavailable)?;

    let body = SfuGetRequest {
        room: room.room_id().as_str(),
        openid_token: OpenIdCredentials {
            access_token: &token.access_token,
            token_type: "Bearer",
            matrix_server_name: token.matrix_server_name.as_str(),
            expires_in: token.expires_in.as_secs(),
        },
        device_id: device_id.as_str(),
    };

    let http = http_client().ok_or(ProvisionError::Unreachable)?;

    let payload = serde_json::to_vec(&body).map_err(|_| ProvisionError::MalformedResponse)?;
    let response = http
        .post(format!("{}/sfu/get", service_url.trim_end_matches('/')))
        .header("Content-Type", "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|_| ProvisionError::Unreachable)?;

    if !response.status().is_success() {
        return Err(ProvisionError::Refused(response.status().as_u16()));
    }

    let body = response
        .text()
        .await
        .map_err(|_| ProvisionError::MalformedResponse)?;
    let provisioned: SfuGetResponse =
        serde_json::from_str(&body).map_err(|_| ProvisionError::MalformedResponse)?;

    if provisioned.url.is_empty() || provisioned.jwt.is_empty() {
        return Err(ProvisionError::MalformedResponse);
    }
    let identity = jwt_identity(&provisioned.jwt)?;

    Ok(Provisioned {
        url: provisioned.url,
        jwt: provisioned.jwt,
        identity,
    })
}

pub(crate) async fn provision_matrix2(
    room: &Room,
    service_url: &str,
    device_id: &DeviceId,
    member_id: &str,
) -> Result<Provisioned, ProvisionError> {
    let client = room.client();
    let user_id = client
        .user_id()
        .ok_or(ProvisionError::NotLoggedIn)?
        .to_owned();
    let token = client
        .send(request_openid_token::v3::Request::new(user_id.clone()))
        .await
        .map_err(|_| ProvisionError::OpenIdUnavailable)?;
    let body = SfuGetTokenRequest {
        room_id: room.room_id().as_str(),
        slot_id: "m.call#ROOM",
        openid_token: OpenIdCredentials {
            access_token: &token.access_token,
            token_type: "Bearer",
            matrix_server_name: token.matrix_server_name.as_str(),
            expires_in: token.expires_in.as_secs(),
        },
        member: SfuMember {
            id: member_id,
            claimed_user_id: user_id.as_str(),
            claimed_device_id: device_id.as_str(),
        },
    };
    provision_request(service_url, "get_token", &body).await
}

pub(crate) async fn provision_remote(
    room: &Room,
    service_url: &str,
    device_id: &DeviceId,
    member_id: &str,
) -> Result<Provisioned, ProvisionError> {
    match provision_matrix2(room, service_url, device_id, member_id).await {
        Ok(provisioned) => Ok(provisioned),
        Err(_) => provision(room, service_url, device_id).await,
    }
}

async fn provision_request<T: Serialize>(
    service_url: &str,
    endpoint: &str,
    body: &T,
) -> Result<Provisioned, ProvisionError> {
    let http = http_client().ok_or(ProvisionError::Unreachable)?;
    let payload = serde_json::to_vec(body).map_err(|_| ProvisionError::MalformedResponse)?;
    let response = http
        .post(format!(
            "{}/{}",
            service_url.trim_end_matches('/'),
            endpoint
        ))
        .header("Content-Type", "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|_| ProvisionError::Unreachable)?;
    if !response.status().is_success() {
        return Err(ProvisionError::Refused(response.status().as_u16()));
    }
    let body = response
        .text()
        .await
        .map_err(|_| ProvisionError::MalformedResponse)?;
    let provisioned: SfuGetResponse =
        serde_json::from_str(&body).map_err(|_| ProvisionError::MalformedResponse)?;
    if provisioned.url.is_empty() || provisioned.jwt.is_empty() {
        return Err(ProvisionError::MalformedResponse);
    }
    let identity = jwt_identity(&provisioned.jwt)?;
    Ok(Provisioned {
        url: provisioned.url,
        jwt: provisioned.jwt,
        identity,
    })
}

#[derive(Deserialize)]
struct JwtPayload {
    sub: String,
    video: JwtVideo,
}

#[derive(Deserialize)]
struct JwtVideo {
    room: String,
}

fn jwt_identity(jwt: &str) -> Result<String, ProvisionError> {
    let Some(payload) = jwt.split('.').nth(1) else {
        return Err(ProvisionError::MalformedResponse);
    };
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .map_err(|_| ProvisionError::MalformedResponse)?;
    let payload: JwtPayload =
        serde_json::from_slice(&decoded).map_err(|_| ProvisionError::MalformedResponse)?;
    if payload.sub.is_empty() || payload.video.room.is_empty() {
        return Err(ProvisionError::MalformedResponse);
    }
    Ok(payload.sub)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProvisionError {
    NotLoggedIn,
    OpenIdUnavailable,
    Unreachable,
    Refused(u16),
    MalformedResponse,
}

impl std::fmt::Display for ProvisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotLoggedIn => f.write_str("not logged in"),
            Self::OpenIdUnavailable => {
                f.write_str("the homeserver would not issue an OpenID token")
            }
            Self::Unreachable => f.write_str("the focus could not be reached"),
            Self::Refused(status) => write!(f, "the focus refused the token with status {status}"),
            Self::MalformedResponse => f.write_str("the focus returned an unusable token"),
        }
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{device_id, user_id};
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::{
        OpenIdCredentials, ProvisionError, SfuGetTokenRequest, SfuMember, jwt_identity,
        livekit_identity, provision_request,
    };

    #[test]
    fn test_the_livekit_identity_pairs_with_the_legacy_endpoint() {
        assert_eq!(
            livekit_identity(user_id!("@erwan:localhost"), device_id!("DEVICEID")),
            "@erwan:localhost:DEVICEID"
        );
    }

    #[test]
    fn test_a_refusal_reports_the_status_and_not_the_body() {
        let message = ProvisionError::Refused(403).to_string();

        assert!(message.contains("403"));
        assert!(!message.contains("jwt"));
    }

    #[test]
    fn token_requires_a_subject_and_room() {
        assert_eq!(
            jwt_identity("x.eyJzdWIiOiJpZCIsInZpZGVvIjp7InJvb20iOiJyIn19.x"),
            Ok("id".to_owned())
        );
        assert_eq!(
            jwt_identity("x.eyJzdWIiOiIiLCJ2aWRlbyI6eyJyb29tIjoiciJ9fQ.x"),
            Err(ProvisionError::MalformedResponse)
        );
    }

    #[test]
    fn matrix2_request_uses_the_sticky_call_slot_and_claims() {
        let body = SfuGetTokenRequest {
            room_id: "!room:example.org",
            slot_id: "m.call#ROOM",
            openid_token: OpenIdCredentials {
                access_token: "token",
                token_type: "Bearer",
                matrix_server_name: "example.org",
                expires_in: 60,
            },
            member: SfuMember {
                id: "member",
                claimed_user_id: "@user:example.org",
                claimed_device_id: "DEVICE",
            },
        };
        let value = serde_json::to_value(body).unwrap();
        assert_eq!(value["room_id"], "!room:example.org");
        assert_eq!(value["slot_id"], "m.call#ROOM");
        assert_eq!(value["member"]["claimed_device_id"], "DEVICE");
    }

    #[tokio::test]
    async fn matrix2_request_posts_to_the_root_get_token_endpoint() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/get_token"))
            .and(body_partial_json(serde_json::json!({
                "slot_id": "m.call#ROOM",
                "member": { "id": "member" },
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "url": "wss://sfu.example.org",
                "jwt": "x.eyJzdWIiOiJpZCIsInZpZGVvIjp7InJvb20iOiJyIn19.x",
            })))
            .mount(&server)
            .await;
        let body = SfuGetTokenRequest {
            room_id: "!room:example.org",
            slot_id: "m.call#ROOM",
            openid_token: OpenIdCredentials {
                access_token: "token",
                token_type: "Bearer",
                matrix_server_name: "example.org",
                expires_in: 60,
            },
            member: SfuMember {
                id: "member",
                claimed_user_id: "@user:example.org",
                claimed_device_id: "DEVICE",
            },
        };
        let provisioned = provision_request(&server.uri(), "get_token", &body)
            .await
            .unwrap();
        assert_eq!(provisioned.identity, "id");
    }
}
