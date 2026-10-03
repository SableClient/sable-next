use std::sync::atomic::Ordering;

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

use crate::protocol::{
    CommandErr, CommandOk, CoreEvent, KeyBackupDownloadState, KeyBackupDownloadView,
    KeyBackupStatusView,
};
use crate::{Core, ResultExt};

impl Core {
    pub(crate) async fn key_backup_status(&self) -> Result<CommandOk, CommandErr> {
        let (account_id, client) = {
            let session = self.session.read().await;
            let session = session.as_ref().ok_or(CommandErr::NotLoggedIn)?;
            (session.account_id.clone(), session.client.clone())
        };
        let status = self
            .backup_status(&client)
            .await
            .or_failed(self, "key_backup_status")?;
        let download = self
            .key_backup_download
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|download| download.account_id == account_id)
            .cloned();
        Ok(CommandOk::KeyBackupStatus {
            status: KeyBackupStatusView {
                local_keys: status.local_keys,
                backed_up_keys: status.backed_up_keys,
                cloud_keys: status.cloud_keys,
                can_restore: status.can_restore,
                download,
            },
        })
    }

    pub(crate) async fn download_key_backup(
        &self,
        request_id: String,
    ) -> Result<CommandOk, CommandErr> {
        let _permit = self
            .key_backup_downloads
            .try_acquire()
            .map_err(|_| CommandErr::Unavailable)?;
        let (account_id, client, generation) = {
            let session = self.session.read().await;
            let session = session.as_ref().ok_or(CommandErr::NotLoggedIn)?;
            (
                session.account_id.clone(),
                session.client.clone(),
                self.session_generation.load(Ordering::SeqCst),
            )
        };
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
        let result = self
            .download_all_room_keys(&client, |progress| {
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
            .key_backup_download
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .unwrap_or(initial);
        download.state = if result.is_ok() {
            KeyBackupDownloadState::Complete
        } else {
            KeyBackupDownloadState::Failed
        };
        self.report_key_backup_download(generation, download.clone());
        result.or_failed(self, "download_key_backup")?;
        Ok(CommandOk::DownloadKeyBackup { download })
    }

    pub(crate) async fn backup_status(&self, client: &Client) -> Result<BackupStatus, String> {
        let base = self
            .base_client()
            .await
            .map_err(|error| format!("{error:?}"))?;
        let machine = base.olm_machine().await;
        let machine = machine.as_ref().ok_or("no olm machine")?;
        let counts = machine
            .backup_machine()
            .room_key_counts()
            .await
            .map_err(|error| error.to_string())?;
        let keys = machine
            .store()
            .load_backup_keys()
            .await
            .map_err(|error| error.to_string())?;
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

    pub(crate) async fn download_all_room_keys(
        &self,
        client: &Client,
        progress: impl Fn(BackupDownloadProgress),
    ) -> Result<BackupDownloadProgress, String> {
        let base = self
            .base_client()
            .await
            .map_err(|error| format!("{error:?}"))?;
        let machine = base.olm_machine().await;
        let machine = machine.as_ref().ok_or("no olm machine")?;
        let keys = machine
            .store()
            .load_backup_keys()
            .await
            .map_err(|error| error.to_string())?;
        let (Some(key), Some(version)) = (keys.decryption_key, keys.backup_version) else {
            return Err("backup is not enabled".to_owned());
        };
        let current = current_backup(client)
            .await?
            .ok_or("backup is not enabled")?;
        if current.version != version || !matches_backup(Some(&key), &current) {
            return Err("backup is not enabled".to_owned());
        }
        let response = client
            .send(get_backup_keys::v3::Request::new(version.clone()))
            .await
            .map_err(|error| error.to_string())?;
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
            let exported: Vec<ExportedRoomKey> = batch
                .iter()
                .filter_map(|(room_id, session_id, backed_up)| {
                    let backed_up = backed_up.deserialize().ok()?;
                    let room_key = key.decrypt_session_data(backed_up.session_data).ok()?;
                    Some(ExportedRoomKey::from_backed_up_room_key(
                        room_id.clone(),
                        session_id.clone(),
                        room_key,
                    ))
                })
                .collect();
            let result = machine
                .store()
                .import_room_keys(exported, Some(&version), |_, _| {})
                .await
                .map_err(|error| error.to_string())?;
            counts.processed += batch.len();
            counts.imported += result.imported_count;
            counts.failed += batch.len() - result.total_count;
            progress(counts);
        }
        Ok(counts)
    }

    fn report_key_backup_download(&self, generation: u64, download: KeyBackupDownloadView) {
        if self.session_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        *self
            .key_backup_download
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(download.clone());
        self.emit_if_current(generation, CoreEvent::KeyBackupDownload { download });
    }
}

const IMPORT_BATCH: usize = 100;

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
) -> Result<Option<get_latest_backup_info::v3::Response>, String> {
    match client
        .send(get_latest_backup_info::v3::Request::new())
        .await
    {
        Ok(info) => Ok(Some(info)),
        Err(error) if error.client_api_error_kind() == Some(&ErrorKind::NotFound) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
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

impl Core {
    pub(crate) async fn honor_backup_preference(&self, client: &Client) {
        if !matches!(backups_marked_disabled(client).await, Ok(true)) {
            return;
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

    pub(crate) fn watch_backup_preference(self: &std::sync::Arc<Self>, client: &Client) {
        use futures_util::StreamExt;
        use matrix_sdk::{encryption::backups::BackupState, executor::JoinHandleExt};

        let core = self.clone();
        let client = client.clone();
        let mut states = client.encryption().backups().state_stream();
        self.track_session_task(
            matrix_sdk::executor::spawn(async move {
                core.honor_backup_preference(&client).await;
                while let Some(state) = states.next().await {
                    if matches!(state, Ok(BackupState::Enabled)) {
                        core.honor_backup_preference(&client).await;
                    }
                }
            })
            .abort_on_drop(),
        );
    }
}

async fn backups_marked_disabled(client: &Client) -> Result<bool, matrix_sdk::Error> {
    use matrix_sdk::ruma::events::GlobalAccountDataEventType;

    let field = |raw: matrix_sdk::ruma::serde::Raw<_>, key: &str| {
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
