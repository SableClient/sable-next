use jni::objects::{JClass, JString};
use jni::{Env, EnvUnowned};

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
        let clear = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()
            .and_then(|runtime| {
                runtime.block_on(sable_core::notifications::decrypt_cold_push(
                    std::path::Path::new(&data_dir),
                    &user_id,
                    &device_id,
                    &room_id,
                    &event_json,
                ))
            })
            .unwrap_or_default();

        JString::from_str(env, clear)
    });

    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}
