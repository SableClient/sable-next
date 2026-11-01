fn main() {
    // One set of variables configures both halves of a build, so the webview
    // and the native process report the same project and release.
    // `tauri ios build` only passes TAURI_* variables through to cargo.
    for (from, to) in [
        ("VITE_SENTRY_DSN", "SENTRY_DSN"),
        ("VITE_SENTRY_ENVIRONMENT", "SENTRY_ENVIRONMENT"),
        ("VITE_APP_VERSION", "SENTRY_APP_VERSION"),
    ] {
        let forwarded = format!("TAURI_{from}");
        if let Ok(value) = std::env::var(from).or_else(|_| std::env::var(&forwarded)) {
            println!("cargo:rustc-env={to}={value}");
        }
        println!("cargo:rerun-if-env-changed={from}");
        println!("cargo:rerun-if-env-changed={forwarded}");
    }

    tauri_build::build();
}
