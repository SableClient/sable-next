//! Hands converted frames to the page through `WebView2` shared buffers, so a
//! 1080p stream never crosses IPC: the capture thread writes into memory the
//! page already holds and only announces which slot is ready.

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY, ICoreWebView2_17, ICoreWebView2Controller,
    ICoreWebView2Environment, ICoreWebView2Environment12, ICoreWebView2SharedBuffer,
};
use windows_core_061::{HSTRING, Interface};

pub const SLOTS: usize = 3;

struct Slot {
    _buffer: ICoreWebView2SharedBuffer,
    address: usize,
    len: usize,
}

/// A ring of shared buffers the page has received, all sized for one frame.
pub struct Ring {
    slots: Vec<Slot>,
    pub width: u32,
    pub height: u32,
    pub generation: u32,
}

// SAFETY: the COM objects are only kept alive here; they are created and
// posted on the UI thread and never called from another one. Writes go
// through the raw address, which stays mapped for as long as `Ring` lives.
#[expect(unsafe_code, reason = "FFI call")]
unsafe impl Send for Ring {}

impl Ring {
    /// Creates the buffers and posts each to the page. Must run on the
    /// webview's UI thread.
    ///
    /// # Errors
    ///
    /// Fails when the `WebView2` runtime is too old for shared buffers.
    #[expect(unsafe_code, reason = "FFI call")]
    pub fn create(
        environment: &ICoreWebView2Environment,
        controller: &ICoreWebView2Controller,
        width: u32,
        height: u32,
        generation: u32,
    ) -> windows_core_061::Result<Self> {
        let environment: ICoreWebView2Environment12 = environment.cast()?;
        // SAFETY: a plain COM getter on a live controller, on its own thread.
        let webview: ICoreWebView2_17 = unsafe { controller.CoreWebView2()? }.cast()?;
        let len = width as usize * height as usize * 4;
        let mut slots = Vec::with_capacity(SLOTS);
        for slot in 0..SLOTS {
            // SAFETY: plain COM calls on live interfaces, on their own thread.
            let buffer = unsafe { environment.CreateSharedBuffer(len as u64)? };
            let mut address = std::ptr::null_mut();
            // SAFETY: `address` is a valid out-pointer.
            unsafe { buffer.Buffer(&raw mut address)? };
            let data = HSTRING::from(format!(
                r#"{{"sableHdr":{{"generation":{generation},"slot":{slot},"width":{width},"height":{height}}}}}"#
            ));
            // SAFETY: as above.
            unsafe {
                webview.PostSharedBufferToScript(
                    &buffer,
                    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                    &data,
                )?;
            }
            slots.push(Slot {
                _buffer: buffer,
                address: address as usize,
                len,
            });
        }
        Ok(Self {
            slots,
            width,
            height,
            generation,
        })
    }

    /// Copies a BGRA frame into `slot`. Returns `false` when the slot does not
    /// exist or the frame does not match the ring's size.
    #[expect(unsafe_code, reason = "FFI call")]
    #[must_use]
    pub fn write(&self, slot: usize, frame: &[u8]) -> bool {
        let Some(target) = self.slots.get(slot) else {
            return false;
        };
        if frame.len() != target.len {
            return false;
        }
        // SAFETY: the mapping is `target.len` bytes long and outlives `self`;
        // the page only reads a slot after it is announced and before it is
        // handed back, so nothing else writes it concurrently.
        unsafe {
            std::ptr::copy_nonoverlapping(frame.as_ptr(), target.address as *mut u8, target.len);
        }
        true
    }
}
