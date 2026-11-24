//! What a subscription lays over the SDK's items: newer sender profiles, replied-to fallbacks and
//! redaction reasons, sent as `Set` diffs.

use std::collections::HashMap;

use matrix_sdk::ruma::events::room::member::{MembershipState, RoomMemberEventContent};
use matrix_sdk::ruma::events::room::power_levels::RoomPowerLevels;
use matrix_sdk::ruma::{OwnedEventId, OwnedUserId, UserId};
use sable_model::event_preview::event_preview;
use serde_json::Value;

use crate::nicknames::{Nicknames, RealNames};
use crate::protocol::{
    MentionView, MessageShieldCode, PreviewEmote, ReplyFallbackView, TimelineItemContentView,
    TimelineItemView, TimelineVisibility, VectorDiff,
};
use crate::view::apply_diff;

#[derive(Debug, Clone, PartialEq, Eq)]
struct SenderProfile {
    name: Option<String>,
    avatar: Option<String>,
}

/// A replied-to event read from its source: who sent it, and either its body
/// or what it was instead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReplyFallback {
    sender: Option<OwnedUserId>,
    body: Option<String>,
    fallback: Option<ReplyFallbackView>,
    emotes: Vec<PreviewEmote>,
    session_id: Option<String>,
}

impl ReplyFallback {
    #[must_use]
    pub(crate) fn from_source(source: &Value) -> Option<Self> {
        let preview = event_preview(source)?;
        let session_id = (source.get("type")?.as_str()? == "m.room.encrypted")
            .then(|| source.pointer("/content/session_id")?.as_str())
            .flatten()
            .map(str::to_owned);
        Some(Self {
            sender: preview
                .sender
                .and_then(|sender| OwnedUserId::try_from(sender).ok()),
            body: preview.body,
            fallback: preview.fallback,
            emotes: preview.emotes,
            session_id,
        })
    }
}

/// MSC4293: who removed a user's events by banning or kicking them with
/// `redact_events`, when and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BanRedaction {
    by: OwnedUserId,
    reason: Option<String>,
    /// When the ban or kick was sent, in milliseconds since the Unix epoch.
    at: u64,
}

impl BanRedaction {
    /// Honoured only when the sender may redact other people's events, which
    /// covers both the `redact` level and the `m.room.redaction` event level.
    pub(crate) fn from_membership(
        sender: &UserId,
        target: &UserId,
        content: &RoomMemberEventContent,
        power_levels: &RoomPowerLevels,
        at: u64,
    ) -> Option<Self> {
        let removed = match content.membership {
            MembershipState::Ban => true,
            MembershipState::Leave => sender != target,
            _ => false,
        };
        (removed && content.redact_events && power_levels.user_can_redact_event_of_other(sender))
            .then(|| Self {
                by: sender.to_owned(),
                reason: content.reason.clone(),
                at,
            })
    }

    /// The bans and kicks with `redact_events` among the room's stored members, and the power
    /// levels they were judged by.
    pub(crate) async fn in_room(
        room: &matrix_sdk::Room,
    ) -> (HashMap<OwnedUserId, Self>, Option<RoomPowerLevels>) {
        use matrix_sdk::RoomMemberships;
        use matrix_sdk::deserialized_responses::MemberEvent;
        use matrix_sdk::ruma::events::room::member::SyncRoomMemberEvent;

        let Ok(power_levels) = room.power_levels().await else {
            return (HashMap::new(), None);
        };
        let members = room
            .members_no_sync(RoomMemberships::BAN | RoomMemberships::LEAVE)
            .await
            .unwrap_or_default();
        let bans = members
            .iter()
            .filter_map(|member| {
                let MemberEvent::Sync(SyncRoomMemberEvent::Original(event)) =
                    member.event().as_ref()
                else {
                    return None;
                };
                Self::from_membership(
                    &event.sender,
                    &event.state_key,
                    &event.content,
                    &power_levels,
                    event.origin_server_ts.0.into(),
                )
                .map(|ban| (member.user_id().to_owned(), ban))
            })
            .collect();
        (bans, Some(power_levels))
    }

