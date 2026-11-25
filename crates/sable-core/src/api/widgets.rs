use std::sync::Arc;

use matrix_sdk::ruma::OwnedRoomId;
use serde::Deserialize;

use super::{Handler, SessionHandler, Json};
use crate::SignedIn;
use crate::Core;
use crate::protocol::RpcError;

domain! {
    send_delayed_event,
    send_sticky_event,
    restart_delayed_event,
    send_to_device,
    room_sticky_events,
    set_widget_feed,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendDelayedEventParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub event_type: String,
    #[serde(default)]
    pub state_key: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub content: serde_json::Value,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub delay_ms: u64,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub sticky_duration_ms: Option<u32>,
}

impl SessionHandler for SendDelayedEventParams {
    /// The delay id.
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        session.widget_send_delayed_event(
            &self.room_id,
            &self.event_type,
            self.state_key,
            self.content,
            self.delay_ms,
            self.sticky_duration_ms,
        )
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendStickyEventParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub event_type: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub content: serde_json::Value,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub sticky_duration_ms: u32,
}

impl SessionHandler for SendStickyEventParams {
    /// The event id.
    type Ok = String;

    async fn run(self, session: &SignedIn) -> Result<String, RpcError> {
        session.widget_send_sticky_event(
            &self.room_id,
            &self.event_type,
            self.content,
            self.sticky_duration_ms,
        )
        .await
        .map(|event_id| event_id.to_string())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RestartDelayedEventParams {
    pub delay_id: String,
}

impl SessionHandler for RestartDelayedEventParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.restart_delayed_event(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendToDeviceParams {
    pub event_type: String,
    pub encrypted: bool,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub messages: serde_json::Value,
}

impl SessionHandler for SendToDeviceParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.widget_send_to_device(&self.event_type, self.encrypted, self.messages)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RoomStickyEventsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for RoomStickyEventsParams {
    type Ok = Vec<Json>;

    fn run(self, core: &Arc<Core>) -> impl Future<Output = Result<Vec<Json>, RpcError>> {
        std::future::ready(
            core.signed_in()
                .and_then(|session| session.room_sticky_events(&self.room_id))
                .map(|events| events.into_iter().map(Json).collect()),
        )
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetWidgetFeedParams {
    pub enabled: bool,
}

impl Handler for SetWidgetFeedParams {
    type Ok = ();

    fn run(self, core: &Arc<Core>) -> impl Future<Output = Result<(), RpcError>> {
        core.set_widget_feed(self.enabled);
        std::future::ready(Ok(()))
    }
}
