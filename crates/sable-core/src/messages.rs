use matrix_sdk::room::MessagesOptions;
use matrix_sdk::ruma::api::client::room::report_content;
use matrix_sdk::ruma::events::relation::RelationType;
use matrix_sdk::ruma::events::room::message::Relation;
use matrix_sdk::ruma::events::{AnyMessageLikeEventContent, AnySyncTimelineEvent, Mentions};
use matrix_sdk::ruma::room::JoinRule;
use matrix_sdk::ruma::{EventId, OwnedEventId, OwnedRoomId, OwnedUserId, UInt};

use crate::Core;
use crate::personas::PER_MESSAGE_PROFILE;
use crate::protocol::CommandErr;

pub(crate) fn outgoing_mentions(user_ids: Vec<OwnedUserId>, room: bool) -> Option<Mentions> {
    if user_ids.is_empty() && !room {
        return None;
    }

    let mut mentions = Mentions::with_user_ids(user_ids);
    mentions.room = room;
    Some(mentions)
}

impl Core {
    pub(crate) async fn bulk_redact(
        &self,
        room_id: &OwnedRoomId,
        senders: &[String],
        after_ts: u64,
        event_types: &[String],
        reason: Option<&str>,
    ) -> Result<u32, CommandErr> {
        let room = self.room(room_id).await?;
        let mut from: Option<String> = None;
        let mut redacted = 0;

        loop {
            let mut options = MessagesOptions::backward().from(from.as_deref());
            options.limit = UInt::from(100u16);
            let messages = room
                .messages(options)
                .await
                .map_err(|error| self.failed("bulk_redact", error))?;
            if messages.chunk.is_empty() {
                break;
            }

            let mut older_than_cutoff = true;
            for event in messages.chunk {
                let Ok(raw) = serde_json::from_str::<serde_json::Value>(event.raw().json().get())
                else {
                    continue;
                };
                let ts = raw
                    .get("origin_server_ts")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or_default();
                if ts >= after_ts {
                    older_than_cutoff = false;
                }
                if ts < after_ts
                    || !senders.iter().any(|sender| {
                        raw.get("sender").and_then(serde_json::Value::as_str) == Some(sender)
                    })
                    || (!event_types.is_empty()
                        && !event_types.iter().any(|event_type| {
                            raw.get("type").and_then(serde_json::Value::as_str) == Some(event_type)
                        }))
                    || raw
                        .get("unsigned")
                        .and_then(|unsigned| unsigned.get("redacted_because"))
                        .is_some()
                {
                    continue;
                }

                let Some(event_id) = raw.get("event_id").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let event_id =
                    EventId::parse(event_id).map_err(|error| self.failed("bulk_redact", error))?;
                room.redact(&event_id, reason, None)
                    .await
                    .map_err(|error| self.failed("bulk_redact", error))?;
                redacted += 1;
            }

            if older_than_cutoff {
                break;
            }
            let Some(next) = messages.end else {
                break;
            };
            from = Some(next);
        }

        Ok(redacted)
    }

    pub(crate) async fn pinned_events(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<Vec<OwnedEventId>, CommandErr> {
        let room = self.room(room_id).await?;
        if let Some(events) = room.pinned_event_ids() {
            return Ok(events);
        }
        if !self
            .probed_pinned_rooms
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(room_id.clone())
        {
            return Ok(Vec::new());
        }
        Ok(room
            .load_pinned_events()
            .await
            .map_err(|error| self.failed("pinned_events", error))?
            .unwrap_or_default())
    }

    pub(crate) async fn set_pinned(
        &self,
        room_id: &OwnedRoomId,
        event_id: OwnedEventId,
        pinned: bool,
    ) -> Result<Vec<OwnedEventId>, CommandErr> {
        let _guard = self.account_data_lock.lock().await;
        let room = self.room(room_id).await?;
        if pinned {
            room.pin_event(&event_id).await
        } else {
            room.unpin_event(&event_id).await
        }
        .map_err(|error| self.failed("set_pinned", error))?;

        Ok(room
            .load_pinned_events()
            .await
            .map_err(|error| self.failed("set_pinned", error))?
            .unwrap_or_default())
    }

    pub(crate) async fn report_message(
        &self,
        room_id: &OwnedRoomId,
        event_id: OwnedEventId,
        reason: Option<String>,
    ) -> Result<(), CommandErr> {
        let room = self.room(room_id).await?;
        let mut request = report_content::v3::Request::new(room.room_id().to_owned(), event_id);
        request.reason = reason;

        room.client()
            .send(request)
            .await
            .map_err(|error| self.failed("report_message", error))?;

        Ok(())
    }

    pub(crate) async fn event_source(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
    ) -> Result<String, CommandErr> {
        let event = self
            .room(room_id)
            .await?
            .event(event_id, None)
            .await
            .map_err(|error| self.failed("event_source", error))?;

        let raw = event.raw().json().get().to_owned();
        Ok(serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|value| serde_json::to_string_pretty(&value).ok())
            .unwrap_or(raw))
    }

