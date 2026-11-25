use std::sync::Arc;

use matrix_sdk::ruma::OwnedRoomId;
use serde::{Deserialize, Serialize};

use super::{Handler, SessionHandler, Json};
use crate::SignedIn;
use crate::Core;
use crate::protocol::{CallBackendView, CallCompatibilityView, CallIntent, CallMode, CallModeReason, CallSessionId, CallSupportView, RpcError, TurnServerView};

domain! {
    turn_server,
    rtc_transports,
    rtc_livekit,
    join,
    compatibility,
    support,
    leave,
    set_screen_sharing,
    decline,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RtcLivekitEndpoint {
    GetToken,
    DelegateDelayedLeave,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct TurnServerParams {}

impl SessionHandler for TurnServerParams {
    type Ok = TurnServerView;

    async fn run(self, session: &SignedIn) -> Result<TurnServerView, RpcError> {
        session.turn_server().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RtcTransportsParams {}

impl SessionHandler for RtcTransportsParams {
    type Ok = Json;

    async fn run(self, session: &SignedIn) -> Result<Json, RpcError> {
        session.rtc_transports().await.map(Json)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RtcLivekitParams {
    pub endpoint: RtcLivekitEndpoint,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub body: serde_json::Value,
}

impl SessionHandler for RtcLivekitParams {
    type Ok = Json;

    async fn run(self, session: &SignedIn) -> Result<Json, RpcError> {
        session.rtc_livekit(self.endpoint, &self.body).await.map(Json)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct JoinParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub livekit_service_url: Option<String>,
    #[serde(default)]
    pub mode: Option<CallMode>,
    #[serde(default)]
    pub intent: Option<CallIntent>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct JoinOk {
    pub session: CallSessionId,
    pub url: String,
    pub jwt: String,
    pub identity: String,
    pub encrypt_media: bool,
    pub mode: CallMode,
    pub mode_reason: CallModeReason,
    pub sticky_available: bool,
    pub peer_modes: Vec<CallMode>,
    pub can_publish: bool,
    pub publisher_id: String,
    pub backends: Vec<CallBackendView>,
}

impl SessionHandler for JoinParams {
    type Ok = JoinOk;

    async fn run(self, session: &SignedIn) -> Result<JoinOk, RpcError> {
        session.join_call(
            self.room_id,
            self.livekit_service_url,
            self.mode,
            self.intent,
        )
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CompatibilityParams {}

impl SessionHandler for CompatibilityParams {
    type Ok = CallCompatibilityView;

    async fn run(self, session: &SignedIn) -> Result<CallCompatibilityView, RpcError> {
        session.call_compatibility().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SupportParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub livekit_service_url: Option<String>,
}

impl SessionHandler for SupportParams {
    type Ok = CallSupportView;

    async fn run(self, session: &SignedIn) -> Result<CallSupportView, RpcError> {
        session.call_support(self)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct LeaveParams {
    pub session: CallSessionId,
}

impl Handler for LeaveParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.signed_in()?.leave_call(self.session).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetScreenSharingParams {
    pub session: CallSessionId,
    pub active: bool,
}

impl SessionHandler for SetScreenSharingParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.set_call_screen_sharing(self)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DeclineParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub notification_event_id: String,
}

impl SessionHandler for DeclineParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.decline_call(self)
            .await
    }
}
