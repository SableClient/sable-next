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

struct Ranked {
    id: u64,
    room_id: String,
    event_id: String,
    origin_server_ts: u64,
    score: f64,
}

/// Date orders have no score to sink a loose match, so only relevance takes
/// prefixes and typos.
pub(crate) const fn expands(order: SearchOrder) -> bool {
    matches!(order, SearchOrder::Rank)
}

fn by_rank(left: &Ranked, right: &Ranked) -> std::cmp::Ordering {
    right
        .score
        .partial_cmp(&left.score)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| left.event_id.cmp(&right.event_id))
}

fn by_recency(left: &Ranked, right: &Ranked) -> std::cmp::Ordering {
    right
        .origin_server_ts
        .cmp(&left.origin_server_ts)
        .then_with(|| left.event_id.cmp(&right.event_id))
}

fn by_age(left: &Ranked, right: &Ranked) -> std::cmp::Ordering {
    left.origin_server_ts
        .cmp(&right.origin_server_ts)
        .then_with(|| left.event_id.cmp(&right.event_id))
}

fn page_ranked(
    mut ranked: Vec<Ranked>,
    order: SearchOrder,
    limit: usize,
    offset: usize,
) -> Vec<Ranked> {
    let compare = match order {
        SearchOrder::Rank => by_rank,
        SearchOrder::Recent => by_recency,
        SearchOrder::Oldest => by_age,
    };
    let wanted = offset.saturating_add(limit);

    if wanted < ranked.len() {
        ranked.select_nth_unstable_by(wanted, compare);
        ranked.truncate(wanted);
    }
    ranked.sort_unstable_by(compare);

    ranked.drain(..offset.min(ranked.len()));
    ranked.truncate(limit);
    ranked
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
        let with_document = needs_document(filter, &terms);
        let (conditions, scope_values) = scope(filter);
        let expand = expands(order);
        let document = if with_document { "d.json" } else { "NULL" };

        let mut statements = Vec::new();
        let mut exact_at = None;
        let sql = if query.is_empty() {
            format!(
                "SELECT d.id, d.event_id, d.ts, 0.0, {document}, d.room_id
                 FROM doc d WHERE {conditions}"
            )
        } else {
            let expression = self.expression(query, filter, expand).await?;
            let Some(expression) = expression else {
                return Ok(Vec::new());
            };
            if expand && let Some(exact) = exact_expression(query, &filter.words) {
                exact_at = Some(statements.len());
                statements.push(statement!(
                    "SELECT rowid FROM fts WHERE fts MATCH ?1",
                    exact
                ));
            }
            let mut main = vec![Value::from(expression)];
            main.extend(scope_values.clone());
            statements.push(Statement {
                sql: format!(
                    "SELECT d.id, d.event_id, d.ts, -bm25(fts), {document}, d.room_id
                     FROM fts JOIN doc d ON d.id = fts.rowid
                     WHERE fts MATCH ? AND {conditions}"
                ),
                params: main,
            });
            let mut answers = self.run(statements).await?;
            let rows = answers.pop().unwrap_or_default();
            let bonus: HashSet<u64> = exact_at
                .and_then(|at| answers.get(at))
                .into_iter()
                .flatten()
                .filter_map(|row| int(row, 0))
                .collect();
            return self
                .page(
                    rows,
                    &bonus,
                    filter,
                    &terms,
                    with_document,
                    order,
                    limit,
                    offset,
                )
                .await;
        };
        let rows = self
            .rows(Statement {
                sql,
                params: scope_values,
            })
            .await?;
        self.page(
            rows,
            &HashSet::new(),
            filter,
            &terms,
            with_document,
            order,
            limit,
            offset,
        )
        .await
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

    #[expect(
        clippy::too_many_arguments,
        reason = "one step of search, with its inputs"
    )]
    async fn page(
        &self,
        rows: Rows,
        bonus: &HashSet<u64>,
        filter: &IndexFilter,
        terms: &FoldedTerms,
        with_document: bool,
        order: SearchOrder,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<Hit>> {
        let mut ranked = Vec::new();
        for row in &rows {
            let (Some(id), Some(event_id), Some(ts), Some(room_id)) =
                (int(row, 0), text(row, 1), int(row, 2), text(row, 5))
            else {
                continue;
            };
            if with_document
                && !row
                    .get(4)
                    .and_then(Value::as_blob)
                    .and_then(decode)
                    .is_some_and(|document| document.matches(filter, terms))
            {
                continue;
            }
            ranked.push(Ranked {
                id,
                room_id: room_id.to_owned(),
                event_id: event_id.to_owned(),
                origin_server_ts: ts,
                score: row.get(3).and_then(Value::as_f64).unwrap_or(0.0)
                    + if bonus.contains(&id) {
                        EXACT_BONUS
                    } else {
                        0.0
                    },
            });
        }

        let page = page_ranked(ranked, order, limit, offset);
        let documents = self
            .run(
                page.iter()
                    .map(|entry| statement!("SELECT json FROM doc WHERE id = ?1", entry.id))
                    .collect(),
            )
            .await?;
        let mut hits = Vec::new();
        for (entry, rows) in page.into_iter().zip(documents) {
            let Some(document) = rows
                .first()
                .and_then(|row| row.first())
                .and_then(Value::as_blob)
                .and_then(decode)
            else {
                continue;
            };
            let Ok(room_id) = OwnedRoomId::try_from(entry.room_id) else {
                continue;
            };
            hits.push(Hit {
                room_id,
                event_id: document.event_id,
                body: document.body,
                sender: document.sender,
                origin_server_ts: document.origin_server_ts,
                score: entry.score,
                before: Vec::new(),
                after: Vec::new(),
            });
        }
        Ok(hits)
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
        let (ceiling, cursor_id) = before.map_or((u64::MAX, ""), |(ts, id)| (ts, id));
        let rows = self
            .rows(statement!(
                "SELECT json FROM doc
                 WHERE room_id = ?1
                   AND (ts < ?2 OR (ts = ?2 AND event_id < ?3))
                   AND (json_extract(json, '$.has_link') = 1
                        OR json_array_length(json, '$.attachments') > 0
                        OR json_array_length(json, '$.media') > 0)
                 ORDER BY ts DESC, event_id DESC",
                room_id.as_str(),
                ceiling,
                cursor_id
            ))
            .await?;
        let mut found: Vec<(u64, OwnedEventId, Vec<RoomAttachmentView>)> = Vec::new();
        let mut unhydrated = Vec::new();
        for row in &rows {
            if found.len() > limit {
                break;
            }
            let Some(document) = row.first().and_then(Value::as_blob).and_then(decode) else {
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
        if !unhydrated.is_empty() {
            unhydrated.truncate(HYDRATE_BATCH);
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
