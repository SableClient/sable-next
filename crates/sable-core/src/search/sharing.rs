use std::collections::{HashMap, HashSet};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use matrix_sdk::Client;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::document::Document;
use super::persist::{self, Cover};

#[cfg(test)]
mod live;
mod peer;
pub(crate) use peer::{DISCOVERY, SearchSharing};

const MAX_SEGMENT_JSON: usize = 4 * 1024 * 1024;
const CLASSIFIED_JSON: usize = 24;

#[derive(Serialize, Deserialize)]
struct SegmentPayload {
    documents: Vec<Document>,
    classified: Vec<(OwnedEventId, u64)>,
    edits: Vec<(OwnedEventId, OwnedEventId)>,
    redacted: Vec<OwnedEventId>,
}

impl SegmentPayload {
    fn json(&self) -> Option<Vec<u8>> {
        serde_json::to_vec(self).ok()
    }

    fn decode(bytes: &[u8], start: u64, end: u64, digest: &str) -> Option<Self> {
        if bytes.len() > MAX_SEGMENT_JSON {
            return None;
        }
        let json = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(bytes, MAX_SEGMENT_JSON)
            .ok()?;
        if sha256(&json) != digest {
            return None;
        }
        let payload: Self = serde_json::from_slice(&json).ok()?;
        let valid = if start < end {
            payload
                .documents
                .iter()
                .all(|document| (start..end).contains(&document.origin_server_ts))
                && payload
                    .classified
                    .iter()
                    .all(|(_, ts)| (start..end).contains(ts))
        } else {
            payload.documents.is_empty()
                && payload.classified.is_empty()
                && payload.edits.is_empty()
        };
        valid.then_some(payload)
    }
}

fn sha256(json: &[u8]) -> String {
    STANDARD_NO_PAD.encode(Sha256::digest(json))
}

struct History {
    documents: Vec<Document>,
    classified: Vec<(OwnedEventId, u64)>,
    edits: HashMap<OwnedEventId, OwnedEventId>,
    weights: Vec<(u64, usize)>,
    redacted: Vec<OwnedEventId>,
}

impl History {
    fn new(
        mut documents: Vec<Document>,
        mut classified: Vec<(OwnedEventId, u64)>,
        edits: HashMap<OwnedEventId, OwnedEventId>,
        mut redacted: Vec<OwnedEventId>,
    ) -> Self {
        redacted.sort();
        let redacted_ids: HashSet<OwnedEventId> = redacted.iter().cloned().collect();
        documents.retain(|document| !document.is_redacted(&redacted_ids));
        documents.sort_by(|left, right| {
            (left.origin_server_ts, &left.event_id).cmp(&(right.origin_server_ts, &right.event_id))
        });
        classified.sort_by(|left, right| (left.1, &left.0).cmp(&(right.1, &right.0)));
        classified.dedup();
        let mut weights: Vec<(u64, usize)> = documents
            .iter()
            .map(|document| {
                (
                    document.origin_server_ts,
                    serde_json::to_vec(document).map_or(0, |json| json.len()),
                )
            })
            .chain(
                classified
                    .iter()
                    .map(|(event_id, ts)| (*ts, event_id.as_str().len() + CLASSIFIED_JSON)),
            )
            .collect();
        weights.sort_unstable();
        Self {
            documents,
            classified,
            edits,
            weights,
            redacted,
        }
    }

    fn weight(&self, start: u64, end: u64) -> usize {
        self.weights
            .iter()
            .filter(|(ts, _)| (start..end).contains(ts))
            .map(|(_, weight)| weight)
            .sum()
    }

    fn slice(&self, start: u64, end: u64) -> SegmentPayload {
        let documents: Vec<Document> = self
            .documents
            .iter()
            .filter(|document| (start..end).contains(&document.origin_server_ts))
            .cloned()
            .collect();
        let ids: HashSet<&OwnedEventId> = documents
            .iter()
            .map(|document| &document.event_id)
            .collect();
        let mut edits: Vec<(OwnedEventId, OwnedEventId)> = self
            .edits
            .iter()
            .filter(|(_, target)| ids.contains(target))
            .map(|(edit, target)| (edit.clone(), target.clone()))
            .collect();
        edits.sort();
        SegmentPayload {
            classified: self
                .classified
                .iter()
                .filter(|(_, ts)| (start..end).contains(ts))
                .cloned()
                .collect(),
            documents,
            edits,
            redacted: Vec::new(),
        }
    }

    fn part(&self, start: u64, end: u64) -> SegmentPayload {
        if start == end {
            self.corrections()
        } else {
            self.slice(start, end)
        }
    }

    fn corrections(&self) -> SegmentPayload {
        SegmentPayload {
            documents: Vec::new(),
            classified: Vec::new(),
            edits: Vec::new(),
            redacted: self.redacted.clone(),
        }
    }

    fn anchor(&self, from: u64, covered: u64) -> Option<OwnedEventId> {
        self.documents
            .iter()
            .rev()
            .find(|document| (from..covered).contains(&document.origin_server_ts))
            .map(|document| document.event_id.clone())
            .or_else(|| {
                self.classified
                    .iter()
                    .rev()
                    .find(|entry| (from..covered).contains(&entry.1))
                    .map(|entry| entry.0.clone())
            })
    }

    fn pack(&self, start: u64, end: u64, target: usize) -> Vec<(u64, u64)> {
        let mut cuts = vec![start];
        let mut held = 0;
        let mut entries = self
            .weights
            .iter()
            .copied()
            .filter(|(ts, _)| (start..end).contains(ts))
            .peekable();
        while let Some((ts, weight)) = entries.next() {
            held += weight;
            if let Some(&(next, _)) = entries.peek()
                && held >= target
                && next > ts
            {
                cuts.push(next);
                held = 0;
            }
        }
        let ends = cuts.iter().skip(1).copied().chain(std::iter::once(end));
        cuts.iter().copied().zip(ends).collect()
    }
}

async fn settled_history(client: &Client, room_id: &OwnedRoomId) -> Option<History> {
    let manifest = persist::read_manifest(client, room_id).await?;
    let mut documents = Vec::new();
    let mut classified = Vec::new();
    for entry in &manifest.chunks {
        let persist::ChunkRead::Found(stored) =
            persist::load_chunk(client, room_id, entry.id).await
        else {
            return None;
        };
        documents.extend(stored.documents);
        classified.extend(stored.classified);
    }
    Some(History::new(
        documents,
        classified,
        manifest.edits.into_iter().collect(),
        manifest.redacted,
    ))
}

fn merged_cover(
    local: Option<&Cover>,
    from: u64,
    until: u64,
    resume: Option<&str>,
    anchor: Option<&OwnedEventId>,
    crawled: bool,
) -> Cover {
    if let Some(local) = local
        && (from > local.until || local.from > until)
    {
        return local.clone();
    }
    local.map_or_else(
        || Cover {
            anchor: anchor.cloned(),
            from,
            until,
            resume: resume.map(str::to_owned),
            stops: from == 0 || (!crawled && resume.is_some()),
        },
        |local| Cover {
            anchor: if until >= local.until {
                anchor.cloned()
            } else {
                local.anchor.clone()
            },
            from: local.from.min(from),
            until: local.until.max(until),
            resume: if local.stops && from < local.from {
                resume.map(str::to_owned)
            } else {
                local.resume.clone()
            },
            stops: local.stops,
        },
    )
}
