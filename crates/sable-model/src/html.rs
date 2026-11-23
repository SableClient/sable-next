use std::sync::LazyLock;

use ruma_html::{Html, ListBehavior, NodeData, NodeRef, SanitizerConfig};
use serde::{Deserialize, Serialize};

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
    let Some(formatted) = formatted else {
        return body.to_owned();
    };
    if nests_too_deeply(formatted) {
        return if formatted.contains(SPOILER_ATTRIBUTE) {
            SPOILER_PLACEHOLDER.to_owned()
        } else {
            body.to_owned()
        };
    }
    let html = Html::parse(formatted);
    html.sanitize_with(&PREVIEW_POLICY);
    let mut text = String::new();
    for node in html.children() {
        push_preview_text(&node, &mut text);
    }
    let text = text.trim_end_matches('\n');
    if text.is_empty() {
        body.to_owned()
    } else {
        text.to_owned()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct PreviewEmote {
    pub alt: String,
    pub source: String,
}

/// The emotes `preview_body` turned into their `alt` text, in order.
#[must_use]
pub fn preview_emotes(formatted: Option<&str>) -> Vec<PreviewEmote> {
    let Some(formatted) = formatted.filter(|formatted| !nests_too_deeply(formatted)) else {
        return Vec::new();
    };
    let html = Html::parse(formatted);
    html.sanitize_with(&PREVIEW_POLICY);
    let mut emotes = Vec::new();
    for node in html.children() {
        push_preview_emotes(&node, &mut emotes);
    }
    emotes
}

fn push_preview_emotes(node: &NodeRef, out: &mut Vec<PreviewEmote>) {
    let NodeData::Element(element) = node.data() else {
        return;
    };
    let attrs = element.attrs.borrow();
    let attr = |name: &str| {
        attrs
            .iter()
            .find(|attribute| &*attribute.name.local == name)
            .map(|attribute| &*attribute.value)
    };
    if attr(SPOILER_ATTRIBUTE).is_some() {
        return;
    }
    if &*element.name.local == "img" {
        if attr("data-mx-emoticon").is_some()
            && let (Some(alt), Some(source)) = (attr("alt"), attr("src"))
            && !alt.is_empty()
            && source.starts_with("mxc://")
        {
            out.push(PreviewEmote {
                alt: alt.to_owned(),
                source: source.to_owned(),
            });
        }
        return;
    }
    for child in node.children() {
        push_preview_emotes(&child, out);
    }
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
