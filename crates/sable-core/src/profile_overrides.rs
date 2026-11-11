use sable_model::text::visible_name;

use crate::api::account::AvatarEditView;
use matrix_sdk::ruma::OwnedUserId;
use serde::Deserialize;
use serde_json::{Map, Value};
use serde_with::{DefaultOnError, serde_as};

use crate::Core;
use crate::cosmetics::MEMBER_COLOR_FIELD;
use crate::protocol::{
    CoreEvent, FieldEdit, OverrideColorView, OverrideTextView, ProfileOverrideView,
    ProfileOverridesView, RpcCode, RpcError, SealStateView,
};

const PROFILE_OVERRIDES_EVENT: &str = "m.profile_overrides";
const UNSTABLE_PROFILE_OVERRIDES_EVENT: &str = "org.matrix.msc4529.profile_overrides";

pub(crate) fn is_override_event(event_type: &str) -> bool {
    event_type == PROFILE_OVERRIDES_EVENT || event_type == UNSTABLE_PROFILE_OVERRIDES_EVENT
}

#[serde_as]
#[derive(Deserialize)]
struct EncryptedFileIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    url: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    v: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    iv: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    hashes: Option<HashesIn>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    key: Option<KeyIn>,
}

#[serde_as]
#[derive(Deserialize)]
struct HashesIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    sha256: Option<String>,
}

#[serde_as]
#[derive(Deserialize)]
struct KeyIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    k: Option<String>,
}

/// The `EncryptedFile` shape `fetch_media` can decrypt, so the avatar is
/// handed on as its JSON.
fn is_encrypted_file(value: &Value) -> bool {
    EncryptedFileIn::deserialize(value).is_ok_and(|file| {
        file.url.is_some_and(|url| url.starts_with("mxc://"))
            && file.v.is_some()
            && file.iv.is_some()
            && file.hashes.is_some_and(|hashes| hashes.sha256.is_some())
            && file.key.is_some_and(|key| key.k.is_some())
    })
}

/// An explicit `null` clears the field; a missing or wrong-typed one is unset.
#[derive(Default, Deserialize)]
#[serde(untagged)]
enum Stored<T> {
    Cleared(()),
    Set(T),
    #[default]
    #[serde(skip)]
    Unset,
}

#[serde_as]
#[derive(Deserialize)]
struct OverrideEntryIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "displayname")]
    display_name: Stored<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "avatar_url")]
    avatar: Stored<Value>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "eu.she-a.color")]
    color: Stored<ColorIn>,
}

#[serde_as]
#[derive(Default, Deserialize)]
struct ColorIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    on_light: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default)]
    on_dark: Option<String>,
}

fn text_override(value: Stored<String>) -> OverrideTextView {
    match value {
        Stored::Set(value) if visible_name(&value).is_some() => OverrideTextView::Set { value },
        Stored::Cleared(()) | Stored::Set(_) => OverrideTextView::Cleared,
        Stored::Unset => OverrideTextView::Unset,
    }
}

fn avatar_override(value: Stored<Value>) -> OverrideTextView {
    match value {
        Stored::Set(file) if is_encrypted_file(&file) => OverrideTextView::Set {
            value: file.to_string(),
        },
        Stored::Set(Value::String(value)) => OverrideTextView::Set { value },
        Stored::Cleared(()) => OverrideTextView::Cleared,
        _ => OverrideTextView::Unset,
    }
}

fn color_override(value: Stored<ColorIn>) -> OverrideColorView {
    match value {
        Stored::Cleared(()) => OverrideColorView::Cleared,
        Stored::Set(ColorIn {
            on_light: None,
            on_dark: None,
        })
        | Stored::Unset => OverrideColorView::Unset,
        Stored::Set(ColorIn { on_light, on_dark }) => OverrideColorView::Set {
            light: on_light,
            dark: on_dark,
        },
    }
}

pub(crate) fn overrides(content: Option<&Value>) -> Vec<ProfileOverrideView> {
    content
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(user_id, entry)| {
            let user_id = OwnedUserId::try_from(user_id.as_str()).ok()?;
            let entry = OverrideEntryIn::deserialize(entry).ok()?;
            Some(ProfileOverrideView {
                user_id,
                display_name: text_override(entry.display_name),
                avatar: avatar_override(entry.avatar),
                color: color_override(entry.color),
            })
        })
        .collect()
}

