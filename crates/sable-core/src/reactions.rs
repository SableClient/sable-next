use std::collections::BTreeMap;

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::ruma::events::relation::RelationType;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId};
use sable_model::truncate::truncate_graphemes;
use serde::Deserialize;
use serde_json::{Map, Value};
use serde_with::{DefaultOnError, serde_as};

use crate::Core;
use crate::ResultExt;
use crate::api::packs::ListOk;
use crate::protocol::{ReactionShortcodeView, RpcError};

const MAX_SHORTCODE_BYTES: usize = 100;

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

impl Core {
    pub(crate) async fn ensure_reaction_target(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
    ) -> Result<(), RpcError> {
        let event = self
            .room(room_id)
            .await?
            .load_or_fetch_event(event_id, None)
            .await
            .or_failed(self, "reaction_target")?;
        if can_annotate(event.raw()) && !is_redacted(event.raw()) {
            Ok(())
        } else {
            Err(RpcError::Unsupported)
        }
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
        let room = self.room(room_id).await?;
        let client = room.client();
        let (cache, _handles) = client
            .event_cache()
            .ok_or(RpcError::Unavailable)?
            .room(room_id)
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
mod tests {
    use matrix_sdk::deserialized_responses::TimelineEvent;
    use matrix_sdk::ruma::{event_id, serde::Raw};
    use serde_json::json;

    use super::{can_annotate, is_redacted, shortcodes};

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
    #[expect(
        clippy::too_many_lines,
        reason = "one sequential flow kept in a single function"
    )]
    async fn nested_reactions_are_ignored() {
        use std::sync::Arc;

        use crate::{
            Core, api::timeline::TimelineFocusView, protocol::RpcError, session::Session,
            store::MemorySessionStore,
        };
        use matrix_sdk::{
            ruma::{event_id, room_id},
            test_utils::mocks::MatrixMockServer,
        };
        use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
        use matrix_sdk_ui::sync_service::SyncService;

        for reactions_first in [false, true] {
            let server = MatrixMockServer::new().await;
            let client = server.client_builder().build().await;
            server.mock_room_state_encryption().plain().mount().await;
            let room_id = room_id!("!reactions:example.org");
            let factory = EventFactory::new().room(room_id).sender(User::Alice);
            let original = event_id!("$original");
            let annotation = event_id!("$annotation");
            let replacement = event_id!("$replacement");
            let edit = event_id!("$edit");
            let reaction = event_id!("$reaction");
            let custom = |event_id, relation| {
                Raw::new(&json!({
                    "type": "com.example.custom", "event_id": event_id,
                    "sender": User::Alice, "origin_server_ts": 1,
                    "content": {"m.relates_to": {"rel_type": relation, "event_id": original}},
                }))
                .unwrap()
                .cast_unchecked()
            };
            let image_reaction = |target, event_id| {
                Raw::new(&json!({
                    "type": "m.reaction", "event_id": event_id,
                    "sender": User::Alice, "origin_server_ts": 2,
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
            assert!(
                views
                    .iter()
                    .filter(|item| item.event_id.as_deref() != Some(original))
                    .all(|item| item.reactions.is_empty())
            );

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
                    Box::pin(core.run(crate::api::messages::ReactParams {
                        persona: None,
                        room_id: room_id.to_owned(),
                        event_id: target.to_owned(),
                        key: "👍".to_owned(),
                        source_pack: None,
                        shortcode: None,
                        thread_root: None,
                        subscription: None,
                    }))
                    .await,
                    Err(RpcError::Unsupported)
                ));
            }
        }
    }

    fn raw(event: &serde_json::Value) -> Raw<serde_json::Value> {
        Raw::new(event).expect("raw event")
    }

    #[test]
    fn a_redaction_marker_counts_even_when_null_and_wrong_shapes_read_as_absent() {
        assert!(is_redacted(&raw(
            &json!({ "unsigned": { "redacted_because": null } })
        )));
        assert!(!is_redacted(&raw(&json!({ "unsigned": {} }))));
        assert!(!is_redacted(&raw(&json!({ "unsigned": "x" }))));
        assert!(can_annotate(&raw(
            &json!({ "content": { "m.relates_to": "x" } })
        )));
        assert!(can_annotate(&raw(&json!({ "content": "x" }))));
        assert!(!can_annotate(&raw(&json!({
            "content": { "m.relates_to": { "rel_type": "m.replace" } }
        }))));
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
    #[tokio::test]
    #[cfg(not(target_family = "wasm"))]
    async fn a_redacted_message_shows_no_reactions() {
        use matrix_sdk::{
            ruma::{event_id, room_id},
            test_utils::mocks::MatrixMockServer,
        };
        use matrix_sdk_test::{JoinedRoomBuilder, User, event_factory::EventFactory};
        use matrix_sdk_ui::timeline::RoomExt as _;

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.mock_room_state_encryption().plain().mount().await;
        let room_id = room_id!("!redacted:example.org");
        let me = client.user_id().unwrap().to_owned();
        let factory = EventFactory::new().room(room_id).sender(User::Alice);
        let target = event_id!("$target");
        let room = server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_timeline_event(factory.text_msg("hi").event_id(target))
                    .add_timeline_event(
                        factory.redaction(target).event_id(event_id!("$redaction")),
                    ),
            )
            .await;
        let timeline = room.timeline().await.unwrap();
        let reactions = |items: Vec<std::sync::Arc<matrix_sdk_ui::timeline::TimelineItem>>| {
            items
                .iter()
                .find(|item| item.as_event().and_then(|e| e.event_id()) == Some(target))
                .map(|item| item.as_event().unwrap().reactions().len())
        };
        let item_id = timeline
            .items()
            .await
            .iter()
            .find_map(|item| item.as_event().filter(|e| e.event_id() == Some(target)))
            .unwrap()
            .identifier();

        server
            .mock_room_send()
            .ok(event_id!("$reaction"))
            .mock_once()
            .mount()
            .await;
        timeline.toggle_reaction(&item_id, "👍").await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_timeline_event(
                    EventFactory::new()
                        .room(room_id)
                        .sender(&me)
                        .reaction(target, "👍")
                        .event_id(event_id!("$reaction")),
                ),
            )
            .await;
        assert_eq!(
            reactions(timeline.items().await.iter().cloned().collect()),
            Some(1)
        );

        let views = timeline
            .items()
            .await
            .iter()
            .map(|item| {
                crate::view::timeline_item(
                    item,
                    client.user_id(),
                    &crate::view::Highlights::default(),
                    &crate::view::LocalContent::default(),
                )
            })
            .collect::<Vec<_>>();
        let view = views
            .iter()
            .find(|item| item.event_id.as_deref() == Some(target))
            .unwrap();
        assert!(view.reactions.is_empty());
    }
}
