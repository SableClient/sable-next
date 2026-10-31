use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use matrix_sdk::ruma::events::secret::request::SecretName;
use matrix_sdk::ruma::{OwnedRoomId, OwnedTransactionId, OwnedUserId};
use matrix_sdk::{SqliteCryptoStore, SqliteStateStore, SqliteStoreConfig};
use matrix_sdk_base::StateStore as _;
use matrix_sdk_base::crypto::olm::OlmMessageHash;
use matrix_sdk_base::crypto::store::CryptoStore as _;
use matrix_sdk_base::crypto::store::types::{Changes, SecretsInboxItem};
use rusqlite::{Connection, OpenFlags};

use crate::secrets::{self, Key};
use crate::store::StoreError;

const MARKER: &str = "encrypted";
const KEY_REFERENCE: &str = "store-key";
const CRYPTO_DATABASE: &str = "matrix-sdk-crypto.sqlite3";
const SLIDING_SYNC_PREFIX: &str = "sliding_sync_store::";

static ENCRYPTING: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(Default::default);

fn store_dir(store_id: &str) -> PathBuf {
    Path::new(store_id).join("store")
}

fn key_reference(store_id: &str) -> PathBuf {
    Path::new(store_id).join(KEY_REFERENCE)
}

pub(crate) fn config(path: impl AsRef<Path>, key: Option<&Key>) -> SqliteStoreConfig {
    SqliteStoreConfig::new(path).key(key.map(Key::as_slice))
}

/// `None` for a store saved before stores were encrypted.
pub(crate) fn saved_key(store_id: &str) -> Result<Option<Key>, StoreError> {
    finish_swap(store_id)?;
    if !store_dir(store_id).join(MARKER).exists() {
        return Ok(None);
    }
    secrets::load(&key_reference(store_id))?
        .map(Some)
        .ok_or(StoreError::KeyMissing)
}

/// `None` leaves a store saved before stores were encrypted as it is, to retry on a later start.
/// Only the app's own process may call this: a notification process opening the old store
/// meanwhile could write to it.
pub(crate) async fn account_key(store_id: &str) -> Result<Option<Key>, StoreError> {
    let _encrypting = ENCRYPTING.lock().await;
    if let Some(key) = saved_key(store_id)? {
        return Ok(Some(key));
    }
    let store = store_dir(store_id);
    if !store.join(CRYPTO_DATABASE).exists()
        && !store.join(matrix_sdk::STATE_STORE_DATABASE_NAME).exists()
    {
        let key = secrets::load_or_create(&key_reference(store_id))?;
        std::fs::create_dir_all(&store)?;
        write_marker(&store)?;
        return Ok(Some(key));
    }
    let key = match encrypted_copy(store_id).await {
        Ok(Some(key)) => key,
        Ok(None) => return Ok(None),
        Err(error) => {
            tracing::error!("the account store stays unencrypted for now: {error}");
            discard(&Path::new(store_id).join("store.new"));
            return Ok(None);
        }
    };
    // Past this point the old store is gone from its place, so a failure must not reopen it.
    std::fs::rename(&store, Path::new(store_id).join("store.old"))?;
    finish_swap(store_id)?;
    Ok(Some(key))
}

pub(crate) fn forget(store_id: &str) {
    secrets::forget(&key_reference(store_id));
}

/// The state store keeps only its custom values. The next sync refetches the rest, and the event
/// cache and media. `None` while messages wait in the send queue, which lives in the state store.
async fn encrypted_copy(store_id: &str) -> Result<Option<Key>, StoreError> {
    let store = store_dir(store_id);
    let has_state = store.join(matrix_sdk::STATE_STORE_DATABASE_NAME).exists();
    if has_state && has_unsent_requests(&store).await? {
        return Ok(None);
    }
    let key = secrets::load_or_create(&key_reference(store_id))?;
    let replacement = Path::new(store_id).join("store.new");
    remove_dir(&replacement)?;
    std::fs::create_dir_all(&replacement)?;
    if store.join(CRYPTO_DATABASE).exists() {
        copy_crypto(&store, &replacement, &key).await?;
    }
    if has_state {
        copy_state(&store, &replacement, &key).await?;
    }
    write_marker(&replacement)?;
    Ok(Some(key))
}

