use std::collections::{HashMap, HashSet};

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};

use super::DOCUMENT_OVERHEAD;
use super::document::{Document, adopt_edit, apply_replacement, replacement_of, room_message};
use super::persist::{self, ChunkId};
use crate::protocol::RoomAttachmentContentView;

const CHUNK_WEIGHT: usize = 8_000;

const DOCUMENT_WEIGHT: usize = 8;

pub(super) struct Saved {
    pub(super) sizes: HashMap<ChunkId, (usize, usize)>,
    pub(super) lost: Vec<ChunkId>,
    pub(super) removed: Vec<ChunkId>,
    pub(super) merged: Vec<ChunkId>,
    pub(super) redactions: HashSet<OwnedEventId>,
    pub(super) resolved: HashSet<OwnedEventId>,
}

pub(super) async fn save_room(
    client: &matrix_sdk::Client,
    room_id: &OwnedRoomId,
    mut flush: persist::Flush,
) -> Result<Saved, Box<persist::Flush>> {
    let mut sizes = HashMap::new();
    for (chunk, stored) in &flush.chunks {
        let Some(bytes) = persist::write_chunk(client, room_id, *chunk, stored).await else {
            return Err(Box::new(flush));
        };
        sizes.insert(*chunk, (bytes, stored.documents.len()));
    }
    apply_sizes(&mut flush.manifest, &sizes, &[]);
    if !persist::write_manifest(client, room_id, &flush.manifest).await {
        return Err(Box::new(flush));
    }

    let redactions: HashSet<OwnedEventId> =
        flush.manifest.pending_redactions.iter().cloned().collect();
    let edits = flush.manifest.pending_replacements.clone();
    let edits_by_target = group_replacements(&edits);
    let redacted = flush
        .manifest
        .redacted
        .iter()
        .cloned()
        .chain(redactions.iter().cloned())
        .collect();
    let targets: HashSet<ChunkId> = flush
        .cold
        .iter()
        .map(|(chunk, _)| *chunk)
        .chain(flush.scan.iter().copied())
        .collect();

    let mut resolved = HashSet::new();
    let mut lost = Vec::new();
    let mut merged = Vec::new();
    for chunk in targets {
        let mut stored = match persist::load_chunk(client, room_id, chunk).await {
            persist::ChunkRead::Found(stored) => stored,
            persist::ChunkRead::Missing => {
                lost.push(chunk);
                continue;
            }
            persist::ChunkRead::Unreadable => return Err(Box::new(flush)),
        };
        let patch = flush
            .cold
            .iter()
            .find(|(id, _)| *id == chunk)
            .map(|(_, patch)| patch);
        if merge_cold(
            &mut stored,
            patch,
            &redacted,
            &edits_by_target,
            &mut resolved,
        ) {
            let Some(bytes) = persist::write_chunk(client, room_id, chunk, &stored).await else {
                return Err(Box::new(flush));
            };
            sizes.insert(chunk, (bytes, stored.documents.len()));
        }
        if patch.is_some() {
            merged.push(chunk);
        }
    }

    if !merged.is_empty() || !lost.is_empty() || !redactions.is_empty() || !edits.is_empty() {
        apply_sizes(&mut flush.manifest, &sizes, &lost);
        flush.manifest.pending_redactions.clear();
        flush.manifest.pending_replacements.retain(|event| {
            event
                .event_id()
                .is_some_and(|edit| !resolved.contains(edit))
        });
        if !persist::write_manifest(client, room_id, &flush.manifest).await {
            return Err(Box::new(flush));
        }
    }
    for chunk in &flush.removed {
        persist::remove_chunk(client, room_id, *chunk).await;
    }
    if flush.legacy {
        persist::remove_legacy(client, room_id).await;
    }

    Ok(Saved {
        sizes,
        lost,
        removed: flush.removed,
        merged,
        redactions,
        resolved,
    })
}

fn apply_sizes(
    manifest: &mut persist::Manifest,
    sizes: &HashMap<ChunkId, (usize, usize)>,
    lost: &[ChunkId],
) {
    manifest.chunks.retain(|entry| !lost.contains(&entry.id));
    for entry in &mut manifest.chunks {
        if let Some((bytes, count)) = sizes.get(&entry.id) {
            entry.bytes = *bytes;
            entry.count = *count;
        }
    }
}

