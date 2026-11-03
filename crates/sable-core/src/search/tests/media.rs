use matrix_sdk::ruma::{event_id, room_id, user_id};
use matrix_sdk::test_utils::mocks::MatrixMockServer;
use matrix_sdk_test::{JoinedRoomBuilder, async_test, event_factory::EventFactory};

use super::{document, logged_in, reingest_whole_room};
use crate::search::MessageIndex;

#[test]
fn test_a_migrated_picture_without_media_asks_to_be_hydrated_once() {
    let room = matrix_sdk::ruma::RoomId::parse("!migrated:localhost").expect("room id");
    let mut index = MessageIndex::new();
    index
        .rooms
        .entry(room.clone())
        .or_insert_with(crate::search::RoomIndex::new)
        .upsert(document(
            "old",
            "beach.png",
            "@kris:localhost",
            1,
            Some(crate::protocol::SearchAttachment::Image),
            Vec::new(),
        ));
    let page = |tried: std::collections::HashSet<matrix_sdk::ruma::OwnedEventId>| {
        index.attachment_page(
            &room,
            crate::protocol::RoomAttachmentKind::Media,
            &[],
            None,
            10,
            &crate::search::index::PageWork {
                tried,
                ..crate::search::index::PageWork::default()
            },
        )
    };

    let crate::search::index::PageStep::Hydrate(asked) = page(std::collections::HashSet::new())
    else {
        panic!("expected a hydrate step");
    };
    assert_eq!(asked, [event_id!("$old").to_owned()]);

    assert!(
        matches!(page(asked.into_iter().collect()), crate::search::index::PageStep::Done(items, None) if items.is_empty())
    );
}

#[async_test]
async fn test_the_gallery_fills_in_media_for_a_migrated_message() {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    let room_id = room_id!("!hydrate:localhost").to_owned();
    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(&room_id).add_timeline_event(
                EventFactory::new()
                    .room(&room_id)
                    .sender(user_id!("@kris:localhost"))
                    .image(
                        "beach.png".to_owned(),
                        matrix_sdk::ruma::owned_mxc_uri!("mxc://localhost/beach"),
                    )
                    .event_id(event_id!("$image")),
            ),
        )
        .await;
    let core = logged_in(&server, &client, "search-hydrate").await;
    core.search_index
        .lock()
        .await
        .rooms
        .entry(room_id.clone())
        .or_insert_with(crate::search::RoomIndex::new)
        .upsert(document(
            "image",
            "beach.png",
            "@kris:localhost",
            1,
            Some(crate::protocol::SearchAttachment::Image),
            Vec::new(),
        ));

    let (items, _) = core
        .attachment_page(
            &room_id,
            crate::protocol::RoomAttachmentKind::Media,
            &[],
            None,
            10,
        )
        .await;

    assert!(matches!(
        items.as_slice(),
        [crate::protocol::RoomAttachmentView {
            content: crate::protocol::RoomAttachmentContentView::Image { source, .. },
            ..
        }] if source == "mxc://localhost/beach"
    ));
    let index = core.search_index.lock().await;
    let stored = index.rooms[&room_id]
        .document(&event_id!("$image").to_owned())
        .expect("still indexed");
    assert_eq!(stored.media.len(), 1);
    assert!(index.rooms[&room_id].dirty);
    drop(room);
}

