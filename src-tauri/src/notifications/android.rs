use super::gateway::{
    Registration, is_unified_push_endpoint, rotated_registration, server_web_pusher,
};
use super::registration::{
    PUSH_REGISTRATION_LOCK, PushConfig, RegisteredPusher, pusher_client, registered_pushers,
    remember_pusher, retire_old_pushers,
};
use sable_core::protocol::{NotificationView, RpcError};
use tauri::{AppHandle, Runtime};

#[derive(serde::Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub(crate) enum BackgroundPush {
    Rotate {
        user_id: String,
        device_id: String,
        endpoint: String,
        p256dh: Option<String>,
        auth: Option<String>,
    },
    Activate {
        app_id: String,
        ack_token: String,
    },
}

pub(crate) async fn maintain_background_push(
    root: &std::path::Path,
    operation: BackgroundPush,
) -> Result<(), RpcError> {
    let _guard = PUSH_REGISTRATION_LOCK.lock().await;
    sable_core::notifications::evict_push_cache(root);
    let pushers = registered_pushers(root)?;
    match operation {
        BackgroundPush::Activate { app_id, ack_token } => {
            for pusher in pushers
                .iter()
                .rev()
                .filter(|pusher| pusher.app_id == app_id)
            {
                let Ok(client) = pusher_client(root, pusher).await else {
                    continue;
                };
                if client
                    .retry(|| sable_core::webpush::ack(&client, app_id.clone(), ack_token.clone()))
                    .await
                    .is_ok()
                {
                    return Ok(());
                }
            }
            Err(RpcError::Unavailable)
        }
        BackgroundPush::Rotate {
            user_id,
            device_id,
            endpoint,
            p256dh,
            auth,
        } => {
            let known = pushers
                .iter()
                .any(|pusher| pusher.user_id == user_id && pusher.device_id == device_id);
            if !known || !is_unified_push_endpoint(&endpoint) {
                return Err(RpcError::Unavailable);
            }
            let registration = Registration {
                token: endpoint,
                p256dh,
                auth,
            };
            for pusher in pushers {
                rotate_pusher(root, &pusher, &registration).await?;
            }
            Ok(())
        }
    }
}

async fn rotate_pusher(
    root: &std::path::Path,
    pusher: &RegisteredPusher,
    registration: &Registration,
) -> Result<(), RpcError> {
    use sable_core::api::push::PusherView;
    use sable_core::protocol::WebPushKeys;
    let client = pusher_client(root, pusher).await?;
    let registration = &rotated_registration(&pusher.app_id, registration);
    let pushkey = if let Some(gateway) = &pusher.gateway {
        let key = registration
            .p256dh
            .clone()
            .unwrap_or_else(|| registration.token.clone());
        let web_push = match (&registration.p256dh, &registration.auth) {
            (Some(p256dh), Some(auth)) => Some(WebPushKeys {
                endpoint: registration.token.clone(),
                p256dh: p256dh.clone(),
                auth: auth.clone(),
            }),
            (None, None) => None,
            _ => return Err(RpcError::Unavailable),
        };
        client
            .retry(|| {
                sable_core::notifications::set_pusher(
                    &client,
                    PusherView {
                        pushkey: key.clone(),
                        app_id: pusher.app_id.clone(),
                        url: gateway.clone(),
                        device_display_name: "Sable on Android".into(),
                        web_push: web_push.clone(),
                        event_id_only: pusher.event_id_only,
                        append: false,
                    },
                )
            })
            .await
            .map_err(|_| RpcError::Unavailable)?;
        key
    } else {
        let rotated = server_web_pusher(registration, &pusher.app_id, pusher.event_id_only)
            .ok_or(RpcError::Unavailable)?;
        let key = rotated.pushkey.clone();
        client
            .retry(|| sable_core::webpush::set_pusher(&client, rotated.clone()))
            .await
            .map_err(|_| RpcError::Unavailable)?;
        key
    };
    let identity = (pusher.user_id.clone(), pusher.device_id.clone());
    remember_pusher(
        root,
        &identity,
        pushkey,
        pusher.app_id.clone(),
        pusher.gateway.clone(),
        pusher.event_id_only,
    )?;
    retire_old_pushers(root, &identity).await;
    Ok(())
}

pub(super) async fn post_android<R: Runtime>(app: &AppHandle<R>, view: &NotificationView) {
    use tauri_plugin_sable_push::SablePushExt;
    let post = tauri_plugin_sable_push::Post {
        user_id: view.user_id.to_string(),
        room_id: view.room_id.to_string(),
        event_id: view.event_id.as_ref().map(ToString::to_string),
        room_name: view.room_name.clone(),
        sender_name: Some(
            view.sender_name
                .clone()
                .unwrap_or_else(|| view.sender.to_string()),
        ),
        body: view.body.clone(),
        encrypted: view.encrypted,
        direct: view.is_direct,
        noisy: view.noisy.unwrap_or(false) || view.mention,
        invite: view.event_id.is_none(),
    };
    if let Err(error) = app.sable_push().post(&post).await {
        log::warn!("could not show a notification: {error}");
    }
}

pub(crate) async fn set_open_conversation<R: Runtime>(
    app: &AppHandle<R>,
    user_id: Option<&str>,
    room_id: Option<&str>,
) {
    use tauri_plugin_sable_push::SablePushExt;
    if let Err(error) = app
        .sable_push()
        .set_open_conversation(user_id, room_id)
        .await
    {
        log::debug!("could not tell the system which conversation is open: {error}");
    }
}

pub(crate) async fn forget_left_conversations<R: Runtime>(
    app: &AppHandle<R>,
    core: &sable_core::Core,
) {
    use tauri_plugin_sable_push::SablePushExt;
    let Ok((user_id, room_ids)) = core.left_rooms().await else {
        return;
    };
    if room_ids.is_empty() {
        return;
    }
    if let Err(error) = app
        .sable_push()
        .forget_conversations(&user_id, &room_ids)
        .await
    {
        log::debug!("could not remove the conversations of left rooms: {error}");
    }
}

pub(super) async fn declare_push_accounts<R: Runtime>(
    app: &AppHandle<R>,
    config: &PushConfig,
    identity: &(String, String),
) {
    use tauri_plugin_sable_push::{Account, SablePushExt};
    let accounts: Vec<Account> = config
        .accounts
        .iter()
        .map(|account| (account.user_id.clone(), account.device_id.clone()))
        .chain(std::iter::once(identity.clone()))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .map(|(user_id, device_id)| Account { user_id, device_id })
        .collect();
    if let Err(error) = app.sable_push().set_accounts(&accounts).await {
        log::warn!("could not declare the signed-in accounts: {error}");
    }
}

pub(super) async fn remove_posted<R: Runtime>(app: &AppHandle<R>, ids: Vec<i32>) {
    use tauri_plugin_sable_push::SablePushExt;
    if let Err(error) = app.sable_push().dismiss(&ids).await {
        log::debug!("could not dismiss a notification: {error}");
    }
}
