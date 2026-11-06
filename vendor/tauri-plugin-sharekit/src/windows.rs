use std::sync::mpsc;

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime, WebviewWindow};

use crate::models::{ShareFileOptions, ShareTextOptions};
use crate::Error;

use windows::{
    core::{Interface, HSTRING},
    ApplicationModel::DataTransfer::{DataPackage, DataRequestedEventArgs, DataTransferManager},
    Foundation::TypedEventHandler,
    Storage::{IStorageItem, StorageFile},
    Win32::{
        Foundation::HWND,
        System::WinRT::{RoGetActivationFactory, RoInitialize, RO_INIT_SINGLETHREADED},
        UI::Shell::IDataTransferManagerInterop,
    },
};
use windows_collections::IIterable;

impl From<windows::core::Error> for Error {
    fn from(err: windows::core::Error) -> Self {
        Self::WindowsApi(err.to_string())
    }
}

#[allow(clippy::unnecessary_wraps)] // signature required by `lib.rs` plugin setup contract
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<ShareKit<R>> {
    Ok(ShareKit::new(app.clone()))
}

/// Access to the share APIs.
pub struct ShareKit<R: Runtime> {
    app: AppHandle<R>,
}

/// Synchronously presents the Windows share UI and blocks the calling thread
/// until the user completes or cancels the share.
///
/// Must be called from inside `tokio::task::spawn_blocking` (or another
/// dedicated thread) — the `WinRT` COM types acquired here are tied to the
/// thread's apartment and cannot cross `.await` points.
fn present_share_ui<F>(hwnd: HWND, populate: F) -> crate::Result<()>
where
    F: Fn(&DataPackage) -> windows::core::Result<()> + Send + Sync + 'static,
{
    let class = HSTRING::from("Windows.ApplicationModel.DataTransfer.DataTransferManager");
    let interop: IDataTransferManagerInterop = unsafe { RoGetActivationFactory(&class)? };
    let dtm: DataTransferManager = unsafe { interop.GetForWindow(hwnd)? };

    let (setup_tx, setup_rx) = mpsc::channel::<crate::Result<()>>();
    let (complete_tx, complete_rx) = mpsc::channel::<bool>();

    let handler: TypedEventHandler<DataTransferManager, DataRequestedEventArgs> =
        TypedEventHandler::new(
            move |_, args: windows::core::Ref<'_, DataRequestedEventArgs>| {
                let result: windows::core::Result<()> = (|| {
                    if let Some(args) = args.as_ref() {
                        let data = args.Request()?.Data()?;
                        populate(&data)?;

                        let tx_completed = complete_tx.clone();
                        data.ShareCompleted(&TypedEventHandler::new(move |_, _| {
                            let _ = tx_completed.send(true);
                            Ok(())
                        }))?;

                        let tx_canceled = complete_tx.clone();
                        data.ShareCanceled(&TypedEventHandler::new(move |_, _| {
                            let _ = tx_canceled.send(false);
                            Ok(())
                        }))?;
                    }
                    Ok(())
                })();
                let _ = setup_tx.send(result.map_err(|e| Error::WindowsApi(e.to_string())));
                Ok(())
            },
        );

    let token = dtm.DataRequested(&handler)?;
    unsafe {
        interop.ShowShareUIForWindow(hwnd)?;
    }

    let setup_result = setup_rx
        .recv()
        .map_err(|e| Error::WindowsApi(e.to_string()))
        .and_then(|r| r);
    if let Err(e) = setup_result {
        let _ = dtm.RemoveDataRequested(token);
        return Err(e);
    }

    let completed = match complete_rx.recv() {
        Ok(b) => b,
        Err(e) => {
            let _ = dtm.RemoveDataRequested(token);
            return Err(Error::WindowsApi(e.to_string()));
        }
    };
    let _ = dtm.RemoveDataRequested(token);

    if completed {
        Ok(())
    } else {
        Err(Error::ShareCancelled)
    }
}

impl<R: Runtime> ShareKit<R> {
    pub const fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }

    /// Opens the native share UI to share text content.
    pub async fn share_text(
        &self,
        window: WebviewWindow<R>,
        text: String,
        _options: ShareTextOptions,
    ) -> crate::Result<()> {
        let app_name = self.app.package_info().name.clone();

        tokio::task::spawn_blocking(move || -> crate::Result<()> {
            init_apartment();
            let hwnd = window
                .hwnd()
                .map_err(|e| Error::WindowsApi(e.to_string()))?;
            let content = HSTRING::from(text);
            let app_name = HSTRING::from(app_name);

            present_share_ui(hwnd, move |data| {
                let props = data.Properties()?;
                props.SetTitle(&app_name)?;
                props.SetDescription(&content)?;
                data.SetText(&content)?;
                Ok(())
            })
        })
        .await
        .map_err(|e| Error::WindowsApi(format!("blocking task: {e}")))?
    }

    /// Opens the native share UI to share a file.
    pub async fn share_file(
        &self,
        window: WebviewWindow<R>,
        url: String,
        options: ShareFileOptions,
    ) -> crate::Result<()> {
        let app_name = self.app.package_info().name.clone();

        tokio::task::spawn_blocking(move || -> crate::Result<()> {
            init_apartment();
            let hwnd = window
                .hwnd()
                .map_err(|e| Error::WindowsApi(e.to_string()))?;
            let path = HSTRING::from(url);
            let title = HSTRING::from(options.title.as_deref().unwrap_or(&app_name));

            present_share_ui(hwnd, move |data| {
                // Title and Description are required for Windows share to work properly
                let props = data.Properties()?;
                props.SetTitle(&title)?;
                props.SetDescription(&title)?;

                let file = StorageFile::GetFileFromPathAsync(&path)?.join()?;
                let storage_item = file.cast::<IStorageItem>()?;
                let storage_items: IIterable<IStorageItem> = vec![Some(storage_item)].into();
                data.SetStorageItemsReadOnly(&storage_items)?;
                Ok(())
            })
        })
        .await
        .map_err(|e| Error::WindowsApi(format!("blocking task: {e}")))?
    }
}

/// Initializes the `WinRT` apartment for the current thread.
/// Safe to call repeatedly — subsequent calls return `S_FALSE` / `RPC_E_CHANGED_MODE`
/// which we intentionally ignore.
fn init_apartment() {
    unsafe {
        let _ = RoInitialize(RO_INIT_SINGLETHREADED);
    }
}
