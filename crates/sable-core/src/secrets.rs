use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;

use crate::store::StoreError;

pub(crate) const KEY_SIZE: usize = 32;

pub(crate) type Key = zeroize::Zeroizing<[u8; KEY_SIZE]>;

/// Every call may block on IPC.
pub trait SecretBackend: Send + Sync {
    /// # Errors
    /// When the store cannot be reached.
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, StoreError>;
    /// # Errors
    /// When the store cannot be reached or refuses the write.
    fn set(&self, name: &str, secret: &[u8]) -> Result<(), StoreError>;
    /// # Errors
    /// When the store cannot be reached. A missing secret is not an error.
    fn delete(&self, name: &str) -> Result<(), StoreError>;
}

static BACKEND: OnceLock<Box<dyn SecretBackend>> = OnceLock::new();
static CACHE: Mutex<Option<HashMap<String, Key>>> = Mutex::new(None);

/// Only the first backend installed in a process is used.
pub fn install(backend: Box<dyn SecretBackend>) {
    let _ = BACKEND.set(backend);
}

fn backend() -> Result<&'static dyn SecretBackend, StoreError> {
    #[cfg(test)]
    let backend = Some(BACKEND.get_or_init(|| Box::new(MemorySecrets::default())));
    #[cfg(not(test))]
    let backend = BACKEND.get();
    backend.map(AsRef::as_ref).ok_or_else(|| {
        StoreError::SecretsUnavailable("no credential store is installed".to_owned())
    })
}

fn cached(id: &str) -> Option<Key> {
    CACHE
        .lock()
        .ok()?
        .as_ref()
        .and_then(|keys| keys.get(id).cloned())
}

fn remember(id: &str, key: Key) {
    if let Ok(mut cache) = CACHE.lock() {
        cache.get_or_insert_default().insert(id.to_owned(), key);
    }
}

fn read_id(id_file: &Path) -> Result<Option<String>, StoreError> {
    match std::fs::read_to_string(id_file) {
        Ok(id) if !id.trim().is_empty() => Ok(Some(id.trim().to_owned())),
        Ok(_) => Err(StoreError::Invalid("a key reference is empty")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(StoreError::Path {
            path: id_file.to_owned(),
            source,
        }),
    }
}

/// The key's name lives in `id_file`, beside the data it protects, so two data directories never
/// share a key. [`StoreError::KeyMissing`] means the reference outlived its key, as after a
/// restore onto another device.
pub(crate) fn load(id_file: &Path) -> Result<Option<Key>, StoreError> {
    let Some(id) = read_id(id_file)? else {
        return Ok(None);
    };
    if let Some(key) = cached(&id) {
        return Ok(Some(key));
    }
    let saved = zeroize::Zeroizing::new(backend()?.get(&id)?.ok_or(StoreError::KeyMissing)?);
    let key = Key::new(
        saved
            .as_slice()
            .try_into()
            .map_err(|_| StoreError::Invalid("a saved key has the wrong length"))?,
    );
    remember(&id, key.clone());
    Ok(Some(key))
}

/// When two processes create the key at once, the first reference written wins and the other
/// adopts its key. A reference whose key is gone is replaced: nothing it sealed opens anymore.
pub(crate) fn load_or_create(id_file: &Path) -> Result<Key, StoreError> {
    let replace = match load(id_file) {
        Ok(Some(key)) => return Ok(key),
        Ok(None) => false,
        Err(StoreError::KeyMissing) => true,
        Err(error) => return Err(error),
    };
    let mut key = Key::new([0u8; KEY_SIZE]);
    getrandom::fill(key.as_mut_slice()).map_err(StoreError::backend)?;
    let mut id = [0u8; 16];
    getrandom::fill(&mut id).map_err(StoreError::backend)?;
    let id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(id);

    // Saved first, so a reference never names a key that was not stored.
    backend()?.set(&id, key.as_slice())?;
    if !write_reference(id_file, &id, replace)? {
        if let Err(error) = backend()?.delete(&id) {
            tracing::warn!("could not delete an unused key: {error}");
        }
        return load(id_file)?.ok_or(StoreError::KeyMissing);
    }
    remember(&id, key.clone());
    Ok(key)
}

#[cfg_attr(not(unix), expect(unused_mut, reason = "creation modes are unix only"))]
fn write_reference(id_file: &Path, id: &str, replace: bool) -> Result<bool, StoreError> {
    use std::io::Write;

    let directory = id_file
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(directory)?;
    let mut builder = tempfile::Builder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o600));
    }
    let mut temporary = builder.tempfile_in(directory)?;
    temporary.write_all(id.as_bytes())?;
    temporary.as_file().sync_all()?;
    let persisted = if replace {
        temporary.persist(id_file)
    } else {
        temporary.persist_noclobber(id_file)
    };
    match persisted {
        Ok(_) => Ok(true),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(StoreError::backend(error)),
    }
}

