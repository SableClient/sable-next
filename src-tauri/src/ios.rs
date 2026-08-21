use std::{
    ffi::OsStr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use block2::RcBlock;
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
