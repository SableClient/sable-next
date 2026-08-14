#![recursion_limit = "512"]

pub mod protocol;
mod registration;
pub mod rt;
pub mod session;
pub mod store;
pub mod view;

use std::{
    collections::HashMap,
    fmt::Display,
    sync::{
        Arc,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
};

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::RoomMemberships;
use matrix_sdk::authentication::oauth::error::OAuthDiscoveryError;
use matrix_sdk::encryption::verification::{
    SasState, SasVerification, VerificationRequest, VerificationRequestState,
};
use matrix_sdk::encryption::{
    VerificationState,
    recovery::{RecoveryError, RecoveryState},
    secret_storage::SecretStorageError,
};
use matrix_sdk::event_cache::PaginationStatus;
use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
use matrix_sdk::room::edit::EditedContent;
use matrix_sdk::ruma::api::client::account::IdentityServerInfo;
use matrix_sdk::ruma::api::client::account::register::v3::Request as RegistrationRequest;
use matrix_sdk::ruma::api::client::account::request_registration_token_via_email::v3::Request as RegistrationEmailRequest;
use matrix_sdk::ruma::api::client::profile::{AvatarUrl, DisplayName};
use matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType;
use matrix_sdk::ruma::api::client::room::Visibility;
use matrix_sdk::ruma::api::client::room::create_room::{self, v3::RoomPreset};
use matrix_sdk::ruma::api::client::session::get_login_types::v3::LoginType;
use matrix_sdk::ruma::api::client::uiaa::{
    AuthData, AuthFlow, AuthType, EmailIdentity, MatrixUserIdentifier, Password,
    ThirdpartyIdCredentials, UiaaInfo, UserIdentifier,
};
use matrix_sdk::ruma::api::error::{ErrorKind, RetryAfter};
use matrix_sdk::ruma::events::InitialStateEvent;
use matrix_sdk::ruma::events::key::verification::request::ToDeviceKeyVerificationRequestEvent;
use matrix_sdk::ruma::events::presence::PresenceEvent;
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::events::room::avatar::RoomAvatarEventContent;
use matrix_sdk::ruma::events::room::create::RoomCreateEventContent;
use matrix_sdk::ruma::events::room::encryption::RoomEncryptionEventContent;
use matrix_sdk::ruma::events::room::join_rules::{JoinRule, RoomJoinRulesEventContent};
use matrix_sdk::ruma::events::room::message::{MessageType, OriginalSyncRoomMessageEvent};
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::events::tag::{TagInfo, TagName};
use matrix_sdk::ruma::events::typing::SyncTypingEvent;
use matrix_sdk::ruma::presence::PresenceState;
use matrix_sdk::ruma::room::RoomType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{
    ClientSecret, OwnedClientSecret, OwnedEventId, OwnedMxcUri, OwnedRoomId, OwnedSessionId,
    OwnedUserId, RoomId, RoomOrAliasId, ServerName, UInt, UserId,
    events::room::message::{RoomMessageEventContent, TextMessageEventContent},
};
use matrix_sdk::send_queue::SendHandle;
use matrix_sdk_ui::{
    room_list_service::filters::new_filter_non_left,
    sync_service::State as SyncState,
    timeline::{
        AttachmentConfig, AttachmentSource, RoomExt, Timeline, TimelineEventFocusThreadMode,
        TimelineEventItemId, TimelineFocus,
    },
};
use mime::Mime;
use tokio::sync::{Mutex, RwLock, mpsc};
use url::Url;

const MAX_ATTACHMENT_BYTES: usize = 100 * 1024 * 1024;

fn profile_bio(
    response: &matrix_sdk::ruma::api::client::profile::get_profile::v3::Response,
) -> Option<String> {
    response
        .iter()
        .find_map(|(field, value)| match field.as_str() {
            "gay.fomx.biography" => value
                .get("m.text")
                .and_then(serde_json::Value::as_array)
                .and_then(|texts| texts.first())
                .and_then(|text| text.get("body"))
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned),
            "moe.sable.app.bio" | "chat.commet.profile_bio" => {
                value.as_str().map(ToOwned::to_owned)
            }
            _ => None,
        })
}

fn profile_hero_color(
    response: &matrix_sdk::ruma::api::client::profile::get_profile::v3::Response,
) -> Option<String> {
    response
        .iter()
        .find(|(field, _)| field.as_str() == "chat.commet.profile_color_scheme")
        .and_then(|(_, value)| value.get("color"))
        .and_then(serde_json::Value::as_str)
        .filter(|color| {
            let digits = color.strip_prefix('#').unwrap_or_default();
            matches!(digits.len(), 3 | 6) && digits.bytes().all(|digit| digit.is_ascii_hexdigit())
        })
        .map(ToOwned::to_owned)
}

include!("dispatch_commands.rs");

use protocol::{
    AuthIntent, Command, CommandErr, CommandOk, CoreEvent, EmojiView, EncryptionStatusView,
    JoinRuleView, PaginationDirection, PresenceView, ProfileView, RecoveryStateView,
    RegistrationResultView, RoomTag, SessionInfo, SubscriptionId, SyncStatus,
    VerificationStateView, VerificationView,
};
use rt::Task;
use session::{AccountRegistry, Credentials, PersistedAccount, PersistedSession, Session};
use store::SessionStore;

const ROOM_LIST_PAGE_SIZE: usize = 200;

async fn encryption_status(client: &matrix_sdk::Client) -> EncryptionStatusView {
    let encryption = client.encryption();

    EncryptionStatusView {
        verification: match encryption.verification_state().get() {
            VerificationState::Verified => VerificationStateView::Verified,
            VerificationState::Unverified => VerificationStateView::Unverified,
            VerificationState::Unknown => VerificationStateView::Unknown,
        },
        recovery: match encryption.recovery().state() {
            RecoveryState::Enabled => RecoveryStateView::Enabled,
            RecoveryState::Disabled => RecoveryStateView::Disabled,
            RecoveryState::Incomplete => RecoveryStateView::Incomplete,
            RecoveryState::Unknown => RecoveryStateView::Unknown,
        },
        // A partial set cannot sign another device, so it does not count.
        cross_signing_ready: encryption
            .cross_signing_status()
            .await
            .is_some_and(|status| status.is_complete()),
    }
}

fn mxc_uri(url: &str) -> Result<OwnedMxcUri, CommandErr> {
    let uri = OwnedMxcUri::from(url);
    if uri.parts().is_err() {
        return Err(CommandErr::InvalidMedia);
    }
    Ok(uri)
}

fn same_redirect_target(expected: &Url, callback: &Url, response_parameters: &[&str]) -> bool {
    let mut callback_target = callback.clone();
    let query = callback
        .query_pairs()
        .filter(|(key, _)| !response_parameters.contains(&key.as_ref()))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    callback_target.set_query(None);
    if !query.is_empty() {
        callback_target
            .query_pairs_mut()
            .extend_pairs(query.iter().map(|(key, value)| (key, value)));
    }

    expected == &callback_target
}

fn has_single_nonempty_query_parameter(url: &Url, name: &str) -> bool {
    let mut values = url
        .query_pairs()
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value);
    matches!(values.next(), Some(value) if !value.is_empty()) && values.next().is_none()
}

fn message_content(body: String, formatted: Option<String>) -> RoomMessageEventContent {
    match formatted {
        Some(html) => RoomMessageEventContent::text_html(body, html),
        None => RoomMessageEventContent::text_plain(body),
    }
}

fn request_view(
    request: &VerificationRequest,
    state: &VerificationRequestState,
) -> VerificationView {
    match state {
        VerificationRequestState::Created { .. } => VerificationView::Requested {
            is_self: request.is_self_verification(),
            initiated_by_us: true,
        },
        VerificationRequestState::Requested { .. } => VerificationView::Requested {
            is_self: request.is_self_verification(),
            initiated_by_us: false,
        },
        VerificationRequestState::Done => VerificationView::Done,
        VerificationRequestState::Cancelled(info) => VerificationView::Cancelled {
            reason: info.reason().to_owned(),
        },
        _ => VerificationView::Waiting,
    }
}

