use std::{fmt::Display, sync::atomic::Ordering};

use matrix_sdk::encryption::{recovery::RecoveryError, secret_storage::SecretStorageError};
use matrix_sdk::ruma::api::error::{ErrorKind, RetryAfter};

use crate::protocol::CommandErr;

use crate::Core;

impl Core {
    pub(crate) fn failed(&self, context: &str, error: impl Display) -> CommandErr {
        let log_id = format!("e{}", self.next_log_id.fetch_add(1, Ordering::Relaxed));
        tracing::error!(log_id, context, "{error}");
        CommandErr::Failed { log_id }
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

    pub(crate) fn room_error(&self, context: &str, error: matrix_sdk::Error) -> CommandErr {
        match error.client_api_error_kind() {
            Some(ErrorKind::Forbidden) => {
                tracing::warn!(context, category = "denied", "room operation refused");
                return CommandErr::Denied;
            }
            Some(ErrorKind::LimitExceeded(limit)) => {
                let retry_after_ms = limit.retry_after.as_ref().and_then(|retry_after| {
                    let RetryAfter::Delay(delay) = retry_after else {
                        return None;
                    };
                    delay.as_millis().try_into().ok()
                });
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
            Some(ErrorKind::LimitExceeded(limit)) => {
                tracing::warn!(
                    context,
                    category = "rate_limited",
                    "homeserver request failed"
                );
                CommandErr::RateLimited {
                    retry_after_ms: limit.retry_after.as_ref().and_then(|retry_after| {
                        let RetryAfter::Delay(delay) = retry_after else {
                            return None;
                        };
                        delay.as_millis().try_into().ok()
                    }),
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
            _ if matches!(error, matrix_sdk::HttpError::Reqwest(_)) => {
                tracing::warn!(context, category = "network", "homeserver request failed");
                CommandErr::Unavailable
            }
            _ if error
                .as_client_api_error()
                .is_some_and(|api_error| api_error.status_code.is_server_error()) =>
            {
                tracing::warn!(context, category = "server", "homeserver request failed");
                CommandErr::Unavailable
            }
            _ => self.failed(context, error),
        }
    }

    pub(crate) fn discovery_error(&self, error: matrix_sdk::ClientBuildError) -> CommandErr {
        match error {
            matrix_sdk::ClientBuildError::Http(error) => {
                self.homeserver_http_error("login_flows: discovery", error)
            }
            _ => CommandErr::UnknownHomeserver,
        }
    }
}
