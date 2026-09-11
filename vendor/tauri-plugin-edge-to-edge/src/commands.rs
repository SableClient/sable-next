use tauri::{AppHandle, command, Runtime};

use crate::models::*;
use crate::Result;
use crate::EdgeToEdgeExt;

/// 获取安全区域
#[command]
pub(crate) async fn get_safe_area_insets<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SafeAreaInsets> {
    app.edge_to_edge().get_safe_area_insets()
}

/// 启用 Edge-to-Edge
#[command]
pub(crate) async fn enable<R: Runtime>(
    app: AppHandle<R>,
) -> Result<()> {
    app.edge_to_edge().enable()
}

/// 禁用 Edge-to-Edge
#[command]
pub(crate) async fn disable<R: Runtime>(
    app: AppHandle<R>,
) -> Result<()> {
    app.edge_to_edge().disable()
}

/// 获取键盘信息
#[command]
pub(crate) async fn get_keyboard_info<R: Runtime>(
    app: AppHandle<R>,
) -> Result<KeyboardInfo> {
    app.edge_to_edge().get_keyboard_info()
}

/// 显示键盘
#[command]
pub(crate) async fn show_keyboard<R: Runtime>(
    app: AppHandle<R>,
) -> Result<()> {
    app.edge_to_edge().show_keyboard()
}

/// 隐藏键盘
#[command]
pub(crate) async fn hide_keyboard<R: Runtime>(
    app: AppHandle<R>,
) -> Result<()> {
    app.edge_to_edge().hide_keyboard()
}
