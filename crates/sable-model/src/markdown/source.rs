//! The source rewritten so that pulldown-cmark reads the blocks markdown-it
//! does. The composer's markdown-it differs in a few block rules:
//!
//! - `>` opens a quote only when a space or tab follows it;
//! - there are no HTML blocks, since the composer parses with `html: false`;
//! - a table is tried before any other block, may interrupt a paragraph, and
//!   ends at a line indented as code;
//! - `-# text` is one line of subtext, which [`prepare`] sets apart with blank
//!   lines so that nothing around it joins it;
//! - a single `~` is text, and a run of three is a lone `~` beside a `~~`.

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

fn indent(line: &str) -> usize {
    leading(line, 0).0
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

struct Fence {
    marker: u8,
    run: usize,
    /// Where the fence's content starts in its line; a later line whose
    /// content starts before it has left the fence's container.
    offset: usize,
}

fn fence_opening(content: &str, offset: usize) -> Option<Fence> {
    let marker = *content.as_bytes().first()?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let run = content.bytes().take_while(|byte| *byte == marker).count();
    let info = tail(content, run);
    (run >= 3 && !(marker == b'`' && info.contains('`'))).then_some(Fence {
        marker,
        run,
        offset,
    })
}

fn is_autolink(content: &str) -> bool {
    let Some(end) = content.find('>') else {
        return false;
    };
    let inner = span(content, 1, end);
    if inner.is_empty() || inner.contains(|c: char| c.is_whitespace() || c == '<') {
        return false;
    }
    let scheme = inner.split(':').next().unwrap_or_default();
    let uri = inner.contains(':')
        && (2..=32).contains(&scheme.len())
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    uri || inner
        .split_once('@')
        .is_some_and(|(user, host)| !user.is_empty() && host.contains('.'))
}

/// A line start pulldown-cmark would read as the start of an HTML block.
fn opens_html(content: &str) -> bool {
    content.starts_with('<')
        && tail(content, 1)
            .starts_with(|c: char| c.is_ascii_alphabetic() || matches!(c, '/' | '!' | '?'))
        && !is_autolink(content)
}

#[derive(Default)]
struct Line {
    /// Quote markers, which a continuation line may repeat without a space.
    quotes: usize,
    /// The containers this line is in, as a blank line beside it has to repeat
    /// them: its quote markers, with each list marker as spaces.
    prefix: String,
    subtext: bool,
}

/// Tilde runs as markdown-it reads them: a single `~` is text, a run of three is a lone `~` beside `~~`.
/// The lone ones are escaped; code spans and autolinks are left alone.
fn split_tildes(content: &str) -> String {
    let mut out = String::with_capacity(content.len() + 2);
    let mut code: Option<usize> = None;
    let mut open = false;
    let mut at = 0;
    while let Some(c) = tail(content, at).chars().next() {
        let rest = tail(content, at);
        let run = rest.chars().take_while(|next| *next == c).count();
        let run_bytes = run * c.len_utf8();
        if c == '\\' && code.is_none() {
            let escaped = rest.chars().take(2).map(char::len_utf8).sum::<usize>();
            out.push_str(head(rest, escaped));
            at += escaped;
            continue;
        }
        if c == '<' && code.is_none() && is_autolink(rest) {
            let end = rest.find('>').map_or(rest.len(), |end| end + 1);
            out.push_str(head(rest, end));
            at += end;
            continue;
        }
        if c == '`' {
            code = match code {
                Some(open) if open == run => None,
                None => Some(run),
                other => other,
            };
        }
        if c == '~' && code.is_none() && matches!(run, 1..=3) {
            let before = head(content, at).chars().next_back().unwrap_or(' ');
            let after = tail(content, at + run_bytes).chars().next().unwrap_or(' ');
            let (opens, closes) = flanking_chars(before, after);
            let closing = closes && open;
            out.push_str(match run {
                1 => "\\~",
                2 => "~~",
                _ if closing => "~~\\~",
                _ if opens && at > 0 && !(open && delimiter_punctuation(after)) => "\\~~~",
                _ => "~~~",
            });
            if run > 1 && (closing || opens) {
                open = !closing;
            }
        } else {
            out.push_str(head(rest, run_bytes));
        }
        at += run_bytes;
    }
    out
}

/// `-# text`, which markdown-it reads as one line of subtext.
fn is_subtext(content: &str) -> bool {
    content
        .strip_prefix("-#")
        .is_some_and(|text| text.starts_with([' ', '\t']) && !text.trim().is_empty())
}

/// One source line with the quote, HTML and tilde rewrites; `quotes`, `in_code` and `in_paragraph` carry state from earlier lines.
fn prepare_line(
    line: &str,
    quotes: usize,
    in_code: bool,
    in_paragraph: bool,
    out: &mut String,
) -> Line {
    let mut at = 0;
    let mut column = 0;
    let mut info = Line::default();
    loop {
        let rest = tail(line, at);
        let (columns, spaces) = leading(rest, column);
        if columns > 3 {
            out.push_str(rest);
            return info;
        }
        let content = tail(rest, spaces);
        if let Some(after) = content.strip_prefix('>') {
            let space_after = after.starts_with([' ', '\t']);
            if space_after || info.quotes < quotes {
                let taken = spaces + 1 + usize::from(space_after);
                out.push_str(head(rest, taken));
                info.prefix.push_str(head(rest, taken));
                column = advance(head(rest, taken), column);
                at += taken;
                info.quotes += 1;
                continue;
            }
            out.push_str(head(rest, spaces));
            out.push('\\');
            out.push_str(content);
            return info;
        }
        if let Some(marker) = list_marker(content) {
            let ordered = content.starts_with(|c: char| c.is_ascii_digit());
            if in_paragraph
                && at == 0
                && ordered
                && !content.starts_with("1.")
                && !content.starts_with("1)")
            {
                out.push_str(rest);
                return info;
            }
            let taken = spaces + marker;
            let next = advance(head(rest, taken), column);
            info.prefix.push_str(&" ".repeat(next - column));
            out.push_str(head(rest, taken));
            column = next;
            at += taken;
            continue;
        }
        out.push_str(head(rest, spaces));
        if !in_code && opens_html(content) {
            out.push('\\');
        }
        if in_code || fence_opening(content, 0).is_some() {
            out.push_str(content);
        } else {
            out.push_str(&split_tildes(content));
        }
        info.subtext = is_subtext(content);
        if content.trim().is_empty() {
            info.quotes = 0;
        }
        return info;
    }
}

/// The content of `line` once its quote and list markers are skipped.
pub(super) fn content_of(line: &str) -> &str {
    let mut rest = line;
    loop {
        let (columns, spaces) = leading(rest, 0);
        if columns > 3 {
            return rest;
        }
        let trimmed = tail(rest, spaces);
        if let Some(after) = trimmed.strip_prefix('>') {
            rest = after.strip_prefix([' ', '\t']).unwrap_or(after);
        } else if let Some(marker) = list_marker(trimmed) {
            rest = tail(trimmed, marker);
        } else {
            return trimmed;
        }
    }
}

/// The length of the backtick run an inline code span left open after
/// `line`, given the one open before it.
fn open_code_after(line: &str, mut open: Option<usize>) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut at = 0;
    while let Some(&byte) = bytes.get(at) {
        if byte == b'\\' && open.is_none() {
            at += 2;
            continue;
        }
        if byte == b'`' {
            let run = bytes
                .iter()
                .skip(at)
                .take_while(|next| **next == b'`')
                .count();
            open = match open {
                Some(length) if length == run => None,
                None => Some(run),
                other => other,
            };
            at += run;
            continue;
        }
        at += 1;
    }
    open
}

