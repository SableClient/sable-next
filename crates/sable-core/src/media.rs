use crate::now_ms;
use backon::Retryable;
use std::io::Read;
use std::time::Duration;

use futures_util::StreamExt;

use matrix_sdk::HttpError;
use matrix_sdk::attachment::{
    AttachmentConfig, AttachmentInfo, BaseAudioInfo, BaseFileInfo, BaseImageInfo, BaseVideoInfo,
    GalleryConfig, GalleryItemInfo, Thumbnail,
};
use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
use matrix_sdk::ruma::api::Metadata;
use matrix_sdk::ruma::api::client::authenticated_media;
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::{
    OwnedMxcUri, OwnedServerName, ServerName, UInt, events::room::message::TextMessageEventContent,
};
use matrix_sdk_base::media::store::IgnoreMediaRetentionPolicy;
use mime::Mime;

use crate::ResultExt;
use crate::media_health::Admission;
use crate::messages::outgoing_mentions;
use crate::outgoing::thread_reply;
use crate::personas::profile_extra_content;
use crate::protocol::{
    AttachmentInfoView, AudioMetadataView, CoreEvent, PerMessageProfileView, RpcCode, RpcError,
    SendAttachmentRequest, SendGalleryRequest,
};
use crate::view::SPOILER_PROPERTY;

use crate::{Core, MatrixClient};

const MAX_INITIAL_DOWNLOAD_CAPACITY: usize = 100 * 1024 * 1024;
const MAX_CACHED_PREVIEW_ORIGINAL_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_MEDIA_DOWNLOADS: usize = 12;
const MEDIA_DOWNLOAD_TIMEOUT: Duration = Duration::from_hours(1);
/// A remote homeserver may need this long to fetch the file from its origin first.
const MEDIA_FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(60);
const MEDIA_STALL_TIMEOUT: Duration = Duration::from_secs(30);
const MEDIA_THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(30);
const MEDIA_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(500), Duration::from_millis(1500)];
const UNSIZED_PROGRESS_STEP: u64 = 256 * 1024;

fn attachment_data(bytes: &mut &[u8]) -> Result<(Vec<u8>, Option<Thumbnail>), RpcError> {
    use std::io::Read;

    let mut size = [0; 8];
    let mut thumbnail_size = [0; 8];
    let mut width = [0; 4];
    let mut height = [0; 4];
    bytes
        .read_exact(&mut size)
        .map_err(|_| RpcCode::InvalidMedia)?;
    bytes
        .read_exact(&mut thumbnail_size)
        .map_err(|_| RpcCode::InvalidMedia)?;
    bytes
        .read_exact(&mut width)
        .map_err(|_| RpcCode::InvalidMedia)?;
    bytes
        .read_exact(&mut height)
        .map_err(|_| RpcCode::InvalidMedia)?;
    let size = usize::try_from(u64::from_le_bytes(size)).map_err(|_| RpcCode::InvalidMedia)?;
    let thumbnail_size = u64::from_le_bytes(thumbnail_size);
    let width = u32::from_le_bytes(width);
    let height = u32::from_le_bytes(height);
    let data = bytes
        .split_off(..size)
        .ok_or(RpcCode::InvalidMedia)?
        .to_vec();
    let thumbnail = if thumbnail_size == 0 {
        None
    } else {
        Some(Thumbnail {
            size: UInt::try_from(thumbnail_size).map_err(|_| RpcCode::InvalidMedia)?,
            data: bytes
                .split_off(..usize::try_from(thumbnail_size).map_err(|_| RpcCode::InvalidMedia)?)
                .ok_or(RpcCode::InvalidMedia)?
                .to_vec(),
            content_type: mime::IMAGE_JPEG,
            width: width.into(),
            height: height.into(),
        })
    };
    Ok((data, thumbnail))
}

impl Core {
    pub(crate) async fn max_upload_size(&self) -> Result<u64, RpcError> {
        self.client()
            .await?
            .load_or_fetch_max_upload_size()
            .await
            .map(u64::from)
            .or_failed(self, "media_config")
    }

    /// Downloads a persona avatar over native HTTP and uploads it to Matrix.
    ///
    /// # Errors
    ///
    /// Returns an error if the download or Matrix upload fails.
    #[cfg(not(target_family = "wasm"))]
    pub async fn import_persona_avatar(&self, url: String) -> Result<String, RpcError> {
        self.client().await?;
        let (mime, bytes) = download_persona_avatar(&url).await?;
        self.upload_media(mime, bytes).await
    }

