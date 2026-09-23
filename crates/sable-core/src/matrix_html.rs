//! Message bodies are untrusted, even when they came from our own homeserver.
//!
//! Everything the UI renders as HTML is produced here, so the view layer never
//! has to decide what is safe.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::sync::{LazyLock, Mutex, PoisonError};

use ammonia::{Builder, UrlRelative};
use linkify::{LinkFinder, LinkKind};
use matrix_sdk::ruma::html::{
    ElementAttributesSchemes, Html, ListBehavior, PropertiesNames, SanitizerConfig,
};
use matrix_sdk::ruma::{MatrixUri, MxcUri};
use time::OffsetDateTime;

const ALLOWED_TAGS: [&str; 38] = [
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

const URL_SCHEMES: [&str; 6] = ["http", "https", "ftp", "mailto", "matrix", "mxc"];

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
    has_scheme(value, "mxc:") && <&MxcUri>::from(value).parts().is_ok()
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
        .allow_elements(["time"], ListBehavior::Add)
        .remove_attributes([PropertiesNames {
            parent: "a",
            properties: &["target"],
        }])
        .allow_attributes(
            [
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
                    parent: "time",
                    properties: &["datetime"],
                },
            ],
            ListBehavior::Add,
        )
        .allow_schemes(
            [ElementAttributesSchemes {
                element: "img",
                attr_schemes: &[PropertiesNames {
                    parent: "src",
                    properties: &["mxc", "http", "https"],
                }],
            }],
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

fn anchor(href: &str, text: &str) -> String {
    let allowed = href.split_once(':').is_some_and(|(scheme, _)| {
        URL_SCHEMES
            .iter()
            .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
    });
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

fn linkify_urls(text: &str) -> String {
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
        let (Some(before), Some(link)) = (text.get(offset..start), text.get(start..end)) else {
            continue;
        };
        html.push_str(&escape_html(before));
        if is_email {
            html.push_str(&anchor(&format!("mailto:{link}"), link));
        } else {
            html.push_str(&anchor(link, link));
        }
        offset = end;
    }
    html.push_str(&escape_html(text.get(offset..).unwrap_or_default()));
    html
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
                html.push_str(&linkify_urls(before));
            }
            html.push_str(&element);
            index += consumed;
            plain_start = index;
            continue;
        }
        index += rest.chars().next().map_or(1, char::len_utf8);
    }
    if let Some(tail) = text.get(plain_start..) {
        html.push_str(&linkify_urls(tail));
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

    let mut depth = 0usize;
    let mut rest = formatted;
    while let Some(offset) = rest.find('<') {
        let Some(after) = rest.get(offset + 1..) else {
            break;
        };
        rest = after;
        let Some(name) = rest.split(['>', ' ', '/', '\t', '\n']).next() else {
            continue;
        };
        if rest.starts_with('/') {
            depth = depth.saturating_sub(1);
        } else if name.starts_with(|c: char| c.is_ascii_alphabetic())
            && !VOID_TAGS.iter().any(|void| name.eq_ignore_ascii_case(void))
        {
            depth += 1;
            if depth > LIMIT {
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
        display_html, render_plain_text, rewrite_markup, strip_profile_fallback_body,
        strip_profile_fallback_html,
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
