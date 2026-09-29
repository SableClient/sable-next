use std::sync::{Arc, PoisonError};

use futures_util::{Stream, StreamExt, pin_mut};
use matrix_sdk::authentication::oauth::qrcode::{
    CheckCodeSender, ContinuationMessageSender, DeviceAuthorizationOAuthError, GeneratedQrProgress,
    GrantLoginProgress, LoginProgress, Msc4108IntentData, QRCodeGrantLoginError, QRCodeLoginError,
    QrCodeData, QrCodeIntent, QrCodeIntentData, QrProgress, SecureChannelError,
};
use matrix_sdk::executor::{JoinHandleExt, spawn};
use url::Url;

use crate::ResultExt;
use crate::protocol::{CommandErr, CoreEvent, QrLoginFailureView, QrLoginProgressView};
use crate::session::{self, Credentials, PersistedSession};
use crate::verification::level_h_code;
use crate::{Core, Task};

#[derive(Default)]
pub(crate) struct QrSlots {
    check_code: std::sync::Mutex<Option<CheckCodeSender>>,
    continuation: std::sync::Mutex<Option<ContinuationMessageSender>>,
}

impl QrSlots {
    fn set_check_code(&self, sender: CheckCodeSender) {
        *self
            .check_code
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(sender);
    }

    fn set_continuation(&self, sender: ContinuationMessageSender) {
        *self
            .continuation
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(sender);
    }

    fn take_check_code(&self) -> Option<CheckCodeSender> {
        self.check_code
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }

    fn take_continuation(&self) -> Option<ContinuationMessageSender> {
        self.continuation
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }
}

pub(crate) struct QrFlow {
    slots: Arc<QrSlots>,
    _task: Task,
}

fn decode(data: &str) -> Result<QrCodeData, CommandErr> {
    QrCodeData::from_base64(data).map_err(|_| CommandErr::Denied)
}

fn reciprocating_homeserver(data: &QrCodeData) -> Option<String> {
    if data.intent() != QrCodeIntent::Reciprocate {
        return None;
    }
    match data.intent_data() {
        QrCodeIntentData::Msc4108 {
            data: Msc4108IntentData::Reciprocate { server_name },
            ..
        } => Some(server_name.clone()),
        QrCodeIntentData::Msc4388 { base_url, .. } => Some(base_url.to_string()),
        QrCodeIntentData::Msc4108 { .. } => None,
    }
}

fn channel_failure(error: &SecureChannelError) -> QrLoginFailureView {
    match error {
        SecureChannelError::InvalidCheckCode => QrLoginFailureView::CheckCode,
        SecureChannelError::RendezvousChannel(error)
            if error
                .as_client_api_error()
                .is_some_and(|error| error.status_code.as_u16() == 404) =>
        {
            QrLoginFailureView::Unsupported
        }
        _ => QrLoginFailureView::Other,
    }
}

fn login_failure(error: &QRCodeLoginError) -> QrLoginFailureView {
    match error {
        QRCodeLoginError::NotFound => QrLoginFailureView::Expired,
        QRCodeLoginError::SecureChannel(error) => channel_failure(error),
        QRCodeLoginError::OAuth(DeviceAuthorizationOAuthError::NoDeviceAuthorizationEndpoint) => {
            QrLoginFailureView::Unsupported
        }
        QRCodeLoginError::OAuth(error) if error.as_request_token_error().is_some() => {
            QrLoginFailureView::Declined
        }
        QRCodeLoginError::LoginFailure { .. } => QrLoginFailureView::Declined,
        _ => QrLoginFailureView::Other,
    }
}

fn grant_failure(error: &QRCodeGrantLoginError) -> QrLoginFailureView {
    match error {
        QRCodeGrantLoginError::NotFound => QrLoginFailureView::Expired,
        QRCodeGrantLoginError::InvalidCheckCode => QrLoginFailureView::CheckCode,
        QRCodeGrantLoginError::MissingSecretsBackup(_) => QrLoginFailureView::NoRecovery,
        QRCodeGrantLoginError::DeviceIDAlreadyInUse => QrLoginFailureView::DeviceInUse,
        QRCodeGrantLoginError::SecureChannel(error) => channel_failure(error),
        QRCodeGrantLoginError::LoginFailure { .. } => QrLoginFailureView::Declined,
        _ => QrLoginFailureView::Other,
    }
}

fn shown(data: &QrCodeData) -> QrLoginProgressView {
    level_h_code(&data.to_bytes()).map_or(QrLoginProgressView::Starting, |code| {
        QrLoginProgressView::ShowCode { code }
    })
}

fn generated(slots: &QrSlots, state: GeneratedQrProgress) -> QrLoginProgressView {
    match state {
        GeneratedQrProgress::QrReady(data) => shown(&data),
        GeneratedQrProgress::QrScanned(sender) => {
            slots.set_check_code(sender);
            QrLoginProgressView::EnterCheckCode
        }
    }
}