pub(crate) fn forget(id_file: &Path) {
    let id = match read_id(id_file) {
        Ok(Some(id)) => id,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!("could not read a key reference: {error}");
            return;
        }
    };
    if let Ok(mut cache) = CACHE.lock()
        && let Some(keys) = cache.as_mut()
    {
        keys.remove(&id);
    }
    if let Err(error) = backend().and_then(|backend| backend.delete(&id)) {
        tracing::warn!("could not delete a saved key: {error}");
    }
    if let Err(error) = std::fs::remove_file(id_file)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("could not remove a key reference: {error}");
    }
}

#[cfg(test)]
#[derive(Default)]
struct MemorySecrets(Mutex<HashMap<String, Vec<u8>>>);

#[cfg(test)]
impl SecretBackend for MemorySecrets {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self
            .0
            .lock()
            .map_err(|_| StoreError::Invalid("the secret map is poisoned"))?
            .get(name)
            .cloned())
    }

    fn set(&self, name: &str, secret: &[u8]) -> Result<(), StoreError> {
        self.0
            .lock()
            .map_err(|_| StoreError::Invalid("the secret map is poisoned"))?
            .insert(name.to_owned(), secret.to_vec());
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), StoreError> {
        self.0
            .lock()
            .map_err(|_| StoreError::Invalid("the secret map is poisoned"))?
            .remove(name);
        Ok(())
    }
}

#[cfg(not(target_os = "android"))]
mod keyring {
    use std::collections::HashMap;
    use std::sync::Arc;

    use keyring_core::{CredentialStore, Error};

    use super::SecretBackend;
    use crate::store::StoreError;

    #[derive(Clone)]
    pub(super) struct Keyring {
        store: Arc<CredentialStore>,
        service: String,
        #[cfg(not(any(target_os = "ios", target_os = "macos", target_os = "windows")))]
        collection: Option<String>,
    }

