//! The block structure markdown-it gives a message, read with pulldown-cmark
//! from the source [`prepare`] rewrote.

use std::iter::Peekable;
use std::ops::Range;

use pulldown_cmark::{
    CodeBlockKind, Event, HeadingLevel, LinkType, OffsetIter, Options, Parser, Tag, TagEnd,
};

use super::inline::{Glyph, Mark, Token};
use super::links::{normalize_link, valid_link};
use super::source::{content_of, flanking_chars, prepare};
use crate::text::{head, span, tail};

pub(super) enum Block<I> {
    Paragraph(I),
    Heading(u8, I),
    Subtext(I),
    Quote(Vec<Self>),
    Code {
        language: String,
        text: String,
    },
    Rule,
    List {
        order: Option<u64>,
        items: Vec<Vec<Self>>,
    },
    Table(Vec<Vec<Cell<I>>>),
}

pub(super) struct Cell<I> {
    pub header: bool,
    pub content: I,
}

impl<I> Block<I> {
    pub fn map<J>(self, f: &mut dyn FnMut(I) -> J) -> Block<J> {
        fn all<I, J>(blocks: Vec<Block<I>>, f: &mut dyn FnMut(I) -> J) -> Vec<Block<J>> {
            blocks.into_iter().map(|block| block.map(f)).collect()
        }
        match self {
            Self::Paragraph(content) => Block::Paragraph(f(content)),
            Self::Heading(level, content) => Block::Heading(level, f(content)),
            Self::Subtext(content) => Block::Subtext(f(content)),
            Self::Quote(children) => Block::Quote(all(children, f)),
            Self::Code { language, text } => Block::Code { language, text },
            Self::Rule => Block::Rule,
            Self::List { order, items } => Block::List {
                order,
                items: items.into_iter().map(|item| all(item, f)).collect(),
            },
            Self::Table(rows) => Block::Table(
                rows.into_iter()
                    .map(|row| {
                        row.into_iter()
                            .map(|cell| Cell {
                                header: cell.header,
                                content: f(cell.content),
                            })
                            .collect()
                    })
                    .collect(),
            ),
        }
    }
}

/// Whether the delimiter run at `start..end` is left- and right-flanking,
/// which markdown-it requires of a `~~` that opens and one that closes.
fn flanking(source: &str, start: usize, end: usize) -> (bool, bool) {
    let before = head(source, start).chars().next_back().unwrap_or(' ');
    let after = tail(source, end).chars().next().unwrap_or(' ');
    flanking_chars(before, after)
}

fn glyphs(text: &str, literal: bool) -> Vec<Glyph> {
    text.chars().map(|c| Glyph { c, literal }).collect()
}

/// `text` as pulldown-cmark read it from `range`; entities and escapes are literal, except `\|` in a table cell.
fn read_glyphs(text: &str, source: &str, range: Range<usize>, bare_pipes: bool) -> Vec<Glyph> {
    let literal = |c: char| !(bare_pipes && c == '|');
    if source.get(range.clone()) != Some(text) {
        return text
            .chars()
            .map(|c| Glyph {
                c,
                literal: literal(c),
            })
            .collect();
    }
    let mut out = glyphs(text, false);
    let backslashes = head(source, range.start)
        .bytes()
        .rev()
        .take_while(|byte| *byte == b'\\')
        .count();
    if backslashes % 2 == 1
        && let Some(first) = out.first_mut()
    {
        first.literal = literal(first.c);
    }
    out
}

/// A line break and the whitespace before it, kept as markdown-it keeps it.
fn line_break(tokens: &mut Vec<Token>, source: &str, range: Range<usize>) {
    let before = if source.as_bytes().get(range.start) == Some(&b'\\') {
        0
    } else {
        head(source, range.start)
            .bytes()
            .rev()
            .take_while(|byte| matches!(byte, b' ' | b'\t'))
            .count()
    };
    let raw = span(source, range.start - before, range.end);
    let body = raw.trim_end_matches(['\n', '\r']);
    let kept = match body.strip_suffix('\\') {
        Some(whitespace) => whitespace,
        None if body.ends_with(' ') => body.trim_end_matches(' '),
        None => body,
    };
    if !kept.is_empty() {
        tokens.push(Token::Text(glyphs(kept, false)));
    }
    tokens.push(Token::Break(tail(raw, kept.len()).to_owned()));
}

