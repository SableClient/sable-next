use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::ruma::api::client::account::request_openid_token;
use matrix_sdk::ruma::api::client::user_directory::search_users;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, UInt};

use crate::Core;
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
            .map_err(|error| self.failed("room_state_events_raw", error))?;

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
