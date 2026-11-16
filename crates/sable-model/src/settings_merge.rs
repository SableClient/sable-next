//! Three-way merge of the synced settings document: a value changed on this
//! device wins, otherwise the account's copy does.

use serde_json::{Map, Value};

fn section<'a>(document: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    document.get(key).and_then(Value::as_object)
}

fn pick<'a>(
    base: Option<&Value>,
    local: Option<&'a Value>,
    remote: Option<&'a Value>,
) -> Option<&'a Value> {
    if local == base { remote } else { local }
}

fn by_id(entries: Option<&Value>) -> Map<String, Value> {
    let mut found = Map::new();
    for entry in entries.and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = entry.get("id").and_then(Value::as_str) {
            found.insert(id.to_owned(), entry.clone());
        }
    }
    found
}

fn merge_entries(
    base: Option<&Value>,
    local: Option<&Value>,
    remote: Option<&Value>,
) -> Vec<Value> {
    let (before, mine, theirs) = (by_id(base), by_id(local), by_id(remote));
    theirs
        .keys()
        .chain(mine.keys().filter(|id| !theirs.contains_key(*id)))
        .filter_map(|id| pick(before.get(id), mine.get(id), theirs.get(id)).cloned())
        .collect()
}

fn ids(value: Option<&Value>) -> Vec<&str> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn merge_ids<'a>(
    base: Option<&Value>,
    local: Option<&'a Value>,
    remote: Option<&'a Value>,
) -> Vec<&'a str> {
    let (before, mine, theirs) = (ids(base), ids(local), ids(remote));
    let mut all: Vec<&str> = Vec::new();
    for id in theirs.iter().chain(&mine) {
        if !all.contains(id) {
            all.push(id);
        }
    }
    all.retain(|id| {
        let held = mine.contains(id);
        if held == before.contains(id) {
            theirs.contains(id)
        } else {
            held
        }
    });
    all
}

