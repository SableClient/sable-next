use std::collections::BTreeSet;

use crate::api::rooms::DirectoryRoomType;
use crate::api::rooms::PublicRoomsParams;
use matrix_sdk::config::RequestConfig;
use matrix_sdk::deserialized_responses::{RawAnySyncOrStrippedState, SyncOrStrippedState};
use matrix_sdk::room::Room;
use matrix_sdk::ruma::SpaceChildOrder;
use matrix_sdk::ruma::api::FeatureFlag;
use matrix_sdk::ruma::api::client::directory::get_public_rooms_filtered;
use matrix_sdk::ruma::api::client::membership::joined_rooms;
use matrix_sdk::ruma::api::client::space::get_hierarchy;
use matrix_sdk::ruma::directory::{Filter, RoomTypeFilter};
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::events::room::join_rules::{AllowRule, JoinRule, RoomJoinRulesEventContent};
use matrix_sdk::ruma::events::room::tombstone::RoomTombstoneEventContent;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::{
    OwnedEventId, OwnedRoomId, OwnedServerName, RoomId, RoomOrAliasId, ServerName, UInt,
};
use matrix_sdk::send_queue::SendHandle;
use matrix_sdk::{Client, EncryptionState, RoomMemberships, RoomState};
use matrix_sdk_base::{RawStateEventWithKeys, RoomInfo, RoomInfoNotableUpdateReasons};

use crate::ResultExt;
use crate::api::rooms::PublicRoomsOk;
use crate::api::spaces::HierarchyOk;
use crate::protocol::{JoinRuleView, RoomPreviewView, RpcError};

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

