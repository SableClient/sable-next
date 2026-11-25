#[test]
fn a_backup_must_carry_a_catalog_with_profiles() {
    let catalog = serde_json::json!({ "profiles": [{ "id": "alt" }] });
    let backup = serde_json::json!({ super::CATALOG_V3: catalog }).to_string();
    assert_eq!(super::catalog_from_backup(&backup), Some(catalog));

    for invalid in [
        "not json".to_owned(),
        serde_json::json!({ super::CATALOG_V3: {} }).to_string(),
        serde_json::json!({ super::CATALOG_V3: null }).to_string(),
        serde_json::json!({ super::CATALOG_V3: [] }).to_string(),
        serde_json::json!({ "other": { "profiles": [] } }).to_string(),
    ] {
        assert_eq!(super::catalog_from_backup(&invalid), None, "{invalid}");
    }
}

use super::{
    RoomAssociation, RoomAssociationsOut, ensure_empty_mentions, fallback_body,
    outgoing_with_fallback, personas_from_catalog, profile_value, room_associations, stamp_profile,
};
use crate::protocol::{PerMessageProfileView, PronounView};
use serde_json::json;

fn persona(value: &serde_json::Value) -> crate::protocol::PersonaView {
    personas_from_catalog(&json!({ "profiles": [value] }))
        .pop()
        .expect("a persona")
}

#[test]
fn persona_catalog_and_selection_events_are_persona_events() {
    assert!(super::is_persona_event(
        "fi.mau.msc4461.per_message_profiles.v3"
    ));
    assert!(super::is_persona_event(
        "fyi.cisnt.permessageprofile.roomassociation"
    ));
    assert!(!super::is_persona_event("fyi.cisnt.permessageprofileother"));
    assert!(!super::is_persona_event("m.direct"));
}

fn profile(display_name: &str, has_fallback: bool) -> PerMessageProfileView {
    PerMessageProfileView {
        id: Some("kris".to_owned()),
        display_name: Some(display_name.to_owned()),
        avatar_url: None,
        pronouns: Vec::new(),
        color_on_light: None,
        color_on_dark: None,
        has_fallback,
        biography: None,
        banner_url: None,
        is_animal: None,
        has_animal: None,
        animal_need: None,
    }
}

#[test]
fn persona_edits_add_an_empty_m_mentions_without_overwriting_mentions() {
    let mut without_mentions = json!({ "msgtype": "m.text", "body": "hello" });
    ensure_empty_mentions(&mut without_mentions);
    assert_eq!(without_mentions["m.mentions"], json!({}));

    let mut with_mentions = json!({ "m.mentions": { "room": true } });
    ensure_empty_mentions(&mut with_mentions);
    assert_eq!(with_mentions["m.mentions"], json!({ "room": true }));
}

#[test]
fn a_room_with_personas_off_round_trips_as_false() {
    let content = json!({
        "associations": {
            "!off:example.org": false,
            "!kris:example.org": { "profileId": "kris", "validUntil": 20 },
        }
    });

    let rooms = room_associations(&content);

    assert!(matches!(
        rooms.get("!off:example.org"),
        Some(RoomAssociation::Disabled)
    ));
    assert!(matches!(
        rooms.get("!kris:example.org"),
        Some(RoomAssociation::Persona(selection))
            if selection.persona_id == "kris" && selection.valid_until == Some(20)
    ));
    assert_eq!(
        serde_json::to_value(RoomAssociationsOut {
            associations: rooms
        })
        .expect("serializable"),
        json!({
            "associations": {
                "!off:example.org": false,
                "!kris:example.org": { "profileId": "kris", "validUntil": 20 },
            }
        })
    );
}

#[test]
fn a_room_sending_as_the_account_round_trips_as_true() {
    let content = json!({ "associations": { "!plain:example.org": true } });

    let rooms = room_associations(&content);

    assert!(matches!(
        rooms.get("!plain:example.org"),
        Some(RoomAssociation::Account)
    ));
    assert_eq!(
        serde_json::to_value(RoomAssociationsOut {
            associations: rooms
        })
        .expect("serializable"),
        content
    );
}