fn group_replacements(events: &[TimelineEvent]) -> HashMap<OwnedEventId, Vec<&TimelineEvent>> {
    let mut grouped: HashMap<_, Vec<_>> = HashMap::new();
    for event in events {
        if let Some((message, _)) = room_message(event)
            && let Some(replacement) = replacement_of(&message)
        {
            grouped
                .entry(replacement.event_id.clone())
                .or_default()
                .push(event);
        }
    }
    grouped
}

fn merge_cold(
    stored: &mut persist::StoredChunk,
    patch: Option<&persist::StoredChunk>,
    redactions: &HashSet<OwnedEventId>,
    edits: &HashMap<OwnedEventId, Vec<&TimelineEvent>>,
    resolved: &mut HashSet<OwnedEventId>,
) -> bool {
    let mut changed = false;
    if let Some(patch) = patch {
        let mut position: HashMap<OwnedEventId, usize> = stored
            .documents
            .iter()
            .enumerate()
            .map(|(index, document)| (document.event_id.clone(), index))
            .collect();
        for overlay in &patch.documents {
            if let Some(&index) = position.get(&overlay.event_id) {
                if let Some(disk) = stored.documents.get_mut(index) {
                    *disk = adopt_edit(overlay.clone(), Some(disk), redactions);
                }
            } else {
                position.insert(overlay.event_id.clone(), stored.documents.len());
                stored.documents.push(overlay.clone());
            }
            changed = true;
        }
        let known: HashSet<OwnedEventId> = stored
            .classified
            .iter()
            .map(|(event_id, _)| event_id.clone())
            .collect();
        for (event_id, ts) in &patch.classified {
            if !known.contains(event_id) {
                stored.classified.push((event_id.clone(), *ts));
                changed = true;
            }
        }
    }

    let before = stored.documents.len();
    stored
        .documents
        .retain(|document| !document.is_redacted(redactions));
    changed |= stored.documents.len() != before;

    if !edits.is_empty() {
        for disk in &mut stored.documents {
            if disk.encrypted.is_none() {
                continue;
            }
            let Some(replacements) = edits.get(&disk.event_id) else {
                continue;
            };
            for edit in replacements {
                if let Some(applied) = apply_replacement(disk, edit, redactions) {
                    changed |= applied;
                }
                if let Some(edit) = edit.event_id() {
                    resolved.insert(edit.to_owned());
                }
            }
        }
    }
    changed
}

pub(super) fn document_bytes(document: &Document) -> usize {
    let media: usize = document
        .media
        .iter()
        .map(|(_, content)| match content {
            RoomAttachmentContentView::Image {
                filename,
                source,
                blurhash,
                thumbnail,
                ..
            }
            | RoomAttachmentContentView::Video {
                filename,
                source,
                blurhash,
                thumbnail,
                ..
            } => {
                filename.len()
                    + source.len()
                    + blurhash.as_ref().map_or(0, String::len)
                    + thumbnail.as_ref().map_or(0, String::len)
            }
            RoomAttachmentContentView::File {
                filename, source, ..
            } => filename.len() + source.len(),
            RoomAttachmentContentView::Link { urls, body } => {
                body.len() + urls.iter().map(String::len).sum::<usize>()
            }
        })
        .sum();
    DOCUMENT_OVERHEAD + document.body.len() * 2 + media
}

pub(super) struct ChunkPiece {
    pub(super) start: u64,
    pub(super) documents: Vec<Document>,
    pub(super) classified: Vec<(OwnedEventId, u64)>,
}

