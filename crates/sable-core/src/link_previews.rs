use crate::Core;
use crate::protocol::{
    PostAuthorView, PostMediaKindView, PostMediaView, PostSensitivityView, PostStatsView, PostView,
    RpcError, UrlPreviewVideoView, UrlPreviewView,
};
use matrix_sdk::media::{MediaFormat, MediaRequestParameters};
use matrix_sdk::ruma::events::room::{EncryptedFile, MediaSource};
use matrix_sdk::ruma::{OwnedMxcUri, OwnedRoomId};
use sable_link_preview::{
    BundleEntry, Post, PostAuthor, PostMedia, PostMediaKind, PostStats, PreviewData, Sensitivity,
    VideoData,
};
use std::collections::HashMap;

pub(crate) use sable_link_preview::{BUNDLED_LINK_PREVIEWS, LEGACY_BUNDLED_LINK_PREVIEWS};

pub(crate) fn is_preview_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

pub(crate) fn preview_refused(error: &matrix_sdk::HttpError) -> bool {
    error
        .as_client_api_error()
        .is_some_and(|api_error| matches!(api_error.status_code.as_u16(), 400 | 403))
}

pub(crate) fn is_mxc(source: &str) -> bool {
    source.starts_with("mxc://")
}

#[cfg(any(target_family = "wasm", test))]
pub(crate) async fn soliditas_preview(
    base: &str,
    target: &str,
) -> Result<Option<serde_json::Value>, RpcError> {
    let mut endpoint = url::Url::parse(&format!(
        "{}/_soliditas/preview_url",
        base.trim_end_matches('/')
    ))
    .map_err(|error| {
        crate::errors::coded(
            "link_preview_url",
            crate::protocol::RpcCode::Unavailable,
            &error,
        )
    })?;
    endpoint.query_pairs_mut().append_pair("url", target);

    let builder = crate::tls::apply(matrix_sdk::reqwest::Client::builder());
    #[cfg(not(target_family = "wasm"))]
    let builder = builder.timeout(std::time::Duration::from_secs(10));
    let http = builder.build().map_err(|error| {
        crate::errors::coded(
            "link_preview_client",
            crate::protocol::RpcCode::Unavailable,
            &error,
        )
    })?;
    let response = http.get(endpoint).send().await.map_err(|error| {
        tracing::warn!("soliditas preview failed: {}", error.without_url());
        crate::protocol::RpcCode::Unavailable
    })?;

    let status = response.status();
    if status.is_client_error() {
        return Ok(None);
    }
    if !status.is_success() {
        tracing::warn!("soliditas preview answered {status}");
        return Err(crate::protocol::RpcCode::Unavailable.into());
    }
    let body = response.bytes().await.map_err(|error| {
        crate::errors::coded(
            "link_preview_body",
            crate::protocol::RpcCode::Unavailable,
            &error,
        )
    })?;
    Ok(serde_json::from_slice(&body).ok())
}

pub(crate) fn video_view(video: VideoData) -> UrlPreviewVideoView {
    UrlPreviewVideoView {
        source: video.source,
        mime: video.mime,
        width: video.width,
        height: video.height,
        gif: video.gif,
    }
}

pub(crate) fn post_view(post: Post, media: impl Fn(&str) -> bool) -> PostView {
    into_post_view(post.map_media(&mut |url| media(url).then(|| url.to_owned())))
}

