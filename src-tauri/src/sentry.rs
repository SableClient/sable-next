use std::collections::BTreeSet;
use std::sync::{
    Arc, Mutex, PoisonError,
    atomic::{AtomicBool, Ordering},
};

#[cfg(not(target_os = "android"))]
fn consent_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        std::path::PathBuf::from(home)
            .join("Library/Application Support/Sable Next/sentry-consent"),
    )
}

#[cfg(not(target_os = "android"))]
fn consent() -> bool {
    consent_path().is_some_and(|path| std::fs::read(path).is_ok_and(|value| value == b"1"))
}

#[cfg(not(target_os = "android"))]
fn persist_consent(enabled: bool) {
    let Some(path) = consent_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, if enabled { b"1" } else { b"0" });
}

use sable_core::protocol::{ErrorFrameView, ErrorReportView};
use sentry::protocol::Event;

fn scrub_text(value: &str) -> String {
    use regex_lite::Regex;
    use std::sync::LazyLock;

    static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
        [
            (r"(?i)\bhttps?://[^/?#\s]+", "https://[HOMESERVER]"),
            (r#"(?i)(access_token|password|token|refresh_token|session_id|sync_token|next_batch)(["']?[=:\s]+["']?)([^\s&"']+)"#, "$1$2[REDACTED]"),
            (r#"@[^\s:@]+:[^\s,'"(){}\[\]]+"#, "@[USER_ID]"),
            (r#"![^\s:]+:[^\s,'"(){}\[\]]+"#, "![ROOM_ID]"),
            (r"![A-Za-z0-9_-]{43}", "![ROOM_ID]"),
            (r#"#[^\s:@]+:[^\s,'"(){}\[\]]+"#, "#[ROOM_ALIAS]"),
            (r"\$[A-Za-z0-9_+/-]{10,}", "$[EVENT_ID]"),
            (r"(?i)/(?:%21|!)[^/?#\s]*?(?:%3a|:)[^/?#\s]+", "/![ROOM_ID]"),
            (r"(?i)/(?:%40|@)[^/?#\s]*?(?:%3a|:)[^/?#\s]+", "/@[USER_ID]"),
            (r"(?i)/%21[^/?#\s]+", "/![ROOM_ID]"),
            (r"(?i)/%40[^/?#\s]+", "/@[USER_ID]"),
            (r"(?i)/%23[^/?#\s]+", "/[ROOM_ALIAS]"),
            (r"(?i)/%24[^/?#\s]+", "/[EVENT_ID]"),
            (r"(?i)([?&#](?:code|state|loginToken)=)[^&#\s]+", "$1[REDACTED]"),
            (r"[A-Za-z0-9+/]{40,}", "[KEY]"),
        ]
        .into_iter()
        .filter_map(|(pattern, replacement)| Regex::new(pattern).ok().map(|regex| (regex, replacement)))
        .collect()
    });
    PATTERNS
        .iter()
        .fold(value.to_owned(), |text, (regex, replacement)| {
            regex.replace_all(&text, *replacement).into_owned()
        })
}

const TAGGED_FIELDS: &[&str] = &["context", "cause", "age"];

fn tag_fields(event: &mut Event<'static>) {
    let Some(sentry::protocol::Context::Other(fields)) = event.contexts.get("Rust Tracing Fields")
    else {
        return;
    };
    let tags: Vec<_> = TAGGED_FIELDS
        .iter()
        .filter_map(|key| Some(((*key).to_owned(), fields.get(*key)?.as_str()?.to_owned())))
        .collect();
    event.tags.extend(tags);
}

fn source_frame(frame: &ErrorFrameView) -> Option<sentry::protocol::Frame> {
    let mut parts = frame.location.as_deref()?.rsplitn(3, ':');
    let colno = parts.next()?.parse().ok();
    let lineno = parts.next()?.parse().ok();
    Some(sentry::protocol::Frame {
        filename: Some(parts.next()?.to_owned()),
        lineno,
        colno,
        function: Some(frame.message.clone()),
        in_app: Some(true),
        ..Default::default()
    })
}

/// Reports a core failure, grouped by the line that raised it and sent once a
/// run, so one failing in a retry loop cannot spend the quota.
pub(crate) fn capture_failure(log_id: &str, context: &str, report: &ErrorReportView) {
    static REPORTED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

    let origin = report
        .frames
        .iter()
        .rev()
        .find_map(|frame| frame.location.as_deref());
    let key = origin.unwrap_or(context);
    if !REPORTED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(key.to_owned())
    {
        return;
    }
    let chain: Vec<_> = report
        .frames
        .iter()
        .map(|frame| frame.message.as_str())
        .collect();
    let mut event = Event {
        exception: vec![sentry::protocol::Exception {
            ty: "CoreFailure".to_owned(),
            value: Some(chain.join(": ")),
            stacktrace: Some(sentry::protocol::Stacktrace {
                frames: report.frames.iter().filter_map(source_frame).collect(),
                ..Default::default()
            }),
            ..Default::default()
        }]
        .into(),
        level: sentry::Level::Error,
        fingerprint: vec!["core".into(), key.to_owned().into()].into(),
        ..Event::default()
    };
    let mut tag = |key: &str, value: Option<String>| {
        if let Some(value) = value {
            event.tags.insert(key.to_owned(), value);
        }
    };
    tag("context", Some(context.to_owned()));
    tag("log_id", Some(log_id.to_owned()));
    tag("core.origin", origin.map(ToOwned::to_owned));
    if let Some(http) = &report.http {
        tag("http.status", http.status.map(|status| status.to_string()));
        tag("matrix.errcode", http.errcode.clone());
    }
    if let Ok(serde_json::Value::Object(fields)) = serde_json::to_value(report) {
        event.contexts.insert(
            "core".to_owned(),
            sentry::protocol::Context::Other(fields.into_iter().collect()),
        );
    }
    sentry::capture_event(event);
}

fn scrub_event(mut event: Event<'static>) -> Event<'static> {
    tag_fields(&mut event);
    if let Some(message) = event.message.as_mut() {
        *message = scrub_text(message);
    }
    for exception in &mut event.exception.values {
        if let Some(value) = exception.value.as_mut() {
            *value = scrub_text(value);
        }
        let frames = exception
            .stacktrace
            .iter_mut()
            .flat_map(|trace| &mut trace.frames);
        for function in frames.filter_map(|frame| frame.function.as_mut()) {
            *function = scrub_text(function);
        }
    }
    scrub_fields(&mut event.extra);
    for (name, context) in &mut event.contexts {
        if let sentry::protocol::Context::Other(fields) = context {
            if name == "core" {
                fields.values_mut().for_each(scrub_value);
            } else {
                scrub_fields(fields);
            }
        }
    }
    event.user = None;
    for value in event.tags.values_mut() {
        *value = scrub_text(value);
    }
    for breadcrumb in &mut event.breadcrumbs.values {
        if let Some(message) = breadcrumb.message.as_mut() {
            *message = scrub_text(message);
        }
        scrub_fields(&mut breadcrumb.data);
    }
    event
}

const REPORTED_FIELDS: &[&str] = &[
    "error",
    "code",
    "context",
    "log_id",
    "source",
    "cause",
    "age",
    "delay",
    "own_identity_trusted",
    "same_homeserver",
    "backup",
    "backup_lookup",
    "account_cross_signed",
    "device_cross_signed",
    "megolm_session",
    "sender_device",
    "errors_by_olm_session",
];

fn scrub_fields(fields: &mut std::collections::BTreeMap<String, serde_json::Value>) {
    fields.retain(|key, _| {
        REPORTED_FIELDS.contains(&key.as_str())
            || matches!(
                key.as_str(),
                "tracing.target"
                    | "tracing.filename"
                    | "tracing.lineno"
                    | "module_path"
                    | "file"
                    | "line"
            )
    });
    for value in fields.values_mut() {
        scrub_value(value);
    }
}

fn scrub_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => *text = scrub_text(text),
        serde_json::Value::Array(values) => values.iter_mut().for_each(scrub_value),
        serde_json::Value::Object(fields) => {
            fields.retain(|key, _| {
                !matches!(
                    key.to_lowercase().replace('_', "").as_str(),
                    "roomid"
                        | "eventid"
                        | "userid"
                        | "senderid"
                        | "deviceid"
                        | "accesstoken"
                        | "refreshtoken"
                        | "password"
                        | "token"
                        | "authorization"
                        | "sessionid"
                        | "synctoken"
                        | "nextbatch"
                )
            });
            fields.values_mut().for_each(scrub_value);
        }
        _ => {}
    }
}

fn scrub_log(mut log: sentry::protocol::Log) -> sentry::protocol::Log {
    log.body = scrub_text(&log.body);
    log.attributes.retain(|key, _| {
        REPORTED_FIELDS.contains(&key.as_str())
            || key.starts_with("sentry.")
            || key.starts_with("code.")
            || key.starts_with("os.")
            || key.starts_with("device.")
    });
    for attribute in log.attributes.values_mut() {
        scrub_value(&mut attribute.0);
    }
    log
}

/// Fire once per room per sync response, which would drown the breadcrumbs.
const NOISY_TARGETS: &[&str] = &[
    "matrix_sdk_base::room::display_name",
    "matrix_sdk::latest_events",
    "matrix_sdk::http_client",
];

fn is_noisy(metadata: &tracing::Metadata<'_>) -> bool {
    NOISY_TARGETS
        .iter()
        .any(|noisy| metadata.target().starts_with(noisy))
}

fn is_error_event(metadata: &tracing::Metadata<'_>) -> bool {
    sable_core::binding::is_reported_event(metadata)
}

fn is_breadcrumb(metadata: &tracing::Metadata<'_>) -> bool {
    !is_noisy(metadata)
        && *metadata.level() <= tracing::Level::WARN
        && !sable_core::binding::is_reported_event(metadata)
}

fn is_log(metadata: &tracing::Metadata<'_>) -> bool {
    !is_noisy(metadata) && *metadata.level() <= tracing::Level::WARN
}

pub(crate) fn tracing_layer<S>() -> impl tracing_subscriber::Layer<S>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    use sentry::integrations::tracing::{BreadcrumbLayer, ErrorLayer, LogLayer};
    use tracing_subscriber::{Layer as _, filter::filter_fn};

    BreadcrumbLayer::new()
        .with_filter(filter_fn(is_breadcrumb))
        .and_then(ErrorLayer::new().with_filter(filter_fn(is_error_event)))
        .and_then(LogLayer::new().with_filter(filter_fn(is_log)))
}

