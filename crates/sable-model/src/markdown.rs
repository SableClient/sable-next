//! A typed message to Matrix content, checked against `fixtures/markdown.json`.
//!
//! The flavour is comrak's reading of GitHub markdown, with:
//!
//! - tables, `~~strike~~` (a single `~` strikes nothing) and `-# subtext`;
//! - `$math$`, `$$math$$` and math in backticks inside the dollars;
//! - `||spoiler||`, which may run across paragraphs, and `$[fn …]` functions;
//! - `>` opening a quote only before a space;
//! - a bare address staying text, with its `_` and `*` as written;
//! - links to allowed schemes only, and HTML shown as the text it is.

mod blocks;
mod doc;
mod html;
mod inline;
mod links;
mod source;

use linkify::{LinkFinder, LinkKind};
use serde::{Deserialize, Serialize};

use self::blocks::Block;
use self::inline::{
    Inline, Mark, Token, add_mark, delimiters_across, fold, formats, merged, sable_syntax,
};
use crate::text::{head, is_space, tail, trim};

/// The placeholder a client writes where a pill sits in the typed text.
pub const PILL: char = '\u{FFFC}';

/// A mention or emote picked from a suggestion rather than typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ComposerPill {
    Mention {
        user_id: String,
        name: String,
        via: Vec<String>,
    },
    Emote {
        shortcode: String,
        url: String,
        body: Option<String>,
    },
    Image {
        src: String,
        alt: String,
        title: String,
    },
}

impl ComposerPill {
    fn text(&self) -> String {
        match self {
            Self::Mention { name, .. } => name.clone(),
            Self::Emote { shortcode, .. } => format!(":{shortcode}:"),
            Self::Image { src, alt, .. } => if alt.is_empty() { src } else { alt }.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ComposerMentions {
    pub user_ids: Vec<String>,
    pub room: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ComposerContent {
    pub body: String,
    pub formatted_body: Option<String>,
    pub mentions: ComposerMentions,
}

/// `text` with each placeholder that has a pill replaced by `with(pill)`.
fn fill_pills(
    text: &str,
    pills: &[ComposerPill],
    with: impl Fn(&ComposerPill) -> String,
) -> String {
    let mut remaining = pills.iter();
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match (c == PILL).then(|| remaining.next()).flatten() {
            Some(pill) => out.push_str(&with(pill)),
            None => out.push(c),
        }
    }
    out
}

/// `@room` stands alone in a paragraph, wherever it is, code included.
fn mentions_room(text: &str, pills: usize) -> bool {
    let mut placed = 0;
    text.split("\n\n").any(|paragraph| {
        let words: String = paragraph
            .chars()
            .map(|c| {
                let pill = c == PILL && placed < pills;
                placed += usize::from(pill);
                if c == '\n' || pill { ' ' } else { c }
            })
            .collect();
        words.match_indices("@room").any(|(at, word)| {
            let before = head(&words, at).chars().next_back();
            let after = tail(&words, at + word.len()).chars().next();
            before.is_none_or(is_space) && after.is_none_or(is_space)
        })
    })
}

fn mentions(text: &str, pills: &[ComposerPill], blocks: &[Block<Vec<Inline>>]) -> ComposerMentions {
    let used = text.chars().filter(|c| *c == PILL).count().min(pills.len());
    let mut contents = Vec::new();
    for block in blocks {
        block.contents(&mut contents);
    }
    let mut user_ids: Vec<String> = Vec::new();
    for index in contents
        .into_iter()
        .flatten()
        .filter_map(|node| match node {
            Inline::Pill(index, _) => Some(*index),
            _ => None,
        })
    {
        if let Some(ComposerPill::Mention { user_id, .. }) = pills.get(index)
            && user_id.starts_with('@')
            && !user_ids.contains(user_id)
        {
            user_ids.push(user_id.clone());
        }
    }
    ComposerMentions {
        user_ids,
        room: mentions_room(text, used),
    }
}

/// The pills put back where their placeholders were. Emotes keep emphasis;
/// inside a code block a pill is its text.
fn splice_pills(nodes: Vec<Inline>, next: &mut usize, pills: &[ComposerPill]) -> Vec<Inline> {
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        let Inline::Text(text, marks) = node else {
            out.push(node);
            continue;
        };
        let coded = marks.contains(&Mark::Code);
        for (index, part) in text.split(PILL).enumerate() {
            if index > 0 {
                match pills.get(*next) {
                    Some(pill) if coded && !matches!(pill, ComposerPill::Emote { .. }) => {
                        out.push(Inline::Text(pill.text(), marks.clone()));
                        *next += 1;
                    }
                    Some(pill) => {
                        let emphasis = if matches!(pill, ComposerPill::Emote { .. })
                            && marks.contains(&Mark::Em)
                        {
                            vec![Mark::Em]
                        } else {
                            Vec::new()
                        };
                        out.push(Inline::Pill(*next, emphasis));
                        *next += 1;
                    }
                    None => out.push(Inline::Text(PILL.to_string(), marks.clone())),
                }
            }
            if !part.is_empty() {
                out.push(Inline::Text(part.to_owned(), marks.clone()));
            }
        }
    }
    out
}

fn splice_code(text: &str, next: &mut usize, pills: &[ComposerPill]) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match (c == PILL).then(|| pills.get(*next)).flatten() {
            Some(pill) => {
                out.push_str(&pill.text());
                *next += 1;
            }
            None => out.push(c),
        }
    }
    out
}

