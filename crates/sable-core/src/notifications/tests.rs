use matrix_sdk::ruma::events::AnySyncTimelineEvent;
use matrix_sdk::ruma::push::{ConditionalPushRule, RuleKind, Ruleset};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{
    EventId, MilliSecondsSinceUnixEpoch, event_id, mxc_uri, owned_device_id, room_id, user_id,
};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_base::crypto::{
    olm::{Account, EncryptionSettings, InboundGroupSession, OutboundGroupSession, SenderData},
    types::EventEncryptionAlgorithm,
};
use matrix_sdk_test::JoinedRoomBuilder;
use serde_json::json;

use super::cold::{PushHost, push_account, push_host};
use super::push_cache::cold_host;
use super::{
    ColdPush, cold_push_store_dir, decrypt_cold_push, fetch_cold_push_event, restore_push_client,
};
use crate::preview::describe;
use crate::protocol::PushFetchView;
use crate::session::PersistedSession;
use crate::store::{FileSessionStore, SessionStore};

fn event(value: &serde_json::Value) -> AnySyncTimelineEvent {
    Raw::<AnySyncTimelineEvent>::from_json_string(value.to_string())
        .expect("the fixture is valid JSON")
        .deserialize()
        .expect("the fixture is a timeline event")
}

#[test]
fn a_cold_push_only_opens_its_exact_authenticated_account() {
    let accounts: crate::session::AccountRegistry = serde_json::from_value(json!({
        "version": 1, "active_account_id": "a1", "next_account_id": 3,
        "accounts": [
            { "account_id": "a1", "store_id": "one", "needs_reauth": false,
              "session": { "homeserver": "https://example.org", "credentials": {
                "kind": "password", "user_id": "@alice:example.org", "device_id": "A", "access_token": "token"
              }}},
            { "account_id": "a2", "store_id": "two", "needs_reauth": true,
              "session": { "homeserver": "https://example.org", "credentials": {
                "kind": "password", "user_id": "@alice:example.org", "device_id": "B", "access_token": "token"
              }}}
        ]
    }))
    .expect("the account registry fixture is valid");

    assert_eq!(
        push_account(&accounts, "@alice:example.org", "A").map(|account| &account.store_id),
        Some(&"one".to_owned())
    );
    assert!(push_account(&accounts, "@alice:example.org", "B").is_none());
    assert!(push_account(&accounts, "@mallory:example.org", "A").is_none());
}

#[test]
fn a_cold_push_uses_androids_files_directory() {
    assert_eq!(
        cold_push_store_dir(std::path::Path::new("/data/user/0/moe.sable.client")),
        std::path::Path::new("/data/user/0/moe.sable.client/files")
    );
}

const COLD_ROOM: &str = "!cold:example.org";

/// The SDK closes its SQLite connections on a blocking thread after the client drops, which
/// can still write a journal while the directory is being removed.
async fn remove_data_dir(path: &std::path::Path) {
    for _ in 0..20 {
        match tokio::fs::remove_dir_all(path).await {
            Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            result => return result.unwrap(),
        }
    }
    panic!("{} stayed in use", path.display());
}

struct ColdFixture {
    data_dir: std::path::PathBuf,
    client: Option<matrix_sdk::Client>,
    outbound: OutboundGroupSession,
    server: MatrixMockServer,
}

impl ColdFixture {
    async fn new(tag: &str, joined: JoinedRoomBuilder, rules: Option<Ruleset>) -> Self {
        let data_dir =
            std::env::temp_dir().join(format!("sable-cold-push-{tag}-{}", std::process::id()));
        let store_dir = cold_push_store_dir(&data_dir);
        let server = MatrixMockServer::new().await;
        server.mock_versions().ok().mount().await;
        let persisted: PersistedSession = serde_json::from_value(json!({
            "homeserver": server.uri(), "resolved_homeserver": server.uri(),
            "credentials": {"kind": "password", "user_id": "@alice:example.org",
                "device_id": "A", "access_token": "test-token"}
        }))
        .unwrap();
        FileSessionStore::new(&store_dir)
            .save(serde_json::to_vec(&persisted).unwrap())
            .await
            .unwrap();
        let client = crate::session::restore_client(store_dir.to_str().unwrap(), &persisted, true)
            .await
            .unwrap();
        crate::session::restore_credentials(&client, &persisted)
            .await
            .unwrap();
        server
            .mock_sync()
            .ok_and_run(&client, |builder| {
                if let Some(rules) = rules {
                    builder.add_global_account_data(
                        matrix_sdk_test::event_factory::EventFactory::new().push_rules(rules),
                    );
                }
                builder.add_joined_room(joined);
            })
            .await;
        let outbound = shared_room_key(&client).await;
        Self {
            data_dir,
            client: Some(client),
            outbound,
            server,
        }
    }

    async fn push(&self, event_type: &str, content: serde_json::Value) -> String {
        encrypted_push(&self.outbound, event_type, content).await
    }

    async fn decrypt(&self, device: &str, event: &str) -> ColdPush {
        decrypt_cold_push(
            &self.data_dir,
            "@alice:example.org",
            device,
            COLD_ROOM,
            event,
            true,
        )
        .await
    }

    async fn decrypt_locally(&self, event: &str) -> ColdPush {
        decrypt_cold_push(
            &self.data_dir,
            "@alice:example.org",
            "A",
            COLD_ROOM,
            event,
            false,
        )
        .await
    }
}

#[tokio::test]
async fn a_cold_push_decrypts_from_androids_persisted_store() {
    let mut fixture = ColdFixture::new("store", cold_room_with_members(), None).await;
    let event = fixture
        .push(
            "m.room.message",
            json!({"msgtype":"m.text", "body":"Cold preview 🔐"}),
        )
        .await;
    // A second SDK client must coexist with the warm application's store owner.
    let ColdPush::Clear(clear) = fixture.decrypt("A", &event).await else {
        panic!("cold decryption while the application has the store open");
    };
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&clear).unwrap()["content"]["body"],
        "Cold preview 🔐"
    );
    drop(fixture.client.take());
    assert!(matches!(
        fixture.decrypt("A", &event).await,
        ColdPush::Clear(_)
    ));
    assert_eq!(
        fixture.decrypt("OTHER", &event).await,
        ColdPush::Undecryptable
    );
    assert!(!fixture.data_dir.join("session.json").exists());

    remove_data_dir(&fixture.data_dir).await;
}

async fn shared_room_key(client: &matrix_sdk::Client) -> OutboundGroupSession {
    let room = room_id!("!cold:example.org");
    let sender = Account::new(user_id!("@sender:example.org"));
    let keys = sender.identity_keys();
    let outbound = OutboundGroupSession::new(
        owned_device_id!("SENDER"),
        std::sync::Arc::new(keys),
        room,
        EncryptionSettings::default(),
    )
    .unwrap();
    let inbound = InboundGroupSession::new(
        outbound.sender_key(),
        keys.ed25519,
        room,
        &outbound.session_key().await,
        SenderData::unknown(),
        None,
        EventEncryptionAlgorithm::MegolmV1AesSha2,
        None,
        false,
    )
    .unwrap();
    client
        .olm_machine_for_testing()
        .await
        .as_ref()
        .unwrap()
        .store()
        .import_room_keys(vec![inbound.export().await], None, |_, _| ())
        .await
        .unwrap();
    outbound
}

async fn saved_login(
    server: &MatrixMockServer,
    data_dir: &std::path::Path,
) -> crate::session::PersistedAccount {
    let session = serde_json::from_value(json!({
        "homeserver": server.uri(), "resolved_homeserver": server.uri(),
        "credentials": {"kind": "password", "user_id": "@alice:example.org",
            "device_id": "A", "access_token": "test-token"}
    }))
    .unwrap();
    saved_login_as(data_dir, session).await
}

async fn saved_login_as(
    data_dir: &std::path::Path,
    session: PersistedSession,
) -> crate::session::PersistedAccount {
    let base = cold_push_store_dir(data_dir);
    let mut registry = crate::session::AccountRegistry::empty();
    let (account_id, store_id) = registry.allocate_account(base.to_str().unwrap());
    registry.upsert(crate::session::PersistedAccount {
        account_id,
        store_id,
        session,
        needs_reauth: false,
        device_invalidated: false,
    });
    FileSessionStore::new(&base)
        .save(serde_json::to_vec(&registry).unwrap())
        .await
        .unwrap();
    let account = registry.accounts.remove(0);
    let seeded = crate::session::restore_client(&account.store_id, &account.session, true)
        .await
        .unwrap();
    crate::session::restore_credentials(&seeded, &account.session)
        .await
        .unwrap();
    account
}

