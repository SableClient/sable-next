use std::sync::{Arc, atomic::Ordering};
use std::time::Duration;

use base64::Engine;
use futures_util::StreamExt;
use matrix_sdk::EncryptionState;
use matrix_sdk::encryption::recovery::{IdentityResetHandle, RecoveryError};
use matrix_sdk::encryption::verification::{
    QrVerification, QrVerificationData, QrVerificationState, SasState, SasVerification,
    VerificationRequest, VerificationRequestState,
};
use matrix_sdk::encryption::{
    CrossSigningResetAuthType, VerificationState, recovery::RecoveryState,
};
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::api::client::uiaa::{AuthData, AuthType, OAuth, Password, UserIdentifier};
use matrix_sdk::ruma::events::GlobalAccountDataEventType;
use matrix_sdk::ruma::events::key::verification::VerificationMethod;
use matrix_sdk::ruma::events::key::verification::request::ToDeviceKeyVerificationRequestEvent;
use matrix_sdk::ruma::events::room::message::{MessageType, OriginalSyncRoomMessageEvent};
use matrix_sdk::ruma::events::secret_storage::default_key::SecretStorageDefaultKeyEventContent;
use matrix_sdk::ruma::{OwnedUserId, UserId};
use qrcode::bits::Bits;
use qrcode::{Color, EcLevel, QrCode, Version};

use crate::protocol::{
    CommandErr, CoreEvent, DeviceView, EmojiView, EncryptionStatusView, IdentityResetStep,
    QrCodeView, RecoveryStateView, SignOutSafetyView, VerificationStateView, VerificationView,
};

use crate::Core;

const BACKUP_SETTLE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) struct PendingIdentityReset {
    generation: u64,
    handle: Arc<IdentityResetHandle>,
}

impl Core {
    pub(crate) async fn reset_identity(&self) -> Result<IdentityResetStep, CommandErr> {
        let client = self.client().await?;
        let generation = self.session_generation.load(Ordering::SeqCst);
        self.cancel_identity_reset().await;

        let Some(handle) = client
            .encryption()
            .recovery()
            .reset_identity()
            .await
            .map_err(|error| self.failed("reset_identity", error))?
        else {
            return Ok(IdentityResetStep::Done {
                recovery_key: self.enable_reset_recovery(&client).await?,
            });
        };

        let step = match handle.auth_type() {
            CrossSigningResetAuthType::OAuth(info) => IdentityResetStep::Approve {
                url: info.approval_url.to_string(),
            },
            CrossSigningResetAuthType::Uiaa(uiaa) => {
                if !uiaa
                    .flows
                    .iter()
                    .any(|flow| flow.stages == [AuthType::Password])
                {
                    let stages = uiaa
                        .flows
                        .iter()
                        .flat_map(|flow| &flow.stages)
                        .map(|stage| stage.as_str().to_owned())
                        .collect();
                    return Err(CommandErr::InteractiveAuthRequired { stages });
                }
                IdentityResetStep::Password
            }
        };

        #[allow(clippy::arc_with_non_send_sync)]
        let handle = Arc::new(handle);
        *self.pending_identity_reset.lock().await =
            Some(PendingIdentityReset { generation, handle });
        Ok(step)
    }

    pub(crate) async fn continue_identity_reset(
        &self,
        password: Option<String>,
    ) -> Result<String, CommandErr> {
        let client = self.client().await?;
        let generation = self.session_generation.load(Ordering::SeqCst);
        let handle = match &*self.pending_identity_reset.lock().await {
            Some(pending) if pending.generation == generation => pending.handle.clone(),
            _ => return Err(CommandErr::Unavailable),
        };

        let auth = match (handle.auth_type(), password) {
            (CrossSigningResetAuthType::OAuth(info), _) => {
                let mut oauth = OAuth::new();
                oauth.session.clone_from(&info.session);
                Some(AuthData::OAuth(oauth))
            }
            (CrossSigningResetAuthType::Uiaa(uiaa), Some(password)) => {
                let user_id = client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned();
                let mut auth = Password::new(UserIdentifier::Matrix(user_id.into()), password);
                auth.session.clone_from(&uiaa.session);
                Some(AuthData::Password(auth))
            }
            (CrossSigningResetAuthType::Uiaa(_), None) => {
                return Err(CommandErr::InteractiveAuthRequired {
                    stages: vec![AuthType::Password.as_str().to_owned()],
                });
            }
        };

        handle.reset(auth).await.map_err(|error| match &error {
            RecoveryError::Sdk(sdk) if sdk.as_uiaa_response().is_some() => CommandErr::Denied,
            _ => self.failed("reset_identity: auth", error),
        })?;

        {
            let mut pending = self.pending_identity_reset.lock().await;
            if !pending
                .as_ref()
                .is_some_and(|pending| Arc::ptr_eq(&pending.handle, &handle))
            {
                return Err(CommandErr::Unavailable);
            }
            pending.take();
        }

        self.enable_reset_recovery(&client).await
    }

