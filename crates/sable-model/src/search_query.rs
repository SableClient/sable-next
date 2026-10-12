use serde::Serialize;

use crate::text::is_space;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum SearchOperator {
    In,
    Space,
    From,
    Mentions,
    Has,
    Before,
    After,
    During,
    On,
    With,
    Is,
    Pinned,
    Regex,
}

impl SearchOperator {
    pub const ALL: [Self; 13] = [
        Self::In,
        Self::Space,
        Self::From,
        Self::Mentions,
        Self::Has,
        Self::Before,
        Self::After,
        Self::During,
        Self::On,
        Self::With,
        Self::Is,
        Self::Pinned,
        Self::Regex,
    ];

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::In => "in",
            Self::Space => "space",
            Self::From => "from",
            Self::Mentions => "mentions",
            Self::Has => "has",
            Self::Before => "before",
            Self::After => "after",
            Self::During => "during",
            Self::On => "on",
            Self::With => "with",
            Self::Is => "is",
            Self::Pinned => "pinned",
            Self::Regex => "regex",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|operator| operator.name() == name)
    }

    const fn is_date(self) -> bool {
        matches!(self, Self::Before | Self::After | Self::During | Self::On)
    }
}

/// `start` and `end` are UTF-16 offsets, so they index the JS string the
/// query was typed into.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct SearchToken {
    pub operator: SearchOperator,
    pub value: String,
    pub negated: bool,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "typegen", derive(specta::Type))]
pub struct ParsedQuery {
    pub text: String,
    pub phrases: Vec<String>,
    pub exclude: Vec<String>,
    pub tokens: Vec<SearchToken>,
    /// Negated date bounds, which no filter can express.
    pub unsupported: Vec<String>,
}

/// One of `-?word:"…"`, `-?"…"` or a run of non-space, tried in that order.
fn segment_end(chars: &[char], start: usize) -> usize {
    let closing_quote = |from: usize| {
        chars
            .get(from..)
            .and_then(|rest| rest.iter().position(|c| *c == '"'))
            .map(|offset| from + offset + 1)
    };
    let dash = usize::from(chars.get(start) == Some(&'-'));
    let letters = chars.get(start + dash..).map_or(0, |rest| {
        rest.iter().take_while(|c| c.is_ascii_alphabetic()).count()
    });
    let word = start + dash + letters;
    if letters > 0
        && chars.get(word) == Some(&':')
        && chars.get(word + 1) == Some(&'"')
        && let Some(end) = closing_quote(word + 2)
    {
        return end;
    }
    if chars.get(start + dash) == Some(&'"')
        && let Some(end) = closing_quote(start + dash + 1)
    {
        return end;
    }
    start
        + chars
            .get(start..)
            .map_or(0, |rest| rest.iter().take_while(|c| !is_space(**c)).count())
}

fn utf16_len(chars: &[char]) -> u32 {
    let units: usize = chars.iter().map(|c| c.len_utf16()).sum();
    u32::try_from(units).unwrap_or(u32::MAX)
}

fn unquoted(raw: &str) -> &str {
    raw.strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(raw)
}

#[must_use]
pub fn parse_search_query(input: &str) -> ParsedQuery {
    let chars: Vec<char> = input.chars().collect();
    let mut parsed = ParsedQuery::default();
    let mut words: Vec<String> = Vec::new();
    let mut position = 0;
    let mut offset = 0_u32;

    while position < chars.len() {
        if let Some(space) = chars
            .get(position..=position)
            .filter(|c| c.iter().all(|c| is_space(*c)))
        {
            offset += utf16_len(space);
            position += 1;
            continue;
        }
        let end = segment_end(&chars, position);
        let segment_chars = chars.get(position..end).unwrap_or_default();
        let start = offset;
        offset += utf16_len(segment_chars);
        position = end;

        let segment: String = segment_chars.iter().collect();
        let negated = segment.starts_with('-');
        let term = segment.strip_prefix('-').unwrap_or(&segment);
        if term.is_empty() {
            continue;
        }

        if let Some(quoted) = term.strip_prefix('"') {
            let phrase = quoted.strip_suffix('"').unwrap_or(quoted);
            if !phrase.trim().is_empty() {
                if negated {
                    parsed.exclude.push(phrase.to_owned());
                } else {
                    parsed.phrases.push(phrase.to_owned());
                }
            }
            continue;
        }

        let Some((name, raw)) = term.split_once(':').filter(|(name, _)| !name.is_empty()) else {
            if negated {
                parsed.exclude.push(term.to_owned());
            } else {
                words.push(term.to_owned());
            }
            continue;
        };

        let name = name.to_lowercase();
        let value = unquoted(raw);
        if value.is_empty() {
            continue;
        }
        match SearchOperator::parse(&name) {
            Some(operator) if negated && operator.is_date() => {
                parsed.unsupported.push(format!("-{name}"));
            }
            Some(operator) => parsed.tokens.push(SearchToken {
                operator,
                value: value.to_owned(),
                negated,
                start,
                end: offset,
            }),
            None if negated => parsed.exclude.push(term.to_owned()),
            None => words.push(term.to_owned()),
        }
    }

    parsed.text = words.join(" ");
    parsed
}

