use std::collections::HashMap;
use std::sync::Arc;

use matrix_sdk::ruma::api::client::state::get_state_events;
use matrix_sdk::ruma::events::{AnyStateEvent, AnySyncStateEvent};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedRoomId, RoomId};
use serde_json::Value;

use crate::protocol::RoomStateEventView;

#[derive(Default)]
pub(crate) struct ProbedState {
    rooms: HashMap<OwnedRoomId, ProbedRoom>,
}

pub(crate) enum Probed {
    Unknown,
    Absent,
    Present(Value),
}

#[derive(Default)]
struct ProbedRoom {
    full: Option<HashMap<String, Vec<RoomStateEventView>>>,
    keys: HashMap<(String, String), Option<Value>>,
}

impl ProbedState {
    pub(crate) fn events(
        &self,
        room_id: &RoomId,
        event_type: &str,
    ) -> Option<Vec<RoomStateEventView>> {
        let full = self.rooms.get(room_id)?.full.as_ref()?;
        Some(full.get(event_type).cloned().unwrap_or_default())
    }

    pub(crate) fn content(&self, room_id: &RoomId, event_type: &str, state_key: &str) -> Probed {
        let Some(room) = self.rooms.get(room_id) else {
            return Probed::Unknown;
        };
        if let Some(full) = &room.full {
            return full
                .get(event_type)
                .and_then(|events| events.iter().find(|event| event.state_key == state_key))
                .map_or(Probed::Absent, |event| {
                    Probed::Present(event.content.clone())
                });
        }
        match room
            .keys
            .get(&(event_type.to_owned(), state_key.to_owned()))
        {
            Some(Some(content)) => Probed::Present(content.clone()),
            Some(None) => Probed::Absent,
            None => Probed::Unknown,
        }
    }

    pub(crate) fn remember_full(
        &mut self,
        room_id: &RoomId,
        events: HashMap<String, Vec<RoomStateEventView>>,
    ) {
        let room = self.rooms.entry(room_id.to_owned()).or_default();
        room.full = Some(events);
        room.keys.clear();
    }

    pub(crate) fn remember_content(
        &mut self,
        room_id: &RoomId,
        event_type: &str,
        state_key: &str,
        content: Option<Value>,
    ) {
        self.rooms
            .entry(room_id.to_owned())
            .or_default()
            .keys
            .insert((event_type.to_owned(), state_key.to_owned()), content);
    }

    pub(crate) fn forget(&mut self, room_id: &RoomId, event_type: &str) {
        if let Some(room) = self.rooms.get_mut(room_id) {
            room.full = None;
            room.keys
                .retain(|(probed_type, _), _| probed_type != event_type);
        }
    }
}

impl crate::Core {
    pub(crate) fn probed_state(&self) -> std::sync::MutexGuard<'_, ProbedState> {
        self.probed_state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

const RECENT_STATE_MS: u64 = 30_000;

pub(crate) type RoomStateSnapshot = Arc<Vec<Raw<AnyStateEvent>>>;

#[derive(Default)]
pub(crate) struct RecentState {
    rooms: HashMap<OwnedRoomId, (u64, RoomStateSnapshot)>,
    fetches: HashMap<OwnedRoomId, Arc<tokio::sync::Mutex<()>>>,
}

impl crate::Core {
    pub(crate) async fn room_state_snapshot(
        &self,
        client: &matrix_sdk::Client,
        room_id: &RoomId,
    ) -> matrix_sdk::Result<RoomStateSnapshot> {
        let fetch = {
            let mut recent = self.recent_state();
            recent.fetches.retain(|_, lock| Arc::strong_count(lock) > 1);
            recent
                .fetches
                .entry(room_id.to_owned())
                .or_default()
                .clone()
        };
        let _fetching = fetch.lock().await;
        let now = now_ms();
        {
            let mut recent = self.recent_state();
            recent
                .rooms
                .retain(|_, (fetched, _)| now.saturating_sub(*fetched) < RECENT_STATE_MS);
            if let Some((_, snapshot)) = recent.rooms.get(room_id) {
                return Ok(snapshot.clone());
            }
        }
        let response = client
            .send(get_state_events::v3::Request::new(room_id.to_owned()))
            .await?;
        let snapshot = Arc::new(response.room_state);
        self.recent_state()
            .rooms
            .insert(room_id.to_owned(), (now_ms(), snapshot.clone()));
        Ok(snapshot)
    }

    pub(crate) fn forget_room_state(&self, room_id: &RoomId, event_type: &str) {
        if event_type != "m.room.member" {
            self.probed_state().forget(room_id, event_type);
        }
        self.recent_state().rooms.remove(room_id);
    }

    pub(crate) fn watch_room_state(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let handle = client.add_event_handler({
            let core = self.clone();
            move |raw: Raw<AnySyncStateEvent>, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    if let Some(event_type) = raw.get_field::<String>("type").ok().flatten() {
                        core.forget_room_state(room.room_id(), &event_type);
                    }
                }
            }
        });
        self.track_session_handler(client, handle);
    }

    fn recent_state(&self) -> std::sync::MutexGuard<'_, RecentState> {
        self.recent_state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn now_ms() -> u64 {
    web_time::SystemTime::now()
        .duration_since(web_time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}