pub(super) fn split_chunk(
    start: u64,
    documents: Vec<Document>,
    classified: Vec<(OwnedEventId, u64)>,
) -> Vec<ChunkPiece> {
    let mut weights: Vec<(u64, usize)> = documents
        .iter()
        .map(|document| (document.origin_server_ts, DOCUMENT_WEIGHT))
        .chain(classified.iter().map(|(_, ts)| (*ts, 1)))
        .collect();
    if weights.iter().map(|(_, weight)| weight).sum::<usize>() <= CHUNK_WEIGHT * 2 {
        return vec![ChunkPiece {
            start,
            documents,
            classified,
        }];
    }
    weights.sort_unstable();

    let mut starts = vec![start];
    let mut held = 0;
    for pair in weights.windows(2) {
        let &[(ts, weight), (next, _)] = pair else {
            continue;
        };
        held += weight;
        if held >= CHUNK_WEIGHT && next > ts {
            starts.push(next);
            held = 0;
        }
    }

    let piece_of = |ts: u64| {
        starts
            .partition_point(|&start| start <= ts)
            .saturating_sub(1)
    };
    let mut pieces: Vec<ChunkPiece> = starts
        .iter()
        .map(|&start| ChunkPiece {
            start,
            documents: Vec::new(),
            classified: Vec::new(),
        })
        .collect();
    for document in documents {
        if let Some(piece) = pieces.get_mut(piece_of(document.origin_server_ts)) {
            piece.documents.push(document);
        }
    }
    for (event_id, ts) in classified {
        if let Some(piece) = pieces.get_mut(piece_of(ts)) {
            piece.classified.push((event_id, ts));
        }
    }
    pieces
}

#[cfg(test)]
mod tests {
    use crate::search::tests::document;
    use matrix_sdk::ruma::event_id;

    #[test]
    fn test_merging_into_a_cold_chunk_keeps_one_copy_and_purges_redactions() {
        let mut stored = super::persist::StoredChunk::new(
            vec![
                document("kept", "old body", "@kris:localhost", 1, None, Vec::new()),
                document("gone", "secret", "@kris:localhost", 2, None, Vec::new()),
            ],
            vec![(event_id!("$kept").to_owned(), 1)],
        );
        let overlay = super::persist::StoredChunk::new(
            vec![document(
                "kept",
                "old body",
                "@kris:localhost",
                1,
                None,
                Vec::new(),
            )],
            vec![
                (event_id!("$kept").to_owned(), 1),
                (event_id!("$reaction").to_owned(), 1),
            ],
        );
        let redactions = [event_id!("$gone").to_owned()].into_iter().collect();
        let mut resolved = std::collections::HashSet::new();

        assert!(super::merge_cold(
            &mut stored,
            Some(&overlay),
            &redactions,
            &std::collections::HashMap::new(),
            &mut resolved
        ));

        let ids: Vec<String> = stored
            .documents
            .iter()
            .map(|document| document.event_id.to_string())
            .collect();
        assert_eq!(ids, ["$kept"]);
        assert_eq!(stored.classified.len(), 2);
    }

    #[test]
    fn test_a_pending_edit_lands_on_the_stored_original() {
        let mut stored = super::persist::StoredChunk::new(
            vec![document(
                "original",
                "typo",
                "@kris:localhost",
                5,
                None,
                Vec::new(),
            )],
            Vec::new(),
        );
        let edit = matrix_sdk::deserialized_responses::TimelineEvent::from_plaintext(
            serde_json::from_value(serde_json::json!({
                "type": "m.room.message", "event_id": "$edit", "sender": "@kris:localhost",
                "origin_server_ts": 900, "content": {
                    "msgtype": "m.text", "body": "* fixed",
                    "m.new_content": {"msgtype": "m.text", "body": "fixed"},
                    "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"}
                }
            }))
            .unwrap(),
        );
        let mut resolved = std::collections::HashSet::new();
        let edits = [edit];
        let grouped = super::group_replacements(&edits);

        super::merge_cold(
            &mut stored,
            None,
            &std::collections::HashSet::new(),
            &grouped,
            &mut resolved,
        );

        let [original] = stored.documents.as_slice() else {
            panic!("one document");
        };
        assert_eq!(original.body, "fixed");
        assert_eq!(original.origin_server_ts, 5);
        assert!(resolved.contains(event_id!("$edit")));
        resolved.clear();
        assert!(!super::merge_cold(
            &mut stored,
            None,
            &std::collections::HashSet::new(),
            &grouped,
            &mut resolved,
        ));
        assert!(resolved.contains(event_id!("$edit")));
    }
}
