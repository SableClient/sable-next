use matrix_sdk::Client;
use matrix_sdk::ruma::OwnedEventId;
use matrix_sdk::ruma::RoomId;
use matrix_sdk::ruma::events::room::encrypted::OriginalSyncRoomEncryptedEvent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::store::RoomLoadSettings;
use matrix_sdk_ui::notification_client::{
    NotificationClient, NotificationProcessSetup, NotificationStatus, RawNotificationEvent,
};

use super::push_cache;
use super::view::{
    NOISY_KEY, every_encrypted_event_pushed, is_rtc_invite, notifies, prepare_invite,
};
use crate::session::{AccountRegistry, PersistedAccount};
use crate::store::{FileSessionStore, SessionStore};

/// Resolve Android's app-data root to the session and SDK stores under `files`.
#[must_use]
pub fn cold_push_store_dir(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("files")
}

pub(super) fn push_account<'a>(
    accounts: &'a AccountRegistry,
    user_id: &str,
    device_id: &str,
) -> Option<&'a PersistedAccount> {
    accounts.accounts.iter().find(|account| {
        account.state.usable()
            && account.session.credentials.user_id() == user_id
            && account.session.credentials.device_id() == device_id
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum ColdPush {
    Clear(String),
    Discard,
    Unevaluated,
    NeedsKey { quietly: bool },
    Undecryptable,
}

/// Decrypt an Android push.
pub async fn decrypt_cold_push(
    data_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &str,
    event_json: &str,
    fetch_keys: bool,
) -> ColdPush {
    let store_dir = cold_push_store_dir(data_dir);
    let Some(host) = push_cache::cold_host(&store_dir, user_id, device_id).await else {
        return ColdPush::Undecryptable;
    };
    let decrypt = || {
        let key_fetch = if fetch_keys {
            host.key_fetch()
        } else {
            KeyFetch::Never
        };
        Box::pin(decrypt_push_event(
            host.client(),
            key_fetch,
            room_id,
            event_json,
        ))
    };
    let result = decrypt().await;
    match result {
        ColdPush::Undecryptable | ColdPush::NeedsKey { .. }
            if fetch_keys && host.refresh().await =>
        {
            decrypt().await
        }
        result => result,
    }
}

#[derive(Clone, Default)]
struct PendingRefreshes(std::sync::Arc<parking_lot::Mutex<Vec<tokio::task::JoinHandle<()>>>>);

tokio::task_local! {
    static PENDING_REFRESHES: PendingRefreshes;
}

pub async fn settle_refreshes<T>(operation: impl Future<Output = T>) -> T {
    let pending = PendingRefreshes::default();
    let result = PENDING_REFRESHES.scope(pending.clone(), operation).await;
    let tasks = std::mem::take(&mut *pending.0.lock());
    for task in tasks {
        let _ = task.await;
    }
    result
}

/// A notification operation owns refreshes separately from SDK background tasks.
pub struct PushClient {
    client: Client,
    /// Only a client opened without a `Core` refreshes; the app's own clients refresh themselves.
    refreshes: bool,
    _lease: Option<PushLease>,
}

pub(super) struct PushLease {
    lease: Option<crate::session::StoreLease>,
    evict: Option<(std::sync::Arc<crate::Core>, String)>,
}

impl PushLease {
    const fn plain(lease: crate::session::StoreLease) -> Self {
        Self {
            lease: Some(lease),
            evict: None,
        }
    }
}

impl Drop for PushLease {
    fn drop(&mut self) {
        drop(self.lease.take());
        let Some((core, account_id)) = self.evict.take() else {
            return;
        };
        if core.clients.give_back(&account_id) {
            // Ordered with switches, so a switch to this account keeps the client it finds.
            core.supervise_later("return a push client", move |core, _| {
                Box::pin(async move {
                    core.evict_idle_account_client(&account_id);
                })
            });
        }
    }
}

impl std::ops::Deref for PushClient {
    type Target = Client;

    fn deref(&self) -> &Self::Target {
        &self.client
    }
}

impl PushClient {
    /// Only OAuth refreshes, under the SDK's cross-process lock; the saved tokens
    /// are written by the session callbacks while that lock is held.
    async fn refresh(&self) -> bool {
        if !self.refreshes
            || self.client.oauth().full_session().is_none()
            || !self.token_rejected().await
        {
            return false;
        }
        let client = self.client.clone();
        let (sent, refreshed) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = sent.send(client.oauth().refresh_access_token().await.is_ok());
        });
        let _ = PENDING_REFRESHES.try_with(|pending| {
            pending.0.lock().push(task);
        });
        refreshed.await.unwrap_or(false)
    }

    async fn token_rejected(&self) -> bool {
        matches!(
            self.client.whoami().await,
            Err(error) if matches!(
                error.client_api_error_kind(),
                Some(ruma::api::error::ErrorKind::UnknownToken(_))
            )
        )
    }

    /// Retry a failed notification request once with refreshed credentials.
    ///
    /// # Errors
    /// Returns the request error when refresh is unavailable or the retry fails.
    pub async fn retry<T, E, F: Future<Output = Result<T, E>>>(
        &self,
        request: impl Fn() -> F,
    ) -> Result<T, E> {
        let result = request().await;
        if result.is_err() && self.refresh().await {
            request().await
        } else {
            result
        }
    }
}

