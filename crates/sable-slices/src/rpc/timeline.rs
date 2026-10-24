//! The core's `timeline` methods the slices call.

use crate::timeline::{TimelineKey, TimelineModeView};
use sable_protocol::{PaginationDirection, SubscriptionId, TimelineItemView};
use sable_runtime::Rpc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct SubscribeRoomList {}

impl Rpc for SubscribeRoomList {
    const METHOD: &'static str = "timeline.subscribe_room_list";
    type Ok = RoomListSubscribed;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoomListSubscribed {
    pub subscription: SubscriptionId,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Unsubscribe {
    pub subscription: SubscriptionId,
}

impl Rpc for Unsubscribe {
    const METHOD: &'static str = "timeline.unsubscribe";
    type Ok = ();
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WarmRooms {
    pub room_ids: Vec<String>,
}

impl Rpc for WarmRooms {
    const METHOD: &'static str = "timeline.warm_rooms";
    type Ok = ();
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Focus {
    Live,
    Event { event_id: String },
    Thread { root_event_id: String },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Subscribe {
    pub key: TimelineKey,
    pub room_id: String,
    pub focus: Focus,
    pub hidden_events: bool,
}

impl Subscribe {
    #[must_use]
    pub fn new(key: TimelineKey, mode: &TimelineModeView, hidden_events: bool) -> Self {
        let focus = match mode {
            TimelineModeView::Live => Focus::Live,
            TimelineModeView::Focused { event_id } | TimelineModeView::Unread { event_id } => {
                Focus::Event {
                    event_id: event_id.clone(),
                }
            }
            TimelineModeView::Thread { root_event_id } => Focus::Thread {
                root_event_id: root_event_id.clone(),
            },
        };
        Self {
            room_id: key.room_id.clone(),
            key,
            focus,
            hidden_events,
        }
    }
}

impl Rpc for Subscribe {
    const METHOD: &'static str = "timeline.subscribe";
    type Ok = SubscribeOk;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscribeOk {
    pub subscription: SubscriptionId,
    pub items: Vec<TimelineItemView>,
    pub aggregations: Vec<TimelineItemView>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Paginate {
    pub subscription: SubscriptionId,
    pub direction: PaginationDirection,
    pub count: u16,
}

impl Rpc for Paginate {
    const METHOD: &'static str = "timeline.paginate";
    type Ok = PaginateOk;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaginateOk {
    pub reached_end: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadMarker {
    pub room_id: String,
}

impl Rpc for ReadMarker {
    const METHOD: &'static str = "timeline.read_marker";
    type Ok = Option<String>;
}

/// The details arrive as a timeline diff.
#[derive(Debug, Serialize, Deserialize)]
pub struct FetchEventDetails {
    pub room_id: String,
    pub event_id: String,
    pub thread_root: Option<String>,
}

impl Rpc for FetchEventDetails {
    const METHOD: &'static str = "timeline.fetch_event_details";
    type Ok = ();
}
