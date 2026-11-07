use std::collections::BTreeMap;
use std::sync::Arc;

use matrix_sdk::RoomMemberships;

use matrix_sdk::ruma::events::room::join_rules::JoinRule;
use matrix_sdk::ruma::events::room::member::{MembershipState, RoomMemberEventContent};
use matrix_sdk::ruma::events::room::power_levels::{RoomPowerLevels, RoomPowerLevelsEventContent};
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId};
use serde::{Deserialize, Serialize};

use super::Handler;
use crate::protocol::{
    FieldEdit, JoinRequestRoomView, MemberLookView, MemberView, MembershipView, PowerLevelLocation,
    PowerLevelTagView, PowerLevelTagsView, PronounView, RoomPermissionsView, RoomPowerLevelsView,
    RpcError,
};
use crate::{Core, ResultExt, view};

domain! {
    list,
    join_requests,
    member,
    permissions,
    power_levels,
    set_power_level,
    sync_power_levels_from_space,
    sync_child_power_levels,
    power_level_tags,
    set_power_level_tag,
    set_user_power_level,
    kick,
    deny_knock,
    ban,
    unban,
    look,
    set_look,
    set_pronouns,
}

/// Keyed by the power level, as JSON object keys are.
pub type PowerLevelTagsOk = BTreeMap<String, PowerLevelTagView>;

