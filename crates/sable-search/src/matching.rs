use std::borrow::Cow;
use std::collections::HashSet;
use std::ops::Range;

use crate::tokenize;

const MAX_TYPO_EXPANSIONS: usize = 50;

/// The text to hand a full-text index: the folded terms of `text`, joined by spaces.
#[must_use]
pub fn indexed_text(text: &str) -> String {
    let mut joined = String::new();
    for (term, _) in tokenize::tokenize(text) {
        if !joined.is_empty() {
            joined.push(' ');
        }
        joined.push_str(&term);
    }
    joined
}

/// Looks up the indexed words in `[low, high)`, in byte order.
pub type Vocabulary<'vocabulary> = &'vocabulary mut dyn FnMut(&str, &str) -> Vec<String>;

/// A full-text query for `query`, or `None` when it holds no word. A word of
/// one script matches by prefix and, with `expand`, by typo as well. Every
/// term of a word must match, and any word of the query may.
#[must_use]
pub fn match_expression(
    query: &str,
    words: &[String],
    expand: bool,
    vocabulary: Vocabulary<'_>,
) -> Option<String> {
    let mut groups = groups(query, words);
    if groups.is_empty() {
        return None;
    }
    let alternatives: Vec<String> = groups
        .drain(..)
        .map(|group| {
            if let Some(phrase) = unspaced_expression(&group) {
                return format!("({phrase})");
            }
            let terms: Vec<String> = group
                .iter()
                .map(|term| term_expression(term, expand, vocabulary))
                .collect();
            format!("({})", terms.join(" AND "))
        })
        .collect();
    Some(alternatives.join(" OR "))
}

/// Like [`match_expression`], without prefixes and typos: the words as spelled.
#[must_use]
pub fn exact_expression(query: &str, words: &[String]) -> Option<String> {
    let groups = groups(query, words);
    if groups.is_empty() {
        return None;
    }
    let alternatives: Vec<String> = groups
        .iter()
        .map(|group| {
            if let Some(phrase) = unspaced_expression(group) {
                return format!("({phrase})");
            }
            let terms: Vec<String> = group.iter().map(|term| quoted(term)).collect();
            format!("({})", terms.join(" AND "))
        })
        .collect();
    Some(alternatives.join(" OR "))
}

fn groups(query: &str, words: &[String]) -> Vec<Vec<String>> {
    let mut groups: Vec<Vec<String>> = tokenize::tokenize_query(query, words)
        .into_iter()
        .map(|(_, group)| {
            let mut group: Vec<String> = group.into_iter().map(Into::into).collect();
            if !is_unspaced(&group) {
                group.sort_unstable();
                group.dedup();
            }
            group
        })
        .collect();
    groups.sort_unstable();
    groups.dedup();
    groups
}

/// A word of a script written without spaces is indexed as overlapping pairs,
/// one after the other, so its pairs must follow each other in that order. A
/// single character is found at the start of any pair as well.
fn unspaced_expression(group: &[String]) -> Option<String> {
    if !is_unspaced(group) {
        return None;
    }
    Some(match group {
        [single] => format!("{}*", quoted(single)),
        pairs => quoted(&pairs.join(" ")),
    })
}

fn is_unspaced<T: AsRef<str>>(group: &[T]) -> bool {
    group
        .first()
        .is_some_and(|term| tokenize::contains_unspaced(term.as_ref()))
}

