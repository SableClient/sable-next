use crate::api::encryption::DeleteDeviceParams;
use crate::session::{self, AccountState, Credentials, PersistedAccount};
use crate::test_support::wait_until_retired;
use std::sync::Arc;

use matrix_sdk::{
    Room,
    ruma::{event_id, events::room::message::RoomMessageEventContent, room_id},
    test_utils::mocks::MatrixMockServer,
};
use matrix_sdk_ui::sync_service::SyncService;
use wiremock::ResponseTemplate;

use crate::{
    CachedTimeline, Core,
    protocol::{RpcCode, RpcError},
    session::Session,
    store::MemorySessionStore,
};

struct DelayedSecondSave {
    attempts: Arc<std::sync::atomic::AtomicUsize>,
    bytes: Arc<parking_lot::Mutex<Option<Vec<u8>>>>,
    started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

#[async_trait::async_trait]
impl crate::store::SessionStore for DelayedSecondSave {
    async fn load(&self) -> Result<Option<Vec<u8>>, crate::store::StoreError> {
        Ok(self.bytes.lock().clone())
    }

    async fn save(&self, bytes: Vec<u8>) -> Result<(), crate::store::StoreError> {
        if self
            .attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            == 1
        {
            self.started.notify_one();
            self.release.notified().await;
        }
        *self.bytes.lock() = Some(bytes);
        Ok(())
    }

    async fn clear(&self) -> Result<(), crate::store::StoreError> {
        Ok(())
    }
}
async fn start_test_session(
    core: &Arc<Core>,
    client: matrix_sdk::Client,
    homeserver: String,
    account_id: &'static str,
) -> Result<(), RpcError> {
    core.supervise("test session start", move |core, supervised| {
        Box::pin(async move {
            let generation = core.lifecycle.claim(&supervised);
            Box::pin(core.start_session(
                client,
                homeserver,
                account_id.to_owned(),
                &generation,
                &supervised,
            ))
            .await
            .map(drop)
        })
    })
    .await?
}

async fn core_with_room() -> (tempfile::TempDir, MatrixMockServer, Arc<Core>, Room) {
    let server = MatrixMockServer::new().await;
    server
        .mock_versions()
        .with_feature("org.matrix.msc4140", true)
        .ok()
        .mount()
        .await;
    let client = server.client_builder().no_server_versions().build().await;
    let room = server
        .sync_joined_room(&client, room_id!("!regression:example.org"))
        .await;
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let base = tempfile::tempdir().unwrap();
    let (core, _events) = Core::new(
        base.path().to_str().unwrap(),
        Box::new(MemorySessionStore::default()),
    );
    crate::test_support::set_session(
        &core,
        Some(Session {
            account_id: "first".to_owned(),
            client,
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
            state: Arc::default(),
        }),
    );
    (base, server, core, room)
}

#[tokio::test]
async fn left_rooms_names_only_the_rooms_the_account_left() {
    let (_store, server, core, room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    server
        .sync_room(
            &room.client(),
            matrix_sdk_test::LeftRoomBuilder::new(room_id!("!gone:example.org")),
        )
        .await;

    let (user_id, rooms) = session.left_rooms().unwrap();
    assert_eq!(user_id, room.client().user_id().unwrap().to_string());
    assert_eq!(rooms, ["!gone:example.org"]);
}

#[test]
fn oauth_account_deactivation_uses_the_provider_portal_without_a_direct_action() {
    use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AuthorizationServerMetadata;
    for actions in [
        serde_json::json!([]),
        serde_json::json!(["org.matrix.profile"]),
    ] {
        let metadata: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
            "issuer": "https://id.example.org/",
            "authorization_endpoint": "https://id.example.org/authorize",
            "token_endpoint": "https://id.example.org/token",
            "revocation_endpoint": "https://id.example.org/revoke",
            "response_types_supported": ["code"],
            "response_modes_supported": ["query", "fragment"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "account_management_uri": "https://id.example.org/account?lang=en#profile",
            "account_management_actions_supported": actions,
        }))
        .unwrap();
        assert_eq!(
            super::oauth_account_deactivate_url(&metadata).unwrap(),
            "https://id.example.org/account?lang=en#profile"
        );
    }
}

#[test]
fn oauth_account_deactivation_prefers_the_advertised_direct_action() {
    use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::{
        AccountManagementAction, AuthorizationServerMetadata,
    };
    let metadata: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
        "issuer": "https://id.example.org/",
        "authorization_endpoint": "https://id.example.org/authorize",
        "token_endpoint": "https://id.example.org/token",
        "revocation_endpoint": "https://id.example.org/revoke",
        "response_types_supported": ["code"],
        "response_modes_supported": ["query", "fragment"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "account_management_uri": "https://id.example.org/account",
        "account_management_actions_supported": [AccountManagementAction::AccountDeactivate.as_str()],
    })).unwrap();
    let url = url::Url::parse(&super::oauth_account_deactivate_url(&metadata).unwrap()).unwrap();
    assert!(url.query_pairs().any(|(key, value)| key == "action"
        && value == AccountManagementAction::AccountDeactivate.as_str()));
}

