use tauri::{AppHandle, Runtime, Theme};
use zbus::zvariant::OwnedValue;

const NAMESPACE: &str = "org.freedesktop.appearance";
const KEY: &str = "color-scheme";

fn theme_for(value: OwnedValue) -> Option<Theme> {
    match u32::try_from(value) {
        Ok(1) => Some(Theme::Dark),
        Ok(2) => Some(Theme::Light),
        _ => None,
    }
}

pub fn follow<R: Runtime>(app: AppHandle<R>) {
    std::thread::spawn(move || {
        let Ok(connection) = zbus::blocking::Connection::session() else {
            return;
        };
        let Ok(proxy) = zbus::blocking::Proxy::new(
            &connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Settings",
        ) else {
            return;
        };
        let Ok(changes) = proxy.receive_signal("SettingChanged") else {
            return;
        };
        if let Ok(value) = proxy.call::<_, _, OwnedValue>("ReadOne", &(NAMESPACE, KEY)) {
            app.set_theme(theme_for(value));
        }
        for message in changes {
            let Ok((namespace, key, value)) =
                message.body().deserialize::<(String, String, OwnedValue)>()
            else {
                continue;
            };
            if namespace == NAMESPACE && key == KEY {
                app.set_theme(theme_for(value));
            }
        }
    });
}
