use super::*;

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn hard_logout_login_uses_a_new_device_and_store() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let server = MatrixMockServer::new().await;
    server
        .mock_versions()
        .with_simplified_sliding_sync()
        .ok()
        .mount()
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "user_id": "@alice:example.org", "device_id": "NEW", "access_token": "new-token"
        })))
        .expect(1)
        .mount(server.server())
        .await;
    server.mock_sync().ok(|_| {}).mount().await;
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().join("data");
    let base = base.to_str().unwrap();
    let old_store = session::account_store_id(base, "a1");
    let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "active_account_id": null, "next_account_id": 2,
            "accounts": [{"account_id": "a1", "store_id": old_store, "needs_reauth": true, "device_invalidated": true,
                "session": {"homeserver": server.server().uri(), "resolved_homeserver": server.server().uri(),
                    "credentials": {"kind": "password", "user_id": "@alice:example.org", "device_id": "OLD", "access_token": "old"}}
            }]
        })).unwrap();
    let (registry, _) = session::AccountRegistry::from_bytes(&bytes, base).unwrap();
    let old = session::restore_client(&old_store, &registry.accounts[0].session, true)
        .await
        .unwrap();
    session::restore_credentials(&old, &registry.accounts[0].session)
        .await
        .unwrap();
    let old_key = old.encryption().curve25519_key().await.unwrap();
    let (core, _) = Core::new(base, Box::new(crate::store::MemorySessionStore::default()));
    *core.accounts.lock().await = Some(registry);
    core.login(
        server.server().uri(),
        LoginIdentifier::User {
            user: "@alice:example.org".into(),
        },
        "password".into(),
        Some("a1".into()),
        Some("Acme Chat".into()),
    )
    .await
    .unwrap();
    let requests = server.server().received_requests().await.unwrap();
    let login = requests
        .iter()
        .find(|request| request.url.path().ends_with("/login"))
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&login.body).unwrap();
    assert!(body.get("device_id").is_none());
    assert_eq!(body["initial_device_display_name"], "Acme Chat");
    crate::test_support::wait_until_retired(&core, "a1").await;
    let accounts = core.accounts().await.unwrap();
    assert_eq!(accounts.accounts.len(), 1);
    assert_eq!(accounts.accounts[0].account_id, "a2");
    assert_ne!(accounts.accounts[0].store_id, old_store);
    assert_eq!(accounts.accounts[0].session.credentials.device_id(), "NEW");
    assert_ne!(
        core.signed_in()
            .unwrap()
            .client()
            .encryption()
            .curve25519_key()
            .await
            .unwrap(),
        old_key
    );
    assert_eq!(old.encryption().curve25519_key().await.unwrap(), old_key);
    if let Some(session) = core.end_session().await {
        session.sync_service.stop().await;
    }
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn signing_in_again_seals_tokens_another_key_sealed_with_the_current_one() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let server = MatrixMockServer::new().await;
    server
        .mock_versions()
        .with_simplified_sliding_sync()
        .ok()
        .mount()
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "user_id": "@alice:example.org", "device_id": "EXISTING", "access_token": "new-token"
        })))
        .expect(1)
        .mount(server.server())
        .await;
    server.mock_sync().ok(|_| {}).mount().await;
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().join("data");
    let base = base.to_str().unwrap();
    let store = session::account_store_id(base, "a1");
    let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "active_account_id": null, "next_account_id": 2,
            "accounts": [{"account_id": "a1", "store_id": store, "needs_reauth": false, "device_invalidated": false,
                "session": {"homeserver": server.server().uri(), "resolved_homeserver": server.server().uri(),
                    "credentials": {"kind": "password", "user_id": "@alice:example.org", "device_id": "EXISTING", "access_token": ""}}
            }]
        })).unwrap();
    let (registry, _) = session::AccountRegistry::from_bytes(&bytes, base).unwrap();
    let mut seeded = registry.accounts[0].session.clone();
    seeded.credentials.set_tokens(matrix_sdk::SessionTokens {
        access_token: "old".to_owned(),
        refresh_token: None,
    });
    let old = session::restore_client(&store, &seeded, true)
        .await
        .unwrap();
    session::restore_credentials(&old, &seeded).await.unwrap();
    drop(old);
    let logins = crate::credentials::LoginTokens::new(std::path::Path::new(base));
    logins
        .save("a2", "OTHER", &seeded.credentials.tokens())
        .unwrap();
    crate::test_support::plant_tokens_sealed_with_another_key(
        std::path::Path::new(base),
        "a1",
        "EXISTING",
        &seeded.credentials.tokens(),
    );
    assert_eq!(
        logins.read("a1", "EXISTING").unwrap(),
        Err(crate::credentials::MissingTokens::OtherKey)
    );
    let (core, _) = Core::new(base, Box::new(crate::store::MemorySessionStore::default()));
    *core.accounts.lock().await = Some(registry);

    core.login(
        server.server().uri(),
        LoginIdentifier::User {
            user: "@alice:example.org".into(),
        },
        "password".into(),
        Some("a1".into()),
        None,
    )
    .await
    .unwrap();

    let accounts = core.accounts().await.unwrap();
    assert_eq!(accounts.accounts.len(), 1);
    assert_eq!(accounts.accounts[0].account_id, "a1");
    assert_eq!(accounts.accounts[0].store_id, store);
    assert!(accounts.accounts[0].state.usable());
    assert_eq!(
        logins.read("a1", "EXISTING").unwrap().unwrap().access_token,
        "new-token"
    );
    if let Some(session) = core.end_session().await {
        session.sync_service.stop().await;
    }
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn signing_in_again_replaces_the_saved_account_of_the_same_user() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let server = MatrixMockServer::new().await;
    server
        .mock_versions()
        .with_simplified_sliding_sync()
        .ok()
        .mount()
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "user_id": "@alice:example.org", "device_id": "NEW", "access_token": "new-token"
        })))
        .mount(server.server())
        .await;
    server.mock_sync().ok(|_| {}).mount().await;
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().join("data");
    let base = base.to_str().unwrap();
    let stale_store = session::account_store_id(base, "a1");
    let bob_store = session::account_store_id(base, "a2");
    let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "active_account_id": null, "next_account_id": 3,
            "accounts": [
                {"account_id": "a1", "store_id": stale_store,
                    "session": {"homeserver": server.server().uri(), "resolved_homeserver": server.server().uri(),
                        "credentials": {"kind": "password", "user_id": "@alice:example.org", "device_id": "OLD", "access_token": ""}}},
                {"account_id": "a2", "store_id": bob_store, "needs_reauth": true,
                    "session": {"homeserver": server.server().uri(), "resolved_homeserver": server.server().uri(),
                        "credentials": {"kind": "password", "user_id": "@bob:example.org", "device_id": "BOB", "access_token": ""}}}
            ]
        })).unwrap();
    let (registry, _) = session::AccountRegistry::from_bytes(&bytes, base).unwrap();
    std::fs::create_dir_all(std::path::Path::new(&stale_store).join("store")).unwrap();
    std::fs::create_dir_all(std::path::Path::new(&bob_store).join("store")).unwrap();
    let (core, _) = Core::new(base, Box::new(crate::store::MemorySessionStore::default()));
    *core.accounts.lock().await = Some(registry);

    core.login(
        server.server().uri(),
        LoginIdentifier::User {
            user: "@alice:example.org".into(),
        },
        "password".into(),
        None,
        None,
    )
    .await
    .unwrap();

    crate::test_support::wait_until_retired(&core, "a1").await;
    let accounts = core.accounts().await.unwrap().accounts;
    let ids: Vec<_> = accounts.iter().map(|a| a.account_id.as_str()).collect();
    assert_eq!(ids, ["a2", "a3"]);
    assert!(!std::path::Path::new(&stale_store).exists());
    assert!(std::path::Path::new(&bob_store).exists());
    if let Some(session) = core.end_session().await {
        session.sync_service.stop().await;
    }
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_store_without_an_identity_falls_back_to_a_new_device() {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().join("data");
    let base = base.to_str().unwrap();
    let store = session::account_store_id(base, "a1");
    let path = std::path::Path::new(&store).join("store");
    std::fs::create_dir_all(&path).unwrap();
    matrix_sdk::SqliteCryptoStore::open(path, None)
        .await
        .unwrap();
    let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "active_account_id": null, "next_account_id": 2,
            "accounts": [{"account_id": "a1", "store_id": store, "needs_reauth": true, "device_invalidated": false,
                "session": {"homeserver": "https://example.org", "resolved_homeserver": "https://example.org",
                    "credentials": {"kind": "password", "user_id": "@alice:example.org", "device_id": "OLD", "access_token": "old"}}
            }]
        })).unwrap();
    let (registry, _) = session::AccountRegistry::from_bytes(&bytes, base).unwrap();
    let (core, _) = Core::new(base, Box::new(crate::store::MemorySessionStore::default()));
    *core.accounts.lock().await = Some(registry);
    let account = core
        .reauthentication_account(Some("a1".into()))
        .await
        .unwrap()
        .unwrap();
    assert!(account.state.device_gone());
    assert!(
        core.accounts().await.unwrap().accounts[0]
            .state
            .device_gone()
    );
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn only_an_account_whose_saved_tokens_are_gone_can_sign_in_again() {
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path().join("data");
    let base = base.to_str().unwrap();
    let store = session::account_store_id(base, "a1");
    let path = std::path::Path::new(&store).join("store");
    std::fs::create_dir_all(&path).unwrap();
    matrix_sdk::SqliteCryptoStore::open(path, None)
        .await
        .unwrap();
    let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "active_account_id": "a1", "next_account_id": 2,
            "accounts": [{"account_id": "a1", "store_id": store,
                "needs_reauth": false, "device_invalidated": false,
                "session": {"homeserver": "https://example.org", "resolved_homeserver": "https://example.org",
                    "credentials": {"kind": "password", "user_id": "@alice:example.org", "device_id": "D", "access_token": ""}}
            }]
        })).unwrap();
    let (registry, _) = session::AccountRegistry::from_bytes(&bytes, base).unwrap();
    let (core, _) = Core::new(base, Box::new(crate::store::MemorySessionStore::default()));
    *core.accounts.lock().await = Some(registry);
    let logins = crate::credentials::LoginTokens::new(std::path::Path::new(base));
    logins
        .save(
            "a1",
            "D",
            &matrix_sdk::SessionTokens {
                access_token: "saved".to_owned(),
                refresh_token: None,
            },
        )
        .unwrap();

    assert!(matches!(
        core.reauthentication_account(Some("a1".into())).await,
        Err(RpcError {
            code: RpcCode::NotLoggedIn,
            ..
        })
    ));
    assert!(core.accounts().await.unwrap().accounts[0].state.usable());

    logins.forget("a1");
    core.reauthentication_account(Some("a1".into()))
        .await
        .unwrap()
        .unwrap();
    assert!(!core.accounts().await.unwrap().accounts[0].state.usable());
}

