use std::sync::Arc;
use std::{
    collections::BTreeSet,
    sync::atomic::{AtomicBool, Ordering},
};

use crate::api::rooms::DirectoryRoomType;
use crate::api::rooms::PublicRoomsParams;
use matrix_sdk::config::RequestConfig;
use matrix_sdk::deserialized_responses::{RawAnySyncOrStrippedState, SyncOrStrippedState};
use matrix_sdk::room::Room;
use matrix_sdk::ruma::SpaceChildOrder;
use matrix_sdk::ruma::api::FeatureFlag;
use matrix_sdk::ruma::api::client::directory::get_public_rooms_filtered;
use matrix_sdk::ruma::api::client::membership::joined_rooms;
use matrix_sdk::ruma::api::client::push::get_pushrules_all;
use matrix_sdk::ruma::api::client::space::{SpaceHierarchyRoomsChunk, get_hierarchy};
use matrix_sdk::ruma::api::client::state::send_state_event;
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::directory::{Filter, PublicRoomsChunk, RoomTypeFilter};
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::events::room::join_rules::{AllowRule, JoinRule, RoomJoinRulesEventContent};
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::{OwnedRoomId, OwnedServerName, RoomId, RoomOrAliasId, ServerName, UInt};
use matrix_sdk::send_queue::{LocalEchoContent, SendHandle};
use matrix_sdk::{Client, EncryptionState, RoomMemberships, RoomState};
use matrix_sdk_base::{RawStateEventWithKeys, RoomInfo, RoomInfoNotableUpdateReasons};

use crate::ResultExt;
use crate::SignedIn;
use crate::api::rooms::PublicRoomsOk;
use crate::api::spaces::HierarchyOk;
use crate::errors::CoreResultExt as _;
use crate::protocol::{
    JoinRuleView, PublicRoomView, RoomPreviewView, RpcCode, RpcError, SpaceHierarchyRoomView,
};

use crate::Core;
use crate::view;

const HIERARCHY_PAGE_SIZE: u32 = 100;
const HIERARCHY_MAX_DEPTH: u32 = 1;
const DIRECTORY_PAGE_SIZE: u32 = 30;
const MAX_JOIN_SERVERS: usize = 10;
const OWN_MEMBER_FILL_MAX_MEMBERS: u64 = 50;
const MEMBERSHIP_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

const TOMBSTONE_MIGRATION_KEY: &[u8] = b"sable.migrations.tombstones";

pub(crate) async fn migrate_saved_tombstones(client: &Client) -> Result<(), matrix_sdk::Error> {
    let store = client.state_store();
    if store
        .get_custom_value(TOMBSTONE_MIGRATION_KEY)
        .await?
        .is_some()
    {
        return Ok(());
    }

    for room in client.rooms() {
        let Some(raw) = room
            .get_state_event(StateEventType::RoomTombstone, "")
            .await?
        else {
            continue;
        };
        room.update_and_save_room_info(|mut info| {
            match raw {
                RawAnySyncOrStrippedState::Sync(raw) => {
                    if let Some(mut event) = RawStateEventWithKeys::try_from_raw_state_event(raw) {
                        info.handle_state_event(&mut event);
                    }
                }
                RawAnySyncOrStrippedState::Stripped(raw) => {
                    if let Some(mut event) = RawStateEventWithKeys::try_from_raw_state_event(raw) {
                        info.handle_stripped_state_event(&mut event);
                    }
                }
            }
            (info, RoomInfoNotableUpdateReasons::NONE)
        })
        .await?;
    }

    store
        .set_custom_value_no_read(TOMBSTONE_MIGRATION_KEY, vec![1])
        .await?;
    Ok(())
}

/// Leaves alone a room that changed while the request was out, since sync knows better than the
/// snapshot, and the whole pass when updates were missed.
pub(crate) async fn reconcile_memberships(client: &Client) -> Result<(), matrix_sdk::Error> {
    use tokio::sync::broadcast::error::TryRecvError;

    let mut updates = client.room_info_notable_update_receiver();
    let joined: std::collections::HashSet<_> = client
        .send(joined_rooms::v3::Request::new())
        .await?
        .joined_rooms
        .into_iter()
        .collect();
    let mut changed = std::collections::HashSet::new();
    loop {
        match updates.try_recv() {
            Ok(update) => {
                changed.insert(update.room_id);
            }
            Err(TryRecvError::Lagged(_)) => return Ok(()),
            Err(TryRecvError::Empty | TryRecvError::Closed) => break,
        }
    }

    for room in client.rooms() {
        if changed.contains(room.room_id()) {
            continue;
        }
        let mark: fn(&mut RoomInfo) = match (room.state(), joined.contains(room.room_id())) {
            (RoomState::Joined, false) => RoomInfo::mark_as_left,
            (RoomState::Left | RoomState::Invited | RoomState::Knocked, true) => {
                RoomInfo::mark_as_joined
            }
            _ => continue,
        };
        room.update_and_save_room_info(|mut info| {
            mark(&mut info);
            (info, RoomInfoNotableUpdateReasons::MEMBERSHIP)
        })
        .await?;
    }
    Ok(())
}

pub(crate) async fn poll_memberships(core: SignedIn, client: Client) {
    loop {
        matrix_sdk::sleep::sleep(MEMBERSHIP_POLL_INTERVAL).await;
        core.core().wait_until_active().await;
        if let Err(error) = reconcile_memberships(&client).await {
            tracing::debug!("could not poll room memberships: {error}");
        }
    }
}