/// The SDK names the kernel, which files Android under Linux and iOS under Darwin.
#[cfg(any(target_os = "android", target_os = "ios"))]
struct Platform {
    os: &'static str,
    version: Option<String>,
    model: Option<String>,
}

#[cfg(target_os = "android")]
fn platform() -> &'static Platform {
    static PLATFORM: std::sync::OnceLock<Platform> = std::sync::OnceLock::new();
    PLATFORM.get_or_init(|| {
        let properties = android_system_properties::AndroidSystemProperties::new();
        Platform {
            os: "Android",
            version: properties.get("ro.build.version.release"),
            model: properties.get("ro.product.model"),
        }
    })
}

#[cfg(target_os = "ios")]
fn platform() -> &'static Platform {
    static PLATFORM: std::sync::OnceLock<Platform> = std::sync::OnceLock::new();
    PLATFORM.get_or_init(|| Platform {
        os: "iOS",
        version: Some(crate::ios::os_version()),
        model: crate::ios::device_model(),
    })
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn name_platform(mut event: Event<'static>) -> Event<'static> {
    use sentry::protocol::Context;

    let platform = platform();
    if let Some(Context::Os(os)) = event.contexts.get_mut("os") {
        os.name = Some(platform.os.to_owned());
        os.build = os.version.take();
        os.version.clone_from(&platform.version);
    }
    if let Some(Context::Device(device)) = event.contexts.get_mut("device") {
        device.model.clone_from(&platform.model);
        device.family.clone_from(&platform.model);
    }
    event
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const fn name_platform(event: Event<'static>) -> Event<'static> {
    event
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn name_log_platform(mut log: sentry::protocol::Log) -> sentry::protocol::Log {
    let platform = platform();
    let mut set = |key: &str, value: Option<&str>| {
        if let Some(value) = value {
            log.attributes
                .insert(key.to_owned(), value.to_owned().into());
        }
    };
    set("os.name", Some(platform.os));
    set("os.version", platform.version.as_deref());
    set("device.model", platform.model.as_deref());
    log
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
const fn name_log_platform(log: sentry::protocol::Log) -> sentry::protocol::Log {
    log
}

static CONSENT: AtomicBool = AtomicBool::new(false);

pub(crate) fn init() -> Option<sentry::ClientInitGuard> {
    let dsn = option_env!("SENTRY_DSN")?;
    // An Android process has no HOME: the activity hands over the saved choice instead.
    #[cfg(not(target_os = "android"))]
    CONSENT.store(consent(), Ordering::Relaxed);
    #[cfg(target_os = "ios")]
    if let Err(error) = crate::ios::set_sentry_enabled(CONSENT.load(Ordering::Relaxed)) {
        eprintln!("ios crash reporting consent not applied: {error}");
    }

    let mut options = sentry::ClientOptions::default();
    match dsn.parse() {
        Ok(dsn) => options.dsn = Some(dsn),
        Err(error) => {
            tracing::error!("SENTRY_DSN is malformed, crash reporting is off: {error}");
            return None;
        }
    }
    options.environment = option_env!("SENTRY_ENVIRONMENT").map(Into::into);
    options.release = option_env!("SENTRY_APP_VERSION").map(Into::into);
    options.send_default_pii = false;
    options.before_send = Some(Arc::new(|event: Event<'static>| {
        CONSENT
            .load(Ordering::Relaxed)
            .then(|| scrub_event(name_platform(event)))
    }));
    options.before_send_log = Some(Arc::new(|log| {
        CONSENT
            .load(Ordering::Relaxed)
            .then(|| name_log_platform(scrub_log(log)))
    }));

    Some(sentry::init(options))
}

#[cfg(target_os = "android")]
pub(crate) fn restore_consent(enabled: bool) {
    CONSENT.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub(crate) fn set_native_sentry_enabled(enabled: bool) {
    CONSENT.store(enabled, Ordering::Relaxed);
    #[cfg(not(target_os = "android"))]
    persist_consent(enabled);
    #[cfg(target_os = "android")]
    if let Err(error) = crate::mobile::set_sentry_enabled(enabled) {
        tracing::warn!(%error, "android crash reporting consent not applied");
    }
    #[cfg(target_os = "ios")]
    if let Err(error) = crate::ios::set_sentry_enabled(enabled) {
        tracing::warn!(%error, "ios crash reporting consent not applied");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingTransport(Mutex<Vec<sentry::Envelope>>);

    impl sentry::Transport for RecordingTransport {
        fn send_envelope(&self, envelope: sentry::Envelope) {
            self.0.lock().unwrap().push(envelope);
        }
    }

    fn record(emit: impl FnOnce()) -> Arc<RecordingTransport> {
        use tracing_subscriber::prelude::*;

        let transport = Arc::new(RecordingTransport::default());
        let mut options = sentry::ClientOptions::default();
        options.dsn = Some("https://public@example.invalid/1".parse().unwrap());
        options.transport = Some(Arc::new(transport.clone()));
        options.before_send = Some(Arc::new(|event| Some(scrub_event(event))));
        options.before_send_log = Some(Arc::new(|log| Some(scrub_log(log))));
        let client = Arc::new(sentry::Client::from_config(options));
        let hub = Arc::new(sentry::Hub::new(
            Some(client.clone()),
            Arc::new(sentry::Scope::default()),
        ));
        let subscriber = tracing_subscriber::registry().with(tracing_layer());
        sentry::Hub::run(hub, || tracing::subscriber::with_default(subscriber, emit));
        assert!(client.flush(Some(std::time::Duration::from_secs(1))));
        transport
    }

    #[test]
    fn reports_only_app_and_core_errors_and_keeps_the_rest_as_breadcrumbs() {
        let transport = record(|| {
            tracing::warn!(target: "tauri_plugin_updater", "updater retry");
            tracing::error!(target: "app_lib", room_id = "!private:example.org", access_token = "secret", error = "GET /rooms/%21private%3Aexample.org/messages", "tauri command failed");
            tracing::error!(target: "tauri_plugin_updater", "update failed");
            tracing::error!(target: "sable_core", "core failed");
            tracing::error!(target: "matrix_sdk::encryption", "encryption failed");
            tracing::error!(target: "matrix_sdk::latest_events", "known noisy event");
            tracing::error!(target: "matrix_sdk::http_client", "Error while sending request");
        });
        let envelopes = transport.0.lock().unwrap();
        let events: Vec<_> = envelopes
            .iter()
            .filter_map(sentry::Envelope::event)
            .collect();
        let messages: Vec<_> = events
            .iter()
            .map(|event| event.message.as_deref())
            .collect();
        assert_eq!(
            messages,
            [Some("tauri command failed"), Some("core failed")]
        );
        let sent = serde_json::to_string(&events[0]).unwrap();
        assert!(!sent.contains("private"));
        assert!(!sent.contains("secret"));
        assert!(sent.contains("[ROOM_ID]"));
        assert!(sent.contains("Rust Tracing Location"));
        assert!(sent.contains("src/sentry.rs"));
        assert_eq!(
            events[0].breadcrumbs.values[0].message.as_deref(),
            Some("updater retry")
        );
        let breadcrumbs: Vec<_> = events[1]
            .breadcrumbs
            .values
            .iter()
            .filter_map(|breadcrumb| breadcrumb.message.as_deref())
            .collect();
        assert!(breadcrumbs.contains(&"update failed"), "{breadcrumbs:?}");
        assert!(
            !breadcrumbs.contains(&"known noisy event"),
            "{breadcrumbs:?}"
        );
        let mut logs = Vec::new();
        for envelope in envelopes.iter() {
            for item in envelope.items() {
                if let sentry::protocol::EnvelopeItem::ItemContainer(
                    sentry::protocol::ItemContainer::Logs(batch),
                ) = item
                {
                    logs.extend(batch.iter().map(|log| log.body.as_str()));
                }
            }
        }
        assert_eq!(logs.len(), 5);
        assert!(logs.contains(&"update failed"));
        assert!(!logs.contains(&"Error while sending request"));
    }

    #[test]
    fn a_room_id_without_a_server_is_scrubbed() {
        let room = "!Rv2mqWrh8-DOEQqSV_YwY3bNsmQ5kwsjXrlAWoHIgLU";
        assert_eq!(room.len(), 44);
        let scrubbed = scrub_text(&format!(
            "error sending request for url (https://example.org/_matrix/client/v3/rooms/{room}/receipt/m.read/$abcdefghijklmnop)"
        ));
        assert!(!scrubbed.contains("Rv2mqWrh8"), "{scrubbed}");
        assert!(scrubbed.contains("/rooms/![ROOM_ID]/receipt"), "{scrubbed}");
    }

    #[test]
    fn a_log_keeps_the_attributes_that_say_where_it_came_from() {
        let transport = record(|| {
            tracing::error!(target: "sable_core::errors", room_id = "!private:example.org", "core failed");
        });
        let envelopes = transport.0.lock().unwrap();
        let mut attributes = Vec::new();
        for envelope in envelopes.iter() {
            for item in envelope.items() {
                if let sentry::protocol::EnvelopeItem::ItemContainer(
                    sentry::protocol::ItemContainer::Logs(batch),
                ) = item
                {
                    for log in batch {
                        attributes.extend(log.attributes.keys().cloned());
                    }
                }
            }
        }
        for kept in ["sentry.sdk.name", "sentry.origin"] {
            assert!(
                attributes.iter().any(|key| key == kept),
                "{kept} missing from {attributes:?}"
            );
        }
        assert!(
            !attributes.iter().any(|key| key == "room_id"),
            "{attributes:?}"
        );
    }

    #[test]
    fn reports_decryption_failures_but_not_other_sdk_warnings() {
        let transport = record(|| {
            tracing::warn!(
                target: "matrix_sdk_crypto::olm::account",
                errors_by_olm_session = ?[("Xc2bUfTFHxJ0Ycs5kd8CmWyDJM5aRjMTXCVqU7yjNmE", "Decryption(InvalidMAC(MacError))")],
                "Failed to decrypt a non-pre-key message with all available sessions"
            );
            tracing::warn!(
                target: "sable_core::utd",
                reported = true,
                cause = "WithheldBySender",
                age = "later",
                backup = "Enabled",
                "unable to decrypt a message"
            );
            tracing::warn!(target: "matrix_sdk_crypto::machine", "a routine warning");
            tracing::warn!(target: "matrix_sdk_crypto::gossiping::machine", "a key request from an unknown device");
            tracing::warn!(target: "matrix_sdk_crypto::session_manager::sessions", "a device is out of one-time keys");
        });
        let envelopes = transport.0.lock().unwrap();
        let events: Vec<_> = envelopes
            .iter()
            .filter_map(sentry::Envelope::event)
            .collect();

        let messages: Vec<_> = events
            .iter()
            .map(|event| event.message.as_deref())
            .collect();
        assert_eq!(
            messages,
            [
                Some("Failed to decrypt a non-pre-key message with all available sessions"),
                Some("unable to decrypt a message"),
            ]
        );
        let olm = serde_json::to_string(&events[0]).unwrap();
        assert!(olm.contains("InvalidMAC"), "{olm}");
        assert!(
            !olm.contains("Xc2bUfTFHxJ0Ycs5kd8CmWyDJM5aRjMTXCVqU7yjNmE"),
            "{olm}"
        );
        let utd = serde_json::to_string(&events[1]).unwrap();
        for field in ["WithheldBySender", "later", "Enabled"] {
            assert!(utd.contains(field), "{field} missing from {utd}");
        }
    }

    #[test]
    fn scrubs_native_error_messages_and_breadcrumbs() {
        let mut event = Event {
            message: Some(
                "failed !private:example.org token=secret https://hs.example.org/sync".into(),
            ),
            ..Default::default()
        };
        event
            .extra
            .insert("room_id".into(), serde_json::json!("!private:example.org"));
        event.extra.insert(
            "error".into(),
            serde_json::json!("permission denied token=secret"),
        );
        event.breadcrumbs.values.push(sentry::Breadcrumb {
            message: Some("@private:example.org password=secret".into()),
            ..Default::default()
        });
        let sent = serde_json::to_string(&scrub_event(event)).unwrap();
        assert!(!sent.contains("!private:example.org"));
        assert!(!sent.contains("@private:example.org"));
        assert!(!sent.contains("secret"));
        assert!(!sent.contains("hs.example.org"));
        assert!(sent.contains("permission denied"));
    }

    #[test]
    fn scrubs_nested_native_log_errors() {
        let mut error = serde_json::json!([
            "GET /rooms/%21private%3Aexample.org/messages token=secret",
            { "access_token": "secret", "error": "permission denied" }
        ]);
        scrub_value(&mut error);
        let sent = error.to_string();
        assert!(!sent.contains("private"));
        assert!(!sent.contains("secret"));
        assert!(sent.contains("permission denied"));
    }

    #[test]
    fn a_native_log_keeps_the_utd_fields_and_drops_the_rest() {
        let log = scrub_log(sentry::protocol::Log {
            level: sentry::protocol::LogLevel::Warn,
            body: "unable to decrypt a message".to_owned(),
            trace_id: None,
            timestamp: std::time::SystemTime::now(),
            severity_number: None,
            attributes: [
                ("cause", "Unknown"),
                ("age", "later"),
                ("megolm_session", "0a1b2c3d4e5f"),
                ("room_id", "!private:example.org"),
            ]
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value.into()))
            .collect(),
        });
        let mut kept: Vec<_> = log.attributes.keys().map(String::as_str).collect();
        kept.sort_unstable();
        assert_eq!(kept, ["age", "cause", "megolm_session"]);
    }

    #[test]
    fn a_core_failure_is_grouped_by_where_it_was_raised_and_keeps_its_report() {
        let transport = record(|| {
            let (core, mut events) = sable_core::Core::new(
                "test",
                Box::new(sable_core::store::MemorySessionStore::default()),
            );
            let _ = core.failed_with(
                "join_room",
                &std::io::Error::other("refused by !private:example.org"),
            );
            let Ok(sable_core::protocol::CoreEvent::Failure {
                log_id,
                context,
                report,
            }) = events.try_recv()
            else {
                panic!("the core did not emit the failure");
            };
            capture_failure(&log_id, &context, &report);
            capture_failure("e2", &context, &report);
        });
        let envelopes = transport.0.lock().unwrap();
        let events: Vec<_> = envelopes
            .iter()
            .filter_map(sentry::Envelope::event)
            .collect();
        let [event] = events.as_slice() else {
            panic!("expected one event, got {}", events.len());
        };

        assert_eq!(event.fingerprint[0], "core");
        assert!(
            event.fingerprint[1].starts_with("src-tauri/src/sentry.rs:"),
            "{:?}",
            event.fingerprint
        );
        assert_eq!(
            event.tags.get("context").map(String::as_str),
            Some("join_room")
        );
        assert_eq!(event.tags.get("log_id").map(String::as_str), Some("e1"));
        let frames = &event.exception.values[0]
            .stacktrace
            .as_ref()
            .unwrap()
            .frames;
        let functions: Vec<_> = frames
            .iter()
            .filter_map(|frame| frame.function.as_deref())
            .collect();
        assert_eq!(functions, ["join_room", "refused by ![ROOM_ID]"]);
        let raised = frames.last().unwrap();
        assert_eq!(raised.filename.as_deref(), Some("src-tauri/src/sentry.rs"));
        assert!(raised.lineno.is_some() && raised.colno.is_some());
        let Some(sentry::protocol::Context::Other(report)) = event.contexts.get("core") else {
            panic!("{:?}", event.contexts.keys().collect::<Vec<_>>());
        };
        let sent = serde_json::to_string(report).unwrap();
        assert!(
            sent.contains("join_room") && sent.contains("refused by"),
            "{sent}"
        );
        assert!(!serde_json::to_string(event).unwrap().contains("private"));
    }

    #[test]
    fn a_json_quoted_token_is_scrubbed() {
        let text = super::scrub_text(r#"{"access_token": "syt_secret", "error": "x"}"#);
        assert!(!text.contains("syt_secret"), "{text}");
    }
}
