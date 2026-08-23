mod tokenize;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::event_cache::RoomEventCache;
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::events::relation::RelationType;
use matrix_sdk::ruma::events::room::message::{
    OriginalSyncRoomMessageEvent, Relation, sanitize::remove_plain_reply_fallback,
};
use matrix_sdk::ruma::events::{
    AnySyncMessageLikeEvent, AnySyncTimelineEvent, room::redaction::SyncRoomRedactionEvent,
};
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId};
use probly_search::{Index, score::bm25};

use crate::Core;

const BODY_FIELD_COUNT: usize = 1;
const BODY_FIELD_BOOST: [f64; BODY_FIELD_COUNT] = [1.0];
const EVENTS_PER_INGEST_YIELD: usize = 256;
const RETIRED_KEYS_BEFORE_VACUUM: usize = 64;

type DocKey = u32;

struct Body(String);

fn body_field(body: &Body) -> Vec<&str> {
    vec![body.0.as_str()]
}

struct RoomIndex {
    index: Index<DocKey>,
    documents: HashMap<DocKey, (OwnedEventId, String)>,
    key_of: HashMap<OwnedEventId, DocKey>,
    classified: HashSet<OwnedEventId>,
    next_key: DocKey,
    retired_keys: usize,
}

impl RoomIndex {
    fn new() -> Self {
        Self {
            index: Index::new(BODY_FIELD_COUNT),
            documents: HashMap::new(),
            key_of: HashMap::new(),
            classified: HashSet::new(),
            next_key: 0,
            retired_keys: 0,
        }
    }

    fn already_classified(&self, event_id: &EventId) -> bool {
        self.classified.contains(event_id)
    }

    fn mark_classified(&mut self, event_id: OwnedEventId) {
        self.classified.insert(event_id);
    }

    fn indexed_body(&self, event_id: &OwnedEventId) -> Option<&String> {
        let key = self.key_of.get(event_id)?;
        self.documents.get(key).map(|(_, body)| body)
    }

    fn upsert(&mut self, event_id: OwnedEventId, body: String) {
        if self.indexed_body(&event_id) == Some(&body) {
            return;
        }
        self.retire(&event_id);

        let key = self.take_unused_key();
        let body = Body(body);
        self.index
            .add_document(&[body_field], tokenize::tokenize, key, &body);
        self.key_of.insert(event_id.clone(), key);
        self.documents.insert(key, (event_id, body.0));
    }

    fn remove(&mut self, event_id: &OwnedEventId) {
        self.retire(event_id);
        if self.retired_keys >= RETIRED_KEYS_BEFORE_VACUUM {
            self.index.vacuum();
            self.retired_keys = 0;
        }
    }

    fn retire(&mut self, event_id: &OwnedEventId) {
        let Some(key) = self.key_of.remove(event_id) else {
            return;
        };
        self.documents.remove(&key);
        self.index.remove_document(key);
        self.retired_keys = self.retired_keys.saturating_add(1);
    }

    const fn take_unused_key(&mut self) -> DocKey {
        let key = self.next_key;
        self.next_key = self.next_key.wrapping_add(1);
        key
    }

    fn matches<'index>(
        &'index self,
        room_id: &'index OwnedRoomId,
        query: &str,
    ) -> Vec<Ranked<'index>> {
        self.index
            .query(
                query,
                &mut bm25::new(),
                tokenize::tokenize,
                &BODY_FIELD_BOOST,
            )
            .into_iter()
            .filter_map(|result| {
                Some(Ranked {
                    room_id,
                    event_id: self.documents.get(&result.key)?.0.as_ref(),
                    score: result.score,
                })
            })
            .collect()
    }
}

pub(crate) struct MessageIndex {
    rooms: HashMap<OwnedRoomId, RoomIndex>,
}

pub(crate) struct Hit {
    pub(crate) room_id: OwnedRoomId,
    pub(crate) event_id: OwnedEventId,
    pub(crate) body: String,
    pub(crate) score: f64,
}

struct Ranked<'index> {
    room_id: &'index OwnedRoomId,
    event_id: &'index EventId,
    score: f64,
}

