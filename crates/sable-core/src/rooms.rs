use matrix_sdk::config::RequestConfig;
use matrix_sdk::deserialized_responses::SyncOrStrippedState;
use matrix_sdk::room::Room;
use matrix_sdk::ruma::SpaceChildOrder;
use matrix_sdk::ruma::api::client::directory::get_public_rooms_filtered;
use matrix_sdk::ruma::api::client::membership::joined_rooms;
use matrix_sdk::ruma::api::client::space::get_hierarchy;
use matrix_sdk::ruma::directory::{Filter, RoomTypeFilter};
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::events::room::join_rules::{AllowRule, JoinRule, RoomJoinRulesEventContent};
use matrix_sdk::ruma::events::room::tombstone::RoomTombstoneEventContent;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, RoomId, RoomOrAliasId, ServerName, UInt};
use matrix_sdk::send_queue::SendHandle;
use matrix_sdk::{Client, EncryptionState, RoomMemberships, RoomState};
use matrix_sdk_base::{RawStateEventWithKeys, RoomInfo, RoomInfoNotableUpdateReasons};

use crate::ResultExt;
use crate::protocol::{CommandErr, CommandOk, DirectoryRoomType, JoinRuleView};

use crate::Core;
use crate::view;

const HIERARCHY_PAGE_SIZE: u32 = 100;
const HIERARCHY_MAX_DEPTH: u32 = 1;
const DIRECTORY_PAGE_SIZE: u32 = 30;
const OWN_MEMBER_FILL_MAX_MEMBERS: u64 = 50;
const MEMBERSHIP_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

pub(crate) fn repair_unreadable_tombstones(
    client: &Client,
) -> matrix_sdk::event_handler::EventHandlerHandle {
    client.add_event_handler(|raw: Raw<AnySyncTimelineEvent>, room: Room| async move {
        if raw.get_field::<&str>("type").ok().flatten() != Some("m.room.tombstone") {
            return;
        }
        let Ok(mut event) = raw.deserialize_as_unchecked::<serde_json::Value>() else {
            return;
        };
        let empty_replacement = event.get("type").and_then(|kind| kind.as_str())
            == Some("m.room.tombstone")
            && event.get("state_key").and_then(|key| key.as_str()) == Some("")
            && event
                .pointer("/content/replacement_room")
                .and_then(|room| room.as_str())
                == Some("");
        if !empty_replacement || room.is_tombstoned() {
            return;
        }
        if let Some(content) = event.get_mut("content").and_then(|c| c.as_object_mut()) {
            content.insert("replacement_room".into(), room.room_id().as_str().into());
        }
        let Ok(sanitized) = Raw::new(&event) else {
            return;
        };
        let Some(mut keys) =
            RawStateEventWithKeys::try_from_raw_state_event(sanitized.cast_unchecked())
        else {
            return;
        };
        let saved = room
            .update_and_save_room_info(|mut info| {
                info.handle_state_event(&mut keys);
                (info, RoomInfoNotableUpdateReasons::NONE)
            })
            .await;
        if let Err(error) = saved {
            tracing::warn!("could not record an unreadable tombstone: {error}");
        }
    })
}