#[cfg(not(target_family = "wasm"))]
async fn oauth_reauthentication_core(
    registered: &str,
) -> (
    matrix_sdk::test_utils::mocks::MatrixMockServer,
    Arc<Core>,
    std::path::PathBuf,
) {
    use matrix_sdk::authentication::oauth::UserSession;
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk::{SessionMeta, SessionTokens};

    let server = MatrixMockServer::new().await;
    server
        .mock_versions()
        .with_simplified_sliding_sync()
        .ok()
        .mount()
        .await;
    let oauth = server.oauth();
    oauth.mock_server_metadata().ok().mount().await;
    oauth.mock_registration().ok().mount().await;
    let directory =
        std::env::temp_dir().join(format!("sable-oauth-reauth-{}", ruma::TransactionId::new()));
    let store_id = directory.to_str().unwrap();
    let (core, _events) = Core::new(
        store_id,
        Box::new(crate::store::MemorySessionStore::default()),
    );
    let persisted = PersistedSession {
        oauth_issuer: Some(Url::parse(&server.server().uri()).unwrap()),
        oauth_redirect_uri: Some(Url::parse(registered).unwrap()),
        resolved_homeserver: Some(Url::parse(&server.server().uri()).unwrap()),
        homeserver: server.server().uri(),
        credentials: Credentials::OAuth {
            client_id: "OLD_CLIENT".to_owned(),
            user: UserSession {
                meta: SessionMeta {
                    user_id: matrix_sdk::ruma::owned_user_id!("@alice:example.org"),
                    device_id: matrix_sdk::ruma::owned_device_id!("EXISTING"),
                },
                tokens: SessionTokens {
                    access_token: "old".to_owned(),
                    refresh_token: None,
                },
            },
        },
    };
    let bytes = serde_json::to_vec(&serde_json::json!({
        "version": 1, "active_account_id": null, "next_account_id": 2,
        "accounts": [{"account_id": "a1", "store_id": store_id, "needs_reauth": true,
            "session": persisted}]
    }))
    .unwrap();
    *core.accounts.lock().await = Some(
        session::AccountRegistry::from_bytes(&bytes, store_id)
            .unwrap()
            .0,
    );
    let client = session::restore_client(store_id, &persisted, true)
        .await
        .unwrap();
    session::restore_credentials(&client, &persisted)
        .await
        .unwrap();
    drop(client);
    (server, core, directory)
}

