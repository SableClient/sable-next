use std::sync::Arc;

use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_ui::sync_service::SyncService;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::protocol::CoreEvent;
use crate::session::Session;
use crate::store::MemorySessionStore;
use crate::{Core, SignedIn};

pub(crate) async fn sticky_update(room: &matrix_sdk::Room, events: Vec<serde_json::Value>) {
    use ruma::{api::client::sync::sync_events::msc4186 as v5, serde::Raw};
    let mut response = v5::Response::new("sticky".to_owned());
    let mut sticky = v5::response::StickyEventsRoom::default();
    sticky.events = events
        .iter()
        .map(|event| Raw::new(event).unwrap().cast_unchecked())
        .collect();
    response
        .extensions
        .sticky_events
        .rooms
        .insert(room.room_id().to_owned(), sticky);
    room.client()
        .process_sliding_sync_test_helper(
            &response,
            &matrix_sdk_base::RequestedRequiredStates::default(),
        )
        .await
        .unwrap();
}

pub(crate) async fn signed_in_core(
    server: &MatrixMockServer,
    client: matrix_sdk::Client,
) -> (Arc<Core>, UnboundedReceiver<CoreEvent>) {
    let (core, events) = Core::new("test", Box::new(MemorySessionStore::default()));
    sign_in(&core, server, client).await;
    (core, events)
}

pub(crate) async fn sign_in(core: &Core, server: &MatrixMockServer, client: matrix_sdk::Client) {
    set_session(
        core,
        Some(Session {
            account_id: "test".to_owned(),
            homeserver: server.server().uri(),
            oauth: false,
            state: Arc::default(),
            sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
            client,
        }),
    );
}

#[cfg(not(target_family = "wasm"))]
pub(crate) async fn wait_until_retired(core: &Core, account_id: &str) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while core
            .accounts()
            .await
            .unwrap()
            .accounts
            .iter()
            .any(|account| account.account_id == account_id)
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the replaced sign-in is retired");
}

#[derive(Clone, Default)]
pub(crate) struct TestWriter(pub(crate) Arc<parking_lot::Mutex<Vec<u8>>>);

impl std::io::Write for TestWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().write(bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.lock().flush()
    }
}

#[cfg(not(target_family = "wasm"))]
pub(crate) fn plant_tokens_sealed_with_another_key(
    base: &std::path::Path,
    account_id: &str,
    device_id: &str,
    tokens: &matrix_sdk::SessionTokens,
) {
    let other = tempfile::tempdir().unwrap();
    crate::credentials::LoginTokens::new(other.path())
        .save(account_id, device_id, tokens)
        .unwrap();
    let foreign = std::fs::read_dir(other.path().join("login-tokens"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "tokens")
        })
        .unwrap();
    std::fs::copy(
        &foreign,
        base.join("login-tokens").join(foreign.file_name().unwrap()),
    )
    .unwrap();
}

#[cfg(not(target_family = "wasm"))]
pub(crate) fn watch_for_deadlocks() {
    static WATCHER: std::sync::Once = std::sync::Once::new();
    WATCHER.call_once(|| {
        std::thread::Builder::new()
            .name("deadlock-watcher".to_owned())
            .spawn(|| {
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    let deadlocks = parking_lot::deadlock::check_deadlock();
                    if deadlocks.is_empty() {
                        continue;
                    }
                    for (index, threads) in deadlocks.iter().enumerate() {
                        eprintln!("deadlock #{index}");
                        for thread in threads {
                            eprintln!("thread {:?}\n{:?}", thread.thread_id(), thread.backtrace());
                        }
                    }
                    std::process::abort();
                }
            })
            .expect("the deadlock watcher starts");
    });
}

pub(crate) async fn session_for(server: &MatrixMockServer, client: matrix_sdk::Client) -> SignedIn {
    let (core, _events) = signed_in_core(server, client).await;
    core.signed_in().unwrap()
}

#[expect(
    clippy::disallowed_methods,
    reason = "tests publish sessions without running a sign-in"
)]
pub(crate) fn set_session(core: &Core, session: Option<Session>) {
    if let Some(session) = &session {
        session.state.generation.store(
            core.lifecycle.current(),
            std::sync::atomic::Ordering::SeqCst,
        );
    }
    *core.session.write() = session;
}

#[expect(
    clippy::disallowed_methods,
    reason = "tests inspect whichever session is current"
)]
pub(crate) fn current_state(core: &Core) -> Option<Arc<crate::SessionState>> {
    core.session.current(|session| session.state.clone())
}
