use std::collections::BTreeSet;
use std::time::Duration;

use matrix_sdk::{Client, HttpResult};
use ruma::api::FeatureFlag;
use ruma::api::client::delayed_events::update_delayed_event::UpdateAction;
use ruma::api::client::delayed_events::{
    DelayParameters, delayed_message_event, delayed_state_event, update_delayed_event,
};
use ruma::events::{MessageLikeEventType, StateEventType};
use ruma::exports::http;
use ruma::serde::Raw;
use ruma::{OwnedRoomId, TransactionId};
use serde_json::value::RawValue as RawJsonValue;

const MSC4140: &str = "org.matrix.msc4140";
const MSC4140_STABLE: &str = "org.matrix.msc4140.stable";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DelayedEventsSupport {
    stable: bool,
    unstable: bool,
}

impl DelayedEventsSupport {
    pub(crate) fn from_features(features: &BTreeSet<FeatureFlag>) -> Self {
        let has = |name: &str| features.iter().any(|feature| feature.as_str() == name);
        Self {
            stable: has(MSC4140_STABLE),
            unstable: has(MSC4140),
        }
    }

    pub(crate) const fn any(self) -> bool {
        self.stable || self.unstable
    }

    /// Listing has no stable endpoint yet (MSC4486), only the unstable one.
    pub(crate) const fn can_list(self) -> bool {
        self.unstable
    }
}

pub(crate) async fn support(client: &Client) -> HttpResult<DelayedEventsSupport> {
    Ok(DelayedEventsSupport::from_features(
        &client.unstable_features().await?,
    ))
}

mod stable {
    pub(super) mod send {
        use ruma::api::{auth_scheme::AccessToken, request, response};
        use ruma::metadata;
        use ruma::{OwnedRoomId, OwnedTransactionId};
        use serde_json::value::RawValue as RawJsonValue;

        metadata! {
            method: PUT,
            rate_limited: true,
            authentication: AccessToken,
            history: {
                stable("org.matrix.msc4140.stable") => "/_matrix/client/v3/rooms/{room_id}/delayed_event/{event_type}/{txn_id}",
            }
        }

        #[request]
        pub(crate) struct Request {
            #[ruma_api(path)]
            pub room_id: OwnedRoomId,
            #[ruma_api(path)]
            pub event_type: String,
            #[ruma_api(path)]
            pub txn_id: OwnedTransactionId,
            #[ruma_api(query)]
            #[serde(
                rename = "org.matrix.msc4354.sticky_duration_ms",
                skip_serializing_if = "Option::is_none"
            )]
            pub sticky_duration_ms: Option<u32>,
            pub delay_ms: u64,
            #[serde(skip_serializing_if = "Option::is_none")]
            pub state_key: Option<String>,
            pub content: Box<RawJsonValue>,
        }

        #[response]
        pub(crate) struct Response {
            pub delay_id: String,
        }
    }

    pub(super) mod update {
        use ruma::api::client::delayed_events::update_delayed_event::UpdateAction;
        use ruma::api::{auth_scheme::AccessToken, request, response};
        use ruma::metadata;

        metadata! {
            method: POST,
            rate_limited: true,
            authentication: AccessToken,
            history: {
                stable("org.matrix.msc4140.stable") => "/_matrix/client/v1/delayed_events/{delay_id}/{action}",
            }
        }

        #[request]
        pub(crate) struct Request {
            #[ruma_api(path)]
            pub delay_id: String,
            #[ruma_api(path)]
            pub action: UpdateAction,
        }

        #[response]
        pub(crate) struct Response {}
    }
}

#[derive(Clone, Debug)]
struct DelayedStickyRequest(delayed_message_event::unstable::Request, u32);

type DelayedRequest = delayed_message_event::unstable::Request;

