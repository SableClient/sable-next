use std::sync::{Mutex, PoisonError};

use tauri::ipc::{Channel, Response};

use crate::capture::{Capture, Selection};

pub use crate::capture::list_apps;

static SESSION: Mutex<Option<Capture>> = Mutex::new(None);

/// # Errors
///
/// Fails when the selection cannot be captured.
pub fn start(selection: &Selection, frames: Channel<Response>) -> Result<(), String> {
    stop();
    let capture = Capture::start(
        selection,
        Box::new(move |chunk| frames.send(Response::new(chunk.to_vec())).is_ok()),
    )?;
    *SESSION.lock().unwrap_or_else(PoisonError::into_inner) = Some(capture);
    Ok(())
}

pub fn stop() {
    let capture = SESSION
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    if let Some(capture) = capture {
        capture.stop();
    }
}
