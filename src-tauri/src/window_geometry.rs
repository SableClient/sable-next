use std::collections::HashMap;

use serde::Deserialize;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Monitor, Runtime, WebviewWindowBuilder};
use tauri_plugin_window_state::AppHandleExt;

#[derive(Deserialize)]
struct SavedGeometry {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    prev_x: i32,
    prev_y: i32,
    maximized: bool,
    decorated: bool,
}

const MAIN_WINDOW: &str = "main";

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri_plugin_window_state::Builder::default()
        .skip_initial_state(MAIN_WINDOW)
        .build()
}

pub fn restore<'a, R: Runtime, M: Manager<R>>(
    app: &AppHandle<R>,
    builder: WebviewWindowBuilder<'a, R, M>,
    label: &str,
) -> WebviewWindowBuilder<'a, R, M> {
    let Some(saved) = load(app, label) else {
        return builder;
    };
    if saved.width == 0 || saved.height == 0 {
        return builder;
    }
    let Some(monitor) = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .find(|monitor| intersects(monitor, &saved))
    else {
        return builder;
    };

    let scale = monitor.scale_factor();
    let (x, y) = if saved.maximized {
        (saved.prev_x, saved.prev_y)
    } else {
        (saved.x, saved.y)
    };
    builder
        .position(f64::from(x) / scale, f64::from(y) / scale)
        .inner_size(
            f64::from(saved.width) / scale,
            f64::from(saved.height) / scale,
        )
        .maximized(saved.maximized)
        .decorations(saved.decorated)
}

fn load<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<SavedGeometry> {
    let path = app.path().app_config_dir().ok()?.join(app.filename());
    let file = std::fs::read(path).ok()?;
    let mut states: HashMap<String, SavedGeometry> = serde_json::from_slice(&file).ok()?;
    states.remove(label)
}

fn intersects(monitor: &Monitor, saved: &SavedGeometry) -> bool {
    let left = i64::from(monitor.position().x);
    let top = i64::from(monitor.position().y);
    let right = left + i64::from(monitor.size().width);
    let bottom = top + i64::from(monitor.size().height);

    let (x, y) = (i64::from(saved.x), i64::from(saved.y));
    let (width, height) = (i64::from(saved.width), i64::from(saved.height));
    [
        (x, y),
        (x + width, y),
        (x, y + height),
        (x + width, y + height),
    ]
    .into_iter()
    .any(|(x, y)| x >= left && x < right && y >= top && y < bottom)
}
