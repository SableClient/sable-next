use sable_model::text::visible_name;

use crate::api::calls::RtcLivekitEndpoint;
use crate::api::widgets::RestartDelayedEventParams;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::pin_mut;
use matrix_sdk::RoomState;
use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::api::client::account::request_openid_token;
use matrix_sdk::ruma::api::client::delayed_events::update_delayed_event::UpdateAction;
use matrix_sdk::ruma::api::client::relations::{
    get_relating_events, get_relating_events_with_rel_type,
};
use matrix_sdk::ruma::api::client::to_device::send_event_to_device;
use matrix_sdk::ruma::api::client::user_directory::search_users;
use matrix_sdk::ruma::api::client::voip::get_turn_server_info;
use matrix_sdk::ruma::api::{Direction, error::FromHttpResponseError};
use matrix_sdk::ruma::events::GlobalAccountDataEventType;
use matrix_sdk::ruma::events::relation::RelationType;
use matrix_sdk::ruma::events::{
    AnySyncStateEvent, AnySyncTimelineEvent, AnyTimelineEvent, ToDeviceEventType,
};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::to_device::DeviceIdOrAllDevices;
use matrix_sdk::ruma::{OwnedEventId, OwnedRoomId, OwnedUserId, TransactionId, UInt};
use matrix_sdk_base::crypto::CollectStrategy;
use serde::{Deserialize as _, Serialize};
use serde_json::Value;
use serde_with::{DefaultOnError, serde_as};

use crate::calls::sticky;
use crate::delayed_events::{self, DelayedEvent};
use crate::protocol::{
    CoreEvent, OpenIdTokenView, PaginationDirection, RelationsView, RpcCode, RpcError,
    TermsPolicyView, TurnServerView, UserDirectoryEntryView,
};
use crate::view::ObjectOnly;
use crate::{Core, ResultExt};

const MAX_TIMELINE_EVENTS: usize = 500;
const WIDGET_STATE_TYPE: &str = "im.vector.modular.widgets";
const DEFAULT_INTEGRATION_MANAGER: (&str, &str) =
    ("https://scalar.vector.im/api", "https://scalar.vector.im");

macro_rules! livekit_endpoint {
    ($module:ident, $path:literal) => {
        mod $module {
            use http::header::CONTENT_TYPE;
            use ruma::api::{auth_scheme::AccessToken, request, response};
            use ruma::metadata;

            metadata! {
                method: POST,
                rate_limited: false,
                authentication: AccessToken,
                history: {
                    unstable("io.element.msc4195") => $path,
                }
            }

            #[request]
            pub(crate) struct Request {
                #[ruma_api(header = CONTENT_TYPE)]
                pub content_type: String,
                #[ruma_api(raw_body)]
                pub body: Vec<u8>,
            }

            #[response]
            pub(crate) struct Response {
                #[ruma_api(raw_body)]
                pub body: Vec<u8>,
            }
        }
    };
}

livekit_endpoint!(
    livekit_get_token,
    "/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token"
);
livekit_endpoint!(
    livekit_delegate_delayed_leave,
    "/_matrix/client/unstable/io.element.msc4195/rtc/livekit/delegate_delayed_leave"
);

fn is_internal_to_device_type(event_type: &str) -> bool {
    matches!(
        event_type,
        "m.dummy"
            | "m.room_key"
            | "m.room_key_request"
            | "m.forwarded_room_key"
            | "m.key.verification.request"
            | "m.key.verification.ready"
            | "m.key.verification.start"
            | "m.key.verification.cancel"
            | "m.key.verification.accept"
            | "m.key.verification.key"
            | "m.key.verification.mac"
            | "m.key.verification.done"
            | "m.secret.request"
            | "m.secret.send"
            | "m.room.encrypted"
    )
}

pub(crate) struct RelationsFilter<'a> {
    pub rel_type: Option<&'a str>,
    pub event_type: Option<&'a str>,
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    pub limit: Option<u32>,
    pub direction: Option<PaginationDirection>,
}

fn with_room_id(mut event: Value, room_id: &matrix_sdk::ruma::RoomId) -> Value {
    if let Some(object) = event.as_object_mut() {
        object
            .entry("room_id")
            .or_insert_with(|| Value::String(room_id.to_string()));
    }
    event
}

