use std::{
    hash::Hasher,
    io::{ErrorKind, Write},
    path::PathBuf,
};

use async_trait::async_trait;
use atomic_write_file::AtomicWriteFile;
use fnv::FnvHasher;
use sable_runtime::{Platform, PlatformError};

pub struct FileStorage<D> {
    directory: D,
}

impl<D: Fn(&str) -> PathBuf + Send + Sync + 'static> FileStorage<D> {
    #[must_use]
    pub const fn new(directory: D) -> Self {
        Self { directory }
    }

    fn path(&self, key: &str) -> PathBuf {
        let account = key.split('/').nth(1).unwrap_or_default();
        let mut hasher = FnvHasher::default();
        hasher.write(key.as_bytes());
        (self.directory)(account).join(format!("{:016x}", hasher.finish()))
    }
}

fn failed(error: &std::io::Error) -> PlatformError {
    PlatformError::Failed(error.to_string())
}

async fn write(path: PathBuf, value: String) -> std::io::Result<()> {
    tokio::fs::create_dir_all(path.parent().unwrap_or(&path)).await?;
    tokio::task::spawn_blocking(move || {
        let mut file = AtomicWriteFile::open(path)?;
        file.write_all(value.as_bytes())?;
        file.commit()
    })
    .await
    .map_err(std::io::Error::other)?
}

#[async_trait]
impl<D: Fn(&str) -> PathBuf + Send + Sync + 'static> Platform for FileStorage<D> {
    async fn storage_get(&self, key: &str) -> Result<Option<String>, PlatformError> {
        match tokio::fs::read_to_string(self.path(key)).await {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(error) => Err(failed(&error)),
        }
    }

    async fn storage_set(&self, key: &str, value: &str) -> Result<(), PlatformError> {
        write(self.path(key), value.to_owned())
            .await
            .map_err(|error| failed(&error))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn storage(root: &Path) -> FileStorage<impl Fn(&str) -> PathBuf + Send + Sync + 'static> {
        let root = root.to_path_buf();
        FileStorage::new(move |account| root.join(format!("account-{account}")).join("views"))
    }

    #[tokio::test]
    async fn a_value_saved_loads_back_from_its_account_directory() {
        let root = tempfile::tempdir().unwrap();
        let storage = storage(root.path());
        let key = "snapshot/3/counter/null";

        assert_eq!(storage.storage_get(key).await, Ok(None));
        storage.storage_set(key, r#"{"a":1}"#).await.unwrap();
        storage.storage_set(key, r#"{"a":2}"#).await.unwrap();

        assert_eq!(
            storage.storage_get(key).await,
            Ok(Some(r#"{"a":2}"#.to_owned()))
        );
        assert!(root.path().join("account-3/views").is_dir());
        assert_eq!(
            storage
                .storage_get("snapshot/4/counter/null")
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn a_key_with_slashes_does_not_leave_its_directory() {
        let root = tempfile::tempdir().unwrap();
        let storage = storage(root.path());

        storage
            .storage_set("snapshot/3/../../escape/..", "x")
            .await
            .unwrap();

        assert!(!root.path().join("escape").exists());
        assert_eq!(
            std::fs::read_dir(root.path().join("account-3/views"))
                .unwrap()
                .count(),
            1
        );
    }
}
