use std::{collections::HashMap, sync::Arc};

use serde_json::Value;

use crate::{
    error::AppError,
    instance::{Era, ExitHook, Shared, Started, Typed},
    rt::{SendOutsideWasm, SyncOutsideWasm},
    slice::{Interest, Lifetime, Slice},
};

pub trait AnySlice: SendOutsideWasm + SyncOutsideWasm {
    fn name(&self) -> &'static str;

    fn lifetime(&self) -> Lifetime;

    fn interest(&self) -> Interest;

    /// # Errors
    ///
    /// `Invalid` when `key` is not this slice's key.
    fn key_id(&self, key: &Value) -> Result<String, AppError>;

    /// # Errors
    ///
    /// `Invalid` when `key` is not this slice's key.
    fn start(
        &self,
        key: &Value,
        shared: Arc<Shared>,
        era: Era,
        generation: u64,
        on_exit: ExitHook,
    ) -> Result<Started, AppError>;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("two slices are named `{0}`")]
pub struct DuplicateSlice(pub &'static str);

/// One line per slice:
///
/// ```ignore
/// registry.add::<Bookmarks>()?;
/// #[cfg(feature = "calls")]
/// registry.add::<Calls>()?;
/// ```
#[derive(Default)]
pub struct Registry {
    slices: HashMap<&'static str, Box<dyn AnySlice>>,
}

impl Registry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// # Errors
    ///
    /// `DuplicateSlice` when another slice has the same name.
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