fn core_of(data_dir: &std::path::Path) -> std::sync::Arc<crate::Core> {
    let base = cold_push_store_dir(data_dir);
    crate::Core::new(
        base.to_str().unwrap(),
        Box::new(FileSessionStore::new(&base)),
    )
    .0
}

async fn waits_for(lease_holder: impl FnOnce(), store_id: &str) {
    let opening = tokio::spawn({
        let store_id = store_id.to_owned();
        async move { drop(crate::session::store_lease(&store_id).await) }
    });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(!opening.is_finished());
    lease_holder();
    tokio::time::timeout(std::time::Duration::from_secs(5), opening)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn a_push_decrypts_on_the_client_the_core_opens_for_its_login() {
    let data_dir = tempfile::tempdir().unwrap();
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    let account = saved_login(&server, data_dir.path()).await;
    let core = core_of(data_dir.path());
    core.accounts().await.unwrap();
    let lease = crate::session::store_lease(&account.store_id).await;
    let client = core.saved_account_client(&account, &lease).await.unwrap();
    drop(lease);
    server
        .mock_sync()
        .ok_and_run(&client, |builder| {
            builder.add_joined_room(cold_room_with_members());
        })
        .await;
    let outbound = shared_room_key(&client).await;
    let event = encrypted_push(
        &outbound,
        "m.room.message",
        json!({"msgtype":"m.text", "body":"Shared preview"}),
    )
    .await;
    let held = crate::session::base_client(&account.store_id).unwrap();

    let decrypted = decrypt_cold_push(
        data_dir.path(),
        "@alice:example.org",
        "A",
        COLD_ROOM,
        &event,
        true,
    )
    .await;

    assert!(matches!(decrypted, ColdPush::Clear(_)));
    assert!(std::sync::Arc::ptr_eq(
        &held,
        &crate::session::base_client(&account.store_id)
            .expect("the core's client still owns the store"),
    ));
}

#[tokio::test]
async fn pusher_upkeep_uses_the_client_of_the_core_in_the_process() {
    let data_dir = tempfile::tempdir().unwrap();
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    let account = saved_login(&server, data_dir.path()).await;
    let core = core_of(data_dir.path());

    let upkeep = restore_push_client(
        &cold_push_store_dir(data_dir.path()),
        "@alice:example.org",
        "A",
    )
    .await
    .unwrap();

    assert!(
        core.account_clients
            .lock()
            .await
            .contains_key(&account.account_id)
    );
    assert!(crate::session::base_client(&account.store_id).is_some());
    drop(upkeep);
}

#[tokio::test]
async fn a_core_opens_a_store_only_once_the_push_that_opened_it_is_done() {
    let data_dir = tempfile::tempdir().unwrap();
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    let account = saved_login(&server, data_dir.path()).await;
    let cold = restore_push_client(
        &cold_push_store_dir(data_dir.path()),
        "@alice:example.org",
        "A",
    )
    .await
    .unwrap();
    let base = cold_push_store_dir(data_dir.path());
    let (core, _) = crate::Core::new(
        base.to_str().unwrap(),
        Box::new(crate::store::ExclusiveFileSessionStore::new(&base)),
    );
    let open = async {
        let accounts = core.accounts().await.unwrap();
        let lease = crate::session::store_lease(&account.store_id).await;
        core.saved_account_client(&accounts.accounts[0], &lease)
            .await
            .unwrap();
    };
    tokio::pin!(open);

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(200), &mut open)
            .await
            .is_err(),
        "two clients on one crypto store overwrite each other's Olm sessions"
    );
    drop(cold);
    tokio::time::timeout(std::time::Duration::from_secs(5), open)
        .await
        .expect("the core opens once the push is done");
}

#[tokio::test]
async fn a_core_drops_an_idle_cached_push_client_before_opening_its_store() {
    let data_dir = tempfile::tempdir().unwrap();
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    let account = saved_login(&server, data_dir.path()).await;
    let base = cold_push_store_dir(data_dir.path());
    let cached = cold_host(&base, "@alice:example.org", "A").await.unwrap();
    assert!(matches!(*cached, PushHost::Own(_)));
    drop(cached);

    let (core, _) = crate::Core::new(
        base.to_str().unwrap(),
        Box::new(crate::store::ExclusiveFileSessionStore::new(&base)),
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let accounts = core.accounts().await.unwrap();
        let lease = crate::session::store_lease(&account.store_id).await;
        core.saved_account_client(&accounts.accounts[0], &lease)
            .await
            .unwrap();
    })
    .await
    .expect("the core evicts the idle push client instead of waiting on it");
}

#[tokio::test]
async fn the_core_cannot_activate_a_login_while_a_push_runs_on_its_client() {
    let data_dir = tempfile::tempdir().unwrap();
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    let account = saved_login(&server, data_dir.path()).await;
    let _core = core_of(data_dir.path());
    let host = push_host(
        &cold_push_store_dir(data_dir.path()),
        "@alice:example.org",
        "A",
        matrix_sdk::store::RoomLoadSettings::default(),
    )
    .await;
    assert!(matches!(host, Some(PushHost::Shared { .. })));

    waits_for(|| drop(host), &account.store_id).await;
}

#[tokio::test]
async fn pushes_reuse_one_restored_client() {
    let data_dir = tempfile::tempdir().unwrap();
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    saved_login(&server, data_dir.path()).await;
    let store_dir = cold_push_store_dir(data_dir.path());

    let first = cold_host(&store_dir, "@alice:example.org", "A").await;
    assert!(matches!(first.as_deref(), Some(PushHost::Own(_))));
    drop(first);
    // A second restore could not find the login any more.
    tokio::fs::remove_file(store_dir.join("session.json"))
        .await
        .unwrap();
    assert!(
        cold_host(&store_dir, "@alice:example.org", "A")
            .await
            .is_some()
    );
}

#[tokio::test]
async fn the_cache_gives_way_to_a_starting_core() {
    let data_dir = tempfile::tempdir().unwrap();
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    saved_login(&server, data_dir.path()).await;
    let store_dir = cold_push_store_dir(data_dir.path());
    drop(cold_host(&store_dir, "@alice:example.org", "A").await);

    let core = core_of(data_dir.path());
    let host = cold_host(&store_dir, "@alice:example.org", "A").await;
    assert!(matches!(host.as_deref(), Some(PushHost::Shared { .. })));
    drop(host);
    drop(core);

    // Only the cached client could still serve the push once the login is gone.
    tokio::fs::remove_file(store_dir.join("session.json"))
        .await
        .unwrap();
    assert!(
        cold_host(&store_dir, "@alice:example.org", "A")
            .await
            .is_none()
    );
}

#[tokio::test]
async fn an_evicted_login_is_restored_from_what_is_saved() {
    let data_dir = tempfile::tempdir().unwrap();
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    saved_login(&server, data_dir.path()).await;
    let store_dir = cold_push_store_dir(data_dir.path());
    drop(cold_host(&store_dir, "@alice:example.org", "A").await);

    super::evict_push_cache(&store_dir);

    tokio::fs::remove_file(store_dir.join("session.json"))
        .await
        .unwrap();
    assert!(
        cold_host(&store_dir, "@alice:example.org", "A")
            .await
            .is_none()
    );
}

async fn encrypted_push(
    outbound: &OutboundGroupSession,
    event_type: &str,
    content: serde_json::Value,
) -> String {
    let content = outbound
        .encrypt(event_type, &serde_json::from_value(content).unwrap())
        .await
        .content;
    json!({"type":"m.room.encrypted", "event_id":"$cold",
        "sender":"@sender:example.org", "origin_server_ts":1, "content":content})
    .to_string()
}

fn cold_room_with_members() -> JoinedRoomBuilder {
    let factory = matrix_sdk_test::event_factory::EventFactory::new()
        .room(room_id!("!cold:example.org"))
        .sender(user_id!("@sender:example.org"));
    JoinedRoomBuilder::new(room_id!("!cold:example.org"))
        .add_state_event(factory.member(user_id!("@alice:example.org")))
        .add_state_event(factory.member(user_id!("@sender:example.org")))
        .add_state_event(factory.power_levels())
}

