use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

#[cfg(not(target_os = "linux"))]
use tauri::tray::{MouseButton, TrayIconEvent};

pub const MAIN_TRAY_ID: &str = "sable_next";
pub const WINDOW_HIDDEN_TO_TRAY_EVENT: &str = "window-hidden-to-tray";
const TRAY_MENU_SHOW_ID: &str = "tray_show";
const TRAY_MENU_QUIT_ID: &str = "tray_quit";
const UNREAD_DOT: [u8; 4] = [224, 45, 45, 255];

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
    unread_dot: AtomicBool,
}

impl Default for DesktopWindowStore {
    fn default() -> Self {
        Self {
            close_to_tray: AtomicBool::new(false),
            show_system_tray_icon: AtomicBool::new(true),
            tray_available: AtomicBool::new(false),
            unread_dot: AtomicBool::new(false),
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

pub fn set_unread_dot<R: Runtime>(app: &AppHandle<R>, shown: bool) -> tauri::Result<()> {
    let store = app.state::<DesktopWindowStore>();
    if store.unread_dot.swap(shown, Ordering::Relaxed) == shown {
        return Ok(());
    }
    let Some(tray) = app.tray_by_id(MAIN_TRAY_ID) else {
        return Ok(());
    };
    tray.set_icon(tray_icon(app, shown))
}

fn tray_icon<R: Runtime>(app: &AppHandle<R>, unread: bool) -> Option<Image<'static>> {
    let base = app.default_window_icon()?;
    Some(if unread {
        with_unread_dot(base)
    } else {
        base.clone().to_owned()
    })
}

fn with_unread_dot(base: &Image<'_>) -> Image<'static> {
    let (width, height) = (base.width(), base.height());
    let (w, h) = (f64::from(width), f64::from(height));
    let radius = w.min(h) * 0.2;
    let (cx, cy) = (w - radius - w * 0.04, h - radius - h * 0.04);

    let mut rgba = base.rgba().to_vec();
    let positions = (0..height).flat_map(|y| (0..width).map(move |x| (x, y)));
    for (pixel, (x, y)) in rgba.as_chunks_mut::<4>().0.iter_mut().zip(positions) {
        if (f64::from(x) + 0.5 - cx).hypot(f64::from(y) + 0.5 - cy) <= radius {
            pixel.copy_from_slice(&UNREAD_DOT);
        }
    }
    Image::new_owned(rgba, width, height)
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

#[cfg(target_os = "linux")]
fn fresh_icon_dir<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<std::path::PathBuf> {
    let root = app.path().app_cache_dir()?.join("tray-icon");
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    Ok(root.join(stamp.to_string()))
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

    let unread = app
        .state::<DesktopWindowStore>()
        .unread_dot
        .load(Ordering::Relaxed);
    if let Some(icon) = tray_icon(app, unread) {
        builder = builder.icon(icon);
    }

    #[cfg(target_os = "linux")]
    {
        builder = builder.temp_dir_path(fresh_icon_dir(app)?);
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

    #[test]
    fn the_unread_dot_sits_bottom_right_and_keeps_the_size() {
        let base = Image::new_owned(vec![0; 32 * 32 * 4], 32, 32);
        let dotted = with_unread_dot(&base);

        assert_eq!((dotted.width(), dotted.height()), (32, 32));
        let at = |x: usize, y: usize| &dotted.rgba()[(y * 32 + x) * 4..][..4];
        assert_eq!(at(25, 25), &UNREAD_DOT);
        assert_eq!(at(0, 0), &[0, 0, 0, 0]);
    }
}
