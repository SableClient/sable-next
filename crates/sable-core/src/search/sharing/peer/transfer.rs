//! Core logic for the search sharing WebRTC protocol.
//!
//! Once a WebRTC connection is established, communication proceeds as follows:
//!
//! - The sending device sends a `RoomList` message with every room it has in its search index.
//! - For each room in the room list:
//!   - The receiving device sends a `RequestRoom` message.
//!   - The sending device sends a `ListParts` message with the search index parts for that room.
//!   - For each part of the room:
//!     - The receiving device sends a `RequestPart` message asking for the part.
//!     - The sending device sends a `PartData` message with the part's data.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use matrix_sdk::Client;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, RoomId};
use serde::{Deserialize, Serialize};
use web_time::Instant;

use super::super::{History, MAX_SEGMENT_JSON, SegmentPayload, settled_history, sha256};
use super::{RESYNC_AFTER, age};
use crate::Core;
use crate::protocol::{RpcCode, RpcError, SearchPeerCopyView};
use crate::search::now_ms;

const STORE_KEY: &[u8] = b"sable.search.peers.v1";
const MAX_PARTS: usize = 1024;
const SHA256_B64_LEN: usize = 43;
const RESTORING: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
enum CopyError {
    #[error("session unavailable: {0:?}")]
    Session(RpcError),
    #[error("malformed message")]
    Malformed,
    #[error("unexpected `{0}` message")]
    Unexpected(&'static str),
    #[error("invalid part list for {0}")]
    InvalidParts(OwnedRoomId),
    #[error("part {part} of {room} failed its hash or range check")]
    BadPart { room: OwnedRoomId, part: usize },
    #[error("the index could not save {0}")]
    NotDurable(OwnedRoomId),
    #[error("could not save the received parts")]
    Store,
}

impl CopyError {
    fn into_rpc(self) -> RpcError {
        match self {
            Self::Session(error) => error,
            _ => RpcCode::Unavailable.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct Part {
    start: u64,
    end: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct SharedCover {
    from: u64,
    until: u64,
    resume: Option<String>,
    anchor: Option<OwnedEventId>,
}

/// A message transferred between peers over the WebRTC connection.
#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum Message {
    RoomList { rooms: Vec<OwnedRoomId> },
    RequestRoom { room: OwnedRoomId },
    RequestPart { room: OwnedRoomId, part: usize },
    ListParts(ListParts),
    PartData(PartData),
}

#[derive(Deserialize, Serialize)]
pub(super) struct ListParts {
    room: OwnedRoomId,
    parts: Vec<Part>,
    cover: Option<SharedCover>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct PartData {
    room: OwnedRoomId,
    part: usize,
    #[serde(with = "serde_bytes")]
    data: Vec<u8>,
}

enum PartMessagePayload {
    ListParts(ListParts),
    PartData(PartData),
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default)]
pub(super) struct Saved {
    /// Hashes of the parts imported per room. Anything that drops indexed
    /// history must forget them, see `forget_shared_room`.
    known: HashMap<OwnedRoomId, HashSet<String>>,
    synced_at: Option<u64>,
    pub(super) last_copy: Option<SearchPeerCopyView>,
}

impl Saved {
    pub(super) fn copy_due(&self) -> bool {
        self.synced_at.is_none_or(|at| age(at) > RESYNC_AFTER)
    }
}

pub(super) enum Transfer {
    Sending(Option<SenderState>),
    Receiving(ReceiverState),
}

pub(super) struct SenderState {
    room: OwnedRoomId,
    history: History,
    parts: Vec<Part>,
    cover: Option<SharedCover>,
}

/// The receiving device's state.
pub(super) struct ReceiverState {
    /// The current search sharing session epoch.
    epoch: u64,
    /// The current state of the download state machine.
    state: DownloadState,
}

impl ReceiverState {
    pub(super) const fn new(epoch: u64) -> Self {
        Self {
            epoch,
            state: DownloadState::WaitingForRoomList,
        }
    }
}

/// The state of the receiving device.
enum DownloadState {
    /// The device is waiting for the sending device to provide a room list.
    WaitingForRoomList,
    /// The device is downloading rooms.
    DownloadingRooms(RoomDownloadState),
}

/// The state of a download task.
struct RoomDownloadState {
    pub queued_rooms: VecDeque<OwnedRoomId>,
    pub total_rooms: usize,
    finished_rooms: usize,
    step: RoomDownloadStep,
}

impl RoomDownloadState {
    fn new(mut queued_rooms: VecDeque<OwnedRoomId>) -> Option<(Self, OwnedRoomId)> {
        let total_rooms = queued_rooms.len();
        let pending_room = queued_rooms.pop_front()?;

        Some((
            Self {
                total_rooms,
                finished_rooms: 0,
                queued_rooms,
                step: RoomDownloadStep::WaitingForParts {
                    pending_room: pending_room.clone(),
                },
            },
            pending_room,
        ))
    }
}

/// The step a download task is on.
enum RoomDownloadStep {
    /// The receiving device is waiting for the room's parts list.
    WaitingForParts { pending_room: OwnedRoomId },
    /// The receving device is downloading the room's parts.
    DownloadingParts(PartsDownloadState),
    /// Every room was downloaded.
    Done,
}

/// The state of an individual room download.
#[derive(Debug)]
struct PartsDownloadState {
    room: OwnedRoomId,
    parts: Vec<Part>,
    missing: VecDeque<usize>,
    cover: Option<SharedCover>,
}

impl PartsDownloadState {
    fn new(
        room: OwnedRoomId,
        parts: Vec<Part>,
        cover: Option<SharedCover>,
        known: &HashSet<String>,
    ) -> Result<(Self, Option<usize>), CopyError> {
        if !valid_parts(&parts, cover.as_ref()) {
            return Err(CopyError::InvalidParts(room));
        }

        let mut missing: VecDeque<usize> = parts
            .iter()
            .enumerate()
            .filter(|(_, part)| !known.contains(&part.sha256))
            .map(|(index, _)| index)
            .collect();

        let first_missing_part = missing.pop_front();

        Ok((
            Self {
                room,
                parts,
                missing,
                cover,
            },
            first_missing_part,
        ))
    }
}

impl Core {
    pub(crate) async fn exchange_search_peer(
        &self,
        session_id: &str,
        data: Option<Vec<u8>>,
    ) -> Result<Option<Vec<u8>>, RpcError> {
        self.exchange(session_id, data).await.map_err(|error| {
            tracing::debug!(session = session_id, %error, "search copy stopped");
            error.into_rpc()
        })
    }

    /// Held for a whole exchange so a logout cannot reset the index while a copy still writes
    /// into it.
    pub(super) async fn copying_session(
        &self,
    ) -> Result<
        (
            tokio::sync::RwLockReadGuard<'_, Option<crate::session::Session>>,
            Client,
        ),
        RpcError,
    > {
        let session = self.session.read().await;
        let client = session.as_ref().ok_or(RpcCode::NotLoggedIn)?.client.clone();
        Ok((session, client))
    }

    /// Handle a message from the peer.
    async fn exchange(
        &self,
        session_id: &str,
        data: Option<Vec<u8>>,
    ) -> Result<Option<Vec<u8>>, CopyError> {
        let message = data
            .map(|data| {
                rmp_serde::from_slice::<Message>(&data).map_err(|error| {
                    tracing::debug!(%error, "search copy message did not decode");
                    CopyError::Malformed
                })
            })
            .transpose()?;
        let (_copying, client) = self.copying_session().await.map_err(CopyError::Session)?;
        let transfer = self
            .search_session(&client, session_id)
            .await
            .map_err(CopyError::Session)?;

        let mut transfer = transfer.lock().await;

        self.load_saved(&client).await;

        let reply = match (&mut *transfer, message) {
            (Transfer::Sending(_), None) => {
                // Send our room list to the receiver.
                let index = self.search_index.lock().await;

                Some(Message::RoomList {
                    rooms: index.rooms.keys().cloned().collect(),
                })
            }
            (Transfer::Receiving(_), None) => {
                // We need to wait on the sender to kick things off by sending the room list.
                return Ok(None);
            }
            (Transfer::Receiving(download), Some(message)) => {
                self.handle_as_receiver(&client, session_id, download, message)
                    .await?
            }
            (Transfer::Sending(snapshot), Some(message)) => {
                Some(self.handle_as_sender(&client, snapshot, message).await?)
            }
        };

        let finished = reply.is_none() && matches!(*transfer, Transfer::Receiving(_));
        drop(transfer);

        if finished {
            self.complete_search_copy(&client, session_id).await;
        }

        reply
            .map(|reply| rmp_serde::to_vec_named(&reply).map_err(|_| CopyError::Malformed))
            .transpose()
    }

    /// Handle a message from the receiver (this device is the sender).
    async fn handle_as_sender(
        &self,
        client: &Client,
        state: &mut Option<SenderState>,
        message: Message,
    ) -> Result<Message, CopyError> {
        // The sender's logic and state are a lot simpler than the receiver's:
        // we just send whatever they ask us for.
        match message {
            Message::RequestRoom { room } => {
                *state = if joined(client, &room) {
                    self.peer_snapshot(client, room.clone()).await
                } else {
                    None
                };
                let (parts, cover) = match state {
                    Some(snapshot) => (snapshot.parts.clone(), snapshot.cover.clone()),
                    None => (Vec::new(), None),
                };
                Ok(Message::ListParts(ListParts { room, parts, cover }))
            }
            Message::RequestPart { room, part } => {
                let snapshot = state
                    .as_ref()
                    .filter(|snapshot| snapshot.room == room)
                    .ok_or(CopyError::Unexpected("get"))?;
                let json = snapshot
                    .parts
                    .get(part)
                    .and_then(|info| snapshot.history.part(info.start, info.end).json())
                    .ok_or(CopyError::Unexpected("get"))?;
                let data = miniz_oxide::deflate::compress_to_vec_zlib(&json, 6);
                Ok(Message::PartData(PartData { room, part, data }))
            }
            _ => Err(CopyError::Unexpected(
                "invalid message for current sender state",
            )),
        }
    }

    /// Handle a message from the sender (this device is the receiver).
    async fn handle_as_receiver(
        &self,
        client: &Client,
        session_id: &str,
        ReceiverState { state, epoch }: &mut ReceiverState,
        message: Message,
    ) -> Result<Option<Message>, CopyError> {
        let response = match (message, &mut *state) {
            (Message::RoomList { rooms }, state @ DownloadState::WaitingForRoomList) => {
                if let Some((download_state, first_room_to_request)) =
                    RoomDownloadState::new(rooms.into())
                {
                    // Switch to DownloadingRooms state and ask for the first room in the queue
                    *state = DownloadState::DownloadingRooms(download_state);

                    Some(Message::RequestRoom {
                        room: first_room_to_request,
                    })
                } else {
                    // The peer has no rooms to offer us, we're done here.
                    return Ok(None);
                }
            }
            (Message::ListParts(part_list), DownloadState::DownloadingRooms(download_state)) => {
                self.advance_download_state(
                    client,
                    *epoch,
                    download_state,
                    PartMessagePayload::ListParts(part_list),
                )
                .await?
            }
            (Message::PartData(part_data), DownloadState::DownloadingRooms(download_state)) => {
                self.advance_download_state(
                    client,
                    *epoch,
                    download_state,
                    PartMessagePayload::PartData(part_data),
                )
                .await?
            }
            _ => {
                return Err(CopyError::Unexpected(
                    "invalid message for current receiver state",
                ));
            }
        };

        if let DownloadState::DownloadingRooms(download_state) = &*state {
            self.update_sharing(|state| {
                if matches!(&state.phase, super::Phase::Receiving(session) if session.id == session_id)
                {
                    state.transferred_rooms = download_state.finished_rooms;
                    state.total_rooms = download_state.total_rooms;
                }
            });
        }

        Ok(response)
    }

    async fn advance_download_state(
        &self,
        client: &Client,
        epoch: u64,
        state: &mut RoomDownloadState,
        message: PartMessagePayload,
    ) -> Result<Option<Message>, CopyError> {
        let (current_room, next_part) = match (&mut state.step, message) {
            (
                RoomDownloadStep::WaitingForParts { pending_room },
                PartMessagePayload::ListParts(ListParts { room, parts, cover }),
            ) => {
                let pending_room = pending_room.to_owned();
                if pending_room != room {
                    return Err(CopyError::Unexpected("got parts list for unexpected room"));
                }

                let known = self.known_parts(&room);
                let (parts, first_missing_part) =
                    PartsDownloadState::new(room, parts, cover, &known)?;
                state.step = RoomDownloadStep::DownloadingParts(parts);

                (pending_room, first_missing_part)
            }
            (
                RoomDownloadStep::DownloadingParts(parts),
                PartMessagePayload::PartData(PartData { room, part, data }),
            ) => {
                if parts.room != room {
                    return Err(CopyError::Unexpected("got parts data for unexpected room"));
                }

                let payload = parts
                    .parts
                    .get(part)
                    .and_then(|info| decode(info, &data))
                    .ok_or_else(|| CopyError::BadPart {
                        room: room.clone(),
                        part,
                    })?;
                self.import_peer_payload(client, &room, payload).await?;
                (room, parts.missing.pop_front())
            }
            _ => {
                return Err(CopyError::Unexpected(
                    "invalid message for current download step",
                ));
            }
        };

        // Update the timer for this room so the crawler will ignore it.
        self.search_sharing
            .state
            .lock()
            .restoring
            .insert(current_room.clone(), Instant::now() + RESTORING);

        if let Some(next_part) = next_part {
            // We're done with this part, let's ask for the next one.
            return Ok(Some(Message::RequestPart {
                room: current_room,
                part: next_part,
            }));
        }

        // We're out of parts for this room, let's ask for the next room, if any.
        let next_room = state.queued_rooms.pop_front();
        let next_step = next_room
            .clone()
            .map_or(RoomDownloadStep::Done, |pending_room| {
                RoomDownloadStep::WaitingForParts { pending_room }
            });
        let RoomDownloadStep::DownloadingParts(parts) =
            std::mem::replace(&mut state.step, next_step)
        else {
            // We can't reach this point without either explicitly setting `state.step` to `DownloadingParts`
            // or returning Err, but the compiler doesn't know that.
            unreachable!();
        };

        self.finish_receiving_room(client, parts, epoch).await?;
        state.finished_rooms += 1;

        Ok(next_room.map(|room| Message::RequestRoom { room }))
    }

    pub(super) async fn mark_synced(&self, client: &Client, copy: Option<SearchPeerCopyView>) {
        self.load_saved(client).await;
        self.update_sharing(|state| {
            let saved = state.saved.get_or_insert_with(Saved::default);
            saved.synced_at = Some(now_ms());
            if copy.is_some() {
                saved.last_copy = copy;
            }
        });
        if let Err(error) = self.save(client).await {
            tracing::warn!(%error, "could not save the search copy result");
        }
    }

    pub(crate) async fn forget_shared_room(&self, client: &Client, room: &RoomId) {
        self.load_saved(client).await;
        let removed = self
            .search_sharing
            .state
            .lock()
            .saved
            .as_mut()
            .is_some_and(|saved| saved.known.remove(room).is_some());
        if removed && let Err(error) = self.save(client).await {
            tracing::warn!(%error, "could not forget the received search parts");
        }
    }

    pub(super) async fn clear_saved(&self, client: &Client) {
        let _store = self.search_sharing.store.lock().await;
        self.update_sharing(|state| {
            state.epoch += 1;
            state.saved = Some(Saved::default());
        });
        if let Err(error) = client.state_store().remove_custom_value(STORE_KEY).await {
            tracing::warn!(%error, "could not clear the search sharing data");
        }
    }

    pub(super) async fn load_saved(&self, client: &Client) {
        if self.search_sharing.state.lock().saved.is_some() {
            return;
        }
        let _store = self.search_sharing.store.lock().await;
        if self.search_sharing.state.lock().saved.is_some() {
            return;
        }
        let saved = client
            .state_store()
            .get_custom_value(STORE_KEY)
            .await
            .ok()
            .flatten()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        self.update_sharing(|state| {
            state.saved.get_or_insert(saved);
        });
    }

    async fn save(&self, client: &Client) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let _store = self.search_sharing.store.lock().await;
        let bytes = self
            .search_sharing
            .state
            .lock()
            .saved
            .as_ref()
            .map(serde_json::to_vec)
            .transpose()?;
        if let Some(bytes) = bytes {
            client
                .state_store()
                .set_custom_value(STORE_KEY, bytes)
                .await?;
        }
        Ok(())
    }

    pub(super) fn known_parts(&self, room: &OwnedRoomId) -> HashSet<String> {
        self.search_sharing
            .state
            .lock()
            .saved
            .as_ref()
            .and_then(|saved| saved.known.get(room))
            .cloned()
            .unwrap_or_default()
    }

    async fn peer_snapshot(&self, client: &Client, room: OwnedRoomId) -> Option<SenderState> {
        self.save_rooms(client, vec![room.clone()]).await;
        self.save_changed_checkpoints(client).await;
        {
            let index = self.search_index.lock().await;
            if !index.settled(&room) || !index.is_durable(&room, index.revision(&room)) {
                return None;
            }
        }
        let history = settled_history(client, &room).await?;
        let (boundary, resume) = self.search_crawl.lock().await.share_boundary(&room);
        let floor = self.search_index.lock().await.floor_of(&room);
        let from = boundary
            .or_else(|| history.weights.first().map(|&(ts, _)| ts))
            .unwrap_or(0)
            .max(floor);
        let until = history
            .weights
            .last()
            .map_or(from, |&(ts, _)| ts.saturating_add(1));
        let mut spans = vec![(0, 0)];
        if until > from {
            let target = history
                .weight(from, until)
                .div_ceil(MAX_PARTS - 1)
                .max(128 * 1024)
                .next_power_of_two()
                .min(MAX_SEGMENT_JSON);
            spans.extend(history.pack(from, until, target));
        }
        let parts = spans
            .into_iter()
            .map(|(start, end)| {
                let json = history
                    .part(start, end)
                    .json()
                    .filter(|json| json.len() <= MAX_SEGMENT_JSON)?;
                Some(Part {
                    start,
                    end,
                    sha256: sha256(&json),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        let cover = (boundary == Some(from) && until > from).then(|| SharedCover {
            from,
            until,
            resume,
            anchor: history.anchor(from, until),
        });
        Some(SenderState {
            room,
            history,
            parts,
            cover,
        })
    }

    async fn import_peer_payload(
        &self,
        client: &Client,
        room: &OwnedRoomId,
        payload: SegmentPayload,
    ) -> Result<(), CopyError> {
        if !self.peers_allowed() {
            return Err(CopyError::Session(RpcCode::Unavailable.into()));
        }

        // We might not have a cache for the room if it hasn't come down sync yet.
        // That's mostly fine, it just means that we'll interpret redactions to replacement events
        // as redactions on the root message instead. Since replacements don't get redacted a whole lot,
        // this should be pretty uncommon.
        let cache = match client.event_cache() {
            Some(event_cache) => event_cache.room(room).await.ok(),
            None => None,
        };

        let revision = {
            let mut index = self.search_index.lock().await;
            index
                .import_redactions(
                    room,
                    payload.redacted,
                    cache.as_ref().map(|(cache, _)| cache),
                )
                .await;
            index
                .import(room, payload.documents, payload.classified, payload.edits)
                .await;
            index.revision(room)
        };
        self.save_rooms(client, vec![room.clone()]).await;
        if self.search_index.lock().await.is_durable(room, revision) {
            Ok(())
        } else {
            Err(CopyError::NotDurable(room.clone()))
        }
    }

    async fn finish_receiving_room(
        &self,
        client: &Client,
        parts: PartsDownloadState,
        epoch: u64,
    ) -> Result<(), CopyError> {
        let room = parts.room;
        self.search_sharing.state.lock().restoring.remove(&room);

        // If we know we're joined to this room, mark it as covered so crawling skips it.
        if let Some(shared) = parts.cover.filter(|_| joined(client, &room)) {
            let mut cover = {
                let crawl = self.search_crawl.lock().await;
                super::super::merged_cover(
                    crawl.cover_of(&room),
                    shared.from,
                    shared.until,
                    shared.resume.as_deref(),
                    shared.anchor.as_ref(),
                    crawl.has_token(&room),
                )
            };
            let (revision, floor) = {
                let index = self.search_index.lock().await;
                (index.revision(&room), index.floor_of(&room))
            };
            if floor > cover.from {
                cover.from = floor;
                cover.resume = None;
                cover.stops = false;
            }
            self.search_crawl.lock().await.cover(&room, cover, revision);
            self.save_changed_checkpoints(client).await;
        }

        if parts.parts.is_empty() {
            return Ok(());
        }

        let kept = {
            let mut state = self.search_sharing.state.lock();
            let current = state.epoch == epoch;
            if current {
                state.saved.get_or_insert_with(Saved::default).known.insert(
                    room,
                    parts.parts.into_iter().map(|part| part.sha256).collect(),
                );
            }
            current
        };
        if kept {
            self.save(client).await.map_err(|_| CopyError::Store)?;
        }
        Ok(())
    }
}

fn joined(client: &Client, room: &OwnedRoomId) -> bool {
    client
        .get_room(room)
        .is_some_and(|room| room.state() == matrix_sdk::RoomState::Joined)
}

/// Parts start with the redactions part `[0, 0)`, then cover a contiguous
/// time range. A shared crawl cover must match that range exactly.
fn valid_parts(parts: &[Part], cover: Option<&SharedCover>) -> bool {
    let Some((first, history)) = parts.split_first() else {
        return cover.is_none();
    };
    let ranges_ok = parts.len() <= MAX_PARTS
        && parts.iter().all(|part| part.sha256.len() == SHA256_B64_LEN)
        && first.start == 0
        && first.end == 0
        && history.iter().all(|part| part.start < part.end)
        && history
            .windows(2)
            .all(|pair| matches!(pair, [left, right] if left.end == right.start));
    ranges_ok
        && cover.is_none_or(|cover| {
            history.first().is_some_and(|part| part.start == cover.from)
                && history.last().is_some_and(|part| part.end == cover.until)
        })
}

fn decode(part: &Part, data: &[u8]) -> Option<SegmentPayload> {
    SegmentPayload::decode(data, part.start, part.end, &part.sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::tests::document;

    fn part(start: u64, end: u64) -> Part {
        Part {
            start,
            end,
            sha256: format!("{start:0>43}"),
        }
    }

    fn cover(from: u64, until: u64) -> SharedCover {
        SharedCover {
            from,
            until,
            resume: None,
            anchor: None,
        }
    }

    #[test]
    fn parts_start_with_redactions_and_cover_a_contiguous_range() {
        assert!(valid_parts(&[], None));
        assert!(!valid_parts(&[], Some(&cover(0, 10))));
        assert!(!valid_parts(&[part(0, 10)], None));
        let parts = [part(0, 0), part(0, 10), part(10, 20)];
        assert!(valid_parts(&parts, None));
        assert!(valid_parts(&parts, Some(&cover(0, 20))));
        assert!(!valid_parts(&parts, Some(&cover(0, 30))));
        assert!(!valid_parts(&[part(0, 0), part(0, 10), part(11, 20)], None));
        assert!(!valid_parts(&[part(0, 0), part(0, 0)], None));
    }

    #[test]
    fn only_parts_with_unknown_hashes_are_fetched() {
        let parts = vec![part(0, 0), part(1, 10), part(10, 20)];
        let known = HashSet::from([part(1, 10).sha256]);
        let (parts, first) =
            PartsDownloadState::new("!room:localhost".try_into().unwrap(), parts, None, &known)
                .unwrap();
        assert_eq!(first, Some(0));
        assert_eq!(parts.missing, [2]);
        assert!(matches!(
            PartsDownloadState::new(
                "!room:localhost".try_into().unwrap(),
                vec![part(5, 10)],
                None,
                &known
            ),
            Err(CopyError::InvalidParts(_))
        ));
    }

    #[test]
    fn a_peer_payload_is_checked_before_import() {
        let payload = SegmentPayload {
            documents: vec![document(
                "peer",
                "hello",
                "@kris:localhost",
                10,
                None,
                Vec::new(),
            )],
            classified: Vec::new(),
            edits: Vec::new(),
            redacted: Vec::new(),
        };
        let json = payload.json().unwrap();
        let data = miniz_oxide::deflate::compress_to_vec_zlib(&json, 6);
        let mut part = Part {
            start: 10,
            end: 11,
            sha256: sha256(&json),
        };
        assert!(decode(&part, &data).is_some());
        part.end = 10;
        assert!(decode(&part, &data).is_none());
        part.end = 11;
        part.sha256 = "a".repeat(SHA256_B64_LEN);
        assert!(decode(&part, &data).is_none());
    }

    #[test]
    fn decompression_is_bounded() {
        let json = vec![b' '; MAX_SEGMENT_JSON + 1];
        let data = miniz_oxide::deflate::compress_to_vec_zlib(&json, 6);
        assert!(
            decode(
                &Part {
                    start: 0,
                    end: 0,
                    sha256: sha256(&json)
                },
                &data
            )
            .is_none()
        );
    }

    #[test]
    fn part_data_travels_as_messagepack_binary() {
        let message = Message::PartData(PartData {
            room: "!room:localhost".try_into().unwrap(),
            part: 3,
            data: vec![0, 159, 255],
        });
        let bytes = rmp_serde::to_vec_named(&message).unwrap();
        assert!(
            bytes
                .windows(5)
                .any(|window| window == [0xc4, 3, 0, 159, 255])
        );
        let Message::PartData(PartData { part, data, .. }) = rmp_serde::from_slice(&bytes).unwrap()
        else {
            panic!("expected data");
        };
        assert_eq!((part, data), (3, vec![0, 159, 255]));
    }
}
