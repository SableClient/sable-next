use crate::SignedIn;
use crate::errors::CoreResultExt as _;
use crate::errors::{CoreError, ReportExt};
use matrix_sdk::{
    Client,
    ruma::api::{
        client::backup::{get_backup_keys, get_latest_backup_info},
        error::ErrorKind,
    },
};
use matrix_sdk_base::crypto::{
    olm::ExportedRoomKey, store::types::BackupDecryptionKey, types::RoomKeyBackupInfo,
};

use crate::Core;
use crate::protocol::{
    CoreEvent, KeyBackupDownloadState, KeyBackupDownloadView, KeyBackupStatusView, RpcCode,
    RpcError,
};

impl SignedIn {
    fn report_key_backup_download(&self, generation: u64, download: KeyBackupDownloadView) {
        *self.state().key_backup_download.lock() = Some(download.clone());
        self.core()
            .emit_if_current(generation, CoreEvent::KeyBackupDownload { download });
    }

    pub(crate) async fn key_backup_status(&self) -> Result<KeyBackupStatusView, RpcError> {
        let client = self.client();
        let base = self.base_client().await?;
        let status = self
            .core()
            .backup_status(&base, client)
            .await
            .or_report(self.core(), "key_backup_status")?;
        let download = self.state().key_backup_download.lock().clone();
        Ok(KeyBackupStatusView {
            local_keys: status.local_keys,
            backed_up_keys: status.backed_up_keys,
            cloud_keys: status.cloud_keys,
            can_restore: status.can_restore,
            download,
        })
    }

    pub(crate) async fn download_key_backup(
        &self,
        request_id: String,
    ) -> Result<KeyBackupDownloadView, RpcError> {
        let _permit = self
            .state()
            .key_backup_downloads
            .try_acquire()
            .map_err(|_| RpcCode::Unavailable)?;
        let account_id = self.session().account_id.clone();
        let generation = self.generation();
        let initial = KeyBackupDownloadView {
            account_id,
            request_id,
            state: KeyBackupDownloadState::Downloading,
            total: None,
            processed: 0,
            imported: 0,
            failed: 0,
        };
        self.report_key_backup_download(generation, initial.clone());
        let base = self.base_client().await?;
        let result = self
            .download_all_room_keys(&base, |progress| {
                self.report_key_backup_download(
                    generation,
                    KeyBackupDownloadView {
                        state: KeyBackupDownloadState::Importing,
                        total: Some(progress.total as u64),
                        processed: progress.processed as u64,
                        imported: progress.imported as u64,
                        failed: progress.failed as u64,
                        ..initial.clone()
                    },
                );
            })
            .await;
        let mut download = self
            .state()
            .key_backup_download
            .lock()
            .clone()
            .unwrap_or(initial);
        download.state = if result.is_ok() {
            KeyBackupDownloadState::Complete
        } else {
            KeyBackupDownloadState::Failed
        };
        self.report_key_backup_download(generation, download.clone());
        result.or_report(self.core(), "download_key_backup")?;
        Ok(download)
    }

    pub(crate) async fn download_all_room_keys(
        &self,
        base: &crate::session::SharedBaseClient,
        progress: impl Fn(BackupDownloadProgress),
    ) -> Result<BackupDownloadProgress, CoreError> {
        let client = self.client();
        let machine = base.olm_machine().await;
        let machine = machine.as_ref().ok_or("no olm machine")?;
        let keys = machine.store().load_backup_keys().await.backend()?;
        let (Some(key), Some(version)) = (keys.decryption_key, keys.backup_version) else {
            return Err("backup is not enabled".into());
        };
        let current = current_backup(client)
            .await?
            .ok_or("backup is not enabled")?;
        if current.version != version || !matches_backup(Some(&key), &current) {
            return Err("backup is not enabled".into());
        }
        let response = client
            .send(get_backup_keys::v3::Request::new(version.clone()))
            .await
            .backend()?;
        let sessions: Vec<_> = response
            .rooms
            .into_iter()
            .flat_map(|(room_id, room)| {
                room.sessions
                    .into_iter()
                    .map(move |(session_id, key)| (room_id.clone(), session_id, key))
            })
            .collect();
        let mut counts = BackupDownloadProgress {
            total: sessions.len(),
            ..BackupDownloadProgress::default()
        };
        progress(counts);
        for batch in sessions.chunks(IMPORT_BATCH) {
            let exported = decrypt_batch(key.clone(), batch.to_vec()).await?;
            let result = machine
                .store()
                .import_room_keys(exported, Some(&version), |_, _| {})
                .await
                .backend()?;
            counts.processed += batch.len();
            counts.imported += result.imported_count;
            counts.failed += batch.len() - result.total_count;
            progress(counts);
        }
        Ok(counts)
    }
}

const IMPORT_BATCH: usize = 100;

type BackedUpSession = (
    ruma::OwnedRoomId,
    String,
    ruma::serde::Raw<ruma::api::client::backup::KeyBackupData>,
);

