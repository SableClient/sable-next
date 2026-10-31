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
    let mut turn = slot.lock_owned().await;
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

/// A push still running on an evicted client finishes with it.
pub fn evict(store_dir: &Path) {
    let store_dir = canonical(store_dir);
    CACHE.lock().retain(|key, _| key.store_dir != store_dir);
}