impl MessageIndex {
    pub(crate) fn new() -> Self {
        Self {
            rooms: HashMap::new(),
        }
    }

    pub(crate) fn forget_room(&mut self, room_id: &OwnedRoomId) {
        self.rooms.remove(room_id);
    }

    pub(crate) fn search_room(
        &self,
        room_id: &OwnedRoomId,
        query: &str,
        limit: usize,
        offset: usize,
    ) -> Vec<Hit> {
        let ranked = self
            .rooms
            .get(room_id)
            .map(|index| index.matches(room_id, query))
            .unwrap_or_default();

        self.materialize(page_ranked(ranked, limit, offset))
    }

    pub(crate) fn search_all(&self, query: &str, limit: usize, offset: usize) -> Vec<Hit> {
        let ranked = self
            .rooms
            .iter()
            .flat_map(|(room_id, index)| index.matches(room_id, query))
            .collect();

        self.materialize(page_ranked(ranked, limit, offset))
    }

    fn materialize(&self, ranked: Vec<Ranked<'_>>) -> Vec<Hit> {
        ranked
            .into_iter()
            .filter_map(|entry| {
                let index = self.rooms.get(entry.room_id)?;
                let key = index.key_of.get(entry.event_id)?;
                let (event_id, body) = index.documents.get(key)?;
                Some(Hit {
                    room_id: entry.room_id.clone(),
                    event_id: event_id.clone(),
                    body: body.clone(),
                    score: entry.score,
                })
            })
            .collect()
    }

    pub(crate) async fn ingest(
        &mut self,
        room_id: &OwnedRoomId,
        events: Vec<TimelineEvent>,
        cache: &RoomEventCache,
        rules: &RedactionRules,
    ) {
        let index = self
            .rooms
            .entry(room_id.clone())
            .or_insert_with(RoomIndex::new);

        for (position, event) in events.into_iter().enumerate() {
            if position > 0 && position.is_multiple_of(EVENTS_PER_INGEST_YIELD) {
                matrix_sdk::sleep::sleep(Duration::ZERO).await;
            }

            let Some(event_id) = event.event_id() else {
                continue;
            };

            if index.already_classified(event_id) || event.kind.is_utd() {
                continue;
            }
            index.mark_classified(event_id.to_owned());

            let Ok(AnySyncTimelineEvent::MessageLike(message)) = event.raw().deserialize() else {
                continue;
            };

            match message {
                AnySyncMessageLikeEvent::RoomMessage(message) => {
                    let Some(original) = message.as_original() else {
                        continue;
                    };
                    let target = edited_or_own_event_id(original);
                    let body = latest_body(cache, &target)
                        .await
                        .unwrap_or_else(|| indexable_body(original.content.body()));

                    index.upsert(target, body);
                }

                AnySyncMessageLikeEvent::RoomRedaction(redaction) => {
                    if let Some(redacted) = redacted_event_id(&redaction, rules) {
                        index.remove(&redacted);
                    }
                }

                _ => {}
            }
        }
    }
}

fn by_rank(left: &Ranked<'_>, right: &Ranked<'_>) -> std::cmp::Ordering {
    right
        .score
        .partial_cmp(&left.score)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| left.event_id.cmp(right.event_id))
}

