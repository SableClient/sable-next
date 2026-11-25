use std::sync::Arc;
use std::sync::atomic::Ordering;

use matrix_sdk::ruma::api::client::membership::get_mutual_rooms;
use matrix_sdk::ruma::api::client::profile::{PropagateTo, set_profile_field};
use matrix_sdk::ruma::profile::{ProfileFieldName, ProfileFieldValue};
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, OwnedUserId, UserId};
use serde::{Deserialize, Serialize};

use super::{Handler, SessionHandler, Json};
use crate::media::mxc_uri;
use crate::profile_overrides::OverrideEdit;
use crate::profiles::profile_view;
use crate::protocol::{
    BookmarkView, FieldEdit, InviteTriageView, MediaPreviewConfigView, MediaPreviewsView,
    MutualRoomView, NotificationModeView, PresenceOverrideView, PresenceSharingEdit,
    PresenceSharingView, PresenceView, ProfileOverridesView, ProfileView, RpcCode, RpcError,
    SealedAccountDataView, ThreadSidebarView, UserDirectoryEntryView,
};
use crate::{Core, ResultExt, SignedIn};

domain! {
    set_read_receipts,
    user_profile,
    user_profile_source,
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
    change_password,
    password_change_enabled,
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
    thread_sidebar,
    set_thread_pin,
    set_thread_dismissed,
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

impl SessionHandler for DeactivateAccountParams {
    type Ok = Option<String>;

    async fn run(self, session: &SignedIn) -> Result<Option<String>, RpcError> {
        session.deactivate_account(self.password).await
    }
}

#[derive(Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ChangePasswordParams {
    pub current_password: String,
    pub new_password: String,
    pub logout_devices: bool,
}