    /// # Errors
    ///
    /// Returns an error for invalid media, missing sessions, or failed downloads.
    pub async fn fetch_media(
        &self,
        source: String,
        width: u32,
        height: u32,
        background: bool,
    ) -> Result<Vec<u8>, RpcError> {
        #[cfg(not(target_family = "wasm"))]
        if let Some(bytes) = crate::link_previews::scraped_media(&source).await {
            return bytes;
        }
        self.fetch_matrix_media(source, width, height, background)
            .await
    }

    async fn fetch_matrix_media(
        &self,
        source: String,
        width: u32,
        height: u32,
        background: bool,
    ) -> Result<Vec<u8>, RpcError> {
        let key = source;
        let source: MediaSource = serde_json::from_str(&key)
            .unwrap_or_else(|_| MediaSource::Plain(OwnedMxcUri::from(key.clone())));
        if let MediaSource::Plain(uri) = &source
            && uri.parts().is_err()
        {
            return Err(RpcCode::InvalidMedia.into());
        }

        let client = self.client().await?;
        if let Some(bytes) = cached_media(&client, &source, width, height).await {
            return Ok(bytes);
        }
        let _download = if background {
            None
        } else {
            let permit = match self.media_downloads.try_acquire() {
                Ok(permit) => permit,
                Err(tokio::sync::TryAcquireError::NoPermits) => {
                    let permit = self
                        .media_downloads
                        .acquire()
                        .await
                        .map_err(|_| RpcCode::Unavailable)?;
                    if let Some(bytes) = cached_media(&client, &source, width, height).await {
                        return Ok(bytes);
                    }
                    permit
                }
                Err(tokio::sync::TryAcquireError::Closed) => {
                    return Err(RpcCode::Unavailable.into());
                }
            };
            Some(permit)
        };
        let media = media_label(&source);
        let origin = media_origin(&source).filter(|(server, _)| {
            client
                .user_id()
                .is_none_or(|user| user.server_name() != server)
        });
        let mut probe = None;
        if let Some((server, media_id)) = &origin {
            let now = now_ms();
            let admission = self.media_health.lock().admit(server, media_id, now);
            match admission {
                Admission::Refused { retry_after_ms } => {
                    tracing::warn!(
                        %media,
                        retry_after_ms,
                        "media refused by the breaker without a request"
                    );
                    return Err(RpcCode::MediaServerUnavailable { retry_after_ms }.into());
                }
                Admission::Probe => {
                    probe = Some(ProbeGuard {
                        core: self,
                        server,
                        armed: true,
                    });
                }
                Admission::Allowed => {}
            }
        }

        let result = self
            .media_bytes(&client, &key, source, width, height, &media)
            .await;
        if let Err(error) = &result {
            tracing::warn!(
                %media,
                status = ?status_of(error).or_else(|| error.as_client_api_error().map(|e| e.status_code)),
                home_server = origin.is_none(),
                not_found = is_not_found(error),
                blames_server = blames_media_server(error),
                "media fetch failed: {error}"
            );
        }
        if let Some((server, media_id)) = &origin {
            let mut health = self.media_health.lock();
            match &result {
                Ok(_) => health.succeeded(server, media_id),
                Err(error) if is_not_found(error) => {
                    health.missing(server, media_id, now_ms());
                }
                Err(error) if blames_media_server(error) => {
                    health.failed(server, media_id, now_ms());
                }
                Err(_) => health.abandoned(server),
            }
        }
        if let Some(probe) = probe.as_mut() {
            probe.armed = false;
        }
        result.map_err(|error| media_code(&error).into())
    }

    async fn media_bytes(
        &self,
        client: &MatrixClient,
        key: &str,
        source: MediaSource,
        width: u32,
        height: u32,
        media: &str,
    ) -> matrix_sdk::Result<Vec<u8>> {
        if width == 0 || height == 0 || matches!(source, MediaSource::Encrypted(_)) {
            return self
                .original_media(client, key, source, false)
                .await
                .inspect_err(|error| tracing::warn!(%media, "media unavailable: {error}"));
        }

        let request = MediaRequestParameters {
            source: source.clone(),
            format: MediaFormat::Thumbnail(MediaThumbnailSettings::new(
                width.into(),
                height.into(),
            )),
        };

        let thumbnail = with_retries(|| async {
            media_timeout(MEDIA_THUMBNAIL_TIMEOUT, fetch_sdk_media(client, &request))
                .await
                .and_then(|result| result)
        })
        .await;
        match thumbnail {
            Ok(bytes) => Ok(bytes),
            Err(error) if answered_by_server(&error) || maybe_hidden_by_browser(&error) => {
                tracing::warn!(%media, "thumbnail refused, falling back to the original: {error}");
                self.original_media(client, key, source, true)
                    .await
                    .inspect_err(|error| {
                        tracing::warn!(%media, "the original is unavailable too: {error}");
                    })
            }
            Err(error) => {
                tracing::warn!(%media, width, height, "media unavailable: {error}");
                Err(error)
            }
        }
    }

