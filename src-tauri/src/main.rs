// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(feature = "cef", target_os = "linux"))]
fn prompt_for_permission(message: &str, answer: std::sync::mpsc::Sender<bool>) {
    use gtk::prelude::*;
    use gtk::{
        ButtonsType, DialogFlags, MessageDialog, MessageType, ResponseType, WindowPosition, glib,
    };

    let message = message.to_owned();
    glib::idle_add_once(move || {
        let dialog = MessageDialog::new(
            None::<&gtk::Window>,
            DialogFlags::MODAL,
            MessageType::Question,
            ButtonsType::YesNo,
            &message,
        );
        dialog.set_title("Permission request");
        dialog.set_position(WindowPosition::CenterAlways);

        let answer = std::cell::RefCell::new(Some(answer));
        dialog.connect_response(move |dialog, response| {
            if let Some(answer) = answer.take() {
                let _ = answer.send(response == ResponseType::Yes);
            }
            dialog.close();
        });

        // Never `run()`: it blocks the GLib main loop that CEF pumps.
        dialog.show();
    });
}

#[cfg(all(feature = "cef", target_os = "linux"))]
fn install_permission_policy() {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};

    static GRANTED: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    let granted = GRANTED.get_or_init(|| Mutex::new(HashSet::new()));

    tauri_runtime_cef::set_permission_policy(move |request, responder| {
        use tauri_runtime_cef::{DenyReason, PermissionKind};

        if request.webview_label != "main"
            || !request
                .origin
                .as_ref()
                .is_some_and(tauri_runtime_cef::NormalizedOrigin::is_app_local)
        {
            return responder.deny(DenyReason::NoPolicy);
        }

        let capture = |kind: &PermissionKind| match kind {
            PermissionKind::Microphone => Some("microphone"),
            PermissionKind::Camera | PermissionKind::CameraPanTiltZoom => Some("camera"),
            PermissionKind::ScreenCapture | PermissionKind::CapturedSurfaceControl => {
                Some("screen")
            }
            PermissionKind::Geolocation => Some("location"),
            _ => None,
        };

        let Some(kinds) = request
            .kinds
            .iter()
            .map(capture)
            .collect::<Option<Vec<_>>>()
        else {
            return responder.deny(DenyReason::NoPolicy);
        };
        if kinds.is_empty() {
            return responder.deny(DenyReason::NoPolicy);
        }

        {
            let cache = granted
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if kinds.iter().all(|kind| cache.contains(kind)) {
                return responder.allow();
            }
        }

        let message = match kinds.as_slice() {
            ["microphone"] => "Sable wants to use your microphone.",
            ["camera"] => "Sable wants to use your camera.",
            ["screen"] => "Sable wants to share your screen.",
            ["location"] => "Sable wants to access your location.",
            _ => "Sable wants to use your microphone and camera.",
        };

        let deferred = responder.defer(tauri_runtime_cef::DEFAULT_PROMPT_TIMEOUT);
        let (tx, rx) = std::sync::mpsc::channel();
        prompt_for_permission(message, tx);
        std::thread::spawn(move || {
            let allowed = rx
                .recv_timeout(tauri_runtime_cef::DEFAULT_PROMPT_TIMEOUT)
                .unwrap_or(false);
            if !allowed {
                deferred.deny(DenyReason::PolicyDenied);
                return;
            }
            granted
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .extend(kinds);
            deferred.allow();
        });
    });
}

#[cfg(all(feature = "cef", target_os = "linux"))]
fn cef_proxy_from_args(
    args: impl IntoIterator<Item = std::ffi::OsString>,
) -> Result<Option<String>, String> {
    let mut args = args.into_iter();
    let mut proxy = None;

    while let Some(argument) = args.next() {
        let Some(argument) = argument.to_str() else {
            continue;
        };
        let value = match argument.strip_prefix("--proxy=") {
            Some(value) => value,
            None if argument == "--proxy" => args
                .next()
                .and_then(|value| value.into_string().ok())
                .ok_or_else(|| "--proxy requires an HTTP or SOCKS proxy URL".to_owned())?,
            None => continue,
        };

        if proxy.is_some() {
            return Err("--proxy may only be specified once".to_owned());
        }
        proxy = Some(normalize_cef_proxy(value)?);
    }

    Ok(proxy)
}

#[cfg(all(feature = "cef", target_os = "linux"))]
fn normalize_cef_proxy(value: &str) -> Result<String, String> {
    let proxy = tauri::Url::parse(value)
        .map_err(|_| "--proxy must be an HTTP or SOCKS proxy URL".to_owned())?;
    if !matches!(proxy.scheme(), "http" | "socks" | "socks4" | "socks5") {
        return Err("--proxy must use http, socks, socks4, or socks5".to_owned());
    }
    if !proxy.username().is_empty() || proxy.password().is_some() {
        return Err("--proxy does not support credentials".to_owned());
    }
    if proxy.path() != "/" || proxy.query().is_some() || proxy.fragment().is_some() {
        return Err("--proxy must not include a path, query, or fragment".to_owned());
    }

    let host = proxy
        .host_str()
        .ok_or_else(|| "--proxy requires a host".to_owned())?;
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let port = proxy
        .port()
        .map_or_else(String::new, |port| format!(":{port}"));

    Ok(format!("{}://{host}{port}", proxy.scheme()))
}

