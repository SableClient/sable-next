//! What a subscription lays over the SDK's items: newer sender profiles and replied-to fallbacks,
//! sent as `Set` diffs.

use std::collections::HashMap;

use matrix_sdk::ruma::{OwnedEventId, OwnedUserId};
use sable_model::event_preview::event_preview;
use serde_json::Value;

use crate::protocol::{ReplyFallbackView, TimelineItemView, VectorDiff};
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
}

impl TimelineOverlay {
    fn overlaid(&self, mut item: TimelineItemView) -> TimelineItemView {
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
        item
    }

    /// The items to send for a fresh snapshot.
    pub(crate) fn reset(&mut self, items: Vec<TimelineItemView>) -> Vec<TimelineItemView> {
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
            VectorDiff::Reset { values } => VectorDiff::Reset {
                values: values.into_iter().map(|item| self.overlaid(item)).collect(),
            },
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
            let Some(item) = self.items.get(index).filter(|item| touched(item)) else {
                continue;
            };
            let next = self.overlaid(item.clone());
            let unchanged = next.sender_name == item.sender_name
                && next.sender_avatar == item.sender_avatar
                && next.in_reply_to == item.in_reply_to;
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
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use matrix_sdk::ruma::{EventId, event_id, user_id};
    use serde_json::json;

    use super::*;
    use crate::protocol::{MentionView, ReplyView, TimelineItemContentView};

    fn item(id: &str, sender: &str, reply: Option<ReplyView>) -> TimelineItemView {
        let content = TimelineItemContentView::Message {
            body: id.to_owned(),
            html: id.to_owned(),
            emote: false,
            notice: false,
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
}
