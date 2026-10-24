use std::sync::Arc;

use matrix_sdk::room::{ListThreadsOptions, Receipts};
use matrix_sdk::ruma::api::Direction;
use matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType;
use matrix_sdk::ruma::api::client::room::get_event_by_timestamp;
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::fully_read::FullyReadEventContent;
use matrix_sdk::ruma::{MilliSecondsSinceUnixEpoch, OwnedEventId, OwnedRoomId, OwnedUserId, UInt};
use matrix_sdk_base::read_receipts::ReadReceipts;
use matrix_sdk_ui::timeline::{RoomExt, TimelineFocus};
use serde::{Deserialize, Serialize};

use super::{Handler, Json};
use crate::protocol::{RpcError, EditVersionView, PaginationDirection, PinReadStateView, RelationsView, RoomListItemView, SubscriptionId, TimelineItemView};
use sable_model::timeline::TimelineKey;
use crate::thread_receipts::thread_receipts;
use crate::timelines::receipt_thread_root;
use crate::widgets::RelationsFilter;
use crate::{Core, ResultExt, SubscriptionKind, view};

domain! {
    subscribe_room_list,
    subscribe,
    unsubscribe,
    warm_rooms,
    paginate,
    fetch_event_details,
    event_items,
    events,
    timestamp_to_event,
    list_threads,
    event_source,
    edit_history,
    mark_read,
    set_fully_read,
    mark_unread,
    read_marker,
    unread_diagnostics,
    retry_decryption,
    room_event_relations,
    pinned_events,
    set_pinned,
    pin_read_state,
    mark_pins_seen,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimelineFocusView {
    #[default]
    Live,
    Event {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        event_id: OwnedEventId,
    },
    Thread {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        root_event_id: OwnedEventId,
    },
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SubscribeRoomListParams {}

/// The snapshot. Everything after it carries the same `subscription`.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SubscribeRoomListOk {
    pub subscription: SubscriptionId,
    pub rooms: Vec<RoomListItemView>,
}

impl Handler for SubscribeRoomListParams {
    type Ok = SubscribeRoomListOk;

    async fn run(self, core: &Arc<Core>) -> Result<SubscribeRoomListOk, RpcError> {
        core.subscribe_room_list().await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SubscribeParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub key: Option<TimelineKey>,
    #[serde(default)]
    pub focus: TimelineFocusView,
    /// Relaxes the event filter so events the SDK would otherwise drop
    /// arrive as `HiddenEvent`. Baked into the timeline, so flipping it
    /// means re-subscribing.
    pub hidden_events: bool,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SubscribeOk {
    pub subscription: SubscriptionId,
    pub items: Vec<TimelineItemView>,
    pub aggregations: Vec<TimelineItemView>,
}

impl Handler for SubscribeParams {
    type Ok = SubscribeOk;

    async fn run(self, core: &Arc<Core>) -> Result<SubscribeOk, RpcError> {
        core.subscribe_timeline(self)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UnsubscribeParams {
    pub subscription: SubscriptionId,
}

impl Handler for UnsubscribeParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let mut subscribed = core.room_subscriptions.lock().await;
        let Some(removed) = core.subscriptions.lock().await.remove(&self.subscription) else {
            return Err(RpcError::UnknownSubscription);
        };
        let has_room = !matches!(removed.kind, SubscriptionKind::Other);
        drop(removed);
        if has_room {
            core.sync_timeline_rooms_locked(&mut subscribed).await?;
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct WarmRoomsParams {
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub room_ids: Vec<OwnedRoomId>,
}

impl Handler for WarmRoomsParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.warm_rooms(self).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PaginateParams {
    pub subscription: SubscriptionId,
    pub direction: PaginationDirection,
    pub count: u16,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PaginateOk {
    pub direction: PaginationDirection,
    pub reached_end: bool,
}

impl Handler for PaginateParams {
    type Ok = PaginateOk;

    async fn run(self, core: &Arc<Core>) -> Result<PaginateOk, RpcError> {
        let Self {
            subscription,
            direction,
            count,
        } = self;
        let (timeline, focused, thread) = core
            .subscriptions
            .lock()
            .await
            .get(&subscription)
            .and_then(|subscription| {
                subscription.timeline.clone().map(|timeline| {
                    (
                        timeline,
                        matches!(subscription.kind, SubscriptionKind::FocusedTimeline(_)),
                        subscription.thread_root.is_some(),
                    )
                })
            })
            .ok_or(RpcError::UnknownSubscription)?;
        if matches!(direction, PaginationDirection::Forward) && !focused {
            return Err(RpcError::InvalidPaginationDirection);
        }
        if matches!(direction, PaginationDirection::Forward) && thread {
            return Ok(PaginateOk {
                direction,
                reached_end: true,
            });
        }
        let _foreground = core.begin_foreground_pagination();
        let reached_end = match direction {
            PaginationDirection::Backward => timeline.paginate_backwards(count).await,
            PaginationDirection::Forward => timeline.paginate_forwards(count).await,
        }
        .or_failed(core, "paginate")?;

        Ok(PaginateOk {
            direction,
            reached_end,
        })
    }
}

/// The details arrive as a timeline diff.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct FetchEventDetailsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
}

impl Handler for FetchEventDetailsParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.fetch_event_details(&self.room_id, &self.event_id, self.thread_root.as_ref())
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EventItemsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub event_ids: Vec<OwnedEventId>,
}

impl Handler for EventItemsParams {
    type Ok = Vec<TimelineItemView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<TimelineItemView>, RpcError> {
        core.event_items(&self.room_id, &self.event_ids).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EventsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub event_type: String,
    #[serde(default)]
    pub msgtype: Option<String>,
    #[serde(default)]
    pub state_key: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub limit: u32,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub since: Option<OwnedEventId>,
}

impl Handler for EventsParams {
    type Ok = Vec<Json>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<Json>, RpcError> {
        core.room_timeline_events(
            &self.room_id,
            &self.event_type,
            self.msgtype.as_deref(),
            self.state_key.as_deref(),
            self.limit,
            self.since.as_ref(),
        )
        .await
        .map(|events| events.into_iter().map(Json).collect())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct TimestampToEventParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub ts: u64,
    pub direction: PaginationDirection,
}

impl Handler for TimestampToEventParams {
    type Ok = Option<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<String>, RpcError> {
        let request = get_event_by_timestamp::v1::Request::new(
            self.room_id,
            MilliSecondsSinceUnixEpoch(UInt::new_saturating(self.ts)),
            match self.direction {
                PaginationDirection::Backward => Direction::Backward,
                PaginationDirection::Forward => Direction::Forward,
            },
        );

        match core.client().await?.send(request).await {
            Ok(response) => Ok(Some(response.event_id.to_string())),
            Err(error) if error.client_api_error_kind() == Some(&ErrorKind::NotFound) => Ok(None),
            Err(error) => Err(core.homeserver_http_error("timestamp_to_event", error)),
        }
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ListThreadsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ListThreadsOk {
    pub roots: Vec<TimelineItemView>,
    pub next_batch: Option<String>,
}

impl Handler for ListThreadsParams {
    type Ok = ListThreadsOk;

    async fn run(self, core: &Arc<Core>) -> Result<ListThreadsOk, RpcError> {
        let room = core.room(&self.room_id).await?;
        let options = ListThreadsOptions {
            from: self.from,
            ..ListThreadsOptions::default()
        };
        let threads = room
            .list_threads(options)
            .await
            .map_err(|error| core.room_error("list_threads", error))?;

        let push = room.push_context().await.ok().flatten();
        let roots = futures_util::future::join_all(
            threads
                .chunk
                .into_iter()
                .map(|event| view::standalone_item(core, &room, event, None, push.as_ref())),
        )
        .await
        .into_iter()
        .flatten()
        .collect();

        Ok(ListThreadsOk {
            roots,
            next_batch: threads.prev_batch_token,
        })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EventSourceParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    pub include_original: bool,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EventSourceOk {
    pub source: String,
    pub encrypted: bool,
    pub original: Option<String>,
}

impl Handler for EventSourceParams {
    type Ok = EventSourceOk;

    async fn run(self, core: &Arc<Core>) -> Result<EventSourceOk, RpcError> {
        let (source, encrypted, original) = core
            .event_source(&self.room_id, &self.event_id, self.include_original)
            .await?;
        Ok(EventSourceOk {
            source,
            encrypted,
            original,
        })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct EditHistoryParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
}

impl Handler for EditHistoryParams {
    type Ok = Vec<EditVersionView>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<EditVersionView>, RpcError> {
        core.edit_history(&self.room_id, &self.event_id).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MarkReadParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub event_id: Option<OwnedEventId>,
    #[serde(default)]
    pub private_receipt: bool,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    #[serde(default)]
    pub subscription: Option<SubscriptionId>,
    #[serde(default)]
    pub fully_read: bool,
}

fn receipt_sent<T>(core: &Core, result: matrix_sdk::Result<T>) -> Result<(), RpcError> {
    match result {
        Ok(_) => Ok(()),
        Err(error)
            if matches!(
                error.client_api_error_kind(),
                Some(ErrorKind::NotFound | ErrorKind::InvalidParam)
            ) =>
        {
            tracing::info!(context = "mark_read", "the receipt target is gone");
            Ok(())
        }
        Err(error) => Err(core.failed("mark_read", error)),
    }
}

impl Handler for MarkReadParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let receipt_type = if self.private_receipt {
            ReceiptType::ReadPrivate
        } else {
            ReceiptType::Read
        };

        let Some(event_id) = self.event_id else {
            let room = core.room(&self.room_id).await?;
            let timeline = room
                .timeline_builder()
                .with_focus(TimelineFocus::Live {
                    hide_threaded_events: false,
                })
                .build()
                .await
                .or_failed(core, "build_mark_read_timeline")?;
            receipt_sent(core, timeline
                .mark_as_read(receipt_type.clone()).await)?;
            let main = room
                .timeline_builder()
                .with_focus(TimelineFocus::Live {
                    hide_threaded_events: true,
                })
                .build()
                .await
                .or_failed(core, "build_mark_read_timeline")?;
            receipt_sent(core, main.mark_as_read(receipt_type).await)?;
            receipt_sent(core, timeline
                .mark_as_read(ReceiptType::FullyRead).await)?;
            return Ok(());
        };

        let room = core.room(&self.room_id).await?;
        let thread_root = receipt_thread_root(&room, &event_id, self.thread_root.clone()).await;
        let timeline = if thread_root == self.thread_root {
            core.subscribed_timeline(&self.room_id, thread_root.as_ref(), self.subscription)
                .await?
        } else {
            core.timeline_for(&self.room_id, thread_root.as_ref())
                .await?
        };
        receipt_sent(core, timeline
            .send_single_receipt(receipt_type, event_id.clone()).await)?;
        if self.fully_read && thread_root.is_none() {
            receipt_sent(core, timeline
                .send_multiple_receipts(Receipts::new().fully_read_marker(event_id)).await)?;
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetFullyReadParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
}

impl Handler for SetFullyReadParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        core.room(&self.room_id)
            .await?
            .send_multiple_receipts(Receipts::new().fully_read_marker(self.event_id))
            .await
            .map_err(|error| core.room_error("set_fully_read", error))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MarkUnreadParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub read_marker: Option<OwnedEventId>,
}

impl Handler for MarkUnreadParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let room = core.room(&self.room_id).await?;

        if let Some(event_id) = self.read_marker {
            room.send_multiple_receipts(Receipts::new().fully_read_marker(event_id))
                .await
                .map_err(|error| core.room_error("mark_unread_marker", error))?;
        }

        room.set_unread_flag(true)
            .await
            .map_err(|error| core.room_error("mark_unread", error))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ReadMarkerParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for ReadMarkerParams {
    type Ok = Option<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Option<String>, RpcError> {
        let room = core.room(&self.room_id).await?;
        let fully_read = core
            .with_open_stores(async || room.account_data_static::<FullyReadEventContent>().await)
            .await
            .map_err(|error| core.room_error("read_marker", error))?
            .and_then(|raw| raw.deserialize().ok())
            .map(|event| event.content.event_id);
        let event_id = fully_read.or_else(|| {
            room.read_receipts()
                .latest_active
                .map(|receipt| receipt.event_id)
        });
        Ok(event_id.map(|event_id| event_id.to_string()))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UnreadDiagnosticsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct TimelineReadDiagnostics {
    pub unread: u32,
    pub notifying: u32,
    pub highlight: u32,
    pub receipt_event_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ThreadReadDiagnostics {
    pub root_event_id: String,
    #[serde(flatten)]
    pub read: TimelineReadDiagnostics,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct UnreadDiagnosticsView {
    pub main: TimelineReadDiagnostics,
    pub server_notifications: u32,
    pub server_highlights: u32,
    pub threads: Vec<ThreadReadDiagnostics>,
}

fn count(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn read_diagnostics(receipts: &ReadReceipts) -> TimelineReadDiagnostics {
    TimelineReadDiagnostics {
        unread: count(receipts.num_unread),
        notifying: count(receipts.num_notifications),
        highlight: count(receipts.num_mentions),
        receipt_event_id: receipts
            .latest_active
            .as_ref()
            .map(|receipt| receipt.event_id.to_string()),
    }
}

impl Handler for UnreadDiagnosticsParams {
    type Ok = UnreadDiagnosticsView;

    async fn run(self, core: &Arc<Core>) -> Result<UnreadDiagnosticsView, RpcError> {
        let room = core.room(&self.room_id).await?;
        let server = room.unread_notification_counts();
        Ok(UnreadDiagnosticsView {
            main: read_diagnostics(&room.read_receipts()),
            server_notifications: count(server.notification_count),
            server_highlights: count(server.highlight_count),
            threads: thread_receipts(&room)
                .await
                .into_iter()
                .map(|(root, receipts)| ThreadReadDiagnostics {
                    root_event_id: root.to_string(),
                    read: read_diagnostics(&receipts),
                })
                .collect(),
        })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RetryDecryptionParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub session_id: String,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub sender: OwnedUserId,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
}

impl Handler for RetryDecryptionParams {
    type Ok = ();

    async fn run(self, core: &Arc<Core>) -> Result<(), RpcError> {
        let sender = self.sender;
        let timeline = core
            .timeline_for(&self.room_id, self.thread_root.as_ref())
            .await?;
        if let Err(error) = core
            .client()
            .await?
            .encryption()
            .request_user_identity(&sender)
            .await
        {
            tracing::warn!(%error, %sender, "refreshing sender identity before decryption retry failed");
        }
        timeline.retry_decryption([self.session_id]).await;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct RoomEventRelationsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    #[serde(default)]
    pub rel_type: Option<String>,
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub limit: Option<u32>,
    #[serde(default)]
    pub direction: Option<PaginationDirection>,
}

impl Handler for RoomEventRelationsParams {
    type Ok = RelationsView;

    async fn run(self, core: &Arc<Core>) -> Result<RelationsView, RpcError> {
        core.room_event_relations(
            &self.room_id,
            &self.event_id,
            RelationsFilter {
                rel_type: self.rel_type.as_deref(),
                event_type: self.event_type.as_deref(),
                from: self.from.as_deref(),
                to: self.to.as_deref(),
                limit: self.limit,
                direction: self.direction,
            },
        )
        .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PinnedEventsParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for PinnedEventsParams {
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
        let event_ids = core.pinned_events(&self.room_id).await?;
        Ok(event_ids.iter().map(ToString::to_string).collect())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetPinnedParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    pub pinned: bool,
}

impl Handler for SetPinnedParams {
    type Ok = Vec<String>;

    async fn run(self, core: &Arc<Core>) -> Result<Vec<String>, RpcError> {
        let event_ids = core
            .set_pinned_with_marker(&self.room_id, self.event_id, self.pinned)
            .await?;
        Ok(event_ids.iter().map(ToString::to_string).collect())
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct PinReadStateParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl Handler for PinReadStateParams {
    type Ok = PinReadStateView;

    async fn run(self, core: &Arc<Core>) -> Result<PinReadStateView, RpcError> {
        core.pin_read_state(&self.room_id).await
    }
}

/// Marks `pinned_ids`, the list the reader is looking at, as seen.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct MarkPinsSeenParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub pinned_ids: Vec<OwnedEventId>,
}

impl Handler for MarkPinsSeenParams {
    type Ok = PinReadStateView;

    async fn run(self, core: &Arc<Core>) -> Result<PinReadStateView, RpcError> {
        core.mark_pins_seen(&self.room_id, self.pinned_ids).await
    }
}
