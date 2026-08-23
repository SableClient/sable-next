use std::{
    ffi::{CString, OsStr},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
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

#[link(name = "Photos", kind = "framework")]
extern "C" {}

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
        if let Ok(mut sender) = sender.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(status);
            }
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

fn write_to_photos(bytes: &[u8], filename: &str) -> Result<(), String> {
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
            request.addResourceWithType_fileURL_options(PHAssetResourceType::Photo, &url, None);
        });
        PHPhotoLibrary::sharedPhotoLibrary()
            .performChangesAndWait_error(RcBlock::as_ptr(&change))
            .map_err(|error| {
                format!(
                    "failed to save image to Photos: {}",
                    error.localizedDescription()
                )
            })
    };
    let _ = std::fs::remove_file(path);
    result
}

#[tauri::command]
pub async fn save_media_to_photos(
    bytes: Vec<u8>,
    filename: String,
    mime_type: String,
) -> Result<(), String> {
    if !mime_type.starts_with("image/") {
        return Err("only images can be saved to Photos".into());
    }
    authorize().await?;
    tauri::async_runtime::spawn_blocking(move || write_to_photos(&bytes, &filename))
        .await
        .map_err(|error| error.to_string())?
}

// iOS shows a form accessory bar (prev/next arrows and Done) above the keyboard
// for web inputs. WKWebView exposes no API to turn it off, so swap the private
// WKContentView's class for a runtime subclass whose inputAccessoryView is nil,
// the same approach as Capacitor's hideFormAccessoryBar.
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
