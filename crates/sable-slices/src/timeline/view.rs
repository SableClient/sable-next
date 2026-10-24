//! What a timeline shows a UI, and what a UI can ask of it.

use std::{collections::BTreeMap, ops::Deref, sync::Arc};

use sable_model::timeline::TimelineReplyStyleView;
use sable_protocol::{PaginationDirection, SubscriptionId, TimelineItemView, skip};
use serde::{Deserialize, Serialize};

/// An item the list and the rows point at.
#[derive(Debug, Clone)]
pub struct Shared(Arc<TimelineItemView>);

impl Shared {
    #[must_use]
    pub fn new(item: TimelineItemView) -> Self {
        Self(Arc::new(item))
    }

    /// A copy of the item to change before sharing it again.
    #[must_use]
    pub fn edited(&self) -> TimelineItemView {
        TimelineItemView::clone(&self.0)
    }
}

impl Deref for Shared {
    type Target = TimelineItemView;

    fn deref(&self) -> &TimelineItemView {
        &self.0
    }
}

impl PartialEq for Shared {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0) || self.0 == other.0
    }
}

impl Serialize for Shared {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

/// Which events the reader has chosen not to see.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[expect(
    clippy::struct_excessive_bools,
    reason = "one switch per kind of event, as the reader's preferences hold them"
)]
pub struct TimelineFiltersView {
    pub hide_membership_events: bool,
    pub hide_profile_changes: bool,
    pub hide_topic_changes: bool,
    pub hide_member_in_read_only: bool,
    pub show_tombstone_events: bool,
    pub show_hidden_events: bool,
    pub hidden_event_edits: bool,
    pub hidden_event_reactions: bool,
    pub hidden_event_redactions: bool,
    pub hidden_event_other: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimelineModeView {
    #[default]
    Live,
    Unread {
        event_id: String,
    },
    Focused {
        event_id: String,
    },
    Thread {
        root_event_id: String,
    },
}

impl TimelineModeView {
    /// Whether it is the same kind of view, and of the same event for those
    /// that have one.
    #[must_use]
    pub fn same_as(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Live, Self::Live) => true,
            (Self::Unread { event_id: a }, Self::Unread { event_id: b })
            | (Self::Focused { event_id: a }, Self::Focused { event_id: b })
            | (Self::Thread { root_event_id: a }, Self::Thread { root_event_id: b }) => a == b,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum PaginationStateView {
    #[default]
    Idle,
    Loading,
    End,
}

/// The readers of a row and when each read it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct TimelineReceiptsView {
    pub readers: Vec<String>,
    #[serde(default, skip_serializing_if = "skip::is_default")]
    #[cfg_attr(feature = "typegen", specta(type = BTreeMap<String, specta_typescript::Number<u64>>))]
    pub timestamps: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TimelineMemberCategoryView {
    Joined,
    Left,
    Invited,
    InvitationRejected,
    Knocked,
    KnockRetracted,
    Other,
    Name,
    Avatar,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct TimelineSubjectView {
    pub user_id: String,
    pub name: String,
}

/// Who went through one kind of membership change in a run of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct TimelineSegmentView {
    pub category: TimelineMemberCategoryView,
    pub users: Vec<TimelineSubjectView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TimelineGroupMember {
    /// Eligible for reply navigation in this filtered timeline.
    pub reply_target: bool,
    pub item: Shared,
}

/// One line of the list: an item, or the run of membership events it ends.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TimelineRow {
    /// Stable while the item moves, becomes remote or is edited.
    pub key: String,
    /// Eligible for reply navigation in this filtered timeline.
    pub reply_target: bool,
    pub item: Shared,
    /// The members of the run when `item` ends one.
    #[serde(skip_serializing_if = "skip::is_default")]
    pub group: Option<Vec<TimelineGroupMember>>,
    #[serde(skip_serializing_if = "skip::is_default")]
    pub segments: Vec<TimelineSegmentView>,
    /// Drawn as a continuation of the row above.
    #[serde(skip_serializing_if = "skip::is_default")]
    pub collapsed: bool,
    #[serde(skip_serializing_if = "skip::is_default")]
    pub group_start: bool,
    /// On the unread marker: the messages after it.
    #[serde(skip_serializing_if = "skip::is_default")]
    pub unread_count: u32,
    /// On a row that carries a receipt: the readers whose latest receipt is on
    /// a later row, with when each read. The item has its own.
    #[serde(skip_serializing_if = "skip::is_default")]
    pub later_receipts: Option<TimelineReceiptsView>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[expect(
    clippy::struct_excessive_bools,
    reason = "the tracker's states are independent of each other"
)]
pub struct TimelineUnreadView {
    pub initialized: bool,
    pub loading: bool,
    pub active: bool,
    pub first_event_id: Option<String>,
    pub read_event_id: Option<String>,
    pub failed: bool,
    /// Messages from the first unread one on that the reader can see.
    pub count: u32,
    /// The timeline should not be drawn yet.
    pub blocking: bool,
}

/// Everything about a timeline that is not a list.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[expect(
    clippy::struct_excessive_bools,
    reason = "each flag is one independent fact about the timeline"
)]
pub struct TimelineStatus {
    pub mode: TimelineModeView,
    pub loading: bool,
    pub resuming_live: bool,
    pub has_snapshot: bool,
    pub forward_pagination: PaginationStateView,
    pub backward_pagination: PaginationStateView,
    /// `load_failed` when the last open or pagination failed.
    pub error: Option<String>,
    /// The core's subscription, which a call that needs it names.
    pub subscription: Option<SubscriptionId>,
    pub can_resume_live: bool,
    /// The newest events are in the list.
    pub reaches_latest: bool,
    pub latest_event_id: Option<String>,
    /// Items the core holds, before the reader's filters leave rows of them.
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub item_count: usize,
    pub unread: TimelineUnreadView,
}

/// What a request to paginate answers with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct TimelinePaginated {
    pub reached_end: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TimelineAction {
    /// How the timeline is shown. Takes effect at once, in any state.
    Configure {
        filters: TimelineFiltersView,
        reply_style: TimelineReplyStyleView,
        read_only: bool,
        /// The reader's offset from UTC in minutes, to find where their days begin.
        utc_offset_minutes: i32,
        /// The thread whose root and first reply are never collapsed.
        thread_root: Option<String>,
    },
    /// Answers once the timeline is open. A failure is `status.error`, not an error reply.
    Open {
        target: TimelineModeView,
        hidden_events: bool,
        /// Open at the read marker.
        unread: bool,
        /// The room has messages the reader has not read, so the tracker starts active.
        has_unread: bool,
        /// Where to land: the live timeline when the event is loaded, its context when not.
        landing: Option<String>,
    },
    /// Answers when the live timeline is back, or with an error when it cannot be.
    ResumeLive,
    /// Releases the core's subscription and empties the timeline.
    Stop,
    /// The view that held the timeline has gone: forget what only it knew.
    Release,
    /// Starts tracking where the reader stopped. Answers once the read marker is known.
    InitializeUnread {
        has_unread: bool,
    },
    /// The first row in view is the first unread one.
    ObserveUnread {
        first_visible: Option<String>,
    },
    /// What the window shows. Arrivals while it is unfocused start an unread
    /// boundary, and showing the newest row while focused reaches the end of
    /// the unread messages.
    Viewing {
        focused: bool,
        newest: Option<String>,
    },
    /// A read receipt was sent up to this event. At the newest event, the unread
    /// boundary is dismissed.
    Read {
        event_id: String,
    },
    /// Whether the room has messages the reader has not read, as the room list
    /// says. Reading them elsewhere dismisses the unread boundary.
    RoomUnread {
        has_unread: bool,
        #[serde(default, skip_serializing_if = "skip::is_default")]
        keep_boundary: bool,
    },
    ClearUnread,
    /// Answers with whether the end was reached.
    Paginate {
        direction: PaginationDirection,
        count: u16,
    },
}

/// A list as the document serves it.
#[cfg(feature = "typegen")]
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TimelineListView<T> {
    #[specta(type = specta_typescript::Number)]
    pub total: usize,
    pub items: Vec<T>,
}

/// What a subscription to a timeline holds, for the generated types: the
/// document is built part by part and never serialized through this type.
#[cfg(feature = "typegen")]
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TimelineDocView {
    #[specta(type = specta_typescript::Number)]
    pub total: usize,
    /// The rows to draw. A subscription's window moves over this list.
    pub items: Vec<TimelineRowView>,
    pub status: TimelineStatus,
    pub aggregations: TimelineListView<TimelineItemView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<TimelineListView<TimelineItemView>>,
}

/// A group member with its item by value, for the generated types.
#[cfg(feature = "typegen")]
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct TimelineGroupMemberView {
    pub reply_target: bool,
    pub item: TimelineItemView,
}

/// A row with its items by value, for the generated types.
#[cfg(feature = "typegen")]
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TimelineRowView {
    pub key: String,
    pub reply_target: bool,
    pub item: TimelineItemView,
    #[serde(skip_serializing_if = "skip::is_default")]
    pub group: Option<Vec<TimelineGroupMemberView>>,
    #[serde(skip_serializing_if = "skip::is_default")]
    pub segments: Vec<TimelineSegmentView>,
    #[serde(skip_serializing_if = "skip::is_default")]
    pub collapsed: bool,
    #[serde(skip_serializing_if = "skip::is_default")]
    pub group_start: bool,
    #[serde(skip_serializing_if = "skip::is_default")]
    pub unread_count: u32,
    #[serde(skip_serializing_if = "skip::is_default")]
    pub later_receipts: Option<TimelineReceiptsView>,
}
