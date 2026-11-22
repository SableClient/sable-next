//! Which servers to name when pointing at a room by id.

use std::collections::HashMap;

use matrix_sdk::deserialized_responses::SyncOrStrippedState;
use matrix_sdk::ruma::events::StateEventType;
use matrix_sdk::ruma::events::room::server_acl::RoomServerAclEventContent;
use matrix_sdk::ruma::events::room::tombstone::RoomTombstoneEventContent;
use matrix_sdk::ruma::events::space::child::SpaceChildEventContent;
use matrix_sdk::ruma::{OwnedServerName, RoomId, ServerName, UserId};
use matrix_sdk::{Client, Room, RoomMemberships, RoomState};

const MAX_SERVERS: usize = 3;
const MODERATOR: i64 = 50;

/// One to three distinct servers to reach a room through.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Route(Vec<OwnedServerName>);

impl Route {
    pub(crate) fn new(servers: impl IntoIterator<Item = OwnedServerName>) -> Option<Self> {
        let mut route = Vec::with_capacity(MAX_SERVERS);
        for server in servers {
            if route.len() == MAX_SERVERS {
                break;
            }
            if !route.contains(&server) {
                route.push(server);
            }
        }
        (!route.is_empty()).then_some(Self(route))
    }

    /// Can wait on the homeserver for the full member list.
    pub(crate) async fn of(room: &Room) -> Option<Self> {
        if let Err(error) = room.sync_members().await {
            tracing::warn!(room = %room.room_id(), %error, "routing from the members already synced");
        }
        Self::cached(room).await
    }

    pub(crate) async fn cached(room: &Room) -> Option<Self> {
        let acl = server_acl(room).await;
        let members = room
            .members_no_sync(RoomMemberships::JOIN)
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(room = %room.room_id(), %error, "room members unreadable for routing");
                Vec::new()
            });
        let eligible: Vec<(&UserId, i64)> = members
            .iter()
            .filter(|member| {
                let server = member.user_id().server_name();
                !server.is_ip_literal() && allowed(server, acl.as_ref())
            })
            .map(|member| {
                let power = crate::view::clamp_power_level(member.power_level());
                (member.user_id(), power)
            })
            .collect();
        match Self::ranked(&eligible) {
            Some(route) => Some(route),
            None => Self::resident(room, acl.as_ref()).await,
        }
    }

    /// Skips ranking, for image packs: they are listed too often to read every member.
    pub(crate) async fn unranked(room: &Room) -> Option<Self> {
        let acl = server_acl(room).await;
        match Self::resident(room, acl.as_ref()).await {
            Some(route) => Some(route),
            None => Self::cached(room).await,
        }
    }

    /// For a room someone else named: looking it up would reveal whether we are in it.
    pub(crate) fn claimed_by(sender: &UserId) -> Option<Self> {
        let server = sender.server_name();
        if server.is_ip_literal() {
            return None;
        }
        Self::new([server.to_owned()])
    }

    /// Only spaces we manage are trusted, as the route gets copied into another space.
    pub(crate) async fn listed(client: &Client, room_id: &RoomId) -> Option<Self> {
        let me = client.user_id()?;
        for space in client.joined_space_rooms() {
            let Ok(Some(event)) = space
                .get_state_event_static_for_key::<SpaceChildEventContent, _>(room_id)
                .await
            else {
                continue;
            };
            let managed = space
                .power_levels()
                .await
                .is_ok_and(|levels| levels.user_can_send_state(me, StateEventType::SpaceChild));
            if managed
                && let Ok(SyncOrStrippedState::Sync(event)) = event.deserialize()
                && let Some(event) = event.as_original()
                && let Some(route) = Self::new(event.content.via.clone())
            {
                return Some(route);
            }
        }
        None
    }

    /// The spec's order: the top moderator's server, then the most populous.
    fn ranked(members: &[(&UserId, i64)]) -> Option<Self> {
        // Ties on power level go to the lower user id, so the same room yields the
        // same link from every client.
        let leader = members
            .iter()
            .filter(|(_, power)| *power >= MODERATOR)
            .max_by(|(left_id, left), (right_id, right)| {
                left.cmp(right).then_with(|| right_id.cmp(left_id))
            })
            .map(|(user_id, _)| user_id.server_name());

        let mut population: HashMap<&ServerName, usize> = HashMap::new();
        for (user_id, _) in members {
            *population.entry(user_id.server_name()).or_default() += 1;
        }
        let mut by_population: Vec<(&ServerName, usize)> = population.into_iter().collect();
        by_population.sort_by(|(left_server, left), (right_server, right)| {
            right.cmp(left).then_with(|| left_server.cmp(right_server))
        });

        let servers = by_population.into_iter().map(|(server, _)| server);
        Self::new(leader.into_iter().chain(servers).map(ToOwned::to_owned))
    }

    /// Our server may be an IP literal, as a room with nobody else has no other route.
    async fn resident(room: &Room, acl: Option<&RoomServerAclEventContent>) -> Option<Self> {
        let server = match room.state() {
            RoomState::Joined => room.client().user_id()?.server_name().to_owned(),
            RoomState::Invited => {
                let inviter = room.invite_details().await.ok()?.inviter_id;
                let server = inviter.server_name();
                if server.is_ip_literal() {
                    return None;
                }
                server.to_owned()
            }
            _ => return None,
        };
        if !allowed(&server, acl) {
            return None;
        }
        Self::new([server])
    }

    pub(crate) fn servers(&self) -> &[OwnedServerName] {
        &self.0
    }

    pub(crate) fn into_servers(self) -> Vec<OwnedServerName> {
        self.0
    }

    pub(crate) fn to_strings(&self) -> Vec<String> {
        self.0.iter().map(ToString::to_string).collect()
    }
}