async fn has_unsent_requests(store: &Path) -> Result<bool, StoreError> {
    let state = SqliteStateStore::open_with_config(&config(store, None))
        .await
        .map_err(StoreError::backend)?;
    let rooms = state
        .load_rooms_with_unsent_requests()
        .await
        .map_err(StoreError::backend)?;
    state.close().await.map_err(StoreError::backend)?;
    Ok(!rooms.is_empty())
}

/// Completes a swap that a crash or another process interrupted. The marker is written last, so a
/// replacement without one was never finished.
fn finish_swap(store_id: &str) -> Result<(), StoreError> {
    let base = Path::new(store_id);
    let store = store_dir(store_id);
    let replacement = base.join("store.new");
    let retired = base.join("store.old");
    if !store.exists()
        && replacement.join(MARKER).exists()
        && let Err(error) = std::fs::rename(&replacement, &store)
        && !store.join(MARKER).exists()
    {
        return Err(error.into());
    }
    if retired.exists() && store.join(MARKER).exists() {
        discard(&base.join("cache"));
        discard(&retired);
    }
    Ok(())
}

/// Leftovers are retried on the next start.
fn discard(path: &Path) {
    if let Err(error) = remove_dir(path) {
        tracing::warn!("could not remove {}: {error}", path.display());
    }
}

fn remove_dir(path: &Path) -> Result<(), StoreError> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
        _ => Ok(()),
    }
}

fn write_marker(directory: &Path) -> Result<(), StoreError> {
    std::fs::File::create(directory.join(MARKER))?.sync_all()?;
    Ok(())
}

fn read_only(database: &Path) -> Result<Connection, StoreError> {
    Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(StoreError::backend)
}

fn column<T: rusqlite::types::FromSql>(raw: &Connection, sql: &str) -> Result<Vec<T>, StoreError> {
    let mut statement = raw.prepare(sql).map_err(StoreError::backend)?;
    statement
        .query_map([], |row| row.get(0))
        .and_then(Iterator::collect)
        .map_err(StoreError::backend)
}

type Pair = (Vec<u8>, Vec<u8>);

fn pairs(raw: &Connection, sql: &str) -> Result<Vec<Pair>, StoreError> {
    let mut statement = raw.prepare(sql).map_err(StoreError::backend)?;
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .and_then(Iterator::collect)
        .map_err(StoreError::backend)
}

fn text(bytes: Vec<u8>) -> Result<String, StoreError> {
    String::from_utf8(bytes).map_err(|_| StoreError::Invalid("a crypto store key is not text"))
}

fn room_id(bytes: Vec<u8>) -> Result<OwnedRoomId, StoreError> {
    OwnedRoomId::try_from(text(bytes)?).map_err(StoreError::backend)
}

fn user_id(bytes: Vec<u8>) -> Result<OwnedUserId, StoreError> {
    OwnedUserId::try_from(text(bytes)?).map_err(StoreError::backend)
}

/// A plaintext store keeps its lookup keys in the clear, so each record can be read back through
/// the store itself.
struct Listing {
    kv: Vec<String>,
    sender_keys: Vec<String>,
    outbound_rooms: Vec<OwnedRoomId>,
    device_users: Vec<OwnedUserId>,
    identity_users: Vec<OwnedUserId>,
    olm_hashes: Vec<OlmMessageHash>,
    key_requests: Vec<OwnedTransactionId>,
    secret_names: Vec<SecretName>,
    withheld: Vec<(OwnedRoomId, String)>,
    room_settings: Vec<OwnedRoomId>,
    bundles: Vec<(OwnedRoomId, OwnedUserId)>,
    backups_downloaded: Vec<OwnedRoomId>,
}