pub(crate) async fn reconcile_joined_invites(client: Client) {
    use tokio::sync::broadcast::error::{RecvError, TryRecvError};

    let mut updates = client.room_info_notable_update_receiver();
    loop {
        match updates.recv().await {
            Ok(update) => {
                let invited = |room_id: &RoomId| {
                    client
                        .get_room(room_id)
                        .is_some_and(|room| room.state() == RoomState::Invited)
                };
                if !invited(&update.room_id) {
                    continue;
                }
                while let Ok(_) | Err(TryRecvError::Lagged(_)) = updates.try_recv() {}
                if let Err(error) = reconcile_memberships(&client).await {
                    tracing::warn!("could not reconcile a joined invite: {error}");
                }
            }
            Err(RecvError::Lagged(_)) => {}
            Err(RecvError::Closed) => break,
        }
    }
}

pub(crate) async fn fill_own_members(client: &Client) -> Result<(), matrix_sdk::Error> {
    for room in client.joined_rooms() {
        fill_own_member(&room).await?;
    }
    Ok(())
}

pub(crate) async fn fill_own_member(room: &Room) -> Result<(), matrix_sdk::Error> {
    if room.joined_members_count() > OWN_MEMBER_FILL_MAX_MEMBERS
        || room.get_member_no_sync(room.own_user_id()).await?.is_some()
    {
        return Ok(());
    }
    if let Err(error) = room.sync_members().await {
        tracing::warn!(room_id = %room.room_id(), "could not fetch our own membership: {error}");
    }
    Ok(())
}

const DM_DEFAULT_EVENT: &str = "moe.sable.dm_notification_default";

async fn clear_dm_default(client: &Client) -> matrix_sdk::Result<()> {
    let event_type = DM_DEFAULT_EVENT;
    let Some(raw) = client
        .account()
        .fetch_account_data(event_type.into())
        .await?
    else {
        return Ok(());
    };
    if raw
        .deserialize_as_unchecked::<serde_json::Map<String, serde_json::Value>>()
        .is_ok_and(|content| content.is_empty())
    {
        return Ok(());
    }
    client
        .account()
        .set_account_data_raw(
            event_type.into(),
            ruma::serde::Raw::from_json_string("{}".to_owned())?,
        )
        .await?;
    Ok(())
}

impl Core {
    /// The active account, with the rooms it left or was banned from: their conversations are gone.
    ///
    /// # Errors
    ///
    /// When no account is signed in.
    pub fn left_rooms(self: &Arc<Self>) -> Result<(String, Vec<String>), RpcError> {
        self.signed_in()?.left_rooms()
    }
}

impl SignedIn {
    pub(crate) fn left_rooms(&self) -> Result<(String, Vec<String>), RpcError> {
        let client = self.client();
        let user_id = client.user_id().ok_or(RpcCode::NotLoggedIn)?.to_string();
        let rooms = client
            .rooms()
            .into_iter()
            .filter(|room| matches!(room.state(), RoomState::Left | RoomState::Banned))
            .map(|room| room.room_id().to_string())
            .collect();
        Ok((user_id, rooms))
    }

    pub(crate) async fn set_direct(
        &self,
        room_id: &OwnedRoomId,
        direct: bool,
        user_id: Option<ruma::OwnedUserId>,
    ) -> Result<(), RpcError> {
        let client = self.client();
        let room = self.room(room_id)?;

        let others = if direct {
            let members = room
                .members(RoomMemberships::ACTIVE)
                .await
                .or_failed(self.core(), "set_direct_members")?;
            match &user_id {
                Some(user_id)
                    if Some(user_id.as_ref()) != client.user_id()
                        && members.iter().any(|member| member.user_id() == user_id) =>
                {
                    vec![user_id.clone()]
                }
                Some(_) => return Err(RpcCode::Denied.into()),
                None => members
                    .iter()
                    .map(|member| member.user_id().to_owned())
                    .filter(|user_id| Some(user_id.as_ref()) != client.user_id())
                    .collect(),
            }
        } else {
            Vec::new()
        };

        // Written before `m.direct`, whose update is what refreshes the room's name.
        let partner = user_id.filter(|_| direct);
        if partner.is_some() || view::chosen_partner(&room).await.is_some() {
            let content = partner.map_or_else(
                || serde_json::json!({}),
                |user_id| serde_json::json!({ "user_id": user_id }),
            );
            let raw = ruma::serde::Raw::new(&content)
                .or_failed(self.core(), "set_direct_partner")?
                .cast_unchecked();
            room.set_account_data_raw(view::DIRECT_PARTNER_EVENT.into(), raw)
                .await
                .or_failed(self.core(), "set_direct_partner")?;
        }

        if direct {
            client
                .account()
                .mark_as_dm(room_id, &others)
                .await
                .or_failed(self.core(), "set_direct")?;
            let rules = self.push_rules().await?;
            let snapshot = rules.snapshot();
            if !crate::push_rules::direct_defaults(
                &snapshot,
                true,
                room.joined_members_count() == 2,
            ) {
                let writes = crate::push_rules::plan_direct_default(&snapshot, room_id);
                rules
                    .apply(writes)
                    .await
                    .or_report(self.core(), "set_direct_notifications")?;
            }
        } else {
            room.set_is_direct(false)
                .await
                .or_failed(self.core(), "unset_direct")?;
        }

        Ok(())
    }

