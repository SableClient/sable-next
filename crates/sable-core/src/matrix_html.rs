//! Sanitises untrusted message bodies; every HTML string the UI renders comes from here.

use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use ammonia::{Builder, UrlRelative};
use html5ever::tree_builder::{NodeOrText, TreeSink};
use linkify::{LinkFinder, LinkKind};
use matrix_sdk::ruma::html::{
    ElementAttributesSchemes, Html, ListBehavior, PropertiesNames, SanitizerConfig,
};
use matrix_sdk::ruma::{MatrixUri, MxcUri};
use regex_lite::Regex;
use sable_model::color::is_hex_color;
use sable_model::html::nests_too_deeply;
use sable_model::jumbo;

pub use sable_model::html::preview_body;

const ALLOWED_TAGS: [&str; 41] = [
    "a",
    "b",
    "blockquote",
    "br",
    "caption",
    "code",
    "dd",
    "del",
    "details",
    "div",
    "dl",
    "dt",
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
    "time",
    "tr",
    "u",
    "ul",
];

/// `mx-reply` holds the quoted fallback, which the UI already renders from
/// `in_reply_to`; unwrapping any of these would surface sender-controlled text.
const STRIPPED_CONTENT_TAGS: [&str; 6] = [
    "mx-reply", "script", "style", "textarea", "option", "noscript",
];

const URL_SCHEMES: [&str; 8] = [
    "http",
    "https",
    "ftp",
    "mailto",
    "matrix",
    "mxc",
    "tauri",
    "sable-app",
];

const DESKTOP_APP_ORIGIN: &str = "tauri://localhost/";
const ELECTRON_APP_ORIGIN: &str = "sable-app://app/";

fn tag_attributes() -> HashMap<&'static str, HashSet<&'static str>> {
    HashMap::from([
        (
            "a",
            HashSet::from(["href", "data-mx-link", "data-org.matrix.msc4550.link"]),
        ),
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
                "data-mx-room-mention",
                "data-emoji",
            ]),
        ),
        ("div", HashSet::from(["data-mx-maths"])),
        ("sub", HashSet::from(["data-md"])),
        ("time", HashSet::from(["datetime"])),
        (
            "img",
            HashSet::from(["src", "alt", "title", "width", "height", "data-mx-emoticon"]),
        ),
    ])
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

/// Built once: the policy allocates a dozen hash containers, and `display_html`
/// runs for every message row.
static SANITIZER: LazyLock<Builder<'static>> = LazyLock::new(sanitizer);

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
            ("a", "href") if has_scheme(value, "tauri:") => {
                has_scheme(value, DESKTOP_APP_ORIGIN).then(|| value.into())
            }
            ("a", "href") if has_scheme(value, "sable-app:") => {
                has_scheme(value, ELECTRON_APP_ORIGIN).then(|| value.into())
            }
            ("a", "href") => (!has_scheme(value, "mxc:")).then(|| value.into()),
            ("img", "src") => is_mxc_uri(value).then(|| value.into()),
            ("img", "width" | "height") | (_, "start") => value
                .parse::<u32>()
                .ok()
                .map(|number| number.to_string().into()),
            (_, "class") => is_language_class(value).then(|| value.into()),
            ("sub", "data-md") => (value == "-#").then(|| value.into()),
            (_, "data-mx-color" | "data-mx-bg-color") => {
                is_hex_color(value, &[3, 6]).then(|| value.into())
            }
            _ => Some(value.into()),
        });
    builder
}

fn is_mxc_uri(value: &str) -> bool {
    has_scheme(value, "mxc:")
        && <&MxcUri>::from(value)
            .parts()
            .is_ok_and(|(_, media_id)| !media_id.is_empty())
}

fn has_scheme(value: &str, scheme: &str) -> bool {
    value
        .get(..scheme.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(scheme))
}

static MATRIX_POLICY: LazyLock<SanitizerConfig> = LazyLock::new(|| {
    SanitizerConfig::compat()
        .remove_reply_fallback()
        .remove_elements(["script", "style", "textarea", "option", "noscript"])
        .allow_elements(["time", "dl", "dt", "dd"], ListBehavior::Add)
        .remove_attributes([PropertiesNames {
            parent: "a",
            properties: &["target"],
        }])
        .allow_attributes(
            [
                PropertiesNames {
                    parent: "a",
                    properties: &["data-mx-link", "data-org.matrix.msc4550.link"],
                },
                PropertiesNames {
                    parent: "img",
                    properties: &["data-mx-emoticon"],
                },
                PropertiesNames {
                    parent: "pre",
                    properties: &["class"],
                },
                PropertiesNames {
                    parent: "sub",
                    properties: &["data-md"],
                },
                PropertiesNames {
                    parent: "span",
                    properties: &["data-mx-room-mention", "data-emoji"],
                },
                PropertiesNames {
                    parent: "time",
                    properties: &["datetime"],
                },
            ],
            ListBehavior::Add,
        )
        .allow_schemes(
            [
                ElementAttributesSchemes {
                    element: "img",
                    attr_schemes: &[PropertiesNames {
                        parent: "src",
                        properties: &["mxc"],
                    }],
                },
                ElementAttributesSchemes {
                    element: "a",
                    attr_schemes: &[PropertiesNames {
                        parent: "href",
                        properties: &["tauri", "sable-app"],
                    }],
                },
            ],
            ListBehavior::Add,
        )
});

static PLAIN_TEXT_LINKS: LazyLock<LinkFinder> = LazyLock::new(|| {
    let mut finder = LinkFinder::new();
    finder.kinds(&[LinkKind::Url, LinkKind::Email]);
    finder
});

fn escape_html(value: &str) -> String {
    html_escape::encode_text(value).into_owned()
}

