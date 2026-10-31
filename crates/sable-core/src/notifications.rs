#[cfg(not(target_family = "wasm"))]
mod cold;
mod device_activity;
mod media;
#[cfg(not(target_family = "wasm"))]
mod push_cache;
mod pusher;
#[cfg(not(target_family = "wasm"))]
mod session;
mod view;

#[cfg(not(target_family = "wasm"))]
pub use cold::{
    ColdPush, PushClient, cold_push_store_dir, decrypt_cold_push, restore_push_client,
    settle_refreshes,
};
pub(crate) use device_activity::set_device_activity;
#[cfg(not(target_family = "wasm"))]
pub(crate) use media::clear_push_media;
pub use media::push_sender_name;
#[cfg(not(target_family = "wasm"))]
pub use media::{PushImage, PushMedia};
#[cfg(not(target_family = "wasm"))]
pub use push_cache::evict as evict_push_cache;
#[cfg(not(target_family = "wasm"))]
pub(crate) use pusher::GATEWAY_PATH;
pub(crate) use pusher::{gateway, pusher_display_name};
pub use pusher::{remove_pusher, set_pusher};
#[cfg(not(target_family = "wasm"))]
pub use session::{
    PushSession, cold_push_active_elsewhere, cold_push_media, cold_push_session,
    fetch_cold_push_event,
};
pub use view::{
    NOISY_KEY, every_encrypted_event_pushed, fetch_push_event, is_backfill, is_read, notification,
    notifies, uses_direct_push_rules,
};
pub(crate) use view::{foreground_notification, invite_notification, raw_is_encrypted};

#[cfg(test)]
mod tests;
