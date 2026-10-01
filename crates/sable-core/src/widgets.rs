use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::ruma::api::client::account::request_openid_token;
use matrix_sdk::ruma::api::client::user_directory::search_users;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, UInt};

use crate::Core;
use crate::ResultExt;
use crate::protocol::{CommandErr, OpenIdTokenView, UserDirectoryEntryView};

const MAX_TIMELINE_EVENTS: usize = 500;

impl Core {
    pub(crate) async fn room_timeline_events(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
        msgtype: Option<&str>,
        limit: u32,
        since: Option<&OwnedEventId>,
    ) -> Result<Vec<serde_json::Value>, CommandErr> {
        let client = self.client().await?;
        let Ok((cache, _drop_handles)) = client.event_cache().room(room_id).await else {
            return Ok(Vec::new());
        };
        let Ok(events) = cache.events().await else {
            return Ok(Vec::new());
        };

        let ceiling = if limit == 0 {
            MAX_TIMELINE_EVENTS
        } else {
            (limit as usize).min(MAX_TIMELINE_EVENTS)
        };

        let mut collected = Vec::new();
        for event in events.iter().rev() {
            let Ok(json) = serde_json::from_str::<serde_json::Value>(event.raw().json().get())
            else {
                continue;
            };

            if json.get("state_key").is_some() {
                continue;
            }
            if json.get("type").and_then(serde_json::Value::as_str) != Some(event_type) {
                continue;
            }
            if let Some(msgtype) = msgtype
                && json
                    .get("content")
                    .and_then(|content| content.get("msgtype"))
                    .and_then(serde_json::Value::as_str)
                    != Some(msgtype)
            {
                continue;
            }

            if since.is_some_and(|since| {
                json.get("event_id").and_then(serde_json::Value::as_str) == Some(since.as_str())
            }) {
                break;
            }

            collected.push(json);
            if collected.len() >= ceiling {
                break;
            }
        }

        Ok(collected)
    }

    pub(crate) async fn room_state_events_raw(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
        state_key: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, CommandErr> {
        let room = self.room(room_id).await?;
        let events = room
            .get_state_events(event_type.into())
            .await
            .or_failed(self, "room_state_events_raw")?;

        Ok(events
            .into_iter()
            .filter_map(|event| {
                let raw = match &event {
                    RawAnySyncOrStrippedState::Sync(raw) => raw.json(),
                    RawAnySyncOrStrippedState::Stripped(raw) => raw.json(),
                };
                serde_json::from_str::<serde_json::Value>(raw.get()).ok()
            })
            .filter(|json| {
                state_key.is_none_or(|wanted| {
                    json.get("state_key").and_then(serde_json::Value::as_str) == Some(wanted)
                })
            })
            .collect())
    }

    pub(crate) async fn search_user_directory(
        &self,
        term: &str,
        limit: Option<u32>,
    ) -> Result<(bool, Vec<UserDirectoryEntryView>), CommandErr> {
        let mut request = search_users::v3::Request::new(term.to_owned());
        if let Some(limit) = limit {
            request.limit = UInt::from(limit);
        }

        let response = self
            .client()
            .await?
            .send(request)
            .await
            .map_err(|error| self.homeserver_http_error("search_user_directory", error))?;

        Ok((
            response.limited,
            response
                .results
                .into_iter()
                .map(|user| UserDirectoryEntryView {
                    user_id: user.user_id.to_string(),
                    display_name: user.display_name,
                    avatar_url: user.avatar_url.map(|url| url.to_string()),
                })
                .collect(),
        ))
    }

    pub(crate) async fn openid_token(&self) -> Result<OpenIdTokenView, CommandErr> {
        let client = self.client().await?;
        let user_id = client.user_id().ok_or(CommandErr::NotLoggedIn)?.to_owned();

        let response = client
            .send(request_openid_token::v3::Request::new(user_id))
            .await
            .map_err(|error| self.homeserver_http_error("openid_token", error))?;

        Ok(OpenIdTokenView {
            access_token: response.access_token,
            token_type: response.token_type.to_string(),
            matrix_server_name: response.matrix_server_name.to_string(),
            expires_in_ms: u64::try_from(response.expires_in.as_millis()).unwrap_or(u64::MAX),
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::{Core, protocol::Command, session::Session, store::MemorySessionStore};
    use matrix_sdk::{ruma::room_id, test_utils::mocks::MatrixMockServer};
    use matrix_sdk_ui::sync_service::SyncService;
    use serde_json::json;
    use std::sync::Arc;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path_regex},
    };

    #[tokio::test]
    async fn widget_sends_return_the_created_event_id() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!widgets:example.org");
        server.sync_joined_room(&client, room_id).await;
        server.mock_room_state_encryption().plain().mount().await;
        Mock::given(method("PUT"))
            .and(path_regex(
                "/_matrix/client/v3/rooms/.*/(send|state|redact)/.*",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$created"})))
            .expect(3)
            .mount(server.server())
            .await;
        let (core, _events) = Core::new("widgets", Box::new(MemorySessionStore::default()));
        *core.session.write().await = Some(Session {
            account_id: "widgets".to_owned(),
            homeserver: server.server().uri(),
            oauth: false,
            sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
            client,
        });
        for command in [
            Command::SendRawEvent {
                room_id: room_id.to_owned(),
                event_type: "com.example.message".to_owned(),
                content: json!({}),
            },
            Command::SendStateEvent {
                room_id: room_id.to_owned(),
                event_type: "com.example.state".to_owned(),
                state_key: String::new(),
                content: json!({}),
            },
            Command::SendRedaction {
                room_id: room_id.to_owned(),
                event_id: "$target".try_into().unwrap(),
                reason: None,
            },
        ] {
            let response =
                serde_json::to_value(Box::pin(core.dispatch(command)).await.unwrap()).unwrap();
            assert_eq!(response["event_id"], "$created");
        }
    }
}
