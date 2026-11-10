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
        !account.needs_reauth
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

pub async fn settle_refreshes<T>(operation: impl std::future::Future<Output = T>) -> T {
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
    _lease: Option<crate::session::StoreLease>,
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
                Some(matrix_sdk::ruma::api::error::ErrorKind::UnknownToken(_))
            )
        )
    }

    /// Retry a failed notification request once with refreshed credentials.
    ///
    /// # Errors
    /// Returns the request error when refresh is unavailable or the retry fails.
    pub async fn retry<T, E, F: std::future::Future<Output = Result<T, E>>>(
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
        PushHost::Live { client, .. } => PushClient {
            client,
            refreshes: false,
            _lease: None,
        },
        PushHost::Shared { client, lease } => PushClient {
            client,
            refreshes: false,
            _lease: Some(lease),
        },
        PushHost::Own(client) => client,
    })
}

pub(super) async fn open_push_client(
    store_dir: &std::path::Path,
    user_id: &str,
    device_id: &str,
    room_load: RoomLoadSettings,
) -> Option<PushClient> {
    let account = saved_push_account(store_dir, user_id, device_id).await?;
    let base_store = store_dir.to_str()?;
    // Held while the client lives, so a core opening this store waits for it to be dropped.
    let lease = crate::session::store_lease(&account.store_id).await;
    let client = crate::session::restore_notification_client(
        &account.store_id,
        &account.session,
        room_load,
        |client| install_push_session_callbacks(client, base_store, &account),
    )
    .await
    .ok()?;
    Some(PushClient {
        client,
        refreshes: true,
        _lease: Some(lease),
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
    .ok()?;
    account.session.credentials.set_tokens(tokens);
    Some(account)
}

pub(super) enum PushHost {
    Live {
        client: Client,
        sync_service: std::sync::Arc<matrix_sdk_ui::sync_service::SyncService>,
    },
    Shared {
        client: Client,
        lease: crate::session::StoreLease,
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

    pub(super) async fn retry<T, E, F: std::future::Future<Output = Result<T, E>>>(
        &self,
        request: impl Fn() -> F,
    ) -> Result<T, E> {
        match self {
            Self::Own(push) => push.retry(request).await,
            _ => request().await,
        }
    }
}

const RESTORE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
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
    let _ = tokio::time::timeout(RESTORE_WAIT, core.lifecycle.restoring()).await;
    if let Some(host) = live_push_host(&core, user_id, device_id).await {
        return Some(host);
    }
    let accounts = core.accounts().await.ok()?;
    let account = push_account(&accounts, user_id, device_id)?;
    let lease = crate::session::store_lease(&account.store_id).await;
    if let Some(host) = live_push_host(&core, user_id, device_id).await {
        return Some(host);
    }
    let client = core.saved_account_client(account, &lease).await.ok()?;
    client
        .set_presence(
            matrix_sdk::ruma::presence::PresenceState::Offline,
            None,
            false,
        )
        .await
        .ok()?;
    Some(PushHost::Shared { client, lease })
}

async fn live_push_host(core: &crate::Core, user_id: &str, device_id: &str) -> Option<PushHost> {
    core.session
        .read()
        .await
        .as_ref()
        .filter(|session| is_login(&session.client, user_id, device_id))
        .map(|session| PushHost::Live {
            client: session.client.clone(),
            sync_service: session.sync_service.clone(),
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
                .ok_or("this login has no saved tokens")?;
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
    if let Ok(Some(sender)) = event.get_field::<matrix_sdk::ruma::OwnedUserId>("sender")
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
    clear: &Raw<matrix_sdk::ruma::events::AnyTimelineEvent>,
    actions: Option<&[matrix_sdk::ruma::push::Action]>,
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
