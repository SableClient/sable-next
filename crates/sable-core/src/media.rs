use std::io::Read;
use std::time::Duration;

use futures_util::StreamExt;

use matrix_sdk::HttpError;
use matrix_sdk::attachment::{
    AttachmentConfig, AttachmentInfo, BaseAudioInfo, BaseFileInfo, BaseImageInfo, BaseVideoInfo,
    GalleryConfig, GalleryItemInfo,
};
use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
use matrix_sdk::ruma::api::Metadata;
use matrix_sdk::ruma::api::client::authenticated_media;
use matrix_sdk::ruma::events::room::MediaSource;
use matrix_sdk::ruma::{
    MilliSecondsSinceUnixEpoch, OwnedMxcUri, OwnedServerName, ServerName, UInt,
    events::room::message::TextMessageEventContent,
};
use matrix_sdk_base::media::store::IgnoreMediaRetentionPolicy;
use mime::Mime;

use crate::ResultExt;
use crate::media_health::Admission;
use crate::messages::outgoing_mentions;
use crate::outgoing::thread_reply;
use crate::personas::profile_extra_content;
use crate::protocol::{
    AttachmentInfoView, AudioMetadataView, CommandErr, CoreEvent, PerMessageProfileView,
    SendAttachmentRequest, SendGalleryRequest,
};
use crate::view::SPOILER_PROPERTY;

use crate::{Core, MatrixClient};

const MAX_INITIAL_DOWNLOAD_CAPACITY: usize = 100 * 1024 * 1024;
const MAX_CACHED_PREVIEW_ORIGINAL_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_MEDIA_DOWNLOADS: usize = 6;
const MEDIA_DOWNLOAD_TIMEOUT: Duration = Duration::from_hours(1);
const MEDIA_FIRST_BYTE_TIMEOUT: Duration = Duration::from_secs(30);
const UNSIZED_PROGRESS_STEP: u64 = 256 * 1024;

#[derive(serde::Deserialize)]
pub struct GalleryAttachment {
    pub filename: String,
    pub mime: String,
    pub bytes: Vec<u8>,
    pub info: Option<AttachmentInfoView>,
}