/// Restore a notification login, rotating OAuth credentials under the SDK's cross-process lock.
pub async fn restore_push_client(
    store_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
) -> Option<PushClient> {
    let host = push_host(store_dir, user_id, device_id, RoomLoadSettings::default()).await?;
    Some(match host {
        PushHost::Live { client, lease, .. } | PushHost::Shared { client, lease } => PushClient {
            client,
            refreshes: false,
            _lease: Some(lease),
        },
        PushHost::Own(client) => client,
    })
}

/// The push sync's own connection, so the app's connections still receive those events live
/// once it opens.
const PUSH_SYNC_CONNECTION: &str = "push-sync";
const PUSH_SYNC_TIMELINE: u32 = 20;
/// Short, so a sync asked to stop finishes its request soon instead of being cut off mid-way.
const PUSH_SYNC_POLL: std::time::Duration = std::time::Duration::from_secs(1);
const PUSH_SYNC_NETWORK: std::time::Duration = std::time::Duration::from_secs(3);

/// Syncs the pushed room for a moment, so it is current when the notification is opened: on the
/// backgrounded app's own sync when the core runs this login, otherwise on a sync of that room
/// alone. Returns once everything stopped, within [`crate::push_sync::DEADLINE`].
pub async fn sync_on_push(
    data_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &str,
    event_id: Option<&str>,
    enabled: bool,
) {
    use crate::push_sync::{DEADLINE, GATE};

    let Ok(room_id) = ruma::OwnedRoomId::try_from(room_id) else {
        return;
    };
    let event_id = event_id.and_then(|id| OwnedEventId::try_from(id).ok());
    let login = format!("{user_id}|{device_id}");
    if !enabled || !GATE.try_start(&login) {
        return;
    }
    let deadline = tokio::time::Instant::now() + DEADLINE;
    let store_dir = cold_push_store_dir(data_dir);
    let (user_id, device_id) = (user_id.to_owned(), device_id.to_owned());
    // Spawned, so the gate is released even if the caller goes away.
    let sync = matrix_sdk::executor::spawn(async move {
        let completed = Box::pin(sync_room(
            &store_dir,
            &user_id,
            &device_id,
            &room_id,
            event_id.as_deref(),
            deadline,
        ))
        .await;
        GATE.finish(&login, completed);
    });
    let _ = sync.await;
}

pub(super) async fn sync_room(
    store_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &RoomId,
    event_id: Option<&ruma::EventId>,
    deadline: tokio::time::Instant,
) -> bool {
    match crate::Core::owning(store_dir) {
        Some(core) => {
            Box::pin(core_sync(
                &core, store_dir, user_id, device_id, room_id, event_id, deadline,
            ))
            .await
        }
        None => {
            Box::pin(own_sync(
                store_dir, user_id, device_id, room_id, event_id, deadline,
            ))
            .await
        }
    }
}

