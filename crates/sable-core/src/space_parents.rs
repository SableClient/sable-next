use std::collections::{BTreeMap, HashMap, HashSet};

use matrix_sdk::executor::spawn;
use matrix_sdk::ruma::events::{
    StateEventType,
    room::power_levels::{RoomPowerLevels, RoomPowerLevelsEventContent},
};
use matrix_sdk::ruma::{
    OwnedRoomId, OwnedServerName, OwnedUserId, RoomId, RoomVersionId, ServerName, UserId,
};
use matrix_sdk_base::deserialized_responses::RawAnySyncOrStrippedState;
use serde::Deserialize;
use serde_json::Value;
use serde_with::{DefaultOnError, VecSkipError, serde_as};

pub(crate) type ParentSpaceLinks = BTreeMap<OwnedRoomId, Vec<(OwnedRoomId, Vec<String>)>>;
pub(crate) type ParentResult = (
    OwnedRoomId,
    u64,
    Vec<(OwnedRoomId, OwnedUserId, Option<bool>)>,
);
type VerdictKey = (OwnedRoomId, OwnedRoomId, OwnedUserId);

pub(crate) struct ParentTracker {
    pub(crate) links: ParentSpaceLinks,
    claims: HashMap<OwnedRoomId, Vec<ParentClaim>>,
    eligible: HashMap<OwnedRoomId, Vec<ParentClaim>>,
    local: HashMap<OwnedRoomId, Vec<ParentClaim>>,
    verdicts: HashMap<VerdictKey, bool>,
    fetching: HashMap<OwnedRoomId, u64>,
    version: u64,
    results: tokio::sync::mpsc::UnboundedSender<ParentResult>,
}

impl ParentTracker {
    pub(crate) fn new(results: tokio::sync::mpsc::UnboundedSender<ParentResult>) -> Self {
        Self {
            links: ParentSpaceLinks::new(),
            claims: HashMap::new(),
            eligible: HashMap::new(),
            local: HashMap::new(),
            verdicts: HashMap::new(),
            fetching: HashMap::new(),
            version: 0,
            results,
        }
    }

    pub(crate) fn apply(
        &mut self,
        client: &matrix_sdk::Client,
        (parent, version, verdicts): ParentResult,
    ) -> bool {
        if self.fetching.get(&parent) != Some(&version) {
            return false;
        }
        self.fetching.remove(&parent);
        let mut answered = HashSet::new();
        for (child, sender, verdict) in &verdicts {
            let key = (child.clone(), parent.clone(), sender.clone());
            if let Some(verdict) = verdict
                && self.eligible.contains_key(child)
            {
                self.verdicts.insert(key.clone(), *verdict);
            }
            answered.insert(key);
        }
        self.fetch_missing(client, &answered);
        for (child, _, _) in &verdicts {
            self.settle(child, &answered);
        }
        true
    }

    fn invalidate(&mut self, parent: &RoomId, sender: Option<&UserId>) {
        self.verdicts
            .retain(|(_, p, s), _| p != parent || sender.is_some_and(|user| user != s));
        self.fetching.remove(parent);
    }

    fn unresolved(&self, child: &RoomId, claim: &ParentClaim) -> Option<VerdictKey> {
        let parent = claim.room_id().filter(|parent| parent != child)?;
        let sender = claim.sender.clone()?;
        if self.local.get(child).is_some_and(|local| {
            local
                .iter()
                .any(|accepted| accepted.state_key == claim.state_key)
        }) {
            return None;
        }
        let key = (child.to_owned(), parent, sender);
        (!self.verdicts.contains_key(&key)).then_some(key)
    }

    fn fetch_missing(&mut self, client: &matrix_sdk::Client, exclude: &HashSet<VerdictKey>) {
        let mut wanted: HashMap<OwnedRoomId, Vec<(OwnedRoomId, OwnedUserId)>> = HashMap::new();
        for (child, claims) in &self.eligible {
            for claim in claims {
                if let Some(key) = self.unresolved(child, claim)
                    && !exclude.contains(&key)
                    && !self.fetching.contains_key(&key.1)
                {
                    wanted.entry(key.1).or_default().push((key.0, key.2));
                }
            }
        }
        for (parent, pairs) in wanted {
            self.version += 1;
            let version = self.version;
            self.fetching.insert(parent.clone(), version);
            let client = client.clone();
            let results = self.results.clone();
            drop(spawn(async move {
                let state = fetch_state(&client, parent.clone()).await;
                let verdicts = pairs
                    .into_iter()
                    .map(|(child, sender)| {
                        let verdict = state
                            .as_ref()
                            .map(|state| legitimate(state, &child, &sender));
                        (child, sender, verdict)
                    })
                    .collect();
                let _ = results.send((parent, version, verdicts));
            }));
        }
    }

