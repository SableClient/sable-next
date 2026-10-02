use async_trait::async_trait;
use matrix_sdk::{SendOutsideWasm, SyncOutsideWasm};

/// The core decides *what* to persist, the carrier *where*: a file natively,
/// `IndexedDB` in a worker, which has no `localStorage`.
#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
pub trait SessionStore: SendOutsideWasm + SyncOutsideWasm + 'static {
    async fn load(&self) -> Result<Option<Vec<u8>>, String>;
    async fn save(&self, bytes: Vec<u8>) -> Result<(), String>;
    async fn clear(&self) -> Result<(), String>;
}

#[cfg(not(target_family = "wasm"))]
pub struct FileSessionStore {
    path: std::path::PathBuf,
    owner: Option<std::sync::Arc<std::fs::File>>,
}

#[cfg(not(target_family = "wasm"))]
pub struct ExclusiveFileSessionStore {
    directory: std::path::PathBuf,
    store: tokio::sync::Mutex<Option<std::sync::Arc<FileSessionStore>>>,
}

#[cfg(not(target_family = "wasm"))]
impl ExclusiveFileSessionStore {
    #[must_use]
    pub fn new(directory: impl Into<std::path::PathBuf>) -> Self {
        Self {
            directory: directory.into(),
            store: tokio::sync::Mutex::new(None),
        }
    }

    async fn store(&self) -> Result<std::sync::Arc<FileSessionStore>, String> {
        let mut store = self.store.lock().await;
        if let Some(store) = store.as_ref() {
            return Ok(store.clone());
        }
        let directory = self.directory.clone();
        let opened = tokio::task::spawn_blocking(move || FileSessionStore::exclusive(directory))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
        let opened = std::sync::Arc::new(opened);
        *store = Some(opened.clone());
        Ok(opened)
    }
}

#[cfg(not(target_family = "wasm"))]
#[async_trait]
impl SessionStore for ExclusiveFileSessionStore {
    async fn load(&self) -> Result<Option<Vec<u8>>, String> {
        self.store().await?.load().await
    }
    async fn save(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.store().await?.save(bytes).await
    }
    async fn clear(&self) -> Result<(), String> {
        self.store().await?.clear().await
    }
}

#[cfg(not(target_family = "wasm"))]
impl FileSessionStore {
    pub fn new(data_dir: impl Into<std::path::PathBuf>) -> Self {
        Self {
            path: data_dir.into().join("session.json"),
            owner: None,
        }
    }

    /// Own credential refreshes until this store is dropped. Foreground startup
    /// waits for any cold notification already using the saved login.
    ///
    /// # Errors
    /// Returns an error if the private directory or ownership lock cannot be opened.
    pub fn exclusive(data_dir: impl Into<std::path::PathBuf>) -> std::io::Result<Self> {
        let store = Self::new(data_dir);
        let owner = store.open_owner()?;
        owner.lock()?;
        Ok(Self {
            owner: Some(std::sync::Arc::new(owner)),
            ..store
        })
    }

    pub(crate) fn try_exclusive(
        data_dir: impl Into<std::path::PathBuf>,
    ) -> std::io::Result<Option<Self>> {
        let store = Self::new(data_dir);
        let owner = store.open_owner()?;
        match owner.try_lock() {
            Ok(()) => Ok(Some(Self {
                owner: Some(std::sync::Arc::new(owner)),
                ..store
            })),
            Err(std::fs::TryLockError::WouldBlock) => Ok(None),
            Err(std::fs::TryLockError::Error(error)) => Err(error),
        }
    }

    fn open_owner(&self) -> std::io::Result<std::fs::File> {
        self.prepare_directory()?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(self.path.with_extension("lock"))
    }

    fn prepare_directory(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        Ok(())
    }

