//! The MFM subset the composer expands: `$[fg.color=…]`, `$[bg.color=…]`, `$[unixtime …]`. Offsets are UTF-16 code units.

use std::sync::LazyLock;

use jiff::{SignedDuration, civil::DateTime, fmt::temporal::Pieces};
use regex_lite::Regex;
use serde::Serialize;

use crate::civil::{format_datetime, format_ms};
use crate::color::is_hex_color;
use crate::text::{trim, trim_start};

const MFM_SPAN_LIMIT: usize = 2048;

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

#[must_use]
pub fn is_opaque_matrix_color(value: &str) -> bool {
    is_hex_color(value, &[3, 6])
}

/// `#abc`, `abc`, `#aabbcc` or `aabbcc` as `#aabbcc`.
#[must_use]
pub fn normalize_mfm_hex(value: &str) -> Option<String> {
    let mut color = value.to_ascii_lowercase();
    if !color.starts_with('#') {
        color.insert(0, '#');
    }
    if !is_hex_color(&color, &[3, 6]) {
        return None;
    }
    if color.len() == 7 {
        return Some(color);
    }
    let digits = color.get(1..)?;
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

const UNIXTIME_ARG_SCAN: usize = 40;

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
    let arg_len = rest
        .bytes()
        .take(UNIXTIME_ARG_SCAN)
        .position(|byte| byte == b']')?;
    let arg = rest.get(..arg_len)?;
    let datetime = if arg.bytes().all(|byte| byte.is_ascii_digit()) {
        unixtime_datetime(arg)?
    } else {
        unixtime_datetime(&unix_seconds_of(arg)?)?
    };
    let raw_len = "$[unixtime".len() + digits_at + arg_len + 1;
    Some(MfmUnixtime {
        raw: src.get(..raw_len)?.to_owned(),
        datetime,
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
    Some(format!("{}Z", format_ms(seconds * 1000)?))
}

#[expect(
    clippy::expect_used,
    reason = "a literal pattern, compiled by every zoned datetime test"
)]
static ZONED_DATETIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\A([0-9]{4}-[0-9]{2}-[0-9]{2}[Tt][0-9]{2}:[0-9]{2})(?::([0-5][0-9])(?:\.[0-9]+)?)?([Zz]|[+-](?:[01][0-9]|2[0-3]):?[0-5][0-9])\z",
    )
    .expect("the zoned datetime pattern is valid")
});

/// `YYYY-MM-DDTHH:MM[:SS[.fff]](Z|±HH[:]MM)`, checked as a real date.
fn zoned_parts(value: &str) -> Option<(String, i64)> {
    // Keep the accepted grammar stricter than Jiff's and discard fractions of any length.
    let parts = ZONED_DATETIME.captures(value)?;
    let local = parts.get(1)?.as_str();
    let second = parts.get(2).map_or("00", |part| part.as_str());
    let offset = parts.get(3)?.as_str();
    let normalized = format!("{local}:{second}{offset}");
    let pieces = Pieces::parse(&normalized).ok()?;
    let local = pieces.date().to_datetime(pieces.time()?);
    if local.year() < 1 {
        return None;
    }
    let offset = pieces.to_numeric_offset()?;
    // Civil durations retain dates near year 9999 that exceed Jiff's timestamp range.
    let instant = local
        .duration_since(DateTime::constant(1970, 1, 1, 0, 0, 0, 0))
        .checked_sub(SignedDuration::from_secs(i64::from(offset.seconds())))?;
    let offset = if offset.seconds() == 0 {
        "Z".to_owned()
    } else {
        let text = offset.to_string();
        if text.len() == 3 {
            format!("{text}:00")
        } else {
            text
        }
    };
    let datetime = format!("{}{offset}", format_datetime(local));
    let instant = i64::try_from(instant.as_millis()).ok()?;
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
        assert_eq!(parse_mfm_unixtime("$[unixtime ]"), None);
    }

    #[test]
    fn unixtime_accepts_an_iso_datetime() {
        let parsed =
            parse_mfm_unixtime("$[unixtime 2026-11-01T14:30+01:00] later").expect("a time");
        assert_eq!(parsed.raw, "$[unixtime 2026-11-01T14:30+01:00]");
        assert_eq!(parsed.datetime, "2026-11-01T13:30:00Z");
        assert_eq!(
            parse_mfm_unixtime("$[unixtime 2026-11-01T14:30:15Z]").map(|unix| unix.datetime),
            Some("2026-11-01T14:30:15Z".to_owned())
        );
        for invalid in [
            "$[unixtime 2026-11-01T14:30]",
            "$[unixtime 2026-02-30T14:30Z]",
            "$[unixtime 1969-12-31T23:59Z]",
            "$[unixtime 2026-11-01 14:30Z]",
        ] {
            assert_eq!(parse_mfm_unixtime(invalid), None, "{invalid}");
        }
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

    #[test]
    fn zoned_dates_keep_the_local_clock_and_discard_fractional_seconds() {
        for (value, canonical, instant) in [
            (
                "1970-01-01t01:00:00.12345678901234567890+0100",
                "1970-01-01T01:00:00+01:00",
                0,
            ),
            ("1970-01-01T00:00:00.999z", "1970-01-01T00:00:00Z", 0),
            ("1970-01-01T00:00-0000", "1970-01-01T00:00:00Z", 0),
            (
                "1970-01-01T00:00+23:59",
                "1970-01-01T00:00:00+23:59",
                -86_340_000,
            ),
        ] {
            assert_eq!(
                parse_zoned_datetime(value),
                Some(ZonedInstant {
                    instant,
                    datetime: canonical.to_owned(),
                }),
                "{value}"
            );
        }
    }

    #[test]
    fn zoned_dates_reject_jiff_extensions_outside_the_composer_grammar() {
        for value in [
            "2026-01-01T00:00+02",
            "2026-01-01T00:00+02:00:00",
            "2026-01-01T00:00+23:60",
            "2026-01-01T00:00-2400",
            "2026-01-01T00:00Z[UTC]",
            "+002026-01-01T00:00Z",
            "2026-01-01T00:00.5Z",
            "2026-01-01T00:00Z\n",
        ] {
            assert_eq!(parse_zoned_datetime(value), None, "{value}");
        }
    }

    #[test]
    fn zoned_dates_cover_the_full_four_digit_year_range() {
        for (value, instant) in [
            ("0001-01-01T00:00:00+23:59", -62_135_683_140_000),
            ("9999-12-31T23:59:59Z", 253_402_300_799_000),
            ("9999-12-31T23:59:59-23:59", 253_402_387_139_000),
        ] {
            assert_eq!(
                parse_zoned_datetime(value),
                Some(ZonedInstant {
                    instant,
                    datetime: value.to_owned(),
                }),
                "{value}"
            );
        }
    }
}