#[cfg(not(target_family = "wasm"))]
async fn start_oauth_reauthentication(core: &Arc<Core>, requested: &str) -> String {
    core.start_oidc_login(StartOidcLoginParams {
        homeserver: "ignored.invalid".to_owned(),
        redirect_uri: requested.to_owned(),
        intent: AuthIntent::Login,
        reauth_account_id: Some("a1".to_owned()),
        device_display_name: None,
    })
    .await
    .unwrap()
}

#[cfg(not(target_family = "wasm"))]
async fn device_invalidated(core: &Core) -> bool {
    core.accounts()
        .await
        .unwrap()
        .accounts
        .iter()
        .any(|account| account.account_id == "a1" && account.state.device_gone())
}

#[cfg(not(target_family = "wasm"))]
async fn oauth_reauthentication_url(registered: &str, requested: &str) -> (String, bool) {
    let (_server, core, directory) = oauth_reauthentication_core(registered).await;
    let url = start_oauth_reauthentication(&core, requested).await;
    let invalidated = device_invalidated(&core).await;
    *core.sign_in.pending_login.lock().await = None;
    drop(core);
    std::fs::remove_dir_all(directory).unwrap();
    (url, invalidated)
}

#[tokio::test]
async fn oauth_reauthentication_keeps_the_device_of_the_same_client() {
    let (url, invalidated) =
        oauth_reauthentication_url("moe.sable.next:/login", "moe.sable.next:/login").await;
    assert!(url.contains("EXISTING"), "{url}");
    assert!(!invalidated);
}

