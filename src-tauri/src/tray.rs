use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

#[cfg(not(target_os = "linux"))]
use tauri::tray::{MouseButton, TrayIconEvent};

pub const MAIN_TRAY_ID: &str = "main";
pub const WINDOW_HIDDEN_TO_TRAY_EVENT: &str = "window-hidden-to-tray";
const TRAY_MENU_SHOW_ID: &str = "tray_show";
const TRAY_MENU_QUIT_ID: &str = "tray_quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowSettings {
    pub close_to_tray: bool,
    pub show_system_tray_icon: bool,
    pub use_custom_title_bar: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowState {
    pub tray_available: bool,
}

pub struct DesktopWindowStore {
    close_to_tray: AtomicBool,
    show_system_tray_icon: AtomicBool,
    tray_available: AtomicBool,
}

impl Default for DesktopWindowStore {
    fn default() -> Self {
        Self {
            close_to_tray: AtomicBool::new(false),
            show_system_tray_icon: AtomicBool::new(true),
            tray_available: AtomicBool::new(false),
        }
    }
}

#[must_use]
pub const fn can_restore_from_background(tray_available: bool) -> bool {
    cfg!(target_os = "macos") || tray_available
}

fn reveal<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn hides_to_tray<R: Runtime>(app: &AppHandle<R>) -> bool {
    let store = app.state::<DesktopWindowStore>();
    store.close_to_tray.load(Ordering::Relaxed)
        && can_restore_from_background(store.tray_available.load(Ordering::Relaxed))
}

pub fn hide_to_tray<R: Runtime>(window: &tauri::Window<R>) {
    let _ = window.emit(WINDOW_HIDDEN_TO_TRAY_EVENT, ());
    let _ = window.hide();
}

pub fn apply<R: Runtime>(
    app: &AppHandle<R>,
    settings: DesktopWindowSettings,
) -> tauri::Result<DesktopWindowState> {
    let store = app.state::<DesktopWindowStore>();
    store
        .close_to_tray
        .store(settings.close_to_tray, Ordering::Relaxed);
    store
        .show_system_tray_icon
        .store(settings.show_system_tray_icon, Ordering::Relaxed);

    apply_title_bar(app, settings.use_custom_title_bar)?;

    let wanted = settings.show_system_tray_icon && cfg!(not(target_os = "macos"));
    let available = if wanted {
        if app.tray_by_id(MAIN_TRAY_ID).is_some() {
            true
        } else {
            match create(app) {
                Ok(()) => true,
                Err(error) => {
                    log::warn!("the system tray could not be created: {error}");
                    false
                }
            }
        }
    } else {
        let _ = app.remove_tray_by_id(MAIN_TRAY_ID);
        false
    };

    store.tray_available.store(available, Ordering::Relaxed);
    Ok(DesktopWindowState {
        tray_available: available,
    })
}

fn apply_title_bar<R: Runtime>(app: &AppHandle<R>, custom: bool) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    window.set_decorations(!custom)?;

    #[cfg(target_os = "macos")]
    window.set_title_bar_style(if custom {
        tauri::TitleBarStyle::Overlay
    } else {
        tauri::TitleBarStyle::Visible
    })?;

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    let _ = (window, custom);

    Ok(())
}

#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
fn appindicator_available() -> bool {
    const CANDIDATES: [&str; 4] = [
        "libayatana-appindicator3.so.1",
        "libappindicator3.so.1",
        "libayatana-appindicator3.so",
        "libappindicator3.so",
    ];

    CANDIDATES.iter().any(|name| {
        // SAFETY: opening a shared library runs its initialisers; these are
        // the desktop's own appindicator, and the handle is dropped at once.
        unsafe { libloading::Library::new(*name) }.is_ok()
    })
}

#[cfg(target_os = "linux")]
fn status_notifier_host_available() -> bool {
    const WATCHER: &str = "org.kde.StatusNotifierWatcher";

    let Ok(name) = zbus::names::BusName::try_from(WATCHER) else {
        return false;
    };
    let Ok(connection) = zbus::blocking::Connection::session() else {
        return false;
    };
    let Ok(dbus) = zbus::blocking::fdo::DBusProxy::new(&connection) else {
        return false;
    };

    dbus.name_has_owner(name).unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn configure_interactions<R: Runtime>(builder: TrayIconBuilder<R>) -> TrayIconBuilder<R> {
    builder
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            else {
                return;
            };
            let app = tray.app_handle();
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            if window.is_visible().unwrap_or(false) {
                let _ = window.hide();
            } else {
                reveal(&window);
            }
        })
}

#[cfg(target_os = "linux")]
const fn configure_interactions<R: Runtime>(builder: TrayIconBuilder<R>) -> TrayIconBuilder<R> {
    builder
}

fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    if !appindicator_available() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no appindicator library on this desktop",
        )
        .into());
    }

    #[cfg(target_os = "linux")]
    if !status_notifier_host_available() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no StatusNotifierWatcher on the session bus",
        )
        .into());
    }

    let show = MenuItem::with_id(app, TRAY_MENU_SHOW_ID, "Show Sable", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_MENU_QUIT_ID, "Quit Sable", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = configure_interactions(
        TrayIconBuilder::with_id(MAIN_TRAY_ID)
            .tooltip("Sable")
            .menu(&menu)
            .on_menu_event(|app, event| match event.id().as_ref() {
                TRAY_MENU_SHOW_ID => {
                    if let Some(window) = app.get_webview_window("main") {
                        reveal(&window);
                    }
                }
                TRAY_MENU_QUIT_ID => app.exit(0),
                _ => {}
            }),
    );

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hiding_is_refused_where_nothing_could_bring_the_window_back() {
        assert!(can_restore_from_background(true));
        assert_eq!(
            can_restore_from_background(false),
            cfg!(target_os = "macos")
        );
    }
}
