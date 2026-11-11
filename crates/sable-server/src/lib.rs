#![recursion_limit = "256"]
#![expect(clippy::missing_errors_doc, reason = "errors are the returned types")]

mod auth;
mod auth_routes;
mod cli;
pub mod config;
mod media;
mod oidc;
mod oidc_routes;
mod outbound;
mod sessions;
mod users;
mod ws;

use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Router,
    http::{HeaderValue, Method, header},
    middleware,
    routing::{get, post},
};
use axum_client_ip::ClientIpSource;
use clap::Parser;
use sable_core::{Core, store::ExclusiveFileSessionStore};
use serde::Serialize;
use tokio::sync::{Mutex, OnceCell, Semaphore, broadcast};
use tower::limit::ConcurrencyLimitLayer;
use tower_governor::{GovernorLayer, governor::GovernorConfigBuilder};
use tower_http::{
    limit::RequestBodyLimitLayer,
    services::{ServeDir, ServeFile},
    set_header::response::SetResponseHeaderLayer,
};
use tower_sessions::{Expiry, SessionManagerLayer, cookie::SameSite};

use crate::{
    auth::Auth,
    auth_routes::{
        ClientIpKeyExtractor, auth_middleware, auth_status, authenticate, cancel_on_shutdown,
        extract_client_ip, logout, server_identity,
    },
    cli::Cli,
    config::{Config, is_loopback_url},
    media::{forget_media, media, rtc_data, send_attachment, send_gallery, upload},
    oidc_routes::{oidc_callback, oidc_start, oidc_status},
    sessions::SessionMemoryStore,
};

const EVENT_BUFFER: usize = 256;
const MAX_UPLOAD_SIZE: usize = 100 * 1024 * 1024;
const MAX_CONNECTIONS: usize = 256;
const MAX_RPC_TASKS: usize = 128;
const MAX_HTTP_REQUESTS: usize = 128;
const MAX_PASSWORD_CHECKS: usize = 8;
const MAX_USER_CONNECTIONS: usize = 16;
const MAX_USER_RPC_TASKS: usize = 16;
const MAX_USER_HTTP_REQUESTS: usize = 16;
const MAX_USER_UPLOADS: usize = 2;
const REQUEST_BODY_TIMEOUT: Duration = Duration::from_secs(30);

type OidcTransactions = Arc<Mutex<HashMap<String, (Instant, IpAddr, oidc::Transaction)>>>;

#[derive(Clone)]
enum SessionRevocation {
    Session(tower_sessions::session::Id),
    User(String),
}

impl SessionRevocation {
    fn ends(
        received: &Result<Self, broadcast::error::RecvError>,
        session_id: tower_sessions::session::Id,
        user_id: &str,
    ) -> bool {
        match received {
            Ok(Self::Session(id)) => *id == session_id,
            Ok(Self::User(id)) => id == user_id,
            Err(_) => true,
        }
    }
}

#[derive(Clone)]
pub struct Server {
    runtimes: Arc<RuntimeManager>,
    _instance_lock: Arc<std::fs::File>,
    auth: Arc<Auth>,
    oidc: Option<Arc<oidc::Oidc>>,
    oidc_auto_provision: bool,
    oidc_transactions: OidcTransactions,
    version: Arc<str>,
    frontend: Arc<Frontend>,
    public_url: Arc<str>,
    client_ip_source: ClientIpSource,
    sessions: SessionMemoryStore,
    session_revocations: broadcast::Sender<SessionRevocation>,
    shutdown: tokio_util::sync::CancellationToken,
    connections: Arc<Semaphore>,
    rpc_tasks: Arc<Semaphore>,
    http_requests: Arc<Semaphore>,
    password_checks: Arc<Semaphore>,
}

struct RuntimeManager {
    root: PathBuf,
    max_active_users: usize,
    shutting_down: AtomicBool,
    users: Mutex<HashMap<String, Arc<OnceCell<Arc<UserRuntime>>>>>,
    legacy: Arc<UserRuntime>,
}

