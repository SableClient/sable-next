use std::{error::Error, fmt::Display, panic::Location, sync::atomic::Ordering};

use error_stack::Report;
use matrix_sdk::authentication::oauth::error::{
    OAuthClientRegistrationError, OAuthError, RequestTokenError,
};
use matrix_sdk::encryption::{recovery::RecoveryError, secret_storage::SecretStorageError};
use matrix_sdk::ruma::api::error::{ErrorBody, ErrorKind, RetryAfter};
use matrix_sdk::send_queue::{RoomSendQueueError, RoomSendQueueStorageError};
use matrix_sdk::{SendOutsideWasm, SyncOutsideWasm};
use matrix_sdk_ui::timeline::Error as TimelineError;
use web_time::SystemTime;

use crate::protocol::{
    CoreEvent, ErrorFrameView, ErrorReportView, HttpFailureView, RpcCode, RpcError,
};

use crate::Core;

#[cfg(not(target_family = "wasm"))]
pub(crate) type Cause = Box<dyn Error + Send + Sync>;
#[cfg(target_family = "wasm")]
pub(crate) type Cause = Box<dyn Error>;

pub(crate) trait Source: Error + SendOutsideWasm + SyncOutsideWasm + 'static {}

impl<T: Error + SendOutsideWasm + SyncOutsideWasm + 'static> Source for T {}

/// One layer of a failure. SDK errors are not `Send` on the web, so a report
/// keeps what each error said rather than the error.
#[derive(Debug)]
struct Layer {
    message: String,
    debug: Option<String>,
}

impl Layer {
    fn text(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            debug: None,
        }
    }

    /// An outer error's `Debug` already prints its causes, so only the
    /// innermost one keeps its own.
    fn of(error: &(dyn Error + 'static), root: bool) -> Self {
        Self {
            message: capped(without_queries(&error.to_string()).into_owned()),
            debug: root.then(|| capped(without_queries(&format!("{error:#?}")).into_owned())),
        }
    }
}

impl Display for Layer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for Layer {}

#[derive(Debug, Clone)]
struct Http(HttpFailureView);

#[derive(Debug)]
struct Classified(Expected);

/// A state the core refuses to work from, as opposed to an operation that failed.
#[derive(Debug)]
struct Invalid(&'static str);

#[derive(Debug)]
pub struct CoreError(Report<Layer>);

impl CoreError {
    #[track_caller]
    pub(crate) fn new(error: &(dyn Error + 'static)) -> Self {
        let mut chain = vec![error];
        while let Some(cause) = chain.last().copied().and_then(next_cause) {
            chain.push(cause);
        }
        let mut causes = chain.iter().rev();
        let root = causes.next().copied().unwrap_or(error);
        let mut report = Report::new(Layer::of(root, true));
        for cause in causes {
            report = report.change_context(Layer::of(*cause, false));
        }
        if let Some(http) = chain.iter().find_map(|cause| http_failure(*cause)) {
            report = report.attach_opaque(Http(http));
        }
        if let Some(expected) = classify(error) {
            report = report.attach_opaque(Classified(expected));
        }
        Self(report)
    }

    #[track_caller]
    pub(crate) fn message(message: impl Into<String>) -> Self {
        Self(Report::new(Layer::text(message)))
    }

    #[track_caller]
    pub(crate) fn invalid(reason: &'static str) -> Self {
        Self(Report::new(Layer::text(reason)).attach_opaque(Invalid(reason)))
    }

    pub(crate) fn invalid_reason(&self) -> Option<&'static str> {
        self.0
            .frames()
            .find_map(|frame| frame.downcast_ref::<Invalid>())
            .map(|invalid| invalid.0)
    }

    #[track_caller]
    pub(crate) fn backend(error: impl Source) -> Self {
        Self::new(&error)
    }

    #[must_use]
    #[track_caller]
    pub(crate) fn wrap(self, what: impl Into<String>) -> Self {
        Self(self.0.change_context(Layer::text(what)))
    }

    #[must_use]
    #[track_caller]
    pub fn into_rpc(self, context: &str, code: RpcCode) -> RpcError {
        RpcError {
            code,
            report: Some(Box::new(self.wrap(context).report())),
        }
    }

    fn expected(&self) -> Option<&Expected> {
        self.0
            .frames()
            .find_map(|frame| frame.downcast_ref::<Classified>())
            .map(|classified| &classified.0)
    }

    fn layers(&self) -> impl Iterator<Item = &Layer> {
        self.0
            .frames()
            .filter_map(|frame| frame.downcast_ref::<Layer>())
    }

    pub(crate) fn report(&self) -> ErrorReportView {
        let mut frames = Vec::new();
        let mut location = None;
        for frame in self.0.frames() {
            if let Some(layer) = frame.downcast_ref::<Layer>() {
                frames.push(ErrorFrameView {
                    message: layer.message.clone(),
                    location: location.take(),
                    debug: layer.debug.clone(),
                });
            } else if let Some(at) = frame.downcast_ref::<Location<'static>>() {
                location = Some(format!("{}:{}:{}", at.file(), at.line(), at.column()));
            }
        }
        let attachment = |frame: &error_stack::Frame| {
            frame.downcast_ref::<Http>().map(|Http(view)| view.clone())
        };
        ErrorReportView {
            frames,
            http: self.0.frames().find_map(attachment),
            span_trace: self
                .0
                .frames()
                .find_map(|frame| frame.downcast_ref::<tracing_error::SpanTrace>())
                .map(ToString::to_string)
                .filter(|trace| !trace.is_empty()),
        }
    }
}

