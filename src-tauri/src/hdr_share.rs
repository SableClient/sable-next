use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use sable_hdr::linux::HdrCapture;
use serde::Serialize;
use tauri::ipc::{Channel, Response};
use zbus::zvariant::OwnedValue;

const BT2100: u32 = 1;

type Properties = HashMap<String, OwnedValue>;
type Connector = (String, String, String, String);
type Mode = (String, i32, i32, f64, f64, Vec<f64>, Properties);
type Monitor = (Connector, Vec<Mode>, Properties);
type LogicalMonitor = (i32, i32, f64, u32, bool, Vec<Connector>, Properties);
type State = (u32, Vec<Monitor>, Vec<LogicalMonitor>, Properties);

#[derive(Serialize)]
pub struct HdrMonitor {
    index: usize,
    name: String,
    hdr: bool,
}

static SHARE: Mutex<Option<(HdrCapture, Arc<AtomicBool>)>> = Mutex::new(None);

pub fn monitors() -> Vec<HdrMonitor> {
    let state = zbus::blocking::Connection::session().and_then(|connection| {
        zbus::blocking::Proxy::new(
            &connection,
            "org.gnome.Mutter.DisplayConfig",
            "/org/gnome/Mutter/DisplayConfig",
            "org.gnome.Mutter.DisplayConfig",
        )?
        .call::<_, _, State>("GetCurrentState", &())
    });
    let Ok((_, monitors, _, _)) = state else {
        return Vec::new();
    };
    monitors
        .into_iter()
        .enumerate()
        .map(|(index, ((connector, ..), _, properties))| HdrMonitor {
            index,
            name: properties
                .get("display-name")
                .and_then(|name| String::try_from(name.clone()).ok())
                .unwrap_or(connector),
            hdr: properties
                .get("color-mode")
                .and_then(|mode| u32::try_from(mode).ok())
                == Some(BT2100),
        })
        .collect()
}

pub async fn start(frames: Channel<Response>) -> Result<(), String> {
    let busy = Arc::new(AtomicBool::new(false));
    let sink_busy = Arc::clone(&busy);
    let capture = HdrCapture::start(Box::new(move |width, height, frame| {
        if frame.is_empty() {
            if frames.send(Response::new(Vec::new())).is_err() {
                log::debug!("the page had already closed the HDR share");
            }
            return;
        }
        if sink_busy.swap(true, Ordering::AcqRel) {
            return;
        }
        let mut message = Vec::with_capacity(8 + frame.len());
        message.extend_from_slice(&width.to_le_bytes());
        message.extend_from_slice(&height.to_le_bytes());
        message.extend_from_slice(frame);
        if frames.send(Response::new(message)).is_err() {
            sink_busy.store(false, Ordering::Release);
        }
    }))
    .await?;
    *SHARE.lock().unwrap_or_else(PoisonError::into_inner) = Some((capture, busy));
    Ok(())
}

pub fn release() {
    if let Some((_, busy)) = SHARE
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
    {
        busy.store(false, Ordering::Release);
    }
}

pub fn stop() {
    let share = SHARE.lock().unwrap_or_else(PoisonError::into_inner).take();
    if let Some((capture, _)) = share {
        capture.stop();
    }
}

#[cfg(test)]
mod tests {
    use zbus::zvariant::Type;

    use super::State;

    #[test]
    fn the_reply_matches_mutters_get_current_state() {
        assert_eq!(
            State::SIGNATURE.to_string(),
            "(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})"
        );
    }
}
