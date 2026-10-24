use sable_model::sidebar::SidebarItemView;
use sable_protocol::{CoreEvent, CoreEventKind, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::backoff;
use crate::rpc::spaces::{SetSpaceSidebar, SpaceSidebar};
use sable_runtime::{Cmd, Cx, Doc, Interest, Lifetime, Name, Slice};

const RETRY_TIMER: Name = "load";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidebarNotice {
    /// A layout was refused and the server is being reloaded.
    SaveFailed,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SidebarView {
    pub items: Vec<SidebarItemView>,
    pub loaded: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SidebarAction {
    Write { items: Vec<SidebarItemView> },
}

pub enum Input {
    Action(SidebarAction),
    Loaded {
        revision: u64,
        result: Result<Vec<SidebarItemView>, RpcError>,
    },
    Reload,
    Changed(Vec<SidebarItemView>),
    Saved {
        write: u64,
        result: Result<(), RpcError>,
    },
}

impl From<SidebarAction> for Input {
    fn from(action: SidebarAction) -> Self {
        Self::Action(action)
    }
}

struct Pending {
    write: u64,
    stored: bool,
}

pub struct State {
    doc: Doc<SidebarView>,
    revision: u64,
    pending: Option<Pending>,
    failures: u32,
}

impl State {
    fn set_items(&mut self, items: Vec<SidebarItemView>) -> Vec<SidebarItemView> {
        let mut replaced = Vec::new();
        self.doc.edit_fields(|view| {
            replaced = std::mem::replace(&mut view.items, items);
        });
        self.doc.edit_fields(|view| view.loaded = true);
        self.revision += 1;
        replaced
    }

    /// A layout that differs from the write still in flight is the core's older one.
    fn receive(&mut self, items: Vec<SidebarItemView>) {
        if let Some(pending) = &self.pending {
            if !pending.stored && items != self.doc.view().items {
                return;
            }
            self.pending = None;
        }
        self.set_items(items);
    }

    fn write(&mut self, items: Vec<SidebarItemView>) -> Cmd<Input> {
        self.set_items(items.clone());
        let write = self.revision;
        self.pending = Some(Pending {
            write,
            stored: false,
        });
        Cmd::rpc(SetSpaceSidebar { items }, move |result| Input::Saved {
            write,
            result,
        })
    }

    fn saved(&mut self, write: u64, result: Result<(), RpcError>) -> Cmd<Input> {
        let current = self
            .pending
            .as_mut()
            .filter(|pending| pending.write == write);
        let Err(error) = result else {
            if let Some(pending) = current {
                pending.stored = true;
                self.revision += 1;
            }
            return Cmd::none();
        };
        tracing::warn!(?error, "the space layout was not saved");
        if current.is_some() {
            self.pending = None;
            self.revision += 1;
            let revision = self.revision;
            return Cmd::rpc(SpaceSidebar {}, move |result| Input::Loaded {
                revision,
                result,
            })
            .then(Cmd::notice(&SidebarNotice::SaveFailed));
        }
        Cmd::notice(&SidebarNotice::SaveFailed)
    }
}

pub struct Sidebar;

impl Slice for Sidebar {
    const NAME: &'static str = "sidebar";
    const LIFETIME: Lifetime = crate::KEPT;
    const INTEREST: Interest = Interest::of(&[CoreEventKind::SpaceSidebarChanged]);
    const PERSIST: bool = true;

    type Key = ();
    type State = State;
    type View = Doc<SidebarView>;
    type Action = SidebarAction;
    type Input = Input;

    fn init((): &(), cached: Option<Value>) -> (State, Cmd<Input>) {
        let doc = cached
            .and_then(Doc::from_cached)
            .unwrap_or_else(|| Doc::new(SidebarView::default()));
        (
            State {
                doc,
                revision: 0,
                pending: None,
                failures: 0,
            },
            Cmd::rpc(SpaceSidebar {}, |result| Input::Loaded {
                revision: 0,
                result,
            }),
        )
    }

    fn core_input(state: &State, event: &CoreEvent) -> Option<Input> {
        match event {
            CoreEvent::SpaceSidebarChanged { items }
                if state.pending.is_some() || *items != state.doc.view().items =>
            {
                Some(Input::Changed(items.clone()))
            }
            _ => None,
        }
    }

    fn view(state: &mut State) -> &mut Doc<SidebarView> {
        &mut state.doc
    }

    fn reduce((): &(), state: &mut State, input: Input, _: &Cx) -> Cmd<Input> {
        match input {
            Input::Action(SidebarAction::Write { items }) => return state.write(items),
            Input::Loaded { revision, .. } if revision != state.revision => {}
            Input::Loaded {
                result: Ok(items), ..
            } => {
                state.failures = 0;
                state.set_items(items);
            }
            Input::Loaded {
                result: Err(error), ..
            } => {
                tracing::debug!(?error, "the space layout is unavailable");
                let wait = backoff::delay(state.failures);
                state.failures += 1;
                return Cmd::after(RETRY_TIMER, wait, Input::Reload);
            }
            Input::Reload => {
                let revision = state.revision;
                return Cmd::rpc(SpaceSidebar {}, move |result| Input::Loaded {
                    revision,
                    result,
                });
            }
            Input::Changed(items) => state.receive(items),
            Input::Saved { write, result } => return state.saved(write, result),
        }
        Cmd::none()
    }
}
