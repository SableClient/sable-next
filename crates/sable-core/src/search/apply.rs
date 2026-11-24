//! What one event does to a room of the index. The event cache, which only
//! async code can ask, is consulted first (`Step`) and the database written after.

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::event_cache::RoomEventCache;
use matrix_sdk::ruma::OwnedEventId;
use matrix_sdk::ruma::events::relation::RelationType;
use matrix_sdk::ruma::events::room::message::OriginalSyncRoomMessageEvent;
use matrix_sdk::ruma::events::{
    AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
};
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk::ruma::serde::Raw;

use super::document::{
    Document, adopt_edit, calendar_document, document_of, edited_document,
    extensible_text_document, forged_state_event, poll_start_document, replacement_of,
    state_document, sticker_document,
};
use super::store::{Result, RoomTx};
use super::{edited_or_own_event_id, is_redacted, redacted_event_id};
use crate::messages::{raw_content, valid_replacements};
use crate::protocol::SearchAttachment;

type Replaced = (TimelineEvent, Vec<TimelineEvent>);

pub(super) enum Step {
    Document(Document),
    Calendar(Box<Document>, String),
    Message {
        event: TimelineEvent,
        message: Box<OriginalSyncRoomMessageEvent>,
        cached: Option<Replaced>,
        fallback: Option<TimelineEvent>,
    },
    PollEdit(Box<PollEdit>),
    Nothing,
}

/// A poll start that replaces the question and answers of an earlier one.
pub(super) struct PollEdit {
    target: OwnedEventId,
    edit_id: OwnedEventId,
    ts: u64,
    document: Document,
}

/// An event the index has decided to take in.
pub(super) struct Item {
    pub(super) event_id: OwnedEventId,
    pub(super) ts: u64,
    pub(super) step: Step,
}

/// An event that redacts another, which the cache has to be asked about.
pub(super) struct Redaction {
    pub(super) classify: Option<(OwnedEventId, u64)>,
    pub(super) target: OwnedEventId,
}

pub(super) enum Planned {
    Item(Box<Item>),
    Redaction(Redaction),
}

/// Only crawled pages can hold an edit that never passes through this index.
pub(super) async fn plan(
    event: &TimelineEvent,
    event_id: OwnedEventId,
    ts: u64,
    cache: &RoomEventCache,
    rules: &RedactionRules,
    crawled: bool,
) -> Planned {
    let item = |step| {
        Planned::Item(Box::new(Item {
            event_id: event_id.clone(),
            ts,
            step,
        }))
    };
    let message = match event.raw().deserialize() {
        Ok(AnySyncTimelineEvent::MessageLike(message)) => message,
        Ok(AnySyncTimelineEvent::State(_)) if forged_state_event(event) => {
            return item(Step::Nothing);
        }
        Ok(AnySyncTimelineEvent::State(state)) => {
            return item(Step::Document(state_document(
                &state,
                raw_content(event).as_ref(),
            )));
        }
        Err(_) => return item(Step::Nothing),
    };

    if let Some(edit) = poll_edit(event, &message, &event_id, ts) {
        return item(Step::PollEdit(Box::new(edit)));
    }
    if let Some(document) = poll_start_document(&message) {
        return item(Step::Document(document));
    }
    if let AnySyncMessageLikeEvent::Sticker(SyncMessageLikeEvent::Original(sticker)) = &message {
        return item(Step::Document(sticker_document(sticker)));
    }

    match message {
        AnySyncMessageLikeEvent::RoomMessage(message) => {
            let Some(message) = message.as_original() else {
                return item(Step::Nothing);
            };
            let is_edit = replacement_of(message).is_some();
            let target = edited_or_own_event_id(message);
            let cached = if is_edit || crawled {
                cache
                    .find_event_with_relations(&target, Some(vec![RelationType::Replacement]))
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            };
            let cached = with_bundled_edit(event, is_edit, cached);
            let fallback = if is_edit && cached.is_none() {
                cache.find_event(&target).await.ok().flatten()
            } else {
                None
            };
            item(Step::Message {
                event: event.clone(),
                message: Box::new(message.clone()),
                cached,
                fallback,
            })
        }
        AnySyncMessageLikeEvent::RoomRedaction(redaction) => redacted_event_id(&redaction, rules)
            .map_or_else(
                || item(Step::Nothing),
                |target| {
                    Planned::Redaction(Redaction {
                        classify: Some((event_id.clone(), ts)),
                        target,
                    })
                },
            ),
        _ => item(whole_event_step(event)),
    }
}

