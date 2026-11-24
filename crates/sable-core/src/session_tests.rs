use matrix_sdk::test_utils::mocks::MatrixMockServer;
#[cfg(not(target_family = "wasm"))]
use matrix_sdk_base::crypto::TrustRequirement;
use matrix_sdk_test::{JoinedRoomBuilder, event_factory::EventFactory};

use super::{
    AccountRegistry, PROXIED_SESSION_TIMEOUT, SESSION_TIMEOUT, account_store_id,
    build_account_client, client_metadata, qr_client_metadata, registered_redirect_uri,
    registration_redirect_uri, removable_account_store, repair_room_key_sharing, session_timeout,
};

#[test]
fn client_metadata_carries_the_configured_name() {
    let redirect = url::Url::parse("https://app.example/callback").unwrap();
    let name = |configured| {
        let raw = client_metadata(&redirect, configured);
        let value: serde_json::Value = serde_json::from_str(raw.json().get()).unwrap();
        value["client_name"].clone()
    };

    assert_eq!(name(Some("Acme Chat")), "Acme Chat");
    assert_eq!(name(None), "Sable");
}

#[test]
fn web_client_metadata_uses_the_deployment_origin() {
    for origin in ["https://chat.example.org", "https://chat.example.net:8443"] {
        let redirect =
            url::Url::parse(&format!("{origin}/login/callback?flow=oidc#fragment")).unwrap();
        for raw in [
            client_metadata(&redirect, None),
            qr_client_metadata(&redirect),
        ] {
            let value: serde_json::Value = serde_json::from_str(raw.json().get()).unwrap();
            assert_eq!(value["application_type"], "web");
            assert_eq!(value["client_uri"], format!("{origin}/"));
            assert_eq!(
                value["logo_uri"],
                format!("{origin}/icons/logo-maskable-180x180.png")
            );
            assert_eq!(
                value["redirect_uris"],
                serde_json::json!([redirect.as_str()])
            );
        }
    }
}

#[test]
fn native_client_metadata_keeps_the_sable_identity() {
    for (redirect, registered) in [
        ("moe.sable.app:/login", "moe.sable.app:/login"),
        ("moe.sable.next:/login", "moe.sable.next:/login"),
        (
            "http://127.0.0.1:41000/callback",
            "http://127.0.0.1/callback",
        ),
        ("http://[::1]:41000/callback", "http://[::1]/callback"),
        (
            "http://localhost:41000/callback",
            "http://localhost/callback",
        ),
    ] {
        let redirect = url::Url::parse(redirect).unwrap();
        for raw in [
            client_metadata(&redirect, None),
            qr_client_metadata(&redirect),
        ] {
            let value: serde_json::Value = serde_json::from_str(raw.json().get()).unwrap();
            assert_eq!(value["application_type"], "native");
            assert_eq!(value["client_uri"], "https://sable.moe/");
            assert_eq!(
                value["logo_uri"],
                "https://docs.sable.moe/img/sable-logo.svg"
            );
            assert_eq!(value["redirect_uris"], serde_json::json!([registered]));
        }
    }
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn discovery_client_identifies_sable_in_sdk_requests() {
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{header, method, path},
    };

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/versions"))
        .and(header("user-agent", crate::USER_AGENT))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({ "versions": ["v1.11"] })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let client = super::discovery_client(&server.uri()).await.unwrap();
    assert!(!client.server_versions().await.unwrap().is_empty());
}

