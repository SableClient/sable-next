//! Bounded, UI-independent notification decryption for the iOS service extension.

use std::ffi::{CStr, CString, c_char};
use std::path::Path;

use sable_core::session::AccountRegistry;
use sable_core::store::{FileSessionStore, SessionStore};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Default, Deserialize)]
#[serde(default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "persisted notification preferences"
)]
struct Policy {
    enabled: bool,
    content: bool,
    encrypted_content: bool,
    sounds: bool,
    notify_once: bool,
}

fn policy(root: &Path) -> Policy {
    std::fs::read(root.join("push-policy.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// # Safety
/// `root` must be null or a valid NUL-terminated UTF-8 path for this call.
#[expect(
    unsafe_code,
    reason = "C ABI used by the notification service extension"
)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sable_push_sounds(root: *const c_char) -> bool {
    if root.is_null() {
        return false;
    }
    std::panic::catch_unwind(|| {
        // SAFETY: the caller guarantees a valid C string for this call.
        let Ok(root) = (unsafe { CStr::from_ptr(root) }).to_str() else {
            return false;
        };
        let settings = policy(Path::new(root));
        settings.enabled && settings.sounds
    })
    .unwrap_or(false)
}

/// # Safety
/// `root` must be null or a valid NUL-terminated UTF-8 path for this call.
#[expect(
    unsafe_code,
    reason = "C ABI used by the notification service extension"
)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sable_push_notify_once(root: *const c_char) -> bool {
    if root.is_null() {
        return false;
    }
    std::panic::catch_unwind(|| {
        // SAFETY: the caller guarantees a valid C string for this call.
        let Ok(root) = (unsafe { CStr::from_ptr(root) }).to_str() else {
            return false;
        };
        policy(Path::new(root)).notify_once
    })
    .unwrap_or(false)
}

fn notification(payload: &Value) -> &Value {
    payload.get("notification").unwrap_or(payload)
}

const RING_TYPES: [&str; 2] = ["m.rtc.notification", "org.matrix.msc4075.rtc.notification"];
const DEFAULT_RING_LIFETIME_MS: u64 = 30_000;

fn ring(event: &Value, notification: &Value) -> Option<Value> {
    let kind = event.get("type")?.as_str()?;
    let content = event.get("content")?;
    if !RING_TYPES.contains(&kind) || content.get("notification_type")?.as_str()? != "ring" {
        return None;
    }
    let sent = content
        .get("sender_ts")
        .and_then(Value::as_u64)
        .or_else(|| event.get("origin_server_ts").and_then(Value::as_u64))?;
    let lifetime = content
        .get("lifetime")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_RING_LIFETIME_MS);
    let caller = notification
        .get("sender_display_name")
        .or_else(|| event.get("sender"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    #[expect(
        clippy::cast_precision_loss,
        reason = "milliseconds since 1970 fit an f64 exactly for millennia"
    )]
    let expires_at = sent.saturating_add(lifetime) as f64 / 1000.0;
    Some(json!({"caller_name": caller, "expires_at": expires_at}))
}

