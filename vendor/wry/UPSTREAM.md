Vendored from crates.io wry 0.57.0 (Apache-2.0 OR MIT) with tauri-apps/wry#1856
applied, fixing tauri-apps/wry#1822. Drop once a wry release includes #1856.

## Also carried

- tauri-apps/wry#1885, released in wry 0.57.1: the Activity ID extra is read only when present
  (src/android/kotlin/WryActivity.kt).
- Lint fixes for this workspace's warnings: a `rustc-check-cfg` line in build.rs, and unused
  imports and `unsafe` blocks in src/wkwebview/download.rs and src/wkwebview/mod.rs.
- Cargo.toml without the upstream examples and readme, which are not vendored.

A re-vendor has to carry these and the local patches below as well as #1856.

## Local patches with no upstream PR yet

- On Android, an interrupted permission request (empty result) counts as denied instead
  of granted, and a camera capture that the system refuses falls back to the file picker
  (src/android/kotlin/WryActivity.kt, RustWebChromeClient.kt).
- On Android, a video capture or file picker that reports success without returning data
  counts as cancelled instead of crashing (src/android/kotlin/RustWebChromeClient.kt).
