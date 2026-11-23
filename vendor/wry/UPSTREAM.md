Vendored from crates.io wry 0.57.0 (Apache-2.0 OR MIT) with tauri-apps/wry#1856
applied, fixing tauri-apps/wry#1822. Drop once a wry release includes #1856.

## Local patches with no upstream PR yet

- On Android, an interrupted permission request (empty result) counts as denied instead
  of granted, and a camera capture that the system refuses falls back to the file picker
  (src/android/kotlin/WryActivity.kt, RustWebChromeClient.kt).
- On Android, a video capture or file picker that reports success without returning data
  counts as cancelled instead of crashing (src/android/kotlin/RustWebChromeClient.kt).
