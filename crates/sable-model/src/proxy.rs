/// The body a persona trigger leaves, or `None` when `body` does not use it.
#[must_use]
pub fn proxy_body(
    prefix: Option<&str>,
    suffix: Option<&str>,
    keep_trigger: bool,
    body: &str,
) -> Option<String> {
    let prefix = prefix.unwrap_or_default();
    let suffix = suffix.unwrap_or_default();
    if prefix.is_empty() && suffix.is_empty() {
        return None;
    }
    let inner = body.strip_prefix(prefix)?.strip_suffix(suffix)?;
    Some(if keep_trigger { body } else { inner.trim() }.to_owned())
}

#[cfg(test)]
mod tests {
    use super::proxy_body;

    #[test]
    fn a_prefix_trigger_is_stripped_and_trimmed() {
        assert_eq!(
            proxy_body(Some("a:"), None, false, "a: hello"),
            Some("hello".to_owned())
        );
    }

    #[test]
    fn a_wrapping_trigger_needs_both_ends() {
        assert_eq!(
            proxy_body(Some("["), Some("]"), false, "[hi]"),
            Some("hi".to_owned())
        );
        assert_eq!(proxy_body(Some("["), Some("]"), false, "[hi"), None);
    }

    #[test]
    fn a_kept_trigger_leaves_the_body_whole() {
        assert_eq!(
            proxy_body(Some("a:"), None, true, "a: hi"),
            Some("a: hi".to_owned())
        );
    }

    #[test]
    fn an_empty_trigger_never_matches() {
        assert_eq!(proxy_body(None, Some(""), false, "hi"), None);
    }

    #[test]
    fn overlapping_ends_do_not_match() {
        assert_eq!(proxy_body(Some("ab"), Some("ba"), false, "aba"), None);
    }
}