    pub(crate) async fn set_room_join_rule(
        &self,
        room_id: &OwnedRoomId,
        rule: JoinRuleView,
    ) -> Result<(), RpcError> {
        let room = self.room(room_id)?;
        let (supports_knock, supports_restricted, supports_knock_restricted) =
            join_rule_support(&room);
        let content = match rule {
            JoinRuleView::Public => RoomJoinRulesEventContent::new(JoinRule::Public),
            JoinRuleView::Invite => RoomJoinRulesEventContent::new(JoinRule::Invite),
            JoinRuleView::Knock if supports_knock => {
                RoomJoinRulesEventContent::new(JoinRule::Knock)
            }
            JoinRuleView::Knock => return Err(RpcCode::Unsupported.into()),
            JoinRuleView::Restricted if !supports_restricted => {
                return Err(RpcCode::Unsupported.into());
            }
            JoinRuleView::KnockRestricted if !supports_knock_restricted => {
                return Err(RpcCode::Unsupported.into());
            }
            JoinRuleView::Restricted | JoinRuleView::KnockRestricted => {
                let client = self.client();
                let allow: Vec<_> = view::restricted_parents(client, &room)
                    .await
                    .into_iter()
                    .map(AllowRule::room_membership)
                    .collect();
                if allow.is_empty() {
                    return Err(RpcCode::Denied.into());
                }
                if matches!(rule, JoinRuleView::Restricted) {
                    RoomJoinRulesEventContent::restricted(allow)
                } else {
                    RoomJoinRulesEventContent::knock_restricted(allow)
                }
            }
        };

        room.send_state_event(content)
            .await
            .or_failed(self.core(), "set_room_join_rule")?;
        Ok(())
    }

    pub(crate) async fn fill_own_members(&self) {
        let client = self.client();
        if let Err(error) = fill_own_members(client).await {
            tracing::warn!("could not fill in our own room memberships: {error}");
        }
    }

    pub(crate) async fn after_sync_running(&self, generation: u64, rules_cleaned: &AtomicBool) {
        self.core()
            .until_stores_close(async {
                self.resubscribe_timeline_rooms().await;
                self.reconcile_memberships().await;
                self.fill_own_members().await;
                if !rules_cleaned.load(Ordering::SeqCst) {
                    self.retry_rule_cleanup(generation, rules_cleaned).await;
                }
            })
            .await;
    }

    pub(crate) async fn retry_rule_cleanup(&self, generation: u64, completed: &AtomicBool) {
        while self.core().is_current(generation) && !self.core().sync_paused() {
            if self.cleanup_notification_rules().await {
                completed.store(true, Ordering::SeqCst);
                return;
            }
            matrix_sdk::sleep::sleep(std::time::Duration::from_secs(30)).await;
        }
    }

    pub(crate) async fn cleanup_notification_rules(&self) -> bool {
        let client = self.client();
        let Some(user_id) = client.user_id() else {
            return false;
        };
        let Ok(rules) = self.push_rules().await else {
            return false;
        };
        // Fetch current rules so retries see successful deletions.
        let snapshot = match client.send(get_pushrules_all::v3::Request::new()).await {
            Ok(response) => response.global,
            Err(error) => {
                tracing::warn!("could not load notification rules for cleanup: {error}");
                return false;
            }
        };
        let writes = crate::push_rules::plan_cleanup(&snapshot, user_id);
        if let Err(error) = rules.apply(writes).await {
            tracing::warn!("could not clean up notification rules: {error}");
            return false;
        }
        if let Err(error) = clear_dm_default(client).await {
            tracing::warn!("could not clear the old DM notification default: {error}");
            return false;
        }
        true
    }

    pub(crate) async fn reconcile_memberships(&self) {
        let client = self.client();
        if let Err(error) = reconcile_memberships(client).await {
            tracing::warn!("could not reconcile room memberships: {error}");
        }
    }

    /// Synapse carries neither side of a space link across an upgrade and the
    /// spec leaves it to MSC4168, so the replacement claims the old room's
    /// spaces and each space we manage lists it in the old room's place. Best
    /// effort, and harmless to repeat where the homeserver already did it.
    pub(crate) async fn carry_space_links(&self, old: &RoomId, new: &RoomId) {
        let client = self.client();
        if let Some(room) = client.get_room(old) {
            match self
                .core()
                .with_open_stores(async || room.get_state_events(StateEventType::SpaceParent).await)
                .await
            {
                Ok(parents) => {
                    let parents = parents
                        .into_iter()
                        .filter_map(|event| match event {
                            RawAnySyncOrStrippedState::Sync(raw) => {
                                raw.deserialize_as_unchecked().ok()
                            }
                            RawAnySyncOrStrippedState::Stripped(_) => None,
                        })
                        .collect();
                    copy_state(client, new, &[StateEventType::SpaceParent], parents).await;
                }
                Err(error) => {
                    tracing::warn!(room = %old, %error, "space parents not read for the upgraded room");
                }
            }
        }

        let Some(me) = client.user_id() else {
            return;
        };
        for space in client.joined_space_rooms() {
            let Ok(Some(mut child)) = self
                .core()
                .space_child_content(&space, old, "carry_space_links")
                .await
            else {
                continue;
            };
            let managed = space
                .power_levels()
                .await
                .is_ok_and(|levels| levels.user_can_send_state(me, StateEventType::SpaceChild));
            if !managed {
                continue;
            }
            // The replacement has no other server in it yet.
            child.via = vec![me.server_name().to_owned()];
            let space_id = space.room_id().to_owned();
            let listed = self
                .send_state(space_id.clone(), "m.space.child", new.as_str(), &child)
                .await;
            let moved = match listed {
                Ok(_) => self
                    .send_state(
                        space_id.clone(),
                        "m.space.child",
                        old.as_str(),
                        &serde_json::Map::new(),
                    )
                    .await
                    .map(drop),
                Err(error) => Err(error),
            };
            if let Err(error) = moved {
                tracing::warn!(space = %space_id, ?error, "space listing not moved to the upgraded room");
            }
        }
    }

