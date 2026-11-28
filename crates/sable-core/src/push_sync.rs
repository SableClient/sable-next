//! A push that arrives with the app in the background briefly runs the app's own sync, so the
//! room is current when the notification is opened.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use matrix_sdk::executor::spawn;
use tokio::sync::broadcast::error::RecvError;
use web_time::Instant;

use crate::Core;

const SYNC_TIMEOUT: Duration = Duration::from_secs(10);
const MIN_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(crate) struct PushSyncGate {
    held: AtomicBool,
    running: AtomicBool,
    last_completed: parking_lot::Mutex<Option<Instant>>,
}

impl PushSyncGate {
    pub(crate) fn held(&self) -> bool {
        self.held.load(Ordering::SeqCst)
    }

    fn try_start(&self) -> bool {
        if self.running.swap(true, Ordering::SeqCst) {
            return false;
        }
        let recent = self
            .last_completed
            .lock()
            .is_some_and(|completed| completed.elapsed() < MIN_INTERVAL);
        if recent {
            self.running.store(false, Ordering::SeqCst);
        }
        !recent
    }

    /// Only a sync that saw the room update counts towards the interval, so the next push can try again.
    fn finish(&self, completed: bool) {
        if completed {
            *self.last_completed.lock() = Some(Instant::now());
        }
        self.running.store(false, Ordering::SeqCst);
    }
}

impl Core {
    /// Returns once the room updated or the sync gave up, so the caller can keep the process
    /// awake until then.
    pub async fn sync_on_push(self: &Arc<Self>, user_id: &str, device_id: &str, room_id: &str) {
        if !self.settings.sync_on_push.load(Ordering::Relaxed)
            || self.activity.app_active()
            || self.activity.account_locked()
            || !self.activity.network_available()
        {
            return;
        }
        let Ok(room_id) = ruma::OwnedRoomId::try_from(room_id) else {
            return;
        };
        let Ok(session) = self.signed_in() else {
            return;
        };
        let client = session.client();
        if client.user_id().is_none_or(|id| id != user_id)
            || client.device_id().is_none_or(|id| id != device_id)
            || !self.activity.push_sync.try_start()
        {
            return;
        }
        let mut updates = client.subscribe_to_room_updates(&room_id);
        let core = self.clone();
        // Spawned, so a caller that stops waiting still releases the hold.
        let sync = spawn(async move {
            core.activity.push_sync.held.store(true, Ordering::SeqCst);
            core.apply_app_activity(false).await;
            let update = matrix_sdk::timeout::timeout(Box::pin(updates.recv()), SYNC_TIMEOUT).await;
            core.activity.push_sync.held.store(false, Ordering::SeqCst);
            core.apply_app_activity(false).await;
            core.activity
                .push_sync
                .finish(update.is_ok_and(|update| !matches!(update, Err(RecvError::Closed))));
        });
        let _ = sync.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_sync_runs_at_a_time_and_a_completed_one_spaces_the_next() {
        let gate = PushSyncGate::default();
        assert!(gate.try_start());
        assert!(!gate.try_start(), "one is already running");

        gate.finish(false);
        assert!(
            gate.try_start(),
            "an incomplete sync leaves the next push free to try"
        );

        gate.finish(true);
        assert!(!gate.try_start(), "the last sync completed too recently");
    }

    #[tokio::test]
    async fn a_held_push_sync_keeps_a_backgrounded_app_syncing_until_released() {
        let (core, _events) = Core::new(
            "test",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.update_app_active(false).await;
        assert!(core.activity.sync_suspended());

        core.activity.push_sync.held.store(true, Ordering::SeqCst);
        core.apply_app_activity(false).await;
        assert!(!core.activity.sync_suspended());

        core.update_app_active(true).await;
        core.activity.push_sync.held.store(false, Ordering::SeqCst);
        core.apply_app_activity(false).await;
        assert!(
            !core.activity.sync_suspended(),
            "opening the app during the hold keeps it syncing"
        );

        core.update_app_active(false).await;
        assert!(core.activity.sync_suspended());
    }
}