fn splice_blocks(
    blocks: Vec<Block<Vec<Inline>>>,
    next: &mut usize,
    pills: &[ComposerPill],
) -> Vec<Block<Vec<Inline>>> {
    blocks
        .into_iter()
        .map(|block| match block {
            Block::Code { language, text } => Block::Code {
                language,
                text: splice_code(&text, next, pills),
            },
            Block::Quote(children) => Block::Quote(splice_blocks(children, next, pills)),
            Block::List { order, items } => Block::List {
                order,
                items: items
                    .into_iter()
                    .map(|item| splice_blocks(item, next, pills))
                    .collect(),
            },
            other => other.map(&mut |nodes| splice_pills(nodes, next, pills)),
        })
        .collect()
}

/// The top-level domains markdown-it's linkify accepts besides the two-letter ones.
const GENERIC_TLDS: [&str; 16] = [
    "biz", "com", "edu", "gov", "net", "org", "pro", "web", "xxx", "aero", "asia", "coop", "info",
    "museum", "name", "shop",
];

/// Where a bare address leads, as markdown-it's linkify reads it: a scheme, or a domain whose
/// top-level domain it knows.
fn bare_href(address: &str, kind: &LinkKind) -> Option<String> {
    if *kind == LinkKind::Email {
        return Some(format!("mailto:{address}"));
    }
    if let Some((scheme, _)) = address.split_once("://") {
        return crate::html::link_scheme_allowed(scheme).then(|| address.to_owned());
    }
    let host = address.split(['/', '?', '#', ':']).next()?;
    let tld = host.rsplit('.').next()?;
    let known = (tld.len() == 2 && tld.bytes().all(|byte| byte.is_ascii_alphabetic()))
        || GENERIC_TLDS.contains(&tld.to_ascii_lowercase().as_str());
    known.then(|| format!("http://{address}"))
}

/// A topic is plain text, so only the bare addresses in it become links.
fn topic_inlines(nodes: Vec<Inline>) -> Vec<Inline> {
    let mut finder = LinkFinder::new();
    finder.url_must_have_scheme(false);
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        match node {
            Inline::Text(text, marks) => {
                for piece in finder.spans(&text) {
                    let href = piece
                        .kind()
                        .and_then(|kind| bare_href(piece.as_str(), kind));
                    let marks = href
                        .map_or_else(|| marks.clone(), |href| add_mark(&marks, Mark::Link(href)));
                    out.push(Inline::Text(piece.as_str().to_owned(), marks));
                }
            }
            other => out.push(other),
        }
    }
    merged(out)
}

fn without_trailing_paragraphs(mut blocks: Vec<Block<Vec<Inline>>>) -> Vec<Block<Vec<Inline>>> {
    while blocks.len() > 1
        && matches!(blocks.last(), Some(Block::Paragraph(nodes)) if nodes.is_empty())
    {
        blocks.pop();
    }
    blocks
}