fn page_ranked(mut ranked: Vec<Ranked<'_>>, limit: usize, offset: usize) -> Vec<Ranked<'_>> {
    let wanted = offset.saturating_add(limit);

    if wanted < ranked.len() {
        ranked.select_nth_unstable_by(wanted, by_rank);
        ranked.truncate(wanted);
    }
    ranked.sort_unstable_by(by_rank);

    ranked.drain(..offset.min(ranked.len()));
    ranked.truncate(limit);
    ranked
}

fn edited_or_own_event_id(original: &OriginalSyncRoomMessageEvent) -> OwnedEventId {
    match &original.content.relates_to {
        Some(Relation::Replacement(replacement)) => replacement.event_id.clone(),
        _ => original.event_id.clone(),
    }
}

fn indexable_body(body: &str) -> String {
    remove_plain_reply_fallback(body).to_owned()
}

fn redacted_event_id(
    redaction: &SyncRoomRedactionEvent,
    rules: &RedactionRules,
) -> Option<OwnedEventId> {
    let original = redaction.as_original()?;
    let (preferred, fallback) = if rules.content_field_redacts {
        (&original.content.redacts, &original.redacts)
    } else {
        (&original.redacts, &original.content.redacts)
    };
    preferred.clone().or_else(|| fallback.clone())
}

async fn latest_body(cache: &RoomEventCache, event_id: &OwnedEventId) -> Option<String> {
    let (original, replacements) = cache
        .find_event_with_relations(event_id, Some(vec![RelationType::Replacement]))
        .await
        .ok()
        .flatten()?;

    let newest = replacements.last().unwrap_or(&original);
    let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(message)) =
        newest.raw().deserialize().ok()?
    else {
        return None;
    };

    let original = message.as_original()?;
    match &original.content.relates_to {
        Some(Relation::Replacement(replacement)) => {
            Some(indexable_body(replacement.new_content.msgtype.body()))
        }
        _ => Some(indexable_body(original.content.body())),
    }
}

