use std::sync::Arc;

use serde::Deserialize;

use super::{Handler, SessionHandler};
use crate::SignedIn;
use crate::Core;
use crate::protocol::{RpcError, RtcSignal};

domain! {
    signal,
    close,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SignalParams {
    pub session_id: String,
    pub signal: RtcSignal,
}

impl SessionHandler for SignalParams {
    type Ok = ();
    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.signal_rtc(&self.session_id, self.signal).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct CloseParams {
    pub session_id: String,
}

impl Handler for CloseParams {
    type Ok = ();
    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        if let Ok(session) = core.signed_in() {
            session.close_rtc(&self.session_id);
            session
                .close_search_peer(&self.session_id)
                .await;
        }
        Ok(())
    }
}