#[test]
fn reads_a_v3_persona_with_its_triggers() {
    let persona = persona(&json!({
        "id": "kris",
        "displayname": "Kris",
        "avatar_url": "mxc://example.org/kris",
        "io.fsky.nyx.pronouns": [{ "summary": "they/them", "language": "EN" }],
        "eu.she-a.color": { "on_light": "#333", "on_dark": "#eee" },
        "triggers": [
            { "prefix": "k:" },
            { "suffix": "-k", "keep_trigger": true },
            { "prefix": "", "suffix": "" }
        ],
    }));

    assert_eq!(persona.display_name, "Kris");
    assert_eq!(
        persona.pronouns,
        vec![PronounView {
            summary: "they/them".to_owned(),
            language: Some("en".to_owned()),
        }]
    );
    assert_eq!(persona.color_on_dark.as_deref(), Some("#eee"));
    assert_eq!(persona.triggers.len(), 2);
    assert!(persona.triggers[1].keep_trigger);
}

#[test]
fn a_persona_writes_only_what_it_has_and_reads_back_unchanged() {
    let written = json!({
        "id": "kris",
        "displayname": "Kris",
        "io.fsky.nyx.pronouns": [{ "summary": "they/them", "language": "en" }],
        "eu.she-a.color": { "on_dark": "#eee" },
        "net.f0rest.pkimport": { "id": "abcde" },
        "triggers": [{ "prefix": "k:" }, { "suffix": "-k", "keep_trigger": true }],
        "net.f0rest.last_used": 7,
    });
    let persona = persona(&written);

    let out = serde_json::to_value(super::PersonaOut::from(&persona)).expect("serializable");

    assert_eq!(out, written);
}

#[test]
fn triggers_keep_the_spaces_they_were_saved_with() {
    let tags = |persona: &crate::protocol::PersonaView| -> Vec<(Option<String>, Option<String>)> {
        persona
            .triggers
            .iter()
            .map(|trigger| (trigger.prefix.clone(), trigger.suffix.clone()))
            .collect()
    };
    let owned = |text: &str| Some(text.to_owned());

    let v3 = persona(&json!({
        "id": "emi", "displayname": "Emi",
        "triggers": [
            { "prefix": "emi: " },
            { "suffix": " -emi" },
            { "prefix": "  ", "suffix": " " }
        ],
    }));
    assert_eq!(
        tags(&v3),
        vec![(owned("emi: "), None), (None, owned(" -emi"))]
    );

    let v2 = persona(&json!({
        "id": "emi", "displayname": "Emi",
        "trigger": { "prefix": ["e: "], "net.f0rest.suffix": [" -e"] },
    }));
    assert_eq!(tags(&v2), vec![(owned("e: "), None), (None, owned(" -e"))]);
}

#[test]
fn lists_skip_bad_entries_and_a_non_list_reads_as_missing() {
    let skipped = persona(&json!({
        "id": "a", "displayname": "A",
        "triggers": [5, { "prefix": "a:" }, "x"],
        "trigger": { "prefix": ["v2:"] },
    }));
    assert_eq!(skipped.triggers.len(), 1);
    assert_eq!(skipped.triggers[0].prefix.as_deref(), Some("a:"));

    let legacy = persona(&json!({
        "id": "a", "displayname": "A",
        "triggers": "nope",
        "trigger": { "prefix": ["v2:", 5, "  "], "net.f0rest.suffix": "nope" },
    }));
    assert_eq!(legacy.triggers.len(), 1);
    assert_eq!(legacy.triggers[0].prefix.as_deref(), Some("v2:"));
}

#[test]
fn room_associations_skip_bad_entries_and_a_non_object_is_empty() {
    let rooms = room_associations(&json!({ "associations": { "!a:x": 7, "!b:x": false } }));
    assert_eq!(rooms.len(), 1);
    assert!(room_associations(&json!({ "associations": [1] })).is_empty());
}

