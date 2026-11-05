use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use jni::objects::{JClass, JString};
use jni::{Env, EnvUnowned};
use sable_core::Core;
use sable_core::notifications::{ColdPush, settle_refreshes};
use sable_core::protocol::PushFetchView;

pub(crate) static CORE: OnceLock<Arc<Core>> = OnceLock::new();

const DISCARD: &str = "discard";
const DISCARD_UNEVALUATED: &str = "discard-unevaluated";
const NEEDS_KEY: &str = "needs-key";
const NEEDS_KEY_QUIETLY: &str = "needs-key-quietly";

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub(crate) extern "system" fn Java_moe_sable_push_PushPayloadDecryptor_nativePreviewBody<'frame>(
    mut unowned_env: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    body: JString<'frame>,
    formatted: JString<'frame>,
) -> JString<'frame> {
    let result = unowned_env.with_env(|env: &mut Env<'frame>| -> Result<_, jni::errors::Error> {
        let preview =
            sable_core::matrix_html::preview_body(&body.to_string(), Some(&formatted.to_string()));
        JString::from_str(env, preview)
    });
    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub(crate) extern "system" fn Java_moe_sable_push_PushPayloadDecryptor_nativeDecryptPush<'frame>(
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
pub(crate) extern "system" fn Java_moe_sable_push_PushPayloadDecryptor_nativeDecryptPushLocally<
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
        let args = ColdArgs::new(store_dir, user_id, device_id, room_id);
        let event_json = event_json.to_string();
        let result = args.run(
            Duration::from_secs(20),
            ColdPush::Undecryptable,
            sable_core::notifications::decrypt_cold_push(
                args.store(),
                &args.user_id,
                &args.device_id,
                &args.room_id,
                &event_json,
                fetch_keys,
            ),
        );

        JString::from_str(env, encode(result))
    });

    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

struct ColdArgs {
    data_dir: String,
    user_id: String,
    device_id: String,
    room_id: String,
}

impl ColdArgs {
    fn new(
        store_dir: &JString<'_>,
        user_id: &JString<'_>,
        device_id: &JString<'_>,
        room_id: &JString<'_>,
    ) -> Self {
        Self {
            data_dir: store_dir.to_string(),
            user_id: user_id.to_string(),
            device_id: device_id.to_string(),
            room_id: room_id.to_string(),
        }
    }

    fn store(&self) -> &Path {
        Path::new(&self.data_dir)
    }

    fn run<T>(&self, limit: Duration, fallback: T, operation: impl Future<Output = T>) -> T {
        block_on(
            CORE.get().is_some(),
            bounded(&self.data_dir, limit, operation),
        )
        .flatten()
        .unwrap_or(fallback)
    }

    async fn session(&self) -> Option<sable_core::notifications::PushSession> {
        sable_core::notifications::cold_push_session(
            self.store(),
            &self.user_id,
            &self.device_id,
            &self.room_id,
        )
        .await
    }
}

/// A cancelled push may leave its cached client half-way through a request.
async fn bounded<T>(
    data_dir: &str,
    limit: Duration,
    operation: impl Future<Output = T>,
) -> Option<T> {
    let result = settle_refreshes(Box::pin(tokio::time::timeout(limit, operation)))
        .await
        .ok();
    if result.is_none() {
        sable_core::notifications::evict_push_cache(
            &sable_core::notifications::cold_push_store_dir(Path::new(data_dir)),
        );
    }
    result
}

/// The cached push client's background tasks need a runtime that outlives each call.
fn cold_runtime() -> Option<&'static tokio::runtime::Runtime> {
    static RUNTIME: std::sync::OnceLock<Option<tokio::runtime::Runtime>> =
        std::sync::OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .ok()
        })
        .as_ref()
}

