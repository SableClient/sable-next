use std::{
    ffi::{CString, OsStr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};

use block2::RcBlock;
use objc2::{
    msg_send,
    runtime::{AnyClass, AnyObject, ClassBuilder, Sel},
    sel,
};
use objc2_foundation::{NSString, NSURL};
use objc2_photos::{
    PHAccessLevel, PHAssetCreationRequest, PHAssetResourceType, PHAuthorizationStatus,
    PHPhotoLibrary,
};

#[tauri::command]
pub async fn open_in_app_auth_url(
    window: tauri::WebviewWindow,
    id: String,
    url: String,
) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "invalid authentication URL")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("authentication requires an HTTP or HTTPS URL".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            let sender = Mutex::new(Some(sender));
            let completion = RcBlock::new(move |presented: objc2::runtime::Bool| {
                if let Ok(mut sender) = sender.lock()
                    && let Some(sender) = sender.take()
                {
                    let _ = sender.send(presented.as_bool());
                }
            });
            let Some(class) = AnyClass::get(c"SableAuthBrowser") else {
                return;
            };
            let value = NSString::from_str(parsed.as_str());
            let id = NSString::from_str(&id);
            let Some(url) = NSURL::URLWithString(&value) else {
                return;
            };
            // with_webview runs on the main thread and owns the view controller.
            unsafe {
                let controller: &AnyObject = &*webview.view_controller().cast();
                let _: () = msg_send![class,
                    presentURL: &*url,
                    id: &*id,
                    from: controller,
                    completion: &*completion
                ];
            }
        })
        .map_err(|error| error.to_string())?;
    if receiver
        .await
        .map_err(|_| "authentication browser is unavailable")?
    {
        Ok(())
    } else {
        Err("authentication browser could not be presented".into())
    }
}

#[tauri::command]
pub async fn close_in_app_auth_window(
    window: tauri::WebviewWindow,
    id: String,
) -> Result<(), String> {
    window
        .with_webview(move |_| {
            if let Some(class) = AnyClass::get(c"SableAuthBrowser") {
                let id = NSString::from_str(&id);
                unsafe {
                    let _: () = msg_send![class, dismissWithId: &*id];
                }
            }
        })
        .map_err(|error| error.to_string())
}

pub(crate) fn watch_network(core: &std::sync::Arc<sable_core::Core>) -> Result<(), String> {
    let class = AnyClass::get(c"SableNetwork").ok_or("network monitor bridge is unavailable")?;
    let core = std::sync::Arc::downgrade(core);
    let handler = RcBlock::new(move |unmetered: objc2::runtime::Bool| {
        if let Some(core) = core.upgrade() {
            core.set_search_network_unmetered(unmetered.as_bool());
        }
    });
    unsafe {
        let _: () = msg_send![class, startWithHandler: &*handler];
    }
    Ok(())
}

/// Synchronizes the native SDK with the webview's telemetry preference.
pub fn set_sentry_enabled(enabled: bool) -> Result<(), String> {
    let class = AnyClass::get(c"SableSentry").ok_or("Sentry Cocoa bridge is unavailable")?;
    let dsn = NSString::from_str(option_env!("SENTRY_DSN").unwrap_or_default());
    let environment = NSString::from_str(option_env!("SENTRY_ENVIRONMENT").unwrap_or_default());
    let release = NSString::from_str(option_env!("SENTRY_APP_VERSION").unwrap_or_default());
    unsafe {
        let _: () = msg_send![class,
            setEnabled: enabled,
            dsn: &*dsn,
            environment: &*environment,
            release: &*release
        ];
    }
    share_sentry_consent(enabled)
}

/// The notification extension reports failures only while this file exists.
fn share_sentry_consent(enabled: bool) -> Result<(), String> {
    let path = shared_store_dir()?.join("sentry.json");
    let Some(dsn) = option_env!("SENTRY_DSN").filter(|dsn| enabled && !dsn.is_empty()) else {
        return match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        };
    };
    let value = serde_json::json!({
        "dsn": dsn,
        "environment": option_env!("SENTRY_ENVIRONMENT"),
        "release": option_env!("SENTRY_APP_VERSION"),
    });
    std::fs::write(path, value.to_string()).map_err(|error| error.to_string())
}