impl Core {
    pub(crate) fn watch_ignored_users(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let core = self.clone();
        let mut changes = client.subscribe_to_ignore_user_list_changes();

        self.track_session_task(
            spawn(async move {
                while changes.next().await.is_some() {
                    *core.search_index.lock().await = MessageIndex::new();
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) fn watch_search_index(self: &Arc<Self>, client: &matrix_sdk::Client) {
        let core = self.clone();
        let client = client.clone();

        self.track_session_task(
            spawn(async move {
                let mut updates = client.event_cache().subscribe_to_room_generic_updates();

                loop {
                    let room_id = match updates.recv().await {
                        Ok(update) => update.room_id,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };

                    let Some(room) = client.get_room(&room_id) else {
                        core.search_index.lock().await.forget_room(&room_id);
                        continue;
                    };

                    let Ok((cache, _drop_handles)) = client.event_cache().room(&room_id).await
                    else {
                        continue;
                    };
                    let Ok(events) = cache.events().await else {
                        continue;
                    };

                    let rules = room.clone_info().room_version_rules_or_default().redaction;
                    core.search_index
                        .lock()
                        .await
                        .ingest(&room_id, events, &cache, &rules)
                        .await;
                }
            })
            .abort_on_drop(),
        );
    }
}

#[cfg(test)]
#[allow(clippy::large_futures)]
mod tests {
    use matrix_sdk::ruma::room_version_rules::RedactionRules;
    use matrix_sdk::ruma::{
        EventId, event_id, events::room::message::RoomMessageEventContentWithoutRelation, room_id,
        user_id,
    };
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::{JoinedRoomBuilder, async_test, event_factory::EventFactory};

    use super::MessageIndex;

    async fn reingest_whole_room(
        index: &mut MessageIndex,
        cache: &matrix_sdk::event_cache::RoomEventCache,
        room_id: &matrix_sdk::ruma::OwnedRoomId,
    ) {
        let events = cache.events().await.expect("cached events");
        index
            .ingest(room_id, events, cache, &RedactionRules::V11)
            .await;
    }

    #[async_test]
    async fn test_an_encrypted_rooms_plaintext_is_searchable_and_edits_replace_the_body() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!search:localhost").to_owned();
        let original_id = event_id!("$original");
        let edit_id = event_id!("$edit");

        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("the deploy pipeline is broken")
                        .event_id(original_id),
                ),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;

        let hits = index.search_room(&room_id, "deploying", 10, 0);
        assert_eq!(hits.len(), 1, "{hits:?}", hits = hits.len());
        assert_eq!(hits[0].event_id, original_id);

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .text_msg("* the rollback finished")
                        .edit(
                            original_id,
                            RoomMessageEventContentWithoutRelation::text_plain(
                                "the rollback finished",
                            ),
                        )
                        .event_id(edit_id),
                ),
            )
            .await;

        reingest_whole_room(&mut index, &cache, &room_id).await;

        assert!(
            index.search_room(&room_id, "deploying", 10, 0).is_empty(),
            "an edited message must not still match its old body"
        );

        let hits = index.search_room(&room_id, "rollback", 10, 0);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].event_id, original_id);
        assert_eq!(hits[0].body, "the rollback finished");

        drop(room);
    }

    #[test]
    fn test_a_replys_quoted_fallback_is_not_indexed() {
        let replied = super::indexable_body(
            "> <@erwan:localhost> the deploy pipeline is broken\n\nlooking at it now",
        );
        assert_eq!(replied, "looking at it now");

        assert_eq!(
            super::indexable_body("> * <@erwan:localhost> waves\n\nhello"),
            "hello"
        );
        assert_eq!(
            super::indexable_body("> not a fallback, just a quote"),
            "> not a fallback, just a quote"
        );
    }

    #[async_test]
    async fn test_a_redaction_drops_the_message_from_the_index() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!redact:localhost").to_owned();
        let target_id = event_id!("$target");

        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_timeline_event(factory.text_msg("regrettable").event_id(target_id)),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;
        assert_eq!(index.search_room(&room_id, "regrettable", 10, 0).len(), 1);

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id).add_timeline_event(
                    factory
                        .redaction(target_id)
                        .event_id(event_id!("$redaction")),
                ),
            )
            .await;

        reingest_whole_room(&mut index, &cache, &room_id).await;

        assert!(
            index.search_room(&room_id, "regrettable", 10, 0).is_empty(),
            "a redacted message must leave no indexed body behind"
        );

        drop(room);
    }

    #[async_test]
    async fn test_pagination_walks_one_ordering_without_repeating_a_hit() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!paging:localhost").to_owned();
        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        let ids = ["$page0", "$page1", "$page2", "$page3", "$page4"];
        let mut builder = JoinedRoomBuilder::new(&room_id);
        for (position, raw_id) in ids.iter().enumerate() {
            let id = EventId::parse(*raw_id).expect("test event id");
            builder = builder.add_timeline_event(
                factory
                    .text_msg(format!("paginate this {position}"))
                    .event_id(&id),
            );
        }
        server.sync_room(&client, builder).await;

        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;

        let ids =
            |hits: Vec<super::Hit>| hits.into_iter().map(|hit| hit.event_id).collect::<Vec<_>>();

        let first = ids(index.search_room(&room_id, "paginate", 2, 0));
        let second = ids(index.search_room(&room_id, "paginate", 2, 2));
        let last = ids(index.search_room(&room_id, "paginate", 2, 4));
        assert_eq!(first.len(), 2);
        assert_eq!(second.len(), 2);
        assert_eq!(last.len(), 1, "five matches paged two at a time");

        let mut walked: Vec<_> = first.iter().chain(&second).chain(&last).cloned().collect();
        let seen = walked.len();
        walked.sort();
        walked.dedup();
        assert_eq!(walked.len(), seen, "paging repeated a hit");

        assert_eq!(
            first,
            ids(index.search_room(&room_id, "paginate", 2, 0)),
            "the same page must come back twice"
        );

        drop(room);
    }

    #[async_test]
    async fn test_leaving_a_room_forgets_its_documents() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().expect("event cache");

        let room_id = room_id!("!forget:localhost").to_owned();
        let room = server.sync_joined_room(&client, &room_id).await;
        let factory = EventFactory::new()
            .room(&room_id)
            .sender(user_id!("@erwan:localhost"));

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(&room_id)
                    .add_timeline_event(factory.text_msg("secret").event_id(event_id!("$secret"))),
            )
            .await;

        let (cache, _drop) = client
            .event_cache()
            .room(&room_id)
            .await
            .expect("room event cache");
        let mut index = MessageIndex::new();
        reingest_whole_room(&mut index, &cache, &room_id).await;
        assert_eq!(index.search_room(&room_id, "secret", 10, 0).len(), 1);

        index.forget_room(&room_id);

        assert!(index.search_room(&room_id, "secret", 10, 0).is_empty());
        assert!(index.search_all("secret", 10, 0).is_empty());

        drop(room);
    }
}

#[cfg(test)]
mod stress {
    use std::time::Instant;

    use matrix_sdk::ruma::{EventId, OwnedEventId};

    use super::RoomIndex;

