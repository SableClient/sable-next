use std::sync::Arc;


use matrix_sdk::ruma::api::client::alias::{create_alias, delete_alias};
use matrix_sdk::ruma::api::client::directory::{get_room_visibility, set_room_visibility};
use matrix_sdk::ruma::api::client::discovery::get_capabilities;
use matrix_sdk::ruma::api::client::discovery::get_capabilities::v3::RoomVersionStability;
use matrix_sdk::ruma::api::client::membership::invite_user::{
    self,
    v3::{InvitationRecipient, InviteUserId},
};
use matrix_sdk::ruma::api::client::room::Visibility;
use matrix_sdk::ruma::api::client::room::aliases;
use matrix_sdk::ruma::api::client::room::create_room::{self, v3::RoomPreset};
use matrix_sdk::ruma::api::client::room::upgrade_room;
use matrix_sdk::ruma::events::{AnyInitialStateEvent, InitialStateEvent};
use matrix_sdk::ruma::events::room::encryption::RoomEncryptionEventContent;
use matrix_sdk::ruma::events::space::parent::SpaceParentEventContent;
use matrix_sdk::ruma::events::tag::{TagInfo, TagName};
use matrix_sdk::ruma::room::RoomType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{
    OwnedRoomId, OwnedUserId, RoomAliasId, RoomVersionId,
};
use serde::{Deserialize, Serialize};

use super::{Handler, SessionHandler};
use crate::calendar::CALENDAR_ROOM_TYPE;
use crate::media::is_not_found;
use crate::search::MAX_SEARCH_RESULTS;
use crate::room_settings::StateEventOut;
use crate::room_settings::join_rule_content;
use crate::room_settings::voice_power_level_override;
use crate::protocol::{RpcError, CreateJoinRuleView, InviteHistoryView, ShareHistoryView, PresenceHintView, PresencePromptView, PublicRoomView, RoomAttachmentKind, RoomAttachmentView, RoomCosmeticsView, RoomOpenView, RoomPreviewView, RoomListItemView, RoomTag, RoomVersionView, RoomVersionsView};
use crate::view::FORUM_ROOM_TYPE;
use crate::{Core, ResultExt, power_levels, view, SignedIn};

const WIDGETS_EVENT_TYPE: &str = "im.vector.modular.widgets";
const POLICY_ROOM_TYPE: &str = "m.policy";
const POLICY_ROOM_TYPE_UNSTABLE: &str = "support.feline.policy.lists.msc.v1";

domain! {
    open,
    presence_prompt,
    answer_presence_prompt,
    list_item,
    preview,
    join,
    knock,
    via_servers,
    upgrade_servers,
    leave,
    invite,
    create,
    create_dm,
    versions,
    upgrade,
    public_rooms,
    directory_visibility,
    set_directory_visibility,
    aliases,
    create_alias,
    delete_alias,
    canonical_alias,
    set_canonical_alias,
    replaced_rooms,
    set_tombstone,
    report,
    set_tag,
    attachments,
    cosmetics,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum DirectoryRoomType {
    Rooms,
    Spaces,
}

/// Room types that Sable supports.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RoomKind {
    /// No room type
    Text,
    /// `m.space`
    Space,
    /// `org.matrix.msc3417.call`
    Voice,
    /// `pl.chrome.forum`
    Forum,
    /// `chat.commet.calendar`
    Calendar,
    /// `m.policy` / `support.feline.policy.lists.msc.v1`
    Policy,
}

impl RoomKind {
    /// Create a [`RoomKind`] from a [`RoomType`].
    ///
    /// Returns None if the room type is unsupported by Sable.
    #[must_use]
    pub fn from_room_type(room_type: Option<&RoomType>) -> Option<Self> {
        match room_type {
            None => Some(Self::Text),
            Some(RoomType::Space) => Some(Self::Space),
            Some(RoomType::Call) => Some(Self::Voice),
            Some(other) if other.as_str() == FORUM_ROOM_TYPE => Some(Self::Forum),
            Some(other) if other.as_str() == CALENDAR_ROOM_TYPE => Some(Self::Calendar),
            Some(other) if other.as_str() == POLICY_ROOM_TYPE => Some(Self::Policy),
            Some(other) if other.as_str() == POLICY_ROOM_TYPE_UNSTABLE => Some(Self::Policy),
            Some(_) => None,
        }
    }

