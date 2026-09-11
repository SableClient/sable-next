use std::time::Duration;

use matrix_sdk::{Client, Room};
use ruma::api::client::{message::send_message_event::v3, sync::sync_events::v5};
use ruma::events::{MessageLikeEventType, sticky::StickyDurationMs};
use ruma::exports::http;
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

#[derive(Clone, Debug)]
struct DelayedStickyRequest(
    ruma::api::client::delayed_events::delayed_message_event::unstable::Request,
);

type DelayedRequest = ruma::api::client::delayed_events::delayed_message_event::unstable::Request;

impl ruma::api::Metadata for DelayedStickyRequest {
    const METHOD: http::Method = DelayedRequest::METHOD;
    const RATE_LIMITED: bool = DelayedRequest::RATE_LIMITED;
    type Authentication = <DelayedRequest as ruma::api::Metadata>::Authentication;
    type PathBuilder = <DelayedRequest as ruma::api::Metadata>::PathBuilder;
    const PATH_BUILDER: Self::PathBuilder = DelayedRequest::PATH_BUILDER;
}

impl ruma::api::OutgoingRequest for DelayedStickyRequest {
    type Body = <DelayedRequest as ruma::api::OutgoingRequest>::Body;
    type EndpointError = <DelayedRequest as ruma::api::OutgoingRequest>::EndpointError;
    type IncomingResponse = <DelayedRequest as ruma::api::OutgoingRequest>::IncomingResponse;

    fn try_into_http_request_inner(
        self,
        base_url: &str,
        input: <Self::PathBuilder as ruma::api::path_builder::PathBuilder>::Input<'_>,
    ) -> Result<http::Request<Self::Body>, ruma::api::error::IntoHttpError> {
        let mut request = self.0.try_into_http_request_inner(base_url, input)?;
        let separator = if request.uri().query().is_some() {
            '&'
        } else {
            '?'
        };
        let uri = format!(
            "{}{separator}org.matrix.msc4354.sticky_duration_ms={STICKY_DURATION_MS}",
            request.uri()
        );
        *request.uri_mut() = uri.parse().map_err(http::Error::from)?;
        Ok(request)
    }
}

pub(super) async fn send_delayed(
    client: &Client,
    room: &Room,
    content: Value,
    delay: Duration,
) -> Result<String, matrix_sdk::Error> {
    let request = DelayedRequest::new_raw(
        room.room_id().to_owned(),
        ruma::TransactionId::new(),
        MessageLikeEventType::from("m.rtc.member"),
        ruma::api::client::delayed_events::DelayParameters::Timeout { timeout: delay },
        Raw::new(&content)?.cast_unchecked(),
    );
    Ok(client.send(DelayedStickyRequest(request)).await?.delay_id)
}

#[cfg(test)]
#[path = "sticky_tests.rs"]
mod tests;
