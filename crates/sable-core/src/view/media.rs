use matrix_sdk::ruma::UInt;
use matrix_sdk::ruma::events::room::message::VideoInfo;
use matrix_sdk::ruma::events::room::message::{
    AudioMessageEventContent, GalleryItemType, GalleryMessageEventContent, UnstableAmplitude,
};
use matrix_sdk::ruma::events::room::{ImageInfo, MediaSource};
use serde::Deserialize as _;
use serde_with::{DefaultOnError, serde_as};

use crate::matrix_html::{display_html, strip_profile_fallback_body, strip_profile_fallback_html};
use crate::protocol::{
    AudioMetadataView, GalleryItemView, PerMessageProfileView, VideoPlaybackView,
};

use super::raw::ObjectOnly;

/// `media.rs` reads a bare string back as a plain mxc URI, so the common case
/// skips the serializer and the wrapper object.
pub(crate) fn media_source(source: &MediaSource) -> String {
    match source {
        MediaSource::Plain(uri) => uri.as_str().to_owned(),
        encrypted @ MediaSource::Encrypted(_) => {
            serde_json::to_string(encrypted).unwrap_or_default()
        }
    }
}

pub(crate) fn image_thumbnail(info: &ImageInfo) -> Option<String> {
    info.thumbnail_source.as_ref().map(media_source)
}

pub(crate) fn video_thumbnail(info: &VideoInfo) -> Option<String> {
    info.thumbnail_source.as_ref().map(media_source)
}

pub(super) fn gallery_item(
    item: &GalleryItemType,
    spoiler: Option<String>,
) -> Option<GalleryItemView> {
    let dimension = |value: Option<UInt>| value.map(u64::from);
    let caption = |caption: Option<&str>| caption.map(ToOwned::to_owned);

    Some(match item {
        GalleryItemType::Image(image) => GalleryItemView::Image {
            filename: image.filename().to_owned(),
            caption: caption(image.caption()),
            source: media_source(&image.source),
            mime: image.info.as_ref().and_then(|info| info.mimetype.clone()),
            width: dimension(image.info.as_ref().and_then(|info| info.width)),
            height: dimension(image.info.as_ref().and_then(|info| info.height)),
            size: dimension(image.info.as_ref().and_then(|info| info.size)),
            blurhash: image.info.as_ref().and_then(|info| info.blurhash.clone()),
            thumbnail: image.info.as_deref().and_then(image_thumbnail),
            spoiler,
        },
        GalleryItemType::Video(video) => GalleryItemView::Video {
            filename: video.filename().to_owned(),
            caption: caption(video.caption()),
            source: media_source(&video.source),
            mime: video.info.as_ref().and_then(|info| info.mimetype.clone()),
            width: dimension(video.info.as_ref().and_then(|info| info.width)),
            height: dimension(video.info.as_ref().and_then(|info| info.height)),
            blurhash: video.info.as_ref().and_then(|info| info.blurhash.clone()),
            thumbnail: video.info.as_deref().and_then(video_thumbnail),
            spoiler,
        },
        GalleryItemType::Audio(audio) => GalleryItemView::Audio {
            filename: audio.filename().to_owned(),
            caption: caption(audio.caption()),
            source: media_source(&audio.source),
            mime: audio.info.as_ref().and_then(|info| info.mimetype.clone()),
            duration_ms: audio_duration_ms(audio),
            waveform: audio_waveform(audio),
        },
        GalleryItemType::File(file) => GalleryItemView::File {
            filename: file.filename().to_owned(),
            caption: caption(file.caption()),
            source: media_source(&file.source),
            mime: file.info.as_ref().and_then(|info| info.mimetype.clone()),
            size: dimension(file.info.as_ref().and_then(|info| info.size)),
        },
        // The caption already describes the set, so an unrenderable item is
        // dropped instead of leaving a gap.
        _ => return None,
    })
}

pub(crate) fn gallery_filenames(gallery: &GalleryMessageEventContent) -> Vec<&str> {
    gallery
        .itemtypes
        .iter()
        .filter_map(|item| match item {
            GalleryItemType::Image(image) => Some(image.filename()),
            GalleryItemType::Video(video) => Some(video.filename()),
            GalleryItemType::Audio(audio) => Some(audio.filename()),
            GalleryItemType::File(file) => Some(file.filename()),
            _ => None,
        })
        .collect()
}

pub(super) fn audio_duration_ms(audio: &AudioMessageEventContent) -> Option<u64> {
    audio
        .audio
        .as_ref()
        .map(|details| details.duration)
        .or_else(|| audio.info.as_ref().and_then(|info| info.duration))
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

pub(super) fn audio_waveform(audio: &AudioMessageEventContent) -> Option<Vec<f32>> {
    audio.audio.as_ref().map(|details| {
        details
            .waveform
            .iter()
            .map(|amplitude| {
                let value = u64::from(amplitude.get());
                #[expect(
                    clippy::cast_precision_loss,
                    reason = "lossy conversion is display-only"
                )]
                let normalised = value as f32 / f32::from(UnstableAmplitude::MAX);
                normalised
            })
            .collect()
    })
}

