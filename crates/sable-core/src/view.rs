use std::collections::{BTreeSet, HashMap};
use std::hash::BuildHasher;
use std::sync::Arc;

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::Client;
use matrix_sdk::deserialized_responses::SyncOrStrippedState;
use matrix_sdk::room::{ParentSpace, Room, RoomMember};
use matrix_sdk::room_preview::RoomPreview;
use matrix_sdk::ruma::api::client::state::get_state_event_for_key;
use matrix_sdk::ruma::directory::PublicRoomsChunk;
use matrix_sdk::ruma::events::SyncStateEvent;
use matrix_sdk::ruma::events::poll::start::PollKind;
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::events::room::join_rules::JoinRule;
use matrix_sdk::ruma::events::room::member::{MembershipState, RoomMemberEventContent};
use matrix_sdk::ruma::events::room::message::{GalleryItemType, MessageType, UnstableAmplitude};
use matrix_sdk::ruma::events::room::power_levels::{RoomPowerLevels, UserPowerLevel};
use matrix_sdk::ruma::events::space::child::{HierarchySpaceChildEvent, SpaceChildEventContent};
use matrix_sdk::ruma::events::{MessageLikeEventType, StateEventContentChange, StateEventType};
use matrix_sdk::ruma::room::{
    JoinRuleKind, JoinRuleSummary, RoomSummary as RumaRoomSummary, RoomType,
};
use matrix_sdk::ruma::{Int, UInt};
use matrix_sdk::ruma::{OwnedRoomId, OwnedUserId, UserId};
use matrix_sdk::{EncryptionState, RoomState};
use matrix_sdk_base::crypto::types::events::UtdCause;
use matrix_sdk_ui::{
    eyeball_im,
    room_list_service::RoomListItem,
    timeline::{
        AnyOtherStateEventContentChange, EncryptedMessage, EventSendState, EventTimelineItem,
        MembershipChange, MsgLikeContent, MsgLikeKind, OtherState, PollState, Profile,
        TimelineDetails, TimelineItem, TimelineItemContent, TimelineItemKind, VirtualTimelineItem,
    },
};

use matrix_sdk::latest_events::{LatestEventValue, LocalLatestEventValue, RemoteLatestEventValue};
use matrix_sdk::ruma::events::{
    AnyMessageLikeEventContent, AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
};

use crate::matrix_html::{
    display_html, has_profile_fallback_html, strip_profile_fallback_body,
    strip_profile_fallback_html,
};
use crate::profiles::pronoun_sets;
use crate::protocol::{
    DisplayNameChangeView, GalleryItemView, LatestEventView, MemberView, MembershipChangeView,
    MembershipView, MentionView, PerMessageProfileView, PollAnswerView, PollView, PublicRoomView,
    ReactionGroup, ReplyView, RoomJoinRuleView, RoomPermissionsView, RoomPowerLevelsView,
    RoomPreviewView, RoomStateView, RoomSummary, RoomTag, SearchHitView, SendStateView,
    SpaceChildEdge, SpaceHierarchyRoomView, StateChangeView, ThreadSummaryView,
    TimelineItemContentView, TimelineItemView, UploadProgressView, UtdCauseView, VectorDiff,
};

// These are independent room capabilities, not a state machine.
#[allow(clippy::struct_excessive_bools)]
pub struct RoomInfo {
    pub is_space: bool,
    pub is_tombstoned: bool,
    pub has_space_parent: bool,
    pub supports_knock: bool,
    pub supports_restricted: bool,
    pub supports_knock_restricted: bool,
    pub canonical_alias: Option<String>,
    pub children: Vec<SpaceChildEdge>,
    pub tags: Vec<RoomTag>,
}

#[must_use]
pub fn room_summary<S: BuildHasher>(
    item: &RoomListItem,
    room_cache: &HashMap<OwnedRoomId, RoomInfo, S>,
) -> RoomSummary {
    let info = room_cache.get(item.room_id());
    let (unread, highlight) = unread_counts(item);
    RoomSummary {
        room_id: item.room_id().to_owned(),
        canonical_alias: info.and_then(|info| info.canonical_alias.clone()),
        // Only `display_name()` fills this cache, so `prime_display_names` must
        // have run. `name()` covers an explicit `m.room.name` until then.
        name: item
            .cached_display_name()
            .map(|name| name.to_string())
            .or_else(|| item.name()),
        topic: item.topic(),
        avatar_url: item.avatar_url().map(|url| url.to_string()),
        is_direct: !item.direct_targets().is_empty(),
        direct_targets: item
            .direct_targets()
            .into_iter()
            .filter_map(|target| OwnedUserId::try_from(target.as_str()).ok())
            .collect(),
        join_rule: join_rule_view(item.join_rule().as_ref()),
        tags: info.map(|i| i.tags.clone()).unwrap_or_default(),
        encrypted: match item.encryption_state() {
            EncryptionState::Encrypted => Some(true),
            EncryptionState::NotEncrypted => Some(false),
            // `m.room.encryption` is not loaded, so neither answer is honest.
            EncryptionState::Unknown => None,
        },
        state: match item.state() {
            RoomState::Joined => RoomStateView::Joined,
            RoomState::Invited => RoomStateView::Invited,
            RoomState::Knocked => RoomStateView::Knocked,
            RoomState::Left => RoomStateView::Left,
            RoomState::Banned => RoomStateView::Banned,
        },
        is_space: info.is_some_and(|i| i.is_space),
        is_tombstoned: info.is_some_and(|i| i.is_tombstoned),
        is_voice: item.is_call(),
        call_participants: call_participants(item.active_room_call_participants()),
        has_space_parent: info.is_some_and(|i| i.has_space_parent),
        supports_knock: info.is_some_and(|i| i.supports_knock),
        supports_restricted: info.is_some_and(|i| i.supports_restricted),
        supports_knock_restricted: info.is_some_and(|i| i.supports_knock_restricted),
        space_children: info.map(|i| i.children.clone()).unwrap_or_default(),
        unread,
        highlight,
        marked_unread: item.is_marked_unread(),
        latest_event: latest_event(item),
    }
}

/// The SDK lists one entry per joined device, so a user on two appears twice.
fn call_participants(joined: Vec<OwnedUserId>) -> Vec<OwnedUserId> {
    let mut participants: Vec<OwnedUserId> = Vec::with_capacity(joined.len());
    for user_id in joined {
        if !participants.contains(&user_id) {
            participants.push(user_id);
        }
    }
    participants
}

fn unread_counts(item: &RoomListItem) -> (u32, u32) {
    let count = |value: u64| u32::try_from(value).unwrap_or(u32::MAX);
    if item.read_receipts().latest_active.is_none() {
        let server = item.unread_notification_counts();
        return (
            count(server.notification_count),
            count(server.highlight_count),
        );
    }
    (
        count(item.num_unread_messages()),
        count(item.num_unread_mentions()),
    )
}

const fn join_rule_view(rule: Option<&JoinRule>) -> RoomJoinRuleView {
    match rule {
        Some(JoinRule::Public) => RoomJoinRuleView::Public,
        Some(JoinRule::Invite) => RoomJoinRuleView::Invite,
        Some(JoinRule::Knock) => RoomJoinRuleView::Knock,
        Some(JoinRule::Restricted(_)) => RoomJoinRuleView::Restricted,
        Some(JoinRule::KnockRestricted(_)) => RoomJoinRuleView::KnockRestricted,
        Some(JoinRule::Private) => RoomJoinRuleView::Private,
        _ => RoomJoinRuleView::Unknown,
    }
}

