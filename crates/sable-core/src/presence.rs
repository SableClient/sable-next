use std::time::Duration;

use crate::tasks::JoinHandleExt;
use futures_util::stream::{self, StreamExt};
use matrix_sdk::executor::spawn;
use matrix_sdk::ruma::OwnedUserId;
use matrix_sdk::ruma::api::FeatureFlag;
use matrix_sdk::ruma::api::client::filter::{FilterDefinition, RoomFilter};
use matrix_sdk::ruma::api::client::presence::get_presence;
use matrix_sdk::ruma::api::client::sync::sync_events;
use matrix_sdk::ruma::events::GlobalAccountDataEventType;
use matrix_sdk::ruma::events::presence::PresenceEvent;
use matrix_sdk::ruma::presence::PresenceState;
use serde_json::{Map, Value};

use crate::Core;
use crate::SignedIn;
use crate::protocol::{CoreEvent, PresenceOverrideView, PresenceView, RpcError};

const POLL_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_GAP: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_mins(1);
const FETCH_CONCURRENCY: usize = 8;
const SINCE_KEY: &[u8] = b"sable.presence.since";

const FEATURE: &str = "org.continuwuity.presence_v2.msc4532";
const STABLE_FEATURE: &str = "org.continuwuity.presence_v2.msc4532.stable";
pub(crate) const PERSISTENT_EVENT: &str = "m.presence.persistent";
pub(crate) const UNSTABLE_PERSISTENT_EVENT: &str =
    "org.continuwuity.presence_v2.msc4532.presence.persistent";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Revised {
    Unstable,
    Stable,
}

impl Revised {
    const fn from_features(stable: bool, unstable: bool) -> Option<Self> {
        if stable {
            Some(Self::Stable)
        } else if unstable {
            Some(Self::Unstable)
        } else {
            None
        }
    }

    /// A server that moved to the stable key may still hold the unstable one.
    const fn persistent_candidates(self) -> &'static [&'static str] {
        match self {
            Self::Stable => &[PERSISTENT_EVENT, UNSTABLE_PERSISTENT_EVENT],
            Self::Unstable => &[UNSTABLE_PERSISTENT_EVENT],
        }
    }
}

#[expect(
    deprecated,
    reason = "legacy servers still send online and unavailable"
)]
pub(crate) fn view(state: &PresenceState, currently_active: Option<bool>) -> PresenceView {
    match state.as_msc4532_state(currently_active.unwrap_or(true)) {
        PresenceState::Active | PresenceState::Online => PresenceView::Online,
        PresenceState::Offline => PresenceView::Offline,
        PresenceState::Busy => PresenceView::Busy,
        // `PresenceState` is non-exhaustive. Anything added later reads as
        // away.
        _ => PresenceView::Unavailable,
    }
}

#[expect(
    deprecated,
    reason = "legacy servers only accept online and unavailable"
)]
pub(crate) fn state(view: PresenceView, revised: bool) -> PresenceState {
    let state = match view {
        PresenceView::Online => PresenceState::Active,
        PresenceView::Offline => PresenceState::Offline,
        PresenceView::Unavailable => PresenceState::Idle,
        PresenceView::Busy => PresenceState::Busy,
    };
    if revised {
        state
    } else {
        match state {
            PresenceState::Active => PresenceState::Online,
            PresenceState::Idle | PresenceState::Busy => PresenceState::Unavailable,
            state => state,
        }
    }
}

/// ruma adds the MSC4532 `status` object beside every status message, and Synapse rejects a body
/// with a key it does not know.
mod legacy_status {
    use ruma::OwnedUserId;
    use ruma::api::{auth_scheme::AccessToken, request, response};
    use ruma::metadata;
    use ruma::presence::PresenceState;

    metadata! {
        method: PUT,
        rate_limited: true,
        authentication: AccessToken,
        history: {
            1.0 => "/_matrix/client/r0/presence/{user_id}/status",
            1.1 => "/_matrix/client/v3/presence/{user_id}/status",
        }
    }

    #[request]
    pub(crate) struct Request {
        #[ruma_api(path)]
        pub user_id: OwnedUserId,
        pub presence: PresenceState,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub status_msg: Option<String>,
    }

    #[response]
    pub(crate) struct Response {}
}

const UNSTABLE_PREFIX: &str = "org.continuwuity.presence_v2.msc4532.";

fn revised_state_view(state: &str) -> Option<PresenceView> {
    match state.strip_prefix(UNSTABLE_PREFIX).unwrap_or(state) {
        "active" => Some(PresenceView::Online),
        "idle" => Some(PresenceView::Unavailable),
        "busy" => Some(PresenceView::Busy),
        "offline" => Some(PresenceView::Offline),
        _ => None,
    }
}

