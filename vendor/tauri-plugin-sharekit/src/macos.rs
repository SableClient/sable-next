use std::cell::{Cell, RefCell};

use serde::de::DeserializeOwned;
use tauri::WebviewWindow;
use tauri::{plugin::PluginApi, AppHandle, Runtime};
use tokio::sync::oneshot;

use crate::models::{RectEdge, ShareFileOptions, SharePosition, ShareTextOptions};

use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject, ProtocolObject},
    AnyThread, DefinedClass,
};
use objc2_app_kit::{
    NSSharingService, NSSharingServicePicker, NSSharingServicePickerDelegate, NSView,
};
use objc2_core_foundation::{CGPoint, CGSize};
use objc2_foundation::{NSArray, NSObjectProtocol, NSRect, NSRectEdge, NSString, NSURL};

impl From<RectEdge> for NSRectEdge {
    fn from(edge: RectEdge) -> Self {
        match edge {
            RectEdge::Top => Self::NSMaxYEdge,
            RectEdge::Bottom => Self::NSMinYEdge,
            RectEdge::Left => Self::NSMinXEdge,
            RectEdge::Right => Self::NSMaxXEdge,
        }
    }
}

fn position_to_rect(position: Option<&SharePosition>) -> (f64, f64, NSRectEdge) {
    position.map_or((0.0, 0.0, NSRectEdge::NSMinYEdge), |pos| {
        let edge = pos
            .preferred_edge
            .map_or(NSRectEdge::NSMinYEdge, Into::into);
        (pos.x, pos.y, edge)
    })
}

struct PickerDelegateIvars {
    sender: Cell<Option<oneshot::Sender<crate::Result<()>>>>,
    picker: RefCell<Option<Retained<NSSharingServicePicker>>>,
    retainer: RefCell<Option<Retained<PickerDelegate>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "SharekitPickerDelegate"]
    #[ivars = PickerDelegateIvars]
    struct PickerDelegate;

    unsafe impl NSObjectProtocol for PickerDelegate {}

    unsafe impl NSSharingServicePickerDelegate for PickerDelegate {
        #[unsafe(method(sharingServicePicker:didChooseSharingService:))]
        fn picker_did_choose_service(
            &self,
            _picker: &NSSharingServicePicker,
            service: Option<&NSSharingService>,
        ) {
            if let Some(sender) = self.ivars().sender.take() {
                let result = if service.is_some() {
                    Ok(())
                } else {
                    Err(crate::Error::ShareCancelled)
                };
                let _ = sender.send(result);
            }
            self.ivars().picker.borrow_mut().take();
            // Releases the last strong ref; `self` stays valid for the rest of
            // this method call per ObjC runtime semantics, then deallocs.
            self.ivars().retainer.borrow_mut().take();
        }
    }
);

impl PickerDelegate {
    fn new(sender: oneshot::Sender<crate::Result<()>>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(PickerDelegateIvars {
            sender: Cell::new(Some(sender)),
            picker: RefCell::new(None),
            retainer: RefCell::new(None),
        });
        unsafe { msg_send![super(this), init] }
    }
}

#[allow(clippy::unnecessary_wraps)] // signature required by `lib.rs` plugin setup contract
pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<ShareKit<R>> {
    Ok(ShareKit(app.clone()))
}

/// Access to the share APIs.
pub struct ShareKit<R: Runtime>(AppHandle<R>);

#[allow(clippy::needless_pass_by_value)] // matches public API signatures of `share_text` / `share_file`
fn present_picker<R: Runtime>(
    window: WebviewWindow<R>,
    items_builder: impl FnOnce() -> Vec<Retained<AnyObject>> + Send + 'static,
    position: Option<SharePosition>,
) -> crate::Result<oneshot::Receiver<crate::Result<()>>> {
    let (tx, rx) = oneshot::channel();
    let (x, y, edge) = position_to_rect(position.as_ref());

    window
        .with_webview(move |webview| {
            let ns_view: &NSView = unsafe { &*(webview.inner() as *const NSView) };

            let items = items_builder();
            let items_array = NSArray::from_retained_slice(&items);

            let rect = NSRect::new(CGPoint::new(x, y), CGSize::new(1.0, 1.0));
            let picker = unsafe {
                NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items_array)
            };

            let delegate = PickerDelegate::new(tx);
            picker.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));

            // Self-retain delegate + retain picker so they outlive this closure
            // and stay alive until the user dismisses the popover.
            delegate.ivars().picker.borrow_mut().replace(picker.clone());
            delegate
                .ivars()
                .retainer
                .borrow_mut()
                .replace(delegate.clone());

            picker.showRelativeToRect_ofView_preferredEdge(rect, ns_view, edge);
        })
        .map_err(|_| crate::Error::WindowNotFound)?;

    Ok(rx)
}

impl<R: Runtime> ShareKit<R> {
    pub async fn share_text(
        &self,
        window: WebviewWindow<R>,
        text: String,
        options: ShareTextOptions,
    ) -> crate::Result<()> {
        let rx = present_picker(
            window,
            move || {
                let ns_string = NSString::from_str(&text);
                vec![unsafe { Retained::cast_unchecked(ns_string) }]
            },
            options.position,
        )?;

        rx.await.unwrap_or(Err(crate::Error::ShareCancelled))
    }

    pub async fn share_file(
        &self,
        window: WebviewWindow<R>,
        url: String,
        options: ShareFileOptions,
    ) -> crate::Result<()> {
        let rx = present_picker(
            window,
            move || {
                let ns_url = NSURL::fileURLWithPath(&NSString::from_str(&url));
                vec![unsafe { Retained::cast_unchecked(ns_url) }]
            },
            options.position,
        )?;

        rx.await.unwrap_or(Err(crate::Error::ShareCancelled))
    }
}
