use serde_json::json;

use super::*;
#[cfg(not(target_family = "wasm"))]
use crate::usage_history::testing::{signed_in_as, uploads};
use crate::usage_history::{History, MAX_TOTAL, Remote, undated};

const DAY_MS: u64 = 86_400_000;

fn holding(stored: &[Value]) -> History {
    let mut history = History::default();
    let remote = Remote {
        content: Some(json!({"recent_emoji": stored})),
        needs_seal: false,
    };
    history.receive(&EMOJI, remote, crate::now_ms());
    history
}

fn after(stored: &[Value], picks: &[&str]) -> Vec<Value> {
    let mut history = holding(stored);
    for key in picks {
        history.pick(&EMOJI, key, "phone", crate::now_ms());
    }
    history.entries(&EMOJI).into_iter().map(undated).collect()
}

fn picked(keys: &[&str]) -> Vec<Value> {
    after(&[], keys)
}

fn ranked(entries: &[Value]) -> Vec<String> {
    frequent_keys(entries, crate::now_ms())
}

fn dated(emoji: &str, total: u64, uses: &[(u64, u64)]) -> Value {
    let now = crate::now_ms();
    let usage: Vec<Value> = uses
        .iter()
        .map(|(days_ago, count)| {
            let at = now - days_ago * DAY_MS;
            json!({"day": at / DAY_MS, "device": "phone", "count": count, "last_used": at})
        })
        .collect();
    json!({"emoji": emoji, "total": total, "moe.sable.usage": usage})
}

#[test]
fn storage_is_newest_first_while_display_is_by_frequency() {
    let entries = picked(&["🔥", "🔥", "🎉"]);
    assert_eq!(
        entries,
        [
            json!({"emoji": "🎉", "total": 1}),
            json!({"emoji": "🔥", "total": 2}),
        ]
    );
    assert_eq!(ranked(&entries), ["🔥", "🎉"]);
    assert_eq!(ranked(&picked(&["🔥", "🔥", "🎉", "🎉"])), ["🎉", "🔥"]);
}

#[test]
fn frequency_is_over_thirty_days_while_totals_stay_cumulative() {
    let old_favorite = dated("🔥", 502, &[(45, 500), (2, 2)]);
    let current = dated("🎉", 9, &[(3, 9)]);
    assert_eq!(ranked(&[old_favorite, current]), ["🎉", "🔥"]);
}

#[test]
fn one_use_does_not_beat_another_clients_undated_favorite() {
    let picked_once = dated("🎉", 1, &[(0, 1)]);
    let elsewhere = json!({"emoji": "🔥", "total": 84});
    assert_eq!(ranked(&[picked_once, elsewhere]), ["🔥", "🎉"]);
}

#[test]
fn another_clients_uses_count_before_they_are_dated() {
    let bumped = dated("🔥", 506, &[(45, 500)]);
    let current = dated("🎉", 4, &[(3, 4)]);
    assert_eq!(ranked(&[current, bumped]), ["🔥", "🎉"]);
}

#[test]
fn with_nothing_recent_the_all_time_favorites_remain() {
    let lesser = dated("🎉", 3, &[(40, 3)]);
    let favorite = dated("🔥", 9, &[(50, 9)]);
    assert_eq!(ranked(&[lesser, favorite]), ["🔥", "🎉"]);
}

#[test]
fn a_favorite_stays_however_many_others_are_newer() {
    let favorite = [json!({"emoji": "🔥", "total": 5000})];
    let others: Vec<String> = (1..EMOJI.limit)
        .map(|index| format!("mxc://example.org/{index}"))
        .collect();
    let others: Vec<&str> = others.iter().map(String::as_str).collect();
    let shown = ranked(&after(&favorite, &others));
    assert_eq!(shown.len(), FREQUENT_REACTIONS);
    assert_eq!(shown.first().unwrap(), "🔥");
}

