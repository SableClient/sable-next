//! Calendar rooms in Commet's format (`chat.commet.calendar`), plus RSVPs.

use std::collections::HashSet;
use std::sync::Arc;

use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::events::relation::Reference;
use matrix_sdk::ruma::room::RoomType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, UInt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::value::to_raw_value;
use serde_with::{DefaultOnError, VecSkipError, serde_as};

use crate::protocol::{
    CalendarEntryView, CalendarRsvpView, CalendarView, CoreEvent, RpcError, RsvpStatusView,
};
use crate::room_settings::EmptyContent;
use crate::{Core, ResultExt};

pub(crate) use sable_protocol::CALENDAR_ROOM_TYPE;
pub(crate) const RSVP_EVENT: &str = "moe.sable.calendar.rsvp";
const CALENDAR_EVENTS: &str = "chat.commet.calendar_events";
const CALENDAR_CREATE: &str = "chat.commet.calendar_create";
const CALENDARS: &str = "chat.commet.calendars";
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

pub(crate) struct CalendarAnswer {
    pub(crate) calendar_event_id: OwnedEventId,
    pub(crate) uid: String,
    pub(crate) recurrence_id: Option<String>,
    pub(crate) status: RsvpStatusView,
}

#[derive(Serialize)]
struct RsvpOut {
    uid: String,
    status: RsvpStatusView,
    #[serde(rename = "m.relates_to")]
    relates_to: Reference,
    #[serde(rename = "recurrenceId", skip_serializing_if = "Option::is_none")]
    recurrence_id: Option<String>,
}

/// One answer per occurrence, related to the event that carries the entry.
fn rsvp_content(answer: &CalendarAnswer) -> RsvpOut {
    RsvpOut {
        uid: answer.uid.clone(),
        status: answer.status,
        relates_to: Reference::new(answer.calendar_event_id.clone()),
        recurrence_id: answer.recurrence_id.clone(),
    }
}

#[derive(Serialize)]
enum CalendarFormat {
    #[serde(rename = "chat.commet.calendar.event.rfc8984")]
    Rfc8984,
}

#[derive(Serialize)]
struct CalendarEventsOut {
    #[serde(rename = "m.relates_to")]
    relates_to: CalendarRefOut,
    format: CalendarFormat,
    events: [CalendarItemOut; 1],
}

#[derive(Serialize)]
#[serde(tag = "rel_type")]
enum CalendarRefOut {
    #[serde(rename = "m.reference")]
    Reference { event_id: String },
}

#[derive(Serialize)]
struct CalendarItemOut {
    event: Value,
}

#[derive(Serialize)]
struct CalendarsOut {
    calendars: [OwnedEventId; 1],
}

