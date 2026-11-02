use matrix_sdk::ruma::push::{
    Action, AnyPushRuleRef, FlattenedJson, PushCondition, PushConditionRoomCtx,
};
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::ruma::{EventId, OwnedEventId};
use serde_json::{Map, Value};

const RELATED_EVENT_MATCH: &str = "im.nheko.msc3664.related_event_match";

#[expect(
    clippy::expect_used,
    reason = "an object with a `kind` always deserializes, as a custom condition at worst"
)]
pub(super) fn related_condition(rel_type: &str, key: &str, pattern: &str) -> PushCondition {
    serde_json::from_value(serde_json::json!({
        "kind": RELATED_EVENT_MATCH,
        "rel_type": rel_type,
        "key": key,
        "pattern": pattern,
    }))
    .expect("a custom push condition always deserializes")
}

fn conditions<'rules>(rule: &AnyPushRuleRef<'rules>) -> &'rules [PushCondition] {
    match rule {
        AnyPushRuleRef::Override(rule) | AnyPushRuleRef::Underride(rule) => &rule.conditions,
        _ => &[],
    }
}

fn has_related(rule: &AnyPushRuleRef<'_>) -> bool {
    conditions(rule)
        .iter()
        .any(|condition| condition.kind() == RELATED_EVENT_MATCH)
}

/// The actions for `event` once rules using `related_event_match` are
/// evaluated, which ruma treats as never matching.
pub async fn related_actions<T>(
    room: &matrix_sdk::Room,
    event: &Raw<T>,
    actions: Vec<Action>,
) -> Vec<Action> {
    let Ok(rules) = room.client().account().push_rules().await else {
        return actions;
    };
    if !rules
        .iter()
        .any(|rule| rule.enabled() && has_related(&rule))
    {
        return actions;
    }
    let Ok(Some(context)) = room.push_condition_room_ctx().await else {
        return actions;
    };
    let flattened = FlattenedJson::from_raw(event);
    if flattened.get_str("sender") == Some(context.user_id.as_str()) {
        return actions;
    }
    let matched = rules
        .get_match(event, &context)
        .await
        .map(|rule| (std::mem::discriminant(&rule), rule.rule_id().to_owned()));
    for rule in &rules {
        if matched.as_ref().is_some_and(|(kind, id)| {
            std::mem::discriminant(&rule) == *kind && rule.rule_id() == id
        }) {
            break;
        }
        if rule.enabled()
            && has_related(&rule)
            && rule_applies(room, &flattened, &context, conditions(&rule)).await
        {
            return rule.actions().to_vec();
        }
    }
    actions
}

async fn rule_applies(
    room: &matrix_sdk::Room,
    event: &FlattenedJson,
    context: &PushConditionRoomCtx,
    conditions: &[PushCondition],
) -> bool {
    for condition in conditions {
        let applies = if condition.kind() == RELATED_EVENT_MATCH {
            related_applies(room, event, &condition.data()).await
        } else {
            condition.applies(event, context).await
        };
        if !applies {
            return false;
        }
    }
    true
}

async fn related_applies(
    room: &matrix_sdk::Room,
    event: &FlattenedJson,
    condition: &Map<String, Value>,
) -> bool {
    let Some(rel_type) = condition.get("rel_type").and_then(Value::as_str) else {
        return false;
    };
    let include_fallbacks = condition
        .get("include_fallbacks")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(target) = related_event_id(event, rel_type, include_fallbacks) else {
        return false;
    };
    let (Some(key), Some(pattern)) = (
        condition.get("key").and_then(Value::as_str),
        condition.get("pattern").and_then(Value::as_str),
    ) else {
        return true;
    };
    let Ok(related) = room.load_or_fetch_event(&target, None).await else {
        return false;
    };
    FlattenedJson::from_raw(related.raw())
        .get_str(key)
        .is_some_and(|value| glob_matches(pattern, value))
}

fn related_event_id(
    event: &FlattenedJson,
    rel_type: &str,
    include_fallbacks: bool,
) -> Option<OwnedEventId> {
    let id = if rel_type == "m.in_reply_to" {
        let falling_back =
            event.get(r"content.m\.relates_to.is_falling_back") == Some(&true.into());
        if falling_back && !include_fallbacks {
            return None;
        }
        event.get_str(r"content.m\.relates_to.m\.in_reply_to.event_id")?
    } else {
        if event.get_str(r"content.m\.relates_to.rel_type") != Some(rel_type) {
            return None;
        }
        event.get_str(r"content.m\.relates_to.event_id")?
    };
    EventId::parse(id).ok()
}

/// `event_match` glob semantics: whole value, case-insensitive, `*` and `?`.
fn glob_matches(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.to_lowercase().chars().collect();
    let value: Vec<char> = value.to_lowercase().chars().collect();
    let (mut p, mut v) = (0, 0);
    let mut backtrack = None;
    while v < value.len() {
        match pattern.get(p) {
            Some('*') => {
                backtrack = Some((p, v));
                p += 1;
            }
            Some('?') => {
                p += 1;
                v += 1;
            }
            Some(c) if value.get(v) == Some(c) => {
                p += 1;
                v += 1;
            }
            _ => match backtrack {
                Some((star, matched)) => {
                    p = star + 1;
                    v = matched + 1;
                    backtrack = Some((star, matched + 1));
                }
                None => return false,
            },
        }
    }
    pattern.iter().skip(p).all(|c| *c == '*')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn flattened(content: &Value) -> FlattenedJson {
        FlattenedJson::from_raw(
            &Raw::new(&json!({"type": "m.reaction", "content": content})).unwrap(),
        )
    }

    #[test]
    fn globs_match_the_whole_value_ignoring_case() {
        assert!(glob_matches("@me:example.org", "@Me:example.org"));
        assert!(glob_matches("@*:example.org", "@me:example.org"));
        assert!(glob_matches("@m?:*", "@me:example.org"));
        assert!(!glob_matches("@me:example.org", "@me:example.org.evil"));
        assert!(!glob_matches("@m?:example.org", "@mee:example.org"));
    }

    #[test]
    fn a_relation_is_followed_only_for_its_own_type() {
        let reaction = flattened(&json!({
            "m.relates_to": {"rel_type": "m.annotation", "event_id": "$target", "key": "👍"}
        }));
        assert_eq!(
            related_event_id(&reaction, "m.annotation", false).as_deref(),
            Some(<&EventId>::try_from("$target").unwrap())
        );
        assert_eq!(related_event_id(&reaction, "m.replace", false), None);
    }

    #[test]
    fn a_reply_fallback_is_followed_only_when_asked() {
        let threaded = flattened(&json!({
            "m.relates_to": {
                "rel_type": "m.thread",
                "event_id": "$root",
                "is_falling_back": true,
                "m.in_reply_to": {"event_id": "$latest"}
            }
        }));
        assert_eq!(related_event_id(&threaded, "m.in_reply_to", false), None);
        assert_eq!(
            related_event_id(&threaded, "m.in_reply_to", true).as_deref(),
            Some(<&EventId>::try_from("$latest").unwrap())
        );
    }

    #[test]
    fn the_condition_round_trips_under_the_unstable_name() {
        let condition = related_condition("m.annotation", "sender", "@me:example.org");
        assert_eq!(
            serde_json::to_value(&condition).unwrap(),
            json!({
                "kind": RELATED_EVENT_MATCH,
                "rel_type": "m.annotation",
                "key": "sender",
                "pattern": "@me:example.org"
            })
        );
    }
}