#[test]
fn re_authentication_reuses_the_redirect_the_client_was_registered_with() {
    let (mut registry, _) =
        AccountRegistry::from_bytes(&registry_json("unused"), "unused").unwrap();
    let mut session = registry.accounts.remove(0).session;
    let app = url::Url::parse("moe.sable.app:/login").unwrap();
    let next = url::Url::parse("moe.sable.next:/login").unwrap();
    let web = url::Url::parse("https://app.sable.moe/login").unwrap();

    assert_eq!(registered_redirect_uri(&session, &app), Some(next.clone()));
    assert_eq!(registered_redirect_uri(&session, &web), None);
    session.oauth_issuer = Some(url::Url::parse("https://issuer.example.org").unwrap());
    assert_eq!(registered_redirect_uri(&session, &next), Some(app.clone()));
    session.oauth_redirect_uri = Some(next.clone());
    assert_eq!(registered_redirect_uri(&session, &app), Some(next.clone()));

    let loopback = url::Url::parse("http://127.0.0.1:41000/callback").unwrap();
    session.oauth_redirect_uri = Some(registration_redirect_uri(&loopback));
    assert_eq!(
        registered_redirect_uri(&session, &loopback),
        url::Url::parse("http://127.0.0.1/callback").ok()
    );
    session.oauth_redirect_uri = Some(next.clone());

    let mut refreshed = session.clone();
    refreshed.oauth_redirect_uri = None;
    assert_eq!(
        refreshed.keeping_endpoint_of(&session).oauth_redirect_uri,
        Some(next)
    );
}

#[test]
fn a_proxy_allows_slow_session_requests() {
    assert_eq!(session_timeout(false), SESSION_TIMEOUT);
    assert_eq!(session_timeout(true), PROXIED_SESSION_TIMEOUT);
}

fn registry_json(store_id: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "active_account_id": "a1",
        "next_account_id": 2,
        "accounts": [{
            "account_id": "a1",
            "store_id": store_id,
            "session": {
                "homeserver": "https://example.org",
                "credentials": {
                    "kind": "password",
                    "user_id": "@alice:example.org",
                    "device_id": "DEVICEID",
                    "access_token": "token"
                }
            }
        }]
    }))
    .unwrap()
}

/// A reader who signed in before multi-account keeps their session,
/// anchored to the store the single-account build wrote.
#[test]
fn adopts_a_legacy_single_account_session() -> Result<(), serde_json::Error> {
    let legacy = serde_json::to_vec(&serde_json::json!({
        "homeserver": "https://example.org",
        "credentials": {
            "kind": "password",
            "user_id": "@alice:example.org",
            "device_id": "DEVICEID",
            "access_token": "token"
        }
    }))?;

    let (accounts, migrated) = AccountRegistry::from_bytes(&legacy, "sable-next")?;

    assert!(migrated);
    assert_eq!(accounts.active_account_id.as_deref(), Some("a1"));
    assert_eq!(accounts.next_account_id, 2);
    let account = accounts.accounts.first().expect("the migrated account");
    assert_eq!(account.account_id, "a1");
    // Re-anchoring here would point the client at an empty crypto store.
    assert_eq!(account.store_id, "sable-next");
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn resolved_endpoint_restores_without_discovery() {
    let bytes = registry_json("unused");
    let (mut registry, _) = AccountRegistry::from_bytes(&bytes, "unused").unwrap();
    let persisted = &mut registry.accounts[0].session;
    assert!(persisted.resolved_homeserver.is_none());
    persisted.homeserver = "does-not-exist.invalid".to_owned();
    persisted.resolved_homeserver = Some(url::Url::parse("https://endpoint.invalid").unwrap());
    let directory =
        std::env::temp_dir().join(format!("sable-offline-{}", ruma::TransactionId::new()));
    let client = super::restore_client(directory.to_str().unwrap(), persisted, true)
        .await
        .unwrap();
    assert_eq!(
        client.homeserver(),
        persisted.resolved_homeserver.clone().unwrap()
    );
    drop(client);
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn account_clients_decrypt_messages_from_all_devices() {
    let store = tempfile::tempdir().unwrap();
    crate::store_encryption::account_key(store.path().to_str().unwrap())
        .await
        .unwrap();
    let client = build_account_client(
        matrix_sdk::Client::builder().homeserver_url("https://example.org"),
        store.path().to_str().unwrap(),
        super::ClientRole::Notification,
        true,
    )
    .await
    .unwrap();

    assert!(matches!(
        client.decryption_settings().sender_device_trust_requirement,
        TrustRequirement::Untrusted
    ));
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn only_account_clients_open_the_shared_caches() {
    let store = tempfile::tempdir().unwrap();
    let store_id = store.path().to_str().unwrap();
    crate::store_encryption::account_key(store_id)
        .await
        .unwrap();
    let build = |role| {
        build_account_client(
            matrix_sdk::Client::builder().homeserver_url("https://example.org"),
            store_id,
            role,
            true,
        )
    };

    let notification = build(super::ClientRole::Notification).await.unwrap();
    assert!(notification.event_cache().is_none());
    assert!(!store.path().join("cache").exists());
    drop(notification);
    let account = build(super::ClientRole::Account).await.unwrap();
    assert!(account.event_cache().is_some());
    assert!(store.path().join("cache").exists());
}

#[tokio::test]
async fn repairs_room_key_sharing_once_per_account() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let encrypted = matrix_sdk::ruma::room_id!("!encrypted:example.org");
    let plain = matrix_sdk::ruma::room_id!("!plain:example.org");
    let factory = EventFactory::new()
        .room(encrypted)
        .sender(client.user_id().unwrap());
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder
                .add_joined_room(
                    JoinedRoomBuilder::new(encrypted).add_state_event(factory.room_encryption()),
                )
                .add_joined_room(JoinedRoomBuilder::new(plain));
        })
        .await;

    repair_room_key_sharing(&client).await.unwrap();
    assert!(
        client
            .state_store()
            .get_custom_value(super::ROOM_KEY_SHARING_REPAIR_KEY)
            .await
            .unwrap()
            .is_some()
    );
    repair_room_key_sharing(&client).await.unwrap();
}

