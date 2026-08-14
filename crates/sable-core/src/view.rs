use std::collections::HashMap;
use std::hash::BuildHasher;
use std::sync::Arc;

use futures_util::{StreamExt, pin_mut};
use matrix_sdk::Client;
use matrix_sdk::deserialized_responses::SyncOrStrippedState;
use matrix_sdk::room::{ParentSpace, Room, RoomMember};
use matrix_sdk::ruma::OwnedRoomId;
use matrix_sdk::ruma::events::SyncStateEvent;
use matrix_sdk::ruma::events::room::message::MessageType;
use matrix_sdk::ruma::events::room::power_levels::UserPowerLevel;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::{EncryptionState, RoomState};
use matrix_sdk_ui::{
    eyeball_im,
    room_list_service::RoomListItem,
    timeline::{
        EventSendState, MsgLikeContent, MsgLikeKind, Profile, TimelineDetails, TimelineItem,
        TimelineItemContent, TimelineItemKind, VirtualTimelineItem,
    },
};

use matrix_sdk::latest_events::{LatestEventValue, LocalLatestEventValue, RemoteLatestEventValue};
use matrix_sdk::ruma::events::{
    AnyMessageLikeEventContent, AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
};

use crate::matrix_html::display_html;
use crate::protocol::{
    LatestEventView, MemberView, ReactionGroup, ReplyView, RoomStateView, RoomSummary,
    SendStateView, SpaceChildEdge, ThreadSummaryView, TimelineItemContentView, TimelineItemView,
    UploadProgressView, VectorDiff,
};

pub struct RoomInfo {
    pub is_space: bool,
    pub canonical_alias: Option<String>,
    pub parents: Vec<OwnedRoomId>,
    pub children: Vec<SpaceChildEdge>,
}

#[must_use]
pub fn room_summary<S: BuildHasher>(
    item: &RoomListItem,
    room_cache: &HashMap<OwnedRoomId, RoomInfo, S>,
) -> RoomSummary {
    let info = room_cache.get(item.room_id());
    RoomSummary {
        room_id: item.room_id().to_owned(),
        canonical_alias: info.and_then(|info| info.canonical_alias.clone()),
        // Only `display_name()` fills this cache, so `prime_display_names` must
        // have run. `name()` covers an explicit `m.room.name` until then.
        name: item
            .cached_display_name()
            .map(|name| name.to_string())
            .or_else(|| item.name()),
        avatar_url: item.avatar_url().map(|url| url.to_string()),
        is_direct: !item.direct_targets().is_empty(),
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
        space_parents: info.map(|i| i.parents.clone()).unwrap_or_default(),
        space_children: info.map(|i| i.children.clone()).unwrap_or_default(),
        unread: u32::try_from(item.num_unread_messages()).unwrap_or(u32::MAX),
        highlight: u32::try_from(item.num_unread_mentions()).unwrap_or(u32::MAX),
        latest_event: latest_event(item),
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
        }),

        LatestEventValue::RemoteInvite {
            timestamp, inviter, ..
        } => Some(LatestEventView {
            sender: inviter,
            body: "invited you".to_owned(),
            timestamp: Some(timestamp.0.into()),
            sending: false,
        }),

        // `LocalHasBeenSent` is accepted already. These two are pending.
        LatestEventValue::LocalIsSending(local) | LatestEventValue::LocalCannotBeSent(local) => {
            Some(LatestEventView {
                sender: None,
                body: local_preview(&local)?,
                timestamp: Some(local.timestamp.0.into()),
                sending: true,
            })
        }

        LatestEventValue::LocalHasBeenSent { value, .. } => Some(LatestEventView {
            sender: None,
            body: local_preview(&value)?,
            timestamp: Some(value.timestamp.0.into()),
            sending: false,
        }),
    }
}

/// Only `m.room.message` earns a preview.
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

