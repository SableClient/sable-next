use std::collections::{BTreeMap, HashSet};

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::ruma::events::relation::RelationType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId, OwnedUserId, UserId};
use sable_model::truncate::truncate_graphemes;
use serde::Deserialize;
use serde_json::{Map, Value};
use serde_with::{DefaultOnError, serde_as};

use crate::ResultExt;
use crate::SignedIn;
use crate::api::packs::ListOk;
use crate::protocol::{ReactionGroup, ReactionShortcodeView, RpcCode, RpcError};
use crate::widgets::RelationsFilter;

const MAX_SHORTCODE_BYTES: usize = 100;
const RELATIONS_PAGE_SIZE: u32 = 100;

#[serde_as]
#[derive(Default, Deserialize)]
struct ContentIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "m.relates_to")]
    relates_to: Option<RelationIn>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    shortcode: Option<String>,
}

#[serde_as]
#[derive(Deserialize)]
struct RelationIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    rel_type: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    event_id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    key: Option<String>,
}

pub(crate) fn can_annotate<T>(event: &Raw<T>) -> bool {
    let content = event
        .get_field::<ContentIn>("content")
        .ok()
        .flatten()
        .unwrap_or_default();
    !matches!(
        content
            .relates_to
            .and_then(|relation| relation.rel_type)
            .as_deref(),
        Some("m.annotation" | "m.replace")
    )
}

fn is_redacted<T>(event: &Raw<T>) -> bool {
    event
        .get_field::<Map<String, Value>>("unsigned")
        .ok()
        .flatten()
        .is_some_and(|unsigned| unsigned.contains_key("redacted_because"))
}

impl SignedIn {
    pub(crate) async fn ensure_reaction_target(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
    ) -> Result<(), RpcError> {
        let event = self
            .room(room_id)?
            .load_or_fetch_event(event_id, None)
            .await
            .or_failed(self.core(), "reaction_target")?;
        if can_annotate(event.raw()) && !is_redacted(event.raw()) {
            Ok(())
        } else {
            Err(RpcCode::Unsupported.into())
        }
    }

    async fn reaction_relations(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        context: &'static str,
    ) -> Result<Vec<Value>, RpcError> {
        let mut events = Vec::new();
        let mut seen_pages = HashSet::new();
        let mut from: Option<String> = None;
        loop {
            let page = self
                .room_event_relations(
                    room_id,
                    event_id,
                    RelationsFilter {
                        rel_type: Some("m.annotation"),
                        event_type: Some("m.reaction"),
                        from: from.as_deref(),
                        to: None,
                        limit: Some(RELATIONS_PAGE_SIZE),
                        direction: None,
                    },
                )
                .await?;
            events.extend(page.chunk);
            let Some(next) = page.next_batch else {
                return Ok(events);
            };
            if !seen_pages.insert(next.clone()) {
                return Err(self
                    .core()
                    .failed(context, "reaction pagination did not advance"));
            }
            from = Some(next);
        }
    }

    /// Every `m.reaction` event `sender` sent to `event_id` with `key`.
    ///
    /// # Errors
    ///
    /// Returns an error when the relations cannot be fetched or pagination does not advance.
    pub(crate) async fn reaction_event_ids(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        key: &str,
        sender: &UserId,
    ) -> Result<Vec<OwnedEventId>, RpcError> {
        let mut found = Vec::new();
        for event in self
            .reaction_relations(room_id, event_id, "reaction_event_ids")
            .await?
        {
            if let Some(id) = reaction_id(&event, event_id, key, sender)
                && !found.contains(&id)
            {
                found.push(id);
            }
        }
        Ok(found)
    }

    /// Toggles the user's `key` reaction on an event no open timeline holds, such as a forum post
    /// older than the room's loaded messages. Returns whether the reaction was added.
    ///
    /// # Errors
    ///
    /// Returns an error when the relations cannot be fetched or the server refuses the change.
    pub(crate) async fn toggle_reaction_outside_timeline(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        key: &str,
        extra: Option<Map<String, Value>>,
    ) -> Result<bool, RpcError> {
        let room = self.room(room_id)?;
        let mine = self
            .reaction_event_ids(room_id, event_id, key, room.own_user_id())
            .await?;
        if mine.is_empty() {
            let mut content = extra.unwrap_or_default();
            content.insert(
                "m.relates_to".to_owned(),
                serde_json::json!({
                    "rel_type": "m.annotation",
                    "event_id": event_id,
                    "key": key,
                }),
            );
            room.send_raw("m.reaction", Value::Object(content))
                .await
                .or_failed(self.core(), "react")?;
            return Ok(true);
        }
        for id in mine {
            room.redact(&id, None, None)
                .await
                .or_failed(self.core(), "react")?;
        }
        Ok(false)
    }