fn whole_event_step(event: &TimelineEvent) -> Step {
    let Ok(raw) = event.raw().deserialize_as_unchecked::<serde_json::Value>() else {
        return Step::Nothing;
    };
    if let Some((document, uid)) = calendar_document(&raw) {
        return Step::Calendar(Box::new(document), uid);
    }
    extensible_text_document(&raw).map_or(Step::Nothing, Step::Document)
}

impl Item {
    pub(super) fn calendar_uid(&self) -> Option<&str> {
        match &self.step {
            Step::Calendar(_, uid) => Some(uid),
            _ => None,
        }
    }
}

pub(super) async fn apply(tx: &mut RoomTx<'_>, item: Item) -> Result<()> {
    match item.step {
        Step::Document(document) => tx.upsert(&document).await,
        Step::Calendar(document, _) => tx.upsert(&document).await,
        Step::Message {
            event,
            message,
            cached,
            fallback,
        } => apply_room_message(tx, &event, &message, cached, fallback.as_ref()).await,
        Step::PollEdit(edit) => apply_poll_edit(tx, *edit).await,
        Step::Nothing => Ok(()),
    }?;
    tx.mark_classified(&item.event_id, item.ts);
    Ok(())
}

fn poll_edit(
    event: &TimelineEvent,
    message: &AnySyncMessageLikeEvent,
    edit_id: &OwnedEventId,
    ts: u64,
) -> Option<PollEdit> {
    if !matches!(
        message,
        AnySyncMessageLikeEvent::UnstablePollStart(_) | AnySyncMessageLikeEvent::PollStart(_)
    ) {
        return None;
    }
    let content = raw_content(event)?;
    let relation = content.get("m.relates_to")?;
    if relation.get("rel_type")?.as_str()? != "m.replace" {
        return None;
    }
    let target = relation.get("event_id")?.as_str()?;
    let new_poll: AnySyncMessageLikeEvent = serde_json::from_value(serde_json::json!({
        "type": event.raw().get_field::<String>("type").ok()??,
        "event_id": target,
        "sender": message.sender(),
        "origin_server_ts": ts,
        "content": content.get("m.new_content")?,
    }))
    .ok()?;
    let document = poll_start_document(&new_poll)?;
    Some(PollEdit {
        target: document.event_id.clone(),
        edit_id: edit_id.clone(),
        ts,
        document,
    })
}

async fn apply_poll_edit(tx: &mut RoomTx<'_>, edit: PollEdit) -> Result<()> {
    if tx.redacted.contains(&edit.edit_id) || tx.redacted.contains(&edit.target) {
        return Ok(());
    }
    let Some(existing) = tx.document(&edit.target).await? else {
        return Ok(());
    };
    if existing.sender != edit.document.sender
        || existing.edited_at.is_some_and(|at| at > edit.ts)
        || !existing.carries(SearchAttachment::Poll)
    {
        return Ok(());
    }
    tx.upsert(&Document {
        body: edit.document.body,
        has_link: edit.document.has_link,
        edited_at: Some(edit.ts),
        edit_id: Some(edit.edit_id),
        ..existing
    })
    .await
}

