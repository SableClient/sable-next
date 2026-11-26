use std::sync::Arc;
use std::time::Duration;

use crate::tasks::JoinHandleExt;
use futures_util::future::{Either, select};
use matrix_sdk::executor::spawn;
use matrix_sdk::{Client, config::RequestConfig};
use matrix_sdk_ui::sync_service::{State, SyncService};

use crate::SignedIn;
use crate::{Core, ResultExt, RpcError, protocol::RpcCode};

pub(crate) const SYNC_STALL: Duration = Duration::from_secs(90);
/// The SDK waits for its sync tasks without a limit, and a lifecycle job must not.
const SYNC_STOP_WAIT: Duration = Duration::from_secs(10);

pub(crate) async fn stop(sync_service: &SyncService) -> bool {
    let stopped = matrix_sdk::timeout::timeout(Box::pin(sync_service.stop()), SYNC_STOP_WAIT)
        .await
        .is_ok();
    if !stopped {
        tracing::warn!(reported = true, "the sync did not stop in time");
    }
    stopped
}

impl SignedIn {
    /// The wasm HTTP client ignores request timeouts, so a long-poll on a connection that died
    /// during sleep never returns. Elsewhere it catches a sync waiting for a network the OS never
    /// reported back.
    pub(crate) fn watch_sync_stall(&self, sync_service: &Arc<SyncService>, stall: Duration) {
        let client = self.client();
        let session = self.clone();
        let client = client.clone();
        let sync_service = sync_service.clone();

        self.track_session_task(
            spawn(async move {
                let mut states = sync_service.state();
                loop {
                    // Nothing to catch while paused. A resume the OS-reported outage refused changes
                    // no state, and it is the one the probe below is for.
                    session.core().wait_until_sync_resumes().await;
                    // A state change restarts the wait, so a sync that just started is not
                    // charged for the time it was stopped.
                    let beat = std::pin::pin!(client.wait_for_sync());
                    let changed = std::pin::pin!(states.next());
                    match matrix_sdk::timeout::timeout(select(beat, changed), stall).await {
                        Ok(Either::Right((None, _))) => break,
                        Ok(_) => continue,
                        Err(_) => {}
                    }
                    if !session.core().activity.network_available()
                        && !session.core().sync_paused()
                        && crate::watchers::server_reachable(&client).await
                    {
                        tracing::warn!("the server answers on a network reported gone");
                        session.core().retry_sync(&sync_service).await;
                        continue;
                    }
                    let stalled = sync_service.clone();
                    if session
                        .core()
                        .supervise("restart stalled sync", move |core, _| {
                            Box::pin(async move {
                                if core.is_current_sync(&stalled)
                                    && matches!(stalled.state().get(), State::Running)
                                    && core.sync_allowed()
                                {
                                    tracing::warn!(
                                        "no sync response for {stall:?}, restarting sync"
                                    );
                                    if stop(&stalled).await {
                                        stalled.start().await;
                                    }
                                }
                            })
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) fn watch_ignored_history(&self, sync_service: &Arc<SyncService>) {
        let client = self.client();
        let core = self.clone();
        let client = client.clone();
        let sync_service = sync_service.clone();
        let mut changes = client.subscribe_to_ignore_user_list_changes();

        self.track_session_task(
            spawn(async move {
                while changes.next().await.is_some() {
                    let (client, sync_service) = (client.clone(), sync_service.clone());
                    if core
                        .core()
                        .supervise("reload after an ignore change", move |core, supervised| {
                            Box::pin(async move {
                                if !core.is_current_sync(&sync_service) {
                                    return;
                                }
                                if let Some(event_cache) = client.event_cache()
                                    && let Err(error) = event_cache.clear_all_rooms().await
                                {
                                    tracing::warn!(
                                        %error,
                                        "clearing the event cache after an ignore change"
                                    );
                                }
                                sync_service.expire_sessions().await;
                                core.activity.start_sync(&supervised, &sync_service).await;
                            })
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn server_features(&self) -> Result<Vec<String>, RpcError> {
        let features = self
            .client()
            .unstable_features()
            .await
            .or_failed(self.core(), "server_features")?;
        Ok(features
            .iter()
            .map(|feature| feature.as_str().to_owned())
            .collect())
    }
}

/// Synapse only advertises per-user Sliding Sync on an authenticated `/versions`.
async fn sliding_sync_endpoint_exists(client: &Client) -> bool {
    let Ok(url) = client
        .homeserver()
        .join("_matrix/client/unstable/org.matrix.simplified_msc3575/sync")
    else {
        return false;
    };
    let request = client.http_client().raw().post(url).body("{}").send();
    match matrix_sdk::timeout::timeout(request, Duration::from_secs(15)).await {
        Ok(Ok(response)) => !matches!(
            response.status(),
            http::StatusCode::NOT_FOUND | http::StatusCode::METHOD_NOT_ALLOWED
        ),
        Ok(Err(_)) | Err(_) => true,
    }
}

impl Core {
    pub(crate) async fn require_sliding_sync(&self, client: &Client) -> Result<(), RpcError> {
        let versions = client
            .fetch_server_versions(Some(
                RequestConfig::new()
                    .timeout(Duration::from_secs(15))
                    .disable_retry(),
            ))
            .await
            .or_failed(self, "sliding_sync_support")?;
        if versions
            .unstable_features
            .get("org.matrix.simplified_msc3575")
            == Some(&true)
            || (client.access_token().is_none() && sliding_sync_endpoint_exists(client).await)
        {
            Ok(())
        } else {
            Err(RpcCode::SlidingSyncUnsupported.into())
        }
    }
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
    async fn support_checks_distinguish_unsupported_servers_from_failures() {
        for supported in [None, Some(false), Some(true)] {
            let server = MatrixMockServer::new().await;
            let client = server.client_builder().no_server_versions().build().await;
            let features = supported.map_or_else(
                || json!({}),
                |value| json!({"org.matrix.simplified_msc3575": value}),
            );
            Mock::given(method("GET"))
                .and(path("/_matrix/client/versions"))
                .respond_with(
                    ResponseTemplate::new(200).set_body_json(
                        json!({"versions": ["v1.19"], "unstable_features": features}),
                    ),
                )
                .mount(server.server())
                .await;
            let (core, _events) = crate::Core::new(
                "sync-support",
                Box::new(crate::store::MemorySessionStore::default()),
            );
            let outcome = core.require_sliding_sync(&client).await;
            assert_eq!(outcome.is_ok(), supported == Some(true));
            if supported != Some(true) {
                assert!(matches!(
                    outcome,
                    Err(crate::protocol::RpcError {
                        code: crate::protocol::RpcCode::SlidingSyncUnsupported,
                        ..
                    })
                ));
            }
        }
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().no_server_versions().build().await;
        Mock::given(method("GET"))
            .and(path("/_matrix/client/versions"))
            .respond_with(
                ResponseTemplate::new(503)
                    .set_body_json(json!({"errcode": "M_UNKNOWN", "error": "unavailable"})),
            )
            .mount(server.server())
            .await;
        let (core, _events) = crate::Core::new(
            "sync-support",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        assert!(matches!(
            core.require_sliding_sync(&client).await,
            Err(crate::protocol::RpcError {
                code: crate::protocol::RpcCode::Unavailable,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn before_login_an_existing_endpoint_defers_the_unadvertised_check() {
        for (endpoint_status, supported) in [(401, true), (404, false)] {
            let server = MatrixMockServer::new().await;
            let client = server
                .client_builder()
                .unlogged()
                .no_server_versions()
                .build()
                .await;
            Mock::given(method("GET"))
                .and(path("/_matrix/client/versions"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "versions": ["v1.15"],
                    "unstable_features": {"org.matrix.simplified_msc3575": false},
                })))
                .mount(server.server())
                .await;
            Mock::given(method("POST"))
                .and(path(
                    "/_matrix/client/unstable/org.matrix.simplified_msc3575/sync",
                ))
                .respond_with(ResponseTemplate::new(endpoint_status))
                .mount(server.server())
                .await;
            let (core, _events) = crate::Core::new(
                "sync-support",
                Box::new(crate::store::MemorySessionStore::default()),
            );
            assert_eq!(
                core.require_sliding_sync(&client).await.is_ok(),
                supported,
                "endpoint status {endpoint_status}"
            );
        }
    }
}
