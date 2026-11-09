//! Android drops stdout, so the webview's debug log is the only place a tester can read core lines.

use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use tauri::ipc::Channel;

const FLUSH_EVERY: Duration = Duration::from_millis(250);
const MAX_PENDING: usize = 500;

static CAPTURING: AtomicBool = AtomicBool::new(false);
static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());
static CHANNEL: Mutex<Option<Channel<Vec<String>>>> = Mutex::new(None);

pub(crate) struct MakeDebugLogWriter;

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for MakeDebugLogWriter {
    type Writer = DebugLogWriter;

    fn make_writer(&'a self) -> Self::Writer {
        DebugLogWriter {
            capturing: CAPTURING.load(Ordering::Relaxed),
            line: String::new(),
        }
    }
}

pub(crate) struct DebugLogWriter {
    capturing: bool,
    line: String,
}

impl Write for DebugLogWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.capturing {
            self.line.push_str(&String::from_utf8_lossy(bytes));
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for DebugLogWriter {
    fn drop(&mut self) {
        let line = self.line.trim_end();
        if line.is_empty() {
            return;
        }
        let mut pending = PENDING.lock().unwrap_or_else(PoisonError::into_inner);
        if pending.len() < MAX_PENDING {
            pending.push(line.to_owned());
        }
    }
}

#[tauri::command]
pub(crate) fn set_debug_logs(enabled: bool, channel: Channel<Vec<String>>) {
    if !enabled {
        detach();
        return;
    }
    *CHANNEL.lock().unwrap_or_else(PoisonError::into_inner) = Some(channel);
    if !CAPTURING.swap(true, Ordering::SeqCst) {
        tauri::async_runtime::spawn(forward());
    }
}

pub(crate) fn detach() {
    *CHANNEL.lock().unwrap_or_else(PoisonError::into_inner) = None;
    CAPTURING.store(false, Ordering::SeqCst);
    PENDING
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clear();
}

async fn forward() {
    while CAPTURING.load(Ordering::SeqCst) {
        tokio::time::sleep(FLUSH_EVERY).await;
        let batch = std::mem::take(&mut *PENDING.lock().unwrap_or_else(PoisonError::into_inner));
        if batch.is_empty() {
            continue;
        }
        let channel = CHANNEL
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(channel) = channel {
            let _ = channel.send(batch);
        }
    }
}
