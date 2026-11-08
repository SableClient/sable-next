use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use base64::Engine as _;
use matrix_sdk::Client;
use matrix_sdk::deserialized_responses::EncryptionInfo;
use matrix_sdk::encryption::VerificationState;
use matrix_sdk::encryption::identities::Device;
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::events::macros::EventContent;
use matrix_sdk::ruma::events::{AnyToDeviceEventContent, StaticEventContent};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{DeviceId, OwnedDeviceId, OwnedRoomId};
use matrix_sdk_base::crypto::CollectStrategy;
use serde::{Deserialize, Serialize};
use web_time::Instant;

use crate::Core;
use crate::protocol::{
    CoreEvent, RpcError, RtcSignal, SearchPeerCandidateStatus, SearchPeerCandidateView,
    SearchPeerCopyView, SearchPeerDeviceView, SearchPeerOutcome, SearchPeerPause, SearchPeerState,
    SearchSharingView,
};
use crate::rtc::RtcPurpose;
use crate::sealed_account_data::verified_own_sender;
use crate::search::now_ms;

mod transfer;

use transfer::{Download, Received, Transfer};

const MAX_SERVING: usize = 2;
const MAX_ASKED: usize = 32;
const SESSION_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const DISCOVERY: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const RESYNC_AFTER: Duration = Duration::from_hours(7 * 24);
const INACTIVE_DEVICE: Duration = Duration::from_hours(90 * 24);
const SESSION_ID_LEN: usize = 32;
/// Devices only talk to devices using the same copy protocol. Events from
/// releases before this field existed fail to parse and are ignored.
const PROTOCOL_VERSION: u32 = 2;

#[derive(Clone, Debug, Deserialize, Serialize, EventContent)]
#[ruma_event(type = "moe.sable.search_peer.v1", kind = ToDevice)]
pub(crate) struct ToDeviceSearchPeerEventContent {
    version: u32,
    session: String,
    timestamp: u64,
    #[serde(flatten)]
    kind: Discovery,
}

