use std::collections::BTreeMap;

use matrix_sdk::Room;
use matrix_sdk::ruma::OwnedRoomId;
use matrix_sdk::ruma::events::{
    AnyGlobalAccountDataEventContent, AnyMessageLikeEventContent, GlobalAccountDataEventType,
    MessageLikeEventContent,
};
use matrix_sdk::ruma::serde::Raw;
use serde_json::{Map, Value, json};

use crate::Core;
use crate::profiles::pronoun_sets;
use crate::protocol::{
    CommandErr, PerMessageProfileView, PersonaCatalogView, PersonaSelectionView,
    PersonaTriggerView, PersonaView, PluralkitImportView, PronounView,
};

const CATALOG_V3: &str = "fi.mau.msc4461.per_message_profiles.v3";
const CATALOG_V2: &str = "fi.mau.msc4461.per_message_profiles.v2";
const SELECTION_PREFIX: &str = "fyi.cisnt.permessageprofile";
const PRONOUNS: &str = "io.fsky.nyx.pronouns";
const COLORS: &str = "eu.she-a.color";
const PKIMPORT: &str = "net.f0rest.pkimport";
const TRIGGER_SUFFIX: &str = "net.f0rest.suffix";
const TRIGGER_CIRCUMFIX: &str = "net.f0rest.circumfix";

pub(crate) const PER_MESSAGE_PROFILE: &str = "com.beeper.per_message_profile";

fn selection_event(scope: &str) -> GlobalAccountDataEventType {
    GlobalAccountDataEventType::from(format!("{SELECTION_PREFIX}.{scope}"))
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn color(profile: &Value, key: &str) -> Option<String> {
    text(profile.get(COLORS).and_then(|colors| colors.get(key)))
}

fn trigger_from_json(value: &Value) -> Option<PersonaTriggerView> {
    let prefix = text(value.get("prefix"));
    let suffix = text(value.get("suffix"));
    if prefix.is_none() && suffix.is_none() {
        return None;
    }

    Some(PersonaTriggerView {
        prefix,
        suffix,
        keep_trigger: value
            .get("keep_trigger")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn triggers_from_v2(trigger: &Value) -> Vec<PersonaTriggerView> {
    let strings = |key: &str| -> Vec<String> {
        trigger
            .get(key)
            .and_then(Value::as_array)
            .map_or_else(Vec::new, |entries| {
                entries
                    .iter()
                    .filter_map(|entry| text(Some(entry)))
                    .collect()
            })
    };

    let circumfixes: Vec<PersonaTriggerView> = trigger
        .get(TRIGGER_CIRCUMFIX)
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    Some(PersonaTriggerView {
                        prefix: text(entry.get("prefix")),
                        suffix: text(entry.get("suffix")),
                        keep_trigger: false,
                    })
                    .filter(|trigger| trigger.prefix.is_some() && trigger.suffix.is_some())
                })
                .collect()
        });

    let prefixes = strings("prefix")
        .into_iter()
        .map(|prefix| PersonaTriggerView {
            prefix: Some(prefix),
            suffix: None,
            keep_trigger: false,
        });
    let suffixes = strings(TRIGGER_SUFFIX)
        .into_iter()
        .map(|suffix| PersonaTriggerView {
            prefix: None,
            suffix: Some(suffix),
            keep_trigger: false,
        });

    circumfixes
        .into_iter()
        .chain(prefixes)
        .chain(suffixes)
        .collect()
}

fn pluralkit_from_json(value: Option<&Value>) -> Option<PluralkitImportView> {
    let record = value?;
    Some(PluralkitImportView {
        id: text(record.get("id"))?,
        uuid: text(record.get("uuid")),
        avatar_url: text(record.get("avatar_url")),
        description: text(record.get("description")),
    })
}

