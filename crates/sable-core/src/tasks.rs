use matrix_sdk::executor::JoinHandle;

pub(crate) struct Task<T = ()>(Option<JoinHandle<T>>);

impl<T: 'static> Task<T> {
    pub(crate) async fn stopped(mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
            let _ = handle.await;
        }
    }
}

impl<T> Drop for Task<T> {
    fn drop(&mut self) {
        if let Some(handle) = &self.0 {
            handle.abort();
        }
    }
}

pub(crate) trait JoinHandleExt<T> {
    fn abort_on_drop(self) -> Task<T>;
}

impl<T> JoinHandleExt<T> for JoinHandle<T> {
    fn abort_on_drop(self) -> Task<T> {
        Task(Some(self))
    }
}

pub(crate) async fn stop_all(tasks: impl IntoIterator<Item = Task>) {
    futures_util::future::join_all(tasks.into_iter().map(Task::stopped)).await;
}