pub(crate) async fn reconcile_memberships(client: &Client) -> Result<(), matrix_sdk::Error> {
    let joined = client
        .send(joined_rooms::v3::Request::new())
        .await?
        .joined_rooms;

    for room in client.rooms() {
        let mark: fn(&mut RoomInfo) =
            match (room.state(), joined.iter().any(|id| id == room.room_id())) {
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
    let Some(own) = client.user_id() else {
        return Ok(());
    };
    for room in client.joined_rooms() {
        if room.joined_members_count() > OWN_MEMBER_FILL_MAX_MEMBERS
            || room.get_member_no_sync(own).await?.is_some()
        {
            continue;
        }
        if let Err(error) = room.sync_members().await {
            tracing::warn!(room_id = %room.room_id(), "could not fetch our own membership: {error}");
        }
    }
    Ok(())
}

impl Core {
    pub(crate) async fn set_direct(
        &self,
        room_id: &OwnedRoomId,
        direct: bool,
        user_id: Option<matrix_sdk::ruma::OwnedUserId>,
    ) -> Result<(), CommandErr> {
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
                Some(_) => return Err(CommandErr::Denied),
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
    ) -> Result<(), CommandErr> {
        let room = self.room(room_id).await?;
        let (supports_knock, supports_restricted, supports_knock_restricted) =
            join_rule_support(&room);
        let content = match rule {
            JoinRuleView::Public => RoomJoinRulesEventContent::new(JoinRule::Public),
            JoinRuleView::Invite => RoomJoinRulesEventContent::new(JoinRule::Invite),
            JoinRuleView::Knock if supports_knock => {
                RoomJoinRulesEventContent::new(JoinRule::Knock)
            }
            JoinRuleView::Knock => return Err(CommandErr::Unsupported),
            JoinRuleView::Restricted if !supports_restricted => {
                return Err(CommandErr::Unsupported);
            }
            JoinRuleView::KnockRestricted if !supports_knock_restricted => {
                return Err(CommandErr::Unsupported);
            }
            JoinRuleView::Restricted | JoinRuleView::KnockRestricted => {
                let client = self.client().await?;
                let allow: Vec<_> = view::restricted_parents(&client, &room)
                    .await
                    .into_iter()
                    .map(AllowRule::room_membership)
                    .collect();
                if allow.is_empty() {
                    return Err(CommandErr::Denied);
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
        let Ok(rules) = self.push_rules().await else {
            return;
        };
        let writes = crate::push_rules::plan_alignment(&rules.snapshot().await);
        if writes.is_empty() {
            return;
        }
        if let Err(error) = rules.apply(writes).await {
            tracing::warn!("could not align notification rules: {error}");
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

    pub(crate) async fn room_is_encrypted(&self, room: &Room) -> Result<bool, CommandErr> {
        match room
            .latest_encryption_state()
            .await
            .map_err(|error| self.room_error("room_encryption_state", error))?
        {
            matrix_sdk::EncryptionState::Encrypted => Ok(true),
            matrix_sdk::EncryptionState::NotEncrypted => Ok(false),
            matrix_sdk::EncryptionState::Unknown => Err(CommandErr::Unavailable),
        }
    }

    /// Without a `via` server the edge is ignored, so a child that is already
    /// listed keeps its own `via`, `order` and `suggested`.
    pub(crate) async fn add_to_space(
        &self,
        space_id: &OwnedRoomId,
        room_id: &RoomId,
        suggested: Option<bool>,
    ) -> Result<(), CommandErr> {
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

    async fn child_via(&self, room_id: &RoomId) -> Result<Vec<String>, CommandErr> {
        let client = self.client().await?;
        let own = client
            .user_id()
            .ok_or(CommandErr::NotLoggedIn)?
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

    pub(crate) async fn room_via_servers(&self, room: &Room) -> Result<Vec<String>, CommandErr> {
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
    ) -> Result<Option<SpaceChildEventContent>, CommandErr> {
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
    ) -> Result<CommandOk, CommandErr> {
        let space = self.room(space_id).await?;

        let mut content = self
            .space_child_content(&space, room_id, "set_space_child_order: read")
            .await?
            .ok_or(CommandErr::UnknownRoom)?;

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

        Ok(CommandOk::SetSpaceChildOrder)
    }

    pub(crate) async fn set_space_child_suggested(
        &self,
        space_id: &OwnedRoomId,
        room_id: &RoomId,
        suggested: bool,
    ) -> Result<CommandOk, CommandErr> {
        let space = self.room(space_id).await?;

        let mut content = self
            .space_child_content(&space, room_id, "set_space_child_suggested: read")
            .await?
            .ok_or(CommandErr::UnknownRoom)?;
        content.suggested = suggested;

        space
            .send_state_event_for_key(room_id, content)
            .await
            .map_err(|error| self.room_error("set_space_child_suggested", error))?;

        Ok(CommandOk::SetSpaceChildSuggested)
    }

    pub(crate) async fn knock_room(
        &self,
        address: &str,
        via: &[String],
        reason: Option<String>,
    ) -> Result<CommandOk, CommandErr> {
        let address = RoomOrAliasId::parse(address).map_err(|_| CommandErr::UnknownRoom)?;
        let via = via
            .iter()
            .filter_map(|server| ServerName::parse(server).ok())
            .collect::<Vec<_>>();

        let room = self
            .client()
            .await?
            .knock(address, reason, via)
            .await
            .or_failed(self, "knock_room")?;

        Ok(CommandOk::KnockRoom {
            room_id: room.room_id().to_owned(),
        })
    }

    pub(crate) async fn room_preview(
        &self,
        address: &str,
        via: &[String],
    ) -> Result<CommandOk, CommandErr> {
        let address = RoomOrAliasId::parse(address).map_err(|_| CommandErr::UnknownRoom)?;
        let via = via
            .iter()
            .filter_map(|server| ServerName::parse(server).ok())
            .collect::<Vec<_>>();

        let preview = self
            .client()
            .await?
            .get_room_preview(&address, via)
            .await
            .or_failed(self, "room_preview")?;

        Ok(CommandOk::RoomPreview {
            preview: view::room_preview_view(&preview),
        })
    }

    pub(crate) async fn public_rooms(
        &self,
        server: Option<String>,
        search: Option<String>,
        since: Option<String>,
        room_type: Option<DirectoryRoomType>,
    ) -> Result<CommandOk, CommandErr> {
        let server = match server.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(name) => Some(ServerName::parse(name).map_err(|_| CommandErr::UnknownHomeserver)?),
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

        Ok(CommandOk::PublicRooms {
            rooms: response.chunk.iter().map(view::public_room).collect(),
            next_batch: response.next_batch,
            total: response.total_room_count_estimate.map(u64::from),
        })
    }

    pub(crate) async fn space_hierarchy(
        &self,
        space_id: &OwnedRoomId,
        from: Option<String>,
    ) -> Result<CommandOk, CommandErr> {
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

        Ok(CommandOk::SpaceHierarchy {
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
    ) -> Result<SendHandle, CommandErr> {
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
            .ok_or(CommandErr::UnknownLocalEcho)
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
        let _handle = super::repair_unreadable_tombstones(&client);
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
