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
use objc2_av_foundation::{
    AVAssetExportPreset1920x1080, AVAssetExportSession, AVAssetExportSessionStatus,
    AVFileTypeMPEG4, AVURLAsset,
};
use objc2_foundation::{NSString, NSURL};
use objc2_photos::{
    PHAccessLevel, PHAssetCreationRequest, PHAssetResourceType, PHAuthorizationStatus,
    PHPhotoLibrary,
};

#[tauri::command]
pub(crate) async fn open_in_app_auth_url(
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
            // SAFETY: with_webview runs on the main thread and view_controller() is the live UIViewController owned by the webview
            let controller: &AnyObject = unsafe { &*webview.view_controller().cast::<AnyObject>() };
            // SAFETY: SableAuthBrowser declares presentURL:id:from:completion: as (NSURL, NSString, UIViewController, void block) returning void, all arguments are live objects
            unsafe {
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
pub(crate) async fn close_in_app_auth_window(
    window: tauri::WebviewWindow,
    id: String,
) -> Result<(), String> {
    window
        .with_webview(move |_| {
            if let Some(class) = AnyClass::get(c"SableAuthBrowser") {
                let id = NSString::from_str(&id);
                // SAFETY: SableAuthBrowser declares dismissWithId: taking an NSString and returning void
                let _: () = unsafe { msg_send![class, dismissWithId: &*id] };
            }
        })
        .map_err(|error| error.to_string())
}

pub(crate) fn watch_network() -> Result<(), String> {
    let class = AnyClass::get(c"SableNetwork").ok_or("network monitor bridge is unavailable")?;
    let handler = RcBlock::new(
        |available: objc2::runtime::Bool, unmetered: objc2::runtime::Bool| {
            crate::network::set_state(available.as_bool(), unmetered.as_bool());
        },
    );
    // SAFETY: SableNetwork declares startWithHandler: taking a (BOOL, BOOL) block and returning void, and the callee copies the block
    let _: () = unsafe { msg_send![class, startWithHandler: &*handler] };
    Ok(())
}

/// Synchronizes the native SDK with the webview's telemetry preference.
pub(crate) fn set_sentry_enabled(enabled: bool) -> Result<(), String> {
    let class = AnyClass::get(c"SableSentry").ok_or("Sentry Cocoa bridge is unavailable")?;
    let dsn = NSString::from_str(option_env!("SENTRY_DSN").unwrap_or_default());
    let environment = NSString::from_str(option_env!("SENTRY_ENVIRONMENT").unwrap_or_default());
    let release = NSString::from_str(option_env!("SENTRY_APP_VERSION").unwrap_or_default());
    // SAFETY: SableSentry declares setEnabled:dsn:environment:release: as (BOOL, NSString, NSString, NSString) returning void, all strings are live
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
pub(crate) fn keychain_group() -> Result<String, String> {
    use objc2_foundation::NSBundle;
    NSBundle::mainBundle()
        .objectForInfoDictionaryKey(&NSString::from_str("SableKeychainGroup"))
        .and_then(|value| value.downcast::<NSString>().ok())
        .map(|group| group.to_string())
        .ok_or_else(|| "missing SableKeychainGroup in Info.plist".to_owned())
}

/// # Errors
/// When the signed app has no accessible App Group container.
pub(crate) fn shared_store_dir() -> Result<std::path::PathBuf, String> {
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
/// When the attribute cannot be set.
pub(crate) fn exclude_from_backup(path: &std::path::Path) -> Result<(), String> {
    use objc2_foundation::{NSNumber, NSURL, NSURLIsExcludedFromBackupKey};
    let url =
        NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&path.to_string_lossy()), true);
    let excluded = NSNumber::numberWithBool(true);
    // SAFETY: the backup exclusion key takes an NSNumber holding a boolean.
    unsafe { url.setResourceValue_forKey_error(Some(&excluded), NSURLIsExcludedFromBackupKey) }
        .map_err(|error| error.to_string())
}

/// # Errors
/// When the shared policy cannot be written.
pub(crate) fn write_push_policy(policy: crate::NotificationPolicy) -> Result<(), String> {
    let root = shared_store_dir()?;
    let value = serde_json::to_vec(&policy).map_err(|error| error.to_string())?;
    sable_core::store::write_atomic(&root.join("push-policy.json"), &value)
        .map_err(|error| error.to_string())
}

#[link(name = "Photos", kind = "framework")]
unsafe extern "C" {}

fn allowed(status: PHAuthorizationStatus) -> bool {
    status == PHAuthorizationStatus::Authorized || status == PHAuthorizationStatus::Limited
}

fn authorize_blocking() -> Result<(), String> {
    // SAFETY: a class method that only reads the current authorization and is callable from any thread
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
    // SAFETY: the handler block takes one PHAuthorizationStatus as the API requires, Photos copies it, and it may run on any queue because it only sends on a Mutex-guarded channel
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
    let file = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&file);
    let change: RcBlock<dyn Fn()> = RcBlock::new(move || {
        // SAFETY: creation requests are only valid inside a performChanges block, which this closure is
        let request = unsafe { PHAssetCreationRequest::creationRequestForAsset() };
        // SAFETY: url is a live file URL to a file that exists until after performChangesAndWait returns
        unsafe { request.addResourceWithType_fileURL_options(resource_type, &url, None) };
    });
    // SAFETY: sharedPhotoLibrary has no preconditions
    let library = unsafe { PHPhotoLibrary::sharedPhotoLibrary() };
    // SAFETY: change is a live no-argument block that runs synchronously before this call returns
    let result =
        unsafe { library.performChangesAndWait_error(RcBlock::as_ptr(&change)) }.map_err(|error| {
            format!(
                "failed to save media to Photos: {}",
                error.localizedDescription()
            )
        });
    let _ = std::fs::remove_file(path);
    result
}

#[tauri::command]
pub(crate) async fn save_media_to_photos(request: tauri::ipc::Request<'_>) -> Result<(), String> {
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

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {}

fn h264_export(input: &std::path::Path, output: &std::path::Path) -> Result<(), String> {
    let source = NSURL::fileURLWithPath(&NSString::from_str(&input.to_string_lossy()));
    // SAFETY: no options are passed
    let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&source, None) };
    // SAFETY: a valid preset name, and the non-HEVC presets encode H.264
    let session = unsafe {
        AVAssetExportSession::exportSessionWithAsset_presetName(
            &asset,
            AVAssetExportPreset1920x1080,
        )
    }
    .ok_or("the video cannot be exported as H.264")?;
    // SAFETY: a framework constant
    let file_type = unsafe { AVFileTypeMPEG4 }.ok_or("MPEG-4 export is unavailable")?;
    let target = NSURL::fileURLWithPath(&NSString::from_str(&output.to_string_lossy()));
    // SAFETY: the session has not started
    unsafe { session.setOutputURL(Some(&target)) };
    // SAFETY: the session has not started
    unsafe { session.setOutputFileType(Some(file_type)) };
    // SAFETY: the session has not started
    unsafe { session.setShouldOptimizeForNetworkUse(true) };

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let sender = Mutex::new(Some(sender));
    let handler: RcBlock<dyn Fn()> = RcBlock::new(move || {
        if let Ok(mut sender) = sender.lock()
            && let Some(sender) = sender.take()
        {
            let _ = sender.send(());
        }
    });
    // SAFETY: the handler only sends on a Mutex-guarded channel, so it is sendable
    unsafe { session.exportAsynchronouslyWithCompletionHandler(&handler) };
    receiver
        .recv()
        .map_err(|_| "the video export was cancelled")?;
    // SAFETY: the export has finished
    if unsafe { session.status() } == AVAssetExportSessionStatus::Completed {
        return Ok(());
    }
    // SAFETY: the export has finished
    Err(unsafe { session.error() }.map_or_else(
        || "the video export failed".to_owned(),
        |error| error.localizedDescription().to_string(),
    ))
}

