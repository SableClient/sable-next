use std::collections::{HashMap, HashSet, VecDeque};

use base64::Engine as _;
use matrix_sdk::Client;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};
use serde::{Deserialize, Serialize};

use super::super::{
    History, MAX_SEGMENT_JSON, STANDARD_NO_PAD, SegmentPayload, settled_history, sha256,
};
use super::Peer;
use crate::Core;
use crate::protocol::{RpcError, SearchPeerState};
use crate::search::now_ms;

const STORE_KEY: &[u8] = b"sable.search.peers.v1";
const MAX_FRAME: usize = 6 * 1024 * 1024;
const ROOM_PAGE: usize = 32;
const MAX_PARTS: usize = 1024;
const SHA256_B64_LEN: usize = 43;
const RESTORING_MS: u64 = 30_000;

#[derive(Clone, Deserialize, Serialize)]
struct Part {
    start: u64,
    end: u64,
    sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Frame {
    List {
        offset: usize,
    },
    Rooms {
        rooms: Vec<OwnedRoomId>,
        next: Option<usize>,
    },
    Room {
        room: OwnedRoomId,
        known: Vec<String>,
    },
    Next {
        room: OwnedRoomId,
    },
    Part {
        room: OwnedRoomId,
        part: Part,
        data: Option<String>,
    },
    Done {
        room: OwnedRoomId,
        from: u64,
        until: u64,
        resume: Option<String>,
        anchor: Option<OwnedEventId>,
        coverage: bool,
    },
}

#[derive(Default, Deserialize, Serialize)]
pub(super) struct Received {
    parts: HashMap<OwnedRoomId, Vec<Part>>,
    pub(super) rooms: HashSet<OwnedRoomId>,
    covers: HashMap<OwnedRoomId, String>,
}

pub(super) struct Snapshot {
    room: OwnedRoomId,
    history: History,
    spans: VecDeque<(u64, u64)>,
    known: HashSet<String>,
    revision: u64,
    from: u64,
    until: u64,
    resume: Option<String>,
    anchor: Option<OwnedEventId>,
    coverage: bool,
}

#[derive(Default)]
pub(super) struct Download {
    finished: bool,
    rooms: VecDeque<OwnedRoomId>,
    next: Option<usize>,
    current: Option<OwnedRoomId>,
    parts: Vec<Part>,
    known: HashSet<String>,
    visited: HashSet<OwnedRoomId>,
}

impl Core {
    pub(crate) async fn exchange_search_peer(
        &self,
        session_id: &str,
        data: Option<String>,
    ) -> Result<Option<String>, RpcError> {
        if data.as_ref().is_some_and(|data| data.len() > MAX_FRAME) {
            return Err(RpcError::Unavailable);
        }
        let session = self.session.read().await;
        let client = session
            .as_ref()
            .ok_or(RpcError::NotLoggedIn)?
            .client
            .clone();
        let peer = self.search_peer(&client, session_id).await?;
        let mut peer = peer.lock().await;
        self.load_peer_receipts(&client).await;
        let Some(data) = data else {
            self.search_sharing.status.lock().0 = SearchPeerState::Transferring;
            peer.download = Download::default();
            return encode(&Frame::List { offset: 0 }).map(Some);
        };
        let frame: Frame = serde_json::from_str(&data).map_err(|_| RpcError::Unavailable)?;
        self.search_sharing.status.lock().0 = SearchPeerState::Transferring;
        let reply = match frame {
            Frame::List { offset } => Some(list_rooms(&client, offset)),
            Frame::Rooms { rooms, next } => {
                if peer.download.current.is_some()
                    || !peer.download.rooms.is_empty()
                    || rooms.len() > ROOM_PAGE
                {
                    return Err(RpcError::Unavailable);
                }
                peer.download.rooms = rooms
                    .into_iter()
                    .filter(|room| {
                        joined(&client, room) && peer.download.visited.insert(room.clone())
                    })
                    .collect();
                peer.download.next = next;
                self.next_peer_room(&client, &mut peer.download).await?
            }
            Frame::Room { room, known } => {
                if known.len() > MAX_PARTS || !joined(&client, &room) || peer.snapshot.is_some() {
                    return Err(RpcError::Unavailable);
                }
                peer.snapshot = self.peer_snapshot(&client, room.clone(), known).await;
                Some(self.next_peer_part(&mut peer, room).await?)
            }
            Frame::Next { room } => Some(self.next_peer_part(&mut peer, room).await?),
            Frame::Part { room, part, data } => {
                let download = &mut peer.download;
                if download.current.as_ref() != Some(&room)
                    || !joined(&client, &room)
                    || !valid_part(&download.parts, &part)
                {
                    return Err(RpcError::Unavailable);
                }
                if let Some(data) = data {
                    let payload = decode(&part, &data).ok_or(RpcError::Unavailable)?;
                    self.import_peer_payload(&client, &room, &part, payload)
                        .await?;
                } else if !download.known.contains(&part.sha256) {
                    return Err(RpcError::Unavailable);
                }
                download.parts.push(part);
                Some(Frame::Next { room })
            }
            Frame::Done {
                room,
                from,
                until,
                resume,
                anchor,
                coverage,
            } => {
                let download = &mut peer.download;
                if download.current.as_ref() != Some(&room) {
                    return Err(RpcError::Unavailable);
                }
                if coverage && complete(&download.parts, from, until) && joined(&client, &room) {
                    self.finish_peer_room(&client, &room, from, until, resume, anchor)
                        .await?;
                }
                download.current = None;
                download.parts.clear();
                self.search_sharing.restoring.lock().remove(&room);
                self.next_peer_room(&client, download).await?
            }
        };
        if peer.download.finished && peer.snapshot.is_none() {
            self.search_sharing.status.lock().0 = SearchPeerState::Idle;
        }
        reply.as_ref().map(encode).transpose()
    }

