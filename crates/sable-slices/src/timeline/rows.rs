//! From the core's items to the rows a UI draws: what the reader's filters
//! leave, hidden events merged in, the unread marker placed, runs of
//! membership events grouped and each row keyed.

use std::collections::{BTreeMap, HashSet};

use sable_model::timeline::{GroupItem, GroupProfile, TimelineReplyStyleView, collapsed};
use sable_protocol::{
    MembershipChangeView, MentionView, StateChangeView, TimelineItemContentView, TimelineItemView,
    TimelineRowKind, TimelineVisibility,
};

use super::{
    identity::Identity,
    receipts,
    view::{
        Shared, TimelineFiltersView, TimelineGroupMember, TimelineMemberCategoryView, TimelineRow,
        TimelineSegmentView, TimelineSubjectView,
    },
};

const DAY_MS: i64 = 86_400_000;

#[expect(
    clippy::struct_excessive_bools,
    reason = "each flag is one of the reader's or the timeline's independent states"
)]
pub struct RowsInput<'a> {
    pub items: &'a [Shared],
    pub aggregations: &'a [Shared],
    pub filters: &'a TimelineFiltersView,
    pub reply_style: TimelineReplyStyleView,
    pub read_only: bool,
    /// The history above has all been loaded.
    pub start_loaded: bool,
    /// The newest events are loaded.
    pub end_loaded: bool,
    /// The first unread event, where the unread marker goes.
    pub unread_event_id: Option<&'a str>,
    /// Drops the core's own read marker, once the reader has caught up with it.
    pub hide_read_marker: bool,
    pub thread_root: Option<&'a str>,
    pub utc_offset_ms: i64,
}

/// What the reader's filters leave of the core's items, and the rows made of them.
pub struct Rows {
    /// Without the hidden-event aggregations, which is where unread counts come from.
    pub event_items: Vec<Shared>,
    pub rows: Vec<TimelineRow>,
}

#[must_use]
#[expect(
    clippy::indexing_slicing,
    reason = "identity keys and receipt entries are indexed by the same source items"
)]
pub fn build(input: &RowsInput<'_>, identity: &mut Identity) -> Rows {
    let event_items = visible_timeline_items(input.items, input.filters, input.read_only);
    let reply_targets: HashSet<&str> = event_items
        .iter()
        .filter(|item| reply_target(item, input.filters.show_hidden_events))
        .filter_map(|item| item.event_id.as_ref().map(|id| id.as_str()))
        .collect();
    let can_reply = |item: &Shared| {
        item.event_id
            .as_deref()
            .is_some_and(|id| reply_targets.contains(id.as_str()))
    };
    let aggregations = visible_aggregations(input.aggregations, input.filters);
    let all = merge_aggregations(
        &event_items,
        &aggregations,
        input.start_loaded,
        input.end_loaded,
        input.utc_offset_ms,
    );
    let visible = match input.unread_event_id {
        Some(event_id) => with_read_marker_before(&all, event_id),
        None if input.hide_read_marker => all
            .into_iter()
            .filter(|item| !matches!(item.content, TimelineItemContentView::ReadMarker))
            .collect(),
        None => all,
    };

    identity.reconcile(&visible);
    let keys = identity.keys(&visible);
    let later_receipts = receipts::later(&visible);
    let units = group_member_events(&visible);
    let unit_items: Vec<&Shared> = units.iter().map(|unit| &unit.item).collect();
    let rows = units
        .iter()
        .enumerate()
        .map(|(index, unit)| {
            let previous = index
                .checked_sub(1)
                .and_then(|before| unit_items.get(before));
            let holds_thread_root = input.thread_root.is_some_and(|root| {
                event_id_is(&unit.item, root)
                    || previous.is_some_and(|previous| event_id_is(previous, root))
            });
            let collapsed =
                !holds_thread_root && is_collapsed(&unit_items, index, input.reply_style);
            TimelineRow {
                reply_target: can_reply(&unit.item),
                key: keys[unit.source].clone(),
                item: unit.item.clone(),
                group: unit.group.as_ref().map(|members| {
                    members
                        .iter()
                        .map(|member| TimelineGroupMember {
                            reply_target: can_reply(member),
                            item: member.clone(),
                        })
                        .collect()
                }),
                segments: unit.group.as_deref().map(segments).unwrap_or_default(),
                collapsed,
                group_start: index > 0 && !collapsed,
                unread_count: if matches!(unit.item.content, TimelineItemContentView::ReadMarker) {
                    unread_count_from(&visible, unit.source + 1)
                } else {
                    0
                },
                later_receipts: later_receipts[unit.source].clone(),
            }
        })
        .collect();
    Rows { event_items, rows }
}

