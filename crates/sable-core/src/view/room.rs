use std::collections::HashMap;
use std::hash::BuildHasher;

use matrix_sdk::EncryptionState;
use matrix_sdk::deserialized_responses::RawAnySyncOrStrippedState;
use matrix_sdk::latest_events::{LatestEventValue, LocalLatestEventValue, RemoteLatestEventValue};
use matrix_sdk::room::{Room, RoomMember};
use matrix_sdk::ruma::events::room::avatar::RoomAvatarEventContent;
use matrix_sdk::ruma::events::room::join_rules::JoinRule;
use matrix_sdk::ruma::events::room::member::MembershipState;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::events::room::topic::PossiblyRedactedRoomTopicEventContent;
use matrix_sdk::ruma::events::sticker::StickerEventContent;
use matrix_sdk::ruma::events::{
    AnyMessageLikeEventContent, AnySyncMessageLikeEvent, AnySyncTimelineEvent, StateEventType,
    SyncMessageLikeEvent,
};
use matrix_sdk::ruma::push::Ruleset;
use matrix_sdk::ruma::{EventId, OwnedMxcUri, OwnedRoomId, OwnedUserId, RoomId};
use matrix_sdk_ui::{eyeball_im, room_list_service::RoomListItem};

use crate::api::rooms::RoomKind;
use crate::protocol::{
    BridgeView, LatestEventView, NotificationModeView, NotificationSettingsView,
    PredecessorRoomView, RoomJoinRuleView, RoomListItemView, RoomTag, RoomUnreadView,
    SpaceChildEdge,
};

use super::diff::diff_values;
use super::space::{kept_children, space_children};

// Independent room capabilities.
#[expect(
    clippy::struct_excessive_bools,
    reason = "wire type mirroring the protocol"
)]
pub struct RoomInfo {
    pub room_kind: Option<RoomKind>,
    pub is_direct: bool,
    pub is_tombstoned: bool,
    pub supports_knock: bool,
    pub supports_restricted: bool,
    pub supports_knock_restricted: bool,
    pub canonical_alias: Option<String>,
    pub avatar_url: Option<String>,
    /// `None` for direct rooms, whose avatar can change through a member.
    pub avatar_source: Option<AvatarSource>,
    pub direct_name: Option<String>,
    pub children: Vec<SpaceChildEdge>,
    /// The last read of `children` failed, so they are the previous ones.
    pub children_stale: bool,
    pub tags: Vec<RoomTag>,
    pub screen_sharers: Vec<OwnedUserId>,
    pub avatar_override: Option<String>,
    /// Read once per row, as a bridge sets it when it creates the room.
    pub bridge: Option<BridgeView>,
}

pub(crate) fn apply_avatar_override(view: &mut RoomListItemView, info: Option<&RoomInfo>) {
    if let Some(url) = info.and_then(|info| info.avatar_override.as_ref()) {
        view.display_avatar_url = Some(url.clone());
    }
}

#[must_use]
pub fn room_list_item<S: BuildHasher>(
    item: &RoomListItem,
    room_cache: &HashMap<OwnedRoomId, RoomInfo, S>,
    rules: &Ruleset,
    nicknames: &crate::nicknames::Nicknames,
) -> RoomListItemView {
    let info = room_cache.get(item.room_id());
    let latest_event = latest_event(item);
    let latest_event_id = latest_event
        .as_ref()
        .and_then(|event| event.event_id.as_deref());
    let every_encrypted = crate::push_rules::pushes_every_encrypted_event(rules);
    let (unread, highlight) = unread_counts(item, latest_event_id, every_encrypted);
    let notifying = notifying_count(item, latest_event_id, every_encrypted);
    let marked_unread = item.is_marked_unread();
    let notification = crate::push_rules::room_settings(
        rules,
        item.room_id(),
        crate::notifications::uses_direct_push_rules(item),
    );
    let mut view = RoomListItemView {
        room_id: item.room_id().to_owned(),
        canonical_alias: info.and_then(|info| info.canonical_alias.clone()),
        name: item
            .name()
            .or_else(|| info.and_then(|info| info.direct_name.clone()))
            .or_else(|| item.cached_display_name().map(|name| name.to_string())),
        topic: item.topic(),
        topic_html: item.topic_content().as_ref().and_then(topic_html),
        avatar_url: info.map_or_else(
            || item.avatar_url().map(|url| url.to_string()),
            |info| info.avatar_url.clone(),
        ),
        is_direct: info.map_or_else(|| !item.direct_targets().is_empty(), |info| info.is_direct),
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
        state: item.state().into(),
        is_tombstoned: info.is_some_and(|i| i.is_tombstoned),
        room_kind: RoomKind::from_room_type(item.room_type().as_ref()),
        call_participants: item.active_room_call_participants(),
        screen_sharers: info.map(|i| i.screen_sharers.clone()).unwrap_or_default(),
        supports_knock: info.is_some_and(|i| i.supports_knock),
        supports_restricted: info.is_some_and(|i| i.supports_restricted),
        supports_knock_restricted: info.is_some_and(|i| i.supports_knock_restricted),
        space_children: info.map(|i| i.children.clone()).unwrap_or_default(),
        bridge: info.and_then(|i| i.bridge.clone()),
        unread,
        notifying,
        highlight,
        marked_unread,
        notification,
        counts: room_counts(notification, unread, notifying, highlight, marked_unread),
        latest_event,
        display_name: String::new(),
        display_avatar_url: None,
    };
    nicknames.apply_room(&mut view);
    apply_avatar_override(&mut view, info);
    view
}