fn persona_from_json(value: &Value) -> Option<PersonaView> {
    let id = text(value.get("id"))?;
    let display_name = value.get("displayname").and_then(Value::as_str)?.to_owned();

    let triggers = value.get("triggers").and_then(Value::as_array).map_or_else(
        || value.get("trigger").map_or_else(Vec::new, triggers_from_v2),
        |entries| entries.iter().filter_map(trigger_from_json).collect(),
    );

    Some(PersonaView {
        id,
        display_name,
        avatar_url: text(value.get("avatar_url")),
        pronouns: pronoun_sets(value.get(PRONOUNS)),
        color_on_light: color(value, "on_light"),
        color_on_dark: color(value, "on_dark"),
        triggers,
        pluralkit: pluralkit_from_json(value.get(PKIMPORT)),
    })
}

fn personas_from_catalog(content: &Value) -> Vec<PersonaView> {
    let profiles = content.get("profiles").or_else(|| {
        content
            .get("content")
            .and_then(|inner| inner.get("profiles"))
    });

    profiles
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |entries| {
            entries.iter().filter_map(persona_from_json).collect()
        })
}

fn pronouns_to_json(pronouns: &[PronounView]) -> Value {
    Value::Array(
        pronouns
            .iter()
            .map(|pronoun| {
                let mut set = Map::new();
                set.insert("summary".to_owned(), pronoun.summary.clone().into());
                if let Some(language) = &pronoun.language {
                    set.insert("language".to_owned(), language.clone().into());
                }
                Value::Object(set)
            })
            .collect(),
    )
}

fn colors_to_json(on_light: Option<&String>, on_dark: Option<&String>) -> Option<Value> {
    if on_light.is_none() && on_dark.is_none() {
        return None;
    }

    let mut colors = Map::new();
    if let Some(value) = on_light {
        colors.insert("on_light".to_owned(), value.clone().into());
    }
    if let Some(value) = on_dark {
        colors.insert("on_dark".to_owned(), value.clone().into());
    }
    Some(Value::Object(colors))
}

fn persona_to_json(persona: &PersonaView) -> Value {
    let mut object = Map::new();
    object.insert("id".to_owned(), persona.id.clone().into());
    object.insert(
        "displayname".to_owned(),
        persona.display_name.clone().into(),
    );

    if let Some(avatar_url) = &persona.avatar_url {
        object.insert("avatar_url".to_owned(), avatar_url.clone().into());
    }
    if !persona.pronouns.is_empty() {
        object.insert(PRONOUNS.to_owned(), pronouns_to_json(&persona.pronouns));
    }
    if let Some(colors) = colors_to_json(
        persona.color_on_light.as_ref(),
        persona.color_on_dark.as_ref(),
    ) {
        object.insert(COLORS.to_owned(), colors);
    }
    if let Some(pluralkit) = &persona.pluralkit {
        let mut record = Map::new();
        record.insert("id".to_owned(), pluralkit.id.clone().into());
        if let Some(uuid) = &pluralkit.uuid {
            record.insert("uuid".to_owned(), uuid.clone().into());
        }
        if let Some(avatar_url) = &pluralkit.avatar_url {
            record.insert("avatar_url".to_owned(), avatar_url.clone().into());
        }
        if let Some(description) = &pluralkit.description {
            record.insert("description".to_owned(), description.clone().into());
        }
        object.insert(PKIMPORT.to_owned(), Value::Object(record));
    }

    object.insert(
        "triggers".to_owned(),
        Value::Array(
            persona
                .triggers
                .iter()
                .map(|trigger| {
                    let mut entry = Map::new();
                    if let Some(prefix) = &trigger.prefix {
                        entry.insert("prefix".to_owned(), prefix.clone().into());
                    }
                    if let Some(suffix) = &trigger.suffix {
                        entry.insert("suffix".to_owned(), suffix.clone().into());
                    }
                    if trigger.keep_trigger {
                        entry.insert("keep_trigger".to_owned(), true.into());
                    }
                    Value::Object(entry)
                })
                .collect(),
        ),
    );

    Value::Object(object)
}

