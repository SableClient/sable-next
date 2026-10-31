#![recursion_limit = "256"]
#![expect(clippy::missing_errors_doc, reason = "errors are the returned types")]

mod auth;
pub mod config;
mod oidc;
mod outbound;
mod sessions;
mod users;

use std::{
    collections::{HashMap, VecDeque},
    io::{IsTerminal, Read},
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, Ordering},
    },
    time::{Duration, Instant},
};

use axum::{
    Extension, Router,
    body::{Body, Bytes},
    extract::{FromRequestParts, Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use axum_client_ip::{ClientIp, ClientIpSource};
use axum_extra::{
    TypedHeader,
    headers::{
        Cookie, HeaderMapExt,
        authorization::{Authorization, Basic},
    },
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use clap::{Parser, Subcommand};
use futures_util::{SinkExt, StreamExt};
use sable_core::{Core, protocol::RpcError, store::ExclusiveFileSessionStore};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, value::RawValue};
use tokio::sync::{Mutex, OnceCell, Semaphore, broadcast, mpsc, watch};
use tower::limit::ConcurrencyLimitLayer;
use tower_governor::{
    GovernorError, GovernorLayer, governor::GovernorConfigBuilder, key_extractor::KeyExtractor,
};
use tower_http::{
    limit::RequestBodyLimitLayer,
    services::{ServeDir, ServeFile},
    set_header::response::SetResponseHeaderLayer,
};
use tower_sessions::{Expiry, Session, SessionManagerLayer, cookie::SameSite};

use crate::{
    auth::{Auth, logout as destroy_session},
    config::{Config, is_loopback_url},
    sessions::SessionMemoryStore,
};

const EVENT_BUFFER: usize = 256;
const OUTGOING_BUFFER: usize = 128;
const PING_INTERVAL: Duration = Duration::from_secs(20);
const PING_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_UPLOAD_SIZE: usize = 100 * 1024 * 1024;
const MAX_WEBSOCKET_MESSAGE_SIZE: usize = 1024 * 1024;
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

const RESET_FRAME: &str = r#"{"reset":true}"#;

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
    shutdown: watch::Sender<bool>,
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
            shutdown: watch::channel(false).0,
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
        self.shutdown.send_replace(true);
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
            .route("/_sable/ws", get(websocket))
            .route("/_sable/identity", get(server_identity))
            .route("/_sable/logout", post(logout))
            .route("/_sable/media/{server}/{media_id}", get(media))
            .route("/_sable/media/forget", post(forget_media))
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
        let record = Arc::new(EventRecord {
            sequence,
            message: Arc::from(message),
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

#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    id: Value,
    method: Option<String>,
    #[serde(default = "empty_params")]
    params: Box<RawValue>,
}

fn empty_params() -> Box<RawValue> {
    RawValue::from_string("{}".to_owned()).unwrap_or_else(|_| RawValue::NULL.to_owned())
}

#[derive(Serialize)]
#[serde(untagged)]
enum Reply {
    Ok { id: Value, ok: Box<RawValue> },
    Error { id: Value, error: RpcError },
}

#[derive(Serialize)]
struct ServerMessage<'a> {
    server: ServerInfo<'a>,
}

#[derive(Serialize)]
struct ServerInfo<'a> {
    version: &'a str,
    run_id: &'a str,
    user_id: &'a str,
}

#[derive(Deserialize)]
struct ResumeQuery {
    user_id: Option<String>,
    run_id: Option<String>,
    last_received_event: Option<u64>,
}

#[derive(Deserialize)]
struct MediaQuery {
    width: Option<u32>,
    height: Option<u32>,
    background: Option<bool>,
    source: Option<String>,
    inline: Option<bool>,
}

async fn health() -> &'static str {
    "ok"
}

#[derive(Deserialize)]
struct OidcCallback {
    code: String,
    state: String,
}

