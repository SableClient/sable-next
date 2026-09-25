use futures_util::{StreamExt, stream};
use linkify::{LinkFinder, LinkKind};
use matrix_sdk::Room;
use matrix_sdk::ruma::{
    OwnedRoomId, UInt,
    events::{
        AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
        room::message::{
            AudioMessageEventContent, FileMessageEventContent, GalleryItemType,
            ImageMessageEventContent, MessageType, VideoMessageEventContent,
        },
    },
};

use crate::Core;
use crate::protocol::{
    CommandErr, RoomAttachmentContentView, RoomAttachmentKind, RoomAttachmentView,
    SearchAttachment, SearchFilter, SearchOrder,
};
use crate::search::Hit;
use crate::view::{image_thumbnail, media_source, spoiler_reason, video_thumbnail};

const CONCURRENT_EVENT_READS: usize = 8;

impl Core {
    pub(crate) async fn room_attachments(
        &self,
        room_id: &OwnedRoomId,
        kind: RoomAttachmentKind,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<RoomAttachmentView>, bool), CommandErr> {
        let room = self.room(room_id).await?;
        let filter = SearchFilter {
            rooms: vec![room_id.clone()],
            has: searched(kind),
            ..SearchFilter::default()
        };
        let hits = self
            .search_messages("", &filter, SearchOrder::Recent, limit, offset)
            .await;
        let exhausted = hits.len() < limit;

        let items = match kind {
            RoomAttachmentKind::Link => hits.into_iter().filter_map(link_view).collect(),
            RoomAttachmentKind::Media | RoomAttachmentKind::File => {
                stream::iter(hits.into_iter().map(|hit| media_views(&room, hit, kind)))
                    .buffered(CONCURRENT_EVENT_READS)
                    .flat_map(stream::iter)
                    .collect()
                    .await
            }
        };

        Ok((items, exhausted))
    }
}

fn searched(kind: RoomAttachmentKind) -> Vec<SearchAttachment> {
    match kind {
        RoomAttachmentKind::Media => vec![SearchAttachment::Image, SearchAttachment::Video],
        RoomAttachmentKind::File => vec![SearchAttachment::File, SearchAttachment::Audio],
        RoomAttachmentKind::Link => vec![SearchAttachment::Link],
    }
}

fn link_view(hit: Hit) -> Option<RoomAttachmentView> {
    let mut finder = LinkFinder::new();
    finder.kinds(&[LinkKind::Url]);
    let mut urls: Vec<String> = Vec::new();
    for url in finder.links(&hit.body).map(|link| link.as_str()) {
        let lower = url.to_ascii_lowercase();
        let http = lower.starts_with("https://") || lower.starts_with("http://");
        if http && !urls.iter().any(|seen| seen == url) {
            urls.push(url.to_owned());
        }
    }
    if urls.is_empty() {
        return None;
    }

    Some(RoomAttachmentView {
        event_id: hit.event_id,
        gallery_index: None,
        sender: hit.sender,
        timestamp: hit.origin_server_ts,
        content: RoomAttachmentContentView::Link {
            urls,
            body: hit.body,
        },
    })
}

