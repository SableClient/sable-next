use matrix_sdk::config::RequestConfig;
use matrix_sdk::deserialized_responses::SyncOrStrippedState;
use matrix_sdk::room::Room;
use matrix_sdk::ruma::SpaceChildOrder;
use matrix_sdk::ruma::api::client::directory::get_public_rooms_filtered;
use matrix_sdk::ruma::api::client::membership::joined_rooms;
use matrix_sdk::ruma::api::client::space::get_hierarchy;
use matrix_sdk::ruma::directory::Filter;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, RoomId, RoomOrAliasId, ServerName, UInt};
use matrix_sdk::send_queue::SendHandle;
use matrix_sdk::{Client, RoomMemberships, RoomState};
use matrix_sdk_base::{RoomInfo, RoomInfoNotableUpdateReasons};

use crate::protocol::{CommandErr, CommandOk};

use crate::Core;
use crate::view;

const HIERARCHY_PAGE_SIZE: u32 = 100;
const HIERARCHY_MAX_DEPTH: u32 = 1;
const DIRECTORY_PAGE_SIZE: u32 = 30;
const OWN_MEMBER_FILL_MAX_MEMBERS: u64 = 50;

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
    pub(crate) async fn fill_own_members(&self) {
        let Ok(client) = self.client().await else {
            return;
        };
        if let Err(error) = fill_own_members(&client).await {
            tracing::warn!("could not fill in our own room memberships: {error}");
        }
    }

    pub(crate) async fn align_encrypted_defaults(&self) {
        let Ok(client) = self.client().await else {
            return;
        };
        if let Err(error) = crate::notifications::align_encrypted_defaults(&client).await {
            tracing::warn!("could not align the encrypted notification defaults: {error}");
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
            .map_err(|error| self.failed("add_to_space", error))?;

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
            .map_err(|error| self.failed("room_via_servers", error))?;

        let ranked: Vec<(String, i32)> = members
            .iter()
            .map(|member| {
                (
                    member.user_id().to_string(),
                    view::clamp_power_level(member.power_level()),
                )
            })
            .collect();

        Ok(view::via_servers(&ranked))
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
            .map_err(|error| self.failed(context, error))?
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
                    .map_err(|error| self.failed("set_space_child_order: invalid order", error))?,
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
            .map_err(|error| self.failed("knock_room", error))?;

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
            .map_err(|error| self.failed("room_preview", error))?;

        Ok(CommandOk::RoomPreview {
            preview: view::room_preview_view(&preview),
        })
    }

    pub(crate) async fn public_rooms(
        &self,
        server: Option<String>,
        search: Option<String>,
        since: Option<String>,
    ) -> Result<CommandOk, CommandErr> {
        let server = match server.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(name) => Some(ServerName::parse(name).map_err(|_| CommandErr::UnknownHomeserver)?),
            None => None,
        };

        let mut filter = Filter::new();
        filter.generic_search_term = search
            .map(|term| term.trim().to_owned())
            .filter(|term| !term.is_empty());

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
            .map_err(|error| self.failed("public_rooms", error))?;

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
            .map_err(|error| self.failed("space_hierarchy", error))?;

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
