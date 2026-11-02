use sable_model::color::is_hex_color;
use sable_model::text::visible_name;

use matrix_sdk::ruma::OwnedUserId;
use matrix_sdk::ruma::api::client::profile::{AvatarUrl, DisplayName};

use sable_model::non_blank::NonBlank;
use sable_model::truncate::truncate_graphemes;
use serde::Deserialize as _;
use serde_with::serde_as;

use crate::protocol::{
    AnimalIdentityView, BrightnessView, ProfileFieldView, ProfileView, PronounView, StatusView,
};

type ProfileResponse = matrix_sdk::ruma::api::client::profile::get_profile::v3::Response;

const STATUS_FIELD: &str = "org.matrix.msc4426.status";
const STABLE_STATUS_FIELD: &str = "m.status";
const COMMET_STATUS_FIELD: &str = "chat.commet.profile_status";

const LEGACY_PROFILE_FIELDS: [&str; 4] = [
    "moe.sable.app.bio",
    "chat.commet.profile_bio",
    COMMET_STATUS_FIELD,
    STABLE_STATUS_FIELD,
];

const SUPPORTER_FIELD: &str = "moe.sable.app.supporter_awards";
const MAX_SUPPORTER_FIELD_BYTES: usize = 16 * 1024;

const RENDERED_PROFILE_FIELDS: [&str; 24] = [
    "displayname",
    "avatar_url",
    "m.biography",
    "gay.fomx.biography",
    "moe.sable.app.bio",
    "chat.commet.profile_bio",
    "chat.commet.profile_color_scheme",
    "chat.commet.profile_banner",
    COMMET_STATUS_FIELD,
    STABLE_STATUS_FIELD,
    STATUS_FIELD,
    "io.fsky.nyx.pronouns",
    "us.cloke.msc4175.tz",
    "m.tz",
    "eu.she-a.color",
    "moe.sable.app.name_color",
    "moe.sable.app.name_color_light_theme",
    "moe.sable.app.name_color_dark_theme",
    "kitty.meow.is_cat",
    "kitty.meow.has_cats",
    "pet.plz.me",
    "pet.plz.my",
    "pet.plz.gib",
    SUPPORTER_FIELD,
];

fn profile_field<'a>(response: &'a ProfileResponse, name: &str) -> Option<&'a serde_json::Value> {
    response
        .iter()
        .find(|(field, _)| field.as_str() == name)
        .map(|(_, value)| value)
}

