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
pub mod image_packs;
mod inbox;
mod invites;
mod key_backup;
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
mod room_sections;
mod room_settings;
mod room_widgets;
mod rooms;
mod rtc;
mod scheduled;
mod sealed_account_data;
pub mod search;
#[cfg(not(target_family = "wasm"))]
pub mod secrets;
pub mod session;
mod space_parents;
pub mod spaces;
pub mod store;
mod store_disposal;
#[cfg(not(target_family = "wasm"))]
mod store_encryption;
#[cfg(test)]
mod store_reads;
mod subscriptions;
mod sync_support;
#[cfg(test)]
mod test_support;
mod thread_receipts;
mod timeline_overlay;
mod timelines;
pub mod tls;
mod utd;
mod verification;
pub mod view;
mod watchers;
pub mod webpush;

pub use matrix_sdk::{Client as MatrixClient, reqwest, ruma};

/// User-Agent for native HTTP requests.
pub const USER_AGENT: &str = concat!("Sable/", env!("SABLE_APP_VERSION"));

mod widgets;

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
};

use matrix_sdk::executor::{AbortOnDrop, JoinHandleExt};
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

pub(crate) type Task = AbortOnDrop<()>;

const TO_DEVICE_WORK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Lets pushes and pusher upkeep use the clients of the core that owns their store.
#[cfg(not(target_family = "wasm"))]
static CORES: parking_lot::Mutex<Vec<std::sync::Weak<Core>>> = parking_lot::Mutex::new(Vec::new());

