use std::collections::BTreeMap;

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::ruma::events::relation::RelationType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId};

use crate::Core;
use crate::ResultExt;
use crate::protocol::{CommandErr, CommandOk, ReactionShortcodeView};

const MAX_SHORTCODE_BYTES: usize = 100;

pub(crate) fn can_annotate<T>(event: &Raw<T>) -> bool {
    let content = event
        .get_field::<serde_json::Value>("content")
        .ok()
        .flatten();
    !matches!(
        content
            .as_ref()
            .and_then(|content| content.pointer("/m.relates_to/rel_type"))
            .and_then(serde_json::Value::as_str),
        Some("m.annotation" | "m.replace")
    )
}

impl Core {
    pub(crate) async fn ensure_reaction_target(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
    ) -> Result<(), CommandErr> {
        let event = self
            .room(room_id)
            .await?
            .load_or_fetch_event(event_id, None)
            .await
            .or_failed(self, "reaction_target")?;
        if can_annotate(event.raw()) {
            Ok(())
        } else {
            Err(CommandErr::Unsupported)
        }
    }

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
            .or_failed(self, "reaction_shortcodes")?;
        let related = cache
            .find_event_with_relations(event_id, Some(vec![RelationType::Annotation]))
            .await
            .or_failed(self, "reaction_shortcodes")?
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

fn shortcodes(events: &[TimelineEvent], target: &EventId) -> Vec<ReactionShortcodeView> {
    let mut by_key = BTreeMap::new();
    for event in events {
        let Ok(Some(content)) = event.raw().get_field::<serde_json::Value>("content") else {
            continue;
        };
        if content
            .pointer("/m.relates_to/event_id")
            .and_then(serde_json::Value::as_str)
            != Some(target.as_str())
        {
            continue;
        }
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
    use matrix_sdk::ruma::{event_id, serde::Raw};
    use serde_json::json;

    use super::{can_annotate, shortcodes};

    #[test]
    fn annotation_targets_are_checked_by_relation_type() {
        for (relation, allowed) in [
            (
                json!({"rel_type": "m.annotation", "event_id": "$original"}),
                false,
            ),
            (
                json!({"rel_type": "m.replace", "event_id": "$original"}),
                false,
            ),
            (
                json!({"rel_type": "m.thread", "event_id": "$original"}),
                true,
            ),
            (
                json!({"rel_type": "m.reference", "event_id": "$original"}),
                true,
            ),
            (json!({"m.in_reply_to": {"event_id": "$original"}}), true),
            (serde_json::Value::Null, true),
        ] {
            let event = Raw::new(&json!({
                "type": "com.example.custom",
                "content": {"m.relates_to": relation},
            }))
            .unwrap();
            assert_eq!(can_annotate(&event), allowed);
        }
    }

    #[tokio::test]
    #[cfg(not(target_family = "wasm"))]
    #[allow(clippy::too_many_lines)]
    async fn nested_reactions_are_ignored() {
        use std::{collections::BTreeSet, sync::Arc};

        use crate::{
            Core,
            protocol::{Command, CommandErr, TimelineFocusView},
            session::Session,
            store::MemorySessionStore,
        };
        use matrix_sdk::{
            ruma::{event_id, room_id},
            test_utils::mocks::MatrixMockServer,
        };
        use matrix_sdk_test::{ALICE, JoinedRoomBuilder, event_factory::EventFactory};
        use matrix_sdk_ui::sync_service::SyncService;

        for reactions_first in [false, true] {
            let server = MatrixMockServer::new().await;
            let client = server.client_builder().build().await;
            client.event_cache().subscribe().unwrap();
            server.mock_room_state_encryption().plain().mount().await;
            let room_id = room_id!("!reactions:example.org");
            let factory = EventFactory::new().room(room_id).sender(*ALICE);
            let original = event_id!("$original");
            let annotation = event_id!("$annotation");
            let replacement = event_id!("$replacement");
            let edit = event_id!("$edit");
            let reaction = event_id!("$reaction");
            let custom = |event_id, relation| {
                Raw::new(&json!({
                    "type": "com.example.custom", "event_id": event_id,
                    "sender": *ALICE, "origin_server_ts": 1,
                    "content": {"m.relates_to": {"rel_type": relation, "event_id": original}},
                }))
                .unwrap()
                .cast_unchecked()
            };
            let image_reaction = |target, event_id| {
                Raw::new(&json!({
                    "type": "m.reaction", "event_id": event_id,
                    "sender": *ALICE, "origin_server_ts": 2,
                    "content": {
                        "shortcode": "invalid",
                        "m.relates_to": {"rel_type": "m.annotation", "event_id": target, "key": "mxc://example.org/invalid"},
                    },
                }))
                .unwrap()
                .cast_unchecked()
            };
            let targets = [
                factory.text_msg("original").event_id(original).into_raw(),
                custom(annotation, "m.annotation"),
                custom(replacement, "m.replace"),
                factory.text_msg("edited")
                    .edit(original, matrix_sdk::ruma::events::room::message::RoomMessageEventContent::text_plain("edited").into())
                    .event_id(edit).into_raw(),
                factory.reaction(original, "👍").event_id(reaction).into_raw(),
            ];
            let annotations = [
                image_reaction(annotation, event_id!("$nested")),
                image_reaction(replacement, event_id!("$on-replacement")),
                factory
                    .reaction(edit, "👎")
                    .event_id(event_id!("$on-edit"))
                    .into_raw(),
                image_reaction(reaction, event_id!("$on-reaction")),
            ];
            let events = if reactions_first {
                annotations.into_iter().chain(targets).collect::<Vec<_>>()
            } else {
                targets.into_iter().chain(annotations).collect::<Vec<_>>()
            };
            let mut joined = JoinedRoomBuilder::new(room_id);
            for event in events {
                joined = joined.add_timeline_event(event);
            }
            let room = server.sync_room(&client, joined).await;
            let timeline =
                crate::timelines::build_room_timeline(&room, &TimelineFocusView::Live, true)
                    .await
                    .unwrap();
            let views = timeline
                .items()
                .await
                .iter()
                .map(|item| {
                    crate::view::timeline_item(
                        item,
                        client.user_id(),
                        &BTreeSet::new(),
                        &crate::view::Highlights::default(),
                        &crate::view::LocalContent::default(),
                    )
                })
                .collect::<Vec<_>>();
            let original_view = views
                .iter()
                .find(|item| item.event_id.as_deref() == Some(original))
                .unwrap();
            assert_eq!(original_view.reactions.len(), 1);
            assert_eq!(original_view.reactions[0].key, "👍");
            assert!(matches!(
                &original_view.content,
                crate::protocol::TimelineItemContentView::Message { edited: true, .. }
            ));
            for target in [annotation, replacement] {
                let view = views
                    .iter()
                    .find(|item| item.event_id.as_deref() == Some(target))
                    .unwrap();
                assert!(view.reactions.is_empty());
            }

            let (core, _events) =
                Core::new("reactions-test", Box::new(MemorySessionStore::default()));
            *core.session.write().await = Some(Session {
                account_id: "test".to_owned(),
                sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
                client,
                homeserver: server.server().uri(),
                oauth: false,
            });
            core.ensure_reaction_target(&room_id.to_owned(), &original.to_owned())
                .await
                .unwrap();
            assert!(
                core.reaction_shortcodes(&room_id.to_owned(), &original.to_owned())
                    .await
                    .unwrap()
                    .is_empty()
            );
            for target in [annotation, replacement, edit, reaction] {
                assert!(
                    core.reaction_shortcodes(&room_id.to_owned(), &target.to_owned())
                        .await
                        .unwrap()
                        .is_empty()
                );
                assert!(matches!(
                    Box::pin(core.dispatch(Command::React {
                        room_id: room_id.to_owned(),
                        event_id: target.to_owned(),
                        key: "👍".to_owned(),
                        source_pack: None,
                        shortcode: None,
                        thread_root: None,
                    }))
                    .await,
                    Err(CommandErr::Unsupported)
                ));
            }
        }
    }

    fn reaction(key: &str, shortcode: Option<&str>) -> TimelineEvent {
        reaction_to(key, shortcode, "$target")
    }

    fn reaction_to(key: &str, shortcode: Option<&str>, target: &str) -> TimelineEvent {
        let mut content = json!({
            "m.relates_to": { "rel_type": "m.annotation", "event_id": target, "key": key },
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
        let found = shortcodes(
            &[
                reaction("mxc://example.org/parrot", Some(":partyparrot:")),
                reaction("mxc://example.org/parrot", Some(":other:")),
                reaction("mxc://example.org/cat", Some("blobcat")),
            ],
            event_id!("$target"),
        );

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
        let found = shortcodes(
            &[
                reaction("👍", Some(":thumbsup:")),
                reaction("mxc://example.org/nameless", None),
                reaction("mxc://example.org/blank", Some("::")),
            ],
            event_id!("$target"),
        );

        assert!(found.is_empty());
    }

    #[test]
    fn test_an_oversized_shortcode_is_cut_to_100_bytes() {
        let long = "é".repeat(80);
        let found = shortcodes(
            &[reaction("mxc://example.org/long", Some(&long))],
            event_id!("$target"),
        );

        assert_eq!(found.first().map(|view| view.shortcode.len()), Some(100));
    }

    #[test]
    fn shortcodes_exclude_nested_reactions() {
        let found = shortcodes(
            &[
                reaction_to("mxc://example.org/parrot", Some("wrong"), "$reaction"),
                reaction("mxc://example.org/parrot", Some("parrot")),
                reaction_to("mxc://example.org/cat", Some("cat"), "$edit"),
            ],
            event_id!("$target"),
        );

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].shortcode, "parrot");
    }
}
