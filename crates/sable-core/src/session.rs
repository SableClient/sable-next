use std::{sync::Arc, time::Duration};

use crate::errors::{CoreError, ReportExt};
use matrix_sdk::{
    Client, ClientBuilder, ThreadingSupport,
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

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);

const SESSION_TIMEOUT: Duration = Duration::from_mins(2);
const PROXIED_SESSION_TIMEOUT: Duration = Duration::from_mins(20);

const ROOM_KEY_SHARING_REPAIR_KEY: &[u8] = b"sable.crypto.room-key-sharing-repair-v1";

pub(crate) const THREADING_SUPPORT: ThreadingSupport = ThreadingSupport::Enabled {
    with_subscriptions: false,
};

#[derive(Clone)]
pub struct Session {
    pub account_id: String,
    pub client: Client,
    pub sync_service: Arc<SyncService>,
    /// So a re-persist after a refresh writes the value we established with.
    pub homeserver: String,
    /// Logging out through the wrong auth API fails.
    pub oauth: bool,
    pub(crate) state: Arc<crate::SessionState>,
}

/// Whatever the client holds now, which after a refresh is newer than disk.
#[must_use]
pub fn current_session(client: &Client, homeserver: String) -> Option<PersistedSession> {
    if let Some(full) = client.oauth().full_session() {
        return Some(PersistedSession {
            oauth_issuer: None,
            oauth_redirect_uri: None,
            resolved_homeserver: Some(client.homeserver()),
            homeserver,
            credentials: Credentials::oauth(full),
        });
    }

    client
        .matrix_auth()
        .session()
        .map(|matrix| PersistedSession {
            oauth_issuer: None,
            oauth_redirect_uri: None,
            resolved_homeserver: Some(client.homeserver()),
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_issuer: Option<Url>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_redirect_uri: Option<Url>,
    #[serde(default)]
    pub resolved_homeserver: Option<Url>,
    pub homeserver: String,
    pub credentials: Credentials,
}

impl PersistedSession {
    #[must_use]
    pub fn keeping_endpoint_of(mut self, previous: &Self) -> Self {
        self.oauth_issuer.clone_from(&previous.oauth_issuer);
        if self.oauth_redirect_uri.is_none() {
            self.oauth_redirect_uri
                .clone_from(&previous.oauth_redirect_uri);
        }
        if previous.resolved_homeserver.is_some() {
            self.resolved_homeserver
                .clone_from(&previous.resolved_homeserver);
        }
        self
    }
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
    #[serde(flatten)]
    pub state: AccountState,
}

/// Whether a saved sign-in can start a session. Saved as the two flags older builds read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "AccountStateFlags", into = "AccountStateFlags")]
pub enum AccountState {
    #[default]
    Usable,
    /// Signed out, replaced or being removed. Signing in again keeps its device.
    NeedsSignIn,
    /// The server no longer knows its device, so signing in again makes a new one.
    DeviceGone,
}

impl AccountState {
    #[must_use]
    pub const fn usable(self) -> bool {
        matches!(self, Self::Usable)
    }

    #[must_use]
    pub const fn device_gone(self) -> bool {
        matches!(self, Self::DeviceGone)
    }

    /// A gone device never comes back, only a new sign-in replaces it.
    pub fn require_sign_in(&mut self) {
        if *self == Self::Usable {
            *self = Self::NeedsSignIn;
        }
    }
}

#[derive(Serialize, Deserialize)]
struct AccountStateFlags {
    #[serde(default)]
    needs_reauth: bool,
    #[serde(default)]
    device_invalidated: bool,
}

impl From<AccountStateFlags> for AccountState {
    fn from(flags: AccountStateFlags) -> Self {
        if flags.device_invalidated {
            Self::DeviceGone
        } else if flags.needs_reauth {
            Self::NeedsSignIn
        } else {
            Self::Usable
        }
    }
}

impl From<AccountState> for AccountStateFlags {
    fn from(state: AccountState) -> Self {
        Self {
            needs_reauth: !state.usable(),
            device_invalidated: state.device_gone(),
        }
    }
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
                    state: AccountState::Usable,
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

    /// Keeps each user's latest usable sign-in and returns the others, marked to wait until they
    /// are retired. Sign-ins are appended, so the last entry is the latest, and one waiting for
    /// reauthentication only stays when the user has no other.
    pub fn mark_stale_sign_ins(&mut self) -> Vec<String> {
        let (waiting, usable): (Vec<_>, Vec<_>) = self
            .accounts
            .iter()
            .partition(|account| !account.state.usable());
        let latest: std::collections::HashMap<_, _> = waiting
            .into_iter()
            .chain(usable)
            .map(|account| {
                (
                    account.session.credentials.user_id(),
                    account.account_id.clone(),
                )
            })
            .collect();
        let mut stale = Vec::new();
        for account in &mut self.accounts {
            let user_id = account.session.credentials.user_id();
            if latest.get(&user_id) == Some(&account.account_id) {
                continue;
            }
            account.state.require_sign_in();
            if self.active_account_id.as_ref() == Some(&account.account_id) {
                self.active_account_id = latest.get(&user_id).cloned();
            }
            stale.push(account.account_id.clone());
        }
        stale
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
            account.store_id = if account
                .store_id
                .ends_with(&format!("-account-{}", account.account_id))
            {
                anchored
            } else {
                base_store_id.to_owned()
            };
            changed = true;
        }
        changed
    }
}

#[must_use]
pub fn account_store_id(base_store_id: &str, account_id: &str) -> String {
    format!("{base_store_id}-account-{account_id}")
}

#[must_use]
pub fn removable_account_store(base_store_id: &str, store_id: &str) -> bool {
    store_id
        .strip_prefix(&format!("{base_store_id}-account-"))
        .is_some_and(|account_id| {
            !account_id.is_empty()
                && account_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
}

/// An empty folder, such as one prepared for a bind mount, is free to take.
#[cfg(not(target_family = "wasm"))]
pub(crate) async fn store_holds_data(store_id: &str) -> std::io::Result<bool> {
    match tokio::fs::read_dir(store_id).await {
        Ok(mut entries) => Ok(entries.next_entry().await?.is_some()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        // A file in the slot cannot become a store either.
        Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => Ok(true),
        Err(error) => Err(error),
    }
}

impl Credentials {
    #[must_use]
    pub fn tokens(&self) -> matrix_sdk::SessionTokens {
        match self {
            Self::Password(session) => session.tokens.clone(),
            Self::OAuth { user, .. } => user.tokens.clone(),
        }
    }
    #[cfg(not(target_family = "wasm"))]
    pub(crate) fn set_tokens(&mut self, tokens: matrix_sdk::SessionTokens) {
        match self {
            Self::Password(session) => session.tokens = tokens,
            Self::OAuth { user, .. } => user.tokens = tokens,
        }
    }

    pub(crate) fn discard_tokens(&mut self) {
        let tokens = match self {
            Self::Password(session) => &mut session.tokens,
            Self::OAuth { user, .. } => &mut user.tokens,
        };
        tokens.access_token.clear();
        tokens.refresh_token = None;
    }

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

#[derive(Debug, thiserror::Error)]
pub enum BuildError {
    #[error(transparent)]
    Sdk(#[from] matrix_sdk::ClientBuildError),
    #[error(transparent)]
    Store(#[from] crate::store::StoreError),
}

/// A filesystem path natively, an `IndexedDB` name on the web.
/// # Errors
///
/// Returns the Matrix SDK build error if the local store or homeserver cannot
/// be initialized.
pub async fn build_client(
    store_id: &str,
    homeserver: &str,
    persistent_event_cache: bool,
) -> Result<Client, BuildError> {
    build_account_client(
        apply_server(Client::builder(), homeserver),
        store_id,
        ClientRole::Account,
        persistent_event_cache,
    )
    .await
}

/// # Errors
///
/// Returns the Matrix SDK build error if the local store cannot be initialized.
pub async fn build_client_at(
    store_id: &str,
    homeserver_url: &Url,
    persistent_event_cache: bool,
) -> Result<Client, BuildError> {
    let builder = crate::tls::apply_sdk(Client::builder()).homeserver_url(homeserver_url.as_str());

    build_account_client(
        builder,
        store_id,
        ClientRole::Account,
        persistent_event_cache,
    )
    .await
}

/// # Errors
///
/// Returns the SDK build error if the store or homeserver cannot be initialized.
pub async fn restore_client(
    store_id: &str,
    persisted: &PersistedSession,
    persistent_event_cache: bool,
) -> Result<Client, BuildError> {
    match &persisted.resolved_homeserver {
        Some(url) => build_client_at(store_id, url, persistent_event_cache).await,
        None => build_client(store_id, &persisted.homeserver, persistent_event_cache).await,
    }
}

/// Restore the persisted login after opening its local SDK store.
///
/// # Errors
///
/// Returns an error if the client or saved login cannot be restored.
pub async fn restore_authenticated_client(
    store_id: &str,
    persisted: &PersistedSession,
) -> Result<Client, CoreError> {
    validate_saved_crypto_store(store_id, persisted).await?;
    let client = restore_client(store_id, persisted, true).await.backend()?;

    restore_credentials(&client, persisted).await?;
    Ok(client)
}

fn persisted_server_builder(persisted: &PersistedSession) -> ClientBuilder {
    persisted.resolved_homeserver.as_ref().map_or_else(
        || apply_server(Client::builder(), &persisted.homeserver),
        |url| crate::tls::apply_sdk(Client::builder()).homeserver_url(url.as_str()),
    )
}

#[cfg(not(target_family = "wasm"))]
pub(crate) async fn restore_notification_client(
    store_id: &str,
    persisted: &PersistedSession,
    room_load: matrix_sdk::store::RoomLoadSettings,
    before_restore: impl FnOnce(&Client),
) -> Result<Client, CoreError> {
    validate_saved_crypto_store_for(store_id, persisted, ClientRole::Notification)
        .await
        .map_err(|error| {
            tracing::error!(context = "notification_restore_crypto_store", "{error}");
            error
        })?;
    let client = build_account_client(
        persisted_server_builder(persisted),
        store_id,
        ClientRole::Notification,
        true,
    )
    .await
    .backend()?;
    // Fetching a push must not report the user online.
    client
        .set_presence(ruma::presence::PresenceState::Offline, None, false)
        .await
        .backend()?;
    before_restore(&client);
    restore_credentials_with(&client, persisted, room_load).await?;
    Ok(client)
}

pub(crate) async fn restore_credentials(
    client: &Client,
    persisted: &PersistedSession,
) -> Result<(), CoreError> {
    restore_credentials_with(
        client,
        persisted,
        matrix_sdk::store::RoomLoadSettings::default(),
    )
    .await?;
    enable_crypto_store_lock(client).await
}

/// Signs a saved login out on the server without opening its store.
pub(crate) async fn log_out(persisted: &PersistedSession) -> Result<(), CoreError> {
    let client = persisted_server_builder(persisted)
        .handle_refresh_tokens()
        .build()
        .await
        .backend()?;
    restore_credentials_with(
        &client,
        persisted,
        matrix_sdk::store::RoomLoadSettings::default(),
    )
    .await?;
    match persisted.credentials {
        Credentials::Password(_) => client.matrix_auth().logout().await.map(|_| ()).backend(),
        Credentials::OAuth { .. } => client.oauth().logout().await.backend(),
    }
}

async fn restore_credentials_with(
    client: &Client,
    persisted: &PersistedSession,
    room_load: matrix_sdk::store::RoomLoadSettings,
) -> Result<(), CoreError> {
    match persisted.credentials.clone() {
        Credentials::Password(matrix) => client
            .restore_session_with(matrix, room_load)
            .await
            .backend()?,
        Credentials::OAuth { client_id, user } => client
            .oauth()
            .restore_session(oauth_session(client_id, user), room_load)
            .await
            .backend()?,
    }
    Ok(())
}

pub(crate) async fn enable_crypto_store_lock(client: &Client) -> Result<(), CoreError> {
    let matrix_sdk_common::cross_process_lock::CrossProcessLockConfig::MultiProcess { holder_name } =
        client.cross_process_lock_config()
    else {
        return Ok(());
    };
    match client
        .encryption()
        .enable_cross_process_store_lock(holder_name.clone())
        .await
    {
        Ok(()) | Err(matrix_sdk::Error::BadCryptoStoreState) => Ok(()),
        Err(error) => Err(CoreError::backend(error)),
    }
}

pub(crate) async fn validate_saved_crypto_store(
    store_id: &str,
    persisted: &PersistedSession,
) -> Result<(), CoreError> {
    validate_saved_crypto_store_for(store_id, persisted, ClientRole::Account).await
}

async fn validate_saved_crypto_store_for(
    store_id: &str,
    persisted: &PersistedSession,
    role: ClientRole,
) -> Result<(), CoreError> {
    use matrix_sdk_base::crypto::store::CryptoStore;

    #[cfg(not(target_family = "wasm"))]
    let store = {
        let path = std::path::Path::new(store_id).join("store");
        let metadata = tokio::fs::metadata(path.join("matrix-sdk-crypto.sqlite3"))
            .await
            .context("saved crypto database is unavailable")?;
        if !metadata.is_file() {
            return Err("saved crypto database is not a file".into());
        }
        let key = match crate::store_encryption::saved_key(store_id) {
            Err(crate::store::StoreError::KeyMissing) => {
                return Err(CoreError::invalid("saved crypto database key is missing"));
            }
            key => key?,
        };
        matrix_sdk::SqliteCryptoStore::open_with_config(
            &role
                .store_config(path)
                .key(key.as_ref().map(|key| key.as_slice())),
        )
        .await
        .context("saved crypto database could not be opened")?
    };
    #[cfg(target_family = "wasm")]
    let store = {
        let _ = role;
        matrix_sdk_indexeddb::IndexeddbStores::open(store_id, None)
            .await
            .context("saved crypto database could not be opened")?
            .crypto
    };

    let account = store
        .load_account()
        .await
        .context("saved crypto identity could not be read")?
        .ok_or("saved crypto identity is missing")?;
    if account.user_id().as_str() != persisted.credentials.user_id()
        || account.device_id().as_str() != persisted.credentials.device_id()
    {
        return Err("saved crypto identity does not match the session".into());
    }
    Ok(())
}

pub(crate) async fn repair_room_key_sharing(client: &Client) -> Result<(), CoreError> {
    let store = client.state_store();
    if store
        .get_custom_value(ROOM_KEY_SHARING_REPAIR_KEY)
        .await
        .backend()?
        .is_some()
    {
        return Ok(());
    }

    for room in client.joined_rooms() {
        if room.encryption_state().is_encrypted() {
            room.discard_room_key().await.backend()?;
        }
    }

    store
        .set_custom_value_no_read(ROOM_KEY_SHARING_REPAIR_KEY, vec![1])
        .await
        .backend()
}

#[derive(Clone, Copy)]
enum ClientRole {
    Account,
    #[cfg(not(target_family = "wasm"))]
    Notification,
}

impl ClientRole {
    const fn is_account(self) -> bool {
        matches!(self, Self::Account)
    }

    #[cfg(not(target_family = "wasm"))]
    async fn store_key(
        self,
        store_id: &str,
    ) -> Result<Option<crate::secrets::Key>, crate::store::StoreError> {
        if self.is_account() {
            crate::store_encryption::account_key(store_id).await
        } else {
            crate::store_encryption::saved_key(store_id)?
                .ok_or(crate::store::StoreError::Invalid(
                    "the store is not encrypted yet",
                ))
                .map(Some)
        }
    }

    /// A notification service extension is held to a few dozen megabytes.
    #[cfg(not(target_family = "wasm"))]
    fn store_config(self, path: std::path::PathBuf) -> matrix_sdk::SqliteStoreConfig {
        if self.is_account() {
            matrix_sdk::SqliteStoreConfig::new(path)
        } else {
            matrix_sdk::SqliteStoreConfig::with_low_memory_config(path)
        }
    }

    const fn encryption_settings(self) -> EncryptionSettings {
        let account = self.is_account();
        EncryptionSettings {
            backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
            auto_enable_cross_signing: account,
            auto_enable_backups: account,
        }
    }
}

#[cfg(not(target_family = "wasm"))]
async fn native_store_config(
    store_id: &str,
    role: ClientRole,
    lock: matrix_sdk_common::cross_process_lock::CrossProcessLockConfig,
) -> Result<matrix_sdk_base::store::StoreConfig, BuildError> {
    let key = role.store_key(store_id).await?;
    let store = role
        .store_config(std::path::Path::new(store_id).join("store"))
        .key(key.as_ref().map(|key| key.as_slice()));
    let cache = store
        .clone()
        .path(std::path::Path::new(store_id).join("cache"));
    // The iOS extension taking the event cache lock makes the app reset its open timelines.
    let caches = async {
        if role.is_account() {
            futures_util::try_join!(
                matrix_sdk::SqliteEventCacheStore::open_with_config(&cache),
                matrix_sdk::SqliteMediaStore::open_with_config(&cache),
            )
            .map(Some)
        } else {
            Ok(None)
        }
    };
    let (state, crypto, caches) = futures_util::try_join!(
        matrix_sdk::SqliteStateStore::open_with_config(&store),
        matrix_sdk::SqliteCryptoStore::open_with_config(&store),
        caches,
    )
    .map_err(matrix_sdk::ClientBuildError::from)?;
    let config = matrix_sdk_base::store::StoreConfig::new(lock)
        .state_store(state)
        .crypto_store(crypto);
    Ok(match caches {
        Some((event_cache, media)) => config.event_cache_store(event_cache).media_store(media),
        None => config,
    })
}

/// Also names the client in the OAuth refresh lock, so no two clients share a holder.
#[cfg(not(target_family = "wasm"))]
fn lock_holder() -> String {
    static NEXT_CLIENT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    format!(
        "sable-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT_CLIENT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

/// Android runs in one process with one client per store, so it needs neither SDK lock.
/// The iOS notification extension shares the stores from another process.
#[cfg(not(target_family = "wasm"))]
fn store_lock(holder: &str) -> matrix_sdk_common::cross_process_lock::CrossProcessLockConfig {
    if cfg!(target_os = "ios") {
        matrix_sdk_common::cross_process_lock::CrossProcessLockConfig::multi_process(
            holder.to_owned(),
        )
    } else {
        matrix_sdk_common::cross_process_lock::CrossProcessLockConfig::SingleProcess
    }
}

#[cfg(not(target_family = "wasm"))]
const OAUTH_REFRESH_LOCK: bool = !cfg!(target_os = "android");

async fn build_account_client(
    builder: ClientBuilder,
    store_id: &str,
    role: ClientRole,
    persistent_event_cache: bool,
) -> Result<Client, BuildError> {
    let builder = if role.is_account() {
        builder.handle_refresh_tokens()
    } else {
        builder
    };
    let builder = builder
        .request_config(
            RequestConfig::new()
                .timeout(session_timeout(crate::tls::proxy_configured()))
                .retry_limit(3),
        )
        .with_threading_support(THREADING_SUPPORT)
        .with_encryption_settings(role.encryption_settings())
        .with_event_cache(role.is_account());

    #[cfg(not(target_family = "wasm"))]
    {
        let _ = persistent_event_cache;
        let holder = lock_holder();
        let lock = store_lock(&holder);

        let config = native_store_config(store_id, role, lock.clone()).await?;
        let base = Arc::new(matrix_sdk_base::BaseClient::new(
            config,
            THREADING_SUPPORT,
            matrix_sdk_base::DmRoomDefinition::MatrixSpec,
        ));
        let client = builder
            .cross_process_store_config(lock)
            .base_client((*base).clone())
            .build()
            .await?;
        // Before any restore or login, which is when the SDK sets the lock up.
        if OAUTH_REFRESH_LOCK
            && let Err(error) = client
                .oauth()
                .enable_cross_process_refresh_lock(holder)
                .await
        {
            tracing::error!("could not enable the OAuth refresh lock: {error}");
            // Without it the app and the notification extension could both spend one refresh token.
            if cfg!(target_os = "ios") {
                return Err(crate::store::StoreError::Invalid(
                    "the OAuth refresh lock could not be enabled",
                )
                .into());
            }
        }
        if role.is_account() {
            register_base_client(store_id, base, &client);
        }
        Ok(client)
    }

    #[cfg(target_family = "wasm")]
    {
        // The SharedWorker is the sole IndexedDB owner in the web runtime.
        let lock = matrix_sdk::cross_process_lock::CrossProcessLockConfig::SingleProcess;
        let stores = matrix_sdk_indexeddb::IndexeddbStores::open(store_id, None)
            .await
            .map_err(matrix_sdk::ClientBuildError::from)?;
        let config = matrix_sdk_base::store::StoreConfig::new(lock.clone())
            .state_store(stores.state)
            .media_store(stores.media)
            .crypto_store(stores.crypto);
        let config = if persistent_event_cache {
            config.event_cache_store(stores.event_cache)
        } else {
            config
        };
        let base = std::rc::Rc::new(matrix_sdk_base::BaseClient::new(
            config,
            THREADING_SUPPORT,
            matrix_sdk_base::DmRoomDefinition::MatrixSpec,
        ));
        let client = builder
            .cross_process_store_config(lock)
            .base_client((*base).clone())
            .build()
            .await?;
        BASE_CLIENTS.with_borrow_mut(|bases| {
            bases.insert(store_id.to_owned(), std::rc::Rc::downgrade(&base));
        });
        client.add_event_handler(move |_: ruma::events::dummy::ToDeviceDummyEvent| {
            let _owner = &base;
            async {}
        });
        Ok(client)
    }
}

const fn session_timeout(proxied: bool) -> Duration {
    if proxied {
        PROXIED_SESSION_TIMEOUT
    } else {
        SESSION_TIMEOUT
    }
}

#[cfg(target_family = "wasm")]
thread_local! {
    static BASE_CLIENTS: std::cell::RefCell<
        std::collections::HashMap<String, std::rc::Weak<matrix_sdk_base::BaseClient>>,
    > = std::cell::RefCell::default();
}

#[cfg(target_family = "wasm")]
pub(crate) type SharedBaseClient = std::rc::Rc<matrix_sdk_base::BaseClient>;

#[cfg(not(target_family = "wasm"))]
pub(crate) type SharedBaseClient = Arc<matrix_sdk_base::BaseClient>;

#[cfg(not(target_family = "wasm"))]
static BASE_CLIENTS: std::sync::LazyLock<
    parking_lot::Mutex<
        std::collections::HashMap<String, std::sync::Weak<matrix_sdk_base::BaseClient>>,
    >,
> = std::sync::LazyLock::new(parking_lot::Mutex::default);

#[cfg(not(target_family = "wasm"))]
fn register_base_client(store_id: &str, base: SharedBaseClient, client: &Client) {
    BASE_CLIENTS
        .lock()
        .insert(store_id.to_owned(), Arc::downgrade(&base));
    client.add_event_handler(move |_: ruma::events::dummy::ToDeviceDummyEvent| {
        let _owner = &base;
        async {}
    });
}

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
pub(crate) async fn mock_account_client(
    server: &matrix_sdk::test_utils::mocks::MatrixMockServer,
    store_id: &str,
) -> Client {
    let base = Arc::new(matrix_sdk_base::BaseClient::new(
        matrix_sdk_base::store::StoreConfig::new(
            matrix_sdk_common::cross_process_lock::CrossProcessLockConfig::SingleProcess,
        ),
        THREADING_SUPPORT,
        matrix_sdk_base::DmRoomDefinition::MatrixSpec,
    ));
    let owned = (*base).clone();
    let client = server
        .client_builder()
        .on_builder(move |builder| builder.base_client(owned))
        .build()
        .await;
    register_base_client(store_id, base, &client);
    client
}

#[cfg(target_family = "wasm")]
pub(crate) fn base_client(store_id: &str) -> Option<SharedBaseClient> {
    BASE_CLIENTS.with_borrow(|bases| bases.get(store_id)?.upgrade())
}

#[cfg(not(target_family = "wasm"))]
pub(crate) fn base_client(store_id: &str) -> Option<SharedBaseClient> {
    BASE_CLIENTS.lock().get(store_id)?.upgrade()
}

#[cfg(not(target_family = "wasm"))]
pub(crate) type StoreLease = tokio::sync::OwnedMutexGuard<()>;

/// The `SharedWorker` is the only owner of a web store.
#[cfg(target_family = "wasm")]
pub(crate) type StoreLease = ();

#[cfg(target_family = "wasm")]
pub(crate) fn store_lease(_store_id: &str) -> std::future::Ready<StoreLease> {
    std::future::ready(())
}

/// Two clients on one crypto store overwrite each other's Olm sessions.
#[cfg(not(target_family = "wasm"))]
pub(crate) async fn store_lease(store_id: &str) -> StoreLease {
    static LEASES: std::sync::LazyLock<
        parking_lot::Mutex<
            std::collections::HashMap<std::path::PathBuf, Arc<tokio::sync::Mutex<()>>>,
        >,
    > = std::sync::LazyLock::new(parking_lot::Mutex::default);

    let store = std::fs::canonicalize(store_id).unwrap_or_else(|_| store_id.into());
    let lease = LEASES.lock().entry(store).or_default().clone();
    lease.lock_owned().await
}

const DEFAULT_DEVICE_DISPLAY_NAME: &str = "Sable";

pub(crate) fn device_display_name(configured: Option<&str>) -> &str {
    configured.unwrap_or(DEFAULT_DEVICE_DISPLAY_NAME)
}

/// For dynamic client registration. The redirect URI must match `OAuth::login`'s, and a private-use
/// scheme must be the reverse-DNS of `client_uri`'s host.
/// # Panics
///
/// This function relies on `ClientMetadata` being serializable because all
/// fields are constructed from validated URLs and static protocol values.
#[must_use]
pub fn client_metadata(redirect_uri: &Url, client_name: Option<&str>) -> Raw<ClientMetadata> {
    metadata_with(redirect_uri, false, client_name)
}

/// Registered only for QR login, so an ordinary login never asks for a grant type the server may lack.
#[must_use]
pub fn qr_client_metadata(redirect_uri: &Url) -> Raw<ClientMetadata> {
    metadata_with(redirect_uri, true, None)
}

#[expect(
    clippy::expect_used,
    reason = "metadata serialization is an invariant of this typed value"
)]
fn metadata_with(
    redirect_uri: &Url,
    device_code: bool,
    client_name: Option<&str>,
) -> Raw<ClientMetadata> {
    let application_type = match redirect_uri.scheme() {
        _ if is_loopback_redirect(redirect_uri) => ApplicationType::Native,
        "https" | "http" => ApplicationType::Web,
        _ => ApplicationType::Native,
    };
    let client_uri = if application_type == ApplicationType::Web {
        redirect_uri.join("/").expect("web redirect URI has a base")
    } else {
        Url::parse("https://sable.moe").expect("this is a valid URL")
    };
    let logo_uri = if application_type == ApplicationType::Web {
        client_uri
            .join("icons/logo-maskable-180x180.png")
            .expect("client URI has a base")
    } else {
        Url::parse("https://docs.sable.moe/img/sable-logo.svg").expect("this is a valid URL")
    };

    let mut grant_types = vec![OAuthGrantType::AuthorizationCode {
        redirect_uris: vec![registration_redirect_uri(redirect_uri)],
    }];
    if device_code {
        grant_types.push(OAuthGrantType::DeviceCode);
    }
    let mut metadata = ClientMetadata::new(
        application_type,
        grant_types,
        Localized::new(client_uri, []),
    );
    metadata.client_name = Some(Localized::new(
        device_display_name(client_name).to_owned(),
        [],
    ));
    metadata.logo_uri = Some(Localized::new(logo_uri, []));

    Raw::new(&metadata).expect("client metadata serializes")
}

#[must_use]
pub fn is_loopback_redirect(redirect_uri: &Url) -> bool {
    redirect_uri.scheme() == "http"
        && matches!(
            redirect_uri.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]")
        )
}

/// RFC 8252 §7.3: a loopback redirect registers without its port, and authorization may use any port.
#[must_use]
pub fn registration_redirect_uri(redirect_uri: &Url) -> Url {
    let mut registered = redirect_uri.clone();
    if is_loopback_redirect(redirect_uri)
        && let Err(error) = registered.set_port(None)
    {
        tracing::warn!("loopback redirect URI kept its port: {error:?}");
    }
    registered
}

#[must_use]
pub fn registered_redirect_uri(session: &PersistedSession, requested: &Url) -> Option<Url> {
    if let Some(uri) = &session.oauth_redirect_uri {
        return Some(uri.clone());
    }
    if matches!(requested.scheme(), "http" | "https") {
        return None;
    }
    let legacy = if session.oauth_issuer.is_some() {
        "moe.sable.app:/login"
    } else {
        "moe.sable.next:/login"
    };
    Url::parse(legacy).ok()
}

/// # Errors
///
/// Returns the sync-service error if its initial state cannot be built.
pub async fn start_sync(
    client: Client,
) -> Result<Arc<SyncService>, matrix_sdk_ui::sync_service::Error> {
    let sync_service = build_sync(client).await?;
    sync_service.start().await;
    Ok(sync_service)
}

/// # Errors
///
/// Returns the sync-service error if its initial state cannot be built.
#[cfg_attr(
    target_family = "wasm",
    expect(
        clippy::arc_with_non_send_sync,
        reason = "the WASM core is single-threaded"
    )
)]
pub async fn build_sync(
    client: Client,
) -> Result<Arc<SyncService>, matrix_sdk_ui::sync_service::Error> {
    Ok(Arc::new(
        SyncService::builder(client)
            .with_offline_mode()
            .build()
            .await?,
    ))
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
    let builder = crate::tls::apply_sdk(builder);

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
        .request_config(RequestConfig::new().timeout(DISCOVERY_TIMEOUT))
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;
