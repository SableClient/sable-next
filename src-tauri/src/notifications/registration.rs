#[cfg(target_os = "android")]
use super::android::declare_push_accounts;
#[cfg(mobile)]
use super::gateway::{
    is_direct_pusher, pusher, register_with_distributor, registration_gateway, server_web_pusher,
};
#[cfg(mobile)]
use sable_core::api::push::WebPusherView;
use sable_core::protocol::{RpcCode, RpcError};
use tauri::{AppHandle, Runtime};
#[cfg(mobile)]
use tauri_plugin_notifications::NotificationsExt;

pub(super) static PUSH_REGISTRATION_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

#[derive(Debug, serde::Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
#[cfg_attr(
    not(mobile),
    expect(dead_code, reason = "only a mobile registration can fail")
)]
pub(crate) enum PushRegistrationError {
    NoSession,
    Capabilities,
    Platform { message: String },
    NoGateway,
    NoAppId,
    Homeserver { error: RpcError },
    Ledger,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(super) struct RegisteredPusher {
    pub(super) user_id: String,
    pub(super) device_id: String,
    pub(super) pushkey: String,
    pub(super) app_id: String,
    #[serde(default)]
    pub(super) gateway: Option<String>,
    #[serde(default)]
    pub(super) event_id_only: bool,
    #[serde(default)]
    pub(super) instance: Option<String>,
}

fn push_store<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, RpcError> {
    use tauri::Manager;
    app.try_state::<PushStore>()
        .map(|store| store.0.clone())
        .ok_or_else(|| RpcCode::Unavailable.into())
}

pub(crate) struct PushStore(pub std::path::PathBuf);

pub(super) fn registered_pushers(
    root: &std::path::Path,
) -> Result<Vec<RegisteredPusher>, RpcError> {
    match std::fs::read(root.join("pushers.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| RpcCode::Unavailable.into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(RpcCode::Unavailable.into()),
    }
}

#[derive(serde::Serialize)]
pub(crate) struct DevicePusher {
    pushkey: String,
    app_id: String,
}

/// # Errors
///
/// When the pusher ledger cannot be read.
pub(crate) fn device_pusher<R: Runtime>(
    app: &AppHandle<R>,
    user_id: &str,
    device_id: &str,
) -> Result<Option<DevicePusher>, RpcError> {
    Ok(registered_pushers(&push_store(app)?)?
        .into_iter()
        .rev()
        .find(|pusher| pusher.user_id == user_id && pusher.device_id == device_id)
        .map(|pusher| DevicePusher {
            pushkey: pusher.pushkey,
            app_id: pusher.app_id,
        }))
}

fn save_pushers(root: &std::path::Path, pushers: &[RegisteredPusher]) -> Result<(), RpcError> {
    std::fs::create_dir_all(root).map_err(|_| RpcCode::Unavailable)?;
    let bytes = serde_json::to_vec(pushers).map_err(|_| RpcCode::Unavailable)?;
    sable_core::store::write_atomic(&root.join("pushers.json"), &bytes)
        .map_err(|_| RpcCode::Unavailable.into())
}

async fn remove_saved_pusher(
    root: &std::path::Path,
    pusher: &RegisteredPusher,
) -> Result<(), RpcError> {
    let client = pusher_client(root, pusher).await?;
    client
        .retry(|| {
            sable_core::notifications::remove_pusher(
                &client,
                pusher.pushkey.clone(),
                pusher.app_id.clone(),
            )
        })
        .await
        .map_err(|_| RpcCode::Unavailable.into())
}

pub(super) async fn pusher_client(
    root: &std::path::Path,
    pusher: &RegisteredPusher,
) -> Result<sable_core::notifications::PushClient, RpcError> {
    sable_core::notifications::restore_push_client(root, &pusher.user_id, &pusher.device_id)
        .await
        .ok_or_else(|| RpcCode::Unavailable.into())
}

#[derive(serde::Deserialize)]
#[cfg_attr(
    not(mobile),
    expect(dead_code, reason = "only a mobile build registers a pusher")
)]
pub(crate) struct PushAccount {
    pub user_id: String,
    pub device_id: String,
}

