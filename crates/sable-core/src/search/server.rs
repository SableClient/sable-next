use std::collections::HashMap;

use matrix_sdk::EncryptionState;
use matrix_sdk::ruma::api::client::filter::RoomEventFilter;
use matrix_sdk::ruma::api::client::search::search_events::v3::{
    Categories, Criteria, OrderBy, Request, SearchKeys, SearchResult,
};
use matrix_sdk::ruma::events::{AnyMessageLikeEvent, AnyTimelineEvent};
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId, UInt};

use super::{Hit, indexable_body};
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
}

impl ServerQuery<'_> {
    fn signature(&self) -> Signature {
        (
            self.query.to_owned(),
            self.filter.clone(),
            self.order,
            self.room_id.clone(),
        )
    }
}

type Signature = (String, SearchFilter, SearchOrder, OwnedRoomId);

#[derive(Default)]
pub(crate) struct ServerSearch {
    signature: Option<Signature>,
    hits: Vec<Hit>,
    next_batch: Option<String>,
    exhausted: bool,
}

impl ServerSearch {
    fn restart(&mut self, signature: Signature) {
        self.signature = Some(signature);
        self.hits.clear();
        self.next_batch = None;
        self.exhausted = false;
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
    filter: &SearchFilter,
) -> Option<OwnedRoomId> {
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
        let mut cursor = self.server_search.lock().await;

        if query.offset == 0 || !cursor.holds(&signature) {
            cursor.restart(signature);
        }

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
                let Some(hit) = hit_from(result) else {
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
                    cursor.hits.push(hit);
                }
            }
        }

        Ok(cursor
            .hits
            .iter()
            .skip(query.offset)
            .take(query.limit)
            .cloned()
            .collect())
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
        SearchOrder::Recent => OrderBy::Recent,
    });
    criteria.event_context.before_limit = UInt::MIN;
    criteria.event_context.after_limit = UInt::MIN;
    criteria.event_context.include_profile = false;

    let mut categories = Categories::new();
    categories.room_events = Some(criteria);

    let mut request = Request::new(categories);
    request.next_batch = next_batch.map(ToOwned::to_owned);
    request
}

fn hit_from(result: &SearchResult) -> Option<Hit> {
    let AnyTimelineEvent::MessageLike(AnyMessageLikeEvent::RoomMessage(message)) =
        result.result.as_ref()?.deserialize().ok()?
    else {
        return None;
    };
    let original = message.as_original()?;

    Some(Hit {
        room_id: original.room_id.clone(),
        event_id: original.event_id.clone(),
        body: indexable_body(original.content.body()),
        sender: original.sender.clone(),
        origin_server_ts: original.origin_server_ts.get().into(),
        score: result.rank.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{room_id, user_id};

    use super::expressible;
    use crate::protocol::{SearchAttachment, SearchFilter};

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
