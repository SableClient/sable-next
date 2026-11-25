use std::sync::Arc;

use matrix_sdk::Client;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::ruma::OwnedRoomId;
use matrix_sdk::ruma::api::client::room::create_room;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::room_version_rules::RedactionRules;

use crate::Core;
use crate::search::crawl::CrawlOutcome;
use crate::search::tests::in_room;

const MESSAGES: usize = 30;

pub(super) async fn login(base: &str, user_id: &str) -> Client {
    let client = Client::builder()
        .homeserver_url(base)
        .build()
        .await
        .unwrap();
    client
        .matrix_auth()
        .login_username(user_id, "pw-pw-pw-1")
        .send()
        .await
        .unwrap();
    client
}

pub(super) async fn crawled_room(base: &str, user_id: &str) -> (Client, OwnedRoomId) {
    let publisher = login(base, user_id).await;
    publisher.sync_once(SyncSettings::default()).await.unwrap();
    let room = publisher
        .create_room(create_room::v3::Request::default())
        .await
        .unwrap();
    room.enable_encryption().await.unwrap();
    for n in 0..MESSAGES {
        room.send(RoomMessageEventContent::text_plain(format!(
            "needle number {n}"
        )))
        .await
        .unwrap();
    }
    publisher.sync_once(SyncSettings::default()).await.unwrap();
    (publisher, room.room_id().to_owned())
}

pub(super) async fn crawl_to_start(core: &Arc<Core>, client: &Client, room_id: &OwnedRoomId) {
    let session = core.signed_in().unwrap();
    let (cache, _drop) = client.event_cache().unwrap().room(room_id).await.unwrap();
    let events = cache.events().await.unwrap();
    session
        .state()
        .search_index
        .lock()
        .await
        .ingest(room_id, events, &cache, &RedactionRules::V11)
        .await;
    loop {
        let CrawlOutcome::Batch(batch) = session.crawl_once(room_id).await.unwrap() else {
            continue;
        };
        if batch.reached_start {
            session
                .state()
                .search_crawl
                .lock()
                .settle(room_id.clone(), batch.exhausted);
            break;
        }
    }
}

pub(super) async fn needles(core: &Arc<Core>, room_id: &OwnedRoomId) -> usize {
    let session = core.signed_in().unwrap();
    in_room(
        &*session.state().search_index.lock().await,
        room_id,
        "needle",
        100,
        0,
    )
    .len()
}
