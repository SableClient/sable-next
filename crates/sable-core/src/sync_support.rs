use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::{Client, config::RequestConfig};
#[cfg(any(target_family = "wasm", test))]
use matrix_sdk_ui::sync_service::State;
use matrix_sdk_ui::sync_service::SyncService;

use crate::{Core, ResultExt, RpcError, protocol::RpcCode};

#[cfg(target_family = "wasm")]
pub(crate) const SYNC_STALL: Duration = Duration::from_secs(90);

impl Core {
    /// The wasm HTTP client ignores request timeouts, so a long-poll on a connection that died
    /// during sleep never returns.
    #[cfg(any(target_family = "wasm", test))]
    pub(crate) fn watch_sync_stall(
        self: &Arc<Self>,
        client: &Client,
        sync_service: &Arc<SyncService>,
        stall: Duration,
    ) {
        let core = self.clone();
        let client = client.clone();
        let sync_service = sync_service.clone();

        self.track_session_task(
            spawn(async move {
                loop {
                    if matrix_sdk::timeout::timeout(client.wait_for_sync(), stall)
                        .await
                        .is_ok()
                    {
                        continue;
                    }
                    let transition = core.activity.transition().await;
                    if matches!(sync_service.state().get(), State::Running)
                        && transition.sync_allowed()
                    {
                        tracing::warn!("no sync response for {stall:?}, restarting sync");
                        sync_service.stop().await;
                        sync_service.start().await;
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) fn watch_ignored_history(
        self: &Arc<Self>,
        client: &Client,
        sync_service: &Arc<SyncService>,
    ) {
        let core = self.clone();
        let client = client.clone();
        let sync_service = sync_service.clone();
        let mut changes = client.subscribe_to_ignore_user_list_changes();

        self.track_session_task(
            spawn(async move {
                while changes.next().await.is_some() {
                    let transition = core.activity.transition().await;
                    if let Some(event_cache) = client.event_cache()
                        && let Err(error) = event_cache.clear_all_rooms().await
                    {
                        tracing::warn!(%error, "clearing the event cache after an ignore change");
                    }
                    sync_service.expire_sessions().await;
                    transition.start_sync(&sync_service).await;
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn server_features(&self) -> Result<Vec<String>, RpcError> {
        let features = self
            .client()
            .await?
            .unstable_features()
            .await
            .or_failed(self, "server_features")?;
        Ok(features
            .iter()
            .map(|feature| feature.as_str().to_owned())
            .collect())
    }

    pub(crate) async fn require_sliding_sync(&self, client: &Client) -> Result<(), RpcError> {
        let versions = client
            .fetch_server_versions(Some(
                RequestConfig::new()
                    .timeout(std::time::Duration::from_secs(15))
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

/// Synapse only advertises per-user Sliding Sync on an authenticated `/versions`.
async fn sliding_sync_endpoint_exists(client: &Client) -> bool {
    let Ok(url) = client
        .homeserver()
        .join("_matrix/client/unstable/org.matrix.simplified_msc3575/sync")
    else {
        return false;
    };
    let request = client.http_client().post(url).body("{}").send();
    match matrix_sdk::timeout::timeout(request, Duration::from_secs(15)).await {
        Ok(Ok(response)) => !matches!(
            response.status(),
            http::StatusCode::NOT_FOUND | http::StatusCode::METHOD_NOT_ALLOWED
        ),
        Ok(Err(_)) | Err(_) => true,
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
