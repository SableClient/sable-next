use std::borrow::Cow;
use std::sync::LazyLock;

use charabia::{Script, Token, TokenKind, Tokenize};
use rust_stemmers::{Algorithm, Stemmer};
use unicode_normalization::UnicodeNormalization;

static ENGLISH: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::English));
static RUSSIAN: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::Russian));
static GREEK: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::Greek));
static ARABIC: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::Arabic));
static TAMIL: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::Tamil));

const MAX_TERM_CHARS: usize = 256;

/// Chinese and Japanese are indexed as overlapping pairs of characters, plus
/// the last character of each run, so a one character query still finds it.
#[must_use]
pub fn tokenize(text: &str) -> Vec<Cow<'static, str>> {
    let mut terms = Vec::new();
    for token in text
        .tokenize()
        .filter(|token| token.kind == TokenKind::Word)
    {
        if token.script == Script::Cj {
            let characters = normalized(&token);
            terms.extend(pairs(&characters));
            terms.extend(characters.last().map(|last| Cow::Owned(last.to_string())));
        } else {
            push_term(&mut terms, &token);
        }
    }
    terms
}

/// A query is a list of words, and a document matches a word only when it
/// holds every term of it. Chinese and Japanese are cut where `words`, the
/// query as the platform's word segmenter split it, says; a run they do not
/// cover stays one word.
#[must_use]
pub fn tokenize_query(text: &str, words: &[String]) -> Vec<Vec<Cow<'static, str>>> {
    let mut groups = Vec::new();
    for token in text
        .tokenize()
        .filter(|token| token.kind == TokenKind::Word)
    {
        if token.script == Script::Cj {
            // Cut the original text: the words are spelled as the query was typed.
            let run = text
                .get(token.byte_start..token.byte_end)
                .unwrap_or_default();
            for word in segmented(run, words) {
                let characters: Vec<char> = word
                    .tokenize()
                    .filter(|token| token.kind == TokenKind::Word)
                    .flat_map(|token| normalized(&token))
                    .collect();
                let group: Vec<_> = if characters.len() == 1 {
                    characters
                        .iter()
                        .map(|single| Cow::Owned(single.to_string()))
                        .collect()
                } else {
                    pairs(&characters).collect()
                };
                if !group.is_empty() {
                    groups.push(group);
                }
            }
        } else {
            let mut terms = Vec::new();
            push_term(&mut terms, &token);
            if !terms.is_empty() {
                groups.push(terms);
            }
        }
    }
    groups
}

#[must_use]
pub fn matches(query: &str, words: &[String], body: &str) -> bool {
    let terms = tokenize(body);
    tokenize_query(query, words)
        .iter()
        .flatten()
        .all(|wanted| terms.iter().any(|term| term.starts_with(wanted.as_ref())))
}

/// The Chinese and Japanese words of a query as [`tokenize_query`] cuts them,
/// spelled as the query was typed.
#[must_use]
pub fn unspaced_words(text: &str, words: &[String]) -> Vec<String> {
    text.tokenize()
        .filter(|token| token.kind == TokenKind::Word && token.script == Script::Cj)
        .filter_map(|token| text.get(token.byte_start..token.byte_end))
        .flat_map(|run| segmented(run, words))
        .map(str::to_owned)
        .collect()
}

#[must_use]
pub fn contains_chinese(text: &str) -> bool {
    text.chars()
        .any(|character| Script::from(character) == Script::Cj)
}

/// Cuts a run into the longest words that start where the previous one ended.
/// A single character the segmenter leaves over usually belongs to a word it
/// does not know, Japanese above all, so it stays joined to its neighbours.
fn segmented<'text>(run: &'text str, words: &[String]) -> Vec<&'text str> {
    let mut pieces = Vec::new();
    let (mut start, mut end) = (0, 0);
    let mut joined = false;
    while let Some(rest) = run.get(end..).filter(|rest| !rest.is_empty()) {
        let Some(word) = words
            .iter()
            .filter(|word| !word.is_empty() && rest.starts_with(word.as_str()))
            .max_by_key(|word| word.len())
        else {
            return vec![run];
        };
        let single = word.chars().count() == 1;
        if end > start && !single && !joined {
            pieces.extend(run.get(start..end));
            start = end;
        }
        end += word.len();
        joined = single;
    }
    pieces.extend(run.get(start..end));
    pieces
}

/// Recomposed so a voiced kana stays one character apart from its unvoiced form.
fn normalized(token: &Token<'_>) -> Vec<char> {
    token.lemma().nfc().collect()
}

fn pairs(characters: &[char]) -> impl Iterator<Item = Cow<'static, str>> + '_ {
    characters
        .windows(2)
        .map(|pair| Cow::Owned(pair.iter().collect()))
}

fn push_term(terms: &mut Vec<Cow<'static, str>>, token: &Token<'_>) {
    let term = limit_term(stem(token));
    if !term.is_empty() {
        terms.push(Cow::Owned(term));
    }
}

fn limit_term(mut term: String) -> String {
    if let Some((index, _)) = term.char_indices().nth(MAX_TERM_CHARS) {
        term.truncate(index);
    }
    term
}

fn stem(token: &Token<'_>) -> String {
    let lemma = token.lemma();
    stemmer_for(token.script).map_or_else(
        || lemma.to_owned(),
        |stemmer| stemmer.stem(lemma).into_owned(),
    )
}