/// linkify only recognises schemes with an authority, so `matrix:u/alice:hs`
/// has to be spotted separately.
fn matrix_uri_spans(text: &str) -> Vec<(usize, usize)> {
    const TRAILING: [char; 9] = ['.', ',', ';', ':', '!', '?', ')', ']', '}'];
    // ASCII-only lowercasing keeps byte offsets aligned with `text`.
    let lowercase = text.to_ascii_lowercase();
    let mut spans = Vec::new();
    let mut search = 0;
    while let Some(offset) = lowercase
        .get(search..)
        .and_then(|rest| rest.find("matrix:"))
    {
        let start = search + offset;
        let mut end = text
            .get(start..)
            .and_then(|rest| rest.find(char::is_whitespace))
            .map_or(text.len(), |length| start + length);
        while end > start
            && text
                .get(start..end)
                .is_some_and(|span| span.ends_with(TRAILING))
        {
            end -= 1;
        }
        // A non-separator before the scheme means this is the tail of a longer token.
        let follows_text = text
            .get(..start)
            .and_then(|before| before.chars().next_back())
            .is_some_and(|character| {
                !character.is_whitespace()
                    && !matches!(character, '(' | '[' | '{' | '<' | '"' | '\'')
            });
        if !follows_text
            && text
                .get(start..end)
                .is_some_and(|uri| MatrixUri::parse(uri).is_ok())
        {
            spans.push((start, end));
        }
        search = end.max(start + "matrix:".len());
    }
    spans
}

/// linkify rejects a bracketed IPv6 host, so `https://[::1]/` has to be spotted separately.
fn ipv6_url_spans(text: &str) -> Vec<(usize, usize)> {
    const TRAILING: [char; 9] = ['.', ',', ';', ':', '!', '?', ')', ']', '}'];
    // ASCII-only lowercasing keeps byte offsets aligned with `text`.
    let lowercase = text.to_ascii_lowercase();
    let mut spans = Vec::new();
    for scheme in ["http://[", "https://["] {
        let mut search = 0;
        while let Some(offset) = lowercase.get(search..).and_then(|rest| rest.find(scheme)) {
            let start = search + offset;
            let host_start = start + scheme.len();
            search = host_start;
            let follows_text = text
                .get(..start)
                .and_then(|before| before.chars().next_back())
                .is_some_and(|character| {
                    !character.is_whitespace()
                        && !matches!(character, '(' | '[' | '{' | '<' | '"' | '\'')
                });
            let Some(close) = text.get(host_start..).and_then(|rest| rest.find(']')) else {
                continue;
            };
            let host_end = host_start + close;
            let valid_host = text
                .get(host_start..host_end)
                .is_some_and(|host| host.parse::<std::net::Ipv6Addr>().is_ok());
            let mut end = text
                .get(host_end + 1..)
                .and_then(|rest| rest.find(char::is_whitespace))
                .map_or(text.len(), |length| host_end + 1 + length);
            while end > host_end + 1
                && text
                    .get(host_end + 1..end)
                    .is_some_and(|tail| tail.ends_with(TRAILING))
            {
                end -= 1;
            }
            let tail_ok = text
                .get(host_end + 1..end)
                .is_some_and(|tail| tail.is_empty() || tail.starts_with([':', '/', '?', '#']));
            if !follows_text && valid_host && tail_ok {
                spans.push((start, end));
            }
        }
    }
    spans
}

fn msc_spans(text: &str) -> Vec<(usize, usize)> {
    const MAX_DIGITS: usize = 5;
    let is_word = |character: char| character.is_alphanumeric() || character == '_';
    let bytes = text.as_bytes();
    // ASCII-only lowercasing keeps byte offsets aligned with `text`.
    let lowercase = text.to_ascii_lowercase();
    let mut spans = Vec::new();
    let mut search = 0;
    while let Some(start) = lowercase
        .get(search..)
        .and_then(|rest| rest.find("msc"))
        .map(|offset| search + offset)
    {
        let digits_at = start + "msc".len();
        let digits = bytes.get(digits_at..).map_or(0, |rest| {
            rest.iter().take_while(|byte| byte.is_ascii_digit()).count()
        });
        let end = digits_at + digits;
        let bounded = text
            .get(..start)
            .and_then(|before| before.chars().next_back())
            .is_none_or(|character| !is_word(character))
            && text
                .get(end..)
                .and_then(|after| after.chars().next())
                .is_none_or(|character| !is_word(character));
        if (1..=MAX_DIGITS).contains(&digits) && bounded {
            spans.push((start, end));
        }
        search = end.max(digits_at);
    }
    spans
}

