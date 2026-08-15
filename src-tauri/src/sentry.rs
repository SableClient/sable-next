use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use sentry::protocol::Event;

static CONSENT: AtomicBool = AtomicBool::new(false);

/// Returns `None` when no DSN was baked in. The guard flushes on drop.
pub fn init() -> Option<sentry::ClientInitGuard> {
    let dsn = option_env!("SENTRY_DSN")?;

    // `ClientOptions` is `#[non_exhaustive]`, so mutate a default instance.
    let mut options = sentry::ClientOptions::default();
    options.dsn = dsn.parse().ok();
    options.environment = option_env!("SENTRY_ENVIRONMENT").map(Into::into);
    options.release = option_env!("SENTRY_APP_VERSION").map(Into::into);
    options.send_default_pii = false;
    // Consent arrives from the frontend, so anything captured before the
    // webview boots is dropped.
    options.before_send = Some(Arc::new(|event: Event<'static>| {
        CONSENT.load(Ordering::Relaxed).then_some(event)
    }));

    Some(sentry::init(options))
}

#[tauri::command]
pub fn set_native_sentry_enabled(enabled: bool) {
    CONSENT.store(enabled, Ordering::Relaxed);
}
