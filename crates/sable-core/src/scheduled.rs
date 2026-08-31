use std::time::Duration;

use matrix_sdk::ruma::api::FeatureFlag;
use matrix_sdk::ruma::api::client::delayed_events::{
    DelayParameters, delayed_message_event, update_delayed_event,
};
use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::{OwnedRoomId, TransactionId};
use serde::Deserialize;

use crate::Core;
use crate::protocol::{CommandErr, ScheduledMessageView};

const MSC4140: &str = "org.matrix.msc4140";

#[derive(Debug, Deserialize)]
struct DelayedEventsResponse {
    #[serde(default)]
    delayed_events: Vec<DelayedEventItem>,
}

#[derive(Debug, Deserialize)]
struct DelayedEventItem {
    delay_id: String,
    room_id: OwnedRoomId,
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    delay: u64,
    #[serde(default)]
    running_since: Option<u64>,
    #[serde(default)]
    content: serde_json::Value,
}

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
        if room
            .latest_encryption_state()
            .await
            .is_ok_and(|state| state.is_encrypted())
        {
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
        let endpoint = client
            .homeserver()
            .join(&format!(
                "/_matrix/client/unstable/{MSC4140}/delayed_events"
            ))
            .map_err(|error| self.failed("scheduled_messages", error))?;
        let token = client
            .access_token()
            .ok_or_else(|| self.failed("scheduled_messages", "no access token"))?;

        let http = crate::tls::apply(matrix_sdk::reqwest::Client::builder())
            .build()
            .map_err(|error| self.failed("scheduled_messages", error))?;

        let response = http
            .get(endpoint)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| self.failed("scheduled_messages", error))?;
        if !response.status().is_success() {
            return Err(self.failed(
                "scheduled_messages",
                format!("delayed events refused with {}", response.status()),
            ));
        }

        let body = response
            .text()
            .await
            .map_err(|error| self.failed("scheduled_messages", error))?;
        let parsed: DelayedEventsResponse = serde_json::from_str(&body)
            .map_err(|error| self.failed("scheduled_messages", error))?;

        Ok(parsed
            .delayed_events
            .into_iter()
            .filter(|item| item.event_type == "m.room.message")
            .filter(|item| room_id.is_none_or(|wanted| &item.room_id == wanted))
            .map(|item| ScheduledMessageView {
                delivery_ts: item
                    .running_since
                    .map(|since| since.saturating_add(item.delay)),
                body: item
                    .content
                    .get("body")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                formatted: item
                    .content
                    .get("formatted_body")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                delay_id: item.delay_id,
                room_id: item.room_id,
                delay_ms: item.delay,
            })
            .collect())
    }
}
