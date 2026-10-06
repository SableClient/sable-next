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

    let Some(identifier) = identifier() else {
        println!("cargo::error=tauri.conf.json must define an identifier");
        std::process::exit(1);
    };
    println!("cargo:rustc-env=SABLE_IDENTIFIER={identifier}");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-changed=tauri.conf.json");

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

/// The Tauri CLI merges `--config` overrides (the nightly identifier) into
/// `TAURI_CONFIG`; without it the base config applies.
fn identifier() -> Option<String> {
    let read = |json: &str| {
        serde_json::from_str::<serde_json::Value>(json)
            .ok()?
            .get("identifier")?
            .as_str()
            .map(str::to_owned)
    };
    std::env::var("TAURI_CONFIG")
        .ok()
        .and_then(|config| read(&config))
        .or_else(|| read(&std::fs::read_to_string("tauri.conf.json").ok()?))
}