#[derive(Default)]
struct Inlines {
    tokens: Vec<Token>,
    strikes: Vec<Option<&'static str>>,
    links: Vec<Option<usize>>,
    images: Vec<Option<usize>>,
    alt: Option<(String, String, String, usize)>,
    skip: usize,
    last_end: usize,
    bare_pipes: bool,
}

impl Inlines {
    fn text(&mut self, text: &str, literal: bool) {
        self.tokens.push(Token::Text(glyphs(text, literal)));
    }

    fn link_start(&mut self, source: &str, range: &Range<usize>, link_type: LinkType, dest: &str) {
        let href = if link_type == LinkType::Email {
            normalize_link(&format!("mailto:{dest}"))
        } else {
            normalize_link(dest)
        };
        if valid_link(&href) {
            self.tokens.push(Token::Open(Mark::Link(href)));
            self.links.push(None);
            self.last_end = range.start + 1;
        } else if matches!(link_type, LinkType::Autolink | LinkType::Email) {
            self.text(source.get(range.clone()).unwrap_or_default(), false);
            self.skip = 1;
        } else {
            self.text("[", false);
            self.links.push(Some(range.end));
            self.last_end = range.start + 1;
        }
    }

    /// The source after a link's label, which markdown-it keeps as text when
    /// it refuses the link.
    fn after_label(&self, source: &str, end: usize) -> String {
        span(source, self.last_end.min(end), end).to_owned()
    }

    fn image_alt(&mut self, event: Event<'_>) {
        let Some((_, _, alt, depth)) = self.alt.as_mut() else {
            return;
        };
        match event {
            Event::Start(Tag::Image { .. }) => *depth += 1,
            Event::End(TagEnd::Image) if *depth > 0 => *depth -= 1,
            Event::End(TagEnd::Image) => {
                if let Some((src, title, alt, _)) = self.alt.take() {
                    self.tokens.push(Token::Image { src, alt, title });
                }
            }
            Event::Text(text) | Event::Code(text) => alt.push_str(&text),
            _ => {}
        }
    }

    fn event(&mut self, source: &str, event: Event<'_>, range: Range<usize>) {
        let opens = matches!(event, Event::Start(Tag::Link { .. } | Tag::Image { .. }));
        if self.skip > 0 {
            match event {
                Event::Start(Tag::Link { .. }) => self.skip += 1,
                Event::End(TagEnd::Link) => self.skip -= 1,
                _ => {}
            }
        } else if self.alt.is_some() {
            self.image_alt(event);
        } else {
            self.read(source, event, range.clone());
        }
        if !opens || self.alt.is_some() {
            self.last_end = self.last_end.max(range.end);
        }
    }

    fn read(&mut self, source: &str, event: Event<'_>, range: Range<usize>) {
        match event {
            Event::Text(text) => {
                let glyphs = read_glyphs(&text, source, range, self.bare_pipes);
                self.tokens.push(Token::Text(glyphs));
            }
            Event::Code(code) => self.tokens.push(Token::Code(code.into_string())),
            Event::InlineHtml(html) | Event::Html(html) => self.text(&html, false),
            Event::SoftBreak | Event::HardBreak => line_break(&mut self.tokens, source, range),
            Event::Start(Tag::Emphasis) => self.tokens.push(Token::Open(Mark::Em)),
            Event::End(TagEnd::Emphasis) => self.tokens.push(Token::Close(1)),
            Event::Start(Tag::Strong) => self.tokens.push(Token::Open(Mark::Strong)),
            Event::End(TagEnd::Strong) => self.tokens.push(Token::Close(0)),
            Event::Start(Tag::Strikethrough) => {
                let double = source
                    .get(range.start..)
                    .is_some_and(|rest| rest.starts_with("~~"));
                let real = double
                    && flanking(source, range.start, range.start + 2).0
                    && flanking(source, range.end - 2, range.end).1;
                let refused = if double { "~~" } else { "~" };
                self.strikes.push((!real).then_some(refused));
                if real {
                    self.tokens.push(Token::Open(Mark::Strike));
                } else {
                    self.text(refused, false);
                }
            }
            Event::End(TagEnd::Strikethrough) => match self.strikes.pop().flatten() {
                Some(refused) => self.text(refused, false),
                None => self.tokens.push(Token::Close(2)),
            },
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                ..
            }) => self.link_start(source, &range, link_type, &dest_url),
            Event::End(TagEnd::Link) => {
                if let Some(end) = self.links.pop().flatten() {
                    let label_end = self.after_label(source, end);
                    self.text(&label_end, false);
                } else {
                    let suffix = self.after_label(source, range.end);
                    self.tokens.push(Token::LinkEnd(suffix));
                }
            }
            Event::Start(Tag::Image {
                dest_url, title, ..
            }) => {
                let src = normalize_link(&dest_url);
                if valid_link(&src) {
                    self.alt = Some((src, title.into_string(), String::new(), 0));
                } else {
                    self.text("![", false);
                    self.images.push(Some(range.end));
                    self.last_end = range.start + 2;
                }
            }
            Event::End(TagEnd::Image) => {
                if let Some(end) = self.images.pop().flatten() {
                    let label_end = self.after_label(source, end);
                    self.text(&label_end, false);
                }
            }
            _ => {}
        }
    }
}

