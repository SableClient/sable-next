#[cfg(not(target_family = "wasm"))]
use std::time::Duration;

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

#[derive(Debug, Deserialize)]
struct SfuGetResponse {
    url: String,
    jwt: String,
}

pub(crate) struct Provisioned {
    pub(crate) url: String,
    pub(crate) jwt: String,
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

    Ok(Provisioned {
        url: provisioned.url,
        jwt: provisioned.jwt,
    })
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

    use super::{ProvisionError, livekit_identity};

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
}
