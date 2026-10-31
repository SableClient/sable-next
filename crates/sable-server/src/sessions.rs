use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;
use tower_sessions::{
    MemoryStore, SessionStore,
    session::{Id, Record},
    session_store,
};

/// Prevent an in-flight request from recreating a session deleted by logout.
#[derive(Clone, Debug, Default)]
pub(crate) struct SessionMemoryStore {
    inner: MemoryStore,
    writes: Arc<Mutex<()>>,
}

#[async_trait]
impl SessionStore for SessionMemoryStore {
    async fn create(&self, record: &mut Record) -> session_store::Result<()> {
        let _guard = self.writes.lock().await;
        self.inner.create(record).await
    }

    async fn save(&self, record: &Record) -> session_store::Result<()> {
        let _guard = self.writes.lock().await;
        if self.inner.load(&record.id).await?.is_none() {
            return Err(session_store::Error::Backend(
                "session no longer exists".into(),
            ));
        }
        self.inner.save(record).await
    }

    async fn load(&self, id: &Id) -> session_store::Result<Option<Record>> {
        self.inner.load(id).await
    }

    async fn delete(&self, id: &Id) -> session_store::Result<()> {
        let _guard = self.writes.lock().await;
        self.inner.delete(id).await
    }
}