fn rooms(raw: &Connection, sql: &str) -> Result<Vec<OwnedRoomId>, StoreError> {
    column(raw, sql)?.into_iter().map(room_id).collect()
}

fn users(raw: &Connection, sql: &str) -> Result<Vec<OwnedUserId>, StoreError> {
    column(raw, sql)?.into_iter().map(user_id).collect()
}

fn list(database: &Path) -> Result<Listing, StoreError> {
    let raw = read_only(database)?;
    Ok(Listing {
        kv: column(&raw, "SELECT key FROM kv")?,
        sender_keys: column(&raw, "SELECT DISTINCT sender_key FROM session")?
            .into_iter()
            .map(text)
            .collect::<Result<_, _>>()?,
        outbound_rooms: rooms(&raw, "SELECT room_id FROM outbound_group_session")?,
        device_users: users(&raw, "SELECT DISTINCT user_id FROM device")?,
        identity_users: users(&raw, "SELECT user_id FROM identity")?,
        olm_hashes: column::<Vec<u8>>(&raw, "SELECT data FROM olm_hash")?
            .iter()
            .map(|data| rmp_serde::from_slice(data).map_err(StoreError::backend))
            .collect::<Result<_, _>>()?,
        key_requests: column(&raw, "SELECT request_id FROM key_requests")?
            .into_iter()
            .map(|id| text(id).map(OwnedTransactionId::from))
            .collect::<Result<_, _>>()?,
        secret_names: column(&raw, "SELECT DISTINCT secret_name FROM secrets_inbox")?
            .into_iter()
            .map(|name| text(name).map(SecretName::from))
            .collect::<Result<_, _>>()?,
        withheld: pairs(&raw, "SELECT room_id, session_id FROM direct_withheld_info")?
            .into_iter()
            .map(|(room, session)| Ok((room_id(room)?, text(session)?)))
            .collect::<Result<_, StoreError>>()?,
        room_settings: rooms(&raw, "SELECT room_id FROM room_settings")?,
        bundles: pairs(
            &raw,
            "SELECT room_id, sender_user_id FROM received_room_key_bundle",
        )?
        .into_iter()
        .map(|(room, user)| Ok((room_id(room)?, user_id(user)?)))
        .collect::<Result<_, StoreError>>()?,
        backups_downloaded: rooms(
            &raw,
            "SELECT room_id FROM room_key_backups_fully_downloaded",
        )?,
    })
}

#[derive(Debug, PartialEq, Eq)]
struct Census {
    kv: usize,
    sessions: usize,
    room_keys: usize,
    outbound: usize,
    devices: usize,
    identities: usize,
    hashes: usize,
    key_requests: usize,
    secrets: usize,
    withheld: usize,
    room_settings: usize,
    bundles: usize,
    backups_downloaded: usize,
    pending_bundles: usize,
    tracked: usize,
}

fn copied_kv(name: &str) -> bool {
    !matches!(name, "version" | "cipher") && !name.starts_with(SLIDING_SYNC_PREFIX)
}

type Failure = <SqliteCryptoStore as matrix_sdk_base::crypto::store::CryptoStore>::Error;

fn present<T>(found: Result<Option<T>, Failure>) -> Result<usize, StoreError> {
    found
        .map(|found| usize::from(found.is_some()))
        .map_err(StoreError::backend)
}