fn profile_text(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn profile_hex_color(value: Option<&serde_json::Value>) -> Option<String> {
    profile_text(value).and_then(hex_color)
}

fn hex_color(color: String) -> Option<String> {
    is_hex_color(&color, &[3, 6]).then_some(color)
}

/// A structured field reads as its default unless it is an object.
fn profile_object<T: serde::de::DeserializeOwned + Default>(
    response: &ProfileResponse,
    name: &str,
) -> T {
    profile_field(response, name)
        .filter(|value| value.is_object())
        .and_then(|value| T::deserialize(value).ok())
        .unwrap_or_default()
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct ColorScheme {
    #[serde_as(as = "NonBlank")]
    brightness: Option<String>,
    #[serde_as(as = "NonBlank")]
    color: Option<String>,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct StructuredStatus {
    #[serde_as(as = "NonBlank")]
    text: Option<String>,
    #[serde_as(as = "NonBlank")]
    emoji: Option<String>,
}

#[serde_as]
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct PronounSet {
    #[serde_as(as = "NonBlank")]
    summary: Option<String>,
    #[serde_as(as = "NonBlank")]
    language: Option<String>,
}

use crate::matrix_html::display_html;

/// A bio is arbitrary remote text, so it goes through the same sanitiser as a
/// message body and reaches the UI as display HTML.
fn profile_bio(response: &ProfileResponse) -> Option<String> {
    let texts = profile_field(response, "m.biography")
        .or_else(|| profile_field(response, "gay.fomx.biography"))
        .and_then(|value| value.get("m.text"))
        .and_then(serde_json::Value::as_array);
    // `m.text` carries one entry per representation; only the HTML one may keep
    // its markup.
    let representation = |mimetype: Option<&str>| {
        texts.and_then(|texts| {
            texts
                .iter()
                .find(|text| text.get("mimetype").and_then(serde_json::Value::as_str) == mimetype)
                .and_then(|text| profile_text(text.get("body")))
        })
    };

    let plain = representation(None).or_else(|| representation(Some("text/plain")));
    let html = representation(Some("text/html")).or_else(|| {
        plain.is_none().then(|| {
            profile_text(profile_field(response, "moe.sable.app.bio")).or_else(|| {
                profile_text(
                    profile_field(response, "chat.commet.profile_bio")
                        .and_then(|bio| bio.get("formatted_body")),
                )
            })
        })?
    });

    (plain.is_some() || html.is_some())
        .then(|| display_html(plain.as_deref().unwrap_or_default(), html.as_deref()))
}

fn profile_hero_brightness(response: &ProfileResponse) -> Option<BrightnessView> {
    match profile_object::<ColorScheme>(response, "chat.commet.profile_color_scheme")
        .brightness?
        .as_str()
    {
        "light" => Some(BrightnessView::Light),
        "dark" => Some(BrightnessView::Dark),
        _ => None,
    }
}

fn profile_hero_color(response: &ProfileResponse) -> Option<String> {
    profile_object::<ColorScheme>(response, "chat.commet.profile_color_scheme")
        .color
        .and_then(hex_color)
}

/// The MSC4426 unstable key first: `m.status` is not a spec identifier yet, so
/// only older builds wrote it and it must not shadow the current status.
fn profile_status(response: &ProfileResponse) -> Option<StatusView> {
    const MAX_TEXT_BYTES: usize = 256;
    const MAX_EMOJI_BYTES: usize = 32;

    let truncate = |text: String, max: usize| truncate_graphemes(&text, max).to_owned();
    let structured = |name| {
        let status = profile_object::<StructuredStatus>(response, name);
        Some(StatusView {
            text: truncate(status.text?, MAX_TEXT_BYTES),
            emoji: status.emoji.map(|emoji| truncate(emoji, MAX_EMOJI_BYTES)),
        })
    };

    structured(STATUS_FIELD)
        .or_else(|| structured(STABLE_STATUS_FIELD))
        .or_else(|| {
            profile_text(profile_field(response, COMMET_STATUS_FIELD)).map(|text| StatusView {
                text: truncate(text, MAX_TEXT_BYTES),
                emoji: None,
            })
        })
}

/// Shared with per-message profiles, which carry pronouns in the same shape.
pub(crate) fn pronoun_sets(value: Option<&serde_json::Value>) -> Vec<PronounView> {
    const MAX_SUMMARY_CHARS: usize = 16;

    value
        .and_then(serde_json::Value::as_array)
        .map(|sets| {
            sets.iter()
                .filter(|set| set.is_object())
                .filter_map(|set| {
                    let set = PronounSet::deserialize(set).ok()?;
                    Some(PronounView {
                        summary: set.summary?.chars().take(MAX_SUMMARY_CHARS).collect(),
                        language: set.language.map(|language| language.to_lowercase()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn profile_pronouns(response: &ProfileResponse) -> Vec<PronounView> {
    pronoun_sets(profile_field(response, "io.fsky.nyx.pronouns"))
}

fn profile_timezone(response: &ProfileResponse) -> Option<String> {
    profile_text(profile_field(response, "m.tz"))
        .or_else(|| profile_text(profile_field(response, "us.cloke.msc4175.tz")))
        // Some clients store the zone with its JSON quotes still attached.
        .map(|zone| zone.trim_matches(['"', '\'']).to_owned())
        .filter(|zone| !zone.is_empty())
}

/// Light-theme colour then dark, each falling back to the theme-agnostic field.
fn profile_name_colors(response: &ProfileResponse) -> (Option<String>, Option<String>) {
    let colors = profile_field(response, "eu.she-a.color");
    let shared = profile_hex_color(profile_field(response, "moe.sable.app.name_color"));
    let per_theme = |msc_key, sable_key| {
        profile_hex_color(colors.and_then(|colors| colors.get(msc_key)))
            .or_else(|| profile_hex_color(profile_field(response, sable_key)))
            .or_else(|| shared.clone())
    };

    (
        per_theme("on_light", "moe.sable.app.name_color_light_theme"),
        per_theme("on_dark", "moe.sable.app.name_color_dark_theme"),
    )
}

fn profile_animal(response: &ProfileResponse) -> Option<AnimalIdentityView> {
    let legacy_cat = |field, label: &str| {
        profile_field(response, field)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
            .then(|| label.to_owned())
    };
    let identity = AnimalIdentityView {
        is_animal: profile_text(profile_field(response, "pet.plz.me"))
            .or_else(|| legacy_cat("kitty.meow.is_cat", "cat")),
        has_animal: profile_text(profile_field(response, "pet.plz.my"))
            .or_else(|| legacy_cat("kitty.meow.has_cats", "cats")),
        animal_need: profile_field(response, "pet.plz.gib")
            .and_then(serde_json::Value::as_str)
            .map(|need| need.trim().to_owned()),
    };

    // The need alone says nothing without an animal to attach it to.
    (identity.is_animal.is_some() || identity.has_animal.is_some()).then_some(identity)
}

fn profile_supporter_awards(response: &ProfileResponse) -> Option<String> {
    profile_field(response, SUPPORTER_FIELD)
        .filter(|value| value.is_array())
        .map(ToString::to_string)
        .filter(|text| text.len() <= MAX_SUPPORTER_FIELD_BYTES)
}

fn profile_extra(response: &ProfileResponse) -> Vec<ProfileFieldView> {
    let mut extra = response
        .iter()
        .filter(|(field, _)| !RENDERED_PROFILE_FIELDS.contains(&field.as_str()))
        .map(|(field, value)| ProfileFieldView {
            key: field.as_str().to_owned(),
            value: value
                .as_str()
                .map_or_else(|| value.to_string(), ToOwned::to_owned),
        })
        .collect::<Vec<_>>();
    extra.sort_by(|left, right| left.key.cmp(&right.key));
    extra
}

pub(crate) fn profile_view(user_id: OwnedUserId, response: &ProfileResponse) -> ProfileView {
    let (name_color_light, name_color_dark) = profile_name_colors(response);

    let real_name = response
        .get_static::<DisplayName>()
        .ok()
        .flatten()
        .and_then(visible_name);
    let real_avatar_url = response
        .get_static::<AvatarUrl>()
        .ok()
        .flatten()
        .map(|url| url.to_string());
    ProfileView {
        user_id,
        display_name: real_name.clone(),
        avatar_url: real_avatar_url.clone(),
        real_name,
        real_avatar_url,
        bio: profile_bio(response),
        hero_color: profile_hero_color(response),
        hero_brightness: profile_hero_brightness(response),
        banner_url: profile_text(profile_field(response, "chat.commet.profile_banner")),
        status: profile_status(response),
        pronouns: profile_pronouns(response),
        timezone: profile_timezone(response),
        name_color_light,
        name_color_dark,
        animal: profile_animal(response),
        extra: profile_extra(response),
        supporter_awards: profile_supporter_awards(response),
        legacy_fields: LEGACY_PROFILE_FIELDS
            .into_iter()
            .filter(|name| profile_field(response, name).is_some())
            .map(ToOwned::to_owned)
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn view(fields: &serde_json::Value) -> ProfileView {
        let response = fields
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<ProfileResponse>();
        profile_view("@me:example.org".try_into().unwrap(), &response)
    }

    #[test]
    fn hidden_names_have_no_profile_name() {
        for name in ["", "   ", "\u{200b}\u{2800}\u{feff}"] {
            assert_eq!(view(&json!({ "displayname": name })).display_name, None);
        }
        assert_eq!(
            view(&json!({ "displayname": " Élodie " }))
                .display_name
                .as_deref(),
            Some(" Élodie ")
        );
    }

    #[test]
    fn a_legacy_bio_is_read_and_reported() {
        let sable = view(&json!({ "moe.sable.app.bio": "<b>sable</b>" }));
        assert!(sable.bio.unwrap().contains("sable"));
        assert_eq!(sable.legacy_fields, ["moe.sable.app.bio"]);
        assert!(sable.extra.is_empty());

        let commet = view(&json!({
            "chat.commet.profile_bio": {
                "format": "org.matrix.custom.html",
                "formatted_body": "commet",
            },
        }));
        assert!(commet.bio.unwrap().contains("commet"));
        assert_eq!(commet.legacy_fields, ["chat.commet.profile_bio"]);
    }

    #[test]
    fn the_msc_bio_wins_over_a_legacy_one() {
        let profile = view(&json!({
            "gay.fomx.biography": { "m.text": [{ "body": "msc" }] },
            "moe.sable.app.bio": "legacy",
        }));
        let bio = profile.bio.unwrap();
        assert!(bio.contains("msc") && !bio.contains("legacy"));
        assert_eq!(profile.legacy_fields, ["moe.sable.app.bio"]);
    }

    #[test]
    fn legacy_status_fields_are_reported() {
        let profile = view(&json!({
            "org.matrix.msc4426.status": { "text": "here", "emoji": "🌴" },
            "chat.commet.profile_status": "old",
            "m.status": { "text": "older" },
        }));
        assert_eq!(profile.status.unwrap().text, "here");
        assert_eq!(
            profile.legacy_fields,
            ["chat.commet.profile_status", "m.status"]
        );

        let stable_only = view(&json!({ "m.status": { "text": "pre-fix" } }));
        assert_eq!(stable_only.status.unwrap().text, "pre-fix");
    }

    #[test]
    fn the_stable_timezone_wins_over_the_unstable_one() {
        let both = view(&json!({ "m.tz": "Europe/Paris", "us.cloke.msc4175.tz": "Asia/Tokyo" }));
        assert_eq!(both.timezone.as_deref(), Some("Europe/Paris"));

        let unstable = view(&json!({ "us.cloke.msc4175.tz": "Asia/Tokyo" }));
        assert_eq!(unstable.timezone.as_deref(), Some("Asia/Tokyo"));
    }

    #[test]
    fn status_limits_count_utf8_bytes_on_char_boundaries() {
        let profile = view(&json!({
            "org.matrix.msc4426.status": { "text": "語".repeat(100), "emoji": "🌴".repeat(10) },
        }));
        let status = profile.status.unwrap();
        assert_eq!(status.text, "語".repeat(85));
        assert_eq!(status.emoji.as_deref(), Some("🌴".repeat(8).as_str()));

        let legacy = view(&json!({ "chat.commet.profile_status": "é".repeat(200) }));
        assert_eq!(legacy.status.unwrap().text, "é".repeat(128));
    }

    #[test]
    fn a_cleared_animal_need_is_distinct_from_an_unset_one() {
        let unset = view(&json!({ "kitty.meow.is_cat": true })).animal.unwrap();
        assert_eq!(unset.is_animal.as_deref(), Some("cat"));
        assert_eq!(unset.animal_need, None);

        let cleared = view(&json!({ "pet.plz.me": "cat", "pet.plz.gib": "" }))
            .animal
            .unwrap();
        assert_eq!(cleared.animal_need.as_deref(), Some(""));
    }

    #[test]
    fn preserves_unrecognised_profile_fields_for_misc_data() {
        let profile = view(&json!({
            "fyi.cisnt.connections": {
                "description": "homepage",
                "uri": "https://example.org"
            }
        }));

        assert_eq!(profile.extra.len(), 1);
        assert_eq!(profile.extra[0].key, "fyi.cisnt.connections");
        assert_eq!(
            profile.extra[0].value,
            r#"{"description":"homepage","uri":"https://example.org"}"#
        );
    }

    #[test]
    fn supporter_awards_are_passed_through_and_hidden_from_misc_data() {
        let profile = view(&json!({
            "moe.sable.app.supporter_awards": [{ "signed": { "id": "oc-1" } }]
        }));

        assert_eq!(
            profile.supporter_awards.as_deref(),
            Some(r#"[{"signed":{"id":"oc-1"}}]"#)
        );
        assert!(profile.extra.is_empty());
    }

    #[test]
    fn a_malformed_or_oversized_awards_field_is_dropped() {
        let not_a_list = view(&json!({ "moe.sable.app.supporter_awards": "nope" }));
        assert_eq!(not_a_list.supporter_awards, None);

        let huge = view(&json!({ "moe.sable.app.supporter_awards": ["x".repeat(20_000)] }));
        assert_eq!(huge.supporter_awards, None);
    }

    #[test]
    fn structured_fields_skip_wrong_typed_members() {
        let profile = view(&json!({
            "m.status": { "text": " busy ", "emoji": 4 },
            "chat.commet.profile_color_scheme": { "brightness": "dark", "color": 1 },
            "io.fsky.nyx.pronouns": [{ "summary": " she ", "language": "EN" }, { "summary": 2 }, "x"],
        }));
        let status = profile.status.unwrap();
        assert_eq!(status.text, "busy");
        assert_eq!(status.emoji, None);
        assert!(matches!(
            profile.hero_brightness,
            Some(BrightnessView::Dark)
        ));
        assert_eq!(profile.hero_color, None);
        assert_eq!(profile.pronouns.len(), 1);
        assert_eq!(profile.pronouns[0].language.as_deref(), Some("en"));

        let arrays = view(&json!({ "m.status": ["busy"] }));
        assert!(arrays.status.is_none());
    }
}