    fn read_blocking(&self) -> std::io::Result<Vec<u8>> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))?;
            if let Some(parent) = self.path.parent() {
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        std::fs::read(&self.path)
    }

    pub(crate) fn save_blocking(&self, bytes: &[u8]) -> Result<(), String> {
        use std::io::Write;
        self.prepare_directory().map_err(|e| e.to_string())?;
        let parent = self.path.parent().ok_or("session directory is missing")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temporary.write_all(bytes).map_err(|e| e.to_string())?;
        temporary.as_file().sync_all().map_err(|e| e.to_string())?;
        temporary.persist(&self.path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(not(target_family = "wasm"))]
#[async_trait]
impl SessionStore for FileSessionStore {
    async fn load(&self) -> Result<Option<Vec<u8>>, String> {
        let reader = Self {
            path: self.path.clone(),
            owner: self.owner.clone(),
        };
        tokio::task::spawn_blocking(move || match reader.read_blocking() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn save(&self, bytes: Vec<u8>) -> Result<(), String> {
        let writer = Self {
            path: self.path.clone(),
            owner: self.owner.clone(),
        };
        tokio::task::spawn_blocking(move || writer.save_blocking(&bytes))
            .await
            .map_err(|e| e.to_string())?
    }

    async fn clear(&self) -> Result<(), String> {
        match tokio::fs::remove_file(&self.path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[derive(Default)]
pub struct MemorySessionStore {
    bytes: std::sync::Mutex<Option<Vec<u8>>>,
}

#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
impl SessionStore for MemorySessionStore {
    async fn load(&self) -> Result<Option<Vec<u8>>, String> {
        Ok(self
            .bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }

    async fn save(&self, bytes: Vec<u8>) -> Result<(), String> {
        *self
            .bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(bytes);
        Ok(())
    }

    async fn clear(&self) -> Result<(), String> {
        *self
            .bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        Ok(())
    }
}

#[cfg(all(test, not(target_family = "wasm")))]
mod tests {
    use super::{FileSessionStore, SessionStore};

    #[tokio::test]
    async fn exclusive_store_retries_after_an_unavailable_directory_without_losing_credentials() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("data");
        std::fs::write(&directory, b"blocked").unwrap();
        let store = super::ExclusiveFileSessionStore::new(&directory);
        store.load().await.unwrap_err();
        std::fs::remove_file(&directory).unwrap();
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("session.json"), b"saved session").unwrap();
        assert_eq!(store.load().await.unwrap(), Some(b"saved session".to_vec()));
        assert!(
            FileSessionStore::try_exclusive(&directory)
                .unwrap()
                .is_none()
        );
        drop(store);
        assert!(
            FileSessionStore::try_exclusive(&directory)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn credential_ownership_excludes_other_clients_until_released() {
        let dir = tempfile::tempdir().unwrap();
        let owner = FileSessionStore::exclusive(dir.path()).unwrap();
        assert!(
            FileSessionStore::try_exclusive(dir.path())
                .unwrap()
                .is_none()
        );
        drop(owner);
        assert!(
            FileSessionStore::try_exclusive(dir.path())
                .unwrap()
                .is_some()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn saved_credentials_are_private_and_existing_permissions_are_repaired() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("account");
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let file = root.join("session.json");
        std::fs::write(&file, b"old").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        let store = FileSessionStore::new(&root);
        assert_eq!(store.load().await.unwrap(), Some(b"old".to_vec()));
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        store.save(b"new".to_vec()).await.unwrap();
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        store.save_blocking(b"refreshed").unwrap();
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[tokio::test]
    async fn a_saved_session_replaces_the_previous_file_without_leftovers() {
        let dir = std::env::temp_dir().join(format!("sable-store-test-{}", std::process::id()));
        let store = FileSessionStore::new(&dir);

        store.save(b"first".to_vec()).await.unwrap();
        store.save(b"second".to_vec()).await.unwrap();
        assert_eq!(store.load().await, Ok(Some(b"second".to_vec())));
        assert!(!dir.join("session.tmp").exists());

        store.clear().await.unwrap();
        assert_eq!(store.load().await, Ok(None));

        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }
}