fn block_on<T>(live: bool, future: impl Future<Output = T>) -> Option<T> {
    if live {
        return Some(tauri::async_runtime::block_on(future));
    }
    cold_runtime().map(|runtime| runtime.block_on(future))
}

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub(crate) extern "system" fn Java_moe_sable_push_PushPayloadDecryptor_nativeFetchPush<'frame>(
    mut unowned_env: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    store_dir: JString<'frame>,
    user_id: JString<'frame>,
    device_id: JString<'frame>,
    room_id: JString<'frame>,
    event_id: JString<'frame>,
) -> JString<'frame> {
    let result = unowned_env.with_env(|env: &mut Env<'frame>| -> Result<_, jni::errors::Error> {
        let args = ColdArgs::new(&store_dir, &user_id, &device_id, &room_id);
        let event_id = event_id.to_string();
        let result = args.run(
            Duration::from_secs(20),
            PushFetchView::Unavailable,
            sable_core::notifications::fetch_cold_push_event(
                args.store(),
                &args.user_id,
                &args.device_id,
                &args.room_id,
                &event_id,
            ),
        );

        JString::from_str(env, encode_fetch(&result))
    });

    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub(crate) extern "system" fn Java_moe_sable_push_PushPayloadDecryptor_nativeActiveElsewhere<
    'frame,
>(
    mut unowned_env: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    store_dir: JString<'frame>,
    user_id: JString<'frame>,
    device_id: JString<'frame>,
    room_id: JString<'frame>,
) -> jni::sys::jboolean {
    let result = unowned_env.with_env(|_env: &mut Env<'frame>| -> Result<_, jni::errors::Error> {
        let args = ColdArgs::new(&store_dir, &user_id, &device_id, &room_id);
        let active = args.run(
            Duration::from_secs(5),
            false,
            sable_core::notifications::cold_push_active_elsewhere(
                args.store(),
                &args.user_id,
                &args.device_id,
                &args.room_id,
            ),
        );
        Ok(jni::sys::jboolean::from(active))
    });

    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub(crate) extern "system" fn Java_moe_sable_push_PushPayloadDecryptor_nativeReadRooms<'frame>(
    mut unowned_env: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    store_dir: JString<'frame>,
    user_id: JString<'frame>,
    device_id: JString<'frame>,
    seed_room_id: JString<'frame>,
    room_ids: JString<'frame>,
) -> JString<'frame> {
    let result = unowned_env.with_env(|env: &mut Env<'frame>| -> Result<_, jni::errors::Error> {
        let args = ColdArgs::new(&store_dir, &user_id, &device_id, &seed_room_id);
        let read = serde_json::from_str::<Vec<String>>(&room_ids.to_string())
            .ok()
            .and_then(|room_ids| {
                args.run(Duration::from_secs(5), None, async {
                    args.session().await?.read_rooms(&room_ids).await
                })
            });
        JString::from_str(
            env,
            read.map_or_else(String::new, |rooms| {
                serde_json::to_string(&rooms).unwrap_or_default()
            }),
        )
    });
    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

