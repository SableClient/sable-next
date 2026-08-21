use std::{sync::Arc, time::Duration};

use matrix_sdk::{
    Client, ClientBuilder,
    authentication::{
        matrix::MatrixSession,
        oauth::{
            ClientId, OAuthSession, UserSession,
            registration::{ApplicationType, ClientMetadata, Localized, OAuthGrantType},
        },
    },
    config::RequestConfig,
    encryption::{BackupDownloadStrategy, EncryptionSettings},
    ruma::serde::Raw,
};
use matrix_sdk_ui::sync_service::SyncService;
use serde::{Deserialize, Serialize};
use url::Url;

pub struct Session {
    pub account_id: String,
    pub client: Client,
    pub sync_service: Arc<SyncService>,
    /// So a re-persist after a refresh writes the value we established with.
    pub homeserver: String,
    /// Logging out through the wrong auth API fails.
    pub oauth: bool,
}

/// Whatever the client holds now, which after a refresh is newer than disk.
#[must_use]
pub fn current_session(client: &Client, homeserver: String) -> Option<PersistedSession> {
    if let Some(full) = client.oauth().full_session() {
        return Some(PersistedSession {
            homeserver,
            credentials: Credentials::oauth(full),
        });
    }

    client
        .matrix_auth()
        .session()
        .map(|matrix| PersistedSession {
            homeserver,
            credentials: Credentials::Password(matrix),
        })
}

