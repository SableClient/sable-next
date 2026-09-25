use matrix_sdk::ruma::api::client::account::change_password::v3::Request as ChangePasswordRequest;
use matrix_sdk::ruma::api::client::account::request_password_change_token_via_email::v3::Request as PasswordEmailRequest;
use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, EmailIdentity, UiaaInfo};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::{ClientSecret, OwnedClientSecret, OwnedSessionId, SessionId, UInt};

use std::sync::Arc;

use crate::protocol::{CommandErr, CommandOk};
use crate::{Core, session};

fn email_identity_auth(
    sid: &OwnedSessionId,
    client_secret: &OwnedClientSecret,
    session: Option<&str>,
) -> Option<AuthData> {
    let identity: EmailIdentity = serde_json::from_value(serde_json::json!({
        "type": "m.login.email.identity",
        "threepid_creds": { "sid": sid, "client_secret": client_secret },
        "session": session,
    }))
    .ok()?;
    Some(AuthData::EmailIdentity(identity))
}

fn offers_email_identity(info: &UiaaInfo) -> bool {
    info.flows
        .iter()
        .any(|flow| flow.stages.contains(&AuthType::EmailIdentity))
}

fn change_password_request(
    new_password: &str,
    logout_devices: bool,
    auth: Option<AuthData>,
) -> ChangePasswordRequest {
    let mut request = ChangePasswordRequest::new(new_password.to_owned());
    request.logout_devices = logout_devices;
    request.auth = auth;
    request
}

impl Core {
    fn password_reset_error(&self, context: &str, error: matrix_sdk::HttpError) -> CommandErr {
        match error.client_api_error_kind() {
            Some(ErrorKind::ThreepidNotFound | ErrorKind::NotFound) => CommandErr::UnknownEmail,
            Some(
                ErrorKind::ThreepidMediumNotSupported
                | ErrorKind::ThreepidDenied
                | ErrorKind::Unrecognized,
            ) => CommandErr::Unsupported,
            Some(ErrorKind::WeakPassword) => CommandErr::WeakPassword,
            Some(kind) if kind.errcode().as_str().starts_with("M_PASSWORD_") => {
                CommandErr::WeakPassword
            }
            _ => self.homeserver_http_error(context, error),
        }
    }

    pub(super) async fn request_password_reset_email(
        self: &Arc<Self>,
        homeserver: String,
        email: String,
        client_secret: Option<String>,
        send_attempt: u32,
    ) -> Result<CommandOk, CommandErr> {
        let email = email.trim().to_owned();
        if email.is_empty() || !email.contains('@') {
            return Err(CommandErr::InvalidEmail);
        }
        let client_secret = match client_secret {
            Some(secret) => {
                ClientSecret::parse(&secret).map_err(|_| CommandErr::EmailVerificationFailed)?
            }
            None => ClientSecret::new(),
        };
        let client = session::discovery_client(&homeserver)
            .await
            .map_err(|error| self.discovery_error(error))?;
        let request =
            PasswordEmailRequest::new(client_secret.clone(), email, UInt::from(send_attempt));
        let response = client
            .send(request)
            .await
            .map_err(|error| self.password_reset_error("password_reset_email", error))?;
        Ok(CommandOk::RequestPasswordResetEmail {
            client_secret: client_secret.to_string(),
            sid: response.sid.to_string(),
        })
    }

