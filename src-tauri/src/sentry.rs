use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

fn consent_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    #[cfg(target_os = "macos")]
    let path = std::path::PathBuf::from(home)
        .join("Library/Application Support/Sable Next/sentry-consent");
    #[cfg(not(target_os = "macos"))]
    let path = std::env::var_os("XDG_STATE_HOME")
        .map_or_else(|| std::path::PathBuf::from(home).join(".local/state"), std::path::PathBuf::from)
        .join("sable-next/sentry-consent");
    Some(path)
}

fn consent() -> bool {
    consent_path().is_some_and(|path| std::fs::read(path).is_ok_and(|value| value == b"1"))
}

fn persist_consent(enabled: bool) {
    let Some(path) = consent_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, if enabled { b"1" } else { b"0" });
}

use sentry::protocol::Event;

static CONSENT: AtomicBool = AtomicBool::new(false);

/// Returns `None` when no DSN was baked in. The guard flushes on drop.
pub fn init() -> Option<sentry::ClientInitGuard> {
    let dsn = option_env!("SENTRY_DSN")?;
    CONSENT.store(consent(), Ordering::Relaxed);

    // `ClientOptions` is `#[non_exhaustive]`, so mutate a default instance.
    let mut options = sentry::ClientOptions::default();
    match dsn.parse() {
        Ok(dsn) => options.dsn = Some(dsn),
        Err(error) => {
            tracing::error!("SENTRY_DSN is malformed, crash reporting is off: {error}");
            return None;
        }
    }
    options.environment = option_env!("SENTRY_ENVIRONMENT").map(Into::into);
    options.release = option_env!("SENTRY_APP_VERSION").map(Into::into);
    options.send_default_pii = false;
    // Consent arrives from the frontend, so anything captured before the
    // webview boots is dropped.
    options.before_send = Some(Arc::new(|event: Event<'static>| {
        consent().then_some(event)
    }));

    Some(sentry::init(options))
}

#[tauri::command]
pub fn set_native_sentry_enabled(enabled: bool) {
    CONSENT.store(enabled, Ordering::Relaxed);
    persist_consent(enabled);
    #[cfg(target_os = "android")]
    if let Err(error) = crate::mobile::set_sentry_enabled(enabled) {
        tracing::warn!(%error, "android crash reporting consent not applied");
    }
    #[cfg(target_os = "ios")]
    if let Err(error) = crate::ios::set_sentry_enabled(enabled) {
        tracing::warn!(%error, "ios crash reporting consent not applied");
    }
}
