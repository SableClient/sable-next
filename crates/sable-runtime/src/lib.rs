//! Slices own app state in Rust and show it to any shell through snapshots and
//! patches. See `docs/runtime-v2.md`.

mod app;
mod cmd;
mod doc;
mod error;
mod followed;
mod instance;
mod outbox;
mod patch;
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
pub use doc::{Doc, ListChanges, ListDoc};
pub use error::AppError;
pub use followed::Followed;
pub use patch::{PatchError, apply, apply_diffs};
pub use ports::{Backend, Clock, Platform, PlatformError, Ports, Rpc, SystemClock};
pub use registry::{AnySlice, DuplicateSlice, Registry};
pub use slice::{Cx, Interest, Key, Lifetime, Render, Slice};
pub use wire::{
    AppEvent, Batch, LostReason, MAX_INPUT_BYTES, Op, Outcome, ReplyError, ReqId, Snapshot, SubId,
    SubscribeRequest, Subscribed, Target, Window, decode,
};
