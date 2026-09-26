//! Calendar rooms in Commet's format (`chat.commet.calendar`), plus RSVPs.

use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, UInt};
use serde_json::{Value, json};

use crate::Core;
use crate::protocol::{CalendarEntryView, CalendarRsvpView, CalendarView, CommandErr};

pub(crate) const CALENDAR_ROOM_TYPE: &str = "chat.commet.calendar";
pub(crate) const RSVP_EVENT: &str = "moe.sable.calendar.rsvp";
const CALENDAR_EVENTS: &str = "chat.commet.calendar_events";
const CALENDAR_CREATE: &str = "chat.commet.calendar_create";
const CALENDARS: &str = "chat.commet.calendars";
const EVENT_FORMAT: &str = "chat.commet.calendar.event.rfc8984";
const RSVP_STATUSES: [&str; 3] = ["accepted", "tentative", "declined"];
const PAGE_SIZE: u32 = 100;
const MAX_PAGES: usize = 100;

impl Core {
    pub(crate) async fn calendar_entries(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<CalendarView, CommandErr> {
        let room = self.room(room_id).await?;
        let mut entries = Vec::new();
        let mut rsvps = Vec::new();
        let mut from: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut options = MessagesOptions::backward().from(from.as_deref());
            options.limit = UInt::from(PAGE_SIZE);
            let messages = room
                .messages(options)
                .await
                .map_err(|error| self.room_error("calendar_entries", error))?;
            for event in &messages.chunk {
                if let Ok(event) = event.raw().deserialize_as::<Value>() {
                    collect(&event, &mut entries, &mut rsvps);
                }
            }
            match messages.end {
                Some(end) if !messages.chunk.is_empty() => from = Some(end),
                _ => break,
            }
        }
        Ok(CalendarView {
            entries: latest_entries(entries),
            rsvps,
        })
    }

    pub(crate) async fn save_calendar_event(
        &self,
        room_id: &OwnedRoomId,
        event: Value,
        replaces: Option<OwnedEventId>,
    ) -> Result<(), CommandErr> {
        let room = self.room(room_id).await?;
        let existing = self
            .room_state_event_content(room_id.clone(), CALENDARS.to_owned(), String::new())
            .await?
            .as_ref()
            .and_then(|content| content.get("calendars"))
            .and_then(Value::as_array)
            .and_then(|calendars| calendars.first())
            .and_then(Value::as_str)
            .map(str::to_owned);
        let calendar_id = if let Some(calendar_id) = existing {
            calendar_id
        } else {
            let created = room
                .send_raw(CALENDAR_CREATE, json!({}))
                .await
                .map_err(|error| self.room_error("save_calendar_event", error))?;
            room.send_state_event_raw(
                CALENDARS,
                "",
                json!({ "calendars": [created.response.event_id] }),
            )
            .await
            .map_err(|error| self.room_error("save_calendar_event", error))?;
            created.response.event_id.to_string()
        };
        room.send_raw(
            CALENDAR_EVENTS,
            json!({
                "m.relates_to": { "event_id": calendar_id, "rel_type": "m.reference" },
                "format": EVENT_FORMAT,
                "events": [{ "event": event }],
            }),
        )
        .await
        .map_err(|error| self.room_error("save_calendar_event", error))?;
        if let Some(replaces) = replaces {
            room.redact(&replaces, None, None)
                .await
                .map_err(|error| self.room_error("save_calendar_event", error.into()))?;
        }
        Ok(())
    }
}

fn collect(event: &Value, entries: &mut Vec<CalendarEntryView>, rsvps: &mut Vec<CalendarRsvpView>) {
    let text = |key: &str| event.get(key).and_then(Value::as_str).map(str::to_owned);
    let (Some(kind), Some(event_id), Some(sender)) =
        (text("type"), text("event_id"), text("sender"))
    else {
        return;
    };
    let timestamp = event
        .get("origin_server_ts")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let Some(content) = event.get("content") else {
        return;
    };
    match kind.as_str() {
        CALENDAR_EVENTS => {
            for item in content
                .get("events")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let Some(body) = item.get("event").filter(|body| {
                    body.get("uid").and_then(Value::as_str).is_some()
                        && body.get("start").and_then(Value::as_str).is_some()
                }) else {
                    continue;
                };
                entries.push(CalendarEntryView {
                    event_id: event_id.clone(),
                    sender: sender.clone(),
                    timestamp,
                    event: body.clone(),
                });
            }
        }
        RSVP_EVENT => {
            let status = content.get("status").and_then(Value::as_str);
            let uid = content.get("uid").and_then(Value::as_str);
            let target = content
                .get("m.relates_to")
                .and_then(|relation| relation.get("event_id"))
                .and_then(Value::as_str);
            if let (Some(status), Some(uid), Some(target)) = (status, uid, target)
                && RSVP_STATUSES.contains(&status)
            {
                rsvps.push(CalendarRsvpView {
                    sender,
                    calendar_event_id: target.to_owned(),
                    uid: uid.to_owned(),
                    status: status.to_owned(),
                    timestamp,
                });
            }
        }
        _ => {}
    }
}

fn latest_entries(mut entries: Vec<CalendarEntryView>) -> Vec<CalendarEntryView> {
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.timestamp));
    let mut seen = std::collections::HashSet::new();
    entries.retain(|entry| {
        entry
            .event
            .get("uid")
            .and_then(Value::as_str)
            .is_some_and(|uid| seen.insert(uid.to_owned()))
    });
    entries
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{collect, latest_entries};

    #[test]
    fn reads_commet_events_and_rsvps_and_keeps_the_latest_edit() {
        let mut entries = Vec::new();
        let mut rsvps = Vec::new();
        let calendar = |event_id: &str, ts: u64, title: &str| {
            json!({
                "type": "chat.commet.calendar_events", "event_id": event_id,
                "sender": "@ana:example.org", "origin_server_ts": ts,
                "content": {
                    "format": "chat.commet.calendar.event.rfc8984",
                    "events": [{ "event": {
                        "@type": "Event", "uid": "raid", "title": title,
                        "start": "2026-10-01T20:00:00", "duration": "PT2H"
                    }}]
                }
            })
        };
        collect(&calendar("$old", 1, "Raid"), &mut entries, &mut rsvps);
        collect(&calendar("$new", 2, "Raid night"), &mut entries, &mut rsvps);
        collect(
            &json!({
                "type": "chat.commet.calendar_events", "event_id": "$redacted",
                "sender": "@ana:example.org", "origin_server_ts": 3, "content": {}
            }),
            &mut entries,
            &mut rsvps,
        );
        collect(
            &json!({
                "type": "moe.sable.calendar.rsvp", "event_id": "$rsvp",
                "sender": "@bob:example.org", "origin_server_ts": 4,
                "content": {
                    "uid": "raid", "status": "tentative",
                    "m.relates_to": { "rel_type": "m.reference", "event_id": "$new" }
                }
            }),
            &mut entries,
            &mut rsvps,
        );
        collect(
            &json!({
                "type": "moe.sable.calendar.rsvp", "event_id": "$bad",
                "sender": "@bob:example.org", "origin_server_ts": 5,
                "content": { "uid": "raid", "status": "maybe", "m.relates_to": { "event_id": "$new" } }
            }),
            &mut entries,
            &mut rsvps,
        );

        let entries = latest_entries(entries);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].event_id, "$new");
        assert_eq!(entries[0].event["title"], "Raid night");
        assert_eq!(rsvps.len(), 1);
        assert_eq!(rsvps[0].status, "tentative");
        assert_eq!(rsvps[0].calendar_event_id, "$new");
    }
}
