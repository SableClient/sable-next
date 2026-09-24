use std::sync::{Arc, OnceLock};

use jni::objects::{JClass, JString};
use jni::{Env, EnvUnowned};
use sable_core::Core;

pub static CORE: OnceLock<Arc<Core>> = OnceLock::new();

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub extern "system" fn Java_app_tauri_notification_PushPayloadDecryptor_nativeDecryptPush<
    'frame,
>(
    mut unowned_env: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    store_dir: JString<'frame>,
    user_id: JString<'frame>,
    device_id: JString<'frame>,
    room_id: JString<'frame>,
    event_json: JString<'frame>,
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
                ),
            )
            .await
            .ok()
            .flatten()
        };
        let clear = if core.is_some() {
            tauri::async_runtime::block_on(decrypt)
        } else {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .ok()
                .and_then(|runtime| runtime.block_on(decrypt))
        }
        .unwrap_or_default();

        JString::from_str(env, clear)
    });

    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
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
