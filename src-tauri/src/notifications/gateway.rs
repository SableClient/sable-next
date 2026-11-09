use super::PushConfig;
#[cfg(mobile)]
use super::PushRegistrationError;
use sable_core::api::push::WebPusherView;
use sable_core::protocol::WebPushKeys;
#[cfg(mobile)]
use tauri::{AppHandle, Runtime};
#[cfg(mobile)]
use tauri_plugin_notifications::NotificationsExt;
use tauri_plugin_notifications::PushProvider;

pub(super) struct Registration {
    pub(super) token: String,
    pub(super) p256dh: Option<String>,
    pub(super) auth: Option<String>,
    pub(super) instance: Option<String>,
}

const DIRECT_PUSH_APP_ID: &str = "moe.sable.up";
const SERVER_PUSH_APP_ID: &str = "moe.sable.webpush";

#[cfg(any(target_os = "android", test))]
pub(super) fn rotated_registration(app_id: &str, registration: &Registration) -> Registration {
    let keyed = app_id != DIRECT_PUSH_APP_ID;
    Registration {
        token: registration.token.clone(),
        p256dh: registration.p256dh.clone().filter(|_| keyed),
        auth: registration.auth.clone().filter(|_| keyed),
        instance: registration.instance.clone(),
    }
}

pub(super) fn pusher(
    registration: Registration,
    native_app_id: Option<&str>,
    web_app_id: Option<&str>,
) -> Option<(String, String, Option<WebPushKeys>)> {
    match (registration.p256dh, registration.auth) {
        (Some(p256dh), Some(auth)) => Some((
            web_app_id?.to_owned(),
            p256dh.clone(),
            Some(WebPushKeys {
                endpoint: registration.token,
                p256dh,
                auth,
            }),
        )),
        (None, None) if is_unified_push_endpoint(&registration.token) => {
            Some((DIRECT_PUSH_APP_ID.to_owned(), registration.token, None))
        }
        (None, None) if !registration.token.is_empty() && !registration.token.contains("://") => {
            Some((native_app_id?.to_owned(), registration.token, None))
        }
        _ => None,
    }
}

/// An MSC4174 pusher belongs to the homeserver: its endpoint is the Web Push
/// subscription, never an HTTP push gateway.
pub(super) fn server_web_pusher(
    registration: &Registration,
    event_id_only: bool,
) -> Option<WebPusherView> {
    Some(WebPusherView {
        pushkey: registration.p256dh.clone()?,
        app_id: SERVER_PUSH_APP_ID.to_owned(),
        device_display_name: format!("Sable on {}", std::env::consts::OS),
        endpoint: registration.token.clone(),
        auth: registration.auth.clone()?,
        event_id_only,
    })
}

pub(super) fn is_unified_push_endpoint(token: &str) -> bool {
    tauri::Url::parse(token).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

pub(super) fn registration_gateway<'a>(
    registration: &Registration,
    config: &'a PushConfig,
) -> Option<&'a str> {
    if config.gateway_override {
        return Some(&config.gateway_url);
    }
    if registration.p256dh.is_none()
        && registration.auth.is_none()
        && is_unified_push_endpoint(&registration.token)
    {
        config
            .unified_push_gateway_url
            .as_deref()
            .filter(|url| !url.trim().is_empty())
    } else {
        Some(&config.gateway_url)
    }
}

#[cfg(mobile)]
async fn active_provider<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.notifications()
        .push_transport()
        .await
        .inspect_err(|error| log::debug!("could not read the push transport: {error}"))
        .ok()
        .and_then(|transport| transport.provider)
}

#[cfg(mobile)]
async fn distributor_gateway<R: Runtime>(
    app: &AppHandle<R>,
    registration: &Registration,
    config: &PushConfig,
    server_vapid: Option<&str>,
) -> Option<String> {
    let active = active_provider(app).await;
    if !asks_distributor_for_gateway(config, registration, server_vapid, active.as_deref()) {
        return None;
    }
    sable_core::push_check::discover_gateway(&registration.token).await
}