fn event_id_is(item: &TimelineItemView, event_id: &str) -> bool {
    item.event_id
        .as_ref()
        .is_some_and(|candidate| candidate.as_str() == event_id)
}

const fn is_topic_change(item: &TimelineItemView) -> bool {
    matches!(
        &item.content,
        TimelineItemContentView::StateEvent {
            change: Some(StateChangeView::RoomTopic { .. }),
            ..
        }
    )
}

const fn is_visible_event(
    item: &TimelineItemView,
    filters: &TimelineFiltersView,
    read_only: bool,
) -> bool {
    let member_events_hidden = read_only && filters.hide_member_in_read_only;
    match item.visibility {
        TimelineVisibility::Membership => !filters.hide_membership_events && !member_events_hidden,
        TimelineVisibility::MembershipOther => {
            !filters.hide_membership_events && !member_events_hidden && filters.show_hidden_events
        }
        TimelineVisibility::ProfileChange => !filters.hide_profile_changes && !member_events_hidden,
        TimelineVisibility::Tombstone => filters.show_tombstone_events,
        TimelineVisibility::Hidden => filters.show_hidden_events && filters.hidden_event_other,
        TimelineVisibility::Always => !(filters.hide_topic_changes && is_topic_change(item)),
    }
}

#[must_use]
pub fn visible_aggregations(aggregations: &[Shared], filters: &TimelineFiltersView) -> Vec<Shared> {
    if !filters.show_hidden_events {
        return Vec::new();
    }
    aggregations
        .iter()
        .filter(|item| match &item.content {
            TimelineItemContentView::HiddenEvent { event_type, .. } => match event_type.as_str() {
                "m.reaction" => filters.hidden_event_reactions,
                "m.room.redaction" => filters.hidden_event_redactions,
                "m.room.message" => filters.hidden_event_edits,
                _ => filters.hidden_event_other,
            },
            _ => true,
        })
        .cloned()
        .collect()
}

fn timestamp(item: &TimelineItemView) -> i64 {
    i64::try_from(item.timestamp).unwrap_or(i64::MAX)
}

const fn start_of_day(timestamp: i64, utc_offset_ms: i64) -> i64 {
    timestamp - (timestamp + utc_offset_ms).rem_euclid(DAY_MS)
}

#[must_use]
pub fn merge_aggregations(
    items: &[Shared],
    aggregations: &[Shared],
    start_loaded: bool,
    end_loaded: bool,
    utc_offset_ms: i64,
) -> Vec<Shared> {
    if aggregations.is_empty() {
        return items.to_vec();
    }
    let mut events = items.iter().filter(|item| item.event_id.is_some());
    let oldest = if start_loaded {
        i64::MIN
    } else {
        events.next().map_or(i64::MAX, |item| timestamp(item))
    };
    let newest = if end_loaded {
        i64::MAX
    } else {
        items
            .iter()
            .rev()
            .find(|item| item.event_id.is_some())
            .map_or(i64::MIN, |item| timestamp(item))
    };
    let known: HashSet<&str> = items.iter().map(|item| item.id.as_str()).collect();
    let mut pending: Vec<&Shared> = aggregations
        .iter()
        .filter(|item| {
            let at = timestamp(item);
            !known.contains(item.id.as_str()) && at >= oldest && at <= newest
        })
        .collect();
    pending.sort_by_key(|item| timestamp(item));
    if pending.is_empty() {
        return items.to_vec();
    }

    let mut merged = Vec::with_capacity(items.len() + pending.len());
    let mut next = 0;
    for item in items {
        let divider = matches!(item.content, TimelineItemContentView::DateDivider { .. });
        let boundary = if divider {
            start_of_day(timestamp(item), utc_offset_ms)
        } else {
            timestamp(item)
        };
        while let Some(held) = pending.get(next) {
            let at = timestamp(held);
            if if divider {
                at < boundary
            } else {
                at <= boundary
            } {
                merged.push((*held).clone());
                next += 1;
            } else {
                break;
            }
        }
        merged.push(item.clone());
    }
    merged.extend(pending.iter().skip(next).map(|item| (*item).clone()));
    merged
}

