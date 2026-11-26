use sable_model::text::visible_name;

use crate::api::calls::RtcLivekitEndpoint;
use crate::api::widgets::RestartDelayedEventParams;
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::tasks::JoinHandleExt;
use futures_util::StreamExt;
use futures_util::pin_mut;
use matrix_sdk::RoomState;
use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::executor::spawn;
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
use crate::{Core, ResultExt, SignedIn};

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

fn with_room_id(mut event: Value, room_id: &ruma::RoomId) -> Value {
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
        .raw()
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
    room_id: &ruma::RoomId,
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

fn accepted_urls(content: Option<Value>) -> Vec<String> {
    content
        .and_then(|content| {
            content.get("accepted")?.as_array().map(|urls| {
                urls.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
        })
        .unwrap_or_default()
}

impl SignedIn {
    pub(crate) async fn room_timeline_events(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
        msgtype: Option<&str>,
        state_key: Option<&str>,
        limit: u32,
        since: Option<&OwnedEventId>,
    ) -> Result<Vec<Value>, RpcError> {
        let client = self.client();
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
            let Ok(json) = serde_json::from_str::<Value>(event.raw().json().get()) else {
                continue;
            };

            if state_key
                .is_some_and(|wanted| json.get("state_key").and_then(Value::as_str) != Some(wanted))
            {
                continue;
            }
            if json.get("type").and_then(Value::as_str) != Some(event_type) {
                continue;
            }
            if let Some(msgtype) = msgtype
                && json
                    .get("content")
                    .and_then(|content| content.get("msgtype"))
                    .and_then(Value::as_str)
                    != Some(msgtype)
            {
                continue;
            }

            if since.is_some_and(|since| {
                json.get("event_id").and_then(Value::as_str) == Some(since.as_str())
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
    ) -> Result<Vec<Value>, RpcError> {
        let room = self.room(room_id)?;
        let wanted = |json: &Value| {
            state_key
                .is_none_or(|wanted| json.get("state_key").and_then(Value::as_str) == Some(wanted))
        };
        // Sliding sync only stores the state types in its `required_state`.
        if room.state() == RoomState::Joined && event_type != "m.room.member" {
            match self.room_state_snapshot(room_id).await {
                Ok(snapshot) => {
                    return Ok(snapshot
                        .iter()
                        .filter_map(|raw| serde_json::from_str::<Value>(raw.json().get()).ok())
                        .filter(|json| json.get("type").and_then(Value::as_str) == Some(event_type))
                        .filter(wanted)
                        .map(|json| with_room_id(json, room_id))
                        .collect());
                }
                Err(error) => {
                    tracing::warn!(room = %room_id, %error, "room state read from the store after the state fetch failed");
                }
            }
        }
        let events = self
            .core()
            .with_open_stores(async || room.get_state_events(event_type.into()).await)
            .await
            .or_failed(self.core(), "room_state_events_raw")?;

        Ok(events
            .into_iter()
            .filter_map(|event| {
                let raw = match &event {
                    RawAnySyncOrStrippedState::Sync(raw) => raw.json(),
                    RawAnySyncOrStrippedState::Stripped(raw) => raw.json(),
                };
                serde_json::from_str::<Value>(raw.get()).ok()
            })
            .filter(wanted)
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
            .send(lenient_user_directory::Request::new(request))
            .await
            .or_failed(self.core(), "search_user_directory")?;

        Ok((response.limited, directory_entries(&response.results)))
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
        let room = self.room(room_id)?;
        let client = self.client();
        let delay = Duration::from_millis(delay_ms);

        if state_key.is_some() {
            let event = DelayedEvent {
                room_id: room_id.clone(),
                event_type: event_type.to_owned(),
                state_key,
                content: serde_json::value::to_raw_value(&content).or_failed(self.core(), LABEL)?,
                delay,
                sticky_duration_ms: None,
            };
            return delayed_events::send(client, support, event)
                .await
                .or_failed(self.core(), LABEL);
        }
        if let Some(duration) = sticky_duration_ms {
            if self.core().room_is_encrypted(&room).await? {
                return Err(RpcCode::EncryptedScheduleUnsupported.into());
            }
            return sticky::send_delayed_event(
                client, support, &room, event_type, content, delay, duration,
            )
            .await
            .or_failed(self.core(), LABEL);
        }
        if self.core().room_is_encrypted(&room).await? {
            return Err(RpcCode::EncryptedScheduleUnsupported.into());
        }
        let event = DelayedEvent {
            room_id: room_id.clone(),
            event_type: event_type.to_owned(),
            state_key: None,
            content: serde_json::value::to_raw_value(&content).or_failed(self.core(), LABEL)?,
            delay,
            sticky_duration_ms: None,
        };
        delayed_events::send(client, support, event)
            .await
            .or_failed(self.core(), LABEL)
    }

    pub(crate) async fn widget_send_sticky_event(
        &self,
        room_id: &OwnedRoomId,
        event_type: &str,
        content: Value,
        sticky_duration_ms: u32,
    ) -> Result<OwnedEventId, RpcError> {
        let response = self
            .room(room_id)?
            .send_raw(event_type, content)
            .with_sticky_duration(Duration::from_millis(u64::from(sticky_duration_ms)))
            .await
            .or_failed(self.core(), "widget_send_sticky_event")?;
        Ok(response.response.event_id)
    }

    pub(crate) async fn restart_delayed_event(
        &self,
        RestartDelayedEventParams { delay_id }: RestartDelayedEventParams,
    ) -> Result<(), RpcError> {
        delayed_events::update(self.client(), delay_id, UpdateAction::Restart)
            .await
            .or_failed(self.core(), "restart_delayed_event")?;
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
            serde_json::from_value(messages).or_failed(self.core(), LABEL)?;
        let client = self.client();

        if !encrypted {
            let mut wire = BTreeMap::new();
            for (user_id, devices) in messages {
                let mut per_device = BTreeMap::new();
                for (device, content) in devices {
                    per_device.insert(
                        device,
                        Raw::new(&content)
                            .or_failed(self.core(), LABEL)?
                            .cast_unchecked(),
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
                .or_failed(self.core(), LABEL)?;
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
                        .or_failed(self.core(), LABEL)?
                        .into_iter()
                        .collect(),
                    DeviceIdOrAllDevices::AllDevices => encryption
                        .get_user_devices(&user_id)
                        .await
                        .or_failed(self.core(), LABEL)?
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
            let raw = Raw::from_json_string(content).or_failed(self.core(), LABEL)?;
            let failures = encryption
                .encrypt_and_send_raw_to_device(
                    devices.iter().collect(),
                    event_type,
                    raw,
                    CollectStrategy::AllDevices,
                )
                .await
                .or_failed(self.core(), LABEL)?;
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
        let room = self.room(room_id)?;
        let event = self
            .core()
            .with_open_stores(async || room.account_data(event_type.into()).await)
            .await
            .or_failed(self.core(), "room_account_data_raw")?;
        Ok(event.and_then(|raw| {
            let mut json: Value = serde_json::from_str(raw.json().get()).ok()?;
            json.as_object_mut()?
                .insert("room_id".to_owned(), Value::String(room_id.to_string()));
            Some(json)
        }))
    }

    pub(crate) fn room_sticky_events(&self, room_id: &OwnedRoomId) -> Result<Vec<Value>, RpcError> {
        let room = self.room(room_id)?;
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
        let room = self.room(room_id)?;
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
            let response = client.send(request).await.or_failed(self.core(), LABEL)?;
            (response.chunk, response.next_batch, response.prev_batch)
        } else {
            let mut request =
                get_relating_events::v1::Request::new(room_id.clone(), event_id.clone());
            request.from = from;
            request.to = to;
            request.limit = limit;
            request.dir = dir;
            let response = client.send(request).await.or_failed(self.core(), LABEL)?;
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
            Err(error) => return Err(self.core().rpc_error("turn_server", &error)),
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
            .discover_rtc_transports()
            .await
            .or_failed(self.core(), "rtc_transports")?
            .unwrap_or_default();
        serde_json::to_value(transports)
            .map(|transports| serde_json::json!({ "rtc_transports": transports }))
            .or_failed(self.core(), "rtc_transports")
    }

    pub(crate) async fn rtc_livekit(
        &self,
        endpoint: RtcLivekitEndpoint,
        body: &Value,
    ) -> Result<Value, RpcError> {
        const LABEL: &str = "rtc_livekit";
        let client = self.client();
        let content_type = "application/json".to_owned();
        let body = serde_json::to_vec(body).or_failed(self.core(), LABEL)?;
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
        .or_failed(self.core(), LABEL)?;
        serde_json::from_slice(&response).or_failed(self.core(), LABEL)
    }

    pub(crate) async fn integration_manager_url(
        &self,
        room_id: &OwnedRoomId,
    ) -> Result<String, RpcError> {
        const LABEL: &str = "integration_manager_url";
        let manager = self.integration_manager(LABEL).await?;

        let scalar_token = self.scalar_token(&manager.api_url).await;
        integration_manager_page(&manager.ui_url, scalar_token.as_deref(), room_id).ok_or_else(
            || {
                self.core()
                    .failed(LABEL, "the integration manager URL is invalid")
            },
        )
    }

    /// The account's `/.well-known/matrix/client`, looked up on its server
    /// name first because the homeserver URL it delegates to rarely serves it.
    pub(crate) async fn well_known(&self) -> Result<Option<Value>, RpcError> {
        let client = self.client();
        let named = client
            .user_id()
            .and_then(|user| url::Url::parse(&format!("https://{}", user.server_name())).ok());
        let advertised = url::Url::parse(client.homeserver().as_str()).ok();
        for base in named.into_iter().chain(advertised) {
            if let Some(well_known) = fetch_well_known(client, &base).await {
                return Ok(Some(well_known));
            }
        }
        Ok(None)
    }

    async fn integration_manager(&self, label: &str) -> Result<IntegrationManager, RpcError> {
        let client = self.client();

        let mut managers = Vec::new();
        if let Ok(base) = url::Url::parse(client.homeserver().as_str())
            && let Some(well_known) = fetch_well_known(client, &base).await
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
            .http_client()
            .raw()
            .get(terms_url(&manager.api_url))
            .send()
            .await
            .or_failed(self.core(), LABEL)?;
        if !response.status().is_success() {
            return Ok(Vec::new());
        }
        let terms: Value =
            serde_json::from_str(&response.text().await.or_failed(self.core(), LABEL)?)
                .or_failed(self.core(), LABEL)?;

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
        let client = self.client();
        let Ok(mut url) = url::Url::parse(&format!("{}/account", api_url.trim_end_matches('/')))
        else {
            return false;
        };
        url.query_pairs_mut().append_pair("scalar_token", &token);
        let Ok(response) = client.http_client().raw().get(url).send().await else {
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
        let token = self.scalar_token(&manager.api_url).await.ok_or_else(|| {
            self.core()
                .failed(LABEL, "the integration manager did not issue a token")
        })?;

        self.client()
            .http_client()
            .raw()
            .post(terms_url(&manager.api_url))
            .bearer_auth(token)
            .header("Content-Type", "application/json")
            .body(serde_json::json!({ "user_accepts": urls }).to_string())
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .or_failed(self.core(), LABEL)?;

        self.update_account_data(&["m.accepted_terms"], LABEL, async |current| {
            let mut accepted = accepted_urls(current);
            for url in urls {
                if !accepted.contains(&url) {
                    accepted.push(url);
                }
            }
            Ok(Some(serde_json::json!({ "accepted": accepted })))
        })
        .await?;
        Ok(())
    }

    async fn accepted_terms(&self, label: &str) -> Result<Vec<String>, RpcError> {
        Ok(accepted_urls(
            self.global_account_data(GlobalAccountDataEventType::from("m.accepted_terms"), label)
                .await?
                .and_then(|raw| serde_json::from_str::<Value>(raw.json().get()).ok()),
        ))
    }

    /// The manager records signed terms per token, so a fresh one opens the page unsigned.
    async fn scalar_token(&self, api_url: &str) -> Option<String> {
        if let Some(token) = self.state().scalar_tokens.lock().get(api_url) {
            return Some(token.clone());
        }
        let token = self.openid_token().await.ok()?;
        let response = self
            .client()
            .http_client()
            .raw()
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
        let token = serde_json::from_str::<Value>(&response.text().await.ok()?)
            .ok()?
            .get("scalar_token")?
            .as_str()?
            .to_owned();
        self.state()
            .scalar_tokens
            .lock()
            .insert(api_url.to_owned(), token.clone());
        Some(token)
    }

    pub(crate) fn known_room_ids(&self) -> Vec<OwnedRoomId> {
        self.client()
            .rooms()
            .into_iter()
            .filter(|room| matches!(room.state(), RoomState::Joined | RoomState::Invited))
            .map(|room| room.room_id().to_owned())
            .collect()
    }

    pub(crate) fn watch_room_widgets(&self, generation: u64) {
        let client = self.client();
        let handle = client.add_event_handler({
            let core = self.clone();
            move |raw: Raw<AnySyncStateEvent>, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    let kind = raw.get_field::<String>("type").ok().flatten();
                    if matches!(kind.as_deref(), Some(WIDGET_STATE_TYPE | "m.widget")) {
                        core.core().emit_if_current(
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

    pub(crate) fn watch_widget_feed(&self, generation: u64) {
        let client = self.client();
        let handle = client.add_event_handler({
            let core = self.clone();
            move |raw: Raw<AnySyncTimelineEvent>, room: matrix_sdk::Room| {
                let core = core.clone();
                async move {
                    if !core.core().settings.widget_feed.load(Ordering::Relaxed) {
                        return;
                    }
                    let Ok(event) = serde_json::from_str::<Value>(raw.json().get()) else {
                        return;
                    };
                    if event.get("type").and_then(Value::as_str) == Some("m.room.encrypted") {
                        return;
                    }
                    core.core().emit_if_current(
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
                    if !core.core().settings.widget_feed.load(Ordering::Relaxed) {
                        continue;
                    }
                    let Ok(event) = serde_json::from_str::<Value>(message.raw.json().get()) else {
                        continue;
                    };
                    core.core().emit_if_current(
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
        let client = self.client();
        let user_id = client.user_id().ok_or(RpcCode::NotLoggedIn)?.to_owned();

        let response = client
            .send(request_openid_token::v3::Request::new(user_id))
            .await
            .or_failed(self.core(), "openid_token")?;

        Ok(OpenIdTokenView {
            access_token: response.access_token,
            token_type: response.token_type.to_string(),
            matrix_server_name: response.matrix_server_name.to_string(),
            expires_in_ms: u64::try_from(response.expires_in.as_millis()).unwrap_or(u64::MAX),
        })
    }
}

fn directory_entries(results: &[Raw<search_users::v3::User>]) -> Vec<UserDirectoryEntryView> {
    results
        .iter()
        .filter_map(|raw| crate::lenient::parse_or_skip(raw, "user directory result"))
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
        .collect()
}

mod lenient_user_directory {
    use ruma::api::client::user_directory::search_users;
    use ruma::api::response;
    use ruma::serde::Raw;

    pub(crate) type Request = crate::lenient::Request<search_users::v3::Request, Response>;

    #[response]
    pub(crate) struct Response {
        pub results: Vec<Raw<search_users::v3::User>>,
        pub limited: bool,
    }
}

#[cfg(test)]
#[path = "widgets_tests.rs"]
mod tests;

impl Core {
    pub(crate) fn set_widget_feed(&self, enabled: bool) {
        self.settings.widget_feed.store(enabled, Ordering::Relaxed);
    }
}