impl RuntimeManager {
    fn new(root: PathBuf, max_active_users: usize) -> std::io::Result<Self> {
        if max_active_users == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "max_active_users must be positive",
            ));
        }
        let legacy = UserRuntime::new(root.clone())?;
        Ok(Self {
            root,
            max_active_users,
            shutting_down: AtomicBool::new(false),
            users: Mutex::new(HashMap::new()),
            legacy,
        })
    }

    async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        let cells: Vec<_> = self.users.lock().await.values().cloned().collect();
        for cell in cells {
            // Wait for an initialization already in progress before shutting its core down.
            if let Ok(runtime) = cell
                .get_or_try_init(|| async {
                    Err::<Arc<UserRuntime>, _>(std::io::Error::other("server shutting down"))
                })
                .await
            {
                runtime.core.shutdown().await;
            }
        }
        self.legacy.core.shutdown().await;
    }

    async fn stop_disabled(&self, registry: &users::UserRegistry) {
        let mut users = self.users.lock().await;
        users.retain(|_, cell| {
            if Arc::strong_count(cell) != 1 {
                return true;
            }
            cell.get().is_some_and(|runtime| {
                runtime.stopped.load(Ordering::Acquire) != 2
                    || Arc::strong_count(runtime) != 1
                    || Arc::strong_count(&runtime.core) != 1
            })
        });
        let disabled: Vec<_> = users
            .iter()
            .filter_map(|(id, cell)| {
                let runtime = cell.get()?;
                (registry
                    .users
                    .iter()
                    .any(|user| &user.id == id && user.disabled)
                    && runtime
                        .stopped
                        .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok())
                .then(|| runtime.clone())
            })
            .collect();
        drop(users);
        for runtime in disabled {
            runtime.core.shutdown().await;
            runtime.stopped.store(2, Ordering::Release);
        }
    }

    async fn get(&self, user_id: &str) -> std::io::Result<Arc<UserRuntime>> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(std::io::Error::other("server shutting down"));
        }
        if user_id == "legacy" {
            return Ok(self.legacy.clone());
        }
        let id = uuid::Uuid::parse_str(user_id).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid user ID")
        })?;
        let user_id = id.to_string();
        let cell = {
            let mut users = self.users.lock().await;
            if self.shutting_down.load(Ordering::Acquire) {
                return Err(std::io::Error::other("server shutting down"));
            }
            if let Some(cell) = users.get(&user_id) {
                cell.clone()
            } else {
                if users.len() >= self.max_active_users.saturating_sub(1) {
                    return Err(std::io::Error::other("runtime limit reached"));
                }
                let cell = Arc::new(OnceCell::new());
                users.insert(user_id.clone(), cell.clone());
                cell
            }
        };
        let path = self.root.join("users").join(&user_id).join("data");
        let runtime = cell
            .get_or_try_init(|| async {
                if self.shutting_down.load(Ordering::Acquire) {
                    return Err(std::io::Error::other("server shutting down"));
                }
                let (core, core_events) = tokio::task::spawn_blocking(move || {
                    if let Some(parent) = path.parent() {
                        create_private_dir(parent)?;
                    }
                    UserRuntime::build(path)
                })
                .await
                .map_err(std::io::Error::other)??;
                Ok(UserRuntime::from_parts(core, core_events))
            })
            .await?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(std::io::Error::other("server shutting down"));
        }
        if runtime.stopped.load(Ordering::Acquire) != 0 {
            return Err(std::io::Error::other("user runtime stopped"));
        }
        Ok(runtime.clone())
    }
}

struct UserRuntime {
    core: Arc<Core>,
    events: broadcast::Sender<Arc<EventRecord>>,
    buffer: Mutex<EventBuffer>,
    run_id: Arc<str>,
    connections: Arc<Semaphore>,
    rpc_tasks: Arc<Semaphore>,
    uploads: Arc<Semaphore>,
    http_requests: Arc<Semaphore>,
    stopped: AtomicU8,
}

#[derive(Serialize)]
struct EventEnvelope<'a> {
    seq: u64,
    run_id: &'a str,
    event: &'a sable_core::protocol::CoreEvent,
}

