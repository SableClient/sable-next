use std::{hash::Hash, time::Duration};

use sable_protocol::{CoreEvent, CoreEventKind};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{
    cmd::Cmd,
    error::AppError,
    rt::SendOutsideWasm,
    wire::{Op, ReqId, Window},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifetime {
    Singleton,
    RefCounted { grace: Duration },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Interest(u64);

impl Interest {
    pub const NONE: Self = Self(0);

    #[must_use]
    pub const fn of(kinds: &[CoreEventKind]) -> Self {
        let mut bits = 0_u64;
        let mut rest = kinds;
        while let [kind, tail @ ..] = rest {
            bits |= 1 << *kind as u8;
            rest = tail;
        }
        Self(bits)
    }

    #[must_use]
    pub const fn wants(self, event: &CoreEvent) -> bool {
        self.0 & (1 << event.kind() as u8) != 0
    }
}

pub trait Key:
    Clone + Eq + Hash + Serialize + DeserializeOwned + SendOutsideWasm + 'static
{
}

impl<T> Key for T where
    T: Clone + Eq + Hash + Serialize + DeserializeOwned + SendOutsideWasm + 'static
{
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Cx {
    req: Option<ReqId>,
}

impl Cx {
    pub(crate) const fn new(req: Option<ReqId>) -> Self {
        Self { req }
    }

    /// Carry it in the inputs of any effect that finishes the request.
    #[must_use]
    pub const fn req(&self) -> Option<ReqId> {
        self.req
    }
}

pub trait Render: SendOutsideWasm + 'static {
    type Changes: SendOutsideWasm;

    fn snapshot(&self, window: Option<Window>) -> Result<Value, AppError>;

    fn drain(&mut self) -> Result<Option<Self::Changes>, AppError>;

    fn clear(&mut self);

    fn project(&self, changes: &Self::Changes, window: Option<Window>)
    -> Result<Vec<Op>, AppError>;
}

pub trait Slice: SendOutsideWasm + 'static {
    const NAME: &'static str;
    const LIFETIME: Lifetime;
    const INTEREST: Interest = Interest::NONE;
    const PERSIST: bool = false;

    type Key: Key;
    type State: SendOutsideWasm + 'static;
    type View: Render;
    type Action: DeserializeOwned + SendOutsideWasm + 'static;
    type Input: From<Self::Action> + SendOutsideWasm + 'static;

    fn init(key: &Self::Key, cached: Option<Value>) -> (Self::State, Cmd<Self::Input>);

    #[must_use]
    fn event_key(_event: &CoreEvent) -> Option<Self::Key> {
        None
    }

    #[must_use]
    fn core_input(_state: &Self::State, _event: &CoreEvent) -> Option<Self::Input> {
        None
    }

    fn view(state: &mut Self::State) -> &mut Self::View;

    fn reduce(
        key: &Self::Key,
        state: &mut Self::State,
        input: Self::Input,
        cx: &Cx,
    ) -> Cmd<Self::Input>;

    /// The inputs of what it starts are discarded.
    fn dispose(_key: &Self::Key, _state: &mut Self::State) -> Cmd<Self::Input> {
        Cmd::none()
    }
}
