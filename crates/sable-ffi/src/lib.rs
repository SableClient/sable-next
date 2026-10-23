#![expect(
    clippy::missing_errors_doc,
    reason = "call errors are represented by the return type"
)]
use std::future::Future;

use sable_protocol::CoreEvent;
pub use sable_runtime::AppError;
use sable_runtime::{
    App, Batch, SubId, SubscribeRequest, Target, Window, decode, rt::SendOutsideWasm,
};
use serde::Serialize;
use serde_json::Value;

fn encode<T: Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value).map_err(|_| AppError::Encode)
}

#[derive(Clone)]
pub struct Ffi {
    app: App,
    #[cfg(not(target_family = "wasm"))]
    runtime: tokio::runtime::Handle,
}

impl Ffi {
    #[cfg(not(target_family = "wasm"))]
    #[must_use]
    pub const fn new(app: App, runtime: tokio::runtime::Handle) -> Self {
        Self { app, runtime }
    }

    #[cfg(target_family = "wasm")]
    #[must_use]
    pub const fn new(app: App) -> Self {
        Self { app }
    }

    #[cfg(not(target_family = "wasm"))]
    async fn run<T>(
        &self,
        work: impl Future<Output = T> + SendOutsideWasm + 'static,
    ) -> Result<T, AppError>
    where
        T: SendOutsideWasm + 'static,
    {
        self.runtime
            .spawn(work)
            .await
            .map_err(|_| AppError::Stopped)
    }

    #[cfg(target_family = "wasm")]
    async fn run<T>(
        &self,
        work: impl Future<Output = T> + SendOutsideWasm + 'static,
    ) -> Result<T, AppError> {
        Ok(work.await)
    }

    pub fn handshake(&self) -> Result<String, AppError> {
        encode(&self.app.handshake())
    }

    pub async fn subscribe(&self, request: &str) -> Result<String, AppError> {
        let request: SubscribeRequest = decode(request)?;
        let app = self.app.clone();
        let subscribed = self
            .run(async move { app.subscribe(request).await })
            .await??;
        encode(&subscribed)
    }

    pub async fn unsubscribe(&self, sub: u32) -> Result<(), AppError> {
        let app = self.app.clone();
        self.run(async move { app.unsubscribe(SubId(sub)).await })
            .await
    }

    pub async fn resync(&self, sub: u32) -> Result<String, AppError> {
        let app = self.app.clone();
        let snapshot = self
            .run(async move { app.resync(SubId(sub)).await })
            .await??;
        encode(&snapshot)
    }

    pub async fn range(&self, sub: u32, window: &str) -> Result<String, AppError> {
        let window: Option<Window> = decode(window)?;
        let app = self.app.clone();
        let snapshot = self
            .run(async move { app.range(SubId(sub), window).await })
            .await??;
        encode(&snapshot)
    }

    pub async fn dispatch(&self, target: &str, action: &str) -> Result<(), AppError> {
        let (target, action): (Target, Value) = (decode(target)?, decode(action)?);
        let app = self.app.clone();
        self.run(async move { app.dispatch(&target, action).await })
            .await??;
        Ok(())
    }

    pub async fn request(&self, target: &str, action: &str) -> Result<u64, AppError> {
        let (target, action): (Target, Value) = (decode(target)?, decode(action)?);
        let app = self.app.clone();
        let req = self
            .run(async move { app.request(&target, action).await })
            .await??;
        Ok(req.0)
    }

    pub async fn next_batch(&self) -> Result<String, AppError> {
        encode(&self.app.next_batch().await)
    }

    pub fn try_next_batch(&self) -> Result<Option<String>, AppError> {
        self.app
            .try_next_batch()
            .map(|batch: Batch| encode(&batch))
            .transpose()
    }

    pub async fn offer(&self, event: CoreEvent) -> Result<(), AppError> {
        let app = self.app.clone();
        self.run(async move { app.offer(&event).await }).await
    }

    pub async fn switch_account(&self, account: String) -> Result<(), AppError> {
        let app = self.app.clone();
        self.run(async move { app.switch_account(account).await })
            .await
    }

    pub async fn shutdown(&self) -> Result<(), AppError> {
        let app = self.app.clone();
        self.run(async move { app.shutdown().await }).await
    }
}
