use matrix_sdk::ruma::{OwnedEventId, OwnedUserId, RoomId, UserId};
use sable_sql::statement;

use super::{Result, Store, text};

impl Store {
    pub(in crate::search) async fn newest_event(
        &self,
        room_id: &RoomId,
    ) -> Result<Option<OwnedEventId>> {
        let rows = self
            .rows(statement!(
                "SELECT event_id FROM doc WHERE room_id = ?1 ORDER BY ts DESC, id DESC LIMIT 1",
                room_id.as_str()
            ))
            .await?;
        Ok(rows
            .first()
            .and_then(|row| OwnedEventId::try_from(text(row, 0)?).ok()))
    }
}

/// Messages of one sender that a ban or kick with `redact_events` removed:
/// those after the sender's previous member event, up to this one.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(in crate::search) struct Removal {
    pub(in crate::search) sender: OwnedUserId,
    pub(in crate::search) after: u64,
    pub(in crate::search) until: u64,
}

impl Removal {
    pub(in crate::search) fn covers(&self, sender: &UserId, ts: u64) -> bool {
        self.sender == sender && ts > self.after && ts <= self.until
    }
}

fn removals_key(room_id: &RoomId) -> String {
    format!("ban-removals:{room_id}")
}

impl Store {
    pub(in crate::search) async fn removals(&self, room_id: &RoomId) -> Result<Vec<Removal>> {
        Ok(self
            .meta(&removals_key(room_id))
            .await?
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default())
    }

    pub(in crate::search) async fn apply_removal(
        &self,
        room_id: &RoomId,
        removal: Removal,
    ) -> Result<()> {
        let mut removals = self.removals(room_id).await?;
        if !removals.contains(&removal) {
            removals.push(removal.clone());
            let json = serde_json::to_vec(&removals)
                .map_err(|error| super::SqlError(error.to_string()))?;
            self.set_meta(&removals_key(room_id), json).await?;
        }
        let (room, sender) = (room_id.as_str(), removal.sender.as_str());
        self.run(vec![
            statement!(
                "DELETE FROM fts WHERE rowid IN
                     (SELECT id FROM doc WHERE room_id = ?1 AND sender = ?2 AND state = 0
                      AND ts > ?3 AND ts <= ?4)",
                room,
                sender,
                removal.after,
                removal.until
            ),
            statement!(
                "DELETE FROM doc WHERE room_id = ?1 AND sender = ?2 AND state = 0
                 AND ts > ?3 AND ts <= ?4",
                room,
                sender,
                removal.after,
                removal.until
            ),
        ])
        .await
        .map(drop)
    }
}

impl Store {
    pub(in crate::search) async fn forget_removals(&self, room_id: &RoomId) -> Result<()> {
        self.remove_meta(&removals_key(room_id)).await
    }
}

/// The newest version of a calendar event the room has seen, by its uid.
#[derive(serde::Serialize, serde::Deserialize)]
struct CalendarVersion {
    event_id: OwnedEventId,
    ts: u64,
}

impl Store {
    /// Records `event_id` as the current version of calendar event `uid` and
    /// returns the version it replaces, or `None` when a newer one is known.
    pub(in crate::search) async fn replace_calendar_version(
        &self,
        room_id: &RoomId,
        uid: &str,
        event_id: &OwnedEventId,
        ts: u64,
    ) -> Result<Option<Option<OwnedEventId>>> {
        let key = format!("calendar:{room_id}:{uid}");
        let known: Option<CalendarVersion> = self
            .meta(&key)
            .await?
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        if known.as_ref().is_some_and(|known| known.ts > ts) {
            return Ok(None);
        }
        let json = serde_json::to_vec(&CalendarVersion {
            event_id: event_id.clone(),
            ts,
        })
        .map_err(|error| super::SqlError(error.to_string()))?;
        self.set_meta(&key, json).await?;
        Ok(Some(
            known
                .map(|known| known.event_id)
                .filter(|known| known != event_id),
        ))
    }
}
