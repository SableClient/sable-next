use std::future::Future;

#[cfg(any(test, feature = "testing"))]
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

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

pub use n0_future::{boxed::BoxFuture, time::sleep};

#[cfg(not(target_family = "wasm"))]
pub type BoxAny = Box<dyn std::any::Any + Send>;
#[cfg(target_family = "wasm")]
pub type BoxAny = Box<dyn std::any::Any>;

#[cfg(not(target_family = "wasm"))]
pub type BoxOnce<A, R> = Box<dyn FnOnce(A) -> R + Send>;
#[cfg(target_family = "wasm")]
pub type BoxOnce<A, R> = Box<dyn FnOnce(A) -> R>;

pub type Task = n0_future::task::AbortOnDropHandle<()>;

/// On native targets this must run inside a tokio runtime.
pub fn spawn(future: impl Future<Output = ()> + SendOutsideWasm + 'static) -> Task {
    Task::new(n0_future::task::spawn(future))
}

pub fn spawn_detached(future: impl Future<Output = ()> + SendOutsideWasm + 'static) {
    drop(n0_future::task::spawn(future));
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
    u64::try_from(jiff::Timestamp::now().as_millisecond()).unwrap_or(0)
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
