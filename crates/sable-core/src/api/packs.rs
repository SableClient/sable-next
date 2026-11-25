
use matrix_sdk::ruma::OwnedRoomId;
use serde::{Deserialize, Serialize};

use super::SessionHandler;
use crate::SignedIn;
use crate::protocol::{RpcError, ImagePackView, PackAddressView, PackDraftView, PackImageDraftView};

domain! {
    list,
    list_all,
    save,
    create_room_pack,
    delete_room_pack,
    convert_legacy,
    remove_legacy,
    add_account_images,
    subscriptions,
    set_subscriptions,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PackTargetView {
    Room {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        room_id: OwnedRoomId,
        state_key: String,
    },
    /// `im.ponies.user_emotes`, the account's own pack.
    Account,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ListParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub cached_only: bool,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ListOk {
    pub packs: Vec<ImagePackView>,
    pub complete: bool,
}

impl SessionHandler for ListParams {
    type Ok = ListOk;

    async fn run(self, session: &SignedIn) -> Result<ListOk, RpcError> {
        session.image_packs(self.room_id, self.cached_only).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ListAllParams {}

impl SessionHandler for ListAllParams {
    type Ok = Vec<ImagePackView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<ImagePackView>, RpcError> {
        session.all_image_packs().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SaveParams {
    pub target: PackTargetView,
    pub draft: PackDraftView,
}

impl SessionHandler for SaveParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.save_image_pack(self.target, &self.draft).await
    }
}

/// The state key is derived from the name and kept unique in the room.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CreateRoomPackParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub name: String,
}

impl SessionHandler for CreateRoomPackParams {
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        session.create_room_image_pack(self.room_id, &self.name)
            .await
    }
}

/// Clears the legacy copy too, or the pack would come back from it.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DeleteRoomPackParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub state_key: String,
}

impl SessionHandler for DeleteRoomPackParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.delete_room_image_pack(self.room_id, &self.state_key)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ConvertLegacyParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub state_keys: Vec<String>,
}

impl SessionHandler for ConvertLegacyParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.convert_legacy_image_packs(&self.room_id, &self.state_keys)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RemoveLegacyParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub state_keys: Vec<String>,
}

impl SessionHandler for RemoveLegacyParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.remove_legacy_image_packs(&self.room_id, &self.state_keys)
            .await
    }
}

/// Merges into the account pack, renaming a shortcode that is taken.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AddAccountImagesParams {
    pub images: Vec<PackImageDraftView>,
}

impl SessionHandler for AddAccountImagesParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.add_account_pack_images(&self.images).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SubscriptionsParams {}

impl SessionHandler for SubscriptionsParams {
    type Ok = Vec<PackAddressView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<PackAddressView>, RpcError> {
        session.pack_subscriptions().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetSubscriptionsParams {
    pub added: Vec<PackAddressView>,
    pub removed: Vec<PackAddressView>,
}

impl SessionHandler for SetSubscriptionsParams {
    type Ok = Vec<PackAddressView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<PackAddressView>, RpcError> {
        session.set_pack_subscriptions(&self.added, &self.removed)
            .await
    }
}