/// The text a plain document says, or `None` when it carries anything else.
fn plain_text(blocks: &[Block<Vec<Inline>>]) -> Option<String> {
    let mut paragraphs = Vec::with_capacity(blocks.len());
    for block in blocks {
        let Block::Paragraph(nodes) = block else {
            return None;
        };
        let mut text = String::new();
        for node in nodes {
            match node {
                Inline::Text(part, marks) if marks.is_empty() => text.push_str(part),
                Inline::Break(marks) if marks.is_empty() => text.push('\n'),
                _ => return None,
            }
        }
        paragraphs.push(text);
    }
    Some(paragraphs.join("\n\n"))
}

fn delimiters_across_paragraphs(blocks: &mut [Block<Vec<Token>>]) {
    let mut run = Vec::new();
    for block in blocks {
        match block {
            Block::Paragraph(tokens) => run.push(tokens),
            other => {
                delimiters_across(&mut std::mem::take(&mut run));
                match other {
                    Block::Quote(children) => delimiters_across_paragraphs(children),
                    Block::List { items, .. } => {
                        for item in items {
                            delimiters_across_paragraphs(item);
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    delimiters_across(&mut run);
}

fn token_blocks(source: &str) -> Vec<Block<Vec<Token>>> {
    let mut blocks = blocks::parse(source);
    delimiters_across_paragraphs(&mut blocks);
    blocks
        .into_iter()
        .map(|block| block.map(&mut sable_syntax))
        .collect()
}

/// Whether a receiver reading `text` as inline markdown would format it.
#[must_use]
pub fn receiver_formats(text: &str) -> bool {
    let blocks = token_blocks(&format!("# {}", text.replace(['\n', '\r'], " ")));
    let mut contents = Vec::new();
    for block in &blocks {
        block.contents(&mut contents);
    }
    let owned: Vec<Token> = contents.into_iter().flatten().cloned().collect();
    formats(&owned)
}

fn parse(source: &str, pills: &[ComposerPill]) -> Vec<Block<Vec<Inline>>> {
    let parsed: Vec<Block<Vec<Inline>>> = token_blocks(source)
        .into_iter()
        .map(|block| block.map(&mut |tokens| fold(tokens)))
        .collect();
    let spliced = splice_blocks(parsed, &mut 0, pills);
    without_trailing_paragraphs(spliced)
}

fn line_feeds(markdown: &str) -> String {
    markdown.replace("\r\n", "\n").replace('\r', "\n")
}

fn typed_source(typed: &str) -> String {
    trim(&typed.replace('\u{a0}', " ")).replace("¯\\_(ツ)_/¯", "¯\\\\\\_(ツ)\\_/¯")
}

#[must_use]
pub fn markdown_to_content(
    markdown: &str,
    pills: &[ComposerPill],
    link_host: Option<&str>,
) -> ComposerContent {
    let typed = line_feeds(markdown);
    let body =
        trim(&fill_pills(&typed, pills, ComposerPill::text).replace('\u{a0}', " ")).to_owned();
    if body.is_empty() {
        return ComposerContent {
            body,
            formatted_body: None,
            mentions: ComposerMentions {
                user_ids: Vec::new(),
                room: false,
            },
        };
    }
    let linked = parse(&typed_source(&typed), pills);
    let mentions = mentions(&typed, pills, &linked);

    let plain = plain_text(&linked).is_some_and(|text| text == body) && !receiver_formats(&body);
    let formatted_body = (!plain).then(|| html::html(&linked, pills, receiver_formats, link_host));
    let body = match formatted_body.as_deref() {
        Some(formatted) if formatted.contains("data-mx-spoiler") => {
            crate::html::preview_body(&body, Some(formatted))
        }
        _ => body,
    };
    ComposerContent {
        body,
        formatted_body,
        mentions,
    }
}

#[must_use]
pub fn topic_to_html(topic: &str) -> String {
    let mut nodes = Vec::new();
    for (index, line) in line_feeds(topic).split('\n').enumerate() {
        if index > 0 {
            nodes.push(Inline::Break(Vec::new()));
        }
        nodes.push(Inline::Text(line.to_owned(), Vec::new()));
    }
    html::html(
        &[Block::Paragraph(topic_inlines(nodes))],
        &[],
        receiver_formats,
        None,
    )
}

#[must_use]
pub fn markdown_to_doc(markdown: &str, pills: &[ComposerPill]) -> serde_json::Value {
    doc::doc(&parse(&typed_source(&line_feeds(markdown)), pills), pills)
}

#[cfg(test)]
#[path = "markdown_tests.rs"]
mod tests;
