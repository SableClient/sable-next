//! Rewrites applied to the source before comrak reads it. Each replaces text
//! comrak would misread with a reserved character that the reader swaps back,
//! so none of them needs to know whether it is inside code.

use crate::text::{head, span, tail};

/// The column after `text`, written from `column`, a tab reaching the next
/// multiple of four.
fn advance(text: &str, column: usize) -> usize {
    text.chars().fold(column, |column, c| {
        if c == '\t' {
            column + 4 - column % 4
        } else {
            column + 1
        }
    })
}

/// The columns of leading whitespace from `column` on, and its bytes.
fn leading(line: &str, column: usize) -> (usize, usize) {
    let bytes = line
        .bytes()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    (advance(head(line, bytes), column) - column, bytes)
}

/// `[-+*]` or up to nine digits and `.`/`)`, then a space or tab: the length
/// of the marker with that space.
fn list_marker(content: &str) -> Option<usize> {
    let bytes = content.as_bytes();
    let marker = match bytes.first()? {
        b'-' | b'+' | b'*' => 1,
        _ => {
            let digits = bytes
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            if !(1..=9).contains(&digits) || !matches!(bytes.get(digits), Some(b'.' | b')')) {
                return None;
            }
            digits + 1
        }
    };
    matches!(bytes.get(marker), Some(b' ' | b'\t')).then_some(marker + 1)
}

/// The length of the `](destination "title")` that opens `rest`, when it is one:
/// what is inside it is no inline syntax of its own.
fn link_tail(rest: &str) -> Option<usize> {
    let bytes = rest.as_bytes();
    let blank = |at: usize| {
        at + bytes
            .iter()
            .skip(at)
            .take_while(|byte| matches!(byte, b' ' | b'\t'))
            .count()
    };
    if !rest.starts_with("](") {
        return None;
    }
    let mut at = blank(2);
    if bytes.get(at) == Some(&b'<') {
        at += 1 + tail(rest, at + 1).find(['>', '\n'])?;
        at += usize::from(bytes.get(at) == Some(&b'>'));
    } else {
        let mut depth = 0_usize;
        while let Some(&byte) = bytes.get(at) {
            match byte {
                b'\\' => at += 1,
                b'(' => depth += 1,
                b')' if depth == 0 => break,
                b')' => depth -= 1,
                b' ' | b'\t' | b'\n' => break,
                _ => {}
            }
            at += 1;
        }
    }
    at = blank(at);
    if let Some(&open) = bytes
        .get(at)
        .filter(|byte| matches!(byte, b'"' | b'\'' | b'('))
    {
        let close = if open == b'(' { b')' } else { open };
        at += 1;
        while let Some(&byte) = bytes.get(at) {
            at += 1;
            match byte {
                b'\\' => at += 1,
                byte if byte == close => break,
                _ => {}
            }
        }
        at = blank(at);
    }
    (bytes.get(at) == Some(&b')')).then_some(at + 1)
}

// Each stands for a backslash and the character after it.
pub(super) const BACKSLASHED_PIPE: char = '\u{fdd0}';
pub(super) const ESCAPED_AMPERSAND: char = '\u{fdd1}';
pub(super) const ESCAPED_BACKSLASH: char = '\u{fdd2}';
/// The `$` of `$[fn …]`, which comrak would open math at.
pub(super) const FUNCTION_DOLLAR: char = '\u{fdd3}';
/// A `>` with no space after it, which is text and opens no quote.
pub(super) const UNSPACED_QUOTE: char = '\u{fdd4}';

/// The composer writes a pipe in a table cell as `\|`, after any backslash of
/// the cell's own. comrak pairs backslashes first, so after an even run of them
/// the pipe would end the cell.
fn mark_backslashed_pipes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = 0_usize;
    for c in text.chars() {
        if c == '|' && run > 0 && run.is_multiple_of(2) {
            out.pop();
            out.push(BACKSLASHED_PIPE);
        } else {
            out.push(c);
        }
        run = if c == '\\' { run + 1 } else { 0 };
    }
    out
}

/// comrak resolves entities in a destination or title before backslashes, so
/// `\&amp;` there would lose its entity, and it reads the quote after `\\` as
/// escaped when another quote follows.
fn mark_link_tails(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    while let Some(close) = tail(text, at).find(']').map(|found| at + found) {
        out.push_str(span(text, at, close));
        let end = close + link_tail(tail(text, close)).unwrap_or(1);
        let mut chars = span(text, close, end).chars();
        while let Some(c) = chars.next() {
            match (c, chars.clone().next()) {
                ('\\', Some('&')) => {
                    chars.next();
                    out.push(ESCAPED_AMPERSAND);
                }
                ('\\', Some('\\')) => {
                    chars.next();
                    out.push(ESCAPED_BACKSLASH);
                }
                ('\\', Some(next)) => {
                    chars.next();
                    out.push(c);
                    out.push(next);
                }
                _ => out.push(c),
            }
        }
        at = end;
    }
    out.push_str(tail(text, at));
    out
}

fn mark_function_dollars(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run = 0_usize;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let function =
            c == '$' && chars.peek() == Some(&'[') && run.is_multiple_of(2) && !out.ends_with('$');
        out.push(if function { FUNCTION_DOLLAR } else { c });
        run = if c == '\\' { run + 1 } else { 0 };
    }
    out
}

/// A `>` right before text opens no quote, unless the line above was quoted
/// that deep and this line continues it.
fn mark_unspaced_quotes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut above = 0;
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let (mut at, mut column, mut quotes) = (0, 0, 0);
        let mut unspaced = None;
        loop {
            let rest = tail(line, at);
            let (columns, spaces) = leading(rest, column);
            let content = tail(rest, spaces);
            let taken = if columns > 3 {
                break;
            } else if let Some(after) = content.strip_prefix('>') {
                let space = after.starts_with([' ', '\t']);
                if !space && quotes >= above {
                    unspaced = Some(at + spaces);
                    break;
                }
                quotes += 1;
                spaces + 1 + usize::from(space)
            } else if let Some(marker) = list_marker(content) {
                spaces + marker
            } else {
                break;
            };
            column = advance(head(rest, taken), column);
            at += taken;
        }
        above = quotes;
        match unspaced {
            Some(quote) => {
                out.push_str(head(line, quote));
                out.push(UNSPACED_QUOTE);
                out.push_str(tail(line, quote + 1));
            }
            None => out.push_str(line),
        }
    }
    out
}

pub(super) fn mark(source: &str) -> String {
    mark_function_dollars(&mark_link_tails(&mark_backslashed_pipes(
        &mark_unspaced_quotes(source),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quote_needs_a_space_unless_it_continues_one() {
        let q = UNSPACED_QUOTE;
        assert_eq!(mark_unspaced_quotes(">no space"), format!("{q}no space"));
        assert_eq!(mark_unspaced_quotes("> a\n>b"), "> a\n>b");
        assert_eq!(mark_unspaced_quotes("> >inner"), format!("> {q}inner"));
        assert_eq!(mark_unspaced_quotes("* >_<"), format!("* {q}_<"));
        assert_eq!(mark_unspaced_quotes("    >code"), "    >code");
    }
}