    pub(super) async fn load_peer_receipts(&self, client: &Client) {
        let mut received = self.search_sharing.received.lock().await;
        if received.is_none() {
            *received = Some(
                client
                    .state_store()
                    .get_custom_value(STORE_KEY)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                    .unwrap_or_default(),
            );
        }
        self.search_sharing.status.lock().1 =
            received.as_ref().map_or(0, |state| state.rooms.len());
    }

    async fn next_peer_room(
        &self,
        client: &Client,
        download: &mut Download,
    ) -> Result<Option<Frame>, RpcError> {
        if let Some(room) = download.rooms.pop_front() {
            let previous = self
                .search_sharing
                .received
                .lock()
                .await
                .as_ref()
                .and_then(|state| state.parts.get(&room))
                .cloned()
                .unwrap_or_default();
            let history = settled_history(client, &room).await;
            let known: Vec<_> = previous
                .iter()
                .filter(|part| {
                    history.as_ref().is_some_and(|history| {
                        let payload = if part.start == part.end {
                            history.corrections()
                        } else {
                            history.slice(part.start, part.end)
                        };
                        payload
                            .json()
                            .is_some_and(|json| sha256(&json) == part.sha256)
                    })
                })
                .map(|part| part.sha256.clone())
                .collect();
            download.known = known.iter().cloned().collect();
            download.current = Some(room.clone());
            self.search_sharing
                .restoring
                .lock()
                .insert(room.clone(), now_ms().saturating_add(RESTORING_MS));
            Ok(Some(Frame::Room { room, known }))
        } else if let Some(offset) = download.next.take() {
            Ok(Some(Frame::List { offset }))
        } else {
            download.finished = true;
            Ok(None)
        }
    }