const fn scanned(QrProgress { check_code }: QrProgress) -> QrLoginProgressView {
    QrLoginProgressView::ShowCheckCode { check_code }
}

fn login_view<Q>(
    progress: LoginProgress<Q>,
    channel: impl FnOnce(Q) -> QrLoginProgressView,
) -> QrLoginProgressView {
    match progress {
        LoginProgress::Starting => QrLoginProgressView::Starting,
        LoginProgress::EstablishingSecureChannel(state) => channel(state),
        LoginProgress::WaitingForToken { user_code } => {
            QrLoginProgressView::WaitingForToken { user_code }
        }
        LoginProgress::SyncingSecrets | LoginProgress::Done => QrLoginProgressView::SyncingSecrets,
    }
}

fn grant_view<Q>(
    slots: &QrSlots,
    progress: GrantLoginProgress<Q>,
    channel: impl FnOnce(Q) -> QrLoginProgressView,
) -> QrLoginProgressView {
    match progress {
        GrantLoginProgress::Starting => QrLoginProgressView::Starting,
        GrantLoginProgress::EstablishingSecureChannel(state) => channel(state),
        GrantLoginProgress::WaitingForAuth {
            verification_uri,
            continuation_sender,
        } => {
            slots.set_continuation(continuation_sender);
            QrLoginProgressView::WaitingForAuth {
                verification_uri: verification_uri.to_string(),
            }
        }
        GrantLoginProgress::SyncingSecrets => QrLoginProgressView::SyncingSecrets,
        GrantLoginProgress::Done => QrLoginProgressView::Done,
    }
}

impl Core {
    fn emit_qr(&self, grant: bool, progress: QrLoginProgressView) {
        tracing::info!(
            operation = "qr_login",
            grant,
            stage = progress.stage(),
            "QR login progressed"
        );
        self.emit(CoreEvent::QrLogin { grant, progress });
    }

    fn watch<P, S, V>(self: &Arc<Self>, grant: bool, progress: S, view: V) -> Task
    where
        P: Send + 'static,
        S: Stream<Item = P> + Send + 'static,
        V: Fn(P) -> QrLoginProgressView + Send + 'static,
    {
        let core = self.clone();
        spawn(async move {
            pin_mut!(progress);
            while let Some(update) = progress.next().await {
                core.emit_qr(grant, view(update));
            }
        })
        .abort_on_drop()
    }

    pub(crate) async fn start_qr_login(
        self: &Arc<Self>,
        homeserver: Option<String>,
        redirect_uri: String,
        scanned_code: Option<String>,
    ) -> Result<(), CommandErr> {
        let scanned_code = scanned_code.as_deref().map(decode).transpose()?;
        let homeserver = match &scanned_code {
            Some(data) => reciprocating_homeserver(data).ok_or(CommandErr::Denied)?,
            None => homeserver.ok_or(CommandErr::Denied)?,
        };
        let redirect_uri =
            Url::parse(&redirect_uri).or_failed(self, "start_qr_login_redirect_uri")?;
        let (account_id, store_id) = self.allocate_account().await?;
        let client = self
            .build_account_client(&store_id, &homeserver)
            .await
            .or_failed(self, "start_qr_login_build_client")?;

        let slots = Arc::new(QrSlots::default());
        let core = self.clone();
        let flow_slots = slots.clone();
        let task = spawn(async move {
            let registration = session::qr_client_metadata(&redirect_uri).into();
            let oauth = client.oauth();
            let builder = oauth.login_with_qr_code(Some(&registration));
            let result = if let Some(data) = &scanned_code {
                let login = builder.scan(data);
                let _watch = core.watch(false, login.subscribe_to_progress(), |update| {
                    login_view(update, scanned)
                });
                login.await
            } else {
                let login = builder.generate();
                let _watch = core.watch(false, login.subscribe_to_progress(), move |update| {
                    login_view(update, |state| generated(&flow_slots, state))
                });
                login.await
            };
            let outcome = match result {
                Ok(()) => core
                    .finish_qr_login(client, homeserver, account_id, store_id)
                    .await
                    .map_err(|_| QrLoginFailureView::Other),
                Err(error) => {
                    tracing::warn!(operation = "qr_login", "QR login failed: {error}");
                    Err(login_failure(&error))
                }
            };
            core.emit_qr(
                false,
                outcome.map_or_else(
                    |reason| QrLoginProgressView::Failed { reason },
                    |user_id| QrLoginProgressView::SignedIn { user_id },
                ),
            );
        })
        .abort_on_drop();

        *self.qr_flow.lock().await = Some(QrFlow { slots, _task: task });
        Ok(())
    }

