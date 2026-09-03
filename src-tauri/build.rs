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

    println!("cargo:rerun-if-env-changed=SABLE_BUILD_FLAVOR");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg-bins=-Wl,--exclude-libs,ALL");
    }

    if std::env::var_os("CARGO_FEATURE_CEF").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux")
    {
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN");
    }

    tauri_build::build();
}
