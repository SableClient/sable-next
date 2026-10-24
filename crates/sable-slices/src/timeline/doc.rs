//! A timeline as one document: the rows as a list, the hidden-event
//! aggregations, and the status.

use sable_runtime::{AppError, Doc, ListChanges, ListDoc, Op, Render, Window};
use serde_json::Value;

use super::view::{Shared, TimelineRow, TimelineStatus};

pub struct TimelineDoc {
    pub(super) events: ListDoc<Shared>,
    pub(super) rows: ListDoc<TimelineRow>,
    pub(super) aggregations: ListDoc<Shared>,
    pub(super) status: Doc<TimelineStatus>,
}

impl Default for TimelineDoc {
    fn default() -> Self {
        Self {
            events: ListDoc::new(Vec::new()),
            rows: ListDoc::new(Vec::new()),
            aggregations: ListDoc::new(Vec::new()),
            status: Doc::new(TimelineStatus::default()),
        }
    }
}

pub struct TimelineChanges {
    events: Option<ListChanges<Shared>>,
    rows: Option<ListChanges<TimelineRow>>,
    aggregations: Option<ListChanges<Shared>>,
    status: Option<TimelineStatus>,
}

impl Render for TimelineDoc {
    type Changes = TimelineChanges;

    fn snapshot(&self, window: Option<Window>) -> Result<Value, AppError> {
        let mut snapshot = self.rows.snapshot(window)?;
        if let Value::Object(fields) = &mut snapshot {
            if window.is_some() {
                fields.insert("events".to_owned(), self.events.snapshot(None)?);
            }
            fields.insert("status".to_owned(), self.status.snapshot(None)?);
            fields.insert("aggregations".to_owned(), self.aggregations.snapshot(None)?);
        }
        Ok(snapshot)
    }

    fn drain(&mut self) -> Result<Option<TimelineChanges>, AppError> {
        let events = self.events.drain()?;
        let rows = self.rows.drain()?;
        let aggregations = self.aggregations.drain()?;
        let status = self.status.drain()?.map(|_| self.status.view().clone());
        let any = events.is_some() || rows.is_some() || aggregations.is_some() || status.is_some();
        Ok(any.then_some(TimelineChanges {
            events,
            rows,
            aggregations,
            status,
        }))
    }

    fn clear(&mut self) {
        self.events.clear();
        self.rows.clear();
        self.aggregations.clear();
        self.status.clear();
    }

    fn project(
        &self,
        changes: &TimelineChanges,
        window: Option<Window>,
    ) -> Result<Vec<Op>, AppError> {
        let mut ops = match &changes.rows {
            Some(rows) => self.rows.project(rows, window)?,
            None => Vec::new(),
        };
        if window.is_some()
            && let Some(events) = &changes.events
        {
            for op in self.events.project(events, None)? {
                ops.push(match op {
                    Op::Fields { fields } => Op::Fields {
                        fields: fields
                            .into_iter()
                            .map(|(field, value)| (format!("events.{field}"), value))
                            .collect(),
                    },
                    Op::List { field, diffs } => Op::List {
                        field: format!("events.{field}"),
                        diffs,
                    },
                });
            }
        }
        if let Some(status) = &changes.status {
            ops.push(Op::Fields {
                fields: std::collections::BTreeMap::from([(
                    String::from("status"),
                    serde_json::to_value(status).map_err(|_| AppError::Encode)?,
                )]),
            });
        }
        if changes.aggregations.is_some() {
            ops.push(Op::Fields {
                fields: std::collections::BTreeMap::from([(
                    String::from("aggregations"),
                    self.aggregations.snapshot(None)?,
                )]),
            });
        }
        Ok(ops)
    }
}

#[cfg(test)]
mod tests {
    use sable_protocol::{TimelineItemView, VectorDiff};
    use serde_json::json;

    use super::*;

    fn event(id: &str) -> Shared {
        Shared::new(
            serde_json::from_value::<TimelineItemView>(json!({
                "id": id,
                "row": "message",
                "visibility": "always",
                "event_id": format!("${id}"),
                "timestamp": 1,
                "content": {
                    "kind": "message", "body": id, "html": id,
                    "emote": false, "notice": false, "edited": false
                },
                "mention": "none"
            }))
            .expect("a timeline event"),
        )
    }

    #[test]
    fn windowed_event_changes_are_list_diffs() {
        let mut doc = TimelineDoc::default();
        doc.events
            .apply(VectorDiff::PushBack { value: event("a") })
            .unwrap();
        let changes = doc.drain().unwrap().expect("changes");
        let ops = doc
            .project(&changes, Some(Window { start: 0, end: 1 }))
            .unwrap();

        assert!(
            ops.iter()
                .any(|op| matches!(op, Op::List { field, .. } if field == "events.items"))
        );
        assert!(
            ops.iter().any(
                |op| matches!(op, Op::Fields { fields } if fields.contains_key("events.total"))
            )
        );
    }
}
