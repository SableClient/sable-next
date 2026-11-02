use std::time::Duration;

use matrix_sdk::{
    Room,
    attachment::{AttachmentConfig, AttachmentInfo, BaseImageInfo, GalleryConfig, GalleryItemInfo},
    ruma::room_id,
    test_utils::mocks::MatrixMockServer,
};

use crate::{
    api::timeline::TimelineFocusView,
    protocol::{GalleryItemView, TimelineItemContentView},
    timelines::build_room_timeline,
    view::{Highlights, LocalContent, SPOILER_PROPERTY, timeline_item},
};

fn spoiler_content(spoiler: bool) -> Option<serde_json::Map<String, serde_json::Value>> {
    spoiler.then(|| serde_json::Map::from_iter([(SPOILER_PROPERTY.to_owned(), true.into())]))
}

#[expect(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::missing_assert_message,
    reason = "test code"
)]
async fn uploading_contents(queue: impl AsyncFnOnce(&Room)) -> Vec<TimelineItemContentView> {
    let server = MatrixMockServer::new().await;
    let client = server.client_builder().build().await;
    client.send_queue().set_enabled(false).await;
    server.mock_room_state_encryption().plain().mount().await;
    let room = server
        .sync_joined_room(&client, room_id!("!spoiler-upload:example.org"))
        .await;
    let timeline = build_room_timeline(&room, &TimelineFocusView::Live, false)
        .await
        .unwrap();
    let (_, mut updates) = room.send_queue().subscribe().await.unwrap();

    queue(&room).await;

    let mut live_content = LocalContent::default();
    while let Ok(update) = updates.try_recv() {
        live_content.apply(&update);
    }
    let (echoes, _) = room.send_queue().subscribe().await.unwrap();
    let restored_content = LocalContent::new(&echoes);
    let items = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let items = timeline.items().await;
            if items.iter().any(|item| item.as_event().is_some()) {
                break items;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the upload's local echo reaches the timeline");
    let item = items.iter().find(|item| item.as_event().is_some()).unwrap();

    [live_content, restored_content]
        .iter()
        .map(|local_content| {
            let view = timeline_item(
                item,
                client.user_id(),
                &Highlights::default(),
                local_content,
            );
            assert!(view.event_id.is_none());
            assert!(view.send_state.is_some());
            view.content
        })
        .collect()
}

#[tokio::test]
async fn uploading_media_keeps_its_spoiler_in_the_local_echo() {
    for mime in ["image/png", "video/mp4"] {
        for spoiler in [false, true] {
            let contents = uploading_contents(async |room| {
                room.send_queue()
                    .send_attachment(
                        "spoiler-media",
                        mime.parse().unwrap(),
                        vec![1, 2, 3],
                        AttachmentConfig {
                            extra_content: spoiler_content(spoiler),
                            ..AttachmentConfig::default()
                        },
                    )
                    .await
                    .unwrap();
            })
            .await;

            for content in contents {
                let (TimelineItemContentView::Image {
                    spoiler: actual, ..
                }
                | TimelineItemContentView::Video {
                    spoiler: actual, ..
                }) = content
                else {
                    panic!("expected image or video content");
                };
                assert_eq!(actual, spoiler.then(String::new), "{mime}");
            }
        }
    }
}

#[tokio::test]
async fn uploading_gallery_keeps_each_item_spoiler_in_the_local_echo() {
    let contents = uploading_contents(async |room| {
        let mut gallery = GalleryConfig::new();
        for spoiler in [true, false] {
            gallery = gallery.add_item(GalleryItemInfo {
                filename: format!("{spoiler}.png"),
                content_type: mime::IMAGE_PNG,
                data: vec![1, 2, 3],
                attachment_info: AttachmentInfo::Image(BaseImageInfo::default()),
                caption: None,
                thumbnail: None,
                extra_content: spoiler_content(spoiler),
            });
        }
        room.send_queue().send_gallery(gallery).await.unwrap();
    })
    .await;

    for content in contents {
        let TimelineItemContentView::Gallery { items, .. } = content else {
            panic!("expected gallery content");
        };
        let spoilers: Vec<_> = items
            .into_iter()
            .map(|item| match item {
                GalleryItemView::Image { spoiler, .. } => spoiler,
                _ => panic!("expected image items"),
            })
            .collect();
        assert_eq!(spoilers, [Some(String::new()), None]);
    }
}
