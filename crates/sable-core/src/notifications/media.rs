#[cfg(not(target_family = "wasm"))]
use matrix_sdk::Client;
use sable_model::text::visible_name;

#[cfg(not(target_family = "wasm"))]
pub(super) const PUSH_AVATAR_SIZE: u32 = 96;
#[cfg(not(target_family = "wasm"))]
pub(super) const PUSH_IMAGE_WIDTH: u32 = 800;
#[cfg(not(target_family = "wasm"))]
pub(super) const PUSH_IMAGE_HEIGHT: u32 = 600;
/// Encrypted media is decrypted in memory, which a notification process can barely spare,
/// and the sender's declared size is the only bound known before downloading it.
#[cfg(not(target_family = "wasm"))]
const PUSH_ENCRYPTED_IMAGE_MAX_BYTES: u64 = 1024 * 1024;
#[cfg(not(target_family = "wasm"))]
const PUSH_MEDIA_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
#[cfg(not(target_family = "wasm"))]
const PUSH_MEDIA_MAX_AGE: std::time::Duration = std::time::Duration::from_hours(7 * 24);

#[cfg(not(target_family = "wasm"))]
pub(super) const PUSH_MEDIA_DIRECTORY: &str = "push-media";

/// Decrypted previews must not outlive the accounts they were shown for.
#[cfg(not(target_family = "wasm"))]
pub(crate) async fn clear_push_media(store_dir: &std::path::Path) {
    match tokio::fs::remove_dir_all(store_dir.join(PUSH_MEDIA_DIRECTORY)).await {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            tracing::warn!("could not clear the push media cache: {error}");
        }
        _ => {}
    }
}

#[cfg(not(target_family = "wasm"))]
#[derive(Debug, Default, serde::Serialize)]
pub struct PushMedia {
    pub sender_name: String,
    pub sender: Option<String>,
    pub room: Option<String>,
    pub image: Option<PushImage>,
    pub own_name: Option<String>,
    pub own_avatar: Option<String>,
}

#[cfg(not(target_family = "wasm"))]
#[derive(Debug, serde::Serialize)]
pub struct PushImage {
    pub path: String,
    pub mimetype: &'static str,
}

#[must_use]
pub fn push_sender_name(sender: Option<&str>, name: Option<&str>) -> String {
    name.and_then(visible_name)
        .or(sender)
        .unwrap_or_default()
        .to_owned()
}

#[cfg(not(target_family = "wasm"))]
pub(super) fn message_image(
    content: &serde_json::Value,
) -> Option<matrix_sdk::ruma::events::room::MediaSource> {
    use matrix_sdk::ruma::events::room::MediaSource;
    use serde_json::Value;

    if crate::view::spoiler_reason(Some(content)).is_some() {
        return None;
    }
    let msgtype = content.get("msgtype")?.as_str()?;
    if msgtype != "m.image" && msgtype != "m.video" {
        return None;
    }
    let info = content.get("info");
    let plain = |url: Option<&Value>| {
        url.and_then(|url| serde_json::from_value(url.clone()).ok())
            .map(MediaSource::Plain)
    };
    let encrypted = |file: Option<&Value>, declared: Option<&Value>| {
        let small = declared
            .and_then(|declared| declared.get("size"))
            .and_then(Value::as_u64)
            .is_some_and(|size| size <= PUSH_ENCRYPTED_IMAGE_MAX_BYTES);
        file.filter(|_| small)
            .and_then(|file| serde_json::from_value(file.clone()).ok())
            .map(MediaSource::Encrypted)
    };
    let thumbnail = encrypted(
        info.and_then(|info| info.get("thumbnail_file")),
        info.and_then(|info| info.get("thumbnail_info")),
    )
    .or_else(|| plain(info.and_then(|info| info.get("thumbnail_url"))));
    if thumbnail.is_some() || msgtype != "m.image" {
        return thumbnail;
    }
    plain(content.get("url")).or_else(|| encrypted(content.get("file"), info))
}

#[cfg(not(target_family = "wasm"))]
pub(super) async fn cached_push_media(
    client: &Client,
    directory: &std::path::Path,
    source: Option<matrix_sdk::ruma::events::room::MediaSource>,
    bounds: Option<(u32, u32)>,
) -> Option<(String, &'static str)> {
    use base64::Engine as _;
    use matrix_sdk::media::{MediaFormat, MediaRequestParameters, MediaThumbnailSettings};
    use matrix_sdk::ruma::events::room::MediaSource;
    use sha2::{Digest, Sha256};

    let source = source?;
    let format = match (&source, bounds) {
        (MediaSource::Plain(_), Some((width, height))) => {
            MediaFormat::Thumbnail(MediaThumbnailSettings::new(width.into(), height.into()))
        }
        _ => MediaFormat::File,
    };
    let url = match &source {
        MediaSource::Plain(url) => url.as_str(),
        MediaSource::Encrypted(file) => file.url.as_str(),
    };
    let key = match &format {
        MediaFormat::Thumbnail(settings) => format!("{url}#{}x{}", settings.width, settings.height),
        MediaFormat::File => url.to_owned(),
    };
    let path = directory.join(
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(key.as_bytes())),
    );
    if let Ok(mut file) = tokio::fs::File::open(&path).await {
        let mut head = [0; 12];
        let read = tokio::io::AsyncReadExt::read(&mut file, &mut head)
            .await
            .ok()?;
        return Some((
            path.to_str()?.to_owned(),
            image_mimetype(head.get(..read)?)?,
        ));
    }
    let request = MediaRequestParameters { source, format };
    let bytes = tokio::time::timeout(
        PUSH_MEDIA_TIMEOUT,
        client.media().get_media_content(&request, false),
    )
    .await
    .ok()?
    .ok()?;
    let mimetype = image_mimetype(&bytes)?;
    let directory = directory.to_owned();
    let destination = path.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(directory)?;
        crate::store::write_atomic(&destination, &bytes)
    })
    .await
    .ok()?
    .ok()?;
    Some((path.to_str()?.to_owned(), mimetype))
}

