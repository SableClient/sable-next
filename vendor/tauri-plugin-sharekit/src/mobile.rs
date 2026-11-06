use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime, WebviewWindow,
};

use crate::models::{ShareFileOptions, ShareFilePayload, ShareTextOptions, ShareTextPayload};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.share";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_share);

#[allow(clippy::needless_pass_by_value)] // signature required by `lib.rs` plugin setup contract
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<ShareKit<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "SharePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_share)?;

    Ok(ShareKit(handle))
}

/// Access to the share APIs.
pub struct ShareKit<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> ShareKit<R> {
    pub async fn share_text(
        &self,
        _window: WebviewWindow<R>,
        text: String,
        options: ShareTextOptions,
    ) -> crate::Result<()> {
        self.0
            .run_mobile_plugin_async("shareText", ShareTextPayload { text, options })
            .await
            .map_err(Into::into)
    }

    pub async fn share_file(
        &self,
        _window: WebviewWindow<R>,
        url: String,
        options: ShareFileOptions,
    ) -> crate::Result<()> {
        self.0
            .run_mobile_plugin_async("shareFile", ShareFilePayload { url, options })
            .await
            .map_err(Into::into)
    }
}
