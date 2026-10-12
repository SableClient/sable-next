//! Inline tokens in markdown-it's order, Sable's inline syntax, and the marks `ProseMirror` gives each run.

use crate::mfm::{parse_mfm_color, parse_mfm_unixtime};
use crate::text::is_space;

/// Whatever a backslash escape or an entity produced is text, never syntax.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Glyph {
    pub c: char,
    pub literal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Mark {
    Strong,
    Em,
    Strike,
    Code,
    Color(String),
    BgColor(String),
    Spoiler,
    Link(String),
}

pub(super) const LINK: u8 = 10;
const CODE: u8 = 3;
const SPOILER: u8 = 9;
const COLOR: u8 = 7;
const BG_COLOR: u8 = 8;

impl Mark {
    /// The composer schema's mark order, which is also the order marks nest in.
    pub const fn rank(&self) -> u8 {
        match self {
            Self::Strong => 0,
            Self::Em => 1,
            Self::Strike => 2,
            Self::Code => CODE,
            Self::Color(_) => COLOR,
            Self::BgColor(_) => BG_COLOR,
            Self::Spoiler => SPOILER,
            Self::Link(_) => LINK,
        }
    }

    /// `code` excludes every other mark; every mark excludes its own type.
    const fn excludes(&self, other: &Self) -> bool {
        matches!(self, Self::Code) || self.rank() == other.rank()
    }
}