/// Decrypting a batch is CPU-bound, so it stays off the async task. A session
/// that cannot be read is logged and counted as failed by the caller.
#[cfg_attr(
    target_family = "wasm",
    expect(
        clippy::unused_async,
        reason = "only native moves the work off the task"
    )
)]
async fn decrypt_batch(
    key: BackupDecryptionKey,
    batch: Vec<BackedUpSession>,
) -> Result<Vec<ExportedRoomKey>, CoreError> {
    let decrypt = move || {
        batch
            .into_iter()
            .filter_map(|(room_id, session_id, backed_up)| {
                let backed_up = backed_up
                    .deserialize()
                    .inspect_err(|error| {
                        tracing::warn!(%session_id, "unreadable backed up room key: {error}");
                    })
                    .ok()?;
                let room_key = key
                    .decrypt_session_data(backed_up.session_data)
                    .inspect_err(|error| {
                        tracing::warn!(%session_id, "undecryptable backed up room key: {error}");
                    })
                    .ok()?;
                Some(ExportedRoomKey::from_backed_up_room_key(
                    room_id, session_id, room_key,
                ))
            })
            .collect()
    };
    #[cfg(not(target_family = "wasm"))]
    return tokio::task::spawn_blocking(decrypt).await.backend();
    #[cfg(target_family = "wasm")]
    Ok(decrypt())
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct BackupStatus {
    pub local_keys: u64,
    pub backed_up_keys: u64,
    pub cloud_keys: Option<u64>,
    pub can_restore: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct BackupDownloadProgress {
    pub total: usize,
    pub processed: usize,
    pub imported: usize,
    pub failed: usize,
}

async fn current_backup(
    client: &Client,
) -> Result<Option<get_latest_backup_info::v3::Response>, CoreError> {
    match client
        .send(get_latest_backup_info::v3::Request::new())
        .await
    {
        Ok(info) => Ok(Some(info)),
        Err(error) if error.client_api_error_kind() == Some(&ErrorKind::NotFound) => Ok(None),
        Err(error) => Err(CoreError::backend(error)),
    }
}

/// A server backup this device holds no key for. A paused backup still matches its key, so it is not one.
fn is_unreadable(
    key: Option<&BackupDecryptionKey>,
    current: Option<&get_latest_backup_info::v3::Response>,
) -> bool {
    current.is_some_and(|info| !matches_backup(key, info))
}

fn matches_backup(
    key: Option<&BackupDecryptionKey>,
    info: &get_latest_backup_info::v3::Response,
) -> bool {
    key.is_some_and(|key| {
        info.algorithm
            .deserialize_as::<RoomKeyBackupInfo>()
            .is_ok_and(|info| key.backup_key_matches(&info))
    })
}

/// What recovery setup finds of a server backup that is not enabled on this device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadableBackup {
    /// No backup, or one this device holds no key for.
    None,
    /// Readable, and left off because the account turned key backup off.
    Paused,
    Resumed,
}

impl SignedIn {
    /// Whether the server holds a backup whose key this device lacks.
    pub(crate) async fn server_backup_unreadable(&self) -> Result<bool, RpcError> {
        let client = self.client();
        let base = self.base_client().await?;
        let unreadable = async {
            let machine = base.olm_machine().await;
            let machine = machine.as_ref().ok_or("no olm machine")?;
            let keys = machine.store().load_backup_keys().await.backend()?;
            let current = current_backup(client).await?;
            Ok::<_, CoreError>(is_unreadable(
                keys.decryption_key.as_ref(),
                current.as_ref(),
            ))
        };
        unreadable.await.or_report(self.core(), "replace_backup")
    }

    /// Enables a server backup this device holds the key for, which recovery setup needs. A
    /// pause is the account's choice (MSC4287), so it is only set back once `turn_on` says the
    /// user agreed. A preference that cannot be read fails rather than guess.
    pub(crate) async fn resume_readable_backup(
        &self,
        turn_on: bool,
    ) -> Result<ReadableBackup, RpcError> {
        let client = self.client();
        let base = self.base_client().await?;
        let resumed = async {
            let machine = base.olm_machine().await;
            let machine = machine.as_ref().ok_or("no olm machine")?;
            let keys = machine.store().load_backup_keys().await.backend()?;
            let (Some(key), Some(info)) = (keys.decryption_key, current_backup(client).await?)
            else {
                return Ok(ReadableBackup::None);
            };
            if !matches_backup(Some(&key), &info) {
                return Ok(ReadableBackup::None);
            }
            if backups_marked_disabled(client).await.backend()? {
                if !turn_on {
                    return Ok(ReadableBackup::Paused);
                }
                mark_backups_enabled(client).await.backend()?;
            }
            let public = key.megolm_v1_public_key();
            public.set_version(info.version);
            machine
                .backup_machine()
                .enable_backup_v1(public)
                .await
                .backend()?;
            Ok::<_, CoreError>(ReadableBackup::Resumed)
        };
        resumed.await.or_report(self.core(), "resume_backup")
    }

    pub(crate) async fn honor_backup_preference(&self) {
        let client = self.client();
        match backups_marked_disabled(client).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                // Pausing on a transient failure would silently stop every user's backup.
                tracing::warn!("could not read the key backup preference: {error}");
                return;
            }
        }
        let Ok(base) = self.base_client().await else {
            return;
        };
        let machine = base.olm_machine().await;
        let Some(machine) = machine.as_ref() else {
            return;
        };
        if !machine.backup_machine().enabled().await {
            return;
        }
        if let Err(error) = machine.backup_machine().disable_backup().await {
            tracing::error!("could not pause the key backup the account disabled: {error}");
        }
    }

    pub(crate) fn watch_backup_preference(&self) {
        use crate::tasks::JoinHandleExt;
        use futures_util::StreamExt;
        use matrix_sdk::encryption::backups::BackupState;

        let client = self.client();
        let core = self.clone();
        let client = client.clone();
        let mut states = client.encryption().backups().state_stream();
        self.track_session_task(
            matrix_sdk::executor::spawn(async move {
                core.honor_backup_preference().await;
                while let Some(state) = states.next().await {
                    if matches!(state, Ok(BackupState::Enabled)) {
                        core.honor_backup_preference().await;
                    }
                }
            })
            .abort_on_drop(),
        );
    }
}

