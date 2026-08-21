use std::collections::HashMap;
use std::hash::BuildHasher;
use std::sync::Arc;

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::Client;
use matrix_sdk::deserialized_responses::SyncOrStrippedState;
use matrix_sdk::room::{ParentSpace, Room, RoomMember};
use matrix_sdk::room_preview::RoomPreview;
use matrix_sdk::ruma::UInt;
use matrix_sdk::ruma::events::SyncStateEvent;
use matrix_sdk::ruma::events::poll::start::PollKind;
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::events::room::join_rules::JoinRule;
use matrix_sdk::ruma::events::room::message::{GalleryItemType, MessageType};
use matrix_sdk::ruma::events::room::power_levels::{RoomPowerLevels, UserPowerLevel};
use matrix_sdk::ruma::events::space::child::{HierarchySpaceChildEvent, SpaceChildEventContent};
use matrix_sdk::ruma::events::{MessageLikeEventType, StateEventContentChange, StateEventType};
use matrix_sdk::ruma::room::{JoinRuleSummary, RoomSummary as RumaRoomSummary, RoomType};
use matrix_sdk::ruma::{OwnedRoomId, UserId};
use matrix_sdk::{EncryptionState, RoomState};
use matrix_sdk_ui::{
    eyeball_im,
    room_list_service::RoomListItem,
    timeline::{
        AnyOtherStateEventContentChange, EventSendState, EventTimelineItem, MembershipChange,
        MsgLikeContent, MsgLikeKind, OtherState, PollState, Profile, TimelineDetails, TimelineItem,
        TimelineItemContent, TimelineItemKind, VirtualTimelineItem,
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
use crate::pronoun_sets;
use crate::protocol::{
    DisplayNameChangeView, GalleryItemView, LatestEventView, MemberView, MembershipChangeView,
    MentionView, PerMessageProfileView, PollAnswerView, PollView, ReactionGroup, ReplyView,
    RoomJoinRuleView, RoomPermissionsView, RoomPreviewView, RoomStateView, RoomSummary, RoomTag,
    SendStateView, SpaceChildEdge, SpaceHierarchyRoomView, StateChangeView, ThreadSummaryView,
    TimelineItemContentView, TimelineItemView, UploadProgressView, VectorDiff,
};

// These are independent room capabilities, not a state machine.
#[allow(clippy::struct_excessive_bools)]
pub struct RoomInfo {
    pub is_space: bool,
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
        has_space_parent: info.is_some_and(|i| i.has_space_parent),
        supports_knock: info.is_some_and(|i| i.supports_knock),
        supports_restricted: info.is_some_and(|i| i.supports_restricted),
        supports_knock_restricted: info.is_some_and(|i| i.supports_knock_restricted),
        space_children: info.map(|i| i.children.clone()).unwrap_or_default(),
        unread,
        highlight,
        latest_event: latest_event(item),
    }
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

    for item in items {
        let room_id = item.room_id();

        // `Set` re-enriches when the summary changes, including re-parenting.
        if room_cache.contains_key(room_id) && !matches!(diff, In::Set { .. }) {
            continue;
        }

        let info = match client.get_room(room_id) {
            Some(room) => {
                let is_space = room.is_space();
                let has_space_parent = has_space_parent(&room).await;
                let (supports_knock, supports_restricted, supports_knock_restricted) =
                    crate::join_rule_support(&room).await;
                let canonical_alias = room.canonical_alias().map(|alias| alias.to_string());

                let children = if is_space {
                    space_children(&room).await
                } else {
                    Vec::new()
                };

                RoomInfo {
                    is_space,
                    has_space_parent,
                    supports_knock,
                    supports_restricted,
                    supports_knock_restricted,
                    canonical_alias,
                    children,
                    tags: room_tags(&room),
                }
            }
            None => RoomInfo {
                is_space: false,
                has_space_parent: false,
                supports_knock: false,
                supports_restricted: false,
                supports_knock_restricted: false,
                canonical_alias: None,
                children: Vec::new(),
                tags: Vec::new(),
            },
        };
        room_cache.insert(room_id.to_owned(), info);
    }
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
pub fn timeline_item(item: &Arc<TimelineItem>, own_user_id: Option<&UserId>) -> TimelineItemView {
    let id = item.unique_id().0.clone();

    match item.kind() {
        TimelineItemKind::Event(event) => {
            let profile = match event.sender_profile() {
                TimelineDetails::Ready(profile) => Some(profile),
                _ => None,
            };
            let raw = raw_content(event);
            let prev_raw = raw_prev_content(event);
            let message_profile = per_message_profile(raw.as_ref());

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
                content: content(
                    event.content(),
                    message_profile.as_ref(),
                    raw.as_ref(),
                    prev_raw.as_ref(),
                    own_user_id,
                ),
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

/// An edit replaces the content, carrying its own profile, so the latest event
/// wins over the original.
fn raw_content(event: &EventTimelineItem) -> Option<serde_json::Value> {
    let raw = event.latest_json().or_else(|| event.original_json())?;
    let json: serde_json::Value = raw.deserialize_as_unchecked().ok()?;
    json.get("content").cloned()
}

/// Lives in `unsigned`, and is the only source for an event type the SDK has no
/// typed content for.
fn raw_prev_content(event: &EventTimelineItem) -> Option<serde_json::Value> {
    let raw = event.latest_json().or_else(|| event.original_json())?;
    let json: serde_json::Value = raw.deserialize_as_unchecked().ok()?;
    json.get("unsigned")?.get("prev_content").cloned()
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

/// `geo:lat,long` with optional `;`-separated parameters.
fn geo_coordinates(geo_uri: &str) -> (Option<f64>, Option<f64>) {
    let Some(rest) = geo_uri.strip_prefix("geo:") else {
        return (None, None);
    };
    let coordinates = rest.split(';').next().unwrap_or(rest);
    let mut parts = coordinates.split(',');
    let latitude = parts.next().and_then(|part| part.trim().parse().ok());
    let longitude = parts.next().and_then(|part| part.trim().parse().ok());
    (latitude, longitude)
}

fn poll(state: &PollState, own_user_id: Option<&UserId>) -> PollView {
    let results = state.results();
    let ended = results.end_time.is_some();
    let undisclosed = matches!(results.kind, PollKind::Undisclosed);
    let reveal = ended || !undisclosed;

    PollView {
        question: results.question,
        answers: results
            .answers
            .iter()
            .map(|answer| {
                let voters = results.votes.get(&answer.id);
                PollAnswerView {
                    id: answer.id.clone(),
                    text: answer.text.clone(),
                    votes: reveal.then(|| {
                        voters.map_or(0, |voters| u32::try_from(voters.len()).unwrap_or(u32::MAX))
                    }),
                    selected: own_user_id.is_some_and(|own| {
                        voters
                            .is_some_and(|voters| voters.iter().any(|voter| voter == own.as_str()))
                    }),
                }
            })
            .collect(),
        max_selections: u32::try_from(results.max_selections).unwrap_or(u32::MAX),
        undisclosed,
        ended_at: results.end_time.map(|at| at.0.into()),
        edited: results.has_been_edited,
    }
}

fn gallery_item(item: &GalleryItemType) -> Option<GalleryItemView> {
    let source = |source: &MediaSource| serde_json::to_string(source).unwrap_or_default();
    let dimension = |value: Option<UInt>| value.map(|value| i64::from(value).cast_unsigned());

    Some(match item {
        GalleryItemType::Image(image) => GalleryItemView::Image {
            body: image.body.clone(),
            source: source(&image.source),
            mime: image.info.as_ref().and_then(|info| info.mimetype.clone()),
            width: dimension(image.info.as_ref().and_then(|info| info.width)),
            height: dimension(image.info.as_ref().and_then(|info| info.height)),
        },
        GalleryItemType::Video(video) => GalleryItemView::Video {
            body: video.body.clone(),
            source: source(&video.source),
            mime: video.info.as_ref().and_then(|info| info.mimetype.clone()),
            width: dimension(video.info.as_ref().and_then(|info| info.width)),
            height: dimension(video.info.as_ref().and_then(|info| info.height)),
        },
        GalleryItemType::Audio(audio) => GalleryItemView::Audio {
            body: audio.body.clone(),
            source: source(&audio.source),
            mime: audio.info.as_ref().and_then(|info| info.mimetype.clone()),
        },
        GalleryItemType::File(file) => GalleryItemView::File {
            body: file.body.clone(),
            source: source(&file.source),
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
            if CALL_MEMBER_TYPES.contains(&event_type.as_str()) =>
        {
            let joined = in_call(content);
            // Moving between calls has no copy.
            if joined && in_call(prev_content) {
                return None;
            }
            Some(StateChangeView::CallMembership { joined })
        }
        _ => None,
    }
}

/// MSC3401 moved from an `application` key to a `memberships` array; both are
/// still in the wild.
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

const CALL_MEMBER_TYPES: [&str; 2] = ["m.call.member", "org.matrix.msc3401.call.member"];

fn message_content(
    message: &matrix_sdk_ui::timeline::Message,
    profile: Option<&PerMessageProfileView>,
) -> TimelineItemContentView {
    let dimension = |value: Option<UInt>| value.map(|value| i64::from(value).cast_unsigned());

    match message.msgtype() {
        MessageType::Image(image) => TimelineItemContentView::Image {
            body: image.body.clone(),
            source: serde_json::to_string(&image.source).unwrap_or_default(),
            mime: image.info.as_ref().and_then(|info| info.mimetype.clone()),
            width: dimension(image.info.as_ref().and_then(|info| info.width)),
            height: dimension(image.info.as_ref().and_then(|info| info.height)),
        },
        MessageType::Video(video) => TimelineItemContentView::Video {
            body: video.body.clone(),
            source: serde_json::to_string(&video.source).unwrap_or_default(),
            mime: video.info.as_ref().and_then(|info| info.mimetype.clone()),
            width: dimension(video.info.as_ref().and_then(|info| info.width)),
            height: dimension(video.info.as_ref().and_then(|info| info.height)),
        },
        MessageType::Audio(audio) => TimelineItemContentView::Audio {
            body: audio.body.clone(),
            source: serde_json::to_string(&audio.source).unwrap_or_default(),
            mime: audio.info.as_ref().and_then(|info| info.mimetype.clone()),
        },
        MessageType::File(file) => TimelineItemContentView::File {
            body: file.body.clone(),
            source: serde_json::to_string(&file.source).unwrap_or_default(),
            mime: file.info.as_ref().and_then(|info| info.mimetype.clone()),
        },
        MessageType::Location(location) => {
            let (latitude, longitude) = geo_coordinates(&location.geo_uri);
            TimelineItemContentView::Location {
                body: location.body.clone(),
                geo_uri: location.geo_uri.clone(),
                latitude,
                longitude,
            }
        }
        MessageType::Gallery(gallery) => TimelineItemContentView::Gallery {
            body: gallery.body.clone(),
            items: gallery.itemtypes.iter().filter_map(gallery_item).collect(),
        },
        _ => text_message(message, profile),
    }
}

fn content(
    content: &TimelineItemContent,
    profile: Option<&PerMessageProfileView>,
    raw: Option<&serde_json::Value>,
    prev_raw: Option<&serde_json::Value>,
    own_user_id: Option<&UserId>,
) -> TimelineItemContentView {
    let unsupported = |what: &str| TimelineItemContentView::Unsupported {
        description: what.to_owned(),
    };

    match content {
        TimelineItemContent::MsgLike(msg) => match &msg.kind {
            MsgLikeKind::Message(message) => message_content(message, profile),
            MsgLikeKind::Redacted => TimelineItemContentView::Redacted,
            MsgLikeKind::UnableToDecrypt(_) => TimelineItemContentView::UnableToDecrypt {
                reason: "undecryptable".to_owned(),
            },
            MsgLikeKind::Sticker(sticker) => {
                let sticker = sticker.content();
                TimelineItemContentView::Sticker {
                    body: sticker.body.clone(),
                    source: serde_json::to_string(&sticker.source).unwrap_or_default(),
                    mime: sticker.info.mimetype.clone(),
                    width: sticker
                        .info
                        .width
                        .map(|width| i64::from(width).cast_unsigned()),
                    height: sticker
                        .info
                        .height
                        .map(|height| i64::from(height).cast_unsigned()),
                }
            }
            MsgLikeKind::Poll(state) => TimelineItemContentView::Poll {
                poll: poll(state, own_user_id),
            },
            MsgLikeKind::LiveLocation(_) => unsupported("live location"),
            MsgLikeKind::Other(other) => TimelineItemContentView::HiddenEvent {
                event_type: other.event_type().to_string(),
                content: raw.cloned(),
            },
        },

        TimelineItemContent::MembershipChange(change) => TimelineItemContentView::Membership {
            user_id: change.user_id().to_owned(),
            change: membership_change(change.change()),
            display_name: change.display_name(),
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
            content: raw.cloned(),
            change: state_change(state, raw, prev_raw),
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{geo_coordinates, in_call, via_servers};

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
    fn reads_a_geo_uri_with_and_without_parameters() {
        assert_eq!(geo_coordinates("geo:51.5,-0.12"), (Some(51.5), Some(-0.12)));
        assert_eq!(
            geo_coordinates("geo:51.5,-0.12;u=35"),
            (Some(51.5), Some(-0.12))
        );
    }

    #[test]
    fn leaves_an_unreadable_geo_uri_without_coordinates() {
        assert_eq!(geo_coordinates("https://example.org/map"), (None, None));
        assert_eq!(geo_coordinates("geo:somewhere"), (None, None));
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
}
