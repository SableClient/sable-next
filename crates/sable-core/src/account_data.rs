use std::collections::BTreeSet;
use std::time::Duration;

use matrix_sdk::ruma::api::client::filter::{FilterDefinition, RoomFilter};
use matrix_sdk::ruma::api::client::sync::sync_events;
use matrix_sdk::ruma::presence::PresenceState;

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

fn account_data_filter() -> FilterDefinition {
    let mut filter = FilterDefinition::default();
    filter.presence.types = Some(Vec::new());
    let mut rooms = RoomFilter::default();
    rooms.rooms = Some(Vec::new());
    filter.room = rooms;
    filter
}

pub(crate) async fn server_types(
    client: &matrix_sdk::Client,
    presence: PresenceState,
) -> Result<BTreeSet<String>, matrix_sdk::HttpError> {
    let mut request = sync_events::v3::Request::new();
    request.filter = Some(sync_events::v3::Filter::FilterDefinition(
        account_data_filter(),
    ));
    request.timeout = Some(Duration::ZERO);
    request.set_presence = presence;
    let response = client.send(request).await?;
    Ok(response
        .account_data
        .events
        .iter()
        .filter_map(|raw| raw.get_field::<String>("type").ok().flatten())
        .collect())
}

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
