//! MSC4293: a ban or kick with `redact_events` removes what the user sent
//! since their previous member event. The timeline hides the same messages
//! with `BanRedaction`, which decides here too whether the sender may do it.

use matrix_sdk::Room;
use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::ruma::events::room::member::RoomMemberEventContent;
use matrix_sdk::ruma::events::{AnySyncStateEvent, AnySyncTimelineEvent, SyncStateEvent};
use matrix_sdk::ruma::{OwnedEventId, OwnedUserId};
use tracing::warn;

use super::store::Removal;
use crate::SignedIn;
use crate::timeline_overlay::BanRedaction;

pub(super) struct Ban {
    sender: OwnedUserId,
    target: OwnedUserId,
    content: RoomMemberEventContent,
    at: u64,
    previous: Option<OwnedEventId>,
}

/// The member events among `events` that ask for a user's events to be redacted.
pub(super) fn bans_in(events: &[TimelineEvent]) -> Vec<Ban> {
    events
        .iter()
        .filter_map(|event| {
            let Ok(AnySyncTimelineEvent::State(AnySyncStateEvent::RoomMember(
                SyncStateEvent::Original(member),
            ))) = event.raw().deserialize()
            else {
                return None;
            };
            member.content.redact_events.then(|| Ban {
                sender: member.sender,
                target: member.state_key,
                content: member.content,
                at: member.origin_server_ts.get().into(),
                previous: member.unsigned.replaces_state,
            })
        })
        .collect()
}

impl SignedIn {
    pub(super) async fn settle_bans(&self, room: &Room, bans: Vec<Ban>) {
        if bans.is_empty() {
            return;
        }
        let Ok(power_levels) = room.power_levels().await else {
            return;
        };
        for ban in bans {
            if BanRedaction::from_membership(
                &ban.sender,
                &ban.target,
                &ban.content,
                &power_levels,
                ban.at,
            )
            .is_none()
            {
                continue;
            }
            let after = match &ban.previous {
                Some(previous) => room
                    .load_or_fetch_event(previous, None)
                    .await
                    .ok()
                    .and_then(|event| event.timestamp_raw())
                    .map_or(0, |ts| u64::from(ts.get())),
                None => 0,
            };
            let removal = Removal {
                sender: ban.target,
                after,
                until: ban.at,
            };
            if let Err(error) = self
                .search_store()
                .await
                .apply_removal(room.room_id(), removal)
                .await
            {
                warn!("search index could not apply a ban redaction: {error}");
            }
        }
    }
}
