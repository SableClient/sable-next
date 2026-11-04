use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState, hotkey::HotKey};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi_derive::napi;
use serde_json::json;

use super::Callback;

#[napi(object)]
pub struct CallShortcutBinding {
    pub id: String,
    pub hotkey: String,
    pub passive: String,
    pub trigger: String,
    pub description: String,
}

#[napi(string_enum = "lowercase")]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CallShortcutBackend {
    Passive,
    Exclusive,
    Portal,
}

struct HotkeyHandler {
    notify: Callback,
    ids: HashMap<u32, String>,
}

static HANDLER: Mutex<Option<HotkeyHandler>> = Mutex::new(None);

fn send(notify: &Callback, event: &serde_json::Value) {
    notify.call(event.to_string(), ThreadsafeFunctionCallMode::NonBlocking);
}

#[napi]
pub struct NativeCallShortcuts {
    manager: Option<GlobalHotKeyManager>,
    listening: Option<Arc<AtomicBool>>,
    #[cfg(target_os = "linux")]
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

#[napi]
impl NativeCallShortcuts {
    #[napi(constructor)]
    pub fn new(
        bindings: Vec<CallShortcutBinding>,
        backend: CallShortcutBackend,
        app_id: String,
        notify: Callback,
    ) -> napi::Result<Self> {
        if backend == CallShortcutBackend::Passive {
            return passive_shortcuts(&bindings, notify).map(|listening| Self {
                manager: None,
                listening: Some(listening),
                #[cfg(target_os = "linux")]
                stop: None,
            });
        }
        #[cfg(target_os = "linux")]
        if backend == CallShortcutBackend::Portal {
            let (stop, stopped) = tokio::sync::oneshot::channel();
            napi::bindgen_prelude::spawn(async move {
                let result = tokio::select! {
                    result = portal_shortcuts(&bindings, &app_id, &notify) => result,
                    _ = stopped => return,
                };
                if let Err(error) = result {
                    send(
                        &notify,
                        &json!({"status": "error", "error": error.to_string()}),
                    );
                }
            });
            return Ok(Self {
                manager: None,
                listening: None,
                stop: Some(stop),
            });
        }
        #[cfg(not(target_os = "linux"))]
        drop(app_id);

        let hotkeys = bindings
            .into_iter()
            .map(|b| b.hotkey.parse::<HotKey>().map(|key| (key, b.id)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        GlobalHotKeyEvent::set_event_handler(Some(|event: GlobalHotKeyEvent| {
            let handler = HANDLER.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(handler) = handler.as_ref()
                && let Some(id) = handler.ids.get(&event.id)
            {
                send(
                    &handler.notify,
                    &json!({"id": id, "pressed": event.state == HotKeyState::Pressed}),
                );
            }
        }));
        let manager = GlobalHotKeyManager::new()
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        for (key, _) in &hotkeys {
            manager
                .register(*key)
                .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        }
        *HANDLER.lock().unwrap_or_else(PoisonError::into_inner) = Some(HotkeyHandler {
            notify,
            ids: hotkeys
                .into_iter()
                .map(|(key, id)| (key.id(), id))
                .collect(),
        });
        Ok(Self {
            manager: Some(manager),
            listening: None,
            #[cfg(target_os = "linux")]
            stop: None,
        })
    }

    #[napi]
    pub fn close(&mut self) {
        if self.manager.take().is_some() {
            *HANDLER.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
        if let Some(listening) = self.listening.take() {
            listening.store(false, Ordering::Relaxed);
        }
        #[cfg(target_os = "linux")]
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

impl Drop for NativeCallShortcuts {
    fn drop(&mut self) {
        self.close();
    }
}

fn passive_shortcuts(
    bindings: &[CallShortcutBinding],
    notify: Callback,
) -> napi::Result<Arc<AtomicBool>> {
    let reason = |error: handy_keys::Error| napi::Error::from_reason(error.to_string());
    let hotkeys = bindings
        .iter()
        .map(|b| Ok((b.passive.parse::<handy_keys::Hotkey>()?, b.id.clone())))
        .collect::<handy_keys::Result<Vec<_>>>()
        .map_err(reason)?;
    let listener = handy_keys::KeyboardListener::new().map_err(reason)?;
    let listening = Arc::new(AtomicBool::new(true));
    let running = Arc::clone(&listening);
    std::thread::spawn(move || {
        let mut held = HashSet::new();
        while running.load(Ordering::Relaxed) {
            let event = match listener.recv_timeout(Duration::from_millis(100)) {
                Ok(event) => event,
                Err(handy_keys::Error::Timeout) => continue,
                Err(error) => {
                    send(
                        &notify,
                        &json!({"status": "error", "error": error.to_string()}),
                    );
                    return;
                }
            };
            for (hotkey, id) in &hotkeys {
                let fires = if event.is_key_down {
                    !held.contains(id)
                        && hotkey.key == event.key
                        && hotkey.modifiers.matches(event.modifiers)
                } else {
                    held.contains(id)
                        && match event.key {
                            Some(_) => hotkey.key == event.key,
                            None => !hotkey.modifiers.matches(event.modifiers),
                        }
                };
                if !fires {
                    continue;
                }
                if event.is_key_down {
                    held.insert(id.clone());
                } else {
                    held.remove(id);
                }
                send(&notify, &json!({"id": id, "pressed": event.is_key_down}));
            }
        }
    });
    Ok(listening)
}

#[cfg(target_os = "linux")]
async fn portal_shortcuts(
    bindings: &[CallShortcutBinding],
    app_id: &str,
    notify: &Callback,
) -> ashpd::Result<()> {
    use ashpd::desktop::{
        CreateSessionOptions,
        global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut},
    };
    use futures_util::StreamExt;

    // A dedicated bus connection also closes the session when registration is cancelled.
    let connection = ashpd::zbus::Connection::session().await?;
    if let Err(error) =
        ashpd::register_host_app_with_connection(connection.clone(), app_id.parse()?).await
    {
        tracing::debug!(%error, "portal app registry unavailable");
    }
    let portal = GlobalShortcuts::with_connection(connection).await?;
    let session = portal
        .create_session(CreateSessionOptions::default())
        .await?;
    let session_handle = serde_json::to_value(&session)
        .map_err(|error| ashpd::Error::IO(std::io::Error::other(error)))?;
    let mut activated = portal.receive_activated().await?;
    let mut deactivated = portal.receive_deactivated().await?;
    let mut closed = session.receive_closed().await?;
    let shortcuts: Vec<_> = bindings
        .iter()
        .map(|b| NewShortcut::new(&b.id, &b.description).preferred_trigger(b.trigger.as_str()))
        .collect();
    let response = portal
        .bind_shortcuts(&session, &shortcuts, None, BindShortcutsOptions::default())
        .await?
        .response()?;
    if bindings
        .iter()
        .any(|b| !response.shortcuts().iter().any(|s| s.id() == b.id))
    {
        session.close().await?;
        return Err(ashpd::Error::Portal(ashpd::PortalError::Failed(
            "Call shortcuts were not granted".into(),
        )));
    }
    send(notify, &json!({"status": "ready"}));
    loop {
        tokio::select! {
            event = activated.next() => {
                let Some(event) = event else { break; };
                if session_handle.as_str() == Some(event.session_handle().as_str()) && bindings.iter().any(|b| b.id == event.shortcut_id()) {
                    send(notify, &json!({"id": event.shortcut_id(), "pressed": true}));
                }
            }
            event = deactivated.next() => {
                let Some(event) = event else { break; };
                if session_handle.as_str() == Some(event.session_handle().as_str()) && bindings.iter().any(|b| b.id == event.shortcut_id()) {
                    send(notify, &json!({"id": event.shortcut_id(), "pressed": false}));
                }
            }
            _ = closed.next() => break,
        }
    }
    send(
        notify,
        &json!({"status": "error", "error": "Desktop shortcut session ended"}),
    );
    let _ = session.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn passive_bindings_from_electron_parse() {
        for binding in [
            "CTRL+SHIFT+t",
            "SUPER+SHIFT+m",
            "ALT+space",
            "keypad0",
            "keypadplus",
            "f13",
            "`",
            "CTRL+\\",
            "'",
            "up",
            "return",
            "backspace",
        ] {
            assert!(
                binding.parse::<handy_keys::Hotkey>().is_ok(),
                "{binding} should parse"
            );
        }
    }
}
