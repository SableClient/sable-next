use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::Hash;
use std::ops::Bound;

use super::tokenize;

const BM25_K1: f64 = 1.2;
const BM25_B: f64 = 0.75;
const MAX_TYPO_EXPANSIONS: usize = 50;

pub(super) struct InvertedIndex<K> {
    postings: BTreeMap<Box<str>, Vec<(K, u32)>>,
    lengths: HashMap<K, u32>,
    total_length: u64,
    removed: HashSet<K>,
    deferred: bool,
}

impl<K: Copy + Eq + Hash> InvertedIndex<K> {
    pub(super) fn with_capacity(documents: usize) -> Self {
        Self {
            postings: BTreeMap::new(),
            lengths: HashMap::with_capacity(documents),
            total_length: 0,
            removed: HashSet::new(),
            deferred: false,
        }
    }

    pub(super) const fn defer(&mut self, deferred: bool) {
        self.deferred = deferred;
    }

    pub(super) const fn is_deferred(&self) -> bool {
        self.deferred
    }

    pub(super) fn add_document(&mut self, key: K, text: &str) {
        if self.deferred {
            return;
        }
        let terms = tokenize::tokenize(text);
        let mut counts: HashMap<&str, u32> = HashMap::with_capacity(terms.len());
        for term in &terms {
            *counts.entry(term.as_ref()).or_default() += 1;
        }
        let length = u32::try_from(terms.len()).unwrap_or(u32::MAX);
        self.lengths.insert(key, length);
        self.total_length += u64::from(length);
        for (term, count) in counts {
            match self.postings.get_mut(term) {
                Some(list) => list.push((key, count)),
                None => {
                    self.postings.insert(term.into(), vec![(key, count)]);
                }
            }
        }
    }

    /// Postings stay until [`Self::vacuum`], so readers must skip keys missing from `lengths`.
    pub(super) fn remove_document(&mut self, key: K) {
        if let Some(length) = self.lengths.remove(&key) {
            self.total_length -= u64::from(length);
            self.removed.insert(key);
        }
    }

    pub(super) fn vacuum(&mut self) {
        if self.removed.is_empty() {
            return;
        }
        self.postings.retain(|_, list| {
            list.retain(|(key, _)| !self.removed.contains(key));
            !list.is_empty()
        });
        self.removed.clear();
    }

    #[expect(
        clippy::cast_precision_loss,
        reason = "counts stay far below 2^52 and only feed a ranking score"
    )]
    pub(super) fn query(&self, query: &str) -> Vec<(K, f64)> {
        if self.lengths.is_empty() {
            return Vec::new();
        }
        let documents = self.lengths.len() as f64;
        let average_length = self.total_length as f64 / documents;
        let mut terms = tokenize::tokenize(query);
        terms.sort_unstable();
        terms.dedup();

        let mut scores: HashMap<K, f64> = HashMap::new();
        let mut live = Vec::new();
        for term in &terms {
            let mut best: HashMap<K, f64> = HashMap::new();
            for (list, edits) in self.expand(term) {
                live.clear();
                live.extend(
                    list.iter()
                        .filter_map(|&(key, count)| Some((key, count, *self.lengths.get(&key)?))),
                );
                let frequency = live.len() as f64;
                let idf = (1.0 + (documents - frequency + 0.5) / (frequency + 0.5)).ln();
                let boost = if edits == 0 {
                    1.0
                } else {
                    (1.0 + 1.0 / (1.0 + edits as f64)).ln()
                };
                for &(key, count, length) in &live {
                    let count = f64::from(count);
                    let saturated = ((BM25_K1 + 1.0) * count)
                        / (BM25_K1 * (1.0 - BM25_B + BM25_B * f64::from(length) / average_length)
                            + count);
                    let score = saturated * idf * boost;
                    best.entry(key)
                        .and_modify(|current| *current = current.max(score))
                        .or_insert(score);
                }
            }
            for (key, score) in best {
                *scores.entry(key).or_default() += score;
            }
        }
        scores.into_iter().collect()
    }

    fn expand(&self, term: &str) -> Vec<(&[(K, u32)], usize)> {
        let Some(first) = term.chars().next() else {
            return Vec::new();
        };
        let mut buffer = [0; 4];
        let first: &str = first.encode_utf8(&mut buffer);
        let term_chars = term.chars().count();
        let typos = allowed_typos(term);

        let mut prefixed = Vec::new();
        let mut misspelled = Vec::new();
        let candidates = self
            .postings
            .range::<str, _>((Bound::Included(first), Bound::Unbounded))
            .take_while(|(word, _)| word.starts_with(first));
        for (word, list) in candidates {
            let word_chars = word.chars().count();
            if word.starts_with(term) {
                prefixed.push((list.as_slice(), word_chars - term_chars));
            } else if typos > 0 && word_chars.abs_diff(term_chars) <= typos {
                let edits = strsim::osa_distance(term, word);
                if edits <= typos {
                    misspelled.push((list.as_slice(), edits));
                }
            }
        }
        misspelled.sort_by_key(|(_, edits)| *edits);
        misspelled.truncate(MAX_TYPO_EXPANSIONS);
        prefixed.extend(misspelled);
        prefixed
    }
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

