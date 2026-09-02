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
    RemoveAccount {
        account_id: String,
    },
    Logout,
    HomeserverInfo,

    SubscribeRoomList,
    SubscribeTimeline {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[serde(default)]
        focus: TimelineFocusView,
        /// Relaxes the event filter so events the SDK would otherwise drop
        /// arrive as `HiddenEvent`. Baked into the timeline, so flipping it
        /// means re-subscribing.
        hidden_events: bool,
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
        #[serde(default)]
        memberships: Vec<MembershipView>,
    },
    RoomPermissions {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    NotificationSettings {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    DefaultNotificationModes,
    Notification {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
    },
    ImagePacks {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    AllImagePacks,
    UserProfile {
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },
    UserRelations {
        #[ts(type = "string")]
        user_id: OwnedUserId,
    },
    SendMessage {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        body: String,
        formatted: Option<String>,
        #[serde(default)]
        kind: MessageKind,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
        /// Replying inside a thread needs no extra field: the SDK infers the
        /// thread from the replied-to event.
        #[ts(type = "string | null")]
        in_reply_to: Option<OwnedEventId>,
        #[serde(default)]
        #[ts(type = "string[]")]
        mentions: Vec<OwnedUserId>,
        #[serde(default)]
        mentions_room: bool,
        #[serde(default)]
        persona: Option<PerMessageProfileView>,
    },
    SendRawEvent {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        event_type: String,
        #[ts(type = "unknown")]
        content: serde_json::Value,
    },
    SendSticker {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        /// `mxc://` only; the core rejects anything else.
        url: String,
        body: String,
        #[serde(default)]
        info: Option<PackImageInfoView>,
        #[serde(default)]
        #[ts(type = "string | null")]
        in_reply_to: Option<OwnedEventId>,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
    },
    SendGif {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        /// `mxc://` only; the core rejects anything else.
        url: String,
        body: String,
        #[ts(type = "number | null")]
        width: Option<u32>,
        #[ts(type = "number | null")]
        height: Option<u32>,
        mimetype: String,
        #[ts(type = "number | null")]
        size: Option<u32>,
        #[serde(default)]
        #[ts(type = "string | null")]
        in_reply_to: Option<OwnedEventId>,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
    },
    /// `edited` on the view flips once the server has the replacement.
    EditMessage {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        body: String,
        formatted: Option<String>,
        #[serde(default)]
        kind: MessageKind,
        /// Present when editing an image caption, so the replacement retains its media.
        #[serde(default)]
        image: Option<EditImageView>,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
        #[serde(default)]
        #[ts(type = "string[]")]
        mentions: Vec<OwnedUserId>,
        #[serde(default)]
        mentions_room: bool,
        #[serde(default)]
        persona: Option<PerMessageProfileView>,
    },
    /// The filled-in details arrive as a timeline diff, not as the response.
    FetchEventDetails {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
    },
    Redact {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        reason: Option<String>,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
    },
    BulkRedact {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        senders: Vec<String>,
        #[ts(type = "number")]
        after_ts: u64,
        event_types: Vec<String>,
        reason: Option<String>,
    },
    PinnedEvents {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    SetPinned {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        pinned: bool,
    },
    RoomPowerLevels {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    RoomVersions,
    RoomAliases {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    CreateRoomAlias {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        alias: String,
    },
    DeleteRoomAlias {
        alias: String,
    },
    PublicRooms {
        server: Option<String>,
        search: Option<String>,
        since: Option<String>,
    },
    RoomDirectoryVisibility {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    SetRoomDirectoryVisibility {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        public: bool,
    },
    UpgradeRoom {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        new_version: String,
        #[ts(type = "string[]")]
        additional_creators: Vec<OwnedUserId>,
    },
    RoomStateEvent {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        event_type: String,
        state_key: String,
    },
    RoomStateEvents {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        event_type: String,
    },
    UrlPreview {
        url: String,
    },
    ListThreads {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        from: Option<String>,
    },
    NotificationKeywords,
    AddNotificationKeyword {
        keyword: String,
    },
    RemoveNotificationKeyword {
        keyword: String,
    },
    TimestampToEvent {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "number")]
        ts: u64,
        direction: PaginationDirection,
    },
    RoomAccountData {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        event_type: String,
    },
    AccountDataTypes,
    AccessToken,
    AccountData {
        event_type: String,
    },
    SetAccountData {
        event_type: String,
        #[ts(type = "unknown")]
        content: serde_json::Value,
    },
    SetRoomAccountData {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        event_type: String,
        #[ts(type = "unknown")]
        content: serde_json::Value,
    },
    ReportMessage {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        reason: Option<String>,
    },
    EventSource {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
    },
    ForwardMessage {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        #[ts(type = "string")]
        to_room_id: OwnedRoomId,
    },
    Personas,
    SavePersona {
        persona: PersonaView,
        #[serde(default)]
        previous_id: Option<String>,
    },
    RemovePersona {
        id: String,
    },
    SetPersonaSelection {
        #[ts(type = "string | null")]
        room_id: Option<OwnedRoomId>,
        persona_id: Option<String>,
        #[ts(type = "number | null")]
        valid_until: Option<u64>,
    },
    Bookmarks,
    SetBookmark {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        bookmarked: bool,
        #[ts(type = "number")]
        now_ms: u64,
    },
    React {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        key: String,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
    },
    SendLocation {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        body: String,
        geo_uri: String,
        #[serde(default)]
        #[ts(type = "string | null")]
        in_reply_to: Option<OwnedEventId>,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
    },
    RoomTimelineEvents {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        event_type: String,
        #[serde(default)]
        msgtype: Option<String>,
        #[ts(type = "number")]
        limit: u32,
        #[serde(default)]
        #[ts(type = "string | null")]
        since: Option<OwnedEventId>,
    },
    RoomStateEventsRaw {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        event_type: String,
        #[serde(default)]
        state_key: Option<String>,
    },
    SearchUserDirectory {
        term: String,
        #[serde(default)]
        #[ts(type = "number | null")]
        limit: Option<u32>,
    },
    OpenIdToken,
    ScheduleMessage {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        body: String,
        #[serde(default)]
        formatted: Option<String>,
        #[ts(type = "number")]
        delay_ms: u64,
    },
    ScheduledMessages {
        #[serde(default)]
        #[ts(type = "string | null")]
        room_id: Option<OwnedRoomId>,
    },
    CancelScheduledMessage {
        delay_id: String,
    },
    SendScheduledMessage {
        delay_id: String,
    },
    DelayedEventsSupported,
    /// MSC3381.
    CreatePoll {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        question: String,
        answers: Vec<String>,
        /// Withholds the tally until the poll closes.
        undisclosed: bool,
        #[ts(type = "number")]
        max_selections: u32,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
    },
    /// Replaces any earlier vote by this account. An empty selection abstains.
    VotePoll {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        /// The poll's start event.
        #[ts(type = "string")]
        event_id: OwnedEventId,
        /// Answer ids, not their text.
        answers: Vec<String>,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
    },
    /// Irreversible.
    EndPoll {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
    },
    MarkRead {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[ts(type = "string")]
        event_id: OwnedEventId,
        #[serde(default)]
        private_receipt: bool,
    },
    MarkUnread {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        #[serde(default)]
        #[ts(type = "string | null")]
        read_marker: Option<OwnedEventId>,
    },
    RetrySend {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        transaction_id: String,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
    },
    /// A local echo is not on the server, so it cannot be redacted.
    CancelSend {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        transaction_id: String,
        #[serde(default)]
        #[ts(type = "string | null")]
        thread_root: Option<OwnedEventId>,
    },

    CreateRoom {
        name: Option<String>,
        topic: Option<String>,
        kind: CreateRoomKind,
        /// Published in the directory, joinable by link.
        public: bool,
        /// Ignored for a space or a public room.
        encrypted: bool,
        #[ts(type = "string[]")]
        invite: Vec<OwnedUserId>,
        /// Adds an `m.space.child` edge from this space.
        #[ts(type = "string | null")]
        parent_space: Option<OwnedRoomId>,
        alias: Option<String>,
        room_version: Option<String>,
        join_rule: Option<CreateJoinRuleView>,
        federate: bool,
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
    SetSpaceChildOrder {
        #[ts(type = "string")]
        space_id: OwnedRoomId,
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        order: Option<String>,
    },
    SpaceHierarchy {
        #[ts(type = "string")]
        space_id: OwnedRoomId,
        from: Option<String>,
    },
    RemoveFromSpace {
        #[ts(type = "string")]
        space_id: OwnedRoomId,
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    SpaceSidebar,
    SetSpaceSidebar {
        items: Vec<SidebarItemView>,
    },

    /// Accepting an invite is `JoinRoom`, declining it `LeaveRoom`.
    ///
    /// Describes a room this account has not joined, so a link to one can be
    /// shown before committing to the join.
    RoomPreview {
        /// A room id or an alias, as `JoinRoom` takes.
        address: String,
        /// Servers to try when the id is not resolvable on ours, or empty.
        via: Vec<String>,
    },
    JoinRoom {
        /// A room id or an alias. A pasted address could be either.
        address: String,
        /// Servers to try when the id is not resolvable on ours, or empty.
        via: Vec<String>,
    },
    /// Asks to be let into a `knock` room. A separate endpoint from joining, and
    /// the only one that works when the join rule is `knock`.
    KnockRoom {
        address: String,
        via: Vec<String>,
        reason: Option<String>,
    },
    /// The servers to advertise in a permalink to this room, per the routing
    /// rules in the spec appendices. Empty when the room has a canonical alias,
    /// which is routable on its own.
    RoomViaServers {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
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
    SyncStatus,
    SearchCoverage,
    Devices,
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
    SetProfileField {
        field: String,
        #[ts(type = "unknown | null")]
        value: Option<serde_json::Value>,
    },
    AccountContacts,
    IgnoredUsers,
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
    SetPusher {
        pusher: PusherView,
    },
    RemovePusher {
        pushkey: String,
        app_id: String,
    },
    /// Mirrors the reader's choice so a native shell can apply it too.
    SetNotificationContent {
        visible: bool,
        encrypted: bool,
    },
    SetPresence {
        presence: PresenceView,
        status_message: Option<String>,
    },
    SetRoomNotificationMode {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        /// `null` drops the room's own rules so it follows the default again.
        mode: Option<NotificationModeView>,
    },
    SetDefaultNotificationMode {
        direct: bool,
        mode: NotificationModeView,
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
        #[serde(default)]
        #[ts(type = "string | null")]
        device_id: Option<OwnedDeviceId>,
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

    SearchMessages {
        query: String,
        #[serde(default)]
        filter: SearchFilter,
        #[serde(default)]
        order: SearchOrder,
        limit: u32,
        offset: u32,
    },

    JoinCall {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        livekit_service_url: Option<String>,
    },

    CallSupport {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    LeaveCall {
        session: CallSessionId,
    },
    DeclineCall {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        notification_event_id: String,
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
    RemoveAccount,
    Logout,
    HomeserverInfo {
        homeserver: String,
        server: Option<HomeserverSoftwareView>,
    },

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
    SearchMessages {
        hits: Vec<SearchHitView>,
    },
    JoinCall {
        session: CallSessionId,
        url: String,
        jwt: String,
        identity: String,
        encrypt_media: bool,
    },
    CallSupport(CallSupportView),
    LeaveCall,
    DeclineCall,
    RoomPermissions(RoomPermissionsView),
    NotificationSettings(NotificationSettingsView),
    DefaultNotificationModes {
        direct: NotificationModeView,
        group: NotificationModeView,
    },
    /// `null` when the event notifies nobody, or is gone, or cannot be read.
    Notification {
        notification: Option<NotificationView>,
    },
    ImagePacks {
        packs: Vec<ImagePackView>,
    },
    AllImagePacks {
        packs: Vec<ImagePackView>,
    },
    /// Boxed: the extended fields make this the widest variant by far.
    UserProfile {
        profile: Box<ProfileView>,
    },
    UserRelations {
        mutual_rooms: Vec<MutualRoomView>,
        ignored: bool,
    },
    SetProfileField,
    AccountContacts {
        emails: Vec<String>,
    },
    IgnoredUsers {
        #[ts(type = "string[]")]
        users: Vec<OwnedUserId>,
    },
    /// The local echo arrives on the timeline diff stream.
    SendMessage,
    SendRawEvent,
    SendSticker,
    SendGif,
    SendLocation,
    EditMessage,
    FetchEventDetails,
    Redact,
    BulkRedact {
        redacted: u32,
    },
    PinnedEvents {
        #[ts(type = "string[]")]
        event_ids: Vec<OwnedEventId>,
    },
    SetPinned {
        #[ts(type = "string[]")]
        event_ids: Vec<OwnedEventId>,
    },
    RoomPowerLevels(RoomPowerLevelsView),
    RoomVersions(RoomVersionsView),
    RoomAliases {
        #[ts(type = "string[]")]
        aliases: Vec<String>,
    },
    CreateRoomAlias,
    DeleteRoomAlias,
    PublicRooms {
        rooms: Vec<PublicRoomView>,
        next_batch: Option<String>,
        #[ts(type = "number | null")]
        total: Option<u64>,
    },
    RoomDirectoryVisibility {
        public: bool,
    },
    SetRoomDirectoryVisibility,
    UpgradeRoom {
        #[ts(type = "string")]
        replacement_room: OwnedRoomId,
    },
    RoomStateEvent {
        #[ts(type = "unknown | null")]
        content: Option<serde_json::Value>,
    },
    RoomStateEvents {
        events: Vec<RoomStateEventView>,
    },
    UrlPreview {
        preview: Option<UrlPreviewView>,
    },
    ListThreads {
        roots: Vec<ThreadRootView>,
        next_batch: Option<String>,
    },
    NotificationKeywords {
        keywords: Vec<String>,
    },
    AddNotificationKeyword,
    RemoveNotificationKeyword,
    TimestampToEvent {
        #[ts(type = "string | null")]
        event_id: Option<OwnedEventId>,
    },
    RoomAccountData {
        #[ts(type = "unknown | null")]
        content: Option<serde_json::Value>,
    },
    AccountDataTypes {
        event_types: Vec<String>,
    },
    AccessToken {
        token: Option<String>,
    },
    SetRoomAccountData,
    AccountData {
        #[ts(type = "unknown | null")]
        content: Option<serde_json::Value>,
    },
    SetAccountData,
    ReportMessage,
    EventSource {
        source: String,
    },
    ForwardMessage,
    Personas {
        catalog: PersonaCatalogView,
    },
    SavePersona {
        personas: Vec<PersonaView>,
    },
    RemovePersona {
        personas: Vec<PersonaView>,
    },
    SetPersonaSelection,
    Bookmarks {
        bookmarks: Vec<BookmarkView>,
    },
    SetBookmark {
        bookmarked: bool,
    },
    React,
    RoomTimelineEvents {
        #[ts(type = "unknown[]")]
        events: Vec<serde_json::Value>,
    },
    RoomStateEventsRaw {
        #[ts(type = "unknown[]")]
        events: Vec<serde_json::Value>,
    },
    SearchUserDirectory {
        limited: bool,
        results: Vec<UserDirectoryEntryView>,
    },
    OpenIdToken {
        token: OpenIdTokenView,
    },
    ScheduleMessage {
        delay_id: String,
    },
    ScheduledMessages {
        messages: Vec<ScheduledMessageView>,
    },
    CancelScheduledMessage,
    SendScheduledMessage,
    DelayedEventsSupported {
        supported: bool,
    },
    CreatePoll,
    VotePoll,
    EndPoll,
    MarkRead,
    MarkUnread,
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
    SpaceHierarchy {
        rooms: Vec<SpaceHierarchyRoomView>,
        /// Pass back as `from` for the next page; `null` at the end.
        next_batch: Option<String>,
    },
    RemoveFromSpace,
    SetSpaceChildOrder,
    SpaceSidebar {
        items: Vec<SidebarItemView>,
    },
    SetSpaceSidebar,

    RoomPreview {
        preview: RoomPreviewView,
    },
    /// Resolved, since the caller may have joined by alias.
    JoinRoom {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    KnockRoom {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    RoomViaServers {
        servers: Vec<String>,
    },
    LeaveRoom,
    InviteUser,

    EncryptionStatus {
        status: EncryptionStatusView,
    },
    SyncStatus {
        status: SyncStatus,
    },
    SearchCoverage {
        coverage: SearchCoverageView,
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
    SetPusher,
    RemovePusher,
    SetNotificationContent,
    SetPresence,
    SetRoomNotificationMode,
    SetDefaultNotificationMode,

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
    InvalidMedia,
    /// A poll needs a question and between 1 and 20 answers.
    InvalidPoll,
    InvalidLocation,
    EncryptedScheduleUnsupported,
    DelayedEventsUnsupported,
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

/// The `m.room.create` type to ask for: `m.space`, the MSC3417 call type, or
/// none at all.
#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum CreateRoomKind {
    Text,
    Space,
    Voice,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum CreateJoinRuleView {
    Public,
    Invite,
    Knock,
    Restricted,
    KnockRestricted,
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

    AccountDataChanged {
        event_type: String,
    },

    SpaceSidebarChanged {
        items: Vec<SidebarItemView>,
    },

    /// An incoming request arrives unsolicited. There is no other prompt.
    Verification {
        #[ts(type = "string")]
        user_id: OwnedUserId,
        flow_id: String,
        state: VerificationView,
    },

    CallEncryptionKey {
        session: CallSessionId,
        identity: String,
        key_index: u8,
        key: String,
        own: bool,
    },

    CallMembers {
        session: CallSessionId,
        members: Vec<CallMemberView>,
    },

    IncomingCall {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
        notification_event_id: String,
        #[ts(type = "string")]
        sender: OwnedUserId,
        ring: bool,
        #[ts(type = "number")]
        expires_at_ms: u64,
    },

    IncomingCallEnded {
        notification_event_id: String,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CallSessionId(pub u32);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum SearchOrder {
    #[default]
    Rank,
    Recent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum SearchAttachment {
    Image,
    Video,
    Audio,
    File,
    Link,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum SearchCoverageState {
    Indexing,
    Complete,
    Partial,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct SearchCoverageView {
    #[ts(type = "number")]
    pub documents: usize,
    #[ts(type = "number")]
    pub rooms_pending: usize,
    #[ts(type = "number")]
    pub rooms_failed: usize,
    pub state: SearchCoverageState,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct SearchFilter {
    #[ts(type = "string[]")]
    pub rooms: Vec<OwnedRoomId>,
    #[ts(type = "string[]")]
    pub senders: Vec<OwnedUserId>,
    #[ts(type = "string[]")]
    pub mentions: Vec<OwnedUserId>,
    pub has: Vec<SearchAttachment>,
    #[ts(type = "string[]")]
    pub not_rooms: Vec<OwnedRoomId>,
    #[ts(type = "string[]")]
    pub not_senders: Vec<OwnedUserId>,
    #[ts(type = "string[]")]
    pub not_mentions: Vec<OwnedUserId>,
    pub not_has: Vec<SearchAttachment>,
    #[ts(type = "number | null")]
    pub after_ts: Option<u64>,
    #[ts(type = "number | null")]
    pub before_ts: Option<u64>,
    pub phrases: Vec<String>,
    pub exclude: Vec<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct CallMemberView {
    #[ts(type = "string")]
    pub user_id: OwnedUserId,
    pub device_id: String,
    pub identity: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct SearchHitView {
    #[ts(type = "string")]
    pub room_id: OwnedRoomId,
    #[ts(type = "string")]
    pub event_id: OwnedEventId,
    pub body: String,
    #[ts(type = "string")]
    pub sender: OwnedUserId,
    #[ts(type = "number")]
    pub origin_server_ts: u64,
    pub score: f64,
}

// Hand-narrowed, keeping the UI off the SDK's shapes.

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
// These are independent room capabilities, not a state machine.
#[allow(clippy::struct_excessive_bools)]
pub struct RoomSummary {
    #[ts(type = "string")]
    pub room_id: OwnedRoomId,
    pub canonical_alias: Option<String>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    pub is_direct: bool,
    #[ts(type = "string[]")]
    pub direct_targets: Vec<OwnedUserId>,
    pub join_rule: RoomJoinRuleView,
    /// Only the tags this client models; others are dropped.
    pub tags: Vec<RoomTag>,
    /// An `invited` room is an invitation to accept, not a room to open.
    pub state: RoomStateView,
    /// `null` until the state event loads, which is not the same as `false`.
    pub encrypted: Option<bool>,
    pub is_space: bool,
    pub is_tombstoned: bool,
    /// An `m.room.create` with the MSC3417 call type.
    pub is_voice: bool,
    /// Members in the room's call, oldest first and one entry per user however
    /// many devices they joined with.
    #[ts(type = "string[]")]
    pub call_participants: Vec<OwnedUserId>,
    pub has_space_parent: bool,
    pub supports_knock: bool,
    pub supports_restricted: bool,
    pub supports_knock_restricted: bool,
    /// Already sorted by `order`, then the child event's age.
    pub space_children: Vec<SpaceChildEdge>,
    pub unread: u32,
    pub highlight: u32,
    pub marked_unread: bool,
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
    #[ts(type = "number | null")]
    pub last_seen_ts: Option<u64>,
    pub last_seen_ip: Option<String>,
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
    Restricted,
    KnockRestricted,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum RoomJoinRuleView {
    Public,
    Invite,
    Knock,
    /// Members of an allowed space may join.
    Restricted,
    KnockRestricted,
    Private,
    /// Not loaded, or a rule this client has no name for.
    Unknown,
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

/// A room as the server describes it to someone who may not be in it.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct RoomPreviewView {
    /// Resolved, since the preview may have been asked for by alias.
    #[ts(type = "string")]
    pub room_id: OwnedRoomId,
    pub canonical_alias: Option<String>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    pub is_space: bool,
    pub is_voice: bool,
    pub num_joined_members: u32,
    pub join_rule: RoomJoinRuleView,
    /// `null` when this account has no membership in the room.
    pub state: Option<RoomStateView>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[allow(clippy::struct_excessive_bools)]
pub struct PublicRoomView {
    #[ts(type = "string")]
    pub room_id: OwnedRoomId,
    pub canonical_alias: Option<String>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    pub is_space: bool,
    pub is_voice: bool,
    pub num_joined_members: u32,
    pub join_rule: RoomJoinRuleView,
    pub guest_can_join: bool,
    pub world_readable: bool,
}

/// One room in a space's hierarchy. The root space is included, so a caller can
/// walk the tree from it.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct SpaceHierarchyRoomView {
    #[ts(type = "string")]
    pub room_id: OwnedRoomId,
    pub canonical_alias: Option<String>,
    pub name: Option<String>,
    pub topic: Option<String>,
    pub avatar_url: Option<String>,
    pub is_space: bool,
    pub is_voice: bool,
    pub num_joined_members: u32,
    pub join_rule: RoomJoinRuleView,
    pub guest_can_join: bool,
    /// This room's own `m.space.child` edges, already sorted. Empty unless it is
    /// a space.
    pub children: Vec<SpaceChildEdge>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct SpaceChildEdge {
    #[ts(type = "string")]
    pub room_id: OwnedRoomId,
    /// `m.space.child.content.order`, unordered children sort last.
    pub order: Option<String>,
    #[ts(type = "number")]
    pub origin_server_ts: u64,
    /// The parent marked this child as worth surfacing first.
    pub suggested: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SidebarItemView {
    Space {
        #[ts(type = "string")]
        room_id: OwnedRoomId,
    },
    Folder {
        id: String,
        name: Option<String>,
        #[ts(type = "string[]")]
        content: Vec<OwnedRoomId>,
    },
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
    /// MSC4144. When set, this is the identity to show as the sender; `sender`
    /// stays the account that actually sent it and must remain reachable.
    pub per_message_profile: Option<PerMessageProfileView>,
    pub mention: MentionView,
}

/// `Loud` covers `@room` and anything the push rules chose to highlight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum MentionView {
    None,
    Silent,
    Loud,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ThreadRootView {
    #[ts(type = "string")]
    pub event_id: OwnedEventId,
    #[ts(type = "string")]
    pub sender: OwnedUserId,
    pub body: String,
    #[ts(type = "number | null")]
    pub timestamp: Option<u64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct UrlPreviewView {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub image: Option<String>,
    #[ts(type = "number | null")]
    pub image_width: Option<u64>,
    #[ts(type = "number | null")]
    pub image_height: Option<u64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct RoomStateEventView {
    pub state_key: String,
    #[ts(type = "unknown")]
    pub content: serde_json::Value,
}

/// What this account may do in one room, resolved from `m.room.power_levels`.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
// Each field is an independent capability, not a state machine.
#[allow(clippy::struct_excessive_bools)]
pub struct RoomPermissionsView {
    pub own_power_level: i32,
    pub can_post: bool,
    /// Redacting someone else's event. Your own needs no extra level.
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

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct RoomPowerLevelsView {
    pub ban: i32,
    pub kick: i32,
    pub redact: i32,
    pub invite: i32,
    pub events_default: i32,
    pub state_default: i32,
    pub users_default: i32,
    #[ts(type = "Record<string, number>")]
    pub events: std::collections::BTreeMap<String, i32>,
    #[ts(type = "Record<string, number>")]
    pub users: std::collections::BTreeMap<String, i32>,
    pub notifications_room: i32,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export)]
pub struct CallSupportView {
    pub has_focus: bool,
    pub can_join: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct RoomVersionsView {
    pub default: String,
    pub available: Vec<RoomVersionView>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct RoomVersionView {
    pub id: String,
    pub stable: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TimelineFocusView {
    #[default]
    Live,
    Event {
        #[ts(type = "string")]
        event_id: OwnedEventId,
    },
    Thread {
        #[ts(type = "string")]
        root_event_id: OwnedEventId,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum MessageKind {
    #[default]
    Text,
    Emote,
    Notice,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct EditImageView {
    pub source: String,
    pub filename: Option<String>,
    pub mime: Option<String>,
    #[ts(type = "number | null")]
    pub width: Option<u64>,
    #[ts(type = "number | null")]
    pub height: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct AttachmentInfoView {
    #[ts(type = "number | null")]
    pub width: Option<u32>,
    #[ts(type = "number | null")]
    pub height: Option<u32>,
    #[ts(type = "number | null")]
    pub duration_ms: Option<u32>,
    pub animated: Option<bool>,
    pub blurhash: Option<String>,
    pub waveform: Option<Vec<f32>>,
    #[serde(default)]
    pub voice: bool,
}

/// MSC4144 per-message profile, letting one account send under several
/// identities. Read from the unstable `com.beeper.per_message_profile` key,
/// falling back to the stable `m.per_message_profile` once servers emit it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PersonaTriggerView {
    pub prefix: Option<String>,
    pub suffix: Option<String>,
    #[serde(default)]
    pub keep_trigger: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PluralkitImportView {
    pub id: String,
    pub uuid: Option<String>,
    pub avatar_url: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PersonaSelectionView {
    pub persona_id: String,
    #[ts(type = "number | null")]
    pub valid_until: Option<u64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct PersonaCatalogView {
    pub personas: Vec<PersonaView>,
    pub account: Option<PersonaSelectionView>,
    #[ts(type = "Record<string, PersonaSelectionView>")]
    pub rooms: std::collections::BTreeMap<String, PersonaSelectionView>,
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
        notice: bool,
        edited: bool,
    },
    Image {
        body: String,
        source: String,
        filename: Option<String>,
        mime: Option<String>,
        #[ts(type = "number | null")]
        width: Option<u64>,
        #[ts(type = "number | null")]
        height: Option<u64>,
        blurhash: Option<String>,
        spoiler: Option<String>,
    },
    Video {
        body: String,
        source: String,
        mime: Option<String>,
        #[ts(type = "number | null")]
        width: Option<u64>,
        #[ts(type = "number | null")]
        height: Option<u64>,
        blurhash: Option<String>,
        spoiler: Option<String>,
    },
    Audio {
        body: String,
        source: String,
        mime: Option<String>,
        #[ts(type = "number | null")]
        duration_ms: Option<u64>,
        waveform: Option<Vec<f32>>,
        voice: bool,
    },
    File {
        body: String,
        source: String,
        mime: Option<String>,
        #[ts(type = "number | null")]
        size: Option<u64>,
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
    /// The coordinates are absent for a `geo:` URI we cannot read; `geo_uri` is
    /// passed through as sent either way.
    Location {
        body: String,
        geo_uri: String,
        #[ts(type = "number | null")]
        latitude: Option<f64>,
        #[ts(type = "number | null")]
        longitude: Option<f64>,
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
    },
    UnableToDecrypt {
        reason: UtdCauseView,
    },
    Membership {
        #[ts(type = "string")]
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
        #[ts(type = "string")]
        user_id: OwnedUserId,
        display_name: Option<DisplayNameChangeView>,
        avatar_changed: bool,
    },
    /// Any other state event. Reported rather than dropped so the UI can decide
    /// what to render and what to keep behind a "show hidden events" setting.
    StateEvent {
        /// e.g. `m.room.topic`.
        event_type: String,
        state_key: String,
        /// Raw content, for the developer-only peek. Absent if the event's
        /// JSON is no longer around.
        #[ts(type = "unknown")]
        content: Option<serde_json::Value>,
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
        #[ts(type = "unknown")]
        content: Option<serde_json::Value>,
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
        #[ts(type = "string[]")]
        added: Vec<OwnedEventId>,
        #[ts(type = "string[]")]
        removed: Vec<OwnedEventId>,
        #[ts(type = "number")]
        total: u32,
    },
    /// MSC3401. An update that neither joins nor leaves carries no change.
    CallMembership {
        joined: bool,
    },
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GalleryItemView {
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
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export)]
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

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct UserDirectoryEntryView {
    pub user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct OpenIdTokenView {
    pub access_token: String,
    pub token_type: String,
    pub matrix_server_name: String,
    #[ts(type = "number")]
    pub expires_in_ms: u64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ScheduledMessageView {
    pub delay_id: String,
    #[ts(type = "string")]
    pub room_id: OwnedRoomId,
    pub body: String,
    pub formatted: Option<String>,
    #[ts(type = "number")]
    pub delay_ms: u64,
    #[ts(type = "number | null")]
    pub delivery_ts: Option<u64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct PollView {
    pub question: String,
    pub answers: Vec<PollAnswerView>,
    #[ts(type = "number")]
    pub max_selections: u32,
    /// Every answer's `votes` stays absent until `ended_at` is set.
    pub undisclosed: bool,
    /// Votes cast after this are not counted.
    #[ts(type = "number | null")]
    pub ended_at: Option<u64>,
    pub edited: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct PollAnswerView {
    #[ts(type = "string[] | null")]
    pub voters: Option<Vec<OwnedUserId>>,
    pub id: String,
    pub text: String,
    /// Absent while an undisclosed poll is still open.
    #[ts(type = "number | null")]
    pub votes: Option<u32>,
    pub selected: bool,
}

/// The SDK's `MembershipChange`, narrowed to the transitions worth wording.
/// Anything unrecognised collapses to `Other`, which the UI hides.
#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export)]
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
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct DisplayNameChangeView {
    pub old: Option<String>,
    pub new: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ReactionGroup {
    pub key: String,
    #[ts(type = "string[]")]
    pub senders: Vec<OwnedUserId>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct PusherView {
    pub pushkey: String,
    pub app_id: String,
    /// The gateway's `_matrix/push/v1/notify`.
    pub url: String,
    pub device_display_name: String,
    /// Web push delivery, as `UnifiedPush` and a browser use: `pushkey` is then
    /// the `p256dh` and the gateway encrypts to these.
    pub web_push: Option<WebPushKeys>,
    pub event_id_only: bool,
    /// False replaces any pusher already holding this key.
    pub append: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct WebPushKeys {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum NotificationModeView {
    All,
    Mentions,
    Mute,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[ts(export)]
pub struct NotificationSettingsView {
    /// The room's own rule. `null` means it follows `default`.
    pub room: Option<NotificationModeView>,
    pub default: NotificationModeView,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct NotificationView {
    #[ts(type = "string")]
    pub user_id: OwnedUserId,
    #[ts(type = "string")]
    pub room_id: OwnedRoomId,
    #[ts(type = "string")]
    pub event_id: OwnedEventId,
    pub room_name: String,
    pub room_avatar_url: Option<String>,
    pub is_direct: bool,
    pub encrypted: bool,
    #[ts(type = "string")]
    pub sender: OwnedUserId,
    pub sender_name: Option<String>,
    pub sender_avatar_url: Option<String>,
    pub body: String,
    pub mention: bool,
    pub noisy: Option<bool>,
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
    #[ts(type = "string | null")]
    pub event_id: Option<OwnedEventId>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct MemberView {
    #[ts(type = "string")]
    pub user_id: OwnedUserId,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub power_level: i32,
    pub membership: MembershipView,
    #[ts(type = "number | null")]
    pub member_ts: Option<u64>,
    pub kicked: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS, PartialEq, Eq)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum MembershipView {
    Join,
    Invite,
    Knock,
    Leave,
    Ban,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct ImagePackView {
    /// The state key for a room pack, empty for the account's own pack. Unique
    /// only together with `room_id`.
    pub id: String,
    pub origin: ImagePackOriginView,
    pub room_id: Option<String>,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
    pub attribution: Option<String>,
    pub images: Vec<PackImageView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ImagePackOriginView {
    Account,
    /// The room being viewed.
    Room,
    /// Another room, subscribed to account-wide.
    Global,
    Space,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct PackImageView {
    pub shortcode: String,
    /// Always `mxc://`; anything else is dropped when the pack is read.
    pub url: String,
    pub body: Option<String>,
    pub usage: Vec<ImageUsageView>,
    pub info: Option<PackImageInfoView>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(default)]
pub struct PackImageInfoView {
    #[ts(type = "number | null")]
    pub width: Option<u32>,
    #[ts(type = "number | null")]
    pub height: Option<u32>,
    pub mimetype: Option<String>,
    #[ts(type = "number | null")]
    pub size: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ImageUsageView {
    Emoticon,
    Sticker,
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
    pub is_space: bool,
}

/// MSC4426 `m.status`. The emoji is optional here even though the MSC requires
/// it, because the older single-string status fields carry no emoji.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct StatusView {
    pub text: String,
    pub emoji: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
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
pub struct HomeserverSoftwareView {
    pub name: Option<String>,
    pub version: Option<String>,
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

#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
pub struct BookmarkView {
    pub bookmark_id: String,
    pub room_id: String,
    pub event_id: String,
    pub room_name: Option<String>,
    pub sender: Option<String>,
    pub body_preview: Option<String>,
    #[ts(type = "number")]
    pub event_ts: u64,
    #[ts(type = "number")]
    pub bookmarked_ts: u64,
}