/// Counts what `store` holds under the keys listed from the original, so the copy can be checked
/// before the original is removed.
async fn census(store: &SqliteCryptoStore, listing: &Listing) -> Result<Census, StoreError> {
    let mut census = Census {
        kv: 0,
        sessions: 0,
        room_keys: store
            .get_inbound_group_sessions()
            .await
            .map_err(StoreError::backend)?
            .len(),
        outbound: 0,
        devices: 0,
        identities: 0,
        hashes: 0,
        key_requests: 0,
        secrets: 0,
        withheld: 0,
        room_settings: 0,
        bundles: 0,
        backups_downloaded: 0,
        pending_bundles: store
            .get_all_rooms_pending_key_bundles()
            .await
            .map_err(StoreError::backend)?
            .len(),
        tracked: store
            .load_tracked_users()
            .await
            .map_err(StoreError::backend)?
            .len(),
    };
    for name in listing.kv.iter().filter(|name| copied_kv(name)) {
        census.kv += present(store.get_custom_value(name).await)?;
    }
    for sender_key in &listing.sender_keys {
        census.sessions += store
            .get_sessions(sender_key)
            .await
            .map_err(StoreError::backend)?
            .map_or(0, |sessions| sessions.len());
    }
    for room in &listing.outbound_rooms {
        census.outbound += present(store.get_outbound_group_session(room).await)?;
    }
    for user in &listing.device_users {
        census.devices += store
            .get_user_devices(user)
            .await
            .map_err(StoreError::backend)?
            .len();
    }
    for user in &listing.identity_users {
        census.identities += present(store.get_user_identity(user).await)?;
    }
    for hash in &listing.olm_hashes {
        census.hashes += usize::from(
            store
                .is_message_known(hash)
                .await
                .map_err(StoreError::backend)?,
        );
    }
    for id in &listing.key_requests {
        census.key_requests += present(store.get_outgoing_secret_requests(id).await)?;
    }
    for name in &listing.secret_names {
        census.secrets += store
            .get_secrets_from_inbox(name)
            .await
            .map_err(StoreError::backend)?
            .len();
    }
    for (room, session) in &listing.withheld {
        census.withheld += present(store.get_withheld_info(room, session).await)?;
    }
    for room in &listing.room_settings {
        census.room_settings += present(store.get_room_settings(room).await)?;
    }
    for (room, user) in &listing.bundles {
        census.bundles += present(store.get_received_room_key_bundle_data(room, user).await)?;
    }
    for room in &listing.backups_downloaded {
        census.backups_downloaded += usize::from(
            store
                .has_downloaded_all_room_keys(room)
                .await
                .map_err(StoreError::backend)?,
        );
    }
    Ok(census)
}

async fn copy_crypto(source_dir: &Path, target_dir: &Path, key: &Key) -> Result<(), StoreError> {
    // Opening first brings an older schema up to date before its tables are listed.
    let source = SqliteCryptoStore::open_with_config(&config(source_dir, None))
        .await
        .map_err(StoreError::backend)?;
    let listing = list(&source_dir.join(CRYPTO_DATABASE))?;
    let target = SqliteCryptoStore::open_with_config(&config(target_dir, Some(key)))
        .await
        .map_err(StoreError::backend)?;

    // Also carries the account, cross-signing identity and backup keys, which live here too.
    for name in listing.kv.iter().filter(|name| copied_kv(name)) {
        if let Some(value) = source
            .get_custom_value(name)
            .await
            .map_err(StoreError::backend)?
        {
            target
                .set_custom_value(name, value)
                .await
                .map_err(StoreError::backend)?;
        }
    }

    // Reading Olm sessions needs the account loaded.
    let account = source
        .load_account()
        .await
        .map_err(StoreError::backend)?
        .ok_or(StoreError::Invalid("the crypto store has no account"))?;
    let expected = census(&source, &listing).await?;
    let mut changes = Changes::default();
    copy_sessions(&listing, &source, &mut changes).await?;
    copy_records(&listing, &source, &mut changes).await?;
    let tracked = source
        .load_tracked_users()
        .await
        .map_err(StoreError::backend)?;
    target
        .save_changes(changes)
        .await
        .map_err(StoreError::backend)?;
    let tracked: Vec<_> = tracked
        .iter()
        .map(|user| (user.user_id.as_ref(), user.dirty))
        .collect();
    target
        .save_tracked_users(&tracked)
        .await
        .map_err(StoreError::backend)?;

    let copied = target
        .load_account()
        .await
        .map_err(StoreError::backend)?
        .ok_or(StoreError::Invalid(
            "the encrypted crypto store has no account",
        ))?;
    let found = census(&target, &listing).await?;
    target.close().await.map_err(StoreError::backend)?;
    source.close().await.map_err(StoreError::backend)?;
    if copied.identity_keys() != account.identity_keys() || found != expected {
        tracing::error!(?expected, ?found, "the encrypted crypto store differs");
        return Err(StoreError::Invalid(
            "the encrypted crypto store does not match the original",
        ));
    }
    Ok(())
}

