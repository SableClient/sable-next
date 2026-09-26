use std::collections::HashMap;

use matrix_sdk::EncryptionState;
use matrix_sdk::ruma::api::client::filter::RoomEventFilter;
use matrix_sdk::ruma::api::client::search::search_events::v3::{
    Categories, Criteria, OrderBy, Request, SearchKeys, SearchResult,
};
use matrix_sdk::ruma::events::room::message::Relation;
use matrix_sdk::ruma::events::{AnyMessageLikeEvent, AnyTimelineEvent};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId, UInt};

use super::{ContextLine, Hit, indexable_body};
use crate::Core;
use crate::protocol::{SearchFilter, SearchOrder};

const MAX_ROUND_TRIPS: usize = 8;

const MAX_PER_REQUEST: u64 = 100;

pub(super) struct ServerQuery<'a> {
    pub(super) room_id: &'a OwnedRoomId,
    pub(super) query: &'a str,
    pub(super) filter: &'a SearchFilter,
    pub(super) order: SearchOrder,
    pub(super) limit: usize,
    pub(super) offset: usize,
    pub(super) context: usize,
}

impl ServerQuery<'_> {
    fn signature(&self) -> Signature {
        (
            self.query.to_owned(),
            self.filter.clone(),
            self.order,
            self.room_id.clone(),
            self.context,
        )
    }
}

type Signature = (String, SearchFilter, SearchOrder, OwnedRoomId, usize);

#[derive(Default)]
pub(crate) struct ServerSearch {
    signature: Option<Signature>,
    progress: Progress,
}

#[derive(Clone, Default)]
struct Progress {
    hits: Vec<Hit>,
    next_batch: Option<String>,
    exhausted: bool,
}

impl ServerSearch {
    fn restart(&mut self, signature: Signature) {
        self.signature = Some(signature);
        self.progress = Progress::default();
    }

    fn progress(&self) -> Progress {
        self.progress.clone()
    }

    fn adopt(&mut self, signature: &Signature, progress: Progress) {
        if self.holds(signature) && progress.hits.len() >= self.progress.hits.len() {
            self.progress = progress;
        }
    }

    fn holds(&self, signature: &Signature) -> bool {
        self.signature.as_ref() == Some(signature)
    }

    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }
}

pub(super) async fn target(
    client: &matrix_sdk::Client,
    query: &str,
    filter: &SearchFilter,
) -> Option<OwnedRoomId> {
    if query.trim().is_empty() {
        return None;
    }
    let [room_id] = filter.rooms.as_slice() else {
        return None;
    };
    if !filter.not_rooms.is_empty() || !expressible(filter) {
        return None;
    }

    let room = client.get_room(room_id)?;
    let state = room.latest_encryption_state().await.ok()?;
    matches!(state, EncryptionState::NotEncrypted).then(|| room_id.clone())
}

impl Core {
    pub(super) async fn search_server(
        &self,
        client: &matrix_sdk::Client,
        query: ServerQuery<'_>,
    ) -> matrix_sdk::Result<Vec<Hit>> {
        let signature = query.signature();
        let mut cursor = {
            let mut shared = self.server_search.lock().await;
            if query.offset == 0 || !shared.holds(&signature) {
                shared.restart(signature.clone());
            }
            shared.progress()
        };

        let wanted = query.offset.saturating_add(query.limit);
        let mut ignored: HashMap<OwnedUserId, bool> = HashMap::new();

        for _ in 0..MAX_ROUND_TRIPS {
            if cursor.hits.len() >= wanted || cursor.exhausted {
                break;
            }

            let outstanding = (wanted - cursor.hits.len()) as u64;
            let request = request_for(
                &query,
                outstanding.min(MAX_PER_REQUEST),
                cursor.next_batch.as_deref(),
            );

            let events = client.send(request).await?.search_categories.room_events;
            cursor.next_batch = events.next_batch;
            cursor.exhausted = cursor.next_batch.is_none();

            for result in &events.results {
                let Some(mut hit) = hit_from(result) else {
                    continue;
                };

                let muted = if let Some(muted) = ignored.get(&hit.sender) {
                    *muted
                } else {
                    let muted = client.is_user_ignored(&hit.sender).await;
                    ignored.insert(hit.sender.clone(), muted);
                    muted
                };

                if !muted {
                    for line in hit.before.iter().chain(&hit.after) {
                        if !ignored.contains_key(&line.sender) {
                            let muted = client.is_user_ignored(&line.sender).await;
                            ignored.insert(line.sender.clone(), muted);
                        }
                    }
                    let shown = |line: &ContextLine| ignored.get(&line.sender) != Some(&true);
                    hit.before.retain(shown);
                    hit.after.retain(shown);
                    cursor.hits.push(hit);
                }
            }
        }

        let page = cursor
            .hits
            .iter()
            .skip(query.offset)
            .take(query.limit)
            .cloned()
            .collect();
        self.server_search.lock().await.adopt(&signature, cursor);
        Ok(page)
    }
}

const fn expressible(filter: &SearchFilter) -> bool {
    filter.mentions.is_empty()
        && filter.not_mentions.is_empty()
        && filter.has.is_empty()
        && filter.not_has.is_empty()
        && filter.after_ts.is_none()
        && filter.before_ts.is_none()
        && filter.phrases.is_empty()
        && filter.exclude.is_empty()
        && filter.pinned.is_none()
        && filter.in_thread.is_none()
}

