use std::borrow::Cow;
use std::ops::Range;
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

/// Each term comes with the bytes of `text` its word spans. A script written
/// without spaces is indexed as overlapping pairs of characters, plus the last
/// character of each run, so a one character query still finds it.
#[must_use]
pub(crate) fn tokenize(text: &str) -> Vec<(Cow<'static, str>, Range<usize>)> {
    let mut terms = Vec::new();
    for token in text
        .tokenize()
        .filter(|token| token.kind == TokenKind::Word)
    {
        let word = token.byte_start..token.byte_end;
        if unspaced(text, &token) {
            let characters = normalized(&token);
            terms.extend(pairs(&characters).map(|pair| (pair, word.clone())));
            terms.extend(
                characters
                    .last()
                    .map(|last| (Cow::Owned(last.to_string()), word.clone())),
            );
        } else {
            terms.extend(term(&token).map(|term| (term, word)));
        }
    }
    terms
}

/// A query is a list of words, each spelled as it was typed, and a document
/// matches a word only when it holds every term of it. A script written
/// without spaces is cut where `words`, the query as the platform's word
/// segmenter split it, says; a run they do not cover stays one word.
#[must_use]
pub(crate) fn tokenize_query<'text>(
    text: &'text str,
    words: &[String],
) -> Vec<(&'text str, Vec<Cow<'static, str>>)> {
    let mut groups = Vec::new();
    for token in text
        .tokenize()
        .filter(|token| token.kind == TokenKind::Word)
    {
        if unspaced(text, &token) {
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
                    groups.push((word, group));
                }
            }
        } else {
            let typed = text
                .get(token.byte_start..token.byte_end)
                .unwrap_or_default();
            groups.extend(term(&token).map(|term| (typed, vec![term])));
        }
    }
    groups
}

/// Chinese characters, Japanese kana, Thai, Lao, Myanmar and Khmer, as charabia
/// tells them apart. `UNSPACED` in src/lib/features/search/query-words.ts
/// mirrors it.
#[must_use]
pub(crate) fn is_unspaced(character: char) -> bool {
    matches!(
        Script::from(character),
        Script::Cj | Script::Thai | Script::Khmer | Script::Myanmar
    ) || is_lao(character)
        || is_myanmar_extended(character)
}

/// charabia only knows the main Myanmar block; these are Myanmar Extended-B and Extended-A.
const fn is_myanmar_extended(character: char) -> bool {
    matches!(character, '\u{A9E0}'..='\u{A9FF}' | '\u{AA60}'..='\u{AA7F}')
}

/// charabia has no script for Lao.
const fn is_lao(character: char) -> bool {
    matches!(character, '\u{0E80}'..='\u{0EFF}')
}

#[must_use]
pub(crate) fn contains_unspaced(text: &str) -> bool {
    text.chars().any(is_unspaced)
}

/// Judged on the text as written, like the query words the client segments.
fn unspaced(text: &str, token: &Token<'_>) -> bool {
    text.get(token.byte_start..token.byte_end)
        .is_some_and(contains_unspaced)
}

/// Cuts a run into the longest words that start where the previous one ended.
/// A single character the segmenter leaves over usually belongs to a word it
/// does not know, Japanese above all, so it stays joined to its neighbours.
/// A lone hiragana between two words written in kanji or katakana is a
/// particle, which is dropped and cuts the run there: 日本語(で)検索.
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
        let particle = single
            && word.chars().all(is_hiragana)
            && run
                .get(start..end)
                .and_then(|piece| piece.chars().next_back())
                .is_some_and(starts_japanese_word)
            && rest
                .get(word.len()..)
                .and_then(|after| after.chars().next())
                .is_some_and(starts_japanese_word);
        if particle {
            pieces.extend(run.get(start..end));
            end += word.len();
            start = end;
            joined = false;
            continue;
        }
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

const fn is_hiragana(character: char) -> bool {
    matches!(character, '\u{3041}'..='\u{309F}')
}

