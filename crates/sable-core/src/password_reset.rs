use crate::SignedIn;
use crate::api::account::ChangePasswordParams;
use crate::api::auth::RequestPasswordResetEmailParams;
use crate::api::auth::ResetPasswordParams;
use matrix_sdk::ruma::api::client::account::change_password::v3::Request as ChangePasswordRequest;
use matrix_sdk::ruma::api::client::account::request_password_change_token_via_email::v3::Request as PasswordEmailRequest;
use matrix_sdk::ruma::api::client::discovery::get_capabilities;
use matrix_sdk::ruma::api::client::uiaa::{
    AuthData, AuthType, EmailIdentity, Password, ThirdpartyIdCredentials, UiaaInfo, UserIdentifier,
};
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::{ClientSecret, OwnedClientSecret, OwnedSessionId, SessionId, UInt};

use std::sync::Arc;

use crate::api::auth::RequestPasswordResetEmailOk;
use crate::protocol::{RpcCode, RpcError};
use crate::{Core, session};

#[derive(serde::Serialize)]
#[serde(tag = "type")]
enum EmailIdentityOut<'a> {
    #[serde(rename = "m.login.email.identity")]
    EmailIdentity {
        threepid_creds: &'a ThirdpartyIdCredentials,
        session: Option<&'a str>,
    },
}

/// ruma gives `EmailIdentity` no constructor, so it is read back from its wire form.
pub(crate) fn email_identity(
    creds: &ThirdpartyIdCredentials,
    session: Option<&str>,
) -> Option<AuthData> {
    let wire = serde_json::to_value(EmailIdentityOut::EmailIdentity {
        threepid_creds: creds,
        session,
    })
    .ok()?;
    let identity: EmailIdentity = serde_json::from_value(wire).ok()?;
    Some(AuthData::EmailIdentity(identity))
}

fn email_identity_auth(
    sid: &OwnedSessionId,
    client_secret: &OwnedClientSecret,
    session: Option<&str>,
) -> Option<AuthData> {
    email_identity(
        &ThirdpartyIdCredentials::new(sid.clone(), client_secret.clone()),
        session,
    )
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
    fn password_reset_error(&self, context: &str, error: &matrix_sdk::HttpError) -> RpcError {
        let rpc = match error.client_api_error_kind() {
            Some(ErrorKind::ThreepidNotFound | ErrorKind::NotFound) => RpcCode::UnknownEmail,
            Some(
                ErrorKind::ThreepidMediumNotSupported
                | ErrorKind::ThreepidDenied
                | ErrorKind::Unrecognized,
            ) => RpcCode::Unsupported,
            Some(ErrorKind::WeakPassword) => RpcCode::WeakPassword,
            Some(kind) if kind.errcode().as_str().starts_with("M_PASSWORD_") => {
                RpcCode::WeakPassword
            }
            _ => return self.rpc_error(context, error),
        };
        crate::errors::coded(context, rpc, error)
    }

    fn change_password_error(
        &self,
        context: &str,
        error: &matrix_sdk::HttpError,
        authenticated: bool,
    ) -> RpcError {
        if error.as_uiaa_response().is_some()
            || (authenticated
                && matches!(error.client_api_error_kind(), Some(ErrorKind::Forbidden)))
        {
            return crate::errors::coded(context, RpcCode::Denied, error);
        }
        match error.client_api_error_kind() {
            Some(ErrorKind::Forbidden | ErrorKind::NotFound | ErrorKind::Unrecognized) => {
                crate::errors::coded(context, RpcCode::Unsupported, error)
            }
            _ => self.password_reset_error(context, error),
        }
    }

    pub(super) async fn request_password_reset_email(
        self: &Arc<Self>,
        RequestPasswordResetEmailParams {
            homeserver,
            email,
            client_secret,
            send_attempt,
        }: RequestPasswordResetEmailParams,
    ) -> Result<RequestPasswordResetEmailOk, RpcError> {
        let email = email.trim().to_owned();
        if email.is_empty() || !email.contains('@') {
            return Err(RpcCode::InvalidEmail.into());
        }
        let client_secret = match client_secret {
            Some(secret) => {
                ClientSecret::parse(&secret).map_err(|_| RpcCode::EmailVerificationFailed)?
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
            .map_err(|error| self.password_reset_error("password_reset_email", &error))?;
        Ok(RequestPasswordResetEmailOk {
            client_secret: client_secret.to_string(),
            sid: response.sid.to_string(),
        })
    }

    pub(super) async fn reset_password(
        self: &Arc<Self>,
        ResetPasswordParams {
            homeserver,
            client_secret,
            sid,
            new_password,
            logout_devices,
        }: ResetPasswordParams,
    ) -> Result<(), RpcError> {
        let client_secret =
            ClientSecret::parse(&client_secret).map_err(|_| RpcCode::EmailVerificationFailed)?;
        let sid = SessionId::parse(&sid).map_err(|_| RpcCode::EmailVerificationFailed)?;
        let client = session::discovery_client(&homeserver)
            .await
            .map_err(|error| self.discovery_error(error))?;

        let info = match client
            .send(change_password_request(&new_password, logout_devices, None))
            .await
        {
            Ok(_) => return Ok(()),
            Err(error) => match error.as_uiaa_response() {
                Some(info) => info.clone(),
                None => return Err(self.password_reset_error("reset_password", &error)),
            },
        };
        if !offers_email_identity(&info) {
            return Err(RpcCode::Unsupported.into());
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
            Ok(_) => Ok(()),
            Err(error) if error.as_uiaa_response().is_some() => {
                Err(RpcCode::EmailVerificationFailed.into())
            }
            Err(error) => Err(self.password_reset_error("reset_password", &error)),
        }
    }
}

#[cfg(test)]
#[path = "password_reset_tests.rs"]
mod tests;

impl SignedIn {
    pub(crate) async fn password_change_enabled(&self) -> Result<bool, RpcError> {
        let capabilities = self
            .client()
            .send(get_capabilities::v3::Request::new())
            .await
            .map_err(|error| self.core().rpc_error("password_change_enabled", &error))?
            .capabilities;
        Ok(capabilities.change_password.enabled)
    }

    pub(crate) async fn change_password(
        &self,
        ChangePasswordParams {
            current_password,
            new_password,
            logout_devices,
        }: ChangePasswordParams,
    ) -> Result<(), RpcError> {
        let client = self.client();
        if client.oauth().full_session().is_some() {
            return Err(RpcCode::Unsupported.into());
        }
        let user_id = client.user_id().ok_or(RpcCode::NotLoggedIn)?.to_owned();

        let info = match client
            .send(change_password_request(&new_password, logout_devices, None))
            .await
        {
            Ok(_) => return Ok(()),
            Err(error) => match error.as_uiaa_response() {
                Some(info) => info.clone(),
                None => {
                    return Err(self.core().change_password_error(
                        "change_password",
                        &error,
                        false,
                    ));
                }
            },
        };
        if !info
            .flows
            .iter()
            .any(|flow| flow.stages == [AuthType::Password])
        {
            return Err(RpcCode::Unsupported.into());
        }
        let mut auth = Password::new(UserIdentifier::Matrix(user_id.into()), current_password);
        auth.session = info.session;

        client
            .send(change_password_request(
                &new_password,
                logout_devices,
                Some(AuthData::Password(auth)),
            ))
            .await
            .map(drop)
            .map_err(|error| {
                self.core()
                    .change_password_error("change_password_auth", &error, true)
            })
    }
}
