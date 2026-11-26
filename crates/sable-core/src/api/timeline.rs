use std::sync::Arc;
use std::sync::atomic::Ordering;

use matrix_sdk::room::{ListThreadsOptions, Receipts};
use matrix_sdk::ruma::api::Direction;
use matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType;
use matrix_sdk::ruma::api::client::room::get_event_by_timestamp;
use matrix_sdk::ruma::api::client::threads::get_threads::v1::IncludeThreads;
use matrix_sdk::ruma::api::error::ErrorKind;
use matrix_sdk::ruma::events::fully_read::FullyReadEventContent;
use matrix_sdk::ruma::events::receipt::{ReceiptThread, ReceiptType as StoredReceiptType};
use matrix_sdk::ruma::{EventId, MilliSecondsSinceUnixEpoch, OwnedEventId, OwnedRoomId, UInt, UserId};
use matrix_sdk_base::read_receipts::ReadReceipts;
use matrix_sdk_ui::timeline::{RoomExt, Timeline, TimelineFocus};
use serde::{Deserialize, Serialize};

use super::{Handler, SessionHandler, Json};
use crate::protocol::{
    EditVersionView, PaginationDirection, PinReadStateView, RelationsView, RoomListItemView,
    RoomListOptionsView, RpcCode, RpcError, SubscriptionId, ThreadReplyView, TimelineItemView,
    UnredactedEventView,
};
use crate::thread_receipts::thread_receipts;
use crate::timelines::receipt_thread_root;
use crate::widgets::RelationsFilter;
use crate::{Core, ResultExt, SubscriptionKind, view, SignedIn};

domain! {
    subscribe_room_list,
    set_room_list_options,
    subscribe,
    unsubscribe,
    warm_rooms,
    paginate,
    fetch_event_details,
    event_items,
    events,
    timestamp_to_event,
    list_threads,
    thread_replies,
    event_source,
    unredacted_event,
    edit_history,
    mark_read,
    set_fully_read,
    mark_unread,
    read_marker,
    unread_diagnostics,
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

#[derive(Debug, Default, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SubscribeRoomListParams {
    #[serde(default)]
    pub options: RoomListOptionsView,
}

/// The snapshot. Everything after it carries the same `subscription`.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SubscribeRoomListOk {
    pub subscription: SubscriptionId,
    pub rooms: Vec<RoomListItemView>,
}

impl SessionHandler for SubscribeRoomListParams {
    type Ok = SubscribeRoomListOk;