/// `Room::parent_spaces` hits the state store, so this runs once per room per
/// subscription.
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
                let canonical_alias = room.canonical_alias().map(|alias| alias.to_string());

                let parents = match room.parent_spaces().await {
                    Ok(stream) => {
                        pin_mut!(stream);
                        stream
                            .filter_map(|result| async { result.ok() })
                            .map(|parent| match parent {
                                ParentSpace::Reciprocal(parent)
                                | ParentSpace::WithPowerlevel(parent)
                                | ParentSpace::Illegitimate(parent) => parent.room_id().to_owned(),
                                ParentSpace::Unverifiable(room_id) => room_id,
                            })
                            .collect()
                            .await
                    }
                    Err(_) => Vec::new(),
                };

                let children = if is_space {
                    space_children(&room).await
                } else {
                    Vec::new()
                };

                RoomInfo {
                    is_space,
                    canonical_alias,
                    parents,
                    children,
                }
            }
            None => RoomInfo {
                is_space: false,
                canonical_alias: None,
                parents: Vec::new(),
                children: Vec::new(),
            },
        };
        room_cache.insert(room_id.to_owned(), info);
    }
}

/// Sorted lexically on `order`, then oldest first; unordered entries sort last.
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
        });
    }

    children.sort_by(|a, b| {
        match (&a.order, &b.order) {
            (Some(left), Some(right)) => left.cmp(right),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
        .then_with(|| a.origin_server_ts.cmp(&b.origin_server_ts))
    });
    children
}

#[must_use]
pub fn timeline_item(item: &Arc<TimelineItem>) -> TimelineItemView {
    let id = item.unique_id().0.clone();

    match item.kind() {
        TimelineItemKind::Event(event) => {
            let profile = match event.sender_profile() {
                TimelineDetails::Ready(profile) => Some(profile),
                _ => None,
            };

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
                content: content(event.content()),
                in_reply_to: in_reply_to(event.content()),
                thread_root: msg_like(event.content()).and_then(|msg| msg.thread_root.clone()),
                thread_summary: thread_summary(event.content()),
                reactions: reactions(event.content()),
                is_own: event.is_own(),
                read_by: event.read_receipts().keys().cloned().collect(),
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

fn content(content: &TimelineItemContent) -> TimelineItemContentView {
    let unsupported = |what: &str| TimelineItemContentView::Unsupported {
        description: what.to_owned(),
    };

    match content {
        TimelineItemContent::MsgLike(msg) => match &msg.kind {
            MsgLikeKind::Message(message) => match message.msgtype() {
                MessageType::Image(image) => TimelineItemContentView::Image {
                    body: image.body.clone(),
                    source: serde_json::to_string(&image.source).unwrap_or_default(),
                    mime: image.info.as_ref().and_then(|info| info.mimetype.clone()),
                    width: image
                        .info
                        .as_ref()
                        .and_then(|info| info.width)
                        .map(|width| i64::from(width) as u64),
                    height: image
                        .info
                        .as_ref()
                        .and_then(|info| info.height)
                        .map(|height| i64::from(height) as u64),
                },
                MessageType::Video(video) => TimelineItemContentView::Video {
                    body: video.body.clone(),
                    source: serde_json::to_string(&video.source).unwrap_or_default(),
                    mime: video.info.as_ref().and_then(|info| info.mimetype.clone()),
                    width: video
                        .info
                        .as_ref()
                        .and_then(|info| info.width)
                        .map(|width| i64::from(width) as u64),
                    height: video
                        .info
                        .as_ref()
                        .and_then(|info| info.height)
                        .map(|height| i64::from(height) as u64),
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
                _ => TimelineItemContentView::Message {
                    body: message.body().to_owned(),
                    html: display_html(
                        message.body(),
                        formatted_body(message.msgtype()).as_deref(),
                    ),
                    emote: matches!(message.msgtype(), MessageType::Emote(_)),
                    edited: message.is_edited(),
                },
            },
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
                    width: sticker.info.width.map(|width| i64::from(width) as u64),
                    height: sticker.info.height.map(|height| i64::from(height) as u64),
                }
            }
            MsgLikeKind::Poll(_) => unsupported("poll"),
            MsgLikeKind::LiveLocation(_) => unsupported("live location"),
            MsgLikeKind::Other(_) => unsupported("message-like event"),
        },

        TimelineItemContent::MembershipChange(change) => TimelineItemContentView::Membership {
            user_id: change.user_id().to_owned(),
            change: format!("{:?}", change.change()),
        },

        TimelineItemContent::ProfileChange(_) => unsupported("profile change"),
        TimelineItemContent::OtherState(_) => unsupported("state event"),
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
        power_level: match member.power_level() {
            UserPowerLevel::Int(level) => i32::try_from(level).unwrap_or_else(|_| {
                if level.is_negative() {
                    i32::MIN
                } else {
                    i32::MAX
                }
            }),
            _ => i32::MAX,
        },
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
