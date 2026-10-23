//! Native targets run on tokio; wasm runs on the page's event loop, where futures cannot be `Send`.

use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
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
pub type BoxStream<'a, T> = Pin<Box<dyn futures_util::Stream<Item = T> + Send + 'a>>;
#[cfg(target_family = "wasm")]
pub type BoxStream<'a, T> = Pin<Box<dyn futures_util::Stream<Item = T> + 'a>>;

#[cfg(not(target_family = "wasm"))]
pub type BoxOnce<A, R> = Box<dyn FnOnce(A) -> R + Send>;
#[cfg(target_family = "wasm")]
pub type BoxOnce<A, R> = Box<dyn FnOnce(A) -> R>;

/// A spawned future that is cancelled when this is dropped.
#[derive(Debug)]
pub struct Task(AbortHandle);

impl Drop for Task {
    fn drop(&mut self) {
        self.0.abort();
    }
}

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

/// Queued messages and unanswered effects. Tests settle on it reaching zero.
#[derive(Debug, Default)]
pub struct Activity(AtomicUsize);

/// Finished when dropped.
#[derive(Debug)]
pub struct Busy(Arc<Activity>);

impl Activity {
    #[must_use]
    pub fn begin(self: &Arc<Self>) -> Busy {
        self.0.fetch_add(1, Ordering::SeqCst);
        Busy(Arc::clone(self))
    }

    #[must_use]
    pub fn is_idle(&self) -> bool {
        self.0.load(Ordering::SeqCst) == 0
    }

    /// For a future that only a test can finish.
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

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.0.fetch_sub(1, Ordering::SeqCst);
    }
}