/// What a room's counts show under its mode: only `mute` clears them, and a
/// mention always counts as unread and as notified.
#[must_use]
pub const fn room_counts(
    notification: NotificationSettingsView,
    unread: u32,
    notifying: u32,
    highlight: u32,
    marked: bool,
) -> RoomUnreadView {
    let mode = match notification.room {
        Some(mode) => mode,
        None => notification.default,
    };
    if matches!(mode, NotificationModeView::Mute) {
        return RoomUnreadView {
            unread: 0,
            notifying: 0,
            highlight: 0,
            marked,
        };
    }
    RoomUnreadView {
        unread: if unread > highlight {
            unread
        } else {
            highlight
        },
        notifying: if notifying > highlight {
            notifying
        } else {
            highlight
        },
        highlight,
        marked,
    }
}

pub(crate) fn unread_counts(
    item: &RoomListItem,
    latest_event_id: Option<&EventId>,
    every_encrypted: bool,
) -> (u32, u32) {
    let count = |value: u64| u32::try_from(value).unwrap_or(u32::MAX);
    let counts = item.unread_notification_counts();
    let server = (
        count(counts.notification_count),
        count(counts.highlight_count),
    );

    let Some(receipt) = item.read_receipts().latest_active else {
        return server;
    };

    let local = (
        count(item.num_unread_messages()),
        count(item.num_unread_mentions()),
    );

    if latest_event_id == Some(&*receipt.event_id) {
        return local;
    }

    if item.encryption_state().is_encrypted() {
        let unread = if every_encrypted {
            local.0
        } else {
            local.0.max(server.0)
        };
        (unread, local.1)
    } else {
        (local.0.max(server.0), local.1.max(server.1))
    }
}

pub(crate) fn notifying_count(
    item: &RoomListItem,
    latest_event_id: Option<&EventId>,
    every_encrypted: bool,
) -> u32 {
    let count = |value: u64| u32::try_from(value).unwrap_or(u32::MAX);
    let server = count(item.unread_notification_counts().notification_count);

    let Some(receipt) = item.read_receipts().latest_active else {
        return server;
    };

    let local = count(item.num_unread_notifications());
    if latest_event_id == Some(&*receipt.event_id)
        || (every_encrypted && item.encryption_state().is_encrypted())
    {
        local
    } else {
        local.max(server)
    }
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
pub(super) fn latest_event(item: &RoomListItem) -> Option<LatestEventView> {
    match item.latest_event() {
        LatestEventValue::None => None,

        LatestEventValue::Remote(event) => Some(LatestEventView {
            sender: event.sender(),
            body: remote_preview(&event).unwrap_or_default(),
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
                body: local_preview(&local).unwrap_or_default(),
                timestamp: Some(local.timestamp.0.into()),
                sending: true,
                event_id: None,
            })
        }

        LatestEventValue::LocalHasBeenSent { value, event_id } => Some(LatestEventView {
            sender: None,
            body: local_preview(&value).unwrap_or_default(),
            timestamp: Some(value.timestamp.0.into()),
            sending: false,
            event_id: Some(event_id),
        }),
    }
}

