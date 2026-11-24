use std::collections::HashSet;

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::ruma::{EventId, OwnedEventId, RoomId};
use sable_search::matching::indexed_text;
use sable_sql::{Rows, Statement, Value, statement};

use super::{Result, SqlError, Store, document_json, int, text};
use crate::search::document::{Document, adopt_edit, apply_replacement};

pub(in crate::search) fn decode(json: &[u8]) -> Option<Document> {
    let mut document: Document = serde_json::from_slice(json).ok()?;
    document.folded = document.body.to_lowercase();
    Some(document)
}

fn json_of(row: &[Value], column: usize) -> Option<Document> {
    decode(row.get(column)?.as_blob()?)
}

/// One room of the database. Writes wait in the transaction until something
/// reads or it commits, and then go out in one batch with that read.
///
/// Every batch commits on its own. Queue `mark_classified` and
/// `record_redacted` after the last read of an event, so they commit with its
/// writes: committed earlier, a write that then fails would never be retried.
pub(in crate::search) struct RoomTx<'store> {
    store: &'store Store,
    pub(super) room: String,
    queued: Vec<Statement>,
    pub(in crate::search) redacted: HashSet<OwnedEventId>,
}

impl<'store> RoomTx<'store> {
    pub(super) async fn open(store: &'store Store, room: &RoomId) -> Result<Self> {
        let answers = store
            .run(vec![
                statement!(
                    "INSERT OR IGNORE INTO room (room_id) VALUES (?1)",
                    room.as_str()
                ),
                statement!(
                    "SELECT event_id FROM redacted WHERE room_id = ?1",
                    room.as_str()
                ),
            ])
            .await?;
        let redacted = answers
            .get(1)
            .into_iter()
            .flatten()
            .filter_map(|row| OwnedEventId::try_from(text(row, 0)?).ok())
            .collect();
        Ok(Self {
            store,
            room: room.as_str().to_owned(),
            queued: Vec::new(),
            redacted,
        })
    }

    pub(super) fn queue(&mut self, statement: Statement) {
        self.queued.push(statement);
    }

    pub(super) async fn read(&mut self, statement: Statement) -> Result<Rows> {
        let mut batch = std::mem::take(&mut self.queued);
        batch.push(statement);
        Ok(self.store.run(batch).await?.pop().unwrap_or_default())
    }

    /// Sends what is still queued.
    pub(in crate::search) async fn commit(&mut self) -> Result<()> {
        if self.queued.is_empty() {
            return Ok(());
        }
        let batch = std::mem::take(&mut self.queued);
        self.store.run(batch).await.map(drop)
    }

    pub(in crate::search) async fn floor(&mut self) -> Result<u64> {
        let rows = self
            .read(statement!(
                "SELECT floor FROM room WHERE room_id = ?1",
                self.room.as_str()
            ))
            .await?;
        Ok(rows.first().and_then(|row| int(row, 0)).unwrap_or(0))
    }

    pub(in crate::search) fn mark_classified(&mut self, event_id: &EventId, ts: u64) {
        self.queue(statement!(
            "INSERT OR IGNORE INTO classified (room_id, event_id, ts) VALUES (?1, ?2, ?3)",
            self.room.as_str(),
            event_id.as_str(),
            ts
        ));
    }

    pub(in crate::search) fn unclassify(&mut self, event_id: &EventId) {
        self.queue(statement!(
            "DELETE FROM classified WHERE room_id = ?1 AND event_id = ?2",
            self.room.as_str(),
            event_id.as_str()
        ));
    }

    async fn row(&mut self, event_id: &EventId) -> Result<Option<(u64, Document)>> {
        let rows = self
            .read(statement!(
                "SELECT id, json FROM doc WHERE room_id = ?1 AND event_id = ?2",
                self.room.as_str(),
                event_id.as_str()
            ))
            .await?;
        Ok(rows
            .first()
            .and_then(|row| Some((int(row, 0)?, json_of(row, 1)?))))
    }

    pub(in crate::search) async fn document(
        &mut self,
        event_id: &EventId,
    ) -> Result<Option<Document>> {
        Ok(self.row(event_id).await?.map(|(_, document)| document))
    }

    pub(in crate::search) fn record_redacted(&mut self, event_id: &EventId) {
        self.queue(statement!(
            "INSERT OR IGNORE INTO redacted (room_id, event_id) VALUES (?1, ?2)",
            self.room.as_str(),
            event_id.as_str()
        ));
    }

    pub(in crate::search) async fn edit_target(
        &mut self,
        edit: &EventId,
    ) -> Result<Option<OwnedEventId>> {
        let rows = self
            .read(statement!(
                "SELECT target_id FROM edit WHERE room_id = ?1 AND edit_id = ?2",
                self.room.as_str(),
                edit.as_str()
            ))
            .await?;
        Ok(rows
            .first()
            .and_then(|row| OwnedEventId::try_from(text(row, 0)?).ok()))
    }

    pub(in crate::search) fn set_edit(&mut self, edit: &EventId, target: &EventId) {
        self.queue(statement!(
            "INSERT OR REPLACE INTO edit (room_id, edit_id, target_id) VALUES (?1, ?2, ?3)",
            self.room.as_str(),
            edit.as_str(),
            target.as_str()
        ));
    }

    pub(in crate::search) fn forget_edit(&mut self, edit: &EventId) {
        self.queue(statement!(
            "DELETE FROM edit WHERE room_id = ?1 AND edit_id = ?2",
            self.room.as_str(),
            edit.as_str()
        ));
    }

