use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

use sysinfo::{ProcessesToUpdate, System};
use wasapi::{
    AudioClient, DeviceEnumerator, Direction, SampleType, SessionState, StreamMode, WaveFormat,
    deinitialize, initialize_mta,
};

use crate::pcm::{BYTES_PER_FRAME, CHANNELS, Chunker, SAMPLE_RATE};
use crate::process::{Process, app_name, descends_from, tree_root};

const READY_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_MS: u32 = 50;
const BUFFER_DURATION_HNS: i64 = 100 * 1000 * 10;
const MAX_PACKET_FRAMES: usize = 16_384;

pub type Sink = Box<dyn FnMut(&[u8]) -> bool + Send>;

#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(
    feature = "tauri",
    derive(serde::Deserialize),
    serde(tag = "kind", rename_all = "lowercase")
)]
pub enum Selection {
    System { exclude: Vec<String> },
    Apps { include: Vec<String> },
}

enum Mode {
    ExcludeSable(u32),
    IncludeApp(u32),
}

pub struct Capture {
    stopped: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

struct Com;

impl Com {
    fn enter() -> Result<Self, String> {
        initialize_mta().ok().map_err(|error| error.to_string())?;
        Ok(Self)
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        deinitialize();
    }
}

fn processes() -> HashMap<u32, Process> {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    system
        .processes()
        .iter()
        .map(|(pid, process)| {
            (
                pid.as_u32(),
                Process {
                    parent: process.parent().map(sysinfo::Pid::as_u32),
                    name: process.name().to_string_lossy().into_owned(),
                },
            )
        })
        .collect()
}

fn playing_pids() -> Result<Vec<u32>, String> {
    let enumerator = DeviceEnumerator::new().map_err(|error| error.to_string())?;
    let devices = enumerator
        .get_device_collection(&Direction::Render)
        .map_err(|error| error.to_string())?;
    let count = devices
        .get_nbr_devices()
        .map_err(|error| error.to_string())?;
    let mut pids = Vec::new();
    for index in 0..count {
        let sessions = devices
            .get_device_at_index(index)
            .and_then(|device| device.get_iaudiosessionmanager())
            .and_then(|manager| manager.get_audiosessionenumerator());
        let sessions = match sessions {
            Ok(sessions) => sessions,
            Err(error) => {
                log::debug!("skipping an audio device: {error}");
                continue;
            }
        };
        let total = sessions.get_count().map_err(|error| error.to_string())?;
        for session in 0..total {
            let Ok(session) = sessions.get_session(session) else {
                continue;
            };
            if session.get_state().ok() != Some(SessionState::Active) {
                continue;
            }
            if let Ok(pid) = session.get_process_id()
                && pid != 0
            {
                pids.push(pid);
            }
        }
    }
    Ok(pids)
}

fn on_thread<T: Send + 'static>(
    name: &str,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let _com = Com::enter()?;
            work()
        })
        .map_err(|error| error.to_string())?
        .join()
        .map_err(|_| format!("{name} thread panicked"))?
}

/// # Errors
///
/// Fails when Windows will not enumerate its audio devices.
pub fn list_apps() -> Result<Vec<String>, String> {
    on_thread("screen-audio-list", || {
        let table = processes();
        let own = std::process::id();
        let apps: BTreeSet<String> = playing_pids()?
            .into_iter()
            .filter(|&pid| pid != own && !descends_from(pid, own, &table))
            .filter_map(|pid| table.get(&pid))
            .map(|process| app_name(&process.name).to_owned())
            .collect();
        Ok(apps.into_iter().collect())
    })
}

fn resolve(selection: &Selection) -> Result<Mode, String> {
    match selection {
        Selection::System { .. } => Ok(Mode::ExcludeSable(std::process::id())),
        Selection::Apps { include } => {
            let [name] = include.as_slice() else {
                return Err("Windows can share the sound of one application at a time".to_owned());
            };
            let table = processes();
            table
                .iter()
                .filter(|(_, process)| app_name(&process.name).eq_ignore_ascii_case(name))
                .map(|(&pid, _)| tree_root(pid, &table))
                .min()
                .map(Mode::IncludeApp)
                .ok_or_else(|| format!("{name} is not running"))
        }
    }
}

fn run(
    mode: &Mode,
    stopped: &AtomicBool,
    sink: &mut Sink,
    ready: &mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let describe = |error: wasapi::WasapiError| error.to_string();
    let (pid, include) = match *mode {
        Mode::ExcludeSable(pid) => (pid, false),
        Mode::IncludeApp(pid) => (pid, true),
    };
    let mut client =
        AudioClient::new_application_loopback_client(pid, include).map_err(describe)?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, CHANNELS, None);
    client
        .initialize_client(
            &format,
            &Direction::Capture,
            &StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: BUFFER_DURATION_HNS,
            },
        )
        .map_err(describe)?;
    let event = client.set_get_eventhandle().map_err(describe)?;
    let capture = client.get_audiocaptureclient().map_err(describe)?;
    client.start_stream().map_err(describe)?;
    let _ = ready.send(Ok(()));

    let mut buffer = vec![0u8; MAX_PACKET_FRAMES * BYTES_PER_FRAME];
    let mut chunker = Chunker::default();
    let mut listening = true;
    while listening && !stopped.load(Ordering::Acquire) {
        let _ = event.wait_for_event(POLL_MS);
        loop {
            let frames = capture
                .get_next_packet_size()
                .map_err(describe)?
                .unwrap_or(0);
            if frames == 0 {
                break;
            }
            let (read, info) = capture.read_from_device(&mut buffer).map_err(describe)?;
            let Some(data) = buffer.get_mut(..read as usize * BYTES_PER_FRAME) else {
                break;
            };
            if info.flags.silent {
                data.fill(0);
            }
            chunker.push(data, |chunk| listening &= sink(chunk));
        }
    }
    client.stop_stream().map_err(describe)
}

impl Capture {
    /// # Errors
    ///
    /// Fails when the application is not running or Windows refuses the
    /// loopback.
    pub fn start(selection: &Selection, mut sink: Sink) -> Result<Self, String> {
        let mode = resolve(selection)?;
        let stopped = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stopped);
        let (ready, answer) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("screen-audio".into())
            .spawn(move || {
                let outcome = Com::enter().and_then(|_com| run(&mode, &flag, &mut sink, &ready));
                if let Err(error) = outcome {
                    log::warn!("screen audio capture ended: {error}");
                    let _ = ready.send(Err(error));
                    sink(&[]);
                }
            })
            .map_err(|error| error.to_string())?;
        match answer.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(())) => Ok(Self { stopped, thread }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                stopped.store(true, Ordering::Release);
                let _ = thread.join();
                Err("Windows did not start the audio capture".to_owned())
            }
        }
    }

    pub fn stop(self) {
        self.stopped.store(true, Ordering::Release);
        let _ = self.thread.join();
    }
}
