use super::*;

#[test]
fn email_identity_auth_carries_the_threepid_and_session() {
    let sid = SessionId::parse("sid-1").unwrap();
    let secret = ClientSecret::parse("secret-1").unwrap();
    let auth = email_identity_auth(&sid, &secret, Some("session-1"));
    let value = serde_json::to_value(auth).unwrap();
    assert_eq!(value["type"], "m.login.email.identity");
    assert_eq!(value["threepid_creds"]["sid"], "sid-1");
    assert_eq!(value["threepid_creds"]["client_secret"], "secret-1");
    assert_eq!(value["session"], "session-1");
}

#[cfg(not(target_family = "wasm"))]
fn test_core(prefix: &str) -> (Arc<Core>, std::path::PathBuf) {
    let directory = std::env::temp_dir().join(format!("{prefix}-{}", ruma::TransactionId::new()));
    let (core, _events) = Core::new(
        directory.to_str().unwrap(),
        Box::new(crate::store::MemorySessionStore::default()),
    );
    (core, directory)
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_reset_retries_with_the_validated_email_after_the_uiaa_challenge() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{body_partial_json, method, path},
    };
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    Mock::given(method("POST"))
        .and(path(
            "/_matrix/client/v3/account/password/email/requestToken",
        ))
        .and(body_partial_json(serde_json::json!({
            "email": "alice@example.org", "send_attempt": 1
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"sid": "sid-1"})))
        .expect(1)
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/account/password"))
        .and(body_partial_json(serde_json::json!({
            "auth": {
                "type": "m.login.email.identity",
                "session": "uia-1",
                "threepid_creds": {"sid": "sid-1"}
            }
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .expect(1)
        .with_priority(1)
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/account/password"))
        .and(body_partial_json(serde_json::json!({
            "new_password": "correct horse", "logout_devices": false
        })))
        .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
            "flows": [{"stages": ["m.login.email.identity"]}],
            "params": {},
            "session": "uia-1"
        })))
        .expect(1)
        .with_priority(2)
        .mount(server.server())
        .await;
    let (core, directory) = test_core("sable-reset");

    let RequestPasswordResetEmailOk { client_secret, sid } = core
        .request_password_reset_email(RequestPasswordResetEmailParams {
            homeserver: server.server().uri(),
            email: " alice@example.org ".to_owned(),
            client_secret: None,
            send_attempt: 1,
        })
        .await
        .unwrap();
    assert_eq!(sid, "sid-1");
    let result = core
        .reset_password(ResetPasswordParams {
            homeserver: server.server().uri(),
            client_secret,
            sid,
            new_password: "correct horse".to_owned(),
            logout_devices: false,
        })
        .await;

    assert!(matches!(result, Ok(())));
    drop(core);
    drop(server);
    let _ = std::fs::remove_dir_all(directory);
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn an_unvalidated_email_asks_the_user_to_open_the_link() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/account/password"))
        .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
            "flows": [{"stages": ["m.login.email.identity"]}],
            "session": "uia-1",
            "errcode": "M_UNAUTHORIZED",
            "error": "Unable to get validated threepid"
        })))
        .expect(2)
        .mount(server.server())
        .await;
    let (core, directory) = test_core("sable-reset-unvalidated");

    let result = core
        .reset_password(ResetPasswordParams {
            homeserver: server.server().uri(),
            client_secret: "secret-1".to_owned(),
            sid: "sid-1".to_owned(),
            new_password: "correct horse".to_owned(),
            logout_devices: true,
        })
        .await;

    assert!(matches!(
        result,
        Err(RpcError {
            code: RpcCode::EmailVerificationFailed,
            ..
        })
    ));
    drop(core);
    drop(server);
    let _ = std::fs::remove_dir_all(directory);
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn an_email_the_server_cannot_reset_is_reported_as_such() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    Mock::given(method("POST"))
        .and(path(
            "/_matrix/client/v3/account/password/email/requestToken",
        ))
        .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "errcode": "M_THREEPID_NOT_FOUND", "error": "Email not found"
        })))
        .mount(server.server())
        .await;
    let (core, directory) = test_core("sable-reset-unknown");

    let unknown = core
        .request_password_reset_email(RequestPasswordResetEmailParams {
            homeserver: server.server().uri(),
            email: "bob@example.org".to_owned(),
            client_secret: None,
            send_attempt: 1,
        })
        .await;
    let invalid = core
        .request_password_reset_email(RequestPasswordResetEmailParams {
            homeserver: server.server().uri(),
            email: "bob".to_owned(),
            client_secret: None,
            send_attempt: 1,
        })
        .await;

    assert!(matches!(
        unknown,
        Err(RpcError {
            code: RpcCode::UnknownEmail,
            ..
        })
    ));
    assert!(matches!(
        invalid,
        Err(RpcError {
            code: RpcCode::InvalidEmail,
            ..
        })
    ));
    drop(core);
    drop(server);
    let _ = std::fs::remove_dir_all(directory);
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_server_without_email_reset_is_unsupported() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    Mock::given(method("POST"))
        .and(path(
            "/_matrix/client/v3/account/password/email/requestToken",
        ))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "errcode": "M_UNRECOGNIZED", "error": "Unrecognized request"
        })))
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/account/password"))
        .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "errcode": "M_WEAK_PASSWORD", "error": "too weak"
        })))
        .mount(server.server())
        .await;
    let (core, directory) = test_core("sable-reset-unsupported");

    let unsupported = core
        .request_password_reset_email(RequestPasswordResetEmailParams {
            homeserver: server.server().uri(),
            email: "bob@example.org".to_owned(),
            client_secret: None,
            send_attempt: 1,
        })
        .await;
    let weak = core
        .reset_password(ResetPasswordParams {
            homeserver: server.server().uri(),
            client_secret: "secret-1".to_owned(),
            sid: "sid-1".to_owned(),
            new_password: "a".to_owned(),
            logout_devices: true,
        })
        .await;

    assert!(matches!(
        unsupported,
        Err(RpcError {
            code: RpcCode::Unsupported,
            ..
        })
    ));
    assert!(matches!(
        weak,
        Err(RpcError {
            code: RpcCode::WeakPassword,
            ..
        })
    ));
    drop(core);
    drop(server);
    let _ = std::fs::remove_dir_all(directory);
}