/// Owns every piece of Matrix state. A carrier only moves `Command`s in and
/// `CoreEvent`s out.
pub struct Core {
    store_id: String,
    persistent_event_cache: bool,
    sessions: Box<dyn SessionStore>,
    events: mpsc::UnboundedSender<CoreEvent>,
    next_subscription: AtomicU32,
    next_log_id: AtomicU64,
    next_registration_attempt: AtomicU64,
    lifecycle: lifecycle::Lifecycle,
    session_store_lock: Mutex<()>,
    credential_writers: Mutex<HashMap<String, u64>>,
    next_credential_writer: AtomicU64,
    account_clients: Mutex<HashMap<String, matrix_sdk::Client>>,
    session_handlers: parking_lot::Mutex<Vec<matrix_sdk::event_handler::EventHandlerDropGuard>>,
    probed_pinned_rooms: parking_lot::Mutex<
        HashMap<matrix_sdk::ruma::OwnedRoomId, Vec<matrix_sdk::ruma::OwnedEventId>>,
    >,
    pinned_caches: parking_lot::Mutex<
        HashMap<
            matrix_sdk::ruma::OwnedRoomId,
            (
                matrix_sdk::event_cache::PinnedEventsCache,
                Arc<matrix_sdk::event_cache::EventCacheDropHandles>,
            ),
        >,
    >,
    cosmetics: parking_lot::Mutex<cosmetics::CosmeticsCache>,
    nicknames: watch::Sender<nicknames::Nicknames>,
    nicknames_stale: tokio::sync::Notify,
    room_list_options: watch::Sender<protocol::RoomListOptionsView>,
    dm_spaces_changed: watch::Sender<()>,
    cosmetics_fetches: parking_lot::Mutex<HashMap<matrix_sdk::ruma::OwnedRoomId, Arc<Mutex<()>>>>,
    probed_state: parking_lot::Mutex<probed_state::ProbedState>,
    recent_state: parking_lot::Mutex<probed_state::RecentState>,
    media_health: parking_lot::Mutex<media_health::MediaHealth>,
    media_downloads: tokio::sync::Semaphore,
    key_backup_downloads: tokio::sync::Semaphore,
    key_backup_download: parking_lot::Mutex<Option<protocol::KeyBackupDownloadView>>,
    notification_routes: Mutex<HashMap<String, watchers::NotificationRoute>>,
    accounts: Mutex<Option<AccountRegistry>>,
    discovered_homeservers: Mutex<HashMap<String, Url>>,
    session: lifecycle::SessionSlot,
    pending_login: Mutex<Option<PendingLogin>>,
    pending_registration: Mutex<Option<registration::PendingRegistration>>,
    qr_flow: Mutex<Option<qr_login::QrFlow>>,
    pending_identity_reset: Mutex<Option<verification::PendingIdentityReset>>,
    session_tasks: parking_lot::Mutex<Vec<Task>>,
    to_device_inbox: parking_lot::Mutex<
        Option<mpsc::UnboundedSender<matrix_sdk_common::BoxFuture<'static, ()>>>,
    >,
    subscriptions: Mutex<HashMap<SubscriptionId, Subscription>>,
    room_subscriptions: Mutex<std::collections::BTreeSet<OwnedRoomId>>,
    warm_rooms: parking_lot::Mutex<std::collections::VecDeque<OwnedRoomId>>,
    account_data_lock: Mutex<()>,
    inbox: Mutex<inbox::InboxCache>,
    inbox_flush: Mutex<()>,
    account_data_types: Mutex<std::collections::BTreeSet<String>>,
    pack_cache: Mutex<image_packs::PackCache>,
    calendars: Mutex<HashMap<OwnedRoomId, calendar::RoomCalendar>>,
    push_rules: Mutex<Option<Arc<push_rules::PushRules>>>,
    timelines: Mutex<hashlink::LinkedHashMap<OwnedRoomId, CachedTimeline>>,
    thread_timelines: Mutex<hashlink::LruCache<ThreadKey, CachedTimeline>>,
    notification_content: AtomicBool,
    notification_encrypted_content: AtomicBool,
    notification_sounds: AtomicBool,
    notify_once: AtomicBool,
    private_receipts: AtomicBool,
    widget_feed: AtomicBool,
    notifications_enabled: AtomicBool,
    search_crawler_enabled: AtomicBool,
    search_sharing: search::SearchSharing,
    rtc: rtc::RtcSessions,
    search_network: search::CrawlNetwork,
    search_foreground: AtomicBool,
    shut_down: AtomicBool,
    activity: activity::Activity,
    server_search_enabled: AtomicBool,
    read_room: parking_lot::Mutex<Option<OwnedRoomId>>,
    search_index: Mutex<search::MessageIndex>,
    search_flush: Mutex<()>,
    retiring_search: parking_lot::Mutex<HashMap<String, Arc<Mutex<()>>>>,
    search_crawl: Mutex<search::CrawlProgress>,
    server_search: Mutex<search::ServerSearch>,
    foreground_paginations: AtomicU32,
    call_sessions: Mutex<HashMap<protocol::CallSessionId, CallSession>>,
    desired_presence: parking_lot::Mutex<protocol::PresenceView>,
}

