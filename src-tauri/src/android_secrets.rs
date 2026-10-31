use jni::objects::{Global, JByteArray, JClass, JObject, JValue};
use jni::{EnvUnowned, JavaVM, jni_sig, jni_str};
use sable_core::secrets::SecretBackend;
use sable_core::store::StoreError;

struct KeystoreSecrets {
    vm: JavaVM,
    // Native worker threads cannot look up application classes by name.
    class: Global<JClass<'static>>,
    context: Global<JObject<'static>>,
}

fn failure(error: &jni::errors::Error) -> StoreError {
    StoreError::Message(error.to_string())
}

impl SecretBackend for KeystoreSecrets {
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.vm
            .attach_current_thread(|env| {
                let name = env.new_string(name)?;
                let result = env.call_static_method(
                    &self.class,
                    jni_str!("get"),
                    jni_sig!("(Landroid/content/Context;Ljava/lang/String;)[B"),
                    &[JValue::Object(&self.context), JValue::Object(&name)],
                );
                let secret = match result {
                    Ok(secret) => secret.l()?,
                    Err(error) => {
                        env.exception_clear();
                        return Err(error);
                    }
                };
                if secret.is_null() {
                    return Ok(None);
                }
                let secret = env.cast_local::<JByteArray>(secret)?;
                env.convert_byte_array(&secret).map(Some)
            })
            .map_err(|error| failure(&error))
    }

    fn set(&self, name: &str, secret: &[u8]) -> Result<(), StoreError> {
        self.vm
            .attach_current_thread(|env| {
                let name = env.new_string(name)?;
                let secret = env.byte_array_from_slice(secret)?;
                let result = env.call_static_method(
                    &self.class,
                    jni_str!("set"),
                    jni_sig!("(Landroid/content/Context;Ljava/lang/String;[B)V"),
                    &[
                        JValue::Object(&self.context),
                        JValue::Object(&name),
                        JValue::Object(&secret),
                    ],
                );
                if result.is_err() {
                    env.exception_clear();
                }
                result.map(drop)
            })
            .map_err(|error| failure(&error))
    }

    fn delete(&self, name: &str) -> Result<(), StoreError> {
        self.vm
            .attach_current_thread(|env| {
                let name = env.new_string(name)?;
                let result = env.call_static_method(
                    &self.class,
                    jni_str!("delete"),
                    jni_sig!("(Landroid/content/Context;Ljava/lang/String;)V"),
                    &[JValue::Object(&self.context), JValue::Object(&name)],
                );
                if result.is_err() {
                    env.exception_clear();
                }
                result.map(drop)
            })
            .map_err(|error| failure(&error))
    }
}

#[unsafe(no_mangle)]
#[expect(unsafe_code, reason = "JNI entry point")]
pub extern "system" fn Java_moe_sable_push_Secrets_nativeInstall<'frame>(
    mut unowned_env: EnvUnowned<'frame>,
    class: JClass<'frame>,
    context: JObject<'frame>,
) {
    unowned_env
        .with_env(|env| {
            let backend = KeystoreSecrets {
                vm: env.get_java_vm()?,
                class: env.new_global_ref(class)?,
                context: env.new_global_ref(context)?,
            };
            sable_core::secrets::install(Box::new(backend));
            Ok::<_, jni::errors::Error>(())
        })
        .resolve::<jni::errors::ThrowRuntimeExAndDefault>();
}