async fn core_sync(
    core: &std::sync::Arc<crate::Core>,
    store_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &RoomId,
    event_id: Option<&ruma::EventId>,
    deadline: tokio::time::Instant,
) -> bool {
    if core.activity.app_active() || !core.activity.network_available() {
        return false;
    }
    if let Ok(session) = core.signed_in()
        && is_login(session.client(), user_id, device_id)
    {
        return !core.activity.account_locked()
            && core
                .hold_sync_for_push(&session, room_id, event_id, deadline)
                .await;
    }
    // Another of the core's logins: its client is lent to the push, as for rendering.
    let mut loans_wanted = core.clients.loans_wanted();
    let release_by = deadline - crate::push_sync::STOP_WAIT;
    let Ok(Some(host)) = tokio::time::timeout_at(
        release_by,
        push_host(store_dir, user_id, device_id, RoomLoadSettings::default()),
    )
    .await
    else {
        return false;
    };
    let PushHost::Shared { client, .. } = &host else {
        return false;
    };
    // A switch or sign-out waiting for the loan ends the sync.
    let wanted = async move {
        let _ = loans_wanted.changed().await;
    };
    lean_sync(client, room_id, event_id, deadline, wanted).await
}

/// The app opening, or another push wanting the store, ends it at any step.
async fn own_sync(
    store_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_id: &RoomId,
    event_id: Option<&ruma::EventId>,
    deadline: tokio::time::Instant,
) -> bool {
    let release_by = deadline - crate::push_sync::STOP_WAIT;
    let Ok(Some(mut turn)) = tokio::time::timeout_at(
        release_by,
        push_cache::sync_turn(store_dir, user_id, device_id),
    )
    .await
    else {
        return false;
    };
    let wanted = turn.wanted();
    tokio::pin!(wanted);
    let open = tokio::time::timeout_at(
        release_by,
        open_saved_client(
            store_dir,
            user_id,
            device_id,
            crate::session::ClientRole::PushSync,
            RoomLoadSettings::default(),
        ),
    );
    let client = tokio::select! {
        client = open => client,
        () = &mut wanted => return false,
    };
    let Ok(Some(client)) = client else {
        return false;
    };
    // The client and its lease drop only once the sync stopped.
    lean_sync(&client, room_id, event_id, deadline, wanted).await
}