/// markdown-it's `escapedSplit`: a pipe right after a backslash is no border,
/// and an empty first or last cell is dropped.
fn table_cells(line: &str) -> usize {
    let mut cells = vec![String::new()];
    let mut escaped = false;
    for c in line.chars() {
        if c == '|' && !escaped {
            cells.push(String::new());
        } else if let Some(cell) = cells.last_mut() {
            cell.push(c);
        }
        escaped = c == '\\';
    }
    if cells.first().is_some_and(String::is_empty) {
        cells.remove(0);
    }
    if cells.last().is_some_and(String::is_empty) {
        cells.pop();
    }
    cells.len()
}

/// The column count of a table's delimiter row, `| --- | :-: |`. It takes two
/// characters at least, and `- ` cannot open it, which would be a list.
fn delimiter_columns(line: &str) -> Option<usize> {
    let trimmed = line.trim();
    let mut chars = trimmed.chars();
    let (first, second) = (chars.next()?, chars.next()?);
    if !matches!(first, '|' | '-' | ':')
        || (first == '-' && matches!(second, ' ' | '\t'))
        || !trimmed
            .chars()
            .all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'))
    {
        return None;
    }
    let columns: Vec<&str> = trimmed.split('|').collect();
    let mut count = 0;
    for (index, column) in columns.iter().enumerate() {
        let column = column.trim();
        if column.is_empty() {
            if index == 0 || index == columns.len() - 1 {
                continue;
            }
            return None;
        }
        let dashes = column.strip_prefix(':').unwrap_or(column);
        let dashes = dashes.strip_suffix(':').unwrap_or(dashes);
        if dashes.is_empty() || !dashes.bytes().all(|byte| byte == b'-') {
            return None;
        }
        count += 1;
    }
    (count > 0).then_some(count)
}

