use std::sync::Arc;

use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_ui::sync_service::SyncService;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::Core;
use crate::protocol::CoreEvent;
use crate::session::Session;
use crate::store::MemorySessionStore;

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
    *core.session.write().await = Some(Session {
        account_id: "test".to_owned(),
        homeserver: server.server().uri(),
        oauth: false,
        sync_service: Arc::new(SyncService::builder(client.clone()).build().await.unwrap()),
        client,
    });
    (core, events)
}