#[tokio::test]
async fn a_cold_push_from_an_ignored_sender_is_discarded() {
    let fixture = ColdFixture::new("ignored", cold_room_with_members(), None).await;
    let client = fixture.client.as_ref().unwrap();
    fixture
        .server
        .mock_sync()
        .ok_and_run(client, |builder| {
            builder.add_global_account_data(
                matrix_sdk_test::event_factory::EventFactory::new()
                    .ignored_user_list([user_id!("@sender:example.org").to_owned()]),
            );
        })
        .await;
    let message = fixture
        .push(
            "m.room.message",
            json!({"msgtype":"m.text", "body":"hello"}),
        )
        .await;

    assert_eq!(fixture.decrypt("A", &message).await, ColdPush::Discard);
    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn a_cold_push_the_push_rules_silence_is_discarded() {
    use matrix_sdk::ruma::push::PredefinedUnderrideRuleId;

    let fixture = ColdFixture::new("reaction", cold_room_with_members(), None).await;
    let reaction = fixture
        .push(
            "m.reaction",
            json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": "$target", "key": "👍"}}),
        )
        .await;
    let message = fixture
        .push(
            "m.room.message",
            json!({"msgtype":"m.text", "body":"hello"}),
        )
        .await;

    assert_eq!(fixture.decrypt("A", &reaction).await, ColdPush::Discard);
    assert_eq!(
        session(&fixture).await.decrypt(&reaction).await,
        ColdPush::Discard
    );
    assert!(matches!(
        fixture.decrypt("A", &message).await,
        ColdPush::Clear(_)
    ));
    remove_data_dir(&fixture.data_dir).await;

    let mut rules = Ruleset::server_default(user_id!("@alice:example.org"));
    rules
        .set_actions(
            RuleKind::Underride,
            PredefinedUnderrideRuleId::Message.as_str(),
            vec![],
        )
        .unwrap();
    let fixture = ColdFixture::new("mentions", cold_room_with_members(), Some(rules)).await;
    let message = fixture
        .push(
            "m.room.message",
            json!({"msgtype":"m.text", "body":"hello"}),
        )
        .await;

    assert_eq!(fixture.decrypt("A", &message).await, ColdPush::Discard);
    assert_eq!(
        session(&fixture).await.decrypt(&message).await,
        ColdPush::Discard
    );
    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn a_cold_push_notifies_only_for_reactions_to_our_own_events() {
    use matrix_sdk::ruma::push::{
        Action, EventMatchConditionData, NewConditionalPushRule, NewPushRule, PushCondition,
    };

    let mut rules = Ruleset::server_default(user_id!("@alice:example.org"));
    rules
        .insert(
            NewPushRule::Override(NewConditionalPushRule::new(
                "moe.sable.reaction_to_me".to_owned(),
                vec![
                    PushCondition::EventMatch(EventMatchConditionData::new(
                        "type".to_owned(),
                        "m.reaction".to_owned(),
                    )),
                    serde_json::from_value(json!({
                        "kind": "im.nheko.msc3664.related_event_match",
                        "rel_type": "m.annotation",
                        "key": "sender",
                        "pattern": "@alice:example.org"
                    }))
                    .unwrap(),
                ],
                vec![Action::Notify],
            )),
            None,
            None,
        )
        .unwrap();
    let fixture = ColdFixture::new("reaction-to-me", cold_room_with_members(), Some(rules)).await;
    let factory =
        matrix_sdk_test::event_factory::EventFactory::new().room(room_id!("!cold:example.org"));
    for (id, sender) in [
        (event_id!("$mine"), user_id!("@alice:example.org")),
        (event_id!("$theirs"), user_id!("@sender:example.org")),
    ] {
        fixture
            .server
            .mock_room_event()
            .expect_access_token("test-token")
            .match_event_id()
            .ok(factory
                .text_msg("hi")
                .sender(sender)
                .event_id(id)
                .into_event())
            .mount()
            .await;
    }
    let reaction = |target: &str| json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": target, "key": "👍"}});
    let to_mine = fixture.push("m.reaction", reaction("$mine")).await;
    let to_theirs = fixture.push("m.reaction", reaction("$theirs")).await;

    assert!(matches!(
        fixture.decrypt("A", &to_mine).await,
        ColdPush::Clear(_)
    ));
    assert_eq!(fixture.decrypt("A", &to_theirs).await, ColdPush::Discard);
    remove_data_dir(&fixture.data_dir).await;
}

fn cold_room_without_me() -> JoinedRoomBuilder {
    let factory = matrix_sdk_test::event_factory::EventFactory::new()
        .room(room_id!("!cold:example.org"))
        .sender(user_id!("@sender:example.org"));
    JoinedRoomBuilder::new(room_id!("!cold:example.org"))
        .add_state_event(factory.member(user_id!("@sender:example.org")))
        .add_state_event(factory.power_levels())
}

#[tokio::test]
async fn a_cold_push_without_our_membership_follows_the_push_rules() {
    use matrix_sdk::ruma::push::{NewPushRule, NewSimplePushRule};

    let mut rules = Ruleset::server_default(user_id!("@alice:example.org"));
    rules
        .insert(
            NewPushRule::Room(NewSimplePushRule::new(
                room_id!("!cold:example.org").to_owned(),
                vec![],
            )),
            None,
            None,
        )
        .unwrap();
    let fixture = ColdFixture::new("no-member", cold_room_without_me(), Some(rules)).await;
    let sticker = fixture
        .push(
            "m.sticker",
            json!({"body": "wave", "url": "mxc://example.org/wave", "info": {}}),
        )
        .await;

    assert!(matches!(
        fixture.decrypt("A", &sticker).await,
        ColdPush::Clear(_)
    ));
    remove_data_dir(&fixture.data_dir).await;

    let fixture = ColdFixture::new("fetched-member", cold_room_without_me(), None).await;
    let factory =
        matrix_sdk_test::event_factory::EventFactory::new().room(room_id!("!cold:example.org"));
    fixture
        .server
        .mock_get_members()
        .ok(vec![
            factory.member(user_id!("@alice:example.org")).into_raw(),
            factory.member(user_id!("@sender:example.org")).into_raw(),
        ])
        .mount()
        .await;
    let message = fixture
        .push(
            "m.room.message",
            json!({"msgtype":"m.text", "body":"hello"}),
        )
        .await;

    assert!(matches!(
        fixture.decrypt("A", &message).await,
        ColdPush::Clear(_)
    ));
    remove_data_dir(&fixture.data_dir).await;
}

fn pushes_every_encrypted_event() -> Ruleset {
    let mut rules = Ruleset::server_default(user_id!("@alice:example.org"));
    rules.override_.insert(
        serde_json::from_value::<ConditionalPushRule>(json!({
            "rule_id": ".org.matrix.msc4028.encrypted_event",
            "default": true,
            "enabled": true,
            "conditions": [{"kind": "event_match", "key": "type", "pattern": "m.room.encrypted"}],
            "actions": ["notify"],
        }))
        .unwrap(),
    );
    rules
}

#[tokio::test]
async fn a_cold_push_whose_rules_cannot_be_evaluated_trusts_the_server_unless_it_pushes_everything()
{
    let fixture = ColdFixture::new("unevaluated", cold_room_without_me(), None).await;
    let message = fixture
        .push(
            "m.room.message",
            json!({"msgtype":"m.text", "body":"hello"}),
        )
        .await;
    assert!(matches!(
        fixture.decrypt("A", &message).await,
        ColdPush::Clear(_)
    ));
    remove_data_dir(&fixture.data_dir).await;

    let fixture = ColdFixture::new(
        "unevaluated-msc4028",
        cold_room_without_me(),
        Some(pushes_every_encrypted_event()),
    )
    .await;
    let message = fixture
        .push(
            "m.room.message",
            json!({"msgtype":"m.text", "body":"hello"}),
        )
        .await;
    assert_eq!(fixture.decrypt("A", &message).await, ColdPush::Unevaluated);
    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn a_cold_push_in_an_all_messages_room_is_shown_under_a_mentions_default() {
    use matrix_sdk::ruma::push::{NewPushRule, NewSimplePushRule, PredefinedUnderrideRuleId};

    let mut rules = Ruleset::server_default(user_id!("@alice:example.org"));
    rules
        .set_actions(
            RuleKind::Underride,
            PredefinedUnderrideRuleId::Message.as_str(),
            vec![],
        )
        .unwrap();
    rules
        .insert(
            NewPushRule::Room(NewSimplePushRule::new(
                room_id!("!cold:example.org").to_owned(),
                vec![matrix_sdk::ruma::push::Action::Notify],
            )),
            None,
            None,
        )
        .unwrap();
    let fixture = ColdFixture::new("all", cold_room_with_members(), Some(rules)).await;
    let message = fixture
        .push(
            "m.room.message",
            json!({"msgtype":"m.text", "body":"hello"}),
        )
        .await;

    let ColdPush::Clear(clear) = fixture.decrypt("A", &message).await else {
        panic!("an all-messages room must still notify");
    };
    let clear = serde_json::from_str::<serde_json::Value>(&clear).unwrap();
    assert_eq!(clear["content"]["body"], "hello");
    assert_eq!(clear.get(super::NOISY_KEY), None);
    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn a_cold_push_whose_rule_rings_is_marked_noisy() {
    use matrix_sdk::ruma::push::{Action, NewPushRule, NewSimplePushRule, Tweak};

    let mut rules = Ruleset::server_default(user_id!("@alice:example.org"));
    rules
        .insert(
            NewPushRule::Room(NewSimplePushRule::new(
                room_id!("!cold:example.org").to_owned(),
                vec![
                    Action::Notify,
                    Action::SetTweak(Tweak::Sound("default".into())),
                ],
            )),
            None,
            None,
        )
        .unwrap();
    let fixture = ColdFixture::new("noisy", cold_room_with_members(), Some(rules)).await;
    let message = fixture
        .push("m.room.message", json!({"msgtype":"m.text", "body":"ring"}))
        .await;

    let ColdPush::Clear(clear) = fixture.decrypt("A", &message).await else {
        panic!("a ringing room must notify");
    };
    let clear = serde_json::from_str::<serde_json::Value>(&clear).unwrap();
    assert_eq!(clear["content"]["body"], "ring");
    assert_eq!(clear[super::NOISY_KEY], true);
    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn a_local_decryption_asks_for_the_key_quietly_only_when_every_encrypted_event_is_pushed() {
    let stranger = OutboundGroupSession::new(
        owned_device_id!("STRANGER"),
        std::sync::Arc::new(Account::new(user_id!("@sender:example.org")).identity_keys()),
        room_id!("!cold:example.org"),
        EncryptionSettings::default(),
    )
    .unwrap();
    let unknown = encrypted_push(
        &stranger,
        "m.room.message",
        json!({"msgtype":"m.text", "body":"hello"}),
    )
    .await;

    let fixture = ColdFixture::new("needs-key", cold_room_with_members(), None).await;
    assert_eq!(
        fixture.decrypt_locally(&unknown).await,
        ColdPush::NeedsKey { quietly: false }
    );
    remove_data_dir(&fixture.data_dir).await;

    let fixture = ColdFixture::new(
        "needs-key-quietly",
        cold_room_with_members(),
        Some(pushes_every_encrypted_event()),
    )
    .await;
    assert_eq!(
        fixture.decrypt_locally(&unknown).await,
        ColdPush::NeedsKey { quietly: true }
    );
    remove_data_dir(&fixture.data_dir).await;
}

async fn fetch(fixture: &ColdFixture, device: &str, event: serde_json::Value) -> PushFetchView {
    let _mocks = mount_fetch(fixture, &event).await;
    fetch_cold_push_event(
        &fixture.data_dir,
        "@alice:example.org",
        device,
        COLD_ROOM,
        event["event_id"].as_str().unwrap(),
    )
    .await
}

async fn mount_fetch(
    fixture: &ColdFixture,
    event: &serde_json::Value,
) -> (wiremock::MockGuard, wiremock::MockGuard) {
    mount_fetch_with(fixture, event, true, false).await
}

async fn mount_fetch_with(
    fixture: &ColdFixture,
    event: &serde_json::Value,
    own_member: bool,
    encrypted: bool,
) -> (wiremock::MockGuard, wiremock::MockGuard) {
    use matrix_sdk::ruma::api::client::sync::sync_events::v5;

    let mut room = v5::response::Room::new();
    room.initial = Some(true);
    room.timeline = vec![Raw::from_json_string(event.to_string()).unwrap()];
    let factory = matrix_sdk_test::event_factory::EventFactory::new()
        .room(room_id!("!cold:example.org"))
        .sender(user_id!("@sender:example.org"));
    room.required_state = own_member
        .then(|| factory.member(user_id!("@alice:example.org")).into_raw())
        .into_iter()
        .chain(encrypted.then(|| factory.room_encryption().into_raw()))
        .collect();
    let mut response = v5::Response::new("1".to_owned());
    response.rooms =
        std::collections::BTreeMap::from([(room_id!("!cold:example.org").to_owned(), room)]);
    let sync = fixture
        .server
        .mock_sliding_sync()
        .ok(response)
        .mount_as_scoped()
        .await;
    let encryption = fixture.server.mock_room_state_encryption();
    let encryption = if encrypted {
        encryption.encrypted()
    } else {
        encryption.plain()
    }
    .mount_as_scoped()
    .await;
    (sync, encryption)
}

#[tokio::test]
async fn a_pushed_event_whose_rules_cannot_be_evaluated_is_still_fetched() {
    let fixture = ColdFixture::new("fetch-unevaluated", cold_room_without_me(), None).await;
    let message = json!({"type": "m.room.message", "event_id": "$unevaluated",
        "sender": "@sender:example.org", "origin_server_ts": 1,
        "content": {"msgtype": "m.text", "body": "rules unknown"}});
    let _mocks = mount_fetch_with(&fixture, &message, false, false).await;

    let fetched = fetch_cold_push_event(
        &fixture.data_dir,
        "@alice:example.org",
        "A",
        COLD_ROOM,
        "$unevaluated",
    )
    .await;

    assert!(
        matches!(fetched, PushFetchView::Event { .. }),
        "{fetched:?}"
    );
    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn an_unevaluated_encrypted_event_is_discarded_when_every_encrypted_event_is_pushed() {
    let fixture = ColdFixture::new(
        "fetch-unevaluated-msc4028",
        cold_room_without_me(),
        Some(pushes_every_encrypted_event()),
    )
    .await;
    let message = json!({"type": "m.room.message", "event_id": "$unevaluated",
        "sender": "@sender:example.org", "origin_server_ts": 1,
        "content": {"msgtype": "m.text", "body": "rules unknown"}});
    let _mocks = mount_fetch_with(&fixture, &message, false, true).await;

    let fetched = fetch_cold_push_event(
        &fixture.data_dir,
        "@alice:example.org",
        "A",
        COLD_ROOM,
        "$unevaluated",
    )
    .await;

    assert!(matches!(fetched, PushFetchView::Discard), "{fetched:?}");
    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn a_push_is_fetched_while_another_process_holds_the_store() {
    let fixture = ColdFixture::new("held", cold_room_with_members(), None).await;
    let app = FileSessionStore::try_exclusive(cold_push_store_dir(&fixture.data_dir))
        .unwrap()
        .unwrap();
    let message = json!({"type": "m.room.message", "event_id": "$extension",
        "sender": "@sender:example.org", "origin_server_ts": 1,
        "content": {"msgtype": "m.text", "body": "while the app runs"}});

    let PushFetchView::Event { event } = fetch(&fixture, "A", message).await else {
        panic!("a push must be fetched beside the app's process");
    };
    assert_eq!(event.content["body"], "while the app runs");

    drop(app);
    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn an_event_id_only_push_is_fetched_in_the_shape_of_a_rich_payload() {
    let fixture = ColdFixture::new("fetch", cold_room_with_members(), None).await;
    let message = json!({"type": "m.room.message", "event_id": "$fetched",
        "sender": "@sender:example.org", "origin_server_ts": 1,
        "content": {"msgtype": "m.text", "body": "fetched by id"}});

    let PushFetchView::Event { event } = fetch(&fixture, "A", message.clone()).await else {
        panic!("a push that names only its event must be fetched");
    };
    let payload = serde_json::to_value(&event).unwrap();
    assert_eq!(payload["type"], "m.room.message");
    assert_eq!(payload["content"]["body"], "fetched by id");
    assert_eq!(payload["sender"], "@sender:example.org");
    assert_ne!(event.room_name, "");
    assert!(!event.noisy);

    assert!(matches!(
        fetch(&fixture, "OTHER", message).await,
        PushFetchView::Unavailable
    ));

    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn an_ios_push_recovers_a_missing_key_from_backup() {
    push_backup_recovery(false).await;
}

#[tokio::test]
async fn an_android_push_recovers_a_missing_key_from_backup() {
    push_backup_recovery(true).await;
}

async fn push_backup_recovery(cached: bool) {
    use matrix_sdk_base::crypto::store::types::BackupDecryptionKey;
    use wiremock::matchers::{body_partial_json, method, path_regex};
    use wiremock::{Mock, ResponseTemplate};

    let tag = if cached {
        "backup-android"
    } else {
        "backup-ios"
    };
    let mut fixture = ColdFixture::new(tag, cold_room_with_members(), None).await;
    let sender = fixture.server.client_builder().build().await;
    let outbound = shared_room_key(&sender).await;
    let machine = sender.olm_machine_for_testing().await;
    let inbound = machine
        .as_ref()
        .unwrap()
        .store()
        .get_inbound_group_session(room_id!("!cold:example.org"), outbound.session_id())
        .await
        .unwrap()
        .unwrap();
    let backup_key = BackupDecryptionKey::new();
    let encrypted_key = backup_key
        .megolm_v1_public_key()
        .encrypt(inbound)
        .await
        .unwrap();
    Mock::given(method("GET"))
        .and(path_regex("/room_keys/version$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "algorithm": "m.megolm_backup.v1.curve25519-aes-sha2",
            "auth_data": {"public_key": backup_key.megolm_v1_public_key().to_base64()},
            "version": "1", "count": 1, "etag": "1"
        })))
        .mount(fixture.server.server())
        .await;
    let backup = Mock::given(method("GET"))
        .and(path_regex("/room_keys/keys/.+/.+$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(encrypted_key))
        .expect(1)
        .mount_as_scoped(fixture.server.server())
        .await;
    fixture
        .client
        .as_ref()
        .unwrap()
        .olm_machine_for_testing()
        .await
        .as_ref()
        .unwrap()
        .backup_machine()
        .save_decryption_key(Some(backup_key), Some("1".to_owned()))
        .await
        .unwrap();
    drop(fixture.client.take());

    let message: serde_json::Value = serde_json::from_str(
        &encrypted_push(
            &outbound,
            "m.room.message",
            json!({"msgtype": "m.text", "body": "recovered while closed"}),
        )
        .await,
    )
    .unwrap();
    let _fetch = mount_fetch_with(&fixture, &message, true, true).await;
    Mock::given(method("POST"))
        .and(path_regex("/sync$"))
        .and(body_partial_json(json!({"conn_id": "encryption"})))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"pos": "1"}))
                .set_delay(std::time::Duration::from_millis(50)),
        )
        .mount(fixture.server.server())
        .await;

    let session = if cached {
        session(&fixture).await
    } else {
        super::PushSession::open(
            &cold_push_store_dir(&fixture.data_dir),
            "@alice:example.org",
            "A",
            COLD_ROOM,
        )
        .await
        .unwrap()
    };
    let fetched = session.fetch("$cold").await;
    let PushFetchView::Event { event } = fetched else {
        panic!("unexpected notification: {fetched:?}");
    };
    assert_eq!(event.event_type, "m.room.message");
    assert_eq!(event.content["body"], "recovered while closed");
    drop(session);
    drop(backup);
    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn a_fetched_mention_is_noisy() {
    let fixture = ColdFixture::new("fetch-mention", cold_room_with_members(), None).await;
    let message = json!({"type": "m.room.message", "event_id": "$mention",
        "sender": "@sender:example.org", "origin_server_ts": 1,
        "content": {"msgtype": "m.text", "body": "alice?",
            "m.mentions": {"user_ids": ["@alice:example.org"]}}});

    let PushFetchView::Event { event } = fetch(&fixture, "A", message).await else {
        panic!("a mention must notify");
    };
    assert!(event.noisy);

    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn push_media_is_thumbnailed_once_and_reused() {
    let fixture = ColdFixture::new("media", media_room(None), None).await;
    let thumbnails = mount_thumbnails(&fixture, 1).await;
    let image = json!({"msgtype": "m.image", "body": "cat.png",
        "url": "mxc://example.org/cat"});

    let first = media(&fixture, Some(&image)).await;
    let read = |path: &str| std::fs::read(path).unwrap();
    assert_eq!(read(first.sender.as_deref().unwrap()), thumbnails["face"]);
    assert_eq!(read(first.room.as_deref().unwrap()), thumbnails["lounge"]);
    assert_eq!(read(first.own_avatar.as_deref().unwrap()), thumbnails["me"]);
    assert_eq!(first.own_name.as_deref(), Some("Alice"));
    let image_file = first.image.as_ref().unwrap();
    assert_eq!(read(&image_file.path), thumbnails["cat"]);
    assert_eq!(image_file.mimetype, "image/png");
    let again = media(&fixture, Some(&image)).await;
    assert_eq!(again.sender, first.sender);
    assert_eq!(again.image.unwrap().path, image_file.path);

    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn a_room_with_media_previews_off_gets_no_push_image() {
    let off = Raw::from_json_string(
        json!({"type": "m.media_preview_config", "content": {"media_previews": "off"}}).to_string(),
    )
    .unwrap();
    let fixture = ColdFixture::new("media-off", media_room(Some(off)), None).await;
    mount_thumbnails(&fixture, 0..=1).await;
    let image = json!({"msgtype": "m.image", "body": "cat.png",
        "url": "mxc://example.org/cat"});

    let media = media(&fixture, Some(&image)).await;
    assert!(media.image.is_none());
    assert!(media.sender.is_some());

    remove_data_dir(&fixture.data_dir).await;
}

fn media_room(
    account_data: Option<Raw<matrix_sdk::ruma::events::AnyRoomAccountDataEvent>>,
) -> JoinedRoomBuilder {
    let factory = matrix_sdk_test::event_factory::EventFactory::new()
        .room(room_id!("!cold:example.org"))
        .sender(user_id!("@sender:example.org"));
    let room = JoinedRoomBuilder::new(room_id!("!cold:example.org"))
        .add_state_event(
            factory
                .member(user_id!("@alice:example.org"))
                .display_name("Alice")
                .avatar_url(mxc_uri!("mxc://example.org/me")),
        )
        .add_state_event(
            factory
                .member(user_id!("@sender:example.org"))
                .avatar_url(mxc_uri!("mxc://example.org/face")),
        )
        .add_state_event(
            factory
                .room_avatar()
                .url(mxc_uri!("mxc://example.org/lounge")),
        )
        .add_state_event(factory.power_levels());
    match account_data {
        Some(event) => room.add_account_data(event),
        None => room,
    }
}

async fn mount_thumbnails(
    fixture: &ColdFixture,
    times: impl Into<wiremock::Times> + Clone,
) -> std::collections::HashMap<&'static str, Vec<u8>> {
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };

    let mut thumbnails = std::collections::HashMap::new();
    for media in ["face", "lounge", "me", "cat"] {
        let png = [b"\x89PNG\r\n\x1a\n".as_slice(), media.as_bytes()].concat();
        Mock::given(method("GET"))
            .and(path(format!(
                "/_matrix/client/v1/media/thumbnail/example.org/{media}"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(png.clone()))
            .expect(times.clone())
            .mount(fixture.server.server())
            .await;
        thumbnails.insert(media, png);
    }
    thumbnails
}

async fn media(fixture: &ColdFixture, content: Option<&serde_json::Value>) -> super::PushMedia {
    super::cold_push_media(
        &fixture.data_dir,
        "@alice:example.org",
        "A",
        COLD_ROOM,
        Some("@sender:example.org"),
        None,
        content,
    )
    .await
}

#[tokio::test]
async fn push_sender_names_without_a_session() {
    let data_dir = tempfile::tempdir().unwrap();
    for (sender, name, expected) in [
        (Some("@bob:example.org"), Some("Bob"), "Bob"),
        (
            Some("@bob:example.org"),
            Some("\u{200b}\u{2800}"),
            "@bob:example.org",
        ),
        (Some("@bob:example.org"), Some(" \t"), "@bob:example.org"),
        (Some("@bob:example.org"), None, "@bob:example.org"),
        (None, Some("Bob"), "Bob"),
        (None, Some("\u{200b}"), ""),
        (None, None, ""),
    ] {
        let media = super::cold_push_media(
            data_dir.path(),
            "@alice:example.org",
            "A",
            COLD_ROOM,
            sender,
            name,
            None,
        )
        .await;
        assert_eq!(media.sender_name, expected);
        assert_eq!(
            serde_json::to_value(media).unwrap()["sender_name"],
            expected
        );
    }
}

#[tokio::test]
async fn push_sender_names_without_a_room() {
    let fixture = ColdFixture::new("missing-room", cold_room_with_members(), None).await;
    let mut session = session(&fixture).await;
    session.room_id = room_id!("!missing:example.org").to_owned();
    let media = session
        .media(Some("@bob:example.org"), Some("\u{200b}\u{2800}"), None)
        .await;
    assert_eq!(media.sender_name, "@bob:example.org");
    drop(session);
    remove_data_dir(&fixture.data_dir).await;
}

#[tokio::test]
async fn one_push_session_fetches_the_event_and_its_media() {
    let fixture = ColdFixture::new("session", media_room(None), None).await;
    let thumbnails = mount_thumbnails(&fixture, 0..=1).await;
    let message = json!({"type": "m.room.message", "event_id": "$session",
        "sender": "@sender:example.org", "origin_server_ts": 1,
        "content": {"msgtype": "m.image", "body": "cat.png", "url": "mxc://example.org/cat"}});
    let _sync = mount_fetch(&fixture, &message).await;

    let session = super::PushSession::open(
        &cold_push_store_dir(&fixture.data_dir),
        "@alice:example.org",
        "A",
        COLD_ROOM,
    )
    .await
    .unwrap();
    let PushFetchView::Event { event } = session.fetch("$session").await else {
        panic!("the session must fetch the pushed event");
    };
    let media = session
        .media(
            Some(&event.sender),
            event.sender_display_name.as_deref(),
            Some(&event.content),
        )
        .await;
    assert_eq!(
        std::fs::read(media.image.unwrap().path).unwrap(),
        thumbnails["cat"]
    );

    drop(session);
    remove_data_dir(&fixture.data_dir).await;
}

async fn session(fixture: &ColdFixture) -> super::PushSession {
    super::cold_push_session(&fixture.data_dir, "@alice:example.org", "A", COLD_ROOM)
        .await
        .unwrap()
}

#[tokio::test]
async fn push_sender_names_follow_plain_and_sealed_profile_overrides() {
    use crate::sealed_account_data::{AccountDataKey, cache_key};

    const STABLE: &str = "m.profile_overrides";
    const UNSTABLE: &str = "org.matrix.msc4529.profile_overrides";
    let fixture = ColdFixture::new("nicknames", cold_room_with_members(), None).await;
    let client = fixture.client.as_ref().unwrap();
    let key = AccountDataKey::generate().unwrap();
    fixture
        .server
        .mock_sync()
        .ok_and_run(client, |builder| {
            builder.add_global_account_data(
                Raw::new(&json!({"type": UNSTABLE, "content": key.seal(
                UNSTABLE, &json!({"@sender:example.org":{"displayname":"Locked"}})
            ).unwrap()}))
                .unwrap()
                .cast_unchecked::<matrix_sdk::ruma::events::AnyGlobalAccountDataEvent>(),
            );
        })
        .await;
    assert_eq!(
        session(&fixture)
            .await
            .sender_name(Some("@sender:example.org"), Some("Payload"))
            .await,
        "Payload"
    );
    cache_key(client, &key).await;
    for (event_type, content, expected) in [
        (
            UNSTABLE,
            json!({"@sender:example.org":{"displayname":"Mum"}}),
            "Mum",
        ),
        (
            UNSTABLE,
            key.seal(
                UNSTABLE,
                &json!({"@sender:example.org":{"displayname":"Dad"}}),
            )
            .unwrap(),
            "Dad",
        ),
        (
            STABLE,
            json!({"@sender:example.org":{"displayname":"Friend"}}),
            "Friend",
        ),
        (
            STABLE,
            json!({"@sender:example.org":{"displayname":null}}),
            "@sender:example.org",
        ),
        (
            STABLE,
            json!({"@sender:example.org":{"displayname":"\u{200b}\u{2800}"}}),
            "@sender:example.org",
        ),
        (STABLE, json!({}), "Payload"),
    ] {
        fixture
            .server
            .mock_sync()
            .ok_and_run(client, |builder| {
                builder.add_global_account_data(
                    Raw::new(&json!({"type":event_type,"content":content}))
                        .unwrap()
                        .cast_unchecked::<matrix_sdk::ruma::events::AnyGlobalAccountDataEvent>(),
                );
            })
            .await;
        let session = session(&fixture).await;
        assert_eq!(
            session
                .sender_name(Some("@sender:example.org"), Some("Payload"))
                .await,
            expected
        );
        assert_eq!(
            session.sender_name(Some("@nobody:example.org"), None).await,
            "@nobody:example.org"
        );
        drop(session);
        assert_eq!(
            super::cold_push_media(
                &fixture.data_dir,
                "@alice:example.org",
                "A",
                COLD_ROOM,
                Some("@sender:example.org"),
                Some("Payload"),
                None,
            )
            .await
            .sender_name,
            expected
        );
    }
    remove_data_dir(&fixture.data_dir).await;
}

async fn mount_notified_event(fixture: &ColdFixture, thread_root: Option<&EventId>) {
    let message = matrix_sdk_test::event_factory::EventFactory::new()
        .room(room_id!("!cold:example.org"))
        .sender(user_id!("@sender:example.org"))
        .text_msg("hi")
        .event_id(event_id!("$notified"));
    let message = match thread_root {
        Some(root) => message.in_thread(root, root),
        None => message,
    };
    fixture
        .server
        .mock_room_event()
        .expect_access_token("test-token")
        .match_event_id()
        .ok(message.into_event())
        .mount()
        .await;
}

#[tokio::test]
async fn a_notification_reply_sends_the_text_then_reads_the_main_timeline() {
    use matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType;
    use matrix_sdk::ruma::events::receipt::ReceiptThread;

    for selected in [false, true] {
        let fixture = ColdFixture::new(&format!("reply-{selected}"), media_room(None), None).await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path_regex(r"/account_data/"))
            .respond_with(
                wiremock::ResponseTemplate::new(404)
                    .set_body_json(json!({"errcode": "M_NOT_FOUND", "error": "not found"})),
            )
            .with_priority(10)
            .mount(fixture.server.server())
            .await;
        let mut expected = json!({"msgtype": "m.text", "body": "on my way"});
        if selected {
            for (event_type, content) in [
                (
                    "fyi.cisnt.permessageprofile.roomassociation",
                    json!({"associations": {COLD_ROOM: {"profileId": "kris"}}}),
                ),
                (
                    "fi.mau.msc4461.per_message_profiles.v3",
                    json!({"profiles": [{"id": "kris", "displayname": "Kris"}]}),
                ),
            ] {
                wiremock::Mock::given(wiremock::matchers::method("GET"))
                    .and(wiremock::matchers::path_regex(format!(
                        "/account_data/{}$",
                        event_type.replace('.', "\\.")
                    )))
                    .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(content))
                    .mount(fixture.server.server())
                    .await;
            }
            expected[crate::personas::PER_MESSAGE_PROFILE] =
                json!({"id": "kris", "displayname": "Kris"});
        }
        mount_notified_event(&fixture, None).await;
        fixture
            .server
            .mock_room_state_encryption()
            .expect_access_token("test-token")
            .plain()
            .mount()
            .await;
        wiremock::Mock::given(wiremock::matchers::method("PUT"))
            .and(wiremock::matchers::path_regex(
                r"^/_matrix/client/v3/rooms/.*/send/m\.room\.message/reply-1$",
            ))
            .and(wiremock::matchers::body_partial_json(expected))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(json!({"event_id": "$reply"})),
            )
            .expect(1)
            .mount(fixture.server.server())
            .await;
        fixture
            .server
            .mock_send_receipt(ReceiptType::Read)
            .expect_access_token("test-token")
            .match_thread(ReceiptThread::Main)
            .match_event_id(event_id!("$notified"))
            .ok()
            .expect(1)
            .mount()
            .await;
        fixture
            .server
            .mock_send_receipt(ReceiptType::FullyRead)
            .expect_access_token("test-token")
            .match_event_id(event_id!("$notified"))
            .ok()
            .expect(1)
            .mount()
            .await;

        assert!(
            session(&fixture)
                .await
                .reply("on my way", "reply-1", "$notified", false,)
                .await,
            "selected={selected}"
        );

        remove_data_dir(&fixture.data_dir).await;
    }
}

#[tokio::test]
async fn a_notification_mark_read_stays_in_the_events_thread_and_privacy() {
    use matrix_sdk::ruma::api::client::receipt::create_receipt::v3::ReceiptType;
    use matrix_sdk::ruma::events::receipt::ReceiptThread;

    let fixture = ColdFixture::new("mark-read", media_room(None), None).await;
    let root = event_id!("$root");
    mount_notified_event(&fixture, Some(root)).await;
    fixture
        .server
        .mock_send_receipt(ReceiptType::ReadPrivate)
        .expect_access_token("test-token")
        .match_thread(ReceiptThread::Thread(root.to_owned()))
        .match_event_id(event_id!("$notified"))
        .ok()
        .expect(1)
        .mount()
        .await;
    fixture
        .server
        .mock_send_receipt(ReceiptType::FullyRead)
        .ok()
        .expect(0)
        .mount()
        .await;

    assert!(session(&fixture).await.mark_read("$notified", true,).await);

    remove_data_dir(&fixture.data_dir).await;
}

const OAUTH_USER: &str = "@example:localhost";
const OAUTH_DEVICE: &str = "DEVICEID";

fn oauth_session(server: &MatrixMockServer) -> PersistedSession {
    use matrix_sdk::test_utils::client::{mock_prev_session_tokens_with_refresh, oauth};

    PersistedSession {
        oauth_issuer: None,
        oauth_redirect_uri: None,
        resolved_homeserver: Some(server.uri().parse().unwrap()),
        homeserver: server.uri(),
        credentials: crate::session::Credentials::oauth(oauth::mock_session(
            mock_prev_session_tokens_with_refresh(),
        )),
    }
}

async fn seeded_cold_store(
    persisted: &PersistedSession,
    name: &str,
) -> (tempfile::TempDir, std::path::PathBuf, FileSessionStore) {
    let data_dir = tempfile::Builder::new()
        .prefix(&format!("sable-{name}-"))
        .tempdir()
        .unwrap();
    let store_dir = cold_push_store_dir(data_dir.path());
    let seeded = crate::session::restore_client(store_dir.to_str().unwrap(), persisted, true)
        .await
        .unwrap();
    crate::session::restore_credentials(&seeded, persisted)
        .await
        .unwrap();
    seeded
        .encryption()
        .wait_for_e2ee_initialization_tasks()
        .await;
    drop(seeded);
    let store = FileSessionStore::new(&store_dir);
    store
        .save(serde_json::to_vec(persisted).unwrap())
        .await
        .unwrap();
    (data_dir, store_dir, store)
}

/// The seeding client keeps fetching keys in the background after it is dropped, so
/// a count taken right away would also take in those late requests.
async fn settled_request_count(server: &MatrixMockServer) -> usize {
    let mut count = server.server().received_requests().await.unwrap().len();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let now = server.server().received_requests().await.unwrap().len();
        if now == count {
            return count;
        }
        count = now;
    }
}

async fn saved_refresh_token(store: &FileSessionStore, store_dir: &std::path::Path) -> String {
    let saved = store.load().await.unwrap().unwrap();
    let (accounts, _) =
        crate::session::AccountRegistry::from_bytes(&saved, store_dir.to_str().unwrap()).unwrap();
    let account = &accounts.accounts[0];
    crate::credentials::LoginTokens::new(store_dir)
        .read(
            &account.account_id,
            &account.session.credentials.device_id(),
        )
        .unwrap()
        .unwrap_or_else(|| account.session.credentials.tokens())
        .refresh_token
        .unwrap()
}

async fn mount_oauth_refresh(server: &MatrixMockServer, expected: u64, delay: std::time::Duration) {
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };

    server.oauth().mock_server_metadata().ok().mount().await;
    Mock::given(method("POST"))
        .and(path("/oauth2/token"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"access_token": "new-access", "expires_in": 300,
                    "refresh_token": "new-refresh", "token_type": "Bearer"}))
                .set_delay(delay),
        )
        .expect(expected)
        .mount(server.server())
        .await;
}

async fn mount_whoami(server: &MatrixMockServer) {
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{header, method, path},
    };

    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/account/whoami"))
        .and(header("authorization", "Bearer prev-access-token"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "errcode": "M_UNKNOWN_TOKEN", "error": "expired"
        })))
        .mount(server.server())
        .await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/account/whoami"))
        .and(header("authorization", "Bearer new-access"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user_id": OAUTH_USER, "device_id": OAUTH_DEVICE
        })))
        .mount(server.server())
        .await;
}

