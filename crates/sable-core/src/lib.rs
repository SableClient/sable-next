#![recursion_limit = "512"]

mod account_data;
mod account_documents;
mod account_lock;
mod accounts;
mod activity;
pub mod api;
mod attachments;
mod auth;
pub mod binding;
mod bookmarks;
mod bot_commands;
mod calendar;
mod calls;
mod cosmetics;
#[cfg(not(target_family = "wasm"))]
mod credentials;
mod dehydrated_device;
mod delayed_events;
mod encryption_details;
mod errors;
mod gestures;
pub use errors::CoreError;
pub(crate) use errors::ResultExt;
#[cfg(target_family = "wasm")]
pub use search::attach_search_port;
pub use signed_in::SignedIn;
pub(crate) use signed_in::WeakSignedIn;
mod account_clients;
pub mod image_packs;
mod inbox;
mod invites;
mod key_backup;
mod lenient;
mod lifecycle;
mod link_previews;
pub mod matrix_html;
mod media;
mod media_health;
mod member_look;
mod messages;
pub mod nicknames;
pub mod notifications;
mod oauth_metadata;
mod outgoing;
mod pack_edits;
mod password_reset;
mod personas;
mod pin_marker;
pub mod polls;
mod power_levels;
mod presence;
mod presence_sharing;
mod preview;
mod probed_state;
mod profile_overrides;
pub mod profiles;
pub mod protocol;
pub mod push_check;
pub mod push_rules;
mod qr_login;
mod reaction_history;
mod reactions;
mod registration;
mod room_keys;
mod room_list_batch;
mod room_list_rows;
mod room_rules;
mod room_sections;
mod room_settings;
mod room_widgets;
mod rooms;
mod routing;
mod rtc;
mod scheduled;
mod sealed_account_data;
pub mod search;
#[cfg(not(target_family = "wasm"))]
pub mod secrets;
pub mod session;
mod settings;
mod signed_in;
mod space_parents;
pub mod spaces;
mod sticker_history;
pub mod store;
mod store_disposal;
#[cfg(not(target_family = "wasm"))]
mod store_encryption;
#[cfg(test)]
mod store_reads;
mod subscriptions;
mod supervisor;
mod sync_support;
mod tasks;
#[cfg(test)]
mod test_support;
mod thread_receipts;
mod timeline_overlay;
mod timelines;
pub mod tls;
mod tunnel;
mod usage_history;
mod utd;
mod verification;
pub mod view;
mod watchers;
pub mod webpush;

pub use matrix_sdk::{Client as MatrixClient, reqwest, ruma};

// MAS names OAuth devices from the `(model; os)` segment and falls back to "Unknown device".
macro_rules! user_agent {
    ($platform:literal) => {
        concat!(
            "Sable/",
            env!("SABLE_APP_VERSION"),
            " (",
            $platform,
            "; ",
            $platform,
            ")"
        )
    };
}

#[cfg(target_os = "android")]
pub const USER_AGENT: &str = user_agent!("Android");
#[cfg(target_os = "ios")]
pub const USER_AGENT: &str = user_agent!("iOS");
#[cfg(target_os = "macos")]
pub const USER_AGENT: &str = user_agent!("macOS");
#[cfg(target_os = "windows")]
pub const USER_AGENT: &str = user_agent!("Windows");
#[cfg(target_family = "wasm")]
pub const USER_AGENT: &str = user_agent!("Web");
#[cfg(not(any(
    target_os = "android",
    target_os = "ios",
    target_os = "macos",
    target_os = "windows",
    target_family = "wasm"
)))]
pub const USER_AGENT: &str = user_agent!("Linux");

mod widgets;

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
};

use crate::tasks::JoinHandleExt;
use matrix_sdk::ruma::events::call::member::CallMemberStateKey;
use matrix_sdk::ruma::events::{AnyGlobalAccountDataEventContent, GlobalAccountDataEventType};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, RoomId};
use matrix_sdk_ui::timeline::Timeline;
use tokio::sync::{Mutex, mpsc, watch};
use url::Url;

use protocol::{CoreEvent, RpcCode, RpcError, SubscriptionId};
use session::AccountRegistry;
use store::SessionStore;

pub(crate) use tasks::Task;

const TO_DEVICE_WORK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Lets pushes and pusher upkeep use the clients of the core that owns their store.
#[cfg(not(target_family = "wasm"))]
static CORES: parking_lot::Mutex<Vec<std::sync::Weak<Core>>> = parking_lot::Mutex::new(Vec::new());

/// Owns every piece of Matrix state. A carrier only moves `Command`s in and
/// `CoreEvent`s out.
pub struct Core {
    store_id: String,
    settings: settings::Settings,
    sign_in: auth::SignInFlows,
    persistent_event_cache: bool,
    sessions: Box<dyn SessionStore>,
    events: mpsc::UnboundedSender<CoreEvent>,
    next_subscription: AtomicU32,
    next_log_id: AtomicU64,
    next_registration_attempt: AtomicU64,
    lifecycle: lifecycle::Lifecycle,
    /// Accounts whose rotated tokens could not be saved, which the SDK only logs.
    unsaved_tokens: parking_lot::Mutex<std::collections::HashSet<String>>,
    #[cfg(not(target_family = "wasm"))]
    unmoved_tokens: parking_lot::Mutex<std::collections::HashSet<String>>,
    next_credential_writer: AtomicU64,
    next_login_attempt: AtomicU64,
    clients: account_clients::AccountClients,
    nicknames: watch::Sender<nicknames::Nicknames>,
    nicknames_stale: tokio::sync::Notify,
    room_list_options: watch::Sender<protocol::RoomListOptionsView>,
    dm_spaces_changed: watch::Sender<()>,
    media_health: parking_lot::Mutex<media_health::MediaHealth>,
    media_downloads: tokio::sync::Semaphore,
    tunnel: tunnel::Tunnel,
    accounts: Mutex<Option<AccountRegistry>>,
    session: lifecycle::SessionSlot,
    search_network: search::CrawlNetwork,
    app_in_foreground: AtomicBool,
    shut_down: AtomicBool,
    activity: activity::Activity,
    session_step: parking_lot::Mutex<&'static str>,
    supervisor: supervisor::Supervisor,
    foreground_paginations: AtomicU32,
}

