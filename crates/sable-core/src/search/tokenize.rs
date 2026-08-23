use std::borrow::Cow;

use charabia::{Script, Token, TokenKind, Tokenize};
use rust_stemmers::{Algorithm, Stemmer};

pub(crate) fn tokenize(text: &str) -> Vec<Cow<'static, str>> {
    text.tokenize()
        .filter(|token| token.kind == TokenKind::Word)
        .map(|token| Cow::<'static, str>::Owned(stem(&token)))
        .filter(|term| !term.is_empty())
        .collect()
}

fn stem(token: &Token<'_>) -> String {
    let lemma = token.lemma();
    stemmer_for(token.script).map_or_else(
        || lemma.to_owned(),
        |algorithm| Stemmer::create(algorithm).stem(lemma).into_owned(),
    )
}

const fn stemmer_for(script: Script) -> Option<Algorithm> {
    Some(match script {
        Script::Latin => Algorithm::English,
        Script::Cyrillic => Algorithm::Russian,
        Script::Greek => Algorithm::Greek,
        Script::Arabic => Algorithm::Arabic,
        Script::Tamil => Algorithm::Tamil,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::tokenize;

    fn terms(text: &str) -> Vec<String> {
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
        assert!(!terms("สวัสดี").is_empty());
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