/// Whether `line` has a pipe no backslash escapes.
fn has_border(line: &str) -> bool {
    let mut escaped = false;
    line.chars().any(|c| {
        let border = c == '|' && !escaped;
        escaped = c == '\\';
        border
    })
}

fn table_starts(header: &str, delimiter: &str) -> bool {
    if indent(header) > 3 || indent(delimiter) > 3 || !header.contains('|') {
        return false;
    }
    delimiter_columns(delimiter) == Some(table_cells(header.trim()))
}

/// A table header with whatever pulldown-cmark would read as another block's
/// start escaped, since markdown-it tries the table first.
fn table_header(line: &str, out: &mut String) {
    let spaces = indent(line);
    let content = tail(line, spaces);
    let block = content.starts_with(['#', '>', '='])
        || opens_html(content)
        || fence_opening(content, 0).is_some();
    let escape = list_marker(content).map_or_else(
        || block.then_some(spaces),
        |marker| Some(spaces + marker - 2),
    );
    match escape {
        Some(at) => {
            out.push_str(head(line, at));
            out.push('\\');
            out.push_str(tail(line, at));
        }
        None => out.push_str(line),
    }
}

fn is_rule(content: &str) -> bool {
    let marks: String = content
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t'))
        .collect();
    marks.len() >= 3
        && ['-', '*', '_']
            .iter()
            .any(|mark| marks.chars().all(|c| c == *mark))
}

/// A table row of nothing but pipes, which markdown-it reads as a row of
/// empty cells and pulldown-cmark as text.
fn empty_row(line: &str) -> bool {
    line.contains('|') && line.trim().chars().all(|c| matches!(c, '|' | ' ' | '\t'))
}

#[derive(Default)]
struct Prepared {
    out: String,
    quotes: usize,
    fence: Option<Fence>,
    open_code: Option<usize>,
    table: bool,
    pipe_next: bool,
    in_container: bool,
    blank_after: Option<String>,
}

impl Prepared {
    /// Copies a line inside a fenced code block as it is; false once `line`
    /// has left the fence's container, which ends the fence too.
    fn fenced(&mut self, line: &str, blank: bool, content: &str, offset: usize) -> bool {
        let Some(open) = &self.fence else {
            return false;
        };
        if !blank && offset < open.offset {
            self.fence = None;
            return false;
        }
        let closing = content
            .bytes()
            .take_while(|byte| *byte == open.marker)
            .count();
        if closing >= open.run && tail(content, closing).trim().is_empty() {
            self.fence = None;
        }
        self.out.push_str(line);
        true
    }

    /// A table's body row; false when `line` ends the table instead.
    fn table_row(&mut self, line: &str, blank: bool, content: &str, offset: usize) -> bool {
        if self.pipe_next {
            self.pipe_next = false;
            self.out.push('|');
            self.out.push_str(line);
            return true;
        }
        if !self.table {
            return false;
        }
        let terminates = offset > indent(line)
            || content.starts_with('#')
            || opens_html(content)
            || fence_opening(content, 0).is_some()
            || is_rule(content)
            || is_subtext(content);
        if blank || terminates {
            self.table = false;
        } else if indent(line) > 3 {
            self.out.push('\n');
            self.table = false;
        } else if empty_row(line) {
            self.out.push_str("| |");
            return true;
        }
        false
    }

    fn table_header(&mut self, line: &str, previous: Option<&str>, next: &str) {
        if previous.is_some_and(|previous| !previous.trim().is_empty()) {
            self.out.push('\n');
        }
        if !has_border(line) || !next.contains('|') {
            self.out.push('|');
            self.pipe_next = true;
        }
        table_header(line, &mut self.out);
        self.table = true;
        self.quotes = 0;
        self.open_code = None;
    }