/// # Errors
/// When the Info.plist lacks `SableKeychainGroup`.
pub fn keychain_group() -> Result<String, String> {
    use objc2_foundation::NSBundle;
    NSBundle::mainBundle()
        .objectForInfoDictionaryKey(&NSString::from_str("SableKeychainGroup"))
        .and_then(|value| value.downcast::<NSString>().ok())
        .map(|group| group.to_string())
        .ok_or_else(|| "missing SableKeychainGroup in Info.plist".to_owned())
}

/// # Errors
/// When the signed app has no accessible App Group container.
pub fn shared_store_dir() -> Result<std::path::PathBuf, String> {
    use objc2_foundation::{NSBundle, NSFileManager};
    let bundle = NSBundle::mainBundle();
    let identifier = bundle
        .bundleIdentifier()
        .ok_or("missing bundle identifier")?;
    let group = NSString::from_str(&format!("group.{identifier}"));
    let url = NSFileManager::defaultManager()
        .containerURLForSecurityApplicationGroupIdentifier(&group)
        .ok_or("App Group container unavailable; enable the shared App Group entitlement")?;
    let path = url
        .path()
        .ok_or("App Group container has no filesystem path")?;
    let root = std::path::PathBuf::from(path.to_string()).join("Sable");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

/// # Errors
/// When the shared policy cannot be written.
#[expect(
    clippy::fn_params_excessive_bools,
    reason = "persisted notification preferences"
)]
pub fn write_push_policy(
    enabled: bool,
    content: bool,
    encrypted_content: bool,
    sounds: bool,
    notify_once: bool,
    clear_on_read: bool,
    quiet_when_active_elsewhere: bool,
) -> Result<(), String> {
    let root = shared_store_dir()?;
    let value = serde_json::json!({"enabled":enabled,"content":content,"encrypted_content":encrypted_content,"sounds":sounds,"notify_once":notify_once,"clear_on_read":clear_on_read,"quiet_when_active_elsewhere":quiet_when_active_elsewhere});
    sable_core::store::write_atomic(&root.join("push-policy.json"), value.to_string().as_bytes())
        .map_err(|error| error.to_string())
}

#[link(name = "Photos", kind = "framework")]
unsafe extern "C" {}

fn allowed(status: PHAuthorizationStatus) -> bool {
    status == PHAuthorizationStatus::Authorized || status == PHAuthorizationStatus::Limited
}

fn authorize_blocking() -> Result<(), String> {
    let status =
        unsafe { PHPhotoLibrary::authorizationStatusForAccessLevel(PHAccessLevel::AddOnly) };
    if allowed(status) {
        return Ok(());
    }
    if status != PHAuthorizationStatus::NotDetermined {
        return Err("photo library access was denied".into());
    }

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let sender = Mutex::new(Some(sender));
    let handler: RcBlock<dyn Fn(PHAuthorizationStatus)> = RcBlock::new(move |status| {
        if let Ok(mut sender) = sender.lock()
            && let Some(sender) = sender.take()
        {
            let _ = sender.send(status);
        }
    });
    unsafe {
        PHPhotoLibrary::requestAuthorizationForAccessLevel_handler(
            PHAccessLevel::AddOnly,
            &handler,
        );
    }
    if allowed(
        receiver
            .recv()
            .map_err(|_| "photo authorization request was cancelled")?,
    ) {
        Ok(())
    } else {
        Err("photo library access was denied".into())
    }
}

async fn authorize() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(authorize_blocking)
        .await
        .map_err(|error| error.to_string())?
}

