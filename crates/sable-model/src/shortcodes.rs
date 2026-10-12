//! MSC2545 shortcodes: the grammar, and turning a file name or a typed label
//! into one that fits it.

use std::collections::HashSet;

/// MSC2545 caps a shortcode at 100 bytes; only ASCII survives normalising.
pub const MAX_SHORTCODE_LENGTH: usize = 100;

const fn is_shortcode_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

#[must_use]
pub fn normalize_shortcode(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .filter(|c| is_shortcode_char(*c))
        .take(MAX_SHORTCODE_LENGTH)
        .collect()
}

#[must_use]
pub fn unique_shortcode(shortcode: &str, taken: impl Fn(&str) -> bool) -> String {
    let base = match normalize_shortcode(shortcode) {
        normalized if normalized.is_empty() => "image".to_owned(),
        normalized => normalized,
    };
    if !taken(&base) {
        return base;
    }
    let mut index = 1_u32;
    loop {
        let suffix = format!("-{index}");
        let keep = MAX_SHORTCODE_LENGTH.saturating_sub(suffix.len());
        let candidate = format!("{}{suffix}", base.chars().take(keep).collect::<String>());
        if !taken(&candidate) {
            return candidate;
        }
        index += 1;
    }
}

#[must_use]
pub fn is_valid_shortcode(shortcode: &str) -> bool {
    !shortcode.is_empty()
        && shortcode.len() <= MAX_SHORTCODE_LENGTH
        && shortcode.chars().all(is_shortcode_char)
}

/// The first shortcode that is malformed or used twice.
pub fn invalid_shortcode<'a>(shortcodes: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let mut seen = HashSet::new();
    shortcodes
        .into_iter()
        .find(|shortcode| !is_valid_shortcode(shortcode) || !seen.insert(*shortcode))
}

/// A file name without its extension; a leading dot is not one.
#[must_use]
pub fn shortcode_without_extension(file_name: &str) -> &str {
    match file_name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem,
        _ => file_name,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        invalid_shortcode, normalize_shortcode, shortcode_without_extension, unique_shortcode,
    };

    #[test]
    fn normalising_keeps_only_the_msc2545_grammar() {
        assert_eq!(normalize_shortcode("  party parrot! "), "party-parrot");
        assert_eq!(normalize_shortcode(" :blob wave: "), "blob-wave");
        assert_eq!(normalize_shortcode("blob😀"), "blob");
        assert_eq!(normalize_shortcode("  "), "");
        assert_eq!(normalize_shortcode(&"a".repeat(120)).len(), 100);
    }

    #[test]
    fn a_taken_shortcode_gets_a_suffix_within_the_limit() {
        assert_eq!(unique_shortcode("cat", |_| false), "cat");
        assert_eq!(
            unique_shortcode("cat", |c| c == "cat" || c == "cat-1"),
            "cat-2"
        );
        assert_eq!(unique_shortcode("!!", |_| false), "image");
        assert_eq!(unique_shortcode("", |c| c == "image"), "image-1");
        let long = "a".repeat(100);
        let renamed = unique_shortcode(&long, |c| c == long);
        assert_eq!(renamed.len(), 100);
        assert!(renamed.ends_with("-1"));
    }

    #[test]
    fn a_malformed_or_repeated_shortcode_is_reported() {
        assert_eq!(invalid_shortcode(["ok"]), None);
        assert_eq!(invalid_shortcode(["no space"]), Some("no space"));
        assert_eq!(invalid_shortcode(["dup", "dup"]), Some("dup"));
        assert_eq!(invalid_shortcode([""]), Some(""));
    }

    #[test]
    fn a_file_name_loses_its_extension() {
        assert_eq!(shortcode_without_extension("blob-wave.png"), "blob-wave");
        assert_eq!(shortcode_without_extension("noextension"), "noextension");
        assert_eq!(shortcode_without_extension(".hidden"), ".hidden");
    }
}
