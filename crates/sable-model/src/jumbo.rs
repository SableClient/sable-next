//! How large to draw a message made of nothing but emoji or inline emotes.

use unicode_segmentation::UnicodeSegmentation;

use crate::emoji_properties::{EMOJI_COMPONENT, EXTENDED_PICTOGRAPHIC};
use crate::text::{is_space, tail, trim};

const JUMBO_MAX: usize = 8;

fn has_property(table: &[(u32, u32)], c: char) -> bool {
    let code = u32::from(c);
    table
        .binary_search_by(|&(from, to)| {
            if to < code {
                std::cmp::Ordering::Less
            } else if from > code {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

const fn level(count: usize) -> Option<u8> {
    match count {
        1 => Some(1),
        2 => Some(2),
        3 | 4 => Some(3),
        5..=JUMBO_MAX => Some(4),
        _ => None,
    }
}

/// A body of only emoji and whitespace, with at least one pictographic character.
#[must_use]
pub fn emoji_level(body: &str) -> Option<u8> {
    let body = trim(body);
    let mut pictographic = false;
    for c in body.chars() {
        if has_property(EXTENDED_PICTOGRAPHIC, c) {
            pictographic = true;
        } else if !is_space(c) && !has_property(EMOJI_COMPONENT, c) {
            return None;
        }
    }
    if !pictographic {
        return None;
    }
    level(
        body.graphemes(true)
            .filter(|grapheme| !trim(grapheme).is_empty())
            .count(),
    )
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

const fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// The length of the tag `<name …>` opening `text`, quoted values included.
fn tag_length(text: &str, name: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let open = name.len() + 1;
    if bytes.first() != Some(&b'<') || !starts_with_ignore_case(tail(text, 1), name) {
        return None;
    }
    if bytes.get(open).copied().is_some_and(is_word_byte) {
        return None;
    }
    let mut at = open;
    while let Some(&byte) = bytes.get(at) {
        match byte {
            b'>' => return Some(at + 1),
            b'"' | b'\'' => {
                let close = tail(text, at + 1).find(char::from(byte))?;
                at += close + 2;
            }
            _ => at += 1,
        }
    }
    None
}

fn is_emote_source(tag: &str) -> bool {
    let bytes = tag.as_bytes();
    tag.char_indices().any(|(at, _)| {
        let bounded = at == 0 || bytes.get(at - 1).is_none_or(|&byte| !is_word_byte(byte));
        let rest = tail(tag, at);
        bounded
            && starts_with_ignore_case(rest, "src=")
            && matches!(rest.as_bytes().get(4), Some(b'"' | b'\''))
            && starts_with_ignore_case(tail(rest, 5), "mxc:")
    })
}

fn without_paragraph(html: &str) -> &str {
    let html = trim(html);
    let html = if starts_with_ignore_case(html, "<p") {
        html.find('>').map_or(html, |end| tail(html, end + 1))
    } else {
        html
    };
    html.len()
        .checked_sub(4)
        .and_then(|end| html.get(end..).zip(html.get(..end)))
        .filter(|(close, _)| close.eq_ignore_ascii_case("</p>"))
        .map_or(html, |(_, body)| body)
}

/// A formatted body of inline `mxc:` emotes only, separated by nothing but
/// whitespace and line breaks, sized by how many emotes it holds.
#[must_use]
pub fn emoticon_level(html: &str) -> Option<u8> {
    let html = without_paragraph(html);
    let mut images = 0;
    let mut at = 0;
    while let Some(rest) = html.get(at..).filter(|rest| !rest.is_empty()) {
        if let Some(length) = tag_length(rest, "img") {
            if !rest.get(..length).is_some_and(is_emote_source) {
                return None;
            }
            images += 1;
            if images > JUMBO_MAX {
                return None;
            }
            at += length;
        } else if let Some(length) = tag_length(rest, "br") {
            at += length;
        } else if starts_with_ignore_case(rest, "&nbsp;") || starts_with_ignore_case(rest, "&#160;")
        {
            at += 6;
        } else {
            let c = rest.chars().next().filter(|c| is_space(*c))?;
            at += c.len_utf8();
        }
    }
    level(images)
}

#[cfg(test)]
mod tests {
    use super::{emoji_level, emoticon_level};

    fn emote(name: &str) -> String {
        format!(r#"<img alt="{name}" height="32" src="mxc://example.org/{name}" title="{name}">"#)
    }

    #[test]
    fn emoji_bodies_are_sized_by_how_many_there_are() {
        assert_eq!(emoji_level("👍"), Some(1));
        assert_eq!(emoji_level("👍🎉"), Some(2));
        assert_eq!(emoji_level("👍🎉🔥"), Some(3));
        assert_eq!(emoji_level("👍🎉🔥😀😀"), Some(4));
        assert_eq!(emoji_level(" 👨‍👩‍👧 👍🏽 "), Some(2));
    }

    #[test]
    fn ordinary_text_is_left_alone() {
        assert_eq!(emoji_level("nice 👍"), None);
        assert_eq!(emoji_level(""), None);
        assert_eq!(emoji_level("123"), None);
        assert_eq!(emoji_level("👍👍👍👍👍👍👍👍👍"), None);
    }

    #[test]
    fn inline_emotes_are_sized_by_how_many_there_are() {
        assert_eq!(
            emoticon_level(
                r#"<img alt="rotate" height="32" src="mxc://a/rotate" title="rotate"> "#
            ),
            Some(1)
        );
        assert_eq!(
            emoticon_level(&format!("<p>{}</p>", emote("rotate"))),
            Some(1)
        );
        assert_eq!(
            emoticon_level(&format!("{}<br>{}", emote("rotate"), emote("spin"))),
            Some(2)
        );
        assert_eq!(
            emoticon_level(&format!("{} {}", emote("a"), emote("b"))),
            Some(2)
        );
        assert_eq!(
            emoticon_level(&["a", "b", "c", "d"].map(emote).join(" ")),
            Some(3)
        );
        assert_eq!(
            emoticon_level(r#"<img src="mxc://a/rotate" alt="a > b">"#),
            Some(1)
        );
        assert_eq!(
            emoticon_level(r#"<img src="mxc://a/rotate" alt=":rotate:">&nbsp;"#),
            Some(1)
        );
    }

    #[test]
    fn words_and_real_images_keep_the_normal_size() {
        assert_eq!(emoticon_level(&format!("nice {}", emote("rotate"))), None);
        assert_eq!(emoticon_level(""), None);
        assert_eq!(
            emoticon_level(r#"<img src="https://example.org/photo.png" width="640">"#),
            None
        );
        assert_eq!(
            emoticon_level(&format!(
                r#"{}<img src="https://example.org/photo.png">"#,
                emote("rotate")
            )),
            None
        );
        assert_eq!(
            emoticon_level(r#"<a href="https://example.org">link</a>"#),
            None
        );
        assert_eq!(
            emoticon_level(&format!("{} and words", emote("rotate"))),
            None
        );
        assert_eq!(emoticon_level(&vec![emote("rotate"); 9].join(" ")), None);
    }
}