#[tokio::test]
async fn a_cold_push_never_uses_embedded_tokens_when_the_login_file_is_corrupt() {
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    let persisted = oauth_session(&server);
    let (_data_dir, store_dir, store) =
        seeded_cold_store(&persisted, "cold-push-corrupt-tokens").await;
    let saved = store.load().await.unwrap().unwrap();
    let logins = crate::credentials::LoginTokens::new(&store_dir);
    let repaired = matrix_sdk::SessionTokens {
        access_token: "repaired-access".to_owned(),
        refresh_token: Some("repaired-refresh".to_owned()),
    };
    logins.save("a1", OAUTH_DEVICE, &repaired).unwrap();
    let path = std::fs::read_dir(store_dir.join("login-tokens"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "tokens")
        })
        .unwrap();
    std::fs::write(&path, b"corrupt tokens").unwrap();
    let requests = settled_request_count(&server).await;

    assert!(
        restore_push_client(&store_dir, OAUTH_USER, OAUTH_DEVICE)
            .await
            .is_none()
    );
    assert_eq!(
        server.server().received_requests().await.unwrap().len(),
        requests
    );
    assert_eq!(store.load().await.unwrap().unwrap(), saved);
    assert_eq!(std::fs::read(path).unwrap(), b"corrupt tokens");

    logins.save("a1", OAUTH_DEVICE, &repaired).unwrap();
    let client = restore_push_client(&store_dir, OAUTH_USER, OAUTH_DEVICE)
        .await
        .unwrap();
    assert_eq!(client.session_tokens().unwrap(), repaired);
    assert_eq!(store.load().await.unwrap().unwrap(), saved);
    drop(client);
}