    async fn run(self, session: &SignedIn) -> Result<SubscribeRoomListOk, RpcError> {
        session.subscribe_room_list(self.options).await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SetRoomListOptionsParams {
    pub options: RoomListOptionsView,
}

impl Handler for SetRoomListOptionsParams {
    type Ok = ();

    fn run(self, core: &Arc<Core>) -> impl Future<Output = Result<(), RpcError>> {
        core.room_list_options.send_replace(self.options);
        std::future::ready(Ok(()))
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct SubscribeParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
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

impl SessionHandler for SubscribeParams {
    type Ok = SubscribeOk;

    async fn run(self, session: &SignedIn) -> Result<SubscribeOk, RpcError> {
        session.subscribe_timeline(self)
            .await
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UnsubscribeParams {
    pub subscription: SubscriptionId,
}

impl SessionHandler for UnsubscribeParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let session_state = session.state();
        let mut subscribed = session_state.room_subscriptions.lock().await;
        let Some(removed) = session_state
            .subscriptions
            .lock()
            .remove(&self.subscription)
        else {
            return Err(RpcCode::UnknownSubscription.into());
        };
        let has_room = !matches!(removed.kind, SubscriptionKind::Other);
        drop(removed);
        if has_room {
            session.sync_timeline_rooms_locked(&mut subscribed)
                .await?;
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

impl SessionHandler for WarmRoomsParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.warm_rooms(self).await
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

impl SessionHandler for PaginateParams {
    type Ok = PaginateOk;
    const ENDS_WITH_SESSION: bool = true;

    async fn run(self, session: &SignedIn) -> Result<PaginateOk, RpcError> {
        let Self {
            subscription,
            direction,
            count,
        } = self;
        let (timeline, focused, thread) = session
            .state().subscriptions
            .lock()
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
            .ok_or(RpcCode::UnknownSubscription)?;
        if matches!(direction, PaginationDirection::Forward) && !focused {
            return Err(RpcCode::InvalidPaginationDirection.into());
        }
        if matches!(direction, PaginationDirection::Forward) && thread {
            return Ok(PaginateOk {
                direction,
                reached_end: true,
            });
        }
        let _foreground = session.core().begin_foreground_pagination();
        let reached_end = match direction {
            PaginationDirection::Backward => timeline.paginate_backwards(count).await,
            PaginationDirection::Forward => timeline.paginate_forwards(count).await,
        }
        .or_failed(session.core(), "paginate")?;

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
    /// The timeline showing the event, since a linked message's context is not the live one.
    #[serde(default)]
    pub subscription: Option<SubscriptionId>,
}

impl SessionHandler for FetchEventDetailsParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.fetch_event_details(
            &self.room_id,
            &self.event_id,
            self.thread_root.as_ref(),
            self.subscription,
        )
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

impl SessionHandler for EventItemsParams {
    type Ok = Vec<TimelineItemView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<TimelineItemView>, RpcError> {
        session.event_items(&self.room_id, &self.event_ids).await
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

impl SessionHandler for EventsParams {
    type Ok = Vec<Json>;

    async fn run(self, session: &SignedIn) -> Result<Vec<Json>, RpcError> {
        session.room_timeline_events(
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

impl SessionHandler for TimestampToEventParams {
    type Ok = Option<String>;

    async fn run(self, session: &SignedIn) -> Result<Option<String>, RpcError> {
        let request = get_event_by_timestamp::v1::Request::new(
            self.room_id,
            MilliSecondsSinceUnixEpoch(UInt::new_saturating(self.ts)),
            match self.direction {
                PaginationDirection::Backward => Direction::Backward,
                PaginationDirection::Forward => Direction::Forward,
            },
        );

        match session.client().send(request).await {
            Ok(response) => Ok(Some(response.event_id.to_string())),
            Err(error) if error.client_api_error_kind() == Some(&ErrorKind::NotFound) => Ok(None),
            Err(error) => Err(session.core().rpc_error("timestamp_to_event", &error)),
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
    #[serde(default)]
    pub participated: bool,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ListThreadsOk {
    pub roots: Vec<TimelineItemView>,
    pub next_batch: Option<String>,
}

impl SessionHandler for ListThreadsParams {
    type Ok = ListThreadsOk;

    async fn run(self, session: &SignedIn) -> Result<ListThreadsOk, RpcError> {
        let room = session.room(&self.room_id)?;
        let options = ListThreadsOptions {
            from: self.from,
            limit: Some(UInt::from(50u32)),
            include_threads: if self.participated {
                IncludeThreads::Participated
            } else {
                IncludeThreads::All
            },
        };
        let threads = room
            .list_threads(options)
            .await
            .or_failed(session.core(), "list_threads")?;

        let push = room.push_context().await.ok().flatten();
        let roots = futures_util::future::join_all(
            threads
                .chunk
                .into_iter()
                .map(|event| view::standalone_item(session, &room, event, None, push.as_ref())),
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
pub struct ThreadRepliesParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub root_event_id: OwnedEventId,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub limit: Option<u32>,
}

impl SessionHandler for ThreadRepliesParams {
    type Ok = Vec<ThreadReplyView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<ThreadReplyView>, RpcError> {
        let page = session
            .room_event_relations(
                &self.room_id,
                &self.root_event_id,
                RelationsFilter {
                    rel_type: Some("m.thread"),
                    event_type: None,
                    from: None,
                    to: None,
                    limit: Some(self.limit.unwrap_or(50)),
                    direction: Some(PaginationDirection::Backward),
                },
            )
            .await?;
        Ok(page.chunk.iter().filter_map(view::thread_reply).collect())
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
    pub encryption: Option<String>,
}

impl SessionHandler for EventSourceParams {
    type Ok = EventSourceOk;

    async fn run(self, session: &SignedIn) -> Result<EventSourceOk, RpcError> {
        let (source, encrypted, original, encryption) = session
            .event_source(&self.room_id, &self.event_id, self.include_original)
            .await?;
        Ok(EventSourceOk {
            source,
            encrypted,
            original,
            encryption,
        })
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct UnredactedEventParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
}

impl SessionHandler for UnredactedEventParams {
    type Ok = UnredactedEventView;

    async fn run(self, session: &SignedIn) -> Result<UnredactedEventView, RpcError> {
        session.unredacted_event(&self.room_id, &self.event_id).await
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

impl SessionHandler for EditHistoryParams {
    type Ok = Vec<EditVersionView>;

    async fn run(self, session: &SignedIn) -> Result<Vec<EditVersionView>, RpcError> {
        session.edit_history(&self.room_id, &self.event_id).await
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
        Err(error) => Err(core.failed_with("mark_read", &error)),
    }
}

/// Hidden events after the last shown one, such as call memberships, still count as
/// notifications, so reading the last shown event has to cover them too.
async fn past_hidden_events(timeline: &Timeline, event_id: &EventId) -> OwnedEventId {
    let last_shown = timeline
        .items()
        .await
        .iter()
        .rev()
        .find_map(|item| item.as_event()?.event_id().map(ToOwned::to_owned));
    if last_shown.as_deref() == Some(event_id)
        && let Some(latest) = timeline.latest_event_id().await
    {
        return latest;
    }
    event_id.to_owned()
}

impl SessionHandler for MarkReadParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let receipt_type = if session.core().settings.private_receipts.load(Ordering::Relaxed) {
            ReceiptType::ReadPrivate
        } else {
            ReceiptType::Read
        };

        let Some(event_id) = self.event_id else {
            let room = session.room(&self.room_id)?;
            let timeline = room
                .timeline_builder()
                .with_focus(TimelineFocus::Live {
                    hide_threaded_events: false,
                })
                .build()
                .await
                .or_failed(session.core(), "build_mark_read_timeline")?;
            receipt_sent(session.core(), timeline
                .mark_as_read(receipt_type.clone()).await)?;
            // The cached live timeline already hides threaded events, which is the main one.
            let main = session.timeline(&self.room_id).await?;
            receipt_sent(session.core(), main.mark_as_read(receipt_type).await)?;
            if self.fully_read {
                receipt_sent(session.core(), timeline
                    .mark_as_read(ReceiptType::FullyRead).await)?;
            }
            return Ok(());
        };

        let room = session.room(&self.room_id)?;
        let thread_root = receipt_thread_root(&room, &event_id, self.thread_root.clone()).await;
        let timeline = if thread_root == self.thread_root {
            session.subscribed_timeline(&self.room_id, thread_root.as_ref(), self.subscription)
                .await?
        } else {
            session.timeline_for(&self.room_id, thread_root.as_ref())
                .await?
        };
        let receipt_target = past_hidden_events(&timeline, &event_id).await;
        receipt_sent(session.core(), timeline
            .send_single_receipt(receipt_type, receipt_target).await)?;
        if self.fully_read && thread_root.is_none() {
            receipt_sent(session.core(), timeline
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

impl SessionHandler for SetFullyReadParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        session.room(&self.room_id)?
            .send_multiple_receipts(Receipts::new().fully_read_marker(self.event_id))
            .await
            .or_failed(session.core(), "set_fully_read")
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

impl SessionHandler for MarkUnreadParams {
    type Ok = ();

    async fn run(self, session: &SignedIn) -> Result<(), RpcError> {
        let room = session.room(&self.room_id)?;

        if let Some(event_id) = self.read_marker {
            room.send_multiple_receipts(Receipts::new().fully_read_marker(event_id))
                .await
                .or_failed(session.core(), "mark_unread_marker")?;
        }

        room.set_unread_flag(true)
            .await
            .or_failed(session.core(), "mark_unread")
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type), specta(inline))]
pub struct ReadMarkerParams {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
}

impl SessionHandler for ReadMarkerParams {
    type Ok = Option<String>;

    async fn run(self, session: &SignedIn) -> Result<Option<String>, RpcError> {
        let room = session.room(&self.room_id)?;
        let fully_read = session
            .core().with_open_stores(async || room.account_data_static::<FullyReadEventContent>().await)
            .await
            .or_failed(session.core(), "read_marker")?
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
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub thread_roots: Vec<OwnedEventId>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typegen", specta(optional, type = Option<specta_typescript::Number>))]
    pub receipt_timestamp: Option<u64>,
    #[serde(flatten)]
    pub read: TimelineReadDiagnostics,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct UnreadDiagnosticsView {
    pub main: TimelineReadDiagnostics,
    pub server_notifications: u32,
    pub server_highlights: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typegen", specta(optional, type = Option<specta_typescript::Number>))]
    pub unthreaded_receipt_timestamp: Option<u64>,
    pub threads: Vec<ThreadReadDiagnostics>,
}

fn count(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

async fn receipt_event_timestamp(
    room: &matrix_sdk::Room,
    event_id: &EventId,
    receipt_ts: Option<MilliSecondsSinceUnixEpoch>,
) -> Option<u64> {
    if let Ok(event) = room.load_or_fetch_event(event_id, None).await
        && let Ok(Some(ts)) = event
            .raw()
            .get_field::<MilliSecondsSinceUnixEpoch>("origin_server_ts")
    {
        return Some(ts.0.into());
    }
    receipt_ts.map(|ts| ts.0.into())
}

async fn newest_stored_receipt(
    room: &matrix_sdk::Room,
    thread: ReceiptThread,
    user_id: &UserId,
) -> Option<(OwnedEventId, Option<u64>)> {
    let (public, private) = futures_util::join!(
        room.load_user_receipt(StoredReceiptType::Read, &thread, user_id),
        room.load_user_receipt(StoredReceiptType::ReadPrivate, &thread, user_id),
    );
    let (event_id, receipt) = [public, private]
        .into_iter()
        .filter_map(|receipt| receipt.ok().flatten())
        .max_by_key(|(_, receipt)| receipt.ts)?;
    let ts = receipt_event_timestamp(room, &event_id, receipt.ts).await;
    Some((event_id, ts))
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

impl SessionHandler for UnreadDiagnosticsParams {
    type Ok = UnreadDiagnosticsView;

    async fn run(self, session: &SignedIn) -> Result<UnreadDiagnosticsView, RpcError> {
        let room = session.room(&self.room_id)?;
        let server = room.unread_notification_counts();
        let mut threads = thread_receipts(&room)
            .await
            .into_iter()
            .collect::<std::collections::BTreeMap<_, _>>();
        if let Some(cache) = room.client().event_cache() {
            for root in &self.thread_roots {
                if let Ok(Some(info)) = cache.thread_info(room.room_id(), root).await {
                    threads.insert(root.clone(), info.read_receipts);
                }
            }
        }
        let mut unthreaded_receipt_timestamp = None;
        let mut stored = std::collections::BTreeMap::new();
        if let Some(user_id) = room.client().user_id() {
            let (unthreaded, receipts) = session
                .core().with_open_stores(async || {
                    futures_util::join!(
                        newest_stored_receipt(&room, ReceiptThread::Unthreaded, user_id),
                        futures_util::future::join_all(self.thread_roots.into_iter().map(
                            |root| {
                                let room = &room;
                                async move {
                                    let resolved = newest_stored_receipt(
                                        room,
                                        ReceiptThread::Thread(root.clone()),
                                        user_id,
                                    )
                                    .await;
                                    (root, resolved)
                                }
                            },
                        )),
                    )
                })
                .await;
            unthreaded_receipt_timestamp = unthreaded.and_then(|(_, ts)| ts);
            for (root, resolved) in receipts {
                if let Some(resolved) = resolved {
                    threads.entry(root.clone()).or_default();
                    stored.insert(root, resolved);
                }
            }
        }
        let mut thread_reads = Vec::with_capacity(threads.len());
        for (root, receipts) in threads {
            let mut read = read_diagnostics(&receipts);
            if receipts.latest_active.is_none() {
                read.unread = 0;
                read.notifying = 0;
                read.highlight = 0;
            }
            let mut receipt_timestamp = None;
            if let Some((event, ts)) = stored.remove(&root)
                && (read.receipt_event_id.is_none()
                    || read.receipt_event_id.as_deref() == Some(event.as_str()))
            {
                read.receipt_event_id = Some(event.to_string());
                receipt_timestamp = ts;
            } else if let Some(active) = &receipts.latest_active {
                receipt_timestamp = session
                    .core()
                    .with_open_stores(async || {
                        receipt_event_timestamp(&room, &active.event_id, None).await
                    })
                    .await;
            }
            thread_reads.push(ThreadReadDiagnostics {
                root_event_id: root.to_string(),
                receipt_timestamp,
                read,
            });
        }
        Ok(UnreadDiagnosticsView {
            main: read_diagnostics(&room.read_receipts()),
            server_notifications: count(server.notification_count),
            server_highlights: count(server.highlight_count),
            unthreaded_receipt_timestamp,
            threads: thread_reads,
        })
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

impl SessionHandler for RoomEventRelationsParams {
    type Ok = RelationsView;

    async fn run(self, session: &SignedIn) -> Result<RelationsView, RpcError> {
        session.room_event_relations(
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

impl SessionHandler for PinnedEventsParams {
    type Ok = Vec<String>;

    async fn run(self, session: &SignedIn) -> Result<Vec<String>, RpcError> {
        let event_ids = session.pinned_events(&self.room_id).await?;
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

impl SessionHandler for SetPinnedParams {
    type Ok = Vec<String>;

    async fn run(self, session: &SignedIn) -> Result<Vec<String>, RpcError> {
        let event_ids = session
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

impl SessionHandler for PinReadStateParams {
    type Ok = PinReadStateView;

    async fn run(self, session: &SignedIn) -> Result<PinReadStateView, RpcError> {
        session.pin_read_state(&self.room_id).await
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

impl SessionHandler for MarkPinsSeenParams {
    type Ok = PinReadStateView;

    async fn run(self, session: &SignedIn) -> Result<PinReadStateView, RpcError> {
        session.mark_pins_seen(&self.room_id, self.pinned_ids).await
    }
}
