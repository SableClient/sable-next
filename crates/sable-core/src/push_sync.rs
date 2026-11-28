//! A push that arrives with the app in the background syncs its room for a moment, so the room
//! is current when the notification is opened.

use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(target_family = "wasm"))]
use std::sync::{Arc, LazyLock};
#[cfg(not(target_family = "wasm"))]
use std::time::Duration;

#[cfg(not(target_family = "wasm"))]
use web_time::Instant;

/// How long a sync waits for the pushed event once it runs.
#[cfg(not(target_family = "wasm"))]
pub(crate) const SYNC_WAIT: Duration = Duration::from_secs(10);
/// Kept free before the deadline, so a sync always has time to stop.
#[cfg(not(target_family = "wasm"))]
pub(crate) const STOP_WAIT: Duration = Duration::from_secs(4);
/// Everything a push sync does, stopping included, so the worker never returns while it runs.
#[cfg(not(target_family = "wasm"))]
pub(crate) const DEADLINE: Duration = Duration::from_secs(20);
#[cfg(not(target_family = "wasm"))]
const MIN_INTERVAL: Duration = Duration::from_secs(60);

/// One for the process, whichever path a push syncs on.
#[cfg(not(target_family = "wasm"))]
pub(crate) static GATE: LazyLock<PushSyncGate> = LazyLock::new(PushSyncGate::default);

/// Per login: one sync at a time, spaced from its last completed one, so one account's sync
/// never holds back another's.
#[cfg(not(target_family = "wasm"))]
#[derive(Default)]
pub(crate) struct PushSyncGate(parking_lot::Mutex<std::collections::HashMap<String, LoginSyncs>>);

#[cfg(not(target_family = "wasm"))]
#[derive(Default)]
struct LoginSyncs {
    running: bool,
    last_completed: Option<Instant>,
}

#[cfg(not(target_family = "wasm"))]
impl PushSyncGate {
    pub(crate) fn try_start(&self, login: &str) -> bool {
        let mut logins = self.0.lock();
        let syncs = logins.entry(login.to_owned()).or_default();
        if syncs.running
            || syncs
                .last_completed
                .is_some_and(|completed| completed.elapsed() < MIN_INTERVAL)
        {
            return false;
        }
        syncs.running = true;
        true
    }

    /// Only a sync that brought the pushed event counts towards the interval, so the next push
    /// can try again.
    pub(crate) fn finish(&self, login: &str, completed: bool) {
        let mut logins = self.0.lock();
        let syncs = logins.entry(login.to_owned()).or_default();
        syncs.running = false;
        if completed {
            syncs.last_completed = Some(Instant::now());
        }
    }
}

/// Keeps a backgrounded core's own sync running for a push.
#[derive(Default)]
pub(crate) struct PushSyncHold(AtomicBool);

impl PushSyncHold {
    pub(crate) fn held(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    #[cfg(not(target_family = "wasm"))]
    fn set(&self, held: bool) {
        self.0.store(held, Ordering::SeqCst);
    }
}

/// Resolves `true` once the pushed event is in the room's event cache, or without an event id,
/// once the room's timeline gets anything. Other updates, and lagging behind, only check again.
#[cfg(not(target_family = "wasm"))]
pub(crate) async fn wait_for_event(
    client: &matrix_sdk::Client,
    room_id: &ruma::RoomId,
    event_id: Option<&ruma::EventId>,
    until: tokio::time::Instant,
) -> bool {
    use tokio::sync::broadcast::error::RecvError;

    let mut updates = client.subscribe_to_room_updates(room_id);
    loop {
        if let Some(event_id) = event_id
            && event_cached(client, room_id, event_id).await
        {
            return true;
        }
        match tokio::time::timeout_at(until, updates.recv()).await {
            Err(_) | Ok(Err(RecvError::Closed)) => return false,
            Ok(Ok(matrix_sdk::sync::RoomUpdate::Joined {
                updates: joined, ..
            })) if event_id.is_none() && !joined.timeline.events.is_empty() => {
                return true;
            }
            Ok(_) => {}
        }
    }
}

#[cfg(not(target_family = "wasm"))]
async fn event_cached(
    client: &matrix_sdk::Client,
    room_id: &ruma::RoomId,
    event_id: &ruma::EventId,
) -> bool {
    let Some(event_cache) = client.event_cache() else {
        return false;
    };
    let Ok((room, _drop)) = event_cache.room(room_id).await else {
        return false;
    };
    room.find_event(event_id).await.ok().flatten().is_some()
}

#[cfg(not(target_family = "wasm"))]
impl crate::Core {
    /// Holds the backgrounded app's own sync running until the pushed event arrives, then lets
    /// it stop. Returns by `deadline`, with the sync stopped.
    pub(crate) async fn hold_sync_for_push(
        self: &Arc<Self>,
        session: &crate::SignedIn,
        room_id: &ruma::RoomId,
        event_id: Option<&ruma::EventId>,
        deadline: tokio::time::Instant,
    ) -> bool {
        let client = session.client().clone();
        let release_by = deadline - STOP_WAIT;
        self.activity.push_sync.set(true);
        // The room list brings one event per room: anything after the pushed one would hide it.
        let _ = tokio::time::timeout_at(
            release_by,
            session.subscribe_pushed_room(Some(room_id.to_owned())),
        )
        .await;
        // Bounded: queued behind a long job, it starts nothing once the hold is gone.
        let _ = tokio::time::timeout_at(release_by, self.apply_app_activity(false)).await;
        let until = release_by.min(tokio::time::Instant::now() + SYNC_WAIT);
        let completed = wait_for_event(&client, room_id, event_id, until).await;
        self.activity.push_sync.set(false);
        let _ = tokio::time::timeout(STOP_WAIT / 4, session.subscribe_pushed_room(None)).await;
        let half = STOP_WAIT / 2;
        if tokio::time::timeout(half, self.apply_app_activity(false))
            .await
            .is_err()
            && !self.activity.app_active()
            && session.state().calls.lock().await.is_empty()
        {
            // The queued reconcile stops it too once it runs; this keeps the deadline.
            let _ = tokio::time::timeout_at(
                deadline,
                crate::sync_support::stop(&session.sync_service()),
            )
            .await;
        }
        completed
    }
}

#[cfg(test)]
#[cfg(not(target_family = "wasm"))]
mod tests {
    use super::*;
    use crate::Core;