#[cfg(all(feature = "cef", target_os = "linux"))]
fn cef_command_line_args(proxy: Option<&str>) -> Vec<(String, Option<String>)> {
    let mut args: Vec<(String, Option<String>)> = vec![
        ("--disable-gpu-sandbox".into(), None),
        // ANGLE's OpenGL backend cannot import decoded video frames on the
        // NVIDIA proprietary driver, so video plays with sound and no picture.
        ("use-angle".into(), Some("vulkan".into())),
        ("--disable-font-subpixel-positioning".into(), None),
        ("--enable-font-antialiasing".into(), None),
        ("--skia-resource-cache-limit-mb".into(), Some("64".into())),
        ("--renderer-process-limit".into(), Some("2".into())),
        (
            "autoplay-policy".into(),
            Some("no-user-gesture-required".into()),
        ),
        ("enable-features".into(), Some("SharedArrayBuffer".into())),
        (
            "disable-features".into(),
            Some(
                "SpareRendererForSitePerProcess,AutofillActorMode,\
                 GlicActorUi,LensOverlay,LocalNetworkAccessChecks,\
                 LocalNetworkAccessChecksWebSocket,LocalNetworkAccessChecksWebRTC"
                    .into(),
            ),
        ),
    ];

    if let Ok(port) = std::env::var("SABLE_DEVTOOLS") {
        args.push(("--remote-debugging-port".into(), Some(port)));
    }
    if std::env::var_os("SABLE_DISABLE_GPU").is_some() {
        args.push(("--disable-gpu".into(), None));
    }
    if let Ok(extra) = std::env::var("SABLE_CEF_ARGS") {
        for arg in extra
            .split(',')
            .map(str::trim)
            .filter(|arg| !arg.is_empty())
        {
            match arg.split_once('=') {
                Some((key, value)) => args.push((key.to_owned(), Some(value.to_owned()))),
                None => args.push((arg.to_owned(), None)),
            }
        }
    }
    if let Some(proxy) = proxy {
        args.push(("proxy-server".into(), Some(proxy.to_owned())));
    }

    args
}

#[cfg(all(feature = "cef", target_os = "linux"))]
fn is_cef_subprocess() -> bool {
    std::env::args().any(|arg| arg.starts_with("--type="))
}

#[cfg(all(feature = "cef", target_os = "linux"))]
fn is_cef_views() -> bool {
    std::env::var_os("SABLE_CEF_VIEWS").is_some()
}

