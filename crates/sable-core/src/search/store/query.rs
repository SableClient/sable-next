use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, OwnedUserId, RoomId};
use sable_search::matching::{exact_expression, match_expression};
use sable_sql::{Rows, Statement, Value, statement};

use super::tx::decode;
use super::{Result, Store, int, text};
use crate::api::search::SearchOrder;
use crate::protocol::{RoomAttachmentKind, RoomAttachmentView};
use crate::search::document::{Document, FoldedTerms};
use crate::search::{ContextLine, HYDRATE_BATCH, Hit, IndexFilter};

/// Larger than any relevance score, so a word as typed outranks its typos and prefixes.
const EXACT_BONUS: f64 = 1_000.0;
/// Rows read per query when a filter has to be checked in Rust, doubled up to
/// `MAX_SCAN` while a page stays short.
const SCAN: usize = 256;
const MAX_SCAN: usize = 4096;
const ATTACHMENT_SCAN: usize = 128;

pub(in crate::search) enum PageStep {
    Done(Vec<RoomAttachmentView>, Option<(u64, OwnedEventId)>),
    Hydrate(Vec<OwnedEventId>),
}

pub(in crate::search) struct Snapshot {
    pub(in crate::search) documents: Vec<Document>,
    pub(in crate::search) classified: Vec<(OwnedEventId, u64)>,
    pub(in crate::search) edits: HashMap<OwnedEventId, OwnedEventId>,
    pub(in crate::search) redacted: Vec<OwnedEventId>,
}

/// Date orders have no score to sink a loose match, so only relevance takes
/// prefixes and typos.
pub(crate) const fn expands(order: SearchOrder) -> bool {
    matches!(order, SearchOrder::Rank)
}

const fn order_by(order: SearchOrder) -> &'static str {
    match order {
        SearchOrder::Rank => "score DESC, d.event_id",
        SearchOrder::Recent => "d.ts DESC, d.event_id",
        SearchOrder::Oldest => "d.ts, d.event_id",
    }
}

/// What the filter asks of a document that its columns do not answer.
const fn needs_document(filter: &IndexFilter, terms: &FoldedTerms) -> bool {
    !filter.mentions.is_empty()
        || !filter.not_mentions.is_empty()
        || !filter.has.is_empty()
        || !filter.not_has.is_empty()
        || filter.in_thread.is_some()
        || filter.pinned.is_some()
        || !filter.file_types.is_empty()
        || !filter.not_file_types.is_empty()
        || terms.pattern.is_some()
        || !terms.phrases.is_empty()
        || !terms.exclude.is_empty()
}

/// The conditions the columns of `doc` (as `d`) can answer.
fn scope(filter: &IndexFilter) -> (String, Vec<Value>) {
    let mut conditions = String::from("d.state = ?");
    let mut values = vec![Value::from(filter.state_events.unwrap_or(false))];
    let mut list = |column: &str, keyword: &str, items: Vec<&str>| {
        if items.is_empty() {
            return;
        }
        let marks = vec!["?"; items.len()].join(", ");
        let _ = write!(conditions, " AND {column} {keyword} ({marks})");
        values.extend(items.into_iter().map(Value::from));
    };
    list(
        "d.room_id",
        "IN",
        filter.rooms.iter().map(|room| room.as_str()).collect(),
    );
    list(
        "d.room_id",
        "NOT IN",
        filter.not_rooms.iter().map(|room| room.as_str()).collect(),
    );
    list(
        "d.sender",
        "IN",
        filter.senders.iter().map(|user| user.as_str()).collect(),
    );
    list(
        "d.sender",
        "NOT IN",
        filter
            .not_senders
            .iter()
            .map(|user| user.as_str())
            .collect(),
    );
    if let Some(after) = filter.after_ts {
        conditions.push_str(" AND d.ts >= ?");
        values.push(Value::from(after));
    }
    if let Some(before) = filter.before_ts {
        conditions.push_str(" AND d.ts <= ?");
        values.push(Value::from(before));
    }
    (conditions, values)
}