/// An empty `sender` skips the avatars, an empty `content` the message's image.
#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub(crate) extern "system" fn Java_moe_sable_push_PushPayloadDecryptor_nativePushMedia<'frame>(
    mut unowned_env: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    store_dir: JString<'frame>,
    user_id: JString<'frame>,
    device_id: JString<'frame>,
    room_id: JString<'frame>,
    sender: JString<'frame>,
    payload_name: JString<'frame>,
    content: JString<'frame>,
) -> JString<'frame> {
    let result = unowned_env.with_env(|env: &mut Env<'frame>| -> Result<_, jni::errors::Error> {
        let args = ColdArgs::new(&store_dir, &user_id, &device_id, &room_id);
        let sender = sender.to_string();
        let sender = Some(sender.as_str()).filter(|sender| !sender.is_empty());
        let payload_name = payload_name.to_string();
        let content = serde_json::from_str::<serde_json::Value>(&content.to_string()).ok();
        let fallback = sable_core::notifications::PushMedia {
            sender_name: sable_core::notifications::push_sender_name(sender, Some(&payload_name)),
            ..Default::default()
        };
        let media = args.run(
            Duration::from_secs(5),
            fallback,
            sable_core::notifications::cold_push_media(
                args.store(),
                &args.user_id,
                &args.device_id,
                &args.room_id,
                sender,
                Some(&payload_name),
                content.as_ref(),
            ),
        );

        JString::from_str(env, serde_json::to_string(&media).unwrap_or_default())
    });

    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub(crate) extern "system" fn Java_moe_sable_push_PushPayloadDecryptor_nativeReply<'frame>(
    mut unowned_env: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    store_dir: JString<'frame>,
    user_id: JString<'frame>,
    device_id: JString<'frame>,
    room_id: JString<'frame>,
    text: JString<'frame>,
    transaction_id: JString<'frame>,
    event_id: JString<'frame>,
    private_receipt: jni::sys::jboolean,
) -> jni::sys::jboolean {
    let result = unowned_env.with_env(|_: &mut Env<'frame>| -> Result<_, jni::errors::Error> {
        let args = ColdArgs::new(&store_dir, &user_id, &device_id, &room_id);
        let (text, transaction_id, event_id) = (
            text.to_string(),
            transaction_id.to_string(),
            event_id.to_string(),
        );
        Ok(args.run(Duration::from_secs(20), false, async {
            let Some(session) = args.session().await else {
                return false;
            };
            session
                .reply(&text, &transaction_id, &event_id, private_receipt)
                .await
        }))
    });
    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub(crate) extern "system" fn Java_moe_sable_push_PushPayloadDecryptor_nativeMarkRead<'frame>(
    mut unowned_env: EnvUnowned<'frame>,
    _class: JClass<'frame>,
    store_dir: JString<'frame>,
    user_id: JString<'frame>,
    device_id: JString<'frame>,
    room_id: JString<'frame>,
    event_id: JString<'frame>,
    private_receipt: jni::sys::jboolean,
) -> jni::sys::jboolean {
    let result = unowned_env.with_env(|_: &mut Env<'frame>| -> Result<_, jni::errors::Error> {
        let args = ColdArgs::new(&store_dir, &user_id, &device_id, &room_id);
        let event_id = event_id.to_string();
        Ok(args.run(Duration::from_secs(20), false, async {
            let Some(session) = args.session().await else {
                return false;
            };
            session.mark_read(&event_id, private_receipt).await
        }))
    });
    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}

fn encode_fetch(result: &PushFetchView) -> String {
    match result {
        PushFetchView::Event { event } => serde_json::to_string(event).unwrap_or_default(),
        PushFetchView::Discard => DISCARD.to_owned(),
        PushFetchView::Unavailable => String::new(),
    }
}

fn encode(result: ColdPush) -> String {
    match result {
        ColdPush::Clear(clear) => clear,
        ColdPush::Discard => DISCARD.to_owned(),
        ColdPush::Unevaluated => DISCARD_UNEVALUATED.to_owned(),
        ColdPush::NeedsKey { quietly: false } => NEEDS_KEY.to_owned(),
        ColdPush::NeedsKey { quietly: true } => NEEDS_KEY_QUIETLY.to_owned(),
        ColdPush::Undecryptable => String::new(),
    }
}

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub(crate) extern "system" fn Java_moe_sable_push_PushPayloadDecryptor_nativeMaintainPush<
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
                block_on(CORE.get().is_some(), async {
                    settle_refreshes(Box::pin(tokio::time::timeout(
                        Duration::from_secs(20),
                        crate::notifications::maintain_background_push(&root, operation),
                    )))
                    .await
                    .ok()?
                    .ok()
                })?
            })
            .is_some();
        JString::from_str(env, if success { "ok" } else { "retry" })
    });
    result.resolve::<jni::errors::ThrowRuntimeExAndDefault>()
}