#[test]
fn converts_a_v2_trigger_object_circumfixes_first() {
    let persona = persona(&json!({
        "id": "kris",
        "displayname": "Kris",
        "trigger": {
            "prefix": ["k:"],
            "net.f0rest.suffix": ["-k"],
            "net.f0rest.circumfix": [{ "prefix": "[", "suffix": "]" }],
        },
    }));

    let shapes: Vec<_> = persona
        .triggers
        .iter()
        .map(|trigger| (trigger.prefix.as_deref(), trigger.suffix.as_deref()))
        .collect();
    assert_eq!(
        shapes,
        vec![
            (Some("["), Some("]")),
            (Some("k:"), None),
            (None, Some("-k")),
        ]
    );
}

#[test]
fn reads_the_catalog_through_v1s_nested_wrapper() {
    let nested = json!({
        "type": "m.per_message_profiles",
        "content": { "profiles": [{ "id": "kris", "displayname": "Kris" }] },
    });
    assert_eq!(personas_from_catalog(&nested).len(), 1);
}

#[test]
fn a_repeated_id_is_kept_under_a_free_id() {
    let catalog = json!({
        "profiles": [
            { "id": "kris", "displayname": "Kris" },
            { "id": "kris-2", "displayname": "Sam" },
            { "id": "kris", "displayname": "Other Kris" },
        ],
    });
    let ids: Vec<_> = personas_from_catalog(&catalog)
        .into_iter()
        .map(|persona| (persona.id, persona.display_name))
        .collect();
    assert_eq!(
        ids,
        vec![
            ("kris".to_owned(), "Kris".to_owned()),
            ("kris-2".to_owned(), "Sam".to_owned()),
            ("kris-3".to_owned(), "Other Kris".to_owned()),
        ]
    );
}

#[test]
fn a_message_opening_with_a_bullet_is_not_an_edit() {
    let (body, formatted, _) = outgoing_with_fallback(
        "* one\n* two".to_owned(),
        Some("<ul><li>one</li><li>two</li></ul>".to_owned()),
        &profile("Kris", true),
    );

    assert_eq!(body, "Kris: * one\n* two");
    assert_eq!(
        formatted.as_deref(),
        Some("<strong data-mx-profile-fallback>Kris: </strong><ul><li>one</li><li>two</li></ul>")
    );
}

#[test]
fn an_edit_keeps_its_marker_ahead_of_the_prefix() {
    let mut content = json!({
        "msgtype": "m.text",
        "body": "* * one",
        "format": "org.matrix.custom.html",
        "formatted_body": "* <ul><li>one</li></ul>",
        "m.new_content": {
            "msgtype": "m.text",
            "body": "* one",
            "format": "org.matrix.custom.html",
            "formatted_body": "<ul><li>one</li></ul>",
        },
    });
    let persona = profile("Kris", true);
    stamp_profile(&mut content, &persona);
    stamp_profile(&mut content["m.new_content"], &persona);

    assert_eq!(content["body"], "* Kris: * one");
    assert_eq!(
        content["formatted_body"],
        "* <strong data-mx-profile-fallback>Kris: </strong><ul><li>one</li></ul>"
    );
    assert_eq!(content["m.new_content"]["body"], "Kris: * one");
    assert_eq!(
        content["m.new_content"]["formatted_body"],
        "<strong data-mx-profile-fallback>Kris: </strong><ul><li>one</li></ul>"
    );
}

#[test]
fn the_fallback_prefixes_both_bodies_once() {
    let mut content = json!({ "msgtype": "m.text", "body": "hello" });
    stamp_profile(&mut content, &profile("Kris", true));

    assert_eq!(content["body"], "Kris: hello");
    assert_eq!(content["format"], "org.matrix.custom.html");
    assert_eq!(
        content["formatted_body"],
        "<strong data-mx-profile-fallback>Kris: </strong>hello"
    );

    stamp_profile(&mut content, &profile("Kris", true));
    assert_eq!(content["body"], "Kris: hello");
    assert_eq!(
        content["formatted_body"],
        "<strong data-mx-profile-fallback>Kris: </strong>hello"
    );
}