impl Store {
    pub(in crate::search) async fn search(
        &self,
        query: &str,
        filter: &IndexFilter,
        pinned: HashSet<OwnedEventId>,
        order: SearchOrder,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<Hit>> {
        let terms = FoldedTerms::of(filter, pinned);
        let by_document = needs_document(filter, &terms);
        let (conditions, scope_values) = scope(filter);
        let order_by = order_by(order);

        let (sql, mut params) = if query.is_empty() {
            (
                format!(
                    "SELECT d.room_id, 0.0 AS score, d.json
                     FROM doc d WHERE {conditions}
                     ORDER BY {order_by} LIMIT ? OFFSET ?"
                ),
                Vec::new(),
            )
        } else {
            let expand = expands(order);
            let Some(expression) = self.expression(query, filter, expand).await? else {
                return Ok(Vec::new());
            };
            let exact = exact_expression(query, &filter.words).filter(|_| expand);
            let bonus = if exact.is_some() {
                format!(
                    " + CASE WHEN fts.rowid IN (SELECT rowid FROM fts WHERE fts MATCH ?)
                      THEN {EXACT_BONUS:?} ELSE 0.0 END"
                )
            } else {
                String::new()
            };
            let mut params: Vec<Value> = exact.into_iter().map(Value::from).collect();
            params.push(Value::from(expression));
            (
                format!(
                    "SELECT d.room_id, -bm25(fts){bonus} AS score, d.json
                     FROM fts JOIN doc d ON d.id = fts.rowid
                     WHERE fts MATCH ? AND {conditions}
                     ORDER BY {order_by} LIMIT ? OFFSET ?"
                ),
                params,
            )
        };
        params.extend(scope_values);

        let (mut at, mut skip, mut step) = if by_document {
            (0, offset, limit.max(SCAN))
        } else {
            (offset, 0, limit)
        };
        let mut hits = Vec::new();
        while hits.len() < limit {
            let mut page = params.clone();
            page.extend([Value::from(step), Value::from(at)]);
            let rows = self
                .rows(Statement {
                    sql: sql.clone(),
                    params: page,
                })
                .await?;
            for row in &rows {
                let Some(document) = row.get(2).and_then(Value::as_blob).and_then(decode) else {
                    continue;
                };
                if by_document && !document.matches(filter, &terms) {
                    continue;
                }
                if skip > 0 {
                    skip -= 1;
                    continue;
                }
                let Some(room_id) = text(row, 0).and_then(|room| OwnedRoomId::try_from(room).ok())
                else {
                    continue;
                };
                hits.push(Hit {
                    room_id,
                    event_id: document.event_id,
                    body: document.body,
                    sender: document.sender,
                    origin_server_ts: document.origin_server_ts,
                    score: row.get(1).and_then(Value::as_f64).unwrap_or(0.0),
                    before: Vec::new(),
                    after: Vec::new(),
                });
                if hits.len() == limit {
                    break;
                }
            }
            if rows.len() < step {
                break;
            }
            at += rows.len();
            step = (step * 2).min(MAX_SCAN);
        }
        Ok(hits)
    }

    /// The full-text expression for `query`, with the typos the index holds for its words.
    async fn expression(
        &self,
        query: &str,
        filter: &IndexFilter,
        expand: bool,
    ) -> Result<Option<String>> {
        let mut wanted = Vec::new();
        let _ = match_expression(query, &filter.words, expand, &mut |low, high| {
            wanted.push((low.to_owned(), high.to_owned()));
            Vec::new()
        });
        wanted.sort();
        wanted.dedup();
        let answers = self
            .run(
                wanted
                    .iter()
                    .map(|(low, high)| {
                        statement!(
                            "SELECT term FROM fts_vocab WHERE term >= ?1 AND term < ?2",
                            low.as_str(),
                            high.as_str()
                        )
                    })
                    .collect(),
            )
            .await?;
        let vocabulary: HashMap<(String, String), Vec<String>> = wanted
            .into_iter()
            .zip(answers)
            .map(|(range, rows)| {
                let terms = rows
                    .iter()
                    .filter_map(|row| text(row, 0).map(str::to_owned))
                    .collect();
                (range, terms)
            })
            .collect();
        Ok(match_expression(
            query,
            &filter.words,
            expand,
            &mut |low, high| {
                vocabulary
                    .get(&(low.to_owned(), high.to_owned()))
                    .cloned()
                    .unwrap_or_default()
            },
        ))
    }

    pub(in crate::search) async fn fill_context(
        &self,
        mut hits: Vec<Hit>,
        not_senders: &[OwnedUserId],
        lines: usize,
    ) -> Result<Vec<Hit>> {
        if lines == 0 {
            return Ok(hits);
        }
        let mut statements = Vec::new();
        for hit in &hits {
            for (compare, order) in [("<", "DESC"), (">", "ASC")] {
                statements.push(statement!(
                    format!(
                        "SELECT json FROM doc
                         WHERE room_id = ?1 AND (ts {compare} ?2 OR (ts = ?2 AND event_id {compare} ?3))
                         ORDER BY ts {order}, event_id {order} LIMIT ?4"
                    ),
                    hit.room_id.as_str(),
                    hit.origin_server_ts,
                    hit.event_id.as_str(),
                    // Filtered lines are skipped, so ask for more than are wanted.
                    lines * 8 + not_senders.len()
                ));
            }
        }
        let mut answers = self.run(statements).await?.into_iter();
        let line = |rows: Rows| -> Vec<ContextLine> {
            rows.iter()
                .filter_map(|row| decode(row.first()?.as_blob()?))
                .filter(|document| {
                    !document.body.is_empty() && !not_senders.contains(&document.sender)
                })
                .take(lines)
                .map(|document| ContextLine {
                    event_id: document.event_id,
                    body: document.body,
                    sender: document.sender,
                    origin_server_ts: document.origin_server_ts,
                })
                .collect()
        };
        for hit in &mut hits {
            hit.before = line(answers.next().unwrap_or_default());
            hit.before.reverse();
            hit.after = line(answers.next().unwrap_or_default());
        }
        Ok(hits)
    }

    pub(in crate::search) async fn attachment_page(
        &self,
        room_id: &RoomId,
        kind: RoomAttachmentKind,
        not_senders: &[OwnedUserId],
        before: Option<(u64, &str)>,
        limit: usize,
        tried: &HashSet<OwnedEventId>,
    ) -> Result<PageStep> {
        let (mut ceiling, mut cursor_id) =
            before.map_or((u64::MAX, String::new()), |(ts, id)| (ts, id.to_owned()));
        let mut found: Vec<(u64, OwnedEventId, Vec<RoomAttachmentView>)> = Vec::new();
        let mut unhydrated = Vec::new();
        'scan: loop {
            let rows = self
                .rows(statement!(
                    "SELECT ts, event_id, json FROM doc
                     WHERE room_id = ?1 AND attachment = 1
                       AND (ts < ?2 OR (ts = ?2 AND event_id < ?3))
                     ORDER BY ts DESC, event_id DESC LIMIT ?4",
                    room_id.as_str(),
                    ceiling,
                    cursor_id.as_str(),
                    ATTACHMENT_SCAN
                ))
                .await?;
            for row in &rows {
                if found.len() > limit || unhydrated.len() == HYDRATE_BATCH {
                    break 'scan;
                }
                let Some(document) = row.get(2).and_then(Value::as_blob).and_then(decode) else {
                    continue;
                };
                if not_senders.contains(&document.sender) {
                    continue;
                }
                if document.needs_media(kind) && !tried.contains(&document.event_id) {
                    unhydrated.push(document.event_id);
                    continue;
                }
                let items = document.attachment_items(kind);
                if !items.is_empty() {
                    found.push((document.origin_server_ts, document.event_id, items));
                }
            }
            let last = rows
                .last()
                .filter(|_| rows.len() == ATTACHMENT_SCAN)
                .and_then(|row| Some((int(row, 0)?, text(row, 1)?.to_owned())));
            let Some(last) = last else {
                break;
            };
            (ceiling, cursor_id) = last;
        }
        if !unhydrated.is_empty() {
            return Ok(PageStep::Hydrate(unhydrated));
        }

        let more = found.len() > limit;
        found.truncate(limit);
        let next = found
            .last()
            .filter(|_| more)
            .map(|(ts, event_id, _)| (*ts, event_id.clone()));
        Ok(PageStep::Done(
            found.into_iter().flat_map(|(_, _, items)| items).collect(),
            next,
        ))
    }

