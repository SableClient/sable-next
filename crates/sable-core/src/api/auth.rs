use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};

use super::Handler;
use crate::Core;
use crate::protocol::{RpcError, LoginFlowsView, RegistrationFlowsView, RegistrationResultView};

domain! {
    login,
    login_flows,
    registration_flows,
    register,
    request_registration_email,
    submit_registration_email,
    continue_registration,
    cancel_registration,
    request_password_reset_email,
    reset_password,
    start_oidc_login,
    complete_oidc_login,
    start_sso_login,
    complete_sso_login,
    start_qr_login,
    start_qr_grant,
    qr_check_code,
    qr_grant_continue,
    cancel_qr,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LoginIdentifier {
    User { user: String },
    Email { address: String },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum AuthIntent {
    Login,
    Register,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct LoginParams {
    #[serde(default)]
    pub reauth_account_id: Option<String>,
    pub homeserver: String,
    pub identifier: LoginIdentifier,
    pub password: String,
    #[serde(default)]
    pub device_display_name: Option<String>,
}

impl Handler for LoginParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.login(
            self.homeserver,
            self.identifier,
            self.password,
            self.reauth_account_id,
            self.device_display_name,
        )
        .await
        .map(|user_id| user_id.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct LoginFlowsParams {
    pub homeserver: String,
}

impl Handler for LoginFlowsParams {
    type Ok = LoginFlowsView;

    async fn run(self, core: &Arc<Core>) -> Result<LoginFlowsView, RpcError> {
        core.login_flows(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RegistrationFlowsParams {
    pub homeserver: String,
}

impl Handler for RegistrationFlowsParams {
    type Ok = RegistrationFlowsView;

    async fn run(self, core: &Arc<Core>) -> Result<RegistrationFlowsView, RpcError> {
        core.discover_registration_flows(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RegisterParams {
    pub homeserver: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub registration_email: Option<String>,
    pub registration_token: Option<String>,
    #[serde(default)]
    pub device_display_name: Option<String>,
}

impl Handler for RegisterParams {
    type Ok = RegistrationResultView;

    async fn run(self, core: &Arc<Core>) -> Result<RegistrationResultView, RpcError> {
        core.register(
            self.homeserver,
            self.username,
            self.password,
            self.registration_email,
            self.registration_token,
            self.device_display_name,
        )
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RequestRegistrationEmailParams {
    pub email: String,
}

impl Handler for RequestRegistrationEmailParams {
    type Ok = RegistrationResultView;

    async fn run(self, core: &Arc<Core>) -> Result<RegistrationResultView, RpcError> {
        core.request_registration_email(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SubmitRegistrationEmailParams {
    pub token: String,
}

impl Handler for SubmitRegistrationEmailParams {
    type Ok = RegistrationResultView;

    async fn run(self, core: &Arc<Core>) -> Result<RegistrationResultView, RpcError> {
        core.submit_registration_email(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ContinueRegistrationParams {}

impl Handler for ContinueRegistrationParams {
    type Ok = RegistrationResultView;

    async fn run(self, core: &Arc<Core>) -> Result<RegistrationResultView, RpcError> {
        core.continue_registration(true).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CancelRegistrationParams {}

impl Handler for CancelRegistrationParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.next_registration_attempt
            .fetch_add(1, Ordering::AcqRel);
        core.pending_registration.lock().await.take();
        core.pending_login.lock().await.take();
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RequestPasswordResetEmailParams {
    pub homeserver: String,
    pub email: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    pub send_attempt: u32,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RequestPasswordResetEmailOk {
    pub client_secret: String,
    pub sid: String,
}

impl Handler for RequestPasswordResetEmailParams {
    type Ok = RequestPasswordResetEmailOk;

    async fn run(self, core: &Arc<Core>) -> Result<RequestPasswordResetEmailOk, RpcError> {
        core.request_password_reset_email(self)
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ResetPasswordParams {
    pub homeserver: String,
    pub client_secret: String,
    pub sid: String,
    pub new_password: String,
    pub logout_devices: bool,
}

impl Handler for ResetPasswordParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.reset_password(self)
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct StartOidcLoginParams {
    #[serde(default)]
    pub reauth_account_id: Option<String>,
    pub homeserver: String,
    pub redirect_uri: String,
    pub intent: AuthIntent,
    #[serde(default)]
    pub device_display_name: Option<String>,
}

impl Handler for StartOidcLoginParams {
    /// The authorization URL to open.
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.start_oidc_login(self)
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CompleteOidcLoginParams {
    pub callback_url: String,
}

impl Handler for CompleteOidcLoginParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.complete_oidc_login(self).await
            .map(|user_id| user_id.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct StartSsoLoginParams {
    #[serde(default)]
    pub reauth_account_id: Option<String>,
    pub homeserver: String,
    pub redirect_uri: String,
    #[serde(default)]
    pub idp_id: Option<String>,
    pub intent: AuthIntent,
}

impl Handler for StartSsoLoginParams {
    /// The authorization URL to open.
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.start_sso_login(self)
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CompleteSsoLoginParams {
    pub callback_url: String,
    #[serde(default)]
    pub device_display_name: Option<String>,
}

impl Handler for CompleteSsoLoginParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.complete_sso_login(self).await
            .map(|user_id| user_id.to_string())
    }
}

/// Signs this device in from another one (MSC4108). `scanned` is the
/// other device's code, base64 encoded; without it this device shows one.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct StartQrLoginParams {
    #[serde(default)]
    pub homeserver: Option<String>,
    pub redirect_uri: String,
    pub scanned: Option<String>,
}

impl Handler for StartQrLoginParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.start_qr_login(self)
            .await
    }
}

/// Lets another device sign in to this account (MSC4108).
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct StartQrGrantParams {
    #[serde(default)]
    pub scanned: Option<String>,
}

impl Handler for StartQrGrantParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.start_qr_grant(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct QrCheckCodeParams {
    pub code: u8,
}

impl Handler for QrCheckCodeParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.qr_check_code(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct QrGrantContinueParams {
    pub confirm: bool,
}

impl Handler for QrGrantContinueParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.qr_grant_continue(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CancelQrParams {}

impl Handler for CancelQrParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.cancel_qr().await;
        Ok(())
    }
}
