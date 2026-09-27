use std::collections::BTreeMap;

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::ruma::events::relation::RelationType;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId};

use crate::Core;
use crate::protocol::{CommandErr, CommandOk, ReactionShortcodeView};

const MAX_SHORTCODE_BYTES: usize = 100;

impl Core {
    /// MSC4027 names a custom-image reaction in its own content, which the
    /// timeline's reaction groups do not carry.
    ///
    /// # Errors
    ///
    /// Returns an error when the room is unknown or its event cache cannot be read.
    pub(crate) async fn reaction_shortcodes(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
    ) -> Result<Vec<ReactionShortcodeView>, CommandErr> {
        let room = self.room(room_id).await?;
        let (cache, _handles) = room
            .event_cache()
            .await
            .map_err(|error| self.failed("reaction_shortcodes", error))?;
        let related = cache
            .find_event_with_relations(event_id, Some(vec![RelationType::Annotation]))
            .await
            .map_err(|error| self.failed("reaction_shortcodes", error))?
            .map(|(_, related)| related)
            .unwrap_or_default();
        Ok(shortcodes(&related))
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
        if let Ok(CommandOk::ImagePacks { packs, .. }) =
            self.image_packs(room_id.clone(), true).await
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

fn shortcodes(events: &[TimelineEvent]) -> Vec<ReactionShortcodeView> {
    let mut by_key = BTreeMap::new();
    for event in events {
        let Ok(Some(content)) = event.raw().get_field::<serde_json::Value>("content") else {
            continue;
        };
        let Some(key) = content
            .pointer("/m.relates_to/key")
            .and_then(serde_json::Value::as_str)
            .filter(|key| key.starts_with("mxc://"))
        else {
            continue;
        };
        let Some(shortcode) = content
            .get("shortcode")
            .and_then(serde_json::Value::as_str)
            .and_then(normalized)
        else {
            continue;
        };
        by_key.entry(key.to_owned()).or_insert(shortcode);
    }
    by_key
        .into_iter()
        .map(|(key, shortcode)| ReactionShortcodeView { key, shortcode })
        .collect()
}

fn normalized(shortcode: &str) -> Option<String> {
    let name = shortcode.trim().trim_matches(':').trim();
    let end = name
        .char_indices()
        .map(|(start, character)| start + character.len_utf8())
        .take_while(|end| *end <= MAX_SHORTCODE_BYTES)
        .last()?;
    name.get(..end).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use matrix_sdk::deserialized_responses::TimelineEvent;
    use matrix_sdk::ruma::serde::Raw;
    use serde_json::json;

    use super::shortcodes;

    fn reaction(key: &str, shortcode: Option<&str>) -> TimelineEvent {
        let mut content = json!({
            "m.relates_to": { "rel_type": "m.annotation", "event_id": "$target", "key": key },
        });
        if let Some(shortcode) = shortcode {
            content["shortcode"] = json!(shortcode);
        }
        TimelineEvent::from_plaintext(
            Raw::new(&json!({
                "type": "m.reaction",
                "event_id": format!("${key}{}", shortcode.unwrap_or_default()),
                "sender": "@alice:example.org",
                "origin_server_ts": 1,
                "content": content,
            }))
            .unwrap_or_else(|error| panic!("{error}"))
            .cast_unchecked(),
        )
    }

    #[test]
    fn test_each_custom_key_takes_the_first_shortcode_it_was_sent_with() {
        let found = shortcodes(&[
            reaction("mxc://example.org/parrot", Some(":partyparrot:")),
            reaction("mxc://example.org/parrot", Some(":other:")),
            reaction("mxc://example.org/cat", Some("blobcat")),
        ]);

        let pairs: Vec<_> = found
            .iter()
            .map(|view| (view.key.as_str(), view.shortcode.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [
                ("mxc://example.org/cat", "blobcat"),
                ("mxc://example.org/parrot", "partyparrot"),
            ]
        );
    }

    #[test]
    fn test_emoji_keys_and_reactions_without_a_shortcode_are_skipped() {
        let found = shortcodes(&[
            reaction("👍", Some(":thumbsup:")),
            reaction("mxc://example.org/nameless", None),
            reaction("mxc://example.org/blank", Some("::")),
        ]);

        assert!(found.is_empty());
    }

    #[test]
    fn test_an_oversized_shortcode_is_cut_to_100_bytes() {
        let long = "é".repeat(80);
        let found = shortcodes(&[reaction("mxc://example.org/long", Some(&long))]);

        assert_eq!(found.first().map(|view| view.shortcode.len()), Some(100));
    }
}
