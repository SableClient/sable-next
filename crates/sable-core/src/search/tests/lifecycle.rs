use matrix_sdk::deserialized_responses::{
    TimelineEvent, UnableToDecryptInfo, UnableToDecryptReason,
};
use matrix_sdk::event_cache::{EventCacheDropHandles, RoomEventCache};
use matrix_sdk::ruma::events::AnyTimelineEvent;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedRoomId, room_id};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_test::async_test;
use serde_json::{Value, json};
use std::sync::Arc;

use super::in_room;
use crate::search::MessageIndex;

const KRIS: &str = "@kris:localhost";

struct Fixture {
    _server: MatrixMockServer,
    _room: matrix_sdk::Room,
    _drop: Arc<EventCacheDropHandles>,
    cache: RoomEventCache,
    room_id: OwnedRoomId,
    index: MessageIndex,
}

impl Fixture {
    async fn new() -> Self {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!lifecycle:localhost").to_owned();
        let room = server.sync_joined_room(&client, &room_id).await;
        let (cache, drop) = client
            .event_cache()
            .unwrap()
            .room(&room_id)
            .await
            .expect("room event cache");
        Self {
            _server: server,
            _room: room,
            _drop: drop,
            cache,
            room_id,
            index: MessageIndex::new(),
        }
    }

    async fn crawled(&self, events: Vec<Value>) {
        let events = events.into_iter().map(|value| event(&value)).collect();
        self.index
            .ingest_with(
                &self.room_id,
                events,
                &self.cache,
                &RedactionRules::V11,
                true,
            )
            .await
            .expect("the index takes the events");
    }

    async fn refuse(&self, change: &str) {
        self.index
            .store()
            .rows(sable_sql::statement!(format!(
                "CREATE TRIGGER refusal BEFORE {change} ON doc
                 BEGIN SELECT RAISE(ABORT, 'refused'); END"
            )))
            .await
            .expect("trigger");
    }

    async fn allow(&self) {
        self.index
            .store()
            .rows(sable_sql::statement!("DROP TRIGGER refusal"))
            .await
            .expect("trigger");
    }

    async fn refused(&self, value: &Value) {
        self.index
            .ingest_with(
                &self.room_id,
                vec![event(value)],
                &self.cache,
                &RedactionRules::V11,
                true,
            )
            .await
            .expect_err("the database refuses the write");
    }

    async fn live(&self, events: Vec<TimelineEvent>) {
        self.index
            .ingest(&self.room_id, events, &self.cache, &RedactionRules::V11)
            .await;
    }

    fn found(&self, query: &str) -> Vec<String> {
        in_room(&self.index, &self.room_id, query, 20, 0)
            .into_iter()
            .map(|hit| hit.event_id.to_string())
            .collect()
    }

    fn assert_none(&self, query: &str) {
        assert_eq!(self.found(query), Vec::<String>::new());
    }

    fn body_of(&self, query: &str) -> Option<String> {
        in_room(&self.index, &self.room_id, query, 20, 0)
            .into_iter()
            .next()
            .map(|hit| hit.body)
    }
}

fn event(value: &Value) -> TimelineEvent {
    TimelineEvent::from_plaintext(Raw::new(value).unwrap().cast_unchecked())
}

fn message(id: &str, ts: u64, body: &str) -> Value {
    json!({
        "type": "m.room.message",
        "event_id": id,
        "sender": KRIS,
        "origin_server_ts": ts,
        "content": { "msgtype": "m.text", "body": body }
    })
}

fn edit(id: &str, target: &str, ts: u64, body: &str) -> Value {
    json!({
        "type": "m.room.message",
        "event_id": id,
        "sender": KRIS,
        "origin_server_ts": ts,
        "content": {
            "msgtype": "m.text",
            "body": format!("* {body}"),
            "m.new_content": { "msgtype": "m.text", "body": body },
            "m.relates_to": { "rel_type": "m.replace", "event_id": target }
        }
    })
}

fn redaction(id: &str, target: &str, ts: u64) -> Value {
    json!({
        "type": "m.room.redaction",
        "event_id": id,
        "sender": KRIS,
        "origin_server_ts": ts,
        "redacts": target,
        "content": { "redacts": target }
    })
}

fn with_unsigned(mut value: Value, unsigned: Value) -> Value {
    value["unsigned"] = unsigned;
    value
}