#[test]
fn a_name_with_markup_is_escaped_in_the_fallback() {
    let mut content = json!({ "msgtype": "m.text", "body": "hi" });
    stamp_profile(&mut content, &profile("<b>Kris</b>", true));

    assert_eq!(
        content["formatted_body"],
        "<strong data-mx-profile-fallback>&lt;b&gt;Kris&lt;/b&gt;: </strong>hi"
    );
}

#[test]
fn without_a_fallback_only_the_profile_is_attached() {
    let mut content = json!({ "msgtype": "m.text", "body": "hello" });
    stamp_profile(&mut content, &profile("Kris", false));

    assert_eq!(content["body"], "hello");
    assert!(content.get("formatted_body").is_none());
    assert_eq!(
        content["com.beeper.per_message_profile"]["displayname"],
        "Kris"
    );
    assert!(
        content["com.beeper.per_message_profile"]
            .get("has_fallback")
            .is_none()
    );
}

#[test]
fn a_nameless_profile_does_not_claim_a_fallback_it_cannot_write() {
    let mut nameless = profile("Kris", true);
    nameless.display_name = None;

    let mut content = json!({ "msgtype": "m.text", "body": "hello" });
    stamp_profile(&mut content, &nameless);

    assert_eq!(content["body"], "hello");
    assert!(
        content["com.beeper.per_message_profile"]
            .get("has_fallback")
            .is_none()
    );
    assert!(fallback_body("hello", None, &nameless, false).is_none());
}

#[test]
fn an_outgoing_message_carries_the_fallback_it_advertises() {
    let (body, formatted, profile) =
        outgoing_with_fallback("hello".to_owned(), None, &profile("Kris", true));

    assert_eq!(body, "Kris: hello");
    assert_eq!(
        formatted.as_deref(),
        Some("<strong data-mx-profile-fallback>Kris: </strong>hello")
    );
    assert!(profile.has_fallback);

    let (body, formatted, profile) =
        outgoing_with_fallback("hello".to_owned(), None, &profile_without_name());
    assert_eq!(body, "hello");
    assert!(formatted.is_none());
    assert!(!profile.has_fallback);
}

#[test]
fn oversized_fields_are_clamped_on_a_char_boundary() {
    let mut long = profile(&"é".repeat(200), true);
    long.id = Some("k".repeat(300));

    let stamped = profile_value(&long);
    let name = stamped["displayname"].as_str().expect("a display name");

    assert!(name.len() <= 255);
    assert_eq!(name.chars().count(), 127);
    assert_eq!(stamped["id"].as_str().expect("an id").len(), 255);
}

#[test]
fn a_null_byte_never_reaches_the_wire() {
    let profile = profile("Kr\0is", true);
    let stamped = profile_value(&profile);

    assert_eq!(stamped["displayname"], "Kris");
}

fn profile_without_name() -> PerMessageProfileView {
    PerMessageProfileView {
        display_name: None,
        ..profile("Kris", true)
    }
}

#[tokio::test]
async fn an_unreachable_server_serves_the_stored_catalog() {
    use crate::{Core, session::Session, store::MemorySessionStore};
    use matrix_sdk::test_utils::mocks::MatrixMockServer;
    use matrix_sdk_ui::sync_service::SyncService;
    use std::sync::Arc;
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path_regex},
    };

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_custom_global_account_data(json!({
                "type": super::CATALOG_V3,
                "content": { "profiles": [{ "id": "kris", "displayname": "Kris" }] }
            }));
        })
        .await;
    let (core, _events) = Core::new("offline-personas", Box::new(MemorySessionStore::default()));
    crate::test_support::set_session(
        &core,
        Some(Session {
            account_id: "test".into(),
            client: client.clone(),
            sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
            homeserver: server.server().uri(),
            oauth: false,
            state: Arc::default(),
        }),
    );
    let session = core.signed_in().unwrap();
    let _unreachable = Mock::given(method("GET"))
        .and(path_regex("/account_data/"))
        .respond_with(ResponseTemplate::new(500))
        .mount_as_scoped(server.server())
        .await;

    let catalog = session.personas().await.unwrap();

    assert_eq!(catalog.personas.len(), 1);
    assert_eq!(catalog.personas[0].id, "kris");
}