#[test]
fn rejects_bytes_that_are_neither_a_registry_nor_a_session() {
    assert!(AccountRegistry::from_bytes(b"{\"nonsense\":true}", "sable-next").is_err());
}

#[test]
fn serializes_an_empty_registry() -> Result<(), serde_json::Error> {
    let bytes = serde_json::to_vec(&AccountRegistry::empty())?;
    let (accounts, migrated) = AccountRegistry::from_bytes(&bytes, "sable-next")?;
    assert!(!migrated);
    assert!(accounts.accounts.is_empty());
    Ok(())
}

#[test]
fn allocates_distinct_store_ids() {
    assert_ne!(
        account_store_id("sable-next", "a1"),
        account_store_id("sable-next", "a2")
    );
    let mut accounts = AccountRegistry::empty();
    let (_, first) = accounts.allocate_account("sable-next");
    let (_, second) = accounts.allocate_account("sable-next");
    assert_ne!(first, second);
}

#[test]
fn a_stale_sign_in_gives_way_to_the_latest_usable_one_of_its_user() {
    let account = |id: &str, user: &str, needs_reauth: bool| {
        serde_json::json!({
            "account_id": id, "store_id": id, "needs_reauth": needs_reauth,
            "session": {"homeserver": "https://example.org", "credentials": {
                "kind": "password", "user_id": user, "device_id": id, "access_token": ""}}
        })
    };
    let bytes = serde_json::to_vec(&serde_json::json!({
        "version": 1, "active_account_id": "a3", "next_account_id": 6,
        "accounts": [
            account("a1", "@alice:example.org", false),
            account("a2", "@alice:example.org", false),
            account("a3", "@alice:example.org", true),
            account("a4", "@bob:example.org", true),
            account("a5", "@carol:example.org", false),
        ]
    }))
    .unwrap();
    let (mut registry, _) = AccountRegistry::from_bytes(&bytes, "base").unwrap();

    let stale = registry.mark_stale_sign_ins();

    assert_eq!(stale, ["a1", "a3"]);
    let usable: Vec<_> = registry
        .accounts
        .iter()
        .filter(|account| account.state.usable())
        .map(|account| account.account_id.as_str())
        .collect();
    assert_eq!(usable, ["a2", "a5"]);
    assert_eq!(registry.accounts.len(), 5);
    assert_eq!(registry.active_account_id.as_deref(), Some("a2"));
    assert_eq!(registry.mark_stale_sign_ins(), ["a1", "a3"]);
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_file_in_a_store_slot_counts_as_taken() {
    let directory = tempfile::tempdir().unwrap();
    let slot = directory.path().join("slot");
    std::fs::write(&slot, b"not a folder").unwrap();

    assert!(
        super::store_holds_data(slot.to_str().unwrap())
            .await
            .unwrap()
    );
}

#[test]
fn only_an_allocated_account_store_may_be_deleted() {
    let base = "/data/moe.sable.next";
    assert!(removable_account_store(base, &account_store_id(base, "a1")));
    assert!(!removable_account_store(base, base));
    assert!(!removable_account_store(
        base,
        "/data/moe.sable.next-account-"
    ));
    assert!(!removable_account_store(base, "/data/other-account-a1"));
    assert!(!removable_account_store(base, "/data/moe.sable.next/store"));
}

#[test]
fn reanchors_a_store_id_left_under_an_old_data_dir() -> Result<(), serde_json::Error> {
    let bytes = registry_json("/old/container/moe.sable.next-account-a1");
    let (mut accounts, _) = AccountRegistry::from_bytes(&bytes, "/new/container/moe.sable.next")?;

    assert!(accounts.reanchor_stores("/new/container/moe.sable.next"));
    assert_eq!(
        accounts.accounts[0].store_id,
        "/new/container/moe.sable.next-account-a1"
    );
    assert!(!accounts.reanchor_stores("/new/container/moe.sable.next"));
    Ok(())
}

#[test]
fn keeps_a_store_id_already_under_the_current_data_dir() -> Result<(), serde_json::Error> {
    let bytes = registry_json("/data/moe.sable.next-account-a1");
    let (mut accounts, _) = AccountRegistry::from_bytes(&bytes, "/data/moe.sable.next")?;
    assert!(!accounts.reanchor_stores("/data/moe.sable.next"));

    // Legacy single-store layout: the id is the base dir itself.
    let bytes = registry_json("/data/moe.sable.next");
    let (mut accounts, _) = AccountRegistry::from_bytes(&bytes, "/data/moe.sable.next")?;
    assert!(!accounts.reanchor_stores("/data/moe.sable.next"));
    Ok(())
}

#[test]
fn keeps_relative_web_store_names() -> Result<(), serde_json::Error> {
    let bytes = registry_json("sable-next-account-a1");
    let (mut accounts, _) = AccountRegistry::from_bytes(&bytes, "sable-next")?;
    assert!(!accounts.reanchor_stores("sable-next"));
    assert_eq!(accounts.accounts[0].store_id, "sable-next-account-a1");
    Ok(())
}

#[cfg(not(target_family = "wasm"))]
fn offline_session() -> super::PersistedSession {
    let (mut registry, _) =
        AccountRegistry::from_bytes(&registry_json("unused"), "unused").unwrap();
    let mut persisted = registry.accounts.remove(0).session;
    persisted.resolved_homeserver = Some(url::Url::parse("https://endpoint.invalid").unwrap());
    persisted
}

#[cfg(not(target_family = "wasm"))]
async fn seed_crypto(store_id: &str, persisted: &super::PersistedSession) -> matrix_sdk::Client {
    let client = super::build_client_at(
        store_id,
        persisted.resolved_homeserver.as_ref().unwrap(),
        true,
    )
    .await
    .unwrap();
    super::restore_credentials(&client, persisted)
        .await
        .unwrap();
    client
}

#[cfg(not(target_family = "wasm"))]
async fn multi_process_client(store_id: &str) -> matrix_sdk::Client {
    let lock = matrix_sdk_common::cross_process_lock::CrossProcessLockConfig::multi_process(
        "push".to_owned(),
    );
    let key = crate::store_encryption::saved_key(store_id).unwrap();
    let store =
        crate::store_encryption::config(std::path::Path::new(store_id).join("store"), key.as_ref());
    matrix_sdk::Client::builder()
        .homeserver_url("https://endpoint.invalid")
        .sqlite_store_with_config_and_cache_path(store, None::<std::path::PathBuf>)
        .cross_process_store_config(lock)
        .build()
        .await
        .unwrap()
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_restored_notification_client_leaves_the_crypto_store_lock_to_the_sdk() {
    let root = tempfile::tempdir().unwrap();
    let store_id = root.path().to_str().unwrap();
    drop(seed_crypto(store_id, &offline_session()).await);
    let persisted = offline_session();

    let push = multi_process_client(store_id).await;
    super::restore_credentials_with(
        &push,
        &persisted,
        matrix_sdk::store::RoomLoadSettings::default(),
    )
    .await
    .unwrap();

    assert!(
        push.encryption()
            .try_lock_store_once()
            .await
            .unwrap()
            .is_none(),
        "holding the lock from restore stalls the SDK's notification encryption sync"
    );
}

#[cfg(not(any(target_family = "wasm", target_os = "android", target_os = "ios")))]
#[tokio::test]
async fn idle_desktop_crypto_store_does_not_write() {
    let root = tempfile::tempdir().unwrap();
    let client = seed_crypto(root.path().to_str().unwrap(), &offline_session()).await;
    let _sync = super::build_sync(client.clone()).await.unwrap();
    let _guard = client.encryption().spin_lock_store(None).await.unwrap();
    let observer = rusqlite::Connection::open_with_flags(
        root.path().join("store/matrix-sdk-crypto.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let before: i64 = observer
        .pragma_query_value(None, "data_version", |row| row.get(0))
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let after: i64 = observer
        .pragma_query_value(None, "data_version", |row| row.get(0))
        .unwrap();
    assert_eq!(before, after, "idle crypto store committed database writes");
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn relocated_legacy_store_preserves_the_device_encryption_identity() {
    let root = tempfile::tempdir().unwrap();
    let old = root.path().join("old");
    let new = root.path().join("new");
    let old_store = old.join("Sable");
    let new_store = new.join("Sable");
    let persisted = offline_session();
    let client = seed_crypto(old_store.to_str().unwrap(), &persisted).await;
    let key = client.encryption().curve25519_key().await.unwrap();
    drop(client);
    std::fs::rename(&old, &new).unwrap();
    let (mut registry, _) = AccountRegistry::from_bytes(
        &registry_json(old_store.to_str().unwrap()),
        old_store.to_str().unwrap(),
    )
    .unwrap();
    registry.accounts[0].session = persisted.clone();
    assert!(registry.reanchor_stores(new_store.to_str().unwrap()));
    let restored = super::restore_authenticated_client(&registry.accounts[0].store_id, &persisted)
        .await
        .unwrap();
    assert_eq!(
        restored.device_id().unwrap().as_str(),
        persisted.credentials.device_id()
    );
    assert_eq!(restored.encryption().curve25519_key().await.unwrap(), key);
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn missing_crypto_store_does_not_recreate_an_existing_device() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("missing");
    let result =
        super::restore_authenticated_client(missing.to_str().unwrap(), &offline_session()).await;
    result.unwrap_err();
    assert!(!missing.exists());
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn empty_crypto_store_does_not_recreate_an_existing_device() {
    let root = tempfile::tempdir().unwrap();
    let client = super::build_client_at(
        root.path().to_str().unwrap(),
        &url::Url::parse("https://endpoint.invalid").unwrap(),
        true,
    )
    .await
    .unwrap();
    drop(client);
    super::restore_authenticated_client(root.path().to_str().unwrap(), &offline_session())
        .await
        .unwrap_err();
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn clearing_disposable_cache_keeps_the_encryption_identity() {
    let root = tempfile::tempdir().unwrap();
    let store_id = root.path().to_str().unwrap();
    let persisted = offline_session();
    let client = seed_crypto(store_id, &persisted).await;
    let key = client.encryption().curve25519_key().await.unwrap();
    drop(client);
    std::fs::remove_dir_all(root.path().join("cache")).unwrap();
    let client = super::restore_authenticated_client(store_id, &persisted)
        .await
        .unwrap();
    assert_eq!(client.encryption().curve25519_key().await.unwrap(), key);
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn restoring_a_different_device_refuses_the_saved_crypto_identity() {
    let root = tempfile::tempdir().unwrap();
    let store_id = root.path().to_str().unwrap();
    let persisted = offline_session();
    let client = seed_crypto(store_id, &persisted).await;
    let key = client.encryption().curve25519_key().await.unwrap();
    drop(client);
    let mut wrong = persisted.clone();
    if let super::Credentials::Password(session) = &mut wrong.credentials {
        session.meta.device_id = "OTHER".into();
    }
    super::restore_authenticated_client(store_id, &wrong)
        .await
        .unwrap_err();
    let restored = super::restore_authenticated_client(store_id, &persisted)
        .await
        .unwrap();
    assert_eq!(restored.encryption().curve25519_key().await.unwrap(), key);
}
