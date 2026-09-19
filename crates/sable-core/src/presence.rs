use std::sync::Arc;
use std::time::Duration;

use futures_util::stream::{self, StreamExt};
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::OwnedUserId;
use matrix_sdk::ruma::api::client::filter::{FilterDefinition, RoomFilter};
use matrix_sdk::ruma::api::client::presence::get_presence;
use matrix_sdk::ruma::api::client::sync::sync_events;
use matrix_sdk::ruma::events::presence::PresenceEvent;
use matrix_sdk::ruma::presence::PresenceState;

use crate::Core;
use crate::protocol::{CoreEvent, PresenceView};

const POLL_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_GAP: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_mins(1);
const FETCH_CONCURRENCY: usize = 8;

pub(crate) const fn view(state: &PresenceState) -> PresenceView {
    match state {
        PresenceState::Online => PresenceView::Online,
        PresenceState::Offline => PresenceView::Offline,
        // `PresenceState` is non-exhaustive. Anything added later reads as
        // away, not online.
        _ => PresenceView::Unavailable,
    }
}

pub(crate) const fn state(view: PresenceView) -> PresenceState {
    match view {
        PresenceView::Online => PresenceState::Online,
        PresenceView::Offline => PresenceState::Offline,
        PresenceView::Unavailable => PresenceState::Unavailable,
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

impl Core {
    pub(crate) fn desired_presence(&self) -> PresenceView {
        *self
            .desired_presence
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn set_desired_presence(&self, presence: PresenceView) {
        *self
            .desired_presence
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = presence;
    }

    pub(crate) fn watch_presence(self: &Arc<Self>, client: &matrix_sdk::Client, generation: u64) {
        let core = self.clone();
        let client = client.clone();

        self.track_session_task(
            spawn(async move {
                let mut since: Option<String> = None;

                loop {
                    let mut request = sync_events::v3::Request::new();
                    request.filter =
                        Some(sync_events::v3::Filter::FilterDefinition(presence_filter()));
                    request.since.clone_from(&since);
                    request.timeout = Some(POLL_TIMEOUT);
                    request.set_presence = state(core.desired_presence());

                    match client
                        .send(request)
                        .with_request_config(
                            matrix_sdk::config::RequestConfig::short_retry()
                                .timeout(REQUEST_TIMEOUT),
                        )
                        .await
                    {
                        Ok(response) => {
                            for raw in response.presence.events {
                                let Ok(event) = raw.deserialize() else {
                                    continue;
                                };
                                core.emit_if_current(generation, presence_event(&event));
                            }
                            since = Some(response.next_batch);
                        }
                        Err(error) => {
                            tracing::debug!("presence sync failed: {error}");
                        }
                    }

                    if core
                        .session_generation
                        .load(std::sync::atomic::Ordering::SeqCst)
                        != generation
                    {
                        break;
                    }

                    matrix_sdk::sleep::sleep(POLL_GAP).await;
                }
            })
            .abort_on_drop(),
        );
    }

    pub(crate) async fn fetch_presence(self: &Arc<Self>, user_ids: Vec<OwnedUserId>) {
        let Ok(client) = self.client().await else {
            return;
        };
        let generation = self
            .session_generation
            .load(std::sync::atomic::Ordering::SeqCst);

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

                    core.emit_if_current(
                        generation,
                        CoreEvent::Presence {
                            user_id,
                            presence: view(&response.presence),
                            status_message: response.status_msg,
                            last_active_ago: response
                                .last_active_ago
                                .map(|ago| u64::try_from(ago.as_millis()).unwrap_or(u64::MAX)),
                        },
                    );
                }
            })
            .await;
    }
}

fn presence_event(event: &PresenceEvent) -> CoreEvent {
    CoreEvent::Presence {
        user_id: event.sender.clone(),
        presence: view(&event.content.presence),
        status_message: event.content.status_msg.clone(),
        last_active_ago: event.content.last_active_ago.map(Into::into),
    }
}

#[cfg(test)]
mod tests {
    use super::presence_filter;

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