/// Whether a document's `terms` hold `group` as the index would find it.
fn holds<T: AsRef<str>>(group: &[T], terms: &[(Cow<'_, str>, Range<usize>)], expand: bool) -> bool {
    if group.len() > 1 && is_unspaced(group) {
        return terms.windows(group.len()).any(|window| {
            window
                .iter()
                .zip(group)
                .all(|((candidate, _), term)| candidate == term.as_ref())
        });
    }
    group.iter().all(|term| {
        terms
            .iter()
            .any(|(candidate, _)| finds(term.as_ref(), candidate, expand))
    })
}

fn quoted(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

fn term_expression(term: &str, expand: bool, vocabulary: Vocabulary<'_>) -> String {
    if !expand && !tokenize::contains_unspaced(term) {
        return quoted(term);
    }
    let mut alternatives = vec![format!("{}*", quoted(term))];
    if expand && let Some(first) = term.chars().next() {
        let typos = allowed_typos(term);
        if typos > 0 {
            let mut buffer = [0; 4];
            let low: &str = first.encode_utf8(&mut buffer);
            let high = char::from_u32(u32::from(first) + 1).map(String::from);
            let candidates = vocabulary(low, high.as_deref().unwrap_or("\u{10ffff}"));
            alternatives.extend(near_words(term, typos, candidates).map(|word| quoted(&word)));
        }
    }
    if alternatives.len() == 1 {
        alternatives.swap_remove(0)
    } else {
        format!("({})", alternatives.join(" OR "))
    }
}

/// The misspellings of `term` among `candidates`, closest first.
fn near_words(term: &str, typos: usize, candidates: Vec<String>) -> impl Iterator<Item = String> {
    let term_chars = term.chars().count();
    let mut near: Vec<(usize, String)> = candidates
        .into_iter()
        .filter(|word| {
            !word.starts_with(term) && word.chars().count().abs_diff(term_chars) <= typos
        })
        .filter_map(|word| {
            let edits = strsim::osa_distance(term, &word);
            (edits <= typos).then_some((edits, word))
        })
        .collect();
    near.sort();
    near.truncate(MAX_TYPO_EXPANSIONS);
    near.into_iter().map(|(_, word)| word)
}

/// Words with digits stay exact so ticket1420 never matches ticket1402.
fn allowed_typos(term: &str) -> usize {
    if term.chars().any(char::is_numeric) {
        return 0;
    }
    match term.chars().count() {
        0..5 => 0,
        5..9 => 1,
        _ => 2,
    }
}

/// Whether a document word `candidate` is one the query term `term` finds.
fn finds(term: &str, candidate: &str, expand: bool) -> bool {
    if !expand && !tokenize::contains_unspaced(term) {
        return candidate == term;
    }
    if candidate.starts_with(term) {
        return true;
    }
    let typos = if expand { allowed_typos(term) } else { 0 };
    typos > 0
        && candidate.chars().next() == term.chars().next()
        && candidate.chars().count().abs_diff(term.chars().count()) <= typos
        && strsim::osa_distance(term, candidate) <= typos
}

/// The words of `body` the index would find it by, spelled as `body` writes
/// them, or `None` when the index would not find it. A word in a script
/// written without spaces is spelled as the query typed it.
#[must_use]
pub fn matched_words(
    query: &str,
    words: &[String],
    body: &str,
    expand: bool,
) -> Option<Vec<String>> {
    let terms = tokenize::tokenize(body);
    let mut found = false;
    let mut matched = Vec::new();
    for (typed, group) in tokenize::tokenize_query(query, words) {
        if !holds(&group, &terms, expand) {
            continue;
        }
        found = true;
        if tokenize::contains_unspaced(typed) {
            matched.push(typed.to_owned());
            continue;
        }
        let stems: HashSet<&str> = group
            .iter()
            .flat_map(|term| {
                terms
                    .iter()
                    .map(|(candidate, _)| candidate.as_ref())
                    .filter(|candidate| finds(term, candidate, expand))
            })
            .collect();
        matched.extend(
            terms
                .iter()
                .filter(|(term, _)| stems.contains(term.as_ref()))
                .filter_map(|(_, word)| body.get(word.clone()))
                .map(str::to_owned),
        );
    }
    matched.sort_unstable();
    matched.dedup();
    found.then_some(matched)
}

/// Whether `body` holds every word of `query` as the index would find each one.
#[must_use]
pub fn matches_every_word(query: &str, words: &[String], body: &str, expand: bool) -> bool {
    let terms = tokenize::tokenize(body);
    tokenize::tokenize_query(query, words)
        .iter()
        .all(|(_, group)| holds(group, &terms, expand))
}

#[cfg(test)]
mod tests {
    use super::{allowed_typos, exact_expression, match_expression, matched_words};

    #[test]
    fn test_a_word_of_several_pairs_is_a_phrase() {
        let mut vocabulary = |_: &str, _: &str| Vec::new();
        assert_eq!(
            match_expression("東京都", &[], true, &mut vocabulary).as_deref(),
            Some("(\"東京 京都\")")
        );
        assert_eq!(
            exact_expression("東京都", &[]).as_deref(),
            Some("(\"東京 京都\")")
        );
    }

    #[test]
    fn test_one_unspaced_character_counts_as_exact_anywhere_in_a_run() {
        let mut vocabulary = |_: &str, _: &str| Vec::new();
        let expected = Some("(\"猫\"*)");
        assert_eq!(
            match_expression("猫", &[], true, &mut vocabulary).as_deref(),
            expected
        );
        assert_eq!(exact_expression("猫", &[]).as_deref(), expected);
    }

    #[test]
    fn test_typo_budget_grows_with_length() {
        assert_eq!(allowed_typos("deleg"), 1);
        assert_eq!(allowed_typos("dele"), 0);
        assert_eq!(allowed_typos("internati"), 2);
    }

    #[test]
    fn test_the_words_a_document_matched_are_spelled_as_written() {
        assert_eq!(
            matched_words("delegate dep", &[], "Please DELIGATE the Deployment", true),
            Some(vec!["DELIGATE".to_owned(), "Deployment".to_owned()])
        );
        assert_eq!(
            matched_words("deploy", &[], "it deployed, then the deploy café", false),
            Some(vec!["deploy".to_owned(), "deployed".to_owned()])
        );
        assert_eq!(
            matched_words("cafe", &[], "un Café crème", false),
            Some(vec!["Café".to_owned()])
        );
        assert_eq!(
            matched_words("rust", &[], "Rustを使う", false),
            Some(vec!["Rust".to_owned()])
        );
        assert_eq!(
            matched_words("東京 deploy", &["東京".to_owned()], "東京都庁に行く", false),
            Some(vec!["東京".to_owned()])
        );
    }
}