    #[test]
    fn one_sync_runs_at_a_time_and_a_completed_one_spaces_the_next() {
        let gate = PushSyncGate::default();
        assert!(gate.try_start("@a:x|A"));
        assert!(!gate.try_start("@a:x|A"), "one is already running");

        gate.finish("@a:x|A", false);
        assert!(
            gate.try_start("@a:x|A"),
            "an incomplete sync leaves the next push free to try"
        );

        gate.finish("@a:x|A", true);
        assert!(
            !gate.try_start("@a:x|A"),
            "the last sync completed too recently"
        );
    }

    #[test]
    fn one_logins_completed_sync_does_not_hold_back_anothers() {
        let gate = PushSyncGate::default();
        assert!(gate.try_start("@a:x|A"));
        assert!(gate.try_start("@b:x|B"), "another login syncs alongside");
        gate.finish("@a:x|A", true);
        gate.finish("@b:x|B", false);

        assert!(gate.try_start("@b:x|B"));
        assert!(!gate.try_start("@a:x|A"));
    }

    #[tokio::test]
    async fn a_held_push_sync_subscribes_the_pushed_room_beside_the_apps_own_and_restores_them() {
        use ruma::room_id;

        let server = matrix_sdk::test_utils::mocks::MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let warm = room_id!("!warm:example.org");
        let pushed = room_id!("!pushed:example.org");
        server.sync_joined_room(&client, warm).await;
        let (core, _events) = crate::test_support::signed_in_core(&server, client).await;
        let session = core.signed_in().unwrap();
        session
            .warm_rooms(crate::api::timeline::WarmRoomsParams {
                room_ids: vec![warm.to_owned()],
            })
            .await
            .unwrap();
        core.update_app_active(false).await;

        let hold = tokio::spawn({
            let (core, session) = (core.clone(), session.clone());
            async move {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
                core.hold_sync_for_push(&session, pushed, None, deadline)
                    .await
            }
        });
        let subscribed = || async { session.state().room_subscriptions.lock().await.clone() };
        tokio::time::timeout(Duration::from_secs(3), async {
            while !subscribed().await.contains(pushed) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the hold subscribes the pushed room");
        assert!(subscribed().await.contains(warm), "the app's own stay");

        hold.await.unwrap();
        assert_eq!(
            subscribed().await,
            std::collections::BTreeSet::from([warm.to_owned()])
        );
    }

    #[tokio::test]
    async fn a_held_push_sync_keeps_a_backgrounded_app_syncing_until_released() {
        let (core, _events) = Core::new(
            "test",
            Box::new(crate::store::MemorySessionStore::default()),
        );
        core.update_app_active(false).await;
        assert!(core.activity.sync_suspended());

        core.activity.push_sync.set(true);
        core.apply_app_activity(false).await;
        assert!(!core.activity.sync_suspended());

        core.update_app_active(true).await;
        core.activity.push_sync.set(false);
        core.apply_app_activity(false).await;
        assert!(
            !core.activity.sync_suspended(),
            "opening the app during the hold keeps it syncing"
        );

        core.update_app_active(false).await;
        assert!(core.activity.sync_suspended());
    }
}
