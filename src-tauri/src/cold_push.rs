use std::sync::{Arc, OnceLock};

use jni::objects::{JClass, JString};
use jni::{Env, EnvUnowned};
use sable_core::Core;
use sable_core::notifications::ColdPush;

pub static CORE: OnceLock<Arc<Core>> = OnceLock::new();

const DISCARD: &str = "discard";
const NEEDS_KEY: &str = "needs-key";
const NEEDS_KEY_QUIETLY: &str = "needs-key-quietly";

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub extern "system" fn Java_app_tauri_notification_PushPayloadDecryptor_nativeDecryptPush<
    'frame,
>(
    unowned_env: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    store_dir: JString<'frame>,
    user_id: JString<'frame>,
    device_id: JString<'frame>,
    room_id: JString<'frame>,
    event_json: JString<'frame>,
) -> JString<'frame> {
    decrypt_push(
        unowned_env,
        &store_dir,
        &user_id,
        &device_id,
        &room_id,
        &event_json,
        true,
    )
}

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub extern "system" fn Java_app_tauri_notification_PushPayloadDecryptor_nativeDecryptPushLocally<
    'frame,
>(
    unowned_env: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    store_dir: JString<'frame>,
    user_id: JString<'frame>,
    device_id: JString<'frame>,
    room_id: JString<'frame>,
    event_json: JString<'frame>,
) -> JString<'frame> {
    decrypt_push(
        unowned_env,
        &store_dir,
        &user_id,
        &device_id,
        &room_id,
        &event_json,
        false,
    )
}

fn decrypt_push<'frame>(
    mut unowned_env: EnvUnowned<'frame>,
    store_dir: &JString<'frame>,
    user_id: &JString<'frame>,
    device_id: &JString<'frame>,
    room_id: &JString<'frame>,
    event_json: &JString<'frame>,
    fetch_keys: bool,
) -> JString<'frame> {
    let result = unowned_env.with_env(|env: &mut Env<'frame>| -> Result<_, jni::errors::Error> {
        let data_dir = store_dir.to_string();
        let user_id = user_id.to_string();
        let device_id = device_id.to_string();
        let room_id = room_id.to_string();
        let event_json = event_json.to_string();
        let core = CORE.get();
        let decrypt = async {
            tokio::time::timeout(
                std::time::Duration::from_secs(20),
                sable_core::notifications::decrypt_cold_push(
                    core.map(Arc::as_ref),
                    std::path::Path::new(&data_dir),
                    &user_id,
                    &device_id,
                    &room_id,
                    &event_json,
                    fetch_keys,
                ),
            )
            .await
            .unwrap_or(ColdPush::Undecryptable)
        };
        let result = if core.is_some() {
            tauri::async_runtime::block_on(decrypt)
        } else {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_or(ColdPush::Undecryptable, |runtime| runtime.block_on(decrypt))
        };

        JString::from_str(env, encode(result))
    });

    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

fn encode(result: ColdPush) -> String {
    match result {
        ColdPush::Clear(clear) => clear,
        ColdPush::Discard => DISCARD.to_owned(),
        ColdPush::NeedsKey { quietly: false } => NEEDS_KEY.to_owned(),
        ColdPush::NeedsKey { quietly: true } => NEEDS_KEY_QUIETLY.to_owned(),
        ColdPush::Undecryptable => String::new(),
    }
}

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub extern "system" fn Java_app_tauri_notification_PushPayloadDecryptor_nativeMaintainPush<
    'frame,
>(
    mut unowned_env: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    store_dir: JString<'frame>,
    operation: JString<'frame>,
) -> JString<'frame> {
    let result = unowned_env.with_env(|env: &mut Env<'frame>| -> Result<_, jni::errors::Error> {
        let root = std::path::PathBuf::from(store_dir.to_string());
        let success = serde_json::from_str(&operation.to_string())
            .ok()
            .and_then(|operation| {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .ok()?;
                runtime.block_on(async {
                    tokio::time::timeout(
                        std::time::Duration::from_secs(20),
                        crate::notifications::maintain_background_push(&root, operation),
                    )
                    .await
                    .ok()?
                    .ok()
                })
            })
            .is_some();
        JString::from_str(env, if success { "ok" } else { "retry" })
    });
    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}
