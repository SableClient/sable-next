use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};

use tauri::{AppHandle, Manager};

use crate::BrowserEngine;

fn granted() -> &'static Mutex<HashSet<&'static str>> {
    static GRANTED: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    GRANTED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn prompt(message: &str, resolve: impl FnOnce(bool) + 'static) {
    use gtk::prelude::*;
    use gtk::{ButtonsType, DialogFlags, MessageDialog, MessageType, ResponseType, WindowPosition};

    let dialog = MessageDialog::new(
        None::<&gtk::Window>,
        DialogFlags::MODAL,
        MessageType::Question,
        ButtonsType::YesNo,
        message,
    );
    dialog.set_title("Permission request");
    dialog.set_position(WindowPosition::CenterAlways);

    let resolve = std::cell::Cell::new(Some(resolve));
    dialog.connect_response(move |dialog, response| {
        if let Some(resolve) = resolve.take() {
            resolve(matches!(response, ResponseType::Yes));
        }
        dialog.close();
    });
    dialog.show();
}

fn resolve(key: &'static str, message: &'static str, answer: impl FnOnce(bool) + 'static) {
    if granted()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(key)
    {
        answer(true);
        return;
    }

    prompt(message, move |allowed| {
        if allowed {
            granted()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(key);
        }
        answer(allowed);
    });
}

pub fn configure(app: &AppHandle<BrowserEngine>) {
    use gtk::glib::prelude::Cast;
    use webkit2gtk::{
        GeolocationPermissionRequest, NotificationPermissionRequest, PermissionRequestExt,
        SettingsExt, UserMediaPermissionRequest, WebViewExt,
    };

    let Some(webview) = app.get_webview_window("main") else {
        return;
    };

    let _ = webview.with_webview(move |platform| {
        let webview = platform.inner();
        if let Some(settings) = webview.settings() {
            settings.set_enable_webrtc(true);
            settings.set_enable_media_stream(true);
            settings.set_enable_mediasource(true);
            settings.set_enable_media(true);
            if std::env::var_os("SABLE_DEVTOOLS").is_some() {
                settings.set_enable_developer_extras(true);
            }
        }

        webview.set_cors_allowlist(&["http://*/*", "https://*/*"]);

        webview.connect_permission_request(|_webview, request| {
            let request = request.clone();
            let asked = if request
                .downcast_ref::<UserMediaPermissionRequest>()
                .is_some()
            {
                Some(("media", "Sable wants to use your camera and microphone."))
            } else if request
                .downcast_ref::<NotificationPermissionRequest>()
                .is_some()
            {
                Some((
                    "notifications",
                    "Sable wants to show desktop notifications.",
                ))
            } else if request
                .downcast_ref::<GeolocationPermissionRequest>()
                .is_some()
            {
                Some(("location", "Sable wants to access your location."))
            } else {
                None
            };

            match asked {
                Some((key, message)) => resolve(key, message, move |allowed| {
                    if allowed {
                        request.allow();
                    } else {
                        request.deny();
                    }
                }),
                None => request.deny(),
            }
            true
        });
    });
}
