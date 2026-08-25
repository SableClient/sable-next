//! Deep-link forwarding for the Linux CEF build.
//!
//! CEF is one process per cache, so a relaunch cannot init Chromium to forward
//! itself the way `tauri-plugin-single-instance` does. The primary binds a
//! socket, the secondary writes to it and exits before touching CEF, and
//! delivery re-emits the `deep-link://new-url` that `onOpenUrl` listens to.

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

const SCHEMES: &[&str] = &["moe.sable.next:", "sable:"];
const SOCKET_NAME: &str = "moe.sable.next-deeplink.sock";
const NEW_URL_EVENT: &str = "deep-link://new-url";
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_secs(3);

fn is_deep_link(arg: &str) -> bool {
    SCHEMES.iter().any(|scheme| arg.starts_with(scheme))
}

fn socket_path() -> PathBuf {
    std::env::var("XDG_RUNTIME_DIR")
        .map_or_else(|_| std::env::temp_dir(), PathBuf::from)
        .join(SOCKET_NAME)
}

fn deep_link_urls_in_args<I, S>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .filter(|arg| is_deep_link(arg.as_ref()))
        .map(|arg| arg.as_ref().to_owned())
        .collect()
}

pub enum ForwardResult {
    /// The URLs reached the primary; the caller must exit.
    Forwarded,
    /// A deep link was in argv but nothing is listening: become the primary.
    NoPrimary,
    NoUrls,
}

/// Call before CEF is initialized, or this process fights for the cache lock.
#[must_use]
pub fn try_forward_deep_links() -> ForwardResult {
    let urls = deep_link_urls_in_args(std::env::args());
    if urls.is_empty() {
        return ForwardResult::NoUrls;
    }

    let Ok(mut stream) = UnixStream::connect(socket_path()) else {
        return ForwardResult::NoPrimary;
    };
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    for url in &urls {
        let _ = writeln!(stream, "{url}");
    }
    ForwardResult::Forwarded
}

type LiveHandler = Box<dyn Fn(String) + Send + Sync>;

static PENDING_URLS: OnceLock<Arc<Mutex<Vec<String>>>> = OnceLock::new();
static LIVE_HANDLER: OnceLock<Mutex<Option<LiveHandler>>> = OnceLock::new();

fn pending_queue() -> &'static Arc<Mutex<Vec<String>>> {
    PENDING_URLS.get_or_init(|| Arc::new(Mutex::new(Vec::new())))
}

fn live_handler() -> &'static Mutex<Option<LiveHandler>> {
    LIVE_HANDLER.get_or_init(|| Mutex::new(None))
}

/// The query and fragment carry OIDC tokens.
fn redact_for_log(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or("<deep link>")
}

fn dispatch_url(url: String) {
    if let Ok(guard) = live_handler().lock() {
        if let Some(handler) = guard.as_ref() {
            handler(url);
            return;
        }
    }
    if let Ok(mut pending) = pending_queue().lock() {
        pending.push(url);
    }
}

pub struct DeepLinkSocketGuard {
    path: PathBuf,
}

impl Drop for DeepLinkSocketGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// `None` means a live primary already holds the socket, or the bind failed;
/// neither is fatal.
#[must_use]
pub fn bind_and_listen() -> Option<DeepLinkSocketGuard> {
    let path = socket_path();
    let listener = match UnixListener::bind(&path) {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            if UnixStream::connect(&path).is_ok() {
                return None;
            }
            let _ = std::fs::remove_file(&path);
            UnixListener::bind(&path).ok()?
        }
        Err(error) => {
            log::warn!("could not bind {}: {error}", path.display());
            return None;
        }
    };

    let guard = DeepLinkSocketGuard { path };
    if let Err(error) = std::thread::Builder::new()
        .name("deep-link-ipc".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                handle_connection(stream);
            }
        })
    {
        log::warn!("could not start the deep-link listener: {error}");
        return None;
    }

    Some(guard)
}

fn handle_connection(stream: UnixStream) {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    for line in BufReader::new(stream).lines() {
        let Ok(url) = line else { break };
        if is_deep_link(&url) {
            log::info!("received deep link {}", redact_for_log(&url));
            dispatch_url(url);
        }
    }
}

/// Installs the handler and flushes what arrived before it. Call from `setup()`.
pub fn drain_pending_urls<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Emitter;

    let emitter = app.clone();
    if let Ok(mut guard) = live_handler().lock() {
        *guard = Some(Box::new(move |url: String| {
            if let Err(error) = emitter.emit(NEW_URL_EVENT, vec![url]) {
                log::warn!("could not deliver a deep link: {error}");
            }
        }));
    }

    let pending = pending_queue()
        .lock()
        .map(|mut queue| std::mem::take(&mut *queue))
        .unwrap_or_default();
    for url in pending {
        let _ = app.emit(NEW_URL_EVENT, vec![url]);
    }
}

#[cfg(test)]
mod tests {
    use super::{deep_link_urls_in_args, redact_for_log};

    #[test]
    fn keeps_only_the_deep_links_after_argv_zero() {
        assert_eq!(
            deep_link_urls_in_args([
                "sable-next",
                "--flag",
                "sable://room/!a:example.org",
                "moe.sable.next:/login?code=secret",
                "https://example.org",
            ]),
            vec![
                "sable://room/!a:example.org".to_owned(),
                "moe.sable.next:/login?code=secret".to_owned(),
            ]
        );
    }

    #[test]
    fn a_deep_link_in_argv_zero_is_not_a_forwarded_url() {
        assert!(deep_link_urls_in_args(["sable://room/!a:example.org"]).is_empty());
    }

    #[test]
    fn the_log_form_drops_the_query_and_the_fragment() {
        assert_eq!(
            redact_for_log("moe.sable.next:/login?code=secret#state=secret"),
            "moe.sable.next:/login"
        );
    }
}
