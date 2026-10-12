//! A typed message to Matrix content, as the web composer's plain mode sends it. Shares
//! `fixtures/markdown.json` with `serialize.ts`; the two differ on rare delimiter layering the corpus lacks.

mod blocks;
mod html;
mod inline;
mod links;
mod source;

use serde::{Deserialize, Serialize};

use self::blocks::Block;
use self::inline::{Inline, Mark, Token, add_mark, fold, formats, merged, sable_syntax};
use crate::text::{head, is_space, span, tail, trim};

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
}

impl ComposerPill {
    fn text(&self) -> String {
        match self {
            Self::Mention { name, .. } => name.clone(),
            Self::Emote { shortcode, .. } => format!(":{shortcode}:"),
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

fn mentions(text: &str, pills: &[ComposerPill]) -> ComposerMentions {
    let used = text.chars().filter(|c| *c == PILL).count().min(pills.len());
    let mut user_ids: Vec<String> = Vec::new();
    for pill in pills.iter().take(used) {
        if let ComposerPill::Mention { user_id, .. } = pill
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

/// The pills put back where their placeholders were. A pill keeps none of the
/// marks around it; inside a code block it is its text.
fn splice_pills(nodes: Vec<Inline>, next: &mut usize, pills: &[ComposerPill]) -> Vec<Inline> {
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        let Inline::Text(text, marks) = node else {
            out.push(node);
            continue;
        };
        for (index, part) in text.split(PILL).enumerate() {
            if index > 0 && *next < pills.len() {
                out.push(Inline::Pill(*next));
                *next += 1;
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
        if c == PILL
            && let Some(pill) = pills.get(*next)
        {
            out.push_str(&pill.text());
            *next += 1;
        } else if c != PILL {
            out.push(c);
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

fn word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The byte ranges of `MSC1234`-style references in `text`.
fn msc_references(text: &str) -> Vec<(usize, usize, String)> {
    let mut found = Vec::new();
    let lower = text.to_ascii_lowercase();
    let mut from = 0;
    while let Some(offset) = tail(&lower, from).find("msc") {
        let at = from + offset;
        from = at + 3;
        if head(text, at).chars().next_back().is_some_and(word_char) {
            continue;
        }
        let digits = tail(text, at + 3)
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        let end = at + 3 + digits;
        if (1..=5).contains(&digits) && !tail(text, end).chars().next().is_some_and(word_char) {
            found.push((at, end, span(text, at + 3, end).to_owned()));
            from = end;
        }
    }
    found
}

fn link_mscs(nodes: Vec<Inline>) -> Vec<Inline> {
    let mut out = Vec::with_capacity(nodes.len());
    for node in nodes {
        match node {
            Inline::Text(text, marks)
                if !marks
                    .iter()
                    .any(|mark| matches!(mark, Mark::Link(_) | Mark::Code)) =>
            {
                let mut from = 0;
                for (start, end, number) in msc_references(&text) {
                    if start > from {
                        out.push(Inline::Text(
                            span(&text, from, start).to_owned(),
                            marks.clone(),
                        ));
                    }
                    let href = format!(
                        "https://github.com/matrix-org/matrix-spec-proposals/pull/{number}"
                    );
                    out.push(Inline::Text(
                        span(&text, start, end).to_owned(),
                        add_mark(&marks, Mark::Link(href)),
                    ));
                    from = end;
                }
                if from < text.len() {
                    out.push(Inline::Text(tail(&text, from).to_owned(), marks));
                }
            }
            other => out.push(other),
        }
    }
    out
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

fn token_blocks(source: &str) -> Vec<Block<Vec<Token>>> {
    blocks::parse(source)
        .into_iter()
        .map(|block| block.map(&mut sable_syntax))
        .collect()
}

fn block_tokens<'a>(block: &'a Block<Vec<Token>>, out: &mut Vec<&'a Token>) {
    match block {
        Block::Paragraph(tokens) | Block::Heading(_, tokens) | Block::Subtext(tokens) => {
            out.extend(tokens);
        }
        Block::Quote(children) => children.iter().for_each(|child| block_tokens(child, out)),
        Block::List { items, .. } => items
            .iter()
            .flatten()
            .for_each(|child| block_tokens(child, out)),
        Block::Table(rows) => out.extend(rows.iter().flatten().flat_map(|cell| &cell.content)),
        Block::Code { .. } | Block::Rule => {}
    }
}

/// Whether a receiver reading `text` as inline markdown would format it.
fn receiver_formats(text: &str) -> bool {
    let blocks = token_blocks(&format!("# {}", text.replace(['\n', '\r'], " ")));
    let mut tokens = Vec::new();
    for block in &blocks {
        block_tokens(block, &mut tokens);
    }
    let owned: Vec<Token> = tokens.into_iter().cloned().collect();
    formats(&owned)
}

#[must_use]
pub fn markdown_to_content(markdown: &str, pills: &[ComposerPill]) -> ComposerContent {
    let typed = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let mentions = mentions(&typed, pills);
    let body =
        trim(&fill_pills(&typed, pills, ComposerPill::text).replace('\u{a0}', " ")).to_owned();
    if body.is_empty() {
        return ComposerContent {
            body,
            formatted_body: None,
            mentions,
        };
    }

    let source = trim(&typed.replace('\u{a0}', " ")).replace("¯\\_(ツ)_/¯", "¯\\\\\\_(ツ)\\_/¯");
    let parsed: Vec<Block<Vec<Inline>>> = token_blocks(&source)
        .into_iter()
        .map(|block| block.map(&mut |tokens| fold(tokens)))
        .collect();
    let spliced = splice_blocks(parsed, &mut 0, pills);
    let linked: Vec<Block<Vec<Inline>>> = without_trailing_paragraphs(spliced)
        .into_iter()
        .map(|block| block.map(&mut |nodes| merged(link_mscs(nodes))))
        .collect();

    let plain = plain_text(&linked).is_some_and(|text| text == body) && !receiver_formats(&body);
    ComposerContent {
        formatted_body: (!plain).then(|| html::html(&linked, pills, receiver_formats)),
        body,
        mentions,
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Deserialize)]
    struct Case {
        markdown: String,
        pills: Vec<ComposerPill>,
        body: String,
        formatted_body: Option<String>,
        mentions: ComposerMentions,
    }

    #[test]
    fn matches_the_composer_on_the_shared_corpus() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../fixtures/markdown.json")).expect("the corpus");
        let mut failures = Vec::new();
        for case in &cases {
            let content = markdown_to_content(&case.markdown, &case.pills);
            let expected = ComposerContent {
                body: case.body.clone(),
                formatted_body: case.formatted_body.clone(),
                mentions: case.mentions.clone(),
            };
            if content != expected {
                failures.push(format!(
                    "{:?}\n  got      {:?}\n  expected {:?}",
                    case.markdown, content, expected
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} of {} differ:\n{}",
            failures.len(),
            cases.len(),
            failures.join("\n")
        );
    }
}