#[test]
fn duplicate_variants_share_a_counter_but_skin_tones_remain_distinct() {
    let entries = picked(&["❤", "❤️", "❤︎", "👍", "👍🏽", "mxc://example.org/cat"]);
    assert_eq!(entries.len(), 4);
    assert_eq!(entries.last().unwrap(), &json!({"emoji": "❤︎", "total": 3}));

    let written_elsewhere = EMOJI.read(&json!({"recent_emoji": [
        {"emoji": "🎉", "total": 4}, {"emoji": "❤", "total": 3}, {"emoji": "❤️", "total": 2},
    ]}));
    assert_eq!(ranked(&written_elsewhere), ["❤", "🎉"]);
}

#[test]
fn a_pick_increments_the_total_and_keeps_fields_it_does_not_know() {
    let stored = [json!({"emoji": "🔥", "total": 84, "x.other": true})];
    assert_eq!(
        after(&stored, &["🔥"]),
        [json!({"emoji": "🔥", "total": 85, "x.other": true})]
    );
    let full = [json!({"emoji": "🔥", "total": MAX_TOTAL})];
    assert_eq!(after(&full, &["🔥"]), full);
}

#[test]
fn older_formats_keep_their_totals() {
    let content = json!({"recent_emoji": [
        {"emoji": "🔥", "total": 5000}, ["❤️", 12], "🎉", null, {}, 7
    ]});
    assert_eq!(
        EMOJI.read(&content),
        [
            json!({"emoji": "🔥", "total": 5000}),
            json!({"emoji": "❤️", "total": 12}),
            json!({"emoji": "🎉", "total": 1}),
        ]
    );
}

#[test]
fn unknown_entries_keep_their_place_but_are_never_shown() {
    let foreign = json!({"emoji": "EsTc 1234 abcd efgh", "total": 3, "x.other": true});
    let entries = EMOJI.read(&json!({"recent_emoji": [
        foreign, {"emoji": "🔥", "total": 1}, "+1", "1",
        {"emoji": "negative", "total": -1}, {"emoji": "huge", "total": MAX_TOTAL + 1},
    ]}));
    assert_eq!(
        entries,
        [foreign.clone(), json!({"emoji": "🔥", "total": 1})]
    );
    assert_eq!(ranked(&entries), ["🔥"]);

    assert_eq!(
        after(&entries, &["🔥"]),
        [json!({"emoji": "🔥", "total": 2}), foreign]
    );
}

#[test]
fn the_cap_drops_the_least_recent_entry_whoever_wrote_it() {
    let foreign = json!({"emoji": "other", "total": 1});
    let ours: Vec<String> = (1..EMOJI.limit)
        .map(|index| format!("mxc://example.org/{index}"))
        .collect();
    let mut picks: Vec<&str> = ours.iter().map(String::as_str).collect();
    let stored = [foreign.clone()];
    assert_eq!(after(&stored, &picks).last(), Some(&foreign));

    picks.push("🔥");
    let entries = after(&stored, &picks);
    assert_eq!(entries.len(), EMOJI.limit);
    assert!(!entries.contains(&foreign));
}

#[test]
fn seeding_adds_missing_picks_once_without_inflating_counted_ones() {
    let mut history = holding(&[json!({"emoji": "🔥", "total": 2})]);
    let wave = "mxc://example.org/wave";
    history.seed(&EMOJI, &["🔥", wave, wave].map(str::to_owned));
    assert_eq!(
        history.entries(&EMOJI),
        [
            json!({"emoji": "🔥", "total": 2}),
            json!({"emoji": "mxc://example.org/wave", "total": 1}),
        ]
    );
}