fn prefers_distributor_gateway(
    config: &PushConfig,
    registration: &Registration,
    active_provider: Option<&str>,
) -> bool {
    (config.provider == Some(PushProvider::UnifiedPush) || active_provider == Some("unifiedpush"))
        && !config.gateway_override
        && is_unified_push_endpoint(&registration.token)
}

fn is_direct_unified_push(registration: &Registration, config: &PushConfig) -> bool {
    !config.gateway_override
        && registration.p256dh.is_none()
        && registration.auth.is_none()
        && is_unified_push_endpoint(&registration.token)
}

fn asks_distributor_for_gateway(
    config: &PushConfig,
    registration: &Registration,
    server_vapid: Option<&str>,
    active_provider: Option<&str>,
) -> bool {
    server_vapid.is_none()
        && (prefers_distributor_gateway(config, registration, active_provider)
            || is_direct_unified_push(registration, config))
}

fn without_keys(registration: Registration) -> Registration {
    Registration {
        token: registration.token,
        p256dh: None,
        auth: None,
        instance: registration.instance,
    }
}

#[cfg(mobile)]
pub(super) fn is_direct_pusher(app_id: &str) -> bool {
    app_id == DIRECT_PUSH_APP_ID
}

/// Skipping the keyed registration keeps the same subscription across launches.
#[cfg(any(target_os = "android", test))]
fn reuses_direct_registration(
    config: &PushConfig,
    server_vapid: Option<&str>,
    was_direct: bool,
    active_provider: Option<&str>,
) -> bool {
    was_direct
        && server_vapid.is_none()
        && !config.gateway_override
        && matches!(
            config.provider,
            None | Some(PushProvider::Auto | PushProvider::UnifiedPush)
        )
        && active_provider == Some("unifiedpush")
}

#[cfg(target_os = "android")]
async fn retire_instance<R: Runtime>(app: &AppHandle<R>, instance: Option<&str>) {
    let Some(instance) = instance else { return };
    if let Err(error) = app.notifications().unregister_push_instance(instance).await {
        log::warn!("could not retire a push subscription: {error}");
    }
}

/// A direct endpoint with a Matrix gateway is registered again without the VAPID key, which such gateways reject.
/// A distributor that requires VAPID refuses it, so the keyed one stays.
#[cfg(mobile)]
pub(super) async fn register_with_distributor<R: Runtime>(
    app: &AppHandle<R>,
    config: &PushConfig,
    server_vapid: Option<&str>,
    identity: &(String, String),
    was_direct: bool,
) -> Result<(Registration, Option<String>), PushRegistrationError> {
    let register = |vapid: Option<String>| async {
        let registered = app
            .notifications()
            .register_for_push_notifications(
                vapid,
                config.provider,
                config.embedded_gateway_url.clone(),
                Some(identity.0.clone()),
                Some(identity.1.clone()),
            )
            .await
            .map_err(|error| {
                log::warn!("could not register for push: {error}");
                PushRegistrationError::Platform {
                    message: error.to_string(),
                }
            })?;
        Ok::<_, PushRegistrationError>(Registration {
            token: registered.device_token,
            p256dh: registered.p256dh,
            auth: registered.auth,
            instance: registered.instance,
        })
    };
    #[cfg(target_os = "android")]
    if reuses_direct_registration(
        config,
        server_vapid,
        was_direct,
        active_provider(app).await.as_deref(),
    ) && let Ok(direct) = register(None).await
    {
        let direct = without_keys(direct);
        if let Some(gateway) = sable_core::push_check::discover_gateway(&direct.token).await {
            return Ok((direct, Some(gateway)));
        }
        retire_instance(app, direct.instance.as_deref()).await;
    }
    #[cfg(not(target_os = "android"))]
    let _ = was_direct;

    let registration = register(Some(
        server_vapid.map_or_else(|| config.vapid_key.clone(), str::to_owned),
    ))
    .await?;
    let Some(gateway) = distributor_gateway(app, &registration, config, server_vapid).await else {
        return Ok((registration, None));
    };
    let Ok(direct) = register(None).await else {
        return Ok((registration, None));
    };
    #[cfg(target_os = "android")]
    if direct.instance != registration.instance {
        retire_instance(app, registration.instance.as_deref()).await;
    }
    Ok((without_keys(direct), Some(gateway)))
}