/// A homeserver bundles the latest edit into the original it serves, which
/// leaves no edit event to find.
fn with_bundled_edit(
    event: &TimelineEvent,
    is_edit: bool,
    cached: Option<Replaced>,
) -> Option<Replaced> {
    if is_edit {
        return cached;
    }
    let bundled = event
        .raw()
        .get_field::<serde_json::Value>("unsigned")
        .ok()
        .flatten()
        .and_then(|unsigned| unsigned.pointer("/m.relations/m.replace").cloned())
        .and_then(|replace| Raw::new(&replace).ok())
        .map(|raw| TimelineEvent::from_plaintext(raw.cast_unchecked()));
    let Some(bundled) = bundled else {
        return cached;
    };
    let (original, mut replacements) = cached.unwrap_or_else(|| (event.clone(), Vec::new()));
    if !replacements
        .iter()
        .any(|replacement| replacement.event_id() == bundled.event_id())
    {
        replacements.push(bundled);
    }
    Some((original, replacements))
}

async fn apply_room_message(
    tx: &mut RoomTx<'_>,
    event: &TimelineEvent,
    message: &OriginalSyncRoomMessageEvent,
    cached: Option<Replaced>,
    fallback: Option<&TimelineEvent>,
) -> Result<()> {
    let is_edit = replacement_of(message).is_some();
    let target = edited_or_own_event_id(message);
    if tx.redacted.contains(&message.event_id) || tx.redacted.contains(&target) {
        return Ok(());
    }
    let original = cached.as_ref().map(|(original, _)| original).or(fallback);
    if is_edit
        && let Some(original) = original
        && (is_redacted(original)
            || valid_replacements(original, std::slice::from_ref(event))
                .next()
                .is_none())
    {
        return Ok(());
    }
    let cached = cached.and_then(|(original, replacements)| {
        edited_document(&original, &replacements, &tx.redacted)
    });
    let existing = tx.document(&target).await?;
    let document = if is_edit {
        tx.set_edit(&message.event_id, &target);
        tx.queue_edit(&target, &message.event_id, event)?;
        let base = cached
            .map(|document| adopt_edit(document, existing.as_ref(), &tx.redacted))
            .or(existing);
        let Some(base) = base else {
            return Ok(());
        };
        base
    } else {
        adopt_edit(
            cached.unwrap_or_else(|| {
                document_of(
                    message,
                    raw_content(event).as_ref(),
                    event.encryption_info().is_some(),
                )
            }),
            existing.as_ref(),
            &tx.redacted,
        )
    };

    let document = tx.apply_pending(document).await?;
    tx.upsert(&document).await
}

/// What the cache holds of the message an edit changed.
pub(super) enum Latest {
    Unasked,
    Gone,
    Content(Box<Document>),
}

/// `latest` is what the cache holds of the message `redacted` edited, when it
/// was an edit and the cache was asked. Returns the message whose document
/// went away with its latest edit, when only the homeserver can say what it
/// said before.
pub(super) async fn apply_redacted(
    tx: &mut RoomTx<'_>,
    redacted: &OwnedEventId,
    latest: Latest,
) -> Result<Option<OwnedEventId>> {
    if !tx.redacted.insert(redacted.clone()) {
        return Ok(None);
    }
    tx.remove_pending_edit(redacted);

    let target = tx.edit_target(redacted).await?;
    let unedited = match (&target, latest) {
        (Some(target), Latest::Content(document)) => {
            let existing = tx.document(target).await?;
            let document = adopt_edit(*document, existing.as_ref(), &tx.redacted);
            let document = tx.apply_pending(document).await?;
            tx.upsert(&document).await?;
            None
        }
        (Some(target), Latest::Gone) => {
            if tx
                .document(target)
                .await?
                .is_some_and(|document| !document.is_redacted(&tx.redacted))
            {
                None
            } else {
                tx.remove(target);
                tx.unclassify(target);
                Some(target.clone())
            }
        }
        _ => {
            tx.forget_message(redacted);
            tx.forget_edits_to(redacted);
            None
        }
    };
    if target.is_some() {
        tx.forget_edit(redacted);
    }
    tx.record_redacted(redacted);
    Ok(unedited)
}