#[tokio::test]
#[cfg(not(target_family = "wasm"))]
async fn reaction_history_records_additions_once_and_survives_a_new_core() {
    use parking_lot::Mutex;
    use std::sync::Arc;

    use crate::api::messages::ReactParams;
    use matrix_sdk::{
        ruma::{event_id, room_id},
        test_utils::mocks::MatrixMockServer,
    };
    use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path_regex},
    };

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    server.mock_room_state_encryption().plain().mount().await;
    let room_id = room_id!("!reactions:example.org");
    let target = event_id!("$message");
    let factory = EventFactory::new().room(room_id).sender(User::Alice);
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(factory.text_msg("Hello").event_id(target)),
        )
        .await;
    server
        .mock_room_send()
        .ok(event_id!("$reaction"))
        .mount()
        .await;

    Mock::given(method("PUT"))
        .and(path_regex("/redact/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$redaction"})))
        .mount(server.server())
        .await;

    let other = json!({"emoji": "x-other-client", "total": 4});
    let stored = Arc::new(Mutex::new(json!({"recent_emoji": [other]})));
    let get = stored.clone();
    Mock::given(method("GET"))
        .and(path_regex("/account_data/m.recent_emoji$"))
        .respond_with(move |_: &wiremock::Request| {
            ResponseTemplate::new(200).set_body_json(get.lock().clone())
        })
        .mount(server.server())
        .await;
    let put = stored.clone();
    Mock::given(method("PUT"))
        .and(path_regex("/account_data/m.recent_emoji$"))
        .respond_with(move |request: &wiremock::Request| {
            *put.lock() = request.body_json().unwrap();
            ResponseTemplate::new(200).set_body_json(json!({}))
        })
        .mount(server.server())
        .await;
    let core = signed_in_as(&server, client.clone()).await;
    let session = core.signed_in().unwrap();
    let react = || ReactParams {
        room_id: room_id.to_owned(),
        event_id: target.to_owned(),
        key: "🔥".into(),
        source_pack: None,
        shortcode: None,
        thread_root: None,
        subscription: None,
        persona: None,
    };
    core.run(react()).await.unwrap();
    assert_eq!(session.frequent_reactions(None, &[]).await.unwrap(), ["🔥"]);
    assert_eq!(stored.lock()["recent_emoji"][0]["total"], 1);
    core.run(react()).await.unwrap();
    assert_eq!(stored.lock()["recent_emoji"][0]["total"], 1);
    assert_eq!(stored.lock()["recent_emoji"][1], other);
    session.remember_reaction("hello").await.unwrap();
    assert_eq!(stored.lock()["recent_emoji"][0]["emoji"], "🔥");
    assert!(
        core.run(ReactParams {
            event_id: event_id!("$missing").to_owned(),
            ..react()
        })
        .await
        .is_err()
    );
    assert_eq!(stored.lock()["recent_emoji"][0]["total"], 1);

    let restored = signed_in_as(&server, client.clone()).await;
    let restored_session = restored.signed_in().unwrap();
    assert_eq!(
        restored_session
            .frequent_reactions(None, &[])
            .await
            .unwrap(),
        ["🔥"]
    );
}

