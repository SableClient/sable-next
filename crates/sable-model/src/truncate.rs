use unicode_segmentation::UnicodeSegmentation;

#[must_use]
pub fn truncate_graphemes(text: &str, max_bytes: usize) -> &str {
    let mut end = 0;
    for grapheme in text.graphemes(true) {
        if end + grapheme.len() > max_bytes {
            break;
        }
        end += grapheme.len();
    }
    text.get(..end).unwrap_or_default()
}

/// The longest prefix of `text` made of whole grapheme clusters and at most `max_chars` chars.
#[must_use]
pub fn truncate_graphemes_to_chars(text: &str, max_chars: usize) -> &str {
    let (mut end, mut chars) = (0, 0);
    for grapheme in text.graphemes(true) {
        chars += grapheme.chars().count();
        if chars > max_chars {
            break;
        }
        end += grapheme.len();
    }
    text.get(..end).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{truncate_graphemes, truncate_graphemes_to_chars};

    #[test]
    fn a_short_text_is_kept_whole() {
        assert_eq!(truncate_graphemes("hello", 5), "hello");
    }

    #[test]
    fn a_cut_never_lands_inside_a_character() {
        assert_eq!(truncate_graphemes("aé", 2), "a");
    }

    #[test]
    fn a_cut_never_splits_a_grapheme_cluster() {
        let family = "👨‍👩‍👧";
        assert_eq!(truncate_graphemes(&format!("a{family}"), family.len()), "a");
        assert_eq!(truncate_graphemes(family, family.len()), family);
    }

    #[test]
    fn a_char_budget_keeps_short_text_whole() {
        assert_eq!(truncate_graphemes_to_chars("héllo", 5), "héllo");
        assert_eq!(truncate_graphemes_to_chars("", 0), "");
    }

    #[test]
    fn a_char_budget_never_splits_a_grapheme_cluster() {
        for cluster in [
            "🇫🇷",
            "👩\u{200d}👩\u{200d}👧\u{200d}👦",
            "👍🏽",
            "1\u{fe0f}\u{20e3}",
            "e\u{301}",
        ] {
            let text = format!("ab{cluster}{cluster}");
            let size = cluster.chars().count();
            for budget in 2..2 + size {
                assert_eq!(
                    truncate_graphemes_to_chars(&text, budget),
                    "ab",
                    "{cluster:?} at {budget}"
                );
            }
            assert_eq!(
                truncate_graphemes_to_chars(&text, 2 + size),
                format!("ab{cluster}")
            );
            assert_eq!(
                truncate_graphemes_to_chars(&text, 1 + 2 * size),
                format!("ab{cluster}")
            );
        }
    }

    #[test]
    fn a_cluster_longer_than_the_char_budget_is_dropped_whole() {
        let cluster = format!("e{}", "\u{301}".repeat(130));
        assert_eq!(truncate_graphemes_to_chars(&format!("{cluster}a"), 120), "");
    }

    #[test]
    fn a_char_budget_cuts_flag_runs_between_flags() {
        let flags = "🇫🇷🇩🇪🇯🇵";
        assert_eq!(truncate_graphemes_to_chars(flags, 3), "🇫🇷");
        assert_eq!(truncate_graphemes_to_chars(flags, 4), "🇫🇷🇩🇪");
    }
}