/// Katakana or a kanji.
fn starts_japanese_word(character: char) -> bool {
    Script::from(character) == Script::Cj && !is_hiragana(character)
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

fn term(token: &Token<'_>) -> Option<Cow<'static, str>> {
    let term = limit_term(stem(token));
    (!term.is_empty()).then_some(Cow::Owned(term))
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
    use std::borrow::Cow;

    use super::{MAX_TERM_CHARS, tokenize, tokenize_query};

    fn words(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    fn terms(text: &str) -> Vec<String> {
        tokenize(text)
            .into_iter()
            .map(|(term, _)| term.into())
            .collect()
    }

    fn query_terms(text: &str, words: &[String]) -> Vec<Vec<Cow<'static, str>>> {
        tokenize_query(text, words)
            .into_iter()
            .map(|(_, terms)| terms)
            .collect()
    }

    fn finds(query: &str, document: &str) -> bool {
        crate::matching::matched_words(query, &[], document, false).is_some()
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
    fn test_thai_lao_myanmar_and_khmer_words_are_found_inside_a_run() {
        assert!(finds("ครับ", "สวัสดีครับ"));
        assert!(!finds("ครับ", "สวัสดีค่ะ"));
        assert!(finds("ບາຍ", "ສະບາຍດີ"));
        assert!(finds("បាទ", "សួស្តីបាទ"));
        assert!(finds("ဂလာ", "မင်္ဂလာပါ"));
    }

    #[test]
    fn test_a_run_that_starts_with_a_number_is_still_cut_into_pairs() {
        assert!(finds("会議", "2024年の会議"));
        assert!(finds("บาท", "100บาท"));
    }

    #[test]
    fn test_the_unspaced_scripts_are_the_ones_the_client_segments() {
        let fixture = include_str!("../tests/fixtures/unspaced.txt");
        for line in fixture.lines() {
            let mut characters = line.split(' ');
            let unspaced = characters.next() == Some("unspaced");
            for character in characters.flat_map(str::chars) {
                assert_eq!(
                    super::is_unspaced(character),
                    unspaced,
                    "U+{:04X}",
                    u32::from(character)
                );
            }
        }
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
            query_terms("deploy 中文搜索", &[]),
            [vec!["deploy"], vec!["中文", "文搜", "搜索"]]
        );
    }

    #[test]
    fn test_a_query_is_cut_where_its_words_say() {
        assert_eq!(
            query_terms(
                "deploy 中文搜索功能",
                &words(&["deploy", "中文", "搜索功能"])
            ),
            [vec!["deploy"], vec!["中文"], vec!["搜索", "索功", "功能"]]
        );
        assert_eq!(
            query_terms("東京都", &words(&["東京", "東京都"])),
            [vec!["東京", "京都"]]
        );
    }

    #[test]
    fn test_each_query_word_keeps_its_spelling() {
        let typed: Vec<&str> = tokenize_query(
            "Deploy 東京都 日本語勉強",
            &words(&["Deploy", "東京", "都", "日本語", "勉強"]),
        )
        .into_iter()
        .map(|(typed, _)| typed)
        .collect();
        assert_eq!(typed, ["Deploy", "東京都", "日本語", "勉強"]);
    }

    #[test]
    fn test_a_character_left_over_stays_joined_to_its_neighbours() {
        assert_eq!(
            query_terms("東京都", &words(&["東京", "都"])),
            [vec!["東京", "京都"]]
        );
        assert_eq!(
            query_terms("ラーメン屋さん", &words(&["ラーメン", "屋", "さん"])),
            [vec!["ラー", "ーメ", "メン", "ン屋", "屋さ", "さん"]]
        );
        assert_eq!(query_terms("猫", &words(&["猫"])), [vec!["猫"]]);
    }

    #[test]
    fn test_a_particle_does_not_weld_the_words_around_it() {
        assert_eq!(
            query_terms("日本語で検索", &words(&["日本語", "で", "検索"])),
            [query_terms("日本語", &[]), query_terms("検索", &[])].concat()
        );
        assert_eq!(
            query_terms("検索を使う", &words(&["検索", "を", "使う"])),
            [query_terms("検索", &[]), query_terms("使う", &[])].concat()
        );
        assert_eq!(
            query_terms("お名前", &words(&["お", "名前"])),
            query_terms("お名前", &[])
        );
        let segmented = words(&["日本語", "で", "検索"]);
        assert!(crate::matching::matches_every_word(
            "日本語で検索",
            &segmented,
            "日本語の検索機能",
            false
        ));
        assert!(
            crate::matching::matched_words("日本語で検索", &segmented, "日本語の検索機能", false)
                .is_some()
        );
    }

    #[test]
    fn test_a_word_matches_only_where_its_pairs_follow_each_other() {
        let tokyo = words(&["東京", "都"]);
        let finds_tokyo =
            |document| crate::matching::matched_words("東京都", &tokyo, document, false).is_some();
        assert!(finds_tokyo("東京都に住む"));
        assert!(!finds_tokyo("京都から東京へ行く"));
        assert!(finds("電話番号", "電話番号を教える"));
        assert!(!finds("電話番号", "電話と話番号"));
    }

    #[test]
    fn test_words_that_do_not_cover_a_run_keep_it_whole() {
        assert_eq!(
            query_terms("中文搜索", &words(&["中文"])),
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