#[cfg(not(target_family = "wasm"))]
async fn change_password_core(
    challenge_flows: serde_json::Value,
    retry: wiremock::ResponseTemplate,
) -> (
    matrix_sdk::test_utils::mocks::MatrixMockServer,
    Arc<Core>,
    wiremock::Mock,
) {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{body_partial_json, method, path},
    };
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/account/password"))
        .and(body_partial_json(serde_json::json!({
            "auth": {
                "type": "m.login.password",
                "session": "uia-1",
                "password": "old secret",
                "identifier": {"type": "m.id.user", "user": "@example:localhost"}
            }
        })))
        .respond_with(retry)
        .expect(1)
        .with_priority(1)
        .mount(server.server())
        .await;
    let challenge = Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/account/password"))
        .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
            "flows": challenge_flows,
            "params": {},
            "session": "uia-1"
        })))
        .expect(1)
        .with_priority(2);
    let (core, _events) = crate::test_support::signed_in_core(&server, client).await;
    (server, core, challenge)
}

#[cfg(not(target_family = "wasm"))]
fn change_params() -> ChangePasswordParams {
    ChangePasswordParams {
        current_password: "old secret".to_owned(),
        new_password: "new secret".to_owned(),
        logout_devices: false,
    }
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_password_change_retries_with_the_current_password_and_the_session() {
    let (server, core, challenge) = change_password_core(
        serde_json::json!([{"stages": ["m.login.password"]}]),
        wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({})),
    )
    .await;
    let session = core.signed_in().unwrap();
    challenge.mount(server.server()).await;

    assert!(matches!(
        session.change_password(change_params()).await,
        Ok(())
    ));
    let requests = server.server().received_requests().await.unwrap();
    let first: serde_json::Value = requests
        .iter()
        .find(|request| request.url.path() == "/_matrix/client/v3/account/password")
        .map(|request| serde_json::from_slice(&request.body).unwrap())
        .unwrap();
    assert_eq!(first["new_password"], "new secret");
    assert_eq!(first["logout_devices"], false);
    assert!(first.get("auth").is_none());
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_wrong_current_password_is_denied() {
    for retry in [
        wiremock::ResponseTemplate::new(401).set_body_json(serde_json::json!({
            "flows": [{"stages": ["m.login.password"]}],
            "params": {},
            "session": "uia-1",
            "errcode": "M_FORBIDDEN",
            "error": "Invalid password"
        })),
        wiremock::ResponseTemplate::new(403).set_body_json(serde_json::json!({
            "errcode": "M_FORBIDDEN",
            "error": "Invalid password"
        })),
    ] {
        let (server, core, challenge) =
            change_password_core(serde_json::json!([{"stages": ["m.login.password"]}]), retry)
                .await;
        let session = core.signed_in().unwrap();
        challenge.mount(server.server()).await;

        let error = session.change_password(change_params()).await.unwrap_err();
        assert!(matches!(error.code, RpcCode::Denied));
    }
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_weak_new_password_is_reported_as_weak() {
    let (server, core, challenge) = change_password_core(
        serde_json::json!([{"stages": ["m.login.password"]}]),
        wiremock::ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "errcode": "M_WEAK_PASSWORD",
            "error": "Password too short"
        })),
    )
    .await;
    let session = core.signed_in().unwrap();
    challenge.mount(server.server()).await;

    let error = session.change_password(change_params()).await.unwrap_err();
    assert!(matches!(error.code, RpcCode::WeakPassword));
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn a_server_that_forbids_changing_the_password_is_unsupported() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/account/password"))
        .respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
            "errcode": "M_FORBIDDEN",
            "error": "Password changes are disabled"
        })))
        .expect(1)
        .mount(server.server())
        .await;
    let (core, _events) = crate::test_support::signed_in_core(&server, client).await;
    let session = core.signed_in().unwrap();

    let error = session.change_password(change_params()).await.unwrap_err();
    assert!(matches!(error.code, RpcCode::Unsupported));
}

#[cfg(not(target_family = "wasm"))]
#[tokio::test]
async fn the_change_password_capability_decides_whether_the_form_shows() {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };
    for enabled in [true, false] {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("GET"))
            .and(path("/_matrix/client/v3/capabilities"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "capabilities": {"m.change_password": {"enabled": enabled}}
            })))
            .expect(1)
            .mount(server.server())
            .await;
        let (core, _events) = crate::test_support::signed_in_core(&server, client).await;
        let session = core.signed_in().unwrap();

        assert_eq!(session.password_change_enabled().await.unwrap(), enabled);
    }
}
