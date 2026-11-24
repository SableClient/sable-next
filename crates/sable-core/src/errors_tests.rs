use std::{io, sync::Arc, time::Duration};

use parking_lot::Mutex;

use matrix_sdk::ruma::api::error::{
    ErrorBody, FromHttpResponseError, RetryAfter, StandardErrorBody,
};
use matrix_sdk::{HttpError, RumaApiError};

use super::{CoreError, ReportExt as _};

use crate::Core;
use crate::protocol::{RpcCode, RpcError};
use crate::store::MemorySessionStore;
use crate::test_support::TestWriter;

use super::{ResultExt, retry_delay_ms};

type Check = fn(&RpcCode) -> bool;

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
    let error = ruma::api::error::Error::new(
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

    let Err(RpcError {
        code: RpcCode::Failed { .. },
        report: Some(report),
    }) = result
    else {
        panic!("{result:?}");
    };
    let messages: Vec<_> = report
        .frames
        .iter()
        .map(|frame| frame.message.as_str())
        .collect();
    assert_eq!(messages, ["test_label", "problem"]);
    assert!(
        report.frames[1]
            .debug
            .as_deref()
            .is_some_and(|debug| debug.contains("Custom"))
    );
    assert!(log.contains("context=\"test_label\""), "{log}");
    assert!(log.contains("ERROR"), "{log}");
}

#[test]
fn a_failure_nobody_expected_stays_an_error() {
    let (result, log) =
        capture(|core| Err::<(), _>(api_error(400, "M_BAD_JSON")).or_failed(core, "probe"));

    assert!(matches!(
        result,
        Err(RpcError {
            code: RpcCode::Failed { .. },
            ..
        })
    ));
    assert!(log.contains("ERROR"), "{log}");
}

