use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

use base64::Engine as _;
use matrix_sdk::Client;
use matrix_sdk::deserialized_responses::EncryptionInfo;
use matrix_sdk::encryption::identities::Device;
use matrix_sdk::event_handler::SyncEvent;
use matrix_sdk::ruma::events::StaticEventContent;
use matrix_sdk::ruma::events::macros::EventContent;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedDeviceId, OwnedRoomId, OwnedUserId};
use matrix_sdk_base::crypto::CollectStrategy;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::Core;
use crate::protocol::{
    CoreEvent, RpcError, SearchPeerCandidate, SearchPeerDescription, SearchPeerDescriptionType,
    SearchPeerSignal, SearchPeerState, SearchSharingView,
};
use crate::sealed_account_data::verified_own_sender;
use crate::search::now_ms;

mod transfer;

use transfer::{Download, Received, Snapshot};

const MAX_SDP: usize = 48 * 1024;
const MAX_CANDIDATE: usize = 1024;
const MAX_CANDIDATES: usize = 64;
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

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "computer.gingershaped.frostbite.negotiate", kind = ToDevice)]
pub(crate) struct ToDeviceFrostbiteNegotiateEventContent {
    session: String,
    timestamp: u64,
    description: SearchPeerDescription,
}

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "computer.gingershaped.frostbite.candidate", kind = ToDevice)]
pub(crate) struct ToDeviceFrostbiteCandidateEventContent {
    session: String,
    candidate: SearchPeerCandidate,
}

struct Incoming {
    sender: OwnedUserId,
    session: String,
    timestamp: Option<u64>,
    signal: Signal,
}

enum Signal {
    Discovery(Discovery),
    Negotiate(SearchPeerDescription),
    Candidate(SearchPeerCandidate),
}

fn valid_description(description: &SearchPeerDescription, from_initiator: bool) -> bool {
    let expected = if from_initiator {
        SearchPeerDescriptionType::Offer
    } else {
        SearchPeerDescriptionType::Answer
    };
    description.kind == expected && !description.sdp.is_empty() && description.sdp.len() <= MAX_SDP
}

fn valid_candidate(candidate: &SearchPeerCandidate) -> bool {
    candidate.candidate.len() + candidate.sdp_mid.as_ref().map_or(0, String::len) <= MAX_CANDIDATE
}

struct Peer {
    device: OwnedDeviceId,
    initiator: bool,
    touched: u64,
    candidates: usize,
    download: Download,
    snapshot: Option<Snapshot>,
}