#[must_use]
pub fn visible_timeline_items(
    items: &[Shared],
    filters: &TimelineFiltersView,
    read_only: bool,
) -> Vec<Shared> {
    let mut shown: HashSet<&str> = HashSet::with_capacity(items.len());
    let mut kept: Vec<Shared> = Vec::with_capacity(items.len());
    let mut last_event: Option<usize> = None;
    for item in items {
        if let Some(event_id) = &item.event_id
            && !shown.insert(event_id.as_str())
        {
            continue;
        }
        if is_visible_event(item, filters, read_only) {
            kept.push(item.clone());
            if item.event_id.is_some() {
                last_event = Some(kept.len() - 1);
            }
        } else if !item.read_by.is_empty()
            && let Some(holder) = last_event.and_then(|at| kept.get_mut(at))
        {
            let mut merged = holder.edited();
            merged.read_by.extend(item.read_by.iter().cloned());
            merged.read_timestamps.extend(
                item.read_timestamps
                    .iter()
                    .map(|(user, at)| (user.clone(), *at)),
            );
            *holder = Shared::new(merged);
        }
    }

    let mut visible: Vec<Shared> = Vec::with_capacity(kept.len());
    let mut has_event_below = false;
    let mut has_unread_below = false;
    for item in kept.into_iter().rev() {
        match &item.content {
            TimelineItemContentView::DateDivider { .. } => {
                if !has_event_below {
                    continue;
                }
                has_event_below = false;
            }
            TimelineItemContentView::ReadMarker => {
                if !has_unread_below {
                    continue;
                }
            }
            _ if item.row == TimelineRowKind::Annotation => {}
            content => {
                has_event_below = true;
                if !item.is_own && is_unread_kind(content) {
                    has_unread_below = true;
                }
            }
        }
        visible.push(item);
    }
    visible.reverse();
    visible
}

const fn is_unread_kind(content: &TimelineItemContentView) -> bool {
    matches!(
        content,
        TimelineItemContentView::Message { .. }
            | TimelineItemContentView::Image { .. }
            | TimelineItemContentView::Video { .. }
            | TimelineItemContentView::Audio { .. }
            | TimelineItemContentView::File { .. }
            | TimelineItemContentView::Sticker { .. }
            | TimelineItemContentView::Gallery { .. }
            | TimelineItemContentView::Location { .. }
            | TimelineItemContentView::LiveLocation { .. }
            | TimelineItemContentView::Poll { .. }
            | TimelineItemContentView::UnableToDecrypt { .. }
    )
}

#[must_use]
pub const fn is_unread_message(item: &TimelineItemView) -> bool {
    item.event_id.is_some() && !item.is_own && is_unread_kind(&item.content)
}

/// Messages from someone else from `start` on.
#[must_use]
pub fn unread_count_from(items: &[Shared], start: usize) -> u32 {
    let count = items
        .iter()
        .skip(start)
        .filter(|item| !item.is_own && is_unread_kind(&item.content))
        .count();
    u32::try_from(count).unwrap_or(u32::MAX)
}

#[must_use]
pub fn latest_event_id(items: &[Shared]) -> Option<String> {
    items
        .iter()
        .rev()
        .find_map(|item| item.event_id.as_ref().map(ToString::to_string))
}

fn read_marker_item() -> TimelineItemView {
    TimelineItemView {
        id: "unread-marker".to_owned(),
        row: TimelineRowKind::Annotation,
        forwardable: false,
        redactable: false,
        visibility: TimelineVisibility::Always,
        event_id: None,
        transaction_id: None,
        send_state: None,
        sender: None,
        sender_name: None,
        sender_avatar: None,
        timestamp: 0,
        content: TimelineItemContentView::ReadMarker,
        in_reply_to: None,
        thread_root: None,
        thread_summary: None,
        reactions: Vec::new(),
        is_own: false,
        read_by: Vec::new(),
        read_timestamps: BTreeMap::new(),
        per_message_profile: None,
        bundled_link_previews: Vec::new(),
        link_previews_removed: None,
        mention: MentionView::None,
        forwarded: None,
        forum_title: None,
    }
}

#[must_use]
pub fn with_read_marker_before(items: &[Shared], event_id: &str) -> Vec<Shared> {
    let rest: Vec<Shared> = items
        .iter()
        .filter(|item| !matches!(item.content, TimelineItemContentView::ReadMarker))
        .cloned()
        .collect();
    let Some(index) = rest.iter().position(|item| event_id_is(item, event_id)) else {
        return rest;
    };
    let marker = items
        .iter()
        .find(|item| matches!(item.content, TimelineItemContentView::ReadMarker))
        .cloned()
        .unwrap_or_else(|| Shared::new(read_marker_item()));
    let mut with_marker = Vec::with_capacity(rest.len() + 1);
    with_marker.extend(rest.iter().take(index).cloned());
    with_marker.push(marker);
    with_marker.extend(rest.iter().skip(index).cloned());
    with_marker
}