    pub(crate) async fn cancel_identity_reset(&self) {
        let pending = self.pending_identity_reset.lock().await.take();
        if let Some(pending) = pending {
            pending.handle.cancel().await;
        }
    }

    async fn enable_reset_recovery(
        &self,
        client: &matrix_sdk::Client,
    ) -> Result<String, CommandErr> {
        client
            .encryption()
            .recovery()
            .enable()
            .await
            .map_err(|error| self.failed("reset_identity: enable_recovery", error))
    }

    /// Self-verification travels to-device, verifying someone else as a DM
    /// message, so both need a handler or one direction never prompts.
    pub(crate) fn watch_incoming_verifications(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let handle = client.add_event_handler({
            let core = self.clone();
            move |event: ToDeviceKeyVerificationRequestEvent, client: matrix_sdk::Client| {
                let core = core.clone();

                async move {
                    let request = client
                        .encryption()
                        .get_verification_request(
                            &event.sender,
                            event.content.transaction_id.as_str(),
                        )
                        .await;

                    tracing::info!(
                        operation = "verification",
                        request_available = request.is_some(),
                        "received to-device verification request"
                    );

                    if let Some(request) = request {
                        core.watch_verification(request);
                    }
                }
            }
        });
        self.track_session_handler(client, handle);

        let handle = client.add_event_handler({
            let core = self.clone();
            move |event: OriginalSyncRoomMessageEvent, client: matrix_sdk::Client| {
                let core = core.clone();

                async move {
                    if !matches!(event.content.msgtype, MessageType::VerificationRequest(_)) {
                        return;
                    }

                    if let Some(request) = client
                        .encryption()
                        .get_verification_request(&event.sender, event.event_id.as_str())
                        .await
                    {
                        core.watch_verification(request);
                    }
                }
            }
        });
        self.track_session_handler(client, handle);
    }

    /// The request and the SAS it becomes are two objects with two state enums.
    /// Both funnel into one event stream keyed by the flow id.
    pub(crate) fn watch_verification(self: &Arc<Self>, request: VerificationRequest) {
        let core = self.clone();
        let task = spawn(async move {
            let user_id = request.other_user_id().to_owned();
            let flow_id = request.flow_id().to_owned();

            let mut changes = request.changes();
            core.emit_verification(&user_id, &flow_id, request_view(&request, &request.state()));

            while let Some(state) = changes.next().await {
                match state {
                    VerificationRequestState::Ready {
                        their_methods,
                        our_methods,
                        ..
                    } => {
                        let can_scan = their_methods.contains(&VerificationMethod::QrCodeShowV1)
                            && our_methods.contains(&VerificationMethod::QrCodeScanV1);
                        let can_compare = their_methods.contains(&VerificationMethod::SasV1)
                            && our_methods.contains(&VerificationMethod::SasV1);
                        let qr = match request.generate_qr_code().await {
                            Ok(qr) => qr,
                            Err(error) => {
                                core.failed("verification: generate_qr_code", error);
                                None
                            }
                        };

                        if qr.is_none() && !can_scan {
                            if request.we_started()
                                && let Err(error) = request.start_sas().await
                            {
                                core.failed("verification: start_sas", error);
                            }

                            core.emit_verification(&user_id, &flow_id, VerificationView::Waiting);
                            continue;
                        }

                        let shown = qr.as_ref().and_then(qr_code_view);
                        if let Some(qr) = qr {
                            core.watch_qr(user_id.clone(), flow_id.clone(), qr);
                        }
                        core.emit_verification(
                            &user_id,
                            &flow_id,
                            VerificationView::Choose {
                                qr: shown,
                                can_scan,
                                can_compare,
                            },
                        );
                    }

                    VerificationRequestState::Transitioned { verification, .. } => {
                        if let Some(sas) = verification.sas() {
                            core.watch_sas(user_id.clone(), flow_id.clone(), sas);
                            break;
                        }
                    }

                    other => {
                        let view = request_view(&request, &other);
                        let done = matches!(
                            view,
                            VerificationView::Done | VerificationView::Cancelled { .. }
                        );
                        core.emit_verification(&user_id, &flow_id, view);

                        if done {
                            break;
                        }
                    }
                }
            }
        })
        .abort_on_drop();
        self.track_session_task(task);
    }

