//! Reads a message's blocks from comrak's tree.

use std::ops::Range;

use comrak::nodes::{ListType, Node, NodeLink, NodeValue, Sourcepos};
use comrak::{Arena, Options, parse_document};

use super::inline::{EM, Glyph, Mark, STRIKE, STRONG, Token};
use super::links::{normalize_link, valid_link};
use super::source::{
    BACKSLASHED_PIPE, ESCAPED_AMPERSAND, ESCAPED_BACKSLASH, FUNCTION_DOLLAR, UNSPACED_QUOTE, mark,
};
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
    Math(String),
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
    pub(super) fn contents<'a>(&'a self, out: &mut Vec<&'a I>) {
        match self {
            Self::Paragraph(content) | Self::Heading(_, content) | Self::Subtext(content) => {
                out.push(content);
            }
            Self::Quote(children) => {
                for child in children {
                    child.contents(out);
                }
            }
            Self::List { items, .. } => {
                for child in items.iter().flatten() {
                    child.contents(out);
                }
            }
            Self::Table(rows) => out.extend(rows.iter().flatten().map(|cell| &cell.content)),
            Self::Code { .. } | Self::Rule | Self::Math(_) => {}
        }
    }

    pub(super) fn map<J>(self, f: &mut dyn FnMut(I) -> J) -> Block<J> {
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
            Self::Math(latex) => Block::Math(latex),
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

fn glyphs(text: &str, literal: bool) -> Vec<Glyph> {
    text.chars().map(|c| Glyph { c, literal }).collect()
}
/// A line break and the whitespace before it.
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

/// A paragraph, or a math block when display math is its only content.
fn paragraph(tokens: Vec<Token>) -> Block<Vec<Token>> {
    if let [
        Token::Math {
            latex,
            display: true,
        },
    ] = tokens.as_slice()
    {
        return Block::Math(latex.clone());
    }
    Block::Paragraph(tokens)
}

/// `ProseMirror` fills a container left empty with an empty paragraph.
fn filled(mut blocks: Vec<Block<Vec<Token>>>) -> Vec<Block<Vec<Token>>> {
    if blocks.is_empty() {
        blocks.push(Block::Paragraph(Vec::new()));
    }
    blocks
}

fn entity_end(text: &str) -> Option<usize> {
    let end = text.find(';')?;
    let name = span(text, 1, end);
    let digits = name.strip_prefix('#');
    let hex = digits.and_then(|digits| digits.strip_prefix(['x', 'X']));
    let valid = match (hex, digits) {
        (Some(hex), _) => hex.bytes().all(|byte| byte.is_ascii_hexdigit()),
        (None, Some(digits)) => digits.bytes().all(|byte| byte.is_ascii_digit()),
        (None, None) => name.bytes().all(|byte| byte.is_ascii_alphanumeric()),
    };
    let empty = hex.or(digits).unwrap_or(name).is_empty();
    (text.starts_with('&') && !empty && valid).then_some(end)
}

struct Reader<'s> {
    source: &'s str,
    lines: Vec<usize>,
    marked: bool,
}

impl<'s> Reader<'s> {
    fn new(source: &'s str, marked: bool) -> Self {
        let mut lines = vec![0];
        lines.extend(source.match_indices('\n').map(|(at, _)| at + 1));
        Self {
            source,
            lines,
            marked,
        }
    }

    /// Source text as it was typed.
    fn typed(&self, text: &str) -> String {
        if self.marked {
            text.replace(BACKSLASHED_PIPE, "\\|")
                .replace(ESCAPED_AMPERSAND, "\\&")
                .replace(ESCAPED_BACKSLASH, "\\\\")
                .replace(FUNCTION_DOLLAR, "$")
                .replace(UNSPACED_QUOTE, ">")
        } else {
            text.to_owned()
        }
    }

    /// Text whose backslash escapes comrak resolved.
    fn unescaped(&self, text: &str) -> String {
        if self.marked {
            text.replace(BACKSLASHED_PIPE, "|")
                .replace(ESCAPED_AMPERSAND, "&")
                .replace(ESCAPED_BACKSLASH, "\\")
                .replace(FUNCTION_DOLLAR, "$")
                .replace(UNSPACED_QUOTE, ">")
        } else {
            text.to_owned()
        }
    }

