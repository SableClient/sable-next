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
pub mod color;
pub mod emote_picker;
pub mod event_preview;
pub mod field;
pub mod html;
pub mod jumbo;
pub mod markdown;
pub mod matrix_link;
pub mod member_look;
pub mod mfm;
pub mod non_blank;
pub mod notifications;
pub mod power_levels;
pub mod proxy;
pub mod rtc_invites;
pub mod search_filter;
pub mod search_query;
pub mod shortcodes;
pub mod sidebar;
pub mod slash;
pub mod spaces;
pub mod text;
pub mod truncate;
