
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};
use serde::Deserialize;

use super::SessionHandler;
use crate::SignedIn;
use crate::calendar::CalendarAnswer;
use crate::protocol::{CalendarView, RpcError, RsvpStatusView};

domain! {
    entries,
    save_event,
    answer_event,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EntriesParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for EntriesParams {
    type Ok = CalendarView;

    async fn run(self, session: &SignedIn) -> Result<CalendarView, RpcError> {
        session.calendar_entries(&self.room_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SaveEventParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub event: serde_json::Value,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    #[serde(default)]
    pub replaces: Option<OwnedEventId>,
}

impl SessionHandler for SaveEventParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.save_calendar_event(&self.room_id, self.event, self.replaces)
            .await
    }
}

/// `recurrence_id` picks one occurrence of a repeating event.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AnswerEventParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub calendar_event_id: OwnedEventId,
    pub uid: String,
    #[serde(default)]
    pub recurrence_id: Option<String>,
    pub status: RsvpStatusView,
}

impl SessionHandler for AnswerEventParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let answer = CalendarAnswer {
            calendar_event_id: self.calendar_event_id,
            uid: self.uid,
            recurrence_id: self.recurrence_id,
            status: self.status,
        };
        session.answer_calendar_event(&self.room_id, &answer).await
    }
}
