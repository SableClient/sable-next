//! Message bodies are untrusted, even when they came from our own homeserver.
//!
//! Everything the UI renders as HTML is produced here, so the view layer never
//! has to decide what is safe.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use ammonia::{Builder, UrlRelative};
use linkify::{LinkFinder, LinkKind};
use matrix_sdk::ruma::{MatrixUri, MxcUri};

const ALLOWED_TAGS: [&str; 35] = [
    "a",
    "b",
    "blockquote",
    "br",
    "caption",
    "code",
    "del",
    "details",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
];

/// `mx-reply` holds the quoted fallback, which the UI already renders from
/// `in_reply_to`; unwrapping any of these would surface sender-controlled text.
const STRIPPED_CONTENT_TAGS: [&str; 6] = [
    "mx-reply", "script", "style", "textarea", "option", "noscript",
];

const URL_SCHEMES: [&str; 7] = ["http", "https", "ftp", "mailto", "magnet", "matrix", "mxc"];

fn tag_attributes() -> HashMap<&'static str, HashSet<&'static str>> {
    HashMap::from([
        ("a", HashSet::from(["href"])),
        ("code", HashSet::from(["class"])),
        ("pre", HashSet::from(["class"])),
        ("ol", HashSet::from(["start"])),
        (
            "span",
            HashSet::from([
                "data-mx-bg-color",
                "data-mx-color",
                "data-mx-spoiler",
                "data-mx-maths",
            ]),
        ),
        ("div", HashSet::from(["data-mx-maths"])),
        (
            "img",
            HashSet::from(["src", "alt", "title", "width", "height", "data-mx-emoticon"]),
        ),
    ])
}

fn is_matrix_hex_color(value: &str) -> bool {
    let Some(digits) = value.strip_prefix('#') else {
        return false;
    };
    matches!(digits.len(), 3 | 6) && digits.bytes().all(|digit| digit.is_ascii_hexdigit())
}

fn is_language_class(value: &str) -> bool {
    let mut classes = value.split_whitespace().peekable();
    if classes.peek().is_none() {
        return false;
    }
    classes.all(|class| {
        class.strip_prefix("language-").is_some_and(|language| {
            !language.is_empty()
                && language
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        })
    })
}

fn sanitizer() -> Builder<'static> {
    let mut builder = Builder::new();
    builder
        .tags(HashSet::from(ALLOWED_TAGS))
        .tag_attributes(tag_attributes())
        .generic_attributes(HashSet::new())
        .clean_content_tags(HashSet::from(STRIPPED_CONTENT_TAGS))
        .url_schemes(HashSet::from(URL_SCHEMES))
        .url_relative(UrlRelative::Deny)
        .link_rel(Some("noreferrer noopener"))
        .attribute_filter(|element, attribute, value| match (element, attribute) {
            // A scheme-only check would admit `matrix:nonsense`, which the UI
            // would then style as a pill it cannot resolve.
            ("a", "href") if has_scheme(value, "matrix:") => {
                MatrixUri::parse(value).ok().map(|_| value.into())
            }
            // An `mxc:` link would navigate the webview to bytes it cannot load.
            ("a", "href") => (!has_scheme(value, "mxc:")).then(|| value.into()),
            ("img", "src") => {
                (is_mxc_uri(value) || has_scheme(value, "https:") || has_scheme(value, "http:"))
                    .then(|| value.into())
            }
            ("img", "width" | "height") | (_, "start") => value
                .parse::<u32>()
                .ok()
                .map(|number| number.to_string().into()),
            (_, "class") => is_language_class(value).then(|| value.into()),
            (_, "data-mx-color" | "data-mx-bg-color") => {
                is_matrix_hex_color(value).then(|| value.into())
            }
            _ => Some(value.into()),
        });
    builder
}

fn is_mxc_uri(value: &str) -> bool {
    has_scheme(value, "mxc:") && <&MxcUri>::from(value).parts().is_ok()
}

fn has_scheme(value: &str, scheme: &str) -> bool {
    value.len() >= scheme.len() && value[..scheme.len()].eq_ignore_ascii_case(scheme)
}