    fn hide(&self, item: TimelineItemView) -> TimelineItemView {
        let content = TimelineItemContentView::Redacted {
            reason: self.reason.clone(),
            redacted_by: Some(self.by.to_string()),
        };
        TimelineItemView {
            row: content.row_kind(),
            forwardable: content.forwardable(),
            redactable: content.redactable(),
            visibility: content.visibility(),
            content,
            in_reply_to: None,
            reactions: Vec::new(),
            per_message_profile: None,
            bundled_link_previews: Vec::new(),
            link_previews_removed: None,
            mention: MentionView::None,
            forwarded: None,
            forum_title: None,
            redacted_on_ban: Some(true),
            ..item
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct TimelineOverlay {
    items: Vec<TimelineItemView>,
    /// The latest ban or kick with `redact_events` known for a user. It decides for the rows
    /// that no loaded member row of theirs follows, and a later member event never lifts it.
    ban_redactions: HashMap<OwnedUserId, BanRedaction>,
    /// Who may redact other people's events, which is who a removal is honoured from.
    redactors: Option<RoomPowerLevels>,
    /// The removal each hidden row falls under, by item id.
    removals: HashMap<String, BanRedaction>,
    /// Items as they were before a ban hid them, by item id.
    hidden: HashMap<String, TimelineItemView>,
    profiles: HashMap<OwnedUserId, SenderProfile>,
    replies: HashMap<OwnedEventId, ReplyFallback>,
    redactions: HashMap<OwnedEventId, String>,
    bridged: bool,
    nicknames: Nicknames,
    real_names: HashMap<String, RealNames>,
}

impl TimelineOverlay {
    pub(crate) fn new(nicknames: Nicknames) -> Self {
        Self {
            nicknames,
            ..Self::default()
        }
    }

    fn overlaid(&mut self, item: TimelineItemView) -> TimelineItemView {
        let item = self.hidden_on_ban(item);
        let mut item = self.with_profiles(item);
        self.real_names
            .insert(item.id.clone(), RealNames::of(&item));
        self.nicknames.apply_item(&mut item);
        item
    }

    fn hidden_on_ban(&mut self, item: TimelineItemView) -> TimelineItemView {
        let Some(ban) = self.removals.get(&item.id) else {
            self.hidden.remove(&item.id);
            return item;
        };
        let hidden = ban.hide(item.clone());
        self.hidden.insert(item.id.clone(), item);
        hidden
    }

    fn with_profiles(&self, mut item: TimelineItemView) -> TimelineItemView {
        if let Some(reply) = item.in_reply_to.as_mut()
            && reply.body.is_none()
            && reply.fallback.is_none()
            && let Some(stand_in) = self.replies.get(&reply.event_id)
        {
            reply.sender = reply.sender.take().or_else(|| stand_in.sender.clone());
            reply.body.clone_from(&stand_in.body);
            reply.fallback.clone_from(&stand_in.fallback);
            reply.emotes.clone_from(&stand_in.emotes);
        }
        if let Some(profile) = item
            .sender
            .as_ref()
            .and_then(|sender| self.profiles.get(sender))
        {
            item.sender_name.clone_from(&profile.name);
            item.sender_avatar.clone_from(&profile.avatar);
        }
        if let Some(reply) = item.in_reply_to.as_mut()
            && let Some(profile) = reply
                .sender
                .as_ref()
                .and_then(|sender| self.profiles.get(sender))
        {
            reply.sender_name.clone_from(&profile.name);
        }
        if let TimelineItemContentView::Redacted {
            reason: None,
            redacted_by,
        } = &item.content
            && let Some(reason) = item
                .event_id
                .as_ref()
                .and_then(|event_id| self.redactions.get(event_id))
        {
            item.content = TimelineItemContentView::Redacted {
                reason: Some(reason.clone()),
                redacted_by: redacted_by.clone(),
            };
        }
        if self.bridged && mismatched_sender(&item) {
            item.shield = None;
        }
        item
    }

    pub(crate) fn index_of_event(&self, event_id: &OwnedEventId) -> Option<usize> {
        self.items
            .iter()
            .position(|item| item.event_id.as_ref() == Some(event_id))
    }

    pub(crate) fn index_of_transaction(&self, transaction_id: &str) -> Option<usize> {
        self.items
            .iter()
            .position(|item| item.transaction_id.as_deref() == Some(transaction_id))
    }

    /// The items to send for a fresh snapshot.
    pub(crate) fn reset(&mut self, items: Vec<TimelineItemView>) -> Vec<TimelineItemView> {
        self.real_names.clear();
        self.items = items.into_iter().map(|item| self.overlaid(item)).collect();
        self.settle_removals(0..self.items.len());
        self.items.clone()
    }

    /// `diff` with its items overlaid, kept in step with the host's copy, then a `Set` for
    /// each other row the diff hides or shows again: a member row decides for the rows before it.
    pub(crate) fn apply(
        &mut self,
        diff: VectorDiff<TimelineItemView>,
    ) -> Vec<VectorDiff<TimelineItemView>> {
        let diff = match diff {
            VectorDiff::Append { values } => VectorDiff::Append {
                values: values.into_iter().map(|item| self.overlaid(item)).collect(),
            },
            VectorDiff::Reset { values } => {
                self.real_names.clear();
                VectorDiff::Reset {
                    values: values.into_iter().map(|item| self.overlaid(item)).collect(),
                }
            }
            VectorDiff::PushFront { value } => VectorDiff::PushFront {
                value: self.overlaid(value),
            },
            VectorDiff::PushBack { value } => VectorDiff::PushBack {
                value: self.overlaid(value),
            },
            VectorDiff::Insert { index, value } => VectorDiff::Insert {
                index,
                value: self.overlaid(value),
            },
            VectorDiff::Set { index, value } => VectorDiff::Set {
                index,
                value: self.overlaid(value),
            },
            other => other,
        };
        let removes = matches!(
            diff,
            VectorDiff::Remove { .. }
                | VectorDiff::PopFront
                | VectorDiff::PopBack
                | VectorDiff::Truncate { .. }
                | VectorDiff::Clear
        );
        apply_diff(&mut self.items, &diff);
        if removes {
            let held: std::collections::HashSet<&str> =
                self.items.iter().map(|item| item.id.as_str()).collect();
            self.real_names.retain(|id, _| held.contains(id.as_str()));
            self.hidden.retain(|id, _| held.contains(id.as_str()));
        }
        let placed = placed(&diff, self.items.len());
        // Nothing removed and no removal known, so only a placed row can start one.
        if self.ban_redactions.is_empty()
            && self.removals.is_empty()
            && !self
                .items
                .get(placed.clone())
                .unwrap_or_default()
                .iter()
                .any(removes_events)
        {
            return vec![diff];
        }
        let others = self.settle_removals(placed.clone());
        let mut diffs = vec![self.as_settled(diff, placed)];
        diffs.extend(others);
        diffs
    }

    /// The member row that decides for the user's earlier rows, and the removal it carries. A
    /// forged one, which the view hides, decides nothing.
    fn member_row(&self, item: &TimelineItemView) -> Option<(OwnedUserId, Option<BanRedaction>)> {
        if item.visibility == TimelineVisibility::Hidden {
            return None;
        }
        match &item.content {
            TimelineItemContentView::Membership {
                user_id,
                reason,
                removes_events,
                ..
            } => {
                let removal = item
                    .sender
                    .as_ref()
                    .filter(|sender| {
                        *removes_events
                            && *sender != user_id
                            && self.redactors.as_ref().is_some_and(|power_levels| {
                                power_levels.user_can_redact_event_of_other(sender)
                            })
                    })
                    .map(|sender| BanRedaction {
                        by: sender.clone(),
                        reason: reason.clone(),
                        at: item.timestamp,
                    });
                Some((user_id.clone(), removal))
            }
            TimelineItemContentView::ProfileChange { user_id, .. } => Some((user_id.clone(), None)),
            _ => None,
        }
    }

    /// MSC4293 removes a user's events back to their previous member event, so each row falls
    /// under the nearest later member row of its sender, or under the latest known removal
    /// where none is loaded. Returns the `Set` diffs for the changed rows outside `placed`.
    fn settle_removals(
        &mut self,
        placed: std::ops::Range<usize>,
    ) -> Vec<VectorDiff<TimelineItemView>> {
        let mut later: HashMap<OwnedUserId, Option<BanRedaction>> = HashMap::new();
        let mut removals = HashMap::new();
        for item in self.items.iter().rev() {
            let original = self.hidden.get(&item.id).unwrap_or(item);
            if let Some((user_id, removal)) = self.member_row(original) {
                later.insert(user_id, removal);
                continue;
            }
            let Some(sender) = original.sender.as_ref().filter(|_| removable(original)) else {
                continue;
            };
            let removal = match later.get(sender) {
                Some(removal) => removal.clone(),
                None => self
                    .ban_redactions
                    .get(sender)
                    .filter(|ban| original.timestamp <= ban.at)
                    .cloned(),
            };
            if let Some(removal) = removal {
                removals.insert(item.id.clone(), removal);
            }
        }
        let changed: Vec<usize> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| removals.get(&item.id) != self.removals.get(&item.id))
            .map(|(index, _)| index)
            .collect();
        self.removals = removals;
        let mut diffs = Vec::new();
        for index in changed {
            let Some(item) = self.items.get(index).cloned() else {
                continue;
            };
            let value = self.reoverlaid(item);
            if let Some(slot) = self.items.get_mut(index) {
                slot.clone_from(&value);
            }
            if !placed.contains(&index) {
                diffs.push(VectorDiff::Set { index, value });
            }
        }
        diffs
    }

    /// `diff` carrying the rows it placed as they are now that removals are settled.
    fn as_settled(
        &self,
        diff: VectorDiff<TimelineItemView>,
        placed: std::ops::Range<usize>,
    ) -> VectorDiff<TimelineItemView> {
        let rows = || self.items.get(placed.clone()).unwrap_or_default().to_vec();
        let row = |value| self.items.get(placed.start).cloned().unwrap_or(value);
        match diff {
            VectorDiff::Append { .. } => VectorDiff::Append { values: rows() },
            VectorDiff::Reset { .. } => VectorDiff::Reset { values: rows() },
            VectorDiff::PushFront { value } => VectorDiff::PushFront { value: row(value) },
            VectorDiff::PushBack { value } => VectorDiff::PushBack { value: row(value) },
            VectorDiff::Insert { index, value } => VectorDiff::Insert {
                index,
                value: row(value),
            },
            VectorDiff::Set { index, value } => VectorDiff::Set {
                index,
                value: row(value),
            },
            other => other,
        }
    }

    fn refresh(
        &mut self,
        touched: impl Fn(&TimelineItemView) -> bool,
    ) -> Vec<VectorDiff<TimelineItemView>> {
        let mut diffs = Vec::new();
        for index in 0..self.items.len() {
            let Some(item) = self.items.get(index).filter(|item| touched(item)).cloned() else {
                continue;
            };
            let item = &item;
            let next = self.reoverlaid(item.clone());
            let unchanged = next.sender_name == item.sender_name
                && subject_name(&next) == subject_name(item)
                && next.sender_avatar == item.sender_avatar
                && next.in_reply_to == item.in_reply_to
                && redaction_reason(&next) == redaction_reason(item)
                && next.redacted_on_ban == item.redacted_on_ban
                && next.shield == item.shield;
            if unchanged {
                continue;
            }
            if let Some(slot) = self.items.get_mut(index) {
                slot.clone_from(&next);
            }
            diffs.push(VectorDiff::Set { index, value: next });
        }
        diffs
    }

    fn reoverlaid(&mut self, mut item: TimelineItemView) -> TimelineItemView {
        if let Some(original) = self.hidden.remove(&item.id) {
            return self.overlaid(original);
        }
        if let Some(real) = self.real_names.get(&item.id) {
            real.restore(&mut item);
        }
        self.overlaid(item)
    }

    /// Seeds the bans known when the timeline opens, before its first items.
    pub(crate) fn seed_ban_redactions(
        &mut self,
        bans: HashMap<OwnedUserId, BanRedaction>,
        redactors: Option<RoomPowerLevels>,
    ) {
        self.ban_redactions = bans;
        self.redactors = redactors;
    }

    /// The `Set` diffs that hide `user_id`'s events after a ban or kick with `redact_events`.
    /// Any other member event leaves what is hidden as it is: MSC4293 never undoes a removal.
    pub(crate) fn set_ban_redaction(
        &mut self,
        user_id: &UserId,
        ban: Option<BanRedaction>,
        redactors: Option<RoomPowerLevels>,
    ) -> Vec<VectorDiff<TimelineItemView>> {
        if let Some(redactors) = redactors {
            self.redactors = Some(redactors);
        }
        if let Some(ban) = ban {
            self.ban_redactions.insert(user_id.to_owned(), ban);
        }
        self.settle_removals(0..0)
    }

    /// The content a ban hides from the timeline, for a moderator to read.
    pub(crate) fn hidden_content(
        &self,
        event_id: &OwnedEventId,
    ) -> Option<TimelineItemContentView> {
        self.hidden
            .values()
            .find(|item| item.event_id.as_ref() == Some(event_id))
            .map(|item| item.content.clone())
    }

    pub(crate) fn set_nicknames(
        &mut self,
        nicknames: Nicknames,
        users: &[OwnedUserId],
    ) -> Vec<VectorDiff<TimelineItemView>> {
        self.nicknames = nicknames;
        self.refresh(|item| RealNames::mentions(item, users))
    }

    /// The `Set` diffs that show `user_id`'s new profile.
    pub(crate) fn set_profile(
        &mut self,
        user_id: OwnedUserId,
        name: Option<String>,
        avatar: Option<String>,
    ) -> Vec<VectorDiff<TimelineItemView>> {
        let touched = user_id.clone();
        self.profiles
            .insert(user_id, SenderProfile { name, avatar });
        self.refresh(|item| {
            item.sender.as_ref() == Some(&touched)
                || item
                    .in_reply_to
                    .as_ref()
                    .is_some_and(|reply| reply.sender.as_ref() == Some(&touched))
        })
    }

    /// The `Set` diffs that show why `event_id` was deleted. The SDK drops the reason
    /// when it redacts a loaded item.
    pub(crate) fn set_redaction_reason(
        &mut self,
        event_id: OwnedEventId,
        reason: String,
    ) -> Vec<VectorDiff<TimelineItemView>> {
        let touched = event_id.clone();
        self.redactions.insert(event_id, reason);
        self.refresh(|item| item.event_id.as_ref() == Some(&touched))
    }

    /// The `Set` diffs that fill in replies to `event_id`.
    pub(crate) fn set_reply(
        &mut self,
        event_id: OwnedEventId,
        stand_in: ReplyFallback,
    ) -> Vec<VectorDiff<TimelineItemView>> {
        let touched = event_id.clone();
        if let Some(previous) = self.replies.insert(event_id, stand_in) {
            for reply in self
                .items
                .iter_mut()
                .filter_map(|item| item.in_reply_to.as_mut())
                .filter(|reply| {
                    reply.event_id == touched
                        && reply.body == previous.body
                        && reply.fallback == previous.fallback
                })
            {
                reply.body = None;
                reply.fallback = None;
                reply.emotes.clear();
            }
        }
        self.refresh(|item| {
            item.in_reply_to
                .as_ref()
                .is_some_and(|reply| reply.event_id == touched)
        })
    }

    pub(crate) fn encrypted_replies(&self, keyed: impl Fn(&str) -> bool) -> Vec<OwnedEventId> {
        self.replies
            .iter()
            .filter(|(_, stand_in)| stand_in.session_id.as_deref().is_some_and(&keyed))
            .map(|(event_id, _)| event_id.clone())
            .collect()
    }

    pub(crate) fn set_bridged(&mut self) -> Vec<VectorDiff<TimelineItemView>> {
        self.bridged = true;
        self.refresh(mismatched_sender)
    }
}

/// The rows a diff put in place, which it carries itself.
fn placed(diff: &VectorDiff<TimelineItemView>, len: usize) -> std::ops::Range<usize> {
    match diff {
        VectorDiff::Append { values } => len.saturating_sub(values.len())..len,
        VectorDiff::Reset { .. } => 0..len,
        VectorDiff::PushFront { .. } => 0..len.min(1),
        VectorDiff::PushBack { .. } => len.saturating_sub(1)..len,
        VectorDiff::Insert { index, .. } | VectorDiff::Set { index, .. } => {
            let index = (*index).min(len);
            index..(index + 1).min(len)
        }
        _ => 0..0,
    }
}

/// What a removal hides: everything its sender sent except state. A redacted state event
/// still takes effect, and a member row is where the next removal stops. A row the reader
/// never sees stays one, rather than turning into a deleted message.
fn removable(item: &TimelineItemView) -> bool {
    item.event_id.is_some()
        && item.row != crate::protocol::TimelineRowKind::Annotation
        && item.visibility != TimelineVisibility::Hidden
        && !matches!(
            item.content,
            TimelineItemContentView::Redacted { .. }
                | TimelineItemContentView::Membership { .. }
                | TimelineItemContentView::ProfileChange { .. }
                | TimelineItemContentView::StateEvent { .. }
        )
}

const fn removes_events(item: &TimelineItemView) -> bool {
    matches!(
        item.content,
        TimelineItemContentView::Membership {
            removes_events: true,
            ..
        }
    )
}

fn mismatched_sender(item: &TimelineItemView) -> bool {
    item.shield
        .is_some_and(|shield| shield.code == MessageShieldCode::MismatchedSender)
}

fn subject_name(item: &TimelineItemView) -> Option<&str> {
    match &item.content {
        TimelineItemContentView::Membership { display_name, .. } => display_name.as_deref(),
        TimelineItemContentView::ProfileChange {
            display_name: Some(change),
            ..
        } => change.old.as_deref(),
        _ => None,
    }
}

fn redaction_reason(item: &TimelineItemView) -> Option<&str> {
    match &item.content {
        TimelineItemContentView::Redacted { reason, .. } => reason.as_deref(),
        _ => None,
    }
}

#[cfg(test)]
#[path = "timeline_overlay_tests.rs"]
mod tests;
