use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{OwnedRoomId, RoomId, room_id};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_test::JoinedRoomBuilder;
use serde_json::{Value, json};
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

use super::{COLOR_EVENT, Layer, MEMBER_EVENT, PRONOUNS_EVENT, resolve};
use crate::Core;
use crate::protocol::{CoreEvent, PronounView, SenderCosmeticsView};
use crate::store::MemorySessionStore;

const ALICE: &str = "@alice:example.org";
const BOB: &str = "@bob:example.org";

fn layer(events: &[(&str, &str, Value)]) -> Layer {
    let mut layer = Layer::default();
    for (event_type, state_key, content) in events {
        layer.apply(event_type, state_key, content);
    }
    layer
}

fn state(event_type: &str, state_key: &str, content: &Value) -> Value {
    json!({
        "type": event_type,
        "state_key": state_key,
        "sender": ALICE,
        "event_id": format!("${event_type}-{state_key}"),
        "origin_server_ts": 1,
        "content": content,
    })
}

fn pronoun(summary: &str, language: Option<&str>) -> PronounView {
    PronounView {
        summary: summary.to_owned(),
        language: language.map(ToOwned::to_owned),
    }
}

#[test]
fn the_room_wins_over_the_space_per_field() {
    let room = layer(&[
        (
            MEMBER_EVENT,
            ALICE,
            json!({ "membership": "join", "eu.she-a.color": { "on_dark": "#111111" } }),
        ),
        (COLOR_EVENT, ALICE, json!({ "color": "#222222" })),
    ]);
    let space = layer(&[
        (
            MEMBER_EVENT,
            ALICE,
            json!({
                "membership": "join",
                "eu.she-a.color": { "on_light": "#333333", "on_dark": "#444444" }
            }),
        ),
        (
            PRONOUNS_EVENT,
            ALICE,
            json!({ "pronouns": [{ "summary": "she/her" }] }),
        ),
        (COLOR_EVENT, BOB, json!({ "color": "#555555" })),
    ]);

    assert_eq!(
        resolve(&room, Some(&space)),
        [
            SenderCosmeticsView {
                user_id: ALICE.try_into().unwrap(),
                color_on_light: Some("#222222".to_owned()),
                color_on_dark: Some("#111111".to_owned()),
                pronouns: vec![pronoun("she/her", None)],
                space_display_name: None,
                space_avatar_url: None,
            },
            SenderCosmeticsView {
                user_id: BOB.try_into().unwrap(),
                color_on_light: Some("#555555".to_owned()),
                color_on_dark: Some("#555555".to_owned()),
                pronouns: Vec::new(),
                space_display_name: None,
                space_avatar_url: None,
            },
        ]
    );
}

#[test]
fn hidden_space_names_are_not_inherited() {
    let room = layer(&[(MEMBER_EVENT, ALICE, json!({ "displayname": "Alice" }))]);
    let space = layer(&[(
        MEMBER_EVENT,
        ALICE,
        json!({ "displayname": "\u{200b}\u{2800}" }),
    )]);
    assert_eq!(resolve(&room, Some(&space)), Vec::new());
}

#[test]
fn the_space_name_and_picture_are_handed_on_beside_the_room_ones() {
    let room = layer(&[(
        MEMBER_EVENT,
        ALICE,
        json!({ "membership": "join", "displayname": "Room Alice" }),
    )]);
    let space = layer(&[(
        MEMBER_EVENT,
        ALICE,
        json!({
            "membership": "join",
            "displayname": "Space Alice",
            "avatar_url": "mxc://example.org/space"
        }),
    )]);

    let resolved = resolve(&room, Some(&space));

    assert_eq!(
        resolved[0].space_display_name.as_deref(),
        Some("Space Alice")
    );
    assert_eq!(
        resolved[0].space_avatar_url.as_deref(),
        Some("mxc://example.org/space")
    );
}

#[test]
fn a_member_without_cosmetics_is_left_out() {
    let room = layer(&[
        (MEMBER_EVENT, ALICE, json!({ "membership": "join" })),
        (COLOR_EVENT, BOB, json!({})),
        (COLOR_EVENT, ALICE, json!({ "color": "red" })),
    ]);

    assert_eq!(resolve(&room, None), Vec::<SenderCosmeticsView>::new());
}

#[test]
fn only_a_changed_value_counts_as_a_change() {
    let mut room = Layer::default();
    let colored = json!({ "membership": "join", "eu.she-a.color": { "on_dark": "#111111" } });
    let renamed = json!({
        "membership": "join",
        "displayname": "Alice",
        "eu.she-a.color": { "on_dark": "#111111" }
    });

    assert!(!room.apply(MEMBER_EVENT, ALICE, &json!({ "membership": "join" })));
    assert!(room.apply(MEMBER_EVENT, ALICE, &colored));
    assert!(room.apply(MEMBER_EVENT, ALICE, &renamed));
    assert!(!room.apply(MEMBER_EVENT, ALICE, &renamed));
    assert!(room.apply(MEMBER_EVENT, ALICE, &json!({ "membership": "leave" })));
    assert_eq!(resolve(&room, None), Vec::<SenderCosmeticsView>::new());
}