fn remote_preview(event: &RemoteLatestEventValue) -> Option<String> {
    if let Ok(raw) = serde_json::from_str::<serde_json::Value>(event.raw().json().get())
        && let Some(preview) = forwarded_room_preview(&raw)
    {
        return Some(preview);
    }
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
    let (raw, _) = local.content.raw();
    if let Ok(raw) = serde_json::from_str::<serde_json::Value>(raw.json().get())
        && let Some(preview) = forwarded_room_preview(&raw)
    {
        return Some(preview);
    }
    let content = local.content.deserialize().ok()?;

    match content {
        AnyMessageLikeEventContent::RoomMessage(message) => Some(message.body().to_owned()),
        _ => None,
    }
}

fn forwarded_room_preview(event: &serde_json::Value) -> Option<String> {
    let content = event.get("content").unwrap_or(event);
    let forwarded = content
        .get("org.matrix.msc4553.forwarded")?
        .get("content")?
        .clone();
    if let Ok(message) = serde_json::from_value::<RoomMessageEventContent>(forwarded.clone()) {
        return Some(message.msgtype.body().to_owned());
    }
    serde_json::from_value::<StickerEventContent>(forwarded)
        .ok()
        .map(|sticker| sticker.body)
}

/// Resolve current room fields for every emitted item, including reordered rooms.
pub async fn enrich_room_batch<S: BuildHasher>(
    diffs: &[eyeball_im::VectorDiff<RoomListItem>],
    room_cache: &mut HashMap<OwnedRoomId, RoomInfo, S>,
) {
    enrich_rooms(latest_items(diffs), room_cache).await;
}

#[tracing::instrument(skip_all, target = "sable_core::tasks", name = "view.enrich_rooms")]
pub(crate) async fn enrich_rooms<'a, S: BuildHasher>(
    rooms: impl IntoIterator<Item = &'a RoomListItem>,
    room_cache: &mut HashMap<OwnedRoomId, RoomInfo, S>,
) {
    let lookups = rooms.into_iter().map(|item| {
        let previous = room_cache.get(item.room_id());
        async move { (item.room_id().to_owned(), room_info(item, previous).await) }
    });

    for (room_id, info) in futures_util::future::join_all(lookups).await {
        room_cache.insert(room_id, info);
    }
}

pub(super) fn latest_items(diffs: &[eyeball_im::VectorDiff<RoomListItem>]) -> Vec<&RoomListItem> {
    let mut latest: HashMap<&RoomId, &RoomListItem> = HashMap::new();
    for item in diffs.iter().flat_map(diff_values) {
        latest.insert(item.room_id(), item);
    }
    latest.into_values().collect()
}

pub async fn listless_room_list_item(
    room: Room,
    rules: &Ruleset,
    nicknames: &crate::nicknames::Nicknames,
) -> RoomListItemView {
    if room.cached_display_name().is_none() {
        let _ = room.display_name().await;
    }
    let item = RoomListItem::from(room);
    let cache = HashMap::from([(item.room_id().to_owned(), room_info(&item, None).await)]);
    room_list_item(&item, &cache, rules, nicknames)
}

#[must_use]
pub fn predecessor(room: &Room) -> Option<PredecessorRoomView> {
    let predecessor = room.predecessor_room()?;
    let mut via = Vec::new();
    for creator in room.creators().unwrap_or_default() {
        let server = creator.server_name().to_string();
        if !via.contains(&server) {
            via.push(server);
        }
    }
    Some(PredecessorRoomView {
        room_id: predecessor.room_id,
        via,
    })
}

/// The stable type first, then the name bridges used before MSC2346.
const BRIDGE_EVENT_TYPES: [&str; 2] = ["m.bridge", "uk.half-shot.bridge"];