    /// Convert this [`RoomKind`] to a [`RoomType`].
    #[must_use]
    pub fn as_room_type(&self) -> Option<RoomType> {
        match self {
            Self::Text => None,
            Self::Space => Some(RoomType::Space),
            Self::Voice => Some(RoomType::Call),
            Self::Forum => Some(RoomType::from(FORUM_ROOM_TYPE)),
            Self::Calendar => Some(RoomType::from(CALENDAR_ROOM_TYPE)),
            Self::Policy => Some(RoomType::from(POLICY_ROOM_TYPE)),
        }
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct OpenParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for OpenParams {
    type Ok = RoomOpenView;

    async fn run(self, session: &SignedIn) -> Result<RoomOpenView, RpcError> {
        let room_id = self.room_id;
        let (access, power_level_tags, widgets, pinned_event_ids) = futures_util::join!(
            session.room_access(&room_id),
            session.room_state_event_content(
                room_id.clone(),
                power_levels::TAGS_EVENT.to_owned(),
                String::new(),
            ),
            session.room_state_events(&room_id, WIDGETS_EVENT_TYPE),
            session.pinned_events(&room_id),
        );
        if pinned_event_ids.as_ref().is_ok_and(|ids| !ids.is_empty()) {
            session.watch_pinned(&room_id).await;
        }
        let predecessor = session
            .room(&room_id)
            .ok()
            .and_then(|room| view::predecessor(&room));
        let (permissions, power_levels) = access?;
        Ok(RoomOpenView {
            permissions,
            power_levels,
            power_level_tags: power_levels::parse_tags(
                power_level_tags
                    .unwrap_or_else(|error| {
                        tracing::warn!(?error, "power level tags unavailable");
                        None
                    })
                    .as_ref(),
            ),
            widgets: widgets.unwrap_or_else(|error| {
                tracing::warn!(?error, "widgets unavailable");
                Vec::new()
            }),
            pinned_event_ids: pinned_event_ids.unwrap_or_else(|error| {
                tracing::warn!(?error, "pinned events unavailable");
                Vec::new()
            }),
            predecessor,
        })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ListItemParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for ListItemParams {
    type Ok = RoomListItemView;

    async fn run(self, session: &SignedIn) -> Result<RoomListItemView, RpcError> {
        let room = session.room(&self.room_id)?;
        let rules = session.push_rules().await?.snapshot();
        Ok(view::listless_room_list_item(room, &rules, &session.core().nicknames()).await)
    }
}

/// Accepting an invite is `JoinRoom`, declining it `LeaveRoom`.
///
/// Describes a room this account has not joined, so a link to one can be
/// shown before committing to the join.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PreviewParams {
    /// A room id or an alias, as `JoinRoom` takes.
    pub address: String,
    /// Servers to try when the id is not resolvable on ours, or empty.
    pub via: Vec<String>,
}

impl SessionHandler for PreviewParams {
    type Ok = RoomPreviewView;

    async fn run(self, session: &SignedIn) -> Result<RoomPreviewView, RpcError> {
        session.room_preview(&self.address, &self.via).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct JoinParams {
    /// A room id or an alias. A pasted address could be either.
    pub address: String,
    /// Servers to try when the id is not resolvable on ours, or empty.
    pub via: Vec<String>,
}

impl SessionHandler for JoinParams {
    /// Resolved, since the caller may have joined by alias.
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        let room_id = session.join_room(&self.address, &self.via).await?;
        session.follow_presence_upgrade(&room_id).await;
        Ok(room_id.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PresencePromptParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for PresencePromptParams {
    type Ok = Option<PresencePromptView>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<PresencePromptView>, RpcError> {
        match core.signed_in() {
            Ok(session) => session.presence_prompt(&self.room_id).await,
            Err(_) => Ok(None),
        }
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AnswerPresencePromptParams {
    pub prompt: PresencePromptView,
    pub share: bool,
}

impl SessionHandler for AnswerPresencePromptParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.answer_presence_prompt(self.prompt, self.share).await
    }
}

/// Asks to be let into a `knock` room. A separate endpoint from joining, and
/// the only one that works when the join rule is `knock`.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct KnockParams {
    pub address: String,
    pub via: Vec<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

impl SessionHandler for KnockParams {
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        session.knock_room(&self.address, &self.via, self.reason)
            .await
            .map(|room_id| room_id.to_string())
    }
}

/// The servers to advertise in a permalink to this room, per the routing
/// rules in the spec appendices. Empty when the room has a canonical alias,
/// which is routable on its own.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ViaServersParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for ViaServersParams {
    type Ok = Vec<String>;

    async fn run(self, session: &SignedIn) -> Result<Vec<String>, RpcError> {
        let room = session.room(&self.room_id)?;
        Ok(crate::routing::Route::of(&room)
            .await
            .map(|route| route.to_strings())
            .unwrap_or_default())
    }
}

/// The servers to join a tombstoned room's successor through. Not for links.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UpgradeServersParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for UpgradeServersParams {
    type Ok = Vec<String>;

    async fn run(self, session: &SignedIn) -> Result<Vec<String>, RpcError> {
        let room = session.room(&self.room_id)?;
        Ok(crate::routing::upgrade_servers(&room)
            .await
            .iter()
            .map(ToString::to_string)
            .collect())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct LeaveParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for LeaveParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.room(&self.room_id)?
            .leave()
            .await
            .or_failed(session.core(), "leave_room")?;

        // Keeping it would hand a stale timeline back on rejoin.
        let removed = session.state().timelines.lock().remove(&self.room_id);
        drop(removed);

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct InviteParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl SessionHandler for InviteParams {
    type Ok = InviteHistoryView;

    async fn run(self, session: &SignedIn) -> Result<InviteHistoryView, RpcError> {
        let room = session.room(&self.room_id)?;
        // MSC4268 sends the keys ahead of the invite. `invite_user_by_id`
        // gives up on the invite when that fails, so both steps happen here.
        let history =
            match super::encryption::share_history(session, &room, &self.user_id, true).await {
                Ok(ShareHistoryView::Shared) => InviteHistoryView::Shared,
                Ok(_) => InviteHistoryView::NotShared,
                // `share_history` has reported the error.
                Err(_) => InviteHistoryView::Failed,
            };
        let recipient = InvitationRecipient::UserId(InviteUserId::new(self.user_id));
        room.client()
            .send(invite_user::v3::Request::new(self.room_id, recipient))
            .await
            .or_failed(session.core(), "invite_user")?;
        // The next send reloads the members, so the invitee gets its key.
        room.mark_members_missing();

        Ok(history)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CreateParams {
    #[serde(default)]
    pub name: Option<String>,
    pub topic: Option<String>,
    pub kind: RoomKind,
    /// Published in the directory, joinable by link.
    pub public: bool,
    /// Ignored for a space or a public room.
    pub encrypted: bool,
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub invite: Vec<OwnedUserId>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub additional_creators: Vec<OwnedUserId>,
    /// Adds an `m.space.child` edge from this space.
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    #[serde(default)]
    pub parent_space: Option<OwnedRoomId>,
    pub alias: Option<String>,
    pub room_version: Option<String>,
    #[serde(default)]
    pub join_rule: Option<CreateJoinRuleView>,
    pub federate: bool,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub predecessor: Option<OwnedRoomId>,
}

/// `room_version` is left out so the server applies the top-level
/// `room_version` or its default; some servers keep a value sent here.
fn creation_content(
    room_type: Option<RoomType>,
    federate: bool,
    predecessor: Option<OwnedRoomId>,
    additional_creators: &[OwnedUserId],
) -> serde_json::Value {
    let mut creation = serde_json::Map::new();
    if let Some(room_type) = room_type {
        creation.insert("type".into(), room_type.to_string().into());
    }
    creation.insert("m.federate".into(), federate.into());
    if let Some(room_id) = predecessor {
        creation.insert("predecessor".into(), serde_json::json!({ "room_id": room_id }));
    }
    if !additional_creators.is_empty() {
        creation.insert(
            "additional_creators".into(),
            serde_json::json!(additional_creators),
        );
    }
    creation.into()
}

async fn canonical_parent(
    client: &matrix_sdk::Client,
    space_id: Option<&OwnedRoomId>,
) -> Option<Raw<AnyInitialStateEvent>> {
    let space_id = space_id?;
    let via = match client.get_room(space_id) {
        Some(space) => crate::routing::Route::cached(&space)
            .await
            .map(crate::routing::Route::into_servers)
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let mut parent = SpaceParentEventContent::new(via);
    parent.canonical = true;
    Some(InitialStateEvent::new(space_id.clone(), parent).to_raw_any())
}

fn configure_voice_room(
    request: &mut create_room::v3::Request,
    encrypted: bool,
    core: &Core,
) -> Result<(), RpcError> {
    // The override is a shallow merge: naming `events` drops the
    // server's default map, so it is re-stated.
    request.power_level_content_override = Some(
        Raw::new(&voice_power_level_override())
            .or_failed(core, "create_room_call_power_levels")?
            .cast_unchecked(),
    );
    request.initial_state.push(
        Raw::new(&StateEventOut {
            kind: view::CALL_TYPE,
            state_key: "",
            content: crate::room_settings::EmptyContent {},
        })
        .or_failed(core, "create_room_call_state")?
        .cast_unchecked(),
    );
    request.initial_state.push(
        Raw::new(&StateEventOut {
            kind: view::RTC_SLOT_TYPE,
            state_key: view::CALL_SLOT_ID,
            content: crate::calls::OpenSlot::new(encrypted),
        })
        .or_failed(core, "create_room_call_slot")?
        .cast_unchecked(),
    );
    Ok(())
}

impl SessionHandler for CreateParams {
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        let client = session.client();
        let mut request = create_room::v3::Request::new();
        request.name = self.name;
        if let Some(topic) = self.topic.as_deref() {
            request.initial_state.push(
                InitialStateEvent::with_empty_state_key(super::room_state::topic_content(topic))
                    .to_raw_any(),
            );
        }
        request.invite = self.invite;
        for creator in &self.additional_creators {
            if !request.invite.contains(creator) {
                request.invite.push(creator.clone());
            }
        }
        request.room_alias_name = self.alias;
        request.room_version = self.room_version
            .map(RoomVersionId::try_from)
            .transpose()
            .or_failed(session.core(), "create_room_room_version")?;
        request.visibility = if self.public {
            Visibility::Public
        } else {
            Visibility::Private
        };
        request.preset = Some(if self.public {
            RoomPreset::PublicChat
        } else {
            RoomPreset::PrivateChat
        });
        if let Some(hint) = session
            .presence_hint_initial_state(if self.public {
                PresenceHintView::Forbid
            } else {
                PresenceHintView::Suggest
            })
            .await
        {
            request.initial_state.push(hint);
        }

        let room_type = self.kind.as_room_type();
        if room_type.is_some()
            || !self.federate
            || self.predecessor.is_some()
            || !self.additional_creators.is_empty()
        {
            let creation = creation_content(
                room_type,
                self.federate,
                self.predecessor,
                &self.additional_creators,
            );
            request.creation_content = Some(
                Raw::new(&creation)
                    .or_failed(session.core(), "create_room_creation_content")?
                    .cast_unchecked(),
            );
        }

        if let Some(rule) = join_rule_content(self.join_rule, self.parent_space.as_deref()) {
            request.initial_state.push(rule.to_raw_any());
        }

        if let Some(rules) = session.delegated_rules_state(self.parent_space.as_ref()).await {
            request.initial_state.push(rules);
        }
        request.initial_state.extend(canonical_parent(client, self.parent_space.as_ref()).await);

        // Anyone can join and read a public room, so encryption only
        // breaks previews.
        let encrypted = self.encrypted && !self.public;
        if matches!(self.kind, RoomKind::Voice) {
            configure_voice_room(&mut request, encrypted, session.core())?;
        }

        if encrypted {
            request.initial_state.push(
                InitialStateEvent::with_empty_state_key(
                    RoomEncryptionEventContent::with_recommended_defaults(),
                )
                .to_raw_any(),
            );
        }

        let room = client
            .create_room(request)
            .await
            .or_failed(session.core(), "create_room")?;

        if matches!(self.kind, RoomKind::Calendar)
            && let Err(error) = session.calendar_id(&room).await
        {
            tracing::warn!(?error, "calendar setup failed");
        }

        if let Some(space_id) = self.parent_space {
            session.add_to_space(&space_id, room.room_id(), None).await?;
        }

        Ok(room.room_id().to_string())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CreateDmParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    #[serde(default)]
    pub encrypted: Option<bool>,
    /// Whether a DM created because none matched is encrypted, when `encrypted` leaves it open.
    pub encrypt_new: bool,
}

impl SessionHandler for CreateDmParams {
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        let Self {
            user_id,
            encrypted,
            encrypt_new,
        } = self;
        let client = session.client();
        let existing = client.get_dm_rooms(&user_id).find(|room| {
            !room.is_tombstoned()
                && encrypted.is_none_or(|wanted| room.encryption_state().is_encrypted() == wanted)
        });
        let room = if let Some(room) = existing {
            room
        } else {
            let own = client.user_id() == Some(&*user_id);
            if !own
                && let Err(error) = client.account().fetch_user_profile_of(&user_id).await
                && is_not_found(&error)
            {
                return Err(session.core().rpc_error("create_dm_profile", &error));
            }
            let mut request = create_room::v3::Request::new();
            // The sender already creates the room, and may not be listed again.
            if !own {
                request.creation_content = Some(
                    Raw::new(&serde_json::json!({ "additional_creators": [&user_id] }))
                        .or_failed(session.core(), "create_dm_creation_content")?
                        .cast_unchecked(),
                );
                request.invite = vec![user_id.clone()];
            }
            request.is_direct = true;
            request.preset = Some(RoomPreset::TrustedPrivateChat);
            if encrypted == Some(true) || (encrypted.is_none() && encrypt_new) {
                request.initial_state.push(
                    InitialStateEvent::with_empty_state_key(
                        RoomEncryptionEventContent::with_recommended_defaults(),
                    )
                    .to_raw_any(),
                );
            }
            if let Some(hint) = session
                .presence_hint_initial_state(PresenceHintView::Suggest)
                .await
            {
                request.initial_state.push(hint);
            }
            let room = client
                .create_room(request)
                .await
                .or_failed(session.core(), "create_dm")?;
            // The SDK marks a direct room only from its invitees.
            if own {
                client
                    .account()
                    .mark_as_dm(room.room_id(), &[user_id])
                    .await
                    .or_failed(session.core(), "create_dm_mark")?;
            }
            room
        };

        Ok(room.room_id().to_string())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct VersionsParams {}

impl SessionHandler for VersionsParams {
    type Ok = RoomVersionsView;

    async fn run(self, session: &SignedIn) -> Result<RoomVersionsView, RpcError> {
        let response = session
            .client()
            .send(get_capabilities::v3::Request::new())
            .await
            .or_failed(session.core(), "room_versions")?;

        let versions = response.capabilities.room_versions;
        let mut available: Vec<RoomVersionView> = versions
            .available
            .into_iter()
            .map(|(id, stability)| RoomVersionView {
                id: id.to_string(),
                stable: stability == RoomVersionStability::Stable,
            })
            .collect();
        available.sort_by(|a, b| {
            b.id.parse::<u32>()
                .ok()
                .cmp(&a.id.parse::<u32>().ok())
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(RoomVersionsView { default: versions.default.to_string(), available })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UpgradeParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub new_version: String,
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub additional_creators: Vec<OwnedUserId>,
}

impl SessionHandler for UpgradeParams {
    /// The replacement room.
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        let mut request = upgrade_room::v3::Request::new(
            self.room_id,
            RoomVersionId::try_from(self.new_version).or_failed(session.core(), "upgrade_room")?,
        );
        request.additional_creators = self.additional_creators;

        let client = session.client();
        let old_room = request.room_id.clone();
        let response = client
            .send(request)
            .await
            .or_failed(session.core(), "upgrade_room")?;
        session.core().copy_room_packs(client, &old_room, &response.replacement_room)
            .await;
        session.carry_space_links(&old_room, &response.replacement_room)
            .await;
        session.copy_presence_hint(&old_room, &response.replacement_room)
            .await;
        session.carry_presence_sharing(&old_room, &response.replacement_room)
            .await;

        Ok(response.replacement_room.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PublicRoomsParams {
    #[serde(default)]
    pub server: Option<String>,
    pub search: Option<String>,
    pub since: Option<String>,
    #[serde(default)]
    pub room_type: Option<DirectoryRoomType>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PublicRoomsOk {
    pub rooms: Vec<PublicRoomView>,
    pub next_batch: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub total: Option<u64>,
}

impl SessionHandler for PublicRoomsParams {
    type Ok = PublicRoomsOk;
    const ENDS_WITH_SESSION: bool = true;

    async fn run(self, session: &SignedIn) -> Result<PublicRoomsOk, RpcError> {
        session.public_rooms(self)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DirectoryVisibilityParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for DirectoryVisibilityParams {
    /// Whether the room is published.
    type Ok = bool;

    async fn run(self, session: &SignedIn) -> Result<bool, RpcError> {
        let response = session
            .client()
            .send(get_room_visibility::v3::Request::new(self.room_id))
            .await
            .or_failed(session.core(), "room_directory_visibility")?;

        Ok(response.visibility == Visibility::Public)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetDirectoryVisibilityParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub public: bool,
}

impl SessionHandler for SetDirectoryVisibilityParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let visibility = if self.public {
            Visibility::Public
        } else {
            Visibility::Private
        };

        session.client()
            .send(set_room_visibility::v3::Request::new(
                self.room_id,
                visibility,
            ))
            .await
            .or_failed(session.core(), "set_room_directory_visibility")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AliasesParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for AliasesParams {
    type Ok = Vec<String>;

    async fn run(self, session: &SignedIn) -> Result<Vec<String>, RpcError> {
        let response = session
            .client()
            .send(aliases::v3::Request::new(self.room_id))
            .await
            .or_failed(session.core(), "room_aliases")?;

        Ok(response
            .aliases
            .into_iter()
            .map(|alias| alias.to_string())
            .collect())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CreateAliasParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub alias: String,
}

impl SessionHandler for CreateAliasParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let alias = RoomAliasId::parse(self.alias).or_failed(session.core(), "create_room_alias")?;

        session.client()
            .send(create_alias::v3::Request::new(alias, self.room_id))
            .await
            .or_failed(session.core(), "create_room_alias")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DeleteAliasParams {
    pub alias: String,
}

impl SessionHandler for DeleteAliasParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let alias = RoomAliasId::parse(self.alias).or_failed(session.core(), "delete_room_alias")?;

        session.client()
            .send(delete_alias::v3::Request::new(alias))
            .await
            .or_failed(session.core(), "delete_room_alias")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CanonicalAliasParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CanonicalAliasOk {
    pub alias: Option<String>,
    pub alt_aliases: Vec<String>,
}

impl SessionHandler for CanonicalAliasParams {
    type Ok = CanonicalAliasOk;

    async fn run(self, session: &SignedIn) -> Result<CanonicalAliasOk, RpcError> {
        let (alias, alt_aliases) = session.canonical_alias(&self.room_id).await?;
        Ok(CanonicalAliasOk { alias, alt_aliases })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetCanonicalAliasParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub alias: Option<String>,
    pub alt_aliases: Vec<String>,
}

impl SessionHandler for SetCanonicalAliasParams {
    type Ok = CanonicalAliasOk;

    async fn run(self, session: &SignedIn) -> Result<CanonicalAliasOk, RpcError> {
        let (alias, alt_aliases) = session
            .set_canonical_alias(self.room_id, self.alias.as_deref(), &self.alt_aliases)
            .await?;
        Ok(CanonicalAliasOk { alias, alt_aliases })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ReplacedRoomsParams {}

impl SessionHandler for ReplacedRoomsParams {
    type Ok = Vec<RoomListItemView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<RoomListItemView>, RpcError> {
        let client = session.client();
        let rules = session.push_rules().await?.snapshot();
        let nicknames = session.core().nicknames();
        let mut rooms = Vec::new();
        for room in client.joined_rooms() {
            if room.is_tombstoned() {
                rooms.push(view::listless_room_list_item(room, &rules, &nicknames).await);
            }
        }
        Ok(rooms)
    }
}

/// Points readers of this room at `replacement_room` without upgrading it.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetTombstoneParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub replacement_room: OwnedRoomId,
    pub body: String,
}

impl SessionHandler for SetTombstoneParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.set_tombstone(self.room_id, &self.replacement_room, &self.body)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ReportParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub reason: String,
}

impl SessionHandler for ReportParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.report_room(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetTagParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub tag: RoomTag,
    /// False removes it.
    pub set: bool,
}

impl SessionHandler for SetTagParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let room = session.room(&self.room_id)?;
        let name = match self.tag {
            RoomTag::Favourite => TagName::Favorite,
        };

        if self.set {
            room.set_tag(name, TagInfo::new())
                .await
                .or_failed(session.core(), "set_room_tag")?;
        } else {
            room.remove_tag(name)
                .await
                .or_failed(session.core(), "remove_room_tag")?;
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AttachmentsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub kind: RoomAttachmentKind,
    pub limit: u32,
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AttachmentsOk {
    pub items: Vec<RoomAttachmentView>,
    pub next_batch: Option<String>,
}

impl SessionHandler for AttachmentsParams {
    type Ok = AttachmentsOk;

    async fn run(self, session: &SignedIn) -> Result<AttachmentsOk, RpcError> {
        let (items, next_batch) = session
            .room_attachments(
                &self.room_id,
                self.kind,
                (self.limit as usize).min(MAX_SEARCH_RESULTS),
                self.from.as_deref(),
            )
            .await?;
        Ok(AttachmentsOk { items, next_batch })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CosmeticsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub space_id: Option<OwnedRoomId>,
}

impl SessionHandler for CosmeticsParams {
    type Ok = RoomCosmeticsView;

    async fn run(self, session: &SignedIn) -> Result<RoomCosmeticsView, RpcError> {
        session.room_cosmetics(&self.room_id, self.space_id).await
    }
}

#[cfg(test)]
mod creation_content_tests {
    use super::*;

    #[test]
    fn omits_room_version() {
        let value = creation_content(None, false, None, &[]);
        assert_eq!(value, serde_json::json!({ "m.federate": false }));
    }

    #[test]
    fn carries_type_and_predecessor() {
        let room_id = OwnedRoomId::try_from("!old:example.org").unwrap();
        let value = creation_content(Some(RoomType::Space), true, Some(room_id), &[]);
        assert_eq!(
            value,
            serde_json::json!({
                "type": "m.space",
                "m.federate": true,
                "predecessor": { "room_id": "!old:example.org" },
            })
        );
    }
}