fn anchor(href: &str, text: &str) -> String {
    let allowed = href.split_once(':').is_some_and(|(scheme, _)| {
        URL_SCHEMES
            .iter()
            .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
    }) && !has_scheme(href, "mxc:")
        && (!has_scheme(href, "tauri:") || has_scheme(href, DESKTOP_APP_ORIGIN))
        && (!has_scheme(href, "sable-app:") || has_scheme(href, ELECTRON_APP_ORIGIN));
    if !allowed {
        return escape_html(text);
    }
    format!(
        "<a href=\"{}\" rel=\"noreferrer noopener\">{}</a>",
        html_escape::encode_double_quoted_attribute(href),
        escape_html(text)
    )
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum SpanKind {
    Url,
    Email,
    Msc,
    RoomMention,
}

fn room_mention_spans(text: &str) -> Vec<(usize, usize)> {
    text.match_indices("@room")
        .filter_map(|(start, mention)| {
            let end = start + mention.len();
            let bounded = text
                .get(..start)
                .and_then(|before| before.chars().next_back())
                .is_none_or(|character| !character.is_alphanumeric() && character != '_')
                && text
                    .get(end..)
                    .and_then(|after| after.chars().next())
                    .is_none_or(|character| !character.is_alphanumeric() && character != '_');
            bounded.then_some((start, end))
        })
        .collect()
}

fn escape_with_emoji(text: &str) -> String {
    let mut html = String::with_capacity(text.len());
    let mut offset = 0;
    for (start, end) in jumbo::emoji_runs(text) {
        html.push_str(&escape_html(text.get(offset..start).unwrap_or_default()));
        html.push_str("<span data-emoji>");
        html.push_str(&escape_html(text.get(start..end).unwrap_or_default()));
        html.push_str("</span>");
        offset = end;
    }
    html.push_str(&escape_html(text.get(offset..).unwrap_or_default()));
    html
}

fn render_plain_text(text: &str) -> String {
    let mut spans: Vec<(usize, usize, SpanKind)> = PLAIN_TEXT_LINKS
        .links(text)
        .map(|link| {
            let kind = if link.kind() == &LinkKind::Email {
                SpanKind::Email
            } else {
                SpanKind::Url
            };
            (link.start(), link.end(), kind)
        })
        .chain(
            matrix_uri_spans(text)
                .into_iter()
                .map(|(start, end)| (start, end, SpanKind::Url)),
        )
        .chain(
            ipv6_url_spans(text)
                .into_iter()
                .map(|(start, end)| (start, end, SpanKind::Url)),
        )
        .chain(
            msc_spans(text)
                .into_iter()
                .map(|(start, end)| (start, end, SpanKind::Msc)),
        )
        .chain(
            room_mention_spans(text)
                .into_iter()
                .map(|(start, end)| (start, end, SpanKind::RoomMention)),
        )
        .collect();
    spans.sort_unstable();

    let mut html = String::with_capacity(text.len());
    let mut offset = 0;
    for (start, end, kind) in spans {
        if start < offset {
            continue;
        }
        let (Some(before), Some(link)) = (text.get(offset..start), text.get(start..end)) else {
            continue;
        };
        html.push_str(&escape_with_emoji(before));
        match kind {
            SpanKind::Email => html.push_str(&anchor(&format!("mailto:{link}"), link)),
            SpanKind::Url => html.push_str(&anchor(link, link)),
            SpanKind::Msc => {
                let number = link.get("msc".len()..).unwrap_or_default();
                html.push_str(&anchor(
                    &format!("https://github.com/matrix-org/matrix-spec-proposals/pull/{number}"),
                    link,
                ));
            }
            SpanKind::RoomMention => html.push_str("<span data-mx-room-mention>@room</span>"),
        }
        offset = end;
    }
    html.push_str(&escape_with_emoji(text.get(offset..).unwrap_or_default()));
    html
}

const LINKIFY_SKIP_ELEMENTS: [&str; 9] = [
    "a", "code", "mx-reply", "noscript", "pre", "script", "style", "textarea", "time",
];

fn rewrite_markup(formatted: &str) -> Html {
    let html = Html::parse(formatted);
    let mut pending: Vec<_> = html.children().collect();
    while let Some(node) = pending.pop() {
        if node
            .as_element()
            .is_some_and(|element| LINKIFY_SKIP_ELEMENTS.contains(&element.name.local.as_ref()))
        {
            continue;
        }
        let Some(text) = node.as_text() else {
            pending.extend(node.children());
            continue;
        };
        let text = text.borrow();
        let rendered = render_plain_text(&text);
        if rendered == escape_html(&text) {
            continue;
        }
        let replacement = Html::parse(&rendered);
        for child in replacement.children() {
            html.append_before_sibling(&node, NodeOrText::AppendNode(child));
        }
        html.remove_from_parent(&node);
    }
    html
}

static PROFILE_FALLBACK_HTML: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r#"<strong\s+data-mx-profile-fallback(?:="")?\s*>([^<]+): </strong\s*>"#).ok()
});

/// Strips the profile-name prefix MSC4144 senders prepend, which Sable renders itself.
///
/// Must run before sanitising, which drops the marker attribute.
#[must_use]
pub fn strip_profile_fallback_html(formatted: &str, fallback_name: Option<&str>) -> String {
    let Some(name) = fallback_name else {
        return formatted.to_owned();
    };
    // Some senders set `has_fallback` but prefix the html without the marker.
    if let Some(rest) = formatted.strip_prefix(&format!("{}: ", html_escape::encode_text(name))) {
        return rest.to_owned();
    }
    PROFILE_FALLBACK_HTML.as_ref().map_or_else(
        || formatted.to_owned(),
        |fallback| fallback.replace_all(formatted, "").into_owned(),
    )
}

#[must_use]
pub fn strip_profile_fallback_body(body: &str, fallback_name: Option<&str>) -> String {
    fallback_name
        .and_then(|name| body.strip_prefix(&format!("{name}: ")))
        .unwrap_or(body)
        .to_owned()
}

fn sanitize(formatted: &str) -> String {
    if nests_too_deeply(formatted) {
        return String::new();
    }
    let html = rewrite_markup(formatted);
    html.sanitize_with(&MATRIX_POLICY);
    SANITIZER.clean(&html.to_string()).to_string()
}

/// The HTML the UI renders for a message: the sender's `formatted_body` once
/// sanitised, or the plain body linkified.
#[must_use]
pub fn display_html(body: &str, formatted: Option<&str>) -> String {
    let Some(formatted) = formatted else {
        return render_html(body, None);
    };
    let key = (body.to_owned(), formatted.to_owned());
    let mut cache = DISPLAY_HTML_CACHE.lock();
    if let Some(html) = cache.get(&key) {
        return html.clone();
    }
    let html = render_html(body, Some(formatted));
    cache.insert(key, html.clone());
    html
}

const DISPLAY_HTML_CACHE_ENTRIES: usize = 2048;

static DISPLAY_HTML_CACHE: LazyLock<Mutex<hashlink::LruCache<(String, String), String>>> =
    LazyLock::new(|| Mutex::new(hashlink::LruCache::new(DISPLAY_HTML_CACHE_ENTRIES)));

