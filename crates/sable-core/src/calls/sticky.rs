use std::time::Duration;

use matrix_sdk::{Client, Room};
use ruma::api::client::{message::send_message_event::v3, sync::sync_events::v5};
use ruma::events::{MessageLikeEventType, sticky::StickyDurationMs};
use ruma::serde::Raw;
use serde_json::Value;

const STICKY_DURATION_MS: u32 = 900_000;

#[derive(Debug)]
pub(super) enum StickySyncError {
    Matrix,
}

pub(super) struct StickySync {
    conn_id: String,
    pos: Option<String>,
    since: Option<String>,
}

impl StickySync {
    pub(super) fn new(session: u32) -> Self {
        Self {
            conn_id: format!("call-{session}"),
            pos: None,
            since: None,
        }
    }

    fn request(&self, room: &Room, timeout: Duration) -> v5::Request {
        let mut request = v5::Request::new();
        request.pos.clone_from(&self.pos);
        request.conn_id = Some(self.conn_id.clone());
        request.timeout = Some(timeout);
        request.room_subscriptions.insert(
            room.room_id().to_owned(),
            v5::request::RoomSubscription::default(),
        );
        request.extensions.to_device.enabled = Some(false);
        request.extensions.sticky_events.enabled = Some(true);
        request
            .extensions
            .sticky_events
            .since
            .clone_from(&self.since);
        request
    }

    pub(super) async fn sync(
        &mut self,
        room: &Room,
        timeout: Duration,
    ) -> Result<Vec<Value>, StickySyncError> {
        let Ok(response) = room.client().send(self.request(room, timeout)).await else {
            self.pos = None;
            self.since = None;
            return Err(StickySyncError::Matrix);
        };
        let sticky = response.extensions.sticky_events;
        self.pos = Some(response.pos);
        if sticky.next_batch.is_some() {
            self.since = sticky.next_batch;
        }
        let mut events = Vec::new();
        if let Some(room_events) = sticky.rooms.get(room.room_id()) {
            events.extend(
                room_events
                    .events
                    .iter()
                    .filter_map(|event| serde_json::from_str(event.json().get()).ok()),
            );
        }
        if let Some(room_events) = response.rooms.get(room.room_id()) {
            events.extend(
                room_events
                    .timeline
                    .iter()
                    .filter_map(|event| serde_json::from_str(event.json().get()).ok()),
            );
        }
        Ok(events)
    }
}

pub(super) async fn send(
    client: &Client,
    room: &Room,
    content: Value,
) -> Result<ruma::OwnedEventId, matrix_sdk::Error> {
    let mut request = v3::Request::new_raw(
        room.room_id().to_owned(),
        ruma::TransactionId::new(),
        MessageLikeEventType::from("m.rtc.member"),
        Raw::new(&content)?.cast_unchecked(),
    );
    request.sticky_duration_ms = Some(StickyDurationMs::new_clamped(STICKY_DURATION_MS));
    Ok(client.send(request).await?.event_id)
}

pub(super) async fn send_delayed(
    client: &Client,
    room: &Room,
    content: Value,
    delay: Duration,
) -> Result<String, &'static str> {
    let token = client.access_token().ok_or("not logged in")?;
    let mut endpoint = client
        .homeserver()
        .join("/_matrix/client/v3/rooms/")
        .map_err(|_| "invalid homeserver")?;
    endpoint
        .path_segments_mut()
        .map_err(|()| "invalid homeserver")?
        .pop_if_empty()
        .push(room.room_id().as_str())
        .push("send")
        .push("m.rtc.member")
        .push(ruma::TransactionId::new().as_str());
    endpoint
        .query_pairs_mut()
        .append_pair("org.matrix.msc4140.delay", &delay.as_millis().to_string())
        .append_pair(
            "org.matrix.msc4354.sticky_duration_ms",
            &STICKY_DURATION_MS.to_string(),
        );
    let builder = crate::tls::apply(matrix_sdk::reqwest::Client::builder());
    #[cfg(not(target_family = "wasm"))]
    let builder = builder.timeout(Duration::from_secs(15));
    let http = builder.build().map_err(|_| "HTTP client unavailable")?;
    let response = http
        .put(endpoint)
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .body(content.to_string())
        .send()
        .await
        .map_err(|_| "delayed sticky event unavailable")?;
    if !response.status().is_success() {
        return Err("delayed sticky event refused");
    }
    let response = response
        .text()
        .await
        .map_err(|_| "invalid delayed event response")?;
    let response: Value =
        serde_json::from_str(&response).map_err(|_| "invalid delayed event response")?;
    response
        .get("delay_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or("missing delayed event id")
}

#[cfg(test)]
#[path = "sticky_tests.rs"]
mod tests;
