use crate::tokenize::is_unspaced;

/// A match may not start or end inside a word, so `mute` skips `mutex`.
#[must_use]
pub fn contains_whole(text: &str, wanted: &str) -> bool {
    text.match_indices(wanted).any(|(start, found)| {
        let before = text.get(..start).and_then(|head| head.chars().next_back());
        let after = text
            .get(start + found.len()..)
            .and_then(|tail| tail.chars().next());
        !joined(before, wanted.chars().next()) && !joined(wanted.chars().next_back(), after)
    })
}

fn joined(left: Option<char>, right: Option<char>) -> bool {
    left.zip(right)
        .is_some_and(|(left, right)| spaced_letter(left) && spaced_letter(right))
}

/// Scripts written without spaces have no word edge to respect.
fn spaced_letter(character: char) -> bool {
    character.is_alphanumeric() && !is_unspaced(character)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_quoted_or_excluded_term_matches_whole_words() {
        assert!(super::contains_whole("so i mute it", "mute"));
        assert!(super::contains_whole("mute.", "mute"));
        assert!(!super::contains_whole("a tokio mutex", "mute"));
        assert!(!super::contains_whole("unmute it", "mute"));
        assert!(super::contains_whole(
            "the pipeline is broken",
            "pipeline is"
        ));
        assert!(super::contains_whole("read the c++ guide", "c++"));
        assert!(super::contains_whole("検索を使う", "検索"));
        assert!(super::contains_whole("สวัสดีครับ", "สวัสดี"));
    }
}