#[cfg(test)]
mod tests {
    use super::{PushConfig, PushProvider, Registration, pusher, server_web_pusher};

    #[test]
    fn only_a_direct_unifiedpush_endpoint_asks_its_distributor_for_a_gateway() {
        let mut config: PushConfig = serde_json::from_value(serde_json::json!({
            "gateway_url": "https://sygnal.example/_matrix/push/v1/notify",
            "vapid_key": "key", "web_app_id": "web", "event_id_only": true,
        }))
        .expect("push config");
        let mut registration = Registration {
            token: "https://ntfy.example/topic".to_owned(),
            p256dh: None,
            auth: None,
            instance: None,
        };
        assert!(super::is_direct_unified_push(&registration, &config));
        config.gateway_override = true;
        assert!(!super::is_direct_unified_push(&registration, &config));
        config.gateway_override = false;
        registration.p256dh = Some("key".to_owned());
        registration.auth = Some("auth".to_owned());
        assert!(!super::is_direct_unified_push(&registration, &config));
        registration.p256dh = None;
        registration.auth = None;
        registration.token = "fcm-token".to_owned();
        assert!(!super::is_direct_unified_push(&registration, &config));
    }

    #[test]
    fn only_an_installed_unifiedpush_distributor_offers_its_gateway() {
        let mut config: PushConfig = serde_json::from_value(serde_json::json!({
            "gateway_url": "https://sygnal.example/_matrix/push/v1/notify",
            "vapid_key": "key", "web_app_id": "web", "event_id_only": true,
            "provider": "unifiedpush",
        }))
        .expect("push config");
        let registration = Registration {
            token: "https://ntfy.example/topic".to_owned(),
            p256dh: Some("key".to_owned()),
            auth: Some("auth".to_owned()),
            instance: None,
        };
        assert!(super::prefers_distributor_gateway(
            &config,
            &registration,
            None
        ));
        config.provider = Some(PushProvider::Embedded);
        assert!(!super::prefers_distributor_gateway(
            &config,
            &registration,
            None
        ));
        config.provider = Some(PushProvider::Auto);
        assert!(!super::prefers_distributor_gateway(
            &config,
            &registration,
            None
        ));
        assert!(!super::prefers_distributor_gateway(
            &config,
            &registration,
            Some("fcm")
        ));
        assert!(!super::prefers_distributor_gateway(
            &config,
            &registration,
            Some("embedded")
        ));
        assert!(super::prefers_distributor_gateway(
            &config,
            &registration,
            Some("unifiedpush")
        ));
        config.provider = Some(PushProvider::UnifiedPush);
        config.gateway_override = true;
        assert!(!super::prefers_distributor_gateway(
            &config,
            &registration,
            None
        ));
    }

    #[test]
    fn a_chosen_distributor_with_web_push_keys_still_offers_its_gateway() {
        let mut config: PushConfig = serde_json::from_value(serde_json::json!({
            "gateway_url": "https://sygnal.example/_matrix/push/v1/notify",
            "vapid_key": "key", "web_app_id": "web", "event_id_only": true,
            "provider": "unifiedpush",
        }))
        .expect("push config");
        let registration = Registration {
            token: "https://ntfy.example/upTopic?up=1".to_owned(),
            p256dh: Some("key".to_owned()),
            auth: Some("auth".to_owned()),
            instance: None,
        };
        assert!(super::asks_distributor_for_gateway(
            &config,
            &registration,
            None,
            None
        ));
        assert!(!super::asks_distributor_for_gateway(
            &config,
            &registration,
            Some("server-key"),
            None
        ));
        config.provider = Some(PushProvider::Embedded);
        assert!(!super::asks_distributor_for_gateway(
            &config,
            &registration,
            None,
            None
        ));

        let (app_id, pushkey, web_push) = pusher(
            super::without_keys(registration),
            Some("native"),
            Some("web"),
        )
        .expect("a direct pusher");
        assert_eq!(app_id, super::DIRECT_PUSH_APP_ID);
        assert_eq!(pushkey, "https://ntfy.example/upTopic?up=1");
        assert!(web_push.is_none());
    }

