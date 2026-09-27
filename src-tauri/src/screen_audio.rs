use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

use pipewire as pw;
use pw::types::ObjectType;

const SELF_MARKER_KEY: &str = "sable.screen-audio.exclude";
pub const SELF_MARKER: &str = "sable.screen-audio.exclude=1";
const NODE_DESCRIPTION: &str = "Sable screen audio";
const READY_TIMEOUT: Duration = Duration::from_secs(3);

struct Session {
    stop: pw::channel::Sender<()>,
    thread: JoinHandle<()>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

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
    streams: HashSet<u32>,
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
            if !self.streams.contains(node) {
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

fn run(
    stop: pw::channel::Receiver<()>,
    ready: &mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
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

    let graph = Rc::new(RefCell::new(Graph::default()));
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
    global: &pw::registry::GlobalObject<&pw::spa::utils::dict::DictRef>,
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
                let ours = info
                    .props()
                    .is_some_and(|props| props.get(SELF_MARKER_KEY).is_some());
                let mut graph = graph.borrow_mut();
                if !ours && graph.streams.insert(id) {
                    link(&core, &mut graph);
                }
            }
        })
        .register();
    Some((node, listener))
}

fn record_port(graph: &mut Graph, id: u32, props: &pw::spa::utils::dict::DictRef) {
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

pub(crate) fn start() -> Result<String, String> {
    let mut session = SESSION
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if session.is_some() {
        return Ok(NODE_DESCRIPTION.to_owned());
    }

    let (stop, receiver) = pw::channel::channel();
    let (ready, answer) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("screen-audio".into())
        .spawn(move || {
            if let Err(error) = run(receiver, &ready) {
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
    use super::{Graph, Side, sides};

    fn graph() -> Graph {
        let mut graph = Graph {
            own_node: Some(10),
            ..Graph::default()
        };
        graph.inputs.insert(Side::Left, 11);
        graph.inputs.insert(Side::Right, 12);
        graph
    }

    #[test]
    fn links_each_channel_of_another_app_to_its_side() {
        let mut graph = graph();
        graph.streams.insert(20);
        graph.outputs.insert(21, (20, "FL".into()));
        graph.outputs.insert(22, (20, "FR".into()));

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
    fn waits_for_a_stream_to_be_confirmed_before_linking_it() {
        let mut graph = graph();
        graph.outputs.insert(51, (50, "FL".into()));

        assert!(graph.wanted_links().is_empty());
    }

    #[test]
    fn forgetting_a_stream_drops_its_ports() {
        let mut graph = graph();
        graph.streams.insert(20);
        graph.outputs.insert(21, (20, "FL".into()));
        graph.forget(20);

        assert!(graph.outputs.is_empty());
        assert!(graph.wanted_links().is_empty());
    }
}