async fn render(root: &Path, payload: &Value) -> Option<Value> {
    let settings = policy(root);
    if !settings.enabled {
        return None;
    }
    let notification = notification(payload);
    let user = notification
        .get("user_id")
        .or_else(|| payload.get("user_id"))?
        .as_str()?;
    let room_id = notification.get("room_id")?.as_str()?;
    let bytes = FileSessionStore::new(root).load().await.ok()??;
    let (registry, _) = AccountRegistry::from_bytes(&bytes, root.to_str()?).ok()?;
    // Never select an arbitrary saved account for a push, including after logout.
    let account = registry.accounts.iter().find(|account| {
        !account.needs_reauth
            && registry.active_account_id.as_deref() == Some(account.account_id.as_str())
            && account.session.credentials.user_id() == user
    })?;
    let encrypted = notification.get("type")?.as_str()? == "m.room.encrypted";
    let event = if encrypted {
        let mut event = notification.clone();
        event
            .as_object_mut()?
            .entry("origin_server_ts")
            .or_insert(json!(0));
        let clear = sable_core::notifications::decrypt_push_from_store(
            root,
            user,
            &account.session.credentials.device_id(),
            room_id,
            &event.to_string(),
        )
        .await?;
        serde_json::from_str::<Value>(&clear).ok()?
    } else {
        notification.clone()
    };
    if let Some(ring) = ring(&event, notification) {
        return Some(json!({"ring": ring, "room_id": room_id, "user_id": user}));
    }
    if !settings.content || (encrypted && !settings.encrypted_content) {
        return None;
    }
    let body = event.get("content")?.get("body")?.as_str()?;
    // Recheck policy after decryption, which may overlap a settings change.
    let current = policy(root);
    if !current.enabled || !current.content || (encrypted && !current.encrypted_content) {
        return None;
    }
    let latest = FileSessionStore::new(root).load().await.ok()??;
    let (latest, _) = AccountRegistry::from_bytes(&latest, root.to_str()?).ok()?;
    if !latest.accounts.iter().any(|saved| {
        saved.account_id == account.account_id
            && !saved.needs_reauth
            && latest.active_account_id.as_deref() == Some(saved.account_id.as_str())
            && saved.session.credentials.user_id() == user
            && saved.session.credentials.device_id() == account.session.credentials.device_id()
    }) {
        return None;
    }
    Some(json!({"body": body, "room_id": room_id, "user_id": user, "sounds": current.sounds}))
}

/// # Safety
/// Both arguments must be valid NUL-terminated UTF-8 strings for this call.
/// The returned string must be released with `sable_push_free` exactly once.
#[expect(
    unsafe_code,
    reason = "C ABI used by the notification service extension"
)]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sable_push_render(
    root: *const c_char,
    payload: *const c_char,
) -> *mut c_char {
    if root.is_null() || payload.is_null() {
        return std::ptr::null_mut();
    }
    let rendered = std::panic::catch_unwind(|| {
        // SAFETY: the caller guarantees valid C strings for the duration of this call.
        let root = unsafe { CStr::from_ptr(root) }.to_str().ok()?;
        // SAFETY: same contract as root above.
        let payload = unsafe { CStr::from_ptr(payload) }.to_str().ok()?;
        let payload = serde_json::from_str(payload).ok()?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()?;
        let rendered = runtime.block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_secs(20),
                render(Path::new(root), &payload),
            )
            .await
            .ok()
            .flatten()
        })?;
        CString::new(rendered.to_string())
            .ok()
            .map(CString::into_raw)
    });
    rendered.ok().flatten().unwrap_or(std::ptr::null_mut())
}

