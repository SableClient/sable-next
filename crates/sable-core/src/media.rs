use std::time::Duration;

use matrix_sdk::attachment::{
    AttachmentInfo, BaseAudioInfo, BaseFileInfo, BaseImageInfo, BaseVideoInfo,
};
use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::{
    OwnedEventId, OwnedMxcUri, OwnedRoomId, OwnedUserId, UInt,
    events::room::message::TextMessageEventContent,
};
use matrix_sdk_ui::timeline::{AttachmentConfig, AttachmentSource};
use mime::Mime;

use crate::messages::outgoing_mentions;
use crate::personas::profile_extra_content;
use crate::protocol::{AttachmentInfoView, CommandErr, PerMessageProfileView};

use crate::Core;

const MAX_ATTACHMENT_BYTES: usize = 100 * 1024 * 1024;

impl Core {
    /// Authenticated media needs the access token, so the fetch happens here.
    ///
    /// # Errors
    ///
    /// Returns an error when the media URI is invalid, the user is logged out,
    /// or the homeserver rejects the request.
    pub async fn media_thumbnail(
        &self,
        source: String,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, CommandErr> {
        let source: MediaSource = serde_json::from_str(&source)
            .unwrap_or_else(|_| MediaSource::Plain(OwnedMxcUri::from(source)));
        if let MediaSource::Plain(uri) = &source
            && uri.parts().is_err()
        {
            return Err(CommandErr::InvalidMedia);
        }

        let format = if width == 0 || height == 0 {
            MediaFormat::File
        } else {
            MediaFormat::Thumbnail(MediaThumbnailSettings::new(width.into(), height.into()))
        };
        let client = self.client().await?;
        let request = MediaRequestParameters {
            source: source.clone(),
            format,
        };

        let media = media_label(&source);

        match client.media().get_media_content(&request, true).await {
            Ok(bytes) => Ok(bytes),
            Err(error) if width != 0 && height != 0 && answered_by_server(&error) => {
                tracing::warn!(%media, "thumbnail refused, falling back to the original: {error}");
                client
                    .media()
                    .get_media_content(
                        &MediaRequestParameters {
                            source,
                            format: MediaFormat::File,
                        },
                        true,
                    )
                    .await
                    .map_err(|error| {
                        tracing::warn!(%media, "the original is unavailable too: {error}");
                        CommandErr::Unavailable
                    })
            }
            Err(error) => {
                tracing::warn!(%media, width, height, "media unavailable: {error}");
                Err(CommandErr::Unavailable)
            }
        }
    }

    /// For the avatar commands. Not for attachments: `send_attachment` keeps the
    /// upload and the event in one queue entry so they retry together.
    ///
    /// # Errors
    ///
    /// Returns an error when the MIME type is invalid, the user is logged out,
    /// or the upload fails.
    pub async fn upload_media(&self, mime: String, bytes: Vec<u8>) -> Result<String, CommandErr> {
        let mime: Mime = mime.parse().map_err(|_| CommandErr::InvalidMedia)?;

        let response = self
            .client()
            .await?
            .media()
            .upload(&mime, bytes, None)
            .await
            .map_err(|error| self.failed("upload_media", error))?;

        Ok(response.content_uri.to_string())
    }

    /// Returns once queued, not once uploaded. Progress and failure arrive as
    /// `send_state` on the local echo.
    ///
    /// # Errors
    ///
    /// Returns an error when an attachment field is invalid, the room is
    /// unavailable, or queuing the upload fails.
    #[allow(clippy::too_many_arguments)] // the platform ports call this positionally
    pub async fn send_attachment(
        &self,
        room_id: String,
        filename: String,
        mime: String,
        bytes: Vec<u8>,
        caption: Option<String>,
        in_reply_to: Option<String>,
        info: Option<AttachmentInfoView>,
        thread_root: Option<String>,
        formatted_caption: Option<String>,
        mentions: Vec<String>,
        mentions_room: bool,
        persona: Option<PerMessageProfileView>,
    ) -> Result<(), CommandErr> {
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(CommandErr::InvalidMedia);
        }
        let room_id = OwnedRoomId::try_from(room_id).map_err(|_| CommandErr::UnknownRoom)?;
        let mime: Mime = mime.parse().map_err(|_| CommandErr::InvalidMedia)?;

        let in_reply_to = match in_reply_to {
            Some(id) => Some(OwnedEventId::try_from(id).map_err(|_| CommandErr::UnknownRoom)?),
            None => None,
        };
        let thread_root = match thread_root {
            Some(id) => Some(OwnedEventId::try_from(id).map_err(|_| CommandErr::UnknownRoom)?),
            None => None,
        };
        let mentions = mentions
            .into_iter()
            .map(|id| OwnedUserId::try_from(id).map_err(|_| CommandErr::InvalidMedia))
            .collect::<Result<Vec<_>, _>>()?;

        let config = AttachmentConfig {
            caption: attachment_caption(caption, formatted_caption),
            mentions: outgoing_mentions(mentions, mentions_room),
            in_reply_to,
            info: Some(attachment_info(
                &mime,
                &info.unwrap_or_default(),
                bytes.len(),
            )),
            extra_content: persona.as_ref().map(attachment_profile),
            ..AttachmentConfig::default()
        };

        self.timeline_for(&room_id, thread_root.as_ref())
            .await?
            .send_attachment(AttachmentSource::Data { bytes, filename }, mime, config)
            // Inline, a dropped connection loses the file. Queued, it retries.
            .use_send_queue()
            .await
            .map_err(|error| self.failed("send_attachment", error))?;

        Ok(())
    }
}

