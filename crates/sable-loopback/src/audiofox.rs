use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, PoisonError, mpsc};
use std::thread::JoinHandle;

use audiofox::{AudioManager, AudioSource};
use sysinfo::{ProcessesToUpdate, System};

use crate::process::{Process, descends_from};

pub type Sink = Box<dyn FnMut(&[u8]) -> bool + Send>;
const PREFIX: &str = "audiofox:";

struct Session {
    stop: mpsc::Sender<()>,
    thread: JoinHandle<()>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn process_table() -> Result<HashMap<u32, Process>, String> {
    let mut system = System::new().map_err(|error| error.to_string())?;
    system.refresh_processes(ProcessesToUpdate::All, true);
    Ok(system
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
        .collect())
}

fn is_own(pid: u32, root_pid: u32, processes: &HashMap<u32, Process>) -> bool {
    [std::process::id(), root_pid]
        .into_iter()
        .filter(|root| *root != 0)
        .any(|root| {
            pid == root
                || descends_from(pid, root, processes)
                || descends_from(root, pid, processes)
        })
}

fn sources(manager: &AudioManager, root_pid: u32) -> Result<Vec<AudioSource>, String> {
    let processes = process_table()?;
    let sources = manager.list().map_err(|error| error.to_string())?;
    #[cfg(target_os = "linux")]
    let allowed = linux_sources(root_pid, &processes)?;
    let blocked: HashSet<_> = sources
        .iter()
        .filter(|source| {
            #[cfg(target_os = "linux")]
            {
                allowed
                    .get(source.name.as_ref())
                    .is_none_or(|ids| source.id.iter().any(|id| !ids.contains(id)))
            }
            #[cfg(not(target_os = "linux"))]
            {
                source
                    .id
                    .iter()
                    .any(|pid| is_own(*pid, root_pid, &processes))
            }
        })
        .map(|source| source.name.to_string())
        .collect();
    Ok(sources
        .into_iter()
        .filter(|source| !blocked.contains(source.name.as_ref()))
        .collect())
}

/// # Errors
/// Returns an error if Audiofox cannot enumerate application sources.
pub fn list_apps(root_pid: u32) -> Result<Vec<String>, String> {
    std::thread::spawn(move || {
        let manager = audiofox::start().map_err(|error| error.to_string())?;
        Ok(sources(&manager, root_pid)?
            .iter()
            .map(|source| format!("{PREFIX}{}", source.name))
            .collect())
    })
    .join()
    .map_err(|_| "Audiofox listing thread panicked".to_owned())?
}

fn resolve(sources: Vec<AudioSource>, include: &[String]) -> Result<Vec<AudioSource>, String> {
    let names: HashSet<_> = include
        .iter()
        .filter_map(|id| id.strip_prefix(PREFIX))
        .collect();
    if names.is_empty() || include.iter().any(|id| !id.starts_with(PREFIX)) {
        return Err("Select the applications again".to_owned());
    }
    let selected: Vec<_> = sources
        .into_iter()
        .filter(|source| names.contains(source.name.as_ref()))
        .collect();
    if selected
        .iter()
        .map(|source| source.name.as_ref())
        .collect::<HashSet<_>>()
        .len()
        != names.len()
    {
        return Err("An audio source is no longer available".to_owned());
    }
    Ok(selected)
}

/// # Errors
/// Returns an error if a selected application cannot be captured.
pub fn start(include: Vec<String>, root_pid: u32, sink: Sink) -> Result<(), String> {
    let mut session = SESSION.lock().unwrap_or_else(PoisonError::into_inner);
    stop_session(session.take());
    let (stop, stopped) = mpsc::channel();
    let (ready, answer) = mpsc::channel();
    let capture_stop = stop.clone();
    let sink = Arc::new(Mutex::new(sink));
    let thread = std::thread::Builder::new()
        .name("audiofox".into())
        .spawn(move || {
            let run = || -> Result<(), String> {
                let manager = audiofox::start().map_err(|error| error.to_string())?;
                let selected = resolve(sources(&manager, root_pid)?, &include)?;
                let sink = sink.clone();
                let _link = manager
                    .link(
                        &selected,
                        move |chunk| {
                            let bytes: Vec<u8> = chunk
                                .iter()
                                .flat_map(|sample| sample.to_le_bytes())
                                .collect();
                            if !sink.lock().unwrap_or_else(PoisonError::into_inner)(&bytes) {
                                let _ = capture_stop.send(());
                            }
                        },
                        960,
                    )
                    .map_err(|error| error.to_string())?;
                let _ = ready.send(Ok(()));
                let _ = stopped.recv();
                Ok(())
            };
            if let Err(error) = run() {
                log::warn!("audio capture ended: {error}");
                let _ = ready.send(Err(error));
                sink.lock().unwrap_or_else(PoisonError::into_inner)(&[]);
            }
        })
        .map_err(|error| error.to_string())?;
    let started = answer
        .recv()
        .map_err(|error| error.to_string())
        .and_then(|result| result);
    match started {
        Ok(()) => {
            *session = Some(Session { stop, thread });
            Ok(())
        }
        Err(error) => {
            stop_session(Some(Session { stop, thread }));
            Err(error)
        }
    }
}

fn stop_session(session: Option<Session>) {
    if let Some(session) = session {
        let _ = session.stop.send(());
        let _ = session.thread.join();
    }
}

pub fn stop() {
    let mut session = SESSION.lock().unwrap_or_else(PoisonError::into_inner);
    stop_session(session.take());
}

#[cfg(target_os = "linux")]
struct LinuxNode {
    name: String,
    pid: Option<u32>,
    client: Option<u32>,
    relay: bool,
}

#[cfg(target_os = "linux")]
fn linux_sources(
    root_pid: u32,
    processes: &HashMap<u32, Process>,
) -> Result<HashMap<String, HashSet<u32>>, String> {
    use pipewire as pw;
    use std::cell::RefCell;
    use std::rc::Rc;
    pw::init();
    let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(|error| error.to_string())?;
    let context =
        pw::context::ContextRc::new(&mainloop, None).map_err(|error| error.to_string())?;
    let core = context
        .connect_rc(None)
        .map_err(|error| error.to_string())?;
    let registry = core.get_registry_rc().map_err(|error| error.to_string())?;
    let nodes = Rc::new(RefCell::new(HashMap::new()));
    let clients = Rc::new(RefCell::new(HashMap::new()));
    let watched = Rc::new(RefCell::new(Vec::new()));
    let watched_clients = Rc::new(RefCell::new(Vec::new()));
    let _listener = registry
        .add_listener_local()
        .global({
            let nodes = nodes.clone();
            let clients = clients.clone();
            let registry = registry.clone();
            move |global| {
                if global.type_ == pw::types::ObjectType::Client {
                    let Ok(client) = registry.bind::<pw::client::Client, _>(global) else {
                        return;
                    };
                    let clients = clients.clone();
                    let id = global.id;
                    let listener = client
                        .add_listener_local()
                        .info(move |info| {
                            if let Some(pid) = info
                                .props()
                                .and_then(|props| {
                                    props
                                        .get("pipewire.sec.pid")
                                        .or_else(|| props.get("application.process.id"))
                                })
                                .and_then(|pid| pid.parse::<u32>().ok())
                            {
                                clients.borrow_mut().insert(id, pid);
                            }
                        })
                        .register();
                    watched_clients.borrow_mut().push((client, listener));
                    return;
                }
                if global.type_ != pw::types::ObjectType::Node
                    || global.props.and_then(|props| props.get("media.class"))
                        != Some("Stream/Output/Audio")
                {
                    return;
                }
                let Ok(node) = registry.bind::<pw::node::Node, _>(global) else {
                    return;
                };
                let nodes = nodes.clone();
                let id = global.id;
                let listener = node
                    .add_listener_local()
                    .info(move |info| {
                        let Some(props) = info.props() else {
                            return;
                        };
                        let Some(name) = props.get("node.name") else {
                            return;
                        };
                        let pid = props
                            .get("pipewire.sec.pid")
                            .or_else(|| props.get("application.process.id"))
                            .and_then(|pid| pid.parse().ok());
                        nodes.borrow_mut().insert(
                            id,
                            LinuxNode {
                                name: name.to_owned(),
                                pid,
                                client: props.get("client.id").and_then(|id| id.parse().ok()),
                                relay: props.get("node.link-group").is_some(),
                            },
                        );
                    })
                    .register();
                watched.borrow_mut().push((node, listener));
            }
        })
        .register();
    sync_linux_registry(&mainloop, &core)?;
    Ok(filter_linux_sources(
        root_pid,
        processes,
        &nodes.borrow(),
        &clients.borrow(),
    ))
}

#[cfg(target_os = "linux")]
fn sync_linux_registry(
    mainloop: &pipewire::main_loop::MainLoopRc,
    core: &pipewire::core::CoreRc,
) -> Result<(), String> {
    use std::cell::Cell;
    use std::rc::Rc;

    for _ in 0..2 {
        let done = Rc::new(Cell::new(false));
        let pending = core.sync(0).map_err(|error| error.to_string())?;
        let _done = core
            .add_listener_local()
            .done({
                let done = done.clone();
                let mainloop = mainloop.clone();
                move |id, seq| {
                    if id == pipewire::core::PW_ID_CORE && seq == pending {
                        done.set(true);
                        mainloop.quit();
                    }
                }
            })
            .register();
        while !done.get() {
            mainloop.run();
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn filter_linux_sources(
    root_pid: u32,
    processes: &HashMap<u32, Process>,
    nodes: &HashMap<u32, LinuxNode>,
    clients: &HashMap<u32, u32>,
) -> HashMap<String, HashSet<u32>> {
    let mut names: HashMap<String, HashSet<u32>> = HashMap::new();
    let mut blocked = HashSet::new();
    for (id, node) in nodes {
        let pid = node
            .pid
            .or_else(|| node.client.and_then(|id| clients.get(&id).copied()));
        if node.relay || pid.is_none_or(|pid| is_own(pid, root_pid, processes)) {
            blocked.insert(node.name.clone());
        } else {
            names.entry(node.name.clone()).or_default().insert(*id);
        }
    }
    names.retain(|name, _| !blocked.contains(name));
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn source(name: &str) -> AudioSource {
        AudioSource {
            id: 123.into(),
            name: name.into(),
        }
    }
    #[test]
    fn missing_or_legacy_selections_never_broaden_capture() {
        resolve(vec![source("music")], &["music".into()]).unwrap_err();
        resolve(vec![source("music")], &["audiofox:missing".into()]).unwrap_err();
        resolve(vec![source("music")], &[]).unwrap_err();
        assert_eq!(
            resolve(
                vec![source("music"), source("call")],
                &["audiofox:music".into()]
            )
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    #[ignore = "requires a playing app named by SABLE_AUDIOFOX_TEST_SOURCE"]
    fn captures_selected_application_and_stops() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let name = std::env::var("SABLE_AUDIOFOX_TEST_SOURCE").unwrap();
        let id = format!("{PREFIX}{name}");
        assert!(list_apps(0).unwrap().contains(&id));
        let callbacks = Arc::new(AtomicUsize::new(0));
        let count = callbacks.clone();
        let (samples, received) = mpsc::channel();
        start(
            vec![id],
            0,
            Box::new(move |chunk| {
                count.fetch_add(1, Ordering::SeqCst);
                if chunk
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .any(|sample| f32::from_le_bytes(*sample).abs() > 0.001)
                {
                    let _ = samples.send(());
                }
                true
            }),
        )
        .unwrap();
        let result = received.recv_timeout(Duration::from_secs(5));
        stop();
        result.unwrap();
        let stopped = callbacks.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(callbacks.load(Ordering::SeqCst), stopped);
    }
}