    /// Drops every stored copy of a source, so the next fetch asks the homeserver.
    ///
    /// # Errors
    ///
    /// Returns an error when the media URI is invalid, the user is logged out,
    /// or the media store cannot be written.
    pub async fn forget_media(&self, source: String) -> Result<(), RpcError> {
        let source: MediaSource = serde_json::from_str(&source)
            .unwrap_or_else(|_| MediaSource::Plain(OwnedMxcUri::from(source)));
        let uri = match source {
            MediaSource::Plain(uri) => uri,
            MediaSource::Encrypted(file) => file.url,
        };
        if uri.parts().is_err() {
            return Err(RpcCode::InvalidMedia.into());
        }
        let client = self.client().await?;
        client
            .media()
            .remove_media_content_for_uri(&uri)
            .await
            .or_failed(self, "forget_media")
    }

    async fn original_media(
        &self,
        client: &MatrixClient,
        key: &str,
        source: MediaSource,
        read_cache: bool,
    ) -> matrix_sdk::Result<Vec<u8>> {
        let request = MediaRequestParameters {
            source,
            format: MediaFormat::File,
        };
        if read_cache
            && let Some(content) = client
                .media_store()
                .lock()
                .await?
                .get_media_content(&request)
                .await?
            && !content.is_empty()
        {
            return Ok(content);
        }

        let uri = match &request.source {
            MediaSource::Plain(uri) => uri,
            MediaSource::Encrypted(file) => &file.url,
        };
        let authenticated = authenticated_media::get_content::v1::Request::PATH_BUILDER
            .is_supported(&client.supported_versions().await?);
        let (Some(token), Ok((server, media_id)), true) =
            (client.access_token(), uri.parts(), authenticated)
        else {
            return fetch_sdk_media(client, &request).await;
        };
        let Some(url) = download_url(client, &AUTHENTICATED_DOWNLOAD, server, media_id) else {
            return fetch_sdk_media(client, &request).await;
        };

        let downloaded = with_retries(|| self.download(client, key, &url, Some(&token))).await;
        let content = match downloaded {
            Ok(content) => content,
            Err(error) if status_of(&error) == Some(reqwest::StatusCode::UNAUTHORIZED) => {
                return fetch_sdk_media(client, &request).await;
            }
            Err(error)
                if status_of(&error)
                    .is_some_and(|status| status != reqwest::StatusCode::TOO_MANY_REQUESTS) =>
            {
                tracing::warn!(
                    media = %media_label(&request.source),
                    "authenticated download refused, trying the legacy endpoint: {error}"
                );
                let Some(url) = download_url(client, &LEGACY_DOWNLOAD, server, media_id) else {
                    return Err(error);
                };
                self.download(client, key, &url, None)
                    .await
                    .map_err(|_| error)?
            }
            Err(error) => return Err(error),
        };

        let content = match &request.source {
            MediaSource::Encrypted(file) => {
                let mut decrypted = Vec::with_capacity(content.len());
                let mut cursor = std::io::Cursor::new(content);
                let mut reader = matrix_sdk_base::crypto::AttachmentDecryptor::new(
                    &mut cursor,
                    file.as_ref().clone().into(),
                )?;
                reader.read_to_end(&mut decrypted)?;
                decrypted
            }
            MediaSource::Plain(_) => content,
        };
        store_media(client, &request, &content).await?;
        Ok(content)
    }

    async fn download(
        &self,
        client: &MatrixClient,
        key: &str,
        url: &url::Url,
        token: Option<&str>,
    ) -> matrix_sdk::Result<Vec<u8>> {
        let mut request = client
            .http_client()
            .get(url.clone())
            .timeout(MEDIA_DOWNLOAD_TIMEOUT);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = media_timeout(MEDIA_FIRST_BYTE_TIMEOUT, request.send())
            .await??
            .error_for_status()?;
        let total = response.content_length().unwrap_or(0);
        let mut content = Vec::with_capacity(
            usize::try_from(total)
                .unwrap_or(0)
                .min(MAX_INITIAL_DOWNLOAD_CAPACITY),
        );
        let mut chunks = response.bytes_stream();
        let mut reported = 0;
        while let Some(chunk) = media_timeout(MEDIA_STALL_TIMEOUT, chunks.next()).await? {
            content.extend_from_slice(&chunk?);
            let current = u64::try_from(content.len()).unwrap_or(u64::MAX);
            let step = current
                .saturating_mul(100)
                .checked_div(total)
                .unwrap_or(current / UNSIZED_PROGRESS_STEP);
            if step > reported {
                reported = step;
                self.emit(CoreEvent::MediaProgress {
                    source: key.to_owned(),
                    current,
                    total,
                });
            }
        }
        Ok(content)
    }

