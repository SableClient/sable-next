use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use sable_protocol::RpcError;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::value::RawValue;

use crate::rt::{SendOutsideWasm, SyncOutsideWasm};

/// A `"<domain>.<method>"` core call with its params as `Self`.
pub trait Rpc: Serialize {
    const METHOD: &'static str;
    type Ok: DeserializeOwned;
}

/// Slices call the typed `run`.
#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
pub trait Backend: SendOutsideWasm + SyncOutsideWasm + 'static {
    /// # Errors
    ///
    /// Returns the core's error for the call.
    async fn call(&self, method: &str, params: &str) -> Result<Box<RawValue>, RpcError>;
}

impl dyn Backend {
    /// # Errors
    ///
    /// The core's error, or `Failed` (logged) when params or result break the contract.
    pub async fn run<P: Rpc + SendOutsideWasm>(&self, params: P) -> Result<P::Ok, RpcError> {
        let contract_broken = |error: serde_json::Error| {
            tracing::error!(method = P::METHOD, %error, "rpc contract broken");
            RpcError::Failed {
                log_id: format!("rpc:{}", P::METHOD),
            }
        };
        let json = serde_json::to_string(&params).map_err(contract_broken)?;
        drop(params);
        let raw = self.call(P::METHOD, &json).await?;
        serde_json::from_str(raw.get()).map_err(contract_broken)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PlatformError {
    #[error("this platform does not provide it")]
    Unsupported,
    #[error("{0}")]
    Failed(String),
}

/// A method a shell lacks stays `Unsupported`.
#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
pub trait Platform: SendOutsideWasm + SyncOutsideWasm + 'static {
    /// # Errors
    ///
    /// `Unsupported` where the shell keeps none.
    async fn storage_get(&self, _key: &str) -> Result<Option<String>, PlatformError> {
        Err(PlatformError::Unsupported)
    }

    /// # Errors
    ///
    /// `Unsupported` where the shell keeps none, `Failed` when it cannot write.
    async fn storage_set(&self, _key: &str, _value: &str) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported)
    }

    /// # Errors
    ///
    /// `Unsupported` where the shell cannot open links.
    async fn open_url(&self, _url: &str) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported)
    }
}

#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
pub trait Clock: SendOutsideWasm + SyncOutsideWasm + 'static {
    async fn sleep(&self, duration: Duration);
}

pub struct SystemClock;

#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
impl Clock for SystemClock {
    async fn sleep(&self, duration: Duration) {
        crate::rt::sleep(duration).await;
    }
}

#[derive(Clone)]
pub struct Ports {
    pub backend: Arc<dyn Backend>,
    pub platform: Arc<dyn Platform>,
    pub clock: Arc<dyn Clock>,
}
