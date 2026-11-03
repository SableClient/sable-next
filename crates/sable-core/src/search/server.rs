use crate::api::search::SearchOrder;
use std::collections::{HashMap, HashSet};

use matrix_sdk::EncryptionState;
use matrix_sdk::Room;
use matrix_sdk::ruma::api::client::filter::RoomEventFilter;
use matrix_sdk::ruma::api::client::search::search_events::v3::{
    Categories, Criteria, OrderBy, Request, SearchKeys, SearchResult,
};
use matrix_sdk::ruma::events::relation::RelationType;
use matrix_sdk::ruma::events::room::message::OriginalSyncRoomMessageEvent;
use matrix_sdk::ruma::events::{
    AnySyncMessageLikeEvent, AnySyncTimelineEvent, AnyTimelineEvent, SyncMessageLikeEvent,
};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{
    EventId, MilliSecondsSinceUnixEpoch, OwnedEventId, OwnedRoomId, OwnedUserId, UInt,
};

use super::IndexFilter;
use super::tokenize::tokenize;
use super::{ContextLine, Hit, edited_or_own_event_id, indexable_body, replacement_of};
use crate::Core;
use crate::messages::latest_valid_replacement;

const MAX_ROUND_TRIPS: usize = 8;

const MAX_PER_REQUEST: u64 = 100;

pub(super) struct ServerQuery<'a> {
    pub(super) room_id: &'a OwnedRoomId,
    pub(super) query: &'a str,
    pub(super) filter: &'a IndexFilter,
    pub(super) order: SearchOrder,
    pub(super) limit: usize,
    pub(super) offset: usize,
    pub(super) context: usize,
}

impl ServerQuery<'_> {
    fn signature(&self) -> Signature {
        Signature {
            query: self.query.to_owned(),
            filter: self.filter.clone(),
            order: self.order,
            room_id: self.room_id.clone(),
            context: self.context,
        }
    }
}

#[derive(Clone, PartialEq)]
struct Signature {
    query: String,
    filter: IndexFilter,
    order: SearchOrder,
    room_id: OwnedRoomId,
    context: usize,
}

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
    filter: &IndexFilter,
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
        let mut seen: HashSet<OwnedEventId> =
            cursor.hits.iter().map(|hit| hit.event_id.clone()).collect();
        let room = client.get_room(query.room_id);

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
                let Some(Candidate { mut hit, edit }) =
                    hit_from(result, query.room_id, query.query)
                else {
                    continue;
                };
                if seen.contains(&hit.event_id) {
                    continue;
                }
                if let Some(edit) = edit {
                    let Some(room) = &room else {
                        continue;
                    };
                    let Some(timestamp) =
                        original_timestamp_if_latest(room, &hit.event_id, &edit).await
                    else {
                        continue;
                    };
                    hit.origin_server_ts = timestamp;
                    hit.before.clear();
                    hit.after.clear();
                }

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
                    seen.insert(hit.event_id.clone());
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

const fn expressible(filter: &IndexFilter) -> bool {
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
        && filter.file_types.is_empty()
        && filter.not_file_types.is_empty()
        && filter.pattern.is_none()
        && filter.state_events.is_none()
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

fn room_message(raw: &Raw<AnyTimelineEvent>) -> Option<OriginalSyncRoomMessageEvent> {
    match raw
        .cast_ref_unchecked::<AnySyncTimelineEvent>()
        .deserialize()
        .ok()?
    {
        AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
            SyncMessageLikeEvent::Original(message),
        )) => Some(message),
        _ => None,
    }
}

fn context_line(raw: &Raw<AnyTimelineEvent>) -> Option<ContextLine> {
    let original = room_message(raw)?;
    if replacement_of(&original).is_some() {
        return None;
    }

    Some(ContextLine {
        body: latest_body(&original).unwrap_or_else(|| indexable_body(original.content.body())),
        event_id: original.event_id,
        sender: original.sender,
        origin_server_ts: original.origin_server_ts.get().into(),
    })
}

fn latest_body(message: &OriginalSyncRoomMessageEvent) -> Option<String> {
    let edit = replacement_of(message.unsigned.relations.replace.as_deref()?)?;
    Some(indexable_body(edit.new_content.msgtype.body()))
}

fn matches_query(query: &str, body: &str) -> bool {
    let terms = tokenize(body);
    tokenize(query)
        .iter()
        .all(|wanted| terms.iter().any(|term| term.starts_with(wanted.as_ref())))
}

/// A search result that matched on an edit stands for the message it replaces, but only
/// once that edit is the replaced message's latest valid one.
struct Candidate {
    hit: Hit,
    edit: Option<OwnedEventId>,
}