pub(crate) const SPOILER_PROPERTY: &str = "page.codeberg.everypizza.msc4193.spoiler";
pub(crate) const SPOILER_REASON_PROPERTY: &str = "page.codeberg.everypizza.msc4193.spoiler.reason";

const AUDIO_METADATA_MAX_CHARS: usize = 256;

const BLURHASH_MAX_CHARS: usize = 128;

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct AudioInfoIn {
    #[serde_as(as = "ObjectOnly")]
    audio_metadata: Option<AudioMetadataIn>,
    #[serde_as(as = "ObjectOnly")]
    #[serde(rename = "org.matrix.msc4549.audio_metadata")]
    unstable_audio_metadata: Option<AudioMetadataIn>,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct AudioMetadataIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    title: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    artist: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    album: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    cover_art_blurhash: Option<String>,
}

pub(crate) fn audio_metadata(content: Option<&serde_json::Value>) -> Option<AudioMetadataView> {
    let info = content?.get("info").filter(|info| info.is_object())?;
    let info = AudioInfoIn::deserialize(info).ok()?;
    let metadata = info.audio_metadata.or(info.unstable_audio_metadata)?;
    let text = |value: Option<String>, limit: usize| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.chars().count() <= limit)
            .map(str::to_owned)
    };
    let view = AudioMetadataView {
        title: text(metadata.title, AUDIO_METADATA_MAX_CHARS),
        artist: text(metadata.artist, AUDIO_METADATA_MAX_CHARS),
        album: text(metadata.album, AUDIO_METADATA_MAX_CHARS),
        cover_art_blurhash: text(metadata.cover_art_blurhash, BLURHASH_MAX_CHARS),
    };
    (view.title.is_some()
        || view.artist.is_some()
        || view.album.is_some()
        || view.cover_art_blurhash.is_some())
    .then_some(view)
}

pub(crate) fn video_playback(content: Option<&serde_json::Value>) -> Option<VideoPlaybackView> {
    let info = content?.get("info")?.as_object()?;
    let flag = |name: &str| info.get(name).and_then(serde_json::Value::as_bool) == Some(true);
    let view = VideoPlaybackView {
        gif: flag("fi.mau.gif"),
        autoplay: flag("fi.mau.autoplay"),
        looping: flag("fi.mau.loop"),
        hide_controls: flag("fi.mau.hide_controls"),
        no_audio: flag("fi.mau.no_audio"),
    };
    (view.gif || view.autoplay || view.looping || view.hide_controls || view.no_audio)
        .then_some(view)
}

pub(crate) fn spoiler_reason(content: Option<&serde_json::Value>) -> Option<String> {
    let content = content?;
    if content.get(SPOILER_PROPERTY)?.as_bool() != Some(true) {
        return None;
    }
    Some(
        content
            .get(SPOILER_REASON_PROPERTY)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    )
}

/// Strips both fallback halves from a media caption, as for text messages.
pub(super) fn caption_view(
    caption: Option<&str>,
    formatted: Option<&matrix_sdk::ruma::events::room::message::FormattedBody>,
    profile: Option<&PerMessageProfileView>,
) -> (Option<String>, Option<String>) {
    let name = profile
        .filter(|profile| profile.has_fallback)
        .and_then(|profile| profile.display_name.as_deref());

    let caption = caption.map(|caption| strip_profile_fallback_body(caption, name));
    let html = match (formatted, caption.as_deref()) {
        (Some(formatted), caption) => {
            let html = strip_profile_fallback_html(&formatted.body, name);
            Some(display_html(caption.unwrap_or_default(), Some(&html)))
        }
        (None, Some(caption)) => Some(display_html(caption, None)),
        (None, None) => None,
    };
    (caption, html)
}

#[cfg(test)]
mod tests {
    use super::*;
    use matrix_sdk::ruma::events::room::message::FormattedBody;

    use serde_json::json;

    use crate::view::profile::per_message_profile;