/// A sync of the pushed room alone, with the keys to decrypt it: no room list. Stops by
/// `deadline`, leaving the in-flight request at most [`crate::push_sync::STOP_WAIT`] to finish.
async fn lean_sync(
    client: &Client,
    room_id: &RoomId,
    event_id: Option<&ruma::EventId>,
    deadline: tokio::time::Instant,
    stop: impl Future<Output = ()>,
) -> bool {
    use ruma::api::client::sync::sync_events::msc4186::request;
    use ruma::events::StateEventType;

    let release_by = deadline - crate::push_sync::STOP_WAIT;
    let mut to_device = request::ToDevice::default();
    to_device.enabled = true;
    let mut e2ee = request::E2EE::default();
    e2ee.enabled = true;
    let Ok(builder) = client.sliding_sync(PUSH_SYNC_CONNECTION) else {
        return false;
    };
    let build = builder
        .poll_timeout(PUSH_SYNC_POLL)
        .network_timeout(PUSH_SYNC_NETWORK)
        // Without a saved position each push sync starts a new connection, on which the SDK
        // queries every tracked user's devices again.
        .share_pos()
        .with_to_device_extension(to_device)
        .with_e2ee_extension(e2ee)
        .build();
    let Ok(Ok(sync)) = tokio::time::timeout_at(release_by, build).await else {
        return false;
    };
    let mut subscription = request::RoomSubscription::default();
    subscription.timeline_limit = PUSH_SYNC_TIMELINE.into();
    subscription.required_state = [
        (StateEventType::RoomEncryption, ""),
        (StateEventType::RoomCreate, ""),
        (StateEventType::RoomPowerLevels, ""),
        (StateEventType::RoomName, ""),
        (StateEventType::RoomAvatar, ""),
        (StateEventType::RoomCanonicalAlias, ""),
        (StateEventType::RoomMember, "$LAZY"),
        (StateEventType::RoomMember, "$ME"),
    ]
    .into_iter()
    .map(|(kind, key)| (kind, key.to_owned()))
    .collect();
    sync.add_room_subscriptions(&[room_id], Some(subscription.clone()), false);

    let stopping = std::sync::atomic::AtomicBool::new(false);
    let ended = tokio::sync::Notify::new();
    // Never cut off mid-request: a response being handled then would still write after the
    // client is gone.
    let drive = async {
        let mut retried = false;
        while !stopping.load(std::sync::atomic::Ordering::SeqCst) {
            match sync.sync_once().await {
                Ok(_) => retried = false,
                // Only the SDK's sync stream resets an expired connection; this loop must too, or
                // every later push sync of this login would fail on the stored position.
                Err(error)
                    if error.client_api_error_kind()
                        == Some(&ruma::api::error::ErrorKind::UnknownPos) =>
                {
                    sync.expire_session().await;
                    sync.add_room_subscriptions(&[room_id], Some(subscription.clone()), false);
                }
                Err(_) if !retried => retried = true,
                Err(_) => break,
            }
        }
        ended.notify_one();
    };
    let wait = async {
        let until = release_by.min(tokio::time::Instant::now() + crate::push_sync::SYNC_WAIT);
        let arrived = tokio::select! {
            arrived = crate::push_sync::wait_for_event(client, room_id, event_id, until) => arrived,
            () = stop => false,
            () = ended.notified() => false,
        };
        stopping.store(true, std::sync::atomic::Ordering::SeqCst);
        arrived
    };
    tokio::pin!(drive, wait);
    let mut driven = false;
    let arrived = tokio::select! {
        arrived = &mut wait => arrived,
        () = &mut drive => {
            driven = true;
            wait.await
        }
    };
    if !driven {
        let stopped_by = deadline.min(tokio::time::Instant::now() + crate::push_sync::STOP_WAIT);
        let _ = tokio::time::timeout_at(stopped_by, drive).await;
    }
    arrived
}

pub(super) async fn open_push_client(
    store_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_load: RoomLoadSettings,
) -> Option<PushClient> {
    open_saved_client(
        store_dir,
        user_id,
        device_id,
        crate::session::ClientRole::Notification,
        room_load,
    )
    .await
}

async fn open_saved_client(
    store_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    role: crate::session::ClientRole,
    room_load: RoomLoadSettings,
) -> Option<PushClient> {
    let account = saved_push_account(store_dir, user_id, device_id).await?;
    let base_store = store_dir.to_str()?;
    // Held while the client lives, so a core opening this store waits for it to be dropped.
    let lease = crate::session::store_lease(&account.store_id).await;
    let client = crate::session::restore_notification_client(
        &account.store_id,
        &account.session,
        role,
        room_load,
        |client| install_push_session_callbacks(client, base_store, &account),
    )
    .await
    .ok()?;
    Some(PushClient {
        client,
        refreshes: true,
        _lease: Some(PushLease::plain(lease)),
    })
}

async fn saved_push_account(
    store_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
) -> Option<PersistedAccount> {
    let stored = FileSessionStore::new(store_dir).load().await.ok()??;
    let base_store = store_dir.to_str()?;
    let (mut accounts, _) = AccountRegistry::from_bytes(&stored, base_store).ok()?;
    accounts.reanchor_stores(base_store);
    let mut account = push_account(&accounts, user_id, device_id).cloned()?;
    let logins = crate::credentials::LoginTokens::new(store_dir);
    let (account_id, device_id) = (account.account_id.clone(), device_id.to_owned());
    let embedded = account.session.credentials.tokens();
    let (tokens, _) = tokio::task::spawn_blocking(move || {
        logins.read_or_migrate(&account_id, &device_id, &embedded)
    })
    .await
    .ok()?
    .ok()?
    .ok()?;
    account.session.credentials.set_tokens(tokens);
    Some(account)
}

