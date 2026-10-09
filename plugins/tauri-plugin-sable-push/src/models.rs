use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[expect(
    clippy::struct_excessive_bools,
    reason = "mirrors the notification view's flags"
)]
pub struct Post {
    pub user_id: String,
    pub room_id: String,
    pub event_id: Option<String>,
    pub room_name: String,
    pub sender_name: Option<String>,
    pub body: String,
    pub encrypted: bool,
    pub direct: bool,
    pub noisy: bool,
    pub invite: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
#[expect(
    clippy::struct_excessive_bools,
    reason = "mirrors the notification preference switches"
)]
pub struct Policy {
    pub enabled: bool,
    pub content: bool,
    pub encrypted_content: bool,
    pub sounds: bool,
    pub notify_once: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub user_id: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub at: i64,
    pub outcome: String,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub room_id: Option<String>,
    #[serde(default)]
    pub event_id: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    #[serde(default)]
    pub entries: Vec<HistoryEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    #[serde(default)]
    pub counts: HashMap<String, u32>,
    #[serde(default)]
    pub last_outcome: Option<String>,
    #[serde(default)]
    pub last_at: i64,
}