fn hit_from(result: &SearchResult, room_id: &OwnedRoomId, query: &str) -> Option<Candidate> {
    let original = room_message(result.result.as_ref()?)?;
    let (edit, edited) = match replacement_of(&original) {
        Some(replacement) => (
            Some(original.event_id.clone()),
            Some(indexable_body(replacement.new_content.msgtype.body())),
        ),
        None => (None, latest_body(&original)),
    };
    if edited
        .as_ref()
        .is_some_and(|body| !matches_query(query, body))
    {
        return None;
    }

    let mut before: Vec<ContextLine> = result
        .context
        .events_before
        .iter()
        .filter_map(context_line)
        .collect();
    before.reverse();

    let hit = Hit {
        room_id: room_id.clone(),
        event_id: edited_or_own_event_id(&original),
        body: edited.unwrap_or_else(|| indexable_body(original.content.body())),
        sender: original.sender,
        origin_server_ts: original.origin_server_ts.get().into(),
        score: result.rank.unwrap_or_default(),
        before,
        after: result
            .context
            .events_after
            .iter()
            .filter_map(context_line)
            .collect(),
    };
    Some(Candidate { hit, edit })
}

async fn original_timestamp_if_latest(
    room: &Room,
    original_id: &EventId,
    edit_id: &EventId,
) -> Option<u64> {
    let (original, replacements) = room
        .load_or_fetch_event_with_relations(
            original_id,
            Some(vec![RelationType::Replacement]),
            None,
        )
        .await
        .ok()?;
    let latest = latest_valid_replacement(&original, &replacements)?;
    if latest.event_id() != Some(edit_id) {
        return None;
    }
    let timestamp = original
        .raw()
        .get_field::<MilliSecondsSinceUnixEpoch>("origin_server_ts")
        .ok()
        .flatten()?;
    Some(timestamp.get().into())
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{OwnedRoomId, room_id, user_id};

    use matrix_sdk::ruma::api::client::search::search_events::v3::SearchResult;
    use serde_json::json;

    use super::super::IndexFilter;
    use super::{expressible, hit_from as candidate_from};
    use crate::protocol::SearchAttachment;

    fn plain_room() -> OwnedRoomId {
        room_id!("!plain:localhost").to_owned()
    }

    fn hit_from(result: &SearchResult, query: &str) -> Option<crate::search::Hit> {
        candidate_from(result, &plain_room(), query).map(|candidate| candidate.hit)
    }

    #[test]
    fn test_an_edit_hit_points_at_the_message_it_replaces() {
        let result: SearchResult = serde_json::from_value(json!({
            "rank": 1.0,
            "result": {
                "type": "m.room.message",
                "event_id": "$edit",
                "room_id": "!plain:localhost",
                "sender": "@kris:localhost",
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

        let hit = hit_from(&result, "deploy").expect("a hit");
        assert_eq!(hit.event_id, "$original");
        assert_eq!(hit.body, "deploy fixed");
    }

    fn edited_original(new_body: &str) -> SearchResult {
        serde_json::from_value(json!({
            "rank": 1.0,
            "result": {
                "type": "m.room.message",
                "event_id": "$original",
                "room_id": "!plain:localhost",
                "sender": "@kris:localhost",
                "origin_server_ts": 1_000,
                "content": { "msgtype": "m.text", "body": "omg mea is doing god's work" },
                "unsigned": {
                    "m.relations": {
                        "m.replace": {
                            "type": "m.room.message",
                            "event_id": "$edit",
                            "sender": "@kris:localhost",
                            "origin_server_ts": 2_000,
                            "content": {
                                "msgtype": "m.text",
                                "body": format!("* {new_body}"),
                                "m.new_content": { "msgtype": "m.text", "body": new_body },
                                "m.relates_to": { "rel_type": "m.replace", "event_id": "$original" }
                            }
                        }
                    }
                }
            }
        }))
        .expect("a search result")
    }

    #[test]
    fn test_an_original_whose_edit_dropped_the_term_is_not_a_hit() {
        let result = edited_original("omg mae is doing god's work");

        assert!(hit_from(&result, "mea").is_none());
    }

    #[test]
    fn test_an_edited_original_that_still_matches_shows_the_new_body() {
        let result = edited_original("omg mea is doing great work");

        let hit = hit_from(&result, "mea").expect("a hit");
        assert_eq!(hit.event_id, "$original");
        assert_eq!(hit.body, "omg mea is doing great work");
    }

    #[test]
    fn test_the_server_context_reads_oldest_first() {
        let message = |id: &str, ts: u64, body: &str| {
            json!({
                "type": "m.room.message",
                "event_id": id,
                "room_id": "!plain:localhost",
                "sender": "@kris:localhost",
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

        let hit = hit_from(&result, "deploy").expect("a hit");
        let ids = |lines: &[super::ContextLine]| {
            lines
                .iter()
                .map(|line| line.event_id.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(&hit.before), ["$first", "$second"]);
        assert_eq!(ids(&hit.after), ["$after"]);
    }

    fn scoped() -> IndexFilter {
        IndexFilter {
            rooms: vec![room_id!("!plain:localhost").to_owned()],
            ..IndexFilter::default()
        }
    }

    #[test]
    fn test_a_sender_scoped_query_survives_the_trip_to_the_homeserver() {
        let filter = IndexFilter {
            senders: vec![user_id!("@kris:localhost").to_owned()],
            ..scoped()
        };

        assert!(expressible(&filter));
    }

    #[test]
    fn test_a_dated_query_stays_local_because_the_wire_cannot_carry_it() {
        let filter = IndexFilter {
            before_ts: Some(1_700_000_000_000),
            ..scoped()
        };

        assert!(!expressible(&filter));
    }

    #[test]
    fn test_an_attachment_query_stays_local() {
        let filter = IndexFilter {
            has: vec![SearchAttachment::Image],
            ..scoped()
        };

        assert!(!expressible(&filter));
    }

    #[test]
    fn test_a_phrase_query_stays_local() {
        let filter = IndexFilter {
            phrases: vec!["exact wording".to_owned()],
            ..scoped()
        };

        assert!(!expressible(&filter));
    }

    fn message(
        id: &str,
        sender: &str,
        ts: u64,
        body: &str,
        relates_to: Option<&str>,
    ) -> serde_json::Value {
        let mut content = json!({"msgtype": "m.text", "body": body});
        if let Some(original) = relates_to {
            content = json!({
                "msgtype": "m.text",
                "body": format!("* {body}"),
                "m.new_content": {"msgtype": "m.text", "body": body},
                "m.relates_to": {"rel_type": "m.replace", "event_id": original}
            });
        }
        json!({
            "type": "m.room.message", "event_id": id, "sender": sender,
            "origin_server_ts": ts, "room_id": "!plain:localhost", "content": content
        })
    }

    async fn search_for_edit(
        found: serde_json::Value,
        relations: Vec<serde_json::Value>,
    ) -> Vec<crate::search::Hit> {
        use std::sync::Arc;

        use matrix_sdk::test_utils::mocks::MatrixMockServer;
        use matrix_sdk_ui::sync_service::SyncService;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};

        use crate::{Core, session::Session, store::MemorySessionStore};

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room = plain_room();
        server.sync_joined_room(&client, &room).await;
        server.mock_room_state_encryption().plain().mount().await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "search_categories": {"room_events": {
                    "count": 1,
                    "results": [{"rank": 1.0, "result": found}]
                }}
            })))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/_matrix/client/v3/rooms/!plain:localhost/event/$original",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(message(
                "$original",
                "@kris:localhost",
                1_000,
                "omg mea is doing god's work",
                None,
            )))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(
                "/_matrix/client/v1/rooms/!plain:localhost/relations/$original/m.replace",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": relations})))
            .mount(server.server())
            .await;

        let (core, _events) = Core::new("search", Box::new(MemorySessionStore::default()));
        *core.session.write().await = Some(Session {
            account_id: "search".to_owned(),
            homeserver: server.server().uri(),
            oauth: false,
            sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
            client: client.clone(),
        });
        let filter = scoped();
        core.search_server(
            &client,
            super::ServerQuery {
                room_id: &room,
                query: "deploy",
                filter: &filter,
                order: crate::api::search::SearchOrder::Recent,
                limit: 10,
                offset: 0,
                context: 0,
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn test_the_latest_edit_hit_carries_the_original_timestamp() {
        let edit = message(
            "$edit",
            "@kris:localhost",
            2_000,
            "deploy fixed",
            Some("$original"),
        );

        let hits = search_for_edit(edit.clone(), vec![edit]).await;

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].event_id, "$original");
        assert_eq!(hits[0].origin_server_ts, 1_000);
        assert_eq!(hits[0].body, "deploy fixed");
    }

    #[tokio::test]
    async fn test_another_users_edit_is_not_a_hit_for_the_message() {
        let forged = message(
            "$forged",
            "@mallory:localhost",
            2_000,
            "deploy now",
            Some("$original"),
        );

        let hits = search_for_edit(forged.clone(), vec![forged]).await;

        assert!(hits.is_empty());
    }

    #[tokio::test]
    async fn test_a_stale_edit_is_not_a_hit_once_a_newer_one_exists() {
        let stale = message(
            "$old",
            "@kris:localhost",
            2_000,
            "deploy old",
            Some("$original"),
        );
        let latest = message(
            "$new",
            "@kris:localhost",
            3_000,
            "mea only",
            Some("$original"),
        );

        let hits = search_for_edit(stale.clone(), vec![latest, stale]).await;

        assert!(hits.is_empty());
    }
}
