//! Which core calls move the app to another account, and to which.

use serde_json::Value;

/// Whether a core call can change the account the core serves.
#[must_use]
pub fn changes_account(method: &str) -> bool {
    matches!(
        method,
        "session.restore" | "session.switch_account" | "session.logout"
    )
}

/// A logout, or a restore that found nothing, leaves no account: `""`.
#[must_use]
pub fn account_after(method: &str, result: &str) -> Option<String> {
    match method {
        "session.restore" | "session.switch_account" => {
            let info: Value = serde_json::from_str(result).ok()?;
            Some(
                info.get("account_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            )
        }
        "session.logout" => Some(String::new()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_calls_that_change_the_account_are_followed() {
        assert!(changes_account("session.restore"));
        assert!(!changes_account("rooms.list"));
        assert_eq!(
            account_after("session.restore", "null"),
            Some(String::new())
        );
        assert_eq!(
            account_after("session.restore", r#"{"account_id":"3"}"#),
            Some("3".to_owned())
        );
        assert_eq!(
            account_after("session.switch_account", r#"{"account_id":"4"}"#),
            Some("4".to_owned())
        );
        assert_eq!(account_after("session.logout", "null"), Some(String::new()));
        assert_eq!(account_after("rooms.list", "[]"), None);
        assert_eq!(account_after("session.restore", "not json"), None);
    }
}
