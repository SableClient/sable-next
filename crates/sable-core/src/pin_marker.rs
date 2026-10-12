use std::fmt::Write;

use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::protocol::{CommandErr, PinReadStateView};
use crate::{Core, ResultExt};

/// Which pins this account has seen, per room. Not specced; v1 wrote it too.
const PIN_MARKER_EVENT: &str = "moe.sable.app.pins_read_marker";
const HASH_LENGTH: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PinMarker {
    hash: String,
    count: usize,
    last_seen_id: String,
}

/// Order-independent, so re-pinning the same set reads as nothing new.
pub(crate) fn pins_hash(pinned: &[OwnedEventId]) -> String {
    let mut ids: Vec<&str> = pinned.iter().map(|id| id.as_str()).collect();
    ids.sort_unstable();
    Sha256::digest(ids.join(",").as_bytes())
        .iter()
        .take(HASH_LENGTH / 2)
        .fold(String::with_capacity(HASH_LENGTH), |mut hash, byte| {
            let _ = write!(hash, "{byte:02x}");
            hash
        })
}

pub(crate) fn read_marker(content: Option<&Value>) -> Option<PinMarker> {
    let content = content?;
    Some(PinMarker {
        hash: content.get("hash")?.as_str()?.to_owned(),
        count: content
            .get("count")
            .and_then(Value::as_u64)
            .and_then(|count| usize::try_from(count).ok())
            .unwrap_or_default(),
        last_seen_id: content.get("last_seen_id")?.as_str()?.to_owned(),
    })
}

fn position(pinned: &[OwnedEventId], event_id: &str) -> Option<usize> {
    pinned.iter().position(|id| id.as_str() == event_id)
}

pub(crate) fn unread_pins(pinned: &[OwnedEventId], marker: Option<&PinMarker>) -> usize {
    if pinned.is_empty() {
        return 0;
    }
    let Some(marker) = marker else {
        return pinned.len();
    };
    if marker.hash == pins_hash(pinned) {
        return 0;
    }
    position(pinned, &marker.last_seen_id).map_or_else(
        || pinned.len().saturating_sub(marker.count.saturating_sub(1)),
        |last_seen| pinned.len() - last_seen - 1,
    )
}

pub(crate) fn is_new_pin(
    pinned: &[OwnedEventId],
    marker: Option<&PinMarker>,
    event_id: &str,
) -> bool {
    let Some(marker) = marker else {
        return true;
    };
    let index = position(pinned, event_id);
    position(pinned, &marker.last_seen_id).map_or_else(
        || index.is_some_and(|index| index >= marker.count.saturating_sub(1)),
        |last_seen| index.is_some_and(|index| index > last_seen),
    )
}

fn marker_for(pinned: &[OwnedEventId]) -> Option<PinMarker> {
    Some(PinMarker {
        hash: pins_hash(pinned),
        count: pinned.len(),
        last_seen_id: pinned.last()?.to_string(),
    })
}

fn marker_content(marker: &PinMarker) -> Value {
    json!({
        "hash": marker.hash,
        "count": marker.count,
        "last_seen_id": marker.last_seen_id,
    })
}

fn read_state(pinned: Vec<OwnedEventId>, marker: Option<&PinMarker>) -> PinReadStateView {
    PinReadStateView {
        unread: u32::try_from(unread_pins(&pinned, marker)).unwrap_or(u32::MAX),
        fresh_ids: pinned
            .iter()
            .filter(|id| is_new_pin(&pinned, marker, id.as_str()))
            .cloned()
            .collect(),
        pinned_ids: pinned,
    }
}

