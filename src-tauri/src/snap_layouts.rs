use std::{
    ffi::OsString,
    os::windows::ffi::OsStringExt,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use enigo::{
    Direction::{Click, Press, Release},
    Enigo, Key, Keyboard, Settings,
};
use windows::Win32::{
    Foundation::{CloseHandle, HWND, POINT},
    System::{
        ProcessStatus::GetModuleBaseNameW,
        Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
    },
    UI::WindowsAndMessaging::{
        GetClassNameW, GetCursorPos, GetWindowThreadProcessId, WindowFromPoint,
    },
};

const FLYOUT_CLASS: &str = "Xaml_WindowedPopupClass";
const FLYOUT_EXE: &str = "explorer.exe";
const REACH_TIMEOUT: Duration = Duration::from_millis(200);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

static TRACKING: AtomicU64 = AtomicU64::new(0);

fn keyboard() -> Result<Enigo, String> {
    Enigo::new(&Settings::default()).map_err(|error| error.to_string())
}

fn press_escape() -> Result<(), String> {
    keyboard()?
        .key(Key::Escape, Click)
        .map_err(|error| error.to_string())
}

#[allow(unsafe_code)]
fn class_name(hwnd: HWND) -> Option<String> {
    let mut buffer = [0u16; 256];
    // SAFETY: writes at most the length of a live local buffer.
    let len = usize::try_from(unsafe { GetClassNameW(hwnd, &mut buffer) }).ok()?;
    let name = buffer.get(..len).filter(|name| !name.is_empty())?;
    Some(OsString::from_wide(name).to_string_lossy().into_owned())
}

#[allow(unsafe_code)]
fn exe_name(hwnd: HWND) -> Option<String> {
    let mut process_id = 0;
    // SAFETY: writes to a live local.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&raw mut process_id)) };
    if process_id == 0 {
        return None;
    }
    // SAFETY: value arguments only; the handle is closed below.
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
            false,
            process_id,
        )
    }
    .ok()?;
    let mut buffer = [0u16; 260];
    // SAFETY: an open handle and a live local buffer.
    let len = usize::try_from(unsafe { GetModuleBaseNameW(process, None, &mut buffer) }).ok();
    // SAFETY: closes the handle opened above, once.
    let _ = unsafe { CloseHandle(process) };
    let len = len.filter(|len| *len > 0)?;
    Some(
        OsString::from_wide(buffer.get(..len)?)
            .to_string_lossy()
            .into_owned(),
    )
}

#[allow(unsafe_code)]
fn pointer_on_flyout() -> bool {
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: writes to a live local.
    if unsafe { GetCursorPos(&raw mut point) }.is_err() {
        return false;
    }
    // SAFETY: value argument only.
    let hwnd = unsafe { WindowFromPoint(point) };
    if hwnd.0.is_null() {
        return false;
    }
    class_name(hwnd).is_some_and(|name| name.eq_ignore_ascii_case(FLYOUT_CLASS))
        && exe_name(hwnd).is_some_and(|name| name.eq_ignore_ascii_case(FLYOUT_EXE))
}

#[tauri::command]
pub async fn show_snap_layouts() -> Result<(), String> {
    TRACKING.fetch_add(1, Ordering::Relaxed);
    let mut keys = keyboard()?;
    keys.key(Key::Meta, Press)
        .map_err(|error| error.to_string())?;
    let chord = keys.key(Key::Unicode('z'), Click);
    let release = keys.key(Key::Meta, Release);
    chord.map_err(|error| error.to_string())?;
    release.map_err(|error| error.to_string())?;
    tokio::time::sleep(POLL_INTERVAL).await;
    keys.key(Key::Alt, Click).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn release_snap_layouts() {
    let generation = TRACKING.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let mut reached = false;
        while TRACKING.load(Ordering::Relaxed) == generation {
            let on_flyout = pointer_on_flyout();
            if (reached && !on_flyout) || (!reached && started.elapsed() >= REACH_TIMEOUT) {
                if let Err(error) = press_escape() {
                    log::warn!("the Snap Layouts flyout could not be closed: {error}");
                }
                break;
            }
            reached |= on_flyout;
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
}

#[tauri::command]
pub fn dismiss_snap_layouts() -> Result<(), String> {
    TRACKING.fetch_add(1, Ordering::Relaxed);
    press_escape()
}
