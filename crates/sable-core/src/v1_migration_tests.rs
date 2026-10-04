use matrix_sdk_base::crypto::{store::CryptoStore, types::events::room::encrypted::EncryptedEvent};
use serde_json::{Value, json};

use super::{Entry, IndexedDbSnapshot, LegacySession, decode, key_parts};
use crate::{
    Core,
    store::{FileSessionStore, SessionStore},
};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/v1-crypto-18.4.json")).unwrap()
}

fn manifest(data: &Value) -> LegacySession {
    serde_json::from_value(json!({
        "baseUrl": "https://example.org", "userId": data["user_id"],
        "deviceId": data["device_id"], "accessToken": "fixture-token"
    }))
    .unwrap()
}

fn snapshot(data: &Value) -> Vec<Option<IndexedDbSnapshot>> {
    let counts: std::collections::BTreeMap<String, u64> = data["database"]["stores"]
        .as_array()
        .unwrap()
        .iter()
        .map(|store| {
            (
                store["name"].as_str().unwrap().to_owned(),
                store["records"].as_array().unwrap().len() as u64,
            )
        })
        .collect();
    vec![Some(IndexedDbSnapshot {
        version: 107,
        counts,
    })]
}

async fn import_fixture(core: &Core, data: &Value) {
    let mut stores: Vec<_> = data["database"]["stores"]
        .as_array()
        .unwrap()
        .iter()
        .collect();
    stores.sort_by_key(|store| store["name"] != "core");
    for store in stores {
        let entries: Vec<Entry> = serde_json::from_value(store["records"].clone()).unwrap();
        core.import_v1_crypto_batch(0, store["name"].as_str().unwrap(), entries)
            .await
            .unwrap();
    }
}