/// Cached, so this costs one deserialization and no request.
fn latest_event(item: &RoomListItem) -> Option<LatestEventView> {
    match item.latest_event() {
        LatestEventValue::None => None,

        LatestEventValue::Remote(event) => Some(LatestEventView {
            sender: event.sender(),
            body: remote_preview(&event)?,
            timestamp: event.timestamp().map(|at| at.0.into()),
            sending: false,
            event_id: event.event_id().map(ToOwned::to_owned),
        }),

        LatestEventValue::RemoteInvite {
            timestamp, inviter, ..
        } => Some(LatestEventView {
            sender: inviter,
            body: "invited you".to_owned(),
            timestamp: Some(timestamp.0.into()),
            sending: false,
            event_id: None,
        }),

        // `LocalHasBeenSent` is accepted already. These two are pending.
        LatestEventValue::LocalIsSending(local) | LatestEventValue::LocalCannotBeSent(local) => {
            Some(LatestEventView {
                sender: None,
                body: local_preview(&local)?,
                timestamp: Some(local.timestamp.0.into()),
                sending: true,
                event_id: None,
            })
        }

        LatestEventValue::LocalHasBeenSent { value, event_id } => Some(LatestEventView {
            sender: None,
            body: local_preview(&value)?,
            timestamp: Some(value.timestamp.0.into()),
            sending: false,
            event_id: Some(event_id),
        }),
    }
}

fn remote_preview(event: &RemoteLatestEventValue) -> Option<String> {
    let any = event.raw().deserialize().ok()?;

    let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(message)) = any
    else {
        return None;
    };

    match message {
        SyncMessageLikeEvent::Original(original) => Some(original.content.body().to_owned()),
        SyncMessageLikeEvent::Redacted(_) => None,
    }
}

fn local_preview(local: &LocalLatestEventValue) -> Option<String> {
    let content = local.content.deserialize().ok()?;

    match content {
        AnyMessageLikeEventContent::RoomMessage(message) => Some(message.body().to_owned()),
        _ => None,
    }
}

/// `Room::get_state_events_static` hits the state store, so this runs once per
/// room per subscription.
pub async fn enrich_room_fields<S: BuildHasher>(
    client: &Client,
    diff: &eyeball_im::VectorDiff<RoomListItem>,
    room_cache: &mut HashMap<OwnedRoomId, RoomInfo, S>,
) {
    use eyeball_im::VectorDiff as In;

    let items: Vec<&RoomListItem> = match diff {
        In::Append { values } | In::Reset { values } => values.iter().collect(),
        In::PushFront { value }
        | In::PushBack { value }
        | In::Insert { value, .. }
        | In::Set { value, .. } => vec![value],
        _ => Vec::new(),
    };

    let stale = items
        .into_iter()
        .filter(|item| !room_cache.contains_key(item.room_id()) || matches!(diff, In::Set { .. }));

    let lookups = stale.map(|item| {
        let room_id = item.room_id().to_owned();
        let room = client.get_room(&room_id);
        async move {
            match room {
                Some(room) => (room_id, room_info(client, &room).await),
                None => (room_id, RoomInfo::absent()),
            }
        }
    });

    for (room_id, info) in futures_util::future::join_all(lookups).await {
        room_cache.insert(room_id, info);
    }
}

impl RoomInfo {
    const fn absent() -> Self {
        Self {
            is_space: false,
            is_tombstoned: false,
            has_space_parent: false,
            supports_knock: false,
            supports_restricted: false,
            supports_knock_restricted: false,
            canonical_alias: None,
            children: Vec::new(),
            tags: Vec::new(),
        }
    }
}

async fn room_info(client: &Client, room: &Room) -> RoomInfo {
    let is_space = room.is_space();
    let is_tombstoned = is_tombstoned(client, room, is_space).await;
    let children = async {
        if is_space {
            space_children(room).await
        } else {
            Vec::new()
        }
    };

    let (has_space_parent, join_rules, children) = futures_util::future::join3(
        has_space_parent(room),
        crate::rooms::join_rule_support(room),
        children,
    )
    .await;
    let (supports_knock, supports_restricted, supports_knock_restricted) = join_rules;

    RoomInfo {
        is_space,
        is_tombstoned,
        has_space_parent,
        supports_knock,
        supports_restricted,
        supports_knock_restricted,
        canonical_alias: room.canonical_alias().map(|alias| alias.to_string()),
        children,
        tags: room_tags(room),
    }
}

async fn is_tombstoned(client: &Client, room: &Room, is_space: bool) -> bool {
    if room
        .get_state_event(StateEventType::RoomTombstone, "")
        .await
        .is_ok_and(|event| event.is_some())
    {
        return true;
    }
    if !is_space {
        return false;
    }

    client
        .send(get_state_event_for_key::v3::Request::new(
            room.room_id().to_owned(),
            StateEventType::RoomTombstone.to_string().into(),
            String::new(),
        ))
        .await
        .is_ok()
}

async fn has_space_parent(room: &Room) -> bool {
    let Ok(parents) = room.parent_spaces().await else {
        return false;
    };
    pin_mut!(parents);

    while let Some(Ok(parent)) = parents.next().await {
        if let ParentSpace::Reciprocal(space) = parent
            && space.is_space()
        {
            return true;
        }
    }

    false
}

#[must_use]
pub fn public_room(chunk: &PublicRoomsChunk) -> PublicRoomView {
    PublicRoomView {
        room_id: chunk.room_id.clone(),
        canonical_alias: chunk.canonical_alias.as_ref().map(ToString::to_string),
        name: chunk.name.clone(),
        topic: chunk.topic.clone(),
        avatar_url: chunk.avatar_url.as_ref().map(ToString::to_string),
        is_space: chunk.room_type == Some(RoomType::Space),
        is_voice: chunk.room_type == Some(RoomType::Call),
        num_joined_members: u32::try_from(chunk.num_joined_members).unwrap_or(u32::MAX),
        join_rule: join_rule_kind_view(&chunk.join_rule),
        guest_can_join: chunk.guest_can_join,
        world_readable: chunk.world_readable,
    }
}

const fn join_rule_kind_view(kind: &JoinRuleKind) -> RoomJoinRuleView {
    match kind {
        JoinRuleKind::Public => RoomJoinRuleView::Public,
        JoinRuleKind::Invite => RoomJoinRuleView::Invite,
        JoinRuleKind::Knock => RoomJoinRuleView::Knock,
        JoinRuleKind::Restricted => RoomJoinRuleView::Restricted,
        JoinRuleKind::KnockRestricted => RoomJoinRuleView::KnockRestricted,
        JoinRuleKind::Private => RoomJoinRuleView::Private,
        _ => RoomJoinRuleView::Unknown,
    }
}

#[must_use]
pub fn space_hierarchy_room(
    summary: &RumaRoomSummary,
    children: Vec<SpaceChildEdge>,
) -> SpaceHierarchyRoomView {
    SpaceHierarchyRoomView {
        room_id: summary.room_id.clone(),
        canonical_alias: summary.canonical_alias.as_ref().map(ToString::to_string),
        name: summary.name.clone(),
        topic: summary.topic.clone(),
        avatar_url: summary.avatar_url.as_ref().map(ToString::to_string),
        is_space: summary.room_type == Some(RoomType::Space),
        is_voice: summary.room_type == Some(RoomType::Call),
        num_joined_members: u32::try_from(summary.num_joined_members).unwrap_or(u32::MAX),
        join_rule: join_rule_summary_view(&summary.join_rule),
        guest_can_join: summary.guest_can_join,
        children,
    }
}

#[must_use]
pub fn hierarchy_child_edges(
    events: &[matrix_sdk::ruma::serde::Raw<HierarchySpaceChildEvent>],
) -> Vec<SpaceChildEdge> {
    let mut children: Vec<SpaceChildEdge> = events
        .iter()
        .filter_map(|raw| raw.deserialize().ok())
        .map(|event| SpaceChildEdge {
            room_id: event.state_key,
            order: event.content.order.map(|order| order.to_string()),
            origin_server_ts: u64::from(event.origin_server_ts.get()),
            suggested: event.content.suggested,
        })
        .collect();

    sort_child_edges(&mut children);
    children
}

