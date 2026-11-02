//! What a subscription lays over the SDK's items: newer sender profiles, replied-to fallbacks and
//! redaction reasons, sent as `Set` diffs.

use std::collections::HashMap;

use matrix_sdk::ruma::{OwnedEventId, OwnedUserId};
use sable_model::event_preview::event_preview;
use serde_json::Value;

use crate::nicknames::{Nicknames, RealNames};
use crate::protocol::{
    MessageShieldCode, ReplyFallbackView, TimelineItemContentView, TimelineItemView, VectorDiff,
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
}

impl ReplyFallback {
    #[must_use]
    pub(crate) fn from_source(source: &Value) -> Option<Self> {
        let preview = event_preview(source)?;
        Some(Self {
            sender: preview
                .sender
                .and_then(|sender| OwnedUserId::try_from(sender).ok()),
            body: preview.body,
            fallback: preview.fallback,
        })
    }
}

#[derive(Debug, Default)]
pub(crate) struct TimelineOverlay {
    items: Vec<TimelineItemView>,
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
        let mut item = self.with_profiles(item);
        self.real_names
            .insert(item.id.clone(), RealNames::of(&item));
        self.nicknames.apply_item(&mut item);
        item
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

    /// The items to send for a fresh snapshot.
    pub(crate) fn reset(&mut self, items: Vec<TimelineItemView>) -> Vec<TimelineItemView> {
        self.real_names.clear();
        self.items = items.into_iter().map(|item| self.overlaid(item)).collect();
        self.items.clone()
    }

    /// `diff` with its items overlaid, kept in step with the host's copy.
    pub(crate) fn apply(
        &mut self,
        diff: VectorDiff<TimelineItemView>,
    ) -> VectorDiff<TimelineItemView> {
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
        apply_diff(&mut self.items, &diff);
        diff
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
        if let Some(real) = self.real_names.get(&item.id) {
            real.restore(&mut item);
        }
        self.overlaid(item)
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
        self.replies.insert(event_id, stand_in);
        self.refresh(|item| {
            item.in_reply_to
                .as_ref()
                .is_some_and(|reply| reply.event_id == touched)
        })
    }

    pub(crate) fn set_bridged(&mut self) -> Vec<VectorDiff<TimelineItemView>> {
        self.bridged = true;
        self.refresh(mismatched_sender)
    }
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
mod tests {
    use std::collections::BTreeMap;

    use matrix_sdk::ruma::{EventId, event_id, user_id};
    use serde_json::json;

    use super::*;
    use crate::protocol::{MentionView, MessageShieldView, ReplyView, TimelineItemContentView};

    fn item(id: &str, sender: &str, reply: Option<ReplyView>) -> TimelineItemView {
        let content = TimelineItemContentView::Message {
            body: id.to_owned(),
            html: id.to_owned(),
            msgtype: crate::protocol::MessageKind::Text,
            edited: false,
            jumbo: None,
        };
        TimelineItemView {
            id: id.to_owned(),
            row: content.row_kind(),
            forwardable: content.forwardable(),
            redactable: content.redactable(),
            visibility: content.visibility(),
            event_id: OwnedEventId::try_from(format!("${id}")).ok(),
            transaction_id: None,
            send_state: None,
            sender: OwnedUserId::try_from(sender).ok(),
            sender_name: Some("Old".to_owned()),
            sender_avatar: None,
            timestamp: 0,
            content,
            in_reply_to: reply,
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
            shield: None,
        }
    }

    fn reply_to(event_id: &EventId, sender: Option<&str>, body: Option<&str>) -> ReplyView {
        ReplyView {
            event_id: event_id.to_owned(),
            sender: sender.and_then(|sender| OwnedUserId::try_from(sender).ok()),
            sender_mentioned: false,
            sender_name: Some("Old".to_owned()),
            body: body.map(ToOwned::to_owned),
            fallback: None,
        }
    }

    fn read(source: &Value) -> ReplyFallback {
        ReplyFallback::from_source(source).expect("a stand-in")
    }

