use std::borrow::Cow;
use std::sync::LazyLock;

use charabia::{Script, Token, TokenKind, Tokenize};
use jieba_rs::Jieba;
use rust_stemmers::{Algorithm, Stemmer};

pub(super) static CHINESE: std::sync::OnceLock<Jieba> = std::sync::OnceLock::new();

static ENGLISH: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::English));
static RUSSIAN: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::Russian));
static GREEK: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::Greek));
static ARABIC: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::Arabic));
static TAMIL: LazyLock<Stemmer> = LazyLock::new(|| Stemmer::create(Algorithm::Tamil));

const MAX_TERM_CHARS: usize = 256;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Document,
    Query,
}

pub(crate) fn tokenize(text: &str) -> Vec<Cow<'static, str>> {
    tokenize_with(text, CHINESE.get(), Side::Document)
}

pub(crate) fn tokenize_query(text: &str) -> Vec<Cow<'static, str>> {
    tokenize_with(text, CHINESE.get(), Side::Query)
}

pub(super) fn chinese_ready() -> bool {
    CHINESE.get().is_some()
}

#[cfg(test)]
pub(super) fn load_bundled_chinese() {
    CHINESE.get_or_init(Jieba::new);
}

pub(super) fn contains_chinese(text: &str) -> bool {
    text.chars()
        .any(|character| Script::from(character) == Script::Cj)
}

fn tokenize_with(text: &str, dictionary: Option<&Jieba>, side: Side) -> Vec<Cow<'static, str>> {
    let mut terms = Vec::new();
    for token in text
        .tokenize()
        .filter(|token| token.kind == TokenKind::Word)
    {
        if token.script == Script::Cj {
            let Some(dictionary) = dictionary else {
                continue;
            };
            // Segment the original text: normalization can change dictionary spellings.
            let original = text
                .get(token.byte_start..token.byte_end)
                .unwrap_or_default();
            let mut singles = Vec::new();
            for word in dictionary.cut_for_search(original, false) {
                let single = word.word.chars().count() == 1;
                let mut found = false;
                for token in word
                    .word
                    .tokenize()
                    .filter(|token| token.kind == TokenKind::Word)
                {
                    let term = limit_term(stem(&token));
                    if term.is_empty() {
                        continue;
                    }
                    if single {
                        found = true;
                        singles.push(term);
                    } else {
                        terms.push(Cow::Owned(term));
                    }
                }
                if !found {
                    push_pairs(&mut terms, &mut singles, side);
                }
            }
            push_pairs(&mut terms, &mut singles, side);
        } else {
            push_term(&mut terms, &token);
        }
    }
    terms
}

/// The Chinese dictionary cuts text it has no words for, Japanese above all,
/// into single characters, and a query of single characters matches any word
/// that starts with one of them. A run of them is indexed as overlapping
/// pairs instead. A document also keeps the last character, which starts no
/// pair, so a one character query still finds it.
fn push_pairs(terms: &mut Vec<Cow<'static, str>>, singles: &mut Vec<String>, side: Side) {
    if singles.len() == 1 {
        terms.extend(singles.drain(..).map(Cow::Owned));
        return;
    }
    for pair in singles.windows(2) {
        terms.push(Cow::Owned(pair.concat()));
    }
    if side == Side::Document {
        terms.extend(singles.pop().map(Cow::Owned));
    }
    singles.clear();
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

    fn terms(text: &str) -> Vec<String> {
        super::load_bundled_chinese();
        tokenize(text).into_iter().map(Into::into).collect()
    }

    fn finds(query: &str, document: &str) -> bool {
        let document = terms(document);
        tokenize_query(query).iter().all(|wanted| {
            document
                .iter()
                .any(|term| term.starts_with(wanted.as_ref()))
        })
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
            let document = terms(sentence);
            for query in ["中文", "搜索", "功能", "加密", "消息", "索引"] {
                let query_terms = terms(query);
                assert_ne!(query_terms, Vec::<String>::new());
                assert!(
                    query_terms.iter().all(|term| document.contains(term)),
                    "{query:?} tokenized to {query_terms:?}, which the document {document:?} cannot match"
                );
            }
        }
    }

    #[test]
    fn test_missing_chinese_dictionary_keeps_latin_terms() {
        let document = super::Side::Document;
        assert_eq!(
            super::tokenize_with("deploy 中文搜索", None, document),
            ["deploy"]
        );
        assert_eq!(
            super::tokenize_with("中文搜索", None, document),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn test_mixed_chinese_and_latin() {
        assert_eq!(terms("搜索 Search 部署"), ["搜索", "search", "部署"]);
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
