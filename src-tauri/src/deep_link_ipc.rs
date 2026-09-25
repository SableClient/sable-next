//! Deep-link forwarding for the Linux CEF build.
//!
//! CEF is one process per cache, so a relaunch cannot init Chromium to forward
//! itself the way `tauri-plugin-single-instance` does. The primary binds a
//! socket, the secondary writes to it and exits before touching CEF, and
//! delivery re-emits the `deep-link://new-url` that `onOpenUrl` listens to.

use std::{
    io::{BufRead, BufReader, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use crate::deep_link_delivery::Delivery;

const SCHEMES: &[&str] = &["moe.sable.next:", "sable:"];
const SOCKET_NAME: &str = "moe.sable.next-deeplink.sock";
const NEW_URL_EVENT: &str = "deep-link://new-url";
const ACTIVATE: &str = "activate";
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_secs(3);
const SOCKET_MODE: u32 = 0o600;

fn is_deep_link(arg: &str) -> bool {
    SCHEMES.iter().any(|scheme| arg.starts_with(scheme))
}

fn socket_path() -> Option<PathBuf> {
    let directory = PathBuf::from(std::env::var_os("XDG_RUNTIME_DIR")?);
    if !directory.is_absolute() {
        return None;
    }
    Some(directory.join(SOCKET_NAME))
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
    /// The launch reached the primary; the caller must exit.
    Forwarded,
    /// Nothing is listening: become the primary.
    NoPrimary,
}

/// Call before CEF is initialized.
#[must_use]
pub fn try_forward_to_primary() -> ForwardResult {
    let urls = deep_link_urls_in_args(std::env::args());
    let Some(path) = socket_path() else {
        return ForwardResult::NoPrimary;
    };
    let Ok(mut stream) = UnixStream::connect(path) else {
        return ForwardResult::NoPrimary;
    };
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let _ = writeln!(stream, "{ACTIVATE}");
    for url in &urls {
        let _ = writeln!(stream, "{url}");
    }
    ForwardResult::Forwarded
}

static DELIVERY: OnceLock<Mutex<Delivery>> = OnceLock::new();
type ActivationHandler = Arc<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct ActivationDelivery {
    pending: bool,
    handler: Option<ActivationHandler>,
}

impl ActivationDelivery {
    fn push(&mut self) -> Option<ActivationHandler> {
        match &self.handler {
            Some(handler) => Some(handler.clone()),
            None => {
                self.pending = true;
                None
            }
        }
    }

    fn install(&mut self, handler: ActivationHandler) -> Option<ActivationHandler> {
        let pending = std::mem::take(&mut self.pending);
        self.handler = Some(handler.clone());
        pending.then_some(handler)
    }
}

static ACTIVATION: OnceLock<Mutex<ActivationDelivery>> = OnceLock::new();

fn delivery() -> &'static Mutex<Delivery> {
    DELIVERY.get_or_init(|| Mutex::new(Delivery::default()))
}

fn activation() -> &'static Mutex<ActivationDelivery> {
    ACTIVATION.get_or_init(|| Mutex::new(ActivationDelivery::default()))
}

/// The query and fragment carry OIDC tokens.
fn redact_for_log(url: &str) -> &str {
    url.split(['?', '#']).next().unwrap_or("<deep link>")
}

fn dispatch_url(url: String) {
    let live = delivery()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(url);
    if let Some((handler, url)) = live {
        handler(url);
    }
}

fn dispatch_activation() {
    if let Some(handler) = activation()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push()
    {
        handler();
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
    let Some(path) = socket_path() else {
        log::warn!("XDG_RUNTIME_DIR is unset; deep links will not be forwarded between processes");
        return None;
    };
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

    if let Err(error) =
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(SOCKET_MODE))
    {
        log::warn!("could not restrict {}: {error}", path.display());
        let _ = std::fs::remove_file(&path);
        return None;
    }

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
        if url == ACTIVATE {
            dispatch_activation();
        } else if is_deep_link(&url) {
            log::info!("received deep link {}", redact_for_log(&url));
            dispatch_url(url);
        }
    }
}

pub fn install_handler<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::{Emitter, Manager};

    let window_app = app.clone();
    let activate = Arc::new(move || {
        if let Some(window) = window_app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
    if let Some(handler) = activation()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .install(activate)
    {
        handler();
    }

    let emitter = app.clone();
    delivery()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .install(Arc::new(move |url: String| {
            if let Err(error) = emitter.emit(NEW_URL_EVENT, vec![url]) {
                log::warn!("could not deliver a deep link: {error}");
            }
        }));
}

#[must_use]
pub fn take_pending_urls() -> Vec<String> {
    delivery()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take_pending()
}

#[cfg(test)]
mod tests {
    use super::{ActivationDelivery, deep_link_urls_in_args, redact_for_log};
    use std::sync::{Arc, Mutex};

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

    #[test]
    fn activation_before_setup_is_delivered_when_the_handler_is_installed() {
        let mut delivery = ActivationDelivery::default();
        assert!(delivery.push().is_none());

        let activated = Arc::new(Mutex::new(false));
        let received = activated.clone();
        let handler = delivery
            .install(Arc::new(move || *received.lock().unwrap() = true))
            .expect("queued activation");
        handler();

        assert!(*activated.lock().unwrap());
    }
}
