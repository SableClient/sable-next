//! How large to draw a message made of nothing but emoji or inline emotes.

use icu_properties::{
    CodePointSetData,
    props::{EmojiComponent, EmojiPresentation, ExtendedPictographic},
};
use ruma_html::{Html, NodeData, NodeRef};
use unicode_segmentation::UnicodeSegmentation;

use crate::html::nests_too_deeply;
use crate::text::{is_space, trim};

const JUMBO_MAX: usize = 8;
const KEYCAP: char = '\u{20E3}';
const REGIONAL_INDICATORS: std::ops::RangeInclusive<char> = '\u{1F1E6}'..='\u{1F1FF}';

const fn level(count: usize) -> Option<u8> {
    match count {
        1 => Some(1),
        2 => Some(2),
        3 | 4 => Some(3),
        5..=JUMBO_MAX => Some(4),
        _ => None,
    }
}

/// A body of only emoji and whitespace. Every grapheme must be a pictograph,
/// a keycap or a flag, so a bare digit next to an emoji keeps the normal size.
#[must_use]
pub fn emoji_level(body: &str) -> Option<u8> {
    let extended_pictographic = CodePointSetData::new::<ExtendedPictographic>();
    let emoji_component = CodePointSetData::new::<EmojiComponent>();
    let mut count = 0;
    for grapheme in trim(body).graphemes(true) {
        if grapheme.chars().all(is_space) {
            continue;
        }
        let emoji = grapheme
            .chars()
            .all(|c| extended_pictographic.contains(c) || emoji_component.contains(c))
            && grapheme.chars().any(|c| {
                extended_pictographic.contains(c) || c == KEYCAP || REGIONAL_INDICATORS.contains(&c)
            });
        if !emoji {
            return None;
        }
        count += 1;
    }
    level(count)
}

/// Byte ranges of the runs of emoji graphemes in `text`. Symbols that default
/// to text presentation, like `©`, only count with a variation selector.
#[must_use]
pub fn emoji_runs(text: &str) -> Vec<(usize, usize)> {
    const VARIATION_SELECTOR_16: char = '\u{FE0F}';
    let presentation = CodePointSetData::new::<EmojiPresentation>();
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for (start, grapheme) in text.grapheme_indices(true) {
        let emoji = grapheme
            .chars()
            .any(|c| presentation.contains(c) || c == VARIATION_SELECTOR_16 || c == KEYCAP);
        if !emoji {
            continue;
        }
        let end = start + grapheme.len();
        match runs.last_mut() {
            Some(run) if run.1 == start => run.1 = end,
            _ => runs.push((start, end)),
        }
    }
    runs
}

fn blank(node: &NodeRef) -> bool {
    node.as_text()
        .is_some_and(|text| text.borrow().chars().all(is_space))
}

/// A formatted body of inline `mxc:` emotes only, separated by nothing but
/// whitespace and line breaks, sized by how many emotes it holds.
#[must_use]
pub fn emoticon_level(html: &str) -> Option<u8> {
    if nests_too_deeply(html) {
        return None;
    }
    let html = Html::parse(html);
    let mut nodes: Vec<_> = html.children().filter(|node| !blank(node)).collect();
    if let [paragraph] = nodes.as_slice()
        && paragraph
            .as_element()
            .is_some_and(|element| element.name.local.as_ref() == "p")
    {
        nodes = paragraph.children().filter(|node| !blank(node)).collect();
    }
    let mut images = 0;
    for node in nodes {
        match node.data() {
            NodeData::Element(element) if element.name.local.as_ref() == "br" => {}
            NodeData::Element(element)
                if element.name.local.as_ref() == "img"
                    && element.attrs.borrow().iter().any(|attribute| {
                        attribute.name.local.as_ref() == "src"
                            && attribute
                                .value
                                .get(..4)
                                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("mxc:"))
                    }) =>
            {
                images += 1;
                if images > JUMBO_MAX {
                    return None;
                }
            }
            _ => return None,
        }
    }
    level(images)
}

#[cfg(test)]
mod tests {
    use super::{emoji_level, emoji_runs, emoticon_level};

    fn runs(text: &str) -> Vec<&str> {
        emoji_runs(text)
            .into_iter()
            .filter_map(|(start, end)| text.get(start..end))
            .collect()
    }

    #[test]
    fn emoji_runs_group_adjacent_emoji_graphemes() {
        assert_eq!(runs("hi 👍🎉 there 🔥"), ["👍🎉", "🔥"]);
        assert_eq!(runs("a 👍🏽 b"), ["👍🏽"]);
        assert_eq!(runs("a 👨‍👩‍👧 b 🇫🇷 c 1️⃣ d ❤️"), ["👨‍👩‍👧", "🇫🇷", "1️⃣", "❤️"]);
    }

    #[test]
    fn emoji_runs_skip_text_symbols_and_digits() {
        assert_eq!(runs("© ™ 1 # * 2024"), Vec::<&str>::new());
    }

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
        assert_eq!(emoji_level("🇫🇷 1️⃣"), Some(2));
    }

    #[test]
    fn ordinary_text_is_left_alone() {
        assert_eq!(emoji_level("nice 👍"), None);
        assert_eq!(emoji_level(""), None);
        assert_eq!(emoji_level("123"), None);
        assert_eq!(emoji_level("👍👍👍👍👍👍👍👍👍"), None);
        assert_eq!(emoji_level("1👍"), None);
        assert_eq!(emoji_level("2 🎉"), None);
        assert_eq!(emoji_level("#👍"), None);
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

    #[test]
    fn html_parsing_distinguishes_image_sources_from_other_attributes() {
        assert_eq!(emoticon_level("<P><IMG SRC = mxc://a/rotate></P>"), Some(1));
        for html in [
            "<img data-src=\"mxc://a/rotate\">",
            "<img alt=\"src='mxc://a/rotate'\" src=\"https://example.org/photo\">",
            "<p><img src=\"mxc://a/rotate\"></p><p><img src=\"mxc://a/spin\"></p>",
        ] {
            assert_eq!(emoticon_level(html), None, "{html}");
        }
    }

    #[test]
    fn deeply_nested_markup_is_rejected_before_building_a_tree() {
        let html = format!("{}{}", "<div>".repeat(20_000), emote("rotate"));
        assert_eq!(emoticon_level(&html), None);
    }
}