#[cfg(test)]
mod tests {
    use super::{InvertedIndex, allowed_typos};

    fn index(bodies: &[&str]) -> InvertedIndex<u32> {
        let mut index = InvertedIndex::with_capacity(bodies.len());
        for (key, body) in (0..).zip(bodies) {
            index.add_document(key, body);
        }
        index
    }

    fn ranked(index: &InvertedIndex<u32>, query: &str) -> Vec<u32> {
        let mut hits = index.query(query);
        hits.sort_by(|left, right| right.1.total_cmp(&left.1).then(left.0.cmp(&right.0)));
        hits.into_iter().map(|(key, _)| key).collect()
    }

    #[test]
    fn test_a_misspelled_message_matches_the_correct_word() {
        let index = index(&["please deligate this", "nothing here"]);
        assert_eq!(ranked(&index, "delegate"), [0]);
    }

    #[test]
    fn test_a_misspelled_query_matches_the_correct_word() {
        let index = index(&["please delegate this"]);
        assert_eq!(ranked(&index, "deligate"), [0]);
    }

    #[test]
    fn test_an_exact_match_outranks_a_typo() {
        let index = index(&["the deligate came", "the delegate came"]);
        assert_eq!(ranked(&index, "delegate"), [1, 0]);
    }

    #[test]
    fn test_a_swapped_pair_of_letters_is_one_typo() {
        let index = index(&["recieve the file"]);
        assert_eq!(ranked(&index, "receive"), [0]);
    }

    #[test]
    fn test_short_words_must_match_exactly() {
        let index = index(&["the cat sat"]);
        assert_eq!(ranked(&index, "cot"), [] as [u32; 0]);
    }

    #[test]
    fn test_the_first_letter_must_match() {
        let index = index(&["a great delegate"]);
        assert_eq!(ranked(&index, "selegate"), [] as [u32; 0]);
    }

    #[test]
    fn test_words_with_digits_must_match_exactly() {
        let index = index(&["release 20240 ticket1420"]);
        assert_eq!(ranked(&index, "20250"), [] as [u32; 0]);
        assert_eq!(ranked(&index, "ticket1402"), [] as [u32; 0]);
    }

    #[test]
    fn test_typo_budget_grows_with_length() {
        assert_eq!(allowed_typos("deleg"), 1);
        assert_eq!(allowed_typos("dele"), 0);
        assert_eq!(allowed_typos("internati"), 2);
    }

    #[test]
    fn test_a_prefix_matches_longer_words() {
        let index = index(&["deployment pipeline"]);
        assert_eq!(ranked(&index, "dep"), [0]);
    }

    #[test]
    fn test_a_removed_document_stops_matching_before_and_after_vacuum() {
        let mut index = index(&["delegate", "delegate"]);
        index.remove_document(0);
        assert_eq!(ranked(&index, "delegate"), [1]);
        index.vacuum();
        assert_eq!(ranked(&index, "delegate"), [1]);
        assert_eq!(index.postings.values().map(Vec::len).sum::<usize>(), 1);
    }

    #[test]
    fn test_every_query_term_adds_to_the_score() {
        let index = index(&["deploy failed", "deploy worked"]);
        assert_eq!(ranked(&index, "deploy failed"), [0, 1]);
    }
}
