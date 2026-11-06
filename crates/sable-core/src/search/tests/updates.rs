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
use super::{document, in_room, seed_room};
use crate::search::persist::{self, Restored};
use crate::search::{MessageIndex, RoomIndex};

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

async fn restart(mut index: MessageIndex, room: &matrix_sdk::ruma::OwnedRoomId) -> MessageIndex {
    let (flush, _, _) = index.take_flush(room).unwrap();
    let manifest = serde_json::from_slice(&serde_json::to_vec(&flush.manifest).unwrap()).unwrap();
    let mut restored = MessageIndex::new();
    restored
        .restore_room(
            room,
            Restored {
                manifest,
                loaded: flush.chunks,
                legacy: false,
            },
        )
        .await;
    restored
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
    let mut index = MessageIndex::new();
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
    let fresh = index.unclassified(&room, vec![redacted]);
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
async fn test_cold_edit_rollback_survives_save() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (core, _events) = crate::Core::new(
        "search-updates",
        Box::new(crate::store::MemorySessionStore::default()),
    );
    let _room = server
        .sync_room(
            &client,
            matrix_sdk_test::JoinedRoomBuilder::new(&room)
                .add_timeline_event(original().raw().clone())
                .add_timeline_event(edit().raw().clone()),
        )
        .await;
    let (cache, _handles) = client.event_cache().unwrap().room(&room).await.unwrap();
    {
        let mut index = core.search_index.lock().await;
        *index = MessageIndex::with_budgets(usize::MAX, u64::MAX);
        let mut room_index = RoomIndex::new();
        seed_room(&mut room_index, 3000);
        index.rooms.insert(room.clone(), room_index);
        index
            .ingest(
                &room,
                cache.events().await.unwrap(),
                &cache,
                &RedactionRules::V11,
            )
            .await;
    }
    core.flush_search_index(&client).await;
    let chunk = {
        let mut index = core.search_index.lock().await;
        let room_index = index.rooms.get_mut(&room).unwrap();
        let chunk = *room_index.chunks.range(..=1000).next_back().unwrap().1;
        room_index.unload(chunk);
        chunk
    };
    let mut raw = serde_json::to_value(redaction().raw()).unwrap();
    raw["content"]["redacts"] = json!("$edit");
    let redaction: matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::AnySyncTimelineEvent> =
        serde_json::from_value(raw).unwrap();
    server
        .sync_room(
            &client,
            matrix_sdk_test::JoinedRoomBuilder::new(&room).add_timeline_event(redaction),
        )
        .await;
    core.search_index
        .lock()
        .await
        .ingest(
            &room,
            cache.events().await.unwrap(),
            &cache,
            &RedactionRules::V11,
        )
        .await;
    assert_eq!(
        in_room(&*core.search_index.lock().await, &room, "original", 10, 0).len(),
        1
    );
    core.flush_search_index(&client).await;
    let persist::ChunkRead::Found(stored) = persist::load_chunk(&client, &room, chunk).await else {
        panic!("chunk missing")
    };
    assert_eq!(
        stored
            .documents
            .iter()
            .find(|doc| doc.event_id == event_id!("$original"))
            .unwrap()
            .body,
        "original",
        "saving restored a redacted edit"
    );
}

#[async_test]
async fn test_redaction_survives_restart_before_peer_import() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (_room, cache, _handles) = empty_cache(&server, &client, &room).await;
    let mut index = MessageIndex::new();
    index
        .ingest(
            &room,
            vec![original(), redaction()],
            &cache,
            &RedactionRules::V11,
        )
        .await;
    let (flush, _, _) = index.take_flush(&room).unwrap();
    let mut restored = MessageIndex::new();
    restored
        .restore_room(
            &room,
            Restored {
                manifest: flush.manifest,
                loaded: flush.chunks,
                legacy: false,
            },
        )
        .await;
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
    let mut index = MessageIndex::new();
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
    let mut index = MessageIndex::new();
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
    let mut index = MessageIndex::new();
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
    let mut restored = restart(index, &room).await;
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
        restored.rooms[&room]
            .document(&event_id!("$original").to_owned())
            .unwrap()
            .edit_id
            .as_deref(),
        Some(event_id!("$edit"))
    );
    assert!(restored.rooms[&room].pending_replacements.is_empty());
}

