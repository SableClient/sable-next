//! Pure logic every client shares: no I/O, no SDK, no runtime. The core links
//! it, and the web page calls it synchronously through `sable-model-wasm`.

#![cfg_attr(
    feature = "typegen",
    allow(
        clippy::zero_sized_map_values,
        reason = "specta types an open JSON object as a map of unknown"
    )
)]

pub mod bot_commands;
pub mod calendar;
mod civil;
mod emoji_properties;
pub mod event_preview;
pub mod jumbo;
pub mod markdown;
pub mod matrix_link;
pub mod member_look;
pub mod mfm;
pub mod notifications;
pub mod power_levels;
pub mod search_filter;
pub mod search_query;
pub mod shortcodes;
pub mod sidebar;
pub mod slash;
pub mod spaces;
mod text;
