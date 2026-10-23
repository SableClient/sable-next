pub use eyeball_im::VectorDiff;
use ruma::room::RoomType;
use ruma::{
    OwnedDeviceId, OwnedEventId, OwnedMxcUri, OwnedRoomAliasId, OwnedRoomId, OwnedServerName,
    OwnedUserId,
};
pub use sable_model::calendar::{CalendarRsvpView, RsvpStatusView};
pub use sable_model::event_preview::ReplyFallbackView;
pub use sable_model::markdown::{ComposerContent, ComposerMentions, ComposerPill};
pub use sable_model::member_look::{FieldEdit, PronounView};
pub use sable_model::notifications::NotificationModeView;
pub use sable_model::power_levels::{PowerLevelAction, PowerLevelLocation, RoomPowerLevelsView};
pub use sable_model::search_filter::{SearchAttachment, SearchFilter};
pub use sable_model::sidebar::SidebarItemView;
pub use sable_model::slash::{GestureView, MessageKind};
pub use sable_model::spaces::{RoomJoinRuleView, SpaceChildEdge};
use serde::{Deserialize, Serialize};

/// Room types that Sable supports.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RoomKind {
    /// No room type
    Text,
    /// `m.space`
    Space,
    /// `org.matrix.msc3417.call`
    Voice,
    /// `pl.chrome.forum`
    Forum,
    /// `chat.commet.calendar`
    Calendar,
}

pub const FORUM_ROOM_TYPE: &str = "pl.chrome.forum";
pub const CALENDAR_ROOM_TYPE: &str = "chat.commet.calendar";

impl RoomKind {
    /// Create a [`RoomKind`] from a [`RoomType`].
    ///
    /// Returns None if the room type is unsupported by Sable.
    #[must_use]
    pub fn from_room_type(room_type: Option<&RoomType>) -> Option<Self> {
        match room_type {
            None => Some(Self::Text),
            Some(RoomType::Space) => Some(Self::Space),
            Some(RoomType::Call) => Some(Self::Voice),
            Some(other) if other.as_str() == FORUM_ROOM_TYPE => Some(Self::Forum),
            Some(other) if other.as_str() == CALENDAR_ROOM_TYPE => Some(Self::Calendar),
            Some(_) => None,
        }
    }