struct EventRecord {
    sequence: u64,
    message: Arc<str>,
    /// Set on a core failure, which every client would report: the first
    /// socket to take it forwards the event and the others skip it.
    unclaimed: Option<AtomicBool>,
}

impl EventRecord {
    fn claim(&self) -> bool {
        self.unclaimed
            .as_ref()
            .is_none_or(|unclaimed| unclaimed.swap(false, Ordering::AcqRel))
    }
}

struct EventBuffer {
    next_sequence: u64,
    records: VecDeque<Arc<EventRecord>>,
}

struct Frontend {
    directory: PathBuf,
}

impl Server {
    pub fn new(config: Config) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let instance_lock = Arc::new(lock_instance(&config.data_dir)?);
        sable_core::secrets::install_file_secrets(&config.data_dir);
        outbound::install(&config.allowed_private_cidrs)?;
        let oidc = match (
            &config.oidc_issuer,
            &config.oidc_client_id,
            &config.oidc_client_secret,
        ) {
            (None, None, None) => None,
            (Some(issuer), Some(client_id), Some(client_secret))
                if !issuer.is_empty() && !client_id.is_empty() && !client_secret.is_empty() =>
            {
                Some(Arc::new(oidc::Oidc {
                    issuer: issuer.clone(),
                    client_id: client_id.clone(),
                    client_secret: client_secret.clone(),
                    redirect_uri: format!("{}/_sable/oidc/callback", config.public_url),
                    metadata: Mutex::new(None),
                }))
            }
            _ => return Err("OIDC issuer, client ID and client secret must all be set".into()),
        };
        if let Some(provider) = &oidc {
            let issuer = url::Url::parse(&provider.issuer)?;
            let loopback = is_loopback_url(&issuer);
            if issuer.scheme() != "https" && !(issuer.scheme() == "http" && loopback) {
                return Err("OIDC issuer must use HTTPS unless it is a loopback address".into());
            }
            let public = url::Url::parse(&config.public_url)?;
            let loopback = is_loopback_url(&public);
            if public.scheme() != "https" && !(public.scheme() == "http" && loopback) {
                return Err(
                    "OIDC public URL must use HTTPS unless it is a loopback address".into(),
                );
            }
        }
        let runtimes = Arc::new(RuntimeManager::new(
            config.data_dir.clone(),
            config.max_active_users,
        )?);
        let auth = Arc::new(Auth::new(
            Arc::<str>::from(config.username),
            config.password_hash,
            config.data_dir.join("users.json"),
        )?);
        let server = Self {
            runtimes,
            _instance_lock: instance_lock,
            oidc,
            oidc_auto_provision: config.oidc_auto_provision,
            oidc_transactions: Arc::new(Mutex::new(HashMap::new())),
            auth,
            version: Arc::from(env!("CARGO_PKG_VERSION")),
            frontend: Arc::new(Frontend::load(config.frontend_dir)),
            public_url: Arc::from(config.public_url),
            client_ip_source: config.client_ip_source,
            sessions: SessionMemoryStore::default(),
            session_revocations: broadcast::channel(MAX_CONNECTIONS).0,
            shutdown: tokio_util::sync::CancellationToken::new(),
            connections: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            rpc_tasks: Arc::new(Semaphore::new(MAX_RPC_TASKS)),
            http_requests: Arc::new(Semaphore::new(MAX_HTTP_REQUESTS)),
            password_checks: Arc::new(Semaphore::new(MAX_PASSWORD_CHECKS)),
        };
        let watcher = Arc::downgrade(&server.runtimes);
        let auth_watcher = Arc::downgrade(&server.auth);
        let revocations = server.session_revocations.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            loop {
                interval.tick().await;
                let Some(manager) = watcher.upgrade() else {
                    break;
                };
                let Some(auth) = auth_watcher.upgrade() else {
                    break;
                };
                match auth.reload_if_changed().await {
                    Ok(Some((registry, revoked))) => {
                        for user_id in revoked {
                            let _ = revocations.send(SessionRevocation::User(user_id));
                        }
                        manager.stop_disabled(&registry).await;
                    }
                    Ok(None) => {}
                    Err(error) => tracing::warn!(%error, "could not reload user registry"),
                }
            }
        });
        Ok(server)
    }

    fn begin_shutdown(&self) {
        self.runtimes.shutting_down.store(true, Ordering::Release);
        self.shutdown.cancel();
    }

    pub fn app(&self) -> Router {
        let mut rate_limit = GovernorConfigBuilder::default();
        rate_limit
            .per_second(1)
            .burst_size(5)
            .methods(vec![Method::POST]);
        let rate_limit = rate_limit
            .key_extractor(ClientIpKeyExtractor)
            .finish()
            .unwrap_or_else(|| unreachable!("rate limit constants are non-zero"));
        let mut oidc_rate_limit = GovernorConfigBuilder::default();
        oidc_rate_limit
            .per_second(1)
            .burst_size(5)
            .methods(vec![Method::GET]);
        let oidc_rate_limit = oidc_rate_limit
            .key_extractor(ClientIpKeyExtractor)
            .finish()
            .unwrap_or_else(|| unreachable!("rate limit constants are non-zero"));
        let uploads = Router::new()
            .route("/_sable/upload", post(upload))
            .route("/_sable/send-attachment", post(send_attachment))
            .route("/_sable/send-gallery", post(send_gallery))
            .layer(ConcurrencyLimitLayer::new(4));
        let protected = Router::new()
            .route("/_sable/ws", get(ws::websocket))
            .route("/_sable/identity", get(server_identity))
            .route("/_sable/logout", post(logout))
            .route("/_sable/media/{server}/{media_id}", get(media))
            .route("/_sable/media/forget", post(forget_media))
            .route("/_sable/rtc/{session}", post(rtc_data))
            .merge(uploads);
        let static_files = ServeDir::new(self.frontend.directory.clone())
            .precompressed_gzip()
            .precompressed_br()
            .precompressed_deflate()
            .precompressed_zstd()
            .fallback(ServeFile::new(self.frontend.directory.join("index.html")));
        Router::new()
            .route("/healthz", get(health))
            .route("/_sable/oidc/status", get(oidc_status))
            .route(
                "/_sable/oidc/start",
                get(oidc_start)
                    .layer::<_, std::convert::Infallible>(ConcurrencyLimitLayer::new(8))
                    .layer(GovernorLayer::new(oidc_rate_limit))
                    .layer(middleware::from_fn(extract_client_ip)),
            )
            .route(
                "/_sable/oidc/callback",
                get(oidc_callback).layer(ConcurrencyLimitLayer::new(8)),
            )
            .route(
                "/_sable/auth",
                get(auth_status)
                    .post(authenticate)
                    .layer(GovernorLayer::new(rate_limit))
                    .layer(middleware::from_fn(extract_client_ip)),
            )
            .merge(protected)
            .fallback_service(static_files)
            .layer(RequestBodyLimitLayer::new(MAX_UPLOAD_SIZE))
            .layer(tower_http::timeout::RequestBodyTimeoutLayer::new(
                REQUEST_BODY_TIMEOUT,
            ))
            .layer(axum::extract::DefaultBodyLimit::max(MAX_UPLOAD_SIZE))
            .layer(SetResponseHeaderLayer::overriding(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                header::X_FRAME_OPTIONS,
                HeaderValue::from_static("DENY"),
            ))
            .layer(SetResponseHeaderLayer::overriding(
                header::REFERRER_POLICY,
                HeaderValue::from_static("strict-origin-when-cross-origin"),
            ))
            .layer(middleware::from_fn_with_state(
                self.clone(),
                auth_middleware,
            ))
            .layer(
                SessionManagerLayer::new(self.sessions.clone())
                    .with_name("__Host-sable_auth")
                    .with_http_only(true)
                    .with_secure(true)
                    .with_same_site(SameSite::Strict)
                    .with_path("/")
                    .with_expiry(Expiry::OnInactivity(time::Duration::minutes(30)))
                    .with_always_save(true),
            )
            .layer(self.client_ip_source.clone().into_extension())
            .layer(middleware::from_fn_with_state(
                self.clone(),
                cancel_on_shutdown,
            ))
            .with_state(self.clone())
    }

    #[must_use]
    pub fn core(&self) -> &Arc<Core> {
        &self.runtimes.legacy.core
    }
}