fn into_post_view(post: Post) -> PostView {
    let text = |value: Option<String>| {
        value
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    PostView {
        url: post.url.filter(|url| is_preview_url(url)),
        author: PostAuthorView {
            name: text(post.author.name),
            handle: text(post.author.handle),
            avatar: encrypted_source(post.author.avatar_encrypted).or(post.author.avatar),
            url: post.author.url.filter(|url| is_preview_url(url)),
        },
        text: text(post.text),
        created_at: post.created_at,
        media: post
            .media
            .into_iter()
            .filter_map(|media| {
                Some(PostMediaView {
                    kind: match media.kind {
                        PostMediaKind::Image => PostMediaKindView::Image,
                        PostMediaKind::Video => PostMediaKindView::Video,
                        PostMediaKind::Gif => PostMediaKindView::Gif,
                    },
                    source: encrypted_source(media.encrypted).or(media.url)?,
                    mime: media.mime,
                    width: media.width,
                    height: media.height,
                    alt: text(media.alt),
                })
            })
            .collect(),
        stats: post.stats.map(|stats| PostStatsView {
            replies: stats.replies,
            reposts: stats.reposts,
            likes: stats.likes,
        }),
        sensitivity: post.sensitivity.map(|sensitivity| match sensitivity {
            Sensitivity::Graphic => PostSensitivityView::Graphic,
            Sensitivity::Inappropriate => PostSensitivityView::Inappropriate,
            Sensitivity::Spoiler => PostSensitivityView::Spoiler,
        }),
        sensitivity_reason: text(post.sensitivity_reason),
        quote: post.quote.map(|quote| Box::new(into_post_view(*quote))),
    }
}

fn encrypted_source(file: Option<serde_json::Value>) -> Option<String> {
    let file: EncryptedFile = serde_json::from_value(file?).ok()?;
    file.url
        .is_valid()
        .then(|| crate::view::media_source(&MediaSource::Encrypted(Box::new(file))))
}

/// `(url, encrypted file, size)` of an uploaded image, the way MSC4095 bundles `og:image`.
fn uploaded(image: &PreviewImage) -> (Option<String>, Option<serde_json::Value>, Option<u64>) {
    match &image.source {
        MediaSource::Plain(uri) => (Some(uri.to_string()), None, Some(image.size)),
        MediaSource::Encrypted(file) => (None, serde_json::to_value(file).ok(), Some(image.size)),
    }
}

/// Videos are too large to upload, so a bundle leaves them out.
fn bundle_post(post: &PostView, images: &HashMap<String, PreviewImage>) -> Post {
    let (avatar, avatar_encrypted, avatar_size) = post
        .author
        .avatar
        .as_ref()
        .and_then(|avatar| images.get(avatar))
        .map_or((None, None, None), uploaded);
    Post {
        url: post.url.clone(),
        author: PostAuthor {
            name: post.author.name.clone(),
            handle: post.author.handle.clone(),
            avatar,
            avatar_encrypted,
            avatar_size,
            url: post.author.url.clone(),
        },
        text: post.text.clone(),
        created_at: post.created_at,
        media: post
            .media
            .iter()
            .filter(|media| media.kind == PostMediaKindView::Image)
            .filter_map(|media| {
                let (url, encrypted, size) = uploaded(images.get(&media.source)?);
                Some(PostMedia {
                    kind: PostMediaKind::Image,
                    url,
                    encrypted,
                    size,
                    mime: media.mime.clone(),
                    width: media.width,
                    height: media.height,
                    alt: media.alt.clone(),
                })
            })
            .collect(),
        stats: post.stats.map(|stats| PostStats {
            replies: stats.replies,
            reposts: stats.reposts,
            likes: stats.likes,
        }),
        sensitivity: post.sensitivity.map(|sensitivity| match sensitivity {
            PostSensitivityView::Graphic => Sensitivity::Graphic,
            PostSensitivityView::Inappropriate => Sensitivity::Inappropriate,
            PostSensitivityView::Spoiler => Sensitivity::Spoiler,
        }),
        sensitivity_reason: post.sensitivity_reason.clone(),
        quote: post
            .quote
            .as_deref()
            .map(|quote| Box::new(bundle_post(quote, images))),
    }
}

pub(crate) fn encrypted_image(data: &PreviewData) -> Option<EncryptedFile> {
    serde_json::from_value(data.encrypted_image.clone()?).ok()
}

pub(crate) fn url_preview(url: String, data: &serde_json::Value) -> Option<UrlPreviewView> {
    preview_view(url, &PreviewData::read(data)?, is_mxc)
}

fn preview_view(
    url: String,
    data: &PreviewData,
    media: impl Fn(&str) -> bool,
) -> Option<UrlPreviewView> {
    let text = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    };

    let preview = UrlPreviewView {
        url,
        title: text(&data.title),
        description: text(&data.description),
        site_name: text(&data.site_name),
        image: text(&data.image).filter(|image| media(image)),
        image_mime: text(&data.image_type),
        image_width: data.image_width,
        image_height: data.image_height,
        video: data.video(&media).map(video_view),
        theme_color: data.valid_theme_color(),
        card: data.valid_card(),
        author_name: text(&data.author_name),
        post: data.post.clone().map(|post| post_view(post, &media)),
    };

    if preview.title.is_none()
        && preview.description.is_none()
        && preview.image.is_none()
        && preview.video.is_none()
        && preview.post.is_none()
    {
        return None;
    }
    Some(preview)
}

#[cfg(not(target_family = "wasm"))]
mod local {
    use std::sync::LazyLock;
    use std::time::Duration;