fn stemmer_for(script: Script) -> Option<&'static Stemmer> {
    Some(match script {
        Script::Latin => &ENGLISH,
        Script::Cyrillic => &RUSSIAN,
        Script::Greek => &GREEK,
        Script::Arabic => &ARABIC,
        Script::Tamil => &TAMIL,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::{MAX_TERM_CHARS, tokenize, tokenize_query};

    fn words(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    fn terms(text: &str) -> Vec<String> {
        tokenize(text).into_iter().map(Into::into).collect()
    }

    fn finds(query: &str, document: &str) -> bool {
        super::matches(query, &[], document)
    }

    #[test]
    fn test_a_japanese_word_matches_only_text_that_contains_it() {
        assert!(finds("検索", "検索を使う"));
        assert!(finds("検索", "日本語検索が失敗"));
        assert!(!finds("検索", "検討します"));
        assert!(!finds("検索", "索引です"));
        assert!(!finds("ありがとう", "日本語検索が失敗"));
    }

    #[test]
    fn test_japanese_matches_ignore_word_boundaries() {
        assert!(finds("東京", "東京都庁に行く"));
        assert!(finds("日本語", "日本語を勉強する"));
        assert!(!finds("日本語", "日本と英語"));
        assert!(!finds("東京都", "東の京都"));
        assert!(!finds("か", "が"));
    }

    #[test]
    fn test_one_japanese_character_finds_it_anywhere_in_a_run() {
        assert!(finds("猫", "黒い猫"));
        assert!(finds("黒", "黒い猫"));
    }

    #[test]
    fn test_punctuation_and_case_are_normalized_away() {
        assert_eq!(terms("Deploy, please!"), vec!["deploy", "pleas"]);
    }

    #[test]
    fn test_an_inflection_stems_onto_its_root() {
        assert_eq!(terms("deploying"), terms("deploy"));
        assert_eq!(terms("deployed"), terms("deploy"));
    }

    #[test]
    fn test_diacritics_are_folded() {
        assert_eq!(terms("café"), terms("cafe"));
    }

    #[test]
    fn test_cyrillic_stems_with_its_own_rules() {
        assert_eq!(terms("сломано"), terms("сломан"));
    }

    #[test]
    fn test_a_script_without_spaces_still_yields_terms() {
        assert_ne!(terms("สวัสดี"), Vec::<String>::new());
    }

    #[test]
    fn test_chinese_words_inside_sentences() {
        for sentence in [
            "今天我们一起讨论中文搜索功能，然后测试加密房间里的消息索引。",
            "今天我們一起討論中文搜索功能，然後測試加密房間裡的消息索引。",
        ] {
            for query in ["中文", "搜索", "功能", "加密", "消息", "索引"] {
                assert!(
                    finds(query, sentence),
                    "{query:?} does not find {sentence:?}"
                );
            }
            assert!(!finds("天气", sentence));
        }
    }

    #[test]
    fn test_a_query_without_words_keeps_a_run_whole() {
        assert_eq!(
            tokenize_query("deploy 中文搜索", &[]),
            [vec!["deploy"], vec!["中文", "文搜", "搜索"]]
        );
    }

    #[test]
    fn test_a_query_is_cut_where_its_words_say() {
        assert_eq!(
            tokenize_query(
                "deploy 中文搜索功能",
                &words(&["deploy", "中文", "搜索功能"])
            ),
            [vec!["deploy"], vec!["中文"], vec!["搜索", "索功", "功能"]]
        );
        assert_eq!(
            tokenize_query("東京都", &words(&["東京", "東京都"])),
            [vec!["東京", "京都"]]
        );
    }

    #[test]
    fn test_the_unspaced_words_are_the_pieces_the_query_is_cut_into() {
        assert_eq!(
            super::unspaced_words(
                "deploy 東京都 日本語勉強",
                &words(&["deploy", "東京", "都", "日本語", "勉強"])
            ),
            ["東京都", "日本語", "勉強"]
        );
        assert_eq!(super::unspaced_words("中文搜索", &[]), ["中文搜索"]);
    }

    #[test]
    fn test_a_character_left_over_stays_joined_to_its_neighbours() {
        assert_eq!(
            tokenize_query("東京都", &words(&["東京", "都"])),
            [vec!["東京", "京都"]]
        );
        assert_eq!(
            tokenize_query("ラーメン屋さん", &words(&["ラーメン", "屋", "さん"])),
            [vec!["ラー", "ーメ", "メン", "ン屋", "屋さ", "さん"]]
        );
        assert_eq!(tokenize_query("猫", &words(&["猫"])), [vec!["猫"]]);
    }

    #[test]
    fn test_words_that_do_not_cover_a_run_keep_it_whole() {
        assert_eq!(
            tokenize_query("中文搜索", &words(&["中文"])),
            [vec!["中文", "文搜", "搜索"]]
        );
    }

    #[test]
    fn test_mixed_chinese_and_latin() {
        assert_eq!(
            terms("搜索 Search 部署"),
            ["搜索", "索", "search", "部署", "署"]
        );
    }

    #[test]
    fn test_a_long_unbroken_word_is_bounded() {
        assert_eq!(
            terms(&"x".repeat(MAX_TERM_CHARS + 1)),
            vec!["x".repeat(MAX_TERM_CHARS)]
        );
    }

    #[test]
    fn test_a_query_and_a_document_normalize_the_same_way() {
        let document = terms("The Deployment Pipeline is BROKEN");

        for query in ["deployment", "Deployment", "deployments", "DEPLOYMENT"] {
            let term = terms(query);
            assert!(
                term.iter().all(|token| document.contains(token)),
                "{query:?} tokenized to {term:?}, which the document {document:?} cannot match"
            );
        }
    }
}
