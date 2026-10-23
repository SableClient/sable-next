use std::collections::HashMap;

use matrix_sdk::room_preview::RoomPreview;
use matrix_sdk::ruma::OwnedRoomId;
use matrix_sdk::ruma::directory::PublicRoomsChunk;
use matrix_sdk::ruma::events::AnyStrippedStateEvent;
use matrix_sdk::ruma::room::{JoinRuleKind, JoinRuleSummary};
use matrix_sdk::{RoomState, RoomStrippedStateVia};

use crate::api::rooms::RoomKind;
use crate::protocol::{
    PublicRoomView, RoomJoinRuleView, RoomPreviewViaView, RoomPreviewView, RoomStateView,
};

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

/// Spec routing rules: the highest-power user's server (PL 50 or more), then the most populous, up to three.
#[must_use]
pub fn via_servers(members: &[(String, i64)]) -> Vec<String> {
    const MODERATOR: i64 = 50;
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
        canonical_alias: preview.canonical_alias.clone(),
        name: preview.name.clone(),
        topic: preview.topic.clone(),
        avatar_url: preview.avatar_url.clone(),
        room_kind: RoomKind::from_room_type(preview.room_type.as_ref()),
        num_joined_members: Some(u32::try_from(preview.num_joined_members).unwrap_or(u32::MAX)),
        join_rule: preview
            .join_rule
            .as_ref()
            .map_or(RoomJoinRuleView::Unknown, join_rule_summary_view),
        state: preview.state.map(room_state_view),
        via: RoomPreviewViaView::Unknown,
    }
}

pub(super) const fn room_state_view(state: RoomState) -> RoomStateView {
    match state {
        RoomState::Joined => RoomStateView::Joined,
        RoomState::Invited => RoomStateView::Invited,
        RoomState::Knocked => RoomStateView::Knocked,
        RoomState::Left => RoomStateView::Left,
        RoomState::Banned => RoomStateView::Banned,
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
        avatar_url: None,
        room_kind: None,
        num_joined_members,
        join_rule: RoomJoinRuleView::Unknown,
        state: membership.map(room_state_view),
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
            AnyStrippedStateEvent::RoomTopic(event) => view.topic = event.content.topic,
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

    fn members(entries: &[(&str, i64)]) -> Vec<(String, i64)> {
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
        assert_eq!(via_servers(&[]), [] as [String; 0]);
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
        assert_eq!(
            via_servers(&members(&[("malformed", 100)])),
            [] as [String; 0]
        );
    }

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
                stripped("m.room.topic", r#"{"topic":"Chat"}"#),
                stripped("m.room.create", r#"{"type":"m.space"}"#),
                stripped("m.room.join_rules", r#"{"join_rule":"knock"}"#),
            ],
            Some(RoomState::Invited),
        );

        assert_eq!(preview.name.as_deref(), Some("Lounge"));
        assert_eq!(preview.topic.as_deref(), Some("Chat"));
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
