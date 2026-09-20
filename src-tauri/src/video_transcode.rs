//! Re-encodes video attachments CEF cannot decode, through the system ffmpeg.

use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use ffmpeg_sidecar::{command::FfmpegCommand, event::FfmpegEvent, event::LogLevel};
use sable_core::protocol::CommandErr;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime, ipc::Channel, ipc::Response};

pub const STREAM_MIME: &str = r#"video/mp4; codecs="vp09.00.10.08,opus""#;

const CACHE_SUBDIR: &str = "sable-video";
const CACHE_TTL: Duration = Duration::from_hours(24 * 30);
const CHUNK: usize = 64 * 1024;

static LANE: Mutex<()> = Mutex::new(());

const ENCODE_ARGS: &[&str] = &[
    "-c:v",
    "libvpx-vp9",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "-row-mt",
    "1",
    "-g",
    "48",
    "-b:v",
    "2M",
    "-c:a",
    "libopus",
    "-f",
    "mp4",
    "-movflags",
    "+frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration",
    "1000000",
];

/// # Errors
///
/// [`CommandErr::Unsupported`] when no ffmpeg is installed,
/// [`CommandErr::InvalidMedia`] when it rejects the input,
/// [`CommandErr::Unavailable`] for cache IO failures.
pub fn stream_to<R: Runtime>(
    app: &AppHandle<R>,
    source: &str,
    input: &[u8],
    chunks: &Channel<Response>,
) -> Result<(), CommandErr> {
    let dir = cache_dir(app)?;
    let key = hex(&Sha256::digest(source.as_bytes()));
    let cached = dir.join(format!("{key}.mp4"));

    if is_fresh(&cached) {
        return replay(&cached, chunks);
    }

    let _lane = LANE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if is_fresh(&cached) {
        return replay(&cached, chunks);
    }

    fs::create_dir_all(&dir).map_err(|_| CommandErr::Unavailable)?;
    let source_path = dir.join(format!("{key}.src"));
    fs::write(&source_path, input).map_err(|_| CommandErr::Unavailable)?;
    let partial = dir.join(format!("{key}.part"));

    let encoded = encode(&source_path, &partial, chunks);
    let _ = fs::remove_file(&source_path);

    match encoded {
        Ok(()) => {
            if fs::rename(&partial, &cached).is_err() {
                let _ = fs::remove_file(&partial);
            }
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&partial);
            Err(error)
        }
    }
}

fn replay(path: &Path, chunks: &Channel<Response>) -> Result<(), CommandErr> {
    let mut file = File::open(path).map_err(|_| CommandErr::Unavailable)?;
    let mut buffer = vec![0_u8; CHUNK];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| CommandErr::Unavailable)?;
        let Some(chunk) = buffer.get(..read).filter(|chunk| !chunk.is_empty()) else {
            return Ok(());
        };
        if chunks.send(Response::new(chunk.to_vec())).is_err() {
            return Ok(());
        }
    }
}

fn encode(source: &Path, partial: &Path, chunks: &Channel<Response>) -> Result<(), CommandErr> {
    let mut child = FfmpegCommand::new()
        .arg("-y")
        .input(source.to_string_lossy())
        .args(ENCODE_ARGS)
        .pipe_stdout()
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                CommandErr::Unsupported
            } else {
                CommandErr::Unavailable
            }
        })?;

    let events = child.iter().map_err(|_| CommandErr::Unavailable)?;
    let mut sink = File::create(partial).ok();
    let mut problems: Vec<String> = Vec::new();
    let mut sent = 0_usize;
    let mut cancelled = false;

    for event in events {
        match event {
            FfmpegEvent::OutputChunk(chunk) => {
                if let Some(file) = sink.as_mut()
                    && file.write_all(&chunk).is_err()
                {
                    sink = None;
                }
                sent += chunk.len();
                if chunks.send(Response::new(chunk)).is_err() {
                    cancelled = true;
                    break;
                }
            }
            FfmpegEvent::Error(message) | FfmpegEvent::Log(LogLevel::Error, message) => {
                problems.push(message);
            }
            FfmpegEvent::Done => break,
            _ => {}
        }
    }

    if cancelled {
        tracing::debug!(bytes = sent, "renderer dropped the video stream");
        let _ = child.kill();
        let _ = child.wait();
        return Err(CommandErr::Unavailable);
    }

    let finished = child.wait().is_ok_and(|status| status.success());
    if !finished || sink.is_none() || sent == 0 {
        tracing::warn!(bytes = sent, ?problems, "video re-encode failed");
        return Err(CommandErr::InvalidMedia);
    }
    tracing::info!(bytes = sent, "video re-encode complete");
    Ok(())
}

pub fn cleanup_cache<R: Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = cache_dir(app) else { return };
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(entries) = fs::read_dir(&dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && !is_fresh(&path) {
                let _ = fs::remove_file(path);
            }
        }
    });
}

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, CommandErr> {
    app.path()
        .app_cache_dir()
        .map(|dir| dir.join(CACHE_SUBDIR))
        .map_err(|_| CommandErr::Unavailable)
}

fn is_fresh(path: &Path) -> bool {
    let Ok(modified) = fs::metadata(path).and_then(|meta| meta.modified()) else {
        return false;
    };
    modified.elapsed().is_ok_and(|age| age < CACHE_TTL)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

#[cfg(test)]
mod tests {
    use super::{ENCODE_ARGS, STREAM_MIME, hex};

    #[test]
    fn hex_pads_each_byte() {
        assert_eq!(hex(&[0x00, 0x0f, 0xff]), "000fff");
    }

    #[test]
    fn the_advertised_mime_matches_what_is_encoded() {
        assert!(STREAM_MIME.starts_with("video/mp4"));
        assert!(STREAM_MIME.contains("vp09"));
        assert!(STREAM_MIME.contains("opus"));
        assert!(ENCODE_ARGS.contains(&"libvpx-vp9"));
        assert!(ENCODE_ARGS.contains(&"libopus"));
        assert!(ENCODE_ARGS.contains(&"+frag_keyframe+empty_moov+default_base_moof"));
    }
}