struct IntegrationManager {
    api_url: String,
    ui_url: String,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct WellKnownIn {
    #[serde_as(as = "ObjectOnly")]
    #[serde(rename = "m.integrations")]
    integrations: Option<IntegrationsIn>,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct IntegrationsIn {
    #[serde_as(deserialize_as = "DefaultOnError<Vec<ObjectOnly>>")]
    managers: Vec<Option<ManagerIn>>,
}

#[derive(serde::Deserialize)]
struct ManagerIn {
    api_url: String,
    ui_url: String,
}

async fn fetch_well_known(client: &matrix_sdk::Client, base: &url::Url) -> Option<Value> {
    let response = client
        .http_client()
        .get(base.join("/.well-known/matrix/client").ok()?)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    serde_json::from_str(&response.text().await.ok()?).ok()
}

fn managers_from_well_known(well_known: &Value) -> Vec<IntegrationManager> {
    if !well_known.is_object() {
        return Vec::new();
    }
    WellKnownIn::deserialize(well_known)
        .unwrap_or_default()
        .integrations
        .unwrap_or_default()
        .managers
        .into_iter()
        .flatten()
        .map(|manager| IntegrationManager {
            api_url: manager.api_url,
            ui_url: manager.ui_url,
        })
        .collect()
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct AccountWidgetIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    url: Option<String>,
    #[serde_as(as = "ObjectOnly")]
    data: Option<AccountWidgetDataIn>,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct AccountWidgetDataIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    api_url: Option<String>,
}

fn managers_from_account_data(widgets: &Value, known: &mut Vec<IntegrationManager>) {
    for widget in widgets.as_object().into_iter().flat_map(|map| map.values()) {
        if !widget.is_object() {
            continue;
        }
        let widget = AccountWidgetIn::deserialize(widget).unwrap_or_default();
        if widget.kind.as_deref() != Some("m.integration_manager") {
            continue;
        }
        let Some(url) = widget.url else {
            continue;
        };
        if known.iter().any(|manager| manager.ui_url == url) {
            continue;
        }
        known.push(IntegrationManager {
            api_url: widget
                .data
                .and_then(|data| data.api_url)
                .unwrap_or_else(|| url.clone()),
            ui_url: url,
        });
    }
}

fn integration_manager_page(
    ui_url: &str,
    scalar_token: Option<&str>,
    room_id: &matrix_sdk::ruma::RoomId,
) -> Option<String> {
    let mut url = url::Url::parse(ui_url).ok()?;
    url.set_path("/index.html");
    {
        let mut query = url.query_pairs_mut();
        if let Some(token) = scalar_token {
            query.append_pair("scalar_token", token);
        }
        query.append_pair("room_id", room_id.as_str());
    }
    Some(url.to_string())
}

fn terms_url(api_url: &str) -> String {
    format!(
        "{}/_matrix/integrations/v1/terms",
        api_url.trim_end_matches('/')
    )
}

fn pending_policies(terms: &Value, accepted: &[String]) -> Vec<TermsPolicyView> {
    let Some(policies) = terms.get("policies").and_then(Value::as_object) else {
        return Vec::new();
    };
    policies
        .values()
        .filter_map(|policy| {
            let translations = policy.as_object()?;
            let translation = translations.get("en").or_else(|| {
                translations
                    .values()
                    .find(|value| value.get("url").is_some())
            })?;
            let url = translation.get("url")?.as_str()?;
            if accepted.iter().any(|accepted| accepted == url) {
                return None;
            }
            Some(TermsPolicyView {
                url: url.to_owned(),
                name: translation
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(url)
                    .to_owned(),
            })
        })
        .collect()
}

#[derive(Serialize)]
struct ScalarRegisterOut {
    access_token: String,
    token_type: String,
    matrix_server_name: String,
    expires_in: u64,
}

impl Core {
    pub(crate) async fn room_timeline_events(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
        msgtype: Option<&str>,
        state_key: Option<&str>,
        limit: u32,
        since: Option<&OwnedEventId>,
    ) -> Result<Vec<serde_json::Value>, RpcError> {
        let client = self.client().await?;
        let Some(event_cache) = client.event_cache() else {
            return Ok(Vec::new());
        };
        let Ok((cache, _drop_handles)) = event_cache.room(room_id).await else {
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

            if state_key.is_some_and(|wanted| {
                json.get("state_key").and_then(serde_json::Value::as_str) != Some(wanted)
            }) {
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

            collected.push(with_room_id(json, room_id));
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
    ) -> Result<Vec<serde_json::Value>, RpcError> {
        let room = self.room(room_id).await?;
        let events = self
            .with_open_stores(async || room.get_state_events(event_type.into()).await)
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
            .map(|json| with_room_id(json, room_id))
            .collect())
    }

    pub(crate) async fn search_user_directory(
        &self,
        term: &str,
        limit: Option<u32>,
    ) -> Result<(bool, Vec<UserDirectoryEntryView>), RpcError> {
        let mut request = search_users::v3::Request::new(term.to_owned());
        if let Some(limit) = limit {
            request.limit = UInt::from(limit);
        }

        let response = self
            .client()
            .await?
            .send(request)
            .await
            .or_failed(self, "search_user_directory")?;

        Ok((
            response.limited,
            response
                .results
                .into_iter()
                .map(|user| {
                    let real_name = user.display_name.and_then(visible_name);
                    let real_avatar_url = user.avatar_url.map(|url| url.to_string());
                    UserDirectoryEntryView {
                        user_id: user.user_id.to_string(),
                        display_name: real_name.clone(),
                        avatar_url: real_avatar_url.clone(),
                        real_name,
                        real_avatar_url,
                    }
                })
                .collect(),
        ))
    }

    pub(crate) async fn widget_send_delayed_event(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
        state_key: Option<String>,
        content: Value,
        delay_ms: u64,
        sticky_duration_ms: Option<u32>,
    ) -> Result<String, RpcError> {
        const LABEL: &str = "widget_send_delayed_event";
        let support = self.delayed_events_support().await?;
        if !support.any() {
            return Err(RpcCode::DelayedEventsUnsupported.into());
        }
        let room = self.room(room_id).await?;
        let client = self.client().await?;
        let delay = Duration::from_millis(delay_ms);

        if state_key.is_some() {
            let event = DelayedEvent {
                room_id: room_id.clone(),
                event_type: event_type.to_owned(),
                state_key,
                content: serde_json::value::to_raw_value(&content).or_failed(self, LABEL)?,
                delay,
                sticky_duration_ms: None,
            };
            return delayed_events::send(&client, support, event)
                .await
                .or_failed(self, LABEL);
        }
        if let Some(duration) = sticky_duration_ms {
            if self.room_is_encrypted(&room).await? {
                return Err(RpcCode::EncryptedScheduleUnsupported.into());
            }
            return sticky::send_delayed_event(
                &client, support, &room, event_type, content, delay, duration,
            )
            .await
            .or_failed(self, LABEL);
        }
        if self.room_is_encrypted(&room).await? {
            return Err(RpcCode::EncryptedScheduleUnsupported.into());
        }
        let event = DelayedEvent {
            room_id: room_id.clone(),
            event_type: event_type.to_owned(),
            state_key: None,
            content: serde_json::value::to_raw_value(&content).or_failed(self, LABEL)?,
            delay,
            sticky_duration_ms: None,
        };
        delayed_events::send(&client, support, event)
            .await
            .or_failed(self, LABEL)
    }

    pub(crate) async fn widget_send_sticky_event(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
        content: Value,
        sticky_duration_ms: u32,
    ) -> Result<OwnedEventId, RpcError> {
        let response = self
            .room(room_id)
            .await?
            .send_raw(event_type, content)
            .with_sticky_duration(Duration::from_millis(u64::from(sticky_duration_ms)))
            .await
            .or_failed(self, "widget_send_sticky_event")?;
        Ok(response.response.event_id)
    }

    pub(crate) async fn restart_delayed_event(
        &self,
        RestartDelayedEventParams { delay_id }: RestartDelayedEventParams,
    ) -> Result<(), RpcError> {
        delayed_events::update(&self.client().await?, delay_id, UpdateAction::Restart)
            .await
            .or_failed(self, "restart_delayed_event")?;
        Ok(())
    }

    pub(crate) async fn widget_send_to_device(
        &self,
        event_type: &str,
        encrypted: bool,
        messages: Value,
    ) -> Result<(), RpcError> {
        const LABEL: &str = "widget_send_to_device";
        if is_internal_to_device_type(event_type) {
            tracing::warn!(
                event_type,
                "a widget tried to send an internal to-device message"
            );
            return Ok(());
        }
        let messages: BTreeMap<OwnedUserId, BTreeMap<DeviceIdOrAllDevices, Value>> =
            serde_json::from_value(messages).or_failed(self, LABEL)?;
        let client = self.client().await?;

        if !encrypted {
            let mut wire = BTreeMap::new();
            for (user_id, devices) in messages {
                let mut per_device = BTreeMap::new();
                for (device, content) in devices {
                    per_device.insert(
                        device,
                        Raw::new(&content).or_failed(self, LABEL)?.cast_unchecked(),
                    );
                }
                wire.insert(user_id, per_device);
            }
            client
                .send(send_event_to_device::v3::Request::new_raw(
                    ToDeviceEventType::from(event_type),
                    TransactionId::new(),
                    wire,
                ))
                .await
                .or_failed(self, LABEL)?;
            return Ok(());
        }

        let encryption = client.encryption();
        let mut by_content: BTreeMap<String, Vec<matrix_sdk::encryption::identities::Device>> =
            BTreeMap::new();
        for (user_id, devices) in messages {
            for (device, content) in devices {
                let targets: Vec<_> = match device {
                    DeviceIdOrAllDevices::DeviceId(device_id) => encryption
                        .get_device(&user_id, &device_id)
                        .await
                        .or_failed(self, LABEL)?
                        .into_iter()
                        .collect(),
                    DeviceIdOrAllDevices::AllDevices => encryption
                        .get_user_devices(&user_id)
                        .await
                        .or_failed(self, LABEL)?
                        .devices()
                        .collect(),
                };
                by_content
                    .entry(content.to_string())
                    .or_default()
                    .extend(targets);
            }
        }

        for (content, devices) in by_content {
            if devices.is_empty() {
                continue;
            }
            let raw = Raw::from_json_string(content).or_failed(self, LABEL)?;
            let failures = encryption
                .encrypt_and_send_raw_to_device(
                    devices.iter().collect(),
                    event_type,
                    raw,
                    CollectStrategy::AllDevices,
                )
                .await
                .or_failed(self, LABEL)?;
            if !failures.is_empty() {
                tracing::warn!(
                    count = failures.len(),
                    "some devices did not receive a widget's to-device message"
                );
            }
        }
        Ok(())
    }

    pub(crate) async fn room_account_data_raw(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
    ) -> Result<Option<Value>, RpcError> {
        let room = self.room(room_id).await?;
        let event = self
            .with_open_stores(async || room.account_data(event_type.into()).await)
            .await
            .or_failed(self, "room_account_data_raw")?;
        Ok(event.and_then(|raw| {
            let mut json: Value = serde_json::from_str(raw.json().get()).ok()?;
            json.as_object_mut()?
                .insert("room_id".to_owned(), Value::String(room_id.to_string()));
            Some(json)
        }))
    }

    pub(crate) async fn room_sticky_events(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<Vec<Value>, RpcError> {
        let room = self.room(room_id).await?;
        Ok(sticky::live_events(&room)
            .into_iter()
            .map(|event| with_room_id(event.into_value(), room_id))
            .collect())
    }

    pub(crate) async fn room_event_relations(
        &self,
        room_id: &OwnedRoomId,
        event_id: &OwnedEventId,
        filter: RelationsFilter<'_>,
    ) -> Result<RelationsView, RpcError> {
        const LABEL: &str = "room_event_relations";
        let room = self.room(room_id).await?;
        let client = room.client();
        let limit = filter.limit.map(UInt::from);
        let dir = match filter.direction {
            Some(PaginationDirection::Forward) => Direction::Forward,
            _ => Direction::Backward,
        };
        let from = filter.from.map(str::to_owned);
        let to = filter.to.map(str::to_owned);

        let (chunk, next_batch, prev_batch) = if let Some(rel_type) = filter.rel_type {
            let mut request = get_relating_events_with_rel_type::v1::Request::new(
                room_id.clone(),
                event_id.clone(),
                RelationType::from(rel_type),
            );
            request.from = from;
            request.to = to;
            request.limit = limit;
            request.dir = dir;
            let response = client.send(request).await.or_failed(self, LABEL)?;
            (response.chunk, response.next_batch, response.prev_batch)
        } else {
            let mut request =
                get_relating_events::v1::Request::new(room_id.clone(), event_id.clone());
            request.from = from;
            request.to = to;
            request.limit = limit;
            request.dir = dir;
            let response = client.send(request).await.or_failed(self, LABEL)?;
            (response.chunk, response.next_batch, response.prev_batch)
        };

        let mut events = Vec::with_capacity(chunk.len());
        for raw in chunk {
            let raw = raw.cast::<AnyTimelineEvent>();
            let decrypted = if raw.get_field::<String>("type").ok().flatten().as_deref()
                == Some("m.room.encrypted")
            {
                room.decrypt_event(raw.cast_ref_unchecked(), None)
                    .await
                    .ok()
                    .filter(|event| event.encryption_info().is_some())
                    .and_then(|event| serde_json::from_str::<Value>(event.raw().json().get()).ok())
            } else {
                None
            };
            let Some(json) =
                decrypted.or_else(|| serde_json::from_str::<Value>(raw.json().get()).ok())
            else {
                continue;
            };
            if filter
                .event_type
                .is_some_and(|wanted| json.get("type").and_then(Value::as_str) != Some(wanted))
            {
                continue;
            }
            events.push(with_room_id(json, room_id));
        }

        Ok(RelationsView {
            chunk: events,
            next_batch,
            prev_batch,
        })
    }

    pub(crate) async fn turn_server(&self) -> Result<TurnServerView, RpcError> {
        let response = match self
            .client()
            .await?
            .send(get_turn_server_info::v3::Request::new())
            .await
        {
            Ok(response) => response,
            // A homeserver without TURN answers `{}`, which has no `username`.
            Err(matrix_sdk::HttpError::Api(error))
                if matches!(*error, FromHttpResponseError::Deserialization(_)) =>
            {
                tracing::debug!("the homeserver has no TURN server");
                return Ok(TurnServerView {
                    username: String::new(),
                    password: String::new(),
                    uris: Vec::new(),
                    ttl_ms: 0,
                });
            }
            Err(error) => return Err(self.rpc_error("turn_server", &error)),
        };
        Ok(TurnServerView {
            username: response.username,
            password: response.password,
            uris: response.uris,
            ttl_ms: u64::try_from(response.ttl.as_millis()).unwrap_or(u64::MAX),
        })
    }

    pub(crate) async fn rtc_transports(&self) -> Result<Value, RpcError> {
        let transports = self
            .client()
            .await?
            .discover_rtc_transports()
            .await
            .or_failed(self, "rtc_transports")?
            .unwrap_or_default();
        serde_json::to_value(transports)
            .map(|transports| serde_json::json!({ "rtc_transports": transports }))
            .or_failed(self, "rtc_transports")
    }

    pub(crate) async fn rtc_livekit(
        &self,
        endpoint: RtcLivekitEndpoint,
        body: &Value,
    ) -> Result<Value, RpcError> {
        const LABEL: &str = "rtc_livekit";
        let client = self.client().await?;
        let content_type = "application/json".to_owned();
        let body = serde_json::to_vec(body).or_failed(self, LABEL)?;
        let response = match endpoint {
            RtcLivekitEndpoint::GetToken => client
                .send(livekit_get_token::Request { content_type, body })
                .await
                .map(|response| response.body),
            RtcLivekitEndpoint::DelegateDelayedLeave => client
                .send(livekit_delegate_delayed_leave::Request { content_type, body })
                .await
                .map(|response| response.body),
        }
        .or_failed(self, LABEL)?;
        serde_json::from_slice(&response).or_failed(self, LABEL)
    }

    pub(crate) async fn integration_manager_url(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<String, RpcError> {
        const LABEL: &str = "integration_manager_url";
        let manager = self.integration_manager(LABEL).await?;

        let scalar_token = self.scalar_token(&manager.api_url).await;
        integration_manager_page(&manager.ui_url, scalar_token.as_deref(), room_id)
            .ok_or_else(|| self.failed(LABEL, "the integration manager URL is invalid"))
    }

    /// The account's `/.well-known/matrix/client`, looked up on its server
    /// name first because the homeserver URL it delegates to rarely serves it.
    pub(crate) async fn well_known(&self) -> Result<Option<Value>, RpcError> {
        let client = self.client().await?;
        let named = client
            .user_id()
            .and_then(|user| url::Url::parse(&format!("https://{}", user.server_name())).ok());
        let advertised = url::Url::parse(client.homeserver().as_str()).ok();
        for base in named.into_iter().chain(advertised) {
            if let Some(well_known) = fetch_well_known(&client, &base).await {
                return Ok(Some(well_known));
            }
        }
        Ok(None)
    }

    async fn integration_manager(&self, label: &str) -> Result<IntegrationManager, RpcError> {
        let client = self.client().await?;

        let mut managers = Vec::new();
        if let Ok(base) = url::Url::parse(client.homeserver().as_str())
            && let Some(well_known) = fetch_well_known(&client, &base).await
        {
            managers = managers_from_well_known(&well_known);
        }
        if let Some(widgets) = self
            .global_account_data(GlobalAccountDataEventType::from("m.widgets"), label)
            .await?
            .and_then(|raw| serde_json::from_str::<Value>(raw.json().get()).ok())
        {
            managers_from_account_data(&widgets, &mut managers);
        }
        Ok(managers
            .into_iter()
            .next()
            .unwrap_or_else(|| IntegrationManager {
                api_url: DEFAULT_INTEGRATION_MANAGER.0.to_owned(),
                ui_url: DEFAULT_INTEGRATION_MANAGER.1.to_owned(),
            }))
    }

    pub(crate) async fn integration_manager_terms(&self) -> Result<Vec<TermsPolicyView>, RpcError> {
        const LABEL: &str = "integration_manager_terms";
        let manager = self.integration_manager(LABEL).await?;
        let response = self
            .client()
            .await?
            .http_client()
            .get(terms_url(&manager.api_url))
            .send()
            .await
            .or_failed(self, LABEL)?;
        if !response.status().is_success() {
            return Ok(Vec::new());
        }
        let terms: Value = serde_json::from_str(&response.text().await.or_failed(self, LABEL)?)
            .or_failed(self, LABEL)?;

        let accepted = self.accepted_terms(LABEL).await?;
        let pending = pending_policies(&terms, &accepted);
        if pending.is_empty() && self.terms_unsigned(&manager.api_url).await {
            let urls = pending_policies(&terms, &[])
                .into_iter()
                .map(|policy| policy.url)
                .collect();
            self.accept_integration_manager_terms(urls).await?;
        }
        Ok(pending)
    }

    async fn terms_unsigned(&self, api_url: &str) -> bool {
        let Some(token) = self.scalar_token(api_url).await else {
            return false;
        };
        let Ok(client) = self.client().await else {
            return false;
        };
        let Ok(mut url) = url::Url::parse(&format!("{}/account", api_url.trim_end_matches('/')))
        else {
            return false;
        };
        url.query_pairs_mut().append_pair("scalar_token", &token);
        let Ok(response) = client.http_client().get(url).send().await else {
            return false;
        };
        response.status() == reqwest::StatusCode::FORBIDDEN
            && response
                .text()
                .await
                .is_ok_and(|text| text.contains("M_TERMS_NOT_SIGNED"))
    }

    pub(crate) async fn accept_integration_manager_terms(
        &self,
        urls: Vec<String>,
    ) -> Result<(), RpcError> {
        const LABEL: &str = "accept_integration_manager_terms";
        let manager = self.integration_manager(LABEL).await?;
        let token = self
            .scalar_token(&manager.api_url)
            .await
            .ok_or_else(|| self.failed(LABEL, "the integration manager did not issue a token"))?;

        self.client()
            .await?
            .http_client()
            .post(terms_url(&manager.api_url))
            .bearer_auth(token)
            .header("Content-Type", "application/json")
            .body(serde_json::json!({ "user_accepts": urls }).to_string())
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .or_failed(self, LABEL)?;

        let mut accepted = self.accepted_terms(LABEL).await?;
        for url in urls {
            if !accepted.contains(&url) {
                accepted.push(url);
            }
        }
        self.put_global_account_data(
            GlobalAccountDataEventType::from("m.accepted_terms"),
            &serde_json::json!({ "accepted": accepted }),
            LABEL,
        )
        .await
    }

    async fn accepted_terms(&self, label: &str) -> Result<Vec<String>, RpcError> {
        Ok(self
            .global_account_data(GlobalAccountDataEventType::from("m.accepted_terms"), label)
            .await?
            .and_then(|raw| serde_json::from_str::<Value>(raw.json().get()).ok())
            .and_then(|content| {
                content.get("accepted")?.as_array().map(|urls| {
                    urls.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
            })
            .unwrap_or_default())
    }

    async fn scalar_token(&self, api_url: &str) -> Option<String> {
        let token = self.openid_token().await.ok()?;
        let response = self
            .client()
            .await
            .ok()?
            .http_client()
            .post(format!("{}/register", api_url.trim_end_matches('/')))
            .header("Content-Type", "application/json")
            .body(
                serde_json::to_string(&ScalarRegisterOut {
                    access_token: token.access_token,
                    token_type: token.token_type,
                    matrix_server_name: token.matrix_server_name,
                    expires_in: token.expires_in_ms / 1000,
                })
                .ok()?,
            )
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        serde_json::from_str::<Value>(&response.text().await.ok()?)
            .ok()?
            .get("scalar_token")?
            .as_str()
            .map(str::to_owned)
    }

    pub(crate) async fn known_room_ids(&self) -> Result<Vec<OwnedRoomId>, RpcError> {
        Ok(self
            .client()
            .await?
            .rooms()
            .into_iter()
            .filter(|room| matches!(room.state(), RoomState::Joined | RoomState::Invited))
            .map(|room| room.room_id().to_owned())
            .collect())
    }

    pub(crate) fn set_widget_feed(&self, enabled: bool) {
        self.widget_feed.store(enabled, Ordering::Relaxed);
    }

    pub(crate) fn watch_room_widgets(
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
                    if matches!(kind.as_deref(), Some(WIDGET_STATE_TYPE | "m.widget")) {
                        core.emit_if_current(
                            generation,
                            CoreEvent::RoomWidgetsChanged {
                                room_id: room.room_id().to_owned(),
                            },
                        );
                    }
                }
            }
        });
        self.track_session_handler(client, handle);
    }

    pub(crate) fn watch_widget_feed(
        self: &Arc<Self>,
        client: &matrix_sdk::Client,
        generation: u64,
    ) {
        let handle = client.add_event_handler({
            let core = self.clone();
            move |raw: Raw<AnySyncTimelineEvent>, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    if !core.widget_feed.load(Ordering::Relaxed) {
                        return;
                    }
                    let Ok(event) = serde_json::from_str::<Value>(raw.json().get()) else {
                        return;
                    };
                    if event.get("type").and_then(Value::as_str) == Some("m.room.encrypted") {
                        return;
                    }
                    core.emit_if_current(
                        generation,
                        CoreEvent::WidgetRoomEvent {
                            event: with_room_id(event, room.room_id()),
                        },
                    );
                }
            }
        });
        self.track_session_handler(client, handle);

        let core = self.clone();
        let messages = client.subscribe_to_custom_to_device_messages(Vec::new());
        self.track_session_task(
            spawn(async move {
                pin_mut!(messages);
                while let Some(message) = messages.next().await {
                    if !core.widget_feed.load(Ordering::Relaxed) {
                        continue;
                    }
                    let Ok(event) = serde_json::from_str::<Value>(message.raw.json().get()) else {
                        continue;
                    };
                    core.emit_if_current(
                        generation,
                        CoreEvent::WidgetToDevice {
                            event,
                            encrypted: message.encryption_info.is_some(),
                        },
                    );
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn openid_token(&self) -> Result<OpenIdTokenView, RpcError> {
        let client = self.client().await?;
        let user_id = client.user_id().ok_or(RpcCode::NotLoggedIn)?.to_owned();

        let response = client
            .send(request_openid_token::v3::Request::new(user_id))
            .await
            .or_failed(self, "openid_token")?;

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
    use super::{RelationsFilter, managers_from_account_data, managers_from_well_known};
    use crate::{
        Core,
        api::calls::RtcLivekitEndpoint,
        api::room_state::SendEventParams,
        protocol::{CoreEvent, RpcCode, RpcError},
        session::Session,
        store::MemorySessionStore,
    };
    use matrix_sdk::{ruma::room_id, test_utils::mocks::MatrixMockServer};
    use matrix_sdk_test::JoinedRoomBuilder;
    use matrix_sdk_ui::sync_service::SyncService;
    use serde_json::json;
    use std::{sync::Arc, time::Duration};
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{body_json, header, method, path, path_regex, query_param},
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
        let sent = Box::pin(core.run(crate::api::messages::SendRawEventParams {
            persona: None,
            room_id: room_id.to_owned(),
            event_type: "com.example.message".to_owned(),
            content: json!({}),
        }))
        .await
        .unwrap();
        assert_eq!(sent, "$created");
        let redaction = Box::pin(core.run(crate::api::messages::SendRedactionParams {
            room_id: room_id.to_owned(),
            event_id: "$target".try_into().unwrap(),
            reason: None,
        }))
        .await
        .unwrap();
        assert_eq!(redaction, "$created");
        let event_id = core
            .run(SendEventParams {
                room_id: room_id.to_owned(),
                event_type: "com.example.state".to_owned(),
                state_key: String::new(),
                content: json!({}),
            })
            .await
            .unwrap();
        assert_eq!(event_id, "$created");
    }

    async fn core_with(server: &MatrixMockServer, client: matrix_sdk::Client) -> Arc<Core> {
        crate::test_support::signed_in_core(server, client).await.0
    }

    async fn delayed_events_server() -> (MatrixMockServer, matrix_sdk::Client) {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().no_server_versions().build().await;
        Mock::given(method("GET"))
            .and(path("/_matrix/client/versions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"versions": ["v1.13"], "unstable_features": {"org.matrix.msc4140": true}}),
            ))
            .mount(server.server())
            .await;
        (server, client)
    }

    #[tokio::test]
    async fn a_stable_only_server_offers_no_user_scheduling_because_it_cannot_list() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().no_server_versions().build().await;
        Mock::given(method("GET"))
            .and(path("/_matrix/client/versions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "versions": ["v1.13"],
                "unstable_features": {"org.matrix.msc4140.stable": true}
            })))
            .mount(server.server())
            .await;
        let room_id = room_id!("!stable:example.org");
        server.sync_joined_room(&client, room_id).await;
        let core = core_with(&server, client).await;

        assert!(!core.scheduling_supported().await.unwrap());
        assert!(matches!(
            core.schedule_message(
                &room_id.to_owned(),
                matrix_sdk::ruma::events::room::message::RoomMessageEventContent::text_plain(
                    "later"
                ),
                5000,
                None,
            )
            .await,
            Err(RpcError {
                code: RpcCode::DelayedEventsUnsupported,
                ..
            })
        ));
        assert!(core.delayed_events_support().await.unwrap().any());
    }

    #[tokio::test]
    async fn a_delayed_state_event_carries_the_delay() {
        let (server, client) = delayed_events_server().await;
        let room_id = room_id!("!delayed:example.org");
        server.sync_joined_room(&client, room_id).await;
        Mock::given(method("PUT"))
            .and(path_regex(
                "/_matrix/client/v3/rooms/.*/state/com.example.state/key",
            ))
            .and(query_param("org.matrix.msc4140.delay", "5000"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"delay_id": "d1"})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        let delay_id = core
            .widget_send_delayed_event(
                &room_id.to_owned(),
                "com.example.state",
                Some("key".to_owned()),
                json!({"a": 1}),
                5000,
                None,
            )
            .await
            .unwrap();

        assert_eq!(delay_id, "d1");
    }

    #[tokio::test]
    async fn encrypted_delayed_events_are_rejected() {
        let (server, client) = delayed_events_server().await;
        let room_id = room_id!("!sticky:example.org");
        server.sync_joined_room(&client, room_id).await;
        server
            .mock_room_state_encryption()
            .encrypted()
            .mount()
            .await;
        let core = core_with(&server, client).await;

        let refused = core
            .widget_send_delayed_event(
                &room_id.to_owned(),
                "org.matrix.msc4143.rtc.member",
                None,
                json!({}),
                5000,
                Some(60_000),
            )
            .await;
        assert!(matches!(
            refused,
            Err(RpcError {
                code: RpcCode::EncryptedScheduleUnsupported,
                ..
            })
        ));

        let refused = core
            .widget_send_delayed_event(
                &room_id.to_owned(),
                "com.example.secret",
                None,
                json!({}),
                5000,
                Some(60_000),
            )
            .await;
        assert!(matches!(
            refused,
            Err(RpcError {
                code: RpcCode::EncryptedScheduleUnsupported,
                ..
            })
        ));
        let refused = core
            .widget_send_delayed_event(
                &room_id.to_owned(),
                "com.example.secret",
                None,
                json!({}),
                5000,
                None,
            )
            .await;
        assert!(matches!(
            refused,
            Err(RpcError {
                code: RpcCode::EncryptedScheduleUnsupported,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn a_sticky_event_carries_its_duration() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!sticky:example.org");
        server.sync_joined_room(&client, room_id).await;
        server.mock_room_state_encryption().plain().mount().await;
        Mock::given(method("PUT"))
            .and(path_regex(
                "/_matrix/client/v3/rooms/.*/send/com.example.sticky/.*",
            ))
            .and(query_param(
                "org.matrix.msc4354.sticky_duration_ms",
                "30000",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"event_id": "$sticky"})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        let sent = core
            .widget_send_sticky_event(&room_id.to_owned(), "com.example.sticky", json!({}), 30_000)
            .await
            .unwrap();

        assert_eq!(sent, "$sticky");
    }

    #[tokio::test]
    async fn restarting_a_delayed_event_posts_the_restart_action() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("POST"))
            .and(path_regex(
                "/_matrix/client/unstable/org.matrix.msc4140/delayed_events/d3",
            ))
            .and(body_json(json!({"action": "restart"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        core.restart_delayed_event(crate::api::widgets::RestartDelayedEventParams {
            delay_id: "d3".to_owned(),
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn relations_come_back_with_their_room_id_and_the_event_type_filter() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!relations:example.org");
        server.sync_joined_room(&client, room_id).await;
        Mock::given(method("GET"))
            .and(path_regex(
                "/_matrix/client/v1/rooms/.*/relations/.*/m.thread",
            ))
            .and(query_param("limit", "5"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "chunk": [
                    {"type": "m.room.message", "event_id": "$a", "content": {}},
                    {"type": "m.reaction", "event_id": "$b", "content": {}},
                ],
                "next_batch": "next"
            })))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        let relations = core
            .room_event_relations(
                &room_id.to_owned(),
                &"$parent".try_into().unwrap(),
                RelationsFilter {
                    rel_type: Some("m.thread"),
                    event_type: Some("m.room.message"),
                    from: None,
                    to: None,
                    limit: Some(5),
                    direction: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(relations.chunk.len(), 1);
        assert_eq!(relations.chunk[0]["event_id"], "$a");
        assert_eq!(relations.chunk[0]["room_id"], room_id.as_str());
        assert_eq!(relations.next_batch.as_deref(), Some("next"));
        assert!(relations.prev_batch.is_none());
    }

    #[tokio::test]
    async fn turn_credentials_report_their_lifetime_in_milliseconds() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("GET"))
            .and(path("/_matrix/client/v3/voip/turnServer"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "username": "u", "password": "p", "uris": ["turn:example.org"], "ttl": 86400
            })))
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        let server = core.turn_server().await.unwrap();

        assert_eq!(server.username, "u");
        assert_eq!(server.uris, ["turn:example.org"]);
        assert_eq!(server.ttl_ms, 86_400_000);
    }

    #[tokio::test]
    async fn a_homeserver_without_turn_has_no_servers() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("GET"))
            .and(path("/_matrix/client/v3/voip/turnServer"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        let server = core.turn_server().await.unwrap();

        assert_eq!(server.uris, Vec::<String>::new());
    }

    #[tokio::test]
    async fn rtc_transports_are_relayed_as_the_homeserver_describes_them() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("GET"))
            .and(path("/_matrix/client/unstable/org.matrix.msc4143/rtc/transports"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "rtc_transports": [{"type": "livekit", "livekit_service_url": "https://sfu.example.org"}]
            })))
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        assert_eq!(
            core.rtc_transports().await.unwrap(),
            json!({"rtc_transports": [{"type": "livekit", "livekit_service_url": "https://sfu.example.org"}]})
        );
    }

    #[tokio::test]
    async fn the_livekit_requests_carry_the_widget_body_verbatim() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let request =
            json!({"room_id": "!r:example.org", "slot_id": "m.call#ROOM", "extra": [1, 2]});
        Mock::given(method("POST"))
            .and(path(
                "/_matrix/client/unstable/io.element.msc4195/rtc/livekit/get_token",
            ))
            .and(body_json(request.clone()))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"jwt": "token"})))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path(
                "/_matrix/client/unstable/io.element.msc4195/rtc/livekit/delegate_delayed_leave",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        assert_eq!(
            core.rtc_livekit(RtcLivekitEndpoint::GetToken, &request)
                .await
                .unwrap(),
            json!({"jwt": "token"})
        );
        assert_eq!(
            core.rtc_livekit(RtcLivekitEndpoint::DelegateDelayedLeave, &json!({}))
                .await
                .unwrap(),
            json!({})
        );
    }

    #[tokio::test]
    async fn a_missing_livekit_endpoint_reads_as_unsupported() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(404).set_body_json(
                json!({"errcode": "M_UNRECOGNIZED", "error": "Unrecognized request"}),
            ))
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        let result = core
            .rtc_livekit(RtcLivekitEndpoint::GetToken, &json!({}))
            .await;

        assert!(matches!(
            result,
            Err(RpcError {
                code: RpcCode::Unsupported,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn a_clear_to_device_message_goes_out_in_one_request_and_internal_types_are_dropped() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        Mock::given(method("PUT"))
            .and(path_regex(
                "/_matrix/client/v3/sendToDevice/com.example.ping/.*",
            ))
            .and(body_json(
                json!({"messages": {"@a:example.org": {"*": {"n": 1}}}}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        core.widget_send_to_device(
            "com.example.ping",
            false,
            json!({"@a:example.org": {"*": {"n": 1}}}),
        )
        .await
        .unwrap();

        core.widget_send_to_device(
            "m.room_key_request",
            false,
            json!({"@a:example.org": {"*": {}}}),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn an_encrypted_to_device_message_to_an_unknown_device_sends_nothing() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let core = core_with(&server, client).await;

        core.widget_send_to_device(
            "com.example.ping",
            true,
            json!({"@a:example.org": {"DEVICE": {"n": 1}}}),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn sticky_reads_come_from_the_sdk_sticky_map() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!stickyread:example.org");
        server.sync_joined_room(&client, room_id).await;
        let now = crate::now_ms();
        let mut response = ruma::api::client::sync::sync_events::v5::Response::new("1".to_owned());
        let mut sticky_room =
            ruma::api::client::sync::sync_events::v5::response::StickyEventsRoom::default();
        sticky_room.events.push(
            matrix_sdk::ruma::serde::Raw::new(&json!({
                "type": "com.example.presence", "event_id": "$sticky", "sender": "@a:example.org",
                "origin_server_ts": now, "msc4354_sticky": {"duration_ms": 600_000},
                "content": {"msc4354_sticky_key": "slot", "status": "here"}
            }))
            .unwrap()
            .cast_unchecked(),
        );
        response
            .extensions
            .sticky_events
            .rooms
            .insert(room_id.to_owned(), sticky_room);
        client
            .process_sliding_sync_test_helper(
                &response,
                &matrix_sdk_base::RequestedRequiredStates::default(),
            )
            .await
            .unwrap();
        let core = core_with(&server, client).await;

        let events = core.room_sticky_events(&room_id.to_owned()).await.unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["event_id"], "$sticky");
        assert_eq!(events[0]["room_id"], room_id.as_str());
    }

    #[tokio::test]
    async fn the_feed_forwards_synced_events_only_while_it_is_on() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let (core, mut events) = Core::new("widgets", Box::new(MemorySessionStore::default()));
        core.watch_widget_feed(&client, 1);
        let room_id = room_id!("!feed:example.org");
        let event = |id: &str| {
            matrix_sdk::ruma::serde::Raw::new(&json!({
                "type": "com.example.thing", "event_id": id, "sender": "@a:example.org",
                "origin_server_ts": 1, "content": {}
            }))
            .unwrap()
            .cast_unchecked::<matrix_sdk::ruma::events::AnySyncTimelineEvent>()
        };

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_timeline_event(event("$off")),
            )
            .await;
        tokio::time::timeout(Duration::from_millis(200), events.recv())
            .await
            .unwrap_err();

        core.set_widget_feed(true);
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_timeline_event(event("$on")),
            )
            .await;
        let forwarded = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(CoreEvent::WidgetRoomEvent { event }) = events.recv().await {
                    break event;
                }
            }
        })
        .await
        .expect("a forwarded event");
        assert_eq!(forwarded["event_id"], "$on");
        assert_eq!(forwarded["room_id"], room_id.as_str());
    }

    #[tokio::test]
    async fn a_widget_state_change_tells_the_room_to_reload_its_widgets() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let (core, mut events) = Core::new("widgets", Box::new(MemorySessionStore::default()));
        core.watch_room_widgets(&client, 1);
        let room_id = room_id!("!widgetstate:example.org");

        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_state_event(
                    matrix_sdk::ruma::serde::Raw::new(&json!({
                        "type": "im.vector.modular.widgets", "state_key": "doom",
                        "event_id": "$widget", "sender": "@a:example.org", "origin_server_ts": 1,
                        "content": {"type": "m.custom", "url": "https://doom.example/", "name": "Doom"}
                    }))
                    .unwrap()
                    .cast_unchecked(),
                ),
            )
            .await;

        let changed = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(CoreEvent::RoomWidgetsChanged { room_id }) = events.recv().await {
                    break room_id;
                }
            }
        })
        .await
        .expect("a widgets change");
        assert_eq!(changed, room_id);
    }

    #[tokio::test]
    async fn the_integration_manager_page_carries_a_scalar_token_from_the_openid_exchange() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let uri = server.server().uri();
        Mock::given(method("GET"))
            .and(path("/.well-known/matrix/client"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "m.integrations": {"managers": [
                    {"api_url": format!("{uri}/scalar/api"), "ui_url": format!("{uri}/scalar")}
                ]}
            })))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path_regex(
                "/_matrix/client/v3/user/.*/account_data/m.widgets",
            ))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "Not found"})),
            )
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path_regex(
                "/_matrix/client/v3/user/.*/openid/request_token",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "openid", "token_type": "Bearer",
                "matrix_server_name": "example.org", "expires_in": 3600
            })))
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/scalar/api/register"))
            .and(body_json(json!({
                "access_token": "openid", "token_type": "Bearer",
                "matrix_server_name": "example.org", "expires_in": 3600
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"scalar_token": "s3"})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        let url = core
            .integration_manager_url(&room_id!("!room:example.org").to_owned())
            .await
            .unwrap();

        assert_eq!(
            url,
            format!("{uri}/index.html?scalar_token=s3&room_id=%21room%3Aexample.org")
        );
    }

    #[test]
    fn pending_policies_skip_accepted_urls_and_prefer_english() {
        let terms = json!({"policies": {
            "privacy": {
                "version": "1",
                "en": {"name": "Privacy", "url": "https://im/privacy-en"},
                "fr": {"name": "Confidentialité", "url": "https://im/privacy-fr"}
            },
            "tos": {"version": "2", "fr": {"name": "Conditions", "url": "https://im/tos-fr"}},
            "old": {"version": "1", "en": {"name": "Old", "url": "https://im/old"}}
        }});

        let pending = super::pending_policies(&terms, &["https://im/old".to_owned()]);

        let mut urls: Vec<_> = pending.iter().map(|policy| policy.url.as_str()).collect();
        urls.sort_unstable();
        assert_eq!(urls, ["https://im/privacy-en", "https://im/tos-fr"]);
        assert!(pending.iter().any(|policy| policy.name == "Privacy"));
    }

    #[tokio::test]
    async fn accepting_integration_manager_terms_signs_with_the_scalar_token_and_remembers_it() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let uri = server.server().uri();
        Mock::given(method("GET"))
            .and(path("/.well-known/matrix/client"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "m.integrations": {"managers": [
                    {"api_url": format!("{uri}/scalar/api"), "ui_url": format!("{uri}/scalar")}
                ]}
            })))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path_regex(
                "/_matrix/client/v3/user/.*/account_data/m.(widgets|accepted_terms)",
            ))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "Not found"})),
            )
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path_regex(
                "/_matrix/client/v3/user/.*/openid/request_token",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "openid", "token_type": "Bearer",
                "matrix_server_name": "example.org", "expires_in": 3600
            })))
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/scalar/api/register"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"scalar_token": "s3"})))
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/scalar/api/_matrix/integrations/v1/terms"))
            .and(header("Authorization", "Bearer s3"))
            .and(body_json(json!({"user_accepts": ["https://im/tos"]})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(
                "/_matrix/client/v3/user/.*/account_data/m.accepted_terms",
            ))
            .and(body_json(json!({"accepted": ["https://im/tos"]})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        core.accept_integration_manager_terms(vec!["https://im/tos".to_owned()])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn terms_the_account_lists_are_signed_with_a_manager_that_never_saw_them() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let uri = server.server().uri();
        Mock::given(method("GET"))
            .and(path("/.well-known/matrix/client"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "m.integrations": {"managers": [
                    {"api_url": format!("{uri}/scalar/api"), "ui_url": format!("{uri}/scalar")}
                ]}
            })))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path_regex(
                "/_matrix/client/v3/user/.*/account_data/m.widgets",
            ))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "Not found"})),
            )
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path_regex(
                "/_matrix/client/v3/user/.*/account_data/m.accepted_terms",
            ))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"accepted": ["https://im/tos"]})),
            )
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path_regex(
                "/_matrix/client/v3/user/.*/openid/request_token",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "access_token": "openid", "token_type": "Bearer",
                "matrix_server_name": "example.org", "expires_in": 3600
            })))
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/scalar/api/register"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"scalar_token": "s3"})))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path("/scalar/api/_matrix/integrations/v1/terms"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"policies": {
                    "tos": {"version": "1", "en": {"name": "Terms", "url": "https://im/tos"}}
                }})),
            )
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path("/scalar/api/account"))
            .and(query_param("scalar_token", "s3"))
            .respond_with(ResponseTemplate::new(403).set_body_json(json!({
                "errcode": "M_TERMS_NOT_SIGNED", "error": "Terms not signed"
            })))
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/scalar/api/_matrix/integrations/v1/terms"))
            .and(body_json(json!({"user_accepts": ["https://im/tos"]})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(
                "/_matrix/client/v3/user/.*/account_data/m.accepted_terms",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .mount(server.server())
            .await;
        let core = core_with(&server, client).await;

        let pending = core.integration_manager_terms().await.unwrap();

        assert_eq!(pending, Vec::new());
    }

    #[test]
    fn integration_managers_come_from_well_known_then_account_data_without_duplicates() {
        let mut managers = super::managers_from_well_known(&json!({
            "m.integrations": {"managers": [
                {"api_url": "https://a/api", "ui_url": "https://a"},
                {"api_url": "https://broken"}
            ]}
        }));
        super::managers_from_account_data(
            &json!({
                "one": {"type": "m.integration_manager", "url": "https://a"},
                "two": {"type": "m.integration_manager", "url": "https://b", "data": {"api_url": "https://b/api"}},
                "three": {"type": "m.custom", "url": "https://c"}
            }),
            &mut managers,
        );

        let urls: Vec<_> = managers
            .iter()
            .map(|manager| (manager.ui_url.as_str(), manager.api_url.as_str()))
            .collect();
        assert_eq!(
            urls,
            [
                ("https://a", "https://a/api"),
                ("https://b", "https://b/api")
            ]
        );
    }

    #[tokio::test]
    async fn known_rooms_are_the_joined_ones() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!known:example.org");
        server.sync_joined_room(&client, room_id).await;
        let core = core_with(&server, client).await;

        assert_eq!(core.known_room_ids().await.unwrap(), [room_id.to_owned()]);
    }

    #[test]
    fn well_known_managers_skip_malformed_entries() {
        let managers = managers_from_well_known(&json!({ "m.integrations": { "managers": [
            { "api_url": "https://a/api", "ui_url": "https://a/ui" },
            { "api_url": "https://b/api" },
            "junk",
            { "api_url": 1, "ui_url": "https://c" },
        ] } }));
        assert_eq!(managers.len(), 1);
        assert_eq!(managers[0].ui_url, "https://a/ui");
        assert!(managers_from_well_known(&json!({ "m.integrations": ["x"] })).is_empty());
    }

    #[test]
    fn account_data_managers_fall_back_to_the_widget_url() {
        let mut known = Vec::new();
        managers_from_account_data(
            &json!({
                "a": { "type": "m.integration_manager", "url": "https://a/ui",
                       "data": { "api_url": "https://a/api" } },
                "b": { "type": "m.integration_manager", "url": "https://b/ui", "data": 5 },
                "c": { "type": "other", "url": "https://c" },
                "d": "junk",
            }),
            &mut known,
        );
        let pairs: Vec<_> = known.iter().map(|m| (&*m.api_url, &*m.ui_url)).collect();
        assert_eq!(
            pairs,
            [
                ("https://a/api", "https://a/ui"),
                ("https://b/ui", "https://b/ui")
            ]
        );
    }
}