#[tokio::test]
async fn oauth_reauthentication_with_a_new_client_moves_to_a_new_device() {
    let (url, invalidated) =
        oauth_reauthentication_url("moe.sable.app:/login", "moe.sable.next:/login").await;
    assert!(!url.contains("EXISTING"), "{url}");
    assert!(invalidated);
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_refused_device_moves_the_next_reauthentication_to_a_new_device() {
    const REDIRECT: &str = "moe.sable.next:/login";
    let (server, core, directory) = oauth_reauthentication_core(REDIRECT).await;
    server
        .oauth()
        .mock_token()
        .respond_with_code_and_json(
            400,
            serde_json::json!({
                "error": "invalid_scope",
                "error_description": "A device with the supplied ID already exists for this user"
            }),
        )
        .mount()
        .await;

    let url = Url::parse(&start_oauth_reauthentication(&core, REDIRECT).await).unwrap();
    assert!(url.as_str().contains("EXISTING"), "{url}");
    let state = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    core.complete_oidc_login(CompleteOidcLoginParams {
        callback_url: format!("{REDIRECT}?state={state}&code=code"),
    })
    .await
    .unwrap_err();
    assert!(device_invalidated(&core).await);
    assert!(core.sign_in.pending_login.lock().await.is_none());

    let url = start_oauth_reauthentication(&core, REDIRECT).await;
    assert!(!url.contains("EXISTING"), "{url}");
    *core.sign_in.pending_login.lock().await = None;
    drop(core);
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn password_reauthentication_reuses_account_device_and_identity() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{body_partial_json, method, path},
    };
    let server = MatrixMockServer::new().await;
    server
        .mock_versions()
        .with_simplified_sliding_sync()
        .ok()
        .mount()
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/login"))
        .and(body_partial_json(serde_json::json!({
            "device_id": "EXISTING", "identifier": {"user": "@alice:example.org"}
        })))
        .respond_with(
            ResponseTemplate::new(403).set_body_json(
                serde_json::json!({"errcode": "M_FORBIDDEN", "error": "bad password"}),
            ),
        )
        .expect(1)
        .mount(server.server())
        .await;
    let directory =
        std::env::temp_dir().join(format!("sable-reauth-{}", ruma::TransactionId::new()));
    let store_id = directory.to_str().unwrap();
    let (core, _events) = Core::new(
        store_id,
        Box::new(crate::store::MemorySessionStore::default()),
    );
    let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "active_account_id": null, "next_account_id": 2,
            "accounts": [{"account_id": "a1", "store_id": store_id, "needs_reauth": true,
                "session": {"homeserver": "example.org", "resolved_homeserver": server.server().uri(),
                    "credentials": {"kind": "password", "user_id": "@alice:example.org", "device_id": "EXISTING", "access_token": "old"}}
            }]
        })).unwrap();
    *core.accounts.lock().await = Some(
        session::AccountRegistry::from_bytes(&bytes, store_id)
            .unwrap()
            .0,
    );
    let persisted = core.accounts().await.unwrap().accounts[0].session.clone();
    let client = session::restore_client(store_id, &persisted, true)
        .await
        .unwrap();
    session::restore_credentials(&client, &persisted)
        .await
        .unwrap();
    let identity = client.encryption().curve25519_key().await.unwrap();
    drop(client);
    core.login(
        "ignored.invalid".to_owned(),
        LoginIdentifier::User {
            user: "different-user".to_owned(),
        },
        "bad".to_owned(),
        Some("a1".to_owned()),
        None,
    )
    .await
    .expect_err("invalid credentials reject reauthentication");
    let accounts = core.accounts().await.unwrap();
    assert_eq!(accounts.accounts.len(), 1);
    assert!(!accounts.accounts[0].state.usable());
    assert_eq!(
        accounts.accounts[0].session.credentials.device_id(),
        "EXISTING"
    );
    let client = session::restore_authenticated_client(store_id, &accounts.accounts[0].session)
        .await
        .unwrap();
    assert_eq!(
        client.encryption().curve25519_key().await.unwrap(),
        identity
    );
    drop(client);
    drop(core);
    std::fs::remove_dir_all(directory).unwrap();
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_login_sends_the_identifier_kind_it_was_given() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{body_partial_json, method, path},
    };
    let server = MatrixMockServer::new().await;
    server
        .mock_versions()
        .with_simplified_sliding_sync()
        .ok()
        .mount()
        .await;
    for identifier in [
        serde_json::json!({"type": "m.id.user", "user": "@alice:example.org"}),
        serde_json::json!({"type": "m.id.thirdparty", "medium": "email", "address": "alice@example.org"}),
    ] {
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v3/login"))
            .and(body_partial_json(
                serde_json::json!({ "identifier": identifier }),
            ))
            .respond_with(ResponseTemplate::new(403).set_body_json(
                serde_json::json!({"errcode": "M_FORBIDDEN", "error": "bad password"}),
            ))
            .expect(1)
            .mount(server.server())
            .await;
    }
    let directory =
        std::env::temp_dir().join(format!("sable-identifier-{}", ruma::TransactionId::new()));
    let store_id = directory.to_str().unwrap();
    let (core, _events) = Core::new(
        store_id,
        Box::new(crate::store::MemorySessionStore::default()),
    );

    for identifier in [
        LoginIdentifier::User {
            user: "@alice:example.org".to_owned(),
        },
        LoginIdentifier::Email {
            address: "alice@example.org".to_owned(),
        },
    ] {
        let error = core
            .login(
                server.server().uri(),
                identifier,
                "pw".to_owned(),
                None,
                None,
            )
            .await
            .expect_err("the mock refuses every login");
        assert!(
            matches!(
                error,
                RpcError {
                    code: RpcCode::Denied,
                    ..
                }
            ),
            "got {error:?}"
        );
    }

    server.server().verify().await;
    drop(core);
    let _ = std::fs::remove_dir_all(directory);
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_login_persists_the_endpoint_it_was_built_at_not_the_advertised_one() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let server = MatrixMockServer::new().await;
    server
        .mock_versions()
        .with_simplified_sliding_sync()
        .ok()
        .mount()
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "user_id": "@alice:example.org", "device_id": "FRESH", "access_token": "token",
            "well_known": {"m.homeserver": {"base_url": "http://advertised.invalid"}}
        })))
        .mount(server.server())
        .await;
    let directory =
        std::env::temp_dir().join(format!("sable-endpoint-{}", ruma::TransactionId::new()));
    let store_id = directory.to_str().unwrap();
    let (core, _events) = Core::new(
        store_id,
        Box::new(crate::store::MemorySessionStore::default()),
    );

    core.login(
        server.server().uri(),
        LoginIdentifier::User {
            user: "alice".to_owned(),
        },
        "pw".to_owned(),
        None,
        None,
    )
    .await
    .unwrap();

    let entered = Url::parse(&server.server().uri()).unwrap();
    let live = core.session.snapshot().as_ref().unwrap().client.clone();
    assert_eq!(live.homeserver().host_str(), Some("advertised.invalid"));
    let persisted = core.accounts().await.unwrap().accounts.remove(0).session;
    assert_eq!(persisted.resolved_homeserver, Some(entered.clone()));
    let restored = session::restore_client(store_id, &persisted, true)
        .await
        .unwrap();
    assert_eq!(restored.homeserver(), entered);
    if let Some(session) = core.end_session().await {
        session.sync_service.stop().await;
    }
    drop((core, restored, live));
    std::fs::remove_dir_all(directory).unwrap();
}