impl Core {
    pub(crate) async fn max_upload_size(&self) -> Result<u64, CommandErr> {
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
    pub async fn import_persona_avatar(&self, url: String) -> Result<String, CommandErr> {
        self.client().await?;
        let (mime, bytes) = download_persona_avatar(&url).await?;
        self.upload_media(mime, bytes).await
    }

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
        self.fetch_media(source, width, height, false).await
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
    ) -> Result<Vec<u8>, CommandErr> {
        let key = source;
        let source: MediaSource = serde_json::from_str(&key)
            .unwrap_or_else(|_| MediaSource::Plain(OwnedMxcUri::from(key.clone())));
        if let MediaSource::Plain(uri) = &source
            && uri.parts().is_err()
        {
            return Err(CommandErr::InvalidMedia);
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
                        .map_err(|_| CommandErr::Unavailable)?;
                    if let Some(bytes) = cached_media(&client, &source, width, height).await {
                        return Ok(bytes);
                    }
                    permit
                }
                Err(tokio::sync::TryAcquireError::Closed) => return Err(CommandErr::Unavailable),
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
            let admission = self
                .media_health
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .admit(server, media_id, now);
            match admission {
                Admission::Refused { retry_after_ms } => {
                    return Err(CommandErr::MediaServerUnavailable { retry_after_ms });
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
        if let Some((server, media_id)) = &origin {
            let mut health = self
                .media_health
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match &result {
                Ok(_) => health.succeeded(server, media_id),
                Err(error) if blames_media_server(error) => {
                    health.failed(server, media_id, now_ms());
                }
                Err(_) => health.abandoned(server),
            }
        }
        if let Some(probe) = probe.as_mut() {
            probe.armed = false;
        }
        result.map_err(|_| CommandErr::Unavailable)
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

        let thumbnail = media_timeout(fetch_sdk_media(client, &request))
            .await
            .and_then(|result| result);
        match thumbnail {
            Ok(bytes) => Ok(bytes),
            Err(error) if answered_by_server(&error) => {
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
    pub async fn forget_media(&self, source: String) -> Result<(), CommandErr> {
        let source: MediaSource = serde_json::from_str(&source)
            .unwrap_or_else(|_| MediaSource::Plain(OwnedMxcUri::from(source)));
        let uri = match source {
            MediaSource::Plain(uri) => uri,
            MediaSource::Encrypted(file) => file.url,
        };
        if uri.parts().is_err() {
            return Err(CommandErr::InvalidMedia);
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
        let mut url = client.homeserver();
        let Ok(mut segments) = url.path_segments_mut() else {
            return fetch_sdk_media(client, &request).await;
        };
        segments.pop_if_empty().extend([
            "_matrix",
            "client",
            "v1",
            "media",
            "download",
            server.as_str(),
            media_id,
        ]);
        drop(segments);

        let response = media_timeout(
            client
                .http_client()
                .get(url)
                .bearer_auth(token)
                .timeout(MEDIA_DOWNLOAD_TIMEOUT)
                .send(),
        )
        .await??;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return fetch_sdk_media(client, &request).await;
        }
        let response = response.error_for_status()?;
        let total = response.content_length().unwrap_or(0);
        let mut content = Vec::with_capacity(
            usize::try_from(total)
                .unwrap_or(0)
                .min(MAX_INITIAL_DOWNLOAD_CAPACITY),
        );
        let mut chunks = response.bytes_stream();
        let mut reported = 0;
        while let Some(chunk) = media_timeout(chunks.next()).await? {
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
            .or_failed(self, "upload_media")?;

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
        request: SendAttachmentRequest,
        bytes: Vec<u8>,
    ) -> Result<(), CommandErr> {
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > self.max_upload_size().await? {
            return Err(CommandErr::InvalidMedia);
        }
        let mime: Mime = request.mime.parse().map_err(|_| CommandErr::InvalidMedia)?;
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
            extra_content: attachment_extra_content(
                persona.as_ref(),
                request.spoiler,
                audio_metadata.as_ref(),
            ),
            ..AttachmentConfig::default()
        };

        self.room(&request.room_id)
            .await?
            .send_queue()
            .send_attachment(request.filename, mime, bytes, config)
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
        attachments: Vec<GalleryAttachment>,
    ) -> Result<(), CommandErr> {
        if attachments.len() != request.attachments.len() || attachments.len() < 2 {
            return Err(CommandErr::InvalidMedia);
        }
        let max_upload_size = self.max_upload_size().await?;
        if attachments
            .iter()
            .any(|item| u64::try_from(item.bytes.len()).unwrap_or(u64::MAX) > max_upload_size)
        {
            return Err(CommandErr::InvalidMedia);
        }
        let mut gallery = GalleryConfig::new()
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
        for item in attachments {
            let mime: Mime = item.mime.parse().map_err(|_| CommandErr::InvalidMedia)?;
            let info = attachment_info(&mime, &item.info.unwrap_or_default(), item.bytes.len());
            gallery = gallery.add_item(GalleryItemInfo {
                filename: item.filename,
                content_type: mime,
                data: item.bytes,
                attachment_info: info,
                caption: None,
                thumbnail: None,
                extra_content: None,
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
async fn download_persona_avatar(url: &str) -> Result<(String, Vec<u8>), CommandErr> {
    const MAX_AVATAR_BYTES: usize = 20 * 1024 * 1024;
    let url = url::Url::parse(url).map_err(|_| CommandErr::InvalidMedia)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(CommandErr::InvalidMedia);
    }
    // Do not send Matrix credentials to avatar hosts.
    let http = crate::tls::apply(matrix_sdk::reqwest::Client::builder())
        .user_agent("Sable")
        .timeout(Duration::from_secs(30))
        .redirect(matrix_sdk::reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|_| CommandErr::Unavailable)?;
    let mut response = http
        .get(url)
        .send()
        .await
        .and_then(matrix_sdk::reqwest::Response::error_for_status)
        .map_err(|error| {
            tracing::warn!("persona avatar download failed: {}", error.without_url());
            CommandErr::Unavailable
        })?;
    if response
        .content_length()
        .is_some_and(|size| size > MAX_AVATAR_BYTES as u64)
    {
        return Err(CommandErr::InvalidMedia);
    }
    let mime = response
        .headers()
        .get(matrix_sdk::reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/*")
        .to_owned();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| CommandErr::Unavailable)?
    {
        if chunk.len() > MAX_AVATAR_BYTES - bytes.len() {
            return Err(CommandErr::InvalidMedia);
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(CommandErr::InvalidMedia);
    }
    Ok((mime, bytes))
}

fn attachment_profile(
    profile: &PerMessageProfileView,
) -> serde_json::Map<String, serde_json::Value> {
    profile_extra_content(profile)
}

const AUDIO_METADATA_KEY: &str = "org.matrix.msc4549.audio_metadata";

fn audio_metadata_content(
    metadata: &AudioMetadataView,
) -> serde_json::Map<String, serde_json::Value> {
    let fields = [
        ("title", &metadata.title),
        ("artist", &metadata.artist),
        ("album", &metadata.album),
        ("cover_art_blurhash", &metadata.cover_art_blurhash),
    ]
    .into_iter()
    .filter_map(|(key, value)| Some((key.to_owned(), serde_json::Value::String(value.clone()?))))
    .collect();
    serde_json::Map::from_iter([(
        "info".to_owned(),
        serde_json::json!({ AUDIO_METADATA_KEY: serde_json::Value::Object(fields) }),
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
            self.core
                .media_health
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .abandoned(self.server);
        }
    }
}

async fn media_timeout<T>(future: impl std::future::Future<Output = T>) -> matrix_sdk::Result<T> {
    matrix_sdk::timeout::timeout(future, MEDIA_FIRST_BYTE_TIMEOUT)
        .await
        .map_err(|elapsed| matrix_sdk::Error::UnknownError(Box::new(elapsed)))
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
            && (!preview
                || !matches!(request.format, MediaFormat::File)
                || bytes.len() <= MAX_CACHED_PREVIEW_ORIGINAL_BYTES)
        {
            return Some(bytes);
        }
    }
    None
}

fn now_ms() -> u64 {
    MilliSecondsSinceUnixEpoch::now().get().into()
}

fn media_origin(source: &MediaSource) -> Option<(OwnedServerName, String)> {
    let uri = match source {
        MediaSource::Plain(uri) => uri,
        MediaSource::Encrypted(file) => &file.url,
    };
    let (server, media_id) = uri.parts().ok()?;
    Some((server.to_owned(), media_id.to_owned()))
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
        };
        let profile = attachment_profile(&profile);

        assert_eq!(profile["com.beeper.per_message_profile"]["id"], "hatchy");
        assert!(profile.get("body").is_none());
    }
}