    /// Without a `via` server the edge is ignored, so a child that is already
    /// listed keeps its own `via`, `order` and `suggested`.
    pub(crate) async fn add_to_space(
        &self,
        space_id: &OwnedRoomId,
        room_id: &RoomId,
        suggested: Option<bool>,
    ) -> Result<(), RpcError> {
        let space = self.room(space_id)?;
        if let Some(mut content) = self
            .core()
            .space_child_content(&space, room_id, "add_to_space")
            .await?
        {
            let Some(suggested) = suggested.filter(|&next| next != content.suggested) else {
                return Ok(());
            };
            content.suggested = suggested;
            space
                .send_state_event_for_key(room_id, content)
                .await
                .or_failed(self.core(), "add_to_space")?;
            return Ok(());
        }

        self.refuse_private_child(&space, room_id).await?;
        let via = self.child_via(room_id).await?;

        let mut content = SpaceChildEventContent::new(via);
        content.suggested = suggested.unwrap_or(false);

        space
            .send_state_event_for_key(room_id, content)
            .await
            .or_failed(self.core(), "add_to_space")?;

        Ok(())
    }

    async fn child_via(&self, room_id: &RoomId) -> Result<Vec<OwnedServerName>, RpcError> {
        let client = self.client();
        if let Some(room) = client.get_room(room_id)
            && let Some(route) = crate::routing::Route::of(&room).await
        {
            return Ok(route.into_servers());
        }
        let listed = crate::routing::Route::listed(client, room_id).await;
        Ok(listed.ok_or(RpcCode::UnknownRoom)?.into_servers())
    }

    /// Space state would show every member a chat this account filed there privately.
    pub(crate) async fn refuse_private_child(
        &self,
        space: &Room,
        room_id: &RoomId,
    ) -> Result<(), RpcError> {
        let private = Core::synced_dm_spaces_of(&space.client(), room_id)
            .await
            .iter()
            .any(|linked| linked == space.room_id());
        if private
            && self
                .core()
                .space_child_content(space, room_id, "refuse_private_child")
                .await?
                .is_none()
        {
            return Err(RpcCode::Unsupported.into());
        }
        Ok(())
    }

    async fn space_child_content_or_via(
        &self,
        space: &Room,
        room_id: &RoomId,
        via: Option<Vec<String>>,
    ) -> Result<SpaceChildEventContent, RpcError> {
        if let Some(content) = self
            .core()
            .space_child_content(space, room_id, "space_child_content: read")
            .await?
        {
            Ok(content)
        } else {
            self.refuse_private_child(space, room_id).await?;
            let via = via.ok_or(RpcCode::UnknownRoom)?;
            let via: Vec<_> = via
                .into_iter()
                .map(|server| ServerName::parse(server).map_err(|_| RpcCode::UnknownRoom))
                .collect::<Result<_, _>>()?;
            if via.is_empty() {
                return Err(RpcCode::UnknownRoom.into());
            }
            Ok(SpaceChildEventContent::new(via))
        }
    }

    pub(crate) async fn set_space_child_order(
        &self,
        space_id: &OwnedRoomId,
        room_id: &RoomId,
        order: Option<String>,
        via: Option<Vec<String>>,
    ) -> Result<(), RpcError> {
        let space = self.room(space_id)?;
        let mut content = self
            .space_child_content_or_via(&space, room_id, via)
            .await?;

        content.order = match order {
            Some(order) => Some(
                SpaceChildOrder::parse(order)
                    .or_failed(self.core(), "set_space_child_order_invalid_order")?,
            ),
            None => None,
        };

        space
            .send_state_event_for_key(room_id, content)
            .await
            .or_failed(self.core(), "set_space_child_order")?;

        Ok(())
    }

    pub(crate) async fn set_space_child_suggested(
        &self,
        space_id: &OwnedRoomId,
        room_id: &RoomId,
        suggested: bool,
        via: Option<Vec<String>>,
    ) -> Result<(), RpcError> {
        let space = self.room(space_id)?;

        let mut content = self
            .space_child_content_or_via(&space, room_id, via)
            .await?;
        content.suggested = suggested;

        space
            .send_state_event_for_key(room_id, content)
            .await
            .or_failed(self.core(), "set_space_child_suggested")?;

        Ok(())
    }