    use sable_link_preview::{
        Fetch as _, MAX_DIRECT_VIDEO_BYTES, PostMediaKind, ReqwestFetch, Response as _,
    };

    use crate::protocol::{RpcCode, RpcError, UrlPreviewView};

    const USER_AGENT: &str = concat!(
        "Sable/",
        env!("SABLE_APP_VERSION"),
        " (link preview; +https://sable.moe)"
    );

    const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

    const MAX_SCRAPED_MEDIA: usize = 512;

    /// The media URLs a scrape handed out, with how many bytes each may take.
    /// Only these reach the web, so an event naming a web URL as its media
    /// cannot make the client fetch it.
    static SCRAPED: LazyLock<parking_lot::Mutex<hashlink::LruCache<String, usize>>> =
        LazyLock::new(|| parking_lot::Mutex::new(hashlink::LruCache::new(MAX_SCRAPED_MEDIA)));

    fn client(timeout: Duration) -> Result<ReqwestFetch, RpcError> {
        let builder = crate::tls::apply(matrix_sdk::reqwest::Client::builder())
            .user_agent(USER_AGENT)
            .timeout(timeout);
        ReqwestFetch::new(builder).map_err(|error| {
            crate::errors::coded("link_preview_fetcher", RpcCode::Unavailable, &error)
        })
    }

    pub(crate) async fn scrape(
        url: &str,
        options: &sable_link_preview::ScrapeOptions,
    ) -> Result<Option<UrlPreviewView>, RpcError> {
        let Some(target) = sable_link_preview::parse_public_url(url, None) else {
            return Ok(None);
        };
        let fetch = client(Duration::from_secs(10))?;
        let Some(preview) = sable_link_preview::scrape(&fetch, &target, options).await else {
            return Ok(None);
        };
        {
            let video_cap = usize::try_from(MAX_DIRECT_VIDEO_BYTES).unwrap_or(usize::MAX);
            let mut scraped = SCRAPED.lock();
            for (url, kind) in preview.media_urls() {
                let cap = match kind {
                    PostMediaKind::Image => MAX_IMAGE_BYTES,
                    PostMediaKind::Video | PostMediaKind::Gif => video_cap,
                };
                scraped.insert(url.into(), cap);
            }
        }
        let data = serde_json::Value::Object(preview.to_matrix(ToString::to_string));
        Ok(sable_link_preview::PreviewData::read(&data)
            .and_then(|data| super::preview_view(url.to_owned(), &data, |_| true)))
    }

    pub(super) async fn scraped_media(
        source: &str,
        limit: usize,
    ) -> Option<Result<Vec<u8>, RpcError>> {
        let cap = SCRAPED.lock().get(source).copied()?;
        Some(download(source, limit.min(cap)).await)
    }

    async fn download(source: &str, limit: usize) -> Result<Vec<u8>, RpcError> {
        let url = url::Url::parse(source).map_err(|_| RpcCode::InvalidMedia)?;
        let fetch = client(Duration::from_secs(60))?;
        let response = fetch
            .get(&url, "image/*,video/*;q=0.9,*/*;q=0.5")
            .await
            .ok_or(RpcCode::Unavailable)?;
        let body = response
            .body(limit.saturating_add(1))
            .await
            .ok_or(RpcCode::Unavailable)?;
        if body.is_empty() || body.len() > limit {
            return Err(RpcCode::InvalidMedia.into());
        }
        Ok(body)
    }
}

#[cfg(not(target_family = "wasm"))]
pub(crate) use local::scrape as scrape_locally;

#[cfg(not(target_family = "wasm"))]
pub(crate) async fn scraped_media(source: &str) -> Option<Result<Vec<u8>, RpcError>> {
    local::scraped_media(source, usize::MAX).await
}

const MAX_PREVIEW_IMAGE_BYTES: usize = 1024 * 1024;

const MAX_POST_IMAGE_BYTES: usize = 10 * 1024 * 1024;

const MAX_BUNDLED_IMAGES: usize = 10;

pub(crate) struct PreviewImage {
    source: MediaSource,
    size: u64,
}