fn tags_ok(tags: PowerLevelTagsView) -> PowerLevelTagsOk {
    tags.into_iter()
        .map(|(level, tag)| (level.to_string(), tag))
        .collect()
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MemberParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl Handler for MemberParams {
    /// `null` when the user has no member event in the room.
    type Ok = Option<MemberView>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<MemberView>, RpcError> {
        let room = core.room(&self.room_id).await?;
        let member = room
            .get_member(&self.user_id)
            .await
            .or_failed(core, "room_member")?;
        Ok(member.map(|member| view::member_view(&member, &core.nicknames())))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ListParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub memberships: Vec<MembershipView>,
}

impl Handler for ListParams {
    type Ok = Vec<MemberView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<MemberView>, RpcError> {
        let room_id = self.room_id;
        let room = core.room(&room_id).await?;
        let filter = membership_filter(&self.memberships);
        let members = if core.members_recently_loaded(&room_id) {
            core.with_open_stores(async || room.members_no_sync(filter).await)
                .await
        } else {
            room.members(filter).await
        }
        .or_failed(core, "room_members")?;
        if room.are_members_synced() {
            core.note_members_loaded(&room_id);
        }
        let power_levels = if core
            .with_open_stores(async || room.power_levels().await)
            .await
            .is_err()
        {
            let content = core
                .room_state_event_content(room_id, "m.room.power_levels".to_owned(), String::new())
                .await
                .ok()
                .flatten()
                .and_then(|content| {
                    serde_json::from_value::<RoomPowerLevelsEventContent>(content).ok()
                });
            let rules = room.clone_info().room_version_rules_or_default();
            content.map(|content| {
                RoomPowerLevels::new(
                    content.into(),
                    &rules.authorization,
                    room.creators().unwrap_or_default(),
                )
            })
        } else {
            None
        };

        let nicknames = core.nicknames();
        Ok(members
            .iter()
            .map(|member| {
                let mut member = view::member_view(member, &nicknames);
                if let Some(levels) = &power_levels {
                    member.power_level = view::clamp_power_level(levels.for_user(&member.user_id));
                }
                member
            })
            .collect())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct JoinRequestsParams {}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct JoinRequestsOk {
    pub rooms: Vec<JoinRequestRoomView>,
    pub failed: bool,
}

impl Handler for JoinRequestsParams {
    type Ok = JoinRequestsOk;

    async fn run(self, core: &Arc<Core>) -> Result<JoinRequestsOk, RpcError> {
        let client = core.client().await?;
        let mut rooms = Vec::new();
        let mut failed = false;
        for room in client.joined_rooms() {
            if !matches!(
                room.join_rule(),
                Some(JoinRule::Knock | JoinRule::KnockRestricted(_))
            ) {
                continue;
            }
            let room_id = room.room_id().to_owned();
            let result: Result<_, RpcError> = async {
                let permissions = core.room_permissions(&room_id).await?;
                if !permissions.can_invite && !permissions.can_kick {
                    return Ok(None);
                }
                let members = ListParams {
                    room_id: room_id.clone(),
                    memberships: vec![MembershipView::Knock],
                }
                .run(core)
                .await?;
                Ok((!members.is_empty()).then_some(JoinRequestRoomView {
                    room_id,
                    members,
                    permissions,
                }))
            }
            .await;
            match result {
                Ok(Some(room)) => rooms.push(room),
                Ok(None) => {}
                Err(_) => failed = true,
            }
        }
        Ok(JoinRequestsOk { rooms, failed })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PermissionsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for PermissionsParams {
    type Ok = RoomPermissionsView;

    async fn run(self, core: &Arc<Core>) -> Result<RoomPermissionsView, RpcError> {
        core.room_permissions(&self.room_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PowerLevelsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for PowerLevelsParams {
    type Ok = RoomPowerLevelsView;

    async fn run(self, core: &Arc<Core>) -> Result<RoomPowerLevelsView, RpcError> {
        let room = core.room(&self.room_id).await?;
        let power_levels = core
            .with_open_stores(async || room.power_levels_or_default().await)
            .await;

        Ok(view::room_power_levels(&power_levels))
    }
}

/// `levels` is what the reader is editing; the store lags our own writes.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetPowerLevelParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub levels: Option<RoomPowerLevelsView>,
    pub location: PowerLevelLocation,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub level: i64,
}

impl Handler for SetPowerLevelParams {
    type Ok = RoomPowerLevelsView;

    async fn run(self, core: &Arc<Core>) -> Result<RoomPowerLevelsView, RpcError> {
        core.set_power_level(self.room_id, self.levels, &self.location, self.level)
            .await
    }
}

/// Copies the space's moderation and settings levels, and its role names,
/// as far as our own level allows.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SyncPowerLevelsFromSpaceParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub space_id: OwnedRoomId,
    #[serde(default)]
    pub levels: Option<RoomPowerLevelsView>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SyncPowerLevelsFromSpaceOk {
    pub levels: RoomPowerLevelsView,
    #[cfg_attr(feature = "typegen", specta(type = BTreeMap<String, PowerLevelTagView>))]
    pub tags: PowerLevelTagsView,
}

impl Handler for SyncPowerLevelsFromSpaceParams {
    type Ok = SyncPowerLevelsFromSpaceOk;

    async fn run(self, core: &Arc<Core>) -> Result<SyncPowerLevelsFromSpaceOk, RpcError> {
        let (levels, tags) = core
            .sync_power_levels_from_space(self.room_id, self.space_id, self.levels)
            .await?;
        Ok(SyncPowerLevelsFromSpaceOk { levels, tags })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SyncChildPowerLevelsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub space_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub child_ids: Vec<OwnedRoomId>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SyncChildPowerLevelsOk {
    pub updated: u32,
    pub skipped: u32,
}

impl Handler for SyncChildPowerLevelsParams {
    type Ok = SyncChildPowerLevelsOk;

    async fn run(self, core: &Arc<Core>) -> Result<SyncChildPowerLevelsOk, RpcError> {
        let result = core
            .sync_child_power_levels(self.space_id, &self.child_ids)
            .await?;
        Ok(SyncChildPowerLevelsOk {
            updated: result.updated,
            skipped: result.skipped,
        })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PowerLevelTagsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for PowerLevelTagsParams {
    type Ok = PowerLevelTagsOk;

    async fn run(self, core: &Arc<Core>) -> Result<PowerLevelTagsOk, RpcError> {
        core.power_level_tags(&self.room_id).await.map(tags_ok)
    }
}

/// No tag removes the role at that level.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetPowerLevelTagParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub level: i64,
    #[serde(default)]
    pub tag: Option<PowerLevelTagView>,
}

impl Handler for SetPowerLevelTagParams {
    type Ok = PowerLevelTagsOk;

    async fn run(self, core: &Arc<Core>) -> Result<PowerLevelTagsOk, RpcError> {
        core.set_power_level_tag(self.room_id, self.level, self.tag.as_ref())
            .await
            .map(tags_ok)
    }
}

/// Lowering our own cannot be undone. The level to raise it is gone.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetUserPowerLevelParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub power_level: i32,
}

impl Handler for SetUserPowerLevelParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.room(&self.room_id)
            .await?
            .update_power_levels(vec![(&self.user_id, self.power_level.into())])
            .await
            .or_failed(core, "set_user_power_level")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct KickParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    #[serde(default)]
    pub reason: Option<String>,
}

impl Handler for KickParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.room(&self.room_id)
            .await?
            .kick_user(&self.user_id, self.reason.as_deref())
            .await
            .or_failed(core, "kick_user")?;

        Ok(())
    }
}

/// Refuses a knock with a `leave` membership; homeservers refuse to kick
/// a user who only knocked.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DenyKnockParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl Handler for DenyKnockParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.send_state(
            self.room_id,
            "m.room.member",
            self.user_id.as_str(),
            &RoomMemberEventContent::new(MembershipState::Leave),
        )
        .await?;
        Ok(())
    }
}

/// Also removes them from the room.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct BanParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    #[serde(default)]
    pub reason: Option<String>,
}

impl Handler for BanParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.room(&self.room_id)
            .await?
            .ban_user(&self.user_id, self.reason.as_deref())
            .await
            .or_failed(core, "ban_user")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UnbanParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    #[serde(default)]
    pub reason: Option<String>,
}

impl Handler for UnbanParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.room(&self.room_id)
            .await?
            .unban_user(&self.user_id, self.reason.as_deref())
            .await
            .or_failed(core, "unban_user")?;

        Ok(())
    }
}