    pub(crate) async fn join_room(
        &self,
        address: &str,
        via: &[String],
    ) -> Result<OwnedRoomId, RpcError> {
        let client = self.client();
        let (room_id, servers) = self
            .core()
            .join_route(client, address, via, "join_room")
            .await?;

        let room = match client
            .join_room_by_id_or_alias((&*room_id).into(), &servers)
            .await
        {
            Ok(room) => room,
            Err(error) => {
                if error.client_api_error_kind() == Some(&ErrorKind::Forbidden)
                    && let Some(room) = client.get_room(&room_id)
                    && let Some((_, reason)) =
                        crate::invites::own_membership(&room, &MembershipState::Ban).await
                {
                    return Err(RpcCode::Banned { reason }.into());
                }
                return Err(self.core().rpc_error("join_room", &error));
            }
        };

        Ok(room.room_id().to_owned())
    }

    pub(crate) async fn knock_room(
        &self,
        address: &str,
        via: &[String],
        reason: Option<String>,
    ) -> Result<OwnedRoomId, RpcError> {
        let client = self.client();
        let (room_id, servers) = self
            .core()
            .join_route(client, address, via, "knock_room")
            .await?;

        let room = client
            .knock(room_id.into(), reason, servers)
            .await
            .or_failed(self.core(), "knock_room")?;

        Ok(room.room_id().to_owned())
    }

    pub(crate) async fn room_preview(
        &self,
        address: &str,
        via: &[String],
    ) -> Result<RoomPreviewView, RpcError> {
        let client = self.client();
        let address = RoomOrAliasId::parse(address).map_err(|_| RpcCode::UnknownRoom)?;
        let via = via
            .iter()
            .filter_map(|server| ServerName::parse(server).ok())
            .collect::<Vec<_>>();

        if client
            .unstable_features()
            .await
            .unwrap_or_default()
            .contains(&FeatureFlag::Msc4560)
        {
            let state = client
                .get_room_stripped_state(
                    &address,
                    via.clone(),
                    BTreeSet::from_iter([
                        StateEventType::RoomCreate,
                        StateEventType::RoomCanonicalAlias,
                        StateEventType::RoomName,
                        StateEventType::RoomTopic,
                        StateEventType::RoomAvatar,
                        StateEventType::RoomJoinRules,
                    ]),
                    true,
                )
                .await;

            match state {
                Ok(state) => {
                    let membership = client.get_room(&state.room_id).map(|room| room.state());

                    return Ok(view::room_preview_from_stripped_state(
                        state.room_id,
                        state.via,
                        state
                            .num_joined_members
                            .map(|count| u32::try_from(count).unwrap_or(u32::MAX)),
                        state.state,
                        membership,
                    ));
                }
                Err(error) => {
                    tracing::debug!(?error, "MSC4560 room preview failed, using the SDK preview");
                }
            }
        }

        let mut preview = client
            .get_room_preview(&address, via)
            .await
            .or_failed(self.core(), "room_preview")?;

        // If the server didn't provide the state, but we have it locally,
        // fill it in before returning
        if let state @ None = &mut preview.state
            && let Some(room) = client.get_room(&preview.room_id)
        {
            *state = Some(room.state());
        }

        Ok(view::room_preview_view(&preview))
    }

    pub(crate) async fn public_rooms(
        &self,
        PublicRoomsParams {
            server,
            search,
            since,
            room_type,
        }: PublicRoomsParams,
    ) -> Result<PublicRoomsOk, RpcError> {
        let server = match server.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(name) => Some(ServerName::parse(name).map_err(|_| RpcCode::UnknownHomeserver)?),
            None => None,
        };

        let mut filter = Filter::new();
        filter.generic_search_term = search
            .map(|term| term.trim().to_owned())
            .filter(|term| !term.is_empty());
        filter.room_types = match room_type {
            Some(DirectoryRoomType::Rooms) => vec![RoomTypeFilter::Default],
            Some(DirectoryRoomType::Spaces) => vec![RoomTypeFilter::Space],
            None => Vec::new(),
        };

        let mut request = get_public_rooms_filtered::v3::Request::new();
        request.server = server;
        request.filter = filter;
        request.since = since;
        request.limit = Some(UInt::from(DIRECTORY_PAGE_SIZE));

        let response = self
            .client()
            .send(lenient_public_rooms::Request::new(request))
            .await
            .or_failed(self.core(), "public_rooms")?;

        Ok(PublicRoomsOk {
            rooms: public_rooms(&response.chunk),
            next_batch: response.next_batch,
            total: response.total_room_count_estimate.map(u64::from),
        })
    }

    pub(crate) async fn space_hierarchy(
        &self,
        space_id: &OwnedRoomId,
        from: Option<String>,
    ) -> Result<HierarchyOk, RpcError> {
        let client = self.client();

        let mut request = get_hierarchy::v1::Request::new(space_id.clone());
        request.from = from;
        request.limit = Some(UInt::from(HIERARCHY_PAGE_SIZE));
        request.max_depth = Some(UInt::from(HIERARCHY_MAX_DEPTH));

        let response = client
            .send(lenient_hierarchy::Request::new(request))
            .with_request_config(RequestConfig::short_retry())
            .await
            .or_failed(self.core(), "space_hierarchy")?;

        Ok(HierarchyOk {
            rooms: hierarchy_rooms(&response.rooms),
            next_batch: response.next_batch,
        })
    }

    /// The send queue's local echoes carry the handle, whatever timeline shows them.
    pub(crate) async fn local_echo(
        &self,
        room_id: &OwnedRoomId,
        transaction_id: &str,
    ) -> Result<SendHandle, RpcError> {
        let (echoes, _updates) = self
            .room(room_id)?
            .send_queue()
            .subscribe()
            .await
            .or_failed(self.core(), "local_echo")?;
        echoes
            .into_iter()
            .find_map(|echo| match echo.content {
                LocalEchoContent::Event { send_handle, .. }
                    if echo.transaction_id == transaction_id =>
                {
                    Some(send_handle)
                }
                _ => None,
            })
            .ok_or_else(|| RpcCode::UnknownLocalEcho.into())
    }
}

