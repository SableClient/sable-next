use serde_json::{Value, json};

use crate::{
    instance::{Era, InstanceId},
    ports::Platform,
    wire::WIRE_SCHEMA,
};

const MAX_PERSISTED_BYTES: usize = 1 << 20;

/// Per account, so one account never starts from another's.
pub fn storage_key(era: &Era, id: &InstanceId) -> String {
    format!("snapshot/{}/{}/{}", era.account, id.slice, id.key)
}

/// Only a view saved by a build with the same wire.
pub async fn load(platform: &dyn Platform, key: &str) -> Option<Value> {
    let stored = platform.storage_get(key).await.ok()??;
    let Value::Object(mut saved) = serde_json::from_str(&stored).ok()? else {
        return None;
    };
    (saved.remove("schema")? == WIRE_SCHEMA)
        .then(|| saved.remove("view"))
        .flatten()
}

/// `None` for a view too large to keep.
pub fn encode(view: &Value) -> Option<String> {
    let saved = json!({"schema": WIRE_SCHEMA, "view": view}).to_string();
    if saved.len() > MAX_PERSISTED_BYTES {
        tracing::warn!(bytes = saved.len(), "a view is too large to persist");
        return None;
    }
    Some(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_view_saved_by_another_wire_is_not_loaded() {
        let saved = encode(&json!({"a": 1})).unwrap();
        assert!(saved.contains(WIRE_SCHEMA));
        assert_eq!(
            serde_json::from_str::<Value>(&saved).unwrap()["view"],
            json!({"a": 1})
        );
        assert!(encode(&json!("x".repeat(MAX_PERSISTED_BYTES))).is_none());
    }
}
