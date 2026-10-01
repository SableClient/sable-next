use matrix_sdk::{Client, config::RequestConfig};

use crate::{Core, protocol::CommandErr};

impl Core {
    pub(crate) async fn require_sliding_sync(&self, client: &Client) -> Result<(), CommandErr> {
        let versions = client
            .fetch_server_versions(Some(
                RequestConfig::new()
                    .timeout(std::time::Duration::from_secs(15))
                    .disable_retry(),
            ))
            .await
            .map_err(|error| self.homeserver_http_error("sliding_sync_support", error))?;
        if versions
            .unstable_features
            .get("org.matrix.simplified_msc3575")
            == Some(&true)
        {
            Ok(())
        } else {
            Err(CommandErr::SlidingSyncUnsupported)
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
                    Err(crate::protocol::CommandErr::SlidingSyncUnsupported)
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
            Err(crate::protocol::CommandErr::Unavailable)
        ));
    }
}
