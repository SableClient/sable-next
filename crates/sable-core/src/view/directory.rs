use matrix_sdk::room_preview::RoomPreview;
use matrix_sdk::ruma::OwnedRoomId;
use matrix_sdk::ruma::directory::PublicRoomsChunk;
use matrix_sdk::ruma::events::AnyStrippedStateEvent;
use matrix_sdk::ruma::room::{JoinRuleKind, JoinRuleSummary};
use matrix_sdk::{RoomState, RoomStrippedStateVia};

use crate::api::rooms::RoomKind;
use crate::protocol::{PublicRoomView, RoomJoinRuleView, RoomPreviewViaView, RoomPreviewView};

#[must_use]
pub fn public_room(chunk: &PublicRoomsChunk) -> PublicRoomView {
    PublicRoomView {
        room_id: chunk.room_id.clone(),
        canonical_alias: chunk.canonical_alias.as_ref().map(ToString::to_string),
        name: chunk.name.clone(),
        topic: chunk.topic.clone(),
        avatar_url: chunk.avatar_url.as_ref().map(ToString::to_string),
        room_kind: RoomKind::from_room_type(chunk.room_type.as_ref()),
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
pub fn room_preview_view(preview: &RoomPreview) -> RoomPreviewView {
    RoomPreviewView {
        room_id: preview.room_id.clone(),
        canonical_alias: preview.canonical_alias.clone(),
        name: preview.name.clone(),
        topic: preview.topic.clone(),
        topic_html: None,
        avatar_url: preview.avatar_url.clone(),
        room_kind: RoomKind::from_room_type(preview.room_type.as_ref()),
        num_joined_members: Some(u32::try_from(preview.num_joined_members).unwrap_or(u32::MAX)),
        join_rule: preview
            .join_rule
            .as_ref()
            .map_or(RoomJoinRuleView::Unknown, join_rule_summary_view),
        state: preview.state.map(Into::into),
        via: RoomPreviewViaView::Unknown,
    }
}

#[must_use]
pub fn room_preview_from_stripped_state(
    room_id: OwnedRoomId,
    via: RoomStrippedStateVia,
    num_joined_members: Option<u32>,
    state_events: Vec<AnyStrippedStateEvent>,
    membership: Option<RoomState>,
) -> RoomPreviewView {
    let mut view = RoomPreviewView {
        room_id,
        canonical_alias: None,
        name: None,
        topic: None,
        topic_html: None,
        avatar_url: None,
        room_kind: None,
        num_joined_members,
        join_rule: RoomJoinRuleView::Unknown,
        state: membership.map(Into::into),
        via: match via {
            RoomStrippedStateVia::Client => RoomPreviewViaView::Client,
            RoomStrippedStateVia::Remote(server) => RoomPreviewViaView::Remote { server },
        },
    };

    for event in state_events {
        match event {
            AnyStrippedStateEvent::RoomCanonicalAlias(event) => {
                view.canonical_alias = event.content.alias;
            }
            AnyStrippedStateEvent::RoomName(event) => view.name = event.content.name,
            AnyStrippedStateEvent::RoomTopic(event) => {
                view.topic_html = event.content.topic_block.text.find_html().map(|html| {
                    crate::matrix_html::display_html(
                        event.content.topic.as_deref().unwrap_or_default(),
                        Some(html),
                    )
                });
                view.topic = event.content.topic;
            }
            AnyStrippedStateEvent::RoomAvatar(event) => view.avatar_url = event.content.url,
            AnyStrippedStateEvent::RoomCreate(event) => {
                view.room_kind = RoomKind::from_room_type(event.content.room_type.as_ref());
            }
            AnyStrippedStateEvent::RoomJoinRules(event) => {
                view.join_rule = join_rule_summary_view(&event.content.join_rule.into());
            }
            _ => {}
        }
    }

    view
}

pub(super) const fn join_rule_summary_view(rule: &JoinRuleSummary) -> RoomJoinRuleView {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::RoomStateView;

    fn stripped(kind: &str, content: &str) -> AnyStrippedStateEvent {
        serde_json::from_str(&format!(
            r#"{{"type":"{kind}","state_key":"","sender":"@a:example.org","content":{content}}}"#
        ))
        .unwrap()
    }

    #[test]
    fn builds_a_preview_from_stripped_state() {
        let preview = room_preview_from_stripped_state(
            matrix_sdk::ruma::owned_room_id!("!room:example.org"),
            RoomStrippedStateVia::Remote(matrix_sdk::ruma::owned_server_name!("other.example")),
            Some(7),
            vec![
                stripped("m.room.name", r#"{"name":"Lounge"}"#),
                stripped(
                    "m.room.topic",
                    r#"{"topic":"**Chat**","m.topic":{"m.text":[{"mimetype":"text/html","body":"<strong>Chat</strong>"},{"body":"**Chat**"}]}}"#,
                ),
                stripped("m.room.create", r#"{"type":"m.space"}"#),
                stripped("m.room.join_rules", r#"{"join_rule":"knock"}"#),
            ],
            Some(RoomState::Invited),
        );

        assert_eq!(preview.name.as_deref(), Some("Lounge"));
        assert_eq!(preview.topic.as_deref(), Some("**Chat**"));
        assert_eq!(preview.topic_html.as_deref(), Some("<strong>Chat</strong>"));
        let hostile = room_preview_from_stripped_state(
            matrix_sdk::ruma::owned_room_id!("!room:example.org"),
            RoomStrippedStateVia::Client,
            None,
            vec![stripped(
                "m.room.topic",
                r#"{"topic":"x","m.topic":{"m.text":[{"mimetype":"text/html","body":"<img src=x onerror=alert(1)>x"}]}}"#,
            )],
            None,
        );
        assert!(!hostile.topic_html.unwrap_or_default().contains("onerror"));
        assert_eq!(preview.room_kind, Some(RoomKind::Space));
        assert_eq!(preview.join_rule, RoomJoinRuleView::Knock);
        assert_eq!(preview.num_joined_members, Some(7));
        assert!(matches!(preview.state, Some(RoomStateView::Invited)));
        assert!(matches!(
            preview.via,
            RoomPreviewViaView::Remote { server } if server == "other.example"
        ));
    }

    #[test]
    fn a_preview_with_no_state_is_unknown_rather_than_empty() {
        let preview = room_preview_from_stripped_state(
            matrix_sdk::ruma::owned_room_id!("!room:example.org"),
            RoomStrippedStateVia::Client,
            None,
            Vec::new(),
            None,
        );

        assert_eq!(preview.room_kind, None);
        assert_eq!(preview.join_rule, RoomJoinRuleView::Unknown);
        assert_eq!(preview.num_joined_members, None);
        assert!(preview.state.is_none());
        assert!(matches!(preview.via, RoomPreviewViaView::Client));
    }
}