fn create_private_dir(path: &std::path::Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

impl UserRuntime {
    fn new(data_dir: PathBuf) -> std::io::Result<Arc<Self>> {
        let (core, core_events) = Self::build(data_dir)?;
        Ok(Self::from_parts(core, core_events))
    }

    fn build(
        data_dir: PathBuf,
    ) -> std::io::Result<(
        Arc<Core>,
        tokio::sync::mpsc::UnboundedReceiver<sable_core::protocol::CoreEvent>,
    )> {
        create_private_dir(&data_dir)?;
        Ok(Core::new(
            data_dir.to_string_lossy().into_owned(),
            Box::new(ExclusiveFileSessionStore::new(data_dir)),
        ))
    }

    fn from_parts(
        core: Arc<Core>,
        mut core_events: tokio::sync::mpsc::UnboundedReceiver<sable_core::protocol::CoreEvent>,
    ) -> Arc<Self> {
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        let runtime = Arc::new(Self {
            core,
            events,
            buffer: Mutex::new(EventBuffer {
                next_sequence: 1,
                records: VecDeque::with_capacity(EVENT_BUFFER),
            }),
            run_id: Arc::from(uuid::Uuid::new_v4().to_string()),
            connections: Arc::new(Semaphore::new(MAX_USER_CONNECTIONS)),
            rpc_tasks: Arc::new(Semaphore::new(MAX_USER_RPC_TASKS)),
            uploads: Arc::new(Semaphore::new(MAX_USER_UPLOADS)),
            http_requests: Arc::new(Semaphore::new(MAX_USER_HTTP_REQUESTS)),
            stopped: AtomicU8::new(0),
        });
        let publisher = Arc::downgrade(&runtime);
        tokio::spawn(async move {
            while let Some(event) = core_events.recv().await {
                let Some(runtime) = publisher.upgrade() else {
                    break;
                };
                runtime.publish_event(event).await;
            }
        });
        runtime
    }

    async fn publish_event(&self, event: sable_core::protocol::CoreEvent) {
        let mut buffer = self.buffer.lock().await;
        let sequence = buffer.next_sequence;
        let Ok(message) = serde_json::to_string(&EventEnvelope {
            seq: sequence,
            run_id: &self.run_id,
            event: &event,
        }) else {
            tracing::warn!("dropping an unserializable core event");
            return;
        };
        buffer.next_sequence = sequence.saturating_add(1);
        let failure = matches!(event, sable_core::protocol::CoreEvent::Failure { .. });
        let record = Arc::new(EventRecord {
            sequence,
            message: Arc::from(message),
            unclaimed: failure.then(|| AtomicBool::new(true)),
        });
        if buffer.records.len() == EVENT_BUFFER {
            buffer.records.pop_front();
        }
        buffer.records.push_back(record.clone());
        let _ = self.events.send(record);
    }

    async fn resume_and_subscribe(
        &self,
        run_id: Option<&str>,
        last: Option<u64>,
    ) -> (
        broadcast::Receiver<Arc<EventRecord>>,
        Vec<Arc<EventRecord>>,
        bool,
    ) {
        let buffer = self.buffer.lock().await;
        let receiver = self.events.subscribe();
        let Some(last) = last else {
            return (receiver, Vec::new(), false);
        };
        if run_id != Some(&self.run_id) {
            return (receiver, Vec::new(), true);
        }
        let Some(first) = buffer.records.front().map(|event| event.sequence) else {
            return (receiver, Vec::new(), false);
        };
        if last.saturating_add(1) < first {
            return (receiver, Vec::new(), true);
        }
        (
            receiver,
            buffer
                .records
                .iter()
                .filter(|event| event.sequence > last)
                .cloned()
                .collect(),
            false,
        )
    }
}

impl Frontend {
    const fn load(directory: PathBuf) -> Self {
        Self { directory }
    }
}

async fn health() -> &'static str {
    "ok"
}

pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    {
        use tracing_subscriber::filter::Targets;
        use tracing_subscriber::layer::SubscriberExt as _;
        use tracing_subscriber::util::SubscriberInitExt as _;
        // What `fmt::init` did before the error layer needed a registry.
        let targets = std::env::var("RUST_LOG")
            .ok()
            .and_then(|filter| filter.parse::<Targets>().ok())
            .unwrap_or_else(|| Targets::new().with_default(tracing::Level::INFO));
        tracing_subscriber::registry()
            .with(targets)
            .with(sable_core::binding::ErrorLayer::default())
            .with(tracing_subscriber::fmt::layer())
            .init();
    }
    let cli = Cli::parse();
    if let Some(command) = cli.command {
        return command.run(cli.config);
    }
    let config = Config::load(cli.config)?;
    let listener = tokio::net::TcpListener::bind(&config.listen_addr).await?;
    let server = Server::new(config)?;
    tracing::info!(address = %listener.local_addr()?, "sable server listening");
    let shutdown_server = server.clone();
    axum::serve(
        listener,
        server
            .app()
            .into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        shutdown_server.begin_shutdown();
    })
    .await?;
    server.runtimes.shutdown().await;
    Ok(())
}

fn lock_instance(data_dir: &std::path::Path) -> std::io::Result<std::fs::File> {
    std::fs::create_dir_all(data_dir)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join("server.lock"))?;
    file.try_lock().map_err(std::io::Error::other)?;
    Ok(file)
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let ctrl_c = tokio::signal::ctrl_c();
        let Ok(mut terminate) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        else {
            return;
        };
        tokio::select! {
            _ = ctrl_c => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_lock_prevents_concurrent_server_or_removal() {
        let dir = tempfile::tempdir().unwrap();
        let lock = lock_instance(dir.path()).unwrap();
        lock_instance(dir.path()).unwrap_err();
        drop(lock);
        drop(lock_instance(dir.path()).unwrap());
    }

    #[tokio::test]
    async fn stopped_runtime_is_not_reopened_while_still_owned() {
        let dir = tempfile::tempdir().unwrap();
        let manager = RuntimeManager::new(dir.path().join("data"), 2).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let runtime = manager.get(&id).await.unwrap();
        manager.stop_disabled(&users::UserRegistry::default()).await;
        drop(manager.get(&id).await.unwrap());
        assert!(
            manager
                .get(&uuid::Uuid::new_v4().to_string())
                .await
                .is_err()
        );
        let registry = users::UserRegistry {
            users: vec![users::User {
                id: id.clone(),
                username: None,
                password_hash: None,
                disabled: true,
                deleted: false,
                session_version: 0,
                identities: Vec::new(),
            }],
        };
        manager.stop_disabled(&registry).await;
        assert!(manager.get(&id).await.is_err());
        manager.stop_disabled(&registry).await;
        assert!(manager.get(&id).await.is_err());
        drop(runtime);
        manager.stop_disabled(&registry).await;
        drop(manager.get(&id).await.unwrap());
    }

    #[tokio::test]
    async fn runtime_manager_serializes_initialization_and_separates_users() {
        let dir = tempfile::tempdir().unwrap();
        let manager = Arc::new(RuntimeManager::new(dir.path().join("data"), 128).unwrap());
        let id = uuid::Uuid::new_v4().to_string();
        let (a, b) = tokio::join!(manager.get(&id), manager.get(&id));
        let a = a.unwrap();
        let b = b.unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        let other = manager
            .get(&uuid::Uuid::new_v4().to_string())
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&a, &other));
        assert!(manager.get("../escape").await.is_err());
    }

    #[tokio::test]
    async fn failed_runtime_initialization_can_retry_and_shutdown_refuses_new_users() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("data");
        let manager = RuntimeManager::new(root.clone(), 4).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let user_dir = root.join("users").join(&id);
        std::fs::create_dir_all(user_dir.parent().unwrap()).unwrap();
        std::fs::write(&user_dir, "not a directory").unwrap();
        assert!(manager.get(&id).await.is_err());
        std::fs::remove_file(user_dir).unwrap();
        manager.get(&id).await.unwrap();
        manager.shutdown().await;
        assert!(manager.get(&id).await.is_err());
        assert!(manager.get("legacy").await.is_err());
        assert!(
            manager
                .get(&uuid::Uuid::new_v4().to_string())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn shutdown_waits_for_initializing_runtime_and_blocks_new_lookups() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("data");
        let manager = Arc::new(RuntimeManager::new(root.clone(), 4).unwrap());
        let id = uuid::Uuid::new_v4().to_string();
        let cell = Arc::new(OnceCell::new());
        manager.users.lock().await.insert(id.clone(), cell.clone());
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let initialization = {
            let started = started.clone();
            let release = release.clone();
            tokio::spawn(async move {
                cell.get_or_init(|| async {
                    started.notify_one();
                    release.notified().await;
                    UserRuntime::new(root.join("late")).unwrap()
                })
                .await
                .clone()
            })
        };
        started.notified().await;
        let closing = {
            let manager = manager.clone();
            tokio::spawn(async move { manager.shutdown().await })
        };
        while !manager.shutting_down.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
        assert!(manager.get(&id).await.is_err());
        assert!(!closing.is_finished());
        release.notify_one();
        initialization.await.unwrap();
        closing.await.unwrap();
        assert!(manager.get(&id).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn user_runtime_secures_existing_workspace_parent() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("data");
        let id = uuid::Uuid::new_v4().to_string();
        let user = root.join("users").join(&id);
        std::fs::create_dir_all(&user).unwrap();
        std::fs::set_permissions(&user, std::fs::Permissions::from_mode(0o755)).unwrap();
        let manager = RuntimeManager::new(root, 2).unwrap();
        manager.get(&id).await.unwrap();
        assert_eq!(
            std::fs::metadata(&user).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(user.join("data"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }

    #[tokio::test]
    async fn runtimes_keep_events_and_replay_separate() {
        let dir = tempfile::tempdir().unwrap();
        let first = UserRuntime::new(dir.path().join("first")).unwrap();
        let second = UserRuntime::new(dir.path().join("second")).unwrap();
        let (mut first_events, _, _) = first.resume_and_subscribe(None, None).await;
        let (mut second_events, _, _) = second.resume_and_subscribe(None, None).await;
        first
            .publish_event(sable_core::protocol::CoreEvent::SessionEnded {
                reason: "first user's event".to_owned(),
            })
            .await;
        first_events.try_recv().unwrap();
        assert!(second_events.try_recv().is_err());
        let (_, replay, reset) = second
            .resume_and_subscribe(Some(&first.run_id), Some(0))
            .await;
        assert!(reset);
        assert!(replay.is_empty());
        let (_, replay, reset) = first
            .resume_and_subscribe(Some(&first.run_id), Some(0))
            .await;
        assert!(!reset);
        assert_eq!(replay.len(), 1);
    }

    #[tokio::test]
    async fn a_core_failure_goes_to_one_client_and_other_events_to_all() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = UserRuntime::new(dir.path().join("user")).unwrap();
        let (mut first, _, _) = runtime.resume_and_subscribe(None, None).await;
        let (mut second, _, _) = runtime.resume_and_subscribe(None, None).await;
        runtime
            .publish_event(sable_core::protocol::CoreEvent::Failure {
                log_id: "e1".to_owned(),
                context: "join_room".to_owned(),
                report: Box::default(),
            })
            .await;
        runtime
            .publish_event(sable_core::protocol::CoreEvent::SessionEnded {
                reason: "signed out".to_owned(),
            })
            .await;

        let (failure, ended) = (first.try_recv().unwrap(), first.try_recv().unwrap());
        assert!(failure.claim());
        assert!(ended.claim());
        let (failure, ended) = (second.try_recv().unwrap(), second.try_recv().unwrap());
        assert!(!failure.claim(), "a second client would report it again");
        assert!(ended.claim());

        let (_, replay, _) = runtime
            .resume_and_subscribe(Some(&runtime.run_id), Some(0))
            .await;
        let resent = replay.iter().filter(|event| event.claim()).count();
        assert_eq!(resent, 1, "a reconnect must not replay the failure");
    }
}