    /// oo7 can lose a race and never answer, which would hang whatever waits on the key.
    #[cfg(not(any(target_os = "ios", target_os = "macos", target_os = "windows")))]
    fn answered<T: Send + 'static>(
        work: impl FnOnce() -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let _ = sender.send(work());
        });
        receiver.recv_timeout(TIMEOUT).unwrap_or_else(|_| {
            Err(StoreError::SecretsUnavailable(
                "the Secret Service did not answer".to_owned(),
            ))
        })
    }

    #[cfg(any(target_os = "ios", target_os = "macos", target_os = "windows"))]
    fn answered<T>(work: impl FnOnce() -> Result<T, StoreError>) -> Result<T, StoreError> {
        work()
    }

    /// `KWallet` serves its wallets without a `default` alias, where the store would write.
    #[cfg(not(any(target_os = "ios", target_os = "macos", target_os = "windows")))]
    fn collection_without_default_alias() -> Option<String> {
        use secret_service::{EncryptionType, blocking::SecretService};

        let service = SecretService::connect(EncryptionType::Plain).ok()?;
        if service.get_default_collection().is_ok() {
            return None;
        }
        service.get_any_collection().ok()?.get_label().ok()
    }

    fn unavailable(error: &Error) -> StoreError {
        StoreError::SecretsUnavailable(error.to_string())
    }

    fn failure(error: Error) -> StoreError {
        match error {
            Error::NoStorageAccess(_) => unavailable(&error),
            error => StoreError::backend(error),
        }
    }

    impl Keyring {
        pub(super) fn open(
            service: String,
            access_group: Option<&str>,
        ) -> Result<Self, StoreError> {
            #[cfg(target_os = "ios")]
            let store: Arc<CredentialStore> = {
                let configuration: HashMap<&str, &str> = access_group
                    .map(|group| ("access-group", group))
                    .into_iter()
                    .collect();
                apple_native_keyring_store::protected::Store::new_with_configuration(&configuration)
                    .map_err(|error| unavailable(&error))?
            };
            #[cfg(target_os = "macos")]
            let store: Arc<CredentialStore> = {
                let _ = access_group;
                apple_native_keyring_store::keychain::Store::new()
                    .map_err(|error| unavailable(&error))?
            };
            #[cfg(target_os = "windows")]
            let store: Arc<CredentialStore> = {
                let _ = access_group;
                windows_native_keyring_store::Store::new().map_err(|error| unavailable(&error))?
            };
            #[cfg(not(any(target_os = "ios", target_os = "macos", target_os = "windows")))]
            return {
                let _ = access_group;
                answered(move || {
                    let store: Arc<CredentialStore> =
                        zbus_secret_service_keyring_store::Store::new()
                            .map_err(|error| unavailable(&error))?;
                    let keyring = Self {
                        store,
                        service,
                        collection: collection_without_default_alias(),
                    };
                    keyring.probe()?;
                    Ok(keyring)
                })
            };
            #[cfg(any(target_os = "ios", target_os = "macos", target_os = "windows"))]
            Ok(Self { store, service })
        }

        /// A Secret Service can answer reads and still refuse every write, as one started without
        /// a default collection does, so the first login save would fail instead.
        #[cfg(not(any(target_os = "ios", target_os = "macos", target_os = "windows")))]
        fn probe(&self) -> Result<(), StoreError> {
            let mut name = [0u8; 8];
            getrandom::fill(&mut name).map_err(StoreError::backend)?;
            let probe = self.entry(&format!("probe-{}", u64::from_le_bytes(name)))?;
            probe
                .set_secret(b"probe")
                .map_err(|error| unavailable(&error))?;
            match probe.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(error) => Err(unavailable(&error)),
            }
        }

        fn entry(&self, name: &str) -> Result<keyring_core::Entry, StoreError> {
            // The notification service extension reads while the device is locked.
            #[cfg(target_os = "ios")]
            let modifiers = HashMap::from([("access-policy", "AfterFirstUnlockThisDeviceOnly")]);
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            let modifiers = HashMap::new();
            #[cfg(not(any(target_os = "ios", target_os = "macos", target_os = "windows")))]
            let modifiers: HashMap<&str, &str> = self
                .collection
                .as_deref()
                .map(|label| ("target", label))
                .into_iter()
                .collect();
            self.store
                .build(&self.service, name, Some(&modifiers))
                .map_err(failure)
        }
    }

    impl SecretBackend for Keyring {
        fn get(&self, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            let (keyring, name) = (self.clone(), name.to_owned());
            answered(move || match keyring.entry(&name)?.get_secret() {
                Ok(secret) => Ok(Some(secret)),
                Err(Error::NoEntry) => Ok(None),
                Err(error) => Err(failure(error)),
            })
        }

        fn set(&self, name: &str, secret: &[u8]) -> Result<(), StoreError> {
            let (keyring, name) = (self.clone(), name.to_owned());
            let secret = zeroize::Zeroizing::new(secret.to_vec());
            answered(move || keyring.entry(&name)?.set_secret(&secret).map_err(failure))
        }

        fn delete(&self, name: &str) -> Result<(), StoreError> {
            let (keyring, name) = (self.clone(), name.to_owned());
            answered(move || match keyring.entry(&name)?.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(error) => Err(failure(error)),
            })
        }
    }
}