type Events<'a> = Peekable<OffsetIter<'a>>;

fn inline_until(events: &mut Events<'_>, source: &str, bare_pipes: bool) -> Vec<Token> {
    let mut inlines = Inlines {
        bare_pipes,
        ..Inlines::default()
    };
    for (event, range) in events.by_ref() {
        if matches!(
            event,
            Event::End(TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::TableCell)
        ) {
            break;
        }
        inlines.event(source, event, range);
    }
    inlines.tokens
}

/// The text after `-#` and its spaces when `line` is a line of subtext.
fn subtext(mut line: Vec<Token>) -> Result<Vec<Token>, Vec<Token>> {
    let Some(Token::Text(glyphs)) = line.first_mut() else {
        return Err(line);
    };
    let marker = matches!(
        glyphs.as_slice(),
        [
            Glyph {
                c: '-',
                literal: false
            },
            Glyph {
                c: '#',
                literal: false
            },
            Glyph { c: ' ' | '\t', .. },
            ..
        ]
    );
    if !marker {
        return Err(line);
    }
    let spaces = glyphs
        .iter()
        .skip(2)
        .take_while(|glyph| matches!(glyph.c, ' ' | '\t'))
        .count();
    glyphs.drain(..2 + spaces);
    if glyphs.is_empty() {
        line.remove(0);
    }
    if line.is_empty() { Err(line) } else { Ok(line) }
}

/// A paragraph, or the subtext it is: [`prepare`] gives every subtext line a
/// paragraph of its own.
fn paragraphs(tokens: Vec<Token>) -> Vec<Block<Vec<Token>>> {
    if tokens.iter().any(|token| matches!(token, Token::Break(_))) {
        return vec![Block::Paragraph(tokens)];
    }
    match subtext(tokens) {
        Ok(content) => vec![Block::Subtext(content)],
        Err(tokens) => vec![Block::Paragraph(tokens)],
    }
}

/// A fence's language from its info string as written: markdown-it takes the
/// first word before resolving escapes, so an escaped one is no language.
fn fence_language(source: &str, start: usize) -> String {
    let line = tail(source, start).lines().next().unwrap_or_default();
    let fence = content_of(line).trim_start();
    let marker = fence.chars().next().unwrap_or('`');
    let info = fence.trim_start_matches(marker);
    info.split_whitespace()
        .next()
        .filter(|word| {
            word.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        })
        .unwrap_or_default()
        .to_owned()
}

fn code_block(
    events: &mut Events<'_>,
    kind: &CodeBlockKind<'_>,
    language: String,
) -> Block<Vec<Token>> {
    let mut text = String::new();
    for (event, _) in events.by_ref() {
        match event {
            Event::Text(chunk) => text.push_str(&chunk),
            Event::End(TagEnd::CodeBlock) => break,
            _ => {}
        }
    }
    if text.ends_with('\n') {
        text.pop();
    }
    let language = match kind {
        CodeBlockKind::Fenced(_) => language,
        CodeBlockKind::Indented => String::new(),
    };
    Block::Code { language, text }
}

fn table(events: &mut Events<'_>, source: &str) -> Block<Vec<Token>> {
    let mut rows: Vec<Vec<Cell<Vec<Token>>>> = Vec::new();
    let mut header = false;
    while let Some((event, _)) = events.next() {
        match event {
            Event::Start(Tag::TableHead) => {
                header = true;
                rows.push(Vec::new());
            }
            Event::Start(Tag::TableRow) => {
                header = false;
                rows.push(Vec::new());
            }
            Event::Start(Tag::TableCell) => {
                let content = inline_until(events, source, true);
                if let Some(row) = rows.last_mut() {
                    row.push(Cell { header, content });
                }
            }
            Event::End(TagEnd::Table) => break,
            _ => {}
        }
    }
    Block::Table(rows)
}

const fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// A heading's content without the edge whitespace markdown-it trims, and an
/// ATX heading's closing run after a tab, which pulldown-cmark keeps.
fn trimmed(mut tokens: Vec<Token>, atx: bool) -> Vec<Token> {
    let space = |glyph: &Glyph| matches!(glyph.c, ' ' | '\t');
    if let Some(Token::Text(glyphs)) = tokens.first_mut() {
        let lead = glyphs.iter().take_while(|glyph| space(glyph)).count();
        glyphs.drain(..lead);
    }
    if let Some(Token::Text(glyphs)) = tokens.last_mut() {
        while glyphs.last().is_some_and(space) {
            glyphs.pop();
        }
        let hashes = glyphs
            .iter()
            .rev()
            .take_while(|glyph| glyph.c == '#' && !glyph.literal)
            .count();
        let before = glyphs.len() - hashes;
        let spaced = before
            .checked_sub(1)
            .and_then(|last| glyphs.get(last))
            .is_some_and(space);
        if atx && hashes > 0 && spaced {
            glyphs.truncate(before);
            while glyphs.last().is_some_and(space) {
                glyphs.pop();
            }
        }
    }
    tokens.retain(|token| !matches!(token, Token::Text(glyphs) if glyphs.is_empty()));
    tokens
}

/// `ProseMirror` fills a container left empty with an empty paragraph.
fn filled(mut blocks: Vec<Block<Vec<Token>>>) -> Vec<Block<Vec<Token>>> {
    if blocks.is_empty() {
        blocks.push(Block::Paragraph(Vec::new()));
    }
    blocks
}

fn list(events: &mut Events<'_>, source: &str, start: Option<u64>) -> Block<Vec<Token>> {
    let mut items = Vec::new();
    while let Some((event, _)) = events.next() {
        match event {
            Event::Start(Tag::Item) => items.push(filled(blocks_until(events, source))),
            Event::End(TagEnd::List(_)) => break,
            _ => {}
        }
    }
    Block::List {
        order: start.map(|start| start.max(1)),
        items,
    }
}

/// Blocks up to the end of the container being read. Inline content directly
/// inside a list item becomes a paragraph, as markdown-it's hidden ones do.
fn blocks_until(events: &mut Events<'_>, source: &str) -> Vec<Block<Vec<Token>>> {
    let mut blocks = Vec::new();
    let mut loose = Inlines::default();
    let flush = |loose: &mut Inlines, blocks: &mut Vec<Block<Vec<Token>>>| {
        if !loose.tokens.is_empty() {
            blocks.extend(paragraphs(std::mem::take(&mut loose.tokens)));
        }
    };
    while let Some((event, range)) = events.next() {
        let starts_block = matches!(
            event,
            Event::Start(
                Tag::Paragraph
                    | Tag::Heading { .. }
                    | Tag::BlockQuote(_)
                    | Tag::CodeBlock(_)
                    | Tag::List(_)
                    | Tag::Table(_)
            ) | Event::Rule
        );
        if starts_block {
            flush(&mut loose, &mut blocks);
        }
        match event {
            Event::End(TagEnd::BlockQuote(_) | TagEnd::Item) => break,
            Event::Start(Tag::Paragraph) => {
                blocks.extend(paragraphs(inline_until(events, source, false)));
            }
            Event::Start(Tag::Heading { level, .. }) => {
                let atx = content_of(tail(source, range.start)).starts_with('#');
                let tokens = trimmed(inline_until(events, source, false), atx);
                blocks.push(Block::Heading(heading_level(level), tokens));
            }
            Event::Start(Tag::BlockQuote(_)) => {
                blocks.push(Block::Quote(filled(blocks_until(events, source))));
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                let language = fence_language(source, range.start);
                blocks.push(code_block(events, &kind, language));
            }
            Event::Start(Tag::List(start)) => blocks.push(list(events, source, start)),
            Event::Start(Tag::Table(_)) => blocks.push(table(events, source)),
            Event::Rule => blocks.push(Block::Rule),
            Event::Start(Tag::HtmlBlock) | Event::End(TagEnd::HtmlBlock) => {}
            event => loose.event(source, event, range),
        }
    }
    flush(&mut loose, &mut blocks);
    blocks
}

pub(super) fn parse(source: &str) -> Vec<Block<Vec<Token>>> {
    let prepared = prepare(source);
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH;
    let mut events = Parser::new_ext(&prepared, options)
        .into_offset_iter()
        .peekable();
    blocks_until(&mut events, &prepared)
}