#[tokio::test]
async fn a_login_without_sliding_sync_for_the_user_is_logged_out() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let server = MatrixMockServer::new().await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/versions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "versions": ["v1.15"],
            "unstable_features": {"org.matrix.simplified_msc3575": false},
        })))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path(
            "/_matrix/client/unstable/org.matrix.simplified_msc3575/sync",
        ))
        .respond_with(ResponseTemplate::new(401))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "user_id": "@alice:example.org", "device_id": "FRESH", "access_token": "token",
        })))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/logout"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    let directory =
        std::env::temp_dir().join(format!("sable-no-sss-{}", ruma::TransactionId::new()));
    let (core, _events) = Core::new(
        directory.to_str().unwrap(),
        Box::new(crate::store::MemorySessionStore::default()),
    );

    let outcome = core
        .login(
            server.server().uri(),
            LoginIdentifier::User {
                user: "alice".to_owned(),
            },
            "pw".to_owned(),
            None,
            None,
        )
        .await;

    assert!(matches!(
        outcome,
        Err(RpcError {
            code: RpcCode::SlidingSyncUnsupported,
            ..
        })
    ));
    assert!(core.accounts().await.unwrap().accounts.is_empty());
    drop(core);
    let _ = std::fs::remove_dir_all(directory);
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn discovery_returns_the_homeserver_endpoint() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    let found = session::discovery_client(&server.server().uri())
        .await
        .expect("discovery succeeds")
        .homeserver()
        .to_string();
    assert!(found.contains(&server.server().uri()), "{found}");
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_rejected_reauthentication_logs_the_issued_session_out() {
    use matrix_sdk::ruma::{device_id, user_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let server = MatrixMockServer::new().await;
    let client = server
        .client_builder()
        .logged_in_with_token(
            "fresh".to_owned(),
            user_id!("@bob:example.org").to_owned(),
            device_id!("OTHER").to_owned(),
        )
        .build()
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/logout"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(1)
        .mount(server.server())
        .await;
    let directory = tempfile::tempdir().unwrap();
    let store_id = directory.path().to_str().unwrap();
    let (core, _events) = Core::new(
        store_id,
        Box::new(crate::store::MemorySessionStore::default()),
    );
    let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1, "active_account_id": null, "next_account_id": 2,
            "accounts": [{"account_id": "a1", "store_id": store_id, "needs_reauth": true,
                "session": {"homeserver": "example.org", "resolved_homeserver": server.server().uri(),
                    "credentials": {"kind": "password", "user_id": "@alice:example.org", "device_id": "EXISTING", "access_token": "old"}}
            }]
        })).unwrap();
    *core.accounts.lock().await = Some(
        session::AccountRegistry::from_bytes(&bytes, store_id)
            .unwrap()
            .0,
    );
    let account = core.accounts().await.unwrap().accounts.remove(0);
    let original = session::restore_client(store_id, &account.session, true)
        .await
        .unwrap();
    session::restore_credentials(&original, &account.session)
        .await
        .unwrap();
    drop(original);

    let result = core
        .validate_reauthentication(Some(&account), &client)
        .await;

    assert!(matches!(
        result,
        Err(RpcError {
            code: RpcCode::Denied,
            ..
        })
    ));
    server.server().verify().await;
}