    async fn peer_snapshot(
        &self,
        client: &Client,
        room: OwnedRoomId,
        known: Vec<String>,
    ) -> Option<Snapshot> {
        self.save_rooms(client, vec![room.clone()]).await;
        self.save_changed_checkpoints(client).await;
        let revision = {
            let index = self.search_index.lock().await;
            let revision = index.revision(&room);
            if !index.settled(&room) || !index.is_durable(&room, revision) {
                return None;
            }
            revision
        };
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
        let anchor = history.anchor(from, until);
        let mut spans = VecDeque::from([(0, 0)]);
        if until > from {
            let target = history
                .weight(from, until)
                .div_ceil(MAX_PARTS - 1)
                .max(128 * 1024)
                .next_power_of_two()
                .min(MAX_SEGMENT_JSON);
            spans.extend(history.pack(from, until, target));
        }
        let coverage = boundary == Some(from) && until > from;
        Some(Snapshot {
            room,
            history,
            spans,
            known: known.into_iter().collect(),
            revision,
            from,
            until,
            resume: if coverage { resume } else { None },
            anchor,
            coverage,
        })
    }

    async fn next_peer_part(&self, peer: &mut Peer, room: OwnedRoomId) -> Result<Frame, RpcError> {
        let Some(snapshot) = peer.snapshot.as_mut() else {
            return Ok(Frame::Done {
                room,
                from: 0,
                until: 0,
                resume: None,
                anchor: None,
                coverage: false,
            });
        };
        if snapshot.room != room {
            return Err(RpcError::Unavailable);
        }
        if let Some((start, end)) = snapshot.spans.pop_front() {
            let payload = if start == end {
                snapshot.history.corrections()
            } else {
                snapshot.history.slice(start, end)
            };
            let json = payload
                .json()
                .filter(|json| json.len() <= MAX_SEGMENT_JSON)
                .ok_or(RpcError::Unavailable)?;
            let part = Part {
                start,
                end,
                sha256: sha256(&json),
            };
            let data = (!snapshot.known.contains(&part.sha256)).then(|| {
                STANDARD_NO_PAD.encode(miniz_oxide::deflate::compress_to_vec_zlib(&json, 6))
            });
            Ok(Frame::Part { room, part, data })
        } else {
            let coverage = snapshot.coverage
                && self.search_index.lock().await.revision(&room) == snapshot.revision;
            let done = Frame::Done {
                room,
                from: snapshot.from,
                until: snapshot.until,
                resume: snapshot.resume.clone(),
                anchor: snapshot.anchor.clone(),
                coverage,
            };
            peer.snapshot = None;
            Ok(done)
        }
    }

    async fn import_peer_payload(
        &self,
        client: &Client,
        room: &OwnedRoomId,
        part: &Part,
        payload: SegmentPayload,
    ) -> Result<(), RpcError> {
        if !self.peers_allowed() {
            return Err(RpcError::Unavailable);
        }
        let useful = !payload.documents.is_empty()
            || !payload.classified.is_empty()
            || !payload.redacted.is_empty();
        let event_cache = client.event_cache().ok_or(RpcError::Unavailable)?;
        let (cache, _guard) = event_cache
            .room(room)
            .await
            .map_err(|_| RpcError::Unavailable)?;
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
        if !self.search_index.lock().await.is_durable(room, revision) {
            return Err(RpcError::Unavailable);
        }
        let mut received = self.search_sharing.received.lock().await;
        let received = received.get_or_insert_with(Received::default);
        let parts = received.parts.entry(room.clone()).or_default();
        parts.retain(|old| old.start != part.start || old.end != part.end);
        if parts.len() >= MAX_PARTS {
            parts.clear();
        }
        parts.push(part.clone());
        if useful {
            received.rooms.insert(room.clone());
        }
        self.search_sharing.status.lock().1 = received.rooms.len();
        save_received(client, received).await
    }