struct CallSession {
    room_id: OwnedRoomId,
    state_key: CallMemberStateKey,
    delay_id: Arc<Mutex<calls::DelayState>>,
    postpone: Option<Task>,
    updates: Option<Task>,
    state: Arc<parking_lot::Mutex<calls::CallRuntimeState>>,
    sticky_member: Option<String>,
    _handlers: Vec<matrix_sdk::event_handler::EventHandlerDropGuard>,
}

pub(crate) struct ForegroundPagination {
    core: Arc<Core>,
}

impl Drop for ForegroundPagination {
    fn drop(&mut self) {
        self.core
            .foreground_paginations
            .fetch_sub(1, Ordering::Relaxed);
    }
}

type ThreadKey = (OwnedRoomId, OwnedEventId);

pub(crate) struct SessionState {
    ended: tokio_util::sync::CancellationToken,
    /// Cancelled when a logout ends the session, so the methods still running on it stop.
    discarded: tokio_util::sync::CancellationToken,
    generation: AtomicU64,
    session_handlers: parking_lot::Mutex<Vec<matrix_sdk::event_handler::EventHandlerDropGuard>>,
    probed_pinned_rooms: parking_lot::Mutex<HashMap<OwnedRoomId, Vec<OwnedEventId>>>,
    pinned_caches: parking_lot::Mutex<
        HashMap<
            OwnedRoomId,
            (
                matrix_sdk::event_cache::PinnedEventsCache,
                Arc<matrix_sdk::event_cache::EventCacheDropHandles>,
            ),
        >,
    >,
    cosmetics: Arc<parking_lot::Mutex<cosmetics::CosmeticsCache>>,
    probed_state: Arc<parking_lot::Mutex<probed_state::ProbedState>>,
    recent_state: Arc<parking_lot::Mutex<probed_state::RecentState>>,
    session_tasks: parking_lot::Mutex<Vec<Task>>,
    foreground_work: parking_lot::Mutex<Option<Task>>,
    reopen_retry: parking_lot::Mutex<Option<Task>>,
    to_device_inbox: parking_lot::Mutex<
        Option<mpsc::UnboundedSender<matrix_sdk_common::BoxFuture<'static, ()>>>,
    >,
    subscriptions: parking_lot::Mutex<HashMap<SubscriptionId, Subscription>>,
    room_subscriptions: Arc<Mutex<std::collections::BTreeSet<OwnedRoomId>>>,
    warm_rooms: parking_lot::Mutex<std::collections::VecDeque<OwnedRoomId>>,
    account_data_types: parking_lot::Mutex<std::collections::BTreeSet<String>>,
    pack_cache: parking_lot::Mutex<image_packs::PackCache>,
    calendars: parking_lot::Mutex<HashMap<OwnedRoomId, calendar::RoomCalendar>>,
    push_rules: Mutex<Option<Arc<push_rules::PushRules>>>,
    timelines: parking_lot::Mutex<hashlink::LinkedHashMap<OwnedRoomId, CachedTimeline>>,
    thread_timelines: parking_lot::Mutex<hashlink::LruCache<ThreadKey, CachedTimeline>>,
    read_room: parking_lot::Mutex<Option<OwnedRoomId>>,
    search_index: Mutex<search::MessageIndex>,
    inbox: inbox::Inbox,
    account_data_writes: Mutex<()>,
    usage_history_writes: Mutex<()>,
    rtc: rtc::RtcSessions,
    server_search: parking_lot::Mutex<search::ServerSearch>,
    calls: Mutex<HashMap<protocol::CallSessionId, CallSession>>,
    search_crawl: parking_lot::Mutex<search::CrawlProgress>,
    search_peers: search::SearchPeers,
    pending_identity_reset: parking_lot::Mutex<Option<verification::PendingIdentityReset>>,
    /// Until sync echoes the acceptance, the room would read as unaccepted.
    accepted_rules: parking_lot::Mutex<HashMap<OwnedRoomId, i64>>,
    scalar_tokens: parking_lot::Mutex<HashMap<String, String>>,
    cosmetics_fetches: parking_lot::Mutex<HashMap<OwnedRoomId, Arc<Mutex<()>>>>,
    key_backup_downloads: tokio::sync::Semaphore,
    key_backup_download: parking_lot::Mutex<Option<protocol::KeyBackupDownloadView>>,
    preview_images: parking_lot::Mutex<
        hashlink::LruCache<link_previews::PreparedImageKey, link_previews::PreparedImage>,
    >,
    operations: std::sync::atomic::AtomicUsize,
    operations_done: tokio::sync::Notify,
    tasks_stopped: AtomicBool,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            ended: tokio_util::sync::CancellationToken::new(),
            discarded: tokio_util::sync::CancellationToken::new(),
            generation: AtomicU64::new(0),
            session_handlers: parking_lot::Mutex::new(Vec::new()),
            probed_pinned_rooms: parking_lot::Mutex::new(HashMap::new()),
            pinned_caches: parking_lot::Mutex::new(HashMap::new()),
            cosmetics: Arc::new(parking_lot::Mutex::new(cosmetics::CosmeticsCache::default())),
            probed_state: Arc::new(parking_lot::Mutex::new(probed_state::ProbedState::default())),
            recent_state: Arc::new(parking_lot::Mutex::new(probed_state::RecentState::default())),
            session_tasks: parking_lot::Mutex::new(Vec::new()),
            foreground_work: parking_lot::Mutex::new(None),
            reopen_retry: parking_lot::Mutex::new(None),
            to_device_inbox: parking_lot::Mutex::new(None),
            subscriptions: parking_lot::Mutex::new(HashMap::new()),
            room_subscriptions: Arc::new(Mutex::new(std::collections::BTreeSet::new())),
            warm_rooms: parking_lot::Mutex::new(std::collections::VecDeque::new()),
            account_data_types: parking_lot::Mutex::new(std::collections::BTreeSet::new()),
            pack_cache: parking_lot::Mutex::new(image_packs::PackCache::default()),
            calendars: parking_lot::Mutex::new(HashMap::new()),
            push_rules: Mutex::new(None),
            timelines: parking_lot::Mutex::new(hashlink::LinkedHashMap::new()),
            thread_timelines: parking_lot::Mutex::new(hashlink::LruCache::new(
                timelines::MAX_CACHED_THREAD_TIMELINES,
            )),
            read_room: parking_lot::Mutex::new(None),
            search_index: Mutex::new(search::MessageIndex::new()),
            inbox: inbox::Inbox::default(),
            account_data_writes: Mutex::new(()),
            usage_history_writes: Mutex::new(()),
            rtc: rtc::RtcSessions::default(),
            server_search: parking_lot::Mutex::new(search::ServerSearch::default()),
            calls: Mutex::new(HashMap::new()),
            search_crawl: parking_lot::Mutex::new(search::CrawlProgress::default()),
            search_peers: search::SearchPeers::default(),
            pending_identity_reset: parking_lot::Mutex::new(None),
            accepted_rules: parking_lot::Mutex::new(HashMap::new()),
            scalar_tokens: parking_lot::Mutex::new(HashMap::new()),
            cosmetics_fetches: parking_lot::Mutex::new(HashMap::new()),
            key_backup_downloads: tokio::sync::Semaphore::new(1),
            key_backup_download: parking_lot::Mutex::new(None),
            preview_images: parking_lot::Mutex::new(hashlink::LruCache::new(
                link_previews::MAX_PREPARED_IMAGES,
            )),
            operations: std::sync::atomic::AtomicUsize::new(0),
            operations_done: tokio::sync::Notify::new(),
            tasks_stopped: AtomicBool::new(false),
        }
    }
}

