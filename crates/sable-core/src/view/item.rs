use sable_model::text::visible_name;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use matrix_sdk::deserialized_responses::TimelineEvent;
use matrix_sdk::room::{PushContext, Room};
use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::push::Action;
use matrix_sdk::ruma::{
    EventId, MilliSecondsSinceUnixEpoch, OwnedEventId, OwnedTransactionId, OwnedUserId,
    TransactionId, UserId,
};
use matrix_sdk::send_queue::{LocalEcho, LocalEchoContent, RoomSendQueueUpdate};
use matrix_sdk_base::store::QueueWedgeError;
use matrix_sdk_base::store::SerializableEventContent;
use matrix_sdk_ui::{
    eyeball_im,
    timeline::{
        EventSendState, EventTimelineItem, MsgLikeKind, Profile, TimelineDetails, TimelineItem,
        TimelineItemContent, TimelineItemKind, VirtualTimelineItem,
    },
};

use crate::protocol::{
    MentionView, PerMessageProfileView, ReactionGroup, SendBlockView, SendStateView,
    TimelineItemContentView, TimelineItemView, UploadProgressView,
};

use super::content::{content, raw_formatted_body};
use super::diff::diff_values;
use super::forward::{forward_meta, forwarded, original_content};
use super::previews::{bundled_link_previews, link_previews_removed};
use super::profile::per_message_profile;
use super::raw::RawFields;
use super::state::forum_title;
use super::thread::{bundled_thread_summary, in_reply_to, msg_like, thread_summary};

#[derive(Default)]
pub struct Highlights(HashMap<String, bool>);

impl Highlights {
    pub async fn compute<'a>(
        push: Option<&PushContext>,
        items: impl IntoIterator<Item = &'a Arc<TimelineItem>>,
    ) -> Self {
        let Some(push) = push else {
            return Self::default();
        };

        let mut holds = HashMap::new();
        for item in items {
            let TimelineItemKind::Event(event) = item.kind() else {
                continue;
            };
            if event.is_own() {
                continue;
            }
            let Some(raw) = event.latest_json().or_else(|| event.original_json()) else {
                continue;
            };
            let highlighted = push.for_event(raw).await.iter().any(Action::is_highlight);
            holds.insert(item.unique_id().0.clone(), highlighted);
        }
        Self(holds)
    }

    pub async fn for_diffs(
        push: Option<&PushContext>,
        diffs: &[eyeball_im::VectorDiff<Arc<TimelineItem>>],
    ) -> Self {
        let mut items = Vec::new();
        for diff in diffs {
            items.extend(diff_values(diff));
        }
        Self::compute(push, items).await
    }

    fn holds(&self, id: &str, event: &EventTimelineItem) -> bool {
        self.0
            .get(id)
            .copied()
            .unwrap_or_else(|| event.is_highlighted())
    }
}

#[derive(Clone)]
struct LocalFields {
    profile: Option<PerMessageProfileView>,
    formatted_body: Option<String>,
}

#[derive(Default)]
pub struct LocalContent {
    fields: HashMap<OwnedTransactionId, LocalFields>,
    edits: Vec<QueuedEdit>,
}

struct QueuedEdit {
    transaction_id: OwnedTransactionId,
    target: OwnedEventId,
    profile: Option<PerMessageProfileView>,
    sent: Option<OwnedEventId>,
}

impl LocalContent {
    #[must_use]
    pub fn new(echoes: &[LocalEcho]) -> Self {
        let mut content = Self::default();
        for echo in echoes {
            if let LocalEchoContent::Event {
                serialized_event, ..
            } = &echo.content
            {
                content.remember(&echo.transaction_id, serialized_event);
            }
        }
        content
    }