    fn watch_sas(self: &Arc<Self>, user_id: OwnedUserId, flow_id: String, sas: SasVerification) {
        let core = self.clone();
        let task = spawn(async move {
            let mut changes = sas.changes();
            core.emit_verification(&user_id, &flow_id, sas_view(&sas, &sas.state()));

            if !sas.we_started()
                && let Err(error) = sas.accept().await
            {
                core.failed("verification: accept_sas", error);
            }

            while let Some(state) = changes.next().await {
                let view = sas_view(&sas, &state);
                let done = matches!(
                    view,
                    VerificationView::Done | VerificationView::Cancelled { .. }
                );
                core.emit_verification(&user_id, &flow_id, view);

                if done {
                    break;
                }
            }
        })
        .abort_on_drop();
        self.track_session_task(task);
    }

    pub(crate) fn watch_qr(
        self: &Arc<Self>,
        user_id: OwnedUserId,
        flow_id: String,
        qr: QrVerification,
    ) {
        let core = self.clone();
        let task = spawn(async move {
            let mut changes = qr.changes();

            while let Some(state) = changes.next().await {
                let view = match state {
                    QrVerificationState::Started => continue,
                    QrVerificationState::Scanned => VerificationView::Scanned,
                    QrVerificationState::Confirmed | QrVerificationState::Reciprocated => {
                        VerificationView::Confirmed
                    }
                    QrVerificationState::Done { .. } => VerificationView::Done,
                    QrVerificationState::Cancelled(info) => VerificationView::Cancelled {
                        reason: info.reason().to_owned(),
                    },
                };
                let done = matches!(
                    view,
                    VerificationView::Done | VerificationView::Cancelled { .. }
                );
                core.emit_verification(&user_id, &flow_id, view);

                if done {
                    break;
                }
            }
        })
        .abort_on_drop();
        self.track_session_task(task);
    }

    fn emit_verification(&self, user_id: &UserId, flow_id: &str, state: VerificationView) {
        tracing::info!(
            operation = "verification",
            phase = verification_phase(&state),
            "verification state changed"
        );
        self.emit(CoreEvent::Verification {
            user_id: user_id.to_owned(),
            flow_id: flow_id.to_owned(),
            state,
        });
    }

    pub(crate) async fn verification_request(
        &self,
        user_id: &UserId,
        flow_id: &str,
    ) -> Result<VerificationRequest, CommandErr> {
        self.client()
            .await?
            .encryption()
            .get_verification_request(user_id, flow_id)
            .await
            .ok_or(CommandErr::UnknownVerification)
    }

    pub(crate) async fn scan_verification_qr(
        self: &Arc<Self>,
        user_id: OwnedUserId,
        flow_id: String,
        data: &str,
    ) -> Result<(), CommandErr> {
        let data = base64::engine::general_purpose::STANDARD
            .decode(data)
            .ok()
            .and_then(|bytes| QrVerificationData::from_bytes(bytes).ok())
            .ok_or(CommandErr::InvalidVerificationCode)?;
        let qr = self
            .verification_request(&user_id, &flow_id)
            .await?
            .scan_qr_code(data)
            .await
            .map_err(|error| self.failed("scan_verification_qr", error))?
            .ok_or(CommandErr::Unavailable)?;
        self.watch_qr(user_id, flow_id, qr);
        Ok(())
    }

    pub(crate) async fn qr(
        &self,
        user_id: &UserId,
        flow_id: &str,
    ) -> Result<QrVerification, CommandErr> {
        self.client()
            .await?
            .encryption()
            .get_verification(user_id, flow_id)
            .await
            .and_then(matrix_sdk::encryption::verification::Verification::qr)
            .ok_or(CommandErr::UnknownVerification)
    }

    pub(crate) async fn sas(
        &self,
        user_id: &UserId,
        flow_id: &str,
    ) -> Result<SasVerification, CommandErr> {
        self.client()
            .await?
            .encryption()
            .get_verification(user_id, flow_id)
            .await
            .and_then(matrix_sdk::encryption::verification::Verification::sas)
            .ok_or(CommandErr::UnknownVerification)
    }
}

