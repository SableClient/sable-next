use matrix_sdk::config::RequestConfig;
use matrix_sdk::deserialized_responses::SyncOrStrippedState;
use matrix_sdk::room::Room;
use matrix_sdk::ruma::api::client::space::get_hierarchy;
use matrix_sdk::ruma::events::room::create::RoomCreateEventContent;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::{
    OwnedRoomId, RoomId, RoomOrAliasId, ServerName, UInt, events::SyncStateEvent,
};
use matrix_sdk::send_queue::SendHandle;

use crate::protocol::{CommandErr, CommandOk};

use crate::Core;
use crate::view;

const HIERARCHY_PAGE_SIZE: u32 = 100;

impl Core {
    /// Without a `via` server the edge is ignored.
    pub(crate) async fn add_to_space(
        &self,
        space_id: &OwnedRoomId,
        room_id: &RoomId,
    ) -> Result<(), CommandErr> {
        let client = self.client().await?;
        let via = vec![
            client
                .user_id()
                .ok_or(CommandErr::NotLoggedIn)?
                .server_name()
                .to_owned(),
        ];

        self.room(space_id)
            .await?
            .send_state_event_for_key(room_id, SpaceChildEventContent::new(via))
            .await
            .map_err(|error| self.failed("add_to_space", error))?;

        Ok(())
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

    pub(crate) async fn space_hierarchy(
        &self,
        space_id: &OwnedRoomId,
        from: Option<String>,
    ) -> Result<CommandOk, CommandErr> {
        let client = self.client().await?;

        let mut request = get_hierarchy::v1::Request::new(space_id.clone());
        request.from = from;
        request.limit = Some(UInt::from(HIERARCHY_PAGE_SIZE));

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
    ) -> Result<SendHandle, CommandErr> {
        self.timeline(room_id)
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

pub(crate) async fn join_rule_support(room: &Room) -> (bool, bool, bool) {
    let Ok(Some(event)) = room
        .get_state_event_static::<RoomCreateEventContent>()
        .await
    else {
        return (false, false, false);
    };
    let room_version = match event.deserialize() {
        Ok(SyncOrStrippedState::Sync(SyncStateEvent::Original(event))) => {
            event.content.room_version
        }
        Ok(SyncOrStrippedState::Stripped(event)) => event.content.room_version,
        _ => return (false, false, false),
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