static PLAIN_TEXT_LINKS: LazyLock<LinkFinder> = LazyLock::new(|| {
    let mut finder = LinkFinder::new();
    finder.kinds(&[LinkKind::Url, LinkKind::Email]);
    finder
});

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

/// linkify only recognises schemes with an authority, so `matrix:u/alice:hs`
/// has to be spotted separately.
fn matrix_uri_spans(text: &str) -> Vec<(usize, usize)> {
    const TRAILING: [char; 9] = ['.', ',', ';', ':', '!', '?', ')', ']', '}'];
    // ASCII-only lowercasing keeps byte offsets aligned with `text`.
    let lowercase = text.to_ascii_lowercase();
    let mut spans = Vec::new();
    let mut search = 0;
    while let Some(offset) = lowercase[search..].find("matrix:") {
        let start = search + offset;
        let mut end = text[start..]
            .find(char::is_whitespace)
            .map_or(text.len(), |length| start + length);
        while end > start && text[start..end].ends_with(TRAILING) {
            end -= 1;
        }
        // A non-separator before the scheme means this is the tail of a longer token.
        let follows_text = text[..start].chars().next_back().is_some_and(|character| {
            !character.is_whitespace() && !matches!(character, '(' | '[' | '{' | '<' | '"' | '\'')
        });
        if !follows_text && MatrixUri::parse(&text[start..end]).is_ok() {
            spans.push((start, end));
        }
        search = end.max(start + "matrix:".len());
    }
    spans
}

fn anchor(href: &str, text: &str) -> String {
    format!(
        "<a href=\"{}\" rel=\"noreferrer noopener\">{}</a>",
        escape_html(href),
        escape_html(text)
    )
}

/// Escapes plain text and turns bare URLs, emails and Matrix URIs into links.
fn linkify_plain_text(text: &str) -> String {
    let mut spans: Vec<(usize, usize, bool)> = PLAIN_TEXT_LINKS
        .links(text)
        .map(|link| (link.start(), link.end(), link.kind() == &LinkKind::Email))
        .chain(
            matrix_uri_spans(text)
                .into_iter()
                .map(|(start, end)| (start, end, false)),
        )
        .collect();
    spans.sort_unstable();

    let mut html = String::with_capacity(text.len());
    let mut offset = 0;
    for (start, end, is_email) in spans {
        if start < offset {
            continue;
        }
        html.push_str(&escape_html(&text[offset..start]));
        let link = &text[start..end];
        if is_email {
            html.push_str(&anchor(&format!("mailto:{link}"), link));
        } else {
            html.push_str(&anchor(link, link));
        }
        offset = end;
    }
    html.push_str(&escape_html(&text[offset..]));
    html
}

/// MSC4144 senders prepend the profile name so clients that cannot read the
/// profile still show who spoke. Sable renders the profile itself, so leaving
/// the prefix in would print the name twice.
///
/// Must run before sanitising, which drops the marker attribute.
/// The leading `<strong>` element and the text it wraps, when there is one.
fn leading_strong(formatted: &str) -> Option<(&str, &str, usize)> {
    let trimmed = formatted.trim_start();
    let tag_end = trimmed.find('>')?;
    let open_tag = &trimmed[..=tag_end];
    if !open_tag.starts_with("<strong") {
        return None;
    }
    let close = trimmed[tag_end..].find("</strong>")?;
    let text = &trimmed[tag_end + 1..tag_end + close];
    let rest = tag_end + close + "</strong>".len();
    Some((open_tag, text, rest))
}

#[must_use]
pub fn has_profile_fallback_html(formatted: &str) -> bool {
    leading_strong(formatted)
        .is_some_and(|(open_tag, _, _)| open_tag.contains("data-mx-profile-fallback"))
}

