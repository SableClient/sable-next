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

pub(crate) fn tokenize(text: &str) -> Vec<Cow<'static, str>> {
    tokenize_with(text, CHINESE.get())
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

fn tokenize_with(text: &str, dictionary: Option<&Jieba>) -> Vec<Cow<'static, str>> {
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
            for word in dictionary.cut_for_search(original, false) {
                for token in word
                    .word
                    .tokenize()
                    .filter(|token| token.kind == TokenKind::Word)
                {
                    push_term(&mut terms, &token);
                }
            }
        } else {
            push_term(&mut terms, &token);
        }
    }
    terms
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
    use super::{MAX_TERM_CHARS, tokenize};

    fn terms(text: &str) -> Vec<String> {
        super::load_bundled_chinese();
        tokenize(text).into_iter().map(Into::into).collect()
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
        assert_ne!(terms("สวัสดี"), [] as [String; 0]);
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
                assert_ne!(query_terms, [] as [String; 0]);
                assert!(
                    query_terms.iter().all(|term| document.contains(term)),
                    "{query:?} tokenized to {query_terms:?}, which the document {document:?} cannot match"
                );
            }
        }
    }

    #[test]
    fn test_missing_chinese_dictionary_keeps_latin_terms() {
        assert_eq!(super::tokenize_with("deploy 中文搜索", None), ["deploy"]);
        assert_eq!(super::tokenize_with("中文搜索", None), [] as [&str; 0]);
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
