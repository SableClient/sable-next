use linkify::{LinkFinder, LinkKind};
use matrix_sdk::ruma::{
    OwnedRoomId, UInt,
    events::room::message::{
        AudioMessageEventContent, FileMessageEventContent, GalleryItemType,
        ImageMessageEventContent, MessageType, VideoMessageEventContent,
    },
};

use crate::Core;
use crate::protocol::{
    CommandErr, RoomAttachmentContentView, RoomAttachmentKind, RoomAttachmentView,
};
use crate::view::{image_thumbnail, media_source, spoiler_reason, video_thumbnail};

impl Core {
    pub(crate) async fn room_attachments(
        &self,
        room_id: &OwnedRoomId,
        kind: RoomAttachmentKind,
        limit: usize,
        from: Option<&str>,
    ) -> Result<(Vec<RoomAttachmentView>, Option<String>), CommandErr> {
        self.room(room_id).await?;
        let before = from.and_then(parse_cursor);
        let ignored = self.ignored_senders().await;
        let (items, next) = self
            .attachment_page(
                room_id,
                kind,
                &ignored,
                before
                    .as_ref()
                    .map(|(ts, event_id)| (*ts, event_id.as_str())),
                limit,
            )
            .await;
        Ok((items, next.map(|(ts, event_id)| format!("{ts}:{event_id}"))))
    }
}

fn parse_cursor(cursor: &str) -> Option<(u64, String)> {
    let (ts, event_id) = cursor.split_once(':')?;
    Some((ts.parse().ok()?, event_id.to_owned()))
}

pub(crate) fn link_urls(body: &str) -> Vec<String> {
    let mut finder = LinkFinder::new();
    finder.kinds(&[LinkKind::Url]);
    let mut urls: Vec<String> = Vec::new();
    for url in finder.links(body).map(|link| link.as_str()) {
        let lower = url.to_ascii_lowercase();
        let http = lower.starts_with("https://") || lower.starts_with("http://");
        if http && !urls.iter().any(|seen| seen == url) {
            urls.push(url.to_owned());
        }
    }
    urls
}

pub(crate) const fn fits(kind: RoomAttachmentKind, content: &RoomAttachmentContentView) -> bool {
    match kind {
        RoomAttachmentKind::Media => matches!(
            content,
            RoomAttachmentContentView::Image { .. } | RoomAttachmentContentView::Video { .. }
        ),
        RoomAttachmentKind::File => matches!(content, RoomAttachmentContentView::File { .. }),
        RoomAttachmentKind::Link => false,
    }
}

pub(crate) fn attachment_contents(
    msgtype: &MessageType,
    content: Option<&serde_json::Value>,
) -> Vec<(Option<u32>, RoomAttachmentContentView)> {
    let spoiler = spoiler_reason(content);
    match msgtype {
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
                    content
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
    }
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
    use super::{link_urls, parse_cursor};

    #[test]
    fn link_urls_lists_each_url_once() {
        assert_eq!(
            link_urls("https://a.example https://b.example https://a.example"),
            ["https://a.example", "https://b.example"]
        );
    }

    #[test]
    fn a_cursor_keeps_the_colon_of_a_v1_event_id() {
        assert_eq!(
            parse_cursor("1700:$event:example.org"),
            Some((1700, "$event:example.org".to_owned()))
        );
    }
}
