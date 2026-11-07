use std::{error::Error, fmt::Display, sync::atomic::Ordering};

use matrix_sdk::authentication::oauth::error::{
    OAuthClientRegistrationError, OAuthError, RequestTokenError,
};
use matrix_sdk::encryption::{recovery::RecoveryError, secret_storage::SecretStorageError};
use matrix_sdk::ruma::api::error::{ErrorKind, RetryAfter};
use matrix_sdk::send_queue::{RoomSendQueueError, RoomSendQueueStorageError};
use matrix_sdk::{SendOutsideWasm, SyncOutsideWasm};
use matrix_sdk_ui::timeline::Error as TimelineError;
use web_time::SystemTime;

use crate::protocol::RpcError;

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
    fn or_failed(self, core: &Core, label: &str) -> Result<T, RpcError>;
}

impl<T, E: Error + 'static> ResultExt<T> for Result<T, E> {
    fn or_failed(self, core: &Core, label: &str) -> Result<T, RpcError> {
        self.map_err(|error| core.rpc_error(label, &error))
    }
}

/// An outcome the user or the homeserver caused, not a defect to act on.
struct Expected {
    rpc: RpcError,
    level: tracing::Level,
    category: &'static str,
    message: &'static str,
}

impl Expected {
    const fn new(
        rpc: RpcError,
        level: tracing::Level,
        category: &'static str,
        message: &'static str,
    ) -> Self {
        Self {
            rpc,
            level,
            category,
            message,
        }
    }

    fn log(&self, context: &str, error: &dyn Error) {
        let (category, message) = (self.category, self.message);
        let error = error_chain(error);
        match self.level {
            tracing::Level::WARN => {
                tracing::warn!(context, category, %error, "{message}");
            }
            tracing::Level::INFO => {
                tracing::info!(context, category, %error, "{message}");
            }
            _ => tracing::debug!(context, category, %error, "{message}"),
        }
    }
}

fn http_error<'a>(error: &'a (dyn Error + 'static)) -> Option<&'a matrix_sdk::HttpError> {
    match error.downcast_ref::<matrix_sdk::Error>() {
        Some(matrix_sdk::Error::Http(http)) => Some(http),
        Some(_) => None,
        None => error.downcast_ref::<matrix_sdk::HttpError>(),
    }
}

fn client_api_error<'a>(
    error: &'a (dyn Error + 'static),
) -> Option<&'a matrix_sdk::ruma::api::error::Error> {
    error.downcast_ref::<matrix_sdk::Error>().map_or_else(
        || {
            error
                .downcast_ref::<matrix_sdk::HttpError>()
                .and_then(matrix_sdk::HttpError::as_client_api_error)
        },
        matrix_sdk::Error::as_client_api_error,
    )
}

fn classify_api_error(api_error: &matrix_sdk::ruma::api::error::Error) -> Option<Expected> {
    use tracing::Level;

    let status = api_error.status_code;
    let kind = api_error.error_kind();
    Some(match kind {
        Some(ErrorKind::UserLocked) => Expected::new(
            RpcError::AccountLocked,
            Level::WARN,
            "locked",
            "the account is locked",
        ),
        Some(ErrorKind::UserSuspended) => Expected::new(
            RpcError::AccountSuspended,
            Level::WARN,
            "suspended",
            "the account is suspended",
        ),
        Some(ErrorKind::UnknownToken(_) | ErrorKind::MissingToken) => Expected::new(
            RpcError::NotLoggedIn,
            Level::DEBUG,
            "auth",
            "the access token is no longer valid",
        ),
        Some(ErrorKind::TooLarge) => Expected::new(
            RpcError::MessageTooLarge,
            Level::DEBUG,
            "too_large",
            "the homeserver refused the size",
        ),
        Some(ErrorKind::LimitExceeded(limit)) => Expected::new(
            RpcError::RateLimited {
                retry_after_ms: limit.retry_after.as_ref().and_then(retry_delay_ms),
            },
            Level::WARN,
            "rate_limited",
            "homeserver request refused",
        ),
        Some(ErrorKind::Unrecognized) => Expected::new(
            RpcError::Unsupported,
            Level::INFO,
            "unsupported",
            "homeserver does not implement this endpoint",
        ),
        Some(ErrorKind::Forbidden) => Expected::new(
            RpcError::Denied,
            Level::WARN,
            "denied",
            "homeserver request refused",
        ),
        // Namespaced by an MSC, such as `UK.TIMEDOUT.MSC4406.SENDER_IGNORED`.
        Some(kind) if !kind.errcode().as_str().starts_with("M_") => Expected::new(
            RpcError::Denied,
            Level::WARN,
            "denied",
            "homeserver request refused",
        ),
        _ if status.as_u16() == 429 => Expected::new(
            RpcError::RateLimited {
                retry_after_ms: None,
            },
            Level::WARN,
            "rate_limited",
            "homeserver request refused",
        ),
        _ if matches!(status.as_u16(), 401 | 403) => Expected::new(
            RpcError::Denied,
            Level::WARN,
            "denied",
            "homeserver request refused",
        ),
        _ if status.as_u16() == 404 => Expected::new(
            RpcError::NotFound,
            Level::DEBUG,
            "not_found",
            "the homeserver does not have it",
        ),
        _ if status.is_server_error() => Expected::new(
            RpcError::Unavailable,
            Level::WARN,
            "server",
            "homeserver request failed",
        ),
        _ => return None,
    })
}

