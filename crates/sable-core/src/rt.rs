use futures_util::future::{AbortHandle, Abortable};

pub struct Task(AbortHandle);

impl Task {
    pub fn abort(&self) {
        self.0.abort();
    }
}

impl Drop for Task {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(not(target_family = "wasm"))]
pub fn spawn<F>(future: F) -> Task
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let (handle, registration) = AbortHandle::new_pair();
    tokio::spawn(Abortable::new(future, registration));
    Task(handle)
}

/// Runs finite, best-effort work that does not need session teardown.
#[cfg(not(target_family = "wasm"))]
pub fn spawn_detached<F>(future: F)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(future);
}

#[cfg(target_family = "wasm")]
pub fn spawn<F>(future: F) -> Task
where
    F: std::future::Future<Output = ()> + 'static,
{
    let (handle, registration) = AbortHandle::new_pair();
    wasm_bindgen_futures::spawn_local(async {
        let _ = Abortable::new(future, registration).await;
    });
    Task(handle)
}

/// Runs finite, best-effort work that does not need session teardown.
#[cfg(target_family = "wasm")]
pub fn spawn_detached<F>(future: F)
where
    F: std::future::Future<Output = ()> + 'static,
{
    wasm_bindgen_futures::spawn_local(future);
}
