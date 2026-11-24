use std::collections::HashSet;

use matrix_sdk::deserialized_responses::{
    AlgorithmInfo, DecryptedRoomEvent, EncryptionInfo, TimelineEvent, VerificationState,
};
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::{event_id, room_id, user_id};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_test::async_test;
use serde_json::json;

use super::ingest::empty_cache;
use super::{document, in_room};
use crate::search::MessageIndex;

fn original() -> TimelineEvent {
    TimelineEvent::from_plaintext(serde_json::from_value(json!({
        "type": "m.room.message", "event_id": "$original", "sender": "@kris:localhost", "room_id": "!updates:localhost",
        "origin_server_ts": 1000, "content": {"msgtype": "m.text", "body": "original"}
    })).unwrap())
}

fn edit() -> TimelineEvent {
    TimelineEvent::from_plaintext(
        serde_json::from_value(json!({
            "type": "m.room.message", "event_id": "$edit", "sender": "@kris:localhost",
            "origin_server_ts": 2000, "content": {
                "msgtype": "m.text", "body": "* edited",
                "m.new_content": {"msgtype": "m.text", "body": "edited"},
                "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"}
            }
        }))
        .unwrap(),
    )
}

fn redaction() -> TimelineEvent {
    TimelineEvent::from_plaintext(
        serde_json::from_value(json!({
            "type": "m.room.redaction", "event_id": "$redaction", "sender": "@kris:localhost",
            "origin_server_ts": 3000, "content": {"redacts": "$original"}
        }))
        .unwrap(),
    )
}

fn changed(event: &TimelineEvent, field: &str, value: serde_json::Value) -> TimelineEvent {
    let mut raw = serde_json::to_value(event.raw()).unwrap();
    raw[field] = value;
    TimelineEvent::from_plaintext(serde_json::from_value(raw).unwrap())
}

fn encrypted(event: &TimelineEvent) -> TimelineEvent {
    TimelineEvent::from_decrypted(
        DecryptedRoomEvent {
            event: serde_json::from_str(event.raw().json().get()).unwrap(),
            encryption_info: std::sync::Arc::new(EncryptionInfo {
                sender: user_id!("@kris:localhost").to_owned(),
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
    )
}

#[async_test]
async fn test_redacted_snapshot_removes_indexed_body() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (_room, cache, _handles) = empty_cache(&server, &client, &room).await;
    let index = MessageIndex::new();
    index
        .ingest(&room, vec![original()], &cache, &RedactionRules::V11)
        .await;
    let redacted = TimelineEvent::from_plaintext(
        serde_json::from_value(json!({
            "type": "m.room.message", "event_id": "$original", "sender": "@kris:localhost",
            "origin_server_ts": 1000, "content": {},
            "unsigned": {"redacted_because": {
                "type": "m.room.redaction", "event_id": "$redaction", "sender": "@kris:localhost",
                "origin_server_ts": 3000, "content": {"redacts": "$original"}
            }}
        }))
        .unwrap(),
    );
    let fresh = index.unclassified(&room, vec![redacted]).await;
    assert_eq!(fresh.len(), 1);
    index
        .ingest(&room, fresh, &cache, &RedactionRules::V11)
        .await;
    assert!(
        in_room(&index, &room, "original", 10, 0).is_empty(),
        "redacted snapshot left the old message searchable"
    );
}

#[async_test]
async fn test_redaction_survives_restart_before_peer_import() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (_room, cache, _handles) = empty_cache(&server, &client, &room).await;
    let index = MessageIndex::new();
    index
        .ingest(
            &room,
            vec![original(), redaction()],
            &cache,
            &RedactionRules::V11,
        )
        .await;
    let restored = index;
    restored
        .import(
            &room,
            vec![document(
                "original",
                "original",
                "@kris:localhost",
                1000,
                None,
                Vec::new(),
            )],
            Vec::new(),
            Vec::new(),
        )
        .await;
    assert!(
        in_room(&restored, &room, "original", 10, 0).is_empty(),
        "peer import resurrected a deleted message after restart"
    );
}

#[async_test]
async fn test_plaintext_edit_before_encrypted_original_is_rejected() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (_room, cache, _handles) = empty_cache(&server, &client, &room).await;
    let index = MessageIndex::new();
    index
        .ingest(
            &room,
            vec![edit(), encrypted(&original())],
            &cache,
            &RedactionRules::V11,
        )
        .await;
    let hits = in_room(&index, &room, "original", 10, 0);
    assert_eq!(
        hits.len(),
        1,
        "plaintext edit incorrectly replaced an encrypted original"
    );
}

#[async_test]
async fn test_plaintext_edit_is_rejected_without_the_cached_original() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (_room, cache, _handles) = empty_cache(&server, &client, &room).await;
    let index = MessageIndex::new();
    index
        .ingest(
            &room,
            vec![encrypted(&original())],
            &cache,
            &RedactionRules::V11,
        )
        .await;
    index
        .ingest(&room, vec![edit()], &cache, &RedactionRules::V11)
        .await;
    assert_eq!(in_room(&index, &room, "original", 10, 0).len(), 1);
    assert!(in_room(&index, &room, "edited", 10, 0).is_empty());
}