/// Sends the non-empty content of each event of `types` as the same state in `to`. Best effort.
pub(crate) async fn copy_state(
    client: &Client,
    to: &RoomId,
    types: &[StateEventType],
    events: Vec<serde_json::Value>,
) {
    for value in events {
        let (Some(event_type), Some(state_key)) = (
            value.get("type").and_then(serde_json::Value::as_str),
            value.get("state_key").and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };
        let event_type = StateEventType::from(event_type);
        if !types.contains(&event_type) {
            continue;
        }
        let Some(Ok(content)) = value
            .get("content")
            .filter(|content| content.as_object().is_some_and(|map| !map.is_empty()))
            .map(ruma::serde::Raw::new)
        else {
            continue;
        };
        let request = send_state_event::v3::Request::new_raw(
            to.to_owned(),
            event_type.clone(),
            state_key.to_owned(),
            content.cast_unchecked(),
        );
        if let Err(error) = client.send(request).await {
            tracing::warn!(room = %to, %event_type, state_key, %error, "state not copied to the upgraded room");
        }
    }
}

/// Ordering lives on each parent's `m.space.child` edges, so the chunks are passed through
/// unsorted.
fn hierarchy_rooms(
    chunks: &[ruma::serde::Raw<SpaceHierarchyRoomsChunk>],
) -> Vec<SpaceHierarchyRoomView> {
    chunks
        .iter()
        .filter_map(|raw| crate::lenient::parse_or_skip(raw, "hierarchy room"))
        .map(|chunk| {
            let children = view::hierarchy_child_edges(&chunk.children_state);
            view::space_hierarchy_room(&chunk.summary, children)
        })
        .collect()
}

fn public_rooms(chunks: &[ruma::serde::Raw<PublicRoomsChunk>]) -> Vec<PublicRoomView> {
    chunks
        .iter()
        .filter_map(|raw| crate::lenient::parse_or_skip(raw, "public room"))
        .map(|chunk| view::public_room(&chunk))
        .collect()
}

mod lenient_hierarchy {
    use ruma::api::client::space::{SpaceHierarchyRoomsChunk, get_hierarchy};
    use ruma::api::response;
    use ruma::serde::Raw;

    pub(crate) type Request = crate::lenient::Request<get_hierarchy::v1::Request, Response>;

    #[response]
    pub(crate) struct Response {
        pub next_batch: Option<String>,
        pub rooms: Vec<Raw<SpaceHierarchyRoomsChunk>>,
    }
}

mod lenient_public_rooms {
    use ruma::UInt;
    use ruma::api::client::directory::get_public_rooms_filtered;
    use ruma::api::response;
    use ruma::directory::PublicRoomsChunk;
    use ruma::serde::Raw;

    pub(crate) type Request =
        crate::lenient::Request<get_public_rooms_filtered::v3::Request, Response>;

    #[response]
    pub(crate) struct Response {
        pub chunk: Vec<Raw<PublicRoomsChunk>>,
        pub next_batch: Option<String>,
        pub total_room_count_estimate: Option<UInt>,
    }
}

pub(crate) fn room_maybe_encrypted(room: &Room) -> bool {
    maybe_encrypted(&room.encryption_state())
}

const fn maybe_encrypted(state: &EncryptionState) -> bool {
    !matches!(state, EncryptionState::NotEncrypted)
}

pub(crate) fn join_rule_support(room: &Room) -> (bool, bool, bool) {
    let Some(room_version) = room.version() else {
        return (false, false, false);
    };
    let Some(rules) = room_version.rules() else {
        return (false, false, false);
    };

    (
        rules.authorization.knocking,
        rules.authorization.restricted_join_rule,
        rules.authorization.knock_restricted_join_rule,
    )
}

impl Core {
    pub(crate) async fn room_is_encrypted(&self, room: &Room) -> Result<bool, RpcError> {
        match room
            .latest_encryption_state()
            .await
            .or_failed(self, "room_encryption_state")?
        {
            EncryptionState::Encrypted => Ok(true),
            EncryptionState::NotEncrypted => Ok(false),
            EncryptionState::Unknown => Err(RpcCode::Unavailable.into()),
        }
    }

    async fn space_child_content(
        &self,
        space: &Room,
        room_id: &RoomId,
        context: &str,
    ) -> Result<Option<SpaceChildEventContent>, RpcError> {
        let Some(raw) = space
            .get_state_event_static_for_key::<SpaceChildEventContent, _>(room_id)
            .await
            .or_failed(self, context)?
        else {
            return Ok(None);
        };

        let Ok(SyncOrStrippedState::Sync(event)) = raw.deserialize() else {
            return Ok(None);
        };

        Ok(event
            .as_original()
            .map(|event| event.content.clone())
            .filter(|content| !content.via.is_empty()))
    }