const fn member_category(item: &TimelineItemView) -> Option<TimelineMemberCategoryView> {
    if item.event_id.is_none() || !item.reactions.is_empty() {
        return None;
    }
    match &item.content {
        TimelineItemContentView::Membership { change, .. } => match change {
            MembershipChangeView::Joined | MembershipChangeView::InvitationAccepted => {
                Some(TimelineMemberCategoryView::Joined)
            }
            MembershipChangeView::Left => Some(TimelineMemberCategoryView::Left),
            MembershipChangeView::Invited => Some(TimelineMemberCategoryView::Invited),
            MembershipChangeView::InvitationRejected => {
                Some(TimelineMemberCategoryView::InvitationRejected)
            }
            MembershipChangeView::Knocked => Some(TimelineMemberCategoryView::Knocked),
            MembershipChangeView::KnockRetracted => {
                Some(TimelineMemberCategoryView::KnockRetracted)
            }
            MembershipChangeView::Other => Some(TimelineMemberCategoryView::Other),
            MembershipChangeView::Banned
            | MembershipChangeView::Unbanned
            | MembershipChangeView::Kicked
            | MembershipChangeView::KickedAndBanned
            | MembershipChangeView::InvitationRevoked
            | MembershipChangeView::KnockAccepted
            | MembershipChangeView::KnockDenied => None,
        },
        TimelineItemContentView::ProfileChange {
            display_name,
            avatar,
            ..
        } => {
            if display_name.is_some() {
                Some(TimelineMemberCategoryView::Name)
            } else if avatar.is_some() {
                Some(TimelineMemberCategoryView::Avatar)
            } else {
                None
            }
        }
        _ => None,
    }
}

struct Unit {
    item: Shared,
    /// Where `item` is in the list the units were made from.
    source: usize,
    group: Option<Vec<Shared>>,
}

fn group_member_events(items: &[Shared]) -> Vec<Unit> {
    let mut units = Vec::new();
    let mut start = 0;
    while start < items.len() {
        let mut end = start;
        while items
            .get(end)
            .is_some_and(|item| member_category(item).is_some())
        {
            end += 1;
        }
        if end - start >= 2
            && let Some(last) = items.get(end - 1)
        {
            units.push(Unit {
                item: last.clone(),
                source: end - 1,
                group: items.get(start..end).map(<[Shared]>::to_vec),
            });
            start = end;
        } else if let Some(item) = items.get(start) {
            units.push(Unit {
                item: item.clone(),
                source: start,
                group: None,
            });
            start += 1;
        }
    }
    units
}

fn group_user(item: &TimelineItemView) -> Option<TimelineSubjectView> {
    match &item.content {
        TimelineItemContentView::Membership {
            user_id,
            display_name,
            ..
        } => Some(TimelineSubjectView {
            user_id: user_id.to_string(),
            name: display_name.clone().unwrap_or_else(|| user_id.to_string()),
        }),
        TimelineItemContentView::ProfileChange { user_id, .. } => Some(TimelineSubjectView {
            user_id: user_id.to_string(),
            name: item
                .sender_name
                .clone()
                .unwrap_or_else(|| user_id.to_string()),
        }),
        _ => None,
    }
}

/// The kinds of change in a run and who went through each, in the order they first appear.
#[must_use]
pub fn segments(group: &[Shared]) -> Vec<TimelineSegmentView> {
    let mut segments: Vec<TimelineSegmentView> = Vec::new();
    for item in group {
        let (Some(category), Some(user)) = (member_category(item), group_user(item)) else {
            continue;
        };
        let at = segments
            .iter()
            .position(|segment| segment.category == category)
            .unwrap_or_else(|| {
                segments.push(TimelineSegmentView {
                    category,
                    users: Vec::new(),
                });
                segments.len() - 1
            });
        if let Some(segment) = segments.get_mut(at)
            && !segment
                .users
                .iter()
                .any(|known| known.user_id == user.user_id)
        {
            segment.users.push(user);
        }
    }
    segments
}

fn grouping_item(item: &TimelineItemView) -> GroupItem<'_> {
    GroupItem {
        row: item.row,
        sender: item.sender.as_ref().map(|sender| sender.as_str()),
        timestamp: Some(item.timestamp),
        reply: item.in_reply_to.is_some(),
        profile: item
            .per_message_profile
            .as_ref()
            .map(|profile| GroupProfile {
                id: profile.id.as_deref(),
                display_name: profile.display_name.as_deref(),
                avatar_url: profile.avatar_url.as_deref(),
            }),
    }
}

fn is_collapsed(items: &[&Shared], index: usize, reply_style: TimelineReplyStyleView) -> bool {
    let Some(previous) = index.checked_sub(1).and_then(|before| items.get(before)) else {
        return false;
    };
    let Some(current) = items.get(index) else {
        return false;
    };
    collapsed(grouping_item(previous), grouping_item(current), reply_style)
}

fn reply_target(item: &TimelineItemView, show_hidden: bool) -> bool {
    item.event_id.is_some()
        && item.row != TimelineRowKind::Annotation
        && !matches!(item.content, TimelineItemContentView::Redacted { .. })
        && (item.row == TimelineRowKind::Message || show_hidden)
}
