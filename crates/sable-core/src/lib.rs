#![recursion_limit = "512"]

mod accounts;
mod auth;
mod bookmarks;
mod calls;
mod dispatch;
mod errors;
pub mod image_packs;
pub mod matrix_html;
mod media;
mod messages;
pub mod notifications;
mod personas;
pub mod polls;
pub mod profiles;
pub mod protocol;
mod registration;
mod rooms;
mod scheduled;
pub mod search;
pub mod session;
pub mod spaces;
pub mod store;
mod subscriptions;
mod timelines;
mod tls;
mod verification;
pub mod view;
mod watchers;
mod widgets;

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
};

use matrix_sdk::executor::AbortOnDrop;
use matrix_sdk::ruma::events::call::member::CallMemberStateKey;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};
use matrix_sdk_ui::timeline::Timeline;
use tokio::sync::{Mutex, RwLock, mpsc};
use url::Url;

use protocol::{CommandErr, CoreEvent, SubscriptionId};
use session::{AccountRegistry, Session};
use store::SessionStore;

pub(crate) type Task = AbortOnDrop<()>;

/// Owns every piece of Matrix state. A carrier only moves `Command`s in and
/// `CoreEvent`s out.
pub struct Core {
    store_id: String,
    sessions: Box<dyn SessionStore>,
    events: mpsc::UnboundedSender<CoreEvent>,
    next_subscription: AtomicU32,
    next_log_id: AtomicU64,
    next_timeline_access: AtomicU64,
    next_registration_attempt: AtomicU64,
    session_generation: AtomicU64,
    session_store_lock: Mutex<()>,
    session_swap_lock: Mutex<()>,
    restore_lock: Mutex<()>,
    accounts: Mutex<Option<AccountRegistry>>,
    session: RwLock<Option<Session>>,
    pending_login: Mutex<Option<PendingLogin>>,
    pending_registration: Mutex<Option<registration::PendingRegistration>>,
    session_tasks: std::sync::Mutex<Vec<Task>>,
    subscriptions: Mutex<HashMap<SubscriptionId, Subscription>>,
    room_subscription_lock: Mutex<()>,
    account_data_lock: Mutex<()>,
    account_data_types: Mutex<std::collections::BTreeSet<String>>,
    timelines: Mutex<HashMap<OwnedRoomId, CachedTimeline>>,
    thread_timelines: Mutex<HashMap<ThreadKey, CachedTimeline>>,
    notification_content: AtomicBool,
    search_index: Mutex<search::MessageIndex>,
    search_crawl: Mutex<search::CrawlProgress>,
    server_search: Mutex<search::ServerSearch>,
    foreground_paginations: AtomicU32,
    call_sessions: Mutex<HashMap<protocol::CallSessionId, CallSession>>,
}

