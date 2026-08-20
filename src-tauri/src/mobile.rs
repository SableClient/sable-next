// The edge-to-edge plugin leaves the system bars transparent and the webview
// paints under them, so the bar colour is already whatever the page draws.
// `Window.setStatusBarColor` cannot change it either: it is a no-op under
// enforced edge-to-edge from API 35, and this app targets 36. What is left is
// the icon contrast, which only the window insets controller can set.
//
// Rust cannot reach the Activity directly, since Tauri does not populate
// ndk-context, so MainActivity hands us the JavaVM on create and we call back
// into a static method that owns the window.

use std::sync::OnceLock;

use jni::objects::{JObject, JValue};
use jni::strings::JNIString;
use jni::{jni_sig, jni_str, EnvUnowned, JavaVM};

static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();

#[no_mangle]
#[expect(
    unsafe_code,
    reason = "the export symbol is fixed by the JNI naming convention"
)]
pub extern "system" fn Java_moe_sable_next_MainActivity_nativeInitSystemBars(
    mut env: EnvUnowned,
    _this: JObject,
) {
    let _ = env.with_env(|env| {
        let vm = env.get_java_vm()?;
        let _ = JAVA_VM.set(vm);
        Ok::<_, jni::errors::Error>(())
    });
}

/// `light` asks for the icon treatment a light background needs: dark icons.
#[tauri::command]
pub fn set_status_bar_light(light: bool) -> Result<(), String> {
    call_bar_light("setStatusBarLightNative", light)
}

#[tauri::command]
pub fn set_navigation_bar_light(light: bool) -> Result<(), String> {
    call_bar_light("setNavigationBarLightNative", light)
}

fn call_bar_light(method: &str, light: bool) -> Result<(), String> {
    let vm = JAVA_VM.get().ok_or("java vm not initialized")?;
    vm.attach_current_thread(|env| {
        let result = env.call_static_method(
            jni_str!("moe/sable/next/MainActivity"),
            JNIString::new(method),
            jni_sig!("(Z)V"),
            &[JValue::Bool(light)],
        );
        if result.is_err() {
            env.exception_clear();
        }
        result.map(|_| ())
    })
    .map_err(|error| error.to_string())
}