fn bundle_entry(
    preview: &UrlPreviewView,
    images: &HashMap<String, PreviewImage>,
    stable: bool,
) -> BundleEntry {
    let image = preview.image.as_ref().and_then(|image| images.get(image));
    let video = preview.video.as_ref().filter(|video| is_mxc(&video.source));
    let encrypted = image.and_then(|image| match &image.source {
        MediaSource::Encrypted(file) => serde_json::to_value(file).ok(),
        MediaSource::Plain(_) => None,
    });
    BundleEntry {
        stable_matched_url: stable.then(|| preview.url.clone()),
        legacy_matched_url: (!stable).then(|| preview.url.clone()),
        url: (preview.title.is_some()
            || preview.description.is_some()
            || preview.site_name.is_some()
            || image.is_some()
            || video.is_some())
        .then(|| preview.url.clone()),
        title: preview.title.clone(),
        description: preview.description.clone(),
        site_name: preview.site_name.clone(),
        encrypted_image: encrypted.clone().filter(|_| stable),
        legacy_encrypted_image: encrypted.filter(|_| !stable),
        image_size: image.map(|image| image.size),
        image: image.and_then(|image| match &image.source {
            MediaSource::Plain(uri) => Some(uri.to_string()),
            MediaSource::Encrypted(_) => None,
        }),
        image_type: preview.image_mime.clone().filter(|_| image.is_some()),
        image_width: preview.image_width.filter(|_| image.is_some()),
        image_height: preview.image_height.filter(|_| image.is_some()),
        video: video.map(|video| video.source.clone()),
        video_type: video.and_then(|video| video.mime.clone()),
        video_width: video.and_then(|video| video.width),
        video_height: video.and_then(|video| video.height),
        video_gif: video.and_then(|video| video.gif.then_some(true)),
        theme_color: preview.theme_color.clone(),
        card: preview.card.clone(),
        author_name: preview.author_name.clone(),
        post: preview.post.as_ref().map(|post| bundle_post(post, images)),
    }
}

pub(crate) fn bundled_link_previews(
    previews: &[UrlPreviewView],
    images: &HashMap<String, PreviewImage>,
    stable: bool,
) -> Option<serde_json::Value> {
    if previews.is_empty() {
        return None;
    }
    let bundles: Vec<_> = previews
        .iter()
        .map(|preview| bundle_entry(preview, images, stable))
        .collect();
    serde_json::to_value(bundles).ok()
}

impl Core {
    async fn preview_image_bytes(
        client: &matrix_sdk::Client,
        image: &str,
        #[cfg_attr(
            target_family = "wasm",
            expect(unused_variables, reason = "the web fetches no scraped media")
        )]
        max_bytes: usize,
    ) -> Option<Vec<u8>> {
        if is_mxc(image) {
            let request = MediaRequestParameters {
                source: MediaSource::Plain(OwnedMxcUri::from(image)),
                format: MediaFormat::File,
            };
            return client.media().get_media_content(&request, false).await.ok();
        }
        #[cfg(not(target_family = "wasm"))]
        if let Some(bytes) = local::scraped_media(image, max_bytes).await {
            return bytes.ok();
        }
        None
    }

    /// Keyed by the source they replace.
    pub(crate) async fn prepare_preview_images(
        &self,
        room_id: &OwnedRoomId,
        previews: &[UrlPreviewView],
    ) -> HashMap<String, PreviewImage> {
        let mut images = HashMap::new();
        let mut wanted: Vec<WantedImage> = Vec::new();
        for preview in previews {
            for image in preview_images(preview) {
                if let Some(known) = wanted.iter_mut().find(|known| known.source == image.source) {
                    known.max_bytes = known.max_bytes.max(image.max_bytes);
                } else if wanted.len() < MAX_BUNDLED_IMAGES {
                    wanted.push(image);
                }
            }
        }
        if wanted.is_empty() {
            return images;
        }
        let Ok(room) = self.room(room_id).await else {
            return images;
        };
        let Ok(encrypted) = self.room_is_encrypted(&room).await else {
            return images;
        };
        let client = room.client();
        for WantedImage {
            source: image,
            mime,
            max_bytes,
        } in wanted
        {
            let Some(data) = Self::preview_image_bytes(&client, image, max_bytes).await else {
                continue;
            };
            if data.is_empty() || data.len() > max_bytes {
                continue;
            }
            let size = data.len() as u64;
            let source = if encrypted {
                let mut reader = std::io::Cursor::new(data);
                let Ok(file) = client.upload_encrypted_file(&mut reader).await else {
                    continue;
                };
                MediaSource::Encrypted(Box::new(file))
            } else {
                let mime = mime
                    .and_then(|mime| mime.parse::<mime::Mime>().ok())
                    .unwrap_or(mime::APPLICATION_OCTET_STREAM);
                let Ok(response) = client.media().upload(&mime, data, None).await else {
                    continue;
                };
                MediaSource::Plain(response.content_uri)
            };
            images.insert(image.to_owned(), PreviewImage { source, size });
        }
        images
    }
}