impl SessionHandler for ChangePasswordParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.change_password(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PasswordChangeEnabledParams {}

impl SessionHandler for PasswordChangeEnabledParams {
    type Ok = bool;

    async fn run(self, session: &SignedIn) -> Result<bool, RpcError> {
        session.password_change_enabled().await
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

impl SessionHandler for UserProfileParams {
    type Ok = ProfileView;

    async fn run(self, session: &SignedIn) -> Result<ProfileView, RpcError> {
        let response = session
            .client()
            .account()
            .fetch_user_profile_of(&self.user_id)
            .await
            .map_err(|error| session.core().profile_error(&error))?;
        let mut profile = profile_view(self.user_id, &response);
        session.core().nicknames().apply_profile(&mut profile);
        Ok(profile)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UserProfileSourceParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
}

impl SessionHandler for UserProfileSourceParams {
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        let response = session
            .client()
            .account()
            .fetch_user_profile_of(&self.user_id)
            .await
            .map_err(|error| session.core().profile_error(&error))?;
        let fields = response
            .iter()
            .map(|(field, value)| (field.as_str().to_owned(), value.clone()))
            .collect::<serde_json::Map<_, _>>();
        serde_json::to_string_pretty(&fields).or_failed(session.core(), "user_profile_source")
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

impl SessionHandler for UserRelationsParams {
    type Ok = UserRelationsOk;

    async fn run(self, session: &SignedIn) -> Result<UserRelationsOk, RpcError> {
        let client = session.client();
        let ignored = ignored_users(session)
            .await?
            .iter()
            .any(|ignored| ignored == self.user_id.as_str());
        let mutual_rooms = fetch_mutual_rooms(client, &self.user_id)
            .await
            .or_failed(session.core(), "user_relations")?;

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
                ruma::api::error::IntoHttpError::NoUnstablePath,
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

impl SessionHandler for WellKnownParams {
    type Ok = Option<Json>;

    async fn run(self, session: &SignedIn) -> Result<Option<Json>, RpcError> {
        Ok(session.well_known().await?.map(Json))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DataTypesParams {}

impl SessionHandler for DataTypesParams {
    type Ok = Vec<String>;

    async fn run(self, session: &SignedIn) -> Result<Vec<String>, RpcError> {
        session.account_data_types().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DataParams {
    pub event_type: String,
}

impl SessionHandler for DataParams {
    type Ok = Option<Json>;
    const ENDS_WITH_SESSION: bool = true;

    async fn run(self, session: &SignedIn) -> Result<Option<Json>, RpcError> {
        session.remember_account_data_type(self.event_type.as_str())
            .await;
        let content = session
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

impl SessionHandler for SetDataParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        // Server-managed since MSC4010.
        if matches!(self.event_type.as_str(), "m.push_rules" | "m.fully_read") {
            return Err(RpcCode::Unsupported.into());
        }
        let _guard = session.state().account_data_writes.lock().await;
        session.set_account_data(&self.event_type, &self.content).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SealedDataParams {
    pub event_type: String,
}

impl SessionHandler for SealedDataParams {
    type Ok = SealedAccountDataView;

    async fn run(self, session: &SignedIn) -> Result<SealedAccountDataView, RpcError> {
        session.remember_account_data_type(self.event_type.as_str())
            .await;
        session.sealed_account_data(&self.event_type).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetSealedDataParams {
    pub event_type: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub content: serde_json::Value,
}

impl SessionHandler for SetSealedDataParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.remember_account_data_type(self.event_type.as_str())
            .await;
        session.set_sealed_account_data(&self.event_type, &self.content)
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

impl SessionHandler for SetDisplayNameParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let client = session.client();
        if client
            .unstable_features()
            .await
            .or_failed(session.core(), "set_display_name")?
            .contains(&ruma::api::FeatureFlag::from(
                "computer.gingershaped.msc4466",
            ))
        {
            let value = ProfileFieldValue::new(
                "displayname",
                serde_json::Value::String(self.name.unwrap_or_default()),
            )
            .or_failed(session.core(), "set_display_name")?;
            let mut request = set_profile_field::v3::Request::new(
                client.user_id().ok_or(RpcCode::NotLoggedIn)?.to_owned(),
                value,
            );
            request.propagate_to = profile_propagation(self.propagate_to);
            client
                .send(request)
                .await
                .or_failed(session.core(), "set_display_name")?;
        } else {
            client
                .account()
                .set_display_name(self.name.as_deref())
                .await
                .or_failed(session.core(), "set_display_name")?;
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

impl SessionHandler for SetAvatarUrlParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let url = match self.url {
            Some(url) => Some(mxc_uri(&url)?),
            None => None,
        };

        let client = session.client();
        if client
            .unstable_features()
            .await
            .or_failed(session.core(), "set_avatar_url")?
            .contains(&ruma::api::FeatureFlag::from(
                "computer.gingershaped.msc4466",
            ))
        {
            let value = ProfileFieldValue::new(
                "avatar_url",
                serde_json::Value::String(url.map(|url| url.to_string()).unwrap_or_default()),
            )
            .or_failed(session.core(), "set_avatar_url")?;
            let mut request = set_profile_field::v3::Request::new(
                client.user_id().ok_or(RpcCode::NotLoggedIn)?.to_owned(),
                value,
            );
            request.propagate_to = profile_propagation(self.propagate_to);
            client
                .send(request)
                .await
                .or_failed(session.core(), "set_avatar_url")?;
        } else {
            client
                .account()
                .set_avatar_url(url.as_deref())
                .await
                .or_failed(session.core(), "set_avatar_url")?;
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

impl SessionHandler for SetProfileFieldParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let account = session.client().account();
        match self.value {
            Some(value) => {
                let value = ProfileFieldValue::new(&self.field, value)
                    .map_err(|error| session.core().failed_with("set_profile_field_invalid_value", &error))?;
                account
                    .set_profile_field(value)
                    .await
                    .or_failed(session.core(), "set_profile_field")?;
            }
            None => {
                account
                    .delete_profile_field(ProfileFieldName::from(self.field.as_str()))
                    .await
                    .or_failed(session.core(), "delete_profile_field")?;
            }
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ContactsParams {}

impl SessionHandler for ContactsParams {
    /// The account's email addresses.
    type Ok = Vec<String>;

    async fn run(self, session: &SignedIn) -> Result<Vec<String>, RpcError> {
        Ok(session
            .client()
            .account()
            .get_3pids()
            .await
            .or_failed(session.core(), "account_contacts")?
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

impl SessionHandler for IgnoredUsersParams {
    type Ok = Vec<String>;

    async fn run(self, session: &SignedIn) -> Result<Vec<String>, RpcError> {
        ignored_users(session).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct InviteTriageParams {}

impl SessionHandler for InviteTriageParams {
    type Ok = Vec<InviteTriageView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<InviteTriageView>, RpcError> {
        Ok(crate::invites::triage(session.core(), session.client()).await)
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

impl SessionHandler for SetDirectParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.set_direct(&self.room_id, self.direct, self.user_id)
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

impl SessionHandler for IgnoreUserParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        edit_ignored_users(session, &self.user_id, true, "ignore_user").await
    }
}

/// The SDK's `ignore_user` round-trips the list through a sorted map, which
/// rewrites the account data in key order. Editing the raw content keeps the
/// order the list was written in.
async fn edit_ignored_users(
    core: &SignedIn,
    user_id: &UserId,
    ignore: bool,
    label: &str,
) -> Result<(), RpcError> {
    if ignore && core.client().user_id() == Some(user_id) {
        return Err(core.core().failed(label, "a user cannot ignore themselves"));
    }
    core.update_account_data(&[IGNORED_USER_LIST], label, async |current| {
        Ok(with_ignored_user(current, user_id.as_str(), ignore))
    })
    .await?;
    Ok(())
}

/// Read from the account data, since the SDK's observable only fills once a sync changes the list.
async fn ignored_users(core: &SignedIn) -> Result<Vec<String>, RpcError> {
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

impl SessionHandler for UnignoreUserParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        edit_ignored_users(session, &self.user_id, false, "unignore_user").await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ReportUserParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub reason: String,
}

impl SessionHandler for ReportUserParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.report_user(self).await
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
        if let Ok(session) = core.signed_in() {
            crate::notifications::set_device_activity(&session, self.active).await;
        }
        Ok(())
    }
}

impl Handler for SetPresenceParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.set_desired_presence(self.presence);

        let session = core.signed_in()?;
        let client = session.client();
        session.publish_presence(self.status_message)
            .await
            .or_failed(session.core(), "set_presence")?;

        if let Some(user_id) = client.user_id() {
            session.fetch_presence(vec![user_id.to_owned()]).await;
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
        core.settings.private_receipts.store(!self.public, Ordering::Relaxed);
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
        if let Ok(session) = core.signed_in() {
            session.fetch_presence(self.user_ids).await;
        }
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

impl SessionHandler for SearchUserDirectoryParams {
    type Ok = SearchUserDirectoryOk;

    async fn run(self, session: &SignedIn) -> Result<SearchUserDirectoryOk, RpcError> {
        let (limited, mut results) = session.search_user_directory(&self.term, self.limit).await?;
        let nicknames = session.core().nicknames();
        for entry in &mut results {
            nicknames.apply_directory_entry(entry);
        }
        Ok(SearchUserDirectoryOk { limited, results })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DismissedInvitesParams {}

impl SessionHandler for DismissedInvitesParams {
    type Ok = Vec<String>;

    async fn run(self, session: &SignedIn) -> Result<Vec<String>, RpcError> {
        Ok(room_id_strings(session.dismissed_invites().await?))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetInviteDismissedParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub dismissed: bool,
}

impl SessionHandler for SetInviteDismissedParams {
    type Ok = Vec<String>;

    async fn run(self, session: &SignedIn) -> Result<Vec<String>, RpcError> {
        Ok(room_id_strings(
            session.set_invite_dismissed(self.room_id, self.dismissed)
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

impl SessionHandler for DmSpacesParams {
    type Ok = Vec<DmSpaceLink>;

    async fn run(self, session: &SignedIn) -> Result<Vec<DmSpaceLink>, RpcError> {
        Ok(dm_space_links(session.dm_spaces().await?))
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

impl SessionHandler for SetDmSpacesParams {
    type Ok = Vec<DmSpaceLink>;

    async fn run(self, session: &SignedIn) -> Result<Vec<DmSpaceLink>, RpcError> {
        Ok(dm_space_links(
            session.set_dm_spaces(self.room_id, self.space_ids).await?,
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

impl SessionHandler for SpaceNotificationsParams {
    type Ok = SpaceNotificationsView;

    async fn run(self, session: &SignedIn) -> Result<SpaceNotificationsView, RpcError> {
        Ok(space_notifications_view(session.space_notifications().await?))
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

impl SessionHandler for SetSpaceNotificationParams {
    type Ok = SpaceNotificationsView;

    async fn run(self, session: &SignedIn) -> Result<SpaceNotificationsView, RpcError> {
        let notifications = session
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

impl SessionHandler for SetSpaceNotificationExemptParams {
    type Ok = SpaceNotificationsView;

    async fn run(self, session: &SignedIn) -> Result<SpaceNotificationsView, RpcError> {
        let notifications = session
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

impl SessionHandler for BookmarksParams {
    type Ok = Vec<BookmarkView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<BookmarkView>, RpcError> {
        session.bookmarks().await
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

impl SessionHandler for SetBookmarkParams {
    /// Whether the event is bookmarked now.
    type Ok = bool;

    async fn run(self, session: &SignedIn) -> Result<bool, RpcError> {
        session.set_bookmark(&self.room_id, &self.event_id, self.bookmarked, self.now_ms)
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

impl SessionHandler for MediaPreviewConfigParams {
    type Ok = MediaPreviewConfigView;

    async fn run(self, session: &SignedIn) -> Result<MediaPreviewConfigView, RpcError> {
        session.media_preview_settings(self.room_id.as_ref()).await
    }
}

/// Merges into the account's config; a field left `None` is kept.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetMediaPreviewConfigParams {
    pub config: MediaPreviewConfigView,
}

impl SessionHandler for SetMediaPreviewConfigParams {
    type Ok = MediaPreviewConfigView;

    async fn run(self, session: &SignedIn) -> Result<MediaPreviewConfigView, RpcError> {
        session.set_media_preview_settings(self).await
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

impl SessionHandler for SetRoomMediaPreviewsParams {
    type Ok = MediaPreviewConfigView;

    async fn run(self, session: &SignedIn) -> Result<MediaPreviewConfigView, RpcError> {
        session.set_room_media_previews(&self.room_id, self.media_previews)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ProfileOverridesParams {}

impl SessionHandler for ProfileOverridesParams {
    type Ok = ProfileOverridesView;

    async fn run(self, session: &SignedIn) -> Result<ProfileOverridesView, RpcError> {
        session.profile_overrides().await
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

impl SessionHandler for SetProfileOverrideParams {
    type Ok = ProfileOverridesView;

    async fn run(self, session: &SignedIn) -> Result<ProfileOverridesView, RpcError> {
        let edit = OverrideEdit {
            display_name: self.display_name,
            avatar: self.avatar,
            color: self.color,
        };
        session.set_profile_override(&self.user_id, &edit).await
    }
}

/// `None` when the homeserver does not support MSC4495.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PresenceSharingParams {}

impl Handler for PresenceSharingParams {
    type Ok = Option<PresenceSharingView>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<PresenceSharingView>, RpcError> {
        match core.signed_in() {
            Ok(session) => session.presence_sharing().await,
            Err(_) => Ok(None),
        }
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EditPresenceSharingParams {
    pub edit: PresenceSharingEdit,
}

impl SessionHandler for EditPresenceSharingParams {
    type Ok = PresenceSharingView;

    async fn run(self, session: &SignedIn) -> Result<PresenceSharingView, RpcError> {
        session.edit_presence_sharing(&self.edit).await
    }
}

/// `None` when the homeserver does not support MSC4532.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PresenceOverrideParams {}

impl Handler for PresenceOverrideParams {
    type Ok = Option<PresenceOverrideView>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<PresenceOverrideView>, RpcError> {
        match core.signed_in() {
            Ok(session) => session.presence_override().await,
            Err(_) => Ok(None),
        }
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetPresenceOverrideParams {
    #[serde(rename = "override")]
    pub presence_override: PresenceOverrideView,
}

impl SessionHandler for SetPresenceOverrideParams {
    type Ok = PresenceOverrideView;

    async fn run(self, session: &SignedIn) -> Result<PresenceOverrideView, RpcError> {
        session.set_presence_override(&self.presence_override).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ThreadSidebarParams {}

impl SessionHandler for ThreadSidebarParams {
    type Ok = ThreadSidebarView;

    async fn run(self, session: &SignedIn) -> Result<ThreadSidebarView, RpcError> {
        session.thread_sidebar().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetThreadPinParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    pub pinned: bool,
}

impl SessionHandler for SetThreadPinParams {
    type Ok = ThreadSidebarView;

    async fn run(self, session: &SignedIn) -> Result<ThreadSidebarView, RpcError> {
        session.set_thread_pin(self.room_id, self.event_id, self.pinned)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetThreadDismissedParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    pub dismissed: bool,
}

impl SessionHandler for SetThreadDismissedParams {
    type Ok = ThreadSidebarView;

    async fn run(self, session: &SignedIn) -> Result<ThreadSidebarView, RpcError> {
        session.set_thread_dismissed(self.room_id, self.event_id, self.dismissed)
            .await
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

