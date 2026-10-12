//! Link destinations as markdown-it's `normalizeLink` and `validateLink`
//! leave them.

use std::fmt::Write as _;

use crate::text::{head, span, tail, trim};

/// markdown-it's `validateLink`.
pub(super) fn valid_link(href: &str) -> bool {
    let lower = trim(href).to_ascii_lowercase();
    let bad = ["vbscript:", "javascript:", "file:", "data:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme));
    !bad || [
        "data:image/gif;",
        "data:image/png;",
        "data:image/jpeg;",
        "data:image/webp;",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

/// Gives an http(s) link with a non-ASCII host that host in punycode, as markdown-it's `normalizeLink` does.
fn punycode_host(href: &str) -> String {
    const NOT_HOST: &[char] = &[
        '%', '/', '?', ';', '#', '{', '}', '|', '\\', '^', '`', '<', '>', '"', ' ', '\r', '\n',
        '\t', '\'',
    ];
    let lower = href.to_ascii_lowercase();
    let Some(scheme) = ["http://", "https://"]
        .into_iter()
        .find(|scheme| lower.starts_with(scheme))
    else {
        return href.to_owned();
    };
    let rest = tail(href, scheme.len());
    let authority = rest
        .find(['/', '?', '#'])
        .map_or(rest, |end| head(rest, end));
    let host_start = scheme.len() + authority.rfind('@').map_or(0, |at| at + 1);
    let host = tail(href, host_start);
    let mut host_end = host_start + host.find(NOT_HOST).unwrap_or(host.len());
    if head(href, host_end).ends_with(':') {
        host_end -= 1;
    }
    let host = span(href, host_start, host_end);
    if let Some(colon) = host.rfind(':')
        && tail(host, colon + 1)
            .bytes()
            .all(|byte| byte.is_ascii_digit())
    {
        host_end = host_start + colon;
    }
    let host_end =
        hostname_end(span(href, host_start, host_end)).map_or(host_end, |end| host_start + end);
    let hostname = span(href, host_start, host_end);
    if hostname.is_ascii() {
        return href.to_owned();
    }
    let labels: Option<Vec<String>> = hostname
        .split('.')
        .map(|label| {
            if label.is_ascii() {
                Some(label.to_owned())
            } else {
                idna::punycode::encode_str(label).map(|encoded| format!("xn--{encoded}"))
            }
        })
        .collect();
    labels.map_or_else(
        || href.to_owned(),
        |labels| {
            format!(
                "{}{}{}",
                head(href, host_start),
                labels.join("."),
                tail(href, host_end)
            )
        },
    )
}

/// Where mdurl ends a hostname: at the first label that, with every non-ASCII
/// character counted as a letter, is not `[+A-Za-z0-9_-]{0,63}`, after that
/// label's ASCII start.
fn hostname_end(host: &str) -> Option<usize> {
    let part = |c: char| c.is_ascii_alphanumeric() || matches!(c, '+' | '_' | '-');
    let mut start = 0;
    for label in host.split('.') {
        let valid = label.chars().count() <= 63 && label.chars().all(|c| !c.is_ascii() || part(c));
        if !valid {
            return Some(start + label.chars().take_while(|c| part(*c)).count());
        }
        start += label.len() + 1;
    }
    None
}

/// markdown-it's `normalizeLink`: the host in punycode, then whatever
/// `mdurl.encode` would percent-encode, keeping existing escapes.
pub(super) fn normalize_link(href: &str) -> String {
    const KEEP: &str = ";/?:@&=+$,-_.!~*'()#";
    let href = &punycode_host(href);
    let mut out = String::with_capacity(href.len());
    let bytes = href.as_bytes();
    for (at, c) in href.char_indices() {
        let escaped = c == '%'
            && bytes.get(at + 1).is_some_and(u8::is_ascii_hexdigit)
            && bytes.get(at + 2).is_some_and(u8::is_ascii_hexdigit);
        if c.is_ascii_alphanumeric() || KEEP.contains(c) || escaped {
            out.push(c);
        } else {
            let mut buffer = [0; 4];
            for byte in c.encode_utf8(&mut buffer).bytes() {
                let _ = write!(out, "%{byte:02X}");
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_encoded_and_unsafe_schemes_refused() {
        assert_eq!(
            normalize_link("https://x.org/ä b%20"),
            "https://x.org/%C3%A4%20b%20"
        );
        assert!(!valid_link("JavaScript:alert(1)"));
        assert!(valid_link("data:image/png;base64,AA"));
    }
}