    #[test]
    fn a_rotated_direct_pusher_stays_keyed_on_its_endpoint() {
        let registration = Registration {
            token: "https://ntfy.example/upNew?up=1".to_owned(),
            p256dh: Some("key".to_owned()),
            auth: Some("auth".to_owned()),
            instance: None,
        };
        let direct = super::rotated_registration(super::DIRECT_PUSH_APP_ID, &registration);
        assert_eq!(direct.token, registration.token);
        assert!(direct.p256dh.is_none() && direct.auth.is_none());
        let keyed = super::rotated_registration("web", &registration);
        assert_eq!(keyed.p256dh.as_deref(), Some("key"));
        assert_eq!(keyed.auth.as_deref(), Some("auth"));
    }

    #[test]
    fn explicit_gateway_applies_to_direct_unifiedpush_too() {
        let config = serde_json::from_value(serde_json::json!({
            "gateway_url": "https://custom.example/_matrix/push/v1/notify",
            "gateway_override": true,
            "vapid_key": "key",
            "web_app_id": "custom",
            "event_id_only": false,
            "unified_push_gateway_url": "https://default.example/_matrix/push/v1/notify"
        }))
        .expect("push config");
        let registration = Registration {
            token: "https://ntfy.example/endpoint".into(),
            p256dh: None,
            auth: None,
            instance: None,
        };
        assert_eq!(
            super::registration_gateway(&registration, &config),
            Some("https://custom.example/_matrix/push/v1/notify")
        );
    }

    #[test]
    fn a_web_push_distributor_registers_its_keys() {
        let (app_id, pushkey, web_push) = pusher(
            Registration {
                token: "https://push.example/endpoint".to_owned(),
                p256dh: Some("key".to_owned()),
                auth: Some("secret".to_owned()),
                instance: None,
            },
            Some("moe.sable.client.android"),
            Some("moe.sable.app.sygnal"),
        )
        .expect("a web push registration has an app id");

        assert_eq!(app_id, "moe.sable.app.sygnal");
        assert_eq!(pushkey, "key");
        let keys = web_push.expect("the gateway needs the keys");
        assert_eq!(keys.endpoint, "https://push.example/endpoint");
        assert_eq!(keys.auth, "secret");
    }

    #[test]
    fn a_unified_push_url_is_not_an_fcm_token() {
        let (app_id, pushkey, web_push) = pusher(
            Registration {
                token: "https://ntfy.sh/up123?up=1".to_owned(),
                p256dh: None,
                auth: None,
                instance: None,
            },
            Some("moe.sable.client.android"),
            Some("moe.sable.app.sygnal"),
        )
        .expect("UnifiedPush registration");
        assert_eq!(app_id, "moe.sable.up");
        assert_eq!(pushkey, "https://ntfy.sh/up123?up=1");
        assert!(web_push.is_none());
    }

    #[test]
    fn incomplete_keys_and_unsafe_endpoints_are_rejected() {
        for (token, p256dh, auth) in [
            ("https://ntfy.sh/topic", Some("key"), None),
            ("https://ntfy.sh/topic", None, Some("auth")),
            ("http://ntfy.sh/topic", None, None),
            ("https://user:password@ntfy.sh/topic", None, None),
            ("", None, None),
        ] {
            assert!(
                pusher(
                    Registration {
                        token: token.to_owned(),
                        p256dh: p256dh.map(str::to_owned),
                        auth: auth.map(str::to_owned),
                        instance: None,
                    },
                    Some("native"),
                    Some("web"),
                )
                .is_none()
            );
        }
    }

