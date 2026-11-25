use std::time::Duration;

use crate::tasks::JoinHandleExt;
use matrix_sdk::executor::spawn;
use matrix_sdk::{
    Client, SessionChange,
    config::RequestConfig,
    ruma::api::{
        client::account::whoami,
        error::{ErrorKind, RetryAfter, UnknownTokenErrorData},
    },
};

use crate::{SignedIn, protocol::CoreEvent};

impl SignedIn {
    pub(crate) fn lock_account(&self, generation: u64) {
        if !self.core().is_current(generation) || self.core().activity.lock_account(generation) {
            return;
        }
        let session = self.clone();
        self.track_session_task(
            spawn(async move {
                let client = session.client().clone();
                let sync = session.sync_service();
                let account_id = session.session().account_id.clone();
                if !session.core().is_current(generation) {
                    return;
                }
                client.send_queue().set_enabled(false).await;
                session.core().emit_if_current(
                    generation,
                    CoreEvent::AccountLockChanged {
                        account_id: account_id.clone(),
                        locked: true,
                    },
                );
                if session
                    .core()
                    .supervise("pause locked account", {
                        let sync = sync.clone();
                        move |core, _| {
                            Box::pin(async move {
                                if core.is_current(generation) {
                                    crate::sync_support::stop(&sync).await;
                                }
                            })
                        }
                    })
                    .await
                    .is_err()
                {
                    return;
                }
                let mut delay = Duration::from_secs(30);
                loop {
                    matrix_sdk::sleep::sleep(delay).await;
                    if !session.core().is_current(generation) {
                        return;
                    }
                    let outcome = probe(&client).await;
                    if matches!(outcome, Ok(false)) {
                        let mut data = UnknownTokenErrorData::new();
                        data.soft_logout = true;
                        session
                            .core()
                            .handle_session_change(&SessionChange::UnknownToken(data), generation);
                        return;
                    }
                    if matches!(outcome, Ok(true)) {
                        let _ = session
                            .core()
                            .supervise("resume unlocked account", move |core, supervised| {
                                Box::pin(async move {
                                    if !core.is_current(generation) {
                                        return;
                                    }
                                    core.activity.unlock_account();
                                    client.send_queue().set_enabled(true).await;
                                    core.activity.start_sync(&supervised, &sync).await;
                                    core.emit_if_current(
                                        generation,
                                        CoreEvent::AccountLockChanged {
                                            account_id,
                                            locked: false,
                                        },
                                    );
                                })
                            })
                            .await;
                        return;
                    }
                    delay = (delay * 2).min(Duration::from_secs(300));
                    if let Err(error) = outcome
                        && let Some(ErrorKind::LimitExceeded(limit)) = error.client_api_error_kind()
                        && let Some(RetryAfter::Delay(retry)) = limit.retry_after.as_ref()
                    {
                        delay = delay.max(*retry);
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn detect_account_lock(&self, generation: u64) -> bool {
        let client = self.client();
        let locked = probe(client)
            .await
            .is_err_and(|error| error.client_api_error_kind() == Some(&ErrorKind::UserLocked));
        if locked {
            self.lock_account(generation);
        }
        locked
    }
}

async fn probe(client: &Client) -> Result<bool, matrix_sdk::HttpError> {
    let response = client
        .send(whoami::v3::Request::new())
        .with_request_config(
            RequestConfig::new()
                .timeout(Duration::from_secs(15))
                .disable_retry(),
        )
        .await?;
    Ok(client.user_id() == Some(&response.user_id))
}

#[cfg(test)]
mod tests {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use serde_json::json;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };

    #[tokio::test]
    async fn lock_errors_preserve_tokens_and_are_distinct_from_expiry() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let tokens = client.session_tokens().unwrap();
        let mut changes = client.subscribe_to_session_changes();
        Mock::given(method("GET"))
            .and(path("/_matrix/client/v3/account/whoami"))
            .respond_with(ResponseTemplate::new(401).set_body_json(
                json!({"errcode": "M_USER_LOCKED", "error": "locked", "soft_logout": true}),
            ))
            .mount(server.server())
            .await;
        let base = tempfile::tempdir().unwrap();
        let (core, mut events) = crate::Core::new(
            base.path().to_str().unwrap(),
            Box::new(crate::store::MemorySessionStore::default()),
        );
        *core.accounts.lock().await = Some(crate::session::AccountRegistry::empty());
        let persisted = crate::session::current_session(&client, server.server().uri()).unwrap();
        core.persist("a1", "lock-account-a1", &persisted, None)
            .await
            .unwrap();
        let stored = core.sessions.load().await.unwrap();
        let identity = client.encryption().ed25519_key().await;
        crate::test_support::set_session(
            &core,
            Some(crate::session::Session {
                account_id: "a1".to_owned(),
                homeserver: server.server().uri(),
                oauth: false,
                state: std::sync::Arc::default(),
                sync_service: std::sync::Arc::new(
                    matrix_sdk_ui::sync_service::SyncService::builder(client.clone())
                        .build()
                        .await
                        .unwrap(),
                ),
                client: client.clone(),
            }),
        );
        let session = core.signed_in().unwrap();
        core.lifecycle.set_current(1);
        assert!(session.detect_account_lock(1).await);
        assert_eq!(client.session_tokens().unwrap(), tokens);
        assert!(core.activity.account_locked());
        assert!(matches!(
            events.recv().await,
            Some(crate::protocol::CoreEvent::AccountLockChanged { locked: true, .. })
        ));
        changes.try_recv().unwrap_err();
        assert!(session.detect_account_lock(1).await);
        events.try_recv().unwrap_err();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while client.send_queue().is_enabled() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(core.session.snapshot().is_some());
        assert_eq!(core.sessions.load().await.unwrap(), stored);
        assert_eq!(client.encryption().ed25519_key().await, identity);
        assert!(core.accounts().await.unwrap().accounts[0].state.usable());
    }

    #[tokio::test]
    async fn unlock_probes_require_the_same_account() {
        for user_id in ["@alice:example.org", "@other:example.org"] {
            let server = MatrixMockServer::new().await;
            let client = server.client_builder().build().await;
            Mock::given(method("GET"))
                .and(path("/_matrix/client/v3/account/whoami"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({"user_id": user_id})))
                .mount(server.server())
                .await;
            assert_eq!(
                super::probe(&client).await.unwrap(),
                client.user_id().unwrap().as_str() == user_id
            );
        }
    }
}