async fn copy_sessions(
    listing: &Listing,
    source: &SqliteCryptoStore,
    changes: &mut Changes,
) -> Result<(), StoreError> {
    for sender_key in &listing.sender_keys {
        if let Some(sessions) = source
            .get_sessions(sender_key)
            .await
            .map_err(StoreError::backend)?
        {
            changes.sessions.extend(sessions);
        }
    }
    changes.inbound_group_sessions = source
        .get_inbound_group_sessions()
        .await
        .map_err(StoreError::backend)?;
    for room in &listing.outbound_rooms {
        if let Some(session) = source
            .get_outbound_group_session(room)
            .await
            .map_err(StoreError::backend)?
        {
            changes.outbound_group_sessions.push(session);
        }
    }
    for user in &listing.device_users {
        let devices = source
            .get_user_devices(user)
            .await
            .map_err(StoreError::backend)?;
        changes.devices.new.extend(devices.into_values());
    }
    for user in &listing.identity_users {
        if let Some(identity) = source
            .get_user_identity(user)
            .await
            .map_err(StoreError::backend)?
        {
            changes.identities.new.push(identity);
        }
    }
    Ok(())
}

async fn copy_records(
    listing: &Listing,
    source: &SqliteCryptoStore,
    changes: &mut Changes,
) -> Result<(), StoreError> {
    changes.message_hashes.clone_from(&listing.olm_hashes);
    for id in &listing.key_requests {
        if let Some(request) = source
            .get_outgoing_secret_requests(id)
            .await
            .map_err(StoreError::backend)?
        {
            changes.key_requests.push(request);
        }
    }
    for secret_name in &listing.secret_names {
        for secret in source
            .get_secrets_from_inbox(secret_name)
            .await
            .map_err(StoreError::backend)?
        {
            changes.secrets.push(SecretsInboxItem {
                secret_name: secret_name.clone(),
                secret,
            });
        }
    }
    for (room, session) in &listing.withheld {
        if let Some(info) = source
            .get_withheld_info(room, session)
            .await
            .map_err(StoreError::backend)?
        {
            changes
                .withheld_session_info
                .entry(room.clone())
                .or_default()
                .insert(session.clone(), info);
        }
    }
    for room in &listing.room_settings {
        if let Some(settings) = source
            .get_room_settings(room)
            .await
            .map_err(StoreError::backend)?
        {
            changes.room_settings.insert(room.clone(), settings);
        }
    }
    for (room, user) in &listing.bundles {
        if let Some(bundle) = source
            .get_received_room_key_bundle_data(room, user)
            .await
            .map_err(StoreError::backend)?
        {
            changes.received_room_key_bundles.push(bundle);
        }
    }
    changes
        .room_key_backups_fully_downloaded
        .extend(listing.backups_downloaded.iter().cloned());
    for details in source
        .get_all_rooms_pending_key_bundles()
        .await
        .map_err(StoreError::backend)?
    {
        changes
            .rooms_pending_key_bundle
            .insert(details.room_id.clone(), Some(details));
    }
    Ok(())
}

