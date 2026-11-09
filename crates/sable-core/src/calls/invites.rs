pub(super) use sable_model::rtc_invites::{Invitations, Invite};
use serde_json::{Value, json};

pub(super) const LIFETIME_MS: u64 = 90_000;
pub(super) const STICKY_MS: u64 = 300_000;

pub(super) fn content(slot: &str, direct: bool, users: &[String], membership: &str) -> Value {
    let mentions = if direct {
        json!({"user_ids": users})
    } else {
        json!({"room": true})
    };
    json!({
        "slot_id": slot, "sender_ts": crate::now_ms(), "lifetime": LIFETIME_MS,
        "m.mentions": mentions,
        "msc4354_sticky_key": slot,
        "notification_type": if direct { "ring" } else { "notification" },
        "m.relates_to": {"rel_type":"m.reference", "event_id":membership},
        "m.text": [{"body":"Call started"}],
    })
}
