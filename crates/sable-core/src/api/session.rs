use std::sync::Arc;
use std::sync::atomic::Ordering;

use matrix_sdk::ruma::OwnedRoomId;
use matrix_sdk::ruma::api::federation::discovery::get_server_version;
use serde::{Deserialize, Serialize};

use super::Handler;
use crate::protocol::{
    HomeserverSoftwareView, OAuthMetadataView, OpenIdTokenView, RpcError, SessionInfo, SyncStatus,
    TermsPolicyView,
};
use crate::{Core, ResultExt};

domain! {
    restore,
    list_accounts,
    switch_account,
    remove_account,
    logout,
    reset_local_cache,
    homeserver_info,
    oauth_metadata,
    request_open_id_token,
    access_token,
    open_id_token,
    sync_status,
    server_features,
    delayed_events_supported,
    set_search_options,
    set_network_conditions,
    set_app_in_foreground,
    set_read_room,
    integration_manager_url,
    integration_manager_terms,
    accept_integration_manager_terms,
    known_rooms,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SearchTuning {
    pub crawl_pause_ms: u32,
    pub trickle_pause_ms: u32,
    pub flush_interval_secs: u32,
    pub batch: u32,
    pub base_events: u32,
    pub max_events: u32,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RestoreParams {}

impl Handler for RestoreParams {
    type Ok = Option<SessionInfo>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<SessionInfo>, RpcError> {
        core.restore().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ListAccountsParams {}

impl Handler for ListAccountsParams {
    type Ok = Vec<SessionInfo>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<SessionInfo>, RpcError> {
        core.list_accounts().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SwitchAccountParams {
    pub account_id: String,
}

impl Handler for SwitchAccountParams {
    type Ok = SessionInfo;

    async fn run(self, core: &Arc<Core>) -> Result<SessionInfo, RpcError> {
        core.switch_account(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RemoveAccountParams {
    pub account_id: String,
}

impl Handler for RemoveAccountParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.remove_inactive_account(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct LogoutParams {}

impl Handler for LogoutParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.logout().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ResetLocalCacheParams {}

impl Handler for ResetLocalCacheParams {
    type Ok = ();

    #[cfg(not(target_family = "wasm"))]
    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.reset_local_cache().await
    }

    #[cfg(target_family = "wasm")]
    fn run(self, _core: &Arc<Core>) -> impl Future<Output = Result<(), RpcError>> {
        std::future::ready(Err(crate::protocol::RpcCode::Unsupported.into()))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct HomeserverInfoParams {}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct HomeserverInfoOk {
    pub homeserver: String,
    pub server: Option<HomeserverSoftwareView>,
}

impl Handler for HomeserverInfoParams {
    type Ok = HomeserverInfoOk;

    async fn run(self, core: &Arc<Core>) -> Result<HomeserverInfoOk, RpcError> {
        let client = core.client().await?;
        let server = match client.send(get_server_version::v1::Request::new()).await {
            Ok(response) => response.server.map(software_view),
            Err(error) => {
                tracing::debug!(%error, "the homeserver did not report its version");
                delegated_server_software(&client).await
            }
        };

        Ok(HomeserverInfoOk {
            homeserver: client.homeserver().to_string(),
            server,
        })
    }
}

fn software_view(server: get_server_version::v1::Server) -> HomeserverSoftwareView {
    HomeserverSoftwareView {
        name: server.name,
        version: server.version,
    }
}

async fn delegated_server_software(client: &matrix_sdk::Client) -> Option<HomeserverSoftwareView> {
    #[derive(Deserialize)]
    struct WellKnown {
        #[serde(rename = "m.server")]
        server: String,
    }
    #[derive(Deserialize)]
    struct Version {
        server: Option<get_server_version::v1::Server>,
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        client: &matrix_sdk::Client,
        url: &str,
    ) -> Option<T> {
        let response = client
            .http_client()
            .get(url)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        serde_json::from_slice(&response.bytes().await.ok()?).ok()
    }

    let server_name = client.user_id()?.server_name();
    let well_known = get_json::<WellKnown>(
        client,
        &format!("https://{server_name}/.well-known/matrix/server"),
    )
    .await;
    let host = federation_host(
        server_name.as_str(),
        well_known.as_ref().map(|known| known.server.as_str()),
    );
    let version = get_json::<Version>(
        client,
        &format!("https://{host}/_matrix/federation/v1/version"),
    )
    .await;
    version?.server.map(software_view)
}

fn federation_host(server_name: &str, delegated: Option<&str>) -> String {
    let host = delegated.unwrap_or(server_name);
    let has_port = host
        .rsplit(']')
        .next()
        .is_some_and(|tail| tail.contains(':'));
    if has_port {
        host.to_owned()
    } else {
        format!("{host}:8448")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RequestOpenIdTokenParams {}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RequestOpenIdTokenOk {
    pub access_token: String,
    pub matrix_server_name: String,
    pub expires_in: u32,
}

impl Handler for RequestOpenIdTokenParams {
    type Ok = RequestOpenIdTokenOk;

    async fn run(self, core: &Arc<Core>) -> Result<RequestOpenIdTokenOk, RpcError> {
        let response = core
            .client()
            .await?
            .account()
            .request_openid_token()
            .await
            .or_failed(core, "request_openid_token")?;

        Ok(RequestOpenIdTokenOk {
            access_token: response.access_token,
            matrix_server_name: response.matrix_server_name.to_string(),
            expires_in: u32::try_from(response.expires_in.as_secs()).unwrap_or(u32::MAX),
        })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AccessTokenParams {}

impl Handler for AccessTokenParams {
    type Ok = Option<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<String>, RpcError> {
        Ok(core.client().await?.access_token())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct OpenIdTokenParams {}

impl Handler for OpenIdTokenParams {
    type Ok = OpenIdTokenView;

    async fn run(self, core: &Arc<Core>) -> Result<OpenIdTokenView, RpcError> {
        core.openid_token().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SyncStatusParams {}

impl Handler for SyncStatusParams {
    type Ok = SyncStatus;

    async fn run(self, core: &Arc<Core>) -> Result<SyncStatus, RpcError> {
        Ok(crate::watchers::sync_status(
            core.sync_service().await?.state().get(),
        ))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct OauthMetadataParams {}

impl Handler for OauthMetadataParams {
    type Ok = Option<OAuthMetadataView>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<OAuthMetadataView>, RpcError> {
        let client = core.client().await?;
        Ok(core
            .oauth_metadata(&client, "oauth_metadata")
            .await?
            .as_ref()
            .map(crate::oauth_metadata::view))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ServerFeaturesParams {}

impl Handler for ServerFeaturesParams {
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
        core.server_features().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct DelayedEventsSupportedParams {}

impl Handler for DelayedEventsSupportedParams {
    type Ok = bool;

    async fn run(self, core: &Arc<Core>) -> Result<bool, RpcError> {
        core.scheduling_supported().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
#[expect(
    clippy::struct_excessive_bools,
    reason = "wire type mirroring the protocol"
)]
pub struct SetSearchOptionsParams {
    pub sharing: bool,
    pub disk_budget_mb: u32,
    pub crawler: bool,
    pub unmetered_only: bool,
    pub server_search: bool,
    pub tuning: SearchTuning,
}

impl Handler for SetSearchOptionsParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let was_sharing = core
            .search_sharing
            .enabled
            .swap(self.sharing, Ordering::Relaxed);
        if !self.sharing {
            if was_sharing && let Ok(client) = core.client().await {
                core.forget_search_sharing(&client).await;
            }
            core.cancel_search_peers();
            core.search_sharing.reset_session();
        }
        core.search_network.set_unmetered_only(self.unmetered_only);
        core.refresh_search_peers();
        core.search_crawl.lock().await.tuning = self.tuning.clamped();
        core.search_crawler_enabled
            .store(self.crawler, Ordering::Relaxed);
        core.server_search_enabled
            .store(self.server_search, Ordering::Relaxed);
        core.search_index
            .lock()
            .await
            .set_disk_budget_mb(self.disk_budget_mb);
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetNetworkConditionsParams {
    pub available: bool,
    pub unmetered: bool,
}

impl Handler for SetNetworkConditionsParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.update_network_conditions(self.available, self.unmetered)
            .await;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetAppInForegroundParams {
    pub foreground: bool,
}

impl Handler for SetAppInForegroundParams {
    type Ok = ();

    fn run(self, core: &Arc<Core>) -> impl Future<Output = Result<(), RpcError>> {
        core.update_app_in_foreground(self.foreground);
        std::future::ready(Ok(()))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetReadRoomParams {
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    #[serde(default)]
    pub room_id: Option<OwnedRoomId>,
}

impl Handler for SetReadRoomParams {
    type Ok = ();

    fn run(self, core: &Arc<Core>) -> impl Future<Output = Result<(), RpcError>> {
        core.set_read_room(self.room_id);
        std::future::ready(Ok(()))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct IntegrationManagerUrlParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for IntegrationManagerUrlParams {
    type Ok = String;

    async fn run(self, core: &Arc<Core>) -> Result<String, RpcError> {
        core.integration_manager_url(&self.room_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct IntegrationManagerTermsParams {}

impl Handler for IntegrationManagerTermsParams {
    type Ok = Vec<TermsPolicyView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<TermsPolicyView>, RpcError> {
        core.integration_manager_terms().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct AcceptIntegrationManagerTermsParams {
    pub urls: Vec<String>,
}

impl Handler for AcceptIntegrationManagerTermsParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.accept_integration_manager_terms(self.urls).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct KnownRoomsParams {}

impl Handler for KnownRoomsParams {
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
        Ok(core
            .known_room_ids()
            .await?
            .iter()
            .map(ToString::to_string)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::federation_host;

    #[test]
    fn federation_host_follows_delegation_and_defaults_to_8448() {
        assert_eq!(
            federation_host("example.org", Some("fed.example.org")),
            "fed.example.org:8448"
        );
        assert_eq!(
            federation_host("example.org", Some("fed.example.org:443")),
            "fed.example.org:443"
        );
        assert_eq!(federation_host("example.org", None), "example.org:8448");
        assert_eq!(federation_host("[::1]", None), "[::1]:8448");
        assert_eq!(federation_host("[::1]:8008", None), "[::1]:8008");
    }
}
