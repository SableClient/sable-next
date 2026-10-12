use matrix_sdk::ruma::OwnedUserId;
use serde_json::{Map, Value, json};

use crate::Core;
use crate::cosmetics::MEMBER_COLOR_FIELD;
use crate::protocol::{
    AvatarEditView, CommandErr, FieldEdit, OverrideColorView, OverrideTextView,
    ProfileOverrideView, ProfileOverridesView, SealStateView,
};

const PROFILE_OVERRIDES_EVENT: &str = "m.profile_overrides";
const UNSTABLE_PROFILE_OVERRIDES_EVENT: &str = "org.matrix.msc4529.profile_overrides";

/// The `EncryptedFile` shape `fetch_media` can decrypt, so the avatar is
/// handed on as its JSON.
fn is_encrypted_file(value: &Value) -> bool {
    let text = |field: &str| value.get(field).and_then(Value::as_str);
    text("url").is_some_and(|url| url.starts_with("mxc://"))
        && text("v").is_some()
        && text("iv").is_some()
        && value
            .get("hashes")
            .and_then(|hashes| hashes.get("sha256"))
            .and_then(Value::as_str)
            .is_some()
        && value
            .get("key")
            .and_then(|key| key.get("k"))
            .and_then(Value::as_str)
            .is_some()
}

fn text_override(value: Option<&Value>) -> OverrideTextView {
    match value {
        Some(Value::Null) => OverrideTextView::Cleared,
        Some(Value::String(text)) => OverrideTextView::Set {
            value: text.clone(),
        },
        _ => OverrideTextView::Unset,
    }
}

fn avatar_override(value: Option<&Value>) -> OverrideTextView {
    match value {
        Some(file) if is_encrypted_file(file) => OverrideTextView::Set {
            value: file.to_string(),
        },
        other => text_override(other),
    }
}

fn color_override(value: Option<&Value>) -> OverrideColorView {
    match value {
        Some(Value::Null) => OverrideColorView::Cleared,
        Some(Value::Object(colors)) => {
            let read = |key: &str| {
                colors
                    .get(key)
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            };
            match (read("on_light"), read("on_dark")) {
                (None, None) => OverrideColorView::Unset,
                (light, dark) => OverrideColorView::Set { light, dark },
            }
        }
        _ => OverrideColorView::Unset,
    }
}

pub(crate) fn overrides(content: Option<&Value>) -> Vec<ProfileOverrideView> {
    content
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(user_id, entry)| {
            let user_id = OwnedUserId::try_from(user_id.as_str()).ok()?;
            let entry = entry.as_object()?;
            Some(ProfileOverrideView {
                user_id,
                display_name: text_override(entry.get("displayname")),
                avatar: avatar_override(entry.get("avatar_url")),
                color: color_override(entry.get(MEMBER_COLOR_FIELD)),
            })
        })
        .collect()
}

pub(crate) struct OverrideEdit {
    pub(crate) display_name: FieldEdit,
    pub(crate) avatar: AvatarEditView,
    pub(crate) color: FieldEdit,
}

fn apply_text(entry: &mut Map<String, Value>, key: &str, edit: &FieldEdit) {
    match edit {
        FieldEdit::Keep => {}
        FieldEdit::Set { value } if !value.is_empty() => {
            entry.insert(key.to_owned(), json!(value));
        }
        FieldEdit::Clear | FieldEdit::Set { .. } => {
            entry.remove(key);
        }
    }
}

/// Fields we do not model survive; a user left with nothing is dropped.
pub(crate) fn edited_overrides(stored: Option<Value>, user_id: &str, edit: &OverrideEdit) -> Value {
    let mut content = match stored {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let mut entry = match content.remove(user_id) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    };
    apply_text(&mut entry, "displayname", &edit.display_name);
    match &edit.avatar {
        AvatarEditView::Keep => {}
        AvatarEditView::Clear => {
            entry.remove("avatar_url");
        }
        AvatarEditView::Url { url } => {
            entry.insert("avatar_url".to_owned(), json!(url));
        }
        AvatarEditView::Encrypted { file } => {
            entry.insert("avatar_url".to_owned(), file.clone());
        }
    }
    match &edit.color {
        FieldEdit::Keep => {}
        FieldEdit::Set { value } if !value.is_empty() => {
            entry.insert(
                MEMBER_COLOR_FIELD.to_owned(),
                json!({ "on_light": value, "on_dark": value }),
            );
        }
        FieldEdit::Clear | FieldEdit::Set { .. } => {
            entry.remove(MEMBER_COLOR_FIELD);
        }
    }
    if !entry.is_empty() {
        content.insert(user_id.to_owned(), Value::Object(entry));
    }
    Value::Object(content)
}

struct StoredOverrides {
    content: Option<Value>,
    sealed_type: bool,
    protection: SealStateView,
    can_seal: bool,
}

impl Core {
    /// MSC4529's stable type wins and stays plain; otherwise the unstable type
    /// is read through the account data key.
    async fn stored_overrides(&self) -> Result<StoredOverrides, CommandErr> {
        let stable = self
            .global_account_data(PROFILE_OVERRIDES_EVENT.into(), "profile_overrides")
            .await?
            .and_then(|raw| raw.deserialize_as::<Value>().ok())
            .filter(Value::is_object);
        if stable.is_some() {
            return Ok(StoredOverrides {
                content: stable,
                sealed_type: false,
                protection: SealStateView::Plain,
                can_seal: false,
            });
        }
        let document = self
            .sealed_account_data(UNSTABLE_PROFILE_OVERRIDES_EVENT)
            .await?;
        Ok(StoredOverrides {
            content: document.content,
            sealed_type: true,
            protection: document.state,
            can_seal: document.can_seal,
        })
    }