    const VOCABULARY: &[&str] = &[
        "deploy",
        "pipeline",
        "broken",
        "staging",
        "cluster",
        "release",
        "morning",
        "review",
        "merged",
        "reverted",
        "flaky",
        "timeout",
        "migration",
        "rollback",
        "incident",
        "postmortem",
        "dashboard",
        "latency",
        "throughput",
        "regression",
        "hotfix",
        "canary",
        "rollout",
        "database",
        "schema",
        "index",
        "query",
        "cache",
        "invalidate",
        "session",
        "token",
        "refresh",
        "encrypt",
        "decrypt",
        "verify",
        "device",
        "keys",
        "backup",
        "recovery",
        "timeline",
        "composer",
        "reaction",
        "thread",
        "redaction",
        "invite",
        "membership",
        "notification",
        "receipt",
        "presence",
        "typing",
    ];

    fn message(seed: usize) -> String {
        let mut state = seed.wrapping_mul(2_654_435_761);
        let mut words = Vec::with_capacity(12);
        for _ in 0..12 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let pick = (state >> 33) % VOCABULARY.len();
            words.push(VOCABULARY.get(pick).copied().unwrap_or("message"));
        }
        if seed.is_multiple_of(SELECTIVE_IN) {
            words.push(SELECTIVE_TERM);
        }
        words.join(" ")
    }

    const SELECTIVE_IN: usize = 500;

    const SELECTIVE_TERM: &str = "zanzibar";

    fn event_id(seed: usize) -> OwnedEventId {
        EventId::parse(format!("$stress{seed}:localhost")).expect("generated event id")
    }

    fn room_id() -> matrix_sdk::ruma::OwnedRoomId {
        matrix_sdk::ruma::RoomId::parse("!stress:localhost").expect("room id")
    }

    fn approximate_resident_kib() -> usize {
        std::fs::read_to_string("/proc/self/statm")
            .ok()
            .and_then(|statm| {
                let pages: usize = statm.split_whitespace().nth(1)?.parse().ok()?;
                Some(pages.saturating_mul(4))
            })
            .unwrap_or(0)
    }

    fn report(count: usize) {
        let before = approximate_resident_kib();

        let mut index = RoomIndex::new();
        let started = Instant::now();
        for seed in 0..count {
            index.upsert(event_id(seed), message(seed));
        }
        let indexing = started.elapsed();

        let resident = approximate_resident_kib().saturating_sub(before);

        let started = Instant::now();
        let matched = index
            .index
            .query(
                "deploy",
                &mut super::bm25::new(),
                super::tokenize::tokenize,
                &super::BODY_FIELD_BOOST,
            )
            .len();
        let raw = started.elapsed();

        let room = room_id();
        let mut owner = super::MessageIndex::new();
        owner.rooms.insert(room.clone(), index);

        let started = Instant::now();
        let common_hits = owner.search_room(&room, "deploy", 20, 0).len();
        let common = started.elapsed();

        let started = Instant::now();
        let selective_hits = owner.search_room(&room, SELECTIVE_TERM, 20, 0).len();
        let selective = started.elapsed();

        let mut index = owner.rooms.remove(&room).expect("room index");

        let started = Instant::now();
        for seed in 0..(count / 100).max(1) {
            index.upsert(event_id(seed), format!("edited {}", message(seed + 7)));
        }
        let edits = started.elapsed();

        println!(
            "{count:>7} msgs | build {indexing:>8.2?} ({:>5.1?}/msg) | rss {:>4} MiB ({:>4} B/msg) \
             | raw {raw:>8.2?} over {matched:>6} matched \
             | common {common:>8.2?} ({common_hits}) | selective {selective:>8.2?} ({selective_hits}) \
             | {} edits {edits:>8.2?}",
            indexing / u32::try_from(count).unwrap_or(1),
            resident / 1024,
            resident.saturating_mul(1024) / count,
            (count / 100).max(1),
        );
    }

    #[test]
    #[ignore = "measures cost rather than asserting behaviour"]
    fn stress_index_cost_at_realistic_room_sizes() {
        println!();
        for count in [1_000, 10_000, 50_000, 100_000] {
            report(count);
        }
    }
}
