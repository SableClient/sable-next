//! The desktop app's side of an HDR share: capture on a worker thread, a
//! shared-buffer ring on the webview thread, and one event per ready frame.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::webview2::{Ring, SLOTS};
use crate::windows::{HdrCapture, monitors};

pub const FRAME_EVENT: &str = "hdr-frame";

#[derive(Serialize)]
pub struct HdrMonitor {
    index: usize,
    name: String,
    hdr: bool,
}

#[derive(Clone, Serialize)]
struct FrameReady {
    slot: usize,
    width: u32,
    height: u32,
    generation: u32,
}

#[derive(Default)]
struct Shared {
    ring: Mutex<Option<Ring>>,
    busy: Mutex<[bool; SLOTS]>,
    allocating: AtomicBool,
    generation: AtomicU32,
}

static SHARE: Mutex<Option<(HdrCapture, Arc<Shared>)>> = Mutex::new(None);

#[must_use]
pub fn list() -> Vec<HdrMonitor> {
    monitors()
        .into_iter()
        .map(|monitor| HdrMonitor {
            index: monitor.index,
            name: monitor.name,
            hdr: monitor.hdr,
        })
        .collect()
}

fn allocate(app: &AppHandle<Wry>, shared: &Arc<Shared>, width: u32, height: u32) {
    if shared.allocating.swap(true, Ordering::AcqRel) {
        return;
    }
    let generation = shared.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let Some(window) = app.get_webview_window("main") else {
        shared.allocating.store(false, Ordering::Release);
        return;
    };
    let target = Arc::clone(shared);
    let posted = window.with_webview(move |platform| {
        let ring = Ring::create(
            &platform.environment(),
            &platform.controller(),
            width,
            height,
            generation,
        );
        match ring {
            Ok(ring) => {
                *target.busy.lock().unwrap_or_else(PoisonError::into_inner) = [false; SLOTS];
                *target.ring.lock().unwrap_or_else(PoisonError::into_inner) = Some(ring);
            }
            Err(error) => log::warn!("could not share HDR frames with the page: {error}"),
        }
        target.allocating.store(false, Ordering::Release);
    });
    if posted.is_err() {
        shared.allocating.store(false, Ordering::Release);
    }
}

fn deliver(app: &AppHandle<Wry>, shared: &Arc<Shared>, width: u32, height: u32, frame: &[u8]) {
    let guard = shared.ring.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(ring) = guard
        .as_ref()
        .filter(|ring| ring.width == width && ring.height == height)
    else {
        drop(guard);
        allocate(app, shared, width, height);
        return;
    };
    let slot = {
        let mut busy = shared.busy.lock().unwrap_or_else(PoisonError::into_inner);
        let Some((slot, taken)) = busy.iter_mut().enumerate().find(|(_, taken)| !**taken) else {
            return;
        };
        *taken = true;
        slot
    };
    let written = ring.write(slot, frame);
    let generation = ring.generation;
    drop(guard);
    if !written {
        if let Some(taken) = shared
            .busy
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_mut(slot)
        {
            *taken = false;
        }
        return;
    }
    let ready = FrameReady {
        slot,
        width,
        height,
        generation,
    };
    if let Err(error) = app.emit(FRAME_EVENT, ready) {
        log::debug!("could not announce an HDR frame: {error}");
    }
}

/// Starts capturing monitor `index`, replacing any share already running.
///
/// # Errors
///
/// Fails when the monitor does not exist or Windows refuses the capture.
pub fn start(app: AppHandle<Wry>, index: usize) -> Result<(), String> {
    stop();
    let shared = Arc::new(Shared::default());
    let sink_shared = Arc::clone(&shared);
    let capture = HdrCapture::start(
        index,
        Box::new(move |width, height, frame| deliver(&app, &sink_shared, width, height, frame)),
    )?;
    *SHARE.lock().unwrap_or_else(PoisonError::into_inner) = Some((capture, shared));
    Ok(())
}

pub fn release(slot: usize) {
    if let Some((_, shared)) = SHARE
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        && let Some(taken) = shared
            .busy
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_mut(slot)
    {
        *taken = false;
    }
}

pub fn stop() {
    let share = SHARE.lock().unwrap_or_else(PoisonError::into_inner).take();
    if let Some((capture, _)) = share
        && let Err(error) = capture.stop()
    {
        log::warn!("HDR capture did not stop cleanly: {error}");
    }
}
