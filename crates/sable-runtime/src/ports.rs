use std::sync::Arc;

use async_trait::async_trait;
use sable_protocol::RpcError;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::value::RawValue;

use crate::rt::{SendOutsideWasm, SyncOutsideWasm};

pub trait Rpc: Serialize {
    const METHOD: &'static str;
    type Ok: DeserializeOwned;
}

#[cfg_attr(not(target_family = "wasm"), async_trait)]
#[cfg_attr(target_family = "wasm", async_trait(?Send))]
pub trait Backend: SendOutsideWasm + SyncOutsideWasm + 'static {
    async fn call(&self, method: &str, params: &str) -> Result<Box<RawValue>, RpcError>;
}

fn contract_broken(method: &str, error: &serde_json::Error) -> RpcError {
    tracing::error!(method, %error, "rpc contract broken");
    RpcError::Failed {
        log_id: format!("rpc:{method}"),
    }
}

impl dyn Backend {
    pub async fn run<P: Rpc + SendOutsideWasm>(&self, params: P) -> Result<P::Ok, RpcError> {
        let contract_broken = |error: serde_json::Error| contract_broken(P::METHOD, &error);
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
    async fn storage_get(&self, _key: &str) -> Result<Option<String>, PlatformError> {
        Err(PlatformError::Unsupported)
    }

    async fn storage_set(&self, _key: &str, _value: &str) -> Result<(), PlatformError> {
        Err(PlatformError::Unsupported)
    }
}

#[derive(Clone)]
pub struct Ports {
    pub backend: Arc<dyn Backend>,
    pub platform: Arc<dyn Platform>,
}
