use std::{fmt::Display, sync::atomic::Ordering};

use matrix_sdk::authentication::oauth::error::{
    OAuthClientRegistrationError, OAuthError, RequestTokenError,
};
use matrix_sdk::encryption::{recovery::RecoveryError, secret_storage::SecretStorageError};
use matrix_sdk::ruma::api::error::{ErrorKind, RetryAfter};
use matrix_sdk::{SendOutsideWasm, SyncOutsideWasm};
use web_time::SystemTime;

use crate::protocol::CommandErr;

use crate::Core;

#[cfg(not(target_family = "wasm"))]
pub(crate) type Cause = Box<dyn std::error::Error + Send + Sync>;
#[cfg(target_family = "wasm")]
pub(crate) type Cause = Box<dyn std::error::Error>;

pub(crate) trait Source:
    std::error::Error + SendOutsideWasm + SyncOutsideWasm + 'static
{
}

impl<T: std::error::Error + SendOutsideWasm + SyncOutsideWasm + 'static> Source for T {}

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("{0}")]
    Invalid(&'static str),
    #[error("{0}")]
    Message(String),
    #[error("{what}: {source}")]
    Context {
        what: &'static str,
        #[source]
        source: Cause,
    },
    #[error(transparent)]
    Store(#[from] crate::store::StoreError),
    #[error(transparent)]
    Backend(Cause),
}

impl CoreError {
    pub(crate) fn backend(error: impl Source) -> Self {
        Self::Backend(Box::new(error))
    }

    pub(crate) fn context(what: &'static str, error: impl Source) -> Self {
        Self::Context {
            what,
            source: Box::new(error),
        }
    }
}

impl From<String> for CoreError {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<&'static str> for CoreError {
    fn from(message: &'static str) -> Self {
        Self::Invalid(message)
    }
}

pub(crate) fn retry_delay_ms(retry_after: &RetryAfter) -> Option<u64> {
    let delay = match retry_after {
        RetryAfter::Delay(delay) => *delay,
        RetryAfter::DateTime(at) => {
            let at = at.duration_since(web_time::UNIX_EPOCH).unwrap_or_default();
            let now = SystemTime::now()
                .duration_since(web_time::UNIX_EPOCH)
                .unwrap_or_default();
            at.saturating_sub(now)
        }
    };
    delay.as_millis().try_into().ok()
}

pub(crate) trait ResultExt<T> {
    fn or_failed(self, core: &Core, label: &str) -> Result<T, CommandErr>;
}

impl<T, E: Display> ResultExt<T> for Result<T, E> {
    fn or_failed(self, core: &Core, label: &str) -> Result<T, CommandErr> {
        self.map_err(|error| core.failed(label, error))
    }
}

impl Core {
    pub fn failed(&self, context: &str, error: impl Display) -> CommandErr {
        let log_id = format!("e{}", self.next_log_id.fetch_add(1, Ordering::Relaxed));
        tracing::error!(log_id, context, "{error}");
        CommandErr::Failed { log_id }
    }

    pub(crate) fn failed_with_source(
        &self,
        context: &str,
        error: &dyn std::error::Error,
    ) -> CommandErr {
        let mut message = error.to_string();
        let mut source = error.source();
        while let Some(cause) = source {
            message.push_str(": ");
            message.push_str(&cause.to_string());
            source = cause.source();
        }
        self.failed(context, message)
    }

    pub(crate) fn oauth_login_error(&self, context: &str, error: &OAuthError) -> CommandErr {
        if matches!(
            error,
            OAuthError::ClientRegistration(OAuthClientRegistrationError::OAuth(
                RequestTokenError::Request(_)
            ))
        ) {
            tracing::warn!(
                context,
                category = "auth_provider_unreachable",
                "the authorization server did not answer: {error}"
            );
            return CommandErr::AuthProviderUnreachable;
        }
        self.failed_with_source(context, error)
    }

    pub(crate) fn login_error(&self, error: matrix_sdk::Error) -> CommandErr {
        if error.client_api_error_kind() == Some(&ErrorKind::Forbidden) {
            tracing::warn!(
                operation = "password_login",
                "homeserver rejected the credentials"
            );
            return CommandErr::Denied;
        }

        match error {
            matrix_sdk::Error::Http(error) => self.homeserver_http_error("login", *error),
            _ => self.failed("login", error),
        }
    }

    pub(crate) fn recovery_error(&self, error: RecoveryError) -> CommandErr {
        if matches!(
            error,
            RecoveryError::SecretStorage(SecretStorageError::SecretStorageKey(_))
        ) {
            return CommandErr::Denied;
        }
        self.failed("recover_identity", error)
    }

    pub(crate) fn profile_error(&self, error: matrix_sdk::Error) -> CommandErr {
        if error.client_api_error_kind() == Some(&ErrorKind::NotFound) {
            tracing::debug!(context = "user_profile", "the user has no profile");
            return CommandErr::Unavailable;
        }

        match error {
            matrix_sdk::Error::Http(error) => self.homeserver_http_error("user_profile", *error),
            _ => self.failed("user_profile", error),
        }
    }

    pub(crate) fn room_error(&self, context: &str, error: matrix_sdk::Error) -> CommandErr {
        match error.client_api_error_kind() {
            Some(ErrorKind::Forbidden) => {
                tracing::warn!(context, category = "denied", "room operation refused");
                return CommandErr::Denied;
            }
            Some(ErrorKind::LimitExceeded(limit)) => {
                let retry_after_ms = limit.retry_after.as_ref().and_then(retry_delay_ms);
                tracing::warn!(context, category = "rate_limited", "room operation refused");
                return CommandErr::RateLimited { retry_after_ms };
            }
            _ => {}
        }

        match error {
            matrix_sdk::Error::Http(error) => self.homeserver_http_error(context, *error),
            _ => self.failed(context, error),
        }
    }

    pub(crate) fn homeserver_http_error(
        &self,
        context: &str,
        error: matrix_sdk::HttpError,
    ) -> CommandErr {
        match error.client_api_error_kind() {
            Some(ErrorKind::UserLocked) => CommandErr::AccountLocked,
            Some(ErrorKind::UserSuspended) => CommandErr::AccountSuspended,
            Some(ErrorKind::LimitExceeded(limit)) => {
                tracing::warn!(
                    context,
                    category = "rate_limited",
                    "homeserver request failed"
                );
                CommandErr::RateLimited {
                    retry_after_ms: limit.retry_after.as_ref().and_then(retry_delay_ms),
                }
            }
            _ if error
                .as_client_api_error()
                .is_some_and(|api_error| api_error.status_code.as_u16() == 429) =>
            {
                tracing::warn!(
                    context,
                    category = "rate_limited",
                    "homeserver request failed"
                );
                CommandErr::RateLimited {
                    retry_after_ms: None,
                }
            }
            Some(ErrorKind::Unrecognized) => {
                tracing::info!(
                    context,
                    category = "unsupported",
                    "homeserver does not implement this endpoint"
                );
                CommandErr::Unsupported
            }
            _ if matches!(error, matrix_sdk::HttpError::Reqwest(_)) => {
                tracing::warn!(
                    context,
                    category = "network",
                    "homeserver request failed: {error}"
                );
                CommandErr::Unavailable
            }
            _ if error
                .as_client_api_error()
                .is_some_and(|api_error| api_error.status_code.is_server_error()) =>
            {
                tracing::warn!(
                    context,
                    category = "server",
                    "homeserver request failed: {error}"
                );
                CommandErr::Unavailable
            }
            _ => self.failed(context, error),
        }
    }

    pub(crate) fn discovery_error(&self, error: matrix_sdk::ClientBuildError) -> CommandErr {
        match error {
            matrix_sdk::ClientBuildError::Http(error) => {
                self.homeserver_http_error("login_flows_discovery", error)
            }
            _ => CommandErr::UnknownHomeserver,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{self, Write},
        sync::{Arc, Mutex, PoisonError},
        time::Duration,
    };

    use matrix_sdk::ruma::api::error::RetryAfter;

    use crate::Core;
    use crate::protocol::CommandErr;
    use crate::store::MemorySessionStore;

    use super::{ResultExt, retry_delay_ms};

    #[derive(Clone)]
    struct TestWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for TestWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .write(bytes)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .flush()
        }
    }

    #[test]
    fn or_failed_records_the_given_label() {
        let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
        let output = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .without_time()
            .with_writer({
                let output = output.clone();
                move || TestWriter(output.clone())
            })
            .finish();
        let result = tracing::subscriber::with_default(subscriber, || {
            Err::<(), _>("problem").or_failed(&core, "test_label")
        });

        assert!(matches!(result, Err(CommandErr::Failed { .. })));
        assert!(
            String::from_utf8(output.lock().unwrap().clone())
                .unwrap()
                .contains("context=\"test_label\"")
        );
    }

    #[test]
    fn retry_after_reads_a_delay() {
        assert_eq!(
            retry_delay_ms(&RetryAfter::Delay(Duration::from_secs(2))),
            Some(2000)
        );
    }

    #[test]
    fn retry_after_reads_an_http_date() {
        let at = web_time::SystemTime::now() + Duration::from_secs(60);
        let ms = retry_delay_ms(&RetryAfter::DateTime(at)).unwrap();
        assert!((58_000..=60_000).contains(&ms), "{ms}");
        let past = web_time::SystemTime::now() - Duration::from_secs(60);
        assert_eq!(retry_delay_ms(&RetryAfter::DateTime(past)), Some(0));
    }
}