struct CachedTimeline {
    timeline: Arc<Timeline>,
    hidden_events: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LoginMethod {
    Oidc,
    Sso,
}

struct PendingLogin {
    attempt: u64,
    method: LoginMethod,
    account_id: String,
    account_store_id: String,
    homeserver: String,
    redirect_uri: Url,
    client: matrix_sdk::Client,
    reauth: Option<session::PersistedAccount>,
}

struct Subscription {
    tasks: Vec<Task>,
    timeline: Option<Arc<Timeline>>,
    overlay: Option<Arc<parking_lot::Mutex<timeline_overlay::TimelineOverlay>>>,
    thread_root: Option<OwnedEventId>,
    kind: SubscriptionKind,
}

enum SubscriptionKind {
    Other,
    LiveTimeline(OwnedRoomId),
    FocusedTimeline(OwnedRoomId),
}

pub(crate) fn now_ms() -> u64 {
    ruma::MilliSecondsSinceUnixEpoch::now().get().into()
}

impl Core {
    pub fn new(
        store_id: impl Into<String>,
        sessions: Box<dyn SessionStore>,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<CoreEvent>) {
        Self::new_with_event_cache(store_id, sessions, true)
    }

    #[cfg_attr(
        target_family = "wasm",
        expect(
            clippy::arc_with_non_send_sync,
            reason = "WASM keeps the core on one event-loop thread"
        )
    )]
    pub fn new_with_event_cache(
        store_id: impl Into<String>,
        sessions: Box<dyn SessionStore>,
        persistent_event_cache: bool,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<CoreEvent>) {
        #[cfg(not(target_family = "wasm"))]
        tls::install_crypto_provider();
        #[cfg(all(test, not(target_family = "wasm")))]
        test_support::watch_for_deadlocks();
        let (events, rx) = mpsc::unbounded_channel();
        let core = Arc::new(Self {
            store_id: store_id.into(),
            settings: settings::Settings::default(),
            sign_in: auth::SignInFlows::default(),
            persistent_event_cache,
            sessions,
            events,
            search_network: search::CrawlNetwork::default(),
            app_in_foreground: AtomicBool::new(true),
            shut_down: AtomicBool::new(false),
            activity: activity::Activity::new(),
            next_subscription: AtomicU32::new(1),
            foreground_paginations: AtomicU32::new(0),
            next_log_id: AtomicU64::new(1),
            next_registration_attempt: AtomicU64::new(1),
            lifecycle: lifecycle::Lifecycle::new(),
            unsaved_tokens: parking_lot::Mutex::new(std::collections::HashSet::new()),
            #[cfg(not(target_family = "wasm"))]
            unmoved_tokens: parking_lot::Mutex::new(std::collections::HashSet::new()),
            next_credential_writer: AtomicU64::new(1),
            next_login_attempt: AtomicU64::new(1),
            clients: account_clients::AccountClients::default(),
            nicknames: watch::Sender::new(nicknames::Nicknames::default()),
            nicknames_stale: tokio::sync::Notify::new(),
            room_list_options: watch::Sender::new(protocol::RoomListOptionsView::default()),
            dm_spaces_changed: watch::Sender::new(()),
            media_health: parking_lot::Mutex::new(media_health::MediaHealth::default()),
            media_downloads: tokio::sync::Semaphore::new(media::MAX_MEDIA_DOWNLOADS),
            tunnel: tunnel::Tunnel::new(),
            accounts: Mutex::new(None),
            session: lifecycle::SessionSlot::new(),
            session_step: parking_lot::Mutex::new("idle"),
            supervisor: supervisor::Supervisor::new(),
        });
        #[cfg(not(target_family = "wasm"))]
        CORES.lock().push(Arc::downgrade(&core));
        #[cfg(not(target_family = "wasm"))]
        notifications::evict_push_cache(std::path::Path::new(&core.store_id));
        (core, rx)
    }

    /// The core of this process that owns the stores under `base_store`.
    #[cfg(not(target_family = "wasm"))]
    pub(crate) fn owning(base_store: &std::path::Path) -> Option<Arc<Self>> {
        let wanted = std::fs::canonicalize(base_store).unwrap_or_else(|_| base_store.into());
        let mut cores = CORES.lock();
        cores.retain(|core| core.strong_count() > 0);
        cores
            .iter()
            .filter_map(std::sync::Weak::upgrade)
            .find(|core| {
                let base = std::path::Path::new(&core.store_id);
                std::fs::canonicalize(base).unwrap_or_else(|_| base.into()) == wanted
            })
    }

    #[must_use]
    pub fn notification_content(&self) -> bool {
        self.settings.notification_content.load(Ordering::Relaxed)
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "answers for whichever account is signed in"
    )]
    pub fn user_id(&self) -> Option<ruma::OwnedUserId> {
        self.session
            .current(|session| session.client.user_id().map(ToOwned::to_owned))
            .flatten()
    }

    #[must_use]
    pub fn notification_encrypted_content(&self) -> bool {
        self.settings
            .notification_encrypted_content
            .load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn notification_sounds(&self) -> bool {
        self.settings.notification_sounds.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn notify_once(&self) -> bool {
        self.settings.notify_once.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn notifications_enabled(&self) -> bool {
        self.settings.notifications_enabled.load(Ordering::Relaxed)
    }

    /// The open app shows this alert as an in-app banner, so the OS must not post it too.
    #[must_use]
    pub fn shows_banner(&self, view: &protocol::NotificationView) -> bool {
        self.settings.in_app_banners.load(Ordering::Relaxed)
            && self.is_app_active()
            && view.wants_banner()
    }

    /// No carrier means no UI, and syncing continues, so a drop is not an error.
    pub fn emit(&self, event: CoreEvent) {
        if let CoreEvent::AccountDataChanged { event_type } = &event {
            if nicknames::reads_from(event_type) {
                self.nicknames_stale.notify_one();
            }
            if event_type == account_documents::DM_SPACES_EVENT {
                self.dm_spaces_changed.send_replace(());
            }
        }
        let _ = self.events.send(event);
    }

    pub(crate) fn emit_if_current(&self, generation: u64, event: CoreEvent) {
        if self.is_current(generation) {
            self.emit(event);
        }
    }

    pub(crate) fn foreground_paginations(&self) -> u32 {
        self.foreground_paginations.load(Ordering::Relaxed)
    }

    pub async fn update_app_in_foreground(self: &Arc<Self>, foreground: bool) {
        self.app_in_foreground.store(foreground, Ordering::Relaxed);
        self.refresh_search_peers().await;
    }

    pub(crate) fn search_crawl_active(&self) -> bool {
        !self.search_peers_discovering()
            && self.activity.app_active()
            && self.app_in_foreground.load(Ordering::Relaxed)
            && self.search_network.allows_crawl()
    }

    pub(crate) fn begin_foreground_pagination(self: &Arc<Self>) -> ForegroundPagination {
        self.foreground_paginations.fetch_add(1, Ordering::Relaxed);
        ForegroundPagination { core: self.clone() }
    }

    pub(crate) fn allocate_subscription(&self) -> SubscriptionId {
        SubscriptionId(self.next_subscription.fetch_add(1, Ordering::Relaxed))
    }

    pub(crate) async fn accounts(&self) -> Result<AccountRegistry, RpcError> {
        let mut accounts = self.accounts.lock().await;
        if let Some(accounts) = accounts.as_ref() {
            return Ok(accounts.clone());
        }

        let stored = self
            .sessions
            .load()
            .await
            .or_failed(self, "restore_read_session_file")?;
        let Some(bytes) = stored else {
            let registry = AccountRegistry::empty();
            *accounts = Some(registry.clone());
            return Ok(registry);
        };
        let (mut registry, migrated) = AccountRegistry::from_bytes(&bytes, &self.store_id)
            .or_failed(self, "restore_parse_session_file")?;
        let reanchored = registry.reanchor_stores(&self.store_id);
        for account in registry
            .accounts
            .iter_mut()
            .filter(|account| account.state.device_gone())
        {
            account.session.credentials.discard_tokens();
        }
        #[cfg(not(target_family = "wasm"))]
        let embedded_tokens = self
            .load_login_tokens(&mut registry)
            .await
            .or_failed(self, "restore_login_tokens")?;
        #[cfg(target_family = "wasm")]
        let embedded_tokens = false;
        if migrated
            || reanchored
            || embedded_tokens
            || registry
                .accounts
                .iter()
                .any(|account| account.state.device_gone())
        {
            self.write_registry(&registry)
                .await
                .or_failed(self, "migrate_session_registry")?;
        }
        *accounts = Some(registry.clone());
        Ok(registry)
    }

    pub(crate) fn remember_homeserver(&self, homeserver: &str, client: &matrix_sdk::Client) {
        self.sign_in
            .discovered_homeservers
            .lock()
            .insert(homeserver.to_owned(), client.homeserver());
    }

    pub(crate) async fn build_account_client(
        &self,
        store_id: &str,
        homeserver: &str,
    ) -> Result<matrix_sdk::Client, session::BuildError> {
        let resolved = self
            .sign_in
            .discovered_homeservers
            .lock()
            .get(homeserver)
            .cloned();

        match resolved {
            Some(url) => {
                session::build_client_at(store_id, &url, self.persistent_event_cache).await
            }
            None => session::build_client(store_id, homeserver, self.persistent_event_cache).await,
        }
    }

    pub(crate) async fn allocate_account(&self) -> Result<(String, String), RpcError> {
        self.accounts().await?;
        let mut accounts = self.accounts.lock().await;
        let Some(registry) = accounts.as_mut() else {
            return Err(self.failed("allocate_account", "account registry is not initialized"));
        };
        let mut updated = registry.clone();
        // An abandoned sign-in leaves its device's crypto store behind, which another device
        // cannot open.
        #[cfg_attr(
            target_family = "wasm",
            expect(unused_mut, reason = "IndexedDB stores are not probed")
        )]
        let mut allocated = updated.allocate_account(&self.store_id);
        #[cfg(not(target_family = "wasm"))]
        while session::store_holds_data(&allocated.1)
            .await
            .or_failed(self, "allocate_account_store")?
        {
            allocated = updated.allocate_account(&self.store_id);
        }
        self.write_registry(&updated)
            .await
            .or_failed(self, "allocate_account_save")?;
        *registry = updated;
        Ok(allocated)
    }
}