impl Peer {
    fn new(device: OwnedDeviceId, initiator: bool, touched: u64) -> Arc<tokio::sync::Mutex<Self>> {
        Arc::new(tokio::sync::Mutex::new(Self {
            device,
            initiator,
            touched,
            candidates: 0,
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
        let peers = std::mem::take(&mut *self.search_sharing.peers.lock());
        self.search_sharing.status.lock().0 = SearchPeerState::Waiting;
        for (session_id, _) in peers {
            self.emit(CoreEvent::SearchPeer {
                session_id,
                initiator: false,
                signal: SearchPeerSignal::Close,
            });
        }
    }

    pub(crate) fn watch_search_peers(self: &Arc<Self>, client: &Client, generation: u64) {
        self.watch_search_signal(client, generation, |event: ToDeviceSearchPeerEvent| {
            let content = event.content;
            Incoming {
                sender: event.sender,
                session: content.session,
                timestamp: Some(content.timestamp),
                signal: Signal::Discovery(content.kind),
            }
        });
        self.watch_search_signal(
            client,
            generation,
            |event: ToDeviceFrostbiteNegotiateEvent| {
                let content = event.content;
                Incoming {
                    sender: event.sender,
                    session: content.session,
                    timestamp: Some(content.timestamp),
                    signal: Signal::Negotiate(content.description),
                }
            },
        );
        self.watch_search_signal(
            client,
            generation,
            |event: ToDeviceFrostbiteCandidateEvent| {
                let content = event.content;
                Incoming {
                    sender: event.sender,
                    session: content.session,
                    timestamp: None,
                    signal: Signal::Candidate(content.candidate),
                }
            },
        );
    }

    fn watch_search_signal<E>(
        self: &Arc<Self>,
        client: &Client,
        generation: u64,
        incoming: fn(E) -> Incoming,
    ) where
        E: SyncEvent + DeserializeOwned + Send + 'static,
    {
        let weak = Arc::downgrade(self);
        let handle = client.add_event_handler(
            move |event: E, encryption: Option<EncryptionInfo>, client: Client| {
                let weak = weak.clone();
                let incoming = incoming(event);
                async move {
                    if let Some(core) = weak.upgrade() {
                        core.receive_search_signal(&client, generation, encryption, incoming)
                            .await;
                    }
                }
            },
        );
        self.track_session_handler(client, handle);
    }

    async fn receive_search_signal(
        &self,
        client: &Client,
        generation: u64,
        encryption: Option<EncryptionInfo>,
        Incoming {
            sender,
            session,
            timestamp,
            signal,
        }: Incoming,
    ) {
        if self.session_generation.load(Ordering::SeqCst) != generation
            || !self.peers_allowed()
            || !self.search_sharing.available.load(Ordering::Relaxed)
            || session.len() != SESSION_ID_LEN
            || timestamp.is_some_and(|ts| now_ms().abs_diff(ts) > SESSION_MS)
        {
            return;
        }
        let Some(device) = verified_own_sender(client, &sender, encryption).await else {
            return;
        };
        let _session = self.session.read().await;
        if self.session_generation.load(Ordering::SeqCst) != generation
            || !self.search_sharing.available.load(Ordering::Relaxed)
        {
            return;
        }
        let id = device.device_id().to_owned();
        if matches!(signal, Signal::Discovery(Discovery::Probe)) {
            {
                self.search_sharing.remove_expired(now_ms());
                let mut peers = self.search_sharing.peers.lock();
                if peers.contains_key(&session) || peers.len() >= MAX_PEERS {
                    return;
                }
                peers.insert(session.clone(), Peer::new(id.clone(), false, now_ms()));
            }
            if send_signal(client, &id, &session, Signal::Discovery(Discovery::Ready))
                .await
                .is_err()
            {
                self.search_sharing.peers.lock().remove(&session);
            }
            return;
        }
        let peer = self.search_sharing.peers.lock().get(&session).cloned();
        let Some(peer) = peer else { return };
        let mut peer = peer.lock().await;
        if peer.device != id || now_ms().saturating_sub(peer.touched) > SESSION_MS {
            return;
        }
        peer.touched = now_ms();
        let signal = match signal {
            Signal::Discovery(Discovery::Ready) if peer.initiator => SearchPeerSignal::Open,
            Signal::Negotiate(description) if valid_description(&description, !peer.initiator) => {
                SearchPeerSignal::Negotiate { description }
            }
            Signal::Candidate(candidate)
                if valid_candidate(&candidate) && peer.candidates < MAX_CANDIDATES =>
            {
                peer.candidates += 1;
                SearchPeerSignal::Candidate { candidate }
            }
            _ => return,
        };
        self.search_sharing.status.lock().0 = SearchPeerState::Connecting;
        self.emit_if_current(
            generation,
            CoreEvent::SearchPeer {
                session_id: session,
                initiator: peer.initiator,
                signal,
            },
        );
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
            if send_signal(
                &client,
                device.device_id(),
                &session_id,
                Signal::Discovery(Discovery::Probe),
            )
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

    pub(crate) async fn signal_search_peer(
        &self,
        session_id: &str,
        signal: SearchPeerSignal,
    ) -> Result<(), RpcError> {
        let session = self.session.read().await;
        let client = session
            .as_ref()
            .ok_or(RpcError::NotLoggedIn)?
            .client
            .clone();
        let peer = self.search_peer(&client, session_id).await?;
        let (device, initiator) = {
            let peer = peer.lock().await;
            (peer.device.clone(), peer.initiator)
        };
        let signal = match signal {
            SearchPeerSignal::Negotiate { description }
                if valid_description(&description, initiator) =>
            {
                Signal::Negotiate(description)
            }
            SearchPeerSignal::Candidate { candidate } if valid_candidate(&candidate) => {
                Signal::Candidate(candidate)
            }
            _ => return Err(RpcError::Unavailable),
        };
        send_signal(&client, &device, session_id, signal).await
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

async fn send_signal(
    client: &Client,
    device_id: &matrix_sdk::ruma::DeviceId,
    session_id: &str,
    signal: Signal,
) -> Result<(), RpcError> {
    let user = client.user_id().ok_or(RpcError::NotLoggedIn)?;
    let device = client
        .encryption()
        .get_device(user, device_id)
        .await
        .map_err(|_| RpcError::Unavailable)?
        .filter(Device::is_verified)
        .ok_or(RpcError::Unavailable)?;
    let session = session_id.to_owned();
    let timestamp = now_ms();
    let (event_type, raw) = match signal {
        Signal::Discovery(kind) => (
            ToDeviceSearchPeerEventContent::TYPE,
            Raw::new(&ToDeviceSearchPeerEventContent {
                session,
                timestamp,
                kind,
            })
            .map(Raw::cast_unchecked),
        ),
        Signal::Negotiate(description) => (
            ToDeviceFrostbiteNegotiateEventContent::TYPE,
            Raw::new(&ToDeviceFrostbiteNegotiateEventContent {
                session,
                timestamp,
                description,
            })
            .map(Raw::cast_unchecked),
        ),
        Signal::Candidate(candidate) => (
            ToDeviceFrostbiteCandidateEventContent::TYPE,
            Raw::new(&ToDeviceFrostbiteCandidateEventContent { session, candidate })
                .map(Raw::cast_unchecked),
        ),
    };
    let raw = raw.map_err(|_| RpcError::Unavailable)?;
    let failures = client
        .encryption()
        .encrypt_and_send_raw_to_device(vec![&device], event_type, raw, CollectStrategy::AllDevices)
        .await
        .map_err(|_| RpcError::Unavailable)?;
    if failures.is_empty() {
        Ok(())
    } else {
        Err(RpcError::Unavailable)
    }
}

#[cfg(test)]
mod tests;
