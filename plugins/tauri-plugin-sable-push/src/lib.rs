use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "android")]
const ANDROID_PACKAGE: &str = "moe.sable.push";

#[must_use]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("sable-push")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin(ANDROID_PACKAGE, "SablePushPlugin")?;
            Ok(())
        })
        .build()
}