/// `access_group` shares the items with the iOS notification service extension.
///
/// # Errors
/// [`StoreError::SecretsUnavailable`] when the OS has no usable credential store.
#[cfg(not(target_os = "android"))]
pub fn install_os_keyring(service: String, access_group: Option<&str>) -> Result<(), StoreError> {
    install(Box::new(keyring::Keyring::open(service, access_group)?));
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios", target_family = "wasm")))]
struct FileSecrets(std::path::PathBuf);

#[cfg(not(any(target_os = "android", target_os = "ios", target_family = "wasm")))]
impl SecretBackend for FileSecrets {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
        match std::fs::read(self.0.join(name)) {
            Ok(secret) => Ok(Some(secret)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn set(&self, name: &str, secret: &[u8]) -> Result<(), StoreError> {
        std::fs::create_dir_all(&self.0)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o700))?;
        }
        crate::store::write_atomic_private(&self.0.join(name), secret)?;
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), StoreError> {
        match std::fs::remove_file(self.0.join(name)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
}

/// Stores keys in owner-only files under `directory/secrets`.
#[cfg(not(any(target_os = "android", target_os = "ios", target_family = "wasm")))]
pub fn install_file_secrets(directory: &Path) {
    install(Box::new(FileSecrets(directory.join("secrets"))));
}

/// Falls back to owner-only files under `directory` when the OS has no usable keyring. The first
/// start picks the store for good: leaving a keyring would orphan the keys already in it.
/// `SABLE_SECRET_STORE=files` overrides that.
///
/// # Errors
/// [`StoreError::SecretsUnavailable`] when the keyring this directory uses is unavailable.
#[cfg(not(any(target_os = "android", target_os = "ios", target_family = "wasm")))]
pub fn install_os_keyring_or_files(service: String, directory: &Path) -> Result<(), StoreError> {
    let choice = directory.join("secret-store");
    let chosen = match std::fs::read_to_string(&choice) {
        Ok(chosen) => Some(chosen),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let files = || Box::new(FileSecrets(directory.join("secrets")));
    if chosen.as_deref() == Some("files") {
        install(files());
        return Ok(());
    }
    if std::env::var_os("SABLE_SECRET_STORE").is_some_and(|store| store == "files") {
        if chosen.is_some() {
            tracing::warn!("leaving the system keyring for SABLE_SECRET_STORE=files");
        }
        keep_secrets_in_files(directory)?;
        install(files());
        return Ok(());
    }
    let keyring = match keyring::Keyring::open(service, None) {
        Ok(keyring) => keyring,
        Err(error) if chosen.is_none() => {
            tracing::warn!("no usable system keyring, keeping keys in files instead: {error}");
            keep_secrets_in_files(directory)?;
            install(files());
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    if chosen.is_none() {
        std::fs::create_dir_all(directory)?;
        crate::store::write_atomic(&choice, b"keyring")?;
    }
    install(Box::new(keyring));
    Ok(())
}

/// Makes [`install_os_keyring_or_files`] keep the keys under `directory` in files from now on.
///
/// # Errors
/// When the choice cannot be written.
#[cfg(not(any(target_os = "android", target_os = "ios", target_family = "wasm")))]
pub fn keep_secrets_in_files(directory: &Path) -> Result<(), StoreError> {
    std::fs::create_dir_all(directory)?;
    crate::store::write_atomic(&directory.join("secret-store"), b"files")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_key_is_found_again_from_its_reference() {
        let directory = tempfile::tempdir().unwrap();
        let reference = directory.path().join("key");

        assert!(super::load(&reference).unwrap().is_none());
        let key = super::load_or_create(&reference).unwrap();
        assert_eq!(super::load(&reference).unwrap(), Some(key.clone()));
        assert_eq!(super::load_or_create(&reference).unwrap(), key);

        super::forget(&reference);
        assert!(super::load(&reference).unwrap().is_none());
    }

    #[test]
    fn a_key_created_elsewhere_first_is_adopted() {
        let directory = tempfile::tempdir().unwrap();
        let reference = directory.path().join("key");
        let theirs = super::load_or_create(&reference).unwrap();
        let id = std::fs::read_to_string(&reference).unwrap();

        assert!(!super::write_reference(&reference, "late", false).unwrap());
        assert_eq!(std::fs::read_to_string(&reference).unwrap(), id);
        assert_eq!(super::load_or_create(&reference).unwrap(), theirs);
    }

    #[test]
    fn a_reference_without_its_key_is_reported() {
        let directory = tempfile::tempdir().unwrap();
        let reference = directory.path().join("key");
        std::fs::write(&reference, "never-saved").unwrap();

        assert!(matches!(
            super::load(&reference),
            Err(crate::store::StoreError::KeyMissing)
        ));
        let key = super::load_or_create(&reference).unwrap();
        assert_eq!(super::load(&reference).unwrap(), Some(key));
    }
}