pub(super) enum PushHost {
    Live {
        client: Client,
        sync_service: std::sync::Arc<matrix_sdk_ui::sync_service::SyncService>,
        lease: PushLease,
    },
    Shared {
        client: Client,
        lease: PushLease,
    },
    Own(PushClient),
}

impl PushHost {
    pub(super) fn client(&self) -> &Client {
        match self {
            Self::Live { client, .. } | Self::Shared { client, .. } => client,
            Self::Own(push) => push,
        }
    }

    pub(super) fn key_fetch(&self) -> KeyFetch {
        match self {
            Self::Live { sync_service, .. } => KeyFetch::Live(sync_service.clone()),
            _ => KeyFetch::Cold,
        }
    }

    pub(super) async fn refresh(&self) -> bool {
        match self {
            Self::Own(push) => push.refresh().await,
            _ => false,
        }
    }

    pub(super) async fn retry<T, E, F: Future<Output = Result<T, E>>>(
        &self,
        request: impl Fn() -> F,
    ) -> Result<T, E> {
        match self {
            Self::Own(push) => push.retry(request).await,
            _ => request().await,
        }
    }
}

const LEND_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
pub(super) const ACCOUNT_DATA_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// A core in this process opens the client, so a store never has two there. Without one, the
/// push opens its own and never waits for, or blocks, the app.
pub(super) async fn push_host(
    store_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_load: RoomLoadSettings,
) -> Option<PushHost> {
    let Some(core) = crate::Core::owning(store_dir) else {
        return open_push_client(store_dir, user_id, device_id, room_load)
            .await
            .map(PushHost::Own);
    };
    let (user, device) = (user_id.to_owned(), device_id.to_owned());
    let abandoned = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Queued behind a restore or switch in progress, so the push finds the session they start.
    let lent = core.supervise("lend a client to a push", {
        let abandoned = abandoned.clone();
        move |core, supervised| {
            Box::pin(async move {
                if abandoned.load(std::sync::atomic::Ordering::SeqCst) {
                    return None;
                }
                lend_push_host(&core, &supervised, &user, &device).await
            })
        }
    });
    let Ok(host) = matrix_sdk::timeout::timeout(Box::pin(lent), LEND_WAIT).await else {
        // The push is over by the time a busy queue gets to it, so it opens nothing then.
        abandoned.store(true, std::sync::atomic::Ordering::SeqCst);
        return None;
    };
    let host = host.ok()??;
    if let PushHost::Shared { client, .. } = &host {
        // Bounded: the loan this push holds keeps lifecycle changes waiting.
        matrix_sdk::timeout::timeout(
            Box::pin(client.set_presence(ruma::presence::PresenceState::Offline, None, false)),
            LEND_WAIT,
        )
        .await
        .ok()?
        .ok()?;
    }
    Some(host)
}

async fn lend_push_host(
    core: &std::sync::Arc<crate::Core>,
    supervised: &crate::supervisor::Supervised<'_>,
    user_id: &str,
    device_id: &str,
) -> Option<PushHost> {
    if let Some(host) = live_push_host(core, supervised, user_id, device_id) {
        return Some(host);
    }
    if !*core.activity.subscribe_stores().borrow() {
        return None;
    }
    let accounts = core.accounts().await.ok()?;
    let account = push_account(&accounts, user_id, device_id)?;
    core.saved_account_client(supervised, account).await.ok()?;
    let client = core.clients.lend(supervised, &account.account_id)?;
    let lease = PushLease {
        lease: None,
        evict: Some((core.clone(), account.account_id.clone())),
    };
    Some(PushHost::Shared { client, lease })
}