    /// The SDK resolves an alias but joins by the alias, losing the servers that know the room.
    async fn join_route(
        &self,
        client: &Client,
        address: &str,
        via: &[String],
        context: &str,
    ) -> Result<(OwnedRoomId, Vec<OwnedServerName>), RpcError> {
        let address = RoomOrAliasId::parse(address).map_err(|_| RpcCode::UnknownRoom)?;
        let mut servers = via
            .iter()
            .filter_map(|server| ServerName::parse(server).ok())
            .collect::<Vec<_>>();

        let (room_id, resolved) = match <&RoomId>::try_from(&*address) {
            Ok(room_id) => (room_id.to_owned(), Vec::new()),
            Err(alias) => {
                let resolved = client
                    .resolve_room_alias(alias)
                    .await
                    .or_failed(self, context)?;
                servers.push(alias.server_name().to_owned());
                (resolved.room_id, resolved.servers)
            }
        };
        if let Some(room) = client.get_room(&room_id)
            && let Some(route) = crate::routing::Route::cached(&room).await
        {
            servers.extend(route.into_servers());
        }
        servers.extend(room_id.server_name().map(ToOwned::to_owned));
        servers.extend(resolved);

        let mut seen = std::collections::HashSet::new();
        servers.retain(|server| seen.insert(server.clone()));
        servers.truncate(MAX_JOIN_SERVERS);
        Ok((room_id, servers))
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::EncryptionState;

    use super::maybe_encrypted;

    #[test]
    fn an_unknown_encryption_state_is_treated_as_encrypted() {
        assert!(maybe_encrypted(&EncryptionState::Unknown));
    }

    #[test]
    fn an_invalid_hierarchy_room_does_not_fail_the_page() {
        use ruma::api::IncomingResponseExt as _;
        use serde_json::json;

        let room = |room_id: &str, alias: &str| {
            json!({
                "room_id": room_id,
                "canonical_alias": alias,
                "num_joined_members": 1,
                "world_readable": false,
                "guest_can_join": false,
                "join_rule": "public",
                "children_state": [],
            })
        };
        let body = json!({
            "rooms": [
                room("!space:example.org", "#space:example.org"),
                room("!broken:example.org", "broken:example.org"),
                room("!fine:example.org", "#fine:example.org"),
            ],
            "next_batch": "next",
        })
        .to_string();

        let response = super::lenient_hierarchy::Response::try_from_http_response(
            http::Response::new(body.as_bytes()),
        )
        .expect("the page parses");
        let rooms: Vec<_> = super::hierarchy_rooms(&response.rooms)
            .into_iter()
            .map(|room| room.room_id.to_string())
            .collect();

        assert_eq!(rooms, ["!space:example.org", "!fine:example.org"]);
        assert_eq!(response.next_batch.as_deref(), Some("next"));
    }

    #[tokio::test]
    async fn the_directory_request_reaches_the_server_unchanged() {
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use serde_json::json;
        use wiremock::matchers::{body_json, method, path, query_param};
        use wiremock::{Mock, ResponseTemplate};

        let server = MatrixMockServer::new().await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/publicRooms"))
            .and(query_param("server", "other.example.org"))
            .and(body_json(json!({
                "limit": super::DIRECTORY_PAGE_SIZE,
                "since": "start",
                "filter": {"generic_search_term": "matrix"},
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "chunk": [
                    {"room_id": "!first:example.org", "canonical_alias": "#first:example.org", "num_joined_members": 1, "world_readable": false, "guest_can_join": false},
                    {"room_id": "!broken:example.org", "canonical_alias": "broken", "num_joined_members": 1, "world_readable": false, "guest_can_join": false},
                    {"room_id": "!fine:example.org", "num_joined_members": 2, "world_readable": true, "guest_can_join": false},
                ],
                "next_batch": "next",
                "total_room_count_estimate": 3,
            })))
            .expect(1)
            .mount(server.server())
            .await;
        let client = server.client_builder().build().await;
        let (core, _events) = crate::test_support::signed_in_core(&server, client).await;
        let session = core.signed_in().unwrap();

        let page = session
            .public_rooms(crate::api::rooms::PublicRoomsParams {
                server: Some("other.example.org".to_owned()),
                search: Some("matrix".to_owned()),
                since: Some("start".to_owned()),
                room_type: None,
            })
            .await
            .unwrap();

        let rooms: Vec<_> = page
            .rooms
            .iter()
            .map(|room| room.room_id.as_str())
            .collect();
        assert_eq!(rooms, ["!first:example.org", "!fine:example.org"]);
        assert_eq!(page.next_batch.as_deref(), Some("next"));
        assert_eq!(page.total, Some(3));
    }

    #[tokio::test]
    async fn a_tombstone_with_an_empty_replacement_still_closes_the_room() {
        use matrix_sdk::ruma::{room_id, serde::Raw};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use matrix_sdk_test::JoinedRoomBuilder;
        use serde_json::json;

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!archived:example.org");
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_timeline_event(
                    Raw::new(&json!({
                        "type": "m.room.tombstone", "state_key": "", "event_id": "$archive",
                        "sender": "@admin:example.org", "origin_server_ts": 1,
                        "content": {"body": "This room has been archived.", "replacement_room": ""}
                    }))
                    .unwrap()
                    .cast_unchecked(),
                ),
            )
            .await;

        let room = client.get_room(room_id).unwrap();
        assert!(room.is_tombstoned());
        assert!(room.successor_room().is_none());
    }

