use std::collections::HashMap;
use std::sync::Arc;

use matrix_sdk::ruma::api::client::state::get_state_events;
use matrix_sdk::ruma::events::{AnyStateEvent, AnySyncStateEvent};
use matrix_sdk::ruma::serde::Raw;
use serde::Deserialize;
use serde_json::Value;

use crate::Core;
use crate::protocol::{BotCommandDescriptionView, CoreEvent};

pub(crate) const COMMAND_DESCRIPTION_EVENT: &str = "org.matrix.msc4391.command_description";
pub(crate) const COMMAND_FIELD: &str = "org.matrix.msc4391.command";
const MEMBER_EVENT: &str = "m.room.member";

#[derive(Deserialize)]
struct StateFields {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    state_key: Option<String>,
    sender: String,
    #[serde(default)]
    content: Value,
}

pub(crate) fn descriptions(state: &[Raw<AnyStateEvent>]) -> Vec<BotCommandDescriptionView> {
    let events: Vec<StateFields> = state
        .iter()
        .filter_map(|raw| raw.deserialize_as_unchecked::<StateFields>().ok())
        .collect();

    let joined: HashMap<&str, &Value> = events
        .iter()
        .filter(|event| {
            event.event_type == MEMBER_EVENT
                && event.content.get("membership").and_then(Value::as_str) == Some("join")
        })
        .filter_map(|event| Some((event.state_key.as_deref()?, &event.content)))
        .collect();

    events
        .iter()
        .filter(|event| event.event_type == COMMAND_DESCRIPTION_EVENT)
        .filter(|event| {
            event
                .content
                .as_object()
                .is_some_and(|content| !content.is_empty())
        })
        .filter_map(|event| {
            let member = joined.get(event.sender.as_str())?;
            let text = |field: &str| member.get(field).and_then(Value::as_str).map(str::to_owned);
            Some(BotCommandDescriptionView {
                sender: event.sender.clone(),
                sender_name: text("displayname"),
                sender_avatar: text("avatar_url"),
                content: event.content.clone(),
            })
        })
        .collect()
}

impl Core {
    pub(crate) async fn bot_commands_for(
        &self,
        client: &matrix_sdk::Client,
        room: &matrix_sdk::Room,
    ) -> Result<Vec<BotCommandDescriptionView>, matrix_sdk::Error> {
        let response = client
            .send(get_state_events::v3::Request::new(
                room.room_id().to_owned(),
            ))
            .await?;
        Ok(descriptions(&response.room_state))
    }

    pub(crate) fn watch_bot_commands(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        generation: u64,
    ) {
        let handle = client.add_event_handler({
            let core = self.clone();
            move |raw: Raw<AnySyncStateEvent>, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    let kind = raw.get_field::<String>("type").ok().flatten();
                    if matches!(
                        kind.as_deref(),
                        Some(COMMAND_DESCRIPTION_EVENT | MEMBER_EVENT)
                    ) {
                        core.emit_if_current(
                            generation,
                            CoreEvent::BotCommandsChanged {
                                room_id: room.room_id().to_owned(),
                            },
                        );
                    }
                }
            }
        });
        self.track_session_handler(client, handle);
    }
}

#[cfg(test)]
#[allow(clippy::large_futures)]
mod tests {
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk::ruma::{OwnedRoomId, room_id};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::{Value, json};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};

    use super::{COMMAND_DESCRIPTION_EVENT, MEMBER_EVENT};
    use crate::Core;
    use crate::protocol::CoreEvent;
    use crate::store::MemorySessionStore;

    const BOT: &str = "@bot:example.org";
    const GONE: &str = "@gone:example.org";

    fn state(event_type: &str, state_key: &str, sender: &str, content: &Value) -> Value {
        json!({
            "type": event_type,
            "state_key": state_key,
            "sender": sender,
            "event_id": format!("${event_type}-{state_key}"),
            "origin_server_ts": 1,
            "content": content,
        })
    }

    #[tokio::test]
    async fn only_joined_senders_advertise_commands() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let client = server.client_builder().build().await;
        server.sync_joined_room(&client, room_id).await;
        let (core, _events) = Core::new("bot-commands", Box::new(MemorySessionStore::default()));
        Mock::given(method("GET"))
            .and(path(format!("/_matrix/client/v3/rooms/{room_id}/state")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                state(
                    MEMBER_EVENT,
                    BOT,
                    BOT,
                    &json!({ "membership": "join", "displayname": "Bot" })
                ),
                state(MEMBER_EVENT, GONE, GONE, &json!({ "membership": "leave" })),
                state(
                    COMMAND_DESCRIPTION_EVENT,
                    "ban",
                    BOT,
                    &json!({ "command": "ban" })
                ),
                state(COMMAND_DESCRIPTION_EVENT, "cleared", BOT, &json!({})),
                state(
                    COMMAND_DESCRIPTION_EVENT,
                    "kick",
                    GONE,
                    &json!({ "command": "kick" })
                ),
            ])))
            .mount(server.server())
            .await;

        let found = core
            .bot_commands_for(&client, &client.get_room(room_id).unwrap())
            .await
            .unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].sender, BOT);
        assert_eq!(found[0].sender_name.as_deref(), Some("Bot"));
        assert_eq!(found[0].content, json!({ "command": "ban" }));
    }

    #[tokio::test]
    async fn synced_command_descriptions_and_member_changes_are_announced() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let client = server.client_builder().build().await;
        server.sync_joined_room(&client, room_id).await;
        let (core, mut events) = Core::new("bot-commands", Box::new(MemorySessionStore::default()));
        core.watch_bot_commands(&client, 1);

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id)
                    .add_timeline_event(
                        Raw::new(&state(
                            COMMAND_DESCRIPTION_EVENT,
                            "ban",
                            BOT,
                            &json!({ "command": "ban" }),
                        ))
                        .unwrap()
                        .cast_unchecked(),
                    )
                    .add_timeline_event(
                        Raw::new(&state(
                            MEMBER_EVENT,
                            BOT,
                            BOT,
                            &json!({ "membership": "leave" }),
                        ))
                        .unwrap()
                        .cast_unchecked(),
                    ),
            )
            .await;

        let announced: Vec<OwnedRoomId> = std::iter::from_fn(|| events.try_recv().ok())
            .filter_map(|event| match event {
                CoreEvent::BotCommandsChanged { room_id } => Some(room_id),
                _ => None,
            })
            .collect();
        assert_eq!(announced, [room_id.to_owned(), room_id.to_owned()]);
    }
}
