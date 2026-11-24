use std::collections::HashSet;

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
            group.sort_unstable();
            group.dedup();
            group
        })
        .collect();
    groups.sort_unstable();
    groups.dedup();
    groups
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
        let stems: Vec<HashSet<&str>> = group
            .iter()
            .map(|term| {
                terms
                    .iter()
                    .map(|(candidate, _)| candidate.as_ref())
                    .filter(|candidate| finds(term, candidate, expand))
                    .collect()
            })
            .collect();
        if stems.iter().any(HashSet::is_empty) {
            continue;
        }
        found = true;
        if tokenize::contains_unspaced(typed) {
            matched.push(typed.to_owned());
            continue;
        }
        let stems: HashSet<&str> = stems.into_iter().flatten().collect();
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
        .all(|(_, group)| {
            group.iter().all(|term| {
                terms
                    .iter()
                    .any(|(candidate, _)| finds(term, candidate, expand))
            })
        })
}

#[cfg(test)]
mod tests {
    use super::{allowed_typos, matched_words};

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