    pub(crate) async fn forward_message(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        to_room_id: &OwnedRoomId,
    ) -> Result<(), CommandErr> {
        let source = self.room(room_id).await?;
        let (event, replacements) = source
            .load_or_fetch_event_with_relations(
                event_id,
                Some(vec![RelationType::Replacement]),
                None,
            )
            .await
            .map_err(|error| self.failed("forward_message", error))?;

        let raw = event
            .raw()
            .deserialize()
            .map_err(|error| self.failed("forward_message", error))?;

        let AnySyncTimelineEvent::MessageLike(message) = raw else {
            return Err(CommandErr::Unsupported);
        };
        let origin_server_ts = message.origin_server_ts().0;
        let AnyMessageLikeEventContent::RoomMessage(original) =
            message.original_content().ok_or(CommandErr::Unsupported)?
        else {
            return Err(CommandErr::Unsupported);
        };

        let latest = replacements
            .iter()
            .filter(|replacement| {
                matrix_sdk::check_validity_of_replacement_events(
                    event.raw(),
                    event.encryption_info().map(|info| &**info),
                    replacement.raw(),
                    replacement.encryption_info().map(|info| &**info),
                )
                .is_ok()
            })
            .filter_map(|replacement| {
                let AnySyncTimelineEvent::MessageLike(message) =
                    replacement.raw().deserialize().ok()?
                else {
                    return None;
                };
                let AnyMessageLikeEventContent::RoomMessage(content) =
                    message.original_content()?
                else {
                    return None;
                };
                let Some(Relation::Replacement(relation)) = content.relates_to else {
                    return None;
                };
                Some((message.origin_server_ts(), relation.new_content))
            })
            .max_by_key(|(timestamp, _)| *timestamp);
        let original = latest.map_or(original, |(_, content)| content.with_relation(None));
        let mut content = serde_json::to_value(&original)
            .map_err(|error| self.failed("forward_message", error))?;
        let Some(object) = content.as_object_mut() else {
            return Err(CommandErr::Unsupported);
        };

        object.remove("m.relates_to");
        object.remove("m.mentions");
        object.remove(PER_MESSAGE_PROFILE);

        let private = !matches!(source.join_rule(), Some(JoinRule::Public));
        if private {
            let body = object
                .get("body")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned();
            object.clear();
            object.insert("msgtype".to_owned(), "m.text".into());
            object.insert("body".to_owned(), body.into());
        }

        object.insert(
            FORWARD_META.to_owned(),
            serde_json::json!({
                "origin_server_ts": u64::from(origin_server_ts),
                "event_id": (!private).then(|| event_id.to_string()),
                "room_id": (!private).then(|| room_id.to_string()),
            }),
        );

        self.room(to_room_id)
            .await?
            .send_raw("m.room.message", content)
            .await
            .map_err(|error| self.failed("forward_message", error))?;

        Ok(())
    }
}

const FORWARD_META: &str = "com.famedly.app.forwarded";

#[cfg(test)]
#[allow(clippy::large_futures)]
mod tests {
    use std::sync::{Arc, Mutex};