    /// For avatar commands; `send_attachment` keeps its upload in the event's queue entry.
    ///
    /// # Errors
    ///
    /// Returns an error when the MIME type is invalid, the user is logged out,
    /// or the upload fails.
    pub async fn upload_media(&self, mime: String, bytes: Vec<u8>) -> Result<String, RpcError> {
        let mime: Mime = mime.parse().map_err(|_| RpcCode::InvalidMedia)?;

        let response = self
            .client()
            .await?
            .media()
            .upload(&mime, bytes, None)
            .await
            .or_failed(self, "upload_media")?;

        Ok(response.content_uri.to_string())
    }

    /// Returns once queued. Progress and failure arrive as
    /// `send_state` on the local echo.
    ///
    /// # Errors
    ///
    /// Returns an error when an attachment field is invalid, the room is
    /// unavailable, or queuing the upload fails.
    pub async fn send_attachment(
        &self,
        request: SendAttachmentRequest,
        payload: Vec<u8>,
    ) -> Result<(), RpcError> {
        let mut body = payload.as_slice();
        let (bytes, thumbnail) = attachment_data(&mut body)?;
        if !body.is_empty() {
            return Err(RpcCode::InvalidMedia.into());
        }
        drop(payload);
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > self.max_upload_size().await? {
            return Err(RpcCode::InvalidMedia.into());
        }
        let mime: Mime = request.mime.parse().map_err(|_| RpcCode::InvalidMedia)?;
        let reply = thread_reply(
            request.outgoing.in_reply_to.clone(),
            request.outgoing.thread_root.clone(),
            request.outgoing.silent_reply,
        );

        let (caption, formatted_caption, persona) = match request.outgoing.persona {
            Some(persona) => match request.caption {
                Some(text) => {
                    let (text, formatted, persona) = crate::personas::outgoing_with_fallback(
                        text,
                        request.formatted_caption,
                        &persona,
                    );
                    (Some(text), formatted, Some(persona))
                }
                None => (
                    None,
                    request.formatted_caption,
                    Some(crate::personas::without_fallback(&persona)),
                ),
            },
            None => (request.caption, request.formatted_caption, None),
        };

        let info = request.info.unwrap_or_default();
        let audio_metadata = info
            .audio_metadata
            .clone()
            .filter(|_| mime.type_() == mime::AUDIO);

        let config = AttachmentConfig {
            caption: attachment_caption(caption, formatted_caption),
            mentions: Some(outgoing_mentions(
                request.outgoing.mentions,
                request.outgoing.mentions_room,
            )),
            reply,
            info: Some(attachment_info(&mime, &info, bytes.len())),
            thumbnail,
            extra_content: attachment_extra_content(
                persona.as_ref(),
                request.spoiler,
                audio_metadata.as_ref(),
            ),
            ..AttachmentConfig::default()
        };

        let room = self.room(&request.room_id).await?;
        Box::pin(
            room.send_queue()
                .send_attachment(request.filename, mime, bytes, config),
        )
        .await
        .or_failed(self, "send_attachment")?;

        Ok(())
    }

    /// # Errors
    ///
    /// Returns an error when an attachment is invalid, the room is unavailable,
    /// or queuing the gallery fails.
    pub async fn send_gallery(
        &self,
        request: SendGalleryRequest,
        bytes: Vec<u8>,
    ) -> Result<(), RpcError> {
        if request.attachments.len() < 2 {
            return Err(RpcCode::InvalidMedia.into());
        }
        let max_upload_size = self.max_upload_size().await?;
        let mut body = bytes.as_slice();
        let attachments = request
            .attachments
            .into_iter()
            .map(|item| {
                let (bytes, thumbnail) = attachment_data(&mut body)?;
                if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > max_upload_size {
                    return Err(RpcCode::InvalidMedia.into());
                }
                Ok((item, bytes, thumbnail))
            })
            .collect::<Result<Vec<_>, RpcError>>()?;
        if !body.is_empty() {
            return Err(RpcCode::InvalidMedia.into());
        }
        drop(bytes);
        let extra = request
            .outgoing
            .persona
            .as_ref()
            .map(|profile| attachment_profile(&crate::personas::without_fallback(profile)));
        let mut gallery = GalleryConfig::new()
            .extra_content(extra)
            .caption(attachment_caption(
                request.caption,
                request.formatted_caption,
            ))
            .mentions(Some(outgoing_mentions(
                request.outgoing.mentions,
                request.outgoing.mentions_room,
            )))
            .reply(thread_reply(
                request.outgoing.in_reply_to,
                request.outgoing.thread_root,
                request.outgoing.silent_reply,
            ));
        for (item, bytes, thumbnail) in attachments {
            let mime: Mime = item.mime.parse().map_err(|_| RpcCode::InvalidMedia)?;
            let info = attachment_info(&mime, &item.info.unwrap_or_default(), bytes.len());
            gallery = gallery.add_item(GalleryItemInfo {
                filename: item.filename,
                content_type: mime,
                data: bytes,
                attachment_info: info,
                caption: None,
                thumbnail,
                extra_content: attachment_extra_content(None, item.spoiler, None),
            });
        }

        self.room(&request.room_id)
            .await?
            .send_queue()
            .send_gallery(gallery)
            .await
            .or_failed(self, "send_gallery")?;
        Ok(())
    }
}