fn attachment_profile(
    profile: &PerMessageProfileView,
) -> serde_json::Map<String, serde_json::Value> {
    profile_extra_content(profile)
}

fn attachment_caption(
    caption: Option<String>,
    formatted_caption: Option<String>,
) -> Option<TextMessageEventContent> {
    caption.map(|body| match formatted_caption {
        Some(html) => TextMessageEventContent::html(body, html),
        None => TextMessageEventContent::plain(body),
    })
}

fn attachment_info(mime: &Mime, view: &AttachmentInfoView, size: usize) -> AttachmentInfo {
    let size = UInt::try_from(size).ok();
    let width = view.width.map(UInt::from);
    let height = view.height.map(UInt::from);
    let duration = view.duration_ms.map(|ms| Duration::from_millis(ms.into()));
    let blurhash = view.blurhash.clone();

    match mime.type_() {
        mime::IMAGE => AttachmentInfo::Image(BaseImageInfo {
            width,
            height,
            size,
            blurhash,
            is_animated: view.animated,
        }),
        mime::VIDEO => AttachmentInfo::Video(BaseVideoInfo {
            duration,
            width,
            height,
            size,
            blurhash,
        }),
        mime::AUDIO => {
            let audio = BaseAudioInfo {
                duration,
                size,
                waveform: view.waveform.clone(),
            };
            if view.voice {
                AttachmentInfo::Voice(audio)
            } else {
                AttachmentInfo::Audio(audio)
            }
        }
        _ => AttachmentInfo::File(BaseFileInfo { size }),
    }
}

fn answered_by_server(error: &matrix_sdk::Error) -> bool {
    matches!(error, matrix_sdk::Error::Http(http) if http.as_ruma_api_error().is_some())
}

fn media_label(source: &MediaSource) -> String {
    match source {
        MediaSource::Plain(uri) => uri.to_string(),
        MediaSource::Encrypted(file) => file.url.to_string(),
    }
}

pub(crate) fn mxc_uri(url: &str) -> Result<OwnedMxcUri, CommandErr> {
    let uri = OwnedMxcUri::from(url);
    if uri.parts().is_err() {
        return Err(CommandErr::InvalidMedia);
    }
    Ok(uri)
}

#[cfg(test)]
mod tests {
    use super::{
        AttachmentConfig, AttachmentInfo, AttachmentInfoView, Mime, OwnedUserId,
        PerMessageProfileView, attachment_caption, attachment_info, attachment_profile,
        outgoing_mentions,
    };

    fn view(
        width: Option<u32>,
        height: Option<u32>,
        duration_ms: Option<u32>,
    ) -> AttachmentInfoView {
        AttachmentInfoView {
            width,
            height,
            duration_ms,
            animated: None,
            blurhash: None,
            waveform: None,
            voice: false,
        }
    }

    fn mime(value: &str) -> Mime {
        value.parse().expect("a test mime type")
    }

    #[test]
    fn an_image_carries_its_dimensions_and_byte_count() {
        let info = attachment_info(&mime("image/png"), &view(Some(800), Some(600), None), 4096);

        let AttachmentInfo::Image(image) = info else {
            panic!("an image mime type must produce image info: {info:?}");
        };
        assert_eq!(image.width.map(u64::from), Some(800));
        assert_eq!(image.height.map(u64::from), Some(600));
        assert_eq!(image.size.map(u64::from), Some(4096));
    }

