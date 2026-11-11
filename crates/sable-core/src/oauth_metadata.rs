use std::sync::Arc;

use matrix_sdk::authentication::oauth::error::OAuthDiscoveryError;
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::AuthorizationServerMetadata;

use crate::Core;
use crate::protocol::{CoreEvent, OAuthMetadataView, RpcError};

pub(crate) fn view(metadata: &AuthorizationServerMetadata) -> OAuthMetadataView {
    OAuthMetadataView {
        account_management_uri: metadata
            .account_management_uri
            .as_ref()
            .map(ToString::to_string),
        account_management_actions_supported: metadata
            .account_management_actions_supported
            .iter()
            .map(|action| action.as_str().to_owned())
            .collect(),
    }
}

impl Core {
    /// The client only caches a successful answer, so a homeserver without OAuth is
    /// asked again on every call.
    pub(crate) async fn oauth_metadata(
        &self,
        client: &matrix_sdk::Client,
        operation: &'static str,
    ) -> Result<Option<AuthorizationServerMetadata>, RpcError> {
        match client.oauth().cached_server_metadata().await {
            Ok(metadata) => Ok(Some(metadata)),
            Err(OAuthDiscoveryError::NotSupported) if client.oauth().full_session().is_none() => {
                Ok(None)
            }
            Err(error) => Err(self.failed_with(operation, &error)),
        }
    }

    pub(crate) fn watch_oauth_metadata(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        generation: u64,
    ) {
        let core = self.clone();
        let client = client.clone();
        self.track_session_task(
            spawn(async move {
                let mut failures = 0u32;
                let metadata = loop {
                    match client.oauth().server_metadata().await {
                        Ok(metadata) => break Some(view(&metadata)),
                        Err(OAuthDiscoveryError::NotSupported) => break None,
                        Err(OAuthDiscoveryError::Http(error))
                            if crate::media::is_transient_http(&error) =>
                        {
                            tracing::debug!("OAuth metadata unavailable, retrying: {error}");
                            failures = failures.saturating_add(1);
                            crate::watchers::retry_backoff(failures).await;
                        }
                        Err(error) => {
                            tracing::warn!("OAuth metadata is unusable: {error}");
                            return;
                        }
                    }
                };
                core.emit_if_current(generation, CoreEvent::OAuthMetadata { metadata });
            })
            .abort_on_drop(),
        );
    }
}

#[cfg(test)]
mod tests {

    use matrix_sdk::test_utils::mocks::MatrixMockServer;

    use crate::api::Handler;
    use crate::api::session::OauthMetadataParams;
    use crate::protocol::{CoreEvent, OAuthMetadataView};
    use crate::test_support::signed_in_core;

    async fn pushed(
        server: &MatrixMockServer,
    ) -> (std::sync::Arc<crate::Core>, Option<OAuthMetadataView>) {
        server.mock_versions().ok().mount().await;
        let client = server.client_builder().no_server_versions().build().await;
        let (core, mut events) = signed_in_core(server, client.clone()).await;
        core.watch_oauth_metadata(&client, core.lifecycle.current());
        let metadata = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if let CoreEvent::OAuthMetadata { metadata } = events.recv().await.unwrap() {
                    return metadata;
                }
            }
        })
        .await
        .unwrap();
        (core, metadata)
    }

    #[tokio::test]
    async fn the_session_start_push_fills_the_cache_for_later_reads() {
        let server = MatrixMockServer::new().await;
        server
            .oauth()
            .mock_server_metadata()
            .ok_https()
            .expect(1)
            .mount()
            .await;

        let (core, metadata) = pushed(&server).await;
        let read = OauthMetadataParams {}.run(&core).await.unwrap();

        assert_eq!(metadata, read);
        let read = read.unwrap();
        assert!(read.account_management_uri.is_some());
        assert!(
            read.account_management_actions_supported
                .contains(&"org.matrix.session_end".to_owned())
        );
    }

    #[tokio::test]
    async fn a_homeserver_without_oauth_pushes_none() {
        let server = MatrixMockServer::new().await;
        server
            .oauth()
            .mock_server_metadata()
            .error_unrecognized()
            .mount()
            .await;

        let (core, metadata) = pushed(&server).await;

        assert!(metadata.is_none());
        assert!(OauthMetadataParams {}.run(&core).await.unwrap().is_none());
    }
}