#[tokio::test]
async fn a_cold_push_saves_the_tokens_it_refreshes() {
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    let (_data_dir, store_dir, store) =
        seeded_cold_store(&oauth_session(&server), "cold-push-refresh").await;
    mount_oauth_refresh(&server, 1, std::time::Duration::ZERO).await;
    mount_whoami(&server).await;

    let client = restore_push_client(&store_dir, OAUTH_USER, OAUTH_DEVICE)
        .await
        .unwrap();
    client.retry(|| client.whoami()).await.unwrap();

    assert_eq!(saved_refresh_token(&store, &store_dir).await, "new-refresh");
    drop(client);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cold_push_cut_short_still_saves_the_rotated_tokens() {
    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    let (_data_dir, store_dir, store) =
        seeded_cold_store(&oauth_session(&server), "cold-push-cut-short").await;
    mount_oauth_refresh(&server, 1, std::time::Duration::from_millis(1500)).await;
    mount_whoami(&server).await;

    let cold_dir = store_dir.clone();
    tokio::task::spawn_blocking(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(super::settle_refreshes(tokio::time::timeout(
                std::time::Duration::from_millis(500),
                async {
                    let client = restore_push_client(&cold_dir, OAUTH_USER, OAUTH_DEVICE)
                        .await
                        .unwrap();
                    let _ = client.retry(|| client.whoami()).await;
                },
            )))
            .unwrap_err();
    })
    .await
    .unwrap();

    assert_eq!(saved_refresh_token(&store, &store_dir).await, "new-refresh");
}

