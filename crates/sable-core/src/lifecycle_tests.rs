use std::sync::Arc;
use std::time::Duration;

use matrix_sdk::ruma::{OwnedDeviceId, OwnedUserId, room_id};
use matrix_sdk::test_utils::mocks::MatrixMockServer;

use crate::Core;
use crate::api::session::SwitchAccountParams;
use crate::session::{self, AccountRegistry, AccountState, PersistedAccount};
use crate::store::MemorySessionStore;

const SETTLES: Duration = Duration::from_secs(15);

struct Accounts {
    core: Arc<Core>,
    events: tokio::sync::mpsc::UnboundedReceiver<crate::protocol::CoreEvent>,
    _servers: Vec<MatrixMockServer>,
    _base: tempfile::TempDir,
}

async fn two_accounts() -> Accounts {
    let base = tempfile::tempdir().unwrap();
    let (core, events) = Core::new(
        base.path().join("data").to_str().unwrap(),
        Box::new(MemorySessionStore::default()),
    );
    let mut registry = AccountRegistry::empty();
    let mut servers = Vec::new();
    for account_id in ["first", "second"] {
        let server = MatrixMockServer::new().await;
        server
            .mock_versions()
            .with_simplified_sliding_sync()
            .ok()
            .mount()
            .await;
        keep_syncing(&server, account_id).await;
        let user_id: OwnedUserId = format!("@{account_id}:example.org").parse().unwrap();
        let device_id: OwnedDeviceId = format!("{account_id}-device").into();
        let client = server
            .client_builder()
            .no_server_versions()
            .logged_in_with_token(format!("token-{account_id}"), user_id, device_id)
            .build()
            .await;
        server
            .sync_joined_room(&client, room_id!("!room:example.org"))
            .await;
        let account = PersistedAccount {
            account_id: account_id.to_owned(),
            store_id: session::account_store_id(&core.store_id, account_id),
            session: session::current_session(&client, server.uri()).unwrap(),
            state: AccountState::Usable,
        };
        let seeded = session::restore_client(&account.store_id, &account.session, true)
            .await
            .unwrap();
        session::restore_credentials(&seeded, &account.session)
            .await
            .unwrap();
        drop(seeded);
        core.save_login_tokens(&account).await.unwrap();
        registry.upsert(account);
        servers.push(server);
    }
    registry.active_account_id = Some("first".to_owned());
    core.write_registry(&registry).await.unwrap();
    assert_eq!(
        settled(core.restore()).await.unwrap().unwrap().account_id,
        "first"
    );
    Accounts {
        core,
        events,
        _servers: servers,
        _base: base,
    }
}

async fn keep_syncing(server: &MatrixMockServer, account_id: &'static str) {
    let counter = std::sync::atomic::AtomicU64::new(0);
    wiremock::Mock::given(wiremock::matchers::method("POST"))
        .and(wiremock::matchers::path_regex(".*simplified_msc3575/sync$"))
        .respond_with(move |_: &wiremock::Request| {
            let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            wiremock::ResponseTemplate::new(200)
                .set_delay(Duration::from_millis(100))
                .set_body_json(serde_json::json!({
                    "pos": n.to_string(),
                    "lists": { "all_rooms": { "count": 1 } },
                    "rooms": {
                        "!room:example.org": {
                            "name": "Room",
                            "initial": n == 0,
                            "timeline": [{
                                "type": "m.room.message",
                                "event_id": format!("$m{n}-{account_id}"),
                                "sender": "@other:example.org",
                                "origin_server_ts": 1_700_000_000_000_u64 + n,
                                "content": { "msgtype": "m.text", "body": format!("marmalade {n}") }
                            }]
                        }
                    },
                    "extensions": {}
                }))
        })
        .mount(server.server())
        .await;
}

async fn settled<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(SETTLES, Box::pin(work))
        .await
        .expect("a lifecycle operation never finished")
}

