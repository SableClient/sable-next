use std::sync::Arc;

use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_ui::sync_service::SyncService;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::Core;
use crate::protocol::CoreEvent;
use crate::session::Session;
use crate::store::MemorySessionStore;

pub(crate) async fn signed_in_core(
    server: &MatrixMockServer,
    client: matrix_sdk::Client,
) -> (Arc<Core>, UnboundedReceiver<CoreEvent>) {
    let (core, events) = Core::new("test", Box::new(MemorySessionStore::default()));
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        homeserver: server.server().uri(),
        oauth: false,
        sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
        client,
    });
    (core, events)
}