/// Not every sender marks the element; some emit a bare `<strong>Name: </strong>`.
/// Matching the profile name, or `has_fallback` plus a trailing colon, catches
/// those without eating the sender's own emphasis.
#[must_use]
pub fn strip_profile_fallback_html(
    formatted: &str,
    display_name: Option<&str>,
    known: bool,
) -> String {
    let Some((open_tag, text, rest)) = leading_strong(formatted) else {
        return formatted.to_owned();
    };
    let label = text.trim().trim_end_matches(':').trim();
    let named = display_name
        .map(str::trim)
        .is_some_and(|name| !name.is_empty() && label == name);
    let marked = open_tag.contains("data-mx-profile-fallback");
    let fallback = marked || named || (known && text.trim_end().ends_with(':'));
    if fallback {
        formatted.trim_start()[rest..].trim_start().to_owned()
    } else {
        formatted.to_owned()
    }
}

/// The plain-text half of the same fallback, which arrives as `Name: `.
/// `known` comes from `has_fallback` or the HTML marker; without it only an
/// exact name match is removed, so a plain `Yes: it shipped` survives.
#[must_use]
pub fn strip_profile_fallback_body(body: &str, display_name: Option<&str>, known: bool) -> String {
    let name = display_name.map(str::trim).filter(|name| !name.is_empty());
    if let Some(stripped) = name.and_then(|name| body.strip_prefix(&format!("{name}: "))) {
        return stripped.to_owned();
    }
    if !known {
        return body.to_owned();
    }
    body.split_once(": ")
        .map_or_else(|| body.to_owned(), |(_, rest)| rest.to_owned())
}