    async fn finish_peer_room(
        &self,
        client: &Client,
        room: &OwnedRoomId,
        from: u64,
        until: u64,
        resume: Option<String>,
        anchor: Option<OwnedEventId>,
    ) -> Result<(), RpcError> {
        let signature = sha256(
            &serde_json::to_vec(&(from, until, &resume, &anchor))
                .map_err(|_| RpcError::Unavailable)?,
        );
        let mut received = self.search_sharing.received.lock().await;
        let received = received.get_or_insert_with(Received::default);
        if received.covers.get(room) == Some(&signature) {
            return Ok(());
        }
        let mut cover = {
            let crawl = self.search_crawl.lock().await;
            super::super::merged_cover(
                crawl.cover_of(room),
                from,
                until,
                resume.as_deref(),
                anchor.as_ref(),
                crawl.has_token(room),
            )
        };
        let index = self.search_index.lock().await;
        let revision = index.revision(room);
        let floor = index.floor_of(room);
        drop(index);
        if floor > cover.from {
            cover.from = floor;
            cover.resume = None;
            cover.stops = false;
        }
        self.search_crawl.lock().await.cover(room, cover, revision);
        self.save_changed_checkpoints(client).await;
        received.covers.insert(room.clone(), signature);
        save_received(client, received).await
    }
}

fn list_rooms(client: &Client, offset: usize) -> Frame {
    let mut rooms: Vec<_> = client
        .joined_rooms()
        .into_iter()
        .map(|room| room.room_id().to_owned())
        .collect();
    rooms.sort();
    let next = (offset.saturating_add(ROOM_PAGE) < rooms.len())
        .then_some(offset.saturating_add(ROOM_PAGE));
    Frame::Rooms {
        rooms: rooms.into_iter().skip(offset).take(ROOM_PAGE).collect(),
        next,
    }
}

fn joined(client: &Client, room: &OwnedRoomId) -> bool {
    client
        .get_room(room)
        .is_some_and(|room| room.state() == matrix_sdk::RoomState::Joined)
}

async fn save_received(client: &Client, received: &Received) -> Result<(), RpcError> {
    let bytes = serde_json::to_vec(received).map_err(|_| RpcError::Unavailable)?;
    client
        .state_store()
        .set_custom_value(STORE_KEY, bytes)
        .await
        .map_err(|_| RpcError::Unavailable)?;
    Ok(())
}

fn encode(frame: &Frame) -> Result<String, RpcError> {
    serde_json::to_string(&frame)
        .ok()
        .filter(|data| data.len() <= MAX_FRAME)
        .ok_or(RpcError::Unavailable)
}

fn valid_part(previous: &[Part], part: &Part) -> bool {
    part.sha256.len() == SHA256_B64_LEN
        && previous.len() < MAX_PARTS
        && previous
            .last()
            .map_or(part.start == 0 && part.end == 0, |last| {
                part.start < part.end && (last.end == 0 || last.end == part.start)
            })
}

fn complete(parts: &[Part], from: u64, until: u64) -> bool {
    parts.get(1).is_some_and(|part| part.start == from)
        && parts.last().is_some_and(|part| part.end == until)
        && parts
            .windows(2)
            .skip(1)
            .all(|pair| matches!(pair, [left, right] if left.end == right.start))
}

fn decode(part: &Part, data: &str) -> Option<SegmentPayload> {
    let bytes = STANDARD_NO_PAD.decode(data).ok()?;
    SegmentPayload::decode(&bytes, part.start, part.end, &part.sha256)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::tests::document;

    fn part(start: u64, end: u64) -> Part {
        Part {
            start,
            end,
            sha256: "a".repeat(SHA256_B64_LEN),
        }
    }

    #[test]
    fn deletions_must_arrive_before_contiguous_history() {
        assert!(!valid_part(&[], &part(0, 10)));
        let parts = vec![part(0, 0), part(0, 10)];
        assert!(valid_part(&parts, &part(10, 20)));
        assert!(!valid_part(&parts, &part(11, 20)));
        assert!(!valid_part(&parts, &part(0, 0)));
        assert!(complete(&parts, 0, 10));
        assert!(!complete(&parts, 0, 20));
        assert!(!complete(&[part(0, 0), part(0, 10), part(11, 20)], 0, 20));
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
        let data = STANDARD_NO_PAD.encode(miniz_oxide::deflate::compress_to_vec_zlib(&json, 6));
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
        let data = STANDARD_NO_PAD.encode(miniz_oxide::deflate::compress_to_vec_zlib(&json, 6));
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
}