struct CallSession {
    room_id: OwnedRoomId,
    state_key: CallMemberStateKey,
    delay_id: Arc<Mutex<calls::DelayState>>,
    postpone: Option<Task>,
    updates: Option<Task>,
    state: Arc<tokio::sync::Mutex<calls::CallRuntimeState>>,
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
    matrix_sdk::ruma::MilliSecondsSinceUnixEpoch::now()
        .get()
        .into()
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
        let (events, rx) = mpsc::unbounded_channel();
        let core = Arc::new(Self {
            store_id: store_id.into(),
            persistent_event_cache,
            sessions,
            events,
            notification_content: AtomicBool::new(false),
            notification_encrypted_content: AtomicBool::new(false),
            notification_sounds: AtomicBool::new(true),
            notify_once: AtomicBool::new(true),
            private_receipts: AtomicBool::new(true),
            widget_feed: AtomicBool::new(false),
            notifications_enabled: AtomicBool::new(true),
            search_crawler_enabled: AtomicBool::new(true),
            search_sharing: search::SearchSharing::default(),
            rtc: rtc::RtcSessions::default(),
            search_network: search::CrawlNetwork::default(),
            search_foreground: AtomicBool::new(true),
            shut_down: AtomicBool::new(false),
            activity: activity::Activity::new(),
            server_search_enabled: AtomicBool::new(true),
            read_room: parking_lot::Mutex::new(None),
            next_subscription: AtomicU32::new(1),
            foreground_paginations: AtomicU32::new(0),
            next_log_id: AtomicU64::new(1),
            next_registration_attempt: AtomicU64::new(1),
            key_backup_downloads: tokio::sync::Semaphore::new(1),
            key_backup_download: parking_lot::Mutex::new(None),
            lifecycle: lifecycle::Lifecycle::new(),
            session_store_lock: Mutex::new(()),
            credential_writers: Mutex::new(HashMap::new()),
            next_credential_writer: AtomicU64::new(1),
            account_clients: Mutex::new(HashMap::new()),
            session_handlers: parking_lot::Mutex::new(Vec::new()),
            probed_pinned_rooms: parking_lot::Mutex::new(HashMap::new()),
            pinned_caches: parking_lot::Mutex::new(HashMap::new()),
            cosmetics: parking_lot::Mutex::new(cosmetics::CosmeticsCache::default()),
            nicknames: watch::Sender::new(nicknames::Nicknames::default()),
            nicknames_stale: tokio::sync::Notify::new(),
            room_list_options: watch::Sender::new(protocol::RoomListOptionsView::default()),
            dm_spaces_changed: watch::Sender::new(()),
            cosmetics_fetches: parking_lot::Mutex::new(HashMap::new()),
            probed_state: parking_lot::Mutex::new(probed_state::ProbedState::default()),
            recent_state: parking_lot::Mutex::new(probed_state::RecentState::default()),
            media_health: parking_lot::Mutex::new(media_health::MediaHealth::default()),
            media_downloads: tokio::sync::Semaphore::new(media::MAX_MEDIA_DOWNLOADS),
            notification_routes: Mutex::new(HashMap::new()),
            accounts: Mutex::new(None),
            discovered_homeservers: Mutex::new(HashMap::new()),
            session: lifecycle::SessionSlot::new(),
            pending_login: Mutex::new(None),
            pending_registration: Mutex::new(None),
            qr_flow: Mutex::new(None),
            pending_identity_reset: Mutex::new(None),
            session_tasks: parking_lot::Mutex::new(Vec::new()),
            to_device_inbox: parking_lot::Mutex::new(None),
            subscriptions: Mutex::new(HashMap::new()),
            room_subscriptions: Mutex::new(std::collections::BTreeSet::new()),
            warm_rooms: parking_lot::Mutex::new(std::collections::VecDeque::new()),
            account_data_lock: Mutex::new(()),
            inbox: Mutex::new(inbox::InboxCache::default()),
            inbox_flush: Mutex::new(()),
            account_data_types: Mutex::new(std::collections::BTreeSet::new()),
            pack_cache: Mutex::new(image_packs::PackCache::default()),
            calendars: Mutex::new(HashMap::new()),
            push_rules: Mutex::new(None),
            timelines: Mutex::new(hashlink::LinkedHashMap::new()),
            thread_timelines: Mutex::new(hashlink::LruCache::new(
                timelines::MAX_CACHED_THREAD_TIMELINES,
            )),
            search_index: Mutex::new(search::MessageIndex::new()),
            search_flush: Mutex::new(()),
            retiring_search: parking_lot::Mutex::new(HashMap::new()),
            search_crawl: Mutex::new(search::CrawlProgress::default()),
            server_search: Mutex::new(search::ServerSearch::default()),
            call_sessions: Mutex::new(HashMap::new()),
            desired_presence: parking_lot::Mutex::new(protocol::PresenceView::Online),
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
        self.notification_content.load(Ordering::Relaxed)
    }

    pub async fn user_id(&self) -> Option<ruma::OwnedUserId> {
        self.client().await.ok()?.user_id().map(ToOwned::to_owned)
    }

    #[must_use]
    pub fn notification_encrypted_content(&self) -> bool {
        self.notification_encrypted_content.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn notification_sounds(&self) -> bool {
        self.notification_sounds.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn notify_once(&self) -> bool {
        self.notify_once.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn notifications_enabled(&self) -> bool {
        self.notifications_enabled.load(Ordering::Relaxed)
    }

    pub(crate) fn set_read_room(&self, room_id: Option<OwnedRoomId>) {
        *self.read_room.lock() = room_id;
    }

    #[must_use]
    pub(crate) fn is_read_room(&self, room_id: &RoomId) -> bool {
        self.read_room.lock().as_deref() == Some(room_id)
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

    /// Session tasks must outlive their spawn call. Dropping `Task` aborts it.
    pub(crate) fn track_session_task(&self, task: Task) {
        self.session_tasks.lock().push(task);
    }

    /// The SDK awaits event handlers before its next sync request.
    pub(crate) fn defer_to_device(&self, work: matrix_sdk_common::BoxFuture<'static, ()>) {
        let mut inbox = self.to_device_inbox.lock();
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
        self.session_handlers
            .lock()
            .push(client.event_handler_drop_guard(handle));
    }

    pub(crate) fn emit_if_current(&self, generation: u64, event: CoreEvent) {
        if self.is_current(generation) {
            self.emit(event);
        }
    }

    pub(crate) fn foreground_paginations(&self) -> u32 {
        self.foreground_paginations.load(Ordering::Relaxed)
    }

    pub fn update_app_in_foreground(&self, foreground: bool) {
        self.search_foreground.store(foreground, Ordering::Relaxed);
        self.refresh_search_peers();
    }

    pub(crate) fn search_crawl_active(&self) -> bool {
        !self.search_sharing.discovering()
            && self.activity.app_active()
            && self.search_foreground.load(Ordering::Relaxed)
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
            .filter(|account| account.device_invalidated)
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
                .any(|account| account.device_invalidated)
        {
            self.write_registry(&registry)
                .await
                .or_failed(self, "migrate_session_registry")?;
        }
        *accounts = Some(registry.clone());
        Ok(registry)
    }

    pub(crate) async fn remember_homeserver(&self, homeserver: &str, client: &matrix_sdk::Client) {
        self.discovered_homeservers
            .lock()
            .await
            .insert(homeserver.to_owned(), client.homeserver());
    }

    pub(crate) async fn build_account_client(
        &self,
        store_id: &str,
        homeserver: &str,
    ) -> Result<matrix_sdk::Client, session::BuildError> {
        let resolved = self
            .discovered_homeservers
            .lock()
            .await
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
        let mut accounts = self.accounts.lock().await;
        if accounts.is_none() {
            drop(accounts);
            self.accounts().await?;
            accounts = self.accounts.lock().await;
        }
        let Some(accounts) = accounts.as_mut() else {
            return Err(self.failed("allocate_account", "account registry is not initialized"));
        };
        Ok(accounts.allocate_account(&self.store_id))
    }

    #[expect(
        clippy::unused_async,
        clippy::unused_async_trait_impl,
        reason = "awaited at some 200 call sites, which a sync signature would all touch"
    )]
    pub(crate) async fn client(&self) -> Result<matrix_sdk::Client, RpcError> {
        self.session
            .current(|session| session.client.clone())
            .ok_or_else(|| RpcCode::NotLoggedIn.into())
    }

    pub(crate) async fn account_data_types(&self) -> Result<Vec<String>, RpcError> {
        let client = self.client().await?;
        let mut types = self.account_data_types.lock().await.clone();
        types.extend(
            self.with_open_stores(async || account_data::stored_types(&client).await)
                .await,
        );
        match account_data::server_types(&client, self.sync_presence().await).await {
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
            .account_data_types
            .lock()
            .await
            .insert(event_type.clone())
        {
            return;
        }
        let Ok(client) = self.client().await else {
            return;
        };
        let mut stored = account_data::stored_types(&client).await;
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
            .await?
            .account()
            .fetch_account_data(event_type)
            .await
            .or_failed(self, label)
    }

    pub(crate) async fn put_global_account_data(
        &self,
        event_type: GlobalAccountDataEventType,
        content: &impl serde::Serialize,
        label: &str,
    ) -> Result<(), RpcError> {
        let raw = serde_json::value::to_raw_value(content)
            .map(Raw::<AnyGlobalAccountDataEventContent>::from_json)
            .or_failed(self, label)?;

        self.client()
            .await?
            .account()
            .set_account_data_raw(event_type, raw)
            .await
            .or_failed(self, label)?;

        Ok(())
    }

    pub(crate) async fn push_rules(&self) -> Result<Arc<push_rules::PushRules>, RpcError> {
        let client = self.client().await?;
        let mut cached = self.push_rules.lock().await;
        if let Some(rules) = cached.as_ref() {
            return Ok(rules.clone());
        }
        let rules = self
            .with_open_stores(async || push_rules::PushRules::load(&client).await)
            .await;
        *cached = Some(rules.clone());
        Ok(rules)
    }

    pub(crate) async fn every_encrypted_event_pushed(&self) -> bool {
        match self.push_rules().await {
            Ok(rules) => rules.pushes_every_encrypted_event().await,
            Err(_) => false,
        }
    }

    #[expect(
        clippy::unused_async,
        clippy::unused_async_trait_impl,
        reason = "awaited at some 200 call sites, which a sync signature would all touch"
    )]
    pub(crate) async fn sync_service(
        &self,
    ) -> Result<Arc<matrix_sdk_ui::sync_service::SyncService>, RpcError> {
        self.session
            .current(|session| session.sync_service.clone())
            .ok_or_else(|| RpcCode::NotLoggedIn.into())
    }

    pub(crate) async fn room(&self, room_id: &OwnedRoomId) -> Result<matrix_sdk::Room, RpcError> {
        self.client()
            .await?
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
        let (core, _events) = Core::new(
            "to-device-inbox",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        let (release, released) = tokio::sync::oneshot::channel::<()>();
        let (done, mut finished) = mpsc::unbounded_channel();
        let first = done.clone();
        core.defer_to_device(Box::pin(async move {
            released.await.unwrap();
            first.send(1).unwrap();
        }));
        let second = done.clone();
        core.defer_to_device(Box::pin(async move {
            second.send(2).unwrap();
        }));
        tokio::task::yield_now().await;
        finished.try_recv().unwrap_err();
        release.send(()).unwrap();
        assert_eq!(finished.recv().await, Some(1));
        assert_eq!(finished.recv().await, Some(2));

        core.session_tasks.lock().clear();
        core.to_device_inbox.lock().take();
        core.defer_to_device(Box::pin(async move {
            done.send(3).unwrap();
        }));
        assert_eq!(finished.recv().await, Some(3));
    }

    struct FailingClearSessionStore;

    #[async_trait::async_trait]
    impl SessionStore for FailingClearSessionStore {
        async fn load(&self) -> Result<Option<Vec<u8>>, crate::store::StoreError> {
            Ok(None)
        }

        async fn save(&self, _bytes: Vec<u8>) -> Result<(), crate::store::StoreError> {
            Ok(())
        }

        async fn clear(&self) -> Result<(), crate::store::StoreError> {
            Err(crate::store::StoreError::Message(
                "storage unavailable".to_owned(),
            ))
        }
    }

    struct TestSessionStore {
        bytes: Arc<Mutex<Option<Vec<u8>>>>,
    }

    #[async_trait::async_trait]
    impl SessionStore for TestSessionStore {
        async fn load(&self) -> Result<Option<Vec<u8>>, crate::store::StoreError> {
            Ok(self.bytes.lock().await.clone())
        }

        async fn save(&self, bytes: Vec<u8>) -> Result<(), crate::store::StoreError> {
            *self.bytes.lock().await = Some(bytes);
            Ok(())
        }

        async fn clear(&self) -> Result<(), crate::store::StoreError> {
            *self.bytes.lock().await = None;
            Ok(())
        }
    }

    #[test]
    fn app_activity_gates_the_search_crawler() {
        let (core, _rx) = Core::new("test", Box::new(store::MemorySessionStore::default()));
        core.search_network.set_unmetered(true);
        assert!(core.search_crawl_active());

        core.set_app_active(false);
        assert!(!core.search_crawl_active());

        core.set_app_active(true);
        assert!(core.search_crawl_active());
        core.update_app_in_foreground(false);
        assert!(!core.search_crawl_active());
    }

    #[tokio::test]
    async fn commands_before_login_are_rejected() {
        let (core, _rx) = Core::new("test", Box::new(store::MemorySessionStore::default()));
        assert!(matches!(
            core.run(crate::api::timeline::SubscribeRoomListParams::default())
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
                matrix_sdk::ruma::api::error::UnknownTokenErrorData::new(),
            ),
            1,
        ));
        assert!(matches!(
            events.recv().await,
            Some(CoreEvent::SessionEnded { reason }) if reason == "token_rejected"
        ));
        assert_eq!(*bytes.lock().await, None);
    }

    #[tokio::test]
    async fn rejected_token_after_a_refresh_still_ends_the_session() {
        let (core, mut events) = Core::new("test", Box::new(store::MemorySessionStore::default()));
        let (changes, receiver) = tokio::sync::broadcast::channel(1);

        changes
            .send(matrix_sdk::SessionChange::TokensRefreshed)
            .unwrap();
        changes
            .send(matrix_sdk::SessionChange::UnknownToken(
                matrix_sdk::ruma::api::error::UnknownTokenErrorData::new(),
            ))
            .unwrap();
        core.watch_session_changes(receiver, 1);

        assert!(matches!(
            tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
                .await
                .ok()
                .flatten(),
            Some(CoreEvent::SessionEnded { reason }) if reason == "token_rejected"
        ));
    }

    #[tokio::test]
    async fn a_soft_logout_ends_the_session_with_its_own_reason() {
        let (core, mut events) = Core::new("test", Box::new(store::MemorySessionStore::default()));
        let (changes, receiver) = tokio::sync::broadcast::channel(1);

        let mut data = matrix_sdk::ruma::api::error::UnknownTokenErrorData::new();
        data.soft_logout = true;
        changes
            .send(matrix_sdk::SessionChange::UnknownToken(data))
            .unwrap();
        core.watch_session_changes(receiver, 1);

        assert!(matches!(
            tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
                .await
                .ok()
                .flatten(),
            Some(CoreEvent::SessionEnded { reason }) if reason == "soft_logout"
        ));
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
        core.mark_account_needs_reauth(Some("a1"), false)
            .await
            .unwrap();

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
            core.switch_account(crate::api::session::SwitchAccountParams {
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

        let logins = crate::credentials::LoginTokens::new(base.path());
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
        crate::credentials::LoginTokens::new(base.path())
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

#[cfg(all(test, not(target_family = "wasm")))]
mod sdk_timeline_tests;

#[cfg(all(test, not(target_family = "wasm")))]
mod sdk_spoiler_tests;

#[cfg(all(test, not(target_family = "wasm")))]
mod sdk_notification_tests;

#[cfg(all(test, not(target_family = "wasm")))]
mod sdk_helpers_tests;

#[cfg(all(test, not(target_family = "wasm")))]
mod live_member_tests;

#[cfg(all(test, not(target_family = "wasm")))]
mod sdk_verification_tests;