#[test]
fn oauth_account_deactivation_requires_a_provider_portal() {
    use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AuthorizationServerMetadata;
    let metadata: AuthorizationServerMetadata = serde_json::from_value(serde_json::json!({
        "issuer": "https://id.example.org/",
        "authorization_endpoint": "https://id.example.org/authorize",
        "token_endpoint": "https://id.example.org/token",
        "revocation_endpoint": "https://id.example.org/revoke",
        "response_types_supported": ["code"],
        "response_modes_supported": ["query", "fragment"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
    }))
    .unwrap();
    assert!(matches!(
        super::oauth_account_deactivate_url(&metadata),
        Err(RpcError {
            code: RpcCode::Unsupported,
            ..
        })
    ));
}

#[test]
fn oauth_device_deletion_uses_supported_actions_or_the_management_page() {
    use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AuthorizationServerMetadata;
    let mut value = serde_json::json!({
        "issuer": "https://id.example.org/", "authorization_endpoint": "https://id.example.org/authorize",
        "token_endpoint": "https://id.example.org/token", "revocation_endpoint": "https://id.example.org/revoke",
        "response_types_supported": ["code"], "response_modes_supported": ["query", "fragment"],
        "grant_types_supported": ["authorization_code", "refresh_token"], "code_challenge_methods_supported": ["S256"],
        "account_management_uri": "https://id.example.org/account"
    });
    let device = matrix_sdk::ruma::device_id!("DEVICE");
    let metadata: AuthorizationServerMetadata = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(
        super::oauth_device_delete_url(&metadata, device).unwrap(),
        "https://id.example.org/account"
    );
    for action in ["org.matrix.device_delete", "org.matrix.session_end"] {
        value["account_management_actions_supported"] = serde_json::json!([action]);
        let metadata: AuthorizationServerMetadata = serde_json::from_value(value.clone()).unwrap();
        let url =
            url::Url::parse(&super::oauth_device_delete_url(&metadata, device).unwrap()).unwrap();
        assert!(
            url.query_pairs()
                .any(|(key, value)| key == "action" && value == action)
        );
        assert!(
            url.query_pairs()
                .any(|(key, value)| key == "device_id" && value == "DEVICE")
        );
    }
    value
        .as_object_mut()
        .unwrap()
        .remove("account_management_uri");
    let metadata: AuthorizationServerMetadata = serde_json::from_value(value).unwrap();
    assert!(matches!(
        super::oauth_device_delete_url(&metadata, device),
        Err(RpcError {
            code: RpcCode::Unsupported,
            ..
        })
    ));
}

#[tokio::test]
async fn legacy_sessions_use_server_device_management() {
    let (_store, server, core, room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    assert!(room.client().oauth().full_session().is_none());
    server
        .oauth()
        .mock_server_metadata()
        .ok_https()
        .expect(1)
        .mount()
        .await;
    server.mock_devices().ok().mount().await;

    let base = server.server().uri().replace("http://", "https://");
    let url = session
        .delete_device(DeleteDeviceParams {
            device_id: "OTHER".into(),
            password: None,
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        url,
        format!("{base}/account?action=org.matrix.session_end&device_id=OTHER")
    );
}

#[tokio::test]
async fn servers_without_oauth_keep_legacy_device_deletion() {
    let (_store, server, core, _room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    server
        .oauth()
        .mock_server_metadata()
        .error_unrecognized()
        .expect(1)
        .mount()
        .await;
    server.mock_devices().ok().mount().await;
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path(
            "/_matrix/client/v3/delete_devices",
        ))
        .and(wiremock::matchers::body_json(
            serde_json::json!({"devices": ["OTHER"]}),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(1)
        .mount(server.server())
        .await;

    assert!(
        session
            .delete_device(DeleteDeviceParams {
                device_id: "OTHER".into(),
                password: None,
            })
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn invalid_metadata_does_not_use_legacy_device_deletion() {
    let (_store, server, core, _room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    server
        .oauth()
        .mock_server_metadata()
        .ok_json(serde_json::json!({"issuer": "https://id.example.org"}))
        .expect(1)
        .mount()
        .await;

    session
        .delete_device(DeleteDeviceParams {
            device_id: "OTHER".into(),
            password: None,
        })
        .await
        .unwrap_err();
    assert!(
        server
            .server()
            .received_requests()
            .await
            .unwrap()
            .iter()
            .all(|request| !request.url.path().ends_with("/delete_devices"))
    );
}

#[tokio::test]
async fn overlapping_failed_attempts_leave_committed_generation_unchanged() {
    let (core, _events) = Core::new("attempts", Box::new(MemorySessionStore::default()));
    let (first, second) = core
        .supervise("test claims", |core, supervised| {
            Box::pin(async move {
                let first = core.lifecycle.claim(&supervised);
                let second = core.lifecycle.claim(&supervised);
                assert!(!first.is_newest(&core.lifecycle));
                assert!(second.is_newest(&core.lifecycle));
                (first.value(), second.value())
            })
        })
        .await
        .unwrap();
    assert_eq!((first, second), (2, 3));
    assert_eq!(core.lifecycle.current(), 1);
}

#[tokio::test]
async fn unknown_token_during_failed_preparation_still_ends_the_active_session() {
    use crate::session::{AccountRegistry, PersistedAccount, current_session};
    let (_store, server, core, room) = core_with_room().await;
    let mut registry = AccountRegistry::empty();
    registry.active_account_id = Some("first".to_owned());
    registry.upsert(PersistedAccount {
        account_id: "first".to_owned(),
        store_id: core.store_id.clone(),
        session: current_session(&room.client(), server.server().uri()).unwrap(),
        state: AccountState::Usable,
    });
    *core.accounts.lock().await = Some(registry);
    let pending = core.hold_supervisor().await;
    let mut rejected = ruma::api::error::UnknownTokenErrorData::new();
    rejected.soft_logout = true;
    assert!(core.handle_session_change(&matrix_sdk::SessionChange::UnknownToken(rejected), 1));
    tokio::task::yield_now().await;
    assert!(core.session.snapshot().is_some());
    drop(pending);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if !core.accounts().await.unwrap().accounts[0].state.usable() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(core.session.snapshot().is_none());
}

#[tokio::test]
async fn rejected_devices_discard_credentials_but_keep_their_stores() {
    use crate::session::{AccountRegistry, PersistedAccount, current_session};
    for hard in [false, true] {
        let server = MatrixMockServer::new().await;
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().join("sable");
        let base = base.to_str().unwrap();
        let store_id = session::account_store_id(base, "a1");
        let client = server
            .client_builder()
            .on_builder(|builder| {
                builder.sqlite_store_with_cache_path(
                    std::path::Path::new(&store_id).join("store"),
                    std::path::Path::new(&store_id).join("cache"),
                    None,
                )
            })
            .build()
            .await;
        client
            .encryption()
            .wait_for_e2ee_initialization_tasks()
            .await;
        let saved = current_session(&client, server.server().uri()).unwrap();
        let (core, _events) = Core::new(base, Box::new(MemorySessionStore::default()));
        let mut registry = AccountRegistry::empty();
        registry.active_account_id = Some("a1".to_owned());
        registry.upsert(PersistedAccount {
            account_id: "a1".to_owned(),
            store_id: store_id.clone(),
            session: saved.clone(),
            state: AccountState::Usable,
        });
        *core.accounts.lock().await = Some(registry);
        core.clients.insert("a1", client.clone());
        let database = std::path::Path::new(&store_id).join("store/matrix-sdk-crypto.sqlite3");
        assert!(database.exists());
        core.needs_reauth(Some("a1"), hard).await.unwrap();
        assert!(database.exists());
        let bytes = core.sessions.load().await.unwrap().unwrap();
        let (registry, _) = AccountRegistry::from_bytes(&bytes, base).unwrap();
        let account = &registry.accounts[0];
        assert!(!account.state.usable());
        assert_eq!(account.state.device_gone(), hard);
        assert_eq!(
            account.session.credentials.user_id(),
            saved.credentials.user_id()
        );
        assert_eq!(
            account.session.credentials.device_id(),
            saved.credentials.device_id()
        );
        if hard {
            assert_eq!(account.session.credentials.tokens().access_token, "");
            assert!(account.session.credentials.tokens().refresh_token.is_none());
        } else {
            assert_eq!(
                account.session.credentials.tokens(),
                saved.credentials.tokens()
            );
        }
    }
}

#[tokio::test]
async fn a_hard_token_rejection_keeps_the_account() {
    use crate::session::{AccountRegistry, PersistedAccount, current_session};
    let (_store, server, core, room) = core_with_room().await;
    let mut registry = AccountRegistry::empty();
    registry.active_account_id = Some("first".to_owned());
    registry.upsert(PersistedAccount {
        account_id: "first".to_owned(),
        store_id: core.store_id.clone(),
        session: current_session(&room.client(), server.server().uri()).unwrap(),
        state: AccountState::Usable,
    });
    *core.accounts.lock().await = Some(registry);
    let rejected = ruma::api::error::UnknownTokenErrorData::new();
    assert!(core.handle_session_change(&matrix_sdk::SessionChange::UnknownToken(rejected), 1));
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let accounts = core.accounts().await.unwrap().accounts;
            if accounts
                .first()
                .is_some_and(|account| !account.state.usable())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let accounts = core.accounts().await.unwrap().accounts;
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].account_id, "first");
    assert!(accounts[0].state.device_gone());
}

#[tokio::test]
async fn ending_a_session_never_waits_for_code_still_using_it() {
    let (_store, _server, core, _room) = core_with_room().await;
    let in_use = core.session.snapshot();
    let ended = tokio::time::timeout(std::time::Duration::from_secs(5), core.end_session())
        .await
        .expect("a session ends while a reader still holds it");
    assert!(ended.is_some());
    assert!(core.signed_in().is_err());
    drop(in_use);
}

#[tokio::test]
async fn a_session_ending_while_a_room_opens_does_not_deadlock() {
    let (_store, _server, core, _room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    let session_state = session.state();
    let opening = session_state.room_subscriptions.lock().await;
    let ending = core.end_session();
    tokio::pin!(ending);
    assert!(futures_util::poll!(ending.as_mut()).is_pending());

    core.signed_in()
        .expect("opening a room must be able to read the session");
    drop(opening);
    assert!(ending.await.is_some());
}

#[tokio::test]
async fn becoming_active_starts_an_idle_sync_service_and_hiding_stops_it() {
    use matrix_sdk_ui::sync_service::State;

    let (_store, _server, core, _room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    let sync_service = session.sync_service();
    assert!(matches!(sync_service.state().get(), State::Idle));

    core.update_app_active(true).await;
    assert!(!matches!(sync_service.state().get(), State::Idle));
    assert!(!core.activity.sync_suspended());

    core.update_app_active(false).await;
    assert!(matches!(sync_service.state().get(), State::Idle));
    assert!(core.activity.sync_suspended());
}

#[tokio::test]
async fn removing_an_inactive_account_signs_its_device_out() {
    use crate::api::session::RemoveAccountParams;
    use crate::session::{AccountRegistry, PersistedAccount, current_session};
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };

    let (_store, server, core, room) = core_with_room().await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/logout"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    let store_id = session::account_store_id(&core.store_id, "second");
    std::fs::create_dir_all(&store_id).unwrap();
    // Its own device: a twin of the active one is left signed in.
    let mut session =
        serde_json::to_value(current_session(&room.client(), server.server().uri()).unwrap())
            .unwrap();
    session["credentials"]["device_id"] = "SECOND".into();
    let account = PersistedAccount {
        account_id: "second".to_owned(),
        store_id,
        session: serde_json::from_value(session).unwrap(),
        state: AccountState::Usable,
    };
    core.save_login_tokens(&account).await.unwrap();
    let mut registry = AccountRegistry::empty();
    registry.upsert(account);
    *core.accounts.lock().await = Some(registry);

    core.remove_inactive_account(RemoveAccountParams {
        account_id: "second".to_owned(),
    })
    .await
    .unwrap();

    server.server().verify().await;
}

struct FailingSaves {
    failing: Arc<std::sync::atomic::AtomicBool>,
    inner: MemorySessionStore,
}

#[async_trait::async_trait]
impl crate::store::SessionStore for FailingSaves {
    async fn load(&self) -> Result<Option<Vec<u8>>, crate::store::StoreError> {
        self.inner.load().await
    }

    async fn save(&self, bytes: Vec<u8>) -> Result<(), crate::store::StoreError> {
        if self.failing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(crate::store::StoreError::Invalid("saving is refused"));
        }
        self.inner.save(bytes).await
    }

    async fn clear(&self) -> Result<(), crate::store::StoreError> {
        self.inner.clear().await
    }
}

#[tokio::test]
async fn refreshed_tokens_that_failed_to_save_are_saved_again() {
    use crate::session::{AccountRegistry, PersistedAccount, current_session};

    let (store, server, _core, room) = core_with_room().await;
    let failing = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let (core, _events) = Core::new(
        store.path().to_str().unwrap(),
        Box::new(FailingSaves {
            failing: failing.clone(),
            inner: MemorySessionStore::default(),
        }),
    );
    let client = room.client();
    crate::test_support::set_session(
        &core,
        Some(Session {
            account_id: "first".to_owned(),
            client: client.clone(),
            sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
            homeserver: server.server().uri(),
            oauth: false,
            state: Arc::default(),
        }),
    );
    let mut registry = AccountRegistry::empty();
    registry.upsert(PersistedAccount {
        account_id: "first".to_owned(),
        store_id: core.store_id.clone(),
        session: current_session(&client, server.server().uri()).unwrap(),
        state: AccountState::Usable,
    });
    *core.accounts.lock().await = Some(registry);
    core.clients.set_writer("first", 1);

    core.persist_refreshed(&client, &server.server().uri(), "first", 1)
        .await
        .unwrap_err();
    assert!(core.unsaved_tokens.lock().contains("first"));

    failing.store(false, std::sync::atomic::Ordering::SeqCst);
    core.signed_in().unwrap().retry_unsaved_tokens().await;
    assert!(core.unsaved_tokens.lock().is_empty());
}

#[tokio::test]
async fn tokens_refreshed_by_a_superseded_writer_are_not_forgotten() {
    let (_store, server, core, room) = core_with_room().await;
    core.clients.set_writer("first", 2);

    core.persist_refreshed(&room.client(), &server.server().uri(), "first", 1)
        .await
        .unwrap();

    assert!(core.unsaved_tokens.lock().contains("first"));
}

#[tokio::test]
async fn the_active_client_is_listed_once_among_the_clients_with_stores() {
    let (_store, _server, core, room) = core_with_room().await;
    assert_eq!(core.store_clients().await.len(), 1);

    core.clients.insert("first", room.client());
    assert_eq!(core.store_clients().await.len(), 1);

    core.clients.insert("second", room.client());
    assert_eq!(core.store_clients().await.len(), 2);
}

#[tokio::test]
async fn resuming_without_a_network_waits_for_one_to_start_sync() {
    use matrix_sdk_ui::sync_service::State;

    let (_store, _server, core, _room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    let sync_service = session.sync_service();
    core.update_network_conditions(false, true).await;

    core.update_app_active(true).await;
    assert!(matches!(sync_service.state().get(), State::Idle));

    core.update_network_conditions(true, true).await;
    assert!(!matches!(sync_service.state().get(), State::Idle));
}

#[tokio::test]
async fn a_network_coming_back_in_the_background_does_not_start_sync() {
    use matrix_sdk_ui::sync_service::State;

    let (_store, _server, core, _room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    let sync_service = session.sync_service();
    core.update_app_active(false).await;
    core.update_network_conditions(false, true).await;

    core.update_network_conditions(true, true).await;
    assert!(matches!(sync_service.state().get(), State::Idle));
}

#[tokio::test]
async fn foregrounding_without_a_session_clears_the_previous_pause() {
    let (_store, _server, core, _room) = core_with_room().await;
    core.update_app_active(false).await;
    assert!(core.sync_paused());
    core.end_session().await;

    core.update_app_active(true).await;

    assert!(!core.sync_paused());
}

#[tokio::test]
async fn unlocking_an_account_keeps_a_background_sync_paused() {
    use matrix_sdk_ui::sync_service::State;
    use std::time::Duration;

    let (_store, server, core, room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    server
        .mock_who_am_i()
        .ok_with_user_id(room.client().user_id().unwrap())
        .mount()
        .await;
    server
        .mock_sliding_sync()
        .with_delay(Duration::from_secs(1))
        .ok_json(serde_json::json!({"pos": "p", "lists": {}, "rooms": {}}))
        .mount()
        .await;
    session.lock_account(core.lifecycle.current());
    core.update_app_active(false).await;

    tokio::time::timeout(Duration::from_secs(35), async {
        while core.activity.account_locked() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    core.supervise("test settle", |_, _| Box::pin(async {}))
        .await
        .unwrap();
    assert!(matches!(session.sync_service().state().get(), State::Idle));
}

#[tokio::test]
async fn an_ignore_change_restarts_an_idle_foreground_sync() {
    use matrix_sdk_test::event_factory::EventFactory;
    use matrix_sdk_ui::sync_service::State;
    use std::time::Duration;

    let (_store, server, core, room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    let client = room.client();
    let sync = session.sync_service();
    server
        .mock_sliding_sync()
        .with_delay(Duration::from_secs(1))
        .ok_json(serde_json::json!({"pos": "p", "lists": {}, "rooms": {}}))
        .mount()
        .await;
    session.watch_ignored_history(&sync);

    server
        .mock_sync()
        .ok_and_run(&client, |response| {
            response.add_global_account_data(EventFactory::new().ignored_user_list([
                matrix_sdk::ruma::user_id!("@ignored:example.org").to_owned(),
            ]));
        })
        .await;

    tokio::time::timeout(Duration::from_secs(2), async {
        while !matches!(sync.state().get(), State::Running) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn queued_sync_recovery_cannot_undo_a_background_pause() {
    use matrix_sdk_ui::sync_service::State;

    let (_store, _server, core, _room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    let sync = session.sync_service();
    sync.start().await;
    let serial = core.hold_supervisor().await;
    core.set_app_active(false);
    let mut pause = std::pin::pin!(core.apply_app_activity(false));
    assert!(futures_util::poll!(&mut pause).is_pending());
    let mut recovery = std::pin::pin!(core.resume_sync(&sync));
    assert!(futures_util::poll!(&mut recovery).is_pending());
    drop(serial);

    tokio::join!(pause, recovery);

    assert!(matches!(sync.state().get(), State::Idle));
}

#[tokio::test]
async fn a_stale_pause_cannot_stop_a_new_background_interval() {
    use matrix_sdk_ui::sync_service::State;

    let (_store, _server, core, _room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    core.update_app_active(true).await;
    let sync = session.sync_service();

    let serial = core.hold_supervisor().await;
    let old_revision = core.set_app_active(false);
    let old_core = core.clone();
    let old_pause = tokio::spawn(async move {
        old_core
            .apply_app_activity_if_current(false, old_revision)
            .await;
    });
    core.set_app_active(true);
    let revision = core.set_app_active(false);
    drop(serial);
    old_pause.await.unwrap();

    assert!(!core.activity.sync_suspended());
    assert!(!matches!(sync.state().get(), State::Idle));
    core.apply_app_activity_if_current(false, revision).await;
    assert!(core.activity.sync_suspended());
    assert!(!matches!(sync.state().get(), State::Running));
}

#[tokio::test]
async fn a_sync_that_never_answers_is_restarted() {
    use std::time::Duration;

    use matrix_sdk_ui::sync_service::State;

    let (_store, server, core, _room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    server
        .mock_sliding_sync()
        .with_delay(Duration::from_secs(60))
        .ok_json(serde_json::json!({ "pos": "0", "lists": {}, "rooms": {}, "extensions": {} }))
        .mount()
        .await;
    let sync_service = session.sync_service();
    sync_service.start().await;
    let mut states = sync_service.state();

    session.watch_sync_stall(&sync_service, Duration::from_millis(200));

    // The subscriber merges the restart's brief `Idle` into `Running`.
    let restarted = tokio::time::timeout(Duration::from_secs(5), states.next())
        .await
        .expect("a stalled sync is restarted");
    assert!(matches!(restarted, Some(State::Running)));
}

#[tokio::test]
async fn a_manual_retry_starts_sync_on_a_network_reported_gone() {
    use matrix_sdk_ui::sync_service::State;

    let (_store, _server, core, _room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    let sync_service = session.sync_service();
    core.update_network_conditions(false, true).await;
    core.update_app_active(true).await;
    assert!(matches!(sync_service.state().get(), State::Idle));
    assert!(matches!(
        core.shown_sync_status(sync_service.state().get()),
        crate::protocol::SyncStatus::Offline
    ));

    core.retry_sync(&sync_service).await;

    assert!(!matches!(sync_service.state().get(), State::Idle));
}

#[tokio::test]
async fn a_reachable_server_overrules_a_network_reported_gone() {
    use std::time::Duration;

    use matrix_sdk_ui::sync_service::State;

    let (_store, server, core, _room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    server.mock_versions().ok().mount().await;
    let sync_service = session.sync_service();
    core.update_network_conditions(false, true).await;
    core.update_app_active(true).await;
    assert!(matches!(sync_service.state().get(), State::Idle));
    let mut states = sync_service.state();

    session.watch_sync_stall(&sync_service, Duration::from_millis(200));

    tokio::time::timeout(Duration::from_secs(5), states.next())
        .await
        .expect("sync starts once the server answers");
    assert!(core.activity.network_available());
}

#[tokio::test]
async fn a_shut_down_core_stops_its_session_and_refuses_calls() {
    let (_store, _server, core, _room) = core_with_room().await;

    core.shutdown().await;

    assert!(core.session.snapshot().is_none());
    assert!(core.clients.is_empty());
    assert!(matches!(
        core.call("session.restore", "{}").await,
        Err(RpcError {
            code: RpcCode::Unavailable,
            ..
        })
    ));
}

#[tokio::test]
async fn switching_back_to_a_cached_client_rebuilds_one_set_of_handlers() {
    use crate::session::{AccountRegistry, PersistedAccount, current_session};
    let (_store, server, core, room) = core_with_room().await;
    let client = room.client();
    let mut registry = AccountRegistry::empty();
    registry.upsert(PersistedAccount {
        account_id: "first".to_owned(),
        store_id: core.store_id.clone(),
        session: current_session(&client, server.server().uri()).unwrap(),
        state: AccountState::Usable,
    });
    *core.accounts.lock().await = Some(registry);
    let mut handler_counts = Vec::new();
    for _ in 0..2 {
        let previous = core.end_session().await.unwrap();
        previous.sync_service.stop().await;
        start_test_session(&core, client.clone(), server.server().uri(), "first")
            .await
            .unwrap();
        handler_counts.push(
            core.signed_in()
                .unwrap()
                .state()
                .session_handlers
                .lock()
                .len(),
        );
        assert_eq!(core.clients.len(), 1);
        assert_eq!(core.clients.writers(), 1);
    }
    assert!(handler_counts[0] > 0);
    assert_eq!(handler_counts[0], handler_counts[1]);
    let session = core.end_session().await.unwrap();
    session.sync_service.stop().await;
}

#[tokio::test]
async fn a_session_started_while_hidden_stays_suspended() {
    use crate::session::{AccountRegistry, PersistedAccount, current_session};
    use matrix_sdk_ui::sync_service::State;

    let (_store, server, core, room) = core_with_room().await;
    let client = room.client();
    let mut registry = AccountRegistry::empty();
    registry.upsert(PersistedAccount {
        account_id: "first".to_owned(),
        store_id: core.store_id.clone(),
        session: current_session(&client, server.server().uri()).unwrap(),
        state: AccountState::Usable,
    });
    *core.accounts.lock().await = Some(registry);
    drop(core.end_session().await);
    core.set_app_active(false);

    start_test_session(&core, client, server.server().uri(), "first")
        .await
        .unwrap();

    let sync_service = core.signed_in().unwrap().sync_service();
    assert!(matches!(sync_service.state().get(), State::Idle));
    assert!(core.activity.sync_suspended());
}

async fn assert_search_index_restored(core: &Arc<Core>) -> Result<(), tokio::time::error::Elapsed> {
    let session = core.signed_in().unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while session.state().search_index.lock().await.documents().await != 2 {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    assert_eq!(
        session
            .state()
            .search_index
            .lock()
            .await
            .search_pinned(
                "archaeology",
                &crate::search::IndexFilter::default(),
                std::collections::HashSet::new(),
                crate::api::search::SearchOrder::Rank,
                10,
                0
            )
            .await
            .len(),
        2,
        "both restored documents should match"
    );
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_saved_session_restores_while_the_homeserver_is_down() {
    use crate::session::{AccountRegistry, Credentials, PersistedAccount, PersistedSession};

    let server = MatrixMockServer::new().await;
    let base = std::env::temp_dir().join(format!("sable-offline-{}", ruma::TransactionId::new()));
    let base_id = base.to_str().unwrap().to_owned();
    let (core, _events) = Core::new(base_id.clone(), Box::new(MemorySessionStore::default()));
    let mut registry = AccountRegistry::empty();
    let (account_id, store_id) = registry.allocate_account(&base_id);
    registry.active_account_id = Some(account_id.clone());
    let mut session = PersistedSession {
        oauth_issuer: None,
        oauth_redirect_uri: None,
        resolved_homeserver: None,
        homeserver: server.server().uri(),
        credentials: Credentials::Password(
            serde_json::from_value(serde_json::json!({
                "user_id": "@alice:example.org",
                "device_id": "DEVICE",
                "access_token": "token"
            }))
            .unwrap(),
        ),
    };
    let client = session::restore_client(&store_id, &session, true)
        .await
        .unwrap();
    session::restore_credentials(&client, &session)
        .await
        .unwrap();
    drop(client);
    session.homeserver = "offline.invalid".to_owned();
    session.resolved_homeserver = Some(url::Url::parse("http://127.0.0.1:9").unwrap());
    registry.upsert(PersistedAccount {
        account_id,
        store_id,
        session,
        state: AccountState::Usable,
    });
    core.sessions
        .save(serde_json::to_vec(&registry).unwrap())
        .await
        .unwrap();
    drop(server);

    let restored = core.restore().await.unwrap().unwrap();
    assert_eq!(restored.user_id.as_str(), "@alice:example.org");
    drop(core);
    let _ = std::fs::remove_dir_all(base);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cache_reset_keeps_the_login_keys_and_search_index_but_not_the_sync_position() {
    use crate::session::{AccountRegistry, Credentials, PersistedAccount, PersistedSession};
    use matrix_sdk_base::crypto::store::CryptoStore as _;

    let server = MatrixMockServer::new().await;
    let base = std::env::temp_dir().join(format!("sable-reset-{}", ruma::TransactionId::new()));
    let base_id = base.to_str().unwrap().to_owned();
    let (core, _events) = Core::new(base_id.clone(), Box::new(MemorySessionStore::default()));
    let mut registry = AccountRegistry::empty();
    let (account_id, store_id) = registry.allocate_account(&base_id);
    registry.active_account_id = Some(account_id.clone());
    registry.upsert(PersistedAccount {
        account_id,
        store_id: store_id.clone(),
        session: PersistedSession {
            oauth_issuer: None,
            oauth_redirect_uri: None,
            resolved_homeserver: None,
            homeserver: server.server().uri(),
            credentials: Credentials::Password(
                serde_json::from_value(serde_json::json!({
                    "user_id": "@alice:example.org",
                    "device_id": "DEVICE",
                    "access_token": "token"
                }))
                .unwrap(),
            ),
        },
        state: AccountState::Usable,
    });
    core.sessions
        .save(serde_json::to_vec(&registry).unwrap())
        .await
        .unwrap();
    let client = session::restore_client(&store_id, &registry.accounts[0].session, true)
        .await
        .unwrap();
    session::restore_credentials(&client, &registry.accounts[0].session)
        .await
        .unwrap();
    // Seeded before the session opens its search index.
    crate::search::seed_account_index(&store_id, room_id!("!indexed:example.org"), 2).await;
    drop(client);
    core.restore().await.unwrap();

    let client = core.signed_in().unwrap().client().clone();
    let identity = client.encryption().ed25519_key().await;
    assert!(identity.is_some());
    client
        .state_store()
        .set_custom_value(b"marker", b"cached".to_vec())
        .await
        .unwrap();
    let store = std::path::Path::new(&store_id).join("store");
    let pos = "sliding_sync_store::room-list::@alice:example.org::instance";
    matrix_sdk::SqliteCryptoStore::open(&store, None)
        .await
        .unwrap()
        .set_custom_value(pos, br#"{"pos":"stale"}"#.to_vec())
        .await
        .unwrap();
    drop(client);

    core.reset_local_cache().await.unwrap();

    let client = core.signed_in().unwrap().client().clone();
    assert_search_index_restored(&core).await.unwrap();
    assert!(
        client
            .state_store()
            .get_custom_value(b"marker")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(client.encryption().ed25519_key().await, identity);
    assert!(
        matrix_sdk::SqliteCryptoStore::open(&store, None)
            .await
            .unwrap()
            .get_custom_value(pos)
            .await
            .unwrap()
            .is_none()
    );

    let session = core.end_session().await.unwrap();
    session.sync_service.stop().await;
    drop((session, client));
    std::fs::remove_dir_all(&store_id).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn late_refresh_persists_after_teardown_and_reuses_live_client() {
    use crate::session::{AccountRegistry, PersistedAccount, current_session};
    use wiremock::{
        Mock,
        matchers::{method, path},
    };
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().unlogged().build().await;
    let matrix: matrix_sdk::authentication::matrix::MatrixSession = serde_json::from_value(serde_json::json!({
        "user_id": "@alice:example.org", "device_id": "DEVICE", "access_token": "old-access", "refresh_token": "old-refresh"
    })).unwrap();
    client.restore_session(matrix).await.unwrap();
    let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
    let persisted = Arc::new(parking_lot::Mutex::new(None));
    let persistence_started = Arc::new(tokio::sync::Notify::new());
    let release_persistence = Arc::new(tokio::sync::Notify::new());
    let base = tempfile::tempdir().unwrap();
    let (core, _events) = Core::new(
        base.path().to_str().unwrap(),
        Box::new(DelayedSecondSave {
            attempts: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            bytes: persisted.clone(),
            started: persistence_started.clone(),
            release: release_persistence.clone(),
        }),
    );
    let mut registry = AccountRegistry::empty();
    registry.upsert(PersistedAccount {
        account_id: "first".to_owned(),
        store_id: "unused".to_owned(),
        session: current_session(&client, server.server().uri()).unwrap(),
        state: AccountState::Usable,
    });
    *core.accounts.lock().await = Some(registry);
    core.prepare_account_client(&client, &server.server().uri(), "first")
        .await
        .unwrap();
    crate::test_support::set_session(
        &core,
        Some(Session {
            account_id: "first".to_owned(),
            client: client.clone(),
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
            state: Arc::default(),
        }),
    );

    let arrived = Arc::new(tokio::sync::Notify::new());
    let (release, wait) = std::sync::mpsc::sync_channel(1);
    let wait = parking_lot::Mutex::new(wait);
    let received = arrived.clone();
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/refresh"))
        .respond_with(move |_: &wiremock::Request| {
            received.notify_one();
            wait.lock()
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
            ResponseTemplate::new(200).set_body_json(
                serde_json::json!({"access_token":"new-access", "refresh_token":"new-refresh"}),
            )
        })
        .expect(1)
        .mount(server.server())
        .await;
    let refreshing_client = client.clone();
    let refresh =
        tokio::spawn(async move { refreshing_client.matrix_auth().refresh_access_token().await });
    tokio::time::timeout(std::time::Duration::from_secs(5), arrived.notified())
        .await
        .unwrap();
    core.lifecycle.set_current(2);
    let previous = core.end_session().await.unwrap();
    previous.sync_service.stop().await;
    let account = core.accounts().await.unwrap().accounts.remove(0);
    let resumed = core.open_saved_account(&account).await.unwrap();
    release.send(()).unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        persistence_started.notified(),
    )
    .await
    .unwrap();
    assert!(!refresh.is_finished());
    release_persistence.notify_one();
    refresh.await.unwrap().unwrap();
    assert_eq!(
        resumed.session_tokens().unwrap().refresh_token.as_deref(),
        Some("new-refresh")
    );
    assert_eq!(
        saved_refresh_token(&core, &account).as_deref(),
        Some("new-refresh")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refresh_during_an_abandoned_restore_is_saved() {
    use crate::session::{AccountRegistry, Credentials, PersistedAccount, PersistedSession};
    use wiremock::{
        Mock,
        matchers::{method, path_regex},
    };

    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    let base = std::env::temp_dir().join(format!(
        "sable-restore-refresh-{}",
        ruma::TransactionId::new()
    ));
    let base_id = base.to_str().unwrap().to_owned();
    let (core, _events) = Core::new(base_id.clone(), Box::new(MemorySessionStore::default()));
    let mut registry = AccountRegistry::empty();
    let (account_id, store_id) = registry.allocate_account(&base_id);
    registry.active_account_id = Some(account_id.clone());
    registry.upsert(PersistedAccount {
        account_id,
        store_id: store_id.clone(),
        session: PersistedSession {
            oauth_issuer: None,
            oauth_redirect_uri: None,
            resolved_homeserver: None,
            homeserver: server.server().uri(),
            credentials: Credentials::Password(
                serde_json::from_value(serde_json::json!({
                    "user_id": "@alice:example.org",
                    "device_id": "DEVICE",
                    "access_token": "old-access",
                    "refresh_token": "old-refresh"
                }))
                .unwrap(),
            ),
        },
        state: AccountState::Usable,
    });
    core.sessions
        .save(serde_json::to_vec(&registry).unwrap())
        .await
        .unwrap();
    let seeded = session::restore_client(&store_id, &registry.accounts[0].session, true)
        .await
        .unwrap();
    session::restore_credentials(&seeded, &registry.accounts[0].session)
        .await
        .unwrap();
    drop(seeded);

    Mock::given(method("POST"))
        .and(path_regex("/refresh$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(
            serde_json::json!({"access_token": "new-access", "refresh_token": "new-refresh"}),
        ))
        .mount(server.server())
        .await;
    let account = core.accounts().await.unwrap().accounts.remove(0);
    let client = core.open_saved_account(&account).await.unwrap();
    client.refresh_access_token().await.unwrap();

    assert_eq!(
        saved_refresh_token(&core, &account).as_deref(),
        Some("new-refresh")
    );
    drop(client);
    std::fs::remove_dir_all(&store_id).unwrap();
}
async fn logged_in_core() -> (tempfile::TempDir, Arc<Core>, PersistedAccount) {
    use crate::session::{AccountRegistry, current_session};
    let (_store, server, _, room) = core_with_room().await;
    let base = tempfile::tempdir().unwrap();
    let (core, _) = Core::new(
        base.path().to_str().unwrap(),
        Box::new(MemorySessionStore::default()),
    );
    *core.accounts.lock().await = Some(AccountRegistry::empty());
    let persisted = current_session(&room.client(), server.server().uri()).unwrap();
    core.persist("first", &core.store_id, &persisted, None)
        .await
        .unwrap();
    let account = core.accounts().await.unwrap().accounts.remove(0);
    (base, core, account)
}

fn has_login_file(base: &tempfile::TempDir, account: &PersistedAccount) -> bool {
    crate::credentials::LoginTokens::new(base.path())
        .read(
            &account.account_id,
            &account.session.credentials.device_id(),
        )
        .is_ok_and(|tokens| tokens.is_ok())
}
async fn restorable_core() -> (
    MatrixMockServer,
    tempfile::TempDir,
    Arc<Core>,
    PersistedAccount,
    tokio::sync::mpsc::UnboundedReceiver<crate::protocol::CoreEvent>,
) {
    let (_store, server, _, room) = core_with_room().await;
    let base = tempfile::tempdir().unwrap();
    let (core, events) = Core::new(
        base.path().join("data").to_str().unwrap(),
        Box::new(MemorySessionStore::default()),
    );
    let account = PersistedAccount {
        account_id: "first".to_owned(),
        store_id: session::account_store_id(&core.store_id, "first"),
        session: session::current_session(&room.client(), server.server().uri()).unwrap(),
        state: AccountState::Usable,
    };
    let seeded = session::restore_client(&account.store_id, &account.session, true)
        .await
        .unwrap();
    session::restore_credentials(&seeded, &account.session)
        .await
        .unwrap();
    drop(seeded);
    let mut registry = session::AccountRegistry::empty();
    registry.active_account_id = Some(account.account_id.clone());
    registry.upsert(account.clone());
    core.save_login_tokens(&account).await.unwrap();
    core.write_registry(&registry).await.unwrap();
    (server, base, core, account, events)
}

#[tokio::test]
async fn tokens_sealed_with_another_key_ask_to_sign_in_again_once() {
    let (_server, _base, core, account, mut events) = restorable_core().await;
    let device_id = account.session.credentials.device_id();
    crate::test_support::plant_tokens_sealed_with_another_key(
        std::path::Path::new(&core.store_id),
        &account.account_id,
        &device_id,
        &account.session.credentials.tokens(),
    );
    let logs = crate::test_support::TestWriter::default();
    let capture = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_ansi(false)
            .with_env_filter("sable_core=warn")
            .with_writer({
                let logs = logs.clone();
                move || logs.clone()
            })
            .finish(),
    );

    assert!(core.restore().await.unwrap().is_none());
    assert!(core.restore().await.unwrap().is_none());
    core.switch_account(crate::api::session::SwitchAccountParams {
        account_id: account.account_id.clone(),
    })
    .await
    .unwrap_err();

    drop(capture);
    let accounts = core.accounts().await.unwrap();
    assert!(!accounts.accounts[0].state.usable());
    assert!(!accounts.accounts[0].state.device_gone());
    assert_eq!(accounts.accounts[0].store_id, account.store_id);
    assert!(std::path::Path::new(&account.store_id).exists());
    let lines: Vec<_> = String::from_utf8_lossy(&logs.0.lock())
        .lines()
        .map(ToOwned::to_owned)
        .collect();
    assert!(
        lines.iter().all(|line| !line.contains("ERROR")),
        "{lines:?}"
    );
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(lines[0].contains("sealed_with_another_key"), "{lines:?}");
    while let Ok(event) = events.try_recv() {
        assert!(
            !matches!(event, crate::protocol::CoreEvent::Failure { .. }),
            "{event:?}"
        );
    }
    core.shutdown().await;
}

#[tokio::test]
async fn a_missing_login_token_file_asks_to_sign_in_again_on_the_same_device() {
    let (_server, _base, core, account, _events) = restorable_core().await;
    let logins = crate::credentials::LoginTokens::new(std::path::Path::new(&core.store_id));
    core.accounts().await.unwrap();
    logins.forget(&account.account_id);

    assert!(core.restore().await.unwrap().is_none());
    let accounts = core.accounts().await.unwrap();
    assert!(!accounts.accounts[0].state.usable());
    assert!(!accounts.accounts[0].state.device_gone());
    assert!(std::path::Path::new(&account.store_id).exists());
    assert!(core.restore().await.unwrap().is_none());
    core.shutdown().await;
}

#[tokio::test]
async fn unreadable_login_tokens_never_fall_back_to_stale_embedded_tokens() {
    let (_server, _base, core, account, _events) = restorable_core().await;
    let mut registry = core.accounts().await.unwrap();
    let before = core.sessions.load().await.unwrap().unwrap();
    let path = std::fs::read_dir(std::path::Path::new(&core.store_id).join("login-tokens"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "tokens")
        })
        .unwrap();
    std::fs::write(&path, b"unreadable tokens").unwrap();

    assert!(!core.load_login_tokens(&mut registry).await.unwrap());
    core.restore().await.unwrap_err();
    assert_eq!(core.sessions.load().await.unwrap().unwrap(), before);
    assert_eq!(std::fs::read(&path).unwrap(), b"unreadable tokens");
    assert!(core.accounts().await.unwrap().accounts[0].state.usable());

    core.save_login_tokens(&account).await.unwrap();
    assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
    core.shutdown().await;
}

#[tokio::test]
async fn restoring_an_account_retires_a_stale_sign_in_of_the_same_user() {
    let (_server, _base, core, first, _events) = restorable_core().await;
    let stale = PersistedAccount {
        account_id: "stale".to_owned(),
        store_id: session::account_store_id(&core.store_id, "stale"),
        ..first.clone()
    };
    std::fs::create_dir_all(std::path::Path::new(&stale.store_id).join("store")).unwrap();
    let mut registry = core.accounts().await.unwrap();
    registry.accounts.insert(0, stale.clone());
    core.write_registry(&registry).await.unwrap();
    *core.accounts.lock().await = Some(registry);

    assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
    wait_until_retired(&core, "stale").await;

    let accounts = core.list_accounts().await.unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].account_id, "first");
    assert!(!std::path::Path::new(&stale.store_id).exists());
    core.shutdown().await;
}

#[tokio::test]
async fn restoring_a_stale_active_sign_in_starts_the_newer_one_instead() {
    let (_server, _base, core, first, _events) = restorable_core().await;
    let newer = PersistedAccount {
        account_id: "newer".to_owned(),
        store_id: session::account_store_id(&core.store_id, "newer"),
        ..first.clone()
    };
    let seeded = session::restore_client(&newer.store_id, &newer.session, true)
        .await
        .unwrap();
    session::restore_credentials(&seeded, &newer.session)
        .await
        .unwrap();
    drop(seeded);
    let mut registry = core.accounts().await.unwrap();
    registry.upsert(newer.clone());
    core.save_login_tokens(&newer).await.unwrap();
    core.write_registry(&registry).await.unwrap();
    *core.accounts.lock().await = Some(registry);

    assert_eq!(core.restore().await.unwrap().unwrap().account_id, "newer");
    wait_until_retired(&core, "first").await;

    let accounts = core.list_accounts().await.unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].account_id, "newer");
    assert!(!std::path::Path::new(&first.store_id).exists());
    assert!(std::path::Path::new(&newer.store_id).exists());
    core.shutdown().await;
}

/// Replaced sign-ins retire in the background once the new session is up.
/// Another sign-in of `first`'s user, on its own device and store.
fn other_sign_in(core: &Core, first: &PersistedAccount, account_id: &str) -> PersistedAccount {
    let mut persisted = serde_json::to_value(&first.session).unwrap();
    persisted["credentials"]["device_id"] = format!("{account_id}-device").into();
    persisted["credentials"]["access_token"] = format!("{account_id}-token").into();
    let account = PersistedAccount {
        account_id: account_id.to_owned(),
        store_id: session::account_store_id(&core.store_id, account_id),
        session: serde_json::from_value(persisted).unwrap(),
        ..first.clone()
    };
    std::fs::create_dir_all(std::path::Path::new(&account.store_id).join("store")).unwrap();
    account
}

#[tokio::test]
async fn a_stale_sign_in_stays_until_a_started_session_retires_it() {
    let (_server, _base, core, first, _events) = restorable_core().await;
    let stale = other_sign_in(&core, &first, "stale");
    let mut registry = core.accounts().await.unwrap();
    registry.accounts.insert(0, stale.clone());
    registry.active_account_id = None;
    core.write_registry(&registry).await.unwrap();
    *core.accounts.lock().await = Some(registry);

    assert!(core.restore().await.unwrap().is_none());

    let accounts = core.accounts().await.unwrap().accounts;
    assert!(accounts.iter().any(|account| account.account_id == "stale"));
    assert!(std::path::Path::new(&stale.store_id).exists());

    let mut registry = core.accounts().await.unwrap();
    registry.active_account_id = Some("first".to_owned());
    *core.accounts.lock().await = Some(registry);
    assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
    wait_until_retired(&core, "stale").await;

    let accounts = core.list_accounts().await.unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].account_id, "first");
    assert!(!std::path::Path::new(&stale.store_id).exists());
    core.shutdown().await;
}

#[tokio::test]
async fn a_stale_sign_in_whose_room_keys_cannot_be_carried_stays_registered() {
    let (_server, _base, core, first, _events) = restorable_core().await;
    let stale = other_sign_in(&core, &first, "stale");
    std::fs::write(
        std::path::Path::new(&stale.store_id).join("store/matrix-sdk-crypto.sqlite3"),
        b"not a database",
    )
    .unwrap();
    // Retired after the stale one, so its retirement shows the stale one's attempt is over.
    let later = other_sign_in(&core, &first, "later");
    let mut registry = core.accounts().await.unwrap();
    registry.accounts.insert(0, later);
    registry.accounts.insert(0, stale.clone());
    core.write_registry(&registry).await.unwrap();
    *core.accounts.lock().await = Some(registry);

    assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
    wait_until_retired(&core, "later").await;

    let accounts = core.accounts().await.unwrap().accounts;
    let kept = accounts
        .iter()
        .find(|account| account.account_id == "stale")
        .expect("the stale sign-in waits for a later retry");
    assert!(!kept.state.usable());
    assert!(std::path::Path::new(&stale.store_id).exists());
    core.shutdown().await;
}

#[tokio::test]
async fn retiring_a_stale_sign_in_signs_its_own_device_out() {
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let (server, _base, core, first, _events) = restorable_core().await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/logout"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    let stale = other_sign_in(&core, &first, "stale");
    let twin = PersistedAccount {
        session: first.session.clone(),
        ..other_sign_in(&core, &first, "twin")
    };
    let mut registry = core.accounts().await.unwrap();
    for account in [&twin, &stale] {
        registry.accounts.insert(0, account.clone());
        core.save_login_tokens(account).await.unwrap();
    }
    core.write_registry(&registry).await.unwrap();
    *core.accounts.lock().await = Some(registry);

    assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
    wait_until_retired(&core, "stale").await;
    wait_until_retired(&core, "twin").await;

    assert_eq!(core.list_accounts().await.unwrap().len(), 1);
    server.server().verify().await;
    core.shutdown().await;
}

#[tokio::test]
async fn restoring_does_not_wait_for_a_replaced_device_to_sign_out() {
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let (server, _base, core, first, _events) = restorable_core().await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/logout"))
        .respond_with(ResponseTemplate::new(200).set_delay(std::time::Duration::from_secs(60)))
        .mount(server.server())
        .await;
    let stale = other_sign_in(&core, &first, "stale");
    let mut registry = core.accounts().await.unwrap();
    registry.accounts.insert(0, stale.clone());
    core.save_login_tokens(&stale).await.unwrap();
    core.write_registry(&registry).await.unwrap();
    *core.accounts.lock().await = Some(registry);

    assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !server
            .server()
            .received_requests()
            .await
            .unwrap()
            .iter()
            .any(|request| request.url.path() == "/_matrix/client/v3/logout")
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the old device's sign-out reaches the server");

    let logins = crate::credentials::LoginTokens::new(std::path::Path::new(&core.store_id));
    let device_id = stale.session.credentials.device_id();
    assert!(matches!(logins.read("stale", &device_id), Ok(Ok(_))));
    assert!(std::path::Path::new(&stale.store_id).exists());
    core.shutdown().await;
}

#[tokio::test]
async fn an_account_whose_store_cannot_be_deleted_stays_listed_for_another_removal() {
    use crate::api::session::RemoveAccountParams;
    let (_server, _base, core, first, _events) = restorable_core().await;
    let mut persisted = serde_json::to_value(&first.session).unwrap();
    persisted["credentials"]["user_id"] = "@second:example.org".into();
    let second = PersistedAccount {
        session: serde_json::from_value(persisted).unwrap(),
        ..other_sign_in(&core, &first, "second")
    };
    // Disposal refuses a store outside the allocated ones.
    let unrelated = PersistedAccount {
        store_id: format!("{}-elsewhere", core.store_id),
        ..second.clone()
    };
    let mut registry = core.accounts().await.unwrap();
    registry.upsert(unrelated);
    core.save_login_tokens(&second).await.unwrap();
    core.write_registry(&registry).await.unwrap();
    *core.accounts.lock().await = Some(registry);
    let remove = || {
        core.remove_inactive_account(RemoveAccountParams {
            account_id: "second".to_owned(),
        })
    };

    remove().await.unwrap_err();

    let mut registry = core.accounts().await.unwrap();
    let kept = registry
        .accounts
        .iter_mut()
        .find(|account| account.account_id == "second")
        .expect("an account whose store is left stays listed");
    assert!(!kept.state.usable());
    kept.store_id.clone_from(&second.store_id);
    *core.accounts.lock().await = Some(registry);
    remove().await.unwrap();
    let accounts = core.accounts().await.unwrap().accounts;
    assert!(
        accounts
            .iter()
            .all(|account| account.account_id != "second")
    );
    assert!(!std::path::Path::new(&second.store_id).exists());
    core.shutdown().await;
}

#[tokio::test]
async fn a_sign_in_that_never_started_gives_back_the_one_it_replaced() {
    let (_server, _base, core, first, _events) = restorable_core().await;
    let waiting = PersistedAccount {
        state: AccountState::NeedsSignIn,
        ..other_sign_in(&core, &first, "waiting")
    };
    let mut registry = core.accounts().await.unwrap();
    registry.upsert(waiting);
    core.write_registry(&registry).await.unwrap();
    *core.accounts.lock().await = Some(registry);
    let newer = other_sign_in(&core, &first, "newer");

    let replaced = core
        .persist(&newer.account_id, &newer.store_id, &newer.session, None)
        .await
        .unwrap();
    assert_eq!(replaced.all.len(), 2);
    assert_eq!(replaced.usable, ["first"]);
    core.keep_replaced(&replaced.usable).await.unwrap();

    let accounts = core.accounts().await.unwrap().accounts;
    let waits = |account_id: &str| {
        accounts
            .iter()
            .find(|account| account.account_id == account_id)
            .unwrap()
            .state
            != AccountState::Usable
    };
    assert!(!waits("first"));
    assert!(waits("waiting"), "one that already waited still does");
    core.shutdown().await;
}

#[tokio::test]
async fn a_stale_sign_in_of_another_user_keeps_its_store_and_waits() {
    let (_server, _base, core, first, _events) = restorable_core().await;
    let mut session = serde_json::to_value(&other_sign_in(&core, &first, "other").session).unwrap();
    session["credentials"]["user_id"] = "@other:example.org".into();
    let other = PersistedAccount {
        session: serde_json::from_value(session).unwrap(),
        state: AccountState::NeedsSignIn,
        ..other_sign_in(&core, &first, "other")
    };
    let mut registry = core.accounts().await.unwrap();
    registry.upsert(other.clone());
    core.write_registry(&registry).await.unwrap();
    *core.accounts.lock().await = Some(registry);
    assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
    let successor = session::base_client(&first.store_id).unwrap();

    core.retire_replaced_account("other", &successor)
        .await
        .unwrap();

    let accounts = core.accounts().await.unwrap().accounts;
    assert!(accounts.iter().any(|account| account.account_id == "other"));
    assert!(std::path::Path::new(&other.store_id).exists());
    core.shutdown().await;
}

#[tokio::test]
async fn removing_a_twin_of_the_active_device_leaves_it_signed_in() {
    use crate::api::session::RemoveAccountParams;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let (server, _base, core, first, _events) = restorable_core().await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/logout"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(0)
        .mount(server.server())
        .await;
    assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
    let twin = PersistedAccount {
        session: first.session.clone(),
        state: AccountState::NeedsSignIn,
        ..other_sign_in(&core, &first, "twin")
    };
    let mut registry = core.accounts().await.unwrap();
    registry.upsert(twin.clone());
    core.save_login_tokens(&twin).await.unwrap();
    core.write_registry(&registry).await.unwrap();
    *core.accounts.lock().await = Some(registry);

    core.remove_inactive_account(RemoveAccountParams {
        account_id: "twin".to_owned(),
    })
    .await
    .unwrap();

    server.server().verify().await;
    core.shutdown().await;
}

#[tokio::test]
async fn a_new_sign_in_keeps_the_one_it_replaces_until_it_is_retired() {
    let (_server, _base, core, first, _events) = restorable_core().await;
    core.accounts().await.unwrap();
    let newer = other_sign_in(&core, &first, "newer");

    core.persist(&newer.account_id, &newer.store_id, &newer.session, None)
        .await
        .unwrap();

    let accounts = core.accounts().await.unwrap().accounts;
    let replaced = accounts
        .iter()
        .find(|account| account.account_id == "first")
        .expect("the replaced sign-in stays until its session is retired");
    assert!(!replaced.state.usable());
    assert!(std::path::Path::new(&first.store_id).exists());
    core.shutdown().await;
}

#[tokio::test]
async fn unreadable_inactive_tokens_do_not_block_other_accounts_or_removal() {
    use crate::api::session::{RemoveAccountParams, SwitchAccountParams};
    let (_server, _base, core, first, _events) = restorable_core().await;
    let mut persisted = serde_json::to_value(&first.session).unwrap();
    persisted["credentials"]["user_id"] = "@second:example.org".into();
    let second = PersistedAccount {
        account_id: "second".to_owned(),
        store_id: session::account_store_id(&core.store_id, "second"),
        session: serde_json::from_value(persisted).unwrap(),
        ..first.clone()
    };
    let mut registry = core.accounts().await.unwrap();
    registry.upsert(second.clone());
    core.save_login_tokens(&second).await.unwrap();
    core.write_registry(&registry).await.unwrap();
    *core.accounts.lock().await = None;
    let path = std::fs::read_dir(std::path::Path::new(&core.store_id).join("login-tokens"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("second.")
        })
        .unwrap();
    std::fs::write(&path, b"unreadable tokens").unwrap();
    let before = core.sessions.load().await.unwrap().unwrap();
    assert_eq!(core.list_accounts().await.unwrap().len(), 2);
    assert_eq!(core.restore().await.unwrap().unwrap().account_id, "first");
    core.switch_account(SwitchAccountParams {
        account_id: "second".to_owned(),
    })
    .await
    .unwrap_err();
    assert_eq!(core.active_session_info().unwrap().account_id, "first");
    assert_eq!(core.sessions.load().await.unwrap().unwrap(), before);
    assert_eq!(std::fs::read(&path).unwrap(), b"unreadable tokens");
    assert!(core.accounts().await.unwrap().accounts[1].state.usable());

    core.remove_inactive_account(RemoveAccountParams {
        account_id: "second".to_owned(),
    })
    .await
    .unwrap();
    assert_eq!(core.list_accounts().await.unwrap().len(), 1);
    assert!(!path.exists());
    crate::credentials::LoginTokens::new(std::path::Path::new(&core.store_id))
        .read(&first.account_id, &first.session.credentials.device_id())
        .unwrap()
        .unwrap();
    core.shutdown().await;
}

#[tokio::test]
async fn a_registry_drops_only_the_tokens_a_login_file_holds() {
    let (base, core, account) = logged_in_core().await;
    let mut registry = core.accounts().await.unwrap();
    registry.upsert(PersistedAccount {
        account_id: "unmoved".to_owned(),
        ..account.clone()
    });
    let mut empty = account.session.credentials.tokens();
    empty.access_token.clear();
    crate::credentials::LoginTokens::new(base.path())
        .save("unmoved", &account.session.credentials.device_id(), &empty)
        .unwrap();
    core.write_registry(&registry).await.unwrap();

    let saved = core.sessions.load().await.unwrap().unwrap();
    let (saved, _) = session::AccountRegistry::from_bytes(&saved, &core.store_id).unwrap();
    let tokens = |id: &str| {
        saved
            .accounts
            .iter()
            .find(|account| account.account_id == id)
            .unwrap()
            .session
            .credentials
            .tokens()
            .access_token
    };
    assert!(has_login_file(&base, &account));
    assert_eq!(tokens("first"), "");
    assert_eq!(
        tokens("unmoved"),
        account.session.credentials.tokens().access_token
    );
}

#[tokio::test]
async fn retiring_a_device_and_removing_an_account_forget_its_login_file() {
    let (base, core, account) = logged_in_core().await;
    core.needs_reauth(Some("first"), false).await.unwrap();
    assert!(has_login_file(&base, &account));
    core.needs_reauth(Some("first"), true).await.unwrap();
    assert!(!has_login_file(&base, &account));

    let (base, core, account) = logged_in_core().await;
    core.remove_saved(Some("first")).await.unwrap();
    assert!(!has_login_file(&base, &account));
}

fn saved_refresh_token(core: &Core, account: &PersistedAccount) -> Option<String> {
    crate::credentials::LoginTokens::new(std::path::Path::new(&core.store_id))
        .read(
            &account.account_id,
            &account.session.credentials.device_id(),
        )
        .ok()?
        .ok()?
        .refresh_token
}

struct RejectSaves {
    attempts: Arc<std::sync::atomic::AtomicUsize>,
}

#[async_trait::async_trait]
impl crate::store::SessionStore for RejectSaves {
    async fn load(&self) -> Result<Option<Vec<u8>>, crate::store::StoreError> {
        Ok(None)
    }
    async fn save(&self, _: Vec<u8>) -> Result<(), crate::store::StoreError> {
        self.attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(crate::store::StoreError::Message("disk is full".to_owned()))
    }
    async fn clear(&self) -> Result<(), crate::store::StoreError> {
        Ok(())
    }
}

#[tokio::test]
async fn rejected_tokens_stay_retired_when_the_registry_write_fails() {
    use crate::session::{AccountRegistry, PersistedAccount, current_session};
    let (_store, server, _, room) = core_with_room().await;
    let base = tempfile::tempdir().unwrap();
    let (core, _) = Core::new(
        base.path().to_str().unwrap(),
        Box::new(RejectSaves {
            attempts: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }),
    );
    let mut registry = AccountRegistry::empty();
    registry.active_account_id = Some("first".to_owned());
    let account = PersistedAccount {
        account_id: "first".to_owned(),
        store_id: "unused".to_owned(),
        session: current_session(&room.client(), server.server().uri()).unwrap(),
        state: AccountState::Usable,
    };
    core.save_login_tokens(&account).await.unwrap();
    let device_id = account.session.credentials.device_id();
    registry.upsert(account);
    *core.accounts.lock().await = Some(registry);
    core.clients.set_writer("first", 1);
    core.needs_reauth(Some("first"), true).await.unwrap_err();
    crate::credentials::LoginTokens::new(base.path())
        .read("first", &device_id)
        .unwrap()
        .unwrap();
    let accounts = core.accounts().await.unwrap();
    assert!(accounts.active_account_id.is_none());
    assert!(!accounts.accounts[0].state.usable());
    assert!(accounts.accounts[0].state.device_gone());
    assert_eq!(core.clients.writers(), 0);
}

#[tokio::test]
async fn failed_switch_persistence_keeps_the_previous_session() {
    use crate::session::{AccountRegistry, PersistedAccount, current_session};
    let (_store, server, previous_core, _) = core_with_room().await;
    let previous = previous_core.end_session().await.unwrap();
    let client = previous.client.clone();
    let sync_service = previous.sync_service.clone();
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (core, _events) = Core::new(
        "failure-regression",
        Box::new(RejectSaves {
            attempts: attempts.clone(),
        }),
    );
    let mut registry = AccountRegistry::empty();
    registry.active_account_id = Some("first".to_owned());
    for account_id in ["first", "second"] {
        registry.upsert(PersistedAccount {
            account_id: account_id.to_owned(),
            store_id: "unused".to_owned(),
            session: current_session(&client, server.server().uri()).unwrap(),
            state: AccountState::Usable,
        });
    }
    *core.accounts.lock().await = Some(registry);
    let previous = Session {
        state: Arc::default(),
        ..previous
    };
    crate::test_support::set_session(&core, Some(previous));
    start_test_session(&core, client, server.server().uri(), "second")
        .await
        .expect_err("switch must report the failed registry write");
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    let session = core.session.snapshot();
    let session = session.as_ref().unwrap();
    assert_eq!(session.account_id, "first");
    assert!(Arc::ptr_eq(&session.sync_service, &sync_service));
    assert_eq!(
        core.accounts().await.unwrap().active_account_id.as_deref(),
        Some("first")
    );
    assert_eq!(core.lifecycle.current(), 1);
}

#[tokio::test]
async fn token_reload_reads_the_durable_session_and_refuses_retired_writers() {
    use crate::session::{AccountRegistry, PersistedAccount, current_session};
    let (_store, server, core, room) = core_with_room().await;
    let client = room.client();
    let mut registry = AccountRegistry::empty();
    let mut saved = current_session(&client, server.server().uri()).unwrap();
    if let Credentials::Password(session) = &mut saved.credentials {
        session.tokens.access_token = "rotated-access".into();
        session.tokens.refresh_token = Some("rotated-refresh".into());
    }
    let account = PersistedAccount {
        account_id: "first".into(),
        store_id: "unused".into(),
        session: saved,
        state: AccountState::Usable,
    };
    core.save_login_tokens(&account).await.unwrap();
    registry.upsert(account);
    *core.accounts.lock().await = Some(registry);
    core.clients.set_writer("first", 1);
    let tokens = core.reload_saved_tokens("first", 1).await.unwrap();
    assert_eq!(tokens.access_token, "rotated-access");
    assert_eq!(tokens.refresh_token.as_deref(), Some("rotated-refresh"));
    assert_ne!(
        tokens.access_token,
        client.session_tokens().unwrap().access_token
    );
    let mut empty = core.accounts().await.unwrap().accounts.remove(0);
    empty.session.credentials.discard_tokens();
    core.save_login_tokens(&empty).await.unwrap();
    core.reload_saved_tokens("first", 1).await.unwrap_err();
    core.clients.remove("first");
    assert!(matches!(
        core.reload_saved_tokens("first", 1).await,
        Err(RpcError {
            code: RpcCode::NotLoggedIn,
            ..
        })
    ));
}

#[tokio::test]
async fn outgoing_credentials_survive_switch_without_resurrecting_accounts() {
    use crate::session::{AccountRegistry, Credentials, PersistedAccount, current_session};

    let (_store, _server, core, room) = core_with_room().await;
    let client = room.client();
    let fresh = current_session(&client, "example.org".to_owned()).unwrap();
    let mut stale = fresh.clone();
    if let Credentials::Password(matrix) = &mut stale.credentials {
        matrix.tokens.access_token = "stale".to_owned();
    }
    let mut registry = AccountRegistry::empty();
    registry.upsert(PersistedAccount {
        account_id: "first".to_owned(),
        store_id: core.store_id.clone(),
        session: stale.clone(),
        state: AccountState::Usable,
    });
    *core.accounts.lock().await = Some(registry);
    core.clients.set_writer("first", 1);
    core.lifecycle.set_current(2);
    core.persist_refreshed(&client, "example.org", "first", 1)
        .await
        .unwrap();
    let saved = core.accounts().await.unwrap();
    assert_eq!(
        serde_json::to_value(&saved.accounts[0].session).unwrap(),
        serde_json::to_value(&fresh).unwrap()
    );

    core.accounts.lock().await.as_mut().unwrap().accounts[0].session = stale.clone();
    core.clients.set_writer("first", 3);
    core.persist_refreshed(&client, "example.org", "first", 1)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&core.accounts().await.unwrap().accounts[0].session).unwrap(),
        serde_json::to_value(&stale).unwrap()
    );

    core.remove_saved(Some("first")).await.unwrap();
    core.persist_refreshed(&client, "example.org", "first", 3)
        .await
        .unwrap();
    assert!(core.accounts().await.unwrap().accounts.is_empty());
}

#[tokio::test]
async fn session_teardown_removes_thread_timelines() {
    let (_store, server, core, room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    server.mock_room_state_encryption().plain().mount().await;
    let room_id = room.room_id().to_owned();
    let thread_root = event_id!("$thread").to_owned();
    let timeline = session.timeline(&room_id).await.unwrap();
    session.state().thread_timelines.lock().insert(
        (room_id.clone(), thread_root.clone()),
        CachedTimeline {
            timeline: timeline.clone(),
            hidden_events: false,
        },
    );
    assert!(Arc::ptr_eq(
        &session
            .thread_timeline(&room_id, &thread_root)
            .await
            .unwrap(),
        &timeline
    ));

    core.end_session().await;

    assert!(session.state().thread_timelines.lock().is_empty());
    assert!(matches!(
        session.thread_timeline(&room_id, &thread_root).await,
        Err(RpcError {
            code: RpcCode::NotLoggedIn,
            ..
        })
    ));
}

#[tokio::test]
async fn a_slow_timeline_build_blocks_neither_another_room_nor_the_teardown() {
    let (_store, server, core, room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    let slow = room.room_id().to_owned();
    let fast = room_id!("!fast:example.org").to_owned();
    server.sync_joined_room(&room.client(), &fast).await;
    let requests = std::sync::atomic::AtomicUsize::new(0);
    server
        .mock_room_state_encryption()
        .respond_with(move |_: &wiremock::Request| {
            let response = ResponseTemplate::new(404)
                .set_body_json(serde_json::json!({"errcode":"M_NOT_FOUND", "error":"not found"}));
            if requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                response.set_delay(std::time::Duration::from_secs(3))
            } else {
                response
            }
        })
        .mount()
        .await;

    let mut slow_build = std::pin::pin!(session.live_timeline(&slow, false));
    assert!(futures_util::poll!(slow_build.as_mut()).is_pending());

    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        session.live_timeline(&fast, false),
    )
    .await
    .expect("another room must open while one builds")
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(5), core.end_session())
        .await
        .expect("the teardown must not wait for a build")
        .unwrap();

    assert!(matches!(
        slow_build.await,
        Err(RpcError {
            code: RpcCode::NotLoggedIn,
            ..
        })
    ));
    assert!(session.state().timelines.lock().is_empty());
}

#[tokio::test]
async fn confirmed_unencrypted_rooms_still_allow_plaintext_operations() {
    let (_store, server, core, room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    server.mock_room_state_encryption().plain().mount().await;
    assert!(!session.core().room_is_encrypted(&room).await.unwrap());
}

#[tokio::test]
async fn a_bookmark_in_an_encrypted_room_stores_no_message_details() {
    let (_store, server, core, room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    let room_id = room.room_id().to_owned();
    server
        .mock_room_state_encryption()
        .encrypted()
        .mount()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path_regex(r"/event/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "type": "m.room.message",
            "event_id": "$secret",
            "room_id": room_id,
            "sender": "@alice:example.org",
            "origin_server_ts": 5,
            "content": { "msgtype": "m.image", "body": "holiday.png" },
        })))
        .mount(server.server())
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path_regex(r"/account_data/"))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(serde_json::json!({"errcode":"M_NOT_FOUND", "error":"not found"})),
        )
        .mount(server.server())
        .await;
    wiremock::Mock::given(wiremock::matchers::method("PUT"))
        .and(wiremock::matchers::path_regex(r"/account_data/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(server.server())
        .await;

    session
        .set_bookmark(&room_id, &event_id!("$secret").to_owned(), true, 1000)
        .await
        .unwrap();

    let requests = server.server().received_requests().await.unwrap();
    let item = requests
        .iter()
        .find(|request| {
            request.method.as_str() == "PUT" && request.url.path().contains("pl.chrome.bookmark.")
        })
        .expect("bookmark item written");
    let body: serde_json::Value = serde_json::from_slice(&item.body).unwrap();
    assert!(body["uri"].as_str().unwrap().contains("?via="), "{body}");
    assert_eq!(body["msgtype"], serde_json::Value::Null, "{body}");
    assert_eq!(body["body_preview"], serde_json::Value::Null, "{body}");
}

#[tokio::test]
async fn encryption_lookup_failure_prevents_plaintext_operations() {
    let (_store, server, core, room) = core_with_room().await;
    let session = core.signed_in().unwrap();
    let room_id = room.room_id().to_owned();
    assert!(room.encryption_state().is_unknown());
    server
        .mock_room_state_encryption()
        .respond_with(ResponseTemplate::new(403).set_body_json(
            serde_json::json!({"errcode":"M_FORBIDDEN", "error":"state unavailable"}),
        ))
        .expect(3)
        .mount()
        .await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .and(wiremock::matchers::path_regex(r"/account_data/"))
        .respond_with(
            ResponseTemplate::new(404)
                .set_body_json(serde_json::json!({"errcode":"M_NOT_FOUND", "error":"not found"})),
        )
        .mount(server.server())
        .await;

    let scheduled = session
        .schedule_message(
            &room_id,
            RoomMessageEventContent::text_plain("secret"),
            1000,
            None,
        )
        .await;
    assert!(
        matches!(
            scheduled,
            Err(RpcError {
                code: RpcCode::Denied,
                ..
            })
        ),
        "{scheduled:?}"
    );
    assert!(matches!(
        session
            .set_bookmark(&room_id, &event_id!("$secret").to_owned(), true, 1000)
            .await,
        Err(RpcError {
            code: RpcCode::Denied,
            ..
        })
    ));
    assert!(matches!(
        session
            .join_call(
                room_id,
                Some("https://focus.example.org".to_owned()),
                None,
                None
            )
            .await,
        Err(RpcError {
            code: RpcCode::Denied,
            ..
        })
    ));

    let requests = server.server().received_requests().await.unwrap();
    let writes: Vec<_> = requests
        .iter()
        .filter(|request| matches!(request.method.as_str(), "PUT" | "POST"))
        .map(|request| request.url.path())
        .filter(|path| {
            path.contains("/rooms/")
                || path.contains("/account_data/")
                || path.ends_with("/openid/request_token")
        })
        .collect();
    assert!(
        writes.is_empty(),
        "unexpected plaintext operation: {writes:?}"
    );
}

#[tokio::test]
async fn a_call_still_running_when_its_session_ends_stops_with_not_logged_in() {
    let (_store, server, core, _room) = core_with_room().await;
    wiremock::Mock::given(wiremock::matchers::path_regex("/account_data/"))
        .respond_with(ResponseTemplate::new(200).set_delay(std::time::Duration::from_secs(30)))
        .mount(server.server())
        .await;
    let call = tokio::spawn({
        let core = core.clone();
        async move {
            core.run(crate::api::account::DataParams {
                event_type: "org.example.slow".to_owned(),
            })
            .await
        }
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    core.end_session().await;

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), call)
        .await
        .expect("the call stops once its session ends")
        .unwrap();
    assert!(matches!(
        outcome,
        Err(RpcError {
            code: RpcCode::NotLoggedIn,
            ..
        })
    ));
}
