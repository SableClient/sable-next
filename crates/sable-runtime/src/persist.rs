use serde_json::{Value, json};

use crate::{
    instance::{Era, InstanceId},
    ports::Platform,
    wire::WIRE_SCHEMA,
};

const MAX_PERSISTED_BYTES: usize = 1 << 20;

pub fn storage_key(era: &Era, id: &InstanceId) -> String {
    format!("snapshot/{}/{}/{}", era.account, id.slice, id.key)
}

pub async fn load(platform: &dyn Platform, key: &str) -> Option<Value> {
    let stored = platform.storage_get(key).await.ok()??;
    let Value::Object(mut saved) = serde_json::from_str(&stored).ok()? else {
        return None;
    };
    (saved.remove("schema")? == WIRE_SCHEMA)
        .then(|| saved.remove("view"))
        .flatten()
}

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
    fn a_view_over_the_size_cap_is_not_saved() {
        assert!(encode(&json!("x".repeat(MAX_PERSISTED_BYTES))).is_none());
    }
}