    use matrix_sdk::{
        ruma::{event_id, room_id},
        test_utils::mocks::MatrixMockServer,
    };
    use matrix_sdk_ui::sync_service::SyncService;
    use serde_json::{Value, json};
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };

    use crate::{Core, session::Session, store::MemorySessionStore};

    async fn core(server: &MatrixMockServer, client: matrix_sdk::Client) -> Arc<Core> {
        let sync_service = Arc::new(SyncService::builder(client.clone()).build().await.unwrap());
        let (core, _events) = Core::new("test", Box::new(MemorySessionStore::default()));
        *core.session.write().await = Some(Session {
            account_id: "test".to_owned(),
            client,
            sync_service,
            homeserver: server.server().uri(),
            oauth: false,
        });
        core
    }

    #[tokio::test]
    async fn pin_and_unpin_load_existing_server_state() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!pins:example.org");
        server.sync_joined_room(&client, room_id).await;
        let pins = Arc::new(Mutex::new(json!({"pinned": ["$old"]})));
        let endpoint = format!("/_matrix/client/v3/rooms/{room_id}/state/m.room.pinned_events/");
        let read_pins = pins.clone();
        Mock::given(method("GET"))
            .and(path(endpoint.clone()))
            .respond_with(move |_: &wiremock::Request| {
                ResponseTemplate::new(200).set_body_json(read_pins.lock().unwrap().clone())
            })
            .mount(server.server())
            .await;
        let write_pins = pins.clone();
        Mock::given(method("PUT"))
            .and(path(endpoint))
            .respond_with(move |request: &wiremock::Request| {
                *write_pins.lock().unwrap() =
                    serde_json::from_slice::<Value>(&request.body).unwrap();
                ResponseTemplate::new(200).set_body_json(json!({"event_id": "$pins"}))
            })
            .expect(2)
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        let result = core
            .set_pinned(&room_id.to_owned(), event_id!("$new").to_owned(), true)
            .await
            .unwrap();
        assert_eq!(result, vec![event_id!("$old"), event_id!("$new")]);
        let result = core
            .set_pinned(&room_id.to_owned(), event_id!("$new").to_owned(), false)
            .await
            .unwrap();
        assert_eq!(result, vec![event_id!("$old")]);
        assert_eq!(*pins.lock().unwrap(), json!({"pinned": ["$old"]}));
    }

    #[tokio::test]
    async fn forwarding_uses_latest_valid_edit_even_when_relations_are_unordered() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().unwrap();
        let source = room_id!("!source:example.org");
        let target = room_id!("!target:example.org");
        server.sync_joined_room(&client, source).await;
        server.sync_joined_room(&client, target).await;
        server.mock_room_state_encryption().plain().mount().await;
        let original = json!({"type": "m.room.message", "event_id": "$original", "sender": "@alice:example.org", "origin_server_ts": 1,
            "room_id": source, "content": {"msgtype": "m.text", "body": "original"}});
        let edit = |id: &str, sender: &str, ts: u64, body: &str| {
            json!({
            "type": "m.room.message", "event_id": id, "sender": sender, "origin_server_ts": ts,
            "room_id": source, "content": {"msgtype": "m.text", "body": "* fallback",
            "m.relates_to": {"rel_type": "m.replace", "event_id": "$original"},
            "m.new_content": {"msgtype": "m.text", "body": body}}})
        };
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{source}/event/$original"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(original))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v1/rooms/{source}/relations/$original/m.replace"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"chunk": [
                edit("$new", "@alice:example.org", 3, "latest"),
                edit("$old", "@alice:example.org", 2, "older"),
                edit("$forged", "@mallory:example.org", 4, "forged")
            ]})))
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(wiremock::matchers::path_regex(format!(
                "/_matrix/client/v3/rooms/{target}/send/m.room.message/.*"
            )))
            .and(wiremock::matchers::body_partial_json(
                json!({"body": "latest"}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$forward"})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        core.forward_message(
            &source.to_owned(),
            &event_id!("$original").to_owned(),
            &target.to_owned(),
        )
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn editing_a_pending_reply_updates_the_queue_and_keeps_the_relation() {
        use crate::protocol::{Command, MessageKind};
        use matrix_sdk::ruma::events::relation::Reply;
        use matrix_sdk::ruma::events::room::message::{Relation, RoomMessageEventContent};
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().unwrap();
        client.send_queue().set_enabled(false).await;
        let room_id = room_id!("!pending:example.org");
        server.sync_joined_room(&client, room_id).await;
        server.mock_room_state_encryption().plain().mount().await;
        let core = core(&server, client).await;
        let timeline = core.timeline(&room_id.to_owned()).await.unwrap();
        let mut content = RoomMessageEventContent::text_plain("before");
        content.relates_to = Some(Relation::Reply(Reply::with_event_id(
            event_id!("$reply").to_owned(),
        )));
        timeline.send(content.into()).await.unwrap();
        let transaction_id = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Some(id) = timeline
                    .items()
                    .await
                    .iter()
                    .find_map(|item| item.as_event()?.transaction_id().map(ToString::to_string))
                {
                    break id;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        core.dispatch(Command::EditMessage {
            room_id: room_id.to_owned(),
            event_id: None,
            transaction_id: Some(transaction_id),
            body: "after".to_owned(),
            formatted: None,
            kind: MessageKind::Text,
            media_caption: false,
            thread_root: None,
            mentions: Vec::new(),
            mentions_room: false,
            persona: None,
        })
        .await
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let items = timeline.items().await;
                if let Some(event) = items
                    .iter()
                    .filter_map(|item| item.as_event())
                    .find(|event| {
                        event
                            .content()
                            .as_message()
                            .is_some_and(|message| message.body() == "after")
                    })
                {
                    assert_eq!(
                        event.content().in_reply_to().unwrap().event_id,
                        event_id!("$reply")
                    );
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn reading_a_thread_sends_only_a_receipt_scoped_to_its_root() {
        use crate::protocol::Command;
        use matrix_sdk_test::{ALICE, JoinedRoomBuilder, event_factory::EventFactory};
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        client.event_cache().subscribe().unwrap();
        let room_id = room_id!("!thread:example.org");
        let root = event_id!("$root");
        let factory = EventFactory::new().room(room_id).sender(*ALICE);
        server.mock_room_state_encryption().plain().mount().await;
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_timeline_event(factory.text_msg("root").event_id(root))
                    .add_timeline_event(
                        factory
                            .text_msg("reply")
                            .event_id(event_id!("$reply"))
                            .in_thread(root, root),
                    ),
            )
            .await;
        Mock::given(method("POST"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room_id}/receipt/m.read/$reply"
            )))
            .and(wiremock::matchers::body_json(json!({"thread_id": "$root"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path(format!(
                "/_matrix/client/v3/rooms/{room_id}/read_markers"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(0)
            .mount(server.server())
            .await;
        let core = core(&server, client).await;
        let subscription = core.allocate_subscription();
        let timeline = core
            .thread_timeline(&room_id.to_owned(), &root.to_owned())
            .await
            .unwrap();
        core.subscriptions.lock().await.insert(
            subscription,
            crate::Subscription {
                tasks: Vec::new(),
                timeline: Some(timeline),
                thread_root: Some(root.to_owned()),
                kind: crate::SubscriptionKind::FocusedTimeline(room_id.to_owned()),
            },
        );
        for thread_root in [None, Some(event_id!("$wrong-root").to_owned())] {
            let result = core
                .dispatch(Command::MarkRead {
                    room_id: room_id.to_owned(),
                    event_id: event_id!("$reply").to_owned(),
                    private_receipt: false,
                    thread_root,
                    subscription: Some(subscription),
                })
                .await;
            assert!(matches!(
                result,
                Err(crate::protocol::CommandErr::UnknownSubscription)
            ));
        }
        core.dispatch(Command::MarkRead {
            room_id: room_id.to_owned(),
            event_id: event_id!("$reply").to_owned(),
            private_receipt: false,
            thread_root: Some(root.to_owned()),
            subscription: Some(subscription),
        })
        .await
        .unwrap();
    }
}