#[async_test]
async fn test_a_message_the_database_refused_is_taken_in_again() {
    let fixture = Fixture::new().await;
    let kept = message("$kept", 1_000, "refused marmalade");

    fixture.refuse("INSERT").await;
    fixture.refused(&kept).await;
    fixture.allow().await;
    fixture.crawled(vec![kept]).await;

    assert_eq!(fixture.found("marmalade"), ["$kept"]);
}

#[async_test]
async fn test_a_redaction_the_database_refused_is_applied_again() {
    let fixture = Fixture::new().await;
    fixture
        .crawled(vec![message("$gone", 1_000, "refused marmalade")])
        .await;
    let redaction = redaction("$redaction", "$gone", 2_000);

    fixture.refuse("DELETE").await;
    fixture.refused(&redaction).await;
    assert_eq!(fixture.found("marmalade"), ["$gone"]);
    fixture.allow().await;
    fixture.crawled(vec![redaction]).await;

    fixture.assert_none("marmalade");
}

#[async_test]
async fn test_a_redaction_removes_the_document_its_context_and_its_attachment_page() {
    let fixture = Fixture::new().await;
    fixture
        .crawled(vec![
            message("$before", 1_000, "context before"),
            json!({
                "type": "m.room.message",
                "event_id": "$picture",
                "sender": KRIS,
                "origin_server_ts": 2_000,
                "content": {
                    "msgtype": "m.image",
                    "body": "sunset.png",
                    "url": "mxc://localhost/sunset"
                }
            }),
            message("$after", 3_000, "context after"),
        ])
        .await;
    assert_eq!(fixture.found("sunset").len(), 1);

    fixture
        .crawled(vec![redaction("$redaction", "$picture", 4_000)])
        .await;

    fixture.assert_none("sunset");
    let mut hits = in_room(&fixture.index, &fixture.room_id, "after", 10, 0);
    fixture.index.context(&mut hits, &[], 3);
    assert!(
        hits[0]
            .before
            .iter()
            .all(|line| line.event_id != "$picture"),
        "a redacted message is not a context line"
    );
    let pages = super::attachment_pages(&fixture.index, &fixture.room_id, &[], 10);
    assert!(pages.iter().all(Vec::is_empty));
}

#[async_test]
async fn test_a_redaction_found_in_a_gap_removes_an_indexed_message() {
    let fixture = Fixture::new().await;
    fixture
        .crawled(vec![message("$gone", 1_000, "regrettable sentence")])
        .await;
    assert_eq!(fixture.found("regrettable").len(), 1);

    fixture
        .crawled(vec![redaction("$redaction", "$gone", 2_000)])
        .await;

    fixture.assert_none("regrettable");
}

#[async_test]
async fn test_a_refetched_original_with_redacted_because_removes_the_document() {
    let fixture = Fixture::new().await;
    fixture
        .crawled(vec![message("$gone", 1_000, "regrettable sentence")])
        .await;

    let refetched = with_unsigned(
        json!({
            "type": "m.room.message",
            "event_id": "$gone",
            "sender": KRIS,
            "origin_server_ts": 1_000,
            "content": {}
        }),
        json!({ "redacted_because": redaction("$redaction", "$gone", 2_000) }),
    );
    fixture.crawled(vec![refetched]).await;

    fixture.assert_none("regrettable");
}

#[async_test]
async fn test_a_refetched_original_with_emptied_content_removes_the_document() {
    let fixture = Fixture::new().await;
    fixture
        .crawled(vec![message("$gone", 1_000, "regrettable sentence")])
        .await;

    fixture
        .crawled(vec![json!({
            "type": "m.room.message",
            "event_id": "$gone",
            "sender": KRIS,
            "origin_server_ts": 1_000,
            "content": {}
        })])
        .await;

    fixture.assert_none("regrettable");
}

#[async_test]
async fn test_an_edit_replaces_the_body_of_an_indexed_original() {
    let fixture = Fixture::new().await;
    fixture
        .crawled(vec![message("$m", 1_000, "the deploy pipeline is broken")])
        .await;
    fixture
        .crawled(vec![edit("$e", "$m", 2_000, "the rollback finished")])
        .await;

    assert_eq!(fixture.found("rollback"), ["$m"]);
    fixture.assert_none("deploy");
}

#[async_test]
async fn test_an_original_reached_by_a_later_backfill_has_its_edited_text() {
    let fixture = Fixture::new().await;
    fixture
        .crawled(vec![edit("$e", "$m", 2_000, "the rollback finished")])
        .await;
    fixture.assert_none("rollback");

    fixture
        .crawled(vec![message("$m", 1_000, "the deploy pipeline is broken")])
        .await;

    assert_eq!(fixture.found("rollback"), ["$m"]);
    fixture.assert_none("deploy");
}

