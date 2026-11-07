use std::future::{self, Future};
use std::sync::Arc;

use matrix_sdk::ruma::OwnedRoomId;
use serde::Deserialize;

use super::Handler;
use crate::Core;
use crate::protocol::{RpcError, PersonaCatalogView, PersonaView};

domain! {
    list,
    save,
    remove,
    reorder,
    set_selection,
    disable_room,
    account_room,
    backup,
    check_backup,
    restore_backup,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ListParams {}

impl Handler for ListParams {
    type Ok = PersonaCatalogView;

    async fn run(self, core: &Arc<Core>) -> Result<PersonaCatalogView, RpcError> {
        core.personas().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SaveParams {
    pub persona: PersonaView,
    pub base_persona: PersonaView,
    #[serde(default)]
    pub previous_id: Option<String>,
}

impl Handler for SaveParams {
    type Ok = Vec<PersonaView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<PersonaView>, RpcError> {
        core.save_persona(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RemoveParams {
    pub id: String,
}

impl Handler for RemoveParams {
    type Ok = Vec<PersonaView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<PersonaView>, RpcError> {
        core.remove_persona(&self.id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ReorderParams {
    pub ids: Vec<String>,
}

impl Handler for ReorderParams {
    type Ok = Vec<PersonaView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<PersonaView>, RpcError> {
        core.reorder_personas(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetSelectionParams {
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    #[serde(default)]
    pub room_id: Option<OwnedRoomId>,
    pub persona_id: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    #[serde(default)]
    pub alternate_avatar_id: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    #[serde(default)]
    pub valid_until: Option<u64>,
}

impl Handler for SetSelectionParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.set_persona_selection(self)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DisableRoomParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for DisableRoomParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.disable_room_personas(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AccountRoomParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for AccountRoomParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.account_room_personas(self).await
    }
}

/// The persona catalog as a backup file's text.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct BackupParams {}

impl Handler for BackupParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.persona_backup().await
    }
}

/// Refuses a file that is not a persona backup, without touching anything.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CheckBackupParams {
    pub backup: String,
}

impl Handler for CheckBackupParams {
    type Ok = ();

    fn run(self, _core: &Arc<Core>) -> impl Future<Output = Result<(), RpcError>> {
        future::ready(Core::check_persona_backup(&self.backup))
    }
}

/// Replaces the persona catalog with the one in a backup file.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RestoreBackupParams {
    pub backup: String,
}

impl Handler for RestoreBackupParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.restore_persona_backup(&self.backup).await
    }
}
