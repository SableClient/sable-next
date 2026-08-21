use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::{
    OwnedEventId, OwnedMxcUri, OwnedRoomId, events::room::message::TextMessageEventContent,
};
use matrix_sdk_ui::timeline::{AttachmentConfig, AttachmentSource};
use mime::Mime;

use crate::protocol::CommandErr;

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

        match client.media().get_media_content(&request, true).await {
            Ok(bytes) => Ok(bytes),
            // Some servers cannot thumbnail SVGs or older media. The original is
            // still useful, and is the only safe fallback for an unknown thumbnail.
            Err(_) if width != 0 && height != 0 => client
                .media()
                .get_media_content(
                    &MediaRequestParameters {
                        source,
                        format: MediaFormat::File,
                    },
                    true,
                )
                .await
                .map_err(|_| CommandErr::Unavailable),
            Err(_) => Err(CommandErr::Unavailable),
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
    pub async fn send_attachment(
        &self,
        room_id: String,
        filename: String,
        mime: String,
        bytes: Vec<u8>,
        caption: Option<String>,
        in_reply_to: Option<String>,
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

        let config = AttachmentConfig {
            caption: caption.map(TextMessageEventContent::plain),
            in_reply_to,
            ..AttachmentConfig::default()
        };

        self.timeline(&room_id)
            .await?
            .send_attachment(AttachmentSource::Data { bytes, filename }, mime, config)
            // Inline, a dropped connection loses the file. Queued, it retries.
            .use_send_queue()
            .await
            .map_err(|error| self.failed("send_attachment", error))?;

        Ok(())
    }
}

pub(crate) fn mxc_uri(url: &str) -> Result<OwnedMxcUri, CommandErr> {
    let uri = OwnedMxcUri::from(url);
    if uri.parts().is_err() {
        return Err(CommandErr::InvalidMedia);
    }
    Ok(uri)
}
