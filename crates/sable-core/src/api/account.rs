use std::sync::Arc;
use std::sync::atomic::Ordering;

use matrix_sdk::ruma::api::client::membership::get_mutual_rooms;
use matrix_sdk::ruma::api::client::profile::{PropagateTo, set_profile_field};
use matrix_sdk::ruma::profile::{ProfileFieldName, ProfileFieldValue};
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, OwnedUserId, UserId};
use serde::{Deserialize, Serialize};

use super::{Handler, Json};
use crate::media::mxc_uri;
use crate::profile_overrides::OverrideEdit;
use crate::profiles::profile_view;
use crate::protocol::{BookmarkView, NotificationModeView, RpcCode, RpcError, FieldEdit, InviteTriageView, MediaPreviewConfigView, MediaPreviewsView, MutualRoomView, PresenceSharingEdit, PresenceOverrideView, PresenceSharingView, PresenceView, ProfileOverridesView, ProfileView, SealedAccountDataView, UserDirectoryEntryView};
use crate::{Core, ResultExt};

domain! {
    set_read_receipts,
    user_profile,
    user_relations,
    well_known,
    data_types,
    data,
    set_data,
    sealed_data,
    set_sealed_data,
    set_display_name,
    set_avatar_url,
    set_profile_field,
    contacts,
    ignored_users,
    invite_triage,
    set_direct,
    ignore_user,
    unignore_user,
    report_user,
    deactivate_account,
    set_presence,
    set_device_activity,
    fetch_presence,
    presence_sharing,
    edit_presence_sharing,
    presence_override,
    set_presence_override,
    search_user_directory,
    dismissed_invites,
    set_invite_dismissed,
    bookmarks,
    set_bookmark,
    media_preview_config,
    set_media_preview_config,
    set_room_media_previews,
    dm_spaces,
    set_dm_spaces,
    space_notifications,
    set_space_notification,
    set_space_notification_exempt,
    profile_overrides,
    set_profile_override,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DeactivateAccountParams {
    #[serde(default)]
    pub password: Option<String>,
}

impl Handler for DeactivateAccountParams {
    type Ok = Option<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<String>, RpcError> {
        core.deactivate_account(self.password).await
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ProfilePropagationView {
    All,
    Unchanged,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AvatarEditView {
    Keep,
    Clear,
    Url {
        url: String,
    },
    /// Encrypted in the webview with the account data key in hand.
    Encrypted {
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
        file: serde_json::Value,
    },
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UserProfileParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl Handler for UserProfileParams {
    type Ok = ProfileView;

    async fn run(self, core: &Arc<Core>) -> Result<ProfileView, RpcError> {
        let response = core
            .client()
            .await?
            .account()
            .fetch_user_profile_of(&self.user_id)
            .await
            .map_err(|error| core.profile_error(&error))?;
        let mut profile = profile_view(self.user_id, &response);
        core.nicknames().apply_profile(&mut profile);
        Ok(profile)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UserRelationsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UserRelationsOk {
    pub mutual_rooms: Vec<MutualRoomView>,
    pub ignored: bool,
}

impl Handler for UserRelationsParams {
    type Ok = UserRelationsOk;

    async fn run(self, core: &Arc<Core>) -> Result<UserRelationsOk, RpcError> {
        let client = core.client().await?;
        let ignored = ignored_users(core)
            .await?
            .iter()
            .any(|ignored| ignored == self.user_id.as_str());
        let mutual_rooms = fetch_mutual_rooms(&client, &self.user_id)
            .await
            .or_failed(core, "user_relations")?;

        Ok(UserRelationsOk {
            mutual_rooms,
            ignored,
        })
    }
}

async fn fetch_mutual_rooms(
    client: &matrix_sdk::Client,
    user_id: &UserId,
) -> Result<Vec<MutualRoomView>, matrix_sdk::HttpError> {
    let mut rooms = Vec::new();
    let mut from = None;
    loop {
        let mut request = get_mutual_rooms::v1::Request::new(user_id.to_owned());
        request.from = from;
        let response = match client.send(request).await {
            Ok(response) => response,
            Err(matrix_sdk::HttpError::IntoHttp(
                matrix_sdk::ruma::api::error::IntoHttpError::NoUnstablePath,
            )) => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        rooms.extend(response.joined.into_iter().map(|room_id| {
            let room = client.get_room(&room_id);
            MutualRoomView {
                name: room.as_ref().and_then(|room| {
                    room.cached_display_name()
                        .map(|name| name.to_string())
                        .or_else(|| room.name())
                }),
                is_space: room.as_ref().is_some_and(|room| room.is_space()),
                room_id,
            }
        }));
        from = response.next_batch;
        if from.is_none() {
            return Ok(rooms);
        }
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct WellKnownParams {}

impl Handler for WellKnownParams {
    type Ok = Option<Json>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<Json>, RpcError> {
        Ok(core.well_known().await?.map(Json))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DataTypesParams {}

impl Handler for DataTypesParams {
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
        core.account_data_types().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DataParams {
    pub event_type: String,
}

impl Handler for DataParams {
    type Ok = Option<Json>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<Json>, RpcError> {
        core.remember_account_data_type(self.event_type.as_str())
            .await;
        let content = core
            .global_account_data(self.event_type.into(), "account_data")
            .await?
            .and_then(|raw| raw.deserialize_as::<serde_json::Value>().ok());
        Ok(content.map(Json))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetDataParams {
    pub event_type: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub content: serde_json::Value,
}

impl Handler for SetDataParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        // Server-managed since MSC4010.
        if matches!(self.event_type.as_str(), "m.push_rules" | "m.fully_read") {
            return Err(RpcCode::Unsupported.into());
        }
        core.set_account_data(&self.event_type, &self.content).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SealedDataParams {
    pub event_type: String,
}

impl Handler for SealedDataParams {
    type Ok = SealedAccountDataView;

    async fn run(self, core: &Arc<Core>) -> Result<SealedAccountDataView, RpcError> {
        core.remember_account_data_type(self.event_type.as_str())
            .await;
        core.sealed_account_data(&self.event_type).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetSealedDataParams {
    pub event_type: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub content: serde_json::Value,
}

impl Handler for SetSealedDataParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.remember_account_data_type(self.event_type.as_str())
            .await;
        core.set_sealed_account_data(&self.event_type, &self.content)
            .await
    }
}

/// `null` clears it.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetDisplayNameParams {
    #[serde(default)]
    pub name: Option<String>,
    pub propagate_to: ProfilePropagationView,
}

impl Handler for SetDisplayNameParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let client = core.client().await?;
        if client
            .unstable_features()
            .await
            .or_failed(core, "set_display_name")?
            .contains(&matrix_sdk::ruma::api::FeatureFlag::from(
                "computer.gingershaped.msc4466",
            ))
        {
            let value = ProfileFieldValue::new(
                "displayname",
                serde_json::Value::String(self.name.unwrap_or_default()),
            )
            .or_failed(core, "set_display_name")?;
            let mut request = set_profile_field::v3::Request::new(
                client.user_id().ok_or(RpcCode::NotLoggedIn)?.to_owned(),
                value,
            );
            request.propagate_to = profile_propagation(self.propagate_to);
            client
                .send(request)
                .await
                .or_failed(core, "set_display_name")?;
        } else {
            client
                .account()
                .set_display_name(self.name.as_deref())
                .await
                .or_failed(core, "set_display_name")?;
        }

        Ok(())
    }
}

/// An `mxc:` URI from the carrier's `uploadMedia`. `null` clears it.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetAvatarUrlParams {
    #[serde(default)]
    pub url: Option<String>,
    pub propagate_to: ProfilePropagationView,
}

impl Handler for SetAvatarUrlParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let url = match self.url {
            Some(url) => Some(mxc_uri(&url)?),
            None => None,
        };

        let client = core.client().await?;
        if client
            .unstable_features()
            .await
            .or_failed(core, "set_avatar_url")?
            .contains(&matrix_sdk::ruma::api::FeatureFlag::from(
                "computer.gingershaped.msc4466",
            ))
        {
            let value = ProfileFieldValue::new(
                "avatar_url",
                serde_json::Value::String(url.map(|url| url.to_string()).unwrap_or_default()),
            )
            .or_failed(core, "set_avatar_url")?;
            let mut request = set_profile_field::v3::Request::new(
                client.user_id().ok_or(RpcCode::NotLoggedIn)?.to_owned(),
                value,
            );
            request.propagate_to = profile_propagation(self.propagate_to);
            client
                .send(request)
                .await
                .or_failed(core, "set_avatar_url")?;
        } else {
            client
                .account()
                .set_avatar_url(url.as_deref())
                .await
                .or_failed(core, "set_avatar_url")?;
        }

        Ok(())
    }
}

const fn profile_propagation(view: ProfilePropagationView) -> PropagateTo {
    match view {
        ProfilePropagationView::All => PropagateTo::All,
        ProfilePropagationView::Unchanged => PropagateTo::Unchanged,
        ProfilePropagationView::None => PropagateTo::None,
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetProfileFieldParams {
    pub field: String,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Unknown>))]
    #[serde(default)]
    pub value: Option<serde_json::Value>,
}

impl Handler for SetProfileFieldParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let account = core.client().await?.account();
        match self.value {
            Some(value) => {
                let value = ProfileFieldValue::new(&self.field, value)
                    .map_err(|error| core.failed_with("set_profile_field_invalid_value", &error))?;
                account
                    .set_profile_field(value)
                    .await
                    .or_failed(core, "set_profile_field")?;
            }
            None => {
                account
                    .delete_profile_field(ProfileFieldName::from(self.field.as_str()))
                    .await
                    .or_failed(core, "delete_profile_field")?;
            }
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ContactsParams {}

impl Handler for ContactsParams {
    /// The account's email addresses.
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
        Ok(core
            .client()
            .await?
            .account()
            .get_3pids()
            .await
            .or_failed(core, "account_contacts")?
            .threepids
            .into_iter()
            .filter(|identifier| identifier.medium.as_str() == "email")
            .map(|identifier| identifier.address)
            .collect())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct IgnoredUsersParams {}

impl Handler for IgnoredUsersParams {
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
        ignored_users(core).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct InviteTriageParams {}

impl Handler for InviteTriageParams {
    type Ok = Vec<InviteTriageView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<InviteTriageView>, RpcError> {
        Ok(crate::invites::triage(core, &core.client().await?).await)
    }
}

/// `m.direct` is client-owned account data. Nothing else will correct it.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetDirectParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub direct: bool,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    #[serde(default)]
    pub user_id: Option<OwnedUserId>,
}

impl Handler for SetDirectParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.set_direct(&self.room_id, self.direct, self.user_id)
            .await
    }
}

/// Server-side, so it survives a reinstall.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct IgnoreUserParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl Handler for IgnoreUserParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        edit_ignored_users(core, &self.user_id, true, "ignore_user").await
    }
}

/// The SDK's `ignore_user` round-trips the list through a sorted map, which
/// rewrites the account data in key order. Editing the raw content keeps the
/// order the list was written in.
async fn edit_ignored_users(
    core: &Arc<Core>,
    user_id: &UserId,
    ignore: bool,
    label: &str,
) -> Result<(), RpcError> {
    if ignore && core.client().await?.user_id() == Some(user_id) {
        return Err(core.failed(label, "a user cannot ignore themselves"));
    }
    let current = core
        .global_account_data(IGNORED_USER_LIST.into(), label)
        .await?
        .and_then(|raw| raw.deserialize_as::<serde_json::Value>().ok());
    let Some(content) = with_ignored_user(current, user_id.as_str(), ignore) else {
        return Ok(());
    };
    core.put_global_account_data(IGNORED_USER_LIST.into(), &content, label)
        .await
}

/// Read from the account data, since the SDK's observable only fills once a sync changes the list.
async fn ignored_users(core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
    let content = core
        .global_account_data(IGNORED_USER_LIST.into(), "ignored_users")
        .await?
        .and_then(|raw| raw.deserialize_as::<serde_json::Value>().ok());
    Ok(content
        .as_ref()
        .and_then(|content| content.get("ignored_users")?.as_object())
        .map(|users| users.keys().cloned().collect())
        .unwrap_or_default())
}

const IGNORED_USER_LIST: &str = "m.ignored_user_list";

fn with_ignored_user(
    current: Option<serde_json::Value>,
    user_id: &str,
    ignore: bool,
) -> Option<serde_json::Value> {
    let mut content = match current {
        Some(serde_json::Value::Object(content)) => content,
        _ => serde_json::Map::new(),
    };
    let users = content
        .entry("ignored_users")
        .or_insert_with(|| serde_json::json!({}));
    if !users.is_object() {
        *users = serde_json::json!({});
    }
    let users = users.as_object_mut()?;
    let changed = if ignore {
        users.insert(user_id.to_owned(), serde_json::json!({})).is_none()
    } else {
        users.shift_remove(user_id).is_some()
    };
    changed.then_some(serde_json::Value::Object(content))
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UnignoreUserParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl Handler for UnignoreUserParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        edit_ignored_users(core, &self.user_id, false, "unignore_user").await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ReportUserParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub reason: String,
}

impl Handler for ReportUserParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.report_user(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetPresenceParams {
    pub presence: PresenceView,
    #[serde(default)]
    pub status_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetDeviceActivityParams {
    pub active: bool,
}

impl Handler for SetDeviceActivityParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        crate::notifications::set_device_activity(core, self.active).await;
        Ok(())
    }
}

impl Handler for SetPresenceParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.set_desired_presence(self.presence);

        let presence = core.sync_presence().await;
        let client = core.client().await?;
        client
            .set_presence(presence, self.status_message, true)
            .await
            .or_failed(core, "set_presence")?;

        if let Some(user_id) = client.user_id() {
            core.fetch_presence(vec![user_id.to_owned()]).await;
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetReadReceiptsParams {
    pub public: bool,
}

impl Handler for SetReadReceiptsParams {
    type Ok = ();

    fn run(self, core: &Arc<Core>) -> impl Future<Output = Result<(), RpcError>> {
        core.private_receipts.store(!self.public, Ordering::Relaxed);
        std::future::ready(Ok(()))
    }
}

/// Fills in users the presence poll has not pushed yet.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct FetchPresenceParams {
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub user_ids: Vec<OwnedUserId>,
}

impl Handler for FetchPresenceParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.fetch_presence(self.user_ids).await;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SearchUserDirectoryParams {
    pub term: String,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SearchUserDirectoryOk {
    pub limited: bool,
    pub results: Vec<UserDirectoryEntryView>,
}

impl Handler for SearchUserDirectoryParams {
    type Ok = SearchUserDirectoryOk;

    async fn run(self, core: &Arc<Core>) -> Result<SearchUserDirectoryOk, RpcError> {
        let (limited, mut results) = core.search_user_directory(&self.term, self.limit).await?;
        let nicknames = core.nicknames();
        for entry in &mut results {
            nicknames.apply_directory_entry(entry);
        }
        Ok(SearchUserDirectoryOk { limited, results })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DismissedInvitesParams {}

impl Handler for DismissedInvitesParams {
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
        Ok(room_id_strings(core.dismissed_invites().await?))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetInviteDismissedParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub dismissed: bool,
}

impl Handler for SetInviteDismissedParams {
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
        Ok(room_id_strings(
            core.set_invite_dismissed(self.room_id, self.dismissed)
                .await?,
        ))
    }
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct DmSpaceLink {
    pub room_id: String,
    pub space_ids: Vec<String>,
}

fn dm_space_links(
    links: std::collections::BTreeMap<OwnedRoomId, Vec<OwnedRoomId>>,
) -> Vec<DmSpaceLink> {
    links
        .into_iter()
        .map(|(room_id, space_ids)| DmSpaceLink {
            room_id: room_id.into(),
            space_ids: room_id_strings(space_ids),
        })
        .collect()
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DmSpacesParams {}

impl Handler for DmSpacesParams {
    type Ok = Vec<DmSpaceLink>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<DmSpaceLink>, RpcError> {
        Ok(dm_space_links(core.dm_spaces().await?))
    }
}

/// An empty `space_ids` takes the chat out of every space.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetDmSpacesParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub space_ids: Vec<OwnedRoomId>,
}

impl Handler for SetDmSpacesParams {
    type Ok = Vec<DmSpaceLink>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<DmSpaceLink>, RpcError> {
        Ok(dm_space_links(
            core.set_dm_spaces(self.room_id, self.space_ids).await?,
        ))
    }
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SpaceNotificationView {
    pub space_id: String,
    pub mode: NotificationModeView,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SpaceNotificationsView {
    pub spaces: Vec<SpaceNotificationView>,
    pub exempt_rooms: Vec<String>,
}

fn space_notifications_view(
    notifications: crate::account_documents::SpaceNotifications,
) -> SpaceNotificationsView {
    SpaceNotificationsView {
        spaces: notifications
            .modes
            .into_iter()
            .map(|(space_id, mode)| SpaceNotificationView {
                space_id: space_id.into(),
                mode,
            })
            .collect(),
        exempt_rooms: notifications.exempt.into_iter().map(String::from).collect(),
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SpaceNotificationsParams {}

impl Handler for SpaceNotificationsParams {
    type Ok = SpaceNotificationsView;

    async fn run(self, core: &Arc<Core>) -> Result<SpaceNotificationsView, RpcError> {
        Ok(space_notifications_view(core.space_notifications().await?))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetSpaceNotificationParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub space_id: OwnedRoomId,
    #[serde(default)]
    pub mode: Option<NotificationModeView>,
}

impl Handler for SetSpaceNotificationParams {
    type Ok = SpaceNotificationsView;

    async fn run(self, core: &Arc<Core>) -> Result<SpaceNotificationsView, RpcError> {
        let notifications = core
            .update_space_notifications(|notifications| match self.mode {
                Some(mode) => {
                    notifications.modes.insert(self.space_id, mode);
                }
                None => {
                    notifications.modes.remove(&self.space_id);
                }
            })
            .await?;
        Ok(space_notifications_view(notifications))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetSpaceNotificationExemptParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub exempt: bool,
}

impl Handler for SetSpaceNotificationExemptParams {
    type Ok = SpaceNotificationsView;

    async fn run(self, core: &Arc<Core>) -> Result<SpaceNotificationsView, RpcError> {
        let notifications = core
            .update_space_notifications(|notifications| {
                if self.exempt {
                    notifications.exempt.insert(self.room_id);
                } else {
                    notifications.exempt.remove(&self.room_id);
                }
            })
            .await?;
        Ok(space_notifications_view(notifications))
    }
}

fn room_id_strings(room_ids: Vec<OwnedRoomId>) -> Vec<String> {
    room_ids.into_iter().map(String::from).collect()
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct BookmarksParams {}

impl Handler for BookmarksParams {
    type Ok = Vec<BookmarkView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<BookmarkView>, RpcError> {
        core.bookmarks().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetBookmarkParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    pub bookmarked: bool,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub now_ms: u64,
}

impl Handler for SetBookmarkParams {
    /// Whether the event is bookmarked now.
    type Ok = bool;

    async fn run(self, core: &Arc<Core>) -> Result<bool, RpcError> {
        core.set_bookmark(&self.room_id, &self.event_id, self.bookmarked, self.now_ms)
            .await
    }
}

/// The room's own config when `room_id` is set, the account's otherwise.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MediaPreviewConfigParams {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub room_id: Option<OwnedRoomId>,
}

impl Handler for MediaPreviewConfigParams {
    type Ok = MediaPreviewConfigView;

    async fn run(self, core: &Arc<Core>) -> Result<MediaPreviewConfigView, RpcError> {
        core.media_preview_settings(self.room_id.as_ref()).await
    }
}

/// Merges into the account's config; a field left `None` is kept.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetMediaPreviewConfigParams {
    pub config: MediaPreviewConfigView,
}

impl Handler for SetMediaPreviewConfigParams {
    type Ok = MediaPreviewConfigView;

    async fn run(self, core: &Arc<Core>) -> Result<MediaPreviewConfigView, RpcError> {
        core.set_media_preview_settings(self).await
    }
}

/// `None` drops the room's own value so the account's applies.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetRoomMediaPreviewsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub media_previews: Option<MediaPreviewsView>,
}

impl Handler for SetRoomMediaPreviewsParams {
    type Ok = MediaPreviewConfigView;

    async fn run(self, core: &Arc<Core>) -> Result<MediaPreviewConfigView, RpcError> {
        core.set_room_media_previews(&self.room_id, self.media_previews)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ProfileOverridesParams {}

impl Handler for ProfileOverridesParams {
    type Ok = ProfileOverridesView;

    async fn run(self, core: &Arc<Core>) -> Result<ProfileOverridesView, RpcError> {
        core.profile_overrides().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetProfileOverrideParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub display_name: FieldEdit,
    pub avatar: AvatarEditView,
    pub color: FieldEdit,
}

impl Handler for SetProfileOverrideParams {
    type Ok = ProfileOverridesView;

    async fn run(self, core: &Arc<Core>) -> Result<ProfileOverridesView, RpcError> {
        let edit = OverrideEdit {
            display_name: self.display_name,
            avatar: self.avatar,
            color: self.color,
        };
        core.set_profile_override(&self.user_id, &edit).await
    }
}

/// `None` when the homeserver does not support MSC4495.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PresenceSharingParams {}

impl Handler for PresenceSharingParams {
    type Ok = Option<PresenceSharingView>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<PresenceSharingView>, RpcError> {
        core.presence_sharing().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EditPresenceSharingParams {
    pub edit: PresenceSharingEdit,
}

impl Handler for EditPresenceSharingParams {
    type Ok = PresenceSharingView;

    async fn run(self, core: &Arc<Core>) -> Result<PresenceSharingView, RpcError> {
        core.edit_presence_sharing(&self.edit).await
    }
}

/// `None` when the homeserver does not support MSC4532.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PresenceOverrideParams {}

impl Handler for PresenceOverrideParams {
    type Ok = Option<PresenceOverrideView>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<PresenceOverrideView>, RpcError> {
        core.presence_override().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetPresenceOverrideParams {
    #[serde(rename = "override")]
    pub presence_override: PresenceOverrideView,
}

impl Handler for SetPresenceOverrideParams {
    type Ok = PresenceOverrideView;

    async fn run(self, core: &Arc<Core>) -> Result<PresenceOverrideView, RpcError> {
        core.set_presence_override(&self.presence_override).await
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::with_ignored_user;

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn mutual_rooms_follows_pagination() {
        use matrix_sdk::ruma::{api::MatrixVersion, user_id};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path, query_param},
        };

        let server = MatrixMockServer::new().await;
        let client = server
            .client_builder()
            .server_versions(vec![MatrixVersion::V1_19])
            .build()
            .await;
        Mock::given(method("GET"))
            .and(path("/_matrix/client/v1/mutual_rooms"))
            .and(query_param("user_id", "@bob:example.org"))
            .respond_with(|request: &wiremock::Request| {
                let from = request.url.query_pairs().find(|(key, _)| key == "from");
                let body = match from.as_ref().map(|(_, value)| value.as_ref()) {
                    None => {
                        json!({"count": 2, "joined": ["!first:example.org"], "next_batch": "next"})
                    }
                    Some("next") => json!({"count": 2, "joined": ["!second:example.org"]}),
                    token => panic!("Unexpected pagination token: {token:?}"),
                };
                ResponseTemplate::new(200).set_body_json(body)
            })
            .expect(2)
            .mount(server.server())
            .await;

        let rooms = super::fetch_mutual_rooms(&client, user_id!("@bob:example.org"))
            .await
            .unwrap();
        assert_eq!(
            rooms
                .iter()
                .map(|room| room.room_id.as_str())
                .collect::<Vec<_>>(),
            ["!first:example.org", "!second:example.org"]
        );
    }

    fn keys(content: &serde_json::Value) -> Vec<&str> {
        content["ignored_users"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect()
    }

    #[test]
    fn ignoring_appends_without_sorting() {
        let current = json!({"ignored_users": {"@z:x": {}, "@a:x": {}}});
        let edited = with_ignored_user(Some(current), "@m:x", true).unwrap();
        assert_eq!(keys(&edited), ["@z:x", "@a:x", "@m:x"]);
    }

    #[test]
    fn unignoring_keeps_the_rest_in_order() {
        let current = json!({"ignored_users": {"@z:x": {}, "@a:x": {}, "@m:x": {}, "@b:x": {}}});
        let edited = with_ignored_user(Some(current), "@z:x", false).unwrap();
        assert_eq!(keys(&edited), ["@a:x", "@m:x", "@b:x"]);
    }

    #[test]
    fn a_list_that_already_says_so_is_left_alone() {
        let current = json!({"ignored_users": {"@a:x": {}}});
        assert!(with_ignored_user(Some(current.clone()), "@a:x", true).is_none());
        assert!(with_ignored_user(Some(current), "@b:x", false).is_none());
    }

    #[test]
    fn a_missing_list_starts_one() {
        let edited = with_ignored_user(None, "@a:x", true).unwrap();
        assert_eq!(keys(&edited), ["@a:x"]);
    }
}