/// `None` when either side is not a version `version` document or the schemas differ.
#[must_use]
pub fn merge_settings(base: &Value, local: &Value, remote: &Value, version: u64) -> Option<Value> {
    let (before, mine, theirs) = (base.as_object()?, local.as_object()?, remote.as_object()?);
    let current =
        |document: &Map<String, Value>| document.get("v").and_then(Value::as_u64) == Some(version);
    if !current(mine) || !current(theirs) || mine.get("schema") != theirs.get("schema") {
        return None;
    }

    let empty = Map::new();
    let before_settings = section(before, "settings").unwrap_or(&empty);
    let mine_settings = section(mine, "settings")?;
    let their_settings = section(theirs, "settings")?;
    let before_themes = section(before, "themes").unwrap_or(&empty);
    let mine_themes = section(mine, "themes")?;
    let their_themes = section(theirs, "themes")?;

    let mut settings = Map::new();
    let keys = their_settings.keys().chain(
        mine_settings
            .keys()
            .filter(|key| !their_settings.contains_key(*key)),
    );
    for key in keys {
        let value = pick(
            before_settings.get(key),
            mine_settings.get(key),
            their_settings.get(key),
        );
        if let Some(value) = value {
            settings.insert(key.clone(), value.clone());
        }
    }

    let merged = |key: &str| {
        merge_entries(
            before_themes.get(key),
            mine_themes.get(key),
            their_themes.get(key),
        )
    };
    let themes = merged("themes");
    let tweaks = merged("tweaks");
    let held = |entries: &[Value], id: &str| {
        entries
            .iter()
            .any(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
    };
    let selected = |key: &str| {
        pick(
            before_themes.get(key),
            mine_themes.get(key),
            their_themes.get(key),
        )
        .and_then(Value::as_str)
        .filter(|id| held(&themes, id))
        .map_or(Value::Null, |id| Value::String(id.to_owned()))
    };
    let enabled: Vec<Value> = merge_ids(
        before_themes.get("enabledTweakIds"),
        mine_themes.get("enabledTweakIds"),
        their_themes.get("enabledTweakIds"),
    )
    .into_iter()
    .filter(|id| held(&tweaks, id))
    .map(|id| Value::String(id.to_owned()))
    .collect();

    let light = selected("lightThemeId");
    let dark = selected("darkThemeId");
    let mut themes_section = Map::new();
    themes_section.insert("themes".into(), Value::Array(themes));
    themes_section.insert("tweaks".into(), Value::Array(tweaks));
    themes_section.insert("lightThemeId".into(), light);
    themes_section.insert("darkThemeId".into(), dark);
    themes_section.insert("enabledTweakIds".into(), Value::Array(enabled));

    let mut document = theirs.clone();
    document.insert("settings".into(), Value::Object(settings));
    document.insert("themes".into(), Value::Object(themes_section));
    Some(Value::Object(document))
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::merge_settings;

    fn document(themes: &Value, settings: &Value) -> Value {
        let mut section = json!({
            "themes": [],
            "tweaks": [],
            "lightThemeId": null,
            "darkThemeId": null,
            "enabledTweakIds": [],
        });
        for (key, value) in themes.as_object().unwrap() {
            section[key] = value.clone();
        }
        json!({ "v": 1, "schema": 4, "settings": settings, "themes": section })
    }

    fn tweak(id: &str, css: &str) -> Value {
        json!({ "id": id, "name": id, "css": css })
    }

    fn ids(merged: &Value, key: &str) -> Vec<String> {
        merged["themes"][key]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                entry
                    .get("id")
                    .unwrap_or(entry)
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect()
    }

    #[test]
    fn keeps_a_tweak_added_on_each_device() {
        let origin = document(&json!({ "tweaks": [tweak("shared", "a{}")] }), &json!({}));
        let mine = document(
            &json!({ "tweaks": [tweak("shared", "a{}"), tweak("mine", "b{}")] }),
            &json!({}),
        );
        let theirs = document(
            &json!({ "tweaks": [tweak("shared", "a{}"), tweak("theirs", "c{}")] }),
            &json!({}),
        );

        let merged = merge_settings(&origin, &mine, &theirs, 1).unwrap();

        assert_eq!(ids(&merged, "tweaks"), ["shared", "theirs", "mine"]);
    }

    #[test]
    fn applies_a_removal_on_one_device_and_an_edit_on_the_other() {
        let origin = document(
            &json!({ "tweaks": [tweak("gone", "a{}"), tweak("kept", "b{}")] }),
            &json!({}),
        );
        let mine = document(&json!({ "tweaks": [tweak("kept", "b{}")] }), &json!({}));
        let theirs = document(
            &json!({ "tweaks": [tweak("gone", "a{}"), tweak("kept", "c{}")] }),
            &json!({}),
        );

        let merged = merge_settings(&origin, &mine, &theirs, 1).unwrap();

        assert_eq!(merged["themes"]["tweaks"], json!([tweak("kept", "c{}")]));
    }

    #[test]
    fn merges_enabled_tweaks_and_drops_ones_that_no_longer_exist() {
        let all = json!([tweak("a", "a{}"), tweak("b", "b{}"), tweak("c", "c{}")]);
        let two = json!([tweak("a", "a{}"), tweak("b", "b{}")]);
        let origin = document(
            &json!({ "tweaks": all, "enabledTweakIds": ["a"] }),
            &json!({}),
        );
        let mine = document(
            &json!({ "tweaks": all, "enabledTweakIds": ["a", "b"] }),
            &json!({}),
        );
        let theirs = document(
            &json!({ "tweaks": two, "enabledTweakIds": ["a", "c"] }),
            &json!({}),
        );

        let merged = merge_settings(&origin, &mine, &theirs, 1).unwrap();

        assert_eq!(ids(&merged, "enabledTweakIds"), ["a", "b"]);
    }

    #[test]
    fn prefers_this_device_for_a_setting_changed_on_both_and_the_other_for_the_rest() {
        let origin = document(
            &json!({}),
            &json!({ "dateFormat": "dmy", "hour24": false, "layout": "a" }),
        );
        let mine = document(
            &json!({}),
            &json!({ "dateFormat": "ymd", "hour24": false, "layout": "a" }),
        );
        let theirs = document(
            &json!({}),
            &json!({ "dateFormat": "mdy", "hour24": true, "layout": "a" }),
        );

        let merged = merge_settings(&origin, &mine, &theirs, 1).unwrap();

        assert_eq!(
            merged["settings"],
            json!({ "dateFormat": "ymd", "hour24": true, "layout": "a" })
        );
    }

    #[test]
    fn a_selected_theme_that_was_removed_falls_back_to_none() {
        let theme = json!({ "id": "dark", "name": "dark", "kind": "dark", "css": "" });
        let origin = document(
            &json!({ "themes": [theme], "darkThemeId": "dark" }),
            &json!({}),
        );
        let mine = document(
            &json!({ "themes": [theme], "darkThemeId": "dark" }),
            &json!({}),
        );
        let theirs = document(&json!({ "darkThemeId": "dark" }), &json!({}));

        let merged = merge_settings(&origin, &mine, &theirs, 1).unwrap();

        assert_eq!(merged["themes"]["darkThemeId"], Value::Null);
    }

    #[test]
    fn declines_documents_of_another_schema_or_version() {
        let origin = document(&json!({}), &json!({}));
        let mut newer = origin.clone();
        newer["schema"] = json!(5);
        let mut other = origin.clone();
        other["v"] = json!(99);

        assert_eq!(merge_settings(&origin, &origin, &newer, 1), None);
        assert_eq!(merge_settings(&origin, &origin, &other, 1), None);
    }
}
