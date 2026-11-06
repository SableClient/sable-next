#![expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "test code"
)]

use std::time::Duration;

use matrix_sdk::{RoomMemberships, ruma::OwnedRoomId};
use matrix_sdk_ui::sync_service::SyncService;
use serde_json::{Value, json};

use crate::{Core, protocol::CoreEvent, store::MemorySessionStore};

pub(crate) struct Account {
    token: String,
    pub(crate) user_id: String,
}

pub(crate) async fn register(http: &reqwest::Client, base: &str, name: &str) -> Account {
    let url = format!("{base}/_matrix/client/v3/register?kind=user");
    let probe = send(
        http,
        reqwest::Method::POST,
        &url,
        None,
        json!({"username": name, "password": "pw-pw-pw-1"}),
    )
    .await
    .1;
    let done = send(
        http,
        reqwest::Method::POST,
        &url,
        None,
        json!({"username": name, "password": "pw-pw-pw-1", "auth": {
            "type": "m.login.registration_token", "token": "sable-e2e",
            "session": probe["session"]}}),
    )
    .await
    .1;
    Account {
        token: done["access_token"].as_str().unwrap().to_owned(),
        user_id: done["user_id"].as_str().unwrap().to_owned(),
    }
}

async fn send(
    http: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    token: Option<&str>,
    body: Value,
) -> (bool, Value) {
    let mut request = http.request(method, url).body(body.to_string());
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.unwrap();
    let ok = response.status().is_success();
    (
        ok,
        serde_json::from_str(&response.text().await.unwrap()).unwrap(),
    )
}

async fn call(http: &reqwest::Client, base: &str, who: &Account, path: &str, body: Value) -> Value {
    let (ok, value) = send(
        http,
        reqwest::Method::POST,
        &format!("{base}/_matrix/client/v3{path}"),
        Some(&who.token),
        body,
    )
    .await;
    assert!(ok, "{path}: {value}");
    value
}

async fn announced(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<CoreEvent>,
    room: &OwnedRoomId,
) {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match events.recv().await {
                Some(CoreEvent::MembersChanged { room_id, .. }) if &room_id == room => return,
                Some(_) => {}
                None => panic!("closed"),
            }
        }
    })
    .await
    .expect("no MembersChanged");
}

type Transition<'a> = (&'a str, &'a str, Value, bool);

fn transitions(bob_id: &str) -> [Transition<'static>; 7] {
    [
        ("join", "/join/{room}", json!({}), true),
        ("leave", "/rooms/{room}/leave", json!({}), false),
        ("rejoin", "/join/{room}", json!({}), true),
        (
            "kick",
            "/rooms/{room}/kick",
            json!({"user_id": bob_id}),
            false,
        ),
        ("rejoin", "/join/{room}", json!({}), true),
        (
            "ban",
            "/rooms/{room}/ban",
            json!({"user_id": bob_id}),
            false,
        ),
        (
            "unban",
            "/rooms/{room}/unban",
            json!({"user_id": bob_id}),
            false,
        ),
    ]
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a homeserver at SABLE_TEST_HOMESERVER"]
async fn every_transition_reaches_the_member_list() {
    let base = std::env::var("SABLE_TEST_HOMESERVER").unwrap();
    let http = reqwest::Client::new();
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let alice = register(&http, &base, &format!("alice{suffix}")).await;
    let bob = register(&http, &base, &format!("bob{suffix}")).await;

    send(
        &http,
        reqwest::Method::PUT,
        &format!(
            "{base}/_matrix/client/v3/profile/{}/displayname",
            bob.user_id
        ),
        Some(&bob.token),
        json!({"displayname": "Bob Display"}),
    )
    .await;

    let client = matrix_sdk::Client::builder()
        .homeserver_url(&base)
        .build()
        .await
        .unwrap();
    client
        .matrix_auth()
        .login_username(&alice.user_id, "pw-pw-pw-1")
        .send()
        .await
        .unwrap();
    let (core, mut events) = Core::new("live", Box::new(MemorySessionStore::default()));
    core.watch_profile_changes(&client, 1);
    let sync = SyncService::builder(client.clone())
        .with_offline_mode()
        .build()
        .await
        .unwrap();
    sync.start().await;

    let room_id = call(
        &http,
        &base,
        &alice,
        "/createRoom",
        json!({"preset": "public_chat", "name": "members"}),
    )
    .await["room_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let room_id: OwnedRoomId = room_id.parse().unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        while client.get_room(&room_id).is_none() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap();
    let room = client.get_room(&room_id).unwrap();
    room.members(RoomMemberships::JOIN).await.unwrap();
    while events.try_recv().is_ok() {}

    let steps = transitions(&bob.user_id);
    for (name, path, body, joined) in steps {
        let actor = if matches!(name, "kick" | "ban" | "unban") {
            &alice
        } else {
            &bob
        };
        call(
            &http,
            &base,
            actor,
            &path.replace("{room}", room_id.as_str()),
            body,
        )
        .await;
        announced(&mut events, &room_id).await;
        let listed = room
            .members(RoomMemberships::JOIN)
            .await
            .unwrap()
            .into_iter()
            .find(|member| member.user_id().as_str() == bob.user_id);
        assert_eq!(listed.is_some(), joined, "after {name}");
        if let Some(listed) = listed {
            assert_eq!(listed.display_name(), Some("Bob Display"), "after {name}");
        }
    }
}