#[test]
fn oauth_callback_must_match_its_redirect_target() -> Result<(), url::ParseError> {
    let expected = Url::parse("https://next.sable.moe/login")?;
    let valid = Url::parse("https://next.sable.moe/login?code=secret&state=csrf")?;
    let error = Url::parse(
        "https://next.sable.moe/login?error=access_denied&error_description=no&state=csrf",
    )?;
    let issuer = Url::parse(
        "https://next.sable.moe/login?code=secret&state=csrf&iss=https%3A%2F%2Fsable.moe%2F",
    )?;
    let fragment = Url::parse("https://next.sable.moe/login#code=secret&state=csrf")?;
    let wrong_path = Url::parse("https://next.sable.moe/other?code=secret&state=csrf")?;
    let wrong_origin = Url::parse("https://attacker.invalid/login?code=secret&state=csrf")?;
    let wrong_port = Url::parse("https://next.sable.moe:8443/login?code=secret&state=csrf")?;

    for accepted in [valid, error, issuer, fragment] {
        assert!(same_redirect_target(&expected, &accepted));
    }
    for invalid in [wrong_path, wrong_origin, wrong_port] {
        assert!(!same_redirect_target(&expected, &invalid));
    }
    Ok(())
}

#[test]
fn browser_redirect_uris_ask_for_a_fragment_response() -> Result<(), url::ParseError> {
    assert_eq!(
        response_mode(&Url::parse("https://next.sable.moe/login")?),
        "fragment"
    );
    assert_eq!(
        response_mode(&Url::parse("moe.sable.next:/login")?),
        "query"
    );
    assert_eq!(
        response_mode(&Url::parse("http://127.0.0.1:41000/callback")?),
        "query"
    );
    Ok(())
}