fn classify_one(error: &(dyn Error + 'static)) -> Option<Expected> {
    use tracing::Level;

    if matches!(
        error.downcast_ref::<RoomSendQueueStorageError>(),
        Some(RoomSendQueueStorageError::EventTooLarge)
    ) {
        return Some(Expected::new(
            RpcError::MessageTooLarge,
            Level::DEBUG,
            "too_large",
            "the event is too large to queue",
        ));
    }
    if let Some(expected) = client_api_error(error).and_then(classify_api_error) {
        return Some(expected);
    }
    if matches!(http_error(error), Some(matrix_sdk::HttpError::Reqwest(_)))
        || error.is::<reqwest::Error>()
    {
        return Some(Expected::new(
            RpcError::Unavailable,
            Level::WARN,
            "network",
            "homeserver request failed",
        ));
    }
    if matches!(
        error.downcast_ref::<matrix_sdk::Error>(),
        Some(matrix_sdk::Error::InsufficientData)
    ) {
        return Some(Expected::new(
            RpcError::Unavailable,
            Level::DEBUG,
            "unknown_room",
            "nothing is known about this room",
        ));
    }
    if matches!(
        error.downcast_ref::<TimelineError>(),
        Some(TimelineError::UnsupportedEvent)
    ) {
        return Some(Expected::new(
            RpcError::Unsupported,
            Level::DEBUG,
            "unsupported",
            "the event cannot be used here",
        ));
    }
    None
}

fn classify(error: &(dyn Error + 'static)) -> Option<Expected> {
    let mut cause = Some(error);
    while let Some(error) = cause {
        if let Some(expected) = classify_one(error) {
            return Some(expected);
        }
        // Transparent SDK wrappers omit their inner error from source().
        cause = if let Some(TimelineError::SendQueueError(inner)) =
            error.downcast_ref::<TimelineError>()
        {
            Some(inner)
        } else if let Some(RoomSendQueueError::StorageError(inner)) =
            error.downcast_ref::<RoomSendQueueError>()
        {
            Some(inner)
        } else {
            error.source()
        };
    }
    None
}

impl Core {
    /// The one place an error becomes an `RpcError`. What the homeserver or the
    /// user caused stays out of the error log, which is what gets reported.
    pub(crate) fn rpc_error(&self, context: &str, error: &(dyn Error + 'static)) -> RpcError {
        match classify(error) {
            Some(expected) => {
                expected.log(context, error);
                expected.rpc
            }
            None => self.failed(context, error_chain(error)),
        }
    }

    pub fn failed(&self, context: &str, error: impl Display) -> RpcError {
        let log_id = format!("e{}", self.next_log_id.fetch_add(1, Ordering::Relaxed));
        tracing::error!(log_id, context, "{error}");
        RpcError::Failed { log_id }
    }

    pub(crate) fn oauth_login_error(&self, context: &str, error: &OAuthError) -> RpcError {
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
            return RpcError::AuthProviderUnreachable;
        }
        self.rpc_error(context, error)
    }

    pub(crate) fn recovery_error(&self, error: &RecoveryError) -> RpcError {
        if matches!(
            error,
            RecoveryError::SecretStorage(SecretStorageError::SecretStorageKey(_))
        ) {
            return RpcError::Denied;
        }
        if let RecoveryError::SecretStorage(SecretStorageError::ImportError { name, error }) = error
        {
            tracing::warn!(
                context = "recover_identity",
                %name,
                "secret storage is out of sync with the account: {error}"
            );
            return RpcError::KeyStorageOutOfSync;
        }
        self.rpc_error("recover_identity", error)
    }

    pub(crate) fn profile_error(&self, error: &matrix_sdk::Error) -> RpcError {
        if matches!(
            error.client_api_error_kind(),
            Some(ErrorKind::Forbidden | ErrorKind::BadJson)
        ) || error
            .as_client_api_error()
            .is_some_and(|api_error| api_error.status_code == http::StatusCode::NOT_FOUND)
        {
            tracing::debug!(
                context = "user_profile",
                "the homeserver does not show this profile"
            );
            return RpcError::Unavailable;
        }
        self.rpc_error("user_profile", error)
    }

    pub(crate) fn discovery_error(&self, error: impl Into<crate::session::BuildError>) -> RpcError {
        match error.into() {
            crate::session::BuildError::Sdk(matrix_sdk::ClientBuildError::Http(error)) => {
                self.rpc_error("login_flows_discovery", &error)
            }
            crate::session::BuildError::Store(error) => self.failed("account_store", error),
            crate::session::BuildError::Sdk(_) => RpcError::UnknownHomeserver,
        }
    }
}

fn error_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

#[cfg(test)]
mod tests {
    use std::{
        io::{self, Write},
        sync::Arc,
        time::Duration,
    };

    use parking_lot::Mutex;

    use matrix_sdk::ruma::api::error::{
        ErrorBody, FromHttpResponseError, RetryAfter, StandardErrorBody,
    };
    use matrix_sdk::{HttpError, RumaApiError};

    use super::error_chain;

    use crate::Core;
    use crate::protocol::RpcError;
    use crate::store::MemorySessionStore;

    use super::{ResultExt, retry_delay_ms};

    #[derive(Clone)]
    struct TestWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for TestWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.lock().write(bytes)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.lock().flush()
        }
    }

    type Check = fn(&RpcError) -> bool;

    fn capture<T>(run: impl FnOnce(&Core) -> T) -> (T, String) {
        let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
        let output = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .without_time()
            .with_max_level(tracing::Level::DEBUG)
            .with_writer({
                let output = output.clone();
                move || TestWriter(output.clone())
            })
            .finish();
        let result = tracing::subscriber::with_default(subscriber, || run(&core));
        let log = String::from_utf8(output.lock().clone()).unwrap();
        (result, log)
    }

    fn api_error(status: u16, errcode: &str) -> HttpError {
        let body: StandardErrorBody =
            serde_json::from_value(serde_json::json!({ "errcode": errcode, "error": "refused" }))
                .unwrap();
        let error = matrix_sdk::ruma::api::error::Error::new(
            http::StatusCode::from_u16(status).unwrap(),
            ErrorBody::Standard(body),
        );
        HttpError::Api(Box::new(FromHttpResponseError::Server(
            RumaApiError::MatrixError(error),
        )))
    }

    #[test]
    fn or_failed_records_the_given_label() {
        let (result, log) =
            capture(|core| Err::<(), _>(io::Error::other("problem")).or_failed(core, "test_label"));

        assert!(matches!(result, Err(RpcError::Failed { .. })));
        assert!(log.contains("context=\"test_label\""), "{log}");
        assert!(log.contains("ERROR"), "{log}");
    }

    #[test]
    fn a_failure_nobody_expected_stays_an_error() {
        let (result, log) =
            capture(|core| Err::<(), _>(api_error(400, "M_BAD_JSON")).or_failed(core, "probe"));

        assert!(matches!(result, Err(RpcError::Failed { .. })));
        assert!(log.contains("ERROR"), "{log}");
    }

    #[test]
    fn what_a_homeserver_answers_is_classified_below_error() {
        let cases: [(HttpError, Check, &str); 11] = [
            (
                api_error(401, "M_UNKNOWN_TOKEN"),
                |e| matches!(e, RpcError::NotLoggedIn),
                "DEBUG",
            ),
            (
                api_error(401, "M_MISSING_TOKEN"),
                |e| matches!(e, RpcError::NotLoggedIn),
                "DEBUG",
            ),
            (
                api_error(403, "M_FORBIDDEN"),
                |e| matches!(e, RpcError::Denied),
                "WARN",
            ),
            (
                api_error(404, "M_NOT_FOUND"),
                |e| matches!(e, RpcError::NotFound),
                "DEBUG",
            ),
            (
                api_error(404, "M_UNRECOGNIZED"),
                |e| matches!(e, RpcError::Unsupported),
                "INFO",
            ),
            (
                api_error(400, "UK.TIMEDOUT.MSC4406.SENDER_IGNORED"),
                |e| matches!(e, RpcError::Denied),
                "WARN",
            ),
            (
                api_error(429, "M_LIMIT_EXCEEDED"),
                |e| matches!(e, RpcError::RateLimited { .. }),
                "WARN",
            ),
            (
                api_error(502, "M_UNKNOWN"),
                |e| matches!(e, RpcError::Unavailable),
                "WARN",
            ),
            (
                api_error(503, "M_UNKNOWN"),
                |e| matches!(e, RpcError::Unavailable),
                "WARN",
            ),
            (
                api_error(413, "M_TOO_LARGE"),
                |e| matches!(e, RpcError::MessageTooLarge),
                "DEBUG",
            ),
            (
                api_error(403, "M_USER_LOCKED"),
                |e| matches!(e, RpcError::AccountLocked),
                "WARN",
            ),
        ];
        for (error, expected, level) in cases {
            let text = error.to_string();
            let (result, log) = capture(|core| Err::<(), _>(error).or_failed(core, "probe"));
            let rpc = result.unwrap_err();
            assert!(expected(&rpc), "{text}: {rpc:?}");
            assert!(
                log.contains(level),
                "{text} logged at the wrong level: {log}"
            );
            assert!(!log.contains("ERROR"), "{text}: {log}");
        }
    }

    #[test]
    fn an_sdk_error_wrapping_the_response_is_classified_too() {
        let (result, log) = capture(|core| {
            Err::<(), _>(matrix_sdk::Error::Http(Box::new(api_error(
                403,
                "M_FORBIDDEN",
            ))))
            .or_failed(core, "probe")
        });

        assert!(matches!(result, Err(RpcError::Denied)));
        assert!(!log.contains("ERROR"), "{log}");
    }

    #[test]
    fn a_dropped_connection_is_unavailable() {
        let transport = reqwest::Client::new().get("not a url").build().unwrap_err();
        let (result, log) =
            capture(|core| Err::<(), _>(HttpError::Reqwest(transport)).or_failed(core, "probe"));

        assert!(matches!(result, Err(RpcError::Unavailable)));
        assert!(log.contains("WARN"), "{log}");
        assert!(!log.contains("ERROR"), "{log}");
    }

    #[test]
    fn an_event_that_cannot_be_used_is_unsupported() {
        let (result, log) = capture(|core| {
            Err::<(), _>(matrix_sdk_ui::timeline::Error::UnsupportedEvent).or_failed(core, "probe")
        });

        assert!(matches!(result, Err(RpcError::Unsupported)));
        assert!(!log.contains("ERROR"), "{log}");
    }

    #[test]
    fn a_missing_profile_is_unavailable() {
        let (result, log) = capture(|core| {
            core.profile_error(&matrix_sdk::Error::Http(Box::new(api_error(
                404,
                "M_NOT_FOUND",
            ))))
        });

        assert!(matches!(result, RpcError::Unavailable));
        assert!(!log.contains("ERROR"), "{log}");
    }

    #[test]
    fn a_profile_the_homeserver_hides_is_unavailable() {
        let (result, log) = capture(|core| {
            core.profile_error(&matrix_sdk::Error::Http(Box::new(api_error(
                403,
                "M_FORBIDDEN",
            ))))
        });

        assert!(matches!(result, RpcError::Unavailable));
        assert!(!log.contains("ERROR"), "{log}");
    }

    #[test]
    fn a_room_nothing_is_known_about_is_unavailable() {
        let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
        let result = Err::<(), _>(matrix_sdk::Error::InsufficientData).or_failed(&core, "preview");
        assert!(matches!(result, Err(RpcError::Unavailable)));
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

    #[derive(Debug)]
    struct Outer(io::Error);

    impl std::fmt::Display for Outer {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("error sending request")
        }
    }

    impl std::error::Error for Outer {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }

    #[test]
    fn the_error_chain_names_every_cause() {
        let error = Outer(io::Error::other(
            "NetworkError when attempting to fetch resource.",
        ));

        assert_eq!(
            error_chain(&error),
            "error sending request: NetworkError when attempting to fetch resource."
        );
    }
}
