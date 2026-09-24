use futures_util::{StreamExt, stream};
use linkify::{LinkFinder, LinkKind};
use matrix_sdk::Room;
use matrix_sdk::ruma::{
    OwnedRoomId, UInt,
    events::{
        AnySyncMessageLikeEvent, AnySyncTimelineEvent, SyncMessageLikeEvent,
        room::message::MessageType,
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
                stream::iter(hits.into_iter().map(|hit| media_view(&room, hit)))
                    .buffered(CONCURRENT_EVENT_READS)
                    .filter_map(|view| async move { view })
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
    let urls: Vec<String> = finder
        .links(&hit.body)
        .map(|link| link.as_str())
        .filter(|url| {
            let lower = url.to_ascii_lowercase();
            lower.starts_with("https://") || lower.starts_with("http://")
        })
        .map(ToOwned::to_owned)
        .collect();
    if urls.is_empty() {
        return None;
    }

    Some(RoomAttachmentView {
        event_id: hit.event_id,
        sender: hit.sender,
        timestamp: hit.origin_server_ts,
        content: RoomAttachmentContentView::Link {
            urls,
            body: hit.body,
        },
    })
}

async fn media_view(room: &Room, hit: Hit) -> Option<RoomAttachmentView> {
    let event = room.load_or_fetch_event(&hit.event_id, None).await.ok()?;
    let AnySyncTimelineEvent::MessageLike(AnySyncMessageLikeEvent::RoomMessage(
        SyncMessageLikeEvent::Original(message),
    )) = event.raw().deserialize().ok()?
    else {
        return None;
    };
    let raw_content = event
        .raw()
        .get_field::<serde_json::Value>("content")
        .ok()
        .flatten();
    let spoiler = spoiler_reason(raw_content.as_ref());
    let dimension = |value: Option<UInt>| value.map(u64::from);

    let content = match message.content.msgtype {
        MessageType::Image(image) => RoomAttachmentContentView::Image {
            filename: image.filename().to_owned(),
            source: media_source(&image.source),
            mime: image.info.as_ref().and_then(|info| info.mimetype.clone()),
            width: dimension(image.info.as_ref().and_then(|info| info.width)),
            height: dimension(image.info.as_ref().and_then(|info| info.height)),
            blurhash: image.info.as_ref().and_then(|info| info.blurhash.clone()),
            thumbnail: image.info.as_deref().and_then(image_thumbnail),
            spoiler,
        },
        MessageType::Video(video) => RoomAttachmentContentView::Video {
            filename: video.filename().to_owned(),
            source: media_source(&video.source),
            mime: video.info.as_ref().and_then(|info| info.mimetype.clone()),
            width: dimension(video.info.as_ref().and_then(|info| info.width)),
            height: dimension(video.info.as_ref().and_then(|info| info.height)),
            blurhash: video.info.as_ref().and_then(|info| info.blurhash.clone()),
            thumbnail: video.info.as_deref().and_then(video_thumbnail),
            spoiler,
        },
        MessageType::File(file) => RoomAttachmentContentView::File {
            filename: file.filename().to_owned(),
            source: media_source(&file.source),
            mime: file.info.as_ref().and_then(|info| info.mimetype.clone()),
            size: dimension(file.info.as_ref().and_then(|info| info.size)),
        },
        MessageType::Audio(audio) => RoomAttachmentContentView::File {
            filename: audio.filename().to_owned(),
            source: media_source(&audio.source),
            mime: audio.info.as_ref().and_then(|info| info.mimetype.clone()),
            size: dimension(audio.info.as_ref().and_then(|info| info.size)),
        },
        _ => return None,
    };

    Some(RoomAttachmentView {
        event_id: hit.event_id,
        sender: hit.sender,
        timestamp: hit.origin_server_ts,
        content,
    })
}