fn write_to_photos(
    bytes: &[u8],
    filename: &str,
    resource_type: PHAssetResourceType,
) -> Result<(), String> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let leaf = std::path::Path::new(filename)
        .file_name()
        .unwrap_or_else(|| OsStr::new("image"));
    let path = std::env::temp_dir().join(format!(
        "sable-photos-{}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed),
        leaf.to_string_lossy()
    ));
    std::fs::write(&path, bytes).map_err(|error| format!("failed to write photo: {error}"))?;
    let result = unsafe {
        let path = NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath(&path);
        let change: RcBlock<dyn Fn()> = RcBlock::new(move || {
            let request = PHAssetCreationRequest::creationRequestForAsset();
            request.addResourceWithType_fileURL_options(resource_type, &url, None);
        });
        PHPhotoLibrary::sharedPhotoLibrary()
            .performChangesAndWait_error(RcBlock::as_ptr(&change))
            .map_err(|error| {
                format!(
                    "failed to save media to Photos: {}",
                    error.localizedDescription()
                )
            })
    };
    let _ = std::fs::remove_file(path);
    result
}

#[tauri::command]
pub async fn save_media_to_photos(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("the media bytes must ride the request body".into());
    };
    let filename = crate::decode_header(&request, "filename").ok_or("missing filename")?;
    let mime_type = crate::decode_header(&request, "mime-type").ok_or("missing mime-type")?;
    let resource_type = if mime_type.starts_with("image/") {
        PHAssetResourceType::Photo
    } else if mime_type.starts_with("video/") {
        PHAssetResourceType::Video
    } else {
        return Err("only images and videos can be saved to Photos".into());
    };
    let bytes = bytes.clone();
    authorize().await?;
    tauri::async_runtime::spawn_blocking(move || write_to_photos(&bytes, &filename, resource_type))
        .await
        .map_err(|error| error.to_string())?
}

// WKWebView cannot hide the form accessory bar, so swap WKContentView's class for a subclass whose inputAccessoryView is nil.
extern "C-unwind" fn input_accessory_view_nil(_this: &AnyObject, _cmd: Sel) -> *mut AnyObject {
    std::ptr::null_mut()
}

pub fn hide_form_accessory_bar(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        let webview: *mut AnyObject = webview.inner().cast();
        let scroll_view: *mut AnyObject = msg_send![&*webview, scrollView];
        let subviews: *mut AnyObject = msg_send![&*scroll_view, subviews];
        let count: usize = msg_send![&*subviews, count];
        for index in 0..count {
            let subview: *mut AnyObject = msg_send![&*subviews, objectAtIndex: index];
            let class = (*subview).class();
            if !class.name().to_bytes().starts_with(b"WKContent") {
                continue;
            }
            let Ok(name) =
                CString::new(format!("{}_NoAccessoryBar", class.name().to_string_lossy()))
            else {
                continue;
            };
            // Registered once per process; a second window finds it by name.
            let subclass = match AnyClass::get(&name) {
                Some(subclass) => subclass,
                None => {
                    let Some(mut builder) = ClassBuilder::new(&name, class) else {
                        continue;
                    };
                    builder.add_method(
                        sel!(inputAccessoryView),
                        input_accessory_view_nil as extern "C-unwind" fn(_, _) -> _,
                    );
                    builder.register()
                }
            };
            AnyObject::set_class(&*subview, subclass);
        }
    });
}

#[tauri::command]
pub fn set_system_bars_hidden(window: tauri::WebviewWindow, hidden: bool) -> Result<(), String> {
    window
        .with_webview(move |webview| unsafe {
            let controller: *mut AnyObject = webview.view_controller().cast();
            let _: () = msg_send![&*controller, setPrefersStatusBarHidden: hidden];
            let _: () = msg_send![&*controller, setPrefersHomeIndicatorAutoHidden: hidden];
        })
        .map_err(|error| error.to_string())
}

#[link(name = "UIKit", kind = "framework")]
unsafe extern "C" {
    static UIBackgroundTaskInvalid: usize;
    static UIApplicationWillResignActiveNotification: &'static NSString;
    static UIApplicationDidEnterBackgroundNotification: &'static NSString;
    static UIApplicationWillEnterForegroundNotification: &'static NSString;
    static UIApplicationDidBecomeActiveNotification: &'static NSString;
}

