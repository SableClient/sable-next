//! Calendar rooms in Commet's format (`chat.commet.calendar`), plus RSVPs.

use std::collections::HashSet;
use std::sync::Arc;

use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::room::RoomType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, UInt};
use serde_json::{Value, json};

use crate::Core;
use crate::protocol::{CalendarEntryView, CalendarRsvpView, CalendarView, CommandErr, CoreEvent};

pub(crate) const CALENDAR_ROOM_TYPE: &str = "chat.commet.calendar";
pub(crate) const RSVP_EVENT: &str = "moe.sable.calendar.rsvp";
const CALENDAR_EVENTS: &str = "chat.commet.calendar_events";
const CALENDAR_CREATE: &str = "chat.commet.calendar_create";
const CALENDARS: &str = "chat.commet.calendars";
const EVENT_FORMAT: &str = "chat.commet.calendar.event.rfc8984";
const RSVP_STATUSES: [&str; 3] = ["accepted", "tentative", "declined"];
const PAGE_SIZE: u32 = 100;
const MAX_PAGES: usize = 100;
const REDACTION: &str = "m.room.redaction";
const ENCRYPTED: &str = "m.room.encrypted";

#[derive(Debug, Clone, Default)]
pub(crate) struct RoomCalendar {
    newest: Option<String>,
    entries: Vec<CalendarEntryView>,
    rsvps: Vec<(String, CalendarRsvpView)>,
}

impl RoomCalendar {
    fn view(&self) -> CalendarView {
        CalendarView {
            entries: latest_entries(self.entries.clone()),
            rsvps: self.rsvps.iter().map(|(_, rsvp)| rsvp.clone()).collect(),
        }
    }
}

impl Core {
    pub(crate) async fn calendar_entries(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<CalendarView, CommandErr> {
        let room = self.room(room_id).await?;
        let cached = self
            .calendars
            .lock()
            .await
            .get(room_id)
            .cloned()
            .unwrap_or_default();
        let mut fresh = RoomCalendar::default();
        let mut redacted = HashSet::new();
        let mut anchored = false;
        let mut from: Option<String> = None;
        'pages: for _ in 0..MAX_PAGES {
            let mut options = MessagesOptions::backward().from(from.as_deref());
            options.limit = UInt::from(PAGE_SIZE);
            let messages = room
                .messages(options)
                .await
                .map_err(|error| self.room_error("calendar_entries", error))?;
            for event in &messages.chunk {
                let Ok(event) = event.raw().deserialize_as::<Value>() else {
                    continue;
                };
                let event_id = event.get("event_id").and_then(Value::as_str);
                if event_id.is_some() && event_id == cached.newest.as_deref() {
                    anchored = true;
                    break 'pages;
                }
                if fresh.newest.is_none() {
                    fresh.newest = event_id.map(str::to_owned);
                }
                if let Some(target) = redacts(&event) {
                    redacted.insert(target.to_owned());
                }
                collect(&event, &mut fresh.entries, &mut fresh.rsvps);
            }
            match messages.end {
                Some(end) if !messages.chunk.is_empty() => from = Some(end),
                _ => break,
            }
        }
        if anchored {
            fresh.newest = fresh.newest.or(cached.newest);
            fresh.entries.extend(cached.entries);
            fresh.rsvps.extend(cached.rsvps);
        }
        fresh
            .entries
            .retain(|entry| !redacted.contains(&entry.event_id));
        fresh
            .rsvps
            .retain(|(event_id, _)| !redacted.contains(event_id));
        let view = fresh.view();
        self.calendars.lock().await.insert(room_id.clone(), fresh);
        Ok(view)
    }

    pub(crate) fn watch_calendars(self: &Arc<Self>, client: &matrix_sdk::Client, generation: u64) {
        let handle = client.add_event_handler({
            let core = self.clone();
            move |event: Raw<AnySyncTimelineEvent>, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    if room.room_type() != Some(RoomType::from(CALENDAR_ROOM_TYPE)) {
                        return;
                    }
                    let kind = event.get_field::<String>("type").ok().flatten();
                    if matches!(
                        kind.as_deref(),
                        Some(CALENDAR_EVENTS | RSVP_EVENT | REDACTION | ENCRYPTED)
                    ) {
                        core.emit_if_current(
                            generation,
                            CoreEvent::CalendarChanged {
                                room_id: room.room_id().to_owned(),
                            },
                        );
                    }
                }
            }
        });
        self.track_session_handler(client, handle);
    }

    pub(crate) async fn save_calendar_event(
        &self,
        room_id: &OwnedRoomId,
        event: Value,
        replaces: Option<OwnedEventId>,
    ) -> Result<(), CommandErr> {
        let room = self.room(room_id).await?;
        let calendar_id = self.calendar_id(&room).await?;
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

    pub(crate) async fn calendar_id(&self, room: &matrix_sdk::Room) -> Result<String, CommandErr> {
        let existing = self
            .room_state_event_content(
                room.room_id().to_owned(),
                CALENDARS.to_owned(),
                String::new(),
            )
            .await?
            .as_ref()
            .and_then(|content| content.get("calendars"))
            .and_then(Value::as_array)
            .and_then(|calendars| calendars.first())
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(calendar_id) = existing {
            return Ok(calendar_id);
        }
        let created = room
            .send_raw(CALENDAR_CREATE, json!({}))
            .await
            .map_err(|error| self.room_error("calendar_id", error))?;
        room.send_state_event_raw(
            CALENDARS,
            "",
            json!({ "calendars": [created.response.event_id] }),
        )
        .await
        .map_err(|error| self.room_error("calendar_id", error))?;
        self.forget_room_state(room.room_id(), CALENDARS);
        Ok(created.response.event_id.to_string())
    }
}

fn redacts(event: &Value) -> Option<&str> {
    if event.get("type").and_then(Value::as_str) != Some(REDACTION) {
        return None;
    }
    event
        .get("content")
        .and_then(|content| content.get("redacts"))
        .or_else(|| event.get("redacts"))
        .and_then(Value::as_str)
}

fn collect(
    event: &Value,
    entries: &mut Vec<CalendarEntryView>,
    rsvps: &mut Vec<(String, CalendarRsvpView)>,
) {
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
                rsvps.push((
                    event_id,
                    CalendarRsvpView {
                        sender,
                        calendar_event_id: target.to_owned(),
                        uid: uid.to_owned(),
                        recurrence_id: content
                            .get("recurrenceId")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        status: status.to_owned(),
                        timestamp,
                    },
                ));
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
                    "uid": "raid", "status": "tentative", "recurrenceId": "2026-10-08T20:00:00",
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
        assert_eq!(rsvps[0].1.status, "tentative");
        assert_eq!(rsvps[0].1.calendar_event_id, "$new");
        assert_eq!(
            rsvps[0].1.recurrence_id.as_deref(),
            Some("2026-10-08T20:00:00")
        );
    }
}
