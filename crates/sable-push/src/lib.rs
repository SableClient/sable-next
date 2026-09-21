//! Bounded, UI-independent notification decryption for the iOS service extension.

use std::ffi::{CStr, CString, c_char};
use std::path::Path;

use sable_core::session::AccountRegistry;
use sable_core::store::{FileSessionStore, SessionStore};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Default, Deserialize)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "persisted notification preferences"
)]
struct Policy {
    enabled: bool,
    content: bool,
    encrypted_content: bool,
    sounds: bool,
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

fn notification(payload: &Value) -> &Value {
    payload.get("notification").unwrap_or(payload)
}

async fn render(root: &Path, payload: &Value) -> Option<Value> {
    let settings = policy(root);
    if !settings.enabled || !settings.content {
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
        if !settings.encrypted_content {
            return None;
        }
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
            std::fs::write(root.join("push-policy.json"), json!({"enabled":enabled,"content":content,"encrypted_content":false,"sounds":sounds}).to_string()).unwrap();
            // SAFETY: path remains alive throughout the call.
            assert_eq!(unsafe { sable_push_sounds(path.as_ptr()) }, expected);
        }
        // SAFETY: null is explicitly accepted by this ABI.
        assert!(!unsafe { sable_push_sounds(std::ptr::null()) });
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
        store.clear().await.unwrap();
        assert!(render(&root, &payload).await.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