#[async_test]
async fn test_the_newest_edit_wins_whatever_order_the_edits_arrive_in() {
    let fixture = Fixture::new().await;
    fixture
        .crawled(vec![message("$m", 1_000, "first draft")])
        .await;
    fixture
        .crawled(vec![edit("$e2", "$m", 3_000, "second draft")])
        .await;
    fixture
        .crawled(vec![edit("$e1", "$m", 2_000, "intermediate draft")])
        .await;

    assert_eq!(fixture.body_of("draft").as_deref(), Some("second draft"));
    fixture.assert_none("intermediate");

    fixture
        .crawled(vec![edit("$e3", "$m", 4_000, "final draft")])
        .await;
    assert_eq!(fixture.body_of("draft").as_deref(), Some("final draft"));
    fixture.assert_none("second");
}

#[async_test]
async fn test_an_edit_bundled_in_the_original_is_applied() {
    let fixture = Fixture::new().await;
    let bundled = edit("$e", "$m", 2_000, "the rollback finished");
    let original = with_unsigned(
        message("$m", 1_000, "the deploy pipeline is broken"),
        json!({ "m.relations": { "m.replace": bundled } }),
    );

    fixture.crawled(vec![original]).await;

    assert_eq!(fixture.found("rollback"), ["$m"]);
    fixture.assert_none("deploy");
}

#[async_test]
async fn test_an_edit_of_a_redacted_original_stays_removed() {
    let fixture = Fixture::new().await;
    fixture
        .crawled(vec![message("$m", 1_000, "first draft")])
        .await;
    fixture.crawled(vec![redaction("$r", "$m", 2_000)]).await;
    fixture
        .crawled(vec![edit("$e", "$m", 3_000, "second draft")])
        .await;

    fixture.assert_none("draft");
}

#[async_test]
async fn test_an_undecryptable_event_is_indexed_once_it_decrypts() {
    let fixture = Fixture::new().await;
    let sealed = json!({
        "type": "m.room.encrypted",
        "event_id": "$sealed",
        "sender": KRIS,
        "origin_server_ts": 1_000,
        "content": {
            "algorithm": "m.megolm.v1.aes-sha2",
            "session_id": "late",
            "ciphertext": "x"
        }
    });
    let undecryptable = TimelineEvent::from_utd(
        Raw::new(&sealed).unwrap().cast_unchecked(),
        UnableToDecryptInfo {
            session_id: Some("late".to_owned()),
            reason: UnableToDecryptReason::Unknown,
        },
    );
    fixture.live(vec![undecryptable]).await;
    assert!(
        !fixture
            .index
            .store()
            .is_classified(&fixture.room_id, "$sealed")
            .await
            .unwrap(),
        "an undecryptable event must stay unclassified"
    );

    fixture
        .live(vec![event(&message(
            "$sealed",
            1_000,
            "late arriving words",
        ))])
        .await;

    assert_eq!(fixture.found("arriving"), ["$sealed"]);
}

fn raw_event(value: &Value) -> Raw<AnyTimelineEvent> {
    Raw::new(value).unwrap().cast_unchecked()
}

#[async_test]
async fn test_redacting_the_latest_edit_of_a_message_outside_the_cache_asks_the_homeserver() {
    use matrix_sdk::test_utils::mocks::RoomMessagesResponseTemplate;
    use matrix_sdk_test::JoinedRoomBuilder;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!refetch:localhost").to_owned();
    server.mock_room_state_encryption().plain().mount().await;
    let _room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(&room_id)
                .set_timeline_limited()
                .set_timeline_prev_batch("previous"),
        )
        .await;

    let now = crate::search::now_ms();
    let after_first_edit = with_unsigned(
        message("$m", now + 1000, "first draft"),
        json!({ "m.relations": { "m.replace": edit("$e1", "$m", now + 2000, "second draft") } }),
    );
    server
        .mock_room_messages()
        .ok(RoomMessagesResponseTemplate::default().events(vec![
            raw_event(&redaction("$r", "$e2", now + 4000)),
            raw_event(&edit("$e2", "$m", now + 3000, "third draft")),
            raw_event(&edit("$e1", "$m", now + 2000, "second draft")),
            raw_event(&message("$m", now + 1000, "first draft")),
        ]))
        .mock_once()
        .mount()
        .await;
    server
        .mock_room_event()
        .ok(event(&after_first_edit))
        .mock_once()
        .mount()
        .await;

    let (core, _events) = crate::Core::new(
        "search-refetch",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    crate::test_support::sign_in(&core, &server, client.clone()).await;
    let session = core.signed_in().unwrap();
    session.crawl_once(&room_id).await.expect("crawl");

    let hits = in_room(
        &*session.state().search_index.lock().await,
        &room_id,
        "draft",
        10,
        0,
    );
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].body, "second draft");
}

