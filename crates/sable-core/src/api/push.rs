use crate::errors::CoreResultExt as _;
use std::sync::Arc;

use serde::Deserialize;

use super::{Handler, SessionHandler};
use crate::protocol::{DiagnosticPushView, RegisteredPusherView, RpcError, WebPushKeys};
use crate::{Core, notifications, push_check, webpush, SignedIn};

domain! {
    set_pusher,
    remove_pusher,
    web_pusher_support,
    set_web_pusher,
    web_pushers,
    ping_gateway,
    send_diagnostic,
    ack_web_pusher,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PusherView {
    pub pushkey: String,
    pub app_id: String,
    /// The gateway's `_matrix/push/v1/notify`.
    pub url: String,
    pub device_display_name: String,
    /// Web push delivery, as `UnifiedPush` and a browser use: `pushkey` is then
    /// the `p256dh` and the gateway encrypts to these.
    pub web_push: Option<WebPushKeys>,
    pub event_id_only: bool,
    /// False replaces any pusher already holding this key.
    pub append: bool,
}

/// MSC4174 web push: the homeserver encrypts and delivers, so no gateway.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct WebPusherView {
    pub pushkey: String,
    pub app_id: String,
    pub device_display_name: String,
    /// The browser subscription, where a gateway pusher carries a `url`.
    pub endpoint: String,
    pub auth: String,
    pub event_id_only: bool,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetPusherParams {
    pub pusher: PusherView,
}

impl SessionHandler for SetPusherParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        notifications::set_pusher(session.client(), self.pusher)
            .await
            .or_report(session.core(), "set_pusher")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RemovePusherParams {
    pub pushkey: String,
    pub app_id: String,
}

impl SessionHandler for RemovePusherParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        notifications::remove_pusher(session.client(), self.pushkey, self.app_id)
            .await
            .or_report(session.core(), "remove_pusher")
    }
}

/// The homeserver's web push support: a VAPID key means server delivery.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct WebPusherSupportParams {}

impl SessionHandler for WebPusherSupportParams {
    /// `Some` carries the VAPID key subscriptions must be minted under.
    type Ok = Option<String>;

    async fn run(self, session: &SignedIn) -> Result<Option<String>, RpcError> {
        webpush::support(session.client())
            .await
            .or_report(session.core(), "webpusher_support")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetWebPusherParams {
    pub pusher: WebPusherView,
}

impl SessionHandler for SetWebPusherParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        webpush::set_pusher(session.client(), self.pusher)
            .await
            .or_report(session.core(), "set_webpusher")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct WebPushersParams {}

impl SessionHandler for WebPushersParams {
    type Ok = Vec<RegisteredPusherView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<RegisteredPusherView>, RpcError> {
        webpush::pushers(session.client())
            .await
            .or_report(session.core(), "webpushers")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PingGatewayParams {
    pub url: String,
}

impl Handler for PingGatewayParams {
    type Ok = Option<bool>;

    async fn run(self, _core: &Arc<Core>) -> Result<Option<bool>, RpcError> {
        Ok(push_check::ping_gateway(&self.url).await)
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SendDiagnosticParams {
    pub pushkey: String,
    pub app_id: String,
}

impl SessionHandler for SendDiagnosticParams {
    type Ok = DiagnosticPushView;

    async fn run(self, session: &SignedIn) -> Result<DiagnosticPushView, RpcError> {
        push_check::send_diagnostic_push(session.client(), &self.pushkey, &self.app_id)
            .await
            .or_report(session.core(), "send_diagnostic_push")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AckWebPusherParams {
    pub app_id: String,
    pub ack_token: String,
}

impl SessionHandler for AckWebPusherParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        webpush::ack(session.client(), self.app_id, self.ack_token)
            .await
            .or_report(session.core(), "ack_webpusher")
    }
}
