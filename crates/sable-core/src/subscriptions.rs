use std::{collections::HashMap, sync::Arc};

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::event_cache::PaginationStatus;
use matrix_sdk::executor::{JoinHandleExt, spawn};
use matrix_sdk::ruma::OwnedRoomId;
use matrix_sdk_ui::room_list_service::RoomListLoadingState;
use matrix_sdk_ui::room_list_service::filters::{
    new_filter_all, new_filter_deduplicate_versions, new_filter_non_left,
};

use crate::protocol::{CommandErr, CommandOk, CoreEvent, SubscriptionId, TimelineFocusView};

use crate::timelines::{build_room_timeline, fill_sender_profiles};
use crate::view;
use crate::{Core, Subscription, SubscriptionKind};

const ROOM_LIST_PAGE_SIZE: usize = 200;

const fn pages_for(total: u32) -> usize {
    (total as usize).div_ceil(ROOM_LIST_PAGE_SIZE)
}

impl Core {
    pub(crate) async fn subscribe_room_list(self: &Arc<Self>) -> Result<CommandOk, CommandErr> {
        let sync_service = {
            let guard = self.session.read().await;
            guard
                .as_ref()
                .ok_or(CommandErr::NotLoggedIn)?
                .sync_service
                .clone()
        };

        let subscription = self.allocate_subscription();
        let core = self.clone();

        let client = {
            let guard = self.session.read().await;
            guard
                .as_ref()
                .ok_or(CommandErr::NotLoggedIn)?
                .client
                .clone()
        };

        let task = spawn(async move {
            let room_list = match sync_service.room_list_service().all_rooms().await {
                Ok(room_list) => room_list,
                Err(error) => {
                    tracing::error!("all_rooms failed: {error}");
                    return;
                }
            };

            let loading = room_list.loading_state();
            let (stream, controller) = room_list.entries_with_dynamic_adapters(ROOM_LIST_PAGE_SIZE);
            controller.set_filter(Box::new(new_filter_all(vec![
                Box::new(new_filter_non_left()),
                Box::new(new_filter_deduplicate_versions()),
            ])));

            // Stable over a stream's life, so resolved once per room.
            let mut room_cache: HashMap<OwnedRoomId, view::RoomInfo> = HashMap::new();

            let mut stream = Box::pin(stream);
            let mut grown_to = 0;
            while let Some(diffs) = stream.next().await {
                if let RoomListLoadingState::Loaded {
                    maximum_number_of_rooms: Some(total),
                } = loading.get()
                    && total > grown_to
                {
                    for _ in 0..pages_for(total) {
                        controller.add_one_page();
                    }
                    grown_to = total;
                }

                view::prime_display_names(&diffs).await;
                for diff in &diffs {
                    view::enrich_room_fields(&client, diff, &mut room_cache).await;
                }
                core.emit(CoreEvent::RoomListDiff {
                    subscription,
                    diffs: diffs
                        .into_iter()
                        .map(|diff| {
                            view::map_diff(diff, |item| view::room_summary(item, &room_cache))
                        })
                        .collect(),
                });
            }
        })
        .abort_on_drop();

        self.subscriptions.lock().await.insert(
            subscription,
            Subscription {
                tasks: vec![task],
                timeline: None,
                kind: SubscriptionKind::Other,
            },
        );

        // The filter makes the stream open with a `Reset` carrying everything.
        Ok(CommandOk::SubscribeRoomList {
            subscription,
            rooms: Vec::new(),
        })
    }