    fn shielded(id: &str, code: MessageShieldCode) -> TimelineItemView {
        TimelineItemView {
            shield: Some(MessageShieldView {
                code,
                critical: true,
            }),
            ..item(id, "@ghost:x", None)
        }
    }

    #[test]
    fn a_bridged_room_drops_only_mismatched_sender_shields() {
        let mut overlay = TimelineOverlay::default();
        overlay.reset(vec![
            shielded("a", MessageShieldCode::MismatchedSender),
            shielded("b", MessageShieldCode::UnknownDevice),
        ]);

        let diffs = overlay.set_bridged();

        assert!(matches!(
            diffs.as_slice(),
            [VectorDiff::Set { index: 0, .. }]
        ));
        assert_eq!(overlay.items[0].shield, None);
        assert!(overlay.items[1].shield.is_some());
        let VectorDiff::PushBack { value } = overlay.apply(VectorDiff::PushBack {
            value: shielded("c", MessageShieldCode::MismatchedSender),
        }) else {
            unreachable!()
        };
        assert_eq!(value.shield, None);
    }

    #[test]
    fn a_rename_relabels_loaded_rows_and_later_arrivals() {
        let mut overlay = TimelineOverlay::default();
        overlay.reset(vec![
            item("a", "@alice:x", None),
            item(
                "b",
                "@bob:x",
                Some(reply_to(event_id!("$a"), Some("@alice:x"), Some("a"))),
            ),
            item("c", "@carol:x", None),
        ]);
        let alicia = || (Some("Alicia".to_owned()), Some("mxc://x/a".to_owned()));

        let (name, avatar) = alicia();
        let diffs = overlay.set_profile(user_id!("@alice:x").to_owned(), name, avatar);

        let indices: Vec<Option<usize>> = diffs
            .iter()
            .map(|diff| match diff {
                VectorDiff::Set { index, .. } => Some(*index),
                _ => None,
            })
            .collect();
        assert_eq!(indices, [Some(0), Some(1)]);
        assert_eq!(overlay.items[0].sender_avatar.as_deref(), Some("mxc://x/a"));
        assert_eq!(overlay.items[1].sender_name.as_deref(), Some("Old"));
        assert_eq!(
            overlay.items[1]
                .in_reply_to
                .as_ref()
                .and_then(|reply| reply.sender_name.as_deref()),
            Some("Alicia")
        );
        let (name, avatar) = alicia();
        assert!(
            overlay
                .set_profile(user_id!("@alice:x").to_owned(), name, avatar)
                .is_empty()
        );

        let VectorDiff::PushBack { value } = overlay.apply(VectorDiff::PushBack {
            value: item("d", "@alice:x", None),
        }) else {
            panic!("a push back");
        };
        assert_eq!(value.sender_name.as_deref(), Some("Alicia"));
        assert_eq!(overlay.items.len(), 4);
    }

    fn bobby() -> Nicknames {
        Nicknames::from_overrides(
            vec![crate::protocol::ProfileOverrideView {
                user_id: user_id!("@bob:x").to_owned(),
                display_name: crate::protocol::OverrideTextView::Set {
                    value: "Bobby".to_owned(),
                },
                avatar: crate::protocol::OverrideTextView::Unset,
                color: crate::protocol::OverrideColorView::Unset,
            }],
            None,
        )
    }

    #[test]
    fn a_nickname_covers_senders_and_replies_and_lifts_when_removed() {
        let mut overlay = TimelineOverlay::new(bobby());
        let items = overlay.reset(vec![
            item("a", "@bob:x", None),
            item(
                "b",
                "@carol:x",
                Some(reply_to(event_id!("$a"), Some("@bob:x"), Some("a"))),
            ),
        ]);
        assert_eq!(items[0].sender_name.as_deref(), Some("Bobby"));
        assert_eq!(
            items[1]
                .in_reply_to
                .as_ref()
                .and_then(|reply| reply.sender_name.as_deref()),
            Some("Bobby")
        );
        assert_eq!(items[1].sender_name.as_deref(), Some("Old"));

        let diffs = overlay.set_nicknames(Nicknames::default(), &[user_id!("@bob:x").to_owned()]);

        assert_eq!(diffs.len(), 2);
        assert_eq!(overlay.items[0].sender_name.as_deref(), Some("Old"));
        assert_eq!(
            overlay.items[1]
                .in_reply_to
                .as_ref()
                .and_then(|reply| reply.sender_name.as_deref()),
            Some("Old")
        );
    }