async fn copy_state(source_dir: &Path, target_dir: &Path, key: &Key) -> Result<(), StoreError> {
    let source = SqliteStateStore::open_with_config(&config(source_dir, None))
        .await
        .map_err(StoreError::backend)?;
    let names = column::<Vec<u8>>(
        &read_only(&source_dir.join(matrix_sdk::STATE_STORE_DATABASE_NAME))?,
        "SELECT key FROM kv_blob",
    )?;
    let target = SqliteStateStore::open_with_config(&config(target_dir, Some(key)))
        .await
        .map_err(StoreError::backend)?;
    for name in &names {
        let Some(name) = name.strip_prefix(b"custom:") else {
            continue;
        };
        if name.starts_with(SLIDING_SYNC_PREFIX.as_bytes()) {
            continue;
        }
        if let Some(value) = source
            .get_custom_value(name)
            .await
            .map_err(StoreError::backend)?
        {
            target
                .set_custom_value_no_read(name, value)
                .await
                .map_err(StoreError::backend)?;
        }
    }
    target.close().await.map_err(StoreError::backend)?;
    source.close().await.map_err(StoreError::backend)
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{device_id, room_id, user_id};
    use matrix_sdk::{SqliteCryptoStore, SqliteStateStore};
    use matrix_sdk_base::StateStore as _;
    use matrix_sdk_base::crypto::olm::IdentityKeys;
    use matrix_sdk_base::crypto::olm::{Account, OlmMessageHash, SenderData};
    use matrix_sdk_base::crypto::store::CryptoStore as _;
    use matrix_sdk_base::crypto::store::types::{
        BackupDecryptionKey, Changes, PendingChanges, RoomSettings, SecretsInboxItem,
    };
    use matrix_sdk_base::crypto::{DeviceData, EncryptionSettings};

    use super::{config, store_dir};

    async fn plaintext_store(store_id: &str) -> IdentityKeys {
        let store = store_dir(store_id);
        let alice = Account::with_device_id(user_id!("@alice:example.org"), device_id!("ALICE"));
        let mut bob = Account::with_device_id(user_id!("@bob:example.org"), device_id!("BOB"));
        bob.generate_one_time_keys(1);
        let olm = alice
            .create_outbound_session(
                &DeviceData::from_account(&bob),
                &bob.signed_one_time_keys(),
                alice.device_keys(),
            )
            .unwrap();
        let room = room_id!("!room:example.org");
        let (outbound, inbound) = alice
            .create_group_session_pair(room, EncryptionSettings::default(), SenderData::unknown())
            .await
            .unwrap();
        inbound.mark_as_backed_up();

        let crypto = SqliteCryptoStore::open(&store, None).await.unwrap();
        let identity_keys = alice.identity_keys();
        let own_device = DeviceData::from_account(&alice);
        crypto
            .save_pending_changes(PendingChanges {
                account: Some(alice),
            })
            .await
            .unwrap();
        let mut changes = Changes {
            sessions: vec![olm],
            inbound_group_sessions: vec![inbound],
            outbound_group_sessions: vec![outbound],
            message_hashes: vec![OlmMessageHash {
                sender_key: "sender".to_owned(),
                hash: "hash".to_owned(),
            }],
            secrets: vec![SecretsInboxItem {
                secret_name: "m.megolm_backup.v1".into(),
                secret: "backup secret".to_owned().into(),
            }],
            backup_decryption_key: Some(BackupDecryptionKey::new()),
            backup_version: Some("1".to_owned()),
            next_batch_token: Some("batch".to_owned()),
            ..Changes::default()
        };
        changes.devices.new.push(own_device);
        changes.devices.new.push(DeviceData::from_account(&bob));
        changes.room_settings.insert(
            room.to_owned(),
            RoomSettings {
                only_allow_trusted_devices: true,
                ..RoomSettings::default()
            },
        );
        changes
            .room_key_backups_fully_downloaded
            .insert(room.to_owned());
        crypto.save_changes(changes).await.unwrap();
        crypto
            .save_tracked_users(&[(user_id!("@bob:example.org"), true)])
            .await
            .unwrap();
        crypto
            .set_custom_value("sable.kept", b"crypto".to_vec())
            .await
            .unwrap();
        crypto
            .set_custom_value("sliding_sync_store::pos", b"stale".to_vec())
            .await
            .unwrap();
        drop(crypto);

        let state = SqliteStateStore::open(&store, None).await.unwrap();
        state
            .set_custom_value_no_read(b"sable.reactions", b"state".to_vec())
            .await
            .unwrap();
        state
            .set_custom_value_no_read(b"sliding_sync_store::list", b"stale".to_vec())
            .await
            .unwrap();
        state.close().await.unwrap();

        let cache = std::path::Path::new(store_id).join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("matrix-sdk-media.sqlite3"), b"plaintext").unwrap();

        identity_keys
    }

    #[tokio::test]
    async fn a_plaintext_store_is_encrypted_without_losing_keys() {
        let directory = tempfile::tempdir().unwrap();
        let store_id = directory.path().to_str().unwrap();
        let identity_keys = plaintext_store(store_id).await;

        let key = super::account_key(store_id).await.unwrap().unwrap();
        assert_eq!(super::saved_key(store_id).unwrap(), Some(key));
        assert!(!directory.path().join("store.old").exists());
        assert!(!directory.path().join("store.new").exists());
        assert!(!directory.path().join("cache").exists());

        let store = store_dir(store_id);
        SqliteCryptoStore::open(&store, None)
            .await
            .unwrap()
            .load_account()
            .await
            .unwrap_err();
        let crypto = SqliteCryptoStore::open_with_config(&config(&store, Some(&key)))
            .await
            .unwrap();
        let account = crypto.load_account().await.unwrap().unwrap();
        assert_eq!(account.identity_keys(), identity_keys);
        let devices = crypto
            .get_user_devices(user_id!("@bob:example.org"))
            .await
            .unwrap();
        assert_eq!(devices.len(), 1);
        let bob = devices.values().next().unwrap();
        assert_eq!(
            crypto
                .get_sessions(&bob.curve25519_key().unwrap().to_base64())
                .await
                .unwrap()
                .unwrap()
                .len(),
            1
        );
        let room_keys = crypto.get_inbound_group_sessions().await.unwrap();
        assert_eq!(room_keys.len(), 1);
        assert!(room_keys[0].backed_up());
        let room = room_id!("!room:example.org");
        assert!(
            crypto
                .get_outbound_group_session(room)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            crypto
                .get_room_settings(room)
                .await
                .unwrap()
                .unwrap()
                .only_allow_trusted_devices
        );
        assert!(crypto.has_downloaded_all_room_keys(room).await.unwrap());
        assert!(
            crypto
                .is_message_known(&OlmMessageHash {
                    sender_key: "sender".to_owned(),
                    hash: "hash".to_owned(),
                })
                .await
                .unwrap()
        );
        assert_eq!(
            crypto
                .get_secrets_from_inbox(&"m.megolm_backup.v1".into())
                .await
                .unwrap()
                .len(),
            1
        );
        let backup = crypto.load_backup_keys().await.unwrap();
        assert!(backup.decryption_key.is_some());
        assert_eq!(backup.backup_version.as_deref(), Some("1"));
        assert_eq!(
            crypto.next_batch_token().await.unwrap().as_deref(),
            Some("batch")
        );
        assert_eq!(crypto.load_tracked_users().await.unwrap().len(), 1);
        assert_eq!(
            crypto.get_custom_value("sable.kept").await.unwrap(),
            Some(b"crypto".to_vec())
        );
        assert!(
            crypto
                .get_custom_value("sliding_sync_store::pos")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn only_custom_values_survive_in_the_state_store() {
        let directory = tempfile::tempdir().unwrap();
        let store_id = directory.path().to_str().unwrap();
        plaintext_store(store_id).await;

        let key = super::account_key(store_id).await.unwrap().unwrap();
        let state = SqliteStateStore::open_with_config(&config(store_dir(store_id), Some(&key)))
            .await
            .unwrap();
        assert_eq!(
            state.get_custom_value(b"sable.reactions").await.unwrap(),
            Some(b"state".to_vec())
        );
        assert!(
            state
                .get_custom_value(b"sliding_sync_store::list")
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_copy_that_fails_leaves_the_store_as_it_was() {
        let directory = tempfile::tempdir().unwrap();
        let store_id = directory.path().to_str().unwrap();
        let identity_keys = plaintext_store(store_id).await;
        rusqlite::Connection::open(store_dir(store_id).join(super::CRYPTO_DATABASE))
            .unwrap()
            .execute("UPDATE inbound_group_session SET data = x'00'", [])
            .unwrap();

        assert!(super::account_key(store_id).await.unwrap().is_none());
        assert!(super::saved_key(store_id).unwrap().is_none());
        assert!(!directory.path().join("store.new").exists());
        let account = SqliteCryptoStore::open(store_dir(store_id), None)
            .await
            .unwrap()
            .load_account()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(account.identity_keys(), identity_keys);
    }

    #[tokio::test]
    async fn unsent_messages_put_off_the_encryption() {
        use matrix_sdk::ruma::events::AnyMessageLikeEventContent;
        use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
        use matrix_sdk_base::store::{QueuedRequestKind, SerializableEventContent};

        let directory = tempfile::tempdir().unwrap();
        let store_id = directory.path().to_str().unwrap();
        plaintext_store(store_id).await;
        let state = SqliteStateStore::open(store_dir(store_id), None)
            .await
            .unwrap();
        let content =
            AnyMessageLikeEventContent::RoomMessage(RoomMessageEventContent::text_plain("pending"));
        state
            .save_send_queue_request(
                room_id!("!room:example.org"),
                "txn".into(),
                matrix_sdk::ruma::MilliSecondsSinceUnixEpoch::now(),
                QueuedRequestKind::Event {
                    content: SerializableEventContent::new(&content).unwrap(),
                    sticky_duration: None,
                },
                0,
            )
            .await
            .unwrap();
        state.close().await.unwrap();

        assert!(super::account_key(store_id).await.unwrap().is_none());
        assert!(super::saved_key(store_id).unwrap().is_none());
    }

    #[tokio::test]
    async fn a_new_store_is_keyed_before_it_is_created() {
        let directory = tempfile::tempdir().unwrap();
        let store_id = directory.path().to_str().unwrap();

        assert!(super::saved_key(store_id).unwrap().is_none());
        let key = super::account_key(store_id).await.unwrap().unwrap();
        assert_eq!(super::saved_key(store_id).unwrap(), Some(key));
        assert_eq!(super::account_key(store_id).await.unwrap(), Some(key));
    }

    #[tokio::test]
    async fn an_interrupted_encryption_resumes() {
        let directory = tempfile::tempdir().unwrap();
        let store_id = directory.path().to_str().unwrap();
        plaintext_store(store_id).await;
        let unfinished = directory.path().join("store.new");
        std::fs::create_dir_all(&unfinished).unwrap();
        std::fs::write(unfinished.join("leftover"), b"").unwrap();

        let key = super::account_key(store_id).await.unwrap().unwrap();
        assert!(!unfinished.exists());
        assert!(
            SqliteCryptoStore::open_with_config(&config(store_dir(store_id), Some(&key)))
                .await
                .unwrap()
                .load_account()
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn a_swap_cut_short_is_finished_on_the_next_open() {
        let directory = tempfile::tempdir().unwrap();
        let store_id = directory.path().to_str().unwrap();
        let key = super::account_key(store_id).await.unwrap().unwrap();
        let store = store_dir(store_id);
        std::fs::rename(&store, directory.path().join("store.new")).unwrap();
        std::fs::create_dir_all(directory.path().join("store.old")).unwrap();
        std::fs::create_dir_all(directory.path().join("cache")).unwrap();

        assert_eq!(super::saved_key(store_id).unwrap(), Some(key));
        assert!(store.join(super::MARKER).exists());
        assert!(!directory.path().join("store.old").exists());
        assert!(!directory.path().join("cache").exists());
    }
}