#[test]
fn legacy_font_events_are_ignored() {
    let mut room = Layer::default();
    assert!(!room.apply(
        "moe.sable.room.cosmetics.font",
        ALICE,
        &json!({ "font": "Georgia" })
    ));
    assert_eq!(resolve(&room, None), Vec::<SenderCosmeticsView>::new());
}

async fn joined(server: &MatrixMockServer, rooms: &[&RoomId]) -> matrix_sdk::Client {
    let client = server.client_builder().build().await;
    for room_id in rooms {
        server.sync_joined_room(&client, *room_id).await;
    }
    client
}

async fn reciprocal(
    server: &MatrixMockServer,
    client: &matrix_sdk::Client,
    parent: &RoomId,
    child: &RoomId,
) {
    server
        .sync_room(
            client,
            JoinedRoomBuilder::new(parent).add_state_bulk([
                Raw::new(&state(
                    "m.room.create",
                    "",
                    &json!({"type": "m.space", "creator": ALICE, "room_version": "10"}),
                ))
                .unwrap()
                .cast_unchecked(),
                Raw::new(&state(
                    "m.space.child",
                    child.as_str(),
                    &json!({"via": ["example.org"]}),
                ))
                .unwrap()
                .cast_unchecked(),
            ]),
        )
        .await;
}

async fn serve_state(server: &MatrixMockServer, room_id: &RoomId, events: Value, times: u64) {
    Mock::given(method("GET"))
        .and(path(format!("/_matrix/client/v3/rooms/{room_id}/state")))
        .respond_with(ResponseTemplate::new(200).set_body_json(events))
        .expect(times)
        .mount(server.server())
        .await;
}

async fn serve_member(server: &MatrixMockServer, room_id: &RoomId, content: &Value, times: u64) {
    Mock::given(method("GET"))
        .and(path(format!(
            "/_matrix/client/v3/rooms/{room_id}/state/m.room.member/{ALICE}"
        )))
        .respond_with(ResponseTemplate::new(200).set_body_json(content))
        .expect(times)
        .mount(server.server())
        .await;
}

async fn rename(
    server: &MatrixMockServer,
    client: &matrix_sdk::Client,
    room_id: &RoomId,
    old: &Value,
    new: &Value,
) {
    let mut renamed = state(MEMBER_EVENT, ALICE, new);
    renamed["event_id"] = json!("$renamed");
    renamed["unsigned"] = json!({ "prev_content": old });
    server
        .sync_room(
            client,
            JoinedRoomBuilder::new(room_id)
                .add_timeline_event(Raw::new(&renamed).unwrap().cast_unchecked()),
        )
        .await;
}