/// `ProseMirror`'s `Mark.addToSet`.
pub(super) fn add_mark(set: &[Mark], mark: Mark) -> Vec<Mark> {
    let mut copy: Option<Vec<Mark>> = None;
    let mut placed = false;
    for (index, other) in set.iter().enumerate() {
        if *other == mark {
            return set.to_vec();
        }
        if mark.excludes(other) {
            copy.get_or_insert_with(|| set.get(..index).unwrap_or_default().to_vec());
        } else if other.excludes(&mark) {
            return set.to_vec();
        } else {
            if !placed && other.rank() > mark.rank() {
                copy.get_or_insert_with(|| set.get(..index).unwrap_or_default().to_vec())
                    .push(mark.clone());
                placed = true;
            }
            if let Some(copy) = copy.as_mut() {
                copy.push(other.clone());
            }
        }
    }
    let mut copy = copy.unwrap_or_else(|| set.to_vec());
    if !placed {
        copy.push(mark);
    }
    copy
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Token {
    Text(Vec<Glyph>),
    Code(String),
    /// A line break with the source around it.
    Break(String),
    Image {
        src: String,
        alt: String,
        title: String,
    },
    Time {
        datetime: String,
        label: String,
    },
    Open(Mark),
    Close(u8),
    /// Closes a link, keeping the source after its label in case MFM claims
    /// the label as markdown-it would.
    LinkEnd(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Inline {
    Text(String, Vec<Mark>),
    Break(Vec<Mark>),
    Image {
        src: String,
        alt: String,
        title: String,
        marks: Vec<Mark>,
    },
    Time {
        datetime: String,
        label: String,
        marks: Vec<Mark>,
    },
    Pill(usize),
}

impl Inline {
    pub fn marks(&self) -> &[Mark] {
        match self {
            Self::Text(_, marks)
            | Self::Break(marks)
            | Self::Image { marks, .. }
            | Self::Time { marks, .. } => marks,
            Self::Pill(_) => &[],
        }
    }
}

/// Whether markdown-it would format any of `tokens` the way a receiver
/// re-reading the text would.
pub(super) fn formats(tokens: &[Token]) -> bool {
    tokens.iter().any(|token| match token {
        Token::Code(_) => true,
        Token::Open(mark) => matches!(mark, Mark::Strong | Mark::Em | Mark::Strike | Mark::Spoiler),
        _ => false,
    })
}

const MFM_WINDOW: usize = 4096;

#[derive(Debug, Clone)]
enum Piece {
    Glyph(Glyph),
    Token(Token),
}

impl Piece {
    const fn glyph(&self, c: char) -> bool {
        matches!(self, Self::Glyph(glyph) if glyph.c == c && !glyph.literal)
    }

    const fn opens_link(&self) -> bool {
        matches!(self, Self::Token(Token::Open(Mark::Link(_))))
    }

    const fn closes_link(&self) -> bool {
        matches!(self, Self::Token(Token::LinkEnd(_)))
    }
}

fn pieces(tokens: Vec<Token>) -> Vec<Piece> {
    let mut pieces = Vec::new();
    for token in tokens {
        match token {
            Token::Text(glyphs) => pieces.extend(glyphs.into_iter().map(Piece::Glyph)),
            other => pieces.push(Piece::Token(other)),
        }
    }
    pieces
}

fn tokens(pieces: Vec<Piece>) -> Vec<Token> {
    let mut tokens: Vec<Token> = Vec::new();
    for piece in pieces {
        match piece {
            Piece::Glyph(glyph) => {
                if let Some(Token::Text(glyphs)) = tokens.last_mut() {
                    glyphs.push(glyph);
                } else {
                    tokens.push(Token::Text(vec![glyph]));
                }
            }
            Piece::Token(token) => tokens.push(token),
        }
    }
    tokens
}

/// The `Close` matching the link opened at `open`, or `hi` when it is missing.
fn link_end(pieces: &[Piece], open: usize, hi: usize) -> usize {
    let mut depth = 0_usize;
    for (index, piece) in pieces.iter().enumerate().take(hi).skip(open) {
        if piece.opens_link() {
            depth += 1;
        } else if piece.closes_link() {
            depth -= 1;
            if depth == 0 {
                return index;
            }
        }
    }
    hi
}

/// markdown-it's raw source for `pieces`, one char per entry; escaped punctuation keeps its backslash.
fn projection(pieces: &[Piece], lo: usize, hi: usize, limit: usize) -> Vec<(char, usize)> {
    let mut chars = Vec::new();
    for (index, piece) in pieces.iter().enumerate().take(hi).skip(lo) {
        if chars.len() >= limit {
            break;
        }
        match piece {
            Piece::Glyph(glyph) => {
                if glyph.literal && glyph.c.is_ascii_punctuation() {
                    chars.push(('\\', index));
                }
                chars.push((glyph.c, index));
            }
            Piece::Token(Token::Code(code)) => {
                chars.push(('`', index));
                chars.extend(code.chars().map(|c| (c, index)));
                chars.push(('`', index));
            }
            Piece::Token(Token::Break(raw)) => chars.extend(raw.chars().map(|c| (c, index))),
            Piece::Token(Token::Open(Mark::Link(_))) => chars.push(('[', index)),
            Piece::Token(Token::LinkEnd(_)) => chars.push((']', index)),
            Piece::Token(_) => chars.push(('*', index)),
        }
    }
    chars
}

/// The `||` that closes a spoiler opened before `from`, inside this scope.
fn spoiler_close(pieces: &[Piece], from: usize, hi: usize) -> Option<usize> {
    let mut index = from;
    while index + 1 < hi {
        let (Some(piece), Some(next)) = (pieces.get(index), pieces.get(index + 1)) else {
            break;
        };
        if piece.opens_link() {
            index = link_end(pieces, index, hi) + 1;
            continue;
        }
        if piece.glyph('|') && next.glyph('|') {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn spoiler_inner_valid(pieces: &[Piece], lo: usize, hi: usize) -> bool {
    let inner = projection(pieces, lo, hi, usize::MAX);
    match (inner.first(), inner.last()) {
        (Some(&(first, _)), Some(&(last, _))) => !is_space(first) && !is_space(last),
        _ => false,
    }
}

/// The piece index `n` chars into a projection, or `hi` past its end.
fn piece_at(chars: &[(char, usize)], n: usize, hi: usize) -> usize {
    chars.get(n).map_or(hi, |&(_, index)| index)
}

fn utf16_chars(chars: &[(char, usize)], units: usize) -> usize {
    let mut seen = 0;
    chars
        .iter()
        .take_while(|(c, _)| {
            seen += c.len_utf16();
            seen <= units
        })
        .count()
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// The composer's English label for a UTC instant: `Nov 14, 2023, 22:13 (UTC)`.
fn utc_label(datetime: &str) -> String {
    let field = |range: std::ops::Range<usize>| {
        datetime
            .get(range)
            .and_then(|digits| digits.parse::<usize>().ok())
    };
    let name = field(5..7)
        .and_then(|month| month.checked_sub(1))
        .and_then(|month| MONTHS.get(month));
    match (field(0..4), name, field(8..10), datetime.get(11..16)) {
        (Some(year), Some(name), Some(day), Some(clock)) => {
            format!("{name} {day}, {year}, {clock} (UTC)")
        }
        _ => datetime.to_owned(),
    }
}

fn mfm(pieces: &[Piece], at: usize, hi: usize, out: &mut Vec<Piece>) -> Option<usize> {
    let chars = projection(pieces, at, hi, MFM_WINDOW);
    let source: String = chars.iter().map(|&(c, _)| c).collect();
    if let Some(unix) = parse_mfm_unixtime(&source) {
        let label = utc_label(&unix.datetime);
        out.push(Piece::Token(Token::Time {
            datetime: unix.datetime,
            label,
        }));
        return Some(piece_at(&chars, unix.raw.chars().count(), hi));
    }
    let color = parse_mfm_color(&source)?;
    let start = utf16_chars(&chars, usize::try_from(color.offset).ok()?);
    let inner_lo = piece_at(&chars, start, hi);
    let inner_hi = piece_at(&chars, start + color.text.chars().count(), hi);
    let end = piece_at(&chars, color.raw.chars().count(), hi);
    if let Some(fg) = &color.args.fg {
        out.push(Piece::Token(Token::Open(Mark::Color(fg.clone()))));
    }
    if let Some(bg) = &color.args.bg {
        out.push(Piece::Token(Token::Open(Mark::BgColor(bg.clone()))));
    }
    scope(pieces, inner_lo, inner_hi, out);
    if color.args.bg.is_some() {
        out.push(Piece::Token(Token::Close(BG_COLOR)));
    }
    if color.args.fg.is_some() {
        out.push(Piece::Token(Token::Close(COLOR)));
    }
    Some(end)
}

/// markdown-it reads `||…||` and `$[…]` from within the current scope only,
/// and reads each one's inside as a scope of its own.
fn scope(pieces: &[Piece], lo: usize, hi: usize, out: &mut Vec<Piece>) {
    let mut index = lo;
    while index < hi {
        let Some(piece) = pieces.get(index) else {
            break;
        };
        if piece.opens_link() {
            let end = link_end(pieces, index, hi);
            out.push(piece.clone());
            scope(pieces, index + 1, end, out);
            if let Some(close) = pieces.get(end).filter(|_| end < hi) {
                out.push(close.clone());
            }
            index = end + 1;
            continue;
        }
        if piece.glyph('|')
            && pieces.get(index + 1).is_some_and(|next| next.glyph('|'))
            && let Some(close) = spoiler_close(pieces, index + 2, hi)
            && spoiler_inner_valid(pieces, index + 2, close)
        {
            out.push(Piece::Token(Token::Open(Mark::Spoiler)));
            scope(pieces, index + 2, close, out);
            out.push(Piece::Token(Token::Close(SPOILER)));
            index = close + 2;
            continue;
        }
        if piece.glyph('$')
            && pieces.get(index + 1).is_some_and(|next| next.glyph('['))
            && let Some(end) = mfm(pieces, index, hi, out)
        {
            index = end;
            continue;
        }
        out.push(piece.clone());
        index += 1;
    }
}

/// Source text with its backslash escapes resolved, as markdown-it reads what
/// follows an MFM span.
fn unescaped(source: &str) -> Vec<Glyph> {
    let mut glyphs = Vec::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        match chars.peek() {
            Some(&next) if c == '\\' && next.is_ascii_punctuation() => {
                chars.next();
                glyphs.push(Glyph {
                    c: next,
                    literal: true,
                });
            }
            _ => glyphs.push(Glyph { c, literal: false }),
        }
    }
    glyphs
}

fn mfm_at(pieces: &[Piece], at: usize) -> bool {
    let chars = projection(pieces, at, pieces.len(), MFM_WINDOW);
    let source: String = chars.iter().map(|&(c, _)| c).collect();
    parse_mfm_unixtime(&source).is_some() || parse_mfm_color(&source).is_some()
}

/// markdown-it tries MFM at a `$` before the link rule sees the `[` after
/// it, so a link whose label MFM claims goes back to being text.
fn unlink_mfm(mut pieces: Vec<Piece>) -> Vec<Piece> {
    let mut index = 0;
    while index + 1 < pieces.len() {
        let dollar = pieces.get(index).is_some_and(|piece| piece.glyph('$'));
        if dollar && pieces.get(index + 1).is_some_and(Piece::opens_link) {
            let end = link_end(&pieces, index + 1, pieces.len());
            if let Some(Piece::Token(Token::LinkEnd(suffix))) = pieces.get(end) {
                let mut candidate = pieces.get(..=index).unwrap_or_default().to_vec();
                candidate.push(Piece::Glyph(Glyph {
                    c: '[',
                    literal: false,
                }));
                candidate.extend_from_slice(pieces.get(index + 2..end).unwrap_or_default());
                candidate.extend(unescaped(suffix).into_iter().map(Piece::Glyph));
                candidate.extend_from_slice(pieces.get(end + 1..).unwrap_or_default());
                if mfm_at(&candidate, index) {
                    pieces = candidate;
                }
            }
        }
        index += 1;
    }
    pieces
}

/// Spoilers and MFM, read after markdown so that emphasis inside them stays.
pub(super) fn sable_syntax(tokens: Vec<Token>) -> Vec<Token> {
    let pieces = unlink_mfm(pieces(tokens));
    let mut out = Vec::with_capacity(pieces.len());
    scope(&pieces, 0, pieces.len(), &mut out);
    self::tokens(out)
}

fn push_text(nodes: &mut Vec<Inline>, text: &str, marks: &[Mark]) {
    if text.is_empty() {
        return;
    }
    if let Some(Inline::Text(last, last_marks)) = nodes.last_mut()
        && last_marks == marks
    {
        last.push_str(text);
        return;
    }
    nodes.push(Inline::Text(text.to_owned(), marks.to_vec()));
}

/// Marks as `prosemirror-markdown` builds them: a closing drops every mark of its type.
pub(super) fn fold(tokens: Vec<Token>) -> Vec<Inline> {
    let mut marks: Vec<Mark> = Vec::new();
    let mut nodes = Vec::new();
    for token in tokens {
        match token {
            Token::Text(glyphs) => {
                let text: String = glyphs.iter().map(|glyph| glyph.c).collect();
                push_text(&mut nodes, &text, &marks);
            }
            Token::Code(code) => {
                let coded = add_mark(&marks, Mark::Code);
                push_text(&mut nodes, &code, &coded);
                marks = coded
                    .into_iter()
                    .filter(|mark| mark.rank() != CODE)
                    .collect();
            }
            Token::Break(_) => nodes.push(Inline::Break(marks.clone())),
            Token::Image { src, alt, title } => nodes.push(Inline::Image {
                src,
                alt,
                title,
                marks: marks.clone(),
            }),
            Token::Time { datetime, label } => nodes.push(Inline::Time {
                datetime,
                label,
                marks: marks.clone(),
            }),
            Token::Open(mark) => marks = add_mark(&marks, mark),
            Token::Close(rank) => marks.retain(|mark| mark.rank() != rank),
            Token::LinkEnd(_) => marks.retain(|mark| mark.rank() != LINK),
        }
    }
    nodes
}

/// Joins neighbouring text with the same marks, as a `ProseMirror` fragment does.
pub(super) fn merged(nodes: Vec<Inline>) -> Vec<Inline> {
    let mut out: Vec<Inline> = Vec::with_capacity(nodes.len());
    for node in nodes {
        match node {
            Inline::Text(text, marks) => push_text(&mut out, &text, &marks),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_drops_every_other_mark_and_a_mark_cannot_join_code() {
        let strong = vec![Mark::Strong, Mark::Link("u".to_owned())];
        assert_eq!(add_mark(&strong, Mark::Code), vec![Mark::Code]);
        assert_eq!(add_mark(&[Mark::Code], Mark::Spoiler), vec![Mark::Code]);
    }

    #[test]
    fn a_mark_takes_its_rank_and_replaces_its_own_type() {
        let set = add_mark(&[Mark::Link("u".to_owned())], Mark::Strong);
        assert_eq!(set, vec![Mark::Strong, Mark::Link("u".to_owned())]);
        let recolored = add_mark(
            &[Mark::Color("#000000".to_owned())],
            Mark::Color("#ffffff".to_owned()),
        );
        assert_eq!(recolored, vec![Mark::Color("#ffffff".to_owned())]);
    }

    #[test]
    fn the_time_label_is_the_composers_english_one() {
        assert_eq!(
            utc_label("2023-11-14T22:13:20Z"),
            "Nov 14, 2023, 22:13 (UTC)"
        );
    }
}