    fn settle(&mut self, child: &RoomId, answered: &HashSet<VerdictKey>) {
        let Some(eligible) = self.eligible.get(child) else {
            return;
        };
        let pending = eligible.iter().any(|claim| {
            self.unresolved(child, claim)
                .is_some_and(|key| !answered.contains(&key))
        });
        if pending && self.links.contains_key(child) {
            return;
        }
        let mut accepted: Vec<_> = self
            .local
            .get(child)
            .into_iter()
            .flatten()
            .chain(eligible.iter().filter(|claim| {
                claim
                    .room_id()
                    .zip(claim.sender.clone())
                    .is_some_and(|(parent, sender)| {
                        self.verdicts
                            .get(&(child.to_owned(), parent, sender))
                            .copied()
                            .unwrap_or(false)
                    })
            }))
            .cloned()
            .collect();
        order(&mut accepted);
        let parents = accepted
            .into_iter()
            .filter_map(|claim| claim.room_id().map(|id| (id, claim.content.via)))
            .collect();
        self.links.insert(child.to_owned(), parents);
    }

    pub(crate) async fn refresh(
        &mut self,
        core: &std::sync::Arc<crate::Core>,
        client: &matrix_sdk::Client,
        listed: &HashSet<OwnedRoomId>,
        rooms: &HashSet<OwnedRoomId>,
        spaces: &HashSet<OwnedRoomId>,
        members: &HashSet<(OwnedRoomId, OwnedUserId)>,
    ) {
        self.claims.retain(|room, _| listed.contains(room));
        self.eligible.retain(|room, _| listed.contains(room));
        self.local.retain(|room, _| listed.contains(room));
        self.links.retain(|room, _| listed.contains(room));
        self.verdicts
            .retain(|(room, _, _), _| listed.contains(room));
        let reads = rooms
            .intersection(listed)
            .filter_map(|room_id| client.get_room(room_id))
            .map(|room| async move { (room.room_id().to_owned(), claims(core, &room).await) });
        for (room_id, claims) in futures_util::future::join_all(reads).await {
            if let Some(claims) = claims {
                self.claims.insert(room_id, claims);
            }
        }
        let mut spaces = spaces.clone();
        for space in &spaces {
            self.invalidate(space, None);
        }
        for (space, user) in members {
            if self.claims.values().flatten().any(|claim| {
                claim.sender.as_deref() == Some(user.as_ref())
                    && claim.room_id().as_ref() == Some(space)
            }) {
                self.invalidate(space, Some(user));
                spaces.insert(space.clone());
            }
        }
        let affected = self
            .claims
            .iter()
            .filter(|(room, claims)| {
                rooms.contains(*room)
                    || claims
                        .iter()
                        .any(|claim| claim.room_id().is_some_and(|id| spaces.contains(&id)))
            })
            .map(|(room, claims)| (room.clone(), claims.clone()));
        let validated = futures_util::future::join_all(affected.map(|(room, claims)| async move {
            let claims: Vec<_> = claims
                .into_iter()
                .filter(|claim| {
                    claim
                        .room_id()
                        .and_then(|id| client.get_room(&id))
                        .is_some_and(|space| space.state() == matrix_sdk::RoomState::Joined)
                })
                .collect();
            let local = validate(core, client, &room, &claims, false).await;
            (room, claims, local)
        }))
        .await;
        let validated_rooms: Vec<_> = validated.iter().map(|(room, _, _)| room.clone()).collect();
        for (room, eligible, local) in validated {
            self.eligible.insert(room.clone(), eligible);
            self.local.insert(room, local);
        }
        self.fetch_missing(client, &HashSet::new());
        for room in validated_rooms {
            self.settle(&room, &HashSet::new());
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ParentClaim {
    #[serde(rename = "type", default)]
    pub event_type: String,
    pub state_key: String,
    #[serde(default)]
    pub sender: Option<OwnedUserId>,
    #[serde(default)]
    pub content: ParentContent,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct ParentContent {
    #[serde(default)]
    pub canonical: bool,
    #[serde(default)]
    pub via: Vec<String>,
}

impl ParentClaim {
    pub(crate) fn room_id(&self) -> Option<OwnedRoomId> {
        if self.sender.is_none()
            || self.content.via.is_empty()
            || self
                .content
                .via
                .iter()
                .any(|via| ServerName::parse(via).is_err())
        {
            return None;
        }
        RoomId::parse(&self.state_key).ok()
    }
}

pub(crate) async fn claims(
    core: &crate::Core,
    room: &matrix_sdk::Room,
) -> Option<Vec<ParentClaim>> {
    let events = core
        .with_open_stores(async || room.get_state_events(StateEventType::SpaceParent).await)
        .await
        .ok()?;
    Some(
        events
            .iter()
            .filter_map(|event| {
                let raw = match event {
                    RawAnySyncOrStrippedState::Sync(raw) => raw.json(),
                    RawAnySyncOrStrippedState::Stripped(raw) => raw.json(),
                };
                serde_json::from_str(raw.get()).ok()
            })
            .collect(),
    )
}

pub(crate) async fn parents(
    core: &crate::Core,
    room: &matrix_sdk::Room,
) -> Vec<(OwnedRoomId, Vec<String>)> {
    let claims = claims(core, room).await.unwrap_or_default();
    validate(core, &room.client(), room.room_id(), &claims, true)
        .await
        .into_iter()
        .filter_map(|parent| parent.room_id().map(|id| (id, parent.content.via)))
        .collect()
}

pub(crate) async fn validate(
    core: &crate::Core,
    client: &matrix_sdk::Client,
    child: &RoomId,
    claims: &[ParentClaim],
    network: bool,
) -> Vec<ParentClaim> {
    let mut accepted = Vec::new();
    for claim in claims {
        let Some(parent) = claim.room_id().filter(|parent| parent != child) else {
            continue;
        };
        let Some(sender) = claim.sender.as_deref() else {
            continue;
        };
        let mut state = Vec::new();
        if let Some(room) = client.get_room(&parent) {
            for (kind, key) in [
                (StateEventType::RoomCreate, ""),
                (StateEventType::RoomMember, sender.as_str()),
                (StateEventType::RoomPowerLevels, ""),
                (StateEventType::SpaceChild, child.as_str()),
            ] {
                if let Ok(Some(raw)) = core
                    .with_open_stores(async || room.get_state_event(kind, key).await)
                    .await
                {
                    let raw = match raw {
                        RawAnySyncOrStrippedState::Sync(raw) => raw.json().to_owned(),
                        RawAnySyncOrStrippedState::Stripped(raw) => raw.json().to_owned(),
                    };
                    if let Ok(value) = serde_json::from_str(raw.get()) {
                        state.push(value);
                    }
                }
            }
        }
        let mut valid = legitimate(&state, child, sender);
        if !valid
            && network
            && let Some(state) = fetch_state(client, parent).await
        {
            valid = legitimate(&state, child, sender);
        }
        if valid {
            accepted.push(claim.clone());
        }
    }
    order(&mut accepted);
    accepted
}

fn order(accepted: &mut Vec<ParentClaim>) {
    accepted.sort_by(|left, right| {
        right
            .content
            .canonical
            .cmp(&left.content.canonical)
            .then_with(|| left.state_key.cmp(&right.state_key))
    });
    accepted.dedup_by(|left, right| left.state_key == right.state_key);
}

async fn fetch_state(client: &matrix_sdk::Client, parent: OwnedRoomId) -> Option<Vec<Value>> {
    use matrix_sdk::{config::RequestConfig, ruma::api::client::state::get_state_events};
    let response = client
        .send(get_state_events::v3::Request::new(parent))
        .with_request_config(
            RequestConfig::new()
                .timeout(std::time::Duration::from_secs(15))
                .disable_retry(),
        )
        .await
        .ok()?;
    Some(
        response
            .room_state
            .iter()
            .filter_map(|raw| raw.deserialize_as_unchecked::<Value>().ok())
            .collect(),
    )
}

#[serde_as]
#[derive(Deserialize)]
struct StateEventIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    state_key: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    sender: Option<String>,
    #[serde(default)]
    content: Value,
}

#[serde_as]
#[derive(Default, Deserialize)]
struct CreateContentIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    room_version: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    creator: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    additional_creators: Vec<String>,
}

#[serde_as]
#[derive(Default, Deserialize)]
struct ChildContentIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    via: Option<Vec<OwnedServerName>>,
}

#[serde_as]
#[derive(Default, Deserialize)]
struct MemberContentIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    membership: Option<String>,
}

