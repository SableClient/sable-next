use std::time::Duration;

use matrix_sdk::ruma::api::FeatureFlag;
use matrix_sdk::ruma::api::client::delayed_events::{
    DelayParameters, delayed_message_event, get_all_delayed_events, update_delayed_event,
};
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::{OwnedRoomId, TransactionId};

use crate::Core;
use crate::protocol::{CommandErr, ScheduledMessageView};

const MSC4140: &str = "org.matrix.msc4140";

impl Core {
    pub(crate) async fn delayed_events_supported(&self) -> Result<bool, CommandErr> {
        let client = self.client().await?;
        let features = client
            .unstable_features()
            .await
            .map_err(|error| self.failed("delayed_events_supported", error))?;
        Ok(features.contains(&FeatureFlag::from(MSC4140)))
    }

    pub(crate) async fn schedule_message(
        &self,
        room_id: &OwnedRoomId,
        content: RoomMessageEventContent,
        delay_ms: u64,
    ) -> Result<String, CommandErr> {
        if !self.delayed_events_supported().await? {
            return Err(CommandErr::DelayedEventsUnsupported);
        }
        let room = self.room(room_id).await?;
        if self.room_is_encrypted(&room).await? {
            return Err(CommandErr::EncryptedScheduleUnsupported);
        }

        let request = delayed_message_event::unstable::Request::new(
            room_id.clone(),
            TransactionId::new(),
            DelayParameters::Timeout {
                timeout: Duration::from_millis(delay_ms),
            },
            &AnyMessageLikeEventContent::RoomMessage(content),
        )
        .map_err(|error| self.failed("schedule_message", error))?;

        let response = self
            .client()
            .await?
            .send(request)
            .await
            .map_err(|error| self.failed("schedule_message", error))?;
        Ok(response.delay_id)
    }

    pub(crate) async fn cancel_scheduled_message(
        &self,
        delay_id: String,
    ) -> Result<(), CommandErr> {
        let request = update_delayed_event::unstable_v1::Request::new(
            delay_id,
            update_delayed_event::UpdateAction::Cancel,
        );
        self.client()
            .await?
            .send(request)
            .await
            .map_err(|error| self.failed("cancel_scheduled_message", error))?;
        Ok(())
    }

    pub(crate) async fn send_scheduled_message_now(
        &self,
        delay_id: String,
    ) -> Result<(), CommandErr> {
        let request = update_delayed_event::unstable_v1::Request::new(
            delay_id,
            update_delayed_event::UpdateAction::Send,
        );
        self.client()
            .await?
            .send(request)
            .await
            .map_err(|error| self.failed("send_scheduled_message", error))?;
        Ok(())
    }

    pub(crate) async fn scheduled_messages(
        &self,
        room_id: Option<&OwnedRoomId>,
    ) -> Result<Vec<ScheduledMessageView>, CommandErr> {
        if !self.delayed_events_supported().await? {
            return Ok(Vec::new());
        }
        let client = self.client().await?;
        let response = client
            .send(get_all_delayed_events::unstable::Request::new())
            .await
            .map_err(|error| self.homeserver_http_error("scheduled_messages", error))?;

        Ok(response
            .delayed_events
            .into_iter()
            .filter(|item| {
                item.event_type == matrix_sdk::ruma::events::TimelineEventType::RoomMessage
            })
            .filter(|item| item.finalized_ts.is_none())
            .filter(|item| room_id.is_none_or(|wanted| &item.room_id == wanted))
            .filter_map(|item| {
                let content = item
                    .content
                    .deserialize_as_unchecked::<RoomMessageEventContent>()
                    .ok()?;
                let delay_ms = u64::try_from(item.delay.as_millis()).unwrap_or(u64::MAX);
                let formatted = match &content.msgtype {
                    matrix_sdk::ruma::events::room::message::MessageType::Text(text) => text
                        .formatted
                        .as_ref()
                        .map(|formatted| formatted.body.clone()),
                    matrix_sdk::ruma::events::room::message::MessageType::Notice(notice) => notice
                        .formatted
                        .as_ref()
                        .map(|formatted| formatted.body.clone()),
                    matrix_sdk::ruma::events::room::message::MessageType::Emote(emote) => emote
                        .formatted
                        .as_ref()
                        .map(|formatted| formatted.body.clone()),
                    _ => None,
                };
                Some(ScheduledMessageView {
                    delivery_ts: Some(u64::from(item.running_since.get()).saturating_add(delay_ms)),
                    body: content.body().to_owned(),
                    formatted,
                    delay_id: item.delay_id,
                    room_id: item.room_id,
                    delay_ms,
                })
            })
            .collect())
    }
}