#[tokio::test]
async fn a_room_is_fetched_once_and_served_from_the_cache() {
    let server = MatrixMockServer::new().await;
    let room_id = room_id!("!room:example.org");
    let space_id = room_id!("!space:example.org");
    let client = joined(&server, &[room_id, space_id]).await;
    let (core, _events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
    crate::test_support::sign_in(&core, &server, client.clone()).await;
    let session = core.signed_in().unwrap();
    serve_state(
        &server,
        room_id,
        json!([
            state(COLOR_EVENT, ALICE, &json!({ "color": "#123456" })),
            state("m.room.name", "", &json!({ "name": "Room" })),
        ]),
        1,
    )
    .await;
    serve_state(
        &server,
        space_id,
        json!([state(
            PRONOUNS_EVENT,
            ALICE,
            &json!({ "pronouns": [{ "summary": "they/them", "language": "EN" }] })
        )]),
        1,
    )
    .await;
    let room = client.get_room(room_id).unwrap();

    for _ in 0..2 {
        let found = session
            .cosmetics_for(&room, Some(space_id.to_owned()))
            .await;
        assert_eq!(found.space_id.as_deref(), Some(space_id));
        assert_eq!(found.users.len(), 1);
        assert_eq!(found.users[0].color_on_light.as_deref(), Some("#123456"));
        assert_eq!(found.users[0].pronouns, [pronoun("they/them", Some("en"))]);
    }
}

#[tokio::test]
async fn concurrent_reads_of_one_room_share_a_single_fetch() {
    let server = MatrixMockServer::new().await;
    let room_id = room_id!("!room:example.org");
    let space_id = room_id!("!space:example.org");
    let client = joined(&server, &[room_id, space_id]).await;
    let (core, _events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
    crate::test_support::sign_in(&core, &server, client.clone()).await;
    let session = core.signed_in().unwrap();
    serve_state(
        &server,
        room_id,
        json!([state(COLOR_EVENT, ALICE, &json!({ "color": "#123456" }))]),
        1,
    )
    .await;
    serve_state(&server, space_id, json!([]), 1).await;
    let room = client.get_room(room_id).unwrap();

    let found = futures_util::future::join_all(
        (0..5).map(|_| session.cosmetics_for(&room, Some(space_id.to_owned()))),
    )
    .await;

    assert!(
        found
            .iter()
            .all(|view| view.users[0].color_on_light.as_deref() == Some("#123456"))
    );
}

#[tokio::test]
async fn only_parents_we_are_not_in_are_offered_canonical_first() {
    let server = MatrixMockServer::new().await;
    let room_id = room_id!("!room:example.org");
    let joined_space = room_id!("!joined:example.org");
    let client = joined(&server, &[joined_space]).await;
    reciprocal(&server, &client, joined_space, room_id).await;
    for id in ["!other:example.org", "!canonical:example.org"] {
        serve_state(
            &server,
            &RoomId::parse(id).unwrap(),
            json!([
                state(
                    "m.room.create",
                    "",
                    &json!({"type": "m.space", "creator": ALICE, "room_version": "10"})
                ),
                state(
                    "m.space.child",
                    room_id.as_str(),
                    &json!({"via": ["example.org"]})
                )
            ]),
            1,
        )
        .await;
    }
    let parent = |space: &str, content: Value| {
        Raw::new(&state("m.space.parent", space, &content))
            .unwrap()
            .cast_unchecked()
    };
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_state_bulk([
                parent(joined_space.as_str(), json!({ "via": ["example.org"] })),
                parent("!other:example.org", json!({ "via": ["other.org"] })),
                parent(
                    "!canonical:example.org",
                    json!({ "via": ["example.org"], "canonical": true }),
                ),
                parent("!stale:example.org", json!({ "via": [] })),
            ]),
        )
        .await;
    let room = client.get_room(room_id).unwrap();

    let (core, _events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
    let offered: Vec<(String, Vec<String>)> = super::unjoined_space_parents(&core, &client, &room)
        .await
        .into_iter()
        .map(|parent| (parent.room_id.to_string(), parent.via))
        .collect();
    assert_eq!(
        offered,
        [
            (
                "!canonical:example.org".to_owned(),
                vec!["example.org".to_owned()]
            ),
            (
                "!other:example.org".to_owned(),
                vec!["other.org".to_owned()]
            ),
        ]
    );
}

#[tokio::test]
async fn without_a_space_the_first_parent_is_used() {
    let server = MatrixMockServer::new().await;
    let room_id = room_id!("!room:example.org");
    let space_id = room_id!("!space:example.org");
    let client = joined(&server, &[space_id]).await;
    reciprocal(&server, &client, space_id, room_id).await;
    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_state_event(
                Raw::new(&state(
                    "m.space.parent",
                    space_id.as_str(),
                    &json!({ "via": ["example.org"] }),
                ))
                .unwrap()
                .cast_unchecked(),
            ),
        )
        .await;
    let (core, _events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
    crate::test_support::sign_in(&core, &server, client.clone()).await;
    let session = core.signed_in().unwrap();
    serve_state(&server, room_id, json!([]), 1).await;
    serve_state(
        &server,
        space_id,
        json!([state(COLOR_EVENT, ALICE, &json!({ "color": "#abcdef" }))]),
        1,
    )
    .await;

    let found = session
        .cosmetics_for(&client.get_room(room_id).unwrap(), None)
        .await;

    assert_eq!(found.space_id.as_deref(), Some(space_id));
    assert_eq!(found.users[0].color_on_dark.as_deref(), Some("#abcdef"));
}

#[tokio::test]
async fn a_synced_change_updates_the_cache_and_is_announced() {
    let server = MatrixMockServer::new().await;
    let room_id = room_id!("!room:example.org");
    let client = joined(&server, &[room_id]).await;
    let (core, mut events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
    crate::test_support::sign_in(&core, &server, client.clone()).await;
    let session = core.signed_in().unwrap();
    session.watch_cosmetics(1);
    serve_state(&server, room_id, json!([]), 1).await;
    let room = client.get_room(room_id).unwrap();
    assert_eq!(
        session.cosmetics_for(&room, None).await.users,
        Vec::<SenderCosmeticsView>::new()
    );

    server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id).add_timeline_event(
                Raw::new(&state(COLOR_EVENT, ALICE, &json!({ "color": "#123456" })))
                    .unwrap()
                    .cast_unchecked(),
            ),
        )
        .await;

    let announced: Vec<OwnedRoomId> = std::iter::from_fn(|| events.try_recv().ok())
        .filter_map(|event| match event {
            CoreEvent::RoomCosmeticsChanged { room_id } => Some(room_id),
            _ => None,
        })
        .collect();
    assert_eq!(announced, [room_id.to_owned()]);
    let found = session.cosmetics_for(&room, None).await;
    assert_eq!(found.users[0].color_on_light.as_deref(), Some("#123456"));
}

#[tokio::test]
async fn a_rename_in_one_room_refreshes_the_cached_space() {
    let server = MatrixMockServer::new().await;
    let room_id = room_id!("!room:example.org");
    let space_id = room_id!("!space:example.org");
    let client = joined(&server, &[room_id, space_id]).await;
    let (core, mut events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
    crate::test_support::sign_in(&core, &server, client.clone()).await;
    let session = core.signed_in().unwrap();
    session.watch_cosmetics(1);
    let old = json!({ "membership": "join", "displayname": "Old Alice" });
    let new = json!({ "membership": "join", "displayname": "New Alice" });
    serve_state(
        &server,
        room_id,
        json!([state(MEMBER_EVENT, ALICE, &old)]),
        1,
    )
    .await;
    serve_state(
        &server,
        space_id,
        json!([state(MEMBER_EVENT, ALICE, &old)]),
        1,
    )
    .await;
    serve_member(&server, space_id, &new, 1).await;
    let room = client.get_room(room_id).unwrap();
    assert_eq!(
        session
            .cosmetics_for(&room, Some(space_id.to_owned()))
            .await
            .users,
        Vec::<SenderCosmeticsView>::new()
    );

    rename(&server, &client, room_id, &old, &new).await;

    loop {
        let event = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
            .await
            .expect("the space is announced")
            .expect("the core is running");
        if matches!(&event, CoreEvent::RoomCosmeticsChanged { room_id } if room_id == space_id) {
            break;
        }
    }
    let found = session
        .cosmetics_for(&room, Some(space_id.to_owned()))
        .await;
    assert!(found.users.is_empty(), "{:?}", found.users);
}

#[tokio::test]
async fn a_resent_member_state_re_reads_a_differing_layer_once() {
    let server = MatrixMockServer::new().await;
    let room_id = room_id!("!room:example.org");
    let space_id = room_id!("!space:example.org");
    let client = joined(&server, &[room_id, space_id]).await;
    let (core, _events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
    crate::test_support::sign_in(&core, &server, client.clone()).await;
    let session = core.signed_in().unwrap();
    session.watch_cosmetics(1);
    let member = json!({ "membership": "join", "displayname": "Alice" });
    let space = json!({ "membership": "join", "displayname": "Space Alice" });
    serve_state(
        &server,
        room_id,
        json!([state(MEMBER_EVENT, ALICE, &member)]),
        1,
    )
    .await;
    serve_state(
        &server,
        space_id,
        json!([state(MEMBER_EVENT, ALICE, &space)]),
        1,
    )
    .await;
    serve_member(&server, space_id, &space, 1).await;
    let room = client.get_room(room_id).unwrap();
    session
        .cosmetics_for(&room, Some(space_id.to_owned()))
        .await;

    for _ in 0..3 {
        server
            .sync_room(
                &client,
                JoinedRoomBuilder::new(room_id).add_state_event(
                    Raw::new(&state(MEMBER_EVENT, ALICE, &member))
                        .unwrap()
                        .cast_unchecked(),
                ),
            )
            .await;
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
}

#[tokio::test]
async fn a_rename_leaves_a_space_name_set_on_purpose() {
    let server = MatrixMockServer::new().await;
    let room_id = room_id!("!room:example.org");
    let space_id = room_id!("!space:example.org");
    let client = joined(&server, &[room_id, space_id]).await;
    let (core, _events) = Core::new("cosmetics", Box::new(MemorySessionStore::default()));
    crate::test_support::sign_in(&core, &server, client.clone()).await;
    let session = core.signed_in().unwrap();
    session.watch_cosmetics(1);
    let old = json!({ "membership": "join", "displayname": "Alice" });
    let new = json!({ "membership": "join", "displayname": "New Alice" });
    let space = json!({ "membership": "join", "displayname": "Space Alice" });
    serve_state(
        &server,
        room_id,
        json!([state(MEMBER_EVENT, ALICE, &old)]),
        1,
    )
    .await;
    serve_state(
        &server,
        space_id,
        json!([state(MEMBER_EVENT, ALICE, &space)]),
        1,
    )
    .await;
    serve_member(&server, space_id, &space, 0).await;
    let room = client.get_room(room_id).unwrap();
    session
        .cosmetics_for(&room, Some(space_id.to_owned()))
        .await;

    rename(&server, &client, room_id, &old, &new).await;

    let found = session
        .cosmetics_for(&room, Some(space_id.to_owned()))
        .await;
    assert_eq!(
        found.users[0].space_display_name.as_deref(),
        Some("Space Alice")
    );
}
