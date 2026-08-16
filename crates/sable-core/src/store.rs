use async_trait::async_trait;
use matrix_sdk::{SendOutsideWasm, SyncOutsideWasm};

/// The core decides *what* to persist, the carrier *where*: a file natively,
/// `IndexedDB` in a worker, which has no `localStorage`.
#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
pub trait SessionStore: SendOutsideWasm + SyncOutsideWasm + 'static {
    async fn load(&self) -> Option<Vec<u8>>;
    async fn save(&self, bytes: Vec<u8>) -> Result<(), String>;
    async fn clear(&self) -> Result<(), String>;
}

#[cfg(not(target_family = "wasm"))]
pub struct FileSessionStore {
    path: std::path::PathBuf,
}

#[cfg(not(target_family = "wasm"))]
impl FileSessionStore {
    pub fn new(data_dir: impl Into<std::path::PathBuf>) -> Self {
        Self {
            path: data_dir.into().join("session.json"),
        }
    }
}

#[cfg(not(target_family = "wasm"))]
#[async_trait]
impl SessionStore for FileSessionStore {
    async fn load(&self) -> Option<Vec<u8>> {
        tokio::fs::read(&self.path).await.ok()
    }

    async fn save(&self, bytes: Vec<u8>) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::fs::write(&self.path, bytes)
            .await
            .map_err(|e| e.to_string())
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
    async fn load(&self) -> Option<Vec<u8>> {
        self.bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
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