/// Our own member event and pronouns in one room or space.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct LookParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for LookParams {
    type Ok = MemberLookView;

    async fn run(self, core: &Arc<Core>) -> Result<MemberLookView, RpcError> {
        core.member_look(self).await
    }
}

/// Writes our member event once; a colour change also clears the legacy
/// colour event other clients still read.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetLookParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub in_parent_space: bool,
    #[serde(default)]
    pub display_name: FieldEdit,
    #[serde(default)]
    pub avatar_url: FieldEdit,
    #[serde(default)]
    pub color_on_light: FieldEdit,
    #[serde(default)]
    pub color_on_dark: FieldEdit,
}

impl Handler for SetLookParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let edit = crate::member_look::LookEdit {
            display_name: self.display_name,
            avatar_url: self.avatar_url,
            color_on_light: self.color_on_light,
            color_on_dark: self.color_on_dark,
        };
        core.set_member_look(self.room_id, self.in_parent_space, edit)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetPronounsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub in_parent_space: bool,
    pub pronouns: Vec<PronounView>,
}

impl Handler for SetPronounsParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.set_pronouns(self.room_id, self.in_parent_space, &self.pronouns)
            .await
    }
}

pub(crate) fn membership_filter(memberships: &[MembershipView]) -> RoomMemberships {
    if memberships.is_empty() {
        return RoomMemberships::JOIN;
    }

    memberships
        .iter()
        .fold(RoomMemberships::empty(), |filter, membership| {
            filter
                | match membership {
                    MembershipView::Join => RoomMemberships::JOIN,
                    MembershipView::Invite => RoomMemberships::INVITE,
                    MembershipView::Knock => RoomMemberships::KNOCK,
                    MembershipView::Leave => RoomMemberships::LEAVE,
                    MembershipView::Ban => RoomMemberships::BAN,
                }
        })
}