fn bridge_view(event: &str) -> Option<BridgeView> {
    let event: serde_json::Value = serde_json::from_str(event).ok()?;
    let content = event.get("content")?;
    let text = |section: &str, key: &str| {
        content
            .get(section)?
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let avatar =
        |section: &str| text(section, "avatar_url").filter(|url| url.starts_with("mxc://"));
    Some(BridgeView {
        network: text("protocol", "displayname")
            .or_else(|| text("protocol", "id"))?
            .to_owned(),
        avatar_url: avatar("protocol")
            .or_else(|| avatar("network"))
            .map(str::to_owned),
    })
}

async fn room_bridge(room: &Room) -> Option<BridgeView> {
    for event_type in BRIDGE_EVENT_TYPES {
        let Ok(events) = room
            .get_state_events(StateEventType::from(event_type))
            .await
        else {
            continue;
        };
        if let Some(bridge) = events.iter().find_map(|event| {
            let json = match event {
                RawAnySyncOrStrippedState::Sync(raw) => raw.json(),
                RawAnySyncOrStrippedState::Stripped(raw) => raw.json(),
            };
            bridge_view(json.get())
        }) {
            return Some(bridge);
        }
    }
    None
}

async fn room_info(room: &Room, previous: Option<&RoomInfo>) -> RoomInfo {
    let room_kind = RoomKind::from_room_type(room.room_type().as_ref());
    let is_tombstoned = room.is_tombstoned();
    let children = async {
        if room_kind == Some(RoomKind::Space) {
            kept_children(space_children(room).await, previous, room.room_id())
        } else {
            (Vec::new(), false)
        }
    };

    let ((children, children_stale), is_direct) =
        futures_util::future::join(children, is_direct(room)).await;
    let (supports_knock, supports_restricted, supports_knock_restricted) =
        crate::rooms::join_rule_support(room);
    let direct_name = if room.name().is_none() {
        direct_peer_name(room).await
    } else {
        None
    };
    let avatar_source = AvatarSource::of(room);
    let avatar_override = if room_kind == Some(RoomKind::Space) {
        crate::spaces::avatar_override(room)
            .await
            .unwrap_or_else(|()| previous.and_then(|info| info.avatar_override.clone()))
    } else {
        None
    };
    let avatar_url = match (previous, &avatar_source) {
        (Some(previous), Some(source)) if previous.avatar_source.as_ref() == Some(source) => {
            previous.avatar_url.clone()
        }
        _ => room_avatar_url(room).await,
    };

    RoomInfo {
        room_kind,
        is_direct,
        is_tombstoned,
        supports_knock,
        supports_restricted,
        supports_knock_restricted,
        canonical_alias: room.canonical_alias().map(|alias| alias.to_string()),
        avatar_url,
        avatar_source,
        direct_name,
        children,
        children_stale,
        tags: room_tags(room),
        bridge: match previous {
            Some(previous) => previous.bridge.clone(),
            None => room_bridge(room).await,
        },
        screen_sharers: if room.is_call() {
            crate::calls::screen_sharers(room).await
        } else {
            Vec::new()
        },
        avatar_override,
    }
}

/// The in-memory inputs of `room_avatar_url`, which reads the store.
#[derive(Clone, PartialEq, Eq)]
pub struct AvatarSource {
    avatar_url: Option<OwnedMxcUri>,
    state: matrix_sdk::RoomState,
}

impl AvatarSource {
    fn of(room: &Room) -> Option<Self> {
        room.direct_targets().is_empty().then(|| Self {
            avatar_url: room.avatar_url(),
            state: room.state(),
        })
    }
}

async fn room_avatar_url(room: &Room) -> Option<String> {
    let avatar = if let Ok(Some(event)) = room
        .get_state_event_static::<RoomAvatarEventContent>()
        .await
        && let Ok(event) = event.deserialize()
    {
        // Sliding-sync metadata can retain an old URL after the state event clears it.
        event
            .original_content()
            .and_then(|content| content.url.clone())
    } else {
        room.avatar_url()
            .filter(|_| room.state() != matrix_sdk::RoomState::Joined)
    };

    match avatar {
        Some(url) => Some(url.to_string()),
        None => direct_avatar_url(room).await,
    }
}

async fn direct_peer(room: &Room) -> Option<RoomMember> {
    let service_members = room.service_members().unwrap_or_default();
    let targets: Vec<OwnedUserId> = room
        .direct_targets()
        .iter()
        .filter_map(|target| OwnedUserId::try_from(target.as_str()).ok())
        .filter(|target| target != room.own_user_id() && !service_members.contains(target))
        .collect();
    let [target] = targets.as_slice() else {
        return None;
    };
    room.get_member_no_sync(target)
        .await
        .ok()
        .flatten()
        .filter(|member| {
            matches!(
                member.membership(),
                MembershipState::Join | MembershipState::Invite
            )
        })
}

pub(crate) async fn direct_peer_name(room: &Room) -> Option<String> {
    direct_peer(room)
        .await
        .map(|member| member.name().to_owned())
}

/// Use synced profiles only: rendering the room list must not fetch members.
async fn direct_avatar_url(room: &Room) -> Option<String> {
    if room.direct_targets().is_empty() {
        return None;
    }
    if let Some(avatar) = direct_peer(room)
        .await
        .and_then(|member| member.avatar_url().map(ToString::to_string))
    {
        return Some(avatar);
    }
    // Sliding sync can supply a hero's picture before their member event.
    let heroes = room.heroes().await;
    if let [hero] = heroes.as_slice()
        && hero.user_id != room.own_user_id()
    {
        return hero.avatar_url.as_ref().map(ToString::to_string);
    }
    None
}

async fn is_direct(room: &Room) -> bool {
    room.is_direct().await.unwrap_or(false)
}

/// The tag a row shows is one the SDK keeps as a notable flag on cached room
/// info, so this reads memory where `Room::tags` reads the store.
fn room_tags(room: &Room) -> Vec<RoomTag> {
    let mut tags = Vec::new();
    if room.is_favourite() {
        tags.push(RoomTag::Favourite);
    }
    tags
}

fn topic_html(content: &PossiblyRedactedRoomTopicEventContent) -> Option<String> {
    let html = content.topic_block.text.find_html()?;
    Some(crate::matrix_html::display_html(
        content.topic.as_deref().unwrap_or_default(),
        Some(html),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::protocol::{NotificationModeView, NotificationSettingsView};

    #[test]
    fn a_bridge_names_its_network_and_only_an_mxc_avatar() {
        let event = |protocol: serde_json::Value| {
            serde_json::json!({"type": "m.bridge", "content": {"protocol": protocol}}).to_string()
        };
        assert_eq!(
            bridge_view(&event(serde_json::json!({
                "id": "discord",
                "displayname": "Discord",
                "avatar_url": "mxc://example.org/discord"
            }))),
            Some(BridgeView {
                network: "Discord".to_owned(),
                avatar_url: Some("mxc://example.org/discord".to_owned()),
            })
        );
        assert_eq!(
            bridge_view(&event(serde_json::json!({
                "id": "whatsapp",
                "avatar_url": "https://example.org/logo.png"
            }))),
            Some(BridgeView {
                network: "whatsapp".to_owned(),
                avatar_url: None,
            })
        );
        assert_eq!(
            bridge_view(&event(serde_json::json!({"displayname": " "}))),
            None
        );
        assert_eq!(bridge_view(r#"{"type":"m.bridge","content":{}}"#), None);
    }

    #[test]
    fn a_bridge_without_a_protocol_image_borrows_the_network_one() {
        let event = serde_json::json!({"type": "m.bridge", "content": {
            "protocol": {"id": "discord", "avatar_url": "https://example.org/logo.png"},
            "network": {"id": "1234", "avatar_url": "mxc://example.org/guild"}
        }});
        assert_eq!(
            bridge_view(&event.to_string()),
            Some(BridgeView {
                network: "discord".to_owned(),
                avatar_url: Some("mxc://example.org/guild".to_owned()),
            })
        );
    }

    #[test]
    fn a_room_preview_uses_valid_forwarded_content() {
        assert_eq!(
            forwarded_room_preview(&serde_json::json!({
                "msgtype": "m.text",
                "body": "Forwarded message\nfallback",
                "org.matrix.msc4553.forwarded": {
                    "content": { "msgtype": "m.text", "body": "original" }
                }
            })),
            Some("original".to_owned())
        );
    }

    const fn under(mode: NotificationModeView) -> NotificationSettingsView {
        NotificationSettingsView {
            room: Some(mode),
            default: NotificationModeView::Mentions,
        }
    }

    #[test]
    fn the_agreed_badge_matrix() {
        use NotificationModeView::{All, Mentions, Mute};
        for (mode, (unread, notifying, highlight), shown) in [
            (All, (6, 6, 0), (6, 6)),
            (All, (9, 9, 2), (9, 9)),
            (All, (6, 0, 0), (6, 0)),
            (Mentions, (6, 0, 0), (6, 0)),
            (Mentions, (9, 2, 2), (9, 2)),
            (Mentions, (9, 1, 0), (9, 1)),
            (All, (0, 0, 3), (3, 3)),
            (Mute, (9, 9, 2), (0, 0)),
        ] {
            let counts = room_counts(under(mode), unread, notifying, highlight, false);
            assert_eq!(
                (counts.unread, counts.notifying),
                shown,
                "{mode:?} {unread} {notifying} {highlight}"
            );
        }
    }

    #[test]
    fn a_room_with_no_rule_of_its_own_follows_its_default() {
        let muted_by_default = NotificationSettingsView {
            room: None,
            default: NotificationModeView::Mute,
        };
        assert_eq!(room_counts(muted_by_default, 4, 4, 1, false).unread, 0);
    }

    #[test]
    fn a_manual_mark_survives_a_mute() {
        let counts = room_counts(under(NotificationModeView::Mute), 0, 0, 0, true);
        assert!(counts.marked);
        assert_eq!(counts.highlight, 0);
    }
}
