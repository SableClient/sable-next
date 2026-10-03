use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

fn consent_path() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA")
            .or_else(|| std::env::var_os("APPDATA"))
            .map(|root| std::path::PathBuf::from(root).join("sable-next/sentry-consent"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var_os("HOME")?;
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        let path = std::path::PathBuf::from(home)
            .join("Library/Application Support/Sable Next/sentry-consent");
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        let path = std::env::var_os("XDG_STATE_HOME")
            .map_or_else(
                || std::path::PathBuf::from(home).join(".local/state"),
                std::path::PathBuf::from,
            )
            .join("sable-next/sentry-consent");
        Some(path)
    }
}

fn consent() -> bool {
    consent_path().is_some_and(|path| std::fs::read(path).is_ok_and(|value| value == b"1"))
}

fn persist_consent(enabled: bool) {
    let Some(path) = consent_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, if enabled { b"1" } else { b"0" });
}

use sentry::protocol::Event;

fn scrub_text(value: &str) -> String {
    use regex_lite::Regex;
    use std::sync::LazyLock;

    static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
        [
            (r"(?i)\bhttps?://[^/?#\s]+", "https://[HOMESERVER]"),
            (r"(?i)(access_token|password|token|refresh_token|session_id|sync_token|next_batch)([=:\s]+)([^\s&]+)", "$1$2[REDACTED]"),
            (r#"@[^\s:@]+:[^\s,'"(){}\[\]]+"#, "@[USER_ID]"),
            (r#"![^\s:]+:[^\s,'"(){}\[\]]+"#, "![ROOM_ID]"),
            (r#"#[^\s:@]+:[^\s,'"(){}\[\]]+"#, "#[ROOM_ALIAS]"),
            (r"\$[A-Za-z0-9_+/-]{10,}", "$[EVENT_ID]"),
            (r"(?i)/(?:%21|!)[^/?#\s]*?(?:%3a|:)[^/?#\s]+", "/![ROOM_ID]"),
            (r"(?i)/(?:%40|@)[^/?#\s]*?(?:%3a|:)[^/?#\s]+", "/@[USER_ID]"),
            (r"(?i)/%21[^/?#\s]+", "/![ROOM_ID]"),
            (r"(?i)/%40[^/?#\s]+", "/@[USER_ID]"),
            (r"(?i)/%23[^/?#\s]+", "/[ROOM_ALIAS]"),
            (r"(?i)/%24[^/?#\s]+", "/[EVENT_ID]"),
            (r"(?i)([?&#](?:code|state|loginToken)=)[^&#\s]+", "$1[REDACTED]"),
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

fn scrub_event(mut event: Event<'static>) -> Event<'static> {
    if let Some(message) = event.message.as_mut() {
        *message = scrub_text(message);
    }
    for exception in &mut event.exception.values {
        if let Some(value) = exception.value.as_mut() {
            *value = scrub_text(value);
        }
    }
    scrub_fields(&mut event.extra);
    for context in event.contexts.values_mut() {
        if let sentry::protocol::Context::Other(fields) = context {
            scrub_fields(fields);
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

fn scrub_fields(fields: &mut std::collections::BTreeMap<String, serde_json::Value>) {
    fields.retain(|key, _| {
        matches!(
            key.as_str(),
            "error"
                | "code"
                | "source"
                | "tracing.target"
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
        matches!(key.as_str(), "error" | "code" | "source" | "sentry.origin")
            || key.starts_with("code.")
    });
    for attribute in log.attributes.values_mut() {
        scrub_value(&mut attribute.0);
    }
    log
}

pub fn tracing_filter(
    metadata: &tracing::Metadata<'_>,
) -> sentry::integrations::tracing::EventFilter {
    use sentry::integrations::tracing::EventFilter;

    if metadata
        .target()
        .starts_with("matrix_sdk_base::room::display_name")
        || metadata.target().starts_with("matrix_sdk::latest_events")
        || metadata.target().starts_with("matrix_sdk::http_client")
    {
        return EventFilter::Ignore;
    }
    match *metadata.level() {
        tracing::Level::ERROR => EventFilter::Event | EventFilter::Log,
        tracing::Level::WARN => EventFilter::Breadcrumb | EventFilter::Log,
        _ => EventFilter::Ignore,
    }
}

static CONSENT: AtomicBool = AtomicBool::new(false);

pub fn init() -> Option<sentry::ClientInitGuard> {
    let dsn = option_env!("SENTRY_DSN")?;
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
        let enabled = if cfg!(desktop) && event.level == sentry::Level::Fatal {
            consent()
        } else {
            CONSENT.load(Ordering::Relaxed)
        };
        enabled.then(|| scrub_event(event))
    }));
    options.before_send_log = Some(Arc::new(|log| {
        CONSENT.load(Ordering::Relaxed).then(|| scrub_log(log))
    }));

    Some(sentry::init(options))
}

#[tauri::command]
pub fn set_native_sentry_enabled(enabled: bool) {
    CONSENT.store(enabled, Ordering::Relaxed);
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

    #[test]
    fn reports_tauri_plugin_core_and_sdk_errors_with_warning_breadcrumbs() {
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
        let subscriber = tracing_subscriber::registry()
            .with(sentry::integrations::tracing::layer().event_filter(tracing_filter));
        sentry::Hub::run(hub, || {
            tracing::subscriber::with_default(subscriber, || {
                tracing::warn!(target: "tauri_plugin_updater", "updater retry");
                tracing::error!(target: "app_lib", room_id = "!private:example.org", access_token = "secret", error = "GET /rooms/%21private%3Aexample.org/messages", "tauri command failed");
                tracing::error!(target: "tauri_plugin_updater", "update failed");
                tracing::error!(target: "sable_core", "core failed");
                tracing::error!(target: "matrix_sdk::encryption", "encryption failed");
                tracing::error!(target: "matrix_sdk::latest_events", "known noisy event");
                tracing::error!(target: "matrix_sdk::http_client", "Error while sending request");
            });
        });
        assert!(client.flush(Some(std::time::Duration::from_secs(1))));
        let envelopes = transport.0.lock().unwrap();
        let events: Vec<_> = envelopes
            .iter()
            .filter_map(sentry::Envelope::event)
            .collect();
        assert_eq!(events.len(), 4);
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
}