    #[test]
    fn a_gif_is_marked_animated() {
        let animated = AttachmentInfoView {
            animated: Some(true),
            ..view(Some(1), Some(1), None)
        };

        let AttachmentInfo::Image(image) = attachment_info(&mime("image/gif"), &animated, 1) else {
            panic!("wrong variant");
        };
        assert_eq!(image.is_animated, Some(true));
    }

    #[test]
    fn a_video_duration_crosses_as_milliseconds() {
        let info = attachment_info(
            &mime("video/mp4"),
            &view(Some(1920), Some(1080), Some(3500)),
            9,
        );

        let AttachmentInfo::Video(video) = info else {
            panic!("wrong variant");
        };
        assert_eq!(video.duration.map(|d| d.as_millis()), Some(3500));
        assert_eq!(video.width.map(u64::from), Some(1920));
    }

    #[test]
    fn audio_keeps_the_duration_and_drops_dimensions_it_has_no_field_for() {
        let info = attachment_info(&mime("audio/ogg"), &view(None, None, Some(12_000)), 64);

        let AttachmentInfo::Audio(audio) = info else {
            panic!("wrong variant");
        };
        assert_eq!(audio.duration.map(|d| d.as_millis()), Some(12_000));
        assert_eq!(audio.size.map(u64::from), Some(64));
    }

    #[test]
    fn anything_else_reports_only_its_size() {
        let info = attachment_info(&mime("application/pdf"), &view(Some(9), Some(9), None), 128);

        let AttachmentInfo::File(file) = info else {
            panic!("wrong variant");
        };
        assert_eq!(file.size.map(u64::from), Some(128));
    }

    #[test]
    fn an_unmeasurable_attachment_still_reports_its_size() {
        let info = attachment_info(&mime("image/png"), &AttachmentInfoView::default(), 512);

        let AttachmentInfo::Image(image) = info else {
            panic!("wrong variant");
        };
        assert_eq!(image.width, None);
        assert_eq!(image.size.map(u64::from), Some(512));
    }

    #[test]
    fn attachment_caption_preserves_html_and_mentions() {
        let config = AttachmentConfig {
            caption: attachment_caption(
                Some("Hello @Ada :wave:".to_owned()),
                Some("Hello <a href=\"https://matrix.to/#/@ada:example.org\">@Ada</a> <img data-mx-emoticon />".to_owned()),
            ),
            mentions: outgoing_mentions(
                vec![OwnedUserId::try_from("@ada:example.org").expect("a user ID")],
                true,
            ),
            ..AttachmentConfig::default()
        };

        let content = serde_json::to_value(config.caption.as_ref().expect("a formatted caption"))
            .expect("caption serializes");
        assert_eq!(content["body"], "Hello @Ada :wave:");
        assert_eq!(
            content["formatted_body"],
            "Hello <a href=\"https://matrix.to/#/@ada:example.org\">@Ada</a> <img data-mx-emoticon />"
        );

        let mentions = config.mentions.as_ref().expect("mentions are retained");
        assert!(mentions.room);
        assert!(
            mentions
                .user_ids
                .contains(&OwnedUserId::try_from("@ada:example.org").expect("a user ID"))
        );
    }

    #[test]
    fn attachment_caption_is_plain_without_html_and_absent_without_a_body() {
        let plain =
            attachment_caption(Some("A caption".to_owned()), None).expect("a plain caption");
        let content = serde_json::to_value(plain).expect("caption serializes");
        assert_eq!(content["body"], "A caption");
        assert!(content.get("formatted_body").is_none());
        assert!(attachment_caption(None, Some("<b>orphaned HTML</b>".to_owned())).is_none());
    }

    #[test]
    fn attachment_profile_adds_the_persona_without_a_body_fallback() {
        let profile = PerMessageProfileView {
            id: Some("hatchy".to_owned()),
            display_name: Some("Hatchy".to_owned()),
            avatar_url: None,
            pronouns: Vec::new(),
            color_on_light: None,
            color_on_dark: None,
            has_fallback: true,
        };
        let profile = attachment_profile(&profile);

        assert_eq!(profile["com.beeper.per_message_profile"]["id"], "hatchy");
        assert!(profile.get("body").is_none());
    }
}
