use std::{future::Future, pin::Pin};

/// The core decides *what* to persist, the carrier *where*: a file natively,
/// `IndexedDB` in a worker, which has no `localStorage`.
#[cfg(not(target_family = "wasm"))]
pub trait SessionStore: Send + Sync + 'static {
    fn load(&self) -> Pin<Box<dyn Future<Output = Option<Vec<u8>>> + Send + '_>>;
    fn save(&self, bytes: Vec<u8>)
    -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>>;
    fn clear(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

#[cfg(target_family = "wasm")]
pub trait SessionStore: 'static {
    fn load(&self) -> Pin<Box<dyn Future<Output = Option<Vec<u8>>> + '_>>;
    fn save(&self, bytes: Vec<u8>) -> Pin<Box<dyn Future<Output = Result<(), String>> + '_>>;
    fn clear(&self) -> Pin<Box<dyn Future<Output = ()> + '_>>;
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
impl SessionStore for FileSessionStore {
    fn load(&self) -> Pin<Box<dyn Future<Output = Option<Vec<u8>>> + Send + '_>> {
        Box::pin(async move { tokio::fs::read(&self.path).await.ok() })
    }

    fn save(
        &self,
        bytes: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            if let Some(parent) = self.path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            tokio::fs::write(&self.path, bytes)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn clear(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            let _ = tokio::fs::remove_file(&self.path).await;
        })
    }
}

#[derive(Default)]
pub struct MemorySessionStore {
    bytes: std::sync::Mutex<Option<Vec<u8>>>,
}

#[cfg(not(target_family = "wasm"))]
impl SessionStore for MemorySessionStore {
    fn load(&self) -> Pin<Box<dyn Future<Output = Option<Vec<u8>>> + Send + '_>> {
        Box::pin(async move {
            self.bytes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        })
    }

    fn save(
        &self,
        bytes: Vec<u8>,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            *self
                .bytes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(bytes);
            Ok(())
        })
    }

    fn clear(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            *self
                .bytes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        })
    }
}

#[cfg(target_family = "wasm")]
impl SessionStore for MemorySessionStore {
    fn load(&self) -> Pin<Box<dyn Future<Output = Option<Vec<u8>>> + '_>> {
        Box::pin(async move {
            self.bytes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        })
    }

    fn save(&self, bytes: Vec<u8>) -> Pin<Box<dyn Future<Output = Result<(), String>> + '_>> {
        Box::pin(async move {
            *self
                .bytes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(bytes);
            Ok(())
        })
    }

    fn clear(&self) -> Pin<Box<dyn Future<Output = ()> + '_>> {
        Box::pin(async move {
            *self
                .bytes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        })
    }
}