impl SignedIn {
    pub(crate) fn set_read_room(&self, room_id: Option<OwnedRoomId>) {
        *self.state().read_room.lock() = room_id;
    }

    #[must_use]
    pub(crate) fn is_read_room(&self, room_id: &RoomId) -> bool {
        self.state().read_room.lock().as_deref() == Some(room_id)
    }

    /// A task tracked after its session ended is dropped, so it cannot keep the session alive.
    pub(crate) fn track_session_task(&self, task: Task) {
        let mut tasks = self.state().session_tasks.lock();
        if !self.state().ended.is_cancelled() {
            tasks.push(task);
        }
    }

    /// The SDK awaits event handlers before its next sync request.
    pub(crate) fn defer_to_device(&self, work: matrix_sdk_common::BoxFuture<'static, ()>) {
        let session_state = self.state();
        let mut inbox = session_state.to_device_inbox.lock();
        if session_state.ended.is_cancelled() {
            return;
        }
        let work = match inbox.as_ref() {
            Some(sender) => match sender.send(work) {
                Ok(()) => return,
                Err(mpsc::error::SendError(work)) => work,
            },
            None => work,
        };
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let _ = sender.send(work);
        *inbox = Some(sender);
        self.track_session_task(
            matrix_sdk::executor::spawn(async move {
                while let Some(work) = receiver.recv().await {
                    // The wasm HTTP client ignores request timeouts.
                    if matrix_sdk::timeout::timeout(work, TO_DEVICE_WORK_TIMEOUT)
                        .await
                        .is_err()
                    {
                        tracing::warn!("to-device work timed out");
                    }
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) fn track_session_handler(
        &self,
        client: &matrix_sdk::Client,
        handle: matrix_sdk::event_handler::EventHandlerHandle,
    ) {
        let guard = client.event_handler_drop_guard(handle);
        let mut handlers = self.state().session_handlers.lock();
        if !self.has_ended() {
            handlers.push(guard);
        }
    }

    pub(crate) async fn account_data_types(&self) -> Result<Vec<String>, RpcError> {
        let client = self.client();
        let mut types = self.state().account_data_types.lock().clone();
        types.extend(
            self.core()
                .with_open_stores(async || account_data::stored_types(client).await)
                .await,
        );
        match account_data::server_types(client, self.sync_presence().await).await {
            Ok(listed) => {
                for event_type in listed {
                    if !types.contains(&event_type) {
                        self.remember_account_data_type(event_type.clone()).await;
                        types.insert(event_type);
                    }
                }
            }
            Err(error) => tracing::debug!("listing the account data types failed: {error}"),
        }
        for candidate in account_data::KNOWN_TYPES {
            if types.contains(*candidate) {
                continue;
            }
            if let Ok(Some(_)) = self
                .core()
                .with_open_stores(async || {
                    client
                        .state_store()
                        .get_account_data_event((*candidate).into())
                        .await
                })
                .await
            {
                types.insert((*candidate).to_owned());
            }
        }
        Ok(types.into_iter().collect())
    }

    pub(crate) async fn remember_account_data_type(&self, event_type: impl Into<String>) {
        let event_type = event_type.into();
        if !self
            .state()
            .account_data_types
            .lock()
            .insert(event_type.clone())
        {
            return;
        }
        let client = self.client();
        let mut stored = account_data::stored_types(client).await;
        if !stored.insert(event_type) {
            return;
        }
        let Ok(bytes) = serde_json::to_vec(&stored) else {
            return;
        };
        if let Err(error) = client
            .state_store()
            .set_custom_value_no_read(account_data::TYPES_KEY, bytes)
            .await
        {
            tracing::warn!("persisting the account data types failed: {error}");
        }
    }

    pub(crate) async fn global_account_data(
        &self,
        event_type: GlobalAccountDataEventType,
        label: &str,
    ) -> Result<Option<Raw<AnyGlobalAccountDataEventContent>>, RpcError> {
        self.client()
            .account()
            .fetch_account_data(event_type)
            .await
            .or_failed(self.core(), label)
    }

    pub(crate) async fn put_global_account_data(
        &self,
        event_type: GlobalAccountDataEventType,
        content: &impl serde::Serialize,
        label: &str,
    ) -> Result<(), RpcError> {
        let raw = serde_json::value::to_raw_value(content)
            .map(Raw::<AnyGlobalAccountDataEventContent>::from_json)
            .or_failed(self.core(), label)?;

        self.client()
            .account()
            .set_account_data_raw(event_type, raw)
            .await
            .or_failed(self.core(), label)?;

        Ok(())
    }

    /// Reads `event_types` in order from the server and hands the first one
    /// found to `update`, which returns what to write or `None` to leave it.
    /// The write goes to the first type. Returns the document as it stands.
    /// A fetch failure or a document that is not a JSON object is an error
    /// and nothing is written.
    pub(crate) async fn update_account_data(
        &self,
        event_types: &[&str],
        label: &str,
        update: impl AsyncFnOnce(
            Option<serde_json::Value>,
        ) -> Result<Option<serde_json::Value>, RpcError>,
    ) -> Result<Option<serde_json::Value>, RpcError> {
        let _guard = self.state().account_data_writes.lock().await;
        self.update_account_data_locked(event_types, label, update)
            .await
    }

    pub(crate) async fn update_account_data_locked(
        &self,
        event_types: &[&str],
        label: &str,
        update: impl AsyncFnOnce(
            Option<serde_json::Value>,
        ) -> Result<Option<serde_json::Value>, RpcError>,
    ) -> Result<Option<serde_json::Value>, RpcError> {
        let current = self.account_object(event_types, label).await?;
        let Some(content) = update(current.clone()).await? else {
            return Ok(current);
        };
        let target = event_types
            .first()
            .ok_or_else(|| self.core().failed(label, "no account data type to write"))?;
        self.set_account_data(target, &content).await?;
        Ok(Some(content))
    }

    /// `None` when the server holds none of `event_types`.
    pub(crate) async fn account_object(
        &self,
        event_types: &[&str],
        label: &str,
    ) -> Result<Option<serde_json::Value>, RpcError> {
        for event_type in event_types {
            let Some(raw) = self
                .global_account_data((*event_type).into(), label)
                .await?
            else {
                continue;
            };
            return match raw.deserialize_as::<serde_json::Value>() {
                Ok(content @ serde_json::Value::Object(_)) => Ok(Some(content)),
                _ => Err(self
                    .core()
                    .failed(label, format_args!("{event_type} is not a JSON object"))),
            };
        }
        Ok(None)
    }

    pub(crate) async fn push_rules(&self) -> Result<Arc<push_rules::PushRules>, RpcError> {
        let client = self.client();
        let session_state = self.state();
        let mut cached = session_state.push_rules.lock().await;
        if let Some(rules) = cached.as_ref() {
            return Ok(rules.clone());
        }
        let rules = self
            .core()
            .with_open_stores(async || push_rules::PushRules::load(client).await)
            .await;
        *cached = Some(rules.clone());
        Ok(rules)
    }

    pub(crate) async fn every_encrypted_event_pushed(&self) -> bool {
        self.push_rules()
            .await
            .is_ok_and(|rules| rules.pushes_every_encrypted_event())
    }

    pub(crate) fn sync_service(&self) -> Arc<matrix_sdk_ui::sync_service::SyncService> {
        self.session().sync_service.clone()
    }

    pub(crate) fn room(&self, room_id: &OwnedRoomId) -> Result<matrix_sdk::Room, RpcError> {
        self.client()
            .get_room(room_id)
            .ok_or_else(|| RpcCode::UnknownRoom.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RpcError;

    #[tokio::test]
    async fn to_device_work_runs_in_order_without_blocking_the_caller() {
        let server = matrix_sdk::test_utils::mocks::MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let (core, _events) = test_support::signed_in_core(&server, client).await;
        let session = core.signed_in().unwrap();
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let (done, mut finished) = mpsc::unbounded_channel();
        let first = done.clone();
        session.defer_to_device(Box::pin(async move {
            released.await.unwrap();
            first.send(1).unwrap();
        }));
        let second = done.clone();
        session.defer_to_device(Box::pin(async move {
            second.send(2).unwrap();
        }));
        tokio::task::yield_now().await;
        finished.try_recv().unwrap_err();
        release.send(()).unwrap();
        assert_eq!(finished.recv().await, Some(1));
        assert_eq!(finished.recv().await, Some(2));

        session.state().session_tasks.lock().clear();
        session.state().to_device_inbox.lock().take();
        session.defer_to_device(Box::pin(async move {
            done.send(3).unwrap();
        }));
        assert_eq!(finished.recv().await, Some(3));
    }

    struct FailingClearSessionStore;

    #[async_trait::async_trait]
    impl SessionStore for FailingClearSessionStore {
        async fn load(&self) -> Result<Option<Vec<u8>>, store::StoreError> {
            Ok(None)
        }

        async fn save(&self, _bytes: Vec<u8>) -> Result<(), store::StoreError> {
            Ok(())
        }

        async fn clear(&self) -> Result<(), store::StoreError> {
            Err(store::StoreError::Message("storage unavailable".to_owned()))
        }
    }

    struct TestSessionStore {
        bytes: Arc<Mutex<Option<Vec<u8>>>>,
    }

    #[async_trait::async_trait]
    impl SessionStore for TestSessionStore {
        async fn load(&self) -> Result<Option<Vec<u8>>, store::StoreError> {
            Ok(self.bytes.lock().await.clone())
        }

        async fn save(&self, bytes: Vec<u8>) -> Result<(), store::StoreError> {
            *self.bytes.lock().await = Some(bytes);
            Ok(())
        }

        async fn clear(&self) -> Result<(), store::StoreError> {
            *self.bytes.lock().await = None;
            Ok(())
        }
    }

    #[tokio::test]
    async fn app_activity_gates_the_search_crawler() {
        let (core, _rx) = Core::new("test", Box::new(store::MemorySessionStore::default()));
        core.search_network.set_unmetered(true);
        assert!(core.search_crawl_active());

        core.set_app_active(false);
        assert!(!core.search_crawl_active());

        core.set_app_active(true);
        assert!(core.search_crawl_active());
        core.update_app_in_foreground(false).await;
        assert!(!core.search_crawl_active());
    }

    #[tokio::test]
    async fn a_closing_page_takes_only_its_own_subscriptions() {
        fn subscription() -> Subscription {
            Subscription {
                tasks: Vec::new(),
                timeline: None,
                overlay: None,
                thread_root: None,
                kind: SubscriptionKind::Other,
            }
        }

        let server = matrix_sdk::test_utils::mocks::MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let (core, _rx) = test_support::signed_in_core(&server, client).await;
        let session = core.signed_in().unwrap();
        let old = core.allocate_subscription();
        session
            .state()
            .subscriptions
            .lock()
            .insert(old, subscription());
        let dropping = session.drop_open_subscriptions();

        let new = core.allocate_subscription();
        session
            .state()
            .subscriptions
            .lock()
            .insert(new, subscription());
        dropping.await;

        let session_state = session.state();
        let open = session_state.subscriptions.lock();
        assert!(!open.contains_key(&old));
        assert!(open.contains_key(&new));
    }

    #[tokio::test]
    async fn commands_before_login_are_rejected() {
        let (core, _rx) = Core::new("test", Box::new(store::MemorySessionStore::default()));
        assert!(matches!(
            core.run(api::timeline::SubscribeRoomListParams::default())
                .await,
            Err(RpcError {
                code: RpcCode::NotLoggedIn,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn session_clear_failure_is_reported() {
        let (core, _rx) = Core::new("test", Box::new(FailingClearSessionStore));
        assert!(matches!(
            core.clear_persisted_session().await,
            Err(RpcError {
                code: RpcCode::Failed { .. },
                ..
            })
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

        assert!(!core.handle_session_change(&matrix_sdk::SessionChange::TokensRefreshed, 1));
        assert_eq!(*bytes.lock().await, Some(b"session".to_vec()));
        assert!(matches!(
            events.recv().await,
            Some(CoreEvent::SessionTokensRefreshed)
        ));

        assert!(core.handle_session_change(
            &matrix_sdk::SessionChange::UnknownToken(
                ruma::api::error::UnknownTokenErrorData::new(),
            ),
            1,
        ));
        assert!(matches!(
            events.recv().await,
            Some(CoreEvent::SessionEnded { reason }) if reason == "token_rejected"
        ));
        assert_eq!(*bytes.lock().await, None);
    }

    async fn ended_reason(events: &mut mpsc::UnboundedReceiver<CoreEvent>) -> Option<String> {
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while let Some(event) = events.recv().await {
                if let CoreEvent::SessionEnded { reason } = event {
                    return Some(reason);
                }
            }
            None
        })
        .await
        .ok()
        .flatten()
    }

    #[tokio::test]
    async fn rejected_token_after_a_refresh_still_ends_the_session() {
        let server = matrix_sdk::test_utils::mocks::MatrixMockServer::new().await;
        let (core, mut events) =
            test_support::signed_in_core(&server, server.client_builder().build().await).await;
        let session = core.signed_in().unwrap();
        let (changes, receiver) = tokio::sync::broadcast::channel(1);

        changes
            .send(matrix_sdk::SessionChange::TokensRefreshed)
            .unwrap();
        changes
            .send(matrix_sdk::SessionChange::UnknownToken(
                ruma::api::error::UnknownTokenErrorData::new(),
            ))
            .unwrap();
        session.watch_session_changes(receiver, 1);

        assert_eq!(
            ended_reason(&mut events).await.as_deref(),
            Some("token_rejected")
        );
    }

    #[tokio::test]
    async fn a_soft_logout_ends_the_session_with_its_own_reason() {
        let server = matrix_sdk::test_utils::mocks::MatrixMockServer::new().await;
        let (core, mut events) =
            test_support::signed_in_core(&server, server.client_builder().build().await).await;
        let session = core.signed_in().unwrap();
        let (changes, receiver) = tokio::sync::broadcast::channel(1);

        let mut data = ruma::api::error::UnknownTokenErrorData::new();
        data.soft_logout = true;
        changes
            .send(matrix_sdk::SessionChange::UnknownToken(data))
            .unwrap();
        session.watch_session_changes(receiver, 1);

        assert_eq!(
            ended_reason(&mut events).await.as_deref(),
            Some("soft_logout")
        );
    }

    #[test]
    fn synapse_reports_an_expired_access_token_as_a_soft_logout() {
        use matrix_sdk::ruma::api::error::{ErrorKind, StandardErrorBody};

        let expired: StandardErrorBody = serde_json::from_value(serde_json::json!({
            "errcode": "M_UNKNOWN_TOKEN",
            "error": "Access token has expired",
            "soft_logout": true,
        }))
        .unwrap();
        assert!(matches!(
            expired.kind,
            ErrorKind::UnknownToken(data) if data.soft_logout
        ));

        let revoked: StandardErrorBody = serde_json::from_value(serde_json::json!({
            "errcode": "M_UNKNOWN_TOKEN",
            "error": "Unrecognised access token",
            "soft_logout": false,
        }))
        .unwrap();
        assert!(matches!(
            revoked.kind,
            ErrorKind::UnknownToken(data) if !data.soft_logout
        ));
    }

    #[tokio::test]
    async fn an_allocated_account_skips_a_leftover_store_and_saves_the_counter() {
        let base = tempfile::tempdir().unwrap();
        let base_store = base.path().join("store");
        let bytes = Arc::new(Mutex::new(None));
        let (core, _events) = Core::new(
            base_store.to_str().unwrap(),
            Box::new(TestSessionStore {
                bytes: bytes.clone(),
            }),
        );
        let leftover = session::account_store_id(base_store.to_str().unwrap(), "a1");
        std::fs::create_dir_all(std::path::Path::new(&leftover).join("store")).unwrap();
        std::fs::write(
            std::path::Path::new(&leftover).join("store/matrix-sdk-crypto.sqlite3"),
            b"keys",
        )
        .unwrap();

        let (account_id, _) = core.allocate_account().await.unwrap();

        assert_eq!(account_id, "a2");
        assert!(std::path::Path::new(&leftover).join("store").exists());
        let stored: serde_json::Value =
            serde_json::from_slice(bytes.lock().await.as_deref().unwrap()).unwrap();
        assert_eq!(stored["next_account_id"], 3);
    }

    #[tokio::test]
    async fn an_allocated_account_takes_an_empty_folder_at_its_place() {
        let base = tempfile::tempdir().unwrap();
        let base_store = base.path().join("store");
        let (core, _events) = Core::new(
            base_store.to_str().unwrap(),
            Box::new(store::MemorySessionStore::default()),
        );
        let prepared = session::account_store_id(base_store.to_str().unwrap(), "a1");
        std::fs::create_dir_all(&prepared).unwrap();

        let (account_id, store_id) = core.allocate_account().await.unwrap();

        assert_eq!(account_id, "a1");
        assert_eq!(store_id, prepared);
        assert!(std::path::Path::new(&prepared).exists());
    }

    #[tokio::test]
    async fn a_soft_logout_keeps_the_account_and_only_flags_it() {
        let bytes = Arc::new(Mutex::new(Some(
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "active_account_id": "a1",
                "next_account_id": 2,
                "accounts": [{
                    "account_id": "a1",
                    "store_id": "test-account-a1",
                    "session": {
                        "homeserver": "https://example.org",
                        "credentials": {
                            "kind": "password",
                            "user_id": "@alice:example.org",
                            "device_id": "DEVICEID",
                            "access_token": "token"
                        }
                    }
                }]
            }))
            .unwrap(),
        )));
        let base = tempfile::tempdir().unwrap();
        let (core, _events) = Core::new(
            base.path().to_str().unwrap(),
            Box::new(TestSessionStore {
                bytes: bytes.clone(),
            }),
        );

        core.accounts().await.unwrap();
        core.needs_reauth(Some("a1"), false).await.unwrap();

        let stored: serde_json::Value =
            serde_json::from_slice(bytes.lock().await.as_deref().unwrap()).unwrap();
        assert_eq!(stored["accounts"].as_array().unwrap().len(), 1);
        assert_eq!(stored["accounts"][0]["needs_reauth"], true);
        assert_eq!(
            stored["accounts"][0]["store_id"],
            session::account_store_id(base.path().to_str().unwrap(), "a1")
        );
        assert!(stored["active_account_id"].is_null());
    }

    #[tokio::test]
    async fn restore_refuses_an_account_waiting_for_reauthentication() {
        let bytes = Arc::new(Mutex::new(Some(
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "active_account_id": "a1",
                "next_account_id": 2,
                "accounts": [{
                    "account_id": "a1",
                    "store_id": "test-account-a1",
                    "needs_reauth": true,
                    "session": {
                        "homeserver": "https://example.org",
                        "credentials": {
                            "kind": "password",
                            "user_id": "@alice:example.org",
                            "device_id": "DEVICEID",
                            "access_token": "token"
                        }
                    }
                }]
            }))
            .unwrap(),
        )));
        let (core, _events) = Core::new("test", Box::new(TestSessionStore { bytes }));

        assert!(matches!(core.restore().await, Ok(None)));
        assert!(matches!(
            core.switch_account(api::session::SwitchAccountParams {
                account_id: "a1".to_owned()
            })
            .await,
            Err(RpcError {
                code: RpcCode::NotLoggedIn,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn accounts_are_reanchored_after_the_data_dir_moves() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "active_account_id": "a1",
            "next_account_id": 2,
            "accounts": [{
                "account_id": "a1",
                "store_id": "/old/container/moe.sable.next-account-a1",
                "session": {
                    "homeserver": "https://example.org",
                    "credentials": {
                        "kind": "password",
                        "user_id": "@alice:example.org",
                        "device_id": "DEVICEID",
                        "access_token": "token"
                    }
                }
            }]
        }))
        .unwrap();
        let saved = Arc::new(Mutex::new(Some(bytes)));
        let (core, _rx) = Core::new(
            "/new/container/moe.sable.next",
            Box::new(TestSessionStore {
                bytes: saved.clone(),
            }),
        );

        let accounts = core.accounts().await.unwrap();
        assert_eq!(
            accounts.accounts[0].store_id,
            "/new/container/moe.sable.next-account-a1"
        );

        let persisted = saved.lock().await.clone().unwrap();
        let text = String::from_utf8_lossy(&persisted);
        assert!(text.contains("/new/container/moe.sable.next-account-a1"));
        assert!(!text.contains("/old/container"));
    }

    fn registry_with_tokens(access_token: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "active_account_id": "a1",
            "next_account_id": 2,
            "accounts": [{
                "account_id": "a1",
                "store_id": "unused",
                "session": {
                    "homeserver": "https://example.org",
                    "credentials": {
                        "kind": "password",
                        "user_id": "@alice:example.org",
                        "device_id": "DEVICEID",
                        "access_token": access_token,
                        "refresh_token": format!("{access_token}-refresh")
                    }
                }
            }]
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn tokens_a_registry_still_holds_move_into_their_login_file() {
        let base = tempfile::tempdir().unwrap();
        let saved = Arc::new(Mutex::new(Some(registry_with_tokens("embedded"))));
        let (core, _rx) = Core::new(
            base.path().to_str().unwrap(),
            Box::new(TestSessionStore {
                bytes: saved.clone(),
            }),
        );

        let accounts = core.accounts().await.unwrap();
        let tokens = accounts.accounts[0].session.credentials.tokens();
        assert_eq!(tokens.access_token, "embedded");

        let logins = credentials::LoginTokens::new(base.path());
        assert_eq!(
            logins.read("a1", "DEVICEID").unwrap().unwrap().access_token,
            "embedded"
        );
        let rewritten = saved.lock().await.clone().unwrap();
        assert!(!String::from_utf8_lossy(&rewritten).contains("embedded"));
    }

    #[tokio::test]
    async fn a_login_file_wins_over_tokens_a_registry_still_holds() {
        let base = tempfile::tempdir().unwrap();
        credentials::LoginTokens::new(base.path())
            .save(
                "a1",
                "DEVICEID",
                &matrix_sdk::SessionTokens {
                    access_token: "rotated".to_owned(),
                    refresh_token: Some("rotated-refresh".to_owned()),
                },
            )
            .unwrap();
        let (core, _rx) = Core::new(
            base.path().to_str().unwrap(),
            Box::new(TestSessionStore {
                bytes: Arc::new(Mutex::new(Some(registry_with_tokens("spent")))),
            }),
        );

        let accounts = core.accounts().await.unwrap();
        assert_eq!(
            accounts.accounts[0]
                .session
                .credentials
                .tokens()
                .access_token,
            "rotated"
        );
    }
}

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
mod sdk_timeline_tests;

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
mod sdk_spoiler_tests;

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
mod sdk_notification_tests;

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
mod sdk_helpers_tests;

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
mod live_member_tests;

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
mod sdk_verification_tests;
