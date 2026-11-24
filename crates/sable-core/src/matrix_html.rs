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
pub use sable_model::html::link_scheme_allowed;
use sable_model::html::nests_too_deeply;
use sable_model::jumbo;

pub use sable_model::html::{PreviewEmote, preview_body, preview_emotes};

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
static SANITIZER: LazyLock<Builder<'static>> = LazyLock::new(|| sanitizer(&[]));

/// ammonia only takes a closed set of schemes, so the ones a message links to
/// beyond `URL_SCHEMES` are passed in once `link_scheme_allowed` has cleared them.
fn sanitizer(link_schemes: &[String]) -> Builder<'_> {
    let mut builder = Builder::new();
    builder
        .tags(HashSet::from(ALLOWED_TAGS))
        .tag_attributes(tag_attributes())
        .generic_attributes(HashSet::new())
        .clean_content_tags(HashSet::from(STRIPPED_CONTENT_TAGS))
        .url_schemes(
            URL_SCHEMES
                .into_iter()
                .chain(link_schemes.iter().map(String::as_str))
                .collect(),
        )
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
            // Link schemes are left to `SANITIZER`, which parses them as the webview will.
            [ElementAttributesSchemes {
                element: "img",
                attr_schemes: &[PropertiesNames {
                    parent: "src",
                    properties: &["mxc"],
                }],
            }],
            ListBehavior::Override,
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

fn anchor(href: &str, text: &str) -> String {
    let allowed = href
        .split_once(':')
        .is_some_and(|(scheme, _)| link_scheme_allowed(scheme))
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
    let link_schemes = extra_link_schemes(&html);
    let markup = html.to_string();
    if link_schemes.is_empty() {
        SANITIZER.clean(&markup).to_string()
    } else {
        sanitizer(&link_schemes).clean(&markup).to_string()
    }
}

fn extra_link_schemes(html: &Html) -> Vec<String> {
    let mut schemes = Vec::new();
    let mut pending: Vec<_> = html.children().collect();
    while let Some(node) = pending.pop() {
        pending.extend(node.children());
        let Some(element) = node.as_element() else {
            continue;
        };
        if element.name.local.as_ref() != "a" {
            continue;
        }
        let attrs = element.attrs.borrow();
        let scheme = attrs
            .iter()
            .find(|attr| attr.name.local.as_ref() == "href")
            .and_then(|attr| url::Url::parse(&attr.value).ok())
            .map(|url| url.scheme().to_owned())
            .filter(|scheme| {
                link_scheme_allowed(scheme) && !URL_SCHEMES.contains(&scheme.as_str())
            });
        schemes.extend(scheme);
    }
    schemes
}

/// What only the HTML of a message says: where its links lead, why a span is
/// hidden as a spoiler, and the names of its custom emotes. The quoted reply is
/// not part of it.
#[must_use]
pub fn html_only_text(formatted: &str) -> Vec<String> {
    let html = Html::parse(&sanitize(formatted));
    let mut found = Vec::new();
    let mut pending: Vec<_> = html.children().collect();
    while let Some(node) = pending.pop() {
        pending.extend(node.children());
        let Some(element) = node.as_element() else {
            continue;
        };
        let attrs = element.attrs.borrow();
        let attribute = |name: &str| {
            attrs
                .iter()
                .find(|attr| attr.name.local.as_ref() == name)
                .map(|attr| attr.value.to_string())
        };
        let text = match element.name.local.as_ref() {
            "a" => attribute("href").filter(|href| !href.starts_with("mxc:")),
            "img" if attribute("data-mx-emoticon").is_some() => {
                attribute("alt").or_else(|| attribute("title"))
            }
            _ => None,
        };
        found.extend(text);
        found.extend(attribute("data-mx-spoiler"));
    }
    found.retain(|text| !text.trim().is_empty());
    found.reverse();
    found.dedup();
    found
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
#[path = "matrix_html_tests.rs"]
mod tests;
