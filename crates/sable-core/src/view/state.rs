use std::collections::BTreeSet;

use matrix_sdk::ruma::events::StateEventContentChange;
use matrix_sdk::ruma::events::room::member::RoomMemberEventContent;
use matrix_sdk_ui::timeline::{AnyOtherStateEventContentChange, MembershipChange, OtherState};
use serde::Deserialize as _;
use serde_with::{DefaultOnError, serde_as};

use crate::protocol::{MembershipChangeView, StateChangeView};

use super::raw::present;

pub(super) fn membership_reason(
    content: &StateEventContentChange<RoomMemberEventContent>,
) -> Option<String> {
    let StateEventContentChange::Original { content, .. } = content else {
        return None;
    };
    content
        .reason
        .as_deref()
        .filter(|reason| !reason.trim().is_empty())
        .map(ToOwned::to_owned)
}

pub(super) const fn membership_change(change: Option<MembershipChange>) -> MembershipChangeView {
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

pub(super) fn state_change(
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
                let mut added = BTreeSet::new();
                let mut removed = BTreeSet::new();
                Some(StateChangeView::PinnedEvents {
                    added: content
                        .pinned
                        .iter()
                        .filter(|pin| !previous.contains(pin) && added.insert(*pin))
                        .cloned()
                        .collect(),
                    removed: previous
                        .iter()
                        .filter(|pin| !content.pinned.contains(pin) && removed.insert(*pin))
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
    #[serde_as]
    #[derive(Default, serde::Deserialize)]
    #[serde(default)]
    struct CallMemberIn {
        #[serde(deserialize_with = "present")]
        application: bool,
        #[serde_as(deserialize_as = "DefaultOnError")]
        memberships: Option<Vec<serde::de::IgnoredAny>>,
    }

    let Some(content) = content.filter(|content| content.is_object()) else {
        return false;
    };
    let member = CallMemberIn::deserialize(content).unwrap_or_default();
    member.application
        || member
            .memberships
            .is_some_and(|memberships| !memberships.is_empty())
}

// ruma resolves the `m.call.member` alias to the unstable type, so only the
// unstable one is ever seen here.
pub(crate) const CALL_MEMBER_TYPE: &str = "org.matrix.msc3401.call.member";

/// The MSC3401 marker a voice room carries. Written on creation and never read
/// back: it is there for other clients.
pub(crate) const CALL_TYPE: &str = "org.matrix.msc3401.call";

pub(crate) const FORUM_TITLE: &str = "moe.sable.forum.title";

pub(crate) const RTC_SLOT_TYPE: &str = "org.matrix.msc4143.rtc.slot";

pub(crate) const CALL_SLOT_ID: &str = "m.call#ROOM";

pub(super) fn forum_title(content: Option<&serde_json::Value>) -> Option<String> {
    let title = content?.get(FORUM_TITLE)?.as_str()?.trim();
    (!title.is_empty()).then(|| title.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    #[test]
    fn reads_the_forum_title_and_ignores_blank_ones() {
        let titled = json!({ "body": "x", FORUM_TITLE: "  Rules  " });
        assert_eq!(forum_title(Some(&titled)).as_deref(), Some("Rules"));
        let blank = json!({ "body": "x", FORUM_TITLE: "   " });
        assert_eq!(forum_title(Some(&blank)), None);
        assert_eq!(forum_title(Some(&json!({ "body": "x" }))), None);
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
    fn a_call_member_is_in_a_call_by_application_presence_or_memberships() {
        assert!(in_call(Some(&json!({ "application": null }))));
        assert!(!in_call(Some(&json!({ "memberships": "x" }))));
        assert!(!in_call(Some(&json!("x"))));
    }
}