/// The matrix API round-trips one struct. OAuth needs the registered client id
/// alongside the session, since `OAuthSession` is not serializable.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Credentials {
    Password(MatrixSession),
    OAuth {
        client_id: String,
        user: UserSession,
    },
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PersistedSession {
    pub homeserver: String,
    pub credentials: Credentials,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AccountRegistry {
    version: u8,
    pub active_account_id: Option<String>,
    next_account_id: u64,
    pub accounts: Vec<PersistedAccount>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PersistedAccount {
    pub account_id: String,
    pub store_id: String,
    pub session: PersistedSession,
}

impl AccountRegistry {
    #[must_use]
    pub const fn empty() -> Self {
        Self {
            version: 1,
            active_account_id: None,
            next_account_id: 1,
            accounts: Vec::new(),
        }
    }

    /// # Errors
    ///
    /// Returns a JSON error when `bytes` are neither an account registry nor a
    /// legacy persisted session.
    pub fn from_bytes(
        bytes: &[u8],
        legacy_store_id: &str,
    ) -> Result<(Self, bool), serde_json::Error> {
        if let Ok(registry) = serde_json::from_slice(bytes) {
            return Ok((registry, false));
        }

        let session = serde_json::from_slice(bytes)?;
        Ok((
            Self {
                version: 1,
                active_account_id: Some("a1".to_owned()),
                next_account_id: 2,
                accounts: vec![PersistedAccount {
                    account_id: "a1".to_owned(),
                    store_id: legacy_store_id.to_owned(),
                    session,
                }],
            },
            true,
        ))
    }

    #[must_use]
    pub fn allocate_account(&mut self, base_store_id: &str) -> (String, String) {
        let account_id = format!("a{}", self.next_account_id);
        self.next_account_id += 1;
        let store_id = account_store_id(base_store_id, &account_id);
        (account_id, store_id)
    }

    pub fn upsert(&mut self, account: PersistedAccount) {
        if let Some(existing) = self
            .accounts
            .iter_mut()
            .find(|existing| existing.account_id == account.account_id)
        {
            *existing = account;
        } else {
            self.accounts.push(account);
        }
    }

    pub fn reanchor_stores(&mut self, base_store_id: &str) -> bool {
        let base = std::path::Path::new(base_store_id);
        let mut changed = false;
        for account in &mut self.accounts {
            let anchored = account_store_id(base_store_id, &account.account_id);
            // A legacy store id is the base dir itself.
            if account.store_id == anchored
                || std::path::Path::new(&account.store_id).starts_with(base)
            {
                continue;
            }
            account.store_id = anchored;
            changed = true;
        }
        changed
    }
}

#[must_use]
pub fn account_store_id(base_store_id: &str, account_id: &str) -> String {
    format!("{base_store_id}-account-{account_id}")
}

impl Credentials {
    #[must_use]
    pub fn oauth(session: OAuthSession) -> Self {
        Self::OAuth {
            client_id: session.client_id.as_str().to_owned(),
            user: session.user,
        }
    }

    #[must_use]
    pub fn user_id(&self) -> String {
        match self {
            Self::Password(session) => session.meta.user_id.to_string(),
            Self::OAuth { user, .. } => user.meta.user_id.to_string(),
        }
    }

    #[must_use]
    pub fn device_id(&self) -> String {
        match self {
            Self::Password(session) => session.meta.device_id.to_string(),
            Self::OAuth { user, .. } => user.meta.device_id.to_string(),
        }
    }
}

/// A filesystem path natively, an `IndexedDB` name on the web.
///
/// # Errors
///
/// Returns the Matrix SDK build error if the local store or homeserver cannot
/// be initialized.
pub async fn build_client(
    store_id: &str,
    homeserver: &str,
) -> Result<Client, matrix_sdk::ClientBuildError> {
    let builder = apply_server(Client::builder(), homeserver)
        .handle_refresh_tokens()
        .with_encryption_settings(EncryptionSettings {
            backup_download_strategy: BackupDownloadStrategy::OneShot,
            auto_enable_cross_signing: true,
            auto_enable_backups: true,
        });

    #[cfg(not(target_family = "wasm"))]
    let builder = builder.sqlite_store(std::path::Path::new(store_id).join("store"), None);

    #[cfg(target_family = "wasm")]
    let builder = builder.indexeddb_store(store_id, None);

    builder.build().await
}

/// For dynamic client registration. The redirect URI must match the one handed
/// to `OAuth::login`, and a private-use scheme must be the reverse-DNS of
/// `client_uri`'s host or MAS rejects it with `invalid_redirect_uri`.
///
/// # Panics
///
/// This function relies on `ClientMetadata` being serializable because all
/// fields are constructed from validated URLs and static protocol values.
#[allow(clippy::expect_used)] // metadata serialization is an invariant of this typed value
#[must_use]
pub fn client_metadata(redirect_uri: &Url) -> Raw<ClientMetadata> {
    let loopback = matches!(
        redirect_uri.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]")
    );

    let (application_type, client_uri) = match redirect_uri.scheme() {
        // MAS rejects an http `client_uri`. A loopback http redirect is a
        // *native* client per RFC 8252, which is what a dev server is.
        "http" if loopback => (ApplicationType::Native, canonical_client_uri()),
        "https" | "http" => (ApplicationType::Web, origin_url(redirect_uri)),
        scheme => (ApplicationType::Native, reverse_dns_url(scheme)),
    };

    // RFC 8252 §7.3: a loopback redirect registers without a port, and sending
    // one is rejected (continuwuity answers `invalid_client_metadata`).
    // Authorization still uses the real URI.
    let mut registered_uri = redirect_uri.clone();
    if redirect_uri.scheme() == "http"
        && loopback
        && let Err(error) = registered_uri.set_port(None)
    {
        tracing::warn!("loopback redirect URI kept its port: {error:?}");
    }

    let mut metadata = ClientMetadata::new(
        application_type,
        vec![OAuthGrantType::AuthorizationCode {
            redirect_uris: vec![registered_uri],
        }],
        Localized::new(client_uri, []),
    );
    metadata.client_name = Some(Localized::new("Sable".to_owned(), []));

    Raw::new(&metadata).expect("client metadata serializes")
}

fn canonical_client_uri() -> Url {
    #[allow(clippy::expect_used)] // this compile-time URL is part of the OAuth protocol contract
    {
        Url::parse("https://next.sable.moe").expect("static URL is valid")
    }
}

/// `moe.sable.next` -> `https://next.sable.moe`
fn reverse_dns_url(scheme: &str) -> Url {
    let host = scheme.split('.').rev().collect::<Vec<_>>().join(".");
    Url::parse(&format!("https://{host}")).unwrap_or_else(|_| canonical_client_uri())
}

fn origin_url(redirect_uri: &Url) -> Url {
    Url::parse(&redirect_uri.origin().ascii_serialization())
        .unwrap_or_else(|_| redirect_uri.clone())
}

/// # Errors
///
/// Returns the sync-service error if its initial state cannot be built.
#[allow(clippy::arc_with_non_send_sync)] // the WASM sync service is intentionally single-threaded
pub async fn start_sync(
    client: Client,
) -> Result<Arc<SyncService>, matrix_sdk_ui::sync_service::Error> {
    let sync_service = Arc::new(
        SyncService::builder(client)
            .with_offline_mode()
            .build()
            .await?,
    );
    sync_service.start().await;
    Ok(sync_service)
}

#[must_use]
pub const fn oauth_session(client_id: String, user: UserSession) -> OAuthSession {
    OAuthSession {
        client_id: ClientId::new(client_id),
        user,
    }
}

/// # Errors
///
/// Returns the Matrix SDK build error if discovery cannot construct a client.
pub async fn discovery_client(homeserver: &str) -> Result<Client, matrix_sdk::ClientBuildError> {
    apply_server(Client::builder(), homeserver).build().await
}

fn apply_server(builder: ClientBuilder, homeserver: &str) -> ClientBuilder {
    if let Ok(url) = Url::parse(homeserver)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    {
        // Development and test servers on loopback are already the endpoint.
        return builder.homeserver_url(url);
    }

    // A scheme is no reason to skip `.well-known`: `https://example.com` is
    // usually the server *name*, delegating elsewhere.
    builder
        .server_name_or_homeserver_url(homeserver)
        .request_config(RequestConfig::new().timeout(Duration::from_secs(15)))
}

#[cfg(test)]
mod tests {
    use super::{AccountRegistry, account_store_id};

    fn registry_json(store_id: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "active_account_id": "a1",
            "next_account_id": 2,
            "accounts": [{
                "account_id": "a1",
                "store_id": store_id,
                "session": {
                    "homeserver": "https://example.org",
                    "credentials": {
                        "kind": "password",
                        "user_id": "@alice:example.org",
                        "device_id": "DEVICEID",
                        "access_token": "token"
                    }
                }
            }]
        }))
        .unwrap()
    }

    #[test]
    fn serializes_an_empty_registry() -> Result<(), serde_json::Error> {
        let bytes = serde_json::to_vec(&AccountRegistry::empty())?;
        let (accounts, migrated) = AccountRegistry::from_bytes(&bytes, "sable-next")?;
        assert!(!migrated);
        assert!(accounts.accounts.is_empty());
        Ok(())
    }

    #[test]
    fn allocates_distinct_store_ids() {
        assert_ne!(
            account_store_id("sable-next", "a1"),
            account_store_id("sable-next", "a2")
        );
        let mut accounts = AccountRegistry::empty();
        let (_, first) = accounts.allocate_account("sable-next");
        let (_, second) = accounts.allocate_account("sable-next");
        assert_ne!(first, second);
    }

    #[test]
    fn reanchors_a_store_id_left_under_an_old_data_dir() -> Result<(), serde_json::Error> {
        let bytes = registry_json("/old/container/moe.sable.next-account-a1");
        let (mut accounts, _) =
            AccountRegistry::from_bytes(&bytes, "/new/container/moe.sable.next")?;

        assert!(accounts.reanchor_stores("/new/container/moe.sable.next"));
        assert_eq!(
            accounts.accounts[0].store_id,
            "/new/container/moe.sable.next-account-a1"
        );
        assert!(!accounts.reanchor_stores("/new/container/moe.sable.next"));
        Ok(())
    }

    #[test]
    fn keeps_a_store_id_already_under_the_current_data_dir() -> Result<(), serde_json::Error> {
        let bytes = registry_json("/data/moe.sable.next-account-a1");
        let (mut accounts, _) = AccountRegistry::from_bytes(&bytes, "/data/moe.sable.next")?;
        assert!(!accounts.reanchor_stores("/data/moe.sable.next"));

        // Legacy single-store layout: the id is the base dir itself.
        let bytes = registry_json("/data/moe.sable.next");
        let (mut accounts, _) = AccountRegistry::from_bytes(&bytes, "/data/moe.sable.next")?;
        assert!(!accounts.reanchor_stores("/data/moe.sable.next"));
        Ok(())
    }

    #[test]
    fn keeps_relative_web_store_names() -> Result<(), serde_json::Error> {
        let bytes = registry_json("sable-next-account-a1");
        let (mut accounts, _) = AccountRegistry::from_bytes(&bytes, "sable-next")?;
        assert!(!accounts.reanchor_stores("sable-next"));
        assert_eq!(accounts.accounts[0].store_id, "sable-next-account-a1");
        Ok(())
    }
}
