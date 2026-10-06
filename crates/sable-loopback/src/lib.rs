#[cfg(windows)]
pub mod capture;
pub mod pcm;
pub mod process;
#[cfg(all(windows, feature = "tauri"))]
pub mod share;