const UI_APPLICATION_STATE_BACKGROUND: isize = 2;

/// A push or call wake launches the app here without it ever resigning active.
pub(crate) fn in_background() -> bool {
    let state: isize = unsafe { msg_send![shared_application(), applicationState] };
    state == UI_APPLICATION_STATE_BACKGROUND
}

#[derive(Clone, Copy)]
pub(crate) enum Lifecycle {
    ResignActive,
    EnterBackground,
    EnterForeground,
    BecomeActive,
}

/// tao's `Focused` follows the key window, which also changes in the background.
pub(crate) fn observe_lifecycle(handler: impl Fn(Lifecycle) + 'static) {
    let handler = std::rc::Rc::new(handler);
    let center: &AnyObject =
        unsafe { msg_send![objc2::class!(NSNotificationCenter), defaultCenter] };
    let queue: &AnyObject = unsafe { msg_send![objc2::class!(NSOperationQueue), mainQueue] };
    let observed = unsafe {
        [
            (
                UIApplicationWillResignActiveNotification,
                Lifecycle::ResignActive,
            ),
            (
                UIApplicationDidEnterBackgroundNotification,
                Lifecycle::EnterBackground,
            ),
            (
                UIApplicationWillEnterForegroundNotification,
                Lifecycle::EnterForeground,
            ),
            (
                UIApplicationDidBecomeActiveNotification,
                Lifecycle::BecomeActive,
            ),
        ]
    };
    for (name, change) in observed {
        let handler = handler.clone();
        let block = RcBlock::new(move |_: *mut AnyObject| (*handler)(change));
        let _: objc2::rc::Retained<AnyObject> = unsafe {
            msg_send![center,
                addObserverForName: name,
                object: std::ptr::null::<AnyObject>(),
                queue: queue,
                usingBlock: &*block
            ]
        };
    }
}

/// iOS kills a process suspended mid-write to the App Group stores.
pub(crate) struct BackgroundTask(Arc<AtomicUsize>);

impl BackgroundTask {
    pub(crate) fn is_active(&self) -> bool {
        self.0.load(Ordering::SeqCst) != unsafe { UIBackgroundTaskInvalid }
    }

    /// Call on the main thread so the expiration handler cannot run before the identifier is stored.
    pub(crate) fn begin(name: &str) -> Self {
        let task = Arc::new(AtomicUsize::new(unsafe { UIBackgroundTaskInvalid }));
        let expired = task.clone();
        let handler = RcBlock::new(move || end_background_task(&expired));
        let name = NSString::from_str(name);
        let identifier: usize = unsafe {
            msg_send![shared_application(), beginBackgroundTaskWithName: &*name, expirationHandler: &*handler]
        };
        task.store(identifier, Ordering::SeqCst);
        Self(task)
    }
}

impl Drop for BackgroundTask {
    fn drop(&mut self) {
        end_background_task(&self.0);
    }
}

fn shared_application() -> &'static AnyObject {
    unsafe { msg_send![objc2::class!(UIApplication), sharedApplication] }
}

fn end_background_task(task: &AtomicUsize) {
    let invalid = unsafe { UIBackgroundTaskInvalid };
    let identifier = task.swap(invalid, Ordering::SeqCst);
    if identifier != invalid {
        unsafe {
            let _: () = msg_send![shared_application(), endBackgroundTask: identifier];
        }
    }
}

#[tauri::command]
pub fn haptic_feedback(app: tauri::AppHandle, strong: bool) -> Result<(), String> {
    app.run_on_main_thread(move || unsafe {
        let allocated: objc2::rc::Allocated<AnyObject> =
            msg_send![objc2::class!(UIImpactFeedbackGenerator), alloc];
        let generator: objc2::rc::Retained<AnyObject> =
            msg_send![allocated, initWithStyle: isize::from(strong)];
        let _: () = msg_send![&*generator, impactOccurred];
    })
    .map_err(|error| error.to_string())
}
