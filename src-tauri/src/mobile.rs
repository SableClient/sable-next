// The webview paints under transparent system bars, so only icon contrast is ours to set;
// `Window.setStatusBarColor` is a no-op from API 35.
// Tauri does not populate ndk-context, so MainActivity hands us the JavaVM on create.

use std::sync::{Arc, Mutex, OnceLock, Weak};

use jni::objects::{Global, JClass, JObject, JValue};
use jni::signature::MethodSignature;
use jni::strings::JNIString;
use jni::{EnvUnowned, JavaVM, jni_sig, jni_str};

static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();
static MAIN_ACTIVITY: OnceLock<Global<JClass<'static>>> = OnceLock::new();
static ACTIVITY: Mutex<(bool, Option<Weak<sable_core::Core>>)> = Mutex::new((true, None));

/// Takes the pending Java exception, which would otherwise abort the next JNI call.
pub(crate) fn caught<T>(env: &jni::Env, result: jni::errors::Result<T>) -> jni::errors::Result<T> {
    result.map_err(|error| env.exception_catch().err().unwrap_or(error))
}

pub(crate) fn describe(error: &jni::errors::Error) -> String {
    if let jni::errors::Error::CaughtJavaException {
        name, msg, stack, ..
    } = error
    {
        tracing::warn!("java call threw {name}: {msg}\n{stack}");
        return format!("{name}: {msg}");
    }
    error.to_string()
}

pub(crate) fn attach_activity(core: &Arc<sable_core::Core>) {
    let mut activity = ACTIVITY
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    activity.1 = Some(Arc::downgrade(core));
    crate::set_mobile_activity(core.clone(), activity.0);
}

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub(crate) extern "system" fn Java_moe_sable_client_AppLifecycle_nativeActivityChanged(
    _env: EnvUnowned,
    _this: JObject,
    active: jni::sys::jboolean,
) {
    let core = {
        let mut activity = ACTIVITY
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        activity.0 = active;
        activity.1.as_ref().and_then(Weak::upgrade)
    };
    if let Some(core) = core {
        crate::set_mobile_activity(core, active);
    }
}

#[tauri::command]
pub(crate) async fn open_in_app_auth_url(
    id: String,
    url: String,
    sheet: bool,
) -> Result<bool, String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "invalid authentication URL")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("authentication requires an HTTP or HTTPS URL".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let vm = JAVA_VM.get().ok_or("java vm not initialized")?;
        let class = MAIN_ACTIVITY
            .get()
            .ok_or("activity class not initialized")?;
        vm.attach_current_thread(|env| {
            let id = env.new_string(id)?;
            let url = env.new_string(parsed.as_str())?;
            let result = env
                .call_static_method(
                    class,
                    jni_str!("openAuthUrlNative"),
                    jni_sig!("(Ljava/lang/String;Ljava/lang/String;Z)Z"),
                    &[
                        JValue::Object(&id),
                        JValue::Object(&url),
                        JValue::Bool(sheet),
                    ],
                )
                .and_then(jni::JValueOwned::z);
            caught(env, result)
        })
        .map_err(|error| describe(&error))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn close_in_app_auth_window(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let vm = JAVA_VM.get().ok_or("java vm not initialized")?;
        let class = MAIN_ACTIVITY
            .get()
            .ok_or("activity class not initialized")?;
        vm.attach_current_thread(|env| {
            let id = env.new_string(id)?;
            let result = env.call_static_method(
                class,
                jni_str!("closeAuthWindowNative"),
                jni_sig!("(Ljava/lang/String;)V"),
                &[JValue::Object(&id)],
            );
            caught(env, result.map(|_| ()))
        })
        .map_err(|error| describe(&error))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn copy_image_to_clipboard(image: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let vm = JAVA_VM.get().ok_or("java vm not initialized")?;
        let class = MAIN_ACTIVITY
            .get()
            .ok_or("activity class not initialized")?;
        vm.attach_current_thread(|env| {
            let image = env.new_string(image)?;
            let result = env.call_static_method(
                class,
                jni_str!("copyImageToClipboardNative"),
                jni_sig!("(Ljava/lang/String;)V"),
                &[JValue::Object(&image)],
            );
            caught(env, result.map(|_| ()))
        })
        .map_err(|error| describe(&error))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[unsafe(no_mangle)]
#[expect(
    unsafe_code,
    reason = "the export symbol is fixed by the JNI naming convention"
)]
pub(crate) extern "system" fn Java_moe_sable_client_MainActivity_nativeNetworkChanged(
    _env: EnvUnowned,
    _this: JObject,
    available: jni::sys::jboolean,
    unmetered: jni::sys::jboolean,
) {
    crate::network::set_state(available, unmetered);
}

#[unsafe(no_mangle)]
#[expect(
    unsafe_code,
    reason = "the export symbol is fixed by the JNI naming convention"
)]
pub(crate) extern "system" fn Java_moe_sable_client_MainActivity_nativeSentryConsent(
    _env: EnvUnowned,
    _this: JObject,
    enabled: jni::sys::jboolean,
) {
    crate::sentry::restore_consent(enabled);
}