#[tokio::test]
#[cfg(not(target_family = "wasm"))]
async fn reaction_history_keeps_offline_counts_and_merges_them_on_reconnect() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path_regex},
    };

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let core = signed_in_as(&server, client.clone()).await;
    let session = core.signed_in().unwrap();
    let unavailable = Mock::given(method("GET"))
        .and(path_regex("/account_data/m.recent_emoji$"))
        .respond_with(
            ResponseTemplate::new(403)
                .set_body_json(json!({"errcode": "M_FORBIDDEN", "error": "offline fixture"})),
        )
        .mount_as_scoped(server.server())
        .await;
    session.remember_reaction("🔥").await.unwrap();
    let seeds = ["mxc://example.org/wave".to_owned()];
    assert_eq!(
        session.frequent_reactions(None, &seeds).await.unwrap(),
        ["🔥", "mxc://example.org/wave"]
    );
    assert_eq!(
        session.frequent_reactions(None, &[]).await.unwrap(),
        ["🔥", "mxc://example.org/wave"]
    );
    drop(unavailable);

    let get = Mock::given(method("GET"))
        .and(path_regex("/account_data/m.recent_emoji$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "recent_emoji": [{"emoji": "🐈", "total": 7}, {"emoji": "🔥", "total": 2}]
        })))
        .mount_as_scoped(server.server())
        .await;
    let refused = Mock::given(method("PUT"))
        .and(path_regex("/account_data/m.recent_emoji$"))
        .respond_with(
            ResponseTemplate::new(403)
                .set_body_json(json!({"errcode": "M_FORBIDDEN", "error": "upload fixture"})),
        )
        .mount_as_scoped(server.server())
        .await;
    let shown = ["🐈", "🔥", "mxc://example.org/wave"];
    assert_eq!(session.frequent_reactions(None, &[]).await.unwrap(), shown);
    drop(refused);

    let expected = json!({"recent_emoji": [
        {"emoji": "🔥", "total": 3},
        {"emoji": "🐈", "total": 7},
        {"emoji": "mxc://example.org/wave", "total": 1},
    ]});
    Mock::given(method("PUT"))
        .and(path_regex("/account_data/m.recent_emoji$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    assert_eq!(session.frequent_reactions(None, &[]).await.unwrap(), shown);
    assert_eq!(uploads(&server).await.last(), Some(&expected));
    drop(get);

    Mock::given(method("GET"))
        .and(path_regex("/account_data/m.recent_emoji$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(expected))
        .mount(server.server())
        .await;
    assert_eq!(session.frequent_reactions(None, &[]).await.unwrap(), shown);
}

#[tokio::test]
#[cfg(not(target_family = "wasm"))]
async fn another_clients_history_survives_reading_and_picking() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path_regex},
    };

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    // What a build with thirty day buckets left behind.
    let old = json!({"recent_emoji": [{"emoji": "🔥", "total": 1, "moe.sable.usage": []}]});
    client
        .state_store()
        .set_custom_value_no_read(EMOJI.store_key, serde_json::to_vec(&old).unwrap())
        .await
        .unwrap();
    let core = signed_in_as(&server, client.clone()).await;
    let session = core.signed_in().unwrap();
    Mock::given(method("GET"))
        .and(path_regex("/account_data/m.recent_emoji$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "x.other": true,
            "recent_emoji": [{"emoji": "🐈", "total": 7}, {"emoji": "🔥", "total": 84}]
        })))
        .mount(server.server())
        .await;
    let untouched = Mock::given(method("PUT"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(0)
        .mount_as_scoped(server.server())
        .await;
    assert_eq!(
        session.frequent_reactions(None, &[]).await.unwrap(),
        ["🔥", "🐈"]
    );
    drop(untouched);

    Mock::given(method("PUT"))
        .and(path_regex("/account_data/m.recent_emoji$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    session.remember_reaction("🔥").await.unwrap();
    assert_eq!(
        uploads(&server).await.last(),
        Some(&json!({
            "x.other": true,
            "recent_emoji": [{"emoji": "🔥", "total": 85}, {"emoji": "🐈", "total": 7}]
        }))
    );
}

#[cfg(not(target_family = "wasm"))]
mod requests {
    use std::time::Duration;

    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::{Value, json};
    use wiremock::{
        Mock, MockGuard, ResponseTemplate,
        matchers::{method, path_regex},
    };

    use crate::Core;
    use crate::usage_history::testing::{signed_in, uploads, written};

    const PATH: &str = "/account_data/m.recent_emoji$";

    async fn answer(
        server: &MatrixMockServer,
        verb: &str,
        response: ResponseTemplate,
    ) -> MockGuard {
        Mock::given(method(verb))
            .and(path_regex(PATH))
            .respond_with(response)
            .mount_as_scoped(server.server())
            .await
    }

    fn ok(content: Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(content)
    }

    fn failed(status: u16, code: &str) -> ResponseTemplate {
        ResponseTemplate::new(status).set_body_json(json!({"errcode": code, "error": "test"}))
    }

    fn fire(total: u64) -> Value {
        json!({"recent_emoji": [{"emoji": "🔥", "total": total}]})
    }

    async fn killed(core: &std::sync::Arc<Core>) {
        let session = core.signed_in().unwrap();
        let pick = session.remember_reaction("🔥");
        tokio::time::timeout(Duration::from_secs(1), pick)
            .await
            .unwrap_err();
    }

    #[tokio::test]
    async fn a_pick_survives_the_app_dying_during_the_read() {
        let server = MatrixMockServer::new().await;
        let core = signed_in(&server).await;
        let session = core.signed_in().unwrap();
        let slow = ok(fire(1)).set_delay(Duration::from_secs(5));
        let reading = answer(&server, "GET", slow).await;
        killed(&core).await;
        drop(reading);

        let _read = answer(&server, "GET", ok(fire(1))).await;
        let _write = answer(&server, "PUT", ok(json!({}))).await;
        session.frequent_reactions(None, &[]).await.unwrap();
        assert_eq!(uploads(&server).await, [fire(2)]);
    }

    #[tokio::test]
    async fn a_pick_survives_the_app_dying_during_the_upload() {
        let server = MatrixMockServer::new().await;
        let core = signed_in(&server).await;
        let session = core.signed_in().unwrap();
        let _read = answer(&server, "GET", ok(fire(1))).await;
        let slow = ok(json!({})).set_delay(Duration::from_secs(5));
        let writing = answer(&server, "PUT", slow).await;
        killed(&core).await;
        drop(writing);

        let _write = answer(&server, "PUT", ok(json!({}))).await;
        session.frequent_reactions(None, &[]).await.unwrap();
        assert_eq!(uploads(&server).await, [fire(2), fire(2)]);
    }

    #[tokio::test]
    async fn an_upload_that_landed_before_the_app_died_is_not_counted_twice() {
        let server = MatrixMockServer::new().await;
        let core = signed_in(&server).await;
        let session = core.signed_in().unwrap();
        let before = answer(&server, "GET", ok(fire(1))).await;
        let slow = ok(json!({})).set_delay(Duration::from_secs(5));
        let writing = answer(&server, "PUT", slow).await;
        killed(&core).await;
        drop((before, writing));

        let sent = written(&server).await.pop().unwrap();
        let _landed = answer(&server, "GET", ok(sent)).await;
        let _write = answer(&server, "PUT", ok(json!({}))).await;
        assert_eq!(session.frequent_reactions(None, &[]).await.unwrap(), ["🔥"]);
        session.remember_reaction("🔥").await.unwrap();
        assert_eq!(uploads(&server).await.last(), Some(&fire(3)));
    }

    #[tokio::test]
    async fn picks_waiting_on_a_slow_request_are_saved_already() {
        let server = MatrixMockServer::new().await;
        let core = signed_in(&server).await;
        let session = core.signed_in().unwrap();
        let slow = ok(fire(1)).set_delay(Duration::from_secs(5));
        let reading = answer(&server, "GET", slow).await;
        let both = async {
            tokio::join!(
                session.remember_reaction("🔥"),
                session.remember_reaction("🔥")
            )
        };
        tokio::time::timeout(Duration::from_secs(1), both)
            .await
            .unwrap_err();
        drop(reading);

        let _read = answer(&server, "GET", ok(fire(1))).await;
        let _write = answer(&server, "PUT", ok(json!({}))).await;
        session.frequent_reactions(None, &[]).await.unwrap();
        assert_eq!(uploads(&server).await, [fire(3)]);
    }

    #[tokio::test]
    async fn reading_does_not_restore_history_the_server_no_longer_has() {
        let server = MatrixMockServer::new().await;
        let core = signed_in(&server).await;
        let session = core.signed_in().unwrap();
        let present = answer(&server, "GET", ok(fire(4))).await;
        session.frequent_reactions(None, &[]).await.unwrap();
        drop(present);

        let _absent = answer(&server, "GET", failed(404, "M_NOT_FOUND")).await;
        let _write = answer(&server, "PUT", ok(json!({}))).await;
        assert_eq!(
            session.frequent_reactions(None, &[]).await.unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(uploads(&server).await, Vec::<Value>::new());
    }

    #[tokio::test]
    async fn history_migrated_offline_uploads_on_reconnect() {
        let server = MatrixMockServer::new().await;
        let core = signed_in(&server).await;
        let session = core.signed_in().unwrap();
        let offline = answer(&server, "GET", failed(403, "M_FORBIDDEN")).await;
        let legacy = Some(json!([["🔥", 4]]));
        assert_eq!(
            session.frequent_reactions(legacy, &[]).await.unwrap(),
            ["🔥"]
        );
        drop(offline);

        let _absent = answer(&server, "GET", failed(404, "M_NOT_FOUND")).await;
        let _write = answer(&server, "PUT", ok(json!({}))).await;
        session.frequent_reactions(None, &[]).await.unwrap();
        assert_eq!(uploads(&server).await, [fire(4)]);
    }
}