    pub(in crate::search) fn forget_edits_to(&mut self, target: &EventId) {
        self.queue(statement!(
            "DELETE FROM edit WHERE room_id = ?1 AND target_id = ?2",
            self.room.as_str(),
            target.as_str()
        ));
    }

    pub(in crate::search) async fn upsert(&mut self, document: &Document) -> Result<()> {
        if document.is_redacted(&self.redacted) {
            return Ok(());
        }
        if let Some(edit) = &document.edit_id {
            self.set_edit(edit, &document.event_id);
        }
        if let Some((id, indexed)) = self.row(&document.event_id).await? {
            if indexed.body == document.body {
                if !indexed.same_metadata(document) {
                    self.queue(statement!(
                        "UPDATE doc SET ts = ?1, sender = ?2, state = ?3, attachment = ?4, json = ?5
                         WHERE id = ?6",
                        document.origin_server_ts,
                        document.sender.as_str(),
                        document.state,
                        document.listed(),
                        document_json(document),
                        id
                    ));
                }
                return Ok(());
            }
            self.queue(statement!("DELETE FROM doc WHERE id = ?1", id));
        }
        self.queue(statement!(
            "INSERT INTO doc (room_id, event_id, ts, sender, state, attachment, json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            self.room.as_str(),
            document.event_id.as_str(),
            document.origin_server_ts,
            document.sender.as_str(),
            document.state,
            document.listed(),
            document_json(document)
        ));
        self.queue(statement!(
            "INSERT INTO fts (rowid, text) VALUES (last_insert_rowid(), ?1)",
            indexed_text(&document.body)
        ));
        Ok(())
    }

    pub(in crate::search) fn remove(&mut self, event_id: &EventId) {
        self.queue(statement!(
            "DELETE FROM doc WHERE room_id = ?1 AND event_id = ?2",
            self.room.as_str(),
            event_id.as_str()
        ));
    }

    pub(in crate::search) fn forget_message(&mut self, event_id: &EventId) {
        self.queue(statement!(
            "DELETE FROM pending_edit WHERE room_id = ?1 AND target_id = ?2",
            self.room.as_str(),
            event_id.as_str()
        ));
        self.remove(event_id);
    }

    pub(in crate::search) fn remove_pending_edit(&mut self, edit: &EventId) {
        self.queue(statement!(
            "DELETE FROM pending_edit WHERE room_id = ?1 AND edit_id = ?2",
            self.room.as_str(),
            edit.as_str()
        ));
    }

    pub(in crate::search) fn queue_edit(
        &mut self,
        target: &EventId,
        edit: &EventId,
        event: &TimelineEvent,
    ) -> Result<()> {
        let event = serde_json::to_vec(event).map_err(|error| SqlError(error.to_string()))?;
        self.queue(statement!(
            "INSERT OR REPLACE INTO pending_edit (room_id, target_id, edit_id, event)
             VALUES (?1, ?2, ?3, ?4)",
            self.room.as_str(),
            target.as_str(),
            edit.as_str(),
            event
        ));
        Ok(())
    }

    pub(in crate::search) async fn apply_pending(
        &mut self,
        mut document: Document,
    ) -> Result<Document> {
        if document.encrypted.is_none() {
            return Ok(document);
        }
        let rows = self
            .read(statement!(
                "SELECT edit_id, event FROM pending_edit WHERE room_id = ?1 AND target_id = ?2",
                self.room.as_str(),
                document.event_id.as_str()
            ))
            .await?;
        if rows.is_empty() {
            return Ok(document);
        }
        self.queue(statement!(
            "DELETE FROM pending_edit WHERE room_id = ?1 AND target_id = ?2",
            self.room.as_str(),
            document.event_id.as_str()
        ));
        let mut edits: Vec<(OwnedEventId, TimelineEvent)> = rows
            .iter()
            .filter_map(|row| {
                Some((
                    OwnedEventId::try_from(text(row, 0)?).ok()?,
                    serde_json::from_slice(row.get(1)?.as_blob()?).ok()?,
                ))
            })
            .collect();
        edits.sort_by(|(left_id, left), (right_id, right)| {
            left.timestamp_raw()
                .cmp(&right.timestamp_raw())
                .then_with(|| left_id.cmp(right_id))
        });
        for (edit, event) in edits {
            if apply_replacement(&mut document, &event, &self.redacted).is_none() {
                self.forget_edit(&edit);
            }
        }
        Ok(document)
    }

    /// Takes in what another device indexed.
    pub(in crate::search) async fn import(
        &mut self,
        documents: Vec<Document>,
        classified: Vec<(OwnedEventId, u64)>,
        edits: Vec<(OwnedEventId, OwnedEventId)>,
    ) -> Result<()> {
        let floor = self.floor().await?;
        for (edit, target) in edits {
            self.queue(statement!(
                "INSERT OR IGNORE INTO edit (room_id, edit_id, target_id) VALUES (?1, ?2, ?3)",
                self.room.as_str(),
                edit.as_str(),
                target.as_str()
            ));
        }
        for document in documents {
            if document.origin_server_ts < floor || document.is_redacted(&self.redacted) {
                continue;
            }
            let existing = self.document(&document.event_id).await?;
            let document = adopt_edit(document, existing.as_ref(), &self.redacted);
            let document = self.apply_pending(document).await?;
            self.upsert(&document).await?;
        }
        for (event_id, ts) in classified {
            if ts >= floor {
                self.mark_classified(&event_id, ts);
            }
        }
        self.commit().await
    }
}