#[cfg(target_os = "linux")]
fn apply_env_defaults(defaults: &[(&str, std::ffi::OsString)]) {
    for (key, value) in defaults {
        if std::env::var_os(key).is_some() {
            continue;
        }
        // SAFETY: single-threaded, before anything Tauri or CEF spawns a thread.
        #[allow(unsafe_code)]
        unsafe {
            std::env::set_var(key, value);
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_env_defaults() -> Vec<(&'static str, std::ffi::OsString)> {
    let nvidia = [("__NV_DISABLE_EXPLICIT_SYNC", std::ffi::OsString::from("1"))];
    #[cfg(feature = "cef")]
    let engine: Vec<(&'static str, std::ffi::OsString)> = Vec::new();
    #[cfg(not(feature = "cef"))]
    let engine = webkit_env_defaults();
    nvidia.into_iter().chain(engine).collect()
}

#[cfg(all(not(feature = "cef"), target_os = "linux"))]
fn webkit_env_defaults() -> Vec<(&'static str, std::ffi::OsString)> {
    use std::path::{Path, PathBuf};

    let mut defaults = vec![
        ("WEBKIT_DISABLE_COMPOSITING_MODE", "1".into()),
        ("WEBKIT_DISABLE_DMABUF_RENDERER", "1".into()),
    ];

    let plugin_dirs = [
        "/usr/lib/gstreamer-1.0",
        "/usr/lib64/gstreamer-1.0",
        "/usr/local/lib/gstreamer-1.0",
        "/usr/local/lib64/gstreamer-1.0",
        "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
        "/usr/lib/aarch64-linux-gnu/gstreamer-1.0",
        "/run/host/usr/lib/gstreamer-1.0",
        "/run/host/usr/lib64/gstreamer-1.0",
    ];
    if let Some(dir) = plugin_dirs.iter().find(|dir| Path::new(dir).exists()) {
        defaults.push(("GST_PLUGIN_SYSTEM_PATH_1_0", (*dir).into()));
        defaults.push(("GST_PLUGIN_PATH_1_0", (*dir).into()));
    }

    let mut scanners: Vec<PathBuf> = [
        "/usr/lib/gstreamer-1.0/gst-plugin-scanner",
        "/usr/lib64/gstreamer-1.0/gst-plugin-scanner",
        "/usr/libexec/gstreamer-1.0/gst-plugin-scanner",
        "/usr/lib/x86_64-linux-gnu/gstreamer-1.0/gst-plugin-scanner",
        "/usr/lib/aarch64-linux-gnu/gstreamer-1.0/gst-plugin-scanner",
        "/run/host/usr/lib/gstreamer-1.0/gst-plugin-scanner",
        "/run/host/usr/lib64/gstreamer-1.0/gst-plugin-scanner",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect();
    if let Some(path) = std::env::var_os("PATH") {
        scanners.extend(std::env::split_paths(&path).map(|dir| dir.join("gst-plugin-scanner")));
    }
    if let Some(scanner) = scanners.iter().find(|path| path.exists()) {
        defaults.push(("GST_PLUGIN_SCANNER", scanner.clone().into_os_string()));
    }

    defaults
}

fn main() {
    #[cfg(all(feature = "cef", target_os = "linux"))]
    let proxy = match cef_proxy_from_args(std::env::args_os().skip(1)) {
        Ok(proxy) => proxy,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };

    // The CEF runtime's Wayland path is unstable; the crate is verified on X11.
    // https://github.com/tauri-apps/tauri/issues/14251
    #[cfg(all(feature = "cef", target_os = "linux"))]
    if !is_cef_views() {
        // SAFETY: single-threaded, before anything Tauri or CEF spawns a thread.
        #[allow(unsafe_code)]
        unsafe {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    #[cfg(target_os = "linux")]
    apply_env_defaults(&linux_env_defaults());

    // Before everything else: CEF re-execs this binary for its subprocesses.
    #[cfg(all(feature = "cef", target_os = "linux"))]
    let _deep_link_socket = {
        tauri_runtime_cef::configure(tauri_runtime_cef::CefConfig {
            identifier: "moe.sable.next".into(),
            custom_schemes: vec![
                "tauri".into(),
                "ipc".into(),
                "asset".into(),
                app_lib::TILE_URI_SCHEME.into(),
            ],
            deep_link_schemes: vec!["moe.sable.next".into(), "sable".into()],
            command_line_args: cef_command_line_args(proxy.as_deref()),
            linux_windowing: if is_cef_views() {
                tauri_runtime_cef::LinuxWindowing::Wayland
            } else {
                tauri_runtime_cef::LinuxWindowing::X11
            },
            ..Default::default()
        });

        if is_cef_subprocess() {
            tauri_runtime_cef::run_cef_helper_process();
            return;
        }

        if matches!(
            app_lib::deep_link_ipc::try_forward_to_primary(),
            app_lib::deep_link_ipc::ForwardResult::Forwarded
        ) {
            return;
        }

        let socket = app_lib::deep_link_ipc::bind_and_listen();
        if socket.is_none()
            && matches!(
                app_lib::deep_link_ipc::try_forward_to_primary(),
                app_lib::deep_link_ipc::ForwardResult::Forwarded
            )
        {
            return;
        }
        socket
    };

    #[cfg(all(feature = "cef", target_os = "linux"))]
    install_permission_policy();

    app_lib::run();
}

#[cfg(all(test, feature = "cef", target_os = "linux"))]
mod tests {
    use std::ffi::OsString;

    use super::{cef_command_line_args, cef_proxy_from_args};

    #[test]
    fn cef_keeps_background_throttling_enabled() {
        let args = cef_command_line_args(None);

        assert!(
            args.iter()
                .all(|(name, _)| name != "--disable-background-timer-throttling")
        );
        assert!(args.iter().all(|(name, value)| {
            name != "disable-features"
                || !value
                    .as_deref()
                    .is_some_and(|features| features.contains("IntensiveWakeUpThrottling"))
        }));
    }

    #[test]
    fn cef_accepts_a_socks_proxy() {
        let args = ["--proxy", "socks5://[::1]:9050"].map(OsString::from);

        assert_eq!(
            cef_proxy_from_args(args),
            Ok(Some("socks5://[::1]:9050".into()))
        );
    }

    #[test]
    fn cef_rejects_an_invalid_proxy() {
        let args = ["--proxy=https://proxy.example"].map(OsString::from);

        assert_eq!(
            cef_proxy_from_args(args),
            Err("--proxy must use http, socks, socks4, or socks5".into())
        );
    }

    #[test]
    fn cef_passes_the_proxy_to_chromium() {
        let args = cef_command_line_args(Some("socks5://127.0.0.1:9050"));

        assert!(args.iter().any(|(name, value)| {
            name == "proxy-server" && value.as_deref() == Some("socks5://127.0.0.1:9050")
        }));
    }
}
