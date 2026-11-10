use std::sync::Arc;

use serde::Deserialize;

use super::Handler;
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

impl Handler for SignalParams {
    type Ok = ();
    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.signal_rtc(&self.session_id, self.signal).await
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
        core.close_rtc(&self.session_id);
        if let Ok(client) = core.client().await {
            core.close_search_peer(&client, &self.session_id).await;
        }
        Ok(())
    }
}