#[async_test]
async fn test_room_attachments_sort_the_index_into_media_files_and_links() {
    use crate::protocol::RoomAttachmentKind;

    use matrix_sdk::ruma::events::room::message::{
        FileMessageEventContent, MessageType, RoomMessageEventContent,
    };

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;

    let room_id = room_id!("!attachments:localhost").to_owned();
    let factory = EventFactory::new()
        .room(&room_id)
        .sender(user_id!("@kris:localhost"));
    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(&room_id)
                .add_timeline_event(
                    factory
                        .image(
                            "beach.png".to_owned(),
                            matrix_sdk::ruma::owned_mxc_uri!("mxc://localhost/beach"),
                        )
                        .event_id(event_id!("$image")),
                )
                .add_timeline_event(
                    factory
                        .event(RoomMessageEventContent::new(MessageType::File(
                            FileMessageEventContent::plain(
                                "notes.pdf".to_owned(),
                                matrix_sdk::ruma::owned_mxc_uri!("mxc://localhost/notes"),
                            ),
                        )))
                        .event_id(event_id!("$file")),
                )
                .add_timeline_event(
                    factory
                        .text_msg(
                            "tickets at https://example.org/tickets and javascript://%0Aalert(1)",
                        )
                        .event_id(event_id!("$link")),
                )
                .add_timeline_event(
                    factory
                        .text_msg("nothing to see")
                        .event_id(event_id!("$plain")),
                ),
        )
        .await;

    let core = logged_in(&server, &client, "room-attachments").await;
    let (cache, _drop_handles) = client
        .event_cache()
        .unwrap()
        .room(&room_id)
        .await
        .expect("room event cache");
    reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

    let (media, next) = core
        .room_attachments(&room_id, RoomAttachmentKind::Media, 10, None)
        .await
        .expect("media");
    assert!(next.is_none());
    assert!(matches!(
        media.as_slice(),
        [crate::protocol::RoomAttachmentView {
            content: crate::protocol::RoomAttachmentContentView::Image { filename, source, .. },
            ..
        }] if filename == "beach.png" && source == "mxc://localhost/beach"
    ));

    let (files, _) = core
        .room_attachments(&room_id, RoomAttachmentKind::File, 10, None)
        .await
        .expect("files");
    assert!(matches!(
        files.as_slice(),
        [crate::protocol::RoomAttachmentView {
            content: crate::protocol::RoomAttachmentContentView::File { filename, .. },
            ..
        }] if filename == "notes.pdf"
    ));

    let (links, _) = core
        .room_attachments(&room_id, RoomAttachmentKind::Link, 10, None)
        .await
        .expect("links");
    assert!(matches!(
        links.as_slice(),
        [crate::protocol::RoomAttachmentView {
            content: crate::protocol::RoomAttachmentContentView::Link { urls, .. },
            ..
        }] if urls == &["https://example.org/tickets".to_owned()]
    ));

    drop(room);
}

#[async_test]
async fn test_room_attachments_list_each_gallery_item_under_its_tab() {
    use crate::protocol::RoomAttachmentKind;

    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;

    let room_id = room_id!("!gallery-attachments:localhost").to_owned();
    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_room(
            &client,
            JoinedRoomBuilder::new(&room_id).add_timeline_event(
                serde_json::from_value::<
                    matrix_sdk::ruma::serde::Raw<matrix_sdk::ruma::events::AnySyncTimelineEvent>,
                >(serde_json::json!({
                    "type": "m.room.message",
                    "event_id": "$gallery",
                    "sender": "@kris:localhost",
                    "origin_server_ts": 1,
                    "content": {
                        "msgtype": "dm.filament.gallery",
                        "body": "",
                        "itemtypes": [
                            {
                                "itemtype": "m.image",
                                "body": "beach.png",
                                "url": "mxc://localhost/beach",
                                "page.codeberg.everypizza.msc4193.spoiler": true
                            },
                            {
                                "itemtype": "m.file",
                                "body": "notes.pdf",
                                "url": "mxc://localhost/notes",
                                "info": { "mimetype": "application/pdf", "size": 4096 }
                            },
                            {
                                "itemtype": "m.video",
                                "body": "wave.mp4",
                                "url": "mxc://localhost/wave"
                            }
                        ]
                    }
                }))
                .expect("gallery event"),
            ),
        )
        .await;

    let core = logged_in(&server, &client, "gallery-attachments").await;
    let (cache, _drop_handles) = client
        .event_cache()
        .unwrap()
        .room(&room_id)
        .await
        .expect("room event cache");
    reingest_whole_room(&mut *core.search_index.lock().await, &cache, &room_id).await;

    let (media, _) = core
        .room_attachments(&room_id, RoomAttachmentKind::Media, 10, None)
        .await
        .expect("media");
    let media = serde_json::to_value(&media).expect("media json");
    assert_eq!(media.as_array().map(Vec::len), Some(2));
    assert_eq!(media[0]["event_id"], "$gallery");
    assert_eq!(media[0]["gallery_index"], 0);
    assert_eq!(media[0]["content"]["spoiler"], "");
    assert_eq!(media[1]["gallery_index"], 2);
    assert_eq!(media[1]["content"]["kind"], "video");

    let (files, _) = core
        .room_attachments(&room_id, RoomAttachmentKind::File, 10, None)
        .await
        .expect("files");
    let files = serde_json::to_value(&files).expect("files json");
    assert_eq!(files.as_array().map(Vec::len), Some(1));
    assert_eq!(files[0]["gallery_index"], 1);
    assert_eq!(files[0]["content"]["filename"], "notes.pdf");
    assert_eq!(files[0]["content"]["size"], 4096);

    let filter = crate::search::IndexFilter {
        rooms: vec![room_id.clone()],
        ..crate::search::IndexFilter::default()
    };
    let hits = core
        .search_messages(
            "notes",
            &filter,
            crate::api::search::SearchOrder::Rank,
            10,
            0,
            0,
        )
        .await;
    assert_eq!(
        hits.iter()
            .map(|hit| hit.event_id.as_str())
            .collect::<Vec<_>>(),
        ["$gallery"]
    );

    drop(room);
}