    /// comrak counts lines and bytes from one, and its end is the last byte.
    fn range(&self, at: Sourcepos) -> Range<usize> {
        let offset = |line: usize, column: usize| {
            let start = line.checked_sub(1).and_then(|line| self.lines.get(line));
            start.map_or(self.source.len(), |start| start + column.saturating_sub(1))
        };
        let start = offset(at.start.line, at.start.column).min(self.source.len());
        let end = (offset(at.end.line, at.end.column) + 1).min(self.source.len());
        start..end.max(start)
    }

    fn range_of(&self, node: Node<'_>) -> Range<usize> {
        self.range(node.data.borrow().sourcepos)
    }

    fn raw(&self, range: Range<usize>) -> &'s str {
        self.source.get(range).unwrap_or_default()
    }

    /// `text` as comrak read it from `range`: what an entity wrote is literal,
    /// and `\|` in a table cell is a pipe like any other.
    fn glyphs(&self, text: &str, range: Range<usize>, bare_pipes: bool) -> Vec<Glyph> {
        let mut rest = self.raw(range);
        if rest == text {
            return glyphs(text, false);
        }
        let mut out = Vec::with_capacity(text.len());
        let mut chars = text.chars();
        while let Some(c) = chars.next() {
            let entity = entity_end(rest)
                .map(|end| (end, html_escape::decode_html_entities(head(rest, end + 1))))
                .filter(|(end, written)| written.len() <= *end && written.starts_with(c));
            if let Some((end, written)) = entity {
                out.push(Glyph { c, literal: true });
                out.extend(
                    chars
                        .by_ref()
                        .take(written.chars().count().saturating_sub(1))
                        .map(|c| Glyph { c, literal: true }),
                );
                rest = tail(rest, end + 1);
            } else if rest.starts_with(c) {
                rest = tail(rest, c.len_utf8());
                out.push(Glyph { c, literal: false });
            } else if bare_pipes && c == '|' && rest.starts_with("\\|") {
                rest = tail(rest, 2);
                out.push(Glyph { c, literal: false });
            } else {
                out.push(Glyph { c, literal: true });
            }
        }
        out
    }

    fn inlines(&self, parent: Node<'_>, bare_pipes: bool) -> Vec<Token> {
        let mut tokens = Vec::new();
        self.children(parent, bare_pipes, &mut tokens);
        tokens
    }

    fn children(&self, parent: Node<'_>, bare_pipes: bool, tokens: &mut Vec<Token>) {
        for child in parent.children() {
            self.inline(child, bare_pipes, tokens);
        }
    }

    /// The source between a link's label and its end, which is text when the
    /// link is refused.
    fn after_label(&self, node: Node<'_>, range: &Range<usize>, marker: usize) -> String {
        let label_end = node
            .last_child()
            .map_or(range.start + marker, |last| self.range_of(last).end);
        self.typed(span(self.source, label_end.min(range.end), range.end))
    }

    fn link(&self, node: Node<'_>, link: &NodeLink, bare_pipes: bool, tokens: &mut Vec<Token>) {
        let range = self.range_of(node);
        let href = normalize_link(&self.unescaped(&link.url));
        let raw = self.raw(range.clone());
        if !raw.starts_with(['[', '<']) {
            // A bare address is text, and its `_` and `*` are not emphasis.
            let bare = self.typed(raw);
            let bare = bare.chars().map(|c| Glyph {
                c,
                literal: matches!(c, '_' | '*' | '~'),
            });
            tokens.push(Token::Text(bare.collect()));
        } else if valid_link(&href) {
            tokens.push(Token::Open(Mark::Link(href)));
            self.children(node, bare_pipes, tokens);
            let suffix = self.after_label(node, &range, 1);
            tokens.push(Token::LinkEnd(suffix));
        } else if raw.starts_with('<') {
            tokens.push(Token::Text(glyphs(&self.typed(raw), false)));
        } else {
            tokens.push(Token::Text(glyphs("[", false)));
            self.children(node, bare_pipes, tokens);
            tokens.push(Token::Text(glyphs(
                &self.after_label(node, &range, 1),
                false,
            )));
        }
    }

    fn image(&self, node: Node<'_>, link: &NodeLink, bare_pipes: bool, tokens: &mut Vec<Token>) {
        let range = &self.range_of(node);
        let src = normalize_link(&self.unescaped(&link.url));
        if valid_link(&src) {
            let mut alt = String::new();
            for inner in node.descendants().skip(1) {
                match &inner.data.borrow().value {
                    NodeValue::Text(text) => alt.push_str(&self.unescaped(text)),
                    NodeValue::Code(code) => alt.push_str(&self.typed(&code.literal)),
                    _ => {}
                }
            }
            tokens.push(Token::Image {
                src,
                alt,
                title: self.unescaped(&link.title),
            });
        } else {
            tokens.push(Token::Text(glyphs("![", false)));
            self.children(node, bare_pipes, tokens);
            tokens.push(Token::Text(glyphs(
                &self.after_label(node, range, 2),
                false,
            )));
        }
    }

    /// A single `~` strikes nothing.
    fn strike(&self, node: Node<'_>, bare_pipes: bool, tokens: &mut Vec<Token>) {
        let real = self.raw(self.range_of(node)).starts_with("~~");
        let edge = |tokens: &mut Vec<Token>, token: Token| {
            tokens.push(if real {
                token
            } else {
                Token::Text(glyphs("~", false))
            });
        };
        edge(tokens, Token::Open(Mark::Strike));
        self.children(node, bare_pipes, tokens);
        edge(tokens, Token::Close(STRIKE));
    }

    fn inline(&self, node: Node<'_>, bare_pipes: bool, tokens: &mut Vec<Token>) {
        let ast = node.data.borrow();
        let range = self.range(ast.sourcepos);
        match &ast.value {
            NodeValue::Text(text) => {
                let mut glyphs = self.glyphs(text, range, bare_pipes);
                let marks = |glyph: &Glyph| self.marked && glyph.c == BACKSLASHED_PIPE;
                while let Some(at) = glyphs.iter().position(marks) {
                    let pipe = Glyph {
                        c: '|',
                        literal: false,
                    };
                    let backslash = Glyph {
                        c: '\\',
                        literal: true,
                    };
                    let typed = if bare_pipes {
                        vec![pipe]
                    } else {
                        vec![backslash, pipe]
                    };
                    glyphs.splice(at.saturating_sub(1)..=at, typed);
                }
                for glyph in &mut glyphs {
                    let (c, literal) = match glyph.c {
                        ESCAPED_AMPERSAND => ('&', true),
                        ESCAPED_BACKSLASH => ('\\', true),
                        FUNCTION_DOLLAR => ('$', false),
                        UNSPACED_QUOTE => ('>', false),
                        _ => continue,
                    };
                    if self.marked {
                        *glyph = Glyph { c, literal };
                    }
                }
                tokens.push(Token::Text(glyphs));
            }
            NodeValue::Escaped => {
                for child in node.children() {
                    if let NodeValue::Text(text) = &child.data.borrow().value {
                        let literal = !(bare_pipes && text.as_ref() == "|");
                        tokens.push(Token::Text(glyphs(text, literal)));
                    }
                }
            }
            NodeValue::HtmlInline(html) => {
                tokens.push(Token::Text(glyphs(&self.typed(html), false)));
            }
            NodeValue::SoftBreak | NodeValue::LineBreak => line_break(tokens, self.source, range),
            NodeValue::Code(code) if bare_pipes && self.marked => {
                tokens.push(Token::Code(
                    self.typed(&code.literal.replace(BACKSLASHED_PIPE, "|")),
                ));
            }
            NodeValue::Code(code) => tokens.push(Token::Code(self.typed(&code.literal))),
            NodeValue::Math(math) if math.display_math && math.literal.trim().is_empty() => {
                tokens.push(Token::Text(glyphs(&self.typed(self.raw(range)), false)));
            }
            NodeValue::Math(math) => {
                let latex = math.literal.trim();
                let latex = if bare_pipes && self.marked {
                    self.typed(&latex.replace(BACKSLASHED_PIPE, "|"))
                } else {
                    self.typed(latex)
                };
                tokens.push(Token::Math {
                    latex,
                    display: math.display_math,
                });
            }
            NodeValue::Emph(_) => {
                tokens.push(Token::Open(Mark::Em));
                self.children(node, bare_pipes, tokens);
                tokens.push(Token::Close(EM));
            }
            NodeValue::Strong(_) => {
                tokens.push(Token::Open(Mark::Strong));
                self.children(node, bare_pipes, tokens);
                tokens.push(Token::Close(STRONG));
            }
            NodeValue::Strikethrough(_) => self.strike(node, bare_pipes, tokens),
            NodeValue::Link(link) => self.link(node, link, bare_pipes, tokens),
            NodeValue::Image(link) => self.image(node, link, bare_pipes, tokens),
            _ => self.children(node, bare_pipes, tokens),
        }
    }

    fn table(&self, node: Node<'_>) -> Block<Vec<Token>> {
        let rows = node
            .children()
            .map(|row| {
                let header =
                    matches!(&row.data.borrow().value, NodeValue::TableRow(row) if row.header);
                row.children()
                    .map(|cell| Cell {
                        header,
                        content: self.inlines(cell, true),
                    })
                    .collect()
            })
            .collect();
        Block::Table(rows)
    }

    fn blocks(&self, parent: Node<'_>) -> Vec<Block<Vec<Token>>> {
        let mut blocks = Vec::new();
        for node in parent.children() {
            let ast = node.data.borrow();
            match &ast.value {
                NodeValue::Paragraph => blocks.push(paragraph(self.inlines(node, false))),
                NodeValue::Subtext => blocks.push(Block::Subtext(self.inlines(node, false))),
                NodeValue::Heading(heading) => {
                    let tokens = self.inlines(node, false);
                    blocks.push(Block::Heading(heading.level, tokens));
                }
                NodeValue::BlockQuote => blocks.push(Block::Quote(filled(self.blocks(node)))),
                NodeValue::CodeBlock(code) => {
                    let mut text = self.typed(&code.literal);
                    if text.ends_with('\n') {
                        text.pop();
                    }
                    let language = code
                        .info
                        .split_whitespace()
                        .next()
                        .filter(|word| {
                            word.chars()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                        })
                        .unwrap_or_default()
                        .to_owned();
                    blocks.push(Block::Code { language, text });
                }
                NodeValue::List(list) => blocks.push(Block::List {
                    order: (list.list_type == ListType::Ordered)
                        .then(|| u64::try_from(list.start).unwrap_or(u64::MAX).max(1)),
                    items: node
                        .children()
                        .map(|item| filled(self.blocks(item)))
                        .collect(),
                }),
                NodeValue::Table(_) => blocks.push(self.table(node)),
                NodeValue::ThematicBreak(_) => blocks.push(Block::Rule),
                NodeValue::HtmlBlock(html) => {
                    let text = self.typed(html.literal.trim_end_matches('\n'));
                    blocks.push(paragraph(vec![Token::Text(glyphs(&text, false))]));
                }
                _ => {}
            }
        }
        blocks
    }
}

pub(super) fn parse(source: &str) -> Vec<Block<Vec<Token>>> {
    let marked = !source.contains([
        BACKSLASHED_PIPE,
        ESCAPED_AMPERSAND,
        ESCAPED_BACKSLASH,
        FUNCTION_DOLLAR,
        UNSPACED_QUOTE,
    ]);
    // comrak reads a list marker that ends the source as text.
    let mut source = source.to_owned() + "\n";
    if marked {
        source = mark(&source);
    }
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.subtext = true;
    options.extension.autolink = true;
    options.extension.math_dollars = true;
    options.extension.math_code = true;
    options.parse.escaped_char_spans = true;
    let arena = Arena::new();
    let document = parse_document(&arena, &source, &options);
    Reader::new(&source, marked).blocks(document)
}