impl Core {
    pub(crate) async fn calendar_entries(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<CalendarView, RpcError> {
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
                let Ok(header) = EventIn::deserialize(&event) else {
                    continue;
                };
                let event_id = header.event_id.as_deref();
                if event_id.is_some() && event_id == cached.newest.as_deref() {
                    anchored = true;
                    break 'pages;
                }
                if fresh.newest.is_none() {
                    fresh.newest = event_id.map(str::to_owned);
                }
                if let Some(target) = header.redacts() {
                    redacted.insert(target);
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
    ) -> Result<(), RpcError> {
        let room = self.room(room_id).await?;
        let calendar_id = self.calendar_id(&room).await?;
        let content = to_raw_value(&CalendarEventsOut {
            relates_to: CalendarRefOut::Reference {
                event_id: calendar_id,
            },
            format: CalendarFormat::Rfc8984,
            events: [CalendarItemOut { event }],
        })
        .or_failed(self, "save_calendar_event")?;
        room.send_raw(CALENDAR_EVENTS, content)
            .await
            .map_err(|error| self.room_error("save_calendar_event", error))?;
        if let Some(replaces) = replaces {
            room.redact(&replaces, None, None)
                .await
                .map_err(|error| self.room_error("save_calendar_event", error.into()))?;
        }
        Ok(())
    }

    pub(crate) async fn answer_calendar_event(
        &self,
        room_id: &OwnedRoomId,
        answer: &CalendarAnswer,
    ) -> Result<(), RpcError> {
        let content =
            to_raw_value(&rsvp_content(answer)).or_failed(self, "answer_calendar_event")?;
        self.room(room_id)
            .await?
            .send_raw(RSVP_EVENT, content)
            .await
            .map_err(|error| self.room_error("answer_calendar_event", error))?;
        Ok(())
    }

    pub(crate) async fn calendar_id(&self, room: &matrix_sdk::Room) -> Result<String, RpcError> {
        let existing = self
            .room_state_event_content(
                room.room_id().to_owned(),
                CALENDARS.to_owned(),
                String::new(),
            )
            .await?
            .as_ref()
            .and_then(|content| CalendarsIn::deserialize(content).ok())
            .and_then(|content| content.calendars?.into_iter().next()?.0);
        if let Some(calendar_id) = existing {
            return Ok(calendar_id);
        }
        let empty = to_raw_value(&EmptyContent {}).or_failed(self, "calendar_id")?;
        let created = room
            .send_raw(CALENDAR_CREATE, empty)
            .await
            .map_err(|error| self.room_error("calendar_id", error))?;
        let calendars = to_raw_value(&CalendarsOut {
            calendars: [created.response.event_id.clone()],
        })
        .or_failed(self, "calendar_id")?;
        room.send_state_event_raw(CALENDARS, "", calendars)
            .await
            .map_err(|error| self.room_error("calendar_id", error))?;
        self.forget_room_state(room.room_id(), CALENDARS);
        Ok(created.response.event_id.to_string())
    }
}

#[serde_as]
#[derive(Deserialize)]
struct EventIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    event_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    sender: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    origin_server_ts: Option<u64>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    content: Option<ContentIn>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    redacts: Option<String>,
}

#[serde_as]
#[derive(Deserialize)]
struct ContentIn {
    #[serde(default, deserialize_with = "sable_model::field::present")]
    redacts: Option<RedactsField>,
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    events: Vec<ItemIn>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    status: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    uid: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "m.relates_to")]
    relates_to: Option<RelationIn>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "recurrenceId")]
    recurrence_id: Option<String>,
}

#[derive(Deserialize)]
struct ItemIn {
    event: Option<Value>,
}

#[serde_as]
#[derive(Deserialize)]
struct RelationIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    event_id: Option<String>,
}

#[serde_as]
#[derive(Deserialize)]
struct EntryKeys {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    uid: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    start: Option<String>,
}

#[serde_as]
#[derive(Deserialize)]
struct CalendarsIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    calendars: Option<Vec<FirstId>>,
}

