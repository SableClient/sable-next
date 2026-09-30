use std::sync::atomic::Ordering;

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
        let status = client
            .encryption()
            .backups()
            .status()
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
        let result = client
            .encryption()
            .backups()
            .download_all_room_keys_with_progress(|progress| {
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
