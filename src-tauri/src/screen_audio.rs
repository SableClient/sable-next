use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

use pipewire as pw;
use pw::spa::utils::dict::DictRef;
use pw::types::ObjectType;
use serde::Deserialize;

const SELF_MARKER_KEY: &str = "sable.screen-audio.exclude";
pub const SELF_MARKER: &str = "sable.screen-audio.exclude=1";
const NODE_DESCRIPTION: &str = "Sable screen audio";
const READY_TIMEOUT: Duration = Duration::from_secs(3);

struct Session {
    stop: pw::channel::Sender<()>,
    thread: JoinHandle<()>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum Selection {
    System { exclude: Vec<String> },
    Apps { include: Vec<String> },
}

impl Selection {
    fn wants(&self, app: &str) -> bool {
        match self {
            Self::System { exclude } => !exclude.iter().any(|name| name == app),
            Self::Apps { include } => include.iter().any(|name| name == app),
        }
    }
}

impl Default for Selection {
    fn default() -> Self {
        Self::System {
            exclude: Vec::new(),
        }
    }
}

fn app_name(props: &DictRef) -> Option<String> {
    if props.get(SELF_MARKER_KEY).is_some() || is_own_process(props) {
        return None;
    }
    props
        .get("application.name")
        .or_else(|| props.get("node.name"))
        .map(str::to_owned)
}

fn is_own_process(props: &DictRef) -> bool {
    let Some(mut pid) = ["pipewire.sec.pid", "application.process.id"]
        .into_iter()
        .find_map(|key| props.get(key)?.parse::<u32>().ok())
    else {
        return false;
    };
    let own_pid = std::process::id();

    loop {
        if pid == own_pid {
            return true;
        }
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        let Some(parent) = stat
            .rsplit_once(')')
            .and_then(|(_, fields)| fields.split_whitespace().nth(1))
            .and_then(|parent| parent.parse().ok())
        else {
            return false;
        };
        pid = parent;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Side {
    Left,
    Right,
}

fn sides(channel: &str) -> &'static [Side] {
    match channel {
        "FL" | "RL" | "SL" | "FLC" | "RLC" | "TFL" | "TRL" => &[Side::Left],
        "FR" | "RR" | "SR" | "FRC" | "RRC" | "TFR" | "TRR" => &[Side::Right],
        _ => &[Side::Left, Side::Right],
    }
}

fn side_of_input(channel: &str) -> Option<Side> {
    match channel {
        "FL" => Some(Side::Left),
        "FR" => Some(Side::Right),
        _ => None,
    }
}

#[derive(Default)]
struct Graph {
    own_node: Option<u32>,
    inputs: HashMap<Side, u32>,
    selection: Selection,
    streams: HashMap<u32, String>,
    outputs: HashMap<u32, (u32, String)>,
    watched: HashMap<u32, (pw::node::Node, pw::node::NodeListener)>,
    linked: HashMap<(u32, u32), pw::link::Link>,
}

impl Graph {
    fn wanted_links(&self) -> Vec<(u32, u32, u32, u32)> {
        let Some(own) = self.own_node else {
            return Vec::new();
        };
        let mut wanted = Vec::new();
        for (&port, (node, channel)) in &self.outputs {
            if !self
                .streams
                .get(node)
                .is_some_and(|app| self.selection.wants(app))
            {
                continue;
            }
            for side in sides(channel) {
                if let Some(&input) = self.inputs.get(side) {
                    wanted.push((*node, port, own, input));
                }
            }
        }
        wanted
    }

    fn forget(&mut self, id: u32) {
        if self.own_node == Some(id) {
            self.own_node = None;
            self.inputs.clear();
        }
        self.inputs.retain(|_, port| *port != id);
        self.streams.remove(&id);
        self.watched.remove(&id);
        self.outputs.remove(&id);
        self.outputs.retain(|_, (node, _)| *node != id);
        let outputs = &self.outputs;
        let inputs = &self.inputs;
        self.linked.retain(|(output, input), _| {
            outputs.contains_key(output) && inputs.values().any(|port| port == input)
        });
    }
}

fn node_name() -> String {
    format!("sable-screen-audio-{}", std::process::id())
}

type Connection = (
    pw::main_loop::MainLoopRc,
    pw::context::ContextRc,
    pw::core::CoreRc,
    pw::registry::RegistryRc,
);

fn connect() -> Result<Connection, String> {
    pw::init();
    let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(|error| error.to_string())?;
    let context =
        pw::context::ContextRc::new(&mainloop, None).map_err(|error| error.to_string())?;
    let core = context
        .connect_rc(Some(pw::properties::properties! {
            "media.category" => "Manager",
        }))
        .map_err(|error| error.to_string())?;
    let registry = core.get_registry_rc().map_err(|error| error.to_string())?;
    Ok((mainloop, context, core, registry))
}

fn run(
    selection: Selection,
    stop: pw::channel::Receiver<()>,
    ready: &mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let (mainloop, _context, core, registry) = connect()?;

    let _stop = stop.attach(mainloop.loop_(), {
        let mainloop = mainloop.clone();
        move |()| mainloop.quit()
    });

    let name = node_name();
    let _node = core
        .create_object::<pw::node::Node>(
            "adapter",
            &pw::properties::properties! {
                "factory.name" => "support.null-audio-sink",
                "node.name" => name.as_str(),
                "node.description" => NODE_DESCRIPTION,
                "media.class" => "Audio/Source/Virtual",
                "audio.position" => "FL,FR",
                "priority.session" => "0",
                "priority.driver" => "0",
                SELF_MARKER_KEY => "1",
            },
        )
        .map_err(|error| error.to_string())?;

    let graph = Rc::new(RefCell::new(Graph {
        selection,
        ..Graph::default()
    }));
    let ready = ready.clone();
    let announced = Rc::new(RefCell::new(false));

    let _listener = registry
        .add_listener_local()
        .global({
            let graph = graph.clone();
            let registry = registry.clone();
            move |global| {
                let Some(props) = global.props else {
                    return;
                };
                let mut current = graph.borrow_mut();
                match global.type_ {
                    ObjectType::Node if props.get("node.name") == Some(name.as_str()) => {
                        current.own_node = Some(global.id);
                    }
                    ObjectType::Node if props.get("media.class") == Some("Stream/Output/Audio") => {
                        if let Some(watch) = watch_stream(&registry, global, &graph, &core) {
                            current.watched.insert(global.id, watch);
                        }
                        return;
                    }
                    ObjectType::Port => record_port(&mut current, global.id, props),
                    _ => return,
                }
                link(&core, &mut current);
                if current.inputs.len() == 2 && !*announced.borrow() {
                    *announced.borrow_mut() = true;
                    let _ = ready.send(Ok(()));
                }
            }
        })
        .global_remove(move |id| graph.borrow_mut().forget(id))
        .register();

    mainloop.run();
    Ok(())
}

fn watch_stream(
    registry: &pw::registry::RegistryRc,
    global: &pw::registry::GlobalObject<&DictRef>,
    graph: &Rc<RefCell<Graph>>,
    core: &pw::core::CoreRc,
) -> Option<(pw::node::Node, pw::node::NodeListener)> {
    let node = registry.bind::<pw::node::Node, _>(global).ok()?;
    let id = global.id;
    let listener = node
        .add_listener_local()
        .info({
            let graph = graph.clone();
            let core = core.clone();
            move |info| {
                let Some(app) = info.props().and_then(app_name) else {
                    return;
                };
                let mut graph = graph.borrow_mut();
                if graph.streams.insert(id, app).is_none() {
                    link(&core, &mut graph);
                }
            }
        })
        .register();
    Some((node, listener))
}

fn record_port(graph: &mut Graph, id: u32, props: &DictRef) {
    let (Some(node), Some(channel)) = (
        props.get("node.id").and_then(|id| id.parse::<u32>().ok()),
        props.get("audio.channel"),
    ) else {
        return;
    };
    let direction = props.get("port.direction");
    if Some(node) == graph.own_node && direction == Some("in") {
        if let Some(side) = side_of_input(channel) {
            graph.inputs.insert(side, id);
        }
    } else if direction == Some("out") && props.get("port.monitor") != Some("true") {
        graph.outputs.insert(id, (node, channel.to_owned()));
    }
}

fn link(core: &pw::core::CoreRc, graph: &mut Graph) {
    for (output_node, output, input_node, input) in graph.wanted_links() {
        if graph.linked.contains_key(&(output, input)) {
            continue;
        }
        let created = core.create_object::<pw::link::Link>(
            "link-factory",
            &pw::properties::properties! {
                "link.output.node" => output_node.to_string(),
                "link.output.port" => output.to_string(),
                "link.input.node" => input_node.to_string(),
                "link.input.port" => input.to_string(),
                "object.linger" => "false",
            },
        );
        match created {
            Ok(proxy) => {
                graph.linked.insert((output, input), proxy);
            }
            Err(error) => tracing::warn!(%error, output, input, "screen audio link failed"),
        }
    }
}

pub(crate) fn start(selection: Selection) -> Result<String, String> {
    stop();
    let mut session = SESSION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    let (stop, receiver) = pw::channel::channel();
    let (ready, answer) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("screen-audio".into())
        .spawn(move || {
            if let Err(error) = run(selection, receiver, &ready) {
                let _ = ready.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;

    match answer.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(())) => {
            *session = Some(Session { stop, thread });
            Ok(NODE_DESCRIPTION.to_owned())
        }
        Ok(Err(error)) => {
            let _ = thread.join();
            Err(error)
        }
        Err(_) => {
            let _ = stop.send(());
            let _ = thread.join();
            Err("PipeWire did not create the screen audio source".to_owned())
        }
    }
}

fn roundtrip(mainloop: &pw::main_loop::MainLoopRc, core: &pw::core::CoreRc) -> Result<(), String> {
    let done = Rc::new(Cell::new(false));
    let pending = core.sync(0).map_err(|error| error.to_string())?;
    let _listener = core
        .add_listener_local()
        .done({
            let done = done.clone();
            let mainloop = mainloop.clone();
            move |id, seq| {
                if id == pw::core::PW_ID_CORE && seq == pending {
                    done.set(true);
                    mainloop.quit();
                }
            }
        })
        .register();
    while !done.get() {
        mainloop.run();
    }
    Ok(())
}

pub(crate) fn list_apps() -> Result<Vec<String>, String> {
    let (mainloop, _context, core, registry) = connect()?;
    let apps = Rc::new(RefCell::new(BTreeSet::new()));
    let watched = Rc::new(RefCell::new(Vec::new()));

    let _listener = registry
        .add_listener_local()
        .global({
            let registry = registry.clone();
            let apps = apps.clone();
            move |global| {
                if global.type_ != ObjectType::Node
                    || global.props.and_then(|props| props.get("media.class"))
                        != Some("Stream/Output/Audio")
                {
                    return;
                }
                let Ok(node) = registry.bind::<pw::node::Node, _>(global) else {
                    return;
                };
                let listener = node
                    .add_listener_local()
                    .info({
                        let apps = apps.clone();
                        move |info| {
                            if let Some(app) = info.props().and_then(app_name) {
                                apps.borrow_mut().insert(app);
                            }
                        }
                    })
                    .register();
                watched.borrow_mut().push((node, listener));
            }
        })
        .register();

    roundtrip(&mainloop, &core)?;
    roundtrip(&mainloop, &core)?;
    Ok(apps.borrow().iter().cloned().collect())
}

pub(crate) fn stop() {
    let session = SESSION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    if let Some(session) = session {
        let _ = session.stop.send(());
        let _ = session.thread.join();
    }
}

#[cfg(test)]
mod tests {
    use super::{Graph, Selection, Side, app_name, pw, sides};

    fn graph(selection: Selection) -> Graph {
        let mut graph = Graph {
            own_node: Some(10),
            selection,
            ..Graph::default()
        };
        graph.inputs.insert(Side::Left, 11);
        graph.inputs.insert(Side::Right, 12);
        graph
    }

    fn with_stream(graph: &mut Graph, node: u32, app: &str) {
        graph.streams.insert(node, app.into());
        graph.outputs.insert(node + 1, (node, "FL".into()));
        graph.outputs.insert(node + 2, (node, "FR".into()));
    }

    #[test]
    fn links_each_channel_of_another_app_to_its_side() {
        let mut graph = graph(Selection::default());
        with_stream(&mut graph, 20, "Firefox");

        let mut links = graph.wanted_links();
        links.sort_unstable();
        assert_eq!(links, vec![(20, 21, 10, 11), (20, 22, 10, 12)]);
    }

    #[test]
    fn a_mono_stream_feeds_both_sides() {
        assert_eq!(sides("MONO"), &[Side::Left, Side::Right]);
        assert_eq!(sides("RL"), &[Side::Left]);
    }

    #[test]
    fn the_whole_system_leaves_out_the_apps_it_excludes() {
        let mut graph = graph(Selection::System {
            exclude: vec!["Spotify".into()],
        });
        with_stream(&mut graph, 20, "Firefox");
        with_stream(&mut graph, 30, "Spotify");

        assert!(graph.wanted_links().iter().all(|link| link.0 == 20));
        assert_eq!(graph.wanted_links().len(), 2);
    }

    #[test]
    fn chosen_apps_are_the_only_ones_shared() {
        let mut graph = graph(Selection::Apps {
            include: vec!["Spotify".into()],
        });
        with_stream(&mut graph, 20, "Firefox");
        with_stream(&mut graph, 30, "Spotify");

        assert!(graph.wanted_links().iter().all(|link| link.0 == 30));
        assert_eq!(graph.wanted_links().len(), 2);
    }

    #[test]
    fn waits_for_a_stream_to_be_confirmed_before_linking_it() {
        let mut graph = graph(Selection::default());
        graph.outputs.insert(51, (50, "FL".into()));

        assert!(graph.wanted_links().is_empty());
    }

    #[test]
    fn forgetting_a_stream_drops_its_ports() {
        let mut graph = graph(Selection::default());
        with_stream(&mut graph, 20, "Firefox");
        graph.forget(20);

        assert!(graph.outputs.is_empty());
        assert!(graph.wanted_links().is_empty());
    }

    #[test]
    fn reads_a_selection_from_the_page() {
        let selection: Selection =
            serde_json::from_str(r#"{"kind":"apps","include":["Spotify"]}"#).unwrap();
        assert_eq!(
            selection,
            Selection::Apps {
                include: vec!["Spotify".into()]
            }
        );
    }

    #[test]
    fn leaves_out_unmarked_audio_from_our_process() {
        let pid = std::process::id().to_string();
        let props = pw::properties::properties! {
            "application.name" => "Sable",
            "application.process.id" => pid.as_str(),
        };

        assert_eq!(app_name(props.dict()), None);
    }
}