struct CallSession {
    room_id: OwnedRoomId,
    state_key: CallMemberStateKey,
    delay_id: Option<String>,
    _postpone: Option<Task>,
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
    last_access: u64,
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
            notification_content: AtomicBool::new(false),
            next_subscription: AtomicU32::new(1),
            foreground_paginations: AtomicU32::new(0),
            next_log_id: AtomicU64::new(1),
            next_timeline_access: AtomicU64::new(1),
            next_registration_attempt: AtomicU64::new(1),
            session_generation: AtomicU64::new(1),
            session_store_lock: Mutex::new(()),
            session_swap_lock: Mutex::new(()),
            restore_lock: Mutex::new(()),
            accounts: Mutex::new(None),
            session: RwLock::new(None),
            pending_login: Mutex::new(None),
            pending_registration: Mutex::new(None),
            session_tasks: std::sync::Mutex::new(Vec::new()),
            subscriptions: Mutex::new(HashMap::new()),
            room_subscription_lock: Mutex::new(()),
            account_data_lock: Mutex::new(()),
            account_data_types: Mutex::new(std::collections::BTreeSet::new()),
            timelines: Mutex::new(HashMap::new()),
            thread_timelines: Mutex::new(HashMap::new()),
            search_index: Mutex::new(search::MessageIndex::new()),
            search_crawl: Mutex::new(search::CrawlProgress::default()),
            server_search: Mutex::new(search::ServerSearch::default()),
            call_sessions: Mutex::new(HashMap::new()),
        });
        (core, rx)
    }

    #[must_use]
    pub fn notification_content(&self) -> bool {
        self.notification_content.load(Ordering::Relaxed)
    }

    /// No carrier means no UI, and syncing continues, so a drop is not an error.
    pub fn emit(&self, event: CoreEvent) {
        let _ = self.events.send(event);
    }

    /// Session tasks must outlive their spawn call. Dropping `Task` aborts it.
    pub(crate) fn track_session_task(&self, task: Task) {
        self.session_tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(task);
    }

    pub(crate) fn emit_if_current(&self, generation: u64, event: CoreEvent) {
        if self.session_generation.load(Ordering::SeqCst) == generation {
            self.emit(event);
        }
    }

    pub(crate) fn foreground_paginations(&self) -> u32 {
        self.foreground_paginations.load(Ordering::Relaxed)
    }

    pub(crate) fn begin_foreground_pagination(self: &Arc<Self>) -> ForegroundPagination {
        self.foreground_paginations.fetch_add(1, Ordering::Relaxed);
        ForegroundPagination { core: self.clone() }
    }

    pub(crate) fn allocate_subscription(&self) -> SubscriptionId {
        SubscriptionId(self.next_subscription.fetch_add(1, Ordering::Relaxed))
    }

    pub(crate) fn next_timeline_access(&self) -> u64 {
        self.next_timeline_access.fetch_add(1, Ordering::Relaxed)
    }

    pub(crate) async fn accounts(&self) -> Result<AccountRegistry, CommandErr> {
        let mut accounts = self.accounts.lock().await;
        if let Some(accounts) = accounts.as_ref() {
            return Ok(accounts.clone());
        }

        let stored = self
            .sessions
            .load()
            .await
            .map_err(|error| self.failed("restore: read session file", error))?;
        let Some(bytes) = stored else {
            let registry = AccountRegistry::empty();
            *accounts = Some(registry.clone());
            return Ok(registry);
        };
        let (mut registry, migrated) = AccountRegistry::from_bytes(&bytes, &self.store_id)
            .map_err(|error| self.failed("restore: parse session file", error))?;
        let reanchored = registry.reanchor_stores(&self.store_id);
        if migrated || reanchored {
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

    pub(crate) async fn allocate_account(&self) -> Result<(String, String), CommandErr> {
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

    pub(crate) async fn client(&self) -> Result<matrix_sdk::Client, CommandErr> {
        let guard = self.session.read().await;
        Ok(guard
            .as_ref()
            .ok_or(CommandErr::NotLoggedIn)?
            .client
            .clone())
    }

    pub(crate) async fn account_data_types(&self) -> Result<Vec<String>, CommandErr> {
        Ok(self
            .account_data_types
            .lock()
            .await
            .iter()
            .cloned()
            .collect())
    }

    pub(crate) async fn remember_account_data_type(&self, event_type: impl Into<String>) {
        self.account_data_types
            .lock()
            .await
            .insert(event_type.into());
    }

    pub(crate) async fn sync_service(
        &self,
    ) -> Result<Arc<matrix_sdk_ui::sync_service::SyncService>, CommandErr> {
        let guard = self.session.read().await;
        Ok(guard
            .as_ref()
            .ok_or(CommandErr::NotLoggedIn)?
            .sync_service
            .clone())
    }

    pub(crate) async fn room(&self, room_id: &OwnedRoomId) -> Result<matrix_sdk::Room, CommandErr> {
        self.client()
            .await?
            .get_room(room_id)
            .ok_or(CommandErr::UnknownRoom)
    }
}

#[cfg(test)]
#[allow(clippy::large_futures)]
mod tests {
    use super::*;
    use crate::protocol::{Command, CommandErr};

    struct FailingClearSessionStore;

    #[async_trait::async_trait]
    impl SessionStore for FailingClearSessionStore {
        async fn load(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(None)
        }

        async fn save(&self, _bytes: Vec<u8>) -> Result<(), String> {
            Ok(())
        }

        async fn clear(&self) -> Result<(), String> {
            Err("storage unavailable".to_owned())
        }
    }

    struct TestSessionStore {
        bytes: Arc<Mutex<Option<Vec<u8>>>>,
    }

    #[async_trait::async_trait]
    impl SessionStore for TestSessionStore {
        async fn load(&self) -> Result<Option<Vec<u8>>, String> {
            Ok(self.bytes.lock().await.clone())
        }

        async fn save(&self, bytes: Vec<u8>) -> Result<(), String> {
            *self.bytes.lock().await = Some(bytes);
            Ok(())
        }

        async fn clear(&self) -> Result<(), String> {
            *self.bytes.lock().await = None;
            Ok(())
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

        assert!(!core.handle_session_change(&matrix_sdk::SessionChange::TokensRefreshed, 1));
        assert_eq!(*bytes.lock().await, Some(b"session".to_vec()));

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
}

#[cfg(all(test, not(target_family = "wasm")))]
#[allow(clippy::large_futures)]
mod sdk_timeline_tests;

#[cfg(test)]
#[allow(clippy::large_futures)]
mod live_tests {
    use super::*;
    use crate::protocol::{Command, CommandErr, CommandOk};

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