/// Join hints for `room`'s successor, never advertised. Whoever upgraded it is in the new room,
/// so the old ACL does not apply to them.
pub(crate) async fn upgrade_servers(room: &Room) -> Vec<OwnedServerName> {
    let mut servers: Vec<_> = tombstone_server(room).await.into_iter().collect();
    if let Some(route) = Route::of(room).await {
        servers.extend(route.into_servers());
    }
    servers
}

fn allowed(server: &ServerName, acl: Option<&RoomServerAclEventContent>) -> bool {
    acl.is_none_or(|acl| acl.is_allowed(server))
}

async fn server_acl(room: &Room) -> Option<RoomServerAclEventContent> {
    let event = room
        .get_state_event_static::<RoomServerAclEventContent>()
        .await
        .ok()??
        .deserialize()
        .ok()?;
    match event {
        SyncOrStrippedState::Sync(event) => event.as_original().map(|event| event.content.clone()),
        SyncOrStrippedState::Stripped(event) => Some(event.content),
    }
}

async fn tombstone_server(room: &Room) -> Option<OwnedServerName> {
    let event = room
        .get_state_event_static::<RoomTombstoneEventContent>()
        .await
        .ok()??
        .deserialize()
        .ok()?;
    let sender = match &event {
        SyncOrStrippedState::Sync(event) => &event.as_original()?.sender,
        SyncOrStrippedState::Stripped(event) => &event.sender,
    };
    Some(sender.server_name().to_owned())
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::events::AnySyncStateEvent;
    use matrix_sdk::ruma::{OwnedUserId, room_id, serde::Raw};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_test::{InvitedRoomBuilder, JoinedRoomBuilder, LeftRoomBuilder};
    use serde_json::{Value, json};
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path_regex},
    };

    use super::*;

    fn ranked(entries: &[(&str, i64)]) -> Vec<String> {
        let users: Vec<(OwnedUserId, i64)> = entries
            .iter()
            .map(|(user, power)| (UserId::parse(*user).unwrap(), *power))
            .collect();
        let members: Vec<(&UserId, i64)> = users
            .iter()
            .map(|(user, power)| (&**user, *power))
            .collect();
        Route::ranked(&members)
            .map(|route| route.to_strings())
            .unwrap_or_default()
    }

    fn state(kind: &str, key: &str, sender: &str, content: &Value) -> Raw<AnySyncStateEvent> {
        Raw::new(&json!({
            "type": kind, "state_key": key, "event_id": format!("${kind}{key}"),
            "sender": sender, "origin_server_ts": 1, "content": content,
        }))
        .unwrap()
        .cast_unchecked()
    }

    fn joined(user: &str) -> Raw<AnySyncStateEvent> {
        state("m.room.member", user, user, &json!({"membership": "join"}))
    }

    fn acl(denied: &str) -> Raw<AnySyncStateEvent> {
        let content = json!({"allow": ["*"], "deny": [denied], "allow_ip_literals": true});
        state("m.room.server_acl", "", "@a:one.example", &content)
    }

    #[test]
    fn leads_with_the_server_of_the_highest_moderator() {
        let servers = ranked(&[
            ("@a:crowded.example", 0),
            ("@b:crowded.example", 0),
            ("@admin:quiet.example", 100),
        ]);

        assert_eq!(servers, ["quiet.example", "crowded.example"]);
    }

    #[test]
    fn ignores_a_user_below_the_moderator_threshold() {
        let servers = ranked(&[
            ("@a:crowded.example", 0),
            ("@b:crowded.example", 0),
            ("@almost:quiet.example", 49),
        ]);

        assert_eq!(servers, ["crowded.example", "quiet.example"]);
    }

    #[test]
    fn fills_the_remaining_slots_by_population() {
        let servers = ranked(&[
            ("@admin:first.example", 100),
            ("@a:second.example", 0),
            ("@b:second.example", 0),
            ("@c:second.example", 0),
            ("@d:third.example", 0),
            ("@e:third.example", 0),
            ("@f:fourth.example", 0),
        ]);

        assert_eq!(
            servers,
            ["first.example", "second.example", "third.example"]
        );
    }

    #[test]
    fn never_advertises_the_same_server_twice() {
        let servers = ranked(&[
            ("@admin:one.example", 100),
            ("@a:one.example", 0),
            ("@b:one.example", 0),
            ("@c:two.example", 0),
        ]);

        assert_eq!(servers, ["one.example", "two.example"]);
    }

    #[test]
    fn supplies_only_what_the_room_has() {
        assert_eq!(ranked(&[("@a:one.example", 0)]), ["one.example"]);
        assert_eq!(ranked(&[]), Vec::<String>::new());
    }

    #[test]
    fn breaks_ties_deterministically() {
        let (alpha, beta) = (("@a:alpha.example", 100), ("@b:beta.example", 100));
        assert_eq!(ranked(&[beta, alpha]), ranked(&[alpha, beta]));
        assert_eq!(ranked(&[beta, alpha])[0], "alpha.example");

        assert_eq!(
            ranked(&[("@b:beta.example", 0), ("@a:alpha.example", 0)]),
            ["alpha.example", "beta.example"]
        );
    }

    #[tokio::test]
    async fn only_eligible_servers_are_advertised() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!old");
        let tombstone = json!({"body": "moved", "replacement_room": "!new"});
        let mut room = JoinedRoomBuilder::new(room_id)
            .add_state_event(acl("banned.example"))
            .add_state_event(state(
                "m.room.tombstone",
                "",
                "@x:banned.example",
                &tombstone,
            ));
        for user in [
            "@a:192.0.2.1",
            "@b:banned.example",
            "@c:one.example",
            "@d:two.example",
        ] {
            room = room.add_state_event(joined(user));
        }
        server.sync_room(&client, room).await;

        let route = Route::cached(&client.get_room(room_id).unwrap()).await;

        assert_eq!(route.unwrap().to_strings(), ["one.example", "two.example"]);
    }

    #[tokio::test]
    async fn upgrade_routes_include_the_tombstone_sender() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let room_id = room_id!("!old:example.org");
        let content = json!({"body": "upgraded", "replacement_room": "!new:example.org"});
        let sender = "@upgrader:[2001:db8::1]:8448";
        let room = JoinedRoomBuilder::new(room_id).add_state_event(state(
            "m.room.tombstone",
            "",
            sender,
            &content,
        ));
        server.sync_room(&client, room).await;

        let via = upgrade_servers(&client.get_room(room_id).unwrap()).await;

        assert_eq!(via, ["[2001:db8::1]:8448", "localhost"]);
    }

    #[tokio::test]
    async fn via_servers_fall_back_to_our_own_server() {
        for response in [
            ResponseTemplate::new(200).set_body_json(json!({"chunk": []})),
            ResponseTemplate::new(403).set_body_json(json!({"errcode": "M_FORBIDDEN"})),
        ] {
            let server = MatrixMockServer::new().await;
            let client = server.client_builder().build().await;
            let room_id = room_id!("!opaque");
            server.sync_joined_room(&client, room_id).await;
            Mock::given(method("GET"))
                .and(path_regex("/members"))
                .respond_with(response)
                .mount(server.server())
                .await;

            let route = Route::of(&client.get_room(room_id).unwrap()).await;

            assert_eq!(route.unwrap().to_strings(), ["localhost"]);
        }
    }

    #[tokio::test]
    async fn the_fallback_is_a_server_known_to_be_in_the_room() {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let (banned, invited, left) =
            (room_id!("!banned"), room_id!("!invited"), room_id!("!left"));
        let invite = Raw::new(&json!({
            "type": "m.room.member", "state_key": client.user_id().unwrap(),
            "sender": "@host:host.example", "content": {"membership": "invite"},
        }))
        .unwrap()
        .cast_unchecked();
        let room = JoinedRoomBuilder::new(banned).add_state_event(acl("localhost"));
        server.sync_room(&client, room).await;
        let room = InvitedRoomBuilder::new(invited).add_state_event(invite);
        server.sync_room(&client, room).await;
        server.sync_room(&client, LeftRoomBuilder::new(left)).await;

        let route = async |id| Route::cached(&client.get_room(id).unwrap()).await;

        assert_eq!(route(banned).await, None);
        assert_eq!(route(invited).await.unwrap().to_strings(), ["host.example"]);
        assert_eq!(route(left).await, None);
    }
}