fn selection_from_json(value: &Value) -> Option<PersonaSelectionView> {
    Some(PersonaSelectionView {
        persona_id: text(value.get("profileId"))?,
        valid_until: value.get("validUntil").and_then(Value::as_u64),
    })
}

fn selection_to_json(selection: &PersonaSelectionView) -> Value {
    let mut object = Map::new();
    object.insert("profileId".to_owned(), selection.persona_id.clone().into());
    if let Some(valid_until) = selection.valid_until {
        object.insert("validUntil".to_owned(), valid_until.into());
    }
    Value::Object(object)
}

fn profile_to_json(profile: &PerMessageProfileView) -> Value {
    let mut object = Map::new();
    if let Some(id) = &profile.id {
        object.insert("id".to_owned(), id.clone().into());
    }
    if let Some(display_name) = profile
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        object.insert("displayname".to_owned(), display_name.into());
    }
    if let Some(avatar_url) = &profile.avatar_url {
        object.insert("avatar_url".to_owned(), avatar_url.clone().into());
    }
    if !profile.pronouns.is_empty() {
        object.insert(PRONOUNS.to_owned(), pronouns_to_json(&profile.pronouns));
    }
    if let Some(colors) = colors_to_json(
        profile.color_on_light.as_ref(),
        profile.color_on_dark.as_ref(),
    ) {
        object.insert(COLORS.to_owned(), colors);
    }
    if profile.has_fallback {
        object.insert("has_fallback".to_owned(), true.into());
    }
    Value::Object(object)
}

pub(crate) fn stamp_profile(content: &mut Value, profile: &PerMessageProfileView) {
    let Some(object) = content.as_object_mut() else {
        return;
    };

    object.insert(PER_MESSAGE_PROFILE.to_owned(), profile_to_json(profile));

    let Some(name) = profile
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    else {
        return;
    };
    if !profile.has_fallback {
        return;
    }

    let plain_prefix = format!("{name}: ");
    let html_prefix = format!(
        "<strong data-mx-profile-fallback>{}: </strong>",
        html_escape::encode_text(name)
    );

    let raw_body = object
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let raw_formatted = object
        .get("formatted_body")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    let (marker, body) = split_edit_marker(&raw_body);
    let (_, formatted) = raw_formatted.as_deref().map_or((marker, None), |html| {
        let (marker, rest) = split_edit_marker(html);
        (marker, Some(rest.to_owned()))
    });

    let stripped = body.strip_prefix(&plain_prefix).unwrap_or(body);

    let formatted = match formatted {
        Some(html) if html.starts_with(&html_prefix) => html,
        Some(html) => format!("{html_prefix}{html}"),
        None => format!(
            "{html_prefix}{}",
            html_escape::encode_text(stripped).replace('\n', "<br/>")
        ),
    };

    object.insert("format".to_owned(), "org.matrix.custom.html".into());
    object.insert(
        "formatted_body".to_owned(),
        format!("{marker}{formatted}").into(),
    );
    if !body.starts_with(&plain_prefix) {
        object.insert(
            "body".to_owned(),
            format!("{marker}{plain_prefix}{body}").into(),
        );
    }
}

const EDIT_MARKER: &str = "* ";

fn split_edit_marker(value: &str) -> (&str, &str) {
    value
        .strip_prefix(EDIT_MARKER)
        .map_or(("", value), |rest| (EDIT_MARKER, rest))
}

