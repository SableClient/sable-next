/// JavaScript's `\s`, which is not quite Unicode `White_Space`: the inputs this
/// crate parses were typed into the web page and split there before.
pub(crate) const fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

pub(crate) fn has_space(text: &str) -> bool {
    text.chars().any(is_space)
}

/// `text.split(/\s+/)` after a trim, with nothing for an empty string.
pub(crate) fn words(text: &str) -> Vec<&str> {
    text.split(is_space)
        .filter(|word| !word.is_empty())
        .collect()
}

pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

pub(crate) fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_space)
}

/// `text[from..]`, or nothing when `from` is not a boundary in it.
pub(crate) fn tail(text: &str, from: usize) -> &str {
    text.get(from..).unwrap_or_default()
}

/// `text[..to]`, or nothing when `to` is not a boundary in it.
pub(crate) fn head(text: &str, to: usize) -> &str {
    text.get(..to).unwrap_or_default()
}

/// `text[from..to]`, or nothing when either is not a boundary in it.
pub(crate) fn span(text: &str, from: usize, to: usize) -> &str {
    text.get(from..to).unwrap_or_default()
}
