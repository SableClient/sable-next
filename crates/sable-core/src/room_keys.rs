use matrix_sdk::encryption::{KeyExportError, RoomKeyImportError};
use matrix_sdk::ruma::RoomId;
#[cfg(not(target_family = "wasm"))]
use tempfile::NamedTempFile;

use crate::Core;
use crate::ResultExt;
use crate::SignedIn;
use crate::api::encryption::ImportRoomKeysOk;
use crate::protocol::{RpcCode, RpcError};

impl SignedIn {
    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn export_room_keys(
        &self,
        passphrase: &str,
        room_id: Option<&RoomId>,
    ) -> Result<String, RpcError> {
        let client = self.client();
        let file = self.core().room_key_file()?;

        client
            .encryption()
            .export_room_keys(file.path().to_owned(), passphrase, |session| {
                room_id.is_none_or(|room_id| session.room_id() == room_id)
            })
            .await
            .or_failed(self.core(), "export_room_keys")?;

        let export = tokio::fs::read_to_string(file.path())
            .await
            .or_failed(self.core(), "export_room_keys")?;

        tracing::info!("room keys exported");
        Ok(export)
    }

    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn import_room_keys(
        &self,
        export: &str,
        passphrase: &str,
    ) -> Result<ImportRoomKeysOk, RpcError> {
        let client = self.client();
        let file = self.core().room_key_file()?;

        tokio::fs::write(file.path(), export)
            .await
            .or_failed(self.core(), "import_room_keys")?;

        let result = client
            .encryption()
            .import_room_keys(file.path().to_owned(), passphrase)
            .await
            .map_err(|error| self.core().room_key_import_error(error))?;

        tracing::info!(
            imported = result.imported_count,
            total = result.total_count,
            "room keys imported"
        );
        Ok(ImportRoomKeysOk {
            imported: result.imported_count as u64,
            total: result.total_count as u64,
        })
    }

    #[cfg(target_family = "wasm")]
    pub(crate) async fn export_room_keys(
        &self,
        passphrase: &str,
        room_id: Option<&RoomId>,
    ) -> Result<String, RpcError> {
        let base = self.base_client().await?;
        let machine = base.olm_machine().await;
        let machine = machine.as_ref().ok_or(RpcCode::NotLoggedIn)?;

        let keys = machine
            .store()
            .export_room_keys(|session| room_id.is_none_or(|room_id| session.room_id() == room_id))
            .await
            .or_failed(self.core(), "export_room_keys")?;
        let export = matrix_sdk_base::crypto::encrypt_room_key_export(&keys, passphrase, 500_000)
            .or_failed(self.core(), "export_room_keys")?;

        tracing::info!("room keys exported");
        Ok(export)
    }

    #[cfg(target_family = "wasm")]
    pub(crate) async fn import_room_keys(
        &self,
        export: &str,
        passphrase: &str,
    ) -> Result<ImportRoomKeysOk, RpcError> {
        let base = self.base_client().await?;
        let machine = base.olm_machine().await;
        let machine = machine.as_ref().ok_or(RpcCode::NotLoggedIn)?;

        let keys = matrix_sdk_base::crypto::decrypt_room_key_export(export.as_bytes(), passphrase)
            .map_err(|error| {
                self.core()
                    .room_key_import_error(RoomKeyImportError::Export(error))
            })?;
        let result = machine
            .store()
            .import_exported_room_keys(keys, |_, _| {})
            .await
            .or_failed(self.core(), "import_room_keys")?;

        tracing::info!(
            imported = result.imported_count,
            total = result.total_count,
            "room keys imported"
        );
        Ok(ImportRoomKeysOk {
            imported: result.imported_count as u64,
            total: result.total_count as u64,
        })
    }

    pub(crate) async fn base_client(&self) -> Result<crate::session::SharedBaseClient, RpcError> {
        let store_id = self
            .core()
            .registered_store_id(&self.session().account_id)
            .await
            .ok_or(RpcCode::NotLoggedIn)?;
        crate::session::base_client(&store_id).ok_or_else(|| RpcCode::Unavailable.into())
    }
}

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
#[path = "room_keys_tests.rs"]
mod tests;

impl Core {
    #[cfg(not(target_family = "wasm"))]
    fn room_key_file(&self) -> Result<NamedTempFile, RpcError> {
        tempfile::Builder::new()
            .prefix(".room-keys-")
            .tempfile_in(&self.store_id)
            .or_failed(self, "room_key_file")
    }

    fn room_key_import_error(&self, error: RoomKeyImportError) -> RpcError {
        match error {
            RoomKeyImportError::Export(KeyExportError::InvalidMac) => RpcCode::Denied.into(),
            RoomKeyImportError::Export(_) => RpcCode::InvalidKeyExport.into(),
            error => self.failed_with("import_room_keys", &error),
        }
    }
}
