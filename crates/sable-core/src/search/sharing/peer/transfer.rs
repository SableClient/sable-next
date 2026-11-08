use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use matrix_sdk::Client;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, RoomId};
use serde::{Deserialize, Serialize};
use web_time::Instant;

use super::super::{History, MAX_SEGMENT_JSON, SegmentPayload, settled_history, sha256};
use super::{RESYNC_AFTER, age};
use crate::Core;
use crate::protocol::{RpcError, SearchPeerCopyView};
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
    #[error("{0} is no longer joined")]
    NotJoined(OwnedRoomId),
    #[error("could not read the event cache of {0}")]
    EventCache(OwnedRoomId),
    #[error("the index could not save {0}")]
    NotDurable(OwnedRoomId),
    #[error("could not save the received parts")]
    Store,
}

impl CopyError {
    fn into_rpc(self) -> RpcError {
        match self {
            Self::Session(error) => error,
            _ => RpcError::Unavailable,
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

/// The receiver asks for one room at a time with `Room`, gets its part list
/// with `Parts`, then fetches each part it does not have with `Get` and `Data`.
#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(super) enum Message {
    Room {
        room: OwnedRoomId,
    },
    Parts {
        room: OwnedRoomId,
        parts: Vec<Part>,
        cover: Option<SharedCover>,
    },
    Get {
        room: OwnedRoomId,
        part: usize,
    },
    Data {
        room: OwnedRoomId,
        part: usize,
        #[serde(with = "serde_bytes")]
        data: Vec<u8>,
    },
}

impl Message {
    const fn kind(&self) -> &'static str {
        match self {
            Self::Room { .. } => "room",
            Self::Parts { .. } => "parts",
            Self::Get { .. } => "get",
            Self::Data { .. } => "data",
        }
    }
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
    Sending(Option<Snapshot>),
    Receiving(Download),
}

pub(super) struct Snapshot {
    room: OwnedRoomId,
    history: History,
    parts: Vec<Part>,
    cover: Option<SharedCover>,
}

#[derive(Default)]
pub(super) struct Download {
    epoch: u64,
    rooms: VecDeque<OwnedRoomId>,
    asked: Option<OwnedRoomId>,
    fetch: Option<Fetch>,
}

#[derive(Debug)]
struct Fetch {
    room: OwnedRoomId,
    parts: Vec<Part>,
    missing: VecDeque<usize>,
    cover: Option<SharedCover>,
}

impl Fetch {
    fn new(
        room: OwnedRoomId,
        parts: Vec<Part>,
        cover: Option<SharedCover>,
        known: &HashSet<String>,
    ) -> Result<Self, CopyError> {
        if !valid_parts(&parts, cover.as_ref()) {
            return Err(CopyError::InvalidParts(room));
        }
        let missing = parts
            .iter()
            .enumerate()
            .filter(|(_, part)| !known.contains(&part.sha256))
            .map(|(index, _)| index)
            .collect();
        Ok(Self {
            room,
            parts,
            missing,
            cover,
        })
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

    async fn exchange(
        &self,
        session_id: &str,
        data: Option<Vec<u8>>,
    ) -> Result<Option<Vec<u8>>, CopyError> {
        let message = data
            .map(|data| rmp_serde::from_slice::<Message>(&data).map_err(|_| CopyError::Malformed))
            .transpose()?;
        // Held for the whole exchange so a logout cannot reset the index
        // while this copy is still writing into it.
        let session = self.session.read().await;
        let client = session
            .as_ref()
            .ok_or(CopyError::Session(RpcError::NotLoggedIn))?
            .client
            .clone();
        let transfer = self
            .search_session(&client, session_id)
            .await
            .map_err(CopyError::Session)?;
        let mut transfer = transfer.lock().await;
        self.load_saved(&client).await;
        let reply = match (&mut *transfer, message) {
            (Transfer::Receiving(download), None) => {
                *download = Download {
                    epoch: self.search_sharing.state.lock().epoch,
                    rooms: joined_rooms(&client),
                    ..Download::default()
                };
                self.next_request(&client, session_id, download).await?
            }
            (Transfer::Receiving(download), Some(message)) => {
                self.receive(&client, session_id, download, message).await?
            }
            (Transfer::Sending(snapshot), Some(message)) => {
                Some(self.send(&client, snapshot, message).await?)
            }
            (Transfer::Sending(_), None) => None,
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

    async fn send(
        &self,
        client: &Client,
        snapshot: &mut Option<Snapshot>,
        message: Message,
    ) -> Result<Message, CopyError> {
        match message {
            Message::Room { room } => {
                *snapshot = if joined(client, &room) {
                    self.peer_snapshot(client, room.clone()).await
                } else {
                    None
                };
                let (parts, cover) = match snapshot {
                    Some(snapshot) => (snapshot.parts.clone(), snapshot.cover.clone()),
                    None => (Vec::new(), None),
                };
                Ok(Message::Parts { room, parts, cover })
            }
            Message::Get { room, part } => {
                let snapshot = snapshot
                    .as_ref()
                    .filter(|snapshot| snapshot.room == room)
                    .ok_or(CopyError::Unexpected("get"))?;
                let json = snapshot
                    .parts
                    .get(part)
                    .and_then(|info| snapshot.history.part(info.start, info.end).json())
                    .ok_or(CopyError::Unexpected("get"))?;
                let data = miniz_oxide::deflate::compress_to_vec_zlib(&json, 6);
                Ok(Message::Data { room, part, data })
            }
            other => Err(CopyError::Unexpected(other.kind())),
        }
    }

    async fn receive(
        &self,
        client: &Client,
        session_id: &str,
        download: &mut Download,
        message: Message,
    ) -> Result<Option<Message>, CopyError> {
        match message {
            Message::Parts { room, parts, cover } => {
                if download.asked.as_ref() != Some(&room) {
                    return Err(CopyError::Unexpected("parts"));
                }
                download.asked = None;
                let known = self.known_parts(&room);
                download.fetch = Some(Fetch::new(room, parts, cover, &known)?);
            }
            Message::Data { room, part, data } => {
                let fetch = download
                    .fetch
                    .as_mut()
                    .filter(|fetch| fetch.room == room && fetch.missing.front() == Some(&part))
                    .ok_or(CopyError::Unexpected("data"))?;
                let payload = fetch
                    .parts
                    .get(part)
                    .and_then(|info| decode(info, &data))
                    .ok_or_else(|| CopyError::BadPart {
                        room: room.clone(),
                        part,
                    })?;
                self.import_peer_payload(client, &room, payload).await?;
                fetch.missing.pop_front();
            }
            other => return Err(CopyError::Unexpected(other.kind())),
        }
        self.next_request(client, session_id, download).await
    }

    async fn next_request(
        &self,
        client: &Client,
        session_id: &str,
        download: &mut Download,
    ) -> Result<Option<Message>, CopyError> {
        if let Some(fetch) = &download.fetch
            && let Some(&part) = fetch.missing.front()
        {
            return Ok(Some(Message::Get {
                room: fetch.room.clone(),
                part,
            }));
        }
        if let Some(fetch) = download.fetch.take() {
            self.finish_peer_room(client, fetch, download.epoch).await?;
            self.copied_room(session_id);
        }
        let Some(room) = download.rooms.pop_front() else {
            return Ok(None);
        };
        self.search_sharing
            .state
            .lock()
            .restoring
            .insert(room.clone(), Instant::now() + RESTORING);
        download.asked = Some(room.clone());
        Ok(Some(Message::Room { room }))
    }

    fn copied_room(&self, session_id: &str) {
        self.update_sharing(|state| {
            if matches!(&state.phase, super::Phase::Receiving(session) if session.id == session_id)
            {
                state.rooms += 1;
            }
        });
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

    async fn peer_snapshot(&self, client: &Client, room: OwnedRoomId) -> Option<Snapshot> {
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
        Some(Snapshot {
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
            return Err(CopyError::Session(RpcError::Unavailable));
        }
        if !joined(client, room) {
            return Err(CopyError::NotJoined(room.clone()));
        }
        let (cache, _guard) = match client.event_cache() {
            Some(event_cache) => event_cache.room(room).await.ok(),
            None => None,
        }
        .ok_or_else(|| CopyError::EventCache(room.clone()))?;
        let revision = {
            let mut index = self.search_index.lock().await;
            index
                .import_redactions(room, payload.redacted, &cache)
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

    async fn finish_peer_room(
        &self,
        client: &Client,
        fetch: Fetch,
        epoch: u64,
    ) -> Result<(), CopyError> {
        let room = fetch.room;
        self.search_sharing.state.lock().restoring.remove(&room);
        if let Some(shared) = fetch.cover.filter(|_| joined(client, &room)) {
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
        if fetch.parts.is_empty() {
            return Ok(());
        }
        let kept = {
            let mut state = self.search_sharing.state.lock();
            let current = state.epoch == epoch;
            if current {
                state.saved.get_or_insert_with(Saved::default).known.insert(
                    room,
                    fetch.parts.into_iter().map(|part| part.sha256).collect(),
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

fn joined_rooms(client: &Client) -> VecDeque<OwnedRoomId> {
    let mut rooms: Vec<_> = client
        .joined_rooms()
        .into_iter()
        .map(|room| room.room_id().to_owned())
        .collect();
    rooms.sort();
    rooms.into()
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
        let fetch = Fetch::new("!room:localhost".try_into().unwrap(), parts, None, &known).unwrap();
        assert_eq!(fetch.missing, [0, 2]);
        assert!(matches!(
            Fetch::new(
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
        let message = Message::Data {
            room: "!room:localhost".try_into().unwrap(),
            part: 3,
            data: vec![0, 159, 255],
        };
        let bytes = rmp_serde::to_vec_named(&message).unwrap();
        assert!(
            bytes
                .windows(5)
                .any(|window| window == [0xc4, 3, 0, 159, 255])
        );
        let Message::Data { part, data, .. } = rmp_serde::from_slice(&bytes).unwrap() else {
            panic!("expected data");
        };
        assert_eq!((part, data), (3, vec![0, 159, 255]));
    }
}
