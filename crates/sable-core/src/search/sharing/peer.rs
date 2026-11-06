use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

use base64::Engine as _;
use matrix_sdk::Client;
use matrix_sdk::deserialized_responses::EncryptionInfo;
use matrix_sdk::ruma::events::macros::EventContent;
use matrix_sdk::ruma::{DeviceId, OwnedDeviceId, OwnedRoomId};
use serde::{Deserialize, Serialize};

use crate::Core;
use crate::protocol::{CoreEvent, RpcError, RtcSignal, SearchPeerState, SearchSharingView};
use crate::rtc::RtcPurpose;
use crate::sealed_account_data::verified_own_sender;
use crate::search::now_ms;

mod transfer;

use transfer::{Download, Received, Snapshot};

const MAX_PEERS: usize = 2;
const SESSION_MS: u64 = 120_000;
const RETRY_MS: u64 = 60_000;
pub(crate) const DISCOVERY_MS: u64 = 5_000;
const SESSION_ID_LEN: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "moe.sable.search_peer.v1", kind = ToDevice)]
pub(crate) struct ToDeviceSearchPeerEventContent {
    session: String,
    timestamp: u64,
    kind: Discovery,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Discovery {
    Probe,
    Ready,
}

struct Peer {
    device: OwnedDeviceId,
    initiator: bool,
    touched: u64,
    download: Download,
    snapshot: Option<Snapshot>,
}

impl Peer {
    fn new(device: OwnedDeviceId, initiator: bool, touched: u64) -> Arc<tokio::sync::Mutex<Self>> {
        Arc::new(tokio::sync::Mutex::new(Self {
            device,
            initiator,
            touched,
            download: Download::default(),
            snapshot: None,
        }))
    }
}

#[derive(Default)]
pub(crate) struct SearchSharing {
    pub(crate) enabled: AtomicBool,
    available: AtomicBool,
    last_start: AtomicU64,
    probe_cursor: AtomicUsize,
    peers: parking_lot::Mutex<HashMap<String, Arc<tokio::sync::Mutex<Peer>>>>,
    restoring: parking_lot::Mutex<HashMap<OwnedRoomId, u64>>,
    received: tokio::sync::Mutex<Option<Received>>,
    status: parking_lot::Mutex<(SearchPeerState, usize)>,
}

impl SearchSharing {
    fn rotate_probe_candidates<T>(&self, candidates: &mut [T]) {
        if !candidates.is_empty() {
            let offset = self.probe_cursor.fetch_add(1, Ordering::Relaxed) % candidates.len();
            candidates.rotate_left(offset);
        }
    }

    fn remove_expired(&self, now: u64) {
        self.peers.lock().retain(|_, peer| {
            peer.try_lock()
                .map_or(true, |peer| now.saturating_sub(peer.touched) < SESSION_MS)
        });
    }

    pub(crate) fn discovering(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
            && now_ms().saturating_sub(self.last_start.load(Ordering::Relaxed)) < DISCOVERY_MS
    }

    pub(crate) async fn reset_session(&self) {
        self.available.store(false, Ordering::Relaxed);
        self.peers.lock().clear();
        self.restoring.lock().clear();
        *self.received.lock().await = None;
        self.last_start.store(0, Ordering::Relaxed);
        self.probe_cursor.store(0, Ordering::Relaxed);
        *self.status.lock() = (SearchPeerState::Off, 0);
    }

    pub(crate) fn restoring(&self, room: &matrix_sdk::ruma::RoomId) -> bool {
        self.restoring
            .lock()
            .get(room)
            .is_some_and(|deadline| *deadline > now_ms())
    }

    pub(crate) fn view(&self) -> SearchSharingView {
        let (state, rooms_received) = *self.status.lock();
        SearchSharingView {
            state: if !self.enabled.load(Ordering::Relaxed) {
                SearchPeerState::Off
            } else if state == SearchPeerState::Off {
                SearchPeerState::Waiting
            } else {
                state
            },
            rooms_received,
        }
    }
}

impl Core {
    fn peers_allowed(&self) -> bool {
        self.search_sharing.enabled.load(Ordering::Relaxed)
            && self.network_available.load(Ordering::Relaxed)
            && self.search_network.allows_crawl()
            && self.search_foreground.load(Ordering::Relaxed)
    }

    pub(crate) fn cancel_search_peers(&self) {
        self.search_sharing
            .available
            .store(false, Ordering::Relaxed);
        self.search_sharing.peers.lock().clear();
        self.search_sharing.status.lock().0 = SearchPeerState::Waiting;
        self.close_rtc_purpose(RtcPurpose::SearchSharing);
    }

    pub(crate) fn watch_search_peers(self: &Arc<Self>, client: &Client, generation: u64) {
        let weak = Arc::downgrade(self);
        let handle = client.add_event_handler(
            move |event: ToDeviceSearchPeerEvent,
                  encryption: Option<EncryptionInfo>,
                  client: Client| {
                let weak = weak.clone();
                async move {
                    if let Some(core) = weak.upgrade() {
                        core.receive_search_peer(&client, generation, event, encryption)
                            .await;
                    }
                }
            },
        );
        self.track_session_handler(client, handle);
    }