struct WantedImage<'a> {
    source: &'a str,
    mime: Option<&'a str>,
    max_bytes: usize,
}

/// The main image, then the avatars and images of the post and its quote.
fn preview_images(preview: &UrlPreviewView) -> Vec<WantedImage<'_>> {
    fn post_images<'a>(post: &'a PostView, images: &mut Vec<WantedImage<'a>>) {
        images.extend(post.author.avatar.as_deref().map(|avatar| WantedImage {
            source: avatar,
            mime: None,
            max_bytes: MAX_PREVIEW_IMAGE_BYTES,
        }));
        images.extend(
            post.media
                .iter()
                .filter(|media| media.kind == PostMediaKindView::Image)
                .map(|media| WantedImage {
                    source: &media.source,
                    mime: media.mime.as_deref(),
                    max_bytes: MAX_POST_IMAGE_BYTES,
                }),
        );
        if let Some(quote) = &post.quote {
            post_images(quote, images);
        }
    }
    let mut images: Vec<_> = preview
        .image
        .as_deref()
        .map(|image| WantedImage {
            source: image,
            mime: preview.image_mime.as_deref(),
            max_bytes: MAX_PREVIEW_IMAGE_BYTES,
        })
        .into_iter()
        .collect();
    if let Some(post) = &preview.post {
        post_images(post, &mut images);
    }
    images
}

#[cfg(test)]
mod tests {

    #[test]
    fn bundles_use_persistent_images_and_include_their_metadata() {
        let previews = [preview("https://example.org/")];
        let images = std::collections::HashMap::from([(
            previews[0].image.clone().unwrap(),
            super::PreviewImage {
                source: matrix_sdk::ruma::events::room::MediaSource::Plain(
                    "mxc://example.org/persistent".into(),
                ),
                size: 42,
            },
        )]);
        let stable = super::bundled_link_previews(&previews, &images, true).unwrap();
        assert_eq!(stable[0]["matrix:matched_url"], "https://example.org/");
        assert_eq!(stable[0]["og:image"], "mxc://example.org/persistent");
        assert_eq!(stable[0]["matrix:image:size"], 42);
        assert_eq!(stable[0]["og:image:type"], "image/png");
        assert_eq!(stable[0]["og:image:width"], 640);
        assert!(stable[0].get("og:description").is_none());
        assert!(stable[0].get("matched_url").is_none());
        let legacy = super::bundled_link_previews(&previews, &images, false).unwrap();
        assert_eq!(legacy[0]["matched_url"], "https://example.org/");
        assert!(legacy[0].get("matrix:matched_url").is_none());
        assert!(super::bundled_link_previews(&[], &images, true).is_none());
    }

    #[test]
    fn whitelist_only_entries_contain_just_the_matched_url() {
        let mut preview = preview("https://example.org/");
        preview.title = None;
        preview.image = None;
        preview.video = None;
        preview.theme_color = None;
        let previews = [preview];
        for (stable, field) in [(true, "matrix:matched_url"), (false, "matched_url")] {
            let bundles =
                super::bundled_link_previews(&previews, &std::collections::HashMap::new(), stable)
                    .unwrap();
            assert_eq!(
                bundles,
                serde_json::json!([{ (field): "https://example.org/" }])
            );
        }
    }

    #[test]
    fn a_preview_with_nothing_to_show_is_no_preview() {
        let empty = serde_json::json!({ "og:title": "   ", "og:image": "https://cdn/x.png" });
        assert!(super::url_preview("https://e".to_owned(), &empty).is_none());
        assert!(super::url_preview("https://e".to_owned(), &serde_json::json!({})).is_none());
    }

    #[test]
    fn a_video_alone_is_a_preview() {
        let data = serde_json::json!({
            "og:video": "mxc://s/clip",
            "og:video:type": "video/mp4",
            "og:video:width": 1280,
            "og:video:height": 720,
        });
        let preview = super::url_preview("https://e".to_owned(), &data).expect("a preview");
        let video = preview.video.expect("a video");
        assert_eq!(video.source, "mxc://s/clip");
        assert_eq!(video.mime.as_deref(), Some("video/mp4"));
        assert_eq!((video.width, video.height), (Some(1280), Some(720)));

        let remote = serde_json::json!({ "og:video": "https://cdn.example/clip.mp4" });
        assert!(super::url_preview("https://e".to_owned(), &remote).is_none());
    }

