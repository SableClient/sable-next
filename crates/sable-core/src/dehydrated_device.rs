use std::sync::Arc;

use matrix_sdk::encryption::secret_storage::SecretStore;
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::api::client::dehydrated_device::get_dehydrated_device;
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::{AnyGlobalAccountDataEvent, AnyGlobalAccountDataEventContent};
use matrix_sdk::ruma::serde::Raw;
use serde::{Deserialize, Serialize};

use crate::protocol::{DehydratedDeviceView, RpcError};
use crate::{Core, ResultExt};

/// Absent means enabled.
pub(crate) const PREFERENCE_EVENT: &str = "moe.sable.dehydrated_device";

#[derive(Deserialize, Serialize)]
struct Preference {
    enabled: bool,
}

fn is_enabled(raw: Option<Raw<AnyGlobalAccountDataEventContent>>) -> bool {
    raw.and_then(|raw| raw.deserialize_as_unchecked::<Preference>().ok())
        .is_none_or(|preference| preference.enabled)
}

async fn enabled(client: &matrix_sdk::Client) -> Result<bool, matrix_sdk::Error> {
    let raw = client
        .account()
        .fetch_account_data(PREFERENCE_EVENT.into())
        .await?;
    Ok(is_enabled(raw))
}

async fn wanted(client: &matrix_sdk::Client) -> bool {
    enabled(client).await.unwrap_or_else(|error| {
        tracing::warn!("reading the dehydrated device preference failed: {error}");
        false
    })
}

pub(crate) async fn on_account_data(
    client: &matrix_sdk::Client,
    event: &AnyGlobalAccountDataEvent,
) {
    if event.event_type().to_string() != PREFERENCE_EVENT {
        return;
    }
    let Ok(raw) = client
        .account()
        .account_data_raw(PREFERENCE_EVENT.into())
        .await
    else {
        return;
    };
    if !is_enabled(raw) {
        client.encryption().dehydrated_devices().stop();
    }
}

impl Core {
    pub(crate) fn resume_dehydrated_device(&self, client: &matrix_sdk::Client) {
        let client = client.clone();
        self.track_session_task(
            spawn(async move {
                if !wanted(&client).await {
                    return;
                }
                if let Err(error) = client.encryption().dehydrated_devices().resume().await {
                    tracing::warn!("resuming the dehydrated device failed: {error}");
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) fn start_dehydrated_device(&self, client: &matrix_sdk::Client, store: SecretStore) {
        let client = client.clone();
        self.track_session_task(
            spawn(async move {
                if !wanted(&client).await {
                    return;
                }
                let devices = client.encryption().dehydrated_devices();
                let started = match devices.is_key_stored(&store).await {
                    Ok(true) => devices.start(&store).await,
                    Ok(false) => devices.start(&store).create_new_key().await,
                    Err(error) => Err(error),
                };
                if let Err(error) = started {
                    tracing::warn!("starting the dehydrated device failed: {error}");
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn dehydrated_device(&self) -> Result<DehydratedDeviceView, RpcError> {
        let client = self.client().await?;
        let present = match client
            .send(get_dehydrated_device::unstable::Request::new())
            .await
        {
            Ok(_) => true,
            Err(error) => match error.client_api_error_kind() {
                Some(ErrorKind::Unrecognized) => return Ok(DehydratedDeviceView::Unsupported),
                Some(ErrorKind::NotFound) => false,
                _ => return Err(error).or_failed(self, "dehydrated_device"),
            },
        };
        if !enabled(&client)
            .await
            .or_failed(self, "dehydrated_device_preference")?
        {
            return Ok(DehydratedDeviceView::Disabled);
        }
        Ok(if present {
            DehydratedDeviceView::Active
        } else {
            DehydratedDeviceView::NeedsRecoveryKey
        })
    }

    pub(crate) async fn set_dehydrated_device(
        self: &Arc<Self>,
        enabled: bool,
    ) -> Result<DehydratedDeviceView, RpcError> {
        let client = self.client().await?;
        self.put_global_account_data(
            PREFERENCE_EVENT.into(),
            &Preference { enabled },
            "set_dehydrated_device",
        )
        .await?;
        let devices = client.encryption().dehydrated_devices();
        if enabled {
            devices
                .resume()
                .await
                .or_failed(self, "resume_dehydrated_device")?;
        } else {
            devices
                .delete()
                .await
                .or_failed(self, "delete_dehydrated_device")?;
        }
        self.dehydrated_device().await
    }
}