    fn line(&mut self, line: &str, previous: Option<&str>, next: Option<&str>) {
        let blank = line.trim().is_empty();
        let content = content_of(line);
        let offset = line.len() - content.len();
        if self.fenced(line, blank, content, offset) {
            return;
        }
        if let Some(prefix) = self.blank_after.take()
            && !blank
        {
            self.out.push_str(&prefix);
            self.out.push('\n');
        }
        let after_table = self.table || self.pipe_next;
        if self.table_row(line, blank, content, offset) {
            return;
        }
        let container_before = self.in_container;
        let lazy = self.in_container && offset == indent(line);
        self.in_container = !blank && (self.in_container || offset > indent(line));
        if let Some(next) = next
            && !self.table
            && !blank
            && !lazy
            && indent(line) <= 3
            && table_starts(line, next)
        {
            self.table_header(line, previous, next);
            return;
        }
        let previous_blank = previous.is_none_or(|previous| previous.trim().is_empty());
        let in_paragraph = !previous_blank
            && !after_table
            && !container_before
            && !previous.is_some_and(|previous| content_of(previous).starts_with('#'));
        let mut rewritten = String::with_capacity(line.len() + 2);
        let info = prepare_line(
            line,
            self.quotes,
            self.open_code.is_some(),
            in_paragraph,
            &mut rewritten,
        );
        self.quotes = info.quotes;
        if info.subtext && !self.table {
            if !previous_blank {
                self.out.push_str(&info.prefix);
                self.out.push('\n');
            }
            self.blank_after = Some(info.prefix);
        }
        let rewritten_content = content_of(&rewritten);
        let rewritten_offset = rewritten.len() - rewritten_content.len();
        if !self.table
            && let Some(opened) = fence_opening(rewritten_content, rewritten_offset)
        {
            self.fence = Some(opened);
            self.open_code = None;
        } else if blank {
            self.open_code = None;
        } else {
            self.open_code = open_code_after(line, self.open_code);
        }
        self.out.push_str(&rewritten);
    }
}

pub(super) fn prepare(source: &str) -> String {
    let lines: Vec<&str> = source.split('\n').collect();
    let mut prepared = Prepared {
        out: String::with_capacity(source.len() + 16),
        ..Prepared::default()
    };
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            prepared.out.push('\n');
        }
        let previous = index
            .checked_sub(1)
            .and_then(|previous| lines.get(previous))
            .copied();
        prepared.line(line, previous, lines.get(index + 1).copied());
    }
    prepared.out
}

fn delimiter_punctuation(c: char) -> bool {
    c.is_ascii_punctuation() || (!c.is_ascii() && !c.is_alphanumeric() && !c.is_whitespace())
}

/// Whether a delimiter run between `before` and `after` is left- and
/// right-flanking.
pub(super) fn flanking_chars(before: char, after: char) -> (bool, bool) {
    let left = !after.is_whitespace()
        && (!delimiter_punctuation(after)
            || before.is_whitespace()
            || delimiter_punctuation(before));
    let right = !before.is_whitespace()
        && (!delimiter_punctuation(before)
            || after.is_whitespace()
            || delimiter_punctuation(after));
    (left, right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quote_needs_a_space_unless_it_continues_one() {
        assert_eq!(prepare(">no space"), "\\>no space");
        assert_eq!(prepare("> a\n>b"), "> a\n>b");
        assert_eq!(prepare("> >inner"), "> \\>inner");
    }

    #[test]
    fn html_cannot_open_a_block_but_an_autolink_stays() {
        assert_eq!(prepare("<div>x</div>"), "\\<div>x</div>");
        assert_eq!(prepare("<https://example.org>"), "<https://example.org>");
        assert_eq!(prepare("`a\n<b>`"), "`a\n<b>`");
    }

    #[test]
    fn a_table_interrupts_a_paragraph_and_outranks_other_blocks() {
        assert_eq!(prepare("text\n# | a\n-|-"), "text\n\n\\# | a\n-|-");
        assert_eq!(prepare("text\n# | a\n- | -"), "text\n# | a\n- | -");
        assert_eq!(prepare("a | b\n- | - | -"), "a | b\n- | - | -");
        assert_eq!(
            prepare("| a |\n| - |\n    code"),
            "| a |\n| - |\n\n    code"
        );
    }

    #[test]
    fn a_fence_ends_with_its_container() {
        assert_eq!(prepare("- ```\n\n>x"), "- ```\n\n\\>x");
    }
}
