use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_edge_to_edge);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<EdgeToEdge<R>> {
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("com.plugin.edgetoedge", "EdgeToEdgePlugin")?;
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_edge_to_edge)?;
  Ok(EdgeToEdge(handle))
}

/// Access to the edge-to-edge APIs.
pub struct EdgeToEdge<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> EdgeToEdge<R> {
  /// 获取安全区域
  pub fn get_safe_area_insets(&self) -> crate::Result<SafeAreaInsets> {
    self
      .0
      .run_mobile_plugin("getSafeAreaInsets", ())
      .map_err(Into::into)
  }

  /// 启用 Edge-to-Edge
  pub fn enable(&self) -> crate::Result<()> {
    self
      .0
      .run_mobile_plugin("enable", ())
      .map_err(Into::into)
  }

  /// 禁用 Edge-to-Edge
  pub fn disable(&self) -> crate::Result<()> {
    self
      .0
      .run_mobile_plugin("disable", ())
      .map_err(Into::into)
  }

  /// 获取键盘信息
  pub fn get_keyboard_info(&self) -> crate::Result<KeyboardInfo> {
    self
      .0
      .run_mobile_plugin("getKeyboardInfo", ())
      .map_err(Into::into)
  }

  /// 显示键盘
  pub fn show_keyboard(&self) -> crate::Result<()> {
    self
      .0
      .run_mobile_plugin("showKeyboard", ())
      .map_err(Into::into)
  }

  /// 隐藏键盘
  pub fn hide_keyboard(&self) -> crate::Result<()> {
    self
      .0
      .run_mobile_plugin("hideKeyboard", ())
      .map_err(Into::into)
  }
}