async fn core_with_room(
    name: &str,
) -> (
    MatrixMockServer,
    matrix_sdk::Client,
    OwnedRoomId,
    Arc<crate::Core>,
) {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!gap:localhost").to_owned();
    server.mock_room_state_encryption().plain().mount().await;
    server.sync_joined_room(&client, &room_id).await;
    let (core, _events) =
        crate::Core::new(name, Box::new(crate::store::MemorySessionStore::default()));
    crate::test_support::sign_in(&core, &server, client.clone()).await;
    (server, client, room_id, core)
}

async fn index_crawled(
    core: &Arc<crate::Core>,
    client: &matrix_sdk::Client,
    room_id: &OwnedRoomId,
    events: Vec<Value>,
) {
    let session = core.signed_in().unwrap();
    let (cache, _drop) = client.event_cache().unwrap().room(room_id).await.unwrap();
    session
        .state()
        .search_index
        .lock()
        .await
        .ingest_with(
            room_id,
            events.into_iter().map(|value| event(&value)).collect(),
            &cache,
            &RedactionRules::V11,
            true,
        )
        .await
        .expect("the index takes the events");
}

fn hits(core: &Arc<crate::Core>, room_id: &OwnedRoomId, query: &str) -> usize {
    let session = core.signed_in().unwrap();
    let session_state = session.state();
    let index = session_state.search_index.try_lock().unwrap();
    in_room(&index, room_id, query, 50, 0).len()
}

#[async_test]
async fn test_a_limited_sync_leaves_a_hole_the_crawler_fills_forward() {
    use matrix_sdk::test_utils::mocks::{
        RoomContextResponseTemplate, RoomMessagesResponseTemplate,
    };
    use matrix_sdk_test::JoinedRoomBuilder;

    let (server, client, room_id, core) = core_with_room("search-hole").await;
    let session = core.signed_in().unwrap();
    let now = crate::search::now_ms();
    let old: Vec<Value> = (1..=10)
        .map(|n| message(&format!("$old{n}"), now + n, &format!("early{n} words")))
        .collect();
    index_crawled(&core, &client, &room_id, old).await;
    assert_eq!(hits(&core, &room_id, "words"), 10);

    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(&room_id)
                .set_timeline_limited()
                .set_timeline_prev_batch("behind")
                .add_timeline_event(event_builder(&room_id, "$live50", now + 50, "live50 words")),
        )
        .await;
    let room = client.get_room(&room_id).unwrap();
    session.index_room_search(&room).await;
    assert_eq!(hits(&core, &room_id, "live50"), 1);
    assert_eq!(hits(&core, &room_id, "gapped"), 0);
    assert!(
        session
            .state()
            .search_crawl
            .lock()
            .holes
            .contains_key(&room_id)
    );

    server
        .mock_room_event_context()
        .ok(
            RoomContextResponseTemplate::new(event(&message("$old10", now + 10, "early10 words")))
                .end("forward"),
        )
        .mock_once()
        .mount()
        .await;
    server
        .mock_room_messages()
        .match_from("forward")
        .ok(RoomMessagesResponseTemplate::default().events(vec![
            raw_event(&message("$gap11", now + 11, "gapped eleven")),
            raw_event(&message("$gap49", now + 49, "gapped forty nine")),
            raw_event(&message("$live50", now + 50, "live50 words")),
        ]))
        .mock_once()
        .mount()
        .await;

    session.crawl_once(&room_id).await.expect("fill");

    assert_eq!(hits(&core, &room_id, "gapped"), 2);
    assert_eq!(hits(&core, &room_id, "live50"), 1);
    assert!(
        !session
            .state()
            .search_crawl
            .lock()
            .holes
            .contains_key(&room_id)
    );
}