/// Unknown or legacy override states are ignored, as the MSC requires.
pub(crate) fn override_view(content: Option<&Value>) -> PresenceOverrideView {
    let state = content
        .and_then(|content| content.get("state_override")?.as_str())
        .and_then(revised_state_view);
    let status_message = content
        .and_then(|content| content.get("status")?.get("msg")?.as_str())
        .map(str::trim)
        .filter(|msg| !msg.is_empty())
        .map(str::to_owned);
    PresenceOverrideView {
        state,
        status_message,
    }
}

/// Other fields in `status` belong to other proposals and are kept.
pub(crate) fn edited_override(
    stored: Option<Value>,
    edit: &PresenceOverrideView,
    revised: Revised,
) -> Value {
    let mut content = match stored {
        Some(Value::Object(content)) => content,
        _ => Map::new(),
    };
    match edit.state {
        Some(view) => {
            let state = override_state(view, revised);
            content.insert("state_override".to_owned(), Value::from(state));
        }
        None => {
            content.shift_remove("state_override");
        }
    }
    let status = content
        .entry("status".to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !status.is_object() {
        *status = Value::Object(Map::new());
    }
    if let Some(status) = status.as_object_mut() {
        match edit
            .status_message
            .as_deref()
            .map(str::trim)
            .filter(|msg| !msg.is_empty())
        {
            Some(msg) => {
                status.insert("msg".to_owned(), Value::from(msg));
            }
            None => {
                status.shift_remove("msg");
            }
        }
    }
    Value::Object(content)
}

fn override_state(view: PresenceView, revised: Revised) -> String {
    let name = match view {
        PresenceView::Online => "active",
        PresenceView::Unavailable => "idle",
        PresenceView::Busy => "busy",
        PresenceView::Offline => return "offline".to_owned(),
    };
    match revised {
        Revised::Stable => name.to_owned(),
        Revised::Unstable => format!("{UNSTABLE_PREFIX}{name}"),
    }
}

fn presence_filter() -> FilterDefinition {
    let mut filter = FilterDefinition::default();
    filter.presence.types = Some(vec!["m.presence".to_owned()]);
    filter.account_data.types = Some(Vec::new());

    let mut rooms = RoomFilter::default();
    rooms.rooms = Some(Vec::new());
    filter.room = rooms;

    filter
}

impl SignedIn {
    pub(crate) async fn revised_presence(&self) -> Option<Revised> {
        let features = self.client().unstable_features().await.ok()?;
        Revised::from_features(
            features.contains(&FeatureFlag::from(STABLE_FEATURE)),
            features.contains(&FeatureFlag::from(FEATURE)),
        )
    }

    pub(crate) async fn sync_presence(&self) -> PresenceState {
        let revised = self.revised_presence().await.is_some();
        self.sync_presence_for(revised).await
    }

    /// Reads the server features from the cache only, for a caller that cannot wait on a request.
    pub(crate) async fn cached_sync_presence(&self) -> PresenceState {
        let cached = self
            .client()
            .supported_versions_cached()
            .await
            .ok()
            .flatten();
        let revised = cached.is_some_and(|supported| {
            Revised::from_features(
                supported
                    .features
                    .contains(&FeatureFlag::from(STABLE_FEATURE)),
                supported.features.contains(&FeatureFlag::from(FEATURE)),
            )
            .is_some()
        });
        self.sync_presence_for(revised).await
    }

    pub(crate) async fn publish_presence(
        &self,
        status_message: Option<String>,
    ) -> matrix_sdk::Result<()> {
        let client = self.client();
        let revised = self.revised_presence().await.is_some();
        let presence = self.sync_presence_for(revised).await;
        if revised {
            return client.set_presence(presence, status_message, true).await;
        }
        client.set_presence(presence.clone(), None, false).await?;
        let user_id = client
            .user_id()
            .ok_or(matrix_sdk::Error::AuthenticationRequired)?
            .to_owned();
        client
            .send(legacy_status::Request {
                user_id,
                presence,
                status_msg: status_message,
            })
            .await?;
        Ok(())
    }

    pub(crate) async fn refresh_presence(&self) {
        if self.revised_presence().await.is_none() {
            return;
        }
        let presence = self.sync_presence().await;
        if let Err(error) = self.client().set_presence(presence, None, true).await {
            tracing::debug!("presence not refreshed: {error}");
        }
    }

    pub(crate) async fn presence_override(&self) -> Result<Option<PresenceOverrideView>, RpcError> {
        let Some(revised) = self.revised_presence().await else {
            return Ok(None);
        };
        let content = self
            .persistent_presence(revised, "presence_override")
            .await?;
        Ok(Some(override_view(content.as_ref())))
    }

    pub(crate) async fn set_presence_override(
        &self,
        edit: &PresenceOverrideView,
    ) -> Result<PresenceOverrideView, RpcError> {
        let label = "set_presence_override";
        let revised = self.revised_presence().await.ok_or_else(|| {
            self.core()
                .failed(label, "the homeserver does not support revised presence")
        })?;
        let content = self
            .update_account_data(revised.persistent_candidates(), label, async |stored| {
                Ok(Some(edited_override(stored, edit, revised)))
            })
            .await?;
        Ok(override_view(content.as_ref()))
    }

    async fn persistent_presence(
        &self,
        revised: Revised,
        label: &str,
    ) -> Result<Option<Value>, RpcError> {
        for key in revised.persistent_candidates() {
            let content = self
                .global_account_data(GlobalAccountDataEventType::from(*key), label)
                .await?
                .and_then(|raw| raw.deserialize_as::<Value>().ok());
            if content.is_some() {
                return Ok(content);
            }
        }
        Ok(None)
    }

    pub(crate) fn watch_presence(&self, generation: u64) {
        let client = self.client();
        let core = self.clone();
        let client = client.clone();

        self.track_session_task(
            spawn(async move {
                let mut since = stored_since(core.core(), &client).await;
                let revised = core.revised_presence().await.is_some();
                let mut failures = 0u32;

                loop {
                    core.core().wait_until_active().await;
                    let mut request = sync_events::v3::Request::new();
                    request.filter =
                        Some(sync_events::v3::Filter::FilterDefinition(presence_filter()));
                    request.since.clone_from(&since);
                    request.timeout = Some(POLL_TIMEOUT);
                    request.set_presence = core.sync_presence().await;
                    request.revised_presence = revised;

                    match client
                        .send(request)
                        .with_request_config(
                            matrix_sdk::config::RequestConfig::short_retry()
                                .timeout(REQUEST_TIMEOUT),
                        )
                        .await
                    {
                        Ok(response) => {
                            failures = 0;
                            for raw in response.presence.events {
                                let Ok(event) = raw.deserialize() else {
                                    continue;
                                };
                                core.core()
                                    .emit_if_current(generation, presence_event(&event));
                            }
                            if since.as_deref() != Some(response.next_batch.as_str()) {
                                store_since(core.core(), &client, &response.next_batch).await;
                                since = Some(response.next_batch);
                            }
                        }
                        Err(error) => {
                            tracing::debug!("presence sync failed: {error}");
                            failures = failures.saturating_add(1);
                            if since.is_some()
                                && error.as_client_api_error().is_some_and(|error| {
                                    error.status_code == http::StatusCode::BAD_REQUEST
                                })
                            {
                                since = None;
                            }
                        }
                    }

                    if !core.core().is_current(generation) {
                        break;
                    }

                    if failures > 0 {
                        crate::watchers::retry_backoff(failures).await;
                    }
                    matrix_sdk::sleep::sleep(POLL_GAP).await;
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn fetch_presence(&self, user_ids: Vec<OwnedUserId>) {
        let client = self.client();
        let generation = self.generation();

        stream::iter(user_ids)
            .for_each_concurrent(FETCH_CONCURRENCY, |user_id| {
                let client = client.clone();
                let core = self.clone();

                async move {
                    let Ok(response) = client
                        .send(get_presence::v3::Request::new(user_id.clone()))
                        .await
                    else {
                        return;
                    };

                    core.core().emit_if_current(
                        generation,
                        CoreEvent::Presence {
                            user_id,
                            presence: view(&response.presence, legacy_active(&response)),
                            status_message: response.status.msg,
                            last_active_ago: response
                                .last_active_ago
                                .map(|ago| u64::try_from(ago.as_millis()).unwrap_or(u64::MAX)),
                        },
                    );
                }
            })
            .await;
    }

    async fn sync_presence_for(&self, revised: bool) -> PresenceState {
        let desired = self.core().desired_presence();
        let in_call = matches!(desired, PresenceView::Online | PresenceView::Unavailable)
            && revised
            && !self.state().calls.lock().await.is_empty();
        state(if in_call { PresenceView::Busy } else { desired }, revised)
    }
}

async fn stored_since(core: &Core, client: &matrix_sdk::Client) -> Option<String> {
    let bytes = core
        .with_open_stores(async || client.state_store().get_custom_value(SINCE_KEY).await)
        .await
        .ok()
        .flatten()?;
    String::from_utf8(bytes).ok()
}

async fn store_since(core: &Core, client: &matrix_sdk::Client, since: &str) {
    if let Err(error) = core
        .with_open_stores(async || {
            client
                .state_store()
                .set_custom_value_no_read(SINCE_KEY, since.as_bytes().to_vec())
                .await
        })
        .await
    {
        tracing::debug!("presence sync token not stored: {error}");
    }
}

#[expect(
    deprecated,
    reason = "legacy servers split online into active and idle with it"
)]
const fn legacy_active(response: &get_presence::v3::Response) -> Option<bool> {
    response.currently_active
}

#[expect(
    deprecated,
    reason = "legacy servers split online into active and idle with it"
)]
fn presence_event(event: &PresenceEvent) -> CoreEvent {
    CoreEvent::Presence {
        user_id: event.sender.clone(),
        presence: view(&event.content.presence, event.content.currently_active),
        status_message: event.content.status.msg.clone(),
        last_active_ago: event.content.last_active_ago.map(Into::into),
    }
}

impl Core {
    pub(crate) fn desired_presence(&self) -> PresenceView {
        *self.settings.desired_presence.lock()
    }

    pub(crate) fn set_desired_presence(&self, presence: PresenceView) {
        *self.settings.desired_presence.lock() = presence;
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::test_utils::mocks::MatrixMockServer;

    use matrix_sdk::ruma::presence::PresenceState;
    use serde_json::json;

    use super::{
        Revised, edited_override, override_view, presence_filter, state, store_since, stored_since,
        view,
    };
    use crate::protocol::{PresenceOverrideView, PresenceView};
    use crate::{Core, store::MemorySessionStore};

    #[test]
    #[expect(deprecated, reason = "legacy states are still on the wire")]
    fn legacy_states_follow_the_msc4532_behaviour_map() {
        assert_eq!(
            view(&PresenceState::Online, Some(true)),
            PresenceView::Online
        );
        assert_eq!(view(&PresenceState::Online, None), PresenceView::Online);
        assert_eq!(
            view(&PresenceState::Online, Some(false)),
            PresenceView::Unavailable
        );
        assert_eq!(
            view(&PresenceState::Unavailable, Some(true)),
            PresenceView::Unavailable
        );
        assert_eq!(view(&PresenceState::Busy, None), PresenceView::Busy);
        assert_eq!(
            view(&PresenceState::Idle, Some(true)),
            PresenceView::Unavailable
        );
    }

    #[test]
    #[expect(deprecated, reason = "legacy states are still on the wire")]
    fn busy_reads_as_unavailable_on_a_legacy_server() {
        assert_eq!(state(PresenceView::Busy, false), PresenceState::Unavailable);
        assert_eq!(state(PresenceView::Online, false), PresenceState::Online);
        assert_eq!(state(PresenceView::Busy, true), PresenceState::Busy);
        assert_eq!(
            state(PresenceView::Online, true).as_str(),
            "org.continuwuity.presence_v2.msc4532.active"
        );
    }

    #[test]
    #[expect(deprecated, reason = "legacy states are still on the wire")]
    fn a_legacy_status_message_carries_no_revised_status() {
        use ruma::api::auth_scheme::SendAccessToken;
        use ruma::api::{OutgoingRequestExt, SupportedVersions};

        let request = super::legacy_status::Request {
            user_id: ruma::owned_user_id!("@a:example.org"),
            presence: PresenceState::Online,
            status_msg: Some("In a meeting".to_owned()),
        };
        let supported = SupportedVersions {
            versions: [ruma::api::MatrixVersion::V1_1].into(),
            features: std::collections::BTreeSet::default(),
        };
        let request = request
            .try_into_http_request::<Vec<u8>>(
                "https://example.org",
                SendAccessToken::IfRequired("token"),
                std::borrow::Cow::Owned(supported),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(request.body()).unwrap(),
            json!({"presence": "online", "status_msg": "In a meeting"})
        );
    }

    #[test]
    fn the_override_ignores_unknown_states_and_blank_messages() {
        let parsed = override_view(Some(&json!({
            "state_override": "online",
            "status": {"msg": "   "},
        })));
        assert_eq!(
            parsed,
            PresenceOverrideView {
                state: None,
                status_message: None
            }
        );

        let parsed = override_view(Some(&json!({
            "state_override": "org.continuwuity.presence_v2.msc4532.busy",
            "status": {"msg": " Partying "},
        })));
        assert_eq!(parsed.state, Some(PresenceView::Busy));
        assert_eq!(parsed.status_message.as_deref(), Some("Partying"));
        assert_eq!(
            override_view(Some(&json!({"state_override": "idle"}))).state,
            Some(PresenceView::Unavailable)
        );
    }

    async fn advertise(server: &MatrixMockServer, features: serde_json::Value) {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};

        Mock::given(method("GET"))
            .and(path("/_matrix/client/versions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "versions": ["v1.19"],
                "unstable_features": features,
            })))
            .mount(server.server())
            .await;
    }

    #[tokio::test]
    #[expect(deprecated, reason = "a legacy server gets the legacy state")]
    async fn a_legacy_server_has_no_override_and_never_sees_busy() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().no_server_versions().build().await;
        advertise(&server, json!({})).await;
        let (core, _) = crate::test_support::signed_in_core(&server, client).await;
        let session = core.signed_in().unwrap();
        session.core().set_desired_presence(PresenceView::Busy);

        assert_eq!(session.presence_override().await.unwrap(), None);
        assert_eq!(session.sync_presence().await, PresenceState::Unavailable);
    }

    #[tokio::test]
    async fn the_stable_override_falls_back_to_the_unstable_key_and_writes_stable() {
        use wiremock::matchers::{method, path_regex};
        use wiremock::{Mock, ResponseTemplate};

        let server = MatrixMockServer::new().await;
        let client = server.client_builder().no_server_versions().build().await;
        advertise(
            &server,
            json!({
                "org.continuwuity.presence_v2.msc4532": true,
                "org.continuwuity.presence_v2.msc4532.stable": true,
            }),
        )
        .await;
        Mock::given(method("GET"))
            .and(path_regex(format!(
                "/account_data/{}$",
                regex_lite::escape(super::UNSTABLE_PERSISTENT_EVENT)
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "state_override": "org.continuwuity.presence_v2.msc4532.busy",
                "status": {"msg": "away", "emoji": "x"},
            })))
            .mount(server.server())
            .await;
        Mock::given(method("GET"))
            .and(path_regex(r"/account_data/"))
            .respond_with(
                ResponseTemplate::new(404)
                    .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "not found"})),
            )
            .mount(server.server())
            .await;
        Mock::given(method("PUT"))
            .and(path_regex(r"/account_data/m\.presence\.persistent$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;
        let (core, _) = crate::test_support::signed_in_core(&server, client).await;
        let session = core.signed_in().unwrap();

        let current = session.presence_override().await.unwrap().unwrap();
        assert_eq!(current.state, Some(PresenceView::Busy));
        assert_eq!(current.status_message.as_deref(), Some("away"));

        let saved = session
            .set_presence_override(&PresenceOverrideView {
                state: None,
                status_message: Some("back".to_owned()),
            })
            .await
            .unwrap();
        assert_eq!(saved.state, None);

        let put = server
            .server()
            .received_requests()
            .await
            .unwrap()
            .into_iter()
            .find(|request| request.method.as_str() == "PUT")
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&put.body).unwrap(),
            json!({"status": {"msg": "back", "emoji": "x"}})
        );
        assert_eq!(session.sync_presence().await, PresenceState::Active);
    }

    #[test]
    fn editing_the_override_keeps_other_status_fields() {
        let stored = json!({
            "state_override": "busy",
            "status": {"msg": "old", "emoji": "🎉"},
            "other": true,
        });
        let edited = edited_override(
            Some(stored),
            &PresenceOverrideView {
                state: None,
                status_message: Some(" new ".to_owned()),
            },
            Revised::Stable,
        );
        assert_eq!(
            edited,
            json!({"status": {"msg": "new", "emoji": "🎉"}, "other": true})
        );

        let edited = edited_override(
            None,
            &PresenceOverrideView {
                state: Some(PresenceView::Busy),
                status_message: None,
            },
            Revised::Unstable,
        );
        assert_eq!(
            edited,
            json!({"state_override": "org.continuwuity.presence_v2.msc4532.busy", "status": {}})
        );
    }

    #[tokio::test]
    async fn the_presence_sync_token_survives_a_restart() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let (core, _) = Core::new("presence", Box::new(MemorySessionStore::default()));
        assert_eq!(stored_since(&core, &client).await, None);

        store_since(&core, &client, "s42").await;

        assert_eq!(stored_since(&core, &client).await.as_deref(), Some("s42"));
    }

    #[test]
    fn the_filter_asks_for_presence_and_nothing_else() {
        let filter = serde_json::to_value(presence_filter()).unwrap();

        assert_eq!(
            filter["presence"]["types"],
            serde_json::json!(["m.presence"])
        );
        assert_eq!(filter["account_data"]["types"], serde_json::json!([]));
        assert_eq!(filter["room"]["rooms"], serde_json::json!([]));
    }
}
