use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::Room;
use matrix_sdk::executor::spawn;
use matrix_sdk::ruma::EventId;
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk_ui::unable_to_decrypt_hook::{
    UnableToDecryptHook, UnableToDecryptInfo, UtdHookManager,
};
use sha2::{Digest, Sha256};

const GRACE_PERIOD: Duration = Duration::from_secs(60);

#[derive(Debug)]
struct UtdReporter {
    room: Room,
}

impl UnableToDecryptHook for UtdReporter {
    fn on_utd(&self, info: UnableToDecryptInfo) {
        match info.time_to_decrypt {
            None => drop(spawn(report(self.room.clone(), info))),
            Some(delay) => tracing::warn!(
                cause = ?info.cause,
                age = event_age(info.event_local_age_millis),
                delay = decrypt_delay(delay),
                "decrypted a message late"
            ),
        }
    }
}

async fn report(room: Room, info: UnableToDecryptInfo) {
    let content = megolm_content(&room, &info.event_id).await;
    let backup_lookup = match content
        .as_ref()
        .and_then(|content| content.session_id.as_deref())
    {
        Some(session_id) => backup_lookup(&room, session_id).await,
        None => "unknown_session",
    };
    let (megolm_session, sender_device) = content.map_or((None, None), |content| {
        (
            content.session_id.as_deref().map(short_hash),
            content.device_id.as_deref().map(short_hash),
        )
    });
    let encryption = room.client().encryption();
    let device_cross_signed = encryption
        .get_own_device()
        .await
        .ok()
        .flatten()
        .map(|device| device.is_cross_signed_by_owner());
    let account_cross_signed = encryption
        .cross_signing_status()
        .await
        .is_some_and(|status| status.is_complete());
    tracing::warn!(
        reported = true,
        cause = ?info.cause,
        age = event_age(info.event_local_age_millis),
        own_identity_trusted = info.user_trusts_own_identity,
        same_homeserver = info.own_homeserver.as_ref() == Some(&info.sender_homeserver),
        backup = ?encryption.backups().state(),
        backup_lookup,
        account_cross_signed,
        device_cross_signed,
        megolm_session,
        sender_device,
        "unable to decrypt a message"
    );
}

#[derive(serde::Deserialize)]
struct MegolmContent {
    session_id: Option<String>,
    device_id: Option<String>,
}

async fn megolm_content(room: &Room, event_id: &EventId) -> Option<MegolmContent> {
    let client = room.client();
    let event_cache = client.event_cache()?;
    let (cache, _handles) = event_cache.room(room.room_id()).await.ok()?;
    cache
        .find_event(event_id)
        .await
        .ok()
        .flatten()?
        .raw()
        .get_field::<MegolmContent>("content")
        .ok()
        .flatten()
}

pub(crate) async fn backup_lookup(room: &Room, session_id: &str) -> &'static str {
    match room
        .client()
        .encryption()
        .backups()
        .download_room_key(room.room_id(), session_id)
        .await
    {
        Ok(true) => "imported",
        Ok(false) => "no_backup_key",
        Err(error) if error.client_api_error_kind() == Some(&ErrorKind::NotFound) => {
            "not_in_backup"
        }
        Err(_) => "request_failed",
    }
}

fn short_hash(value: &str) -> String {
    use std::fmt::Write;

    Sha256::digest(value.as_bytes()).iter().take(6).fold(
        String::with_capacity(12),
        |mut hash, byte| {
            let _ = write!(hash, "{byte:02x}");
            hash
        },
    )
}

const fn event_age(millis_since_device_created: i64) -> &'static str {
    const HOUR: i64 = 3_600_000;
    const DAY: i64 = 24 * HOUR;
    match millis_since_device_created {
        ..0 => "before_this_device",
        0..HOUR => "first_hour",
        HOUR..DAY => "first_day",
        _ => "later",
    }
}

const fn decrypt_delay(delay: Duration) -> &'static str {
    match delay.as_secs() {
        0..2 => "under_2s",
        2..10 => "under_10s",
        _ => "under_60s",
    }
}

#[cfg_attr(
    target_family = "wasm",
    expect(
        clippy::arc_with_non_send_sync,
        reason = "the WASM core is single-threaded"
    )
)]
pub(crate) fn hook(room: &Room) -> Arc<UtdHookManager> {
    Arc::new(
        UtdHookManager::new(Arc::new(UtdReporter { room: room.clone() }), room.client())
            .with_max_delay(GRACE_PERIOD),
    )
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{decrypt_delay, event_age, short_hash};

    #[test]
    fn an_event_age_falls_into_one_coarse_bucket() {
        assert_eq!(event_age(-1), "before_this_device");
        assert_eq!(event_age(0), "first_hour");
        assert_eq!(event_age(3_600_000), "first_day");
        assert_eq!(event_age(86_400_000), "later");
    }

    #[test]
    fn a_late_decryption_falls_into_one_coarse_bucket() {
        assert_eq!(decrypt_delay(Duration::from_millis(1_999)), "under_2s");
        assert_eq!(decrypt_delay(Duration::from_secs(2)), "under_10s");
        assert_eq!(decrypt_delay(Duration::from_secs(10)), "under_60s");
    }

    #[test]
    fn a_short_hash_is_stable_and_too_short_to_be_scrubbed_as_a_key() {
        let hash = short_hash("rIatPKL0yVALedn6jJBOGi55vRkgXUCDcUzqJCHIINU");
        assert_eq!(
            hash,
            short_hash("rIatPKL0yVALedn6jJBOGi55vRkgXUCDcUzqJCHIINU")
        );
        assert_eq!(hash.len(), 12);
        assert_ne!(hash, short_hash("another session"));
    }
}
