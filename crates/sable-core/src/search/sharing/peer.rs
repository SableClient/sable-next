use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Weak;
use std::sync::atomic::{AtomicBool, Ordering};
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

use transfer::{Download, Saved, Transfer};

const MAX_ASKED: usize = 32;
const SESSION_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const DISCOVERY: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const BUSY_RETRY: Duration = Duration::from_secs(30);
const RESYNC_AFTER: Duration = Duration::from_hours(7 * 24);
const INACTIVE_DEVICE: Duration = Duration::from_hours(90 * 24);
const SESSION_ID_LEN: usize = 32;
/// Devices only talk to devices using the same copy protocol. Events from
/// releases before this field existed fail to parse and are ignored.
const PROTOCOL_VERSION: u32 = 4;

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
    /// Answers a `Query`, or refuses a `Request` with `busy` set.
    Info {
        documents: u64,
        complete_rooms: u64,
        busy: bool,
    },
    Request,
}

/// One WebRTC copy with another device. A device takes part in one at a time.
struct Session {
    id: String,
    device: OwnedDeviceId,
    touched: Instant,
    /// Locked for a whole message exchange, which awaits index and store writes.
    transfer: Arc<tokio::sync::Mutex<Transfer>>,
}

impl Session {
    fn new(id: String, device: OwnedDeviceId, transfer: Transfer, now: Instant) -> Self {
        Self {
            id,
            device,
            touched: now,
            transfer: Arc::new(tokio::sync::Mutex::new(transfer)),
        }
    }

    fn stale(&self, now: Instant) -> bool {
        now.duration_since(self.touched) >= SESSION_TIMEOUT
    }
}

#[derive(Default)]
enum Phase {
    #[default]
    Idle,
    Discovering {
        query: String,
        until: Instant,
    },
    /// The device with the most history is busy, discovery runs again at `until`.
    Waiting {
        until: Instant,
    },
    Connecting {
        session: Session,
        until: Instant,
    },
    Receiving(Session),
    Sending(Session),
}

impl Phase {
    const fn session(&self) -> Option<&Session> {
        match self {
            Self::Connecting { session, .. }
            | Self::Receiving(session)
            | Self::Sending(session) => Some(session),
            Self::Idle | Self::Discovering { .. } | Self::Waiting { .. } => None,
        }
    }