async fn media_views(room: &Room, hit: Hit, kind: RoomAttachmentKind) -> Vec<RoomAttachmentView> {
    let Some(event) = room.load_or_fetch_event(&hit.event_id, None).await.ok() else {
        return Vec::new();
    };
    let Some(AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
        SyncMessageLikeEvent::Original(message),
    ))) = event.raw().deserialize().ok()
    else {
        return Vec::new();
    };
    let raw_content = event
        .raw()
        .get_field::<serde_json::Value>("content")
        .ok()
        .flatten();
    let spoiler = spoiler_reason(raw_content.as_ref());

    let contents: Vec<(Option<u32>, RoomAttachmentContentView)> = match &message.content.msgtype {
        MessageType::Image(image) => vec![(None, image_view(image, spoiler))],
        MessageType::Video(video) => vec![(None, video_view(video, spoiler))],
        MessageType::File(file) => vec![(None, file_view(file))],
        MessageType::Audio(audio) => vec![(None, audio_view(audio))],
        MessageType::Gallery(gallery) => gallery
            .itemtypes
            .iter()
            .enumerate()
            .filter_map(|(position, item)| {
                let spoiler = spoiler_reason(
                    raw_content
                        .as_ref()
                        .and_then(|content| content.get("itemtypes"))
                        .and_then(|items| items.get(position)),
                );
                match item {
                    GalleryItemType::Image(image) => Some(image_view(image, spoiler)),
                    GalleryItemType::Video(video) => Some(video_view(video, spoiler)),
                    GalleryItemType::File(file) => Some(file_view(file)),
                    GalleryItemType::Audio(audio) => Some(audio_view(audio)),
                    _ => None,
                }
            })
            .enumerate()
            .map(|(index, content)| (u32::try_from(index).ok(), content))
            .collect(),
        _ => Vec::new(),
    };

    contents
        .into_iter()
        .filter(|(_, content)| match kind {
            RoomAttachmentKind::Media => matches!(
                content,
                RoomAttachmentContentView::Image { .. } | RoomAttachmentContentView::Video { .. }
            ),
            RoomAttachmentKind::File => matches!(content, RoomAttachmentContentView::File { .. }),
            RoomAttachmentKind::Link => false,
        })
        .map(|(gallery_index, content)| RoomAttachmentView {
            event_id: hit.event_id.clone(),
            gallery_index,
            sender: hit.sender.clone(),
            timestamp: hit.origin_server_ts,
            content,
        })
        .collect()
}

fn dimension(value: Option<UInt>) -> Option<u64> {
    value.map(u64::from)
}

fn image_view(
    image: &ImageMessageEventContent,
    spoiler: Option<String>,
) -> RoomAttachmentContentView {
    RoomAttachmentContentView::Image {
        filename: image.filename().to_owned(),
        source: media_source(&image.source),
        mime: image.info.as_ref().and_then(|info| info.mimetype.clone()),
        width: dimension(image.info.as_ref().and_then(|info| info.width)),
        height: dimension(image.info.as_ref().and_then(|info| info.height)),
        blurhash: image.info.as_ref().and_then(|info| info.blurhash.clone()),
        thumbnail: image.info.as_deref().and_then(image_thumbnail),
        spoiler,
    }
}

fn video_view(
    video: &VideoMessageEventContent,
    spoiler: Option<String>,
) -> RoomAttachmentContentView {
    RoomAttachmentContentView::Video {
        filename: video.filename().to_owned(),
        source: media_source(&video.source),
        mime: video.info.as_ref().and_then(|info| info.mimetype.clone()),
        width: dimension(video.info.as_ref().and_then(|info| info.width)),
        height: dimension(video.info.as_ref().and_then(|info| info.height)),
        blurhash: video.info.as_ref().and_then(|info| info.blurhash.clone()),
        thumbnail: video.info.as_deref().and_then(video_thumbnail),
        spoiler,
    }
}

fn file_view(file: &FileMessageEventContent) -> RoomAttachmentContentView {
    RoomAttachmentContentView::File {
        filename: file.filename().to_owned(),
        source: media_source(&file.source),
        mime: file.info.as_ref().and_then(|info| info.mimetype.clone()),
        size: dimension(file.info.as_ref().and_then(|info| info.size)),
    }
}

fn audio_view(audio: &AudioMessageEventContent) -> RoomAttachmentContentView {
    RoomAttachmentContentView::File {
        filename: audio.filename().to_owned(),
        source: media_source(&audio.source),
        mime: audio.info.as_ref().and_then(|info| info.mimetype.clone()),
        size: dimension(audio.info.as_ref().and_then(|info| info.size)),
    }
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::{owned_event_id, owned_room_id, owned_user_id};

    use super::link_view;
    use crate::protocol::RoomAttachmentContentView;
    use crate::search::Hit;

    #[test]
    fn link_view_lists_each_url_once() {
        let hit = Hit {
            room_id: owned_room_id!("!room:example.org"),
            event_id: owned_event_id!("$event"),
            body: "https://a.example https://b.example https://a.example".to_owned(),
            sender: owned_user_id!("@alice:example.org"),
            origin_server_ts: 0,
            score: 0.0,
        };
        let Some(view) = link_view(hit) else {
            panic!("expected a link view");
        };
        let RoomAttachmentContentView::Link { urls, .. } = view.content else {
            panic!("expected link content");
        };
        assert_eq!(urls, ["https://a.example", "https://b.example"]);
    }
}
