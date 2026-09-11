use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::EdgeToEdge;
#[cfg(mobile)]
use mobile::EdgeToEdge;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the edge-to-edge APIs.
pub trait EdgeToEdgeExt<R: Runtime> {
  fn edge_to_edge(&self) -> &EdgeToEdge<R>;
}

impl<R: Runtime, T: Manager<R>> crate::EdgeToEdgeExt<R> for T {
  fn edge_to_edge(&self) -> &EdgeToEdge<R> {
    self.state::<EdgeToEdge<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("edge-to-edge")
    .invoke_handler(tauri::generate_handler![
      commands::get_safe_area_insets,
      commands::get_keyboard_info,
      commands::enable,
      commands::disable,
      commands::show_keyboard,
      commands::hide_keyboard
    ])
    .setup(|app, api| {
      #[cfg(mobile)]
      let edge_to_edge = mobile::init(app, api)?;
      #[cfg(desktop)]
      let edge_to_edge = desktop::init(app, api)?;
      app.manage(edge_to_edge);
      Ok(())
    })
    .build()
}
