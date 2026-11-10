use std::sync::Arc;

use matrix_sdk::ruma::api::client::alias::{create_alias, delete_alias};
use matrix_sdk::ruma::api::client::directory::{get_room_visibility, set_room_visibility};
use matrix_sdk::ruma::api::client::discovery::get_capabilities;
use matrix_sdk::ruma::api::client::discovery::get_capabilities::v3::RoomVersionStability;
use matrix_sdk::ruma::api::client::room::Visibility;
use matrix_sdk::ruma::api::client::room::aliases;
use matrix_sdk::ruma::api::client::room::create_room::{self, v3::RoomPreset};
use matrix_sdk::ruma::api::client::room::upgrade_room;
use matrix_sdk::ruma::events::InitialStateEvent;
use matrix_sdk::ruma::events::room::encryption::RoomEncryptionEventContent;
use matrix_sdk::ruma::events::tag::{TagInfo, TagName};
use matrix_sdk::ruma::room::RoomType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{
    OwnedRoomId, OwnedUserId, RoomAliasId, RoomVersionId,
};
use serde::{Deserialize, Serialize};

use super::Handler;
use crate::calendar::CALENDAR_ROOM_TYPE;
use crate::search::MAX_SEARCH_RESULTS;
use crate::room_settings::StateEventOut;
use crate::room_settings::join_rule_content;
use crate::room_settings::voice_power_level_override;
use crate::protocol::{RpcError, CreateJoinRuleView, PresenceHintView, PresencePromptView, PublicRoomView, RoomAttachmentKind, RoomAttachmentView, RoomCosmeticsView, RoomOpenView, RoomPreviewView, RoomListItemView, RoomTag, RoomVersionView, RoomVersionsView};
use crate::view::FORUM_ROOM_TYPE;
use crate::{Core, ResultExt, power_levels, view};

const WIDGETS_EVENT_TYPE: &str = "im.vector.modular.widgets";