impl ruma::api::Metadata for DelayedStickyRequest {
    const METHOD: http::Method = DelayedRequest::METHOD;
    const RATE_LIMITED: bool = DelayedRequest::RATE_LIMITED;
    type Authentication = <DelayedRequest as ruma::api::Metadata>::Authentication;
    type PathBuilder = <DelayedRequest as ruma::api::Metadata>::PathBuilder;
    const PATH_BUILDER: Self::PathBuilder = DelayedRequest::PATH_BUILDER;
}

impl ruma::api::OutgoingRequest for DelayedStickyRequest {
    type Body = <DelayedRequest as ruma::api::OutgoingRequest>::Body;
    type EndpointError = <DelayedRequest as ruma::api::OutgoingRequest>::EndpointError;
    type IncomingResponse = <DelayedRequest as ruma::api::OutgoingRequest>::IncomingResponse;

    fn try_into_http_request_inner(
        self,
        base_url: &str,
        input: <Self::PathBuilder as ruma::api::path_builder::PathBuilder>::Input<'_>,
    ) -> Result<http::Request<Self::Body>, ruma::api::error::IntoHttpError> {
        let mut request = self.0.try_into_http_request_inner(base_url, input)?;
        let separator = if request.uri().query().is_some() {
            '&'
        } else {
            '?'
        };
        let uri = format!(
            "{}{separator}org.matrix.msc4354.sticky_duration_ms={}",
            request.uri(),
            self.1
        );
        *request.uri_mut() = uri.parse().map_err(http::Error::from)?;
        Ok(request)
    }
}

pub(crate) struct DelayedEvent {
    pub(crate) room_id: OwnedRoomId,
    pub(crate) event_type: String,
    pub(crate) state_key: Option<String>,
    pub(crate) content: Box<RawJsonValue>,
    pub(crate) delay: Duration,
    pub(crate) sticky_duration_ms: Option<u32>,
}

pub(crate) async fn send(
    client: &Client,
    support: DelayedEventsSupport,
    event: DelayedEvent,
) -> HttpResult<String> {
    let DelayedEvent {
        room_id,
        event_type,
        state_key,
        content,
        delay,
        sticky_duration_ms,
    } = event;

    if support.stable {
        let request = stable::send::Request {
            room_id,
            event_type,
            txn_id: TransactionId::new(),
            sticky_duration_ms,
            delay_ms: u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
            state_key,
            content,
        };
        return Ok(client.send(request).await?.delay_id);
    }

    let parameters = DelayParameters::Timeout { timeout: delay };
    if let Some(state_key) = state_key {
        let request = delayed_state_event::unstable::Request::new_raw(
            room_id,
            state_key,
            StateEventType::from(event_type),
            parameters,
            Raw::from_json(content),
        );
        return Ok(client.send(request).await?.delay_id);
    }
    let request = DelayedRequest::new_raw(
        room_id,
        TransactionId::new(),
        MessageLikeEventType::from(event_type),
        parameters,
        Raw::from_json(content),
    );
    Ok(match sticky_duration_ms {
        Some(duration) => {
            client
                .send(DelayedStickyRequest(request, duration))
                .await?
                .delay_id
        }
        None => client.send(request).await?.delay_id,
    })
}

pub(crate) async fn update(
    client: &Client,
    delay_id: String,
    action: UpdateAction,
) -> HttpResult<()> {
    if support(client).await?.stable {
        client
            .send(stable::update::Request { delay_id, action })
            .await?;
    } else {
        client
            .send(update_delayed_event::unstable_v1::Request::new(
                delay_id, action,
            ))
            .await?;
    }
    Ok(())
}

#[cfg(all(test, not(target_family = "wasm")))]
mod tests {
    use std::time::Duration;

    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use ruma::api::client::delayed_events::update_delayed_event::UpdateAction;
    use ruma::owned_room_id;
    use serde_json::json;
    use wiremock::matchers::{body_json, method, path, query_param};
    use wiremock::{Mock, ResponseTemplate};

    use super::{DelayedEvent, DelayedEventsSupport, send, support, update};

