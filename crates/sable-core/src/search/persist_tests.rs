use matrix_sdk::ruma::{room_id, user_id};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_test::async_test;

use super::{
    Cover, StoredCrawlRoom, forget_crawl, ignored_unchanged, load_crawl, purge_legacy, save_crawl,
    save_ignored,
};
use crate::search::store::Store;

fn checkpoint() -> StoredCrawlRoom {
    StoredCrawlRoom {
        shared_resume: false,
        frontier: Some(9),
        gapped: false,
        token: Some("older".to_owned()),
        reached_start: false,
        cover: Some(Cover {
            anchor: None,
            from: 1,
            until: 2,
            resume: None,
            stops: false,
        }),
        hole: None,
    }
}

#[async_test]
async fn test_crawl_checkpoints_come_back_as_saved_until_forgotten() {
    let store = Store::memory();
    let rooms = [(room_id!("!crawl:localhost").to_owned(), checkpoint())].into();

    assert!(load_crawl(&store).await.rooms.is_empty());
    assert!(save_crawl(&store, rooms).await);

    let stored = load_crawl(&store).await;
    assert_eq!(stored.rooms.len(), 1);
    assert_eq!(
        stored.rooms[room_id!("!crawl:localhost")].token.as_deref(),
        Some("older")
    );

    assert!(forget_crawl(&store).await);
    assert!(load_crawl(&store).await.rooms.is_empty());
}

#[async_test]
async fn test_the_ignored_users_are_remembered_to_spot_a_change() {
    let store = Store::memory();
    let ignored = [user_id!("@troll:localhost").to_owned()];

    assert!(!ignored_unchanged(&store, &ignored).await);
    save_ignored(&store, &ignored).await;
    assert!(ignored_unchanged(&store, &ignored).await);
    assert!(!ignored_unchanged(&store, &[]).await);
}

#[async_test]
async fn test_the_index_an_older_version_kept_in_the_state_store_is_deleted_once() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let state = client.state_store();
    let room = room_id!("!old:localhost").to_owned();
    let old = [
        b"sable.search.rooms".to_vec(),
        b"sable.search.crawl".to_vec(),
        b"sable.search.ignored".to_vec(),
        format!("sable.search.documents.{room}").into_bytes(),
        format!("sable.search.chunk.{room}.0").into_bytes(),
        format!("sable.search.chunk.{room}.1").into_bytes(),
    ];
    for key in &old {
        state.set_custom_value(key, b"old".to_vec()).await.unwrap();
    }
    state
        .set_custom_value(
            format!("sable.search.room.{room}").as_bytes(),
            serde_json::to_vec(&serde_json::json!({ "next_chunk": 2 })).unwrap(),
        )
        .await
        .unwrap();
    state
        .set_custom_value(b"sable.reactions", b"kept".to_vec())
        .await
        .unwrap();
    state
        .set_custom_value(b"sable.search.rooms", serde_json::to_vec(&[&room]).unwrap())
        .await
        .unwrap();

    let store = Store::memory();
    purge_legacy(&store, &client, "store").await;

    for key in &old {
        assert!(
            state.get_custom_value(key).await.unwrap().is_none(),
            "{} survived",
            String::from_utf8_lossy(key)
        );
    }
    assert!(
        state
            .get_custom_value(format!("sable.search.room.{room}").as_bytes())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        state
            .get_custom_value(b"sable.reactions")
            .await
            .unwrap()
            .as_deref(),
        Some(b"kept".as_slice())
    );

    state
        .set_custom_value(b"sable.search.crawl", b"new".to_vec())
        .await
        .unwrap();
    purge_legacy(&store, &client, "store").await;
    assert!(
        state
            .get_custom_value(b"sable.search.crawl")
            .await
            .unwrap()
            .is_some(),
        "the purge runs once per database"
    );
}