/// Resolved by the webview, so the binary bakes no gateway of its own.
#[derive(serde::Deserialize)]
#[cfg_attr(
    not(mobile),
    expect(dead_code, reason = "only a mobile build registers a pusher")
)]
pub(crate) struct PushConfig {
    pub gateway_url: String,
    #[serde(default)]
    pub gateway_override: bool,
    pub vapid_key: String,
    pub web_app_id: String,
    pub event_id_only: bool,
    pub user_id: Option<String>,
    pub device_id: Option<String>,
    #[serde(default)]
    pub accounts: Vec<PushAccount>,
    /// Absent when the reader has retargeted the gateway: a token distributor
    /// needs an app id that gateway serves, and only the deployment names one.
    pub native_app_id: Option<String>,
    #[serde(default)]
    pub ios_app_id: Option<String>,
    #[serde(default)]
    pub unified_push_gateway_url: Option<String>,
    #[serde(default)]
    pub embedded_gateway_url: Option<String>,
    #[serde(default)]
    pub provider: Option<tauri_plugin_notifications::PushProvider>,
}

/// # Errors
///
/// When the platform refuses a push registration, or the homeserver rejects the
/// pusher the distributor asked for.
#[cfg(mobile)]
pub(crate) async fn register_push<R: Runtime>(
    app: &AppHandle<R>,
    config: PushConfig,
) -> Result<(), PushRegistrationError> {
    #[cfg(target_os = "ios")]
    let config = PushConfig {
        event_id_only: true,
        ..config
    };
    let _guard = PUSH_REGISTRATION_LOCK.lock().await;
    let root = push_store(app).map_err(|_| PushRegistrationError::Ledger)?;
    let (Some(user_id), Some(device_id)) = (&config.user_id, &config.device_id) else {
        return Err(PushRegistrationError::NoSession);
    };
    let current = (user_id.clone(), device_id.clone());
    #[cfg(target_os = "android")]
    declare_push_accounts(app, &config, &current).await;
    let accounts: std::collections::BTreeSet<_> = config
        .accounts
        .iter()
        .map(|account| (account.user_id.clone(), account.device_id.clone()))
        .chain(std::iter::once(current))
        .collect();
    let mut failure = None;
    for identity in accounts {
        if let Err(error) = register_account_push(app, &config, &root, &identity).await {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

#[cfg(mobile)]
async fn register_account_push<R: Runtime>(
    app: &AppHandle<R>,
    config: &PushConfig,
    root: &std::path::Path,
    identity: &(String, String),
) -> Result<(), PushRegistrationError> {
    use sable_core::api::push::PusherView;
    let client = sable_core::notifications::restore_push_client(root, &identity.0, &identity.1)
        .await
        .ok_or(PushRegistrationError::NoSession)?;

    // MSC4174 makes the homeserver the push gateway. Query before creating the
    // subscription because the distributor must bind it to the server's VAPID key.
    let server_vapid = if config.gateway_override || cfg!(target_os = "ios") {
        None
    } else {
        client
            .retry(|| sable_core::webpush::support(&client))
            .await
            .map_err(|_| PushRegistrationError::Capabilities)?
    };
    let was_direct = registered_pushers(root).is_ok_and(|pushers| {
        pushers.iter().any(|entry| {
            entry.belongs_to(&identity.0, &identity.1) && is_direct_pusher(&entry.app_id)
        })
    });
    let (registration, distributor_gateway) =
        register_with_distributor(app, config, server_vapid.as_deref(), identity, was_direct)
            .await?;
    let instance = registration.instance.clone();
    if server_vapid.is_some()
        && let Some(pusher) = server_web_pusher(&registration, config.event_id_only)
    {
        return Box::pin(register_server_pusher(
            app,
            &client,
            root,
            identity,
            pusher,
            config.event_id_only,
            instance,
        ))
        .await;
    }

    let gateway_url = match distributor_gateway {
        Some(gateway) => gateway,
        None => registration_gateway(&registration, config)
            .ok_or_else(|| {
                log::warn!("no UnifiedPush gateway is configured for this distributor");
                PushRegistrationError::NoGateway
            })?
            .to_owned(),
    };

    let Some((app_id, pushkey, web_push)) = pusher(
        registration,
        if cfg!(target_os = "ios") {
            config.ios_app_id.as_deref()
        } else {
            config.native_app_id.as_deref()
        },
        Some(&config.web_app_id),
    ) else {
        return Err(PushRegistrationError::NoAppId);
    };

    // Anyone who knows the endpoint can read and forge a plain push.
    let event_id_only = config.event_id_only || is_direct_pusher(&app_id);
    let pusher = PusherView {
        pushkey: pushkey.clone(),
        app_id: app_id.clone(),
        url: gateway_url.clone(),
        device_display_name: format!("Sable on {}", std::env::consts::OS),
        web_push,
        event_id_only,
        append: true,
    };

    client
        .retry(|| sable_core::notifications::set_pusher(&client, pusher.clone()))
        .await
        .map_err(|error| PushRegistrationError::Homeserver {
            error: error.into_rpc("register_pusher", RpcCode::Unavailable),
        })?;
    remember_pusher(
        root,
        identity,
        pushkey,
        app_id,
        Some(gateway_url),
        event_id_only,
        instance,
    )
    .map_err(|_| PushRegistrationError::Ledger)?;
    retire_account_pushers(app, root, identity).await;
    Ok(())
}

#[cfg(mobile)]
async fn register_server_pusher<R: Runtime>(
    app: &AppHandle<R>,
    client: &sable_core::notifications::PushClient,
    root: &std::path::Path,
    identity: &(String, String),
    pusher: WebPusherView,
    event_id_only: bool,
    instance: Option<String>,
) -> Result<(), PushRegistrationError> {
    let pushkey = pusher.pushkey.clone();
    let app_id = pusher.app_id.clone();
    if let Err(error) = client
        .retry(|| sable_core::webpush::set_pusher(client, pusher.clone()))
        .await
    {
        log::warn!("homeserver rejected the MSC4174 pusher: {error}");
        return Err(PushRegistrationError::Homeserver {
            error: error.into_rpc("register_web_pusher", RpcCode::Unavailable),
        });
    }
    log::debug!("registered an MSC4174 pusher through the homeserver");
    remember_pusher(
        root,
        identity,
        pushkey,
        app_id,
        None,
        event_id_only,
        instance,
    )
    .map_err(|_| PushRegistrationError::Ledger)?;
    retire_account_pushers(app, root, identity).await;
    Ok(())
}

#[cfg(any(mobile, test))]
pub(super) fn remember_pusher(
    root: &std::path::Path,
    identity: &(String, String),
    pushkey: String,
    app_id: String,
    gateway: Option<String>,
    event_id_only: bool,
    instance: Option<String>,
) -> Result<(), RpcError> {
    let mut pushers = registered_pushers(root)?;
    pushers.retain(|p| {
        !(p.user_id == identity.0
            && p.device_id == identity.1
            && p.pushkey == pushkey
            && p.app_id == app_id)
    });
    pushers.push(RegisteredPusher {
        user_id: identity.0.clone(),
        device_id: identity.1.clone(),
        pushkey,
        app_id,
        gateway,
        event_id_only,
        instance,
    });
    save_pushers(root, &pushers)
}

#[cfg(any(mobile, test))]
fn stale_pusher(pushers: &[RegisteredPusher], identity: &(String, String)) -> Option<usize> {
    let mut mine = pushers
        .iter()
        .enumerate()
        .filter(|(_, pusher)| pusher.user_id == identity.0 && pusher.device_id == identity.1)
        .map(|(index, _)| index);
    let first = mine.next()?;
    mine.next().map(|_| first)
}

#[cfg(any(mobile, test))]
pub(super) async fn retire_old_pushers(root: &std::path::Path, identity: &(String, String)) {
    let Ok(mut pushers) = registered_pushers(root) else {
        return;
    };
    loop {
        let Some((index, stale)) = stale_pusher(&pushers, identity)
            .and_then(|index| Some((index, pushers.get(index)?.clone())))
        else {
            return;
        };
        if remove_saved_pusher(root, &stale).await.is_err() {
            return;
        }
        pushers.remove(index);
        if save_pushers(root, &pushers).is_err() {
            return;
        }
    }
}

impl RegisteredPusher {
    #[cfg(any(target_os = "android", test))]
    pub(super) fn subscription(&self) -> &str {
        self.instance.as_deref().unwrap_or("default")
    }

    pub(super) fn belongs_to(&self, user_id: &str, device_id: &str) -> bool {
        self.user_id == user_id && self.device_id == device_id
    }

    #[cfg(any(target_os = "android", test))]
    pub(super) fn accepts_rotation(
        &self,
        instance: Option<&str>,
        legacy_identity: Option<(&str, &str)>,
    ) -> bool {
        instance.map_or_else(
            || {
                self.instance.is_none()
                    && legacy_identity.is_some_and(|(user, device)| self.belongs_to(user, device))
            },
            |instance| self.subscription() == instance,
        )
    }
}

#[cfg(any(target_os = "android", test))]
fn unused_subscriptions<'a>(
    before: &'a [RegisteredPusher],
    remaining: &[RegisteredPusher],
) -> std::collections::BTreeSet<&'a str> {
    before
        .iter()
        .map(RegisteredPusher::subscription)
        .filter(|instance| {
            !remaining
                .iter()
                .any(|pusher| pusher.subscription() == *instance)
        })
        .collect()
}

#[cfg(mobile)]
async fn retire_account_pushers<R: Runtime>(
    app: &AppHandle<R>,
    root: &std::path::Path,
    identity: &(String, String),
) {
    #[cfg(target_os = "android")]
    let before = registered_pushers(root).ok();
    retire_old_pushers(root, identity).await;
    #[cfg(target_os = "android")]
    if let (Some(before), Ok(remaining)) = (before, registered_pushers(root))
        && let Err(error) = retire_unused_subscriptions(app, &before, &remaining).await
    {
        log::warn!("could not retire a push subscription: {error:?}");
    }
    #[cfg(not(target_os = "android"))]
    let _ = app;
}

#[cfg(target_os = "android")]
async fn retire_unused_subscriptions<R: Runtime>(
    app: &AppHandle<R>,
    before: &[RegisteredPusher],
    remaining: &[RegisteredPusher],
) -> Result<(), RpcError> {
    for instance in unused_subscriptions(before, remaining) {
        app.notifications()
            .unregister_push_instance(instance)
            .await
            .map_err(|_| RpcCode::Unavailable)?;
    }
    Ok(())
}

/// # Errors
///
/// When the homeserver refuses to delete the pusher.
pub(crate) async fn unregister_push<R: Runtime>(
    app: &AppHandle<R>,
    user_id: Option<&str>,
    device_id: Option<&str>,
) -> Result<(), RpcError> {
    let identity = match (user_id, device_id) {
        (Some(user), Some(device)) => Some((user, device)),
        (None, None) => None,
        _ => return Err(RpcCode::Denied.into()),
    };
    let _guard = PUSH_REGISTRATION_LOCK.lock().await;
    let root = push_store(app)?;
    let before = registered_pushers(&root)?;
    let keep = |pusher: &RegisteredPusher| {
        identity.is_some_and(|(user, device)| !pusher.belongs_to(user, device))
    };
    let remaining: Vec<_> = before
        .iter()
        .filter(|pusher| keep(pusher))
        .cloned()
        .collect();
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_sable_push::{Account, SablePushExt};
        let accounts: Vec<_> = remaining
            .iter()
            .map(|pusher| (pusher.user_id.clone(), pusher.device_id.clone()))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .map(|(user_id, device_id)| Account { user_id, device_id })
            .collect();
        let push = app.sable_push();
        push.set_accounts(&accounts)
            .await
            .map_err(|_| RpcCode::Unavailable)?;
        if accounts.is_empty() {
            push.dismiss_all().await.map_err(|_| RpcCode::Unavailable)?;
        }
    }
    save_pushers(&root, &remaining)?;
    #[cfg(mobile)]
    if remaining.is_empty() {
        app.notifications()
            .unregister_for_push_notifications()
            .await
            .map_err(|_| RpcCode::Unavailable)?;
    }
    #[cfg(target_os = "android")]
    if !remaining.is_empty() {
        retire_unused_subscriptions(app, &before, &remaining).await?;
    }
    let mut result = Ok(());
    for pusher in before.iter().filter(|pusher| !keep(pusher)) {
        if let Err(error) = remove_saved_pusher(&root, pusher).await {
            result = Err(error);
        }
    }
    result
}

