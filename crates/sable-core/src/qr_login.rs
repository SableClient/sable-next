use crate::api::auth::QrCheckCodeParams;
use crate::api::auth::QrGrantContinueParams;
use crate::api::auth::StartQrGrantParams;
use crate::api::auth::StartQrLoginParams;
use std::sync::Arc;

use crate::tasks::JoinHandleExt;
use futures_util::{FutureExt, Stream, StreamExt, pin_mut};
use matrix_sdk::authentication::oauth::qrcode::{
    CheckCodeSender, ContinuationMessageSender, DeviceAuthorizationOAuthError, GeneratedQrProgress,
    GrantLoginProgress, LoginProgress, Msc4108IntentData, QRCodeGrantLoginError, QRCodeLoginError,
    QrCodeData, QrCodeIntent, QrCodeIntentData, QrProgress, SecureChannelError,
};
use matrix_sdk::executor::spawn;
use matrix_sdk::ruma::api::FeatureFlag;
use url::Url;

use crate::ResultExt;
use crate::protocol::{CoreEvent, QrLoginFailureView, QrLoginProgressView, RpcCode, RpcError};
use crate::session::{self, Credentials, PersistedSession};
use crate::verification::level_h_code;
use crate::{Core, SignedIn, Task};

#[derive(Default)]
pub(crate) struct QrSlots {
    check_code: parking_lot::Mutex<Option<CheckCodeSender>>,
    continuation: parking_lot::Mutex<Option<ContinuationMessageSender>>,
}

impl QrSlots {
    fn set_check_code(&self, sender: CheckCodeSender) {
        *self.check_code.lock() = Some(sender);
    }

    fn set_continuation(&self, sender: ContinuationMessageSender) {
        *self.continuation.lock() = Some(sender);
    }

    fn take_check_code(&self) -> Option<CheckCodeSender> {
        self.check_code.lock().take()
    }

    fn take_continuation(&self) -> Option<ContinuationMessageSender> {
        self.continuation.lock().take()
    }
}

/// Forwards a flow's progress; `drain` makes sure the last updates go out before the flow's final event.
struct Watch {
    _task: Task,
    stop: tokio::sync::oneshot::Sender<()>,
    drained: tokio::sync::oneshot::Receiver<()>,
}

impl Watch {
    async fn drain(self) {
        let _ = self.stop.send(());
        let _ = self.drained.await;
    }
}

pub(crate) struct QrFlow {
    slots: Arc<QrSlots>,
    _task: Task,
}

