use std::collections::BTreeSet;

pub(crate) const TYPES_KEY: &[u8] = b"sable.account_data_types";

pub(crate) const KNOWN_TYPES: &[&str] = &[
    "m.direct",
    "m.push_rules",
    "m.ignored_user_list",
    "m.identity_server",
    "m.secret_storage.default_key",
    "m.cross_signing.master",
    "m.cross_signing.self_signing",
    "m.cross_signing.user_signing",
    "m.megolm_backup.v1",
    "m.widgets",
    "m.recent_emoji",
    "m.image_pack.rooms",
    "m.per_message_profiles",
    "im.ponies.user_emotes",
    "im.ponies.emote_rooms",
    "io.element.recent_emoji",
    "in.cinny.spaces",
    "moe.sable.app.settings",
    "moe.sable.next.settings",
    "moe.sable.next.drafts",
    "moe.sable.next.workspace",
];

pub(crate) async fn stored_types(client: &matrix_sdk::Client) -> BTreeSet<String> {
    match client.state_store().get_custom_value(TYPES_KEY).await {
        Ok(Some(bytes)) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Ok(None) => BTreeSet::new(),
        Err(error) => {
            tracing::warn!("reading the account data types failed: {error}");
            BTreeSet::new()
        }
    }
}