#[async_test]
async fn test_redacting_a_pending_edit_before_restart_keeps_the_original() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (_room, cache, _handles) = empty_cache(&server, &client, &room).await;
    let mut index = MessageIndex::new();
    let redaction = changed(&redaction(), "content", json!({"redacts": "$edit"}));
    index
        .ingest(&room, vec![edit(), redaction], &cache, &RedactionRules::V11)
        .await;
    let mut restored = restart(index, &room).await;
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
    let mut index = MessageIndex::new();
    index
        .ingest(&room, vec![original()], &cache, &RedactionRules::V11)
        .await;
    let stale = index.rooms[&room]
        .document(&event_id!("$original").to_owned())
        .unwrap()
        .clone();
    let snapshot = changed(
        &changed(&edit(), "content", json!({})),
        "unsigned",
        json!({"redacted_because": {}}),
    );
    let fresh = index.unclassified(&room, vec![snapshot]);
    index
        .ingest(&room, fresh, &cache, &RedactionRules::V11)
        .await;
    let mut restored = restart(index, &room).await;
    restored
        .import(&room, vec![stale], Vec::new(), Vec::new())
        .await;
    assert_eq!(in_room(&restored, &room, "original", 10, 0).len(), 1);
    assert!(in_room(&restored, &room, "edited", 10, 0).is_empty());
}

#[async_test]
async fn test_cold_edits_are_validated_before_search_and_save() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (_room, cache, _handles) = empty_cache(&server, &client, &room).await;
    for (original_encrypted, edit_encrypted, expected) in [
        (false, false, "edited"),
        (true, true, "edited"),
        (true, false, "original"),
    ] {
        let (core, _events) = crate::Core::new(
            "cold-updates",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        let original = if original_encrypted {
            encrypted(&original())
        } else {
            original()
        };
        core.search_index
            .lock()
            .await
            .ingest(&room, vec![original], &cache, &RedactionRules::V11)
            .await;
        core.flush_search_index(&client).await;
        let chunk = {
            let mut index = core.search_index.lock().await;
            let room_index = index.rooms.get_mut(&room).unwrap();
            let chunk = *room_index.chunks.values().next().unwrap();
            room_index.unload(chunk);
            chunk
        };
        let edit = if edit_encrypted {
            encrypted(&edit())
        } else {
            edit()
        };
        core.search_index
            .lock()
            .await
            .ingest(&room, vec![edit], &cache, &RedactionRules::V11)
            .await;
        let persist::ChunkRead::Found(stored) = persist::load_chunk(&client, &room, chunk).await
        else {
            panic!("chunk missing")
        };
        {
            let index = core.search_index.lock().await;
            let filter = crate::search::IndexFilter::default();
            let terms = crate::search::document::FoldedTerms::of(&filter, HashSet::new());
            let (hits, _) = index.scan_cold(
                &room,
                &stored,
                "",
                &filter,
                &terms,
                crate::search::index::ColdWindow::all(0),
            );
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].body, expected);
        }
        core.flush_search_index(&client).await;
        let persist::ChunkRead::Found(stored) = persist::load_chunk(&client, &room, chunk).await
        else {
            panic!("chunk missing")
        };
        assert_eq!(stored.documents.len(), 1);
        assert_eq!(stored.documents[0].body, expected);
        assert!(
            core.search_index.lock().await.rooms[&room]
                .pending_replacements
                .is_empty()
        );
        if original_encrypted && !edit_encrypted {
            let redaction = changed(&redaction(), "content", json!({"redacts": "$edit"}));
            core.search_index
                .lock()
                .await
                .ingest(&room, vec![redaction], &cache, &RedactionRules::V11)
                .await;
            core.flush_search_index(&client).await;
            let persist::ChunkRead::Found(stored) =
                persist::load_chunk(&client, &room, chunk).await
            else {
                panic!("chunk missing")
            };
            assert_eq!(stored.documents.len(), 1);
            assert_eq!(stored.documents[0].body, "original");
        }
    }
}

#[async_test]
async fn test_restore_applies_pending_edits_to_loaded_chunks() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room = room_id!("!updates:localhost").to_owned();
    let (_room, cache, _handles) = empty_cache(&server, &client, &room).await;
    let mut index = MessageIndex::new();
    index
        .ingest(&room, vec![original()], &cache, &RedactionRules::V11)
        .await;
    let (flush, _, _) = index.take_flush(&room).unwrap();
    let loaded = flush.chunks;
    let chunk = loaded[0].0;
    index.rooms.get_mut(&room).unwrap().unload(chunk);
    index
        .ingest(&room, vec![edit()], &cache, &RedactionRules::V11)
        .await;
    let (flush, _, _) = index.take_flush(&room).unwrap();
    let mut restored = MessageIndex::new();
    restored
        .restore_room(
            &room,
            Restored {
                manifest: flush.manifest,
                loaded,
                legacy: false,
            },
        )
        .await;
    assert_eq!(in_room(&restored, &room, "edited", 10, 0).len(), 1);
    assert!(in_room(&restored, &room, "original", 10, 0).is_empty());
    let (flush, _, _) = restored.take_flush(&room).unwrap();
    assert!(flush.manifest.pending_replacements.is_empty());
    assert_eq!(flush.chunks[0].1.documents[0].body, "edited");
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
    let mut index = MessageIndex::new();
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
        index.rooms[&room]
            .document(&event_id!("$original").to_owned())
            .unwrap()
            .edit_id
            .as_deref(),
        Some(event_id!("$kept"))
    );
}