    fn overrides_view(stored: &StoredOverrides) -> ProfileOverridesView {
        ProfileOverridesView {
            overrides: if stored.protection == SealStateView::Locked {
                Vec::new()
            } else {
                overrides(stored.content.as_ref())
            },
            protection: stored.protection,
            can_seal: stored.can_seal,
        }
    }

    /// A plaintext unstable document read while the key is at hand is sealed.
    pub(crate) async fn profile_overrides(&self) -> Result<ProfileOverridesView, CommandErr> {
        let stored = self.stored_overrides().await?;
        let view = Self::overrides_view(&stored);
        if stored.sealed_type
            && stored.protection == SealStateView::Plain
            && stored.can_seal
            && !view.overrides.is_empty()
            && let Some(content) = &stored.content
        {
            self.set_sealed_account_data(UNSTABLE_PROFILE_OVERRIDES_EVENT, content)
                .await?;
        }
        Ok(view)
    }

    /// Refused while locked: writing from an empty view would erase the other
    /// devices' copy.
    pub(crate) async fn set_profile_override(
        &self,
        user_id: &OwnedUserId,
        edit: &OverrideEdit,
    ) -> Result<ProfileOverridesView, CommandErr> {
        let _guard = self.account_data_lock.lock().await;
        let stored = self.stored_overrides().await?;
        if stored.protection == SealStateView::Locked {
            return Err(CommandErr::DocumentLocked);
        }
        let content = edited_overrides(stored.content, user_id.as_str(), edit);
        if stored.sealed_type {
            self.set_sealed_account_data(UNSTABLE_PROFILE_OVERRIDES_EVENT, &content)
                .await?;
        } else {
            self.set_account_data(PROFILE_OVERRIDES_EVENT, &content)
                .await?;
        }
        Ok(Self::overrides_view(&StoredOverrides {
            content: Some(content),
            ..stored
        }))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{OverrideEdit, edited_overrides, overrides};
    use crate::protocol::{AvatarEditView, FieldEdit, OverrideColorView, OverrideTextView};

    fn keep() -> OverrideEdit {
        OverrideEdit {
            display_name: FieldEdit::Keep,
            avatar: AvatarEditView::Keep,
            color: FieldEdit::Keep,
        }
    }

    #[test]
    fn each_field_tells_unset_from_cleared_from_set() {
        let content = json!({
            "@a:example.org": {
                "displayname": null,
                "avatar_url": "mxc://example.org/a",
                "eu.she-a.color": { "on_dark": "#112233" },
            },
            "@b:example.org": { "displayname": "Bee", "eu.she-a.color": null },
            "not a user": { "displayname": "x" },
            "@c:example.org": "not an object",
        });
        let read = overrides(Some(&content));

        assert_eq!(read.len(), 2);
        let first = read.first().expect("first override");
        assert_eq!(first.user_id.as_str(), "@a:example.org");
        assert_eq!(first.display_name, OverrideTextView::Cleared);
        assert_eq!(
            first.avatar,
            OverrideTextView::Set {
                value: "mxc://example.org/a".to_owned()
            }
        );
        assert_eq!(
            first.color,
            OverrideColorView::Set {
                light: None,
                dark: Some("#112233".to_owned())
            }
        );
        let second = read.get(1).expect("second override");
        assert_eq!(second.avatar, OverrideTextView::Unset);
        assert_eq!(second.color, OverrideColorView::Cleared);
    }

    #[test]
    fn an_encrypted_avatar_is_handed_on_as_its_json() {
        let file = json!({
            "url": "mxc://example.org/enc",
            "v": "v2",
            "iv": "iv",
            "hashes": { "sha256": "h" },
            "key": { "k": "k" },
        });
        let read = overrides(Some(&json!({ "@a:example.org": { "avatar_url": file } })));

        let OverrideTextView::Set { value } = &read.first().expect("override").avatar else {
            panic!("expected an avatar");
        };
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(value).ok(),
            Some(file)
        );
    }

    #[test]
    fn an_avatar_missing_part_of_its_file_is_not_encrypted() {
        let partial = json!({ "url": "mxc://example.org/enc", "v": "v2", "iv": "iv" });
        let read = overrides(Some(
            &json!({ "@a:example.org": { "avatar_url": partial } }),
        ));

        assert_eq!(
            read.first().expect("override").avatar,
            OverrideTextView::Unset
        );
    }

    #[test]
    fn an_edit_keeps_unknown_fields_and_drops_an_emptied_user() {
        let stored = json!({
            "@a:example.org": { "displayname": "A", "x.extra": 1 },
            "@b:example.org": { "displayname": "B" },
        });
        let edit = OverrideEdit {
            display_name: FieldEdit::Set {
                value: "Ay".to_owned(),
            },
            color: FieldEdit::Set {
                value: "#abcdef".to_owned(),
            },
            ..keep()
        };
        let next = edited_overrides(Some(stored), "@a:example.org", &edit);
        assert_eq!(
            next["@a:example.org"],
            json!({
                "displayname": "Ay",
                "x.extra": 1,
                "eu.she-a.color": { "on_light": "#abcdef", "on_dark": "#abcdef" },
            })
        );

        let reset = OverrideEdit {
            display_name: FieldEdit::Clear,
            avatar: AvatarEditView::Clear,
            color: FieldEdit::Clear,
        };
        assert_eq!(
            edited_overrides(Some(next), "@b:example.org", &reset).get("@b:example.org"),
            None
        );
    }
}
