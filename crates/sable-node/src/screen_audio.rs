use std::sync::{Mutex, PoisonError};

use napi::{
    Status,
    bindgen_prelude::Buffer,
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use sable_loopback::capture::{Capture, Selection};

// Drop PCM when the JS queue is full instead of blocking capture.
type Frames = ThreadsafeFunction<Buffer, (), Buffer, Status, false, true, 8>;

static SESSION: Mutex<Option<Capture>> = Mutex::new(None);

#[napi]
pub(crate) fn start_screen_audio(audio_pid: u32, frames: Frames) -> napi::Result<()> {
    if audio_pid == 0 {
        return Err(napi::Error::from_reason("invalid audio process"));
    }
    stop_screen_audio();
    let selection = Selection::System { exclude: vec![] };
    let capture = Capture::start(
        &selection,
        audio_pid,
        Box::new(move |chunk| {
            matches!(
                frames.call(
                    Buffer::from(chunk.to_vec()),
                    ThreadsafeFunctionCallMode::NonBlocking
                ),
                Status::Ok | Status::QueueFull
            )
        }),
    )
    .map_err(napi::Error::from_reason)?;
    *SESSION.lock().unwrap_or_else(PoisonError::into_inner) = Some(capture);
    Ok(())
}

#[napi]
pub(crate) fn stop_screen_audio() {
    let capture = SESSION
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    if let Some(capture) = capture {
        capture.stop();
    }
}