#[expect(
    clippy::disallowed_methods,
    reason = "lends the active session's client to a push"
)]
fn live_push_host(
    core: &std::sync::Arc<crate::Core>,
    supervised: &crate::supervisor::Supervised<'_>,
    user_id: &str,
    device_id: &str,
) -> Option<PushHost> {
    let (client, sync_service, account_id) = core
        .session
        .current(|session| {
            is_login(&session.client, user_id, device_id).then(|| {
                (
                    session.client.clone(),
                    session.sync_service.clone(),
                    session.account_id.clone(),
                )
            })
        })
        .flatten()?;
    core.clients.count_loan(supervised, &account_id);
    Some(PushHost::Live {
        client,
        sync_service,
        lease: PushLease {
            lease: None,
            evict: Some((core.clone(), account_id)),
        },
    })
}

fn is_login(client: &Client, user_id: &str, device_id: &str) -> bool {
    client.user_id().is_some_and(|id| id == user_id)
        && client.device_id().is_some_and(|id| id == device_id)
}

/// Synchronous, as the SDK calls them inside a refresh, possibly on a single-threaded runtime.
fn install_push_session_callbacks(client: &Client, base_store: &str, account: &PersistedAccount) {
    let base_store = std::path::Path::new(base_store);
    let device_id = account.session.credentials.device_id();
    let reload = {
        let logins = crate::credentials::LoginTokens::new(base_store);
        let (account_id, device_id) = (account.account_id.clone(), device_id.clone());
        move |_: Client| {
            let tokens = logins
                .read(&account_id, &device_id)?
                .map_err(|_| "this login has no saved tokens")?;
            if tokens.access_token.is_empty() {
                return Err("saved login access token is empty".into());
            }
            Ok(tokens)
        }
    };
    let save = {
        let logins = crate::credentials::LoginTokens::new(base_store);
        let account_id = account.account_id.clone();
        move |client: Client| {
            let tokens = client
                .session_tokens()
                .ok_or(crate::store::StoreError::Invalid(
                    "the refreshed client has no tokens",
                ))?;
            logins
                .save(&account_id, &device_id, &tokens)
                .map_err(Into::into)
        }
    };
    if let Err(error) = client.set_session_callbacks(Box::new(reload), Box::new(save)) {
        tracing::error!("could not install push session callbacks: {error}");
    }
}

pub(super) enum KeyFetch {
    Never,
    Live(std::sync::Arc<matrix_sdk_ui::sync_service::SyncService>),
    Cold,
}