async fn switch(core: &Arc<Core>, account_id: &str) {
    settled(core.switch_account(SwitchAccountParams {
        account_id: account_id.to_owned(),
    }))
    .await
    .unwrap();
    assert_eq!(core.active_session_info().unwrap().account_id, account_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn switching_back_and_forth_finishes() {
    let accounts = two_accounts().await;
    for account_id in ["second", "first", "second", "first"] {
        switch(&accounts.core, account_id).await;
    }
    settled(accounts.core.shutdown()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn switching_while_the_app_suspends_and_resumes_finishes() {
    let accounts = two_accounts().await;
    let core = &accounts.core;
    core.activity.close_stores_when_suspended();
    for account_id in ["second", "first", "second", "first"] {
        let background = {
            let core = core.clone();
            tokio::spawn(async move { Box::pin(core.update_app_active(false)).await })
        };
        let switched = {
            let core = core.clone();
            let account_id = account_id.to_owned();
            tokio::spawn(async move {
                core.switch_account(SwitchAccountParams { account_id })
                    .await
            })
        };
        settled(background).await.unwrap();
        settled(core.update_app_active(true)).await;
        settled(switched).await.unwrap().unwrap();
        assert!(core.activity.stores_open());
        assert_eq!(core.active_session_info().unwrap().account_id, account_id);
    }
    settled(accounts.core.shutdown()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn switching_to_an_account_a_push_is_using_shares_its_client() {
    let accounts = two_accounts().await;
    let core = &accounts.core;
    let store = std::path::Path::new(&core.store_id).to_owned();
    let push = settled(crate::notifications::restore_push_client(
        &store,
        "@second:example.org",
        "second-device",
    ))
    .await
    .expect("the push borrows the idle account");

    switch(core, "second").await;
    drop(push);
    settle(core).await;
    assert!(core.clients.contains("second"));
    switch(core, "first").await;
    settled(accounts.core.shutdown()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lent_client_stays_until_its_last_push_is_done() {
    let accounts = two_accounts().await;
    let core = &accounts.core;
    let store = std::path::Path::new(&core.store_id).to_owned();
    let lend = || {
        Box::pin(crate::notifications::restore_push_client(
            &store,
            "@second:example.org",
            "second-device",
        ))
    };
    let first = settled(lend()).await.unwrap();
    let second = settled(lend()).await.unwrap();

    drop(first);
    settle(core).await;
    assert!(core.clients.contains("second"));
    drop(second);
    settle(core).await;
    assert!(!core.clients.contains("second"));
    settled(accounts.core.shutdown()).await;
}

async fn settle(core: &Arc<Core>) {
    settled(core.supervise("test settle", |_, _| Box::pin(async {})))
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn switching_while_pushes_arrive_for_both_accounts_finishes() {
    let accounts = two_accounts().await;
    let core = &accounts.core;
    core.activity.close_stores_when_suspended();
    let store = std::path::Path::new(&core.store_id).to_owned();
    let pushes = tokio::spawn({
        let store = store.clone();
        async move {
            for round in 0..20 {
                let (user, device) = if round % 2 == 0 {
                    ("@second:example.org", "second-device")
                } else {
                    ("@first:example.org", "first-device")
                };
                let push = Box::pin(crate::notifications::restore_push_client(
                    &store, user, device,
                ))
                .await;
                tokio::time::sleep(Duration::from_millis(20)).await;
                drop(push);
            }
        }
    });
    for (round, account_id) in ["second", "first", "second", "first", "second"]
        .into_iter()
        .enumerate()
    {
        if round % 2 == 0 {
            settled(core.update_app_active(false)).await;
            settled(core.update_app_active(true)).await;
        }
        switch(core, account_id).await;
    }
    settled(pushes).await.unwrap();
    settled(accounts.core.shutdown()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn logging_out_again_with_no_session_keeps_the_other_accounts() {
    let accounts = two_accounts().await;
    let core = &accounts.core;
    settled(core.logout()).await.unwrap();
    assert!(core.signed_in().is_err());

    settled(core.logout()).await.unwrap();

    let saved = core.accounts().await.unwrap().accounts;
    assert_eq!(saved.len(), 1);
    assert!(saved[0].state.usable());
    switch(core, "second").await;
    settled(core.shutdown()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_operation_keeps_its_own_generation_across_a_switch() {
    let accounts = two_accounts().await;
    let core = &accounts.core;
    let first = core.signed_in().unwrap();
    let generation = first.generation();
    assert!(core.is_current(generation));

    switch(core, "second").await;

    assert!(first.has_ended());
    assert_eq!(first.generation(), generation);
    assert!(!core.is_current(generation));
    assert!(core.is_current(core.signed_in().unwrap().generation()));
    core.activity.lock_account(generation);
    assert!(!core.activity.account_locked());
    assert!(core.sync_allowed());
    settled(core.shutdown()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tokens_that_never_left_the_registry_are_moved_when_the_account_opens() {
    let accounts = two_accounts().await;
    let core = &accounts.core;
    let store = std::path::Path::new(&core.store_id).to_owned();
    crate::credentials::LoginTokens::new(&store).forget("second");
    core.unmoved_tokens.lock().insert("second".to_owned());

    switch(core, "second").await;

    assert!(core.unmoved_tokens.lock().is_empty());
    crate::credentials::LoginTokens::new(&store)
        .read("second", "second-device")
        .unwrap()
        .unwrap();
    settled(core.shutdown()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_logout_waits_for_a_push_before_it_changes_anything() {
    let accounts = two_accounts().await;
    let core = &accounts.core;
    let store = std::path::Path::new(&core.store_id).to_owned();
    let push = settled(Box::pin(crate::notifications::restore_push_client(
        &store,
        "@first:example.org",
        "first-device",
    )))
    .await
    .unwrap();
    let logout = tokio::spawn({
        let core = core.clone();
        async move { core.logout().await }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert!(!logout.is_finished());
    assert_eq!(core.active_session_info().unwrap().account_id, "first");
    assert_eq!(core.accounts().await.unwrap().accounts.len(), 2);

    drop(push);
    settled(logout).await.unwrap().unwrap();
    assert!(core.signed_in().is_err());
    assert_eq!(core.accounts().await.unwrap().accounts.len(), 1);
    settled(core.shutdown()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_job_cancelled_while_ending_the_session_leaves_none_half_ended() {
    let accounts = two_accounts().await;
    let core = &accounts.core;
    let first = core.signed_in().unwrap();
    core.set_job_deadline(Duration::from_millis(200));

    let stuck = core
        .supervise("stuck teardown", move |_, _| {
            Box::pin(async move {
                first.state().ended.cancel();
                std::future::pending::<()>().await;
            })
        })
        .await;

    stuck.unwrap_err();
    settle(core).await;
    assert!(core.active_session_info().is_none());
    core.set_job_deadline(SETTLES);
    assert_eq!(
        settled(core.restore()).await.unwrap().unwrap().account_id,
        "first"
    );
    settled(core.shutdown()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_ended_session_is_quiesced_once_its_tasks_and_methods_are_gone() {
    struct Gone(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Gone {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    use crate::tasks::JoinHandleExt as _;

    let accounts = two_accounts().await;
    let core = &accounts.core;
    let session = core.signed_in().unwrap();
    let gone = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let held = Gone(gone.clone());
    session.track_session_task(
        tokio::spawn(async move {
            let _held = held;
            std::future::pending::<()>().await;
        })
        .abort_on_drop(),
    );
    let method = session.begin_operation();

    let ended = core.end_session().await.unwrap();

    assert!(gone.load(std::sync::atomic::Ordering::SeqCst));
    let state = ended.state.clone();
    let quiesced = tokio::spawn(async move { state.quiesced().await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!quiesced.is_finished());
    drop(method);
    assert!(settled(quiesced).await.unwrap());
    settled(core.shutdown()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_job_cancelled_after_the_session_is_gone_tells_the_app() {
    let mut accounts = two_accounts().await;
    let core = accounts.core.clone();
    core.set_job_deadline(Duration::from_millis(500));

    let stuck = core
        .supervise("stuck after teardown", |core, supervised| {
            Box::pin(async move {
                core.take_session(&supervised).await;
                std::future::pending::<()>().await;
            })
        })
        .await;

    stuck.unwrap_err();
    settle(&core).await;
    assert!(core.active_session_info().is_none());
    let told = settled(async {
        loop {
            match accounts.events.recv().await {
                Some(crate::protocol::CoreEvent::SessionEnded { reason }) => break reason,
                Some(_) => {}
                None => panic!("the core's events ended"),
            }
        }
    })
    .await;
    assert_eq!(told, "lifecycle_failed");
    core.set_job_deadline(SETTLES);
    settled(core.shutdown()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stuck_job_that_changed_no_session_leaves_it_running() {
    let accounts = two_accounts().await;
    let core = &accounts.core;
    core.set_job_deadline(Duration::from_millis(200));

    let stuck = core
        .supervise("stuck elsewhere", |_, _| {
            Box::pin(std::future::pending::<()>())
        })
        .await;

    stuck.unwrap_err();
    settle(core).await;
    assert_eq!(core.active_session_info().unwrap().account_id, "first");
    assert!(!core.signed_in().unwrap().has_ended());
    core.set_job_deadline(SETTLES);
    settled(core.shutdown()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_logout_stops_the_methods_still_running_and_removes_the_account() {
    let accounts = two_accounts().await;
    let core = &accounts.core;
    let session = core.signed_in().unwrap();
    let running = tokio::spawn(async move {
        let _method = session.begin_operation();
        session.until_discarded(std::future::pending::<()>()).await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;

    settled(core.logout()).await.unwrap();

    assert!(settled(running).await.unwrap().is_none());
    assert_eq!(core.accounts().await.unwrap().accounts.len(), 1);
    settled(core.shutdown()).await;
}