    async fn finish_qr_login(
        self: &Arc<Self>,
        client: matrix_sdk::Client,
        homeserver: String,
        account_id: String,
        store_id: String,
    ) -> Result<String, CommandErr> {
        let full = client
            .oauth()
            .full_session()
            .ok_or_else(|| self.failed("qr_login", "no session after the QR login"))?;
        let user_id = full.user.meta.user_id.to_string();
        let generation = self.claim_session_generation().await;
        self.persist(
            &account_id,
            &store_id,
            &PersistedSession {
                resolved_homeserver: Some(client.homeserver()),
                homeserver: homeserver.clone(),
                credentials: Credentials::oauth(full),
            },
            None,
        )
        .await?;
        self.start_session(client, homeserver, account_id, generation.value())
            .await?;
        Ok(user_id)
    }

    pub(crate) async fn start_qr_grant(
        self: &Arc<Self>,
        scanned_code: Option<String>,
    ) -> Result<(), CommandErr> {
        let scanned_code = scanned_code.as_deref().map(decode).transpose()?;
        if scanned_code
            .as_ref()
            .is_some_and(|data| data.intent() != QrCodeIntent::Login)
        {
            return Err(CommandErr::Denied);
        }
        let client = self.client().await?;

        let slots = Arc::new(QrSlots::default());
        let core = self.clone();
        let flow_slots = slots.clone();
        let task = spawn(async move {
            let oauth = client.oauth();
            let result = if let Some(data) = &scanned_code {
                let grant = oauth.grant_login_with_qr_code().scan(data);
                let _watch = core.watch(true, grant.subscribe_to_progress(), move |update| {
                    grant_view(&flow_slots, update, scanned)
                });
                grant.await
            } else {
                let grant = oauth.grant_login_with_qr_code().generate();
                let _watch = core.watch(true, grant.subscribe_to_progress(), move |update| {
                    grant_view(&flow_slots, update, |state| generated(&flow_slots, state))
                });
                grant.await
            };
            core.emit_qr(
                true,
                match result {
                    Ok(()) => QrLoginProgressView::Done,
                    Err(error) => {
                        tracing::warn!(operation = "qr_grant", "QR grant failed: {error}");
                        QrLoginProgressView::Failed {
                            reason: grant_failure(&error),
                        }
                    }
                },
            );
        })
        .abort_on_drop();

        *self.qr_flow.lock().await = Some(QrFlow { slots, _task: task });
        Ok(())
    }

    pub(crate) async fn qr_check_code(&self, code: u8) -> Result<(), CommandErr> {
        let sender = self
            .qr_slots()
            .await?
            .take_check_code()
            .ok_or(CommandErr::Unavailable)?;
        sender.send(code).await.or_failed(self, "qr_check_code")
    }

    pub(crate) async fn qr_grant_continue(&self, confirm: bool) -> Result<(), CommandErr> {
        let sender = self
            .qr_slots()
            .await?
            .take_continuation()
            .ok_or(CommandErr::Unavailable)?;
        let sent = if confirm {
            sender.confirm().await
        } else {
            sender.cancel().await
        };
        sent.or_failed(self, "qr_grant_continue")
    }

    pub(crate) async fn cancel_qr(&self) {
        self.qr_flow.lock().await.take();
    }

    async fn qr_slots(&self) -> Result<Arc<QrSlots>, CommandErr> {
        self.qr_flow
            .lock()
            .await
            .as_ref()
            .map(|flow| flow.slots.clone())
            .ok_or(CommandErr::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::authentication::oauth::qrcode::{
        Msc4108IntentData, QRCodeGrantLoginError, QRCodeLoginError, QrCodeData,
    };
    use matrix_sdk::encryption::vodozemac::Curve25519PublicKey;
    use url::Url;

    use super::{QrLoginFailureView, grant_failure, login_failure, reciprocating_homeserver};

    fn code(intent: Msc4108IntentData) -> QrCodeData {
        QrCodeData::new_msc4108(
            Curve25519PublicKey::from_bytes([7; 32]),
            Url::parse("https://rendezvous.example.org/abc").unwrap(),
            intent,
        )
    }

    #[test]
    fn a_code_from_a_signed_in_device_names_its_homeserver() {
        let data = code(Msc4108IntentData::Reciprocate {
            server_name: "example.org".to_owned(),
        });

        assert_eq!(
            reciprocating_homeserver(&data).as_deref(),
            Some("example.org")
        );
    }

    #[test]
    fn a_code_from_a_new_device_is_not_one_to_sign_in_with() {
        assert_eq!(
            reciprocating_homeserver(&code(Msc4108IntentData::Login)),
            None
        );
    }

    #[test]
    fn failures_are_explained() {
        assert_eq!(
            login_failure(&QRCodeLoginError::NotFound),
            QrLoginFailureView::Expired
        );
        assert_eq!(
            grant_failure(&QRCodeGrantLoginError::MissingSecretsBackup(None)),
            QrLoginFailureView::NoRecovery
        );
        assert_eq!(
            grant_failure(&QRCodeGrantLoginError::InvalidCheckCode),
            QrLoginFailureView::CheckCode
        );
    }
}