    async fn client_with(features: serde_json::Value) -> (MatrixMockServer, matrix_sdk::Client) {
        let server = MatrixMockServer::new().await;
        Mock::given(method("GET"))
            .and(path("/_matrix/client/versions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({"versions": ["v1.13"], "unstable_features": features})),
            )
            .mount(server.server())
            .await;
        let client = server.client_builder().no_server_versions().build().await;
        (server, client)
    }

    #[expect(clippy::unwrap_used, reason = "test code")]
    fn event(state_key: Option<&str>) -> DelayedEvent {
        DelayedEvent {
            room_id: owned_room_id!("!room:example.org"),
            event_type: "m.room.message".to_owned(),
            state_key: state_key.map(ToOwned::to_owned),
            content: serde_json::value::to_raw_value(
                &json!({"msgtype": "m.text", "body": "later"}),
            )
            .unwrap(),
            delay: Duration::from_millis(5000),
            sticky_duration_ms: None,
        }
    }

    #[tokio::test]
    async fn a_stable_server_gets_the_stable_endpoints() {
        let (server, client) =
            client_with(json!({"org.matrix.msc4140": true, "org.matrix.msc4140.stable": true}))
                .await;
        Mock::given(method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/!room:example.org/delayed_event/m.room.message/[^/]+$",
            ))
            .and(body_json(
                json!({"delay_ms": 5000, "content": {"msgtype": "m.text", "body": "later"}}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"delay_id": "d1"})))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path("/_matrix/client/v1/delayed_events/d1/cancel"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;

        let delay_id = send(&client, support(&client).await.unwrap(), event(None))
            .await
            .unwrap();
        assert_eq!(delay_id, "d1");
        update(&client, delay_id, UpdateAction::Cancel)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_stable_server_carries_the_sticky_duration_as_a_query_parameter() {
        let (server, client) = client_with(json!({"org.matrix.msc4140.stable": true})).await;
        Mock::given(method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/!room:example.org/delayed_event/m.room.message/[^/]+$",
            ))
            .and(query_param(
                "org.matrix.msc4354.sticky_duration_ms",
                "3600000",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"delay_id": "d3"})))
            .expect(1)
            .mount(server.server())
            .await;

        let sticky = DelayedEvent {
            sticky_duration_ms: Some(3_600_000),
            ..event(None)
        };
        let delay_id = send(&client, support(&client).await.unwrap(), sticky)
            .await
            .unwrap();
        assert_eq!(delay_id, "d3");
    }

    #[tokio::test]
    async fn an_unstable_server_keeps_the_msc4140_endpoints() {
        let (server, client) = client_with(json!({"org.matrix.msc4140": true})).await;
        Mock::given(method("PUT"))
            .and(path(
                "/_matrix/client/v3/rooms/!room:example.org/state/m.room.message/key",
            ))
            .and(query_param("org.matrix.msc4140.delay", "5000"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"delay_id": "d2"})))
            .expect(1)
            .mount(server.server())
            .await;
        Mock::given(method("POST"))
            .and(path(
                "/_matrix/client/unstable/org.matrix.msc4140/delayed_events/d2",
            ))
            .and(body_json(json!({"action": "restart"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({})))
            .expect(1)
            .mount(server.server())
            .await;

        let delay_id = send(&client, support(&client).await.unwrap(), event(Some("key")))
            .await
            .unwrap();
        assert_eq!(delay_id, "d2");
        update(&client, delay_id, UpdateAction::Restart)
            .await
            .unwrap();
    }

    #[test]
    fn support_reads_both_flags() {
        let stable_only =
            DelayedEventsSupport::from_features(&["org.matrix.msc4140.stable".into()].into());
        assert!(stable_only.any());
        assert!(!stable_only.can_list());
        assert!(!DelayedEventsSupport::from_features(&std::collections::BTreeSet::new()).any());
    }
}