impl Core {
    pub(crate) async fn send_with_persona(
        &self,
        room: &Room,
        content: &AnyMessageLikeEventContent,
        profile: &PerMessageProfileView,
    ) -> Result<(), CommandErr> {
        let event_type = content.event_type().to_string();
        let mut value = serde_json::to_value(content)
            .map_err(|error| self.failed("send_with_persona", error))?;

        stamp_profile(&mut value, profile);
        if let Some(new_content) = value.get_mut("m.new_content") {
            stamp_profile(new_content, profile);
        }

        let raw = Raw::<AnyMessageLikeEventContent>::from_json_string(value.to_string())
            .map_err(|error| self.failed("send_with_persona", error))?;

        room.send_queue()
            .send_raw(raw, event_type)
            .await
            .map_err(|error| self.failed("send_with_persona", error))?;

        Ok(())
    }

    async fn persona_account_data(
        &self,
        event_type: GlobalAccountDataEventType,
    ) -> Result<Option<Value>, CommandErr> {
        let Some(raw) = self
            .client()
            .await?
            .account()
            .fetch_account_data(event_type)
            .await
            .map_err(|error| self.failed("personas: fetch_account_data", error))?
        else {
            return Ok(None);
        };

        raw.deserialize_as::<Value>()
            .map(Some)
            .map_err(|error| self.failed("personas: deserialize", error))
    }

    async fn put_persona_account_data(
        &self,
        event_type: GlobalAccountDataEventType,
        content: Value,
    ) -> Result<(), CommandErr> {
        let raw = Raw::<AnyGlobalAccountDataEventContent>::from_json_string(content.to_string())
            .map_err(|error| self.failed("personas", error))?;

        self.client()
            .await?
            .account()
            .set_account_data_raw(event_type, raw)
            .await
            .map_err(|error| self.failed("personas", error))?;

        Ok(())
    }

    async fn load_personas(&self) -> Result<Vec<PersonaView>, CommandErr> {
        if let Some(content) = self
            .persona_account_data(GlobalAccountDataEventType::from(CATALOG_V3))
            .await?
            && content.get("profiles").is_some()
        {
            return Ok(personas_from_catalog(&content));
        }

        let Some(content) = self
            .persona_account_data(GlobalAccountDataEventType::from(CATALOG_V2))
            .await?
        else {
            return Ok(Vec::new());
        };

        let personas = personas_from_catalog(&content);
        if personas.is_empty() {
            return Ok(personas);
        }

        self.save_personas(&personas).await?;
        Ok(personas)
    }

    async fn save_personas(&self, personas: &[PersonaView]) -> Result<(), CommandErr> {
        self.put_persona_account_data(
            GlobalAccountDataEventType::from(CATALOG_V3),
            json!({ "profiles": personas.iter().map(persona_to_json).collect::<Vec<_>>() }),
        )
        .await
    }

    async fn account_selection(&self) -> Result<Option<PersonaSelectionView>, CommandErr> {
        Ok(self
            .persona_account_data(selection_event("globalassociation"))
            .await?
            .as_ref()
            .and_then(|content| content.get("association"))
            .and_then(selection_from_json))
    }