#[async_test]
async fn test_pending_edits_are_validated_after_restart() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (_room, cache, _handles) = empty_cache(&server, &client, &room).await;
    let index = MessageIndex::new();
    let invalid = changed(
        &changed(&edit(), "event_id", json!("$invalid")),
        "origin_server_ts",
        json!(3000),
    );
    index
        .ingest(
            &room,
            vec![encrypted(&edit()), invalid],
            &cache,
            &RedactionRules::V11,
        )
        .await;
    assert!(in_room(&index, &room, "edited", 10, 0).is_empty());
    let restored = index;
    restored
        .ingest(
            &room,
            vec![encrypted(&original())],
            &cache,
            &RedactionRules::V11,
        )
        .await;
    let hits = in_room(&restored, &room, "edited", 10, 0);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].origin_server_ts, 1000);
    assert_eq!(
        restored
            .document(&room, &event_id!("$original").to_owned())
            .await
            .unwrap()
            .edit_id
            .as_deref(),
        Some(event_id!("$edit"))
    );
    assert_eq!(restored.store().pending_edits().await, 0);
}

#[async_test]
async fn test_redacting_a_pending_edit_before_restart_keeps_the_original() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (_room, cache, _handles) = empty_cache(&server, &client, &room).await;
    let index = MessageIndex::new();
    let redaction = changed(&redaction(), "content", json!({"redacts": "$edit"}));
    index
        .ingest(&room, vec![edit(), redaction], &cache, &RedactionRules::V11)
        .await;
    let restored = index;
    restored
        .ingest(
            &room,
            vec![original(), edit()],
            &cache,
            &RedactionRules::V11,
        )
        .await;
    assert_eq!(in_room(&restored, &room, "original", 10, 0).len(), 1);
    assert!(in_room(&restored, &room, "edited", 10, 0).is_empty());
}

#[async_test]
async fn test_a_stale_peer_cannot_restore_a_redacted_edit() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let _room = server
        .sync_room(
            &client,
            matrix_sdk_test::JoinedRoomBuilder::new(&room)
                .add_timeline_event(original().raw().clone())
                .add_timeline_event(edit().raw().clone()),
        )
        .await;
    let (cache, _handles) = client.event_cache().unwrap().room(&room).await.unwrap();
    let index = MessageIndex::new();
    index
        .ingest(&room, vec![original()], &cache, &RedactionRules::V11)
        .await;
    let stale = index
        .document(&room, &event_id!("$original").to_owned())
        .await
        .unwrap();
    let snapshot = changed(
        &changed(&edit(), "content", json!({})),
        "unsigned",
        json!({"redacted_because": {}}),
    );
    let fresh = index.unclassified(&room, vec![snapshot]).await;
    index
        .ingest(&room, fresh, &cache, &RedactionRules::V11)
        .await;
    let restored = index;
    restored
        .import(&room, vec![stale], Vec::new(), Vec::new())
        .await;
    assert_eq!(in_room(&restored, &room, "original", 10, 0).len(), 1);
    assert!(in_room(&restored, &room, "edited", 10, 0).is_empty());
}

#[async_test]
async fn test_edits_are_validated_against_the_encryption_of_the_original() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (_room, cache, _handles) = empty_cache(&server, &client, &room).await;
    for (original_encrypted, edit_encrypted, expected) in [
        (false, false, "edited"),
        (true, true, "edited"),
        (true, false, "original"),
    ] {
        let index = MessageIndex::new();
        let original = if original_encrypted {
            encrypted(&original())
        } else {
            original()
        };
        index
            .ingest(&room, vec![original], &cache, &RedactionRules::V11)
            .await;
        let edit = if edit_encrypted {
            encrypted(&edit())
        } else {
            edit()
        };
        index
            .ingest(&room, vec![edit], &cache, &RedactionRules::V11)
            .await;
        let hits = index.search(
            "",
            &crate::search::IndexFilter::default(),
            crate::api::search::SearchOrder::Rank,
            10,
            0,
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].body, expected);
        if original_encrypted && !edit_encrypted {
            let redaction = changed(&redaction(), "content", json!({"redacts": "$edit"}));
            index
                .ingest(&room, vec![redaction], &cache, &RedactionRules::V11)
                .await;
            let hits = index.search(
                "",
                &crate::search::IndexFilter::default(),
                crate::api::search::SearchOrder::Rank,
                10,
                0,
            );
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].body, "original");
        }
    }
}

#[test]
fn test_legacy_edits_do_not_override_rederived_encryption_metadata() {
    let mut legacy = document(
        "original",
        "edited",
        "@kris:localhost",
        1000,
        None,
        Vec::new(),
    );
    legacy.encrypted = None;
    legacy.edited_at = Some(2000);
    let mut original = document(
        "original",
        "original",
        "@kris:localhost",
        1000,
        None,
        Vec::new(),
    );
    original.encrypted = Some(true);
    let restored = crate::search::document::adopt_edit(original, Some(&legacy), &HashSet::new());
    assert_eq!(restored.body, "original");
    assert!(restored.edited_at.is_none());
}

#[async_test]
async fn test_redacting_one_pending_edit_keeps_other_valid_edits() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (_room, cache, _handles) = empty_cache(&server, &client, &room).await;
    let index = MessageIndex::new();
    let kept = changed(&edit(), "event_id", json!("$kept"));
    let removed = changed(&redaction(), "content", json!({"redacts": "$edit"}));
    index
        .ingest(
            &room,
            vec![kept, edit(), removed, original()],
            &cache,
            &RedactionRules::V11,
        )
        .await;
    let hits = in_room(&index, &room, "edited", 10, 0);
    assert_eq!(hits.len(), 1);
    assert_eq!(
        index
            .document(&room, &event_id!("$original").to_owned())
            .await
            .unwrap()
            .edit_id
            .as_deref(),
        Some(event_id!("$kept"))
    );
}