    #[allow(clippy::arc_with_non_send_sync)] // Matrix timelines are single-threaded on WASM
    pub(crate) async fn subscribe_timeline(
        self: &Arc<Self>,
        room_id: OwnedRoomId,
        focus: TimelineFocusView,
        hidden_events: bool,
    ) -> Result<CommandOk, CommandErr> {
        let subscription = self.allocate_subscription();
        let live_room_id = matches!(focus, TimelineFocusView::Live).then(|| room_id.clone());
        let room = self.room(&room_id).await?;
        let timeline = match &focus {
            TimelineFocusView::Live => self.live_timeline(&room_id, hidden_events).await?,
            TimelineFocusView::Thread { root_event_id } => {
                self.thread_timeline(&room_id, root_event_id).await?
            }
            TimelineFocusView::Event { .. } => Arc::new(
                build_room_timeline(&room, &focus, hidden_events)
                    .await
                    .map_err(|error| self.failed("build focused timeline", error))?,
            ),
        };
        fill_sender_profiles(&room, &timeline);
        let relays = Arc::new(room.service_members().unwrap_or_default());

        // The SDK replaces its explicit-room set wholesale. Register before
        // computing the union so concurrent live subscriptions see each other.
        let _update = self.room_subscription_lock.lock().await;
        self.subscriptions.lock().await.insert(
            subscription,
            Subscription {
                tasks: Vec::new(),
                timeline: Some(timeline.clone()),
                kind: live_room_id.clone().map_or(
                    SubscriptionKind::FocusedTimeline,
                    SubscriptionKind::LiveTimeline,
                ),
            },
        );
        if let Err(error) = self.sync_timeline_rooms_locked(live_room_id.as_ref()).await {
            self.subscriptions.lock().await.remove(&subscription);
            return Err(error);
        }
        let (items, stream) = timeline.subscribe().await;
        let pagination = timeline.live_back_pagination_status().await;
        let own_user_id = self.client().await?.user_id().map(ToOwned::to_owned);
        let core = self.clone();
        let stream_user_id = own_user_id.clone();
        let stream_relays = relays.clone();
        let task = spawn(async move {
            pin_mut!(stream);
            while let Some(diffs) = stream.next().await {
                core.emit(CoreEvent::TimelineDiff {
                    subscription,
                    diffs: diffs
                        .into_iter()
                        .map(|diff| {
                            view::map_diff(diff, |item| {
                                view::timeline_item(item, stream_user_id.as_deref(), &stream_relays)
                            })
                        })
                        .collect(),
                });
            }
        })
        .abort_on_drop();
        let (initial_status, status_task) = pagination.map_or((None, None), |(status, stream)| {
            let core = self.clone();
            (
                Some(status),
                Some(
                    spawn(async move {
                        let mut status = Box::pin(stream);
                        while let Some(status) = status.next().await {
                            core.emit(timeline_pagination_event(subscription, status));
                        }
                    })
                    .abort_on_drop(),
                ),
            )
        });
        let mut subscriptions = self.subscriptions.lock().await;
        let Some(entry) = subscriptions.get_mut(&subscription) else {
            return Err(CommandErr::Unavailable);
        };
        entry.tasks = status_task.into_iter().chain([task]).collect();
        if let Some(status) = initial_status {
            self.emit(timeline_pagination_event(subscription, status));
        }

        Ok(CommandOk::SubscribeTimeline {
            subscription,
            items: items
                .iter()
                .map(|item| view::timeline_item(item, own_user_id.as_deref(), &relays))
                .collect(),
        })
    }

    pub(crate) async fn sync_timeline_rooms_locked(
        &self,
        pending_room: Option<&OwnedRoomId>,
    ) -> Result<(), CommandErr> {
        let subscriptions = self.subscriptions.lock().await;
        let room_ids = subscriptions
            .values()
            .filter_map(|subscription| match &subscription.kind {
                SubscriptionKind::LiveTimeline(room_id) => Some(room_id.clone()),
                SubscriptionKind::Other | SubscriptionKind::FocusedTimeline => None,
            })
            .chain(pending_room.cloned())
            .collect::<std::collections::HashSet<_>>();
        drop(subscriptions);
        let room_refs = room_ids.iter().map(OwnedRoomId::as_ref).collect::<Vec<_>>();
        self.sync_service()
            .await?
            .room_list_service()
            .subscribe_to_rooms(&room_refs)
            .await;
        Ok(())
    }
}

pub(crate) const fn timeline_pagination_event(
    subscription: SubscriptionId,
    status: PaginationStatus,
) -> CoreEvent {
    match status {
        PaginationStatus::Paginating => CoreEvent::TimelinePagination {
            subscription,
            loading: true,
            reached_start: false,
        },
        PaginationStatus::Idle { hit_timeline_start } => CoreEvent::TimelinePagination {
            subscription,
            loading: false,
            reached_start: hit_timeline_start,
        },
    }
}
