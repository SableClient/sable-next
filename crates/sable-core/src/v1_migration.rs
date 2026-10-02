#![allow(clippy::missing_errors_doc)]

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use matrix_sdk::{SqliteCryptoStore, authentication::matrix::MatrixSession};
use matrix_sdk_base::crypto::{
    olm::{
        Account, InboundGroupSession, OutboundGroupSession, PrivateCrossSigningIdentity, Session,
    },
    store::{
        CryptoStore,
        types::{Changes, PendingChanges, SecretsInboxItem},
    },
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;

use crate::{
    Core,
    session::{AccountRegistry, Credentials, PersistedAccount, PersistedSession},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySession {
    base_url: String,
    user_id: String,
    device_id: String,
    access_token: String,
    refresh_token: Option<String>,
    oidc: Option<LegacyOidc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyOidc {
    issuer: String,
    client_id: String,
}

#[derive(Deserialize)]
pub struct Entry {
    key: String,
    value: Value,
}

#[derive(Deserialize)]
pub struct IndexedDbSnapshot {
    version: u32,
    counts: BTreeMap<String, u64>,
}

pub(crate) struct Import {
    registry: AccountRegistry,
    directory: PathBuf,
    stores: Vec<SqliteCryptoStore>,
    snapshots: Vec<Option<IndexedDbSnapshot>>,
    imported: Vec<BTreeMap<String, u64>>,
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    if value.get("ciphertext").is_some() {
        return Err("v1 crypto is encrypted; the original store key is required".into());
    }
    match value {
        Value::String(value) => {
            let bytes = STANDARD_NO_PAD
                .decode(value)
                .map_err(|_| "invalid v1 crypto encoding")?;
            serde_json::from_slice(&bytes).map_err(|_| "invalid v1 crypto value".into())
        }
        value => serde_json::from_value(value).map_err(|_| "invalid legacy v1 crypto value".into()),
    }
}

fn key_parts(key: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut part = String::new();
    let mut chars = key.chars().peekable();
    while let Some(char) = chars.next() {
        if char == '\u{001e}' && chars.peek() == Some(&'\u{001d}') {
            part.push('\u{001d}');
            chars.next();
        } else if char == '\u{001d}' {
            parts.push(std::mem::take(&mut part));
        } else {
            part.push(char);
        }
    }
    parts.push(part);
    parts
}

fn parse_id<T: std::str::FromStr>(value: &str) -> Result<T, String> {
    value
        .parse()
        .map_err(|_| "invalid v1 crypto identifier".into())
}

fn private_directory(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn source_directory(roots: &[PathBuf], user: &str, device: &str) -> Option<PathBuf> {
    let name =
        format!("{user}|{device}").replace(['/', ':', '|', '\\', '<', '>', '"', '?', '*'], "_");
    for root in roots {
        let directory = root.join("matrix-crypto").join(&name);
        let file = directory.join("matrix-sdk-crypto.sqlite3");
        if file.is_file() {
            return Some(directory);
        }
        if file.join("matrix-sdk-crypto.sqlite3").is_file() {
            return Some(file);
        }
    }
    None
}

async fn snapshot_sqlite(source: PathBuf, target: PathBuf) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let connection = rusqlite::Connection::open_with_flags(
            source.join("matrix-sdk-crypto.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|error| error.to_string())?;
        connection
            .backup("main", target.join("matrix-sdk-crypto.sqlite3"), None)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

impl LegacySession {
    fn persisted(self) -> Result<PersistedSession, String> {
        let homeserver = url::Url::parse(&self.base_url).map_err(|_| "invalid v1 homeserver")?;
        if !matches!(homeserver.scheme(), "https" | "http")
            || self.access_token.is_empty()
            || self.device_id.is_empty()
        {
            return Err("invalid v1 credentials".into());
        }
        let meta = matrix_sdk::SessionMeta {
            user_id: parse_id(&self.user_id)?,
            device_id: self.device_id.into(),
        };
        let tokens = matrix_sdk::SessionTokens {
            access_token: self.access_token,
            refresh_token: self.refresh_token,
        };
        let (credentials, oauth_issuer) = match self.oidc {
            Some(oidc) => {
                let issuer =
                    url::Url::parse(&oidc.issuer).map_err(|_| "invalid v1 OAuth issuer")?;
                if oidc.client_id.is_empty() || issuer.scheme() != "https" {
                    return Err("invalid v1 OAuth registration".into());
                }
                (
                    Credentials::OAuth {
                        client_id: oidc.client_id,
                        user: matrix_sdk::authentication::oauth::UserSession { meta, tokens },
                    },
                    Some(issuer),
                )
            }
            None => (Credentials::Password(MatrixSession { meta, tokens }), None),
        };
        Ok(PersistedSession {
            homeserver: self.base_url,
            resolved_homeserver: Some(homeserver),
            credentials,
            oauth_issuer,
        })
    }
}

impl Core {
    pub async fn v1_migration_complete(&self) -> Result<bool, String> {
        if self.sessions.load().await?.is_some() {
            private_directory(Path::new(&self.store_id))?;
            tokio::fs::write(
                Path::new(&self.store_id).join("v1-migration-complete"),
                b"1",
            )
            .await
            .map_err(|error| error.to_string())?;
            return Ok(true);
        }
        match tokio::fs::metadata(Path::new(&self.store_id).join("v1-migration-complete")).await {
            Ok(metadata) => Ok(metadata.is_file()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn skip_v1_migration(&self) -> Result<(), String> {
        let _restore = self.restore_lock.lock().await;
        self.v1_migration.lock().await.take();
        private_directory(Path::new(&self.store_id))?;
        tokio::fs::write(
            Path::new(&self.store_id).join("v1-migration-complete"),
            b"1",
        )
        .await
        .map_err(|error| error.to_string())
    }

    pub async fn begin_v1_migration(
        &self,
        sessions: Vec<LegacySession>,
        active_user_id: Option<String>,
        snapshots: Vec<Option<IndexedDbSnapshot>>,
        native_roots: Vec<PathBuf>,
    ) -> Result<(), String> {
        let _restore = self.restore_lock.lock().await;
        let mut migration = self.v1_migration.lock().await;
        if self.v1_migration_complete().await? {
            return Err("v2 session already exists".into());
        }
        if sessions.is_empty() || sessions.len() != snapshots.len() {
            return Err("invalid v1 migration manifest".into());
        }
        for snapshot in snapshots.iter().flatten() {
            if snapshot.version != 107 || snapshot.counts.get("core").copied().unwrap_or(0) == 0 {
                return Err("unsupported or incomplete v1 crypto snapshot".into());
            }
        }
        *migration = None;
        let directory = Path::new(&self.store_id).join("v1-migration");
        match tokio::fs::remove_dir_all(&directory).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        private_directory(&directory)?;
        let mut registry = AccountRegistry::empty();
        let mut stores = Vec::new();
        for (legacy, snapshot) in sessions.into_iter().zip(&snapshots) {
            let session = legacy.persisted()?;
            let (account_id, store_id) = loop {
                let allocated = registry.allocate_account(&self.store_id);
                if !Path::new(&allocated.1).exists() {
                    break allocated;
                }
            };
            private_directory(&directory.join(&account_id))?;
            let target = directory.join(&account_id).join("store");
            private_directory(&target)?;
            if snapshot.is_none() {
                let source = source_directory(
                    &native_roots,
                    &session.credentials.user_id(),
                    &session.credentials.device_id(),
                )
                .ok_or("original v1 encryption identity is missing")?;
                snapshot_sqlite(source, target.clone()).await?;
            }
            let store = SqliteCryptoStore::open(&target, None)
                .await
                .map_err(|error| error.to_string())?;
            if snapshot.is_none() {
                validate_account(&store, &session).await?;
            }
            if registry.active_account_id.is_none()
                || active_user_id.as_ref() == Some(&session.credentials.user_id())
            {
                registry.active_account_id = Some(account_id.clone());
            }
            registry.accounts.push(PersistedAccount {
                account_id,
                store_id,
                session,
                needs_reauth: false,
                device_invalidated: false,
            });
            stores.push(store);
        }
        *migration = Some(Import {
            registry,
            directory,
            stores,
            imported: snapshots
                .iter()
                .map(|snapshot| {
                    snapshot.as_ref().map_or_else(BTreeMap::new, |snapshot| {
                        snapshot.counts.keys().map(|key| (key.clone(), 0)).collect()
                    })
                })
                .collect(),
            snapshots,
        });
        Ok(())
    }

    pub async fn import_v1_crypto_batch(
        &self,
        account_index: usize,
        table: &str,
        entries: Vec<Entry>,
    ) -> Result<(), String> {
        if entries.len() > 128 {
            return Err("v1 migration batch is too large".into());
        }
        let mut migration = self.v1_migration.lock().await;
        let import = migration.as_mut().ok_or("v1 migration was not started")?;
        let expected_count = import
            .snapshots
            .get(account_index)
            .and_then(Option::as_ref)
            .and_then(|snapshot| snapshot.counts.get(table))
            .ok_or("unknown v1 snapshot table")?;
        let imported = import
            .imported
            .get_mut(account_index)
            .ok_or("unknown v1 account")?
            .get_mut(table)
            .ok_or("unknown v1 snapshot table")?;
        let count = entries.len() as u64;
        if *imported + count > *expected_count {
            return Err("excess v1 snapshot records".into());
        }
        let store = import
            .stores
            .get(account_index)
            .ok_or("unknown v1 account")?;
        let expected = &import
            .registry
            .accounts
            .get(account_index)
            .ok_or("unknown v1 account")?
            .session;
        import_batch(store, expected, table, entries).await?;
        *imported += count;
        Ok(())
    }

    pub async fn finish_v1_migration(&self) -> Result<(), String> {
        let _restore = self.restore_lock.lock().await;
        let mut migration = self.v1_migration.lock().await;
        let import = migration.as_ref().ok_or("v1 migration was not started")?;
        for (snapshot, imported) in import.snapshots.iter().zip(&import.imported) {
            if snapshot
                .as_ref()
                .is_some_and(|snapshot| &snapshot.counts != imported)
            {
                return Err("v1 crypto snapshot is incomplete".into());
            }
        }
        for (account, store) in import.registry.accounts.iter().zip(&import.stores) {
            validate_account(store, &account.session).await?;
        }
        let mut import = migration.take().ok_or("v1 migration was not started")?;
        import.stores.clear();
        for account in &import.registry.accounts {
            tokio::fs::rename(
                import.directory.join(&account.account_id),
                &account.store_id,
            )
            .await
            .map_err(|error| error.to_string())?;
        }
        let bytes = serde_json::to_vec(&import.registry).map_err(|error| error.to_string())?;
        self.sessions.save(bytes).await?;
        *self.accounts.lock().await = Some(import.registry);
        tokio::fs::write(
            Path::new(&self.store_id).join("v1-migration-complete"),
            b"1",
        )
        .await
        .map_err(|error| error.to_string())?;
        Ok(())
    }
}

async fn validate_account(
    store: &SqliteCryptoStore,
    expected: &PersistedSession,
) -> Result<Account, String> {
    let account = store
        .load_account()
        .await
        .map_err(|error| error.to_string())?
        .ok_or("original v1 encryption identity is missing")?;
    if account.user_id().as_str() != expected.credentials.user_id()
        || account.device_id().as_str() != expected.credentials.device_id()
    {
        return Err("v1 encryption identity does not match its session".into());
    }
    Ok(account)
}

#[allow(clippy::too_many_lines)]
async fn import_batch(
    store: &SqliteCryptoStore,
    expected: &PersistedSession,
    table: &str,
    entries: Vec<Entry>,
) -> Result<(), String> {
    let mut changes = Changes::default();
    let mut tracked = Vec::new();
    let mut custom = Vec::new();
    for Entry { key, value } in entries {
        let parts = key_parts(&key);
        let first = parts.first().ok_or("missing v1 crypto key")?;
        match table {
            "core" => match key.as_str() {
                "account" => {
                    let account = Account::from_pickle(decode(value)?)
                        .map_err(|_| "invalid v1 account pickle")?;
                    if account.user_id().as_str() != expected.credentials.user_id()
                        || account.device_id().as_str() != expected.credentials.device_id()
                    {
                        return Err("v1 identity mismatch".into());
                    }
                    store
                        .save_pending_changes(PendingChanges {
                            account: Some(account),
                        })
                        .await
                        .map_err(|error| error.to_string())?;
                }
                "private_identity" => {
                    changes.private_identity = Some(
                        PrivateCrossSigningIdentity::from_pickle(decode(value)?)
                            .map_err(|_| "invalid v1 cross-signing identity")?,
                    );
                }
                "next_batch_token" => changes.next_batch_token = Some(decode(value)?),
                "dehydration_pickle_key" => {
                    changes.dehydrated_device_pickle_key = Some(decode(value)?);
                }
                _ => custom.push((key, decode::<Vec<u8>>(value)?)),
            },
            "backup_keys" => match key.as_str() {
                "recovery_key_v1" => changes.backup_decryption_key = Some(decode(value)?),
                "backup_version_v1" => changes.backup_version = Some(decode(value)?),
                _ => return Err("unknown v1 backup record".into()),
            },
            "session" => {
                let account = validate_account(store, expected).await?;
                let session = Session::from_pickle(account.device_keys(), decode(value)?)
                    .map_err(|_| "invalid v1 Olm session")?;
                if parts.len() != 2
                    || first != &session.sender_key().to_base64()
                    || parts.get(1).map(String::as_str) != Some(session.session_id())
                {
                    return Err("v1 Olm session key mismatch".into());
                }
                changes.sessions.push(session);
            }
            "inbound_group_sessions3" => {
                let pickle = value
                    .get("pickled_session")
                    .ok_or("invalid v1 room key")?
                    .clone();
                let session = InboundGroupSession::from_pickle(decode(pickle)?)
                    .map_err(|_| "invalid v1 room key pickle")?;
                if parts.len() != 2
                    || first != session.room_id().as_str()
                    || parts.get(1).map(String::as_str) != Some(session.session_id())
                {
                    return Err("v1 room key mismatch".into());
                }
                if value
                    .get("needs_backup")
                    .is_some_and(|value| value == 1 || value == true)
                {
                    session.reset_backup_state();
                } else {
                    session.mark_as_backed_up();
                }
                changes.inbound_group_sessions.push(session);
            }
            "outbound_group_sessions" => {
                let account = validate_account(store, expected).await?;
                let session = OutboundGroupSession::from_pickle(
                    account.device_id().to_owned(),
                    account.identity_keys().into(),
                    decode(value)?,
                )
                .map_err(|_| "invalid v1 outbound session")?;
                if parts.len() != 1
                    || first != session.room_id().as_str()
                    || session.sender_key() != account.identity_keys().curve25519
                {
                    return Err("v1 outbound session key mismatch".into());
                }
                changes.outbound_group_sessions.push(session);
            }
            "devices" => {
                let device: matrix_sdk_base::crypto::DeviceData = decode(value)?;
                if parts.len() != 2
                    || first != device.user_id().as_str()
                    || parts.get(1).map(String::as_str) != Some(device.device_id().as_str())
                {
                    return Err("v1 device key mismatch".into());
                }
                changes.devices.new.push(device);
            }
            "identities" => {
                let identity: matrix_sdk_base::crypto::UserIdentityData = decode(value)?;
                if parts.len() != 1 || first != identity.user_id().as_str() {
                    return Err("v1 user identity key mismatch".into());
                }
                changes.identities.new.push(identity);
            }
            "room_settings" => {
                changes
                    .room_settings
                    .insert(parse_id(first)?, decode(value)?);
            }
            "withheld_sessions" => {
                let session = parts.get(1).ok_or("invalid withheld session key")?;
                changes
                    .withheld_session_info
                    .entry(parse_id(first)?)
                    .or_default()
                    .insert(session.clone(), decode(value)?);
            }
            "received_room_key_bundles" => changes.received_room_key_bundles.push(decode(value)?),
            "rooms_pending_key_bundle" => {
                changes
                    .rooms_pending_key_bundle
                    .insert(parse_id(first)?, Some(decode(value)?));
            }
            "room_key_backups_fully_downloaded" => {
                changes
                    .room_key_backups_fully_downloaded
                    .insert(parse_id(first)?);
            }
            "tracked_users" => tracked.push((
                parse_id::<matrix_sdk::ruma::OwnedUserId>(&key)?,
                value.as_bool().ok_or("invalid tracked user")?,
            )),
            "olm_hashes" => {
                changes
                    .message_hashes
                    .push(matrix_sdk_base::crypto::olm::OlmMessageHash {
                        sender_key: first.clone(),
                        hash: parts.get(1).ok_or("invalid v1 message hash")?.clone(),
                    });
            }
            "secrets_inbox2" => changes.secrets.push(SecretsInboxItem {
                secret_name: first.as_str().into(),
                secret: decode::<String>(value)?.into(),
            }),
            "gossip_requests" => {
                let bytes: Vec<u8> = serde_json::from_value(
                    value
                        .get("request")
                        .ok_or("invalid v1 key request")?
                        .clone(),
                )
                .map_err(|_| "invalid v1 key request bytes")?;
                changes.key_requests.push(
                    serde_json::from_slice(&bytes).map_err(|_| "invalid v1 key request content")?,
                );
            }
            "lease_locks" => {}
            _ => return Err(format!("unsupported v1 crypto store: {table}")),
        }
    }
    store
        .save_changes(changes)
        .await
        .map_err(|error| error.to_string())?;
    if !tracked.is_empty() {
        let borrowed: Vec<_> = tracked
            .iter()
            .map(|(user, dirty)| (user.as_ref(), *dirty))
            .collect();
        store
            .save_tracked_users(&borrowed)
            .await
            .map_err(|error| error.to_string())?;
    }
    for (key, value) in custom {
        store
            .set_custom_value(&key, value)
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "v1_migration_tests.rs"]
mod tests;
