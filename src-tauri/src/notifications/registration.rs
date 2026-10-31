#[cfg(target_os = "android")]
use super::android::declare_push_accounts;
#[cfg(mobile)]
use super::gateway::{pusher, register_with_distributor, registration_gateway, server_web_pusher};
#[cfg(mobile)]
use sable_core::api::push::WebPusherView;
use sable_core::protocol::RpcError;
use std::sync::Arc;
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
}

fn push_store<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, RpcError> {
    use tauri::Manager;
    app.try_state::<PushStore>()
        .map(|store| store.0.clone())
        .ok_or(RpcError::Unavailable)
}

pub(crate) struct PushStore(pub std::path::PathBuf);

pub(super) fn registered_pushers(
    root: &std::path::Path,
) -> Result<Vec<RegisteredPusher>, RpcError> {
    match std::fs::read(root.join("pushers.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| RpcError::Unavailable),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(RpcError::Unavailable),
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
    std::fs::create_dir_all(root).map_err(|_| RpcError::Unavailable)?;
    let bytes = serde_json::to_vec(pushers).map_err(|_| RpcError::Unavailable)?;
    sable_core::store::write_atomic(&root.join("pushers.json"), &bytes)
        .map_err(|_| RpcError::Unavailable)
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
        .map_err(|_| RpcError::Unavailable)
}

pub(super) async fn pusher_client(
    root: &std::path::Path,
    pusher: &RegisteredPusher,
) -> Result<sable_core::notifications::PushClient, RpcError> {
    sable_core::notifications::restore_push_client(root, &pusher.user_id, &pusher.device_id)
        .await
        .ok_or(RpcError::Unavailable)
}

#[derive(serde::Deserialize)]
#[cfg_attr(
    not(mobile),
    expect(dead_code, reason = "only a mobile build registers a pusher")
)]
#[cfg_attr(
    all(mobile, not(target_os = "android")),
    expect(
        dead_code,
        reason = "only android declares accounts to the push plugin"
    )
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
    #[cfg_attr(
        all(mobile, not(target_os = "android")),
        expect(
            dead_code,
            reason = "only android declares accounts to the push plugin"
        )
    )]
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
    pub provider: Option<String>,
}

/// # Errors
///
/// When the platform refuses a push registration, or the homeserver rejects the
/// pusher the distributor asked for.
#[cfg(mobile)]
pub(crate) async fn register_push<R: Runtime>(
    app: &AppHandle<R>,
    core: &Arc<sable_core::Core>,
    config: PushConfig,
) -> Result<(), PushRegistrationError> {
    use sable_core::api::push::{PusherView, SetPusherParams, WebPusherSupportParams};
    // The extension fetches the event itself, so the gateway never needs its text.
    #[cfg(target_os = "ios")]
    let config = PushConfig {
        event_id_only: true,
        ..config
    };
    let _guard = PUSH_REGISTRATION_LOCK.lock().await;
    let root = push_store(app).map_err(|_| PushRegistrationError::Ledger)?;
    let (Some(user_id), Some(device_id)) = (config.user_id.clone(), config.device_id.clone())
    else {
        return Err(PushRegistrationError::NoSession);
    };
    let identity = (user_id, device_id);
    #[cfg(target_os = "android")]
    declare_push_accounts(app, &config, &identity).await;

    // MSC4174 makes the homeserver the push gateway. Query before creating the
    // subscription because the distributor must bind it to the server's VAPID key.
    let server_vapid = if config.gateway_override || cfg!(target_os = "ios") {
        None
    } else {
        core.run(WebPusherSupportParams {})
            .await
            .map_err(|_| PushRegistrationError::Capabilities)?
    };
    let (registration, distributor_gateway) =
        register_with_distributor(app, core, &config, server_vapid.as_deref()).await?;
    if server_vapid.is_some()
        && let Some(pusher) =
            server_web_pusher(&registration, &config.web_app_id, config.event_id_only)
    {
        return Box::pin(register_server_pusher(
            core,
            &root,
            &identity,
            pusher,
            config.event_id_only,
        ))
        .await;
    }

    let gateway_url = match distributor_gateway {
        Some(gateway) => gateway,
        None => registration_gateway(&registration, &config)
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

    let params = SetPusherParams {
        pusher: PusherView {
            pushkey: pushkey.clone(),
            app_id: app_id.clone(),
            url: gateway_url.clone(),
            device_display_name: format!("Sable on {}", std::env::consts::OS),
            web_push,
            event_id_only: config.event_id_only,
            append: false,
        },
    };

    core.run(params)
        .await
        .map_err(|error| PushRegistrationError::Homeserver { error })?;
    remember_pusher(
        &root,
        &identity,
        pushkey,
        app_id,
        Some(gateway_url),
        config.event_id_only,
    )
    .map_err(|_| PushRegistrationError::Ledger)?;
    retire_old_pushers(&root, &identity).await;
    Ok(())
}

#[cfg(mobile)]
async fn register_server_pusher(
    core: &Arc<sable_core::Core>,
    root: &std::path::Path,
    identity: &(String, String),
    pusher: WebPusherView,
    event_id_only: bool,
) -> Result<(), PushRegistrationError> {
    let pushkey = pusher.pushkey.clone();
    let app_id = pusher.app_id.clone();
    if let Err(error) = core
        .run(sable_core::api::push::SetWebPusherParams { pusher })
        .await
    {
        log::warn!("homeserver rejected the MSC4174 pusher: {error:?}");
        return Err(PushRegistrationError::Homeserver { error });
    }
    log::debug!("registered an MSC4174 pusher through the homeserver");
    remember_pusher(root, identity, pushkey, app_id, None, event_id_only)
        .map_err(|_| PushRegistrationError::Ledger)?;
    retire_old_pushers(root, identity).await;
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

/// # Errors
///
/// When the homeserver refuses to delete the pusher.
pub(crate) async fn unregister_push<R: Runtime>(app: &AppHandle<R>) -> Result<(), RpcError> {
    let _guard = PUSH_REGISTRATION_LOCK.lock().await;
    #[cfg(mobile)]
    app.notifications()
        .unregister_for_push_notifications()
        .await
        .map_err(|_| RpcError::Unavailable)?;
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_sable_push::SablePushExt;
        let push = app.sable_push();
        if let Err(error) = push.set_accounts(&[]).await {
            log::debug!("could not clear the signed-in accounts: {error}");
        }
        if let Err(error) = push.dismiss_all().await {
            log::debug!("could not dismiss the notifications: {error}");
        }
    }
    let root = push_store(app)?;
    let mut pushers = registered_pushers(&root)?;
    while let Some(pusher) = pushers.first() {
        remove_saved_pusher(&root, pusher).await?;
        pushers.remove(0);
        save_pushers(&root, &pushers)?;
    }
    Ok(())
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
    _core: &Arc<sable_core::Core>,
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
}