#[unsafe(no_mangle)]
#[expect(
    unsafe_code,
    reason = "the export symbol is fixed by the JNI naming convention"
)]
pub(crate) extern "system" fn Java_moe_sable_client_MainActivity_nativeInitSystemBars(
    mut env: EnvUnowned,
    this: JObject,
) {
    env.with_env(|env| {
        let vm = env.get_java_vm()?;
        // Native worker threads cannot look up application classes by name.
        let class = env.get_object_class(&this)?;
        let class = env.new_global_ref(class)?;
        let _ = MAIN_ACTIVITY.set(class);
        let _ = JAVA_VM.set(vm);
        Ok::<_, jni::errors::Error>(())
    })
    .resolve::<jni::errors::ThrowRuntimeExAndDefault>();
}

/// `light` asks for the icon treatment a light background needs: dark icons.
#[tauri::command]
pub(crate) fn set_status_bar_light(light: bool) -> Result<(), String> {
    call_activity_bool("setStatusBarLightNative", light)
}

#[tauri::command]
pub(crate) fn set_navigation_bar_light(light: bool) -> Result<(), String> {
    call_activity_bool("setNavigationBarLightNative", light)
}

#[tauri::command]
pub(crate) fn set_system_bars_hidden(hidden: bool) -> Result<(), String> {
    call_activity_bool("setSystemBarsHiddenNative", hidden)
}

#[tauri::command]
pub(crate) fn haptic_feedback(strong: bool) -> Result<(), String> {
    call_activity_bool("hapticFeedbackNative", strong)
}

/// `color` is an opaque ARGB value, as `android.graphics.Color` packs it.
#[tauri::command]
pub(crate) fn set_window_background(color: i32) -> Result<(), String> {
    call_activity(
        "setWindowBackgroundNative",
        jni_sig!("(I)V"),
        JValue::Int(color),
    )
}

pub(crate) fn set_sentry_enabled(enabled: bool) -> Result<(), String> {
    call_activity_bool("setSentryEnabledNative", enabled)
}

fn call_activity_bool(method: &str, value: bool) -> Result<(), String> {
    call_activity(method, jni_sig!("(Z)V"), JValue::Bool(value))
}

fn call_activity(
    method: &str,
    signature: MethodSignature<'static, 'static>,
    value: JValue,
) -> Result<(), String> {
    let vm = JAVA_VM.get().ok_or("java vm not initialized")?;
    let class = MAIN_ACTIVITY
        .get()
        .ok_or("activity class not initialized")?;
    vm.attach_current_thread(|env| {
        let result = env.call_static_method(class, JNIString::new(method), signature, &[value]);
        caught(env, result.map(|_| ()))
    })
    .map_err(|error| describe(&error))
}
