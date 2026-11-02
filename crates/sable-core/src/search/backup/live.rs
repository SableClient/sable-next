use std::sync::atomic::Ordering;
use std::time::Duration;

use matrix_sdk::Client;
use matrix_sdk::config::SyncSettings;
use matrix_sdk::ruma::OwnedRoomId;
use matrix_sdk::ruma::api::client::room::create_room;
use matrix_sdk::ruma::events::room::message::RoomMessageEventContent;
use matrix_sdk::ruma::room_version_rules::RedactionRules;
use matrix_sdk_ui::sync_service::SyncService;

use super::{BACKUP_EVENT, BackupSession, DAY_MS};
use crate::Core;
use crate::live_member_tests::register;
use crate::protocol::SearchBackupState;
use crate::sealed_account_data::{AccountDataKey, cache_key};
use crate::search::crawl::CrawlOutcome;
use crate::search::now_ms;
use crate::search::tests::in_room;
use crate::store::MemorySessionStore;

const MESSAGES: usize = 30;

async fn login(base: &str, user_id: &str) -> Client {
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

fn core(name: &str) -> std::sync::Arc<Core> {
    let (core, _events) = Core::new(name, Box::new(MemorySessionStore::default()));
    core.search_backup.enabled.store(true, Ordering::Relaxed);
    core.search_backup.limit_mb.store(100, Ordering::Relaxed);
    core
}

async fn crawled_room(base: &str, user_id: &str, key: &AccountDataKey) -> (Client, OwnedRoomId) {
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
    cache_key(&publisher, key).await;
    (publisher, room.room_id().to_owned())
}

async fn crawl_to_start(core: &Core, client: &Client, room_id: &OwnedRoomId) {
    let (cache, _drop) = client.event_cache().unwrap().room(room_id).await.unwrap();
    let events = cache.events().await.unwrap();
    core.search_index
        .lock()
        .await
        .ingest(room_id, events, &cache, &RedactionRules::V11)
        .await;
    loop {
        let CrawlOutcome::Batch(batch) = core.crawl_once(client, room_id).await.unwrap() else {
            continue;
        };
        if batch.reached_start {
            core.search_crawl
                .lock()
                .await
                .settle(room_id.clone(), batch.exhausted);
            break;
        }
    }
    core.flush_search_index(client).await;
}

async fn sliding_sync_reader(
    base: &str,
    user_id: &str,
    room_id: &OwnedRoomId,
) -> (Client, SyncService) {
    let reader = login(base, user_id).await;
    let sync = SyncService::builder(reader.clone())
        .with_offline_mode()
        .build()
        .await
        .unwrap();
    sync.start().await;
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Some(room) = reader.get_room(room_id)
                && room.encryption_state().is_encrypted()
                && room
                    .account_data(BACKUP_EVENT.into())
                    .await
                    .unwrap()
                    .is_some()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .expect("the backup manifest reaches the reader through sliding sync");
    (reader, sync)
}

async fn needles(core: &Core, room_id: &OwnedRoomId) -> usize {
    in_room(&*core.search_index.lock().await, room_id, "needle", 100, 0).len()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a homeserver at SABLE_TEST_HOMESERVER"]
async fn a_second_device_searches_history_it_never_crawled() {
    let base = std::env::var("SABLE_TEST_HOMESERVER").unwrap();
    let http = reqwest::Client::new();
    let account = register(&http, &base, &format!("backup{}", now_ms())).await;
    let key = AccountDataKey::from_bytes([42; 32]);
    let later = now_ms() + 2 * DAY_MS;

    let (publisher, room_id) = crawled_room(&base, &account.user_id, &key).await;
    let publishing = core("backup-publisher");
    crawl_to_start(&publishing, &publisher, &room_id).await;
    assert_eq!(needles(&publishing, &room_id).await, MESSAGES);
    publishing
        .backup_pass(&publisher, &mut BackupSession::default(), later)
        .await;
    let status = publishing.search_backup.view(0);
    assert_eq!(status.state, SearchBackupState::Idle);
    assert_eq!(status.rooms_published, 1);
    assert!(status.published_bytes > 0);

    let (reader, sync) = sliding_sync_reader(&base, &account.user_id, &room_id).await;
    cache_key(&reader, &key).await;
    let reading = core("backup-reader");
    reading
        .backup_pass(&reader, &mut BackupSession::default(), later)
        .await;

    assert_eq!(needles(&reading, &room_id).await, MESSAGES);
    let cover = reading
        .search_crawl
        .lock()
        .await
        .cover_of(&room_id)
        .cloned()
        .expect("the reader keeps where the backup ends");
    assert_eq!(cover.from, 0);
    assert!(cover.stops);

    let outcome = reading.crawl_once(&reader, &room_id).await.unwrap();
    assert!(matches!(
        outcome,
        CrawlOutcome::Batch(batch) if batch.reached_start && batch.exhausted
    ));
    sync.stop().await;
}
