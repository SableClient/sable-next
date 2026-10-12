use matrix_sdk::ruma::OwnedRoomId;
use serde_json::{Map, Value, json};

use crate::Core;
use crate::cosmetics::{COLOR_EVENT, MEMBER_COLOR_FIELD, MEMBER_EVENT, PRONOUNS_EVENT};
use crate::protocol::{CommandErr, FieldEdit, MemberLookView, PronounView};

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

pub(crate) fn member_look(member: Option<&Value>, pronouns: Option<&Value>) -> MemberLookView {
    let colors = member.and_then(|member| member.get(MEMBER_COLOR_FIELD));
    MemberLookView {
        display_name: text(member.and_then(|member| member.get("displayname"))),
        avatar_url: text(member.and_then(|member| member.get("avatar_url"))),
        color_on_light: text(colors.and_then(|colors| colors.get("on_light"))),
        color_on_dark: text(colors.and_then(|colors| colors.get("on_dark"))),
        pronouns: pronouns
            .and_then(|content| content.get("pronouns"))
            .and_then(Value::as_array)
            .map(|sets| {
                sets.iter()
                    .filter_map(|set| {
                        Some(PronounView {
                            summary: text(set.get("summary"))?,
                            language: text(set.get("language")),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
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
    fields.insert("membership".to_owned(), json!("join"));
    Value::Object(fields)
}

pub(crate) fn pronouns_content(pronouns: &[PronounView]) -> Value {
    let sets: Vec<Value> = pronouns
        .iter()
        .filter(|set| !set.summary.trim().is_empty())
        .map(|set| {
            let mut entry = Map::new();
            if let Some(language) = set.language.as_deref().filter(|code| !code.is_empty()) {
                entry.insert("language".to_owned(), json!(language));
            }
            entry.insert("summary".to_owned(), json!(set.summary.trim()));
            Value::Object(entry)
        })
        .collect();
    if sets.is_empty() {
        json!({})
    } else {
        json!({ "pronouns": sets })
    }
}

impl Core {
    async fn look_target(
        &self,
        room_id: OwnedRoomId,
        in_parent_space: bool,
    ) -> Result<OwnedRoomId, CommandErr> {
        if !in_parent_space {
            return Ok(room_id);
        }
        let client = self.client().await?;
        let room = self.room(&room_id).await?;
        Ok(crate::cosmetics::first_space_parent(&client, &room)
            .await
            .unwrap_or(room_id))
    }

    async fn own_user(&self) -> Result<String, CommandErr> {
        Ok(self
            .client()
            .await?
            .user_id()
            .ok_or(CommandErr::NotLoggedIn)?
            .to_string())
    }

    pub(crate) async fn member_look(
        &self,
        room_id: OwnedRoomId,
    ) -> Result<MemberLookView, CommandErr> {
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
    ) -> Result<(), CommandErr> {
        let target = self.look_target(room_id, in_parent_space).await?;
        let user_id = self.own_user().await?;
        let member = self
            .room_state_event_content(target.clone(), MEMBER_EVENT.to_owned(), user_id.clone())
            .await?;
        let content = edited_member(member, &edit);
        self.send_state(target.clone(), MEMBER_EVENT, &user_id, &content)
            .await?;
        if edit.touches_colors() {
            self.send_state(target, COLOR_EVENT, &user_id, &json!({}))
                .await?;
        }
        Ok(())
    }

    pub(crate) async fn set_pronouns(
        &self,
        room_id: OwnedRoomId,
        in_parent_space: bool,
        pronouns: &[PronounView],
    ) -> Result<(), CommandErr> {
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
            pronouns_content(&sets),
            json!({ "pronouns": [
                { "language": "en", "summary": "they/them" },
                { "summary": "iel" },
            ]})
        );
        assert_eq!(pronouns_content(&[]), json!({}));
    }
}