#[test]
fn what_a_homeserver_answers_is_classified_below_error() {
    let cases: [(HttpError, Check, &str); 13] = [
        (
            api_error(401, "M_UNKNOWN_TOKEN"),
            |e| matches!(e, RpcCode::NotLoggedIn),
            "DEBUG",
        ),
        (
            api_error(401, "M_MISSING_TOKEN"),
            |e| matches!(e, RpcCode::NotLoggedIn),
            "DEBUG",
        ),
        (
            api_error(403, "M_FORBIDDEN"),
            |e| matches!(e, RpcCode::Denied),
            "WARN",
        ),
        (
            api_error(404, "M_NOT_FOUND"),
            |e| matches!(e, RpcCode::NotFound),
            "DEBUG",
        ),
        (
            api_error(404, "M_UNRECOGNIZED"),
            |e| matches!(e, RpcCode::Unsupported),
            "INFO",
        ),
        (
            api_error(400, "UK.TIMEDOUT.MSC4406.SENDER_IGNORED"),
            |e| matches!(e, RpcCode::Denied),
            "WARN",
        ),
        (
            api_error(429, "M_LIMIT_EXCEEDED"),
            |e| matches!(e, RpcCode::RateLimited { .. }),
            "WARN",
        ),
        (
            api_error(502, "M_UNKNOWN"),
            |e| matches!(e, RpcCode::Unavailable),
            "WARN",
        ),
        (
            api_error(503, "M_UNKNOWN"),
            |e| matches!(e, RpcCode::Unavailable),
            "WARN",
        ),
        (
            api_error(413, "M_TOO_LARGE"),
            |e| matches!(e, RpcCode::MessageTooLarge),
            "DEBUG",
        ),
        (
            api_error(403, "M_USER_LOCKED"),
            |e| matches!(e, RpcCode::AccountLocked),
            "WARN",
        ),
        (
            HttpError::RefreshToken(matrix_sdk::RefreshTokenError::RefreshTokenRequired),
            |e| matches!(e, RpcCode::NotLoggedIn),
            "DEBUG",
        ),
        (
            HttpError::RefreshToken(matrix_sdk::RefreshTokenError::MatrixAuth(Arc::new(
                api_error(503, "M_UNKNOWN"),
            ))),
            |e| matches!(e, RpcCode::Unavailable),
            "WARN",
        ),
    ];
    for (error, expected, level) in cases {
        let text = error.to_string();
        let (result, log) = capture(|core| Err::<(), _>(error).or_failed(core, "probe"));
        let rpc = result.unwrap_err();
        assert!(expected(&rpc.code), "{text}: {rpc:?}");
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

    assert!(matches!(
        result,
        Err(RpcError {
            code: RpcCode::Denied,
            ..
        })
    ));
    assert!(!log.contains("ERROR"), "{log}");
}

#[test]
fn a_dropped_connection_is_unavailable() {
    let transport = reqwest::Client::new().get("not a url").build().unwrap_err();
    let (result, log) =
        capture(|core| Err::<(), _>(HttpError::Reqwest(transport)).or_failed(core, "probe"));

    assert!(matches!(
        result,
        Err(RpcError {
            code: RpcCode::Unavailable,
            ..
        })
    ));
    assert!(log.contains("WARN"), "{log}");
    assert!(!log.contains("ERROR"), "{log}");

    let (shared, log) = capture(|core| {
        Err::<(), _>(matrix_sdk::Error::ConcurrentRequestFailed).or_failed(core, "room_members")
    });
    assert!(matches!(
        shared,
        Err(RpcError {
            code: RpcCode::Unavailable,
            ..
        })
    ));
    assert!(!log.contains("ERROR"), "{log}");
}

#[test]
fn an_event_that_cannot_be_used_is_unsupported() {
    let (result, log) = capture(|core| {
        Err::<(), _>(matrix_sdk_ui::timeline::Error::UnsupportedEvent).or_failed(core, "probe")
    });

    assert!(matches!(
        result,
        Err(RpcError {
            code: RpcCode::Unsupported,
            ..
        })
    ));
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

    assert!(matches!(
        result,
        RpcError {
            code: RpcCode::Unavailable,
            ..
        }
    ));
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

    assert!(matches!(
        result,
        RpcError {
            code: RpcCode::Unavailable,
            ..
        }
    ));
    assert!(!log.contains("ERROR"), "{log}");
}

#[test]
fn a_room_nothing_is_known_about_is_unavailable() {
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let result = Err::<(), _>(matrix_sdk::Error::InsufficientData).or_failed(&core, "preview");
    assert!(matches!(
        result,
        Err(RpcError {
            code: RpcCode::Unavailable,
            ..
        })
    ));
}

#[test]
fn a_read_while_the_stores_are_closed_is_unavailable() {
    let closed = matrix_sdk::Error::StateStore(Box::new(
        matrix_sdk_base::store::StoreError::Backend("The store is closed".into()),
    ));
    let (result, log) = capture(|core| Err::<(), _>(closed).or_failed(core, "room_members"));

    assert!(matches!(
        result,
        Err(RpcError {
            code: RpcCode::Unavailable,
            ..
        })
    ));
    assert!(!log.contains("ERROR"), "{log}");
}

#[test]
fn a_jump_to_a_missing_event_is_not_found() {
    let missing = super::TimelineError::from(matrix_sdk_ui::timeline::PaginationError::from(
        matrix_sdk::paginators::PaginatorError::EventNotFound(matrix_sdk::ruma::owned_event_id!(
            "$gone:example.org"
        )),
    ));
    let (result, log) =
        capture(|core| Err::<(), _>(missing).or_failed(core, "build_focused_timeline"));

    assert!(matches!(
        result,
        Err(RpcError {
            code: RpcCode::NotFound,
            ..
        })
    ));
    assert!(!log.contains("ERROR"), "{log}");
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
fn a_report_names_every_cause_and_where_it_was_raised() {
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let error = Outer(io::Error::other(
        "NetworkError when attempting to fetch resource.",
    ));
    let (raised, failure) = (line!(), core.failed_with("sync", &error));
    let RpcError {
        code: RpcCode::Failed { .. },
        report: Some(report),
    } = failure
    else {
        panic!("not a failure");
    };

    let messages: Vec<_> = report
        .frames
        .iter()
        .map(|frame| frame.message.as_str())
        .collect();
    assert_eq!(
        messages,
        [
            "sync",
            "error sending request",
            "NetworkError when attempting to fetch resource."
        ]
    );
    let at = format!("{}:{raised}:", file!());
    assert!(
        report.frames.iter().any(|frame| frame
            .location
            .as_deref()
            .is_some_and(|l| l.starts_with(&at))),
        "{report:#?}"
    );
    assert!(
        report.frames[2]
            .debug
            .as_deref()
            .is_some_and(|d| d.contains("Custom"))
    );
}

#[test]
fn a_report_keeps_what_the_homeserver_answered() {
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let RpcError {
        code: RpcCode::Failed { .. },
        report: Some(report),
    } = core.failed_with("probe", &api_error(400, "M_BAD_JSON"))
    else {
        panic!("not a failure");
    };

    let http = report.http.expect("http");
    assert_eq!(http.status, Some(400));
    assert_eq!(http.errcode.as_deref(), Some("M_BAD_JSON"));
    assert_eq!(http.message.as_deref(), Some("refused"));
}

#[test]
fn a_core_error_raised_in_a_helper_keeps_its_line() {
    const RAISED: u32 = line!() + 2;
    fn helper() -> Result<(), CoreError> {
        Err(io::Error::other("disk full")).backend()
    }
    let (result, _log) = capture(|core| super::CoreResultExt::or_report(helper(), core, "persist"));

    let Err(RpcError {
        code: RpcCode::Failed { .. },
        report: Some(report),
    }) = result
    else {
        panic!("{result:?}");
    };
    let at = format!("{}:{RAISED}:", file!());
    assert!(
        report.frames.iter().any(|frame| frame
            .location
            .as_deref()
            .is_some_and(|l| l.starts_with(&at))),
        "{report:#?}"
    );
}

#[test]
fn an_expected_failure_from_a_helper_keeps_its_code() {
    fn helper() -> Result<(), CoreError> {
        Err(api_error(403, "M_FORBIDDEN")).backend()
    }
    let (result, log) = capture(|core| super::CoreResultExt::or_report(helper(), core, "probe"));

    assert!(
        matches!(
            result,
            Err(RpcError {
                code: RpcCode::Denied,
                ..
            })
        ),
        "{result:?}"
    );
    assert!(!log.contains("ERROR"), "{log}");
}

#[test]
fn a_report_carries_the_spans_it_failed_in() {
    use tracing_subscriber::layer::SubscriberExt as _;

    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let subscriber = tracing_subscriber::registry().with(tracing_error::ErrorLayer::default());
    let report = tracing::subscriber::with_default(subscriber, || {
        let _span = tracing::info_span!("rpc", method = "rooms.join").entered();
        match core.failed_with("join", &io::Error::other("refused")) {
            RpcError {
                code: RpcCode::Failed { .. },
                report: Some(report),
            } => report,
            other => panic!("{other:?}"),
        }
    });

    let trace = report.span_trace.expect("span trace");
    assert!(
        trace.contains("rpc") && trace.contains("rooms.join"),
        "{trace}"
    );
}

#[test]
fn a_classified_code_carries_the_report_it_came_from() {
    let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
    let error = Err::<(), _>(api_error(403, "M_FORBIDDEN"))
        .or_failed(&core, "kick")
        .unwrap_err();

    assert!(matches!(error.code, RpcCode::Denied));
    let report = error.report.expect("report");
    assert_eq!(report.frames[0].message, "kick");
    assert_eq!(
        report.http.and_then(|http| http.errcode).as_deref(),
        Some("M_FORBIDDEN")
    );
}

#[test]
fn a_code_the_caller_chose_keeps_the_error_as_its_report() {
    let error = super::coded(
        "probe",
        RpcCode::Unavailable,
        &io::Error::other("connection reset"),
    );

    assert!(matches!(error.code, RpcCode::Unavailable));
    let report = error.report.expect("report");
    let messages: Vec<_> = report
        .frames
        .iter()
        .map(|frame| frame.message.as_str())
        .collect();
    assert_eq!(messages, ["probe", "connection reset"]);
    assert!(
        report.frames.iter().any(|frame| frame
            .location
            .as_deref()
            .is_some_and(|at| at.starts_with(file!()))),
        "{report:?}"
    );
}

#[test]
fn the_report_rides_beside_the_code_on_the_wire() {
    let error = super::coded("probe", RpcCode::Denied, &io::Error::other("no"));
    let json = serde_json::to_value(&error).unwrap();

    assert_eq!(json["code"], "denied");
    assert_eq!(json["report"]["frames"][0]["message"], "probe");
    let bare = serde_json::to_value(RpcError::from(RpcCode::Denied)).unwrap();
    assert_eq!(bare, serde_json::json!({ "code": "denied" }));
}

#[test]
fn a_url_in_an_error_loses_its_query() {
    let text = "error sending request for url (https://hs.example/_matrix/client/v3/sync?since=s72_secret&timeout=0): refused";

    assert_eq!(
        super::without_queries(text),
        "error sending request for url (https://hs.example/_matrix/client/v3/sync): refused"
    );
}

#[tokio::test]
async fn a_transport_error_reports_no_query() {
    let transport = reqwest::Client::new()
        .get("http://127.0.0.1:1/sync?since=s72_secret")
        .send()
        .await
        .unwrap_err();
    let error = super::coded("sync", RpcCode::Unavailable, &transport);

    let sent = serde_json::to_string(&error).unwrap();
    assert!(sent.contains("127.0.0.1:1/sync"), "{sent}");
    assert!(!sent.contains("s72_secret"), "{sent}");
}

#[test]
fn a_huge_body_is_cut_and_only_the_root_cause_keeps_its_debug() {
    let body = "x".repeat(3 * super::DETAIL_LIMIT);
    let error = ruma::api::error::Error::new(
        http::StatusCode::BAD_GATEWAY,
        ErrorBody::NotJson {
            bytes: body.into(),
            deserialization_error: Arc::new(
                serde_json::from_str::<serde_json::Value>("x").unwrap_err(),
            ),
        },
    );
    let error = HttpError::Api(Box::new(FromHttpResponseError::Server(
        RumaApiError::MatrixError(error),
    )));
    let report = super::coded("probe", RpcCode::Unavailable, &error)
        .report
        .unwrap();

    let body = report.http.unwrap().body.unwrap();
    assert_eq!(body.len(), super::DETAIL_LIMIT);
    let with_debug = report.frames.iter().filter(|frame| frame.debug.is_some());
    assert_eq!(with_debug.count(), 1);
    assert!(report.frames.iter().all(|frame| {
        frame.message.len() <= super::DETAIL_LIMIT + 4
            && frame
                .debug
                .as_ref()
                .is_none_or(|d| d.len() <= super::DETAIL_LIMIT + 4)
    }));
}
