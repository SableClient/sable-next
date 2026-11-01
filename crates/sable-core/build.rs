fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-changed=../../package.json");
    println!("cargo::rerun-if-env-changed=VITE_APP_VERSION");
    println!("cargo::rerun-if-env-changed=TAURI_VITE_APP_VERSION");
    let version = std::env::var("VITE_APP_VERSION")
        .or_else(|_| std::env::var("TAURI_VITE_APP_VERSION"))
        .ok()
        .filter(|version| !version.is_empty())
        .or_else(|| {
            serde_json::from_str::<serde_json::Value>(include_str!("../../package.json"))
                .ok()?
                .get("version")?
                .as_str()
                .map(str::to_owned)
        });
    match version {
        Some(version) => println!("cargo::rustc-env=SABLE_APP_VERSION={version}"),
        None => println!("cargo::error=package.json has no app version"),
    }

    if std::env::var("OPT_LEVEL").as_deref() == Ok("0")
        && std::env::var_os("CARGO_FEATURE_UNOPTIMIZED_BUILD").is_none()
    {
        println!(
            "cargo::error=sable-core requires opt-level >= 1. At opt-level 0 its dispatch path \
             needs ~2.5 MiB of stack, which overflows libtest's 2 MiB test threads, tokio's 2 MiB \
             worker threads and wasm32's 1 MiB shadow stack; at opt-level 1 it needs ~224 KiB. \
             Add `[profile.dev.package.sable-core] opt-level = 1` (and the same under \
             `[profile.test.package.sable-core]`) to your workspace Cargo.toml, or enable the \
             `unoptimized-build` feature to accept the risk."
        );
    }
}