domain! {
    open,
    presence_prompt,
    answer_presence_prompt,
    list_item,
    preview,
    join,
    knock,
    via_servers,
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
        }
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct OpenParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for OpenParams {
    type Ok = RoomOpenView;

    async fn run(self, core: &Arc<Core>) -> Result<RoomOpenView, RpcError> {
        let room_id = self.room_id;
        let (access, power_level_tags, widgets, pinned_event_ids) = futures_util::join!(
            core.room_access(&room_id),
            core.room_state_event_content(
                room_id.clone(),
                power_levels::TAGS_EVENT.to_owned(),
                String::new(),
            ),
            core.room_state_events(&room_id, WIDGETS_EVENT_TYPE),
            core.pinned_events(&room_id),
        );
        if pinned_event_ids.as_ref().is_ok_and(|ids| !ids.is_empty()) {
            core.watch_pinned(&room_id).await;
        }
        let predecessor = core
            .room(&room_id)
            .await
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

impl Handler for ListItemParams {
    type Ok = RoomListItemView;

    async fn run(self, core: &Arc<Core>) -> Result<RoomListItemView, RpcError> {
        let room = core.room(&self.room_id).await?;
        let rules = core.push_rules().await?.snapshot().await;
        Ok(view::listless_room_list_item(room, &rules, &core.nicknames()).await)
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

impl Handler for PreviewParams {
    type Ok = RoomPreviewView;

    async fn run(self, core: &Arc<Core>) -> Result<RoomPreviewView, RpcError> {
        core.room_preview(&self.address, &self.via).await
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

impl Handler for JoinParams {
    /// Resolved, since the caller may have joined by alias.
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        let room_id = core.join_room(&self.address, &self.via).await?;
        core.follow_presence_upgrade(&room_id).await;
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
        core.presence_prompt(&self.room_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AnswerPresencePromptParams {
    pub prompt: PresencePromptView,
    pub share: bool,
}

impl Handler for AnswerPresencePromptParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.answer_presence_prompt(self.prompt, self.share).await
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

impl Handler for KnockParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.knock_room(&self.address, &self.via, self.reason)
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

impl Handler for ViaServersParams {
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
        let room = core.room(&self.room_id).await?;
        core.room_via_servers(&room).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct LeaveParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for LeaveParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.room(&self.room_id)
            .await?
            .leave()
            .await
            .or_failed(core, "leave_room")?;

        // Keeping it would hand a stale timeline back on rejoin.
        core.timelines.lock().await.remove(&self.room_id);

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

impl Handler for InviteParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.room(&self.room_id)
            .await?
            .invite_user_by_id(&self.user_id)
            .await
            .or_failed(core, "invite_user")?;

        Ok(())
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
) -> serde_json::Value {
    let mut creation = serde_json::Map::new();
    if let Some(room_type) = room_type {
        creation.insert("type".into(), room_type.to_string().into());
    }
    creation.insert("m.federate".into(), federate.into());
    if let Some(room_id) = predecessor {
        creation.insert("predecessor".into(), serde_json::json!({ "room_id": room_id }));
    }
    creation.into()
}

impl Handler for CreateParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        let client = core.client().await?;
        let mut request = create_room::v3::Request::new();
        request.name = self.name;
        if let Some(topic) = self.topic.as_deref() {
            request.initial_state.push(
                InitialStateEvent::with_empty_state_key(super::room_state::topic_content(topic))
                    .to_raw_any(),
            );
        }
        request.invite = self.invite;
        request.room_alias_name = self.alias;
        request.room_version = self.room_version
            .map(RoomVersionId::try_from)
            .transpose()
            .or_failed(core, "create_room_room_version")?;
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
        if let Some(hint) = core
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
        if room_type.is_some() || !self.federate || self.predecessor.is_some() {
            let creation = creation_content(room_type, self.federate, self.predecessor);
            request.creation_content = Some(
                Raw::new(&creation)
                    .or_failed(core, "create_room_creation_content")?
                    .cast_unchecked(),
            );
        }

        if let Some(rule) = join_rule_content(self.join_rule, self.parent_space.as_deref()) {
            request.initial_state.push(rule.to_raw_any());
        }

        if matches!(self.kind, RoomKind::Voice) {
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
                    content: crate::calls::OpenSlot::new(self.encrypted && !self.public),
                })
                .or_failed(core, "create_room_call_slot")?
                .cast_unchecked(),
            );
        }

        // Anyone can join and read a public room, so encryption only
        // breaks previews.
        if self.encrypted && !self.public {
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
            .or_failed(core, "create_room")?;

        if matches!(self.kind, RoomKind::Calendar)
            && let Err(error) = core.calendar_id(&room).await
        {
            tracing::warn!(?error, "calendar setup failed");
        }

        if let Some(space_id) = self.parent_space {
            core.add_to_space(&space_id, room.room_id(), None).await?;
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

impl Handler for CreateDmParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        let Self {
            user_id,
            encrypted,
            encrypt_new,
        } = self;
        let client = core.client().await?;
        let existing = client.get_dm_rooms(&user_id).find(|room| {
            !room.is_tombstoned()
                && encrypted.is_none_or(|wanted| room.encryption_state().is_encrypted() == wanted)
        });
        let room = if let Some(room) = existing {
            room
        } else {
            let mut request = create_room::v3::Request::new();
            request.creation_content = Some(
                Raw::new(&serde_json::json!({ "additional_creators": [&user_id] }))
                    .or_failed(core, "create_dm_creation_content")?
                    .cast_unchecked(),
            );
            request.invite = vec![user_id];
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
            if let Some(hint) = core
                .presence_hint_initial_state(PresenceHintView::Suggest)
                .await
            {
                request.initial_state.push(hint);
            }
            client
                .create_room(request)
                .await
                .or_failed(core, "create_dm")?
        };

        Ok(room.room_id().to_string())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct VersionsParams {}

impl Handler for VersionsParams {
    type Ok = RoomVersionsView;

    async fn run(self, core: &Arc<Core>) -> Result<RoomVersionsView, RpcError> {
        let response = core
            .client()
            .await?
            .send(get_capabilities::v3::Request::new())
            .await
            .or_failed(core, "room_versions")?;

        let versions = response.capabilities.room_versions;
        Ok(RoomVersionsView {
            default: versions.default.to_string(),
            available: versions
                .available
                .into_iter()
                .map(|(id, stability)| RoomVersionView {
                    id: id.to_string(),
                    stable: stability == RoomVersionStability::Stable,
                })
                .collect(),
        })
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

impl Handler for UpgradeParams {
    /// The replacement room.
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        let mut request = upgrade_room::v3::Request::new(
            self.room_id,
            RoomVersionId::try_from(self.new_version).or_failed(core, "upgrade_room")?,
        );
        request.additional_creators = self.additional_creators;

        let client = core.client().await?;
        let old_room = request.room_id.clone();
        let response = client
            .send(request)
            .await
            .or_failed(core, "upgrade_room")?;
        core.copy_room_packs(&client, &old_room, &response.replacement_room)
            .await;
        core.copy_presence_hint(&old_room, &response.replacement_room)
            .await;
        core.carry_presence_sharing(&old_room, &response.replacement_room)
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

impl Handler for PublicRoomsParams {
    type Ok = PublicRoomsOk;

    async fn run(self, core: &Arc<Core>) -> Result<PublicRoomsOk, RpcError> {
        core.public_rooms(self)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DirectoryVisibilityParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for DirectoryVisibilityParams {
    /// Whether the room is published.
    type Ok = bool;

    async fn run(self, core: &Arc<Core>) -> Result<bool, RpcError> {
        let response = core
            .client()
            .await?
            .send(get_room_visibility::v3::Request::new(self.room_id))
            .await
            .or_failed(core, "room_directory_visibility")?;

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

impl Handler for SetDirectoryVisibilityParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let visibility = if self.public {
            Visibility::Public
        } else {
            Visibility::Private
        };

        core.client()
            .await?
            .send(set_room_visibility::v3::Request::new(
                self.room_id,
                visibility,
            ))
            .await
            .or_failed(core, "set_room_directory_visibility")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AliasesParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for AliasesParams {
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
        let response = core
            .client()
            .await?
            .send(aliases::v3::Request::new(self.room_id))
            .await
            .or_failed(core, "room_aliases")?;

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

impl Handler for CreateAliasParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let alias = RoomAliasId::parse(self.alias).or_failed(core, "create_room_alias")?;

        core.client()
            .await?
            .send(create_alias::v3::Request::new(alias, self.room_id))
            .await
            .or_failed(core, "create_room_alias")?;

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DeleteAliasParams {
    pub alias: String,
}

impl Handler for DeleteAliasParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let alias = RoomAliasId::parse(self.alias).or_failed(core, "delete_room_alias")?;

        core.client()
            .await?
            .send(delete_alias::v3::Request::new(alias))
            .await
            .or_failed(core, "delete_room_alias")?;

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

impl Handler for CanonicalAliasParams {
    type Ok = CanonicalAliasOk;

    async fn run(self, core: &Arc<Core>) -> Result<CanonicalAliasOk, RpcError> {
        let (alias, alt_aliases) = core.canonical_alias(&self.room_id).await?;
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

impl Handler for SetCanonicalAliasParams {
    type Ok = CanonicalAliasOk;

    async fn run(self, core: &Arc<Core>) -> Result<CanonicalAliasOk, RpcError> {
        let (alias, alt_aliases) = core
            .set_canonical_alias(self.room_id, self.alias.as_deref(), &self.alt_aliases)
            .await?;
        Ok(CanonicalAliasOk { alias, alt_aliases })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ReplacedRoomsParams {}

impl Handler for ReplacedRoomsParams {
    type Ok = Vec<RoomListItemView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<RoomListItemView>, RpcError> {
        let client = core.client().await?;
        let rules = core.push_rules().await?.snapshot().await;
        let nicknames = core.nicknames();
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

impl Handler for SetTombstoneParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.set_tombstone(self.room_id, &self.replacement_room, &self.body)
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

impl Handler for ReportParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.report_room(self).await
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

impl Handler for SetTagParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let room = core.room(&self.room_id).await?;
        let name = match self.tag {
            RoomTag::Favourite => TagName::Favorite,
        };

        if self.set {
            room.set_tag(name, TagInfo::new())
                .await
                .or_failed(core, "set_room_tag")?;
        } else {
            room.remove_tag(name)
                .await
                .or_failed(core, "remove_room_tag")?;
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

impl Handler for AttachmentsParams {
    type Ok = AttachmentsOk;

    async fn run(self, core: &Arc<Core>) -> Result<AttachmentsOk, RpcError> {
        let (items, next_batch) = core
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

impl Handler for CosmeticsParams {
    type Ok = RoomCosmeticsView;

    async fn run(self, core: &Arc<Core>) -> Result<RoomCosmeticsView, RpcError> {
        core.room_cosmetics(&self.room_id, self.space_id).await
    }
}

#[cfg(test)]
mod creation_content_tests {
    use super::*;

    #[test]
    fn omits_room_version() {
        let value = creation_content(None, false, None);
        assert_eq!(value, serde_json::json!({ "m.federate": false }));
    }

    #[test]
    fn carries_type_and_predecessor() {
        let room_id = OwnedRoomId::try_from("!old:example.org").unwrap();
        let value = creation_content(Some(RoomType::Space), true, Some(room_id));
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
