use std::sync::Arc;

use matrix_sdk::encryption::recovery::RecoveryError;
use matrix_sdk::ruma::events::room::history_visibility::HistoryVisibility;
use matrix_sdk::ruma::{OwnedDeviceId, OwnedRoomId, OwnedUserId};
use serde::{Deserialize, Serialize};

use super::Handler;
use crate::protocol::{RpcCode, RpcError, DehydratedDeviceView, DeviceView, EncryptionStatusView, IdentityResetStep, KeyBackupDownloadView, KeyBackupStatusView, ShareHistoryView, SignOutSafetyView, UserSecurityView};
use crate::verification::{self, VERIFICATION_METHODS, encryption_status, sign_out_safety};
use crate::{Core, ResultExt};

domain! {
    status,
    key_backup_status,
    download_key_backup,
    sign_out_safety,
    devices,
    user_security,
    recover_identity,
    enable_recovery,
    reset_recovery_key,
    reset_identity,
    continue_identity_reset,
    cancel_identity_reset,
    export_room_keys,
    import_room_keys,
    delete_device,
    rename_device,
    discard_room_key,
    share_history,
    dehydrated_device,
    set_dehydrated_device,
    request_verification,
    withdraw_verification,
    set_device_blocked,
    accept_verification,
    scan_verification_qr,
    start_sas_verification,
    confirm_verification,
    cancel_verification,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct StatusParams {}

impl Handler for StatusParams {
    type Ok = EncryptionStatusView;

    async fn run(self, core: &Arc<Core>) -> Result<EncryptionStatusView, RpcError> {
        let client = core.client().await?;
        Ok(core.with_open_stores(async || encryption_status(&client).await).await)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct KeyBackupStatusParams {}

impl Handler for KeyBackupStatusParams {
    type Ok = KeyBackupStatusView;

    async fn run(self, core: &Arc<Core>) -> Result<KeyBackupStatusView, RpcError> {
        core.key_backup_status().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DownloadKeyBackupParams {
    pub request_id: String,
}

impl Handler for DownloadKeyBackupParams {
    type Ok = KeyBackupDownloadView;

    async fn run(self, core: &Arc<Core>) -> Result<KeyBackupDownloadView, RpcError> {
        core.download_key_backup(self.request_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SignOutSafetyParams {}

impl Handler for SignOutSafetyParams {
    type Ok = SignOutSafetyView;

    async fn run(self, core: &Arc<Core>) -> Result<SignOutSafetyView, RpcError> {
        Ok(sign_out_safety(core, &core.client().await?).await)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DevicesParams {}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DevicesOk {
    pub devices: Vec<DeviceView>,
}

impl Handler for DevicesParams {
    type Ok = DevicesOk;

    async fn run(self, core: &Arc<Core>) -> Result<DevicesOk, RpcError> {
        let client = core.client().await?;

        Ok(DevicesOk {
            devices: verification::own_devices(&client).await,
        })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UserSecurityParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl Handler for UserSecurityParams {
    type Ok = UserSecurityView;

    async fn run(self, core: &Arc<Core>) -> Result<UserSecurityView, RpcError> {
        verification::user_security(core, &self.user_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RecoverIdentityParams {
    pub recovery_key: String,
}

impl Handler for RecoverIdentityParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let client = core.client().await?;
        client
            .encryption()
            .recovery()
            .recover_and_fix_backup(&self.recovery_key)
            .await
            .map_err(|error| core.recovery_error(&error))?;
        core.adopt_account_data_key(&client, &self.recovery_key)
            .await;
        Ok(())
    }
}

/// First-time cross-signing and key backup. Without it a lone session can
/// never verify a second. The returned key is unrecoverable, so a UI must
/// make the user store it.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EnableRecoveryParams {
    /// A passphrase to unlock the key with. The key is returned either way.
    #[serde(default)]
    pub passphrase: Option<String>,
    /// Deletes the unreadable server backup and the history it holds.
    #[serde(default)]
    pub replace_backup: bool,
}

impl Handler for EnableRecoveryParams {
    /// Unrecoverable once discarded.
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        let client = core.client().await?;
        let backups = client.encryption().backups();
        if self.replace_backup && !backups.are_enabled().await {
            backups
                .disable_and_delete()
                .await
                .or_failed(core, "replace_backup")?;
        }
        let recovery = client.encryption().recovery();
        let enable = recovery.enable();

        let recovery_key = match &self.passphrase {
            Some(passphrase) => enable.with_passphrase(passphrase).await,
            None => enable.await,
        }
        .map_err(|error| match error {
            RecoveryError::BackupExistsOnServer => RpcCode::BackupExists.into(),
            error => core.failed_with("enable_recovery", &error),
        })?;
        core.adopt_account_data_key(&client, &recovery_key).await;
        Ok(recovery_key)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ResetRecoveryKeyParams {
    #[serde(default)]
    pub passphrase: Option<String>,
}

impl Handler for ResetRecoveryKeyParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        let client = core.client().await?;
        let recovery = client.encryption().recovery();
        let reset = recovery.reset_key();

        let recovery_key = match &self.passphrase {
            Some(passphrase) => reset.with_passphrase(passphrase).await,
            None => reset.await,
        }
        .or_failed(core, "reset_recovery_key")?;
        core.adopt_account_data_key(&client, &recovery_key).await;
        Ok(recovery_key)
    }
}

/// Destructive from the first call: the key backup and secret storage are
/// gone before the server is asked for authentication.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ResetIdentityParams {}

impl Handler for ResetIdentityParams {
    type Ok = IdentityResetStep;

    async fn run(self, core: &Arc<Core>) -> Result<IdentityResetStep, RpcError> {
        core.reset_identity().await
    }
}

/// OAuth polls for the approval for up to two minutes.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ContinueIdentityResetParams {
    #[serde(default)]
    pub password: Option<String>,
}

impl Handler for ContinueIdentityResetParams {
    /// The new recovery key.
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.continue_identity_reset(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CancelIdentityResetParams {}

impl Handler for CancelIdentityResetParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.cancel_identity_reset().await;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ExportRoomKeysParams {
    pub passphrase: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub room_id: Option<OwnedRoomId>,
}

impl Handler for ExportRoomKeysParams {
    /// The passphrase-encrypted export file.
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.export_room_keys(&self.passphrase, self.room_id.as_deref())
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ImportRoomKeysParams {
    pub export: String,
    pub passphrase: String,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ImportRoomKeysOk {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub imported: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub total: u64,
}

impl Handler for ImportRoomKeysParams {
    type Ok = ImportRoomKeysOk;

    async fn run(self, core: &Arc<Core>) -> Result<ImportRoomKeysOk, RpcError> {
        core.import_room_keys(&self.export, &self.passphrase).await
    }
}

/// Call without a password first: the server states its terms in an
/// `interactive_auth_required` error, and only then is there a prompt.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DeleteDeviceParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub device_id: OwnedDeviceId,
    #[serde(default)]
    pub password: Option<String>,
}

impl Handler for DeleteDeviceParams {
    /// Under OAuth, the account page that deletes the device.
    type Ok = Option<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<String>, RpcError> {
        core.delete_device(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RenameDeviceParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub device_id: OwnedDeviceId,
    pub display_name: String,
}

impl Handler for RenameDeviceParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let client = core.client().await?;
        let generation = core.lifecycle.current();
        client
            .rename_device(&self.device_id, &self.display_name)
            .await
            .or_failed(core, "rename_device")?;
        core.emit_devices(generation, &client).await;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DiscardRoomKeyParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for DiscardRoomKeyParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.room(&self.room_id)
            .await?
            .discard_room_key()
            .await
            .or_failed(core, "discard_room_key")?;
        Ok(())
    }
}

/// MSC4268: the invitee only accepts the keys from the sender shortly after
/// joining, so this is for someone who just did.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ShareHistoryParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl Handler for ShareHistoryParams {
    type Ok = ShareHistoryView;

    async fn run(self, core: &Arc<Core>) -> Result<ShareHistoryView, RpcError> {
        let room = core.room(&self.room_id).await?;
        if !room.encryption_state().is_encrypted() {
            return Ok(ShareHistoryView::Unencrypted);
        }
        let client = core.client().await?;
        let own = client.user_id().ok_or(RpcCode::NotLoggedIn)?;
        let identity = client
            .encryption()
            .get_user_identity(own)
            .await
            .or_failed(core, "share_history")?;
        if identity.is_none() {
            return Ok(ShareHistoryView::NoCrossSigning);
        }
        if matches!(
            room.history_visibility_or_default(),
            HistoryVisibility::Joined | HistoryVisibility::Invited
        ) {
            return Ok(ShareHistoryView::HistoryNotShared);
        }
        room.share_history_with(&self.user_id)
            .await
            .or_failed(core, "share_history")?;
        Ok(ShareHistoryView::Shared)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DehydratedDeviceParams {}

impl Handler for DehydratedDeviceParams {
    type Ok = DehydratedDeviceView;

    async fn run(self, core: &Arc<Core>) -> Result<DehydratedDeviceView, RpcError> {
        core.dehydrated_device().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetDehydratedDeviceParams {
    pub enabled: bool,
}

impl Handler for SetDehydratedDeviceParams {
    type Ok = DehydratedDeviceView;

    async fn run(self, core: &Arc<Core>) -> Result<DehydratedDeviceView, RpcError> {
        core.set_dehydrated_device(self.enabled).await
    }
}

/// Our own user id self-verifies another session. Progress arrives as
/// `CoreEvent::Verification`.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RequestVerificationParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub device_id: Option<OwnedDeviceId>,
}

impl Handler for RequestVerificationParams {
    /// The flow id, carried by every later call and event for this
    /// verification.
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        let encryption = core.client().await?.encryption();
        let request = match self.device_id {
            Some(device_id) => encryption
                .get_device(&self.user_id, &device_id)
                .await
                .or_failed(core, "request_verification_device")?
                .ok_or(RpcCode::Unavailable)?
                .request_verification_with_methods(VERIFICATION_METHODS.to_vec())
                .await
                .or_failed(core, "request_verification")?,
            None => encryption
                .get_user_identity(&self.user_id)
                .await
                .or_failed(core, "request_verification_identity")?
                .ok_or(RpcCode::Unavailable)?
                .request_verification_with_methods(VERIFICATION_METHODS.to_vec())
                .await
                .or_failed(core, "request_verification")?,
        };

        if request.is_cancelled() {
            return Err(core.failed(
                "request_verification",
                "cancelled on creation by another ongoing request",
            ));
        }

        let flow_id = request.flow_id().to_owned();
        core.watch_verification(request);
        Ok(flow_id)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct WithdrawVerificationParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl Handler for WithdrawVerificationParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.client()
            .await?
            .encryption()
            .get_user_identity(&self.user_id)
            .await
            .or_failed(core, "withdraw_verification_identity")?
            .ok_or(RpcCode::Unavailable)?
            .withdraw_verification()
            .await
            .or_failed(core, "withdraw_verification")?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetDeviceBlockedParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub device_id: OwnedDeviceId,
    pub blocked: bool,
}

impl Handler for SetDeviceBlockedParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        verification::set_device_blocked(core, &self.user_id, &self.device_id, self.blocked).await
    }
}

/// Also transitions into SAS, so the emoji need no further round trip.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AcceptVerificationParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub flow_id: String,
}

impl Handler for AcceptVerificationParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.verification_request(&self.user_id, &self.flow_id)
            .await?
            .accept_with_methods(VERIFICATION_METHODS.to_vec())
            .await
            .or_failed(core, "accept_verification")?;
        Ok(())
    }
}

/// The bytes read from the other device's code, base64 encoded.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ScanVerificationQrParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub flow_id: String,
    pub data: String,
}

impl Handler for ScanVerificationQrParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.scan_verification_qr(self.user_id, self.flow_id, &self.data)
            .await
    }
}

/// Leaves the codes for emoji.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct StartSasVerificationParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub flow_id: String,
}

impl Handler for StartSasVerificationParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.verification_request(&self.user_id, &self.flow_id)
            .await?
            .start_sas()
            .await
            .or_failed(core, "start_sas_verification")?
            .ok_or(RpcCode::Unavailable)?;
        Ok(())
    }
}

/// The emoji matched, or the other device showed that it scanned our code.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ConfirmVerificationParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub flow_id: String,
}

impl Handler for ConfirmVerificationParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        match core.sas(&self.user_id, &self.flow_id).await {
            Ok(sas) => sas.confirm().await,
            Err(_) => core.qr(&self.user_id, &self.flow_id).await?.confirm().await,
        }
        .or_failed(core, "confirm_verification")?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CancelVerificationParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub flow_id: String,
    /// The emoji differed. An attack signal the other side must be told
    /// about. A plain cancel is not.
    pub mismatch: bool,
}

impl Handler for CancelVerificationParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let (user_id, flow_id) = (&self.user_id, &self.flow_id);
        // No SAS to report a mismatch on before the emoji show.
        match core.sas(user_id, flow_id).await {
            Ok(sas) if self.mismatch => sas
                .mismatch()
                .await
                .or_failed(core, "cancel_verification_mismatch")?,
            Ok(sas) => sas
                .cancel()
                .await
                .or_failed(core, "cancel_verification_sas")?,
            Err(_) if let Ok(qr) = core.qr(user_id, flow_id).await => {
                qr.cancel()
                    .await
                    .or_failed(core, "cancel_verification_qr")?;
            }
            Err(_) => core
                .verification_request(user_id, flow_id)
                .await?
                .cancel()
                .await
                .or_failed(core, "cancel_verification")?,
        }
        Ok(())
    }
}