    /// Convert this [`RoomKind`] to a [`RoomType`].
    #[must_use]
    pub fn as_room_type(&self) -> Option<RoomType> {
        match self {
            Self::Text => None,
            Self::Space => Some(RoomType::Space),
            Self::Voice => Some(RoomType::Call),
            Self::Forum => Some(RoomType::from(FORUM_ROOM_TYPE)),
            Self::Calendar => Some(RoomType::from(CALENDAR_ROOM_TYPE)),
        }
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct Outgoing {
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub in_reply_to: Option<OwnedEventId>,
    #[serde(default)]
    pub silent_reply: bool,
    #[serde(default)]
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub mentions: Vec<OwnedUserId>,
    #[serde(default)]
    pub mentions_room: bool,
    #[serde(default)]
    pub persona: Option<PerMessageProfileView>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SendAttachmentRequest {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub filename: String,
    pub mime: String,
    #[serde(default)]
    pub caption: Option<String>,
    #[serde(default)]
    pub formatted_caption: Option<String>,
    #[serde(default)]
    pub info: Option<AttachmentInfoView>,
    #[serde(flatten)]
    pub outgoing: Outgoing,
    #[serde(default)]
    pub spoiler: bool,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SendGalleryRequest {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub attachments: Vec<GalleryAttachmentView>,
    #[serde(default)]
    pub caption: Option<String>,
    #[serde(default)]
    pub formatted_caption: Option<String>,
    #[serde(flatten)]
    pub outgoing: Outgoing,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct GalleryAttachmentView {
    pub filename: String,
    pub mime: String,
    #[serde(default)]
    pub info: Option<AttachmentInfoView>,
}

/// Stable serialized codes. Source chains, inputs and bodies stay native-side
/// and are logged there, so nothing leaks across the wire. The last four words
/// match the platform ports, so a core failure and a capability failure read
/// alike.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum RpcError {
    NotLoggedIn,
    UnknownSubscription,
    UnknownCall,
    NoCallFocus,
    InvalidPaginationDirection,
    UnknownRoom,
    UnknownHomeserver,
    UnknownLocalEcho,
    /// `stages` are the `m.login.*` types offered. With `m.login.password` the
    /// command can be retried carrying one, otherwise the user must finish on
    /// the homeserver.
    InteractiveAuthRequired {
        stages: Vec<String>,
    },
    UnknownVerification,
    /// A scanned code that is not a Matrix verification code.
    InvalidVerificationCode,
    InvalidMedia,
    MessageTooLarge,
    /// A poll needs a question and between 1 and 20 answers.
    InvalidPoll,
    InvalidLocation,
    InvalidKeyExport,
    EncryptedScheduleUnsupported,
    DelayedEventsUnsupported,
    SlidingSyncUnsupported,
    AccountLocked,
    AccountSuspended,
    /// MSC2545 allows `[a-zA-Z0-9-_]`, at most 100 bytes, each once per pack.
    InvalidShortcode {
        shortcode: String,
    },
    /// A file that is not a backup this app wrote.
    InvalidBackup,
    /// Not an `http` or `https` URL.
    InvalidUrl,
    /// Matrix JSON integers must fit in ±(2^53 - 1).
    IntegerOutOfRange,
    /// A search filter naming something that is not a room or user id.
    InvalidSearchFilter,
    /// A sealed document this device cannot open, so writing it would erase
    /// what the other devices stored.
    DocumentLocked,
    /// Static: safe to hide UI.
    Unsupported,
    /// Retryable: keep UI.
    Unavailable,
    /// The media's server keeps failing; asking again before this is pointless.
    MediaServerUnavailable {
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        retry_after_ms: u64,
    },
    /// Refused, recoverable by user action.
    Denied,
    RateLimited {
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        retry_after_ms: Option<u64>,
    },
    RegistrationUnavailable,
    UsernameTaken,
    InvalidUsername,
    InvalidEmail,
    UnknownEmail,
    EmailVerificationFailed,
    WeakPassword,
    RegistrationStageFailed {
        stage: String,
    },
    /// The homeserver advertises OAuth endpoints that cannot be reached.
    AuthProviderUnreachable,
    /// Detail is in the core's log under `log_id`.
    Failed {
        log_id: String,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum PaginationDirection {
    Backward,
    Forward,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum CreateJoinRuleView {
    Public,
    Invite,
    Knock,
    Restricted,
    KnockRestricted,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RegistrationResultView {
    Complete {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        user_id: OwnedUserId,
    },
    Fallback {
        stage: String,
        fallback_url: String,
        completed: Vec<String>,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        total_stages: usize,
    },
    Email {
        email: Option<String>,
        submit_url: Option<String>,
        can_complete_out_of_band: bool,
        verified: bool,
        completed: Vec<String>,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        total_stages: usize,
    },
}

/// Pushed, unsolicited. Never a reply to a command.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CoreEvent {
    AccountLockChanged {
        account_id: String,
        locked: bool,
    },
    SyncStatus(SyncStatus),
    SessionEnded {
        reason: String,
    },
    SessionTokensRefreshed,

    /// One batch is one render, so it stays batched all the way to the UI.
    RoomListDiff {
        subscription: SubscriptionId,
        #[cfg_attr(
            feature = "typegen",
            specta(type = Vec<VectorDiffWire<RoomListItemView>>)
        )]
        diffs: Vec<VectorDiff<RoomListItemView>>,
    },
    TimelineDiff {
        subscription: SubscriptionId,
        #[cfg_attr(
            feature = "typegen",
            specta(type = Vec<VectorDiffWire<TimelineItemView>>)
        )]
        diffs: Vec<VectorDiff<TimelineItemView>>,
    },
    TimelinePagination {
        subscription: SubscriptionId,
        loading: bool,
        reached_start: bool,
    },
    TimelineAggregations {
        subscription: SubscriptionId,
        items: Vec<TimelineItemView>,
    },

    /// Our own user excluded. Absolute, so an empty list replaces the previous
    /// one. Sent for every joined room, since a room list row shows it too.
    Typing {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        room_id: OwnedRoomId,
        #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
        user_ids: Vec<OwnedUserId>,
    },

    /// Pushed on every change, so the UI never polls to notice it is verified.
    EncryptionStatus {
        status: EncryptionStatusView,
    },
    KeyBackupDownload {
        download: KeyBackupDownloadView,
    },

    DevicesChanged {
        devices: Vec<DeviceView>,
    },

    SearchCoverage {
        coverage: SearchCoverageView,
    },

    Notification {
        notification: NotificationView,
    },

    NotificationSettingsChanged,

    InboxChanged,

    AccountDataChanged {
        event_type: String,
    },

    PersonasChanged,

    SpaceSidebarChanged {
        items: Vec<SidebarItemView>,
    },

    /// A calendar entry, an answer or a redaction arrived in a calendar room.
    RoomWidgetsChanged {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        room_id: OwnedRoomId,
    },
    WidgetRoomEvent {
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
        event: serde_json::Value,
    },
    WidgetToDevice {
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
        event: serde_json::Value,
        encrypted: bool,
    },
    CalendarChanged {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        room_id: OwnedRoomId,
    },

    RoomCosmeticsChanged {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        room_id: OwnedRoomId,
    },

    ProfileChanged {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        room_id: OwnedRoomId,
        #[cfg_attr(feature = "typegen", specta(type = String))]
        user_id: OwnedUserId,
        display_name: Option<String>,
        avatar_url: Option<String>,
    },

    /// A member event of any kind arrived: join, leave, kick, ban, invite or a profile change.
    MembersChanged {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        room_id: OwnedRoomId,
    },

    BotCommandsChanged {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        room_id: OwnedRoomId,
    },

    ImagePacksChanged {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        room_id: OwnedRoomId,
    },

    /// An incoming request arrives unsolicited. There is no other prompt.
    Verification {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        user_id: OwnedUserId,
        flow_id: String,
        state: VerificationView,
    },

    QrLogin {
        grant: bool,
        progress: QrLoginProgressView,
    },

    CallEncryptionKey {
        session: CallSessionId,
        identity: String,
        key_index: u8,
        key: String,
        own: bool,
        backend_id: Option<String>,
    },

    CallBackends {
        session: CallSessionId,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        revision: u64,
        publisher_id: String,
        backends: Vec<CallBackendView>,
    },

    CallSignalingError {
        session: CallSessionId,
        stage: CallSignalingStage,
        fatal: bool,
    },

    CallMembers {
        session: CallSessionId,
        members: Vec<CallMemberView>,
    },

    IncomingCall {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        room_id: OwnedRoomId,
        notification_event_id: String,
        #[cfg_attr(feature = "typegen", specta(type = String))]
        sender: OwnedUserId,
        sender_name: Option<String>,
        room_name: Option<String>,
        ring: bool,
        has_video: bool,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        expires_at_ms: u64,
    },

    IncomingCallEnded {
        notification_event_id: String,
    },

    MediaProgress {
        source: String,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        current: u64,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        total: u64,
    },

    /// Never arrives on a homeserver with presence disabled.
    Presence {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        user_id: OwnedUserId,
        presence: PresenceView,
        status_message: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        last_active_ago: Option<u64>,
    },
}

impl CoreEvent {
    #[must_use]
    pub const fn kind(&self) -> CoreEventKind {
        match self {
            Self::AccountLockChanged { .. } => CoreEventKind::AccountLockChanged,
            Self::SyncStatus(..) => CoreEventKind::SyncStatus,
            Self::SessionEnded { .. } => CoreEventKind::SessionEnded,
            Self::SessionTokensRefreshed => CoreEventKind::SessionTokensRefreshed,
            Self::RoomListDiff { .. } => CoreEventKind::RoomListDiff,
            Self::TimelineDiff { .. } => CoreEventKind::TimelineDiff,
            Self::TimelinePagination { .. } => CoreEventKind::TimelinePagination,
            Self::TimelineAggregations { .. } => CoreEventKind::TimelineAggregations,
            Self::Typing { .. } => CoreEventKind::Typing,
            Self::EncryptionStatus { .. } => CoreEventKind::EncryptionStatus,
            Self::KeyBackupDownload { .. } => CoreEventKind::KeyBackupDownload,
            Self::DevicesChanged { .. } => CoreEventKind::DevicesChanged,
            Self::SearchCoverage { .. } => CoreEventKind::SearchCoverage,
            Self::Notification { .. } => CoreEventKind::Notification,
            Self::NotificationSettingsChanged => CoreEventKind::NotificationSettingsChanged,
            Self::InboxChanged => CoreEventKind::InboxChanged,
            Self::AccountDataChanged { .. } => CoreEventKind::AccountDataChanged,
            Self::PersonasChanged => CoreEventKind::PersonasChanged,
            Self::SpaceSidebarChanged { .. } => CoreEventKind::SpaceSidebarChanged,
            Self::RoomWidgetsChanged { .. } => CoreEventKind::RoomWidgetsChanged,
            Self::WidgetRoomEvent { .. } => CoreEventKind::WidgetRoomEvent,
            Self::WidgetToDevice { .. } => CoreEventKind::WidgetToDevice,
            Self::CalendarChanged { .. } => CoreEventKind::CalendarChanged,
            Self::RoomCosmeticsChanged { .. } => CoreEventKind::RoomCosmeticsChanged,
            Self::ProfileChanged { .. } => CoreEventKind::ProfileChanged,
            Self::MembersChanged { .. } => CoreEventKind::MembersChanged,
            Self::BotCommandsChanged { .. } => CoreEventKind::BotCommandsChanged,
            Self::ImagePacksChanged { .. } => CoreEventKind::ImagePacksChanged,
            Self::Verification { .. } => CoreEventKind::Verification,
            Self::QrLogin { .. } => CoreEventKind::QrLogin,
            Self::CallEncryptionKey { .. } => CoreEventKind::CallEncryptionKey,
            Self::CallBackends { .. } => CoreEventKind::CallBackends,
            Self::CallSignalingError { .. } => CoreEventKind::CallSignalingError,
            Self::CallMembers { .. } => CoreEventKind::CallMembers,
            Self::IncomingCall { .. } => CoreEventKind::IncomingCall,
            Self::IncomingCallEnded { .. } => CoreEventKind::IncomingCallEnded,
            Self::MediaProgress { .. } => CoreEventKind::MediaProgress,
            Self::Presence { .. } => CoreEventKind::Presence,
        }
    }
}

/// What a `CoreEvent` is, without its payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CoreEventKind {
    AccountLockChanged,
    SyncStatus,
    SessionEnded,
    SessionTokensRefreshed,
    RoomListDiff,
    TimelineDiff,
    TimelinePagination,
    TimelineAggregations,
    Typing,
    EncryptionStatus,
    KeyBackupDownload,
    DevicesChanged,
    SearchCoverage,
    Notification,
    NotificationSettingsChanged,
    InboxChanged,
    AccountDataChanged,
    PersonasChanged,
    SpaceSidebarChanged,
    RoomWidgetsChanged,
    WidgetRoomEvent,
    WidgetToDevice,
    CalendarChanged,
    RoomCosmeticsChanged,
    ProfileChanged,
    MembersChanged,
    BotCommandsChanged,
    ImagePacksChanged,
    Verification,
    QrLogin,
    CallEncryptionKey,
    CallBackends,
    CallSignalingError,
    CallMembers,
    IncomingCall,
    IncomingCallEnded,
    MediaProgress,
    Presence,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum PresenceView {
    Online,
    Offline,
    Unavailable,
}

#[cfg(feature = "typegen")]
#[derive(Serialize, specta::Type)]
pub enum VectorDiffWire<T> {
    Append {
        values: Vec<T>,
    },
    Clear {},
    PushFront {
        value: T,
    },
    PushBack {
        value: T,
    },
    PopFront {},
    PopBack {},
    Insert {
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        index: usize,
        value: T,
    },
    Set {
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        index: usize,
        value: T,
    },
    Remove {
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        index: usize,
    },
    Truncate {
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        length: usize,
    },
    Reset {
        values: Vec<T>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SubscriptionId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct CallSessionId(pub u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum SearchCoverageState {
    Indexing,
    Complete,
    Partial,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SearchCoverageView {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub documents: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub rooms_pending: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub rooms_failed: usize,
    pub state: SearchCoverageState,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum SearchCrawlPhase {
    #[default]
    Starting,
    Crawling,
    Trickling,
    Yielding,
    Paused,
    BackingOff,
    Idle,
    BudgetSpent,
    IndexFull,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SearchMetricsView {
    pub phase: SearchCrawlPhase,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub documents: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub documents_loaded: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub memory_bytes: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub memory_budget: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub disk_bytes: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub disk_budget: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub rooms_joined: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub rooms_indexed: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub rooms_pending: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub rooms_exhausted: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub rooms_failed: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub rooms_blind: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub rooms_unreadable: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub events_crawled: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub event_budget: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub batches: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub pushbacks: u64,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub last_request_ms: Option<u64>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub average_request_ms: Option<u64>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub running_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct CallMemberView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub device_id: String,
    pub identity: String,
    pub backend_id: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub joined_ts: u64,
    pub screen_sharing: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum CallMode {
    Legacy,
    Compatibility,
    #[serde(rename = "matrix_2")]
    Matrix2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum CallModeReason {
    Requested,
    StickyOnly,
    LegacyPeer,
    StickyPeer,
    Fresh,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum CallIntent {
    Audio,
    Video,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum CallSignalingStage {
    Membership,
    Sync,
    Provision,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct CallBackendView {
    pub id: String,
    pub url: String,
    pub jwt: String,
    pub identity: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SearchHitView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    pub body: String,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub sender: OwnedUserId,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub origin_server_ts: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub score: f64,
    pub context_before: Vec<SearchContextView>,
    pub context_after: Vec<SearchContextView>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SearchContextView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    pub body: String,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub sender: OwnedUserId,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub origin_server_ts: u64,
}

// Hand-narrowed, keeping the UI off the SDK's shapes.

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
// Independent room capabilities.
#[expect(
    clippy::struct_excessive_bools,
    reason = "wire type mirroring the protocol"
)]
pub struct RoomListItemView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub canonical_alias: Option<String>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    pub is_direct: bool,
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub direct_targets: Vec<OwnedUserId>,
    pub join_rule: RoomJoinRuleView,
    /// Only the tags this client models; others are dropped.
    pub tags: Vec<RoomTag>,
    pub state: RoomStateView,
    /// `null` until the state event loads, which is not the same as `false`.
    pub encrypted: Option<bool>,
    pub is_tombstoned: bool,
    pub room_kind: Option<RoomKind>,
    /// Members in the room's call, oldest first and one entry per user however
    /// many devices they joined with.
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub call_participants: Vec<OwnedUserId>,
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub screen_sharers: Vec<OwnedUserId>,
    pub supports_knock: bool,
    pub supports_restricted: bool,
    pub supports_knock_restricted: bool,
    /// Already sorted by `order`, then the child event's age.
    pub space_children: Vec<SpaceChildEdge>,
    pub unread: u32,
    pub notifying: u32,
    pub highlight: u32,
    pub marked_unread: bool,
    pub notification: NotificationSettingsView,
    /// The counts above under the room's mode.
    pub counts: RoomUnreadView,
    pub latest_event: Option<LatestEventView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomUnreadView {
    pub unread: u32,
    /// What the push rules notified on, which is what the inbox counts.
    pub notifying: u32,
    pub highlight: u32,
    /// Set by hand, so it survives a mute.
    pub marked: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[expect(
    clippy::struct_excessive_bools,
    reason = "wire type mirroring the protocol"
)]
pub struct EncryptionStatusView {
    /// Whether *this* device is signed by our own identity.
    pub verification: VerificationStateView,
    pub recovery: RecoveryStateView,
    /// All three keys held locally, so this device can sign others. False means
    /// verification must come from another session.
    pub cross_signing_ready: bool,
    pub signing_keys: SigningKeysView,
    pub backup_unlocked: bool,
    /// The default secret storage key can also be unlocked with a passphrase.
    pub recovery_passphrase: bool,
    pub account_data_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct KeyBackupStatusView {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub local_keys: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub backed_up_keys: u64,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub cloud_keys: Option<u64>,
    pub can_restore: bool,
    pub download: Option<KeyBackupDownloadView>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct KeyBackupDownloadView {
    pub account_id: String,
    pub request_id: String,
    pub state: KeyBackupDownloadState,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub total: Option<u64>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub processed: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub imported: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub failed: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum KeyBackupDownloadState {
    Downloading,
    Importing,
    Complete,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SealedAccountDataView {
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Unknown>))]
    pub content: Option<serde_json::Value>,
    pub state: SealStateView,
    pub can_seal: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum SealStateView {
    Plain,
    Sealed,
    Locked,
}

/// Which private cross-signing keys this device holds.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SigningKeysView {
    pub master: bool,
    pub self_signing: bool,
    pub user_signing: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SignOutSafetyView {
    pub encryption: EncryptionStatusView,
    pub backup_enabled: bool,
    pub backup_uploaded: bool,
    pub has_encrypted_rooms: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum VerificationStateView {
    Unknown,
    Verified,
    Unverified,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum IdentityResetStep {
    Done { recovery_key: String },
    Password,
    Approve { url: String },
}

/// `incomplete` means secret storage exists but this device lacks secrets from
/// it, so recovery will fix decryption.
#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStateView {
    Unknown,
    Enabled,
    Disabled,
    Incomplete,
}

/// The SDK splits this across a request and the SAS it becomes, with a state
/// enum each. The UI shows one dialog, so both flatten into this sequence.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum VerificationView {
    /// Waiting for us to accept or decline.
    Requested {
        /// Another of our own sessions, which also unlocks our history.
        is_self: bool,
        /// The current session sent the request, so it waits for the other
        /// device instead of showing an accept action.
        initiated_by_us: bool,
    },
    /// Nothing to do but wait. The side that accepted drives the transition to
    /// SAS.
    Waiting,
    /// Both sides are ready and support codes. `qr` is ours to show, and
    /// `can_scan` says the other device shows one we can read.
    Choose {
        qr: Option<QrCodeView>,
        can_scan: bool,
        can_compare: bool,
    },
    /// The other device read our code and waits for us to say it shows success.
    Scanned,
    Reciprocated,
    /// `decimals` is the fallback when the other side refused emoji.
    Compare {
        emojis: Vec<EmojiView>,
        decimals: (u16, u16, u16),
    },
    /// We said they match, but the other side has not.
    Confirmed,
    Done,
    Cancelled {
        reason: String,
    },
}

/// A square of `width` rows, `modules` holding `1` for a dark module.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct QrCodeView {
    pub width: u32,
    pub modules: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct EmojiView {
    pub symbol: String,
    /// English, from the spec's table.
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
// Independent facts about one device.
#[expect(
    clippy::struct_excessive_bools,
    reason = "wire type mirroring the protocol"
)]
pub struct DeviceView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub device_id: OwnedDeviceId,
    pub display_name: Option<String>,
    pub is_verified: bool,
    /// Signed by the account's own identity, whether or not this device trusts
    /// that identity yet. What a new device can be confirmed from.
    pub cross_signed: bool,
    /// The device has uploaded device keys, so it can be verified at all.
    pub has_keys: bool,
    /// The session this core is running in.
    pub is_own: bool,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub last_seen_ts: Option<u64>,
    pub last_seen_ip: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct UserSecurityView {
    pub verification: VerificationStateView,
    pub verification_violation: bool,
    pub devices: Vec<UserDeviceView>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct UserDeviceView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub device_id: OwnedDeviceId,
    pub display_name: Option<String>,
    pub verified: bool,
    pub cross_signed: bool,
    pub blocked: bool,
}

/// `restricted` and `knock_restricted` need an allowed-spaces list, so they are
/// not settable here.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum JoinRuleView {
    Public,
    Invite,
    /// Anyone may ask. A member approves.
    Knock,
    Restricted,
    KnockRestricted,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RoomTag {
    Favourite,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RoomStateView {
    Joined,
    Invited,
    Knocked,
    Left,
    Banned,
}

/// A room as the server describes it to someone who may not be in it.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomPreviewView {
    /// Resolved, since the preview may have been asked for by alias.
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub canonical_alias: Option<OwnedRoomAliasId>,
    pub name: Option<String>,
    pub topic: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub avatar_url: Option<OwnedMxcUri>,
    pub room_kind: Option<RoomKind>,
    /// `null` when the server did not say.
    pub num_joined_members: Option<u32>,
    pub join_rule: RoomJoinRuleView,
    /// `null` when this account has no membership in the room.
    pub state: Option<RoomStateView>,
    pub via: RoomPreviewViaView,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub enum RoomPreviewViaView {
    Client,
    Remote {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        server: OwnedServerName,
    },
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PublicRoomView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub canonical_alias: Option<String>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    pub room_kind: Option<RoomKind>,
    pub num_joined_members: u32,
    pub join_rule: RoomJoinRuleView,
    pub guest_can_join: bool,
    pub world_readable: bool,
}

/// One room in a space's hierarchy. The root space is included, so a caller can
/// walk the tree from it.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SpaceHierarchyRoomView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub canonical_alias: Option<String>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    pub room_kind: Option<RoomKind>,
    pub num_joined_members: u32,
    pub join_rule: RoomJoinRuleView,
    /// The rooms a `restricted` or `knock_restricted` join rule admits members of.
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub allowed_room_ids: Vec<OwnedRoomId>,
    pub guest_can_join: bool,
    /// This room's own `m.space.child` edges, already sorted. Empty unless it is
    /// a space.
    pub children: Vec<SpaceChildEdge>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SpaceParentView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub via: Vec<String>,
}

/// How a timeline row is drawn: a message carries a sender, a hover menu and
/// reactions; an event is a one-line notice; an annotation is a divider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TimelineRowKind {
    Message,
    Event,
    Annotation,
}

/// Which reader preference can hide a row; `always` rows are always shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TimelineVisibility {
    Always,
    Membership,
    /// A membership event that changed nothing a reader would notice.
    MembershipOther,
    ProfileChange,
    Tombstone,
    /// Shown only with hidden events on.
    Hidden,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct TimelineItemView {
    /// Not an event id. Stable across a local echo becoming remote.
    pub id: String,
    pub row: TimelineRowKind,
    /// Content another room can receive as it is.
    pub forwardable: bool,
    /// Whether the event can be redacted at all; the room's power levels
    /// decide whether the reader may.
    pub redactable: bool,
    pub visibility: TimelineVisibility,
    /// Absent while the event is still a local echo.
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub event_id: Option<OwnedEventId>,
    /// A local echo's only handle, since it has no event id yet.
    pub transaction_id: Option<String>,
    pub send_state: Option<SendStateView>,
    /// Dividers and markers have no sender.
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub sender: Option<OwnedUserId>,
    pub sender_name: Option<String>,
    pub sender_avatar: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub timestamp: u64,
    pub content: TimelineItemContentView,
    pub in_reply_to: Option<ReplyView>,
    /// Set on the root and on every reply, so a UI with no thread view can hide
    /// the replies.
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub thread_root: Option<OwnedEventId>,
    pub thread_summary: Option<ThreadSummaryView>,
    pub reactions: Vec<ReactionGroup>,
    pub is_own: bool,
    /// Already reduced by the SDK to one receipt per user.
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub read_by: Vec<OwnedUserId>,
    /// Available receipt timestamps in milliseconds since the Unix epoch.
    #[cfg_attr(feature = "typegen", specta(type = std::collections::BTreeMap<String, specta_typescript::Number<u64>>))]
    pub read_timestamps: std::collections::BTreeMap<String, u64>,
    /// MSC4144. When set, this is the identity to show as the sender; `sender`
    /// stays the account that actually sent it and must remain reachable.
    pub per_message_profile: Option<PerMessageProfileView>,
    pub bundled_link_previews: Vec<UrlPreviewView>,
    #[cfg_attr(feature = "typegen", specta(optional))]
    pub link_previews_removed: Option<bool>,
    pub mention: MentionView,
    pub forwarded: Option<ForwardedView>,
    pub forum_title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ForwardedView {
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub timestamp: Option<u64>,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub room_id: Option<OwnedRoomId>,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub event_id: Option<OwnedEventId>,
    #[cfg_attr(feature = "typegen", specta(optional, type = Option<String>))]
    pub sender: Option<OwnedUserId>,
    #[cfg_attr(feature = "typegen", specta(optional))]
    pub content_valid: Option<bool>,
}

/// `Loud` covers `@room` and anything the push rules chose to highlight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum MentionView {
    None,
    Silent,
    Loud,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RoomAttachmentKind {
    Media,
    File,
    Link,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomAttachmentView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    pub gallery_index: Option<u32>,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub sender: OwnedUserId,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub timestamp: u64,
    pub content: RoomAttachmentContentView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RoomAttachmentContentView {
    Image {
        filename: String,
        source: String,
        mime: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        width: Option<u64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        height: Option<u64>,
        blurhash: Option<String>,
        thumbnail: Option<String>,
        spoiler: Option<String>,
    },
    Video {
        filename: String,
        source: String,
        mime: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        width: Option<u64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        height: Option<u64>,
        blurhash: Option<String>,
        thumbnail: Option<String>,
        spoiler: Option<String>,
    },
    File {
        filename: String,
        source: String,
        mime: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        size: Option<u64>,
    },
    Link {
        urls: Vec<String>,
        body: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct UrlPreviewView {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub image: Option<String>,
    pub image_mime: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub image_width: Option<u64>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub image_height: Option<u64>,
    pub video: Option<UrlPreviewVideoView>,
    pub theme_color: Option<String>,
    pub card: Option<String>,
    pub author_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct UrlPreviewVideoView {
    pub source: String,
    pub mime: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub width: Option<u64>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub height: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomStateEventView {
    pub state_key: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub content: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomOpenView {
    pub permissions: RoomPermissionsView,
    #[cfg_attr(feature = "typegen", specta(type = std::collections::BTreeMap<String, PowerLevelTagView>))]
    pub power_level_tags: PowerLevelTagsView,
    pub widgets: Vec<RoomStateEventView>,
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub pinned_event_ids: Vec<OwnedEventId>,
    pub predecessor: Option<PredecessorRoomView>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomCosmeticsView {
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub space_id: Option<OwnedRoomId>,
    pub users: Vec<SenderCosmeticsView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SenderCosmeticsView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub color_on_light: Option<String>,
    pub color_on_dark: Option<String>,
    pub pronouns: Vec<PronounView>,
    pub space_display_name: Option<String>,
    pub space_avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PredecessorRoomView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub via: Vec<String>,
}

/// What this account may do in one room, resolved from `m.room.power_levels`.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
// Independent capabilities.
#[expect(
    clippy::struct_excessive_bools,
    reason = "wire type mirroring the protocol"
)]
pub struct RoomPermissionsView {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub own_power_level: i64,
    pub can_post: bool,
    pub can_react: bool,
    /// Redacting your own event, which needs the level to send `m.room.redaction`.
    pub can_redact_own: bool,
    /// Redacting someone else's event.
    pub can_redact_others: bool,
    pub can_invite: bool,
    pub can_kick: bool,
    pub can_ban: bool,
    /// `m.room.name`, `m.room.topic` and `m.room.avatar` share one level in
    /// practice, so they are reported together.
    pub can_change_settings: bool,
    pub can_pin: bool,
    pub can_change_join_rule: bool,
    pub can_change_power_levels: bool,
    /// `m.space.child`. Meaningless outside a space.
    pub can_manage_children: bool,
}

/// A role name for a power level, from `in.cinny.room.power_level_tags`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PowerLevelTagView {
    pub name: String,
    pub color: Option<String>,
    /// A Unicode emoji or an `mxc://` URI.
    pub icon: Option<String>,
}

/// Keyed by the power level.
pub type PowerLevelTagsView = std::collections::BTreeMap<i64, PowerLevelTagView>;

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct CallCompatibilityView {
    pub sticky_events: bool,
    pub delayed_events: bool,
    pub rtc_transports: RtcTransportSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RtcTransportSource {
    Endpoint,
    WellKnown,
    None,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct CallSupportView {
    pub has_focus: bool,
    pub can_join: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomVersionsView {
    pub default: String,
    pub available: Vec<RoomVersionView>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RoomVersionView {
    pub id: String,
    pub stable: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(default)]
pub struct AttachmentInfoView {
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub width: Option<u32>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub height: Option<u32>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub duration_ms: Option<u32>,
    pub animated: Option<bool>,
    pub blurhash: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = Option<Vec<specta_typescript::Number>>))]
    pub waveform: Option<Vec<f32>>,
    #[serde(default)]
    pub voice: bool,
    pub audio_metadata: Option<AudioMetadataView>,
}

/// MSC4144 per-message profile, letting one account send under several
/// identities. Read from the unstable `com.beeper.per_message_profile` key,
/// falling back to the stable `m.per_message_profile` once servers emit it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PerMessageProfileView {
    pub id: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub pronouns: Vec<PronounView>,
    /// Author-chosen, so it is arbitrary and not theme-aware. The UI has to
    /// hold it to a legibility floor against whatever surface is active.
    pub color_on_light: Option<String>,
    pub color_on_dark: Option<String>,
    /// The sender prefixed the body with the profile name for clients that
    /// cannot read the profile.
    #[serde(default)]
    pub has_fallback: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PersonaView {
    pub id: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub pronouns: Vec<PronounView>,
    pub color_on_light: Option<String>,
    pub color_on_dark: Option<String>,
    #[serde(default)]
    pub triggers: Vec<PersonaTriggerView>,
    pub pluralkit: Option<PluralkitImportView>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub last_used: Option<u64>,
    pub alternate_avatars: Option<Vec<PersonaAlternateAvatarView>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PersonaAlternateAvatarView {
    pub id: String,
    pub avatar_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PersonaTriggerView {
    pub prefix: Option<String>,
    pub suffix: Option<String>,
    #[serde(default)]
    pub keep_trigger: bool,
    pub alternate_avatar_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PluralkitImportView {
    pub id: String,
    pub uuid: Option<String>,
    pub avatar_url: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PersonaSelectionView {
    pub persona_id: String,
    pub alternate_avatar_id: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub valid_until: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PersonaCatalogView {
    pub personas: Vec<PersonaView>,
    pub account: Option<PersonaSelectionView>,
    pub rooms: std::collections::BTreeMap<String, PersonaSelectionView>,
    pub disabled_rooms: Vec<String>,
}

/// The SDK loads the body lazily, so it is absent for an event we have never
/// seen until `FetchEventDetails` fills it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ReplyView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub event_id: OwnedEventId,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub sender: Option<OwnedUserId>,
    pub sender_mentioned: bool,
    pub sender_name: Option<String>,
    pub body: Option<String>,
    /// Set instead of `body` when the replied-to event has none to show.
    pub fallback: Option<ReplyFallbackView>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct EditVersionView {
    pub event_id: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub timestamp: u64,
    pub body: String,
    pub html: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ThreadSummaryView {
    /// Excludes the root, so zero if every reply was redacted.
    pub num_replies: u32,
    /// The latest reply's id, so the UI can strip its per-message-profile
    /// fallback like a reply preview. Absent for a local echo or an unloaded
    /// event.
    pub latest_event_id: Option<String>,
    pub latest_body: Option<String>,
    /// What the latest reply was when it has no body to show.
    pub latest_fallback: Option<ReplyFallbackView>,
}

/// Without this a failed send renders as an ordinary message.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SendStateView {
    Sending {
        /// Media uploads only.
        progress: Option<UploadProgressView>,
    },
    Failed {
        error: String,
        /// A recoverable failure resumes by itself. An unrecoverable one is
        /// parked until `RetrySend` or `CancelSend`, so only it needs a prompt.
        recoverable: bool,
        blocked: Option<SendBlockView>,
    },
    /// Accepted, still waiting to arrive through sync.
    Sent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum QrLoginProgressView {
    Starting,
    ShowCode { code: QrCodeView },
    EnterCheckCode,
    ShowCheckCode { check_code: u8 },
    WaitingForToken { user_code: String },
    WaitingForAuth { verification_uri: String },
    SyncingSecrets,
    Done,
    SignedIn { user_id: String },
    Failed { reason: QrLoginFailureView },
}

impl QrLoginProgressView {
    #[must_use]
    pub const fn stage(&self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::ShowCode { .. } => "show_code",
            Self::EnterCheckCode => "enter_check_code",
            Self::ShowCheckCode { .. } => "show_check_code",
            Self::WaitingForToken { .. } => "waiting_for_token",
            Self::WaitingForAuth { .. } => "waiting_for_auth",
            Self::SyncingSecrets => "syncing_secrets",
            Self::Done => "done",
            Self::SignedIn { .. } => "signed_in",
            Self::Failed { .. } => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum QrLoginFailureView {
    Unsupported,
    Expired,
    CheckCode,
    Declined,
    NoRecovery,
    DeviceInUse,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SendBlockView {
    IdentityChanged { user_ids: Vec<String> },
    VerifyThisDevice,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct UploadProgressView {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub index: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub current: usize,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimelineItemContentView {
    Message {
        /// Plain text, for previews and notifications.
        body: String,
        /// Sanitised display HTML, safe to inject as-is.
        html: String,
        /// `m.emote`, which reads as an action by the sender rather than speech.
        emote: bool,
        notice: bool,
        edited: bool,
        /// Drawn larger, 1 to 4, when the message is nothing but emoji or
        /// inline emotes.
        #[cfg_attr(feature = "typegen", specta(optional))]
        jumbo: Option<u8>,
    },
    Image {
        filename: String,
        caption: Option<String>,
        /// Sanitised display HTML for a formatted caption, when present.
        html: Option<String>,
        source: String,
        mime: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        width: Option<u64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        height: Option<u64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        size: Option<u64>,
        blurhash: Option<String>,
        thumbnail: Option<String>,
        spoiler: Option<String>,
        #[cfg_attr(feature = "typegen", specta(optional))]
        animated: Option<bool>,
    },
    Video {
        filename: String,
        caption: Option<String>,
        /// Sanitised display HTML for a formatted caption, when present.
        html: Option<String>,
        source: String,
        mime: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        width: Option<u64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        height: Option<u64>,
        blurhash: Option<String>,
        thumbnail: Option<String>,
        spoiler: Option<String>,
        playback: Option<VideoPlaybackView>,
    },
    Audio {
        filename: String,
        caption: Option<String>,
        /// Sanitised display HTML for a formatted caption, when present.
        html: Option<String>,
        source: String,
        mime: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        duration_ms: Option<u64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<Vec<specta_typescript::Number>>))]
        waveform: Option<Vec<f32>>,
        voice: bool,
        metadata: Option<AudioMetadataView>,
    },
    File {
        filename: String,
        caption: Option<String>,
        /// Sanitised display HTML for a formatted caption, when present.
        html: Option<String>,
        source: String,
        mime: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        size: Option<u64>,
    },
    Sticker {
        body: String,
        source: String,
        mime: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        width: Option<u64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        height: Option<u64>,
    },
    /// The coordinates are absent for a `geo:` URI we cannot read; `geo_uri` is
    /// passed through as sent either way.
    Location {
        body: String,
        geo_uri: String,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        latitude: Option<f64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        longitude: Option<f64>,
    },
    LiveLocation {
        body: String,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        latitude: Option<f64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        longitude: Option<f64>,
        live: bool,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        expires_at: u64,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        updated_at: Option<u64>,
    },
    CallInvite,
    VerificationRequest,
    /// The `im.fluffychat.cute_event` msgtype, such as a hug or a wave.
    Cute {
        cute_type: Option<String>,
        body: String,
    },
    Malformed {
        event_type: String,
    },
    /// MSC4274.
    Gallery {
        /// The caption shared by the whole set.
        body: String,
        /// Sanitised display HTML, safe to inject as-is.
        html: String,
        items: Vec<GalleryItemView>,
    },
    /// MSC3381, with the responses and the end event already folded in.
    Poll {
        poll: PollView,
    },
    Redacted {
        reason: Option<String>,
        #[cfg_attr(feature = "typegen", specta(optional))]
        redacted_by: Option<String>,
    },
    UnableToDecrypt {
        reason: UtdCauseView,
        session_id: Option<String>,
    },
    Membership {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        user_id: OwnedUserId,
        change: MembershipChangeView,
        /// The member's name at the time, so the copy does not have to fall
        /// back to a raw user id.
        display_name: Option<String>,
        reason: Option<String>,
    },
    /// A display name or avatar change on an already-joined member. Separate
    /// from `Membership` because clients hide these by default.
    ProfileChange {
        #[cfg_attr(feature = "typegen", specta(type = String))]
        user_id: OwnedUserId,
        display_name: Option<DisplayNameChangeView>,
        /// `new` is `None` when the member cleared their avatar rather than
        /// replacing it, which is a different sentence.
        avatar: Option<AvatarChangeView>,
    },
    /// Any other state event. Reported rather than dropped so the UI can decide
    /// what to render and what to keep behind a "show hidden events" setting.
    StateEvent {
        /// e.g. `m.room.topic`.
        event_type: String,
        state_key: String,
        /// Raw content, for the developer-only peek. Absent if the event's
        /// JSON is no longer around.
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
        content: Option<serde_json::Value>,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
        prev_content: Option<serde_json::Value>,
        /// `None` leaves the UI with only `event_type` to show.
        change: Option<StateChangeView>,
    },
    /// A message-like event the SDK has no item for. Only ever reaches the UI
    /// when the timeline was built with hidden events on; the default filter
    /// drops these.
    HiddenEvent {
        /// e.g. `m.key.verification.start`.
        event_type: String,
        /// Raw content, for the developer-only peek. Absent if the event's
        /// JSON is no longer around.
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
        content: Option<serde_json::Value>,
        #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
        redacts: Option<OwnedEventId>,
    },
    DateDivider {
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        timestamp: u64,
    },
    ReadMarker,
    TimelineStart,
    /// Unmodelled, kept as a stub so wire indices stay aligned with the SDK's.
    Unsupported {
        description: String,
    },
}

impl TimelineItemContentView {
    #[must_use]
    pub const fn row_kind(&self) -> TimelineRowKind {
        match self {
            Self::Message { .. }
            | Self::Image { .. }
            | Self::Video { .. }
            | Self::Audio { .. }
            | Self::File { .. }
            | Self::Sticker { .. }
            | Self::Gallery { .. }
            | Self::Location { .. }
            | Self::LiveLocation { .. }
            | Self::Poll { .. }
            | Self::Redacted { .. }
            | Self::UnableToDecrypt { .. } => TimelineRowKind::Message,
            Self::DateDivider { .. } | Self::ReadMarker | Self::TimelineStart => {
                TimelineRowKind::Annotation
            }
            Self::CallInvite
            | Self::VerificationRequest
            | Self::Cute { .. }
            | Self::Malformed { .. }
            | Self::Membership { .. }
            | Self::ProfileChange { .. }
            | Self::StateEvent { .. }
            | Self::HiddenEvent { .. }
            | Self::Unsupported { .. } => TimelineRowKind::Event,
        }
    }

    #[must_use]
    pub const fn forwardable(&self) -> bool {
        matches!(
            self,
            Self::Message { .. }
                | Self::Image { .. }
                | Self::Video { .. }
                | Self::Audio { .. }
                | Self::File { .. }
                | Self::Sticker { .. }
                | Self::Location { .. }
                | Self::Gallery { .. }
        )
    }

    #[must_use]
    pub const fn visibility(&self) -> TimelineVisibility {
        match self {
            Self::Membership {
                change: MembershipChangeView::Other,
                ..
            } => TimelineVisibility::MembershipOther,
            Self::Membership { .. } => TimelineVisibility::Membership,
            Self::ProfileChange { .. } => TimelineVisibility::ProfileChange,
            Self::Redacted { .. } => TimelineVisibility::Tombstone,
            Self::StateEvent { change: None, .. } | Self::HiddenEvent { .. } => {
                TimelineVisibility::Hidden
            }
            _ => TimelineVisibility::Always,
        }
    }

    #[must_use]
    pub const fn redactable(&self) -> bool {
        !matches!(self, Self::Redacted { .. })
            && !matches!(self.row_kind(), TimelineRowKind::Annotation)
    }
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StateChangeView {
    RoomName {
        name: Option<String>,
        previous: Option<String>,
    },
    RoomTopic {
        topic: Option<String>,
    },
    RoomAvatar {
        removed: bool,
    },
    PinnedEvents {
        #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
        added: Vec<OwnedEventId>,
        #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
        removed: Vec<OwnedEventId>,
        #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
        total: u32,
    },
    /// MSC3401. An update that neither joins nor leaves carries no change.
    CallMembership {
        joined: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GalleryItemView {
    Image {
        filename: String,
        caption: Option<String>,
        source: String,
        mime: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        width: Option<u64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        height: Option<u64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        size: Option<u64>,
        blurhash: Option<String>,
        thumbnail: Option<String>,
        spoiler: Option<String>,
    },
    Video {
        filename: String,
        caption: Option<String>,
        source: String,
        mime: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        width: Option<u64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        height: Option<u64>,
        blurhash: Option<String>,
        thumbnail: Option<String>,
        spoiler: Option<String>,
    },
    Audio {
        filename: String,
        caption: Option<String>,
        source: String,
        mime: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        duration_ms: Option<u64>,
        #[cfg_attr(feature = "typegen", specta(type = Option<Vec<specta_typescript::Number>>))]
        waveform: Option<Vec<f32>>,
    },
    File {
        filename: String,
        caption: Option<String>,
        source: String,
        mime: Option<String>,
        #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
        size: Option<u64>,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum UtdCauseView {
    Unknown,
    SentBeforeWeJoined,
    VerificationViolation,
    UnsignedDevice,
    UnknownDevice,
    HistoricalMessageBackupDisabled,
    HistoricalMessageDeviceUnverified,
    WithheldForUnverifiedOrInsecureDevice,
    WithheldBySender,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct UserDirectoryEntryView {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct TurnServerView {
    pub username: String,
    pub password: String,
    pub uris: Vec<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub ttl_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RelationsView {
    #[cfg_attr(feature = "typegen", specta(type = Vec<specta_typescript::Unknown>))]
    pub chunk: Vec<serde_json::Value>,
    pub next_batch: Option<String>,
    pub prev_batch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct TermsPolicyView {
    pub url: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct OpenIdTokenView {
    pub access_token: String,
    pub token_type: String,
    pub matrix_server_name: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub expires_in_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ScheduledMessageView {
    pub delay_id: String,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub body: String,
    pub formatted: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub delay_ms: u64,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub delivery_ts: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PollView {
    pub question: String,
    pub answers: Vec<PollAnswerView>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub max_selections: u32,
    /// Every answer's `votes` stays absent until `ended_at` is set.
    pub undisclosed: bool,
    /// Votes cast after this are not counted.
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub ended_at: Option<u64>,
    pub edited: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PollAnswerView {
    #[cfg_attr(feature = "typegen", specta(type = Option<Vec<String>>))]
    pub voters: Option<Vec<OwnedUserId>>,
    pub id: String,
    pub text: String,
    /// Absent while an undisclosed poll is still open.
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub votes: Option<u32>,
    pub selected: bool,
}

/// The SDK's `MembershipChange`, narrowed to the transitions worth wording.
/// Anything unrecognised collapses to `Other`, which the UI hides.
#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum MembershipChangeView {
    Joined,
    Left,
    Banned,
    Unbanned,
    Kicked,
    Invited,
    KickedAndBanned,
    InvitationAccepted,
    InvitationRejected,
    InvitationRevoked,
    Knocked,
    KnockAccepted,
    KnockRetracted,
    KnockDenied,
    Other,
}

/// `None` on either side means the name was unset, which reads differently from
/// a rename.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct DisplayNameChangeView {
    pub old: Option<String>,
    pub new: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct AvatarChangeView {
    pub old: Option<String>,
    pub new: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ReactionGroup {
    pub key: String,
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub senders: Vec<OwnedUserId>,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct WebPushKeys {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

/// Read raw: ruma's `Pusher` carries neither a custom kind nor `activated`.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RegisteredPusherView {
    pub pushkey: String,
    pub app_id: String,
    /// `http`, `email`, the web push kind, or a server-defined kind.
    pub kind: Option<String>,
    pub device_display_name: Option<String>,
    /// Some pusher kinds validate through a handshake; absent elsewhere.
    pub activated: Option<bool>,
    pub gateway: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ShareHistoryView {
    Shared,
    Unencrypted,
    NoCrossSigning,
    HistoryNotShared,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiagnosticPushView {
    NoPusher,
    NoGateway,
    Rejected,
    Sent {
        event_id: String,
        accepted: Option<bool>,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct DefaultNotificationModesView {
    pub direct: NotificationModeView,
    pub group: NotificationModeView,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum MentionNotificationModeView {
    Off,
    Notify,
    Loud,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum MentionRuleView {
    Room,
    User,
    DisplayName,
    Username,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct MentionNotificationsView {
    pub room: Option<MentionNotificationModeView>,
    pub user: Option<MentionNotificationModeView>,
    pub display_name: Option<MentionNotificationModeView>,
    pub username: Option<MentionNotificationModeView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum EventNotificationView {
    Membership,
    Reactions,
    Edits,
    Notices,
    Invites,
    Calls,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct EventNotificationsView {
    pub membership: Option<bool>,
    pub reactions: Option<bool>,
    pub edits: Option<bool>,
    pub notices: Option<bool>,
    pub invites: Option<bool>,
    pub calls: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct KeywordNotificationView {
    pub keyword: String,
    pub mode: MentionNotificationModeView,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct NotificationSettingsView {
    /// The room's own rule. `null` means it follows `default`.
    pub room: Option<NotificationModeView>,
    pub default: NotificationModeView,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct NotificationView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub event_id: Option<OwnedEventId>,
    pub room_name: String,
    pub room_avatar_url: Option<String>,
    pub is_direct: bool,
    pub encrypted: bool,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub sender: OwnedUserId,
    pub sender_name: Option<String>,
    pub sender_avatar_url: Option<String>,
    pub body: String,
    pub mention: bool,
    pub noisy: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PushEventView {
    #[serde(rename = "type")]
    pub event_type: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub content: serde_json::Value,
    pub sender: String,
    pub sender_display_name: Option<String>,
    pub room_name: String,
    pub room_avatar_url: Option<String>,
    pub encrypted: bool,
    pub noisy: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PushFetchView {
    Event { event: PushEventView },
    Discard,
    Unavailable,
}

/// Structured, so arranging and localising the preview stays with the UI.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct LatestEventView {
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub sender: Option<OwnedUserId>,
    /// Plain text: a list row must not run untrusted HTML.
    pub body: String,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub timestamp: Option<u64>,
    pub sending: bool,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub event_id: Option<OwnedEventId>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct MemberView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub power_level: i64,
    pub membership: MembershipView,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub member_ts: Option<u64>,
    pub kicked: bool,
    pub service: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum MembershipView {
    Join,
    Invite,
    Knock,
    Leave,
    Ban,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ImagePackView {
    /// The state key for a room pack, empty for the account's own pack. Unique
    /// only together with `room_id`.
    pub id: String,
    pub origin: ImagePackOriginView,
    pub room_id: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub declared_name: Option<String>,
    pub declared_avatar_url: Option<String>,
    pub attribution: Option<String>,
    pub usage: Vec<ImageUsageView>,
    pub images: Vec<PackImageView>,
    pub stable_event: bool,
    pub legacy_event: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ImagePackOriginView {
    Account,
    Room,
    Global,
    Space,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PackImageView {
    pub shortcode: String,
    pub url: String,
    pub body: Option<String>,
    pub usage: Vec<ImageUsageView>,
    pub info: Option<PackImageInfoView>,
    pub source_pack: Option<ImageSourcePackView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ReactionShortcodeView {
    pub key: String,
    pub shortcode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ImageSourcePackView {
    pub room_id: String,
    pub state_key: String,
    pub shortcode: String,
    pub via: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ImageSourcePackReferenceView {
    pub url: String,
    pub source: ImageSourcePackView,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(default)]
pub struct PackImageInfoView {
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub width: Option<u32>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub height: Option<u32>,
    pub mimetype: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = Option<specta_typescript::Number>))]
    pub size: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ImageUsageView {
    Emoticon,
    Sticker,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ProfileView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    /// Sanitised display HTML, safe to inject as-is.
    pub bio: Option<String>,
    pub hero_color: Option<String>,
    /// Whether the writer meant the hero colour to be read as a light or a dark
    /// surface. Absent means the UI has to decide for itself.
    pub hero_brightness: Option<BrightnessView>,
    pub banner_url: Option<String>,
    pub status: Option<StatusView>,
    pub pronouns: Vec<PronounView>,
    /// IANA zone name; the UI turns it into the member's local time.
    pub timezone: Option<String>,
    /// Already resolved against the deprecated per-theme fields, so the UI only
    /// has to pick by the theme it is rendering.
    pub name_color_light: Option<String>,
    pub name_color_dark: Option<String>,
    pub animal: Option<AnimalIdentityView>,
    /// Extended fields this client has no rendering for, kept so a profile that
    /// another client wrote is still readable here.
    pub extra: Vec<ProfileFieldView>,
    pub supporter_awards: Option<String>,
    pub legacy_fields: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum BrightnessView {
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct MutualRoomView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub name: Option<String>,
    pub is_space: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct InviteTriageView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    #[cfg_attr(feature = "typegen", specta(type = Option<String>))]
    pub inviter: Option<OwnedUserId>,
    pub reason: Option<String>,
    pub shares_room: bool,
    pub inviter_banned: bool,
}

/// MSC4426 status. The emoji is optional here even though the MSC requires
/// it, because the older single-string status fields carry no emoji.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct StatusView {
    pub text: String,
    pub emoji: Option<String>,
}

/// One `JSCalendar` event from a `chat.commet.calendar_events` room event.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct CalendarEntryView {
    pub event_id: String,
    pub sender: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub timestamp: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Unknown))]
    pub event: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct CalendarView {
    pub entries: Vec<CalendarEntryView>,
    pub rsvps: Vec<CalendarRsvpView>,
}

/// Bridge hints from a video's `info`: the `fi.mau.*` flags mautrix sets on gifs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[expect(
    clippy::struct_excessive_bools,
    reason = "wire type mirroring the protocol"
)]
pub struct VideoPlaybackView {
    pub gif: bool,
    pub autoplay: bool,
    pub looping: bool,
    pub hide_controls: bool,
    pub no_audio: bool,
}

/// MSC4549 track details from an `m.audio` event's `info`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct AudioMetadataView {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover_art_blurhash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PinReadStateView {
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub pinned_ids: Vec<OwnedEventId>,
    pub unread: u32,
    /// Pins added since this account last looked.
    #[cfg_attr(feature = "typegen", specta(type = Vec<String>))]
    pub fresh_ids: Vec<OwnedEventId>,
}

/// MSC4529 keeps three states apart: no override, an override that removes
/// the value, and an override that replaces it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OverrideTextView {
    Unset,
    Cleared,
    Set { value: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OverrideColorView {
    Unset,
    Cleared,
    Set {
        light: Option<String>,
        dark: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ProfileOverrideView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub display_name: OverrideTextView,
    /// An `mxc://` URI, or an encrypted file's JSON that `fetch_media` opens.
    pub avatar: OverrideTextView,
    pub color: OverrideColorView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ProfileOverridesView {
    pub overrides: Vec<ProfileOverrideView>,
    pub protection: SealStateView,
    pub can_seal: bool,
}

/// MSC4278. `None` means the event does not say.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct MediaPreviewConfigView {
    pub media_previews: Option<MediaPreviewsView>,
    pub invite_avatars: Option<InviteAvatarsView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum MediaPreviewsView {
    On,
    /// Only in rooms that are not public.
    Private,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum InviteAvatarsView {
    On,
    Off,
}

/// What the pack editor holds; the core turns it into MSC2545 content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PackDraftView {
    pub name: String,
    pub avatar_url: Option<String>,
    pub attribution: String,
    pub usage: Vec<ImageUsageView>,
    pub images: Vec<PackImageDraftView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PackImageDraftView {
    pub shortcode: String,
    pub url: String,
    pub body: Option<String>,
    pub usage: Vec<ImageUsageView>,
    pub info: Option<PackImageInfoView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PackAddressView {
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub room_id: OwnedRoomId,
    pub state_key: String,
}

/// A term the room explains on hover. An uncased term matches any casing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct AbbreviationView {
    pub term: String,
    pub definition: String,
    #[serde(default)]
    pub cased: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum HistoryVisibilityView {
    Shared,
    Invited,
    Joined,
    WorldReadable,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct MemberLookView {
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub color_on_light: Option<String>,
    pub color_on_dark: Option<String>,
    pub pronouns: Vec<PronounView>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct AnimalIdentityView {
    pub is_animal: Option<String>,
    pub has_animal: Option<String>,
    pub animal_need: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ProfileFieldView {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
// Independent server capabilities.
#[expect(
    clippy::struct_excessive_bools,
    reason = "wire type mirroring the protocol"
)]
pub struct LoginFlowsView {
    pub password: bool,
    pub oidc: bool,
    pub oidc_registration: bool,
    pub qr_login: bool,
    pub sso: bool,
    pub oauth_aware_preferred: bool,
    pub sso_identity_providers: Vec<SsoIdentityProviderView>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct RegistrationFlowsView {
    pub uiaa: bool,
    pub email: RegistrationRequirementView,
    pub registration_token: RegistrationRequirementView,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RegistrationRequirementView {
    Unavailable,
    Optional,
    Required,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SsoIdentityProviderView {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub brand: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SessionInfo {
    pub account_id: String,
    #[cfg_attr(feature = "typegen", specta(type = String))]
    pub user_id: OwnedUserId,
    pub device_id: String,
    pub homeserver: String,
    pub needs_reauth: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct HomeserverSoftwareView {
    pub name: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SyncStatus {
    Offline,
    Syncing,
    Live,
    Error { message: String },
}

#[derive(Debug, Clone, serde::Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[expect(
    clippy::struct_excessive_bools,
    reason = "wire type mirroring the protocol"
)]
pub struct InboxItemView {
    pub room_id: String,
    pub event_id: String,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub ts: u64,
    pub sender: String,
    pub sender_name: Option<String>,
    pub body: Option<String>,
    pub highlight: bool,
    pub is_direct: bool,
    pub encrypted: bool,
    pub read: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct BookmarkView {
    pub bookmark_id: String,
    pub room_id: String,
    pub event_id: String,
    pub room_name: Option<String>,
    pub sender: Option<String>,
    pub body_preview: Option<String>,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub event_ts: u64,
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub bookmarked_ts: u64,
}