/// The HTML the UI renders for a message: the sender's `formatted_body` once
/// sanitised, or the plain body linkified.
#[must_use]
pub fn display_html(body: &str, formatted: Option<&str>) -> String {
    let sanitized = formatted.map(|formatted| sanitizer().clean(formatted).to_string());
    // Markup rejected in full would otherwise leave the message blank.
    match sanitized {
        Some(html) if !html.trim().is_empty() => html,
        _ => linkify_plain_text(body),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        display_html, linkify_plain_text, strip_profile_fallback_body, strip_profile_fallback_html,
    };

    #[test]
    fn strips_the_per_message_profile_fallback() {
        assert_eq!(
            strip_profile_fallback_html(
                "<strong data-mx-profile-fallback>Kris: </strong>hello there",
                None,
                false
            ),
            "hello there"
        );
        assert_eq!(
            strip_profile_fallback_body("Kris: hello there", Some("Kris"), false),
            "hello there"
        );
        assert_eq!(
            strip_profile_fallback_body("Kris: hello there", Some("Robin"), true),
            "hello there"
        );
        assert_eq!(
            strip_profile_fallback_body("Kris: hello there", None, true),
            "hello there"
        );
    }

    #[test]
    fn leaves_markup_without_the_fallback_marker_alone() {
        assert_eq!(
            strip_profile_fallback_html("<strong>Kris: </strong>hello", Some("Robin"), false),
            "<strong>Kris: </strong>hello"
        );
        assert_eq!(
            strip_profile_fallback_body("Kris: hello", Some("Robin"), false),
            "Kris: hello"
        );
        assert_eq!(
            strip_profile_fallback_body("Kris: hello", None, false),
            "Kris: hello"
        );
    }

    #[test]
    fn strips_an_unmarked_bold_prefix_that_names_the_profile() {
        assert_eq!(
            strip_profile_fallback_html("<strong>Alice: </strong>hello", Some("Alice"), false),
            "hello"
        );
        assert_eq!(
            strip_profile_fallback_html("<strong>Alice: </strong>hello", None, true),
            "hello"
        );
    }

    #[test]
    fn keeps_the_body_when_the_fallback_tag_is_unclosed() {
        let malformed = "<strong data-mx-profile-fallback>Kris: hello";
        assert_eq!(
            strip_profile_fallback_html(malformed, Some("Kris"), true),
            malformed
        );
    }

    #[test]
    fn strips_executable_markup_and_unsafe_links() {
        let html = display_html(
            "",
            Some(
                "<strong>Safe</strong><script>alert(1)</script>\
                 <a href=\"javascript:alert(1)\">bad</a>\
                 <a href=\"/settings\">relative</a>\
                 <a href=\"matrix:u/alice:example.org\">pill</a>",
            ),
        );

        assert!(html.contains("<strong>Safe</strong>"));
        assert!(!html.contains("alert(1)"));
        assert!(!html.contains("javascript:"));
        assert!(!html.contains("/settings"));
        assert!(html.contains("href=\"matrix:u/alice:example.org\""));
        assert!(html.contains("rel=\"noreferrer noopener\""));
    }

    #[test]
    fn drops_the_reply_fallback_with_its_contents() {
        let html = display_html(
            "",
            Some("<mx-reply><blockquote>quoted</blockquote></mx-reply>Answer"),
        );

        assert_eq!(html, "Answer");
    }

    #[test]
    fn keeps_spoilers_colours_and_code_languages() {
        let html = display_html(
            "",
            Some(
                "<span data-mx-spoiler=\"\">secret</span>\
                 <span data-mx-color=\"#ff0000\">red</span>\
                 <span data-mx-color=\"red\">named</span>\
                 <pre><code class=\"language-rust\">fn main() {}</code></pre>",
            ),
        );

        assert!(html.contains("data-mx-spoiler"));
        assert!(html.contains("data-mx-color=\"#ff0000\""));
        assert!(!html.contains("\"red\""));
        assert!(html.contains("class=\"language-rust\""));
    }

    #[test]
    fn strips_style_and_event_handlers() {
        let html = display_html(
            "",
            Some("<span style=\"position:fixed\" onclick=\"steal()\">text</span>"),
        );

        assert_eq!(html, "<span>text</span>");
    }

    #[test]
    fn keeps_mxc_and_web_image_sources_and_drops_every_other_kind() {
        let html = display_html(
            "",
            Some(
                "<img src=\"mxc://example.org/emoji\" alt=\"party\" height=\"32\" data-mx-emoticon=\"\">\
                 <img src=\"https://example.org/badge.png\" alt=\"badge\">\
                 <img src=\"data:image/png;base64,AAAA\" alt=\"inline\">\
                 <img src=\"mxc://example.org\" alt=\"no media id\">",
            ),
        );

        assert!(html.contains("src=\"mxc://example.org/emoji\""));
        assert!(html.contains("data-mx-emoticon"));
        assert!(html.contains("height=\"32\""));
        assert!(html.contains("src=\"https://example.org/badge.png\""));
        assert!(!html.contains("data:image"));
        assert!(!html.contains("src=\"mxc://example.org\""));
    }

    #[test]
    fn falls_back_to_the_body_when_nothing_survives_sanitising() {
        let html = display_html("plain words", Some("<script>alert(1)</script>"));

        assert_eq!(html, "plain words");
    }

    #[test]
    fn refuses_mxc_as_a_link_target() {
        let html = display_html("", Some("<a href=\"mxc://example.org/file\">grab</a>"));

        assert!(!html.contains("href"));
    }

    #[test]
    fn rejects_malformed_matrix_uris() {
        let html = display_html("", Some("<a href=\"matrix:u/alice\">pill</a>"));

        assert!(!html.contains("href"));
    }

    #[test]
    fn linkifies_plain_text_without_interpreting_markup() {
        let html = linkify_plain_text("Use <b>text</b> at https://example.org/a");

        assert!(html.starts_with("Use &lt;b&gt;text&lt;/b&gt;"));
        assert!(html.contains("href=\"https://example.org/a\""));
    }

    #[test]
    fn leaves_trailing_punctuation_out_of_links() {
        assert!(linkify_plain_text("See https://example.org/a.").ends_with("</a>."));
        assert!(linkify_plain_text("(matrix:u/alice:example.org)").ends_with("</a>)"));
    }

    #[test]
    fn linkifies_matrix_uris_and_emails() {
        let html = linkify_plain_text("ping matrix:u/alice:example.org or alice@example.org");

        assert!(html.contains("href=\"matrix:u/alice:example.org\""));
        assert!(html.contains("href=\"mailto:alice@example.org\""));
    }
}