#[tokio::test]
async fn a_cold_push_failure_with_a_live_token_does_not_rotate_it() {
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };

    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    let (_data_dir, store_dir, store) =
        seeded_cold_store(&oauth_session(&server), "cold-push-live-token").await;
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/account/whoami"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user_id": OAUTH_USER, "device_id": OAUTH_DEVICE
        })))
        .mount(server.server())
        .await;
    mount_oauth_refresh(&server, 0, std::time::Duration::ZERO).await;

    let client = restore_push_client(&store_dir, OAUTH_USER, OAUTH_DEVICE)
        .await
        .unwrap();
    client
        .retry(|| async { Err::<(), _>("the room key has not arrived") })
        .await
        .unwrap_err();

    assert_eq!(
        saved_refresh_token(&store, &store_dir).await,
        "prev-refresh-token"
    );
    drop(client);
}

#[tokio::test]
async fn a_push_client_never_refreshes_a_password_session() {
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path},
    };

    let server = MatrixMockServer::new().await;
    server.mock_versions().ok().mount().await;
    let persisted: PersistedSession = serde_json::from_value(json!({
        "homeserver": server.uri(), "resolved_homeserver": server.uri(),
        "credentials": {"kind": "password", "user_id": "@alice:example.org",
            "device_id": "A", "access_token": "old-access", "refresh_token": "old-refresh"}
    }))
    .unwrap();
    let (_data_dir, store_dir, store) = seeded_cold_store(&persisted, "cold-push-password").await;
    let saved = store.load().await.unwrap();
    Mock::given(method("GET"))
        .and(path("/_matrix/client/v3/account/whoami"))
        .respond_with(
            ResponseTemplate::new(401)
                .set_body_json(json!({"errcode": "M_UNKNOWN_TOKEN", "error": "expired"})),
        )
        .mount(server.server())
        .await;
    Mock::given(method("POST"))
        .and(path("/_matrix/client/v3/refresh"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"access_token": "new", "refresh_token": "new"})),
        )
        .expect(0)
        .mount(server.server())
        .await;

    let client = restore_push_client(&store_dir, "@alice:example.org", "A")
        .await
        .unwrap();
    client.retry(|| client.whoami()).await.unwrap_err();

    assert_eq!(store.load().await.unwrap(), saved);
    drop(client);
}

