use serde::{Serialize, de::DeserializeOwned};
use tauri::{
    Runtime,
    plugin::{PluginApi, PluginHandle},
};

use crate::{
    Result,
    models::{Account, Diagnostics, History, Policy, Post},
};

pub struct SablePush<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> SablePush<R> {
    pub(crate) fn new(api: &PluginApi<R, ()>) -> Result<Self> {
        Ok(Self(api.register_android_plugin(
            "moe.sable.push",
            "SablePushPlugin",
        )?))
    }

    async fn call<T: DeserializeOwned + 'static>(
        &self,
        command: &str,
        payload: impl Serialize,
    ) -> Result<T> {
        Ok(self.0.run_mobile_plugin_async(command, payload).await?)
    }

    /// # Errors
    ///
    /// When the Android plugin rejects the call.
    pub async fn post(&self, post: &Post) -> Result<()> {
        self.call("post", post).await
    }

    /// # Errors
    ///
    /// When the Android plugin rejects the call.
    pub async fn dismiss(&self, ids: &[i32]) -> Result<()> {
        self.call("dismiss", serde_json::json!({ "ids": ids }))
            .await
    }

    /// # Errors
    ///
    /// When the Android plugin rejects the call.
    pub async fn dismiss_shown(&self, ids: &[i32]) -> Result<()> {
        self.call("dismissShown", serde_json::json!({ "ids": ids }))
            .await
    }

    /// # Errors
    ///
    /// When the Android plugin rejects the call.
    pub async fn dismiss_all(&self) -> Result<()> {
        self.call("dismissAll", ()).await
    }

    /// # Errors
    ///
    /// When the Android plugin rejects the call.
    pub async fn set_accounts(&self, accounts: &[Account]) -> Result<()> {
        self.call("setAccounts", serde_json::json!({ "accounts": accounts }))
            .await
    }

    /// # Errors
    ///
    /// When the Android plugin rejects the call.
    pub async fn set_policy(&self, policy: Policy) -> Result<()> {
        self.call("setPolicy", policy).await
    }

    pub(crate) async fn history(&self) -> Result<History> {
        self.call("pushHistory", ()).await
    }

    pub(crate) async fn clear_history(&self) -> Result<()> {
        self.call("clearPushHistory", ()).await
    }

    pub(crate) async fn take_diagnostics(&self) -> Result<Diagnostics> {
        self.call("takePushDiagnostics", ()).await
    }
}