/// The routing rules in the spec appendices: the server of the highest-power
/// user who is at least PL 50, then the next servers by population, up to three
/// in total. Fewer when the room cannot supply that many.
#[must_use]
pub fn via_servers(members: &[(String, i32)]) -> Vec<String> {
    const MODERATOR: i32 = 50;
    const WANTED: usize = 3;

    let server_of = |user_id: &str| {
        user_id
            .split_once(':')
            .map(|(_, server)| server.to_owned())
            .filter(|server| !server.is_empty())
    };

    let mut chosen: Vec<String> = Vec::with_capacity(WANTED);

    // Ties on power level go to the lower user id, so the same room yields the
    // same link from every client.
    if let Some((user_id, _)) = members
        .iter()
        .filter(|(_, power)| *power >= MODERATOR)
        .max_by(|(left_id, left), (right_id, right)| {
            left.cmp(right).then_with(|| right_id.cmp(left_id))
        })
        && let Some(server) = server_of(user_id)
    {
        chosen.push(server);
    }

    let mut population: HashMap<String, usize> = HashMap::new();
    for (user_id, _) in members {
        if let Some(server) = server_of(user_id) {
            *population.entry(server).or_default() += 1;
        }
    }

    let mut by_population: Vec<(String, usize)> = population.into_iter().collect();
    by_population.sort_by(|(left_server, left), (right_server, right)| {
        right.cmp(left).then_with(|| left_server.cmp(right_server))
    });

    for (server, _) in by_population {
        if chosen.len() == WANTED {
            break;
        }
        if !chosen.contains(&server) {
            chosen.push(server);
        }
    }

    chosen
}

#[must_use]
pub fn room_preview_view(preview: &RoomPreview) -> RoomPreviewView {
    RoomPreviewView {
        room_id: preview.room_id.clone(),
        canonical_alias: preview.canonical_alias.as_ref().map(ToString::to_string),
        name: preview.name.clone(),
        topic: preview.topic.clone(),
        avatar_url: preview.avatar_url.as_ref().map(ToString::to_string),
        is_space: preview.room_type == Some(RoomType::Space),
        is_voice: preview.room_type == Some(RoomType::Call),
        num_joined_members: u32::try_from(preview.num_joined_members).unwrap_or(u32::MAX),
        join_rule: preview
            .join_rule
            .as_ref()
            .map_or(RoomJoinRuleView::Unknown, join_rule_summary_view),
        state: preview.state.map(|state| match state {
            RoomState::Joined => RoomStateView::Joined,
            RoomState::Invited => RoomStateView::Invited,
            RoomState::Knocked => RoomStateView::Knocked,
            RoomState::Left => RoomStateView::Left,
            RoomState::Banned => RoomStateView::Banned,
        }),
    }
}

const fn join_rule_summary_view(rule: &JoinRuleSummary) -> RoomJoinRuleView {
    match rule {
        JoinRuleSummary::Public => RoomJoinRuleView::Public,
        JoinRuleSummary::Invite => RoomJoinRuleView::Invite,
        JoinRuleSummary::Knock => RoomJoinRuleView::Knock,
        JoinRuleSummary::Restricted(_) => RoomJoinRuleView::Restricted,
        JoinRuleSummary::KnockRestricted(_) => RoomJoinRuleView::KnockRestricted,
        JoinRuleSummary::Private => RoomJoinRuleView::Private,
        _ => RoomJoinRuleView::Unknown,
    }
}

/// The two tags a row shows are the two the SDK keeps as notable flags on
/// cached room info, so this reads memory where `Room::tags` reads the store.
fn room_tags(room: &Room) -> Vec<RoomTag> {
    let mut tags = Vec::new();
    if room.is_favourite() {
        tags.push(RoomTag::Favourite);
    }
    if room.is_low_priority() {
        tags.push(RoomTag::LowPriority);
    }
    tags
}

async fn space_children(room: &Room) -> Vec<SpaceChildEdge> {
    let Ok(events) = room
        .get_state_events_static::<SpaceChildEventContent>()
        .await
    else {
        return Vec::new();
    };

    let mut children: Vec<SpaceChildEdge> = Vec::new();
    for event in events {
        let Ok(SyncOrStrippedState::Sync(SyncStateEvent::Original(original))) = event.deserialize()
        else {
            continue;
        };
        children.push(SpaceChildEdge {
            room_id: original.state_key.clone(),
            order: original.content.order.map(|order| order.to_string()),
            origin_server_ts: u64::from(original.origin_server_ts.get()),
            suggested: original.content.suggested,
        });
    }

    sort_child_edges(&mut children);
    children
}