pub(crate) async fn reconcile_memberships(client: &Client) -> Result<(), matrix_sdk::Error> {
    let joined: std::collections::HashSet<_> = client
        .send(joined_rooms::v3::Request::new())
        .await?
        .joined_rooms
        .into_iter()
        .collect();

    for room in client.rooms() {
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

pub(crate) async fn poll_memberships(core: std::sync::Arc<crate::Core>, client: Client) {
    loop {
        matrix_sdk::sleep::sleep(MEMBERSHIP_POLL_INTERVAL).await;
        core.wait_until_active().await;
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

pub(crate) async fn fill_own_member(room: &matrix_sdk::Room) -> Result<(), matrix_sdk::Error> {
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

impl Core {
    /// The active account, with the rooms it left or was banned from: their conversations are gone.
    ///
    /// # Errors
    ///
    /// When no account is signed in.
    pub async fn left_rooms(&self) -> Result<(String, Vec<String>), RpcError> {
        let client = self.client().await?;
        let user_id = client.user_id().ok_or(RpcError::NotLoggedIn)?.to_string();
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
        user_id: Option<matrix_sdk::ruma::OwnedUserId>,
    ) -> Result<(), RpcError> {
        let client = self.client().await?;
        let room = self.room(room_id).await?;

        if direct {
            let members = room
                .members(RoomMemberships::ACTIVE)
                .await
                .or_failed(self, "set_direct_members")?;
            let others = match user_id {
                Some(user_id)
                    if Some(user_id.as_ref()) != client.user_id()
                        && members.iter().any(|member| member.user_id() == user_id) =>
                {
                    vec![user_id]
                }
                Some(_) => return Err(RpcError::Denied),
                None => members
                    .iter()
                    .map(|member| member.user_id().to_owned())
                    .filter(|user_id| Some(user_id.as_ref()) != client.user_id())
                    .collect(),
            };
            client
                .account()
                .mark_as_dm(room_id, &others)
                .await
                .or_failed(self, "set_direct")?;
        } else {
            room.set_is_direct(false)
                .await
                .or_failed(self, "unset_direct")?;
        }

        Ok(())
    }

    pub(crate) async fn set_room_join_rule(
        &self,
        room_id: &OwnedRoomId,
        rule: JoinRuleView,
    ) -> Result<(), RpcError> {
        let room = self.room(room_id).await?;
        let (supports_knock, supports_restricted, supports_knock_restricted) =
            join_rule_support(&room);
        let content = match rule {
            JoinRuleView::Public => RoomJoinRulesEventContent::new(JoinRule::Public),
            JoinRuleView::Invite => RoomJoinRulesEventContent::new(JoinRule::Invite),
            JoinRuleView::Knock if supports_knock => {
                RoomJoinRulesEventContent::new(JoinRule::Knock)
            }
            JoinRuleView::Knock => return Err(RpcError::Unsupported),
            JoinRuleView::Restricted if !supports_restricted => {
                return Err(RpcError::Unsupported);
            }
            JoinRuleView::KnockRestricted if !supports_knock_restricted => {
                return Err(RpcError::Unsupported);
            }
            JoinRuleView::Restricted | JoinRuleView::KnockRestricted => {
                let client = self.client().await?;
                let allow: Vec<_> = view::restricted_parents(&client, &room)
                    .await
                    .into_iter()
                    .map(AllowRule::room_membership)
                    .collect();
                if allow.is_empty() {
                    return Err(RpcError::Denied);
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
            .map_err(|error| self.room_error("set_room_join_rule", error))?;
        Ok(())
    }

    pub(crate) async fn fill_own_members(&self) {
        let Ok(client) = self.client().await else {
            return;
        };
        if let Err(error) = fill_own_members(&client).await {
            tracing::warn!("could not fill in our own room memberships: {error}");
        }
    }

    pub(crate) async fn align_notification_rules(&self) {
        let (Ok(client), Ok(rules)) = (self.client().await, self.push_rules().await) else {
            return;
        };
        let writes = crate::push_rules::plan_alignment(&rules.snapshot().await);
        if let Err(error) = rules.apply(writes).await {
            tracing::warn!("could not align notification rules: {error}");
            return;
        }
        let shaped: Vec<_> = client
            .joined_rooms()
            .iter()
            .filter_map(|room| {
                let direct = crate::notifications::uses_direct_push_rules(room);
                let joined = room.joined_members_count();
                ((direct && joined > 2) || (!direct && joined == 2))
                    .then(|| (room.room_id().to_owned(), direct))
            })
            .collect();
        let writes = crate::push_rules::plan_room_shapes(&rules.snapshot().await, &shaped);
        if let Err(error) = rules.apply(writes).await {
            tracing::warn!("could not align notification rules to the direct chats: {error}");
        }
    }

    pub(crate) async fn reconcile_memberships(&self) {
        let Ok(client) = self.client().await else {
            return;
        };
        if let Err(error) = reconcile_memberships(&client).await {
            tracing::warn!("could not reconcile room memberships: {error}");
        }
    }

    pub(crate) async fn room_is_encrypted(&self, room: &Room) -> Result<bool, RpcError> {
        match room
            .latest_encryption_state()
            .await
            .map_err(|error| self.room_error("room_encryption_state", error))?
        {
            matrix_sdk::EncryptionState::Encrypted => Ok(true),
            matrix_sdk::EncryptionState::NotEncrypted => Ok(false),
            matrix_sdk::EncryptionState::Unknown => Err(RpcError::Unavailable),
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
        let space = self.room(space_id).await?;
        if let Some(mut content) = self
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
                .map_err(|error| self.room_error("add_to_space", error))?;
            return Ok(());
        }

        let via = self
            .child_via(room_id)
            .await?
            .iter()
            .filter_map(|server| ServerName::parse(server).ok())
            .collect();

        let mut content = SpaceChildEventContent::new(via);
        content.suggested = suggested.unwrap_or(false);

        space
            .send_state_event_for_key(room_id, content)
            .await
            .or_failed(self, "add_to_space")?;

        Ok(())
    }

    async fn child_via(&self, room_id: &RoomId) -> Result<Vec<String>, RpcError> {
        let client = self.client().await?;
        let own = client
            .user_id()
            .ok_or(RpcError::NotLoggedIn)?
            .server_name()
            .to_string();

        let via = match client.get_room(room_id) {
            Some(room) => self.room_via_servers(&room).await.unwrap_or_else(|error| {
                tracing::warn!("add_to_space: no via for {room_id}: {error:?}");
                Vec::new()
            }),
            None => Vec::new(),
        };

        Ok(if via.is_empty() { vec![own] } else { via })
    }

    pub(crate) async fn room_via_servers(&self, room: &Room) -> Result<Vec<String>, RpcError> {
        let members = room
            .members(RoomMemberships::JOIN)
            .await
            .or_failed(self, "room_via_servers")?;

        let ranked: Vec<(String, i64)> = members
            .iter()
            .map(|member| {
                (
                    member.user_id().to_string(),
                    view::clamp_power_level(member.power_level()),
                )
            })
            .collect();

        let mut via = view::via_servers(&ranked);
        if let Some(event) = room
            .get_state_event_static::<RoomTombstoneEventContent>()
            .await
            .or_failed(self, "room_via_servers")?
            .and_then(|event| event.deserialize().ok())
        {
            let sender = match &event {
                SyncOrStrippedState::Sync(event) => event.as_original().map(|event| &event.sender),
                SyncOrStrippedState::Stripped(event) => Some(&event.sender),
            };
            if let Some(sender) = sender {
                let server = sender.server_name().to_string();
                if !via.contains(&server) {
                    via.insert(0, server);
                }
            }
        }
        Ok(via)
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

    pub(crate) async fn set_space_child_order(
        &self,
        space_id: &OwnedRoomId,
        room_id: &RoomId,
        order: Option<String>,
    ) -> Result<(), RpcError> {
        let space = self.room(space_id).await?;

        let mut content = self
            .space_child_content(&space, room_id, "set_space_child_order: read")
            .await?
            .ok_or(RpcError::UnknownRoom)?;

        content.order = match order {
            Some(order) => Some(
                SpaceChildOrder::parse(order)
                    .or_failed(self, "set_space_child_order_invalid_order")?,
            ),
            None => None,
        };

        space
            .send_state_event_for_key(room_id, content)
            .await
            .map_err(|error| self.room_error("set_space_child_order", error))?;

        Ok(())
    }

    pub(crate) async fn set_space_child_suggested(
        &self,
        space_id: &OwnedRoomId,
        room_id: &RoomId,
        suggested: bool,
    ) -> Result<(), RpcError> {
        let space = self.room(space_id).await?;

        let mut content = self
            .space_child_content(&space, room_id, "set_space_child_suggested: read")
            .await?
            .ok_or(RpcError::UnknownRoom)?;
        content.suggested = suggested;

        space
            .send_state_event_for_key(room_id, content)
            .await
            .map_err(|error| self.room_error("set_space_child_suggested", error))?;

        Ok(())
    }

    /// The SDK resolves an alias but joins by the alias, losing the servers that know the room.
    async fn join_route(
        &self,
        client: &Client,
        address: &str,
        via: &[String],
        context: &str,
    ) -> Result<(OwnedRoomId, Vec<OwnedServerName>), RpcError> {
        let address = RoomOrAliasId::parse(address).map_err(|_| RpcError::UnknownRoom)?;
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
                    .map_err(|error| self.room_error(context, error.into()))?;
                servers.push(alias.server_name().to_owned());
                (resolved.room_id, resolved.servers)
            }
        };
        servers.extend(room_id.server_name().map(ToOwned::to_owned));
        servers.extend(resolved);

        let mut seen = std::collections::HashSet::new();
        servers.retain(|server| seen.insert(server.clone()));
        servers.truncate(MAX_JOIN_SERVERS);
        Ok((room_id, servers))
    }

    pub(crate) async fn join_room(
        &self,
        address: &str,
        via: &[String],
    ) -> Result<OwnedRoomId, RpcError> {
        let client = self.client().await?;
        let (room_id, servers) = self.join_route(&client, address, via, "join_room").await?;

        let room = client
            .join_room_by_id_or_alias((&*room_id).into(), &servers)
            .await
            .map_err(|error| self.room_error("join_room", error))?;

        Ok(room.room_id().to_owned())
    }

    pub(crate) async fn knock_room(
        &self,
        address: &str,
        via: &[String],
        reason: Option<String>,
    ) -> Result<OwnedRoomId, RpcError> {
        let client = self.client().await?;
        let (room_id, servers) = self.join_route(&client, address, via, "knock_room").await?;

        let room = client
            .knock(room_id.into(), reason, servers)
            .await
            .or_failed(self, "knock_room")?;

        Ok(room.room_id().to_owned())
    }

    pub(crate) async fn room_preview(
        &self,
        address: &str,
        via: &[String],
    ) -> Result<RoomPreviewView, RpcError> {
        let client = self.client().await?;
        let address = RoomOrAliasId::parse(address).map_err(|_| RpcError::UnknownRoom)?;
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
            .or_failed(self, "room_preview")?;

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
            Some(name) => Some(ServerName::parse(name).map_err(|_| RpcError::UnknownHomeserver)?),
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
            .await?
            .public_rooms_filtered(request)
            .await
            .map_err(|error| self.room_error("public_rooms", error.into()))?;

        Ok(PublicRoomsOk {
            rooms: response.chunk.iter().map(view::public_room).collect(),
            next_batch: response.next_batch,
            total: response.total_room_count_estimate.map(u64::from),
        })
    }

    pub(crate) async fn space_hierarchy(
        &self,
        space_id: &OwnedRoomId,
        from: Option<String>,
    ) -> Result<HierarchyOk, RpcError> {
        let client = self.client().await?;

        let mut request = get_hierarchy::v1::Request::new(space_id.clone());
        request.from = from;
        request.limit = Some(UInt::from(HIERARCHY_PAGE_SIZE));
        request.max_depth = Some(UInt::from(HIERARCHY_MAX_DEPTH));

        let response = client
            .send(request)
            .with_request_config(RequestConfig::short_retry())
            .await
            .or_failed(self, "space_hierarchy")?;

        // Ordering lives on each parent's `m.space.child` edges, so the chunks
        // are passed through unsorted.
        let rooms = response
            .rooms
            .into_iter()
            .map(|chunk| {
                let children = view::hierarchy_child_edges(&chunk.children_state);
                view::space_hierarchy_room(&chunk.summary, children)
            })
            .collect();

        Ok(HierarchyOk {
            rooms,
            next_batch: response.next_batch,
        })
    }

    /// The handle lives on the timeline item, so the id has to be looked up.
    pub(crate) async fn local_echo(
        &self,
        room_id: &OwnedRoomId,
        transaction_id: &str,
        thread_root: Option<&OwnedEventId>,
    ) -> Result<SendHandle, RpcError> {
        self.timeline_for(room_id, thread_root)
            .await?
            .items()
            .await
            .iter()
            .filter_map(|item| item.as_event())
            .find(|event| {
                event
                    .transaction_id()
                    .is_some_and(|id| id == transaction_id)
            })
            .and_then(matrix_sdk_ui::timeline::EventTimelineItem::local_echo_send_handle)
            .ok_or(RpcError::UnknownLocalEcho)
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

#[cfg(test)]
mod tests {
    use matrix_sdk::EncryptionState;

    use super::maybe_encrypted;

    #[test]
    fn an_unknown_encryption_state_is_treated_as_encrypted() {
        assert!(maybe_encrypted(&EncryptionState::Unknown));
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
            &matrix_sdk::ruma::push::Ruleset::server_default(client.user_id().unwrap()),
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
    async fn upgrade_routes_include_the_tombstone_sender() {
        use matrix_sdk::ruma::{room_id, serde::Raw};
        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use matrix_sdk_test::JoinedRoomBuilder;
        use serde_json::json;
        use wiremock::{
            Mock, ResponseTemplate,
            matchers::{method, path_regex},
        };

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!old:example.org");
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_state_event(
                    Raw::new(&json!({
                        "type": "m.room.tombstone", "state_key": "", "event_id": "$upgrade",
                        "sender": "@upgrader:[2001:db8::1]:8448", "origin_server_ts": 1,
                        "content": {"body": "upgraded", "replacement_room": "!new:example.org"}
                    }))
                    .unwrap()
                    .cast_unchecked(),
                ),
            )
            .await;
        Mock::given(method("GET"))
            .and(path_regex("/_matrix/client/v3/rooms/.*/members"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": []})))
            .mount(server.server())
            .await;
        let (core, _events) = crate::Core::new(
            "routes",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        let via = core
            .room_via_servers(&client.get_room(room_id).unwrap())
            .await
            .unwrap();
        assert_eq!(
            via.iter()
                .filter(|server| *server == "[2001:db8::1]:8448")
                .count(),
            1
        );
    }
}