    /// Grouped `m.reaction` events targeting `event_id`, fetched from relations.
    ///
    /// # Errors
    ///
    /// Returns an error when the relations cannot be fetched or pagination does not advance.
    pub(crate) async fn event_reactions(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
    ) -> Result<Vec<ReactionGroup>, RpcError> {
        let events = self
            .reaction_relations(room_id, event_id, "event_reactions")
            .await?;
        Ok(group_reactions(&events, event_id))
    }

    /// MSC4027 custom-image reactions, which the timeline's reaction groups omit.
    ///
    /// # Errors
    ///
    /// Returns an error when the room is unknown or its event cache cannot be read.
    pub(crate) async fn reaction_shortcodes(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
    ) -> Result<Vec<ReactionShortcodeView>, RpcError> {
        let room = self.room(room_id)?;
        let client = room.client();
        let (cache, _handles) = client
            .event_cache()
            .ok_or(RpcCode::Unavailable)?
            .room(room_id)
            .await
            .or_failed(self.core(), "reaction_shortcodes")?;
        let related = cache
            .find_event_with_relations(event_id, Some(vec![RelationType::Annotation]))
            .await
            .or_failed(self.core(), "reaction_shortcodes")?
            .filter(|(target, _)| can_annotate(target.raw()))
            .map(|(_, related)| related)
            .unwrap_or_default();
        Ok(shortcodes(&related, event_id))
    }

    /// The name to send with a custom-image reaction when the caller has none:
    /// the room's packs first, then what others already reacted with.
    pub(crate) async fn known_reaction_shortcode(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        key: &str,
    ) -> Option<String> {
        if !key.starts_with("mxc://") {
            return None;
        }
        if let Ok(ListOk { packs, .. }) = self.image_packs(room_id.clone(), true).await
            && let Some(image) = packs
                .iter()
                .flat_map(|pack| &pack.images)
                .find(|image| image.url == key)
        {
            return Some(image.shortcode.clone());
        }
        self.reaction_shortcodes(room_id, event_id)
            .await
            .ok()?
            .into_iter()
            .find(|view| view.key == key)
            .map(|view| view.shortcode)
    }
}

fn reaction_annotation<'a>(event: &'a Value, target: &EventId) -> Option<(&'a str, &'a str)> {
    if event.get("type")?.as_str()? != "m.reaction" {
        return None;
    }
    let relation = event.get("content")?.get("m.relates_to")?;
    (relation.get("rel_type")?.as_str()? == "m.annotation"
        && relation.get("event_id")?.as_str()? == target)
        .then(|| {
            Some((
                event.get("sender")?.as_str()?,
                relation.get("key")?.as_str()?,
            ))
        })?
}

fn reaction_id(
    event: &Value,
    target: &EventId,
    key: &str,
    sender: &UserId,
) -> Option<OwnedEventId> {
    let (ev_sender, ev_key) = reaction_annotation(event, target)?;
    (ev_sender == sender && ev_key == key).then(|| event.get("event_id")?.as_str()?.parse().ok())?
}

fn group_reactions(events: &[Value], target: &EventId) -> Vec<ReactionGroup> {
    let mut groups: Vec<ReactionGroup> = Vec::new();
    for event in events {
        let Some((sender, key)) = reaction_annotation(event, target) else {
            continue;
        };
        let Ok(sender) = OwnedUserId::try_from(sender) else {
            continue;
        };
        if let Some(group) = groups.iter_mut().find(|group| group.key == key) {
            if !group.senders.contains(&sender) {
                group.senders.push(sender);
            }
        } else {
            groups.push(ReactionGroup {
                key: key.to_owned(),
                senders: vec![sender],
            });
        }
    }
    groups
}

fn shortcodes(events: &[TimelineEvent], target: &EventId) -> Vec<ReactionShortcodeView> {
    let mut by_key = BTreeMap::new();
    for event in events {
        let Ok(Some(content)) = event.raw().get_field::<ContentIn>("content") else {
            continue;
        };
        let Some(relation) = content
            .relates_to
            .filter(|relation| relation.event_id.as_deref() == Some(target.as_str()))
        else {
            continue;
        };
        let Some(key) = relation.key.filter(|key| key.starts_with("mxc://")) else {
            continue;
        };
        let Some(shortcode) = content.shortcode.as_deref().and_then(normalized) else {
            continue;
        };
        by_key.entry(key).or_insert(shortcode);
    }
    by_key
        .into_iter()
        .map(|(key, shortcode)| ReactionShortcodeView { key, shortcode })
        .collect()
}

fn normalized(shortcode: &str) -> Option<String> {
    let name = shortcode.trim().trim_matches(':').trim();
    let name = truncate_graphemes(name, MAX_SHORTCODE_BYTES);
    (!name.is_empty()).then(|| name.to_owned())
}

#[cfg(test)]
#[path = "reactions_tests.rs"]
mod tests;
