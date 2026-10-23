use std::{
    future::Future,
    sync::{Arc, Mutex, OnceLock, PoisonError},
};

use serde_json::Value;
use tokio::sync::{RwLock, RwLockReadGuard};

use crate::Ffi;

#[must_use]
pub fn changes_account(method: &str) -> bool {
    matches!(
        method,
        "session.restore" | "session.switch_account" | "session.logout"
    )
}

/// A logout, or a restore that found nothing, leaves no account: `""`.
#[must_use]
pub fn account_after(method: &str, result: &str) -> Option<String> {
    match method {
        "session.restore" | "session.switch_account" => {
            let info: Value = serde_json::from_str(result).ok()?;
            Some(
                info.get("account_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            )
        }
        "session.logout" => Some(String::new()),
        _ => None,
    }
}

/// The core serves the new account to the runtime only after `switch_account` returned:
/// runtime calls hold the gate for reading, an account change for writing.
#[derive(Clone, Default)]
pub struct AccountGate {
    inner: Arc<GateState>,
}

#[derive(Default)]
struct GateState {
    switching: RwLock<()>,
    account: Mutex<String>,
    ffi: OnceLock<Ffi>,
}

impl AccountGate {
    /// Before this, account changes only wait.
    pub fn attach(&self, ffi: Ffi) {
        let _ = self.inner.ffi.set(ffi);
    }

    pub async fn serving(&self) -> RwLockReadGuard<'_, ()> {
        self.inner.switching.read().await
    }

    /// When the call changes the account, the runtime moves to it before this returns.
    ///
    /// # Errors
    ///
    /// The call's error, or `unavailable()` when the runtime cannot follow.
    pub async fn run<T, E>(
        &self,
        method: &str,
        call: impl Future<Output = Result<T, E>>,
        json: impl for<'a> FnOnce(&'a T) -> &'a str,
        unavailable: impl FnOnce() -> E,
    ) -> Result<T, E> {
        if !changes_account(method) {
            return call.await;
        }
        let _moving = self.inner.switching.write().await;
        let result = call.await?;
        let Some(account) = account_after(method, json(&result)) else {
            return Ok(result);
        };
        let current = self
            .inner
            .account
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if current != account {
            if let Some(ffi) = self.inner.ffi.get() {
                ffi.switch_account(account.clone())
                    .await
                    .map_err(|_| unavailable())?;
            }
            *self
                .inner
                .account
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = account;
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_calls_that_change_the_account_are_followed() {
        assert!(changes_account("session.restore"));
        assert!(!changes_account("rooms.list"));
        assert_eq!(
            account_after("session.restore", "null"),
            Some(String::new())
        );
        assert_eq!(
            account_after("session.restore", r#"{"account_id":"3"}"#),
            Some("3".to_owned())
        );
        assert_eq!(
            account_after("session.switch_account", r#"{"account_id":"4"}"#),
            Some("4".to_owned())
        );
        assert_eq!(account_after("session.logout", "null"), Some(String::new()));
        assert_eq!(account_after("rooms.list", "[]"), None);
        assert_eq!(account_after("session.restore", "not json"), None);
    }
}