    async fn sync_archived_room() -> (matrix_sdk::Client, matrix_sdk::Room) {
        use matrix_sdk::ruma::{room_id, serde::Raw};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use matrix_sdk_test::JoinedRoomBuilder;
        use serde_json::json;

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!archived:example.org");
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_state_event(
                    Raw::new(&json!({
                        "type": "m.room.tombstone", "state_key": "", "event_id": "$archive",
                        "sender": "@admin:example.org", "origin_server_ts": 1,
                        "content": {"body": "Archived"}
                    }))
                    .unwrap()
                    .cast_unchecked(),
                ),
            )
            .await;
        let room = client.get_room(room_id).unwrap();
        (client, room)
    }

    #[tokio::test]
    async fn a_synced_tombstone_without_a_replacement_closes_the_room() {
        let (client, room) = sync_archived_room().await;
        assert!(room.is_tombstoned());
        assert!(room.successor_room().is_none());
        let row = crate::view::listless_room_list_item(
            room,
            &ruma::push::Ruleset::server_default(client.user_id().unwrap()),
            &crate::nicknames::Nicknames::default(),
        )
        .await;
        assert!(row.is_tombstoned);
    }

    #[tokio::test]
    async fn the_migration_restores_a_dropped_tombstone() {
        let (client, room) = sync_archived_room().await;
        room.update_and_save_room_info(|info| {
            let mut saved = serde_json::to_value(info).unwrap();
            saved["base_info"]["tombstone"] = serde_json::Value::Null;
            (
                serde_json::from_value(saved).unwrap(),
                super::RoomInfoNotableUpdateReasons::NONE,
            )
        })
        .await
        .unwrap();
        assert!(!room.is_tombstoned());

        super::migrate_saved_tombstones(&client).await.unwrap();
        assert!(room.is_tombstoned());
        assert!(room.successor_room().is_none());
        let saved = client
            .state_store()
            .get_room_infos(&matrix_sdk::store::RoomLoadSettings::default())
            .await
            .unwrap();
        assert_eq!(
            saved[0].tombstone().unwrap().body.as_deref(),
            Some("Archived")
        );
    }

    #[tokio::test]
    async fn the_migration_removes_the_own_room_successor() {
        let (client, room) = sync_archived_room().await;
        room.update_and_save_room_info(|info| {
            let mut saved = serde_json::to_value(info).unwrap();
            saved["base_info"]["tombstone"]["PossiblyRedacted"]["content"]["replacement_room"] =
                serde_json::json!(room.room_id());
            (
                serde_json::from_value(saved).unwrap(),
                super::RoomInfoNotableUpdateReasons::NONE,
            )
        })
        .await
        .unwrap();
        assert_eq!(room.successor_room().unwrap().room_id, room.room_id());

        super::migrate_saved_tombstones(&client).await.unwrap();
        assert!(room.is_tombstoned());
        assert!(room.successor_room().is_none());
        let saved = client
            .state_store()
            .get_room_infos(&matrix_sdk::store::RoomLoadSettings::default())
            .await
            .unwrap();
        assert!(saved[0].tombstone().unwrap().replacement_room.is_none());
    }

    #[tokio::test]
    async fn the_tombstone_migration_does_not_run_twice() {
        let (client, room) = sync_archived_room().await;
        super::migrate_saved_tombstones(&client).await.unwrap();
        assert_eq!(
            client
                .state_store()
                .get_custom_value(super::TOMBSTONE_MIGRATION_KEY)
                .await
                .unwrap(),
            Some(vec![1]),
        );
        room.update_and_save_room_info(|info| {
            let mut saved = serde_json::to_value(info).unwrap();
            saved["base_info"]["tombstone"] = serde_json::Value::Null;
            (
                serde_json::from_value(saved).unwrap(),
                super::RoomInfoNotableUpdateReasons::NONE,
            )
        })
        .await
        .unwrap();

        super::migrate_saved_tombstones(&client).await.unwrap();
        assert!(!room.is_tombstoned());
    }

    #[tokio::test]
    async fn converting_to_a_chat_with_one_person_remembers_them() {
        use matrix_sdk::ruma::{room_id, user_id};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use matrix_sdk_test::JoinedRoomBuilder;
        use matrix_sdk_test::event_factory::EventFactory;
        use serde_json::json;
        use wiremock::matchers::{body_json, method, path_regex};
        use wiremock::{Mock, ResponseTemplate};

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!chat:example.org");
        let own = client.user_id().unwrap().to_owned();
        let partner = user_id!("@partner:example.org");
        let backup = user_id!("@backup:example.org");
        let factory = EventFactory::new().room(room_id);
        let members = [own.as_ref(), partner, backup];
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_state_bulk(members.iter().map(|member| factory.member(*member).into()))
                    .set_joined_members_count(3),
            )
            .await;
        let member_events: Vec<_> = members
            .iter()
            .map(|member| factory.member(*member).into_raw_timeline())
            .collect();
        Mock::given(method("GET"))
            .and(path_regex(r"/members"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "chunk": member_events })),
            )
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(
                r"/rooms/.*/account_data/moe\.sable\.direct_partner",
            ))
            .and(body_json(json!({ "user_id": partner })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"/account_data/m\.direct"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(r"/account_data/m\.direct"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        let (core, _events) = crate::test_support::signed_in_core(&server, client.clone()).await;
        let session = core.signed_in().unwrap();

        session
            .set_direct(&room_id.to_owned(), true, Some(partner.to_owned()))
            .await
            .unwrap();
    }
}