fn request_view(
    request: &VerificationRequest,
    state: &VerificationRequestState,
) -> VerificationView {
    match state {
        VerificationRequestState::Created { .. } => VerificationView::Requested {
            is_self: request.is_self_verification(),
            initiated_by_us: true,
        },
        VerificationRequestState::Requested { .. } => VerificationView::Requested {
            is_self: request.is_self_verification(),
            initiated_by_us: false,
        },
        VerificationRequestState::Done => VerificationView::Done,
        VerificationRequestState::Cancelled(info) => VerificationView::Cancelled {
            reason: info.reason().to_owned(),
        },
        _ => VerificationView::Waiting,
    }
}

fn sas_view(sas: &SasVerification, state: &SasState) -> VerificationView {
    match state {
        // From the SAS itself, so a flow joined mid-way still reports emoji.
        SasState::KeysExchanged { decimals, .. } => VerificationView::Compare {
            emojis: sas
                .emoji()
                .map(|emoji| {
                    emoji
                        .iter()
                        .map(|emoji| EmojiView {
                            symbol: emoji.symbol.to_owned(),
                            description: emoji.description.to_owned(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            decimals: *decimals,
        },
        SasState::Confirmed => VerificationView::Confirmed,
        SasState::Done { .. } => VerificationView::Done,
        SasState::Cancelled(info) => VerificationView::Cancelled {
            reason: info.reason().to_owned(),
        },
        _ => VerificationView::Waiting,
    }
}

fn qr_code_view(qr: &QrVerification) -> Option<QrCodeView> {
    level_h_code(&qr.to_bytes().ok()?)
}

fn level_h_code(data: &[u8]) -> Option<QrCodeView> {
    let code = (7..=40).find_map(|version| {
        let mut bits = Bits::new(Version::Normal(version));
        bits.push_byte_data(data).ok()?;
        bits.push_terminator(EcLevel::H).ok()?;
        QrCode::with_bits(bits, EcLevel::H).ok()
    })?;
    Some(QrCodeView {
        width: u32::try_from(code.width()).ok()?,
        modules: code
            .to_colors()
            .into_iter()
            .map(|color| if color == Color::Dark { '1' } else { '0' })
            .collect(),
    })
}

const fn verification_phase(state: &VerificationView) -> &'static str {
    match state {
        VerificationView::Requested { .. } => "requested",
        VerificationView::Waiting => "waiting",
        VerificationView::Choose { .. } => "choose",
        VerificationView::Scanned => "scanned",
        VerificationView::Compare { .. } => "compare",
        VerificationView::Confirmed => "confirmed",
        VerificationView::Done => "done",
        VerificationView::Cancelled { .. } => "cancelled",
    }
}

pub(crate) async fn own_devices(client: &matrix_sdk::Client) -> Vec<DeviceView> {
    let Some(user_id) = client.user_id() else {
        return Vec::new();
    };
    let own_device_id = client.device_id();
    let encryption = client.encryption().get_user_devices(user_id).await.ok();
    let mut views: Vec<DeviceView> = match client.devices().await {
        Ok(response) => response
            .devices
            .into_iter()
            .map(|device| {
                let crypto = encryption
                    .as_ref()
                    .and_then(|devices| devices.get(&device.device_id));
                DeviceView {
                    is_own: Some(device.device_id.as_ref()) == own_device_id,
                    is_verified: crypto
                        .as_ref()
                        .is_some_and(matrix_sdk::encryption::identities::Device::is_verified),
                    display_name: device.display_name,
                    device_id: device.device_id,
                    last_seen_ts: device.last_seen_ts.map(|ts| u64::from(ts.get())),
                    last_seen_ip: device.last_seen_ip,
                }
            })
            .collect(),
        Err(error) => {
            tracing::warn!(%error, "could not refresh devices; using the crypto store");
            encryption
                .map(|devices| {
                    devices
                        .devices()
                        .map(|device| DeviceView {
                            is_own: Some(device.device_id()) == own_device_id,
                            is_verified: device.is_verified(),
                            display_name: device.display_name().map(str::to_owned),
                            device_id: device.device_id().to_owned(),
                            last_seen_ts: None,
                            last_seen_ip: None,
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
    };

    views.sort_by(|a, b| {
        b.is_own
            .cmp(&a.is_own)
            .then(b.last_seen_ts.cmp(&a.last_seen_ts))
            .then(a.device_id.cmp(&b.device_id))
    });
    views
}

pub(crate) async fn encryption_status(client: &matrix_sdk::Client) -> EncryptionStatusView {
    let encryption = client.encryption();

    EncryptionStatusView {
        verification: match encryption.verification_state().get() {
            VerificationState::Verified => VerificationStateView::Verified,
            VerificationState::Unverified => VerificationStateView::Unverified,
            VerificationState::Unknown => VerificationStateView::Unknown,
        },
        recovery: match encryption.recovery().state() {
            RecoveryState::Enabled => RecoveryStateView::Enabled,
            RecoveryState::Disabled => RecoveryStateView::Disabled,
            RecoveryState::Incomplete => RecoveryStateView::Incomplete,
            RecoveryState::Unknown => RecoveryStateView::Unknown,
        },
        // A partial set cannot sign another device, so it does not count.
        cross_signing_ready: encryption
            .cross_signing_status()
            .await
            .is_some_and(|status| status.is_complete()),
        recovery_passphrase: recovery_passphrase(client).await,
    }
}

pub(crate) async fn sign_out_safety(client: &matrix_sdk::Client) -> SignOutSafetyView {
    let encryption = client.encryption();
    let backups = encryption.backups();
    let backup_uploaded = tokio::select! {
        uploaded = async {
            encryption.wait_for_e2ee_initialization_tasks().await;
            backups.are_enabled().await && backups.wait_for_steady_state().await.is_ok()
        } => uploaded,
        () = matrix_sdk::sleep::sleep(BACKUP_SETTLE_TIMEOUT) => false,
    };

    SignOutSafetyView {
        encryption: encryption_status(client).await,
        backup_enabled: backups.are_enabled().await,
        backup_uploaded,
        has_encrypted_rooms: client
            .joined_rooms()
            .iter()
            .any(|room| !matches!(room.encryption_state(), EncryptionState::NotEncrypted)),
    }
}

async fn recovery_passphrase(client: &matrix_sdk::Client) -> bool {
    let account = client.account();
    let Ok(Some(default_key)) = account
        .account_data::<SecretStorageDefaultKeyEventContent>()
        .await
    else {
        return false;
    };
    let Ok(default_key) = default_key.deserialize() else {
        return false;
    };
    let Ok(Some(key)) = account
        .account_data_raw(GlobalAccountDataEventType::SecretStorageKey(
            default_key.key_id,
        ))
        .await
    else {
        return false;
    };
    key.get_field::<serde_json::Value>("passphrase")
        .is_ok_and(|passphrase| passphrase.is_some_and(|value| !value.is_null()))
}

#[cfg(test)]
mod tests {
    use qrcode::{EcLevel, Version};

    use super::level_h_code;

    fn payload() -> Vec<u8> {
        let mut data = b"MATRIX\x02\x01".to_vec();
        let flow_id = b"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
        data.extend_from_slice(&u16::try_from(flow_id.len()).unwrap().to_be_bytes());
        data.extend_from_slice(flow_id);
        data.extend((0..64).map(|byte: u8| byte.wrapping_mul(37)));
        data.extend((0..16).map(|byte: u8| byte.wrapping_mul(91)));
        data
    }

    #[test]
    fn a_verification_code_is_drawn_at_the_highest_correction_level() {
        let view = level_h_code(&payload()).unwrap();
        let width = usize::try_from(view.width).unwrap();

        assert_eq!(view.modules.len(), width * width);
        assert!(
            view.modules
                .chars()
                .all(|module| module == '0' || module == '1')
        );
        let smallest = (7..=40)
            .map(Version::Normal)
            .find(|version| {
                let mut bits = qrcode::bits::Bits::new(*version);
                bits.push_byte_data(&payload()).is_ok() && bits.push_terminator(EcLevel::H).is_ok()
            })
            .unwrap();
        assert_eq!(width, usize::try_from(smallest.width()).unwrap());
    }

    #[test]
    #[ignore = "writes the fixture the web decoder test reads"]
    fn write_the_web_fixture() {
        let view = level_h_code(&payload()).unwrap();
        let fixture = serde_json::json!({
            "payload": payload(),
            "code": { "width": view.width, "modules": view.modules },
        });
        std::fs::write(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../src/lib/features/settings/verification-qr.fixture.json"
            ),
            serde_json::to_string(&fixture).unwrap(),
        )
        .unwrap();
    }
}