fn sort_child_edges(children: &mut [SpaceChildEdge]) {
    children.sort_by(|a, b| {
        match (&a.order, &b.order) {
            (Some(left), Some(right)) => left.cmp(right),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
        .then_with(|| a.origin_server_ts.cmp(&b.origin_server_ts))
    });
}

#[must_use]
pub fn timeline_item(
    item: &Arc<TimelineItem>,
    own_user_id: Option<&UserId>,
    relays: &BTreeSet<OwnedUserId>,
) -> TimelineItemView {
    let id = item.unique_id().0.clone();

    match item.kind() {
        TimelineItemKind::Event(event) => {
            let profile = match event.sender_profile() {
                TimelineDetails::Ready(profile) => Some(profile),
                _ => None,
            };
            let raw = RawFields::read(event);
            let message_profile = per_message_profile(raw.content.as_ref()).or_else(|| {
                relays
                    .contains(event.sender())
                    .then(|| relay_profile(raw.content.as_ref()))
                    .flatten()
            });

            TimelineItemView {
                id,
                event_id: event.event_id().map(ToOwned::to_owned),
                transaction_id: event.transaction_id().map(ToString::to_string),
                send_state: event.send_state().map(send_state),
                sender: Some(event.sender().to_owned()),
                sender_name: profile.and_then(|p: &Profile| p.display_name.clone()),
                sender_avatar: profile
                    .and_then(|p: &Profile| p.avatar_url.as_ref())
                    .map(ToString::to_string),
                timestamp: event.timestamp().0.into(),
                content: content(event.content(), message_profile.as_ref(), &raw, own_user_id),
                in_reply_to: in_reply_to(event.content()),
                thread_root: msg_like(event.content()).and_then(|msg| msg.thread_root.clone()),
                thread_summary: thread_summary(event.content()),
                reactions: reactions(event.content()),
                is_own: event.is_own(),
                read_by: event.read_receipts().keys().cloned().collect(),
                per_message_profile: message_profile,
                mention: mention(event, own_user_id),
            }
        }

        TimelineItemKind::Virtual(virtual_item) => {
            let (timestamp, content) = match virtual_item {
                VirtualTimelineItem::DateDivider(at) => (
                    u64::from(at.0),
                    TimelineItemContentView::DateDivider {
                        timestamp: at.0.into(),
                    },
                ),
                VirtualTimelineItem::ReadMarker => (0, TimelineItemContentView::ReadMarker),
                VirtualTimelineItem::TimelineStart => (0, TimelineItemContentView::TimelineStart),
            };

            TimelineItemView {
                id,
                event_id: None,
                transaction_id: None,
                send_state: None,
                sender: None,
                sender_name: None,
                sender_avatar: None,
                timestamp,
                content,
                in_reply_to: None,
                thread_root: None,
                thread_summary: None,
                reactions: Vec::new(),
                is_own: false,
                read_by: Vec::new(),
                per_message_profile: None,
                mention: MentionView::None,
            }
        }
    }
}

fn send_state(state: &EventSendState) -> SendStateView {
    match state {
        EventSendState::NotSentYet { progress } => SendStateView::Sending {
            progress: progress.as_ref().map(|progress| UploadProgressView {
                current: progress.progress.current,
                total: progress.progress.total,
            }),
        },
        EventSendState::SendingFailed {
            error,
            is_recoverable,
        } => SendStateView::Failed {
            error: error.to_string(),
            recoverable: *is_recoverable,
        },
        EventSendState::Sent { .. } => SendStateView::Sent,
    }
}

/// MSC4144 is still unstable, so the Beeper key is what servers actually emit
/// today; the `m.` key is read too so nothing breaks when it stabilises.
/// `m.mentions` names us directly; the SDK's highlight flag folds in `@room`
/// and any push rule the server matched.
fn mention(event: &EventTimelineItem, own_user_id: Option<&UserId>) -> MentionView {
    if event.is_own() {
        return MentionView::None;
    }
    if event.is_highlighted() {
        return MentionView::Loud;
    }

    let mentioned = msg_like(event.content())
        .and_then(|msg| match &msg.kind {
            MsgLikeKind::Message(message) => Some(message),
            _ => None,
        })
        .and_then(|message| message.mentions())
        .is_some_and(|mentions| {
            own_user_id.is_some_and(|user_id| mentions.user_ids.contains(user_id))
        });

    if mentioned {
        MentionView::Silent
    } else {
        MentionView::None
    }
}

const PMP_KEYS: [&str; 2] = ["com.beeper.per_message_profile", "m.per_message_profile"];

fn relay_profile(content: Option<&serde_json::Value>) -> Option<PerMessageProfileView> {
    let body = content?.get("body")?.as_str()?;
    let name = relay_author(body)?;

    Some(PerMessageProfileView {
        id: None,
        display_name: Some(name.to_owned()),
        avatar_url: None,
        pronouns: Vec::new(),
        color_on_light: None,
        color_on_dark: None,
        has_fallback: true,
    })
}

fn relay_author(body: &str) -> Option<&str> {
    const MAX_NAME: usize = 64;

    let line = body.lines().next()?;
    let name = if let Some(rest) = line.strip_prefix('<') {
        rest.split_once("> ")?.0
    } else {
        let name = line.split_once(": ")?.0;
        if name.contains(['<', '>']) {
            return None;
        }
        name
    };

    let trimmed = name.trim();
    (!trimmed.is_empty() && trimmed.len() <= MAX_NAME).then_some(trimmed)
}

/// Narrow so serde skips the rest of the event; a whole-event `Value`
/// materialises every `formatted_body`.
#[derive(Default, serde::Deserialize)]
struct RawFields {
    content: Option<serde_json::Value>,
    unsigned: Option<RawUnsigned>,
}

#[derive(serde::Deserialize)]
struct RawUnsigned {
    prev_content: Option<serde_json::Value>,
    redacted_because: Option<RawRedaction>,
}

#[derive(serde::Deserialize)]
struct RawRedaction {
    content: Option<RawRedactionContent>,
}

#[derive(serde::Deserialize)]
struct RawRedactionContent {
    reason: Option<String>,
}

impl RawFields {
    /// An edit replaces the content, carrying its own profile, so the latest
    /// event wins over the original.
    fn read(event: &EventTimelineItem) -> Self {
        event
            .latest_json()
            .or_else(|| event.original_json())
            .and_then(|raw| raw.deserialize_as_unchecked::<Self>().ok())
            .unwrap_or_default()
    }

    /// A state event's previous content, which is the only source for an event
    /// type the SDK has no typed content for.
    fn prev_content(&self) -> Option<&serde_json::Value> {
        self.unsigned.as_ref()?.prev_content.as_ref()
    }

    fn redaction_reason(&self) -> Option<String> {
        self.unsigned
            .as_ref()?
            .redacted_because
            .as_ref()?
            .content
            .as_ref()?
            .reason
            .as_deref()
            .filter(|reason| !reason.trim().is_empty())
            .map(ToOwned::to_owned)
    }
}

fn per_message_profile(content: Option<&serde_json::Value>) -> Option<PerMessageProfileView> {
    let content = content?;
    let profile = PMP_KEYS.iter().find_map(|key| content.get(*key))?;

    let text = |key: &str| {
        profile
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToOwned::to_owned)
    };
    let color = |key: &str| {
        profile
            .get("eu.she-a.color")
            .and_then(|color| color.get(key))
            .and_then(serde_json::Value::as_str)
            .map(ToOwned::to_owned)
    };

    Some(PerMessageProfileView {
        id: text("id"),
        display_name: text("displayname"),
        avatar_url: text("avatar_url"),
        pronouns: pronoun_sets(profile.get("io.fsky.nyx.pronouns")),
        color_on_light: color("on_light"),
        color_on_dark: color("on_dark"),
        has_fallback: profile
            .get("has_fallback")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

fn membership_reason(content: &StateEventContentChange<RoomMemberEventContent>) -> Option<String> {
    let StateEventContentChange::Original { content, .. } = content else {
        return None;
    };
    content
        .reason
        .as_deref()
        .filter(|reason| !reason.trim().is_empty())
        .map(ToOwned::to_owned)
}

const fn membership_change(change: Option<MembershipChange>) -> MembershipChangeView {
    match change {
        Some(MembershipChange::Joined) => MembershipChangeView::Joined,
        Some(MembershipChange::Left) => MembershipChangeView::Left,
        Some(MembershipChange::Banned) => MembershipChangeView::Banned,
        Some(MembershipChange::Unbanned) => MembershipChangeView::Unbanned,
        Some(MembershipChange::Kicked) => MembershipChangeView::Kicked,
        Some(MembershipChange::Invited) => MembershipChangeView::Invited,
        Some(MembershipChange::KickedAndBanned) => MembershipChangeView::KickedAndBanned,
        Some(MembershipChange::InvitationAccepted) => MembershipChangeView::InvitationAccepted,
        Some(MembershipChange::InvitationRejected) => MembershipChangeView::InvitationRejected,
        Some(MembershipChange::InvitationRevoked) => MembershipChangeView::InvitationRevoked,
        Some(MembershipChange::Knocked) => MembershipChangeView::Knocked,
        Some(MembershipChange::KnockAccepted) => MembershipChangeView::KnockAccepted,
        Some(MembershipChange::KnockRetracted) => MembershipChangeView::KnockRetracted,
        Some(MembershipChange::KnockDenied) => MembershipChangeView::KnockDenied,
        _ => MembershipChangeView::Other,
    }
}

fn text_message(
    message: &matrix_sdk_ui::timeline::Message,
    profile: Option<&PerMessageProfileView>,
) -> TimelineItemContentView {
    let formatted = formatted_body(message.msgtype());
    let known = formatted.as_deref().is_some_and(has_profile_fallback_html)
        || profile.is_some_and(|profile| profile.has_fallback);
    let body = strip_profile_fallback_body(
        message.body(),
        profile.and_then(|profile| profile.display_name.as_deref()),
        known,
    );
    // Runs without a parsed profile too: the marker alone is enough, and
    // skipping it leaves the html naming a sender the body no longer does.
    let formatted = formatted.map(|formatted| {
        strip_profile_fallback_html(
            &formatted,
            profile.and_then(|profile| profile.display_name.as_deref()),
            known,
        )
    });

    TimelineItemContentView::Message {
        html: display_html(&body, formatted.as_deref()),
        body,
        emote: matches!(message.msgtype(), MessageType::Emote(_)),
        notice: matches!(message.msgtype(), MessageType::Notice(_)),
        edited: message.is_edited(),
    }
}

/// RFC 5870 `geo:lat,long[,alt]` with optional `;`-separated parameters.
pub(crate) fn geo_coordinates(geo_uri: &str) -> Option<(f64, f64)> {
    // RFC 3986: schemes are case-insensitive.
    let scheme = geo_uri.get(..4)?;
    if !scheme.eq_ignore_ascii_case("geo:") {
        return None;
    }
    let coordinates = geo_uri.get(4..)?.split(';').next()?;
    let mut parts = coordinates.split(',');
    let latitude: f64 = parts.next()?.trim().parse().ok()?;
    let longitude: f64 = parts.next()?.trim().parse().ok()?;

    // RFC 5870 declares anything outside these ranges invalid.
    ((-90.0..=90.0).contains(&latitude) && (-180.0..=180.0).contains(&longitude))
        .then_some((latitude, longitude))
}

fn poll(state: &PollState, own_user_id: Option<&UserId>) -> PollView {
    let results = state.results();
    // MSC3381 says to assume `m.undisclosed` for a kind we do not recognise, so
    // only an explicit `m.disclosed` reveals a running tally.
    let undisclosed = !matches!(results.kind, PollKind::Disclosed);
    let reveal = results.end_time.is_some() || !undisclosed;
    let tally = results.votes;

    PollView {
        question: results.question,
        answers: results
            .answers
            .into_iter()
            .map(|answer| {
                let voters = tally.get(&answer.id);
                PollAnswerView {
                    votes: reveal.then(|| {
                        voters.map_or(0, |voters| u32::try_from(voters.len()).unwrap_or(u32::MAX))
                    }),
                    voters: reveal.then(|| {
                        voters.map_or_else(Vec::new, |voters| {
                            voters
                                .iter()
                                .filter_map(|voter| OwnedUserId::try_from(voter.as_str()).ok())
                                .collect()
                        })
                    }),
                    selected: own_user_id.is_some_and(|own| {
                        voters
                            .is_some_and(|voters| voters.iter().any(|voter| voter == own.as_str()))
                    }),
                    id: answer.id,
                    text: answer.text,
                }
            })
            .collect(),
        max_selections: u32::try_from(results.max_selections).unwrap_or(u32::MAX),
        undisclosed,
        ended_at: results.end_time.map(|at| at.0.into()),
        edited: results.has_been_edited,
    }
}

/// `media.rs` reads a bare string back as a plain mxc URI, so the common case
/// skips the serializer and the wrapper object.
fn media_source(source: &MediaSource) -> String {
    match source {
        MediaSource::Plain(uri) => uri.as_str().to_owned(),
        encrypted @ MediaSource::Encrypted(_) => {
            serde_json::to_string(encrypted).unwrap_or_default()
        }
    }
}

fn gallery_item(item: &GalleryItemType) -> Option<GalleryItemView> {
    let dimension = |value: Option<UInt>| value.map(u64::from);

    Some(match item {
        GalleryItemType::Image(image) => GalleryItemView::Image {
            body: image.body.clone(),
            source: media_source(&image.source),
            mime: image.info.as_ref().and_then(|info| info.mimetype.clone()),
            width: dimension(image.info.as_ref().and_then(|info| info.width)),
            height: dimension(image.info.as_ref().and_then(|info| info.height)),
        },
        GalleryItemType::Video(video) => GalleryItemView::Video {
            body: video.body.clone(),
            source: media_source(&video.source),
            mime: video.info.as_ref().and_then(|info| info.mimetype.clone()),
            width: dimension(video.info.as_ref().and_then(|info| info.width)),
            height: dimension(video.info.as_ref().and_then(|info| info.height)),
        },
        GalleryItemType::Audio(audio) => GalleryItemView::Audio {
            body: audio.body.clone(),
            source: media_source(&audio.source),
            mime: audio.info.as_ref().and_then(|info| info.mimetype.clone()),
        },
        GalleryItemType::File(file) => GalleryItemView::File {
            body: file.body.clone(),
            source: media_source(&file.source),
            mime: file.info.as_ref().and_then(|info| info.mimetype.clone()),
        },
        // The caption already describes the set, so an unrenderable item is
        // dropped instead of leaving a gap.
        _ => return None,
    })
}

fn state_change(
    state: &OtherState,
    content: Option<&serde_json::Value>,
    prev_content: Option<&serde_json::Value>,
) -> Option<StateChangeView> {
    let text = |value: &str| (!value.trim().is_empty()).then(|| value.to_owned());

    match state.content() {
        AnyOtherStateEventContentChange::RoomName(change) => match change {
            StateEventContentChange::Original {
                content,
                prev_content,
            } => Some(StateChangeView::RoomName {
                name: text(&content.name),
                previous: prev_content
                    .as_ref()
                    .and_then(|prev| prev.name.as_deref())
                    .and_then(text),
            }),
            StateEventContentChange::Redacted(_) => None,
        },
        AnyOtherStateEventContentChange::RoomTopic(change) => match change {
            StateEventContentChange::Original { content, .. } => Some(StateChangeView::RoomTopic {
                topic: text(&content.topic),
            }),
            StateEventContentChange::Redacted(_) => None,
        },
        AnyOtherStateEventContentChange::RoomAvatar(change) => match change {
            StateEventContentChange::Original { content, .. } => {
                Some(StateChangeView::RoomAvatar {
                    removed: content.url.is_none(),
                })
            }
            StateEventContentChange::Redacted(_) => None,
        },
        AnyOtherStateEventContentChange::RoomPinnedEvents(change) => match change {
            StateEventContentChange::Original {
                content,
                prev_content,
            } => {
                let previous = prev_content
                    .as_ref()
                    .and_then(|prev| prev.pinned.clone())
                    .unwrap_or_default();
                Some(StateChangeView::PinnedEvents {
                    added: content
                        .pinned
                        .iter()
                        .filter(|pin| !previous.contains(pin))
                        .cloned()
                        .collect(),
                    removed: previous
                        .iter()
                        .filter(|pin| !content.pinned.contains(pin))
                        .cloned()
                        .collect(),
                    total: u32::try_from(content.pinned.len()).unwrap_or(u32::MAX),
                })
            }
            StateEventContentChange::Redacted(_) => None,
        },
        // MSC3401 is unstable, so there is no typed content to read.
        AnyOtherStateEventContentChange::_Custom { event_type }
            if event_type == CALL_MEMBER_TYPE =>
        {
            // A redaction takes the content with it; an empty content is a
            // real leave.
            let content = content?;
            let joined = in_call(Some(content));
            // Moving between calls has no copy.
            if joined && in_call(prev_content) {
                return None;
            }
            Some(StateChangeView::CallMembership { joined })
        }
        _ => None,
    }
}

/// The legacy MSC3401 shape is a `memberships` array; the session shape that
/// replaced it carries a top-level `application`. Both are still in the wild.
fn in_call(content: Option<&serde_json::Value>) -> bool {
    let Some(content) = content else {
        return false;
    };
    if content.get("application").is_some() {
        return true;
    }
    content
        .get("memberships")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|memberships| !memberships.is_empty())
}

// ruma resolves the `m.call.member` alias to the unstable type, so only the
// unstable one is ever seen here.
pub(crate) const CALL_MEMBER_TYPE: &str = "org.matrix.msc3401.call.member";

/// The MSC3401 marker a voice room carries. Written on creation and never read
/// back: it is there for other clients.
pub(crate) const CALL_TYPE: &str = "org.matrix.msc3401.call";

fn spoiler_reason(content: Option<&serde_json::Value>) -> Option<String> {
    const SPOILER: &str = "page.codeberg.everypizza.msc4193.spoiler";
    const REASON: &str = "page.codeberg.everypizza.msc4193.spoiler.reason";

    let content = content?;
    if content.get(SPOILER)?.as_bool() != Some(true) {
        return None;
    }
    Some(
        content
            .get(REASON)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    )
}

const fn utd_cause(message: &EncryptedMessage) -> UtdCauseView {
    let EncryptedMessage::MegolmV1AesSha2 { cause, .. } = message else {
        return UtdCauseView::Unknown;
    };

    match cause {
        UtdCause::SentBeforeWeJoined => UtdCauseView::SentBeforeWeJoined,
        UtdCause::VerificationViolation => UtdCauseView::VerificationViolation,
        UtdCause::UnsignedDevice => UtdCauseView::UnsignedDevice,
        UtdCause::UnknownDevice => UtdCauseView::UnknownDevice,
        UtdCause::HistoricalMessageAndBackupIsDisabled => {
            UtdCauseView::HistoricalMessageBackupDisabled
        }
        UtdCause::HistoricalMessageAndDeviceIsUnverified => {
            UtdCauseView::HistoricalMessageDeviceUnverified
        }
        UtdCause::WithheldForUnverifiedOrInsecureDevice => {
            UtdCauseView::WithheldForUnverifiedOrInsecureDevice
        }
        UtdCause::WithheldBySender => UtdCauseView::WithheldBySender,
        UtdCause::Unknown => UtdCauseView::Unknown,
    }
}

fn message_content(
    message: &matrix_sdk_ui::timeline::Message,
    profile: Option<&PerMessageProfileView>,
    raw: &RawFields,
) -> TimelineItemContentView {
    let dimension = |value: Option<UInt>| value.map(u64::from);

    match message.msgtype() {
        MessageType::Image(image) => TimelineItemContentView::Image {
            body: image.body.clone(),
            source: media_source(&image.source),
            filename: image.filename.clone(),
            mime: image.info.as_ref().and_then(|info| info.mimetype.clone()),
            width: dimension(image.info.as_ref().and_then(|info| info.width)),
            height: dimension(image.info.as_ref().and_then(|info| info.height)),
            blurhash: image.info.as_ref().and_then(|info| info.blurhash.clone()),
            spoiler: spoiler_reason(raw.content.as_ref()),
        },
        MessageType::Video(video) => TimelineItemContentView::Video {
            body: video.body.clone(),
            source: media_source(&video.source),
            mime: video.info.as_ref().and_then(|info| info.mimetype.clone()),
            width: dimension(video.info.as_ref().and_then(|info| info.width)),
            height: dimension(video.info.as_ref().and_then(|info| info.height)),
            blurhash: video.info.as_ref().and_then(|info| info.blurhash.clone()),
            spoiler: spoiler_reason(raw.content.as_ref()),
        },
        MessageType::Audio(audio) => TimelineItemContentView::Audio {
            body: audio.body.clone(),
            source: media_source(&audio.source),
            mime: audio.info.as_ref().and_then(|info| info.mimetype.clone()),
            duration_ms: audio
                .audio
                .as_ref()
                .map(|details| details.duration)
                .or_else(|| audio.info.as_ref().and_then(|info| info.duration))
                .and_then(|duration| u64::try_from(duration.as_millis()).ok()),
            waveform: audio.audio.as_ref().map(|details| {
                details
                    .waveform
                    .iter()
                    .map(|amplitude| {
                        let value = u64::from(amplitude.get());
                        #[allow(clippy::cast_precision_loss)]
                        let normalised = value as f32 / f32::from(UnstableAmplitude::MAX);
                        normalised
                    })
                    .collect()
            }),
            voice: audio.voice.is_some(),
        },
        MessageType::File(file) => TimelineItemContentView::File {
            body: file.body.clone(),
            source: media_source(&file.source),
            mime: file.info.as_ref().and_then(|info| info.mimetype.clone()),
            size: file.info.as_ref().and_then(|info| info.size).map(u64::from),
        },
        MessageType::Location(location) => {
            let coordinates = geo_coordinates(&location.geo_uri);
            TimelineItemContentView::Location {
                body: location.body.clone(),
                geo_uri: location.geo_uri.clone(),
                latitude: coordinates.map(|(latitude, _)| latitude),
                longitude: coordinates.map(|(_, longitude)| longitude),
            }
        }
        MessageType::Gallery(gallery) => TimelineItemContentView::Gallery {
            html: display_html(
                &gallery.body,
                gallery
                    .formatted
                    .as_ref()
                    .map(|formatted| formatted.body.as_str()),
            ),
            body: gallery.body.clone(),
            items: gallery.itemtypes.iter().filter_map(gallery_item).collect(),
        },
        _ => text_message(message, profile),
    }
}

fn content(
    content: &TimelineItemContent,
    profile: Option<&PerMessageProfileView>,
    raw: &RawFields,
    own_user_id: Option<&UserId>,
) -> TimelineItemContentView {
    let unsupported = |what: &str| TimelineItemContentView::Unsupported {
        description: what.to_owned(),
    };

    match content {
        TimelineItemContent::MsgLike(msg) => match &msg.kind {
            MsgLikeKind::Message(message) => message_content(message, profile, raw),
            MsgLikeKind::Redacted => TimelineItemContentView::Redacted {
                reason: raw.redaction_reason(),
            },
            MsgLikeKind::UnableToDecrypt(message) => TimelineItemContentView::UnableToDecrypt {
                reason: utd_cause(message),
            },
            MsgLikeKind::Sticker(sticker) => {
                let sticker = sticker.content();
                TimelineItemContentView::Sticker {
                    body: sticker.body.clone(),
                    source: serde_json::to_string(&sticker.source).unwrap_or_default(),
                    mime: sticker.info.mimetype.clone(),
                    width: sticker.info.width.map(u64::from),
                    height: sticker.info.height.map(u64::from),
                }
            }
            MsgLikeKind::Poll(state) => TimelineItemContentView::Poll {
                poll: poll(state, own_user_id),
            },
            MsgLikeKind::LiveLocation(_) => unsupported("live location"),
            MsgLikeKind::Other(other) => TimelineItemContentView::HiddenEvent {
                event_type: other.event_type().to_string(),
                content: raw.content.clone(),
            },
        },

        TimelineItemContent::MembershipChange(change) => TimelineItemContentView::Membership {
            user_id: change.user_id().to_owned(),
            change: membership_change(change.change()),
            display_name: change.display_name(),
            reason: membership_reason(change.content()),
        },

        TimelineItemContent::ProfileChange(change) => TimelineItemContentView::ProfileChange {
            user_id: change.user_id().to_owned(),
            display_name: change
                .displayname_change()
                .map(|change| DisplayNameChangeView {
                    old: change.old.clone(),
                    new: change.new.clone(),
                }),
            avatar_changed: change.avatar_url_change().is_some(),
        },

        TimelineItemContent::OtherState(state) => TimelineItemContentView::StateEvent {
            event_type: state.content().event_type().to_string(),
            state_key: state.state_key().to_owned(),
            change: state_change(state, raw.content.as_ref(), raw.prev_content()),
            content: raw.content.clone(),
        },
        TimelineItemContent::CallInvite => unsupported("call invite"),
        _ => unsupported("event"),
    }
}

fn formatted_body(msgtype: &MessageType) -> Option<String> {
    match msgtype {
        MessageType::Text(content) => content.formatted.as_ref().map(|f| f.body.clone()),
        MessageType::Notice(content) => content.formatted.as_ref().map(|f| f.body.clone()),
        MessageType::Emote(content) => content.formatted.as_ref().map(|f| f.body.clone()),
        _ => None,
    }
}

const fn msg_like(content: &TimelineItemContent) -> Option<&MsgLikeContent> {
    match content {
        TimelineItemContent::MsgLike(msg) => Some(msg),
        _ => None,
    }
}

/// An unloaded event still yields its id.
fn in_reply_to(content: &TimelineItemContent) -> Option<ReplyView> {
    let reply = msg_like(content)?.in_reply_to.as_ref()?;

    let embedded = match &reply.event {
        TimelineDetails::Ready(event) => Some(event),
        _ => None,
    };

    Some(ReplyView {
        event_id: reply.event_id.clone(),
        sender: embedded.map(|event| event.sender.clone()),
        sender_name: embedded.and_then(|event| match &event.sender_profile {
            TimelineDetails::Ready(profile) => profile.display_name.clone(),
            _ => None,
        }),
        body: embedded.and_then(|event| body_of(&event.content)),
    })
}

fn thread_summary(content: &TimelineItemContent) -> Option<ThreadSummaryView> {
    let summary = msg_like(content)?.thread_summary.as_ref()?;

    Some(ThreadSummaryView {
        num_replies: summary.num_replies,
        latest_body: match &summary.latest_event {
            TimelineDetails::Ready(event) => body_of(&event.content),
            _ => None,
        },
    })
}

/// Plain text: a preview must not run untrusted HTML.
fn body_of(content: &TimelineItemContent) -> Option<String> {
    match &msg_like(content)?.kind {
        MsgLikeKind::Message(message) => Some(message.body().to_owned()),
        MsgLikeKind::Sticker(sticker) => Some(sticker.content().body.clone()),
        MsgLikeKind::Poll(state) => Some(state.results().question),
        _ => None,
    }
}

fn reactions(content: &TimelineItemContent) -> Vec<ReactionGroup> {
    let TimelineItemContent::MsgLike(msg) = content else {
        return Vec::new();
    };

    msg.reactions
        .iter()
        .map(|(key, senders)| ReactionGroup {
            key: key.clone(),
            senders: senders.keys().cloned().collect(),
        })
        .collect()
}

#[must_use]
pub fn member_view(member: &RoomMember) -> MemberView {
    MemberView {
        user_id: member.user_id().to_owned(),
        display_name: member.display_name().map(str::to_owned),
        avatar_url: member.avatar_url().map(ToString::to_string),
        power_level: clamp_power_level(member.power_level()),
        membership: membership_view(member.membership()),
        member_ts: member.event().timestamp().map(u64::from),
        kicked: matches!(member.membership(), MembershipState::Leave)
            && member.event().sender() != member.user_id(),
    }
}

const fn membership_view(state: &MembershipState) -> MembershipView {
    match state {
        MembershipState::Join => MembershipView::Join,
        MembershipState::Invite => MembershipView::Invite,
        MembershipState::Knock => MembershipView::Knock,
        MembershipState::Ban => MembershipView::Ban,
        _ => MembershipView::Leave,
    }
}

#[must_use]
pub fn room_permissions(power_levels: &RoomPowerLevels, user_id: &UserId) -> RoomPermissionsView {
    RoomPermissionsView {
        own_power_level: clamp_power_level(power_levels.for_user(user_id)),
        can_post: power_levels.user_can_send_message(user_id, MessageLikeEventType::RoomMessage),
        can_redact_others: power_levels.user_can_redact_event_of_other(user_id),
        can_invite: power_levels.user_can_invite(user_id),
        can_kick: power_levels.user_can_kick(user_id),
        can_ban: power_levels.user_can_ban(user_id),
        can_change_settings: power_levels.user_can_send_state(user_id, StateEventType::RoomName),
        can_pin: power_levels.user_can_send_state(user_id, StateEventType::RoomPinnedEvents),
        can_change_join_rule: power_levels
            .user_can_send_state(user_id, StateEventType::RoomJoinRules),
        can_change_power_levels: power_levels
            .user_can_send_state(user_id, StateEventType::RoomPowerLevels),
        can_manage_children: power_levels.user_can_send_state(user_id, StateEventType::SpaceChild),
    }
}

pub(crate) fn clamp_power_level(level: UserPowerLevel) -> i32 {
    match level {
        UserPowerLevel::Int(level) => i32::try_from(level).unwrap_or_else(|_| {
            if level.is_negative() {
                i32::MIN
            } else {
                i32::MAX
            }
        }),
        _ => i32::MAX,
    }
}

#[must_use]
pub fn map_diff<T, U>(diff: eyeball_im::VectorDiff<T>, map: impl Fn(&T) -> U) -> VectorDiff<U> {
    use eyeball_im::VectorDiff as In;

    match diff {
        In::Append { values } => VectorDiff::Append {
            values: values.iter().map(&map).collect(),
        },
        In::Clear => VectorDiff::Clear,
        In::PushFront { value } => VectorDiff::PushFront { value: map(&value) },
        In::PushBack { value } => VectorDiff::PushBack { value: map(&value) },
        In::PopFront => VectorDiff::PopFront,
        In::PopBack => VectorDiff::PopBack,
        In::Insert { index, value } => VectorDiff::Insert {
            index,
            value: map(&value),
        },
        In::Set { index, value } => VectorDiff::Set {
            index,
            value: map(&value),
        },
        In::Remove { index } => VectorDiff::Remove { index },
        In::Truncate { length } => VectorDiff::Truncate { length },
        In::Reset { values } => VectorDiff::Reset {
            values: values.iter().map(&map).collect(),
        },
    }
}

fn diff_values<T>(diff: &eyeball_im::VectorDiff<T>) -> Vec<&T> {
    use eyeball_im::VectorDiff as In;

    match diff {
        In::Append { values } | In::Reset { values } => values.iter().collect(),
        In::PushFront { value }
        | In::PushBack { value }
        | In::Insert { value, .. }
        | In::Set { value, .. } => vec![value],
        In::Clear | In::PopFront | In::PopBack | In::Remove { .. } | In::Truncate { .. } => {
            Vec::new()
        }
    }
}

/// Computed lazily: until something awaits `display_name()` every unnamed room
/// crosses the wire as `null`.
pub async fn prime_display_names(diffs: &[eyeball_im::VectorDiff<RoomListItem>]) {
    for diff in diffs {
        for item in diff_values(diff) {
            if item.cached_display_name().is_none() {
                let _ = item.display_name().await;
            }
        }
    }
}

pub(crate) fn search_hit_view(hit: crate::search::Hit) -> SearchHitView {
    SearchHitView {
        room_id: hit.room_id,
        event_id: hit.event_id,
        body: hit.body,
        sender: hit.sender,
        origin_server_ts: hit.origin_server_ts,
        score: hit.score,
    }
}

fn clamp_int(level: Int) -> i32 {
    i32::try_from(i64::from(level)).unwrap_or(if level.is_negative() {
        i32::MIN
    } else {
        i32::MAX
    })
}

#[must_use]
pub fn room_power_levels(power_levels: &RoomPowerLevels) -> RoomPowerLevelsView {
    RoomPowerLevelsView {
        ban: clamp_int(power_levels.ban),
        kick: clamp_int(power_levels.kick),
        redact: clamp_int(power_levels.redact),
        invite: clamp_int(power_levels.invite),
        events_default: clamp_int(power_levels.events_default),
        state_default: clamp_int(power_levels.state_default),
        users_default: clamp_int(power_levels.users_default),
        events: power_levels
            .events
            .iter()
            .map(|(event_type, level)| (event_type.to_string(), clamp_int(*level)))
            .collect(),
        users: power_levels
            .users
            .iter()
            .map(|(user_id, level)| (user_id.to_string(), clamp_int(*level)))
            .collect(),
        notifications_room: clamp_int(power_levels.notifications.room),
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::OwnedUserId;
    use serde_json::json;

    use super::{
        call_participants, clamp_power_level, geo_coordinates, in_call, per_message_profile,
        relay_author, relay_profile, via_servers,
    };
    use matrix_sdk::ruma::events::room::power_levels::UserPowerLevel;

    fn members(entries: &[(&str, i32)]) -> Vec<(String, i32)> {
        entries
            .iter()
            .map(|(user_id, power)| ((*user_id).to_owned(), *power))
            .collect()
    }

    #[test]
    fn leads_with_the_server_of_the_highest_moderator() {
        let servers = via_servers(&members(&[
            ("@a:crowded.example", 0),
            ("@b:crowded.example", 0),
            ("@admin:quiet.example", 100),
        ]));

        assert_eq!(servers, ["quiet.example", "crowded.example"]);
    }

    #[test]
    fn ignores_a_user_below_the_moderator_threshold() {
        let servers = via_servers(&members(&[
            ("@a:crowded.example", 0),
            ("@b:crowded.example", 0),
            ("@almost:quiet.example", 49),
        ]));

        assert_eq!(servers, ["crowded.example", "quiet.example"]);
    }

    #[test]
    fn fills_the_remaining_slots_by_population() {
        let servers = via_servers(&members(&[
            ("@admin:first.example", 100),
            ("@a:second.example", 0),
            ("@b:second.example", 0),
            ("@c:second.example", 0),
            ("@d:third.example", 0),
            ("@e:third.example", 0),
            ("@f:fourth.example", 0),
        ]));

        assert_eq!(
            servers,
            ["first.example", "second.example", "third.example"]
        );
    }

    #[test]
    fn never_advertises_the_same_server_twice() {
        let servers = via_servers(&members(&[
            ("@admin:one.example", 100),
            ("@a:one.example", 0),
            ("@b:one.example", 0),
            ("@c:two.example", 0),
        ]));

        assert_eq!(servers, ["one.example", "two.example"]);
    }

    #[test]
    fn supplies_only_what_the_room_has() {
        assert_eq!(
            via_servers(&members(&[("@a:one.example", 0)])),
            ["one.example"]
        );
        assert!(via_servers(&[]).is_empty());
    }

    #[test]
    fn breaks_ties_deterministically() {
        let tied_power = members(&[("@b:beta.example", 100), ("@a:alpha.example", 100)]);
        let reversed = members(&[("@a:alpha.example", 100), ("@b:beta.example", 100)]);
        assert_eq!(via_servers(&tied_power), via_servers(&reversed));
        assert_eq!(via_servers(&tied_power)[0], "alpha.example");

        let tied_population = members(&[("@a:alpha.example", 0), ("@b:beta.example", 0)]);
        assert_eq!(
            via_servers(&tied_population),
            ["alpha.example", "beta.example"]
        );
    }

    #[test]
    fn skips_a_user_id_with_no_server() {
        assert!(via_servers(&members(&[("malformed", 100)])).is_empty());
    }

    #[test]
    fn reads_the_author_a_relay_bot_writes_into_the_body() {
        assert_eq!(relay_author("<Marie> salut"), Some("Marie"));
        assert_eq!(relay_author("Marie: salut"), Some("Marie"));
        assert_eq!(relay_author("<Marie Dupont> salut"), Some("Marie Dupont"));
        assert_eq!(
            relay_author("<Marie> salut\nsur deux lignes"),
            Some("Marie")
        );
        assert_eq!(relay_author("Marie: a: b"), Some("Marie"));
        assert_eq!(
            relay_author("we shipped it: finally"),
            Some("we shipped it")
        );
    }

    #[test]
    fn leaves_a_body_that_names_no_author() {
        assert_eq!(relay_author("salut"), None);
        assert_eq!(relay_author("<Marie>salut"), None);
        assert_eq!(relay_author(": salut"), None);
        assert_eq!(relay_author(&format!("{}: hi", "n".repeat(65))), None);
        assert_eq!(relay_author("\nMarie: salut"), None);
    }

    #[test]
    fn synthesises_a_profile_only_from_a_body_that_names_an_author() {
        let named = relay_profile(Some(&json!({ "body": "<Marie> salut" }))).expect("profile");
        assert_eq!(named.display_name.as_deref(), Some("Marie"));
        assert!(named.has_fallback);
        assert!(relay_profile(Some(&json!({ "body": "salut" }))).is_none());
        assert!(relay_profile(Some(&json!({ "msgtype": "m.text" }))).is_none());
    }

    #[test]
    fn reads_a_geo_uri_with_parameters_an_altitude_or_an_upper_case_scheme() {
        assert_eq!(geo_coordinates("geo:51.5,-0.12"), Some((51.5, -0.12)));
        assert_eq!(geo_coordinates("geo:51.5,-0.12;u=35"), Some((51.5, -0.12)));
        assert_eq!(geo_coordinates("geo:51.5,-0.12,120"), Some((51.5, -0.12)));
        assert_eq!(geo_coordinates("GEO:51.5,-0.12"), Some((51.5, -0.12)));
    }

    #[test]
    fn leaves_an_unreadable_geo_uri_without_coordinates() {
        assert_eq!(geo_coordinates("https://example.org/map"), None);
        assert_eq!(geo_coordinates("geo:somewhere"), None);
        assert_eq!(geo_coordinates("geo:"), None);
        assert_eq!(geo_coordinates("geo:51.5"), None);
    }

    #[test]
    fn rejects_coordinates_outside_the_ranges_rfc_5870_allows() {
        assert_eq!(geo_coordinates("geo:91,0"), None);
        assert_eq!(geo_coordinates("geo:0,181"), None);
        assert_eq!(geo_coordinates("geo:-90,-180"), Some((-90.0, -180.0)));
    }

    #[test]
    fn saturates_a_power_level_that_does_not_fit_and_treats_infinite_as_the_ceiling() {
        use matrix_sdk::ruma::Int;

        assert_eq!(clamp_power_level(UserPowerLevel::Int(Int::from(50))), 50);
        assert_eq!(
            clamp_power_level(UserPowerLevel::Int(Int::MAX)),
            i32::MAX,
            "a level above i32 must not wrap into a demotion"
        );
        assert_eq!(clamp_power_level(UserPowerLevel::Int(Int::MIN)), i32::MIN);
        assert_eq!(clamp_power_level(UserPowerLevel::Infinite), i32::MAX);
    }

    #[test]
    fn reads_a_per_message_profile_under_either_key() {
        let beeper = json!({ "com.beeper.per_message_profile": { "displayname": "Kris" } });
        let stable = json!({ "m.per_message_profile": { "displayname": "Kris" } });

        for content in [&beeper, &stable] {
            let profile = per_message_profile(Some(content)).expect("a profile under either key");
            assert_eq!(profile.display_name.as_deref(), Some("Kris"));
            assert!(!profile.has_fallback);
        }

        assert!(per_message_profile(Some(&json!({}))).is_none());
        assert!(per_message_profile(None).is_none());
    }

    #[test]
    fn a_blank_profile_name_reads_as_no_name_rather_than_an_empty_one() {
        let content = json!({ "m.per_message_profile": { "displayname": "   " } });
        let profile = per_message_profile(Some(&content)).expect("a profile");

        assert_eq!(profile.display_name, None);
    }

    #[test]
    fn recognises_both_call_membership_shapes_and_neither() {
        assert!(in_call(Some(&json!({ "application": "m.call" }))));
        assert!(in_call(Some(
            &json!({ "memberships": [{ "call_id": "" }] })
        )));
        assert!(!in_call(Some(&json!({ "memberships": [] }))));
        assert!(!in_call(Some(&json!({}))));
        assert!(!in_call(None));
    }

    #[test]
    fn one_participant_per_user_however_many_devices_joined() {
        let user = |id: &str| OwnedUserId::try_from(id).unwrap();

        assert_eq!(
            call_participants(vec![
                user("@a:example.org"),
                user("@b:example.org"),
                user("@a:example.org"),
            ]),
            vec![user("@a:example.org"), user("@b:example.org")]
        );
        assert!(call_participants(Vec::new()).is_empty());
    }
}
