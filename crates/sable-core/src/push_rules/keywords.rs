use base64::Engine as _;
use matrix_sdk::ruma::push::{NewPatternedPushRule, NewPushRule, RuleKind, Ruleset};

use super::{RuleWrite, level, level_actions, plan_level};
use crate::errors::CoreError;
use crate::protocol::{KeywordNotificationView, MentionNotificationModeView};

fn keyword_rules<'a>(rules: &'a Ruleset, keyword: &'a str) -> impl Iterator<Item = &'a str> {
    rules
        .content
        .iter()
        .filter(move |rule| !rule.default && rule.pattern == keyword)
        .map(|rule| rule.rule_id.as_str())
}

#[must_use]
pub fn keywords(rules: &Ruleset) -> Vec<KeywordNotificationView> {
    let mut keywords: Vec<KeywordNotificationView> = Vec::new();
    for rule in rules.content.iter().filter(|rule| !rule.default) {
        let mode = level(rule.enabled, &rule.actions);
        match keywords
            .iter_mut()
            .find(|entry| entry.keyword == rule.pattern)
        {
            Some(entry) if mode_rank(mode) > mode_rank(entry.mode) => entry.mode = mode,
            Some(_) => {}
            None => keywords.push(KeywordNotificationView {
                keyword: rule.pattern.clone(),
                mode,
            }),
        }
    }
    keywords.sort_unstable_by(|left, right| left.keyword.cmp(&right.keyword));
    keywords
}

const fn mode_rank(mode: MentionNotificationModeView) -> u8 {
    match mode {
        MentionNotificationModeView::Off => 0,
        MentionNotificationModeView::Notify => 1,
        MentionNotificationModeView::Loud => 2,
    }
}

fn keyword_rule_id(rules: &Ruleset, keyword: &str) -> String {
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(keyword);
    let base = format!("moe.sable.keyword.{encoded}");
    let mut id = base.clone();
    let mut suffix = 1_u64;
    while rules.content.iter().any(|rule| rule.rule_id == id) {
        id = format!("{base}.{suffix}");
        suffix += 1;
    }
    id
}

/// # Errors
///
/// When the keyword is blank.
pub fn plan_add_keyword(rules: &Ruleset, keyword: &str) -> Result<Vec<RuleWrite>, CoreError> {
    let pattern = keyword.trim();
    if pattern.is_empty() {
        return Err("a keyword cannot be blank".into());
    }
    if keyword_rules(rules, pattern).next().is_some() {
        return Ok(plan_keyword_mode(
            rules,
            pattern,
            MentionNotificationModeView::Notify,
        ));
    }
    let rule_id = keyword_rule_id(rules, pattern);
    Ok(vec![
        RuleWrite::Put(NewPushRule::Content(NewPatternedPushRule::new(
            rule_id.clone(),
            pattern.to_owned(),
            level_actions(MentionNotificationModeView::Notify, true),
        ))),
        RuleWrite::Enabled {
            kind: RuleKind::Content,
            rule_id,
            enabled: true,
        },
    ])
}

#[must_use]
pub fn plan_keyword_mode(
    rules: &Ruleset,
    keyword: &str,
    mode: MentionNotificationModeView,
) -> Vec<RuleWrite> {
    keyword_rules(rules, keyword)
        .flat_map(|rule_id| plan_level(RuleKind::Content, rule_id, mode, true))
        .collect()
}

#[must_use]
pub fn plan_remove_keyword(rules: &Ruleset, keyword: &str) -> Vec<RuleWrite> {
    keyword_rules(rules, keyword)
        .map(ToOwned::to_owned)
        .map(|rule_id| RuleWrite::Delete {
            kind: RuleKind::Content,
            rule_id,
        })
        .collect()
}