fn event_builder(
    room_id: &OwnedRoomId,
    id: &str,
    ts: u64,
    body: &str,
) -> matrix_sdk_test::event_factory::EventBuilder<RoomMessageEventContent> {
    use matrix_sdk::ruma::{EventId, MilliSecondsSinceUnixEpoch, UInt};
    matrix_sdk_test::event_factory::EventFactory::new()
        .room(room_id)
        .sender(matrix_sdk::ruma::user_id!("@kris:localhost"))
        .text_msg(body)
        .event_id(EventId::parse(id).unwrap())
        .server_ts(MilliSecondsSinceUnixEpoch(UInt::try_from(ts).unwrap()))
}

#[async_test]
async fn test_resumed_backfill_skips_what_is_indexed_and_what_the_budget_evicted() {
    let fixture = Fixture::new().await;
    fixture
        .index
        .store()
        .set_floor(&fixture.room_id, 5_000)
        .await
        .unwrap();
    let page = || {
        vec![
            message("$newer", 7_000, "newer words"),
            message("$kept", 6_000, "kept words"),
            message("$evicted", 1_000, "evicted words"),
        ]
    };

    fixture.crawled(page()).await;
    fixture.crawled(page()).await;

    assert_eq!(fixture.found("newer"), ["$newer"]);
    assert_eq!(fixture.found("kept"), ["$kept"]);
    fixture.assert_none("evicted");
    assert_eq!(fixture.index.documents().await, 2);
}

#[async_test]
async fn test_a_ban_removal_drops_the_users_messages_in_its_range_now_and_when_backfilled() {
    use crate::search::store::Removal;

    let fixture = Fixture::new().await;
    fixture
        .crawled(vec![
            message("$before", 1_000, "before words"),
            message("$during", 3_000, "during words"),
            message("$after", 6_000, "after words"),
        ])
        .await;

    fixture
        .index
        .store()
        .apply_removal(
            &fixture.room_id,
            Removal {
                sender: matrix_sdk::ruma::user_id!("@kris:localhost").to_owned(),
                after: 2_000,
                until: 5_000,
            },
        )
        .await
        .unwrap();
    fixture
        .crawled(vec![message("$backfilled", 4_000, "backfilled words")])
        .await;

    let mut found = fixture.found("words");
    found.sort();
    assert_eq!(found, ["$after", "$before"]);
}

#[async_test]
async fn test_a_poll_edit_replaces_the_question_and_answers() {
    let fixture = Fixture::new().await;
    let poll = |id: &str, ts: u64, question: &str, answer: &str| {
        json!({
            "type": "org.matrix.msc3381.poll.start",
            "event_id": id,
            "sender": KRIS,
            "origin_server_ts": ts,
            "content": {
                "org.matrix.msc3381.poll.start": {
                    "question": { "org.matrix.msc1767.text": question },
                    "kind": "org.matrix.msc3381.poll.disclosed",
                    "max_selections": 1,
                    "answers": [{ "id": "a", "org.matrix.msc1767.text": answer }]
                }
            }
        })
    };
    fixture
        .crawled(vec![poll("$poll", 1_000, "Lunch spot?", "Ramen")])
        .await;
    assert_eq!(fixture.found("ramen"), ["$poll"]);

    let mut replacement = poll("$pollEdit", 2_000, "Dinner spot?", "Tacos");
    let new_content = replacement["content"].clone();
    replacement["content"] = json!({
        "m.new_content": new_content,
        "m.relates_to": { "rel_type": "m.replace", "event_id": "$poll" }
    });
    fixture.crawled(vec![replacement]).await;

    assert_eq!(fixture.found("tacos"), ["$poll"]);
    fixture.assert_none("ramen");
    fixture.assert_none("lunch");
}

#[async_test]
async fn test_ignoring_keeps_the_index_and_unignoring_rewalks_without_wiping_it() {
    let (_server, client, room_id, core) = core_with_room("search-ignore").await;
    let session = core.signed_in().unwrap();
    let now = crate::search::now_ms();
    index_crawled(
        &core,
        &client,
        &room_id,
        vec![message("$kept", now + 1, "troll words")],
    )
    .await;
    let troll = matrix_sdk::ruma::user_id!("@troll:localhost").to_owned();
    session
        .state()
        .search_crawl
        .lock()
        .advance(&room_id, Some("saved".to_owned()));

    session
        .ignored_users_changed(std::slice::from_ref(&troll))
        .await;
    assert!(session.state().search_crawl.lock().has_token(&room_id));
    assert_eq!(hits(&core, &room_id, "troll"), 1);

    session.ignored_users_changed(&[]).await;
    assert!(!session.state().search_crawl.lock().has_token(&room_id));
    assert_eq!(hits(&core, &room_id, "troll"), 1);
}