    pub(in crate::search) async fn snapshot(&self, room_id: &RoomId) -> Result<Snapshot> {
        let room = room_id.as_str();
        let mut answers = self
            .run(vec![
                statement!("SELECT json FROM doc WHERE room_id = ?1", room),
                statement!(
                    "SELECT event_id, ts FROM classified WHERE room_id = ?1",
                    room
                ),
                statement!(
                    "SELECT edit_id, target_id FROM edit WHERE room_id = ?1",
                    room
                ),
                statement!("SELECT event_id FROM redacted WHERE room_id = ?1", room),
            ])
            .await?
            .into_iter();
        let mut next = || answers.next().unwrap_or_default();
        let documents = next()
            .iter()
            .filter_map(|row| decode(row.first()?.as_blob()?))
            .collect();
        let classified = next()
            .iter()
            .filter_map(|row| Some((OwnedEventId::try_from(text(row, 0)?).ok()?, int(row, 1)?)))
            .collect();
        let edits = next()
            .iter()
            .filter_map(|row| {
                Some((
                    OwnedEventId::try_from(text(row, 0)?).ok()?,
                    OwnedEventId::try_from(text(row, 1)?).ok()?,
                ))
            })
            .collect();
        let redacted = next()
            .iter()
            .filter_map(|row| OwnedEventId::try_from(text(row, 0)?).ok())
            .collect();
        Ok(Snapshot {
            documents,
            classified,
            edits,
            redacted,
        })
    }
}