fn render_html(body: &str, formatted: Option<&str>) -> String {
    let sanitized = formatted.map(sanitize);
    // Markup rejected in full would otherwise leave the message blank.
    match sanitized {
        Some(html) if !html.trim().is_empty() => html,
        _ if body.is_empty() => String::new(),
        _ => format!("<span data-plain-body>{}</span>", render_plain_text(body)),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        display_html, escape_html, preview_body, render_plain_text, rewrite_markup,
        strip_profile_fallback_body, strip_profile_fallback_html,
    };

    #[test]
    fn custom_emotes_only_keep_valid_mxc_sources() {
        for source in [
            "https://tracker.example/pixel",
            "http://tracker.example/pixel",
            "mxc://example.org/",
        ] {
            let html = display_html(
                "wave",
                Some(&format!(
                    "<img data-mx-emoticon src=\"{source}\" alt=\"wave\">"
                )),
            );
            assert!(!html.contains("src="));
        }
        assert!(
            display_html(
                "wave",
                Some("<img data-mx-emoticon src=\"mxc://example.org/wave\" alt=\"wave\">")
            )
            .contains("src=\"mxc://example.org/wave\"")
        );
    }

    #[test]
    fn strips_the_per_message_profile_fallback() {
        assert_eq!(
            strip_profile_fallback_html(
                "<p><strong data-mx-profile-fallback>cat: </strong>Hello, World!</p>",
                Some("cat")
            ),
            "<p>Hello, World!</p>"
        );
        assert_eq!(
            strip_profile_fallback_html(
                "<strong data-mx-profile-fallback=\"\">a &amp; b: </strong>hi",
                Some("a & b")
            ),
            "hi"
        );
        assert_eq!(
            strip_profile_fallback_body("cat: Hello, World!", Some("cat")),
            "Hello, World!"
        );
    }

    #[test]
    fn keeps_a_fallback_the_profile_does_not_declare() {
        let marked = "<strong data-mx-profile-fallback>cat: </strong>hi";
        assert_eq!(strip_profile_fallback_html(marked, None), marked);
        assert_eq!(strip_profile_fallback_body("cat: hi", None), "cat: hi");
    }

    #[test]
    fn keeps_text_that_is_not_the_fallback() {
        assert_eq!(
            strip_profile_fallback_body("Note: to self", Some("cat")),
            "Note: to self"
        );
        assert_eq!(
            strip_profile_fallback_html("<strong>cat: </strong>hi", Some("cat")),
            "<strong>cat: </strong>hi"
        );
        let unclosed = "<strong data-mx-profile-fallback>cat: hi";
        assert_eq!(strip_profile_fallback_html(unclosed, Some("cat")), unclosed);
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
    fn keeps_the_explicit_link_marker() {
        for attribute in ["data-mx-link", "data-org.matrix.msc4550.link"] {
            let html = display_html(
                "",
                Some(&format!(
                    "<a {attribute} href=\"https://matrix.to/#/@alice:example.org\">DM me</a>"
                )),
            );
            assert!(html.contains(attribute), "{attribute}: {html}");
        }
    }

    #[test]
    fn preview_body_uses_formatted_text() {
        for (body, formatted, expected) in [
            ("***both***", "<strong><em>both</em></strong>", "both"),
            ("``code ` tick``", "<code>code ` tick</code>", "code ` tick"),
            (
                "[label](https://example.org)",
                "<a href=\"https://example.org\">label</a>",
                "label",
            ),
            (
                "```rust\nlet x = 1;\n```",
                "<pre><code class=\"language-rust\">let x = 1;</code></pre>",
                "let x = 1;",
            ),
            (
                "before\n```\n    a\n    b\n```\nafter",
                "<p>before</p><pre><code>    a\n    b</code></pre><p>after</p>",
                "before\n    a\n    b\nafter",
            ),
            (
                ":rotate:",
                "<img data-mx-emoticon src=\"mxc://example.org/rotate\" alt=\":rotate:\">",
                ":rotate:",
            ),
            ("\\*literal\\*", "*literal*", "*literal*"),
            (
                "`<tag> & text`",
                "<code>&lt;tag&gt; &amp; text</code>",
                "<tag> & text",
            ),
        ] {
            assert_eq!(preview_body(body, Some(formatted)), expected);
        }
        assert_eq!(preview_body("plain **literal**", None), "plain **literal**");
        assert_eq!(preview_body("fallback", Some("")), "fallback");
    }

    #[test]
    fn preview_body_keeps_mention_link_text() {
        for href in [
            "https://matrix.to/#/@alice:example.org",
            "matrix:u/alice:example.org",
        ] {
            assert_eq!(
                preview_body("hello", Some(&format!("<a href=\"{href}\">hello</a>"))),
                "hello"
            );
        }
    }

    #[test]
    fn preview_body_hides_spoilers() {
        assert_eq!(
            preview_body(
                "look ||secret|| here",
                Some("look <span data-mx-spoiler=\"\">sec<b>ret</b></span> here &amp; there"),
            ),
            "look [Spoiler] here & there"
        );
        assert_eq!(
            preview_body(
                "> quoted\n\n||secret||",
                Some(
                    "<mx-reply><blockquote>quoted</blockquote></mx-reply>\
                     <span data-mx-spoiler=\"why\">secret</span>"
                ),
            ),
            "[Spoiler]"
        );
        assert_eq!(
            preview_body("plain **bold**", Some("plain <b>bold</b>")),
            "plain bold"
        );
        assert_eq!(preview_body("plain", None), "plain");
    }

    #[test]
    fn literal_double_bars_stay_literal() {
        for formatted in ["so. ||i could see it|| yes", "a ||b|| and ||c||"] {
            assert_eq!(display_html("", Some(formatted)), formatted);
        }
    }

    #[test]
    fn spaced_escaped_or_verbatim_bars_stay_literal() {
        for formatted in [
            "a || b || c",
            "a \\||b|| c",
            "<code>||b||</code>",
            "<a href=\"https://example.org\">||b||</a>",
            "one || two",
            "||",
        ] {
            assert!(
                !display_html("", Some(formatted)).contains("data-mx-spoiler"),
                "{formatted}"
            );
        }
    }

    #[test]
    fn preview_keeps_literal_spoiler_bars() {
        assert_eq!(
            preview_body("x", Some("see ||this|| now")),
            "see ||this|| now"
        );
    }

    #[test]
    fn a_plain_body_is_never_read_as_markup() {
        for body in [
            "a **b** and *c* and __d__ and ~~e~~ `f`",
            "so. ||i could see it|| yes",
            "see $x^2$ now and $$a<b$$",
            "at $[unixtime 0] $[fg.color=f00 red]",
        ] {
            assert_eq!(
                display_html(body, None),
                format!("<span data-plain-body>{}</span>", escape_html(body))
            );
            assert_eq!(preview_body(body, None), body);
        }
    }

    #[test]
    fn formatted_body_markdown_stays_literal() {
        for formatted in [
            "*test*",
            "a **b** and *c* and __d__ and _e_ and ~~f~~ `g&amp;h`",
            "***a***",
            "**a _b_ c**",
            "# heading\n\n&gt; quote\n\n- item\n\n```rust\ncode\n```",
            "[label](relative) and ![image](relative)",
            "\\*escaped\\* and \\`code\\`",
        ] {
            assert_eq!(
                display_html("different fallback", Some(formatted)),
                formatted
            );
        }
    }

    #[test]
    fn html_formatting_does_not_change_literal_markdown_inside_it() {
        assert_eq!(
            display_html(
                "",
                Some("<p>*test* <em>**literal**</em> <strong>_text_</strong></p>")
            ),
            "<p>*test* <em>**literal**</em> <strong>_text_</strong></p>"
        );
    }

    #[test]
    fn entity_encoded_markdown_stays_literal() {
        let html = display_html("", Some("<p>&#42;test&#42; &amp; &#96;code&#96;</p>"));
        assert_eq!(html, "<p>*test* &amp; `code`</p>");
        assert_eq!(preview_body("", Some(&html)), "*test* & `code`");
    }

    #[test]
    fn formatted_body_fallback_keeps_literal_syntax() {
        assert_eq!(
            display_html("*test* <b>plain</b>", Some("<script>discard</script>")),
            "<span data-plain-body>*test* &lt;b&gt;plain&lt;/b&gt;</span>"
        );
    }

    #[test]
    fn ordinary_text_with_markers_is_left_alone() {
        for formatted in [
            "2 * 3 * 4",
            "snake_case_name and a_b_c",
            "https://example.org/_a_/*b*",
            "a ~~ b ~~ c",
            "lonely *star",
            "<code>**x**</code>",
        ] {
            let html = display_html("", Some(formatted));
            assert!(
                !html.contains("<em>") && !html.contains("<strong>") && !html.contains("<del>"),
                "{formatted} became {html}"
            );
        }
    }

    #[test]
    fn a_marker_split_by_an_empty_span_stays_literal() {
        let html = display_html("", Some("<span>*</span>like so* and <span>|</span>|x||"));
        assert!(!html.contains("<em>") && !html.contains("data-mx-spoiler"));
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
    fn keeps_description_lists() {
        let markup = "<dl><dt>term</dt><dd>details</dd></dl>";
        assert_eq!(display_html("", Some(markup)), markup);
        assert_eq!(preview_body("", Some(markup)), "term\ndetails");
    }

    #[test]
    fn keeps_only_the_subtext_marker_on_sub() {
        assert_eq!(
            display_html("", Some("<sub data-md=\"-#\">caption</sub>")),
            "<sub data-md=\"-#\">caption</sub>"
        );
        assert_eq!(
            display_html("", Some("<sub data-md=\"x\">2</sub>")),
            "<sub>2</sub>"
        );
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
    fn keeps_only_valid_mxc_image_sources() {
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
        assert!(!html.contains("src=\"https://example.org/badge.png\""));
        assert!(!html.contains("data:image"));
        assert!(!html.contains("src=\"mxc://example.org\""));
    }

    #[test]
    fn rejects_invalid_image_sources() {
        for source in [
            "https://tracker.example/pixel",
            "http://tracker.example/pixel",
            "//tracker.example/pixel",
            "/pixel",
            "data:image/png;base64,AAAA",
            "blob:https://tracker.example/pixel",
            "https&#58;//tracker.example/pixel",
            "mxc://example.org/",
        ] {
            let html = display_html(
                "photo",
                Some(&format!("<img src=\"{source}\" alt=\"photo\">")),
            );
            assert!(!html.contains("src="), "{source}: {html}");
            assert!(html.contains("alt=\"photo\""), "{source}: {html}");
        }
    }

    #[test]
    fn falls_back_to_the_body_when_nothing_survives_sanitising() {
        let html = display_html("plain words", Some("<script>alert(1)</script>"));

        assert_eq!(html, "<span data-plain-body>plain words</span>");
    }

    #[test]
    fn formatted_text_maths_stays_literal() {
        for formatted in ["see $x^2$ now", "$$a&lt;b$$"] {
            assert_eq!(display_html("", Some(formatted)), formatted);
        }
    }

    #[test]
    fn authored_html_maths_is_preserved() {
        let formatted = "<span data-mx-maths=\"x^2\"><code>x^2</code></span>";
        assert_eq!(display_html("", Some(formatted)), formatted);
    }

    #[test]
    fn prices_and_code_are_not_maths() {
        for body in [
            "costs $5 and $10",
            "a $ b $ c",
            "`$x$`",
            "\\$x$",
            "$[unixtime 1]",
        ] {
            assert!(
                !display_html("", Some(body)).contains("data-mx-maths"),
                "{body}"
            );
        }
    }

    #[test]
    fn marks_the_plain_branch_only() {
        assert_eq!(
            display_html("first\nsecond", None),
            "<span data-plain-body>first\nsecond</span>"
        );
        assert!(!display_html("first\nsecond", Some("<b>rich</b>")).contains("data-plain-body"));
        assert_eq!(display_html("", None), "");
    }

    #[test]
    fn wraps_emoji_runs_in_plain_and_formatted_text() {
        assert_eq!(
            display_html("hi 👍🎉 <b>", None),
            "<span data-plain-body>hi <span data-emoji>👍🎉</span> &lt;b&gt;</span>"
        );
        assert_eq!(
            display_html(
                "x",
                Some("<p>go 🔥 <a href=\"https://a.example\">🔥</a> <code>🔥</code></p>")
            ),
            "<p>go <span data-emoji=\"\">🔥</span> <a href=\"https://a.example\" rel=\"noreferrer noopener\">🔥</a> <code>🔥</code></p>"
        );
        assert_eq!(
            display_html("© 1", None),
            "<span data-plain-body>© 1</span>"
        );
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
        let html = render_plain_text("Use <b>text</b> at https://example.org/a");

        assert!(html.starts_with("Use &lt;b&gt;text&lt;/b&gt;"));
        assert!(html.contains("href=\"https://example.org/a\""));
    }

    #[test]
    fn linkifies_ipv6_literal_urls() {
        let html = render_plain_text(
            "see https://[2001:41d0:602:1eea:6767:6767:6767:6767]/ and (http://[::1]:8080/a?b=1).",
        );

        assert!(
            html.contains("href=\"https://[2001:41d0:602:1eea:6767:6767:6767:6767]/\""),
            "{html}"
        );
        assert!(html.contains("href=\"http://[::1]:8080/a?b=1\""), "{html}");
        assert!(!render_plain_text("https://[nope]/").contains("<a "));
    }

    #[test]
    fn marks_standalone_room_mentions() {
        let plain = display_html("tell @room now", None);
        assert!(plain.contains("<span data-mx-room-mention>@room</span>"));
        assert!(!display_html("email me@room", None).contains("data-mx-room-mention"));

        let formatted = display_html("tell @room now", Some("tell @room now"));
        assert!(
            formatted.contains("data-mx-room-mention=\"\""),
            "{formatted}"
        );
    }

    #[test]
    fn leaves_trailing_punctuation_out_of_links() {
        assert!(render_plain_text("See https://example.org/a.").ends_with("</a>."));
        assert!(render_plain_text("(matrix:u/alice:example.org)").ends_with("</a>)"));
    }

    #[test]
    fn multibyte_urls_do_not_panic() {
        for markup in [
            "<a href=\"mxc:\u{e9}\u{e9}\u{e9}\">x</a>",
            "<a href=\"ftp:\u{e9}\u{e9}\u{e9}\">x</a>",
            "<img src=\"mxc:\u{e9}\u{e9}\u{e9}\">",
            "<img src=\"http:\u{e9}\u{e9}\u{e9}\">",
        ] {
            let _ = display_html("", Some(markup));
        }
    }

    #[test]
    fn a_magnet_link_never_becomes_an_anchor() {
        let markup = "<a href=\"magnet:?xt=urn:btih:abc\">torrent</a>";
        let html = display_html("", Some(markup));
        assert!(!html.contains("magnet:"), "magnet href survived: {html}");

        let plain = display_html("magnet:?xt=urn:btih:abc", None);
        assert!(!plain.contains("<a "), "magnet was autolinked: {plain}");
    }

    #[test]
    fn a_bare_mxc_uri_stays_plain_text() {
        let plain = display_html("hi mxc://example.org/pic. and https://example.org", None);
        assert!(plain.contains("hi mxc://example.org/pic. and "), "{plain}");
        assert!(!plain.contains("<img"), "{plain}");
        assert!(plain.contains("<a href=\"https://example.org\""), "{plain}");

        let formatted = display_html("", Some("<p>see mxc://example.org/pic</p>"));
        assert!(
            formatted.contains("see mxc://example.org/pic") && !formatted.contains("<img"),
            "{formatted}"
        );
    }

    #[test]
    fn plain_text_links_keep_the_scheme_whitelist() {
        for body in [
            "javascript://x/a%0aalert(1)",
            "javascript://x?%0Aalert(1)",
            "vbscript://x",
            "data://text/html,x",
        ] {
            let html = display_html(body, None);
            assert!(!html.contains("<a "), "{body} became a link: {html}");
        }

        assert!(display_html("see https://example.org/a", None).contains("<a href="));
    }

    #[test]
    fn nesting_is_capped_and_absurd_nesting_falls_back_to_the_body() {
        let moderate = format!("{}deep{}", "<div>".repeat(400), "</div>".repeat(400));
        assert_eq!(
            display_html("", Some(&moderate)).matches("<div>").count(),
            100
        );

        let absurd = format!("{}deep{}", "<div>".repeat(50_000), "</div>".repeat(50_000));
        assert_eq!(
            display_html("plain", Some(&absurd)),
            "<span data-plain-body>plain</span>"
        );
    }

    #[test]
    fn end_tags_that_close_nothing_do_not_hide_nesting() {
        for markup in ["<b></i>".repeat(20_000), "<b><div></b>".repeat(20_000)] {
            assert_eq!(
                display_html("plain", Some(&markup)),
                "<span data-plain-body>plain</span>"
            );
        }
    }

    #[test]
    fn many_closed_siblings_are_not_mistaken_for_nesting() {
        let markup = "<p><b>x</b></p>".repeat(2_000);
        assert_eq!(
            display_html("", Some(&markup)).matches("<b>").count(),
            2_000
        );
    }

    #[test]
    fn many_void_tags_are_not_mistaken_for_nesting() {
        let markup = "<br>".repeat(2_000);
        assert_eq!(
            display_html("", Some(&markup)).matches("<br>").count(),
            2_000
        );
    }

    #[test]
    fn mfm_time_and_nested_colors_in_formatted_text_stay_literal() {
        let formatted = "at $[unixtime 0] $[fg.color=abc bg.color=123456 red $[bg.color=f00 hot]]";
        assert_eq!(display_html("", Some(formatted)), formatted);
    }

    #[test]
    fn mfm_in_formatted_text_and_verbatim_elements_stays_literal() {
        let html = display_html(
            "",
            Some(
                "<p>$[unixtime 0]</p><code>$[unixtime 0]</code><a href=\"https://example.org\">$[unixtime 0]</a>",
            ),
        );

        assert!(html.contains("<p>$[unixtime 0]</p>"));
        assert!(!html.contains("<time "));
        assert!(html.contains("<code>$[unixtime 0]</code>"));
        assert!(html.contains(">$[unixtime 0]</a>"));
    }

    #[test]
    fn invalid_and_escaped_mfm_stays_literal() {
        let source = "\\$[unixtime 0] $[unixtime nope] $[fg.color=red bad]";
        assert_eq!(render_plain_text(source), source);
    }

    #[test]
    fn escaped_markdown_and_mfm_render_as_literal_text() {
        for (body, formatted, visible) in [
            ("\\*like so*", "<span>*</span>like so*", "*like so*"),
            ("\\`code\\`", "<span>`</span>code`", "`code`"),
            (
                "\\$[unixtime 0]",
                "<span>$</span>[unixtime 0]",
                "$[unixtime 0]",
            ),
            (
                "\\$[fg.color=f00 red]",
                "<span>$</span>[fg.color=f00 red]",
                "$[fg.color=f00 red]",
            ),
        ] {
            let rendered = display_html(body, Some(formatted));
            assert_eq!(rendered, formatted);
            assert_eq!(preview_body(body, Some(&rendered)), visible);
        }
    }

    #[test]
    fn mfm_colors_stay_literal_regardless_of_length() {
        for length in [100, 5000] {
            let formatted = format!("$[fg.color=f00 {}]", "a".repeat(length));
            assert_eq!(display_html("", Some(&formatted)), formatted);
        }
    }

    #[test]
    fn a_long_run_of_unclosed_mfm_stays_literal() {
        for source in [
            "$[fg.color=f00 x ".repeat(20_000),
            "$[unixtime 1 ".repeat(20_000),
        ] {
            assert_eq!(render_plain_text(&source), source);
        }
    }

    #[test]
    fn linkifies_matrix_uris_and_emails() {
        let html = render_plain_text("ping matrix:u/alice:example.org or alice@example.org");

        assert!(html.contains("href=\"matrix:u/alice:example.org\""));
        assert!(html.contains("href=\"mailto:alice@example.org\""));
    }

    #[test]
    fn detects_links_and_mentions_without_interpreting_markdown() {
        let body = "*test* **bold** `literal` ||bars|| $x$ $[unixtime 0] @room https://example.org alice@example.org matrix:u/alice:example.org MSC4144";
        for formatted in [None, Some(body)] {
            let html = display_html(body, formatted);
            assert!(html.contains("*test* **bold** `literal` ||bars|| $x$ $[unixtime 0]"));
            for href in [
                "https://example.org",
                "mailto:alice@example.org",
                "matrix:u/alice:example.org",
                "https://github.com/matrix-org/matrix-spec-proposals/pull/4144",
            ] {
                assert!(html.contains(&format!("href=\"{href}\"")), "{html}");
            }
            assert!(html.contains("data-mx-room-mention"));
            assert!(html.contains(">@room</span>"));
            assert_eq!(preview_body(body, Some(&html)), body);
        }
    }

    #[test]
    fn links_to_the_desktop_app_survive() {
        let href = "tauri://localhost/settings/notifications?focus=favicon-for-mentions-only&moe.sable.client.action=settings";
        assert_eq!(
            href.parse::<http::Uri>().unwrap().scheme_str(),
            Some("tauri")
        );
        let escaped = href.replace('&', "&amp;");

        let markup = format!("<a href=\"{escaped}\">settings</a>");
        assert!(display_html("", Some(&markup)).contains(&format!("href=\"{escaped}\"")));
        assert!(display_html(href, None).contains(&format!("href=\"{escaped}\"")));
        assert!(
            display_html("", Some(&format!("<p>see {escaped}</p>")))
                .contains(&format!("href=\"{escaped}\""))
        );

        for other in [
            "tauri://evil.example/settings/timeline",
            "tauri:localhost/settings",
        ] {
            assert!(
                !display_html(other, None).contains("<a "),
                "{other} became a link"
            );
            let markup = format!("<a href=\"{other}\">x</a>");
            assert!(
                !display_html("", Some(&markup)).contains("tauri:"),
                "{other} survived"
            );
        }
    }

    #[test]
    fn links_to_the_electron_app_survive() {
        let href = "sable-app://app/settings/appearance?focus=font-family&moe.sable.client.action=settings";
        assert_eq!(
            href.parse::<http::Uri>().unwrap().scheme_str(),
            Some("sable-app")
        );
        let escaped = href.replace('&', "&amp;");

        let markup = format!("<a href=\"{escaped}\">settings</a>");
        assert!(display_html("", Some(&markup)).contains(&format!("href=\"{escaped}\"")));
        assert!(display_html(href, None).contains(&format!("href=\"{escaped}\"")));
        assert!(
            display_html("", Some(&format!("<p>see {escaped}</p>")))
                .contains(&format!("href=\"{escaped}\""))
        );

        for other in [
            "sable-app://evil.example/settings/timeline",
            "sable-app://app.evil.example/settings/timeline",
            "sable-app://app:1234/settings/timeline",
            "sable-app:app/settings",
        ] {
            assert!(
                !display_html(other, None).contains("<a "),
                "{other} became a link"
            );
            let markup = format!("<a href=\"{other}\">x</a>");
            assert!(
                !display_html("", Some(&markup)).contains("sable-app:"),
                "{other} survived"
            );
        }
    }

    #[test]
    fn links_to_the_android_app_survive() {
        let href = "http://tauri.localhost/settings/notifications?focus=favicon-for-mentions-only&moe.sable.client.action=settings";
        let escaped = href.replace('&', "&amp;");

        assert!(display_html(href, None).contains(&format!("href=\"{escaped}\"")));
        let markup = format!("<a href=\"{escaped}\">settings</a>");
        assert!(display_html("", Some(&markup)).contains(&format!("href=\"{escaped}\"")));
    }

    #[test]
    fn linkifies_msc_references_in_plain_and_formatted_bodies() {
        let pull = "https://github.com/matrix-org/matrix-spec-proposals/pull";

        let plain = display_html("see MSC4144 and msc2545, not xMSC1 or MSC123456", None);
        assert!(plain.contains(&format!(
            "<a href=\"{pull}/4144\" rel=\"noreferrer noopener\">MSC4144</a>"
        )));
        assert!(plain.contains(&format!("href=\"{pull}/2545\"")));
        assert!(!plain.contains("/pull/1\""));
        assert!(!plain.contains("/pull/123456"));

        let formatted = display_html(
            "",
            Some("<strong>MSC3391</strong> <code>MSC1</code> <a href=\"https://x.org\">MSC2</a>"),
        );
        assert!(formatted.contains(&format!("href=\"{pull}/3391\"")));
        assert!(!formatted.contains("/pull/1\""));
        assert!(!formatted.contains("/pull/2\""));
    }

    #[test]
    fn linkifies_bare_urls_inside_formatted_markup() {
        let html = display_html(
            "hi see https://example.org/a",
            Some("<strong>hi</strong> see https://example.org/a"),
        );

        assert!(html.contains("<strong>hi</strong>"));
        assert!(html.contains("href=\"https://example.org/a\""));
    }

    #[test]
    fn linkifies_matrix_uris_and_permalinks_inside_formatted_markup() {
        let html = display_html(
            "",
            Some(
                "<em>ping</em> matrix:u/alice:example.org and https://matrix.to/#/@bob:example.org",
            ),
        );

        assert!(html.contains("href=\"matrix:u/alice:example.org\""));
        assert!(html.contains("href=\"https://matrix.to/#/@bob:example.org\""));
    }

    #[test]
    fn markup_linkifying_leaves_trailing_punctuation_out() {
        let html = display_html(
            "",
            Some("<p>see https://matrix.to/#/@alice:example.org.</p>"),
        );

        assert!(html.contains("href=\"https://matrix.to/#/@alice:example.org\""));
        assert!(html.contains("</a>."));
    }

    #[test]
    fn markup_linkifying_skips_anchors_and_verbatim_elements() {
        let markup = "<a href=\"https://example.org/a\">https://example.org/a</a>\
                      <code>https://example.org/b</code>\
                      <pre><code>https://example.org/c</code></pre>";
        let html = display_html("", Some(markup));

        assert_eq!(html.matches("<a ").count(), 1);
        assert!(html.contains("<code>https://example.org/b</code>"));
        assert!(html.contains("<code>https://example.org/c</code>"));
    }

    #[test]
    fn markup_linkifying_survives_a_nested_verbatim_element() {
        let html = display_html(
            "",
            Some("<code>a <code>https://example.org/a</code> b</code> https://example.org/c"),
        );

        assert!(!html.contains("href=\"https://example.org/a\""));
        assert!(html.contains("href=\"https://example.org/c\""));
    }

    #[test]
    fn markup_linkifying_ignores_tags_comments_and_attribute_values() {
        let markup = "<!-- https://example.org/a -->\
                      <img src=\"https://example.org/b.png\" alt=\"https://example.org/c\">\
                      <span data-mx-color=\"#ff0000\">plain</span>";
        let html = display_html("", Some(markup));

        assert!(!html.contains("<a "));
        assert!(!html.contains("src="));
        assert!(html.contains("alt=\"https://example.org/c\""));
    }

    #[test]
    fn markup_linkifying_uses_html_text_boundaries() {
        let html = display_html(
            "",
            Some("<p title=\"not > a tag\">2 < 3 https://example.org/a</p>"),
        );

        assert!(html.contains("2 &lt; 3 <a href=\"https://example.org/a\""));
    }

    #[test]
    fn a_self_closing_non_void_element_keeps_its_html_meaning() {
        let html = display_html("", Some("<code/>https://example.org/a</code>"));

        assert_eq!(html, "<code>https://example.org/a</code>");
    }

    #[test]
    fn markup_linkifying_keeps_a_query_that_arrived_as_an_entity() {
        let html = display_html("", Some("<p>https://example.org/a?x=1&amp;y=2</p>"));

        assert!(html.contains("href=\"https://example.org/a?x=1&amp;y=2\""));
    }

    #[test]
    fn markup_without_a_link_is_left_byte_identical() {
        let markup = "<p>plain <strong>text</strong> &amp; more</p>";

        assert_eq!(rewrite_markup(markup).to_string(), markup);
    }

    #[test]
    fn markup_linkifying_does_not_panic_on_unbalanced_or_truncated_markup() {
        for markup in [
            "<code>https://example.org/a",
            "<p https://example.org/a",
            "<!-- https://example.org/a",
            "</code>https://example.org/a",
            "<a/>https://example.org/a",
        ] {
            let _ = rewrite_markup(markup);
        }
    }
}