#[async_test]
async fn test_a_forged_state_event_inside_encryption_is_not_indexed() {
    use matrix_sdk::deserialized_responses::{
        AlgorithmInfo, DecryptedRoomEvent, EncryptionInfo, VerificationState,
    };

    let fixture = Fixture::new().await;
    let forged = json!({
        "type": "m.room.name", "event_id": "$name2", "state_key": "", "sender": KRIS,
        "origin_server_ts": 1_000, "content": { "name": "Forgedname" }
    });
    let decrypted = TimelineEvent::from_decrypted(
        DecryptedRoomEvent {
            event: Raw::new(&forged).unwrap().cast_unchecked(),
            encryption_info: Arc::new(EncryptionInfo {
                sender: matrix_sdk::ruma::user_id!("@kris:localhost").to_owned(),
                sender_device: None,
                forwarder: None,
                algorithm_info: AlgorithmInfo::MegolmV1AesSha2 {
                    curve25519_key: String::new(),
                    sender_claimed_keys: std::collections::BTreeMap::new(),
                    session_id: None,
                },
                verification_state: VerificationState::Verified,
            }),
            unsigned_encryption_info: None,
        },
        None,
    );
    let mut plain = forged;
    plain["event_id"] = json!("$plain");
    fixture.live(vec![decrypted, event(&plain)]).await;

    let count = fixture.index.documents().await;
    assert_eq!(count, 1);
}

#[async_test]
async fn test_an_extensible_text_message_is_indexed_from_the_ingest_path() {
    let fixture = Fixture::new().await;
    fixture
        .crawled(vec![json!({
            "type": "m.message", "event_id": "$ext", "sender": KRIS, "origin_server_ts": 1_000,
            "content": { "m.text": [{ "body": "hello extensible" }] }
        })])
        .await;

    assert_eq!(fixture.found("extensible"), ["$ext"]);
}

#[async_test]
async fn test_a_newer_calendar_version_replaces_the_older_document_and_a_redaction_removes_it() {
    let fixture = Fixture::new().await;
    let calendar = |id: &str, ts: u64, title: &str| {
        json!({
            "type": "chat.commet.calendar_events", "event_id": id, "sender": KRIS,
            "origin_server_ts": ts,
            "content": { "uid": "u1", "start": "2030-01-01T10:00", "title": title }
        })
    };
    fixture
        .crawled(vec![calendar("$v1", 1_000, "Sprint review")])
        .await;
    assert_eq!(fixture.found("sprint"), ["$v1"]);

    fixture.crawled(vec![calendar("$v2", 2_000, "Retro")]).await;
    assert_eq!(fixture.found("retro"), ["$v2"]);
    fixture.assert_none("sprint");

    fixture
        .crawled(vec![calendar("$v0", 500, "Planning")])
        .await;
    fixture.assert_none("planning");

    fixture.crawled(vec![redaction("$r", "$v2", 3_000)]).await;
    fixture.assert_none("retro");
}

#[async_test]
async fn test_a_stable_poll_edit_replaces_the_question_and_answers() {
    let fixture = Fixture::new().await;
    let content = |question: &str, answer: &str| {
        json!({
            "m.text": [{ "body": question }],
            "m.poll": {
                "kind": "m.disclosed",
                "max_selections": 1,
                "question": { "m.text": [{ "body": question }] },
                "answers": [{ "m.id": "a", "m.text": [{ "body": answer }] }]
            }
        })
    };
    let start = |id: &str, ts: u64, content: Value| {
        json!({
            "type": "m.poll.start", "event_id": id, "sender": KRIS,
            "origin_server_ts": ts, "content": content
        })
    };
    fixture
        .crawled(vec![start("$poll", 1_000, content("Lunch spot?", "Ramen"))])
        .await;
    assert_eq!(fixture.found("ramen"), ["$poll"]);

    let mut replacement = content("Dinner spot?", "Tacos");
    replacement["m.new_content"] = content("Dinner spot?", "Tacos");
    replacement["m.relates_to"] = json!({ "rel_type": "m.replace", "event_id": "$poll" });
    fixture
        .crawled(vec![start("$pollEdit", 2_000, replacement)])
        .await;

    assert_eq!(fixture.found("tacos"), ["$poll"]);
    fixture.assert_none("ramen");
}