struct SharedLogin {
    _data_dir: tempfile::TempDir,
    base: std::path::PathBuf,
    core: std::sync::Arc<crate::Core>,
    account: crate::session::PersistedAccount,
    server: MatrixMockServer,
}

impl SharedLogin {
    async fn new() -> Self {
        let data_dir = tempfile::tempdir().unwrap();
        let server = MatrixMockServer::new().await;
        server.mock_versions().ok().mount().await;
        mount_oauth_refresh(&server, 1, std::time::Duration::ZERO).await;
        mount_whoami(&server).await;
        let account = saved_login_as(data_dir.path(), oauth_session(&server)).await;
        let core = core_of(data_dir.path());
        core.accounts().await.unwrap();
        Self {
            base: cold_push_store_dir(data_dir.path()),
            _data_dir: data_dir,
            core,
            account,
            server,
        }
    }

    async fn app_client(&self) -> matrix_sdk::Client {
        let lease = crate::session::store_lease(&self.account.store_id).await;
        self.core
            .saved_account_client(&self.account, &lease)
            .await
            .unwrap()
    }

    async fn push_client(&self) -> super::PushClient {
        super::cold::open_push_client(
            &self.base,
            OAUTH_USER,
            OAUTH_DEVICE,
            matrix_sdk::store::RoomLoadSettings::default(),
        )
        .await
        .unwrap()
    }