    pub(super) async fn reset_password(
        self: &Arc<Self>,
        homeserver: String,
        client_secret: String,
        sid: String,
        new_password: String,
        logout_devices: bool,
    ) -> Result<CommandOk, CommandErr> {
        let client_secret =
            ClientSecret::parse(&client_secret).map_err(|_| CommandErr::EmailVerificationFailed)?;
        let sid = SessionId::parse(&sid).map_err(|_| CommandErr::EmailVerificationFailed)?;
        let client = session::discovery_client(&homeserver)
            .await
            .map_err(|error| self.discovery_error(error))?;

        let info = match client
            .send(change_password_request(&new_password, logout_devices, None))
            .await
        {
            Ok(_) => return Ok(CommandOk::ResetPassword),
            Err(error) => match error.as_uiaa_response() {
                Some(info) => info.clone(),
                None => return Err(self.password_reset_error("reset_password", error)),
            },
        };
        if !offers_email_identity(&info) {
            return Err(CommandErr::Unsupported);
        }
        let auth = email_identity_auth(&sid, &client_secret, info.session.as_deref())
            .ok_or_else(|| self.failed("reset_password", "email identity auth did not build"))?;

        match client
            .send(change_password_request(
                &new_password,
                logout_devices,
                Some(auth),
            ))
            .await
        {
            Ok(_) => Ok(CommandOk::ResetPassword),
            Err(error) if error.as_uiaa_response().is_some() => {
                Err(CommandErr::EmailVerificationFailed)
            }
            Err(error) => Err(self.password_reset_error("reset_password", error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_identity_auth_carries_the_threepid_and_session() {
        let sid = SessionId::parse("sid-1").unwrap();
        let secret = ClientSecret::parse("secret-1").unwrap();
        let auth = email_identity_auth(&sid, &secret, Some("session-1"));
        let value = serde_json::to_value(auth).unwrap();
        assert_eq!(value["type"], "m.login.email.identity");
        assert_eq!(value["threepid_creds"]["sid"], "sid-1");
        assert_eq!(value["threepid_creds"]["client_secret"], "secret-1");
        assert_eq!(value["session"], "session-1");
    }

    #[cfg(not(target_family = "wasm"))]
    fn test_core(prefix: &str) -> (Arc<Core>, std::path::PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "{prefix}-{}",
            matrix_sdk::ruma::TransactionId::new()
        ));
        let (core, _events) = Core::new(
            directory.to_str().unwrap(),
            Box::new(crate::store::MemorySessionStore::default()),
        );
        (core, directory)
    }

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn a_reset_retries_with_the_validated_email_after_the_uiaa_challenge() {
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{body_partial_json, method, path},
        };
        let server = MatrixMockServer::new().await;
        server.mock_versions().ok().mount().await;
        Mock::given(method("POST"))
            .and(path(
                "/_matrix/client/v3/account/password/email/requestToken",
            ))
            .and(body_partial_json(serde_json::json!({
                "email": "alice@example.org", "send_attempt": 1
            })))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"sid": "sid-1"})),
            )
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/account/password"))
            .and(body_partial_json(serde_json::json!({
                "auth": {
                    "type": "m.login.email.identity",
                    "session": "uia-1",
                    "threepid_creds": {"sid": "sid-1"}
                }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .expect(1)
            .with_priority(1)
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/account/password"))
            .and(body_partial_json(serde_json::json!({
                "new_password": "correct horse", "logout_devices": false
            })))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "flows": [{"stages": ["m.login.email.identity"]}],
                "params": {},
                "session": "uia-1"
            })))
            .expect(1)
            .with_priority(2)
            .mount(server.server())
            .await;
        let (core, directory) = test_core("sable-reset");

        let CommandOk::RequestPasswordResetEmail { client_secret, sid } = core
            .request_password_reset_email(
                server.server().uri(),
                " alice@example.org ".to_owned(),
                None,
                1,
            )
            .await
            .unwrap()
        else {
            panic!("expected a password reset email");
        };
        assert_eq!(sid, "sid-1");
        let result = core
            .reset_password(
                server.server().uri(),
                client_secret,
                sid,
                "correct horse".to_owned(),
                false,
            )
            .await;

        assert!(matches!(result, Ok(CommandOk::ResetPassword)));
        drop(core);
        drop(server);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn an_unvalidated_email_asks_the_user_to_open_the_link() {
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path},
        };
        let server = MatrixMockServer::new().await;
        server.mock_versions().ok().mount().await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/account/password"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "flows": [{"stages": ["m.login.email.identity"]}],
                "session": "uia-1",
                "errcode": "M_UNAUTHORIZED",
                "error": "Unable to get validated threepid"
            })))
            .expect(2)
            .mount(server.server())
            .await;
        let (core, directory) = test_core("sable-reset-unvalidated");

        let result = core
            .reset_password(
                server.server().uri(),
                "secret-1".to_owned(),
                "sid-1".to_owned(),
                "correct horse".to_owned(),
                true,
            )
            .await;

        assert!(matches!(result, Err(CommandErr::EmailVerificationFailed)));
        drop(core);
        drop(server);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn an_email_the_server_cannot_reset_is_reported_as_such() {
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path},
        };
        let server = MatrixMockServer::new().await;
        server.mock_versions().ok().mount().await;
        Mock::given(method("POST"))
            .and(path(
                "/_matrix/client/v3/account/password/email/requestToken",
            ))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "errcode": "M_THREEPID_NOT_FOUND", "error": "Email not found"
            })))
            .mount(server.server())
            .await;
        let (core, directory) = test_core("sable-reset-unknown");

        let unknown = core
            .request_password_reset_email(
                server.server().uri(),
                "bob@example.org".to_owned(),
                None,
                1,
            )
            .await;
        let invalid = core
            .request_password_reset_email(server.server().uri(), "bob".to_owned(), None, 1)
            .await;

        assert!(matches!(unknown, Err(CommandErr::UnknownEmail)));
        assert!(matches!(invalid, Err(CommandErr::InvalidEmail)));
        drop(core);
        drop(server);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn a_server_without_email_reset_is_unsupported() {
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path},
        };
        let server = MatrixMockServer::new().await;
        server.mock_versions().ok().mount().await;
        Mock::given(method("POST"))
            .and(path(
                "/_matrix/client/v3/account/password/email/requestToken",
            ))
            .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
                "errcode": "M_UNRECOGNIZED", "error": "Unrecognized request"
            })))
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/account/password"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "errcode": "M_WEAK_PASSWORD", "error": "too weak"
            })))
            .mount(server.server())
            .await;
        let (core, directory) = test_core("sable-reset-unsupported");

        let unsupported = core
            .request_password_reset_email(
                server.server().uri(),
                "bob@example.org".to_owned(),
                None,
                1,
            )
            .await;
        let weak = core
            .reset_password(
                server.server().uri(),
                "secret-1".to_owned(),
                "sid-1".to_owned(),
                "a".to_owned(),
                true,
            )
            .await;

        assert!(matches!(unsupported, Err(CommandErr::Unsupported)));
        assert!(matches!(weak, Err(CommandErr::WeakPassword)));
        drop(core);
        drop(server);
        let _ = std::fs::remove_dir_all(directory);
    }
}
