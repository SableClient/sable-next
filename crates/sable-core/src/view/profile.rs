use matrix_sdk::ruma::events::room::message::sanitize::remove_plain_reply_fallback;
use sable_model::text::visible_name;

use serde::Deserialize as _;
use serde_with::{DefaultOnError, serde_as};

use crate::profiles::pronoun_sets;
use crate::protocol::PerMessageProfileView;

use super::raw::{ObjectOnly, present};

const PMP_KEYS: [&str; 2] = ["com.beeper.per_message_profile", "m.per_message_profile"];

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct PerMessageProfileIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    id: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "displayname")]
    display_name: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    avatar_url: Option<String>,
    #[serde(deserialize_with = "present")]
    avatar_file: bool,
    #[serde(rename = "io.fsky.nyx.pronouns")]
    pronouns: Option<serde_json::Value>,
    #[serde_as(as = "ObjectOnly")]
    #[serde(rename = "eu.she-a.color")]
    color: Option<ProfileColorIn>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    has_fallback: Option<bool>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "net.f0rest.biography")]
    biography: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "net.f0rest.banner_url")]
    banner_url: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "net.f0rest.is_animal")]
    pub is_animal: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "net.f0rest.has_animal")]
    pub has_animal: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    #[serde(rename = "net.f0rest.animal_need")]
    pub animal_need: Option<String>,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct ProfileColorIn {
    #[serde_as(deserialize_as = "DefaultOnError")]
    on_light: Option<String>,
    #[serde_as(deserialize_as = "DefaultOnError")]
    on_dark: Option<String>,
}

pub(crate) fn per_message_profile(
    content: Option<&serde_json::Value>,
) -> Option<PerMessageProfileView> {
    let content = content?;
    let profile = PMP_KEYS.iter().find_map(|key| content.get(*key))?;
    let profile = if profile.is_object() {
        PerMessageProfileIn::deserialize(profile).unwrap_or_default()
    } else {
        PerMessageProfileIn::default()
    };
    let color = profile.color.unwrap_or_default();
    let non_blank = |value: Option<String>| value.filter(|value| !value.trim().is_empty());

    let avatar_url = profile
        .avatar_url
        .as_deref()
        .map(str::trim)
        .filter(|url| url.is_empty() || url.starts_with("mxc://"))
        .map(ToOwned::to_owned)
        .or_else(|| profile.avatar_file.then(String::new));

    Some(PerMessageProfileView {
        id: non_blank(profile.id),
        display_name: profile.display_name.and_then(visible_name),
        avatar_url,
        pronouns: pronoun_sets(profile.pronouns.as_ref()),
        color_on_light: color.on_light,
        color_on_dark: color.on_dark,
        has_fallback: profile.has_fallback.unwrap_or(false),
        biography: profile.biography,
        banner_url: profile.banner_url,
        is_animal: profile.is_animal,
        has_animal: profile.has_animal,
        animal_need: profile.animal_need,
    })
}

pub(crate) fn authored_body(body: &str, content: Option<&serde_json::Value>) -> String {
    let fallback_name = per_message_profile(content)
        .filter(|profile| profile.has_fallback)
        .and_then(|profile| profile.display_name);
    let body = crate::matrix_html::strip_profile_fallback_body(body, fallback_name.as_deref());
    remove_plain_reply_fallback(&body).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    #[test]
    fn reads_a_per_message_profile_under_either_key() {
        let beeper = json!({ "com.beeper.per_message_profile": { "displayname": "Kris" } });
        let stable = json!({ "m.per_message_profile": { "displayname": "Kris" } });

        for content in [&beeper, &stable] {
            let profile = per_message_profile(Some(content)).expect("a profile under either key");
            assert_eq!(profile.display_name.as_deref(), Some("Kris"));
            assert!(!profile.has_fallback);
        }

        assert!(per_message_profile(Some(&json!({}))).is_none());
        assert!(per_message_profile(None).is_none());
    }

    #[test]
    fn an_empty_or_unreadable_avatar_clears_it_instead_of_falling_back() {
        let cleared = json!({ "m.per_message_profile": { "avatar_url": "" } });
        let encrypted =
            json!({ "m.per_message_profile": { "avatar_file": { "url": "mxc://e/1" } } });
        let foreign =
            json!({ "m.per_message_profile": { "avatar_url": "https://example.org/a.png" } });
        let mxc = json!({ "m.per_message_profile": { "avatar_url": "mxc://example.org/a" } });

        for content in [&cleared, &encrypted] {
            let profile = per_message_profile(Some(content)).expect("a profile");
            assert_eq!(profile.avatar_url.as_deref(), Some(""));
        }
        assert_eq!(
            per_message_profile(Some(&foreign))
                .expect("a profile")
                .avatar_url,
            None
        );
        assert_eq!(
            per_message_profile(Some(&mxc))
                .expect("a profile")
                .avatar_url
                .as_deref(),
            Some("mxc://example.org/a")
        );
    }

    #[test]
    fn a_blank_profile_name_reads_as_no_name_rather_than_an_empty_one() {
        for name in ["   ", "\u{200b}\u{2800}\u{feff}"] {
            let content = json!({ "m.per_message_profile": { "displayname": name } });
            let profile = per_message_profile(Some(&content)).expect("a profile");
            assert_eq!(profile.display_name, None);
        }
    }

    #[test]
    fn a_wrong_typed_profile_field_reads_as_missing() {
        let profile = per_message_profile(Some(&json!({ "m.per_message_profile": {
            "id": 5,
            "displayname": ["Kris"],
            "avatar_url": 3,
            "avatar_file": null,
            "has_fallback": "yes",
            "eu.she-a.color": { "on_light": "#111111", "on_dark": 7 },
            "io.fsky.nyx.pronouns": [{ "summary": "she" }, 4],
        } })))
        .expect("a profile");

        assert_eq!(profile.id, None);
        assert_eq!(profile.display_name, None);
        assert_eq!(profile.avatar_url.as_deref(), Some(""));
        assert!(!profile.has_fallback);
        assert_eq!(profile.color_on_light.as_deref(), Some("#111111"));
        assert_eq!(profile.color_on_dark, None);
        assert_eq!(profile.pronouns.len(), 1);

        let bare = per_message_profile(Some(&json!({ "m.per_message_profile": ["x"] })))
            .expect("a profile");
        assert_eq!(bare.display_name, None);
        let arrayed = per_message_profile(Some(&json!({
            "m.per_message_profile": { "eu.she-a.color": ["#111111"] },
        })))
        .expect("a profile");
        assert_eq!(arrayed.color_on_light, None);
    }
}