    async fn room_selections(&self) -> Result<BTreeMap<String, PersonaSelectionView>, CommandErr> {
        let Some(content) = self
            .persona_account_data(selection_event("roomassociation"))
            .await?
        else {
            return Ok(BTreeMap::new());
        };

        Ok(content
            .get("associations")
            .and_then(Value::as_object)
            .map(|associations| {
                associations
                    .iter()
                    .filter_map(|(room_id, association)| {
                        Some((room_id.clone(), selection_from_json(association)?))
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    pub(crate) async fn personas(&self) -> Result<PersonaCatalogView, CommandErr> {
        Ok(PersonaCatalogView {
            personas: self.load_personas().await?,
            account: self.account_selection().await?,
            rooms: self.room_selections().await?,
        })
    }

    pub(crate) async fn save_persona(
        &self,
        persona: PersonaView,
        previous_id: Option<String>,
    ) -> Result<Vec<PersonaView>, CommandErr> {
        let _guard = self.account_data_lock.lock().await;
        let replaced = previous_id.unwrap_or_else(|| persona.id.clone());
        let mut personas = self.load_personas().await?;

        personas.retain(|existing| existing.id != persona.id || existing.id == replaced);
        match personas.iter_mut().find(|existing| existing.id == replaced) {
            Some(existing) => *existing = persona.clone(),
            None => personas.push(persona.clone()),
        }

        self.save_personas(&personas).await?;
        if replaced != persona.id {
            self.repoint_selections(&replaced, Some(&persona.id))
                .await?;
        }

        Ok(personas)
    }

    pub(crate) async fn remove_persona(&self, id: &str) -> Result<Vec<PersonaView>, CommandErr> {
        let _guard = self.account_data_lock.lock().await;
        let mut personas = self.load_personas().await?;
        personas.retain(|persona| persona.id != id);

        self.save_personas(&personas).await?;
        self.repoint_selections(id, None).await?;

        Ok(personas)
    }

    async fn repoint_selections(&self, from: &str, to: Option<&str>) -> Result<(), CommandErr> {
        if let Some(account) = self.account_selection().await?
            && account.persona_id == from
        {
            let content = to.map_or_else(
                || json!({}),
                |id| {
                    json!({ "association": selection_to_json(&PersonaSelectionView {
                        persona_id: id.to_owned(),
                        valid_until: account.valid_until,
                    }) })
                },
            );
            self.put_persona_account_data(selection_event("globalassociation"), content)
                .await?;
        }

        let mut rooms = self.room_selections().await?;
        let affected: Vec<String> = rooms
            .iter()
            .filter(|(_, selection)| selection.persona_id == from)
            .map(|(room_id, _)| room_id.clone())
            .collect();
        if affected.is_empty() {
            return Ok(());
        }

        for room_id in affected {
            match to {
                Some(id) => {
                    if let Some(selection) = rooms.get_mut(&room_id) {
                        id.clone_into(&mut selection.persona_id);
                    }
                }
                None => {
                    rooms.remove(&room_id);
                }
            }
        }

        self.write_room_selections(&rooms).await
    }

    async fn write_room_selections(
        &self,
        rooms: &BTreeMap<String, PersonaSelectionView>,
    ) -> Result<(), CommandErr> {
        let associations: Map<String, Value> = rooms
            .iter()
            .map(|(room_id, selection)| (room_id.clone(), selection_to_json(selection)))
            .collect();

        self.put_persona_account_data(
            selection_event("roomassociation"),
            json!({ "associations": Value::Object(associations) }),
        )
        .await
    }

    pub(crate) async fn set_persona_selection(
        &self,
        room_id: Option<OwnedRoomId>,
        persona_id: Option<String>,
        valid_until: Option<u64>,
    ) -> Result<(), CommandErr> {
        let _guard = self.account_data_lock.lock().await;
        let selection = persona_id.map(|persona_id| PersonaSelectionView {
            persona_id,
            valid_until,
        });

        let Some(room_id) = room_id else {
            let content = selection.as_ref().map_or_else(
                || json!({}),
                |selection| json!({ "association": selection_to_json(selection) }),
            );
            return self
                .put_persona_account_data(selection_event("globalassociation"), content)
                .await;
        };

        let mut rooms = self.room_selections().await?;
        match selection {
            Some(selection) => {
                rooms.insert(room_id.to_string(), selection);
            }
            None => {
                rooms.remove(room_id.as_str());
            }
        }

        self.write_room_selections(&rooms).await
    }
}

#[cfg(test)]
mod tests {
    use super::{persona_from_json, personas_from_catalog, stamp_profile};
    use crate::protocol::{PerMessageProfileView, PronounView};
    use serde_json::json;

    fn profile(display_name: &str, has_fallback: bool) -> PerMessageProfileView {
        PerMessageProfileView {
            id: Some("kris".to_owned()),
            display_name: Some(display_name.to_owned()),
            avatar_url: None,
            pronouns: Vec::new(),
            color_on_light: None,
            color_on_dark: None,
            has_fallback,
        }
    }

    #[test]
    fn reads_a_v3_persona_with_its_triggers() {
        let persona = persona_from_json(&json!({
            "id": "kris",
            "displayname": "Kris",
            "avatar_url": "mxc://example.org/kris",
            "io.fsky.nyx.pronouns": [{ "summary": "they/them", "language": "EN" }],
            "eu.she-a.color": { "on_light": "#333", "on_dark": "#eee" },
            "triggers": [
                { "prefix": "k:" },
                { "suffix": "-k", "keep_trigger": true },
                { "prefix": "", "suffix": "" }
            ],
        }))
        .expect("a persona");

        assert_eq!(persona.display_name, "Kris");
        assert_eq!(
            persona.pronouns,
            vec![PronounView {
                summary: "they/them".to_owned(),
                language: Some("en".to_owned()),
            }]
        );
        assert_eq!(persona.color_on_dark.as_deref(), Some("#eee"));
        assert_eq!(persona.triggers.len(), 2);
        assert!(persona.triggers[1].keep_trigger);
    }

    #[test]
    fn converts_a_v2_trigger_object_circumfixes_first() {
        let persona = persona_from_json(&json!({
            "id": "kris",
            "displayname": "Kris",
            "trigger": {
                "prefix": ["k:"],
                "net.f0rest.suffix": ["-k"],
                "net.f0rest.circumfix": [{ "prefix": "[", "suffix": "]" }],
            },
        }))
        .expect("a persona");

        let shapes: Vec<_> = persona
            .triggers
            .iter()
            .map(|trigger| (trigger.prefix.as_deref(), trigger.suffix.as_deref()))
            .collect();
        assert_eq!(
            shapes,
            vec![
                (Some("["), Some("]")),
                (Some("k:"), None),
                (None, Some("-k")),
            ]
        );
    }

    #[test]
    fn reads_the_catalog_through_v1s_nested_wrapper() {
        let nested = json!({
            "type": "m.per_message_profiles",
            "content": { "profiles": [{ "id": "kris", "displayname": "Kris" }] },
        });
        assert_eq!(personas_from_catalog(&nested).len(), 1);
    }

    #[test]
    fn the_fallback_prefixes_both_bodies_once() {
        let mut content = json!({ "msgtype": "m.text", "body": "hello" });
        stamp_profile(&mut content, &profile("Kris", true));

        assert_eq!(content["body"], "Kris: hello");
        assert_eq!(content["format"], "org.matrix.custom.html");
        assert_eq!(
            content["formatted_body"],
            "<strong data-mx-profile-fallback>Kris: </strong>hello"
        );

        stamp_profile(&mut content, &profile("Kris", true));
        assert_eq!(content["body"], "Kris: hello");
        assert_eq!(
            content["formatted_body"],
            "<strong data-mx-profile-fallback>Kris: </strong>hello"
        );
    }

    #[test]
    fn a_name_with_markup_is_escaped_in_the_fallback() {
        let mut content = json!({ "msgtype": "m.text", "body": "hi" });
        stamp_profile(&mut content, &profile("<b>Kris</b>", true));

        assert_eq!(
            content["formatted_body"],
            "<strong data-mx-profile-fallback>&lt;b&gt;Kris&lt;/b&gt;: </strong>hi"
        );
    }

    #[test]
    fn without_a_fallback_only_the_profile_is_attached() {
        let mut content = json!({ "msgtype": "m.text", "body": "hello" });
        stamp_profile(&mut content, &profile("Kris", false));

        assert_eq!(content["body"], "hello");
        assert!(content.get("formatted_body").is_none());
        assert_eq!(
            content["com.beeper.per_message_profile"]["displayname"],
            "Kris"
        );
        assert!(
            content["com.beeper.per_message_profile"]
                .get("has_fallback")
                .is_none()
        );
    }
}
