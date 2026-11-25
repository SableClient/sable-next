
use matrix_sdk::encryption::recovery::RecoveryError;
use matrix_sdk::ruma::events::room::history_visibility::HistoryVisibility;
use matrix_sdk::ruma::events::SyncStateEvent;
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::{OwnedDeviceId, OwnedRoomId, OwnedUserId, UserId};
use matrix_sdk_base::deserialized_responses::MemberEvent;
use matrix_sdk_base::crypto::olm::InboundGroupSession;
use serde::{Deserialize, Serialize};

use super::SessionHandler;
use crate::key_backup::ReadableBackup;
use crate::protocol::{RpcCode, RpcError, DehydratedDeviceView, DeviceView, EncryptionStatusView, IdentityResetStep, KeyBackupDownloadView, KeyBackupStatusView, ShareHistoryView, SignOutSafetyView, UserSecurityView};
use crate::verification::{self, VERIFICATION_METHODS, encryption_status, sign_out_safety};
use crate::{ResultExt, SignedIn};

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

impl SessionHandler for StatusParams {
    type Ok = EncryptionStatusView;

    async fn run(self, session: &SignedIn) -> Result<EncryptionStatusView, RpcError> {
        let client = session.client();
        Ok(session.core().with_open_stores(async || encryption_status(client).await).await)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct KeyBackupStatusParams {}

impl SessionHandler for KeyBackupStatusParams {
    type Ok = KeyBackupStatusView;

    async fn run(self, session: &SignedIn) -> Result<KeyBackupStatusView, RpcError> {
        session.key_backup_status().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DownloadKeyBackupParams {
    pub request_id: String,
}

impl SessionHandler for DownloadKeyBackupParams {
    type Ok = KeyBackupDownloadView;

    async fn run(self, session: &SignedIn) -> Result<KeyBackupDownloadView, RpcError> {
        session.download_key_backup(self.request_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SignOutSafetyParams {}

impl SessionHandler for SignOutSafetyParams {
    type Ok = SignOutSafetyView;

    async fn run(self, session: &SignedIn) -> Result<SignOutSafetyView, RpcError> {
        Ok(sign_out_safety(session, session.client()).await)
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

impl SessionHandler for DevicesParams {
    type Ok = DevicesOk;

    async fn run(self, session: &SignedIn) -> Result<DevicesOk, RpcError> {
        let client = session.client();

        Ok(DevicesOk {
            devices: verification::own_devices(client).await,
        })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UserSecurityParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl SessionHandler for UserSecurityParams {
    type Ok = UserSecurityView;

    async fn run(self, session: &SignedIn) -> Result<UserSecurityView, RpcError> {
        verification::user_security(session, &self.user_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RecoverIdentityParams {
    pub recovery_key: String,
}

impl SessionHandler for RecoverIdentityParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let client = session.client();
        client
            .encryption()
            .recovery()
            .recover_and_fix_backup(&self.recovery_key)
            .await
            .map_err(|error| session.core().recovery_error(&error))?;
        session.adopt_account_data_key(&self.recovery_key)
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
    /// Turns the account's key backup back on. Without it, a backup the account paused ends
    /// the call with `backup_paused`.
    #[serde(default)]
    pub resume_backup: bool,
}

impl SessionHandler for EnableRecoveryParams {
    /// Unrecoverable once discarded.
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        let client = session.client();
        let backups = client.encryption().backups();
        // A backup paused by the account preference is not enabled either, yet it is readable, so
        // it is turned back on, once the user agrees, instead of being offered for replacement.
        let resumed = !backups.are_enabled().await
            && match session
                .resume_readable_backup(self.resume_backup)
                .await?
            {
                ReadableBackup::Paused => return Err(RpcCode::BackupPaused.into()),
                ReadableBackup::Resumed => true,
                ReadableBackup::None => false,
            };
        if self.replace_backup && !resumed && session.server_backup_unreadable().await? {
            backups
                .disable_and_delete()
                .await
                .or_failed(session.core(), "replace_backup")?;
        }
        let recovery = client.encryption().recovery();
        let enable = recovery.enable();

        let recovery_key = match &self.passphrase {
            Some(passphrase) => enable.with_passphrase(passphrase).await,
            None => enable.await,
        }
        .map_err(|error| match error {
            RecoveryError::BackupExistsOnServer => RpcCode::BackupExists.into(),
            error => session.core().failed_with("enable_recovery", &error),
        })?;
        session.adopt_account_data_key(&recovery_key).await;
        Ok(recovery_key)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ResetRecoveryKeyParams {
    #[serde(default)]
    pub passphrase: Option<String>,
}

impl SessionHandler for ResetRecoveryKeyParams {
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        let client = session.client();
        let recovery = client.encryption().recovery();
        let reset = recovery.reset_key();

        let recovery_key = match &self.passphrase {
            Some(passphrase) => reset.with_passphrase(passphrase).await,
            None => reset.await,
        }
        .or_failed(session.core(), "reset_recovery_key")?;
        session.adopt_account_data_key(&recovery_key).await;
        Ok(recovery_key)
    }
}

/// Destructive from the first call: the key backup and secret storage are
/// gone before the server is asked for authentication.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ResetIdentityParams {}

impl SessionHandler for ResetIdentityParams {
    type Ok = IdentityResetStep;

    async fn run(self, session: &SignedIn) -> Result<IdentityResetStep, RpcError> {
        session.reset_identity().await
    }
}

/// OAuth polls for the approval for up to two minutes.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ContinueIdentityResetParams {
    #[serde(default)]
    pub password: Option<String>,
}

impl SessionHandler for ContinueIdentityResetParams {
    /// The new recovery key.
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        session.continue_identity_reset(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CancelIdentityResetParams {}

impl SessionHandler for CancelIdentityResetParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.cancel_identity_reset().await;
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

impl SessionHandler for ExportRoomKeysParams {
    /// The passphrase-encrypted export file.
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        session.export_room_keys(&self.passphrase, self.room_id.as_deref())
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

impl SessionHandler for ImportRoomKeysParams {
    type Ok = ImportRoomKeysOk;

    async fn run(self, session: &SignedIn) -> Result<ImportRoomKeysOk, RpcError> {
        session.import_room_keys(&self.export, &self.passphrase).await
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

impl SessionHandler for DeleteDeviceParams {
    /// Under OAuth, the account page that deletes the device.
    type Ok = Option<String>;

    async fn run(self, session: &SignedIn) -> Result<Option<String>, RpcError> {
        session.delete_device(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RenameDeviceParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub device_id: OwnedDeviceId,
    pub display_name: String,
}

impl SessionHandler for RenameDeviceParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let client = session.client();
        let generation = session.generation();
        client
            .rename_device(&self.device_id, &self.display_name)
            .await
            .or_failed(session.core(), "rename_device")?;
        session.core().emit_devices(generation, client).await;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DiscardRoomKeyParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for DiscardRoomKeyParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.room(&self.room_id)?
            .discard_room_key()
            .await
            .or_failed(session.core(), "discard_room_key")?;
        Ok(())
    }
}

/// MSC4268: the recipient only accepts the keys from whoever invited them.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ShareHistoryParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl SessionHandler for ShareHistoryParams {
    type Ok = ShareHistoryView;

    async fn run(self, session: &SignedIn) -> Result<ShareHistoryView, RpcError> {
        let room = session.room(&self.room_id)?;
        share_history(session, &room, &self.user_id, false).await
    }
}

/// `inviting` skips the inviter check: the invite that makes us the inviter
/// is about to be sent.
pub(crate) async fn share_history(
    signed_in: &SignedIn,
    room: &matrix_sdk::Room,
    user_id: &UserId,
    inviting: bool,
) -> Result<ShareHistoryView, RpcError> {
    let core = signed_in.core();
    if !room.encryption_state().is_encrypted() {
        return Ok(ShareHistoryView::Unencrypted);
    }
    let client = signed_in.client();
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
    if !inviting && bundle_refused(room, own, user_id).await {
        return Ok(ShareHistoryView::NotInvited);
    }
    // Bundles only go to devices the recipient has cross-signed.
    client
        .encryption()
        .request_user_identity(user_id)
        .await
        .or_failed(core, "share_history")?;
    let devices = client
        .encryption()
        .get_user_devices(user_id)
        .await
        .or_failed(core, "share_history")?;
    if !devices.devices().any(|device| device.is_cross_signed_by_owner()) {
        return Ok(ShareHistoryView::NoVerifiedDevices);
    }
    room.share_history_with(user_id)
        .await
        .or_failed(core, "share_history")?;
    let base = signed_in.base_client().await?;
    let machine = base.olm_machine().await;
    let machine = machine.as_ref().ok_or(RpcCode::NotLoggedIn)?;
    let sessions = machine
        .store()
        .get_inbound_group_sessions_by_room_id(room.room_id())
        .await
        .or_failed(core, "share_history")?;
    if !sessions.iter().any(InboundGroupSession::shared_history) {
        return Ok(ShareHistoryView::NothingToShare);
    }
    Ok(ShareHistoryView::Shared)
}

/// True when the room state shows `user_id` will drop a bundle from `own`.
async fn bundle_refused(room: &matrix_sdk::Room, own: &UserId, user_id: &UserId) -> bool {
    let member = match room.get_member_no_sync(user_id).await {
        Ok(Some(member)) => Some(member),
        _ => room.get_member(user_id).await.ok().flatten(),
    };
    let Some(member) = member else {
        return false;
    };
    let event = member.event();
    match event.membership() {
        MembershipState::Invite => event.sender() != own,
        MembershipState::Leave | MembershipState::Ban => true,
        MembershipState::Join => {
            let MemberEvent::Sync(SyncStateEvent::Original(join)) = &**event else {
                return false;
            };
            match join.unsigned.prev_content.as_ref().map(|previous| &previous.membership) {
                Some(MembershipState::Leave) => true,
                Some(MembershipState::Invite) => {
                    let Some(invite) = join.unsigned.replaces_state.as_ref() else {
                        return false;
                    };
                    let Ok(invite) = room.load_or_fetch_event(invite, None).await else {
                        return false;
                    };
                    invite
                        .raw()
                        .get_field::<OwnedUserId>("sender")
                        .ok()
                        .flatten()
                        .is_some_and(|sender| sender != own)
                }
                _ => false,
            }
        }
        _ => false,
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DehydratedDeviceParams {}

impl SessionHandler for DehydratedDeviceParams {
    type Ok = DehydratedDeviceView;

    async fn run(self, session: &SignedIn) -> Result<DehydratedDeviceView, RpcError> {
        session.dehydrated_device().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetDehydratedDeviceParams {
    pub enabled: bool,
}

impl SessionHandler for SetDehydratedDeviceParams {
    type Ok = DehydratedDeviceView;

    async fn run(self, session: &SignedIn) -> Result<DehydratedDeviceView, RpcError> {
        session.set_dehydrated_device(self.enabled).await
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

impl SessionHandler for RequestVerificationParams {
    /// The flow id, carried by every later call and event for this
    /// verification.
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        let encryption = session.client().encryption();
        let request = match self.device_id {
            Some(device_id) => encryption
                .get_device(&self.user_id, &device_id)
                .await
                .or_failed(session.core(), "request_verification_device")?
                .ok_or(RpcCode::Unavailable)?
                .request_verification_with_methods(VERIFICATION_METHODS.to_vec())
                .await
                .or_failed(session.core(), "request_verification")?,
            None => encryption
                .get_user_identity(&self.user_id)
                .await
                .or_failed(session.core(), "request_verification_identity")?
                .ok_or(RpcCode::Unavailable)?
                .request_verification_with_methods(VERIFICATION_METHODS.to_vec())
                .await
                .or_failed(session.core(), "request_verification")?,
        };

        if request.is_cancelled() {
            return Err(session.core().failed(
                "request_verification",
                "cancelled on creation by another ongoing request",
            ));
        }

        let flow_id = request.flow_id().to_owned();
        session.watch_verification(request);
        Ok(flow_id)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct WithdrawVerificationParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl SessionHandler for WithdrawVerificationParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.client()
            .encryption()
            .get_user_identity(&self.user_id)
            .await
            .or_failed(session.core(), "withdraw_verification_identity")?
            .ok_or(RpcCode::Unavailable)?
            .withdraw_verification()
            .await
            .or_failed(session.core(), "withdraw_verification")?;
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

impl SessionHandler for SetDeviceBlockedParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        verification::set_device_blocked(session, &self.user_id, &self.device_id, self.blocked).await
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

impl SessionHandler for AcceptVerificationParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.verification_request(&self.user_id, &self.flow_id)
            .await?
            .accept_with_methods(VERIFICATION_METHODS.to_vec())
            .await
            .or_failed(session.core(), "accept_verification")?;
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

impl SessionHandler for ScanVerificationQrParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.scan_verification_qr(self.user_id, self.flow_id, &self.data)
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

impl SessionHandler for StartSasVerificationParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.verification_request(&self.user_id, &self.flow_id)
            .await?
            .start_sas()
            .await
            .or_failed(session.core(), "start_sas_verification")?
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

impl SessionHandler for ConfirmVerificationParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        match session.sas(&self.user_id, &self.flow_id).await {
            Ok(sas) => sas.confirm().await,
            Err(_) => session.qr(&self.user_id, &self.flow_id).await?.confirm().await,
        }
        .or_failed(session.core(), "confirm_verification")?;
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

impl SessionHandler for CancelVerificationParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let (user_id, flow_id) = (&self.user_id, &self.flow_id);
        // No SAS to report a mismatch on before the emoji show.
        match session.sas(user_id, flow_id).await {
            Ok(sas) if self.mismatch => sas
                .mismatch()
                .await
                .or_failed(session.core(), "cancel_verification_mismatch")?,
            Ok(sas) => sas
                .cancel()
                .await
                .or_failed(session.core(), "cancel_verification_sas")?,
            Err(_) if let Ok(qr) = session.qr(user_id, flow_id).await => {
                qr.cancel()
                    .await
                    .or_failed(session.core(), "cancel_verification_qr")?;
            }
            Err(_) => session
                .verification_request(user_id, flow_id)
                .await?
                .cancel()
                .await
                .or_failed(session.core(), "cancel_verification")?,
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::events::AnySyncStateEvent;
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk::ruma::{event_id, room_id, user_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::{JoinedRoomBuilder, event_factory::EventFactory};
    use serde_json::{Value, json};

    use super::*;

    fn room() -> JoinedRoomBuilder {
        JoinedRoomBuilder::new(room_id!("!history:localhost"))
    }

    fn join(previous: Option<&str>, replaces_state: Option<&str>) -> Raw<AnySyncStateEvent> {
        let mut unsigned = json!({});
        if let Some(membership) = previous {
            unsigned["prev_content"] = json!({ "membership": membership });
        }
        if let Some(event_id) = replaces_state {
            unsigned["replaces_state"] = Value::from(event_id);
        }
        Raw::new(&json!({
            "type": "m.room.member",
            "state_key": "@bob:localhost",
            "sender": "@bob:localhost",
            "event_id": "$join",
            "origin_server_ts": 1,
            "content": { "membership": "join" },
            "unsigned": unsigned,
        }))
        .unwrap()
        .cast_unchecked()
    }

    /// `None` means we sent the invite.
    async fn refused(
        inviter: Option<&UserId>,
        state: impl FnOnce(&EventFactory, &UserId) -> JoinedRoomBuilder,
    ) -> bool {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let own = client.user_id().unwrap().to_owned();
        let factory = EventFactory::new().room(room_id!("!history:localhost"));
        let room = server.sync_room(&client, state(&factory, &own)).await;
        server
            .mock_room_event()
            .match_event_id()
            .ok(factory
                .member(inviter.unwrap_or(&own))
                .invited(user_id!("@bob:localhost"))
                .event_id(event_id!("$invite"))
                .into_event())
            .mount()
            .await;
        bundle_refused(&room, &own, user_id!("@bob:localhost")).await
    }

    #[tokio::test]
    async fn an_invite_we_sent_takes_the_bundle() {
        assert!(
            !refused(None, |factory, own| room()
                .add_state_event(factory.member(own).invited(user_id!("@bob:localhost"))))
            .await
        );
    }

    #[tokio::test]
    async fn an_invite_someone_else_sent_drops_it() {
        let carol = user_id!("@carol:localhost");
        assert!(
            refused(None, |factory, _| room()
                .add_state_event(factory.member(carol).invited(user_id!("@bob:localhost"))))
            .await
        );
    }

    #[tokio::test]
    async fn a_join_that_accepted_our_invite_takes_it() {
        assert!(!refused(None, |_, _| room().add_state_bulk([join(Some("invite"), Some("$invite"))])).await);
    }

    #[tokio::test]
    async fn a_join_that_accepted_someone_elses_invite_drops_it() {
        let carol = user_id!("@carol:localhost");
        assert!(refused(Some(carol), |_, _| room().add_state_bulk([join(Some("invite"), Some("$invite"))])).await);
    }

    #[tokio::test]
    async fn a_join_without_an_invite_drops_it() {
        assert!(refused(None, |_, _| room().add_state_bulk([join(Some("leave"), None)])).await);
    }

    #[tokio::test]
    async fn a_join_with_no_history_is_left_to_their_client() {
        assert!(!refused(None, |_, _| room().add_state_bulk([join(None, None)])).await);
    }

    #[tokio::test]
    async fn someone_we_know_nothing_about_is_left_to_their_client() {
        assert!(!refused(None, |_, _| room()).await);
    }

    #[tokio::test]
    async fn a_profile_change_after_joining_is_left_to_their_client() {
        assert!(!refused(None, |_, _| room().add_state_bulk([join(Some("join"), Some("$invite"))])).await);
    }

    #[tokio::test]
    async fn someone_who_left_drops_it() {
        assert!(
            refused(None, |factory, _| room()
                .add_state_event(factory.member(user_id!("@bob:localhost")).leave()))
            .await
        );
    }
}
