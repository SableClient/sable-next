use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use base64::Engine as _;

use crate::store::StoreError;

pub(crate) const KEY_SIZE: usize = 32;

pub(crate) type Key = [u8; KEY_SIZE];

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
        .and_then(|keys| keys.get(id).copied())
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
    let key: Key = backend()?
        .get(&id)?
        .ok_or(StoreError::KeyMissing)?
        .try_into()
        .map_err(|_| StoreError::Invalid("a saved key has the wrong length"))?;
    remember(&id, key);
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
    let mut key = [0u8; KEY_SIZE];
    getrandom::fill(&mut key).map_err(StoreError::backend)?;
    let mut id = [0u8; 16];
    getrandom::fill(&mut id).map_err(StoreError::backend)?;
    let id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(id);

    // Saved first, so a reference never names a key that was not stored.
    backend()?.set(&id, &key)?;
    if !write_reference(id_file, &id, replace)? {
        if let Err(error) = backend()?.delete(&id) {
            tracing::warn!("could not delete an unused key: {error}");
        }
        return load(id_file)?.ok_or(StoreError::KeyMissing);
    }
    remember(&id, key);
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

    pub(super) struct Keyring {
        store: Arc<CredentialStore>,
        service: String,
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
            let store: Arc<CredentialStore> = {
                let _ = access_group;
                zbus_secret_service_keyring_store::Store::new()
                    .map_err(|error| unavailable(&error))?
            };
            let keyring = Self { store, service };
            #[cfg(not(any(target_os = "ios", target_os = "macos", target_os = "windows")))]
            keyring.probe()?;
            Ok(keyring)
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
            #[cfg(not(target_os = "ios"))]
            let modifiers = HashMap::new();
            self.store
                .build(&self.service, name, Some(&modifiers))
                .map_err(failure)
        }
    }

    impl SecretBackend for Keyring {
        fn get(&self, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
            match self.entry(name)?.get_secret() {
                Ok(secret) => Ok(Some(secret)),
                Err(Error::NoEntry) => Ok(None),
                Err(error) => Err(failure(error)),
            }
        }

        fn set(&self, name: &str, secret: &[u8]) -> Result<(), StoreError> {
            self.entry(name)?.set_secret(secret).map_err(failure)
        }

        fn delete(&self, name: &str) -> Result<(), StoreError> {
            match self.entry(name)?.delete_credential() {
                Ok(()) | Err(Error::NoEntry) => Ok(()),
                Err(error) => Err(failure(error)),
            }
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

#[cfg(test)]
mod tests {
    #[test]
    fn a_key_is_found_again_from_its_reference() {
        let directory = tempfile::tempdir().unwrap();
        let reference = directory.path().join("key");

        assert!(super::load(&reference).unwrap().is_none());
        let key = super::load_or_create(&reference).unwrap();
        assert_eq!(super::load(&reference).unwrap(), Some(key));
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
