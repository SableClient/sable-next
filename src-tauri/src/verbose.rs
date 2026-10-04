use std::{ffi::OsString, io::Write, sync::OnceLock};

use serde::Deserialize;
use tauri::{Runtime, plugin::TauriPlugin};

pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| from_args(std::env::args_os().skip(1)))
}

fn from_args(args: impl IntoIterator<Item = OsString>) -> bool {
    args.into_iter()
        .take_while(|arg| arg != "--")
        .any(|arg| arg == "--verbose")
}

pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("sable-console")
        .js_init_script(include_str!("verbose-console.js"))
        .build()
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ConsoleLevel {
    Log,
    Info,
    Warn,
    Error,
    Debug,
    Trace,
}

impl ConsoleLevel {
    const fn label(self) -> &'static str {
        match self {
            Self::Log => "log",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
            Self::Debug => "debug",
            Self::Trace => "trace",
        }
    }
}

#[tauri::command]
pub(crate) fn log_console(level: ConsoleLevel, message: &str) -> Result<(), &'static str> {
    if !enabled() {
        return Err("console forwarding requires --verbose");
    }
    let _ = writeln!(
        std::io::stderr().lock(),
        "[webview:{}] {message}",
        level.label()
    );
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn attach_terminal() {
    use windows::Win32::System::Console::{ATTACH_PARENT_PROCESS, AttachConsole};

    // SAFETY: AttachConsole takes only a process ID.
    #[expect(unsafe_code, reason = "FFI call")]
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(test)]
mod tests {
    use super::from_args;
    use std::ffi::OsString;

    #[test]
    fn enables_only_an_explicit_verbose_flag() {
        assert!(from_args(["--verbose"].map(OsString::from)));
        assert!(from_args(
            ["--proxy=socks5://localhost:9050", "--verbose"].map(OsString::from)
        ));
        for args in [
            vec![],
            vec!["--verbose=false"],
            vec!["sable://open?flag=--verbose"],
            vec!["--", "--verbose"],
        ] {
            assert!(!from_args(args.into_iter().map(OsString::from)));
        }
    }
}
