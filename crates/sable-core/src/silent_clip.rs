//! A short video without sound plays as a GIF. Giphy and Telegram send GIFs
//! as silent MP4s, and mautrix bridges flag them with the same `fi.mau.*` keys.

use std::io::Cursor;

use matroska_demuxer::{MatroskaFile, TrackType};
use mp4_atom::{Atom, Buf, Decode, FourCC, Hdlr, Header, Mdia, Moov, Trak};

/// Past these, a silent video is more likely a screen recording than a GIF.
/// Telegram Desktop uses the same size limit.
const GIF_MAX_DURATION_MS: u32 = 60_000;
const GIF_MAX_BYTES: usize = 10 * 1024 * 1024;
const EBML_MAGIC: [u8; 4] = [0x1a, 0x45, 0xdf, 0xa3];

/// The mautrix keys that make a video autoplay and loop without controls.
pub(crate) fn gif_flags() -> serde_json::Map<String, serde_json::Value> {
    [
        "fi.mau.gif",
        "fi.mau.loop",
        "fi.mau.autoplay",
        "fi.mau.hide_controls",
        "fi.mau.no_audio",
    ]
    .into_iter()
    .map(|key| (key.to_owned(), serde_json::Value::Bool(true)))
    .collect()
}

pub(crate) fn plays_as_gif(bytes: &[u8], duration_ms: Option<u32>) -> bool {
    bytes.len() <= GIF_MAX_BYTES
        && duration_ms.is_some_and(|ms| ms <= GIF_MAX_DURATION_MS)
        && tracks(bytes).is_some_and(|tracks| tracks.video && !tracks.audio)
}

#[derive(Default)]
struct Tracks {
    video: bool,
    audio: bool,
}

fn tracks(bytes: &[u8]) -> Option<Tracks> {
    if bytes.get(4..8) == Some(b"ftyp".as_slice()) {
        mp4_tracks(bytes)
    } else if bytes.starts_with(&EBML_MAGIC) {
        matroska_tracks(bytes)
    } else {
        None
    }
}

fn mp4_tracks(bytes: &[u8]) -> Option<Tracks> {
    let mut tracks = Tracks::default();
    for (kind, trak) in boxes(child(bytes, Moov::KIND)?)? {
        if kind != Trak::KIND {
            continue;
        }
        let mut hdlr = child(child(trak, Mdia::KIND)?, Hdlr::KIND)?;
        let handler = Hdlr::decode_body(&mut hdlr).ok()?.handler;
        tracks.video |= handler == FourCC::new(b"vide");
        tracks.audio |= handler == FourCC::new(b"soun");
    }
    Some(tracks)
}

/// Only headers are decoded, so a box this crate cannot parse elsewhere in the
/// file does not hide the tracks.
fn boxes(mut buf: &[u8]) -> Option<Vec<(FourCC, &[u8])>> {
    let mut boxes = Vec::new();
    while buf.has_remaining() {
        let header = Header::decode(&mut buf).ok()?;
        let size = header.size.unwrap_or(buf.len());
        boxes.push((header.kind, buf.get(..size)?));
        buf.advance(size);
    }
    Some(boxes)
}

fn child(buf: &[u8], kind: FourCC) -> Option<&[u8]> {
    boxes(buf)?
        .into_iter()
        .find_map(|(found, body)| (found == kind).then_some(body))
}

fn matroska_tracks(bytes: &[u8]) -> Option<Tracks> {
    let file = MatroskaFile::open(Cursor::new(bytes)).ok()?;
    let mut tracks = Tracks::default();
    for track in file.tracks() {
        tracks.video |= track.track_type() == TrackType::Video;
        tracks.audio |= track.track_type() == TrackType::Audio;
    }
    Some(tracks)
}

#[cfg(test)]
mod tests {
    use super::{plays_as_gif, tracks};

    macro_rules! clip {
        ($name:literal) => {
            include_bytes!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/clips/",
                $name
            ))
            .as_slice()
        };
    }

    #[test]
    fn reads_the_tracks_of_each_container() {
        for (name, clip, audio) in [
            ("silent.mp4", clip!("silent.mp4"), false),
            ("sound.mp4", clip!("sound.mp4"), true),
            ("fragmented.mp4", clip!("fragmented.mp4"), false),
            ("silent.mov", clip!("silent.mov"), false),
            ("silent.webm", clip!("silent.webm"), false),
            ("sound.webm", clip!("sound.webm"), true),
            ("live.webm", clip!("live.webm"), false),
        ] {
            let tracks = tracks(clip).unwrap_or_else(|| panic!("{name} parses"));
            assert!(tracks.video, "{name} has video");
            assert_eq!(tracks.audio, audio, "{name} audio");
        }
    }

    #[test]
    fn only_a_short_silent_video_plays_as_a_gif() {
        assert!(plays_as_gif(clip!("silent.mp4"), Some(300)));
        assert!(!plays_as_gif(clip!("sound.mp4"), Some(300)));
        assert!(!plays_as_gif(clip!("silent.mp4"), Some(60_001)));
        assert!(!plays_as_gif(clip!("silent.mp4"), None));
    }

    #[test]
    fn a_large_silent_video_stays_a_video() {
        let mut large = clip!("silent.mp4").to_vec();
        large.extend_from_slice(b"\0\0\0\x08free");
        large.resize(10 * 1024 * 1024 + 1, 0);
        assert!(!plays_as_gif(&large, Some(300)));
    }

    #[test]
    fn a_truncated_or_unknown_file_stays_a_video() {
        let silent = clip!("silent.mp4");
        assert!(!plays_as_gif(&silent[..silent.len() - 10], Some(300)));
        assert!(!plays_as_gif(&clip!("silent.webm")[..40], Some(300)));
        assert!(!plays_as_gif(b"\0\0\0\x08ftyp", Some(300)));
        assert!(!plays_as_gif(&[0; 64], Some(300)));
    }
}