/// Only formats both platforms decode in a notification.
#[cfg(not(target_family = "wasm"))]
const fn image_mimetype(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Some("image/webp"),
        _ => None,
    }
}

#[cfg(not(target_family = "wasm"))]
pub(super) async fn prune_push_media(directory: &std::path::Path) {
    let Ok(mut entries) = tokio::fs::read_dir(directory).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let stale = entry
            .metadata()
            .await
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > PUSH_MEDIA_MAX_AGE);
        if stale {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{clear_push_media, message_image};

    #[test]
    fn push_images_skip_spoilers() {
        for mut content in [
            json!({"msgtype": "m.image", "url": "mxc://example.org/full"}),
            json!({"msgtype": "m.image", "url": "mxc://example.org/full",
                "info": {"thumbnail_url": "mxc://example.org/small"}}),
            json!({"msgtype": "m.video",
                "info": {"thumbnail_url": "mxc://example.org/frame"}}),
        ] {
            assert!(message_image(&content).is_some());
            content[crate::view::SPOILER_PROPERTY] = true.into();
            assert!(message_image(&content).is_none());
            content[crate::view::SPOILER_REASON_PROPERTY] = "plot twist".into();
            assert!(message_image(&content).is_none());
            content[crate::view::SPOILER_PROPERTY] = false.into();
            assert!(message_image(&content).is_some());
        }
    }

    #[test]
    fn a_push_image_prefers_a_thumbnail_and_skips_large_encrypted_originals() {
        use matrix_sdk::ruma::events::room::MediaSource;

        let encrypted = |url: &str| {
            json!({"url": url, "v": "v2", "iv": "AAAAAAAAAAAAAAAAAAAAAA",
                "hashes": {"sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
                "key": {"kty": "oct", "alg": "A256CTR", "ext": true,
                    "k": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "key_ops": ["encrypt", "decrypt"]}})
        };
        let source = |content: serde_json::Value| match message_image(&content) {
            Some(MediaSource::Plain(url)) => Some(url.to_string()),
            Some(MediaSource::Encrypted(file)) => Some(file.url.to_string()),
            None => None,
        };

        assert_eq!(
            source(
                json!({"msgtype": "m.image", "url": "mxc://example.org/full",
                "info": {"thumbnail_url": "mxc://example.org/small"}})
            ),
            Some("mxc://example.org/small".to_owned())
        );
        assert_eq!(
            source(json!({"msgtype": "m.video", "url": "mxc://example.org/clip"})),
            None
        );
        assert_eq!(
            source(
                json!({"msgtype": "m.image", "file": encrypted("mxc://example.org/small"),
                "info": {"size": 1024}})
            ),
            Some("mxc://example.org/small".to_owned())
        );
        assert_eq!(
            source(
                json!({"msgtype": "m.image", "file": encrypted("mxc://example.org/huge"),
                "info": {"size": 8 * 1024 * 1024}})
            ),
            None
        );
        assert_eq!(
            source(
                json!({"msgtype": "m.image", "url": "mxc://example.org/full",
                "info": {"thumbnail_file": encrypted("mxc://example.org/unsized")}})
            ),
            Some("mxc://example.org/full".to_owned())
        );
        assert_eq!(
            source(json!({"msgtype": "m.video",
                "info": {"thumbnail_file": encrypted("mxc://example.org/thumb"),
                    "thumbnail_info": {"size": 2048}}})),
            Some("mxc://example.org/thumb".to_owned())
        );
        assert_eq!(
            source(json!({"msgtype": "m.image", "file": encrypted("mxc://example.org/unsized")})),
            None
        );
        assert_eq!(source(json!({"msgtype": "m.text", "body": "hi"})), None);
    }

    #[tokio::test]
    async fn clearing_push_media_removes_the_cache_and_tolerates_its_absence() {
        let store_dir = tempfile::tempdir().unwrap();
        let cache = store_dir.path().join("push-media");
        tokio::fs::create_dir_all(&cache).await.unwrap();
        tokio::fs::write(cache.join("preview"), b"decrypted")
            .await
            .unwrap();

        clear_push_media(store_dir.path()).await;
        assert!(!cache.exists());
        clear_push_media(store_dir.path()).await;
    }
}