#[cfg(not(target_family = "wasm"))]
pub(crate) async fn notification_name(client: &matrix_sdk::Client, sender: &str) -> Option<String> {
    let stored = stored_overrides(
        client,
        false,
        crate::sealed_account_data::cached_key(client),
    )
    .await
    .ok()?;
    let entry = overrides(stored.content.as_ref())
        .into_iter()
        .find(|entry| entry.user_id == sender)?;
    match entry.display_name {
        OverrideTextView::Set { value } => Some(value),
        OverrideTextView::Cleared => Some(sender.to_owned()),
        OverrideTextView::Unset => None,
    }
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
            entry.insert(key.to_owned(), Value::from(value.as_str()));
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
            entry.insert("avatar_url".to_owned(), Value::from(url.as_str()));
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
                serde_json::json!({ "on_light": value, "on_dark": value }),
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

/// MSC4529's stable type wins and stays plain; otherwise the unstable type
/// is read through the account data key.
async fn stored_overrides(
    client: &matrix_sdk::Client,
    fetch: bool,
    key: impl std::future::Future<Output = Option<crate::sealed_account_data::AccountDataKey>>,
) -> matrix_sdk::Result<StoredOverrides> {
    let stable =
        crate::sealed_account_data::read_account_data(client, PROFILE_OVERRIDES_EVENT, fetch)
            .await?
            .filter(Value::is_object);
    if stable.is_some() {
        return Ok(StoredOverrides {
            content: stable,
            sealed_type: false,
            protection: SealStateView::Plain,
            can_seal: false,
        });
    }
    let document = crate::sealed_account_data::read_document(
        client,
        UNSTABLE_PROFILE_OVERRIDES_EVENT,
        fetch,
        key.await,
    )
    .await?;
    Ok(StoredOverrides {
        content: document.content,
        sealed_type: true,
        protection: document.state,
        can_seal: document.can_seal,
    })
}

impl Core {
    async fn stored_overrides(&self) -> Result<StoredOverrides, RpcError> {
        use crate::ResultExt;
        let client = self.client().await?;
        let key =
            self.with_open_stores(async || crate::sealed_account_data::cached_key(&client).await);
        stored_overrides(&client, true, key)
            .await
            .or_failed(self, "profile_overrides")
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

    pub(crate) async fn profile_overrides_view(&self) -> Result<ProfileOverridesView, RpcError> {
        Ok(Self::overrides_view(&self.stored_overrides().await?))
    }

    /// A plaintext unstable document read while the key is at hand is sealed.
    pub(crate) async fn profile_overrides(&self) -> Result<ProfileOverridesView, RpcError> {
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
    ) -> Result<ProfileOverridesView, RpcError> {
        let _guard = self.account_data_lock.lock().await;
        let stored = self.stored_overrides().await?;
        if stored.protection == SealStateView::Locked {
            return Err(RpcCode::DocumentLocked.into());
        }
        let content = edited_overrides(stored.content, user_id.as_str(), edit);
        let event_type = if stored.sealed_type {
            self.set_sealed_account_data(UNSTABLE_PROFILE_OVERRIDES_EVENT, &content)
                .await?;
            UNSTABLE_PROFILE_OVERRIDES_EVENT
        } else {
            self.set_account_data(PROFILE_OVERRIDES_EVENT, &content)
                .await?;
            PROFILE_OVERRIDES_EVENT
        };
        self.emit(CoreEvent::AccountDataChanged {
            event_type: event_type.to_owned(),
        });
        Ok(Self::overrides_view(&StoredOverrides {
            content: Some(content),
            ..stored
        }))
    }
}

#[cfg(test)]
mod tests {
    use crate::api::account::AvatarEditView;
    use serde_json::json;

    use super::{OverrideEdit, edited_overrides, overrides};
    use crate::protocol::{FieldEdit, OverrideColorView, OverrideTextView};

    fn keep() -> OverrideEdit {
        OverrideEdit {
            display_name: FieldEdit::Keep,
            avatar: AvatarEditView::Keep,
            color: FieldEdit::Keep,
        }
    }

    #[test]
    fn a_wrong_typed_field_reads_as_unset() {
        let read = overrides(Some(&json!({
            "@a:example.org": {
                "displayname": 3, "avatar_url": 4, "eu.she-a.color": "red"
            },
            "@b:example.org": { "eu.she-a.color": { "on_light": 1 } },
        })));

        assert_eq!(read.len(), 2);
        for entry in &read {
            assert_eq!(entry.display_name, OverrideTextView::Unset);
            assert_eq!(entry.avatar, OverrideTextView::Unset);
            assert_eq!(entry.color, OverrideColorView::Unset);
        }
    }

    #[test]
    fn an_edit_writes_the_color_as_both_themes() {
        let edit = OverrideEdit {
            color: FieldEdit::Set {
                value: "#abcdef".to_owned(),
            },
            ..keep()
        };
        assert_eq!(
            edited_overrides(None, "@a:example.org", &edit),
            json!({ "@a:example.org": {
                "eu.she-a.color": { "on_light": "#abcdef", "on_dark": "#abcdef" }
            }})
        );
    }

    #[test]
    fn hidden_names_clear_the_override() {
        for name in ["", "   ", "\u{200b}\u{2800}\u{feff}"] {
            let content = json!({ "@a:example.org": { "displayname": name } });
            let read = overrides(Some(&content));
            assert_eq!(
                read.first().unwrap().display_name,
                OverrideTextView::Cleared
            );
        }
        let content = json!({ "@a:example.org": { "displayname": "\u{200b}Alice" } });
        assert_eq!(
            overrides(Some(&content)).first().unwrap().display_name,
            OverrideTextView::Set {
                value: "\u{200b}Alice".to_owned()
            }
        );
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
