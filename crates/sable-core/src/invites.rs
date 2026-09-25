use std::collections::HashSet;

use matrix_sdk::{
    Client, Room, RoomMemberships,
    ruma::{OwnedUserId, events::room::member::MembershipState},
};

use crate::protocol::InviteTriageView;

struct PendingInvite {
    room: Room,
    inviter: Option<OwnedUserId>,
    reason: Option<String>,
}

async fn pending_invite(room: Room) -> PendingInvite {
    let member = room
        .get_member_no_sync(room.own_user_id())
        .await
        .ok()
        .flatten();
    let event = member
        .as_ref()
        .map(|member| member.event())
        .filter(|event| event.membership() == &MembershipState::Invite);
    PendingInvite {
        inviter: event.map(|event| event.sender().to_owned()),
        reason: event
            .and_then(|event| event.reason())
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .map(ToOwned::to_owned),
        room,
    }
}

pub(crate) async fn triage(client: &Client) -> Vec<InviteTriageView> {
    let invites =
        futures_util::future::join_all(client.invited_rooms().into_iter().map(pending_invite))
            .await;

    let own = client.user_id();
    let senders: HashSet<&OwnedUserId> = invites
        .iter()
        .filter_map(|invite| invite.inviter.as_ref())
        .filter(|inviter| Some(inviter.as_ref()) != own)
        .collect();

    let mut known = HashSet::new();
    let mut banned = HashSet::new();
    if !senders.is_empty() {
        let store = client.state_store();
        let rooms = client.joined_rooms();
        let lookups = rooms.iter().map(|room| async move {
            let joined = room.joined_user_ids().await.unwrap_or_default();
            let bans = store
                .get_user_ids(room.room_id(), RoomMemberships::BAN)
                .await
                .unwrap_or_default();
            (joined, bans)
        });
        for (joined, bans) in futures_util::future::join_all(lookups).await {
            known.extend(joined.into_iter().filter(|user| senders.contains(user)));
            banned.extend(bans.into_iter().filter(|user| senders.contains(user)));
        }
    }

    invites
        .into_iter()
        .map(|invite| InviteTriageView {
            room_id: invite.room.room_id().to_owned(),
            shares_room: invite
                .inviter
                .as_ref()
                .is_some_and(|inviter| known.contains(inviter)),
            inviter_banned: invite
                .inviter
                .as_ref()
                .is_some_and(|inviter| banned.contains(inviter)),
            inviter: invite.inviter,
            reason: invite.reason,
        })
        .collect()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use matrix_sdk::{
        ruma::{room_id, user_id},
        test_utils::mocks::MatrixMockServer,
    };
    use matrix_sdk_test::{
        InvitedRoomBuilder, JoinedRoomBuilder, stripped_state_event, sync_state_event,
    };

    use super::triage;

    #[tokio::test]
    async fn triage_reads_the_reason_and_classifies_each_inviter() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let own = client.user_id().unwrap().to_owned();
        let friend = user_id!("@friend:example.org");
        let stranger = user_id!("@stranger:example.org");
        let spammer = user_id!("@spammer:example.org");

        let invite = |room_id: &matrix_sdk::ruma::RoomId,
                      sender: &matrix_sdk::ruma::UserId,
                      reason: Option<&str>| {
            let mut content = serde_json::json!({ "membership": "invite" });
            if let Some(reason) = reason {
                content["reason"] = reason.into();
            }
            InvitedRoomBuilder::new(room_id).add_state_event(stripped_state_event!({
                "type": "m.room.member", "sender": sender, "state_key": own,
                "content": content
            }))
        };

        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_joined_room(
                    JoinedRoomBuilder::new(room_id!("!shared:example.org")).add_state_bulk([
                        sync_state_event!({
                            "type": "m.room.member", "sender": friend, "state_key": friend,
                            "event_id": "$friend", "origin_server_ts": 1,
                            "content": { "membership": "join" }
                        }),
                        sync_state_event!({
                            "type": "m.room.member", "sender": own, "state_key": spammer,
                            "event_id": "$spammer", "origin_server_ts": 2,
                            "content": { "membership": "ban" }
                        }),
                    ]),
                );
                builder.add_invited_room(invite(
                    room_id!("!from-friend:example.org"),
                    friend,
                    Some("  come along  "),
                ));
                builder.add_invited_room(invite(
                    room_id!("!from-stranger:example.org"),
                    stranger,
                    Some(" "),
                ));
                builder.add_invited_room(invite(
                    room_id!("!from-spammer:example.org"),
                    spammer,
                    None,
                ));
            })
            .await;

        let mut invites = triage(&client).await;
        invites.sort_by(|left, right| left.room_id.cmp(&right.room_id));
        let summary: Vec<_> = invites
            .iter()
            .map(|invite| {
                (
                    invite.room_id.as_str(),
                    invite
                        .inviter
                        .as_deref()
                        .map(matrix_sdk::ruma::UserId::as_str),
                    invite.reason.as_deref(),
                    invite.shares_room,
                    invite.inviter_banned,
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                (
                    "!from-friend:example.org",
                    Some("@friend:example.org"),
                    Some("come along"),
                    true,
                    false,
                ),
                (
                    "!from-spammer:example.org",
                    Some("@spammer:example.org"),
                    None,
                    false,
                    true,
                ),
                (
                    "!from-stranger:example.org",
                    Some("@stranger:example.org"),
                    None,
                    false,
                    false,
                ),
            ]
        );
        drop(server);
    }

    #[tokio::test]
    async fn triage_is_empty_without_invites() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                builder.add_joined_room(JoinedRoomBuilder::new(room_id!("!room:example.org")));
            })
            .await;

        assert!(triage(&client).await.is_empty());
        drop(server);
    }
}