#[tauri::command]
pub(crate) async fn h264_from_hevc(
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("the video bytes must ride the request body".into());
    };
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let stem = std::env::temp_dir().join(format!(
            "sable-h264-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let input = stem.with_extension("mov");
        let output = stem.with_extension("mp4");
        let result = std::fs::write(&input, &bytes)
            .map_err(|error| format!("failed to stage the video: {error}"))
            .and_then(|()| h264_export(&input, &output))
            .and_then(|()| {
                std::fs::read(&output)
                    .map_err(|error| format!("failed to read the export: {error}"))
            });
        let _ = std::fs::remove_file(&input);
        let _ = std::fs::remove_file(&output);
        result.map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri extracts command arguments by value"
)]
pub(crate) fn donate_sent_message(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(avatar) = request.body() else {
        return Err("the avatar bytes must ride the request body".into());
    };
    let user = crate::decode_header(&request, "user-id").ok_or("missing user-id")?;
    let room = crate::decode_header(&request, "room-id").ok_or("missing room-id")?;
    let name = crate::decode_header(&request, "name").ok_or("missing name")?;
    let avatar = avatar.clone();
    app.run_on_main_thread(move || {
        let Some(class) = AnyClass::get(c"SableConversations") else {
            log::warn!("conversation donation bridge is unavailable");
            return;
        };
        let avatar = (!avatar.is_empty()).then(|| objc2_foundation::NSData::with_bytes(&avatar));
        let (user, room, name) = (
            NSString::from_str(&user),
            NSString::from_str(&room),
            NSString::from_str(&name),
        );
        // SAFETY: SableConversations declares donateSentByUser:room:name:avatar: taking three NSStrings and a nullable NSData and returning void
        unsafe {
            let _: () = msg_send![class, donateSentByUser: &*user, room: &*room, name: &*name, avatar: avatar.as_deref()];
        }
    })
    .map_err(|error| error.to_string())
}