#[test]
fn a_fragment_carries_the_authorization_response() -> Result<(), url::ParseError> {
    let fragment = Url::parse("https://next.sable.moe/login#code=secret&state=csrf")?;
    let query = Url::parse("moe.sable.next:/login?code=secret&state=csrf")?;

    assert_eq!(
        authorization_response(&fragment).query(),
        Some("code=secret&state=csrf")
    );
    assert_eq!(
        authorization_response(&query).query(),
        Some("code=secret&state=csrf")
    );
    Ok(())
}

#[test]
fn sso_callback_must_preserve_our_state() -> Result<(), url::ParseError> {
    let expected = Url::parse("moe.sable.next://login?sable_sso_state=expected")?;
    let valid = Url::parse("moe.sable.next://login?sable_sso_state=expected&loginToken=secret")?;
    let wrong_state =
        Url::parse("moe.sable.next://login?sable_sso_state=attacker&loginToken=secret")?;

    assert!(same_redirect_target(&expected, &valid));
    assert!(!same_redirect_target(&expected, &wrong_state));
    assert!(has_single_nonempty_query_parameter(
        &expected,
        "sable_sso_state"
    ));
    assert!(has_single_nonempty_query_parameter(&valid, "loginToken"));
    assert!(!has_single_nonempty_query_parameter(
        &Url::parse("moe.sable.next://login")?,
        "sable_sso_state"
    ));
    assert!(!has_single_nonempty_query_parameter(
        &Url::parse("moe.sable.next://login?sable_sso_state=")?,
        "sable_sso_state"
    ));
    assert!(!has_single_nonempty_query_parameter(
        &Url::parse("moe.sable.next://login?loginToken=one&loginToken=two")?,
        "loginToken"
    ));
    Ok(())
}