    async fn receive_search_peer(
        &self,
        client: &Client,
        generation: u64,
        event: ToDeviceSearchPeerEvent,
        encryption: Option<EncryptionInfo>,
    ) {
        let content = event.content;
        if self.session_generation.load(Ordering::SeqCst) != generation
            || !self.peers_allowed()
            || !self.search_sharing.available.load(Ordering::Relaxed)
            || content.session.len() != SESSION_ID_LEN
            || now_ms().abs_diff(content.timestamp) > SESSION_MS
        {
            return;
        }
        let Some(device) = verified_own_sender(client, &event.sender, encryption).await else {
            return;
        };
        let _session = self.session.read().await;
        if self.session_generation.load(Ordering::SeqCst) != generation
            || !self.search_sharing.available.load(Ordering::Relaxed)
        {
            return;
        }
        let id = device.device_id().to_owned();
        let session = content.session;
        match content.kind {
            Discovery::Probe => {
                {
                    self.search_sharing.remove_expired(now_ms());
                    let mut peers = self.search_sharing.peers.lock();
                    if peers.contains_key(&session) || peers.len() >= MAX_PEERS {
                        return;
                    }
                    peers.insert(session.clone(), Peer::new(id.clone(), false, now_ms()));
                }
                if !self.open_rtc(
                    RtcPurpose::SearchSharing,
                    session.clone(),
                    id.clone(),
                    false,
                ) || send_discovery(client, &id, &session, Discovery::Ready)
                    .await
                    .is_err()
                {
                    self.search_sharing.peers.lock().remove(&session);
                    self.close_rtc(&session);
                }
            }
            Discovery::Ready => {
                let peer = self.search_sharing.peers.lock().get(&session).cloned();
                let Some(peer) = peer else { return };
                let mut peer = peer.lock().await;
                if !peer.initiator
                    || peer.device != id
                    || now_ms().saturating_sub(peer.touched) > SESSION_MS
                    || !self.open_rtc(RtcPurpose::SearchSharing, session.clone(), id, true)
                {
                    return;
                }
                peer.touched = now_ms();
                self.search_sharing.status.lock().0 = SearchPeerState::Connecting;
                self.emit_if_current(
                    generation,
                    CoreEvent::Rtc {
                        session_id: session,
                        sender: true,
                        signal: RtcSignal::Open,
                    },
                );
            }
        }
    }

    pub(crate) async fn start_search_peers(&self) -> Result<(), RpcError> {
        if !self.peers_allowed() {
            return Ok(());
        }
        let state = &self.search_sharing;
        state.available.store(true, Ordering::Relaxed);
        let now = now_ms();
        state.remove_expired(now);
        if !state.peers.lock().is_empty() {
            return Ok(());
        }
        let last = state.last_start.load(Ordering::Relaxed);
        if now.saturating_sub(last) < RETRY_MS {
            return Ok(());
        }
        if state
            .last_start
            .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return Ok(());
        }
        let session = self.session.read().await;
        let client = session
            .as_ref()
            .ok_or(RpcError::NotLoggedIn)?
            .client
            .clone();
        self.load_peer_receipts(&client).await;
        state.status.lock().0 = SearchPeerState::Waiting;
        let own = client.user_id().ok_or(RpcError::NotLoggedIn)?;
        let devices = client
            .encryption()
            .get_user_devices(own)
            .await
            .map_err(|_| RpcError::Unavailable)?;
        let mut candidates: Vec<_> = devices
            .devices()
            .filter(|device| device.is_verified() && Some(device.device_id()) != client.device_id())
            .collect();
        candidates.sort_by(|a, b| a.device_id().cmp(b.device_id()));
        state.rotate_probe_candidates(&mut candidates);
        for device in candidates.into_iter().take(MAX_PEERS) {
            let mut random = [0_u8; 24];
            getrandom::fill(&mut random).map_err(|_| RpcError::Unavailable)?;
            let session_id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random);
            state.peers.lock().insert(
                session_id.clone(),
                Peer::new(device.device_id().to_owned(), true, now),
            );
            if send_discovery(&client, device.device_id(), &session_id, Discovery::Probe)
                .await
                .is_err()
            {
                state.peers.lock().remove(&session_id);
            }
        }
        Ok(())
    }

    async fn search_peer(
        &self,
        client: &Client,
        session_id: &str,
    ) -> Result<Arc<tokio::sync::Mutex<Peer>>, RpcError> {
        if !self.peers_allowed() {
            self.cancel_search_peers();
            return Err(RpcError::Unavailable);
        }
        let peer = self
            .search_sharing
            .peers
            .lock()
            .get(session_id)
            .cloned()
            .ok_or(RpcError::Unavailable)?;
        let mut current = peer.lock().await;
        if now_ms().saturating_sub(current.touched) > SESSION_MS {
            return Err(RpcError::Unavailable);
        }
        let user = client.user_id().ok_or(RpcError::NotLoggedIn)?;
        if !client
            .encryption()
            .get_device(user, &current.device)
            .await
            .ok()
            .flatten()
            .is_some_and(|device| device.is_verified())
        {
            return Err(RpcError::Unavailable);
        }
        current.touched = now_ms();
        drop(current);
        Ok(peer)
    }

    pub(crate) fn close_search_peer(&self, session_id: &str) {
        let mut peers = self.search_sharing.peers.lock();
        peers.remove(session_id);
        if peers.is_empty() {
            let mut status = self.search_sharing.status.lock();
            status.0 = if status.1 > 0 {
                SearchPeerState::Idle
            } else {
                SearchPeerState::Waiting
            };
        }
    }
}

async fn send_discovery(
    client: &Client,
    device: &DeviceId,
    session: &str,
    kind: Discovery,
) -> Result<(), RpcError> {
    let content = ToDeviceSearchPeerEventContent {
        session: session.to_owned(),
        timestamp: now_ms(),
        kind,
    };
    sable_frostbite::send(client, device, &content)
        .await
        .map_err(|_| RpcError::Unavailable)
}

#[cfg(test)]
mod tests;