async fn oidc_status(State(server): State<Server>) -> Response {
    let mut response = axum::Json(
        serde_json::json!({ "oidc": server.oidc.is_some(), "local": server.auth.local_enabled() }),
    )
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn oidc_start(
    State(server): State<Server>,
    Extension(ClientIp(ip)): Extension<ClientIp>,
    headers: HeaderMap,
) -> Response {
    let Some(oidc) = &server.oidc else {
        return StatusCode::NOT_FOUND.into_response();
    };
    {
        let mut transactions = server.oidc_transactions.lock().await;
        transactions.retain(|_, (created, _, _)| created.elapsed() < Duration::from_secs(600));
        if let Some(previous) = oidc_cookie(&headers) {
            transactions.remove(&previous);
        }
        if transactions.len() >= 1024
            || transactions
                .values()
                .filter(|(_, owner, _)| *owner == ip)
                .count()
                >= 5
        {
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }
    let Ok((url, transaction)) = oidc.start().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let cookie = uuid::Uuid::new_v4().to_string();
    let mut transactions = server.oidc_transactions.lock().await;
    transactions.retain(|_, (created, _, _)| created.elapsed() < Duration::from_secs(600));
    if let Some(previous) = oidc_cookie(&headers) {
        transactions.remove(&previous);
    }
    if transactions.len() >= 1024
        || transactions
            .values()
            .filter(|(_, owner, _)| *owner == ip)
            .count()
            >= 5
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    transactions.insert(cookie.clone(), (Instant::now(), ip, transaction));
    let mut response = axum::response::Redirect::temporary(&url).into_response();
    let cookie =
        format!("__Host-sable_oidc={cookie}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600");
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

fn oidc_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .typed_get::<Cookie>()?
        .get("__Host-sable_oidc")
        .map(ToOwned::to_owned)
}

async fn oidc_callback(
    State(server): State<Server>,
    session: Session,
    headers: HeaderMap,
    Query(query): Query<OidcCallback>,
) -> Response {
    let Some(oidc) = &server.oidc else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let cookie = oidc_cookie(&headers);
    let Some(cookie) = cookie else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let transaction = server.oidc_transactions.lock().await.remove(&cookie);
    let Some((created, _, transaction)) = transaction else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if created.elapsed() >= Duration::from_secs(600) || transaction.state != query.state {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(subject) = oidc.exchange(query.code, transaction).await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let user_id = if server.oidc_auto_provision {
        server
            .auth
            .provision_oidc(oidc.issuer.clone(), subject)
            .await
    } else {
        server.auth.oidc_user(&oidc.issuer, &subject)
    };
    let Some(user_id) = user_id else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if server.auth.login(&session, &user_id, None).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let mut response = axum::response::Redirect::to("/").into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "__Host-sable_oidc=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
        ),
    );
    response
}

#[derive(Clone)]
struct ServerUserId(String);

async fn server_identity(Extension(user): Extension<ServerUserId>) -> Response {
    let mut response = axum::Json(serde_json::json!({ "id": user.0 })).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn auth_status(State(server): State<Server>, session: Session) -> Response {
    if server.auth.authenticate(&session).await.is_some() {
        StatusCode::NO_CONTENT.into_response()
    } else {
        unauthorized().into_response()
    }
}

async fn authenticate(
    State(server): State<Server>,
    session: Session,
    credentials: Option<TypedHeader<Authorization<Basic>>>,
) -> Response {
    let Ok(permit) = server.password_checks.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let Some((user_id, version)) = server
        .auth
        .check_basic(credentials.as_ref().map(|TypedHeader(value)| value), permit)
        .await
    else {
        let mut response = StatusCode::UNAUTHORIZED.into_response();
        response.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            HeaderValue::from_static("Basic realm=\"Sable\", charset=\"UTF-8\""),
        );
        return response;
    };
    if server
        .auth
        .login(&session, &user_id, Some(version))
        .await
        .is_err()
    {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn logout(State(server): State<Server>, session: Session) -> Response {
    let id = session.id();
    if destroy_session(&session).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Some(id) = id {
        let _ = server
            .session_revocations
            .send(SessionRevocation::Session(id));
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn cancel_on_shutdown(
    State(server): State<Server>,
    request: axum::http::Request<Body>,
    next: Next,
) -> Response {
    let mut shutdown = server.shutdown.subscribe();
    if *shutdown.borrow() || server.runtimes.shutting_down.load(Ordering::Acquire) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    tokio::select! {
        _ = shutdown.changed() => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        response = next.run(request) => response,
    }
}

async fn auth_middleware(
    State(server): State<Server>,
    mut request: axum::http::Request<Body>,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    if !path.starts_with("/_sable/") && path != "/_sable" {
        return next.run(request).await;
    }
    let session = request.extensions().get::<Session>().cloned();
    let user_id = if let Some(session) = &session {
        server.auth.authenticate(session).await
    } else {
        None
    };
    if matches!(
        path.as_str(),
        "/_sable/oidc/status" | "/_sable/oidc/start" | "/_sable/oidc/callback"
    ) {
        return next.run(request).await;
    }
    if path == "/_sable/auth" {
        if request.method() != Method::GET
            && request.method() != Method::HEAD
            && request.headers().contains_key(header::COOKIE)
            && !same_origin(request.headers(), &server.public_url)
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        return next.run(request).await;
    }
    let Some(user_id) = user_id else {
        return unauthorized().into_response();
    };
    if request
        .headers()
        .get("x-sable-user")
        .is_some_and(|expected| expected.as_bytes() != user_id.as_bytes())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let state_change = request.method() != Method::GET && request.method() != Method::HEAD;
    let websocket = path == "/_sable/ws";
    if (state_change || websocket) && !same_origin(request.headers(), &server.public_url) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let runtime = match server.runtimes.get(&user_id).await {
        Ok(runtime) => runtime,
        Err(error) => {
            tracing::error!(%error, "failed to open user runtime");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    };
    // Logout must remain available even if a user has exhausted their request quota.
    let (_request, _user_request) = if path == "/_sable/logout" || websocket {
        (None, None)
    } else {
        let Ok(request_permit) = server.http_requests.clone().try_acquire_owned() else {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        };
        let Ok(user_permit) = runtime.http_requests.clone().try_acquire_owned() else {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        };
        (Some(request_permit), Some(user_permit))
    };
    let _upload = if matches!(
        path.as_str(),
        "/_sable/upload" | "/_sable/send-attachment" | "/_sable/send-gallery"
    ) {
        match runtime.uploads.clone().try_acquire_owned() {
            Ok(permit) => Some(permit),
            Err(_) => return StatusCode::TOO_MANY_REQUESTS.into_response(),
        }
    } else {
        None
    };
    let Some(session_id) = session.and_then(|session| session.id()) else {
        return unauthorized().into_response();
    };
    request.extensions_mut().insert(runtime);
    request
        .extensions_mut()
        .insert(ServerUserId(user_id.clone()));
    if path == "/_sable/logout" {
        return next.run(request).await;
    }

    run_protected_request(&server, session_id, &user_id, request, next).await
}

async fn run_protected_request(
    server: &Server,
    session_id: tower_sessions::session::Id,
    user_id: &str,
    request: axum::http::Request<Body>,
    next: Next,
) -> Response {
    let mut revocations = server.session_revocations.subscribe();
    let valid_session = || async {
        let session = Session::new(Some(session_id), Arc::new(server.sessions.clone()), None);
        server.auth.authenticate(&session).await.as_deref() == Some(user_id)
    };
    if !valid_session().await {
        return unauthorized().into_response();
    }
    let response = next.run(request);
    tokio::pin!(response);
    loop {
        tokio::select! {
            result = &mut response => {
                return if valid_session().await { result } else { unauthorized().into_response() };
            }
            revoked = revocations.recv() => {
                if SessionRevocation::ends(&revoked, session_id, user_id) {
                    return unauthorized().into_response();
                }
            }
        }
    }
}

fn same_origin(headers: &HeaderMap, public_url: &str) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| origin == public_url)
}

#[derive(Clone, Copy)]
struct ClientIpKeyExtractor;

impl KeyExtractor for ClientIpKeyExtractor {
    type Key = IpAddr;

    fn extract<T>(&self, request: &axum::http::Request<T>) -> Result<Self::Key, GovernorError> {
        request
            .extensions()
            .get::<ClientIp>()
            .map(|ClientIp(ip)| *ip)
            .ok_or(GovernorError::UnableToExtractKey)
    }
}

fn unauthorized() -> Response {
    StatusCode::UNAUTHORIZED.into_response()
}

async fn extract_client_ip(request: axum::http::Request<Body>, next: Next) -> Response {
    let (mut parts, body) = request.into_parts();
    let Ok(client_ip) = ClientIp::from_request_parts(&mut parts, &()).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    parts.extensions.insert(client_ip);
    next.run(axum::http::Request::from_parts(parts, body)).await
}

async fn websocket(
    State(server): State<Server>,
    Extension(runtime): Extension<Arc<UserRuntime>>,
    session: Session,
    Query(query): Query<ResumeQuery>,
    upgrade: yawc::IncomingUpgrade,
) -> Response {
    let Some(session_id) = session.id() else {
        return unauthorized().into_response();
    };
    let Some(user_id) = server.auth.authenticate(&session).await else {
        return unauthorized().into_response();
    };
    if query
        .user_id
        .as_deref()
        .is_some_and(|expected| expected != user_id)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let revocations = server.session_revocations.subscribe();
    let Some(connection) = server.connections.clone().try_acquire_owned().ok() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Some(user_connection) = runtime.connections.clone().try_acquire_owned().ok() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let options = yawc::Options::default()
        .with_balanced_compression()
        .with_limits(MAX_WEBSOCKET_MESSAGE_SIZE, MAX_WEBSOCKET_MESSAGE_SIZE)
        .with_utf8();
    let Ok((response, upgrade)) = upgrade.upgrade(options) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    tokio::spawn(async move {
        if let Ok(socket) = upgrade.await {
            handle_socket(
                socket,
                server,
                runtime,
                session_id,
                user_id,
                revocations,
                query,
                connection,
                user_connection,
            )
            .await;
        }
    });
    response.into_response()
}

#[expect(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "socket owns its session, revocation state, and connection permits"
)]
async fn handle_socket(
    socket: yawc::HttpWebSocket,
    server: Server,
    runtime: Arc<UserRuntime>,
    session_id: tower_sessions::session::Id,
    user_id: String,
    mut revocations: broadcast::Receiver<SessionRevocation>,
    query: ResumeQuery,
    _connection: tokio::sync::OwnedSemaphorePermit,
    _user_connection: tokio::sync::OwnedSemaphorePermit,
) {
    let mut shutdown = server.shutdown.subscribe();
    if *shutdown.borrow() {
        return;
    }
    let valid_session = || async {
        let session = Session::new(Some(session_id), Arc::new(server.sessions.clone()), None);
        server.auth.authenticate(&session).await.as_deref() == Some(user_id.as_str())
    };
    if !valid_session().await {
        return;
    }
    let (sink, mut stream) = socket.split();
    let (outgoing, messages) = mpsc::channel(OUTGOING_BUFFER);
    let writer = tokio::spawn(write_socket(sink, messages));
    let mut receiver = {
        let greeting = greet(&server.version, &runtime, &user_id, &query, &outgoing);
        tokio::pin!(greeting);
        loop {
            tokio::select! {
                _ = shutdown.changed() => { writer.abort(); return; }
                revoked = revocations.recv() => {
                    if SessionRevocation::ends(&revoked, session_id, &user_id) {
                        writer.abort();
                        return;
                    }
                }
                result = &mut greeting => {
                    let Some(receiver) = result else { writer.abort(); return; };
                    break receiver;
                }
            }
        }
    };
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await;
    let mut last_received = Instant::now();
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            revoked = revocations.recv() => {
                if SessionRevocation::ends(&revoked, session_id, &user_id) { break; }
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
            message = stream.next() => {
                let Some(message) = message else { break };
                match message.opcode() {
                    yawc::OpCode::Text => {
                        if !valid_session().await { break; }
                        last_received = Instant::now();
                        let Ok(text) = std::str::from_utf8(message.payload()) else {
                            break;
                        };
                        let Ok(request) = serde_json::from_str::<Request>(text) else {
                            let reply = Reply::Error {
                                id: Value::Null,
                                error: RpcError::Failed {
                                    log_id: "invalid websocket request".to_owned(),
                                },
                            };
                            if !try_send_reply(&outgoing, &reply) {
                                break;
                            }
                            continue;
                        };
                        spawn_rpc(&server, &runtime, request, &outgoing, &mut tasks);
                    }
                    yawc::OpCode::Ping | yawc::OpCode::Pong => last_received = Instant::now(),
                    yawc::OpCode::Close => break,
                    yawc::OpCode::Binary | yawc::OpCode::Continuation => {}
                }
            }
            event = receiver.recv() => {
                match event {
                    Ok(event) => {
                        if !valid_session().await { break; }
                        if outgoing.try_send(yawc::Frame::text(event.message.to_string())).is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let _ = outgoing.try_send(yawc::Frame::text(RESET_FRAME));
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = ping.tick() => {
                if last_received.elapsed() > PING_TIMEOUT
                    || outgoing.try_send(yawc::Frame::ping(Bytes::new())).is_err()
                {
                    break;
                }
            }
        }
    }
    writer.abort();
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    let _ = writer.await;
}

fn spawn_rpc(
    server: &Server,
    runtime: &UserRuntime,
    request: Request,
    outgoing: &mpsc::Sender<yawc::Frame>,
    tasks: &mut tokio::task::JoinSet<()>,
) {
    let Some(permit) = server.rpc_tasks.clone().try_acquire_owned().ok() else {
        reject_rate_limited(outgoing, request.id);
        return;
    };
    let Some(user_permit) = runtime.rpc_tasks.clone().try_acquire_owned().ok() else {
        reject_rate_limited(outgoing, request.id);
        return;
    };
    let core = runtime.core.clone();
    let outgoing = outgoing.clone();
    tasks.spawn(async move {
        let _permit = permit;
        let _user_permit = user_permit;
        let reply = if let Some(method) = request.method {
            match core.call(&method, request.params.get()).await {
                Ok(ok) => Reply::Ok { id: request.id, ok },
                Err(error) => Reply::Error {
                    id: request.id,
                    error,
                },
            }
        } else {
            Reply::Error {
                id: request.id,
                error: RpcError::Unsupported,
            }
        };
        send_reply(&outgoing, reply).await;
    });
}

fn reject_rate_limited(outgoing: &mpsc::Sender<yawc::Frame>, id: Value) {
    let reply = Reply::Error {
        id,
        error: RpcError::RateLimited {
            retry_after_ms: Some(100),
        },
    };
    try_send_reply(outgoing, &reply);
}

async fn write_socket(
    mut sink: futures_util::stream::SplitSink<yawc::HttpWebSocket, yawc::Frame>,
    mut messages: mpsc::Receiver<yawc::Frame>,
) {
    while let Some(message) = messages.recv().await {
        if sink.send(message).await.is_err() {
            break;
        }
    }
}

/// Sends the hello and what the client missed, or a reset when the gap is gone.
async fn greet(
    version: &str,
    runtime: &UserRuntime,
    user_id: &str,
    query: &ResumeQuery,
    outgoing: &mpsc::Sender<yawc::Frame>,
) -> Option<broadcast::Receiver<Arc<EventRecord>>> {
    let (receiver, replayed, reset) = runtime
        .resume_and_subscribe(query.run_id.as_deref(), query.last_received_event)
        .await;
    let hello = serde_json::to_string(&ServerMessage {
        server: ServerInfo {
            version,
            run_id: &runtime.run_id,
            user_id,
        },
    })
    .ok()?;
    if !send_text(outgoing, &hello).await {
        return None;
    }
    if reset {
        return send_text(outgoing, RESET_FRAME).await.then_some(receiver);
    }
    for event in replayed {
        if !send_text(outgoing, &event.message).await {
            return None;
        }
    }
    Some(receiver)
}

/// False once the socket's writer is gone.
async fn send_text(outgoing: &mpsc::Sender<yawc::Frame>, text: &str) -> bool {
    outgoing
        .send(yawc::Frame::text(text.to_owned()))
        .await
        .is_ok()
}

fn try_send_reply(outgoing: &mpsc::Sender<yawc::Frame>, reply: &Reply) -> bool {
    serde_json::to_string(reply)
        .is_ok_and(|message| outgoing.try_send(yawc::Frame::text(message)).is_ok())
}

async fn send_reply(outgoing: &mpsc::Sender<yawc::Frame>, reply: Reply) -> bool {
    match serde_json::to_string(&reply) {
        Ok(message) => send_text(outgoing, &message).await,
        Err(_) => false,
    }
}

async fn media(
    Extension(runtime): Extension<Arc<UserRuntime>>,
    AxumPath((media_server, media_id)): AxumPath<(String, String)>,
    Query(query): Query<MediaQuery>,
) -> Response {
    let source = query
        .source
        .and_then(|source| URL_SAFE_NO_PAD.decode(source).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| format!("mxc://{media_server}/{media_id}"));
    let bytes = match runtime
        .core
        .fetch_media(
            source,
            query.width.unwrap_or(0),
            query.height.unwrap_or(0),
            query.background.unwrap_or(false),
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => return rpc_error_response(error),
    };
    let content_type = if query.width.unwrap_or(0) > 0 || query.height.unwrap_or(0) > 0 {
        "image/jpeg"
    } else {
        "application/octet-stream"
    };
    let mut response = (StatusCode::OK, bytes).into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    let disposition = if query.inline.unwrap_or(false) && content_type.starts_with("image/") {
        "inline"
    } else {
        "attachment"
    };
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static(disposition),
    );
    response
}

async fn upload(
    Extension(runtime): Extension<Arc<UserRuntime>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    match runtime.core.upload_media(mime, body.into()).await {
        Ok(uri) => (StatusCode::OK, axum::Json(uri)).into_response(),
        Err(error) => rpc_error_response(error),
    }
}

#[derive(Deserialize)]
struct ForgetMediaRequest {
    source: String,
}

async fn forget_media(
    Extension(runtime): Extension<Arc<UserRuntime>>,
    axum::Json(request): axum::Json<ForgetMediaRequest>,
) -> Response {
    match runtime.core.forget_media(request.source).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => rpc_error_response(error),
    }
}

async fn send_attachment(
    Extension(runtime): Extension<Arc<UserRuntime>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Ok(request) = decode_carried::<sable_core::protocol::SendAttachmentRequest>(&headers)
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match runtime.core.send_attachment(request, body.into()).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => rpc_error_response(error),
    }
}

async fn send_gallery(
    Extension(runtime): Extension<Arc<UserRuntime>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Ok(request) = decode_carried::<sable_core::protocol::SendGalleryRequest>(&headers) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match runtime.core.send_gallery(request, body.into()).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => rpc_error_response(error),
    }
}

