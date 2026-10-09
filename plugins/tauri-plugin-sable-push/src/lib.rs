mod models;

#[cfg(target_os = "android")]
mod commands;
#[cfg(target_os = "android")]
mod error;
#[cfg(target_os = "android")]
mod mobile;

use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

pub use models::{Account, Diagnostics, History, HistoryEntry, Policy, Post};

#[cfg(target_os = "android")]
pub use error::{Error, Result};
#[cfg(target_os = "android")]
pub use mobile::SablePush;

#[cfg(target_os = "android")]
pub trait SablePushExt<R: Runtime> {
    fn sable_push(&self) -> &SablePush<R>;
}

#[cfg(target_os = "android")]
impl<R: Runtime, T: tauri::Manager<R>> SablePushExt<R> for T {
    fn sable_push(&self) -> &SablePush<R> {
        self.state::<SablePush<R>>().inner()
    }
}

#[must_use]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::<R>::new("sable-push");
    #[cfg(target_os = "android")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            commands::push_history,
            commands::clear_push_history,
            commands::take_push_diagnostics,
        ])
        .setup(|app, api| {
            use tauri::Manager;
            app.manage(SablePush::new(&api)?);
            Ok(())
        });
    builder.build()
}