/// The stable preference and the unstable one older clients still read.
async fn mark_backups_enabled(client: &Client) -> Result<(), matrix_sdk::Error> {
    use matrix_sdk::ruma::events::GlobalAccountDataEventType;

    for (event_type, content) in [
        ("m.key_backup", serde_json::json!({ "enabled": true })),
        (
            "m.org.matrix.custom.backup_disabled",
            serde_json::json!({ "disabled": false }),
        ),
    ] {
        client
            .account()
            .set_account_data_raw(
                GlobalAccountDataEventType::from(event_type),
                ruma::serde::Raw::new(&content)?.cast_unchecked(),
            )
            .await?;
    }
    Ok(())
}

async fn backups_marked_disabled(client: &Client) -> Result<bool, matrix_sdk::Error> {
    use matrix_sdk::ruma::events::GlobalAccountDataEventType;

    let field = |raw: ruma::serde::Raw<_>, key: &str| {
        raw.deserialize_as::<serde_json::Value>()
            .ok()
            .and_then(|content| content.get(key)?.as_bool())
    };
    if let Some(raw) = client
        .account()
        .fetch_account_data(GlobalAccountDataEventType::from("m.key_backup"))
        .await?
    {
        return Ok(field(raw, "enabled") == Some(false));
    }
    Ok(client
        .account()
        .fetch_account_data(GlobalAccountDataEventType::from(
            "m.org.matrix.custom.backup_disabled",
        ))
        .await?
        .and_then(|raw| field(raw, "disabled"))
        .unwrap_or(false))
}

impl Core {
    pub(crate) async fn backup_status(
        &self,
        base: &crate::session::SharedBaseClient,
        client: &Client,
    ) -> Result<BackupStatus, CoreError> {
        let machine = base.olm_machine().await;
        let machine = machine.as_ref().ok_or("no olm machine")?;
        let counts = machine.backup_machine().room_key_counts().await.backend()?;
        let keys = machine.store().load_backup_keys().await.backend()?;
        let current = current_backup(client).await?;
        let same_version = current
            .as_ref()
            .is_some_and(|info| keys.backup_version.as_ref() == Some(&info.version));
        let can_restore = same_version
            && current
                .as_ref()
                .is_some_and(|info| matches_backup(keys.decryption_key.as_ref(), info));
        Ok(BackupStatus {
            local_keys: counts.total as u64,
            backed_up_keys: if same_version {
                counts.backed_up as u64
            } else {
                0
            },
            cloud_keys: current.map(|info| info.count.into()),
            can_restore,
        })
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::serde::Raw;

    use super::*;

    fn info_for(key: &BackupDecryptionKey) -> get_latest_backup_info::v3::Response {
        get_latest_backup_info::v3::Response::new(
            Raw::new(&key.to_backup_info()).unwrap().cast_unchecked(),
            0u32.into(),
            String::new(),
            "1".to_owned(),
        )
    }

    #[test]
    fn a_backup_the_device_holds_the_key_for_is_never_unreadable() {
        let key = BackupDecryptionKey::new();

        assert!(!is_unreadable(Some(&key), Some(&info_for(&key))));
    }

    #[test]
    fn a_backup_under_another_key_is_unreadable() {
        let info = info_for(&BackupDecryptionKey::new());

        assert!(is_unreadable(
            Some(&BackupDecryptionKey::new()),
            Some(&info)
        ));
        assert!(is_unreadable(None, Some(&info)));
    }

    #[test]
    fn no_server_backup_leaves_nothing_to_replace() {
        assert!(!is_unreadable(None, None));
    }
}