/// A host build, which only lints and tests the crate, has no distributor to
/// register with.
///
/// # Errors
///
/// Never; the signature mirrors the mobile one.
#[cfg(not(mobile))]
pub(crate) async fn register_push<R: Runtime>(
    _app: &AppHandle<R>,
    _config: PushConfig,
) -> Result<(), PushRegistrationError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        RegisteredPusher, registered_pushers, remember_pusher, retire_old_pushers, stale_pusher,
    };

    #[tokio::test]
    async fn pusher_rotation_survives_restart_and_failed_retirement() {
        let root = std::env::temp_dir().join(format!("sable-pusher-ledger-{}", std::process::id()));
        let identity = ("@alice:example.org".to_owned(), "DEVICE".to_owned());
        for endpoint in ["old", "new", "new"] {
            remember_pusher(
                &root,
                &identity,
                endpoint.to_owned(),
                "app".to_owned(),
                None,
                false,
                None,
            )
            .expect("persist pusher");
        }
        let saved = registered_pushers(&root).expect("reload ledger");
        assert_eq!(saved.len(), 2);
        assert_eq!(saved.last().expect("current pusher").pushkey, "new");
        // No session: deletion must fail without discarding its retry identity.
        retire_old_pushers(&root, &identity).await;
        assert_eq!(registered_pushers(&root).expect("retained ledger").len(), 2);
        std::fs::remove_dir_all(root).expect("remove test ledger");
    }

    #[test]
    fn a_second_account_keeps_its_pusher() {
        let pushers: Vec<RegisteredPusher> = serde_json::from_value(serde_json::json!([
            { "user_id": "@alice:example.org", "device_id": "A", "pushkey": "old", "app_id": "app" },
            { "user_id": "@bob:example.org", "device_id": "B", "pushkey": "new", "app_id": "app" },
            { "user_id": "@alice:example.org", "device_id": "A", "pushkey": "new", "app_id": "app" }
        ]))
        .expect("a pusher ledger");
        let alice = ("@alice:example.org".to_owned(), "A".to_owned());
        let bob = ("@bob:example.org".to_owned(), "B".to_owned());
        assert_eq!(stale_pusher(&pushers, &alice), Some(0));
        assert_eq!(stale_pusher(&pushers, &bob), None);
        assert_eq!(stale_pusher(&pushers[1..], &alice), None);
    }
    #[test]
    fn rotation_is_scoped_to_subscription_and_rejects_retired_instances() {
        let pushers: Vec<RegisteredPusher> = serde_json::from_value(serde_json::json!([
            { "user_id": "@alice:one.test", "device_id": "A", "pushkey": "a", "app_id": "app", "instance": "alice-one" },
            { "user_id": "@bob:two.test", "device_id": "B", "pushkey": "b", "app_id": "app", "instance": "bob-two" },
            { "user_id": "@alice:one.test", "device_id": "OTHER", "pushkey": "c", "app_id": "app", "instance": "alice-other" },
            { "user_id": "@legacy:one.test", "device_id": "L", "pushkey": "d", "app_id": "app" }
        ])).expect("saved account pushers");
        let selected = |instance| {
            pushers
                .iter()
                .filter(|p| p.accepts_rotation(Some(instance), None))
                .count()
        };
        assert_eq!(selected("alice-one"), 1);
        assert_eq!(selected("bob-two"), 1);
        assert_eq!(selected("retired-alice"), 0);
        assert_eq!(selected("default"), 1);
        assert_eq!(
            pushers
                .iter()
                .filter(|p| p.accepts_rotation(None, Some(("@legacy:one.test", "L"))))
                .count(),
            1
        );
        assert!(!pushers[0].accepts_rotation(None, Some(("@alice:one.test", "A"))));
        assert!(!pushers[3].accepts_rotation(None, None));
    }

    #[test]
    fn retiring_one_account_preserves_a_shared_subscription() {
        let pushers: Vec<RegisteredPusher> = serde_json::from_value(serde_json::json!([
            { "user_id": "@alice:one.test", "device_id": "A", "pushkey": "a", "app_id": "app", "instance": "shared" },
            { "user_id": "@bob:two.test", "device_id": "B", "pushkey": "a", "app_id": "app", "instance": "shared" },
            { "user_id": "@carol:three.test", "device_id": "C", "pushkey": "c", "app_id": "app", "instance": "carol" }
        ])).expect("shared and independent subscriptions");
        assert!(super::unused_subscriptions(&pushers, &pushers[1..]).is_empty());
        assert_eq!(
            super::unused_subscriptions(&pushers, &pushers[2..]),
            std::collections::BTreeSet::from(["shared"])
        );
        assert_eq!(
            super::unused_subscriptions(&pushers, &[]),
            std::collections::BTreeSet::from(["shared", "carol"])
        );
    }
}