fn decode(data: &str) -> Result<QrCodeData, RpcError> {
    QrCodeData::from_base64(data).map_err(|_| RpcCode::Denied.into())
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

async fn msc_4388_supported(oauth: &matrix_sdk::authentication::oauth::OAuth) -> bool {
    oauth
        .msc_4388_rendezvous_server_supported()
        .await
        .inspect_err(|error| tracing::debug!("MSC4388 rendezvous discovery failed: {error}"))
        .unwrap_or(false)
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

    fn watch<P, S, V>(self: &Arc<Self>, grant: bool, progress: S, view: V) -> Watch
    where
        P: Send + 'static,
        S: Stream<Item = P> + Send + 'static,
        V: Fn(P) -> QrLoginProgressView + Send + 'static,
    {
        let core = self.clone();
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let (drained_tx, drained) = tokio::sync::oneshot::channel::<()>();
        let task = spawn(async move {
            pin_mut!(progress);
            loop {
                tokio::select! {
                    update = progress.next() => {
                        let Some(update) = update else { break };
                        core.emit_qr(grant, view(update));
                    }
                    _ = &mut stopped => {
                        // The flow ended: forward what it already queued before the final event.
                        while let Some(Some(update)) = progress.next().now_or_never() {
                            core.emit_qr(grant, view(update));
                        }
                        break;
                    }
                }
            }
            let _ = drained_tx.send(());
        })
        .abort_on_drop();
        Watch {
            _task: task,
            stop,
            drained,
        }
    }

    pub(crate) async fn start_qr_login(
        self: &Arc<Self>,
        StartQrLoginParams {
            homeserver,
            redirect_uri,
            scanned: scanned_code,
        }: StartQrLoginParams,
    ) -> Result<(), RpcError> {
        let scanned_code = scanned_code.as_deref().map(decode).transpose()?;
        let homeserver = match &scanned_code {
            Some(data) => reciprocating_homeserver(data).ok_or(RpcCode::Denied)?,
            None => homeserver.ok_or(RpcCode::Denied)?,
        };
        let redirect_uri =
            Url::parse(&redirect_uri).or_failed(self, "start_qr_login_redirect_uri")?;
        let (account_id, store_id) = self.allocate_account().await?;
        let client = self
            .build_account_client(&store_id, &homeserver)
            .await
            .or_failed(self, "start_qr_login_build_client")?;
        self.require_sliding_sync(&client).await?;

        let slots = Arc::new(QrSlots::default());
        let core = self.clone();
        let flow_slots = slots.clone();
        let task = spawn(async move {
            let registration = session::qr_client_metadata(&redirect_uri).into();
            let oauth = client.oauth();
            let builder = oauth.login_with_qr_code(Some(&registration));
            let result = if let Some(data) = &scanned_code {
                let login = builder.scan(data);
                let watch = core.watch(false, login.subscribe_to_progress(), |update| {
                    login_view(update, scanned)
                });
                let result = login.await;
                watch.drain().await;
                result
            } else {
                let mut login = builder.generate();
                if msc_4388_supported(&oauth).await {
                    login.with_msc4388_support();
                }
                let watch = core.watch(false, login.subscribe_to_progress(), move |update| {
                    login_view(update, |state| generated(&flow_slots, state))
                });
                let result = login.await;
                watch.drain().await;
                result
            };
            let outcome = match result {
                Ok(()) => core
                    .finish_qr_login(client, homeserver, redirect_uri, account_id, store_id)
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

        *self.sign_in.qr_flow.lock() = Some(QrFlow { slots, _task: task });
        Ok(())
    }

    async fn finish_qr_login(
        self: &Arc<Self>,
        client: matrix_sdk::Client,
        homeserver: String,
        redirect_uri: Url,
        account_id: String,
        store_id: String,
    ) -> Result<String, RpcError> {
        let full = client
            .oauth()
            .full_session()
            .ok_or_else(|| self.failed("qr_login", "no session after the QR login"))?;
        let user_id = full.user.meta.user_id.to_string();
        let endpoint = client.homeserver();
        self.finish_sign_in(
            client,
            account_id,
            &store_id,
            PersistedSession {
                oauth_issuer: None,
                oauth_redirect_uri: Some(redirect_uri),
                resolved_homeserver: Some(endpoint),
                homeserver,
                credentials: Credentials::oauth(full),
            },
            None,
        )
        .await?;
        Ok(user_id)
    }

    pub(crate) async fn qr_check_code(
        &self,
        QrCheckCodeParams { code }: QrCheckCodeParams,
    ) -> Result<(), RpcError> {
        let sender = self
            .qr_slots()?
            .take_check_code()
            .ok_or(RpcCode::Unavailable)?;
        sender.send(code).await.or_failed(self, "qr_check_code")
    }

    pub(crate) async fn qr_grant_continue(
        &self,
        QrGrantContinueParams { confirm }: QrGrantContinueParams,
    ) -> Result<(), RpcError> {
        let sender = self
            .qr_slots()?
            .take_continuation()
            .ok_or(RpcCode::Unavailable)?;
        let sent = if confirm {
            sender.confirm().await
        } else {
            sender.cancel().await
        };
        sent.or_failed(self, "qr_grant_continue")
    }

    pub(crate) fn cancel_qr(&self) {
        self.sign_in.qr_flow.lock().take();
    }

    fn qr_slots(&self) -> Result<Arc<QrSlots>, RpcError> {
        self.sign_in
            .qr_flow
            .lock()
            .as_ref()
            .map(|flow| flow.slots.clone())
            .ok_or_else(|| RpcCode::Unavailable.into())
    }
}

impl SignedIn {
    pub(crate) fn start_qr_grant(
        &self,
        StartQrGrantParams {
            scanned: scanned_code,
        }: StartQrGrantParams,
    ) -> Result<(), RpcError> {
        let scanned_code = scanned_code.as_deref().map(decode).transpose()?;
        if scanned_code
            .as_ref()
            .is_some_and(|data| data.intent() != QrCodeIntent::Login)
        {
            return Err(RpcCode::Denied.into());
        }
        let client = self.client().clone();

        let slots = Arc::new(QrSlots::default());
        let session = self.clone();
        let core = Arc::clone(self.core());
        let flow_slots = slots.clone();
        // Ends with its session, which it would otherwise keep open.
        let grant = async move {
            let oauth = client.oauth();
            let result = if let Some(data) = &scanned_code {
                let grant = oauth.grant_login_with_qr_code().scan(data);
                let watch = core.watch(true, grant.subscribe_to_progress(), move |update| {
                    grant_view(&flow_slots, update, scanned)
                });
                let result = grant.await;
                watch.drain().await;
                result
            } else {
                let mut grant = oauth.grant_login_with_qr_code().generate();
                if msc_4388_supported(&oauth).await {
                    grant.with_msc4388_support();
                }
                let watch = core.watch(true, grant.subscribe_to_progress(), move |update| {
                    grant_view(&flow_slots, update, |state| generated(&flow_slots, state))
                });
                let result = grant.await;
                watch.drain().await;
                result
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
        };
        let task = spawn(async move {
            session.until_ended(grant).await;
        })
        .abort_on_drop();

        *self.core().sign_in.qr_flow.lock() = Some(QrFlow { slots, _task: task });
        Ok(())
    }

    pub(crate) async fn qr_grant_supported(&self) -> Result<bool, RpcError> {
        let client = self.client();
        let features = client
            .unstable_features()
            .await
            .or_failed(self.core(), "qr_grant_supported")?;
        Ok(features.contains(&FeatureFlag::Msc4108) || msc_4388_supported(&client.oauth()).await)
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::authentication::oauth::qrcode::{
        Msc4108IntentData, QRCodeGrantLoginError, QRCodeLoginError, QrCodeData, QrCodeIntent,
    };
    use matrix_sdk::encryption::vodozemac::Curve25519PublicKey;
    use url::Url;

    use super::{QrLoginFailureView, grant_failure, login_failure, reciprocating_homeserver};

    #[tokio::test]
    async fn queued_progress_is_forwarded_before_the_watch_finishes() {
        use crate::Core;
        use futures_util::StreamExt as _;

        use crate::protocol::{CoreEvent, QrLoginProgressView};
        use crate::store::MemorySessionStore;

        let (core, mut events) = Core::new("test", Box::new(MemorySessionStore::default()));
        // Two updates are ready and the stream then stays open, as a live flow's does.
        let progress = futures_util::stream::iter([1u8, 2]).chain(futures_util::stream::pending());
        let watch = core.watch(false, progress, |_| QrLoginProgressView::Done);

        watch.drain().await;

        let mut forwarded = 0;
        while let Ok(event) = events.try_recv() {
            if matches!(event, CoreEvent::QrLogin { .. }) {
                forwarded += 1;
            }
        }
        assert_eq!(forwarded, 2);
    }

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
    fn a_2025_code_from_a_signed_in_device_names_its_homeserver() {
        let data = QrCodeData::new_msc4388(
            Curve25519PublicKey::from_bytes([7; 32]),
            "session".to_owned(),
            Url::parse("https://example.org/").unwrap(),
            QrCodeIntent::Reciprocate,
        )
        .unwrap();
        assert_eq!(
            reciprocating_homeserver(&data).as_deref(),
            Some("https://example.org/")
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