// WKWebView cannot hide the form accessory bar, so swap WKContentView's class for a subclass whose inputAccessoryView is nil.
const extern "C-unwind" fn input_accessory_view_nil(
    _this: &AnyObject,
    _cmd: Sel,
) -> *mut AnyObject {
    std::ptr::null_mut()
}

pub(crate) fn hide_form_accessory_bar(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        // SAFETY: with_webview runs on the main thread and inner() is the live WKWebView
        let webview: &AnyObject = unsafe { &*webview.inner().cast::<AnyObject>() };
        // SAFETY: WKWebView.scrollView is a non-nil UIScrollView
        let scroll_view: &AnyObject = unsafe { msg_send![webview, scrollView] };
        // SAFETY: UIView.subviews returns a non-nil NSArray
        let subviews: &AnyObject = unsafe { msg_send![scroll_view, subviews] };
        // SAFETY: NSArray.count returns NSUInteger
        let count: usize = unsafe { msg_send![subviews, count] };
        for index in 0..count {
            // SAFETY: index is below count, so objectAtIndex: returns a live element
            let subview: &AnyObject = unsafe { msg_send![subviews, objectAtIndex: index] };
            let class = subview.class();
            if !class.name().to_bytes().starts_with(b"WKContent") {
                continue;
            }
            let Ok(name) =
                CString::new(format!("{}_NoAccessoryBar", class.name().to_string_lossy()))
            else {
                continue;
            };
            // Registered once per process; a second window finds it by name.
            let subclass = if let Some(subclass) = AnyClass::get(&name) {
                subclass
            } else {
                let Some(mut builder) = ClassBuilder::new(&name, class) else {
                    continue;
                };
                // SAFETY: the function takes (self, _cmd) and returns an object pointer, matching the inputAccessoryView signature
                unsafe {
                    builder.add_method(
                        sel!(inputAccessoryView),
                        input_accessory_view_nil as extern "C-unwind" fn(_, _) -> _,
                    );
                }
                builder.register()
            };
            // SAFETY: subclass derives from the view's current class and adds no ivars, so the layout is unchanged
            unsafe { AnyObject::set_class(subview, subclass) };
        }
    });
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri extracts command arguments by value"
)]
pub(crate) fn set_system_bars_hidden(
    window: tauri::WebviewWindow,
    hidden: bool,
) -> Result<(), String> {
    window
        .with_webview(move |webview| {
            // SAFETY: with_webview runs on the main thread and view_controller() is the live UIViewController
            let controller: &AnyObject = unsafe { &*webview.view_controller().cast::<AnyObject>() };
            // SAFETY: UIViewController declares setPrefersStatusBarHidden: taking a BOOL
            let _: () = unsafe { msg_send![controller, setPrefersStatusBarHidden: hidden] };
            // SAFETY: UIViewController declares setPrefersHomeIndicatorAutoHidden: taking a BOOL
            let _: () = unsafe { msg_send![controller, setPrefersHomeIndicatorAutoHidden: hidden] };
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
    // SAFETY: UIApplication.applicationState returns a UIApplicationState (NSInteger)
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
    // SAFETY: +defaultCenter returns the non-nil shared NSNotificationCenter
    let center: &AnyObject =
        unsafe { msg_send![objc2::class!(NSNotificationCenter), defaultCenter] };
    // SAFETY: +mainQueue returns the non-nil main NSOperationQueue
    let queue: &AnyObject = unsafe { msg_send![objc2::class!(NSOperationQueue), mainQueue] };
    // SAFETY: UIKit notification names are immutable constants initialized when the framework loads
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
        // SAFETY: addObserverForName:object:queue:usingBlock: takes (NSString, nil, NSOperationQueue, block) and returns a retained observer, the block is copied and the handler is only run on the main queue
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
        // SAFETY: UIBackgroundTaskInvalid is an immutable constant initialized when UIKit loads
        self.0.load(Ordering::SeqCst) != unsafe { UIBackgroundTaskInvalid }
    }

    /// Call on the main thread so the expiration handler cannot run before the identifier is stored.
    pub(crate) fn begin(name: &str) -> Self {
        // SAFETY: UIBackgroundTaskInvalid is an immutable constant initialized when UIKit loads
        let task = Arc::new(AtomicUsize::new(unsafe { UIBackgroundTaskInvalid }));
        let expired = task.clone();
        let handler = RcBlock::new(move || end_background_task(&expired));
        let name = NSString::from_str(name);
        // SAFETY: beginBackgroundTaskWithName:expirationHandler: takes (NSString, void block) and returns a UIBackgroundTaskIdentifier (NSUInteger), the block is copied
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
    // SAFETY: +sharedApplication returns the non-nil singleton, which lives for the whole process
    unsafe { msg_send![objc2::class!(UIApplication), sharedApplication] }
}

fn end_background_task(task: &AtomicUsize) {
    // SAFETY: UIBackgroundTaskInvalid is an immutable constant initialized when UIKit loads
    let invalid = unsafe { UIBackgroundTaskInvalid };
    let identifier = task.swap(invalid, Ordering::SeqCst);
    if identifier != invalid {
        // SAFETY: identifier came from beginBackgroundTask and the swap above ensures it is ended only once
        let _: () = unsafe { msg_send![shared_application(), endBackgroundTask: identifier] };
    }
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri extracts command arguments by value"
)]
pub(crate) fn haptic_feedback(app: tauri::AppHandle, strong: bool) -> Result<(), String> {
    app.run_on_main_thread(move || {
        // SAFETY: +alloc returns a fresh allocation that is initialized exactly once below
        let allocated: objc2::rc::Allocated<AnyObject> =
            unsafe { msg_send![objc2::class!(UIImpactFeedbackGenerator), alloc] };
        // SAFETY: initWithStyle: takes a UIImpactFeedbackStyle (NSInteger) and runs on the main thread as UIKit requires
        let generator: objc2::rc::Retained<AnyObject> =
            unsafe { msg_send![allocated, initWithStyle: isize::from(strong)] };
        // SAFETY: impactOccurred takes no arguments and returns void
        let _: () = unsafe { msg_send![&*generator, impactOccurred] };
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri extracts command arguments by value"
)]
pub(crate) fn set_badge_count(app: tauri::AppHandle, count: isize) -> Result<(), String> {
    app.run_on_main_thread(move || {
        let Some(class) = AnyClass::get(c"UNUserNotificationCenter") else {
            return;
        };
        // setBadgeCount:withCompletionHandler: is iOS 16+, and the app still supports 15.
        if !class.responds_to(sel!(setBadgeCount:withCompletionHandler:)) {
            // SAFETY: applicationIconBadgeNumber is an NSInteger property on the main-thread UIApplication
            let _: () =
                unsafe { msg_send![shared_application(), setApplicationIconBadgeNumber: count] };
            return;
        }
        // SAFETY: +currentNotificationCenter returns the non-nil singleton
        let center: &AnyObject = unsafe { msg_send![class, currentNotificationCenter] };
        let done = RcBlock::new(|error: *mut AnyObject| {
            if !error.is_null() {
                log::warn!("setting the badge count failed");
            }
        });
        // SAFETY: setBadgeCount:withCompletionHandler: takes an NSInteger and a (NSError *) block, which the callee copies
        let _: () =
            unsafe { msg_send![center, setBadgeCount: count, withCompletionHandler: &*done] };
    })
    .map_err(|error| error.to_string())
}