    #[test]
    fn presentation_hints_are_validated() {
        let data = serde_json::json!({
            "og:title": "Title",
            "com.sable.theme_color": "#ff4500",
            "com.sable.card": "summary_large_image",
            "com.sable.author_name": "someone",
        });
        let preview = super::url_preview("https://e".to_owned(), &data).expect("a preview");
        assert_eq!(preview.theme_color.as_deref(), Some("#ff4500"));
        assert_eq!(preview.card.as_deref(), Some("summary_large_image"));
        assert_eq!(preview.author_name.as_deref(), Some("someone"));

        let data = serde_json::json!({
            "og:title": "Title",
            "com.sable.theme_color": "red; background:url(x)",
            "com.sable.card": "player",
        });
        let preview = super::url_preview("https://e".to_owned(), &data).expect("a preview");
        assert_eq!(preview.theme_color, None);
        assert_eq!(preview.card, None);
    }

    #[test]
    fn a_preview_keeps_only_an_mxc_image() {
        let data = serde_json::json!({
            "og:title": "Title",
            "og:image": "https://cdn.example/x.png",
        });
        let preview = super::url_preview("https://e".to_owned(), &data).expect("a preview");
        assert_eq!(preview.image, None);

        let data = serde_json::json!({
            "og:title": "Title",
            "og:image": "mxc://example.org/1",
            "og:image:width": 640,
        });
        let preview = super::url_preview("https://e".to_owned(), &data).expect("a preview");
        assert_eq!(preview.image.as_deref(), Some("mxc://example.org/1"));
        assert_eq!(preview.image_width, Some(640));
    }

    #[test]
    fn bundles_keep_only_an_mxc_video() {
        let previews = [preview("https://example.org/")];
        let bundles =
            super::bundled_link_previews(&previews, &std::collections::HashMap::new(), true)
                .unwrap();
        assert!(bundles[0].get("og:video").is_none());
        assert!(bundles[0].get("og:video:height").is_none());

        let mut proxied = preview("https://example.org/");
        if let Some(video) = proxied.video.as_mut() {
            video.source = "mxc://example.org/clip".to_owned();
            video.gif = true;
        }
        let bundles =
            super::bundled_link_previews(&[proxied], &std::collections::HashMap::new(), true)
                .unwrap();
        assert_eq!(bundles[0]["og:video"], "mxc://example.org/clip");
        assert_eq!(bundles[0]["og:video:height"], 360);
        assert_eq!(bundles[0]["og:video:com.sable.gif"], true);
        let read = super::url_preview("https://example.org/".to_owned(), &bundles[0]);
        assert!(
            read.and_then(|preview| preview.video)
                .is_some_and(|video| video.gif)
        );
    }

    #[test]
    fn a_post_keeps_only_mxc_media_and_bundles_only_uploaded_images() {
        let data = serde_json::json!({
            "og:title": "Alice (@alice.test)",
            "og:type": "note",
            "note:author": " Alice ",
            "note:author:handle": "alice.test",
            "note:author:image": "https://cdn/a.jpg",
            "note:author:url": "javascript:alert(1)",
            "note:content": "hello",
            "note:published_time": "2026-10-12T00:00:00.000Z",
            "note:relation": ["like", "quoted_note"],
            "note:relation:like": "7",
            "note:relation:quoted_note": "1",
            "note:sensitivity": "spoiler",
            "og:image": "mxc://s/cat",
            "og:image:alt": "a cat",
            "og:video": "https://cdn/v.mp4",
            "related:1:og:type": "note",
            "related:1:og:url": "https://bsky.app/profile/bob.test/post/1",
            "related:1:note:content": "quoted",
            "related:1:og:video": "mxc://s/gif",
            "related:1:og:video:com.sable.gif": true,
        });
        let preview = super::url_preview("https://bsky.app/x".to_owned(), &data).unwrap();
        let post = preview.post.clone().unwrap();
        assert_eq!(post.author.name.as_deref(), Some("Alice"));
        assert_eq!(post.author.avatar, None);
        assert_eq!(post.author.url, None);
        assert_eq!(post.media.len(), 1);
        assert_eq!(post.media[0].source, "mxc://s/cat");
        assert_eq!(
            post.sensitivity,
            Some(crate::protocol::PostSensitivityView::Spoiler)
        );
        let quote = post.quote.as_ref().unwrap();
        assert_eq!(
            quote.url.as_deref(),
            Some("https://bsky.app/profile/bob.test/post/1")
        );
        assert_eq!(quote.media[0].kind, crate::protocol::PostMediaKindView::Gif);
        assert_eq!(quote.media[0].source, "mxc://s/gif");

        let bundles =
            super::bundled_link_previews(&[preview], &std::collections::HashMap::new(), true)
                .unwrap();
        assert_eq!(
            note_keys(&bundles[0]),
            serde_json::json!({
                "og:type": "note",
                "note:author": "Alice",
                "note:author:handle": "alice.test",
                "note:content": "hello",
                "note:published_time": "2026-10-12T00:00:00.000Z",
                "note:relation": ["like", "quoted_note"],
                "note:relation:like": "7",
                "note:relation:quoted_note": "1",
                "note:sensitivity": "spoiler",
                "related:1:og:type": "note",
                "related:1:og:url": "https://bsky.app/profile/bob.test/post/1",
                "related:1:note:content": "quoted",
            })
        );
    }

