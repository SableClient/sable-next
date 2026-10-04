//! Message bodies are untrusted, even when they came from our own homeserver.
//!
//! Everything the UI renders as HTML is produced here, so the view layer never
//! has to decide what is safe.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::ops::Range;
use std::sync::{LazyLock, Mutex, PoisonError};

use ammonia::{Builder, UrlRelative};
use linkify::{LinkFinder, LinkKind};
use matrix_sdk::ruma::html::{
    ElementAttributesSchemes, Html, ListBehavior, NodeData, NodeRef, PropertiesNames,
    SanitizerConfig,
};
use matrix_sdk::ruma::{MatrixUri, MxcUri};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use time::OffsetDateTime;

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

const URL_SCHEMES: [&str; 7] = ["http", "https", "ftp", "mailto", "matrix", "mxc", "tauri"];

const DESKTOP_APP_ORIGIN: &str = "tauri://localhost/";

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
            ("sub", "data-md") => (value == "-#").then(|| value.into()),
            (_, "data-mx-color" | "data-mx-bg-color") => {
                is_matrix_hex_color(value).then(|| value.into())
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
                    properties: &["data-mx-room-mention"],
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
                        properties: &["mxc", "http", "https"],
                    }],
                },
                ElementAttributesSchemes {
                    element: "a",
                    attr_schemes: &[PropertiesNames {
                        parent: "href",
                        properties: &["tauri"],
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
        && (!has_scheme(href, "tauri:") || has_scheme(href, DESKTOP_APP_ORIGIN));
    if !allowed {
        return escape_html(text);
    }
    format!(
        "<a href=\"{}\" rel=\"noreferrer noopener\">{}</a>",
        html_escape::encode_double_quoted_attribute(href),
        escape_html(text)
    )
}

fn render_plain_text(text: &str) -> String {
    rewrite_mfm(text)
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

fn linkify_urls(text: &str) -> String {
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
        html.push_str(&escape_html(before));
        match kind {
            SpanKind::Email => html.push_str(&anchor(&format!("mailto:{link}"), link)),
            SpanKind::Url if is_mxc_uri(link) => {
                let _ = write!(
                    html,
                    "<img src=\"{}\">",
                    html_escape::encode_double_quoted_attribute(link)
                );
            }
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
    html.push_str(&escape_html(text.get(offset..).unwrap_or_default()));
    html
}

fn spoiler_bars(text: &str, index: usize) -> Option<(usize, &str)> {
    let body = text.get(index..)?.strip_prefix("||")?;
    let before = text.get(..index)?.chars().next_back();
    if !before.is_none_or(|c| c.is_whitespace() || "([{<\"'".contains(c)) {
        return None;
    }
    if body.starts_with(|c: char| c == '|' || c.is_whitespace()) {
        return None;
    }
    let inner = body.get(..body.find("||")?)?;
    if inner.ends_with(char::is_whitespace) {
        return None;
    }
    Some((inner.len() + 4, inner))
}

fn math_span(text: &str, index: usize) -> Option<(usize, String)> {
    let rest = text.get(index..)?;
    let before = text.get(..index)?.chars().next_back();
    if before.is_some_and(|c| c.is_alphanumeric() || c == '$') {
        return None;
    }
    let (display, body) = match rest.strip_prefix("$$") {
        Some(body) => (true, body),
        None => (false, rest.strip_prefix('$')?),
    };
    let inner = body.get(..body.find(if display { "$$" } else { "$" })?)?;
    if inner.trim().is_empty() || (!display && inner.contains('\n')) {
        return None;
    }
    if !display {
        let after = body.get(inner.len() + 1..)?.chars().next();
        let bounded = !inner.starts_with(char::is_whitespace)
            && !inner.ends_with(char::is_whitespace)
            && !inner.starts_with('[')
            && !after.is_some_and(|c| c.is_ascii_digit());
        if !bounded {
            return None;
        }
    }
    let latex = inner.trim();
    let attribute = html_escape::encode_double_quoted_attribute(latex);
    let tag = if display { "div" } else { "span" };
    let consumed = inner.len() + if display { 4 } else { 2 };
    Some((
        consumed,
        format!(
            "<{tag} data-mx-maths=\"{attribute}\"><code>{}</code></{tag}>",
            escape_html(latex)
        ),
    ))
}

fn hide_spoiler_bars(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while let Some(rest) = text.get(index..).filter(|rest| !rest.is_empty()) {
        if let Some((consumed, _)) = spoiler_bars(text, index) {
            out.push_str(SPOILER_PLACEHOLDER);
            index += consumed;
        } else {
            let character = rest.chars().next().unwrap_or_default();
            out.push(character);
            index += character.len_utf8();
        }
    }
    out
}

fn link_words(text: &str) -> Vec<Range<usize>> {
    let mut words = Vec::new();
    let mut start = None;
    for (index, character) in text.char_indices().chain([(text.len(), ' ')]) {
        if character.is_whitespace() {
            if let Some(from) = start.take()
                && let Some(word) = text.get(from..index)
                && (word.contains("://")
                    || ["www.", "mailto:", "matrix:"]
                        .iter()
                        .any(|prefix| word.starts_with(prefix)))
            {
                words.push(from..index);
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    words
}

fn inline_markdown(segment: &str) -> String {
    let trimmed = segment.trim();
    let lead = segment.get(..segment.len() - segment.trim_start().len());
    let trail = segment.get(segment.trim_end().len()..);
    let mut html = String::with_capacity(segment.len());
    let mut formatted = false;
    let links = link_words(trimmed);
    for (event, range) in Parser::new_ext(trimmed, Options::ENABLE_STRIKETHROUGH).into_offset_iter()
    {
        if matches!(
            event,
            Event::Start(Tag::Emphasis | Tag::Strong | Tag::Strikethrough) | Event::Code(_)
        ) {
            formatted = true;
            if links
                .iter()
                .any(|word| range.start < word.end && word.start < range.end)
            {
                return linkify_urls(segment);
            }
        }
        match event {
            Event::Start(Tag::Paragraph) => {
                if !html.is_empty() {
                    html.push_str("\n\n");
                }
            }
            Event::End(TagEnd::Paragraph) => {}
            Event::Start(Tag::Emphasis) => html.push_str("<em>"),
            Event::End(TagEnd::Emphasis) => html.push_str("</em>"),
            Event::Start(Tag::Strong) => html.push_str("<strong>"),
            Event::End(TagEnd::Strong) => html.push_str("</strong>"),
            Event::Start(Tag::Strikethrough) => html.push_str("<del>"),
            Event::End(TagEnd::Strikethrough) => html.push_str("</del>"),
            Event::Code(code) => {
                let _ = write!(html, "<code>{}</code>", escape_html(&code));
            }
            Event::Text(text) => html.push_str(&linkify_urls(&text)),
            Event::SoftBreak | Event::HardBreak => html.push('\n'),
            _ => return linkify_urls(segment),
        }
    }
    if !formatted {
        return linkify_urls(segment);
    }
    format!(
        "{}{html}{}",
        lead.map(escape_html).unwrap_or_default(),
        trail.map(escape_html).unwrap_or_default()
    )
}

fn rewrite_mfm(text: &str) -> String {
    rewrite_mfm_at_depth(text, 0)
}

const MAX_MFM_DEPTH: usize = 32;

const MFM_SPAN_LIMIT: usize = 2048;

fn rewrite_mfm_at_depth(text: &str, depth: usize) -> String {
    let mut html = String::with_capacity(text.len());
    let mut plain_start = 0;
    let mut code_ticks = None;
    let mut index = 0;
    while index < text.len() {
        let Some(rest) = text.get(index..) else {
            break;
        };
        if code_ticks.is_none() && rest.starts_with('\\') {
            index += 1 + rest
                .get(1..)
                .and_then(|tail| tail.chars().next())
                .map_or(0, char::len_utf8);
            continue;
        }
        if rest.starts_with('`') {
            let ticks = rest.bytes().take_while(|byte| *byte == b'`').count();
            match code_ticks {
                Some(open) if open == ticks => code_ticks = None,
                None => code_ticks = Some(ticks),
                _ => {}
            }
            index += ticks;
            continue;
        }
        if code_ticks.is_none()
            && rest.starts_with("$[")
            && let Some((consumed, element)) = mfm_element(rest, depth)
        {
            if let Some(before) = text.get(plain_start..index) {
                html.push_str(&inline_markdown(before));
            }
            html.push_str(&element);
            index += consumed;
            plain_start = index;
            continue;
        }
        if code_ticks.is_none()
            && !rest.starts_with("$[")
            && let Some((consumed, element)) = math_span(text, index)
        {
            if let Some(before) = text.get(plain_start..index) {
                html.push_str(&inline_markdown(before));
            }
            html.push_str(&element);
            index += consumed;
            plain_start = index;
            continue;
        }
        if code_ticks.is_none()
            && depth < MAX_MFM_DEPTH
            && let Some((consumed, inner)) = spoiler_bars(text, index)
        {
            if let Some(before) = text.get(plain_start..index) {
                html.push_str(&inline_markdown(before));
            }
            let _ = write!(
                html,
                "<span data-mx-spoiler=\"\">{}</span>",
                rewrite_mfm_at_depth(inner, depth + 1)
            );
            index += consumed;
            plain_start = index;
            continue;
        }
        index += rest.chars().next().map_or(1, char::len_utf8);
    }
    if let Some(tail) = text.get(plain_start..) {
        html.push_str(&inline_markdown(tail));
    }
    html
}

fn mfm_element(src: &str, depth: usize) -> Option<(usize, String)> {
    mfm_unixtime(src).or_else(|| mfm_color(src, depth))
}

fn mfm_unixtime(src: &str) -> Option<(usize, String)> {
    let after_name = src.strip_prefix("$[unixtime")?;
    if !after_name.starts_with([' ', '\t']) {
        return None;
    }
    let args = after_name.trim_start_matches([' ', '\t']);
    let close = args.bytes().take_while(u8::is_ascii_digit).count();
    if close == 0 || args.as_bytes().get(close) != Some(&b']') {
        return None;
    }
    let seconds = args.get(..close)?;
    let (datetime, label) = unix_time(seconds)?;
    Some((
        src.len() - args.len() + close + 1,
        format!("<time datetime=\"{datetime}\">{label}</time>"),
    ))
}

struct ColorArgs {
    fg: Option<String>,
    bg: Option<String>,
}

fn mfm_close(src: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut escaped = false;
    for (index, character) in src.char_indices().take(MFM_SPAN_LIMIT).skip(1) {
        if escaped {
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '[' {
            depth += 1;
        } else if character == ']' {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

fn mfm_color(src: &str, depth: usize) -> Option<(usize, String)> {
    if !src.starts_with("$[fg.color=") && !src.starts_with("$[bg.color=") {
        return None;
    }
    let close = mfm_close(src)?;
    let inner = src.get(2..close)?;
    let (args, text_at) = parse_color_args(inner)?;
    let text = inner.get(text_at..)?.trim();
    if text.is_empty() {
        return None;
    }
    let mut attrs = String::new();
    if let Some(fg) = &args.fg {
        let _ = write!(attrs, " data-mx-color=\"{fg}\"");
    }
    if let Some(bg) = &args.bg {
        let _ = write!(attrs, " data-mx-bg-color=\"{bg}\"");
    }
    let content = if depth < MAX_MFM_DEPTH {
        rewrite_mfm_at_depth(text, depth + 1)
    } else {
        linkify_urls(text)
    };
    Some((close + 1, format!("<span{attrs}>{content}</span>")))
}

fn parse_color_args(inner: &str) -> Option<(ColorArgs, usize)> {
    let mut args = ColorArgs { fg: None, bg: None };
    let mut rest = inner;
    let mut consumed = 0;
    let mut found = false;
    loop {
        if found {
            let spaces = rest.len() - rest.trim_start_matches([' ', '\t']).len();
            if spaces == 0 {
                break;
            }
            rest = rest.get(spaces..)?;
            consumed += spaces;
        }
        let token_len = rest.find([' ', '\t']).unwrap_or(rest.len());
        let token = rest.get(..token_len)?;
        let Some((kind, value)) = token
            .strip_prefix("fg.color=")
            .map(|value| ("fg", value))
            .or_else(|| token.strip_prefix("bg.color=").map(|value| ("bg", value)))
        else {
            break;
        };
        let normalized = normalize_mfm_hex(value)?;
        if kind == "fg" {
            args.fg = Some(normalized);
        } else {
            args.bg = Some(normalized);
        }
        found = true;
        rest = rest.get(token_len..)?;
        consumed += token_len;
    }
    (args.fg.is_some() || args.bg.is_some()).then_some((args, consumed))
}

fn normalize_mfm_hex(value: &str) -> Option<String> {
    let digits = value.strip_prefix('#').unwrap_or(value);
    if !matches!(digits.len(), 3 | 6) || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let expanded = match digits.len() {
        3 => {
            let [red, green, blue] = *digits.as_bytes() else {
                return None;
            };
            format!(
                "{}{}{}{}{}{}",
                red as char, red as char, green as char, green as char, blue as char, blue as char
            )
        }
        6 => digits.to_owned(),
        _ => return None,
    };
    Some(format!("#{}", expanded.to_ascii_lowercase()))
}

fn unix_time(seconds: &str) -> Option<(String, String)> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let seconds: i64 = seconds.parse().ok()?;
    if seconds < 0 {
        return None;
    }
    let value = OffsetDateTime::from_unix_timestamp(seconds).ok()?;
    if !(1..=9999).contains(&value.year()) {
        return None;
    }
    let datetime = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second()
    );
    let month = MONTHS.get(usize::from(u8::from(value.month()) - 1))?;
    let label = format!(
        "{} {} {}, {:02}:{:02} (UTC)",
        value.day(),
        month,
        value.year(),
        value.hour(),
        value.minute()
    );
    Some((datetime, label))
}

const LINKIFY_SKIP_ELEMENTS: [&str; 9] = [
    "a", "code", "mx-reply", "noscript", "pre", "script", "style", "textarea", "time",
];

fn markup_span_end(formatted: &str, start: usize) -> usize {
    let Some(rest) = formatted.get(start..) else {
        return formatted.len();
    };
    if rest.starts_with("<!--") {
        return rest
            .find("-->")
            .map_or(formatted.len(), |at| start + at + "-->".len());
    }

    let mut quote = None;
    for (offset, character) in rest.char_indices().skip(1) {
        match (quote, character) {
            (None, '"' | '\'') => quote = Some(character),
            (Some(open), _) if open == character => quote = None,
            (None, '>') => return start + offset + 1,
            _ => {}
        }
    }
    formatted.len()
}

fn tag_name(tag: &str) -> Option<(String, bool)> {
    let body = tag.strip_prefix('<')?;
    let (body, closing) = body
        .strip_prefix('/')
        .map_or((body, false), |rest| (rest, true));
    let name: String = body
        .chars()
        .take_while(|character| character.is_ascii_alphanumeric() || *character == '-')
        .map(|character| character.to_ascii_lowercase())
        .collect();
    (!name.is_empty()).then_some((name, closing))
}

fn rewrite_text_run(run: &str) -> String {
    let decoded = html_escape::decode_html_entities(run);
    let rendered = render_plain_text(&decoded);
    if rendered == escape_html(&decoded) {
        run.to_owned()
    } else {
        rendered
    }
}

fn rewrite_markup(formatted: &str) -> String {
    let mut out = String::with_capacity(formatted.len());
    let mut run_start = 0;
    let mut cursor = 0;
    let mut skip: Option<(String, usize)> = None;

    while let Some(offset) = formatted.get(cursor..).and_then(|rest| rest.find('<')) {
        let start = cursor + offset;
        let run = formatted.get(run_start..start).unwrap_or_default();
        if skip.is_none() {
            out.push_str(&rewrite_text_run(run));
        } else {
            out.push_str(run);
        }

        let end = markup_span_end(formatted, start);
        let tag = formatted.get(start..end).unwrap_or_default();
        out.push_str(tag);

        if let Some((name, closing)) = tag_name(tag) {
            let self_closing = tag.trim_end_matches('>').trim_end().ends_with('/');
            match &mut skip {
                Some((open, depth)) if *open == name => {
                    if closing {
                        *depth -= 1;
                        if *depth == 0 {
                            skip = None;
                        }
                    } else if !self_closing {
                        *depth += 1;
                    }
                }
                None if !closing
                    && !self_closing
                    && LINKIFY_SKIP_ELEMENTS.contains(&name.as_str()) =>
                {
                    skip = Some((name, 1));
                }
                _ => {}
            }
        }

        run_start = end;
        cursor = end.max(start + 1);
    }

    let tail = formatted.get(run_start..).unwrap_or_default();
    if skip.is_none() {
        out.push_str(&rewrite_text_run(tail));
    } else {
        out.push_str(tail);
    }
    out
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
    let open_tag = trimmed.get(..=tag_end)?;
    if !open_tag.starts_with("<strong") {
        return None;
    }
    let close = trimmed.get(tag_end..)?.find("</strong>")?;
    let text = trimmed.get(tag_end + 1..tag_end + close)?;
    let rest = tag_end + close + "</strong>".len();
    Some((open_tag, text, rest))
}

#[must_use]
pub fn has_profile_fallback_html(formatted: &str) -> bool {
    leading_strong(formatted)
        .is_some_and(|(open_tag, _, _)| open_tag.contains("data-mx-profile-fallback"))
}

/// Not every sender marks the element; some emit a bare `<strong>Name: </strong>`
/// or no markup at all. Matching the profile name, or `has_fallback` plus a
/// trailing colon, catches those without eating the sender's own emphasis.
#[must_use]
pub fn strip_profile_fallback_html(
    formatted: &str,
    display_name: Option<&str>,
    known: bool,
) -> String {
    if let Some(name) = display_name.map(str::trim).filter(|name| !name.is_empty())
        && let Some(body) = formatted
            .trim_start()
            .strip_prefix(&format!("&lt;{name}&gt; "))
    {
        return body.trim_start().to_owned();
    }

    if let Some(name) = display_name.map(str::trim).filter(|name| !name.is_empty()) {
        if let Some(body) = formatted.trim_start().strip_prefix(&format!("{name}: ")) {
            return body.trim_start().to_owned();
        }
        // A name with markup characters arrives entity-encoded in the html.
        let encoded = html_escape::encode_text(name);
        if encoded != name
            && let Some(body) = formatted.trim_start().strip_prefix(&format!("{encoded}: "))
        {
            return body.trim_start().to_owned();
        }
    }

    let Some((open_tag, text, rest)) = leading_strong(formatted) else {
        return formatted.to_owned();
    };
    // The fallback always carries the colon; without it this is the sender's
    // own emphasis that happens to read like the profile name.
    let labelled = text.trim_end().ends_with(':');
    let label = text.trim().trim_end_matches(':').trim();
    let named = labelled
        && display_name
            .map(str::trim)
            .is_some_and(|name| !name.is_empty() && label == name);
    let marked = open_tag.contains("data-mx-profile-fallback");
    let fallback = marked || named || (known && labelled);
    fallback
        .then(|| formatted.trim_start().get(rest..))
        .flatten()
        .map_or_else(|| formatted.to_owned(), |body| body.trim_start().to_owned())
}

/// The plain-text half of the same fallback, which arrives as `Name: `.
///
/// A known name that does not prefix the body means there is no fallback, so
/// nothing is cut: splitting on the first `": "` would eat the opening clause
/// of `we shipped it: finally`. Only a nameless profile falls back to that.
#[must_use]
pub fn strip_profile_fallback_body(body: &str, display_name: Option<&str>, known: bool) -> String {
    let name = display_name.map(str::trim).filter(|name| !name.is_empty());
    if let Some(name) = name {
        return body
            .strip_prefix(&format!("{name}: "))
            .or_else(|| body.strip_prefix(&format!("<{name}> ")))
            .map_or_else(|| body.to_owned(), ToOwned::to_owned);
    }
    if !known {
        return body.to_owned();
    }
    body.split_once(": ")
        .map_or_else(|| body.to_owned(), |(_, rest)| rest.to_owned())
}

fn nests_too_deeply(formatted: &str) -> bool {
    const VOID_TAGS: [&str; 3] = ["br", "hr", "img"];
    const LIMIT: usize = 512;

    let mut open: Vec<&str> = Vec::new();
    let mut rest = formatted;
    while let Some(offset) = rest.find('<') {
        let Some(after) = rest.get(offset + 1..) else {
            break;
        };
        rest = after;
        if let Some(closing) = rest.strip_prefix('/') {
            let name = closing
                .split(['>', ' ', '\t', '\n'])
                .next()
                .unwrap_or_default();
            if open
                .last()
                .is_some_and(|top| top.eq_ignore_ascii_case(name))
            {
                open.pop();
            }
            continue;
        }
        let Some(name) = rest.split(['>', ' ', '/', '\t', '\n']).next() else {
            continue;
        };
        if name.starts_with(|c: char| c.is_ascii_alphabetic())
            && !VOID_TAGS.iter().any(|void| name.eq_ignore_ascii_case(void))
        {
            open.push(name);
            if open.len() > LIMIT {
                return true;
            }
        }
    }
    false
}

fn sanitize(formatted: &str) -> String {
    if nests_too_deeply(formatted) {
        return String::new();
    }
    let html = Html::parse(&rewrite_markup(formatted));
    html.sanitize_with(&MATRIX_POLICY);
    for node in html.children() {
        sanitize_emote_sources(&node);
    }
    SANITIZER.clean(&html.to_string()).to_string()
}

fn sanitize_emote_sources(node: &NodeRef) {
    if let NodeData::Element(element) = node.data()
        && &*element.name.local == "img"
    {
        let mut attrs = element.attrs.borrow_mut();
        if attrs
            .iter()
            .any(|attr| &*attr.name.local == "data-mx-emoticon")
        {
            attrs.retain(|attr| &*attr.name.local != "src" || is_mxc_uri(&attr.value));
        }
    }
    for child in node.children() {
        sanitize_emote_sources(&child);
    }
}

const SPOILER_ATTRIBUTE: &str = "data-mx-spoiler";
const SPOILER_PLACEHOLDER: &str = "[Spoiler]";

#[must_use]
pub fn preview_body(body: &str, formatted: Option<&str>) -> String {
    let Some(formatted) = formatted else {
        return hide_spoiler_bars(body);
    };
    if nests_too_deeply(formatted) {
        return if formatted.contains(SPOILER_ATTRIBUTE) {
            SPOILER_PLACEHOLDER.to_owned()
        } else {
            hide_spoiler_bars(body)
        };
    }
    let html = Html::parse(formatted);
    html.sanitize_with(&MATRIX_POLICY);
    let mut text = String::new();
    for node in html.children() {
        push_preview_text(&node, &mut text);
    }
    let text = text.trim_end_matches('\n');
    hide_spoiler_bars(if text.is_empty() { body } else { text })
}

fn push_preview_text(node: &NodeRef, out: &mut String) {
    match node.data() {
        NodeData::Text(text) => out.push_str(&text.borrow()),
        NodeData::Element(element) => {
            if element
                .attrs
                .borrow()
                .iter()
                .any(|attribute| &*attribute.name.local == SPOILER_ATTRIBUTE)
            {
                out.push_str(SPOILER_PLACEHOLDER);
                return;
            }
            if &*element.name.local == "br" {
                out.push('\n');
                return;
            }
            if &*element.name.local == "img" {
                if let Some(alt) = element
                    .attrs
                    .borrow()
                    .iter()
                    .find(|attr| &*attr.name.local == "alt")
                {
                    out.push_str(&alt.value);
                }
                return;
            }
            let block = matches!(
                &*element.name.local,
                "p" | "div"
                    | "pre"
                    | "blockquote"
                    | "h1"
                    | "h2"
                    | "h3"
                    | "h4"
                    | "h5"
                    | "h6"
                    | "li"
                    | "tr"
                    | "dt"
                    | "dd"
            );
            if block && !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            for child in node.children() {
                push_preview_text(&child, out);
            }
            if block && !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
        }
        _ => {}
    }
}

/// The HTML the UI renders for a message: the sender's `formatted_body` once
/// sanitised, or the plain body linkified.
#[must_use]
pub fn display_html(body: &str, formatted: Option<&str>) -> String {
    let Some(formatted) = formatted else {
        return render_html(body, None);
    };
    let key = (body.to_owned(), formatted.to_owned());
    let mut cache = DISPLAY_HTML_CACHE
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if let Some(html) = cache.get(&key) {
        return html.clone();
    }
    let html = render_html(body, Some(formatted));
    if cache.len() >= DISPLAY_HTML_CACHE_ENTRIES {
        cache.clear();
    }
    cache.insert(key, html.clone());
    html
}

const DISPLAY_HTML_CACHE_ENTRIES: usize = 2048;

static DISPLAY_HTML_CACHE: LazyLock<Mutex<HashMap<(String, String), String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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
        display_html, preview_body, render_plain_text, rewrite_markup, strip_profile_fallback_body,
        strip_profile_fallback_html,
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
        assert!(
            display_html(
                "photo",
                Some("<img src=\"https://example.org/photo\" alt=\"photo\">")
            )
            .contains("src=\"https://example.org/photo\"")
        );
    }

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
            strip_profile_fallback_body("Kris: hello there", None, true),
            "hello there"
        );
    }

    #[test]
    fn keeps_a_body_whose_colon_is_not_a_fallback() {
        assert_eq!(
            strip_profile_fallback_body("we shipped it: finally", Some("Robin"), true),
            "we shipped it: finally"
        );
        assert_eq!(
            strip_profile_fallback_body("Note: to self", Some("Kris"), true),
            "Note: to self"
        );
    }

    #[test]
    fn keeps_bold_that_merely_repeats_the_profile_name() {
        assert_eq!(
            strip_profile_fallback_html("<strong>Kris</strong> is great", Some("Kris"), false),
            "<strong>Kris</strong> is great"
        );
        assert_eq!(
            strip_profile_fallback_html("<strong>Kris</strong> is great", Some("Kris"), true),
            "<strong>Kris</strong> is great"
        );
    }

    #[test]
    fn strips_the_html_fallback_without_a_parsed_profile() {
        assert_eq!(
            strip_profile_fallback_html(
                "<strong data-mx-profile-fallback>Kris: </strong>hi",
                None,
                true
            ),
            "hi"
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
    fn strips_a_bare_prefix_that_names_the_profile() {
        assert_eq!(
            strip_profile_fallback_html("Alice: hello there", Some("Alice"), true),
            "hello there"
        );
        assert_eq!(
            strip_profile_fallback_html("Alice: hello there", Some("Alice"), false),
            "hello there"
        );
        assert_eq!(
            strip_profile_fallback_html("Alice &amp; Bob: hello", Some("Alice & Bob"), false),
            "hello"
        );
        assert_eq!(
            strip_profile_fallback_html("<em>Alice: </em>hello", Some("Alice"), false),
            "<em>Alice: </em>hello"
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
    fn literal_double_bars_become_spoilers() {
        let html = display_html("", Some("so. ||i could see it|| yes"));
        assert!(html.contains("so. <span data-mx-spoiler=\"\">i could see it</span> yes"));

        let html = display_html("", Some("a ||b|| and ||c||"));
        assert_eq!(html.matches("data-mx-spoiler").count(), 2);
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
        assert!(display_html("a ||b|| c", None).contains("data-mx-spoiler"));
    }

    #[test]
    fn preview_hides_literal_spoiler_bars() {
        assert_eq!(
            preview_body("x", Some("see ||this|| now")),
            "see [Spoiler] now"
        );
        assert_eq!(preview_body("see ||this|| now", None), "see [Spoiler] now");
    }

    #[test]
    fn unrendered_markdown_markers_become_formatting() {
        let html = display_html(
            "",
            Some("a **b** and *c* and __d__ and _e_ and ~~f~~ `g&amp;h`"),
        );
        for expected in [
            "<strong>b</strong>",
            "<em>c</em>",
            "<strong>d</strong>",
            "<em>e</em>",
            "<del>f</del>",
            "<code>g&amp;h</code>",
        ] {
            assert!(html.contains(expected), "{expected} in {html}");
        }
        assert_eq!(
            display_html("", Some("***a***")),
            "<em><strong>a</strong></em>"
        );
        assert_eq!(
            display_html("", Some("**a _b_ c**")),
            "<strong>a <em>b</em> c</strong>"
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

        assert_eq!(html, "<span data-plain-body>plain words</span>");
    }

    #[test]
    fn plain_text_maths_becomes_a_maths_element() {
        assert_eq!(
            display_html("see $x^2$ now", None),
            "<span data-plain-body>see <span data-mx-maths=\"x^2\"><code>x^2</code></span> now</span>"
        );
        assert_eq!(
            display_html("$$a<b$$", None),
            "<span data-plain-body><div data-mx-maths=\"a&lt;b\"><code>a&lt;b</code></div></span>"
        );
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
                !display_html(body, None).contains("data-mx-maths"),
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
    fn a_bare_mxc_uri_renders_as_its_image() {
        let plain = display_html("hi mxc://example.org/pic. and https://example.org", None);
        assert!(
            plain.contains("hi <img src=\"mxc://example.org/pic\">."),
            "{plain}"
        );
        assert!(plain.contains("<a href=\"https://example.org\""), "{plain}");

        let formatted = display_html("", Some("<p>see mxc://example.org/pic</p>"));
        assert!(
            formatted.contains("<img src=\"mxc://example.org/pic\">"),
            "{formatted}"
        );

        let invalid = display_html("mxc://example.org", None);
        assert!(
            !invalid.contains("<img") && !invalid.contains("<a "),
            "{invalid}"
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
    fn renders_mfm_time_and_nested_colors_in_plain_text() {
        let html = display_html(
            "at $[unixtime 0] $[fg.color=abc bg.color=123456 red $[bg.color=f00 hot]]",
            None,
        );

        assert!(
            html.contains("<time datetime=\"1970-01-01T00:00:00Z\">1 Jan 1970, 00:00 (UTC)</time>")
        );
        assert!(html.contains(
            "<span data-mx-color=\"#aabbcc\" data-mx-bg-color=\"#123456\">red <span data-mx-bg-color=\"#ff0000\">hot</span></span>"
        ));
    }

    #[test]
    fn rewrites_mfm_in_formatted_text_but_skips_verbatim_elements() {
        let html = display_html(
            "",
            Some(
                "<p>$[unixtime 0]</p><code>$[unixtime 0]</code><a href=\"https://example.org\">$[unixtime 0]</a>",
            ),
        );

        assert_eq!(html.matches("<time ").count(), 1);
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
    fn a_colour_looks_for_its_close_within_a_bounded_span() {
        let near = format!("$[fg.color=f00 {}]", "a".repeat(100));
        assert!(render_plain_text(&near).starts_with("<span data-mx-color=\"#ff0000\">"));

        let far = format!("$[fg.color=f00 {}]", "a".repeat(5000));
        assert_eq!(render_plain_text(&far), far);
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
        assert!(html.contains("src=\"https://example.org/b.png\""));
    }

    #[test]
    fn markup_linkifying_keeps_a_query_that_arrived_as_an_entity() {
        let html = display_html("", Some("<p>https://example.org/a?x=1&amp;y=2</p>"));

        assert!(html.contains("href=\"https://example.org/a?x=1&amp;y=2\""));
    }

    #[test]
    fn markup_without_a_link_is_left_byte_identical() {
        let markup = "<p>plain <strong>text</strong> &amp; more</p>";

        assert_eq!(rewrite_markup(markup), markup);
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
