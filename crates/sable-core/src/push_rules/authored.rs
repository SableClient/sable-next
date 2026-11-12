use matrix_sdk::ruma::serde::Raw;
use serde_json::Value;

/// Push rules match `content.body`, which can hold a reply fallback or a profile name the sender never typed.
pub fn authored_event<T>(event: &Raw<T>) -> Option<Raw<T>> {
    let mut value = event.deserialize_as_unchecked::<Value>().ok()?;
    let content = value.get_mut("content")?;
    let body = content.get("body")?.as_str()?;
    let authored = crate::view::authored_body(body, Some(content));
    if authored == body {
        return None;
    }
    content["body"] = Value::String(authored);
    Raw::new(&value).ok().map(Raw::cast_unchecked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn authored_body(content: &Value) -> Option<String> {
        let event =
            Raw::<Value>::new(&json!({"type": "m.room.message", "content": content})).unwrap();
        authored_event(&event).map(|event| {
            event.deserialize_as_unchecked::<Value>().unwrap()["content"]["body"]
                .as_str()
                .unwrap()
                .to_owned()
        })
    }

    #[test]
    fn a_reply_fallback_is_left_out() {
        assert_eq!(
            authored_body(&json!({
                "msgtype": "m.text",
                "body": "> <@someone:paige.moe> is this correct\n\nyou're not specifying a tag"
            }))
            .as_deref(),
            Some("you're not specifying a tag")
        );
    }

    #[test]
    fn a_profile_fallback_name_is_left_out() {
        assert_eq!(
            authored_body(&json!({
                "msgtype": "m.text",
                "body": "Erwan: hi",
                "com.beeper.per_message_profile": {"displayname": "Erwan", "has_fallback": true}
            }))
            .as_deref(),
            Some("hi")
        );
    }

    #[test]
    fn a_body_the_sender_wrote_is_kept() {
        assert_eq!(
            authored_body(&json!({"msgtype": "m.text", "body": "Erwan: hi"})),
            None
        );
    }
}
