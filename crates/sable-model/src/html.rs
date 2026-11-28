use std::sync::LazyLock;

use ruma_html::{ElementData, Html, ListBehavior, NodeData, NodeRef, SanitizerConfig};
use serde::{Deserialize, Deserializer, Serialize};

static PREVIEW_POLICY: LazyLock<SanitizerConfig> = LazyLock::new(|| {
    SanitizerConfig::compat()
        .remove_reply_fallback()
        .remove_elements(["script", "style", "textarea", "option", "noscript"])
        .allow_elements(["time", "dl", "dt", "dd"], ListBehavior::Add)
});

/// Schemes that run script, read local data or have launched code through an OS handler.
const BLOCKED_LINK_SCHEMES: [&str; 14] = [
    "about",
    "blob",
    "content",
    "data",
    "file",
    "intent",
    "jar",
    "javascript",
    "ms-msdt",
    "ms-officecmd",
    "mxc",
    "search-ms",
    "vbscript",
    "view-source",
];

/// Whether a link with this scheme may be shown and handed to the OS, which picks the app.
#[must_use]
pub fn link_scheme_allowed(scheme: &str) -> bool {
    scheme.starts_with(|first: char| first.is_ascii_alphabetic())
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
        && !BLOCKED_LINK_SCHEMES
            .iter()
            .any(|blocked| scheme.eq_ignore_ascii_case(blocked))
}

#[must_use]
pub fn nests_too_deeply(formatted: &str) -> bool {
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

const SPOILER_ATTRIBUTE: &str = "data-mx-spoiler";
const SPOILER_PLACEHOLDER: &str = "[Spoiler]";

#[must_use]
pub fn preview_body(body: &str, formatted: Option<&str>) -> String {
    preview(body, formatted).0
}

/// `preview_body`'s text and the emotes placed in it.
#[must_use]
pub fn preview(body: &str, formatted: Option<&str>) -> (String, Vec<PreviewEmote>) {
    let Some(formatted) = formatted else {
        return (body.to_owned(), Vec::new());
    };
    if nests_too_deeply(formatted) {
        let text = if formatted.contains(SPOILER_ATTRIBUTE) {
            SPOILER_PLACEHOLDER
        } else {
            body
        };
        return (text.to_owned(), Vec::new());
    }
    let (text, emotes) = preview_parts(formatted);
    if text.is_empty() {
        (body.to_owned(), Vec::new())
    } else {
        (text, emotes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PreviewEmote {
    pub alt: String,
    pub source: String,
    /// Where `alt` starts in the preview text, in UTF-16 code units (a JS string index).
    pub offset: u32,
}

/// Reads stored emotes, leaving out any stored before emotes had an offset.
///
/// # Errors
///
/// When the value is not a list of emotes.
pub fn placed_emotes<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<PreviewEmote>, D::Error> {
    #[derive(Deserialize)]
    struct Stored {
        alt: String,
        source: String,
        offset: Option<u32>,
    }
    Ok(Vec::<Stored>::deserialize(deserializer)?
        .into_iter()
        .filter_map(|stored| {
            Some(PreviewEmote {
                offset: stored.offset?,
                alt: stored.alt,
                source: stored.source,
            })
        })
        .collect())
}

/// The emotes whose `alt` ends within `text`.
#[must_use]
pub fn emotes_within(mut emotes: Vec<PreviewEmote>, text: &str) -> Vec<PreviewEmote> {
    let kept = text.encode_utf16().count();
    emotes.retain(|emote| {
        usize::try_from(emote.offset)
            .ok()
            .and_then(|offset| offset.checked_add(emote.alt.encode_utf16().count()))
            .is_some_and(|end| end <= kept)
    });
    emotes
}

/// The emotes `preview_body` turned into their `alt` text, in order.
#[must_use]
pub fn preview_emotes(formatted: Option<&str>) -> Vec<PreviewEmote> {
    let Some(formatted) = formatted.filter(|formatted| !nests_too_deeply(formatted)) else {
        return Vec::new();
    };
    preview_parts(formatted).1
}

/// The preview text of sanitised `formatted` and the emotes placed in it.
fn preview_parts(formatted: &str) -> (String, Vec<PreviewEmote>) {
    let html = Html::parse(formatted);
    html.sanitize_with(&PREVIEW_POLICY);
    let mut text = String::new();
    let mut emotes = Vec::new();
    for node in html.children() {
        push_preview_text(&node, &mut text, &mut emotes);
    }
    let kept = text.trim_end_matches('\n').len();
    text.truncate(kept);
    let emotes = emotes_within(emotes, &text);
    (text, emotes)
}

fn emote(element: &ElementData) -> Option<(String, String)> {
    let attrs = element.attrs.borrow();
    let attr = |name: &str| {
        attrs
            .iter()
            .find(|attribute| &*attribute.name.local == name)
            .map(|attribute| &*attribute.value)
    };
    attr("data-mx-emoticon")?;
    let (alt, source) = (attr("alt")?, attr("src")?);
    (!alt.is_empty() && source.starts_with("mxc://")).then(|| (alt.to_owned(), source.to_owned()))
}

fn push_preview_text(node: &NodeRef, out: &mut String, emotes: &mut Vec<PreviewEmote>) {
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
                if let Some((alt, source)) = emote(element) {
                    emotes.push(PreviewEmote {
                        offset: u32::try_from(out.encode_utf16().count()).unwrap_or(u32::MAX),
                        alt,
                        source,
                    });
                }
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
                push_preview_text(&child, out, emotes);
            }
            if block && !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
        }
        _ => {}
    }
}

#[cfg(test)]
#[path = "html_tests.rs"]
mod tests;