/// # Safety
/// `value` must be null or an unreleased pointer returned by `sable_push_render`.
#[expect(unsafe_code, reason = "releases a string allocated by the C ABI")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sable_push_free(value: *mut c_char) {
    if !value.is_null() {
        // SAFETY: ownership is returned by the caller under the documented contract.
        drop(unsafe { CString::from_raw(value) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[expect(unsafe_code, reason = "tests the extension C ABI with owned C strings")]
    fn sound_policy_is_independent_of_preview_and_decryption() {
        let root = std::env::temp_dir().join(format!("sable-sound-policy-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = CString::new(root.to_str().unwrap()).unwrap();
        for (enabled, content, sounds, expected) in [
            (true, false, true, true),
            (true, true, true, true),
            (true, true, false, false),
            (false, true, true, false),
        ] {
            std::fs::write(root.join("push-policy.json"), json!({"enabled":enabled,"content":content,"encrypted_content":false,"sounds":sounds,"notify_once":false}).to_string()).unwrap();
            // SAFETY: path remains alive throughout the call.
            assert_eq!(unsafe { sable_push_sounds(path.as_ptr()) }, expected);
        }
        // SAFETY: null is explicitly accepted by this ABI.
        assert!(!unsafe { sable_push_sounds(std::ptr::null()) });
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[expect(unsafe_code, reason = "tests the extension C ABI with owned C strings")]
    fn notify_once_is_read_back_from_the_stored_policy() {
        let root = std::env::temp_dir().join(format!("sable-notify-once-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = CString::new(root.to_str().unwrap()).unwrap();
        for notify_once in [true, false] {
            std::fs::write(root.join("push-policy.json"), json!({"enabled":true,"content":true,"encrypted_content":false,"sounds":true,"notify_once":notify_once}).to_string()).unwrap();
            assert_eq!(
                // SAFETY: path remains alive throughout the call.
                unsafe { sable_push_notify_once(path.as_ptr()) },
                notify_once
            );
        }
        // SAFETY: null is explicitly accepted by this ABI.
        assert!(!unsafe { sable_push_notify_once(std::ptr::null()) });
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn missing_policy_and_session_fail_closed() {
        assert!(
            render(
                Path::new("/nonexistent-sable-push-test"),
                &json!({"content":{"body":"private"}})
            )
            .await
            .is_none()
        );
    }

    #[test]
    fn only_a_ring_notification_is_a_ring() {
        let event = |kind: &str, notification_type: &str| {
            json!({"type":kind,"sender":"@bob:example.org","origin_server_ts":2_000,
                "content":{"notification_type":notification_type}})
        };
        let named = json!({"sender_display_name":"Bob"});

        assert_eq!(
            ring(
                &event("org.matrix.msc4075.rtc.notification", "ring"),
                &named
            ),
            Some(json!({"caller_name":"Bob","expires_at":32.0}))
        );
        assert!(ring(&event("m.rtc.notification", "notification"), &named).is_none());
        assert!(ring(&event("m.room.message", "ring"), &named).is_none());
    }

    #[test]
    fn accepts_both_matrix_payload_envelopes() {
        let inner = json!({"room_id":"!room:example.org"});
        assert_eq!(notification(&inner), &inner);
        assert_eq!(notification(&json!({"notification":inner.clone()})), &inner);
    }

    #[tokio::test]
    async fn previews_require_policy_and_the_current_authenticated_account() {
        let root =
            std::env::temp_dir().join(format!("sable-push-policy-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("push-policy.json"),
            r#"{"enabled":true,"content":true,"encrypted_content":false,"sounds":true}"#,
        )
        .unwrap();
        let registry = json!({"version":1,"active_account_id":"a1","next_account_id":2,"accounts":[{
            "account_id":"a1","store_id":"old","needs_reauth":false,
            "session":{"homeserver":"https://example.org","credentials":{
                "kind":"password","user_id":"@alice:example.org","device_id":"A","access_token":"test"
            }}
        }]});
        let store = FileSessionStore::new(&root);
        store.save(registry.to_string().into_bytes()).await.unwrap();
        let mut payload = json!({"user_id":"@alice:example.org","notification":{
            "room_id":"!room:example.org","type":"m.room.message","content":{"body":"private"}
        }});
        assert_eq!(
            render(&root, &payload)
                .await
                .and_then(|value| value.get("body").cloned()),
            Some(json!("private"))
        );
        payload["user_id"] = json!("@other:example.org");
        assert!(render(&root, &payload).await.is_none());
        payload["user_id"] = json!("@alice:example.org");
        payload["notification"]["type"] = json!("m.room.encrypted");
        assert!(render(&root, &payload).await.is_none());
        payload["notification"]["type"] = json!("m.room.message");
        let mut expired = registry.clone();
        expired["accounts"][0]["needs_reauth"] = json!(true);
        store.save(expired.to_string().into_bytes()).await.unwrap();
        assert!(render(&root, &payload).await.is_none());
        store.save(registry.to_string().into_bytes()).await.unwrap();
        std::fs::write(
            root.join("push-policy.json"),
            r#"{"enabled":true,"content":false}"#,
        )
        .unwrap();
        assert!(render(&root, &payload).await.is_none());
        let ringing = json!({"user_id":"@alice:example.org","notification":{
            "room_id":"!room:example.org","type":"m.rtc.notification","sender":"@bob:example.org",
            "content":{"notification_type":"ring","sender_ts":1_000,"lifetime":30_000}
        }});
        assert_eq!(
            render(&root, &ringing)
                .await
                .and_then(|value| value.get("ring").cloned()),
            Some(json!({"caller_name":"@bob:example.org","expires_at":31.0}))
        );
        store.clear().await.unwrap();
        assert!(render(&root, &payload).await.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
