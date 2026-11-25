use std::collections::BTreeMap;

use matrix_sdk::RoomMemberships;

use matrix_sdk::ruma::events::room::join_rules::JoinRule;
use matrix_sdk::ruma::events::room::member::{MembershipState, RoomMemberEventContent};
use matrix_sdk::ruma::events::room::power_levels::{RoomPowerLevels, RoomPowerLevelsEventContent};
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId};
use serde::{Deserialize, Serialize};

use super::SessionHandler;
use crate::protocol::{
    FieldEdit, JoinRequestRoomView, MemberLookView, MemberView, MembershipView, PowerLevelLocation,
    PowerLevelTagView, PowerLevelTagsView, PronounView, RoomPermissionsView, RoomPowerLevelsView,
    RpcError,
};
use crate::{ResultExt, view, SignedIn};

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

impl SessionHandler for MemberParams {
    /// `null` when the user has no member event in the room.
    type Ok = Option<MemberView>;

    async fn run(self, session: &SignedIn) -> Result<Option<MemberView>, RpcError> {
        let room = session.room(&self.room_id)?;
        let member = room
            .get_member(&self.user_id)
            .await
            .or_failed(session.core(), "room_member")?;
        Ok(member.map(|member| view::member_view(&member, &session.core().nicknames())))
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

impl SessionHandler for ListParams {
    type Ok = Vec<MemberView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<MemberView>, RpcError> {
        let room_id = self.room_id;
        let room = session.room(&room_id)?;
        let filter = membership_filter(&self.memberships);
        let members = if session.members_recently_loaded(&room_id) {
            session.core().with_open_stores(async || room.members_no_sync(filter).await)
                .await
        } else {
            room.members(filter).await
        }
        .or_failed(session.core(), "room_members")?;
        if room.are_members_synced() {
            session.note_members_loaded(&room_id);
        }
        let power_levels = if session
            .core().with_open_stores(async || room.power_levels().await)
            .await
            .is_err()
        {
            let content = session
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

        let nicknames = session.core().nicknames();
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

impl SessionHandler for JoinRequestsParams {
    type Ok = JoinRequestsOk;

    async fn run(self, session: &SignedIn) -> Result<JoinRequestsOk, RpcError> {
        let client = session.client();
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
                let permissions = session.room_permissions(&room_id).await?;
                if !permissions.can_invite && !permissions.can_kick {
                    return Ok(None);
                }
                let knocking = ListParams {
                    room_id: room_id.clone(),
                    memberships: vec![MembershipView::Knock],
                };
                let members = SessionHandler::run(knocking, session).await?;
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

impl SessionHandler for PermissionsParams {
    type Ok = RoomPermissionsView;

    async fn run(self, session: &SignedIn) -> Result<RoomPermissionsView, RpcError> {
        session.room_permissions(&self.room_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PowerLevelsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for PowerLevelsParams {
    type Ok = RoomPowerLevelsView;

    async fn run(self, session: &SignedIn) -> Result<RoomPowerLevelsView, RpcError> {
        let room = session.room(&self.room_id)?;
        let power_levels = session
            .core().with_open_stores(async || room.power_levels_or_default().await)
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

impl SessionHandler for SetPowerLevelParams {
    type Ok = RoomPowerLevelsView;

    async fn run(self, session: &SignedIn) -> Result<RoomPowerLevelsView, RpcError> {
        session.set_power_level(self.room_id, self.levels, &self.location, self.level)
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

impl SessionHandler for SyncPowerLevelsFromSpaceParams {
    type Ok = SyncPowerLevelsFromSpaceOk;

    async fn run(self, session: &SignedIn) -> Result<SyncPowerLevelsFromSpaceOk, RpcError> {
        let (levels, tags) = session
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

impl SessionHandler for SyncChildPowerLevelsParams {
    type Ok = SyncChildPowerLevelsOk;

    async fn run(self, session: &SignedIn) -> Result<SyncChildPowerLevelsOk, RpcError> {
        let result = session
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

impl SessionHandler for PowerLevelTagsParams {
    type Ok = PowerLevelTagsOk;

    async fn run(self, session: &SignedIn) -> Result<PowerLevelTagsOk, RpcError> {
        session.power_level_tags(&self.room_id).await.map(tags_ok)
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

impl SessionHandler for SetPowerLevelTagParams {
    type Ok = PowerLevelTagsOk;

    async fn run(self, session: &SignedIn) -> Result<PowerLevelTagsOk, RpcError> {
        session.set_power_level_tag(self.room_id, self.level, self.tag.as_ref())
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

impl SessionHandler for SetUserPowerLevelParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.room(&self.room_id)?
            .update_power_levels(vec![(&self.user_id, self.power_level.into())])
            .await
            .or_failed(session.core(), "set_user_power_level")?;

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
    /// MSC4293: also remove everything they sent since they joined.
    #[serde(default)]
    pub redact_events: bool,
}

impl SessionHandler for KickParams {
    /// How many of their messages this client redacted itself.
    type Ok = u32;

    async fn run(self, session: &SignedIn) -> Result<u32, RpcError> {
        let room = session.room(&self.room_id)?;
        if !self.redact_events {
            room.kick_user(&self.user_id, self.reason.as_deref())
                .await
                .or_failed(session.core(), "kick_user")?;
            return Ok(0);
        }
        session.remove_redacting_events(&room, &self.user_id, self.reason.as_deref(), false)
            .await
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

impl SessionHandler for DenyKnockParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.send_state(
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
    /// MSC4293: also remove everything they sent since they joined.
    #[serde(default)]
    pub redact_events: bool,
}

impl SessionHandler for BanParams {
    /// How many of their messages this client redacted itself.
    type Ok = u32;

    async fn run(self, session: &SignedIn) -> Result<u32, RpcError> {
        let room = session.room(&self.room_id)?;
        if !self.redact_events {
            room.ban_user(&self.user_id, self.reason.as_deref())
                .await
                .or_failed(session.core(), "ban_user")?;
            return Ok(0);
        }
        session.remove_redacting_events(&room, &self.user_id, self.reason.as_deref(), true)
            .await
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

impl SessionHandler for UnbanParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.room(&self.room_id)?
            .unban_user(&self.user_id, self.reason.as_deref())
            .await
            .or_failed(session.core(), "unban_user")?;

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

impl SessionHandler for LookParams {
    type Ok = MemberLookView;

    async fn run(self, session: &SignedIn) -> Result<MemberLookView, RpcError> {
        session.member_look(self).await
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

impl SessionHandler for SetLookParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let edit = crate::member_look::LookEdit {
            display_name: self.display_name,
            avatar_url: self.avatar_url,
            color_on_light: self.color_on_light,
            color_on_dark: self.color_on_dark,
        };
        session.set_member_look(self.room_id, self.in_parent_space, edit)
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

impl SessionHandler for SetPronounsParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.set_pronouns(self.room_id, self.in_parent_space, &self.pronouns)
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
