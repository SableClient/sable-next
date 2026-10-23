use std::{future::Future, pin::Pin, time::Duration};

#[cfg(any(test, feature = "testing"))]
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use futures_util::future::{AbortHandle, abortable};

#[cfg(not(target_family = "wasm"))]
mod bounds {
    pub trait SendOutsideWasm: Send {}
    impl<T: Send + ?Sized> SendOutsideWasm for T {}

    pub trait SyncOutsideWasm: Sync {}
    impl<T: Sync + ?Sized> SyncOutsideWasm for T {}
}

#[cfg(target_family = "wasm")]
mod bounds {
    pub trait SendOutsideWasm {}
    impl<T: ?Sized> SendOutsideWasm for T {}

    pub trait SyncOutsideWasm {}
    impl<T: ?Sized> SyncOutsideWasm for T {}
}

pub use bounds::{SendOutsideWasm, SyncOutsideWasm};

#[cfg(not(target_family = "wasm"))]
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
#[cfg(target_family = "wasm")]
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

#[cfg(not(target_family = "wasm"))]
pub type BoxAny = Box<dyn std::any::Any + Send>;
#[cfg(target_family = "wasm")]
pub type BoxAny = Box<dyn std::any::Any>;

#[cfg(not(target_family = "wasm"))]
pub type BoxOnce<A, R> = Box<dyn FnOnce(A) -> R + Send>;
#[cfg(target_family = "wasm")]
pub type BoxOnce<A, R> = Box<dyn FnOnce(A) -> R>;

#[derive(Debug)]
pub struct Task(AbortHandle);

impl Drop for Task {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// On native targets this must run inside a tokio runtime.
pub fn spawn(future: impl Future<Output = ()> + SendOutsideWasm + 'static) -> Task {
    let (future, handle) = abortable(future);
    spawn_detached(async move {
        let _ = future.await;
    });
    Task(handle)
}

#[cfg(not(target_family = "wasm"))]
pub fn spawn_detached(future: impl Future<Output = ()> + SendOutsideWasm + 'static) {
    drop(tokio::spawn(future));
}

#[cfg(target_family = "wasm")]
pub fn spawn_detached(future: impl Future<Output = ()> + SendOutsideWasm + 'static) {
    wasm_bindgen_futures::spawn_local(future);
}

#[cfg(not(target_family = "wasm"))]
pub async fn sleep(duration: Duration) {
    tokio::time::sleep(duration).await;
}

#[cfg(target_family = "wasm")]
pub async fn sleep(duration: Duration) {
    gloo_timers::future::sleep(duration).await;
}

#[cfg(any(test, feature = "testing"))]
pub(crate) static CLOCK_OVERRIDE: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

#[must_use]
pub fn now_ms() -> u64 {
    #[cfg(any(test, feature = "testing"))]
    {
        let fixed = CLOCK_OVERRIDE.load(Ordering::SeqCst);
        if fixed != 0 {
            return fixed;
        }
    }
    wall_clock_ms()
}

#[cfg(not(target_family = "wasm"))]
fn wall_clock_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(target_family = "wasm")]
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "Date.now() is a whole, positive number of milliseconds"
)]
fn wall_clock_ms() -> u64 {
    js_sys::Date::now() as u64
}

#[cfg(any(test, feature = "testing"))]
#[derive(Debug, Default, Clone)]
pub struct Activity(Arc<AtomicUsize>);

#[cfg(any(test, feature = "testing"))]
#[derive(Debug)]
pub struct Busy(Activity);

#[cfg(any(test, feature = "testing"))]
impl Activity {
    #[must_use]
    pub fn begin(&self) -> Busy {
        self.0.fetch_add(1, Ordering::SeqCst);
        Busy(self.clone())
    }

    #[must_use]
    pub fn is_idle(&self) -> bool {
        self.0.load(Ordering::SeqCst) == 0
    }

    pub async fn parked<T>(&self, wait: impl Future<Output = T>) -> T {
        struct Resume<'a>(&'a Activity);

        impl Drop for Resume<'_> {
            fn drop(&mut self) {
                self.0.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        self.0.fetch_sub(1, Ordering::SeqCst);
        let _resume = Resume(self);
        wait.await
    }
}

#[cfg(any(test, feature = "testing"))]
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(not(any(test, feature = "testing")))]
#[derive(Debug, Default, Clone)]
pub struct Activity {}

#[cfg(not(any(test, feature = "testing")))]
#[derive(Debug)]
pub struct Busy;

#[cfg(not(any(test, feature = "testing")))]
impl Activity {
    #[must_use]
    pub const fn begin(&self) -> Busy {
        Busy
    }
}