    #[test]
    fn a_bundled_post_carries_its_uploaded_images_like_og_image() {
        let file: matrix_sdk::ruma::events::room::EncryptedFile =
            serde_json::from_value(encrypted_file("mxc://example.org/face")).unwrap();
        let mut preview = preview("https://bsky.app/x");
        preview.post = Some(crate::protocol::PostView {
            author: crate::protocol::PostAuthorView {
                handle: Some("alice.test".to_owned()),
                avatar: Some("https://cdn/face.jpg".to_owned()),
                ..Default::default()
            },
            media: vec![
                post_media(
                    crate::protocol::PostMediaKindView::Image,
                    "https://cdn/cat.png",
                ),
                post_media(
                    crate::protocol::PostMediaKindView::Image,
                    "https://cdn/dog.png",
                ),
                post_media(
                    crate::protocol::PostMediaKindView::Video,
                    "https://cdn/clip.mp4",
                ),
            ],
            ..Default::default()
        });
        let images = std::collections::HashMap::from([
            (
                "https://cdn/face.jpg".to_owned(),
                super::PreviewImage {
                    source: matrix_sdk::ruma::events::room::MediaSource::Encrypted(Box::new(file)),
                    size: 5,
                },
            ),
            (
                "https://cdn/cat.png".to_owned(),
                super::PreviewImage {
                    source: matrix_sdk::ruma::events::room::MediaSource::Plain(
                        "mxc://example.org/cat".into(),
                    ),
                    size: 9,
                },
            ),
        ]);
        let bundles = super::bundled_link_previews(&[preview], &images, true).unwrap();
        let mut keys = note_keys(&bundles[0]);
        assert_eq!(
            keys["note:author:image:encrypted"]["url"],
            "mxc://example.org/face"
        );
        keys.as_object_mut()
            .unwrap()
            .remove("note:author:image:encrypted");
        assert_eq!(
            keys,
            serde_json::json!({
                "og:type": "note",
                "note:author": "alice.test",
                "note:author:handle": "alice.test",
                "note:author:image:size": 5,
                "og:image": "mxc://example.org/cat",
                "og:image:alt": "alt",
                "matrix:image:size": 9,
            })
        );

        let read = super::url_preview("https://bsky.app/x".to_owned(), &bundles[0])
            .unwrap()
            .post
            .unwrap();
        let avatar = read.author.avatar.unwrap();
        assert!(avatar.starts_with('{') && avatar.contains("mxc://example.org/face"));
        assert_eq!(read.media[0].source, "mxc://example.org/cat");
    }

