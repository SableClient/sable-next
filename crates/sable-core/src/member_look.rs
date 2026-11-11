use crate::api::members::LookParams;
use matrix_sdk::ruma::OwnedRoomId;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use serde_with::{DefaultOnError, NoneAsEmptyString, VecSkipError, serde_as};

use crate::Core;
use crate::cosmetics::{COLOR_EVENT, MEMBER_COLOR_FIELD, MEMBER_EVENT, PRONOUNS_EVENT};
use crate::protocol::{FieldEdit, MemberLookView, PronounView, RpcCode, RpcError};
use crate::room_settings::EmptyContent;

pub(crate) struct LookEdit {
    pub(crate) display_name: FieldEdit,
    pub(crate) avatar_url: FieldEdit,
    pub(crate) color_on_light: FieldEdit,
    pub(crate) color_on_dark: FieldEdit,
}

impl LookEdit {
    fn touches_colors(&self) -> bool {
        self.color_on_light != FieldEdit::Keep || self.color_on_dark != FieldEdit::Keep
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn object(value: Option<Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn apply(fields: &mut Map<String, Value>, key: &str, edit: &FieldEdit) {
    match edit {
        FieldEdit::Keep => {}
        FieldEdit::Set { value } if !value.is_empty() => {
            fields.insert(key.to_owned(), Value::String(value.clone()));
        }
        FieldEdit::Clear | FieldEdit::Set { .. } => {
            fields.remove(key);
        }
    }
}

#[serde_as]
#[derive(Default, Deserialize)]
struct MemberIn {
    #[serde_as(deserialize_as = "DefaultOnError<NoneAsEmptyString>")]
    #[serde(default, rename = "displayname")]
    display_name: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError<NoneAsEmptyString>")]
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(default, rename = "eu.she-a.color")]
    colors: Option<ColorsIn>,
}

#[serde_as]
#[derive(Deserialize)]
struct ColorsIn {
    #[serde_as(deserialize_as = "DefaultOnError<NoneAsEmptyString>")]
    #[serde(default)]
    on_light: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError<NoneAsEmptyString>")]
    #[serde(default)]
    on_dark: Option<String>,
}

#[serde_as]
#[derive(Default, Deserialize)]
struct PronounsIn {
    #[serde_as(deserialize_as = "DefaultOnError<VecSkipError<_>>")]
    #[serde(default)]
    pronouns: Vec<PronounSetIn>,
}

#[serde_as]
#[derive(Deserialize)]
struct PronounSetIn {
    #[serde_as(deserialize_as = "DefaultOnError<NoneAsEmptyString>")]
    #[serde(default)]
    summary: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError<NoneAsEmptyString>")]
    #[serde(default)]
    language: Option<String>,
}

pub(crate) fn member_look(member: Option<&Value>, pronouns: Option<&Value>) -> MemberLookView {
    let read =
        |content: Option<&Value>| content.and_then(|content| MemberIn::deserialize(content).ok());
    let member = read(member).unwrap_or_default();
    let colors = member.colors;
    let pronouns = pronouns
        .and_then(|content| PronounsIn::deserialize(content).ok())
        .unwrap_or_default();
    MemberLookView {
        display_name: member.display_name,
        avatar_url: member.avatar_url,
        color_on_light: colors.as_ref().and_then(|colors| colors.on_light.clone()),
        color_on_dark: colors.and_then(|colors| colors.on_dark),
        pronouns: pronouns
            .pronouns
            .into_iter()
            .filter_map(|set| {
                Some(PronounView {
                    summary: set.summary?,
                    language: set.language,
                })
            })
            .collect(),
    }
}

pub(crate) fn edited_member(member: Option<Value>, edit: &LookEdit) -> Value {
    let mut fields = object(member);
    apply(&mut fields, "displayname", &edit.display_name);
    apply(&mut fields, "avatar_url", &edit.avatar_url);
    if edit.touches_colors() {
        let mut colors = object(fields.remove(MEMBER_COLOR_FIELD));
        apply(&mut colors, "on_light", &edit.color_on_light);
        apply(&mut colors, "on_dark", &edit.color_on_dark);
        if colors.values().any(|color| text(Some(color)).is_some()) {
            fields.insert(MEMBER_COLOR_FIELD.to_owned(), Value::Object(colors));
        }
    }
    fields.insert("membership".to_owned(), Value::from("join"));
    Value::Object(fields)
}

#[derive(Serialize)]
struct PronounSetOut {
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    summary: String,
}

#[derive(Serialize)]
pub(crate) struct PronounsOut {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pronouns: Vec<PronounSetOut>,
}

/// No sets serializes as `{}`, which clears the event.
pub(crate) fn pronouns_content(pronouns: &[PronounView]) -> PronounsOut {
    let pronouns: Vec<_> = pronouns
        .iter()
        .filter(|set| !set.summary.trim().is_empty())
        .map(|set| PronounSetOut {
            language: set.language.clone().filter(|code| !code.is_empty()),
            summary: set.summary.trim().to_owned(),
        })
        .collect();
    PronounsOut { pronouns }
}

impl Core {
    async fn look_target(
        &self,
        room_id: OwnedRoomId,
        in_parent_space: bool,
    ) -> Result<OwnedRoomId, RpcError> {
        if !in_parent_space {
            return Ok(room_id);
        }
        let client = self.client().await?;
        let room = self.room(&room_id).await?;
        Ok(crate::cosmetics::first_space_parent(self, &client, &room)
            .await
            .unwrap_or(room_id))
    }

    async fn own_user(&self) -> Result<String, RpcError> {
        Ok(self
            .client()
            .await?
            .user_id()
            .ok_or(RpcCode::NotLoggedIn)?
            .to_string())
    }

    pub(crate) async fn member_look(
        &self,
        LookParams { room_id }: LookParams,
    ) -> Result<MemberLookView, RpcError> {
        let user_id = self.own_user().await?;
        let member = self
            .room_state_event_content(room_id.clone(), MEMBER_EVENT.to_owned(), user_id.clone())
            .await?;
        let pronouns = self
            .room_state_event_content(room_id, PRONOUNS_EVENT.to_owned(), user_id)
            .await?;
        Ok(member_look(member.as_ref(), pronouns.as_ref()))
    }

    pub(crate) async fn set_member_look(
        &self,
        room_id: OwnedRoomId,
        in_parent_space: bool,
        edit: LookEdit,
    ) -> Result<(), RpcError> {
        let target = self.look_target(room_id, in_parent_space).await?;
        let user_id = self.own_user().await?;
        let member = self
            .room_state_event_content(target.clone(), MEMBER_EVENT.to_owned(), user_id.clone())
            .await?;
        let content = edited_member(member, &edit);
        self.send_state(target.clone(), MEMBER_EVENT, &user_id, &content)
            .await?;
        if edit.touches_colors() {
            self.send_state(target, COLOR_EVENT, &user_id, &EmptyContent {})
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn set_pronouns(
        &self,
        room_id: OwnedRoomId,
        in_parent_space: bool,
        pronouns: &[PronounView],
    ) -> Result<(), RpcError> {
        let target = self.look_target(room_id, in_parent_space).await?;
        let user_id = self.own_user().await?;
        self.send_state(
            target,
            PRONOUNS_EVENT,
            &user_id,
            &pronouns_content(pronouns),
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{LookEdit, edited_member, member_look, pronouns_content};
    use crate::protocol::{FieldEdit, MemberLookView, PronounView};

    fn set(value: &str) -> FieldEdit {
        FieldEdit::Set {
            value: value.to_owned(),
        }
    }

    fn keep_all() -> LookEdit {
        LookEdit {
            display_name: FieldEdit::Keep,
            avatar_url: FieldEdit::Keep,
            color_on_light: FieldEdit::Keep,
            color_on_dark: FieldEdit::Keep,
        }
    }

    #[test]
    fn reads_the_member_and_pronoun_events() {
        let member = json!({
            "membership": "join",
            "displayname": "Ana",
            "avatar_url": "",
            "eu.she-a.color": { "on_light": "#112233", "on_dark": "" },
        });
        let pronouns = json!({ "pronouns": [
            { "language": "en", "summary": "she/her" },
            { "summary": "" },
            { "summary": "elle" },
        ]});

        assert_eq!(
            member_look(Some(&member), Some(&pronouns)),
            MemberLookView {
                display_name: Some("Ana".to_owned()),
                avatar_url: None,
                color_on_light: Some("#112233".to_owned()),
                color_on_dark: None,
                pronouns: vec![
                    PronounView {
                        summary: "she/her".to_owned(),
                        language: Some("en".to_owned()),
                    },
                    PronounView {
                        summary: "elle".to_owned(),
                        language: None,
                    },
                ],
            }
        );
        assert_eq!(member_look(None, None), MemberLookView::default());
    }

    #[test]
    fn wrong_typed_member_fields_read_as_missing() {
        let member = json!({ "displayname": 1, "avatar_url": "", "eu.she-a.color": "red" });
        let pronouns =
            json!({ "pronouns": [{ "summary": 2 }, "x", { "summary": "she/her", "language": 3 }] });
        let look = member_look(Some(&member), Some(&pronouns));
        assert_eq!(look.display_name, None);
        assert_eq!(look.avatar_url, None);
        assert_eq!(look.color_on_light, None);
        assert_eq!(look.pronouns.len(), 1);
        assert_eq!(look.pronouns[0].language, None);
        assert_eq!(
            member_look(None, Some(&json!({ "pronouns": "x" }))).pronouns,
            []
        );
    }

    #[test]
    fn keeps_unrelated_member_fields_and_forces_join() {
        let member = json!({ "membership": "leave", "displayname": "Ana", "reason": "x" });
        let edit = LookEdit {
            avatar_url: set("mxc://a/b"),
            ..keep_all()
        };

        assert_eq!(
            edited_member(Some(member), &edit),
            json!({
                "membership": "join",
                "displayname": "Ana",
                "avatar_url": "mxc://a/b",
                "reason": "x",
            })
        );
    }

    #[test]
    fn an_empty_value_removes_the_field() {
        let member = json!({ "displayname": "Ana", "avatar_url": "mxc://a/b" });
        let edit = LookEdit {
            display_name: set(""),
            avatar_url: FieldEdit::Clear,
            ..keep_all()
        };

        assert_eq!(
            edited_member(Some(member), &edit),
            json!({ "membership": "join" })
        );
    }

    #[test]
    fn a_colour_edit_merges_with_the_other_theme() {
        let member = json!({ "eu.she-a.color": { "on_light": "#111111", "on_dark": "#222222" } });
        let edit = LookEdit {
            color_on_dark: set("#333333"),
            ..keep_all()
        };

        assert_eq!(
            edited_member(Some(member), &edit),
            json!({
                "membership": "join",
                "eu.she-a.color": { "on_light": "#111111", "on_dark": "#333333" },
            })
        );
    }

    #[test]
    fn clearing_every_colour_drops_the_field() {
        let member = json!({ "eu.she-a.color": { "on_light": "#111111" } });
        let edit = LookEdit {
            color_on_light: FieldEdit::Clear,
            color_on_dark: FieldEdit::Clear,
            ..keep_all()
        };

        assert_eq!(
            edited_member(Some(member), &edit),
            json!({ "membership": "join" })
        );
    }

    #[test]
    fn untouched_colours_are_left_as_they_were() {
        let member = json!({ "eu.she-a.color": { "on_light": "" } });

        assert_eq!(
            edited_member(Some(member), &keep_all()),
            json!({ "membership": "join", "eu.she-a.color": { "on_light": "" } })
        );
    }

    #[test]
    fn pronouns_drop_blank_sets_and_an_empty_list_clears() {
        let sets = [
            PronounView {
                summary: " they/them ".to_owned(),
                language: Some("en".to_owned()),
            },
            PronounView {
                summary: "iel".to_owned(),
                language: None,
            },
            PronounView {
                summary: " ".to_owned(),
                language: None,
            },
        ];

        assert_eq!(
            serde_json::to_value(pronouns_content(&sets)).unwrap(),
            json!({ "pronouns": [
                { "language": "en", "summary": "they/them" },
                { "summary": "iel" },
            ]})
        );
        assert_eq!(
            serde_json::to_value(pronouns_content(&[])).unwrap(),
            json!({})
        );
    }
}