fn content_of<T: Default + serde::de::DeserializeOwned>(event: &StateEventIn) -> T {
    T::deserialize(&event.content).unwrap_or_default()
}

fn legitimate(state: &[Value], child: &RoomId, sender: &UserId) -> bool {
    let state: Vec<StateEventIn> = state
        .iter()
        .filter_map(|event| StateEventIn::deserialize(event).ok())
        .collect();
    let Some(create) = state.iter().find(|event| {
        event.kind.as_deref() == Some("m.room.create") && event.state_key.as_deref() == Some("")
    }) else {
        return false;
    };
    let create_content: CreateContentIn = content_of(create);
    if create_content.kind.as_deref() != Some("m.space") {
        return false;
    }
    if let Some(child_event) = state.iter().find(|event| {
        event.kind.as_deref() == Some("m.space.child")
            && event.state_key.as_deref() == Some(child.as_str())
    }) {
        return content_of::<ChildContentIn>(child_event)
            .via
            .is_some_and(|via| !via.is_empty());
    }
    if !state.iter().any(|event| {
        event.kind.as_deref() == Some("m.room.member")
            && event.state_key.as_deref() == Some(sender.as_str())
            && content_of::<MemberContentIn>(event).membership.as_deref() == Some("join")
    }) {
        return false;
    }
    let Ok(version) =
        RoomVersionId::try_from(create_content.room_version.as_deref().unwrap_or("1"))
    else {
        return false;
    };
    let Some(rules) = version.rules() else {
        return false;
    };
    let mut creators = create_content
        .creator
        .as_deref()
        .or(create.sender.as_deref())
        .and_then(|id| UserId::parse(id).ok())
        .into_iter()
        .collect::<Vec<_>>();
    creators.extend(
        create_content
            .additional_creators
            .iter()
            .filter_map(|id| UserId::parse(id).ok()),
    );
    let levels = match state.iter().find(|event| {
        event.kind.as_deref() == Some("m.room.power_levels")
            && event.state_key.as_deref() == Some("")
    }) {
        Some(event) => {
            match serde_json::from_value::<RoomPowerLevelsEventContent>(event.content.clone()) {
                Ok(content) => Some(content),
                Err(_) => return false,
            }
        }
        None => None,
    };
    RoomPowerLevels::new(levels.into(), &rules.authorization, creators)
        .user_can_send_state(sender, StateEventType::SpaceChild)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use matrix_sdk::{
        ruma::{OwnedRoomId, OwnedUserId, room_id, serde::Raw, user_id},
        test_utils::mocks::MatrixMockServer,
    };
    use matrix_sdk_test::JoinedRoomBuilder;
    use serde_json::json;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };

    #[test]
    fn a_parent_requires_an_active_reciprocal_edge_or_an_authorized_sender() {
        let child = room_id!("!child:example.org");
        let sender = user_id!("@alice:example.org");
        let mut state = vec![
            json!({"type": "m.room.create", "state_key": "", "sender": "@owner:example.org", "content": {"type": "m.space"}}),
            json!({"type": "m.space.child", "state_key": child, "content": {"via": ["example.org"]}}),
        ];
        assert!(super::legitimate(&state, child, sender));
        state[1]["content"] = json!({"via": []});
        state.push(json!({"type": "m.room.member", "state_key": sender, "content": {"membership": "join"}}));
        state.push(json!({"type": "m.room.power_levels", "state_key": "", "content": {"users": {sender: 50}, "events": {"m.space.child": 50}}}));
        assert!(!super::legitimate(&state, child, sender));

        state.remove(1);
        assert!(super::legitimate(&state, child, sender));
        state[2]["content"]["users"][sender.as_str()] = json!(49);
        assert!(!super::legitimate(&state, child, sender));
    }

    #[test]
    fn room_v12_creator_can_claim_a_parent_without_a_child_event() {
        let child = room_id!("!TSu72vOzgRWPPXopf7dUlfzwXvrBCKMGerwFTWkXtpA");
        let sender = user_id!("@seven:sable.moe");
        let mut state = vec![
            json!({"type": "m.room.create", "state_key": "", "sender": sender, "content": {"type": "m.space", "room_version": "12", "additional_creators": ["@7w1:matrix.org"]}}),
            json!({"type": "m.room.member", "state_key": sender, "content": {"membership": "join"}}),
            json!({"type": "m.room.power_levels", "state_key": "", "content": {"state_default": 50, "users": {}}}),
        ];
        assert!(super::legitimate(&state, child, sender));
        state[1]["content"]["membership"] = json!("leave");
        assert!(!super::legitimate(&state, child, sender));
    }

    const SPACE: &str = "!space:example.org";
    const SENDER: &str = "@alice:example.org";

    fn event(kind: &str, key: &str, content: &serde_json::Value) -> serde_json::Value {
        json!({
            "type": kind, "state_key": key, "sender": SENDER,
            "event_id": format!("${kind}-{key}"), "origin_server_ts": 1, "content": content
        })
    }

    struct Harness {
        _server: MatrixMockServer,
        core: std::sync::Arc<crate::Core>,
        client: matrix_sdk::Client,
        tracker: super::ParentTracker,
        results: tokio::sync::mpsc::UnboundedReceiver<super::ParentResult>,
        child: OwnedRoomId,
        space: OwnedRoomId,
    }

    async fn harness(state_requests: u64) -> Harness {
        let server = MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let space = room_id!("!space:example.org");
        let child = room_id!("!room:example.org");
        let create = event(
            "m.room.create",
            "",
            &json!({"type": "m.space", "room_version": "12"}),
        );
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(space)
                    .add_state_event(Raw::new(&create).unwrap().cast_unchecked()),
            )
            .await;
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(child).add_state_event(
                    Raw::new(&event(
                        "m.space.parent",
                        SPACE,
                        &json!({"via": ["example.org"]}),
                    ))
                    .unwrap()
                    .cast_unchecked(),
                ),
            )
            .await;
        Mock::given(method("GET"))
            .and(path(format!("/_matrix/client/v3/rooms/{SPACE}/state")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                create,
                event("m.room.member", SENDER, &json!({"membership": "join"})),
                event("m.room.power_levels", "", &json!({"state_default": 50})),
            ])))
            .expect(state_requests)
            .mount(server.server())
            .await;
        let (core, _events) = crate::test_support::signed_in_core(&server, client.clone()).await;
        let (sender, results) = tokio::sync::mpsc::unbounded_channel();
        Harness {
            _server: server,
            core,
            client,
            tracker: super::ParentTracker::new(sender),
            results,
            child: child.to_owned(),
            space: space.to_owned(),
        }
    }

    impl Harness {
        async fn refresh(
            &mut self,
            rooms: &[&OwnedRoomId],
            spaces: &[&OwnedRoomId],
            members: &[(&OwnedRoomId, &str)],
        ) {
            let listed = HashSet::from([self.child.clone(), self.space.clone()]);
            self.tracker
                .refresh(
                    &self.core,
                    &self.client,
                    &listed,
                    &rooms.iter().map(|room| (*room).clone()).collect(),
                    &spaces.iter().map(|space| (*space).clone()).collect(),
                    &members
                        .iter()
                        .map(|(space, user)| {
                            ((*space).clone(), OwnedUserId::try_from(*user).unwrap())
                        })
                        .collect(),
                )
                .await;
        }

        async fn settle(&mut self) {
            let result =
                tokio::time::timeout(std::time::Duration::from_secs(5), self.results.recv())
                    .await
                    .unwrap()
                    .unwrap();
            assert!(self.tracker.apply(&self.client, result));
        }

        fn linked(&self) -> bool {
            self.tracker
                .links
                .get(&self.child)
                .is_some_and(|parents| parents.iter().any(|(id, _)| *id == self.space))
        }
    }

    #[tokio::test]
    async fn a_cached_network_verdict_avoids_refetching_the_parent_state() {
        let mut harness = harness(1).await;
        let child = harness.child.clone();
        harness.refresh(&[&child], &[], &[]).await;
        assert!(!harness.linked());
        harness.settle().await;
        assert!(harness.linked());
        harness.refresh(&[&child], &[], &[]).await;
        assert!(harness.linked());
        harness.results.try_recv().unwrap_err();
    }

    #[tokio::test]
    async fn a_member_who_sent_no_claim_does_not_revalidate_the_parent() {
        let mut harness = harness(1).await;
        let (child, space) = (harness.child.clone(), harness.space.clone());
        harness.refresh(&[&child], &[], &[]).await;
        harness.settle().await;
        harness
            .refresh(&[], &[], &[(&space, "@bob:example.org")])
            .await;
        assert!(harness.linked());
        harness.results.try_recv().unwrap_err();
    }

    #[tokio::test]
    async fn links_are_kept_while_a_network_check_is_pending() {
        let mut harness = harness(2).await;
        let (child, space) = (harness.child.clone(), harness.space.clone());
        harness.refresh(&[&child], &[], &[]).await;
        harness.settle().await;
        harness.refresh(&[], &[], &[(&space, SENDER)]).await;
        assert!(harness.linked());
        harness.settle().await;
        assert!(harness.linked());
    }
}