pub(super) async fn decrypt_push_event(
    client: &Client,
    key_fetch: KeyFetch,
    room_id: &str,
    event_json: &str,
) -> ColdPush {
    let every_encrypted = every_encrypted_event_pushed(client).await;
    let undecryptable = if every_encrypted {
        ColdPush::Discard
    } else {
        ColdPush::Undecryptable
    };
    let Ok(room_id) = RoomId::parse(room_id) else {
        return ColdPush::Undecryptable;
    };
    let Some(room) = client.get_room(&room_id) else {
        return ColdPush::Undecryptable;
    };
    let Ok(event) = Raw::<OriginalSyncRoomEncryptedEvent>::from_json_string(event_json.to_owned())
    else {
        return ColdPush::Undecryptable;
    };
    if let Ok(Some(sender)) = event.get_field::<ruma::OwnedUserId>("sender")
        && client.is_user_ignored(&sender).await
    {
        return ColdPush::Discard;
    }
    if let Err(error) = crate::rooms::fill_own_member(&room).await {
        tracing::debug!("could not load the own member before decrypting: {error}");
    }
    let push_context = room.push_context().await.ok().flatten();
    let Ok(decrypted) = room.decrypt_event(&event, push_context.as_ref()).await else {
        return undecryptable;
    };

    match &decrypted.kind {
        matrix_sdk::deserialized_responses::TimelineEventKind::Decrypted(clear) => {
            return decrypted_push(
                &room,
                &clear.event,
                decrypted.push_actions(),
                every_encrypted,
            )
            .await;
        }
        matrix_sdk::deserialized_responses::TimelineEventKind::UnableToDecrypt {
            utd_info, ..
        } if utd_info.reason.is_missing_room_key() => {}
        matrix_sdk::deserialized_responses::TimelineEventKind::UnableToDecrypt { .. }
        | matrix_sdk::deserialized_responses::TimelineEventKind::PlainText { .. } => {
            return undecryptable;
        }
    }

    let sync_service = match key_fetch {
        KeyFetch::Never => {
            return ColdPush::NeedsKey {
                quietly: every_encrypted,
            };
        }
        KeyFetch::Live(sync_service) => sync_service,
        KeyFetch::Cold => match crate::session::build_sync(client.clone()).await {
            Ok(sync_service) => sync_service,
            Err(_) => return undecryptable,
        },
    };
    let Some(event_id) = event.get_field::<OwnedEventId>("event_id").ok().flatten() else {
        return undecryptable;
    };
    let setup = NotificationProcessSetup::SingleProcess { sync_service };
    let Ok(notifications) = NotificationClient::new(client.clone(), setup).await else {
        return undecryptable;
    };
    match super::view::related_notification(&notifications, client, &room_id, &event_id).await {
        Ok(NotificationStatus::Event(item)) if item.actions.is_none() && every_encrypted => {
            ColdPush::Unevaluated
        }
        Ok(NotificationStatus::Event(item))
            if item
                .actions
                .as_deref()
                .is_some_and(|actions| !notifies(actions)) =>
        {
            ColdPush::Discard
        }
        Ok(NotificationStatus::Event(item)) => match item.raw_event {
            RawNotificationEvent::Timeline(clear)
                if clear.get_field::<String>("type").ok().flatten().as_deref()
                    != Some("m.room.encrypted") =>
            {
                let noisy = item.is_noisy == Some(true) || item.has_mention == Some(true);
                prepared_push_event(&room, clear.json().get(), noisy).await
            }
            _ => undecryptable,
        },
        Ok(NotificationStatus::EventFilteredOut | NotificationStatus::EventRedacted) => {
            ColdPush::Discard
        }
        Ok(NotificationStatus::EventNotFound) | Err(_) => undecryptable,
    }
}

async fn decrypted_push(
    room: &matrix_sdk::Room,
    clear: &Raw<ruma::events::AnyTimelineEvent>,
    actions: Option<&[ruma::push::Action]>,
    every_encrypted: bool,
) -> ColdPush {
    let actions = match actions {
        Some(actions) => {
            Some(crate::push_rules::related_actions(room, clear, actions.to_vec()).await)
        }
        None => None,
    };
    match actions.as_deref() {
        None if every_encrypted => ColdPush::Unevaluated,
        None => prepared_push_event(room, clear.json().get(), false).await,
        Some(actions) if notifies(actions) => {
            let noisy = actions
                .iter()
                .any(|action| action.sound().is_some() || action.is_highlight());
            prepared_push_event(room, clear.json().get(), noisy).await
        }
        Some(_) => ColdPush::Discard,
    }
}

pub(super) async fn prepared_push_event(
    room: &matrix_sdk::Room,
    clear: &str,
    noisy: bool,
) -> ColdPush {
    let Ok(mut event) = serde_json::from_str::<serde_json::Value>(clear) else {
        return ColdPush::Undecryptable;
    };
    if !is_rtc_invite(&event) {
        return ColdPush::Clear(marked_noisy(clear, noisy));
    }
    if !prepare_invite(room, &mut event).await {
        return ColdPush::Discard;
    }
    let Ok(clear) = serde_json::to_string(&event) else {
        return ColdPush::Undecryptable;
    };
    ColdPush::Clear(marked_noisy(&clear, noisy))
}

fn marked_noisy(clear: &str, noisy: bool) -> String {
    if !noisy {
        return clear.to_owned();
    }
    let Ok(mut event) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(clear)
    else {
        return clear.to_owned();
    };
    event.insert(NOISY_KEY.to_owned(), true.into());
    serde_json::to_string(&event).unwrap_or_else(|_| clear.to_owned())
}
