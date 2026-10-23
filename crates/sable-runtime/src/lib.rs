#![expect(
    clippy::missing_errors_doc,
    reason = "call errors are represented by the return type"
)]

mod app;
mod cmd;
mod diff;
mod doc;
mod error;
mod instance;
mod outbox;
mod patch;
mod persist;
mod ports;
mod registry;
mod requests;
pub mod rt;
mod slice;
#[cfg(all(feature = "testing", not(target_family = "wasm")))]
pub mod testing;
mod wire;

pub use app::App;
pub use cmd::{Cmd, Name};
pub use diff::list_diff;
pub use doc::{Doc, ListChanges, ListDoc};
pub use error::AppError;
#[cfg(any(test, feature = "testing"))]
pub use patch::apply;
pub use patch::{PatchError, apply_diffs};
pub use ports::{Backend, Platform, PlatformError, Ports, Rpc};
pub use registry::{DuplicateSlice, Registry};
pub use slice::{Cx, Interest, Lifetime, Render, Slice};
pub use wire::{
    AppEvent, Batch, Handshake, LostReason, MAX_INPUT_BYTES, Op, Outcome, ReplyError, ReqId,
    Snapshot, SubId, SubscribeRequest, Subscribed, Target, WIRE_SCHEMA, Window, decode, fnv1a_hex,
};