impl Display for CoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let messages: Vec<_> = self.layers().map(|layer| layer.message.as_str()).collect();
        formatter.write_str(&messages.join(": "))
    }
}

impl From<crate::store::StoreError> for CoreError {
    #[track_caller]
    fn from(error: crate::store::StoreError) -> Self {
        Self::new(&error)
    }
}

impl From<String> for CoreError {
    #[track_caller]
    fn from(message: String) -> Self {
        Self::message(message)
    }
}

impl From<&'static str> for CoreError {
    #[track_caller]
    fn from(reason: &'static str) -> Self {
        Self::invalid(reason)
    }
}

pub(crate) trait ReportExt<T> {
    fn backend(self) -> Result<T, CoreError>;
    fn context(self, what: &'static str) -> Result<T, CoreError>;
}

impl<T, E: Source> ReportExt<T> for Result<T, E> {
    #[track_caller]
    fn backend(self) -> Result<T, CoreError> {
        match self {
            Ok(value) => Ok(value),
            Err(error) => Err(CoreError::new(&error)),
        }
    }

    #[track_caller]
    fn context(self, what: &'static str) -> Result<T, CoreError> {
        match self {
            Ok(value) => Ok(value),
            Err(error) => Err(CoreError::new(&error).wrap(what)),
        }
    }
}

/// A response body or a large SDK value would otherwise flood the console and Sentry.
const DETAIL_LIMIT: usize = 4096;

/// A query can carry a sync token or a login code, and `reqwest` prints the
/// whole URL in both `Display` and `Debug`.
fn without_queries(text: &str) -> std::borrow::Cow<'_, str> {
    static QUERY: std::sync::LazyLock<Option<regex_lite::Regex>> = std::sync::LazyLock::new(|| {
        regex_lite::Regex::new(r#"(https?://[^\s?#"'<>)]+)\?[^\s"'<>)]*"#).ok()
    });
    QUERY
        .as_ref()
        .map_or_else(|| text.into(), |query| query.replace_all(text, "$1"))
}

fn capped(mut text: String) -> String {
    if text.len() > DETAIL_LIMIT {
        let mut end = DETAIL_LIMIT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push('…');
    }
    text
}

fn http_failure(error: &(dyn Error + 'static)) -> Option<HttpFailureView> {
    if let Some(api) = client_api_error(error) {
        let (errcode, message, body) = match &api.body {
            ErrorBody::Standard(body) => (
                Some(body.kind.errcode().as_str().to_owned()),
                Some(capped(body.message.clone())),
                None,
            ),
            ErrorBody::Json(json) => (None, None, Some(capped(json.to_string()))),
            ErrorBody::NotJson { bytes, .. } => {
                let shown = bytes.get(..bytes.len().min(DETAIL_LIMIT)).unwrap_or(bytes);
                (
                    None,
                    None,
                    Some(String::from_utf8_lossy(shown).into_owned()),
                )
            }
        };
        return Some(HttpFailureView {
            status: Some(api.status_code.as_u16()),
            errcode,
            message,
            body,
            url: None,
        });
    }
    let transport = match http_error(error) {
        Some(matrix_sdk::HttpError::Reqwest(transport)) => Some(transport),
        _ => error.downcast_ref::<reqwest::Error>(),
    }?;
    Some(HttpFailureView {
        status: transport.status().map(|status| status.as_u16()),
        errcode: None,
        message: None,
        body: None,
        url: transport.url().map(|url| {
            let mut url = url.clone();
            url.set_query(None);
            url.to_string()
        }),
    })
}

/// Transparent SDK wrappers omit their inner error from `source()`.
fn next_cause<'a>(error: &'a (dyn Error + 'static)) -> Option<&'a (dyn Error + 'static)> {
    if let Some(TimelineError::SendQueueError(inner)) = error.downcast_ref::<TimelineError>() {
        Some(inner)
    } else if let Some(RoomSendQueueError::StorageError(inner)) =
        error.downcast_ref::<RoomSendQueueError>()
    {
        Some(inner)
    } else {
        error.source()
    }
}

#[track_caller]
pub(crate) fn coded(context: &str, code: RpcCode, error: &(dyn Error + 'static)) -> RpcError {
    CoreError::new(error).into_rpc(context, code)
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

pub(crate) trait CoreResultExt<T> {
    fn or_report(self, core: &Core, label: &str) -> Result<T, RpcError>;
}

impl<T> CoreResultExt<T> for Result<T, CoreError> {
    #[track_caller]
    fn or_report(self, core: &Core, label: &str) -> Result<T, RpcError> {
        self.map_err(|error| core.report_error(label, error))
    }
}

impl<T, E: Error + 'static> ResultExt<T> for Result<T, E> {
    #[track_caller]
    fn or_failed(self, core: &Core, label: &str) -> Result<T, RpcError> {
        match self {
            Ok(value) => Ok(value),
            Err(error) => Err(core.rpc_error(label, &error)),
        }
    }
}

/// An outcome the user or the homeserver caused, not a defect to act on.
#[derive(Debug)]
struct Expected {
    code: RpcCode,
    level: tracing::Level,
    category: &'static str,
    message: &'static str,
}

impl Expected {
    const fn new(
        code: RpcCode,
        level: tracing::Level,
        category: &'static str,
        message: &'static str,
    ) -> Self {
        Self {
            code,
            level,
            category,
            message,
        }
    }

    fn log(&self, context: &str, error: &dyn Display) {
        let (category, message) = (self.category, self.message);
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

fn refresh_error<'error>(
    error: &'error (dyn Error + 'static),
) -> Option<&'error matrix_sdk::RefreshTokenError> {
    match http_error(error) {
        Some(matrix_sdk::HttpError::RefreshToken(refresh)) => Some(refresh),
        _ => error.downcast_ref::<matrix_sdk::RefreshTokenError>(),
    }
}

/// Mirrors the SDK's private `session_rejection`: these end the session for good.
fn rejects_session(refresh: &matrix_sdk::RefreshTokenError) -> bool {
    use matrix_sdk::RefreshTokenError;
    use matrix_sdk::authentication::oauth::error::BasicErrorResponseType;
    match refresh {
        RefreshTokenError::RefreshTokenRequired => true,
        RefreshTokenError::MatrixAuth(http) => matches!(
            http.client_api_error_kind(),
            Some(ErrorKind::UnknownToken(_))
        ),
        RefreshTokenError::OAuth(oauth) => matches!(
            &**oauth,
            OAuthError::RefreshToken(RequestTokenError::ServerResponse(response))
                if matches!(
                    response.error(),
                    BasicErrorResponseType::InvalidGrant | BasicErrorResponseType::InvalidClient
                )
        ),
    }
}

fn client_api_error<'a>(error: &'a (dyn Error + 'static)) -> Option<&'a ruma::api::error::Error> {
    error.downcast_ref::<matrix_sdk::Error>().map_or_else(
        || {
            error
                .downcast_ref::<matrix_sdk::HttpError>()
                .and_then(matrix_sdk::HttpError::as_client_api_error)
        },
        matrix_sdk::Error::as_client_api_error,
    )
}

fn classify_api_error(api_error: &ruma::api::error::Error) -> Option<Expected> {
    use tracing::Level;

    let status = api_error.status_code;
    let kind = api_error.error_kind();
    Some(match kind {
        Some(ErrorKind::UserLocked) => Expected::new(
            RpcCode::AccountLocked,
            Level::WARN,
            "locked",
            "the account is locked",
        ),
        Some(ErrorKind::UserSuspended) => Expected::new(
            RpcCode::AccountSuspended,
            Level::WARN,
            "suspended",
            "the account is suspended",
        ),
        Some(ErrorKind::UnknownToken(_) | ErrorKind::MissingToken) => Expected::new(
            RpcCode::NotLoggedIn,
            Level::DEBUG,
            "auth",
            "the access token is no longer valid",
        ),
        Some(ErrorKind::TooLarge) => Expected::new(
            RpcCode::MessageTooLarge,
            Level::DEBUG,
            "too_large",
            "the homeserver refused the size",
        ),
        Some(ErrorKind::LimitExceeded(limit)) => Expected::new(
            RpcCode::RateLimited {
                retry_after_ms: limit.retry_after.as_ref().and_then(retry_delay_ms),
            },
            Level::WARN,
            "rate_limited",
            "homeserver request refused",
        ),
        Some(ErrorKind::Unrecognized) => Expected::new(
            RpcCode::Unsupported,
            Level::INFO,
            "unsupported",
            "homeserver does not implement this endpoint",
        ),
        Some(ErrorKind::Forbidden) => Expected::new(
            RpcCode::Denied,
            Level::WARN,
            "denied",
            "homeserver request refused",
        ),
        // Namespaced by an MSC, such as `UK.TIMEDOUT.MSC4406.SENDER_IGNORED`.
        Some(kind) if !kind.errcode().as_str().starts_with("M_") => Expected::new(
            RpcCode::Denied,
            Level::WARN,
            "denied",
            "homeserver request refused",
        ),
        _ if status.as_u16() == 429 => Expected::new(
            RpcCode::RateLimited {
                retry_after_ms: None,
            },
            Level::WARN,
            "rate_limited",
            "homeserver request refused",
        ),
        _ if matches!(status.as_u16(), 401 | 403) => Expected::new(
            RpcCode::Denied,
            Level::WARN,
            "denied",
            "homeserver request refused",
        ),
        _ if status.as_u16() == 404 => Expected::new(
            RpcCode::NotFound,
            Level::DEBUG,
            "not_found",
            "the homeserver does not have it",
        ),
        _ if status.is_server_error() => Expected::new(
            RpcCode::Unavailable,
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
            RpcCode::MessageTooLarge,
            Level::DEBUG,
            "too_large",
            "the event is too large to queue",
        ));
    }
    if let Some(refresh) = refresh_error(error) {
        return Some(if rejects_session(refresh) {
            Expected::new(
                RpcCode::NotLoggedIn,
                Level::DEBUG,
                "auth",
                "the session can no longer be refreshed",
            )
        } else {
            Expected::new(
                RpcCode::Unavailable,
                Level::WARN,
                "server",
                "the access token could not be refreshed",
            )
        });
    }
    if let Some(expected) = client_api_error(error).and_then(classify_api_error) {
        return Some(expected);
    }
    if matches!(http_error(error), Some(matrix_sdk::HttpError::Reqwest(_)))
        || error.is::<reqwest::Error>()
    {
        return Some(Expected::new(
            RpcCode::Unavailable,
            Level::WARN,
            "network",
            "homeserver request failed",
        ));
    }
    // matrix-sdk-sqlite keeps its error type private, so its message is the only handle.
    if error.to_string() == "The store is closed" {
        return Some(Expected::new(
            RpcCode::Unavailable,
            Level::DEBUG,
            "store_closed",
            "the stores are closed while the app is suspended",
        ));
    }
    if matches!(
        error.downcast_ref::<matrix_sdk::paginators::PaginatorError>(),
        Some(matrix_sdk::paginators::PaginatorError::EventNotFound(_))
    ) {
        return Some(Expected::new(
            RpcCode::NotFound,
            Level::DEBUG,
            "missing_event",
            "the event is gone or out of reach",
        ));
    }
    if matches!(
        error.downcast_ref::<matrix_sdk::Error>(),
        Some(matrix_sdk::Error::ConcurrentRequestFailed)
    ) {
        // The request it waited on failed, and that one was logged where it ran.
        return Some(Expected::new(
            RpcCode::Unavailable,
            Level::WARN,
            "network",
            "a shared homeserver request failed",
        ));
    }
    if matches!(
        error.downcast_ref::<matrix_sdk::Error>(),
        Some(matrix_sdk::Error::InsufficientData)
    ) {
        return Some(Expected::new(
            RpcCode::Unavailable,
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
            RpcCode::Unsupported,
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
        cause = next_cause(error);
    }
    None
}

impl Core {
    /// The one place an error becomes an `RpcError`. What the homeserver or the
    /// user caused stays out of the error log, which is what gets reported.
    #[track_caller]
    pub(crate) fn rpc_error(&self, context: &str, error: &(dyn Error + 'static)) -> RpcError {
        self.report_error(context, CoreError::new(error))
    }

    #[track_caller]
    pub(crate) fn report_error(&self, context: &str, error: CoreError) -> RpcError {
        match error.expected() {
            Some(expected) => {
                expected.log(context, &error);
                RpcError {
                    code: expected.code.clone(),
                    report: Some(Box::new(error.wrap(context).report())),
                }
            }
            None => self.failed_report(context, error),
        }
    }

    #[track_caller]
    pub fn failed(&self, context: &str, error: impl Display) -> RpcError {
        self.failed_report(context, CoreError::message(error.to_string()))
    }

    #[track_caller]
    pub fn failed_with(&self, context: &str, error: &(dyn Error + 'static)) -> RpcError {
        self.failed_report(context, CoreError::new(error))
    }

    #[track_caller]
    pub(crate) fn failed_report(&self, context: &str, error: CoreError) -> RpcError {
        let error = error.wrap(context);
        let log_id = format!("e{}", self.next_log_id.fetch_add(1, Ordering::Relaxed));
        tracing::error!(log_id, context, "{error}");
        let report = Box::new(error.report());
        self.emit(CoreEvent::Failure {
            log_id: log_id.clone(),
            context: context.to_owned(),
            report: report.clone(),
        });
        RpcError {
            code: RpcCode::Failed { log_id },
            report: Some(report),
        }
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
            return coded(context, RpcCode::AuthProviderUnreachable, error);
        }
        self.rpc_error(context, error)
    }

    pub(crate) fn recovery_error(&self, error: &RecoveryError) -> RpcError {
        if matches!(
            error,
            RecoveryError::SecretStorage(SecretStorageError::SecretStorageKey(_))
        ) {
            return coded("recover_identity", RpcCode::Denied, error);
        }
        let outer = error;
        if let RecoveryError::SecretStorage(SecretStorageError::ImportError { name, error }) = error
        {
            tracing::warn!(
                context = "recover_identity",
                %name,
                "secret storage is out of sync with the account: {error}"
            );
            return coded("recover_identity", RpcCode::KeyStorageOutOfSync, outer);
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
            return coded("user_profile", RpcCode::Unavailable, error);
        }
        self.rpc_error("user_profile", error)
    }

    pub(crate) fn discovery_error(&self, error: impl Into<crate::session::BuildError>) -> RpcError {
        match error.into() {
            crate::session::BuildError::Sdk(matrix_sdk::ClientBuildError::Http(error)) => {
                self.rpc_error("login_flows_discovery", &error)
            }
            crate::session::BuildError::Store(error) => self.failed_with("account_store", &error),
            crate::session::BuildError::Sdk(error) => {
                coded("login_flows_discovery", RpcCode::UnknownHomeserver, &error)
            }
        }
    }
}

#[cfg(test)]
#[path = "errors_tests.rs"]
mod tests;
