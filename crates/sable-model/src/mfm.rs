//! The MFM subset the composer expands: `$[fg.color=…]`, `$[bg.color=…]`, `$[unixtime …]`. Offsets are UTF-16 code units.

use serde::Serialize;

use crate::civil::{MS_PER_DAY, days_from_civil, days_in_month, format_ms};
use crate::text::{trim, trim_start};

const MFM_SPAN_LIMIT: usize = 2048;
const MAX_UNIX_SECONDS: i64 = 253_402_300_799;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct MfmColorArgs {
    pub fg: Option<String>,
    pub bg: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct MfmColor {
    pub raw: String,
    pub args: MfmColorArgs,
    pub text: String,
    /// Where `text` starts in `raw`.
    pub offset: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct MfmUnixtime {
    pub raw: String,
    pub datetime: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ZonedInstant {
    #[cfg_attr(feature = "typegen", specta(type = specta_typescript::Number))]
    pub instant: i64,
    pub datetime: String,
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn is_hex_run(text: &str) -> bool {
    (text.len() == 3 || text.len() == 6) && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[must_use]
pub fn is_opaque_matrix_color(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(is_hex_run)
}

/// `#abc`, `abc`, `#aabbcc` or `aabbcc` as `#aabbcc`.
#[must_use]
pub fn normalize_mfm_hex(value: &str) -> Option<String> {
    let digits = value
        .strip_prefix('#')
        .unwrap_or(value)
        .to_ascii_lowercase();
    if !is_hex_run(&digits) {
        return None;
    }
    if digits.len() == 6 {
        return Some(format!("#{digits}"));
    }
    Some(digits.chars().fold("#".to_owned(), |mut hex, digit| {
        hex.push(digit);
        hex.push(digit);
        hex
    }))
}

/// The byte index of the `]` that closes the `$[` at the start of `src`,
/// looked for only within the first [`MFM_SPAN_LIMIT`] code units.
fn close_index(src: &str) -> Option<usize> {
    let mut depth = 0_i32;
    let mut units = 0;
    let mut chars = src.char_indices();
    while let Some((at, c)) = chars.next() {
        if units >= MFM_SPAN_LIMIT {
            return None;
        }
        units += c.len_utf16();
        if at == 0 {
            continue;
        }
        match c {
            '\\' => {
                if let Some((_, skipped)) = chars.next() {
                    units += skipped.len_utf16();
                }
            }
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(at);
                }
            }
            _ => {}
        }
    }
    None
}

/// `(?:fg|bg)\.color=#?(?:[0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])`, case-insensitive
/// on the hex only: the byte length of the token at the start of `text`.
fn color_token_len(text: &str) -> Option<usize> {
    let rest = text
        .strip_prefix("fg.color=")
        .or_else(|| text.strip_prefix("bg.color="))?;
    let hex = rest.strip_prefix('#').unwrap_or(rest);
    let run = hex.bytes().take_while(u8::is_ascii_hexdigit).count();
    if run != 3 && run != 6 {
        return None;
    }
    Some(text.len() - hex.len() + run)
}

/// `^((?:<token>[ \t]+)+)([\s\S]+)$`, with the backtracking a regex engine
/// would do when the text after the last token is empty.
fn split_color_function(inner: &str) -> Option<(&str, &str)> {
    let mut ends: Vec<(usize, usize)> = Vec::new();
    let mut at = 0;
    while let Some(token) = inner.get(at..).and_then(color_token_len) {
        let spaces = inner
            .get(at + token..)
            .unwrap_or_default()
            .bytes()
            .take_while(|byte| matches!(byte, b' ' | b'\t'))
            .count();
        if spaces == 0 {
            break;
        }
        at += token + spaces;
        ends.push((at, spaces));
    }
    let &(end, spaces) = ends.last()?;
    let split = if end < inner.len() {
        end
    } else if spaces >= 2 {
        end - 1
    } else {
        ends.len()
            .checked_sub(2)
            .and_then(|previous| ends.get(previous))?
            .0
    };
    Some(inner.split_at(split))
}

#[must_use]
pub fn parse_mfm_color_args(args: &str) -> Option<MfmColorArgs> {
    let mut result = MfmColorArgs::default();
    let tokens = trim(args)
        .split([' ', '\t'])
        .filter(|token| !token.is_empty());
    for token in tokens {
        if color_token_len(token)? != token.len() {
            return None;
        }
        let (side, value) = token.split_once(".color=")?;
        let value = normalize_mfm_hex(value);
        if side == "fg" {
            result.fg = value;
        } else {
            result.bg = value;
        }
    }
    (result.fg.is_some() || result.bg.is_some()).then_some(result)
}

#[must_use]
pub fn parse_mfm_color(src: &str) -> Option<MfmColor> {
    if !src.starts_with("$[fg.color=") && !src.starts_with("$[bg.color=") {
        return None;
    }
    let close = close_index(src)?;
    let (head, body) = split_color_function(src.get(2..close)?)?;
    let args = parse_mfm_color_args(head)?;
    let text = trim(body);
    if text.is_empty() {
        return None;
    }
    let offset = 2 + utf16_len(head) + utf16_len(body) - utf16_len(trim_start(body));
    Some(MfmColor {
        raw: src.get(..=close)?.to_owned(),
        args,
        text: text.to_owned(),
        offset: u32::try_from(offset).ok()?,
    })
}

#[must_use]
pub fn parse_mfm_unixtime(src: &str) -> Option<MfmUnixtime> {
    let rest = src.strip_prefix("$[unixtime")?;
    let digits_at = rest
        .bytes()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    if digits_at == 0 {
        return None;
    }
    let rest = rest.get(digits_at..)?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 || rest.as_bytes().get(digits) != Some(&b']') {
        return None;
    }
    let raw_len = "$[unixtime".len() + digits_at + digits + 1;
    Some(MfmUnixtime {
        raw: src.get(..raw_len)?.to_owned(),
        datetime: unixtime_datetime(rest.get(..digits)?)?,
    })
}

/// Whole seconds since 1970 as `YYYY-MM-DDTHH:MM:SSZ`, up to the year 9999.
#[must_use]
pub fn unixtime_datetime(seconds: &str) -> Option<String> {
    if seconds.is_empty() || !seconds.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let significant = seconds.trim_start_matches('0');
    if significant.len() > 12 {
        return None;
    }
    let seconds: i64 = if significant.is_empty() {
        0
    } else {
        significant.parse().ok()?
    };
    if seconds > MAX_UNIX_SECONDS {
        return None;
    }
    Some(format!("{}Z", format_ms(seconds * 1000)))
}

fn digits(text: &str, count: usize) -> Option<i64> {
    let run = text.get(..count)?;
    if !run.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    run.parse().ok()
}

/// `+hh:mm`, `+hhmm` or `Z` as minutes east of UTC and their canonical text.
fn offset_of(offset: &str) -> Option<(i64, String)> {
    if offset.eq_ignore_ascii_case("z") {
        return Some((0, "Z".to_owned()));
    }
    let sign = match offset.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let rest = offset.get(1..)?;
    let rest = match rest.len() {
        5 if rest.as_bytes().get(2) == Some(&b':') => {
            format!("{}{}", rest.get(..2)?, rest.get(3..)?)
        }
        4 => rest.to_owned(),
        _ => return None,
    };
    let hours = digits(&rest, 2)?;
    let minutes = digits(rest.get(2..)?, 2)?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    if hours == 0 && minutes == 0 {
        return Some((0, "Z".to_owned()));
    }
    let text = format!(
        "{}{hours:02}:{minutes:02}",
        if sign > 0 { '+' } else { '-' }
    );
    Some((sign * (hours * 60 + minutes), text))
}

/// `YYYY-MM-DDTHH:MM[:SS[.fff]](Z|±HH[:]MM)`, checked as a real date.
fn zoned_parts(value: &str) -> Option<(String, i64)> {
    let bytes = value.as_bytes();
    let separators = [(4, b'-'), (7, b'-'), (13, b':')];
    if separators
        .iter()
        .any(|&(at, byte)| bytes.get(at) != Some(&byte))
        || !matches!(bytes.get(10), Some(b'T' | b't'))
    {
        return None;
    }
    let year = digits(value, 4)?;
    let month = digits(value.get(5..)?, 2)?;
    let day = digits(value.get(8..)?, 2)?;
    let hour = digits(value.get(11..)?, 2)?;
    let minute = digits(value.get(14..)?, 2)?;
    let mut rest = value.get(16..)?;
    let mut second = 0;
    if let Some(seconds) = rest.strip_prefix(':') {
        second = digits(seconds, 2)?;
        rest = seconds.get(2..)?;
        if let Some(fraction) = rest.strip_prefix('.') {
            let run = fraction.bytes().take_while(u8::is_ascii_digit).count();
            if run == 0 {
                return None;
            }
            rest = fraction.get(run..)?;
        }
    }
    let (offset_minutes, offset) = offset_of(rest)?;
    if !(1..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let datetime = format!(
        "{}-{}-{}T{}:{}:{second:02}{offset}",
        value.get(..4)?,
        value.get(5..7)?,
        value.get(8..10)?,
        value.get(11..13)?,
        value.get(14..16)?
    );
    let instant = days_from_civil(year, month, day) * MS_PER_DAY
        + ((hour * 60 + minute - offset_minutes) * 60 + second) * 1000;
    Some((datetime, instant))
}

#[must_use]
pub fn canonical_datetime(value: &str) -> Option<String> {
    zoned_parts(value).map(|(datetime, _)| datetime)
}

#[must_use]
pub fn parse_zoned_datetime(value: &str) -> Option<ZonedInstant> {
    zoned_parts(value).map(|(datetime, instant)| ZonedInstant { instant, datetime })
}

/// Whole seconds since 1970, or `None` before it.
#[must_use]
pub fn unix_seconds_of(datetime: &str) -> Option<String> {
    let instant = parse_zoned_datetime(datetime)?.instant;
    let seconds = instant.div_euclid(1000);
    (seconds >= 0).then(|| seconds.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn color(src: &str) -> Option<(String, Option<String>, Option<String>, u32)> {
        parse_mfm_color(src).map(|color| (color.text, color.args.fg, color.args.bg, color.offset))
    }

    #[test]
    fn hex_values_normalize_to_six_lowercase_digits() {
        assert_eq!(normalize_mfm_hex("F0a").as_deref(), Some("#ff00aa"));
        assert_eq!(normalize_mfm_hex("#ABCDEF").as_deref(), Some("#abcdef"));
        assert_eq!(normalize_mfm_hex("abcd"), None);
        assert!(is_opaque_matrix_color("#AbC"));
        assert!(!is_opaque_matrix_color("abc"));
    }

    #[test]
    fn a_colour_reads_its_arguments_and_text() {
        assert_eq!(
            color("$[fg.color=f00 bg.color=#00FF00  hello [world]] tail"),
            Some((
                "hello [world]".to_owned(),
                Some("#ff0000".to_owned()),
                Some("#00ff00".to_owned()),
                33
            ))
        );
        assert_eq!(
            parse_mfm_color("$[fg.color=f00 hi] tail").map(|color| color.raw),
            Some("$[fg.color=f00 hi]".to_owned())
        );
        assert_eq!(color("$[fg.color=f00f hi]"), None);
        assert_eq!(color("$[fg.color=f00hi]"), None);
        assert_eq!(
            color("$[fg.color=f00 \\] still]"),
            Some(("\\] still".to_owned(), Some("#ff0000".to_owned()), None, 15))
        );
    }

    #[test]
    fn a_trailing_argument_is_text_as_a_regex_would_backtrack() {
        assert_eq!(
            color("$[fg.color=f00 bg.color=0f0 ]"),
            Some((
                "bg.color=0f0".to_owned(),
                Some("#ff0000".to_owned()),
                None,
                15
            ))
        );
        assert_eq!(color("$[fg.color=f00 bg.color=0f0  ]"), None);
        assert_eq!(color("$[fg.color=f00 ]"), None);
    }

    #[test]
    fn offsets_count_utf16_and_the_close_is_bounded() {
        assert_eq!(
            color("$[fg.color=f00 \t😀 x]").map(|color| color.3),
            Some(16)
        );
        assert_eq!(
            color(&format!("$[fg.color=f00 {}]", "a".repeat(100))).map(|color| color.0.len()),
            Some(100)
        );
        assert_eq!(
            color(&format!("$[fg.color=f00 {}]", "a".repeat(5000))),
            None
        );
    }

    #[test]
    fn unixtime_becomes_a_utc_datetime() {
        let parsed = parse_mfm_unixtime("$[unixtime  1700000000] later").expect("a time");
        assert_eq!(parsed.raw, "$[unixtime  1700000000]");
        assert_eq!(parsed.datetime, "2023-11-14T22:13:20Z");
        assert_eq!(
            unixtime_datetime("0").as_deref(),
            Some("1970-01-01T00:00:00Z")
        );
        assert_eq!(
            unixtime_datetime("000000000000000000000001").as_deref(),
            Some("1970-01-01T00:00:01Z")
        );
        assert_eq!(
            unixtime_datetime("253402300799").as_deref(),
            Some("9999-12-31T23:59:59Z")
        );
        assert_eq!(unixtime_datetime("253402300800"), None);
        assert_eq!(parse_mfm_unixtime("$[unixtime1]"), None);
        assert_eq!(parse_mfm_unixtime("$[unixtime 1x]"), None);
    }

    #[test]
    fn datetimes_are_checked_and_canonical() {
        assert_eq!(
            canonical_datetime("2026-09-23t14:05+0200").as_deref(),
            Some("2026-09-23T14:05:00+02:00")
        );
        assert_eq!(
            canonical_datetime("2024-02-29T00:00:59.123-00:00").as_deref(),
            Some("2024-02-29T00:00:59Z")
        );
        for invalid in [
            "2023-02-29T00:00Z",
            "2026-13-01T00:00Z",
            "2026-01-01T24:00Z",
            "2026-01-01T00:60Z",
            "2026-01-01T00:00:60Z",
            "2026-01-01T00:00+24:00",
            "2026-01-01T00:00",
            "2026-01-01T00:00:00.Z",
            "0000-01-01T00:00Z",
            "2026-01-01 00:00Z",
        ] {
            assert_eq!(canonical_datetime(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn instants_honour_the_offset() {
        let zoned = parse_zoned_datetime("2023-11-14T23:13:20+01:00").expect("a datetime");
        assert_eq!(zoned.instant, 1_700_000_000_000);
        assert_eq!(
            unix_seconds_of("2023-11-14T22:13:20Z").as_deref(),
            Some("1700000000")
        );
        assert_eq!(unix_seconds_of("1969-12-31T23:59:59Z"), None);
        assert_eq!(
            parse_zoned_datetime("0001-01-01T00:00Z").map(|zoned| zoned.instant),
            Some(-62_135_596_800_000)
        );
    }
}
