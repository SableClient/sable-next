use matrix_sdk_ui::{eyeball_im, room_list_service::RoomListItem};

use crate::protocol::{SearchContextView, SearchHitView};

use super::room::latest_items;

/// Computed lazily: until something awaits `display_name()` every unnamed room
/// crosses the wire as `null`.
pub async fn prime_display_names(diffs: &[eyeball_im::VectorDiff<RoomListItem>]) {
    let missing = latest_items(diffs)
        .into_iter()
        .filter(|item| item.cached_display_name().is_none())
        .map(|item| async move {
            let _ = item.display_name().await;
        });
    futures_util::future::join_all(missing).await;
}

pub(crate) fn search_hit_view(hit: crate::search::Hit, matched: Vec<String>) -> SearchHitView {
    SearchHitView {
        room_id: hit.room_id,
        event_id: hit.event_id,
        body: hit.body,
        sender: hit.sender,
        origin_server_ts: hit.origin_server_ts,
        score: hit.score,
        matched,
        context_before: hit.before.into_iter().map(search_context_view).collect(),
        context_after: hit.after.into_iter().map(search_context_view).collect(),
    }
}

fn search_context_view(line: crate::search::ContextLine) -> SearchContextView {
    SearchContextView {
        event_id: line.event_id,
        body: line.body,
        sender: line.sender,
        origin_server_ts: line.origin_server_ts,
    }
}
