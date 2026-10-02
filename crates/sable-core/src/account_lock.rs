use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::{
    Client, SessionChange,
    config::RequestConfig,
    ruma::api::{
        client::account::whoami,
        error::{ErrorKind, RetryAfter, UnknownTokenErrorData},
    },
};

use crate::{Core, protocol::CoreEvent};

impl Core {
    pub(crate) fn lock_account(self: &Arc<Self>, generation: u64) {
        if self.session_generation.load(Ordering::SeqCst) != generation
            || self.account_locked.swap(true, Ordering::SeqCst)
        {
            return;
        }
        let core = self.clone();
        self.track_session_task(
            spawn(async move {
                let (client, sync, account_id) = {
                    let session = core.session.read().await;
                    let Some(session) = session.as_ref() else {
                        return;
                    };
                    (
                        session.client.clone(),
                        session.sync_service.clone(),
                        session.account_id.clone(),
                    )
                };
                if core.session_generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                client.send_queue().set_enabled(false).await;
                core.emit_if_current(
                    generation,
                    CoreEvent::AccountLockChanged {
                        account_id: account_id.clone(),
                        locked: true,
                    },
                );
                sync.stop().await;
                let mut delay = Duration::from_secs(30);
                loop {
                    matrix_sdk::sleep::sleep(delay).await;
                    if core.session_generation.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    let outcome = probe(&client).await;
                    if matches!(outcome, Ok(false)) {
                        let mut data = UnknownTokenErrorData::new();
                        data.soft_logout = true;
                        core.handle_session_change(&SessionChange::UnknownToken(data), generation);
                        return;
                    }
                    if matches!(outcome, Ok(true)) {
                        let _activation = core.session_activation_lock.lock().await;
                        let _swap = core.session_swap_lock.lock().await;
                        if core.session_generation.load(Ordering::SeqCst) != generation {
                            return;
                        }
                        core.account_locked.store(false, Ordering::SeqCst);
                        client.send_queue().set_enabled(true).await;
                        sync.start().await;
                        core.emit_if_current(
                            generation,
                            CoreEvent::AccountLockChanged {
                                account_id,
                                locked: false,
                            },
                        );
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
}

impl Core {
    pub(crate) async fn detect_account_lock(
        self: &Arc<Self>,
        client: &Client,
        generation: u64,
    ) -> bool {
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
        let (core, mut events) = crate::Core::new(
            "lock",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        *core.accounts.lock().await = Some(crate::session::AccountRegistry::empty());
        let persisted = crate::session::current_session(&client, server.server().uri()).unwrap();
        core.persist("a1", "lock-account-a1", &persisted, None)
            .await
            .unwrap();
        let stored = core.sessions.load().await.unwrap();
        let identity = client.encryption().ed25519_key().await;
        *core.session.write().await = Some(crate::session::Session {
            account_id: "a1".to_owned(),
            homeserver: server.server().uri(),
            oauth: false,
            sync_service: std::sync::Arc::new(
                matrix_sdk_ui::sync_service::SyncService::builder(client.clone())
                    .build()
                    .await
                    .unwrap(),
            ),
            client: client.clone(),
        });
        core.session_generation
            .store(1, std::sync::atomic::Ordering::SeqCst);
        assert!(core.detect_account_lock(&client, 1).await);
        assert_eq!(client.session_tokens().unwrap(), tokens);
        assert!(
            core.account_locked
                .load(std::sync::atomic::Ordering::SeqCst)
        );
        assert!(matches!(
            events.recv().await,
            Some(crate::protocol::CoreEvent::AccountLockChanged { locked: true, .. })
        ));
        changes.try_recv().unwrap_err();
        assert!(core.detect_account_lock(&client, 1).await);
        events.try_recv().unwrap_err();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while client.send_queue().is_enabled() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(core.session.read().await.is_some());
        assert_eq!(core.sessions.load().await.unwrap(), stored);
        assert_eq!(client.encryption().ed25519_key().await, identity);
        assert!(!core.accounts().await.unwrap().accounts[0].needs_reauth);
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