    pub fn apply(&mut self, update: &RoomSendQueueUpdate) -> Option<OwnedEventId> {
        match update {
            RoomSendQueueUpdate::NewLocalEvent(LocalEcho {
                transaction_id,
                content:
                    LocalEchoContent::Event {
                        serialized_event, ..
                    },
            }) => {
                self.remember(transaction_id, serialized_event);
                self.edit_target(transaction_id)
            }
            RoomSendQueueUpdate::ReplacedLocalEvent {
                transaction_id,
                new_content,
            } => {
                let previous = self.edit_target(transaction_id);
                self.remember(transaction_id, new_content);
                self.edit_target(transaction_id).or(previous)
            }
            RoomSendQueueUpdate::CancelledLocalEvent { transaction_id } => {
                let target = self.edit_target(transaction_id);
                self.forget(transaction_id);
                target
            }
            RoomSendQueueUpdate::SentEvent {
                transaction_id,
                event_id,
            } => {
                for edit in &mut self.edits {
                    if edit.transaction_id == *transaction_id {
                        edit.sent = Some(event_id.clone());
                    }
                }
                None
            }
            _ => None,
        }
    }

    fn edit_target(&self, transaction_id: &TransactionId) -> Option<OwnedEventId> {
        self.edits
            .iter()
            .find(|edit| edit.transaction_id == *transaction_id)
            .map(|edit| edit.target.clone())
    }

    fn remember(&mut self, transaction_id: &TransactionId, content: &SerializableEventContent) {
        let content = content
            .raw()
            .0
            .deserialize_as_unchecked::<serde_json::Value>()
            .ok();
        self.edits
            .retain(|edit| edit.transaction_id != *transaction_id);
        if let Some(target) = content.as_ref().and_then(replaced_event) {
            self.edits.push(QueuedEdit {
                transaction_id: transaction_id.to_owned(),
                target,
                profile: content
                    .as_ref()
                    .and_then(|content| per_message_profile(Some(content))),
                sent: None,
            });
        }
        let fields = content
            .map(|content| LocalFields {
                profile: per_message_profile(Some(&content)),
                formatted_body: raw_formatted_body(Some(&content)).map(ToOwned::to_owned),
            })
            .filter(|fields| fields.profile.is_some() || fields.formatted_body.is_some());
        match fields {
            Some(fields) => {
                self.fields.insert(transaction_id.to_owned(), fields);
            }
            None => {
                self.fields.remove(transaction_id);
            }
        }
    }

    fn get(&self, transaction_id: &TransactionId) -> Option<&LocalFields> {
        self.fields.get(transaction_id)
    }

    /// `Some(None)` is a queued edit that clears the profile.
    fn pending_edit(&self, event_id: &EventId) -> Option<&Option<PerMessageProfileView>> {
        self.edits
            .iter()
            .rev()
            .find_map(|edit| (edit.target == event_id).then_some(&edit.profile))
    }

    /// Drops the queued edits whose remote echo is now the event's latest edit.
    pub(crate) fn settle(&mut self, target: &EventId, latest_edit: Option<&EventId>) {
        let Some(latest_edit) = latest_edit else {
            return;
        };
        self.edits
            .retain(|edit| edit.target != target || edit.sent.as_deref() != Some(latest_edit));
    }

    pub(crate) fn forget(&mut self, transaction_id: &TransactionId) {
        self.fields.remove(transaction_id);
        self.edits
            .retain(|edit| edit.transaction_id != *transaction_id);
    }
}

#[must_use]
pub fn latest_edit_id(event: &EventTimelineItem) -> Option<OwnedEventId> {
    event
        .latest_edit_json()?
        .get_field("event_id")
        .ok()
        .flatten()
}

fn replaced_event(content: &serde_json::Value) -> Option<OwnedEventId> {
    let relation = content.get("m.relates_to")?;
    if relation.get("rel_type")?.as_str()? != "m.replace" {
        return None;
    }
    OwnedEventId::try_from(relation.get("event_id")?.as_str()?).ok()
}