    #[test]
    fn a_nickname_survives_a_profile_change_underneath() {
        let mut overlay = TimelineOverlay::new(bobby());
        overlay.reset(vec![item("a", "@bob:x", None)]);

        overlay.set_profile(
            user_id!("@bob:x").to_owned(),
            Some("Robert".to_owned()),
            None,
        );
        assert_eq!(overlay.items[0].sender_name.as_deref(), Some("Bobby"));

        overlay.set_nicknames(Nicknames::default(), &[user_id!("@bob:x").to_owned()]);
        assert_eq!(overlay.items[0].sender_name.as_deref(), Some("Robert"));
    }

    #[test]
    fn a_reply_stand_in_fills_the_preview_now_and_on_later_diffs() {
        let mut overlay = TimelineOverlay::default();
        let reply = item(
            "r",
            "@bob:x",
            Some(reply_to(event_id!("$gone"), None, None)),
        );
        overlay.reset(vec![item("a", "@alice:x", None), reply.clone()]);

        let stand_in = read(&json!({
            "type": "m.reaction",
            "sender": "@ana:x",
            "content": {"m.relates_to": {"rel_type": "m.annotation", "event_id": "$x", "key": "👍"}}
        }));
        assert_eq!(
            overlay
                .set_reply(event_id!("$gone").to_owned(), stand_in)
                .len(),
            1
        );

        let VectorDiff::Set { value, .. } = overlay.apply(VectorDiff::Set {
            index: 1,
            value: reply,
        }) else {
            panic!("a set");
        };
        let shown = value.in_reply_to.expect("a reply");
        assert_eq!(shown.sender, Some(user_id!("@ana:x").to_owned()));
        assert_eq!(shown.body, None);
        assert_eq!(
            shown.fallback,
            Some(ReplyFallbackView::Reaction {
                key: "👍".to_owned()
            })
        );
    }

    #[test]
    fn a_redaction_reason_fills_the_deleted_row_now_and_on_later_diffs() {
        let mut overlay = TimelineOverlay::default();
        let deleted = |id: &str| {
            let mut row = item(id, "@alice:x", None);
            row.content = TimelineItemContentView::Redacted {
                reason: None,
                redacted_by: None,
            };
            row
        };
        overlay.reset(vec![item("a", "@alice:x", None), deleted("b")]);

        let diffs = overlay.set_redaction_reason(event_id!("$b").to_owned(), "spam".to_owned());
        assert_eq!(diffs.len(), 1);
        assert_eq!(redaction_reason(&overlay.items[1]), Some("spam"));
        assert!(
            overlay
                .set_redaction_reason(event_id!("$b").to_owned(), "spam".to_owned())
                .is_empty()
        );

        let VectorDiff::Set { value, .. } = overlay.apply(VectorDiff::Set {
            index: 1,
            value: deleted("b"),
        }) else {
            panic!("a set");
        };
        assert_eq!(redaction_reason(&value), Some("spam"));
    }

    #[test]
    fn a_reason_never_replaces_one_the_sdk_already_knows() {
        let mut overlay = TimelineOverlay::default();
        let mut row = item("b", "@alice:x", None);
        row.content = TimelineItemContentView::Redacted {
            reason: Some("rude".to_owned()),
            redacted_by: None,
        };
        overlay.reset(vec![row]);

        assert!(
            overlay
                .set_redaction_reason(event_id!("$b").to_owned(), "spam".to_owned())
                .is_empty()
        );
        assert_eq!(redaction_reason(&overlay.items[0]), Some("rude"));
    }
}
