use std::{collections::HashMap, sync::Arc};

use sable_protocol::CoreEvent;
use serde_json::Value;

use crate::{
    error::AppError,
    instance::{Era, Origin, Shared, Started, Typed},
    rt::{BoxOnce, SendOutsideWasm, SyncOutsideWasm},
    slice::{Interest, Lifetime, Slice},
};

pub(crate) trait AnySlice: SendOutsideWasm + SyncOutsideWasm {
    fn name(&self) -> &'static str;

    fn lifetime(&self) -> Lifetime;

    fn interest(&self) -> Interest;

    fn event_key(&self, event: &CoreEvent) -> Option<String>;

    fn key_id(&self, key: &Value) -> Result<String, AppError>;

    fn start(
        &self,
        key: &Value,
        shared: Arc<Shared>,
        era: Era,
        generation: u64,
        ended: BoxOnce<Origin, ()>,
    ) -> Result<Started, AppError>;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("two slices are named `{0}`")]
pub struct DuplicateSlice(pub &'static str);

#[derive(Default)]
pub struct Registry {
    slices: HashMap<&'static str, Box<dyn AnySlice>>,
}

impl Registry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add<S: Slice>(&mut self) -> Result<&mut Self, DuplicateSlice> {
        if self.slices.contains_key(S::NAME) {
            return Err(DuplicateSlice(S::NAME));
        }
        self.slices.insert(S::NAME, Box::new(Typed::<S>::new()));
        Ok(self)
    }

    pub(crate) fn into_slices(self) -> HashMap<&'static str, Box<dyn AnySlice>> {
        self.slices
    }
}
