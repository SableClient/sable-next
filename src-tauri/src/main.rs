// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(all(feature = "cef", target_os = "linux"))]
fn prompt_for_permission(message: &str, answer: std::sync::mpsc::Sender<bool>) {
    use gtk::prelude::*;
    use gtk::{
        glib, ButtonsType, DialogFlags, MessageDialog, MessageType, ResponseType, WindowPosition,
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
                .is_some_and(|origin| origin.is_app_local())
        {
            return responder.deny(DenyReason::NoPolicy);
        }

        let capture = |kind: &PermissionKind| match kind {
            PermissionKind::Microphone => Some("microphone"),
            PermissionKind::Camera | PermissionKind::CameraPanTiltZoom => Some("camera"),
            PermissionKind::ScreenCapture | PermissionKind::CapturedSurfaceControl => {
                Some("screen")
            }
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
fn cef_command_line_args() -> Vec<(String, Option<String>)> {
    let mut args: Vec<(String, Option<String>)> = vec![
        ("--disable-gpu-sandbox".into(), None),
        ("--disable-font-subpixel-positioning".into(), None),
        ("--enable-font-antialiasing".into(), None),
        ("--disable-background-timer-throttling".into(), None),
        ("--skia-resource-cache-limit-mb".into(), Some("64".into())),
        ("--renderer-process-limit".into(), Some("2".into())),
        (
            "autoplay-policy".into(),
            Some("no-user-gesture-required".into()),
        ),
        (
            "disable-features".into(),
            Some(
                "SpareRendererForSitePerProcess,IntensiveWakeUpThrottling,AutofillActorMode,\
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

    args
}

#[cfg(all(feature = "cef", target_os = "linux"))]
fn is_cef_subprocess() -> bool {
    std::env::args().any(|arg| arg.starts_with("--type="))
}

fn main() {
    // The CEF runtime's Wayland path is unstable; the crate is verified on X11.
    // https://github.com/tauri-apps/tauri/issues/14251
    #[cfg(all(feature = "cef", target_os = "linux"))]
    // SAFETY: single-threaded, before anything Tauri or CEF spawns a thread.
    #[allow(unsafe_code)]
    unsafe {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    // Before everything else: CEF re-execs this binary for its subprocesses.
    #[cfg(all(feature = "cef", target_os = "linux"))]
    {
        tauri_runtime_cef::configure(tauri_runtime_cef::CefConfig {
            identifier: "moe.sable.next".into(),
            custom_schemes: vec!["tauri".into(), "ipc".into(), "asset".into()],
            deep_link_schemes: vec!["moe.sable.next".into(), "sable".into()],
            command_line_args: cef_command_line_args(),
            ..Default::default()
        });

        if is_cef_subprocess() {
            tauri_runtime_cef::run_cef_helper_process();
            return;
        }

        if matches!(
            app_lib::deep_link_ipc::try_forward_deep_links(),
            app_lib::deep_link_ipc::ForwardResult::Forwarded
        ) {
            return;
        }

        install_permission_policy();
    }

    #[cfg(all(feature = "cef", target_os = "linux"))]
    let _deep_link_socket = app_lib::deep_link_ipc::bind_and_listen();

    app_lib::run();
}