    #[test]
    fn ntfy_and_webpush_use_their_own_gateways() {
        let mut config: PushConfig = serde_json::from_value(serde_json::json!({
            "gateway_url": "https://sygnal.example/_matrix/push/v1/notify",
            "unified_push_gateway_url": "https://ntfy.example/_matrix/push/v1/notify",
            "vapid_key": "key", "web_app_id": "web", "event_id_only": true,
        }))
        .expect("push config");
        let mut registration = Registration {
            token: "https://ntfy.example/topic".to_owned(),
            p256dh: None,
            auth: None,
            instance: None,
        };
        assert_eq!(
            super::registration_gateway(&registration, &config),
            config.unified_push_gateway_url.as_deref()
        );
        config.unified_push_gateway_url = None;
        assert!(super::registration_gateway(&registration, &config).is_none());
        registration.p256dh = Some("key".to_owned());
        registration.auth = Some("auth".to_owned());
        assert_eq!(
            super::registration_gateway(&registration, &config),
            Some(config.gateway_url.as_str())
        );
        registration.token = "fcm-token".to_owned();
        registration.p256dh = None;
        registration.auth = None;
        assert_eq!(
            super::registration_gateway(&registration, &config),
            Some(config.gateway_url.as_str())
        );
    }

    #[test]
    fn a_bare_token_registers_as_the_pushkey() {
        let (app_id, pushkey, web_push) = pusher(
            Registration {
                token: "fcm-token".to_owned(),
                p256dh: None,
                auth: None,
                instance: None,
            },
            Some("moe.sable.client.android"),
            Some("moe.sable.app.sygnal"),
        )
        .expect("a token registration has an app id");

        assert_eq!(app_id, "moe.sable.client.android");
        assert_eq!(pushkey, "fcm-token");
        assert!(web_push.is_none());
    }

    #[test]
    fn a_build_without_the_matching_app_id_registers_nothing() {
        assert!(
            pusher(
                Registration {
                    token: "fcm-token".to_owned(),
                    p256dh: None,
                    auth: None,
                    instance: None,
                },
                None,
                Some("moe.sable.app.sygnal"),
            )
            .is_none()
        );
    }

    #[test]
    fn msc4174_uses_the_distributor_subscription_without_a_gateway() {
        let registration = Registration {
            token: "https://push.example/subscription".to_owned(),
            p256dh: Some("public-key".to_owned()),
            auth: Some("auth-secret".to_owned()),
            instance: None,
        };

        let pusher =
            server_web_pusher(&registration, true).expect("web push keys create an MSC4174 pusher");
        assert_eq!(pusher.pushkey, "public-key");
        assert_eq!(pusher.endpoint, registration.token);
        assert_eq!(pusher.auth, "auth-secret");
        assert_eq!(pusher.app_id, super::SERVER_PUSH_APP_ID);
        assert!(pusher.event_id_only);
    }

    #[test]
    fn only_a_unifiedpush_account_already_on_a_matrix_gateway_skips_the_keyed_registration() {
        let mut config: PushConfig = serde_json::from_value(serde_json::json!({
            "gateway_url": "https://sygnal.example/_matrix/push/v1/notify",
            "vapid_key": "key", "web_app_id": "web", "event_id_only": true,
        }))
        .expect("push config");
        let reuses = super::reuses_direct_registration;
        assert!(reuses(&config, None, true, Some("unifiedpush")));
        assert!(!reuses(&config, None, false, Some("unifiedpush")));
        assert!(!reuses(
            &config,
            Some("server-key"),
            true,
            Some("unifiedpush")
        ));
        assert!(!reuses(&config, None, true, Some("embedded")));
        assert!(!reuses(&config, None, true, Some("fcm")));
        assert!(!reuses(&config, None, true, None));
        config.provider = Some(PushProvider::Embedded);
        assert!(!reuses(&config, None, true, Some("unifiedpush")));
        config.provider = Some(PushProvider::UnifiedPush);
        config.gateway_override = true;
        assert!(!reuses(&config, None, true, Some("unifiedpush")));
    }
}
