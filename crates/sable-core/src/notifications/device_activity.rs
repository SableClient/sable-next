use matrix_sdk::ruma::serde::Raw;

pub(super) const DEVICE_ACTIVITY_EVENT: &str = "moe.sable.device_activity";
const DEVICE_ACTIVITY_PRUNE_MS: u64 = 7 * 24 * 60 * 60_000;
const DEVICE_ACTIVITY_WRITE_INTERVAL_MS: u64 = 30_000;

fn update_device_activity(
    mut content: sable_model::notifications::DeviceActivity,
    device_id: &str,
    active: bool,
    now_ms: u64,
) -> Option<sable_model::notifications::DeviceActivity> {
    if content.devices.get(device_id).is_some_and(|entry| {
        entry.active == active
            && now_ms >= entry.at
            && now_ms - entry.at < DEVICE_ACTIVITY_WRITE_INTERVAL_MS
    }) {
        return None;
    }

    content
        .devices
        .retain(|_, entry| now_ms.saturating_sub(entry.at) <= DEVICE_ACTIVITY_PRUNE_MS);
    content.devices.insert(
        device_id.to_owned(),
        sable_model::notifications::DeviceActivityEntry { active, at: now_ms },
    );
    Some(content)
}

pub(crate) async fn set_device_activity(core: &crate::Core, active: bool) {
    let _guard = core.account_data_lock.lock().await;
    let Ok(client) = core.client().await else {
        tracing::debug!("device activity not recorded: not logged in");
        return;
    };
    let Some(device_id) = client.device_id() else {
        tracing::debug!("device activity not recorded: device ID unavailable");
        return;
    };
    let current = match client
        .account()
        .fetch_account_data(DEVICE_ACTIVITY_EVENT.into())
        .await
    {
        Ok(raw) => raw
            .and_then(|raw| serde_json::from_str(raw.json().get()).ok())
            .unwrap_or_default(),
        Err(error) => {
            tracing::debug!("device activity not read: {error}");
            return;
        }
    };
    let Some(content) =
        update_device_activity(current, device_id.as_str(), active, crate::now_ms())
    else {
        return;
    };
    let Ok(raw) = serde_json::value::to_raw_value(&content)
        .map(Raw::<matrix_sdk::ruma::events::AnyGlobalAccountDataEventContent>::from_json)
    else {
        tracing::debug!("device activity not serialized");
        return;
    };
    if let Err(error) = client
        .account()
        .set_account_data_raw(DEVICE_ACTIVITY_EVENT.into(), raw)
        .await
    {
        tracing::debug!("device activity not written: {error}");
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{DEVICE_ACTIVITY_PRUNE_MS, update_device_activity};

    #[test]
    fn device_activity_updates_its_entry_and_prunes_old_devices() {
        let now = DEVICE_ACTIVITY_PRUNE_MS + 1_000_000;
        let content = update_device_activity(
            serde_json::from_value(json!({
                "devices": {
                    "OWN": {"active": true, "at": now - 31_000},
                    "OLD": {"active": true, "at": now - DEVICE_ACTIVITY_PRUNE_MS - 1}
                }
            }))
            .unwrap(),
            "OWN",
            false,
            now,
        )
        .unwrap();
        assert!(!content.devices["OWN"].active);
        assert!(!content.devices.contains_key("OLD"));
        assert!(update_device_activity(content, "OWN", false, now + 1_000).is_none());
    }
}