    const fn session_mut(&mut self) -> Option<&mut Session> {
        match self {
            Self::Connecting { session, .. }
            | Self::Receiving(session)
            | Self::Sending(session) => Some(session),
            Self::Idle | Self::Discovering { .. } | Self::Waiting { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Candidate {
    device: OwnedDeviceId,
    documents: u64,
    complete_rooms: u64,
    status: SearchPeerCandidateStatus,
}

impl Candidate {
    const fn score(&self) -> (u64, u64) {
        (self.documents, self.complete_rooms)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Overdue {
    Discovery,
    Retry,
    Session { id: String, sender: bool },
}

enum Next {
    Ignore,
    Wait,
    Try(OwnedDeviceId),
    Finished(SearchPeerOutcome),
}

/// Everything search sharing tracks, behind one lock. Changes that affect
/// [`SearchSharingView`] go through [`Core::update_sharing`], which emits it.
#[derive(Default)]
struct State {
    phase: Phase,
    asked: Vec<(OwnedDeviceId, Option<String>)>,
    candidates: Vec<Candidate>,
    /// This device's `(documents, complete_rooms)` when discovery ended. Only
    /// devices with more are copied from.
    own: (u64, u64),
    outcome: Option<SearchPeerOutcome>,
    rooms: usize,
    /// Loaded from the store on first use.
    saved: Option<Saved>,
    /// Bumped when `saved` is wiped, so a copy that started before does not
    /// save part hashes afterwards.
    epoch: u64,
    restoring: HashMap<OwnedRoomId, Instant>,
    /// The app is running the WebRTC side, so this device can answer and serve.
    available: bool,
    /// The automatic copy already ran since launch or since the network came back.
    auto_tried: bool,
    shown: Option<SearchSharingView>,
}

impl State {
    fn begin(&mut self, query: String, now: Instant) -> bool {
        if !matches!(self.phase, Phase::Idle | Phase::Waiting { .. }) {
            return false;
        }
        self.phase = Phase::Discovering {
            query,
            until: now + DISCOVERY,
        };
        self.asked.clear();
        self.candidates.clear();
        self.outcome = None;
        self.rooms = 0;
        true
    }

    fn finish(&mut self, outcome: Option<SearchPeerOutcome>) {
        self.phase = Phase::Idle;
        self.outcome = outcome;
    }

    fn name_of(&self, device: &DeviceId) -> Option<String> {
        self.asked
            .iter()
            .find(|(asked, _)| asked == device)
            .and_then(|(_, name)| name.clone())
    }

    fn candidate_mut(&mut self, device: &DeviceId) -> Option<&mut Candidate> {
        self.candidates
            .iter_mut()
            .find(|candidate| candidate.device == device)
    }

    /// Records an `Info`. Returns true when it refuses the session this
    /// device is connecting with.
    fn reply(
        &mut self,
        device: &DeviceId,
        session: &str,
        documents: u64,
        complete_rooms: u64,
        busy: bool,
    ) -> bool {
        match &self.phase {
            Phase::Discovering { query, .. } if query == session => {
                if self.asked.iter().any(|(asked, _)| asked == device)
                    && self.candidate_mut(device).is_none()
                {
                    self.candidates.push(Candidate {
                        device: device.to_owned(),
                        documents,
                        complete_rooms,
                        status: if busy {
                            SearchPeerCandidateStatus::Busy
                        } else {
                            SearchPeerCandidateStatus::Waiting
                        },
                    });
                }
                false
            }
            Phase::Connecting {
                session: current, ..
            } if busy && current.id == session && current.device == device => {
                if let Some(candidate) = self.candidate_mut(device) {
                    candidate.status = SearchPeerCandidateStatus::Busy;
                }
                true
            }
            _ => false,
        }
    }

    fn next(&mut self, failed: Option<&str>, session: String, now: Instant) -> Next {
        match (&self.phase, failed) {
            (Phase::Discovering { .. }, None) => {
                self.candidates
                    .sort_by_key(|candidate| std::cmp::Reverse(candidate.score()));
            }
            (Phase::Connecting { session, .. } | Phase::Receiving(session), Some(failed))
                if session.id == failed =>
            {
                let device = session.device.clone();
                if let Some(candidate) = self.candidate_mut(&device)
                    && candidate.status == SearchPeerCandidateStatus::Trying
                {
                    candidate.status = SearchPeerCandidateStatus::Failed;
                }
            }
            _ => return Next::Ignore,
        }
        let own = self.own;
        let Some(candidate) = self.candidates.iter_mut().find(|candidate| {
            matches!(
                candidate.status,
                SearchPeerCandidateStatus::Waiting | SearchPeerCandidateStatus::Busy
            ) && candidate.documents > 0
                && candidate.score() > own
        }) else {
            let outcome = if self.candidates.is_empty() {
                SearchPeerOutcome::NoAnswer
            } else if self
                .candidates
                .iter()
                .all(|candidate| candidate.documents == 0 || candidate.score() <= own)
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
        if candidate.status == SearchPeerCandidateStatus::Busy {
            self.phase = Phase::Waiting {
                until: now + BUSY_RETRY,
            };
            return Next::Wait;
        }
        candidate.status = SearchPeerCandidateStatus::Trying;
        let device = candidate.device.clone();
        self.phase = Phase::Connecting {
            session: Session::new(
                session,
                device.clone(),
                Transfer::Receiving(Download::default()),
                now,
            ),
            until: now + CONNECT_TIMEOUT,
        };
        Next::Try(device)
    }

    fn overdue(&self, now: Instant) -> Option<Overdue> {
        let session = |session: &Session, sender| Overdue::Session {
            id: session.id.clone(),
            sender,
        };
        match &self.phase {
            Phase::Idle => None,
            Phase::Discovering { until, .. } => (now >= *until).then_some(Overdue::Discovery),
            Phase::Waiting { until } => (now >= *until).then_some(Overdue::Retry),
            Phase::Connecting {
                session: current,
                until,
            } => (now >= *until).then(|| session(current, false)),
            Phase::Receiving(current) => current.stale(now).then(|| session(current, false)),
            Phase::Sending(current) => current.stale(now).then(|| session(current, true)),
        }
    }

    fn connected(&mut self, session_id: &str) {
        self.phase = match std::mem::take(&mut self.phase) {
            Phase::Connecting { session, .. } if session.id == session_id => {
                Phase::Receiving(session)
            }
            other => other,
        };
    }
}

#[derive(Default)]
pub(crate) struct SearchSharing {
    pub(crate) enabled: AtomicBool,
    state: parking_lot::Mutex<State>,
    /// Serializes store writes so the last one saves the latest state.
    store: tokio::sync::Mutex<()>,
}

impl SearchSharing {
    pub(crate) fn discovering(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
            && matches!(self.state.lock().phase, Phase::Discovering { .. })
    }

    pub(crate) fn reset_session(&self) {
        let mut state = self.state.lock();
        *state = State {
            epoch: state.epoch + 1,
            ..State::default()
        };
    }

    pub(crate) fn restoring(&self, room: &matrix_sdk::ruma::RoomId) -> bool {
        self.state
            .lock()
            .restoring
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

    fn update_sharing<R>(&self, change: impl FnOnce(&mut State) -> R) -> R {
        let (result, changed) = {
            let mut state = self.search_sharing.state.lock();
            let result = change(&mut state);
            let view = self.sharing_view_of(&state);
            let changed = (state.shown.as_ref() != Some(&view)).then(|| {
                state.shown = Some(view.clone());
                view
            });
            (result, changed)
        };
        if let Some(sharing) = changed {
            self.emit(CoreEvent::SearchSharing { sharing });
        }
        result
    }

    pub(crate) fn search_sharing_view(&self) -> SearchSharingView {
        self.sharing_view_of(&self.search_sharing.state.lock())
    }

    fn sharing_view_of(&self, state: &State) -> SearchSharingView {
        if !self.search_sharing.enabled.load(Ordering::Relaxed) {
            return SearchSharingView::default();
        }
        let peer = match &state.phase {
            Phase::Waiting { .. } => state
                .candidates
                .iter()
                .find(|candidate| candidate.status == SearchPeerCandidateStatus::Busy)
                .map(|candidate| &candidate.device),
            phase => phase.session().map(|session| &session.device),
        };
        SearchSharingView {
            state: match state.phase {
                Phase::Idle => SearchPeerState::Idle,
                Phase::Discovering { .. } => SearchPeerState::Discovering,
                Phase::Waiting { .. } => SearchPeerState::Waiting,
                Phase::Connecting { .. } => SearchPeerState::Connecting,
                Phase::Receiving(_) => SearchPeerState::Receiving,
                Phase::Sending(_) => SearchPeerState::Sending,
            },
            pause: self.search_peer_pause(),
            outcome: state.outcome,
            peer: peer.map(|device| SearchPeerDeviceView {
                device_id: device.to_string(),
                name: state.name_of(device),
            }),
            rooms_copied: state.rooms,
            last_copy: state
                .saved
                .as_ref()
                .and_then(|saved| saved.last_copy.clone()),
            automatic: state.saved.as_ref().is_some_and(Saved::copy_due),
            asked: state.asked.len(),
            candidates: state
                .candidates
                .iter()
                .map(|candidate| SearchPeerCandidateView {
                    device_id: candidate.device.to_string(),
                    name: state.name_of(&candidate.device),
                    documents: candidate.documents,
                    complete_rooms: candidate.complete_rooms,
                    status: candidate.status,
                })
                .collect(),
        }
    }

    pub(crate) fn refresh_search_peers(&self) {
        if self.search_peer_pause().is_some() {
            self.cancel_search_peers();
        } else {
            self.update_sharing(|_| {});
        }
    }

    pub(crate) fn cancel_search_peers(&self) {
        self.update_sharing(|state| {
            state.available = false;
            state.auto_tried = false;
            match state.phase {
                Phase::Idle => {}
                Phase::Discovering { .. } | Phase::Waiting { .. } => state.finish(None),
                Phase::Connecting { .. } | Phase::Receiving(_) => {
                    state.finish(Some(SearchPeerOutcome::Interrupted));
                }
                Phase::Sending(_) => state.phase = Phase::Idle,
            }
        });
        self.close_rtc_purpose(RtcPurpose::SearchSharing);
    }

    pub(crate) async fn forget_search_sharing(&self, client: &Client) {
        self.cancel_search_peers();
        self.update_sharing(|state| {
            *state = State {
                epoch: state.epoch,
                saved: state.saved.take(),
                shown: state.shown.take(),
                ..State::default()
            };
        });
        self.clear_saved(client).await;
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
                    if !core.is_current(generation) {
                        return;
                    }
                    core.tick_search_peers(generation).await;
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
        if !self.is_current(generation)
            || !self.peers_allowed()
            || !self.search_sharing.state.lock().available
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
        if !self.is_current(generation) {
            return;
        }
        let id = device.device_id().to_owned();
        let session = content.session;
        match content.kind {
            Discovery::Query => {
                let busy = self.search_sharing.state.lock().phase.session().is_some();
                self.send_info(client, &id, &session, busy).await;
            }
            Discovery::Info {
                documents,
                complete_rooms,
                busy,
            } => {
                let refused = self.update_sharing(|state| {
                    state.reply(&id, &session, documents, complete_rooms, busy)
                });
                if refused {
                    self.close_rtc(&session);
                    self.next_search_peer(Some(session)).await;
                }
            }
            Discovery::Request => {
                self.serve_search_peer(client, generation, session, id)
                    .await;
            }
        }
    }

    async fn search_score(&self) -> (u64, u64) {
        (
            self.search_index.lock().await.stored_documents() as u64,
            self.search_crawl.lock().await.complete_rooms() as u64,
        )
    }

    async fn send_info(&self, client: &Client, device: &DeviceId, session: &str, busy: bool) {
        let (documents, complete_rooms) = self.search_score().await;
        let info = Discovery::Info {
            documents,
            complete_rooms,
            busy,
        };
        if send_discovery(client, device, session, info).await.is_err() {
            tracing::debug!(%device, "could not answer a search peer");
        }
    }

    /// Two devices that request each other at once would both refuse, so the
    /// one with the smaller device ID gives up its own attempt and serves.
    async fn serve_search_peer(
        &self,
        client: &Client,
        generation: u64,
        session: String,
        device: OwnedDeviceId,
    ) {
        let now = Instant::now();
        let yields = client.device_id().is_some_and(|own| *own < *device);
        let accepted = self.update_sharing(|state| {
            let replaced = match &state.phase {
                Phase::Sending(current) if current.device == device || current.stale(now) => {
                    Some((current.id.clone(), true))
                }
                Phase::Connecting { session, .. } if session.device == device && yields => {
                    Some((session.id.clone(), false))
                }
                Phase::Idle | Phase::Discovering { .. } | Phase::Waiting { .. } => None,
                _ => return Err(()),
            };
            if !matches!(state.phase, Phase::Idle | Phase::Sending(_)) {
                state.auto_tried = false;
                state.outcome = None;
            }
            state.phase = Phase::Sending(Session::new(
                session.clone(),
                device.clone(),
                Transfer::Sending(None),
                now,
            ));
            Ok(replaced)
        });
        let Ok(replaced) = accepted else {
            self.send_info(client, &device, &session, true).await;
            return;
        };
        if let Some((session_id, sender)) = replaced {
            self.end_rtc(generation, session_id, sender);
        }
        if !self.open_rtc(RtcPurpose::SearchSharing, session.clone(), device, true) {
            self.close_search_peer(&session).await;
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

    fn end_rtc(&self, generation: u64, session_id: String, sender: bool) {
        self.close_rtc(&session_id);
        self.emit_if_current(
            generation,
            CoreEvent::Rtc {
                session_id,
                purpose: RtcPurpose::SearchSharing,
                sender,
                signal: RtcSignal::Close,
            },
        );
    }

    pub(crate) async fn start_search_peers(&self) -> Result<(), RpcError> {
        if !self.peers_allowed() {
            return Ok(());
        }
        let tried = self.update_sharing(|state| {
            state.available = true;
            state.auto_tried
        });
        if tried {
            return Ok(());
        }
        let client = self.client().await?;
        self.load_saved(&client).await;
        let due = self
            .search_sharing
            .state
            .lock()
            .saved
            .as_ref()
            .is_some_and(Saved::copy_due);
        if due {
            self.discover_search_peers(&client).await?;
        }
        let mut state = self.search_sharing.state.lock();
        state.auto_tried = !matches!(state.phase, Phase::Sending(_));
        Ok(())
    }

    pub(crate) async fn find_search_peers(&self) -> Result<(), RpcError> {
        if !self.peers_allowed() {
            return Err(RpcError::Unavailable);
        }
        self.update_sharing(|state| state.available = true);
        let client = self.client().await?;
        self.discover_search_peers(&client).await
    }

    async fn discover_search_peers(&self, client: &Client) -> Result<(), RpcError> {
        let query = session_id().ok_or(RpcError::Unavailable)?;
        if !self.update_sharing(|state| state.begin(query.clone(), Instant::now())) {
            return Ok(());
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
        self.update_sharing(|state| {
            if matches!(&state.phase, Phase::Discovering { query: current, .. } if *current == query)
            {
                state.asked = devices
                    .iter()
                    .map(|device| {
                        (
                            device.device_id().to_owned(),
                            device.display_name().map(str::to_owned),
                        )
                    })
                    .collect();
            }
        });
        let content = ToDeviceSearchPeerEventContent::new(query.clone(), Discovery::Query);
        if let Err(error) = broadcast(client, &devices, &content).await {
            self.finish_discovery(&query, SearchPeerOutcome::Failed);
            return Err(error);
        }
        Ok(())
    }

    fn finish_discovery(&self, query: &str, outcome: SearchPeerOutcome) {
        self.update_sharing(|state| {
            if matches!(&state.phase, Phase::Discovering { query: current, .. } if current == query)
            {
                state.finish(Some(outcome));
            }
        });
    }

    async fn tick_search_peers(&self, generation: u64) {
        let overdue = self.search_sharing.state.lock().overdue(Instant::now());
        match overdue {
            None => {}
            Some(Overdue::Discovery) => {
                let own = self.search_score().await;
                self.search_sharing.state.lock().own = own;
                self.next_search_peer(None).await;
            }
            Some(Overdue::Retry) => {
                if let Ok(client) = self.client().await
                    && let Err(error) = self.discover_search_peers(&client).await
                {
                    tracing::debug!(?error, "could not ask search peers again");
                }
            }
            Some(Overdue::Session { id, sender }) => {
                self.end_rtc(generation, id.clone(), sender);
                self.close_search_peer(&id).await;
            }
        }
    }

    async fn next_search_peer(&self, mut failed: Option<String>) {
        let Ok(client) = self.client().await else {
            return;
        };
        loop {
            let Some(session) = session_id() else {
                self.update_sharing(|state| state.finish(Some(SearchPeerOutcome::Failed)));
                return;
            };
            let next = self.update_sharing(|state| {
                state.next(failed.as_deref(), session.clone(), Instant::now())
            });
            let device = match next {
                Next::Finished(SearchPeerOutcome::NothingToCopy) => {
                    self.mark_synced(&client, None).await;
                    return;
                }
                Next::Ignore | Next::Wait | Next::Finished(_) => return,
                Next::Try(device) => device,
            };
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
            self.close_rtc(&session);
            failed = Some(session);
        }
    }

    async fn complete_search_copy(&self, client: &Client, session_id: &str) {
        let copy = self.update_sharing(|state| {
            let Phase::Receiving(session) = &state.phase else {
                return None;
            };
            if session.id != session_id {
                return None;
            }
            let device = session.device.clone();
            if let Some(candidate) = state.candidate_mut(&device) {
                candidate.status = SearchPeerCandidateStatus::Done;
            }
            state.finish(Some(SearchPeerOutcome::Completed));
            Some(SearchPeerCopyView {
                device_id: device.to_string(),
                name: state.name_of(&device),
                at_ms: now_ms(),
                rooms: state.rooms,
            })
        });
        let Some(copy) = copy else { return };
        self.mark_synced(client, Some(copy)).await;
        self.emit(CoreEvent::Rtc {
            session_id: session_id.to_owned(),
            purpose: RtcPurpose::SearchSharing,
            sender: false,
            signal: RtcSignal::Close,
        });
    }

    async fn search_session(
        &self,
        client: &Client,
        session_id: &str,
    ) -> Result<Arc<tokio::sync::Mutex<Transfer>>, RpcError> {
        if !self.peers_allowed() {
            self.cancel_search_peers();
            return Err(RpcError::Unavailable);
        }
        let now = Instant::now();
        let (device, transfer) = self
            .update_sharing(|state| {
                state.connected(session_id);
                let session = state
                    .phase
                    .session_mut()
                    .filter(|session| session.id == session_id && !session.stale(now))?;
                session.touched = now;
                Some((session.device.clone(), session.transfer.clone()))
            })
            .ok_or(RpcError::Unavailable)?;
        let user = client.user_id().ok_or(RpcError::NotLoggedIn)?;
        if !client
            .encryption()
            .get_device(user, &device)
            .await
            .ok()
            .flatten()
            .is_some_and(|device| device.is_verified())
        {
            return Err(RpcError::Unavailable);
        }
        Ok(transfer)
    }

    pub(crate) async fn close_search_peer(&self, session_id: &str) {
        let sending = self.update_sharing(|state| match &state.phase {
            Phase::Sending(session) if session.id == session_id => {
                state.phase = Phase::Idle;
                true
            }
            _ => false,
        });
        if !sending {
            self.next_search_peer(Some(session_id.to_owned())).await;
        }
    }
}

async fn verified(core: &Weak<Core>) {
    let Some(core) = core.upgrade() else { return };
    {
        let mut state = core.search_sharing.state.lock();
        if !state.available {
            return;
        }
        state.auto_tried = false;
    }
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
