//! MSC3381 poll start events. Tallying lives in `view`.

use matrix_sdk::ruma::UInt;
use matrix_sdk::ruma::events::poll::start::PollKind;
use matrix_sdk::ruma::events::poll::unstable_start::{
    NewUnstablePollStartEventContent, UnstablePollAnswer, UnstablePollAnswers,
    UnstablePollStartContentBlock,
};

/// `None` unless the question is non-blank and the answers number 1 to 20.
#[must_use]
pub fn start(
    question: &str,
    answers: &[String],
    undisclosed: bool,
    max_selections: u32,
) -> Option<NewUnstablePollStartEventContent> {
    let question = question.trim();
    if question.is_empty() {
        return None;
    }

    let answers: Vec<UnstablePollAnswer> = answers
        .iter()
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .enumerate()
        .map(|(index, text)| UnstablePollAnswer::new(index.to_string(), text))
        .collect();
    let fallback = fallback_text(question, &answers);
    let answers = UnstablePollAnswers::try_from(answers).ok()?;

    let mut block = UnstablePollStartContentBlock::new(question, answers);
    block.kind = if undisclosed {
        PollKind::Undisclosed
    } else {
        PollKind::Disclosed
    };
    // The spec floor is 1; zero would be a poll nobody can answer.
    block.max_selections = UInt::from(max_selections.max(1));

    Some(NewUnstablePollStartEventContent::plain_text(
        fallback, block,
    ))
}

fn fallback_text(question: &str, answers: &[UnstablePollAnswer]) -> String {
    let numbered = answers
        .iter()
        .enumerate()
        .map(|(index, answer)| format!("{}. {}", index + 1, answer.text));

    std::iter::once(question.to_owned())
        .chain(numbered)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::start;

    fn answers(texts: &[&str]) -> Vec<String> {
        texts.iter().map(|text| (*text).to_owned()).collect()
    }

    #[test]
    fn rejects_a_blank_question() {
        assert!(start("   ", &answers(&["yes"]), false, 1).is_none());
    }

    #[test]
    fn rejects_a_poll_with_no_answer_left_after_trimming() {
        assert!(start("lunch?", &answers(&["", "  "]), false, 1).is_none());
    }

    #[test]
    fn rejects_more_answers_than_the_spec_allows() {
        let many: Vec<String> = (0..21).map(|index| index.to_string()).collect();
        assert!(start("too many?", &many, false, 1).is_none());
    }

    #[test]
    fn numbers_the_fallback_so_a_poll_reads_without_support() {
        let content = start("lunch?", &answers(&["ramen", "curry"]), false, 1)
            .expect("a question and two answers are a valid poll");

        assert_eq!(content.text.as_deref(), Some("lunch?\n1. ramen\n2. curry"));
    }

    #[test]
    fn floors_max_selections_at_one() {
        let content = start("lunch?", &answers(&["ramen"]), false, 0)
            .expect("a question and one answer are a valid poll");

        assert_eq!(
            content.poll_start.max_selections,
            matrix_sdk::ruma::uint!(1)
        );
    }

    #[test]
    fn an_undisclosed_poll_carries_the_undisclosed_kind() {
        let content = start("lunch?", &answers(&["ramen"]), true, 1)
            .expect("a question and one answer are a valid poll");

        assert!(matches!(
            content.poll_start.kind,
            matrix_sdk::ruma::events::poll::start::PollKind::Undisclosed
        ));
    }
}