#[must_use]
pub fn aggregation_item(
    event: &AnySyncTimelineEvent,
    content: Option<serde_json::Value>,
    redacts: Option<OwnedEventId>,
    own_user_id: Option<&UserId>,
) -> TimelineItemView {
    let event_id = event.event_id().to_owned();
    let sender = event.sender().to_owned();
    let content = TimelineItemContentView::HiddenEvent {
        event_type: event.event_type().to_string(),
        content,
        redacts,
    };
    TimelineItemView {
        id: event_id.to_string(),
        row: content.row_kind(),
        forwardable: content.forwardable(),
        redactable: content.redactable(),
        visibility: content.visibility(),
        event_id: Some(event_id),
        transaction_id: None,
        send_state: None,
        is_own: own_user_id == Some(sender.as_ref()),
        sender_name: None,
        sender_avatar: None,
        timestamp: event.origin_server_ts().0.into(),
        content,
        sender: Some(sender),
        in_reply_to: None,
        thread_root: None,
        thread_summary: None,
        reactions: Vec::new(),
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

pub async fn standalone_item(
    room: &Room,
    event: TimelineEvent,
    latest: Option<TimelineEvent>,
    push: Option<&PushContext>,
) -> Option<TimelineItemView> {
    let event_id = event.event_id()?.to_owned();
    let sender = event.raw().get_field::<OwnedUserId>("sender").ok()??;
    let timestamp = event
        .raw()
        .get_field::<MilliSecondsSinceUnixEpoch>("origin_server_ts")
        .ok()??;
    let own_user_id = room.client().user_id().map(ToOwned::to_owned);
    let is_own = own_user_id.as_deref() == Some(sender.as_ref());

    let shown = latest.as_ref().unwrap_or(&event);
    let raw = shown
        .raw()
        .deserialize_as_unchecked::<RawFields>()
        .unwrap_or_default();
    let item_content = TimelineItemContent::from_event(room, shown.clone()).await?;
    let highlighted = match push {
        Some(push) if !is_own => push
            .for_event(shown.raw())
            .await
            .iter()
            .any(Action::is_highlight),
        _ => false,
    };
    let message_profile = per_message_profile(raw.content.as_ref());
    let member = room.get_member_no_sync(&sender).await.ok().flatten();
    let original = event
        .raw()
        .deserialize_as_unchecked::<RawFields>()
        .unwrap_or_default();
    let thread_summary = thread_summary(&item_content).or_else(|| {
        event
            .raw()
            .get_field::<serde_json::Value>("unsigned")
            .ok()
            .flatten()
            .as_ref()
            .and_then(bundled_thread_summary)
    });

    let mut view_content = content(
        &item_content,
        message_profile.as_ref(),
        &raw,
        own_user_id.as_deref(),
    );
    if latest.is_some()
        && let TimelineItemContentView::Message { edited, .. } = &mut view_content
    {
        *edited = true;
    }

    Some(TimelineItemView {
        id: event_id.to_string(),
        row: view_content.row_kind(),
        forwardable: view_content.forwardable(),
        redactable: view_content.redactable(),
        visibility: view_content.visibility(),
        event_id: Some(event_id),
        transaction_id: None,
        send_state: None,
        is_own,
        sender_name: member.as_ref().and_then(|member| {
            member
                .display_name()
                .and_then(visible_name)
                .map(ToOwned::to_owned)
        }),
        sender_avatar: member
            .as_ref()
            .and_then(|member| member.avatar_url().map(ToString::to_string)),
        timestamp: timestamp.0.into(),
        mention: content_mention(&item_content, is_own, own_user_id.as_deref(), highlighted),
        in_reply_to: in_reply_to(&item_content),
        thread_root: msg_like(&item_content).and_then(|msg| msg.thread_root.clone()),
        thread_summary,
        content: view_content,
        sender: Some(sender),
        reactions: Vec::new(),
        read_by: Vec::new(),
        read_timestamps: BTreeMap::new(),
        bundled_link_previews: bundled_link_previews(raw.message()),
        link_previews_removed: link_previews_removed(raw.message()),
        per_message_profile: message_profile,
        forwarded: original.content.as_ref().and_then(forward_meta),
        forum_title: None,
    })
}

fn message_profile(
    event: &EventTimelineItem,
    raw: &RawFields,
    local: Option<&LocalFields>,
    local_content: &LocalContent,
) -> Option<PerMessageProfileView> {
    let pending_edit = event
        .event_id()
        .and_then(|event_id| local_content.pending_edit(event_id));
    pending_edit
        .map_or_else(|| per_message_profile(raw.content.as_ref()), Clone::clone)
        .or_else(|| local?.profile.clone())
}

#[must_use]
pub fn timeline_item(
    item: &Arc<TimelineItem>,
    own_user_id: Option<&UserId>,
    highlights: &Highlights,
    local_content: &LocalContent,
) -> TimelineItemView {
    let id = item.unique_id().0.clone();

    match item.kind() {
        TimelineItemKind::Event(event) => {
            let profile = match event.sender_profile() {
                TimelineDetails::Ready(profile) => Some(profile),
                _ => None,
            };
            let mut raw = RawFields::read(event);
            if event.latest_edit_json().is_some() {
                raw.original_content = original_content(event);
            }
            let local = event
                .send_state()
                .and(event.transaction_id())
                .and_then(|transaction_id| local_content.get(transaction_id));
            raw.echo_formatted_body = local.and_then(|fields| fields.formatted_body.clone());
            let message_profile = message_profile(event, &raw, local, local_content);

            let mention = mention(event, own_user_id, highlights.holds(&id, event));
            let bundled_link_previews = bundled_link_previews(raw.message());
            let link_previews_removed = link_previews_removed(raw.message());
            let forwarded = forwarded(event, &raw);
            let forum_title = forum_title(raw.message());
            let content = content(event.content(), message_profile.as_ref(), &raw, own_user_id);

            TimelineItemView {
                id,
                row: content.row_kind(),
                forwardable: content.forwardable(),
                redactable: content.redactable(),
                visibility: content.visibility(),
                event_id: event.event_id().map(ToOwned::to_owned),
                transaction_id: event.transaction_id().map(ToString::to_string),
                send_state: event.send_state().map(send_state),
                sender: Some(event.sender().to_owned()),
                sender_name: profile
                    .and_then(|p: &Profile| p.display_name.as_deref())
                    .and_then(visible_name)
                    .map(str::to_owned),
                sender_avatar: profile
                    .and_then(|p: &Profile| p.avatar_url.as_ref())
                    .map(ToString::to_string),
                timestamp: event.timestamp().0.into(),
                content,
                in_reply_to: in_reply_to(event.content()),
                thread_root: msg_like(event.content()).and_then(|msg| msg.thread_root.clone()),
                thread_summary: thread_summary(event.content()),
                reactions: annotatable_reactions(event),
                is_own: event.is_own(),
                read_by: event.read_receipts().keys().cloned().collect(),
                read_timestamps: read_timestamps(event),
                per_message_profile: message_profile,
                bundled_link_previews,
                link_previews_removed,
                mention,
                forwarded,
                forum_title,
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
                row: content.row_kind(),
                forwardable: content.forwardable(),
                redactable: content.redactable(),
                visibility: content.visibility(),
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
                read_timestamps: BTreeMap::new(),
                per_message_profile: None,
                bundled_link_previews: Vec::new(),
                link_previews_removed: None,
                mention: MentionView::None,
                forwarded: None,
                forum_title: None,
            }
        }
    }
}

fn annotatable_reactions(event: &EventTimelineItem) -> Vec<ReactionGroup> {
    if !event.content().is_redacted()
        && event
            .original_json()
            .is_none_or(crate::reactions::can_annotate)
    {
        reactions(event.reactions())
    } else {
        Vec::new()
    }
}

fn read_timestamps(event: &EventTimelineItem) -> BTreeMap<String, u64> {
    event
        .read_receipts()
        .iter()
        .filter_map(|(user_id, receipt)| receipt.ts.map(|ts| (user_id.to_string(), ts.0.into())))
        .collect()
}

fn send_state(state: &EventSendState) -> SendStateView {
    match state {
        EventSendState::NotSentYet { progress } => SendStateView::Sending {
            progress: progress.as_ref().map(|progress| UploadProgressView {
                index: progress.index,
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
            blocked: send_block(&QueueWedgeError::from(&**error)),
        },
        EventSendState::Sent { .. } => SendStateView::Sent,
    }
}

fn send_block(error: &QueueWedgeError) -> Option<SendBlockView> {
    match error {
        QueueWedgeError::IdentityViolations { users } => Some(SendBlockView::IdentityChanged {
            user_ids: users.iter().map(ToString::to_string).collect(),
        }),
        QueueWedgeError::CrossVerificationRequired => Some(SendBlockView::VerifyThisDevice),
        _ => None,
    }
}

pub(super) fn mention(
    event: &EventTimelineItem,
    own_user_id: Option<&UserId>,
    highlighted: bool,
) -> MentionView {
    content_mention(event.content(), event.is_own(), own_user_id, highlighted)
}

fn content_mention(
    content: &TimelineItemContent,
    is_own: bool,
    own_user_id: Option<&UserId>,
    highlighted: bool,
) -> MentionView {
    if is_own || content.is_redacted() {
        return MentionView::None;
    }
    if highlighted {
        return MentionView::Loud;
    }

    let mentioned = msg_like(content)
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

fn reactions(reactions: &matrix_sdk_ui::timeline::ReactionsByKeyBySender) -> Vec<ReactionGroup> {
    reactions
        .iter()
        .map(|(key, senders)| ReactionGroup {
            key: key.clone(),
            senders: senders.keys().cloned().collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::protocol::SendBlockView;
    use matrix_sdk::ruma::owned_user_id;
    use matrix_sdk_base::store::QueueWedgeError;
    use serde_json::json;

    use crate::protocol::{
        TimelineItemContentView, TimelineRowKind, TimelineVisibility, UtdCauseView,
    };
    use matrix_sdk::ruma::serde::Raw;
    use matrix_sdk::ruma::{OwnedEventId, OwnedTransactionId};

    #[test]
    fn a_send_blocked_by_a_changed_identity_names_the_users() {
        let error = QueueWedgeError::IdentityViolations {
            users: vec![owned_user_id!("@bob:example.org")],
        };

        assert_eq!(
            send_block(&error),
            Some(SendBlockView::IdentityChanged {
                user_ids: vec!["@bob:example.org".to_owned()],
            })
        );
        assert_eq!(
            send_block(&QueueWedgeError::CrossVerificationRequired),
            Some(SendBlockView::VerifyThisDevice)
        );
        assert_eq!(send_block(&QueueWedgeError::MissingMediaContent), None);
    }

    #[test]
    fn a_local_echo_takes_its_profile_from_the_send_queue() {
        let transaction_id = OwnedTransactionId::from("txn");
        let content = SerializableEventContent::from_raw(
            Raw::from_json_string(
                json!({
                    "msgtype": "m.text",
                    "body": "Kris: hello",
                    "com.beeper.per_message_profile": { "id": "kris", "displayname": "Kris" },
                })
                .to_string(),
            )
            .expect("raw content"),
            "m.room.message".to_owned(),
        );

        let mut local_content = LocalContent::default();
        local_content.apply(&RoomSendQueueUpdate::ReplacedLocalEvent {
            transaction_id: transaction_id.clone(),
            new_content: content,
        });
        assert_eq!(
            local_content
                .get(&transaction_id)
                .and_then(|fields| fields.profile.as_ref())
                .expect("the queued profile")
                .display_name
                .as_deref(),
            Some("Kris")
        );

        local_content.apply(&RoomSendQueueUpdate::SentEvent {
            transaction_id: transaction_id.clone(),
            event_id: OwnedEventId::try_from("$sent:example.org").expect("an event id"),
        });
        assert_eq!(
            local_content
                .get(&transaction_id)
                .and_then(|fields| fields.profile.as_ref())
                .expect("the profile outlives the send acknowledgement")
                .display_name
                .as_deref(),
            Some("Kris")
        );

        local_content.forget(&transaction_id);
        assert!(local_content.get(&transaction_id).is_none());
    }

    fn queued_edit(profile: Option<serde_json::Value>) -> SerializableEventContent {
        let mut content = json!({
            "msgtype": "m.text",
            "body": "* hello",
            "m.new_content": { "msgtype": "m.text", "body": "hello" },
            "m.relates_to": { "rel_type": "m.replace", "event_id": "$target:example.org" },
        });
        if let Some(profile) = profile {
            content["com.beeper.per_message_profile"] = profile;
        }
        SerializableEventContent::from_raw(
            Raw::from_json_string(content.to_string()).expect("raw content"),
            "m.room.message".to_owned(),
        )
    }

    #[test]
    fn a_queued_edit_carries_its_profile_to_the_edited_event() {
        let target = OwnedEventId::try_from("$target:example.org").expect("an event id");
        let transaction_id = OwnedTransactionId::from("txn");
        let mut local_content = LocalContent::default();
        assert!(local_content.pending_edit(&target).is_none());

        local_content.apply(&RoomSendQueueUpdate::ReplacedLocalEvent {
            transaction_id: transaction_id.clone(),
            new_content: queued_edit(Some(json!({ "id": "kris", "displayname": "Kris" }))),
        });
        let profile = local_content
            .pending_edit(&target)
            .expect("the queued edit")
            .as_ref()
            .expect("its profile");
        assert_eq!(profile.display_name.as_deref(), Some("Kris"));

        local_content.apply(&RoomSendQueueUpdate::ReplacedLocalEvent {
            transaction_id: transaction_id.clone(),
            new_content: queued_edit(None),
        });
        assert!(
            matches!(local_content.pending_edit(&target), Some(None)),
            "an edit that drops the profile clears it too"
        );

        local_content.forget(&transaction_id);
        assert!(local_content.pending_edit(&target).is_none());
    }

    #[test]
    fn a_queued_edit_settles_once_its_remote_echo_is_the_latest_edit() {
        let target = OwnedEventId::try_from("$target:example.org").expect("an event id");
        let sent = OwnedEventId::try_from("$edit:example.org").expect("an event id");
        let other = OwnedEventId::try_from("$other:example.org").expect("an event id");
        let transaction_id = OwnedTransactionId::from("txn");
        let mut local_content = LocalContent::default();
        local_content.apply(&RoomSendQueueUpdate::ReplacedLocalEvent {
            transaction_id: transaction_id.clone(),
            new_content: queued_edit(Some(json!({ "id": "kris" }))),
        });
        local_content.apply(&RoomSendQueueUpdate::SentEvent {
            transaction_id,
            event_id: sent.clone(),
        });

        local_content.settle(&target, Some(&other));
        assert!(local_content.pending_edit(&target).is_some());

        local_content.settle(&target, Some(&sent));
        assert!(local_content.pending_edit(&target).is_none());
    }

    #[test]
    fn a_tombstone_is_a_message_row_that_cannot_be_redacted_again() {
        let tombstone = TimelineItemContentView::Redacted {
            reason: None,
            redacted_by: None,
        };
        assert_eq!(tombstone.row_kind(), TimelineRowKind::Message);
        assert!(!tombstone.redactable());
        assert!(!tombstone.forwardable());
    }

    #[test]
    fn an_undecryptable_event_is_a_message_row() {
        let utd = TimelineItemContentView::UnableToDecrypt {
            reason: UtdCauseView::Unknown,
            session_id: None,
        };
        assert_eq!(utd.row_kind(), TimelineRowKind::Message);
    }

    #[test]
    fn dividers_are_annotations_and_notices_are_events() {
        let divider = TimelineItemContentView::DateDivider { timestamp: 0 };
        assert_eq!(divider.row_kind(), TimelineRowKind::Annotation);
        assert!(!divider.redactable());
        let unsupported = TimelineItemContentView::Unsupported {
            description: String::new(),
        };
        assert_eq!(unsupported.row_kind(), TimelineRowKind::Event);
        assert!(unsupported.redactable());
    }

    #[test]
    fn visibility_names_the_preference_that_can_hide_a_row() {
        let tombstone = TimelineItemContentView::Redacted {
            reason: None,
            redacted_by: None,
        };
        assert_eq!(tombstone.visibility(), TimelineVisibility::Tombstone);
        let hidden = TimelineItemContentView::HiddenEvent {
            event_type: "m.reaction".to_owned(),
            content: None,
            redacts: None,
        };
        assert_eq!(hidden.visibility(), TimelineVisibility::Hidden);
        let divider = TimelineItemContentView::DateDivider { timestamp: 0 };
        assert_eq!(divider.visibility(), TimelineVisibility::Always);
    }
}
