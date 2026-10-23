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
    transitions: tokio::sync::Mutex<()>,
    ffi: OnceLock<Ffi>,
}

impl AccountGate {
    pub fn attach(&self, ffi: Ffi) {
        let _ = self.inner.ffi.set(ffi);
    }

    pub async fn serving(&self) -> RwLockReadGuard<'_, ()> {
        self.inner.switching.read().await
    }

    /// When the call changes the account, the runtime moves to it before this returns.
    /// Restoring the account already served uses `active_session` without waiting for other readers.
    ///
    /// # Errors
    ///
    /// The call's error, or `unavailable()` when the runtime cannot follow.
    pub async fn run<T, E, F: Future<Output = Result<T, E>>>(
        &self,
        method: &str,
        call: impl Future<Output = Result<T, E>>,
        active_session: impl FnOnce() -> F,
        json: impl for<'a> Fn(&'a T) -> &'a str,
        unavailable: impl Fn() -> E,
    ) -> Result<T, E> {
        if !changes_account(method) {
            return call.await;
        }
        let _transition = self.inner.transitions.lock().await;
        if method == "session.restore" {
            let _serving = self.serving().await;
            let active = active_session().await?;
            if account_after(method, json(&active)).is_some_and(|account| {
                !account.is_empty()
                    && *self
                        .inner
                        .account
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        == account
            }) {
                return Ok(active);
            }
        }
        if let Some(ffi) = self.inner.ffi.get() {
            ffi.shutdown().await.map_err(|_| unavailable())?;
        }
        let _moving = self.inner.switching.write().await;
        let result = call.await;
        let previous = self
            .inner
            .account
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let account = result
            .as_ref()
            .ok()
            .and_then(|result| account_after(method, json(result)))
            .unwrap_or(previous);
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
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn restoring_the_active_account_does_not_wait_for_runtime_calls() {
        let gate = AccountGate::default();
        let session = r#"{"account_id":"a"}"#;
        gate.run(
            "session.restore",
            async { Ok::<_, &str>(session) },
            || async { Ok("null") },
            |json| json,
            || "unavailable",
        )
        .await
        .unwrap();
        let _serving = gate.serving().await;

        let restored = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            gate.run(
                "session.restore",
                async { Err("an active session should not need restoring") },
                || async { Ok(session) },
                |json| json,
                || "unavailable",
            ),
        )
        .await
        .expect("an unchanged account does not need exclusive access")
        .unwrap();

        assert_eq!(restored, session);
    }

    #[tokio::test]
    async fn restoring_a_missing_or_different_account_still_waits_for_runtime_calls() {
        for active in ["null", r#"{"account_id":"b"}"#] {
            let gate = AccountGate::default();
            gate.run(
                "session.restore",
                async { Ok::<_, ()>(r#"{"account_id":"a"}"#) },
                || async { Ok("null") },
                |json| json,
                || (),
            )
            .await
            .unwrap();
            let serving = gate.serving().await;
            let mut restoring = tokio::spawn({
                let gate = gate.clone();
                async move {
                    gate.run(
                        "session.restore",
                        async { Ok::<_, ()>(r#"{"account_id":"b"}"#) },
                        || async { Ok(active) },
                        |json| json,
                        || (),
                    )
                    .await
                }
            });

            tokio::time::timeout(std::time::Duration::from_millis(20), &mut restoring)
                .await
                .expect_err("an account change waits for runtime calls");
            drop(serving);
            assert_eq!(restoring.await.unwrap().unwrap(), r#"{"account_id":"b"}"#);
        }
    }

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
