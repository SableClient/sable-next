use async_trait::async_trait;
use matrix_sdk::{SendOutsideWasm, SyncOutsideWasm};

use crate::errors::Cause;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("{}: {source}", path.display())]
    Path {
        path: std::path::PathBuf,
        source: std::io::Error,
    },
    #[error("{0}")]
    Invalid(&'static str),
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("the system keyring is unavailable: {0}")]
    SecretsUnavailable(String),
    #[error("a saved key is missing from the system keyring")]
    KeyMissing,
    #[error(transparent)]
    Backend(Cause),
}

impl StoreError {
    pub(crate) fn backend(error: impl crate::errors::Source) -> Self {
        Self::Backend(Box::new(error))
    }
}

/// Atomically and durably replaces a file, retaining its permissions or the normal creation mode.
///
/// # Errors
/// Returns an error if the temporary file cannot be written or published.
#[cfg(not(target_family = "wasm"))]
pub fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    publish(path, bytes, 0o666)
}

/// Like [`write_atomic`], but a newly created file is readable by its owner only.
///
/// # Errors
/// Returns an error if the temporary file cannot be written or published.
#[cfg(not(target_family = "wasm"))]
pub fn write_atomic_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    publish(path, bytes, 0o600)
}

#[cfg(not(target_family = "wasm"))]
#[cfg_attr(
    not(unix),
    expect(unused_variables, unused_mut, reason = "creation modes are unix only")
)]
fn publish(path: &std::path::Path, bytes: &[u8], mode: u32) -> std::io::Result<()> {
    use std::io::Write;

    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let mut builder = tempfile::Builder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(mode));
    }
    let mut temporary = builder.tempfile_in(parent)?;
    match std::fs::metadata(path) {
        Ok(metadata) => temporary
            .as_file()
            .set_permissions(metadata.permissions())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
pub trait SessionStore: SendOutsideWasm + SyncOutsideWasm + 'static {
    async fn load(&self) -> Result<Option<Vec<u8>>, StoreError>;
    async fn save(&self, bytes: Vec<u8>) -> Result<(), StoreError>;
    async fn clear(&self) -> Result<(), StoreError>;
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

    async fn store(&self) -> Result<std::sync::Arc<FileSessionStore>, StoreError> {
        let mut store = self.store.lock().await;
        if let Some(store) = store.as_ref() {
            return Ok(store.clone());
        }
        let directory = self.directory.clone();
        let opened = tokio::task::spawn_blocking(move || FileSessionStore::exclusive(directory))
            .await
            .map_err(StoreError::backend)??;
        let opened = std::sync::Arc::new(opened);
        *store = Some(opened.clone());
        Ok(opened)
    }
}

#[cfg(not(target_family = "wasm"))]
#[async_trait]
impl SessionStore for ExclusiveFileSessionStore {
    async fn load(&self) -> Result<Option<Vec<u8>>, StoreError> {
        self.store().await?.load().await
    }
    async fn save(&self, bytes: Vec<u8>) -> Result<(), StoreError> {
        self.store().await?.save(bytes).await
    }
    async fn clear(&self) -> Result<(), StoreError> {
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

    /// Holds the credentials lock until dropped, so a second app process waits for the first.
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

    #[cfg(test)]
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

    pub(crate) fn save_blocking(&self, bytes: &[u8]) -> Result<(), StoreError> {
        use std::io::Write;
        self.prepare_directory()?;
        let parent = self
            .path
            .parent()
            .ok_or(StoreError::Invalid("session directory is missing"))?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(bytes)?;
        temporary.as_file().sync_all()?;
        temporary.persist(&self.path).map_err(StoreError::backend)?;
        Ok(())
    }
}

#[cfg(not(target_family = "wasm"))]
#[async_trait]
impl SessionStore for FileSessionStore {
    async fn load(&self) -> Result<Option<Vec<u8>>, StoreError> {
        let reader = Self {
            path: self.path.clone(),
            owner: self.owner.clone(),
        };
        tokio::task::spawn_blocking(move || match reader.read_blocking() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        })
        .await
        .map_err(StoreError::backend)?
    }

    async fn save(&self, bytes: Vec<u8>) -> Result<(), StoreError> {
        let writer = Self {
            path: self.path.clone(),
            owner: self.owner.clone(),
        };
        tokio::task::spawn_blocking(move || writer.save_blocking(&bytes))
            .await
            .map_err(StoreError::backend)?
    }

    async fn clear(&self) -> Result<(), StoreError> {
        match tokio::fs::remove_file(&self.path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
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
    async fn load(&self) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self
            .bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }

    async fn save(&self, bytes: Vec<u8>) -> Result<(), StoreError> {
        *self
            .bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(bytes);
        Ok(())
    }

    async fn clear(&self) -> Result<(), StoreError> {
        *self
            .bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        Ok(())
    }
}

#[cfg(all(test, not(target_family = "wasm")))]
mod tests {
    use super::{FileSessionStore, SessionStore, write_atomic, write_atomic_private};

    #[test]
    fn concurrent_atomic_writers_publish_complete_files_without_leftovers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("media");
        let ready = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            for byte in 0..8 {
                let (path, ready) = (&path, &ready);
                scope.spawn(move || {
                    ready.wait();
                    write_atomic(path, &vec![byte; 16 * 1024]).unwrap();
                    let saved = std::fs::read(path).unwrap();
                    assert_eq!(saved.len(), 16 * 1024);
                    assert!(saved.iter().all(|byte| *byte == saved[0]));
                });
            }
        });
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_writes_preserve_creation_and_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let reference = dir.path().join("reference");
        let path = dir.path().join("policy.json");
        let mode =
            |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        std::fs::write(&reference, b"old").unwrap();
        write_atomic(&path, b"first").unwrap();
        assert_eq!(mode(&path), mode(&reference));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        write_atomic(&path, b"replacement").unwrap();
        assert_eq!(mode(&path), 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn private_atomic_writes_create_owner_only_files() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("users.json");
        write_atomic_private(&path, b"secret").unwrap();
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn a_failed_atomic_publish_cleans_its_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("occupied");
        std::fs::create_dir(&path).unwrap();
        assert!(write_atomic(&path, b"replacement").is_err());
        assert!(path.is_dir());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

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
        assert_eq!(store.load().await.unwrap(), Some(b"second".to_vec()));
        assert!(!dir.join("session.tmp").exists());

        store.clear().await.unwrap();
        assert_eq!(store.load().await.unwrap(), None);

        tokio::fs::remove_dir_all(&dir).await.unwrap();
    }
}