#[cfg(test)]
mod tests {
    use super::{SearchOperator, parse_search_query};

    fn spans(query: &str) -> Vec<String> {
        let units: Vec<u16> = query.encode_utf16().collect();
        parse_search_query(query)
            .tokens
            .iter()
            .map(|token| {
                let start = usize::try_from(token.start).unwrap_or_default();
                let end = usize::try_from(token.end).unwrap_or_default();
                String::from_utf16_lossy(units.get(start..end).unwrap_or_default())
            })
            .collect()
    }

    #[test]
    fn plain_words_become_the_free_text() {
        let parsed = parse_search_query("deploy pipeline broken");
        assert_eq!(parsed.text, "deploy pipeline broken");
        assert!(parsed.tokens.is_empty());
    }

    #[test]
    fn operators_are_lifted_out_of_the_free_text() {
        let parsed = parse_search_query("deploy from:erwan in:dev has:image");

        assert_eq!(parsed.text, "deploy");
        assert_eq!(
            parsed
                .tokens
                .iter()
                .map(|token| (token.operator, token.value.as_str(), token.negated))
                .collect::<Vec<_>>(),
            vec![
                (SearchOperator::From, "erwan", false),
                (SearchOperator::In, "dev", false),
                (SearchOperator::Has, "image", false),
            ]
        );
    }

    #[test]
    fn quotes_make_phrases_and_a_dash_excludes() {
        let parsed = parse_search_query("\"pipeline is broken\" deploy -staging -\"staging box\"");
        assert_eq!(parsed.phrases, vec!["pipeline is broken"]);
        assert_eq!(parsed.exclude, vec!["staging", "staging box"]);
        assert_eq!(parsed.text, "deploy");
    }

    #[test]
    fn an_unclosed_phrase_keeps_what_was_typed() {
        assert_eq!(parse_search_query("\"deplo").phrases, vec!["deplo"]);
        assert_eq!(parse_search_query("fix -\"deplo").exclude, vec!["deplo"]);
    }

    #[test]
    fn a_negated_date_bound_is_unsupported() {
        let parsed = parse_search_query("deploy -before:2024-01-01 -on:2026-01-01");
        assert_eq!(parsed.unsupported, vec!["-before", "-on"]);
        assert!(parsed.tokens.is_empty());
    }

    #[test]
    fn unknown_operators_and_empty_values_are_text() {
        assert_eq!(
            parse_search_query("deploy colour:red").text,
            "deploy colour:red"
        );
        let empty = parse_search_query("from: deploy");
        assert!(empty.tokens.is_empty());
        assert_eq!(empty.text, "deploy");
    }

    #[test]
    fn a_quoted_value_may_hold_spaces_and_a_matrix_id_keeps_its_colon() {
        let parsed = parse_search_query("deploy in:\"Design crew\" -from:@erwan:example.org");
        assert_eq!(parsed.text, "deploy");
        assert_eq!(
            parsed
                .tokens
                .iter()
                .map(|token| (token.value.as_str(), token.negated))
                .collect::<Vec<_>>(),
            vec![("Design crew", false), ("@erwan:example.org", true)]
        );
    }

    #[test]
    fn spans_index_the_utf16_string() {
        assert_eq!(spans("deploy in:dev broke"), vec!["in:dev"]);
        assert_eq!(
            spans("in:\"Design crew\" deploy"),
            vec!["in:\"Design crew\""]
        );
        assert_eq!(spans("🚀 déployer from:ana"), vec!["from:ana"]);
    }

    #[test]
    fn the_text_left_behind_parses_to_itself() {
        let parsed = parse_search_query("from:a deploy -in:b now");
        let again = parse_search_query(&parsed.text);
        assert_eq!(again.text, parsed.text);
        assert!(again.tokens.is_empty());
    }
}