    async fn saved_refresh_token(&self) -> String {
        saved_refresh_token(&FileSessionStore::new(&self.base), &self.base).await
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_app_picks_up_the_tokens_a_push_client_refreshed() {
    let login = SharedLogin::new().await;
    let app = login.app_client().await;
    let push = login.push_client().await;
    let registry = std::fs::read(login.base.join("session.json")).unwrap();

    push.retry(|| push.whoami()).await.unwrap();
    assert_eq!(login.saved_refresh_token().await, "new-refresh");
    assert_eq!(
        std::fs::read(login.base.join("session.json")).unwrap(),
        registry
    );

    app.oauth().refresh_access_token().await.unwrap();
    assert_eq!(
        app.session_tokens().unwrap().refresh_token.as_deref(),
        Some("new-refresh")
    );
    drop((push, login.server));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_push_client_picks_up_the_tokens_the_app_refreshed() {
    let login = SharedLogin::new().await;
    let app = login.app_client().await;
    let push = login.push_client().await;

    app.oauth().refresh_access_token().await.unwrap();
    assert_eq!(login.saved_refresh_token().await, "new-refresh");

    push.retry(|| push.whoami()).await.unwrap();
    assert_eq!(
        push.session_tokens().unwrap().refresh_token.as_deref(),
        Some("new-refresh")
    );
    drop((push, login.server));
}

fn stub(event_type: &str, content: &serde_json::Value) -> serde_json::Value {
    json!({
        "type": event_type,
        "content": content,
        "event_id": "$1:example.org",
        "sender": "@alice:example.org",
        "origin_server_ts": 0,
    })
}

#[test]
fn every_notifiable_event_says_something() {
    let cases = [
        stub(
            "m.room.message",
            &json!({"msgtype": "m.text", "body": "hello"}),
        ),
        stub(
            "m.room.message",
            &json!({"msgtype": "m.image", "body": "cat.png", "url": "mxc://example.org/2"}),
        ),
        stub(
            "m.room.message",
            &json!({"msgtype": "dm.filament.gallery", "body": "", "itemtypes": [{"itemtype": "m.image", "body": "cat.png", "url": "mxc://example.org/3"}]}),
        ),
        stub(
            "m.room.encrypted",
            &json!({"algorithm": "m.megolm.v1.aes-sha2", "ciphertext": "x", "sender_key": "k", "device_id": "D", "session_id": "s"}),
        ),
        stub(
            "m.sticker",
            &json!({"body": "wave", "url": "mxc://example.org/1", "info": {"w": 1, "h": 1, "mimetype": "image/png", "size": 1}}),
        ),
        stub(
            "m.reaction",
            &json!({"m.relates_to": {"rel_type": "m.annotation", "event_id": "$0:example.org", "key": "👍"}}),
        ),
        stub(
            "org.matrix.msc3381.poll.start",
            &json!({"org.matrix.msc3381.poll.start": {"question": {"org.matrix.msc1767.text": "Lunch?"}, "answers": [{"id": "a", "org.matrix.msc1767.text": "Yes"}]}}),
        ),
        stub("m.room.topic", &json!({"topic": "hi"})),
    ];

    for case in cases {
        let body = describe(&event(&case));
        assert!(
            !body.is_empty(),
            "a notification for {case} would read as a bare sender name"
        );
    }
}

#[tokio::test]
async fn native_rtc_invites_use_validated_receiver_presentation() {
    use wiremock::{
        Mock, ResponseTemplate,
        matchers::{method, path_regex},
    };
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!push-call:example.org");
    let own = client.user_id().unwrap().to_owned();
    let sender = user_id!("@caller:example.org");
    let factory = matrix_sdk_test::event_factory::EventFactory::new()
        .room(room_id)
        .sender(sender);
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(room_id)
                .add_state_event(factory.member(&own))
                .add_state_event(factory.member(sender))
                .add_state_event(factory.power_levels()),
        )
        .await;
    let now = u64::from(MilliSecondsSinceUnixEpoch::now().get());
    let event = json!({
        "type":"m.rtc.invite", "event_id":"$push-invite", "room_id":room_id,
        "sender":sender, "origin_server_ts":now - 5_000,
        "sticky":{"duration_ms":300_000},
        "content":{"slot_id":"m.call#room", "sticky_key":"m.call#room",
            "sender_ts":now - 5_000,"lifetime":90_000,
            "notification_type":"ring", "m.mentions":{"user_ids":[own]}}
    });
    for withdrawn in [false, true] {
        let mut events = vec![event.clone()];
        if withdrawn {
            let mut withdrawal = event.clone();
            withdrawal["event_id"] = "$withdrawal".into();
            withdrawal["origin_server_ts"] = now.into();
            withdrawal["content"] = json!({"sticky_key":"m.call#room"});
            events.push(withdrawal);
        }
        let response = json!({"pos":"push-state", "rooms":{room_id.as_str():{
            "initial":true,"required_state":[{
                "type":"m.rtc.slot","state_key":"m.call#room","event_id":"$slot",
                "sender":sender,"origin_server_ts":now - 10_000,
                "content":{"status":"open","application":{"type":"m.call"}}
            }]
        }},"extensions":{"org.matrix.msc4354.sticky_events":{
            "next_batch":"push-sticky","rooms":{room_id.as_str():{"events":events}}
        }}});
        let guard = Mock::given(method("POST"))
            .and(path_regex("/sync$"))
            .respond_with(ResponseTemplate::new(200).set_body_json(response))
            .mount_as_scoped(server.server())
            .await;
        let prepared = super::cold::prepared_push_event(&room, &event.to_string(), true).await;
        if withdrawn {
            assert_eq!(prepared, ColdPush::Discard);
        } else {
            let ColdPush::Clear(clear) = prepared else {
                panic!("active invitation must notify");
            };
            let clear: serde_json::Value = serde_json::from_str(&clear).unwrap();
            assert_eq!(clear["content"]["notification_type"], "ring");
            assert_eq!(clear["content"]["body"], "Call started");
            assert!(clear["content"]["lifetime"].as_u64().unwrap() <= 85_000);
            assert_eq!(clear[super::NOISY_KEY], true);
        }
        drop(guard);
    }
    assert_eq!(event["content"]["notification_type"], "ring");
}