fn sas_view(sas: &SasVerification, state: &SasState) -> VerificationView {
    match state {
        // From the SAS itself, so a flow joined mid-way still reports emoji.
        SasState::KeysExchanged { decimals, .. } => VerificationView::Compare {
            emojis: sas
                .emoji()
                .map(|emoji| {
                    emoji
                        .iter()
                        .map(|emoji| EmojiView {
                            symbol: emoji.symbol.to_owned(),
                            description: emoji.description.to_owned(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            decimals: *decimals,
        },
        SasState::Confirmed => VerificationView::Confirmed,
        SasState::Done { .. } => VerificationView::Done,
        SasState::Cancelled(info) => VerificationView::Cancelled {
            reason: info.reason().to_owned(),
        },
        _ => VerificationView::Waiting,
    }
}

const fn verification_phase(state: &VerificationView) -> &'static str {
    match state {
        VerificationView::Requested { .. } => "requested",
        VerificationView::Waiting => "waiting",
        VerificationView::Compare { .. } => "compare",
        VerificationView::Confirmed => "confirmed",
        VerificationView::Done => "done",
        VerificationView::Cancelled { .. } => "cancelled",
    }
}

fn sync_status(state: SyncState) -> SyncStatus {
    match state {
        SyncState::Idle | SyncState::Terminated => SyncStatus::Offline,
        SyncState::Running => SyncStatus::Live,
        SyncState::Error(error) => SyncStatus::Error {
            message: error.to_string(),
        },
        SyncState::Offline => SyncStatus::Syncing,
    }
}

const fn timeline_pagination_event(
    subscription: SubscriptionId,
    status: PaginationStatus,
) -> CoreEvent {
    match status {
        PaginationStatus::Paginating => CoreEvent::TimelinePagination {
            subscription,
            loading: true,
            reached_start: false,
        },
        PaginationStatus::Idle { hit_timeline_start } => CoreEvent::TimelinePagination {
            subscription,
            loading: false,
            reached_start: hit_timeline_start,
        },
    }
}

/// Owns every piece of Matrix state. A carrier only moves `Command`s in and
/// `CoreEvent`s out.
pub struct Core {
    store_id: String,
    sessions: Box<dyn SessionStore>,
    events: mpsc::UnboundedSender<CoreEvent>,
    next_subscription: AtomicU32,
    next_log_id: AtomicU64,
    next_registration_attempt: AtomicU64,
    session_generation: AtomicU64,
    session_store_lock: Mutex<()>,
    restore_lock: Mutex<()>,
    accounts: Mutex<Option<AccountRegistry>>,
    session: RwLock<Option<Session>>,
    pending_login: Mutex<Option<PendingLogin>>,
    pending_registration: Mutex<Option<registration::PendingRegistration>>,
    session_tasks: std::sync::Mutex<Vec<Task>>,
    subscriptions: Mutex<HashMap<SubscriptionId, Subscription>>,
    room_subscription_lock: Mutex<()>,
    timelines: Mutex<HashMap<OwnedRoomId, Arc<Timeline>>>,
}

enum PendingLogin {
    Oidc(String, String, String, Url, matrix_sdk::Client),
    Sso(String, String, String, Url, matrix_sdk::Client),
}

struct Subscription {
    tasks: Vec<Task>,
    timeline: Option<Arc<Timeline>>,
    kind: SubscriptionKind,
}

enum SubscriptionKind {
    Other,
    LiveTimeline(OwnedRoomId),
    FocusedTimeline,
}

impl Core {
    #[allow(clippy::arc_with_non_send_sync)] // WASM keeps the core on one event-loop thread
    pub fn new(
        store_id: impl Into<String>,
        sessions: Box<dyn SessionStore>,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<CoreEvent>) {
        let (events, rx) = mpsc::unbounded_channel();
        let core = Arc::new(Self {
            store_id: store_id.into(),
            sessions,
            events,
            next_subscription: AtomicU32::new(1),
            next_log_id: AtomicU64::new(1),
            next_registration_attempt: AtomicU64::new(1),
            session_generation: AtomicU64::new(1),
            session_store_lock: Mutex::new(()),
            restore_lock: Mutex::new(()),
            accounts: Mutex::new(None),
            session: RwLock::new(None),
            pending_login: Mutex::new(None),
            pending_registration: Mutex::new(None),
            session_tasks: std::sync::Mutex::new(Vec::new()),
            subscriptions: Mutex::new(HashMap::new()),
            room_subscription_lock: Mutex::new(()),
            timelines: Mutex::new(HashMap::new()),
        });
        (core, rx)
    }

    /// No carrier means no UI, and syncing continues, so a drop is not an error.
    pub fn emit(&self, event: CoreEvent) {
        let _ = self.events.send(event);
    }

    /// Session tasks must outlive their spawn call. Dropping `Task` aborts it.
    fn track_session_task(&self, task: Task) {
        self.session_tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(task);
    }

    fn emit_if_current(&self, generation: u64, event: CoreEvent) {
        if self.session_generation.load(Ordering::SeqCst) == generation {
            self.emit(event);
        }
    }

    fn allocate_subscription(&self) -> SubscriptionId {
        SubscriptionId(self.next_subscription.fetch_add(1, Ordering::Relaxed))
    }

    async fn accounts(&self) -> Result<AccountRegistry, CommandErr> {
        let mut accounts = self.accounts.lock().await;
        if let Some(accounts) = accounts.as_ref() {
            return Ok(accounts.clone());
        }

        let Some(bytes) = self.sessions.load().await else {
            let registry = AccountRegistry::empty();
            *accounts = Some(registry.clone());
            return Ok(registry);
        };
        let (registry, migrated) = AccountRegistry::from_bytes(&bytes, &self.store_id)
            .map_err(|error| self.failed("restore: parse session file", error))?;
        if migrated {
            let bytes = serde_json::to_vec(&registry)
                .map_err(|error| self.failed("migrate session registry", error))?;
            self.sessions
                .save(bytes)
                .await
                .map_err(|error| self.failed("migrate session registry", error))?;
        }
        *accounts = Some(registry.clone());
        Ok(registry)
    }

    async fn allocate_account(&self) -> Result<(String, String), CommandErr> {
        let mut accounts = self.accounts.lock().await;
        if accounts.is_none() {
            drop(accounts);
            self.accounts().await?;
            accounts = self.accounts.lock().await;
        }
        let Some(accounts) = accounts.as_mut() else {
            return Err(self.failed("allocate account", "account registry is not initialized"));
        };
        Ok(accounts.allocate_account(&self.store_id))
    }

    fn failed(&self, context: &str, error: impl Display) -> CommandErr {
        let log_id = format!("e{}", self.next_log_id.fetch_add(1, Ordering::Relaxed));
        tracing::error!(log_id, context, "{error}");
        CommandErr::Failed { log_id }
    }

    fn login_error(&self, error: matrix_sdk::Error) -> CommandErr {
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

    fn recovery_error(&self, error: RecoveryError) -> CommandErr {
        if matches!(
            error,
            RecoveryError::SecretStorage(SecretStorageError::SecretStorageKey(_))
        ) {
            return CommandErr::Denied;
        }
        self.failed("recover_identity", error)
    }

    fn homeserver_http_error(&self, context: &str, error: matrix_sdk::HttpError) -> CommandErr {
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

    fn discovery_error(&self, error: matrix_sdk::ClientBuildError) -> CommandErr {
        match error {
            matrix_sdk::ClientBuildError::Http(error) => {
                self.homeserver_http_error("login_flows: discovery", error)
            }
            _ => CommandErr::UnknownHomeserver,
        }
    }

    /// Dispatches one protocol command to the Matrix client.
    ///
    /// # Errors
    ///
    /// Returns a protocol error when the command is invalid, the user is not
    /// authenticated, or the Matrix operation fails.
    pub async fn dispatch(self: &Arc<Self>, command: Command) -> Result<CommandOk, CommandErr> {
        dispatch_commands!(self, command)
    }

    /// Without a `via` server the edge is ignored.
    async fn add_to_space(
        &self,
        space_id: &OwnedRoomId,
        room_id: &RoomId,
    ) -> Result<(), CommandErr> {
        let client = self.client().await?;
        let via = vec![
            client
                .user_id()
                .ok_or(CommandErr::NotLoggedIn)?
                .server_name()
                .to_owned(),
        ];

        self.room(space_id)
            .await?
            .send_state_event_for_key(room_id, SpaceChildEventContent::new(via))
            .await
            .map_err(|error| self.failed("add_to_space", error))?;

        Ok(())
    }

    /// The handle lives on the timeline item, so the id has to be looked up.
    async fn local_echo(
        &self,
        room_id: &OwnedRoomId,
        transaction_id: &str,
    ) -> Result<SendHandle, CommandErr> {
        self.timeline(room_id)
            .await?
            .items()
            .await
            .iter()
            .filter_map(|item| item.as_event())
            .find(|event| {
                event
                    .transaction_id()
                    .is_some_and(|id| id == transaction_id)
            })
            .and_then(matrix_sdk_ui::timeline::EventTimelineItem::local_echo_send_handle)
            .ok_or(CommandErr::UnknownLocalEcho)
    }

    // session

    async fn login(
        self: &Arc<Self>,
        homeserver: String,
        username: String,
        password: String,
    ) -> Result<CommandOk, CommandErr> {
        let (account_id, account_store_id) = self.allocate_account().await?;
        tracing::info!(
            operation = "password_login",
            homeserver,
            "building Matrix client"
        );
        let client = session::build_client(&account_store_id, &homeserver)
            .await
            .map_err(|error| self.failed("build_client", error))?;

        tracing::info!(
            operation = "password_login",
            homeserver,
            "requesting an authenticated session"
        );
        client
            .matrix_auth()
            .login_username(&username, &password)
            .initial_device_display_name("Sable")
            .request_refresh_token()
            .await
            .map_err(|error| self.login_error(error))?;

        let matrix = client
            .matrix_auth()
            .session()
            .ok_or_else(|| self.failed("login", "no session after a successful login"))?;

        let user_id = matrix.meta.user_id.clone();
        let generation = self.session_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.persist(
            &account_id,
            &account_store_id,
            &PersistedSession {
                homeserver: homeserver.clone(),
                credentials: Credentials::Password(matrix),
            },
            generation,
        )
        .await?;
        tracing::info!(
            operation = "password_login",
            homeserver,
            "session persisted; starting sync"
        );
        self.start_session(client, homeserver, account_id.clone(), generation)
            .await?;
        self.set_active_account(&account_id).await?;

        tracing::info!(operation = "password_login", "login completed");
        Ok(CommandOk::Login { user_id })
    }

    async fn login_flows(self: &Arc<Self>, homeserver: String) -> Result<CommandOk, CommandErr> {
        tracing::info!(
            operation = "login_flows",
            homeserver,
            "discovering sign-in methods"
        );
        let client = session::discovery_client(&homeserver)
            .await
            .map_err(|error| self.discovery_error(error))?;
        let mut flows = protocol::LoginFlowsView {
            password: false,
            oidc: false,
            oidc_registration: false,
            sso: false,
            oauth_aware_preferred: false,
            sso_identity_providers: Vec::new(),
        };

        match client.matrix_auth().get_login_types().await {
            Ok(types) => {
                for flow in &types.flows {
                    match flow {
                        LoginType::Password(_) => flows.password = true,
                        LoginType::Sso(sso) => {
                            flows.sso = true;
                            flows.oauth_aware_preferred |= sso.oauth_aware_preferred;
                            flows
                                .sso_identity_providers
                                .extend(sso.identity_providers.iter().map(|provider| {
                                    protocol::SsoIdentityProviderView {
                                        id: provider.id.clone(),
                                        name: provider.name.clone(),
                                        icon: provider.icon.as_ref().map(ToString::to_string),
                                        brand: provider.brand.as_ref().and_then(|brand| {
                                            serde_json::to_value(brand)
                                                .ok()?
                                                .as_str()
                                                .map(str::to_owned)
                                        }),
                                    }
                                }));
                        }
                        _ => {}
                    }
                }
            }
            Err(error) if error.is_endpoint_not_implemented() => {
                tracing::debug!("homeserver has no legacy login flows: {error}");
            }
            Err(error) => {
                return Err(self.homeserver_http_error("login_flows: legacy", error));
            }
        }

        match client.oauth().server_metadata().await {
            Ok(metadata) => {
                flows.oidc = true;
                flows.oidc_registration = metadata.prompt_values_supported.iter().any(|prompt| {
                    matches!(
                        prompt,
                        matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::Prompt::Create
                    )
                });
            }
            Err(OAuthDiscoveryError::NotSupported) => {}
            Err(OAuthDiscoveryError::Http(error)) if !flows.password && !flows.sso => {
                return Err(self.homeserver_http_error("login_flows: oauth", error));
            }
            Err(error) if !flows.password && !flows.sso => {
                return Err(self.failed("login_flows: oauth", error));
            }
            Err(error) => tracing::debug!("OAuth login is unavailable: {error}"),
        }

        if !flows.password && !flows.sso && !flows.oidc {
            return Err(CommandErr::Unsupported);
        }

        tracing::info!(
            operation = "login_flows",
            password = flows.password,
            oidc = flows.oidc,
            sso = flows.sso,
            "sign-in methods discovered"
        );
        Ok(CommandOk::LoginFlows { flows })
    }

    /// Parked in `pending_oidc` so step 2 finishes on the same `Client`: the
    /// PKCE verifier and CSRF state live inside it and cannot be rebuilt.
    async fn start_oidc_login(
        self: &Arc<Self>,
        homeserver: String,
        redirect_uri: String,
        intent: AuthIntent,
    ) -> Result<CommandOk, CommandErr> {
        let (account_id, account_store_id) = self.allocate_account().await?;
        tracing::info!(operation = "oidc_login", intent = ?intent, "starting OAuth login");
        let redirect_uri = Url::parse(&redirect_uri)
            .map_err(|error| self.failed("start_oidc_login: redirect_uri", error))?;

        let client = session::build_client(&account_store_id, &homeserver)
            .await
            .map_err(|error| self.failed("start_oidc_login: build_client", error))?;

        let registration = session::client_metadata(&redirect_uri).into();

        let mut login = client
            .oauth()
            .login(redirect_uri.clone(), None, Some(registration), None);
        if matches!(intent, AuthIntent::Register) {
            login = login.prompt(vec![
                matrix_sdk::ruma::api::client::discovery::get_authorization_server_metadata::v1::Prompt::Create,
            ]);
        }
        let data = login
            .build()
            .await
            .map_err(|error| self.failed("start_oidc_login", error))?;

        let authorization_url = data.url.to_string();
        let mut pending = self.pending_login.lock().await;
        if matches!(pending.as_ref(), Some(PendingLogin::Sso(_, _, _, _, _))) {
            return Err(CommandErr::Unavailable);
        }

        if pending.is_some() {
            tracing::warn!("replacing unfinished OIDC login with a new attempt");
        }
        *pending = Some(PendingLogin::Oidc(
            account_id,
            account_store_id,
            homeserver,
            redirect_uri,
            client,
        ));

        tracing::info!(
            operation = "oidc_login",
            "OAuth login ready for browser redirect"
        );
        Ok(CommandOk::StartOidcLogin { authorization_url })
    }

    async fn complete_oidc_login(
        self: &Arc<Self>,
        callback_url: String,
    ) -> Result<CommandOk, CommandErr> {
        tracing::info!(operation = "oidc_login", "completing OAuth login callback");
        let url = Url::parse(&callback_url)
            .map_err(|error| self.failed("complete_oidc_login: callback_url", error))?;

        let mut pending = self.pending_login.lock().await;
        let Some(PendingLogin::Oidc(_, _, _, expected_redirect_uri, client)) = pending.as_ref()
        else {
            tracing::warn!("no pending OIDC login: it was started elsewhere or the core restarted");
            return Err(CommandErr::Unavailable);
        };

        if !same_redirect_target(
            expected_redirect_uri,
            &url,
            &["code", "state", "error", "error_description", "error_uri"],
        ) {
            return Err(self.failed(
                "complete_oidc_login: callback_url",
                "callback URL does not match the redirect URI used to start OAuth",
            ));
        }

        client
            .oauth()
            .finish_login(url.into())
            .await
            .map_err(|error| self.failed("complete_oidc_login", error))?;

        let Some(PendingLogin::Oidc(account_id, account_store_id, homeserver, _, client)) =
            pending.take()
        else {
            return Err(CommandErr::Unavailable);
        };
        drop(pending);

        let full = client
            .oauth()
            .full_session()
            .ok_or_else(|| self.failed("complete_oidc_login", "no session after finish_login"))?;

        let user_id = full.user.meta.user_id.clone();
        let generation = self.session_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.persist(
            &account_id,
            &account_store_id,
            &PersistedSession {
                homeserver: homeserver.clone(),
                credentials: Credentials::oauth(full),
            },
            generation,
        )
        .await?;
        self.start_session(client, homeserver, account_id.clone(), generation)
            .await?;
        self.set_active_account(&account_id).await?;

        tracing::info!(operation = "oidc_login", "OAuth login completed");
        Ok(CommandOk::CompleteOidcLogin { user_id })
    }

    async fn start_sso_login(
        self: &Arc<Self>,
        homeserver: String,
        redirect_uri: String,
        idp_id: Option<String>,
        intent: AuthIntent,
    ) -> Result<CommandOk, CommandErr> {
        let (account_id, account_store_id) = self.allocate_account().await?;
        tracing::info!(operation = "sso_login", intent = ?intent, "starting SSO login");
        let redirect_uri = Url::parse(&redirect_uri)
            .map_err(|error| self.failed("start_sso_login: redirect_uri", error))?;
        if !has_single_nonempty_query_parameter(&redirect_uri, "sable_sso_state") {
            return Err(CommandErr::Denied);
        }

        let client = session::build_client(&account_store_id, &homeserver)
            .await
            .map_err(|error| self.failed("start_sso_login: build_client", error))?;

        let authorization_url = client
            .matrix_auth()
            .get_sso_login_url(redirect_uri.as_str(), idp_id.as_deref())
            .await
            .map_err(|error| self.failed("start_sso_login", error))?;

        let mut authorization_url = Url::parse(&authorization_url)
            .map_err(|error| self.failed("start_sso_login: authorization_url", error))?;
        authorization_url.query_pairs_mut().append_pair(
            "action",
            if matches!(intent, AuthIntent::Register) {
                "register"
            } else {
                "login"
            },
        );

        let mut pending = self.pending_login.lock().await;
        if pending.is_some() {
            return Err(CommandErr::Unavailable);
        }
        *pending = Some(PendingLogin::Sso(
            account_id,
            account_store_id,
            homeserver,
            redirect_uri,
            client,
        ));

        tracing::info!(
            operation = "sso_login",
            "SSO login ready for browser redirect"
        );
        Ok(CommandOk::StartSsoLogin {
            authorization_url: authorization_url.to_string(),
        })
    }

    async fn complete_sso_login(
        self: &Arc<Self>,
        callback_url: String,
    ) -> Result<CommandOk, CommandErr> {
        tracing::info!(operation = "sso_login", "completing SSO login callback");
        // The login token is single-use, so keep the client that created the
        // redirect and consume the pending flow exactly once.
        let callback_url = Url::parse(&callback_url)
            .map_err(|error| self.failed("complete_sso_login: callback_url", error))?;
        if !has_single_nonempty_query_parameter(&callback_url, "loginToken") {
            return Err(CommandErr::Denied);
        }

        let mut pending = self.pending_login.lock().await;
        let Some(PendingLogin::Sso(_, _, _, expected_redirect_uri, _)) = pending.as_ref() else {
            tracing::warn!("no pending SSO login: it was started elsewhere or the core restarted");
            return Err(CommandErr::Unavailable);
        };

        if !same_redirect_target(expected_redirect_uri, &callback_url, &["loginToken"]) {
            return Err(self.failed(
                "complete_sso_login: callback_url",
                "callback URL does not match the redirect URI used to start SSO",
            ));
        }

        let Some(PendingLogin::Sso(account_id, account_store_id, homeserver, _, client)) =
            pending.take()
        else {
            return Err(CommandErr::Unavailable);
        };
        drop(pending);

        client
            .matrix_auth()
            .login_with_sso_callback(callback_url.into())
            .map_err(|error| self.failed("complete_sso_login: callback_url", error))?
            .initial_device_display_name("Sable")
            .request_refresh_token()
            .await
            .map_err(|error| self.failed("complete_sso_login", error))?;

        let matrix = client.matrix_auth().session().ok_or_else(|| {
            self.failed("complete_sso_login", "no session after a successful login")
        })?;
        let user_id = matrix.meta.user_id.clone();

        let generation = self.session_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.persist(
            &account_id,
            &account_store_id,
            &PersistedSession {
                homeserver: homeserver.clone(),
                credentials: Credentials::Password(matrix),
            },
            generation,
        )
        .await?;
        self.start_session(client, homeserver, account_id.clone(), generation)
            .await?;
        self.set_active_account(&account_id).await?;

        tracing::info!(operation = "sso_login", "SSO login completed");
        Ok(CommandOk::CompleteSsoLogin { user_id })
    }

    async fn restore(self: &Arc<Self>) -> Result<CommandOk, CommandErr> {
        let _restore = self.restore_lock.lock().await;
        if let Some(session) = self.active_session_info().await {
            return Ok(CommandOk::Restore {
                session: Some(session),
            });
        }

        let accounts = self.accounts().await?;
        let Some(account_id) = accounts.active_account_id else {
            return Ok(CommandOk::Restore { session: None });
        };
        let Some(account) = accounts
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id)
        else {
            return Err(self.failed("restore", "active account is missing"));
        };
        let persisted = account.session;

        let client = session::build_client(&account.store_id, &persisted.homeserver)
            .await
            .map_err(|error| self.failed("restore: build_client", error))?;

        let info = SessionInfo {
            account_id: account.account_id.clone(),
            user_id: persisted
                .credentials
                .user_id()
                .parse()
                .map_err(|error| self.failed("restore: user id", error))?,
            device_id: persisted.credentials.device_id(),
        };

        match persisted.credentials {
            Credentials::Password(matrix) => client
                .restore_session(matrix)
                .await
                .map_err(|error| self.failed("restore_session", error))?,
            Credentials::OAuth { client_id, user } => client
                .oauth()
                .restore_session(
                    session::oauth_session(client_id, user),
                    matrix_sdk::store::RoomLoadSettings::default(),
                )
                .await
                .map_err(|error| self.failed("restore_session: oauth", error))?,
        }

        let generation = self.session_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.start_session(client, persisted.homeserver, account.account_id, generation)
            .await?;

        Ok(CommandOk::Restore {
            session: Some(info),
        })
    }

    async fn active_session_info(&self) -> Option<SessionInfo> {
        let session = self.session.read().await;
        let session = session.as_ref()?;
        Some(SessionInfo {
            account_id: session.account_id.clone(),
            user_id: session.client.user_id()?.to_owned(),
            device_id: session.client.device_id()?.to_string(),
        })
    }

    async fn list_accounts(&self) -> Result<CommandOk, CommandErr> {
        let accounts = self.accounts().await?;
        let accounts = accounts
            .accounts
            .into_iter()
            .map(|account| {
                Ok(SessionInfo {
                    account_id: account.account_id,
                    user_id: account
                        .session
                        .credentials
                        .user_id()
                        .parse()
                        .map_err(|error| self.failed("list accounts: user id", error))?,
                    device_id: account.session.credentials.device_id(),
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(CommandOk::ListAccounts { accounts })
    }

    async fn switch_account(self: &Arc<Self>, account_id: String) -> Result<CommandOk, CommandErr> {
        let accounts = self.accounts().await?;
        let account = accounts
            .accounts
            .into_iter()
            .find(|account| account.account_id == account_id)
            .ok_or(CommandErr::NotLoggedIn)?;
        let persisted = account.session;
        let client = session::build_client(&account.store_id, &persisted.homeserver)
            .await
            .map_err(|error| self.failed("switch account: build_client", error))?;
        let info = SessionInfo {
            account_id: account.account_id.clone(),
            user_id: persisted
                .credentials
                .user_id()
                .parse()
                .map_err(|error| self.failed("switch account: user id", error))?,
            device_id: persisted.credentials.device_id(),
        };
        match persisted.credentials {
            Credentials::Password(matrix) => client
                .restore_session(matrix)
                .await
                .map_err(|error| self.failed("switch account: restore_session", error))?,
            Credentials::OAuth { client_id, user } => client
                .oauth()
                .restore_session(
                    session::oauth_session(client_id, user),
                    matrix_sdk::store::RoomLoadSettings::default(),
                )
                .await
                .map_err(|error| self.failed("switch account: restore_session: oauth", error))?,
        }

        let generation = self.session_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.pending_registration.lock().await.take();
        self.pending_login.lock().await.take();
        self.start_session(client, persisted.homeserver, account.account_id, generation)
            .await?;
        self.set_active_account(&info.account_id).await?;
        Ok(CommandOk::SwitchAccount { session: info })
    }

    async fn logout(self: &Arc<Self>) -> Result<CommandOk, CommandErr> {
        self.session_generation.fetch_add(1, Ordering::SeqCst);
        self.pending_registration.lock().await.take();
        self.pending_login.lock().await.take();
        let session = self.take_session().await;
        let account_id = session.as_ref().map(|session| session.account_id.clone());
        if let Some(session) = session {
            let result = if session.oauth {
                session
                    .client
                    .oauth()
                    .logout()
                    .await
                    .map_err(|e| e.to_string())
            } else {
                session
                    .client
                    .matrix_auth()
                    .logout()
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            };

            if let Err(error) = result {
                tracing::warn!("server-side logout failed, clearing locally anyway: {error}");
            }

            session.sync_service.stop().await;
        }

        self.remove_account(account_id.as_deref()).await?;

        Ok(CommandOk::Logout)
    }

    async fn persist(
        &self,
        account_id: &str,
        store_id: &str,
        persisted: &PersistedSession,
        generation: u64,
    ) -> Result<(), CommandErr> {
        let _guard = self.session_store_lock.lock().await;
        if self.session_generation.load(Ordering::SeqCst) != generation {
            return Ok(());
        }
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_mut() else {
            return Err(self.failed("persist", "account registry is not initialized"));
        };
        registry.upsert(PersistedAccount {
            account_id: account_id.to_owned(),
            store_id: store_id.to_owned(),
            session: persisted.clone(),
        });
        let bytes = serde_json::to_vec(registry)
            .map_err(|error| self.failed("persist: serialize", error))?;
        self.sessions
            .save(bytes)
            .await
            .map_err(|error| self.failed("persist: save", error))
    }

    async fn set_active_account(&self, account_id: &str) -> Result<(), CommandErr> {
        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_mut() else {
            return Err(self.failed("switch account", "account registry is not initialized"));
        };
        if !registry
            .accounts
            .iter()
            .any(|account| account.account_id == account_id)
        {
            return Err(CommandErr::NotLoggedIn);
        }
        registry.active_account_id = Some(account_id.to_owned());
        let bytes = serde_json::to_vec(registry)
            .map_err(|error| self.failed("switch account: serialize", error))?;
        self.sessions
            .save(bytes)
            .await
            .map_err(|error| self.failed("switch account: save", error))
    }

    async fn clear_persisted_session(&self) -> Result<(), CommandErr> {
        let _guard = self.session_store_lock.lock().await;
        self.sessions
            .clear()
            .await
            .map_err(|error| self.failed("clear session", error))
    }

    async fn remove_account(&self, account_id: Option<&str>) -> Result<(), CommandErr> {
        let Some(account_id) = account_id else {
            return self.clear_persisted_session().await;
        };

        let _guard = self.session_store_lock.lock().await;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_mut() else {
            return Err(self.failed("remove account", "account registry is not initialized"));
        };
        registry
            .accounts
            .retain(|account| account.account_id != account_id);
        registry.active_account_id = None;
        let bytes = serde_json::to_vec(registry)
            .map_err(|error| self.failed("logout: serialize accounts", error))?;
        self.sessions
            .save(bytes)
            .await
            .map_err(|error| self.failed("logout: save accounts", error))?;
        Ok(())
    }

    async fn take_session(&self) -> Option<Session> {
        self.session_tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.subscriptions.lock().await.clear();
        self.timelines.lock().await.clear();
        self.session.write().await.take()
    }

    async fn start_session(
        self: &Arc<Self>,
        client: matrix_sdk::Client,
        homeserver: String,
        account_id: String,
        generation: u64,
    ) -> Result<(), CommandErr> {
        let oauth = client.oauth().full_session().is_some();
        client
            .event_cache()
            .subscribe()
            .map_err(|error| self.failed("subscribe_event_cache", error))?;

        // Event handlers do not spawn until sync starts, and are owned by the
        // client. Register them now so the first sync response cannot race us.
        self.watch_ephemeral(&client, generation);
        self.watch_incoming_verifications(&client);

        let sync_service = session::start_sync(client.clone())
            .await
            .map_err(|error| self.failed("start_sync", error))?;

        // Do not disrupt the active session unless its replacement started
        // successfully. `take_session` also aborts its owned watcher tasks.
        if let Some(previous) = self.take_session().await {
            previous.sync_service.stop().await;
        }

        let verification_client = client.clone();
        let verification_user_id = client.user_id().map(ToOwned::to_owned);
        let mut session = self.session.write().await;
        if self.session_generation.load(Ordering::SeqCst) != generation {
            drop(session);
            sync_service.stop().await;
            return Ok(());
        }
        *session = Some(Session {
            account_id: account_id.clone(),
            client: client.clone(),
            sync_service: sync_service.clone(),
            homeserver: homeserver.clone(),
            oauth,
        });

        self.watch_session(&client, &homeserver, &account_id, generation);
        self.watch_encryption(&client, generation);

        let core = self.clone();
        let mut states = sync_service.state();
        // `Subscriber::next` yields only on *change*, so emit the first by hand.
        core.emit_if_current(generation, CoreEvent::SyncStatus(sync_status(states.get())));
        self.track_session_task(rt::spawn(async move {
            while let Some(state) = states.next().await {
                core.emit_if_current(generation, CoreEvent::SyncStatus(sync_status(state)));
            }
        }));

        if let Some(user_id) = verification_user_id {
            rt::spawn_detached(async move {
                if let Err(error) = verification_client
                    .encryption()
                    .request_user_identity(&user_id)
                    .await
                {
                    tracing::warn!(
                        operation = "verification",
                        "could not refresh own device list: {error}"
                    );
                }
            });
        }

        Ok(())
    }

    /// Two streams, one status, so either firing re-reads both.
    fn watch_encryption(self: &Arc<Self>, client: &matrix_sdk::Client, generation: u64) {
        let mut verification = client.encryption().verification_state();
        let recovery = client.encryption().recovery().state_stream();

        let core = self.clone();
        let watched = client.clone();
        self.track_session_task(rt::spawn(async move {
            while verification.next().await.is_some() {
                core.emit_if_current(
                    generation,
                    CoreEvent::EncryptionStatus {
                        status: encryption_status(&watched).await,
                    },
                );
            }
        }));

        let core = self.clone();
        let watched = client.clone();
        self.track_session_task(rt::spawn(async move {
            pin_mut!(recovery);
            while recovery.next().await.is_some() {
                core.emit_if_current(
                    generation,
                    CoreEvent::EncryptionStatus {
                        status: encryption_status(&watched).await,
                    },
                );
            }
        }));
    }

    /// Self-verification travels to-device, verifying someone else as a DM
    /// message, so both need a handler or one direction never prompts.
    fn watch_incoming_verifications(self: &Arc<Self>, client: &matrix_sdk::Client) {
        client.add_event_handler({
            let core = self.clone();
            move |event: ToDeviceKeyVerificationRequestEvent, client: matrix_sdk::Client| {
                let core = core.clone();

                async move {
                    let request = client
                        .encryption()
                        .get_verification_request(
                            &event.sender,
                            event.content.transaction_id.as_str(),
                        )
                        .await;

                    tracing::info!(
                        operation = "verification",
                        request_available = request.is_some(),
                        "received to-device verification request"
                    );

                    if let Some(request) = request {
                        core.watch_verification(request);
                    }
                }
            }
        });

        client.add_event_handler({
            let core = self.clone();
            move |event: OriginalSyncRoomMessageEvent, client: matrix_sdk::Client| {
                let core = core.clone();

                async move {
                    if !matches!(event.content.msgtype, MessageType::VerificationRequest(_)) {
                        return;
                    }

                    if let Some(request) = client
                        .encryption()
                        .get_verification_request(&event.sender, event.event_id.as_str())
                        .await
                    {
                        core.watch_verification(request);
                    }
                }
            }
        });
    }

    /// The request and the SAS it becomes are two objects with two state enums.
    /// Both funnel into one event stream keyed by the flow id.
    fn watch_verification(self: &Arc<Self>, request: VerificationRequest) {
        let core = self.clone();
        let task = rt::spawn(async move {
            let user_id = request.other_user_id().to_owned();
            let flow_id = request.flow_id().to_owned();

            let mut changes = request.changes();
            core.emit_verification(&user_id, &flow_id, request_view(&request, &request.state()));

            while let Some(state) = changes.next().await {
                match state {
                    VerificationRequestState::Ready { .. } => {
                        if request.we_started()
                            && let Err(error) = request.start_sas().await
                        {
                            core.failed("verification: start_sas", error);
                        }

                        core.emit_verification(&user_id, &flow_id, VerificationView::Waiting);
                    }

                    VerificationRequestState::Transitioned { verification, .. } => {
                        // QR is not compiled in, so any other flow is
                        // undriveable. Say so instead of spinning.
                        match verification.sas() {
                            Some(sas) => core.watch_sas(user_id.clone(), flow_id.clone(), sas),
                            None => core.emit_verification(
                                &user_id,
                                &flow_id,
                                VerificationView::Cancelled {
                                    reason: "unsupported verification method".to_owned(),
                                },
                            ),
                        }

                        break;
                    }

                    other => {
                        let view = request_view(&request, &other);
                        let done = matches!(
                            view,
                            VerificationView::Done | VerificationView::Cancelled { .. }
                        );
                        core.emit_verification(&user_id, &flow_id, view);

                        if done {
                            break;
                        }
                    }
                }
            }
        });
        self.track_session_task(task);
    }

    fn watch_sas(self: &Arc<Self>, user_id: OwnedUserId, flow_id: String, sas: SasVerification) {
        let core = self.clone();
        let task = rt::spawn(async move {
            let mut changes = sas.changes();
            core.emit_verification(&user_id, &flow_id, sas_view(&sas, &sas.state()));

            if !sas.we_started()
                && let Err(error) = sas.accept().await
            {
                core.failed("verification: accept_sas", error);
            }

            while let Some(state) = changes.next().await {
                let view = sas_view(&sas, &state);
                let done = matches!(
                    view,
                    VerificationView::Done | VerificationView::Cancelled { .. }
                );
                core.emit_verification(&user_id, &flow_id, view);

                if done {
                    break;
                }
            }
        });
        self.track_session_task(task);
    }

    fn emit_verification(&self, user_id: &UserId, flow_id: &str, state: VerificationView) {
        tracing::info!(
            operation = "verification",
            phase = verification_phase(&state),
            "verification state changed"
        );
        self.emit(CoreEvent::Verification {
            user_id: user_id.to_owned(),
            flow_id: flow_id.to_owned(),
            state,
        });
    }

    async fn verification_request(
        &self,
        user_id: &UserId,
        flow_id: &str,
    ) -> Result<VerificationRequest, CommandErr> {
        self.client()
            .await?
            .encryption()
            .get_verification_request(user_id, flow_id)
            .await
            .ok_or(CommandErr::UnknownVerification)
    }

    async fn sas(&self, user_id: &UserId, flow_id: &str) -> Result<SasVerification, CommandErr> {
        self.client()
            .await?
            .encryption()
            .get_verification(user_id, flow_id)
            .await
            .and_then(matrix_sdk::encryption::verification::Verification::sas)
            .ok_or(CommandErr::UnknownVerification)
    }

    /// Ordinary sync events, so one handler each covers every room. Per-room
    /// registration would mean tracking what the UI looks at, and a room list
    /// row needs typing for rooms that are shut.
    fn watch_ephemeral(self: &Arc<Self>, client: &matrix_sdk::Client, generation: u64) {
        let own_user_id = client.user_id().map(ToOwned::to_owned);

        client.add_event_handler({
            let core = self.clone();
            move |event: SyncTypingEvent, room: matrix_sdk::Room| {
                let core = core.clone();
                let own_user_id = own_user_id.clone();

                async move {
                    // `Room::subscribe_to_typing_notifications` filters our own
                    // user out. A raw handler does not, and the echo reads as
                    // "you are typing" in your own room list.
                    let user_ids = event
                        .content
                        .user_ids
                        .into_iter()
                        .filter(|id| Some(id) != own_user_id.as_ref())
                        .collect();

                    core.emit_if_current(
                        generation,
                        CoreEvent::Typing {
                            room_id: room.room_id().to_owned(),
                            user_ids,
                        },
                    );
                }
            }
        });

        client.add_event_handler({
            let core = self.clone();
            move |event: PresenceEvent| {
                let core = core.clone();

                async move {
                    core.emit_if_current(
                        generation,
                        CoreEvent::Presence {
                            user_id: event.sender,
                            presence: match event.content.presence {
                                PresenceState::Online => PresenceView::Online,
                                PresenceState::Offline => PresenceView::Offline,
                                // `PresenceState` is non-exhaustive. Anything added
                                // later reads as away, not online.
                                _ => PresenceView::Unavailable,
                            },
                            status_message: event.content.status_msg,
                            last_active_ago: event.content.last_active_ago.map(Into::into),
                        },
                    );
                }
            }
        });
    }

    /// The SDK rotates the OAuth refresh token when it refreshes. Without
    /// re-persisting, the next cold start authenticates with a spent one.
    fn watch_session(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        homeserver: &str,
        account_id: &str,
        generation: u64,
    ) {
        let saver = self.clone();
        let saved_homeserver = homeserver.to_owned();
        let saved_account_id = account_id.to_owned();

        let save = move |client: matrix_sdk::Client| {
            let account_id = saved_account_id.clone();
            let Some(persisted) = session::current_session(&client, saved_homeserver.clone())
            else {
                return Ok(());
            };

            // The callback is synchronous and the store is not. A failure only
            // costs the next restore, so it is logged.
            let core = saver.clone();
            rt::spawn_detached(async move {
                let store_id: Option<String> = {
                    let accounts = core.accounts.lock().await;
                    accounts
                        .as_ref()
                        .and_then(|accounts| {
                            accounts
                                .accounts
                                .iter()
                                .find(|account| account.account_id == account_id)
                        })
                        .map(|account| account.store_id.clone())
                };
                let Some(store_id) = store_id else {
                    return;
                };
                if let Err(error) = core
                    .persist(&account_id, &store_id, &persisted, generation)
                    .await
                {
                    tracing::error!("could not persist refreshed session: {error:?}");
                }
            });

            Ok(())
        };

        let reload = move |client: matrix_sdk::Client| {
            client
                .session_tokens()
                .ok_or_else(|| "no session tokens to reload".into())
        };

        if let Err(error) = client.set_session_callbacks(Box::new(reload), Box::new(save)) {
            tracing::error!("could not install session callbacks: {error}");
        }

        let core = self.clone();
        let mut changes = client.subscribe_to_session_changes();
        self.track_session_task(rt::spawn(async move {
            while let Ok(change) = changes.recv().await {
                if core.handle_session_change(change, generation).await {
                    return;
                }
            }
        }));
    }

    async fn handle_session_change(
        self: &Arc<Self>,
        change: matrix_sdk::SessionChange,
        generation: u64,
    ) -> bool {
        if !matches!(change, matrix_sdk::SessionChange::UnknownToken(_)) {
            return false;
        }

        if self
            .session_generation
            .compare_exchange(
                generation,
                generation + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_err()
        {
            return true;
        }

        let session = self.take_session().await;
        let account_id = session.as_ref().map(|session| session.account_id.clone());
        if let Some(session) = session {
            session.sync_service.stop().await;
        }
        if let Err(error) = self.remove_account(account_id.as_deref()).await {
            tracing::error!("could not clear rejected session: {error:?}");
        }
        self.emit(CoreEvent::SessionEnded {
            reason: "token_rejected".to_owned(),
        });
        true
    }

    // subscriptions

    async fn subscribe_room_list(self: &Arc<Self>) -> Result<CommandOk, CommandErr> {
        let sync_service = {
            let guard = self.session.read().await;
            guard
                .as_ref()
                .ok_or(CommandErr::NotLoggedIn)?
                .sync_service
                .clone()
        };

        let subscription = self.allocate_subscription();
        let core = self.clone();

        let client = {
            let guard = self.session.read().await;
            guard
                .as_ref()
                .ok_or(CommandErr::NotLoggedIn)?
                .client
                .clone()
        };

        let task = rt::spawn(async move {
            let room_list = match sync_service.room_list_service().all_rooms().await {
                Ok(room_list) => room_list,
                Err(error) => {
                    tracing::error!("all_rooms failed: {error}");
                    return;
                }
            };

            let (stream, controller) = room_list.entries_with_dynamic_adapters(ROOM_LIST_PAGE_SIZE);
            controller.set_filter(Box::new(new_filter_non_left()));

            // Stable over a stream's life, so resolved once per room.
            let mut room_cache: HashMap<OwnedRoomId, view::RoomInfo> = HashMap::new();

            let mut stream = Box::pin(stream);
            while let Some(diffs) = stream.next().await {
                view::prime_display_names(&diffs).await;
                for diff in &diffs {
                    view::enrich_room_fields(&client, diff, &mut room_cache).await;
                }
                core.emit(CoreEvent::RoomListDiff {
                    subscription,
                    diffs: diffs
                        .into_iter()
                        .map(|diff| {
                            view::map_diff(diff, |item| view::room_summary(item, &room_cache))
                        })
                        .collect(),
                });
            }
        });

        self.subscriptions.lock().await.insert(
            subscription,
            Subscription {
                tasks: vec![task],
                timeline: None,
                kind: SubscriptionKind::Other,
            },
        );

        // The filter makes the stream open with a `Reset` carrying everything.
        Ok(CommandOk::SubscribeRoomList {
            subscription,
            rooms: Vec::new(),
        })
    }

    #[allow(clippy::arc_with_non_send_sync)] // Matrix timelines are single-threaded on WASM
    async fn subscribe_timeline(
        self: &Arc<Self>,
        room_id: OwnedRoomId,
        event_id: Option<OwnedEventId>,
    ) -> Result<CommandOk, CommandErr> {
        let subscription = self.allocate_subscription();
        let live_room_id = event_id.is_none().then(|| room_id.clone());
        let timeline = match event_id {
            Some(event_id) => Arc::new(
                build_room_timeline(&self.room(&room_id).await?, Some(event_id))
                    .await
                    .map_err(|error| self.failed("build focused timeline", error))?,
            ),
            None => self.timeline(&room_id).await?,
        };

        // The SDK replaces its explicit-room set wholesale. Register before
        // computing the union so concurrent live subscriptions see each other.
        let _update = self.room_subscription_lock.lock().await;
        self.subscriptions.lock().await.insert(
            subscription,
            Subscription {
                tasks: Vec::new(),
                timeline: Some(timeline.clone()),
                kind: live_room_id.clone().map_or(
                    SubscriptionKind::FocusedTimeline,
                    SubscriptionKind::LiveTimeline,
                ),
            },
        );
        if let Err(error) = self.sync_timeline_rooms_locked(live_room_id.as_ref()).await {
            self.subscriptions.lock().await.remove(&subscription);
            return Err(error);
        }
        let (items, stream) = timeline.subscribe().await;
        let pagination = timeline.live_back_pagination_status().await;
        let core = self.clone();
        let task = rt::spawn(async move {
            pin_mut!(stream);
            while let Some(diffs) = stream.next().await {
                core.emit(CoreEvent::TimelineDiff {
                    subscription,
                    diffs: diffs
                        .into_iter()
                        .map(|diff| view::map_diff(diff, view::timeline_item))
                        .collect(),
                });
            }
        });
        let (initial_status, status_task) = pagination.map_or((None, None), |(status, stream)| {
            let core = self.clone();
            (
                Some(status),
                Some(rt::spawn(async move {
                    let mut status = Box::pin(stream);
                    while let Some(status) = status.next().await {
                        core.emit(timeline_pagination_event(subscription, status));
                    }
                })),
            )
        });
        let mut subscriptions = self.subscriptions.lock().await;
        let Some(entry) = subscriptions.get_mut(&subscription) else {
            return Err(CommandErr::Unavailable);
        };
        entry.tasks = status_task.into_iter().chain([task]).collect();
        if let Some(status) = initial_status {
            self.emit(timeline_pagination_event(subscription, status));
        }

        Ok(CommandOk::SubscribeTimeline {
            subscription,
            items: items.iter().map(view::timeline_item).collect(),
        })
    }

    async fn client(&self) -> Result<matrix_sdk::Client, CommandErr> {
        let guard = self.session.read().await;
        Ok(guard
            .as_ref()
            .ok_or(CommandErr::NotLoggedIn)?
            .client
            .clone())
    }

    async fn sync_service(
        &self,
    ) -> Result<Arc<matrix_sdk_ui::sync_service::SyncService>, CommandErr> {
        let guard = self.session.read().await;
        Ok(guard
            .as_ref()
            .ok_or(CommandErr::NotLoggedIn)?
            .sync_service
            .clone())
    }

    async fn room(&self, room_id: &OwnedRoomId) -> Result<matrix_sdk::Room, CommandErr> {
        self.client()
            .await?
            .get_room(room_id)
            .ok_or(CommandErr::UnknownRoom)
    }

    async fn sync_timeline_rooms_locked(
        &self,
        pending_room: Option<&OwnedRoomId>,
    ) -> Result<(), CommandErr> {
        let subscriptions = self.subscriptions.lock().await;
        let room_ids = subscriptions
            .values()
            .filter_map(|subscription| match &subscription.kind {
                SubscriptionKind::LiveTimeline(room_id) => Some(room_id.clone()),
                SubscriptionKind::Other | SubscriptionKind::FocusedTimeline => None,
            })
            .chain(pending_room.cloned())
            .collect::<std::collections::HashSet<_>>();
        drop(subscriptions);
        let room_refs = room_ids.iter().map(OwnedRoomId::as_ref).collect::<Vec<_>>();
        self.sync_service()
            .await?
            .room_list_service()
            .subscribe_to_rooms(&room_refs)
            .await;
        Ok(())
    }

    /// Authenticated media needs the access token, so the fetch happens here.
    ///
    /// # Errors
    ///
    /// Returns an error when the media URI is invalid, the user is logged out,
    /// or the homeserver rejects the request.
    pub async fn media_thumbnail(
        &self,
        source: String,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, CommandErr> {
        let source: MediaSource = serde_json::from_str(&source)
            .unwrap_or_else(|_| MediaSource::Plain(OwnedMxcUri::from(source)));
        if let MediaSource::Plain(uri) = &source
            && uri.parts().is_err()
        {
            return Err(CommandErr::InvalidMedia);
        }

        let format = if width == 0 || height == 0 {
            MediaFormat::File
        } else {
            MediaFormat::Thumbnail(MediaThumbnailSettings::new(width.into(), height.into()))
        };
        let client = self.client().await?;
        let request = MediaRequestParameters {
            source: source.clone(),
            format,
        };

        match client.media().get_media_content(&request, true).await {
            Ok(bytes) => Ok(bytes),
            // Some servers cannot thumbnail SVGs or older media. The original is
            // still useful, and is the only safe fallback for an unknown thumbnail.
            Err(_) if width != 0 && height != 0 => client
                .media()
                .get_media_content(
                    &MediaRequestParameters {
                        source,
                        format: MediaFormat::File,
                    },
                    true,
                )
                .await
                .map_err(|error| self.failed("media_thumbnail", error)),
            Err(error) => Err(self.failed("media_thumbnail", error)),
        }
    }

    /// For the avatar commands. Not for attachments: `send_attachment` keeps the
    /// upload and the event in one queue entry so they retry together.
    ///
    /// # Errors
    ///
    /// Returns an error when the MIME type is invalid, the user is logged out,
    /// or the upload fails.
    pub async fn upload_media(&self, mime: String, bytes: Vec<u8>) -> Result<String, CommandErr> {
        let mime: Mime = mime.parse().map_err(|_| CommandErr::InvalidMedia)?;

        let response = self
            .client()
            .await?
            .media()
            .upload(&mime, bytes, None)
            .await
            .map_err(|error| self.failed("upload_media", error))?;

        Ok(response.content_uri.to_string())
    }

    /// Returns once queued, not once uploaded. Progress and failure arrive as
    /// `send_state` on the local echo.
    ///
    /// # Errors
    ///
    /// Returns an error when an attachment field is invalid, the room is
    /// unavailable, or queuing the upload fails.
    pub async fn send_attachment(
        &self,
        room_id: String,
        filename: String,
        mime: String,
        bytes: Vec<u8>,
        caption: Option<String>,
        in_reply_to: Option<String>,
    ) -> Result<(), CommandErr> {
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(CommandErr::InvalidMedia);
        }
        let room_id = OwnedRoomId::try_from(room_id).map_err(|_| CommandErr::UnknownRoom)?;
        let mime: Mime = mime.parse().map_err(|_| CommandErr::InvalidMedia)?;

        let in_reply_to = match in_reply_to {
            Some(id) => Some(OwnedEventId::try_from(id).map_err(|_| CommandErr::UnknownRoom)?),
            None => None,
        };

        let config = AttachmentConfig {
            caption: caption.map(TextMessageEventContent::plain),
            in_reply_to,
            ..AttachmentConfig::default()
        };

        self.timeline(&room_id)
            .await?
            .send_attachment(AttachmentSource::Data { bytes, filename }, mime, config)
            // Inline, a dropped connection loses the file. Queued, it retries.
            .use_send_queue()
            .await
            .map_err(|error| self.failed("send_attachment", error))?;

        Ok(())
    }

    /// Cached: building one twice gives the UI two streams for one room.
    #[allow(clippy::arc_with_non_send_sync)] // Matrix timelines are single-threaded on WASM
    async fn timeline(&self, room_id: &OwnedRoomId) -> Result<Arc<Timeline>, CommandErr> {
        if let Some(timeline) = self.timelines.lock().await.get(room_id) {
            return Ok(timeline.clone());
        }

        let room = self.room(room_id).await?;
        let timeline = Arc::new(
            room.timeline()
                .await
                .map_err(|error| self.failed("build timeline", error))?,
        );

        let mut timelines = self.timelines.lock().await;
        Ok(timelines.entry(room_id.clone()).or_insert(timeline).clone())
    }
}

async fn build_room_timeline(
    room: &matrix_sdk::Room,
    event_id: Option<OwnedEventId>,
) -> Result<Timeline, matrix_sdk_ui::timeline::Error> {
    let builder = room.timeline_builder();
    let builder = match event_id {
        Some(event_id) => builder.with_focus(TimelineFocus::Event {
            target: event_id,
            num_context_events: 20,
            thread_mode: TimelineEventFocusThreadMode::Automatic {
                hide_threaded_events: false,
            },
        }),
        None => builder,
    };
    builder.build().await
}

#[cfg(test)]
#[allow(clippy::large_futures)]
mod tests {
    use super::*;

    #[test]
    fn oauth_callback_must_match_its_redirect_target() -> Result<(), url::ParseError> {
        let expected = Url::parse("https://next.sable.moe/login")?;
        let valid = Url::parse("https://next.sable.moe/login?code=secret&state=csrf")?;
        let error = Url::parse(
            "https://next.sable.moe/login?error=access_denied&error_description=no&state=csrf",
        )?;
        let wrong_path = Url::parse("https://next.sable.moe/other?code=secret&state=csrf")?;
        let wrong_origin = Url::parse("https://attacker.invalid/login?code=secret&state=csrf")?;
        let wrong_port = Url::parse("https://next.sable.moe:8443/login?code=secret&state=csrf")?;
        let fragment = Url::parse("https://next.sable.moe/login?code=secret&state=csrf#token")?;
        let extra_query =
            Url::parse("https://next.sable.moe/login?code=secret&state=csrf&next=attacker")?;

        let response_parameters = ["code", "state", "error", "error_description", "error_uri"];
        assert!(same_redirect_target(
            &expected,
            &valid,
            &response_parameters
        ));
        assert!(same_redirect_target(
            &expected,
            &error,
            &response_parameters
        ));
        for invalid in [wrong_path, wrong_origin, wrong_port, fragment, extra_query] {
            assert!(!same_redirect_target(
                &expected,
                &invalid,
                &response_parameters
            ));
        }
        Ok(())
    }

    #[test]
    fn sso_callback_must_preserve_our_state() -> Result<(), url::ParseError> {
        let expected = Url::parse("moe.sable.next://login?sable_sso_state=expected")?;
        let valid =
            Url::parse("moe.sable.next://login?sable_sso_state=expected&loginToken=secret")?;
        let wrong_state =
            Url::parse("moe.sable.next://login?sable_sso_state=attacker&loginToken=secret")?;

        assert!(same_redirect_target(&expected, &valid, &["loginToken"]));
        assert!(!same_redirect_target(
            &expected,
            &wrong_state,
            &["loginToken"]
        ));
        assert!(has_single_nonempty_query_parameter(
            &expected,
            "sable_sso_state"
        ));
        assert!(has_single_nonempty_query_parameter(&valid, "loginToken"));
        assert!(!has_single_nonempty_query_parameter(
            &Url::parse("moe.sable.next://login")?,
            "sable_sso_state"
        ));
        assert!(!has_single_nonempty_query_parameter(
            &Url::parse("moe.sable.next://login?sable_sso_state=")?,
            "sable_sso_state"
        ));
        assert!(!has_single_nonempty_query_parameter(
            &Url::parse("moe.sable.next://login?loginToken=one&loginToken=two")?,
            "loginToken"
        ));
        Ok(())
    }

    struct FailingClearSessionStore;

    impl SessionStore for FailingClearSessionStore {
        fn load(
            &self,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<u8>>> + Send + '_>>
        {
            Box::pin(async { None })
        }

        fn save(
            &self,
            _bytes: Vec<u8>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
        {
            Box::pin(async { Ok(()) })
        }

        fn clear(
            &self,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
        {
            Box::pin(async { Err("storage unavailable".to_owned()) })
        }
    }

    struct TestSessionStore {
        bytes: Arc<Mutex<Option<Vec<u8>>>>,
    }

    impl SessionStore for TestSessionStore {
        fn load(
            &self,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<u8>>> + Send + '_>>
        {
            Box::pin(async move { self.bytes.lock().await.clone() })
        }

        fn save(
            &self,
            bytes: Vec<u8>,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
        {
            Box::pin(async move {
                *self.bytes.lock().await = Some(bytes);
                Ok(())
            })
        }

        fn clear(
            &self,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>>
        {
            Box::pin(async move {
                *self.bytes.lock().await = None;
                Ok(())
            })
        }
    }

    #[tokio::test]
    async fn commands_before_login_are_rejected() {
        let (core, _rx) = Core::new("test", Box::new(store::MemorySessionStore::default()));
        assert!(matches!(
            core.dispatch(Command::SubscribeRoomList).await,
            Err(CommandErr::NotLoggedIn)
        ));
    }

    #[tokio::test]
    async fn session_clear_failure_is_reported() {
        let (core, _rx) = Core::new("test", Box::new(FailingClearSessionStore));
        assert!(matches!(
            core.clear_persisted_session().await,
            Err(CommandErr::Failed { .. })
        ));
    }

    #[tokio::test]
    async fn unknown_token_ends_the_session_but_refresh_does_not() {
        let bytes = Arc::new(Mutex::new(Some(b"session".to_vec())));
        let (core, mut events) = Core::new(
            "test",
            Box::new(TestSessionStore {
                bytes: bytes.clone(),
            }),
        );

        assert!(
            !core
                .handle_session_change(matrix_sdk::SessionChange::TokensRefreshed, 1)
                .await
        );
        assert_eq!(*bytes.lock().await, Some(b"session".to_vec()));

        assert!(
            core.handle_session_change(
                matrix_sdk::SessionChange::UnknownToken(
                    matrix_sdk::ruma::api::error::UnknownTokenErrorData::new(),
                ),
                1,
            )
            .await
        );
        assert_eq!(*bytes.lock().await, None);
        assert!(matches!(
            events.recv().await,
            Some(CoreEvent::SessionEnded { reason }) if reason == "token_rejected"
        ));
    }
}

#[cfg(all(test, not(target_family = "wasm")))]
// These timeline tests use panic-based assertions to keep async test failures readable.
#[allow(
    clippy::expect_used,
    clippy::large_futures,
    clippy::panic,
    clippy::unwrap_used
)]
mod sdk_timeline_tests;

#[cfg(test)]
// These ignored network tests intentionally panic with context on an unexpected
// server response; production command paths remain panic-free.
#[allow(clippy::expect_used, clippy::large_futures, clippy::panic)]
mod live_tests {
    use super::*;

    #[tokio::test]
    #[ignore = "hits matrix.org"]
    async fn discovers_a_real_homeserver() {
        let (core, _rx) = Core::new(
            "sable-next-discover",
            Box::new(store::MemorySessionStore::default()),
        );
        let result = core
            .dispatch(Command::DiscoverHomeserver {
                server_name: "matrix.org".into(),
            })
            .await
            .expect("discovery should succeed");

        let CommandOk::DiscoverHomeserver { homeserver } = result else {
            panic!("wrong response variant");
        };
        assert!(homeserver.contains("matrix.org"), "got {homeserver}");
    }

    #[tokio::test]
    #[ignore = "hits matrix.org"]
    async fn rejects_bad_credentials() {
        let dir = std::env::temp_dir().join("sable-next-badlogin");
        let (core, _rx) = Core::new(
            dir.to_string_lossy().into_owned(),
            Box::new(store::MemorySessionStore::default()),
        );
        let error = core
            .dispatch(Command::Login {
                homeserver: "https://matrix.org".into(),
                username: "sable-next-does-not-exist".into(),
                password: "definitely-wrong".into(),
            })
            .await
            .expect_err("login should fail");

        assert!(matches!(error, CommandErr::Denied), "got {error:?}");
    }
}