    #[test]
    fn audio_metadata_reads_msc4549_and_prefers_the_stable_key() {
        let unstable = audio_metadata(Some(&json!({"info": {
            "org.matrix.msc4549.audio_metadata": {
                "title": " Moonwalker ", "artist": "Jake Chudnow", "album": "",
                "cover_art_blurhash": "LBEpAr~VM{x[004:oyM|9GM|xtIU"
            }
        }})))
        .expect("metadata");
        assert_eq!(unstable.title.as_deref(), Some("Moonwalker"));
        assert_eq!(unstable.artist.as_deref(), Some("Jake Chudnow"));
        assert_eq!(unstable.album, None);
        assert_eq!(
            unstable.cover_art_blurhash.as_deref(),
            Some("LBEpAr~VM{x[004:oyM|9GM|xtIU")
        );

        let both = audio_metadata(Some(&json!({"info": {
            "audio_metadata": {"title": "Stable"},
            "org.matrix.msc4549.audio_metadata": {"title": "Unstable"}
        }})))
        .expect("metadata");
        assert_eq!(both.title.as_deref(), Some("Stable"));

        assert!(audio_metadata(Some(&json!({"info": {"audio_metadata": {"title": 5}}}))).is_none());
        assert!(audio_metadata(Some(&json!({"info": {}}))).is_none());
    }

    #[test]
    fn video_playback_reads_the_mautrix_flags() {
        let gif = video_playback(Some(&json!({"info": {
            "fi.mau.gif": true, "fi.mau.loop": true, "fi.mau.no_audio": true,
            "fi.mau.hide_controls": true, "fi.mau.autoplay": true
        }})))
        .expect("playback");
        assert!(gif.gif && gif.looping && gif.no_audio && gif.hide_controls && gif.autoplay);

        assert!(video_playback(Some(&json!({"info": {"fi.mau.gif": "yes"}}))).is_none());
        assert!(video_playback(Some(&json!({"info": {"mimetype": "video/mp4"}}))).is_none());
    }

    #[test]
    fn formatted_attachment_captions_are_sanitised_for_display() {
        let (_, html) = caption_view(
            Some("hi Ana party"),
            Some(&FormattedBody::html(
                "<a href=\"https://matrix.to/#/@ana:example.org\">Ana</a> <img src=\"mxc://example.org/party\" alt=\"party\" data-mx-emoticon><script>steal()</script>",
            )),
            None,
        );
        let html = html.expect("a formatted caption maps to display HTML");

        assert!(html.contains("href=\"https://matrix.to/#/@ana:example.org\""));
        assert!(html.contains("src=\"mxc://example.org/party\""));
        assert!(html.contains("data-mx-emoticon"));
        assert!(!html.contains("script"));
        assert!(caption_view(None, None, None).1.is_none());
    }

    #[test]
    fn strips_a_per_message_profile_fallback_from_media_captions() {
        let profile = per_message_profile(Some(&json!({
            "m.per_message_profile": {
                "displayname": "Josie",
                "has_fallback": true,
            },
        })))
        .expect("a profile");
        let (caption, html) = caption_view(
            Some("Josie: you can still see the fallback on this message"),
            Some(&FormattedBody::html(
                "<strong data-mx-profile-fallback>Josie: </strong>you can still see the fallback on this message",
            )),
            Some(&profile),
        );

        assert_eq!(
            caption.as_deref(),
            Some("you can still see the fallback on this message")
        );
        let html = html.expect("a formatted caption maps to display HTML");
        assert!(html.contains("this message"));
        assert!(!html.contains("Josie"));
    }

    #[test]
    fn a_caption_fallback_is_stripped_from_the_plain_body_alone() {
        let profile = per_message_profile(Some(&json!({
            "m.per_message_profile": {
                "displayname": "Josie",
                "has_fallback": true,
            },
        })))
        .expect("a profile");
        let (caption, html) = caption_view(
            Some("Josie: you can still see the fallback on this message"),
            None,
            Some(&profile),
        );

        assert_eq!(
            caption.as_deref(),
            Some("you can still see the fallback on this message")
        );
        assert_eq!(
            html.as_deref(),
            Some("<span data-plain-body>you can still see the fallback on this message</span>")
        );
    }

    #[test]
    fn a_plain_caption_marks_room_mentions() {
        let (_, html) = caption_view(Some("@room look"), None, None);

        assert!(html.is_some_and(|html| html.contains("data-mx-room-mention")));
    }

    // The event reported in the issue: an image whose `formatted_body` is
    // plain text with a bare "josiejosie: " prefix and no strong wrapper.
    #[test]
    fn strips_a_bare_prefix_fallback_from_an_image_caption() {
        let profile = per_message_profile(Some(&json!({
            "m.per_message_profile": {
                "displayname": "josiejosie",
                "has_fallback": true,
            },
        })))
        .expect("a profile");
        let (caption, html) = caption_view(
            Some("josiejosie: you can still see the fallback on this message"),
            Some(&FormattedBody::html(
                "josiejosie: you can still see the fallback on this message",
            )),
            Some(&profile),
        );

        assert_eq!(
            caption.as_deref(),
            Some("you can still see the fallback on this message")
        );
        let html = html.expect("a formatted caption maps to display HTML");
        assert!(html.contains("you can still see the fallback on this message"));
        assert!(!html.contains("josiejosie"));
    }
}