#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "one sequential flow kept in a single function"
)]
async fn imports_actual_v1_identity_sessions_secrets_trust_and_decrypts_old_and_new_messages() {
    let data = fixture();
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().join("app");
    let (core, _) = Core::new(
        base.to_str().unwrap(),
        Box::new(FileSessionStore::new(&base)),
    );
    core.begin_v1_migration(vec![manifest(&data)], None, snapshot(&data), vec![])
        .await
        .unwrap();
    import_fixture(&core, &data).await;
    assert!(FileSessionStore::new(&base).load().await.unwrap().is_none());
    core.finish_v1_migration().await.unwrap();
    let accounts = core.accounts().await.unwrap();
    let account = &accounts.accounts[0];
    assert_eq!(account.session.credentials.user_id(), data["user_id"]);
    assert_eq!(account.session.credentials.device_id(), data["device_id"]);
    assert_eq!(
        account.session.credentials.tokens().access_token,
        "fixture-token"
    );
    let store = matrix_sdk::SqliteCryptoStore::open(
        std::path::Path::new(&account.store_id).join("store"),
        None,
    )
    .await
    .unwrap();
    let identity = store.load_account().await.unwrap().unwrap();
    assert_eq!(
        identity.identity_keys().ed25519.to_base64(),
        data["identity_keys"]["ed25519"]
    );
    assert_eq!(
        identity.identity_keys().curve25519.to_base64(),
        data["identity_keys"]["curve25519"]
    );
    assert!(store.load_identity().await.unwrap().is_some());
    assert!(
        store
            .load_backup_keys()
            .await
            .unwrap()
            .decryption_key
            .is_some()
    );
    assert_eq!(store.get_inbound_group_sessions().await.unwrap().len(), 2);
    let room: matrix_sdk::ruma::OwnedRoomId = data["room_id"].as_str().unwrap().parse().unwrap();
    let event: EncryptedEvent = serde_json::from_value(data["encrypted_event"].clone()).unwrap();
    let session_id = data["encrypted_event"]["content"]["session_id"]
        .as_str()
        .unwrap();
    let inbound = store
        .get_inbound_group_session(&room, session_id)
        .await
        .unwrap()
        .unwrap();
    let (decrypted, _) = inbound.decrypt(&event).await.unwrap();
    assert_eq!(decrypted["content"], data["plaintext"]);
    let outbound = store
        .get_outbound_group_session(&room)
        .await
        .unwrap()
        .unwrap();
    let plaintext = matrix_sdk::ruma::serde::Raw::from_json(
        serde_json::value::to_raw_value(
            &json!({"msgtype": "m.text", "body": "Sent after migration"}),
        )
        .unwrap(),
    );
    let content = outbound.encrypt("m.room.message", &plaintext).await.content;
    let event: EncryptedEvent = serde_json::from_value(json!({"type": "m.room.encrypted", "event_id": "$new", "sender": data["user_id"], "origin_server_ts": 1, "content": content})).unwrap();
    let (decrypted, _) = inbound.decrypt(&event).await.unwrap();
    assert_eq!(decrypted["content"]["body"], "Sent after migration");
    for table in data["database"]["stores"].as_array().unwrap() {
        if table["name"] == "session" {
            for entry in table["records"].as_array().unwrap() {
                let sender = key_parts(entry["key"].as_str().unwrap());
                assert!(
                    !store
                        .get_sessions(&sender[0])
                        .await
                        .unwrap()
                        .unwrap()
                        .is_empty()
                );
            }
        }
    }
    let peer = store
        .get_device(
            matrix_sdk::ruma::user_id!("@peer:example.org"),
            "PEERDEVICE".into(),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        peer.local_trust_state(),
        matrix_sdk_base::crypto::LocalTrust::Verified
    );
    assert!(
        store
            .get_user_identity(matrix_sdk::ruma::user_id!("@migration:example.org"))
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(store.load_tracked_users().await.unwrap().len(), 1);
    assert!(store.get_room_settings(&room).await.unwrap().is_some());
    assert!(
        store
            .get_pending_key_bundle_details_for_room(matrix_sdk::ruma::room_id!(
                "!pending:example.org"
            ))
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        store
            .get_custom_value("HAS_MIGRATED_VERIFICATION_LATCH")
            .await
            .unwrap()
            .is_some()
    );
    let hashes = data["database"]["stores"]
        .as_array()
        .unwrap()
        .iter()
        .find(|table| table["name"] == "olm_hashes")
        .unwrap();
    let key = key_parts(hashes["records"][0]["key"].as_str().unwrap());
    assert!(
        store
            .is_message_known(&matrix_sdk_base::crypto::olm::OlmMessageHash {
                sender_key: key[0].clone(),
                hash: key[1].clone()
            })
            .await
            .unwrap()
    );
    drop(store);
    drop(core);
    let (restored, _) = Core::new(
        base.to_str().unwrap(),
        Box::new(FileSessionStore::new(&base)),
    );
    assert!(restored.v1_migration_complete().await.unwrap());
    assert!(
        restored
            .begin_v1_migration(vec![manifest(&data)], None, snapshot(&data), vec![])
            .await
            .is_err()
    );
}

#[tokio::test]
async fn failed_identity_import_never_publishes_and_can_retry() {
    let data = fixture();
    let directory = tempfile::tempdir().unwrap();
    let (core, _) = Core::new(
        directory.path().to_str().unwrap(),
        Box::new(FileSessionStore::new(directory.path())),
    );
    core.begin_v1_migration(vec![manifest(&data)], None, snapshot(&data), vec![])
        .await
        .unwrap();
    let core_table = data["database"]["stores"]
        .as_array()
        .unwrap()
        .iter()
        .find(|store| store["name"] == "core")
        .unwrap();
    let mut entries: Vec<Entry> = serde_json::from_value(core_table["records"].clone()).unwrap();
    let account = entries
        .iter_mut()
        .find(|entry| entry.key == "account")
        .unwrap();
    let mut pickle: Value = decode(account.value.clone()).unwrap();
    pickle["device_id"] = json!("WRONG");
    account.value = pickle;
    assert!(
        core.import_v1_crypto_batch(0, "core", entries)
            .await
            .is_err()
    );
    assert!(core.finish_v1_migration().await.is_err());
    assert!(
        FileSessionStore::new(directory.path())
            .load()
            .await
            .unwrap()
            .is_none()
    );
    core.begin_v1_migration(vec![manifest(&data)], None, snapshot(&data), vec![])
        .await
        .unwrap();
    import_fixture(&core, &data).await;
    core.finish_v1_migration().await.unwrap();
}

#[test]
fn escaped_composite_keys_and_encrypted_values_are_handled_explicitly() {
    assert_eq!(
        key_parts("first\u{001e}\u{001d}part\u{001d}second"),
        ["first\u{001d}part", "second"]
    );
    decode::<Value>(json!({"version": 1, "nonce": "x", "ciphertext": "x"})).unwrap_err();
}

#[test]
fn migrated_oauth_registration_and_issuer_survive_serialization_and_refresh() {
    let legacy: LegacySession = serde_json::from_value(json!({"baseUrl":"https://example.org", "userId":"@migration:example.org", "deviceId":"V1DEVICE", "accessToken":"access", "refreshToken":"refresh", "oidc":{"issuer":"https://issuer.example.org", "clientId":"original-client"}})).unwrap();
    let persisted = legacy.persisted().unwrap();
    let encoded = serde_json::to_value(&persisted).unwrap();
    assert_eq!(encoded["credentials"]["kind"], "o_auth");
    assert_eq!(encoded["credentials"]["client_id"], "original-client");
    assert_eq!(encoded["credentials"]["user"]["refresh_token"], "refresh");
    let mut refreshed = persisted.clone();
    refreshed.oauth_issuer = None;
    assert_eq!(
        refreshed.keeping_endpoint_of(&persisted).oauth_issuer,
        persisted.oauth_issuer
    );
}

#[tokio::test]
async fn incomplete_snapshot_cannot_publish_even_when_the_account_is_valid() {
    let data = fixture();
    let directory = tempfile::tempdir().unwrap();
    let (core, _) = Core::new(
        directory.path().to_str().unwrap(),
        Box::new(FileSessionStore::new(directory.path())),
    );
    core.begin_v1_migration(vec![manifest(&data)], None, snapshot(&data), vec![])
        .await
        .unwrap();
    let table = data["database"]["stores"]
        .as_array()
        .unwrap()
        .iter()
        .find(|table| table["name"] == "core")
        .unwrap();
    core.import_v1_crypto_batch(
        0,
        "core",
        serde_json::from_value(table["records"].clone()).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        core.finish_v1_migration().await.unwrap_err().to_string(),
        "v1 crypto snapshot is incomplete"
    );
    assert!(
        FileSessionStore::new(directory.path())
            .load()
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn native_sqlite_snapshot_includes_wal_and_preserves_both_old_path_layouts() {
    for nested in [false, true] {
        let data = fixture();
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("old");
        let mut source = original
            .join("matrix-crypto")
            .join("@migration_example.org_V1DEVICE");
        if nested {
            source = source.join("matrix-sdk-crypto.sqlite3");
        }
        let store = matrix_sdk::SqliteCryptoStore::open(&source, None)
            .await
            .unwrap();
        let expected = manifest(&data).persisted().unwrap();
        for table in data["database"]["stores"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|table| table["name"] == "core")
        {
            super::import_batch(
                &store,
                &expected,
                "core",
                serde_json::from_value(table["records"].clone()).unwrap(),
            )
            .await
            .unwrap();
        }
        let writer = rusqlite::Connection::open(source.join("matrix-sdk-crypto.sqlite3")).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture_wal(value TEXT); INSERT INTO fixture_wal VALUES('committed');").unwrap();
        let before: i64 = writer
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let base = directory.path().join("new");
        let occupied = crate::session::account_store_id(base.to_str().unwrap(), "a1");
        std::fs::create_dir_all(&occupied).unwrap();
        std::fs::write(std::path::Path::new(&occupied).join("sentinel"), b"keep").unwrap();
        let (core, _) = Core::new(
            base.to_str().unwrap(),
            Box::new(FileSessionStore::new(&base)),
        );
        core.begin_v1_migration(vec![manifest(&data)], None, vec![None], vec![original])
            .await
            .unwrap();
        core.finish_v1_migration().await.unwrap();
        let accounts = core.accounts().await.unwrap();
        assert_eq!(accounts.accounts[0].account_id, "a2");
        let migrated = matrix_sdk::SqliteCryptoStore::open(
            std::path::Path::new(&accounts.accounts[0].store_id).join("store"),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            migrated
                .load_account()
                .await
                .unwrap()
                .unwrap()
                .identity_keys()
                .curve25519
                .to_base64(),
            data["identity_keys"]["curve25519"]
        );
        let copied = rusqlite::Connection::open(
            std::path::Path::new(&accounts.accounts[0].store_id)
                .join("store/matrix-sdk-crypto.sqlite3"),
        )
        .unwrap();
        assert_eq!(
            copied
                .query_row("SELECT value FROM fixture_wal", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "committed"
        );
        assert_eq!(
            writer
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            before
        );
        assert_eq!(
            std::fs::read(std::path::Path::new(&occupied).join("sentinel")).unwrap(),
            b"keep"
        );
        FileSessionStore::new(&base).clear().await.unwrap();
        assert!(core.v1_migration_complete().await.unwrap());
    }
}

#[tokio::test]
async fn changed_oauth_issuer_is_rejected_before_restoring_tokens() {
    let server = matrix_sdk::test_utils::mocks::MatrixMockServer::new().await;
    server
        .oauth()
        .mock_server_metadata()
        .ok()
        .expect(1)
        .mount()
        .await;
    let client = server.client_builder().unlogged().build().await;
    let legacy: LegacySession = serde_json::from_value(json!({"baseUrl":"https://example.org", "userId":"@migration:example.org", "deviceId":"V1DEVICE", "accessToken":"access", "refreshToken":"refresh", "oidc":{"issuer":"https://different.example.org", "clientId":"original-client"}})).unwrap();
    assert_eq!(
        crate::session::restore_credentials(&client, &legacy.persisted().unwrap())
            .await
            .unwrap_err()
            .to_string(),
        "saved OAuth issuer does not match the homeserver"
    );
    assert!(client.oauth().full_session().is_none());
    assert!(client.session().is_none());
}
