
use matrix_sdk::ruma::{OwnedRoomId, RoomId};
use serde::{Deserialize, Serialize};

use super::SessionHandler;
use crate::protocol::{RpcCode, RpcError, SidebarItemView, SpaceHierarchyRoomView, SpaceParentView};
use crate::{ResultExt, view, SignedIn};

domain! {
    add,
    set_child_order,
    set_child_suggested,
    hierarchy,
    remove,
    sidebar,
    set_sidebar,
    set_avatar_override,
    room_has_space_parent,
    unjoined_space_parents,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AddParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub space_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub suggested: Option<bool>,
}

impl SessionHandler for AddParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.add_to_space(&self.space_id, &self.room_id, self.suggested)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetChildOrderParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub space_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub order: Option<String>,
    #[serde(default)]
    pub via: Option<Vec<String>>,
}

impl SessionHandler for SetChildOrderParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.set_space_child_order(&self.space_id, &self.room_id, self.order, self.via)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetChildSuggestedParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub space_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub suggested: bool,
    #[serde(default)]
    pub via: Option<Vec<String>>,
}

impl SessionHandler for SetChildSuggestedParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.set_space_child_suggested(&self.space_id, &self.room_id, self.suggested, self.via)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct HierarchyParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub space_id: OwnedRoomId,
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct HierarchyOk {
    pub rooms: Vec<SpaceHierarchyRoomView>,
    /// Pass back as `from` for the next page; `null` at the end.
    pub next_batch: Option<String>,
}

impl SessionHandler for HierarchyParams {
    type Ok = HierarchyOk;
    const ENDS_WITH_SESSION: bool = true;

    async fn run(self, session: &SignedIn) -> Result<HierarchyOk, RpcError> {
        session.space_hierarchy(&self.space_id, self.from).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RemoveParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub space_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for RemoveParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        // The spec delists by omitting `via`. The typed content has it
        // non-optional and would send `{"via": []}`, a valid array.
        let space = session.room(&self.space_id)?;
        session.refuse_private_child(&space, &self.room_id).await?;
        space
            .send_state_event_raw(
                "m.space.child",
                self.room_id.as_str(),
                serde_json::Value::Object(serde_json::Map::new()),
            )
            .await
            .or_failed(session.core(), "remove_from_space")?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SidebarParams {}

impl SessionHandler for SidebarParams {
    type Ok = Vec<SidebarItemView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<SidebarItemView>, RpcError> {
        session.space_sidebar().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetSidebarParams {
    pub items: Vec<SidebarItemView>,
}

impl SessionHandler for SetSidebarParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        if sable_model::sidebar::layout_space_ids(&self.items)
            .iter()
            .any(|room_id| RoomId::parse(room_id).is_err())
        {
            return Err(RpcCode::UnknownRoom.into());
        }
        session.set_space_sidebar(&self.items).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetAvatarOverrideParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub url: Option<String>,
}

impl SessionHandler for SetAvatarOverrideParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.set_avatar_override(&self.room_id, self.url.as_deref())
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RoomHasSpaceParentParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for RoomHasSpaceParentParams {
    type Ok = bool;

    async fn run(self, session: &SignedIn) -> Result<bool, RpcError> {
        let client = session.client();
        let room = session.room(&self.room_id)?;
        Ok(!view::restricted_parents(client, &room).await.is_empty())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UnjoinedSpaceParentsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for UnjoinedSpaceParentsParams {
    type Ok = Vec<SpaceParentView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<SpaceParentView>, RpcError> {
        let client = session.client();
        let room = session.room(&self.room_id)?;
        Ok(crate::cosmetics::unjoined_space_parents(session.core(), client, &room).await)
    }
}
