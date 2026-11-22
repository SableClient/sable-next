use std::collections::BTreeSet;

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::Client;
use matrix_sdk::deserialized_responses::SyncOrStrippedState;
use matrix_sdk::room::{ParentSpace, Room};
use matrix_sdk::ruma::events::SyncStateEvent;
use matrix_sdk::ruma::events::space::child::{
    HierarchySpaceChildEvent, SpaceChildEventContent, SpaceChildOrd,
};
use matrix_sdk::ruma::room::{JoinRuleSummary, RoomSummary as RumaRoomSummary};
use matrix_sdk::ruma::{OwnedRoomId, RoomId};

use crate::api::rooms::RoomKind;
use crate::protocol::{SpaceChildEdge, SpaceHierarchyRoomView};

use super::directory::join_rule_summary_view;
use super::room::RoomInfo;

pub async fn restricted_parents(client: &Client, room: &Room) -> Vec<OwnedRoomId> {
    let mut parents = Vec::new();
    if let Ok(stream) = room.parent_spaces().await {
        pin_mut!(stream);
        while let Some(Ok(parent)) = stream.next().await {
            if let ParentSpace::Reciprocal(space) = parent
                && space.is_space()
            {
                parents.push(space.room_id().to_owned());
            }
        }
    }
    if !parents.is_empty() {
        return parents;
    }

    for space in client.joined_space_rooms() {
        let lists_room = space_children(&space)
            .await
            .unwrap_or_default()
            .iter()
            .any(|edge| edge.room_id == room.room_id().as_str() && !edge.via.is_empty());
        if lists_room {
            parents.push(space.room_id().to_owned());
        }
    }
    parents
}

pub async fn listing_spaces(
    core: Option<&crate::Core>,
    client: &Client,
    room_id: &RoomId,
) -> Vec<OwnedRoomId> {
    let mut spaces = Vec::new();
    for space in client.joined_space_rooms() {
        if space.is_tombstoned() {
            continue;
        }
        let children = match core {
            Some(core) => {
                core.with_open_stores(async || space_children(&space).await)
                    .await
            }
            None => space_children(&space).await,
        };
        let lists_room = children
            .unwrap_or_default()
            .iter()
            .any(|edge| edge.room_id == room_id.as_str() && !edge.via.is_empty());
        if lists_room {
            spaces.push(space.room_id().to_owned());
        }
    }
    spaces
}

#[must_use]
pub fn space_hierarchy_room(
    summary: &RumaRoomSummary,
    children: Vec<SpaceChildEdge>,
) -> SpaceHierarchyRoomView {
    SpaceHierarchyRoomView {
        room_id: summary.room_id.clone(),
        canonical_alias: summary.canonical_alias.as_ref().map(ToString::to_string),
        name: summary.name.clone(),
        topic: summary.topic.clone(),
        avatar_url: summary.avatar_url.as_ref().map(ToString::to_string),
        room_kind: RoomKind::from_room_type(summary.room_type.as_ref()),
        num_joined_members: u32::try_from(summary.num_joined_members).unwrap_or(u32::MAX),
        join_rule: join_rule_summary_view(&summary.join_rule),
        allowed_room_ids: match &summary.join_rule {
            JoinRuleSummary::Restricted(rule) | JoinRuleSummary::KnockRestricted(rule) => {
                rule.allowed_room_ids.clone()
            }
            _ => Vec::new(),
        },
        guest_can_join: summary.guest_can_join,
        children,
    }
}

#[must_use]
pub fn hierarchy_child_edges(
    events: &[ruma::serde::Raw<HierarchySpaceChildEvent>],
) -> Vec<SpaceChildEdge> {
    let mut events: Vec<_> = events
        .iter()
        .filter_map(|raw| raw.deserialize().ok())
        .collect();
    events.sort_by(SpaceChildOrd::cmp_space_child);
    let mut seen = BTreeSet::new();
    events
        .into_iter()
        .filter(|event| seen.insert(event.state_key.clone()))
        .map(|event| SpaceChildEdge {
            room_id: event.state_key.into(),
            via: event.content.via.iter().map(ToString::to_string).collect(),
            order: event.content.order.map(|order| order.to_string()),
            origin_server_ts: u64::from(event.origin_server_ts.get()),
            suggested: event.content.suggested,
            private: false,
        })
        .collect()
}

/// A failed read must not empty the space, which would unspace its rooms.
pub(super) fn kept_children(
    read: Result<Vec<SpaceChildEdge>, matrix_sdk::Error>,
    previous: Option<&RoomInfo>,
    room_id: &RoomId,
) -> (Vec<SpaceChildEdge>, bool) {
    match read {
        Ok(children) => (children, false),
        Err(error) => {
            if !previous.is_some_and(|info| info.children_stale) {
                tracing::warn!(
                    "could not read the children of {room_id}, keeping the last ones: {error}"
                );
            }
            (
                previous
                    .map(|info| info.children.clone())
                    .unwrap_or_default(),
                true,
            )
        }
    }
}

pub(crate) async fn space_children(room: &Room) -> Result<Vec<SpaceChildEdge>, matrix_sdk::Error> {
    let events = room
        .get_state_events_static::<SpaceChildEventContent>()
        .await?;

    let mut events: Vec<_> = events
        .into_iter()
        .filter_map(|event| {
            let SyncOrStrippedState::Sync(SyncStateEvent::Original(original)) =
                event.deserialize().ok()?
            else {
                return None;
            };
            Some(original)
        })
        .collect();
    events.sort_by(SpaceChildOrd::cmp_space_child);
    Ok(events
        .into_iter()
        .map(|event| SpaceChildEdge {
            room_id: event.state_key.into(),
            via: event.content.via.iter().map(ToString::to_string).collect(),
            order: event.content.order.map(|order| order.to_string()),
            origin_server_ts: u64::from(event.origin_server_ts.get()),
            suggested: event.content.suggested,
            private: false,
        })
        .collect())
}
