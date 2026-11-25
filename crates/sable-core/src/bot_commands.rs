use sable_model::text::visible_name;

use std::collections::HashMap;

use matrix_sdk::ruma::api::client::state::get_state_events;
use matrix_sdk::ruma::events::{AnyStateEvent, AnySyncStateEvent};
use matrix_sdk::ruma::serde::Raw;
use sable_model::bot_commands::{BotCommand, BotCommandDescription, parse_descriptions};
use serde::Deserialize;
use serde_json::Value;

use crate::Core;
use crate::SignedIn;
use crate::protocol::CoreEvent;

pub(crate) const COMMAND_DESCRIPTION_EVENT: &str = "org.matrix.msc4391.command_description";
pub(crate) const COMMAND_FIELD: &str = "org.matrix.msc4391.command";
const MEMBER_EVENT: &str = "m.room.member";

/// Fills the empty `via` the model leaves on a room that was typed or picked.
pub(crate) async fn route_rooms(client: &matrix_sdk::Client, command: &mut Value) {
    let Some(arguments) = command.get_mut("arguments").and_then(Value::as_object_mut) else {
        return;
    };
    for argument in arguments.values_mut() {
        let values = match argument {
            Value::Array(values) => values.as_mut_slice(),
            value => std::slice::from_mut(value),
        };
        for reference in values.iter_mut().filter_map(Value::as_object_mut) {
            if reference.get("via") != Some(&Value::Array(Vec::new())) {
                continue;
            }
            reference.remove("via");
            let id = reference.get("id").and_then(Value::as_str);
            if let Some(id) = id.and_then(|id| ruma::RoomId::parse(id).ok())
                && let Some(room) = client.get_room(&id)
                && let Some(route) = crate::routing::Route::cached(&room).await
            {
                reference.insert("via".to_owned(), route.to_strings().into());
            }
        }
    }
}

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

/// Only a joined member's descriptions count, and they carry its profile.
pub(crate) fn descriptions(state: &[Raw<AnyStateEvent>]) -> Vec<BotCommand> {
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

    let described: Vec<BotCommandDescription> = events
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
            Some(BotCommandDescription {
                sender: event.sender.clone(),
                sender_name: text("displayname").and_then(visible_name),
                sender_avatar: text("avatar_url").and_then(|url| crate::media::mxc_only(&url)),
                content: event.content.clone(),
            })
        })
        .collect();
    parse_descriptions(&described)
}

impl SignedIn {
    pub(crate) fn watch_bot_commands(&self, generation: u64) {
        let client = self.client();
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
                        core.core().emit_if_current(
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

impl Core {
    pub(crate) async fn bot_commands_for(
        &self,
        client: &matrix_sdk::Client,
        room: &matrix_sdk::Room,
    ) -> Result<Vec<BotCommand>, matrix_sdk::Error> {
        let response = client
            .send(get_state_events::v3::Request::new(
                room.room_id().to_owned(),
            ))
            .await?;
        Ok(descriptions(&response.room_state))
    }
}

#[cfg(test)]
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
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
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

        let found = session
            .core()
            .bot_commands_for(&client, &client.get_room(room_id).unwrap())
            .await
            .unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].sender, BOT);
        assert_eq!(found[0].sender_name.as_deref(), Some("Bot"));
        assert_eq!(found[0].command, "ban");
    }

    #[tokio::test]
    async fn synced_command_descriptions_and_member_changes_are_announced() {
        let server = MatrixMockServer::new().await;
        let room_id = room_id!("!room:example.org");
        let client = server.client_builder().build().await;
        server.sync_joined_room(&client, room_id).await;
        let (core, mut events) = Core::new("bot-commands", Box::new(MemorySessionStore::default()));
        crate::test_support::sign_in(&core, &server, client.clone()).await;
        let session = core.signed_in().unwrap();
        session.watch_bot_commands(1);

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

    #[tokio::test]
    async fn only_references_asking_for_a_route_get_one() {
        use matrix_sdk::ruma::room_id;

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server.sync_joined_room(&client, room_id!("!known")).await;
        let mut command = serde_json::json!({"command": "move", "arguments": {
            "picked": [{"type": "room_id", "id": "!known", "via": []}],
            "declared": {"type": "room_id", "id": "!known"},
            "unknown": {"type": "room_id", "id": "!elsewhere", "via": []},
        }});

        super::route_rooms(&client, &mut command).await;

        assert_eq!(
            command["arguments"],
            serde_json::json!({
                "picked": [{"type": "room_id", "id": "!known", "via": ["localhost"]}],
                "declared": {"type": "room_id", "id": "!known"},
                "unknown": {"type": "room_id", "id": "!elsewhere"},
            })
        );
    }
}