fn request_for(query: &ServerQuery<'_>, limit: u64, next_batch: Option<&str>) -> Request {
    let mut events = RoomEventFilter::default();
    events.rooms = Some(vec![query.room_id.clone()]);
    events.types = Some(vec!["m.room.message".to_owned()]);
    events.limit = UInt::new(limit);
    if !query.filter.senders.is_empty() {
        events.senders = Some(query.filter.senders.clone());
    }
    events.not_senders.clone_from(&query.filter.not_senders);

    let mut criteria = Criteria::new(query.query.to_owned());
    criteria.keys = Some(vec![SearchKeys::ContentBody]);
    criteria.filter = events;
    criteria.order_by = Some(match query.order {
        SearchOrder::Rank => OrderBy::Rank,
        SearchOrder::Recent | SearchOrder::Oldest => OrderBy::Recent,
    });
    let context = UInt::try_from(query.context).unwrap_or(UInt::MIN);
    criteria.event_context.before_limit = context;
    criteria.event_context.after_limit = context;
    criteria.event_context.include_profile = false;

    let mut categories = Categories::new();
    categories.room_events = Some(criteria);

    let mut request = Request::new(categories);
    request.next_batch = next_batch.map(ToOwned::to_owned);
    request
}

fn context_line(raw: &Raw<AnyTimelineEvent>) -> Option<ContextLine> {
    let AnyTimelineEvent::MessageLike(AnyMessageLikeEvent::RoomMessage(message)) =
        raw.deserialize().ok()?
    else {
        return None;
    };
    let original = message.as_original()?;
    if matches!(original.content.relates_to, Some(Relation::Replacement(_))) {
        return None;
    }

    Some(ContextLine {
        event_id: original.event_id.clone(),
        body: indexable_body(original.content.body()),
        sender: original.sender.clone(),
        origin_server_ts: original.origin_server_ts.get().into(),
    })
}

fn hit_from(result: &SearchResult) -> Option<Hit> {
    let AnyTimelineEvent::MessageLike(AnyMessageLikeEvent::RoomMessage(message)) =
        result.result.as_ref()?.deserialize().ok()?
    else {
        return None;
    };
    let original = message.as_original()?;
    if matches!(original.content.relates_to, Some(Relation::Replacement(_))) {
        return None;
    }

    let mut before: Vec<ContextLine> = result
        .context
        .events_before
        .iter()
        .filter_map(context_line)
        .collect();
    before.reverse();

    Some(Hit {
        room_id: original.room_id.clone(),
        event_id: original.event_id.clone(),
        body: indexable_body(original.content.body()),
        sender: original.sender.clone(),
        origin_server_ts: original.origin_server_ts.get().into(),
        score: result.rank.unwrap_or_default(),
        before,
        after: result
            .context
            .events_after
            .iter()
            .filter_map(context_line)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{room_id, user_id};

    use matrix_sdk::ruma::api::client::search::search_events::v3::SearchResult;
    use serde_json::json;

    use super::{expressible, hit_from};
    use crate::protocol::{SearchAttachment, SearchFilter};

    #[test]
    fn test_an_edit_is_not_a_hit_of_its_own() {
        let result: SearchResult = serde_json::from_value(json!({
            "rank": 1.0,
            "result": {
                "type": "m.room.message",
                "event_id": "$edit",
                "room_id": "!plain:localhost",
                "sender": "@erwan:localhost",
                "origin_server_ts": 2_000,
                "content": {
                    "msgtype": "m.text",
                    "body": "* deploy fixed",
                    "m.new_content": { "msgtype": "m.text", "body": "deploy fixed" },
                    "m.relates_to": { "rel_type": "m.replace", "event_id": "$original" }
                }
            }
        }))
        .expect("a search result");

        assert!(hit_from(&result).is_none());
    }

    #[test]
    fn test_the_server_context_reads_oldest_first() {
        let message = |id: &str, ts: u64, body: &str| {
            json!({
                "type": "m.room.message",
                "event_id": id,
                "room_id": "!plain:localhost",
                "sender": "@erwan:localhost",
                "origin_server_ts": ts,
                "content": { "msgtype": "m.text", "body": body }
            })
        };
        let result: SearchResult = serde_json::from_value(json!({
            "rank": 1.0,
            "result": message("$hit", 3, "deploy"),
            "context": {
                "events_before": [message("$second", 2, "b"), message("$first", 1, "a")],
                "events_after": [message("$after", 4, "c")]
            }
        }))
        .expect("a search result");

        let hit = hit_from(&result).expect("a hit");
        let ids = |lines: &[super::ContextLine]| {
            lines
                .iter()
                .map(|line| line.event_id.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&hit.before), ["$first", "$second"]);
        assert_eq!(ids(&hit.after), ["$after"]);
    }

    fn scoped() -> SearchFilter {
        SearchFilter {
            rooms: vec![room_id!("!plain:localhost").to_owned()],
            ..SearchFilter::default()
        }
    }

    #[test]
    fn test_a_sender_scoped_query_survives_the_trip_to_the_homeserver() {
        let filter = SearchFilter {
            senders: vec![user_id!("@erwan:localhost").to_owned()],
            ..scoped()
        };

        assert!(expressible(&filter));
    }

    #[test]
    fn test_a_dated_query_stays_local_because_the_wire_cannot_carry_it() {
        let filter = SearchFilter {
            before_ts: Some(1_700_000_000_000),
            ..scoped()
        };

        assert!(!expressible(&filter));
    }

    #[test]
    fn test_an_attachment_query_stays_local() {
        let filter = SearchFilter {
            has: vec![SearchAttachment::Image],
            ..scoped()
        };

        assert!(!expressible(&filter));
    }

    #[test]
    fn test_a_phrase_query_stays_local() {
        let filter = SearchFilter {
            phrases: vec!["exact wording".to_owned()],
            ..scoped()
        };

        assert!(!expressible(&filter));
    }
}
