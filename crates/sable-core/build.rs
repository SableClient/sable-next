fn main() {
    println!("cargo::rerun-if-changed=build.rs");

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