impl Core {
    async fn stored_pin_marker(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<Option<PinMarker>, CommandErr> {
        let content = self
            .room(room_id)
            .await?
            .account_data(PIN_MARKER_EVENT.into())
            .await
            .map_err(|error| self.room_error("pin_marker", error))?
            .and_then(|raw| raw.get_field::<Value>("content").ok().flatten());
        Ok(read_marker(content.as_ref()))
    }

    async fn write_pin_marker(
        &self,
        room_id: &OwnedRoomId,
        marker: &PinMarker,
    ) -> Result<(), CommandErr> {
        let raw = matrix_sdk::ruma::serde::Raw::new(&marker_content(marker))
            .or_failed(self, "pin_marker")?
            .cast_unchecked();
        self.room(room_id)
            .await?
            .set_account_data_raw(PIN_MARKER_EVENT.into(), raw)
            .await
            .map_err(|error| self.room_error("pin_marker", error))?;
        Ok(())
    }

    pub(crate) async fn pin_read_state(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<PinReadStateView, CommandErr> {
        let pinned = self.pinned_events(room_id).await?;
        let marker = self.stored_pin_marker(room_id).await?;
        Ok(read_state(pinned, marker.as_ref()))
    }

    pub(crate) async fn mark_pins_seen(
        &self,
        room_id: &OwnedRoomId,
        pinned: Vec<OwnedEventId>,
    ) -> Result<PinReadStateView, CommandErr> {
        let marker = marker_for(&pinned);
        if let Some(marker) = &marker {
            self.write_pin_marker(room_id, marker).await?;
        }
        Ok(read_state(pinned, marker.as_ref()))
    }

    /// A reader who had seen every pin has also seen the one they add; the
    /// marker is put back if the pin itself fails.
    pub(crate) async fn set_pinned_with_marker(
        &self,
        room_id: &OwnedRoomId,
        event_id: OwnedEventId,
        pinned: bool,
    ) -> Result<Vec<OwnedEventId>, CommandErr> {
        let previous_marker = if pinned {
            self.advance_marker_for_own_pin(room_id, &event_id).await
        } else {
            None
        };
        match self.set_pinned(room_id, event_id, pinned).await {
            Ok(events) => Ok(events),
            Err(error) => {
                if let Some(Some(previous)) = previous_marker
                    && let Err(restore) = self.write_pin_marker(room_id, &previous).await
                {
                    tracing::debug!(?restore, "pin marker not restored");
                }
                Err(error)
            }
        }
    }

    /// `Some(stored)` when the marker was advanced, holding what it was before.
    async fn advance_marker_for_own_pin(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
    ) -> Option<Option<PinMarker>> {
        let result: Result<Option<Option<PinMarker>>, CommandErr> = async {
            let mut previous = self.pinned_events(room_id).await?;
            let stored = self.stored_pin_marker(room_id).await?;
            let caught_up = previous.is_empty() || unread_pins(&previous, stored.as_ref()) == 0;
            if !caught_up {
                return Ok(None);
            }
            previous.push(event_id.clone());
            if let Some(next) = marker_for(&previous) {
                self.write_pin_marker(room_id, &next).await?;
            }
            Ok(Some(stored))
        }
        .await;
        result.unwrap_or_else(|error| {
            tracing::debug!(?error, "pin marker not stored");
            None
        })
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::OwnedEventId;
    use serde_json::json;

    use super::{PinMarker, is_new_pin, pins_hash, read_marker, unread_pins};

    fn ids(names: &[&str]) -> Vec<OwnedEventId> {
        names
            .iter()
            .map(|name| OwnedEventId::try_from(format!("${name}")).expect("event id"))
            .collect()
    }

    fn marker(pinned: &[OwnedEventId], count: usize, last: &str) -> PinMarker {
        PinMarker {
            hash: pins_hash(pinned),
            count,
            last_seen_id: format!("${last}"),
        }
    }

    #[test]
    fn the_hash_ignores_order_and_is_ten_hex_digits() {
        let hash = pins_hash(&ids(&["a", "b"]));
        assert_eq!(hash, pins_hash(&ids(&["b", "a"])));
        assert_eq!(hash.len(), 10);
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn unread_counts_the_pins_after_the_last_seen_one() {
        let pinned = ids(&["a", "b", "c"]);
        assert_eq!(unread_pins(&pinned, None), 3);
        assert_eq!(unread_pins(&[], None), 0);
        assert_eq!(unread_pins(&pinned, Some(&marker(&pinned, 3, "c"))), 0);

        let seen = marker(&ids(&["a"]), 1, "a");
        assert_eq!(unread_pins(&pinned, Some(&seen)), 2);
        assert!(!is_new_pin(&pinned, Some(&seen), "$a"));
        assert!(is_new_pin(&pinned, Some(&seen), "$c"));
    }

    #[test]
    fn a_vanished_last_seen_pin_falls_back_to_the_count() {
        let pinned = ids(&["x", "y", "z"]);
        let gone = marker(&ids(&["old"]), 2, "old");
        assert_eq!(unread_pins(&pinned, Some(&gone)), 2);
        assert!(!is_new_pin(&pinned, Some(&gone), "$x"));
        assert!(is_new_pin(&pinned, Some(&gone), "$y"));
    }

    #[test]
    fn a_marker_needs_a_hash_and_a_last_seen_id() {
        assert_eq!(
            read_marker(Some(&json!({ "hash": "h", "last_seen_id": "$a" }))),
            Some(PinMarker {
                hash: "h".to_owned(),
                count: 0,
                last_seen_id: "$a".to_owned(),
            })
        );
        assert_eq!(read_marker(Some(&json!({ "hash": "h" }))), None);
        assert_eq!(read_marker(None), None);
    }
}