#[serde_as]
#[derive(Deserialize)]
struct FirstId(#[serde_as(deserialize_as = "DefaultOnError")] Option<String>);

/// Present even when wrong-typed, so the top-level `redacts` only applies to a missing one.
#[serde_as]
#[derive(Deserialize)]
struct RedactsField(#[serde_as(deserialize_as = "DefaultOnError")] Option<String>);

impl EventIn {
    fn redacts(self) -> Option<String> {
        if self.kind.as_deref() != Some(REDACTION) {
            return None;
        }
        self.content
            .and_then(|content| content.redacts)
            .map_or(self.redacts, |redacts| redacts.0)
    }
}

fn collect(
    event: &Value,
    entries: &mut Vec<CalendarEntryView>,
    rsvps: &mut Vec<(String, CalendarRsvpView)>,
) {
    let Ok(event) = EventIn::deserialize(event) else {
        return;
    };
    let (Some(kind), Some(event_id), Some(sender)) = (event.kind, event.event_id, event.sender)
    else {
        return;
    };
    let timestamp = event.origin_server_ts.unwrap_or_default();
    let Some(content) = event.content else {
        return;
    };
    match kind.as_str() {
        CALENDAR_EVENTS => {
            for body in content.events.into_iter().filter_map(|item| item.event) {
                let keys = EntryKeys::deserialize(&body).ok();
                if !keys.is_some_and(|keys| keys.uid.is_some() && keys.start.is_some()) {
                    continue;
                }
                entries.push(CalendarEntryView {
                    event_id: event_id.clone(),
                    sender: sender.clone(),
                    timestamp,
                    event: body,
                });
            }
        }
        RSVP_EVENT => {
            let target = content.relates_to.and_then(|relation| relation.event_id);
            if let (Some(status), Some(uid), Some(target)) = (content.status, content.uid, target)
                && RSVP_STATUSES.contains(&status.as_str())
            {
                rsvps.push((
                    event_id,
                    CalendarRsvpView {
                        sender,
                        calendar_event_id: target,
                        uid,
                        recurrence_id: content.recurrence_id,
                        status,
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
        EntryKeys::deserialize(&entry.event)
            .ok()
            .and_then(|keys| keys.uid)
            .is_some_and(|uid| seen.insert(uid))
    });
    entries
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use matrix_sdk::ruma::OwnedEventId;

    use super::{CalendarAnswer, RsvpStatusView, collect, latest_entries, rsvp_content};

    #[test]
    fn rsvp_content_relates_by_reference_and_omits_an_absent_recurrence_id() {
        let mut answer = CalendarAnswer {
            calendar_event_id: OwnedEventId::try_from("$new").expect("event id"),
            uid: "raid".to_owned(),
            recurrence_id: None,
            status: RsvpStatusView::Tentative,
        };
        assert_eq!(
            serde_json::to_value(rsvp_content(&answer)).unwrap(),
            json!({
                "uid": "raid", "status": "tentative",
                "m.relates_to": { "rel_type": "m.reference", "event_id": "$new" }
            })
        );
        answer.recurrence_id = Some("2026-10-08T20:00:00".to_owned());
        assert_eq!(
            serde_json::to_value(rsvp_content(&answer)).unwrap()["recurrenceId"],
            "2026-10-08T20:00:00"
        );
    }

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

    #[test]
    fn redactions_read_the_target_from_content_before_the_top_level() {
        let target = |event: serde_json::Value| {
            super::EventIn::deserialize(&event)
                .expect("event")
                .redacts()
        };
        let redaction = |extra: serde_json::Value| {
            let mut event = json!({ "type": "m.room.redaction", "redacts": "$top" });
            for (key, value) in extra.as_object().expect("object") {
                event[key] = value.clone();
            }
            event
        };
        assert_eq!(target(redaction(json!({}))), Some("$top".to_owned()));
        assert_eq!(
            target(redaction(json!({ "content": { "redacts": "$inner" } }))),
            Some("$inner".to_owned())
        );
        assert_eq!(
            target(redaction(json!({ "content": { "redacts": 3 } }))),
            None
        );
        assert_eq!(
            target(redaction(json!({ "content": "x" }))),
            Some("$top".to_owned())
        );
        assert_eq!(
            target(json!({ "type": "m.room.message", "redacts": "$top" })),
            None
        );
    }

    #[test]
    fn wrong_typed_calendar_content_is_skipped() {
        let mut entries = Vec::new();
        let mut rsvps = Vec::new();
        let event = |content: serde_json::Value| {
            json!({
                "type": "chat.commet.calendar_events", "event_id": "$e",
                "sender": "@ana:example.org", "origin_server_ts": 1, "content": content
            })
        };
        for content in [
            json!("x"),
            json!({ "events": "x" }),
            json!({ "events": [null, "x", { "event": null }, { "event": { "uid": 1, "start": "s" } }] }),
        ] {
            collect(&event(content), &mut entries, &mut rsvps);
        }
        assert!(entries.is_empty());
        assert_eq!(
            super::CalendarsIn::deserialize(&json!({ "calendars": ["$a", "$b"] }))
                .expect("calendars")
                .calendars
                .and_then(|calendars| calendars.into_iter().next()?.0),
            Some("$a".to_owned())
        );
        assert!(
            super::CalendarsIn::deserialize(&json!({ "calendars": [3, "$b"] }))
                .expect("calendars")
                .calendars
                .and_then(|calendars| calendars.into_iter().next()?.0)
                .is_none()
        );
    }
}
