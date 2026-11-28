use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use matrix_sdk::store::RoomLoadSettings;
use tokio::sync::OwnedMutexGuard;

use super::cold::{PushHost, push_host};

#[derive(PartialEq, Eq, Hash)]
struct Key {
    store_dir: PathBuf,
    user_id: String,
    device_id: String,
}

type Slot = Arc<tokio::sync::Mutex<Option<Arc<PushHost>>>>;

/// A process keeps one client per store, so a core taking the store must find none cached.
static CACHE: LazyLock<Mutex<HashMap<Key, Slot>>> = LazyLock::new(Mutex::default);

type Wanted = tokio::sync::watch::Sender<u64>;

/// Changes whenever a core or another push wants a store, so a push sync holding it lets go.
static WANTED: LazyLock<Mutex<HashMap<PathBuf, Wanted>>> = LazyLock::new(Mutex::default);

fn want(store_dir: &Path) {
    if let Some(wanted) = WANTED.lock().get(store_dir) {
        wanted.send_modify(|wants| *wants = wants.wrapping_add(1));
    }
}

/// Pushes for one cached login run one at a time on its client.
pub(super) struct ColdHost {
    host: Arc<PushHost>,
    _turn: Option<OwnedMutexGuard<Option<Arc<PushHost>>>>,
}

impl ColdHost {
    pub(super) fn uncached(host: PushHost) -> Self {
        Self {
            host: Arc::new(host),
            _turn: None,
        }
    }
}

impl std::ops::Deref for ColdHost {
    type Target = PushHost;

    fn deref(&self) -> &PushHost {
        &self.host
    }
}

fn canonical(store_dir: &Path) -> PathBuf {
    std::fs::canonicalize(store_dir).unwrap_or_else(|_| store_dir.into())
}

pub(super) async fn cold_host(
    store_dir: &Path,
    user_id: &str,
    device_id: &str,
) -> Option<ColdHost> {
    let slot = {
        let mut cache = CACHE.lock();
        // Checked under the lock `Core::new` takes to evict, so a store is never cached once a core owns it.
        if crate::Core::owning(store_dir).is_some() {
            None
        } else {
            let key = Key {
                store_dir: canonical(store_dir),
                user_id: user_id.to_owned(),
                device_id: device_id.to_owned(),
            };
            Some(cache.entry(key).or_default().clone())
        }
    };
    let Some(slot) = slot else {
        return push_host(store_dir, user_id, device_id, RoomLoadSettings::default())
            .await
            .map(ColdHost::uncached);
    };
    let mut turn = if let Ok(turn) = slot.clone().try_lock_owned() {
        turn
    } else {
        want(&canonical(store_dir));
        slot.lock_owned().await
    };
    if let Some(host) = turn.as_ref() {
        return Some(ColdHost {
            host: host.clone(),
            _turn: Some(turn),
        });
    }
    let host =
        Arc::new(push_host(store_dir, user_id, device_id, RoomLoadSettings::default()).await?);
    if matches!(*host, PushHost::Own(_)) {
        *turn = Some(host.clone());
    }
    Some(ColdHost {
        host,
        _turn: Some(turn),
    })
}

/// A login's turn with its cached client closed, so the store's lease is free for a push sync.
pub(super) struct SyncTurn {
    _turn: OwnedMutexGuard<Option<Arc<PushHost>>>,
    wanted: tokio::sync::watch::Receiver<u64>,
}

impl SyncTurn {
    /// Resolves once a core or another push wants the store.
    pub(super) async fn wanted(&mut self) {
        let _ = self.wanted.changed().await;
    }
}

/// `None` once a core owns the store, as it syncs itself, or while a push waits for the turn.
pub(super) async fn sync_turn(
    store_dir: &Path,
    user_id: &str,
    device_id: &str,
) -> Option<SyncTurn> {
    let (slot, wanted) = {
        let mut cache = CACHE.lock();
        if crate::Core::owning(store_dir).is_some() {
            return None;
        }
        let store_dir = canonical(store_dir);
        let wanted = WANTED
            .lock()
            .entry(store_dir.clone())
            .or_insert_with(|| Wanted::new(0))
            .subscribe();
        let key = Key {
            store_dir,
            user_id: user_id.to_owned(),
            device_id: device_id.to_owned(),
        };
        (cache.entry(key).or_default().clone(), wanted)
    };
    let mut turn = slot.lock_owned().await;
    // A push that queued behind this turn renders first, on the client still cached.
    if wanted.has_changed().unwrap_or(true) || crate::Core::owning(store_dir).is_some() {
        return None;
    }
    turn.take();
    Some(SyncTurn {
        _turn: turn,
        wanted,
    })
}

/// A push still running on an evicted client finishes with it.
pub fn evict(store_dir: &Path) {
    let store_dir = canonical(store_dir);
    let mut cache = CACHE.lock();
    cache.retain(|key, _| key.store_dir != store_dir);
    // Under the lock `sync_turn` checks for a core in, so a sync starting after this sees the core.
    want(&store_dir);
}