impl ToDeviceSearchPeerEventContent {
    fn new(session: String, kind: Discovery) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            session,
            timestamp: now_ms(),
            kind,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Discovery {
    Query,
    Info { documents: u64, complete_rooms: u64 },
    Request,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Requester,
    Provider,
}

struct Peer {
    touched: Instant,
    transfer: Transfer,
}

#[derive(Clone)]
struct Slot {
    role: Role,
    device: OwnedDeviceId,
    peer: Arc<tokio::sync::Mutex<Peer>>,
}

impl Slot {
    fn new(role: Role, device: OwnedDeviceId, touched: Instant) -> Self {
        Self {
            role,
            device,
            peer: Arc::new(tokio::sync::Mutex::new(Peer {
                touched,
                transfer: match role {
                    Role::Provider => Transfer::Sending(None),
                    Role::Requester => Transfer::Receiving(Download::default()),
                },
            })),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Candidate {
    device: OwnedDeviceId,
    name: Option<String>,
    documents: u64,
    complete_rooms: u64,
    status: SearchPeerCandidateStatus,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Idle,
    Discovering {
        deadline: Instant,
    },
    Connecting {
        session: String,
        deadline: Instant,
    },
    Transferring {
        session: String,
    },
}

impl Phase {
    fn session(&self) -> Option<&str> {
        match self {
            Self::Connecting { session, .. } | Self::Transferring { session } => Some(session),
            Self::Idle | Self::Discovering { .. } => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Overdue {
    Discovery,
    Connection(String),
}

enum Next {
    Ignore,
    Try(OwnedDeviceId),
    Finished(SearchPeerOutcome),
}

#[derive(Default)]
struct Catchup {
    phase: Phase,
    query: String,
    asked: Vec<(OwnedDeviceId, Option<String>)>,
    candidates: Vec<Candidate>,
    current: Option<usize>,
    outcome: Option<SearchPeerOutcome>,
    rooms: usize,
}

impl Catchup {
    fn begin(&mut self, query: String, now: Instant) {
        *self = Self {
            phase: Phase::Discovering {
                deadline: now + DISCOVERY,
            },
            query,
            ..Self::default()
        };
    }

    fn finish(&mut self, outcome: Option<SearchPeerOutcome>) {
        self.phase = Phase::Idle;
        self.current = None;
        self.outcome = outcome;
    }

    fn reply(&mut self, device: &DeviceId, session: &str, documents: u64, complete_rooms: u64) {
        if self.phase == Phase::Idle
            || self.query != session
            || self.candidates.iter().any(|known| known.device == device)
        {
            return;
        }
        let Some((_, name)) = self.asked.iter().find(|(asked, _)| asked == device) else {
            return;
        };
        self.candidates.push(Candidate {
            device: device.to_owned(),
            name: name.clone(),
            documents,
            complete_rooms,
            status: SearchPeerCandidateStatus::Waiting,
        });
    }

    fn next(&mut self, failed: Option<&str>, session: String, now: Instant) -> Next {
        match (&self.phase, failed) {
            (Phase::Discovering { .. }, None) => {
                self.candidates.sort_by_key(|candidate| {
                    std::cmp::Reverse((candidate.documents, candidate.complete_rooms))
                });
            }
            (phase, Some(failed)) if phase.session() == Some(failed) => {
                if let Some(current) = self.current_mut() {
                    current.status = SearchPeerCandidateStatus::Failed;
                }
            }
            _ => return Next::Ignore,
        }
        let Some((index, candidate)) =
            self.candidates
                .iter_mut()
                .enumerate()
                .find(|(_, candidate)| {
                    candidate.status == SearchPeerCandidateStatus::Waiting
                        && candidate.documents > 0
                })
        else {
            let outcome = if self.candidates.is_empty() {
                SearchPeerOutcome::NoAnswer
            } else if self
                .candidates
                .iter()
                .all(|candidate| candidate.documents == 0)
            {
                SearchPeerOutcome::NothingToCopy
            } else if self.rooms > 0 {
                SearchPeerOutcome::Interrupted
            } else {
                SearchPeerOutcome::Failed
            };
            self.finish(Some(outcome));
            return Next::Finished(outcome);
        };
        self.current = Some(index);
        self.phase = Phase::Connecting {
            session,
            deadline: now + CONNECT_TIMEOUT,
        };
        candidate.status = SearchPeerCandidateStatus::Trying;
        Next::Try(candidate.device.clone())
    }

    fn current(&self) -> Option<&Candidate> {
        self.candidates.get(self.current?)
    }

    fn current_mut(&mut self) -> Option<&mut Candidate> {
        self.candidates.get_mut(self.current?)
    }

    fn overdue(&self, now: Instant) -> Option<Overdue> {
        match &self.phase {
            Phase::Discovering { deadline } if now >= *deadline => Some(Overdue::Discovery),
            Phase::Connecting { session, deadline } if now >= *deadline => {
                Some(Overdue::Connection(session.clone()))
            }
            _ => None,
        }
    }
}

#[derive(Default)]
pub(crate) struct SearchSharing {
    pub(crate) enabled: AtomicBool,
    /// The app is running the WebRTC side, so this device can answer and serve.
    available: AtomicBool,
    /// The automatic copy already ran since launch or since the network came back.
    auto_tried: AtomicBool,
    /// Bumped when saved copy data is wiped, so a copy that started before
    /// does not save part hashes afterwards.
    epoch: AtomicU64,
    slots: parking_lot::Mutex<HashMap<String, Slot>>,
    catchup: parking_lot::Mutex<Catchup>,
    restoring: parking_lot::Mutex<HashMap<OwnedRoomId, Instant>>,
    received: tokio::sync::Mutex<Option<Received>>,
}

impl SearchSharing {
    fn remove_expired(slots: &mut HashMap<String, Slot>, now: Instant) {
        slots.retain(|_, slot| {
            slot.peer.try_lock().map_or(true, |peer| {
                now.duration_since(peer.touched) < SESSION_TIMEOUT
            })
        });
    }

    pub(crate) fn discovering(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
            && matches!(self.catchup.lock().phase, Phase::Discovering { .. })
    }

    pub(crate) async fn reset_session(&self) {
        self.available.store(false, Ordering::Relaxed);
        self.auto_tried.store(false, Ordering::Relaxed);
        self.slots.lock().clear();
        self.restoring.lock().clear();
        *self.catchup.lock() = Catchup::default();
        *self.received.lock().await = None;
    }

    pub(crate) fn restoring(&self, room: &matrix_sdk::ruma::RoomId) -> bool {
        self.restoring
            .lock()
            .get(room)
            .is_some_and(|deadline| *deadline > Instant::now())
    }
}

impl Core {
    fn peers_allowed(&self) -> bool {
        self.search_sharing.enabled.load(Ordering::Relaxed) && self.search_peer_pause().is_none()
    }

    fn search_peer_pause(&self) -> Option<SearchPeerPause> {
        if !self.network_available.load(Ordering::Relaxed) {
            Some(SearchPeerPause::Offline)
        } else if !self.search_network.allows_crawl() {
            Some(SearchPeerPause::Metered)
        } else if !self.search_foreground.load(Ordering::Relaxed) {
            Some(SearchPeerPause::Background)
        } else {
            None
        }
    }

    pub(crate) async fn search_sharing_view(&self) -> SearchSharingView {
        let sharing = &self.search_sharing;
        if !sharing.enabled.load(Ordering::Relaxed) {
            return SearchSharingView::default();
        }
        let (rooms_received, last_copy, automatic) = {
            let received = sharing.received.lock().await;
            received.as_ref().map_or((0, None, false), |received| {
                (
                    received.known.len(),
                    received.last_copy.clone(),
                    received.copy_due(),
                )
            })
        };
        let serving = sharing
            .slots
            .lock()
            .values()
            .filter(|slot| slot.role == Role::Provider)
            .count();
        let catchup = sharing.catchup.lock();
        SearchSharingView {
            state: match catchup.phase {
                Phase::Idle => SearchPeerState::Idle,
                Phase::Discovering { .. } => SearchPeerState::Discovering,
                Phase::Connecting { .. } => SearchPeerState::Connecting,
                Phase::Transferring { .. } => SearchPeerState::Transferring,
            },
            pause: self.search_peer_pause(),
            outcome: catchup.outcome,
            peer: catchup.current().map(|candidate| SearchPeerDeviceView {
                device_id: candidate.device.to_string(),
                name: candidate.name.clone(),
            }),
            rooms_copied: catchup.rooms,
            rooms_received,
            last_copy,
            automatic,
            asked: catchup.asked.len(),
            serving,
            candidates: catchup
                .candidates
                .iter()
                .map(|candidate| SearchPeerCandidateView {
                    device_id: candidate.device.to_string(),
                    name: candidate.name.clone(),
                    documents: candidate.documents,
                    complete_rooms: candidate.complete_rooms,
                    status: candidate.status,
                })
                .collect(),
        }
    }

    pub(crate) fn cancel_search_peers(&self) {
        let sharing = &self.search_sharing;
        sharing.available.store(false, Ordering::Relaxed);
        sharing.slots.lock().clear();
        {
            let mut catchup = sharing.catchup.lock();
            match catchup.phase {
                Phase::Idle => {}
                Phase::Discovering { .. } => catchup.finish(None),
                Phase::Connecting { .. } | Phase::Transferring { .. } => {
                    catchup.finish(Some(SearchPeerOutcome::Interrupted));
                }
            }
        }
        sharing.auto_tried.store(false, Ordering::Relaxed);
        self.close_rtc_purpose(RtcPurpose::SearchSharing);
    }

    pub(crate) async fn forget_search_sharing(&self, client: &Client) {
        self.cancel_search_peers();
        *self.search_sharing.catchup.lock() = Catchup::default();
        self.search_sharing.restoring.lock().clear();
        self.clear_received(client).await;
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
                        let deferred = core.clone();
                        core.defer_to_device(Box::pin(async move {
                            deferred
                                .receive_search_peer(&client, generation, event, encryption)
                                .await;
                        }));
                    }
                }
            },
        );
        self.track_session_handler(client, handle);

        let weak = Arc::downgrade(self);
        self.track_session_task(
            spawn(async move {
                loop {
                    matrix_sdk::sleep::sleep(Duration::from_secs(1)).await;
                    let Some(core) = weak.upgrade() else { return };
                    if core.session_generation.load(Ordering::SeqCst) != generation {
                        return;
                    }
                    core.tick_search_peers().await;
                }
            })
            .abort_on_drop(),
        );

        let weak = Arc::downgrade(self);
        let mut verification = client.encryption().verification_state();
        self.track_session_task(
            spawn(async move {
                let mut previous = verification.get();
                while let Some(state) = verification.next().await {
                    if previous == VerificationState::Unverified
                        && state == VerificationState::Verified
                    {
                        verified(&weak).await;
                    }
                    previous = state;
                }
            })
            .abort_on_drop(),
        );
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
            || content.version != PROTOCOL_VERSION
            || content.session.len() != SESSION_ID_LEN
            || Duration::from_millis(now_ms().abs_diff(content.timestamp)) > SESSION_TIMEOUT
        {
            return;
        }
        let Some(device) = verified_own_sender(client, &event.sender, encryption).await else {
            return;
        };
        let _session = self.session.read().await;
        if self.session_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let id = device.device_id().to_owned();
        let session = content.session;
        match content.kind {
            Discovery::Query => {
                let documents = self.search_index.lock().await.stored_documents() as u64;
                let complete_rooms = self.search_crawl.lock().await.complete_rooms() as u64;
                let info = Discovery::Info {
                    documents,
                    complete_rooms,
                };
                if send_discovery(client, &id, &session, info).await.is_err() {
                    tracing::debug!(device = %id, "could not answer a search peer query");
                }
            }
            Discovery::Info {
                documents,
                complete_rooms,
            } => {
                self.search_sharing
                    .catchup
                    .lock()
                    .reply(&id, &session, documents, complete_rooms);
            }
            Discovery::Request => self.serve_search_peer(generation, session, id),
        }
    }

    fn serve_search_peer(&self, generation: u64, session: String, device: OwnedDeviceId) {
        let (accepted, replaced) = {
            let mut slots = self.search_sharing.slots.lock();
            SearchSharing::remove_expired(&mut slots, Instant::now());
            let replaced: Vec<String> = slots
                .iter()
                .filter(|(_, slot)| slot.role == Role::Provider && slot.device == device)
                .map(|(id, _)| id.clone())
                .collect();
            for id in &replaced {
                slots.remove(id);
            }
            let serving = slots
                .values()
                .filter(|slot| slot.role == Role::Provider)
                .count();
            let accepted = !slots.contains_key(&session) && serving < MAX_SERVING;
            if accepted {
                slots.insert(
                    session.clone(),
                    Slot::new(Role::Provider, device.clone(), Instant::now()),
                );
            }
            (accepted, replaced)
        };
        for session_id in replaced {
            self.close_rtc(&session_id);
            self.emit_if_current(
                generation,
                CoreEvent::Rtc {
                    session_id,
                    purpose: RtcPurpose::SearchSharing,
                    sender: true,
                    signal: RtcSignal::Close,
                },
            );
        }
        if !accepted {
            return;
        }
        if !self.open_rtc(RtcPurpose::SearchSharing, session.clone(), device, true) {
            self.search_sharing.slots.lock().remove(&session);
            return;
        }
        self.emit_if_current(
            generation,
            CoreEvent::Rtc {
                session_id: session,
                purpose: RtcPurpose::SearchSharing,
                sender: true,
                signal: RtcSignal::Open,
            },
        );
    }

    pub(crate) async fn start_search_peers(&self) -> Result<(), RpcError> {
        if !self.peers_allowed() {
            return Ok(());
        }
        let sharing = &self.search_sharing;
        sharing.available.store(true, Ordering::Relaxed);
        if sharing.auto_tried.load(Ordering::Relaxed) {
            return Ok(());
        }
        let client = self.client().await?;
        self.load_peer_receipts(&client).await;
        let due = sharing
            .received
            .lock()
            .await
            .as_ref()
            .is_some_and(Received::copy_due);
        if due {
            self.discover_search_peers(&client).await?;
        }
        sharing.auto_tried.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub(crate) async fn find_search_peers(&self) -> Result<(), RpcError> {
        if !self.peers_allowed() {
            return Err(RpcError::Unavailable);
        }
        self.search_sharing.available.store(true, Ordering::Relaxed);
        let client = self.client().await?;
        self.discover_search_peers(&client).await
    }

    async fn discover_search_peers(&self, client: &Client) -> Result<(), RpcError> {
        let query = session_id().ok_or(RpcError::Unavailable)?;
        {
            let mut catchup = self.search_sharing.catchup.lock();
            if catchup.phase != Phase::Idle {
                return Ok(());
            }
            catchup.begin(query.clone(), Instant::now());
        }
        let devices = match query_targets(client).await {
            Ok(devices) => devices,
            Err(error) => {
                self.finish_discovery(&query, SearchPeerOutcome::Failed);
                return Err(error);
            }
        };
        if devices.is_empty() {
            self.finish_discovery(&query, SearchPeerOutcome::NoDevices);
            return Ok(());
        }
        {
            let mut catchup = self.search_sharing.catchup.lock();
            if catchup.query != query {
                return Ok(());
            }
            catchup.asked = devices
                .iter()
                .map(|device| {
                    (
                        device.device_id().to_owned(),
                        device.display_name().map(str::to_owned),
                    )
                })
                .collect();
        }
        let content = ToDeviceSearchPeerEventContent::new(query.clone(), Discovery::Query);
        if let Err(error) = broadcast(client, &devices, &content).await {
            self.finish_discovery(&query, SearchPeerOutcome::Failed);
            return Err(error);
        }
        Ok(())
    }

    fn finish_discovery(&self, query: &str, outcome: SearchPeerOutcome) {
        let mut catchup = self.search_sharing.catchup.lock();
        if catchup.query == query {
            catchup.finish(Some(outcome));
        }
    }

    async fn tick_search_peers(&self) {
        let overdue = self.search_sharing.catchup.lock().overdue(Instant::now());
        let failed = match overdue {
            None => return,
            Some(Overdue::Discovery) => None,
            Some(Overdue::Connection(session)) => Some(session),
        };
        if let Some(session) = &failed {
            self.search_sharing.slots.lock().remove(session);
            self.close_rtc(session);
            self.emit(CoreEvent::Rtc {
                session_id: session.clone(),
                purpose: RtcPurpose::SearchSharing,
                sender: false,
                signal: RtcSignal::Close,
            });
        }
        self.next_search_peer(failed).await;
    }

    async fn next_search_peer(&self, mut failed: Option<String>) {
        let Ok(client) = self.client().await else {
            return;
        };
        loop {
            let Some(session) = session_id() else {
                self.search_sharing
                    .catchup
                    .lock()
                    .finish(Some(SearchPeerOutcome::Failed));
                return;
            };
            let next = self.search_sharing.catchup.lock().next(
                failed.as_deref(),
                session.clone(),
                Instant::now(),
            );
            let device = match next {
                Next::Finished(SearchPeerOutcome::NothingToCopy) => {
                    self.mark_synced(&client, None).await;
                    return;
                }
                Next::Ignore | Next::Finished(_) => return,
                Next::Try(device) => device,
            };
            self.search_sharing.slots.lock().insert(
                session.clone(),
                Slot::new(Role::Requester, device.clone(), Instant::now()),
            );
            if self.open_rtc(
                RtcPurpose::SearchSharing,
                session.clone(),
                device.clone(),
                false,
            ) && send_discovery(&client, &device, &session, Discovery::Request)
                .await
                .is_ok()
            {
                return;
            }
            self.search_sharing.slots.lock().remove(&session);
            self.close_rtc(&session);
            failed = Some(session);
        }
    }

    async fn complete_search_copy(&self, client: &Client, session: &str) {
        let copy = {
            let mut catchup = self.search_sharing.catchup.lock();
            if catchup.phase.session() != Some(session) {
                return;
            }
            let Some(current) = catchup.current_mut() else {
                return;
            };
            current.status = SearchPeerCandidateStatus::Done;
            let candidate = current.clone();
            let rooms = catchup.rooms;
            catchup.finish(Some(SearchPeerOutcome::Completed));
            SearchPeerCopyView {
                device_id: candidate.device.to_string(),
                name: candidate.name,
                at_ms: now_ms(),
                rooms,
            }
        };
        self.mark_synced(client, Some(copy)).await;
        self.emit(CoreEvent::Rtc {
            session_id: session.to_owned(),
            purpose: RtcPurpose::SearchSharing,
            sender: false,
            signal: RtcSignal::Close,
        });
    }

    async fn search_slot(&self, client: &Client, session_id: &str) -> Result<Slot, RpcError> {
        if !self.peers_allowed() {
            self.cancel_search_peers();
            return Err(RpcError::Unavailable);
        }
        let slot = self
            .search_sharing
            .slots
            .lock()
            .get(session_id)
            .cloned()
            .ok_or(RpcError::Unavailable)?;
        let mut peer = slot.peer.lock().await;
        if peer.touched.elapsed() > SESSION_TIMEOUT {
            return Err(RpcError::Unavailable);
        }
        let user = client.user_id().ok_or(RpcError::NotLoggedIn)?;
        if !client
            .encryption()
            .get_device(user, &slot.device)
            .await
            .ok()
            .flatten()
            .is_some_and(|device| device.is_verified())
        {
            return Err(RpcError::Unavailable);
        }
        peer.touched = Instant::now();
        drop(peer);
        Ok(slot)
    }

    pub(crate) async fn close_search_peer(&self, session_id: &str) {
        self.search_sharing.slots.lock().remove(session_id);
        self.next_search_peer(Some(session_id.to_owned())).await;
    }
}

async fn verified(core: &Weak<Core>) {
    let Some(core) = core.upgrade() else { return };
    if !core.search_sharing.available.load(Ordering::Relaxed) {
        return;
    }
    core.search_sharing
        .auto_tried
        .store(false, Ordering::Relaxed);
    if let Err(error) = core.start_search_peers().await {
        tracing::debug!(?error, "could not look for search peers after verification");
    }
}

fn age(timestamp_ms: u64) -> Duration {
    Duration::from_millis(now_ms().saturating_sub(timestamp_ms))
}

fn session_id() -> Option<String> {
    let mut random = [0_u8; 24];
    getrandom::fill(&mut random).ok()?;
    Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random))
}

async fn query_targets(client: &Client) -> Result<Vec<Device>, RpcError> {
    let own = client.user_id().ok_or(RpcError::NotLoggedIn)?;
    let devices = client
        .encryption()
        .get_user_devices(own)
        .await
        .map_err(|_| RpcError::Unavailable)?;
    let seen: Option<HashMap<OwnedDeviceId, Option<u64>>> =
        client.devices().await.ok().map(|response| {
            response
                .devices
                .into_iter()
                .map(|device| {
                    (
                        device.device_id,
                        device.last_seen_ts.map(|ts| u64::from(ts.get())),
                    )
                })
                .collect()
        });
    let mut targets: Vec<(u64, Device)> = devices
        .devices()
        .filter(|device| device.is_verified() && Some(device.device_id()) != client.device_id())
        .filter_map(|device| {
            let last_seen = match &seen {
                Some(seen) => *seen.get(device.device_id())?,
                None => None,
            };
            if last_seen.is_some_and(|ts| age(ts) > INACTIVE_DEVICE) {
                return None;
            }
            Some((last_seen.unwrap_or(0), device))
        })
        .collect();
    targets.sort_by_key(|(last_seen, _)| std::cmp::Reverse(*last_seen));
    targets.truncate(MAX_ASKED);
    Ok(targets.into_iter().map(|(_, device)| device).collect())
}

async fn broadcast(
    client: &Client,
    devices: &[Device],
    content: &ToDeviceSearchPeerEventContent,
) -> Result<(), RpcError> {
    let raw: Raw<AnyToDeviceEventContent> = Raw::new(content)
        .map_err(|_| RpcError::Unavailable)?
        .cast_unchecked();
    client
        .encryption()
        .encrypt_and_send_raw_to_device(
            devices.iter().collect(),
            ToDeviceSearchPeerEventContent::TYPE,
            raw,
            CollectStrategy::AllDevices,
        )
        .await
        .map(|_| ())
        .map_err(|_| RpcError::Unavailable)
}

async fn send_discovery(
    client: &Client,
    device: &DeviceId,
    session: &str,
    kind: Discovery,
) -> Result<(), RpcError> {
    let content = ToDeviceSearchPeerEventContent::new(session.to_owned(), kind);
    sable_frostbite::send(client, device, &content)
        .await
        .map_err(|_| RpcError::Unavailable)
}

#[cfg(test)]
mod tests;
