fn main() {
    // One set of variables configures both halves of a build, so the webview
    // and the native process report the same project and release.
    for (from, to) in [
        ("VITE_SENTRY_DSN", "SENTRY_DSN"),
        ("VITE_SENTRY_ENVIRONMENT", "SENTRY_ENVIRONMENT"),
        ("VITE_APP_VERSION", "SENTRY_APP_VERSION"),
    ] {
        if let Ok(value) = std::env::var(from) {
            println!("cargo:rustc-env={to}={value}");
        }
        println!("cargo:rerun-if-env-changed={from}");
    }

    tauri_build::build();
}
