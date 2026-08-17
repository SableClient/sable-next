fn main() {
    // One set of variables configures both halves of a build, so the webview
    // and the native process report the same project and release.
    for (from, to) in [
        ("VITE_SENTRY_DSN", "SENTRY_DSN"),
        ("VITE_SENTRY_ENVIRONMENT", "SENTRY_ENVIRONMENT"),
        ("VITE_APP_VERSION", "SENTRY_APP_VERSION"),
        ("VITE_PUSH_GATEWAY_URL", "PUSH_GATEWAY_URL"),
        ("VITE_PUSH_APP_ID", "PUSH_APP_ID"),
        ("VITE_PUSH_WEB_APP_ID", "PUSH_WEB_APP_ID"),
        ("VITE_PUSH_VAPID_KEY", "PUSH_VAPID_KEY"),
    ] {
        if let Ok(value) = std::env::var(from) {
            println!("cargo:rustc-env={to}={value}");
        }
        println!("cargo:rerun-if-env-changed={from}");
    }

    tauri_build::build();
}