#[cfg(not(target_family = "wasm"))]
async fn download_persona_avatar(url: &str) -> Result<(String, Vec<u8>), RpcError> {
    const MAX_AVATAR_BYTES: usize = 20 * 1024 * 1024;
    let url = url::Url::parse(url).map_err(|_| RpcCode::InvalidMedia)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(RpcCode::InvalidMedia.into());
    }
    // Do not send Matrix credentials to avatar hosts.
    let http = crate::tls::apply(matrix_sdk::reqwest::Client::builder())
        .timeout(Duration::from_secs(30))
        .redirect(matrix_sdk::reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| {
            crate::errors::coded("persona_avatar_client", RpcCode::Unavailable, &error)
        })?;
    let mut response = http
        .get(url)
        .send()
        .await
        .and_then(matrix_sdk::reqwest::Response::error_for_status)
        .map_err(|error| {
            tracing::warn!("persona avatar download failed: {}", error.without_url());
            RpcCode::Unavailable
        })?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_AVATAR_BYTES as u64)
    {
        return Err(RpcCode::InvalidMedia.into());
    }
    let mime = response
        .headers()
        .get(matrix_sdk::reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/*")
        .to_owned();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        crate::errors::coded("persona_avatar_body", RpcCode::Unavailable, &error)
    })? {
        if chunk.len() > MAX_AVATAR_BYTES - bytes.len() {
            return Err(RpcCode::InvalidMedia.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(RpcCode::InvalidMedia.into());
    }
    Ok((mime, bytes))
}

fn attachment_profile(
    profile: &PerMessageProfileView,
) -> serde_json::Map<String, serde_json::Value> {
    profile_extra_content(profile)
}

#[derive(serde::Serialize)]
struct AudioInfoOut {
    #[serde(rename = "org.matrix.msc4549.audio_metadata")]
    audio_metadata: AudioMetadataOut,
}

#[derive(serde::Serialize)]
struct AudioMetadataOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cover_art_blurhash: Option<String>,
}

fn audio_metadata_content(
    metadata: &AudioMetadataView,
) -> serde_json::Map<String, serde_json::Value> {
    let info = AudioInfoOut {
        audio_metadata: AudioMetadataOut {
            title: metadata.title.clone(),
            artist: metadata.artist.clone(),
            album: metadata.album.clone(),
            cover_art_blurhash: metadata.cover_art_blurhash.clone(),
        },
    };
    serde_json::Map::from_iter([(
        "info".to_owned(),
        serde_json::to_value(info).unwrap_or_default(),
    )])
}

fn attachment_extra_content(
    persona: Option<&PerMessageProfileView>,
    spoiler: bool,
    audio: Option<&AudioMetadataView>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let mut extra = persona.map(attachment_profile).unwrap_or_default();
    if let Some(audio) = audio {
        extra.extend(audio_metadata_content(audio));
    }
    if spoiler {
        extra.insert(SPOILER_PROPERTY.to_owned(), serde_json::Value::Bool(true));
    }
    (!extra.is_empty()).then_some(extra)
}

#[cfg(all(test, not(target_family = "wasm")))]
mod avatar_import_tests {
    use super::download_persona_avatar;
    use wiremock::{Mock, MockServer, ResponseTemplate, matchers::path};

    #[tokio::test]
    async fn downloads_without_cors_headers_and_follows_redirects() {
        let server = MockServer::start().await;
        Mock::given(path("/avatar"))
            .respond_with(ResponseTemplate::new(302).insert_header("Location", "/image"))
            .mount(&server)
            .await;
        Mock::given(path("/image"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_bytes(vec![137, 80, 78, 71])
                    .insert_header("Content-Type", "image/png"),
            )
            .mount(&server)
            .await;
        let (mime, bytes) = download_persona_avatar(&format!("{}/avatar", server.uri()))
            .await
            .expect("native avatar download");
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, [137, 80, 78, 71]);
        for request in server.received_requests().await.expect("requests") {
            assert_eq!(request.headers["user-agent"], crate::USER_AGENT);
            assert!(!request.headers.contains_key("authorization"));
            assert!(!request.headers.contains_key("cookie"));
        }
    }

    #[tokio::test]
    async fn rejects_failed_empty_and_oversized_downloads() {
        let server = MockServer::start().await;
        for (route, response) in [
            ("/missing", ResponseTemplate::new(404)),
            ("/empty", ResponseTemplate::new(200)),
            (
                "/large",
                ResponseTemplate::new(200).set_body_bytes(vec![0; 20 * 1024 * 1024 + 1]),
            ),
        ] {
            Mock::given(path(route))
                .respond_with(response)
                .mount(&server)
                .await;
            download_persona_avatar(&format!("{}{route}", server.uri()))
                .await
                .unwrap_err();
        }
    }

    #[tokio::test]
    async fn rejects_non_http_and_credential_urls() {
        for url in [
            "file:///tmp/avatar",
            "data:image/png;base64,AAAA",
            "https://user:password@example.org/avatar",
        ] {
            download_persona_avatar(url).await.unwrap_err();
        }
    }
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

struct ProbeGuard<'a> {
    core: &'a Core,
    server: &'a ServerName,
    armed: bool,
}

impl Drop for ProbeGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.core.media_health.lock().abandoned(self.server);
        }
    }
}

async fn media_timeout<T>(
    limit: Duration,
    future: impl std::future::Future<Output = T>,
) -> matrix_sdk::Result<T> {
    matrix_sdk::timeout::timeout(future, limit)
        .await
        .map_err(|elapsed| matrix_sdk::Error::UnknownError(Box::new(elapsed)))
}

async fn with_retries<T, Fut>(attempt: impl FnMut() -> Fut) -> matrix_sdk::Result<T>
where
    Fut: std::future::Future<Output = matrix_sdk::Result<T>>,
{
    attempt
        .retry(MEDIA_RETRY_DELAYS.into_iter())
        .when(is_transient)
        .notify(|error, delay| {
            tracing::debug!("media request failed, retrying in {delay:?}: {error}");
        })
        .sleep(matrix_sdk::sleep::sleep)
        .await
}

pub(crate) fn is_transient_http(http: &HttpError) -> bool {
    let retryable = |status: reqwest::StatusCode| {
        status.is_server_error() || matches!(status.as_u16(), 408 | 429)
    };
    match http {
        HttpError::Reqwest(error) => error.status().is_none_or(retryable),
        HttpError::Api(_) => http
            .as_client_api_error()
            .is_some_and(|error| retryable(error.status_code)),
        _ => false,
    }
}

fn is_transient(error: &matrix_sdk::Error) -> bool {
    match error {
        matrix_sdk::Error::Http(http) => is_transient_http(http),
        matrix_sdk::Error::UnknownError(error) => error.is::<matrix_sdk::timeout::ElapsedError>(),
        _ => false,
    }
}

fn status_of(error: &matrix_sdk::Error) -> Option<reqwest::StatusCode> {
    match error {
        matrix_sdk::Error::Http(http) => match http.as_ref() {
            HttpError::Reqwest(error) => error.status(),
            _ => None,
        },
        _ => None,
    }
}

const AUTHENTICATED_DOWNLOAD: [&str; 5] = ["_matrix", "client", "v1", "media", "download"];
const LEGACY_DOWNLOAD: [&str; 4] = ["_matrix", "media", "v3", "download"];

fn download_url(
    client: &MatrixClient,
    endpoint: &[&str],
    server: &ServerName,
    media_id: &str,
) -> Option<url::Url> {
    let mut url = client.homeserver();
    url.path_segments_mut()
        .ok()?
        .pop_if_empty()
        .extend(endpoint.iter().copied().chain([server.as_str(), media_id]));
    Some(url)
}

async fn fetch_sdk_media(
    client: &MatrixClient,
    request: &MediaRequestParameters,
) -> matrix_sdk::Result<Vec<u8>> {
    let content = client.media().get_media_content(request, false).await?;
    store_media(client, request, &content).await?;
    Ok(content)
}

async fn store_media(
    client: &MatrixClient,
    request: &MediaRequestParameters,
    content: &[u8],
) -> matrix_sdk::Result<()> {
    if content.is_empty() {
        return Ok(());
    }
    let store = client.media_store().lock().await?;
    let size = u64::try_from(content.len()).unwrap_or(u64::MAX);
    if store.media_retention_policy().exceeds_max_file_size(size) {
        return Ok(());
    }
    store
        .add_media_content(request, content.to_vec(), IgnoreMediaRetentionPolicy::No)
        .await?;
    Ok(())
}

async fn cached_media(
    client: &MatrixClient,
    source: &MediaSource,
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    let thumbnail = (width > 0 && height > 0 && matches!(source, MediaSource::Plain(_)))
        .then(|| MediaFormat::Thumbnail(MediaThumbnailSettings::new(width.into(), height.into())));
    let preview = thumbnail.is_some();
    let store = client.media_store().lock().await.ok()?;
    for format in thumbnail.into_iter().chain([MediaFormat::File]) {
        let request = MediaRequestParameters {
            source: source.clone(),
            format,
        };
        if let Ok(Some(bytes)) = store.get_media_content(&request).await
            && !bytes.is_empty()
            && (!preview
                || !matches!(request.format, MediaFormat::File)
                || bytes.len() <= MAX_CACHED_PREVIEW_ORIGINAL_BYTES)
        {
            return Some(bytes);
        }
    }
    None
}

fn media_origin(source: &MediaSource) -> Option<(OwnedServerName, String)> {
    let uri = match source {
        MediaSource::Plain(uri) => uri,
        MediaSource::Encrypted(file) => &file.url,
    };
    let (server, media_id) = uri.parts().ok()?;
    Some((server.to_owned(), media_id.to_owned()))
}

/// Every missing thumbnail ends here, so the code goes out without a report.
fn media_code(error: &matrix_sdk::Error) -> RpcCode {
    if is_not_found(error) {
        RpcCode::MediaNotFound
    } else {
        RpcCode::Unavailable
    }
}

fn is_not_found(error: &matrix_sdk::Error) -> bool {
    match error {
        matrix_sdk::Error::Http(http) => match http.as_ref() {
            HttpError::Reqwest(error) => error.status() == Some(reqwest::StatusCode::NOT_FOUND),
            HttpError::Api(_) => http
                .as_client_api_error()
                .is_some_and(|error| error.status_code == reqwest::StatusCode::NOT_FOUND),
            _ => false,
        },
        _ => false,
    }
}

fn blames_media_server(error: &matrix_sdk::Error) -> bool {
    const NOT_THE_REMOTE: [u16; 3] = [401, 403, 429];
    match error {
        matrix_sdk::Error::Http(http) => match http.as_ref() {
            HttpError::Reqwest(error) => error.status().map_or_else(
                || transport_failure_blames_remote(error),
                |status| !NOT_THE_REMOTE.contains(&status.as_u16()),
            ),
            HttpError::Api(_) => http
                .as_client_api_error()
                .is_none_or(|error| !NOT_THE_REMOTE.contains(&error.status_code.as_u16())),
            _ => false,
        },
        matrix_sdk::Error::UnknownError(error) => error.is::<matrix_sdk::timeout::ElapsedError>(),
        _ => false,
    }
}

#[cfg(not(target_family = "wasm"))]
fn transport_failure_blames_remote(error: &reqwest::Error) -> bool {
    !error.is_connect()
}

#[cfg(target_family = "wasm")]
const fn transport_failure_blames_remote(_: &reqwest::Error) -> bool {
    false
}

#[cfg(target_family = "wasm")]
fn maybe_hidden_by_browser(error: &matrix_sdk::Error) -> bool {
    matches!(error, matrix_sdk::Error::Http(http)
        if matches!(http.as_ref(), HttpError::Reqwest(error) if error.status().is_none()))
}

#[cfg(not(target_family = "wasm"))]
const fn maybe_hidden_by_browser(_: &matrix_sdk::Error) -> bool {
    false
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

pub(crate) fn mxc_uri(url: &str) -> Result<OwnedMxcUri, RpcError> {
    let uri = OwnedMxcUri::from(url);
    if uri.parts().is_err() {
        return Err(RpcCode::InvalidMedia.into());
    }
    Ok(uri)
}

#[cfg(test)]
mod tests {
    use matrix_sdk::ruma::OwnedUserId;

    use super::{
        AttachmentConfig, AttachmentInfo, AttachmentInfoView, Mime, PerMessageProfileView,
        SPOILER_PROPERTY, attachment_caption, attachment_extra_content, attachment_info,
        attachment_profile, outgoing_mentions,
    };

    #[test]
    fn audio_metadata_rides_inside_info_and_reads_back() {
        let metadata = crate::protocol::AudioMetadataView {
            title: Some("Moonwalker".to_owned()),
            artist: Some("Jake Chudnow".to_owned()),
            album: None,
            cover_art_blurhash: Some("LBEpAr~VM{x[004:oyM|9GM|xtIU".to_owned()),
        };
        let extra = attachment_extra_content(None, true, Some(&metadata)).expect("extra content");

        let inner = &extra["info"]["org.matrix.msc4549.audio_metadata"];
        assert_eq!(inner["title"], "Moonwalker");
        assert_eq!(inner["cover_art_blurhash"], "LBEpAr~VM{x[004:oyM|9GM|xtIU");
        assert!(inner.get("album").is_none());
        assert_eq!(extra[SPOILER_PROPERTY], true);
        let read = crate::view::audio_metadata(Some(&serde_json::Value::Object(extra)))
            .expect("metadata reads back");
        assert_eq!(read.artist.as_deref(), Some("Jake Chudnow"));
    }

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
            audio_metadata: None,
        }
    }

    fn mime(value: &str) -> Mime {
        value.parse().expect("a test mime type")
    }

    #[test]
    fn attachment_bytes_include_a_thumbnail() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2_u64.to_le_bytes());
        bytes.extend_from_slice(&3_u64.to_le_bytes());
        bytes.extend_from_slice(&800_u32.to_le_bytes());
        bytes.extend_from_slice(&450_u32.to_le_bytes());
        bytes.extend_from_slice(&[1, 2, 255, 216, 255]);
        bytes.extend_from_slice(&[9]);
        let mut body = bytes.as_slice();
        let (data, thumbnail) = super::attachment_data(&mut body).unwrap();
        let thumbnail = thumbnail.unwrap();
        assert_eq!(data, [1, 2]);
        assert_eq!(thumbnail.data, [255, 216, 255]);
        assert_eq!(thumbnail.content_type, mime::IMAGE_JPEG);
        assert_eq!(u64::from(thumbnail.size), 3);
        assert_eq!(u64::from(thumbnail.width), 800);
        assert_eq!(u64::from(thumbnail.height), 450);
        assert_eq!(body, [9]);
        for length in 0..bytes.len() - 1 {
            super::attachment_data(&mut &bytes[..length])
                .expect_err("a truncated attachment is rejected");
        }
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
            mentions: Some(outgoing_mentions(
                vec![OwnedUserId::try_from("@ada:example.org").expect("a user ID")],
                true,
            )),
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
    fn a_spoiler_rides_the_extra_content_beside_the_persona() {
        assert!(attachment_extra_content(None, false, None).is_none());

        let spoiler = attachment_extra_content(None, true, None).expect("a spoiler property");
        assert_eq!(spoiler[SPOILER_PROPERTY], true);

        let profile = PerMessageProfileView {
            id: Some("hatchy".to_owned()),
            display_name: Some("Hatchy".to_owned()),
            avatar_url: None,
            pronouns: Vec::new(),
            color_on_light: None,
            color_on_dark: None,
            has_fallback: true,
            biography: None,
            banner_url: None,
            is_animal: None,
            has_animal: None,
            animal_need: None,
        };
        let both = attachment_extra_content(Some(&profile), true, None).expect("both properties");
        assert_eq!(both["com.beeper.per_message_profile"]["id"], "hatchy");
        assert_eq!(both[SPOILER_PROPERTY], true);
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
            biography: None,
            banner_url: None,
            is_animal: None,
            has_animal: None,
            animal_need: None,
        };
        let profile = attachment_profile(&profile);

        assert_eq!(profile["com.beeper.per_message_profile"]["id"], "hatchy");
        assert!(profile.get("body").is_none());
    }

    #[cfg(not(target_family = "wasm"))]
    #[tokio::test]
    async fn an_empty_body_is_never_served_from_the_store() {
        use matrix_sdk::media::{MediaFormat, MediaRequestParameters};
        use matrix_sdk::ruma::{events::room::MediaSource, owned_mxc_uri};

        let server = matrix_sdk::test_utils::mocks::MatrixMockServer::new().await;
        let client = server.client_builder().build().await;
        let source = MediaSource::Plain(owned_mxc_uri!("mxc://example.org/empty"));
        let request = MediaRequestParameters {
            source: source.clone(),
            format: MediaFormat::File,
        };

        super::store_media(&client, &request, &[])
            .await
            .expect("store");
        let store = client.media_store().lock().await.expect("media store");
        assert_eq!(store.get_media_content(&request).await.expect("read"), None);

        store
            .add_media_content(&request, Vec::new(), super::IgnoreMediaRetentionPolicy::No)
            .await
            .expect("stored empty body");
        drop(store);
        assert_eq!(super::cached_media(&client, &source, 0, 0).await, None);

        super::store_media(&client, &request, &[1])
            .await
            .expect("store");
        assert_eq!(
            super::cached_media(&client, &source, 0, 0).await,
            Some(vec![1])
        );
    }
}