    fn note_keys(bundle: &serde_json::Value) -> serde_json::Value {
        bundle
            .as_object()
            .unwrap()
            .iter()
            .filter(|(key, _)| {
                [
                    "og:type",
                    "note:",
                    "related:",
                    "og:image",
                    "og:video",
                    "matrix:image",
                ]
                .iter()
                .any(|prefix| key.starts_with(prefix))
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<serde_json::Map<_, _>>()
            .into()
    }

    fn post_media(
        kind: crate::protocol::PostMediaKindView,
        source: &str,
    ) -> crate::protocol::PostMediaView {
        crate::protocol::PostMediaView {
            kind,
            source: source.to_owned(),
            mime: None,
            width: None,
            height: None,
            alt: Some("alt".to_owned()),
        }
    }

    fn encrypted_file(url: &str) -> serde_json::Value {
        serde_json::json!({
            "url": url,
            "key": {
                "kty": "oct", "key_ops": ["encrypt", "decrypt"], "alg": "A256CTR",
                "k": "GRAgOUnbbkcd-UWoX5kTiIXJII81qwpSCnxLd5X6pxU", "ext": true
            },
            "iv": "kZeoJfx4ehoAAAAAAAAAAA",
            "hashes": { "sha256": "WDOJYFegjAHNlaJmOhEPpE/3reYeD1pRvPVcta4Tgbg" },
            "v": "v2"
        })
    }

    #[test]
    fn a_post_alone_is_a_preview() {
        let data = serde_json::json!({ "og:type": "note", "note:content": "just text" });
        let preview = super::url_preview("https://e".to_owned(), &data).unwrap();
        assert_eq!(preview.post.unwrap().text.as_deref(), Some("just text"));
    }

    #[tokio::test]
    async fn only_scraped_media_reaches_the_web() {
        assert!(
            super::scraped_media("https://tracker.example/pixel.png")
                .await
                .is_none()
        );
        assert!(
            super::scraped_media("mxc://example.org/media")
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_local_scrape_refuses_non_public_urls() {
        for url in [
            "http://localhost/",
            "http://192.168.1.1/",
            "ftp://files.example/",
        ] {
            assert!(
                super::scrape_locally(url, &sable_link_preview::ScrapeOptions::default())
                    .await
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[tokio::test]
    async fn soliditas_preview_asks_the_worker_with_the_url() {
        use wiremock::{
            Mock, MockServer, ResponseTemplate,
            matchers::{header, method, path, query_param},
        };
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/_soliditas/preview_url"))
            .and(header("user-agent", crate::USER_AGENT))
            .and(query_param("url", "https://example.org/a?b=1&c=2"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"og:title": "Hi"})),
            )
            .expect(1)
            .mount(&server)
            .await;

        let data = super::soliditas_preview(
            &format!("{}/", server.uri()),
            "https://example.org/a?b=1&c=2",
        )
        .await
        .expect("answered");
        assert_eq!(
            data.as_ref().and_then(|d| d["og:title"].as_str()),
            Some("Hi")
        );
    }

    #[tokio::test]
    async fn soliditas_preview_treats_a_refused_url_as_no_preview() {
        use wiremock::{Mock, MockServer, ResponseTemplate, matchers::method};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let data = super::soliditas_preview(&server.uri(), "https://example.org/a")
            .await
            .expect("answered");
        assert!(data.is_none());
    }

    #[tokio::test]
    async fn soliditas_preview_reports_a_server_failure() {
        use wiremock::{Mock, MockServer, ResponseTemplate, matchers::method};
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(502))
            .mount(&server)
            .await;

        let error = super::soliditas_preview(&server.uri(), "https://example.org/a")
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            crate::protocol::RpcError {
                code: crate::protocol::RpcCode::Unavailable,
                ..
            }
        ));
    }

    fn preview(url: &str) -> crate::protocol::UrlPreviewView {
        crate::protocol::UrlPreviewView {
            url: url.to_owned(),
            title: Some("Title".to_owned()),
            description: None,
            site_name: None,
            image: Some("mxc://example.org/image".to_owned()),
            image_mime: Some("image/png".to_owned()),
            image_width: Some(640),
            image_height: None,
            video: Some(crate::protocol::UrlPreviewVideoView {
                source: "https://example.org/v.mp4".to_owned(),
                mime: Some("video/mp4".to_owned()),
                width: None,
                height: Some(360),
                gif: false,
            }),
            theme_color: Some("#fff".to_owned()),
            card: None,
            author_name: None,
            post: None,
        }
    }
}

#[cfg(test)]
mod preview_data_tests {
    use super::url_preview;

    #[test]
    fn a_preview_skips_wrong_typed_fields_and_non_objects() {
        let data = serde_json::json!({
            "og:title": " Title ",
            "og:description": 5,
            "og:image": ["mxc://x/y"],
            "og:video": "mxc://x/v",
            "og:video:width": -1,
            "com.sable.card": "summary",
            "com.sable.theme_color": "#12",
        });
        let preview = url_preview("https://e".to_owned(), &data).expect("a preview");
        assert_eq!(preview.title.as_deref(), Some("Title"));
        assert_eq!(preview.description, None);
        assert_eq!(preview.image, None);
        assert_eq!(preview.video.as_ref().unwrap().width, None);
        assert_eq!(preview.card.as_deref(), Some("summary"));
        assert_eq!(preview.theme_color, None);
        assert!(url_preview("https://e".to_owned(), &serde_json::json!(["x"])).is_none());
    }
}
