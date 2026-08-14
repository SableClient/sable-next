use matrix_sdk::ruma::{OwnedDeviceId, OwnedEventId, OwnedRoomId, OwnedUserId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    DiscoverHomeserver {
        server_name: String,
    },
    Login {
        homeserver: String,
        username: String,
        password: String,
    },
    LoginFlows {
        homeserver: String,
    },
    RegistrationFlows {
        homeserver: String,
    },
    Register {
        homeserver: String,
        username: String,
        password: String,
        registration_email: Option<String>,
        registration_token: Option<String>,
    },
    RequestRegistrationEmail {
        email: String,
    },
    SubmitRegistrationEmail {
        token: String,
    },
    ContinueRegistration,
    CancelRegistration,
    StartOidcLogin {
        homeserver: String,
        redirect_uri: String,
        intent: AuthIntent,
    },
    CompleteOidcLogin {
        callback_url: String,
    },
    StartSsoLogin {
        homeserver: String,
        redirect_uri: String,
        idp_id: Option<String>,
        intent: AuthIntent,
    },
    CompleteSsoLogin {
        callback_url: String,
    },
    Restore,
    ListAccounts,
    SwitchAccount {
        account_id: String,
    },
    Logout,

    SubscribeRoomList,
    SubscribeTimeline {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string | null")]
        event_id: Option<OwnedEventId>,
    },
    Unsubscribe {
        subscription: SubscriptionId,
    },

    Paginate {
        subscription: SubscriptionId,
        direction: PaginationDirection,
        count: u16,
    },
    RoomMembers {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    UserProfile {
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },
    /// What this account shares with another user: both answers come from local
    /// state, so the profile card's action row needs one call rather than two.
    UserRelations {
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },
    SendMessage {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        body: String,
        formatted: Option<String>,
        /// Replying inside a thread needs no extra field: the SDK infers the
        /// thread from the replied-to event.
        #[ts(type = "string | null")]
        in_reply_to: Option<OwnedEventId>,
    },
    /// `edited` on the view flips once the server has the replacement.
    EditMessage {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        body: String,
        formatted: Option<String>,
    },
    /// The filled-in details arrive as a timeline diff, not as the response.
    FetchEventDetails {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
    },
    Redact {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        reason: Option<String>,
    },
    React {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        key: String,
    },
    MarkRead {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
    },
    RetrySend {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        transaction_id: String,
    },
    /// A local echo is not on the server, so it cannot be redacted.
    CancelSend {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        transaction_id: String,
    },

    /// A space is an `m.room.create` with `type: m.space`.
    CreateRoom {
        name: Option<String>,
        topic: Option<String>,
        is_space: bool,
        /// Published in the directory, joinable by link.
        public: bool,
        /// Ignored for a space or a public room.
        encrypted: bool,
        #[ts(type = "string[]")]
        invite: Vec<OwnedUserId>,
        /// Adds an `m.space.child` edge from this space.
        #[ts(type = "string | null")]
        parent_space: Option<OwnedRoomId>,
    },
    /// Reuses an existing DM with this user if there is one.
    CreateDm {
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },
    AddToSpace {
        #[ts(type = "string")]
        space_id: OwnedRoomId,
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    RemoveFromSpace {
        #[ts(type = "string")]
        space_id: OwnedRoomId,
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },

    // membership. Accepting an invite is `JoinRoom`, declining it `LeaveRoom`.
    JoinRoom {
        /// A room id or an alias. A pasted address could be either.
        address: String,
        /// Servers to try when the id is not resolvable on ours, or empty.
        via: Vec<String>,
    },
    LeaveRoom {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    InviteUser {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },

    EncryptionStatus,
    Devices,
    /// Verifies this device and unlocks existing history.
    RecoverIdentity {
        recovery_key: String,
    },
    /// First-time cross-signing and key backup. Without it a lone session can
    /// never verify a second. The returned key is unrecoverable, so a UI must
    /// make the user store it.
    EnableRecovery {
        /// A passphrase to unlock the key with. The key is returned either way.
        passphrase: Option<String>,
    },
    /// Issues a new key and abandons whatever the old backup held. For a key the
    /// user has lost, not for rotation.
    ResetRecoveryKey {
        passphrase: Option<String>,
    },
    /// Call without a password first: the server states its terms in an
    /// `interactive_auth_required` error, and only then is there a prompt.
    DeleteDevice {
        #[ts(type = "string")]
        device_id: OwnedDeviceId,
        password: Option<String>,
    },
    RenameDevice {
        #[ts(type = "string")]
        device_id: OwnedDeviceId,
        display_name: String,
    },

    /// `null` clears it.
    SetDisplayName {
        name: Option<String>,
    },
    /// An `mxc:` URI from the carrier's `uploadMedia`. `null` clears it.
    SetAvatarUrl {
        url: Option<String>,
    },
    /// `m.direct` is client-owned account data. Nothing else will correct it.
    SetDirect {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        direct: bool,
    },
    /// Server-side, so it survives a reinstall.
    IgnoreUser {
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },
    UnignoreUser {
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },
    /// The server expires it by itself, so a missed `false` is not fatal.
    SetTyping {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        typing: bool,
    },
    SetRoomTag {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        tag: RoomTag,
        /// False removes it.
        set: bool,
    },

    SetRoomName {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        name: Option<String>,
    },
    SetRoomTopic {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        topic: String,
    },
    SetRoomAvatar {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        url: Option<String>,
    },
    SetRoomJoinRule {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        rule: JoinRuleView,
    },
    /// Escape hatch for unmodelled state. `content` is validated only by the
    /// server, so prefer a typed command.
    SendStateEvent {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        event_type: String,
        state_key: String,
        #[ts(type = "unknown")]
        content: serde_json::Value,
    },
    /// Lowering our own cannot be undone. The level to raise it is gone.
    SetUserPowerLevel {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        user_id: OwnedUserId,
        power_level: i32,
    },

    KickUser {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        user_id: OwnedUserId,
        reason: Option<String>,
    },
    /// Also removes them from the room.
    BanUser {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        user_id: OwnedUserId,
        reason: Option<String>,
    },
    UnbanUser {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        user_id: OwnedUserId,
        reason: Option<String>,
    },
    /// Our own user id self-verifies another session. Progress arrives as
    /// `CoreEvent::Verification`.
    RequestVerification {
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },
    /// Also transitions into SAS, so the emoji need no further round trip.
    AcceptVerification {
        #[ts(type = "string")]
        user_id: OwnedUserId,
        flow_id: String,
    },
    /// The emoji matched.
    ConfirmVerification {
        #[ts(type = "string")]
        user_id: OwnedUserId,
        flow_id: String,
    },
    CancelVerification {
        #[ts(type = "string")]
        user_id: OwnedUserId,
        flow_id: String,
        /// The emoji differed. An attack signal the other side must be told
        /// about. A plain cancel is not.
        mismatch: bool,
    },
}

/// Paired with `Command` by variant name, so the generated TS resolves a
/// response type from a command type.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommandOk {
    DiscoverHomeserver {
        homeserver: String,
    },
    Login {
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },
    LoginFlows {
        flows: LoginFlowsView,
    },
    RegistrationFlows {
        flows: RegistrationFlowsView,
    },
    Register {
        result: RegistrationResultView,
    },
    ContinueRegistration {
        result: RegistrationResultView,
    },
    RequestRegistrationEmail {
        result: RegistrationResultView,
    },
    SubmitRegistrationEmail {
        result: RegistrationResultView,
    },
    CancelRegistration,
    StartOidcLogin {
        authorization_url: String,
    },
    CompleteOidcLogin {
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },
    StartSsoLogin {
        authorization_url: String,
    },
    CompleteSsoLogin {
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },
    Restore {
        session: Option<SessionInfo>,
    },
    ListAccounts {
        accounts: Vec<SessionInfo>,
    },
    SwitchAccount {
        session: SessionInfo,
    },
    Logout,

    /// The snapshot. Everything after it carries the same `subscription`.
    SubscribeRoomList {
        subscription: SubscriptionId,
        rooms: Vec<RoomSummary>,
    },
    SubscribeTimeline {
        subscription: SubscriptionId,
        items: Vec<TimelineItemView>,
    },
    Unsubscribe,

    Paginate {
        direction: PaginationDirection,
        reached_end: bool,
    },
    RoomMembers {
        members: Vec<MemberView>,
    },
    /// Boxed: the extended fields make this the widest variant by far.
    UserProfile {
        profile: Box<ProfileView>,
    },
    UserRelations {
        mutual_rooms: Vec<MutualRoomView>,
        ignored: bool,
    },
    /// The local echo arrives on the timeline diff stream.
    SendMessage,
    EditMessage,
    FetchEventDetails,
    Redact,
    React,
    MarkRead,
    RetrySend,
    /// False when there was no such echo left to discard.
    CancelSend {
        cancelled: bool,
    },

    CreateRoom {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    CreateDm {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    AddToSpace,
    RemoveFromSpace,

    /// Resolved, since the caller may have joined by alias.
    JoinRoom {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    LeaveRoom,
    InviteUser,

    EncryptionStatus {
        status: EncryptionStatusView,
    },
    Devices {
        devices: Vec<DeviceView>,
        account_management: bool,
    },
    RecoverIdentity,
    /// Unrecoverable once discarded.
    EnableRecovery {
        recovery_key: String,
    },
    ResetRecoveryKey {
        recovery_key: String,
    },
    DeleteDevice {
        management_url: Option<String>,
    },
    RenameDevice,

    SetDisplayName,
    SetAvatarUrl,
    IgnoreUser,
    UnignoreUser,
    SetTyping,
    SetRoomTag,

    SetDirect,
    SetRoomName,
    SetRoomTopic,
    SetRoomAvatar,
    SetRoomJoinRule,
    SendStateEvent,
    SetUserPowerLevel,

    KickUser,
    BanUser,
    UnbanUser,

    /// Carried by every later command and event for this verification.
    RequestVerification {
        flow_id: String,
    },
    AcceptVerification,
    ConfirmVerification,
    CancelVerification,
}

/// Stable serialized codes. Source chains, inputs and bodies stay native-side
/// and are logged there, so nothing leaks across the wire. The last four words
/// match the platform ports, so a core failure and a capability failure read
/// alike.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum CommandErr {
    NotLoggedIn,
    UnknownSubscription,
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
    InvalidMedia,
    /// Static: safe to hide UI.
    Unsupported,
    /// Retryable: keep UI.
    Unavailable,
    /// Refused, recoverable by user action.
    Denied,
    RateLimited {
        #[ts(type = "number | null")]
        retry_after_ms: Option<u64>,
    },
    RegistrationUnavailable,
    UsernameTaken,
    InvalidUsername,
    InvalidEmail,
    EmailVerificationFailed,
    WeakPassword,
    RegistrationStageFailed {
        stage: String,
    },
    /// Detail is in the core's log under `log_id`.
    Failed {
        log_id: String,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum AuthIntent {
    Login,
    Register,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum PaginationDirection {
    Backward,
    Forward,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RegistrationResultView {
    Complete {
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },
    Fallback {
        stage: String,
        fallback_url: String,
        completed: Vec<String>,
        total_stages: usize,
    },
    Email {
        email: Option<String>,
        submit_url: Option<String>,
        can_complete_out_of_band: bool,
        verified: bool,
        completed: Vec<String>,
        total_stages: usize,
    },
}

/// Pushed, unsolicited. Never a reply to a command.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CoreEvent {
    SyncStatus(SyncStatus),
    SessionEnded {
        reason: String,
    },

    /// One batch is one render, so it stays batched all the way to the UI.
    RoomListDiff {
        subscription: SubscriptionId,
        diffs: Vec<VectorDiff<RoomSummary>>,
    },
    TimelineDiff {
        subscription: SubscriptionId,
        diffs: Vec<VectorDiff<TimelineItemView>>,
    },
    TimelinePagination {
        subscription: SubscriptionId,
        loading: bool,
        reached_start: bool,
    },

    /// Our own user excluded. Absolute, so an empty list replaces the previous
    /// one. Sent for every joined room, since a room list row shows it too.
    Typing {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string[]")]
        user_ids: Vec<OwnedUserId>,
    },

    /// Pushed on every change, so the UI never polls to notice it is verified.
    EncryptionStatus {
        status: EncryptionStatusView,
    },

    /// An incoming request arrives unsolicited. There is no other prompt.
    Verification {
        #[ts(type = "string")]
        user_id: OwnedUserId,
        flow_id: String,
        state: VerificationView,
    },

    /// Never arrives on a homeserver with presence disabled.
    Presence {
        #[ts(type = "string")]
        user_id: OwnedUserId,
        presence: PresenceView,
        status_message: Option<String>,
        #[ts(type = "number | null")]
        last_active_ago: Option<u64>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum PresenceView {
    Online,
    Offline,
    Unavailable,
}

/// Mirrors `eyeball_im::VectorDiff`, which is not `TS` and whose `Vector<T>`
/// has to flatten to a plain array on the wire.
#[derive(Debug, Serialize, TS)]
#[ts(export)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum VectorDiff<T> {
    Append { values: Vec<T> },
    Clear,
    PushFront { value: T },
    PushBack { value: T },
    PopFront,
    PopBack,
    Insert { index: usize, value: T },
    Set { index: usize, value: T },
    Remove { index: usize },
    Truncate { length: usize },
    Reset { values: Vec<T> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SubscriptionId(pub u32);

// View types. Hand-narrowed, keeping the UI off the SDK's shapes.

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct RoomSummary {
    #[ts(type = "string")]
    pub room_id: OwnedRoomId,
    pub canonical_alias: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub is_direct: bool,
    /// An `invited` room is an invitation to accept, not a room to open.
    pub state: RoomStateView,
    /// `null` until the state event loads, which is not the same as `false`.
    pub encrypted: Option<bool>,
    pub is_space: bool,
    /// Spaces are a DAG, so there can be several.
    #[ts(type = "string[]")]
    pub space_parents: Vec<OwnedRoomId>,
    /// Already sorted by `order`, then the child event's age.
    #[ts(type = "Array<{ room_id: string, order: string | null, origin_server_ts: number }>")]
    pub space_children: Vec<SpaceChildEdge>,
    pub unread: u32,
    pub highlight: u32,
    pub latest_event: Option<LatestEventView>,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export)]
pub struct EncryptionStatusView {
    /// Whether *this* device is signed by our own identity.
    pub verification: VerificationStateView,
    pub recovery: RecoveryStateView,
    /// All three keys held locally, so this device can sign others. False means
    /// verification must come from another session.
    pub cross_signing_ready: bool,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStateView {
    Unknown,
    Verified,
    Unverified,
}

/// `incomplete` means secret storage exists but this device lacks secrets from
/// it, so recovery will fix decryption.
#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryStateView {
    Unknown,
    Enabled,
    Disabled,
    Incomplete,
}

/// The SDK splits this across a request and the SAS it becomes, with a state
/// enum each. The UI shows one dialog, so both flatten into this sequence.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
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
    /// `decimals` is the fallback when the other side refused emoji.
    Compare {
        emojis: Vec<EmojiView>,
        #[ts(type = "[number, number, number]")]
        decimals: (u16, u16, u16),
    },
    /// We said they match, but the other side has not.
    Confirmed,
    Done,
    Cancelled {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct EmojiView {
    pub symbol: String,
    /// English, from the spec's table.
    pub description: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct DeviceView {
    #[ts(type = "string")]
    pub device_id: OwnedDeviceId,
    pub display_name: Option<String>,
    pub is_verified: bool,
    /// The session this core is running in.
    pub is_own: bool,
}

/// `restricted` and `knock_restricted` need an allowed-spaces list, so they are
/// not settable here.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum JoinRuleView {
    Public,
    Invite,
    /// Anyone may ask. A member approves.
    Knock,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum RoomTag {
    Favourite,
    LowPriority,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum RoomStateView {
    Joined,
    Invited,
    Knocked,
    Left,
    Banned,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct SpaceChildEdge {
    #[ts(type = "string")]
    pub room_id: OwnedRoomId,
    /// `m.space.child.content.order`, unordered children sort last.
    pub order: Option<String>,
    /// Used to consistently order sibling child edges with equal `order` values.
    #[ts(type = "number")]
    pub origin_server_ts: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct TimelineItemView {
    /// Not an event id. Stable across a local echo becoming remote.
    pub id: String,
    /// Absent while the event is still a local echo.
    #[ts(type = "string | null")]
    pub event_id: Option<OwnedEventId>,
    /// A local echo's only handle, since it has no event id yet.
    pub transaction_id: Option<String>,
    pub send_state: Option<SendStateView>,
    /// Dividers and markers have no sender.
    #[ts(type = "string | null")]
    pub sender: Option<OwnedUserId>,
    pub sender_name: Option<String>,
    pub sender_avatar: Option<String>,
    #[ts(type = "number")]
    pub timestamp: u64,
    pub content: TimelineItemContentView,
    pub in_reply_to: Option<ReplyView>,
    /// Set on the root and on every reply, so a UI with no thread view can hide
    /// the replies.
    #[ts(type = "string | null")]
    pub thread_root: Option<OwnedEventId>,
    pub thread_summary: Option<ThreadSummaryView>,
    pub reactions: Vec<ReactionGroup>,
    pub is_own: bool,
    /// Already reduced by the SDK to one receipt per user.
    #[ts(type = "string[]")]
    pub read_by: Vec<OwnedUserId>,
}

/// The SDK loads the body lazily, so it is absent for an event we have never
/// seen until `FetchEventDetails` fills it.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ReplyView {
    #[ts(type = "string")]
    pub event_id: OwnedEventId,
    #[ts(type = "string | null")]
    pub sender: Option<OwnedUserId>,
    pub sender_name: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ThreadSummaryView {
    /// Excludes the root, so zero if every reply was redacted.
    pub num_replies: u32,
    pub latest_body: Option<String>,
}

/// Without this a failed send renders as an ordinary message.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum SendStateView {
    Sending {
        /// Media uploads only.
        #[ts(type = "{ current: number, total: number } | null")]
        progress: Option<UploadProgressView>,
    },
    Failed {
        error: String,
        /// A recoverable failure resumes by itself. An unrecoverable one is
        /// parked until `RetrySend` or `CancelSend`, so only it needs a prompt.
        recoverable: bool,
    },
    /// Accepted, still waiting to arrive through sync.
    Sent,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export)]
pub struct UploadProgressView {
    #[ts(type = "number")]
    pub current: usize,
    #[ts(type = "number")]
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimelineItemContentView {
    Message {
        /// Plain text, for previews and notifications.
        body: String,
        /// Sanitised display HTML, safe to inject as-is.
        html: String,
        /// `m.emote`, which reads as an action by the sender rather than speech.
        emote: bool,
        edited: bool,
    },
    Image {
        body: String,
        source: String,
        mime: Option<String>,
        #[ts(type = "number | null")]
        width: Option<u64>,
        #[ts(type = "number | null")]
        height: Option<u64>,
    },
    Video {
        body: String,
        source: String,
        mime: Option<String>,
        #[ts(type = "number | null")]
        width: Option<u64>,
        #[ts(type = "number | null")]
        height: Option<u64>,
    },
    Audio {
        body: String,
        source: String,
        mime: Option<String>,
    },
    File {
        body: String,
        source: String,
        mime: Option<String>,
    },
    Sticker {
        body: String,
        source: String,
        mime: Option<String>,
        #[ts(type = "number | null")]
        width: Option<u64>,
        #[ts(type = "number | null")]
        height: Option<u64>,
    },
    Redacted,
    UnableToDecrypt {
        reason: String,
    },
    Membership {
        #[ts(type = "string")]
        user_id: OwnedUserId,
        change: String,
    },
    DateDivider {
        #[ts(type = "number")]
        timestamp: u64,
    },
    ReadMarker,
    TimelineStart,
    /// Unmodelled, kept as a stub so wire indices stay aligned with the SDK's.
    Unsupported {
        description: String,
    },
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ReactionGroup {
    pub key: String,
    #[ts(type = "string[]")]
    pub senders: Vec<OwnedUserId>,
}

/// Structured, so arranging and localising the preview stays with the UI.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct LatestEventView {
    #[ts(type = "string | null")]
    pub sender: Option<OwnedUserId>,
    /// Plain text: a list row must not run untrusted HTML.
    pub body: String,
    #[ts(type = "number | null")]
    pub timestamp: Option<u64>,
    pub sending: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct MemberView {
    #[ts(type = "string")]
    pub user_id: OwnedUserId,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub power_level: i32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ProfileView {
    #[ts(type = "string")]
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
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum BrightnessView {
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct MutualRoomView {
    #[ts(type = "string")]
    pub room_id: OwnedRoomId,
    pub name: Option<String>,
}

/// MSC4426 `m.status`. The emoji is optional here even though the MSC requires
/// it, because the older single-string status fields carry no emoji.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct StatusView {
    pub text: String,
    pub emoji: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct PronounView {
    pub summary: String,
    /// Absent when the writer did not tag the set with a language.
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct AnimalIdentityView {
    pub is_animal: Option<String>,
    pub has_animal: Option<String>,
    pub animal_need: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ProfileFieldView {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
// These are independent server capabilities, not a state machine.
#[allow(clippy::struct_excessive_bools)]
pub struct LoginFlowsView {
    pub password: bool,
    pub oidc: bool,
    pub oidc_registration: bool,
    pub sso: bool,
    pub oauth_aware_preferred: bool,
    pub sso_identity_providers: Vec<SsoIdentityProviderView>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct RegistrationFlowsView {
    pub uiaa: bool,
    pub email: RegistrationRequirementView,
    pub registration_token: RegistrationRequirementView,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationRequirementView {
    Unavailable,
    Optional,
    Required,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct SsoIdentityProviderView {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub brand: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct SessionInfo {
    pub account_id: String,
    #[ts(type = "string")]
    pub user_id: OwnedUserId,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SyncStatus {
    Offline,
    Syncing,
    Live,
    Error { message: String },
}