fn decode_carried<T: DeserializeOwned>(headers: &HeaderMap) -> Result<T, ()> {
    let Some(encoded) = headers
        .get("x-sable-request")
        .and_then(|value| value.to_str().ok())
    else {
        return Err(());
    };
    URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| ())
        .and_then(|request| serde_json::from_slice(&request).map_err(|_| ()))
}

fn rpc_error_response(error: RpcError) -> Response {
    (StatusCode::BAD_GATEWAY, axum::Json(error)).into_response()
}

#[derive(Parser)]
#[command(name = "sable-server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(long)]
    config: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    HashPassword,
    AddUser {
        username: String,
    },
    AddOidcUser {
        subject: String,
    },
    DisableUser {
        id: String,
    },
    RemoveUser {
        id: String,
        #[arg(long)]
        delete_data: bool,
    },
    EnableUser {
        id: String,
    },
    SetUserPassword {
        id: String,
    },
    ListUsers,
}

#[expect(
    clippy::too_many_lines,
    reason = "CLI dispatch keeps administrative operations together"
)]
pub async fn run() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt::init();
    let cli = Cli::parse();
    if matches!(cli.command, Some(Command::HashPassword)) {
        use argon2::{Argon2, Params, PasswordHasher, Version};

        let password = if std::io::stdin().is_terminal() {
            rpassword::prompt_password("Password: ")?
        } else {
            let mut password = String::new();
            std::io::stdin().read_to_string(&mut password)?;
            password.trim_end().to_owned()
        };
        let params = Params::new(19_456, 2, 1, None)?;
        let argon2 = Argon2::new(argon2::Algorithm::Argon2id, Version::V0x13, params);
        println!("{}", argon2.hash_password(password.as_bytes())?);
        return Ok(());
    }
    let config = Config::load(cli.config)?;
    if let Some(Command::AddUser { ref username }) = cli.command {
        use argon2::{Argon2, Params, PasswordHasher, Version};
        if username == &config.username {
            return Err("username is reserved for the existing account".into());
        }
        let password = rpassword::prompt_password("Password: ")?;
        if password.is_empty() {
            return Err("password cannot be empty".into());
        }
        let argon2 = Argon2::new(
            argon2::Algorithm::Argon2id,
            Version::V0x13,
            Params::new(19_456, 2, 1, None)?,
        );
        let hash = argon2.hash_password(password.as_bytes())?.to_string();
        let id =
            users::UserRegistry::add_local(&config.data_dir.join("users.json"), username, &hash)?;
        println!("Created user {username} ({id}).");
        return Ok(());
    }
    if let Some(Command::AddOidcUser { ref subject }) = cli.command {
        let issuer = config
            .oidc_issuer
            .as_deref()
            .ok_or("OIDC issuer is not configured")?;
        let id =
            users::UserRegistry::add_oidc(&config.data_dir.join("users.json"), issuer, subject)?;
        println!("Created OIDC user {id}.");
        return Ok(());
    }
    if let Some(Command::DisableUser { ref id }) = cli.command {
        users::UserRegistry::set_disabled(&config.data_dir.join("users.json"), id, true)?;
        println!("Disabled user {id}.");
        return Ok(());
    }
    if let Some(Command::EnableUser { ref id }) = cli.command {
        users::UserRegistry::set_disabled(&config.data_dir.join("users.json"), id, false)?;
        println!("Enabled user {id}.");
        return Ok(());
    }
    if let Some(Command::SetUserPassword { ref id }) = cli.command {
        use argon2::{Argon2, Params, PasswordHasher, Version};
        let password = rpassword::prompt_password("Password: ")?;
        if password.is_empty() {
            return Err("password cannot be empty".into());
        }
        let argon2 = Argon2::new(
            argon2::Algorithm::Argon2id,
            Version::V0x13,
            Params::new(19_456, 2, 1, None)?,
        );
        let hash = argon2.hash_password(password.as_bytes())?.to_string();
        users::UserRegistry::set_password(&config.data_dir.join("users.json"), id, hash)?;
        println!("Updated password for user {id}.");
        return Ok(());
    }
    if matches!(cli.command, Some(Command::ListUsers)) {
        let users = users::UserRegistry::load(&config.data_dir.join("users.json"))?;
        for user in users.users {
            println!(
                "{}\t{}\t{}",
                user.id,
                user.username.as_deref().unwrap_or("OIDC"),
                if user.disabled { "disabled" } else { "enabled" }
            );
        }
        return Ok(());
    }
    if let Some(Command::RemoveUser {
        ref id,
        delete_data,
    }) = cli.command
    {
        let uuid = uuid::Uuid::parse_str(id)?;
        if uuid.to_string() != *id {
            return Err("user ID must be a canonical UUID".into());
        }
        let _lock = lock_instance(&config.data_dir)?;
        users::UserRegistry::mark_deleted(&config.data_dir.join("users.json"), id)?;
        if delete_data {
            let path = config.data_dir.join("users").join(id);
            match std::fs::remove_dir_all(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        println!("Removed user {id}.");
        return Ok(());
    }
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
    fn oidc_cookie_is_read_from_multiple_cookie_headers() {
        let mut headers = HeaderMap::new();
        headers.append(header::COOKIE, HeaderValue::from_static("other=value"));
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("another=value; __Host-sable_oidc=transaction"),
        );
        assert_eq!(oidc_cookie(&headers).as_deref(), Some("transaction"));
        assert_eq!(oidc_cookie(&HeaderMap::new()), None);
    }

    #[test]
    fn request_params_default_to_an_empty_object_and_keep_explicit_null() {
        let missing: Request = serde_json::from_str(r#"{"id":1,"method":"m"}"#).unwrap();
        assert_eq!(missing.params.get(), "{}");
        let null: Request = serde_json::from_str(r#"{"id":1,"method":"m","params":null}"#).unwrap();
        assert_eq!(null.params.get(), "null");
        let given: Request =
            serde_json::from_str(r#"{"id":1,"method":"m","params":{"a": 1}}"#).unwrap();
        assert_eq!(given.params.get(), r#"{"a": 1}"#);
    }

    #[test]
    fn instance_lock_prevents_concurrent_server_or_removal() {
        let dir = tempfile::tempdir().unwrap();
        let lock = lock_instance(dir.path()).unwrap();
        lock_instance(dir.path()).unwrap_err();
        drop(lock);
        drop(lock_instance(dir.path()).unwrap());
    }

    #[tokio::test]
    async fn oidc_callback_rejects_mismatched_and_replayed_state() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config {
            listen_addr: "127.0.0.1:18008".into(),
            public_url: "http://127.0.0.1:18008".into(),
            client_ip_source: ClientIpSource::ConnectInfo,
            data_dir: dir.path().to_owned(),
            max_active_users: 128,
            allowed_private_cidrs: vec!["127.0.0.1/32".into()],
            username: "legacy".into(),
            password_hash: None,
            oidc_issuer: Some("http://127.0.0.1:9999".into()),
            oidc_client_id: Some("client".into()),
            oidc_client_secret: Some("secret".into()),
            oidc_auto_provision: false,
            frontend_dir: dir.path().join("missing"),
        };
        let server = Server::new(config).unwrap();
        server.oidc_transactions.lock().await.insert(
            "cookie".into(),
            (
                Instant::now(),
                IpAddr::from([127, 0, 0, 1]),
                oidc::Transaction {
                    state: "expected".into(),
                    nonce: "nonce".into(),
                    verifier: "verifier".into(),
                },
            ),
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("__Host-sable_oidc=cookie"),
        );
        let session = Session::new(None, Arc::new(SessionMemoryStore::default()), None);
        let response = oidc_callback(
            State(server.clone()),
            session.clone(),
            headers.clone(),
            Query(OidcCallback {
                code: "code".into(),
                state: "wrong".into(),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let replay = oidc_callback(
            State(server),
            session,
            headers,
            Query(OidcCallback {
                code: "code".into(),
                state: "expected".into(),
            }),
        )
        .await;
        assert_eq!(replay.status(), StatusCode::BAD_REQUEST);
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
}
